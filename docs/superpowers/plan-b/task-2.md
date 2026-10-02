### Task 2: ref 解析與過期判斷（refs.ts）

`refs.ts` 是右窗格工具的座標系統之一：`view_snapshot` 配出 `s<snapshotId>-e<nodeIndex>` 這種 ref 給模型，後續 `view_click`／`view_type` 等工具收到 ref 字串後要能純粹靠字串與一份 `RefTable` 判斷這個 ref 現在還能不能用，不碰 CDP、不碰 Electron。這個檔案是全部四個判斷結果（格式錯、過期、不存在、可用）唯一的權威來源，`controller.ts`（Task 9）不重寫這段邏輯，只把 `RefLookup` 的四種 `kind` 轉成 `MSG` 裡對應的中文錯誤。

`lookupRef` 的判斷順序刻意是「格式錯 → snapshotId 不相等（stale／newer-snapshot） → 相等但 `invalidatedBy` 有值（stale／原因） → entries 查無（missing） → ok」，不是先查 `missing`。關鍵原因是 `invalidateRefs` 的定義：表一旦失效，`entries` 一律清空。如果 `missing` 判斷排在 `stale` 之前，任何一個失效表上的合法格式 ref 都會落到 `entries.get()` 查無，回報成「這個節點不存在」，但真正的原因是整份 snapshot 已經過期，使用者被導向錯誤的下一步（去找節點編號打錯字，而不是重新 `view_snapshot`）。把 `stale` 排在 `missing` 之前，才能讓「表整體過期」與「這一個 ref 從沒出現過」這兩種不同的錯誤訊息對得上真正的原因。`bad-format` 排最前面是因為它連 `snapshotId` 都解不出來，沒有 `snapshotId` 就無法做後面任何比較。

契約 §7 的 `lookupRef` 規則寫的是 `parsed.snapshotId !== table.snapshotId → stale（reason 'newer-snapshot'）`，用的是不等於而不是小於。這裡我照字面實作 `!==`：ref 的 snapshotId 比目前表小（最常見情況，使用者在舊的 snapshot 上操作）與 ref 的 snapshotId 比目前表大（理論上不該發生，因為 snapshotId 只會遞增且 `RefTable` 只留最新一份，但不能排除模型編造或記錯編號）都回同一種 `stale／newer-snapshot`。這是一個契約疑慮，寫在最後的回報裡：`newer-snapshot` 這個 reason 名稱在「ref 序號比表大」的情況語意是反的（明明沒有更新的 snapshot，是 ref 本身憑空指向未來），但契約沒有另外定義一種 reason，我不自行新增，照契約字面做並留下測試釘住這個行為。

實作用一個正則 `/^s(\d+)-e(\d+)$/`，`\d+` 不排除前導零，`s01-e2` 會被接受並解析成 `snapshotId: 1`；這不是我自行放寬，是契約給的正則字面如此，測試裡有一條專門釘住這個決定並附註理由，不算契約疑慮。

**Files:**
- Create `src/main/view-tools/refs.ts`
- Test: `tests/view-tools/refs.test.ts`

**Interfaces:**

Consumes（Task 0 產出的 `src/main/view-tools/types.ts`，只用到這三個型別，簽章照契約 §5）：

```ts
export type InvalidationReason = 'documentUpdated' | 'navigated' | 'userInput'
export interface RefEntry {
  readonly sessionId?: string
  readonly backendNodeId: number
  readonly role: string
  readonly name: string
}
export interface RefTable {
  readonly snapshotId: number
  readonly invalidatedBy?: InvalidationReason
  readonly entries: ReadonlyMap<string, RefEntry>
}
```

Produces（契約 §7 全部匯出，簽章逐字照契約）：

```ts
export interface ParsedRef { readonly snapshotId: number; readonly nodeIndex: number }
export function parseRef(ref: string): ParsedRef | null
export function formatRef(snapshotId: number, nodeIndex: number): string
export const EMPTY_REFS: RefTable
export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable
export type RefLookup =
  | { readonly kind: 'ok'; readonly entry: RefEntry }
  | { readonly kind: 'bad-format' }
  | { readonly kind: 'stale'; readonly snapshotId: number; readonly reason: InvalidationReason | 'newer-snapshot' }
  | { readonly kind: 'missing'; readonly snapshotId: number; readonly ref: string }
export function lookupRef(table: RefTable, ref: string): RefLookup
```

