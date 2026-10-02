### Task 1: cdp.ts 加事件訂閱與 sessionId、假 CDP helper

cdp.ts 目前只有 `send`／`detach`／`getAttachedTargets`／`getRearmErrors` 這四個方法，watch.ts（Task 6）要靠 `DOM.documentUpdated`、`Page.frameNavigated` 判斷 ref 失效，settle.ts（Task 8）要靠 `Network.*` 判斷靜默，這些都是 CDP 事件，不是現有介面能回答的問題。裁決 1（`docs/superpowers/plan-b/CONTRACT.md` §4）已經定案要加 `onEvent`；這是最小加法，不改既有三個方法的行為，也不影響已經在跑的 `send`／`detach` 流程。

廣播順序：`onEvent` 收到的是每一則 debugger message，含 cdp.ts 自己也在處理的 `Target.attachedToTarget`／`detachedFromTarget`；cdp.ts 先處理完（更新 `attachedTargets`、觸發 re-arm）再廣播，下游不需要重新解析 `Target.*` 的語意。`sessionId` 的正規化（Electron 給的空字串轉成 `undefined`，契約 §0 已查證主 target 的事件 sessionId 是空字串）放在這一層做一次，不要求八個下游工具各自判斷。

unsubscribe 的安全性：watch.ts、settle.ts 都會在自己的 `dispose()` 呼叫 unsubscribe，可能發生在另一個 listener 的回呼正在跑的當下。用陣列 splice 逐一走訪容易踩到「移除自己時索引位移，漏掉下一個」的錯誤；這裡的解法是廣播前把目前的 listener 複製成一份快照再逐一呼叫，不需要任何索引修正邏輯，把這個特殊情況整個消除掉而不是繞過它。同一個理由也用在 `tests/helpers/fake-cdp.ts` 的 `emit()`：這個 helper 是 Task 5、6、8、9、10 共用的測試替身，介面要先在這裡定案，實作也刻意複製跟 cdp.ts 本體一樣的快照設計，讓假的 `CdpSession` 在 unsubscribe 安全性這件事上跟真的行為一致，下游測試不會因為兩邊行為不同而落空。

沒有做的事：cdp.ts 仍然只在 `Page` 與 `Runtime` 兩個域呼叫 `enable`，`DOM`／`Network`／`Accessibility` 的啟用是 watch.ts（Task 6，裁決 5）的責任；也沒有讓 `detach()` 自動幫呼叫端解除所有 `onEvent` listener，契約明講由呼叫端自己在 `dispose()` 解除，cdp.ts 代勞等於幫下游決定生命週期。

**Files:**

- Modify `src/main/cdp.ts`（原始 167 行；型別區塊原第 24 到 55 行、`attachCdp` 主體原第 84 到 167 行都有改動，完整新內容見 Step 3，新檔 217 行）
- Modify `tests/cdp.test.ts`（原始 224 行；`createFakeDebugger` 的 `Listener` 型別與 `emitMessage`／`emitMessageBypassingRemoval` 要加 `sessionId` 參數，既有 6 個 re-arm 測試裡有 3 個用到 `getAttachedTargets()` 的期待值，都要加 `sessionId` 欄位，新增 `describe('attachCdp onEvent', ...)` 共 6 個測試；完整新內容見 Step 1，新檔 357 行）
- Create `tests/helpers/fake-cdp.ts`（98 行）
- Test: `tests/view-tools/fake-cdp.test.ts`（183 行）

**Interfaces:**

Consumes：無上游（Task 0 尚未產出任何本 task 用到的型別；本 task 不依賴其他 task）。

Produces（下游會 import 的精確簽章，照契約 §4、§14）：

```ts
// src/main/cdp.ts
export type CdpEventListener = (method: string, params: unknown, sessionId?: string) => void
export type Unsubscribe = () => void

export interface AttachedTargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  readonly sessionId: string
}

export interface CdpSession {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>
  detach(): void
  getAttachedTargets(): readonly AttachedTargetInfo[]
  getRearmErrors(): readonly CdpError[]
  onEvent(listener: CdpEventListener): Unsubscribe
}

export interface AttachCdpOptions {
  readonly onListenerError?: (error: Error) => void
}
export async function attachCdp(wc: WebContents, opts?: AttachCdpOptions): Promise<CdpSession>

// tests/helpers/fake-cdp.ts
export type SendResponder = (params: object | undefined, sessionId: string | undefined) => unknown
export interface FakeCdp extends CdpSession {
  readonly send: CdpSession['send'] & ReturnType<typeof vi.fn>
  readonly detach: CdpSession['detach'] & ReturnType<typeof vi.fn>
  onSend(method: string, responder: SendResponder, sessionId?: string): void
  emit(method: string, params: unknown, sessionId?: string): void
  setAttachedTargets(targets: readonly AttachedTargetInfo[]): void
  setRearmErrors(errors: readonly CdpError[]): void
}
export function createFakeCdp(): FakeCdp
```

