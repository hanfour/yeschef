### Task 6: 批准的待決 promise 註冊表

> **2026-09-02 依裁決 11／16 修訂**：`ApprovalRequest` 新增 `title`／`displayName`（裁決 11，
> 語意見定義處註解）；新增 `ApprovalAsk = Omit<ApprovalRequest, 'requestId'>`；
> `ApprovalRegistry.request` 簽章改收單一物件 `request(ask: ApprovalAsk)`（裁決 16），
> registry 展開 `ask` 補上 `requestId` 後整個轉送 `sendRequest`，不逐欄位挑。所有呼叫點與
> 測試改成物件寫法，新增一條驗證 `title`／`displayName` 原樣送達的測試與對應突變。
>
> **2026-09-02 依裁決 28 加 `toolUseId`**：`ApprovalRequest` 新增必填的
> `readonly toolUseId: string`（來源是 SDK `CanUseTool` options 的 `toolUseID`），
> `ApprovalAsk` 隨 `Omit` 一起帶到，所有測試的 ask 補這個欄位。

`canUseTool` 在主程序觸發，SDK 等的是一個 `Promise<PermissionResult>`：這個 promise 不
resolve，`query()` 就整條卡死。規格 §3.1「批准」與 §8 定出四種必須各自走到明確結果的結局
（renderer 回 allow、renderer 回 deny、逾時、視窗關閉或 renderer 未就緒），**不得留置任何
掛起的 promise**。本 task 把這四種結局統一成一個可測、不依賴 Electron 的註冊表。

**設計取捨：「送不出去」與「逾時」共用同一個了結入口。**「送請求給 renderer」是依賴注入的
`sendRequest` 函式，由 Task 8 決定怎麼送（例如 `webContents.send`）。視窗已關閉或 renderer
還沒 preload 完成時，Electron 的 send 本身會 throw；本模組把「throw」直接當成「送不出去」的
訊號，立即 deny，不啟動計時器。這樣規格 §8 的第 3、4 種結局（逾時、視窗關閉/未就緒）都走
`settle()` 這一個函式，呼叫端不必額外查視窗狀態，也不會有第二條「忘記處理視窗關閉」的路徑。

**Files:**
- Create: `src/main/approval.ts`
- Create: `tests/approval.test.ts`
- Modify: `vitest.config.ts`（coverage include 加入 `src/main/approval.ts`）

**Interfaces:**
- Consumes: 無（`sendRequest` 是呼叫端注入的函式，見下）
- Produces:
  - `interface ApprovalRequest { readonly requestId: string; readonly toolUseId: string; readonly toolName: string; readonly input: unknown; readonly title?: string; readonly displayName?: string }`
    （與 CONTRACT.md 的 `approvalAsk`（`agent:approval:ask`）payload 逐欄位相同，Task 8
    可以直接 `webContents.send(IPC.approvalAsk, request)`，不必轉形狀。`toolUseId` 是 SDK
    `CanUseTool` options 的 `toolUseID`（裁決 28），renderer 靠它把卡片掛到對應的 tool block；
    `title` 是 SDK 產的完整提示句，`displayName` 是短名詞片語，語意見裁決 11。）
  - `type ApprovalAsk = Omit<ApprovalRequest, 'requestId'>`（`request()` 的輸入形狀，裁決 16）
  - `type ApprovalDecision = 'allow' | 'deny'`
  - `interface ApprovalOutcome { readonly decision: ApprovalDecision; readonly reason?: string }`
  - `type SendApprovalRequest = (request: ApprovalRequest) => void`
  - `interface ApprovalRegistryOptions { readonly sendRequest: SendApprovalRequest; readonly timeoutMs?: number; readonly createRequestId?: () => string }`
  - `interface ApprovalRegistry { request(ask: ApprovalAsk): Promise<ApprovalOutcome>; reply(requestId: string, decision: ApprovalDecision): boolean; denyAll(reason: string): void; pendingCount(): number }`
  - `function createApprovalRegistry(options: ApprovalRegistryOptions): ApprovalRegistry`

  下游用法（裁決 16／28）：Task 8 的 `canUseTool` 呼叫
  `registry.request({ toolName, input, toolUseId: options.toolUseID, title: options.title, displayName: options.displayName })`，
  把 `ApprovalOutcome` 轉成 SDK 的 `PermissionResult`（`allow` → `{ behavior: 'allow', updatedInput: input }`；
  `deny` → `{ behavior: 'deny', message: reason ?? '使用者拒絕' }`），並在 `agent:approval:reply`
  的 IPC handler 呼叫 `registry.reply(requestId, decision)`。Task 5 的收尾三步驟第一步呼叫
  `registry.denyAll('切換 session' | '視窗已關閉')`。

