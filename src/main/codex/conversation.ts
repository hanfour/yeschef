import { attachmentLabel, type PromptAttachment } from '../../shared/conversation-tools.js'
/**
 * codex 對話核心:對外與 Claude 那邊同一個 `Conversation` 介面(規格 §1),
 * 路由器不必知道底下是哪一種。
 *
 * 狀態比 Claude 簡單,沒有 session-machine:`idle` 是還沒開過 thread;有 threadId 但
 * 子程序不在是 `viewing`;子程序活著是 `live`。開歷史先讀 items,下一則訊息才 resume。
 */
import { accessSync, constants } from 'node:fs'
import { PEER_MSG, PeerError } from '../peer/errors.js'
import type { PeerTools } from '../peer/service.js'
import type { CodexDynamicTool, CodexToolOutcome, DynamicToolCallParams } from './client.js'
import type { InvokeContext, ViewToolInvocation } from '../view-tools/tool-defs.js'
import { VIEW_TOOL_DEFS } from '../view-tools/tool-defs.js'
import { MSG } from '../view-tools/errors.js'
import { viewToolPolicy } from '../view-tools/policy.js'
import { chefToolPolicy } from '../chef/tool-policy.js'
import { asViewToolName, fullToolName, type ViewToolName } from '../../shared/view-tools.js'
import { toDataUrl } from '../../shared/tool-images.js'
import { PEER_TOOL_NAMES } from '../../shared/peer-tools.js'
import { isTurnContentEvent, type Event } from '../../shared/events.js'
import type { SessionState } from '../../shared/session-state.js'
import { appendEvents } from '../../shared/event-log.js'
import {
  createApprovalRegistry,
  type ApprovalAsk,
  type ApprovalDecision,
  type ApprovalOutcome,
} from '../approval.js'
import { DEFAULT_MERGE_CONFIG, INITIAL_MERGE_STATE, asError, mergeAccept, mergeFlush } from '../agent-host.js'
import type { Conversation, ConversationSink } from '../conversation.js'
import { createCodexMapper, historyEvents, MSG_NOT_LOGGED_IN, withAuthHint } from './mapper.js'
import { createCodexClient, type ApprovalKind, type CodexClient, type SpawnCodex } from './client.js'

export const MSG_NO_CODEX = 'PATH 找不到 codex,請先安裝'
export { MSG_NOT_LOGGED_IN }
const MSG_WINDOW_CLOSED = '視窗已關閉'
const SWITCHING_SESSION = '切換 session'
const RESET: Event = { kind: 'reset' }

export interface CodexConversationDeps {
  readonly model?: string
  readonly effort?: string
  readonly chefTools?: { specs: readonly import('./client.js').CodexDynamicTool[]; call(name: string, args: unknown, callId?: string): Promise<import('./client.js').CodexToolOutcome> }
  readonly onEvents?: (events: readonly Event[]) => void
  readonly onActivity?: (sessionId: string, events: readonly Event[]) => void
  readonly skillRoots?: () => readonly string[]
  /** 有給才把兩個同伴工具交給 codex(5c)。沒給就是這個對話不能問也不能答。 */
  readonly peerTools?: PeerTools
  /** 有給才把八個右窗格工具交給 codex(規格 §4.1)。沒給就是這個對話不能開瀏覽器。 */
  readonly viewTools?: CodexViewTools
  readonly loadHistory: (threadId: string) => Promise<readonly unknown[]>
  readonly sink: ConversationSink
  /** 專案根目錄,子程序的 cwd。 */
  readonly cwd: string
  readonly logError: (error: Error) => void
  /** 背景結束也要保存 SDK 花費,歷史重播不經這個回呼。 */
  readonly onSessionEnded?: (sessionId: string, event: Extract<Event, { kind: 'session-end' }>) => void
  readonly onSessionStarted?: (sessionId: string, cwd?: string) => void
  readonly onPendingApprovalsChange?: (count: number) => void
  readonly onBusyChange?: (busy: boolean) => void
  /** 本回合首次產出內容時通知，背景分頁也要更新。 */
  readonly onTurnProduced?: () => void
  /** 重開 app 時狀態檔記的 threadId。 */
  readonly initialThreadId?: string
  readonly approvalTimeoutMs?: number | null
  readonly createRegistry?: typeof createApprovalRegistry
  readonly createClient?: typeof createCodexClient
  readonly spawn?: SpawnCodex
  readonly commandExists?: (command: string) => boolean
}

/** PATH 裡有沒有這個指令。與 terminal-server 的判斷同一個做法。 */
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

