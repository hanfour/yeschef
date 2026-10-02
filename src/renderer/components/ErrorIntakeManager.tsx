import { useEffect, useRef, useState } from 'react'
import { notifyErrorIntakeChanged } from '../error-intake-events.js'
import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { ErrorIntakeResponse, ErrorIntakeSettingsView, ErrorIntakeStatus } from '../../shared/error-intake.js'
import type { ProjectView } from '../../shared/projects.js'
import './SkillsManager.css'
import './ErrorIntakeManager.css'

type Settings = Omit<ErrorIntakeSettingsView, 'hasAdminPassword' | 'hasAppPassword' | 'schemaVersion'>
const EMPTY: Settings = { host: '', port: 3306, database: '', tls: true, adminUsername: '', packageSource: '@yeschef/error-intake' }
const MSG = {
  passwordReentry: '加密的資料庫密碼無法解密。請重新輸入管理者密碼，並按「重新輸入密碼並恢復」更新連線。',
  passwordPlaceholder: '請重新輸入管理者密碼',
  recoverDatabase: '重新輸入密碼並恢復',
} as const

export interface ErrorIntakeManagerProps {
  readonly api: Pick<YesChefApi, 'manageErrorIntake'>
  readonly project?: ProjectView
  readonly onClose: () => void
}

interface FormState {
  readonly alive: React.MutableRefObject<boolean>
  readonly setSettings: React.Dispatch<React.SetStateAction<Settings>>
  readonly setHasPassword: React.Dispatch<React.SetStateAction<boolean>>
  readonly setStatus: React.Dispatch<React.SetStateAction<ErrorIntakeStatus | undefined>>
  readonly setError: React.Dispatch<React.SetStateAction<string>>
  readonly setPassword: React.Dispatch<React.SetStateAction<string>>
}

interface FormController {
  readonly settings: Settings
  readonly hasPassword: boolean
  readonly status: ErrorIntakeStatus | undefined
  readonly password: string
  readonly busy: boolean
  readonly error: string
  readonly setPassword: React.Dispatch<React.SetStateAction<string>>
  readonly setSettings: React.Dispatch<React.SetStateAction<Settings>>
  readonly save: (event: React.FormEvent) => void
  readonly initialize: (form: HTMLFormElement | null) => void
  readonly update: (key: keyof Settings) => (event: React.ChangeEvent<HTMLInputElement>) => void
}

export function ErrorIntakeManager({ api, project, onClose }: ErrorIntakeManagerProps): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const alive = useRef(true)
  const controller = useErrorIntakeForm(api, alive)

  useEffect(() => {
    alive.current = true
    dialog.current?.showModal()
    return () => { alive.current = false }
  }, [api])

  return (
    <dialog ref={dialog} className="skills-dialog error-intake-dialog" aria-labelledby="error-intake-title" onClose={onClose}>
      <header className="skills-heading">
        <div><h1 id="error-intake-title">錯誤收集資料庫</h1></div>
        <button type="button" className="skills-close" aria-label="關閉" onClick={onClose}>×</button>
      </header>
      <div className="skills-body"><ErrorIntakeForm controller={controller} api={api} project={project} /></div>
    </dialog>
  )
}

function useErrorIntakeForm(api: ErrorIntakeManagerProps['api'], alive: React.MutableRefObject<boolean>): FormController {
  const [settings, setSettings] = useState(EMPTY)
  const [hasPassword, setHasPassword] = useState(false)
  const [status, setStatus] = useState<ErrorIntakeStatus>()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const formState: FormState = { alive, setSettings, setHasPassword, setStatus, setError, setPassword }

  useEffect(() => { void loadInitial(api, formState) }, [api])

  const persist = (): Promise<boolean> => persistSettings(api, settings, password, formState)
  const run = (action: () => Promise<unknown>): Promise<void> => runAction(action, setBusy, setError, alive)
  const save = (event: React.FormEvent): void => { event.preventDefault(); void run(persist) }
  const initialize = (form: HTMLFormElement | null): void => {
    if (form !== null && !form.checkValidity()) { form.reportValidity(); return }
    void run(() => initializeDatabase(api, persist, formState, status?.passwordNeedsReentry === true))
  }
  const update = (key: keyof Settings) => (event: React.ChangeEvent<HTMLInputElement>): void => {
    const value = event.currentTarget.value
    if (key === 'port') setSettings((current) => ({ ...current, port: Number(value) }))
    else setSettings((current) => ({ ...current, [key]: value }))
  }

  return { settings, hasPassword, status, password, busy, error, setPassword, setSettings, save, initialize, update }
}

