import { realpathSync } from 'node:fs'
import type { ChefService, WorkerRequest, WorkerHandle } from './chef/service.js'
import { createChefTools } from './chef/tools.js'
import { ERROR_INTAKE_SETUP_PURPOSE } from '../shared/chef.js'
import type { ErrorIntakeService } from './error-intake/service.js'
import type { ActivityLedger } from './activity-ledger.js'
import { writtenPaths, type ConversationActivity } from './conversation-activity.js'
import { historyEvents as codexHistoryEvents } from './codex/mapper.js'
import { CONVERSATION_TOOLS_CHANNEL, ConversationToolsRequestSchema, type ConversationToolsResponse } from '../shared/conversation-tools.js'
import { isChefInternalTool } from '../shared/chef.js'
import type { Attachments } from './attachments.js'
import type { DevelopmentDiff } from './development-diff.js'
import type { PermissionService } from './permissions/service.js'
import type { CodexCatalog } from './codex/catalog.js'
import type { PeerService } from './peer/service.js'
import type { DeliverOutcome, OpenParticipantInput } from './group/service.js'
import { ipcMain, type WebContents } from 'electron'
import type { Event } from '../shared/events.js'
import type { SessionState } from '../shared/session-state.js'
import {
  IPC,
  parsePeerAction,
  type PeerStatePayload,
  parseApprovalReply,
  parseHandoffDone,
  parseIntentOpenHistory,
  parseUserInput,
  type ApprovalAskPayload,
  type EventsBatchPayload,
  type SessionStatePayload,
  type SessionSummary,
  type TerminalEndpoint,
} from '../shared/ipc.js'
import { parseSessionListScope, sortTabs, type Provider, type ProjectEntry, type ProjectsState, type ProjectsView, type SessionLink } from '../shared/projects.js'
import { asError, type QueryFn, type createAgentHost } from './agent-host.js'
import { createApprovalRegistry as defaultApprovalRegistry, type createApprovalRegistry } from './approval.js'
import {
  createConversation as defaultCreateConversation,
  type Conversation,
  type ConversationSink,
  type ViewToolHooks,
} from './conversation.js'
import { createCodexConversation as defaultCreateCodexConversation, type CodexViewTools } from './codex/conversation.js'
import { createGrokConversation as defaultCreateGrokConversation, type GrokViewTools } from './grok/conversation.js'
import type { GrokCatalog } from './grok/catalog.js'
import type { ProjectsService } from './projects-service.js'
import {
  activeTabId,
  closeChefWorkerTab,
  closeInactiveChefTabs,
  conversationTabs,
  currentThread,
  findProject,
  findProjectByTab,
  foregroundConversationId,
  focusTab,
  setActive,
  openConversationTab,
  lastSessionId,
  pointConversationAt,
  recordSession,
  recordSessionCost,
  sessionCostOf,
  startThread,
  tabLastUrl,
} from './projects-state.js'
import type { SessionOptions } from './session-args.js'
import { transcriptPathFor } from './transcript-path.js'

/**
 * `prev` 有、`next` 沒有的對話分頁 id(跨所有專案,含整個專案被移除的情況)。
 * 每對話瀏覽器規格 §3:瀏覽器的壽命跟著分頁,只有分頁真的從狀態裡消失才該收掉它的瀏覽器。
 */
function removedConversationIds(prev: ProjectsState, next: ProjectsState): readonly string[] {
  const nextIds = new Set(next.projects.flatMap((p) => conversationTabs(p).map((t) => t.id)))
  return prev.projects.flatMap((p) => conversationTabs(p).map((t) => t.id)).filter((id) => !nextIds.has(id))
}

function labelConversationTab(state: ProjectsState, projectId: string, tabId: string, label: string): ProjectsState {
  const project = findProject(state, projectId)
  const tab = project?.tabs.find((candidate) => candidate.id === tabId && candidate.contentType === 'conversation')
  if (tab === undefined || (tab.label === label && tab.customLabel === label)) return state
  return { ...state, projects: state.projects.map((entry) => entry.id !== projectId ? entry : {
    ...entry,
    tabs: entry.tabs.map((candidate) => candidate.id === tabId
      ? { ...candidate, label, customLabel: label }
      : candidate),
  }) }
}

export type { ViewToolHooks }

/** 哪一種 provider 有本機 transcript。codex 與 grok 都沒有,thread 記 null。 */
const HAS_TRANSCRIPT: Readonly<Record<Provider, boolean>> = { claude: true, codex: false, grok: false }

/**
 * 查某個 provider 的歷史寫檔證據要往哪裡讀。grok 是 `live`:它沒有「讀某個 session 的
 * 歷史項目」這種 API,只有 session/load 的重播,那要一個活著的子行程,不適合在 diff
 * 查詢裡做。少一列 TypeScript 會報錯,新增 provider 時一定要想清楚走哪一條。
 */
const TRANSCRIPT: Readonly<Record<Provider, 'codex' | 'claude' | 'live'>> = {
  claude: 'claude', codex: 'codex', grok: 'live',
}

export interface SessionSource {
  /** 帶 cwd 時只回那個目錄底下的 session(規格 §3.2 的「本專案」)。 */
  list(cwd?: string): Promise<readonly SessionSummary[]>
  loadHistory(sessionId: string, costOf?: (sessionId: string) => SessionLink['cost']): Promise<readonly Event[]>
  /** transcript 記的 cwd;SDK 列表裡沒有這個 session 時回 undefined。 */
  cwdOf(sessionId: string): string | undefined
}

/** 每個專案一份的執行環境,由 index.ts 用該專案的 rootPath 與 view tools 組出來。 */
export interface ProjectRuntime {
  readonly codexSkillRoots?: () => readonly string[]
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  readonly viewTools?: ViewToolHooks
  /** codex 對話用的右窗格工具(codex view tools 規格 §4.1)。Claude 那側走 sessionOptions 裡的 MCP server。 */
  readonly codexViewTools?: CodexViewTools
  /** grok 對話用的右窗格工具(grok 規格 §5.6);token 在這裡面,不外流。 */
  readonly grokViewTools?: GrokViewTools
  /** 收掉這份執行環境專屬的資源(Task 10 的每專案 MCP server);core dispose 之後呼叫。 */
  readonly dispose?: () => void
}

export interface IpcBridgeDeps {
  readonly chef?: ChefService
  readonly errorIntake?: ErrorIntakeService
  readonly activityLedger?: ActivityLedger
  readonly loadClaudeActivity?: (sessionId: string) => Promise<ConversationActivity>
  readonly attachments?: Attachments
  readonly developmentDiff?: DevelopmentDiff
  readonly permissions?: PermissionService
  readonly onAnyBusyChange?: (anyBusy: boolean) => void
  /** 同伴問答(P 規格 §4)。沒給就沒有同伴功能,其餘行為完全不變。 */
  readonly peer?: PeerService
  readonly webContents: WebContents
  readonly projects: ProjectsService
  readonly codexCatalog: CodexCatalog
  readonly grokCatalog: GrokCatalog
  readonly sessions: SessionSource
  /**
   * 每個對話分頁呼叫一次(D2)。`cwd` 是該對話的工作目錄，可能是 worktree 路徑；
   * `conversationId` 供 log 與測試識別；`provider` 決定要掛哪一組工具。
   */
  readonly runtimeFor: (projectId: string, cwd: string, conversationId: string, provider: Provider) => ProjectRuntime
  /**
   * 每對話瀏覽器:前景換人時換顯示。瀏覽器的壽命跟著對話分頁,不跟著 slot:
   * 分頁從狀態裡消失才收;重新指定資料夾或主廚 worker 停止只重建/收掉 slot,瀏覽器留著。
   * 沒給就沒有瀏覽器。
   */
  readonly browser?: { show(conversationId: string | null): void; dispose(conversationId: string): Promise<void> }
  readonly logError: (error: Error) => void
  /** `os.homedir()`,transcript 路徑的根。 */
  readonly homeDir: string
  readonly queryFn?: QueryFn
  readonly approvalTimeoutMs?: number
  readonly createHost?: typeof createAgentHost
  readonly createRegistry?: typeof createApprovalRegistry
  readonly terminalPort?: number
  readonly terminalToken?: string
  /** 測試用接縫:換掉對話核心。 */
  readonly createConversation?: typeof defaultCreateConversation
  /** 測試用接縫:換掉 codex 的對話核心。 */
  readonly createCodexConversation?: typeof defaultCreateCodexConversation
  /** 測試用接縫:換掉 grok 的對話核心。 */
  readonly createGrokConversation?: typeof defaultCreateGrokConversation
}