- [ ] **Step 1: 寫失敗的測試**

`tests/approval.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import {
  createApprovalRegistry,
  type ApprovalAsk,
  type ApprovalRequest,
  type ApprovalRegistry,
} from '../src/main/approval.js'

/** 建一份帶假 sendRequest 的註冊表，並回傳收到的請求清單供斷言。 */
function setup(opts?: { timeoutMs?: number; onSend?: (req: ApprovalRequest) => void }): {
  registry: ApprovalRegistry
  sent: ApprovalRequest[]
} {
  const sent: ApprovalRequest[] = []
  let counter = 0
  const registry = createApprovalRegistry({
    timeoutMs: opts?.timeoutMs,
    createRequestId: () => `req-${(counter += 1)}`,
    sendRequest: (req) => {
      sent.push(req)
      opts?.onSend?.(req)
    },
  })
  return { registry, sent }
}

/** ask 的最小形狀：三個必填欄位（裁決 28 之後 `toolUseId` 也是必填）。 */
const ask = (over: Partial<ApprovalAsk> & { toolName: string }): ApprovalAsk => ({
  toolUseId: 'toolu_1',
  input: {},
  ...over,
})

describe('createApprovalRegistry', () => {
  it('送出的請求帶正確的 requestId、toolUseId、toolName、input', async () => {
    const { registry, sent } = setup()
    const promise = registry.request(
      ask({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_ls' })
    )
    expect(sent).toEqual([
      { requestId: 'req-1', toolUseId: 'toolu_ls', toolName: 'Bash', input: { command: 'ls' } },
    ])
    registry.reply('req-1', 'allow')
    await promise
  })

  it('結局 1：renderer 回 allow', async () => {
    const { registry } = setup()
    const promise = registry.request(ask({ toolName: 'Read', input: { path: 'a.ts' } }))
    expect(registry.reply('req-1', 'allow')).toBe(true)
    const outcome = await promise
    expect(outcome).toEqual({ decision: 'allow' })
  })

  it('結局 2：renderer 回 deny', async () => {
    const { registry } = setup()
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'rm -rf /' } }))
    expect(registry.reply('req-1', 'deny')).toBe(true)
    const outcome = await promise
    expect(outcome.decision).toBe('deny')
  })

  it('結局 3：逾時，deny 且 reason 留下可辨識的記錄（規格 §8）', async () => {
    const { registry } = setup({ timeoutMs: 5 })
    const outcome = await registry.request(ask({ toolName: 'Bash', input: { command: 'sleep 999' } }))
    expect(outcome.decision).toBe('deny')
    expect(outcome.reason).toMatch(/逾時/)
  })

  it('結局 4：sendRequest 丟錯（視窗已關閉／renderer 未就緒）立即 deny，不留計時器', async () => {
    const { registry } = setup({
      timeoutMs: 30_000, // 刻意設大：若沒有立即 deny，測試會真的卡住
      onSend: () => {
        throw new Error('webContents 已銷毀')
      },
    })
    const promise = registry.request(ask({ toolName: 'Write', input: { path: 'x.ts' } }))
    // 同步斷言：Promise executor 是同步執行的，settle() 在 request() 回傳前就跑完，
    // 不必等任何一輪 microtask/timer 就能看到表已經清空。
    expect(registry.pendingCount()).toBe(0)
    const outcome = await promise
    expect(outcome.decision).toBe('deny')
    expect(outcome.reason).toMatch(/送不出去|webContents 已銷毀/)
  })

  it('多個待決請求時互不干擾', async () => {
    const { registry } = setup({ timeoutMs: 200 })
    const p1 = registry.request(ask({ toolName: 'Read', input: { path: 'a.ts' } }))
    const p2 = registry.request(ask({ toolName: 'Read', input: { path: 'b.ts' } }))
    expect(registry.pendingCount()).toBe(2)

    const SENTINEL = Symbol('not-yet')
    registry.reply('req-1', 'allow')
    // req-2 還沒被回覆：跟一個立刻 resolve 的 sentinel 賽跑，證明它真的還掛著
    const raced = await Promise.race([p2, Promise.resolve(SENTINEL)])
    expect(raced).toBe(SENTINEL)
    expect(registry.pendingCount()).toBe(1)

    expect((await p1).decision).toBe('allow')
    registry.reply('req-2', 'deny')
    expect((await p2).decision).toBe('deny')
    expect(registry.pendingCount()).toBe(0)
  })

  it('回覆一個不存在的 requestId：回傳 false，不影響其他待決請求', async () => {
    const { registry } = setup({ timeoutMs: 200 })
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'ls' } }))
    expect(registry.reply('req-不存在', 'allow')).toBe(false)
    expect(registry.pendingCount()).toBe(1)
    registry.reply('req-1', 'allow')
    expect((await promise).decision).toBe('allow')
  })

  it('同一個 requestId 回覆兩次：第二次視為找不到（擋住「忘記清理」的實作）', async () => {
    const { registry } = setup()
    const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'ls' } }))
    expect(registry.reply('req-1', 'allow')).toBe(true)
    expect(registry.reply('req-1', 'deny')).toBe(false)
    expect((await promise).decision).toBe('allow') // 第二次回覆沒有蓋掉第一次的結果
  })

  it('denyAll 把所有待決請求立即以指定 reason 結束', async () => {
    const { registry } = setup({ timeoutMs: 200 })
    const p1 = registry.request(ask({ toolName: 'Bash', input: { command: 'a' } }))
    const p2 = registry.request(ask({ toolName: 'Bash', input: { command: 'b' } }))
    expect(registry.pendingCount()).toBe(2)

    registry.denyAll('切換 session')

    expect(registry.pendingCount()).toBe(0)
    expect(await p1).toEqual({ decision: 'deny', reason: '切換 session' })
    expect(await p2).toEqual({ decision: 'deny', reason: '切換 session' })
  })

  it('denyAll 在沒有待決請求時是無害的 no-op', () => {
    const { registry } = setup()
    expect(() => registry.denyAll('視窗已關閉')).not.toThrow()
    expect(registry.pendingCount()).toBe(0)
  })

  it('請求逾時後，計時器不會再次觸發（不留 dangling timer）', async () => {
    vi.useFakeTimers()
    try {
      const { registry } = setup({ timeoutMs: 100 })
      const promise = registry.request(ask({ toolName: 'Bash', input: { command: 'x' } }))
      await vi.advanceTimersByTimeAsync(100)
      expect((await promise).decision).toBe('deny')
      expect(registry.pendingCount()).toBe(0)
      // 再推進時間不該有任何效果（沒有殘留的計時器可觸發）
      await vi.advanceTimersByTimeAsync(10_000)
      expect(registry.pendingCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('title／displayName 原封不動送到 sendRequest，且帶 requestId（裁決 11／16）', async () => {
    const { registry, sent } = setup()
    const promise = registry.request({
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
      title: '要執行 ls 嗎？',
      displayName: 'ls',
    })
    expect(sent).toEqual([
      {
        requestId: 'req-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'ls' },
        title: '要執行 ls 嗎？',
        displayName: 'ls',
      },
    ])
    registry.reply('req-1', 'allow')
    await promise
  })

  it('toolUseId 原封不動送到 sendRequest，兩筆請求各自帶自己的（裁決 28）', async () => {
    const { registry, sent } = setup({ timeoutMs: 200 })
    const p1 = registry.request(ask({ toolName: 'Bash', toolUseId: 'toolu_a' }))
    const p2 = registry.request(ask({ toolName: 'Read', toolUseId: 'toolu_b' }))
    expect(sent.map((r) => r.toolUseId)).toEqual(['toolu_a', 'toolu_b'])
    registry.reply('req-1', 'allow')
    registry.reply('req-2', 'allow')
    await Promise.all([p1, p2])
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/approval.test.ts`
Expected: FAIL，無法解析 `../src/main/approval.js`