`onSend` 匹配規則：有給 `sessionId` 的呼叫先找 `method` 加該 `sessionId` 的精確預錄，找不到才退回只用 `method` 的預錄；同一組 `method`／`sessionId` 重複呼叫 `onSend` 會覆蓋前一次。沒有任何匹配的預錄時 `send()` 回傳的 promise reject，錯誤訊息帶 `method`（有給 `sessionId` 也帶上）。

`emit` 的 `sessionId` 省略或為空字串都視為主 target，listener 收到 `undefined`；有值則原樣傳給 listener，語意與 `CdpSession.onEvent` 收到的廣播一致。

- [ ] **Step 1: 寫失敗的測試（`tests/cdp.test.ts` 完整新內容）**

既有測試因為 `AttachedTargetInfo` 多了 `sessionId` 欄位、`createFakeDebugger` 的訊息型別多了 `sessionId` 參數而需要同步修改；新增 `describe('attachCdp onEvent', ...)` 六個測試涵蓋：依註冊順序廣播且含 `Target.*`、sessionId 正規化、listener 例外隔離、unsubscribe 後不再收到、unsubscribe 在回呼中呼叫的安全性、`detach()` 之後不再廣播。整份檔案覆蓋寫入：

```ts
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
 * 只測 attachCdp() 這個公開介面，不碰 cdp.ts 內部（這一輪的指示是不准動
 * cdp.ts，透過公開介面加測試不違反這個限制。
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
     * sessionId 預設空字串，對應 Electron 的主 target 事件（契約 §0）。
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
    expect(targets).toContainEqual({
      targetId: 't1',
      type: 'iframe',
      url: 'https://child.example/',
      sessionId: 'child-1',
    })
    expect(targets).toContainEqual({
      targetId: 't2',
      type: 'iframe',
      url: 'https://grandchild.example/',
      sessionId: 'grandchild-1',
    })
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
    expect(targets).toContainEqual({
      targetId: 'tb',
      type: 'iframe',
      url: 'https://bad.example/',
      sessionId: 'bad-child',
    })
    expect(targets).toContainEqual({
      targetId: 'tg',
      type: 'iframe',
      url: 'https://good.example/',
      sessionId: 'good-child',
    })
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

    emitMessage('Page.loadEventFired', {}) // 預設 sessionId 為 ''
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
      unsubscribeSecond() // 第一個 listener 在自己的回呼裡把第二個移除
    })
    unsubscribeSecond = cdp.onEvent(() => calls.push('second'))
    cdp.onEvent(() => calls.push('third'))

    emitMessage('Page.loadEventFired', {})
    await flushAsync()

    // 這次廣播開始時第二個 listener 還在，理當被呼叫到；下一次廣播才會少了它。
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
```

- [ ] **Step 2: 跑測試確認失敗**

在 worktree 用未修改的 `src/main/cdp.ts` 跑上面這份新測試檔（已實跑）：

```
$ npx vitest run tests/cdp.test.ts
```

實跑結果：16 個測試裡 9 個失敗、7 個通過。3 個既有 re-arm 測試因為 `getAttachedTargets()` 少了 `sessionId` 欄位而斷言不符（例：`收到 Target.attachedToTarget 後...` 這個測試，`AssertionError: expected [ { targetId: 't1', …(2) } ] to deeply equal [ { targetId: 't1', …(3) } ]`，少的就是 `sessionId`）；6 個新的 `attachCdp onEvent` 測試全部拋出 `TypeError: cdp.onEvent is not a function`，因為 `attachCdp()` 回傳的物件還沒有 `onEvent`。符合預期：兩類失敗分別對應 `AttachedTargetInfo.sessionId` 與 `CdpSession.onEvent` 這兩個還沒實作的部分。

