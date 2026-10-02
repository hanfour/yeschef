import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { ErrorIntakeEnvironment, ErrorIntakePullGroup, ErrorIntakeResponse } from '../../shared/error-intake.js'
import type { YesChefApi } from '../../shared/ipc.js'
import { formatRelativeTime } from './relative-time.js'
import './SkillsManager.css'
import './ErrorPullDialog.css'

const STORAGE_KEY = 'error-pull-environment'
type PullList = Extract<ErrorIntakeResponse, { kind: 'pull-list' }>

export interface ErrorPullDialogProps {
  readonly api: Pick<YesChefApi, 'manageErrorIntake'>
  readonly projectId: string
  readonly onClose: () => void
  readonly onStarted: () => void
  readonly now?: () => number
}

interface PullListController {
  readonly environment: ErrorIntakeEnvironment | ''
  readonly data: PullList | undefined
  readonly selected: string[]
  readonly loading: boolean
  readonly busy: boolean
  readonly error: string
  readonly chooseEnvironment: (value: ErrorIntakeEnvironment) => void
  readonly toggleGroup: (id: string, checked: boolean) => void
  readonly submit: () => void
  readonly changeStatus: (id: string, status: 'new' | 'resolved' | 'ignored') => void
}

export function ErrorPullDialog({ api, projectId, onClose, onStarted, now = Date.now }: ErrorPullDialogProps): React.ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const selection = useErrorSelection()
  const list = usePullList(api, projectId, selection.keep, selection.clear)
  const actions = usePullActions(api, projectId, selection.selected, list, onStarted, onClose)

  useEffect(() => { dialogRef.current?.showModal() }, [])

  const controller: PullListController = {
    ...list, selected: selection.selected, toggleGroup: selection.toggleGroup, ...actions,
  }
  return <dialog ref={dialogRef} className="skills-dialog error-pull-dialog" aria-labelledby="error-pull-title"
    onCancel={event => { event.preventDefault(); onClose() }} onClose={onClose}>
    <header className="skills-heading">
      <div><h1 id="error-pull-title">拉錯誤</h1></div>
      <button type="button" className="skills-close" aria-label="關閉拉錯誤" onClick={onClose}>×</button>
    </header>
    <ErrorPullDialogBody controller={controller} now={now} />
  </dialog>
}

function usePullList(api: ErrorPullDialogProps['api'], projectId: string, keepSelection: (ids: readonly string[]) => void, clearSelection: () => void) {
  // 只有使用者選的環境會觸發查詢；主行程回報「選了哪個環境」只用來顯示。
  // 否則第一次打開時會因環境從未指定變成選定值而再載入一次，剛勾的錯誤被清空（實機驗收時發現）。
  const [requested, setRequested] = useState<ErrorIntakeEnvironment | ''>(() => readEnvironment(projectId) ?? '')
  const [data, setData] = useState<PullList>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    const request = requested === '' ? { action: 'pull-list' as const, projectId } : { action: 'pull-list' as const, projectId, environment: requested }
    void api.manageErrorIntake(request).then(response => {
      if (!active) return
      if (response.kind === 'pull-list') {
        setData(response); rememberEnvironment(projectId, response.selectedEnvironment); setError('')
        // 重新載入時只拿掉已不在新清單裡的錯誤，不整個清空。
        keepSelection(response.newGroups.map(group => group.id))
      } else if (response.kind === 'error') setError(response.message)
    }).catch(() => { if (active) setError('錯誤清單讀取失敗') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, projectId, requested, refresh, keepSelection])

  const environment = data?.selectedEnvironment ?? requested
  return { environment, data, loading, error, setError, setLoading, chooseEnvironment: (value: ErrorIntakeEnvironment) => {
    if (value === environment) return
    setLoading(true); setRequested(value); rememberEnvironment(projectId, value); clearSelection()
  }, refresh: () => setRefresh(value => value + 1) }
}

