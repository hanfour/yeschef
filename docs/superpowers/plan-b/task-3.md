### Task 3: 按鍵表與網址檢查（keys.ts、urls.ts）

把 keys.ts 與 urls.ts 放同一個 task，是因為兩者都是規格 §7、契約 §8 定義的「進門檢查」用純函式：都不 import Electron、都不 import 其他 view-tools 模組，彼此完全獨立，卻同樣被 Task 9 的 controller.ts 在同一個進門檢查順序（`isDestroyed()` → zod → ref／網址等語意檢查 → CDP）裡用到，適合一次交付給下游。

keys.ts 用 `Map` 而不是物件字面量存 `KEY_TABLE`：契約要求 `lookupKey` 大小寫敏感、回傳型別是 `KeyDef | null`（不是 `undefined`），`Map.get` 天生回 `undefined`，用 `?? null` 轉換維持簽章精確。`KEY_NAMES` 直接從同一份 `ENTRIES` 陣列衍生（`map` 取 name），不另外維護第二份清單：一份給 `Map` 用、一份給錯誤訊息用的陣列若分開寫，改動時很容易漏改其中一份，這是把「兩份平行資料要保持同步」的特殊情況，用單一事實來源消除掉。

urls.ts 的核心判斷是 `file:` 網址的路徑前綴比對，最大的陷阱是 `/proj-suffix` 這種字串層級「以 projectDir 開頭」但語意上不在 projectDir 底下的路徑，必須在比對時補上 `path.sep` 當結尾分隔符（或用相等比對涵蓋 projectDir 本身）。這裡不對目標路徑做 realpath：契約已講明理由，規格只要求前綴限制，不要求目標檔真的存在；若做 realpath，`view_navigate` 導到一個還沒產生的輸出檔就會在檢查階段被 `ENOENT` 擋下，而那其實是合法用法。symlink 因此不會被解開，這是刻意的取捨，不是遺漏；若日後要防禦「用 symlink 逃出 projectDir」的攻擊面，需要另外裁決，目前照契約字面實作。

測試設計上，keys.ts 用 table-driven：測試資料直接照契約 §8 的表格逐字轉成陣列，對每個鍵的 key／code／vk／text 四個欄位分別斷言，任何一格填錯都精準對應到失敗的那一列，不會被「至少一個鍵測過」蓋過去。urls.ts 針對契約與規格列出的每一種輸入分類各寫一個案例，並刻意包含前綴陷阱與 projectDir 帶／不帶結尾斜線兩種情況，這兩種正是「看起來合理但錯」的實作最容易蒙混過去的地方。

**Files:**
- Create `src/main/view-tools/keys.ts`
- Create `src/main/view-tools/urls.ts`
- Test: `tests/view-tools/keys.test.ts`
- Test: `tests/view-tools/urls.test.ts`

**Interfaces:**

Consumes：無。純函式模組，不依賴其他 task 的產出。契約 §8 提到的 Task 0 `errors.ts` 只在 Task 9 的 `controller.ts` 組錯誤訊息時用到（`MSG.badKey`、`MSG.badScheme`、`MSG.invalidUrl`、`MSG.outsideProject`），keys.ts／urls.ts 本身只回傳判別結果，不 import errors.ts。

Produces（Task 9 controller.ts 會 import 的精確簽章）：

```ts
// src/main/view-tools/keys.ts
export interface KeyDef {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly text?: string
}
export const KEY_TABLE: ReadonlyMap<string, KeyDef>
export const KEY_NAMES: readonly string[]
export function lookupKey(name: string): KeyDef | null

// src/main/view-tools/urls.ts
export type UrlCheck =
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'bad-scheme' }
  | { readonly kind: 'outside-project'; readonly projectDir: string }
  | { readonly kind: 'invalid' }
export function checkNavigateUrl(raw: string, projectDir: string): UrlCheck
```

- [ ] **Step 1: 寫失敗的測試（keys.ts）**

