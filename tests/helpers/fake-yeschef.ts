import { act } from '@testing-library/react'
import type { Projects } from '../../src/renderer/hooks/useProjects.js'
import type { PreviewReadResult, PeerStatePayload, EventsBatchPayload, SessionStatePayload, ApprovalAskPayload, ApprovalReplyPayload, ApprovalSettledPayload, SessionSummary, YesChefApi } from '../../src/shared/ipc.js'
import type { BrowserCommandResult, BrowserSessionEntry, BrowserStatePayload } from '../../src/shared/browser-ipc.js'
import type { GroupMessagesPayload } from '../../src/shared/group.js'
import type { ProjectsView, ProjectView, TabEntry } from '../../src/shared/projects.js'
import type { SessionState } from '../../src/shared/session-state.js'
import type { Event } from '../../src/shared/events.js'

/**
 * 假的 YesChefApi。preload 的真品要 Electron,這裡只需要「訂閱得到、送得出去」
 * 這兩件事,所以自己拿幾個 Set 當事件來源,順便可以斷言訂閱有沒有解除。
 * `calls` 記所有 send 類呼叫(`名稱:引數`),測試斷言接線用。
 */
export interface FakeYesChef {
  readonly api: YesChefApi
  readonly replies: ApprovalReplyPayload[]
  readonly calls: string[]
  emitPeer(state: PeerStatePayload): void
  emitAsk(ask: ApprovalAskPayload): void
  emitSettled(settled: ApprovalSettledPayload): void
  emitState(state: SessionState, conversationId?: string): void
  emitEvents(events: readonly Event[], conversationId?: string): void
  emitProjects(view: ProjectsView): void
  emitBrowserState(state: BrowserStatePayload): void
  emitBrowserSessions(list: readonly BrowserSessionEntry[]): void
  emitGroup(payload: GroupMessagesPayload): void
  /**
   * 不包 `act()` 的送法。`emit*` 每一則之後都 flush 完 render 與 effect,真的 IPC 沒有
   * 這個保證;要驗「兩則訊息落在同一批更新裡」的先後,就用 `raw`,由測試自己包一層 `act`。
   */
  readonly raw: {
    projects(view: ProjectsView): void
    ask(ask: ApprovalAskPayload): void
    settled(settled: ApprovalSettledPayload): void
  }
  listenerCounts(): { ask: number; settled: number; state: number }
  setBrowserCommandResult(next: BrowserCommandResult): void
}

export const DEFAULT_CONVERSATION = 'p-1-conv'

export const EMPTY_PROJECTS: ProjectsView = { projects: [], activeId: null }

export function projectView(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name: id,
    rootPath: `/p/${id}`,
    available: true,
    pendingApproval: false,
    pendingTabIds: [],
    busyTabIds: [],
    busySince: {},
    producingTabIds: [],
    activeTabId: `${id}-conv`,
    tabs: [
      { id: `${id}-conv`, contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: `${id}-th` },
    ],
    threads: [{ id: `${id}-th`, sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }],
    ...over,
  }
}

export function terminalTab(id: string, label: string, sortOrder: number, command?: string): TabEntry {
  const base = { id, contentType: 'terminal' as const, label, customLabel: null, sortOrder, lastFocusedAt: sortOrder }
  return command === undefined ? base : { ...base, command }
}

export const ONE_PROJECT: ProjectsView = {
  activeId: 'p-1',
  projects: [projectView('p-1', { name: 'demo', rootPath: '/Users/x/Projects/demo' })],
}