- [ ] **Step 3: 最小實作（`src/main/cdp.ts` 完整新內容）**

```ts
import type { Event, WebContents } from 'electron'

export class CdpError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CdpError'
    this.code = code
  }
}

/** CDP 的錯誤形狀不固定，統一成 CdpError 才能在上層一致處理。 */
export function toCdpError(raw: unknown): CdpError {
  if (typeof raw === 'string') return new CdpError(raw, 'unknown', { cause: raw })
  if (raw && typeof raw === 'object') {
    const o = raw as { code?: unknown; message?: unknown }
    const message = typeof o.message === 'string' ? o.message : '未知的 CDP 錯誤'
    const code = o.code === undefined ? 'unknown' : String(o.code)
    return new CdpError(message, code, { cause: raw })
  }
  return new CdpError('未知的 CDP 錯誤', 'unknown', { cause: raw })
}

/** 一個透過遞迴 auto-attach 收到附著事件的 target，範圍限定在這個 CdpSession 自己。 */
export interface AttachedTargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  /** 對這個 target 下指令要用的 sessionId。裁決 1（docs/superpowers/plan-b/CONTRACT.md）。 */
  readonly sessionId: string
}

/** onEvent 收到的每一則 debugger message。sessionId 是 Electron 給的空字串在這裡轉成 undefined 後的值。 */
export type CdpEventListener = (method: string, params: unknown, sessionId?: string) => void
export type Unsubscribe = () => void

export interface CdpSession {
  /**
   * sessionId 未提供時對根 session 下指令；提供時對該子 session 下指令
   * （例如遞迴 re-arm 附著到的跨站 iframe）。實作本來就支援，這裡只是把
   * 型別補齊，讓呼叫端能實際對子 session 送指令，而不只是看得到它附著了。
   */
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>
  detach(): void
  /**
   * 這個 session（含所有遞迴附著到的子代 session）目前已知附著的 target。
   *
   * 用 Target.attachedToTarget / Target.detachedFromTarget 事件即時維護，範圍
   * 是「這個 session 真的收到附著事件的 target」。故意不用 Target.getTargets()：
   * 那個指令回傳整個 browser context 的全域 target 清單，會把跟這個 session
   * 無關的東西也算進來（例如其他分頁、上一次導覽殘留的 service worker），而且
   * 它的 attached 欄位語意是「有任何 client 附著」，不是「附著到我這個 session」。
   */
  getAttachedTargets(): readonly AttachedTargetInfo[]
  /**
   * 遞迴 re-arm 某個子 session 的 auto-attach 若失敗，記在這裡而不是吞掉：
   * 失敗不會中止其他子代的附著流程（避免一個壞掉的子代拖垮全部），但呼叫端
   * 要能看到「這裡曾經失敗過、那個子代往下的孫代可能沒被附著到」。
   */
  getRearmErrors(): readonly CdpError[]
  /**
   * 訂閱每一則 debugger message（裁決 1）：含 Target.attachedToTarget／
   * detachedFromTarget（cdp.ts 自己處理完後照樣廣播）。listener 依註冊順序
   * 同步呼叫；一個丟例外不影響其他 listener（例外交給 AttachCdpOptions.onListenerError）。
   * 主 target 的事件 sessionId 為 undefined（Electron 給的空字串在這裡轉掉）。
   * detach() 之後不再廣播；已註冊的 listener 由呼叫端自己解除，cdp.ts 不代為清除。
   */
  onEvent(listener: CdpEventListener): Unsubscribe
}

export interface AttachCdpOptions {
  /** listener 丟出的例外交到這裡；沒給就丟掉。listener 例外不得中斷 debugger 的 message 迴圈。 */
  readonly onListenerError?: (error: Error) => void
}

interface AttachedToTargetParams {
  readonly sessionId: string
  readonly targetInfo: { readonly targetId: string; readonly type: string; readonly url: string }
}

interface DetachedFromTargetParams {
  readonly sessionId: string
}

/**
 * 附著 CDP 並開啟 flat 模式的自動附著，且遞迴到任意深度。
 *
 * flatten: true 是必要的：Electron 強制 strict site isolation，跨站 iframe
 * （金流、SSO 登入框）是獨立的 OOPIF target。沒有這個設定，單一 session
 * 看不到那些 iframe，而 agent 會以為自己成功了。
 *
 * 但 flat 模式的 auto-attach 本身不會遞迴：對根 session 發一次
 * Target.setAutoAttach 只會附著到「直接」子代 target；孫代（巢狀在另一個跨站
 * iframe 內部的跨站 iframe，例如 SSO 登入按鈕 widget 裡面又包一層帳號選擇
 * 對話框）不會被附著上。這不是理論疑慮：Spike 3（跨站 iframe 覆蓋率量測）
 * 用 Google 登入按鈕頁面實測到，巢狀的 accounts.google.com iframe 在只呼叫
 * 根層 setAutoAttach 的版本裡一直是 attached: false，導致 agent 會看不到使用者
 * 正在操作的登入框。修法是監聽 Target.attachedToTarget，每收到一個新子
 * session 就對那個子 session 再發一次 Target.setAutoAttach，讓它自己的子代
 * 也被遞迴附著；Puppeteer 與 Chrome DevTools 前端都是這樣處理巢狀 OOPIF 的，
 * 不是本專案自創的技巧。
 */
export async function attachCdp(wc: WebContents, opts?: AttachCdpOptions): Promise<CdpSession> {
  const attachedTargets = new Map<string, AttachedTargetInfo>()
  const rearmErrors: CdpError[] = []
  // Map 的 key 是訂閱時發的流水號，不是 listener 參考本身：同一個函式參考訂閱
  // 兩次要能各自獨立解除，用參考當 key 做不到這件事。
  const listeners = new Map<number, CdpEventListener>()
  let nextListenerId = 0
  let detached = false
  let onMessage: ((event: Event, method: string, params: unknown, sessionId: string) => void) | undefined
  // 這次呼叫是不是真的附著者，決定失敗時能不能 detach：如果進來時已經是別人
  // 附著的（isAttached() 已是 true），這次呼叫從未取得附著權，失敗時 detach
  // 會把那個別人正在用的 session 一起拆掉。
  let weAttached = false

  // 廣播前先把目前的 listener 複製成一份快照再逐一呼叫：某個 listener 在被呼叫
  // 時呼叫 unsubscribe（移除自己或移除排在後面的 listener），動到的是 listeners
  // 這個 Map 本體，不影響這次廣播正在走的快照，所以「迭代時移除」不會跳過
  // 下一個 listener，也不需要額外的索引修正邏輯。
  const broadcast = (method: string, params: unknown, rawSessionId: string): void => {
    const sessionId = rawSessionId === '' ? undefined : rawSessionId
    for (const listener of [...listeners.values()]) {
      try {
        listener(method, params, sessionId)
      } catch (e) {
        opts?.onListenerError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }
  }

  try {
    weAttached = !wc.debugger.isAttached()
    if (weAttached) wc.debugger.attach('1.3')

    const send = async <T,>(method: string, params: object = {}, sessionId?: string): Promise<T> => {
      try {
        return (await wc.debugger.sendCommand(method, params, sessionId)) as T
      } catch (e) {
        throw toCdpError(e)
      }
    }

    const armAutoAttach = (sessionId?: string): Promise<void> =>
      send<void>(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId
      )

    onMessage = (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') {
        const { sessionId: childSessionId, targetInfo } = params as AttachedToTargetParams
        attachedTargets.set(childSessionId, {
          targetId: targetInfo.targetId,
          type: targetInfo.type,
          url: targetInfo.url,
          sessionId: childSessionId,
        })
        // detach() 之後再收到的附著事件不再 re-arm：session 已經在收尾，繼續發
        // 指令只會製造註定失敗的 rearmErrors，沒有意義。
        if (!detached) {
          armAutoAttach(childSessionId).catch((e: unknown) => {
            rearmErrors.push(e instanceof CdpError ? e : toCdpError(e))
          })
        }
      } else if (method === 'Target.detachedFromTarget') {
        const { sessionId: childSessionId } = params as DetachedFromTargetParams
        attachedTargets.delete(childSessionId)
      }
      // cdp.ts 自己處理完後照樣廣播（裁決 1）；detach() 之後不再廣播。
      if (!detached) broadcast(method, params, sessionId)
    }
    wc.debugger.on('message', onMessage)

    await send('Page.enable')
    await send('Runtime.enable')
    await armAutoAttach()

    return {
      send,
      detach: () => {
        detached = true
        if (onMessage) wc.debugger.removeListener('message', onMessage)
        wc.debugger.detach()
      },
      getAttachedTargets: () => Array.from(attachedTargets.values()),
      getRearmErrors: () => [...rearmErrors],
      onEvent: (listener) => {
        const id = nextListenerId++
        listeners.set(id, listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          listeners.delete(id)
        }
      },
    }
  } catch (e) {
    if (onMessage) {
      try {
        wc.debugger.removeListener('message', onMessage)
      } catch {
        // 不蓋掉原始錯誤，移除 listener 失敗就忽略
      }
    }
    if (weAttached) {
      try {
        wc.debugger.detach()
      } catch {
        // 不蓋掉原始錯誤，detach 失敗就忽略
      }
    }
    throw e instanceof CdpError ? e : toCdpError(e)
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

```
$ npx vitest run tests/cdp.test.ts
```

實跑結果：`Test Files  1 passed (1)`、`Tests  16 passed (16)`。同時跑過型別檢查（實跑）：

```
$ npx tsc --noEmit -p tsconfig.json
```

無輸出，0 error。

- [ ] **Step 5: 寫失敗的測試（`tests/view-tools/fake-cdp.test.ts` 完整內容）**

這是 `createFakeCdp()` 自己的測試，寫在 `tests/helpers/fake-cdp.ts` 建立之前，此時 import 會直接失敗（模組不存在）。分三組：`emit`／`onEvent` 的廣播語意（含 unsubscribe 安全性、sessionId 正規化）、`send` 的預錄回應（含 method+sessionId 精確匹配、reject、沒有預錄時的錯誤訊息）、`setAttachedTargets`／`setRearmErrors`／`detach` 的基本讀寫：

```ts
import { describe, it, expect } from 'vitest'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import { CdpError } from '../../src/main/cdp.js'

