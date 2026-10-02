### Task 11: handoff:done IPC、preload、formatElapsed

`request_handoff` 的交接卡（Task 12 產出）需要一條 renderer 到 main 的單向通道，讓使用者按下「我好了」時通知主程序 resolve 對應的 `HandoffPending`；以及一個把毫秒數轉成「已等待時間」文案的純函式給卡片顯示。這個 task 只做地基：IPC 常數、payload 型別、驗證函式、preload 曝露、文案函式，不碰 UI 元件與 main 端的 handler（分別是 Task 12、13 的範圍）。

三個檔案改動都刻意沿用既有寫法，不引入新樣式：`parseHandoffDone` 照抄 `parseIntentOpenHistory` 的形狀（`isRecord` 加一個非空字串欄位，回傳新造物件），`bridge.ts` 的 `handoffDone` 照抄 `openHistory` 的形狀（單一字串參數包成物件送出，函式體用大括號，理由見 `bridge.ts` 檔頭那段關於 `ipcRenderer.on()` 回傳值外洩的鐵律）。`formatElapsed` 與既有 `formatRelativeTime` 共用同一個 `MINUTE` 常數，不重複定義。

`formatElapsed` 的 guard 寫成 `!Number.isFinite(ms) || ms < MINUTE`，一次涵蓋非有限數與負數兩種情況：負數必然小於 `MINUTE`，不需要另外把它夾成 0 再比較。這比「先 clamp 到 0 再比較」少一個步驟，也少一個可能漏掉負數但單獨測非有限數就過的分支。

裁決 23：IPC 鍵沿用既有 camelCase（`IPC.handoffDone`，值仍是 `'handoff:done'`），不是獨立大寫常數。`YesChefApi.handoffDone` 維持必填方法，這會讓三份既有的 Plan A 測試檔（各自手刻一個假 `YesChefApi` 物件）型別檢查不過，裁決 23 明訂由這個 task 一併補齊，不推給下游；三份檔案各自照既有的樁寫法補一行 `handoffDone`，不引入 `vi.fn()` 這個新樣式。

**Files:**
- Modify `src/shared/ipc.ts`
  - 第 24 行後（`intentOpenHistory` 之後、`} as const` 之前）加一行 `handoffDone: 'handoff:done'`
  - 第 59 行後（`IntentOpenHistoryPayload` 之後）加 `HandoffDonePayload` 介面
  - 第 91 行後（`YesChefApi.openHistory` 之後）加 `handoffDone(toolUseId: string): void`
  - 第 137 行後（`parseIntentOpenHistory` 之後）加 `parseHandoffDone`
- Modify `src/preload/bridge.ts`
  - 第 2-11 行的 import 清單加 `type HandoffDonePayload`
  - 第 83-85 行（`openHistory` 方法）之後加 `handoffDone` 方法
- Modify `src/renderer/components/relative-time.ts`
  - 第 17 行（`formatRelativeTime` 結尾）之後加 `formatElapsed`
- Test:
  - Modify `tests/ipc.test.ts`：`IPC` 逐字比對案例改成九個頻道；加 `describe('parseHandoffDone', …)`
  - Modify `tests/recents.test.tsx`：import 加 `formatElapsed`；加 `describe('formatElapsed', …)`
  - Modify `tests/preload-bridge.test.ts`：既有「回傳值不是 ipcRenderer」那個 `it` 加一行 `handoffDone` 的斷言
  - Modify `tests/app-title-bar.test.tsx`（裁決 23）：第 33 行（`openHistory: () => undefined,`）之後加 `handoffDone: () => undefined,`
  - Modify `tests/use-approvals.test.tsx`（裁決 23）：第 57 行（`openHistory: () => undefined,`）之後加 `handoffDone: () => undefined,`
  - Modify `tests/use-conversation.test.tsx`（裁決 23）：第 64-66 行（`openHistory() { throw new Error('Task 9B 不該呼叫 openHistory') }`）之後加 `handoffDone() { throw new Error('Task 9B 不該呼叫 handoffDone') }`

