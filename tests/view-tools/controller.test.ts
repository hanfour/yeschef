import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EVAL_MAX_CHARS, SCREENSHOT_MAX_WIDTH } from '../../src/main/view-tools/controller.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { HANDOFF_TIMEOUT_MS } from '../../src/main/view-tools/handoff.js'
import { collectSnapshotInput } from '../../src/main/view-tools/snapshot-collect.js'
import type { SnapshotInput } from '../../src/main/view-tools/snapshot.js'
import { createHarness, sent, tick, type Harness } from './controller-harness.js'

// Task 5 的蒐集流程有自己的 task 與測試；這裡只驗 controller 的職責：流水號、
// setRefs、插手摘要與文字組裝。同一個模組的 resolveFrameOffset（裁決 9）保留真實作。
vi.mock('../../src/main/view-tools/snapshot-collect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/view-tools/snapshot-collect.js')>()
  return { ...actual, collectSnapshotInput: vi.fn() }
})

const collectMock = collectSnapshotInput as unknown as Mock

function inputFor(id: number, scope: 'viewport' | 'full' = 'viewport'): SnapshotInput {
  return {
    id,
    takenAt: 1_000,
    url: 'https://example.test/',
    title: '起始頁',
    scope,
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    frames: [
      {
        frameId: 'F1',
        url: 'https://example.test/',
        offset: { x: 0, y: 0 },
        nodes: [
          {
            nodeId: '1',
            ignored: false,
            role: { value: 'button' },
            name: { value: '送出' },
            backendDOMNodeId: 42,
            childIds: [],
          },
        ],
        boxes: new Map([[42, { x: 1, y: 2, width: 30, height: 10 }]]),
      },
    ],
    unattachedFrames: 0,
  }
}

describe('controller：view_navigate', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness('/tmp/yeschef-proj')
    h.cdp.onSend('Page.navigate', () => ({ frameId: 'F1' }))
  })

  const loadThenQuiet = (): void => {
    h.cdp.emit('Page.loadEventFired', { timestamp: 1 })
  }

  it('協定不在白名單回 badScheme，不送 Page.navigate', async () => {
    await expect(h.controller.navigate('ftp://example.test/x', h.signal)).rejects.toThrow(MSG.badScheme)
    expect(sent(h.cdp, 'Page.navigate')).toHaveLength(0)
  })

  it('無法解析的網址回 invalidUrl，訊息帶原字串', async () => {
    await expect(h.controller.navigate('example.test', h.signal)).rejects.toThrow(MSG.invalidUrl('example.test'))
  })

  it('專案目錄外的 file:// 回 outsideProject', async () => {
    await expect(h.controller.navigate('file:///etc/hosts', h.signal)).rejects.toThrow(
      MSG.outsideProject('/tmp/yeschef-proj')
    )
  })

  it('成功時送出正規化後的網址並回報網址與標題', async () => {
    h.wc.setUrl('https://example.test/a/b')
    h.wc.setTitle('目的地')
    const promise = h.controller.navigate('https://example.test/a/../a/b', h.signal)
    await tick()
    loadThenQuiet()
    await tick()
    h.advance(500)
    const out = await promise
    expect(sent(h.cdp, 'Page.navigate')[0]).toEqual({
      params: { url: 'https://example.test/a/b' },
      sessionId: undefined,
    })
    expect(out).toEqual({ kind: 'text', text: MSG.navigated('https://example.test/a/b', '目的地') })
  })

  it('Page.navigate 回 errorText 時丟 navigateFailed', async () => {
    h.cdp.onSend('Page.navigate', () => ({ frameId: 'F1', errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
    await expect(h.controller.navigate('https://nope.test/', h.signal)).rejects.toThrow(
      MSG.navigateFailed('https://nope.test/', 'net::ERR_NAME_NOT_RESOLVED')
    )
  })

  it('8 秒內沒 load 完丟 navigateTimeout，帶當下網址', async () => {
    h.wc.setUrl('https://example.test/stuck')
    const promise = h.controller.navigate('https://example.test/stuck', h.signal)
    await tick()
    h.advance(8_000)
    await expect(promise).rejects.toThrow(MSG.navigateTimeout('https://example.test/stuck'))
  })

  it('等待中被中止丟 sessionEnded', async () => {
    const promise = h.controller.navigate('https://example.test/x', h.signal)
    await tick()
    h.aborter.abort()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })

  it('右窗格已銷毀時連網址檢查都不做', async () => {
    h.wc.destroy()
    await expect(h.controller.navigate('https://example.test/', h.signal)).rejects.toThrow(MSG.viewGone)
    expect(sent(h.cdp, 'Page.navigate')).toHaveLength(0)
  })
})

describe('controller：view_snapshot', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    collectMock.mockReset()
    collectMock.mockImplementation((_deps: unknown, id: number, scope: 'viewport' | 'full') =>
      Promise.resolve(inputFor(id, scope))
    )
  })

  it('流水號從 1 起遞增，scope 原樣傳給蒐集函式', async () => {
    await h.controller.snapshot('viewport', h.signal)
    await h.controller.snapshot('full', h.signal)
    expect(collectMock.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, 'viewport'],
      [2, 'full'],
    ])
  })

  it('把新的 RefTable 交給 watcher，ref 編號帶這次的流水號', async () => {
    await h.controller.snapshot('viewport', h.signal)
    const table = h.watcher.refs()
    expect(table.snapshotId).toBe(1)
    expect(table.entries.get('s1-e0')).toEqual({ backendNodeId: 42, role: 'button', name: '送出' })
  })

  it('沒有插手時文字不含摘要行', async () => {
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out).toEqual({
      kind: 'text',
      text: '[page] 起始頁 https://example.test/\ns1-e0 button "送出"',
    })
  })

  it('有插手時第一行是摘要，且摘要取完就歸零', async () => {
    h.wc.userInput('mouseDown')
    h.wc.userInput('keyDown')
    h.wc.setUrl('https://example.test/moved')
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out.text.split('\n')[0]).toBe(
      '使用者在你上次操作後點了 1 次、按了 1 個鍵，網址從 https://example.test/ 變成 https://example.test/moved'
    )
    expect(h.watcher.intervention()).toEqual({
      clicks: 0,
      keys: 0,
      navigations: 0,
      fromUrl: 'https://example.test/moved',
    })
  })

  it('蒐集期間的 input-event 不算插手（runAsAgent）', async () => {
    collectMock.mockImplementation((_deps: unknown, id: number) => {
      h.wc.userInput('mouseDown')
      return Promise.resolve(inputFor(id))
    })
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out.text.startsWith('[page]')).toBe(true)
    expect(h.watcher.intervention().clicks).toBe(0)
  })
})