describe('createFakeCdp: emit / onEvent', () => {
  it('emit 觸發所有已訂閱的 listener，依註冊順序', () => {
    const cdp = createFakeCdp()
    const calls: string[] = []
    cdp.onEvent(() => calls.push('a'))
    cdp.onEvent(() => calls.push('b'))

    cdp.emit('Page.loadEventFired', {})

    expect(calls).toEqual(['a', 'b'])
  })

  it('unsubscribe 之後不再收到 emit', () => {
    const cdp = createFakeCdp()
    const calls: string[] = []
    const unsubscribe = cdp.onEvent(() => calls.push('x'))

    cdp.emit('Page.loadEventFired', {})
    unsubscribe()
    cdp.emit('Page.loadEventFired', {})

    expect(calls).toEqual(['x'])
  })

  it('unsubscribe 在 listener 回呼中呼叫也安全：這次廣播不跳過下一個 listener', () => {
    const cdp = createFakeCdp()
    const calls: string[] = []
    let unsubscribeSecond: () => void = () => {}
    cdp.onEvent(() => {
      calls.push('first')
      unsubscribeSecond()
    })
    unsubscribeSecond = cdp.onEvent(() => calls.push('second'))
    cdp.onEvent(() => calls.push('third'))

    cdp.emit('Page.loadEventFired', {})
    expect(calls).toEqual(['first', 'second', 'third'])

    calls.length = 0
    cdp.emit('Page.loadEventFired', {})
    expect(calls).toEqual(['first', 'third'])
  })

  it('sessionId 省略或空字串都視為主 target，listener 收到 undefined；有值則原樣傳遞', () => {
    const cdp = createFakeCdp()
    const received: (string | undefined)[] = []
    cdp.onEvent((_method, _params, sessionId) => received.push(sessionId))

    cdp.emit('Page.loadEventFired', {})
    cdp.emit('Page.loadEventFired', {}, '')
    cdp.emit('Network.requestWillBeSent', {}, 'child-1')

    expect(received).toEqual([undefined, undefined, 'child-1'])
  })

  it('params 原樣傳給 listener，不做任何轉換', () => {
    const cdp = createFakeCdp()
    let received: unknown
    cdp.onEvent((_method, params) => {
      received = params
    })
    const params = { requestId: 'r1' }

    cdp.emit('Network.requestWillBeSent', params)

    expect(received).toBe(params)
  })
})

