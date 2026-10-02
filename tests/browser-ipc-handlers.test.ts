import { describe, expect, it, vi } from 'vitest'
import { createBrowserIpcHandlers, type BrowserIpcHandlersDeps } from '../src/main/browser-ipc-handlers.js'
import type { BrowserCommandResult, BrowserSnapshot } from '../src/shared/browser-ipc.js'
import { MSG } from '../src/main/view-tools/errors.js'

const SNAPSHOT: BrowserSnapshot = { states: [], sessions: [] }
const TRUSTED = { sender: 'trusted' }
const UNTRUSTED = { sender: 'other' }

function setup(overrides: Partial<BrowserIpcHandlersDeps> = {}) {
  const run = vi.fn<(command: never) => Promise<BrowserCommandResult>>(async () => ({ ok: true }))
  const logError = vi.fn()
  const deps: BrowserIpcHandlersDeps = {
    isTrustedSender: (sender) => sender === 'trusted',
    commands: { run },
    snapshot: () => SNAPSHOT,
    logError,
    ...overrides,
  }
  return { handlers: createBrowserIpcHandlers(deps), run, logError }
}

describe('createBrowserIpcHandlers', () => {
  it('onCommand 拒絕不信任的來源', async () => {
    const { handlers, run } = setup()
    await expect(handlers.onCommand(UNTRUSTED, { kind: 'reload' })).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it('onGet 拒絕不信任的來源', () => {
    const { handlers } = setup()
    expect(() => handlers.onGet(UNTRUSTED)).toThrow()
  })

  it('payload 格式不對:記錄錯誤並回 ok:false,不呼叫 commands.run', async () => {
    const { handlers, run, logError } = setup()
    const result = await handlers.onCommand(TRUSTED, { kind: 'not-a-real-kind' })
    expect(result).toEqual({ ok: false, message: MSG.internal(MSG.badCommand) })
    expect(run).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('合法 payload:原樣轉給 commands.run,回傳它的結果', async () => {
    const run = vi.fn(async () => ({ ok: false as const, message: '擋下來了' }))
    const { handlers } = setup({ commands: { run } })
    const result = await handlers.onCommand(TRUSTED, { kind: 'navigate', url: 'https://a.test' })
    expect(run).toHaveBeenCalledWith({ kind: 'navigate', url: 'https://a.test' })
    expect(result).toEqual({ ok: false, message: '擋下來了' })
  })

  it('onGet:信任的來源回傳目前的 snapshot', () => {
    const { handlers } = setup()
    expect(handlers.onGet(TRUSTED)).toBe(SNAPSHOT)
  })
})