下游：Task 6（`watch.ts` 持有 `RefTable`，`DOM.documentUpdated`／`Page.frameNavigated`／使用者 `input-event` 時呼叫 `invalidateRefs`）、Task 9（`controller.ts` 每個需要 ref 的工具方法先呼叫 `lookupRef`，依 `kind` 轉成 `errors.ts` 的 `MSG.refFormat`／`MSG.refStale`／`MSG.refMissing`，`ok` 才繼續用 `entry.sessionId`／`entry.backendNodeId`）。
- [ ] **Step 1: 寫失敗的測試**

建立 `tests/view-tools/refs.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { EMPTY_REFS, formatRef, invalidateRefs, lookupRef, parseRef } from '../../src/main/view-tools/refs.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

const entryA: RefEntry = { backendNodeId: 101, role: 'button', name: '送出' }
const entryB: RefEntry = { backendNodeId: 202, role: 'link', name: '說明' }

describe('parseRef', () => {
  it('接受標準格式 s1-e2', () => {
    expect(parseRef('s1-e2')).toEqual({ snapshotId: 1, nodeIndex: 2 })
  })

  it('接受 s2-e1，且不與 s1-e2 混淆（防序號互換）', () => {
    expect(parseRef('s2-e1')).toEqual({ snapshotId: 2, nodeIndex: 1 })
  })

  it('接受前導零 s01-e2（\\d+ 不排除前導零，依契約字面 regex）', () => {
    expect(parseRef('s01-e2')).toEqual({ snapshotId: 1, nodeIndex: 2 })
  })

  it('接受多位數 s12-e70', () => {
    expect(parseRef('s12-e70')).toEqual({ snapshotId: 12, nodeIndex: 70 })
  })

  it('拒絕大寫 S1-E2', () => {
    expect(parseRef('S1-E2')).toBeNull()
  })

  it('拒絕前面有空白', () => {
    expect(parseRef(' s1-e2')).toBeNull()
  })

  it('拒絕後面有空白', () => {
    expect(parseRef('s1-e2 ')).toBeNull()
  })

  it('拒絕負數', () => {
    expect(parseRef('s-1-e2')).toBeNull()
  })

  it('拒絕結尾多餘字元（regex 缺 $ 錨點會漏接這個）', () => {
    expect(parseRef('s1-e2x')).toBeNull()
  })

  it('拒絕開頭多餘字元', () => {
    expect(parseRef('xs1-e2')).toBeNull()
  })

  it("拒絕 't' 開頭", () => {
    expect(parseRef('t1-e2')).toBeNull()
  })

  it('拒絕缺少 e 節點段', () => {
    expect(parseRef('s1-2')).toBeNull()
  })

  it('拒絕空字串', () => {
    expect(parseRef('')).toBeNull()
  })

  it('拒絕沒有數字的 s-e', () => {
    expect(parseRef('s-e')).toBeNull()
  })
})

describe('formatRef', () => {
  it('組出 s12-e7', () => {
    expect(formatRef(12, 7)).toBe('s12-e7')
  })

  it('s1-e2 與 s2-e1 是不同字串（防序號互換）', () => {
    expect(formatRef(1, 2)).toBe('s1-e2')
    expect(formatRef(2, 1)).toBe('s2-e1')
    expect(formatRef(1, 2)).not.toBe(formatRef(2, 1))
  })

  it('與 parseRef 互為反函式', () => {
    const ref = formatRef(3, 9)
    expect(parseRef(ref)).toEqual({ snapshotId: 3, nodeIndex: 9 })
  })
})
describe('EMPTY_REFS', () => {
  it('snapshotId 為 0、entries 為空、未失效', () => {
    expect(EMPTY_REFS.snapshotId).toBe(0)
    expect(EMPTY_REFS.entries.size).toBe(0)
    expect(EMPTY_REFS.invalidatedBy).toBeUndefined()
  })
})

describe('invalidateRefs', () => {
  it('回傳同 snapshotId、entries 清空的新表', () => {
    const table: RefTable = { snapshotId: 5, entries: new Map([['s5-e0', entryA]]) }
    const result = invalidateRefs(table, 'documentUpdated')
    expect(result.snapshotId).toBe(5)
    expect(result.entries.size).toBe(0)
    expect(result.invalidatedBy).toBe('documentUpdated')
  })

  it('不修改原表（不可變）', () => {
    const originalEntries = new Map([['s5-e0', entryA]])
    const table: RefTable = { snapshotId: 5, entries: originalEntries }
    invalidateRefs(table, 'navigated')
    expect(table.entries.size).toBe(1)
    expect(table.invalidatedBy).toBeUndefined()
    expect(originalEntries.size).toBe(1)
  })

  it('不修改 EMPTY_REFS 本身', () => {
    invalidateRefs(EMPTY_REFS, 'userInput')
    expect(EMPTY_REFS.entries.size).toBe(0)
    expect(EMPTY_REFS.invalidatedBy).toBeUndefined()
  })

  it('第二次呼叫用新原因覆蓋，不保留第一次的原因（照契約字面：invalidatedBy = reason，每次呼叫都是新賦值，不是「已失效就不重建」；那個規則屬於 watch.ts 的呼叫端政策，見契約 §9.3）', () => {
    const table: RefTable = { snapshotId: 5, entries: new Map() }
    const first = invalidateRefs(table, 'documentUpdated')
    const second = invalidateRefs(first, 'userInput')
    expect(second.invalidatedBy).toBe('userInput')
  })
})

describe('lookupRef', () => {
  it('格式錯 → bad-format，即使 snapshotId 部分看起來合理', () => {
    const table: RefTable = { snapshotId: 1, entries: new Map() }
    expect(lookupRef(table, 'S1-E2')).toEqual({ kind: 'bad-format' })
  })

  it('格式錯優先於過期判斷（就算表已失效也先回 bad-format）', () => {
    const invalidated = invalidateRefs({ snapshotId: 1, entries: new Map() }, 'navigated')
    expect(lookupRef(invalidated, 'not-a-ref')).toEqual({ kind: 'bad-format' })
  })

  it('ref 的 snapshot 序號小於目前 snapshotId → stale，reason 為 newer-snapshot', () => {
    const table: RefTable = { snapshotId: 3, entries: new Map() }
    expect(lookupRef(table, 's1-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'newer-snapshot' })
  })

  it('ref 的 snapshot 序號大於目前 snapshotId → 同樣 stale／newer-snapshot（照契約 !== 字面；契約疑慮見回報）', () => {
    const table: RefTable = { snapshotId: 3, entries: new Map() }
    expect(lookupRef(table, 's9-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'newer-snapshot' })
  })
  it('snapshotId 相等且 invalidatedBy 有值 → stale，reason 是 invalidatedBy（documentUpdated）', () => {
    const table: RefTable = { snapshotId: 3, invalidatedBy: 'documentUpdated', entries: new Map() }
    expect(lookupRef(table, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'documentUpdated' })
  })

  it('snapshotId 相等且 invalidatedBy 有值 → stale，reason 是 invalidatedBy（navigated）', () => {
    const table: RefTable = { snapshotId: 3, invalidatedBy: 'navigated', entries: new Map() }
    expect(lookupRef(table, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'navigated' })
  })

  it('snapshotId 相等且 invalidatedBy 有值 → stale，reason 是 invalidatedBy（userInput）', () => {
    const table: RefTable = { snapshotId: 3, invalidatedBy: 'userInput', entries: new Map() }
    expect(lookupRef(table, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'userInput' })
  })

  it('snapshotId 不相等優先於 invalidatedBy 判斷（不應報成 invalidatedBy 的原因）', () => {
    const table: RefTable = { snapshotId: 5, invalidatedBy: 'navigated', entries: new Map() }
    expect(lookupRef(table, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 5, reason: 'newer-snapshot' })
  })

  it('snapshotId 相等、未失效、entries 沒有這個 ref → missing', () => {
    const table: RefTable = { snapshotId: 3, entries: new Map([['s3-e0', entryA]]) }
    expect(lookupRef(table, 's3-e9')).toEqual({ kind: 'missing', snapshotId: 3, ref: 's3-e9' })
  })

  it('已失效的表對格式正確但 entries 已清空的 ref 回 stale，不是 missing（優先順序的關鍵測試）', () => {
    const invalidated = invalidateRefs(
      { snapshotId: 3, entries: new Map([['s3-e0', entryA]]) },
      'documentUpdated',
    )
    expect(lookupRef(invalidated, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'documentUpdated' })
  })

  it('全部符合 → ok，回傳對應 entry', () => {
    const table: RefTable = { snapshotId: 3, entries: new Map([['s3-e0', entryA]]) }
    expect(lookupRef(table, 's3-e0')).toEqual({ kind: 'ok', entry: entryA })
  })

  it('同時有 s1-e2 與 s2-e1 兩個不同 entry 時各自查到正確的一筆（防序號互換的盲點）', () => {
    const table1: RefTable = { snapshotId: 1, entries: new Map([[formatRef(1, 2), entryA]]) }
    expect(lookupRef(table1, 's1-e2')).toEqual({ kind: 'ok', entry: entryA })

    const table2: RefTable = { snapshotId: 2, entries: new Map([[formatRef(2, 1), entryB]]) }
    expect(lookupRef(table2, 's2-e1')).toEqual({ kind: 'ok', entry: entryB })
  })

  it('不修改傳入的 table', () => {
    const entries = new Map([['s3-e0', entryA]])
    const table: RefTable = { snapshotId: 3, entries }
    lookupRef(table, 's3-e0')
    lookupRef(table, 's3-e9')
    lookupRef(table, 'bad')
    expect(table.entries.size).toBe(1)
    expect(table.snapshotId).toBe(3)
  })
})
```
- [ ] **Step 2: 跑測試確認失敗**

