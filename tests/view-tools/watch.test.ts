import { describe, expect, it, vi } from 'vitest'
import { createFakeCdp as createRawFakeCdp } from '../helpers/fake-cdp.js'
import { EMPTY_REFS } from '../../src/main/view-tools/refs.js'
import { createWatcher, summarizeIntervention } from '../../src/main/view-tools/watch.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

function createFakeCdp() {
  const cdp = createRawFakeCdp()
  for (const method of ['DOM.enable', 'Network.enable', 'Accessibility.enable']) {
    cdp.onSend(method, () => undefined)
  }
  return cdp
}

type InputListener = (event: unknown, input: { readonly type: string }) => void

type OnOffMock = ReturnType<typeof vi.fn<(event: 'input-event', listener: InputListener) => unknown>>

function createFakeWebContents(initialUrl: string): {
  readonly on: OnOffMock
  readonly off: OnOffMock
  getURL(): string
  setUrl(url: string): void
} {
  let url = initialUrl
  return {
    on: vi.fn(),
    off: vi.fn(),
    getURL: () => url,
    setUrl: (u: string) => {
      url = u
    },
  }
}

function inputListenerOf(wc: { readonly on: OnOffMock }): InputListener {
  const call = wc.on.mock.calls.find((c) => c[0] === 'input-event')
  if (!call) throw new Error('input-event 未註冊')
  return call[1]
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

const entry: RefEntry = { backendNodeId: 101, role: 'button', name: '送出' }

describe('createWatcher：裁決 5 的域啟用', () => {
  it('正常建立 watcher 時 enable 成功、不記錄錯誤，且傳入空 params 與正確 sessionId', async () => {
    const cdp = createFakeCdp()
    cdp.setAttachedTargets([
      { targetId: 't1', type: 'iframe', url: 'https://oopif.example/', sessionId: 's1' },
    ])
    const wc = createFakeWebContents('https://a.example/')
    const logError = vi.fn()

    await createWatcher({ cdp, webContents: wc, logError })

    expect(logError).not.toHaveBeenCalled()
    expect(cdp.send).toHaveBeenNthCalledWith(1, 'DOM.enable', {}, undefined)
    expect(cdp.send).toHaveBeenNthCalledWith(2, 'Network.enable', {}, undefined)
    expect(cdp.send).toHaveBeenNthCalledWith(3, 'Accessibility.enable', {}, undefined)
    expect(cdp.send).toHaveBeenNthCalledWith(4, 'DOM.enable', {}, 's1')
    expect(cdp.send).toHaveBeenNthCalledWith(5, 'Network.enable', {}, 's1')
    expect(cdp.send).toHaveBeenNthCalledWith(6, 'Accessibility.enable', {}, 's1')
  })

  it('建立時對 root 與既有 iframe target 各送 DOM／Network／Accessibility 三個 enable，非 iframe target 不送', async () => {
    const cdp = createFakeCdp()
    cdp.setAttachedTargets([
      { targetId: 't1', type: 'iframe', url: 'https://oopif.example/', sessionId: 's1' },
      { targetId: 't2', type: 'page', url: 'about:blank', sessionId: 's2' },
    ])
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })

    const calls = cdp.send.mock.calls
    const rootMethods = calls.filter((c) => c[2] === undefined).map((c) => c[0])
    const s1Methods = calls.filter((c) => c[2] === 's1').map((c) => c[0])
    const s2Methods = calls.filter((c) => c[2] === 's2')

    expect(rootMethods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(s1Methods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(s2Methods).toEqual([])
  })

  it('之後收到 Target.attachedToTarget（iframe）時對新 sessionId 再送三個 enable', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    cdp.send.mockClear()

    cdp.emit('Target.attachedToTarget', {
      sessionId: 's9',
      targetInfo: { targetId: 't9', type: 'iframe', url: 'https://new.example/' },
    })
    await flush()

    const s9Methods = cdp.send.mock.calls.filter((c) => c[2] === 's9').map((c) => c[0])
    expect(s9Methods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
  })

  it('Target.attachedToTarget 但 type 不是 iframe 時不送 enable', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    cdp.send.mockClear()

    cdp.emit('Target.attachedToTarget', {
      sessionId: 's9',
      targetInfo: { targetId: 't9', type: 'page', url: 'https://new.example/' },
    })
    await flush()

    expect(cdp.send.mock.calls.filter((c) => c[2] === 's9')).toEqual([])
  })

  it('Target.attachedToTarget 缺少 targetInfo 時不拋出例外', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    cdp.send.mockClear()

    expect(() => cdp.emit('Target.attachedToTarget', { sessionId: 's9' })).not.toThrow()
    await flush()

    expect(cdp.send).not.toHaveBeenCalled()
  })

  it('enable 失敗記 logError 不丟出，且不中斷其餘 enable', async () => {
    const cdp = createFakeCdp()
    cdp.send.mockImplementation(async (method: unknown) => {
      if (method === 'Network.enable') throw new Error('nope')
      return undefined
    })
    const wc = createFakeWebContents('https://a.example/')
    const logError = vi.fn()

    await expect(createWatcher({ cdp, webContents: wc, logError })).resolves.toBeDefined()

    const rootMethods = cdp.send.mock.calls.filter((c) => c[2] === undefined).map((c) => c[0])
    expect(rootMethods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })
})

