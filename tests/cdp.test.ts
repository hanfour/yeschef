import { describe, it, expect, vi } from 'vitest'
import { toCdpError, CdpError, attachCdp } from '../src/main/cdp.js'
import type { WebContents } from 'electron'

describe('toCdpError', () => {
  it('把 CDP 的錯誤物件轉成帶 code 的 CdpError', () => {
    const err = toCdpError({ code: -32000, message: 'Cannot find context with specified id' })
    expect(err).toBeInstanceOf(CdpError)
    expect(err.code).toBe('-32000')
    expect(err.message).toContain('Cannot find context')
  })

  it('字串錯誤也能轉，code 標成 unknown', () => {
    const err = toCdpError('debugger detached')
    expect(err.code).toBe('unknown')
    expect(err.message).toBe('debugger detached')
  })

  it('null 或 undefined 不會讓轉換本身爆掉', () => {
    expect(toCdpError(undefined).code).toBe('unknown')
    expect(toCdpError(null).message).toBe('未知的 CDP 錯誤')
  })

  it('CdpError 的 cause 保留原始值', () => {
    const raw = { code: -32000, message: 'Something went wrong' }
    const err = toCdpError(raw)
    expect(err.cause).toBe(raw)
  })
})

/**
 * cdp.ts 只用 `import type` 引入 electron 的型別，執行期完全不依賴真的
 * Electron，所以這裡可以直接造一個假的 wc.debugger 測 attachCdp() 的遞迴
 * re-arm 行為，不需要跑在 Electron 裡、也不需要 mock 'electron' 模組。
 *
 * 只測 attachCdp() 這個公開介面，不碰 cdp.ts 內部——這一輪的指示是不准動
 * cdp.ts，透過公開介面加測試不違反這個邊界。
 */
function createFakeDebugger() {
  let attached = false
  const rearmShouldFail = new Set<string | undefined>()
  const sendCommand = vi.fn(async (method: string, _params?: object, sessionId?: string) => {
    if (method === 'Target.setAutoAttach' && rearmShouldFail.has(sessionId)) {
      throw { code: -32000, message: `setAutoAttach 失敗：sessionId=${sessionId}` }
    }
    return {}
  })

  // registeredListener 模擬 debugger.on('message', ...) 目前真的掛著的監聽器，
  // removeListener 會清掉它；capturedListener 永遠保留最後一次註冊的監聽器，
  // 用來測「即使監聽器理論上已經移除，detached 旗標本身還是會擋下 re-arm」
  // 這個防禦性分支，不只是測「監聽器有沒有被移除」這件事本身。
  type Listener = (event: unknown, method: string, params: unknown, sessionId: string) => void
  let registeredListener: Listener | undefined
  let capturedListener: Listener | undefined

  const fakeDebugger = {
    isAttached: () => attached,
    attach: () => {
      attached = true
    },
    detach: () => {
      attached = false
    },
    sendCommand,
    on: (event: string, listener: Listener) => {
      if (event === 'message') {
        registeredListener = listener
        capturedListener = listener
      }
    },
    removeListener: (event: string) => {
      if (event === 'message') registeredListener = undefined
    },
  }

  return {
    wc: { debugger: fakeDebugger } as unknown as WebContents,
    sendCommand,
    rearmShouldFail,
    /**
     * 模擬正常送達的 CDP 訊息，尊重 removeListener（監聽器移除後這裡就是 no-op）。
     * sessionId 預設空字串，對應 Electron 的主 target 事件。
     */
    emitMessage: (method: string, params: unknown, sessionId = '') =>
      registeredListener?.({}, method, params, sessionId),
    /** 繞過 removeListener，直接呼叫最後一次註冊的監聽器，用來測 cdp.ts 內部的 detached 旗標本身。 */
    emitMessageBypassingRemoval: (method: string, params: unknown, sessionId = '') =>
      capturedListener?.({}, method, params, sessionId),
    hasRegisteredListener: () => registeredListener !== undefined,
  }
}

