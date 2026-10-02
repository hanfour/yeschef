import { expect, it, vi } from 'vitest'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { createDeadlineReviewer, type DeadlineReviewInput } from '../src/main/chef/deadline-reviewer.js'

const input: DeadlineReviewInput = {
  goal: '完成目標',
  followups: ['先保留未驗收結果'],
  units: [{ title: '實作', status: 'running' }],
  attempts: [{ label: 'codex-1', status: 'running', reason: '正在修改' }],
  groupMessages: [{ from: '你', kind: 'text', text: '請先完成測試' }],
  remainingMinutes: 9,
  usedMinutes: 51,
}

it('期限 reviewer 使用一次性、無工具、無持久化的隔離 session', async () => {
  let args: Parameters<typeof query>[0] | undefined
  const close = vi.fn()
  const mock = ((params: Parameters<typeof query>[0]) => {
    args = params
    return { close, async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', is_error: false, structured_output: { extendMinutes: 30, reason: '剩餘工作需要多一輪驗收' } } } }
  }) as unknown as typeof query
  const review = createDeadlineReviewer(mock, '/isolated')

  await expect(review(input, new AbortController().signal)).resolves.toEqual({ extendMinutes: 30, reason: '剩餘工作需要多一輪驗收' })
  expect(args?.options).toMatchObject({ cwd: '/isolated', tools: [], maxTurns: 1, persistSession: false, settingSources: [], maxBudgetUsd: 0.25 })
  expect(args?.options?.outputFormat).toMatchObject({ type: 'json_schema' })
  expect(args?.options?.systemPrompt).toContain('不可信')
  expect(args?.prompt).toContain(JSON.stringify(input))
  expect(close).toHaveBeenCalledOnce()
})

it('期限 reviewer 將外部 abort 傳給模型 session，並拒絕不符 schema 的結果', async () => {
  let abortController: AbortController | undefined
  const mock = ((params: Parameters<typeof query>[0]) => {
    abortController = params.options?.abortController
    return { close: vi.fn(), async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', is_error: false, structured_output: { extendMinutes: '60', reason: '格式錯誤' } } } }
  }) as unknown as typeof query
  const review = createDeadlineReviewer(mock, '/isolated')
  const controller = new AbortController()
  const result = review(input, controller.signal)
  controller.abort()

  expect(abortController?.signal.aborted).toBe(true)
  await expect(result).rejects.toThrow()
})
