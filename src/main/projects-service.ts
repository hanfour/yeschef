/**
 * 專案登錄表的唯一持有者(規格 §3.1)。state 只透過 `update` 換新;每次換新先送出
 * 存檔(非同步,失敗只記錯不回滾:使用者眼前的操作已經生效,下一次 update 會再存
 * 一次),再逐一呼叫訂閱者(路由器據此切對話核心、右窗格)。訂閱者拋錯只記那一個
 * 訂閱者的錯,不擋存檔,也不擋其他訂閱者被呼叫。
 */
import { addProject as addProjectEntry, createProjectEntry, findProject, openGroupTab } from './projects-state.js'
import type { ProjectsStore } from './projects-store.js'
import type { ProjectsState } from '../shared/projects.js'

export interface ProjectsServiceDeps {
  readonly store: ProjectsStore
  readonly initial: ProjectsState
  readonly now: () => number
  readonly newId: () => string
  readonly isDir: (path: string) => boolean
  readonly logError: (error: Error) => void
}

export interface ProjectsService {
  state(): ProjectsState
  error(): string | undefined
  reportError(message: string): void
  clearError(): void
  /**
   * 套 reducer。state 不變時原樣回傳,不存檔也不通知。state 有變時:換新 state、
   * 送出存檔、逐一呼叫每個訂閱者;哪個訂閱者拋錯就記那筆錯,照樣呼叫下一個訂閱者,
   * 存檔也不受影響。回傳新 state。
   */
  update(fn: (state: ProjectsState) => ProjectsState): ProjectsState
  subscribe(cb: (next: ProjectsState, prev: ProjectsState) => void): () => void
  rootPathOf(id: string): string | undefined
  /** 資料夾存在且是目錄(規格 §6:不存在標示為不可用,不移除)。 */
  isAvailable(id: string): boolean
  /** 建專案、對話、thread 與群組分頁 id,回專案 id。 */
  addProject(rootPath: string): string
  newId(): string
  now(): number
}

function addMissingGroupTabs(state: ProjectsState, newId: () => string): ProjectsState {
  return state.projects.reduce((next, project) => {
    if (project.tabs.some((tab) => tab.contentType === 'group')) return next
    const focusedAt = Math.max(...project.tabs.map((tab) => tab.lastFocusedAt))
    return openGroupTab(next, project.id, newId(), focusedAt)
  }, state)
}

type Listener = (next: ProjectsState, prev: ProjectsState) => void

export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService {
  let error: string | undefined
  let state = deps.initial
  let listeners: readonly Listener[] = []

  function update(fn: (s: ProjectsState) => ProjectsState): ProjectsState {
    const prev = state
    const next = fn(prev)
    if (next === prev) return prev
    state = next
    deps.store.save(next).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      deps.logError(new Error(`寫入專案狀態檔失敗:${message}`))
    })
    notify(next, prev)
    return next
  }

  function notify(next: ProjectsState, prev: ProjectsState): void {
    for (const cb of listeners) {
      try {
        cb(next, prev)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        deps.logError(new Error(`專案狀態訂閱者拋錯:${message}`))
      }
    }
  }

  const migrated = addMissingGroupTabs(state, deps.newId)
  if (migrated !== state) update(() => migrated)

  return {
    state: () => state,
    error: () => error,
    reportError(message) {
      // 沿用專案推播與錯誤區；訊息只留在記憶體，不寫進狀態檔。
      error = message
      notify(state, state)
    },
    clearError() {
      if (error === undefined) return
      error = undefined
      // 即使接下來的動作不改狀態，也要清除畫面上的舊訊息。
      notify(state, state)
    },
    update,
    subscribe(cb) {
      listeners = [...listeners, cb]
      return () => {
        listeners = listeners.filter((l) => l !== cb)
      }
    },
    rootPathOf: (id) => findProject(state, id)?.rootPath,
    isAvailable(id) {
      const root = findProject(state, id)?.rootPath
      return root !== undefined && deps.isDir(root)
    },
    addProject(rootPath) {
      const entry = createProjectEntry({
        id: deps.newId(),
        rootPath,
        conversationTabId: deps.newId(),
        threadId: deps.newId(),
        now: deps.now(),
      })
      update((s) => openGroupTab(addProjectEntry(s, entry), entry.id, deps.newId(), deps.now()))
      return entry.id
    },
    newId: deps.newId,
    now: deps.now,
  }
}