function ErrorIntakeForm({ controller, api, project }: {
  readonly controller: FormController
  readonly api: ErrorIntakeManagerProps['api']
  readonly project: ProjectView | undefined
}): React.ReactElement {
  const form = useRef<HTMLFormElement>(null)
  const { settings, status, busy, error, hasPassword, password } = controller
  return (
    <form ref={form} className="error-intake-form" onSubmit={controller.save}>
      <div className="error-intake-fields">
        <label>主機<input value={settings.host} onChange={controller.update('host')} autoComplete="off" required /></label>
        <label>連接埠<input type="number" min="1" max="65535" value={settings.port} onChange={controller.update('port')} required /></label>
        <label>資料庫<input value={settings.database} onChange={controller.update('database')} autoComplete="off" required /></label>
        <label>管理者帳號<input value={settings.adminUsername} onChange={controller.update('adminUsername')} autoComplete="username" required /></label>
        <label>{status?.passwordNeedsReentry ? '管理者密碼（需要重新輸入）' : '管理者密碼'}<input type="password" value={password} onChange={(event) => controller.setPassword(event.currentTarget.value)} autoComplete="new-password" required={status?.passwordNeedsReentry === true} placeholder={status?.passwordNeedsReentry ? MSG.passwordPlaceholder : hasPassword ? '已設定，留空表示不變更' : ''} /></label>
        <label className="error-intake-package-source">套件來源<input value={settings.packageSource} onChange={controller.update('packageSource')} autoComplete="off" required /></label>
        <label className="error-intake-tls"><input type="checkbox" checked={settings.tls} onChange={(event) => { const tls = event.currentTarget.checked; controller.setSettings((current) => ({ ...current, tls })) }} />TLS</label>
      </div>
      <ErrorIntakeStatusView status={status} />
      {status?.passwordNeedsReentry ? <p role="alert" className="error-intake-error">{MSG.passwordReentry}</p> : null}
      <ErrorIntakeProjectSection api={api} project={project} packageSource={settings.packageSource} schemaVersion={status?.schemaVersion ?? null} />
      {error === '' ? null : <p role="alert" className="error-intake-error">{error}</p>}
      <div className="error-intake-actions">
        <button type="submit" disabled={busy}>儲存</button>
        <button type="button" className="primary" onClick={() => controller.initialize(form.current)} disabled={busy}>{status?.passwordNeedsReentry ? MSG.recoverDatabase : '連線並初始化'}</button>
      </div>
    </form>
  )
}

type ProjectInfo = Extract<ErrorIntakeResponse, { kind: 'project' }>
type ProjectNotice = { readonly kind: 'status' | 'alert'; readonly text: string }

function ErrorIntakeProjectSection({ api, project, packageSource, schemaVersion }: {
  readonly api: ErrorIntakeManagerProps['api']; readonly project: ProjectView | undefined; readonly packageSource: string
  /** 資料庫初始化或版本改變時重讀專案狀態；否則第一次設定時啟用按鈕會停在「資料庫未就緒」。 */
  readonly schemaVersion: number | null
}): React.ReactElement {
  const [info, setInfo] = useState<ProjectInfo>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ProjectNotice | null>(null)
  useProjectInfo(api, project, schemaVersion, setInfo, setNotice)
  const copy = (): Promise<void> => project === undefined
    ? Promise.resolve()
    : copyProjectConnection(api, project.id, setBusy, setNotice)
  return (
    <section className="error-intake-project" aria-labelledby="error-intake-project-title">
      <h2 id="error-intake-project-title">目前專案</h2>
      {project === undefined ? <p>目前沒有開啟的專案</p> : <>
        <p className="error-intake-project-name">{project.name}</p>
        {info === undefined ? null : info.enabled
          ? <EnabledProjectSettings projectCode={info.projectCode ?? info.defaultProjectCode} onCopy={copy} busy={busy} />
          : <ErrorIntakeEnableSettings key={`${project.id}:${info.projectCode ?? info.defaultProjectCode}`}
            api={api} projectId={project.id} info={info} packageSource={packageSource}
            busy={busy} setBusy={setBusy} setInfo={setInfo} setNotice={setNotice} />}
      </>}
      {notice === null ? null : <p role={notice.kind} className="error-intake-project-message">{notice.text}</p>}
    </section>
  )
}