建立 `tests/view-tools/keys.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { KEY_TABLE, KEY_NAMES, lookupKey, type KeyDef } from '../../src/main/view-tools/keys.js'

/**
 * 契約 §8 的表格逐字搬過來當測試資料：任何一格填錯都要讓對應那一列變紅，
 * 不會被「至少一個鍵測過」這種寬鬆斷言蓋過去。
 */
const EXPECTED: readonly (readonly [string, KeyDef])[] = [
  ['Enter', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }],
  ['Tab', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }],
  ['Home', { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }],
  ['End', { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }],
  ['Space', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }],
]

describe('KEY_TABLE', () => {
  it.each(EXPECTED)('%s 的 key／code／vk／text 與契約 §8 相符', (name, expected) => {
    expect(KEY_TABLE.get(name)).toEqual(expected)
  })

  it('只有這 14 個鍵，沒有多餘或漏掉的項目', () => {
    expect(KEY_TABLE.size).toBe(EXPECTED.length)
  })

  it('沒有 text 的鍵，text 欄位是 undefined（不是空字串）', () => {
    expect(KEY_TABLE.get('Tab')?.text).toBeUndefined()
    expect(KEY_TABLE.get('Escape')?.text).toBeUndefined()
  })
})

describe('KEY_NAMES', () => {
  it('順序固定，逐字等於契約 §8 列出的順序', () => {
    expect(KEY_NAMES).toEqual([
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Space',
    ])
  })
})

describe('lookupKey', () => {
  it.each(EXPECTED)('%s 查得到且內容與 KEY_TABLE 一致', (name, expected) => {
    expect(lookupKey(name)).toEqual(expected)
  })

  it('查不到的鍵回 null', () => {
    expect(lookupKey('F1')).toBeNull()
    expect(lookupKey('Unknown')).toBeNull()
    expect(lookupKey('')).toBeNull()
  })

  it('大小寫敏感：小寫的 enter 查不到', () => {
    expect(lookupKey('enter')).toBeNull()
    expect(lookupKey('ENTER')).toBeNull()
  })

  it('大小寫敏感：只有大小寫不同於 ArrowUp 的變體查不到', () => {
    expect(lookupKey('arrowup')).toBeNull()
    expect(lookupKey('ArrowUP')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/keys.test.ts
```

`src/main/view-tools/keys.ts` 還不存在，預期輸出（已實測）：

```
 FAIL  tests/view-tools/keys.test.ts [ tests/view-tools/keys.test.ts ]
Error: Cannot find module '../../src/main/view-tools/keys.js' imported from .../tests/view-tools/keys.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: 最小實作（keys.ts）**

建立 `src/main/view-tools/keys.ts`：

```ts
/**
 * view_press 的按鍵白名單。
 *
 * 契約 §8（docs/superpowers/plan-b/CONTRACT.md）逐字表：key／code／windowsVirtualKeyCode
 * 三欄用來組 CDP 的 Input.dispatchKeyEvent；有 text 的鍵用 keyDown，沒有的用 rawKeyDown
 * （Puppeteer 對輸入事件的既有作法，此處只查表不送 CDP，送法留給 controller.ts）。
 */

export interface KeyDef {
  readonly key: string
  readonly code: string
  readonly windowsVirtualKeyCode: number
  readonly text?: string
}

const ENTRIES: readonly (readonly [string, KeyDef])[] = [
  ['Enter', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }],
  ['Tab', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
  ['Escape', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }],
  ['Home', { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }],
  ['End', { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }],
  ['Space', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }],
]

export const KEY_TABLE: ReadonlyMap<string, KeyDef> = new Map(ENTRIES)

/** 供錯誤訊息列出，順序固定（契約 §8）。 */
export const KEY_NAMES: readonly string[] = ENTRIES.map(([name]) => name)

/** 大小寫敏感；查不到回 null（不是 undefined，維持與契約簽章一致）。 */
export function lookupKey(name: string): KeyDef | null {
  return KEY_TABLE.get(name) ?? null
}
```

- [ ] **Step 4: 跑測試確認通過（keys.ts）**

```bash
npx vitest run tests/view-tools/keys.test.ts
```

已實測：

```
 Test Files  1 passed (1)
      Tests  34 passed (34)
```

- [ ] **Step 5: 寫失敗的測試（urls.ts）**

建立 `tests/view-tools/urls.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { checkNavigateUrl } from '../../src/main/view-tools/urls.js'

/**
 * projectDir 不需要真的存在：契約明講「不對目標做 realpath」，checkNavigateUrl
 * 只做字串層級的路徑比對，不碰檔案系統，所以固定字串路徑就夠測。
 */
const PROJECT_DIR = '/Users/tester/Projects/yeschef-fixture'

describe('checkNavigateUrl：允許的協定', () => {
  it('http:// 通過，回傳正規化後的 url', () => {
    expect(checkNavigateUrl('http://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: 'http://example.com/a',
    })
  })

  it('https:// 通過', () => {
    expect(checkNavigateUrl('https://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: 'https://example.com/a',
    })
  })

  it('大寫 scheme（HTTP://）也通過，且正規化後的 url 是小寫協定', () => {
    expect(checkNavigateUrl('HTTP://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: 'http://example.com/a',
    })
  })
})

describe('checkNavigateUrl：不允許的協定', () => {
  it.each([['javascript:alert(1)'], ['data:text/plain,hi'], ['about:blank'], ['chrome://settings']])(
    '%s 回 bad-scheme',
    (raw) => {
      expect(checkNavigateUrl(raw, PROJECT_DIR)).toEqual({ kind: 'bad-scheme' })
    }
  )
})