/** 讓 armAutoAttach(sessionId).catch(...) 這條 fire-and-forget 的 promise 鏈有機會跑完。 */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('attachCdp 遞迴 re-arm', () => {
  it('附著時對根 session 發一次 Target.setAutoAttach（沒有 sessionId）', async () => {
    const { wc, sendCommand } = createFakeDebugger()
    const cdp = await attachCdp(wc)

    expect(sendCommand).toHaveBeenCalledWith(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      undefined
    )
    cdp.detach()
  })

  it('收到 Target.attachedToTarget 後，對那個新子 session 再發一次 Target.setAutoAttach，且該 target 進入 getAttachedTargets()', async () => {
    const { wc, sendCommand, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc)
    sendCommand.mockClear()

    emitMessage('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { targetId: 't1', type: 'iframe', url: 'https://child.example/' },
    })
    await flushAsync()

    expect(sendCommand).toHaveBeenCalledWith(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      'child-1'
    )
    expect(cdp.getAttachedTargets()).toEqual([
      { targetId: 't1', type: 'iframe', url: 'https://child.example/', sessionId: 'child-1' },
    ])
    cdp.detach()
  })

  it('巢狀到孫代：對子代 re-arm 之後，收到孫代的附著事件一樣會再 re-arm一次', async () => {
    const { wc, sendCommand, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc)

    emitMessage('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { targetId: 't1', type: 'iframe', url: 'https://child.example/' },
    })
    await flushAsync()
    sendCommand.mockClear()

    // 孫代：巢狀在子代 session 底下附著的另一個 target。
    emitMessage('Target.attachedToTarget', {
      sessionId: 'grandchild-1',
      targetInfo: { targetId: 't2', type: 'iframe', url: 'https://grandchild.example/' },
    })
    await flushAsync()

    expect(sendCommand).toHaveBeenCalledWith(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      'grandchild-1'
    )
    const targets = cdp.getAttachedTargets()
    expect(targets).toContainEqual({ targetId: 't1', type: 'iframe', url: 'https://child.example/', sessionId: 'child-1' })
    expect(targets).toContainEqual({ targetId: 't2', type: 'iframe', url: 'https://grandchild.example/', sessionId: 'grandchild-1' })
    cdp.detach()
  })

  it('收到 Target.detachedFromTarget 後，那個 session 從 getAttachedTargets() 移除', async () => {
    const { wc, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc)

    emitMessage('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { targetId: 't1', type: 'iframe', url: 'https://child.example/' },
    })
    await flushAsync()
    expect(cdp.getAttachedTargets()).toHaveLength(1)

    emitMessage('Target.detachedFromTarget', { sessionId: 'child-1' })
    expect(cdp.getAttachedTargets()).toHaveLength(0)
    cdp.detach()
  })

  it('re-arm 失敗記錄進 getRearmErrors()，不拋出，也不擋下其他子代的附著', async () => {
    const { wc, emitMessage, rearmShouldFail } = createFakeDebugger()
    const cdp = await attachCdp(wc)
    rearmShouldFail.add('bad-child')

    emitMessage('Target.attachedToTarget', {
      sessionId: 'bad-child',
      targetInfo: { targetId: 'tb', type: 'iframe', url: 'https://bad.example/' },
    })
    emitMessage('Target.attachedToTarget', {
      sessionId: 'good-child',
      targetInfo: { targetId: 'tg', type: 'iframe', url: 'https://good.example/' },
    })
    await flushAsync()

    const errors = cdp.getRearmErrors()
    expect(errors).toHaveLength(1)
    const [firstError] = errors
    expect(firstError).toBeInstanceOf(CdpError)
    expect(firstError?.message).toContain('bad-child')

    // 失敗的那個子代本身仍然算「附著」了（第一次 attachedToTarget 本來就成功，
    // 只是後續要再往下遞迴的那次 setAutoAttach 失敗），另一個子代完全不受影響。
    const targets = cdp.getAttachedTargets()
    expect(targets).toContainEqual({ targetId: 'tb', type: 'iframe', url: 'https://bad.example/', sessionId: 'bad-child' })
    expect(targets).toContainEqual({ targetId: 'tg', type: 'iframe', url: 'https://good.example/', sessionId: 'good-child' })
    cdp.detach()
  })

  it('detach() 之後，即使監聽器仍被呼叫也不再對新 session re-arm（detached 旗標本身擋下，不只是靠移除監聽器）', async () => {
    const { wc, sendCommand, emitMessageBypassingRemoval, hasRegisteredListener } = createFakeDebugger()
    const cdp = await attachCdp(wc)

    cdp.detach()
    expect(hasRegisteredListener()).toBe(false) // detach() 有呼叫 removeListener

    sendCommand.mockClear()
    // 繞過 removeListener，直接呼叫監聽器本體，模擬「事件在移除生效前就已經送達」的競態。
    emitMessageBypassingRemoval('Target.attachedToTarget', {
      sessionId: 'late-child',
      targetInfo: { targetId: 'tl', type: 'iframe', url: 'https://late.example/' },
    })
    await flushAsync()

    expect(sendCommand).not.toHaveBeenCalledWith(
      'Target.setAutoAttach',
      expect.anything(),
      'late-child'
    )
  })
})

