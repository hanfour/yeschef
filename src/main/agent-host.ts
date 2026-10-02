import { attachmentLabel, attachmentPrompt, type PromptAttachment } from '../shared/conversation-tools.js'
import { INITIAL_CURSOR, stepLive, type Event, type LiveCursor } from '../shared/events.js'
import type { ApprovalAsk, ApprovalOutcome } from './approval.js'
import type { SessionOptions } from './session-args.js'

// ───────────────────────── 事件合併（純函式） ─────────────────────────

export interface MergeConfig {
  /** 一幀的長度。規格 §3.1 給的方向。 */
  readonly frameMs: number
  /**
   * 單一批次的事件數上限。
   *
   * 逐字串流的正常速率下一幀只有一兩筆，這個上限碰不到。它擋的是三種爆量情況：
   * 工具結果一次回填、compact 切點一次吐出整段歷史、歷史對話重播。沒有上限時
   * 一次 `webContents.send` 要序列化整包，renderer 收到後一次 fold 全量，畫面停住。
   *
   * 超過上限的處理是**在同一次呼叫內切成滿批送出**，不是丟掉、也不是壓到下一幀。
   * 所以這個上限只影響「一次 send 多大」，不影響事件何時到、以什麼順序到。
   */
  readonly maxBatchSize: number
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = { frameMs: 16, maxBatchSize: 128 }

export interface MergeState {
  readonly pending: readonly Event[]
  /** 這一幀的起點。null 表示沒有待送事件。 */
  readonly frameStartedAt: number | null
}

export const INITIAL_MERGE_STATE: MergeState = { pending: [], frameStartedAt: null }

export interface MergeStep {
  readonly state: MergeState
  /** 這一步要送出的批次，依序送。永遠不含空批次。 */
  readonly batches: readonly (readonly Event[])[]
}

const NO_BATCHES: readonly (readonly Event[])[] = []

function configOf(config?: MergeConfig): MergeConfig {
  return config ?? DEFAULT_MERGE_CONFIG
}

/**
 * 收下新事件。
 *
 * 不變量：回傳的 `state.pending.length` 永遠小於 `maxBatchSize`。
 * 不變量：`batches` 串接起來再接上 `state.pending`，等於舊的 pending 接上 incoming。
 */
export function mergeAccept(
  state: MergeState,
  incoming: readonly Event[],
  now: number,
  config?: MergeConfig
): MergeStep {
  if (incoming.length === 0) return { state, batches: NO_BATCHES }

  const cfg = configOf(config)
  const all = [...state.pending, ...incoming]
  const fullCount = Math.floor(all.length / cfg.maxBatchSize)
  const batches: (readonly Event[])[] = []
  for (let i = 0; i < fullCount; i += 1) {
    batches.push(all.slice(i * cfg.maxBatchSize, (i + 1) * cfg.maxBatchSize))
  }
  const rest = all.slice(fullCount * cfg.maxBatchSize)

  if (rest.length === 0) return { state: INITIAL_MERGE_STATE, batches }

  // 已經開著的幀不因為新事件而延後截止：起點只在幀是新開的、或剛切完滿批時重設。
  const frameStartedAt = batches.length === 0 && state.frameStartedAt !== null ? state.frameStartedAt : now
  return { state: { pending: rest, frameStartedAt }, batches }
}

/** 幀到期就把 pending 整包送出。未到期或沒有 pending 時是 no-op。 */
export function mergeTick(state: MergeState, now: number, config?: MergeConfig): MergeStep {
  const wakeAt = mergeWakeAt(state, config)
  if (wakeAt === null || now < wakeAt) return { state, batches: NO_BATCHES }
  return { state: INITIAL_MERGE_STATE, batches: [state.pending] }
}

/** 不管幀有沒有到期，立刻送完。收尾時用，確保緩衝裡的事件不被吞掉。 */
export function mergeFlush(state: MergeState): MergeStep {
  if (state.pending.length === 0) return { state, batches: NO_BATCHES }
  return { state: INITIAL_MERGE_STATE, batches: [state.pending] }
}

/** 這一幀的絕對截止時間。合併器外層用它算 setTimeout 的延遲，純函式本身不碰計時器。 */
export function mergeWakeAt(state: MergeState, config?: MergeConfig): number | null {
  if (state.frameStartedAt === null || state.pending.length === 0) return null
  return state.frameStartedAt + configOf(config).frameMs
}

// ───────────────────────── 合併器外層（有狀態） ─────────────────────────

export interface MergerClock {
  readonly now: () => number
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
}

export const SYSTEM_CLOCK: MergerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface EventMerger {
  accept(events: readonly Event[]): void
  flush(): void
  dispose(): void
}

export interface EventMergerOptions {
  readonly onBatch: (events: readonly Event[]) => void
  readonly config?: MergeConfig
  readonly clock?: MergerClock
}

/**
 * 把純函式的合併規則接上真實計時器。時鐘可注入，所以測試不必動用 fake timers。
 */
export function createEventMerger(options: EventMergerOptions): EventMerger {
  const cfg = configOf(options.config)
  const clock = options.clock ?? SYSTEM_CLOCK
  let state: MergeState = INITIAL_MERGE_STATE
  let timer: unknown = null
  let disposed = false

  const cancelTimer = (): void => {
    if (timer === null) return
    clock.clearTimer(timer)
    timer = null
  }

  const apply = (step: MergeStep): void => {
    state = step.state
    for (const batch of step.batches) options.onBatch(batch)
    cancelTimer()
    const wakeAt = mergeWakeAt(state, cfg)
    if (wakeAt === null || disposed) return
    timer = clock.setTimer(onTimer, Math.max(0, wakeAt - clock.now()))
  }

  function onTimer(): void {
    timer = null
    if (disposed) return
    apply(mergeTick(state, clock.now(), cfg))
  }

  return {
    accept: (events) => {
      if (disposed) return
      apply(mergeAccept(state, events, clock.now(), cfg))
    },
    flush: () => {
      if (disposed) return
      apply(mergeFlush(state))
    },
    dispose: () => {
      disposed = true
      cancelTimer()
    },
  }
}

// ───────────────────────── SDK 的窄化型別 ─────────────────────────

/**
 * `query()` 回傳值中我們真正用到的部分。
 *
 * 刻意不 import SDK 的 `Query`：這裡是與 SDK 交接的地方，跟 Task 3 的正規化層同一個理由。
 * 窄化到三件事（迭代、interrupt、close）之後，SDK 版本變動的衝擊面就只有
 * `ipc-bridge.ts` 裡那一行轉接，而且那一行有型別檢查擋著。
 */
export interface QueryHandle extends AsyncIterable<unknown> {
  /**
   * 回傳型別刻意是 `Promise<unknown>`：SDK 0.3.258 的 `Query.interrupt()` 回的是
   * `Promise<SDKControlInterruptResponse | undefined>`，標成 `Promise<void>` 會讓
   * `ipc-bridge.ts` 的 `defaultQueryFn` 那一行過不了 typecheck（worktree 實測）。
   * 我們不看這個回傳值。
   */
  interrupt(): Promise<unknown>
  close(): void
}

/** 送進 prompt 串流的一則使用者輸入。欄位對齊 SDK 的 `SDKUserMessage`。 */
export interface UserTurn {
  readonly type: 'user'
  readonly message: { readonly role: 'user'; readonly content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } }> }
  readonly parent_tool_use_id: null
}

