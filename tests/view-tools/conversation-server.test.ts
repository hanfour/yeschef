// tests/view-tools/conversation-server.test.ts
import { describe, expect, it, vi } from 'vitest'
import { MSG } from '../../src/main/view-tools/errors.js'
import { createConversationViewServer } from '../../src/main/view-tools/conversation-server.js'
import type { ViewTools } from '../../src/main/view-tools/server.js'

function fakeTools(): ViewTools & { invoke: ReturnType<typeof vi.fn> } {
  return {
    invoke: vi.fn(() => Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: '好了' } })),
    handoffDone: vi.fn(), abortPending: vi.fn(), busy: () => false, dispose: () => Promise.resolve(),
  }
}

describe('每個對話的 view server', () => {
  it('建立時不呼叫 resolve;第一次 invoke 才呼叫', async () => {
    const tools = fakeTools()
    const resolve = vi.fn(() => Promise.resolve(tools))
    const server = createConversationViewServer({ resolve, logError: vi.fn() })
    expect(resolve).not.toHaveBeenCalled()
    await server.invoke('view_snapshot', {}, { callId: 'a' })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(tools.invoke).toHaveBeenCalledWith('view_snapshot', {}, { callId: 'a' })
  })

  it('resolve 失敗回 browserUnavailable 並記錯;下一次呼叫會再試', async () => {
    const tools = fakeTools()
    const logError = vi.fn()
    const resolve = vi.fn<() => Promise<ViewTools>>()
      .mockRejectedValueOnce(new Error('CDP 附著逾時'))
      .mockResolvedValueOnce(tools)
    const server = createConversationViewServer({ resolve, logError })
    await expect(server.invoke('view_snapshot', {}, { callId: 'a' })).resolves.toEqual({ ok: false, text: MSG.browserUnavailable })
    expect(logError).toHaveBeenCalledTimes(1)
    await expect(server.invoke('view_snapshot', {}, { callId: 'b' })).resolves.toMatchObject({ ok: true })
  })

  it('dispose 之後不呼叫 resolve,直接回 sessionEnded', async () => {
    const resolve = vi.fn(() => Promise.resolve(fakeTools()))
    const server = createConversationViewServer({ resolve, logError: vi.fn() })
    server.dispose()
    await expect(server.invoke('view_snapshot', {}, { callId: 'a' })).resolves.toEqual({ ok: false, text: MSG.sessionEnded })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolve 還沒回來對話就被關掉:回 sessionEnded,不把呼叫交給工具', async () => {
    const tools = fakeTools()
    let release: (t: ViewTools) => void = () => {}
    const server = createConversationViewServer({
      resolve: () => new Promise<ViewTools>((r) => { release = r }), logError: vi.fn(),
    })
    const pending = server.invoke('view_snapshot', {}, { callId: 'a' })
    server.dispose()
    release(tools)
    await expect(pending).resolves.toEqual({ ok: false, text: MSG.sessionEnded })
    expect(tools.invoke).not.toHaveBeenCalled()
  })
})
