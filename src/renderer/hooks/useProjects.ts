import { useCallback, useEffect, useMemo, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { Provider, AddProjectResult, ProjectView, ProjectsView } from '../../shared/projects.js'

export interface Projects {
  /** 主行程推來的完整 view;第一次 getProjects 回來之前是空的 EMPTY_VIEW。 */
  readonly view: ProjectsView
  /** 第一份 view 到了沒。false 時 App 不畫左窗格內容,避免先閃一下「加入專案開始使用」。 */
  readonly loaded: boolean
  readonly active: ProjectView | undefined
  /** 加入或重新指定專案被拒的原因、或 IPC 失敗;下一次成功就清掉。 */
  readonly error: string | undefined
  activate(id: string): void
  add(): Promise<void>
  remove(id: string): void
  relocate(id: string): Promise<void>
  /** 在 active 專案底下開一個新的對話分頁;沒有 active 專案時不做事。 */
  openConversation(provider?: Provider, worktreeName?: string): void
  /** 在 active 專案底下開群組分頁;已經有就切過去。 */
  openGroup(): void
  /** 分頁動作預設作用在 active 專案;沒有 active 專案時不做事。 */
  openTab(label: string, command?: string): void
  closeTab(tabId: string): void
  /** 可指定目標專案,避免切換專案後仍使用舊的 activeId。 */
  activateTab(tabId: string, projectId?: string): void
}

export const EMPTY_VIEW: ProjectsView = { projects: [], activeId: null }

const LOAD_FAILED = '讀取專案清單失敗'

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback
}

/**
 * 專案與分頁的 renderer 端狀態(規格 §3.1):renderer 只認 id,所有改動送到主行程,
 * 主行程改完狀態再推整份 `ProjectsView` 回來,這裡沒有任何本地推測更新。
 *
 * 先訂閱 `onProjects` 再 `getProjects()`:反過來的話,invoke 回來之前主行程推的
 * 那一份會漏掉。`getProjects` 順便讓主行程重送 active 對話的內容(Task 7 規則 7)。
 */
export function useProjects(api: YesChefApi): Projects {
  const [view, setView] = useState<ProjectsView>(EMPTY_VIEW)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    // 主行程背景時也會推 projects:state(分頁、待批准記號變動都算),掛載當下的
    // getProjects() 可能比先到的那次推播晚解析。pushed 記著「推播贏過初始查詢了嗎」,
    // 贏過就不讓晚到的舊快照蓋掉,但 loaded 兩條路徑都要設成 true。
    let pushed = false
    const unsubscribe = api.onProjects((next) => {
      pushed = true
      setView(next)
      setError(next.error)
      setLoaded(true)
    })
    api
      .getProjects()
      .then((next) => {
        if (!alive) return
        if (!pushed) {
          setView(next)
          setError(next.error)
        }
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(messageOf(err, LOAD_FAILED))
        setLoaded(true)
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])

  const activeId = view.activeId
  const active = useMemo(
    () => (activeId === null ? undefined : view.projects.find((p) => p.id === activeId)),
    [view, activeId]
  )

  /** add 與 relocate 共用:rejected 顯示原因,added／cancelled 清掉舊錯誤,IPC 拋錯顯示訊息。 */
  const settle = useCallback((task: Promise<AddProjectResult>, fallback: string): Promise<void> => {
    return task
      .then((result) => {
        setError(result.kind === 'rejected' ? result.message : undefined)
      })
      .catch((err: unknown) => {
        setError(messageOf(err, fallback))
      })
  }, [])

  const activate = useCallback((id: string): void => { api.activateProject(id) }, [api])
  const remove = useCallback((id: string): void => { api.removeProject(id) }, [api])
  const add = useCallback((): Promise<void> => settle(api.addProject(), '加入專案失敗'), [api, settle])
  const relocate = useCallback(
    (id: string): Promise<void> => settle(api.relocateProject(id), '重新指定資料夾失敗'),
    [api, settle]
  )

  const openConversation = useCallback((provider: Provider = 'claude', worktreeName?: string): void => {
    if (activeId === null) return
    api.openConversation(activeId, provider, worktreeName)
  }, [api, activeId])

  const openGroup = useCallback((): void => {
    if (activeId === null) return
    api.openGroup(activeId)
  }, [api, activeId])

  const openTab = useCallback(
    (label: string, command?: string): void => {
      if (activeId === null) return
      api.openTab(command === undefined ? { projectId: activeId, label } : { projectId: activeId, label, command })
    },
    [api, activeId]
  )
  const closeTab = useCallback(
    (tabId: string): void => {
      if (activeId === null) return
      api.closeTab({ projectId: activeId, tabId })
    },
    [api, activeId]
  )
  const activateTab = useCallback(
    (tabId: string, projectId?: string): void => {
      const targetId = projectId ?? activeId
      if (targetId === null) return
      api.activateTab({ projectId: targetId, tabId })
    },
    [api, activeId]
  )

  return useMemo(
    () => ({ view, loaded, active, error, activate, add, remove, relocate, openConversation, openGroup, openTab, closeTab, activateTab }),
    [view, loaded, active, error, activate, add, remove, relocate, openConversation, openGroup, openTab, closeTab, activateTab]
  )
}
