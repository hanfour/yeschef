import { useEffect, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import { emptyPolicy, type FilePolicy, type PermissionState, type PermissionAudit, type PermissionsRequest } from '../../shared/permissions.js'
import './SkillsManager.css'
import './PermissionManager.css'

export function PermissionManager({ api, projects, activeId, onClose, onChange }: {
  api: Pick<YesChefApi, 'managePermissions'>; projects: readonly { id: string; name: string }[]; activeId: string | null;
  onClose: () => void; onChange: (state: PermissionState) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const alive = useRef(true)
  const [state, setState] = useState<PermissionState>()
  const [audit, setAudit] = useState<PermissionAudit[]>([])
  const [projectId, setProjectId] = useState(activeId ?? projects[0]?.id ?? '')
  const [policy, setPolicy] = useState<FilePolicy>(emptyPolicy(projectId))
  const [paths, setPaths] = useState('.git\n.env')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dirty, setDirty] = useState(false)
  const [filter, setFilter] = useState<'all' | 'allow' | 'deny' | 'manual'>('all')
  const [exportPath, setExportPath] = useState('')

  async function run(request: Extract<PermissionsRequest, { action: 'get' | 'save' | 'pause' }>, replaceForm = false) {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await api.managePermissions(request)
      if (!alive.current) return
      if (response.kind === 'error') { setError(response.message); return }
      if (response.kind === 'exported') return
      setState(response.state); setAudit(response.audit); onChange(response.state)
      if (response.error) setError(response.error)
      if (replaceForm) {
        const next = response.state.policies.find(p => p.projectId === projectId) ?? emptyPolicy(projectId)
        setPolicy(next); setPaths(next.excluded.join('\n')); setDirty(false)
      }
      if (request.action !== 'get') setNotice('設定已儲存，套用於後續批准請求。進行中的審核已轉交人工。')
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '授權設定讀取失敗') }
    finally { if (alive.current) setBusy(false) }
  }
  async function exportAudit() {
    if (!projectId) return
    setBusy(true); setError(''); setExportPath('')
    try {
      const response = await api.managePermissions({ action: 'export', projectId })
      if (!alive.current) return
      if (response.kind === 'error') { setError(response.message); return }
      if (response.kind === 'exported') { setExportPath(response.path); return }
      setState(response.state); setAudit(response.audit); onChange(response.state)
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '匯出授權紀錄失敗') }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true; ref.current?.showModal(); void run({ action: 'get' }, true)
    return () => { alive.current = false }
  }, [])
  function change(value: Partial<FilePolicy>) { setPolicy(p => ({ ...p, ...value })); setDirty(true) }
  return <dialog ref={ref} className="skills-dialog permissions-dialog" aria-labelledby="permissions-title" onCancel={e => { e.preventDefault(); onClose() }}>
    <header className="skills-heading"><div><h1 id="permissions-title">讓批准符合你的工作方式</h1><p>明確授權的檔案操作自動處理，其他操作交給你。</p></div><button type="button" className="skills-close" aria-label="關閉授權設定" onClick={onClose}>×</button></header>
    <div className="skills-body permissions-body">
      {error && <p role="alert" className="permissions-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="permissions-controls">
        <label>專案<select value={projectId} disabled={busy || dirty} onChange={e => {
          const id = e.target.value; setProjectId(id)
          const next = state?.policies.find(p => p.projectId === id) ?? emptyPolicy(id)
          setPolicy(next); setPaths(next.excluded.join('\n')); setNotice(''); setExportPath(''); setFilter('all')
        }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button type="button" disabled={busy || !state} onClick={() => state && void run({ action: 'pause', revision: state.revision, paused: !state.paused })}>{state?.paused ? '恢復自動批准' : '暫停所有自動批准'}</button>
      </div>
      {state?.paused && <p role="status">自動批准已暫停；明確禁止路徑仍維持拒絕。</p>}
      <form onSubmit={e => { e.preventDefault(); if (state) void run({ action: 'save', revision: state.revision, policy: { ...policy, excluded: paths.split('\n').map(p => p.trim()).filter(Boolean) } }, true) }}>
        <fieldset disabled={busy || !state || !projectId}>
          <legend>檔案批准方式</legend>
          <div className="permissions-modes">{([
            ['manual', '人工批准', '需要批准時由你決定'], ['rules', '規則自動', '符合範圍即可通過'], ['review', 'Agent 審核', '符合範圍後再由獨立 Claude 檢查'],
          ] as const).map(([mode, name, description]) => <label key={mode} className={policy.mode === mode ? 'is-selected' : ''}><input type="radio" name="permission-mode" value={mode} checked={policy.mode === mode} onChange={() => change({ mode })} /><strong>{name}</strong><span>{description}</span></label>)}</div>
          <div className="permissions-options"><label><input type="checkbox" checked={policy.read} onChange={e => change({ read: e.target.checked })} />讀取工作目錄內的檔案</label><label><input type="checkbox" checked={policy.write} onChange={e => change({ write: e.target.checked })} />新增與修改工作目錄內的檔案</label></div>
          <p className="skills-hint">以每個對話的工作目錄（含 worktree）為界。刪除、搬移、終端命令、push／PR 與外部發布的批准請求仍交由人工處理。只有 provider 送出的批准請求會經過此流程。</p>
          <label className="permissions-field">禁止路徑<textarea rows={3} value={paths} onChange={e => { setPaths(e.target.value); setDirty(true) }} /><span>每行一個相對路徑，含子目錄；不支援萬用字元。例如 .env 不會涵蓋 .env.local，需另外列入。禁止路徑優先於自動批准，僅作用於可辨識的檔案工具請求。</span></label>
          {policy.mode === 'review' && <><label className="permissions-field">審核目的<textarea required rows={3} maxLength={4000} value={policy.purpose} onChange={e => change({ purpose: e.target.value })} placeholder="例如：只修改登入畫面與相關測試，不變更後端授權行為" /></label><p className="skills-hint">將本次操作內容交給獨立 Claude Sonnet 審核，會使用你的 Claude 連線並產生模型用量。每筆最多 30 秒，設定預算 US$0.25；不足以判斷或模型不可用時轉人工。每個專案同時一筆審核，其餘由你確認。</p></>}
          <div className="permissions-controls"><button type="button" onClick={() => void run({ action: 'get' }, true)}>{dirty ? '放棄修改並重讀' : '重新讀取'}</button><button type="submit" className="primary" disabled={!dirty}>儲存授權設定</button>{dirty && <span>尚未儲存</span>}</div>
        </fieldset>
      </form>
      <section>
        <div className="permissions-controls"><h2>最近審核紀錄</h2><span className="permissions-audit-actions"><button type="button" disabled={busy} onClick={() => void run({ action: 'get' })}>重新整理紀錄</button><button type="button" disabled={busy || !projectId} onClick={() => void exportAudit()}>匯出 JSON</button></span></div>
        <p className="skills-hint">保存最近 200 筆，不保存工具參數或檔案內容。批准不代表工具已執行成功。</p>
        {exportPath && <p role="status" className="permissions-export-path">已匯出至 {exportPath}</p>}
        {(() => {
          const projectAudit = audit.filter(a => a.projectId === projectId)
          if (!projectAudit.length) return <p>此專案尚無審核紀錄。</p>
          const counts = { allow: 0, deny: 0, manual: 0 }
          for (const a of projectAudit) counts[a.decision] += 1
          const filtered = filter === 'all' ? projectAudit : projectAudit.filter(a => a.decision === filter)
          return <>
            <p className="permissions-audit-counts">允許 {counts.allow} · 拒絕 {counts.deny} · 轉人工 {counts.manual}</p>
            <div className="permissions-filter" role="group" aria-label="篩選稽核紀錄">{([
              ['all', '全部'], ['allow', '允許'], ['deny', '拒絕'], ['manual', '轉人工'],
            ] as const).map(([value, name]) => <button key={value} type="button" className={filter === value ? 'is-selected' : ''} onClick={() => setFilter(value)}>{name}</button>)}</div>
            <ol className="permissions-audit">{filtered.map(a => <li key={a.id}>
              <div><strong>{a.tool}</strong><span>{a.decision === 'allow' ? '允許' : a.decision === 'deny' ? '拒絕' : '轉人工'} · {a.source === 'review' ? 'Claude 審核' : a.source === 'rule' ? '授權規則' : a.source === 'user' ? '使用者' : '系統'}</span></div>
              <p className="permissions-audit-summary-line">{a.summary || '（未記錄）'}</p>
              <p>{a.reason || '使用者回覆'}</p>
              <small>{new Date(a.at).toLocaleString()} · 對話 {a.conversationId.slice(0, 8)} · 規則版本 {a.revision}</small>
            </li>)}</ol>
          </>
        })()}
      </section>
    </div>
  </dialog>
}