export interface IpcBridge {
  startChefWorker(request: WorkerRequest): Promise<WorkerHandle>
  /** 群組跳轉用:聚焦既有 session 或建立並命名歷史分頁。 */
  openHistoryConversation(request: OpenParticipantInput): void
  hasBusyWork(cwd: string): boolean
  dispose(): Promise<void>
  disposeConversation(conversationId: string): Promise<void>
  /** 合併用:依 projectId 與分頁 id 拿到那個對話的忙碌狀態與輸入口(合併規格 §4)。 */
  conversationFor(projectId: string, tabId: string): { isBusy(): boolean; userInput(text: string): void } | undefined
  /**
   * 群組規格 §5.4:群組送訊息略過主廚的 `guard`。guard 存在是為了擋「從一般介面
   * 打擾被主廚管理的對話」,群組是這件事唯一該發生的地方,所以這條路不套它。
   * 跟 `conversationFor` 一樣只看已經建起來的 slot:沒 slot 就是還沒跑過,不該憑空開。
   */
  deliverToManaged(projectId: string, conversationId: string, text: string): DeliverOutcome
}

interface Slot {
  readonly core: Conversation
  /** 兩種 provider 都有:codex 不用 sessionOptions,但要同一份右窗格工具與 dispose。 */
  readonly runtime?: ProjectRuntime
  readonly projectId: string
  /** 建 core 時的 rootPath;之後被重新指定就整個 core 重建。 */
  readonly rootPath: string
}

/**
 * 路由器:renderer 只有一份,主行程每個對話分頁一份對話核心(D2)。
 * 這裡只做三件事:把 renderer 的訊息轉給前景對話、把專案狀態推給 renderer、
 * 在前景對話改變時切換前景。對話本身的狀態機、批准、事件流都在 conversation.ts。
 */