**Interfaces:**
- Consumes：無（`src/shared/view-tools.ts` 是 Task 0 的產出，這個 task 不 import 它）
- Produces：
  - `IPC.handoffDone: 'handoff:done'`
  - `interface HandoffDonePayload { readonly toolUseId: string }`
  - `function parseHandoffDone(raw: unknown): HandoffDonePayload | null`
  - `YesChefApi.handoffDone(toolUseId: string): void`
  - `function formatElapsed(ms: number): string`
  - 下游：Task 12（`HandoffCard` 用 `formatElapsed` 顯示已等待時間、用 `api.handoffDone` 送出通知）、Task 13（`ipc-bridge.ts` 的 `handoffDone` handler 用 `parseHandoffDone` 驗證後轉給 `ViewTools.handoffDone`）

- [ ] **Step 1：寫失敗的測試**

`tests/ipc.test.ts`：import 清單加 `parseHandoffDone`；把「八個頻道逐字比對」改成九個並加 `handoffDone`；仿 `describe('parseIntentOpenHistory', …)` 加一個新的 `describe`。

```ts
// import 清單（第 2-12 行）改成：
import {
  IPC,
  MAX_INPUT_LENGTH,
  parseApprovalAsk,
  parseApprovalReply,
  parseEventsBatch,
  parseHandoffDone,
  parseIntentOpenHistory,
  parseSessionState,
  parseSessionSummaries,
  parseUserInput,
} from '../src/shared/ipc.js'

// 第 14-27 行的 describe 改成：
describe('IPC 頻道名稱與契約一致', () => {
  it('九個頻道逐字比對', () => {
    expect(IPC).toEqual({
      eventsBatch: 'agent:events',
      userInput: 'agent:input',
      approvalAsk: 'agent:approval:ask',
      approvalReply: 'agent:approval:reply',
      sessionList: 'session:list',
      sessionState: 'session:state',
      intentStartNew: 'session:intent:start-new',
      intentOpenHistory: 'session:intent:open-history',
      handoffDone: 'handoff:done',
    })
  })
})

// 加在 parseIntentOpenHistory 的 describe 之後：
describe('parseHandoffDone', () => {
  it('接受帶 toolUseId 的物件，並回傳新物件（額外欄位被丟掉）', () => {
    const raw = { toolUseId: 'toolu_1', 額外欄位: '應被丟掉' }
    const parsed = parseHandoffDone(raw)
    expect(parsed).toEqual({ toolUseId: 'toolu_1' })
    expect(parsed).not.toBe(raw)
  })
  it('toolUseId 缺漏、空字串或非字串回 null', () => {
    expect(parseHandoffDone({})).toBeNull()
    expect(parseHandoffDone({ toolUseId: '' })).toBeNull()
    expect(parseHandoffDone({ toolUseId: 7 })).toBeNull()
  })
  it('非物件回 null（陣列也算非物件）', () => {
    for (const bad of [null, undefined, 'toolu_1', 3, []]) {
      expect(parseHandoffDone(bad)).toBeNull()
    }
  })
})
```

`tests/recents.test.tsx`：import 加 `formatElapsed`；在既有 `describe('formatRelativeTime', …)` 之後加一個新的 `describe`。

```ts
// 第 5 行改成：
import { formatElapsed, formatRelativeTime } from '../src/renderer/components/relative-time.js'

// 加在 formatRelativeTime 的 describe 之後：
describe('formatElapsed', () => {
  it.each([
    ['0 毫秒仍不到一分鐘', 0, '不到 1 分鐘'],
    ['59999 毫秒仍不到一分鐘', 59_999, '不到 1 分鐘'],
    ['滿一分鐘進位成 1 分鐘', 60_000, '1 分鐘'],
    ['一分鐘多 1 毫秒仍是 1 分鐘', 60_001, '1 分鐘'],
    ['接近兩分鐘但未滿仍是 1 分鐘', 119_999, '1 分鐘'],
    ['滿兩分鐘進位成 2 分鐘', 120_000, '2 分鐘'],
    ['負數視為不到 1 分鐘', -500_000, '不到 1 分鐘'],
    ['非有限數視為不到 1 分鐘', Number.NaN, '不到 1 分鐘'],
  ])('%s', (_label, ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})
```

