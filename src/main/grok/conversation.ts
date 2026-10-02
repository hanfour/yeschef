/**
 * grok 對話核心:對外與 Claude、codex 同一個 `Conversation` 介面(grok 規格 §5.4),
 * 路由器不必知道底下是哪一種。
 *
 * 狀態與 codex 同構:`idle` 是還沒開過 session;有 sessionId 但子行程不在是 `viewing`;
 * 子行程活著是 `live`。回合結束的唯一依據是 `session/prompt` 的回應,不猜「多久沒事件」。
 *
 * 與 codex 有兩處刻意不同,理由寫在各自的註解裡:退到背景不收子行程,
 * 以及 `replay()` 不自動載入歷史。
 */
import { accessSync, constants } from 'node:fs'
import {
  PATH_ONLY_ATTACHMENT_INSTRUCTION, attachmentLabel, attachmentPrompt, type PromptAttachment,
} from '../../shared/conversation-tools.js'
import { appendEvents } from '../../shared/event-log.js'
import { isTurnContentEvent, type Event } from '../../shared/events.js'
import type { SessionState } from '../../shared/session-state.js'
import { DEFAULT_MERGE_CONFIG, INITIAL_MERGE_STATE, asError, mergeAccept, mergeFlush } from '../agent-host.js'
import {
  createApprovalRegistry,
  type ApprovalAsk, type ApprovalDecision, type ApprovalOutcome,
} from '../approval.js'
import type { Conversation, ConversationSink } from '../conversation.js'
import { createGrokMapper, type GrokMapper } from './mapper.js'
import {
  createGrokClient, MSG_NO_GROK, rpcErrorMessage, withGrokAuthHint,
  type AcpMcpServer, type GrokClient, type PermissionOption, type PermissionOutcome,
  type PermissionRequest, type PromptBlock, type SpawnGrok,
} from './client.js'

export { MSG_NO_GROK }

export const MSG = {
  windowClosed: '視窗已關閉',
  switchingSession: '切換 session',
  startFailed: (reason: string) => `grok 啟動失敗:${reason}`,
  exited: (code: number | null) => `grok 子行程結束,code ${code ?? 'null'}`,
  noViewTools: (toolUseId: string) => `grok 對話沒有接右窗格工具,交接 ${toolUseId} 無處可送`,
} as const

/** grok 對話要用的右窗格工具。conversation 不需要知道 MCP server 長什麼樣。 */
export interface GrokViewTools {
  /** 交給 grok 的 mcpServers;第一次呼叫才真的開 HTTP server。 */
  mcpServers(): Promise<readonly AcpMcpServer[]>
  /**
   * 對話建好之後把自己的批准入口接上(規格 §7)。右窗格工具是 index.ts 在對話之前
   * 就建好的,所以批准只能反過來由對話注入;接上之前的呼叫一律當拒絕。
   */
  useApproval(request: (ask: ApprovalAsk) => Promise<ApprovalDecision>): void
  /** Grok MCP 工具沒有呼叫識別碼，批准時沿用右窗格工具的合成識別碼。 */
  requestApproval(toolName: string, input: unknown): Promise<ApprovalDecision>
  handoffDone(toolUseId: string): void
  /** 關掉 HTTP server。一定在 client.close() 之後才呼叫(規格 §6.2)。 */
  close(): Promise<void>
}

export interface GrokConversationDeps {
  readonly model?: string
  readonly pluginDir?: string
  readonly onEvents?: (events: readonly Event[]) => void
  readonly onActivity?: (sessionId: string, events: readonly Event[]) => void
  /** 有給才把右窗格工具交給 grok(規格 §6)。沒給就是這個對話不能開瀏覽器。 */
  readonly viewTools?: GrokViewTools
  readonly sink: ConversationSink
  /** 專案根目錄或 worktree,子行程的 cwd。 */
  readonly cwd: string
  readonly logError: (error: Error) => void
  readonly onSessionEnded?: (sessionId: string, event: Extract<Event, { kind: 'session-end' }>) => void
  readonly onSessionStarted?: (sessionId: string, cwd?: string) => void
  readonly onPendingApprovalsChange?: (count: number) => void
  readonly onBusyChange?: (busy: boolean) => void
  readonly onTurnProduced?: () => void
  /** 重開 app 時狀態檔記的 sessionId。 */
  readonly initialSessionId?: string
  readonly approvalTimeoutMs?: number | null
  readonly createRegistry?: typeof createApprovalRegistry
  readonly createClient?: typeof createGrokClient
  readonly spawn?: SpawnGrok
  readonly commandExists?: (command: string) => boolean
}