describe('createFakeCdp: send 預錄回應', () => {
  it('依 method 預錄回應，send 回傳預錄的值', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }))

    const result = await cdp.send('Page.getLayoutMetrics')

    expect(result).toEqual({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } })
  })

  it('同一個 method 依 sessionId 精確匹配，找不到才退回無 sessionId 的那份', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('DOM.getBoxModel', () => ({ model: { border: 'root' } }))
    cdp.onSend('DOM.getBoxModel', () => ({ model: { border: 'child' } }), 'child-1')

    const rootResult = await cdp.send('DOM.getBoxModel')
    const childResult = await cdp.send('DOM.getBoxModel', undefined, 'child-1')
    const otherSessionFallsBack = await cdp.send('DOM.getBoxModel', undefined, 'other-session')

    expect(rootResult).toEqual({ model: { border: 'root' } })
    expect(childResult).toEqual({ model: { border: 'child' } })
    expect(otherSessionFallsBack).toEqual({ model: { border: 'root' } })
  })

  it('responder 丟例外時 send 回傳的 promise reject', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('DOM.getBoxModel', () => {
      throw new CdpError('找不到節點', '-32000')
    })

    await expect(cdp.send('DOM.getBoxModel')).rejects.toThrow('找不到節點')
  })

  it('沒有預錄回應時 send reject 並在錯誤訊息裡帶 method 名稱', async () => {
    const cdp = createFakeCdp()

    await expect(cdp.send('Runtime.evaluate')).rejects.toThrow(/Runtime\.evaluate/)
  })

  it('帶 sessionId 呼叫但完全沒有預錄時，錯誤訊息裡也帶上 sessionId', async () => {
    const cdp = createFakeCdp()

    await expect(cdp.send('DOM.focus', undefined, 'child-1')).rejects.toThrow(/sessionId=child-1/)
  })

  it('onSend 對同一組 method／sessionId 覆蓋預錄', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Page.navigate', () => ({ frameId: 'f1' }))
    cdp.onSend('Page.navigate', () => ({ frameId: 'f2' }))

    const result = await cdp.send('Page.navigate')

    expect(result).toEqual({ frameId: 'f2' })
  })

  it('send 是 vi.fn()，可以用 toHaveBeenCalledWith 斷言呼叫參數', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Input.dispatchMouseEvent', () => ({}))

    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 }, 'child-1')

    expect(cdp.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 1, y: 2 },
      'child-1'
    )
  })
})

