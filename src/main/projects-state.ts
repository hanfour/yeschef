/**
 * `ProjectsState` 的純 reducer(規格 §4.1)。每個函式回新物件,不改傳入的 state;
 * 沒有東西可改時回傳原 state(呼叫端可用 `===` 判斷要不要存檔)。
 */
import { basename } from 'node:path'
import {
  GROUP_TAB_LABEL,
  PROVIDER_LABELS,
  type Provider,
  type ProjectEntry,
  type ProjectsState,
  type SessionLink,
  type TabEntry,
  type ThreadEntry,
  sortTabs,
} from '../shared/projects.js'

export interface NewProjectInput {
  readonly isGitRepo?: boolean
  readonly id: string
  readonly rootPath: string
  readonly conversationTabId: string
  readonly threadId: string
  readonly now: number
}

function newThread(id: string, now: number, sessions: readonly SessionLink[] = []): ThreadEntry {
  return { id, sessions, handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: now }
}

export function createProjectEntry(input: NewProjectInput): ProjectEntry {
  return {
    ...(input.isGitRepo === undefined ? {} : { isGitRepo: input.isGitRepo }),
    id: input.id,
    rootPath: input.rootPath,
    name: basename(input.rootPath),
    addedAt: input.now,
    lastOpenedAt: input.now,
    tabs: [{
      id: input.conversationTabId,
      contentType: 'conversation',
      label: PROVIDER_LABELS.claude.tabTitle,
      customLabel: null,
      sortOrder: 0,
      lastFocusedAt: input.now,
      threadId: input.threadId,
      provider: 'claude',
    }],
    lastUrl: null,
    threads: [newThread(input.threadId, input.now)],
  }
}

export function findProject(state: ProjectsState, id: string): ProjectEntry | undefined {
  return state.projects.find((p) => p.id === id)
}

/** 套用到一個專案;找不到或 fn 回原 entry 時回原 state。 */
function updateProject(state: ProjectsState, id: string, fn: (p: ProjectEntry) => ProjectEntry): ProjectsState {
  const current = findProject(state, id)
  if (current === undefined) return state
  const next = fn(current)
  if (next === current) return state
  return { ...state, projects: state.projects.map((p) => (p.id === id ? next : p)) }
}

export function addProject(state: ProjectsState, entry: ProjectEntry): ProjectsState {
  return { ...state, projects: [...state.projects, entry], activeId: state.activeId ?? entry.id }
}

export function removeProject(state: ProjectsState, id: string): ProjectsState {
  if (findProject(state, id) === undefined) return state
  const projects = state.projects.filter((p) => p.id !== id)
  const activeId = state.activeId === id ? (projects[0]?.id ?? null) : state.activeId
  return { ...state, projects, activeId }
}

export function relocateProject(state: ProjectsState, id: string, rootPath: string, isGitRepo?: boolean): ProjectsState {
  return updateProject(state, id, (p) => ({ ...p, rootPath, name: basename(rootPath), isGitRepo }))
}

export function setActive(state: ProjectsState, id: string, now: number): ProjectsState {
  const next = updateProject(state, id, (p) => ({ ...p, lastOpenedAt: now }))
  return next === state ? state : { ...next, activeId: id }
}

function mostRecent(tabs: readonly TabEntry[]): TabEntry | undefined {
  return tabs.reduce<TabEntry | undefined>(
    (best, t) => (best === undefined || t.lastFocusedAt > best.lastFocusedAt ? t : best),
    undefined,
  )
}

/** 一個專案的對話分頁,依 sortOrder。 */
export function conversationTabs(entry: ProjectEntry): readonly TabEntry[] {
  return sortTabs(entry.tabs.filter((t) => t.contentType === 'conversation'))
}

/** 前景對話(D2 規格 §1):最近聚焦的對話分頁。schema 保證至少一個。 */
export function activeConversationId(entry: ProjectEntry): string {
  const tab = mostRecent(conversationTabs(entry))
  if (tab === undefined) throw new Error(`專案 ${entry.id} 沒有對話分頁`)
  return tab.id
}

export function activeTabId(entry: ProjectEntry): string {
  return mostRecent(entry.tabs)?.id ?? activeConversationId(entry)
}

