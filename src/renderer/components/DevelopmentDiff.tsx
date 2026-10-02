import { useEffect, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { DiffResult, DiffRepositories } from '../../shared/conversation-tools.js'
import { WorktreeMergeBar } from './WorktreeMergeBar.js'
import './DevelopmentDiff.css'
export function DevelopmentDiff({ api, conversationId, worktree }: {
  api: Pick<YesChefApi, 'conversationTools'> & Partial<Pick<YesChefApi, 'worktreeMerge'>>
  conversationId: string
  /** 這個對話開在自己的 worktree 時才給;`conversationId` 同時就是分頁 id。 */
  worktree?: { readonly projectId: string }
}) {
  const [scope, setScope] = useState<'conversation' | 'working' | 'base'>('conversation')
  const [revision, refresh] = useState(0)
  const [catalog, setCatalog] = useState<DiffRepositories>()
  const [repositoryId, setRepositoryId] = useState('')
  const [catalogError, setCatalogError] = useState('')
  const [draftRef, setDraftRef] = useState('HEAD~1')
  const [baseRef, setBaseRef] = useState('HEAD~1')
  const [result, setResult] = useState<DiffResult>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, select] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    let alive = true
    setCatalogError('')
    api.conversationTools({ action: 'repositories', conversationId }).then(response => {
      if (!alive) return
      if (response.kind === 'error') { setCatalogError(response.message); setRepositoryId(''); return }
      if (response.kind !== 'repositories') { setCatalogError('無法取得 repo 清單'); return }
      setCatalog(response)
      setRepositoryId(previous => response.repositories.some(r => r.id === previous) ? previous : response.repositories[0]?.id ?? '')
    }).catch(error => { if (alive) setCatalogError(error instanceof Error ? error.message : 'repo 掃描失敗') })
    return () => { alive = false }
  }, [api, conversationId, revision])
  useEffect(() => {
    if (!repositoryId) { setResult(undefined); setError(''); setLoading(false); return }
    const id = ++generation.current
    setLoading(true); setError(''); setResult(undefined)
    api.conversationTools({ action: 'diff', conversationId, scope, repositoryId, ...(scope === 'base' ? { baseRef } : {}) }).then(response => {
      if (id !== generation.current) return
      if (response.kind === 'error') setError(response.message)
      else if (response.kind === 'diff') { setResult(response); select(previous => response.files.some(f => f.path === previous) ? previous : response.files[0]?.path ?? '') }
    }).catch(error => { if (id === generation.current) setError(error instanceof Error ? error.message : 'diff 讀取失敗') })
      .finally(() => { if (id === generation.current) setLoading(false) })
    return () => { generation.current += 1 }
  }, [api, conversationId, scope, revision, repositoryId, baseRef])
  const file = result?.files.find(f => f.path === selected)
  return <section className="development-diff" aria-label="開發變更 diff">
    {worktree !== undefined && api.worktreeMerge !== undefined
      && <WorktreeMergeBar merge={api.worktreeMerge} projectId={worktree.projectId} tabId={conversationId} />}
    <header><h2>開發變更</h2>
      <select aria-label="Git repository" value={repositoryId} onChange={e => setRepositoryId(e.target.value)}><option value="" disabled>本次對話修改的 repo</option>{catalog?.repositories.map(r => <option value={r.id} key={r.id}>{r.label}</option>)}</select>
      <select aria-label="diff 範圍" value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="conversation">本次對話開始後</option><option value="working">目前未提交變更</option><option value="base">指定基準（含已 commit）</option></select>
      <button type="button" disabled={loading} onClick={() => refresh(n => n + 1)}>重新整理</button>
    </header>
    {scope === 'base' && <form className="diff-base-form" onSubmit={e => { e.preventDefault(); setBaseRef(draftRef.trim()); refresh(n => n + 1) }}><label>比較起點<input aria-label="比較基準" value={draftRef} onChange={e => setDraftRef(e.target.value)} placeholder="HEAD~1、main 或 commit SHA" required maxLength={256} /></label><button type="submit" disabled={loading || !draftRef.trim()}>比較</button><p>從指定 commit／分支比較到目前工作目錄，包含其後已提交與未提交的內容。</p></form>}
    <p className="diff-warning">只列出本次對話、子 agent 與已驗證外部委派成功寫檔的 repo；無法對應來源與寫檔結果的指令不會被推測為修改。選定 repo 後，diff 仍依所選 Git 範圍比較。</p>
    {catalogError && <p role="alert" className="diff-error">{catalogError}</p>}
    {catalog?.repositories.length === 0 && <p>尚無本次對話可驗證的 repo 修改紀錄。讀取、搜尋或其他對話的未提交變更不會列入。</p>}
    {!result && catalog?.warnings.map(w => <p className="diff-warning" key={w}>{w}</p>)}
    {loading && <p role="status">正在讀取變更…</p>}
    {error && <p role="alert" className="diff-error">{error}</p>}
    {result && <><p className="diff-baseline">{result.baseline} · {result.files.length} 個檔案</p>{result.warnings.map(w => <p className="diff-warning" key={w}>{w}</p>)}
      {!result.files.length && <p className="diff-empty">此範圍目前沒有變更。{scope === 'working' ? ' 已 commit 的內容可改用「指定基準」查看。' : ''}</p>}
      <nav className="diff-files" aria-label="變更檔案">{result.files.map(f => <button type="button" key={f.path} aria-current={selected === f.path ? 'true' : undefined} onClick={() => select(f.path)}><span>{f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M'}</span>{f.path}{f.omitted ? '（內容省略）' : ''}</button>)}</nav>
      {file && <div className="diff-code"><h3>{file.path}</h3><pre aria-label={`${file.path} 的差異`}>{file.patch.split('\n').map((line, i) => <span key={i} className={line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-delete' : ''}>{line || ' '}</span>)}</pre></div>}
    </>}
  </section>
}