export type SdkPermissionResult =
  | { readonly behavior: 'allow'; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string }

/**
 * SDK 的 `CanUseTool` options 裡我們真正用到的三個欄位（裁決 11／28）。
 * 已查證：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（0.3.258）
 * 第 209 行宣告 `CanUseTool`，第 233 行是 `title?: string`、第 238 行是
 * `displayName?: string`、第 248 行是**必填**的 `toolUseID: string`。
 * 裁決 11 當時誤判為「沒有 tool_use_id」而改用內容比對，裁決 28 已把它作廢。
 *
 * 只宣告這三個欄位是刻意的：函式參數是逆變位置，SDK 那個更寬的
 * options（含必填的 `signal`）仍然指派得進來，而我們不必跟著它的其他欄位走。
 * 欄位名與 Task 6 的 `ApprovalAsk` 對齊（`toolUseID` 是 SDK 的拼法，我們的
 * 欄位叫 `toolUseId`），`canUseTool` 只要補上 `toolName` 與 `input` 就是一個
 * 完整的 ask（裁決 16）。
 */
export interface CanUseToolOptions {
  readonly toolUseID: string
  readonly title?: string
  readonly displayName?: string
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions
) => Promise<SdkPermissionResult>

export type QueryFn = (params: {
  readonly prompt: AsyncIterable<UserTurn>
  readonly options: SessionOptions & { readonly canUseTool: CanUseToolFn }
}) => QueryHandle

