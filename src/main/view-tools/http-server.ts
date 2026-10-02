// src/main/view-tools/http-server.ts
/**
 * 每個對話一個 localhost 的 streamable HTTP MCP server(grok 規格 §6)。
 *
 * 內容就是現有的 `createConversationViewServer`:同一份 `VIEW_TOOL_DEFS` 加兩個同伴工具,
 * 同一個 `invoke`,同一套批准政策。這裡只是把它多接一條 HTTP 通道,因為 grok 不收
 * `type: "sdk"` 的 in-process 形狀。
 *
 * 一個 grok 子行程等於一個 MCP session 等於一個 transport(規格 §6.1)。`openHistory`
 * 與 crash 之後的重啟都會開新的子行程,那個子行程會從頭送 `initialize`;舊 transport
 * 已經初始化過,同一份收到第二次 `initialize` 只會回「Server already initialized」。
 * 所以這裡收工廠而不是單一 view:沒帶 session id 的 `initialize` 到達時,把目前這一份
 * 換掉。同一時間只有一個子行程,所以是替換,不是一張 session 表。
 *
 * 三道檢查在交給 transport 之前做,任一不過就 401 或 404 並關掉連線,不回 MCP 錯誤:
 * 擋下來的請求不該拿到任何協定層的資訊。token 只出現在 `session/new` 的 headers。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ConversationViewServer } from './conversation-server.js'

export const HTTP_MSG = {
  unauthorized: '未授權的右窗格工具請求',
  notFound: '沒有這個位址',
  noPort: '右窗格工具的本機伺服器沒有取得埠號',
  serverError: '右窗格工具的本機伺服器處理失敗',
} as const

export interface ViewToolHttpServer {
  /** 交給 grok 的位址,例:`http://127.0.0.1:51234/mcp`。 */
  readonly url: string
  /** 只出現在 `session/new` 的 headers,不寫檔、不進 log、不進 renderer、不進事件。 */
  readonly token: string
  close(): Promise<void>
}

const MCP_PATH = '/mcp'
/** IPv4 與 IPv6 的 loopback,以及 IPv4-mapped 的那一種。 */
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** 一個請求體的上限。右窗格工具的參數都是小的,超過就不是正常呼叫。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 定長比對,長度不同直接拒:不讓回應時間洩漏 token 前幾個字元。 */
function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function authorized(req: IncomingMessage, token: string, port: number): boolean {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  if (!sameToken(header.slice('Bearer '.length), token)) return false
  // 非 loopback 的來源無法在單機的測試裡重現,只能靠這一行擋。
  const remote = req.socket.remoteAddress
  if (remote === undefined || !LOOPBACK.has(remote)) return false
  // Host 必須逐字等於自己的位址,不接受 localhost:擋 DNS rebinding。
  return req.headers['host'] === `127.0.0.1:${port}`
}

function refuse(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
  res.end(text)
}

/** 請求體一次讀完。transport 之後只吃 parsedBody,同一條 stream 不會被讀第二次。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('右窗格工具的請求體過大')); return }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
  })
}

function parseBody(raw: string): unknown {
  if (raw === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 是不是「接班子行程的第一次握手」:initialize 而且沒帶 session id。 */
function isFreshInitialize(req: IncomingMessage, body: unknown): boolean {
  if (req.headers['mcp-session-id'] !== undefined) return false
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    && (body as { method?: unknown }).method === 'initialize'
}

interface Live {
  readonly view: ConversationViewServer
  readonly transport: StreamableHTTPServerTransport
}

export function startViewToolHttpServer(
  makeView: () => ConversationViewServer,
  logError: (error: Error) => void,
): Promise<ViewToolHttpServer> {
  const token = randomBytes(32).toString('base64url')
  let port = 0
  let live: Live | null = null

  /** stateful:1.30.0 的 stateless transport 只能處理一個請求(見 Task 5 說明)。 */
  const connect = async (): Promise<Live> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    })
    transport.onerror = (error) => { logError(new Error(`右窗格工具的 MCP 傳輸錯誤:${error.message}`)) }
    const view = makeView()
    await view.server.instance.connect(transport)
    return { view, transport }
  }

  const closeLive = async (): Promise<void> => {
    const current = live
    live = null
    if (current === null) return
    current.view.dispose()
    await current.transport.close()
  }

  /** 接班的子行程來握手:舊的那一份收掉,換一份新的再讓它走完 initialize。 */
  const takeOver = async (): Promise<Live> => {
    await closeLive()
    const next = await connect()
    live = next
    return next
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = parseBody(await readBody(req))
    const current = live
    // 第一次握手用啟動時就接好的那一份;已經有 sessionId 才表示是接班的子行程。
    const target = current !== null && current.transport.sessionId !== undefined && isFreshInitialize(req, body)
      ? await takeOver()
      : current
    if (target === null) { refuse(res, 500, HTTP_MSG.serverError); return }
    await target.transport.handleRequest(req, res, body)
  }

  const http = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== MCP_PATH) { refuse(res, 404, HTTP_MSG.notFound); return }
    if (!authorized(req, token, port)) { refuse(res, 401, HTTP_MSG.unauthorized); return }
    dispatch(req, res).catch((cause: unknown) => {
      logError(cause instanceof Error ? cause : new Error(String(cause)))
      if (!res.headersSent) refuse(res, 500, HTTP_MSG.serverError)
      else res.end()
    })
  })

  return new Promise<ViewToolHttpServer>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      const address = http.address() as AddressInfo | null
      if (address === null) { http.close(); reject(new Error(HTTP_MSG.noPort)); return }
      port = address.port
      connect().then((first) => {
        live = first
        resolve({
          url: `http://127.0.0.1:${port}${MCP_PATH}`,
          token,
          close: async () => {
            await closeLive()
            await new Promise<void>((done) => { http.close(() => { done() }) })
          },
        })
      }, (cause: unknown) => {
        // connect() 失敗不代表 http server 沒在聽:已經 listen(0, ...) 成功了,
        // 不關掉就漏一個 port 到行程結束。
        http.close(() => { reject(cause) })
      })
    })
  })
}