function useProjectInfo(
  api: ErrorIntakeManagerProps['api'], project: ProjectView | undefined, schemaVersion: number | null,
  setInfo: React.Dispatch<React.SetStateAction<ProjectInfo | undefined>>,
  setNotice: React.Dispatch<React.SetStateAction<ProjectNotice | null>>,
): void {
  const shownProject = useRef<string | undefined>(undefined)
  useEffect(() => {
    let active = true
    // 只有換專案才清空；同一專案因資料庫版本改變而重讀時保留畫面，使用者已勾的確認不會被清掉。
    if (shownProject.current !== project?.id) { setInfo(undefined); setNotice(null) }
    shownProject.current = project?.id
    if (project === undefined) return () => { active = false }
    api.manageErrorIntake({ action: 'project', projectId: project.id }).then((result) => {
      if (!active) return
      if (result.kind === 'project') setInfo(result)
      else if (result.kind === 'error') setNotice({ kind: 'alert', text: result.message })
    }).catch(() => { if (active) setNotice({ kind: 'alert', text: '目前專案設定讀取失敗' }) })
    return () => { active = false }
  }, [api, project?.id, schemaVersion, setInfo, setNotice])
}

function ErrorIntakeEnableSettings({ api, projectId, info, packageSource, busy, setBusy, setInfo, setNotice }: {
  readonly api: ErrorIntakeManagerProps['api']; readonly projectId: string; readonly info: ProjectInfo
  readonly packageSource: string; readonly busy: boolean
  readonly setBusy: React.Dispatch<React.SetStateAction<boolean>>
  readonly setInfo: React.Dispatch<React.SetStateAction<ProjectInfo | undefined>>
  readonly setNotice: React.Dispatch<React.SetStateAction<ProjectNotice | null>>
}): React.ReactElement {
  const [projectCode, setProjectCode] = useState(info.projectCode ?? info.defaultProjectCode)
  const [acknowledged, setAcknowledged] = useState(false)
  const enable = (): void => { void enableProject(api, projectId, projectCode, acknowledged, packageSource, setBusy, setInfo, setNotice) }
  return <>
    <label className="error-intake-project-code">專案代號<input value={projectCode} maxLength={28} pattern="[a-z0-9-]{1,28}" disabled={info.projectCodeLocked} onChange={(event) => setProjectCode(event.currentTarget.value)} /></label>
    {info.projectCodeLocked ? <p className="error-intake-hint">此專案已有寫入帳號，會沿用既有代號。</p> : null}
    <label className="error-intake-consent"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.currentTarget.checked)} />我了解拉錯誤交給主廚時，錯誤內容會送到模型供應商</label>
    {!info.databaseReady ? <p className="error-intake-hint">請先初始化錯誤資料庫並確認版本正確。</p> : null}
    <div className="error-intake-actions"><button type="button" className="primary" disabled={busy || !info.databaseReady || !acknowledged || !/^[a-z0-9-]{1,28}$/.test(projectCode)} onClick={enable}>啟用錯誤收集</button></div>
  </>
}

async function enableProject(
  api: ErrorIntakeManagerProps['api'], projectId: string, projectCode: string, acknowledged: boolean,
  packageSource: string, setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setInfo: React.Dispatch<React.SetStateAction<ProjectInfo | undefined>>,
  setNotice: React.Dispatch<React.SetStateAction<ProjectNotice | null>>,
): Promise<void> {
  setBusy(true); setNotice(null)
  try {
    const result = await api.manageErrorIntake({ action: 'enable', projectId, projectCode, acknowledged, packageSource })
    if (result.kind === 'enabled') {
      setInfo((current) => current === undefined ? current : { ...current, enabled: true, projectCode: result.projectCode })
      setNotice({ kind: 'status', text: '錯誤收集已啟用，主廚任務已建立' })
      notifyErrorIntakeChanged(projectId)
    } else if (result.kind === 'error') setNotice({ kind: 'alert', text: result.message })
  } catch { setNotice({ kind: 'alert', text: '錯誤收集啟用失敗' }) }
  finally { setBusy(false) }
}

async function copyProjectConnection(
  api: ErrorIntakeManagerProps['api'], projectId: string,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setNotice: React.Dispatch<React.SetStateAction<ProjectNotice | null>>,
): Promise<void> {
  setBusy(true); setNotice(null)
  try {
    const result = await api.manageErrorIntake({ action: 'copy-connection', projectId })
    const text = result.kind === 'copied' ? '已複製連線字串' : result.kind === 'error' ? result.message : '連線字串複製失敗'
    setNotice({ kind: result.kind === 'error' ? 'alert' : 'status', text })
  } catch { setNotice({ kind: 'alert', text: '連線字串複製失敗' }) }
  finally { setBusy(false) }
}

