### Task 7: 交接狀態（handoff.ts）

`request_handoff` 需要的核心行為是「同時只有一筆等待，且不管使用者按下、逾時、還是對話收尾，都要走到同一個乾淨的結束狀態」。這個模組故意不碰 CDP、不碰 renderer、不知道 toolUseId 從哪裡來（那是 server.ts 的事），只做一件事：一個靠注入的 `MergerClock` 計時的單一 pending 狀態機。純粹到可以完全用 `manualClock()` 測完，不需要假的 `CdpSession` 或 `WebContentsView`。

實作上只有一個可變變數 `active: ActiveWait | null`，把「目前這筆等待」的所有可變狀態（`resolve` 回呼、計時器 handle、`AbortSignal` 監聽器）包成一個物件。三條結束路徑（使用者按下的 `done`、逾時的計時器回呼、收尾的 `abortAll`）全部都交給同一個私有函式 `finish(outcome)` 處理：清計時器、解除 abort 監聽、把 `active` 設回 `null`，最後才 `resolve`。這是刻意的「好品味」設計：如果三條路各自寫一份清理邏輯，只要漏寫一行（例如 `abortAll` 忘了清計時器），舊的逾時計時器就會在下一筆全新的 pending 進行到一半時把它誤判成逾時。清理邏輯只留一份之後，這種錯誤在正常寫法下根本不會發生；Step 5 的突變測試會刻意繞過 `finish`、手動內聯清理邏輯來重現這個錯誤，證明測試真的在測「清理有沒有做全」而不是巧合過關。

`begin()` 沒有寫成 `async function`：如果宣告成 `async`，回傳值會被 JS runtime 多包一層 promise，需要多一個 microtask tick 才會 resolve。這在一般情境下看不出差異，但 Step 1 有兩個測試要在「到期前一毫秒」與「到期那一毫秒」這兩個精確時間點上斷言 resolve 與否（用 `manualClock` 的到期排序，不能只靠「全部觸發」），多出來的那一個 tick 會讓斷言在 `await Promise.resolve()` 只 flush 一輪微任務時看起來像沒有 resolve，測試會不穩定地紅。實測過（見 Step 4）：改成直接回傳 `Promise.reject(...)` ／`Promise.resolve(...)` ／`new Promise(...)`，不用 `async`／`await` 語法糖，這兩個測試才穩定綠。

`readToolUseId` 的三層防呆（`extra` 是不是物件、`_meta` 是不是物件、值是不是非空字串）逐字對應契約 §9.4 裁決 8 的定義。這裡不假設 `extra` 的形狀，因為它是 MCP SDK 的 `RequestHandlerExtra`，型別上只承諾很少東西；讀不到就回 `null`，由 server.ts（Task 10）決定要不要丟 `ViewToolError(MSG.handoffNoId)`。

裁決 31（修訂）：`request_handoff` 的 tool-use 事件一進對話流，fold 就會把 HandoffCard 畫出來，按鈕立刻可按；但 MCP handler（也就是 `begin()` 真正被呼叫的時間點）要等 SDK 排到這個工具才會執行，兩者之間有一段落差。使用者若在這段落差裡就按下「我好了」，`done()` 收到的 toolUseId 還沒有對應的 pending，這種情況新增一個 `earlyDone` 集合記住它（`Set<string>`，插入順序即走訪順序，天生就是 FIFO），不再像原本那樣當成錯誤 `logError`。等真正的 `begin()` 帶著同一個 id 進來，第一件事就是查 `earlyDone`：命中就移除並立即回 `{ outcome: 'done' }`，連 pending 都不建立。這個查詢刻意排在 `handoffBusy` 檢查之前：早到的 done 跟「目前是否還有別筆 pending 在等」是兩件事，即使當下真的有別筆 pending 在等，一筆已經確定完成的交接也不該被那筆無關的 busy 狀態卡住。`earlyDone` 設 `EARLY_DONE_MAX = 8` 的上限並在超過時淘汰最舊的一筆，是防止外部（例如重放事件或測試誤用）灌爆這個集合；`abortAll()` 收尾時整個清空，理由跟清 pending 一樣：對話結束後任何殘留狀態都不該延續到下一個對話。這個改動也讓 `logError` 這個注入的回呼在 `done()` 的兩條舊分支裡都不再被呼叫，`createHandoff` 的簽章仍然照契約保留這個參數（下游呼叫端維持原樣傳入即可），只是目前程式碼路徑用不到它。

**Files:**
- Create `src/main/view-tools/handoff.ts`
- Test: `tests/view-tools/handoff.test.ts`

