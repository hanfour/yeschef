import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChefService, type ChefService, type WorkerRequest } from '../src/main/chef/service.js'
import type { DeadlineReviewInput, DeadlineReviewResult } from '../src/main/chef/deadline-reviewer.js'
import type { GroupMessageInput } from '../src/main/group/service.js'
import type { ChefModel, ChefPolicy } from '../src/shared/chef.js'
import type { GroupMessage } from '../src/shared/group.js'

const HOUR = 60 * 60_000
const models: ChefModel[] = [{ key: 'claude:c', provider: 'claude', model: 'c', label: 'Claude', description: '', recommended: true }]
const roots: string[] = []
const services: ChefService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})

async function rig(options: {
  deadlineMinutes?: number
  deadlineReviewer?: (input: DeadlineReviewInput, signal: AbortSignal) => Promise<DeadlineReviewResult>
  groupMessages?: readonly GroupMessage[]
  stop?: () => Promise<boolean>
} = {}) {
  vi.useFakeTimers()
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'yeschef-chef-deadline-')))
  roots.push(root)
  let current = 1_000
  const started: WorkerRequest[] = []
  const written: GroupMessageInput[] = []
  const errors: Error[] = []
  const service = await createChefService({
    dir: join(root, 'tasks'), catalog: { list: async () => ({ models, notices: [] }) },
    rootOf: id => id === 'p' ? root : undefined, busyIn: () => false, now: () => current,
    logError: error => errors.push(error), deadlineReviewer: options.deadlineReviewer,
    group: { write: message => written.push(message), recent: async () => options.groupMessages ?? [] },
    startWorker: async request => { started.push(request); return { stop: options.stop ?? (async () => true) } },
  })
  services.push(service)
  const policy: ChefPolicy = { mode: 'auto', allowed: ['claude:c'], maxExecutions: 8, deadlineMinutes: options.deadlineMinutes ?? 30 }
  const startedRequest = async () => {
    const response = await service.handle({ action: 'start', projectId: 'p', goal: '完成報表與驗收', policy })
    expect(response.kind).toBe('state')
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(0))
    return started[0]!
  }
  const task = () => service.tasksOf('p')[0]!
  const at = async (time: number) => {
    current = time
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
  }
  const elapse = async (milliseconds: number) => {
    current += milliseconds
    await vi.advanceTimersByTimeAsync(milliseconds)
  }
  return { root, service, started, written, errors, current: () => current, setNow: (time: number) => { current = time }, at, elapse, task, startedRequest }
}

it('期限 reviewer 在最後 10 分鐘且有執行中的 attempt 時詢問一次並帶齊任務脈絡', async () => {
  let decide!: (result: DeadlineReviewResult) => void
  const review = vi.fn((_input: DeadlineReviewInput, _signal: AbortSignal) => new Promise<DeadlineReviewResult>(resolve => { decide = resolve }))
  const groupMessage = { id: 'm1', projectId: 'p', threadId: 'task', at: 1, from: { kind: 'user' }, kind: 'text', text: '先完成測試', mentions: [] } as GroupMessage
  const r = await rig({ deadlineReviewer: review, groupMessages: [groupMessage] })
  await r.startedRequest()
  const taskId = r.task().id
  await r.service.handle({ action: 'cancel', taskId })
  await r.service.handle({ action: 'resume', taskId, reconciled: false, message: '新增補充：先保留未驗收結果' })
  await vi.waitFor(() => expect(r.started.length).toBe(2))
  const task = r.task()

  await r.at(task.deadlineAt - 10 * 60_000 - 1_000)
  expect(review).not.toHaveBeenCalled()
  await r.at(task.deadlineAt - 10 * 60_000)
  await vi.waitFor(() => expect(review).toHaveBeenCalledOnce())
  await r.at(task.deadlineAt - 10 * 60_000 + 1_000)
  expect(review).toHaveBeenCalledOnce()
  expect(review.mock.calls[0]?.[0]).toMatchObject({
    goal: '完成報表與驗收', followups: ['新增補充：先保留未驗收結果'], remainingMinutes: 10, usedMinutes: 20,
    units: [{ title: '規劃與執行', status: 'running' }],
    groupMessages: [{ from: '你', kind: 'text', text: '先完成測試' }],
  })
  expect(review.mock.calls[0]?.[0].attempts).toContainEqual(expect.objectContaining({ label: '主廚', status: 'running' }))
  expect(review.mock.calls[0]?.[0].attempts).toContainEqual(expect.objectContaining({ label: '主廚', status: 'blocked', reason: expect.stringContaining('使用者停止') }))
  decide({ extendMinutes: 0, reason: '不需要額外時間' })
  await vi.waitFor(() => expect(r.written.some(message => message.text.includes('主廚判斷不延長期限'))).toBe(true))
})

it('沒有注入期限 reviewer 時到期仍直接停止', async () => {
  const r = await rig()
  await r.startedRequest()
  const deadline = r.task().deadlineAt

  await r.at(deadline - 10 * 60_000)
  expect(r.task().status).toBe('running')
  await r.at(deadline)
  await vi.waitFor(() => expect(r.task().status).toBe('cancelled'))
  expect(r.written.some(message => message.text.includes('主廚判斷'))).toBe(false)
})

