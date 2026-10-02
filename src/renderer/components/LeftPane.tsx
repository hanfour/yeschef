import type { Provider } from '../../shared/projects.js'
import type React from 'react'
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon.js'
import { tabKeyboard } from '../tab-keyboard.js'
import { TAB_FADE_WIDTH, useActiveTabVisibility } from '../hooks/useActiveTabVisibility.js'
import type { Projects } from '../hooks/useProjects.js'
import { PROVIDER_LABELS, sortTabs } from '../../shared/projects.js'
import type { ProjectView, TabEntry } from '../../shared/projects.js'
import { NewConversationForm } from './NewConversationForm.js'
import { Terminal } from './Terminal.js'
import { foregroundConversationId } from '../foreground.js'
import { BrowserSessionsContext } from '../browser-context.js'
import { readLastProvider, writeLastProvider } from '../last-provider.js'
import './LeftPane.css'
import './Busy.css'

export interface LeftPaneProps {
  readonly projects: Projects
  /** 每個要掛載的對話分頁呼叫一次;回傳的節點放進那個分頁的 slot(D2)。 */
  readonly renderConversation: (projectId: string, conversationId: string, provider: Provider, isActive: boolean) => React.ReactNode
  /** 每個群組分頁呼叫一次;沒給就不畫群組內容。 */
  readonly renderGroup?: (projectId: string) => React.ReactNode
  /** 關回合進行中的對話分頁前的確認;預設 `window.confirm`,測試注入。 */
  readonly confirmClose?: (message: string) => boolean
  readonly endpoint: string | null
}

export const QUICK_LAUNCH: readonly { readonly label: string; readonly command?: string }[] = [
  { label: 'claude', command: 'claude' },
  { label: 'codex', command: 'codex' },
  { label: 'grok', command: 'grok' },
  { label: 'zsh' },
] as const

export const EMPTY_HINT = '加入專案開始使用'
export const LEFT_PANE_UI_TEXT = {
  newConversation: '新對話',
  newCodexConversation: `新 ${PROVIDER_LABELS.codex.name} 對話`,
  newGrokConversation: `新 ${PROVIDER_LABELS.grok.name} 對話`,
  conversationSection: '對話',
  terminalSection: '終端機',
  moreLaunchOptions: '更多新增選項',
  newConversationActionPrefix: '新增',
  conversationNoun: '對話',
} as const
export const NEW_CONVERSATION_LABEL = LEFT_PANE_UI_TEXT.newConversation
export const NEW_CODEX_CONVERSATION_LABEL = LEFT_PANE_UI_TEXT.newCodexConversation
export const NEW_GROK_CONVERSATION_LABEL = LEFT_PANE_UI_TEXT.newGrokConversation
export const LAST_CONVERSATION_HINT = '至少留一個對話'
export const CLOSE_BUSY_CONFIRM = '回合進行中，確定關閉？'

function newConversationActionLabel(provider: Provider): string {
  return `${LEFT_PANE_UI_TEXT.newConversationActionPrefix} ${PROVIDER_LABELS[provider].name} ${LEFT_PANE_UI_TEXT.conversationNoun}`
}

function labelOf(tab: TabEntry): string {
  const label = tab.customLabel ?? tab.label
  if (tab.contentType !== 'conversation' || tab.worktreePath === undefined) return label
  // Renderer 沒有 Node path；去掉尾端分隔符後取 basename，不另存 slug。
  const slug = tab.worktreePath.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
  return slug === undefined || slug === '' ? label : `${label} · ${slug}`
}

function BrowserMark({ tabId }: { readonly tabId: string }): React.ReactElement | null {
  const session = useContext(BrowserSessionsContext).find((s) => s.conversationId === tabId)
  if (session === undefined) return null
  const label = session.busy ? '瀏覽器操作中' : '有瀏覽器'
  return <span className={`tab-browser${session.busy ? ' is-busy' : ''}`} role="img" aria-label={label} title={label}><Icon name="globe" /></span>
}