describe('refs 失效', () => {
  it('DOM.documentUpdated（任一 session）使 refs 失效，原因 documentUpdated', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 3, entries: new Map([['s3-e0', entry]]) })

    cdp.emit('DOM.documentUpdated', {}, 's7')

    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')
    expect(watcher.refs().entries.size).toBe(0)
    expect(watcher.refs().snapshotId).toBe(3)
  })

  it('主 frame（root session、frame.parentId 不存在）的 Page.frameNavigated 使 refs 失效並計入 navigations', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })

    expect(watcher.refs().invalidatedBy).toBe('navigated')
    expect(watcher.intervention().navigations).toBe(1)
  })

  it('子 frame（frame.parentId 有值）的 frameNavigated 不算導航、不使 refs 失效（突變候選）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: 'root-frame-id' } })

    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('OOPIF 自身 session（sessionId 非 undefined、無 parentId）的 frameNavigated 不算主 frame（見回報契約疑慮）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } }, 's1')

    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('第一個失效原因保留，之後不同來源的失效不覆蓋（突變候選）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    cdp.emit('DOM.documentUpdated', {})
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')

    inputListenerOf(wc)(undefined, { type: 'mouseDown' })
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')
  })
})

describe('使用者輸入（input-event）', () => {
  it('mouseDown 計 clicks 並使 refs 失效（userInput）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    inputListenerOf(wc)(undefined, { type: 'mouseDown' })

    expect(watcher.intervention().clicks).toBe(1)
    expect(watcher.refs().invalidatedBy).toBe('userInput')
  })

  it('keyDown 計 keys 並使 refs 失效（userInput）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    inputListenerOf(wc)(undefined, { type: 'keyDown' })

    expect(watcher.intervention().keys).toBe(1)
    expect(watcher.refs().invalidatedBy).toBe('userInput')
  })

  it('其他 type（mouseUp／mouseMove／keyUp／char／mouseWheel）不計、不使 refs 失效', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })
    const listener = inputListenerOf(wc)

    for (const type of ['mouseUp', 'mouseMove', 'keyUp', 'char', 'mouseWheel']) {
      listener(undefined, { type })
    }

    expect(watcher.intervention()).toEqual({ clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://a.example/' })
    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
  })
})

