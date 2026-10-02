/**
 * 一個 grok 對話的子行程生命週期(grok 規格 §5.2)。
 *
 * 一個對話一個 `grok agent stdio`,cwd 是那個對話的工作目錄。開場兩步:
 * `initialize` → `session/new`(或 `session/load`)。`session/load` 的重播可能很久,
 * 所以不設逾時;`session/prompt` 同理。
 *
 * stderr 是 tracing 格式的 log,含全域 MCP server 連不上的 ERROR。它不是致命錯誤,
 * 一行一行交給 `onStderr`,由上層寫 log,不進對話(規格 §3)。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { isRecord } from '../../shared/ipc.js'
import { createRpc, type CodexIo } from '../jsonrpc-stdio.js'

/** 子行程的最小介面。真的實作見檔尾的 `nodeSpawnGrok`,測試接假的。 */
export interface GrokProcess {
  write(line: string): void
  closeStdin(): void
  kill(signal?: NodeJS.Signals): void
  onLine(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  /** 子行程或它的 stdin 出錯。沒有監聽的話 Node 會把它變成未捕捉例外。 */
  onError(cb: (error: Error) => void): void
  onExit(cb: (code: number | null) => void): void
}

export type SpawnGrok = (cwd: string, model?: string) => GrokProcess

export const MSG = {
  noGrok: 'PATH 找不到 grok,請先安裝',
  loginFirst: '請先在終端機執行 `grok login`',
  noSessionId: 'grok 沒有回 sessionId',
  notStarted: 'grok 尚未啟動,這則訊息未送出',
} as const

export const MSG_NO_GROK = MSG.noGrok

/** grok 回的錯誤裡出現這三個字之一就當成未登入(規格 §5.2)。原文保留,它指得出端點。 */
const AUTH_HINTS = ['auth', 'login', 'unauthorized']

export function withGrokAuthHint(message: string): string {
  const lower = message.toLowerCase()
  return AUTH_HINTS.some((hint) => lower.includes(hint)) ? `${MSG.loginFirst}(${message})` : message
}

export interface GrokModel {
  readonly id: string
  readonly name: string
  readonly reasoningEfforts: readonly string[]
}

/** 交給 grok 的 MCP server 設定。第一版只用 http 這一種形狀(規格 §6.3)。 */
export interface AcpMcpServer {
  readonly name: string
  readonly type: 'http'
  readonly url: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
}

export interface PromptBlock { readonly type: 'text'; readonly text: string }
export interface PromptResult { readonly stopReason: string | undefined }

export interface PermissionOption { readonly optionId: string; readonly name: string; readonly kind: string }

export interface PermissionRequest {
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly rawInput: unknown
  readonly options: readonly PermissionOption[]
}

export type PermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

export interface GrokClientDeps {
  readonly cwd: string
  readonly mcpServers: readonly AcpMcpServer[]
  readonly model?: string
  /** 有給就用 `session/load` 續接,沒給就 `session/new`。 */
  readonly resume?: string
  /** 每一則通知原樣往上送,由 mapper 決定畫什麼。 */
  readonly onUpdate: (method: string, params: unknown) => void
  readonly onPermission: (request: PermissionRequest) => Promise<PermissionOutcome>
  readonly onStderr: (line: string) => void
  readonly onExit: (code: number | null) => void
  readonly logError: (error: Error) => void
  readonly spawn?: SpawnGrok
  readonly requestTimeoutMs?: number
  readonly killDelayMs?: number
}

export interface GrokClient {
  readonly sessionId: string
  prompt(blocks: readonly PromptBlock[]): Promise<PromptResult>
  cancel(): Promise<void>
  close(): Promise<void>
  models(): readonly GrokModel[]
  isRunning(): boolean
}

const DEFAULT_KILL_DELAY_MS = 2000

/**
 * 還活著的 grok 子行程。app 結束時 Electron 不會替我們收掉它們,沒有這張表就會留下
 * 孤兒的 `grok agent stdio`(規格 §5.2)。對話與清單探測兩條路都要登記。
 */
const LIVE_PROCESSES: Set<GrokProcess> = new Set()

export function trackGrokProcess(proc: GrokProcess): void {
  LIVE_PROCESSES.add(proc)
}

export function untrackGrokProcess(proc: GrokProcess): void {
  LIVE_PROCESSES.delete(proc)
}

/** app 結束時把還在的全部收掉。index.ts 在 `app.on('quit')` 呼叫,行程結束也自己叫一次。 */
export function killAllGrokProcesses(): void {
  for (const proc of [...LIVE_PROCESSES]) {
    LIVE_PROCESSES.delete(proc)
    try {
      proc.kill('SIGKILL')
    } catch {
      // 已經沒了就算收掉了。
    }
  }
}

process.on('exit', killAllGrokProcesses)
const PERMISSION_METHOD = 'session/request_permission'
const CANCELLED: PermissionOutcome = { outcome: 'cancelled' }

/** 型別守衛共用 `shared/ipc.ts` 的 `isRecord`,這裡只是把它轉成「取不到就是 null」。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** `_meta.reasoningEfforts` 是物件陣列,每個物件的 `id` 才是要送回去的字串(規格 §3)。 */
function readEfforts(meta: Record<string, unknown> | null): readonly string[] {
  const raw = meta === null ? undefined : meta['reasoningEfforts']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: unknown): readonly string[] => {
    const id = str(asRecord(entry)?.['id'])
    return id === undefined ? [] : [id]
  })
}