**Interfaces:**

Consumes：
- `src/main/view-tools/types.ts`（Task 0）：`HandoffPending { readonly toolUseId: string; readonly reason: string; readonly askedAt: number }`、`HandoffOutcome = 'done' | 'timeout' | 'session-ended'`
- `src/main/view-tools/errors.ts`（Task 0）：`ViewToolError`（`class ViewToolError extends Error { readonly name = 'ViewToolError' }`）、`MSG.handoffBusy(reason: string): string`
- `src/main/agent-host.ts`（現有程式碼，第 96 到 100 行）：`interface MergerClock { readonly now: () => number; readonly setTimer: (fn: () => void, ms: number) => unknown; readonly clearTimer: (handle: unknown) => void }`
- `tests/helpers/manual-clock.ts`（Task 0）：`function manualClock(start = 0): { readonly clock: MergerClock; advance(ms: number): void; now(): number }`（到期排序：`advance(ms)` 依 `due <= now` 由小到大逐一觸發，不是一次觸發全部）

Produces（契約 §9.4 全部匯出，含裁決 31 的修訂）：
```ts
export const HANDOFF_TIMEOUT_MS = 10 * 60_000
export const EARLY_DONE_MAX = 8
export interface HandoffWaitResult { readonly outcome: HandoffOutcome }
export interface Handoff {
  pending(): HandoffPending | null
  begin(toolUseId: string, reason: string, signal?: AbortSignal): Promise<HandoffWaitResult>
  done(toolUseId: string): void
  abortAll(): void
}
export function createHandoff(clock: MergerClock, logError: (error: Error) => void): Handoff
export function readToolUseId(extra: unknown): string | null
```
下游：Task 9（`controller.requestHandoff` 呼叫 `handoff.begin`）、Task 10（`server.ts` 用 `handoffDone`／`abortPending` 包 `handoff.done`／`handoff.abortAll`，並用 `readToolUseId` 從 handler 的 `extra` 取 id）、Task 13（`ipc-bridge.ts` 的 `IPC.handoffDone` handler 轉呼叫 `ViewTools.handoffDone`，最終落到 `handoff.done`）。

- [ ] **Step 1: 寫失敗的測試**

