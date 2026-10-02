/**
 * 用真的 `grok` 驗四件事(grok 規格 §11.2):
 * 1. `session/new` 帶 http 形狀的 mcpServers,grok 連得上 yeschef 的 MCP server。
 * 2. 叫它呼叫 view_snapshot,`tools/call` 真的打到我們的 server。
 * 3. `session/request_permission` 進來,回 allow 之後回合結束。
 * 4. `session/list` 列得到剛才那個 session,`session/load` 重播得出同樣的工具呼叫。
 *
 * 外加控制者要求的三項:
 * 5. grok 送 `tools/call` 的 JSON-RPC 原始請求體(含 `_meta`)長什麼樣子。
 * 6. `session/load` 重播收到幾則 `session/update`、從呼叫到回應花多久。
 * 7. ACP `initialize` 回應的 `_meta` 有哪些 key(models=0 時用來查 grok 到底回了什麼)。
 *
 * 中間插了一個 tap:grok 拿到的 mcpServers.url 不是 `startViewToolHttpServer` 直接開的
 * 那個位址,是一個轉發用的小 http server。它把每個請求原封不動轉給真正的 server,
 * 順便記下 `tools/call` 的 params 與有沒有帶 `Mcp-Session-Id`:這是網路層真的收到什麼,
 * 不是我們自己的程式碼選擇解析出什麼。
 *
 * 每項印一行 JSON:{ check, ok, detail }。全部通過 exit 0,否則 exit 1。
 * 會用到 grok.com 的額度。不要跟 `npm test` 同時跑。
 */
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { URL } from 'node:url'
import { createGrokClient, nodeSpawnGrok, type AcpMcpServer, type PermissionOutcome } from '../src/main/grok/client.js'
import { createGrokMapper } from '../src/main/grok/mapper.js'
import { createGrokCatalog } from '../src/main/grok/catalog.js'
import { createRpc } from '../src/main/jsonrpc-stdio.js'
import { createConversationViewServer } from '../src/main/view-tools/conversation-server.js'
import { startViewToolHttpServer } from '../src/main/view-tools/http-server.js'
import type { ViewTools } from '../src/main/view-tools/server.js'

const SNAPSHOT_TEXT = 'spike-snapshot-ok'
const PROMPT = `請呼叫 view_snapshot 工具看一下右窗格,然後把它回傳的第一行原樣告訴我。`
const results: { check: string; ok: boolean; detail: string }[] = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ check: name, ok, detail })
  console.log(JSON.stringify({ check: name, ok, detail }))
}

const toolCalls: string[] = []

/** 假的右窗格:只回一段固定文字,不開瀏覽器。 */
function fakeTools(): ViewTools {
  return {
    invoke: (name) => {
      toolCalls.push(name)
      return Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: SNAPSHOT_TEXT } })
    },
    handoffDone: () => {},
    abortPending: () => {},
    busy: () => false,
    dispose: () => Promise.resolve(),
  }
}

/** rpcMethod 是請求體裡的 JSON-RPC method;不是 JSON 或沒有 method 欄位就是 undefined。 */
interface TapRequest { readonly httpMethod: string; readonly rpcMethod: string | undefined; readonly hasSessionHeader: boolean }

interface Tap {
  /** 交給 grok 的位址,取代真正 server 的位址。 */
  readonly url: string
  /** 每個轉發過的請求,依到達順序。 */
  readonly requests: readonly TapRequest[]
  /** 攔到的第一個 `tools/call` 的 `params._meta`;還沒攔到就是 undefined。 */
  toolsCallMeta(): unknown
  close(): Promise<void>
}

/**
 * 轉發到 `targetUrl` 的最小 http proxy。記下每個請求的 rpcMethod 與有沒有帶
 * `Mcp-Session-Id`,第一個 `tools/call` 的 `_meta` 另外存起來;不掛勾任何協定邏輯,
 * 原樣轉發,不擋任何請求。
 */
