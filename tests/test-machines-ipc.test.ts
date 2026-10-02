import { describe, expect, it, vi } from 'vitest'
import { createTestMachinesIpcHandler, type TestMachinesIpcHandlerDeps } from '../src/main/test-machines/ipc.js'
import type { TestMachinesRequest, TestMachinesResponse } from '../src/shared/test-machines.js'

const TRUSTED = { sender: 'trusted' }
const UNTRUSTED = { sender: 'other' }

function setup(overrides: Partial<TestMachinesIpcHandlerDeps> = {}) {
  const handle = vi.fn<(raw: unknown) => Promise<TestMachinesResponse>>(async () => ({ kind: 'state', revision: 0, machines: [] }))
  const deps: TestMachinesIpcHandlerDeps = {
    isTrustedSender: (sender) => sender === 'trusted',
    handle,
    ...overrides,
  }
  return { onEvent: createTestMachinesIpcHandler(deps), handle }
}

describe('createTestMachinesIpcHandler', () => {
  it('不信任的來源回 error,不呼叫 handle(I5)', async () => {
    const { onEvent, handle } = setup()
    await expect(onEvent(UNTRUSTED, { action: 'list', projectId: 'p1' })).resolves.toEqual({ kind: 'error', message: '不接受此來源的測試機請求' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('信任的來源原樣轉給 handle,回傳它的結果', async () => {
    const response: TestMachinesResponse = { kind: 'state', revision: 3, machines: [] }
    const handle = vi.fn(async () => response)
    const { onEvent } = setup({ handle })
    const raw: TestMachinesRequest = { action: 'list', projectId: 'p1' }
    await expect(onEvent(TRUSTED, raw)).resolves.toBe(response)
    expect(handle).toHaveBeenCalledWith(raw)
  })
})
