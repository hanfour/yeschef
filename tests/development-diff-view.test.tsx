// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DevelopmentDiff } from '../src/renderer/components/DevelopmentDiff.js'
import type { ConversationToolsResponse, DiffResult } from '../src/shared/conversation-tools.js'
afterEach(cleanup)
const result: DiffResult = { kind: 'diff', scope: 'working', baseline: 'current HEAD', warnings: [], files: [{ path: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new', binary: false, omitted: false }] }
it('切换範圍後忽略較晚回來的舊結果，顯示檔名與增刪行', async () => {
  let finish!: (value: ConversationToolsResponse) => void
  render(<DevelopmentDiff conversationId="c" api={{ conversationTools: async request => {
    if (request.action === 'repositories') return { kind: 'repositories', repositories: [{ id: 'demo', label: 'demo' }], warnings: [] }
    if (request.action === 'diff' && request.scope === 'conversation') return new Promise(resolve => { finish = resolve })
    return result
  } }} />)
  await screen.findByRole('option', { name: 'demo' })
  fireEvent.change(screen.getByLabelText('diff 範圍'), { target: { value: 'working' } })
  await screen.findByText(/current HEAD/)
  await act(async () => finish({ ...result, baseline: 'obsolete' }))
  expect(screen.queryByText(/obsolete/)).toBeNull()
  expect(screen.getByLabelText('src/a.ts 的差異').textContent).toContain('+new')
  expect(screen.getByLabelText('src/a.ts 的差異').querySelector('.diff-delete')?.textContent).toContain('-old')
})

it('repo 與指定基準交給主程序；切換 repo 不沿用上一份 diff', async () => {
  const calls: unknown[] = []
  render(<DevelopmentDiff conversationId="parent" api={{ conversationTools: async request => {
    calls.push(request)
    if (request.action === 'repositories') return { kind: 'repositories', repositories: [{ id: 'a', label: 'web-ui' }, { id: 'm', label: 'service-b' }], warnings: [] }
    if (request.action !== 'diff') return { kind: 'error', message: 'unused' }
    return { ...result, scope: request.scope, baseline: request.repositoryId === 'm' ? 'service-b base' : 'web-ui base' }
  } }} />)
  await screen.findByText(/web-ui base/)
  fireEvent.change(screen.getByLabelText('Git repository'), { target: { value: 'm' } })
  await screen.findByText(/service-b base/)
  expect(screen.queryByText(/web-ui base/)).toBeNull()
  fireEvent.change(screen.getByLabelText('diff 範圍'), { target: { value: 'base' } })
  await screen.findByLabelText('比較基準')
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('比較基準'), { target: { value: 'main' } })
  fireEvent.click(screen.getByRole('button', { name: /^比較$/ }))
  await act(async () => {})
  expect(calls).toContainEqual({ action: 'diff', conversationId: 'parent', scope: 'base', repositoryId: 'm', baseRef: 'main' })
})

it('無可驗證寫檔時顯示空狀態，不改列全部 repo', async () => {
  render(<DevelopmentDiff conversationId="read-only" api={{ conversationTools: async () => ({ kind: 'repositories', repositories: [], warnings: [] }) }} />)
  await screen.findByText(/尚無本次對話可驗證的 repo 修改紀錄/)
  expect(screen.getByLabelText('Git repository').querySelectorAll('option')).toHaveLength(1)
})

it('分頁有 worktree 時面板最上方出現合併列', async () => {
  const worktreeMerge = vi.fn(async () => ({
    kind: 'status' as const, branch: 'task', target: 'main', ahead: 1, dirty: false, conflictPending: false,
    message: '分支 task → main,領先 1 個 commit',
  }))
  render(<DevelopmentDiff conversationId="t1" worktree={{ projectId: 'p1' }} api={{
    conversationTools: async () => ({ kind: 'repositories', repositories: [], warnings: [] }),
    worktreeMerge,
  }} />)
  await screen.findByText(/領先 1 個 commit/)
  expect(worktreeMerge).toHaveBeenCalledWith({ action: 'status', projectId: 'p1', tabId: 't1' })
  const bar = screen.getByLabelText('worktree 合併')
  const panel = screen.getByLabelText('開發變更 diff')
  expect(panel.firstElementChild).toBe(bar)
})

it('分頁沒有 worktree 時不顯示合併列', async () => {
  render(<DevelopmentDiff conversationId="t1" api={{
    conversationTools: async () => ({ kind: 'repositories', repositories: [], warnings: [] }),
  }} />)
  await screen.findByText(/尚無本次對話可驗證的 repo 修改紀錄/)
  expect(screen.queryByLabelText('worktree 合併')).toBeNull()
})
