### Task 8: 網路靜默與載入等待（settle.ts）

八個工具裡有四個要等頁面「安靜下來」才回話：`view_click`、`view_type`（submit 時）、`view_press` 等網路靜默 500ms、上限 5 秒，`view_navigate` 等 `Page.loadEventFired` 再接靜默、兩段合計上限 8 秒。這件事只需要一份狀態：目前有多少個請求在飛。`settle.ts` 訂閱 CDP 事件維護這個數字，對外只給三個等待用的入口，不碰 DOM、不碰 Electron、不自己叫 CDP 指令，所以整個模組可以用假事件與假時鐘測到底。

資料結構就是一個 `Set<string>`，鍵是 `` `${sessionId ?? 'root'}:${requestId}` ``（裁決 30）。用 Set 不用計數器是這個模組唯一的關鍵設計：redirect 會用同一個 `requestId` 再送一次 `Network.requestWillBeSent`，但只會有一次 `loadingFinished`。計數器版本在每個 302 之後就永遠少減一次，頁面再也靜不下來，每次點擊都撐到 5 秒逾時才回；Set 的 `add` 對同一個鍵是冪等的，這個情況自然消失，不必加 if 判斷去認 `redirectResponse` 欄位。鍵要帶 session 的理由是每個 target 的 Network agent 各自編號，root 與某個 OOPIF 同時有一筆 `1000012.5` 是正常的，只用 `requestId` 當鍵會讓一邊的 `loadingFinished` 把另一邊還在飛的請求也消掉，等待提早結束、snapshot 拍到半成品。

三種「請求不會再有結局」的情況用清空處理，不是等它逾時：`Page.frameNavigated` 主 frame 換頁清整個集合（舊頁的請求不會再有 `loadingFinished`）；`Target.detachedFromTarget` 只清掉走掉那個 session 的鍵（iframe 載入到一半被移除，裁決 30）；`dispose()` 全清並讓還在等的呼叫端收 `'aborted'`。這也是鍵要帶 session 的第二個好處：清掉一個 session 就是前綴比對，不必另外維護一張 session 對請求的表。

`waitForLoad` 認兩種事件：`Page.loadEventFired` 與 `Page.navigatedWithinDocument`，都只認 `sessionId` 為 undefined 的那則（裁決 30）。hash 導航與 SPA 的 `history.pushState` 只發後者，沒有 load 事件，只等 `loadEventFired` 的版本會讓 `view_navigate` 在單頁應用上每次都撐滿 8 秒才回一句逾時。

時間全部走注入的 `MergerClock`（`src/main/agent-host.ts` 第 96 到 108 行定義，`SYSTEM_CLOCK` 是正式環境用的那份）。每個等待有兩個計時器：靜默計時器（`quietMs`）與逾時計時器（`timeoutMs`）並存，先到的那個決定結果，另一個當場清掉。測試用 `tests/helpers/manual-clock.ts` 的到期排序時鐘，`advance()` 只觸發 `due <= now` 的計時器，所以「500ms 與 5 秒兩個計時器並存時誰先到」是真的被驗到的，不是靠「一次全部觸發」蒙對。

靜默計時器從**呼叫當下**起算，不是從最後一個事件起算。差別在沒有任何網路活動的頁面上：從最後一個事件起算的版本永遠等不到第一個事件，`view_click` 點一個純前端的按鈕會撐到 5 秒逾時。實作上就是 `waitForQuiet` 進來時先呼叫一次 `armQuiet`，之後每則計數事件再呼叫一次（在飛數大於零就清掉計時器、不重排）。

`waitForLoad` 的兩段合計上限用「剩餘時間」表示：load 事件到達時算出 `timeoutMs - 已用時間`，把剩下的交給 `waitForQuiet`。如果第二段重新拿完整的 `timeoutMs`，`view_navigate` 在慢站上最壞會等到 16 秒，而工具描述對模型講的是 8 秒。

