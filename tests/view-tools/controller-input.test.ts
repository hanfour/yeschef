import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpError } from '../../src/main/cdp.js'
import { CDP_CALL_TIMEOUT_MS } from '../../src/main/view-tools/controller.js'
import { createCore } from '../../src/main/view-tools/controller-core.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { KEY_NAMES, KEY_TABLE, lookupKey } from '../../src/main/view-tools/keys.js'
import { invalidateRefs } from '../../src/main/view-tools/refs.js'
import { manualClock } from '../helpers/manual-clock.js'
import { createHarness, delay, refTable, sent, tick, type Harness } from './controller-harness.js'

vi.mock('../../src/main/view-tools/keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/view-tools/keys.js')>()
  return { ...actual, lookupKey: vi.fn(actual.lookupKey) }
})

const lookupKeyMock = lookupKey as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  lookupKeyMock.mockImplementation((name: string) => KEY_TABLE.get(name) ?? null)
})

/** 主 target 的按鈕：border 四點的中心是 (62, 54)，跟左上角 (12, 24) 不同。 */
const ROOT_BORDER = [12, 24, 112, 24, 112, 84, 12, 84]
/** OOPIF 內的按鈕：中心 (60, 50)。 */
const INNER_BORDER = [10, 20, 110, 20, 110, 80, 10, 80]
/** 外層 iframe 在主視窗裡的位置：左上角 (100, 200)。 */
const OUTER_CONTENT = [100, 200, 300, 200, 300, 400, 100, 400]
/** 內層 iframe 在外層 iframe 座標系裡的位置：左上角 (30, 40)。 */
const INNER_CONTENT = [30, 40, 230, 40, 230, 140, 30, 140]

function quietOk(h: Harness): void {
  h.advance(500)
}