describe('controller：view_screenshot', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.cdp.onSend('Page.captureScreenshot', () => ({ data: 'UE5H' }))
  })

  const metrics = (clientWidth: number, clientHeight: number): void => {
    h.cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth, clientHeight } }))
  }

  it('寬度超過上限時等比縮小，clip 與文字用同一個 scale', async () => {
    metrics(1_600, 900)
    const out = await h.controller.screenshot(h.signal)
    expect(sent(h.cdp, 'Page.captureScreenshot')[0]?.params).toEqual({
      format: 'png',
      clip: { x: 0, y: 0, width: 1_600, height: 900, scale: 0.8 },
    })
    expect(out).toEqual({
      kind: 'image',
      text: MSG.screenshot(SCREENSHOT_MAX_WIDTH, 720, 'https://example.test/'),
      dataBase64: 'UE5H',
      mimeType: 'image/png',
    })
  })

  it('寬度小於上限時不放大', async () => {
    metrics(800, 601)
    const out = await h.controller.screenshot(h.signal)
    expect(sent(h.cdp, 'Page.captureScreenshot')[0]?.params).toMatchObject({
      clip: { width: 800, height: 601, scale: 1 },
    })
    expect(out.text).toBe(MSG.screenshot(800, 601, 'https://example.test/'))
  })
})