/** Task 6 的 `ApprovalOutcome` → SDK 的 `PermissionResult`。 */
export function toPermissionResult(
  outcome: ApprovalOutcome,
  input: Record<string, unknown>
): SdkPermissionResult {
  if (outcome.decision === 'allow') return { behavior: 'allow', updatedInput: input }
  return { behavior: 'deny', message: outcome.reason ?? '使用者拒絕' }
}

// ───────────────────────── 輸入佇列 ─────────────────────────

interface InputQueue {
  push(turn: UserTurn): boolean
  close(): void
  readonly stream: AsyncIterable<UserTurn>
}

/**
 * `prompt` 必須是 AsyncIterable 而不能是字串：`interrupt()` 是控制請求，
 * SDK 只在 streaming input 模式下支援。這個佇列就是那個串流。
 * 只有 SDK 一個讀取端，所以只需要一個等待中的 resolver。
 */
function createInputQueue(): InputQueue {
  const buffered: UserTurn[] = []
  let waiting: ((r: IteratorResult<UserTurn>) => void) | null = null
  let closed = false

  return {
    push: (turn) => {
      if (closed) return false
      const w = waiting
      if (w) {
        waiting = null
        w({ value: turn, done: false })
        return true
      }
      buffered.push(turn)
      return true
    },
    close: () => {
      if (closed) return
      closed = true
      const w = waiting
      if (w) {
        waiting = null
        w({ value: undefined, done: true })
      }
    },
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const head = buffered.shift()
          if (head !== undefined) return Promise.resolve({ value: head, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise<IteratorResult<UserTurn>>((resolve) => {
            waiting = resolve
          })
        },
      }),
    },
  }
}

// ───────────────────────── 宿主 ─────────────────────────

export interface AgentHostDeps {
  readonly strictShutdown?: boolean
  readonly queryFn: QueryFn
  /** 包住 `buildSessionOptions()`（Task 1）；resume 目標由 `start()` 傳入。 */
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  /** 接 Task 6 的 `registry.request(ask)`（裁決 16：一個物件，含 title／displayName）。 */
  readonly requestApproval: (ask: ApprovalAsk) => Promise<ApprovalOutcome>
  readonly onBatch: (events: readonly Event[]) => void
  readonly onError: (error: Error) => void
  /** query 自己走完時通知呼叫端（裁決 6：bridge 據此送 `session-ended` action）。 */
  readonly onEnded: () => void
  readonly merge?: MergeConfig
  readonly clock?: MergerClock
  /**
   * 回 true 時 `canUseTool` 直接 allow，不進批准流程（契約 §11.2）。
   * 預設沒有這個函式，等同一律 false：既有行為不變。
   */
  readonly autoAllow?: (toolName: string, toolUseId: string) => boolean
}

/**
 * 裁決 6 之後 host 是**長生命週期**物件：建構不開 query，`start()` 才開，
 * `teardown()` 之後還可以再 `start()`。
 *
 * 初稿是「建構即開 query」，那是因為當時 bridge 靠反推生命週期，換 session 就整個
 * 重建 host。狀態機搬進 main 之後 `start-query` 變成一個 effect，effect 需要的是一個
 * 可以重複開關的把手，不是一次性的建構子。
 */
export interface AgentHost {
  shutdownConfirmed?(): boolean
  /** 對應 Task 5 的 `start-query` effect。已有活躍 query 時是接線錯誤，回報後忽略。 */
  start(resumeSessionId?: string, initialInput?: string, attachments?: readonly PromptAttachment[]): void
  /** 回傳 false 表示沒有活躍 query，這則輸入沒有被送出。呼叫端要處理，不得忽略。 */
  send(text: string, attachments?: readonly PromptAttachment[]): boolean
  /** 中止進行中的工具，但不收掉 query：之後還可以繼續送輸入。 */
  interrupt(): Promise<void>
  /** 收掉目前的 query。resolve 之後保證不會再有 `onBatch`。可重複呼叫。 */
  teardown(): Promise<void>
}

