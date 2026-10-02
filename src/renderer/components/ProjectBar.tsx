import type React from 'react'
import { useContext, useRef } from 'react'
import { useActiveTabVisibility } from '../hooks/useActiveTabVisibility.js'
import type { Projects } from '../hooks/useProjects.js'
import type { ProjectView } from '../../shared/projects.js'
import './ProjectBar.css'
import './Busy.css'
import { Icon } from './Icon.js'
import { tabKeyboard } from '../tab-keyboard.js'
import { BrowserSessionsContext } from '../browser-context.js'

export interface ProjectBarProps {
  readonly projects: Projects
}

function chipClass(p: ProjectView, on: boolean): string {
  return ['project-chip', on ? 'on' : '', p.available ? '' : 'unavailable'].filter((c) => c !== '').join(' ')
}

/**
 * 分頁列上方那一列專案(規格 §5)。只畫 `projects.view`,所有動作送回主行程,
 * 主行程改完狀態再推新的 view 回來;這裡沒有自己的狀態。
 */
export function ProjectBar({ projects }: ProjectBarProps): React.ReactElement {
  const { view, error } = projects
  const browserSessions = useContext(BrowserSessionsContext)
  const tabsRef = useRef<HTMLDivElement>(null)
  useActiveTabVisibility(tabsRef, view.activeId)
  return (
    <div className="project-bar-wrap">
      <div ref={tabsRef} className="project-bar" role="tablist" aria-label="專案">
        {view.projects.map((p) => {
          const on = p.id === view.activeId
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