/**
 * `initialize` 回應的 `_meta.modelState.availableModels`。拿不到就回空陣列。
 *
 * 實際形狀的 id 欄位叫 `modelId` 不是 `id`(規格 §3 有逐字的一筆);`id` 留著當退路,
 * 協定哪天改回來也讀得到。
 */
export function readModels(result: unknown): readonly GrokModel[] {
  const state = asRecord(asRecord(asRecord(result)?.['_meta'])?.['modelState'])
  const list = state === null ? undefined : state['availableModels']
  if (!Array.isArray(list)) return []
  return list.flatMap((entry: unknown): readonly GrokModel[] => {
    const record = asRecord(entry)
    const id = record === null ? undefined : (str(record['modelId']) ?? str(record['id']))
    if (record === null || id === undefined) return []
    return [{
      id,
      name: str(record['name']) ?? id,
      reasoningEfforts: readEfforts(asRecord(record['_meta'])),
    }]
  })
}

/**
 * `createRpc` 的 request 失敗訊息長 `${method}:${JSON.stringify(error)}`(見 jsonrpc-stdio.ts),
 * 這裡把 grok 自己的 `error.message` 挖出來,不要讓使用者看到 method 名稱與整包 JSON(規格 §5.2)。
 * 格式不符或解不出字串就回原文。
 */
export function rpcErrorMessage(error: Error): string {
  const match = /^[^:]+:(\{.*\})$/.exec(error.message)
  const payload = match?.[1]
  if (payload === undefined) return error.message
  try {
    const message = asRecord(JSON.parse(payload))?.['message']
    return typeof message === 'string' ? message : error.message
  } catch {
    return error.message
  }
}

function readOptions(raw: unknown): readonly PermissionOption[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: unknown): readonly PermissionOption[] => {
    const record = asRecord(entry)
    const optionId = record === null ? undefined : str(record['optionId'])
    if (record === null || optionId === undefined) return []
    return [{ optionId, name: str(record['name']) ?? optionId, kind: str(record['kind']) ?? '' }]
  })
}

