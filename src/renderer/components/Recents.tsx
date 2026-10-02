import { useState } from 'react'
import type { SessionSummary } from '../../shared/ipc.js'
import type { ThreadEntry } from '../../shared/projects.js'
import { groupSessions, type ThreadGroup } from '../recents-groups.js'
import { formatRelativeTime } from './relative-time.js'
import './Recents.css'
import { Icon } from './Icon.js'

export type SessionScope = 'project' | 'all'

export interface RecentsProps {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly onOpen: (sessionId: string) => void
  readonly onStartNew: () => void
  readonly error?: string
  /** 用來分組的 thread;沒給就每一筆各自一列。 */
  readonly threads?: readonly ThreadEntry[]
  readonly scope?: SessionScope
  /** 沒給就不畫「本專案／全部」切換(沒有 active 專案時)。 */
  readonly onScopeChange?: (scope: SessionScope) => void
}

/** 裁決 7 的 SessionSummary 兩個欄位都可能是標題,customTitle 是使用者自己下的,優先。 */
function titleOf(s: SessionSummary): string {
  const custom = (s.customTitle ?? '').trim()
  return custom === '' ? s.summary : custom
}

interface ItemProps {
  readonly s: SessionSummary
  readonly current: string | undefined
  readonly at: number
  readonly showCwd: boolean
  readonly onOpen: (sessionId: string) => void
}

function SessionItem({ s, current, at, showCwd, onOpen }: ItemProps) {
  const isCurrent = s.sessionId === current
  return (
    <button
      type="button"
      className={isCurrent ? 'recents-item is-current' : 'recents-item'}
      aria-current={isCurrent ? 'true' : undefined}
      title={titleOf(s)}
      onClick={() => {
        onOpen(s.sessionId)
      }}
    >
      <span className="recents-title">{titleOf(s)}</span>
      <span className="recents-meta">
        <time dateTime={new Date(s.lastModified).toISOString()}>{formatRelativeTime(s.lastModified, at)}</time>
        {s.gitBranch === undefined ? null : <span className="recents-branch">{s.gitBranch}</span>}
      </span>
      {showCwd && s.cwd !== undefined ? <span className="recents-cwd">{s.cwd}</span> : null}
    </button>
  )
}

interface GroupProps extends Omit<ItemProps, 's'> {
  readonly group: ThreadGroup
  readonly open: boolean
  readonly onToggle: () => void
}

function Group({ group, open, onToggle, ...item }: GroupProps) {
  return (
    <li className="recents-group">
      <SessionItem s={group.head} {...item} />
      {group.rest.length === 0 ? null : (
        <>
          <button type="button" className="recents-expand" aria-expanded={open} onClick={onToggle}>
            {open ? '收合' : `+${group.rest.length} 筆較早`}
          </button>
          {open ? (
            <ul className="recents-rest">
              {group.rest.map((s) => (
                <li key={s.sessionId}>
                  <SessionItem s={s} {...item} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </li>
  )
}

export function Recents({
  sessions,
  current,
  onOpen,
  onStartNew,
  error,
  threads = [],
  scope = 'project',
  onScopeChange,
}: RecentsProps) {
  const at = Date.now()
  const [opened, setOpened] = useState<readonly string[]>([])
  const [search, setSearch] = useState('')
  const toggle = (key: string) => {
    setOpened((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }
  const query = search.trim().toLocaleLowerCase()
  const filtered = query ? sessions.filter(session => [titleOf(session), session.summary, session.gitBranch, session.cwd].some(value => value?.toLocaleLowerCase().includes(query))) : sessions
  const groups = groupSessions(filtered, threads)

  return (
    <nav className="recents" aria-label="歷史對話">
      <div className="recents-heading"><span>歷史對話</span><span>{sessions.length}</span></div>
      <button type="button" className="recents-new" onClick={onStartNew}>
        <Icon name="plus" />新對話
      </button>
      <label className="recents-search"><Icon name="search" /><input type="search" aria-label="搜尋歷史對話" placeholder="搜尋對話…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      {onScopeChange === undefined ? null : (
        <div className="recents-scope" role="group" aria-label="範圍">
          <button type="button" aria-pressed={scope === 'project'} onClick={() => onScopeChange('project')}>
            本專案
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => onScopeChange('all')}>
            全部
          </button>
        </div>
      )}
      {error === undefined ? null : (
        <p className="recents-error" role="alert">
          {error}
        </p>
      )}
      {/* 有錯誤時不顯示「還沒有歷史對話」:讀不到跟真的沒有是兩件事,
          顯示成後者等於用一句安慰的話蓋掉一個故障。 */}
      {error === undefined && sessions.length === 0 ? <p className="recents-empty">還沒有歷史對話</p> : null}
      {query && sessions.length > 0 && filtered.length === 0 && <p className="recents-empty" role="status">找不到符合的對話</p>}
      <ul className="recents-list">
        {groups.map((g) => (
          <Group
            key={g.key}
            group={g}
            open={opened.includes(g.key)}
            onToggle={() => toggle(g.key)}
            current={current}
            at={at}
            showCwd={scope === 'all'}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </nav>
  )
}