/**
 * 曾經成為 active 的專案 id。終端的 ws 一斷主行程就 `pty.kill()`,所以背景專案的
 * `Terminal` 不能卸載,只能藏;這個清單決定哪些專案的終端要留在 DOM 裡。
 * 專案被移除(不在 `known` 裡)就不再保留。
 */
function useSeen(activeId: string | null, known: readonly string[]): readonly string[] {
  const [seen, setSeen] = useState<readonly string[]>(() => (activeId === null ? [] : [activeId]))
  useEffect(() => {
    if (activeId === null) return
    setSeen((prev) => (prev.includes(activeId) ? prev : [...prev, activeId]))
  }, [activeId])
  return seen.filter((id) => known.includes(id))
}

interface TabStripProps {
  readonly projects: Projects
  readonly active: ProjectView
  readonly confirmClose: (message: string) => boolean
}

function TabItems({ projects, active, confirmClose }: TabStripProps): React.ReactElement {
  const conversationCount = active.tabs.filter((t) => t.contentType === 'conversation').length
  const closeTab = (tab: TabEntry): void => {
    if (active.busyTabIds.includes(tab.id) && !confirmClose(CLOSE_BUSY_CONFIRM)) return
    projects.closeTab(tab.id)
  }
  return <>{sortTabs(active.tabs).map((tab) => {
    const on = tab.id === active.activeTabId
    const lastConversation = tab.contentType === 'conversation' && conversationCount <= 1
    return <div key={tab.id} role="tab" aria-selected={on} tabIndex={on ? 0 : -1} title={labelOf(tab)}
      data-provider={tab.contentType === 'conversation' ? tab.provider ?? 'claude' : tab.contentType}
      onKeyDown={event => tabKeyboard(event, () => projects.activateTab(tab.id))}
      className={`tab${on ? ' on' : ''}`} onClick={() => projects.activateTab(tab.id)}>
      <span className="tab-label">{labelOf(tab)}</span>
      <BrowserMark tabId={tab.id} />
      {active.busyTabIds.includes(tab.id) ? <span className="tab-busy" role="img" aria-label="執行中" title="執行中">◐</span> : null}
      {active.pendingTabIds.includes(tab.id) ? <span className="tab-pending" role="img" aria-label="有待批准的請求" title="有待批准的請求">●</span> : null}
      {tab.contentType !== 'group' ? <button type="button" className="tab-close" aria-label="關閉分頁"
        disabled={lastConversation} title={lastConversation ? LAST_CONVERSATION_HINT : undefined}
        onClick={(event) => { event.stopPropagation(); closeTab(tab) }}>×</button> : null}
    </div>
  })}</>
}

interface LaunchMenuProps {
  readonly projects: Projects
  readonly start: (provider: Provider) => void
}