- [ ] **Step 3: 寫最小實作**

`src/main/approval.ts`：

```typescript
import { randomUUID } from 'node:crypto'

/**
 * canUseTool 的批准請求送到 renderer 時的形狀。
 * 與 CONTRACT.md 的 `approvalAsk`（`agent:approval:ask`）payload 逐欄位相同，
 * Task 8 可以把它原樣 `webContents.send`，不必轉形狀。`title`／`displayName`
 * 語意見裁決 11。
 */
export interface ApprovalRequest {
  readonly requestId: string
  /**
   * SDK `CanUseTool` options 的 `toolUseID`（裁決 28）。renderer 靠
   * `block.id === toolUseId` 把批准卡片掛到對應的 tool block 上。
   */
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
  readonly title?: string        // SDK 產的完整提示句，官方建議優先用它
  readonly displayName?: string  // 短名詞片語，適合按鈕標籤
}

/** `request()` 的輸入形狀：比 `ApprovalRequest` 少了 `requestId`，由 registry 補上（裁決 16）。 */
export type ApprovalAsk = Omit<ApprovalRequest, 'requestId'>

export type ApprovalDecision = 'allow' | 'deny'

/**
 * 待決 promise 的最終結果。
 *
 * deny 時盡量帶 reason，供 UI 在對話裡留下可見記錄（規格 §8：「拒絕是安全的
 * 方向，靜默掛住不是」。這句話反過來說就是「拒絕了也不能是靜默的」，要有
 * 看得見的原因）。allow 一律不帶 reason。
 *
 * Task 8 的 canUseTool 直接用這個值組出 SDK 的 PermissionResult：
 *   allow → { behavior: 'allow', updatedInput: input }
 *   deny  → { behavior: 'deny', message: reason ?? '使用者拒絕' }
 */
export interface ApprovalOutcome {
  readonly decision: ApprovalDecision
  readonly reason?: string
}

/**
 * 把請求送到 renderer 的注入函式，由呼叫端（Task 8）決定怎麼送
 * （例如 `webContents.send`）。
 *
 * 是否「送得出去」用「會不會 throw」判斷：視窗已關閉或 webContents 已銷毀時，
 * Electron 的 send 本身會 throw，不需要呼叫端額外查視窗狀態、也不需要另一條
 *「處理視窗關閉」的路徑：throw 直接併入下面 request() 的 deny 邏輯。
 */
export type SendApprovalRequest = (request: ApprovalRequest) => void

export interface ApprovalRegistryOptions {
  readonly sendRequest: SendApprovalRequest
  /** 逾時毫秒數，規格 §8 定為 30000。可注入是為了讓測試不必真的等 30 秒。 */
  readonly timeoutMs?: number
  /** requestId 產生器，預設 crypto.randomUUID。測試可注入以取得可預期的 id。 */
  readonly createRequestId?: () => string
}

export interface ApprovalRegistry {
  /**
   * 送出一筆批准請求，回傳掛著的 promise。
   *
   * 這個 promise **永遠 resolve，不 reject**：allow、deny、逾時、送不出去
   * 這四種結局在 canUseTool 眼中都是「有了結果」，不是例外，呼叫端不需要
   * 包 try/catch。
   *
   * 參數是 `ApprovalAsk`（裁決 16）：呼叫端把 `toolUseId`／`toolName`／`input`／
   * `title`／`displayName` 組成一個物件，registry 補上 `requestId` 後整個轉送給
   * `sendRequest`，不逐欄位重組。
   */
  request(ask: ApprovalAsk): Promise<ApprovalOutcome>

  /**
   * renderer 回覆時呼叫。找不到對應的待決請求（未知 id、已經結束過的 id）
   * 回傳 false，不做任何事、不 throw：遲到或重複的回覆在 IPC 世界是正常
   * 狀況，不是錯誤，不該讓整個 handler 掛掉。
   */
  reply(requestId: string, decision: ApprovalDecision): boolean

  /**
   * 把目前所有待決請求立即以 deny 結束。
   *
   * 規格 §3.2 收尾三步驟的第一步：切換 session 或關閉視窗前，先讓掛著的
   * 批准 promise 全部有個了結，再 interrupt() 進行中的工具、收掉 query。
   * 理由跟逾時一樣：拒絕是安全的方向；讓 promise 隨著被收掉的 query 一起
   * 消失、永遠不 resolve，才是真正危險的狀態。
   */
  denyAll(reason: string): void

  /** 目前待決請求數。供測試與偵錯使用。 */
  pendingCount(): number
}

interface PendingEntry {
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * 建立一份批准的待決 promise 註冊表。
 *
 * `canUseTool` 在主程序觸發後沒有第二次機會：SDK 等的是一個
 * `Promise<PermissionResult>`，這個 promise 不 resolve，`query()` 就卡住
 * 不動。四種結局（allow、deny、逾時、送不出去／視窗關閉）都必須走到
 * resolve，不得留置。
 */
export function createApprovalRegistry(options: ApprovalRegistryOptions): ApprovalRegistry {
  const { sendRequest } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  const createRequestId = options.createRequestId ?? randomUUID

  const pending = new Map<string, PendingEntry>()

  /** 唯一的了結入口：清計時器、從表裡刪掉、resolve。順序不能反過來。 */
  function settle(requestId: string, outcome: ApprovalOutcome): boolean {
    const entry = pending.get(requestId)
    if (entry === undefined) return false
    clearTimeout(entry.timer)
    pending.delete(requestId)
    entry.resolve(outcome)
    return true
  }

  function request(ask: ApprovalAsk): Promise<ApprovalOutcome> {
    const requestId = createRequestId()

    return new Promise<ApprovalOutcome>((resolve) => {
      // 逾時是安全的方向，不是例外：規格 §8「批准逾時 → 拒絕，並在對話裡
      // 留下可見記錄」。掛住不回覆比拒絕危險：掛住會讓 query() 整條卡死，
      // 使用者連「這次不行」都看不到。
      const timer = setTimeout(() => {
        settle(requestId, {
          decision: 'deny',
          reason: `批准請求逾時（${timeoutMs}ms 內未收到回覆）`,
        })
      }, timeoutMs)

      pending.set(requestId, { resolve, timer })

      try {
        // 展開整個 ask 再補上 requestId，不逐欄位挑：toolUseId（裁決 28）與
        // title／displayName 有沒有值都原樣轉送給 sendRequest（裁決 16）。
        sendRequest({ ...ask, requestId })
      } catch (error) {
        // 送不出去（視窗已關閉、renderer 還沒 preload 完成）跟逾時是同一種
        // 情況的另一個入口：不會有人回覆這筆請求。立即 deny，不必等滿
        // timeoutMs 才發現，也不能讓例外把 promise 就此晾在那裡沒人 resolve。
        // 規格 §8「批准時 renderer 未就緒或視窗已關 → 同上，拒絕並記錄」。
        settle(requestId, {
          decision: 'deny',
          reason: `無法送出批准請求：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    })
  }

  function reply(requestId: string, decision: ApprovalDecision): boolean {
    return settle(requestId, { decision })
  }

  function denyAll(reason: string): void {
    // 先把 key 複製出來：settle() 會修改 pending，在 Map 走訪中刪除「目前
    // 造訪的」key 雖然安全，但刪除「還沒走到」的 key 沒有規格保證，不賭這個。
    for (const requestId of [...pending.keys()]) {
      settle(requestId, { decision: 'deny', reason })
    }
  }

  function pendingCount(): number {
    return pending.size
  }

  return { request, reply, denyAll, pendingCount }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/approval.test.ts`
Expected: PASS，13 個測試

Run: `npm run typecheck`
Expected: 無錯誤。`src/main/approval.ts` 共 176 行，在單檔 800 行的上限內。

實測（worktree，2026-09-02 裁決 28 之後重跑）：`npx tsc --noEmit -p .` 無輸出、exit 0。
`npx vitest run tests/approval.test.ts` 輸出：
```
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

