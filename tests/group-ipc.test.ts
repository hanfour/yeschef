import { describe, expect, it, vi } from 'vitest'
import { createGroupIpcHandler } from '../src/main/group/ipc.js'
import type { GroupResponse } from '../src/shared/group.js'

const state: GroupResponse = { kind: 'state', messages: [], threads: [] }

describe('group:manage 的 handler', () => {
  it('來源不對直接回 error,不呼叫 handle', async () => {
    const handle = vi.fn(async () => state)
    const onCall = createGroupIpcHandler({ isTrustedSender: () => false, handle })
    expect(await onCall({ sender: 'other' }, { action: 'get', projectId: 'p1' })).toEqual({ kind: 'error', message: '不接受此來源的群組請求' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('來源正確就把原始 payload 原樣交給 handle', async () => {
    const handle = vi.fn(async () => state)
    const onCall = createGroupIpcHandler({ isTrustedSender: () => true, handle })
    expect(await onCall({ sender: 'renderer' }, { action: 'get', projectId: 'p1' })).toEqual(state)
    expect(handle).toHaveBeenCalledWith({ action: 'get', projectId: 'p1' })
  })

  it('handle 丟例外時回 error,不讓主行程冒出未捕捉例外', async () => {
    const onCall = createGroupIpcHandler({ isTrustedSender: () => true, handle: () => Promise.reject(new Error('壞了')) })
    expect(await onCall({ sender: 'renderer' }, { action: 'get', projectId: 'p1' })).toEqual({ kind: 'error', message: '壞了' })
  })
})
