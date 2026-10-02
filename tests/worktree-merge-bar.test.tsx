// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { WorktreeMergeBar } from '../src/renderer/components/WorktreeMergeBar.js'
import type { WorktreeMergeRequest, WorktreeMergeResponse } from '../src/shared/worktree-merge.js'

afterEach(cleanup)

const STATUS_AHEAD: WorktreeMergeResponse = {
  kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: false, conflictPending: false,
  message: '分支 task → main,領先 2 個 commit',
}
const STATUS_CLEAN: WorktreeMergeResponse = {
  kind: 'status', branch: 'task', target: 'main', ahead: 0, dirty: false, conflictPending: false,
  message: '已是最新,沒有要合併的 commit',
}
/** 衝突留在 worktree 裡時 status 看得到 MERGE_HEAD,合併之後重查拿到的是這個。 */
const STATUS_CONFLICT: WorktreeMergeResponse = {
  kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: false, conflictPending: true,
  message: '分支 task → main,領先 2 個 commit',
}
const STATUS_DETACHED: WorktreeMergeResponse = {
  kind: 'status', branch: 'task', target: null, ahead: 0, dirty: false, conflictPending: false,
  message: '主目錄不在任何分支上(detached HEAD),先切回分支',
}

function mount(replies: readonly WorktreeMergeResponse[]) {
  const requests: WorktreeMergeRequest[] = []
  let index = 0
  const merge = vi.fn(async (payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse> => {
    requests.push(payload)
    const reply = replies[index] ?? replies.at(-1) ?? STATUS_AHEAD
    index += 1
    return reply
  })
  render(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t1" />)
  return { requests }
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

it('平常態顯示分支與領先數,合併按鈕可按', async () => {
  const m = mount([STATUS_AHEAD])
  await screen.findByText(/領先 2 個 commit/)
  expect(button('合併').disabled).toBe(false)
  expect(screen.queryByRole('button', { name: '放棄合併' })).toBeNull()
  expect(m.requests).toEqual([{ action: 'status', projectId: 'p1', tabId: 't1' }])
})

it('已是最新時合併按鈕停用', async () => {
  mount([STATUS_CLEAN])
  await screen.findByText(/已是最新/)
  expect(button('合併').disabled).toBe(true)
})

it('主目錄 detached 時說明原因並停用', async () => {
  mount([STATUS_DETACHED])
  await screen.findByText(/detached HEAD/)
  expect(button('合併').disabled).toBe(true)
})

// 審查追加:衝突態是 status 的一個欄位。別的地方(終端、上一次開著的視窗)解到一半留下的
// MERGE_HEAD,開面板查 status 就該看到衝突列,不必先按一次合併。
it('status 回 conflictPending 時直接顯示衝突列與放棄合併按鈕,status 沒帶檔案就不列', async () => {
  mount([{
    kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: false, conflictPending: true,
    message: '分支 task → main,領先 2 個 commit',
  }])
  await screen.findByRole('button', { name: '放棄合併' })
  expect(document.querySelector('.worktree-merge-bar.is-conflict')).not.toBeNull()
  expect(screen.getByText('解完衝突並提交之後,再按一次合併。')).toBeTruthy()
  expect(document.querySelector('.worktree-merge-files')).toBeNull()
  expect(button('合併').disabled).toBe(false)
})

it('合併成功後顯示結果並重查 status', async () => {
  const m = mount([
    STATUS_AHEAD,
    { kind: 'merged', target: 'main', branch: 'task', commits: 2, message: '已合併到 main(2 個 commit)' },
    STATUS_CLEAN,
  ])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(/已合併到 main/)
  expect(m.requests).toEqual([
    { action: 'status', projectId: 'p1', tabId: 't1' },
    { action: 'merge', projectId: 'p1', tabId: 't1' },
    { action: 'status', projectId: 'p1', tabId: 't1' },
  ])
  expect(button('合併').disabled).toBe(true)
})

it('衝突時整列標記,列出檔案,兩顆按鈕都在', async () => {
  mount([
    STATUS_AHEAD,
    { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts', 'src/b.ts'], message: '主分支 main 合進 task 時有衝突:src/a.ts、src/b.ts。已請 agent 處理' },
    STATUS_CONFLICT,
  ])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(/已請 agent 處理/)
  expect(screen.getByText('src/a.ts')).toBeTruthy()
  expect(screen.getByText('src/b.ts')).toBeTruthy()
  expect(document.querySelector('.worktree-merge-bar.is-conflict')).not.toBeNull()
  expect(screen.getByText('解完衝突並提交之後,再按一次合併。')).toBeTruthy()
  expect(button('合併').disabled).toBe(false)
  expect(button('放棄合併').disabled).toBe(false)
})

it('放棄合併之後重查 status,回到平常態', async () => {
  const m = mount([
    STATUS_AHEAD,
    { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突' },
    STATUS_CONFLICT,
    { kind: 'aborted' },
    STATUS_AHEAD,
  ])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByRole('button', { name: '放棄合併' })
  await act(async () => { button('放棄合併').click() })
  await screen.findByText(/領先 2 個 commit/)
  expect(screen.queryByRole('button', { name: '放棄合併' })).toBeNull()
  expect(m.requests.map((r) => r.action)).toEqual(['status', 'merge', 'status', 'abort', 'status'])
})

// 新增(非原始 brief 內容):abort 現在也可能回 agentBusy(agent 正在處理衝突,回合還沒結束),
// 這時列上要照舊顯示衝突樣式與這則訊息,「放棄合併」按鈕留著讓使用者稍後再試。
it('放棄合併時 agent 忙碌,顯示訊息但放棄合併按鈕仍在', async () => {
  mount([
    STATUS_AHEAD,
    { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突' },
    STATUS_CONFLICT,
    { kind: 'agentBusy', message: 'agent 還在工作,等這個回合結束再合併' },
    STATUS_CONFLICT,
  ])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByRole('button', { name: '放棄合併' })
  await act(async () => { button('放棄合併').click() })
  await screen.findByText(/等這個回合結束/)
  expect(button('放棄合併').disabled).toBe(false)
  expect(document.querySelector('.worktree-merge-bar.is-conflict')).not.toBeNull()
})

it.each([
  ['rootDirty', { kind: 'rootDirty', files: ['src/a.ts'], message: '主目錄有未提交的改動,先處理再合併:src/a.ts' }, /先處理再合併/],
  ['agentBusy', { kind: 'agentBusy', message: 'agent 還在工作,等這個回合結束再合併' }, /等這個回合結束/],
  ['failed', { kind: 'failed', message: '合併失敗:fatal' }, /合併失敗/],
] as const)('被拒時同一列顯示原因,合併仍可按(%s)', async (_label, refusal, pattern) => {
  mount([STATUS_AHEAD, refusal as WorktreeMergeResponse, STATUS_AHEAD])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(pattern)
  expect(button('合併').disabled).toBe(false)
})

it('invoke 丟例外時顯示錯誤,不讓畫面卡在合併中', async () => {
  const merge = vi.fn(async (payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse> => {
    if (payload.action === 'status') return STATUS_AHEAD
    throw new Error('合併回傳格式不正確')
  })
  render(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t1" />)
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(/合併回傳格式不正確/)
  expect(button('合併').disabled).toBe(false)
})

// 審查追加:雙擊(或手快連按)只能送一次合併請求,擋在 hook 這層,不能只靠 `busy` state
// (React 同一輪同步事件裡,state 還沒反映到 disabled,連按三次會在同一輪都通過)。
it('連續三次同步點擊合併,只送一次合併請求', async () => {
  const m = mount([
    STATUS_AHEAD,
    { kind: 'merged', target: 'main', branch: 'task', commits: 2, message: '已合併到 main(2 個 commit)' },
    STATUS_CLEAN,
  ])
  await screen.findByText(/領先 2 個 commit/)
  const merge = button('合併')
  await act(async () => {
    merge.click()
    merge.click()
    merge.click()
  })
  await screen.findByText(/已合併到 main/)
  expect(m.requests.filter((r) => r.action === 'merge')).toHaveLength(1)
})

// 審查追加:合併請求還沒回來就換分頁,舊分頁的回應必須被丟掉,不能蓋掉新分頁已經查到的 status。
it('合併進行中換到另一個分頁,舊分頁的回應不會蓋掉新分頁畫面', async () => {
  const TAB2_STATUS: WorktreeMergeResponse = {
    kind: 'status', branch: 'task2', target: 'main', ahead: 1, dirty: false, conflictPending: false,
    message: '分支 task2 → main,領先 1 個 commit',
  }
  let resolveMerge: ((response: WorktreeMergeResponse) => void) | undefined
  const merge = vi.fn(async (payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse> => {
    if (payload.tabId === 't1' && payload.action === 'status') return STATUS_AHEAD
    if (payload.tabId === 't1' && payload.action === 'merge') {
      return new Promise<WorktreeMergeResponse>((resolve) => { resolveMerge = resolve })
    }
    if (payload.tabId === 't2' && payload.action === 'status') return TAB2_STATUS
    throw new Error(`未預期的請求:${JSON.stringify(payload)}`)
  })
  const { rerender } = render(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t1" />)
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { screen.getByRole('button', { name: '合併' }).click() })
  await screen.findByText('合併中')

  rerender(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t2" />)
  await screen.findByText(/領先 1 個 commit/)

  await act(async () => {
    resolveMerge?.({ kind: 'merged', target: 'main', branch: 'task', commits: 2, message: '已合併到 main(2 個 commit)' })
  })
  expect(screen.queryByText(/已合併到 main/)).toBeNull()
  expect(screen.getByText(/領先 1 個 commit/)).toBeTruthy()
})

// 審查追加:分頁 A 停在衝突態,切到乾淨的分頁 B 不該殘留衝突列與放棄合併按鈕。
it('分頁 A 停在衝突,切到乾淨的分頁 B 不會殘留衝突列', async () => {
  let conflicted = false
  const merge = vi.fn(async (payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse> => {
    if (payload.tabId === 't1' && payload.action === 'status') return conflicted ? STATUS_CONFLICT : STATUS_AHEAD
    if (payload.tabId === 't1' && payload.action === 'merge') {
      conflicted = true
      return { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突' }
    }
    if (payload.tabId === 't2' && payload.action === 'status') return STATUS_CLEAN
    throw new Error(`未預期的請求:${JSON.stringify(payload)}`)
  })
  const { rerender } = render(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t1" />)
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { screen.getByRole('button', { name: '合併' }).click() })
  await screen.findByRole('button', { name: '放棄合併' })
  expect(document.querySelector('.worktree-merge-bar.is-conflict')).not.toBeNull()

  rerender(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t2" />)
  await screen.findByText(/已是最新/)
  expect(screen.queryByRole('button', { name: '放棄合併' })).toBeNull()
  expect(document.querySelector('.worktree-merge-bar.is-conflict')).toBeNull()
})
