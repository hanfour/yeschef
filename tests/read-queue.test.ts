import { afterEach, describe, expect, it, vi } from 'vitest'
import { queuedReader, resetQueueForTests } from '../src/renderer/read-queue.js'
import type { PreviewReadResult } from '../src/shared/ipc.js'

afterEach(resetQueueForTests)

describe('queuedReader', () => {
  it('同時最多送出 2 個,前面的回來才送下一個', async () => {
    const pending: (() => void)[] = []
    let inFlight = 0
    let peak = 0
    const api = {
      readPreview: () => new Promise<PreviewReadResult>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        pending.push(() => { inFlight -= 1; resolve({ kind: 'markdown', text: 'x' }) })
      }),
    }
    const read = queuedReader(api)
    const all = Promise.all([1, 2, 3, 4, 5].map((i) => read({ projectId: 'p', path: `${String(i)}.md` })))
    await Promise.resolve()
    expect(pending).toHaveLength(2)
    while (pending.length > 0) {
      pending.shift()?.()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect((await all).map((r) => r.kind)).toEqual(['markdown', 'markdown', 'markdown', 'markdown', 'markdown'])
    expect(peak).toBe(2)
  })

  it('失敗也會讓出名額', async () => {
    let calls = 0
    const api = { readPreview: async (): Promise<PreviewReadResult> => { calls += 1; throw new Error('boom') } }
    const read = queuedReader(api)
    const results = await Promise.allSettled([1, 2, 3].map(() => read({ projectId: 'p', path: 'a.md' })))
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(calls).toBe(3)
  })
})

it('不同 api 物件共用同一個 queue', async () => {
  let started: readonly string[] = []
  let pending: readonly (() => void)[] = []
  const makeApi = (name: string) => ({
    readPreview: () => new Promise<PreviewReadResult>((resolve) => {
      started = [...started, name]
      pending = [...pending, () => resolve({ kind: 'markdown', text: name })]
    }),
  })
  const first = queuedReader(makeApi('a'))
  const second = queuedReader(makeApi('b'))
  const third = queuedReader(makeApi('c'))
  const payload = { projectId: 'p', path: 'a.md' }
  const all = Promise.all([first(payload), first(payload), second(payload), second(payload), third(payload)])
  // 先排空請求再斷言，失敗時也不把模組共用的名額留給下一個測試。
  const initial = [...started]
  let batches: readonly (readonly string[])[] = []
  while (pending.length > 0) {
    const [finish, ...rest] = pending
    pending = rest
    finish?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    batches = [...batches, started]
  }
  await all
  expect(initial).toEqual(['a', 'a'])
  expect(batches).toEqual([
    ['a', 'a', 'b'], ['a', 'a', 'b', 'b'],
    ['a', 'a', 'b', 'b', 'c'], ['a', 'a', 'b', 'b', 'c'], ['a', 'a', 'b', 'b', 'c'],
  ])
})


it('重設清空名額與等待者，舊請求完成不干擾新佇列', async () => {
  let finishOld: (() => void) | undefined
  const oldApi = { readPreview: vi.fn(() => new Promise<PreviewReadResult>((resolve) => {
    finishOld = () => resolve({ kind: 'markdown', text: '舊結果' })
  })) }
  const payload = { projectId: 'p', path: 'a.md' }
  const oldRead = queuedReader(oldApi)
  void oldRead(payload)
  const oldFinished = oldRead(payload)
  void oldRead(payload)
  expect(oldApi.readPreview).toHaveBeenCalledTimes(2)

  resetQueueForTests()

  let pending: readonly (() => void)[] = []
  const newApi = { readPreview: vi.fn(() => new Promise<PreviewReadResult>((resolve) => {
    pending = [...pending, () => resolve({ kind: 'markdown', text: '新結果' })]
  })) }
  const newRead = queuedReader(newApi)
  const first = newRead(payload)
  const second = newRead(payload)
  expect(newApi.readPreview).toHaveBeenCalledTimes(2)
  finishOld?.()
  await oldFinished
  const third = newRead(payload)
  expect(newApi.readPreview).toHaveBeenCalledTimes(2)

  const [finishFirst, finishSecond] = pending
  finishFirst?.()
  await first
  await Promise.resolve()
  expect(newApi.readPreview).toHaveBeenCalledTimes(3)
  expect(oldApi.readPreview).toHaveBeenCalledTimes(2)
  finishSecond?.()
  pending[2]?.()
  await Promise.all([second, third])
})