export function startFailureMessage(error: Error): string {
  // 規格 §7:PATH 找不到 codex 的訊息就是那一句,不加前綴。
  if (error.message === MSG_NO_CODEX) return MSG_NO_CODEX
  const hinted = withAuthHint(error.message)
  return hinted === error.message ? `codex 啟動失敗:${error.message}` : hinted
}

/**
 * codex 對話要用的右窗格工具(規格 §4.1、§4.4)。這是 `ProjectViewTools` 的一小片:
 * conversation 不需要知道 MCP server,只要能呼叫與告知交接完成。
 */
export interface CodexViewTools {
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  handoffDone(toolUseId: string): void
}

/**
 * 八個右窗格工具的 codex 規格。名字平鋪,與 Claude 那側同名(codex 沒有 `mcp__yeschef__`
 * 這個慣例,加了 namespace 反而會變成 `view__click`,RESULTS-22 §5)。
 * inputSchema 與 Claude 那側的 zod shape 由同一份定義轉出來(tool-defs.ts)。
 */
export function codexViewToolSpecs(): readonly CodexDynamicTool[] {
  return VIEW_TOOL_DEFS.map((def) => ({
    type: 'function',
    name: def.name,
    description: def.description,
    inputSchema: { ...def.inputSchema },
  }))
}

/**
 * 給 codex 的兩個工具規格。名稱與 Claude 那側的 MCP 工具同名(沒有前綴),
 * 描述沿用同一份文字,兩邊的模型看到的說明一樣。
 */
export function codexPeerToolSpecs(): readonly CodexDynamicTool[] {
  return [
    {
      type: 'function',
      name: PEER_TOOL_NAMES[0],
      description: PEER_MSG.askPeerDescription,
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' }, to: { type: 'string' } },
        required: ['question'],
      },
    },
    {
      type: 'function',
      name: PEER_TOOL_NAMES[1],
      description: PEER_MSG.answerPeerDescription,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    },
  ]
}

