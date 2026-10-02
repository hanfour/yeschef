import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import { useWorktreeMerge, type WorktreeMergeOutcome } from '../hooks/useWorktreeMerge.js'
import './WorktreeMergeBar.css'

export interface WorktreeMergeBarProps {
  readonly merge: YesChefApi['worktreeMerge']
  readonly projectId: string
  readonly tabId: string
}

const LABEL = {
  region: 'worktree 合併',
  loading: '正在讀取分支狀態…',
  merging: '合併中',
  merge: '合併',
  abort: '放棄合併',
  hint: '解完衝突並提交之後,再按一次合併。',
} as const

// `aborted` 沒有 message 欄位,不過 hook 送出的 outcome 從不會是它(放棄成功時直接歸零)。
function outcomeMessage(outcome: WorktreeMergeOutcome | undefined): string | undefined {
  return outcome !== undefined && outcome.kind !== 'aborted' ? outcome.message : undefined
}

function outcomeFiles(outcome: WorktreeMergeOutcome | undefined): readonly string[] {
  return outcome !== undefined && 'files' in outcome ? outcome.files : []
}

/**
 * 「查看 diff」面板最上方的合併列(合併規格 §7)。
 * 文案除了介面固定字樣(合併、合併中、放棄合併、載入中)之外都來自回應的 `message`,
 * 那串字在主行程的 MSG 組好,這裡不重組。
 */
export function WorktreeMergeBar({ merge, projectId, tabId }: WorktreeMergeBarProps): React.ReactElement {
  const view = useWorktreeMerge(merge, projectId, tabId)
  const settled = view.status !== undefined && view.status.target !== null
    && view.status.ahead === 0 && view.status.dirty === false
  const disabled = view.busy || view.status === undefined || view.status.target === null || (settled && !view.conflicted)
  const files = outcomeFiles(view.outcome)
  const text = view.busy ? LABEL.merging : outcomeMessage(view.outcome) ?? view.status?.message ?? LABEL.loading
  return (
    <section className={`worktree-merge-bar${view.conflicted ? ' is-conflict' : ''}`} aria-label={LABEL.region}>
      <p className="worktree-merge-text" role="status">{text}</p>
      {files.length > 0 && (
        <ul className="worktree-merge-files">{files.map((file) => <li key={file}>{file}</li>)}</ul>
      )}
      {view.conflicted && <p className="worktree-merge-hint">{LABEL.hint}</p>}
      <div className="worktree-merge-actions">
        <button type="button" className="primary" disabled={disabled} onClick={view.merge}>{LABEL.merge}</button>
        {view.conflicted && <button type="button" disabled={view.busy} onClick={view.abort}>{LABEL.abort}</button>}
      </div>
    </section>
  )
}