五個突變各跑一次，每一個都必須讓測試變紅：

| # | 突變 | 預期紅的測試 |
|---|---|---|
| 1 | `request()` 裡逾時那個 `setTimeout` callback，把 `decision: 'deny'` 改成 `decision: 'allow'` | 「結局 3：逾時，deny 且 reason 留下可辨識的記錄」、「請求逾時後，計時器不會再次觸發」（斷言 `decision === 'deny'` 那一行） |
| 2 | 拿掉 `settle()` 裡的 `pending.delete(requestId)`（清理，讓已了結的請求繼續留在表裡） | 「同一個 requestId 回覆兩次：第二次視為找不到」：移除清理後第二次 `reply('req-1', 'deny')` 仍會在表裡找到 entry、回傳 `true` 並再呼叫一次 `entry.resolve()`，斷言 `toBe(false)` 變紅。另外四條靠 `pendingCount()` 的測試也一起紅 |
| 3 | 拿掉 `request()` 裡包住 `sendRequest(...)` 的 `try/catch`，讓例外直接穿透 | 「結局 4：sendRequest 丟錯時立即 deny，不留計時器」：Promise executor 內未捕捉的例外會讓整個 promise reject，測試裡的 `await promise` 直接拋出，整條測試變紅（而不是原本預期的 `outcome.decision === 'deny'`） |
| 4 | `request()` 裡把 `sendRequest({ ...ask, requestId })` 改成 `sendRequest({ requestId, toolUseId: ask.toolUseId, toolName: ask.toolName, input: ask.input })`（丟掉 title／displayName） | 「title／displayName 原封不動送到 sendRequest，且帶 requestId（裁決 11／16）」：`sent` 裡少了 `title`／`displayName` 兩個欄位，`toEqual` 斷言變紅 |
| 5 | `request()` 裡把 `sendRequest({ ...ask, requestId })` 改成 `sendRequest({ ...ask, requestId, toolUseId: 'toolu_1' })`（toolUseId 寫死成第一筆的值，裁決 28） | 「toolUseId 原封不動送到 sendRequest，兩筆請求各自帶自己的（裁決 28）」：第二筆的 `toolUseId` 變成 `toolu_1`，`toEqual(['toolu_a', 'toolu_b'])` 變紅 |