`src/main/view-tools/refs.ts` 與 `src/main/view-tools/types.ts` 都還不存在時：

```bash
npx vitest run tests/view-tools/refs.test.ts
```

已驗證（worktree，Task 0 的 `types.ts` 缺席時用最小 stub 頂替，見回報）：整個檔案找不到模組而失敗，不是斷言失敗：

```
FAIL  tests/view-tools/refs.test.ts [ tests/view-tools/refs.test.ts ]
Error: Cannot find module '../../src/main/view-tools/refs.js' imported from tests/view-tools/refs.test.ts

Test Files  1 failed (1)
     Tests  no tests
```

- [ ] **Step 3: 最小實作**

建立 `src/main/view-tools/refs.ts`：

```ts
import type { InvalidationReason, RefEntry, RefTable } from './types.js'

export interface ParsedRef {
  readonly snapshotId: number
  readonly nodeIndex: number
}

// 裁決：契約 §7 只給 /^s(\d+)-e(\d+)$/，不接受 't' 開頭、不接受大小寫混合、
// 前後空白、負號；\d+ 不排除前導零（'s01-e2' 會被接受，見 refs.test.ts）。
const REF_PATTERN = /^s(\d+)-e(\d+)$/

export function parseRef(ref: string): ParsedRef | null {
  const match = REF_PATTERN.exec(ref)
  if (match === null) {
    return null
  }
  const snapshotPart = match[1]
  const nodePart = match[2]
  if (snapshotPart === undefined || nodePart === undefined) {
    return null
  }
  return { snapshotId: Number(snapshotPart), nodeIndex: Number(nodePart) }
}

export function formatRef(snapshotId: number, nodeIndex: number): string {
  return `s${snapshotId}-e${nodeIndex}`
}

export const EMPTY_REFS: RefTable = {
  snapshotId: 0,
  entries: new Map(),
}

export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable {
  return {
    snapshotId: table.snapshotId,
    invalidatedBy: reason,
    entries: new Map(),
  }
}
export type RefLookup =
  | { readonly kind: 'ok'; readonly entry: RefEntry }
  | { readonly kind: 'bad-format' }
  | { readonly kind: 'stale'; readonly snapshotId: number; readonly reason: InvalidationReason | 'newer-snapshot' }
  | { readonly kind: 'missing'; readonly snapshotId: number; readonly ref: string }

export function lookupRef(table: RefTable, ref: string): RefLookup {
  const parsed = parseRef(ref)
  if (parsed === null) {
    return { kind: 'bad-format' }
  }
  if (parsed.snapshotId !== table.snapshotId) {
    return { kind: 'stale', snapshotId: table.snapshotId, reason: 'newer-snapshot' }
  }
  if (table.invalidatedBy !== undefined) {
    return { kind: 'stale', snapshotId: table.snapshotId, reason: table.invalidatedBy }
  }
  const entry = table.entries.get(ref)
  if (entry === undefined) {
    return { kind: 'missing', snapshotId: table.snapshotId, ref }
  }
  return { kind: 'ok', entry }
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/refs.test.ts
```