建立 `tests/view-tools/handoff.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { manualClock } from '../helpers/manual-clock.js'
import {
  createHandoff,
  readToolUseId,
  HANDOFF_TIMEOUT_MS,
  EARLY_DONE_MAX,
  type HandoffWaitResult,
} from '../../src/main/view-tools/handoff.js'
import { ViewToolError, MSG } from '../../src/main/view-tools/errors.js'

/** 每個測試各自的 clock、logError 收集器與 handoff 實例，互不共用狀態。 */
function setup() {
  const { clock, advance } = manualClock()
  const errors: Error[] = []
  const logError = (error: Error): void => {
    errors.push(error)
  }
  const handoff = createHandoff(clock, logError)
  return { clock, advance, errors, handoff }
}

describe('createHandoff', () => {
  it('pending() 初始為 null', () => {
    const { handoff } = setup()
    expect(handoff.pending()).toBeNull()
  })

  it('begin() 建立 pending，reason 與 askedAt 依 clock.now()（非建構時間）', () => {
    const { advance, handoff } = setup()
    advance(1000)
    const wait = handoff.begin('t1', '需要登入')
    void wait.catch(() => {})
    expect(handoff.pending()).toEqual({ toolUseId: 't1', reason: '需要登入', askedAt: 1000 })
    handoff.done('t1')
  })

  it('已有 pending 時第二次 begin 立刻拒絕（handoffBusy），第一筆不受影響', async () => {
    const { handoff } = setup()
    const wait1 = handoff.begin('t1', '原因A')
    await expect(handoff.begin('t2', '原因B')).rejects.toThrow(ViewToolError)
    await expect(handoff.begin('t2', '原因B')).rejects.toThrow(MSG.handoffBusy('原因A'))
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1', reason: '原因A' }))
    handoff.done('t1')
    await expect(wait1).resolves.toEqual({ outcome: 'done' })
  })

  it('done 在逾時前 resolve done，timer 已清：之後 advance 不再第二次 resolve 或 logError', async () => {
    const { advance, handoff, errors } = setup()
    const spy = vi.fn()
    const wait = handoff.begin('t1', 'x')
    void wait.then(spy)
    handoff.done('t1')
    await expect(wait).resolves.toEqual({ outcome: 'done' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(handoff.pending()).toBeNull()
    advance(HANDOFF_TIMEOUT_MS)
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(0)
  })

  it('done 傳入不符 pending 的 id（裁決 31）：記進 earlyDone、不 logError，原本那筆 pending 不受影響', async () => {
    const { handoff, errors } = setup()
    const wait = handoff.begin('t1', 'x')
    handoff.done('other-id')
    expect(errors).toHaveLength(0)
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1' }))
    handoff.done('t1')
    await expect(wait).resolves.toEqual({ outcome: 'done' })
  })

  it('done 在沒有 pending 時（裁決 31）：記進 earlyDone、不 logError、不丟例外', () => {
    const { handoff, errors } = setup()
    expect(() => handoff.done('nope')).not.toThrow()
    expect(errors).toHaveLength(0)
  })

  it('早到的 done（裁決 31）：之後 begin 帶同一個 id 立即回 done，不建立 pending', async () => {
    const { handoff, errors } = setup()
    handoff.done('t1') // handler 還沒開始跑，卡片已經先被按過
    expect(handoff.pending()).toBeNull()
    await expect(handoff.begin('t1', '理由')).resolves.toEqual({ outcome: 'done' })
    expect(handoff.pending()).toBeNull() // 全程沒建立過 pending
    expect(errors).toHaveLength(0)
  })

  it('早到的 done 用過一次就消耗掉：同一個 id 第二次 begin 是正常新的一筆', async () => {
    const { handoff } = setup()
    handoff.done('t1')
    await expect(handoff.begin('t1', '理由A')).resolves.toEqual({ outcome: 'done' })
    const wait2 = handoff.begin('t1', '理由B')
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1', reason: '理由B' }))
    handoff.done('t1')
    await expect(wait2).resolves.toEqual({ outcome: 'done' })
  })

  it('earlyDone 命中優先於 handoffBusy：即使目前有別筆 pending 也能立即回 done', async () => {
    const { handoff } = setup()
    const wait1 = handoff.begin('t1', '原因A') // 目前唯一的 pending
    handoff.done('t2') // 跟 t1 無關，先記進 earlyDone
    await expect(handoff.begin('t2', '原因B')).resolves.toEqual({ outcome: 'done' })
    // t1 這筆完全不受影響，仍在等
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1' }))
    handoff.done('t1')
    await expect(wait1).resolves.toEqual({ outcome: 'done' })
  })

  it('earlyDone 有 FIFO 上限 EARLY_DONE_MAX：超過時淘汰最舊的一筆', async () => {
    const { handoff } = setup()
    for (let i = 0; i <= EARLY_DONE_MAX; i += 1) {
      handoff.done(`id-${i}`) // 共 EARLY_DONE_MAX + 1 筆，最舊的 id-0 應該被淘汰
    }
    // 被淘汰的 id-0：begin 走正常流程，建立真正的 pending（不是立即 done）。
    const waitEvicted = handoff.begin('id-0', '正常一筆')
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 'id-0' }))
    handoff.done('id-0')
    await expect(waitEvicted).resolves.toEqual({ outcome: 'done' })

    // 還留著的最舊一筆 id-1：立即回 done。
    await expect(handoff.begin('id-1', 'x')).resolves.toEqual({ outcome: 'done' })
    // 最新一筆 id-<EARLY_DONE_MAX> 也還在。
    await expect(handoff.begin(`id-${EARLY_DONE_MAX}`, 'x')).resolves.toEqual({ outcome: 'done' })
  })

  it('abortAll 清空 earlyDone（裁決 31）：清空後同一個 id 的 begin 不再立即回 done', async () => {
    const { handoff } = setup()
    handoff.done('t1')
    handoff.abortAll()
    const wait = handoff.begin('t1', '理由')
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1', reason: '理由' }))
    handoff.done('t1')
    await expect(wait).resolves.toEqual({ outcome: 'done' })
  })

  it('逾時：到 HANDOFF_TIMEOUT_MS 前不 resolve（到期排序，不是 advance 就全部觸發）', async () => {
    const { advance, handoff } = setup()
    const wait = handoff.begin('t1', 'x')
    let settled: HandoffWaitResult | undefined
    void wait.then((r) => {
      settled = r
    })
    advance(HANDOFF_TIMEOUT_MS - 1)
    await Promise.resolve()
    expect(settled).toBeUndefined()
    expect(handoff.pending()).not.toBeNull()
    advance(1)
    await Promise.resolve()
    expect(settled).toEqual({ outcome: 'timeout' })
    expect(handoff.pending()).toBeNull()
  })

  it('逾時後 pending 已清：之後可以再 begin（不會被舊 pending 卡成 handoffBusy）', async () => {
    const { advance, handoff } = setup()
    const wait1 = handoff.begin('t1', 'x')
    advance(HANDOFF_TIMEOUT_MS)
    await expect(wait1).resolves.toEqual({ outcome: 'timeout' })
    const wait2 = handoff.begin('t2', 'y')
    handoff.done('t2')
    await expect(wait2).resolves.toEqual({ outcome: 'done' })
  })

  it('abortAll 對沒有 pending 時是 no-op：不丟例外、不 logError', () => {
    const { handoff, errors } = setup()
    expect(() => handoff.abortAll()).not.toThrow()
    expect(errors).toHaveLength(0)
    expect(handoff.pending()).toBeNull()
  })

  it('abortAll 對有 pending 時 resolve session-ended 並清 timer：之後 advance 不再 logError 或第二次 resolve', async () => {
    const { advance, handoff, errors } = setup()
    const spy = vi.fn()
    const wait = handoff.begin('t1', 'x')
    void wait.then(spy)
    handoff.abortAll()
    await expect(wait).resolves.toEqual({ outcome: 'session-ended' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(handoff.pending()).toBeNull()
    advance(HANDOFF_TIMEOUT_MS)
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(0)
  })

  it('abortAll 之後開新的 begin：舊 pending 的逾時 timer 不能提前結束新的 pending（驗證 clearTimer 有實際生效）', async () => {
    const { advance, handoff } = setup()
    const wait1 = handoff.begin('t1', 'x') // 到期於 now=0+HANDOFF_TIMEOUT_MS
    advance(100)
    handoff.abortAll()
    await expect(wait1).resolves.toEqual({ outcome: 'session-ended' })

    const wait2 = handoff.begin('t2', 'y') // 到期於 now=100+HANDOFF_TIMEOUT_MS
    let settled2: HandoffWaitResult | undefined
    void wait2.then((r) => {
      settled2 = r
    })

    // 推進到舊 timer 原本的到期點（HANDOFF_TIMEOUT_MS），還沒到新 timer 的到期點。
    advance(HANDOFF_TIMEOUT_MS - 100)
    await Promise.resolve()
    expect(settled2).toBeUndefined()
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't2' }))

    advance(100)
    await Promise.resolve()
    expect(settled2).toEqual({ outcome: 'timeout' })
  })

  it('signal 建立時已 aborted：立即 session-ended，不建立 pending', async () => {
    const { handoff } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(handoff.begin('t1', 'x', controller.signal)).resolves.toEqual({ outcome: 'session-ended' })
    expect(handoff.pending()).toBeNull()
  })

  it('signal 事後 abort：resolve session-ended 並清 pending 與 timer', async () => {
    const { advance, handoff, errors } = setup()
    const controller = new AbortController()
    const wait = handoff.begin('t1', 'x', controller.signal)
    controller.abort()
    await expect(wait).resolves.toEqual({ outcome: 'session-ended' })
    expect(handoff.pending()).toBeNull()
    advance(HANDOFF_TIMEOUT_MS)
    await Promise.resolve()
    expect(errors).toHaveLength(0)
  })
})

describe('readToolUseId', () => {
  it('extra 不是物件回 null', () => {
    expect(readToolUseId(undefined)).toBeNull()
    expect(readToolUseId(null)).toBeNull()
    expect(readToolUseId('x')).toBeNull()
    expect(readToolUseId(42)).toBeNull()
  })

  it('_meta 缺回 null', () => {
    expect(readToolUseId({})).toBeNull()
  })

  it('_meta 不是物件回 null', () => {
    expect(readToolUseId({ _meta: 'nope' })).toBeNull()
    expect(readToolUseId({ _meta: null })).toBeNull()
  })

  it('id 不是字串回 null', () => {
    expect(readToolUseId({ _meta: { 'claudecode/toolUseId': 123 } })).toBeNull()
  })

  it('id 是空字串回 null', () => {
    expect(readToolUseId({ _meta: { 'claudecode/toolUseId': '' } })).toBeNull()
  })

  it('正常取出 toolUseId', () => {
    expect(readToolUseId({ _meta: { 'claudecode/toolUseId': 'abc-123' } })).toBe('abc-123')
  })
})
```