it('期限延長每次最多 60 分鐘且任務總期限裁切在建立後 8 小時', async () => {
  const review = vi.fn(async () => ({ extendMinutes: 90, reason: '尚需驗收' }))
  const r = await rig({ deadlineMinutes: 235, deadlineReviewer: review })
  await r.startedRequest()
  const initialDeadline = r.task().deadlineAt

  for (let count = 0; count < 4; count += 1) {
    await r.at(r.task().deadlineAt - 10 * 60_000)
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(count + 1))
  }
  expect(r.task().deadlineAt).toBe(initialDeadline + 4 * 60 * 60_000)
  await r.at(r.task().deadlineAt - 10 * 60_000)
  await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(5))
  expect(r.task().deadlineAt).toBe(r.task().createdAt + 8 * HOUR)
  expect(r.written.filter(message => message.text.includes('主廚把期限延長')).at(-1)?.text).toContain('延長 5 分鐘')
})

it('期限 reviewer 失敗時記錄錯誤、期限不變並寫群組失敗訊息', async () => {
  const failure = Error('review failed')
  const review = vi.fn(async () => { throw failure })
  const r = await rig({ deadlineReviewer: review })
  await r.startedRequest()
  const deadline = r.task().deadlineAt

  await r.at(deadline - 10 * 60_000)
  await vi.waitFor(() => expect(r.errors).toContain(failure))
  expect(r.task().deadlineAt).toBe(deadline)
  expect(r.written.some(message => message.text === '期限延長判斷失敗，到期會停止')).toBe(true)
})

it('期限到期時等待中的判斷最多等 2 分鐘，期間回覆可延長期限', async () => {
  let decide!: (result: DeadlineReviewResult) => void
  const review = vi.fn((_input: DeadlineReviewInput, _signal: AbortSignal) => new Promise<DeadlineReviewResult>(resolve => { decide = resolve }))
  const r = await rig({ deadlineReviewer: review })
  await r.startedRequest()
  const deadline = r.task().deadlineAt

  await r.at(deadline - 10 * 60_000)
  await r.at(deadline)
  expect(r.task().status).toBe('running')
  decide({ extendMinutes: 15, reason: '仍有最後驗收' })
  await vi.waitFor(() => expect(r.task().deadlineAt).toBe(deadline + 15 * 60_000))
  expect(r.task().status).toBe('running')
})

it('期限判斷超過到期後 2 分鐘視為不延長並停止任務', async () => {
  let signal: AbortSignal | undefined
  const review = vi.fn((_input: DeadlineReviewInput, activeSignal: AbortSignal) => { signal = activeSignal; return new Promise<DeadlineReviewResult>(() => {}) })
  const r = await rig({ deadlineReviewer: review })
  await r.startedRequest()
  const deadline = r.task().deadlineAt

  await r.at(deadline - 10 * 60_000)
  await r.at(deadline)
  expect(r.task().status).toBe('running')
  await r.elapse(2 * 60_000)
  await vi.waitFor(() => expect(r.task().status).toBe('cancelled'))
  expect(signal?.aborted).toBe(true)
  expect(r.written.at(-1)?.text).toContain('在這個目標裡回覆即可接續')
})

it('沒有 running attempt 時不詢問期限 reviewer', async () => {
  let release!: (result: boolean) => void
  let waitForStop = true
  const review = vi.fn(async () => ({ extendMinutes: 10, reason: '再驗收' }))
  const r = await rig({ deadlineReviewer: review, stop: () => waitForStop ? new Promise<boolean>(resolve => { waitForStop = false; release = resolve }) : Promise.resolve(true) })
  const first = await r.startedRequest()
  r.service.observe(first.id, [{ kind: 'session-end', isError: false }])
  await vi.waitFor(() => expect(r.task().attempts[0]?.status).toBe('stopping'))
  await r.at(r.task().deadlineAt - 1)
  expect(review).not.toHaveBeenCalled()
  release(true)
})

it('任務先完成時中止仍在進行的期限判斷', async () => {
  let decide!: (result: DeadlineReviewResult) => void
  let signal: AbortSignal | undefined
  const review = vi.fn((_input: DeadlineReviewInput, activeSignal: AbortSignal) => {
    signal = activeSignal
    return new Promise<DeadlineReviewResult>(resolve => { decide = resolve })
  })
  const r = await rig({ deadlineReviewer: review })
  const worker = await r.startedRequest()
  await r.service.report(worker.id, { outcome: 'completed', summary: '已完成', checks: [] })
  await r.at(r.task().deadlineAt - 10 * 60_000)
  await vi.waitFor(() => expect(review).toHaveBeenCalledOnce())
  r.service.observe(worker.id, [{ kind: 'session-end', isError: false }])
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(() => expect(r.task().status).toBe('completed'))
  const wasAborted = signal?.aborted
  decide({ extendMinutes: 30, reason: '已無需延長' })
  expect(wasAborted).toBe(true)
})
