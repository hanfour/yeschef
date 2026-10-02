import type { PromptAttachment } from '../shared/conversation-tools.js'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { isTurnContentEvent, type Event } from '../shared/events.js'
import type { SessionState } from '../shared/session-state.js'
import { IPC, type ApprovalAskPayload } from '../shared/ipc.js'
import { appendEvents } from '../shared/event-log.js'
import {
  createApprovalRegistry,
  type ApprovalAsk,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalRequest,
} from './approval.js'
import {
  DEFAULT_MERGE_CONFIG,
  INITIAL_MERGE_STATE,
  asError,
  createAgentHost,
  mergeAccept,
  mergeFlush,
  type AgentHost,
  type QueryFn,
} from './agent-host.js'
import { transition, type Action, type Effect } from './session-machine.js'
import type { SessionOptions } from './session-args.js'
import { MSG } from './view-tools/errors.js'

/** 對話核心需要的右窗格工具那一小片。autoAllow 在瀏覽器建立之前就會被問到,所以不綁在 ViewTools 上。 */
export interface ViewToolHooks {
  autoAllow(toolName: string, toolUseId: string): boolean
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
}

export const defaultQueryFn: QueryFn = (params) =>
  sdkQuery({ prompt: params.prompt, options: params.options })

/** 對話核心對外送東西的唯一出口;Task 7 的路由器把它接到 webContents。 */
export interface ConversationSink {
  events(batch: readonly Event[]): void
  state(state: SessionState): void
  /** 送不出去就 throw:registry 把 throw 當視窗已關,立刻 deny(沿用 approval.ts 的規則)。 */
  approvalAsk(payload: ApprovalRequest): void
  /** 某筆批准已了結。best-effort:renderer 不在了也沒有東西要拿掉。 */
  approvalSettled(requestId: string): void
}

export interface ConversationDeps {
  readonly strictShutdown?: boolean
  readonly internalAutoAllow?: (toolName: string) => boolean
  readonly onEvents?: (events: readonly Event[]) => void
  readonly onActivity?: (sessionId: string, events: readonly Event[]) => void
  readonly sink: ConversationSink
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  readonly loadHistory: (sessionId: string) => Promise<readonly Event[]>
  readonly logError: (error: Error) => void
  /** 背景結束也要保存 SDK 花費,歷史重播不經這個回呼。 */
  readonly onSessionEnded?: (sessionId: string, event: Extract<Event, { kind: 'session-end' }>) => void
  /** live 拿到 SDK 的 session id 時通知;路由器據此記進 thread(規格 §2 thread 定義)。 */
  readonly onSessionStarted?: (sessionId: string, cwd?: string) => void
  /** 待批准數量改變時通知(D2 規格 §11);路由器據此更新分頁列的待批准記號 */
  readonly onPendingApprovalsChange?: (count: number) => void
  /** 回合進行中與否改變時通知(D2);路由器據此更新分頁列的 busy 記號,renderer 關分頁前用它決定要不要確認。 */
  readonly onBusyChange?: (busy: boolean) => void
  /** 本回合首次產出內容時通知，背景分頁也要更新。 */
  readonly onTurnProduced?: () => void
  /** 重開 app 時該專案的 sleeping session(規格 §3.3);有就從 viewing 起步。 */
  readonly initialSessionId?: string
  readonly queryFn?: QueryFn
  readonly approvalTimeoutMs?: number | null
  readonly createHost?: typeof createAgentHost
  readonly createRegistry?: typeof createApprovalRegistry
  readonly viewTools?: ViewToolHooks
}

export interface Conversation {
  shutdownConfirmed?(): boolean
  userInput(text: string, attachments?: readonly PromptAttachment[]): void
  approvalReply(requestId: string, decision: ApprovalDecision): void
  startNew(): void
  openHistory(sessionId: string): void
  handoffDone(toolUseId: string): void
  /** 成為前景:重播內容、推狀態。 */
  activate(): void
  /** 退到背景:回合已結束就 sleep,否則等 session-end 再 sleep。 */
  deactivate(): void
  /** 把目前內容與狀態再推一次給 sink(renderer 剛載入時用);背景時不動。 */
  replay(): void
  isActive(): boolean
  /** 目前在等回覆的批准數。分頁列的待批准記號用它。 */
  pendingApprovals(): number
  isBusy(): boolean
  busyStartedAt(): number | null
  turnProduced(): boolean
  activityEvents?(): readonly Event[]
  sessionState(): SessionState
  dispose(): Promise<void>
}