function LaunchMenu({ projects, start }: LaunchMenuProps): React.ReactElement {
  const menu = useRef<HTMLDetailsElement>(null)
  const close = (): void => { if (menu.current) menu.current.open = false }
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])
  const onKeyDown = (event: React.KeyboardEvent<HTMLDetailsElement>): void => {
    if (event.key !== 'Escape' || menu.current === null) return
    close()
    menu.current.querySelector('summary')?.focus()
  }
  return <details ref={menu} className="split-launch-menu" onKeyDown={onKeyDown}>
    <summary aria-label={LEFT_PANE_UI_TEXT.moreLaunchOptions} title={LEFT_PANE_UI_TEXT.moreLaunchOptions}><Icon name="chevronDown" /></summary>
    <div className="split-launch-options" role="group" aria-label={LEFT_PANE_UI_TEXT.moreLaunchOptions}>
      <div className="split-launch-section" role="group" aria-label={LEFT_PANE_UI_TEXT.conversationSection}>
        <span className="split-launch-heading">{LEFT_PANE_UI_TEXT.conversationSection}</span>
        <button type="button" aria-label={NEW_CONVERSATION_LABEL} onClick={() => { start('claude'); close() }}>{PROVIDER_LABELS.claude.name}</button>
        <button type="button" aria-label={NEW_CODEX_CONVERSATION_LABEL} onClick={() => { start('codex'); close() }}>{PROVIDER_LABELS.codex.name}</button>
        <button type="button" aria-label={NEW_GROK_CONVERSATION_LABEL} onClick={() => { start('grok'); close() }}>{PROVIDER_LABELS.grok.name}</button>
      </div>
      <div className="split-launch-section" role="group" aria-label={LEFT_PANE_UI_TEXT.terminalSection}>
        <span className="split-launch-heading">{LEFT_PANE_UI_TEXT.terminalSection}</span>
        {QUICK_LAUNCH.map((quick) => <button key={quick.label} type="button"
          onClick={() => { projects.openTab(quick.label, quick.command); close() }}><Icon name="terminal" />{quick.label}</button>)}
      </div>
    </div>
  </details>
}

function QuickLaunch({ projects, active }: Pick<TabStripProps, 'projects' | 'active'>): React.ReactElement {
  const [worktreeProvider, setWorktreeProvider] = useState<Provider | undefined>()
  const [lastProvider, setLastProvider] = useState<Provider>(readLastProvider)
  const start = (next: Provider): void => {
    setLastProvider(next)
    writeLastProvider(next)
    if (active.isGitRepo === true) setWorktreeProvider(next)
    else projects.openConversation(next)
  }
  return <>
    <div className="quick-launch"><div className="split-launch">
      <button type="button" className="tab-new-conversation split-launch-main"
        aria-label={newConversationActionLabel(lastProvider)} title={newConversationActionLabel(lastProvider)}
        onClick={() => start(lastProvider)}><Icon name="plus" />{PROVIDER_LABELS[lastProvider].name}</button>
      <LaunchMenu projects={projects} start={start} />
    </div></div>
    {worktreeProvider !== undefined && active.isGitRepo === true ? <NewConversationForm key={worktreeProvider}
      provider={worktreeProvider} onCancel={() => setWorktreeProvider(undefined)} onCreate={(worktreeName) => {
        projects.openConversation(worktreeProvider, worktreeName)
        setWorktreeProvider(undefined)
      }} /> : null}
  </>
}

function TabStrip({ projects, active, confirmClose }: TabStripProps): React.ReactElement {
  const tabsRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ left: false, right: false })
  useActiveTabVisibility(tabsRef, active.activeTabId, TAB_FADE_WIDTH)
  useLayoutEffect(() => {
    const rail = tabsRef.current
    if (!rail) return
    const update = () => {
      const maxScroll = rail.scrollWidth - rail.clientWidth
      setFade({ left: maxScroll > 1 && rail.scrollLeft > 1, right: maxScroll > 1 && rail.scrollLeft < maxScroll - 1 })
    }
    update()
    rail.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    resize?.observe(rail)
    const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(update)
    mutations?.observe(rail, { childList: true, subtree: true, characterData: true })
    return () => {
      rail.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      resize?.disconnect()
      mutations?.disconnect()
    }
  }, [active.tabs, active.activeTabId])
  return <div className="tab-strip">
    <div className="conversation-tabs-frame">
      <div ref={tabsRef} className="conversation-tabs" role="tablist" aria-label="工作分頁">
        <TabItems projects={projects} active={active} confirmClose={confirmClose} />
      </div>
      {fade.left && <span className="conversation-tabs-fade--left" aria-hidden="true" />}
      {fade.right && <span className="conversation-tabs-fade--right" aria-hidden="true" />}
    </div>
    <QuickLaunch projects={projects} active={active} />
  </div>
}

