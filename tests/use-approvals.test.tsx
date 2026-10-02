// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useApprovals } from '../src/renderer/hooks/useApprovals.js'
import { useProjects } from '../src/renderer/hooks/useProjects.js'
import { App } from '../src/renderer/App.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import type { ProjectsView } from '../src/shared/projects.js'
import { createFakeYesChef as createFakeApi, ONE_PROJECT, projectView } from './helpers/fake-yeschef.js'

/** 切到第二個專案之後的 view:`activeId` 換人,兩個專案都還在清單裡。 */
const TWO_PROJECTS: ProjectsView = {
  activeId: 'p-2',
  projects: [...ONE_PROJECT.projects, projectView('p-2')],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function ask(requestId: string, over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId,
    projectId: 'p-1',
    conversationId: 'p-1-conv',
    toolUseId: `toolu_${requestId}`,
    toolName: 'Bash',
    input: { command: 'ls' },
    ...over,
  }
}

describe('useApprovals', () => {
  it('一開始沒有待決請求，且已經訂閱三個頻道', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    expect(result.current.pending).toEqual([])
    expect(fake.listenerCounts()).toEqual({ ask: 1, settled: 1, state: 1 })
  })

  it('依到達順序累積，且每次都是新陣列（不就地 push）', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))

    fake.emitAsk(ask('req-1'))
    const afterFirst = result.current.pending
    fake.emitAsk(ask('req-2', { toolName: 'Write' }))

    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1', 'req-2'])
    expect(result.current.pending).not.toBe(afterFirst)
    expect(afterFirst.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('同一個 requestId 重送不會疊出第二張卡片', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-1'))
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('reply 把決定送給 main，並把那一筆從 pending 移除', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-2'))

    act(() => {
      result.current.reply('req-1', 'allow')
    })

    expect(fake.replies).toEqual([{ requestId: 'req-1', decision: 'allow' }])
    // 卡片按了就要消失：這條是「按了沒反應」那個 bug 的守門員。
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-2'])
  })

  it('reply 只移除指定的那一筆，deny 一樣送得出去', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-2'))
    fake.emitAsk(ask('req-3'))

    act(() => {
      result.current.reply('req-2', 'deny')
    })

    expect(fake.replies).toEqual([{ requestId: 'req-2', decision: 'deny' }])
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1', 'req-3'])
  })

  it('回覆一個不存在的 requestId 不影響 pending，但仍然送出去', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    fake.emitAsk(ask('req-1'))

    act(() => {
      result.current.reply('req-does-not-exist', 'deny')
    })

    expect(fake.replies).toHaveLength(1)
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('session 狀態變動不再清空 pending:了結由 main 的 approval:settled 通知', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    fake.emitAsk(ask('req-1'))
    fake.emitState({ kind: 'idle' })
    fake.emitState({ kind: 'viewing', sessionId: 's-1' })
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
    expect(fake.replies).toEqual([])
  })

  it('approval:settled 到達就把那一筆移除,不代替使用者回答', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-2'))
    fake.emitSettled({ requestId: 'req-1' })
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-2'])
    expect(fake.replies).toEqual([])
  })

  it('settled 指到不存在的 requestId 時 pending 原樣不動', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    fake.emitAsk(ask('req-1'))
    const before = result.current.pending
    fake.emitSettled({ requestId: 'nope' })
    expect(result.current.pending).toBe(before)
  })

  it('切到別的對話:別的對話的卡藏起來,不清掉、不代替使用者回答', () => {
    const fake = createFakeApi({ projects: ONE_PROJECT })
    const { result, rerender } = renderHook(({ activeId }) => useApprovals(fake.api, activeId), {
      initialProps: { activeId: 'p-1-conv' as string | null },
    })
    fake.emitAsk(ask('req-1'))
    expect(result.current.pending).toHaveLength(1)

    rerender({ activeId: 'p-2-conv' })
    expect(result.current.pending).toEqual([])
    expect(fake.replies).toEqual([])
  })

  it('切回原對話:前景時送到的卡還在(RESULTS-08 記的窄窗口)', () => {
    const fake = createFakeApi({ projects: ONE_PROJECT })
    const { result, rerender } = renderHook(({ activeId }) => useApprovals(fake.api, activeId), {
      initialProps: { activeId: 'p-1-conv' as string | null },
    })
    fake.emitAsk(ask('req-1'))
    rerender({ activeId: 'p-2-conv' })
    rerender({ activeId: 'p-1-conv' })
    expect(result.current.pending.map((p) => p.requestId)).toEqual(['req-1'])
  })

  it('pending 只列 conversationId 那個對話的卡,別的對話的照樣收著', () => {
    const fake = createFakeApi({ projects: ONE_PROJECT })
    const { result, rerender } = renderHook(({ activeId }) => useApprovals(fake.api, activeId), {
      initialProps: { activeId: 'p-1-conv' as string | null },
    })
    fake.emitAsk(ask('req-p1'))
    fake.emitAsk(ask('req-p2', { projectId: 'p-2', conversationId: 'p-2-conv' }))
    expect(result.current.pending.map((p) => p.requestId)).toEqual(['req-p1'])
    rerender({ activeId: 'p-2-conv' })
    expect(result.current.pending.map((p) => p.requestId)).toEqual(['req-p2'])
  })

  /**
   * I1 那個時序問題在鏡像設計下不存在:`projects:state` 與新專案的 ask 同一批到達,
   * 兩者都只是各自更新自己的狀態,顯示結果由 activeId 過濾決定,沒有「清空」動作可以搶跑。
   */
  it('切專案的 projects:state 與新專案的 ask 同一批到達:舊卡藏起來、新卡顯示', () => {
    const fake = createFakeApi({ projects: ONE_PROJECT })
    const { result } = renderHook(() => {
      const projects = useProjects(fake.api)
      return useApprovals(fake.api, projects.active?.tabs.find((t) => t.contentType === 'conversation')?.id ?? null)
    })
    fake.emitProjects(ONE_PROJECT)
    fake.emitAsk(ask('req-p1'))
    expect(result.current.pending.map((p) => p.requestId)).toEqual(['req-p1'])

    act(() => {
      fake.raw.projects(TWO_PROJECTS)
      fake.raw.ask(ask('req-p2', { projectId: 'p-2', conversationId: 'p-2-conv' }))
    })

    expect(result.current.pending.map((p) => p.requestId)).toEqual(['req-p2'])
    expect(fake.replies).toEqual([])
  })

  it('卸載時三個訂閱都解除', () => {
    const fake = createFakeApi()
    const { unmount } = renderHook(() => useApprovals(fake.api, 'p-1-conv'))
    expect(fake.listenerCounts()).toEqual({ ask: 1, settled: 1, state: 1 })
    unmount()
    expect(fake.listenerCounts()).toEqual({ ask: 0, settled: 0, state: 0 })
  })
})