已驗證（worktree）：

```
 Test Files  1 passed (1)
      Tests  35 passed (35)
```

另跑 `npx tsc --noEmit -p tsconfig.json` 確認 0 error（已驗證，worktree）。
- [ ] **Step 5: 突變測試**

三個突變都已在 worktree 實跑（改實作、跑測試、記錄變紅的測試名、還原、確認回綠），過程如下。

**突變 1：`invalidateRefs` 不覆蓋已有的 `invalidatedBy`（誤以為要保留第一個原因）**

```diff
 export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable {
   return {
     snapshotId: table.snapshotId,
-    invalidatedBy: reason,
+    invalidatedBy: table.invalidatedBy ?? reason,
     entries: new Map(),
   }
 }
```

`npx vitest run tests/view-tools/refs.test.ts` 變紅（已驗證）：

```
 × invalidateRefs > 第二次呼叫用新原因覆蓋，不保留第一次的原因（…）
 AssertionError: expected 'documentUpdated' to be 'userInput'
 Tests  1 failed | 34 passed (35)
```

這個突變之所以危險：它「看起來合理」（很像 watch.ts 那條「已失效的表不再重建，第一個原因保留」的政策，契約 §9.3），但那條政策是呼叫端 watch.ts 的責任（它決定要不要再呼叫 invalidateRefs），不是 `invalidateRefs` 自己該做的事。如果 `invalidateRefs` 自己也做一次「保留第一個」，兩層保護疊在一起雖然當下測試多半還是會抓到（因為我特別測了「連續兩次呼叫、第二次的原因要生效」），但這正是為什麼要專門測這一條：沒有這條測試的話，這個突變會悄悄通過，讓 `invalidateRefs` 的語意偏離契約字面。已還原並確認 35 個測試回綠。