function useErrorSelection() {
  const [selected, setSelected] = useState<string[]>([])
  const clear = useCallback(() => setSelected([]), [])
  const keep = useCallback((ids: readonly string[]) => setSelected(current => current.filter(id => ids.includes(id))), [])
  const toggleGroup = useCallback((id: string, checked: boolean): void => setSelected(current => checked
    ? current.length >= 10 || current.includes(id) ? current : [...current, id]
    : current.filter(value => value !== id)), [])
  return { selected, toggleGroup, clear, keep }
}

function usePullActions(
  api: ErrorPullDialogProps['api'], projectId: string, selected: readonly string[],
  list: ReturnType<typeof usePullList>, onStarted: () => void, onClose: () => void,
) {
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (busy || selected.length === 0) return
    setBusy(true); list.setError('')
    try {
      const response = await api.manageErrorIntake({ action: 'start-fix', projectId, groupIds: [...selected] })
      if (response.kind === 'fix-started') { onStarted(); onClose() }
      else if (response.kind === 'error') list.setError(response.message)
    } catch { list.setError('主廚任務無法開始，請重試') }
    finally { setBusy(false) }
  }
  const changeStatus = async (id: string, status: 'new' | 'resolved' | 'ignored'): Promise<void> => {
    setBusy(true); list.setError('')
    try {
      const response = await api.manageErrorIntake({ action: 'set-group-status', projectId, groupId: id, status })
      if (response.kind === 'error') list.setError(response.message)
      else list.refresh()
    } catch { list.setError('錯誤狀態更新失敗') }
    finally { setBusy(false) }
  }
  return { busy, submit: () => { void submit() }, changeStatus: (id: string, status: 'new' | 'resolved' | 'ignored') => { void changeStatus(id, status) } }
}

function ErrorPullDialogBody({ controller, now }: {
  readonly controller: PullListController
  readonly now: () => number
}): React.ReactElement {
  return <div className="skills-body error-pull-body">
    <EnvironmentPicker controller={controller} />
    <NewErrorsSection controller={controller} now={now} />
    <InProgressSection controller={controller} now={now} />
    {controller.error === '' ? null : <p role="alert" className="error-pull-error">{controller.error}</p>}
    <div className="error-pull-actions">
      <button type="button" className="primary" disabled={controller.busy || controller.loading || controller.selected.length === 0} onClick={controller.submit}>
        交給主廚{controller.selected.length > 0 ? `（${controller.selected.length}）` : ''}
      </button>
    </div>
  </div>
}

function EnvironmentPicker({ controller }: { readonly controller: PullListController }): React.ReactElement {
  return <label className="error-pull-environment">環境
    <select aria-label="錯誤環境" value={controller.environment} onChange={event => controller.chooseEnvironment(event.currentTarget.value as ErrorIntakeEnvironment)}
      disabled={!controller.data || controller.busy || controller.loading}>
      {(controller.data?.environments ?? []).map(value => <option key={value} value={value}>{environmentLabel(value)}</option>)}
    </select>
  </label>
}

function NewErrorsSection({ controller, now }: { readonly controller: PullListController; readonly now: () => number }): React.ReactElement {
  const groups = controller.data?.newGroups ?? []
  return <section className="error-pull-section" aria-labelledby="error-pull-new-title">
    <h2 id="error-pull-new-title">新錯誤 <span>{groups.length}</span></h2>
    {groups.length === 0 ? <EmptyList data={controller.data} text="這個環境目前沒有新錯誤" /> : <ul className="error-pull-list">
      {groups.map(group => <li key={group.id}><NewErrorRow group={group} checked={controller.selected.includes(group.id)}
        disabled={controller.busy || controller.loading || (controller.selected.length >= 10 && !controller.selected.includes(group.id))}
        now={now()} onChange={checked => controller.toggleGroup(group.id, checked)} /></li>)}
    </ul>}
  </section>
}