export function foregroundConversationId(state: ProjectsState): string | null {
  const entry = state.activeId === null ? undefined : findProject(state, state.activeId)
  return entry === undefined ? null : activeConversationId(entry)
}

export function findProjectByTab(state: ProjectsState, tabId: string): ProjectEntry | undefined {
  return state.projects.find((p) => p.tabs.some((t) => t.id === tabId))
}

/** prev 有、next 沒有的專案 id。測試機規格 §3.1:專案被移除時一併刪掉它的帳密檔。 */
export function removedProjectIds(prev: ProjectsState, next: ProjectsState): readonly string[] {
  const nextIds = new Set(next.projects.map((p) => p.id))
  return prev.projects.map((p) => p.id).filter((id) => !nextIds.has(id))
}

/**
 * 這個對話自己的工作目錄:有 worktree 就只到 worktree,沒有才是專案根目錄。
 * 每對話瀏覽器的 file:// 範圍(規格 §4.4)跟著這個,不是「前景對話」或整個專案 rootPath——
 * worktree 底下的對話不該看得到整個專案根目錄,更不該看到其他 worktree。
 * 找不到擁有這個分頁的專案時回 undefined。
 */
export function conversationDir(state: ProjectsState, conversationId: string): string | undefined {
  const project = findProjectByTab(state, conversationId)
  if (project === undefined) return undefined
  const tab = project.tabs.find((t) => t.id === conversationId)
  return tab?.worktreePath ?? project.rootPath
}

export interface NewTabInput {
  readonly id: string
  readonly label: string
  readonly command?: string
}

function nextSortOrder(p: ProjectEntry): number {
  return Math.max(...p.tabs.map((t) => t.sortOrder)) + 1
}

export function openTab(state: ProjectsState, projectId: string, tab: NewTabInput, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const entry: TabEntry = {
      id: tab.id,
      contentType: 'terminal',
      label: tab.label,
      customLabel: null,
      ...(tab.command === undefined ? {} : { command: tab.command }),
      sortOrder: nextSortOrder(p),
      lastFocusedAt: now,
    }
    return { ...p, tabs: [...p.tabs, entry] }
  })
}

/**
 * 群組分頁(群組規格 §8)。一個專案最多一個:已經有就只把焦點移過去,不再開第二個。
 * 不帶 threadId 與 provider,所以 `conversationTabs` 與主廚、peer 的路徑都碰不到它。
 */
export function openGroupTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const existing = p.tabs.find((t) => t.contentType === 'group')
    if (existing !== undefined) {
      return { ...p, tabs: p.tabs.map((t) => (t.id === existing.id ? { ...t, lastFocusedAt: now } : t)) }
    }
    const entry: TabEntry = {
      id: tabId,
      contentType: 'group',
      label: GROUP_TAB_LABEL,
      customLabel: null,
      sortOrder: nextSortOrder(p),
      lastFocusedAt: now,
    }
    return { ...p, tabs: [...p.tabs, entry] }
  })
}

export interface NewConversationInput {
  readonly worktreePath?: string
  readonly tabId: string
  readonly threadId: string
  /** 缺就是 'claude'。 */
  readonly provider?: Provider
}

function nextConversationLabel(p: ProjectEntry, provider: Provider): string {
  const base = PROVIDER_LABELS[provider].tabTitle
  const sameProvider = conversationTabs(p).filter((t) => (t.provider ?? 'claude') === provider)
  if (sameProvider.length === 0) return base
  const used = sameProvider.map((t) => {
    if (t.label === base) return 1
    const m = new RegExp(`^${base} (\\d+)$`).exec(t.label)
    return m === null ? 1 : Number(m[1])
  })
  return `${base} ${Math.max(...used) + 1}`
}

/** 規格 §3:新增一個 conversation 分頁與一條空 thread;新開的立刻成為 active 分頁。 */
export function openConversationTab(
  state: ProjectsState,
  projectId: string,
  input: NewConversationInput,
  now: number,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const provider = input.provider ?? 'claude'
    const entry: TabEntry = {
      id: input.tabId,
      contentType: 'conversation',
      label: nextConversationLabel(p, provider),
      customLabel: null,
      sortOrder: nextSortOrder(p),
      lastFocusedAt: now,
      threadId: input.threadId,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      provider,
    }
    return { ...p, tabs: [...p.tabs, entry], threads: [...p.threads, newThread(input.threadId, now)] }
  })
}