describe('controller：view_click', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, role: 'button', name: '送出' }]]))
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => ({}))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: ROOT_BORDER } }))
    h.cdp.onSend('Input.dispatchMouseEvent', () => ({}))
  })

  it('ref 格式錯回 refFormat，不送任何 CDP 指令', async () => {
    await expect(h.controller.click('t1-e0', h.signal)).rejects.toThrow(MSG.refFormat)
    expect(sent(h.cdp, 'DOM.getBoxModel')).toHaveLength(0)
  })

  it('snapshot 已失效回 refStale，原因照 RefTable 的 invalidatedBy', async () => {
    h.watcher.setRefs(invalidateRefs(h.watcher.refs(), 'userInput'))
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.refStale(1, 'userInput'))
  })

  it('ref 編號不在表裡回 refMissing', async () => {
    await expect(h.controller.click('s1-e7', h.signal)).rejects.toThrow(MSG.refMissing(1, 's1-e7'))
  })

  it('getBoxModel 失敗回 refDetached', async () => {
    h.cdp.onSend('DOM.getBoxModel', () => {
      throw new CdpError('Could not find node', 'nodeNotFound')
    })
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.refDetached('s1-e0'))
  })

  it('border quad 為空時 fail closed，不點擊左上角', async () => {
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: [] } }))
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(
      MSG.internal('元素沒有可用的座標')
    )
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')).toHaveLength(0)
  })

  it('主 target 的節點點在 border 中心，mousePressed 與 mouseReleased 各一次', async () => {
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    const out = await promise

    const mouse = sent(h.cdp, 'Input.dispatchMouseEvent')
    expect(mouse).toHaveLength(2)
    expect(mouse[0]).toEqual({
      params: { type: 'mousePressed', x: 62, y: 54, button: 'left', clickCount: 1 },
      sessionId: undefined,
    })
    expect(mouse[1]?.params).toEqual({ type: 'mouseReleased', x: 62, y: 54, button: 'left', clickCount: 1 })
    expect(out).toEqual({ kind: 'text', text: MSG.clicked('button', '送出') })
  })

  it('scrollIntoViewIfNeeded 與 getBoxModel 送到節點所屬的 session', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 9, sessionId: 's-inner', role: 'link', name: '說明' }]]))
    h.cdp.setAttachedTargets([{ targetId: 'T-inner', type: 'iframe', url: 'https://in.test/', sessionId: 's-inner' }])
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')
    h.cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-page' }, { targetId: 'T-inner', parentId: 'T-page' }],
    }))
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 500 }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: OUTER_CONTENT } }))

    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise

    expect(sent(h.cdp, 'DOM.scrollIntoViewIfNeeded')[0]).toEqual({ params: { backendNodeId: 9 }, sessionId: 's-inner' })
    expect(sent(h.cdp, 'DOM.getBoxModel')[0]?.sessionId).toBe('s-inner')
  })

  it('兩層巢狀 OOPIF 的座標加上兩層 offset（裁決 9）', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, sessionId: 's-inner', role: 'button', name: '付款' }]]))
    h.cdp.setAttachedTargets([
      { targetId: 'T-outer', type: 'iframe', url: 'https://outer.test/', sessionId: 's-outer' },
      { targetId: 'T-inner', type: 'iframe', url: 'https://inner.test/', sessionId: 's-inner' },
    ])
    h.cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page' },
        { targetId: 'T-outer', parentId: 'T-page' },
        { targetId: 'T-inner', parentId: 'T-outer' },
      ],
    }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 501 }), 's-outer')
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: INNER_CONTENT } }), 's-outer')
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 500 }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: OUTER_CONTENT } }))

    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise

    // 中心 (60,50) + 內層 (30,40) + 外層 (100,200)
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')[0]?.params).toEqual({
      type: 'mousePressed',
      x: 190,
      y: 290,
      button: 'left',
      clickCount: 1,
    })
    expect(sent(h.cdp, 'DOM.getFrameOwner').map((c) => c.sessionId)).toEqual(['s-outer', undefined])
  })

  it('offset 算不出來時錯誤原樣傳出，不退回主視窗座標亂點（裁決 29）', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, sessionId: 's-inner', role: 'button', name: '付款' }]]))
    h.cdp.setAttachedTargets([
      { targetId: 'T-inner', type: 'iframe', url: 'https://inner.test/', sessionId: 's-inner' },
    ])
    // 這個 target 在 Target.getTargets 裡沒有 parentId：resolveFrameOffset 丟 frame-detached。
    h.cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-inner' }] }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')

    const error = await h.controller.click('s1-e0', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CdpError)
    expect((error as CdpError).code).toBe('frame-detached')
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')).toHaveLength(0)
  })

  it('點擊造成換頁時多一行 urlChanged', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.setUrl('https://example.test/next')
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    const out = await promise
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.clicked('button', '送出')}\n${MSG.urlChanged('https://example.test/next')}`,
    })
  })

  it('等不到靜默回 settleTimeout(5)', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.cdp.emit('Network.requestWillBeSent', { requestId: 'r1', type: 'XHR' })
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    h.advance(5_000)
    await expect(promise).rejects.toThrow(MSG.settleTimeout(5))
  })

  it('動作期間的 input-event 不算使用者插手（runAsAgent）', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.userInput('mouseDown')
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise
    expect(h.watcher.intervention().clicks).toBe(0)
  })

  it('右窗格已銷毀回 viewGone', async () => {
    h.wc.destroy()
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.viewGone)
  })

  it('CDP 指令逾時丟 code timeout 的 CdpError，不會永遠掛住（裁決 14）', async () => {
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => new Promise(() => {}))
    const settled = h.controller.click('s1-e0', h.signal).then(
      () => 'resolved' as const,
      (error: unknown) => error
    )
    await tick()
    h.advance(CDP_CALL_TIMEOUT_MS)
    const result = await Promise.race([settled, delay(50).then(() => 'hung' as const)])
    expect(result).toBeInstanceOf(CdpError)
    expect((result as CdpError).code).toBe('timeout')
  })

  it('CDP 指令自己失敗時原樣傳出，不當成逾時', async () => {
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => Promise.reject(new CdpError('boom', 'protocol')))
    const error = await h.controller.click('s1-e0', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CdpError)
    expect((error as CdpError).code).toBe('protocol')
  })
})

describe('controller：view_type', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.watcher.setRefs(refTable(2, [['s2-e1', { backendNodeId: 7, role: 'textbox', name: '電子郵件' }]]))
    h.cdp.onSend('DOM.focus', () => ({}))
    h.cdp.onSend('Input.dispatchKeyEvent', () => ({}))
    h.cdp.onSend('Input.insertText', () => ({}))
  })

  it('focus 送到節點所屬 session，insertText 送 root', async () => {
    h.watcher.setRefs(refTable(2, [['s2-e1', { backendNodeId: 7, sessionId: 's-x', role: 'textbox', name: '帳號' }]]))
    h.cdp.onSend('DOM.focus', () => ({}), 's-x')
    await h.controller.type('s2-e1', 'abc', false, false, h.signal)
    expect(sent(h.cdp, 'DOM.focus')[0]).toEqual({ params: { backendNodeId: 7 }, sessionId: 's-x' })
    expect(sent(h.cdp, 'Input.insertText')[0]).toEqual({ params: { text: 'abc' }, sessionId: undefined })
  })

  it('clear 用 commands: [selectAll] 全選後按 Backspace（裁決 12）', async () => {
    const out = await h.controller.type('s2-e1', 'hi', true, false, h.signal)
    const keys = sent(h.cdp, 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toEqual({
      type: 'keyDown',
      modifiers: 4,
      commands: ['selectAll'],
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    })
    expect(keys[1]).toEqual({ type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    expect(keys[2]).toEqual({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    expect(keys[3]).toEqual({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    expect(out).toEqual({ kind: 'text', text: MSG.typed(2, 'textbox', '電子郵件') })
  })

  it('clear 為 false 時先將游標移到內容結尾，再 insertText', async () => {
    await h.controller.type('s2-e1', 'hi', false, false, h.signal)
    const calls = (h.cdp.send as unknown as { mock: { calls: [string, unknown][] } }).mock.calls
    const moveToEndIndex = calls.findIndex(
      ([method, params]) =>
        method === 'Input.dispatchKeyEvent' &&
        (params as { commands?: string[] }).commands?.includes('moveToEndOfDocument')
    )
    const insertTextIndex = calls.findIndex(([method]) => method === 'Input.insertText')
    expect(moveToEndIndex).toBeGreaterThanOrEqual(0)
    expect(calls[moveToEndIndex]?.[1]).toEqual({
      type: 'keyDown',
      commands: ['moveToEndOfDocument'],
    })
    expect(insertTextIndex).toBeGreaterThan(moveToEndIndex)
  })

  it('clear 查不到 Backspace 時明確失敗，不回報已輸入', async () => {
    lookupKeyMock.mockImplementation((name: string) => (name === 'Backspace' ? null : KEY_TABLE.get(name) ?? null))
    await expect(h.controller.type('s2-e1', 'hi', true, false, h.signal)).rejects.toThrow(
      MSG.badKey('Backspace', KEY_NAMES)
    )
  })

  it('submit 送 Enter 並等靜默，換頁時加 urlChanged', async () => {
    h.cdp.onSend('Input.dispatchKeyEvent', () => {
      h.wc.setUrl('https://example.test/search?q=hi')
      return {}
    })
    const promise = h.controller.type('s2-e1', 'hi', false, true, h.signal)
    await tick()
    h.advance(500)
    const out = await promise
    const keys = sent(h.cdp, 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys).toEqual([
      { type: 'keyDown', commands: ['moveToEndOfDocument'] },
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    ])
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.typed(2, 'textbox', '電子郵件')}\n${MSG.urlChanged('https://example.test/search?q=hi')}`,
    })
  })

  it('submit 為 false 時不等靜默也不比對網址', async () => {
    h.cdp.onSend('Input.insertText', () => {
      h.wc.setUrl('https://example.test/other')
      return {}
    })
    const out = await h.controller.type('s2-e1', 'hi', false, false, h.signal)
    expect(out).toEqual({ kind: 'text', text: MSG.typed(2, 'textbox', '電子郵件') })
  })

  it('submit 查不到 Enter 時明確失敗', async () => {
    lookupKeyMock.mockImplementation((name: string) => (name === 'Enter' ? null : KEY_TABLE.get(name) ?? null))
    await expect(h.controller.type('s2-e1', 'hi', false, true, h.signal)).rejects.toThrow(
      MSG.badKey('Enter', KEY_NAMES)
    )
  })

  it('ref 過期時不 focus 也不輸入', async () => {
    await expect(h.controller.type('s9-e1', 'hi', false, false, h.signal)).rejects.toBeInstanceOf(ViewToolError)
    expect(sent(h.cdp, 'DOM.focus')).toHaveLength(0)
  })
})