**Files:**
- Create `src/main/view-tools/settle.ts`（244 行）
- Test `tests/view-tools/settle.test.ts`（604 行，30 個測試）
- 依賴（本 task 不建立）：`tests/helpers/manual-clock.ts`（Task 0）、`tests/helpers/fake-cdp.ts`（Task 1）、`src/main/cdp.ts` 的 `onEvent`（Task 1）

**Interfaces:**

Consumes：
- Task 1 的 `src/main/cdp.ts`：`export type CdpEventListener = (method: string, params: unknown, sessionId?: string) => void`、`export type Unsubscribe = () => void`、`CdpSession.onEvent(listener: CdpEventListener): Unsubscribe`。只用 `onEvent` 這一個成員（參數型別是 `Pick<CdpSession, 'onEvent'>`），不呼叫 `send`。root session 的事件 `sessionId` 是 `undefined`（cdp.ts 已把 Electron 給的空字串轉掉）。
- `src/main/agent-host.ts` 的 `MergerClock`：`{ now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(handle: unknown): void }`。型別 import，不會把 Electron 拉進來。
- Task 0 的 `tests/helpers/manual-clock.ts`：`manualClock(start = 0): { clock: MergerClock; advance(ms: number): void; now(): number }`。
- Task 1 的 `tests/helpers/fake-cdp.ts`：`createFakeCdp()`，含 `onEvent(listener)` 回 unsubscribe、`emit(method, params, sessionId?)`。測試裡用 `ReturnType<typeof createFakeCdp>` 取型別，不綁它匯出的型別名稱。

Produces（契約 §9.2 全部）：
```ts
export const SETTLE_QUIET_MS = 500
export const SETTLE_TIMEOUT_MS = 5_000
export const NAVIGATE_TIMEOUT_MS = 8_000
export type SettleOutcome = 'quiet' | 'timeout' | 'aborted'
export interface SettleWaitOptions {
  readonly quietMs: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}
export interface SettleTracker {
  inflight(): number
  /** inflight 連續 quietMs 為 0 → 'quiet'；到 timeoutMs → 'timeout'；signal 中止 → 'aborted'。 */
  waitForQuiet(opts: SettleWaitOptions): Promise<SettleOutcome>
  /** 等主 frame 的 Page.loadEventFired 或 Page.navigatedWithinDocument 再接 waitForQuiet，兩段合計不超過 timeoutMs。 */
  waitForLoad(opts: SettleWaitOptions): Promise<SettleOutcome>
  /** 解除訂閱、清計時器；還在等的 waitFor* 全部以 'aborted' 結束。 */
  dispose(): void
}
export function createSettleTracker(cdp: Pick<CdpSession, 'onEvent'>, clock: MergerClock): SettleTracker
```
Task 9 的 controller 這樣用：`navigate` 走 `waitForLoad({ quietMs: SETTLE_QUIET_MS, timeoutMs: NAVIGATE_TIMEOUT_MS, signal })`，`click`／`type`／`press` 走 `waitForQuiet({ quietMs: SETTLE_QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS, signal })`；回 `'timeout'` 丟 `settleTimeout(5)` 或 `navigateTimeout(url)`，回 `'aborted'` 丟 `MSG.sessionEnded`。

- [ ] **Step 1: 寫失敗的測試**

建立 `tests/view-tools/settle.test.ts`（目錄不存在就先 `mkdir -p tests/view-tools`）。完整內容如下，分四段貼完就是整個檔案。

第一段（開頭到 `waitForQuiet` 的前三個測試）：

```ts
import { describe, expect, it, vi } from 'vitest'
import {
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
  })
})

describe('waitForQuiet', () => {
  it('沒有在飛請求時從呼叫當下起算 500ms 才算靜默', async () => {
    const { tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    advance(499)
    await flush()
    expect(pending.outcome()).toBeUndefined()

    advance(1)
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
```

第二段（`waitForQuiet` 其餘測試與 `frameNavigated`，接在上一段的最後一行後面）：