`tests/preload-bridge.test.ts`：既有的「回傳值不是 ipcRenderer」那個 `it` 裡，`api.openHistory('s-1')` 那行之後加一行：

```ts
    expect(api.startNew()).toBeUndefined()
    expect(api.openHistory('s-1')).toBeUndefined()
    expect(api.handoffDone('toolu_1')).toBeUndefined()
  })
```

- [ ] **Step 2：跑測試確認失敗**

```bash
npx vitest run tests/ipc.test.ts tests/recents.test.tsx tests/preload-bridge.test.ts
```

實測（worktree `wt-11`）：13 個測試失敗，其餘 49 個既有測試照常通過。失敗訊息：

```
TypeError: parseHandoffDone is not a function
 ❯ tests/ipc.test.ts:39:12  （parseHandoffDone 的三個 it 全紅）
TypeError: api.handoffDone is not a function
 ❯ tests/preload-bridge.test.ts:63:16
TypeError: formatElapsed is not a function
 ❯ tests/recents.test.tsx:70:12  （formatElapsed 的 8 筆 it.each 全紅）
Test Files  3 failed (3)
     Tests  13 failed | 49 passed (62)
```

- [ ] **Step 3：最小實作**

`src/shared/ipc.ts`，第 24 行（`intentOpenHistory: 'session:intent:open-history',`）之後、`} as const` 之前加一行：

```ts
  /** renderer → main：使用者按下交接卡的「我好了」（Task 11，契約 §11.3） */
  handoffDone: 'handoff:done',
```

第 59 行（`IntentOpenHistoryPayload` 介面結尾的 `}`）之後加：

```ts

/** 交接完成通知。`toolUseId` 對應 `request_handoff` 那次 tool call 的 id（契約 §11.3）。 */
export interface HandoffDonePayload {
  readonly toolUseId: string
}
```

第 91 行（`openHistory(sessionId: string): void  // → IPC.intentOpenHistory`）之後加一行：

```ts
  handoffDone(toolUseId: string): void  // → IPC.handoffDone
```

第 137 行（`parseIntentOpenHistory` 函式結尾的 `}`）之後加：

```ts

export function parseHandoffDone(v: unknown): HandoffDonePayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.toolUseId)) return null
  return { toolUseId: v.toolUseId }
}
```

`src/preload/bridge.ts`，第 2-11 行的 import 加一個型別（放在既有 `type YesChefApi` 之前，維持字母序）：

```ts
import {
  IPC,
  PROJECT_DIR_ARG,
  parseApprovalAsk,
  parseEventsBatch,
  parseSessionState,
  parseSessionSummaries,
  type HandoffDonePayload,
  type YesChefApi,
  type Unsubscribe,
} from '../shared/ipc.js'
```

第 83-85 行（`openHistory` 方法）之後加：

```ts

  handoffDone: (toolUseId) => {
    ipcRenderer.send(IPC.handoffDone, { toolUseId } satisfies HandoffDonePayload)
  },
```

`src/renderer/components/relative-time.ts`，第 17 行（`formatRelativeTime` 結尾的 `}`）之後加：

```ts

/**
 * HandoffCard 的已等待時間。`ms` 是「現在 - 卡片出現時刻」，負數（時鐘偏差）與
 * 非有限數都落在「不到 1 分鐘」這個分支：guard 用 `ms < MINUTE`，負數必然小於
 * `MINUTE`，不需要另外夾成 0。
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return '不到 1 分鐘'
  return `${String(Math.floor(ms / MINUTE))} 分鐘`
}
```

