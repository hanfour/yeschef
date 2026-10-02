import { describe, expect, it, vi } from 'vitest'
import type { WebContentsView } from 'electron'
import { createViewToolServer } from '../../src/main/view-tools/server.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import { manualClock } from '../helpers/manual-clock.js'

async function setup() {
  const cdp = createFakeCdp()
  for (const method of ['DOM.enable', 'Network.enable', 'Accessibility.enable']) {
    cdp.onSend(method, () => ({}))
  }
  const logError = vi.fn<(error: Error) => void>()
  const tools = await createViewToolServer({
    view: { webContents: {
      getURL: () => 'https://example.test/', isDestroyed: () => false,
      on: vi.fn(), off: vi.fn(),
    } } as unknown as WebContentsView,
    cdp, clock: manualClock().clock, projectDir: () => '/專案', logError,
    credentials: async () => undefined,
  })
  return { tools, logError }
}

describe('真實交接等待的生命週期', () => {
  it('切分頁不打斷沒有外部 signal 的交接', async () => {
    const { tools } = await setup()
    try {
      const result = tools.invoke('request_handoff', { reason: 'x' }, { callId: 'exec-1' })
      tools.abortPending(MSG.sessionEnded)
      tools.handoffDone('exec-1')
      await expect(result).resolves.toEqual({
        ok: true, output: { kind: 'text', text: MSG.handoffDone('https://example.test/') },
      })
    } finally { await tools.dispose() }
  })

  it('dispose 仍中止交接', async () => {
    const { tools } = await setup()
    try {
      const result = tools.invoke('request_handoff', { reason: 'x' }, { callId: 'exec-1' })
      await tools.dispose()
      tools.handoffDone('exec-1')
      await expect(result).resolves.toEqual({ ok: false, text: MSG.sessionEnded })
    } finally { await tools.dispose() }
  })

  it.each([
    { reason: new ViewToolError('外部中止'), text: '外部中止' },
    { reason: new Error('外部錯誤'), text: MSG.internal('外部錯誤') },
    { reason: '非例外原因', text: MSG.sessionEnded },
  ])('保留中止原因：$text', async ({ reason, text }) => {
    const { tools, logError } = await setup()
    try {
      const outer = new AbortController()
      const result = tools.invoke('request_handoff', { reason: 'x' }, { callId: 'exec-1', signal: outer.signal })
      outer.abort(reason)
      await expect(result).resolves.toEqual({ ok: false, text })
      if (reason instanceof Error && !(reason instanceof ViewToolError)) {
        expect(logError).toHaveBeenCalledWith(reason)
      }
    } finally { await tools.dispose() }
  })
})
