import { DevelopmentDiff } from './DevelopmentDiff.js'
import { useImperativeHandle, useRef } from 'react'
import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { ProjectView } from '../../shared/projects.js'
import type { BrowserCommand, BrowserCommandResult, BrowserStatePayload } from '../../shared/browser-ipc.js'
import { useReportBounds } from '../hooks/useReportBounds.js'
import { BROWSER_TAB_ID, type PreviewTab } from '../previews.js'
import { PreviewPane } from './PreviewPane.js'
import './PanelGroup.css'
import { Icon } from './Icon.js'
import { BrowserBar } from './BrowserBar.js'
import { BrowserEmpty } from './BrowserEmpty.js'
import { tabKeyboard } from '../tab-keyboard.js'
import { useActiveTabVisibility } from '../hooks/useActiveTabVisibility.js'

export interface PanelGroupHandle {
  readonly hideNow: () => void
}

export interface PanelGroupProps {
  readonly ref?: React.Ref<PanelGroupHandle>
  readonly api: Pick<YesChefApi, 'setBrowserBounds' | 'readPreview' | 'conversationTools'>
    & Partial<Pick<YesChefApi, 'worktreeMerge'>>
  readonly collapsed: boolean
  readonly dragging: boolean
  readonly previews: readonly PreviewTab[]
  readonly activeId: string
  readonly onActivate: (id: string) => void
  readonly onClose: (id: string) => void
  /** 用來查出 diff 分頁那個對話有沒有 worktree;沒給就不顯示合併列。 */
  readonly projects?: readonly ProjectView[]
  readonly browser: {
    readonly conversationId: string | null
    readonly state: BrowserStatePayload | undefined
    readonly lastUrl: string | null
    readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>
  }
}

/**
 * 原生 view 會蓋住 React 預覽,因此只在瀏覽器分頁在前景時回報矩形。
 * 瀏覽器本身是主行程的原生 view,不在這棵 DOM 裡,這裡只負責量出 `.panel-body`
 * 的位置交給主行程,讓它疊上來。
 */
export function PanelGroup({ ref, api, collapsed, dragging, previews, activeId, onActivate, onClose, browser, projects = [] }: PanelGroupProps): React.ReactElement {
  const body = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  useActiveTabVisibility(tabsRef, activeId)
  const hideNow = useReportBounds(body, !collapsed && !dragging && activeId === BROWSER_TAB_ID, api.setBrowserBounds)
  useImperativeHandle(ref, () => ({ hideNow }), [hideNow])
  const activePreview = previews.find((tab) => tab.id === activeId)
  // 對話分頁 id 就是 conversationId,所以直接拿它去 projects 裡找 worktree 歸屬。
  // 先把 source 取出來再查,narrowing 才穿得過下面那個 closure。
  const diffSource = activePreview?.source.kind === 'diff' ? activePreview.source : undefined
  const diffOwner = diffSource === undefined
    ? undefined
    : projects.find((project) => project.tabs.some((tab) => tab.id === diffSource.conversationId && tab.worktreePath !== undefined))
  return (
    <section className="panel-group" hidden={collapsed}>
      <div ref={tabsRef} className="panel-tabs" role="tablist" aria-label="預覽分頁">
        <button type="button" role="tab" aria-selected={activeId === BROWSER_TAB_ID}
          className={`panel-tab${activeId === BROWSER_TAB_ID ? ' is-active' : ''}`}
          tabIndex={activeId === BROWSER_TAB_ID ? 0 : -1}
          onKeyDown={event => tabKeyboard(event, () => onActivate(BROWSER_TAB_ID))}
          onClick={() => onActivate(BROWSER_TAB_ID)}><Icon name="globe" />瀏覽器</button>
        {previews.map((tab) => (
          <div className="panel-preview-tab" key={tab.id}>
            <button type="button" role="tab" aria-selected={activeId === tab.id}
              className={`panel-tab${activeId === tab.id ? ' is-active' : ''}`}
              title={tab.source.kind === 'file' ? tab.source.path : tab.title}
              tabIndex={activeId === tab.id ? 0 : -1}
              onKeyDown={event => tabKeyboard(event, () => onActivate(tab.id))}
              onClick={() => onActivate(tab.id)}>{tab.title}</button>
            <button type="button" className="panel-tab-close" aria-label="關閉預覽"
              onClick={() => onClose(tab.id)}>×</button>
          </div>
        ))}
      </div>
      {activeId === BROWSER_TAB_ID
        ? <BrowserBar key={browser.conversationId ?? 'none'} state={browser.state} fallbackUrl={browser.lastUrl ?? ''} run={browser.run} />
        : null}
      <div className="panel-body" ref={body}>
        {activeId === BROWSER_TAB_ID && browser.state === undefined
          ? <BrowserEmpty lastUrl={browser.lastUrl} onOpen={(url) => { void browser.run({ kind: 'navigate', url }) }} />
          : null}
        {activePreview === undefined ? null : activePreview.source.kind === 'diff' ? <DevelopmentDiff key={`${activePreview.id}:${activePreview.revision}`} api={api} conversationId={activePreview.source.conversationId} {...(diffOwner === undefined ? {} : { worktree: { projectId: diffOwner.id } })} /> : <PreviewPane key={`${activePreview.id}:${String(activePreview.revision)}`} api={api} source={activePreview.source} />}
      </div>
    </section>
  )
}