describe('controller：view_press', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.cdp.onSend('Input.dispatchKeyEvent', () => ({}))
  })

  it('不支援的按鍵回 badKey 並列出全部鍵名', async () => {
    await expect(h.controller.press('F13', h.signal)).rejects.toThrow(MSG.badKey('F13', KEY_NAMES))
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')).toHaveLength(0)
  })

  it('大小寫敏感：enter 不是 Enter', async () => {
    await expect(h.controller.press('enter', h.signal)).rejects.toThrow(MSG.badKey('enter', KEY_NAMES))
  })

  it('signal 進門時已中止，回 sessionEnded 且不送 CDP', async () => {
    h.aborter.abort()
    await expect(h.controller.press('Tab', h.signal)).rejects.toThrow(MSG.sessionEnded)
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')).toHaveLength(0)
  })

  it('有 text 的鍵用 keyDown 並帶 text', async () => {
    const promise = h.controller.press('Space', h.signal)
    await tick()
    h.advance(500)
    const out = await promise
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')[0]?.params).toEqual({
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
      text: ' ',
    })
    expect(out).toEqual({ kind: 'text', text: MSG.pressed('Space') })
  })

  it('沒有 text 的鍵用 rawKeyDown 且不帶 text', async () => {
    const promise = h.controller.press('Tab', h.signal)
    await tick()
    h.advance(500)
    await promise
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')[0]?.params).toEqual({
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    })
  })

  it('等待靜默期間 signal 中止回 sessionEnded', async () => {
    const promise = h.controller.press('Tab', h.signal)
    await tick()
    h.aborter.abort()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })
})

