import { WorkspaceHistory } from './components/WorkspaceHistory.js'
import { ChefManager } from './components/ChefManager.js'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import './theme.css'
import { Icon } from './components/Icon.js'
import { usePreviewTabs } from './hooks/usePreviewTabs.js'
import { PreviewContext, type OpenPreviewRequest } from './preview-context.js'
import { ConversationPane } from './components/ConversationPane.js'
import { GroupPane } from './components/GroupPane.js'
import { titleFor } from './title.js'
import { LeftPane } from './components/LeftPane.js'
import { ProjectBar } from './components/ProjectBar.js'
import { useProjects } from './hooks/useProjects.js'
import { StatusBar } from './components/StatusBar.js'
import type { ConversationCost } from './format-cost.js'
import { usePeer } from './hooks/usePeer.js'
import { PanelDivider } from './components/PanelDivider.js'
import { PanelGroup, type PanelGroupHandle } from './components/PanelGroup.js'
import { usePanelCollapsed } from './hooks/usePanelCollapsed.js'
import { useBrowser } from './hooks/useBrowser.js'
import { foregroundConversationId } from './foreground.js'
import { PermissionManager } from './components/PermissionManager.js'
import type { PermissionState } from '../shared/permissions.js'
import { SkillsManager } from './components/SkillsManager.js'
import { TestMachinesManager } from './components/TestMachinesManager.js'
import { ErrorIntakeManager } from './components/ErrorIntakeManager.js'
import { DialogBoundary } from './components/ErrorBoundary.js'
import { BrowserSessionsContext } from './browser-context.js'
import { terminalWebSocketUrl } from './terminal-client.js'
import './App.css'

export { LIVE_PLACEHOLDER, VIEWING_PLACEHOLDER } from './components/ConversationPane.js'

/**
 * 主分頁區的預覽由 React 顯示;瀏覽器是獨立的 WebContentsView,
 * 由主程序疊在視窗上,只在瀏覽器分頁在前景時顯示。
 *
 * 專案(子專案 D):`useProjects` 是唯一的專案狀態來源,標題列、`ProjectBar`、
 * `LeftPane` 都吃它。`projects.loaded` 為 false 時不畫 `LeftPane`,避免啟動時先閃一下「加入專案開始使用」。
 *
 * 對話(D2):每個對話分頁一份 `ConversationPane`,由 `LeftPane` 決定哪些掛載、哪個可見;
 * 對話、批准、Recents 的狀態都在 pane 裡,App 不再持有。
 */