- [ ] **Step 4：補 Plan A 假 YesChefApi（裁決 23）**

`YesChefApi.handoffDone` 是必填方法，三份既有的 Plan A 測試檔各自手刻一個假 `YesChefApi` 物件，補上這個成員才會通過型別檢查。三處都照該檔案既有的樁寫法補，不新增樣式。

`tests/app-title-bar.test.tsx` 第 32-34 行，原文：

```ts
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: PROJECT_DIR,
```

改後：

```ts
    startNew: () => undefined,
    openHistory: () => undefined,
    handoffDone: () => undefined,
    projectDir: PROJECT_DIR,
```

`tests/use-approvals.test.tsx` 第 56-58 行，原文：

```ts
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: '/Users/x/Projects/demo',
```

改後：

```ts
    startNew: () => undefined,
    openHistory: () => undefined,
    handoffDone: () => undefined,
    projectDir: '/Users/x/Projects/demo',
```

`tests/use-conversation.test.tsx` 第 61-67 行，原文：

```ts
    startNew() {
      throw new Error('Task 9B 不該呼叫 startNew')
    },
    openHistory() {
      throw new Error('Task 9B 不該呼叫 openHistory')
    },
    projectDir: '/Users/x/Projects/demo',
```

改後（這個檔案對 Task 9B 用不到的成員一律用會丟例外的樁，不是靜默的 no-op；`handoffDone` 跟著這個規則）：

```ts
    startNew() {
      throw new Error('Task 9B 不該呼叫 startNew')
    },
    openHistory() {
      throw new Error('Task 9B 不該呼叫 openHistory')
    },
    handoffDone() {
      throw new Error('Task 9B 不該呼叫 handoffDone')
    },
    projectDir: '/Users/x/Projects/demo',
```

跑型別檢查：

```bash
npx tsc --noEmit -p tsconfig.json
```

實測（worktree `wt-11`）：修改前先確認基準是乾淨的（`git stash` 後跑一次 `tsc --noEmit`，退出碼 0，無輸出），套用 Step 3 與本步驟的改動後再跑一次，退出碼 0、無錯誤輸出。三個 `TS2741 Property 'handoffDone' is missing` 錯誤消失。

- [ ] **Step 5：跑測試確認通過**

```bash
npx vitest run tests/ipc.test.ts tests/recents.test.tsx tests/preload-bridge.test.ts
```

實測（worktree `wt-11`）：

```
Test Files  3 passed (3)
     Tests  62 passed (62)
```

跑整個套件確認沒有波及其他測試：

```bash
npx vitest run
```

```
Test Files  25 passed (25)
     Tests  500 passed (500)
```

型別檢查（與 Step 4 同一份結果，這裡合併確認）：

```bash
npx tsc --noEmit -p tsconfig.json
```

實測（worktree `wt-11`）：退出碼 0，無錯誤輸出。裁決 23 交代的三個 Plan A 假 `YesChefApi` 物件已在 Step 4 補齊，型別檢查全線通過，沒有留給下游的疑慮。

- [ ] **Step 6：突變測試**

五個突變，全部在 worktree `wt-11` 實測，跑完立刻還原並確認回綠。

**突變 1（`formatElapsed`）：`ms < MINUTE` 改成 `ms <= MINUTE`。**

```bash
sed -i '' "s/ms < MINUTE) return '不到 1 分鐘'/ms <= MINUTE) return '不到 1 分鐘'/" src/renderer/components/relative-time.ts
npx vitest run tests/recents.test.tsx
```

變紅：`formatElapsed > 滿一分鐘進位成 1 分鐘`（`ms = 60_000` 這個值撞到 off-by-one；60_000 剛好等於 `MINUTE`，用 `<=` 會被誤判成「不到 1 分鐘」）。還原後 `28 passed (28)`。