export function createIpcBridge(deps: IpcBridgeDeps): IpcBridge {
  /** 鍵是 conversationId(= TabEntry.id)。 */
  const slots = new Map<string, Slot>()
  // 同時保存歸屬與快照;了結、關閉時一併移除。
  const approvals = new Map<string, ApprovalAskPayload>()
  /** 只記 renderer 送來的使用者訊息。 */
  let lastUserText = new Map<string, string>()
  /** 前景對話的 conversationId。 */
  let currentId: string | null = null
  let disposed = false
  // 初次推送也通知,讓擋睡眠端取得明確的初始狀態。
  let lastAnyBusy: boolean | undefined

  const contents = (): WebContents | null => {
    if (disposed || deps.webContents.isDestroyed()) return null
    return deps.webContents
  }

  /** 送不出去就 throw。對話核心把 throw 當成「視窗關了」的訊號,立即 deny。 */
  const sendOrThrow = (channel: string, payload: unknown): void => {
    const wc = contents()
    if (wc === null) throw new Error(`${channel}：webContents 已銷毀`)
    wc.send(channel, payload)
  }

  const sendBestEffort = (channel: string, payload: unknown): void => {
    const wc = contents()
    if (wc === null) {
      // 收尾途中送不出去是預期行為,不必吵;其餘情況要留下記錄。
      if (!disposed) deps.logError(new Error(`${channel}：視窗已不可用，這則訊息未送達`))
      return
    }
    wc.send(channel, payload)
  }

  // ---- 專案狀態 → renderer ----

  const tabIdsWhere = (p: ProjectEntry, pick: (core: Conversation) => boolean): readonly string[] =>
    conversationTabs(p)
      .filter((t) => {
        const slot = slots.get(t.id)
        return slot !== undefined && pick(slot.core)
      })
      .map((t) => t.id)

  const composeView = (): ProjectsView => {
    const state = deps.projects.state()
    return {
      ...(deps.projects.error() === undefined ? {} : { error: deps.projects.error() }),
      activeId: state.activeId,
      projects: state.projects.map((p) => {
        const pendingTabIds = tabIdsWhere(p, (core) => core.pendingApprovals() > 0)
        return {
          id: p.id,
          name: p.name,
          rootPath: p.rootPath,
          ...(p.isGitRepo === undefined ? {} : { isGitRepo: p.isGitRepo }),
          available: deps.projects.isAvailable(p.id),
          pendingApproval: pendingTabIds.length > 0,
          pendingTabIds,
          producingTabIds: tabIdsWhere(p, (core) => core.isBusy() && core.turnProduced()),
          busyTabIds: tabIdsWhere(p, (core) => core.isBusy()),
          busySince: Object.fromEntries(conversationTabs(p).flatMap((tab) => {
            const core = slots.get(tab.id)?.core
            const since = core?.busyStartedAt()
            return core?.isBusy() && since !== undefined && since !== null ? [[tab.id, since]] : []
          })),
          tabs: sortTabs(p.tabs.map((tab) => {
            const worker = deps.chef?.worker(tab.id)
            const withUrl = tab.contentType === 'conversation' ? { ...tab, lastUrl: tabLastUrl(p, tab.id) } : tab
            return worker ? { ...withUrl, chefTaskId: worker.taskId } : withUrl
          })),
          activeTabId: activeTabId(p),
          threads: p.threads,
        }
      }),
    }
  }

  const pushProjects = (): void => {
    const view = composeView()
    const anyBusy = view.projects.some((p) => p.busyTabIds.length > 0)
    if (anyBusy !== lastAnyBusy) {
      lastAnyBusy = anyBusy
      deps.onAnyBusyChange?.(anyBusy)
    }
    sendBestEffort(IPC.projectsState, view)
  }

  // ---- thread 記錄 ----

  const linkFor = (provider: Provider, rootPath: string, sessionId: string, cwd: string | undefined): SessionLink => ({
    linkId: sessionId,
    provider,
    sessionId,
    transcriptPath: HAS_TRANSCRIPT[provider] ? transcriptPathFor(deps.homeDir, cwd ?? rootPath, sessionId) : null,
    parentLinkId: null,
    startedAt: deps.projects.now(),
    endedAt: null,
    endReason: null,
    models: [],
  })

  const recordStarted = (provider: Provider, conversationId: string, projectId: string, sessionId: string, cwd: string | undefined): void => {
    deps.projects.update((state) => {
      const entry = findProject(state, projectId)
      if (entry === undefined) return state
      // 分頁指到不存在的 thread(規格 §5):補一條,之後的 session 才記得進去。
      const seeded = currentThread(entry, conversationId) === undefined
        ? startThread(state, projectId, conversationId, deps.projects.newId(), deps.projects.now())
        : state
      const seededEntry = findProject(seeded, projectId)
      const thread = seededEntry === undefined ? undefined : currentThread(seededEntry, conversationId)
      if (seededEntry === undefined || thread === undefined) return seeded
      return recordSession(seeded, projectId, thread.id, linkFor(provider, seededEntry.rootPath, sessionId, cwd))
    })
  }

  // ---- 每個對話分頁一份 core ----

  const createSlot = (conversationId: string, projectId: string, rootPath: string): Slot => {
    const entry = findProject(deps.projects.state(), projectId)
    // 規格 §5:狀態檔裡的分頁指到不存在的 thread,記錯誤;那個分頁當新對話(initialSessionId 為 undefined)。
    if (entry !== undefined && currentThread(entry, conversationId) === undefined) {
      deps.logError(new Error(`對話分頁 ${conversationId} 指到不存在的 thread，當成新對話`))
    }
    const initialSessionId = entry === undefined ? undefined : lastSessionId(entry, conversationId)
    const sink: ConversationSink = {
      // conversationId 與 projectId 在這裡補:core 不知道自己是誰,router 知道。
      events: (events: readonly Event[]) => {
        const payload: EventsBatchPayload = { conversationId, events }
        sendBestEffort(IPC.eventsBatch, payload)
      },
      state: (state: SessionState) => {
        const payload: SessionStatePayload = { conversationId, state }
        sendBestEffort(IPC.sessionState, payload)
      },
      approvalAsk: (request) => {
        const payload: ApprovalAskPayload = { ...request, projectId, conversationId }
        approvals.set(request.requestId, payload)
        sendOrThrow(IPC.approvalAsk, payload)
      },
      approvalSettled: (requestId) => {
        approvals.delete(requestId)
        sendBestEffort(IPC.approvalSettled, { requestId })
      },
    }
    const managed = deps.chef?.worker(conversationId)
    const common = {
      sink,
      onEvents: (events: readonly Event[]) => { deps.chef?.observe(conversationId, events) },
      onActivity: (sessionId: string, events: readonly Event[]) => { deps.activityLedger?.observe(`${provider}:${sessionId}`, cwd, events) },
      // live 回呼不受前景篩選影響,也不會把歷史重播當成新花費。
      onSessionEnded: (sessionId: string, event: Extract<Event, { kind: 'session-end' }>) => {
        if (event.costUsd === undefined && event.numTurns === undefined && event.tokens === undefined) return
        deps.projects.update((s) => recordSessionCost(s, projectId, sessionId, {
          ...(event.costUsd === undefined ? {} : { usd: event.costUsd }),
          ...(event.numTurns === undefined ? {} : { turns: event.numTurns }),
          ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
        }))
      },
      logError: deps.logError,
      onPendingApprovalsChange: (count: number) => { deps.chef?.waiting(conversationId, count > 0); pushProjects() },
      onTurnProduced: pushProjects,
      onBusyChange: (busy: boolean) => {
        pushProjects()
        if (!busy) deps.peer?.notifyIdle(conversationId)
      },
      approvalTimeoutMs: managed ? null : deps.approvalTimeoutMs,
      createRegistry: (deps.permissions || managed) ? (options: Parameters<typeof createApprovalRegistry>[0]) => {
        const wrapped = { ...options, onDecision: (request: import('./approval.js').ApprovalRequest, outcome: import('./approval.js').ApprovalOutcome) => {
          options.onDecision?.(request, outcome)
          if (outcome.decision === 'deny') deps.chef?.denied(conversationId, { timedOut: outcome.timedOut === true })
        } }
        return deps.permissions ? deps.permissions.registry({ projectId, conversationId, cwd }, wrapped) : (deps.createRegistry ?? defaultApprovalRegistry)(wrapped)
      } : deps.createRegistry,
    }

    const tab = entry?.tabs.find((t) => t.id === conversationId)
    const cwd = tab?.worktreePath ?? rootPath
    const provider: Provider = (tab?.provider ?? 'claude')
    // grok 的主廚工具掛在它自己的 HTTP MCP server 上(由 runtimeFor 建),這裡不必再建一份。
    const projectRoot = deps.projects.rootPathOf(projectId)
    const errorIntakeContext = managed?.purpose === ERROR_INTAKE_SETUP_PURPOSE && deps.errorIntake !== undefined && projectRoot !== undefined
      ? { service: deps.errorIntake, projectId, projectRoot }
      : undefined
    const chefTools = managed && deps.chef && provider !== 'grok'
      ? createChefTools(deps.chef, conversationId, errorIntakeContext === undefined ? {} : { errorIntake: errorIntakeContext })
      : undefined

    const runtime = deps.runtimeFor(projectId, cwd, conversationId, provider)

    const makeClaude = (): Conversation => (deps.createConversation ?? defaultCreateConversation)({
      ...common,
      onSessionStarted: (sessionId, startedCwd) => recordStarted('claude', conversationId, projectId, sessionId, startedCwd),
      strictShutdown: Boolean(managed),
      internalAutoAllow: managed ? isChefInternalTool : undefined,
      sessionOptions: managed ? resume => { const options = runtime.sessionOptions(resume); return { ...options, model: managed.model, maxTurns: 64, disallowedTools: [...(options.disallowedTools ?? []), 'Agent', 'Task'], mcpServers: { ...options.mcpServers, ...(chefTools ? { chef: chefTools.server } : {}) } } } : runtime.sessionOptions,
      loadHistory: (sessionId) => deps.sessions.loadHistory(sessionId, (id) => sessionCostOf(deps.projects.state(), id)),
      initialSessionId,
      viewTools: runtime.viewTools,
      queryFn: deps.queryFn,
      createHost: deps.createHost,
    })

    const makeCodex = (): Conversation => (deps.createCodexConversation ?? defaultCreateCodexConversation)({
      ...common,
      ...(managed ? { model: managed.model } : {}),
      ...(managed?.reasoningEffort === undefined ? {} : { effort: managed.reasoningEffort }),
      ...(chefTools ? { chefTools } : {}),
      onSessionStarted: (sessionId, startedCwd) => recordStarted('codex', conversationId, projectId, sessionId, startedCwd),
      cwd,
      ...(runtime.codexSkillRoots === undefined ? {} : { skillRoots: runtime.codexSkillRoots }),
      loadHistory: (threadId) => deps.codexCatalog.items(cwd, threadId),
      ...(initialSessionId === undefined ? {} : { initialThreadId: initialSessionId }),
      ...(deps.peer === undefined || managed ? {} : { peerTools: deps.peer.forConversation(conversationId) }),
      ...(runtime.codexViewTools === undefined ? {} : { viewTools: runtime.codexViewTools }),
    })

    /**
     * grok 的同伴工具不另外接:它們掛在同一份 HTTP MCP server 上,由 runtimeFor 建
     * `createConversationViewServer` 時就帶進去了(grok 規格 §6.1)。
     */
    const makeGrok = (): Conversation => (deps.createGrokConversation ?? defaultCreateGrokConversation)({
      ...common,
      ...(managed ? { model: managed.model } : {}),
      onSessionStarted: (sessionId, startedCwd) => recordStarted('grok', conversationId, projectId, sessionId, startedCwd),
      cwd,
      ...(initialSessionId === undefined ? {} : { initialSessionId }),
      ...(runtime.grokViewTools === undefined ? {} : { viewTools: runtime.grokViewTools }),
    })

    const factories: Readonly<Record<Provider, () => Conversation>> = { claude: makeClaude, codex: makeCodex, grok: makeGrok }
    return { core: factories[provider](), runtime, projectId, rootPath }
  }

  const slotFor = (conversationId: string): Slot | undefined => {
    const existing = slots.get(conversationId)
    if (existing !== undefined) return existing
    const owner = findProjectByTab(deps.projects.state(), conversationId)
    if (owner === undefined) {
      // 規格 §5:狀態檔裡的分頁指到不存在的東西,記錯誤,不建 core。
      deps.logError(new Error(`找不到對話分頁 ${conversationId} 所屬的專案`))
      return undefined
    }
    const created = createSlot(conversationId, owner.id, owner.rootPath)
    slots.set(conversationId, created)
    return created
  }

  const currentSessionId = (project: ProjectEntry, tab: ProjectEntry['tabs'][number]): string | undefined => {
    const session = slots.get(tab.id)?.core.sessionState()
    return session === undefined ? lastSessionId(project, tab.id)
      : session.kind === 'idle' ? undefined : session.sessionId
  }

  // 登錄與核心生命週期分離，未曾切到前景的對話也能收到同伴提問。
  let registeredIds: readonly string[] = []
  const unregisterPeer = (conversationId: string): void => {
    deps.peer?.conversationEnded(conversationId)
    deps.peer?.registry.unregister(conversationId)
    registeredIds = registeredIds.filter((id) => id !== conversationId)
    lastUserText = new Map([...lastUserText].filter(([id]) => id !== conversationId))
  }

  const ensurePeerRegistered = (conversationId: string, projectId: string): void => {
    const registry = deps.peer?.registry
    if (deps.chef?.worker(conversationId) || findProject(deps.projects.state(), projectId)?.tabs.find(t => t.id === conversationId)?.chefTaskId) { if (registeredIds.includes(conversationId)) unregisterPeer(conversationId); return }
    const owner = findProject(deps.projects.state(), projectId)
    if (registry === undefined || owner === undefined) return
    const provider = owner.tabs.find((t) => t.id === conversationId)?.provider ?? 'claude'
    const existing = registry.get(conversationId)
    if (existing !== undefined && existing.projectId === projectId && existing.rootPath === owner.rootPath && existing.provider === provider) return
    if (existing !== undefined) unregisterPeer(conversationId)
    registry.register({
      conversationId,
      projectId,
      rootPath: owner.rootPath,
      provider,
      linkId: () => {
        const now = findProject(deps.projects.state(), projectId)
        return now === undefined ? undefined : currentThread(now, conversationId)?.sessions.at(-1)?.linkId
      },
      isBusy: () => Boolean(deps.chef?.guard(conversationId, owner.rootPath)) || (slots.get(conversationId)?.core.isBusy() ?? false),
      deliver: (text) => {
        const blocked = deps.chef?.guard(conversationId, owner.rootPath); if (blocked) throw Error(blocked)
        const core = slotFor(conversationId)?.core
        if (core === undefined) throw new Error(`找不到對話核心 ${conversationId}`)
        core.userInput(text)
        if (currentId !== conversationId) core.deactivate()
      },
      recentText: () => lastUserText.get(conversationId) ?? '',
    })
    registeredIds = [...registeredIds, conversationId]
  }

  const syncPeers = (state: ProjectsState): void => {
    const ids = state.projects.flatMap((p) => conversationTabs(p).map((t) => t.id))
    for (const id of registeredIds) {
      if (!ids.includes(id)) unregisterPeer(id)
    }
    for (const project of state.projects) {
      for (const tab of conversationTabs(project)) ensurePeerRegistered(tab.id, project.id)
    }
  }

  const activeSlot = (): Slot | undefined => (currentId === null ? undefined : slotFor(currentId))

  const guard = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      deps.logError(asError(err, label))
    }
  }

  /** 舊對話退到背景(回合跑完才 sleep);它的瀏覽器照常運作,只是右窗格改顯示新前景的那一個。專案切換與同專案切分頁都走這裡。 */
  const switchTo = (nextId: string | null): void => {
    if (nextId === currentId) return
    const prev = currentId === null ? undefined : slots.get(currentId)
    currentId = nextId
    prev?.core.deactivate()
    guard('browser.show', () => { deps.browser?.show(nextId) })
    activeSlot()?.core.activate()
  }

  /**
   * 收掉一個 slot。runtime 一定等 core 收完才拆:`Conversation.dispose()` 是真的非同步,
   * 它排進 pending 鏈的 window-closed effects 還會用到 `viewTools.abortPending` 與
   * host 的 interrupt／teardown,先拆 runtime 等於把它們從底下抽掉(規則 9)。
   * core 收尾失敗只記錯,runtime 照樣拆掉,不把每對話的資源留在原地。
   */
  const closeSlot = async (conversationId: string, slot: Slot): Promise<void> => {
    // 必須先取消,再移除登錄與 slot;分頁關閉與整體 dispose 共用。
    unregisterPeer(conversationId)
    slots.delete(conversationId)
    for (const [id, ask] of approvals) {
      if (ask.conversationId === conversationId) approvals.delete(id)
    }
    try {
      await slot.core.dispose()
    } catch (err) {
      deps.logError(asError(err, `dispose(${conversationId})`))
    } finally {
      slot.runtime?.dispose?.()
    }
  }

  // 同一分頁重新指定資料夾時可能已有舊 core 收尾中，必須分別追蹤每個 slot。
  let closing = new Map<Slot, { readonly id: string; readonly task: Promise<void> }>()
  const startClosing = (conversationId: string, slot: Slot): Promise<void> => {
    const task = closeSlot(conversationId, slot).finally(() => {
      closing = new Map([...closing].filter(([entry]) => entry !== slot))
    })
    closing = new Map([...closing, [slot, { id: conversationId, task }]])
    return task
  }
  const disposeSlot = (conversationId: string, slot: Slot): void => {
    startClosing(conversationId, slot).catch((err: unknown) => deps.logError(asError(err, `dispose(${conversationId})`)))
  }
  const disposeConversation = async (conversationId: string): Promise<void> => {
    deps.chef?.workerClosed(conversationId)
    const slot = slots.get(conversationId)
    const started = slot === undefined ? [] : [startClosing(conversationId, slot)]
    await Promise.all([
      ...started,
      ...[...closing.values()].filter((entry) => entry.id === conversationId).map((entry) => entry.task),
    ])
  }

  /** 這個 slot 綁的專案、資料夾、分頁還在不在。 */
  const slotStillValid = (state: ProjectsState, conversationId: string, slot: Slot): boolean => {
    const after = findProject(state, slot.projectId)
    return after !== undefined && after.rootPath === slot.rootPath && after.tabs.some((t) => t.id === conversationId)
  }

  const foregroundTabKey = (state: ProjectsState): string | null => {
    const project = state.activeId === null ? undefined : findProject(state, state.activeId)
    return project === undefined ? null : `${project.id}:${activeTabId(project)}`
  }

  const cleanupInactiveChefTabs = (): void => {
    const activeWorkersByTask = new Map(deps.projects.state().projects.flatMap((project) =>
      (deps.chef?.tasksOf(project.id) ?? []).map((task) => [
        task.id,
        new Set(task.attempts.filter((attempt) => ['running', 'stopping'].includes(attempt.status)).map((attempt) => attempt.workerId)),
      ] as const)
    ))
    deps.projects.update((state) => closeInactiveChefTabs(state, activeWorkersByTask, deps.projects.now()))
  }

  const unsubscribe = deps.projects.subscribe((next, prev) => {
    const foregroundChanged = foregroundTabKey(prev) !== foregroundTabKey(next)
    // 每對話瀏覽器規格 §3:瀏覽器的壽命跟著分頁,不跟著 slot——分頁真的從狀態裡消失
    // (關閉分頁、整個專案被移除)才收掉;重新指定資料夾只是 slot 重建,瀏覽器留著。
    for (const id of removedConversationIds(prev, next)) {
      deps.browser?.dispose(id).catch((err: unknown) => {
        deps.logError(asError(err, `browser.dispose(${id})`))
      })
    }
    // 專案被移除、資料夾被重新指定(規格 §6)、對話分頁被關閉(D2 規格 §3):這個 core 已經不該存在,先收掉。
    // 關掉的若是前景對話,不另外 deactivate:core.dispose() 自己走收尾(deny-all、interrupt/teardown),
    // 下面 switchTo 找不到它就只 activate 新前景。順序與 D 相同。
    for (const [conversationId, slot] of [...slots]) {
      if (!slotStillValid(next, conversationId, slot)) { deps.chef?.workerClosed(conversationId); disposeSlot(conversationId, slot) }
    }
    syncPeers(next)
    const nextId = foregroundConversationId(next)
    if (nextId !== currentId) {
      // 規則 2:先讓 renderer 知道前景換了,它才能在新對話的批准卡送到之前換過濾條件。
      pushProjects()
      switchTo(nextId)
    } else {
      if (nextId !== null && !slots.has(nextId)) activeSlot()?.core.activate()
      pushProjects()
    }
    if (foregroundChanged) cleanupInactiveChefTabs()
  })

  // ---- renderer → active core ----

  const rejectPayload = (channel: string, raw: unknown): Error =>
    new Error(`${channel}：payload 形狀不符（${typeof raw}），已丟棄`)

  const withActive = (channel: string, fn: (slot: Slot, conversationId: string) => void): void => {
    const slot = activeSlot()
    if (slot === undefined || currentId === null) {
      deps.logError(new Error(`${channel}：沒有前景對話，已丟棄`))
      return
    }
    fn(slot, currentId)
  }

  const diffContext = (slot: Slot, conversationId: string) => {
    const entry = findProject(deps.projects.state(), slot.projectId)
    const tab = entry?.tabs.find(t => t.id === conversationId)
    if (!entry || !tab || tab.contentType !== 'conversation') throw Error('對話已關閉')
    const managed = deps.chef?.taskContext(conversationId)
    if (managed) return managed
    const cwd = tab.worktreePath ?? slot.rootPath
    return { cwd, key: JSON.stringify([slot.projectId, conversationId, tab.threadId, cwd]) }
  }
  const captureBeforeInput = async (slot: Slot, id: string) => {
    const context = diffContext(slot, id)
    try { await deps.developmentDiff?.capture(context.key, context.cwd) }
    catch (error) { deps.logError(asError(error, '建立 diff 基準')) }
    if (disposed || slots.get(id) !== slot || diffContext(slot, id).key !== context.key) throw Error('對話已變更，訊息未送出')
  }
  const activitySessionId = (slot: Slot, id: string): string | undefined => {
    const project = findProject(deps.projects.state(), slot.projectId)
    const state = slot.core.sessionState()
    return state.kind === 'idle' ? (project ? lastSessionId(project, id) : undefined) : state.sessionId
  }
  // grok 沒有「讀某個 session 的歷史項目」這種 API,只有 session/load 的重播。
  // 重播要一個活著的子行程,不適合在 diff 查詢裡做,所以 grok 只用 live 的事件。
  // 這是已知代價:Grok 分頁關掉再開,之前那一段的寫檔證據查不回來,diff 會少列檔案。
  const activityFor = async (slot: Slot, id: string, cwd: string): Promise<{ paths: string[]; warnings: string[]; sessionId?: string }> => {
    const project = findProject(deps.projects.state(), slot.projectId)
    const provider = project?.tabs.find(t => t.id === id)?.provider ?? 'claude'
    const sessionId = activitySessionId(slot, id)
    const live = [...(slot.core.activityEvents?.() ?? [])]
    const groups: (readonly Event[])[] = [], warnings: string[] = [], externalPaths: string[] = []
    if (sessionId) {
      try {
        if (TRANSCRIPT[provider] === 'codex') groups.push(codexHistoryEvents(await deps.codexCatalog.items(cwd, sessionId)))
        else if (TRANSCRIPT[provider] === 'claude' && deps.loadClaudeActivity) { const loaded = await deps.loadClaudeActivity(sessionId); groups.push(...loaded.groups); warnings.push(...loaded.warnings); externalPaths.push(...(loaded.externalWrites ?? []).filter(write => write.parentSessionId === sessionId).flatMap(write => write.paths)) }
        else if (TRANSCRIPT[provider] === 'claude') groups.push(await deps.sessions.loadHistory(sessionId))
      } catch { warnings.push('部分對話紀錄無法讀取，僅使用目前可驗證的寫檔事件。') }
    }
    for (const source of deps.chef?.sources(id) ?? []) {
      if (source.sessionId === sessionId && source.provider === provider) continue
      try {
        const saved = await deps.activityLedger?.read(`${source.provider}:${source.sessionId}`) ?? []
        externalPaths.push(...saved)
        if (TRANSCRIPT[source.provider] === 'codex') groups.push(codexHistoryEvents(await deps.codexCatalog.items(cwd, source.sessionId)))
        else if (TRANSCRIPT[source.provider] === 'claude' && deps.loadClaudeActivity) { const child = await deps.loadClaudeActivity(source.sessionId); groups.push(...child.groups); warnings.push(...child.warnings); externalPaths.push(...(child.externalWrites ?? []).filter(w => w.parentSessionId === source.sessionId).flatMap(w => w.paths)) }
      } catch { warnings.push('部分受管理工作者的紀錄暫時無法讀取。') }
    }
    if (sessionId) groups.push(live)
    // Never merge tool IDs from different sessions/subagents into one matching table.
    const recorded = sessionId ? await deps.activityLedger?.read(`${provider}:${sessionId}`) ?? [] : []
    const evidenceCwd = provider === 'claude' && sessionId ? deps.sessions.cwdOf(sessionId) ?? cwd : cwd
    const confirmed = [...new Set([...writtenPaths({ groups, warnings }, evidenceCwd), ...externalPaths])]
    if (sessionId && !deps.chef?.worker(id)) deps.activityLedger?.record(`${provider}:${sessionId}`, confirmed)
    const paths = [...new Set([...recorded, ...confirmed])]
    return { paths, warnings, sessionId }
  }
  const sending = new Set<string>()
  const onConversationTools = async (event: { sender: unknown }, raw: unknown): Promise<ConversationToolsResponse> => {
    if (event.sender !== deps.webContents) return { kind: 'error', message: '不接受此來源的對話工具請求' }
    const parsed = ConversationToolsRequestSchema.safeParse(raw)
    if (!parsed.success || disposed) return { kind: 'error', message: '對話工具請求無效' }
    const request = parsed.data
    const owner = findProjectByTab(deps.projects.state(), request.conversationId)
    if (!owner?.tabs.some(t => t.id === request.conversationId && t.contentType === 'conversation')) return { kind: 'error', message: '對話已不存在' }
    const slot = slotFor(request.conversationId)
    if (!slot) return { kind: 'error', message: '對話已不存在' }
    try {
      const context = diffContext(slot, request.conversationId)
      if (request.action === 'repositories') {
        if (!deps.developmentDiff) throw Error('diff 服務尚未啟動')
        const activity = await activityFor(slot, request.conversationId, context.cwd)
        if (slots.get(request.conversationId) !== slot || diffContext(slot, request.conversationId).key !== context.key || activitySessionId(slot, request.conversationId) !== activity.sessionId) throw Error('對話已變更，請重新整理')
        const catalog = await deps.developmentDiff.repositories(context.cwd, activity.paths)
        if (activitySessionId(slot, request.conversationId) !== activity.sessionId || diffContext(slot, request.conversationId).key !== context.key) throw Error('對話已變更，請重新整理')
        return { ...catalog, warnings: [...catalog.warnings, ...activity.warnings] }
      }
      if (request.action === 'diff') {
        if (!deps.developmentDiff) throw Error('diff 服務尚未啟動')
        const activity = await activityFor(slot, request.conversationId, context.cwd)
        if (slots.get(request.conversationId) !== slot || diffContext(slot, request.conversationId).key !== context.key || activitySessionId(slot, request.conversationId) !== activity.sessionId) throw Error('對話已變更，請重新整理')
        const result = await deps.developmentDiff.read(context.key, context.cwd, request.scope, request.repositoryId, request.baseRef, activity.paths)
        if (activitySessionId(slot, request.conversationId) !== activity.sessionId || diffContext(slot, request.conversationId).key !== context.key) throw Error('對話已變更，請重新整理')
        return { ...result, warnings: [...result.warnings, ...activity.warnings] }
      }
      if (!deps.attachments) throw Error('附件服務尚未啟動')
      if (request.action === 'pick') {
        const selected = await deps.attachments.pick(request.conversationId)
        try { if (disposed || slots.get(request.conversationId) !== slot || diffContext(slot, request.conversationId).key !== context.key) throw Error('對話已變更，未附加檔案') }
        catch (error) { for (const a of selected) await deps.attachments.remove(request.conversationId, a.id); throw error }
        return { kind: 'attachments', attachments: selected }
      }
      if (request.action === 'remove') { await deps.attachments.remove(request.conversationId, request.id); return { kind: 'attachments', attachments: [] } }
      if (!deps.chef && owner.tabs.find(t => t.id === request.conversationId)?.chefTaskId) throw Error('主廚服務不可用，此工作者只供檢視')
      const blocked = deps.chef?.guard(request.conversationId, context.cwd); if (blocked) throw Error(blocked)
      if (sending.has(request.conversationId)) throw Error('訊息正在送出')
      if (slot.core.pendingApprovals() > 0) throw Error('請先回覆待批准的請求')
      if (!request.text.trim() && !request.attachments.length) throw Error('請輸入訊息或附加檔案')
      const attachments = deps.attachments.prepare(request.conversationId, request.attachments)
      sending.add(request.conversationId)
      try {
        const session = JSON.stringify(slot.core.sessionState())
        await captureBeforeInput(slot, request.conversationId)
        if (JSON.stringify(slot.core.sessionState()) !== session || slot.core.pendingApprovals() > 0) throw Error('對話狀態已改變，草稿未送出，請重試')
        lastUserText = new Map([...lastUserText, [request.conversationId, request.text]])
        slot.core.userInput(request.text, attachments)
        deps.attachments.sent(request.attachments)
        return { kind: 'sent' }
      } finally { sending.delete(request.conversationId) }
    } catch (error) { return { kind: 'error', message: asError(error, '對話工具').message } }
  }

  const onUserInput = (_event: unknown, raw: unknown): void =>
    guard(IPC.userInput, () => {
      const text = parseUserInput(raw)
      if (text === null) {
        deps.logError(rejectPayload(IPC.userInput, raw))
        return
      }
      withActive(IPC.userInput, (slot, conversationId) => {
        if (!deps.chef && findProject(deps.projects.state(), slot.projectId)?.tabs.find(t => t.id === conversationId)?.chefTaskId) { deps.logError(new Error('主廚服務不可用，此工作者只供檢視')); return }
        const blocked = deps.chef?.guard(conversationId, diffContext(slot, conversationId).cwd); if (blocked) { deps.logError(new Error(blocked)); return }
        lastUserText = new Map([...lastUserText, [conversationId, text]])
        if (deps.developmentDiff) {
          const session = JSON.stringify(slot.core.sessionState())
          void captureBeforeInput(slot, conversationId).then(() => {
            if (JSON.stringify(slot.core.sessionState()) !== session) throw Error('對話已變更，訊息未送出')
            slot.core.userInput(text)
          }).catch(error => deps.logError(asError(error, '訊息未送出')))
        } else slot.core.userInput(text)
      })
    })

  const onApprovalReply = (_event: unknown, raw: unknown): void =>
    guard(IPC.approvalReply, () => {
      const reply = parseApprovalReply(raw)
      if (reply === null) {
        deps.logError(rejectPayload(IPC.approvalReply, raw))
        return
      }
      const owner = approvals.get(reply.requestId)
      const slot = owner === undefined ? undefined : slots.get(owner.conversationId)
      if (slot === undefined) {
        deps.logError(new Error(`${IPC.approvalReply}：找不到 requestId ${reply.requestId}，可能已逾時`))
        return
      }
      slot.core.approvalReply(reply.requestId, reply.decision)
    })

  const onHandoffDone = (_event: unknown, raw: unknown): void =>
    guard(IPC.handoffDone, () => {
      const payload = parseHandoffDone(raw)
      if (payload === null) {
        deps.logError(rejectPayload(IPC.handoffDone, raw))
        return
      }
      withActive(IPC.handoffDone, (slot) => slot.core.handoffDone(payload.toolUseId))
    })

  const onIntentStartNew = (): void =>
    guard(IPC.intentStartNew, () => {
      withActive(IPC.intentStartNew, (slot, conversationId) => {
        const tab = findProject(deps.projects.state(), slot.projectId)?.tabs.find(t => t.id === conversationId)
        if (tab?.chefTaskId) { deps.projects.update(state => openConversationTab(state, slot.projectId, { tabId: deps.projects.newId(), threadId: deps.projects.newId(), provider: tab.provider ?? 'claude' }, deps.projects.now() + 1)); return }
        deps.projects.update((state) =>
          startThread(state, slot.projectId, conversationId, deps.projects.newId(), deps.projects.now()),
        )
        // 開新對話等於這一場結束:未決的同伴問答收掉,分頁還在所以登錄留著,
        // 但上一場的最後一句不該再當成這個對話「最近說的話」。
        deps.peer?.conversationEnded(conversationId)
        lastUserText = new Map([...lastUserText].filter(([id]) => id !== conversationId))
        slot.core.startNew()
      })
    })

  const onIntentOpenHistory = (_event: unknown, raw: unknown): void =>
    guard(IPC.intentOpenHistory, () => {
      const payload = parseIntentOpenHistory(raw)
      if (payload === null) {
        deps.logError(rejectPayload(IPC.intentOpenHistory, raw))
        return
      }
      withActive(IPC.intentOpenHistory, (slot, conversationId) => {
        const entry = findProject(deps.projects.state(), slot.projectId)
        const tab = entry?.tabs.find((t) => t.id === conversationId)
        const provider = tab?.provider ?? 'claude'
        const focusedAt = Math.max(deps.projects.now(), ...(entry?.tabs.map(t => t.lastFocusedAt + 1) ?? []))
        // 歷史導覽不是停止指令；已開啟的 session 直接聚焦，尤其不能重開自己。
        const existing = entry === undefined ? undefined : conversationTabs(entry).find(candidate => {
          if ((candidate.provider ?? 'claude') !== provider) return false
          return currentSessionId(entry, candidate) === payload.sessionId
        })
        if (existing !== undefined) {
          if (existing.id !== conversationId) deps.projects.update(state => focusTab(state, slot.projectId, existing.id, focusedAt))
          return
        }
        const link = linkFor(provider, slot.rootPath, payload.sessionId,
          TRANSCRIPT[provider] === 'claude' ? deps.sessions.cwdOf(payload.sessionId) : undefined)
        if (slot.core.isBusy() || tab?.chefTaskId) {
          const tabId = deps.projects.newId()
          const threadId = deps.projects.newId()
          const historyThreadId = deps.projects.newId()
          const now = focusedAt
          deps.projects.update(state => focusTab(pointConversationAt(
            openConversationTab(state, slot.projectId, { tabId, threadId, provider,
              ...(tab?.worktreePath === undefined ? {} : { worktreePath: tab.worktreePath }) }, now),
            slot.projectId, tabId, link, historyThreadId, now), slot.projectId, tabId, now))
          return
        }
        deps.projects.update((state) =>
          pointConversationAt(state, slot.projectId, conversationId, link, deps.projects.newId(), deps.projects.now()),
        )
        deps.peer?.conversationEnded(conversationId)
        slot.core.openHistory(payload.sessionId)
      })
    })

  const openHistoryConversation = (request: OpenParticipantInput): void => {
    const state = deps.projects.state()
    const existing = state.projects.flatMap(project => conversationTabs(project)
      .filter(tab => {
        if ((tab.provider ?? 'claude') !== request.provider) return false
        const current = currentSessionId(project, tab)
        return current === request.sessionId || (current === undefined && lastSessionId(project, tab.id) === request.sessionId)
      })
      .map(tab => ({ projectId: project.id, tab })))
      .at(0)
    if (existing !== undefined) {
      const project = findProject(state, existing.projectId)!
      const focusedAt = Math.max(deps.projects.now(), ...project.tabs.map(tab => tab.lastFocusedAt + 1))
      deps.projects.update(current => setActive(
        focusTab(labelConversationTab(current, project.id, existing.tab.id, request.tabLabel), project.id, existing.tab.id, focusedAt),
        project.id,
        focusedAt,
      ))
      return
    }

    const project = findProject(state, request.projectId)
    if (project === undefined) throw new Error('找不到這個專案')
    const focusedAt = Math.max(deps.projects.now(), ...project.tabs.map(tab => tab.lastFocusedAt + 1))
    const tabId = deps.projects.newId()
    const threadId = deps.projects.newId()
    const historyThreadId = deps.projects.newId()
    const link = linkFor(request.provider, project.rootPath, request.sessionId,
      TRANSCRIPT[request.provider] === 'claude' ? deps.sessions.cwdOf(request.sessionId) : undefined)
    // 先建空白 core，再綁定歷史並呼叫 openHistory，避免初始 session 與明確載入重複。
    deps.projects.update(current => {
      const opened = openConversationTab(current, request.projectId, { tabId, threadId, provider: request.provider }, focusedAt)
      const named = labelConversationTab(opened, request.projectId, tabId, request.tabLabel)
      return setActive(focusTab(named, request.projectId, tabId, focusedAt), request.projectId, focusedAt)
    })
    const slot = slotFor(tabId)
    if (slot === undefined) throw new Error('無法建立歷史對話分頁')
    deps.projects.update(current => pointConversationAt(
      current, request.projectId, tabId, link, historyThreadId, focusedAt,
    ))
    deps.peer?.conversationEnded(tabId)
    slot.core.openHistory(request.sessionId)
  }

  const onPeerAnswer = (_event: unknown, raw: unknown): void =>
    guard(IPC.peerAnswer, () => {
      const payload = parsePeerAction(raw)
      if (payload === null || payload.text === undefined) {
        deps.logError(rejectPayload(IPC.peerAnswer, raw))
        return
      }
      const text = payload.text
      deps.peer?.answerAsUser(payload.questionId, text)
        .catch((cause: unknown) => deps.logError(asError(cause, `${IPC.peerAnswer}(${payload.questionId})`)))
    })

  const onPeerCancel = (_event: unknown, raw: unknown): void =>
    guard(IPC.peerCancel, () => {
      const payload = parsePeerAction(raw)
      if (payload === null) {
        deps.logError(rejectPayload(IPC.peerCancel, raw))
        return
      }
      deps.peer?.cancelAsUser(payload.questionId)
        .catch((cause: unknown) => deps.logError(asError(cause, `${IPC.peerCancel}(${payload.questionId})`)))
    })

  // ---- invoke 通道 ----

  const onSessionList = async (_event: unknown, raw: unknown): Promise<readonly SessionSummary[]> => {
    const scope = parseSessionListScope(raw)
    if (scope === null) {
      const error = rejectPayload(IPC.sessionList, raw)
      deps.logError(error)
      throw error
    }
    try {
      const sources: Readonly<Record<Provider, { list(cwd?: string): Promise<readonly SessionSummary[]> }>> = {
        claude: deps.sessions, codex: deps.codexCatalog, grok: deps.grokCatalog,
      }
      const source = sources[scope.provider ?? 'claude']
      if (scope.projectId === null) return await source.list()
      const rootPath = deps.projects.rootPathOf(scope.projectId)
      // 過濾交給 store:在這裡過濾的話,拿到的已經是全域最新 100 筆砍過的結果,
      // 冷門專案的 Recents 會是空的(RESULTS-08 第 12 項的「本專案 2 筆」就是這樣來的)。
      return rootPath === undefined ? [] : await source.list(rootPath)
    } catch (err) {
      const error = asError(err, IPC.sessionList)
      deps.logError(error)
      throw error
    }
  }

  /** renderer 剛載入(或重載)時呼叫:先把 active 專案的對話重送一遍,再給它專案清單。 */
  const onProjectsGet = (): ProjectsView => {
    try {
      activeSlot()?.core.replay()
      return composeView()
    } catch (err) {
      // 與 session:list 同一個出口:靜默 reject 會讓 renderer 停在空畫面而沒有人知道原因。
      const error = asError(err, IPC.projectsGet)
      deps.logError(error)
      throw error
    }
  }

  /** 未決的同伴提問整份重推。與 projects:state 同一個做法:整份推,不做增量。 */
  const pushPeer = (): void => {
    if (deps.peer === undefined) return
    const payload: PeerStatePayload = { pending: deps.peer.pending() }
    sendBestEffort(IPC.peerState, payload)
  }

  const offPeerChange = deps.peer?.onChange(() => guard(IPC.peerState, pushPeer))

  const onPeerGet = (): PeerStatePayload => ({ pending: deps.peer?.pending() ?? [] })

  const onTerminalEndpoint = (event: { sender: unknown }): TerminalEndpoint => {
    if (event.sender !== deps.webContents) throw new Error('不接受此來源的終端機 endpoint 請求')
    return { port: deps.terminalPort!, token: deps.terminalToken! }
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    unsubscribe()
    offPeerChange?.()
    if (deps.peer !== undefined) {
      ipcMain.removeListener(IPC.peerAnswer, onPeerAnswer)
      ipcMain.removeListener(IPC.peerCancel, onPeerCancel)
    }
    ipcMain.removeListener(IPC.userInput, onUserInput)
    ipcMain.removeListener(IPC.approvalReply, onApprovalReply)
    ipcMain.removeListener(IPC.intentStartNew, onIntentStartNew)
    ipcMain.removeListener(IPC.intentOpenHistory, onIntentOpenHistory)
    ipcMain.removeListener(IPC.handoffDone, onHandoffDone)
    ipcMain.removeHandler(CONVERSATION_TOOLS_CHANNEL)
    ipcMain.removeHandler(IPC.sessionList)
    ipcMain.removeHandler(IPC.approvalsGet)
    ipcMain.removeHandler(IPC.peerGet)
    ipcMain.removeHandler(IPC.projectsGet)
    if (deps.terminalPort !== undefined && deps.terminalToken !== undefined) ipcMain.removeHandler(IPC.terminalEndpoint)
    // allSettled:一個專案收尾失敗不能讓其他專案的 runtime 留著沒拆。
    const results = await Promise.allSettled([
      ...[...closing.values()].map(entry => entry.task),
      ...[...slots].map(([id, slot]) => closeSlot(id, slot)),
    ])
    for (const result of results) {
      if (result.status === 'rejected') deps.logError(asError(result.reason, 'dispose'))
    }
    for (const id of registeredIds) unregisterPeer(id)
    slots.clear()
  }

  if (deps.peer !== undefined) {
    ipcMain.on(IPC.peerAnswer, onPeerAnswer)
    ipcMain.on(IPC.peerCancel, onPeerCancel)
  }
  ipcMain.handle(CONVERSATION_TOOLS_CHANNEL, onConversationTools)
  ipcMain.on(IPC.userInput, onUserInput)
  ipcMain.on(IPC.approvalReply, onApprovalReply)
  ipcMain.on(IPC.intentStartNew, onIntentStartNew)
  ipcMain.on(IPC.intentOpenHistory, onIntentOpenHistory)
  ipcMain.on(IPC.handoffDone, onHandoffDone)
  ipcMain.handle(IPC.sessionList, onSessionList)
  ipcMain.handle(IPC.approvalsGet, () => [...approvals.values()])
  ipcMain.handle(IPC.peerGet, onPeerGet)
  ipcMain.handle(IPC.projectsGet, onProjectsGet)
  if (deps.terminalPort !== undefined && deps.terminalToken !== undefined) ipcMain.handle(IPC.terminalEndpoint, onTerminalEndpoint)

  syncPeers(deps.projects.state())
  const initialId = foregroundConversationId(deps.projects.state())
  if (initialId === null) deps.browser?.show(null)
  switchTo(initialId)
  // 建立時就推送初始快照,讓擋睡眠端不必等到第一次忙碌事件。
  pushProjects()

  const startChefWorker = async (request: WorkerRequest): Promise<WorkerHandle> => {
    if (disposed || !deps.chef?.runnable(request.id)) throw Error('主廚執行已取消')
    const project = findProject(deps.projects.state(), request.projectId)
    if (!project || realpathSync.native(project.rootPath) !== request.cwd) throw Error('主廚專案工作目錄已變更')
    const previousFocus = foregroundConversationId(deps.projects.state())
    const shouldFocus = !request.previousWorkerId || previousFocus === request.previousWorkerId
    deps.projects.update(state => {
      const added = openConversationTab(state, request.projectId, { tabId: request.id, threadId: deps.projects.newId(), provider: request.provider }, deps.projects.now())
      const named = { ...added, projects: added.projects.map(p => p.id === request.projectId ? { ...p, tabs: p.tabs.map(t => t.id === request.id ? { ...t, chefTaskId: request.taskId, label: request.tabLabel, customLabel: request.tabLabel } : t) } : p) }
      return !shouldFocus && previousFocus ? focusTab(named, findProjectByTab(named, previousFocus)!.id, previousFocus, deps.projects.now() + 1) : setActive(focusTab(named, request.projectId, request.id, deps.projects.now() + 1), request.projectId, deps.projects.now())
    })
    const slot = slotFor(request.id)
    if (!slot) throw Error('無法建立主廚工作者')
    const stop = async () => {
      await startClosing(request.id, slot)
      const deadline = Date.now() + 2500
      while (slot.core.shutdownConfirmed?.() !== true && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      const confirmed = slot.core.shutdownConfirmed?.() === true
      if (confirmed) deps.projects.update(state => closeChefWorkerTab(state, request.projectId, request.id, deps.projects.now()))
      return confirmed
    }
    try {
      await captureBeforeInput(slot, request.id)
      if (!deps.chef.runnable(request.id)) { await stop(); throw Error('主廚執行已取消') }
      slot.core.userInput(request.prompt)
      return { stop }
    } catch (error) { const confirmed = await stop(); if (!confirmed) throw Object.assign(new Error('工作者啟動失敗，且停止尚未確認', { cause: error }), { shutdownConfirmed: false }); throw error }
  }
  const hasBusyWork = (cwd: string) => [...slots.entries()].some(([id, slot]) => {
    if (!slot.core.isBusy()) return false
    const other = diffContext(slot, id).cwd
    const prefix = (a: string, b: string) => b === a || b.startsWith(a.endsWith('/') ? a : `${a}/`)
    return prefix(cwd, other) || prefix(other, cwd)
  })
  /**
   * 忙碌狀態與送訊息都只看已經建起來的 slot:沒有 slot 就表示這個對話還沒跑過,
   * 當然不忙,也不該送。跟 slotFor 不一樣,這裡絕不能用衝突訊息當第一句 prompt
   * 憑空開一個新的 agent session——那個 session 沒人 activate/deactivate,是
   * 背景孤兒 query(合併規格 §4:分頁沒開過就沒有 agent 可以通知)。
   */
  const conversationFor = (projectId: string, tabId: string): { isBusy(): boolean; userInput(text: string): void } | undefined => {
    const owner = findProject(deps.projects.state(), projectId)
    const tab = owner?.tabs.find((t) => t.id === tabId && t.contentType === 'conversation')
    if (owner === undefined || tab === undefined) return undefined
    // 主廚管理中的工作目錄跟 peer 那條路一樣要先過 guard:那時這個對話不歸使用者調度,
    // 算忙碌,訊息也不送(這裡不 throw,合併那邊只需要知道忙不忙)。
    const blocked = (): string | undefined => deps.chef?.guard(tabId, owner.rootPath)
    return {
      isBusy: () => Boolean(blocked()) || (slots.get(tabId)?.core.isBusy() ?? false),
      userInput: (text: string) => { if (blocked() === undefined) slots.get(tabId)?.core.userInput(text) },
    }
  }
  const deliverToManaged = (projectId: string, conversationId: string, text: string): DeliverOutcome => {
    const owner = findProject(deps.projects.state(), projectId)
    const tab = owner?.tabs.find((t) => t.id === conversationId && t.contentType === 'conversation')
    if (owner === undefined || tab === undefined) return { kind: 'missing' }
    const slot = slots.get(conversationId)
    if (slot === undefined) return { kind: 'missing' }
    const busy = slot.core.isBusy()
    slot.core.userInput(text)
    if (currentId !== conversationId) slot.core.deactivate()
    return { kind: 'delivered', busy }
  }
  return { dispose, disposeConversation, startChefWorker, openHistoryConversation, hasBusyWork, conversationFor, deliverToManaged }
}