```ts
  it('請求持續不斷時在 5000ms 回 timeout', async () => {
    const { cdp, tracker, advance } = setup()
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

  it('不同 session 的相同 requestId 不互相抵銷', async () => {
    const { cdp, tracker, advance } = setup()
    const pending = watchOutcome(tracker.waitForQuiet(QUIET))

    request(cdp, 'r1')
    request(cdp, 'r1', 'S1') // 子 session 的 Network agent 自己編號，撞號是常態
    expect(tracker.inflight()).toBe(2)

    advance(100)
    finished(cdp, 'r1') // 只結束 root 那一筆
    expect(tracker.inflight()).toBe(1)

    advance(600) // t=700
    await flush()
    expect(pending.outcome()).toBeUndefined()

    finished(cdp, 'r1', 'S1')
    expect(tracker.inflight()).toBe(0)

    advance(500) // t=1200
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
```

第三段（`Target.detachedFromTarget`、`signal`、多個等待並行、`waitForLoad`）：

```ts
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
```

第四段（`dispose` 與壞掉的事件參數，貼完檔案結束）：

```ts
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
```

測試設計上的三個要點，改動時不要拿掉：

1. `setup()` 的 `clock` 是包在 `manualClock()` 外面的一層，記錄還沒被 `clearTimer` 的 handle。abort 與 dispose 的測試靠 `liveTimers()` 斷言「計時器真的清掉了」，只看回傳值看不出計時器有沒有留著。
2. 每個時間點都用 `advance(n-1)` 加 `advance(1)` 卡在到期前後各測一次，不是一次 `advance(大數字)`。一次推很多的寫法在「靜默從最後一個事件起算」這種錯誤實作下照樣會綠。
3. `watchOutcome` 不用 `await` 那個 promise，而是把結果記到變數再斷言 `toBeUndefined()`。直接 `await` 一個永遠不 resolve 的 promise 會卡到 vitest 逾時，錯誤訊息看不出是哪一段時間算錯。

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/settle.test.ts
```

預期：`Error: Failed to resolve import "../../src/main/view-tools/settle.js"`，測試檔整個載入失敗（0 passed）。如果看到的是 `manualClock is not a function` 或 `createFakeCdp` 找不到，代表 Task 0 或 Task 1 的 helper 還沒進來，先把那兩個 task 做完。

- [ ] **Step 3: 最小實作**

建立 `src/main/view-tools/settle.ts`（目錄不存在就先 `mkdir -p src/main/view-tools`）。兩段貼完就是整個檔案，共 217 行。

第一段（型別、常數、事件參數的讀取）：

```ts
import type { CdpEventListener, CdpSession } from '../cdp.js'
import type { MergerClock } from '../agent-host.js'

/** 在飛請求連續為零多久算靜默（契約 §9.2）。 */
export const SETTLE_QUIET_MS = 500
/** click／type／press 之後等靜默的上限。 */
export const SETTLE_TIMEOUT_MS = 5_000
/** navigate 的 load 加靜默合計上限。 */
export const NAVIGATE_TIMEOUT_MS = 8_000

export type SettleOutcome = 'quiet' | 'timeout' | 'aborted'