export function createFakeYesChef(
  opts: { readonly sessions?: readonly SessionSummary[]; readonly projects?: ProjectsView; readonly readPreview?: PreviewReadResult } = {}
): FakeYesChef {
  const peerListeners = new Set<(state: PeerStatePayload) => void>()
  const askListeners = new Set<(ask: ApprovalAskPayload) => void>()
  const settledListeners = new Set<(settled: ApprovalSettledPayload) => void>()
  const stateListeners = new Set<(p: SessionStatePayload) => void>()
  const eventListeners = new Set<(p: EventsBatchPayload) => void>()
  const projectListeners = new Set<(view: ProjectsView) => void>()
  const browserStateListeners = new Set<(state: BrowserStatePayload) => void>()
  const browserSessionsListeners = new Set<(sessions: readonly BrowserSessionEntry[]) => void>()
  const groupListeners = new Set<(payload: GroupMessagesPayload) => void>()
  const replies: ApprovalReplyPayload[] = []
  const calls: string[] = []
  // getProjects 回「目前這一份」而不是建構時那一份:App 測試 render 之後立刻 emitProjects,
  // invoke 的 promise 在下一個 microtask 才 resolve,這時要拿到 emit 過的 view,不能把它蓋回去。
  let current: ProjectsView = opts.projects ?? EMPTY_PROJECTS
  let browserCommandResult: BrowserCommandResult = { ok: true }

  const on = <T,>(set: Set<(v: T) => void>) => (cb: (v: T) => void) => {
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  const api: YesChefApi = {
    manageChef: async () => ({ kind: 'state', state: { tasks: [], models: [], notices: [] } }),
    conversationTools: async request => { if (request.action === 'send') { calls.push(`sendInput:${request.text}`); return { kind: 'sent' } } return { kind: 'error', message: '測試未設定對話工具' } },
    managePermissions: async () => ({ kind: 'state', state: { revision: 0, paused: false, policies: [] }, audit: [] }),
    manageSkills: async () => ({ kind: 'state', state: { revision: null, skills: [] } }),
    manageTestMachines: async () => ({ kind: 'state', revision: 0, machines: [] }),
    manageErrorIntake: async () => ({ kind: 'settings', settings: { host: '', port: 3306, database: '', tls: true, adminUsername: '', hasAdminPassword: false, hasAppPassword: false, schemaVersion: null, packageSource: '@yeschef/error-intake' } }),
    manageGroup: async () => ({ kind: 'state', messages: [], threads: [] }),
    onGroupMessages: on(groupListeners),
    openGroup: (id) => { calls.push(`openGroup:${id}`) },
    worktreeMerge: async () => ({ kind: 'error', message: '測試未設定合併' }),
    translate: () => Promise.resolve({ kind: 'rejected', message: 'fake' }),
    readPreview: (payload) => {
      calls.push(`readPreview:${payload.projectId}:${payload.path}`)
      return Promise.resolve({ ...(opts.readPreview ?? { kind: 'rejected', message: 'fake' }) })
    },
    setBrowserBounds: (rect) => { calls.push(`setBrowserBounds:${rect === null ? 'null' : JSON.stringify(rect)}`) },
    browserCommand: (command) => {
      calls.push(`browserCommand:${JSON.stringify(command)}`)
      return Promise.resolve(browserCommandResult)
    },
    getBrowser: () => Promise.resolve({ states: [], sessions: [] }),
    onBrowserState: on(browserStateListeners),
    onBrowserSessions: on(browserSessionsListeners),
    getApprovals: () => Promise.resolve([]),
    getPeer: () => Promise.resolve({ pending: [] }),
    onPeerState: on(peerListeners),
    answerPeerAsUser: (p) => { calls.push(`answerPeerAsUser:${p.questionId}:${p.text}`) },
    cancelPeer: (p) => { calls.push(`cancelPeer:${p.questionId}`) },
    onEvents: on(eventListeners),
    onApprovalAsk: on(askListeners),
    onApprovalSettled: on(settledListeners),
    onSessionState: on(stateListeners),
    onProjects: on(projectListeners),
    sendInput: (text) => { calls.push(`sendInput:${text}`) },
    replyApproval: (reply) => { replies.push(reply) },
    listSessions: () => Promise.resolve(opts.sessions ?? []),
    startNew: () => { calls.push('startNew') },
    openHistory: (sessionId) => { calls.push(`openHistory:${sessionId}`) },
    handoffDone: (toolUseId) => { calls.push(`handoffDone:${toolUseId}`) },
    terminalEndpoint: () => Promise.resolve({ port: 1, token: 'test-token' }),
    getProjects: () => Promise.resolve().then(() => current),
    addProject: () => { calls.push('addProject'); return Promise.resolve({ kind: 'cancelled' }) },
    relocateProject: (id) => { calls.push(`relocateProject:${id}`); return Promise.resolve({ kind: 'cancelled' }) },
    removeProject: (id) => { calls.push(`removeProject:${id}`) },
    openConversation: (projectId, provider) => { calls.push(`openConversation:${projectId}:${provider}`) },
    activateProject: (id) => { calls.push(`activateProject:${id}`) },
    openTab: (p) => { calls.push(`openTab:${p.projectId}:${p.label}:${p.command ?? '-'}`) },
    closeTab: (p) => { calls.push(`closeTab:${p.projectId}:${p.tabId}`) },
    activateTab: (p) => { calls.push(`activateTab:${p.projectId}:${p.tabId}`) },
  }

  const rawEmit = <T,>(set: Set<(v: T) => void>) => (value: T) => {
    for (const l of set) l(value)
  }

  const emit = <T,>(set: Set<(v: T) => void>) => (value: T) => {
    act(() => {
      rawEmit(set)(value)
    })
  }

  const rawProjects = (view: ProjectsView): void => {
    current = view
    rawEmit(projectListeners)(view)
  }

  return {
    api,
    replies,
    calls,
    emitPeer: emit(peerListeners),
    emitAsk: emit(askListeners),
    emitSettled: emit(settledListeners),
    emitState: (state, conversationId = DEFAULT_CONVERSATION) => {
      act(() => { rawEmit(stateListeners)({ conversationId, state }) })
    },
    emitEvents: (events, conversationId = DEFAULT_CONVERSATION) => {
      act(() => { rawEmit(eventListeners)({ conversationId, events }) })
    },

    emitProjects: (view) => {
      act(() => {
        rawProjects(view)
      })
    },
    emitBrowserState: emit(browserStateListeners),
    emitBrowserSessions: emit(browserSessionsListeners),
    emitGroup: emit(groupListeners),
    raw: { projects: rawProjects, ask: rawEmit(askListeners), settled: rawEmit(settledListeners) },
    listenerCounts: () => ({ ask: askListeners.size, settled: settledListeners.size, state: stateListeners.size }),
    setBrowserCommandResult: (next) => { browserCommandResult = next },
  }
}

/** 直接餵給 ProjectBar／LeftPane 的假 `Projects`,動作都記進 calls。 */
export function fakeProjects(view: ProjectsView, over: Partial<Projects> = {}): { projects: Projects; calls: string[] } {
  const calls: string[] = []
  const projects: Projects = {
    view,
    loaded: true,
    active: view.activeId === null ? undefined : view.projects.find((p) => p.id === view.activeId),
    error: undefined,
    activate: (id) => { calls.push(`activate:${id}`) },
    add: () => { calls.push('add'); return Promise.resolve() },
    remove: (id) => { calls.push(`remove:${id}`) },
    relocate: (id) => { calls.push(`relocate:${id}`); return Promise.resolve() },
    openTab: (label, command) => { calls.push(`openTab:${label}:${command ?? '-'}`) },
    closeTab: (tabId) => { calls.push(`closeTab:${tabId}`) },
    openConversation: (provider) => { calls.push(`openConversation:${provider ?? 'claude'}`) },
    openGroup: () => { calls.push('openGroup') },
    activateTab: (tabId) => { calls.push(`activateTab:${tabId}`) },
    ...over,
  }
  return { projects, calls }
}