describe('createFakeCdp: attached targets 與 rearm errors', () => {
  it('setAttachedTargets 之後 getAttachedTargets 回同一份內容', () => {
    const cdp = createFakeCdp()
    const targets = [{ targetId: 't1', type: 'iframe', url: 'https://child.example/', sessionId: 'child-1' }]

    cdp.setAttachedTargets(targets)

    expect(cdp.getAttachedTargets()).toEqual(targets)
  })

  it('未呼叫 setAttachedTargets 時預設是空陣列', () => {
    const cdp = createFakeCdp()

    expect(cdp.getAttachedTargets()).toEqual([])
  })

  it('setRearmErrors 之後 getRearmErrors 回同一份內容', () => {
    const cdp = createFakeCdp()
    const errors = [new CdpError('setAutoAttach 失敗', '-32000')]

    cdp.setRearmErrors(errors)

    expect(cdp.getRearmErrors()).toEqual(errors)
  })

  it('未呼叫 setRearmErrors 時預設是空陣列', () => {
    const cdp = createFakeCdp()

    expect(cdp.getRearmErrors()).toEqual([])
  })
})

describe('createFakeCdp: detach', () => {
  it('detach 是 vi.fn()，可以斷言有沒有被呼叫', () => {
    const cdp = createFakeCdp()

    cdp.detach()

    expect(cdp.detach).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 6: 跑測試確認失敗**

在建立 `tests/helpers/fake-cdp.ts` 之前，用上面的測試檔（先只放第一個 `it` 驗證失敗形態即可）跑：

```
$ npx vitest run tests/view-tools/fake-cdp.test.ts
```

實跑結果（已實跑）：`Error: Cannot find module '../helpers/fake-cdp.js' imported from .../tests/view-tools/fake-cdp.test.ts`，`Test Files  1 failed (1)`，`Tests  no tests`。符合預期：模組還不存在。

- [ ] **Step 7: 最小實作（`tests/helpers/fake-cdp.ts` 完整內容）**

```ts
import { vi } from 'vitest'
import type { AttachedTargetInfo, CdpError, CdpEventListener, CdpSession, Unsubscribe } from '../../src/main/cdp.js'

/**
 * send 的預錄回應。responder 可以直接丟例外（同步）或回傳 Promise.reject(...)，
 * 兩種都會讓 send() 回傳的 promise reject，模擬 CDP 指令失敗。
 */
export type SendResponder = (params: object | undefined, sessionId: string | undefined) => unknown

export interface FakeCdp extends CdpSession {
  /** vi.fn()：斷言呼叫次數與參數用，例如 expect(cdp.send).toHaveBeenCalledWith(...)。 */
  readonly send: CdpSession['send'] & ReturnType<typeof vi.fn>
  readonly detach: CdpSession['detach'] & ReturnType<typeof vi.fn>
  /**
   * 預錄一個 method 的回應。有給 sessionId 時只匹配那個 sessionId 的呼叫；
   * 同一個 method 可以分別給「無 sessionId」與「特定 sessionId」兩份預錄，
   * 呼叫時先找 sessionId 精確匹配，找不到才退回無 sessionId 的那份。
   * 呼叫端可以呼叫多次覆蓋同一組 method／sessionId 的預錄。
   */
  onSend(method: string, responder: SendResponder, sessionId?: string): void
  /**
   * 觸發目前所有已訂閱的 onEvent listener，語意與 CdpSession.onEvent 收到的
   * 廣播一致：sessionId 省略或為空字串都視為主 target，listener 收到 undefined。
   */
  emit(method: string, params: unknown, sessionId?: string): void
  setAttachedTargets(targets: readonly AttachedTargetInfo[]): void
  setRearmErrors(errors: readonly CdpError[]): void
}

/**
 * Task 1 產出，Task 5、6、8、9、10 共用的假 CdpSession。
 * 形狀照契約 §14：不重寫，各 task 一律 import 這個。
 */
export function createFakeCdp(): FakeCdp {
  let attachedTargets: readonly AttachedTargetInfo[] = []
  let rearmErrors: readonly CdpError[] = []
  const responders = new Map<string, SendResponder>()
  // Map 的 key 是訂閱時發的流水號，跟 cdp.ts 本體的作法一致：unsubscribe 用
  // id 而不是函式參考，同一個函式參考訂閱兩次也能各自獨立解除。
  const listeners = new Map<number, CdpEventListener>()
  let nextListenerId = 0

  const responderKey = (method: string, sessionId?: string): string =>
    sessionId === undefined ? method : `${method}::${sessionId}`

  const onSend = (method: string, responder: SendResponder, sessionId?: string): void => {
    responders.set(responderKey(method, sessionId), responder)
  }

  const send = vi.fn(async (method: string, params?: object, sessionId?: string) => {
    const specific = sessionId === undefined ? undefined : responders.get(responderKey(method, sessionId))
    const responder = specific ?? responders.get(responderKey(method))
    if (!responder) {
      throw new Error(
        `createFakeCdp: send 沒有預錄 ${method}${sessionId === undefined ? '' : ` (sessionId=${sessionId})`} 的回應，請先呼叫 onSend 設定`
      )
    }
    return responder(params, sessionId)
  }) as unknown as CdpSession['send'] & ReturnType<typeof vi.fn>

  const detach = vi.fn(() => {}) as unknown as CdpSession['detach'] & ReturnType<typeof vi.fn>

  const onEvent = (listener: CdpEventListener): Unsubscribe => {
    const id = nextListenerId++
    listeners.set(id, listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(id)
    }
  }

  // 廣播前先複製一份快照：跟 cdp.ts 本體同樣的理由，某個 listener 在回呼中
  // unsubscribe 不會影響這次正在走的快照，不會跳過下一個 listener。
  const emit = (method: string, params: unknown, sessionId?: string): void => {
    const normalized = sessionId === undefined || sessionId === '' ? undefined : sessionId
    for (const listener of [...listeners.values()]) {
      listener(method, params, normalized)
    }
  }

  return {
    send,
    detach,
    getAttachedTargets: () => attachedTargets,
    getRearmErrors: () => rearmErrors,
    onEvent,
    onSend,
    emit,
    setAttachedTargets: (targets) => {
      attachedTargets = [...targets]
    },
    setRearmErrors: (errors) => {
      rearmErrors = [...errors]
    },
  }
}
```

- [ ] **Step 8: 跑測試確認通過**

```
$ npx vitest run tests/cdp.test.ts tests/view-tools/fake-cdp.test.ts
```

實跑結果（已實跑，含 Step 5 的完整測試檔，非只有第一個 `it`）：`Test Files  2 passed (2)`、`Tests  33 passed (33)`（`tests/cdp.test.ts` 16 個、`tests/view-tools/fake-cdp.test.ts` 17 個）。另外跑過型別檢查與全專案測試（皆已實跑）：

```
$ npx tsc --noEmit -p tsconfig.json
```

無輸出，0 error。

```
$ npx vitest run
```

`Test Files  26 passed (26)`、`Tests  512 passed (512)`：既有 25 個測試檔全部維持綠燈，新增的 `tests/view-tools/fake-cdp.test.ts` 是第 26 個檔。

- [ ] **Step 9: 突變測試（四個，皆已在 worktree 實跑）**

每個突變：改 `src/main/cdp.ts` 的 `broadcast` 或 `onMessage`，跑 `npx vitest run tests/cdp.test.ts`，貼出變紅的測試名稱，還原，確認回綠。

**突變 1：把 listener 例外隔離拿掉**（對應「一個丟例外就中斷後面的」這個盲點）。把：

```ts
    for (const listener of [...listeners.values()]) {
      try {
        listener(method, params, sessionId)
      } catch (e) {
        opts?.onListenerError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }
```

改成：

```ts
    for (const listener of [...listeners.values()]) {
      listener(method, params, sessionId)
    }
```

結果：`一個 listener 丟例外不影響其他 listener，例外交給 onListenerError` 變紅，`Error: 第一個 listener 壞了` 直接從 `broadcast` 拋出中斷迴圈。還原後 16 個測試回綠。

**突變 2：sessionId 為 `''` 時沒轉成 undefined**。把 `broadcast` 開頭的：

```ts
    const sessionId = rawSessionId === '' ? undefined : rawSessionId
```

改成：

```ts
    const sessionId = rawSessionId
```

結果：`主 target 事件的 sessionId（空字串）轉成 undefined，子 session 事件的 sessionId 原樣傳遞` 變紅，`expected [ '', 'child-1' ] to deeply equal [ undefined, 'child-1' ]`。還原後回綠。

**突變 3：拿掉廣播前的快照複製**（unsubscribe 在回呼中呼叫時跳過下一個 listener）。把：

```ts
    for (const listener of [...listeners.values()]) {
```

改成：

```ts
    for (const listener of listeners.values()) {
```

結果：`unsubscribe 在 listener 回呼中呼叫也安全：迭代時移除不跳過下一個 listener` 變紅，`expected [ 'first', 'third' ] to deeply equal [ 'first', 'second', 'third' ]`：第一個 listener 在回呼中把第二個 unsubscribe 之後，Map 的原生迭代器直接跳過還沒走到的第二個 key（Map 刪除尚未走訪的 key 不會出現在這次迭代），沒有快照就攔不住。還原後回綠。

**突變 4：`detach()` 之後仍然廣播**。把：

```ts
      // cdp.ts 自己處理完後照樣廣播（裁決 1）；detach() 之後不再廣播。
      if (!detached) broadcast(method, params, sessionId)
```

改成：

```ts
      // cdp.ts 自己處理完後照樣廣播（裁決 1）；detach() 之後不再廣播。
      broadcast(method, params, sessionId)
```

結果：`detach() 之後不再廣播（detached 旗標本身擋下，繞過 removeListener 直接呼叫監聽器本體也一樣）` 變紅，`expected [ 'x' ] to deeply equal []`。還原後回綠，`diff` 對照原始檔確認逐字一致。

四次都在同一個 worktree 依序做（改、跑、貼、還原、跑），每次還原後都跑過 `npx vitest run tests/cdp.test.ts` 確認 16 個測試回到全綠才進行下一個突變。

- [ ] **Step 10: 提交**

```
git add src/main/cdp.ts tests/cdp.test.ts tests/helpers/fake-cdp.ts tests/view-tools/fake-cdp.test.ts
git commit -m "feat: cdp.ts 加事件訂閱與 sessionId，補假 CDP helper"
```