（共 24 個測試：`createHandoff` 18 個、`readToolUseId` 6 個。裁決 31 新增 5 個：早到的 done 立即回 done、早到的 done 用過即消耗、earlyDone 優先於 handoffBusy、FIFO 上限淘汰最舊、abortAll 清空 earlyDone；另外把原本兩個「忽略並 logError」的舊測試改寫成符合新行為，不是新增。）

- [ ] **Step 2: 跑測試確認失敗**

此時 `src/main/view-tools/handoff.ts` 還不存在，`types.ts`／`errors.ts`／`tests/helpers/manual-clock.ts` 已由 Task 0 產出（上游）。跑：

```bash
npx vitest run tests/view-tools/handoff.test.ts
```

預期失敗，錯誤是找不到模組：

```
Error: Cannot find module '../../src/main/view-tools/handoff.js' imported from tests/view-tools/handoff.test.ts
```

不是斷言失敗，因為實作檔案還沒建立。

（已驗證：撰寫本 task 時 Task 0 尚未定稿為 task 檔，其 worktree 已有實作，於是複製 `types.ts`／`errors.ts`／`tests/helpers/manual-clock.ts`（不是自己寫的 stub）到本 task 的 worktree。把 Step 3 寫好的 `handoff.ts` 暫時移走後跑上面的指令，錯誤訊息與上面逐字相同；移回後全綠。裁決 31 修訂時原 worktree 已刪除，改用 `git worktree add <scratchpad>/wt-7 00213ba` 重建；這次 Task 0 已定稿為 `task-0.md`，`types.ts`／`errors.ts`／`tests/helpers/manual-clock.ts` 三份程式碼直接照抄它 Step 12／14／17 的最終程式碼區塊，逐字比對與先前複製自其 worktree 的版本一致。）