describe('controller：view_eval', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
  })

  const evaluates = (result: unknown): void => {
    h.cdp.onSend('Runtime.evaluate', () => result)
  }

  it('回傳值以 JSON 呈現，參數含 returnByValue 與 awaitPromise', async () => {
    evaluates({ result: { value: { a: 1 } } })
    const out = await h.controller.evaluate('({a:1})', h.signal)
    expect(sent(h.cdp, 'Runtime.evaluate')[0]).toEqual({
      params: { expression: '({a:1})', returnByValue: true, awaitPromise: true },
      sessionId: undefined,
    })
    expect(out).toEqual({ kind: 'text', text: '{"a":1}' })
  })

  it('值是 undefined 時回字串 undefined', async () => {
    evaluates({ result: {} })
    expect(await h.controller.evaluate('void 0', h.signal)).toEqual({ kind: 'text', text: 'undefined' })
  })

  it('NaN 這類值只有 unserializableValue 時用它（裁決 28）', async () => {
    evaluates({ result: { type: 'number', unserializableValue: 'NaN' } })
    expect(await h.controller.evaluate('0/0', h.signal)).toEqual({ kind: 'text', text: 'NaN' })
  })

  it('BigInt 的 unserializableValue 優先於 JSON.stringify', async () => {
    evaluates({ result: { type: 'bigint', unserializableValue: '1n' } })
    expect(await h.controller.evaluate('1n', h.signal)).toEqual({ kind: 'text', text: '1n' })
  })

  it('exceptionDetails 存在時丟出 description', async () => {
    evaluates({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } })
    await expect(h.controller.evaluate('x()', h.signal)).rejects.toThrow('TypeError: x is not a function')
  })

  it('沒有 description 時退回 exceptionDetails.text', async () => {
    evaluates({ exceptionDetails: { text: 'Uncaught SyntaxError' } })
    const error = await h.controller.evaluate('=', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ViewToolError)
    expect((error as Error).message).toBe('Uncaught SyntaxError')
  })

  it('例外沒有任何訊息時回固定說明，不丟空字串', async () => {
    evaluates({ exceptionDetails: {} })
    const error = await h.controller.evaluate('=', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ViewToolError)
    expect((error as Error).message).toBe(MSG.evalException)
  })

  it('超長結果截到 8192 字元並附原長', async () => {
    const value = 'x'.repeat(9_000)
    evaluates({ result: { value } })
    const json = JSON.stringify(value)
    const out = await h.controller.evaluate('long', h.signal)
    expect(out.text).toBe(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(json.length))
    expect(out.text.startsWith(`"${'x'.repeat(EVAL_MAX_CHARS - 1)}`)).toBe(true)
  })

  it('剛好 8192 字元不截斷', async () => {
    const value = 'y'.repeat(EVAL_MAX_CHARS - 2)
    evaluates({ result: { value } })
    const out = await h.controller.evaluate('exact', h.signal)
    expect(out.text).toHaveLength(EVAL_MAX_CHARS)
    expect(out.text.includes('已截斷')).toBe(false)
  })
})

describe('controller：request_handoff', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
  })

  it('使用者按下後回 handoffDone，帶當下網址', async () => {
    const promise = h.controller.requestHandoff('tu-1', '請完成登入', h.signal)
    await tick()
    h.wc.setUrl('https://example.test/logged-in')
    h.handoff.done('tu-1')
    expect(await promise).toEqual({ kind: 'text', text: MSG.handoffDone('https://example.test/logged-in') })
  })

  it('逾時是狀態不是錯誤，回 handoffTimeout', async () => {
    const promise = h.controller.requestHandoff('tu-2', '請完成登入', h.signal)
    await tick()
    h.advance(HANDOFF_TIMEOUT_MS)
    expect(await promise).toEqual({ kind: 'text', text: MSG.handoffTimeout('https://example.test/') })
  })

  it('對話結束時丟 sessionEnded', async () => {
    const promise = h.controller.requestHandoff('tu-3', '請完成登入', h.signal)
    await tick()
    h.handoff.abortAll()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })

  it('已有一筆等待中時第二筆丟 handoffBusy', async () => {
    const first = h.controller.requestHandoff('tu-4', '請完成登入', h.signal)
    await tick()
    await expect(h.controller.requestHandoff('tu-5', '再一次', h.signal)).rejects.toThrow(MSG.handoffBusy('請完成登入'))
    h.handoff.done('tu-4')
    await first
  })

  it('等待期間的 input-event 要算使用者插手（不包在 runAsAgent 內）', async () => {
    const promise = h.controller.requestHandoff('tu-6', '請完成登入', h.signal)
    await tick()
    h.wc.userInput('mouseDown')
    h.wc.userInput('keyDown')
    h.wc.userInput('keyDown')
    h.handoff.done('tu-6')
    await promise
    expect(h.watcher.intervention()).toMatchObject({ clicks: 1, keys: 2 })
  })

  it('右窗格已銷毀時不建立 pending', async () => {
    h.wc.destroy()
    await expect(h.controller.requestHandoff('tu-7', '請完成登入', h.signal)).rejects.toThrow(MSG.viewGone)
    expect(h.handoff.pending()).toBeNull()
  })
})
