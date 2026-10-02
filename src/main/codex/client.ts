import { attachmentPrompt, type PromptAttachment } from '../../shared/conversation-tools.js'
/**
 * 一個 codex 對話的子程序生命週期(規格 §5)。
 *
 * 一個對話一個 `codex app-server`,cwd 是專案根目錄。開場固定四步:
 * spawn → `initialize` → `initialized` → `thread/start` 或 `thread/resume`。
 * 收掉時關 stdin、等 2 秒、SIGTERM。
 *
 * 批准與其他 server 請求都在這裡接住:認不得的也一定要回覆,不回覆會讓 codex 的 turn
 * 永遠等下去(見 rpc.ts 的說明)。
 */
import { PEER_MSG } from '../peer/errors.js'
import { spawn as nodeSpawn } from 'node:child_process'
import { createRpc, type CodexIo } from '../jsonrpc-stdio.js'

/** 子程序的最小介面。真的實作見檔尾的 `nodeSpawnCodex`,測試接假的。 */
export interface CodexProcess {
  write(line: string): void
  closeStdin(): void
  kill(): void
  onLine(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  /** 子程序或它的 stdin 出錯。沒有監聽的話 Node 會把它變成未捕捉例外,整個主行程掛掉。 */
  onError(cb: (error: Error) => void): void
  onExit(cb: (code: number | null) => void): void
}

export type SpawnCodex = (cwd: string) => CodexProcess

export type ApprovalKind = 'command' | 'fileChange'

/** 兩種批准請求的方法名 → 我們自己的分類。
 * schema 的其他 server 請求目前走「認不得」:item/permissions/requestApproval、
 * mcpServer/elicitation/request、account/chatgptAuthTokens/refresh、
 * attestation/generate、currentTime/read。
 */
export const APPROVAL_METHODS: Readonly<Record<string, ApprovalKind>> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
}

/** codex 要問使用者問題:第一版回空答案並記 log(規格 §3)。 */
const USER_INPUT_METHOD = 'item/tool/requestUserInput'

const DEFAULT_KILL_DELAY_MS = 2000

/** codex app-server 的 dynamic tool 規格(RESULTS-11、RESULTS-16 實測過的形狀)。 */
export interface CodexDynamicTool {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/**
 * `item/tool/call` 的參數。`callId` 與同一刻 `item/started` 的 `item.id` 逐字相同
 * (RESULTS-22 §9),所以宿主可以直接拿它當畫面上那顆 item 的 key,不必另建對照表。
 */
export interface DynamicToolCallParams {
  readonly threadId: string
  readonly turnId: string
  readonly callId: string | null
  readonly tool: string
}

/**
 * 宿主回給 codex 的結果。有圖就多一項 `inputImage`,`imageDataUrl` 必須是 data: URL:
 * https 會被 app-server 擋掉並把 item 改成 failed(RESULTS-22 §1)。
 */
export interface CodexToolOutcome {
  readonly ok: boolean
  readonly text: string
  readonly imageDataUrl?: string
}

/** codex 呼叫宿主提供的工具。回覆前那個 turn 不會結束,逾時由宿主自己管。 */
export const TOOL_CALL_METHOD = 'item/tool/call'

export interface CodexClientDeps {
  readonly model?: string
  readonly effort?: string
  readonly skillRoots?: readonly string[]
  /** 給 codex 的工具規格。`thread/start` 與 `thread/resume` 都會帶上。 */
  readonly dynamicTools?: readonly CodexDynamicTool[]
  /** codex 呼叫工具時問這裡。回 `ok: false` 就是把錯誤講給模型聽,不是協定層的錯誤。 */
  readonly onDynamicToolCall?: (tool: string, args: unknown, params: DynamicToolCallParams) => Promise<CodexToolOutcome>