**突變 2（`formatElapsed`）：`Math.floor` 改成 `Math.round`。**

```bash
# 只改 formatElapsed 那一行的 floor（Math.floor(ms / MINUTE) → Math.round(ms / MINUTE)）
npx vitest run tests/recents.test.tsx
```

變紅：`formatElapsed > 接近兩分鐘但未滿仍是 1 分鐘`（`ms = 119_999`，`119999 / 60000 ≈ 1.9998`，`floor` 給 1、`round` 給 2；選這個值而不是隨便一個非零值，是因為它離下一個整數分鐘只差 1 毫秒，`floor` 與 `round` 的分歧在這裡最明顯）。還原後 `28 passed (28)`。

**突變 3（`formatElapsed`）：拿掉 `!Number.isFinite(ms) ||` 這段 guard，只剩 `if (ms < MINUTE) return …`。**

```bash
npx vitest run tests/recents.test.tsx
```

變紅：`formatElapsed > 非有限數視為不到 1 分鐘`（`NaN < MINUTE` 恆為 `false`，會掉進 `Math.floor(NaN / MINUTE)` 分支變成字串 `"NaN 分鐘"`）。這個突變證明「負數與非有限數共用同一個 guard」不是巧合：guard 真的兩件事都在做，不是只靠負數比較順便涵蓋非有限數。還原後 `28 passed (28)`。

**突變 4（`parseHandoffDone`）：`isNonEmptyString(v.toolUseId)` 改成 `typeof v.toolUseId !== 'string'` 的否定（等於接受空字串）。**

```ts
export function parseHandoffDone(v: unknown): HandoffDonePayload | null {
  if (!isRecord(v)) return null
  if (typeof v.toolUseId !== 'string') return null   // 突變：空字串會通過
  return { toolUseId: v.toolUseId }
}
```

```bash
npx vitest run tests/ipc.test.ts
```

變紅：`parseHandoffDone > toolUseId 缺漏、空字串或非字串回 null`（`{ toolUseId: '' }` 這個案例：空字串是合法的 `string`，只用 `typeof` 判斷會放行，但空字串當 `toolUseId` 對不到任何 pending，是「看起來合理但錯」的典型）。還原後 `32 passed (32)`。

**突變 5（`parseHandoffDone`）：直接回傳 `v as HandoffDonePayload`，不造新物件。**

```ts
export function parseHandoffDone(v: unknown): HandoffDonePayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.toolUseId)) return null
  return v as HandoffDonePayload   // 突變：原物件直接放行
}
```

```bash
npx vitest run tests/ipc.test.ts
```

變紅：`parseHandoffDone > 接受帶 toolUseId 的物件，並回傳新物件（額外欄位被丟掉）`（`額外欄位` 沒被切掉，`toEqual({ toolUseId: 'toolu_1' })` 失敗）。這個突變測的是「一律回傳新造的物件」這條全域規則本身，不是型別層面能擋下的錯誤。還原後 `32 passed (32)`。

全部還原後跑過一次 `npx vitest run`（500 passed）與 `git diff --stat` 確認只剩下 Step 1、Step 3、Step 4 描述的九個檔案改動，沒有殘留任何突變。

- [ ] **Step 7：提交**

兩個 commit：功能本體一個，Plan A 假物件的補丁緊接一個 `test:` commit（裁決 23 的驗證結果附在後者）。

```bash
git add src/shared/ipc.ts src/preload/bridge.ts src/renderer/components/relative-time.ts tests/ipc.test.ts tests/recents.test.tsx tests/preload-bridge.test.ts
git commit -m "feat: 加 handoff:done IPC 通道與 formatElapsed"

git add tests/app-title-bar.test.tsx tests/use-approvals.test.tsx tests/use-conversation.test.tsx
git commit -m "test: 補 Plan A 假 YesChefApi 的 handoffDone 樁（裁決 23）"
```

