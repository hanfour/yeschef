### Task 1: SDK options 組裝與 cwd 守衛

取代 `spawn-args.ts`。這是整個專案前提的守門處，上一個分支的最終審查把它列為唯一的 Critical。

**跨模型審查（2026-09-02）對本 task 的兩項發現，已納入下方實作：**

1. `permissionMode: 'manual'` 過不了 typecheck（TS 型別不接受），而且執行期會**靜默降級**成 `default`：傳 `manual` 進去，`init.permissionMode` 回報 `default`；傳 `plan` 回報 `plan`，證明該欄位忠實反映生效模式。省略欄位則落到 `auto`，那是第三種模式。因此明確傳 `'default'`。
2. `resolve()` 比對在 macOS 上擋不住大小寫變體。實機驗證：`path.resolve('/Users/me/Projects/yeschef')` 回傳 `.../YesChef`（大小寫原樣），而 `fs.realpathSync.native()` 回傳 `.../yeschef`。同一個 inode，`resolve()` 判定為不相等。

**Files:**
- Create: `src/main/session-args.ts`
- Create: `tests/session-args.test.ts`
- Modify: `vitest.config.ts`（coverage include 定成裁決 19 的基準清單：`session-args.ts`、`layout.ts`、`cdp.ts`、`src/shared/**/*.ts`、`spikes/measure-memory.ts`）

`spawn-args.ts` 與其測試已在 Task 0 刪除，本 task 開始時 `src/main/` 只剩 `index.ts`、`layout.ts`、`agent-view.ts`、`cdp.ts`。

**Interfaces:**
- Consumes: 無
- Produces:
  - `interface SessionArgsInput { readonly projectDir: string; readonly appDir: string; readonly resumeSessionId?: string }`
  - `interface SessionOptions { readonly cwd: string; readonly permissionMode: 'default'; readonly includePartialMessages: true; readonly resume?: string }`
  - `function buildSessionOptions(input: SessionArgsInput): SessionOptions`

- [ ] **Step 1: 寫失敗的測試**

`tests/session-args.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionOptions } from '../src/main/session-args.js'

/**
 * 用真實目錄而非字串常數：守衛要靠 realpath 解析符號連結與大小寫，
 * 而 realpath 對不存在的路徑會拋錯，所以測試必須建出真的目錄。
 */
let root: string
let appDir: string
let projectDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yeschef-args-'))
  appDir = join(root, 'yeschef')
  projectDir = join(root, 'demo-app')
  mkdirSync(appDir)
  mkdirSync(projectDir)
  mkdirSync(join(appDir, 'docs'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('buildSessionOptions', () => {
  it('cwd 是使用者的專案目錄', () => {
    expect(buildSessionOptions({ projectDir, appDir }).cwd).toBe(projectDir)
  })

  it('projectDir 等於 app 自身目錄時丟錯（接縫測試）', () => {
    expect(() => buildSessionOptions({ projectDir: appDir, appDir })).toThrow('app 自身目錄')
  })

  it('大小寫變體也擋得住（macOS 檔案系統大小寫不敏感）', () => {
    const variant = join(root, 'YESCHEF')
    // 大小寫不敏感的檔案系統上，這個路徑指向同一個 inode
    expect(() => buildSessionOptions({ projectDir: variant, appDir })).toThrow('app 自身目錄')
  })

  it('尾斜線與 .. 也擋得住', () => {
    expect(() => buildSessionOptions({ projectDir: appDir + '/', appDir })).toThrow('app 自身目錄')
    expect(() => buildSessionOptions({ projectDir: join(appDir, 'docs', '..'), appDir })).toThrow(
      'app 自身目錄'
    )
  })

  it('app 目錄底下的子目錄也擋得住（逐字稿仍落在 app 的路徑樹裡）', () => {
    expect(() => buildSessionOptions({ projectDir: join(appDir, 'docs'), appDir })).toThrow(
      'app 自身目錄'
    )
  })

  it('projectDir 是相對路徑時丟錯', () => {
    expect(() => buildSessionOptions({ projectDir: './relative', appDir })).toThrow('絕對路徑')
  })

  it('projectDir 是空字串時丟錯', () => {
    expect(() => buildSessionOptions({ projectDir: '', appDir })).toThrow('絕對路徑')
  })

  it('projectDir 不存在時丟錯，訊息要能讓人看懂', () => {
    expect(() =>
      buildSessionOptions({ projectDir: join(root, 'not-there'), appDir })
    ).toThrow('projectDir 不存在')
  })

  it('permissionMode 是 default，不是 manual', () => {
    // manual 過不了 typecheck，且執行期靜默降級為 default
    expect(buildSessionOptions({ projectDir, appDir }).permissionMode).toBe('default')
  })

  it('includePartialMessages 固定為 true，逐字串流的前提', () => {
    expect(buildSessionOptions({ projectDir, appDir }).includePartialMessages).toBe(true)
  })

  it('沒有 resumeSessionId 時不帶 resume', () => {
    expect(buildSessionOptions({ projectDir, appDir }).resume).toBeUndefined()
  })

  it('有 resumeSessionId 時帶進 resume', () => {
    expect(buildSessionOptions({ projectDir, appDir, resumeSessionId: 'abc-123' }).resume).toBe(
      'abc-123'
    )
  })

  it('不修改傳入的物件', () => {
    const input = { projectDir, appDir }
    const snapshot = JSON.stringify(input)
    buildSessionOptions(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
```

