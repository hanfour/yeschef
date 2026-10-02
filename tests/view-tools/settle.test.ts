import { describe, expect, it, vi } from 'vitest'
import {
  INFLIGHT_MAX_AGE_MS,
  NAVIGATE_TIMEOUT_MS,
  SETTLE_QUIET_MS,
  SETTLE_TIMEOUT_MS,
  createSettleTracker,
  type SettleOutcome,
  type SettleTracker,
} from '../../src/main/view-tools/settle.js'
import type { MergerClock } from '../../src/main/agent-host.js'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import { manualClock } from '../helpers/manual-clock.js'

/** 不綁 Task 1 helper 的型別名稱，只綁它的回傳值。 */
type FakeCdp = ReturnType<typeof createFakeCdp>

/** 讓 .then 的 microtask 跑完；settle.ts 只用注入的 clock，真的 setTimeout 不影響它。 */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface Pending {
  readonly outcome: () => SettleOutcome | undefined
}

function watchOutcome(promise: Promise<SettleOutcome>): Pending {
  let outcome: SettleOutcome | undefined
  void promise.then((o) => {
    outcome = o
  })
  return { outcome: () => outcome }
}

interface Harness {
  readonly cdp: FakeCdp
  readonly tracker: SettleTracker
  readonly clock: MergerClock
  readonly advance: (ms: number) => void
  /** 目前還沒被 clearTimer 的 timer handle 數。 */
  readonly liveTimers: () => number
}

function setup(): Harness {
  const { clock: base, advance } = manualClock()
  const live = new Set<unknown>()
  const clock: MergerClock = {
    now: base.now,
    setTimer: (fn, ms) => {
      const handle = base.setTimer(fn, ms)
      live.add(handle)
      return handle
    },
    clearTimer: (handle) => {
      live.delete(handle)
      base.clearTimer(handle)
    },
  }
  const cdp = createFakeCdp()
  const tracker = createSettleTracker(cdp, clock)
  return { cdp, tracker, clock, advance, liveTimers: () => live.size }
}

const QUIET = { quietMs: SETTLE_QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS }

function request(cdp: FakeCdp, id: string, sessionId?: string, type = 'Fetch'): void {
  cdp.emit('Network.requestWillBeSent', { requestId: id, type }, sessionId)
}
function finished(cdp: FakeCdp, id: string, sessionId?: string): void {
  cdp.emit('Network.loadingFinished', { requestId: id, encodedDataLength: 12 }, sessionId)
}
function navigated(cdp: FakeCdp, frameId: string, parentId?: string, sessionId?: string): void {
  const frame = parentId === undefined ? { id: frameId, url: 'https://b/' } : { id: frameId, parentId, url: 'https://b/' }
  cdp.emit('Page.frameNavigated', { frame }, sessionId)
}

describe('常數', () => {
  it('是契約 §9.2 的三個值', () => {
    expect(SETTLE_QUIET_MS).toBe(500)
    expect(SETTLE_TIMEOUT_MS).toBe(5_000)
    expect(NAVIGATE_TIMEOUT_MS).toBe(8_000)
    expect(INFLIGHT_MAX_AGE_MS).toBe(30_000)
  })
})