- [ ] **Step 3: 最小實作**

建立 `src/main/view-tools/handoff.ts`：

```ts
/**
 * 交接等待（契約 §9.4）。單一 pending 的狀態機：同時只允許一筆 request_handoff
 * 在等使用者。使用者按下、逾時（`HANDOFF_TIMEOUT_MS`）、或收尾（`abortAll`／
 * `signal` 中止）三條路都會 resolve 同一個 promise，且都會清掉 pending 與計時器，
 * 讓下一次 `begin()` 可以重新開始。不碰 CDP、不碰 renderer，純狀態機加注入的
 * `MergerClock`（裁決 8：`toolUseId` 由呼叫端從 handler 的 `extra` 取出後傳進來）。
 */

import type { MergerClock } from '../agent-host.js'
import { MSG, ViewToolError } from './errors.js'
import type { HandoffOutcome, HandoffPending } from './types.js'

export const HANDOFF_TIMEOUT_MS = 10 * 60_000
export const EARLY_DONE_MAX = 8

export interface HandoffWaitResult {
  readonly outcome: HandoffOutcome
}

export interface Handoff {
  pending(): HandoffPending | null
  /**
   * 工具處理函式呼叫。建立以 toolUseId 為 key 的 pending 並等待。
   * 已有 pending → 丟 ViewToolError(MSG.handoffBusy(existing.reason))。
   * 使用者按下 → { outcome: 'done' }；逾時 → { outcome: 'timeout' }；signal 中止 → { outcome: 'session-ended' }。
   */
  begin(toolUseId: string, reason: string, signal?: AbortSignal): Promise<HandoffWaitResult>
  /**
   * renderer 的 handoff:done。id 等於 pending 的 → 以 done resolve。
   * 否則記進 earlyDone（最多 EARLY_DONE_MAX 個，滿了淘汰最舊的），不 logError：
   * 同一則訊息帶多個工具時，卡片按鈕會比 handler 早出現，使用者先按了就先記著（裁決 31）。
   * begin() 帶的 id 已在 earlyDone → 移除並立即回 { outcome: 'done' }。
   */
  done(toolUseId: string): void
  /** 收尾。pending 以 session-ended resolve；earlyDone 清空。 */
  abortAll(): void
}

/** 目前這一筆等待的所有可變狀態，全部包在一個物件裡，resolve 後整包丟棄。 */
interface ActiveWait {
  readonly pending: HandoffPending
  readonly resolve: (result: HandoffWaitResult) => void
  readonly timerHandle: unknown
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

export function createHandoff(clock: MergerClock, logError: (error: Error) => void): Handoff {
  let active: ActiveWait | null = null
  // 裁決 31：done() 對不上目前 pending 的 id 先記在這裡（FIFO，插入順序即 Set 的走訪順序），
  // 等對應的 begin() 真的呼叫時直接命中，不必等一輪逾時或誤判成別筆訊息。
  const earlyDone = new Set<string>()

  /** 三條收尾路徑（done／timeout／abortAll）共用：清 timer、解除 abort 監聽、清 pending，最後才 resolve。 */
  function finish(outcome: HandoffOutcome): void {
    const current = active
    if (current === null) return
    active = null
    clock.clearTimer(current.timerHandle)
    if (current.signal !== undefined && current.onAbort !== undefined) {
      current.signal.removeEventListener('abort', current.onAbort)
    }
    current.resolve({ outcome })
  }

  return {
    pending: () => (active === null ? null : active.pending),

    begin(toolUseId, reason, signal) {
      // 裁決 31：使用者搶先按過（handler 還沒開始跑，卡片已經先顯示出來），直接視為完成，
      // 不佔用 pending 名額，也不受目前是否有別筆 pending（handoffBusy）影響。
      if (earlyDone.has(toolUseId)) {
        earlyDone.delete(toolUseId)
        return Promise.resolve({ outcome: 'done' })
      }
      if (active !== null) {
        return Promise.reject(new ViewToolError(MSG.handoffBusy(active.pending.reason)))
      }
      if (signal?.aborted === true) {
        return Promise.resolve({ outcome: 'session-ended' })
      }
      return new Promise<HandoffWaitResult>((resolve) => {
        const timerHandle = clock.setTimer(() => finish('timeout'), HANDOFF_TIMEOUT_MS)
        const onAbort = signal === undefined ? undefined : () => finish('session-ended')
        if (signal !== undefined && onAbort !== undefined) {
          signal.addEventListener('abort', onAbort)
        }
        active = {
          pending: { toolUseId, reason, askedAt: clock.now() },
          resolve,
          timerHandle,
          signal,
          onAbort,
        }
      })
    },

    done(toolUseId) {
      if (active !== null && active.pending.toolUseId === toolUseId) {
        finish('done')
        return
      }
      // 裁決 31：不再 logError。記進 earlyDone，滿了（超過 EARLY_DONE_MAX）淘汰最舊的一筆；
      // Set 的走訪順序等於插入順序，第一個元素就是最舊的。重複呼叫同一個 id 不會移動它的位置。
      earlyDone.add(toolUseId)
      if (earlyDone.size > EARLY_DONE_MAX) {
        const oldest = earlyDone.values().next().value
        if (oldest !== undefined) earlyDone.delete(oldest)
      }
    },

    abortAll() {
      earlyDone.clear()
      if (active === null) return
      finish('session-ended')
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 從 MCP handler 的 `extra._meta['claudecode/toolUseId']` 取出 toolUseId（裁決 8）。
 * `extra` 不是物件、`_meta` 不是物件、或該欄位不是非空字串都回 null；server.ts
 * 收到 null 時丟 `ViewToolError(MSG.handoffNoId)`（那段邏輯不在這裡，這裡只負責讀值）。
 */
export function readToolUseId(extra: unknown): string | null {
  if (!isRecord(extra)) return null
  const meta = extra['_meta']
  if (!isRecord(meta)) return null
  const id = meta['claudecode/toolUseId']
  return typeof id === 'string' && id.length > 0 ? id : null
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/handoff.test.ts
npx tsc --noEmit -p tsconfig.json
```