export function createCodexConversation(deps: CodexConversationDeps): Conversation {
  const makeClient = deps.createClient ?? createCodexClient
  const commandExists = deps.commandExists ?? realCommandExists
  let mapper = createCodexMapper()
  const fileEvidence = new Map<string, { threadId: unknown; turnId: unknown; changes: unknown }>()

  let state: SessionState =
    deps.initialThreadId === undefined ? { kind: 'idle' } : { kind: 'viewing', sessionId: deps.initialThreadId }
  let threadId: string | null = deps.initialThreadId ?? null
  let active = false
  let disposed = false
  let busy = false
  let busyStartedAt: number | null = null
  let turnProduced = false
  /** ensureClient 進行中的退出由 userInput catch 統一推錯誤卡。 */
  let starting = false
  let sleepPending = false
  let log: readonly Event[] = []
  let client: CodexClient | null = null
  let latestClient: CodexClient | null = null
  /** 每次 startNew 換一代;舊 client 之後才到的事件(例如中斷造成的 turn/completed)不能落進新對話。 */
  let generation = 0
  /** 動作串行鏈,與 Claude 那邊同一個規則:同一份對話的非同步動作不交錯。 */
  let pending: Promise<void> = Promise.resolve()

  const registry = (deps.createRegistry ?? createApprovalRegistry)({
    timeoutMs: deps.approvalTimeoutMs,
    sendRequest: (request) => { deps.sink.approvalAsk(request) },
    onSettled: (requestId) => { deps.sink.approvalSettled(requestId) },
  })

  const emit = (batch: readonly Event[]): void => { if (active) deps.sink.events(batch) }
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
    if (threadId) deps.onActivity?.(threadId, events)
    emit(events)
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

  const teardownClient = async (): Promise<void> => {
    fileEvidence.clear()
    const c = client
    client = null
    if (c === null) return
    await c.teardown()
  }

  /** 有進行中的回合先中斷再收掉,與 Claude teardownLive 對齊。 */
  const interruptAndTeardown = async (wasBusy: boolean): Promise<void> => {
    const c = client
    if (c !== null && wasBusy) await c.interrupt()
    await teardownClient()
  }

  /** 回合結束:解除 busy;切走時等的 sleep 在這裡補做(規格 §5)。 */
  const turnEnded = (): void => {
    setBusy(false)
    // 通知 busy 變化時可能同步注入新回合（同伴排隊投遞），此時不是回合結束。
    // 保留 sleepPending，讓新回合自己的結尾再休眠。
    if (!sleepPending || busy) return
    sleepPending = false
    pending = pending.then(async () => {
      await teardownClient()
      if (threadId !== null) setState({ kind: 'viewing', sessionId: threadId })
    }).catch((err: unknown) => deps.logError(asError(err, 'codex-sleep')))
  }

  const onEvents = (method: string, params: unknown): void => {
    if (method === 'turn/started' || method === 'turn/completed') fileEvidence.clear()
    const payload = params as { threadId?: unknown; turnId?: unknown; item?: { id?: unknown; type?: unknown; changes?: unknown } } | null
    if (method === 'item/started' && payload?.item?.type === 'fileChange' && typeof payload.item.id === 'string') {
      fileEvidence.set(payload.item.id, { threadId: payload.threadId, turnId: payload.turnId, changes: structuredClone(payload.item.changes) })
    }
    if (method === 'item/completed' && typeof payload?.item?.id === 'string') fileEvidence.delete(payload.item.id)

    const events = mapper.accept(method, params)
    pushBatch(events)
    for (const event of events) {
      if (event.kind !== 'session-end') continue
      if (threadId !== null) deps.onSessionEnded?.(threadId, event)
      turnEnded()
    }
  }

  const onApproval = async (kind: ApprovalKind, params: Record<string, unknown>): Promise<'accept' | 'decline'> => {
    const itemId = typeof params['itemId'] === 'string' ? params['itemId'] : ''
    const evidence = fileEvidence.get(itemId)
    const valid = () => evidence !== undefined && fileEvidence.get(itemId) === evidence && typeof params['threadId'] === 'string' && typeof params['turnId'] === 'string' && evidence.threadId === params['threadId'] && evidence.turnId === params['turnId']
    const ask: ApprovalAsk = kind === 'command'
      ? {
          toolUseId: itemId,
          toolName: 'Bash',
          input: { command: params['command'], cwd: params['cwd'], reason: params['reason'] },
        }
      : {
          // fileChange 的請求本身不帶 changes,那些在 item/started 已經畫進 tool block 了。
          toolUseId: itemId,
          toolName: 'Edit',
          input: { reason: params['reason'], ...(params['grantRoot'] == null ? {} : { grantRoot: params['grantRoot'] }), ...(valid() ? { changes: evidence!.changes } : {}) },
          executionCwd: deps.cwd,
          ...(valid() ? { validateEvidence: valid } : {}),
        }
    const outcome = await requestApproval(ask)
    // 拒絕與逾時都送 decline:cancel 會中斷整個 turn(規格 §3)。
    return outcome.decision === 'allow' ? 'accept' : 'decline'
  }

  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}

  /**
   * 右窗格工具(規格 §4.2)。codex 的 dynamic tool 呼叫不經 codex 自己的批准流程,
   * 所以 `ask` 的要自己先問使用者;批准卡的 toolUseId 用 callId,它與畫面上那顆
   * tool block 的 item.id 同值(RESULTS-22 §9),卡會掛在正確的 block 底下。
   */
  const runViewTool = async (
    view: CodexViewTools,
    name: ViewToolName,
    args: unknown,
    params: DynamicToolCallParams
  ): Promise<CodexToolOutcome> => {
    if (viewToolPolicy(fullToolName(name), 'codex') === 'ask') {
      // 缺少識別碼就無法把批准卡綁回工具，不能建立無法追蹤的批准。
      if (params.callId === null) return { ok: false, text: MSG.badArgs(name, 'callId') }
      const outcome = await requestApproval({ toolUseId: params.callId, toolName: name, input: asRecord(args) })
      if (outcome.decision !== 'allow') return { ok: false, text: outcome.reason ?? MSG.approvalDenied }
    }
    const result = await view.invoke(name, args, { callId: params.callId })
    if (!result.ok) return { ok: false, text: result.text }
    const output = result.output
    // 圖一律用 data URL:https 會被 app-server 擋掉,file:// 會多跑一顆 codex 自己的 view_image(RESULTS-22 §1)。
    return output.kind === 'image'
      ? { ok: true, text: output.text, imageDataUrl: toDataUrl({ mimeType: output.mimeType, dataBase64: output.dataBase64 }) }
      : { ok: true, text: output.text }
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

  /**
   * codex 呼叫同伴工具。參數檢查在這裡做:codex 的 inputSchema 是給模型看的提示,
   * 不保證送過來的東西合規。錯誤一律以文字回去,模型看得懂才改得了做法。
   */
  const onDynamicToolCall = async (
    tool: string,
    args: unknown,
    params: DynamicToolCallParams
  ): Promise<CodexToolOutcome> => {
    if (deps.chefTools?.specs.some(spec => spec.name === tool)) {
      if (chefToolPolicy(tool) === 'ask') {
        if (params.callId === null) return { ok: false, text: MSG.badArgs(tool, 'callId') }
        const approval = await requestApproval({ toolUseId: params.callId, toolName: tool, input: asRecord(args) })
        if (approval.decision !== 'allow') return { ok: false, text: approval.reason ?? MSG.approvalDenied }
      }
      return deps.chefTools.call(tool, args, params.callId ?? undefined)
    }
    const view = deps.viewTools
    const viewName = asViewToolName(tool)
    if (view !== undefined && viewName !== undefined) return await runViewTool(view, viewName, args, params)
    if (view !== undefined && viewName === undefined && tool !== PEER_TOOL_NAMES[0] && tool !== PEER_TOOL_NAMES[1]) {
      return { ok: false, text: PEER_MSG.unknownTool(tool) }
    }
    const peer = deps.peerTools
    if (peer === undefined) return { ok: false, text: PEER_MSG.peerToolsMissing }
    const record: Record<string, unknown> = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
    try {
      if (tool === PEER_TOOL_NAMES[0]) {
        const question = str(record['question'])
        if (question === undefined) return { ok: false, text: PEER_MSG.askPeerNeedsQuestion }
        // 規格 §5:`to` 有給就要對得上。給了一個空字串或不是字串的東西,不能當成沒給:
        // 只有一個同伴時那會靜默送給它,與「有給就要對得上」相反。
        const rawTo = record['to']
        const to = str(rawTo)
        if (rawTo !== undefined && to === undefined) return { ok: false, text: PEER_MSG.askPeerBadTo }
        return { ok: true, text: await peer.askPeer(question, to) }
      }
      if (tool === PEER_TOOL_NAMES[1]) {
        const id = str(record['id'])
        const text = str(record['text'])
        if (id === undefined || text === undefined) return { ok: false, text: PEER_MSG.answerPeerNeedsBoth }
        return { ok: true, text: await peer.answerPeer(id, text) }
      }
      return { ok: false, text: PEER_MSG.unknownTool(tool) }
    } catch (cause) {
      if (cause instanceof PeerError) return { ok: false, text: cause.message }
      throw cause
    }
  }

  const ensureClient = async (): Promise<CodexClient> => {
    const existing = client
    if (existing !== null && existing.isRunning()) return existing
    if (!commandExists('codex')) throw new Error(MSG_NO_CODEX)
    const gen = generation
    const dynamicTools = [
      ...(deps.chefTools?.specs ?? []),
      ...(deps.viewTools === undefined ? [] : codexViewToolSpecs()),
      ...(deps.peerTools === undefined ? [] : codexPeerToolSpecs()),
    ]
    const created = makeClient({
      cwd: deps.cwd,
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.effort === undefined ? {} : { effort: deps.effort }),
      ...(deps.skillRoots === undefined ? {} : { skillRoots: deps.skillRoots() }),
      logError: deps.logError,
      onEvents: (method, params) => { if (gen === generation) onEvents(method, params) },
      onApproval: (kind, params) => gen === generation && !disposed ? onApproval(kind, params) : Promise.resolve('decline'),
      ...(dynamicTools.length === 0 ? {} : { dynamicTools, onDynamicToolCall }),
      onExit: (code) => {
        if (gen !== generation) return
        client = null
        sleepPending = false
        if (busy && !starting) {
          pushBatch([{ kind: 'session-end', isError: true, errorMessage: `codex 子程序結束,code ${code ?? 'null'}` }])
          setBusy(false)
        }
        // 子程序不在了,狀態一定不是 live(規格 §5:live 的定義就是子程序活著)。
        if (threadId !== null) setState({ kind: 'viewing', sessionId: threadId })
      },
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    })
    client = created
    latestClient = created
    starting = true
    try {
      const result = await created.start(threadId ?? undefined)
      if (disposed || gen !== generation) return created
      threadId = result.threadId
      pushBatch([{
        kind: 'session-start',
        sessionId: result.threadId,
        cwd: deps.cwd,
        ...(result.model === undefined ? {} : { model: result.model }),
      }])
      deps.onSessionStarted?.(result.threadId, deps.cwd)
      setState({ kind: 'live', sessionId: result.threadId })
      return created
    } finally {
      starting = false
    }
  }

  const userInput = (text: string, attachments?: readonly PromptAttachment[]): void => {
    if (disposed) return
    // viewing 時的新輸入讓尚未回來的歷史失效；live 回合沿用 client 的世代。
    if (state.kind === 'viewing' && busy === false) generation += 1
    const gen = generation
    pushBatch([{ kind: 'user-text', text: attachmentLabel(text, attachments) }])
    setBusy(true)
    pending = pending.then(async () => {
      if (disposed || gen !== generation) return
      try {
        const c = await ensureClient()
        if (disposed || gen !== generation) return
        await c.send(text, attachments)
      } catch (cause) {
        // log 要有來源(asError 加 context),使用者看到的訊息用原始的錯誤,不帶前綴。
        deps.logError(asError(cause, 'codex-input'))
        if (disposed || gen !== generation) return
        const original = cause instanceof Error ? cause : new Error(String(cause))
        pushBatch([{ kind: 'session-end', isError: true, errorMessage: startFailureMessage(original) }])
        setBusy(false)
        await teardownClient()
        if (threadId !== null) setState({ kind: 'viewing', sessionId: threadId })
      }
    }).catch((err: unknown) => deps.logError(asError(err, 'codex-input')))
  }

  const openHistory = (sessionId: string): void => {
    if (disposed) return
    generation += 1
    const gen = generation
    const c = client
    // 中斷不能排在尚未完成的 send 後面，畫面也不等歷史查詢。
    if (c !== null) void c.interrupt().catch((cause: unknown) => deps.logError(asError(cause, 'codex-interrupt')))
    registry.denyAll(SWITCHING_SESSION)
    notifyPending()
    setBusy(false)
    sleepPending = false
    mapper = createCodexMapper()
    log = []
    pushBatch([RESET])
    setState({ kind: 'viewing', sessionId })
    threadId = sessionId
    pending = pending.then(async () => {
      await teardownClient()
      if (disposed || gen !== generation) return
      const items = await deps.loadHistory(sessionId)
      // 快速切換、輸入或關閉後到達的回應不能覆蓋新的畫面。
      if (disposed || gen !== generation) return
      pushBatch([...historyEvents(items), { kind: 'session-end', isError: false }])
    }).catch((cause: unknown) => {
      deps.logError(asError(cause, 'codex-history'))
      if (disposed || gen !== generation) return
      pushBatch([{ kind: 'session-end', isError: true, errorMessage: asError(cause, 'codex-history').message }])
    })
  }

  const replay = (): void => {
    if (!active) return
    if (state.kind === 'viewing' && log.length === 0) {
      openHistory(state.sessionId)
      return
    }
    chunked([RESET, ...log], (batch) => { deps.sink.events(batch) })
    deps.sink.state(state)
  }

  return {
    shutdownConfirmed: () => latestClient === null || latestClient.shutdownConfirmed?.() === true,
    userInput,
    approvalReply(requestId, decision: ApprovalDecision) {
      if (registry.reply(requestId, decision)) return
      deps.logError(new Error(`codex 對話:找不到批准 ${requestId},可能已逾時`))
    },
    startNew() {
      generation += 1
      const wasBusy = busy
      mapper = createCodexMapper()
      // 與 Claude 版的 teardownLive('切換 session') 對齊:換對話前先讓掛著的批准有個了結,
      // 否則卡片要等批准逾時才會移除。
      registry.denyAll(SWITCHING_SESSION)
      notifyPending()
      setBusy(false)
      sleepPending = false
      log = []
      threadId = null
      pushBatch([RESET])
      setState({ kind: 'idle' })
      pending = pending.then(() => interruptAndTeardown(wasBusy)).catch((err: unknown) => deps.logError(asError(err, 'codex-start-new')))
    },
    openHistory,
    handoffDone(toolUseId) {
      const view = deps.viewTools
      if (view === undefined) {
        deps.logError(new Error(`codex 對話沒有接右窗格工具,交接 ${toolUseId} 無處可送`))
        return
      }
      view.handoffDone(toolUseId)
    },
    activate() {
      if (active || disposed) return
      active = true
      sleepPending = false
      replay()
    },
    deactivate() {
      active = false
      // 背景投遞也要登記休眠，包含核心尚在啟動的回合。
      if (busy) { sleepPending = true; return }
      if (state.kind !== 'live') return
      pending = pending.then(async () => {
        await teardownClient()
        if (threadId !== null) setState({ kind: 'viewing', sessionId: threadId })
      }).catch((err: unknown) => deps.logError(asError(err, 'codex-deactivate')))
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
      registry.denyAll(MSG_WINDOW_CLOSED)
      notifyPending()
      const wasBusy = busy
      pending = pending.then(() => interruptAndTeardown(wasBusy)).catch((err: unknown) => deps.logError(asError(err, 'codex-dispose')))
      await pending
    },
  }
}