function EnabledProjectSettings({ projectCode, onCopy, busy }: {
  readonly projectCode: string; readonly onCopy: () => Promise<void>; readonly busy: boolean
}): React.ReactElement {
  return <>
    <label className="error-intake-project-code">專案代號<input value={projectCode} disabled /></label>
    <div className="error-intake-env-vars">
      <h3>部署環境變數</h3>
      <p><code>ERROR_INTAKE_DATABASE_URL</code><span>使用複製的連線字串，不會顯示在這裡。</span></p>
      <p><code>ERROR_INTAKE_PROJECT</code><span>設定為此專案的代號。</span></p>
      <p><code>APP_ENV</code><span>部署到 staging 或正式環境時，分別設定為 staging 或 production。</span></p>
    </div>
    <div className="error-intake-actions"><button type="button" disabled={busy} onClick={() => { void onCopy() }}>複製連線字串</button></div>
  </>
}

function ErrorIntakeStatusView({ status }: { readonly status: ErrorIntakeStatus | undefined }): React.ReactElement {
  return (
    <div className="error-intake-status" aria-live="polite">
      <div><span>資料庫連線</span><strong className={status?.connected && !status.passwordNeedsReentry ? 'is-ok' : 'is-missing'}>{status?.passwordNeedsReentry ? '需要重新輸入密碼' : status?.connected ? '可連線' : '無法連線'}</strong></div>
      <div><span>Schema 版本</span><strong>{status?.schemaVersion ?? '尚未初始化'}</strong></div>
      <div><span>上次清理</span><strong>{cleanupText(status)}</strong></div>
    </div>
  )
}

async function loadInitial(api: ErrorIntakeManagerProps['api'], state: FormState): Promise<void> {
  try {
    const [settings, status] = await Promise.all([
      api.manageErrorIntake({ action: 'get' }), api.manageErrorIntake({ action: 'status' }),
    ])
    if (!state.alive.current) return
    if (settings.kind === 'settings') applySettings(settings, state)
    else if (settings.kind === 'error') state.setError(settings.message)
    if (status.kind === 'status') state.setStatus(status.status)
    else if (status.kind === 'error') state.setError(status.message)
  } catch {
    if (state.alive.current) state.setError('錯誤收集資料庫設定讀取失敗')
  }
}

async function persistSettings(api: ErrorIntakeManagerProps['api'], settings: Settings, password: string, state: FormState): Promise<boolean> {
  const result = await api.manageErrorIntake({ action: 'save', settings: { ...settings, ...(password === '' ? {} : { adminPassword: password }) } })
  if (!state.alive.current) return false
  if (result.kind === 'error') { state.setError(result.message); return false }
  if (result.kind !== 'settings') { state.setError('錯誤收集資料庫設定回傳格式不正確'); return false }
  applySettings(result, state)
  state.setPassword('')
  const currentStatus = await api.manageErrorIntake({ action: 'status' })
  if (state.alive.current && currentStatus.kind === 'status') state.setStatus(currentStatus.status)
  else if (state.alive.current && currentStatus.kind === 'error') state.setError(currentStatus.message)
  return true
}

function applySettings(response: Extract<ErrorIntakeResponse, { kind: 'settings' }>, state: FormState): void {
  const { hasAdminPassword, hasAppPassword: _hasAppPassword, schemaVersion: _schemaVersion, ...form } = response.settings
  state.setSettings(form)
  state.setHasPassword(hasAdminPassword)
}

async function initializeDatabase(
  api: ErrorIntakeManagerProps['api'], persist: () => Promise<boolean>, state: FormState, recovery: boolean,
): Promise<void> {
  if (!(await persist())) return
  const result = await api.manageErrorIntake({ action: 'initialize', ...(recovery ? { recovery: true } : {}) })
  if (!state.alive.current) return
  if (result.kind === 'error') { state.setError(result.message); return }
  if (result.kind !== 'initialized') { state.setError('錯誤收集資料庫回傳格式不正確'); return }
  state.setStatus(result.status)
  state.setError('')
}

async function runAction(action: () => Promise<unknown>, setBusy: React.Dispatch<React.SetStateAction<boolean>>, setError: React.Dispatch<React.SetStateAction<string>>, alive: React.MutableRefObject<boolean>): Promise<void> {
  setBusy(true)
  setError('')
  try { await action() } catch { if (alive.current) setError('錯誤收集資料庫操作失敗') }
  finally { if (alive.current) setBusy(false) }
}

function cleanupText(status: ErrorIntakeStatus | undefined): string {
  if (status?.lastCleanupAt === null || status?.lastCleanupAt === undefined) return '尚未執行'
  const result = status.lastCleanup
  if (result === null) return new Date(status.lastCleanupAt).toLocaleString('zh-TW')
  const outcome = result.ok ? '完成' : '失敗'
  return `${new Date(status.lastCleanupAt).toLocaleString('zh-TW')}，${outcome}（刪除 ${result.deletedEvents} 筆樣本、${result.deletedGroups} 個群組）`
}