/** query 收不掉時的最長等待。超過就記錄並放行，不讓視窗關閉卡住。 */
export const TEARDOWN_TIMEOUT_MS = 2_000

/**
 * `interrupt()` 回不來時的最長等待。
 *
 * interrupt 是送給 SDK 的控制請求，要等對方回覆；對方沒回就是一個永遠 pending 的
 * promise。它排在 `ipc-bridge` 那條串行 effects 鏈上，卡住的不只是這一次中止，
 * 而是後面所有 action 的 effects，畫面會停在沒有任何說明的狀態。逾時就記錄並放行，
 * 讓後面的 teardown 照跑。
 */
export const INTERRUPT_TIMEOUT_MS = 2_000

/**
 * 把任何丟出來的東西包成帶上下文的 Error。`ipc-bridge` 也用它，所以匯出。
 *
 * Ruling 8：用 `cause` 而不是把原始 `stack` 搬過來。搬 stack 會讓 console.error
 * 印出來的堆疊只剩原始的 header，`effects(open-history)` 這類 context 整段不見；
 * `cause` 讓兩層都留著。寫法與 `session-store.ts` 的 `wrap()` 一致。
 */
export function asError(err: unknown, context: string): Error {
  const detail = err instanceof Error ? err.message : String(err)
  return new Error(`${context}：${detail}`, { cause: err })
}