describe('checkNavigateUrl：無法解析', () => {
  it('沒有 scheme 的字串（example.com）回 invalid', () => {
    expect(checkNavigateUrl('example.com', PROJECT_DIR)).toEqual({ kind: 'invalid' })
  })

  it('完全不是網址的字串回 invalid', () => {
    expect(checkNavigateUrl('這不是網址 有空格', PROJECT_DIR)).toEqual({ kind: 'invalid' })
  })

  it('file:// 帶 host（非 localhost）回 invalid：fileURLToPath 轉不出本機路徑', () => {
    expect(checkNavigateUrl('file://host/path', PROJECT_DIR)).toEqual({ kind: 'invalid' })
  })
})

describe('checkNavigateUrl：file: 的專案目錄範圍', () => {
  it('projectDir 底下的檔案回 ok', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}/a.html`, PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: `file://${PROJECT_DIR}/a.html`,
    })
  })

  it('路徑恰好等於 projectDir 本身（無子路徑）回 ok', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}`, PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: `file://${PROJECT_DIR}`,
    })
  })

  it('用 .. 跳出 projectDir，正規化後在外面，回 outside-project', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}/../other/a.html`, PROJECT_DIR)).toEqual({
      kind: 'outside-project',
      projectDir: PROJECT_DIR,
    })
  })

  it('前綴陷阱：projectDir-suffix 不是 projectDir 底下，回 outside-project', () => {
    // "/…/yeschef-fixture-suffix" 以 "/…/yeschef-fixture" 開頭（字串層級），
    // 但不在它底下：少了結尾分隔符的前綴比對會誤判成 ok，必須是 outside-project。
    expect(checkNavigateUrl(`file://${PROJECT_DIR}-suffix/a.html`, PROJECT_DIR)).toEqual({
      kind: 'outside-project',
      projectDir: PROJECT_DIR,
    })
  })

  it('含 %20 與中文的路徑，解碼後在 projectDir 底下，回 ok', () => {
    const raw = `file://${PROJECT_DIR}/a%20b/%E4%B8%AD%E6%96%87.html`
    expect(checkNavigateUrl(raw, PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: raw,
    })
  })

  it('projectDir 帶結尾斜線時，判斷結果與不帶斜線一致（ok 案例）', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}/a.html`, `${PROJECT_DIR}/`)).toEqual({
      kind: 'ok',
      url: `file://${PROJECT_DIR}/a.html`,
    })
  })

  it('projectDir 帶結尾斜線時，判斷結果與不帶斜線一致（outside-project 案例）', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}-suffix/a.html`, `${PROJECT_DIR}/`)).toEqual({
      kind: 'outside-project',
      projectDir: `${PROJECT_DIR}/`,
    })
  })
})
```

- [ ] **Step 6: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/urls.test.ts
```

`src/main/view-tools/urls.ts` 還不存在，預期輸出（已實測）：

```
 FAIL  tests/view-tools/urls.test.ts [ tests/view-tools/urls.test.ts ]
Error: Cannot find module '../../src/main/view-tools/urls.js' imported from .../tests/view-tools/urls.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 7: 最小實作（urls.ts）**

建立 `src/main/view-tools/urls.ts`：

```ts
/**
 * view_navigate 的網址檢查：協定白名單與 file:// 的專案目錄範圍限制。
 *
 * 純 Node，不 import Electron（契約 §1：純函式模組不 import Electron）。
 * 只做判別，不丟例外；controller.ts 依 UrlCheck.kind 決定要不要用 errors.ts 的 MSG 組錯誤。
 */

import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'

export type UrlCheck =
  | { readonly kind: 'ok'; readonly url: string } // 正規化後（new URL().href）
  | { readonly kind: 'bad-scheme' }
  | { readonly kind: 'outside-project'; readonly projectDir: string }
  | { readonly kind: 'invalid' } // new URL() 丟例外，或 file: 網址無法轉成路徑

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:'])

/**
 * 不對目標做 realpath：目標檔可能還不存在（例如 view_navigate 到一個待產生的
 * 輸出檔），對不存在的路徑呼叫 realpath 會直接丟錯，把「合法但還沒建立」的
 * 路徑也擋下來。規格 §7 只要求路徑落在專案目錄底下（前綴限制），不要求目標
 * 真的存在，所以這裡只用字串層級的 `path.resolve` 正規化，不碰檔案系統。
 * 符號連結因此不會被解開：這是刻意的取捨，不是遺漏。
 */
export function checkNavigateUrl(raw: string, projectDir: string): UrlCheck {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { kind: 'invalid' }
  }

  // URL 的 protocol 一律是小寫（URL 標準規定解析時正規化大小寫），
  // 所以這裡不需要、也不能再對 raw 字串自己做一次大小寫處理。
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { kind: 'bad-scheme' }
  }

  if (parsed.protocol !== 'file:') {
    return { kind: 'ok', url: parsed.href }
  }

  let targetPath: string
  try {
    targetPath = fileURLToPath(parsed)
  } catch {
    // 例如帶了非 localhost 的 host（file://host/path）：fileURLToPath 在
    // macOS 上對這種網址丟例外，無法轉成本機路徑。
    return { kind: 'invalid' }
  }

  const resolvedTarget = resolve(targetPath)
  // projectDir 可能帶結尾斜線也可能不帶（呼叫端不保證），用 resolve 正規化到
  // 同一種形式再比較，避免尾斜線造成前綴比對誤判。
  const resolvedProject = resolve(projectDir)

  const isInside =
    resolvedTarget === resolvedProject || resolvedTarget.startsWith(resolvedProject + sep)

  return isInside ? { kind: 'ok', url: parsed.href } : { kind: 'outside-project', projectDir }
}
```