const RESET: Event = { kind: 'reset' }

/**
 * 偏好 `*_once`:`*_always` 會存進 grok 自己的 session 狀態,YesChef 管不到(規格 §7)。
 * 找法是三層退讓:先找完全相符的 kind,再找同方向而且不是 `*_always` 的,都沒有時
 * 才退到同方向的任何一個,也就是那個方向只剩 `*_always` 的情況。
 */
const OPTION_KIND: Readonly<Record<ApprovalDecision, { readonly exact: string; readonly prefix: string }>> = {
  allow: { exact: 'allow_once', prefix: 'allow' },
  deny: { exact: 'reject_once', prefix: 'reject' },
}

export function pickPermissionOption(
  options: readonly PermissionOption[],
  decision: ApprovalDecision,
): string | undefined {
  const want = OPTION_KIND[decision]
  const exact = options.find((option) => option.kind === want.exact)
  const once = options.find((option) => option.kind.startsWith(want.prefix) && !option.kind.endsWith('_always'))
  const same = options.find((option) => option.kind.startsWith(want.prefix))
  return (exact ?? once ?? same)?.optionId
}

/**
 * grok 沒有像 Claude／codex 那樣另一條原生圖片管道(`PromptBlock` 只有 `text` 一種),
 * `promptCapabilities.image` 也是 false(規格 §10)。共用的 `attachmentPrompt()` 只替
 * `file` 附件帶路徑,圖片附件預期走別的管道帶原始資料;這裡把圖片一律當 `file`,
 * 讓路徑文字補進 prompt,grok 才有機會用自己的工具讀到那個檔案。
 */
function asPathAttachments(attachments: readonly PromptAttachment[]): readonly PromptAttachment[] {
  return attachments.map((a) => (a.kind === 'image' ? { ...a, kind: 'file' as const } : a))
}

/** PATH 裡有沒有這個指令。與 codex 對話同一個做法。 */
function realCommandExists(command: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue
    try {
      accessSync(`${dir}/${command}`, constants.X_OK)
      return true
    } catch {
      // 這個目錄沒有,看下一個。
    }
  }
  return false
}

export function grokStartFailureMessage(error: Error): string {
  // 規格 §9:PATH 找不到 grok 的訊息就是那一句,不加前綴。
  if (error.message === MSG_NO_GROK) return MSG_NO_GROK
  const hinted = withGrokAuthHint(error.message)
  return hinted === error.message ? MSG.startFailed(error.message) : hinted
}

