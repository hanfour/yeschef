import type React from 'react'
import { useContext, useRef } from 'react'
import { useActiveTabVisibility } from '../hooks/useActiveTabVisibility.js'
import type { Projects } from '../hooks/useProjects.js'
import type { ProjectView } from '../../shared/projects.js'
import type { ProjectRunStatus } from '../../shared/project-run.js'
import './ProjectBar.css'
import './Busy.css'
import { Icon } from './Icon.js'
import { tabKeyboard } from '../tab-keyboard.js'
import { BrowserSessionsContext } from '../browser-context.js'

export interface ProjectBarProps {
  readonly projects: Projects
  readonly projectRunStatuses?: Readonly<Record<string, ProjectRunStatus>>
}

function chipClass(p: ProjectView, on: boolean): string {
  return ['project-chip', on ? 'on' : '', p.available ? '' : 'unavailable'].filter((c) => c !== '').join(' ')
}

function serviceStatusLabel(status: ProjectRunStatus | undefined): string {
  if (status === undefined || status.state === 'stopped') return ''
  if (status.state === 'running') return '專案服務執行中'
  if (status.state === 'failed') return '專案服務啟動失敗'
  return '專案服務狀態變更中'
}

/**
 * 分頁列上方那一列專案(規格 §5)。只畫 `projects.view`,所有動作送回主行程,
 * 主行程改完狀態再推新的 view 回來;這裡沒有自己的狀態。
 */
export function ProjectBar({ projects, projectRunStatuses = {} }: ProjectBarProps): React.ReactElement {
  const { view, error } = projects
  const browserSessions = useContext(BrowserSessionsContext)
  const tabsRef = useRef<HTMLDivElement>(null)
  useActiveTabVisibility(tabsRef, view.activeId)
  return (
    <div className="project-bar-wrap">
      <div ref={tabsRef} className="project-bar" role="tablist" aria-label="專案">
        {view.projects.map((p) => {
          const on = p.id === view.activeId
          const runStatus = projectRunStatuses[p.id]
          const runStatusLabel = serviceStatusLabel(runStatus)
          return (
            <div
              key={p.id}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={p.rootPath}
              onKeyDown={event => tabKeyboard(event, () => projects.activate(p.id))}
              className={chipClass(p, on)}
              onClick={() => projects.activate(p.id)}
            >
              <Icon name="folder" /><span className="project-name">{p.name}</span>
              {runStatusLabel === '' || runStatus === undefined ? null : (
                <span className={`project-run-dot ${runStatus.state}`} role="img" aria-label={runStatusLabel} title={runStatusLabel} />
              )}
              {p.tabs.some((t) => browserSessions.some((s) => s.busy && s.conversationId === t.id)) ? (
                <span className="project-browser" role="img" aria-label="瀏覽器操作中" title="瀏覽器操作中"><Icon name="globe" /></span>
              ) : null}
              {p.busyTabIds.length > 0 ? (
                <span className="project-busy" role="img" aria-label="執行中" title="執行中">◐</span>
              ) : null}
              {p.pendingApproval ? (
                <span className="project-pending" role="img" aria-label="有待批准的請求" title="有待批准的請求">
                  ●
                </span>
              ) : null}
              {p.available ? null : (
                <span className="project-unavailable" role="img" aria-label="資料夾不存在" title="資料夾不存在">
                  !
                </span>
              )}
              <button
                type="button"
                className="project-remove"
                aria-label={`移除專案 ${p.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  projects.remove(p.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="project-add"
          aria-label="加入專案"
          onClick={() => {
            void projects.add()
          }}
        >
          +
        </button>
      </div>
      {error === undefined ? null : (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