export function createGrokClient(deps: GrokClientDeps): Promise<GrokClient> {
  const spawnGrok = deps.spawn ?? nodeSpawnGrok
  const killDelayMs = deps.killDelayMs ?? DEFAULT_KILL_DELAY_MS
  const proc = spawnGrok(deps.cwd, deps.model)
  trackGrokProcess(proc)
  const io: CodexIo = { write: (line) => { proc.write(line) }, onLine: (cb) => { proc.onLine(cb) } }
  const rpc = createRpc(io, deps.logError, deps.requestTimeoutMs, 'grok')

  let sessionId: string | null = null
  let models: readonly GrokModel[] = []
  let alive = true
  let started = false
  let stopped = false
  let closing = false
  let exited: () => void = () => {}
  let stderrBuffer = ''

  const detach = (code: number | null, reason: Error): void => {
    exited()
    untrackGrokProcess(proc)
    if (!alive) return
    alive = false
    rpc.rejectAll(reason)
    // 開場失敗由 boot 的 catch 統一回報;自己發起的 close 也不算「意外結束」(規格 §5.4),
    // 只有子行程自己死掉才通知上層。
    if (started && !closing) deps.onExit(code)
  }

  proc.onStderr((chunk) => {
    stderrBuffer += chunk
    let at = stderrBuffer.indexOf('\n')
    while (at >= 0) {
      const line = stderrBuffer.slice(0, at).trim()
      stderrBuffer = stderrBuffer.slice(at + 1)
      if (line !== '') deps.onStderr(line)
      at = stderrBuffer.indexOf('\n')
    }
  })
  proc.onError((error) => {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    detach(null, missing ? new Error(MSG.noGrok) : new Error(error.message))
  })
  proc.onExit((code) => { detach(code, new Error(`grok 子行程已結束(code ${code ?? 'null'})`)) })

  /** 這則訊息是不是屬於自己的 session。還沒拿到 id 前一律算是。 */
  const mine = (params: unknown): boolean => {
    const target = str(asRecord(params)?.['sessionId'])
    return sessionId === null || target === undefined || target === sessionId
  }

  rpc.onNotification((method, params) => {
    if (!mine(params)) {
      deps.logError(new Error(`grok 送來不是這個 session 的 ${method}(${String(asRecord(params)?.['sessionId'])}),已丟棄`))
      return
    }
    deps.onUpdate(method, params)
  })

  const handlePermission = async (params: unknown): Promise<unknown> => {
    if (!mine(params)) {
      deps.logError(new Error(`grok 的 ${PERMISSION_METHOD} 不屬於這個 session,回 cancelled`))
      return { outcome: CANCELLED }
    }
    const toolCall = asRecord(asRecord(params)?.['toolCall']) ?? {}
    const outcome = await deps.onPermission({
      toolCallId: str(toolCall['toolCallId']) ?? '',
      title: str(toolCall['title']) ?? '',
      kind: str(toolCall['kind']) ?? '',
      rawInput: toolCall['rawInput'] ?? null,
      options: readOptions(asRecord(params)?.['options']),
    })
    // 回覆之前對話被收掉:一律 cancelled,不讓已經沒人管的工具跑起來(規格 §5.2)。
    return { outcome: closing || !alive ? CANCELLED : outcome }
  }

  rpc.onServerRequest(async (method, params) => {
    if (method === PERMISSION_METHOD) return await handlePermission(params)
    // 認不得的請求交給 rpc 回錯誤;不回覆會讓 grok 的回合永遠等下去。
    throw new Error(`不認得的 grok 請求 ${method}`)
  })

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    closing = true
    // 子行程已經死了就沒有什麼好等的,直接收尾,不要白白等滿 killDelayMs。
    if (!alive) {
      proc.kill()
      detach(null, new Error('grok 子行程已收掉'))
      return
    }
    // 先裝等待器再關 stdin,同步退出也不會漏接。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, killDelayMs)
      exited = () => { clearTimeout(timer); resolve() }
      proc.closeStdin()
    })
    proc.kill()
    detach(null, new Error('grok 子行程已收掉'))
  }

  const client: GrokClient = {
    get sessionId() { return sessionId ?? '' },
    prompt: async (blocks) => {
      if (!alive || sessionId === null) throw new Error(MSG.notStarted)
      const result = await rpc.request<unknown>('session/prompt', { sessionId, prompt: [...blocks] }, null)
      return { stopReason: str(asRecord(result)?.['stopReason']) }
    },
    cancel: () => {
      if (alive && sessionId !== null) rpc.notify('session/cancel', { sessionId })
      return Promise.resolve()
    },
    close: async () => {
      closing = true
      if (alive && sessionId !== null) {
        try {
          await rpc.request<unknown>('session/close', { sessionId })
        } catch (cause) {
          deps.logError(cause instanceof Error ? cause : new Error(String(cause)))
        }
      }
      await stop()
    },
    models: () => models,
    isRunning: () => alive && !stopped,
  }

  const open = async (): Promise<void> => {
    const params = { cwd: deps.cwd, mcpServers: [...deps.mcpServers] }
    if (deps.resume !== undefined) {
      // 先記下 id,重播的 session/update 才通得過 mine()。重播可能很久,不設逾時。
      sessionId = deps.resume
      await rpc.request<unknown>('session/load', { sessionId: deps.resume, ...params }, null)
      return
    }
    const opened = await rpc.request<unknown>('session/new', params)
    const id = str(asRecord(opened)?.['sessionId'])
    if (id === undefined) throw new Error(MSG.noSessionId)
    sessionId = id
  }

  const boot = async (): Promise<GrokClient> => {
    const initialize = await rpc.request<unknown>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'yeschef', version: '0.0.0' },
      // 規格 §10:檔案與終端機的 client 能力一律 false,grok 自己做。
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    models = readModels(initialize)
    await open()
    started = true
    return client
  }

  return boot().catch(async (cause: unknown) => {
    await stop()
    const error = cause instanceof Error ? cause : new Error(String(cause))
    throw new Error(withGrokAuthHint(rpcErrorMessage(error)), { cause: error })
  })
}

/** 真的起一個 `grok agent stdio`。沒有單元測試,行為靠 spike 與實機驗收(規格 §11)。 */
export const nodeSpawnGrok: SpawnGrok = (cwd, model) => {
  const args = ['agent', 'stdio', ...(model === undefined ? [] : ['--model', model])]
  const child = nodeSpawn('grok', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false
  let report: (error: Error) => void = () => {}
  // ChildProcess 與 stdin 的 error 必須接住;spawn 失敗只發 error 不發 exit。
  child.on('error', (error) => { closed = true; report(error) })
  child.stdin?.on('error', (error) => { closed = true; report(error) })
  return {
    write: (line) => { if (!closed) child.stdin?.write(line) },
    closeStdin: () => { closed = true; child.stdin?.end() },
    kill: (signal) => { closed = true; child.kill(signal ?? 'SIGTERM') },
    onLine: (cb) => { child.stdout?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onStderr: (cb) => { child.stderr?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onError: (cb) => { report = cb },
    onExit: (cb) => { child.on('exit', (code) => { closed = true; cb(code) }) },
  }
}