  readonly cwd: string
  readonly logError: (error: Error) => void
  /** 每一則通知原樣往上送,由 mapper 決定畫什麼。 */
  readonly onEvents: (method: string, params: unknown) => void
  readonly onApproval: (kind: ApprovalKind, params: Record<string, unknown>) => Promise<'accept' | 'decline'>
  /** 子程序結束(自己死或被我們收掉)。 */
  readonly onExit: (code: number | null) => void
  readonly spawn?: SpawnCodex
  readonly requestTimeoutMs?: number
  readonly killDelayMs?: number
}

export interface CodexClient {
  shutdownConfirmed?(): boolean
  /** 沒給 threadId 就 `thread/start`,有就 `thread/resume`。 */
  start(threadId?: string): Promise<{ threadId: string; model?: string }>
  send(text: string, attachments?: readonly PromptAttachment[]): Promise<void>
  /** 有進行中的 turn 才送 `turn/interrupt`。 */
  interrupt(): Promise<void>
  teardown(): Promise<void>
  isRunning(): boolean
}

const toolResult = (outcome: CodexToolOutcome): unknown => ({
  success: outcome.ok,
  contentItems: outcome.imageDataUrl === undefined
    ? [{ type: 'inputText', text: outcome.text }]
    : [
        // 文字在前圖在後,兩項都會進模型(RESULTS-22 §2)。
        { type: 'inputText', text: outcome.text },
        { type: 'inputImage', imageUrl: outcome.imageDataUrl },
      ],
})

/** params 的欄位缺了不能讓整個呼叫失敗:模型還在等回覆,回覆晚一步整個 turn 就停住。 */
const readString = (value: unknown): string => (typeof value === 'string' ? value : '')

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `thread/start` 與 `thread/resume` 的回應都是 `{ thread: { id }, model }`。 */
function readThread(result: unknown): { threadId: string; model?: string } | null {
  if (!isRecord(result) || !isRecord(result['thread'])) return null
  const id = result['thread']['id']
  if (typeof id !== 'string' || id === '') return null
  const model = result['model']
  return typeof model === 'string' ? { threadId: id, model } : { threadId: id }
}

export function createCodexClient(deps: CodexClientDeps): CodexClient {
  const spawnCodex = deps.spawn ?? nodeSpawnCodex
  const killDelayMs = deps.killDelayMs ?? DEFAULT_KILL_DELAY_MS
  let proc: CodexProcess | null = null
  let latestProcess: CodexProcess | null = null
  let exitedConfirmed = true
  let rpc: ReturnType<typeof createRpc> | null = null
  let threadId: string | null = null
  let turnId: string | null = null
  let closing = false
  let exited: () => void = () => {}

  const handleNotification = (method: string, params: unknown): void => {
    // turn/started 與 turn/completed 兩則我們自己也要看:interrupt 需要現行的 turnId。
    if (method === 'turn/started' && isRecord(params) && isRecord(params['turn'])) {
      const id = params['turn']['id']
      turnId = typeof id === 'string' ? id : null
    }
    if (method === 'turn/completed') turnId = null
    deps.onEvents(method, params)
  }

  /**
   * codex 呼叫宿主的工具。一律回 `{ success, contentItems }`,不丟 JSON-RPC 錯誤:
   * 錯誤要以文字回給模型,模型才有辦法改做法(RESULTS-16 驗過失敗的文字會進到它的答案)。
   */
  const handleToolCall = async (params: unknown): Promise<unknown> => {
    const record = isRecord(params) ? params : {}
    const tool = record['tool']
    const handler = deps.onDynamicToolCall
    if (typeof tool !== 'string' || tool === '' || handler === undefined) {
      const why = typeof tool === 'string' && tool !== '' ? PEER_MSG.codexToolUnavailable(tool) : PEER_MSG.codexToolNameMissing
      deps.logError(new Error(`${TOOL_CALL_METHOD}:${why}`))
      return toolResult({ ok: false, text: why })
    }
    const callParams: DynamicToolCallParams = {
      threadId: readString(record['threadId']),
      turnId: readString(record['turnId']),
      callId: readString(record['callId']) || null,
      tool,
    }
    try {
      return toolResult(await handler(tool, record['arguments'], callParams))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      deps.logError(new Error(`${TOOL_CALL_METHOD}(${tool}):${message}`))
      return toolResult({ ok: false, text: message })
    }
  }

  const handleServerRequest = async (method: string, params: unknown): Promise<unknown> => {
    const kind = APPROVAL_METHODS[method]
    if (kind !== undefined) {
      const decision = await deps.onApproval(kind, isRecord(params) ? params : {})
      return { decision }
    }
    if (method === TOOL_CALL_METHOD) return await handleToolCall(params)
    if (method === USER_INPUT_METHOD) {
      deps.logError(new Error(`codex 送來 ${USER_INPUT_METHOD},第一版回空答案:${JSON.stringify(params).slice(0, 200)}`))
      // schema 要求 answers 必填。
      return { answers: {} }
    }
    // 認不得的請求交給 rpc 回錯誤(它會記 log)。不回覆會讓 codex 的 turn 永遠等下去。
    throw new Error(`不認得的 codex 請求 ${method}`)
  }

  const detach = (code: number | null): void => {
    exited()
    const had = proc !== null
    proc = null
    rpc?.rejectAll(new Error(`codex 子程序已結束(code ${code ?? 'null'})`))
    rpc = null
    turnId = null
    if (!had) return
    if (!closing && code !== 0) deps.logError(new Error(`codex 子程序非預期結束,code ${code ?? 'null'}`))
    deps.onExit(code)
  }

  const boot = (): ReturnType<typeof createRpc> => {
    const p = spawnCodex(deps.cwd)
    const io: CodexIo = { write: (line) => { p.write(line) }, onLine: (cb) => { p.onLine(cb) } }
    const r = createRpc(io, deps.logError, deps.requestTimeoutMs)
    r.onNotification(handleNotification)
    r.onServerRequest(handleServerRequest)
    p.onStderr((chunk) => {
      const text = chunk.trim()
      if (text !== '') deps.logError(new Error(`codex stderr:${text.slice(0, 300)}`))
    })
    p.onError((error) => {
      deps.logError(new Error(`codex 子程序錯誤:${error.message}`))
      detach(null)
    })
    latestProcess = p; exitedConfirmed = false
    p.onExit((code) => { if (latestProcess === p) exitedConfirmed = true; detach(code) })
    proc = p
    rpc = r
    return r
  }

  const stop = async (): Promise<void> => {
    const p = proc
    if (p === null) return
    closing = true
    try {
      // 先裝等待器再關 stdin,同步退出也不會漏接。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, killDelayMs)
        exited = () => { clearTimeout(timer); resolve() }
        p.closeStdin()
      })
      if (proc === p) p.kill()
    } finally {
      closing = false
      exited = () => {}
      if (proc === p) detach(null)
    }
  }

  return {
    async start(existingThreadId) {
      const r = boot()
      try {
        await r.request('initialize', {
          clientInfo: { name: 'yeschef', title: 'YesChef', version: '0.0.0' },
          capabilities: { experimentalApi: true },
        })
        r.notify('initialized')
        if (deps.skillRoots?.length) {
          try {
            await r.request('skills/extraRoots/set', { extraRoots: [...deps.skillRoots] })
          } catch (error) {
            throw new Error('Codex 無法載入共用 Skills。請確認 Codex CLI 支援 skills/extraRoots/set，更新後重開對話。', { cause: error })
          }
        }
        // 保留 workspace-write 沙箱;網路或工作區外操作可提出批准後重試。
        // untrusted 下允許命令不會解除網路沙箱,且不允許 require_escalated,使本機 DB 測試卡住。
        // 預設是 read-only,那會讓 codex 連問都不問就拒絕所有檔案編輯(實機驗收抓到的)。
        const common = { ...(deps.model ? { model: deps.model } : {}), approvalPolicy: 'on-request' as const, sandbox: 'workspace-write' as const }
        const tools = deps.dynamicTools
        const result = existingThreadId === undefined
          ? await r.request('thread/start', { cwd: deps.cwd, ...common, dynamicTools: tools ?? [] })
          : await r.request('thread/resume', {
              threadId: existingThreadId,
              ...common,
              ...(tools === undefined ? {} : { dynamicTools: tools }),
            })
        const thread = readThread(result)
        if (thread === null) throw new Error('codex 沒有回 thread id')
        threadId = thread.threadId
        return thread
      } catch (cause) {
        await stop()
        throw cause instanceof Error ? cause : new Error(String(cause))
      }
    },
    async send(text, attachments = []) {
      const r = rpc
      if (r === null || threadId === null) throw new Error('codex 尚未啟動,這則訊息未送出')
      await r.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: attachmentPrompt(text, attachments) }, ...attachments.filter(a => a.kind === 'image').map(a => ({ type: 'localImage', path: a.path }))],
        ...(deps.effort === undefined ? {} : { effort: deps.effort }),
      }, null)
    },
    async interrupt() {
      const r = rpc
      if (r === null || threadId === null || turnId === null) return
      await r.request('turn/interrupt', { threadId, turnId }, null)
    },
    shutdownConfirmed: () => exitedConfirmed,
    teardown: stop,
    isRunning: () => proc !== null,
  }
}

/** 真的起一個 `codex app-server`。沒有單元測試,行為靠實機驗收(規格 §8)。 */
export const nodeSpawnCodex: SpawnCodex = (cwd) => {
  const child = nodeSpawn('codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false
  let report: (error: Error) => void = () => {}
  // ChildProcess 與 stdin 的 error 必須接住;spawn 失敗只發 error 不發 exit。
  child.on('error', (error) => { closed = true; report(error) })
  child.stdin?.on('error', (error) => { closed = true; report(error) })
  return {
    // 關閉後晚到的回覆直接丟掉,避免 EPIPE。
    write: (line) => { if (!closed) child.stdin?.write(line) },
    closeStdin: () => { closed = true; child.stdin?.end() },
    kill: () => { closed = true; child.kill('SIGTERM') },
    onLine: (cb) => { child.stdout?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onStderr: (cb) => { child.stderr?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onError: (cb) => { report = cb },
    onExit: (cb) => { child.on('exit', (code) => { closed = true; cb(code) }) },
  }
}