export function App({ slot }: { readonly slot?: ReactNode } = {}) {
  const api = window.yeschef
  const projects = useProjects(api)
  const peer = usePeer(api)
  const panel = usePanelCollapsed()
  const browser = useBrowser(api)
  const foregroundId = foregroundConversationId(projects.active)
  const foregroundLastUrl = projects.active?.tabs.find((t) => t.id === foregroundId)?.lastUrl ?? null
  const [jumpToken, setJumpToken] = useState(0)
  const [jumpTarget, setJumpTarget] = useState<{ readonly projectId: string; readonly tabId: string }>()
  const [dragging, setDragging] = useState(false)
  const [chefOpen, setChefOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [testMachinesOpen, setTestMachinesOpen] = useState(false)
  const [errorIntakeOpen, setErrorIntakeOpen] = useState(false)
  // active 專案消失時(例如被移除、或切到還沒載入完成)測試機對話框跟著關閉;
  // 不然它繼續把 dragging 卡在 true,原生瀏覽器就再也拿不到擺放矩形了(I1)。
  useEffect(() => {
    if (projects.active === undefined) setTestMachinesOpen(false)
  }, [projects.active])
  const [permissionState, setPermissionState] = useState<PermissionState>()
  useEffect(() => {
    let alive = true
    api.managePermissions({ action: 'get' }).then(result => { if (alive && result.kind === 'state') setPermissionState(result.state) }).catch(() => {})
    return () => { alive = false }
  }, [api])
  const [compact, setCompact] = useState(() => window.innerWidth < 900)
  const [compactPane, setCompactPane] = useState<'conversation' | 'preview'>('conversation')
  const desktopPanelWidth = useRef('')
  useLayoutEffect(() => {
    if (!compact) desktopPanelWidth.current = document.documentElement.style.getPropertyValue('--panel-width')
  })
  useEffect(() => {
    let wasCompact = window.innerWidth < 900
    const resize = () => {
      const next = window.innerWidth < 900
      if (wasCompact && !next) {
        if (desktopPanelWidth.current) document.documentElement.style.setProperty('--panel-width', desktopPanelWidth.current)
        else document.documentElement.style.removeProperty('--panel-width')
      }
      wasCompact = next
      setCompact(next)
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const panelHidden = compact ? compactPane !== 'preview' : panel.collapsed
  const panelGroup = useRef<PanelGroupHandle>(null)
  const onDragging = useCallback((next: boolean): void => {
    // 按下當下就送出隱藏通知,不等狀態更新後的重繪。
    if (next) panelGroup.current?.hideNow()
    setDragging(next)
  }, [])
  const previewTabs = usePreviewTabs()
  /**
   * 這個函式是 PreviewContext 的值,每個 ToolCall 都訂閱它;參考一換,所有掛著的工具卡片都重畫
   * (memo 擋不住 context)。所以它不依賴 active 專案與收起狀態,改從 ref 讀當下的值。
   */
  const latest = useRef({ projectId: projects.active?.id, collapsed: panel.collapsed, compact })
  useLayoutEffect(() => {
    latest.current = { projectId: projects.active?.id, collapsed: panel.collapsed, compact }
  })
  const { open: openPreviewTab } = previewTabs
  const { toggle: togglePanel } = panel
  const openPreviewFromConversation = useCallback((request: OpenPreviewRequest): void => {
    const { projectId, collapsed, compact } = latest.current
    if (request.kind === 'file') {
      // 對話以當前專案為基準；已開啟文件的連結則保留來源專案。
      const fileProjectId = request.projectId ?? projectId
      if (fileProjectId === undefined) return
      openPreviewTab({ ...request, projectId: fileProjectId })
    } else {
      openPreviewTab(request)
    }
    if (compact) setCompactPane('preview')
    else if (collapsed) togglePanel()
  }, [openPreviewTab, togglePanel])

  /** 三個數字跨全部專案加總:狀態列的用處是不必先切到某個專案才知道有事。 */
  const busy = projects.view.projects.reduce((n, p) => n + p.busyTabIds.length, 0)
  const pending = projects.view.projects.reduce((n, p) => n + p.pendingTabIds.length, 0)
  /** 第一個有待批准的對話;狀態列點下去就跳過去。 */
  const withPending = projects.view.projects.find((p) => p.pendingTabIds.length > 0)
  const withBusy = projects.view.projects.find((p) => p.busyTabIds.length > 0)
  const busyTabId = withBusy?.busyTabIds[0]
  const firstBusy = withBusy === undefined || busyTabId === undefined
    ? undefined
    : { projectId: withBusy.id, tabId: busyTabId }
  const firstPending =
    withPending === undefined || withPending.pendingTabIds[0] === undefined
      ? undefined
      : { projectId: withPending.id, tabId: withPending.pendingTabIds[0] }
  /**
   * 花費連著回報它的對話一起記:前景可能是終端機分頁、專案資料夾可能不存在、
   * 新專案的對話 pane 可能還沒掛上,這些情況都沒有 pane 會回報,
   * 只認「回報的人就是現在的前景」就不會把上一個對話的數字掛在別人頭上。
   */
  const [reported, setReported] = useState<{ readonly id: string; readonly cost?: ConversationCost }>()
  const onCost = useCallback((id: string, cost: ConversationCost | undefined): void => {
    setReported(cost === undefined ? { id } : { id, cost })
  }, [])
  const activeTabId = projects.active?.activeTabId
  const shownCost = reported !== undefined && reported.id === activeTabId ? reported.cost : undefined
  const [endpoint, setEndpoint] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.resolve(api.terminalEndpoint()).then(
      (result) => {
        if (alive && result !== undefined) setEndpoint(terminalWebSocketUrl(result))
      },
      (err: unknown) => console.error('[yeschef] 取終端機 port 失敗', err)
    )
    return () => {
      alive = false
    }
  }, [api])

  return (
    <div className={`app${compact ? ' is-compact' : ''}`}>
      <BrowserSessionsContext.Provider value={browser.sessions}>
        <PreviewContext.Provider value={openPreviewFromConversation}>
              <header className="title-bar">
                <span className="app-brand"><Icon name="panels" /><span className="brand-word">YesChef</span></span>
                <span className="title-text" title={projects.active?.rootPath}>{titleFor(projects.active)}</span>
                <button type="button" className="panel-toggle" onClick={() => {
                  panelGroup.current?.hideNow()
                  setSkillsOpen(true)
                }}><Icon name="skills" />Skills</button>
                <button type="button" className="panel-toggle" onClick={() => { panelGroup.current?.hideNow(); setSelectedTaskId(undefined); setChefOpen(true) }}>主廚</button>
                <button type="button" className="panel-toggle" title={permissionState?.paused ? '自動批准已暫停' : `授權模式：${permissionState?.policies.find(p => p.projectId === projects.active?.id)?.mode ?? 'manual'}`} onClick={() => { panelGroup.current?.hideNow(); setPermissionsOpen(true) }}>授權{permissionState && !permissionState.paused && permissionState.policies.some(p => p.projectId === projects.active?.id && p.mode !== 'manual') ? ' ●' : ''}</button>
                <button type="button" className="panel-toggle" onClick={() => { panelGroup.current?.hideNow(); setTestMachinesOpen(true) }} disabled={projects.active === undefined}>測試機</button>
                <button type="button" className="panel-toggle error-intake-trigger" aria-label="錯誤收集" title="錯誤收集資料庫" onClick={() => { panelGroup.current?.hideNow(); setErrorIntakeOpen(true) }}>
                  <Icon name="database" /><span>錯誤收集</span>
                </button>
                <button type="button" className="panel-toggle" onClick={() => {
                  if (compact) { panelGroup.current?.hideNow(); setCompactPane(pane => pane === 'preview' ? 'conversation' : 'preview') }
                  else panel.toggle()
                }}>
                  <Icon name="panels" />{compact ? compactPane === 'preview' ? '返回對話' : '開啟預覽' : panel.collapsed ? '展開右側' : '收起右側'}
                </button>
              </header>
          <div className="workbench">
            <div className="main-column" hidden={compact && compactPane === 'preview'}>
              <ProjectBar projects={projects} />
              {projects.loaded ? (
                <div className="workspace-conversations">
                {projects.active?.available && <WorkspaceHistory api={api} projects={projects} />}
                <LeftPane
                  projects={projects}
                  endpoint={endpoint}
                  renderConversation={(projectId, conversationId, provider, isActive) => (
                    <ConversationPane
                      sharedHistory
                      api={api}
                      projects={projects}
                      projectId={projectId}
                      conversationId={conversationId}
                      provider={provider}
                      isActive={isActive}
                      onOpenChef={taskId => { panelGroup.current?.hideNow(); setSelectedTaskId(taskId); setChefOpen(true) }}
                      onCost={onCost}
                      jumpToken={jumpToken}
                      jumpTarget={jumpTarget}
                    />
                  )}
                  renderGroup={(projectId) => <GroupPane api={api} projects={projects} projectId={projectId} onOpenChef={taskId => { panelGroup.current?.hideNow(); setSelectedTaskId(taskId); setChefOpen(true) }} />}
                />
                </div>
              ) : null}
            </div>
            {panel.collapsed || compact ? null : <PanelDivider onDragging={onDragging} />}
            <PanelGroup ref={panelGroup} dragging={dragging || skillsOpen || permissionsOpen || chefOpen || testMachinesOpen || errorIntakeOpen} api={api} collapsed={panelHidden}
              previews={previewTabs.tabs.previews} activeId={previewTabs.tabs.activeId}
              projects={projects.view.projects}
              onActivate={previewTabs.activate} onClose={previewTabs.close}
              browser={{ conversationId: foregroundId, state: browser.stateOf(foregroundId), lastUrl: foregroundLastUrl, run: browser.run }} />
            {slot}
          </div>
        </PreviewContext.Provider>
      </BrowserSessionsContext.Provider>
      {chefOpen && <DialogBoundary onClose={() => setChefOpen(false)}><ChefManager api={api} projects={projects.view} selectedTaskId={selectedTaskId} onClose={() => setChefOpen(false)} /></DialogBoundary>}
      {permissionsOpen && <DialogBoundary onClose={() => setPermissionsOpen(false)}><PermissionManager api={api} projects={projects.view.projects} activeId={projects.view.activeId} onClose={() => setPermissionsOpen(false)} onChange={setPermissionState} /></DialogBoundary>}
      {skillsOpen && <DialogBoundary onClose={() => setSkillsOpen(false)}><SkillsManager api={api} onClose={() => setSkillsOpen(false)} /></DialogBoundary>}
      {testMachinesOpen && projects.active !== undefined && <DialogBoundary key={projects.active.id} onClose={() => setTestMachinesOpen(false)}><TestMachinesManager api={api} projectId={projects.active.id} projectName={projects.active.name} onClose={() => setTestMachinesOpen(false)} /></DialogBoundary>}
      {errorIntakeOpen && <DialogBoundary key={projects.active?.id ?? 'none'} onClose={() => setErrorIntakeOpen(false)}><ErrorIntakeManager api={api} project={projects.active} onClose={() => setErrorIntakeOpen(false)} /></DialogBoundary>}
      <StatusBar
        {...(shownCost === undefined ? {} : { cost: shownCost })}
        busy={busy}
        pending={pending}
        peerPending={peer.pending.length}
        {...(firstBusy === undefined ? {} : {
          onJumpToBusy: () => {
            if (compact) { panelGroup.current?.hideNow(); setCompactPane('conversation') }
            projects.activate(firstBusy.projectId)
            projects.activateTab(firstBusy.tabId, firstBusy.projectId)
          },
        })}
        {...(firstPending === undefined
          ? {}
          : {
              onJumpToPending: () => {
                if (compact) { panelGroup.current?.hideNow(); setCompactPane('conversation') }
                setJumpTarget(firstPending)
                setJumpToken((previous) => previous + 1)
                projects.activate(firstPending.projectId)
                projects.activateTab(firstPending.tabId, firstPending.projectId)
              },
            })}
      />
    </div>
  )
}
