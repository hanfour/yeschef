// tests/view-tools-http-server.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 記下 startViewToolHttpServer 內部真正拿到的 port,只用來驗證 connect() 失敗時
 * 那個已經在聽的 http server 有沒有被關掉(裁決:reject 分支要先 http.close() 再 reject)。
 * 用 vi.mock 包一層而不是動 http-server.ts:被測的檔案完全不知道自己被觀察。
 */
const httpState: { port: number } = { port: 0 }
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args)
      server.once('listening', () => {
        const address = server.address()
        if (address !== null && typeof address === 'object') httpState.port = address.port
      })
      return server
    },
  }
})

import { request as httpRequest } from 'node:http'
import { createConversationViewServer } from '../src/main/view-tools/conversation-server.js'
import type { ConversationViewServer } from '../src/main/view-tools/conversation-server.js'
import { HTTP_MSG, startViewToolHttpServer, type ViewToolHttpServer } from '../src/main/view-tools/http-server.js'
import type { ViewTools } from '../src/main/view-tools/server.js'
import { VIEW_TOOL_NAMES } from '../src/shared/view-tools.js'

interface Reply { readonly status: number; readonly body: string; readonly sessionId: string | undefined }

interface CallOptions {
  readonly token?: string | null
  readonly host?: string
  readonly path?: string
  readonly sessionId?: string
  readonly payload?: unknown
}

/** 用 node:http 而不是 fetch:fetch 不讓呼叫端自己設 Host,而 Host 正是要驗的東西。 */
function call(port: number, options: CallOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.payload === undefined ? '' : JSON.stringify(options.payload)
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: options.path ?? '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
        ...(options.token === null || options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.sessionId === undefined ? {} : { 'mcp-session-id': options.sessionId }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const header = res.headers['mcp-session-id']
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), sessionId: typeof header === 'string' ? header : undefined })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** `setHost: false` 讓 node 不自動補 Host,這是唯一送得出「沒有 Host」的方式。 */
function callWithoutHost(port: number, token: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp', setHost: false,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
        authorization: `Bearer ${token}`,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), sessionId: undefined }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

function fakeTools(): ViewTools {
  return {
    invoke: vi.fn(() => Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: '快照好了' } })),
    handoffDone: vi.fn(), abortPending: vi.fn(), busy: () => false, dispose: () => Promise.resolve(),
  }
}

let running: ViewToolHttpServer | undefined
afterEach(async () => { await running?.close(); running = undefined })

async function start() {
  const logError = vi.fn()
  // 直接留住 tools 物件斷言 invoke:createConversationViewServer 內的 tool() callback
  // 用閉包抓住 invoke,不是透過 view.invoke 讀取,vi.spyOn(view, 'invoke') 換不掉那個閉包。
  const tools = fakeTools()
  // 一個 MCP session 一份 view:工廠每次被叫就多一份,測試留住每一份好斷言 dispose。
  const views: ConversationViewServer[] = []
  const makeView = (): ConversationViewServer => {
    const view = createConversationViewServer({ resolve: () => Promise.resolve(tools), logError })
    const spied = { ...view, dispose: vi.fn(view.dispose) }
    views.push(spied)
    return spied
  }
  const server = await startViewToolHttpServer(makeView, logError)
  running = server
  const port = Number(new URL(server.url).port)
  return { server, port, token: server.token, logError, views, tools }
}

async function handshake(port: number, token: string): Promise<string> {
  const init = await call(port, {
    token,
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok', version: '1.0.40' } } },
  })
  expect(init.status).toBe(200)
  const sessionId = init.sessionId
  expect(sessionId).toBeDefined()
  await call(port, { token, sessionId, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } })
  return sessionId as string
}