export function createGrokConversation(deps: GrokConversationDeps): Conversation {
  const makeClient = deps.createClient ?? createGrokClient
  const commandExists = deps.commandExists ?? realCommandExists

  let sessionId: string | null = deps.initialSessionId ?? null
  let resumeNext = deps.initialSessionId !== undefined
  let mapper: GrokMapper = createGrokMapper(sessionId ?? 'new', deps.model)
  let state: SessionState = sessionId === null ? { kind: 'idle' } : { kind: 'viewing', sessionId }
  let active = false
  let disposed = false
  let busy = false
  let busyStartedAt: number | null = null
  let turnProduced = false
  let closingClient = false
  let log: readonly Event[] = []
  let client: GrokClient | null = null
  /** 每次 startNew／openHistory 換一代;舊 client 之後才到的事件不能落進新對話。 */
  let generation = 0
  /**
   * 每次「開始一個新回合」就 +1,同一個 client 上回合進行中再送(先 cancel 再送)不會換
   * generation,但一定要換 turn:第一回合被 cancel 之後才回來的 settle(成功或失敗都算)
   * 不能再結束第二回合,也不能補發第二份 session-end(裁決見審查回報)。userInput 呼叫時
   * 同步遞增,不等到 runTurn 真的開始跑,才擋得住「cancel 同步讓上一個 prompt 立刻 settle」
   * 這種比 ensureClient 還快的時序。handleExit／openHistory／startNew／dispose 結束回合時
   * 也讓它失效,晚到的 prompt reject 才不會再結一次尾。
   *
   * 只用在 `runTurn` 的 settle,不能拿來擋鏈裡送出前的守衛:client 還在 boot 時連送兩句,
   * 第一句排進鏈裡等 ensureClient() 期間,turnSeq 已經被第二句追過去,送出前若也檢查
   * `turn !== turnSeq` 會讓第一句永遠送不出去(複審找到的問題)。鏈裡要不要先 cancel
   * 前一句改看 `promptInFlight`。
   */
  let turnSeq = 0
  /**
   * 有沒有一個 `session/prompt` 還沒收到回應。只有 `runTurn` 會動它(開始時設 true,
   * 結束時在 `finally` 設回 false),鏈裡送出新的 prompt 之前用它判斷要不要先 cancel
   * 舊的一個(見 userInput 鏈裡那段的註解)。
   */
  let promptInFlight = false
  /** 動作串行鏈。只串 client 的建立與收尾,回合本身不進來,不然第二句話要等第一句跑完。 */
  let pending: Promise<void> = Promise.resolve()

  const registry = (deps.createRegistry ?? createApprovalRegistry)({
    timeoutMs: deps.approvalTimeoutMs,
    sendRequest: (request) => { deps.sink.approvalAsk(request) },
    onSettled: (requestId) => { deps.sink.approvalSettled(requestId) },
  })

  const emitState = (next: SessionState): void => { if (active) deps.sink.state(next) }
  const setState = (next: SessionState): void => { state = next; emitState(next) }
  const pushBatch = (events: readonly Event[]): void => {
    if (busy && !turnProduced && events.some(isTurnContentEvent)) {
      turnProduced = true
      deps.onTurnProduced?.()
    }
    if (events.length === 0) return
    log = appendEvents(log, events)
    deps.onEvents?.(events)
    if (sessionId !== null) deps.onActivity?.(sessionId, events)
    for (const event of events) {
      if (event.kind === 'session-end' && sessionId !== null) deps.onSessionEnded?.(sessionId, event)
    }
    if (active) deps.sink.events(events)
  }
  const chunked = (events: readonly Event[], out: (batch: readonly Event[]) => void): void => {
    const accepted = mergeAccept(INITIAL_MERGE_STATE, events, 0, DEFAULT_MERGE_CONFIG)
    const rest = mergeFlush(accepted.state)
    for (const batch of accepted.batches) out(batch)
    for (const batch of rest.batches) out(batch)
  }
  const setBusy = (next: boolean): void => {
    if (busy === next) return
    busy = next
    busyStartedAt = next ? Date.now() : null
    if (next) turnProduced = false
    deps.onBusyChange?.(next)
  }
  const notifyPending = (): void => { deps.onPendingApprovalsChange?.(registry.pendingCount()) }
  const requestApproval = (request: ApprovalAsk): Promise<ApprovalOutcome> => {
    const outcome = registry.request(request)
    notifyPending()
    return outcome.finally(notifyPending)
  }

  // 右窗格工具的批准走同一個 registry,卡片才會出現在這個對話裡(規格 §7)。
  deps.viewTools?.useApproval(async (ask) => (await requestApproval(ask)).decision)

  /** `session/request_permission` 轉批准卡片(規格 §7)。 */
  const onPermission = async (request: PermissionRequest): Promise<PermissionOutcome> => {
    if (disposed) return { outcome: 'cancelled' }
    const outcome = await requestApproval({
      toolUseId: request.toolCallId,
      toolName: request.title === '' ? request.kind : request.title,
      input: request.rawInput,
      executionCwd: deps.cwd,
      ...(request.title === '' ? {} : { title: request.title }),
      ...(request.kind === '' ? {} : { displayName: request.kind }),
    })
    const optionId = pickPermissionOption(request.options, outcome.decision)
    return optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId }
  }

  /**
   * 全域 MCP server 連不上時記一行 log,不顯示在對話裡(規格 §6.4)。
   * 那些 server 來自 `~/.grok/config.toml`,第一版不干預,但人要查得到為什麼工具少了。
   */
  const noteServerStatus = (method: string, params: unknown): void => {
    if (method !== '_x.ai/mcp/server_status') return
    const record = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    if (record['status'] !== 'unavailable') return
    deps.logError(new Error(`grok 的 MCP server ${String(record['name'])} 不可用:${String(record['reason'])} ${String(record['detail'])}`))
  }

  const prepareMapper = (id: string): void => {
    mapper = createGrokMapper(id, deps.model)
    mapper.beginTurn()
  }

  const pushSessionStart = (id: string): void => {
    const model = mapper.model()
    pushBatch([{ kind: 'session-start', sessionId: id, cwd: deps.cwd, ...(model === undefined ? {} : { model }) }])
  }

  const handleExit = (code: number | null): void => {
    client = null
    // 子行程沒了,下一句話要用 session/load 接回同一個 session。
    resumeNext = sessionId !== null
    if (busy) {
      // 這裡結束了進行中的回合;稍後才到的 prompt reject(client.ts 的 detach 先 rejectAll
      // 再叫 onExit,兩者同一個 tick)不能再補發第二份 session-end(規格見審查回報)。
      turnSeq += 1
      pushBatch([{ kind: 'session-end', isError: true, errorMessage: MSG.exited(code) }])
      setBusy(false)
    }
    if (sessionId !== null) setState({ kind: 'viewing', sessionId })
  }

  const teardownClient = async (): Promise<void> => {
    const current = client
    client = null
    if (current === null) return
    closingClient = true
    try {
      await current.close()
    } finally {
      closingClient = false
    }
  }

  const ensureClient = async (): Promise<GrokClient> => {
    const existing = client
    if (existing !== null && existing.isRunning()) return existing
    if (!commandExists('grok')) throw new Error(MSG_NO_GROK)
    const gen = generation
    const mcpServers = deps.viewTools === undefined ? [] : await deps.viewTools.mcpServers()
    const resume = resumeNext && sessionId !== null ? sessionId : undefined
    // 重播的 session/update 在 makeClient 回來之前就會到,所以 mapper 要先就位。
    if (resume !== undefined) { prepareMapper(resume); pushSessionStart(resume) }
    const created = await makeClient({
      cwd: deps.cwd,
      mcpServers,
      logError: deps.logError,
      ...(deps.model === undefined ? {} : { model: deps.model }),
      ...(deps.pluginDir === undefined ? {} : { pluginDir: deps.pluginDir }),
      ...(resume === undefined ? {} : { resume }),
      onUpdate: (method, params) => {
        if (gen !== generation || disposed) return
        noteServerStatus(method, params)
        pushBatch(mapper.accept(method, params))
      },
      onPermission: (request) => (gen === generation && !disposed
        ? onPermission(request)
        : Promise.resolve<PermissionOutcome>({ outcome: 'cancelled' })),
      onStderr: (line) => { deps.logError(new Error(`grok stderr:${line.slice(0, 300)}`)) },
      onExit: (code) => { if (gen === generation && !closingClient) handleExit(code) },
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    })
    if (disposed || gen !== generation) { await created.close(); throw new Error(MSG.switchingSession) }
    client = created
    resumeNext = false
    if (resume === undefined) {
      sessionId = created.sessionId
      prepareMapper(sessionId)
      pushSessionStart(sessionId)
      deps.onSessionStarted?.(sessionId, deps.cwd)
    }
    setState({ kind: 'live', sessionId: sessionId ?? created.sessionId })
    return created
  }

  /** 回合本身不進串行鏈:第二句話要能在第一句還沒結束時先 cancel 再送。 */
  const runTurn = async (c: GrokClient, gen: number, turn: number, blocks: readonly PromptBlock[]): Promise<void> => {
    // 結尾是否還輪得到這個 turn:generation 換了、視窗關了,或是這個 turn 已經被更新的
    // 一句話取代(turnSeq 已經前進),都表示這份 settle 不是給這裡的,只記 log 不動狀態。
    const stale = (): boolean => disposed || gen !== generation || turn !== turnSeq
    promptInFlight = true
    try {
      const result = await c.prompt(blocks)
      if (stale()) return
      pushBatch(mapper.promptFinished(result.stopReason))
      setBusy(false)
    } catch (cause) {
      deps.logError(asError(cause, 'grok-turn'))
      if (stale()) return
      const original = cause instanceof Error ? cause : new Error(String(cause))
      // rpcErrorMessage 先把 jsonrpc-stdio 的 `method:{json}` 拆成 grok 自己的 error.message,
      // 使用者不該看到方法名與整包 JSON(裁決見 client.ts 同名函式)。
      pushBatch([{ kind: 'session-end', isError: true, errorMessage: withGrokAuthHint(rpcErrorMessage(original)) }])
      setBusy(false)
    } finally {
      promptInFlight = false
    }
  }

  const userInput = (text: string, attachments?: readonly PromptAttachment[]): void => {
    if (disposed) return
    if (state.kind === 'viewing' && !busy) generation += 1
    const gen = generation
    // 同步遞增,不等 runTurn 真的開始:cancel() 可能讓上一個 turn 同步 settle,
    // 一定要在那之前就讓上一個 turn 的 token 過期(見 turnSeq 宣告處的說明)。
    const turn = ++turnSeq
    pushBatch([{ kind: 'user-text', text: attachmentLabel(text, attachments) }])
    const wasBusy = busy
    setBusy(true)
    const current = client
    // 回合進行中再送:先 cancel 再送,跟 Codex 一樣(規格 §5.4)。
    if (wasBusy && current !== null) {
      void current.cancel().catch((cause: unknown) => { deps.logError(asError(cause, 'grok-cancel')) })
    }
    pending = pending.then(async () => {
      // 送出前的守衛只看 client 是不是同一個:token 只管 settle,擋在這裡的話,
      // 前一句排進鏈裡但 client 還在 boot 時,會被判 stale 而永遠送不出去
      // (複審找到的問題:PATH boot 期間連送兩句,第一句就這樣不見了)。
      if (disposed || gen !== generation) return
      try {
        const c = await ensureClient()
        if (disposed || gen !== generation) return
        // 前一回合的 prompt 還飛在天上:client 若剛才還在 boot,userInput 那次同步
        // cancel 當時還沒有 client 可以呼叫,這裡補上,送出新的之前先 cancel 掉舊的
        // (規格 §5.4;client 已經 alive 時這裡會是第二次 cancel,對 grok 是 no-op)。
        if (promptInFlight) {
          await c.cancel().catch((cause: unknown) => { deps.logError(asError(cause, 'grok-cancel')) })
        }
        mapper.beginTurn()
        // grok 的 promptCapabilities.image 是 false,附件只帶路徑文字(規格 §10)。
        void runTurn(c, gen, turn, [{
          type: 'text',
          text: attachmentPrompt(text, asPathAttachments(attachments ?? []), PATH_ONLY_ATTACHMENT_INSTRUCTION),
        }])
      } catch (cause) {
        deps.logError(asError(cause, 'grok-input'))
        if (disposed || gen !== generation) return
        // 已經有更新的一句接手(boot 失敗時兩句都會走到這裡):錯誤卡由最後那一句出,不重複。
        if (turn !== turnSeq) return
        const original = cause instanceof Error ? cause : new Error(String(cause))
        pushBatch([{ kind: 'session-end', isError: true, errorMessage: grokStartFailureMessage(original) }])
        setBusy(false)
        await teardownClient()
        if (sessionId !== null) setState({ kind: 'viewing', sessionId })
      }
    }).catch((err: unknown) => { deps.logError(asError(err, 'grok-input')) })
  }

  const openHistory = (id: string): void => {
    if (disposed) return
    generation += 1
    turnSeq += 1
    const gen = generation
    const current = client
    if (current !== null) void current.cancel().catch((cause: unknown) => { deps.logError(asError(cause, 'grok-cancel')) })
    registry.denyAll(MSG.switchingSession)
    notifyPending()
    setBusy(false)
    log = []
    pushBatch([RESET])
    sessionId = id
    resumeNext = true
    setState({ kind: 'viewing', sessionId: id })
    pending = pending.then(async () => {
      await teardownClient()
      if (disposed || gen !== generation) return
      try {
        // 一律開新的子行程 load,不在同一個行程裡 close 再 load(規格 §3)。
        await ensureClient()
        if (disposed || gen !== generation) return
        pushBatch([{ kind: 'session-end', isError: false }])
      } catch (cause) {
        deps.logError(asError(cause, 'grok-history'))
        if (disposed || gen !== generation) return
        const original = cause instanceof Error ? cause : new Error(String(cause))
        pushBatch([{ kind: 'session-end', isError: true, errorMessage: grokStartFailureMessage(original) }])
      }
      setState({ kind: 'viewing', sessionId: id })
    }).catch((err: unknown) => { deps.logError(asError(err, 'grok-history')) })
  }

  const replay = (): void => {
    if (!active) return
    // 與 codex 不同:不自動 openHistory。grok 的歷史只能用 session/load 重播,
    // 那會多開一個子行程;切回前景不該付這個代價,由使用者輸入時才接回去。
    chunked([RESET, ...log], (batch) => { deps.sink.events(batch) })
    deps.sink.state(state)
  }

  return {
    shutdownConfirmed: () => client === null,
    userInput,
    approvalReply(requestId, decision: ApprovalDecision) {
      if (registry.reply(requestId, decision)) return
      deps.logError(new Error(`grok 對話:找不到批准 ${requestId},可能已逾時`))
    },
    startNew() {
      generation += 1
      turnSeq += 1
      registry.denyAll(MSG.switchingSession)
      notifyPending()
      setBusy(false)
      log = []
      sessionId = null
      resumeNext = false
      mapper = createGrokMapper('new', deps.model)
      pushBatch([RESET])
      setState({ kind: 'idle' })
      pending = pending.then(teardownClient).catch((err: unknown) => { deps.logError(asError(err, 'grok-start-new')) })
    },
    openHistory,
    handoffDone(toolUseId) {
      const view = deps.viewTools
      if (view === undefined) {
        deps.logError(new Error(MSG.noViewTools(toolUseId)))
        return
      }
      view.handoffDone(toolUseId)
    },
    activate() {
      if (active || disposed) return
      active = true
      replay()
    },
    deactivate() {
      // 與 codex 不同:不收子行程。grok 沒有 thread/resume 這種「接回去但不重播」的方法,
      // 收掉再回來只能 session/load,那會把整段歷史重播一次,畫面變兩份。
      // 這是已知代價:每個開著的 Grok 分頁常駐一個 `grok agent stdio`。
      active = false
    },
    replay,
    isActive: () => active,
    pendingApprovals: () => registry.pendingCount(),
    isBusy: () => busy,
    busyStartedAt: () => busyStartedAt,
    turnProduced: () => turnProduced,
    activityEvents: () => log,
    sessionState: () => state,
    async dispose() {
      disposed = true
      active = false
      turnSeq += 1
      registry.denyAll(MSG.windowClosed)
      notifyPending()
      pending = pending.then(async () => {
        // 順序固定:先 session/close 再關 HTTP server,反過來 grok 的 MCP client
        // 會在關閉時把 handshake 錯誤噴到 stderr(規格 §6.2)。
        await teardownClient()
        await deps.viewTools?.close()
      }).catch((err: unknown) => { deps.logError(asError(err, 'grok-dispose')) })
      await pending
    },
  }
}