const RESET: Event = { kind: 'reset' }
/** 收尾時給待批准請求的理由。與 `session-machine.ts` 的 `teardownLive('視窗已關閉')` 同一句。 */
const WINDOW_CLOSED = '視窗已關閉'

export function createConversation(deps: ConversationDeps): Conversation {
  const queryFn = deps.queryFn ?? defaultQueryFn
  const createHost = deps.createHost ?? createAgentHost
  const viewTools = deps.viewTools

  let state: SessionState =
    deps.initialSessionId === undefined
      ? { kind: 'idle' }
      : { kind: 'viewing', sessionId: deps.initialSessionId }
  let active = false
  let disposed = false
  /** 上一次 reset 之後推過的事件;切回前景時重播。 */
  let log: readonly Event[] = []
  let activitySessionId = deps.initialSessionId
  /** 回合進行中:userInput 送出後 true,session-end／onEnded／換 session 後 false。 */
  let busy = false
  let busyStartedAt: number | null = null
  let turnProduced = false
  const setBusy = (next: boolean): void => {
    if (busy === next) return
    busy = next
    busyStartedAt = next ? Date.now() : null
    if (next) turnProduced = false
    deps.onBusyChange?.(next)
  }
  /** 切到背景時回合還在跑,等它結束再 sleep。 */
  let sleepPending = false
  let host: AgentHost | null = null
  /** effects 串行鏈:同一份對話的 effects 依 action 順序執行,不交錯。 */
  let pending: Promise<void> = Promise.resolve()

  const registry = (deps.createRegistry ?? createApprovalRegistry)({
    timeoutMs: deps.approvalTimeoutMs,
    sendRequest: (request: ApprovalRequest) => {
      deps.sink.approvalAsk(request)
    },
    onSettled: (requestId) => {
      deps.sink.approvalSettled(requestId)
    },
  })

  const emit = (batch: readonly Event[]): void => {
    if (busy && !turnProduced && batch.some(isTurnContentEvent)) {
      turnProduced = true
      deps.onTurnProduced?.()
    }
    if (active) deps.sink.events(batch)
  }
  const emitState = (next: SessionState): void => {
    if (active) deps.sink.state(next)
  }
  /** 記進 log,前景時送出。 */
  const pushBatch = (events: readonly Event[]): void => {
    log = appendEvents(log, events)
    deps.onEvents?.(events)
    if (activitySessionId) deps.onActivity?.(activitySessionId, events)
    emit(events)
  }
  /** 一次很多事件時照 live 的規則分批,renderer 才不會一口氣吃下整份歷史。 */
  const chunked = (events: readonly Event[], out: (batch: readonly Event[]) => void): void => {
    const accepted = mergeAccept(INITIAL_MERGE_STATE, events, 0, DEFAULT_MERGE_CONFIG)
    const rest = mergeFlush(accepted.state)
    for (const batch of accepted.batches) out(batch)
    for (const batch of rest.batches) out(batch)
  }
  const pushHistory = (events: readonly Event[]): void => {
    chunked(events, pushBatch)
  }

  /** 待批准數量變了就通知一次。送出前後各推一次,renderer 的記號才跟得上。 */
  const notifyPending = (): void => {
    deps.onPendingApprovalsChange?.(registry.pendingCount())
  }
  /**
   * D2 規格 §11:不看自己是不是前景,一律進批准登錄表。背景時扣住的舊做法讓
   * 同伴問答一旦需要批准就卡住,而人不知道要切到哪裡去按。
   */
  const requestApproval = (request: ApprovalAsk): Promise<ApprovalOutcome> => {
    const outcome = registry.request(request)
    notifyPending()
    return outcome.finally(notifyPending)
  }

  const turnEnded = (): void => {
    setBusy(false)
    // 通知 busy 變化時可能同步注入新回合（同伴排隊投遞），此時不是回合結束。
    // 保留 sleepPending，讓新回合自己的結尾再休眠。
    if (!sleepPending || busy) return
    sleepPending = false
    dispatch({ kind: 'sleep' })
  }

  const pushLive = (events: readonly Event[]): void => {
    for (const event of events) if (event.kind === 'session-start') activitySessionId = event.sessionId
    pushBatch(events)
    for (const event of events) {
      if (event.kind === 'session-start') {
        activitySessionId = event.sessionId
        dispatch({ kind: 'session-started', sessionId: event.sessionId })
        deps.onSessionStarted?.(event.sessionId, event.cwd)
      }
      if (event.kind === 'session-end') {
        if (state.kind !== 'idle' && state.sessionId !== undefined) deps.onSessionEnded?.(state.sessionId, event)
        turnEnded()
      }
    }
  }

  const ensureHost = (): AgentHost => {
    if (host !== null) return host
    host = createHost({
      queryFn,
      strictShutdown: deps.strictShutdown,
      sessionOptions: deps.sessionOptions,
      requestApproval,
      ...((viewTools === undefined && !deps.internalAutoAllow) ? {} : { autoAllow: (name: string, id: string) => deps.internalAutoAllow?.(name) === true || viewTools?.autoAllow(name, id) === true }),
      onBatch: pushLive,
      onError: deps.logError,
      onEnded: () => {
        setBusy(false)
        // 閒置通知可能同步注入新回合，不可清掉它的休眠請求或把狀態打回 idle。
        if (busy) return
        sleepPending = false
        // query 沒了,登錄表裡的待批准請求一律以 deny 收掉,
        // 避免 SDK 的 canUseTool 繼續等待已結束的對話。
        registry.denyAll(MSG.sessionEnded)
        notifyPending()
        dispatch({ kind: 'session-ended' })
      },
    })
    return host
  }

  const runEffect = async (effect: Effect): Promise<void> => {
    switch (effect.kind) {
      case 'deny-all-approvals':
        registry.denyAll(effect.reason)
        notifyPending()
        return
      case 'interrupt-query':
        viewTools?.abortPending(MSG.sessionEnded)
        await ensureHost().interrupt()
        return
      case 'teardown-query':
        viewTools?.abortPending(MSG.sessionEnded)
        await ensureHost().teardown()
        return
      case 'start-query':
        if (effect.resumeSessionId === undefined) pushBatch([RESET])
        ensureHost().start(effect.resumeSessionId, effect.initialInput, effect.attachments)
        return
      case 'load-history': {
        activitySessionId = effect.sessionId
        pushHistory([RESET])
        try {
          pushHistory(await deps.loadHistory(effect.sessionId))
        } catch (err) {
          const error = asError(err, 'load-history')
          deps.logError(error)
          pushHistory([
            { kind: 'session-end', isError: true, errorMessage: `讀取歷史對話失敗：${error.message}` },
          ])
        }
        return
      }
    }
  }
  const runEffects = async (effects: readonly Effect[]): Promise<void> => {
    for (const effect of effects) await runEffect(effect)
  }

  function dispatch(action: Action): void {
    const result = transition(state, action)
    state = result.state
    pending = pending
      .then(() => runEffects(result.effects))
      .catch((err: unknown) => deps.logError(asError(err, `effects(${action.kind})`)))
      .then(() => emitState(result.state))
  }

  const userInput = (text: string, attachments?: readonly PromptAttachment[], retried = false): void => {
    const wasLive = state.kind === 'live'
    dispatch({ kind: 'user-input', text, ...(attachments?.length ? { attachments } : {}) })
    setBusy(true)
    if (!wasLive && !retried) return
    pending = pending
      .then(() => {
        if (state.kind !== 'live') {
          if (!retried) {
            // 接在既有 sleep effects 後 resume；不 await 自己所屬的 pending 鏈。
            userInput(text, attachments, true)
            return
          }
          deps.logError(new Error(`${IPC.userInput}：${MSG.inputNotLive}`))
          pushBatch([
            { kind: 'session-end', isError: true, errorMessage: MSG.inputSessionChanged(text) },
          ])
          turnEnded()
          return
        }
        // 非 live 路徑的 start-query 已把文字當 initialInput 送出，不可再 send。
        if (!wasLive) return
        if (ensureHost().send(text, attachments)) return
        deps.logError(new Error(`${IPC.userInput}：session 已收尾，這則輸入未送出`))
        pushBatch([
          { kind: 'session-end', isError: true, errorMessage: `這則輸入未送出（session 已收尾）：${text}` },
        ])
        turnEnded()
      })
      // 與 bridge 同一個收束:這一段丟出來的例外只記錄,不讓 `pending` 鏈停在 rejected,
      // 否則下一個 action 的 effects 會被整段跳過。
      .catch((err: unknown) => deps.logError(asError(err, IPC.userInput)))
  }

  const approvalReply = (requestId: string, decision: ApprovalDecision): void => {
    if (registry.reply(requestId, decision)) return
    deps.logError(new Error(`${IPC.approvalReply}：找不到 ${requestId}，可能已逾時`))
  }

  const startNew = (): void => {
    activitySessionId = undefined
    setBusy(false)
    sleepPending = false
    dispatch({ kind: 'start-new' })
  }

  const openHistory = (sessionId: string): void => {
    activitySessionId = undefined
    setBusy(false)
    sleepPending = false
    dispatch({ kind: 'open-history', sessionId })
  }

  const handoffDone = (toolUseId: string): void => {
    if (viewTools === undefined) {
      deps.logError(new Error('收到 handoff:done 但沒有 view tools'))
      return
    }
    viewTools.handoffDone(toolUseId)
  }

  const replay = (): void => {
    if (!active) return
    if (state.kind === 'viewing') {
      // sleeping session:transcript 才是完整內容,log 只有切走前那一段(規格 §3.3)。
      dispatch({ kind: 'open-history', sessionId: state.sessionId })
      return
    }
    // 重播的舊內容不能被算成本回合的新產出。
    chunked([RESET, ...log], (batch) => deps.sink.events(batch))
    deps.sink.state(state)
  }

  const activate = (): void => {
    if (active || disposed) return
    active = true
    sleepPending = false
    replay()
  }

  const deactivate = (): void => {
    active = false
    // 背景投遞也要登記休眠，包含核心尚在啟動的回合。
    if (busy) {
      sleepPending = true
      return
    }
    if (state.kind !== 'live') return
    dispatch({ kind: 'sleep' })
  }

  const dispose = async (): Promise<void> => {
    disposed = true
    active = false
    // 不能只靠 window-closed 的 effects:那條路只有 live 出得了 deny-all-approvals,
    // 從 idle／viewing 收尾時等待中的 ask 會永遠不 resolve。這裡無條件先收掉,
    // live 時後面的 effect 再跑一次 denyAll 只是 no-op。
    registry.denyAll(WINDOW_CLOSED)
    notifyPending()
    const result = transition(state, { kind: 'window-closed' })
    state = result.state
    pending = pending
      .then(() => runEffects(result.effects))
      .catch((err: unknown) => deps.logError(asError(err, 'effects(window-closed)')))
    await pending
  }

  return {
    shutdownConfirmed: () => host === null || host.shutdownConfirmed?.() === true,
    userInput,
    approvalReply,
    startNew,
    openHistory,
    handoffDone,
    activate,
    deactivate,
    replay,
    isActive: () => active,
    pendingApprovals: () => registry.pendingCount(),
    isBusy: () => busy,
    busyStartedAt: () => busyStartedAt,
    turnProduced: () => turnProduced,
    activityEvents: () => activitySessionId !== undefined && (state.kind === 'idle' || state.sessionId === activitySessionId) ? log : [],
    sessionState: () => state,
    dispose,
  }
}