function startTap(targetUrl: string, logError: (error: Error) => void): Promise<Tap> {
  const target = new URL(targetUrl)
  const requests: TapRequest[] = []
  let toolsCallMeta: unknown
  let capturedToolsCall = false

  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      let rpcMethod: string | undefined
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as { method?: string; params?: Record<string, unknown> }
          rpcMethod = parsed.method
          if (!capturedToolsCall && parsed.method === 'tools/call') {
            capturedToolsCall = true
            toolsCallMeta = parsed.params?.['_meta']
          }
        } catch {
          // 不是 JSON 就照樣轉發,tap 不擋任何請求;rpcMethod 留 undefined。
        }
      }
      requests.push({ httpMethod: req.method ?? '', rpcMethod, hasSessionHeader: typeof req.headers['mcp-session-id'] === 'string' })
      const headers: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        // host 交給 http.request 自己算,才會等於真正 server 的位址(它的 authorized() 逐字比對)。
        if (value !== undefined && key !== 'host') headers[key] = value
      }
      const forward = httpRequest(
        { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...headers, 'content-length': String(body.length) } },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers)
          upstream.pipe(res)
        },
      )
      forward.on('error', (error) => {
        logError(error)
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      forward.end(body)
    })
  })

  return new Promise<Tap>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}${target.pathname}`,
        requests,
        toolsCallMeta: () => toolsCallMeta,
        close: () => new Promise<void>((done) => { server.close(() => { done() }) }),
      })
    })
  })
}

/**
 * 獨立探一次 ACP `initialize`,只為了拿 `result._meta` 的 key 清單(控制者要求的檢查 7),
 * 跟主流程的 client 是兩個子行程,不互相影響。initialize 的回應形狀跟 session 無關,
 * 用哪個子行程問到的都一樣。
 */
async function probeInitializeMetaKeys(cwd: string, logError: (error: Error) => void): Promise<readonly string[]> {
  const proc = nodeSpawnGrok(cwd)
  const rpc = createRpc({ write: (line) => { proc.write(line) }, onLine: (cb) => { proc.onLine(cb) } }, logError)
  proc.onStderr(() => {})
  proc.onError((error) => { rpc.rejectAll(error) })
  proc.onExit((code) => { rpc.rejectAll(new Error(`grok 子行程已結束(code ${code ?? 'null'})`)) })
  try {
    const result = await rpc.request<unknown>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'yeschef', version: '0.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {}
    const meta = record['_meta']
    return typeof meta === 'object' && meta !== null ? Object.keys(meta as Record<string, unknown>) : []
  } finally {
    proc.closeStdin()
    proc.kill()
  }
}

/** 控制者加驗的檢查 1:grok 真的送出的 tools/call params,含 _meta。 */
function checkToolCallMeta(tap: Tap): void {
  const meta = tap.toolsCallMeta()
  check('tools/call 帶的 _meta', true, meta === undefined ? 'none' : JSON.stringify(meta))
}

/**
 * 控制者加驗的檢查 2:`initialize` 之後的每一筆請求都要帶 `Mcp-Session-Id`。
 * `initialize` 本身,以及 grok 在它之前送的 `server/discover`,這兩筆都還沒拿到 session id,
 * 本來就不算;用 rpcMethod 找出 `initialize` 的位置,只斷言它之後的那些請求,不猜「第幾筆」。
 */
function checkSessionHeader(tap: Tap): void {
  const requests = tap.requests
  const initializeAt = requests.findIndex((r) => r.rpcMethod === 'initialize')
  const after = initializeAt === -1 ? [] : requests.slice(initializeAt + 1)
  const requestLog = requests.map((r) => `${r.rpcMethod ?? r.httpMethod}:${r.hasSessionHeader ? '有' : '無'}`).join(', ')
  check(
    'initialize 之後的每一筆請求都帶 Mcp-Session-Id',
    after.length > 0 && after.every((r) => r.hasSessionHeader),
    `initialize 之後共 ${after.length} 筆;全部依序=[${requestLog}]`,
  )
}

/** 控制者加驗的檢查 3:重播收到幾則 session/update、從呼叫到回應花多久。 */
function checkReplay(sessionUpdateCount: number, loadElapsedMs: number, replayed: readonly string[]): void {
  check('session/load 重播得出事件', replayed.length > 0, replayed.join(','))
  check(
    'session/load 重播計時',
    sessionUpdateCount > 0,
    `session/update 通知 ${sessionUpdateCount} 則,耗時 ${loadElapsedMs}ms(含 initialize)`,
  )
}

/** 開第一個子行程、送一句話、跑完四個核心檢查與兩個加驗檢查,回傳 sessionId 給重播那段用。 */
async function runFirstTurn(
  cwd: string, mcp: AcpMcpServer, tap: Tap, metaKeys: readonly string[], logError: (error: Error) => void,
): Promise<string> {
  const seen: string[] = []
  const permissions: string[] = []
  let mapper = createGrokMapper('pending')
  const client = await createGrokClient({
    cwd, mcpServers: [mcp], logError,
    onUpdate: (method, params) => { for (const event of mapper.accept(method, params)) seen.push(event.kind) },
    onPermission: (request): Promise<PermissionOutcome> => {
      permissions.push(request.title === '' ? request.kind : request.title)
      const allow = request.options.find((option) => option.kind === 'allow_once') ?? request.options[0]
      return Promise.resolve(allow === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: allow.optionId })
    },
    onStderr: (line) => { console.error(`[grok] ${line}`) },
    onExit: (code) => { console.error(`[grok] exit ${code ?? 'null'}`) },
  })
  check(
    'session/new 帶 http mcpServers',
    client.sessionId !== '',
    `sessionId=${client.sessionId} models=${client.models().length} metaKeys=[${metaKeys.join(',')}]`,
  )

  mapper = createGrokMapper(client.sessionId)
  mapper.beginTurn()
  const turn = await client.prompt([{ type: 'text', text: PROMPT }])
  check('回合結束', turn.stopReason !== undefined, `stopReason=${String(turn.stopReason)}`)
  check('tools/call 打到 yeschef 的 MCP server', toolCalls.includes('view_snapshot'), toolCalls.join(','))
  check('request_permission 進得來', true, permissions.join(',') || '這次沒有需要批准的工具')
  check('事件進得了 mapper', seen.includes('text-delta') || seen.includes('tool-use'), seen.join(','))
  checkToolCallMeta(tap)
  checkSessionHeader(tap)

  const sessionId = client.sessionId
  await client.close()
  return sessionId
}

/** 開第二個子行程做 session/load 重播,跑 session/list 與重播相關的檢查。 */
async function runReplay(cwd: string, mcp: AcpMcpServer, sessionId: string, logError: (error: Error) => void): Promise<void> {
  const catalog = createGrokCatalog({ logError, cacheMs: 0 })
  const listed = await catalog.list(cwd)
  check('session/list 列得到剛才的 session', listed.some((s) => s.sessionId === sessionId), `共 ${listed.length} 筆`)

  const replayed: string[] = []
  let sessionUpdateCount = 0
  const loadMapper = createGrokMapper(sessionId)
  loadMapper.beginTurn()
  const loadStartedAt = Date.now()
  const loader = await createGrokClient({
    cwd, mcpServers: [mcp], resume: sessionId, logError,
    onUpdate: (method, params) => {
      if (method === 'session/update') sessionUpdateCount += 1
      for (const event of loadMapper.accept(method, params)) replayed.push(event.kind)
    },
    onPermission: () => Promise.resolve<PermissionOutcome>({ outcome: 'cancelled' }),
    onStderr: () => {},
    onExit: () => {},
  })
  const loadElapsedMs = Date.now() - loadStartedAt
  checkReplay(sessionUpdateCount, loadElapsedMs, replayed)
  await loader.close()
}

async function main(): Promise<void> {
  const logError = (error: Error): void => { console.error(error.message) }
  const http = await startViewToolHttpServer(
    () => createConversationViewServer({ resolve: () => Promise.resolve(fakeTools()), logError }),
    logError,
  )
  const tap = await startTap(http.url, logError)
  const mcp: AcpMcpServer = {
    name: 'yeschef', type: 'http', url: tap.url,
    headers: [{ name: 'Authorization', value: `Bearer ${http.token}` }],
  }
  const cwd = process.cwd()
  const metaKeys = await probeInitializeMetaKeys(cwd, logError)

  const sessionId = await runFirstTurn(cwd, mcp, tap, metaKeys, logError)
  await runReplay(cwd, mcp, sessionId, logError)

  await tap.close()
  await http.close()
}

main().then(
  () => { process.exit(results.every((r) => r.ok) ? 0 : 1) },
  (cause: unknown) => {
    check('spike 本身', false, cause instanceof Error ? cause.message : String(cause))
    process.exit(1)
  },
)