describe('controller：CDP 逾時熔斷', () => {
  it('第一次逾時後同一次工具呼叫的第二次 call 立即失敗', async () => {
    const h = await createHarness()
    const clockKit = manualClock(1_000)
    h.cdp.onSend('Runtime.evaluate', () => new Promise<never>(() => {}))
    const core = createCore({
      cdp: h.cdp,
      webContents: h.wc,
      watcher: h.watcher,
      settle: h.settle,
      handoff: h.handoff,
      clock: clockKit.clock,
      projectDir: () => '/tmp/yeschef-proj',
      logError: h.logError,
      credentials: async () => undefined,
    })

    core.guard(h.signal)
    const first = core.call('Runtime.evaluate')
    clockKit.advance(CDP_CALL_TIMEOUT_MS)
    const firstError = (await first.catch((error: unknown) => error)) as CdpError
    expect(firstError).toBeInstanceOf(CdpError)
    expect(MSG.cdpFailed(firstError.code, firstError.message)).toBe(
      'CDP 指令失敗（timeout）：Runtime.evaluate 逾時（10000 毫秒）'
    )

    h.cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }))
    const second = core.call('Page.getLayoutMetrics')
    await expect(second).rejects.toBeInstanceOf(CdpError)
    expect(sent(h.cdp, 'Page.getLayoutMetrics')).toHaveLength(0)
    expect(clockKit.now()).toBe(1_000 + CDP_CALL_TIMEOUT_MS)
  })

  it('熔斷的第二次失敗仍是 timeout，訊息指出略過原因', async () => {
    const h = await createHarness()
    const clockKit = manualClock(1_000)
    h.cdp.onSend('Runtime.evaluate', () => new Promise<never>(() => {}))
    const core = createCore({
      cdp: h.cdp,
      webContents: h.wc,
      watcher: h.watcher,
      settle: h.settle,
      handoff: h.handoff,
      clock: clockKit.clock,
      projectDir: () => '/tmp/yeschef-proj',
      logError: h.logError,
      credentials: async () => undefined,
    })

    core.guard(h.signal)
    const first = core.call('Runtime.evaluate')
    clockKit.advance(CDP_CALL_TIMEOUT_MS)
    await expect(first).rejects.toMatchObject({ code: 'timeout' })
    const error = await core.call('Runtime.evaluate').catch((value: unknown) => value)
    expect(error).toBeInstanceOf(CdpError)
    expect((error as CdpError).code).toBe('timeout')
    expect((error as CdpError).message).toContain('前一次逾時')
  })

  it('下一次工具呼叫先跑 guard 後恢復送出指令', async () => {
    const h = await createHarness()
    const clockKit = manualClock(1_000)
    h.cdp.onSend('Runtime.evaluate', () => new Promise<never>(() => {}))
    const core = createCore({
      cdp: h.cdp,
      webContents: h.wc,
      watcher: h.watcher,
      settle: h.settle,
      handoff: h.handoff,
      clock: clockKit.clock,
      projectDir: () => '/tmp/yeschef-proj',
      logError: h.logError,
      credentials: async () => undefined,
    })

    core.guard(h.signal)
    const first = core.call('Runtime.evaluate')
    clockKit.advance(CDP_CALL_TIMEOUT_MS)
    await expect(first).rejects.toMatchObject({ code: 'timeout' })

    core.guard(h.signal)
    h.cdp.onSend('Page.getLayoutMetrics', () => ({ ok: true }))
    await expect(core.call('Page.getLayoutMetrics')).resolves.toEqual({ ok: true })
    expect(sent(h.cdp, 'Page.getLayoutMetrics')).toHaveLength(1)
  })
})