**突變 2：正則漏掉 `$` 錨點**

```diff
-const REF_PATTERN = /^s(\d+)-e(\d+)$/
+const REF_PATTERN = /^s(\d+)-e(\d+)/
```

`npx vitest run tests/view-tools/refs.test.ts` 變紅（已驗證，2 個測試）：

```
 × parseRef > 拒絕後面有空白
 × parseRef > 拒絕結尾多餘字元（regex 缺 $ 錨點會漏接這個）
 Tests  2 failed | 33 passed (35)
```

少了 `$` 之後 `'s1-e2 '`（結尾空白）與 `'s1-e2x'`（結尾垃圾字元）都會被 `exec` 接受（只要開頭吻合），`parseRef` 回傳看起來正常的 `{ snapshotId: 1, nodeIndex: 2 }` 而不是 `null`。已還原並確認 35 個測試回綠。

**突變 3：`newer-snapshot` 判斷用 `<` 而不是 `!==`**

```diff
-  if (parsed.snapshotId !== table.snapshotId) {
+  if (parsed.snapshotId < table.snapshotId) {
```

`npx vitest run tests/view-tools/refs.test.ts` 變紅（已驗證）：

```
 × lookupRef > ref 的 snapshot 序號大於目前 snapshotId → 同樣 stale／newer-snapshot（照契約 !== 字面；契約疑慮見回報）
 AssertionError: expected { kind: 'missing', ref: 's9-e0', snapshotId: 3 }
                  to equal { kind: 'stale', snapshotId: 3, reason: 'newer-snapshot' }
 Tests  1 failed | 34 passed (35)
```

這個突變是這個檔案最容易被測試漏接的盲點：如果測試只涵蓋「ref 序號比表小」這個常見方向（最自然想到的情境），`<` 與 `!==` 兩種實作在那條測試下結果完全一樣，突變會全綠通過。專門補一條「ref 序號比表大」的測試，才能把 `<` 與 `!==` 的差異照出來，也同時是釘住契約疑慮（見下）的測試。已還原並確認 35 個測試回綠。

三次突變後最終回到與 Step 3 相同的實作，`npx vitest run tests/view-tools/refs.test.ts` 再次 35 個測試全過，`npx tsc --noEmit -p tsconfig.json` 0 error（已驗證）。
- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/refs.ts tests/view-tools/refs.test.ts
git commit -m "feat: 新增 ref 解析與過期判斷（refs.ts）"
```

（本 task 執行時 `src/main/view-tools/types.ts` 應已由 Task 0 提交在主分支上；不需要另外處理 stub。）

---

**關於本回報使用的 stub**：本 task 撰寫時 Task 0 尚未產出 `src/main/view-tools/types.ts`，為了在 worktree 裡實跑測試，另外寫了一份最小 stub（只含 `InvalidationReason`、`RefEntry`、`RefTable` 三個型別，內容逐字照契約 §5），放在 worktree 的同一路徑，驗證完後隨整個 worktree 一併移除，不影響本檔內容（本檔的程式碼一律 import 真正的 `./types.js`，執行 Task 2 時該檔已由 Task 0 產出）。

**契約疑慮**：契約 §7 的 `lookupRef` 用 `parsed.snapshotId !== table.snapshotId` 判斷 stale／newer-snapshot，沒有區分 ref 序號「比目前表小」（正常過期）與「比目前表大」（理論上不該出現，`RefTable` 只留最新一份，snapshotId 只遞增）兩種方向，兩者都回同一個 `reason: 'newer-snapshot'`。這個 reason 名稱在後者的語意是反的：不是「已有更新的 snapshot」，而是「ref 指向一個還不存在的未來 snapshot」。本 task 依契約字面用 `!==` 實作並用測試釘住這個行為，不自行新增 reason 種類；若日後要把這兩種情況分開處理（例如兩種不同的錯誤訊息），需要控制端在契約加一個新的 `RefLookup` 變體或 reason 值。
<!-- END -->