describe('waitForQuiet', () => {
  it('沒有在飛請求時從呼叫當下起算 500ms 才算靜默', async () => {
    const { tracker, advance, liveTimers } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(499)
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1)
    await flush()
    expect(pending.outcome()).toBe('quiet')
    expect(liveTimers()).toBe(0)
  })

  it('集合裡沒有 requestId 時，loadingFinished 不會重排靜默計時', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(100)
    finished(cdp, 'missing')

    advance(399) // t=499：原本的靜默計時仍應在 t=500 到期
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=500
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('請求在 t=100 開始、t=300 結束時，靜默在 t=800 才成立', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(100)
    request(cdp, 'r1')
    expect(tracker.inflight()).toBe(1)

    advance(200) // t=300
    finished(cdp, 'r1')
    expect(tracker.inflight()).toBe(0)

    advance(200) // t=500：呼叫當下排的那個 500ms 已經被重排掉
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(299) // t=799
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=800
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('loadingFailed 也把在飛請求減掉', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(100)
    request(cdp, 'r1')
    advance(200) // t=300
    cdp.emit('Network.loadingFailed', { requestId: 'r1', type: 'Fetch', errorText: 'net::ERR_FAILED' })
    expect(tracker.inflight()).toBe(0)

    advance(400) // t=700
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(100) // t=800
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('請求持續不斷時在 5000ms 回 timeout', async () => {
    const { cdp, tracker, advance, liveTimers } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    for (let t = 200; t <= 4_800; t += 200) {
      advance(200)
      request(cdp, `r${t}`)
      await flush()
      expect(pending.outcome()).toBeUndefined()
    }

    advance(200) // t=5000
    await flush()
    expect(pending.outcome()).toBe('timeout')
    expect(liveTimers()).toBe(0)

    for (let t = 5_200; t <= 6_000; t += 200) {
      advance(200)
      request(cdp, `r${t}`)
    }
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })

  it('redirect 的同一個 requestId 不重複計入', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(100)
    request(cdp, 'r1')
    advance(100) // t=200：redirect，同一個 requestId 再送一次
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Document',
      redirectResponse: { status: 302, url: 'https://a/' },
    })
    expect(tracker.inflight()).toBe(1)

    advance(100) // t=300
    finished(cdp, 'r1')
    expect(tracker.inflight()).toBe(0)

    advance(499) // t=799
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=800
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('子 session 的請求一樣計入', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(100)
    request(cdp, 'r1', 'S1')
    expect(tracker.inflight()).toBe(1)

    advance(600) // t=700：只有子 session 的請求也擋得住靜默
    await flush()
    expect(pending.outcome()).toBeUndefined()

    finished(cdp, 'r1', 'S1')
    advance(500) // t=1200
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('requestWillBeSent 與 loadingFinished 可由不同 session 配對', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    request(cdp, 'r1')
    expect(tracker.inflight()).toBe(1)

    advance(100)

    finished(cdp, 'r1', 'S1') // 實機上跨站 iframe 會由子 session 結束 root 發出的請求
    expect(tracker.inflight()).toBe(0)

    advance(499) // t=599
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=600
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('EventSource 的請求不計入', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(100)
    request(cdp, 'sse1', undefined, 'EventSource')
    expect(tracker.inflight()).toBe(0)

    advance(399) // t=499
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=500：EventSource 既不計入也不重排靜默計時
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('請求超過在飛上限且沒有結束事件時，重新等待仍可回 quiet', async () => {
    const { cdp, tracker, advance } = setup()

    request(cdp, 'stream1', undefined, 'Fetch')
    advance(INFLIGHT_MAX_AGE_MS + 1)
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(SETTLE_QUIET_MS)
    await flush()
    expect(pending.outcome()).toBe('quiet')
    expect(tracker.inflight()).toBe(0)
  })
})

describe('frameNavigated', () => {
  it('主 frame 換頁清空在飛請求', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    request(cdp, 'r1')
    request(cdp, 'r2')
    advance(100)
    navigated(cdp, 'F-main')
    expect(tracker.inflight()).toBe(0)

    advance(499) // t=599
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=600
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('子 frame（有 parentId）換頁不清空', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    request(cdp, 'r1')
    request(cdp, 'r2')
    advance(100)
    navigated(cdp, 'F-child', 'F-main')
    expect(tracker.inflight()).toBe(2)

    advance(5_000)
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })

  it('OOPIF session 的無 parentId 換頁不清空', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    request(cdp, 'r1')
    advance(100)
    navigated(cdp, 'F-oopif', undefined, 'S1')
    expect(tracker.inflight()).toBe(1)

    advance(5_000)
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })
})

describe('Target.detachedFromTarget', () => {
  it('只清掉走掉那個 session 的在飛請求', () => {
    const { cdp, tracker } = setup()

    request(cdp, 'r1')
    request(cdp, 'r2', 'S1')
    request(cdp, 'r3', 'S1')
    expect(tracker.inflight()).toBe(3)

    cdp.emit('Target.detachedFromTarget', { sessionId: 'S1' })
    expect(tracker.inflight()).toBe(1) // root 的 r1 還在

    finished(cdp, 'r1')
    expect(tracker.inflight()).toBe(0)
  })

  it('iframe 載入途中被移除時，等待中的 waitForQuiet 結束得了', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    request(cdp, 'r1', 'S1')
    advance(100)
    await flush()
    expect(pending.outcome()).toBeUndefined()

    cdp.emit('Target.detachedFromTarget', { sessionId: 'S1' })
    expect(tracker.inflight()).toBe(0)

    advance(499) // t=599
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=600：從 detach 那一刻起算 500ms
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('沒有 sessionId 的 detach 事件不動在飛請求', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    request(cdp, 'r1', 'S1')
    advance(100)
    cdp.emit('Target.detachedFromTarget', {})
    cdp.emit('Target.detachedFromTarget', { sessionId: '' })
    expect(tracker.inflight()).toBe(1)

    advance(5_000)
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })
})

describe('signal', () => {
  it('已經 aborted 的 signal 立刻回 aborted', async () => {
    const { tracker } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(tracker.waitForQuiet({ ...QUIET, signal: controller.signal })).resolves.toBe('aborted')
  })

  it('中途 abort 回 aborted 並清掉兩個計時器', async () => {
    const { tracker, advance, liveTimers } = setup()
    const controller = new AbortController()
    const pending = watchOutcome(tracker.waitForQuiet({ ...QUIET, signal: controller.signal }))
    expect(liveTimers()).toBe(2) // 靜默 500ms 與逾時 5000ms

    advance(300)
    controller.abort()
    await flush()
    expect(pending.outcome()).toBe('aborted')
    expect(liveTimers()).toBe(0)

    advance(10_000)
    await flush()
    expect(pending.outcome()).toBe('aborted')
  })
})

describe('多個等待並行', () => {
  it('各自獨立計時', async () => {
    const { cdp, tracker, advance } = setup()
    const first = watchOutcome(tracker.waitForQuiet(QUIET)) // t=0 起算

    advance(100)
    request(cdp, 'r1')

    advance(100) // t=200：這時 inflight 為 1，第二個等待不從呼叫當下起算
    const second = watchOutcome(tracker.waitForQuiet({ quietMs: 300, timeoutMs: 1_000 }))

    advance(200) // t=400
    finished(cdp, 'r1')

    advance(300) // t=700：second 的 300ms 到期，first 的 500ms 還沒
    await flush()
    expect(second.outcome()).toBe('quiet')
    expect(first.outcome()).toBeUndefined()

    advance(200) // t=900
    await flush()
    expect(first.outcome()).toBe('quiet')
  })
})

describe('waitForLoad', () => {
  const LOAD = { quietMs: SETTLE_QUIET_MS, timeoutMs: NAVIGATE_TIMEOUT_MS }

  it('load 之後再等靜默', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForLoad(LOAD))

    advance(1_000)
    await flush()
    expect(pending.outcome()).toBeUndefined()

    cdp.emit('Page.loadEventFired', { timestamp: 1 })
    advance(499) // t=1499
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=1500
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('navigatedWithinDocument 也算載入完成', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForLoad(LOAD))

    advance(1_000)
    // hash 或 SPA 的同文件導航只發這則，不會有 loadEventFired
    cdp.emit('Page.navigatedWithinDocument', { frameId: 'F-main', url: 'https://a/#x' })
    advance(499) // t=1499
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=1500
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })

  it('load 沒到就到 8000ms 回 timeout', async () => {
    const { tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForLoad(LOAD))

    advance(7_999)
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1)
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })

  it('兩段合計不超過 timeoutMs', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForLoad(LOAD))

    advance(7_800)
    cdp.emit('Page.loadEventFired', { timestamp: 1 })
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(200) // t=8000：剩下的 200ms 用完，靜默那 500ms 還沒到
    await flush()
    expect(pending.outcome()).toBe('timeout')

    advance(500) // t=8500：就算靜默計時到了也不改結果
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })

  it('計時器延遲觸發、load 到的時候時間已經用完就回 timeout', async () => {
    // 真實 setTimeout 會漂：逾時計時器還沒跑到，clock.now() 已經超過期限。
    // 這裡用一個不會自己觸發計時器的 clock 把那一刻做出來。
    const cdp = createFakeCdp()
    let now = 0
    const lazyClock: MergerClock = { now: () => now, setTimer: () => 1, clearTimer: () => {} }
    const tracker = createSettleTracker(cdp, lazyClock)
    const pending = watchOutcome(tracker.waitForLoad(LOAD))

    now = NAVIGATE_TIMEOUT_MS + 20
    cdp.emit('Page.loadEventFired', { timestamp: 1 })
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })

  it('子 session 的 load 事件都不算', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForLoad(LOAD))

    advance(1_000)
    cdp.emit('Page.loadEventFired', { timestamp: 1 }, 'S1')
    cdp.emit('Page.navigatedWithinDocument', { frameId: 'F-oopif', url: 'https://b/#x' }, 'S1')
    advance(6_999) // t=7999
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1) // t=8000
    await flush()
    expect(pending.outcome()).toBe('timeout')
  })

  it('中途 abort 回 aborted', async () => {
    const { tracker, advance, liveTimers } = setup()
    const controller = new AbortController()
    const pending = watchOutcome(tracker.waitForLoad({ ...LOAD, signal: controller.signal }))

    advance(1_000)
    controller.abort()
    await flush()
    expect(pending.outcome()).toBe('aborted')
    expect(liveTimers()).toBe(0)
  })

  it('已經 aborted 的 signal 立刻回 aborted', async () => {
    const { tracker } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(tracker.waitForLoad({ ...LOAD, signal: controller.signal })).resolves.toBe('aborted')
  })
})