export interface SettleWaitOptions {
  readonly quietMs: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface SettleTracker {
  /** 目前在飛的請求數（所有 session 合計）。 */
  inflight(): number
  /** inflight 連續 quietMs 為 0 → 'quiet'；到 timeoutMs → 'timeout'；signal 中止 → 'aborted'。 */
  waitForQuiet(opts: SettleWaitOptions): Promise<SettleOutcome>
  /** 等主 frame 的 Page.loadEventFired 或 Page.navigatedWithinDocument 再接 waitForQuiet，兩段合計不超過 timeoutMs。 */
  waitForLoad(opts: SettleWaitOptions): Promise<SettleOutcome>
  /** 解除訂閱、清計時器；還在等的 waitFor* 全部以 'aborted' 結束。 */
  dispose(): void
}

interface QuietWaiter {
  readonly quietMs: number
  quietTimer: unknown
  deadlineTimer: unknown
  readonly finish: (outcome: SettleOutcome) => void
}

interface LoadWaiter {
  readonly hit: () => void
  readonly abort: () => void
}

/**
 * 在飛集合的鍵。各 session 的 Network agent 各自編號 requestId，兩個 frame 同時
 * 拿到 '1000012.5' 是正常的，只用 requestId 當鍵會讓一邊的 finished 把另一邊的
 * 請求也消掉（裁決 30，docs/superpowers/plan-b/CONTRACT.md）。
 */
function inflightKey(sessionId: string | undefined, requestId: string): string {
  return `${sessionId ?? 'root'}:${requestId}`
}

function requestIdOf(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const id = (params as { requestId?: unknown }).requestId
  return typeof id === 'string' ? id : null
}

/** requestWillBeSent 的 type 是 ResourceType，欄位在協定上是選填的。 */
function resourceTypeOf(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const type = (params as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

/** Target.detachedFromTarget 的 params.sessionId 是走掉的那個子 session。 */
function detachedSessionOf(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const id = (params as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 主 frame 換頁：sessionId 為 undefined（root session）且 frame 沒有 parentId。
 *
 * 兩個條件都要：OOPIF 自己的 session 也會為它那個 iframe 送出沒有 parentId 的
 * frameNavigated（在那個 target 眼裡它就是最上層），只看 parentId 會讓 iframe
 * 內部換頁清掉整頁的在飛請求。
 */
function isMainFrameNavigation(params: unknown, sessionId: string | undefined): boolean {
  if (sessionId !== undefined) return false
  if (params === null || typeof params !== 'object') return false
  const frame = (params as { frame?: unknown }).frame
  if (frame === null || typeof frame !== 'object') return false
  return (frame as { parentId?: unknown }).parentId === undefined
}
```

CDP 的參數形狀（推論，依 CDP 協定定義，不是本專案實測）：`Network.requestWillBeSent` 有 `requestId`、`type`（ResourceType，選填）、redirect 時多一個 `redirectResponse`；`loadingFinished` 有 `requestId`、`encodedDataLength`；`loadingFailed` 有 `requestId`、`errorText`；`Page.frameNavigated` 有 `frame.id`／`frame.url`／`frame.parentId`（最上層沒有這個欄位）；`Page.loadEventFired` 只有 `timestamp`；`Page.navigatedWithinDocument` 有 `frameId`、`url`；`Target.detachedFromTarget` 有 `sessionId`（走掉的那個子 session，不是事件本身的 sessionId）。`Network.requestServedFromCache` 不必處理：命中快取的請求後面照樣有 `loadingFinished`，多接一個事件只會把同一件事算兩次。所有讀取都當外部輸入檢查型別，形狀不對就當這則事件不存在。

兩個判定範圍照契約寫死，不自己加條件：`Target.detachedFromTarget` 不看事件本身的 `sessionId`（巢狀 OOPIF 的 detach 會由它的父 session 廣播，那也該清），`Page.navigatedWithinDocument` 只看事件的 `sessionId` 是不是 undefined、不比對 `frameId` 是不是主 frame（root session 裡同行程子 frame 的 hash 導航會被當成載入完成，代價只是提早進入靜默那一段，而靜默本身照樣會等網路安靜）。

第二段（`createSettleTracker`，接在第一段後面）：

```ts
/**
 * 網路靜默與載入等待。
 *
 * 只吃 CDP 事件，時間全部走注入的 clock（測試用 tests/helpers/manual-clock.ts），
 * 所以 500ms 與 5 秒兩個計時器並存時的到期順序是可測的。
 */
export function createSettleTracker(cdp: Pick<CdpSession, 'onEvent'>, clock: MergerClock): SettleTracker {
  const inflightIds = new Set<string>()
  const quietWaiters = new Set<QuietWaiter>()
  const loadWaiters = new Set<LoadWaiter>()
  let disposed = false

  /** 靜默計時重排：呼叫當下就排一次，之後每則計數事件再排一次。 */
  const armQuiet = (waiter: QuietWaiter): void => {
    clock.clearTimer(waiter.quietTimer)
    waiter.quietTimer = null
    if (inflightIds.size > 0) return
    waiter.quietTimer = clock.setTimer(() => {
      waiter.finish('quiet')
    }, waiter.quietMs)
  }

  /** 回傳這則事件是否進入在飛計數的範圍（是的話所有 waiter 都要重排靜默計時）。 */
  const applyToInflight = (method: string, params: unknown, sessionId: string | undefined): boolean => {
    if (method === 'Network.requestWillBeSent') {
      const id = requestIdOf(params)
      if (id === null) return false
      // EventSource 永遠不會有 loadingFinished，計進來就再也靜不下來。
      if (resourceTypeOf(params) === 'EventSource') return false
      // Set：redirect 會用同一個 requestId 再送一次 requestWillBeSent，不重複計入。
      inflightIds.add(inflightKey(sessionId, id))
      return true
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const id = requestIdOf(params)
      if (id === null) return false
      inflightIds.delete(inflightKey(sessionId, id))
      return true
    }
    if (method === 'Target.detachedFromTarget') {
      const gone = detachedSessionOf(params)
      if (gone === null) return false
      // iframe 在載入途中被移除：它的請求不會再有 finished，留著就永遠靜不下來。
      const prefix = `${gone}:`
      for (const key of [...inflightIds]) if (key.startsWith(prefix)) inflightIds.delete(key)
      return true
    }
    if (method === 'Page.frameNavigated' && isMainFrameNavigation(params, sessionId)) {
      // 舊頁的請求不會再有 finished，留著會讓後續每次等待都撐到逾時。
      inflightIds.clear()
      return true
    }
    return false
  }

  const handleEvent: CdpEventListener = (method, params, sessionId) => {
    if (disposed) return
    // hash 與 SPA 的同文件導航只發 navigatedWithinDocument，沒有 loadEventFired。
    // 兩者都只認 root session 那則（裁決 30）。
    if (method === 'Page.loadEventFired' || method === 'Page.navigatedWithinDocument') {
      if (sessionId === undefined) for (const waiter of [...loadWaiters]) waiter.hit()
      return
    }
    if (!applyToInflight(method, params, sessionId)) return
    for (const waiter of quietWaiters) armQuiet(waiter)
  }

  const unsubscribe = cdp.onEvent(handleEvent)

  const waitForQuiet = (opts: SettleWaitOptions): Promise<SettleOutcome> => {
    if (opts.signal?.aborted === true || disposed) return Promise.resolve<SettleOutcome>('aborted')
    return new Promise<SettleOutcome>((resolve) => {
      const waiter: QuietWaiter = {
        quietMs: opts.quietMs,
        quietTimer: null,
        deadlineTimer: null,
        finish: (outcome) => {
          // delete 回 false 代表這個 waiter 已經結束過，後到的計時器不再改變結果。
          if (!quietWaiters.delete(waiter)) return
          clock.clearTimer(waiter.quietTimer)
          clock.clearTimer(waiter.deadlineTimer)
          waiter.quietTimer = null
          waiter.deadlineTimer = null
          opts.signal?.removeEventListener('abort', onAbort)
          resolve(outcome)
        },
      }
      const onAbort = (): void => {
        waiter.finish('aborted')
      }
      quietWaiters.add(waiter)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      waiter.deadlineTimer = clock.setTimer(() => {
        waiter.finish('timeout')
      }, opts.timeoutMs)
      armQuiet(waiter)
    })
  }

  const waitForLoad = (opts: SettleWaitOptions): Promise<SettleOutcome> => {
    if (opts.signal?.aborted === true || disposed) return Promise.resolve<SettleOutcome>('aborted')
    const startedAt = clock.now()
    return new Promise<SettleOutcome>((resolve) => {
      let settled = false
      const cleanup = (): void => {
        loadWaiters.delete(waiter)
        clock.clearTimer(deadlineTimer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const waiter: LoadWaiter = {
        hit: () => {
          if (settled) return
          settled = true
          cleanup()
          // 兩段合計不超過 timeoutMs：第二段只拿剩下的時間。
          const remaining = opts.timeoutMs - (clock.now() - startedAt)
          if (remaining <= 0) {
            resolve('timeout')
            return
          }
          resolve(waitForQuiet({ quietMs: opts.quietMs, timeoutMs: remaining, signal: opts.signal }))
        },
        abort: () => {
          if (settled) return
          settled = true
          cleanup()
          resolve('aborted')
        },
      }
      const onAbort = (): void => {
        waiter.abort()
      }
      const deadlineTimer = clock.setTimer(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve('timeout')
      }, opts.timeoutMs)
      loadWaiters.add(waiter)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    inflight: () => inflightIds.size,
    waitForQuiet,
    waitForLoad,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      // 契約 §9.2 只寫「退訂並清計時器」；等待中的呼叫端一律收 'aborted'，
      // 不留永遠不 resolve 的 promise（teardown 時 controller 會翻成「對話已結束」）。
      for (const waiter of [...loadWaiters]) waiter.abort()
      for (const waiter of [...quietWaiters]) waiter.finish('aborted')
      inflightIds.clear()
    },
  }
}
```

五個容易寫錯的地方：

1. `armQuiet` 在 `waitForQuiet` 進來時就呼叫一次。少了這一行，沒有網路活動的頁面永遠等不到靜默。
2. `waiter.finish` 用 `quietWaiters.delete(waiter)` 的回傳值當「已經結束過」的判斷，不另外開一個 `done` 旗標。同一個 waiter 的靜默與逾時兩個計時器可能都排上，先到的那個把 waiter 從集合移掉，後到的那個 `delete` 回 false 就直接 return。
3. `waitForLoad` 的第二段用 `remaining`，不是 `opts.timeoutMs`。
4. `add` 與 `delete` 兩邊都要經過 `inflightKey(sessionId, id)`。只有一邊帶 session 的話請求進得去出不來，比完全不帶還糟。
5. `Target.detachedFromTarget` 清完之後回 `true`。回 `false` 的話集合空了卻沒有人重排靜默計時器，等待要撐到逾時才結束，行為看起來像「偶爾比較慢」，很難查。

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/settle.test.ts
npx tsc --noEmit -p tsconfig.json
```

預期（已在 worktree 實跑）：

```
 Test Files  1 passed (1)
      Tests  30 passed (30)
```

`tsc --noEmit` 0 error。單檔覆蓋率（`npx vitest run tests/view-tools/settle.test.ts --coverage --coverage.include='src/main/view-tools/**'`）實測 Stmts 95.07、Branch 90.69、Funcs 100、Lines 100，都在判準（Stmts ≥ 93、Branch ≥ 86）之上。

- [ ] **Step 5: 突變測試**

十個突變都在 worktree 實跑過，每個都改實作、跑 `npx vitest run tests/view-tools/settle.test.ts`、記下變紅的測試、還原確認回綠（還原後每次都是 30 passed）。

**突變 1：靜默計時從最後一個事件起算，不從呼叫當下起算。** 把 `waitForQuiet` 裡 `waiter.deadlineTimer = clock.setTimer(...)` 後面那行 `armQuiet(waiter)` 刪掉（只留事件進來時的重排）。變紅 6 個：

```
× 沒有在飛請求時從呼叫當下起算 500ms 才算靜默
× EventSource 的請求不計入
× 中途 abort 回 aborted 並清掉兩個計時器
× load 之後再等靜默
× navigatedWithinDocument 也算載入完成
× 缺 requestId 或形狀不對的事件被忽略
Tests  6 failed | 24 passed (30)
```

這個突變是這個 task 最重要的一個，而且「請求在 t=100 開始、t=300 結束」那個測試在突變下**照樣是綠的**：t=300 的 `loadingFinished` 會替它排上計時器，t=800 一樣 resolve。只有「完全沒有網路事件」的場景抓得到，所以那個測試不能拿掉。

**突變 2：`loadingFailed` 不減在飛數。** 把 `if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed')` 改成只留 `loadingFinished`。變紅 1 個：

```
× loadingFailed 也把在飛請求減掉
Tests  1 failed | 29 passed (30)
```

**突變 3：子 frame 的 `frameNavigated` 也清空。** 把 `isMainFrameNavigation` 最後兩行改成 `return frame !== null && typeof frame === 'object'`（不看 `parentId`）。變紅 1 個：

```
× 子 frame（有 parentId）換頁不清空
Tests  1 failed | 29 passed (30)
```

**突變 4：用計數器取代 Set，redirect 重複計入。** 把 `inflightIds` 換成 `let inflightCount = 0`，`requestWillBeSent` 改 `inflightCount += 1`、`loadingFinished`／`loadingFailed` 改 `inflightCount = Math.max(0, inflightCount - 1)`、`frameNavigated` 與 `detachedFromTarget` 改 `inflightCount = 0`、`inflight()` 回 `inflightCount`、`armQuiet` 的條件改 `inflightCount > 0`。變紅 3 個：

```
× redirect 的同一個 requestId 不重複計入
× 只清掉走掉那個 session 的在飛請求
× iframe 載入途中被移除時，等待中的 waitForQuiet 結束得了
Tests  3 failed | 27 passed (30)
```

redirect 那個測試是唯一一個同一個 `requestId` 送兩次 `requestWillBeSent` 的場景，而且斷言同時看 `inflight()` 為 0 與最後 resolve 為 `'quiet'`。只斷言結果不斷言計數的話，5 秒逾時之後拿到的是 `'timeout'`，測試名字看起來還是對的。

**突變 5：`waitForLoad` 第二段重新拿完整的 `timeoutMs`。** 把 `resolve(waitForQuiet({ ..., timeoutMs: remaining, ... }))` 的 `remaining` 改成 `opts.timeoutMs`。變紅 1 個：

```
× 兩段合計不超過 timeoutMs
Tests  1 failed | 29 passed (30)
```

**突變 6：`EventSource` 也計入在飛數。** 把 `if (resourceTypeOf(params) === 'EventSource') return false` 刪掉。變紅 1 個：

```
× EventSource 的請求不計入
Tests  1 failed | 29 passed (30)
```

**突變 7：在飛集合的鍵不帶 session。** 把 `inflightKey` 的本體改成 `return requestId`。變紅 3 個：

```
× 不同 session 的相同 requestId 不互相抵銷
× 只清掉走掉那個 session 的在飛請求
× iframe 載入途中被移除時，等待中的 waitForQuiet 結束得了
Tests  3 failed | 27 passed (30)
```

三個一起紅是對的：鍵沒有 session 前綴，`detachedFromTarget` 的前綴比對也就永遠比不中。這也說明測試不能只斷言「最後 resolve 成 quiet」，`不同 session 的相同 requestId 不互相抵銷` 中間那句 `expect(tracker.inflight()).toBe(1)` 才是抓到這個突變的那一行。

**突變 8：`detachedFromTarget` 清空整個集合。** 把前綴比對那一行改成 `inflightIds.clear()`。變紅 1 個：

```
× 只清掉走掉那個 session 的在飛請求
Tests  1 failed | 29 passed (30)
```

**突變 9：`waitForLoad` 只認 `loadEventFired`。** 把 `if (method === 'Page.loadEventFired' || method === 'Page.navigatedWithinDocument')` 改成只留 `loadEventFired`。變紅 1 個：

```
× navigatedWithinDocument 也算載入完成
Tests  1 failed | 29 passed (30)
```

**突變 10：`detachedFromTarget` 清完之後回 `false`（忘了重排靜默計時）。** 變紅 1 個：

```
× iframe 載入途中被移除時，等待中的 waitForQuiet 結束得了
Tests  1 failed | 29 passed (30)
```

這個突變的在飛數是對的（`只清掉走掉那個 session 的在飛請求` 照樣綠），錯的只有「等待什麼時候結束」。同時斷言計數與時間點的測試才擋得住。

- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/settle.ts tests/view-tools/settle.test.ts
git commit -m "feat: 網路靜默與載入等待（settle.ts）"
```

