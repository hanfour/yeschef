import { expect, it, vi } from 'vitest'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import { createPermissionReviewer } from '../src/main/permissions/reviewer.js'
it('審核工作隔離設定、工具與歷史，且綁定輸入 hash', async () => {
  let options: Parameters<typeof query>[0]['options']
  const close = vi.fn()
  const mock = ((args: Parameters<typeof query>[0]) => {
    options = args.options
    return { close, async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', is_error: false, structured_output: { requestHash: 'hash', verdict: 'allow', reason: 'ok' } } } }
  }) as unknown as typeof query
  const review = createPermissionReviewer(mock, '/isolated')
  expect(await review({ requestHash: 'hash', purpose: 'task', operation: 'write', paths: ['/p/a'], input: {} }, new AbortController().signal)).toMatchObject({ verdict: 'allow' })
  expect(options).toMatchObject({ tools: [], mcpServers: {}, strictMcpConfig: true, plugins: [], persistSession: false, settingSources: [], cwd: '/isolated', maxBudgetUsd: 0.25 })
  expect(close).toHaveBeenCalledOnce()
  await expect(review({ requestHash: 'changed', purpose: 'task', operation: 'write', paths: [], input: {} }, new AbortController().signal)).rejects.toThrow('不一致')
})