- [ ] **Step 8: 跑測試確認通過（urls.ts）**

```bash
npx vitest run tests/view-tools/urls.test.ts
```

已實測：

```
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

型別檢查（兩個模組一起，已實測）：

```bash
npx tsc --noEmit -p tsconfig.json
```

無輸出（通過）。

- [ ] **Step 9: 突變測試（四個，全部已實跑）**

每個突變：改實作、跑對應測試檔、記錄變紅的測試名稱、還原、確認回綠。

**突變 1（keys.ts）：`Enter` 的 text 從 `\r` 改成 `\n`。**

```ts
['Enter', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\n' }],
```

`npx vitest run tests/view-tools/keys.test.ts` 變紅：

```
FAIL  tests/view-tools/keys.test.ts > KEY_TABLE > Enter 的 key／code／vk／text 與契約 §8 相符
FAIL  tests/view-tools/keys.test.ts > lookupKey > Enter 查得到且內容與 KEY_TABLE 一致
Tests  2 failed | 32 passed (34)
```

還原後 `34 passed (34)`。

**突變 2（keys.ts）：`ENTRIES` 裡 `Enter` 與 `Tab` 兩列順序互換。**

`npx vitest run tests/view-tools/keys.test.ts` 變紅：

```
FAIL  tests/view-tools/keys.test.ts > KEY_NAMES > 順序固定，逐字等於契約 §8 列出的順序
Tests  1 failed | 33 passed (34)
```

還原後 `34 passed (34)`。這一個突變只會被「整段陣列 `toEqual`」的順序斷言抓到；若測試只斷言「集合裡有這 14 個名字」（不管順序），這個突變會被測試放過，測試會變盲。

**突變 3（urls.ts）：前綴檢查少了結尾分隔符，`resolvedTarget.startsWith(resolvedProject + sep)` 改成 `resolvedTarget.startsWith(resolvedProject)`。**

`npx vitest run tests/view-tools/urls.test.ts` 變紅：

```
FAIL  checkNavigateUrl：file: 的專案目錄範圍 > 前綴陷阱：projectDir-suffix 不是 projectDir 底下，回 outside-project
FAIL  checkNavigateUrl：file: 的專案目錄範圍 > projectDir 帶結尾斜線時，判斷結果與不帶斜線一致（outside-project 案例）
Tests  2 failed | 15 passed (17)
```

還原後 `17 passed (17)`。這正是撰寫者須知點名的前綴陷阱：`/proj-suffix` 若沒有這個測試會被誤判成 `ok`。

**突變 4（urls.ts）：scheme 比對沒有小寫化，從 `parsed.protocol` 改成對 `raw` 字串自己切出 scheme（`raw.slice(0, raw.indexOf(':') + 1)`）。**

`npx vitest run tests/view-tools/urls.test.ts` 變紅：

```
FAIL  checkNavigateUrl：允許的協定 > 大寫 scheme（HTTP://）也通過，且正規化後的 url 是小寫協定
Tests  1 failed | 16 passed (17)
```

還原後 `17 passed (17)`。若測試只用小寫的 `http://` 起手，這個突變（改用原始字串不小寫化）會被測試放過。

四個突變跑完後，兩個模組一起再跑一次確認全綠：

```bash
npx vitest run tests/view-tools/keys.test.ts tests/view-tools/urls.test.ts
```

已實測：`Test Files  2 passed (2)`、`Tests  51 passed (51)`。

- [ ] **Step 10: 提交**

```bash
git add src/main/view-tools/keys.ts src/main/view-tools/urls.ts \
        tests/view-tools/keys.test.ts tests/view-tools/urls.test.ts
git commit -m "feat: 新增 view_press 按鍵表與 view_navigate 網址檢查"
```

<!-- END -->