任何一個突變後測試仍然全綠，表示該條測試沒有測到它宣稱要測的東西，停下來回報。
五次的紅燈輸出與還原後的綠燈都貼進報告。

實測（worktree，2026-09-02 裁決 28 之後，五個突變逐一實跑，每一個都改壞、跑紅、還原、回綠）：

```
###### 突變 1：逾時 callback 的 decision 改成 allow
     × 結局 3：逾時，deny 且 reason 留下可辨識的記錄（規格 §8）
     × 請求逾時後，計時器不會再次觸發（不留 dangling timer）
      Tests  2 failed | 11 passed (13)

###### 突變 2：settle() 拿掉 pending.delete
     × 結局 4：sendRequest 丟錯（視窗已關閉／renderer 未就緒）立即 deny，不留計時器
     × 多個待決請求時互不干擾
     × 同一個 requestId 回覆兩次：第二次視為找不到（擋住「忘記清理」的實作）
     × denyAll 把所有待決請求立即以指定 reason 結束
     × 請求逾時後，計時器不會再次觸發（不留 dangling timer）
      Tests  5 failed | 8 passed (13)

###### 突變 3：拿掉 try/catch
     × 結局 4：sendRequest 丟錯（視窗已關閉／renderer 未就緒）立即 deny，不留計時器
      Tests  1 failed | 12 passed (13)

###### 突變 4：sendRequest 丟掉 title／displayName
     × title／displayName 原封不動送到 sendRequest，且帶 requestId（裁決 11／16）
      Tests  1 failed | 12 passed (13)

###### 突變 5：toolUseId 寫死成 'toolu_1'
     × 送出的請求帶正確的 requestId、toolUseId、toolName、input
     × toolUseId 原封不動送到 sendRequest，兩筆請求各自帶自己的（裁決 28）
      Tests  2 failed | 11 passed (13)

###### 還原
      Tests  13 passed (13)
```

突變 3 的紅燈落在 `pendingCount()` 那一行而不是 `outcome.decision === 'deny'`：Promise
executor 同步 throw 時前者先斷言到，另外還跳出一個 Unhandled Rejection。結論與表格一致，
變紅的確切斷言行不同，這裡照實記。

- [ ] **Step 6: 更新 coverage 設定並跑完整測試套件**

`vitest.config.ts` 的 coverage include 加一行，其餘既有條目不動（裁決 19：每個 task 只增刪
自己的檔案，不重寫整份清單）：

```diff
   coverage: {
     include: [
       // ...既有條目不動...
+      'src/main/approval.ts',
     ],
   },
```

Run: `npm test`
Expected: PASS。總數在前面 task 的基礎上加 13，把實際數字記進報告。

- [ ] **Step 7: 提交**

```bash
git add src/main/approval.ts tests/approval.test.ts vitest.config.ts
git commit -m "feat: canUseTool 的待決 promise 註冊表，四種結局都不留置"
```