function toUserTurn(text: string, attachments: readonly PromptAttachment[] = []): UserTurn {
  if (attachments.length) {
    const content: Exclude<UserTurn['message']['content'], string> = [{ type: 'text', text: attachmentPrompt(text, attachments) }]
    for (const a of attachments) if (a.kind === 'image' && a.data && a.mime !== 'application/octet-stream') content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
  }
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

/**
 * 送一句使用者輸入進 query，並在事件流合成同一句的 user-text：現行 SDK 的
 * streaming input 不回送 user 訊息，不合成的話 live 對話裡看不到自己說了什麼。
 * 只在 push 成功時合成，佇列已關閉就什麼都不留，回傳值給呼叫端決定要不要 log。
 */
function pushUserTurn(q: LiveQuery, text: string, attachments?: readonly PromptAttachment[]): boolean {
  if (!q.input.push(toUserTurn(text, attachments))) return false
  q.merger.accept([{ kind: 'user-text', text: attachmentLabel(text, attachments) }])
  return true
}

/** 一條活躍 query 的全部可變狀態。換 session 就整個換掉，不留半條舊的。 */
interface LiveQuery {
  readonly handle: QueryHandle
  readonly input: InputQueue
  readonly merger: EventMerger
  /** 裁決 2：游標一個 query 一份。module 層級不得有可變狀態。 */
  cursor: LiveCursor
  torndown: boolean
  finished: boolean
  closeSucceeded: boolean
  /** 事件迴圈的完成訊號。物件建好之後才填，所以不是 readonly。 */
  settled: Promise<void>
}

export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const clock = deps.clock ?? SYSTEM_CLOCK
  let current: LiveQuery | null = null
  let latest: LiveQuery | null = null
  let approvalGeneration = 0
  let teardownPromise: Promise<void> | null = null

  const canUseTool = (executionCwd: string, generation: number): CanUseToolFn => async (toolName, toolInput, options) => {
    if (generation !== approvalGeneration) return { behavior: 'deny', message: '對話已結束' }
    // 政策放行的工具不打擾使用者（契約 §11.2）。這一段必須在 requestApproval
    // 之前：放在之後等於卡片已經送到 renderer，再自動放行就是兩套答案。
    // autoAllow 丟例外時視同 false 往批准流程倒，不讓一個政策函式的 bug 中斷 query。
    try {
      if (deps.autoAllow?.(toolName, options.toolUseID) === true) {
        return { behavior: 'allow', updatedInput: toolInput }
      }
    } catch (err) {
      deps.onError(asError(err, `工具 ${toolName} 的自動放行判斷失敗`))
    }

    try {
      // 裁決 16：整個 ask 一個物件送進去，registry 補 requestId 再原樣轉給 sendRequest。
      // tsconfig 沒開 exactOptionalPropertyTypes，undefined 直接賦給選填欄位即可，
      // 不必條件展開。`toolUseId` 來自 SDK options 的 `toolUseID`（裁決 28），
      // renderer 靠它把卡片掛到對應的 tool block 上。
      const outcome = await deps.requestApproval({
        toolName,
        input: toolInput,
        executionCwd,
        validateEvidence: () => generation === approvalGeneration,
        toolUseId: options.toolUseID,
        title: options.title,
        displayName: options.displayName,
      })
      return toPermissionResult(outcome, toolInput)
    } catch (err) {
      // 批准流程壞掉時往 deny 倒。掛著不回覆會讓整條 query 卡死（規格 §8）。
      deps.onError(asError(err, `工具 ${toolName} 的批准流程失敗`))
      return { behavior: 'deny', message: '批准流程失敗，已拒絕' }
    }
  }

  /**
   * 開不成 query 的共同出口（裁決 20 的 sessionOptions 失敗、Ruling 9 的 queryFn 同步 throw）。
   *
   * 三件事缺一不可：`onError` 讓錯誤進主程序 log、`onBatch` 合成一筆 isError 的
   * session-end 讓使用者在對話尾端看得到錯誤卡片、`onEnded` 讓狀態機回 idle。
   * 少了最後一個，狀態會卡在一個沒有 query 的 live，使用者看得到錯誤卻按不了下一步。
   */
  const failStart = (err: unknown, context: string): void => {
    const error = asError(err, context)
    deps.onError(error)
    // 這裡不走 merger，直接走 onBatch。兩個呼叫點的處境不同但結論一樣：
    // 裁決 20 的 sessionOptions 失敗時 merger 根本還沒建；Ruling 9 的 queryFn
    // 同步 throw 時 merger 建了但已經在呼叫端 dispose 掉。兩種情況都沒有
    // 收得下事件的 merger，而這一筆 session-end 一定要送到 renderer。
    deps.onBatch([{ kind: 'session-end', isError: true, errorMessage: error.message }])
    deps.onEnded()
  }

  /** query 自己走完（不是我們收的）：把緩衝送完、關掉合併器，再通知呼叫端。 */
  const finishNaturally = (q: LiveQuery): void => {
    if (q.torndown) return
    q.merger.flush()
    q.merger.dispose()
    if (current === q) current = null
    deps.onEnded()
  }

  /**
   * 事件迴圈。裡面**沒有 break**：唯一的退出方式是生成器自己結束。
   *
   * 中途 break 會隱式呼叫 `query.return()`，那既不中止進行中的工具（工具照樣跑完，
   * 只是沒人收結果），SDK 對 `return()` 的清理程度也不在契約裡。收尾走
   * interrupt → close → 迴圈自然結束 → await 這個 promise。
   */
  const pump = (q: LiveQuery): Promise<void> =>
    (async () => {
      for await (const msg of q.handle) {
        const step = stepLive(msg, q.cursor)
        q.cursor = step.cursor
        q.merger.accept(step.events)
      }
    })().then(
      () => {
        q.finished = true
        finishNaturally(q)
      },
      (err: unknown) => {
        q.finished = true
        deps.onError(asError(err, 'SDK 事件流中斷'))
        // 裁決 17 第 3 點：事件流中斷不另設連線狀態 UI，合成一筆 isError 的
        // session-end 走同一條 events 通道，由 fold() 變成對話尾端的錯誤卡片。
        // 走 merger 而不是直接 onBatch，這筆才會排在前面那些事件之後。
        q.merger.accept([
          {
            kind: 'session-end',
            isError: true,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        ])
        finishNaturally(q)
      }
    )

  const waitForPump = (q: LiveQuery): Promise<void> =>
    new Promise((resolve) => {
      let settled = false
      let timeoutHandle: unknown = null
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timeoutHandle !== null) clock.clearTimer(timeoutHandle)
        resolve()
      }
      timeoutHandle = clock.setTimer(() => {
        deps.onError(new Error(`query 未在 ${TEARDOWN_TIMEOUT_MS} 毫秒內結束，強制收尾`))
        finish()
      }, TEARDOWN_TIMEOUT_MS)
      q.settled.then(finish, finish)
    })

  return {
    start: (resumeSessionId, initialInput, attachments) => {
      if (current !== null) {
        // 狀態機保證 start-query 之前一定有 teardown-query，走到這裡就是接線錯了。
        deps.onError(new Error('start()：已有活躍 query，先 teardown 才能再開'))
        return
      }
      // 裁決 20：resume 用的是歷史 session 自己的 cwd，那個目錄可能已經被刪掉，
      // 也可能落在 app 自身目錄底下，兩種都會被 Task 1 的守衛擋下來。組不出
      // options 就不開 query，改走裁決 17 的同一條路：合成一筆 isError 的
      // session-end，讓狀態機回 idle、renderer 畫出錯誤卡片，而不是卡在沒有
      // query 的 live。
      let options: SessionOptions
      try {
        options = deps.sessionOptions(resumeSessionId)
      } catch (err) {
        failStart(err, '無法組出 session options')
        return
      }
      const input = createInputQueue()
      const merger = createEventMerger({ onBatch: deps.onBatch, config: deps.merge, clock })
      // Ruling 9：`query()` 也可能同步 throw（CLI 不見了、options 被 SDK 擋下來）。
      // 不接住的話 `current` 還是 null、不合成 session-end、也不呼叫 onEnded，
      // 狀態機會停在 live，UI 卡住而且沒有任何說明。走與裁決 20 完全相同的出口。
      let handle: QueryHandle
      try {
        handle = deps.queryFn({
          prompt: input.stream,
          options: { ...options, canUseTool: canUseTool(options.cwd, ++approvalGeneration) },
        })
      } catch (err) {
        merger.dispose()
        failStart(err, '無法開啟 query')
        return
      }
      const q: LiveQuery = {
        handle,
        input,
        merger,
        cursor: INITIAL_CURSOR,
        torndown: false, finished: false, closeSucceeded: false,
        settled: Promise.resolve(),
      }
      current = q
      latest = q
      q.settled = pump(q)
      if (initialInput !== undefined && (initialInput.length > 0 || attachments?.length)) pushUserTurn(q, initialInput, attachments)
    },

    send: (text, attachments) => {
      return current === null ? false : pushUserTurn(current, text, attachments)
    },

    interrupt: (): Promise<void> => {
      const q = current
      if (q === null) return Promise.resolve()
      // 與 waitForPump 同一個形狀：真正的工作與計時器比快，誰先到誰了結這個 promise。
      return new Promise<void>((resolve) => {
        let settled = false
        let timeoutHandle: unknown = null
        const finish = (): void => {
          if (settled) return
          settled = true
          if (timeoutHandle !== null) clock.clearTimer(timeoutHandle)
          resolve()
        }
        timeoutHandle = clock.setTimer(() => {
          deps.onError(new Error(`interrupt 逾時 ${INTERRUPT_TIMEOUT_MS}ms，繼續收尾`))
          finish()
        }, INTERRUPT_TIMEOUT_MS)
        q.handle.interrupt().then(finish, (err: unknown) => {
          deps.onError(asError(err, 'interrupt 失敗'))
          finish()
        })
      })
    },

    shutdownConfirmed: () => latest === null || (latest.finished && latest.closeSucceeded),
    teardown: () => {
      approvalGeneration += 1
      if (teardownPromise !== null) return teardownPromise
      const q = current ?? (deps.strictShutdown ? latest : null)
      if (q === null || q.closeSucceeded) return Promise.resolve()
      q.torndown = true
      current = null
      q.input.close()
      try {
        q.handle.close()
        q.closeSucceeded = true
      } catch (err) {
        deps.onError(asError(err, 'close 失敗'))
      }
      teardownPromise = waitForPump(q).then(() => {
        q.merger.flush() // 緩衝裡的事件一筆都不吞
        q.merger.dispose()
        teardownPromise = null
      })
      return teardownPromise
    },
  }
}
