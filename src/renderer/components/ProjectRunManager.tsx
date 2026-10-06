import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import { ProjectRunConfigSchema, type ProjectRunCandidate, type ProjectRunConfig, type ProjectRunRequest, type ProjectRunResponse, type ProjectRunStatus, type ProjectRunUpdate } from '../../shared/project-run.js'
import { Icon } from './Icon.js'
import './SkillsManager.css'
import './ProjectRunManager.css'

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.yeschef']
type Api = Pick<YesChefApi, 'manageProjectRun' | 'onProjectRunUpdate'>
interface Draft {
  readonly command: string
  readonly cwd: string
  readonly port: string
  readonly url: string
  readonly readyPath: string
  readonly envText: string
  readonly portStrategy: 'fixed' | 'placeholder'
  readonly watchEnabled: boolean
  readonly includeText: string
  readonly excludeText: string
  readonly openInBrowser: boolean
}

export interface ProjectRunManagerProps {
  readonly api: Api
  readonly projectId: string
  readonly projectName: string
  readonly autoStart?: boolean
  readonly onRevealBrowser: () => void
  readonly onClose: () => void
}

function initialDraft(candidate?: ProjectRunCandidate): Draft {
  const frontend = /vite|next|astro|webpack/i.test(`${candidate?.command ?? ''} ${candidate?.source ?? ''}`)
  return {
    command: candidate?.command ?? '', cwd: candidate?.cwd ?? '.', port: candidate?.port === null || candidate === undefined ? '' : String(candidate.port),
    url: 'http://127.0.0.1:{port}/', readyPath: '/', envText: '', portStrategy: candidate?.portStrategy ?? 'fixed',
    watchEnabled: candidate?.watchEnabled ?? !frontend, includeText: candidate?.source.startsWith('Python ') ? '**/*.py' : '**/*',
    excludeText: DEFAULT_EXCLUDES.join('\n'), openInBrowser: true,
  }
}

function draftFromConfig(config: ProjectRunConfig): Draft {
  return {
    command: config.command, cwd: config.cwd, port: String(config.port), url: config.url, readyPath: config.readyPath,
    envText: Object.entries(config.env).map(([key, value]) => `${key}=${value}`).join('\n'),
    portStrategy: config.portStrategy, watchEnabled: config.watch.enabled,
    includeText: config.watch.include.join('\n'), excludeText: config.watch.exclude.join('\n'), openInBrowser: config.openInBrowser,
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean)
}

function parseEnv(value: string): Record<string, string> | undefined {
  const entries = lines(value).map(line => {
    const separator = line.indexOf('=')
    return separator < 1 ? undefined : [line.slice(0, separator).trim(), line.slice(separator + 1)] as const
  })
  if (entries.some(entry => entry === undefined)) return undefined
  return Object.fromEntries(entries as readonly (readonly [string, string])[])
}

function statusLabel(status: ProjectRunStatus): string {
  return ({ stopped: '已停止', starting: '啟動中', running: '執行中', restarting: '重新啟動中', failed: '啟動失敗' })[status.state]
}

function stateResponse(response: ProjectRunResponse): response is Extract<ProjectRunResponse, { kind: 'state' }> {
  return response.kind === 'state'
}