已驗證：24 個測試全綠，`tsc --noEmit` 對 `handoff.ts`／`handoff.test.ts` 0 error。

```
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

補充驗證覆蓋率（同一 worktree，只量這個檔案）：

```bash
npx vitest run tests/view-tools/handoff.test.ts --coverage --coverage.include='src/main/view-tools/handoff.ts'
```

```
File        | % Stmts | % Branch | % Funcs | % Lines
------------|---------|----------|---------|--------
handoff.ts  |   97.95 |    95.00 |     100 |     100
```

沒蓋到的兩條分支：`finish()` 開頭 `if (current === null) return` 的早退，以及 `done()` 裡 `earlyDone` 淘汰邏輯的 `if (oldest !== undefined) earlyDone.delete(oldest)`。兩者都是防呆用的，正常流程下不會真的走到：前者的理由同前一版（三個呼叫端都先判斷過 `active` 才叫 `finish`）；後者是因為 `earlyDone.values().next().value` 在 TypeScript 的型別是 `string | undefined`（Set 迭代器的通用型別），但這裡已經先確認 `size > EARLY_DONE_MAX >= 1`，邏輯上一定拿得到值，只是型別系統不知道。這兩條分支正是 Step 5 突變測試刻意繞過的地方。

- [ ] **Step 5: 突變測試**

六個突變都已在 worktree 實跑：改成錯誤版本、跑測試、貼變紅的測試名稱、還原、確認回綠。突變 1 與突變 3 動到的程式碼（`finish` 與逾時 timer 的清理）裁決 31 沒有改動，沿用原撰寫時的實跑記錄；突變 2 的 `done()` 已改寫成符合新行為的版本重新實跑；突變 4、5、6 是裁決 31 新增的 `earlyDone` 行為專用。

**突變 1：逾時 timer 忘了清 `active`（只 resolve 不清 pending）。**

把 `begin()` 裡的 `clock.setTimer(() => finish('timeout'), HANDOFF_TIMEOUT_MS)` 換成手動內聯、故意漏掉 `active = null`：

```ts
const timerHandle = clock.setTimer(() => {
  const current = active
  if (current === null) return
  clock.clearTimer(current.timerHandle)
  current.resolve({ outcome: 'timeout' })
  // 漏了 active = null
}, HANDOFF_TIMEOUT_MS)
```

跑 `npx vitest run tests/view-tools/handoff.test.ts`，變紅：

```
× 逾時：到 HANDOFF_TIMEOUT_MS 前不 resolve（到期排序，不是 advance 就全部觸發）
× 逾時後 pending 已清：之後可以再 begin（不會被舊 pending 卡成 handoffBusy）
```

第二個測試的錯誤是 `wait2` 被 `ViewToolError: 已有一筆交接等待中（x），請等使用者完成` 拒絕，符合預期：`pending` 沒清乾淨，第二次 `begin` 誤判成還有一筆在等。還原後全綠。

**突變 2：`done()` 忘了比對 `toolUseId`（只要有 pending 就 resolve）。**

```ts
done(toolUseId) {
  // 少了 && active.pending.toolUseId === toolUseId
  if (active !== null) {
    finish('done')
    return
  }
  earlyDone.add(toolUseId)
  if (earlyDone.size > EARLY_DONE_MAX) {
    const oldest = earlyDone.values().next().value
    if (oldest !== undefined) earlyDone.delete(oldest)
  }
},
```

變紅：

```
× done 傳入不符 pending 的 id（裁決 31）：記進 earlyDone、不 logError，原本那筆 pending 不受影響
× earlyDone 命中優先於 handoffBusy：即使目前有別筆 pending 也能立即回 done（逾時，5000ms）
```

傳入不相干的 id 卻把正在等的那一筆結束掉：第一個測試斷言 `pending()` 傳回不受影響的 `t1`，被錯誤結束後變成 `null`，直接抓到。第二個測試更隱蔽：`handoff.done('t2')` 呼叫時唯一的 pending 是 `t1`，突變版本不比對 id、直接把它當成 `t1` 完成，`t2` 從頭到尾沒被記進 `earlyDone`；接下來 `handoff.begin('t2', ...)` 因為 `earlyDone` 沒有 `t2`、`active` 又已經被清空，會建立一筆全新的、真正在等的 pending，但測試裡沒有任何後續動作去完成它，`await expect(...).resolves...` 卡死到 vitest 預設的 5 秒逾時。兩個測試斷言的是 pending 內容與 resolve 結果，不是巧合能過的計數，所以不會被誤導成一直綠。還原後全綠。

**突變 3：`abortAll()` 手動內聯清理邏輯，但漏了 `clock.clearTimer`。**

```ts
abortAll() {
  if (active === null) return
  const current = active
  active = null
  if (current.signal !== undefined && current.onAbort !== undefined) {
    current.signal.removeEventListener('abort', current.onAbort)
  }
  current.resolve({ outcome: 'session-ended' })
  // 漏了 clock.clearTimer(current.timerHandle)
},
```

變紅：

```
× abortAll 之後開新的 begin：舊 pending 的逾時 timer 不能提前結束新的 pending（驗證 clearTimer 有實際生效）
AssertionError: expected { outcome: 'timeout' } to be undefined
```

這個突變在這六個裡最隱蔽：`abortAll` 本身的斷言（resolve session-ended、`pending()` 變 null）全部還是綠的，因為 `finish` 的 `if (current === null) return` 早退會吞掉舊 timer 之後那一次多餘的觸發，只 resolve 一次、不 logError，表面上看不出差異。真正把問題照出來的是專門設計的那個測試：舊 pending 在 `now=0` 開始、`now=100` 被 `abortAll`；如果舊 timer 沒被真的取消，它仍然會在 `now=HANDOFF_TIMEOUT_MS` 這個原本的到期點觸發，而這時候 `active` 已經指向後來新開的第二筆 pending，`finish('timeout')` 就會把不相干的第二筆提前判成逾時，比它自己真正的到期點（`now=HANDOFF_TIMEOUT_MS+100`）早了 100ms。測試在剛好卡在兩個到期點中間的時刻斷言「還沒 resolve」，抓到這個提前結束。這也是為什麼 Step 1 特別強調要用到期排序的 `manualClock`：如果測試 helper 只會「一次觸發全部」，這個突變不會被抓到。還原後全綠。

**突變 4（裁決 31）：`begin()` 漏掉 earlyDone 命中檢查。**

```ts
begin(toolUseId, reason, signal) {
  // 漏了 earlyDone 命中檢查
  if (active !== null) {
    return Promise.reject(new ViewToolError(MSG.handoffBusy(active.pending.reason)))
  }
  ...
```

跑測試，變紅：

```
× 早到的 done（裁決 31）：之後 begin 帶同一個 id 立即回 done，不建立 pending（逾時，5000ms）
× 早到的 done 用過一次就消耗掉：同一個 id 第二次 begin 是正常新的一筆（逾時，5000ms）
× earlyDone 命中優先於 handoffBusy：即使目前有別筆 pending 也能立即回 done
AssertionError: promise rejected "ViewToolError: 已有一筆交接等待中（原因A），請等使用者完成" instead of resolving
× earlyDone 有 FIFO 上限 EARLY_DONE_MAX：超過時淘汰最舊的一筆（逾時，5000ms）
```

四個測試全部抓到，因為 `begin()` 完全不再認得 `earlyDone`：第一、二、四個測試裡的 `begin()` 呼叫本來預期立即回 `done`，少了短路後變成建立一筆沒人會完成的真實 pending，`await` 永遠等不到結果而逾時；第三個測試（`earlyDone` 命中優先於 `handoffBusy`）呼叫 `begin('t2', ...)` 時剛好有 `t1` 這筆真正的 pending 在等，少了短路就直接撞上 `handoffBusy` 被拒絕。還原後全綠。

**突變 5（裁決 31）：`earlyDone` 淘汰邏輯淘汰最新的一筆而不是最舊的（違反 FIFO）。**

```ts
earlyDone.add(toolUseId)
if (earlyDone.size > EARLY_DONE_MAX) {
  const arr = [...earlyDone]
  const newest = arr[arr.length - 1]   // 應該取最舊（第一個），不是最新（最後一個）
  if (newest !== undefined) earlyDone.delete(newest)
}
```

變紅：

```
× earlyDone 有 FIFO 上限 EARLY_DONE_MAX：超過時淘汰最舊的一筆
AssertionError: expected null to deeply equal ObjectContaining {"toolUseId": "id-0"}
```

測試依序塞進 `id-0` 到 `id-8` 共 `EARLY_DONE_MAX + 1` 筆，正確版本應該淘汰最舊的 `id-0`，讓它之後的 `begin('id-0', ...)` 走正常流程、真的建立一筆 pending；這裡因為淘汰了最新的 `id-8`，`id-0` 仍然留在 earlyDone 裡，`begin('id-0', ...)` 立即回 done，從沒建立過 pending，`pending()` 是 `null`，斷言直接抓到。還原後全綠。

**突變 6（裁決 31）：`abortAll()` 忘了清 `earlyDone`。**

```ts
abortAll() {
  // 漏了 earlyDone.clear()
  if (active === null) return
  finish('session-ended')
},
```

變紅：

```
× abortAll 清空 earlyDone（裁決 31）：清空後同一個 id 的 begin 不再立即回 done
AssertionError: expected null to deeply equal ObjectContaining {"reason": "理由", "toolUseId": "t1"}
```

測試在沒有 pending 的情況下（`active === null`）呼叫 `abortAll()`，正確版本要把先前 `done('t1')` 記下的 earlyDone 清掉，之後 `begin('t1', ...)` 才會走正常流程建立 pending；這裡因為 `earlyDone` 沒被清，`begin('t1', ...)` 命中舊的 earlyDone 立即回 done，`pending()` 停在 `null`，斷言抓到。這個突變刻意選在沒有 pending 的分支測，因為 `active === null` 時原本就是提早 return，很容易漏掉「就算沒有 pending 也要清 earlyDone」這件事。還原後全綠。

- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/handoff.ts tests/view-tools/handoff.test.ts
git commit -m "feat: 新增右窗格工具的交接等待狀態機（handoff.ts）"
```

<!-- END -->
