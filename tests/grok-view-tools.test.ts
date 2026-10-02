import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGrokViewTools } from '../src/main/grok/view-tools.js'
import type { ViewToolHttpServer } from '../src/main/view-tools/http-server.js'
import type { ViewTools } from '../src/main/view-tools/server.js'
import { MSG } from '../src/main/view-tools/errors.js'
import type { ApprovalAsk, ApprovalDecision } from '../src/main/approval.js'
import { VIEW_TOOL_SERVER_NAME } from '../src/shared/view-tools.js'

/** 假的 view server 參數:createGrokViewTools 只是把它轉手給工廠,內容不重要。 */
const VIEW = { resolve: () => Promise.reject(new Error('不該被叫到')), logError: () => {} }

describe('createGrokViewTools', () => {
  it('HTTP server 第一次啟動失敗,快取的 rejection 用完就丟,下一次 mcpServers() 能重試成功', async () => {
    let calls = 0
    const closed: string[] = []
    const start = async (): Promise<ViewToolHttpServer> => {
      calls += 1
      if (calls === 1) throw new Error('listen 失敗')
      return { url: 'http://127.0.0.1:1/mcp', token: 't-2', close: async () => { closed.push('close') } }
    }
    const errors: string[] = []
    const tools = createGrokViewTools({
      view: VIEW,
      logError: (e) => { errors.push(e.message) },
      handoffDone: () => {},
      start,
    })

    await expect(tools.mcpServers()).rejects.toThrow('listen 失敗')
    expect(calls).toBe(1)

    const servers = await tools.mcpServers()
    expect(calls).toBe(2)
    expect(servers).toEqual([{
      name: VIEW_TOOL_SERVER_NAME,
      type: 'http',
      url: 'http://127.0.0.1:1/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t-2' }],
    }])
    // 失敗那一次不該被當成「已經在跑」而擋住 close,也不該自己冒出多餘的錯誤紀錄。
    expect(errors).toEqual([])

    await tools.close()
    expect(closed).toEqual(['close'])
  })

  it('第二次呼叫命中同一個進行中的 server,不重複 start', async () => {
    let calls = 0
    const start = async (): Promise<ViewToolHttpServer> => {
      calls += 1
      return { url: 'http://127.0.0.1:2/mcp', token: 't', close: async () => {} }
    }
    const tools = createGrokViewTools({ view: VIEW, logError: () => {}, handoffDone: () => {}, start })
    await Promise.all([tools.mcpServers(), tools.mcpServers()])
    expect(calls).toBe(1)
  })

  it('close() 前沒叫過 mcpServers():什麼都不做,不丟例外', async () => {
    const tools = createGrokViewTools({ view: VIEW, logError: () => {}, handoffDone: () => {} })
    await expect(tools.close()).resolves.toBeUndefined()
  })

  it('close() 失敗記錯誤,不讓例外跑出去', async () => {
    const errors: string[] = []
    const start = async (): Promise<ViewToolHttpServer> =>
      ({ url: 'http://127.0.0.1:3/mcp', token: 't', close: async () => { throw new Error('關閉失敗') } })
    const tools = createGrokViewTools({ view: VIEW, logError: (e) => { errors.push(e.message) }, handoffDone: () => {}, start })
    await tools.mcpServers()
    await expect(tools.close()).resolves.toBeUndefined()
    expect(errors).toEqual(['關閉失敗'])
  })

  it('handoffDone 原樣轉交給呼叫端給的函式', () => {
    const calls: string[] = []
    const tools = createGrokViewTools({ view: VIEW, logError: () => {}, handoffDone: (id) => { calls.push(id) } })
    tools.handoffDone('tool-1')
    expect(calls).toEqual(['tool-1'])
  })

  it('主廚的 configure 工具可透過 Grok 批准入口取得批准卡', async () => {
    const asks: ApprovalAsk[] = []
    const tools = createGrokViewTools({ view: VIEW, logError: () => {}, handoffDone: () => {} })
    tools.useApproval(async (ask) => { asks.push(ask); return 'allow' })
    await expect(tools.requestApproval('configure_error_intake_env', { envFile: '.env.local' })).resolves.toBe('allow')
    expect(asks[0]).toMatchObject({
      toolName: 'configure_error_intake_env', input: { envFile: '.env.local' },
      toolUseId: expect.stringMatching(/^grok-view-/),
    })
  })
})

interface Reply { readonly status: number; readonly body: string; readonly sessionId: string | undefined }

function call(port: number, token: string, payload: unknown, sessionId?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
        authorization: `Bearer ${token}`,
        ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
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

let running: { close(): Promise<void> } | undefined
afterEach(async () => { await running?.close(); running = undefined })

/** 走真的 HTTP 路徑:createGrokViewTools 自己開 server,測試只透過 MCP 打進去。 */
async function rig() {
  const invoke = vi.fn(() => Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: '做完了' } }))
  const viewTools: ViewTools = {
    invoke, handoffDone: () => {}, abortPending: () => {}, busy: () => false, dispose: () => Promise.resolve(),
  }
  const asks: ApprovalAsk[] = []
  let settle: (decision: ApprovalDecision) => void = () => {}
  const tools = createGrokViewTools({
    view: { resolve: () => Promise.resolve(viewTools), logError: () => {} },
    logError: () => {},
    handoffDone: () => {},
  })
  tools.useApproval((ask) => {
    asks.push(ask)
    return new Promise<ApprovalDecision>((resolve) => { settle = resolve })
  })
  running = tools
  const servers = await tools.mcpServers()
  const server = servers[0]!
  const port = Number(new URL(server.url).port)
  const token = server.headers[0]!.value.replace('Bearer ', '')
  const init = await call(port, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok', version: '1.0.40' } } })
  const sessionId = init.sessionId as string
  await call(port, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
  const callTool = (name: string, args: unknown): Promise<Reply> =>
    call(port, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, sessionId)
  return { callTool, invoke, asks, decide: (d: ApprovalDecision) => { settle(d) } }
}

describe('yeschef 這側的批准閘門(grok 的 HTTP 路徑)', () => {
  it('view_eval 在批准回來之前不會碰到 tools.invoke', async () => {
    const r = await rig()
    const pending = r.callTool('view_eval', { expression: '1 + 1' })
    // 等到批准被要求為止:政策是 ask,所以一定先問。
    while (r.asks.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(r.invoke).not.toHaveBeenCalled()
    expect(r.asks[0]?.toolName).toBe('view_eval')
    r.decide('allow')
    const reply = await pending
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('做完了')
    expect(r.invoke).toHaveBeenCalledTimes(1)
  })

  it('拒絕時回 MSG.approvalDenied,工具不執行', async () => {
    const r = await rig()
    const pending = r.callTool('view_eval', { expression: '1 + 1' })
    while (r.asks.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    r.decide('deny')
    const reply = await pending
    expect(reply.status).toBe(200)
    expect(reply.body).toContain(MSG.approvalDenied)
    expect(r.invoke).not.toHaveBeenCalled()
  })

  it('view_snapshot 是 allow:不問,直接執行', async () => {
    const r = await rig()
    const reply = await r.callTool('view_snapshot', { scope: 'full' })
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('做完了')
    expect(r.asks).toEqual([])
    expect(r.invoke).toHaveBeenCalledTimes(1)
  })
})