export function ProjectRunManager({ api, projectId, projectName, autoStart = false, onRevealBrowser, onClose }: ProjectRunManagerProps): React.ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const revealBrowser = useRef(onRevealBrowser)
  const [response, setResponse] = useState<ProjectRunResponse>()
  const [draft, setDraft] = useState<Draft>(() => initialDraft())
  const [editing, setEditing] = useState(false)
  const [candidateIndex, setCandidateIndex] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { revealBrowser.current = onRevealBrowser }, [onRevealBrowser])

  useEffect(() => {
    let alive = true
    let latest: ProjectRunUpdate | undefined
    const unsubscribe = api.onProjectRunUpdate(update => {
      if (update.projectId !== projectId) return
      latest = update
      setResponse(current => current === undefined || !stateResponse(current) ? current : {
        ...current, snapshot: update.snapshot, logs: update.logs,
      })
    })
    const load = async (): Promise<void> => {
      setBusy(true)
      try {
        let result = await api.manageProjectRun({ action: 'get', projectId })
        if (result.kind === 'state' && result.config === undefined) {
          setDraft(initialDraft(result.candidates[0]))
          setCandidateIndex(result.candidates.length === 0 ? '' : '0')
          setEditing(true)
        } else if (result.kind === 'state' && result.config !== undefined) {
          setDraft(draftFromConfig(result.config))
          if (autoStart && result.snapshot.state === 'stopped') {
            result = await api.manageProjectRun({ action: 'start', projectId })
          }
        }
        if (!alive) return
        if (latest !== undefined && result.kind === 'state') result = { ...result, snapshot: latest.snapshot, logs: latest.logs }
        setResponse(result)
        if (autoStart && result.kind === 'state' && result.config?.openInBrowser && result.snapshot.state === 'running') revealBrowser.current()
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : '專案執行狀態讀取失敗')
      } finally {
        if (alive) setBusy(false)
      }
    }
    void load()
    return () => { alive = false; unsubscribe() }
  }, [api, projectId, autoStart])

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
  }, [])

  const runRequest = async (request: ProjectRunRequest): Promise<ProjectRunResponse | undefined> => {
    setBusy(true)
    setError('')
    try {
      const next = await api.manageProjectRun(request)
      setResponse(next)
      if (next.kind === 'error') setError(next.message)
      return next
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '專案執行操作失敗'
      setError(message)
      return undefined
    } finally { setBusy(false) }
  }

  const saveAndRun = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const env = parseEnv(draft.envText)
    if (env === undefined) { setError('環境變數請使用 KEY=VALUE 格式'); return }
    const config = {
      version: 1, command: draft.command, cwd: draft.cwd, port: Number(draft.port), url: draft.url,
      readyPath: draft.readyPath, env, portStrategy: draft.portStrategy,
      watch: { enabled: draft.watchEnabled, include: lines(draft.includeText), exclude: lines(draft.excludeText) },
      openInBrowser: draft.openInBrowser,
    }
    const parsed = ProjectRunConfigSchema.safeParse(config)
    if (!parsed.success) {
      setError(draft.portStrategy === 'placeholder' && !draft.command.includes('{port}') && !draft.envText.includes('{port}')
        ? '啟動指令或環境變數需包含 {port}'
        : '設定欄位不正確，請檢查連接埠、網址與工作目錄')
      return
    }
    const saved = await runRequest({ action: 'save', projectId, config: parsed.data })
    if (saved?.kind !== 'state') return
    const started = await runRequest({ action: 'start', projectId })
    if (started?.kind === 'state') {
      setEditing(false)
      if (parsed.data.openInBrowser && started.snapshot.state === 'running') onRevealBrowser()
    }
  }

  const invoke = async (request: ProjectRunRequest): Promise<void> => {
    const result = await runRequest(request)
    if (result?.kind === 'state' && request.action === 'open') onRevealBrowser()
    if (result?.kind === 'state' && request.action === 'refresh') setError('')
  }

  const updateDraft = (key: keyof Draft, value: string | boolean): void => setDraft(current => ({ ...current, [key]: value }))
  const current = response?.kind === 'state' ? response : undefined
  const status = current?.snapshot
  const visibleLogs = (current?.logs ?? []).slice(status?.state === 'failed' ? -40 : -200)
  const canUseFreePort = status?.state === 'failed' && status.conflict !== undefined && current?.config?.portStrategy === 'placeholder'

  return (
    <dialog ref={dialog} className="skills-dialog project-run-dialog" aria-labelledby="project-run-title" onClose={onClose}
      onCancel={event => { event.preventDefault(); onClose() }}>
      <header className="skills-heading">
        <div><h1 id="project-run-title">{editing ? '設定執行方式' : '專案執行'}</h1><p>{projectName}</p></div>
        <button type="button" onClick={onClose}>關閉</button>
      </header>
      {editing || current?.config === undefined ? (
        <form className="project-run-settings" onSubmit={event => { void saveAndRun(event) }}>
          {current?.candidates.length ? <label>偵測候選
            <select value={candidateIndex} onChange={event => {
              const index = event.currentTarget.value
              setCandidateIndex(index)
              setDraft(initialDraft(index === '' ? undefined : current.candidates[Number(index)]))
            }}>
              {current.candidates.map((candidate, index) => <option key={`${candidate.source}-${index}`} value={index}>{candidate.source}</option>)}
              <option value="">自訂</option>
            </select>
          </label> : null}
          <label>啟動指令<textarea aria-label="啟動指令" value={draft.command} onChange={event => updateDraft('command', event.currentTarget.value)} rows={2} required /></label>
          <div className="project-run-fields">
            <label>工作目錄<input value={draft.cwd} onChange={event => updateDraft('cwd', event.currentTarget.value)} required /></label>
            <label>連接埠<input aria-label="連接埠" type="number" min="1" max="65535" value={draft.port} onChange={event => updateDraft('port', event.currentTarget.value)} required /></label>
          </div>
          <label>服務網址<input value={draft.url} onChange={event => updateDraft('url', event.currentTarget.value)} required /></label>
          <label>準備路徑<input value={draft.readyPath} onChange={event => updateDraft('readyPath', event.currentTarget.value)} required /></label>
          <label>環境變數（不含密碼）<textarea value={draft.envText} onChange={event => updateDraft('envText', event.currentTarget.value)} rows={2} /></label>
          <label>連接埠策略<select value={draft.portStrategy} onChange={event => updateDraft('portStrategy', event.currentTarget.value as Draft['portStrategy'])}>
            <option value="fixed">固定連接埠</option><option value="placeholder">可替換連接埠</option>
          </select></label>
          <label className="project-run-check"><input type="checkbox" checked={draft.watchEnabled} onChange={event => updateDraft('watchEnabled', event.currentTarget.checked)} />檔案變動時重啟</label>
          <div className="project-run-fields">
            <label>監看檔案<textarea value={draft.includeText} onChange={event => updateDraft('includeText', event.currentTarget.value)} rows={3} /></label>
            <label>排除路徑<textarea value={draft.excludeText} onChange={event => updateDraft('excludeText', event.currentTarget.value)} rows={3} /></label>
          </div>
          <label className="project-run-check"><input type="checkbox" checked={draft.openInBrowser} onChange={event => updateDraft('openInBrowser', event.currentTarget.checked)} />服務就緒後在右側打開</label>
          {error ? <p className="project-run-error" role="alert">{error}</p> : null}
          <footer className="project-run-actions">
            {current?.config ? <button type="button" onClick={() => { setDraft(draftFromConfig(current.config!)); setEditing(false); setError('') }}>取消</button> : null}
            <button type="submit" className="primary" disabled={busy || draft.port === ''}>保存並執行</button>
          </footer>
        </form>
      ) : (
        <section className="project-run-panel">
          <div className="project-run-status-row">
            <span className={`project-run-status-dot ${status?.state ?? 'stopped'}`} aria-hidden="true" />
            <strong>{status ? statusLabel(status) : '讀取中'}</strong>
            {status?.pid === undefined ? null : <span>PID {status.pid}</span>}
            {status?.port === undefined ? null : <span>連接埠 {status.port}</span>}
          </div>
          {status?.url ? <a className="project-run-url" href={status.url} onClick={event => { event.preventDefault(); void invoke({ action: 'open', projectId }) }}>{status.url}</a> : null}
          {status?.error ? <p className="project-run-error" role="alert">{status.error}</p> : null}
          {status?.conflict ? <p className="project-run-conflict">連接埠由 {status.conflict.projectName === undefined ? status.conflict.processName : `專案「${status.conflict.projectName}」`} 使用（PID {status.conflict.pid}）</p> : null}
          {status?.restarted ? <p className="project-run-restarted" role="status">服務已重啟 <button type="button" onClick={() => { void invoke({ action: 'refresh', projectId }) }}><Icon name="reload" />重新整理</button></p> : null}
          <div className="project-run-actions">
            {status?.state === 'running' || status?.state === 'starting' || status?.state === 'restarting'
              ? <><button type="button" onClick={() => { void invoke({ action: 'stop', projectId }) }} disabled={busy}><Icon name="stop" />停止</button>
                <button type="button" onClick={() => { void invoke({ action: 'restart', projectId }) }} disabled={busy}><Icon name="reload" />重啟</button>
                <button type="button" onClick={() => { void invoke({ action: 'open', projectId }) }} disabled={busy}><Icon name="globe" />在右側打開</button></>
              : <button type="button" className="primary" onClick={() => { void invoke({ action: 'start', projectId }) }} disabled={busy}><Icon name="terminal" />執行</button>}
            {canUseFreePort ? <button type="button" onClick={() => { void invoke({ action: 'start', projectId, useFreePort: true }) }} disabled={busy}>改用空著的埠</button> : null}
            <button type="button" onClick={() => { setEditing(true); setError('') }} disabled={busy}>編輯設定</button>
          </div>
          <div className="project-run-log-heading"><h2>執行紀錄</h2><button type="button" onClick={() => { void invoke({ action: 'openLog', projectId }) }} disabled={busy}>開啟完整紀錄檔</button></div>
          <pre className="project-run-log" aria-label="執行紀錄">{visibleLogs.join('\n')}</pre>
          {error ? <p className="project-run-error" role="alert">{error}</p> : null}
        </section>
      )}
    </dialog>
  )
}