describe('App 與批准的接線', () => {
  /**
   * 規格 §6「批准時輸入框停用」。Task 9B 的 Composer 留了 disabled 這個 prop
   * 沒有接，本 task 接上：pending 非空就停用，pending 清空就恢復。
   *
   * 這條放在本檔而不是另開一個 App 測試檔：要斷言的東西完全由 useApprovals 的
   * pending 決定，跟這裡既有的假 api 是同一套裝置。
   */
  it('有待決請求時輸入框與送出鍵都停用，請求清掉之後恢復', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    const send = container.querySelector('.composer-send')
    if (input === null || send === null) throw new Error('找不到輸入框或送出鍵')
    fireEvent.change(input, { target: { value: '保留這份草稿' } })

    expect(input.disabled).toBe(false)
    expect((send as HTMLButtonElement).disabled).toBe(false)

    fake.emitAsk(ask('req-1'))
    expect(input.disabled).toBe(true)
    expect((send as HTMLButtonElement).disabled).toBe(true)

    // main 通知那筆已了結,輸入框跟著恢復。
    fake.emitSettled({ requestId: 'req-1' })
    expect(input.disabled).toBe(false)
    expect((send as HTMLButtonElement).disabled).toBe(false)
  })

  /**
   * 修正 1（RESULTS 待辦第 4 列，D4）：批准逾時之後主程序直接 deny，renderer 收不到
   * 任何通知，`pending` 這一筆一直留著。停用的判準改成 `openAsks`：block 一旦了結
   * （這裡是 `tool-result { isError: true }` 讓它進 `error`），就不再算「還在等」。
   */
  it('D4：block 了結後即使 pending 還留著那筆，輸入框仍要解鎖，卡片也要消失', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    const send = container.querySelector('.composer-send')
    if (input === null || send === null) throw new Error('找不到輸入框或送出鍵')
    fireEvent.change(input, { target: { value: '保留這份草稿' } })

    fake.emitEvents([
      { kind: 'tool-use', messageId: 'm1', id: 'toolu_req-1', name: 'Bash', input: { command: 'ls' } },
    ])
    fake.emitAsk(ask('req-1', { toolUseId: 'toolu_req-1' }))

    expect(input.disabled).toBe(true)
    expect((send as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('.approval-card')).not.toBeNull()

    // 逾時被 deny：block 收到 isError 的 tool-result，主程序沒有另外通知 renderer。
    fake.emitEvents([{ kind: 'tool-result', id: 'toolu_req-1', content: '批准請求逾時', isError: true }])

    expect(input.disabled).toBe(false)
    expect((send as HTMLButtonElement).disabled).toBe(false)
    expect(container.querySelector('.approval-card')).toBeNull()
    expect(container.querySelector('.approval-tail')).toBeNull()
  })

  it('對照：ask 對應的 toolUseId 在 view 裡不存在，仍然停用，卡片畫在對話尾端', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    const send = container.querySelector('.composer-send')
    if (input === null || send === null) throw new Error('找不到輸入框或送出鍵')

    fake.emitAsk(ask('req-early', { toolUseId: 'toolu_not_yet' }))

    expect(input.disabled).toBe(true)
    expect((send as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('.approval-tail')).not.toBeNull()
  })
})