/** 沒有分頁指到、也沒有 session 的 thread 回收掉;其餘保留。 */
function pruneThreads(tabs: readonly TabEntry[], threads: readonly ThreadEntry[]): readonly ThreadEntry[] {
  const referenced = new Set(tabs.map((t) => t.threadId))
  return threads.filter((t) => t.sessions.length > 0 || referenced.has(t.id))
}

/**
 * 關分頁。終端分頁照關;對話分頁可關,但一個專案至少留一個(規格 §3)。
 * 關掉的是 active 分頁時,焦點回到剩下的分頁裡最近聚焦的對話分頁(沿用 D:終端關掉回對話)。
 */
export function closeTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const target = p.tabs.find((t) => t.id === tabId)
    if (target === undefined || target.contentType === 'group') return p
    if (target.contentType === 'conversation' && conversationTabs(p).length <= 1) return p
    const wasFocused = activeTabId(p) === tabId
    const remaining = p.tabs.filter((t) => t.id !== tabId)
    const fallback = mostRecent(remaining.filter((t) => t.contentType === 'conversation'))?.id
    const tabs = remaining.map((t) => (wasFocused && t.id === fallback ? { ...t, lastFocusedAt: now } : t))
    return { ...p, tabs, threads: pruneThreads(tabs, p.threads) }
  })
}

/** 確認停止後關閉工作者分頁;前景與最後一個對話分頁沿用既有保護。 */
export function closeChefWorkerTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  const project = findProject(state, projectId)
  const tab = project?.tabs.find((entry) => entry.id === tabId)
  if (project === undefined || tab?.contentType !== 'conversation' || tab.chefTaskId === undefined) return state
  if (state.activeId === projectId && activeTabId(project) === tabId) return state
  return closeTab(state, projectId, tabId, now)
}

/** 啟動或切離前景時清除已結束及找不到 attempt 的背景工作者分頁。 */
export function closeInactiveChefTabs(
  state: ProjectsState,
  runningWorkersByTask: ReadonlyMap<string, ReadonlySet<string>>,
  now: number,
): ProjectsState {
  let next = state
  for (const project of state.projects) {
    for (const tab of project.tabs) {
      if (tab.chefTaskId !== undefined && !runningWorkersByTask.get(tab.chefTaskId)?.has(tab.id)) {
        next = closeChefWorkerTab(next, project.id, tab.id, now)
      }
    }
  }
  return next
}

export function focusTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    if (!p.tabs.some((t) => t.id === tabId)) return p
    return { ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, lastFocusedAt: now } : t)) }
  })
}

export function setLastUrl(state: ProjectsState, projectId: string, url: string | null): ProjectsState {
  return updateProject(state, projectId, (p) => (p.lastUrl === url ? p : { ...p, lastUrl: url }))
}

/** 每對話瀏覽器規格 §4.6。值沒變回傳同一個 state,service 才不會多排一次存檔。 */
export function setTabLastUrl(state: ProjectsState, tabId: string, url: string): ProjectsState {
  const owner = findProjectByTab(state, tabId)
  if (owner === undefined) return state
  if (owner.tabs.some((t) => t.id === tabId && t.lastUrl === url)) return state
  return updateProject(state, owner.id, (p) => ({
    ...p,
    tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, lastUrl: url } : t)),
  }))
}

/**
 * 分頁自己的 lastUrl;從沒記過時,只有 sortOrder 最小的對話分頁繼承專案層級的舊值。
 * 專案層級的欄位是單一瀏覽器時期留下的,不再寫入。
 */
export function tabLastUrl(project: ProjectEntry, tabId: string): string | null {
  const tab = project.tabs.find((t) => t.id === tabId)
  if (tab === undefined) return null
  if (tab.lastUrl !== undefined) return tab.lastUrl
  const first = conversationTabs(project).reduce<TabEntry | undefined>(
    (acc, t) => (acc === undefined || t.sortOrder < acc.sortOrder ? t : acc),
    undefined
  )
  return first?.id === tabId ? project.lastUrl : null
}

