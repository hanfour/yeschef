import { describe, expect, it } from 'vitest'
import {
  WORKTREE_MERGE_CHANNEL,
  WorktreeMergeRequestSchema,
  WorktreeMergeResponseSchema,
} from '../src/shared/worktree-merge.js'

describe('worktree:merge 的頻道與請求', () => {
  it('頻道名固定', () => {
    expect(WORKTREE_MERGE_CHANNEL).toBe('worktree:merge')
  })

  it.each(['status', 'merge', 'abort'])('%s 三個欄位收得下', (action) => {
    expect(WorktreeMergeRequestSchema.safeParse({ action, projectId: 'p1', tabId: 't1' }).success).toBe(true)
  })

  it('多餘欄位不收', () => {
    expect(WorktreeMergeRequestSchema.safeParse({ action: 'merge', projectId: 'p1', tabId: 't1', rootPath: '/repo' }).success).toBe(false)
  })

  it.each([
    { action: 'push', projectId: 'p1', tabId: 't1' },
    { action: 'merge', projectId: '', tabId: 't1' },
    { action: 'merge', projectId: 'p1', tabId: '' },
    { action: 'merge', projectId: 'p1' },
  ])('形狀不對不收:%j', (raw) => {
    expect(WorktreeMergeRequestSchema.safeParse(raw).success).toBe(false)
  })
})

describe('worktree:merge 的回應', () => {
  it.each([
    { kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: false, conflictPending: false, message: '分支 task → main,領先 2 個 commit' },
    { kind: 'status', branch: 'task', target: null, ahead: 0, dirty: true, conflictPending: true, message: '主目錄不在任何分支上(detached HEAD),先切回分支' },
    { kind: 'merged', target: 'main', branch: 'task', commits: 2, message: '已合併到 main(2 個 commit)' },
    { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突' },
    { kind: 'conflictPending', files: ['src/a.ts'], message: '上一次的衝突還沒解完:src/a.ts' },
    { kind: 'rootDirty', files: ['src/b.ts'], message: '主目錄有未提交的改動' },
    { kind: 'rootDetached', message: '主目錄不在任何分支上' },
    { kind: 'agentBusy', message: 'agent 還在工作' },
    { kind: 'failed', message: '合併失敗:fatal' },
    { kind: 'aborted' },
    { kind: 'error', message: '這個分頁沒有 worktree' },
  ])('十一種回應都收:%j', (raw) => {
    expect(WorktreeMergeResponseSchema.safeParse(raw).success).toBe(true)
  })

  it('回應多欄位不收,ahead 不收負數', () => {
    expect(WorktreeMergeResponseSchema.safeParse({ kind: 'aborted', extra: 1 }).success).toBe(false)
    expect(WorktreeMergeResponseSchema.safeParse({ kind: 'status', branch: 'task', target: 'main', ahead: -1, dirty: false, conflictPending: false, message: 'x' }).success).toBe(false)
  })

  it('不帶絕對路徑以外的資料:conflict 只有四個欄位', () => {
    const shape = WorktreeMergeResponseSchema.safeParse({
      kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突', worktreePath: '/repo/.worktrees/task',
    })
    expect(shape.success).toBe(false)
  })
})