describe('useApprovals 的 foreign', () => {
  it('自己的進 pending,別的對話的進 foreign', () => {
    const f = createFakeApi()
    const { result } = renderHook(() => useApprovals(f.api, 'c1'))
    f.emitAsk(ask('r1', { conversationId: 'c1' }))
    f.emitAsk(ask('r2', { conversationId: 'c2' }))
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['r1'])
    expect(result.current.foreign.map((a) => a.requestId)).toEqual(['r2'])
  })

  it('foreign 依到達順序,不分專案', () => {
    const f = createFakeApi()
    const { result } = renderHook(() => useApprovals(f.api, 'c1'))
    f.emitAsk(ask('r2', { conversationId: 'c2', projectId: 'p2' }))
    f.emitAsk(ask('r3', { conversationId: 'c3', projectId: 'p1' }))
    expect(result.current.foreign.map((a) => a.requestId)).toEqual(['r2', 'r3'])
  })

  it('沒有目前對話時全部算 foreign', () => {
    const f = createFakeApi()
    const { result } = renderHook(() => useApprovals(f.api, null))
    f.emitAsk(ask('r1', { conversationId: 'c1' }))
    expect(result.current.pending).toEqual([])
    expect(result.current.foreign.map((a) => a.requestId)).toEqual(['r1'])
  })
})

it('重載拉取所有批准,晚快照合併新推送且不復活已了結或已回覆的卡', async () => {
  const f = createFakeApi()
  let resolve!: (asks: readonly ApprovalAskPayload[]) => void
  f.api.getApprovals = () => new Promise((done) => { resolve = done })
  const { result } = renderHook(() => useApprovals(f.api, 'p-1-conv'))
  f.emitAsk(ask('new'))
  f.emitSettled({ requestId: 'settled' })
  act(() => result.current.reply('replied', 'allow'))
  await act(async () => resolve([ask('old'), ask('new'), ask('settled'), ask('replied'), ask('foreign', { conversationId: 'other' })]))
  expect(result.current.pending.map((a) => a.requestId)).toEqual(['old', 'new'])
  expect(result.current.foreign.map((a) => a.requestId)).toEqual(['foreign'])
})

it('卸載之後才回來的快照不會流進下一次掛載', async () => {
  const f = createFakeApi()
  let resolve!: (asks: readonly ApprovalAskPayload[]) => void
  f.api.getApprovals = () => new Promise((done) => { resolve = done })
  const first = renderHook(() => useApprovals(f.api, null))
  first.unmount()
  await act(async () => resolve([ask('old')]))
  // 這一次掛載自己拉到的是空的:上一次卸載後才 resolve 的那份不該被看見。
  f.api.getApprovals = () => Promise.resolve([])
  const second = renderHook(() => useApprovals(f.api, null))
  await act(async () => {})
  expect(second.result.current.foreign).toEqual([])
  expect(second.result.current.pending).toEqual([])
})

it('拉取失敗留下錯誤,訂閱照樣可用', async () => {
  const f = createFakeApi()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  f.api.getApprovals = () => Promise.reject(new Error('offline'))
  const { result } = renderHook(() => useApprovals(f.api, 'p-1-conv'))
  await act(async () => {})
  expect(log).toHaveBeenCalledWith('讀取批准請求失敗', expect.any(Error))
  act(() => { f.emitAsk(ask('after', { conversationId: 'p-1-conv' })) })
  expect(result.current.pending.map((a) => a.requestId)).toEqual(['after'])
  log.mockRestore()
})
