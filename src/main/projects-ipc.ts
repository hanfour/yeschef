import { ipcMain } from 'electron'
import { createWorktree, removeWorktree, isGitRepo, type WorktreeDeps } from './worktree.js'
import { IPC } from '../shared/ipc.js'
import { parseGroupOpen } from '../shared/group.js'
import {
  parseConversationOpen,
  parseProjectId,
  parseTabOpen,
  parseTabTarget,
  type AddProjectResult,
  type ProjectsState,
} from '../shared/projects.js'
import { asError } from './agent-host.js'
import { MSG } from './merge.js'
import type { MergeLocks } from './merge-locks.js'
import type { ProjectsService } from './projects-service.js'
import {
  addProject,
  closeTab,
  createProjectEntry,
  findProject,
  focusTab,
  openConversationTab,
  openGroupTab,
  openTab,
  relocateProject,
  removeProject,
  setActive,
} from './projects-state.js'

export interface ProjectsIpcDeps {
  readonly worktree: WorktreeDeps
  readonly service: ProjectsService
  readonly disposeConversation: (conversationId: string) => Promise<void>
  /**
   * 跟 worktree-merge-ipc 共用同一份合併進行中旗標。關分頁會移除 worktree,
   * 合併跑到一半被抽掉目錄的話 git 會停在半路,所以這裡只讀不拿。
   */
  readonly locks: MergeLocks
  /** 開資料夾選擇器;使用者取消回 undefined。 */
  readonly pickFolder: () => Promise<string | undefined>
  /** 這個資料夾能不能當專案:可以回 undefined,不行回給使用者看的原因。 */
  readonly validateRoot: (rootPath: string) => string | undefined
  readonly logError: (error: Error) => void
  /**
   * 終端分頁被使用者關掉、或它的專案被移除時呼叫一次。index.ts 接的是
   * `killTmuxSession`:socket 斷線不殺 session(那是接回的前提),只有使用者明確
   * 說不要了才殺,而「不要了」只有主行程這裡知道。
   */
  readonly onTerminalTabClosed?: (tabId: string) => void
}

/** 舊狀態沒有快取時只在啟動補一次，推 view 不執行 git。 */
export async function initializeGitRepoState(service: ProjectsService, worktree: WorktreeDeps): Promise<void> {
  const missing = service.state().projects.filter((project) => project.isGitRepo === undefined)
  const checked = await Promise.all(missing.map(async (project) => ({
    id: project.id, rootPath: project.rootPath, isGitRepo: await isGitRepo(worktree, project.rootPath),
  })))
  if (checked.length === 0) return
  service.update((state) => ({ ...state, projects: state.projects.map((project) => {
    const result = checked.find((entry) => entry.id === project.id && entry.rootPath === project.rootPath)
    return result === undefined || project.isGitRepo !== undefined ? project : { ...project, isGitRepo: result.isGitRepo }
  }) }))
}

type Reducer = (state: ProjectsState) => ProjectsState

const BAD_PAYLOAD = 'payload 形狀不符'

/**
 * 專案與分頁的 IPC:只改 `ProjectsState`。改完之後路由器(ipc-bridge)透過 subscribe
 * 自己切前景、推 `projects:state`,這裡不需要知道對話與終端的存在。
 */
