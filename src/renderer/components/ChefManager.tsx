import { useEffect, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import { PROVIDER_LABELS, type ProjectsView } from '../../shared/projects.js'
import type { ChefTask, ChefPolicy, ChefModel, ChefRequest, ChefResponse } from '../../shared/chef.js'
import { ChefUiCheck } from './ChefUiCheck.js'
import './SkillsManager.css'
import './ChefManager.css'
const kindLabels: Record<string, string> = { analysis: '分析', code: '實作', test: '測試', docs: '文件', review: '驗收' }
const attemptLabels: Record<string, string> = { running: '執行中', stopping: '停止中', done: '已結束', failed: '失敗', blocked: '等待處理' }
const labels: Record<ChefTask['status'], string> = { queued: '排程中', running: '執行中', stopping: '正在停止', completed: '本輪完成', blocked: '等待處理', cancelled: '已停止' }
export function ChefManager({ api, projects, selectedTaskId, onClose }: { api: Pick<YesChefApi, 'manageChef' | 'activateTab'>; projects: ProjectsView; selectedTaskId?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(true), sequence = useRef(0), mutation = useRef(false)
  const [tasks, setTasks] = useState<ChefTask[]>([]), [models, setModels] = useState<ChefModel[]>([]), [notices, setNotices] = useState<string[]>([])
  const [projectId, setProjectId] = useState(projects.activeId ?? projects.projects[0]?.id ?? '')
  const [goal, setGoal] = useState(''), [mode, setMode] = useState<ChefPolicy['mode']>('auto'), [allowed, setAllowed] = useState<string[]>([]), [preferred, setPreferred] = useState('')
  const [maxExecutions, setMaxExecutions] = useState(6), [deadlineMinutes, setDeadline] = useState(120)
  const [selected, setSelected] = useState(selectedTaskId ?? ''), [reconciled, setReconciled] = useState(false), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(true), [error, setError] = useState('')
  const initializedPool = useRef(false)
  function accept(response: ChefResponse) {
    if (response.kind === 'error') { setError(response.message); return }
    setTasks(response.state.tasks); setModels(response.state.models); setNotices(response.state.notices)
    if (!initializedPool.current && response.state.models.length) { setAllowed(response.state.models.map(m => m.key)); setPreferred(response.state.models[0]!.key); initializedPool.current = true }
    else if (initializedPool.current) { setAllowed(previous => previous.filter(key => response.state.models.some(m => m.key === key))); setPreferred(previous => response.state.models.some(m => m.key === previous) ? previous : '') }
  }
  async function read(refreshModels = false) {
    if (mutation.current) return
    const generation = ++sequence.current
    try { const result = await api.manageChef({ action: 'get', refreshModels }); if (alive.current && sequence.current === generation) { accept(result); setBusy(false) } }
    catch (error) { if (alive.current && sequence.current === generation) { setError(error instanceof Error ? error.message : '讀取主廚失敗'); setBusy(false) } }
  }
  async function run(request: ChefRequest) {
    if (mutation.current) return
    mutation.current = true; sequence.current += 1; setBusy(true); setError('')
    try {
      const response = await api.manageChef(request)
      if (!alive.current) return
      accept(response)
      if (response.kind === 'state') {
        if (request.action === 'start') { setGoal(''); setSelected(response.state.tasks.at(-1)?.id ?? '') }
        if (request.action === 'resume') { setMessage(''); setReconciled(false) }
      }
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '主廚操作失敗') }
    finally { mutation.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true; dialog.current?.showModal(); void read()
    const timer = setInterval(() => { void read() }, 2500)
    return () => { alive.current = false; clearInterval(timer); sequence.current += 1 }
  }, [])
  const task = tasks.find(t => t.id === selected)
  return <dialog ref={dialog} className="skills-dialog chef-dialog" aria-labelledby="chef-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <header className="skills-heading"><div><h1 id="chef-title">自動主廚</h1><p>交付目標，讓平台選擇模型、登錄委派並保存交接進度。</p></div><button type="button" className="skills-close" aria-label="關閉主廚" onClick={onClose}>×</button></header>
    <div className="skills-body chef-body">
      {error && <p role="alert" className="chef-error">{error}</p>}
      {notices.map(n => <p className="skills-hint" key={n}>{n}</p>)}
      <form onSubmit={event => { event.preventDefault(); void run({ action: 'start', projectId, goal, policy: { mode, allowed, ...(mode === 'auto' ? {} : { preferred }), maxExecutions, deadlineMinutes } }) }}>
        <fieldset disabled={busy}>
          <div className="chef-controls"><label>專案<select aria-label="主廚專案" value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>執行方式<select aria-label="主廚執行方式" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="auto">自動選模型</option><option value="preferred">偏好模型＋自動備援</option><option value="pinned">固定模型</option></select></label></div>
          <label className="chef-field">任務目標<textarea aria-label="主廚任務目標" rows={4} maxLength={20000} value={goal} onChange={e => setGoal(e.target.value)} placeholder="描述要完成的工作、驗收方式與限制。" required /></label>
          <details><summary>模型池與執行上限（{allowed.length} 個模型）</summary>
            <p className="skills-hint">使用 provider 回傳的模型清單。允許的模型會收到任務與交接內容。自動模式依工作類型、預設候選與本次失敗紀錄選擇；不保證每個列出的模型都能通過實際執行的登入／額度檢查。</p>
            <button type="button" onClick={() => { setBusy(true); void read(true) }}>重新讀取模型</button>
            <div className="chef-models">{models.map(model => <label key={model.key}><input type="checkbox" checked={allowed.includes(model.key)} onChange={e => setAllowed(previous => e.target.checked ? [...previous, model.key] : previous.filter(k => k !== model.key))} /><span>{PROVIDER_LABELS[model.provider].name} · {model.label}</span></label>)}</div>
            {mode !== 'auto' && <label className="chef-field">指定模型<select aria-label="指定主廚模型" value={preferred} onChange={e => setPreferred(e.target.value)}><option value="" disabled>選擇模型</option>{models.filter(m => allowed.includes(m.key)).map(m => <option key={m.key} value={m.key}>{m.provider} · {m.label}</option>)}</select></label>}
            <div className="chef-controls"><label>最多執行次數<input aria-label="最多執行次數" type="number" min={1} max={20} value={maxExecutions} onChange={e => setMaxExecutions(Number(e.target.value))} /></label><label>任務期限（分鐘）<input aria-label="任務期限" type="number" min={1} max={240} value={deadlineMinutes} onChange={e => setDeadline(Number(e.target.value))} /></label></div>
            <p className="skills-hint">次數包含主廚、子工作、驗收與改派；每個工作最多自動改派 2 次。這是執行與時間上限，不是美元費用保證。沿用專案授權，拒絕或未確認的工具結果不會被自動繞過。</p>
          </details>
          <button className="chef-start primary" type="submit" disabled={!goal.trim() || !projectId || !allowed.length || (mode !== 'auto' && !allowed.includes(preferred))}>{busy ? '處理中…' : '交給主廚'}</button>
        </fieldset>
      </form>
      <section className="chef-tasks"><h2>任務與交接</h2>
        {!tasks.length && <p className="skills-hint">尚無主廚任務。既有固定對話會維持原本方式。</p>}
        <div className="chef-task-list">{[...tasks].reverse().map(t => <button type="button" key={t.id} aria-pressed={selected === t.id} onClick={() => { setSelected(t.id); setReconciled(false); setMessage('') }}><strong>{t.goal.slice(0,100)}</strong><span>{labels[t.status]} · {t.attempts.length}/{t.policy.maxExecutions} 次執行</span></button>)}</div>
        {task && <article className="chef-task-detail"><p role="status">{labels[task.status]} · {task.reason}</p>
          <ol className="chef-units">{task.units.map(unit => <li key={unit.id}><strong>{unit.title}</strong><span>{kindLabels[unit.kind]} · {unit.status === 'done' ? '已完成回合' : unit.status === 'queued' ? '待執行' : unit.status === 'running' ? '執行中' : '等待處理'}</span></li>)}</ol>
          <ol className="chef-attempts">{task.attempts.map(a => <li key={a.id}><div><strong>{a.provider} · {a.actualModel ?? a.model}</strong><span>{a.actualModel ? '實際模型' : '待實際模型回報'} · {a.awaitingApproval ? '等待批准' : attemptLabels[a.status]}</span></div><p>{a.reason}</p><small>{new Date(a.startedAt).toLocaleString()}{a.costUsd === undefined ? ' · 費用未回報' : ` · 已回報 US$${a.costUsd.toFixed(4)}`}</small><button type="button" disabled={!projects.projects.some(p => p.tabs.some(t => t.id === a.workerId))} onClick={() => { api.activateTab({ projectId: task.projectId, tabId: a.workerId }); onClose() }}>查看工作者</button></li>)}</ol>
          <ChefUiCheck task={task} />
          {['queued','running','stopping'].includes(task.status) ? <button type="button" disabled={busy || task.status === 'stopping'} onClick={() => void run({ action: 'cancel', taskId: task.id })}>停止並保存進度</button> : null}
          {['blocked','cancelled'].includes(task.status) && <div className="chef-resume"><label className="chef-field">接續指示<textarea aria-label="接續指示" rows={2} value={message} onChange={e => setMessage(e.target.value)} placeholder="補充已處理的阻塞原因或新的限制。" /></label>{task.needsReconciliation && <label><input type="checkbox" checked={reconciled} onChange={e => setReconciled(e.target.checked)} />我已確認舊執行者停止，並核對檔案與外部操作結果。</label>}<p className="skills-hint">接續可增加最多 3 次執行，任務總上限 20 次；會先核對 checkpoint。</p><button type="button" disabled={busy || (task.needsReconciliation && !reconciled)} onClick={() => void run({ action: 'resume', taskId: task.id, reconciled, message })}>接續任務</button></div>}
        </article>}
      </section>
    </div>
  </dialog>
}