function InProgressSection({ controller, now }: { readonly controller: PullListController; readonly now: () => number }): React.ReactElement {
  const groups = controller.data?.inProgressGroups ?? []
  return <section className="error-pull-section" aria-labelledby="error-pull-progress-title">
    <h2 id="error-pull-progress-title">處理中 <span>{groups.length}</span></h2>
    {groups.length === 0 ? <EmptyList data={controller.data} text="目前沒有處理中的錯誤" /> : <ul className="error-pull-list">
      {groups.map(group => <li key={group.id}><InProgressErrorRow group={group} disabled={controller.busy || controller.loading}
        now={now()} onStatus={status => controller.changeStatus(group.id, status)} /></li>)}
    </ul>}
  </section>
}

function EmptyList({ data, text }: { readonly data: PullList | undefined; readonly text: string }): React.ReactElement {
  return <p className="error-pull-empty">{data ? text : '正在讀取錯誤清單…'}</p>
}

function NewErrorRow({ group, checked, disabled, now, onChange }: {
  readonly group: ErrorIntakePullGroup
  readonly checked: boolean
  readonly disabled: boolean
  readonly now: number
  readonly onChange: (checked: boolean) => void
}): React.ReactElement {
  return <div className="error-pull-row">
    <label className="error-pull-select">
      <input type="checkbox" aria-label={`選取錯誤群 ${group.id}`} checked={checked} disabled={disabled}
        onChange={event => onChange(event.currentTarget.checked)} />
    </label>
    <div className="error-pull-details">
      <div className="error-pull-title-line"><strong>{group.errorType}</strong>
        {group.regressedAt === null ? null : <span className="error-pull-regressed">再次出現</span>}
        <span className="error-pull-count">{group.count} 次</span></div>
      <span className="error-pull-message" title={group.message}>{group.message}</span>
      <div className="error-pull-meta"><span>{formatRelativeTime(Date.parse(group.lastSeenAt), now)}</span><span>{group.route ?? '沒有路由'}</span></div>
    </div>
  </div>
}

function InProgressErrorRow({ group, disabled, now, onStatus }: {
  readonly group: ErrorIntakePullGroup
  readonly disabled: boolean
  readonly now: number
  readonly onStatus: (status: 'new' | 'resolved' | 'ignored') => void
}): React.ReactElement {
  return <div className="error-pull-progress-row">
    <div className="error-pull-details">
      <div className="error-pull-title-line"><strong>{group.errorType}</strong><span className="error-pull-count">{group.count} 次</span></div>
      <span className="error-pull-message" title={group.message}>{group.message}</span>
      <div className="error-pull-meta"><span>{formatRelativeTime(Date.parse(group.lastSeenAt), now)}</span><span>{group.route ?? '沒有路由'}</span></div>
      <span className="error-pull-note">{group.statusNote ?? '沒有任務備註'}</span>
    </div>
    <label className="error-pull-status">狀態
      <select aria-label={`錯誤群 ${group.id} 狀態`} value="in_progress" disabled={disabled} onChange={event => {
        const value = event.currentTarget.value
        if (value === 'new' || value === 'resolved' || value === 'ignored') onStatus(value)
      }}>
        <option value="in_progress">處理中</option><option value="new">新錯誤</option>
        <option value="resolved">已解決</option><option value="ignored">忽略</option>
      </select>
    </label>
  </div>
}

function readEnvironment(projectId: string): ErrorIntakeEnvironment | undefined {
  try {
    const value = localStorage.getItem(`${STORAGE_KEY}:${projectId}`)
    return value === 'local' || value === 'staging' || value === 'production' ? value : undefined
  } catch { return undefined }
}

function rememberEnvironment(projectId: string, value: ErrorIntakeEnvironment): void {
  try { localStorage.setItem(`${STORAGE_KEY}:${projectId}`, value) } catch { /* 儲存空間不可用時維持本次選擇。 */ }
}

function environmentLabel(value: ErrorIntakeEnvironment): string {
  if (value === 'production') return '正式環境'
  if (value === 'staging') return '預備環境'
  return '本機環境'
}