檔案頂端加上 `import { describe, it, expect, beforeEach, afterEach } from 'vitest'`。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/session-args.test.ts`
Expected: FAIL，無法解析 `../src/main/session-args.js`

- [ ] **Step 3: 寫最小實作**

`src/main/session-args.ts`：

```typescript
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export interface SessionArgsInput {
  /** 使用者實際工作的專案目錄。決定 Insights 的歸屬，必須是絕對路徑且存在。 */
  readonly projectDir: string
  /** 本 app 自身的目錄（`app.getAppPath()`）。 */
  readonly appDir: string
  /** 有值時接續既有 session。 */
  readonly resumeSessionId?: string
}

export interface SessionOptions {
  readonly cwd: string
  /**
   * 明確傳 'default'。
   * 'manual' 過不了 typecheck，且執行期會靜默降級為 'default'；
   * 省略此欄位則落到 'auto'，那是第三種行為。
   */
  readonly permissionMode: 'default'
  /** 逐字串流的前提。 */
  readonly includePartialMessages: true
  readonly resume?: string
}

/**
 * 把路徑正規化到可比較的形式。
 *
 * 用 realpath 而非 resolve：macOS 的檔案系統大小寫不敏感，而 resolve() 不做
 * 大小寫正規化也不解符號連結。實機驗證 resolve('.../YesChef') 回傳 '.../YesChef'，
 * realpathSync.native() 回傳 '.../yeschef'，兩者是同一個 inode。
 */
function canonical(p: string): string {
  return realpathSync.native(resolve(p))
}

/**
 * 組出 SDK query() 的 options。
 *
 * projectDir 落在 app 自身的路徑樹裡（相等或為其子目錄）會讓整場 session 的
 * 逐字稿落在被 Insights 排除的路徑下，而且完全靜默：沒有錯誤、agent 正常運作、
 * 月底才發現少了一批 session。見規格 §2.1。
 */
export function buildSessionOptions(input: SessionArgsInput): SessionOptions {
  if (!input.projectDir.startsWith('/')) {
    throw new Error('projectDir 必須是絕對路徑')
  }

  let projectReal: string
  try {
    projectReal = canonical(input.projectDir)
  } catch {
    throw new Error(`projectDir 不存在：${input.projectDir}`)
  }
  const appReal = canonical(input.appDir)

  if (projectReal === appReal || projectReal.startsWith(appReal + sep)) {
    throw new Error(
      `projectDir 不可為 app 自身目錄或其子目錄：${projectReal}\n` +
        `這會讓這場 session 的逐字稿落在被 Insights 排除的路徑下。`
    )
  }

  return {
    cwd: input.projectDir,
    permissionMode: 'default',
    includePartialMessages: true,
    ...(input.resumeSessionId === undefined ? {} : { resume: input.resumeSessionId }),
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/session-args.test.ts`
Expected: PASS，13 個測試

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

把 `canonical` 的 `realpathSync.native(resolve(p))` 暫時改成 `resolve(p)`，跑測試。

Run: `npm test tests/session-args.test.ts`
Expected: **FAIL**，「大小寫變體也擋得住」那一條要紅。若它仍然綠，表示這個測試沒有測到它宣稱要測的東西，停下來回報。

還原後再跑一次確認回綠。兩次輸出都貼進報告。

- [ ] **Step 6: 更新 coverage 設定**

`vitest.config.ts` 的 coverage include 改為（Task 0 已拿掉 `spawn-args.ts` 那一行）：

```typescript
coverage: {
  include: [
    'src/main/session-args.ts',
    'src/main/layout.ts',
    'src/main/cdp.ts',
    'src/shared/**/*.ts',
    'spikes/measure-memory.ts',
  ],
},
```

Run: `npm test`
Expected: PASS。總數在 Task 0 之後的基礎上增加本 task 的 13 個，把實際數字記進報告。

- [ ] **Step 7: 提交**

```bash
git add src/main/session-args.ts tests/session-args.test.ts vitest.config.ts
git commit -m "feat: SDK options 組裝，用 realpath 擋住 app 目錄的大小寫與子目錄變體"
```