export function registerProjectsIpc(deps: ProjectsIpcDeps): () => void {
  const { service } = deps

  const badPayload = (channel: string, raw: unknown): Error =>
    new Error(`${channel}：${BAD_PAYLOAD}（${typeof raw}），已丟棄`)

  /** 選資料夾並驗證;三種結果對應 `AddProjectResult` 的前兩種加上「可以用的路徑」。 */
  const pickValidFolder = async (): Promise<
    { readonly kind: 'ok'; readonly rootPath: string } | Exclude<AddProjectResult, { kind: 'added' }>
  > => {
    const picked = await deps.pickFolder()
    if (picked === undefined) return { kind: 'cancelled' }
    const reason = deps.validateRoot(picked)
    if (reason !== undefined) {
      service.reportError(reason)
      return { kind: 'rejected', message: reason }
    }
    return { kind: 'ok', rootPath: picked }
  }

  const addNew = async (rootPath: string): Promise<AddProjectResult> => {
    const gitRepo = await isGitRepo(deps.worktree, rootPath)
    const existing = service.state().projects.find((p) => p.rootPath === rootPath)
    const id = existing?.id ?? service.newId()
    service.update((state) => {
      const now = service.now()
      const withEntry = existing !== undefined
        ? state
        : addProject(state, createProjectEntry({
          id,
          rootPath,
          isGitRepo: gitRepo,
          conversationTabId: service.newId(),
          threadId: service.newId(),
          now,
        }))
      const withGroup = existing !== undefined ? withEntry : openGroupTab(withEntry, id, service.newId(), now)
      return setActive(withGroup, id, now)
    })
    return { kind: 'added', id }
  }

  const onAdd = async (): Promise<AddProjectResult> => {
    service.clearError()
    try {
      const picked = await pickValidFolder()
      return picked.kind === 'ok' ? await addNew(picked.rootPath) : picked
    } catch (err) {
      const error = asError(err, IPC.projectsAdd)
      deps.logError(error)
      service.reportError(error.message)
      return { kind: 'rejected', message: error.message }
    }
  }

  const onRelocate = async (_event: unknown, raw: unknown): Promise<AddProjectResult> => {
    service.clearError()
    const payload = parseProjectId(raw)
    if (payload === null) {
      deps.logError(badPayload(IPC.projectsRelocate, raw))
      return { kind: 'rejected', message: BAD_PAYLOAD }
    }
    if (findProject(service.state(), payload.id) === undefined) {
      return { kind: 'rejected', message: `找不到專案 ${payload.id}` }
    }
    try {
      const picked = await pickValidFolder()
      if (picked.kind !== 'ok') return picked
      const gitRepo = await isGitRepo(deps.worktree, picked.rootPath)
      service.update((state) => relocateProject(state, payload.id, picked.rootPath, gitRepo))
      return { kind: 'added', id: payload.id }
    } catch (err) {
      const error = asError(err, IPC.projectsRelocate)
      deps.logError(error)
      service.reportError(error.message)
      return { kind: 'rejected', message: error.message }
    }
  }

  /**
   * send 通道共用:解析 →(有給 `projectIdOf` 就確認專案在)→ 套 reducer;
   * 任何一步失敗都只記錯誤。
   *
   * 分頁通道要這個守衛:未知專案的 reducer 原樣回傳 state,`update` 不通知也不記錯,
   * renderer 送錯 id 這件事就完全看不出來。terminal-server 對未知 id 一定記 log,這裡一致。
   */
  const onSend = <T>(
    channel: string,
    parse: (raw: unknown) => T | null,
    reduce: (payload: T) => Reducer,
    projectIdOf?: (payload: T) => string,
  ) =>
    (_event: unknown, raw: unknown): void => {
      service.clearError()
      const payload = parse(raw)
      if (payload === null) {
        deps.logError(badPayload(channel, raw))
        return
      }
      const projectId = projectIdOf?.(payload)
      if (projectId !== undefined && findProject(service.state(), projectId) === undefined) {
        deps.logError(new Error(`${channel}：找不到專案 ${projectId}`))
        return
      }
      try {
        service.update(reduce(payload))
      } catch (err) {
        deps.logError(asError(err, channel))
      }
    }

  /** reducer 跑之前先算好要通知哪些終端分頁:跑完之後那些分頁已經不在 state 裡了。 */
  const terminalTabsOf = (projectId: string): readonly string[] =>
    (findProject(service.state(), projectId)?.tabs ?? [])
      .filter((t) => t.contentType === 'terminal')
      .map((t) => t.id)
  const notifyClosed = (tabIds: readonly string[]): void => {
    for (const tabId of tabIds) deps.onTerminalTabClosed?.(tabId)
  }

  const onRemove = onSend(IPC.projectsRemove, parseProjectId, ({ id }) => {
    const closing = terminalTabsOf(id)
    return (s) => {
      const next = removeProject(s, id)
      if (next !== s) notifyClosed(closing)
      return next
    }
  })
  const activate = onSend(IPC.projectsActivate, parseProjectId, ({ id }) => (s) => setActive(s, id, service.now()))
  const onActivate = async (event: unknown, raw: unknown): Promise<void> => {
    activate(event, raw)
    const payload = parseProjectId(raw)
    if (payload === null) return
    const project = findProject(service.state(), payload.id)
    if (project === undefined) return
    const gitRepo = await isGitRepo(deps.worktree, project.rootPath)
    // 等待 Git 時可能已重新指定資料夾或移除專案，不把舊路徑的結果寫回。
    service.update(state => ({ ...state, projects: state.projects.map(entry =>
      entry.id === project.id && entry.rootPath === project.rootPath ? { ...entry, isGitRepo: gitRepo } : entry,
    ) }))
  }
  const tabProjectId = (p: { readonly projectId: string }): string => p.projectId
  const onTabOpen = onSend(IPC.tabsOpen, parseTabOpen, (p) => (s) =>
    openTab(s, p.projectId, { id: service.newId(), label: p.label, command: p.command }, service.now()), tabProjectId)
  const onGroupOpen = onSend(IPC.groupOpen, parseGroupOpen, (p) => (s) =>
    openGroupTab(s, p.projectId, service.newId(), service.now()), tabProjectId)
  const onTabClose = async (_event: unknown, raw: unknown): Promise<void> => {
    service.clearError()
    const payload = parseTabTarget(raw)
    if (payload === null) {
      deps.logError(badPayload(IPC.tabsClose, raw))
      return
    }
    const project = findProject(service.state(), payload.projectId)
    if (project === undefined) {
      deps.logError(new Error(`${IPC.tabsClose}：找不到專案 ${payload.projectId}`))
      return
    }
    const tab = project.tabs.find((entry) => entry.id === payload.tabId)
    // 只有帶 worktree 的分頁要看合併旗標:它關起來會移除目錄,合併跑到一半不能被抽走。
    // 這個專案在 merge 中,或這個分頁自己在放棄合併,就留著分頁請使用者稍後再關。
    // 沒有 worktree 的分頁(終端、一般對話)關閉不碰 git,合併中照常關。
    const merging = deps.locks.isBusy(payload.projectId) || deps.locks.isBusy(`${payload.projectId}/${payload.tabId}`)
    if (tab?.worktreePath !== undefined && merging) {
      service.reportError(MSG.closeWhileMerging)
      return
    }
    try {
      const before = service.state()
      // 先關閉分頁，再等對話完成收尾才碰工作目錄；重複關閉與最後一個對話都不會刪除。
      const next = service.update((state) => closeTab(state, payload.projectId, payload.tabId, service.now()))
      if (next === before || tab === undefined) return
      if (tab.contentType === 'terminal') notifyClosed([tab.id])
      if (tab.worktreePath === undefined) return
      await deps.disposeConversation(tab.id)
      const result = await removeWorktree(deps.worktree, project.rootPath, tab.worktreePath)
      if (result.kind === 'dirty') {
        service.reportError(`worktree 還有未提交的改動,留在 ${tab.worktreePath},請自己處理`)
      } else if (result.kind === 'failed') {
        service.reportError(result.message)
      }
    } catch (error) {
      const failure = asError(error, IPC.tabsClose)
      deps.logError(failure)
      service.reportError(failure.message)
    }
  }
  const onTabActivate = onSend(
    IPC.tabsActivate, parseTabTarget, (p) => (s) => focusTab(s, p.projectId, p.tabId, service.now()), tabProjectId)

  const onConversationOpen = async (_event: unknown, raw: unknown): Promise<void> => {
    service.clearError()
    const payload = parseConversationOpen(raw)
    if (payload === null) {
      deps.logError(badPayload(IPC.conversationsOpen, raw))
      return
    }
    const project = findProject(service.state(), payload.projectId)
    if (project === undefined) {
      deps.logError(new Error(`${IPC.conversationsOpen}：找不到專案 ${payload.projectId}`))
      return
    }
    try {
      const tabId = service.newId()
      const threadId = service.newId()
      const result = payload.worktreeName === undefined ? undefined
        : await createWorktree(deps.worktree, project.rootPath, payload.worktreeName, tabId)
      const stillThere = findProject(service.state(), payload.projectId)
      if (stillThere === undefined) {
        // 等待 git 期間專案被移除：清理沒有分頁使用的 worktree，並記錄結果。
        if (result?.kind === 'ok') {
          const cleanup = await removeWorktree(deps.worktree, project.rootPath, result.path)
          if (cleanup.kind !== 'removed') {
            deps.logError(new Error(`${IPC.conversationsOpen}：專案已移除,殘留 worktree ${result.path}`))
          }
        }
        deps.logError(new Error(`${IPC.conversationsOpen}：等待 git 期間專案 ${payload.projectId} 已被移除`))
        return
      }
      if (result?.kind === 'failed') {
        service.reportError(`建立 worktree 失敗：${result.message}；對話已在專案主目錄開啟。`)
      }
      // 等待 git 期間其他分頁可能已更新，必須套用到最新狀態。
      service.update((state) => openConversationTab(state, payload.projectId, {
        tabId, threadId, provider: payload.provider,
        ...(result?.kind === 'ok' ? { worktreePath: result.path } : {}),
      }, service.now()))
    } catch (error) {
      const failure = asError(error, IPC.conversationsOpen)
      deps.logError(failure)
      service.reportError(failure.message)
    }
  }

  ipcMain.handle(IPC.projectsAdd, onAdd)
  ipcMain.handle(IPC.projectsRelocate, onRelocate)
  ipcMain.on(IPC.projectsRemove, onRemove)
  ipcMain.on(IPC.projectsActivate, onActivate)
  ipcMain.on(IPC.tabsOpen, onTabOpen)
  ipcMain.on(IPC.groupOpen, onGroupOpen)
  ipcMain.on(IPC.tabsClose, onTabClose)
  ipcMain.on(IPC.tabsActivate, onTabActivate)
  ipcMain.on(IPC.conversationsOpen, onConversationOpen)

  return () => {
    ipcMain.removeHandler(IPC.projectsAdd)
    ipcMain.removeHandler(IPC.projectsRelocate)
    ipcMain.removeListener(IPC.projectsRemove, onRemove)
    ipcMain.removeListener(IPC.projectsActivate, onActivate)
    ipcMain.removeListener(IPC.tabsOpen, onTabOpen)
    ipcMain.removeListener(IPC.groupOpen, onGroupOpen)
    ipcMain.removeListener(IPC.tabsClose, onTabClose)
    ipcMain.removeListener(IPC.tabsActivate, onTabActivate)
    ipcMain.removeListener(IPC.conversationsOpen, onConversationOpen)
  }
}