describe('runAsAgent', () => {
  it('會把內層函式的回傳值原樣傳出', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })

    await expect(watcher.runAsAgent(async () => 42)).resolves.toBe(42)
  })

  it('期間的 frameNavigated 仍使 refs 失效，但不計入 navigations（突變候選：期間導航被算成使用者導覽）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 4, entries: new Map([['s4-e0', entry]]) })

    await watcher.runAsAgent(async () => {
      cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })
      return null
    })

    expect(watcher.refs().invalidatedBy).toBe('navigated')
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('期間的 input-event 不計、不使 refs 失效（agent 自己的 CDP 操作觸發的合成輸入）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 4, entries: new Map([['s4-e0', entry]]) })
    const listener = inputListenerOf(wc)

    await watcher.runAsAgent(async () => {
      listener(undefined, { type: 'mouseDown' })
      return null
    })

    expect(watcher.intervention().clicks).toBe(0)
    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
  })

  it('可重入：巢狀呼叫時內層結束不會提前恢復使用者插手偵測（用計數器而非布林）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    await watcher.runAsAgent(async () => {
      await watcher.runAsAgent(async () => {
        listener(undefined, { type: 'mouseDown' })
        return null
      })
      // 內層已經 return，但外層仍在進行中：這裡仍不該被計入
      listener(undefined, { type: 'mouseDown' })
      return null
    })
    expect(watcher.intervention().clicks).toBe(0)

    listener(undefined, { type: 'mouseDown' })
    expect(watcher.intervention().clicks).toBe(1)
  })

  it('fn 丟例外時仍會還原旗標（try/finally），例外原樣往外丟', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    await expect(
      watcher.runAsAgent(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    listener(undefined, { type: 'mouseDown' })
    expect(watcher.intervention().clicks).toBe(1)
  })
})

describe('intervention／takeIntervention', () => {
  it('intervention() 不歸零', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    inputListenerOf(wc)(undefined, { type: 'mouseDown' })

    watcher.intervention()

    expect(watcher.intervention().clicks).toBe(1)
  })

  it('takeIntervention() 回傳目前 log 並歸零，fromUrl 設為目前網址（突變候選：沒歸零）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)
    listener(undefined, { type: 'mouseDown' })
    listener(undefined, { type: 'keyDown' })
    wc.setUrl('https://b.example/')

    const first = watcher.takeIntervention()
    expect(first).toEqual({ clicks: 1, keys: 1, navigations: 0, fromUrl: 'https://a.example/' })

    const second = watcher.takeIntervention()
    expect(second).toEqual({ clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://b.example/' })
  })
})

describe('setRefs／refs', () => {
  it('初始為 EMPTY_REFS；setRefs 直接替換整份表', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })

    expect(watcher.refs()).toBe(EMPTY_REFS)

    const table: RefTable = { snapshotId: 9, entries: new Map([['s9-e0', entry]]) }
    watcher.setRefs(table)
    expect(watcher.refs()).toBe(table)
  })
})

describe('dispose', () => {
  it('解除 cdp.onEvent 訂閱與 webContents 的 input-event 監聽', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    watcher.dispose()

    expect(wc.off).toHaveBeenCalledWith('input-event', listener)

    watcher.setRefs({ snapshotId: 1, entries: new Map([['s1-e0', entry]]) })
    cdp.emit('DOM.documentUpdated', {})
    expect(watcher.refs().invalidatedBy).toBeUndefined()
  })
})

describe('summarizeIntervention', () => {
  it('三個計數都是 0 時回 null', () => {
    const log = { clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBeNull()
  })

  it('網址改變時用「網址從 A 變成 B」', () => {
    const log = { clicks: 3, keys: 12, navigations: 1, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://b.example/')).toBe(
      '使用者在你上次操作後點了 3 次、按了 12 個鍵，網址從 https://a.example/ 變成 https://b.example/'
    )
  })

  it('網址相同但 navigations > 0 時用「網址仍是」', () => {
    const log = { clicks: 1, keys: 0, navigations: 2, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBe(
      '使用者在你上次操作後點了 1 次、按了 0 個鍵，網址仍是 https://a.example/'
    )
  })

  it('navigations 為 0 且網址相同時省略網址段', () => {
    const log = { clicks: 2, keys: 5, navigations: 0, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBe('使用者在你上次操作後點了 2 次、按了 5 個鍵')
  })
})