describe('dispose', () => {
  it('退訂 onEvent，之後的事件不再影響計數', async () => {
    const { clock, advance } = setup()
    const cdp = createFakeCdp()
    const unsubscribed = vi.fn()
    const tracker = createSettleTracker(
      {
        onEvent: (listener) => {
          const off = cdp.onEvent(listener)
          return () => {
            unsubscribed()
            off()
          }
        },
      },
      clock
    )

    request(cdp, 'r1')
    expect(tracker.inflight()).toBe(1)

    tracker.dispose()
    expect(unsubscribed).toHaveBeenCalledTimes(1)

    request(cdp, 'r2')
    finished(cdp, 'r1')
    expect(tracker.inflight()).toBe(0)

    advance(10_000)
    await flush()
  })

  it('廣播途中被 dispose 時，這一輪剩下的事件也不再計入', () => {
    // cdp.ts 對 listener 快照迭代，所以前一個 listener 在迴圈裡 dispose 之後，
    // 我們的 handleEvent 這一輪還是會被呼叫到。
    const { clock } = setup()
    const cdp = createFakeCdp()
    let tracker: SettleTracker | null = null
    cdp.onEvent(() => {
      tracker?.dispose()
    })
    tracker = createSettleTracker(cdp, clock)

    request(cdp, 'r1')
    expect(tracker.inflight()).toBe(0)
  })

  it('等待中的呼叫收到 aborted，dispose 之後再等也是 aborted', async () => {
    const { tracker, advance, liveTimers } = setup()
    const quiet = watchOutcome(tracker.waitForQuiet(QUIET))
    const load = watchOutcome(tracker.waitForLoad({ quietMs: SETTLE_QUIET_MS, timeoutMs: NAVIGATE_TIMEOUT_MS }))

    advance(100)
    tracker.dispose()
    await flush()
    expect(quiet.outcome()).toBe('aborted')
    expect(load.outcome()).toBe('aborted')
    expect(liveTimers()).toBe(0)

    await expect(tracker.waitForQuiet(QUIET)).resolves.toBe('aborted')
    await expect(tracker.waitForLoad(QUIET)).resolves.toBe('aborted')
    tracker.dispose() // 第二次 dispose 不炸
  })
})

describe('壞掉的事件參數', () => {
  it('缺 requestId 或形狀不對的事件被忽略', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    cdp.emit('Network.requestWillBeSent', null)
    cdp.emit('Network.requestWillBeSent', { requestId: 7 })
    cdp.emit('Network.loadingFinished', undefined)
    cdp.emit('Page.frameNavigated', { frame: null })
    cdp.emit('Runtime.consoleAPICalled', { type: 'log' })
    expect(tracker.inflight()).toBe(0)

    advance(500)
    await flush()
    expect(pending.outcome()).toBe('quiet')
  })
})