function pointTabAt(p: ProjectEntry, conversationId: string, threadId: string): readonly TabEntry[] {
  return p.tabs.map((t) => (t.id === conversationId ? { ...t, threadId } : t))
}

export function startThread(
  state: ProjectsState,
  projectId: string,
  conversationId: string,
  threadId: string,
  now: number,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    if (!p.tabs.some((t) => t.id === conversationId && t.contentType === 'conversation')) return p
    const tabs = pointTabAt(p, conversationId, threadId)
    return { ...p, tabs, threads: [...pruneThreads(tabs, p.threads), newThread(threadId, now)] }
  })
}

export function pointConversationAt(
  state: ProjectsState,
  projectId: string,
  conversationId: string,
  link: SessionLink,
  newThreadId: string,
  now: number,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    if (!p.tabs.some((t) => t.id === conversationId && t.contentType === 'conversation')) return p
    const existing = p.threads.find((t) => t.sessions.some((s) => s.sessionId === link.sessionId))
    // 同一條 thread 不給兩個對話分頁共用:兩個 core 會 resume 同一個 session、同時續寫同一份 transcript。
    // 別的分頁已經指著它時,為這個分頁另建一條 thread,起點是同一場 session。
    const takenByOther = existing !== undefined &&
      p.tabs.some((t) => t.id !== conversationId && t.contentType === 'conversation' && t.threadId === existing.id)
    if (existing !== undefined && !takenByOther) {
      const tabs = pointTabAt(p, conversationId, existing.id)
      return { ...p, tabs, threads: pruneThreads(tabs, p.threads) }
    }
    const tabs = pointTabAt(p, conversationId, newThreadId)
    return { ...p, tabs, threads: [...pruneThreads(tabs, p.threads), newThread(newThreadId, now, [link])] }
  })
}

export function recordSession(state: ProjectsState, projectId: string, threadId: string, link: SessionLink): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const thread = p.threads.find((t) => t.id === threadId)
    if (thread === undefined) return p
    // 比對整條鏈,不只最後一筆:resume 回鏈上較早那段時會再收到一次它的
    // session-started,只看最後一筆的話同一個 sessionId 會被記第二次。
    if (thread.sessions.some((s) => s.sessionId === link.sessionId)) return p
    const updated: ThreadEntry = { ...thread, sessions: [...thread.sessions, link] }
    return { ...p, threads: p.threads.map((t) => (t.id === threadId ? updated : t)) }
  })
}

export function setShutdown(state: ProjectsState, openIds: readonly string[]): ProjectsState {
  return { ...state, openIdsOnShutdown: [...openIds] }
}

export function currentThread(entry: ProjectEntry, conversationId: string): ThreadEntry | undefined {
  const tab = entry.tabs.find((t) => t.id === conversationId && t.contentType === 'conversation')
  if (tab === undefined) return undefined
  return entry.threads.find((t) => t.id === tab.threadId)
}

export function lastSessionId(entry: ProjectEntry, conversationId: string): string | undefined {
  return currentThread(entry, conversationId)?.sessions.at(-1)?.sessionId
}

/** 同一 session 可能被多條 thread 引用,同步更新避免歷史查到舊值。 */
export function recordSessionCost(
  state: ProjectsState, projectId: string, sessionId: string, cost: NonNullable<SessionLink['cost']>,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    if (!p.threads.some((t) => t.sessions.some((s) => s.sessionId === sessionId))) return p
    return {
      ...p,
      threads: p.threads.map((t) => t.sessions.some((s) => s.sessionId === sessionId)
        ? { ...t, sessions: t.sessions.map((s) => s.sessionId === sessionId ? { ...s, cost } : s) }
        : t),
    }
  })
}

export function sessionCostOf(state: ProjectsState, sessionId: string): SessionLink['cost'] {
  // 刻意掃全部專案而不限 projectId，因為裁決 20 的跨專案 resume 會在另一個專案底下開同一個 session。
  return state.projects.flatMap((p) => p.threads).flatMap((t) => t.sessions)
    .find((s) => s.sessionId === sessionId)?.cost
}