describe('三道檢查', () => {
  it('url 綁 127.0.0.1,token 夠長且是 base64url', async () => {
    const { server } = await start()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('沒有 Authorization:401,回的是純文字不是 MCP 錯誤', async () => {
    const { port } = await start()
    const reply = await call(port, { token: null, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    expect(reply.status).toBe(401)
    expect(reply.body).toBe(HTTP_MSG.unauthorized)
  })

  it('token 不對:401', async () => {
    const { port } = await start()
    expect((await call(port, { token: 'wrong-token', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401)
  })

  it('Host 不是 127.0.0.1:<port>:401(擋 DNS rebinding)', async () => {
    const { port, token } = await start()
    expect((await call(port, { token, host: 'yeschef.evil.test', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401)
    expect((await call(port, { token, host: `localhost:${port}`, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401)
  })

  it('缺 Host header:被拒,進不到 MCP', async () => {
    const { port, token } = await start()
    // HTTP/1.1 沒有 Host 時 node 自己就回 400,根本不會叫到我們的處理函式;真的進來了
    // `authorized` 也會因為 host 是 undefined 而回 401。兩種都是拒絕,這裡只驗不是 200。
    // 非 loopback 的來源無法在單機測(要真的從別台機器連進來),只能靠 remoteAddress 那一行擋。
    expect((await callWithoutHost(port, token)).status).not.toBe(200)
  })

  it('路徑不是 /mcp:404', async () => {
    const { port, token } = await start()
    const reply = await call(port, { token, path: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    expect(reply.status).toBe(404)
    expect(reply.body).toBe(HTTP_MSG.notFound)
  })

  it('401 與 404 都不留下 log:被擋下來是預期行為,不是故障', async () => {
    const { port, logError } = await start()
    await call(port, { token: null, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    await call(port, { token: 'x', path: '/other' })
    expect(logError).not.toHaveBeenCalled()
  })
})

describe('MCP 本體', () => {
  it('handshake 之後 tools/list 看得到全部的右窗格工具', async () => {
    const { port, token } = await start()
    const sessionId = await handshake(port, token)
    const listed = await call(port, { token, sessionId, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } })
    expect(listed.status).toBe(200)
    const names = (JSON.parse(listed.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    for (const name of VIEW_TOOL_NAMES) expect(names).toContain(name)
  })

  it('tools/call 打到同一份 invoke', async () => {
    const { port, token, tools } = await start()
    const sessionId = await handshake(port, token)
    const called = await call(port, {
      token, sessionId,
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'view_snapshot', arguments: { scope: 'full' } } },
    })
    expect(called.status).toBe(200)
    expect(called.body).toContain('快照好了')
    // callId 來自 extra._meta['claudecode/toolUseId'](handoff.ts 的 readToolUseId),
    // 那是 Claude in-process 呼叫才會帶的欄位;grok 走的是裸 JSON-RPC,沒有這個 meta,
    // 所以這裡合法地是 null,不是「有給就好」的 expect.anything()。
    expect(tools.invoke).toHaveBeenCalledWith('view_snapshot', { scope: 'full' }, expect.objectContaining({ callId: null }))
  })

  it('close() 之後連不上', async () => {
    const { server, port, token } = await start()
    await handshake(port, token)
    await server.close()
    running = undefined
    // macOS + Node 這個組合下,server.close() 的 callback 有時比核心真的釋放那個 port
    // 早幾十毫秒觸發,這個空窗期連進去會是 ECONNRESET 而不是 ECONNREFUSED(用最陽春的
    // http.createServer 重現過,跟這裡的實作無關)。兩種都代表連不上,都算通過。
    await expect(call(port, { token, payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' } })).rejects.toMatchObject({
      code: expect.stringMatching(/^(ECONNREFUSED|ECONNRESET)$/),
    })
  })

  it('接班的子行程再送一次 initialize:換一份 view 與 transport,舊的收掉', async () => {
    const { port, token, tools, views } = await start()
    const first = await handshake(port, token)
    expect(views).toHaveLength(1)

    // 第二個 grok 子行程(openHistory 或 crash 後重啟)從頭握手,沒有 session id。
    const second = await handshake(port, token)
    expect(second).not.toBe(first)
    expect(views).toHaveLength(2)
    expect(views[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(views[1]?.dispose).not.toHaveBeenCalled()

    const called = await call(port, {
      token, sessionId: second,
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'view_snapshot', arguments: { scope: 'full' } } },
    })
    expect(called.status).toBe(200)
    expect(called.body).toContain('快照好了')
    expect(tools.invoke).toHaveBeenCalledWith('view_snapshot', { scope: 'full' }, expect.objectContaining({ callId: null }))

    // 舊的 session id 已經不屬於目前這份 transport,SDK 回 404 或 400,總之不是 200。
    const stale = await call(port, {
      token, sessionId: first,
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
    })
    expect(stale.status).not.toBe(200)
  })

  it('view.server.instance.connect() 失敗時,已經在聽的 http server 要跟著關掉,不漏 port', async () => {
    const logError = vi.fn()
    const view = {
      server: { instance: { connect: () => Promise.reject(new Error('connect 炸了')) } },
      invoke: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ConversationViewServer

    await expect(startViewToolHttpServer(() => view, logError)).rejects.toThrow('connect 炸了')

    expect(httpState.port).toBeGreaterThan(0)
    // 跟「close() 之後連不上」同樣的理由:這台機器上 close 剛完成的那一刻偶爾是
    // ECONNRESET 不是 ECONNREFUSED,兩種都代表 port 真的沒人聽了。
    await expect(call(httpState.port, { token: 'whatever', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).rejects.toMatchObject({
      code: expect.stringMatching(/^(ECONNREFUSED|ECONNRESET)$/),
    })
  })
})