describe('attachCdp onEvent', () => {
  it('每一則 debugger message 都廣播給 listener，含 Target.attachedToTarget，依註冊順序呼叫', async () => {
    const { wc, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc)
    const calls: string[] = []
    cdp.onEvent(() => calls.push('a'))
    cdp.onEvent(() => calls.push('b'))

    emitMessage('Page.loadEventFired', {})
    emitMessage('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { targetId: 't1', type: 'iframe', url: 'https://child.example/' },
    })
    await flushAsync()

    expect(calls).toEqual(['a', 'b', 'a', 'b'])
    cdp.detach()
  })

  it('主 target 事件的 sessionId（空字串）轉成 undefined，子 session 事件的 sessionId 原樣傳遞', async () => {
    const { wc, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc)
    const received: (string | undefined)[] = []
    cdp.onEvent((_method, _params, sessionId) => received.push(sessionId))

    emitMessage('Page.loadEventFired', {})
    emitMessage('Network.requestWillBeSent', {}, 'child-1')
    await flushAsync()

    expect(received).toEqual([undefined, 'child-1'])
    cdp.detach()
  })

  it('一個 listener 丟例外不影響其他 listener，例外交給 onListenerError', async () => {
    const onListenerError = vi.fn()
    const { wc, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc, { onListenerError })
    const calls: string[] = []
    cdp.onEvent(() => {
      calls.push('first')
      throw new Error('第一個 listener 壞了')
    })
    cdp.onEvent(() => calls.push('second'))

    emitMessage('Page.loadEventFired', {})
    await flushAsync()

    expect(calls).toEqual(['first', 'second'])
    expect(onListenerError).toHaveBeenCalledTimes(1)
    expect((onListenerError.mock.calls[0]?.[0] as Error).message).toContain('第一個 listener 壞了')
    cdp.detach()
  })

  it('unsubscribe 之後不再收到事件', async () => {
    const { wc, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc)
    const calls: string[] = []
    const unsubscribe = cdp.onEvent(() => calls.push('x'))

    emitMessage('Page.loadEventFired', {})
    await flushAsync()
    unsubscribe()
    emitMessage('Page.loadEventFired', {})
    await flushAsync()

    expect(calls).toEqual(['x'])
    cdp.detach()
  })

  it('unsubscribe 在 listener 回呼中呼叫也安全：迭代時移除不跳過下一個 listener', async () => {
    const { wc, emitMessage } = createFakeDebugger()
    const cdp = await attachCdp(wc)
    const calls: string[] = []
    let unsubscribeSecond: () => void = () => {}
    cdp.onEvent(() => {
      calls.push('first')
      unsubscribeSecond()
    })
    unsubscribeSecond = cdp.onEvent(() => calls.push('second'))
    cdp.onEvent(() => calls.push('third'))

    emitMessage('Page.loadEventFired', {})
    await flushAsync()
    expect(calls).toEqual(['first', 'second', 'third'])

    calls.length = 0
    emitMessage('Page.loadEventFired', {})
    await flushAsync()
    expect(calls).toEqual(['first', 'third'])
    cdp.detach()
  })

  it('detach() 之後不再廣播（detached 旗標本身擋下，繞過 removeListener 直接呼叫監聽器本體也一樣）', async () => {
    const { wc, emitMessageBypassingRemoval } = createFakeDebugger()
    const cdp = await attachCdp(wc)
    const calls: string[] = []
    cdp.onEvent(() => calls.push('x'))

    cdp.detach()
    emitMessageBypassingRemoval('Page.loadEventFired', {})
    await flushAsync()

    expect(calls).toEqual([])
  })
})
