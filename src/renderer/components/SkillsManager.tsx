import { useEffect, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { InstalledSkill, SkillInspection, SkillsRequest, SkillsResponse, SkillsState } from '../../shared/skills.js'
import './SkillsManager.css'

export function SkillsManager({ api, onClose }: { api: Pick<YesChefApi, 'manageSkills'>; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const aliveRef = useRef(true)
  const [state, setState] = useState<SkillsState>({ revision: null, skills: [] })
  const [url, setUrl] = useState('')
  const [inspection, setInspection] = useState<SkillInspection>()
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState('讀取共用庫…')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string>()
  const [pendingEnabled, setPendingEnabled] = useState<{ id: string; enabled: boolean }>()

  useEffect(() => {
    aliveRef.current = true
    dialogRef.current?.showModal()
    api.manageSkills({ action: 'list' }).then(response => {
      if (!aliveRef.current) return
      if (response.kind === 'state') setState(response.state)
      else if (response.kind === 'error') setError(response.message)
    }).catch(error => { if (aliveRef.current) setError(String(error)) })
      .finally(() => { if (aliveRef.current) setBusy('') })
    return () => { aliveRef.current = false }
  }, [api])

  async function run(label: string, request: SkillsRequest, done?: (response: SkillsResponse) => void) {
    if (busy) return
    setBusy(label)
    setError('')
    setMessage('')
    try {
      const response = await api.manageSkills(request)
      if (!aliveRef.current) return
      if (response.kind === 'error') { setError(response.message); return }
      if (response.kind === 'state') setState(response.state)
      done?.(response)
    } catch (error) { if (aliveRef.current) setError(error instanceof Error ? error.message : '操作失敗，請重試') }
    finally { if (aliveRef.current) setBusy('') }
  }

  function inspect() {
    setInspection(undefined)
    setSelected([])
    void run('正在讀取 GitHub skills…', { action: 'inspect', url }, response => {
      if (response.kind === 'inspection') setInspection(response.inspection)
    })
  }

  function checkUpdate(skill: InstalledSkill) {
    setInspection(undefined)
    setSelected([])
    const path = skill.source.path.split('/').map(encodeURIComponent).join('/')
    const sourceUrl = `${skill.source.url}/tree/${encodeURIComponent(skill.source.ref)}${path ? `/${path}` : ''}`
    void run(`正在檢查 ${skill.name}…`, { action: 'inspect', url: sourceUrl }, response => {
      if (response.kind !== 'inspection') return
      if (response.inspection.commit === skill.commit) { setMessage(`${skill.name} 已是最新版本`); return }
      const candidate = response.inspection.candidates.find(candidate => candidate.path === skill.source.path && candidate.name === skill.name)
      if (!candidate) { setError('原 skill 已移除或更名，請重新讀取 repository 並選取'); return }
      setInspection({ ...response.inspection, candidates: [candidate] })
      setSelected([candidate.path])
      setMessage(`找到 ${skill.name} 的新版本，檢視內容後按「安裝／更新選取項目」`)
    })
  }

  return <dialog ref={dialogRef} className="skills-dialog" aria-labelledby="skills-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <header className="skills-heading">
      <div><h1 id="skills-title">Skills</h1>
        <p>安裝一次，所有專案的 Codex 與 Claude 都能使用。</p></div>
      <button className="skills-close" type="button" aria-label="關閉 Skills 管理" onClick={onClose}>×</button>
    </header>
    <div className="skills-body">
      <section className="skills-import" aria-labelledby="skills-import-title">
        <h2 id="skills-import-title">從 GitHub 加入</h2>
        <form onSubmit={event => { event.preventDefault(); inspect() }}>
          <label htmlFor="skills-url">公開 repository 網址</label>
          <div className="skills-url-row"><input id="skills-url" type="url" value={url} required placeholder="https://github.com/emilkowalski/skills"
            onChange={event => setUrl(event.target.value)} disabled={Boolean(busy)} />
            <button type="submit" disabled={Boolean(busy) || !url.trim()}>讀取 Skills</button></div>
        </form>
        <p className="skills-hint">支援 repository 或 tree 網址。讀取後選擇要加入的 skills。</p>
      </section>
      <div className="skills-feedback" aria-live="polite">
        {busy && <p role="status">{busy}</p>}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert" className="skills-error">{error}</p>}
      </div>
      {inspection && <section className="skills-results" aria-labelledby="skills-results-title">
        <div className="skills-section-heading"><h2 id="skills-results-title">可安裝的 Skills <span>{inspection.candidates.length}</span></h2>
          <code title={inspection.commit}>{inspection.commit.slice(0, 8)}</code></div>
        <p className="skills-source">{inspection.url} · {inspection.ref}</p>
        {inspection.warnings.map(warning => <p className="skills-error" key={warning}>{warning}</p>)}
        {!inspection.candidates.length && <p>找不到支援的 SKILL.md。請確認網址或查看上方原因。</p>}
        <ul className="skills-candidates">{inspection.candidates.map(candidate => <li key={candidate.path}>
          <label className="skill-selection"><input type="checkbox" checked={selected.includes(candidate.path)} disabled={Boolean(busy)}
            onChange={event => setSelected(items => event.target.checked ? [...items, candidate.path] : items.filter(path => path !== candidate.path))} />
            <span><strong>{candidate.name}</strong><span className="skill-description">{candidate.description}</span></span></label>
          <details><summary>查看 SKILL.md</summary><pre>{candidate.markdown}</pre></details>
        </li>)}</ul>
        {inspection.candidates.length > 0 && <div className="skills-install-row"><span>已選 {selected.length} 項</span>
          <button className="primary" type="button" disabled={!selected.length || Boolean(busy)} onClick={() => {
            void run('正在安裝共用 Skills…', { action: 'install', inspectionId: inspection.id, paths: selected }, response => {
              if (response.kind === 'state') { setInspection(undefined); setSelected([]); setMessage('安裝完成，所有專案的新對話可使用'); }
            })
          }}>安裝／更新選取項目</button></div>}
      </section>}
      <section aria-labelledby="skills-installed-title">
        <div className="skills-section-heading"><h2 id="skills-installed-title">共用庫 <span>{state.skills.length}</span></h2>
          <button type="button" disabled={Boolean(busy)} onClick={() => void run('重新整理中…', { action: 'list' })}>重新整理</button></div>
        <p className="skills-hint">啟用項目供新對話載入；進行中的對話保留原版本。既有對話需要最新設定時，請開新對話。</p>
        {state.skills.length === 0 && <div className="skills-empty">共用庫還沒有 skills。貼上 GitHub 網址開始加入。</div>}
        <ul className="skills-installed">{state.skills.map(skill => <li key={skill.id}>
          <div className="skill-card-heading"><h3>{skill.name}</h3><span className={skill.enabled ? 'skill-enabled' : 'skill-disabled'}>{skill.enabled ? '已啟用 · 新對話可用' : '已停用'}</span></div>
          <p className="skill-description">{skill.description}</p>
          <p className="skills-source">{skill.source.url} · {skill.source.path || '/'}<br />版本 <code title={skill.commit}>{skill.commit.slice(0, 8)}</code> · {skill.source.ref}</p>
          <p className="skills-hint">對話中可指定 <code>yeschef-shared:{skill.name}</code></p>
          <div className="skill-actions">
            <label><input type="checkbox" aria-label={`啟用 ${skill.name}`} checked={pendingEnabled?.id === skill.id ? pendingEnabled.enabled : skill.enabled} disabled={Boolean(busy)} onChange={event => {
              const enabled = event.target.checked
              setPendingEnabled({ id: skill.id, enabled })
              void run('更新啟用狀態…', { action: 'enable', id: skill.id, enabled }).finally(() => {
                if (aliveRef.current) setPendingEnabled(undefined)
              })
            }} /> 啟用</label>
            <button type="button" disabled={Boolean(busy)} onClick={() => checkUpdate(skill)}>檢查更新</button>
            {removing === skill.id ? <><span>從共用庫移除？</span><button type="button" disabled={Boolean(busy)} onClick={() => {
              void run('移除中…', { action: 'remove', id: skill.id }, () => { setRemoving(undefined); setMessage('已移除，進行中的對話維持原版本') })
            }}>確認移除</button><button type="button" onClick={() => setRemoving(undefined)}>取消</button></> :
              <button type="button" disabled={Boolean(busy)} onClick={() => setRemoving(skill.id)}>移除</button>}
          </div>
        </li>)}</ul>
      </section>
    </div>
  </dialog>
}