function Unavailable({ projects, active }: { readonly projects: Projects; readonly active: ProjectView }): React.ReactElement {
  return (
    <div className="pane-unavailable" role="alert">
      <p>資料夾 {active.rootPath} 不存在</p>
      <div className="pane-unavailable-actions">
        <button
          type="button"
          onClick={() => {
            void projects.relocate(active.id)
          }}
        >
          重新指定資料夾
        </button>
        <button type="button" onClick={() => projects.remove(active.id)}>
          移除專案
        </button>
      </div>
    </div>
  )
}

/**
 * 左窗格(規格 §3.2、§5):分頁列畫 active 專案的分頁,內容區放對話、群組與終端 slot,
 * 用 `hidden` 決定誰可見。分頁狀態全在主行程,
 * 這裡只有 `useSeen` 這一點本地狀態,而且它只影響掛載,不影響顯示什麼。
 */
export function LeftPane({ projects, renderConversation, renderGroup, endpoint, confirmClose = (message) => window.confirm(message) }: LeftPaneProps): React.ReactElement {
  const { view, active } = projects
  const seenProjects = useSeen(view.activeId, view.projects.map((p) => p.id))
  // 對話分頁比照終端分頁(D2 規格 §4):曾經前景過的都常駐掛載,用 hidden 切換,切走不卸載才不會丟串流中的畫面。
  const foreground = foregroundConversationId(active)
  const knownConversations = view.projects.flatMap((p) => p.tabs.filter((t) => t.contentType === 'conversation').map((t) => t.id))
  const seenConversations = useSeen(foreground, knownConversations)
  const usable = active !== undefined && active.available

  const visible = (p: ProjectView, tab: TabEntry): boolean =>
    usable && p.id === view.activeId && tab.id === p.activeTabId

  return (
    <div className="left-pane">
      {active === undefined ? (
        <div className="pane-empty"><span className="welcome-mark"><Icon name="folder" /></span><h1>{EMPTY_HINT}</h1><p>選擇專案資料夾，建立你的協作工作台。</p><button type="button" className="primary" onClick={() => void projects.add()}><Icon name="plus" />加入專案</button></div>
      ) : active.available ? (
        <TabStrip key={active.id} projects={projects} active={active} confirmClose={confirmClose} />
      ) : (
        <Unavailable projects={projects} active={active} />
      )}
      <div className="pane-area" hidden={!usable}>
        {/* slot 的排列順序看不見(同時只有一個不 hidden),所以用 `tabs` 原本的順序,
            不跟著 `sortOrder` 走:重排分頁時不必連帶搬動掛著 xterm 的那個節點。 */}
        {view.projects.flatMap((p) =>
          p.tabs
            .filter((tab) => tab.contentType === 'conversation' && seenConversations.includes(tab.id))
            .map((tab) => (
              <div key={tab.id} className="pane-slot pane-slot-conversation" hidden={!visible(p, tab)}>
                {renderConversation(p.id, tab.id, tab.provider ?? 'claude', visible(p, tab))}
              </div>
            ))
        )}
        {renderGroup === undefined ? null : view.projects.filter((p) => seenProjects.includes(p.id)).flatMap((p) =>
          p.tabs
            .filter((tab) => tab.contentType === 'group')
            .map((tab) => (
              <div key={tab.id} className="pane-slot pane-slot-group" hidden={!visible(p, tab)}>
                {renderGroup(p.id)}
              </div>
            ))
        )}
        {view.projects
          .filter((p) => seenProjects.includes(p.id))
          .flatMap((p) =>
            p.tabs
              .filter((tab) => tab.contentType === 'terminal')
              .map((tab) => (
                <div key={tab.id} className="pane-slot" hidden={!visible(p, tab)}>
                  {endpoint === null ? (
                    <div className="term-loading">終端機連線中</div>
                  ) : (
                    <Terminal endpoint={endpoint} projectId={p.id} tabId={tab.id} command={tab.command} />
                  )}
                </div>
              ))
          )}
      </div>
    </div>
  )
}
