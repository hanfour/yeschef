# yeschef 子專案 B：右窗格瀏覽器工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓左窗格的 agent 透過八個程序內 MCP 工具操作右窗格瀏覽器，並在需要人時交接給使用者、再接回來。

**Architecture:** `src/main/view-tools/` 用 Agent SDK 的 `createSdkMcpServer` 建一個名為 `yeschef` 的程序內 MCP server，八個工具全部經 `webContents.debugger` 的 CDP 執行（不注入持久 JS）。純函式（snapshot 過濾與 ref 編號、ref 解析、按鍵表、網址檢查、插手摘要）與有狀態元件（settle 計數、插手監看、handoff 單一 pending、controller）分檔，server.ts 只做組裝與錯誤翻譯。左窗格用 `renderToolOverride` 把 `request_handoff` 的工具卡換成 HandoffCard，其餘工具卡沿用 Plan A 的 fold 與 ToolCall。

**Tech Stack:** Electron 44、`@anthropic-ai/claude-agent-sdk` 0.3.258（`createSdkMcpServer`、`tool`、`canUseTool`）、zod 4、`@modelcontextprotocol/sdk` 1.30.0、React、vitest。

**Spec:** `docs/specs/2026-09-03-yeschef-b-view-tools-design.md`
**Contract:** `docs/superpowers/plan-b/CONTRACT.md`（型別契約與裁決 1 到 37；程式碼註解引用「裁決 N」時指這份）

## Global Constraints

- Electron 44、Agent SDK 0.3.258、`@modelcontextprotocol/sdk` 1.30.0 不升版；zod 加為直接相依（`^4.0.0`，裁決 4）。
- MCP server 名稱 `yeschef`，工具全名 `mcp__yeschef__<name>`，八個工具名稱以 `src/shared/view-tools.ts` 的 `VIEW_TOOL_NAMES` 為準；八個工具都設 `alwaysLoad: true`（裁決 19）。
- 批准政策：七個工具 `allow`，`view_eval` 與任何未列名工具 `ask`（`policy.ts`）。
- 進門檢查順序：`isDestroyed()` → zod 參數驗證 → ref／網址等語意檢查 → CDP；所有錯誤都是 MCP `isError: true` 加一句繁體中文，字串以 `errors.ts` 的 `MSG` 表為準，逐字使用。
- 數值常數：`MAX_SNAPSHOT_NODES = 400`、`MAX_BOX_LOOKUPS = 1500`、`SETTLE_QUIET_MS = 500`、`SETTLE_TIMEOUT_MS = 5_000`、`NAVIGATE_TIMEOUT_MS = 8_000`、`HANDOFF_TIMEOUT_MS = 10 * 60_000`、`CDP_CALL_TIMEOUT_MS = 10_000`、`EVAL_MAX_CHARS = 8192`、`SCREENSHOT_MAX_WIDTH = 1280`。
- 網址只接受 `http:`、`https:`、`file:`；`file:` 必須在 `YESCHEF_PROJECT_DIR` 底下。
- `view_eval` 每次都走批准卡；工具內只用 CDP，不注入持久 JS；`persist:agent` partition 與 `setWindowOpenHandler` 行為不變。
- session 收尾時所有等待中的工具呼叫收到 `對話已結束`（`abortPending`，裁決 11）；handoff 逾時是狀態不是錯誤。
- `src/renderer/fold.ts` 不改；`request_handoff` 的卡片替換走 `renderToolOverride`（裁決 2）。
- 每個檔案不超過 400 行；純函式模組不 import Electron；`src/shared/` 不 import `src/main/` 或 `src/renderer/`。
- 時間相關程式碼全部經 `MergerClock` 注入，測試用 `tests/helpers/manual-clock.ts`（到期排序）。
- 測試：vitest；整體覆蓋率 Stmts ≥ 93、Branch ≥ 86；`tests/view-tools/<module>.test.ts` 一個模組一檔；`src/main/agent-view.ts` 維持排除並更新註解。
- 實機驗收 25 項至少 23 項 ✓，`view_click`、`view_type`、`request_handoff` 必須 ✓；結果寫 `docs/RESULTS-05-b-view-tools.md`，格式沿 `docs/RESULTS-04-*.md`。
- 使用者可見文案（工具描述、錯誤訊息、HandoffCard 文字、插手摘要）為繁體中文台灣用語，以契約 §10.1、§12、§9.3 的字串為準。
- commit 訊息 `<type>: <description>`，繁體中文，不加 Co-Authored-By 或任何 trailer；每個 task 至少一個 commit，`git add` 列精確檔名。

---

### Task 0: 共用常數、批准政策、錯誤表、型別、manual-clock helper

這個 task 是整個計畫的地基。八個工具與七個下游 task 全部從這裡拿型別、錯誤字串與批准規則，沒有一行邏輯屬於某個特定工具。契約 §2、§3、§5、§10.1、§14 逐字照抄，唯一需要設計判斷的地方是 manual-clock 的到期排序：既有 `tests/agent-host.test.ts` 裡的私有版本 `advance()` 不看到期時間，一次觸發全部 timer，測不出「500ms 與 5 秒兩個 timer 並存」這種情境，settle.ts（Task 8）與 handoff.ts（Task 7）之後的測試都要靠這個能力。

五個產出檔裡，`view-tools.ts`、`policy.ts`、`errors.ts`、`types.ts` 都是純函式或純資料，沒有一處匯入 Electron：這是刻意的，renderer 只認得 `view-tools.ts`，main 端另外三個檔案要能被之後任何一個純函式模組匯入而不牽動 CDP 或 `WebContents`。`errors.ts` 的 `refStale` 內部藏了一個沒有寫在契約簽章上的小函式 `renderStaleReason`，把 `newer-snapshot` 轉成「已有更新的 snapshot」。這是本 task 唯一自行補上的邏輯：契約 §10.1 段落文字有描述這個轉換規則，但程式碼區塊只給了 `refStale: (snapshotId: number, reason: string) => ...` 這個簽章，沒有另外宣告一個轉換函式。選擇把轉換藏在 `errors.ts` 內部而不要求下游 task（例如 controller.ts）各自轉換，理由是給模型看的顯示字串只該有一個真相來源；`refStale` 對外簽章完全不變，仍然是 `(snapshotId: number, reason: string) => string`。

`manual-clock.ts` 的實作用「每觸發一個 timer 就重新掃描一次還在的 timer」，而不是「先收集一份到期清單再逐一觸發」：後者收集到清單之後，timer 回呼裡新排的、也到期的 timer 不會被納入同一輪，必須用重新掃描版本才能滿足「回呼裡再排一個 0ms timer 要在同一輪 `advance()` 觸發」的規則。

在 worktree 裡實跑：既有套件（25 個測試檔、489 條測試）在改動前確認全綠；把 `tests/agent-host.test.ts` 的私有 `manualClock` 換成 import 之後，連同四個新模組的 37 條新測試一起跑，29 個測試檔、526 條測試全綠，`tsc --noEmit` 零錯誤。另外用一個沒有列入正式輸出的 smoke test 確認 `import { z } from 'zod'` 在裝好直接相依後可以編譯並執行：Task 0 本身沒有任何檔案用到 zod，但下游全部要靠它，先確認不會卡在這裡。

**Files:**
- Modify `package.json`（加 zod 為直接相依）與 `package-lock.json`（`npm i` 自動更新，不必手動編輯）
- Create `src/shared/view-tools.ts`
- Create `src/main/view-tools/policy.ts`
- Create `src/main/view-tools/errors.ts`
- Create `src/main/view-tools/types.ts`
- Create `tests/helpers/manual-clock.ts`
- Modify `tests/agent-host.test.ts`：第 22 行後插入一行 import；刪除第 659 到 688 行的私有 `manualClock` 函式
- Test：`tests/view-tools/view-tools-shared.test.ts`、`tests/view-tools/policy.test.ts`、`tests/view-tools/errors.test.ts`、`tests/view-tools/manual-clock.test.ts`

**Interfaces:**

Consumes：無，Task 0 沒有上游。

Produces（下游 Task 1 到 14 依賴，逐項列出）：

`src/shared/view-tools.ts`
```ts
export const VIEW_TOOL_SERVER_NAME = 'yeschef'
export const VIEW_TOOL_PREFIX: string        // 'mcp__yeschef__'
export const VIEW_TOOL_NAMES: readonly ['view_navigate', 'view_snapshot', 'view_screenshot', 'view_click', 'view_type', 'view_press', 'view_eval', 'request_handoff']
export type ViewToolName = (typeof VIEW_TOOL_NAMES)[number]
export function fullToolName(name: ViewToolName): string
export const REQUEST_HANDOFF_TOOL: string    // 'mcp__yeschef__request_handoff'
export const VIEW_EVAL_TOOL: string          // 'mcp__yeschef__view_eval'
```

`src/main/view-tools/policy.ts`
```ts
export type ToolDecision = 'allow' | 'ask'
export function viewToolPolicy(toolName: string): ToolDecision
```

`src/main/view-tools/errors.ts`
```ts
export class ViewToolError extends Error { readonly name = 'ViewToolError' }
export const MSG: {
  viewGone: string
  badScheme: string
  invalidUrl(raw: string): string
  outsideProject(projectDir: string): string
  navigateFailed(url: string, errorText: string): string
  navigateTimeout(url: string): string
  settleTimeout(seconds: number): string
  refFormat: string
  refStale(snapshotId: number, reason: string): string
  refMissing(snapshotId: number, ref: string): string
  refDetached(ref: string): string
  badKey(key: string, names: readonly string[]): string
  handoffBusy(reason: string): string
  handoffNoId: string
  handoffDone(url: string): string
  handoffTimeout(url: string): string
  sessionEnded: string
  cdpFailed(code: string, message: string): string
  internal(message: string): string
  navigated(url: string, title: string): string
  clicked(role: string, name: string): string
  urlChanged(url: string): string
  typed(count: number, role: string, name: string): string
  pressed(key: string): string
  screenshot(width: number, height: number, url: string): string
  evalTruncated(length: number): string
}
```

`src/main/view-tools/types.ts`（只有型別，逐一列出供下游 import）
```ts
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface Point { readonly x: number; readonly y: number }
export interface AxNode { readonly ref?: string; readonly role: string; readonly name: string; readonly value?: string; readonly bounds: Rect; readonly states: readonly string[]; readonly backendNodeId: number; readonly sessionId?: string }
export interface FrameSnapshot { readonly sessionId?: string; readonly frameId: string; readonly url: string; readonly nodes: readonly AxNode[] }
export interface Snapshot { readonly id: number; readonly takenAt: number; readonly url: string; readonly title: string; readonly scope: 'viewport' | 'full'; readonly frames: readonly FrameSnapshot[]; readonly unattachedFrames: number; readonly truncated: number }
export type InvalidationReason = 'documentUpdated' | 'navigated' | 'userInput'
export interface RefEntry { readonly sessionId?: string; readonly backendNodeId: number; readonly role: string; readonly name: string }
export interface RefTable { readonly snapshotId: number; readonly invalidatedBy?: InvalidationReason; readonly entries: ReadonlyMap<string, RefEntry> }
export interface InterventionLog { readonly clicks: number; readonly keys: number; readonly navigations: number; readonly fromUrl: string }
export interface HandoffPending { readonly toolUseId: string; readonly reason: string; readonly askedAt: number }
export type HandoffOutcome = 'done' | 'timeout' | 'session-ended'
```

`tests/helpers/manual-clock.ts`
```ts
export function manualClock(start = 0): {
  readonly clock: MergerClock   // import type { MergerClock } from '../../src/main/agent-host.js'
  advance(ms: number): void
  now(): number
}
```

- [ ] **Step 1：加入 zod 為直接相依（裁決 4）**

  zod 已經是 `@anthropic-ai/claude-agent-sdk` 的 peer dependency，`node_modules/zod` 已經是 4.5.4，但 `package.json` 沒有列出來（契約 §0）。這一步沒有失敗測試可寫，用指令本身與其後 `tsc`／`vitest` 全綠當作驗證。

  指令：
  ```bash
  npm i zod@^4
  ```

  預期 `package.json` 的 diff（實際在 worktree 跑過，`npm` 會順手把兩個既有陣列重新排序成字母序，這是 npm 的既有行為，不是這次改動刻意造成）：
  ```diff
   "devDependencies": {
  +    "@testing-library/react": "^16.3.3",
       "@types/node": "^26.4.0",
       "@types/react": "^19.2.18",
       "@types/react-dom": "^19.2.5",
  -    "@testing-library/react": "^16.3.3",
  -    "jsdom": "^30.0.1",
       "@vitest/coverage-v8": "^4.1.11",
       "electron": "^44.0.0",
       "electron-vite": "^5.0.0",
  +    "jsdom": "^30.0.1",
       "typescript": "^7.0.2",
       "vite": "^7.3.6",
       "vitest": "^4.1.11"
     },
     ...
     "react": "^19.2.8",
     "react-dom": "^19.2.8",
     "react-markdown": "^10.1.0",
  +    "rehype-highlight": "^7.0.2",
     "remark-gfm": "^4.0.1",
  -    "rehype-highlight": "^7.0.2"
  +    "zod": "^4.5.4"
  ```
  `dependencies` 多一行 `"zod": "^4.5.4"`（`npm i zod@^4` 會把當下解析到的版本存成 `^<版本>`，不是字面的 `^4`）。`package-lock.json` 對應的 zod 條目會拿掉 `"peer": true` 欄位，其餘不變。

  驗證：`npx tsc --noEmit` 通過；另外寫一個不列入正式輸出的 smoke test（`import { z } from 'zod'; z.object({ url: z.string() }).parse({ url: 'https://a.test/' })`），在 worktree 跑過確認可以編譯並執行，之後刪除（Task 0 本身沒有檔案用到 zod，Task 10 才會用）。

- [ ] **Step 2：寫失敗的測試（`src/shared/view-tools.ts`）**

  建立 `tests/view-tools/view-tools-shared.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest'
  import {
    REQUEST_HANDOFF_TOOL,
    VIEW_EVAL_TOOL,
    VIEW_TOOL_NAMES,
    VIEW_TOOL_PREFIX,
    VIEW_TOOL_SERVER_NAME,
    fullToolName,
  } from '../../src/shared/view-tools.js'

  describe('view-tools 共用常數', () => {
    it('server 名稱與前綴', () => {
      expect(VIEW_TOOL_SERVER_NAME).toBe('yeschef')
      expect(VIEW_TOOL_PREFIX).toBe('mcp__yeschef__')
    })

    it('八個工具名稱，順序與契約 §2 一致', () => {
      expect(VIEW_TOOL_NAMES).toEqual([
        'view_navigate',
        'view_snapshot',
        'view_screenshot',
        'view_click',
        'view_type',
        'view_press',
        'view_eval',
        'request_handoff',
      ])
    })

    it('fullToolName 加上 mcp__yeschef__ 前綴', () => {
      expect(fullToolName('view_click')).toBe('mcp__yeschef__view_click')
      expect(fullToolName('request_handoff')).toBe('mcp__yeschef__request_handoff')
    })

    it('REQUEST_HANDOFF_TOOL 與 VIEW_EVAL_TOOL 是預先算好的全名', () => {
      expect(REQUEST_HANDOFF_TOOL).toBe('mcp__yeschef__request_handoff')
      expect(VIEW_EVAL_TOOL).toBe('mcp__yeschef__view_eval')
    })
  })
  ```

- [ ] **Step 3：跑測試確認失敗**

  ```bash
  npx vitest run tests/view-tools/view-tools-shared.test.ts
  ```
  實跑輸出（`src/shared/view-tools.ts` 還不存在）：
  ```
   FAIL  tests/view-tools/view-tools-shared.test.ts [ tests/view-tools/view-tools-shared.test.ts ]
  Error: Cannot find module '../../src/shared/view-tools.js' imported from .../tests/view-tools/view-tools-shared.test.ts
   Test Files  1 failed (1)
        Tests  no tests
  ```

- [ ] **Step 4：最小實作（`src/shared/view-tools.ts`）**

  ```ts
  /**
   * 右窗格瀏覽器工具的共用常數（契約 §2）。main 與 renderer 都會 import，所以這裡
   * 不引入 Electron，也不引入 `src/main/**` 或 `src/renderer/**` 的任何東西。
   */

  export const VIEW_TOOL_SERVER_NAME = 'yeschef'
  export const VIEW_TOOL_PREFIX = `mcp__${VIEW_TOOL_SERVER_NAME}__`

  export const VIEW_TOOL_NAMES = [
    'view_navigate',
    'view_snapshot',
    'view_screenshot',
    'view_click',
    'view_type',
    'view_press',
    'view_eval',
    'request_handoff',
  ] as const

  export type ViewToolName = (typeof VIEW_TOOL_NAMES)[number]

  /** 模型看到的完整名稱，例：fullToolName('view_click') === 'mcp__yeschef__view_click' */
  export function fullToolName(name: ViewToolName): string {
    return `${VIEW_TOOL_PREFIX}${name}`
  }

  export const REQUEST_HANDOFF_TOOL = fullToolName('request_handoff')
  export const VIEW_EVAL_TOOL = fullToolName('view_eval')
  ```

- [ ] **Step 5：跑測試確認通過**

  ```bash
  npx vitest run tests/view-tools/view-tools-shared.test.ts
  ```
  實跑輸出：
  ```
   Test Files  1 passed (1)
        Tests  4 passed (4)
  ```

- [ ] **Step 6：寫失敗的測試（`src/main/view-tools/policy.ts`）**

  建立 `tests/view-tools/policy.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest'
  import { fullToolName } from '../../src/shared/view-tools.js'
  import { viewToolPolicy } from '../../src/main/view-tools/policy.js'

  describe('viewToolPolicy', () => {
    it('七個非 view_eval 工具都是 allow', () => {
      const names = [
        'view_navigate',
        'view_snapshot',
        'view_screenshot',
        'view_click',
        'view_type',
        'view_press',
        'request_handoff',
      ] as const
      for (const name of names) {
        expect(viewToolPolicy(fullToolName(name))).toBe('allow')
      }
    })

    it('view_eval 是 ask', () => {
      expect(viewToolPolicy(fullToolName('view_eval'))).toBe('ask')
    })

    it('白名單比對而非前綴比對：多打一段的名稱是 ask', () => {
      expect(viewToolPolicy('mcp__yeschef__view_navigate_extra')).toBe('ask')
    })

    it('未知的 mcp__yeschef__ 工具名稱是 ask', () => {
      expect(viewToolPolicy('mcp__yeschef__somethingelse')).toBe('ask')
    })

    it('完全不相干的工具名稱是 ask', () => {
      expect(viewToolPolicy('Read')).toBe('ask')
      expect(viewToolPolicy('')).toBe('ask')
    })
  })
  ```

- [ ] **Step 7：跑測試確認失敗**

  ```bash
  npx vitest run tests/view-tools/policy.test.ts
  ```
  實跑輸出（`src/main/view-tools/policy.ts` 還不存在，這時 `view-tools.ts` 已經在上一步建好）：
  ```
   FAIL  tests/view-tools/policy.test.ts [ tests/view-tools/policy.test.ts ]
  Error: Cannot find module '../../src/main/view-tools/policy.js' imported from .../tests/view-tools/policy.test.ts
   Test Files  1 failed (1)
        Tests  no tests
  ```

- [ ] **Step 8：最小實作（`src/main/view-tools/policy.ts`）**

  ```ts
  import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName } from '../../shared/view-tools.js'

  /**
   * 批准政策（契約 §3）。純函式，不 import Electron。
   *
   * 白名單比對，不是前綴比對：只有 `VIEW_TOOL_NAMES` 裡除 `view_eval` 之外的七個全名回
   * `'allow'`，其餘一律 `'ask'`（含格式相似但不在白名單裡的名稱，例如
   * `mcp__yeschef__view_navigate_extra` 或未知的 `mcp__yeschef__xxx`）。
   */
  export type ToolDecision = 'allow' | 'ask'

  const ALLOW_LIST: ReadonlySet<string> = new Set(
    VIEW_TOOL_NAMES.filter((name) => name !== 'view_eval').map((name) => fullToolName(name))
  )

  export function viewToolPolicy(toolName: string): ToolDecision {
    if (toolName === VIEW_EVAL_TOOL) return 'ask'
    return ALLOW_LIST.has(toolName) ? 'allow' : 'ask'
  }
  ```

- [ ] **Step 9：跑測試確認通過**

  ```bash
  npx vitest run tests/view-tools/policy.test.ts
  ```
  實跑輸出：
  ```
   Test Files  1 passed (1)
        Tests  5 passed (5)
  ```

- [ ] **Step 10：寫失敗的測試（`src/main/view-tools/errors.ts`）**

  建立 `tests/view-tools/errors.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest'
  import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'

  describe('ViewToolError', () => {
    it('name 固定為 ViewToolError，訊息原樣保留', () => {
      const err = new ViewToolError('右窗格不存在')
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('ViewToolError')
      expect(err.message).toBe('右窗格不存在')
    })
  })

  describe('MSG（契約 §10.1，逐字比對）', () => {
    it('固定字串', () => {
      expect(MSG.viewGone).toBe('右窗格不存在')
      expect(MSG.badScheme).toBe('只接受 http、https、file 開頭的網址')
      expect(MSG.refFormat).toBe('ref 格式應為 s<數字>-e<數字>')
      expect(MSG.handoffNoId).toBe('找不到這次交接的 toolUseId，請重試')
      expect(MSG.sessionEnded).toBe('對話已結束')
    })

    it('invalidUrl', () => {
      expect(MSG.invalidUrl('not a url')).toBe('網址無法解析：not a url')
    })

    it('outsideProject', () => {
      expect(MSG.outsideProject('/Users/x/project')).toBe('只允許開啟 /Users/x/project 底下的本地檔案')
    })

    it('navigateFailed', () => {
      expect(MSG.navigateFailed('https://a.test/', '連線逾時')).toBe('無法開啟 https://a.test/：連線逾時')
    })

    it('navigateTimeout', () => {
      expect(MSG.navigateTimeout('https://a.test/')).toBe('頁面在 8 秒內未載入完成，目前網址 https://a.test/')
    })

    it('settleTimeout', () => {
      expect(MSG.settleTimeout(5)).toBe('頁面在 5 秒內未靜默，請 snapshot 確認狀態')
    })

    it('refStale：documentUpdated／navigated／userInput 照原字', () => {
      expect(MSG.refStale(12, 'documentUpdated')).toBe('snapshot s12 已過期（原因：documentUpdated），請先呼叫 view_snapshot')
      expect(MSG.refStale(12, 'navigated')).toBe('snapshot s12 已過期（原因：navigated），請先呼叫 view_snapshot')
      expect(MSG.refStale(12, 'userInput')).toBe('snapshot s12 已過期（原因：userInput），請先呼叫 view_snapshot')
    })

    it('refStale：newer-snapshot 改寫成「已有更新的 snapshot」', () => {
      expect(MSG.refStale(12, 'newer-snapshot')).toBe('snapshot s12 已過期（原因：已有更新的 snapshot），請先呼叫 view_snapshot')
    })

    it('refMissing：取 ref 裡 e 那半段，不是整個 ref', () => {
      expect(MSG.refMissing(3, 's3-e5')).toBe('snapshot s3 沒有 e5 這個節點')
    })

    it('refDetached', () => {
      expect(MSG.refDetached('s3-e5')).toBe('ref s3-e5 指向的元素已不在頁面上，請重新 snapshot')
    })

    it('badKey', () => {
      expect(MSG.badKey('F1', ['Enter', 'Tab'])).toBe('不支援的按鍵 F1，可用：Enter、Tab')
    })

    it('handoffBusy', () => {
      expect(MSG.handoffBusy('填完表單')).toBe('已有一筆交接等待中（填完表單），請等使用者完成')
    })

    it('handoffDone／handoffTimeout', () => {
      expect(MSG.handoffDone('https://a.test/')).toBe('使用者已完成，目前網址 https://a.test/')
      expect(MSG.handoffTimeout('https://a.test/')).toBe('已逾時 10 分鐘，使用者未按確認，目前網址 https://a.test/')
    })

    it('cdpFailed／internal', () => {
      expect(MSG.cdpFailed('timeout', '逾時')).toBe('CDP 指令失敗（timeout）：逾時')
      expect(MSG.internal('boom')).toBe('工具內部錯誤：boom')
    })

    it('navigated／clicked／urlChanged／typed／pressed', () => {
      expect(MSG.navigated('https://a.test/', '標題')).toBe('已到 https://a.test/，標題 標題')
      expect(MSG.clicked('button', '送出')).toBe('已點擊 button "送出"')
      expect(MSG.urlChanged('https://a.test/')).toBe('網址變為 https://a.test/')
      expect(MSG.typed(3, 'textbox', '電子郵件')).toBe('已輸入 3 字元到 textbox "電子郵件"')
      expect(MSG.pressed('Enter')).toBe('已按 Enter')
    })

    it('screenshot：寬高之間是全形乘號 ×，不是英文字母 x', () => {
      expect(MSG.screenshot(1280, 720, 'https://a.test/')).toBe('可視範圍 1280×720，網址 https://a.test/')
    })

    it('evalTruncated', () => {
      expect(MSG.evalTruncated(9000)).toBe('（已截斷，原長 9000 字元）')
    })
  })
  ```

- [ ] **Step 11：跑測試確認失敗**

  ```bash
  npx vitest run tests/view-tools/errors.test.ts
  ```
  實跑輸出（`src/main/view-tools/errors.ts` 還不存在）：
  ```
   FAIL  tests/view-tools/errors.test.ts [ tests/view-tools/errors.test.ts ]
  Error: Cannot find module '../../src/main/view-tools/errors.js' imported from .../tests/view-tools/errors.test.ts
   Test Files  1 failed (1)
        Tests  no tests
  ```

- [ ] **Step 12：最小實作（`src/main/view-tools/errors.ts`）**

  ```ts
  /**
   * 錯誤型別與訊息表（契約 §10.1）。`MSG` 的每一句都是給模型看的繁體中文，
   * server.ts 直接把它當 `isError: true` 的內容回傳，不再包裝或翻譯。
   */

  /** 訊息已是給模型看的繁體中文，server.ts 直接回 isError 文字，不再包裝。 */
  export class ViewToolError extends Error {
    readonly name = 'ViewToolError'
  }

  /**
   * `refStale` 的 reason 字串：`documentUpdated`／`navigated`／`userInput` 照原字，
   * `newer-snapshot`（parseRef 出來的 snapshotId 比目前 RefTable 新）改寫成
   * 「已有更新的 snapshot」（契約 §10.1 段末的規則）。呼叫端不必自己轉換，直接把
   * `RefLookup` 的 `reason` 傳進 `MSG.refStale` 即可。
   */
  function renderStaleReason(reason: string): string {
    return reason === 'newer-snapshot' ? '已有更新的 snapshot' : reason
  }

  export const MSG = {
    viewGone: '右窗格不存在',
    badScheme: '只接受 http、https、file 開頭的網址',
    invalidUrl: (raw: string) => `網址無法解析：${raw}`,
    outsideProject: (projectDir: string) => `只允許開啟 ${projectDir} 底下的本地檔案`,
    navigateFailed: (url: string, errorText: string) => `無法開啟 ${url}：${errorText}`,
    navigateTimeout: (url: string) => `頁面在 8 秒內未載入完成，目前網址 ${url}`,
    settleTimeout: (seconds: number) => `頁面在 ${seconds} 秒內未靜默，請 snapshot 確認狀態`,
    refFormat: 'ref 格式應為 s<數字>-e<數字>',
    refStale: (snapshotId: number, reason: string) =>
      `snapshot s${snapshotId} 已過期（原因：${renderStaleReason(reason)}），請先呼叫 view_snapshot`,
    refMissing: (snapshotId: number, ref: string) => `snapshot s${snapshotId} 沒有 ${ref.split('-')[1]} 這個節點`,
    refDetached: (ref: string) => `ref ${ref} 指向的元素已不在頁面上，請重新 snapshot`,
    badKey: (key: string, names: readonly string[]) => `不支援的按鍵 ${key}，可用：${names.join('、')}`,
    handoffBusy: (reason: string) => `已有一筆交接等待中（${reason}），請等使用者完成`,
    handoffNoId: '找不到這次交接的 toolUseId，請重試',
    handoffDone: (url: string) => `使用者已完成，目前網址 ${url}`,
    handoffTimeout: (url: string) => `已逾時 10 分鐘，使用者未按確認，目前網址 ${url}`,
    sessionEnded: '對話已結束',
    cdpFailed: (code: string, message: string) => `CDP 指令失敗（${code}）：${message}`,
    internal: (message: string) => `工具內部錯誤：${message}`,
    navigated: (url: string, title: string) => `已到 ${url}，標題 ${title}`,
    clicked: (role: string, name: string) => `已點擊 ${role} "${name}"`,
    urlChanged: (url: string) => `網址變為 ${url}`,
    typed: (count: number, role: string, name: string) => `已輸入 ${count} 字元到 ${role} "${name}"`,
    pressed: (key: string) => `已按 ${key}`,
    screenshot: (width: number, height: number, url: string) => `可視範圍 ${width}×${height}，網址 ${url}`,
    evalTruncated: (length: number) => `（已截斷，原長 ${length} 字元）`,
  } as const
  ```

- [ ] **Step 13：跑測試確認通過**

  ```bash
  npx vitest run tests/view-tools/errors.test.ts
  ```
  實跑輸出：
  ```
   Test Files  1 passed (1)
        Tests  18 passed (18)
  ```

- [ ] **Step 14：最小實作（`src/main/view-tools/types.ts`，無執行期邏輯，不寫測試）**

  ```ts
  /**
   * 右窗格工具的核心資料結構（契約 §5，以規格 §4 為基礎的定稿）。只有型別，
   * 沒有執行期邏輯，所以沒有對應的測試檔；`tsc --noEmit` 是唯一的檢查手段。
   */

  export interface Rect {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }

  export interface Point {
    readonly x: number
    readonly y: number
  }

  export interface AxNode {
    readonly ref?: string // 可操作角色才有；heading／image 沒有
    readonly role: string
    readonly name: string
    readonly value?: string
    readonly bounds: Rect // 主視窗 viewport 座標（已加 frame offset）
    readonly states: readonly string[] // 見契約 §6 的 states 表
    readonly backendNodeId: number
    readonly sessionId?: string // 主 target 與同行程 frame 為 undefined
  }

  export interface FrameSnapshot {
    readonly sessionId?: string
    readonly frameId: string
    readonly url: string
    readonly nodes: readonly AxNode[]
  }

  export interface Snapshot {
    readonly id: number
    readonly takenAt: number
    readonly url: string
    readonly title: string
    readonly scope: 'viewport' | 'full'
    readonly frames: readonly FrameSnapshot[]
    readonly unattachedFrames: number // AX 樹抓不到的 frame 數（裁決 6）
    readonly truncated: number // 超過 400 個節點時被截掉的數量
  }

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

  export interface InterventionLog {
    readonly clicks: number
    readonly keys: number
    readonly navigations: number
    readonly fromUrl: string
  }

  export interface HandoffPending {
    readonly toolUseId: string
    readonly reason: string
    readonly askedAt: number
  }

  export type HandoffOutcome = 'done' | 'timeout' | 'session-ended'
  ```

  驗證：`npx tsc --noEmit` 通過（`AxNode`／`RefEntry`／`RefTable` 之後會被 `refs.ts`、`snapshot.ts`、`watch.ts`、`controller.ts` import，這一步只確認型別本身能編譯，沒有執行期行為可測）。

- [ ] **Step 15：寫失敗的測試（`tests/helpers/manual-clock.ts`）**

  建立 `tests/view-tools/manual-clock.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest'
  import { manualClock } from '../helpers/manual-clock.js'

  describe('manualClock', () => {
    it('now() 預設從 0 起，advance 之後累加', () => {
      const { clock, advance, now } = manualClock()
      expect(now()).toBe(0)
      expect(clock.now()).toBe(0)
      advance(100)
      expect(now()).toBe(100)
      expect(clock.now()).toBe(100)
      advance(50)
      expect(now()).toBe(150)
    })

    it('可指定起始時間', () => {
      const { now } = manualClock(1000)
      expect(now()).toBe(1000)
    })

    it('advance(600) 只觸發 500ms 的 timer，5000ms 的還沒到期', () => {
      const { clock, advance } = manualClock()
      const fired: string[] = []
      clock.setTimer(() => fired.push('short'), 500)
      clock.setTimer(() => fired.push('long'), 5000)
      advance(600)
      expect(fired).toEqual(['short'])
    })

    it('之後再 advance 到 5000ms，長 timer 才觸發', () => {
      const { clock, advance } = manualClock()
      const fired: string[] = []
      clock.setTimer(() => fired.push('short'), 500)
      clock.setTimer(() => fired.push('long'), 5000)
      advance(600)
      advance(4400)
      expect(fired).toEqual(['short', 'long'])
    })

    it('due 剛好等於 now 就要觸發（比較式是 <=，不是 <）', () => {
      const { clock, advance } = manualClock()
      let fired = false
      clock.setTimer(() => {
        fired = true
      }, 500)
      advance(500)
      expect(fired).toBe(true)
    })

    it('依到期時間由小到大觸發，不是依註冊順序', () => {
      const { clock, advance } = manualClock()
      const order: string[] = []
      // 刻意用「先註冊的反而晚到期」的順序，讓「不排序、按註冊順序觸發」的突變會被測出來。
      clock.setTimer(() => order.push('due-300'), 300)
      clock.setTimer(() => order.push('due-100'), 100)
      clock.setTimer(() => order.push('due-200'), 200)
      advance(300)
      expect(order).toEqual(['due-100', 'due-200', 'due-300'])
    })

    it('timer 回呼裡新排一個 0ms timer，會在同一輪 advance() 觸發', () => {
      const { clock, advance } = manualClock()
      const order: string[] = []
      clock.setTimer(() => {
        order.push('first')
        clock.setTimer(() => order.push('second'), 0)
      }, 100)
      advance(100)
      expect(order).toEqual(['first', 'second'])
    })

    it('回呼裡新排的 timer 若還沒到期，要等下一次 advance()', () => {
      const { clock, advance } = manualClock()
      const order: string[] = []
      clock.setTimer(() => {
        order.push('first')
        clock.setTimer(() => order.push('second'), 1000)
      }, 100)
      advance(100)
      expect(order).toEqual(['first'])
      advance(1000)
      expect(order).toEqual(['first', 'second'])
    })

    it('clearTimer 之後不會觸發', () => {
      const { clock, advance } = manualClock()
      let fired = false
      const handle = clock.setTimer(() => {
        fired = true
      }, 100)
      clock.clearTimer(handle)
      advance(200)
      expect(fired).toBe(false)
    })

    it('已觸發的 timer 不會重複觸發', () => {
      const { clock, advance } = manualClock()
      let count = 0
      clock.setTimer(() => {
        count += 1
      }, 100)
      advance(100)
      advance(1000)
      expect(count).toBe(1)
    })
  })
  ```

- [ ] **Step 16：跑測試確認失敗**

  ```bash
  npx vitest run tests/view-tools/manual-clock.test.ts
  ```
  實跑輸出（`tests/helpers/manual-clock.ts` 還不存在）：
  ```
   FAIL  tests/view-tools/manual-clock.test.ts [ tests/view-tools/manual-clock.test.ts ]
  Error: Cannot find module '../helpers/manual-clock.js' imported from .../tests/view-tools/manual-clock.test.ts
   Test Files  1 failed (1)
        Tests  no tests
  ```

- [ ] **Step 17：最小實作（`tests/helpers/manual-clock.ts`）**

  ```ts
  import type { MergerClock } from '../../src/main/agent-host.js'

  interface TimerEntry {
    readonly due: number
    readonly fn: () => void
  }

  /**
   * 手動時鐘：計時器不會自己跑，測試呼叫 advance() 才觸發（契約 §14 第一點）。
   *
   * `setTimer(fn, ms)` 記 `due = now + ms`。`advance(ms)` 先把 `now` 推進，
   * 再依 `due` 由小到大逐一觸發所有 `due <= now` 的 timer：每觸發一個就重新掃描一次
   * 目前還在的 timer，所以 timer 回呼裡新排的 timer 若也到期（例如再排一個 0ms
   * 的 timer），會在同一次 advance() 呼叫裡被一併觸發，不必呼叫第二次 advance()。
   *
   * 取代 `tests/agent-host.test.ts` 原本檔內私有的 `manualClock()`：舊版 `advance()`
   * 不看到期時間、一次觸發全部 timer，測不出「500ms 與 5 秒兩個 timer 並存時
   * advance(600) 只觸發前者」這種情境，settle.ts／handoff.ts 的測試需要這個能力。
   */
  export function manualClock(start = 0): {
    readonly clock: MergerClock
    advance(ms: number): void
    now(): number
  } {
    let now = start
    let nextId = 1
    const timers = new Map<number, TimerEntry>()

    function fireDue(): void {
      for (;;) {
        let earliestId: number | null = null
        let earliestDue = Infinity
        for (const [id, entry] of timers) {
          if (entry.due <= now && entry.due < earliestDue) {
            earliestId = id
            earliestDue = entry.due
          }
        }
        if (earliestId === null) return
        const entry = timers.get(earliestId)
        timers.delete(earliestId)
        entry?.fn()
      }
    }

    const clock: MergerClock = {
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextId
        nextId += 1
        timers.set(id, { due: now + ms, fn })
        return id
      },
      clearTimer: (handle) => {
        timers.delete(handle as number)
      },
    }

    return {
      clock,
      advance(ms) {
        now += ms
        fireDue()
      },
      now: () => now,
    }
  }
  ```

  設計說明：`fireDue()` 每觸發一個 timer 就重新掃描整個 `timers` map 找目前到期時間最小的一個，而不是先收集一份快照再逐一觸發。差別只在「timer 回呼裡新排的、也到期的 timer」：先收集快照的寫法會漏掉這種 timer（它們在收集當下還不存在），要下一次 `advance()` 才會被看到；重新掃描版本才符合 Step 15 的「回呼裡新排一個 0ms timer 會在同一輪 advance() 觸發」測試。

- [ ] **Step 18：跑測試確認通過**

  ```bash
  npx vitest run tests/view-tools/manual-clock.test.ts
  ```
  實跑輸出：
  ```
   Test Files  1 passed (1)
        Tests  10 passed (10)
  ```

- [ ] **Step 19：改 `tests/agent-host.test.ts` 改用 helper，跑整套件確認仍全綠**

  這一步沒有新的失敗測試：`tests/agent-host.test.ts` 既有的四處 `manualClock()` 呼叫點（第 45、57、65、165 行）行為不變，只是換了來源。

  第一處編輯，在第 22 行後插入 import（`import type { SessionOptions } from '../src/main/session-args.js'` 之後）：
  ```diff
   import type { ApprovalAsk } from '../src/main/approval.js'
   import type { SessionOptions } from '../src/main/session-args.js'
  +import { manualClock } from './helpers/manual-clock.js'
  ```

  第二處編輯，刪除第 659 到 688 行（`describe` 區塊結束的 `})` 之後、檔案結尾之間的空行與私有 `manualClock` 函式整段）：
  ```diff
       expect(errors.map((e) => e.message).join()).toMatch(/close 爆炸/)
     })
   })
  -
  -/** 手動時鐘：計時器不會自己跑，測試呼叫 advance() 才觸發。與 event-merge.test.ts 同款，兩檔各自持有以免測試互相 import。 */
  -function manualClock(): {
  -  clock: { now: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void }
  -  advance: (ms: number) => void
  -} {
  -  let now = 0
  -  let nextId = 1
  -  const timers = new Map<number, () => void>()
  -  return {
  -    clock: {
  -      now: () => now,
  -      setTimer: (fn) => {
  -        const id = nextId
  -        nextId += 1
  -        timers.set(id, fn)
  -        return id
  -      },
  -      clearTimer: (h) => {
  -        timers.delete(h as number)
  -      },
  -    },
  -    advance: (ms) => {
  -      now += ms
  -      const due = [...timers.values()]
  -      timers.clear()
  -      for (const fn of due) fn()
  -    },
  -  }
  -}
  ```
  上面兩處行號都是對原始（改動前）檔案而言。依序做完（先插入 import，檔案先變成 689 行；再刪掉 30 行的私有 `manualClock`）之後，檔案以 `})` 結尾，總行數是 688 + 1 − 30 = 659 行（`wc -l tests/agent-host.test.ts` 實跑確認）。四個呼叫點 `manualClock()`（第 45、57、65、165 行）不必改：新 helper 的 `start` 參數預設 0，簽章相容，這幾處都只用單一 timer，不受到期排序影響。

  驗證指令與實跑結果（worktree 裡先確認改動前 25 個測試檔、489 條測試全綠，改完 `agent-host.test.ts` 並補上四個新模組與其測試檔之後）：
  ```bash
  npx vitest run
  ```
  ```
   Test Files  29 passed (29)
        Tests  526 passed (526)
  ```
  ```bash
  npx tsc --noEmit
  ```
  零輸出、結束碼 0（沒有錯誤）。

  29 = 25（既有）+ 4（`view-tools-shared.test.ts`／`policy.test.ts`／`errors.test.ts`／`manual-clock.test.ts`）；`agent-host.test.ts` 本身仍是原本那一個測試檔，只是內容變了。526 = 489（既有）+ 4 + 5 + 18 + 10（四個新檔各自的測試數）。

- [ ] **Step 20：突變測試（五個，全部在 worktree 實跑）**

  **突變 1（`manual-clock.ts`）：拿掉到期排序，改成「掃到第一個 due <= now 的就觸發」而不是「找 due 最小的」**
  ```diff
       function fireDue(): void {
         for (;;) {
  -        let earliestId: number | null = null
  -        let earliestDue = Infinity
  -        for (const [id, entry] of timers) {
  -          if (entry.due <= now && entry.due < earliestDue) {
  -            earliestId = id
  -            earliestDue = entry.due
  -          }
  -        }
  -        if (earliestId === null) return
  -        const entry = timers.get(earliestId)
  -        timers.delete(earliestId)
  +        let readyId: number | null = null
  +        for (const [id, entry] of timers) {
  +          if (entry.due <= now) {
  +            readyId = id
  +            break
  +          }
  +        }
  +        if (readyId === null) return
  +        const entry = timers.get(readyId)
  +        timers.delete(readyId)
           entry?.fn()
         }
       }
  ```
  ```bash
  npx vitest run tests/view-tools/manual-clock.test.ts
  ```
  變紅：`依到期時間由小到大觸發，不是依註冊順序`（1 個失敗，其餘 9 個仍綠）。還原後 `npx vitest run tests/view-tools/manual-clock.test.ts` 回到 10 passed (10)。

  **突變 2（`manual-clock.ts`）：`due <= now` 改成 `due < now`**
  ```diff
  -        if (entry.due <= now && entry.due < earliestDue) {
  +        if (entry.due < now && entry.due < earliestDue) {
  ```
  ```bash
  npx vitest run tests/view-tools/manual-clock.test.ts
  ```
  變紅：5 個測試失敗（`之後再 advance 到 5000ms，長 timer 才觸發`、`due 剛好等於 now 就要觸發（比較式是 <=，不是 <）`、`依到期時間由小到大觸發，不是依註冊順序`、`timer 回呼裡新排一個 0ms timer，會在同一輪 advance() 觸發`、`回呼裡新排的 timer 若還沒到期，要等下一次 advance()`），5 passed（10）。這個突變的影響面比前一個大：專案裡多數 timer 測試都用整數毫秒的 `advance()` 精準對齊 due，這個判斷式一壞會連坐好幾條測試。還原後 10 passed (10)。

  **突變 3（`policy.ts`）：白名單改成前綴比對（`toolName.startsWith(VIEW_TOOL_PREFIX)`），一個看起來更「通用」但錯的簡化**
  ```diff
  -import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName } from '../../shared/view-tools.js'
  +import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, VIEW_TOOL_PREFIX, fullToolName } from '../../shared/view-tools.js'
   ...
   export function viewToolPolicy(toolName: string): ToolDecision {
     if (toolName === VIEW_EVAL_TOOL) return 'ask'
  -  return ALLOW_LIST.has(toolName) ? 'allow' : 'ask'
  +  return toolName.startsWith(VIEW_TOOL_PREFIX) ? 'allow' : 'ask'
   }
  ```
  ```bash
  npx vitest run tests/view-tools/policy.test.ts
  ```
  變紅：`白名單比對而非前綴比對：多打一段的名稱是 ask`、`未知的 mcp__yeschef__ 工具名稱是 ask`，2 個失敗、3 passed。這正是契約 §3 特別強調的那句「白名單比對，不是前綴比對」要防的錯誤，也是為什麼測試不能只測「七個工具都 allow、view_eval 是 ask」（那樣兩種實作都會通過）。還原後 5 passed (5)。

  **突變 4（`errors.ts`）：拿掉 `refStale` 裡的 `newer-snapshot` 轉譯**
  ```diff
     refStale: (snapshotId: number, reason: string) =>
  -    `snapshot s${snapshotId} 已過期（原因：${renderStaleReason(reason)}），請先呼叫 view_snapshot`,
  +    `snapshot s${snapshotId} 已過期（原因：${reason}），請先呼叫 view_snapshot`,
  ```
  ```bash
  npx vitest run tests/view-tools/errors.test.ts
  ```
  變紅：`refStale：newer-snapshot 改寫成「已有更新的 snapshot」`，1 個失敗（`snapshot s12 已過期（原因：newer-snapshot）...` 而非預期的「已有更新的 snapshot」），17 passed。還原後 18 passed (18)。

  **突變 5（`errors.ts`）：`refMissing` 直接用整個 `ref`，不取 `e<n>` 那半段**
  ```diff
  -  refMissing: (snapshotId: number, ref: string) => `snapshot s${snapshotId} 沒有 ${ref.split('-')[1]} 這個節點`,
  +  refMissing: (snapshotId: number, ref: string) => `snapshot s${snapshotId} 沒有 ${ref} 這個節點`,
  ```
  ```bash
  npx vitest run tests/view-tools/errors.test.ts
  ```
  變紅：`refMissing：取 ref 裡 e 那半段，不是整個 ref`（收到 `snapshot s3 沒有 s3-e5 這個節點`，預期 `snapshot s3 沒有 e5 這個節點`），1 個失敗，17 passed。還原後 18 passed (18)。

  五個突變全部先變紅（且只紅該紅的測試，其餘同檔測試維持綠燈），還原後個別測試檔與 `npx vitest run` 整套件都回到 526 passed (526)，`npx tsc --noEmit` 零錯誤。

- [ ] **Step 21：提交**

  ```bash
  git add package.json package-lock.json \
    src/shared/view-tools.ts \
    src/main/view-tools/policy.ts \
    src/main/view-tools/errors.ts \
    src/main/view-tools/types.ts \
    tests/helpers/manual-clock.ts \
    tests/agent-host.test.ts \
    tests/view-tools/view-tools-shared.test.ts \
    tests/view-tools/policy.test.ts \
    tests/view-tools/errors.test.ts \
    tests/view-tools/manual-clock.test.ts
  git commit -m "feat: 右窗格工具共用常數、批准政策、錯誤表、型別與 manual-clock helper"
  ```

---

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

---

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

---

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

---

### Task 4: snapshot 純函式與 fixture（snapshot.ts）

`view_snapshot` 的難處不在抓資料，在把一棵幾百到幾千個節點的無障礙樹壓成模型讀得懂又不爆 context 的文字。這個 task 只做「壓」這件事，把它寫成一個沒有副作用的函式：輸入是已經蒐集好的 AX 樹、矩形表與 viewport（Task 5 的 `collectSnapshotInput` 負責生產），輸出是 `Snapshot`、`RefTable` 與文字三件套。這樣切的理由是 CDP 蒐集那段沒辦法在單元測試裡跑，而過濾與編號的規則正是最容易寫錯又最難從實機看出錯的部分：ref 錯一號，agent 就點到隔壁的按鈕。

八條規則裡有三條是實機教出來的。第一條「從 `nodes[0]` 起依 `childIds` 深度優先」：`Accessibility.getFullAXTree` 的 `nodes` 陣列順序不保證等於樹的前序，照陣列跑會得到跟畫面不一樣的順序，所以本檔的 fixture 故意把陣列打亂（只留 `nodes[0]` 是 RootWebArea），實機抓回來的 `form.real.json` 陣列是前序，兩份都要過同一組測試。第二條「沒有矩形就略過」：`display: none` 的元素在 AX 樹裡還在，`DOM.getBoxModel` 會失敗，Task 5 不會把它放進 `boxes`，這裡直接當它不存在。第三條「structural 角色要求 name 非空」：沒有 alt 的 `<img>` 在 AX 樹裡是 `role: image` 且 `name: ''`，列出來只是浪費行數。

ref 只配給可操作角色，heading 與 image 出現在文字裡但沒有 ref 欄。這是刻意的：模型需要 heading 來判斷自己在頁面的哪一區，但點 heading 沒有意義，給了 ref 反而誘導它去點。編號 `e<n>` 從 0 起、跨 frame 連續遞增、structural 節點不佔號（契約 §6 規則 5 與文字格式範例的 `s12-e0`／`s12-e1`／`s12-e2` 一致）。

座標一律換算成主視窗 viewport 座標：`bounds` = frame 自身的 border 矩形加上 `FrameInput.offset`（OOPIF 才非零，裁決 7）。`scope: 'viewport'` 的可視判定用換算後的 `bounds` 比對，而且是閉區間（邊緣相切算看得到）。這兩件事在測試裡都用非零 offset 與不對稱矩形釘死，因為 offset 為 0、矩形正方形的測試對「忘了加 offset」「x 與 y 寫反」「開區間寫成閉區間」三種寫法都會巧合地通過。

本檔只依賴 `types.ts` 的型別，不 import Electron、不 import CDP，也不讀時鐘：`takenAt` 與 `id` 都由呼叫端給。`formatSnapshotText` 另外收一個 `intervention` 字串（`watch.ts` 的 `summarizeIntervention` 輸出，契約 §9.3），Task 9 的 controller 會把兩者串起來。

**Files:**

- Create `src/main/view-tools/snapshot.ts`（265 行，契約 §6 的全部匯出；未超過 400 行，不拆 `snapshot-text.ts`）
- Create `tests/fixtures/ax/form.json`（手寫的 `Accessibility.getFullAXTree` 回傳）
- Create `tests/fixtures/view/form.html`（與 `form.json` 對應的最小頁面，Task 14 用它抓 `form.real.json`）
- Test `tests/view-tools/snapshot.test.ts`（494 行，39 個測試）

**Interfaces:**

Consumes（Task 0 的 `src/main/view-tools/types.ts`）：

```ts
import type { AxNode, FrameSnapshot, Point, Rect, RefEntry, RefTable, Snapshot } from './types.js'
```

Task 0 若尚未完成，先照契約 §5 把 `types.ts` 建出來（只有型別，沒有值），內容逐字照契約 §5 的程式碼區塊。

Produces（契約 §6 全部）：

```ts
export interface AxRawNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value: unknown }
  readonly name?: { readonly value: unknown }
  readonly value?: { readonly value: unknown }
  readonly properties?: readonly { readonly name: string; readonly value: { readonly value: unknown } }[]
  readonly childIds?: readonly string[]
  readonly backendDOMNodeId?: number
}
export interface FrameInput {
  readonly sessionId?: string
  readonly frameId: string
  readonly url: string
  readonly offset: Point
  readonly nodes: readonly AxRawNode[]
  readonly boxes: ReadonlyMap<number, Rect>
}
export interface SnapshotInput {
  readonly id: number
  readonly takenAt: number
  readonly url: string
  readonly title: string
  readonly scope: 'viewport' | 'full'
  readonly viewport: Rect
  readonly frames: readonly FrameInput[]
  readonly unattachedFrames: number
}
export interface SnapshotResult {
  readonly snapshot: Snapshot
  readonly refs: RefTable
  readonly text: string
}
export const MAX_SNAPSHOT_NODES = 400
export const INTERACTIVE_ROLES: ReadonlySet<string>
export const STRUCTURAL_ROLES: ReadonlySet<string>
export function buildSnapshot(input: SnapshotInput): SnapshotResult
export function rectsIntersect(a: Rect, b: Rect): boolean
export function formatSnapshotText(snapshot: Snapshot, intervention?: string | null): string
```

下游：Task 5 的 `collectSnapshotInput` 產生 `SnapshotInput`；Task 9 的 controller 呼叫 `buildSnapshot` 與 `formatSnapshotText(snapshot, summary)`（第二參數收 `string | null | undefined`，裁決 22）；Task 14 把實機抓到的 `form.real.json` 加進本檔測試的 `AX_FIXTURES` 陣列。

---

- [ ] **Step 1a: 建兩份 fixture**

`tests/fixtures/view/form.html`（Task 14 會用 `spikes/capture-ax.ts` 對這個檔抓 `form.real.json`）：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>訂單確認</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 80px 120px; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <h1>訂單</h1>
    <div>
      <label>電子郵件<input type="email" name="email" required /></label>
      <label>收件人<input type="text" name="recipient" value="王小明" /></label>
      <label>訂閱電子報<input type="checkbox" name="news" checked /></label>
      <button type="button" disabled>刪除</button>
      <button type="button" class="hidden">隱藏</button>
    </div>
    <a href="/help">說明</a>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="商品圖" width="100" height="100" />
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="100" height="100" />
  </body>
</html>
```

`tests/fixtures/ax/form.json`：手寫，形狀照 `Accessibility.getFullAXTree` 的 `{ nodes: AXNode[] }`。三個刻意的安排：

1. `nodes[0]` 是 RootWebArea，其餘節點的陣列順序刻意打亂（不是前序），用來釘死「照 `childIds` 走，不照陣列走」。
2. `checked` 用 `{ "type": "tristate", "value": "true" }`：CDP 的 `AXPropertyName.checked` 對應 `AXValueType.tristate`，值是字串（Task 14 用 Electron 44 實機抓的 `form.real.json` 確認就是這個形狀；契約 §6 規則 6 同時接受字串與 boolean）。`disabled` 用 `boolean`、`required` 用 `booleanOrUndefined`。
3. 每個 textbox 都帶 `invalid`／`focusable`／`editable`／`settable`／`multiline`／`readonly` 這些 Chrome 實際會回的 property，用來釘死「表外的 property 一律不看」與「`readonly: false` 不產生 state」。

```json
{
  "nodes": [
    {
      "nodeId": "1",
      "ignored": false,
      "role": { "type": "internalRole", "value": "RootWebArea" },
      "name": { "type": "computedString", "value": "訂單確認" },
      "childIds": ["2", "3", "14", "16", "17"],
      "backendDOMNodeId": 1,
      "frameId": "FRAME-ROOT"
    },
    {
      "nodeId": "16",
      "ignored": false,
      "role": { "type": "role", "value": "image" },
      "name": { "type": "computedString", "value": "商品圖" },
      "childIds": [],
      "backendDOMNodeId": 116
    },
    {
      "nodeId": "4",
      "ignored": false,
      "role": { "type": "role", "value": "textbox" },
      "name": { "type": "computedString", "value": "電子郵件" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "editable", "value": { "type": "token", "value": "plaintext" } },
        { "name": "settable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "multiline", "value": { "type": "boolean", "value": false } },
        { "name": "readonly", "value": { "type": "booleanOrUndefined", "value": false } },
        { "name": "required", "value": { "type": "booleanOrUndefined", "value": true } }
      ],
      "childIds": [],
      "backendDOMNodeId": 104
    },
    {
      "nodeId": "20",
      "ignored": false,
      "role": { "type": "internalRole", "value": "StaticText" },
      "name": { "type": "computedString", "value": "訂單" },
      "childIds": [],
      "backendDOMNodeId": 102
    },
    {
      "nodeId": "10",
      "ignored": false,
      "role": { "type": "role", "value": "button" },
      "name": { "type": "computedString", "value": "刪除" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "disabled", "value": { "type": "boolean", "value": true } }
      ],
      "childIds": [],
      "backendDOMNodeId": 110
    },
    {
      "nodeId": "3",
      "ignored": false,
      "role": { "type": "role", "value": "generic" },
      "name": { "type": "computedString", "value": "" },
      "childIds": ["4", "6", "8", "10", "12"],
      "backendDOMNodeId": 103
    },
    {
      "nodeId": "17",
      "ignored": false,
      "role": { "type": "role", "value": "image" },
      "name": { "type": "computedString", "value": "" },
      "childIds": [],
      "backendDOMNodeId": 117
    },
    {
      "nodeId": "8",
      "ignored": false,
      "role": { "type": "role", "value": "checkbox" },
      "name": { "type": "computedString", "value": "訂閱電子報" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "checked", "value": { "type": "tristate", "value": "true" } }
      ],
      "childIds": [],
      "backendDOMNodeId": 108
    },
    {
      "nodeId": "14",
      "ignored": false,
      "role": { "type": "role", "value": "link" },
      "name": { "type": "computedString", "value": "說明" },
      "properties": [
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } }
      ],
      "childIds": ["21"],
      "backendDOMNodeId": 114
    },
    {
      "nodeId": "6",
      "ignored": false,
      "role": { "type": "role", "value": "textbox" },
      "name": { "type": "computedString", "value": "收件人" },
      "value": { "type": "string", "value": "王小明" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "editable", "value": { "type": "token", "value": "plaintext" } },
        { "name": "settable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "multiline", "value": { "type": "boolean", "value": false } },
        { "name": "readonly", "value": { "type": "booleanOrUndefined", "value": false } },
        { "name": "required", "value": { "type": "booleanOrUndefined", "value": false } }
      ],
      "childIds": [],
      "backendDOMNodeId": 106
    },
    {
      "nodeId": "21",
      "ignored": false,
      "role": { "type": "internalRole", "value": "StaticText" },
      "name": { "type": "computedString", "value": "說明" },
      "childIds": [],
      "backendDOMNodeId": 115
    },
    {
      "nodeId": "12",
      "ignored": true,
      "ignoredReasons": [{ "name": "notRendered", "value": { "type": "boolean", "value": true } }],
      "role": { "type": "role", "value": "none" },
      "name": { "type": "computedString", "value": "隱藏" },
      "childIds": [],
      "backendDOMNodeId": 112
    },
    {
      "nodeId": "2",
      "ignored": false,
      "role": { "type": "role", "value": "heading" },
      "name": { "type": "computedString", "value": "訂單" },
      "properties": [{ "name": "level", "value": { "type": "integer", "value": 1 } }],
      "childIds": ["20"],
      "backendDOMNodeId": 101
    }
  ]
}
```

---

- [ ] **Step 1b: 寫失敗的測試**

`tests/view-tools/snapshot.test.ts` 全文（分三段貼，實際是同一個檔）。

`boxes` 不能用 `backendDOMNodeId` 當 key 寫死在測試裡：手寫的 `form.json` 與實機的 `form.real.json` 的 id 不同。改成用「角色｜名稱」查表，兩份 fixture 都適用；`display: none` 的 `button "隱藏"` 不在表裡（也是 `ignored: true`），兩條規則都會濾掉它，實機 fixture 不管把它標成哪一種都能過。

第一段（載入與工具函式）：

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildSnapshot,
  formatSnapshotText,
  rectsIntersect,
  INTERACTIVE_ROLES,
  STRUCTURAL_ROLES,
  MAX_SNAPSHOT_NODES,
  type AxRawNode,
  type FrameInput,
  type SnapshotInput,
} from '../../src/main/view-tools/snapshot.js'
import type { Rect } from '../../src/main/view-tools/types.js'

/**
 * Task 14 抓到實機的 form.real.json 之後只要加進這個陣列，同一組測試就會對它再跑一次。
 * 兩份 fixture 的差異只准出現在 nodeId 與屬性順序，所以測試不看 nodeId 也不看順序。
 */
const AX_FIXTURES = ['form.json'] as const

/** 矩形以「角色｜名稱」對應，才不會綁死 backendDOMNodeId（兩份 fixture 的 id 不同）。 */
const FORM_BOXES: ReadonlyMap<string, Rect> = new Map([
  ['heading|訂單', { x: 120, y: 80, width: 200, height: 32 }],
  ['textbox|電子郵件', { x: 120, y: 140, width: 240, height: 24 }],
  ['textbox|收件人', { x: 120, y: 180, width: 240, height: 24 }],
  ['checkbox|訂閱電子報', { x: 120, y: 220, width: 16, height: 16 }],
  ['button|刪除', { x: 120, y: 260, width: 80, height: 30 }],
  ['link|說明', { x: 120, y: 300, width: 60, height: 20 }],
  ['image|商品圖', { x: 120, y: 340, width: 100, height: 100 }],
  ['image|', { x: 120, y: 460, width: 100, height: 100 }],
])

function readAxFixture(file: string): readonly AxRawNode[] {
  const raw: unknown = JSON.parse(readFileSync(`tests/fixtures/ax/${file}`, 'utf8'))
  const nodes = (raw as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) throw new Error(`fixture ${file} 沒有 nodes 陣列`)
  return nodes as readonly AxRawNode[]
}

/** display: none 的 button 拿不到矩形（getBoxModel 會失敗），所以不進 boxes。 */
function boxesFor(nodes: readonly AxRawNode[]): ReadonlyMap<number, Rect> {
  const out = new Map<number, Rect>()
  for (const node of nodes) {
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const name = typeof node.name?.value === 'string' ? node.name.value : ''
    const box = FORM_BOXES.get(`${role}|${name}`)
    if (node.ignored === false && node.backendDOMNodeId !== undefined && box !== undefined) {
      out.set(node.backendDOMNodeId, box)
    }
  }
  return out
}

function formInput(file: string, over: Partial<SnapshotInput> = {}): SnapshotInput {
  const nodes = readAxFixture(file)
  return {
    id: 7,
    takenAt: 1_700_000_000_000,
    url: 'https://example.test/form.html',
    title: '訂單確認',
    scope: 'full',
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    frames: [{ frameId: 'FRAME-ROOT', url: 'https://example.test/form.html', offset: { x: 0, y: 0 }, nodes, boxes: boxesFor(nodes) }],
    unattachedFrames: 0,
    ...over,
  }
}

/** 合成節點：只放規則用得到的欄位。 */
function raw(id: string, role: string, name: string, over: Partial<AxRawNode> = {}): AxRawNode {
  return { nodeId: id, ignored: false, role: { value: role }, name: { value: name }, childIds: [], backendDOMNodeId: Number(id), ...over }
}

function frame(nodes: readonly AxRawNode[], boxes: ReadonlyMap<number, Rect>, over: Partial<FrameInput> = {}): FrameInput {
  return { frameId: 'F', url: 'https://example.test/', offset: { x: 0, y: 0 }, nodes, boxes, ...over }
}

function input(frames: readonly FrameInput[], over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    id: 1,
    takenAt: 0,
    url: 'https://example.test/',
    title: 'T',
    scope: 'full',
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    frames,
    unattachedFrames: 0,
    ...over,
  }
}

const BOX: Rect = { x: 10, y: 10, width: 10, height: 10 }
function boxesOf(...ids: readonly number[]): ReadonlyMap<number, Rect> {
  return new Map(ids.map((id) => [id, BOX]))
}

describe('fixture 守衛', () => {
  it.each(AX_FIXTURES)('%s 讀得到節點（fixture 被誤刪時測試會對空陣列跑然後全過）', (file) => {
    const nodes = readAxFixture(file)
    expect(nodes.length).toBeGreaterThanOrEqual(10)
    expect(boxesFor(nodes).size).toBe(FORM_BOXES.size)
  })
})

describe.each(AX_FIXTURES)('fixture %s：整棵 AX 樹的文字輸出', (file) => {
  it('依 childIds 深度優先排序，不是 nodes 陣列順序；ref 只給互動角色且從 e0 連續遞增', () => {
    const { snapshot, text } = buildSnapshot(formInput(file))
    expect(text).toBe(
      [
        '[page] 訂單確認 https://example.test/form.html',
        'heading "訂單"',
        's7-e0 textbox "電子郵件" (required)',
        's7-e1 textbox "收件人" value="王小明"',
        's7-e2 checkbox "訂閱電子報" (checked)',
        's7-e3 button "刪除" (disabled)',
        's7-e4 link "說明"',
        'image "商品圖"',
      ].join('\n'),
    )
    expect(snapshot.frames[0]?.nodes.map((n) => n.ref)).toEqual([
      undefined, 's7-e0', 's7-e1', 's7-e2', 's7-e3', 's7-e4', undefined,
    ])
  })

  it('display: none 的 button 與沒有 alt 的 image 都不出現，truncated 為 0', () => {
    const { snapshot, text } = buildSnapshot(formInput(file))
    expect(text).not.toContain('隱藏')
    expect(text.match(/image /g)).toHaveLength(1)
    expect(snapshot.truncated).toBe(0)
    expect(snapshot.frames[0]?.nodes).toHaveLength(7)
  })

  it('RefTable 的 key 是完整 ref、entries 帶 role 與 name，invalidatedBy 不設', () => {
    const { refs } = buildSnapshot(formInput(file))
    expect(refs.snapshotId).toBe(7)
    expect([...refs.entries.keys()]).toEqual(['s7-e0', 's7-e1', 's7-e2', 's7-e3', 's7-e4'])
    expect(refs.entries.get('s7-e3')).toEqual({ backendNodeId: expect.any(Number), role: 'button', name: '刪除' })
    expect(refs.invalidatedBy).toBeUndefined()
  })

  it('scope viewport 只留與 viewport 有交集的節點（y 260 的按鈕被 250 高的 viewport 濾掉）', () => {
    const { text } = buildSnapshot(formInput(file, { scope: 'viewport', viewport: { x: 0, y: 0, width: 800, height: 250 } }))
    expect(text.split('\n').slice(1)).toEqual([
      'heading "訂單"',
      's7-e0 textbox "電子郵件" (required)',
      's7-e1 textbox "收件人" value="王小明"',
      's7-e2 checkbox "訂閱電子報" (checked)',
    ])
  })

  it('scope full 不看 viewport：viewport 縮到 1x1 仍然七個節點', () => {
    const { snapshot } = buildSnapshot(formInput(file, { scope: 'full', viewport: { x: 0, y: 0, width: 1, height: 1 } }))
    expect(snapshot.frames[0]?.nodes).toHaveLength(7)
  })
})

```

第二段（座標、候選門檻、走訪、states、value）：

```ts
describe('rectsIntersect', () => {
  it('邊緣相切算有交集（閉區間）', () => {
    expect(rectsIntersect({ x: 100, y: 50, width: 20, height: 10 }, { x: 120, y: 50, width: 30, height: 10 })).toBe(true)
    expect(rectsIntersect({ x: 100, y: 40, width: 20, height: 10 }, { x: 100, y: 50, width: 20, height: 10 })).toBe(true)
  })

  it('差一單位就不相交', () => {
    expect(rectsIntersect({ x: 100, y: 50, width: 20, height: 10 }, { x: 121, y: 50, width: 30, height: 10 })).toBe(false)
    expect(rectsIntersect({ x: 100, y: 39, width: 20, height: 10 }, { x: 100, y: 50, width: 20, height: 10 })).toBe(false)
  })

  it('x 與 y 互換會得到不同答案（矩形不對稱，交換軸的實作會被抓到）', () => {
    const a: Rect = { x: 300, y: 10, width: 20, height: 500 }
    const b: Rect = { x: 0, y: 0, width: 100, height: 600 }
    expect(rectsIntersect(a, b)).toBe(false)
    expect(rectsIntersect({ x: a.y, y: a.x, width: a.height, height: a.width }, b)).toBe(true)
  })
})

describe('bounds 與 frame offset', () => {
  const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'button', '送出')]
  const boxes = new Map([[2, { x: 30, y: 20, width: 40, height: 10 }]])

  it('bounds 是矩形加上 frame offset（非零 offset）', () => {
    const { snapshot } = buildSnapshot(input([frame(nodes, boxes, { offset: { x: 120, y: 80 } })]))
    expect(snapshot.frames[0]?.nodes[0]?.bounds).toEqual({ x: 150, y: 100, width: 40, height: 10 })
  })

  it('viewport 判定用加過 offset 的 bounds：沒加 offset 會誤留在畫面外的節點', () => {
    const far = frame(nodes, boxes, { offset: { x: 900, y: 700 } })
    const kept = buildSnapshot(input([far], { scope: 'viewport', viewport: { x: 0, y: 0, width: 800, height: 600 } }))
    expect(kept.snapshot.frames[0]?.nodes).toHaveLength(0)
    const near = frame(nodes, boxes, { offset: { x: 120, y: 80 } })
    const inView = buildSnapshot(input([near], { scope: 'viewport', viewport: { x: 0, y: 0, width: 800, height: 600 } }))
    expect(inView.snapshot.frames[0]?.nodes).toHaveLength(1)
  })

  it('offset 的 x 與 y 不可互換：只在 y 方向超出時要被濾掉', () => {
    const out = buildSnapshot(input([frame(nodes, boxes, { offset: { x: 100, y: 700 } })], {
      scope: 'viewport',
      viewport: { x: 0, y: 0, width: 800, height: 400 },
    }))
    expect(out.snapshot.frames[0]?.nodes).toHaveLength(0)
    const swapped = buildSnapshot(input([frame(nodes, boxes, { offset: { x: 700, y: 100 } })], {
      scope: 'viewport',
      viewport: { x: 0, y: 0, width: 800, height: 400 },
    }))
    expect(swapped.snapshot.frames[0]?.nodes).toHaveLength(1)
  })
})

describe('候選節點的四道門檻', () => {
  const root = raw('1', 'RootWebArea', '', { childIds: ['2', '3', '4', '5', '6'] })

  it('ignored 為 true 的節點就算有矩形也不收', () => {
    const nodes = [root, raw('2', 'button', '甲', { ignored: true }), raw('3', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('boxes 沒有矩形的節點不收（getBoxModel 失敗等同不存在）', () => {
    const nodes = [root, raw('2', 'button', '甲'), raw('3', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(3))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('沒有 backendDOMNodeId 的節點不收', () => {
    const nodes = [root, { ...raw('2', 'button', '甲'), backendDOMNodeId: undefined }, raw('3', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('白名單外的角色不收；structural 角色名稱為空也不收，但互動角色名稱為空要收', () => {
    const nodes = [
      root,
      raw('2', 'paragraph', '段落'),
      raw('3', 'heading', ''),
      raw('4', 'button', ''),
      raw('5', 'heading', '標題'),
      { ...raw('6', 'button', '壞角色'), role: { value: 42 } },
    ]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3, 4, 5, 6))]))
    expect(snapshot.frames[0]?.nodes.map((n) => `${n.role}|${n.name}`)).toEqual(['button|', 'heading|標題'])
  })

  it('INTERACTIVE_ROLES 與 STRUCTURAL_ROLES 的內容照契約 §6', () => {
    expect([...INTERACTIVE_ROLES].sort()).toEqual(
      ['button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox'],
    )
    expect([...STRUCTURAL_ROLES].sort()).toEqual(['heading', 'image'])
  })
})

describe('走訪順序', () => {
  it('nodes 陣列順序與 childIds 順序相反時，輸出照 childIds', () => {
    const nodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2', '3'] }),
      raw('3', 'button', '丙', { childIds: [] }),
      raw('2', 'button', '乙', { childIds: ['4'] }),
      raw('4', 'button', '丁'),
    ]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3, 4))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙', '丁', '丙'])
  })

  it('找不到的 childId 略過，不中斷同一層後面的兄弟', () => {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['9', '2'] }), raw('2', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('nodes 為空的 frame 得到空節點清單', () => {
    const { snapshot } = buildSnapshot(input([frame([], new Map())]))
    expect(snapshot.frames[0]?.nodes).toEqual([])
  })
})

describe('states', () => {
  function statesOf(properties: readonly { name: string; value: { value: unknown } }[]): readonly string[] {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'checkbox', 'X', { properties })]
    return buildSnapshot(input([frame(nodes, boxesOf(2))])).snapshot.frames[0]?.nodes[0]?.states ?? []
  }

  it('輸出順序固定，與 properties 的排列無關', () => {
    const props = [
      { name: 'pressed', value: { value: 'true' } },
      { name: 'required', value: { value: true } },
      { name: 'checked', value: { value: 'true' } },
      { name: 'disabled', value: { value: true } },
      { name: 'focused', value: { value: true } },
      { name: 'expanded', value: { value: true } },
      { name: 'selected', value: { value: true } },
      { name: 'readonly', value: { value: true } },
    ]
    const expected = ['disabled', 'checked', 'expanded', 'selected', 'required', 'focused', 'readonly', 'pressed']
    expect(statesOf(props)).toEqual(expected)
    expect(statesOf([...props].reverse())).toEqual(expected)
  })

  it('checked 的三種值分別對到 checked／unchecked／mixed，boolean 與 tristate 都吃', () => {
    expect(statesOf([{ name: 'checked', value: { value: 'true' } }])).toEqual(['checked'])
    expect(statesOf([{ name: 'checked', value: { value: true } }])).toEqual(['checked'])
    expect(statesOf([{ name: 'checked', value: { value: 'false' } }])).toEqual(['unchecked'])
    expect(statesOf([{ name: 'checked', value: { value: false } }])).toEqual(['unchecked'])
    expect(statesOf([{ name: 'checked', value: { value: 'mixed' } }])).toEqual(['mixed'])
  })

  it('expanded 為 false 是 collapsed；disabled／required 為 false 不產生任何 state', () => {
    expect(statesOf([{ name: 'expanded', value: { value: false } }])).toEqual(['collapsed'])
    expect(statesOf([{ name: 'disabled', value: { value: false } }, { name: 'required', value: { value: false } }])).toEqual([])
  })

  it('表外的 property 一律不看（focusable、editable、invalid、level）', () => {
    expect(statesOf([
      { name: 'focusable', value: { value: true } },
      { name: 'editable', value: { value: 'plaintext' } },
      { name: 'invalid', value: { value: 'false' } },
      { name: 'level', value: { value: 1 } },
    ])).toEqual([])
  })
})

describe('value', () => {
  function valueOf(value: unknown): string | undefined {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), { ...raw('2', 'textbox', 'X'), value: { value } }]
    return buildSnapshot(input([frame(nodes, boxesOf(2))])).snapshot.frames[0]?.nodes[0]?.value
  }

  it('只有非空字串才帶 value', () => {
    expect(valueOf('王小明')).toBe('王小明')
    expect(valueOf('')).toBeUndefined()
    expect(valueOf(0)).toBeUndefined()
    expect(valueOf(null)).toBeUndefined()
  })
})

```

第三段（400 上限、多 frame、文字格式、純函式性質）：

```ts
describe('400 上限', () => {
  function manyNodes(count: number): readonly AxRawNode[] {
    const ids = Array.from({ length: count }, (_, i) => String(i + 2))
    return [
      raw('1', 'RootWebArea', '', { childIds: ids }),
      ...ids.map((id, i) => raw(id, 'button', `按鈕${i}`)),
    ]
  }

  it('450 個候選只留 DFS 前 400 個，truncated 為 50', () => {
    const nodes = manyNodes(450)
    const boxes = new Map(nodes.slice(1).map((n) => [n.backendDOMNodeId ?? 0, BOX]))
    const { snapshot } = buildSnapshot(input([frame(nodes, boxes)]))
    const kept = snapshot.frames[0]?.nodes ?? []
    expect(kept).toHaveLength(MAX_SNAPSHOT_NODES)
    expect(snapshot.truncated).toBe(50)
    expect(kept[0]?.name).toBe('按鈕0')
    expect(kept[399]?.name).toBe('按鈕399')
    expect(kept.some((n) => n.name === '按鈕400')).toBe(false)
    expect(kept[399]?.ref).toBe('s1-e399')
  })

  it('剛好 400 個不算截斷', () => {
    const nodes = manyNodes(400)
    const boxes = new Map(nodes.slice(1).map((n) => [n.backendDOMNodeId ?? 0, BOX]))
    const { snapshot, text } = buildSnapshot(input([frame(nodes, boxes)]))
    expect(snapshot.truncated).toBe(0)
    expect(text).not.toContain('未列出')
  })

  it('被 viewport 濾掉的節點不算進 400 也不算進 truncated', () => {
    const nodes = manyNodes(410)
    const boxes = new Map(nodes.slice(1).map((n, i) => [n.backendDOMNodeId ?? 0, i < 20 ? { x: 5000, y: 5000, width: 10, height: 10 } : BOX]))
    const { snapshot } = buildSnapshot(input([frame(nodes, boxes)], { scope: 'viewport' }))
    expect(snapshot.frames[0]?.nodes).toHaveLength(390)
    expect(snapshot.truncated).toBe(0)
  })
})

describe('多個 frame', () => {
  function twoFrames(): SnapshotInput {
    const rootNodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2', '3'] }),
      raw('2', 'heading', '訂單'),
      raw('3', 'button', '送出'),
    ]
    const childNodes = [
      raw('11', 'RootWebArea', '', { childIds: ['12', '13'] }),
      raw('12', 'link', '說明'),
      raw('13', 'textbox', '搜尋'),
    ]
    return input(
      [
        frame(rootNodes, boxesOf(2, 3), { frameId: 'FRAME-ROOT', url: 'https://example.test/' }),
        frame(childNodes, boxesOf(12, 13), { frameId: 'FRAME-CHILD', url: 'https://ads.test/box', sessionId: 'S-1', offset: { x: 120, y: 80 } }),
      ],
      { id: 12, url: 'https://example.test/', title: '首頁' },
    )
  }

  it('ref 序號跨 frame 連續，iframe 的節點接在 root 之後', () => {
    const { snapshot, refs } = buildSnapshot(twoFrames())
    expect(snapshot.frames[0]?.nodes.map((n) => n.ref)).toEqual([undefined, 's12-e0'])
    expect(snapshot.frames[1]?.nodes.map((n) => n.ref)).toEqual(['s12-e1', 's12-e2'])
    expect([...refs.entries.keys()]).toEqual(['s12-e0', 's12-e1', 's12-e2'])
  })

  it('iframe 的節點帶 sessionId、bounds 已加 offset；root 的節點沒有 sessionId', () => {
    const { snapshot, refs } = buildSnapshot(twoFrames())
    expect(snapshot.frames[1]?.nodes[0]?.sessionId).toBe('S-1')
    expect(snapshot.frames[1]?.nodes[0]?.bounds).toEqual({ x: 130, y: 90, width: 10, height: 10 })
    expect(refs.entries.get('s12-e1')?.sessionId).toBe('S-1')
    expect('sessionId' in (refs.entries.get('s12-e0') ?? {})).toBe(false)
    expect(snapshot.frames[0]?.nodes[1]?.sessionId).toBeUndefined()
  })

  it('文字第一個 frame 是 [page]，其餘是 [iframe k]（k 從 1 起）', () => {
    const { text } = buildSnapshot(twoFrames())
    expect(text).toBe(
      [
        '[page] 首頁 https://example.test/',
        'heading "訂單"',
        's12-e0 button "送出"',
        '[iframe 1] https://ads.test/box',
        's12-e1 link "說明"',
        's12-e2 textbox "搜尋"',
      ].join('\n'),
    )
  })
})

describe('formatSnapshotText', () => {
  const base = buildSnapshot(input([frame(
    [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'button', '送出')],
    boxesOf(2),
  )])).snapshot

  it('沒有插手摘要時不多一行：省略、undefined、空字串、null 都一樣', () => {
    const plain = ['[page] T https://example.test/', 's1-e0 button "送出"'].join('\n')
    expect(formatSnapshotText(base)).toBe(plain)
    expect(formatSnapshotText(base, undefined)).toBe(plain)
    expect(formatSnapshotText(base, '')).toBe(plain)
    // summarizeIntervention() 回傳 string | null，controller 直接傳進來（裁決 22）
    expect(formatSnapshotText(base, null)).toBe(plain)
  })

  it('有插手摘要時放在最前面一行', () => {
    const summary = '使用者在你上次操作後點了 3 次、按了 12 個鍵，網址從 https://a.test/ 變成 https://b.test/'
    expect(formatSnapshotText(base, summary).split('\n')).toEqual([summary, '[page] T https://example.test/', 's1-e0 button "送出"'])
  })

  it('unattachedFrames 為 0 時沒有那一行，大於 0 時排在插手摘要之後', () => {
    expect(formatSnapshotText(base)).not.toContain('未附著')
    const withUnattached = { ...base, unattachedFrames: 2 }
    expect(formatSnapshotText(withUnattached, '摘要').split('\n').slice(0, 2)).toEqual(['摘要', '[iframe 未附著 2 個]'])
  })

  it('truncated 大於 0 時最後一行是截斷提示', () => {
    const lines = formatSnapshotText({ ...base, truncated: 37 }).split('\n')
    expect(lines[lines.length - 1]).toBe('（還有 37 個節點未列出，請縮小範圍或捲動後重拍）')
  })

  it('name 與 value 裡的雙引號與換行逸出', () => {
    const nodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2'] }),
      { ...raw('2', 'textbox', '請輸入「"暱稱"」\n第二行'), value: { value: '他說 "好"\r\n然後走了' } },
    ]
    const { text } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    expect(text.split('\n')[1]).toBe('s1-e0 textbox "請輸入「\\"暱稱\\"」\\n第二行" value="他說 \\"好\\"\\n然後走了"')
    expect(text.split('\n')).toHaveLength(2)
  })

  it('value 與 states 同時存在時 value 在前、states 在後，多個 state 以「、」連接', () => {
    const nodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2'] }),
      {
        ...raw('2', 'textbox', '電子郵件'),
        value: { value: 'a@b.c' },
        properties: [{ name: 'required', value: { value: true } }, { name: 'disabled', value: { value: true } }],
      },
    ]
    const { text } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    expect(text.split('\n')[1]).toBe('s1-e0 textbox "電子郵件" value="a@b.c" (disabled、required)')
  })
})

describe('純函式性質', () => {
  it('buildSnapshot 不改動輸入', () => {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'button', '送出')]
    const source = input([frame(nodes, boxesOf(2), { offset: { x: 120, y: 80 } })])
    const before = JSON.stringify({ ...source, frames: source.frames.map((f) => ({ ...f, boxes: [...f.boxes] })) })
    buildSnapshot(source)
    const after = JSON.stringify({ ...source, frames: source.frames.map((f) => ({ ...f, boxes: [...f.boxes] })) })
    expect(after).toBe(before)
  })

  it('同一份輸入跑兩次得到相同文字', () => {
    const source = formInput('form.json')
    expect(buildSnapshot(source).text).toBe(buildSnapshot(source).text)
  })
})
```

---

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/snapshot.test.ts
```

預期：整個檔案在載入階段就失敗，錯誤是 `Failed to resolve import "../../src/main/view-tools/snapshot.js"`（`snapshot.ts` 還不存在）。若 `types.ts` 也還沒有，會多一則同樣形狀的錯誤，先照 Interfaces 那節把 `types.ts` 建出來再跑一次。

---

- [ ] **Step 3: 最小實作**

`src/main/view-tools/snapshot.ts` 全文（265 行，分兩段貼，實際是同一個檔）。第一段（型別、常數、規則的零件）：

```ts
import type { AxNode, FrameSnapshot, Point, Rect, RefEntry, RefTable, Snapshot } from './types.js'

/** Accessibility.getFullAXTree 回傳的 nodes[] 元素，只列本模組用到的欄位。 */
export interface AxRawNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value: unknown }
  readonly name?: { readonly value: unknown }
  readonly value?: { readonly value: unknown }
  readonly properties?: readonly { readonly name: string; readonly value: { readonly value: unknown } }[]
  readonly childIds?: readonly string[]
  readonly backendDOMNodeId?: number
}

export interface FrameInput {
  readonly sessionId?: string
  readonly frameId: string
  readonly url: string
  /** OOPIF 才非零（裁決 7，docs/superpowers/plan-b/CONTRACT.md）。 */
  readonly offset: Point
  readonly nodes: readonly AxRawNode[]
  /** backendNodeId → border 矩形（frame 自身座標，尚未加 offset）。 */
  readonly boxes: ReadonlyMap<number, Rect>
}

export interface SnapshotInput {
  readonly id: number
  readonly takenAt: number
  readonly url: string
  readonly title: string
  readonly scope: 'viewport' | 'full'
  readonly viewport: Rect
  readonly frames: readonly FrameInput[]
  readonly unattachedFrames: number
}

export interface SnapshotResult {
  readonly snapshot: Snapshot
  readonly refs: RefTable
  readonly text: string
}

export const MAX_SNAPSHOT_NODES = 400

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'switch', 'slider', 'tab', 'menuitem', 'option', 'listbox', 'spinbutton',
])

export const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['heading', 'image'])

/** 契約 §6 規則 6：states 的輸出順序固定，與 properties 的排列無關。 */
const STATE_ORDER: readonly string[] = [
  'disabled', 'checked', 'unchecked', 'mixed', 'expanded', 'collapsed',
  'selected', 'required', 'focused', 'readonly', 'pressed',
]

/** 邊緣相切算有交集（契約 §6 規則 3 的閉區間比較）。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  )
}

function textOf(field: { readonly value: unknown } | undefined): string {
  return typeof field?.value === 'string' ? field.value : ''
}

/** 契約 §6 規則 6 的對應表。值同時接受 CDP 的 boolean 與 tristate 兩種形狀。 */
function statesOf(node: AxRawNode): readonly string[] {
  const found = new Set<string>()
  for (const prop of node.properties ?? []) {
    const v = prop.value.value
    if (prop.name === 'disabled' && v === true) found.add('disabled')
    else if (prop.name === 'checked') {
      if (v === true || v === 'true') found.add('checked')
      else if (v === false || v === 'false') found.add('unchecked')
      else if (v === 'mixed') found.add('mixed')
    } else if (prop.name === 'expanded') {
      if (v === true) found.add('expanded')
      else if (v === false) found.add('collapsed')
    } else if (v === true && (prop.name === 'selected' || prop.name === 'required' || prop.name === 'focused' || prop.name === 'readonly')) {
      found.add(prop.name)
    } else if (prop.name === 'pressed' && (v === true || v === 'true')) found.add('pressed')
  }
  return STATE_ORDER.filter((s) => found.has(s))
}

/**
 * 契約 §6 規則 1：從 nodes[0] 起依 childIds 深度優先。nodes 陣列本身的順序不可靠
 * （CDP 不保證），所以先建 nodeId 索引再走 childIds；找不到的 childId 略過。
 */
function traverse(nodes: readonly AxRawNode[]): readonly AxRawNode[] {
  const first = nodes[0]
  if (first === undefined) return []
  const byId = new Map<string, AxRawNode>()
  for (const n of nodes) if (!byId.has(n.nodeId)) byId.set(n.nodeId, n)
  const out: AxRawNode[] = []
  const seen = new Set<string>()
  const stack: AxRawNode[] = [first]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || seen.has(node.nodeId)) continue
    seen.add(node.nodeId)
    out.push(node)
    const children = node.childIds ?? []
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const id = children[i]
      const child = id === undefined ? undefined : byId.get(id)
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

interface Candidate {
  readonly frameIndex: number
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: Rect
  readonly states: readonly string[]
  readonly backendNodeId: number
  readonly sessionId?: string
}

/** 契約 §6 規則 2 與 3：角色白名單、有 backendDOMNodeId、有矩形、（viewport 時）與 viewport 有交集。 */
function candidateOf(node: AxRawNode, frame: FrameInput, frameIndex: number, input: SnapshotInput): Candidate | null {
  if (node.ignored !== false) return null
  const role = textOf(node.role)
  const interactive = INTERACTIVE_ROLES.has(role)
  if (!interactive && !STRUCTURAL_ROLES.has(role)) return null
  const backendNodeId = node.backendDOMNodeId
  if (backendNodeId === undefined) return null
  const box = frame.boxes.get(backendNodeId)
  if (box === undefined) return null
  const name = textOf(node.name)
  if (!interactive && name === '') return null
  const bounds: Rect = {
    x: box.x + frame.offset.x,
    y: box.y + frame.offset.y,
    width: box.width,
    height: box.height,
  }
  if (input.scope === 'viewport' && !rectsIntersect(bounds, input.viewport)) return null
  const value = textOf(node.value)
  return {
    frameIndex,
    role,
    name,
    ...(value === '' ? {} : { value }),
    bounds,
    states: statesOf(node),
    backendNodeId,
    ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
  }
}

function collectCandidates(input: SnapshotInput): readonly Candidate[] {
  const out: Candidate[] = []
  input.frames.forEach((frame, frameIndex) => {
    for (const raw of traverse(frame.nodes)) {
      const candidate = candidateOf(raw, frame, frameIndex, input)
      if (candidate !== null) out.push(candidate)
    }
  })
  return out
}

```

第二段（`buildSnapshot` 與文字格式，接在第一段後面）：

```ts
/**
 * AX 樹（每個 frame 一份）轉成 Snapshot、RefTable 與給模型看的文字。
 * 純函式：同樣的輸入永遠得到同樣的輸出，不改動輸入的任何物件。
 */
export function buildSnapshot(input: SnapshotInput): SnapshotResult {
  const candidates = collectCandidates(input)
  const kept = candidates.slice(0, MAX_SNAPSHOT_NODES)
  const truncated = candidates.length - kept.length

  const entries = new Map<string, RefEntry>()
  const perFrame: AxNode[][] = input.frames.map(() => [])
  let nextIndex = 0
  for (const c of kept) {
    const ref = INTERACTIVE_ROLES.has(c.role) ? `s${input.id}-e${nextIndex}` : undefined
    if (ref !== undefined) {
      nextIndex += 1
      entries.set(ref, {
        ...(c.sessionId === undefined ? {} : { sessionId: c.sessionId }),
        backendNodeId: c.backendNodeId,
        role: c.role,
        name: c.name,
      })
    }
    const node: AxNode = {
      ...(ref === undefined ? {} : { ref }),
      role: c.role,
      name: c.name,
      ...(c.value === undefined ? {} : { value: c.value }),
      bounds: c.bounds,
      states: c.states,
      backendNodeId: c.backendNodeId,
      ...(c.sessionId === undefined ? {} : { sessionId: c.sessionId }),
    }
    perFrame[c.frameIndex]?.push(node)
  }

  const frames: readonly FrameSnapshot[] = input.frames.map((frame, i) => ({
    ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
    frameId: frame.frameId,
    url: frame.url,
    nodes: perFrame[i] ?? [],
  }))

  const snapshot: Snapshot = {
    id: input.id,
    takenAt: input.takenAt,
    url: input.url,
    title: input.title,
    scope: input.scope,
    frames,
    unattachedFrames: input.unattachedFrames,
    truncated,
  }
  const refs: RefTable = { snapshotId: input.id, entries }
  return { snapshot, refs, text: formatSnapshotText(snapshot) }
}

/** 契約 §6：name 與 value 裡的雙引號與換行要逸出，否則模型讀到的行會斷開。 */
function escapeText(raw: string): string {
  return raw.replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '\\n')
}

function nodeLine(node: AxNode): string {
  const head = node.ref === undefined ? '' : `${node.ref} `
  const value = node.value === undefined || node.value === '' ? '' : ` value="${escapeText(node.value)}"`
  const states = node.states.length === 0 ? '' : ` (${node.states.join('、')})`
  return `${head}${node.role} "${escapeText(node.name)}"${value}${states}`
}

/** 第一個 frame 是頁面本身，其餘依序是 iframe 1、iframe 2……（契約 §6 的文字格式）。 */
function frameHeader(frame: FrameSnapshot, index: number, snapshot: Snapshot): string {
  if (index === 0) return `[page] ${snapshot.title} ${snapshot.url}`
  return `[iframe ${index}] ${frame.url}`
}

/**
 * 給模型看的 snapshot 文字。intervention 是 summarizeIntervention() 的輸出
 * （watch.ts，契約 §9.3）：沒有插手時不給，那一行就不出現。空字串與 null
 * 一併當成沒給（裁決 22：controller 直接傳 summarizeIntervention 的結果）。
 */
export function formatSnapshotText(snapshot: Snapshot, intervention?: string | null): string {
  const lines: string[] = []
  if (intervention) lines.push(intervention)
  if (snapshot.unattachedFrames > 0) lines.push(`[iframe 未附著 ${snapshot.unattachedFrames} 個]`)
  snapshot.frames.forEach((frame, index) => {
    lines.push(frameHeader(frame, index, snapshot))
    for (const node of frame.nodes) lines.push(nodeLine(node))
  })
  if (snapshot.truncated > 0) {
    lines.push(`（還有 ${snapshot.truncated} 個節點未列出，請縮小範圍或捲動後重拍）`)
  }
  return lines.join('\n')
}
```

實作上兩個值得說的決定。`Candidate` 這個中間型別的存在是為了讓「先蒐集全部候選、再切 400、再編號」變成三個沒有分支的步驟：如果邊走訪邊編號，就得在走訪迴圈裡同時處理「還沒滿 400」「已經滿了」「這個要不要配 ref」三件事，那是特殊情況疊特殊情況。`buildSnapshot` 呼叫 `formatSnapshotText(snapshot)`（不帶 intervention），controller 拿到 `SnapshotResult` 之後再用摘要重新格式化一次，這樣純函式不必知道插手記錄是什麼。

---

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/snapshot.test.ts
npx tsc --noEmit -p tsconfig.json
```

預期（已在 worktree 實跑）：`Tests 39 passed (39)`，`tsc` 0 error。單檔覆蓋率（`npx vitest run tests/view-tools/snapshot.test.ts --coverage --coverage.include='src/main/view-tools/snapshot.ts'`）為 Stmts 99.15、Branch 93.75、Funcs 100、Lines 100，未覆蓋的是 `noUncheckedIndexedAccess` 逼出來的防呆分支（重複 nodeId、`childIds` 元素為 undefined、`perFrame[i] ?? []`）。

---

- [ ] **Step 5: 突變測試**

十一個突變都在 worktree `wt-4` 實跑過，每個都是「改實作、跑 `npx vitest run tests/view-tools/snapshot.test.ts`、記下變紅的測試、還原、確認回綠」。九個被抓到，兩個沒被抓到但查證後確認是等價改寫（不是測試盲點），照 WRITER-GUIDE 的要求把過程寫下來。

| # | 改法 | 變紅的測試 |
|---|---|---|
| 1 | `bounds` 不加 offset（`x: box.x, y: box.y`） | `bounds 是矩形加上 frame offset（非零 offset）`、`viewport 判定用加過 offset 的 bounds…`、`offset 的 x 與 y 不可互換…`、`iframe 的節點帶 sessionId、bounds 已加 offset…`（4 個） |
| 2 | `rectsIntersect` 四個比較全改成開區間（`<`／`>`） | `邊緣相切算有交集（閉區間）` |
| 3 | `traverse` 直接 `return nodes`（假設陣列已是前序） | `依 childIds 深度優先排序…`、`RefTable 的 key 是完整 ref…`、`scope viewport 只留與 viewport 有交集的節點…`、`nodes 陣列順序與 childIds 順序相反時，輸出照 childIds`（4 個） |
| 4 | `candidates.slice(0, MAX)` 改成 `slice(-MAX)`（取最後 400 個） | `450 個候選只留 DFS 前 400 個，truncated 為 50` |
| 5 | `nextIndex += 1` 移到 `if (ref !== undefined)` 之外（structural 也佔號） | `依 childIds 深度優先排序…`、`RefTable 的 key…`、`scope viewport…`、`ref 序號跨 frame 連續…`、`iframe 的節點帶 sessionId…`、`文字第一個 frame 是 [page]…`（6 個） |
| 6 | `statesOf` 回傳 `[...found]`（用出現順序，不照 STATE_ORDER） | `輸出順序固定，與 properties 的排列無關`、`value 與 states 同時存在時 value 在前、states 在後…`（2 個） |
| 7 | `rectsIntersect` 把 `a.x` 與 `a.y` 對調 | `scope viewport 只留與 viewport 有交集的節點…`、`邊緣相切算有交集（閉區間）`、`x 與 y 互換會得到不同答案…`、`offset 的 x 與 y 不可互換…`（4 個） |
| 8 | `...(value === '' ? {} : { value })` 改成 `value,`（空字串也帶） | `只有非空字串才帶 value` |
| 9 | `escapeText` 拿掉換行那一段 `.replace(/\r\n\|\r\|\n/g, '\\n')` | `name 與 value 裡的雙引號與換行逸出` |
| 10 | `frameHeader` 的 `[iframe ${index}]` 改成 `${index + 1}` | `文字第一個 frame 是 [page]，其餘是 [iframe k]（k 從 1 起）` |
| 11 | `if (!interactive && name === '') return null` 改成 `if (name === '') return null` | `白名單外的角色不收；structural 角色名稱為空也不收，但互動角色名稱為空要收` |

兩個全綠的改法與查證結果：

- `traverse` 的堆疊初值 `[first]` 改成 `[...nodes].reverse()`：39 個測試全過。查證後確認這是等價改寫，不是測試盲點。堆疊底部多塞的那些節點永遠排在自己父節點的後面被彈出，而彈出時 `seen` 已經記過它們，所以只有「從 `nodes[0]` 出發的 DFS 結果」會進 `out`；能到達的節點集合與順序都沒變。真正該測的「不照 `childIds` 走」是突變 3，那個有被抓到。
- `const truncated = candidates.length - kept.length` 改成 `Math.max(0, candidates.length - MAX_SNAPSHOT_NODES)`：39 個測試全過。因為 `kept = candidates.slice(0, MAX)`，兩式在數學上恆等。保留現寫法只是為了少一個常數引用。

突變 1 與 7 是這個 task 最重要的兩個。座標測試若用 `offset: {x: 0, y: 0}` 或正方形 viewport，這兩個突變都會巧合地全綠：所以 `bounds 與 frame offset` 那一組一律用 `{x: 120, y: 80}` 這種非零 offset，`x 與 y 互換會得到不同答案` 那個測試用的是 20×500 的細長矩形對 100×600 的 viewport（換軸之後答案由 `false` 變 `true`）。

---

- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/snapshot.ts tests/view-tools/snapshot.test.ts tests/fixtures/ax/form.json tests/fixtures/view/form.html
git commit -m "feat: snapshot 純函式與 AX fixture"
```

若 `src/main/view-tools/types.ts` 是本 task 補的（Task 0 尚未完成），一併 `git add src/main/view-tools/types.ts`，commit 訊息改為 `feat: snapshot 純函式、types 型別與 AX fixture`。

---

### Task 5: snapshot 的 CDP 蒐集（snapshot-collect.ts）

Task 4 的 `buildSnapshot` 是純函式，它需要的東西（每個 frame 的 AX 樹、每個節點的矩形、每個 frame 的 offset、viewport）全部得從 CDP 問出來。這個 task 就只做問的部分：把四種 CDP 查詢串成一個 `SnapshotInput`，過濾與編號一條都不做。這樣切的理由是兩邊的失敗模式完全不同，一邊是 I/O（frame 可能在查到一半就卸載、OOPIF 的 session 可能已經斷線），一邊是規則（ref 編號、截斷、可視判定）。混在一起會讓「ref 編號錯了」與「某個 iframe 沒附著」這兩種問題在同一個函式裡除錯。

frame 的發現是這個 task 最容易寫錯的地方，而且錯了不會有任何錯誤訊息，只會少看到東西。RESULTS-03 實測過：在 root session 呼叫 `Page.getFrameTree`，對 Google Identity configurator 那種頁面只回傳頂層文件自己一個 frame，完全沒有 `childFrames`，跨行程的 OOPIF 不在裡面。所以裁決 6 的作法是兩個來源取聯集：root 的 frame 樹負責同行程的子 frame，`getAttachedTargets()` 的每個 `type === 'iframe'` target 負責 OOPIF（`frameId` 就是它的 `targetId`），再對每個 OOPIF 的 session 呼叫一次 `Page.getFrameTree`，把巢狀在 OOPIF 裡面的同行程 frame 也納入。同一個 `frameId` 從兩邊都進來時只留第一次看到的那筆，這讓「OOPIF 自己的 frame 樹的根就是它自己」這個重複情況不必寫成特殊判斷。

座標是第二個容易寫錯又不會報錯的地方。`DOM.getBoxModel` 回的是「該 session 頂層 frame 的 viewport 座標」，不是主視窗座標：一個 OOPIF 裡的按鈕拿到的 y 是它在 iframe 內部的 y。裁決 7 的解法是每個 session 算一次 offset，沿 `Target.getTargets` 的父欄位鏈往上走到頁面本身，把每一層在父層裡的左上角加起來。父欄位依裁決 26 讀 `parentId ?? parentFrameId`，兩個欄位都當選填：`spikes/probe-oopif.ts:125` 的探針就是這樣讀的，哪一個真的有值尚未分開驗證，只讀其中一個會讓所有 OOPIF 的 offset 靜靜變成 `{0,0}`（Task 14 實機時把實際有值的欄位記進 RESULTS-05）。這裡刻意寫成迴圈而不是遞迴：巢狀 OOPIF（金流 iframe 裡再包一層 SSO 登入框，RESULTS-03 在 Stripe 量到深度 3）要加兩層以上才會對，而「走到一半失敗」與「`parentId` 意外成環」兩件事在迴圈裡都只是 `break`，不必在遞迴的每一層各自處理一次。裁決 7 說「任一步失敗回 `{0,0}` 並 logError」，套在迴圈上就是：失敗那一層以上當作 `{0,0}`，已經算出來的下層照樣加上去，跟逐層套用遞迴版本的結果一致。

錯誤處理分成四種，刻意不一致。`Page.getLayoutMetrics` 與 root 的 `Page.getFrameTree` 失敗直接往外丟：連 viewport 或主 frame 都沒有的話，回一份空的 snapshot 比回錯誤更糟，模型會以為頁面是空的。frame 層級的失敗（AX 樹抓不到）記 `logError` 並計入 `unattachedFrames`，snapshot 文字會多一行讓模型知道自己看不到某些東西。節點層級的失敗（`DOM.getBoxModel` 回錯）完全不記錄，因為 `display: none` 的元素在 AX 樹裡還在、`getBoxModel` 必定失敗，一次 snapshot 記幾百則等於沒記。

offset 的失敗是第四種，依裁決 29 由呼叫端決定怎麼處理：`resolveFrameOffset` 自己一律往外丟，不回退成 `{0,0}`。理由是這個值算錯不會有任何跡象，一個「iframe 內部座標被當成主視窗座標」的點擊會落在主頁上的別的元素，看起來像成功了。snapshot 端 catch 成 `{0,0}` 並 `logError`，frame 照常列入（節點清單與 ref 不需要座標就能餵給 `view_type`）；click 端（Task 9，裁決 9）不 catch，錯誤到工具端變成 `cdpFailed`，寧可讓模型收到一句失敗也不點錯地方。

`MAX_BOX_LOOKUPS` 的額度跨 frame 共用而不是每個 frame 各自一份：它擋的是「一次 snapshot 發出幾千個 CDP 指令」這件事，跟 frame 有幾個無關。box 查詢逐個 `await` 不並發，理由寫在裁決 7：幾百個 CDP 指令同時送會讓 Electron 的 debugger 排隊到逾時。

**Files:**

- Create `src/main/view-tools/snapshot-collect.ts`（381 行，契約 §9.1 的全部匯出加上裁決 9 要共用的 `resolveFrameOffset`；未超過 400 行，不拆檔）
- Test `tests/view-tools/snapshot-collect.test.ts`（672 行，36 個測試）

不改任何既有檔案。域的啟用（裁決 5 的 `DOM.enable`／`Network.enable`／`Accessibility.enable`）是 Task 6 的 watch.ts 負責，本 task 假設呼叫時三個域已經啟用。

**Interfaces:**

Consumes：

```ts
// Task 1（src/main/cdp.ts）
import { CdpError } from '../cdp.js'
import type { CdpSession } from '../cdp.js'
// CdpSession.send<T>(method: string, params?: object, sessionId?: string): Promise<T>
// CdpSession.getAttachedTargets(): readonly AttachedTargetInfo[]   // { targetId, type, url, sessionId }
// CdpSession.getRearmErrors(): readonly CdpError[]

// Task 4（src/main/view-tools/snapshot.ts）
import { INTERACTIVE_ROLES, STRUCTURAL_ROLES } from './snapshot.js'
import type { AxRawNode, FrameInput, SnapshotInput } from './snapshot.js'

// Task 0（src/main/view-tools/types.ts）
import type { Point, Rect } from './types.js'

// 測試：Task 1 的 tests/helpers/fake-cdp.ts
import { createFakeCdp } from '../helpers/fake-cdp.js'   // onSend(method, responder, sessionId?)、emit、setAttachedTargets、setRearmErrors
// 測試：Task 4 的 tests/fixtures/ax/form.json
```

Produces：

```ts
export interface CollectDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly currentUrl: () => string       // wc.getURL()
  readonly currentTitle: () => string     // wc.getTitle()
  readonly now: () => number
  readonly logError: (error: Error) => void
}
export const MAX_BOX_LOOKUPS = 1500
/**
 * 裁決 9：controller 點擊 OOPIF 裡的元素時重算 offset，只傳前兩個參數。
 * 裁決 29：任一步失敗往外丟（CdpError 原樣；找不到 session／target 時 code 為
 * 'frame-detached'，CDP 回了預期外形狀時 code 為 'invalid-response'），不回 {0,0}。
 */
export function resolveFrameOffset(
  deps: CollectDeps,
  sessionId: string | undefined,
  cache?: Map<string, Point>
): Promise<Point>
export function collectSnapshotInput(
  deps: CollectDeps,
  id: number,
  scope: 'viewport' | 'full'
): Promise<SnapshotInput>
```

`resolveFrameOffset` 的第三個參數 `cache` 依裁決 26 定案並已寫進契約 §9.1：裁決 7 要求「同一次 snapshot 內以 sessionId 快取，不重算」，而同一個函式又要能被 controller 單獨呼叫（裁決 9）。選填加預設值兩件事都成立，`collectSnapshotInput` 內部建一份 cache 傳給每個 frame，controller 寫兩個參數即可。只有成功解析的層會進 cache，失敗不留下紀錄（裁決 29 之下失敗已經是例外，不是一個要記住的值）。

下游：Task 9 的 controller 呼叫 `collectSnapshotInput(deps, id, scope)` 後把結果交給 `buildSnapshot`，並在 `view_click` 遇到 `entry.sessionId` 有值時呼叫 `resolveFrameOffset(deps, entry.sessionId)`。

---

- [ ] **Step 1: 寫失敗的測試**

`tests/view-tools/snapshot-collect.test.ts` 全文（分四段貼，實際是同一個檔）。

假 CDP 用 Task 1 的 `createFakeCdp()`，`onSend` 依 method 與 sessionId 分別預錄：`onSend('X', fn)` 接所有 session 的 X，`onSend('X', fn, 's-a')` 只接那個 session 的，後者優先。`DOM.getBoxModel` 的預錄回應同時給 `border` 與 `content` 兩個 quad，因為節點的矩形與 iframe 擁有者的矩形查的是不同的 `backendNodeId`，不會互相干擾，一個 session 因此只需要一份預錄。

offset 的測試資料全部用非零、且同一層的 x 與 y 不相等的數字（外層 `(100, 40)`、內層 `(7, 13)`、相加是 `(107, 53)`）：offset 為 0 或 x 等於 y 的話，「忘記加父層」「只加父層」「x 與 y 寫反」三種寫法都會巧合地算出正確答案。

失敗的情況全部用 `rejects.toMatchObject({ code })` 驗 code（裁決 29），不驗 `logError`：`resolveFrameOffset` 本身不再記錄任何東西。snapshot 端的 `{0,0}` 回退另外一條測試單獨驗，而且刻意讓同一個 session 底下有兩個 frame，用來釘死「一個 session 只記一次」。

第一段（工具函式、基本欄位與 viewport）：

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CdpError } from '../../src/main/cdp.js'
import type { AttachedTargetInfo } from '../../src/main/cdp.js'
import {
  MAX_BOX_LOOKUPS,
  collectSnapshotInput,
  resolveFrameOffset,
} from '../../src/main/view-tools/snapshot-collect.js'
import type { CollectDeps } from '../../src/main/view-tools/snapshot-collect.js'
import { buildSnapshot } from '../../src/main/view-tools/snapshot.js'
import type { AxRawNode } from '../../src/main/view-tools/snapshot.js'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import type { FakeCdp } from '../helpers/fake-cdp.js'

/** 軸對齊的 quad：[x1,y1,x2,y2,x3,y3,x4,y4]，順序是左上、右上、右下、左下。 */
function quad(x: number, y: number, width: number, height: number): readonly number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height]
}

/**
 * DOM.getBoxModel 的預錄回應：同一個 model 同時給 border 與 content。
 * 兩者查的是不同的 backendNodeId（節點的矩形 vs iframe 擁有者的矩形），
 * 不會互相干擾，測試因此不必為同一個 session 開兩份預錄。
 */
function boxModel(byId: Readonly<Record<number, readonly number[]>>) {
  return (params: object | undefined): unknown => {
    const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId
    const q = id === undefined ? undefined : byId[id]
    if (q === undefined) throw new CdpError(`沒有 node ${String(id)} 的 box model`, 'no-box-model')
    return { model: { border: q, content: q } }
  }
}

function axNode(
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId: number,
  extra: Partial<AxRawNode> = {}
): AxRawNode {
  return { nodeId, ignored: false, role: { value: role }, name: { value: name }, backendDOMNodeId, ...extra }
}

function frameTree(id: string, url: string, children: readonly { id: string; url: string }[] = []): unknown {
  return { frameTree: { frame: { id, url }, childFrames: children.map((c) => ({ frame: { id: c.id, url: c.url } })) } }
}

function target(targetId: string, sessionId: string, url: string, type = 'iframe'): AttachedTargetInfo {
  return { targetId, type, url, sessionId }
}

function makeDeps(cdp: FakeCdp): { deps: CollectDeps; errors: Error[] } {
  const errors: Error[] = []
  const deps: CollectDeps = {
    cdp,
    currentUrl: () => 'https://a.test/order',
    currentTitle: () => '訂單確認',
    now: () => 1700,
    logError: (e) => {
      errors.push(e)
    },
  }
  return { deps, errors }
}

/** 最小可用的樁：viewport 1024×768、一個主 frame、沒有 iframe。 */
function basicCdp(nodes: readonly AxRawNode[], byId: Readonly<Record<number, readonly number[]>>): FakeCdp {
  const cdp = createFakeCdp()
  cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 1024, clientHeight: 768 } }))
  cdp.onSend('Page.getFrameTree', () => frameTree('F-root', 'https://a.test/order'))
  cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes }))
  cdp.onSend('DOM.getBoxModel', boxModel(byId))
  return cdp
}

function methodCalls(cdp: FakeCdp, method: string): readonly unknown[][] {
  return (cdp.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === method)
}

describe('collectSnapshotInput：基本欄位與 viewport', () => {
  it('id、scope 與 deps 的 now／url／title 原樣帶進 SnapshotInput，viewport 取 cssVisualViewport 且 x、y 為 0', async () => {
    const cdp = basicCdp([], {})
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 7, 'full')
    expect(input.id).toBe(7)
    expect(input.scope).toBe('full')
    expect(input.takenAt).toBe(1700)
    expect(input.url).toBe('https://a.test/order')
    expect(input.title).toBe('訂單確認')
    // 寬高刻意不同，x/y 或 width/height 互換的實作會被抓到。
    expect(input.viewport).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })

  it('cssVisualViewport 沒有寬高時丟 CdpError（code invalid-response），不是靜靜回 0', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getLayoutMetrics', () => ({ layoutViewport: { clientWidth: 800, clientHeight: 600 } }))
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({
      name: 'CdpError',
      code: 'invalid-response',
    })
  })

  it('Page.getLayoutMetrics 失敗時錯誤往外丟，不吞掉', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getLayoutMetrics', () => {
      throw new CdpError('目標已關閉', 'targetClosed')
    })
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({ code: 'targetClosed' })
  })
})
```

第二段（frame 發現與 unattachedFrames，裁決 6）：

```ts
describe('collectSnapshotInput：frame 發現（裁決 6）', () => {
  const rootNodes = [axNode('1', 'button', '送出', 11)]

  it('root 的 frame 樹遞迴攤平，同行程子 frame 的 sessionId 是 undefined，主 frame 排在最前', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.onSend('Page.getFrameTree', () =>
      frameTree('F-root', 'https://a.test/order', [{ id: 'F-child', url: 'https://a.test/side' }])
    )
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'F-child'])
    expect(input.frames.map((f) => f.sessionId)).toEqual([undefined, undefined])
    expect(input.frames[1]?.url).toBe('https://a.test/side')
  })

  it('getAttachedTargets 的 iframe target 成為 frame（frameId 就是 targetId），非 iframe 的 target 不算', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([
      target('T-oopif', 's-oopif', 'https://pay.test/'),
      target('T-worker', 's-worker', 'https://a.test/sw.js', 'service_worker'),
    ])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-oopif', 'https://pay.test/'), 's-oopif')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif'])
    expect(input.frames[1]?.sessionId).toBe('s-oopif')
    expect(input.frames[1]?.url).toBe('https://pay.test/')
  })

  it('iframe target 自己的 frame 樹也攤平，且跟 target 重複的 frameId 只出現一次', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend(
      'Page.getFrameTree',
      () => frameTree('T-oopif', 'https://pay.test/', [{ id: 'F-inner', url: 'https://pay.test/inner' }]),
      's-oopif'
    )
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif', 'F-inner'])
    expect(input.frames[2]?.sessionId).toBe('s-oopif')
  })

  it('iframe target 的 Page.getFrameTree 失敗只記錄，target 本身仍然是一個 frame', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend(
      'Page.getFrameTree',
      () => {
        throw new CdpError('session 已關閉', 'sessionClosed')
      },
      's-oopif'
    )
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif'])
    expect(errors.map((e) => e.message).join('\n')).toContain('T-oopif')
    expect(input.unattachedFrames).toBe(0)
  })
})

describe('collectSnapshotInput：unattachedFrames（裁決 6 第 3、4 點）', () => {
  const rootNodes = [axNode('1', 'button', '送出', 11)]

  function withTwoOopifs(): FakeCdp {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) })
    cdp.setAttachedTargets([target('T-a', 's-a', 'https://a.pay/'), target('T-b', 's-b', 'https://b.pay/')])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-a', 'https://a.pay/'), 's-a')
    cdp.onSend('Page.getFrameTree', () => frameTree('T-b', 'https://b.pay/'), 's-b')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-a', type: 'iframe', parentId: 'T-page' },
        { targetId: 'T-b', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    return cdp
  }

  it('AX 樹抓不到的 frame 略過、計入 unattachedFrames 並記錄錯誤', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-a'
    )
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-b'])
    expect(input.unattachedFrames).toBe(1)
    expect(errors.some((e) => e.message.includes('T-a'))).toBe(true)
  })

  it('getFullAXTree 回傳沒有 nodes 陣列時視同抓不到', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({}), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-b'])
    expect(input.unattachedFrames).toBe(1)
    expect(errors.some((e) => e.message.includes('nodes'))).toBe(true)
  })

  it('getRearmErrors 非空、但所有 frame 的 AX 樹都抓得到時，unattachedFrames 仍至少是 1', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames).toHaveLength(3)
    expect(input.unattachedFrames).toBe(1)
  })

  it('getRearmErrors 非空且已經有兩個 frame 抓不到時，維持 2 而不是被壓成 1', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-a'
    )
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-b'
    )
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.unattachedFrames).toBe(2)
  })

  it('getRearmErrors 為空、frame 都正常時 unattachedFrames 是 0', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.unattachedFrames).toBe(0)
  })
})
```

第三段（offset，裁決 7）：

```ts
describe('resolveFrameOffset（裁決 7）', () => {
  /**
   * 兩層 OOPIF：T-outer 在頁面裡的 (100, 40)，T-inner 在 T-outer 座標系裡的 (7, 13)。
   * 每一層的 x 與 y 都不同、都不是 0，所以「只加自己那層」「只加父層」「x 與 y 寫反」
   * 三種錯法都會得到跟 (107, 53) 不同的值。
   */
  function nestedCdp(): FakeCdp {
    const cdp = basicCdp([], {})
    cdp.setAttachedTargets([
      target('T-outer', 's-outer', 'https://outer.test/'),
      target('T-inner', 's-inner', 'https://inner.test/'),
    ])
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' },
        { targetId: 'T-outer', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    // root session（父是頁面本身）算 T-outer 的位置。
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 900: quad(100, 40, 300, 200) }))
    // s-outer session 算 T-inner 的位置。
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 901 }), 's-outer')
    cdp.onSend('DOM.getBoxModel', boxModel({ 901: quad(7, 13, 120, 60) }), 's-outer')
    return cdp
  }

  it('sessionId 為 undefined（root）時直接回 {0,0}，一個 CDP 指令都不發', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, undefined)).toEqual({ x: 0, y: 0 })
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(0)
    expect(errors).toEqual([])
  })

  it('單層 OOPIF：offset 就是父 session 裡 content 的左上角', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-outer')).toEqual({ x: 100, y: 40 })
    expect(errors).toEqual([])
  })

  it('兩層 OOPIF：offset 是整條父鏈相加，不是只有自己那一層', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-inner')).toEqual({ x: 107, y: 53 })
    expect(errors).toEqual([])
  })

  it('getFrameOwner 送到父 session：T-inner 問 s-outer，T-outer 問 root', async () => {
    const cdp = nestedCdp()
    const { deps } = makeDeps(cdp)
    await resolveFrameOffset(deps, 's-inner')
    const owners = methodCalls(cdp, 'DOM.getFrameOwner')
    expect(owners).toEqual([
      ['DOM.getFrameOwner', { frameId: 'T-inner' }, 's-outer'],
      ['DOM.getFrameOwner', { frameId: 'T-outer' }, undefined],
    ])
  })

  it('Target.getTargets 找不到這個 target 的父 target 時往外丟 frame-detached（裁決 29）', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-somebody-else', type: 'iframe', parentId: 'T-page' }],
    }))
    const { deps, errors } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({
      name: 'CdpError',
      code: 'frame-detached',
    })
    // 容忍與否由呼叫端決定，函式本身不記錄也不回退。
    expect(errors).toEqual([])
  })

  it('TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-inner', type: 'iframe', parentFrameId: 'T-outer' },
        { targetId: 'T-outer', type: 'iframe', parentFrameId: 'T-page' },
      ],
    }))
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-inner')).toEqual({ x: 107, y: 53 })
    expect(errors).toEqual([])
  })

  it('TargetInfo 有這個 target 但兩個父欄位都沒有時往外丟 frame-detached', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-outer', type: 'iframe' }] }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'frame-detached' })
  })

  it('getAttachedTargets 裡沒有這個 sessionId 時往外丟 frame-detached，不發任何指令', async () => {
    const cdp = nestedCdp()
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-unknown')).rejects.toMatchObject({ code: 'frame-detached' })
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(0)
  })

  it('DOM.getFrameOwner 失敗時把原本的 CdpError 原樣往外丟，不換成別的 code', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getFrameOwner', () => {
      throw new CdpError('找不到 frame owner', 'noNode')
    })
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'noNode' })
  })

  it('DOM.getFrameOwner 沒有回傳 backendNodeId 時往外丟 invalid-response', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getFrameOwner', () => ({}))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('backendNodeId'),
    })
  })

  it('Target.getTargets 失敗時把原本的 CdpError 原樣往外丟', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => {
      throw new CdpError('debugger 已卸除', 'detached')
    })
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'detached' })
  })

  it('父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）', async () => {
    const cdp = nestedCdp()
    // T-inner 在 T-outer 裡的位置查得到，但 T-outer 自己的父 target 查不到。
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' }],
    }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-inner')).rejects.toMatchObject({ code: 'frame-detached' })
  })

  it('content 的四點順序打亂時取最小外接矩形的左上角', async () => {
    const cdp = nestedCdp()
    // 右下、左下、左上、右上：左上角仍應是 (100, 40)。
    cdp.onSend('DOM.getBoxModel', () => ({ model: { content: [400, 240, 100, 240, 100, 40, 400, 40] } }))
    const { deps } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-outer')).toEqual({ x: 100, y: 40 })
  })

  it('content 不是八個數字時往外丟 invalid-response', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getBoxModel', () => ({ model: { content: [100, 40] } }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('父欄位成環時往外丟 invalid-response，不會無限打轉', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-outer', type: 'iframe', parentId: 'T-inner' },
        { targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' },
      ],
    }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-inner')).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('迴圈'),
    })
  })

  it('同一次 snapshot 內同一個 session 只算一次（快取）', async () => {
    const cdp = nestedCdp()
    cdp.setAttachedTargets([
      target('T-outer', 's-outer', 'https://outer.test/'),
      target('T-inner', 's-inner', 'https://inner.test/'),
    ])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-outer', 'https://outer.test/'), 's-outer')
    cdp.onSend('Page.getFrameTree', () => frameTree('T-inner', 'https://inner.test/'), 's-inner')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.offset)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 40 },
      { x: 107, y: 53 },
    ])
    // s-outer 出現在兩條解析路徑上（自己一次、s-inner 的父鏈一次），只能查一次 parentId。
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(2)
  })
})
```

第四段（裁決 29 的 snapshot 端處置、box 蒐集、`MAX_BOX_LOOKUPS`，以及跟 Task 4 `buildSnapshot` 串起來的整合測試）：

```ts
describe('collectSnapshotInput 對 offset 失敗的處置（裁決 29）', () => {
  it('offset 算不出來時該 frame 用 {0,0}、記錄一次，frame 與它的節點照常列入', async () => {
    const cdp = basicCdp([axNode('1', 'button', '主頁按鈕', 11)], { 11: quad(10, 20, 30, 40), 21: quad(5, 6, 30, 40) })
    cdp.setAttachedTargets([target('T-pay', 's-pay', 'https://pay.test/')])
    // 同一個 session 底下兩個 frame，錯誤只該記一次。
    cdp.onSend(
      'Page.getFrameTree',
      () => frameTree('T-pay', 'https://pay.test/', [{ id: 'F-inner', url: 'https://pay.test/inner' }]),
      's-pay'
    )
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [axNode('1', 'button', '付款', 21)] }), 's-pay')
    // T-pay 不在 Target.getTargets 的清單裡：resolveFrameOffset 丟 frame-detached。
    cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-other', type: 'iframe' }] }))
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-pay', 'F-inner'])
    expect(input.frames.map((f) => f.offset)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ])
    // 節點與矩形照常蒐集：view_type 不需要座標，ref 仍然可用。
    expect([...(input.frames[1]?.boxes.keys() ?? [])]).toEqual([21])
    expect(input.frames[1]?.nodes).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('s-pay')
  })
})

describe('collectSnapshotInput：box 蒐集', () => {
  it('只對角色白名單內、未 ignored 且有 backendDOMNodeId 的節點查 box', async () => {
    const nodes: readonly AxRawNode[] = [
      axNode('1', 'RootWebArea', '訂單確認', 1),
      axNode('2', 'button', '送出', 11),
      axNode('3', 'heading', '訂單', 12),
      axNode('4', 'generic', '', 13),
      axNode('5', 'StaticText', '送出', 14),
      axNode('6', 'button', '隱藏', 15, { ignored: true }),
      { nodeId: '7', ignored: false, role: { value: 'link' }, name: { value: '沒有節點' } },
    ]
    const cdp = basicCdp(nodes, { 11: quad(10, 20, 30, 40), 12: quad(1, 2, 3, 4) })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel').map((c) => c[1])).toEqual([{ backendNodeId: 11 }, { backendNodeId: 12 }])
    expect([...(input.frames[0]?.boxes.keys() ?? [])]).toEqual([11, 12])
    expect(errors).toEqual([])
  })

  it('border 取四點的最小外接矩形，順序打亂與非軸對齊都算得出來', async () => {
    const nodes = [axNode('1', 'button', '送出', 11)]
    const cdp = basicCdp(nodes, {})
    cdp.onSend('DOM.getBoxModel', () => ({ model: { border: [30, 5, 50, 25, 30, 45, 10, 25] } }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames[0]?.boxes.get(11)).toEqual({ x: 10, y: 5, width: 40, height: 40 })
  })

  it('getBoxModel 失敗的節點不進 boxes，也不記錄錯誤（display: none 是常態）', async () => {
    const nodes = [axNode('1', 'button', '送出', 11), axNode('2', 'button', '隱藏', 12)]
    const cdp = basicCdp(nodes, { 11: quad(10, 20, 30, 40) })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect([...(input.frames[0]?.boxes.keys() ?? [])]).toEqual([11])
    expect(errors).toEqual([])
  })

  it('box 查詢送到該 frame 的 sessionId', async () => {
    const cdp = basicCdp([axNode('1', 'button', '主頁按鈕', 11)], {
      11: quad(10, 20, 30, 40),
      21: quad(1, 2, 3, 4),
      900: quad(100, 40, 300, 200),
    })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-oopif', 'https://pay.test/'), 's-oopif')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [axNode('1', 'button', '付款', 21)] }), 's-oopif')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    const { deps } = makeDeps(cdp)
    await collectSnapshotInput(deps, 1, 'full')
    const calls = methodCalls(cdp, 'DOM.getBoxModel')
    expect(calls).toContainEqual(['DOM.getBoxModel', { backendNodeId: 11 }, undefined])
    expect(calls).toContainEqual(['DOM.getBoxModel', { backendNodeId: 21 }, 's-oopif'])
  })
})

describe('collectSnapshotInput：MAX_BOX_LOOKUPS（裁決 7）', () => {
  function manyNodes(prefix: string, count: number, firstId: number): readonly AxRawNode[] {
    return Array.from({ length: count }, (_, i) => axNode(`${prefix}${i}`, 'button', `按鈕 ${i}`, firstId + i))
  }

  it('額度跨 frame 共用：兩個各 800 個候選的 frame 只查 1500 次，多的不查也不進 boxes，並記錄一次', async () => {
    const first = manyNodes('a', 800, 1000)
    const second = manyNodes('b', 800, 5000)
    const cdp = basicCdp(first, {})
    cdp.onSend('Page.getFrameTree', () =>
      frameTree('F-root', 'https://a.test/order', [{ id: 'F-child', url: 'https://a.test/side' }])
    )
    cdp.onSend('Accessibility.getFullAXTree', (params) =>
      (params as { frameId?: string } | undefined)?.frameId === 'F-child' ? { nodes: second } : { nodes: first }
    )
    cdp.onSend('DOM.getBoxModel', (params) => {
      const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId ?? 0
      return { model: { border: quad(id, id + 1, 10, 10) } }
    })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel')).toHaveLength(MAX_BOX_LOOKUPS)
    expect(input.frames[0]?.boxes.size).toBe(800)
    expect(input.frames[1]?.boxes.size).toBe(700)
    // 第二個 frame 的第 701 個之後沒有矩形：buildSnapshot 規則 2 會把它們當不存在。
    expect(input.frames[1]?.boxes.has(5699)).toBe(true)
    expect(input.frames[1]?.boxes.has(5700)).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('100')
  })

  it('候選數剛好等於上限時全部查完，不記錄錯誤', async () => {
    const nodes = manyNodes('a', MAX_BOX_LOOKUPS, 1000)
    const cdp = basicCdp(nodes, {})
    cdp.onSend('DOM.getBoxModel', (params) => {
      const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId ?? 0
      return { model: { border: quad(id, id + 1, 10, 10) } }
    })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel')).toHaveLength(MAX_BOX_LOOKUPS)
    expect(input.frames[0]?.boxes.size).toBe(MAX_BOX_LOOKUPS)
    expect(errors).toEqual([])
  })
})

describe('collectSnapshotInput 的輸出直接餵得進 buildSnapshot', () => {
  const FORM_AX = JSON.parse(readFileSync('tests/fixtures/ax/form.json', 'utf8')) as { nodes: readonly AxRawNode[] }

  /** fixture 的 backendDOMNodeId → 矩形。刻意全部落在 viewport 內。 */
  const FORM_BOXES: Readonly<Record<number, readonly number[]>> = {
    101: quad(120, 80, 200, 32), // heading 訂單
    104: quad(120, 140, 240, 24), // textbox 電子郵件
    106: quad(120, 180, 240, 24), // textbox 收件人
    108: quad(120, 220, 16, 16), // checkbox 訂閱電子報
    110: quad(120, 260, 80, 30), // button 刪除
    114: quad(120, 300, 60, 20), // link 說明
    116: quad(120, 340, 100, 100), // image 商品圖
    117: quad(120, 460, 100, 100), // image（沒有 alt）
  }

  it('form.json 加一個 OOPIF：ref 連續編號、OOPIF 節點的 bounds 已經加上 offset、未附著數進文字', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 1024, clientHeight: 768 } }))
    cdp.onSend('Page.getFrameTree', () => frameTree('F-root', 'https://a.test/order'))
    cdp.onSend('Page.getFrameTree', () => frameTree('T-pay', 'https://pay.test/'), 's-pay')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: FORM_AX.nodes }))
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => ({
        nodes: [
          { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: '付款' }, childIds: ['2'] },
          axNode('2', 'button', '確認付款', 201),
        ],
      }),
      's-pay'
    )
    cdp.onSend('DOM.getBoxModel', boxModel({ ...FORM_BOXES, 900: quad(100, 40, 300, 200) }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 201: quad(8, 12, 120, 30) }), 's-pay')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-pay', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.setAttachedTargets([target('T-pay', 's-pay', 'https://pay.test/')])
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])

    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 12, 'viewport')
    const { snapshot, refs, text } = buildSnapshot(input)

    expect(snapshot.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-pay'])
    expect(refs.snapshotId).toBe(12)
    expect(refs.entries.get('s12-e0')).toEqual({ backendNodeId: 104, role: 'textbox', name: '電子郵件' })
    expect(refs.entries.get('s12-e4')).toEqual({ backendNodeId: 114, role: 'link', name: '說明' })
    // 編號跨 frame 連續：主 frame 用掉 e0 到 e4，OOPIF 的按鈕接在 e5。
    expect(refs.entries.get('s12-e5')).toEqual({
      sessionId: 's-pay',
      backendNodeId: 201,
      role: 'button',
      name: '確認付款',
    })
    // OOPIF 的按鈕在自己 frame 裡是 (8, 12)，加上 iframe 在主視窗的 (100, 40)。
    expect(snapshot.frames[1]?.nodes[0]?.bounds).toEqual({ x: 108, y: 52, width: 120, height: 30 })
    expect(text.split('\n')[0]).toBe('[iframe 未附著 1 個]')
    expect(text).toContain('[page] 訂單確認 https://a.test/order')
    expect(text).toContain('[iframe 1] https://pay.test/')
    expect(text).toContain('s12-e5 button "確認付款"')
    // 沒有 alt 的 image（name 為空）由 buildSnapshot 規則 2 濾掉，不佔行。
    expect(text).not.toContain('image ""')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/snapshot-collect.test.ts
```

實跑輸出（`src/main/view-tools/snapshot-collect.ts` 還不存在）：

```
Error: Cannot find module '../../src/main/view-tools/snapshot-collect.js' imported from .../tests/view-tools/snapshot-collect.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: 最小實作**

`src/main/view-tools/snapshot-collect.ts` 全文（381 行，分三段貼，實際是同一個檔）。第一段（型別、quad 與 viewport、frame 發現）：

```ts
import { CdpError } from '../cdp.js'
import type { CdpSession } from '../cdp.js'
import { INTERACTIVE_ROLES, STRUCTURAL_ROLES } from './snapshot.js'
import type { AxRawNode, FrameInput, SnapshotInput } from './snapshot.js'
import type { Point, Rect } from './types.js'

/** 契約 §9.1。cdp 只用得到三個方法，型別上就收窄，測試不必造整個 CdpSession。 */
export interface CollectDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly currentUrl: () => string
  readonly currentTitle: () => string
  readonly now: () => number
  readonly logError: (error: Error) => void
}

/** 一次 snapshot 最多查幾個 DOM.getBoxModel（裁決 7）。跨 frame 共用同一份額度。 */
export const MAX_BOX_LOOKUPS = 1500

const ORIGIN: Point = { x: 0, y: 0 }

interface RawFrame {
  readonly id?: unknown
  readonly url?: unknown
}

interface RawFrameTreeNode {
  readonly frame?: RawFrame
  readonly childFrames?: readonly RawFrameTreeNode[]
}

interface DiscoveredFrame {
  readonly frameId: string
  readonly url: string
  readonly sessionId?: string
}

function errorOf(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

/**
 * CDP 的 quad 是 [x1,y1,x2,y2,x3,y3,x4,y4] 八個數字。取四點的最小外接矩形，
 * 不假設四點的排列順序（頁面有 transform 時 border 不是軸對齊的矩形）。
 */
function quadToRect(quad: unknown): Rect | null {
  if (!Array.isArray(quad) || quad.length < 8) return null
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < 8; i += 2) {
    const x = quad[i]
    const y = quad[i + 1]
    if (typeof x !== 'number' || !Number.isFinite(x)) return null
    if (typeof y !== 'number' || !Number.isFinite(y)) return null
    xs.push(x)
    ys.push(y)
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

/** viewport 取 root 的 cssVisualViewport（裁決 7）。抓不到寬高就是 CDP 回了預期外的形狀，直接失敗。 */
async function readViewport(deps: CollectDeps): Promise<Rect> {
  const metrics = await deps.cdp.send<{ cssVisualViewport?: { clientWidth?: unknown; clientHeight?: unknown } }>(
    'Page.getLayoutMetrics'
  )
  const width = metrics?.cssVisualViewport?.clientWidth
  const height = metrics?.cssVisualViewport?.clientHeight
  if (typeof width !== 'number' || !Number.isFinite(width) || typeof height !== 'number' || !Number.isFinite(height)) {
    throw new CdpError('Page.getLayoutMetrics 沒有回傳 cssVisualViewport 的寬高', 'invalid-response')
  }
  return { x: 0, y: 0, width, height }
}

/** 同一個 frameId 只留第一次看到的那筆：先進來的順序就是輸出順序（第一個是主 frame）。 */
function addFrame(into: Map<string, DiscoveredFrame>, frame: DiscoveredFrame): void {
  if (into.has(frame.frameId)) return
  into.set(frame.frameId, frame)
}

function addFrameTree(into: Map<string, DiscoveredFrame>, node: RawFrameTreeNode | undefined, sessionId?: string): void {
  if (node === undefined) return
  const id = node.frame?.id
  if (typeof id === 'string' && id !== '') {
    const url = node.frame?.url
    addFrame(into, {
      frameId: id,
      url: typeof url === 'string' ? url : '',
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  }
  for (const child of node.childFrames ?? []) addFrameTree(into, child, sessionId)
}

/**
 * 裁決 6：root 的 Page.getFrameTree 只列同行程的子 frame，OOPIF 不在裡面
 * （RESULTS-03 實測），所以要再走一次 getAttachedTargets() 的 iframe target，
 * 每個 target 自己就是一個 frame（frameId 等於 targetId），再對它的 session
 * 呼叫一次 Page.getFrameTree 把它裡面的同行程子 frame 也納入。
 *
 * root 的 getFrameTree 失敗就整個 snapshot 失敗（連主 frame 都沒有，沒有東西可回）；
 * 個別 iframe target 的 getFrameTree 失敗只記錄，target 本身仍留在清單裡。
 */
async function discoverFrames(deps: CollectDeps): Promise<readonly DiscoveredFrame[]> {
  const frames = new Map<string, DiscoveredFrame>()
  const rootTree = await deps.cdp.send<{ frameTree?: RawFrameTreeNode }>('Page.getFrameTree')
  addFrameTree(frames, rootTree?.frameTree)
  for (const target of deps.cdp.getAttachedTargets()) {
    if (target.type !== 'iframe') continue
    addFrame(frames, { frameId: target.targetId, url: target.url, sessionId: target.sessionId })
    try {
      const tree = await deps.cdp.send<{ frameTree?: RawFrameTreeNode }>('Page.getFrameTree', {}, target.sessionId)
      addFrameTree(frames, tree?.frameTree, target.sessionId)
    } catch (e) {
      deps.logError(new Error(`iframe target ${target.targetId} 的 frame 樹抓不到：${errorOf(e).message}`, { cause: e }))
    }
  }
  return [...frames.values()]
}

/** 裁決 6 第 3 點：抓不到 AX 樹的 frame 略過並計入 unattachedFrames。 */
async function fetchAxNodes(deps: CollectDeps, frame: DiscoveredFrame): Promise<readonly AxRawNode[] | null> {
  try {
    const result = await deps.cdp.send<{ nodes?: unknown }>(
      'Accessibility.getFullAXTree',
      { frameId: frame.frameId },
      frame.sessionId
    )
    const nodes = result?.nodes
    if (!Array.isArray(nodes)) {
      deps.logError(new Error(`frame ${frame.frameId} 的 Accessibility.getFullAXTree 沒有回傳 nodes 陣列`))
      return null
    }
    return nodes as readonly AxRawNode[]
  } catch (e) {
    deps.logError(new Error(`frame ${frame.frameId} 的 AX 樹抓不到：${errorOf(e).message}`, { cause: e }))
    return null
  }
}
```

第二段（offset，裁決 7）：

```ts
interface OwnerStep {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly dx: number
  readonly dy: number
}

interface RawTargetInfo {
  readonly targetId?: unknown
  /** 兩個欄位都選填：裁決 26 照探針 spikes/probe-oopif.ts:125 的讀法，先 parentId 再 parentFrameId。 */
  readonly parentId?: unknown
  readonly parentFrameId?: unknown
}

/** 裁決 7 第 2 步：TargetInfo 的父欄位才是結構，清單順序不是。 */
async function findParentTargetId(deps: CollectDeps, targetId: string): Promise<string> {
  const result = await deps.cdp.send<{ targetInfos?: unknown }>('Target.getTargets')
  const infos = result?.targetInfos
  const entry = Array.isArray(infos)
    ? (infos as readonly RawTargetInfo[]).find((t) => t?.targetId === targetId)
    : undefined
  const parentId = entry?.parentId ?? entry?.parentFrameId
  if (typeof parentId !== 'string' || parentId === '') {
    throw new CdpError(`Target.getTargets 找不到 target ${targetId} 的父 target`, 'frame-detached')
  }
  return parentId
}

/**
 * 裁決 7 第 1 到 4 步：這個 session 的頂層 frame 在「父 session 座標系」裡的左上角。
 * 任何一步失敗都往外丟（裁決 29）：CDP 指令的錯誤原樣傳出去，找不到 session 或 target
 * 丟 code 'frame-detached'，CDP 回了預期外的形狀丟 code 'invalid-response'。
 */
async function ownerStep(deps: CollectDeps, sessionId: string): Promise<OwnerStep> {
  const targets = deps.cdp.getAttachedTargets()
  const self = targets.find((t) => t.sessionId === sessionId)
  if (self === undefined) {
    throw new CdpError(`getAttachedTargets 找不到 sessionId ${sessionId} 的 target`, 'frame-detached')
  }
  const parentTargetId = await findParentTargetId(deps, self.targetId)
  // 父 target 不在附著清單裡代表父就是頁面本身，指令送 root（sessionId 為 undefined）。
  const parentSessionId = targets.find((t) => t.targetId === parentTargetId)?.sessionId
  const owner = await deps.cdp.send<{ backendNodeId?: unknown }>(
    'DOM.getFrameOwner',
    { frameId: self.targetId },
    parentSessionId
  )
  const backendNodeId = owner?.backendNodeId
  if (typeof backendNodeId !== 'number') {
    throw new CdpError(`DOM.getFrameOwner 沒有回傳 frame ${self.targetId} 的 backendNodeId`, 'invalid-response')
  }
  const box = await deps.cdp.send<{ model?: { content?: unknown } }>(
    'DOM.getBoxModel',
    { backendNodeId },
    parentSessionId
  )
  const rect = quadToRect(box?.model?.content)
  if (rect === null) {
    throw new CdpError(`DOM.getBoxModel 沒有回傳 frame ${self.targetId} 可用的 content 矩形`, 'invalid-response')
  }
  return { sessionId, parentSessionId, dx: rect.x, dy: rect.y }
}

/**
 * 一個 session 的頂層 frame 在主視窗 viewport 裡的位置（裁決 7）。root 為 {0,0}。
 *
 * 沿 target 的父欄位鏈往上走到 root，把每一層的左上角加起來：巢狀 OOPIF
 * （SSO 登入框包在金流 iframe 裡）要加兩層以上才會對。寫成迴圈而不是遞迴，
 * 是為了讓「parentId 成環」這種結構異常只是一個 throw，不必在遞迴的每一層各自處理。
 *
 * 任一層失敗整條往外丟，不回退成 {0,0}（裁決 29）：算不出來時給一個「看起來合理
 * 但其實是 iframe 內部座標」的值，會讓 click 點到主頁上的別的東西。要不要容忍失敗
 * 由呼叫端決定：snapshot 端自己 catch 成 {0,0}（節點清單仍有價值），click 端不 catch。
 *
 * cache 由呼叫端提供並在同一次 snapshot 內共用（裁決 7「同一次 snapshot 內以
 * sessionId 快取，不重算」）；controller 點擊時重算 offset 只傳兩個參數即可。
 * 只有成功解析的層會進 cache，失敗不留下任何紀錄。
 */
export async function resolveFrameOffset(
  deps: CollectDeps,
  sessionId: string | undefined,
  cache: Map<string, Point> = new Map()
): Promise<Point> {
  if (sessionId === undefined) return ORIGIN
  const steps: OwnerStep[] = []
  const walking = new Set<string>()
  let base = ORIGIN
  let current: string | undefined = sessionId
  while (current !== undefined) {
    const cached = cache.get(current)
    if (cached !== undefined) {
      base = cached
      break
    }
    if (walking.has(current)) {
      throw new CdpError(`target 的父欄位形成迴圈（sessionId ${current}）`, 'invalid-response')
    }
    walking.add(current)
    const step = await ownerStep(deps, current)
    steps.push(step)
    current = step.parentSessionId
  }
  let acc = base
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step === undefined) continue
    acc = { x: acc.x + step.dx, y: acc.y + step.dy }
    cache.set(step.sessionId, acc)
  }
  return acc
}

/**
 * 裁決 29 的 snapshot 端：offset 算不出來時該 frame 的 offset 用 {0,0} 並 logError，
 * frame 照常列入（節點與 ref 仍然可用，view_type 不需要座標）。同一個 session
 * 只記一次，不會因為它底下有五個 frame 就記五次。
 */
async function frameOffset(
  deps: CollectDeps,
  sessionId: string | undefined,
  cache: Map<string, Point>,
  failed: Set<string>
): Promise<Point> {
  if (sessionId === undefined) return ORIGIN
  if (failed.has(sessionId)) return ORIGIN
  try {
    return await resolveFrameOffset(deps, sessionId, cache)
  } catch (e) {
    failed.add(sessionId)
    deps.logError(
      new Error(`session ${sessionId} 的 offset 算不出來，這個 frame 的座標以 {0,0} 計：${errorOf(e).message}`, {
        cause: e,
      })
    )
    return ORIGIN
  }
}
```

第三段（box 蒐集與 `collectSnapshotInput`）：

```ts
/** buildSnapshot 規則 2 裡「不必查 box 就能排除」的那半：ignored、角色白名單、有 backendDOMNodeId。 */
function candidateBackendNodeId(node: AxRawNode): number | undefined {
  if (node.ignored !== false) return undefined
  const role = node.role?.value
  if (typeof role !== 'string') return undefined
  if (!INTERACTIVE_ROLES.has(role) && !STRUCTURAL_ROLES.has(role)) return undefined
  return node.backendDOMNodeId
}

interface BoxBudget {
  remaining: number
  skipped: number
}

/**
 * 逐個 await（裁決 7）：一次幾百個 CDP 指令並發會讓 Electron 的 debugger 排隊到逾時。
 * getBoxModel 失敗是常態（display: none 的元素在 AX 樹裡還在），不記錄，
 * 沒有矩形的節點由 buildSnapshot 規則 2 略過。
 */
async function collectBoxes(
  deps: CollectDeps,
  sessionId: string | undefined,
  nodes: readonly AxRawNode[],
  budget: BoxBudget
): Promise<ReadonlyMap<number, Rect>> {
  const boxes = new Map<number, Rect>()
  for (const node of nodes) {
    const backendNodeId = candidateBackendNodeId(node)
    if (backendNodeId === undefined) continue
    if (budget.remaining <= 0) {
      budget.skipped += 1
      continue
    }
    budget.remaining -= 1
    try {
      const box = await deps.cdp.send<{ model?: { border?: unknown } }>(
        'DOM.getBoxModel',
        { backendNodeId },
        sessionId
      )
      const rect = quadToRect(box?.model?.border)
      if (rect !== null) boxes.set(backendNodeId, rect)
    } catch {
      // 略過：沒有矩形就等同不存在
    }
  }
  return boxes
}

/**
 * 蒐集 buildSnapshot（Task 4）需要的全部輸入：frame 清單、每個 frame 的 AX 樹、
 * 矩形表、offset 與 viewport。純粹是 I/O，過濾與編號的規則全在 snapshot.ts。
 */
export async function collectSnapshotInput(
  deps: CollectDeps,
  id: number,
  scope: 'viewport' | 'full'
): Promise<SnapshotInput> {
  const viewport = await readViewport(deps)
  const discovered = await discoverFrames(deps)
  const offsets = new Map<string, Point>()
  const failedOffsets = new Set<string>()
  const budget: BoxBudget = { remaining: MAX_BOX_LOOKUPS, skipped: 0 }
  const frames: FrameInput[] = []
  let unattachedFrames = 0

  for (const frame of discovered) {
    const nodes = await fetchAxNodes(deps, frame)
    if (nodes === null) {
      unattachedFrames += 1
      continue
    }
    const offset = await frameOffset(deps, frame.sessionId, offsets, failedOffsets)
    const boxes = await collectBoxes(deps, frame.sessionId, nodes, budget)
    frames.push({
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      frameId: frame.frameId,
      url: frame.url,
      offset,
      nodes,
      boxes,
    })
  }

  if (budget.skipped > 0) {
    deps.logError(
      new Error(`snapshot 的候選節點超過 ${MAX_BOX_LOOKUPS} 個，有 ${budget.skipped} 個沒有查矩形，不會出現在 snapshot 裡`)
    )
  }
  // 裁決 6 第 4 點：re-arm 失敗代表有子代 target 沒附著上，數字不能是 0。
  if (deps.cdp.getRearmErrors().length > 0) unattachedFrames = Math.max(1, unattachedFrames)

  return {
    id,
    takenAt: deps.now(),
    url: deps.currentUrl(),
    title: deps.currentTitle(),
    scope,
    viewport,
    frames,
    unattachedFrames,
  }
}
```

實作上兩個值得說明的取捨。第一，box 查詢是照 `nodes` 陣列順序走，不是照 `childIds` 的深度優先順序：順序只影響「超過 1500 個候選時哪些查得到矩形」這個已經降級的情況，而深度優先的規則是 Task 4 `snapshot.ts` 裡 `traverse()` 的職責，在這裡再寫一次等於同一條規則有兩份實作、兩邊可能各自改壞。`Accessibility.getFullAXTree` 實機回來的陣列本來就是前序（Task 4 的 `form.real.json` 是這樣，手寫的 `form.json` 才刻意打亂），所以真實資料上兩者一致。

第二，`candidateBackendNodeId` 只做「不必查 box 就能排除」的那三條（ignored、角色白名單、有 `backendDOMNodeId`），不做 `STRUCTURAL_ROLES` 的 name 非空檢查。那條是 `buildSnapshot` 規則 2 的一部分，放進來會變成兩個檔案各持有半條規則；多查幾個 `getBoxModel` 的代價遠小於規則散在兩處的代價。

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/snapshot-collect.test.ts
```

實跑輸出：

```
 Test Files  1 passed (1)
      Tests  36 passed (36)
```

型別檢查（實跑，零輸出、結束碼 0）：

```bash
npx tsc --noEmit
```

本模組自己的覆蓋率（實跑，兩個門檻都過：Stmts ≥ 93、Branch ≥ 86）：

```bash
npx vitest run --coverage --coverage.reporter=text \
  --coverage.include='src/main/view-tools/snapshot-collect.ts' \
  tests/view-tools/snapshot-collect.test.ts
```

```
 ...hot-collect.ts |   96.89 |    89.65 |     100 |     100 |
```

- [ ] **Step 5: 突變測試**

八個突變，全部在 worktree 實跑。每一個都先確認變紅、記下變紅的測試名稱，還原後確認回到 36 passed。

**突變 1：offset 不往上遞迴，只算自己在父層裡的位置**

```diff
     steps.push(step)
-    current = step.parentSessionId
+    current = undefined
```

```bash
npx vitest run tests/view-tools/snapshot-collect.test.ts
```

變紅 6 個（30 passed）：`兩層 OOPIF：offset 是整條父鏈相加，不是只有自己那一層`、`getFrameOwner 送到父 session：T-inner 問 s-outer，T-outer 問 root`、`TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）`、`父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）`、`父欄位成環時往外丟 invalid-response，不會無限打轉`、`同一次 snapshot 內同一個 session 只算一次（快取）`。這是裁決 7 最容易被寫成的錯誤版本：單層 OOPIF 測起來完全正確，只有巢狀兩層才會露餡，所以測試資料一定要有兩層而且兩層的值都非零。還原後 36 passed。

**突變 2：`Target.getTargets` 找不到 parentId 時當成「父就是頁面本身」**

```diff
   const parentId = entry?.parentId ?? entry?.parentFrameId
-  if (typeof parentId !== 'string' || parentId === '') {
-    throw new CdpError(`Target.getTargets 找不到 target ${targetId} 的父 target`, 'frame-detached')
-  }
-  return parentId
+  return typeof parentId === 'string' ? parentId : ''
```

變紅 3 個（33 passed）：`Target.getTargets 找不到這個 target 的父 target 時往外丟 frame-detached（裁決 29）`、`TargetInfo 有這個 target 但兩個父欄位都沒有時往外丟 frame-detached`、`父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）`。空字串找不到對應 target，於是 `parentSessionId` 變成 undefined、指令改送 root，算出一個看起來合理但其實是別人座標系的 offset，而且一聲不吭。還原後 36 passed。

**突變 3：`MAX_BOX_LOOKUPS` 改成每個 frame 各自一份額度**

```diff
     if (nodes === null) {
       unattachedFrames += 1
       continue
     }
+    budget.remaining = MAX_BOX_LOOKUPS
     const offset = await frameOffset(deps, frame.sessionId, offsets, failedOffsets)
```

變紅 1 個（35 passed）：`額度跨 frame 共用：兩個各 800 個候選的 frame 只查 1500 次，多的不查也不進 boxes，並記錄一次`（實際查了 1600 次、第二個 frame 拿到 800 個矩形而不是 700 個）。這個突變說明為什麼那個測試要用「兩個各 800 個」而不是「一個 1600 個」：單一 frame 的測試對兩種寫法都會通過。還原後 36 passed。

**突變 4：拿掉 `getRearmErrors()` 非空時的下限**

```diff
-  // 裁決 6 第 4 點：re-arm 失敗代表有子代 target 沒附著上，數字不能是 0。
-  if (deps.cdp.getRearmErrors().length > 0) unattachedFrames = Math.max(1, unattachedFrames)
-
```

變紅 2 個（34 passed）：`getRearmErrors 非空、但所有 frame 的 AX 樹都抓得到時，unattachedFrames 仍至少是 1`、`form.json 加一個 OOPIF：ref 連續編號、OOPIF 節點的 bounds 已經加上 offset、未附著數進文字`（後者的第一行從 `[iframe 未附著 1 個]` 變成 `[page] …`）。還原後 36 passed。

**突變 5：`Target.getTargets` 的回傳用清單第一筆，不用 targetId 精確比對**

```diff
   const entry = Array.isArray(infos)
-    ? (infos as readonly RawTargetInfo[]).find((t) => t?.targetId === targetId)
+    ? (infos as readonly RawTargetInfo[])[0]
     : undefined
```

變紅 11 個（25 passed）：`單層 OOPIF：offset 就是父 session 裡 content 的左上角`、`兩層 OOPIF：offset 是整條父鏈相加，不是只有自己那一層`、`getFrameOwner 送到父 session：T-inner 問 s-outer，T-outer 問 root`、`Target.getTargets 找不到這個 target 的父 target 時往外丟 frame-detached（裁決 29）`、`TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）`、`DOM.getFrameOwner 失敗時把原本的 CdpError 原樣往外丟，不換成別的 code`、`DOM.getFrameOwner 沒有回傳 backendNodeId 時往外丟 invalid-response`、`父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）`、`content 的四點順序打亂時取最小外接矩形的左上角`、`content 不是八個數字時往外丟 invalid-response`、`同一次 snapshot 內同一個 session 只算一次（快取）`。這正是 RESULTS-03「`getTargets` 回整個 browser context 的 target，不能拿清單順序當結構」那一條，所以測試的 `targetInfos` 刻意排成 `[T-page, T-inner, T-outer]`，跟父子順序不一致。還原後 36 passed。

**突變 6：`quadToRect` 取第一個點，不取四點的最小值**

```diff
-  const minX = Math.min(...xs)
-  const minY = Math.min(...ys)
-  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
+  const [x0 = 0, y0 = 0] = [xs[0], ys[0]]
+  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
```

變紅 2 個（34 passed）：`content 的四點順序打亂時取最小外接矩形的左上角`、`border 取四點的最小外接矩形，順序打亂與非軸對齊都算得出來`。四點若照左上、右上、右下、左下排列，兩種寫法同值，所以這兩個測試的 quad 一個是順序打亂、一個是旋轉過的菱形。還原後 36 passed。

**突變 7：只讀 `parentId`，拿掉 `parentFrameId` 的退路（裁決 26）**

```diff
-  const parentId = entry?.parentId ?? entry?.parentFrameId
+  const parentId = entry?.parentId
```

變紅 1 個（35 passed）：`TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）`。這個突變擋的是「照 CDP 文件只讀一個欄位」這種看起來最正規的寫法：真的發生時不會有錯誤訊息，只有全部 OOPIF 的座標一起變成 `{0,0}`，點擊落在主視窗左上角。還原後 36 passed。

**突變 8：`collectSnapshotInput` 不 catch offset 的失敗（裁決 29 的 snapshot 端）**

```diff
   if (sessionId === undefined) return ORIGIN
   if (failed.has(sessionId)) return ORIGIN
-  try {
-    return await resolveFrameOffset(deps, sessionId, cache)
-  } catch (e) {
-    failed.add(sessionId)
-    deps.logError(
-      new Error(`session ${sessionId} 的 offset 算不出來，這個 frame 的座標以 {0,0} 計：${errorOf(e).message}`, {
-        cause: e,
-      })
-    )
-    return ORIGIN
-  }
+  return await resolveFrameOffset(deps, sessionId, cache)
```

變紅 1 個（35 passed）：`offset 算不出來時該 frame 用 {0,0}、記錄一次，frame 與它的節點照常列入`（整個 `collectSnapshotInput` 改成 reject）。這個突變與突變 1 到 7 的方向相反：其他七個防的是「算錯」，這一個防的是「一個 OOPIF 的座標算不出來就整份 snapshot 都不給」，模型連頁面上還有什麼都看不到。還原後 36 passed。

- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/snapshot-collect.ts tests/view-tools/snapshot-collect.test.ts
git commit -m "feat: 用 CDP 蒐集 snapshot 輸入（frame 樹、AX 樹、矩形與 OOPIF offset）"
```

---

### Task 6: 插手監看與摘要（watch.ts）

`watch.ts` 是右窗格「人機共用同一個 WebContents」這件事在程式碼裡唯一負責記帳的模組。它同時做兩件不相關但都要盯著同一批 CDP 事件的事：判斷 `RefTable` 什麼時候該作廢（`DOM.documentUpdated`、主 frame 換頁、使用者敲鍵盤滑鼠），以及把「使用者到底插手了幾次」累計成 `InterventionLog`，讓 `view_snapshot` 能在回傳文字裡老實告訴模型「你上次操作後發生了什麼」。裁決 5 又把三個 CDP 域（`DOM`、`Network`、`Accessibility`）的啟用塞進這個檔案：因為它本來就要訂閱 `Target.attachedToTarget`（cdp.ts 遞迴 re-arm 之後照樣把這個事件廣播出來）才能判斷「這是不是主 frame」，收到新 session 時順手補這三個域的啟用，不用另開一個模組重複訂閱同一個事件。`Page`／`Runtime` 已經由 cdp.ts 在 root 啟用過，契約 §9.1 裁決 5 只列了三個域，不是五個，這裡照契約字面只送三個。

最容易讀漏的一段規則是 agent 動作期間（`runAsAgent` 內）對 `input-event` 與 `Page.frameNavigated` 這兩種訊號的處理**不是同一套**。`input-event` 在 agent 期間「一律不計、不失效」：agent 自己用 CDP 的 `Input.dispatchMouseEvent` 觸發點擊時，Electron 照樣會冒出一個 `mouseDown` 的 `input-event`，如果不排除，agent 每點一次自己的按鈕就會被記成一次使用者插手，`view_snapshot` 的摘要會變成雜訊，而且會把自己剛設好的 `RefTable` 立刻打成失效。但 `Page.frameNavigated` 不一樣：agent 呼叫 `view_navigate` 觸發的真實換頁，舊 snapshot 的 ref 真的全部作廢了，這件事跟「是不是 agent 自己導航的」無關，所以失效永遠發生；只有 `navigations` 這個要進插手摘要文字的計數，才在 agent 期間跳過（`agentDepth === 0` 才加一）。這是契約 §9.3 寫的兩條不同規則，不是同一條規則的兩種寫法，實作時分開處理，不能把 `input-event` 的排除邏輯直接套到 `frameNavigated` 上。

第一個失效原因保留、之後的失效不覆蓋，是為了讓模型收到的訊息貼近真實成因：`RefTable` 一旦失效 `entries` 就清空，如果任由後到的事件改寫 `invalidatedBy`，常見情境是頁面自己非同步重繪（`documentUpdated`）先發生，接著使用者又點了一下，原因被覆寫成 `userInput`，模型看到的訊息就會誤導成「使用者插手了」而不是「頁面自己重繪了」。判斷式因此不是「每次都换新表」，而是「entries 還有東西，或者這份表根本還沒失效過」才换。

主 frame 的判準有一處契約字面沒寫死，這裡列成契約疑慮：契約 §9.3 只說「`Page.frameNavigated` 且主 frame」，沒有明講要不要連 `sessionId` 一起看；對照的 `settle.ts`（契約 §9.2）規則只看 `frame.parentId`，不提 session。CDP 的 frame 樹是「每個 target 各自一份」，OOPIF 自己那個 session 裡的頂層 frame，從它自己的角度看 `parentId` 一樣是 `undefined`；若只看 `parentId`，使用者在跨站 iframe（例如 SSO 登入框）裡點連結換頁，會被誤記成整個右窗格換頁。這裡的實作要求 `sessionId === undefined`（root session）**且** `frame.parentId === undefined` 才算主 frame，兩個條件缺一不可，測試把「OOPIF 自身 session、無 parentId」與「子 frame、有 parentId」分開驗證。

**Files:**
- Create `src/main/view-tools/watch.ts`
- Test: `tests/view-tools/watch.test.ts`

**Interfaces:**

Consumes：
- Task 1（`src/main/cdp.ts`）的 `CdpSession`，只用 `onEvent`／`send`／`getAttachedTargets`（`Pick<CdpSession, 'onEvent' | 'send' | 'getAttachedTargets'>`），簽章照契約 §4：
```ts
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
```
- Task 0（`src/main/view-tools/types.ts`）的 `InvalidationReason`、`RefEntry`、`RefTable`、`InterventionLog`，簽章照契約 §5。
- Task 2（`src/main/view-tools/refs.ts`）的 `EMPTY_REFS`、`invalidateRefs`：
```ts
export const EMPTY_REFS: RefTable
export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable
```

Produces（契約 §9.3 全部匯出，簽章逐字照契約）：
```ts
export interface WatchDeps {
  readonly cdp: Pick<CdpSession, 'onEvent' | 'send' | 'getAttachedTargets'>
  readonly webContents: {
    on(event: 'input-event', listener: (event: unknown, input: { readonly type: string }) => void): unknown
    off(event: 'input-event', listener: (event: unknown, input: { readonly type: string }) => void): unknown
    getURL(): string
  }
  readonly logError: (error: Error) => void
}
export interface Watcher {
  refs(): RefTable
  setRefs(table: RefTable): void
  intervention(): InterventionLog
  takeIntervention(): InterventionLog
  runAsAgent<T>(fn: () => Promise<T>): Promise<T>
  dispose(): void
}
export function createWatcher(deps: WatchDeps): Promise<Watcher>
export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null
```

下游：Task 9（`controller.ts` 持有 `watcher: Watcher`，每個工具方法把 CDP 動作包在 `watcher.runAsAgent()` 裡，`snapshot` 方法用 `setRefs`／`takeIntervention`，`click`／`type` 用 `refs()` 給 `lookupRef`）、Task 10（`server.ts` 的 `createViewToolServer` 建構時 `await createWatcher(...)`，`dispose()` 呼叫 `watcher.dispose()`）。

- [ ] **Step 1：寫失敗的測試**

建立 `tests/view-tools/watch.test.ts`（`../helpers/fake-cdp.ts` 的 `createFakeCdp()` 是 Task 1 產出，簽章照契約 §14 第二點；下游 task 執行時它應已存在）：

```ts
import { describe, expect, it, vi } from 'vitest'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import { EMPTY_REFS } from '../../src/main/view-tools/refs.js'
import { createWatcher, summarizeIntervention } from '../../src/main/view-tools/watch.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

type InputListener = (event: unknown, input: { readonly type: string }) => void

type OnOffMock = ReturnType<typeof vi.fn<(event: 'input-event', listener: InputListener) => unknown>>

function createFakeWebContents(initialUrl: string): {
  readonly on: OnOffMock
  readonly off: OnOffMock
  getURL(): string
  setUrl(url: string): void
} {
  let url = initialUrl
  return {
    on: vi.fn(),
    off: vi.fn(),
    getURL: () => url,
    setUrl: (u: string) => {
      url = u
    },
  }
}

function inputListenerOf(wc: { readonly on: OnOffMock }): InputListener {
  const call = wc.on.mock.calls.find((c) => c[0] === 'input-event')
  if (!call) throw new Error('input-event 未註冊')
  return call[1]
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

const entry: RefEntry = { backendNodeId: 101, role: 'button', name: '送出' }

describe('createWatcher：裁決 5 的域啟用', () => {
  it('建立時對 root 與既有 iframe target 各送 DOM／Network／Accessibility 三個 enable，非 iframe target 不送', async () => {
    const cdp = createFakeCdp()
    cdp.setAttachedTargets([
      { targetId: 't1', type: 'iframe', url: 'https://oopif.example/', sessionId: 's1' },
      { targetId: 't2', type: 'page', url: 'about:blank', sessionId: 's2' },
    ])
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })

    const calls = cdp.send.mock.calls
    const rootMethods = calls.filter((c) => c[2] === undefined).map((c) => c[0])
    const s1Methods = calls.filter((c) => c[2] === 's1').map((c) => c[0])
    const s2Methods = calls.filter((c) => c[2] === 's2')

    expect(rootMethods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(s1Methods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(s2Methods).toEqual([])
  })

  it('之後收到 Target.attachedToTarget（iframe）時對新 sessionId 再送三個 enable', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    cdp.send.mockClear()

    cdp.emit('Target.attachedToTarget', {
      sessionId: 's9',
      targetInfo: { targetId: 't9', type: 'iframe', url: 'https://new.example/' },
    })
    await flush()

    const s9Methods = cdp.send.mock.calls.filter((c) => c[2] === 's9').map((c) => c[0])
    expect(s9Methods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
  })

  it('Target.attachedToTarget 但 type 不是 iframe 時不送 enable', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    cdp.send.mockClear()

    cdp.emit('Target.attachedToTarget', {
      sessionId: 's9',
      targetInfo: { targetId: 't9', type: 'page', url: 'https://new.example/' },
    })
    await flush()

    expect(cdp.send.mock.calls.filter((c) => c[2] === 's9')).toEqual([])
  })

  it('enable 失敗記 logError 不丟出，且不中斷其餘 enable', async () => {
    const cdp = createFakeCdp()
    cdp.send.mockImplementation(async (method: unknown) => {
      if (method === 'Network.enable') throw new Error('nope')
      return undefined
    })
    const wc = createFakeWebContents('https://a.example/')
    const logError = vi.fn()

    await expect(createWatcher({ cdp, webContents: wc, logError })).resolves.toBeDefined()

    const rootMethods = cdp.send.mock.calls.filter((c) => c[2] === undefined).map((c) => c[0])
    expect(rootMethods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })
})

describe('refs 失效', () => {
  it('DOM.documentUpdated（任一 session）使 refs 失效，原因 documentUpdated', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 3, entries: new Map([['s3-e0', entry]]) })

    cdp.emit('DOM.documentUpdated', {}, 's7')

    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')
    expect(watcher.refs().entries.size).toBe(0)
    expect(watcher.refs().snapshotId).toBe(3)
  })

  it('主 frame（root session、frame.parentId 不存在）的 Page.frameNavigated 使 refs 失效並計入 navigations', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })

    expect(watcher.refs().invalidatedBy).toBe('navigated')
    expect(watcher.intervention().navigations).toBe(1)
  })

  it('子 frame（frame.parentId 有值）的 frameNavigated 不算導航、不使 refs 失效（突變候選）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: 'root-frame-id' } })

    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('OOPIF 自身 session（sessionId 非 undefined、無 parentId）的 frameNavigated 不算主 frame（見回報契約疑慮）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } }, 's1')

    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('第一個失效原因保留，之後不同來源的失效不覆蓋（突變候選）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    cdp.emit('DOM.documentUpdated', {})
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')

    inputListenerOf(wc)(undefined, { type: 'mouseDown' })
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')
  })
})

describe('使用者輸入（input-event）', () => {
  it('mouseDown 計 clicks 並使 refs 失效（userInput）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    inputListenerOf(wc)(undefined, { type: 'mouseDown' })

    expect(watcher.intervention().clicks).toBe(1)
    expect(watcher.refs().invalidatedBy).toBe('userInput')
  })

  it('keyDown 計 keys 並使 refs 失效（userInput）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    inputListenerOf(wc)(undefined, { type: 'keyDown' })

    expect(watcher.intervention().keys).toBe(1)
    expect(watcher.refs().invalidatedBy).toBe('userInput')
  })

  it('其他 type（mouseUp／mouseMove／keyUp／char／mouseWheel）不計、不使 refs 失效', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })
    const listener = inputListenerOf(wc)

    for (const type of ['mouseUp', 'mouseMove', 'keyUp', 'char', 'mouseWheel']) {
      listener(undefined, { type })
    }

    expect(watcher.intervention()).toEqual({ clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://a.example/' })
    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
  })
})

describe('runAsAgent', () => {
  it('期間的 frameNavigated 仍使 refs 失效，但不計入 navigations（突變候選：期間導航被算成使用者導覽）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 4, entries: new Map([['s4-e0', entry]]) })

    await watcher.runAsAgent(async () => {
      cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })
      return null
    })

    expect(watcher.refs().invalidatedBy).toBe('navigated')
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('期間的 input-event 不計、不使 refs 失效（agent 自己的 CDP 操作觸發的合成輸入）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 4, entries: new Map([['s4-e0', entry]]) })
    const listener = inputListenerOf(wc)

    await watcher.runAsAgent(async () => {
      listener(undefined, { type: 'mouseDown' })
      return null
    })

    expect(watcher.intervention().clicks).toBe(0)
    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
  })

  it('可重入：巢狀呼叫時內層結束不會提前恢復使用者插手偵測（用計數器而非布林）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    await watcher.runAsAgent(async () => {
      await watcher.runAsAgent(async () => {
        listener(undefined, { type: 'mouseDown' })
        return null
      })
      // 內層已經 return，但外層仍在進行中：這裡仍不該被計入
      listener(undefined, { type: 'mouseDown' })
      return null
    })
    expect(watcher.intervention().clicks).toBe(0)

    listener(undefined, { type: 'mouseDown' })
    expect(watcher.intervention().clicks).toBe(1)
  })

  it('fn 丟例外時仍會還原旗標（try/finally），例外原樣往外丟', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    await expect(
      watcher.runAsAgent(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    listener(undefined, { type: 'mouseDown' })
    expect(watcher.intervention().clicks).toBe(1)
  })
})

describe('intervention／takeIntervention', () => {
  it('intervention() 不歸零', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    inputListenerOf(wc)(undefined, { type: 'mouseDown' })

    watcher.intervention()

    expect(watcher.intervention().clicks).toBe(1)
  })

  it('takeIntervention() 回傳目前 log 並歸零，fromUrl 設為目前網址（突變候選：沒歸零）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)
    listener(undefined, { type: 'mouseDown' })
    listener(undefined, { type: 'keyDown' })
    wc.setUrl('https://b.example/')

    const first = watcher.takeIntervention()
    expect(first).toEqual({ clicks: 1, keys: 1, navigations: 0, fromUrl: 'https://a.example/' })

    const second = watcher.takeIntervention()
    expect(second).toEqual({ clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://b.example/' })
  })
})

describe('setRefs／refs', () => {
  it('初始為 EMPTY_REFS；setRefs 直接替換整份表', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })

    expect(watcher.refs()).toBe(EMPTY_REFS)

    const table: RefTable = { snapshotId: 9, entries: new Map([['s9-e0', entry]]) }
    watcher.setRefs(table)
    expect(watcher.refs()).toBe(table)
  })
})

describe('dispose', () => {
  it('解除 cdp.onEvent 訂閱與 webContents 的 input-event 監聽', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    watcher.dispose()

    expect(wc.off).toHaveBeenCalledWith('input-event', listener)

    watcher.setRefs({ snapshotId: 1, entries: new Map([['s1-e0', entry]]) })
    cdp.emit('DOM.documentUpdated', {})
    expect(watcher.refs().invalidatedBy).toBeUndefined()
  })
})

describe('summarizeIntervention', () => {
  it('三個計數都是 0 時回 null', () => {
    const log = { clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBeNull()
  })

  it('網址改變時用「網址從 A 變成 B」', () => {
    const log = { clicks: 3, keys: 12, navigations: 1, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://b.example/')).toBe(
      '使用者在你上次操作後點了 3 次、按了 12 個鍵，網址從 https://a.example/ 變成 https://b.example/'
    )
  })

  it('網址相同但 navigations > 0 時用「網址仍是」', () => {
    const log = { clicks: 1, keys: 0, navigations: 2, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBe(
      '使用者在你上次操作後點了 1 次、按了 0 個鍵，網址仍是 https://a.example/'
    )
  })

  it('navigations 為 0 且網址相同時省略網址段', () => {
    const log = { clicks: 2, keys: 5, navigations: 0, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBe('使用者在你上次操作後點了 2 次、按了 5 個鍵')
  })
})
```

- [ ] **Step 2：跑測試確認失敗**

```bash
npx vitest run tests/view-tools/watch.test.ts
```

預期：找不到 `src/main/view-tools/watch.ts`（模組不存在），測試檔本身載入失敗，全部 24 個案例顯示為錯誤（`Error: Cannot find module '../../src/main/view-tools/watch.js'` 或等價的解析錯誤）。

- [ ] **Step 3：最小實作**

建立 `src/main/view-tools/watch.ts`：

```ts
import type { CdpSession } from '../cdp.js'
import { EMPTY_REFS, invalidateRefs } from './refs.js'
import type { InterventionLog, InvalidationReason, RefTable } from './types.js'

type InputListener = (event: unknown, input: { readonly type: string }) => void

export interface WatchDeps {
  readonly cdp: Pick<CdpSession, 'onEvent' | 'send' | 'getAttachedTargets'>
  readonly webContents: {
    on(event: 'input-event', listener: InputListener): unknown
    off(event: 'input-event', listener: InputListener): unknown
    getURL(): string
  }
  readonly logError: (error: Error) => void
}

export interface Watcher {
  refs(): RefTable
  setRefs(table: RefTable): void
  intervention(): InterventionLog
  takeIntervention(): InterventionLog
  runAsAgent<T>(fn: () => Promise<T>): Promise<T>
  dispose(): void
}

// 裁決 5（docs/superpowers/plan-b/CONTRACT.md）：域的啟用由 watch.ts 做，Page／Runtime 已由 cdp.ts 啟用，
// 這裡只補 DOM／Network／Accessibility 三個。
const ENABLE_METHODS = ['DOM.enable', 'Network.enable', 'Accessibility.enable'] as const

interface FrameNavigatedParams {
  readonly frame?: { readonly parentId?: string }
}
interface AttachedToTargetParams {
  readonly sessionId: string
  readonly targetInfo: { readonly type: string }
}

async function enableDomains(
  cdp: WatchDeps['cdp'],
  sessionId: string | undefined,
  logError: WatchDeps['logError']
): Promise<void> {
  for (const method of ENABLE_METHODS) {
    try {
      await cdp.send(method, {}, sessionId)
    } catch (e) {
      logError(e instanceof Error ? e : new Error(String(e)))
    }
  }
}

export async function createWatcher(deps: WatchDeps): Promise<Watcher> {
  let refsTable: RefTable = EMPTY_REFS
  let log: InterventionLog = { clicks: 0, keys: 0, navigations: 0, fromUrl: deps.webContents.getURL() }
  let agentDepth = 0

  const invalidate = (reason: InvalidationReason): void => {
    // 裁決（契約 §9.3）：entries 還有東西，或者尚未失效過，才換新表；已失效的表保留第一個原因。
    if (refsTable.entries.size > 0 || refsTable.invalidatedBy === undefined) {
      refsTable = invalidateRefs(refsTable, reason)
    }
  }

  const onCdpEvent = (method: string, params: unknown, sessionId?: string): void => {
    if (method === 'DOM.documentUpdated') {
      invalidate('documentUpdated')
      return
    }
    if (method === 'Page.frameNavigated') {
      const p = params as FrameNavigatedParams
      const isMainFrame = sessionId === undefined && p.frame !== undefined && p.frame.parentId === undefined
      if (!isMainFrame) return
      invalidate('navigated')
      if (agentDepth === 0) {
        log = { ...log, navigations: log.navigations + 1 }
      }
      return
    }
    if (method === 'Target.attachedToTarget') {
      const p = params as AttachedToTargetParams
      if (p.targetInfo.type === 'iframe') {
        void enableDomains(deps.cdp, p.sessionId, deps.logError)
      }
    }
  }
  const unsubscribe = deps.cdp.onEvent(onCdpEvent)

  const onInputEvent: InputListener = (_event, input) => {
    // 契約 §9.3：agent 動作期間一律不計、不失效（agent 自己觸發的 CDP 輸入也會冒出這個事件）。
    if (agentDepth > 0) return
    if (input.type === 'mouseDown') {
      log = { ...log, clicks: log.clicks + 1 }
      invalidate('userInput')
    } else if (input.type === 'keyDown') {
      log = { ...log, keys: log.keys + 1 }
      invalidate('userInput')
    }
  }
  deps.webContents.on('input-event', onInputEvent)

  await enableDomains(deps.cdp, undefined, deps.logError)
  for (const target of deps.cdp.getAttachedTargets()) {
    if (target.type === 'iframe') {
      await enableDomains(deps.cdp, target.sessionId, deps.logError)
    }
  }

  return {
    refs: () => refsTable,
    setRefs: (table) => {
      refsTable = table
    },
    intervention: () => log,
    takeIntervention: () => {
      const current = log
      log = { clicks: 0, keys: 0, navigations: 0, fromUrl: deps.webContents.getURL() }
      return current
    },
    runAsAgent: async (fn) => {
      agentDepth += 1
      try {
        return await fn()
      } finally {
        agentDepth -= 1
      }
    },
    dispose: () => {
      unsubscribe()
      deps.webContents.off('input-event', onInputEvent)
    },
  }
}

function urlSegment(log: InterventionLog, currentUrl: string): string | null {
  if (log.fromUrl !== currentUrl) return `網址從 ${log.fromUrl} 變成 ${currentUrl}`
  if (log.navigations === 0) return null
  return `網址仍是 ${currentUrl}`
}

export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null {
  if (log.clicks === 0 && log.keys === 0 && log.navigations === 0) return null
  const base = `使用者在你上次操作後點了 ${log.clicks} 次、按了 ${log.keys} 個鍵`
  const seg = urlSegment(log, currentUrl)
  return seg === null ? base : `${base}，${seg}`
}
```

`watch.ts` 148 行。`invalidate` 的判斷式與 `runAsAgent` 用 `agentDepth`（數字而非布林）是這個 task 的兩個關鍵設計點，都已在前面的段落說明理由；`onCdpEvent` 用單一 if-chain 依序判斷三種 method，不拆成三個各自訂閱的 listener，因為契約要求的是同一個 `cdp.onEvent` 訂閱點收全部事件，拆開沒有好處只會多兩次訂閱開銷。

- [ ] **Step 4：跑測試確認通過**

```bash
npx vitest run tests/view-tools/watch.test.ts
```

已實測（worktree `/tmp/wt-6`，Task 0／1／2 尚未實作，照契約簽章自建最小 stub：`src/main/view-tools/types.ts`、`src/main/view-tools/refs.ts`（`EMPTY_REFS`／`invalidateRefs`／`parseRef`／`formatRef`／`lookupRef`）、`tests/helpers/fake-cdp.ts`，以及在既有 `src/main/cdp.ts` 上疊加 Task 1 的 `onEvent`／`AttachedTargetInfo.sessionId` 兩個新增欄位，讓 `watch.ts` 能照契約字面 `import type { CdpSession } from '../cdp.js'`）：

```
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

`npx tsc --noEmit -p tsconfig.json` 對這四個檔案（`watch.ts`、`watch.test.ts`、stub 的 `types.ts`／`refs.ts`／`fake-cdp.ts`、疊加後的 `cdp.ts`）0 error。

- [ ] **Step 5：突變測試**

四個突變都已在 worktree 實跑（改實作、跑測試看到指定案例變紅、還原、確認回綠）。

**突變 1：第一個失效原因被後來的覆蓋。**
```diff
-  const invalidate = (reason: InvalidationReason): void => {
-    if (refsTable.entries.size > 0 || refsTable.invalidatedBy === undefined) {
-      refsTable = invalidateRefs(refsTable, reason)
-    }
-  }
+  const invalidate = (reason: InvalidationReason): void => {
+    refsTable = invalidateRefs(refsTable, reason)
+  }
```
變紅：`refs 失效 > 第一個失效原因保留，之後不同來源的失效不覆蓋（突變候選）`（`AssertionError: expected 'userInput' to be 'documentUpdated'`）。其餘 23 個通過。還原後重跑 24 個全綠。

**突變 2：runAsAgent 期間的導航被算成使用者導覽。**
```diff
       invalidate('navigated')
-      if (agentDepth === 0) {
-        log = { ...log, navigations: log.navigations + 1 }
-      }
+      log = { ...log, navigations: log.navigations + 1 }
       return
```
變紅：`runAsAgent > 期間的 frameNavigated 仍使 refs 失效，但不計入 navigations（突變候選：期間導航被算成使用者導覽）`（`expected 1 to be +0`）。其餘 23 個通過。還原後重跑 24 個全綠。

**突變 3：子 frame（有 parentId）的 frameNavigated 也算導航。**
```diff
-      const isMainFrame = sessionId === undefined && p.frame !== undefined && p.frame.parentId === undefined
+      const isMainFrame = sessionId === undefined && p.frame !== undefined
```
變紅：`refs 失效 > 子 frame（frame.parentId 有值）的 frameNavigated 不算導航、不使 refs 失效（突變候選）`（`expected 'navigated' to be undefined`）。其餘 23 個通過。還原後重跑 24 個全綠。

**突變 4：takeIntervention 沒歸零。**
```diff
   takeIntervention: () => {
-      const current = log
-      log = { clicks: 0, keys: 0, navigations: 0, fromUrl: deps.webContents.getURL() }
-      return current
+      return log
     },
```
變紅：`intervention／takeIntervention > takeIntervention() 回傳目前 log 並歸零，fromUrl 設為目前網址（突變候選：沒歸零）`（第二次呼叫回傳仍是 `{ clicks: 1, keys: 1, fromUrl: 'https://a.example/' }` 而非歸零後的值）。其餘 23 個通過。還原後重跑 24 個全綠。

四次突變後都確認 `git diff` 回到與 Step 3 相同的內容，且 `npx vitest run tests/view-tools/watch.test.ts` 回到 24 passed。

- [ ] **Step 6：提交**

```bash
git add src/main/view-tools/watch.ts tests/view-tools/watch.test.ts
git commit -m "feat: 新增 watch.ts 插手監看與摘要"
```
<!-- END -->

---

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

---

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

---

### Task 9: 八個工具的實際動作（controller）

controller 是 B 的執行層：server.ts 把 zod 驗過型別的參數交進來，controller 負責語意檢查（ref、網址、按鍵）、送 CDP、等頁面穩定、把結果組成給模型看的一句話。它是唯一同時碰到 `watcher`、`settle`、`handoff`、`snapshot-collect` 四個有狀態元件的地方，所以錯誤翻譯之外的判斷全部集中在這裡，server.ts 只剩下 `tool()` 註冊與 `CallToolResult` 包裝。

契約 §10.2 把八個方法的流程逐格寫死了，這個 task 的自由度只在「怎麼拆檔」與「怎麼讓測試看得見」。八個方法加 `call()` 逾時、offset 重算、輸出組字放同一個檔實測是 480 行，超過契約 §1 的 400 行上限，所以拆成六個檔。切法依「共用什麼」而不是依工具數量平均切：`controller-core.ts` 是八個方法都要的零件（逾時、進門檢查、`runAsAgent` 包裝、snapshot 流水號、ref 查表），`controller-page.ts` 三個方法共用 settle 的等待與網址檢查，`controller-input.ts` 三個方法共用 ref 查表、座標換算與按鍵送出，`controller-eval.ts` 的兩個方法不碰前兩者任何東西。`controller-types.ts` 單獨存在是為了避免循環匯入：`controller.ts` 匯入三個子模組，子模組又要用 `ControllerDeps`／`ToolOutput`，型別放在最下游的葉節點才不會繞回來。對外匯出仍然只有契約 §10.2 列的那幾個名字，全部從 `controller.ts` 轉出。

三個設計決定值得先講。第一，`call()` 的逾時（裁決 14）用注入的 `MergerClock` 而不是 `setTimeout`，先到的一方用 `settled` 旗標定案：CDP 慢一步回來時不會覆寫已經丟出的逾時，成功之後逾時計時器也已經被清掉。少了這個包裝，Electron 的 `debugger.sendCommand` 在 renderer 掛住時會永遠不 resolve，整個工具呼叫連同左窗格的那一輪對話一起卡死。第二，裁決 9 的 offset 每次點擊重算而不是存進 `RefEntry`：iframe 在主視窗裡的位置會因為捲動而變，存下來的座標在 snapshot 之後就過期了。第三，`requestHandoff` 是八個方法裡唯一不包在 `watcher.runAsAgent()` 內的：等待期間使用者的點擊與按鍵正是這個工具在等的事，要照常計入插手記錄，下一次 `view_snapshot` 才會告訴模型使用者做了什麼。

實機事實兩則：`docs/RESULTS-02-input-focus.md` 量到 CDP 的 `Input.*` 在右窗格沒有焦點、甚至整個視窗失焦時三種狀態各 200/200 全部成功，所以 `click`／`type`／`press` 不需要搶焦點也不需要遮罩。`docs/RESULTS-03-oopif.md` 量到 `Target.getTargets()` 回的是整個 browser context 的清單（會混進其他分頁與上一站殘留的 target），所以裁決 7 的父 target 一定要用 `targetId` 精確比對，不能拿清單順序當結構；同一份文件也記錄了 OOPIF 巢狀到第二層（`accounts.google.com/gsi/button` 這種 SSO 登入框）是真實情況，所以 offset 必須遞迴相加，測試也照這個形狀寫成兩層。

**Files:**

- Create `src/main/view-tools/controller-types.ts`：契約 §10.2 的公開型別（`ControllerDeps`、`ToolText`／`ToolImage`／`ToolOutput`、`ViewController`）與三個數值常數。只有型別與常數，沒有執行期邏輯。
- Create `src/main/view-tools/controller-core.ts`：`createCore(deps)`。逾時包裝的 `call()`、進門檢查 `guard()`、`act()`（進門檢查加 `runAsAgent`）、`collect`（給 snapshot-collect 的 deps，`send` 已換成 `call`）、`nextSnapshotId()`、`resolveEntry()`、`text()`。
- Create `src/main/view-tools/controller-page.ts`：`createPageTools(core)` → `navigate`、`snapshot`、`screenshot`。
- Create `src/main/view-tools/controller-input.ts`：`createInputTools(core)` → `click`、`type`、`press`，含 `centerOfQuad()`、`dispatchKey()`、`waitQuiet()`、`pointOf()`。
- Create `src/main/view-tools/controller.ts`：轉出契約 §10.2 的公開名稱，`createViewController(deps)` 把三組方法組成一個 `ViewController`。
- Create `src/main/view-tools/controller-eval.ts`：`createEvalTools(core)` → `evaluate`、`requestHandoff`。
- Test `tests/view-tools/controller-harness.ts`：測試共用的假 webContents、`createHarness()`、`sent()`、`refTable()`、`tick()`／`delay()`。副檔名不是 `.test.ts`，`vitest.config.ts` 的 `include: ['tests/**/*.test.{ts,tsx}']` 不會把它當測試檔收走。
- Test `tests/view-tools/controller.test.ts`：`navigate`、`snapshot`、`screenshot`、`evaluate`、`requestHandoff`。
- Test `tests/view-tools/controller-input.test.ts`：`click`、`type`、`press`，以及 `call()` 的逾時與錯誤傳遞。

兩個測試檔而不是一個：合成一檔是 641 行，拆開之後各 331 與 310 行，剛好落在契約 §1 的範圍內，切線就是「輸入層級」與「其餘」。

**Interfaces:**

Consumes：

```ts
// Task 0：src/main/view-tools/errors.ts
export class ViewToolError extends Error { readonly name = 'ViewToolError' }
export const MSG: { /* 契約 §10.1 全表 */ }
// Task 0：src/main/view-tools/types.ts
export interface Point { readonly x: number; readonly y: number }
export interface RefEntry { readonly sessionId?: string; readonly backendNodeId: number; readonly role: string; readonly name: string }
// Task 0：tests/helpers/manual-clock.ts
export function manualClock(start?: number): { readonly clock: MergerClock; advance(ms: number): void; now(): number }
// Task 1：src/main/cdp.ts
export class CdpError extends Error { readonly code: string; constructor(message: string, code: string, options?: { cause?: unknown }) }
export function toCdpError(raw: unknown): CdpError
export interface CdpSession { send<T>(method: string, params?: object, sessionId?: string): Promise<T>; /* … */ }
// Task 1：tests/helpers/fake-cdp.ts
export function createFakeCdp(): FakeCdp   // onSend(method, responder, sessionId?)、emit、setAttachedTargets、setRearmErrors
// Task 2：src/main/view-tools/refs.ts
export function lookupRef(table: RefTable, ref: string): RefLookup
export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable
// Task 3：src/main/view-tools/keys.ts、urls.ts
export function lookupKey(name: string): KeyDef | null
export const KEY_NAMES: readonly string[]
export function checkNavigateUrl(raw: string, projectDir: string): UrlCheck
// Task 4：src/main/view-tools/snapshot.ts
export function buildSnapshot(input: SnapshotInput): SnapshotResult
export function formatSnapshotText(snapshot: Snapshot, intervention?: string | null): string   // 裁決 22
// Task 5：src/main/view-tools/snapshot-collect.ts
export interface CollectDeps { readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>; readonly currentUrl: () => string; readonly currentTitle: () => string; readonly now: () => number; readonly logError: (error: Error) => void }
export function collectSnapshotInput(deps: CollectDeps, id: number, scope: 'viewport' | 'full'): Promise<SnapshotInput>
/** 第三參數 cache 選填（裁決 26），controller 只傳前兩個。 */
export function resolveFrameOffset(deps: CollectDeps, sessionId: string | undefined, cache?: Map<string, Point>): Promise<Point>
// Task 6：src/main/view-tools/watch.ts
export interface Watcher { refs(): RefTable; setRefs(table: RefTable): void; intervention(): InterventionLog; takeIntervention(): InterventionLog; runAsAgent<T>(fn: () => Promise<T>): Promise<T>; dispose(): void }
export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null
// Task 7：src/main/view-tools/handoff.ts
export interface Handoff { pending(): HandoffPending | null; begin(toolUseId: string, reason: string, signal?: AbortSignal): Promise<HandoffWaitResult>; done(toolUseId: string): void; abortAll(): void }
export const HANDOFF_TIMEOUT_MS: number
// Task 8：src/main/view-tools/settle.ts
export const SETTLE_QUIET_MS: number; export const SETTLE_TIMEOUT_MS: number; export const NAVIGATE_TIMEOUT_MS: number
export interface SettleTracker { inflight(): number; waitForQuiet(opts: SettleWaitOptions): Promise<SettleOutcome>; waitForLoad(opts: SettleWaitOptions): Promise<SettleOutcome>; dispose(): void }
```

Produces（Task 10 的 server.ts 會用，全部從 `src/main/view-tools/controller.ts` 匯出）：

```ts
export const CDP_CALL_TIMEOUT_MS = 10_000
export const EVAL_MAX_CHARS = 8_192
export const SCREENSHOT_MAX_WIDTH = 1_280
export interface ControllerDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly webContents: { isDestroyed(): boolean; getURL(): string; getTitle(): string }
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
}
export interface ToolText { readonly kind: 'text'; readonly text: string }
export interface ToolImage { readonly kind: 'image'; readonly text: string; readonly dataBase64: string; readonly mimeType: 'image/png' }
export type ToolOutput = ToolText | ToolImage
export interface ViewController {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, text: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
}
export function createViewController(deps: ControllerDeps): ViewController
```

- [ ] **Step 1a: 寫測試共用的 harness（`tests/view-tools/controller-harness.ts` 完整內容）**

`watcher`／`settle`／`handoff` 全部用上游真實作，不 mock：controller 對它們的用法（`runAsAgent` 的巢狀、`waitForQuiet` 的 500ms 靜默視窗、`begin` 的單一 pending）如果換成假物件，測到的就只是「有沒有呼叫」，不是「行為對不對」。假的只有兩個：`CdpSession` 用 Task 1 的 `createFakeCdp()`，`webContents` 用最小假物件。時間全部走 `manualClock`，所以逾時測試不必真的等 10 秒。

```ts
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { createFakeCdp, type FakeCdp } from '../helpers/fake-cdp.js'
import { manualClock } from '../helpers/manual-clock.js'
import { createViewController } from '../../src/main/view-tools/controller.js'
import type { ViewController } from '../../src/main/view-tools/controller.js'
import { createHandoff, type Handoff } from '../../src/main/view-tools/handoff.js'
import { createSettleTracker, type SettleTracker } from '../../src/main/view-tools/settle.js'
import { createWatcher, type Watcher } from '../../src/main/view-tools/watch.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

/** 真計時器：把 microtask 與一輪 macrotask 都排空，讓 await 鏈走到下一個等待點。 */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type InputListener = (event: unknown, input: { readonly type: string }) => void

export interface FakeWebContents {
  on(event: 'input-event', listener: InputListener): unknown
  off(event: 'input-event', listener: InputListener): unknown
  isDestroyed(): boolean
  getURL(): string
  getTitle(): string
  setUrl(url: string): void
  setTitle(title: string): void
  destroy(): void
  /** 模擬使用者實際操作右窗格（Electron 的 input-event）。 */
  userInput(type: string): void
}

export function createFakeWebContents(url = 'https://example.test/'): FakeWebContents {
  let currentUrl = url
  let title = '起始頁'
  let destroyed = false
  const listeners = new Set<InputListener>()
  return {
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    isDestroyed: () => destroyed,
    getURL: () => currentUrl,
    getTitle: () => title,
    setUrl: (next) => {
      currentUrl = next
    },
    setTitle: (next) => {
      title = next
    },
    destroy: () => {
      destroyed = true
    },
    userInput: (type) => {
      for (const listener of [...listeners]) listener({}, { type })
    },
  }
}

export interface Harness {
  readonly cdp: FakeCdp
  readonly wc: FakeWebContents
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly controller: ViewController
  readonly logError: Mock
  readonly signal: AbortSignal
  readonly aborter: AbortController
  advance(ms: number): void
  now(): number
}

/** 已送出的 CDP 指令，依 method 過濾。 */
export function sent(cdp: FakeCdp, method: string): { params: unknown; sessionId: string | undefined }[] {
  return (cdp.send as unknown as Mock).mock.calls
    .filter((call) => call[0] === method)
    .map((call) => ({ params: call[1] as unknown, sessionId: call[2] as string | undefined }))
}

export function refTable(snapshotId: number, entries: readonly (readonly [string, RefEntry])[]): RefTable {
  return { snapshotId, entries: new Map(entries) }
}

/**
 * watcher／settle／handoff 一律用上游真實作，只有 CdpSession 與 webContents 是假的。
 * 時間全部走 manualClock，所以逾時測試不需要真的等。
 */
export async function createHarness(projectDir = '/tmp/yeschef-proj'): Promise<Harness> {
  const cdp = createFakeCdp()
  const clockKit = manualClock(1_000)
  const wc = createFakeWebContents()
  const logError = vi.fn()

  // createWatcher 建構時做裁決 5 的三個 enable。
  for (const method of ['DOM.enable', 'Network.enable', 'Accessibility.enable']) {
    cdp.onSend(method, () => ({}))
  }

  const watcher = await createWatcher({ cdp, webContents: wc, logError })
  const settle = createSettleTracker(cdp, clockKit.clock)
  const handoff = createHandoff(clockKit.clock, logError)
  const aborter = new AbortController()
  const controller = createViewController({
    cdp,
    webContents: wc,
    watcher,
    settle,
    handoff,
    clock: clockKit.clock,
    projectDir,
    logError,
  })

  return {
    cdp,
    wc,
    watcher,
    settle,
    handoff,
    controller,
    logError,
    aborter,
    signal: aborter.signal,
    advance: clockKit.advance,
    now: clockKit.now,
  }
}
```

- [ ] **Step 1b: 寫失敗的測試（`tests/view-tools/controller-input.test.ts`，第一段：`view_click`）**

座標的四組常數是這個檔的關鍵：`ROOT_BORDER` 的中心 `(62, 54)` 與左上角 `(12, 24)` 不同，所以「拿左上角當點擊點」的實作過不了；兩層 offset 各自非零且互不相等（`(100, 200)` 與 `(30, 40)`），所以「只算一層」與「完全不加」兩種錯誤都會被抓到。這是計畫撰寫者須知列的 B 特有盲點：offset 為 0 時加不加都對。

貼完第一段先不要跑，第二段接在同一個檔後面。

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { CdpError } from '../../src/main/cdp.js'
import { CDP_CALL_TIMEOUT_MS } from '../../src/main/view-tools/controller.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { KEY_NAMES } from '../../src/main/view-tools/keys.js'
import { invalidateRefs } from '../../src/main/view-tools/refs.js'
import { createHarness, delay, refTable, sent, tick, type Harness } from './controller-harness.js'

/** 主 target 的按鈕：border 四點的中心是 (62, 54)，跟左上角 (12, 24) 不同。 */
const ROOT_BORDER = [12, 24, 112, 24, 112, 84, 12, 84]
/** OOPIF 內的按鈕：中心 (60, 50)。 */
const INNER_BORDER = [10, 20, 110, 20, 110, 80, 10, 80]
/** 外層 iframe 在主視窗裡的位置：左上角 (100, 200)。 */
const OUTER_CONTENT = [100, 200, 300, 200, 300, 400, 100, 400]
/** 內層 iframe 在外層 iframe 座標系裡的位置：左上角 (30, 40)。 */
const INNER_CONTENT = [30, 40, 230, 40, 230, 140, 30, 140]

function quietOk(h: Harness): void {
  h.advance(500)
}

describe('controller：view_click', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, role: 'button', name: '送出' }]]))
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => ({}))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: ROOT_BORDER } }))
    h.cdp.onSend('Input.dispatchMouseEvent', () => ({}))
  })

  it('ref 格式錯回 refFormat，不送任何 CDP 指令', async () => {
    await expect(h.controller.click('t1-e0', h.signal)).rejects.toThrow(MSG.refFormat)
    expect(sent(h.cdp, 'DOM.getBoxModel')).toHaveLength(0)
  })

  it('snapshot 已失效回 refStale，原因照 RefTable 的 invalidatedBy', async () => {
    h.watcher.setRefs(invalidateRefs(h.watcher.refs(), 'userInput'))
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.refStale(1, 'userInput'))
  })

  it('ref 編號不在表裡回 refMissing', async () => {
    await expect(h.controller.click('s1-e7', h.signal)).rejects.toThrow(MSG.refMissing(1, 's1-e7'))
  })

  it('getBoxModel 失敗回 refDetached', async () => {
    h.cdp.onSend('DOM.getBoxModel', () => {
      throw new CdpError('Could not find node', 'nodeNotFound')
    })
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.refDetached('s1-e0'))
  })

  it('主 target 的節點點在 border 中心，mousePressed 與 mouseReleased 各一次', async () => {
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    const out = await promise

    const mouse = sent(h.cdp, 'Input.dispatchMouseEvent')
    expect(mouse).toHaveLength(2)
    expect(mouse[0]).toEqual({
      params: { type: 'mousePressed', x: 62, y: 54, button: 'left', clickCount: 1 },
      sessionId: undefined,
    })
    expect(mouse[1]?.params).toEqual({ type: 'mouseReleased', x: 62, y: 54, button: 'left', clickCount: 1 })
    expect(out).toEqual({ kind: 'text', text: MSG.clicked('button', '送出') })
  })

  it('scrollIntoViewIfNeeded 與 getBoxModel 送到節點所屬的 session', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 9, sessionId: 's-inner', role: 'link', name: '說明' }]]))
    h.cdp.setAttachedTargets([{ targetId: 'T-inner', type: 'iframe', url: 'https://in.test/', sessionId: 's-inner' }])
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')
    h.cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-page' }, { targetId: 'T-inner', parentId: 'T-page' }],
    }))
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 500 }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: OUTER_CONTENT } }))

    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise

    expect(sent(h.cdp, 'DOM.scrollIntoViewIfNeeded')[0]).toEqual({ params: { backendNodeId: 9 }, sessionId: 's-inner' })
    expect(sent(h.cdp, 'DOM.getBoxModel')[0]?.sessionId).toBe('s-inner')
  })

  it('兩層巢狀 OOPIF 的座標加上兩層 offset（裁決 9）', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, sessionId: 's-inner', role: 'button', name: '付款' }]]))
    h.cdp.setAttachedTargets([
      { targetId: 'T-outer', type: 'iframe', url: 'https://outer.test/', sessionId: 's-outer' },
      { targetId: 'T-inner', type: 'iframe', url: 'https://inner.test/', sessionId: 's-inner' },
    ])
    h.cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page' },
        { targetId: 'T-outer', parentId: 'T-page' },
        { targetId: 'T-inner', parentId: 'T-outer' },
      ],
    }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 501 }), 's-outer')
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: INNER_CONTENT } }), 's-outer')
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 500 }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: OUTER_CONTENT } }))

    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise

    // 中心 (60,50) + 內層 (30,40) + 外層 (100,200)
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')[0]?.params).toEqual({
      type: 'mousePressed',
      x: 190,
      y: 290,
      button: 'left',
      clickCount: 1,
    })
    expect(sent(h.cdp, 'DOM.getFrameOwner').map((c) => c.sessionId)).toEqual(['s-outer', undefined])
  })

  it('offset 算不出來時錯誤原樣傳出，不退回主視窗座標亂點（裁決 29）', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, sessionId: 's-inner', role: 'button', name: '付款' }]]))
    h.cdp.setAttachedTargets([
      { targetId: 'T-inner', type: 'iframe', url: 'https://inner.test/', sessionId: 's-inner' },
    ])
    // 這個 target 在 Target.getTargets 裡沒有 parentId：resolveFrameOffset 丟 frame-detached。
    h.cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-inner' }] }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')

    const error = await h.controller.click('s1-e0', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CdpError)
    expect((error as CdpError).code).toBe('frame-detached')
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')).toHaveLength(0)
  })

  it('點擊造成換頁時多一行 urlChanged', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.setUrl('https://example.test/next')
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    const out = await promise
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.clicked('button', '送出')}\n${MSG.urlChanged('https://example.test/next')}`,
    })
  })

  it('等不到靜默回 settleTimeout(5)', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.cdp.emit('Network.requestWillBeSent', { requestId: 'r1', type: 'XHR' })
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    h.advance(5_000)
    await expect(promise).rejects.toThrow(MSG.settleTimeout(5))
  })

  it('動作期間的 input-event 不算使用者插手（runAsAgent）', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.userInput('mouseDown')
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise
    expect(h.watcher.intervention().clicks).toBe(0)
  })

  it('右窗格已銷毀回 viewGone', async () => {
    h.wc.destroy()
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.viewGone)
  })

  it('CDP 指令逾時丟 code timeout 的 CdpError，不會永遠掛住（裁決 14）', async () => {
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => new Promise(() => {}))
    const settled = h.controller.click('s1-e0', h.signal).then(
      () => 'resolved' as const,
      (error: unknown) => error
    )
    await tick()
    h.advance(CDP_CALL_TIMEOUT_MS)
    const result = await Promise.race([settled, delay(50).then(() => 'hung' as const)])
    expect(result).toBeInstanceOf(CdpError)
    expect((result as CdpError).code).toBe('timeout')
  })

  it('CDP 指令自己失敗時原樣傳出，不當成逾時', async () => {
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => Promise.reject(new CdpError('boom', 'protocol')))
    const error = await h.controller.click('s1-e0', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CdpError)
    expect((error as CdpError).code).toBe('protocol')
  })
})
```

逾時那個測試用 `Promise.race` 加一個 50ms 的真計時器哨兵，而不是直接 `await`：實作若少了逾時包裝，`await` 會掛到 vitest 的 5 秒測試逾時才變紅，訊息也只說「測試逾時」；用哨兵則是立刻拿到 `'hung'`、斷言指著 `toBeInstanceOf(CdpError)` 失敗，訊息說得清楚。

- [ ] **Step 1c: 寫失敗的測試（`controller-input.test.ts` 第二段：`view_type` 與 `view_press`，接在第一段後面）**

```ts
describe('controller：view_type', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.watcher.setRefs(refTable(2, [['s2-e1', { backendNodeId: 7, role: 'textbox', name: '電子郵件' }]]))
    h.cdp.onSend('DOM.focus', () => ({}))
    h.cdp.onSend('Input.dispatchKeyEvent', () => ({}))
    h.cdp.onSend('Input.insertText', () => ({}))
  })

  it('focus 送到節點所屬 session，insertText 送 root', async () => {
    h.watcher.setRefs(refTable(2, [['s2-e1', { backendNodeId: 7, sessionId: 's-x', role: 'textbox', name: '帳號' }]]))
    h.cdp.onSend('DOM.focus', () => ({}), 's-x')
    await h.controller.type('s2-e1', 'abc', false, false, h.signal)
    expect(sent(h.cdp, 'DOM.focus')[0]).toEqual({ params: { backendNodeId: 7 }, sessionId: 's-x' })
    expect(sent(h.cdp, 'Input.insertText')[0]).toEqual({ params: { text: 'abc' }, sessionId: undefined })
  })

  it('clear 用 commands: [selectAll] 全選後按 Backspace（裁決 12）', async () => {
    const out = await h.controller.type('s2-e1', 'hi', true, false, h.signal)
    const keys = sent(h.cdp, 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toEqual({
      type: 'keyDown',
      modifiers: 4,
      commands: ['selectAll'],
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    })
    expect(keys[1]).toEqual({ type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    expect(keys[2]).toEqual({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    expect(keys[3]).toEqual({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    expect(out).toEqual({ kind: 'text', text: MSG.typed(2, 'textbox', '電子郵件') })
  })

  it('clear 為 false 時完全不送按鍵，只有 insertText', async () => {
    await h.controller.type('s2-e1', 'hi', false, false, h.signal)
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')).toHaveLength(0)
    expect(sent(h.cdp, 'Input.insertText')).toHaveLength(1)
  })

  it('submit 送 Enter 並等靜默，換頁時加 urlChanged', async () => {
    h.cdp.onSend('Input.dispatchKeyEvent', () => {
      h.wc.setUrl('https://example.test/search?q=hi')
      return {}
    })
    const promise = h.controller.type('s2-e1', 'hi', false, true, h.signal)
    await tick()
    h.advance(500)
    const out = await promise
    const keys = sent(h.cdp, 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toEqual({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(keys[1]).toEqual({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.typed(2, 'textbox', '電子郵件')}\n${MSG.urlChanged('https://example.test/search?q=hi')}`,
    })
  })

  it('submit 為 false 時不等靜默也不比對網址', async () => {
    h.cdp.onSend('Input.insertText', () => {
      h.wc.setUrl('https://example.test/other')
      return {}
    })
    const out = await h.controller.type('s2-e1', 'hi', false, false, h.signal)
    expect(out).toEqual({ kind: 'text', text: MSG.typed(2, 'textbox', '電子郵件') })
  })

  it('ref 過期時不 focus 也不輸入', async () => {
    await expect(h.controller.type('s9-e1', 'hi', false, false, h.signal)).rejects.toBeInstanceOf(ViewToolError)
    expect(sent(h.cdp, 'DOM.focus')).toHaveLength(0)
  })
})

describe('controller：view_press', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.cdp.onSend('Input.dispatchKeyEvent', () => ({}))
  })

  it('不支援的按鍵回 badKey 並列出全部鍵名', async () => {
    await expect(h.controller.press('F13', h.signal)).rejects.toThrow(MSG.badKey('F13', KEY_NAMES))
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')).toHaveLength(0)
  })

  it('大小寫敏感：enter 不是 Enter', async () => {
    await expect(h.controller.press('enter', h.signal)).rejects.toThrow(MSG.badKey('enter', KEY_NAMES))
  })

  it('有 text 的鍵用 keyDown 並帶 text', async () => {
    const promise = h.controller.press('Space', h.signal)
    await tick()
    h.advance(500)
    const out = await promise
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')[0]?.params).toEqual({
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
      text: ' ',
    })
    expect(out).toEqual({ kind: 'text', text: MSG.pressed('Space') })
  })

  it('沒有 text 的鍵用 rawKeyDown 且不帶 text', async () => {
    const promise = h.controller.press('Tab', h.signal)
    await tick()
    h.advance(500)
    await promise
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')[0]?.params).toEqual({
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    })
  })

  it('等待靜默期間 signal 中止回 sessionEnded', async () => {
    const promise = h.controller.press('Tab', h.signal)
    await tick()
    h.aborter.abort()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })
})
```

`clear` 那個測試把四則按鍵事件逐一比對完整參數而不是只看有沒有 `selectAll`：`commands` 少了、`modifiers` 錯了、`keyUp` 忘了送、Backspace 用了 `keyDown` 而不是 `rawKeyDown`，四種錯法都各自有一行斷言擋著。

- [ ] **Step 1d: 寫失敗的測試（`tests/view-tools/controller.test.ts` 完整內容）**

只有 `collectSnapshotInput` 用 `vi.mock` 換掉，同一個模組的 `resolveFrameOffset` 保留真實作（`importOriginal()` 展開後只覆蓋一個名字）。理由：蒐集 AX 樹是 Task 5 的職責、有自己的測試，controller 的 `snapshot` 只負責流水號、`setRefs`、插手摘要與文字組裝；把整個蒐集流程真的跑一遍，這個檔會變成 Task 5 的第二份測試，而且 Task 5 一改 CDP 呼叫順序這裡就跟著紅。`resolveFrameOffset` 不能一起換掉：裁決 9 的座標重算是 controller 的行為，Step 1b 的兩層 offset 測試靠它。

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EVAL_MAX_CHARS, SCREENSHOT_MAX_WIDTH } from '../../src/main/view-tools/controller.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { HANDOFF_TIMEOUT_MS } from '../../src/main/view-tools/handoff.js'
import { collectSnapshotInput } from '../../src/main/view-tools/snapshot-collect.js'
import type { SnapshotInput } from '../../src/main/view-tools/snapshot.js'
import { createHarness, sent, tick, type Harness } from './controller-harness.js'

// Task 5 的蒐集流程有自己的 task 與測試；這裡只驗 controller 的職責：流水號、
// setRefs、插手摘要與文字組裝。同一個模組的 resolveFrameOffset（裁決 9）保留真實作。
vi.mock('../../src/main/view-tools/snapshot-collect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/view-tools/snapshot-collect.js')>()
  return { ...actual, collectSnapshotInput: vi.fn() }
})

const collectMock = collectSnapshotInput as unknown as Mock

function inputFor(id: number, scope: 'viewport' | 'full' = 'viewport'): SnapshotInput {
  return {
    id,
    takenAt: 1_000,
    url: 'https://example.test/',
    title: '起始頁',
    scope,
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    frames: [
      {
        frameId: 'F1',
        url: 'https://example.test/',
        offset: { x: 0, y: 0 },
        nodes: [
          {
            nodeId: '1',
            ignored: false,
            role: { value: 'button' },
            name: { value: '送出' },
            backendDOMNodeId: 42,
            childIds: [],
          },
        ],
        boxes: new Map([[42, { x: 1, y: 2, width: 30, height: 10 }]]),
      },
    ],
    unattachedFrames: 0,
  }
}

describe('controller：view_navigate', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness('/tmp/yeschef-proj')
    h.cdp.onSend('Page.navigate', () => ({ frameId: 'F1' }))
  })

  const loadThenQuiet = (): void => {
    h.cdp.emit('Page.loadEventFired', { timestamp: 1 })
  }

  it('協定不在白名單回 badScheme，不送 Page.navigate', async () => {
    await expect(h.controller.navigate('ftp://example.test/x', h.signal)).rejects.toThrow(MSG.badScheme)
    expect(sent(h.cdp, 'Page.navigate')).toHaveLength(0)
  })

  it('無法解析的網址回 invalidUrl，訊息帶原字串', async () => {
    await expect(h.controller.navigate('example.test', h.signal)).rejects.toThrow(MSG.invalidUrl('example.test'))
  })

  it('專案目錄外的 file:// 回 outsideProject', async () => {
    await expect(h.controller.navigate('file:///etc/hosts', h.signal)).rejects.toThrow(
      MSG.outsideProject('/tmp/yeschef-proj')
    )
  })

  it('成功時送出正規化後的網址並回報網址與標題', async () => {
    h.wc.setUrl('https://example.test/a/b')
    h.wc.setTitle('目的地')
    const promise = h.controller.navigate('https://example.test/a/../a/b', h.signal)
    await tick()
    loadThenQuiet()
    await tick()
    h.advance(500)
    const out = await promise
    expect(sent(h.cdp, 'Page.navigate')[0]).toEqual({
      params: { url: 'https://example.test/a/b' },
      sessionId: undefined,
    })
    expect(out).toEqual({ kind: 'text', text: MSG.navigated('https://example.test/a/b', '目的地') })
  })

  it('Page.navigate 回 errorText 時丟 navigateFailed', async () => {
    h.cdp.onSend('Page.navigate', () => ({ frameId: 'F1', errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
    await expect(h.controller.navigate('https://nope.test/', h.signal)).rejects.toThrow(
      MSG.navigateFailed('https://nope.test/', 'net::ERR_NAME_NOT_RESOLVED')
    )
  })

  it('8 秒內沒 load 完丟 navigateTimeout，帶當下網址', async () => {
    h.wc.setUrl('https://example.test/stuck')
    const promise = h.controller.navigate('https://example.test/stuck', h.signal)
    await tick()
    h.advance(8_000)
    await expect(promise).rejects.toThrow(MSG.navigateTimeout('https://example.test/stuck'))
  })

  it('等待中被中止丟 sessionEnded', async () => {
    const promise = h.controller.navigate('https://example.test/x', h.signal)
    await tick()
    h.aborter.abort()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })

  it('右窗格已銷毀時連網址檢查都不做', async () => {
    h.wc.destroy()
    await expect(h.controller.navigate('https://example.test/', h.signal)).rejects.toThrow(MSG.viewGone)
    expect(sent(h.cdp, 'Page.navigate')).toHaveLength(0)
  })
})

describe('controller：view_snapshot', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    collectMock.mockReset()
    collectMock.mockImplementation((_deps: unknown, id: number, scope: 'viewport' | 'full') =>
      Promise.resolve(inputFor(id, scope))
    )
  })

  it('流水號從 1 起遞增，scope 原樣傳給蒐集函式', async () => {
    await h.controller.snapshot('viewport', h.signal)
    await h.controller.snapshot('full', h.signal)
    expect(collectMock.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, 'viewport'],
      [2, 'full'],
    ])
  })

  it('把新的 RefTable 交給 watcher，ref 編號帶這次的流水號', async () => {
    await h.controller.snapshot('viewport', h.signal)
    const table = h.watcher.refs()
    expect(table.snapshotId).toBe(1)
    expect(table.entries.get('s1-e0')).toEqual({ backendNodeId: 42, role: 'button', name: '送出' })
  })

  it('沒有插手時文字不含摘要行', async () => {
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out).toEqual({
      kind: 'text',
      text: '[page] 起始頁 https://example.test/\ns1-e0 button "送出"',
    })
  })

  it('有插手時第一行是摘要，且摘要取完就歸零', async () => {
    h.wc.userInput('mouseDown')
    h.wc.userInput('keyDown')
    h.wc.setUrl('https://example.test/moved')
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out.text.split('\n')[0]).toBe(
      '使用者在你上次操作後點了 1 次、按了 1 個鍵，網址從 https://example.test/ 變成 https://example.test/moved'
    )
    expect(h.watcher.intervention()).toEqual({
      clicks: 0,
      keys: 0,
      navigations: 0,
      fromUrl: 'https://example.test/moved',
    })
  })

  it('蒐集期間的 input-event 不算插手（runAsAgent）', async () => {
    collectMock.mockImplementation((_deps: unknown, id: number) => {
      h.wc.userInput('mouseDown')
      return Promise.resolve(inputFor(id))
    })
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out.text.startsWith('[page]')).toBe(true)
    expect(h.watcher.intervention().clicks).toBe(0)
  })
})
```

- [ ] **Step 1e: 寫失敗的測試（`controller.test.ts` 第二段：`view_screenshot`、`view_eval`、`request_handoff`，接在第一段後面）**

```ts
describe('controller：view_screenshot', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.cdp.onSend('Page.captureScreenshot', () => ({ data: 'UE5H' }))
  })

  const metrics = (clientWidth: number, clientHeight: number): void => {
    h.cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth, clientHeight } }))
  }

  it('寬度超過上限時等比縮小，clip 與文字用同一個 scale', async () => {
    metrics(1_600, 900)
    const out = await h.controller.screenshot(h.signal)
    expect(sent(h.cdp, 'Page.captureScreenshot')[0]?.params).toEqual({
      format: 'png',
      clip: { x: 0, y: 0, width: 1_600, height: 900, scale: 0.8 },
    })
    expect(out).toEqual({
      kind: 'image',
      text: MSG.screenshot(SCREENSHOT_MAX_WIDTH, 720, 'https://example.test/'),
      dataBase64: 'UE5H',
      mimeType: 'image/png',
    })
  })

  it('寬度小於上限時不放大', async () => {
    metrics(800, 601)
    const out = await h.controller.screenshot(h.signal)
    expect(sent(h.cdp, 'Page.captureScreenshot')[0]?.params).toMatchObject({
      clip: { width: 800, height: 601, scale: 1 },
    })
    expect(out.text).toBe(MSG.screenshot(800, 601, 'https://example.test/'))
  })
})

describe('controller：view_eval', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
  })

  const evaluates = (result: unknown): void => {
    h.cdp.onSend('Runtime.evaluate', () => result)
  }

  it('回傳值以 JSON 呈現，參數含 returnByValue 與 awaitPromise', async () => {
    evaluates({ result: { value: { a: 1 } } })
    const out = await h.controller.evaluate('({a:1})', h.signal)
    expect(sent(h.cdp, 'Runtime.evaluate')[0]).toEqual({
      params: { expression: '({a:1})', returnByValue: true, awaitPromise: true },
      sessionId: undefined,
    })
    expect(out).toEqual({ kind: 'text', text: '{"a":1}' })
  })

  it('值是 undefined 時回字串 undefined', async () => {
    evaluates({ result: {} })
    expect(await h.controller.evaluate('void 0', h.signal)).toEqual({ kind: 'text', text: 'undefined' })
  })

  it('NaN 這類值只有 unserializableValue 時用它（裁決 28）', async () => {
    evaluates({ result: { type: 'number', unserializableValue: 'NaN' } })
    expect(await h.controller.evaluate('0/0', h.signal)).toEqual({ kind: 'text', text: 'NaN' })
  })

  it('BigInt 的 unserializableValue 優先於 JSON.stringify', async () => {
    evaluates({ result: { type: 'bigint', unserializableValue: '1n' } })
    expect(await h.controller.evaluate('1n', h.signal)).toEqual({ kind: 'text', text: '1n' })
  })

  it('exceptionDetails 存在時丟出 description', async () => {
    evaluates({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } })
    await expect(h.controller.evaluate('x()', h.signal)).rejects.toThrow('TypeError: x is not a function')
  })

  it('沒有 description 時退回 exceptionDetails.text', async () => {
    evaluates({ exceptionDetails: { text: 'Uncaught SyntaxError' } })
    const error = await h.controller.evaluate('=', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ViewToolError)
    expect((error as Error).message).toBe('Uncaught SyntaxError')
  })

  it('超長結果截到 8192 字元並附原長', async () => {
    const value = 'x'.repeat(9_000)
    evaluates({ result: { value } })
    const json = JSON.stringify(value)
    const out = await h.controller.evaluate('long', h.signal)
    expect(out.text).toBe(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(json.length))
    expect(out.text.startsWith(`"${'x'.repeat(EVAL_MAX_CHARS - 1)}`)).toBe(true)
  })

  it('剛好 8192 字元不截斷', async () => {
    const value = 'y'.repeat(EVAL_MAX_CHARS - 2)
    evaluates({ result: { value } })
    const out = await h.controller.evaluate('exact', h.signal)
    expect(out.text).toHaveLength(EVAL_MAX_CHARS)
    expect(out.text.includes('已截斷')).toBe(false)
  })
})

describe('controller：request_handoff', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
  })

  it('使用者按下後回 handoffDone，帶當下網址', async () => {
    const promise = h.controller.requestHandoff('tu-1', '請完成登入', h.signal)
    await tick()
    h.wc.setUrl('https://example.test/logged-in')
    h.handoff.done('tu-1')
    expect(await promise).toEqual({ kind: 'text', text: MSG.handoffDone('https://example.test/logged-in') })
  })

  it('逾時是狀態不是錯誤，回 handoffTimeout', async () => {
    const promise = h.controller.requestHandoff('tu-2', '請完成登入', h.signal)
    await tick()
    h.advance(HANDOFF_TIMEOUT_MS)
    expect(await promise).toEqual({ kind: 'text', text: MSG.handoffTimeout('https://example.test/') })
  })

  it('對話結束時丟 sessionEnded', async () => {
    const promise = h.controller.requestHandoff('tu-3', '請完成登入', h.signal)
    await tick()
    h.handoff.abortAll()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })

  it('已有一筆等待中時第二筆丟 handoffBusy', async () => {
    const first = h.controller.requestHandoff('tu-4', '請完成登入', h.signal)
    await tick()
    await expect(h.controller.requestHandoff('tu-5', '再一次', h.signal)).rejects.toThrow(
      MSG.handoffBusy('請完成登入')
    )
    h.handoff.done('tu-4')
    await first
  })

  it('等待期間的 input-event 要算使用者插手（不包在 runAsAgent 內）', async () => {
    const promise = h.controller.requestHandoff('tu-6', '請完成登入', h.signal)
    await tick()
    h.wc.userInput('mouseDown')
    h.wc.userInput('keyDown')
    h.wc.userInput('keyDown')
    h.handoff.done('tu-6')
    await promise
    expect(h.watcher.intervention()).toMatchObject({ clicks: 1, keys: 2 })
  })

  it('右窗格已銷毀時不建立 pending', async () => {
    h.wc.destroy()
    await expect(h.controller.requestHandoff('tu-7', '請完成登入', h.signal)).rejects.toThrow(MSG.viewGone)
    expect(h.handoff.pending()).toBeNull()
  })
})
```

`剛好 8192 字元不截斷` 這個上限測試存在的理由：截斷條件寫成 `>=` 而不是 `>` 時，長度恰好等於上限的結果會被多加一句「已截斷，原長 8192 字元」，是模型讀得到的假訊息。`'y'.repeat(EVAL_MAX_CHARS - 2)` 加上 `JSON.stringify` 的兩個雙引號剛好是 8192。

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/controller.test.ts tests/view-tools/controller-input.test.ts
```

六個實作檔都還不存在，兩個檔在載入階段就失敗。實跑輸出（已在 worktree 實跑）：

```
Error: Cannot find module '../../src/main/view-tools/controller.js' imported from …/tests/view-tools/controller-input.test.ts
Error: Cannot find module '/src/main/view-tools/controller.js' imported from …/tests/view-tools/controller.test.ts
 Test Files  2 failed (2)
      Tests  no tests
```

- [ ] **Step 3a: 最小實作（`src/main/view-tools/controller-types.ts` 完整內容）**

```ts
/**
 * controller 的公開型別與數值常數（契約 §10.2）。獨立成檔的理由：
 * controller.ts 與 controller-page／input／eval 都要用這些型別，型別放在
 * 最上游的葉節點才不會出現「controller.ts 匯入子模組、子模組又回頭匯入
 * controller.ts 的型別」這種循環。對外仍只從 controller.ts 匯出。
 */
import type { MergerClock } from '../agent-host.js'
import type { CdpSession } from '../cdp.js'
import type { Handoff } from './handoff.js'
import type { SettleTracker } from './settle.js'
import type { Watcher } from './watch.js'

export interface ControllerDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly webContents: { isDestroyed(): boolean; getURL(): string; getTitle(): string }
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
}

/** 單一 CDP 指令的逾時（裁決 14：在 controller 的 call() 做，不改 cdp.ts）。 */
export const CDP_CALL_TIMEOUT_MS = 10_000
/** view_eval 回傳文字的上限，超過截斷並附原長。 */
export const EVAL_MAX_CHARS = 8_192
/** 截圖縮放的目標寬度上限。 */
export const SCREENSHOT_MAX_WIDTH = 1_280

export interface ToolText {
  readonly kind: 'text'
  readonly text: string
}

export interface ToolImage {
  readonly kind: 'image'
  readonly text: string
  readonly dataBase64: string
  readonly mimeType: 'image/png'
}

export type ToolOutput = ToolText | ToolImage

export interface ViewController {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, text: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
}
```

- [ ] **Step 3b: 最小實作（`src/main/view-tools/controller-core.ts` 完整內容）**

```ts
/**
 * 八個方法共用的零件：逾時包裝的 call()、進門檢查、runAsAgent 包裝、
 * snapshot 編號、ref 查表與 ToolText 組裝。
 */
import { CdpError, toCdpError } from '../cdp.js'
import { MSG, ViewToolError } from './errors.js'
import { lookupRef } from './refs.js'
import type { CollectDeps } from './snapshot-collect.js'
import type { RefEntry } from './types.js'
import { CDP_CALL_TIMEOUT_MS, type ControllerDeps, type ToolText } from './controller-types.js'

/** 與 CdpSession.send 同簽章，多了 CDP_CALL_TIMEOUT_MS 的逾時。 */
export type CdpCall = <T>(method: string, params?: object, sessionId?: string) => Promise<T>

export interface ControllerCore {
  readonly deps: ControllerDeps
  readonly call: CdpCall
  /** 給 snapshot-collect 的 deps：send 走 call()，所以蒐集階段的指令也有逾時。 */
  readonly collect: CollectDeps
  /** 進門檢查（isDestroyed／已中止）後把整個動作包進 watcher.runAsAgent()。 */
  act<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>
  /** 只做進門檢查，不包 runAsAgent：request_handoff 的等待期間使用者操作是預期的。 */
  guard(signal: AbortSignal): void
  /** view_snapshot 的流水號，從 1 起。 */
  nextSnapshotId(): number
  /** ref 查表；bad-format／stale／missing 直接翻成 MSG 丟出。 */
  resolveEntry(ref: string): RefEntry
}

export function text(value: string): ToolText {
  return { kind: 'text', text: value }
}

/**
 * 裁決 14：逾時計時器走注入的 clock，逾時丟 code 為 'timeout' 的 CdpError。
 * `settled` 旗標讓先到的一方定案：CDP 慢一步回來時不會覆寫已經丟出的逾時，
 * 逾時計時器也不會在指令成功後再開一槍。
 */
function createCall(deps: ControllerDeps): CdpCall {
  return <T,>(method: string, params?: object, sessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false
      const handle = deps.clock.setTimer(() => {
        if (settled) return
        settled = true
        reject(new CdpError(`CDP 指令 ${method} 逾時（${CDP_CALL_TIMEOUT_MS} 毫秒）`, 'timeout'))
      }, CDP_CALL_TIMEOUT_MS)
      deps.cdp.send<T>(method, params, sessionId).then(
        (value) => {
          if (settled) return
          settled = true
          deps.clock.clearTimer(handle)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          deps.clock.clearTimer(handle)
          reject(error instanceof Error ? error : toCdpError(error))
        }
      )
    })
}

export function createCore(deps: ControllerDeps): ControllerCore {
  const call = createCall(deps)
  let lastSnapshotId = 0

  const guard = (signal: AbortSignal): void => {
    if (deps.webContents.isDestroyed()) throw new ViewToolError(MSG.viewGone)
    if (signal.aborted) throw new ViewToolError(MSG.sessionEnded)
  }

  return {
    deps,
    call,
    collect: {
      cdp: {
        send: call,
        getAttachedTargets: () => deps.cdp.getAttachedTargets(),
        getRearmErrors: () => deps.cdp.getRearmErrors(),
      },
      currentUrl: () => deps.webContents.getURL(),
      currentTitle: () => deps.webContents.getTitle(),
      now: () => deps.clock.now(),
      logError: deps.logError,
    },
    guard,
    act: async (signal, fn) => {
      guard(signal)
      return deps.watcher.runAsAgent(fn)
    },
    nextSnapshotId: () => {
      lastSnapshotId += 1
      return lastSnapshotId
    },
    resolveEntry: (ref) => {
      const lookup = lookupRef(deps.watcher.refs(), ref)
      switch (lookup.kind) {
        case 'ok':
          return lookup.entry
        case 'bad-format':
          throw new ViewToolError(MSG.refFormat)
        case 'stale':
          throw new ViewToolError(MSG.refStale(lookup.snapshotId, lookup.reason))
        default:
          throw new ViewToolError(MSG.refMissing(lookup.snapshotId, lookup.ref))
      }
    },
  }
}
```

`guard()` 除了 `isDestroyed()` 之外還檢查 `signal.aborted`，兩者都丟對應的 `MSG`（裁決 28）：`abortPending()` 之後才被模型叫到的工具，與其送出註定失敗的 CDP 指令，不如立刻回「對話已結束」。八個方法一致，`snapshot` 與 `screenshot` 的 `signal` 參數也因此有了實際用途。

- [ ] **Step 3c: 最小實作（`src/main/view-tools/controller-input.ts` 完整內容）**

```ts
/**
 * 輸入層級的三個工具：view_click、view_type、view_press。
 *
 * 三個共同點：Input.* 一律送 root session（CDP 的輸入是頁面層級的，送到
 * OOPIF 的 session 反而打不到主視窗座標系），而 DOM.* 送節點所屬的 session。
 */
import { KEY_NAMES, lookupKey, type KeyDef } from './keys.js'
import { MSG, ViewToolError } from './errors.js'
import { SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS } from './settle.js'
import { resolveFrameOffset } from './snapshot-collect.js'
import type { Point, RefEntry } from './types.js'
import { text, type ControllerCore } from './controller-core.js'
import type { ToolOutput } from './controller-types.js'

interface BoxModel {
  readonly model: { readonly border: readonly number[] }
}

/** border 四點（x1,y1,…,x4,y4）的最小外接矩形中心。 */
function centerOfQuad(quad: readonly number[]): Point {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < quad.length; i += 2) {
    xs.push(quad[i] as number)
    ys.push(quad[i + 1] as number)
  }
  if (xs.length === 0) return { x: 0, y: 0 }
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

export function createInputTools(core: ControllerCore): {
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, value: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  /** 契約 §8：有 text 的鍵用 keyDown，沒有的用 rawKeyDown。 */
  const dispatchKey = async (def: KeyDef, extra?: object): Promise<void> => {
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    await call('Input.dispatchKeyEvent', {
      ...base,
      type: def.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...(def.text === undefined ? {} : { text: def.text }),
      ...extra,
    })
    await call('Input.dispatchKeyEvent', { ...base, type: 'keyUp', ...extra })
  }

  const waitQuiet = async (signal: AbortSignal): Promise<void> => {
    const outcome = await deps.settle.waitForQuiet({
      quietMs: SETTLE_QUIET_MS,
      timeoutMs: SETTLE_TIMEOUT_MS,
      signal,
    })
    if (outcome === 'timeout') throw new ViewToolError(MSG.settleTimeout(SETTLE_TIMEOUT_MS / 1000))
    if (outcome === 'aborted') throw new ViewToolError(MSG.sessionEnded)
  }

  /** 裁決 9：OOPIF 的 offset 每次點擊重算，不存進 RefEntry（iframe 位置會隨捲動改變）。 */
  const pointOf = async (entry: RefEntry, ref: string): Promise<Point> => {
    let box: BoxModel
    try {
      box = await call<BoxModel>('DOM.getBoxModel', { backendNodeId: entry.backendNodeId }, entry.sessionId)
    } catch {
      throw new ViewToolError(MSG.refDetached(ref))
    }
    const center = centerOfQuad(box.model.border)
    const offset = await resolveFrameOffset(core.collect, entry.sessionId)
    return { x: center.x + offset.x, y: center.y + offset.y }
  }

  return {
    click: (ref, signal) =>
      core.act(signal, async () => {
        const entry = core.resolveEntry(ref)
        await call('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, entry.sessionId)
        const point = await pointOf(entry, ref)
        const before = deps.webContents.getURL()
        const mouse = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
        await call('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed' })
        await call('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' })
        await waitQuiet(signal)
        const after = deps.webContents.getURL()
        const lines = [MSG.clicked(entry.role, entry.name)]
        if (after !== before) lines.push(MSG.urlChanged(after))
        return text(lines.join('\n'))
      }),

    type: (ref, value, clear, submit, signal) =>
      core.act(signal, async () => {
        const entry = core.resolveEntry(ref)
        await call('DOM.focus', { backendNodeId: entry.backendNodeId }, entry.sessionId)
        const before = deps.webContents.getURL()
        if (clear) {
          // 裁決 12（docs/superpowers/plan-b/CONTRACT.md）：macOS 的 Meta+A 不會進
          // renderer 的編輯指令，全選要靠 commands: ['selectAll'] 這個欄位。
          await call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: 4,
            commands: ['selectAll'],
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
          await call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: 4,
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
          const backspace = lookupKey('Backspace')
          if (backspace !== null) await dispatchKey(backspace)
        }
        await call('Input.insertText', { text: value })
        const lines = [MSG.typed(value.length, entry.role, entry.name)]
        if (submit) {
          const enter = lookupKey('Enter')
          if (enter !== null) await dispatchKey(enter)
          await waitQuiet(signal)
          const after = deps.webContents.getURL()
          if (after !== before) lines.push(MSG.urlChanged(after))
        }
        return text(lines.join('\n'))
      }),

    press: (key, signal) =>
      core.act(signal, async () => {
        const def = lookupKey(key)
        if (def === null) throw new ViewToolError(MSG.badKey(key, KEY_NAMES))
        await dispatchKey(def)
        await waitQuiet(signal)
        return text(MSG.pressed(key))
      }),
  }
}
```

四處值得說明。`centerOfQuad` 取最小外接矩形的中心而不是直接用 `border[0]`／`border[1]`：CDP 的四點在元素有 transform 時不一定是軸對齊的左上起點，取中心是唯一在旋轉後仍落在元素上的取法。`clear` 的 Backspace 走 `dispatchKey`（`KEY_TABLE` 沒有 `text` 所以是 `rawKeyDown`）而不是硬寫 `keyDown`，跟 `view_press` 送出同一個鍵時的形狀一致，這是裁決 28 定案的。`type` 的 `before` 在 `focus` 之後就取，但只在 `submit` 為真時比較：契約 §10.2 只在 submit 那一格提 `urlChanged`，純輸入不該報網址。`pointOf` 只對 `DOM.getBoxModel` 包 try／catch（那一個要翻成 `refDetached`），`resolveFrameOffset` 的錯誤原樣往外丟：裁決 29 的 fail closed，算不出 iframe 位置時寧可回報 `cdpFailed`，也不能拿 iframe 內的座標去點主頁上的別的東西。

- [ ] **Step 3d: 最小實作（`src/main/view-tools/controller-page.ts` 完整內容）**

```ts
/**
 * 頁面層級的三個工具：view_navigate、view_snapshot、view_screenshot。
 */
import { MSG, ViewToolError } from './errors.js'
import { NAVIGATE_TIMEOUT_MS, SETTLE_QUIET_MS } from './settle.js'
import { buildSnapshot, formatSnapshotText } from './snapshot.js'
import { collectSnapshotInput } from './snapshot-collect.js'
import { checkNavigateUrl } from './urls.js'
import { summarizeIntervention } from './watch.js'
import { text, type ControllerCore } from './controller-core.js'
import { SCREENSHOT_MAX_WIDTH, type ToolOutput } from './controller-types.js'

interface LayoutMetrics {
  readonly cssVisualViewport: { readonly clientWidth: number; readonly clientHeight: number }
}

export function createPageTools(core: ControllerCore): {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  return {
    navigate: (url, signal) =>
      core.act(signal, async () => {
        // 檢查順序：協定與專案範圍先擋掉，不合格的網址不該送進 CDP。
        const check = checkNavigateUrl(url, deps.projectDir)
        if (check.kind === 'invalid') throw new ViewToolError(MSG.invalidUrl(url))
        if (check.kind === 'bad-scheme') throw new ViewToolError(MSG.badScheme)
        if (check.kind === 'outside-project') throw new ViewToolError(MSG.outsideProject(check.projectDir))

        // 裁決 13：走 Page.navigate 而不是 wc.loadURL，才拿得到 errorText。
        const result = await call<{ readonly errorText?: string }>('Page.navigate', { url: check.url })
        const errorText = result.errorText
        if (typeof errorText === 'string' && errorText !== '') {
          throw new ViewToolError(MSG.navigateFailed(check.url, errorText))
        }

        const outcome = await deps.settle.waitForLoad({
          quietMs: SETTLE_QUIET_MS,
          timeoutMs: NAVIGATE_TIMEOUT_MS,
          signal,
        })
        if (outcome === 'timeout') throw new ViewToolError(MSG.navigateTimeout(deps.webContents.getURL()))
        if (outcome === 'aborted') throw new ViewToolError(MSG.sessionEnded)

        return text(MSG.navigated(deps.webContents.getURL(), deps.webContents.getTitle()))
      }),

    snapshot: (scope, signal) =>
      core.act(signal, async () => {
        const id = core.nextSnapshotId()
        const input = await collectSnapshotInput(core.collect, id, scope)
        const built = buildSnapshot(input)
        deps.watcher.setRefs(built.refs)
        // takeIntervention 要在 setRefs 之後、回傳之前呼叫：這一次 snapshot 就是
        // 「上次操作」的新起點，摘要交給模型看過就歸零。
        const summary = summarizeIntervention(deps.watcher.takeIntervention(), deps.webContents.getURL())
        return text(formatSnapshotText(built.snapshot, summary))
      }),

    screenshot: (signal) =>
      core.act(signal, async () => {
        const metrics = await call<LayoutMetrics>('Page.getLayoutMetrics')
        const width = metrics.cssVisualViewport.clientWidth
        const height = metrics.cssVisualViewport.clientHeight
        // 寬度為 0（頁面還沒排版完）時不縮放，避免 1280 / 0 得到 Infinity。
        const scale = width > 0 ? Math.min(1, SCREENSHOT_MAX_WIDTH / width) : 1
        const shot = await call<{ readonly data: string }>('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width, height, scale },
        })
        return {
          kind: 'image',
          text: MSG.screenshot(Math.round(width * scale), Math.round(height * scale), deps.webContents.getURL()),
          dataBase64: shot.data,
          mimeType: 'image/png',
        }
      }),
  }
}
```

`summary` 直接傳、不加 `?? undefined`：裁決 22 定案 `formatSnapshotText` 第二參數收 `string | null | undefined`，Task 4 的簽章已改成 `intervention?: string | null`，controller 不必自己轉換。

- [ ] **Step 3e: 最小實作（`src/main/view-tools/controller-eval.ts` 完整內容）**

```ts
/**
 * view_eval 與 request_handoff。兩個放一起的理由是它們都不碰 DOM 座標、
 * 也不等網路靜默，跟 page／input 兩組的流程沒有共用部分。
 */
import { MSG, ViewToolError } from './errors.js'
import { text, type ControllerCore } from './controller-core.js'
import { EVAL_MAX_CHARS, type ToolOutput } from './controller-types.js'

interface EvaluateResult {
  readonly result?: { readonly value?: unknown; readonly unserializableValue?: string }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

export function createEvalTools(core: ControllerCore): {
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  return {
    evaluate: (expression, signal) =>
      core.act(signal, async () => {
        const res = await call<EvaluateResult>('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        const details = res.exceptionDetails
        if (details !== undefined) {
          throw new ViewToolError(details.exception?.description ?? details.text ?? '')
        }
        // 裁決 28：NaN／Infinity／BigInt 只有 unserializableValue，value 是 undefined。
        // JSON.stringify 對 undefined／函式／symbol 也回 undefined，一併當成 'undefined'，
        // 不必為「值本身就是 undefined」另開一個特殊情況。
        const json = res.result?.unserializableValue ?? JSON.stringify(res.result?.value) ?? 'undefined'
        if (json.length <= EVAL_MAX_CHARS) return text(json)
        return text(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(json.length))
      }),

    // 不包 watcher.runAsAgent()：等待期間使用者的點擊與按鍵就是這個工具在等的事，
    // 要照常計入插手記錄，下一次 view_snapshot 才會告訴模型使用者做了什麼。
    requestHandoff: async (toolUseId, reason, signal) => {
      core.guard(signal)
      const { outcome } = await deps.handoff.begin(toolUseId, reason, signal)
      if (outcome === 'done') return text(MSG.handoffDone(deps.webContents.getURL()))
      if (outcome === 'timeout') return text(MSG.handoffTimeout(deps.webContents.getURL()))
      throw new ViewToolError(MSG.sessionEnded)
    },
  }
}
```

- [ ] **Step 3f: 最小實作（`src/main/view-tools/controller.ts` 完整內容）**

```ts
/**
 * 八個工具的實際動作（契約 §10.2）。這個檔只做兩件事：把契約列的公開型別與
 * 常數轉出去，以及把三組方法組成一個 ViewController。
 *
 * 拆檔的理由：八個方法加 call() 逾時、offset 重算與輸出組字放同一個檔會超過
 * 400 行（契約 §1）。切法依「共用什麼」而不是依工具數量平均切：
 * controller-core 是全部共用的零件，controller-page 共用 settle 的等待與網址
 * 檢查，controller-input 共用 ref 查表、座標換算與按鍵送出，controller-eval
 * 兩個方法不碰前兩者任何東西。
 */
import { createCore } from './controller-core.js'
import { createEvalTools } from './controller-eval.js'
import { createInputTools } from './controller-input.js'
import { createPageTools } from './controller-page.js'
import type { ControllerDeps, ViewController } from './controller-types.js'

export {
  CDP_CALL_TIMEOUT_MS,
  EVAL_MAX_CHARS,
  SCREENSHOT_MAX_WIDTH,
  type ControllerDeps,
  type ToolImage,
  type ToolOutput,
  type ToolText,
  type ViewController,
} from './controller-types.js'

export function createViewController(deps: ControllerDeps): ViewController {
  const core = createCore(deps)
  const page = createPageTools(core)
  const input = createInputTools(core)
  const evalTools = createEvalTools(core)

  return {
    navigate: page.navigate,
    snapshot: page.snapshot,
    screenshot: page.screenshot,
    click: input.click,
    type: input.type,
    press: input.press,
    evaluate: evalTools.evaluate,
    requestHandoff: evalTools.requestHandoff,
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/controller.test.ts tests/view-tools/controller-input.test.ts
npx tsc --noEmit -p tsconfig.json
```

實跑輸出（已在 worktree 實跑，Task 0 到 8 的定稿程式碼全部放入，`snapshot-collect.ts` 用的是 task-5.md 的 371 行定稿版而不是 stub）：

```
 Test Files  2 passed (2)
      Tests  54 passed (54)
```

`tsc --noEmit` 無輸出、0 error。行數：`controller-core.ts` 111、`controller-eval.ts` 52、`controller-input.ts` 137、`controller-page.ts` 82、`controller-types.ts` 54、`controller.ts` 44，全部在 400 行以內。

- [ ] **Step 5: 突變測試（八個，全部已在 worktree 實跑）**

每個突變都是「看起來合理但錯」的版本，跑的指令一律是 `npx vitest run tests/view-tools/`（54 個測試）。改完跑、記下變紅的測試名、還原、再跑一次確認回綠。

**突變 1：`call()` 不做逾時，直接把 `cdp.send` 的 promise 傳出去。** 這是最容易發生的簡化：型別完全一樣，成功路徑的所有測試照樣綠。

```ts
function createCall(deps: ControllerDeps): CdpCall {
  return <T,>(method: string, params?: object, sessionId?: string): Promise<T> =>
    deps.cdp.send<T>(method, params, sessionId)
}
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_click > CDP 指令逾時丟 code timeout 的 CdpError，不會永遠掛住（裁決 14）`。還原後 54 綠。

**突變 2：`pointOf` 不加 frame offset，直接回 border 中心。**

```ts
    const center = centerOfQuad(box.model.border)
    return center
```

實跑結果：`Tests 2 failed | 52 passed (54)`，紅的是
`controller：view_click > 兩層巢狀 OOPIF 的座標加上兩層 offset（裁決 9）` 與
`controller：view_click > offset 算不出來時錯誤原樣傳出，不退回主視窗座標亂點（裁決 29）`（不呼叫就不會丟）。還原後 54 綠。
主 target 的點擊測試（offset 為 0）在這個突變下照樣綠，這正是計畫撰寫者須知說的盲點：測試必須用非零 offset 才擋得住。

**突變 3：Task 5 的 `resolveFrameOffset` 只往上走一層，不繼續找祖父 session。** 這一個比突變 2 更難察覺：offset 仍然非零，只是少了外層那 `(100, 200)`。改的是上游的檔，用意是確認 Task 9 的測試對「共用函式退化」也看得見。

```ts
    steps.push(step)
    current = undefined      // 原本是 current = step.parentSessionId
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的同樣是
`controller：view_click > 兩層巢狀 OOPIF 的座標加上兩層 offset（裁決 9）`（期望 `x: 190` 收到 `x: 90`）。還原後 54 綠。

**突變 4：`clear` 的全選按鍵不帶 `commands: ['selectAll']`，只留 `modifiers: 4`。** 這是裁決 12 要防的那個錯：在 macOS 上這個版本按下去什麼都不會選，接著的 Backspace 只刪掉一個字元，模型以為清空了。

```ts
          await call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: 4,
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_type > clear 用 commands: [selectAll] 全選後按 Backspace（裁決 12）`。還原後 54 綠。

**突變 5：`evalTruncated` 帶截斷後的長度而不是原長。** 截斷本身還在做，字數也還是 8192，只有括號裡的數字錯了。

```ts
        return text(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(EVAL_MAX_CHARS))
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_eval > 超長結果截到 8192 字元並附原長`。還原後 54 綠。

**突變 6：`requestHandoff` 也包進 `core.act()`（即 `watcher.runAsAgent()`）。** 這是最像「一致性重構」的錯：八個方法看起來就該一視同仁，包進去之後所有 handoff 的成功、逾時、忙碌測試照樣綠，只有插手記錄不見了。

```ts
    requestHandoff: (toolUseId, reason, signal) =>
      core.act(signal, async () => {
      const { outcome } = await deps.handoff.begin(toolUseId, reason, signal)
      // …（其餘不變）
      }),
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：request_handoff > 等待期間的 input-event 要算使用者插手（不包在 runAsAgent 內）`。還原後 54 綠。

**突變 7：`evaluate` 不看 `unserializableValue`，只用 `JSON.stringify(result.value)`。** 這是裁決 28 之前的寫法：`NaN`、`Infinity`、`1n` 的 `result.value` 是 undefined，模型會收到「undefined」而不是真正的值。

```ts
        const json = JSON.stringify(res.result?.value) ?? 'undefined'
```

實跑結果：`Tests 2 failed | 52 passed (54)`，紅的是
`controller：view_eval > NaN 這類值只有 unserializableValue 時用它（裁決 28）` 與
`controller：view_eval > BigInt 的 unserializableValue 優先於 JSON.stringify`。還原後 54 綠。

**突變 8：`click` 把 `resolveFrameOffset` 的錯誤吞掉，退回 `{0,0}`。** 這是最危險的一個「防禦性寫法」：算不出 iframe 位置時仍然照點，座標會落在主頁上完全不相干的地方。裁決 29 明訂 click 端不 catch。

```ts
    const offset = await resolveFrameOffset(core.collect, entry.sessionId).catch(() => ({ x: 0, y: 0 }))
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_click > offset 算不出來時錯誤原樣傳出，不退回主視窗座標亂點（裁決 29）`。還原後 54 綠。

還原後最終確認（已實跑）：

```
$ npx vitest run tests/view-tools/
 Test Files  2 passed (2)
      Tests  54 passed (54)
$ npx tsc --noEmit -p tsconfig.json
（無輸出）
```

- [ ] **Step 6: 提交**

```bash
git add \
  src/main/view-tools/controller.ts \
  src/main/view-tools/controller-types.ts \
  src/main/view-tools/controller-core.ts \
  src/main/view-tools/controller-page.ts \
  src/main/view-tools/controller-input.ts \
  src/main/view-tools/controller-eval.ts \
  tests/view-tools/controller-harness.ts \
  tests/view-tools/controller.test.ts \
  tests/view-tools/controller-input.test.ts
git commit -m "feat: 八個右窗格工具的 CDP 動作（controller）"
```

---

### Task 10: view-tools 的 MCP server 組裝（`server.ts`）

這個檔只做三件事：把 controller 的 `ToolOutput` 轉成 MCP 的 `CallToolResult`、把三種例外翻成 `isError` 的一句中文、管住每次工具呼叫的 `AbortController`。八個工具的實際動作全部在 `controller.ts`，值檢查也在那裡（裁決 10），所以 server.ts 一行 CDP 都不碰，也不 import `snapshot.ts`／`refs.ts`／`urls.ts`。這樣切的好處是：controller 的每個方法都可以只回傳「成功時要說的那句話」，遇到問題就丟 `ViewToolError`，不必每個方法各自組 MCP 結果物件。

handler 永不 reject 是硬規定（規格 §7 最後一列）。作法是所有八個 handler 都走同一個外殼 `runTool()`：`try` 裡呼叫 controller 並轉成功結果，`catch` 轉錯誤結果，`finally` 把自己的 `AbortController` 從 `inflight` 移除。`catch` 分三路：`ViewToolError` 的 message 已經是 `MSG` 表的字，直接用；`CdpError` 補上 code 走 `MSG.cdpFailed`；剩下的都是沒預期到的例外，先 `logError` 再包成 `MSG.internal`。三路的順序不能換，因為 `ViewToolError` 與 `CdpError` 都是 `Error` 的子類。

signal 有兩個來源（裁決 19）：session 收尾時 ipc-bridge 呼叫的 `abortPending`（走每次呼叫自己的 `AbortController`），以及 MCP 端給的 `extra.signal`。兩者用 `AbortSignal.any` 合併後才交給 controller。`finally` 的 `inflight.delete(own)` 不是可有可無的清理：少了它，一個早就結束的呼叫仍留在集合裡，之後的 `abortPending` 會去中止一個沒人在等的 signal；測試「已經結束的呼叫不會被之後的 abortPending 中止」就是釘這件事，突變 2 已驗證它會變紅。

測試把 `watch.ts`、`settle.ts`、`handoff.ts`、`controller.ts` 四個模組 mock 掉（`handoff.ts` 用 `importOriginal` 保留真的 `readToolUseId`，那是裁決 8 指定要用的純函式），並攔截 `createSdkMcpServer` 的參數以取得八個工具定義。攔參數而不是去翻 `server.instance` 的私有欄位，是因為 `McpServer` 沒有公開的「列出已註冊工具」介面；也刻意不架一個真的 MCP client 對打，因為 MCP server 自己會把 handler 的 reject 包成 `isError`，那樣「handler 永不 reject」這條就永遠測不出來。`tool()` 的回傳物件本身帶 `_meta`，`alwaysLoad` 直接從那裡驗（已實跑確認 `{ 'anthropic/alwaysLoad': true }`）。

另外兩件事照契約寫死。`createSdkMcpServer` 帶 `timeout: HANDOFF_TIMEOUT_MS + 60_000`（裁決 32）：SDK 的工具呼叫上限預設讀 `MCP_TOOL_TIMEOUT` 環境變數，`request_handoff` 要等使用者最久 10 分鐘，明寫 11 分鐘才不會被使用者環境裡的設定砍掉。八個工具都不設 `annotations`，server 也不加序列化鎖（裁決 33）：Claude Code 對沒有 `readOnlyHint` 的 MCP 工具是序列執行，同一則訊息裡的 `view_navigate` 加 `view_snapshot` 會依序跑，自己再加一層鎖只是把同一件事做兩次；這條靠 RESULTS-05 的實機驗收確認，不寫單元測試（要測的是 Claude Code 的排程行為，不是 server.ts 的程式碼）。

選填參數的預設值在 server 端補齊（裁決 27）：`view_snapshot` 的 `scope ?? 'viewport'`、`view_type` 的 `clear ?? false` 與 `submit ?? false`。controller 的簽章三個都是必填，這樣 controller 不必再判斷 undefined。`dispose()` 的四步順序也是裁決 27 定的，測試釘死。

在 worktree 實跑：28 條測試全綠、`tsc --noEmit` 零錯誤、八個突變全部變紅、`server.ts` 的 Stmts／Branch／Funcs／Lines 皆 100%。實跑時 `controller.ts`（Task 9）用契約 §10.2 簽章的最小 stub（八個方法都回 rejected promise），測試把整個模組 mock 掉，所以 stub 的內容不影響任何斷言；事後對過 `task-9.md` 的 Produces 區塊，`ControllerDeps`、`ToolOutput`、`ViewController`、`createViewController` 四個名稱與簽章與 stub 完全一致，接得上。`snapshot-collect.ts`（Task 5）server.ts 完全不 import，沒有放進 worktree。

**Files:**
- Create `src/main/view-tools/server.ts`（196 行）
- Test: `tests/view-tools/server.test.ts`（378 行）

**Interfaces:**

Consumes：

```ts
// src/shared/view-tools.ts（Task 0）
export const VIEW_TOOL_SERVER_NAME = 'yeschef'
export type ViewToolName = 'view_navigate' | 'view_snapshot' | 'view_screenshot' | 'view_click'
  | 'view_type' | 'view_press' | 'view_eval' | 'request_handoff'
// src/main/view-tools/errors.ts（Task 0）
export class ViewToolError extends Error { readonly name = 'ViewToolError' }
export const MSG: { sessionEnded: string; handoffNoId: string;
  cdpFailed(code: string, message: string): string; internal(message: string): string; /* 其餘見契約 §10.1 */ }
// src/main/view-tools/policy.ts（Task 0）
export function viewToolPolicy(toolName: string): 'allow' | 'ask'
// src/main/cdp.ts（Task 1）
export class CdpError extends Error { readonly code: string }
export interface CdpSession { send; detach; getAttachedTargets; getRearmErrors; onEvent }
// src/main/view-tools/watch.ts（Task 6）
export function createWatcher(deps: WatchDeps): Promise<Watcher>
// src/main/view-tools/handoff.ts（Task 7）
export function createHandoff(clock: MergerClock, logError: (error: Error) => void): Handoff
export function readToolUseId(extra: unknown): string | null
// src/main/view-tools/settle.ts（Task 8）
export function createSettleTracker(cdp: Pick<CdpSession, 'onEvent'>, clock: MergerClock): SettleTracker
// src/main/view-tools/controller.ts（Task 9）
export function createViewController(deps: ControllerDeps): ViewController
export type ToolOutput = ToolText | ToolImage
// @anthropic-ai/claude-agent-sdk 0.3.258（契約 §0）
export function tool<Schema>(name, description, inputSchema, handler, extras?): SdkMcpToolDefinition<Schema>
export function createSdkMcpServer(options): McpSdkServerConfigWithInstance
```

Produces（Task 13 的 ipc-bridge 與 Task 14 的 index.ts 會用）：

```ts
// src/main/view-tools/server.ts
export interface ViewToolDeps {
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
}
export interface ViewTools {
  readonly server: McpSdkServerConfigWithInstance
  autoAllow(toolName: string, toolUseId: string): boolean
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
  dispose(): Promise<void>
}
export async function createViewToolServer(deps: ViewToolDeps): Promise<ViewTools>
```

- [ ] **Step 1: 寫失敗的測試**

先建目錄（Task 0 到 8 執行過的話已經有）：`mkdir -p src/main/view-tools tests/view-tools`。

建立 `tests/view-tools/server.test.ts`，完整內容如下（378 行）。四個 `vi.mock` 的位置不能挪到 import 之後：vitest 會把它們提到最上面，但 `shared` 必須用 `vi.hoisted` 建立才拿得到。`shared.controller` 等四個容器在 `beforeEach` 才填值，mock 工廠是在 `createViewToolServer()` 被呼叫時才讀它們，所以順序沒有問題。

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { WebContentsView } from 'electron'
import { z } from 'zod'
import { CdpError } from '../../src/main/cdp.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { HANDOFF_TIMEOUT_MS } from '../../src/main/view-tools/handoff.js'
import type { ToolOutput } from '../../src/main/view-tools/controller.js'
import { createViewToolServer, type ViewTools } from '../../src/main/view-tools/server.js'
import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName } from '../../src/shared/view-tools.js'
import { createFakeCdp, type FakeCdp } from '../helpers/fake-cdp.js'
import { manualClock } from '../helpers/manual-clock.js'

const shared = vi.hoisted(() => ({
  order: [] as string[],
  controller: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  watcher: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  settle: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  handoff: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  watchDeps: [] as unknown[],
  serverOptions: null as unknown as { name: string; version?: string; timeout?: number; tools?: { name: string; description: string; inputSchema: Record<string, z.ZodType>; _meta?: Record<string, unknown>; handler: (args: never, extra: unknown) => Promise<unknown> }[] },
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...actual,
    createSdkMcpServer: (options: Parameters<typeof actual.createSdkMcpServer>[0]) => {
      shared.serverOptions = options as typeof shared.serverOptions
      return actual.createSdkMcpServer(options)
    },
  }
})
vi.mock('../../src/main/view-tools/watch.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createWatcher: (deps: unknown) => { shared.watchDeps.push(deps); return Promise.resolve(shared.watcher) },
}))
vi.mock('../../src/main/view-tools/settle.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSettleTracker: () => shared.settle,
}))
vi.mock('../../src/main/view-tools/handoff.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createHandoff: () => shared.handoff,
}))
vi.mock('../../src/main/view-tools/controller.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createViewController: () => shared.controller,
}))

const OK_TEXT: ToolOutput = { kind: 'text', text: '好了' }
const PNG: ToolOutput = { kind: 'image', text: '可視範圍 800×600，網址 https://example.test/', dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' }

/** 每個 controller 方法的最後一個參數都是 signal，統一記下來給 signal 相關的斷言用。 */
let signals: AbortSignal[]
let logError: Mock<(error: Error) => void>
let cdp: FakeCdp
let webContents: { isDestroyed(): boolean; getURL(): string; getTitle(): string; on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> }

function resolving(output: ToolOutput) {
  return vi.fn((...args: unknown[]) => {
    signals.push(args[args.length - 1] as AbortSignal)
    return Promise.resolve(output)
  })
}

/** 永不 settle：讓呼叫停在 inflight 裡，才能測 abortPending 與 extra.signal。 */
function pendingForever() {
  return vi.fn((...args: unknown[]) => {
    signals.push(args[args.length - 1] as AbortSignal)
    return new Promise<ToolOutput>(() => {})
  })
}

beforeEach(() => {
  signals = []
  shared.order = []
  shared.watchDeps = []
  logError = vi.fn<(error: Error) => void>()
  cdp = createFakeCdp()
  webContents = {
    isDestroyed: () => false,
    getURL: () => 'https://example.test/',
    getTitle: () => '標題',
    on: vi.fn(),
    off: vi.fn(),
  }
  shared.controller = {
    navigate: resolving(OK_TEXT), snapshot: resolving(OK_TEXT), screenshot: resolving(PNG),
    click: resolving(OK_TEXT), type: resolving(OK_TEXT), press: resolving(OK_TEXT),
    evaluate: resolving(OK_TEXT), requestHandoff: resolving(OK_TEXT),
  }
  shared.watcher = { refs: vi.fn(), setRefs: vi.fn(), intervention: vi.fn(), takeIntervention: vi.fn(), runAsAgent: vi.fn(), dispose: vi.fn(() => { shared.order.push('watcher.dispose') }) }
  shared.settle = { inflight: vi.fn(), waitForQuiet: vi.fn(), waitForLoad: vi.fn(), dispose: vi.fn(() => { shared.order.push('settle.dispose') }) }
  shared.handoff = { pending: vi.fn(), begin: vi.fn(), done: vi.fn(), abortAll: vi.fn(() => { shared.order.push('handoff.abortAll') }) }
})

async function build(): Promise<ViewTools> {
  return createViewToolServer({
    view: { webContents } as unknown as WebContentsView,
    cdp,
    clock: manualClock().clock,
    projectDir: '/專案',
    logError,
  })
}

function toolDef(name: string) {
  const found = shared.serverOptions.tools?.find((t) => t.name === name)
  if (found === undefined) throw new Error(`找不到工具 ${name}`)
  return found
}

async function call(name: string, args: object, extra: unknown = { _meta: {} }) {
  return (await toolDef(name).handler(args as never, extra)) as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }
}

function ctrl(name: string): ReturnType<typeof vi.fn> {
  const fn = shared.controller[name]
  if (fn === undefined) throw new Error(`沒有 ${name}`)
  return fn
}

describe('工具定義', () => {
  it('server 名稱、版本與八個工具的名稱順序都照契約', async () => {
    await build()
    expect(shared.serverOptions.name).toBe('yeschef')
    expect(shared.serverOptions.version).toBe('0.1.0')
    expect(shared.serverOptions.tools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES])
  })

  it('server 帶 11 分鐘的工具呼叫上限，不受 MCP_TOOL_TIMEOUT 影響', async () => {
    await build()
    expect(shared.serverOptions.timeout).toBe(HANDOFF_TIMEOUT_MS + 60_000)
    expect(shared.serverOptions.timeout).toBe(660_000)
  })

  it('八個工具都帶 alwaysLoad', async () => {
    await build()
    for (const def of shared.serverOptions.tools ?? []) {
      expect(def._meta, def.name).toEqual({ 'anthropic/alwaysLoad': true })
    }
  })

  it('每個工具都有非空的中文描述', async () => {
    await build()
    for (const def of shared.serverOptions.tools ?? []) {
      expect(def.description.length, def.name).toBeGreaterThan(0)
    }
  })

  it('zod shape 的欄位名稱與必填選填照契約', async () => {
    await build()
    expect(Object.keys(toolDef('view_navigate').inputSchema)).toEqual(['url'])
    expect(Object.keys(toolDef('view_snapshot').inputSchema)).toEqual(['scope'])
    expect(Object.keys(toolDef('view_screenshot').inputSchema)).toEqual([])
    expect(Object.keys(toolDef('view_click').inputSchema)).toEqual(['ref'])
    expect(Object.keys(toolDef('view_type').inputSchema)).toEqual(['ref', 'text', 'clear', 'submit'])
    expect(Object.keys(toolDef('view_press').inputSchema)).toEqual(['key'])
    expect(Object.keys(toolDef('view_eval').inputSchema)).toEqual(['expression'])
    expect(Object.keys(toolDef('request_handoff').inputSchema)).toEqual(['reason'])
  })

  it('view_type 的 clear／submit 是選填，view_snapshot 的 scope 只收兩個值', async () => {
    await build()
    const typeShape = z.object(toolDef('view_type').inputSchema)
    expect(typeShape.safeParse({ ref: 's1-e0', text: 'hi' }).success).toBe(true)
    expect(typeShape.safeParse({ ref: 's1-e0' }).success).toBe(false)
    const scopeShape = z.object(toolDef('view_snapshot').inputSchema)
    expect(scopeShape.safeParse({}).success).toBe(true)
    expect(scopeShape.safeParse({ scope: 'full' }).success).toBe(true)
    expect(scopeShape.safeParse({ scope: 'whole-page' }).success).toBe(false)
  })

  it('createWatcher 收到 cdp、webContents 與 logError', async () => {
    await build()
    expect(shared.watchDeps).toEqual([{ cdp, webContents, logError }])
  })
})

describe('參數傳遞與成功結果', () => {
  it('文字輸出包成單段 text 且不標 isError', async () => {
    await build()
    const result = await call('view_navigate', { url: 'https://a.test/' })
    expect(result).toEqual({ content: [{ type: 'text', text: '好了' }] })
    expect(result.isError).toBeUndefined()
    expect(ctrl('navigate').mock.calls[0]?.[0]).toBe('https://a.test/')
  })

  it('影像輸出包成 text 加 image 兩段', async () => {
    await build()
    const result = await call('view_screenshot', {})
    expect(result.content).toEqual([
      { type: 'text', text: '可視範圍 800×600，網址 https://example.test/' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    expect(result.isError).toBeUndefined()
  })

  it('view_snapshot 省略 scope 時用 viewport，給 full 時用 full', async () => {
    await build()
    await call('view_snapshot', {})
    await call('view_snapshot', { scope: 'full' })
    expect(ctrl('snapshot').mock.calls[0]?.[0]).toBe('viewport')
    expect(ctrl('snapshot').mock.calls[1]?.[0]).toBe('full')
  })

  it('view_type 的 clear 與 submit 省略時是 false，給值時原樣傳下去', async () => {
    await build()
    await call('view_type', { ref: 's3-e1', text: 'abc' })
    await call('view_type', { ref: 's3-e2', text: 'x', clear: true, submit: true })
    expect(ctrl('type').mock.calls[0]?.slice(0, 4)).toEqual(['s3-e1', 'abc', false, false])
    expect(ctrl('type').mock.calls[1]?.slice(0, 4)).toEqual(['s3-e2', 'x', true, true])
  })

  it('click、press、eval 的參數各自傳到對應方法', async () => {
    await build()
    await call('view_click', { ref: 's2-e7' })
    await call('view_press', { key: 'Enter' })
    await call('view_eval', { expression: '1 + 1' })
    expect(ctrl('click').mock.calls[0]?.[0]).toBe('s2-e7')
    expect(ctrl('press').mock.calls[0]?.[0]).toBe('Enter')
    expect(ctrl('evaluate').mock.calls[0]?.[0]).toBe('1 + 1')
  })
})

describe('錯誤包裝', () => {
  it('ViewToolError 直接用它的訊息並標 isError，不記 logError', async () => {
    await build()
    ctrl('click').mockRejectedValueOnce(new ViewToolError(MSG.refFormat))
    const result = await call('view_click', { ref: '亂寫' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.refFormat }], isError: true })
    expect(logError).not.toHaveBeenCalled()
  })

  it('CdpError 轉成 cdpFailed 並帶 code，不記 logError', async () => {
    await build()
    ctrl('press').mockRejectedValueOnce(new CdpError('沒有這個方法', '-32601'))
    const result = await call('view_press', { key: 'Enter' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.cdpFailed('-32601', '沒有這個方法') }], isError: true })
    expect(logError).not.toHaveBeenCalled()
  })

  it('一般 Error 先 logError 再轉成 internal', async () => {
    await build()
    const boom = new Error('undefined 不是函式')
    ctrl('evaluate').mockRejectedValueOnce(boom)
    const result = await call('view_eval', { expression: 'x()' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.internal('undefined 不是函式') }], isError: true })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBe(boom)
  })

  it('丟出非 Error 的值也會 logError 並包成 internal', async () => {
    await build()
    ctrl('navigate').mockRejectedValueOnce('壞掉了')
    const result = await call('view_navigate', { url: 'https://a.test/' })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.internal('壞掉了') }], isError: true })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('controller 同步丟例外時 handler 仍然 resolve', async () => {
    await build()
    ctrl('click').mockImplementationOnce(() => { throw new ViewToolError(MSG.viewGone) })
    await expect(call('view_click', { ref: 's1-e0' })).resolves.toEqual({
      content: [{ type: 'text', text: MSG.viewGone }], isError: true,
    })
  })
})

describe('signal', () => {
  it('abortPending 中止全部進行中的呼叫', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' })
    void call('view_click', { ref: 's1-e1' })
    await Promise.resolve()
    expect(signals).toHaveLength(2)
    expect(signals.map((s) => s.aborted)).toEqual([false, false])
    tools.abortPending(MSG.sessionEnded)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
    expect(signals[0]?.reason).toBeInstanceOf(ViewToolError)
    expect((signals[0]?.reason as Error).message).toBe(MSG.sessionEnded)
  })

  it('已經結束的呼叫不會被之後的 abortPending 中止', async () => {
    const tools = await build()
    await call('view_press', { key: 'Tab' })
    tools.abortPending(MSG.sessionEnded)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
  })

  it('abortPending 之後開始的呼叫拿到乾淨的 signal', async () => {
    const tools = await build()
    tools.abortPending(MSG.sessionEnded)
    await call('view_press', { key: 'Tab' })
    expect(signals[0]?.aborted).toBe(false)
  })

  it('extra.signal 中止時 controller 收到的 signal 也中止', async () => {
    await build()
    ctrl('click').mockImplementation(pendingForever())
    const outer = new AbortController()
    void call('view_click', { ref: 's1-e0' }, { _meta: {}, signal: outer.signal })
    await Promise.resolve()
    expect(signals[0]?.aborted).toBe(false)
    outer.abort(new Error('MCP 端取消'))
    expect(signals[0]?.aborted).toBe(true)
  })

  it('extra 沒有 signal 或不是 AbortSignal 時照樣可用，自己的中止仍然有效', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' }, undefined)
    void call('view_click', { ref: 's1-e1' }, { _meta: {}, signal: '不是 signal' })
    await Promise.resolve()
    expect(signals).toHaveLength(2)
    tools.abortPending(MSG.sessionEnded)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
  })
})

describe('request_handoff', () => {
  it('從 extra._meta 取到 toolUseId 並傳給 controller', async () => {
    await build()
    const result = await call('request_handoff', { reason: '請登入' }, { _meta: { 'claudecode/toolUseId': 'toolu_42' } })
    expect(ctrl('requestHandoff').mock.calls[0]?.slice(0, 2)).toEqual(['toolu_42', '請登入'])
    expect(result.isError).toBeUndefined()
  })

  it('取不到 toolUseId 時回 handoffNoId，不呼叫 controller 也不 logError', async () => {
    await build()
    const result = await call('request_handoff', { reason: '請登入' }, { _meta: { 'claudecode/toolUseId': '' } })
    expect(result).toEqual({ content: [{ type: 'text', text: MSG.handoffNoId }], isError: true })
    expect(ctrl('requestHandoff')).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  it('extra 完全不是物件時也只回 handoffNoId', async () => {
    await build()
    await expect(call('request_handoff', { reason: '請登入' }, 'nope')).resolves.toEqual({
      content: [{ type: 'text', text: MSG.handoffNoId }], isError: true,
    })
  })
})

describe('autoAllow、handoffDone 與 dispose', () => {
  it('autoAllow 只看 policy：view_eval 與未知名稱不放行', async () => {
    const tools = await build()
    for (const name of VIEW_TOOL_NAMES) {
      const expected = name !== 'view_eval'
      expect(tools.autoAllow(fullToolName(name), 'toolu_1'), name).toBe(expected)
    }
    expect(tools.autoAllow(VIEW_EVAL_TOOL, 'toolu_1')).toBe(false)
    expect(tools.autoAllow('mcp__yeschef__view_delete_everything', 'toolu_1')).toBe(false)
    expect(tools.autoAllow('view_click', 'toolu_1')).toBe(false)
    expect(tools.autoAllow('Bash', 'toolu_1')).toBe(false)
  })

  it('handoffDone 轉給 handoff.done', async () => {
    const tools = await build()
    tools.handoffDone('toolu_9')
    expect(shared.handoff.done).toHaveBeenCalledWith('toolu_9')
  })

  it('dispose 先中止進行中的呼叫，再依序收 watcher、settle、handoff', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' })
    await Promise.resolve()
    signals[0]?.addEventListener('abort', () => { shared.order.push('abort') })
    await tools.dispose()
    expect(shared.order).toEqual(['abort', 'watcher.dispose', 'settle.dispose', 'handoff.abortAll'])
    expect((signals[0]?.reason as Error).message).toBe(MSG.sessionEnded)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/server.test.ts
```

實跑結果（在 worktree 把 `server.ts` 移走後跑）：

```
Error: Cannot find module '/src/main/view-tools/server.js' imported from .../tests/view-tools/server.test.ts
Test Files  1 failed (1)
     Tests  no tests
```

符合預期：模組還不存在，連 collect 都過不了。

- [ ] **Step 3: 最小實作**

建立 `src/main/view-tools/server.ts`，完整內容如下（196 行）。`@modelcontextprotocol/sdk/types.js` 的 `CallToolResult` 是契約 §0 指定的來源，它是 Agent SDK 的相依，已經在 `node_modules`。

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { WebContentsView } from 'electron'
import type { MergerClock } from '../agent-host.js'
import { CdpError, type CdpSession } from '../cdp.js'
import { VIEW_TOOL_SERVER_NAME, type ViewToolName } from '../../shared/view-tools.js'
import { MSG, ViewToolError } from './errors.js'
import { viewToolPolicy } from './policy.js'
import { createViewController, type ToolOutput, type ViewController } from './controller.js'
import { HANDOFF_TIMEOUT_MS, createHandoff, readToolUseId } from './handoff.js'
import { createSettleTracker } from './settle.js'
import { createWatcher } from './watch.js'

export interface ViewToolDeps {
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
}

export interface ViewTools {
  readonly server: McpSdkServerConfigWithInstance
  autoAllow(toolName: string, toolUseId: string): boolean
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
  dispose(): Promise<void>
}

const SERVER_VERSION = '0.1.0'
/**
 * 工具呼叫上限（裁決 32）。SDK 預設讀 MCP_TOOL_TIMEOUT 環境變數，明寫成 11 分鐘，
 * request_handoff 的 10 分鐘等待才不會被環境設定砍掉。
 */
const TOOL_CALL_TIMEOUT_MS = HANDOFF_TIMEOUT_MS + 60_000

/** 給模型看的一句話。字串是使用者可見文案，改字要先改契約。 */
const TOOL_DESCRIPTIONS: Readonly<Record<ViewToolName, string>> = {
  view_navigate: '在右窗格開啟一個網址，支援 http、https，以及專案目錄底下的 file。',
  view_snapshot: '列出右窗格目前可操作的元素與它們的 ref，操作前先呼叫這個。',
  view_screenshot: '對右窗格的可視範圍截一張圖，用於確認版面或圖片內容。',
  view_click: '點擊 view_snapshot 給的 ref 所指的元素。',
  view_type: '在 view_snapshot 給的 ref 所指的欄位輸入文字，可選擇先清空或輸入後送出。',
  view_press: '對右窗格送出一個按鍵，例如 Enter、Tab 或方向鍵。',
  view_eval: '在右窗格的主 frame 執行一段 JavaScript 並取回結果，每次都需要使用者批准。',
  request_handoff: '把右窗格交給使用者處理（例如登入或輸入驗證碼），等他按下「我好了」再繼續。',
}

function toToolResult(output: ToolOutput): CallToolResult {
  if (output.kind === 'image') {
    return {
      content: [
        { type: 'text', text: output.text },
        { type: 'image', data: output.dataBase64, mimeType: output.mimeType },
      ],
    }
  }
  return { content: [{ type: 'text', text: output.text }] }
}

/**
 * 錯誤翻成給模型看的一句中文（契約 §10.3）。ViewToolError 的 message 本來就是
 * MSG 表的字，直接用；CdpError 補上 code；其他都是沒預期到的例外，先 logError
 * 再包成 MSG.internal，主程序才看得到 stack。
 */
function toErrorResult(error: unknown, logError: (error: Error) => void): CallToolResult {
  if (error instanceof ViewToolError) return errorResult(error.message)
  if (error instanceof CdpError) return errorResult(MSG.cdpFailed(error.code, error.message))
  const wrapped = error instanceof Error ? error : new Error(String(error))
  logError(wrapped)
  return errorResult(MSG.internal(wrapped.message))
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function extraSignal(extra: unknown): AbortSignal | null {
  if (typeof extra !== 'object' || extra === null) return null
  const signal = (extra as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : null
}

/** 裁決 19（docs/superpowers/plan-b/CONTRACT.md）：自己的中止與 MCP 端的中止都要能停掉等待。 */
function mergeSignal(own: AbortSignal, extra: unknown): AbortSignal {
  const fromExtra = extraSignal(extra)
  return fromExtra === null ? own : AbortSignal.any([own, fromExtra])
}

interface ToolRuntime {
  readonly controller: ViewController
  readonly inflight: Set<AbortController>
  readonly logError: (error: Error) => void
}

/** 所有工具的共用外殼：登記 inflight、合併 signal、把任何結果或例外轉成 CallToolResult。永不 reject。 */
async function runTool(
  runtime: ToolRuntime,
  extra: unknown,
  action: (signal: AbortSignal) => Promise<ToolOutput>
): Promise<CallToolResult> {
  const own = new AbortController()
  runtime.inflight.add(own)
  try {
    return toToolResult(await action(mergeSignal(own.signal, extra)))
  } catch (error) {
    return toErrorResult(error, runtime.logError)
  } finally {
    runtime.inflight.delete(own)
  }
}

function handoffAction(runtime: ToolRuntime, extra: unknown, reason: string) {
  return (signal: AbortSignal): Promise<ToolOutput> => {
    // 裁決 8：toolUseId 只能從 extra._meta 取，取不到就當這次交接無法追蹤。
    const toolUseId = readToolUseId(extra)
    if (toolUseId === null) throw new ViewToolError(MSG.handoffNoId)
    return runtime.controller.requestHandoff(toolUseId, reason, signal)
  }
}

/** 八個工具。裁決 10：zod shape 只宣告型別，值檢查在 controller。裁決 19：全部 alwaysLoad。 */
function createTools(runtime: ToolRuntime) {
  const always = { alwaysLoad: true }
  return [
    tool('view_navigate', TOOL_DESCRIPTIONS.view_navigate, { url: z.string() }, (args, extra) =>
      runTool(runtime, extra, (signal) => runtime.controller.navigate(args.url, signal)), always),
    tool('view_snapshot', TOOL_DESCRIPTIONS.view_snapshot, { scope: z.enum(['viewport', 'full']).optional() }, (args, extra) =>
      runTool(runtime, extra, (signal) => runtime.controller.snapshot(args.scope ?? 'viewport', signal)), always),
    tool('view_screenshot', TOOL_DESCRIPTIONS.view_screenshot, {}, (_args, extra) =>
      runTool(runtime, extra, (signal) => runtime.controller.screenshot(signal)), always),
    tool('view_click', TOOL_DESCRIPTIONS.view_click, { ref: z.string() }, (args, extra) =>
      runTool(runtime, extra, (signal) => runtime.controller.click(args.ref, signal)), always),
    tool('view_type', TOOL_DESCRIPTIONS.view_type, {
      ref: z.string(), text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional(),
    }, (args, extra) =>
      runTool(runtime, extra, (signal) =>
        runtime.controller.type(args.ref, args.text, args.clear ?? false, args.submit ?? false, signal)), always),
    tool('view_press', TOOL_DESCRIPTIONS.view_press, { key: z.string() }, (args, extra) =>
      runTool(runtime, extra, (signal) => runtime.controller.press(args.key, signal)), always),
    tool('view_eval', TOOL_DESCRIPTIONS.view_eval, { expression: z.string() }, (args, extra) =>
      runTool(runtime, extra, (signal) => runtime.controller.evaluate(args.expression, signal)), always),
    tool('request_handoff', TOOL_DESCRIPTIONS.request_handoff, { reason: z.string() }, (args, extra) =>
      runTool(runtime, extra, handoffAction(runtime, extra, args.reason)), always),
  ]
}

/**
 * 組裝右窗格工具：watcher（含裁決 5 的域啟用，所以工廠是 async）、settle、handoff、
 * controller，最後包成一個程序內 MCP server。這個檔只做組裝與錯誤翻譯，動作全在 controller。
 */
export async function createViewToolServer(deps: ViewToolDeps): Promise<ViewTools> {
  const webContents = deps.view.webContents
  const watcher = await createWatcher({ cdp: deps.cdp, webContents, logError: deps.logError })
  const settle = createSettleTracker(deps.cdp, deps.clock)
  const handoff = createHandoff(deps.clock, deps.logError)
  const controller = createViewController({
    cdp: deps.cdp,
    webContents,
    watcher,
    settle,
    handoff,
    clock: deps.clock,
    projectDir: deps.projectDir,
    logError: deps.logError,
  })

  const inflight = new Set<AbortController>()
  const runtime: ToolRuntime = { controller, inflight, logError: deps.logError }
  const server = createSdkMcpServer({
    name: VIEW_TOOL_SERVER_NAME,
    version: SERVER_VERSION,
    tools: createTools(runtime),
    timeout: TOOL_CALL_TIMEOUT_MS,
  })

  const abortPending = (reason: string): void => {
    for (const pending of inflight) pending.abort(new ViewToolError(reason))
    inflight.clear()
  }

  return {
    server,
    autoAllow: (toolName: string, _toolUseId: string): boolean => viewToolPolicy(toolName) === 'allow',
    handoffDone: (toolUseId: string): void => { handoff.done(toolUseId) },
    abortPending,
    dispose: async (): Promise<void> => {
      abortPending(MSG.sessionEnded)
      watcher.dispose()
      settle.dispose()
      handoff.abortAll()
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/server.test.ts
npx tsc --noEmit -p tsconfig.json
npx vitest run
```

實跑結果（在 worktree，上游 Task 0 到 8 的程式碼已就位，Task 9 用最小 stub）：

```
Test Files  1 passed (1)
     Tests  28 passed (28)
```

`tsc --noEmit` 零輸出。全套件：`Test Files 26 passed (26)`、`Tests 523 passed (523)`。

覆蓋率（`npx vitest run --coverage tests/view-tools/server.test.ts`，只看本檔）：`src/main/view-tools/server.ts` 的 Stmts、Branch、Funcs、Lines 都是 100。

- [ ] **Step 5: 突變測試**

八個突變，全部在 worktree 實跑，每個改完跑 `npx vitest run tests/view-tools/server.test.ts`，記下變紅的測試後 `git checkout` 還原並確認回到 28 passed。

突變 1：`errorResult()` 漏掉 `isError: true`。

```diff
-  return { content: [{ type: 'text', text }], isError: true }
+  return { content: [{ type: 'text', text }] }
```

7 failed | 20 passed。變紅：`ViewToolError 直接用它的訊息並標 isError，不記 logError`、`CdpError 轉成 cdpFailed 並帶 code，不記 logError`、`一般 Error 先 logError 再轉成 internal`、`丟出非 Error 的值也會 logError 並包成 internal`、`controller 同步丟例外時 handler 仍然 resolve`、`取不到 toolUseId 時回 handoffNoId，不呼叫 controller 也不 logError`、`extra 完全不是物件時也只回 handoffNoId`。反方向也擋得住：成功路徑的兩條測試用 `toEqual` 比整個結果物件，所以「一律加上 isError」的突變一樣會紅。

突變 2：`runTool()` 的 `finally` 不清 inflight。

```diff
   } catch (error) {
     return toErrorResult(error, runtime.logError)
-  } finally {
-    runtime.inflight.delete(own)
   }
```

1 failed | 26 passed。變紅：`已經結束的呼叫不會被之後的 abortPending 中止`。這是刻意設計的盲點防護：呼叫結束後留在集合裡不會造成任何例外，只會讓之後的 `abortPending` 去中止一個沒人在等的 signal，所以測試必須斷言「已完成呼叫拿到的那個 signal 在 abortPending 之後仍是 `aborted === false`」，光看「新的呼叫沒被中止」是抓不到的。

突變 3：`mergeSignal()` 不合併 `extra.signal`。

```diff
-  return fromExtra === null ? own : AbortSignal.any([own, fromExtra])
+  return own
```

1 failed | 26 passed。變紅：`extra.signal 中止時 controller 收到的 signal 也中止`。該測試用真的 `AbortController` 當 `extra.signal`，不是斷言 `AbortSignal.any` 被呼叫過。

突變 4：一般 Error 不經 `logError`。

```diff
   const wrapped = error instanceof Error ? error : new Error(String(error))
-  logError(wrapped)
   return errorResult(MSG.internal(wrapped.message))
```

2 failed | 25 passed。變紅：`一般 Error 先 logError 再轉成 internal`、`丟出非 Error 的值也會 logError 並包成 internal`。前者還斷言 `logError` 收到的是同一個 error 物件（`toBe`），不只是被呼叫過。

突變 5：`abortPending` 只中止第一個。

```diff
-    for (const pending of inflight) pending.abort(new ViewToolError(reason))
+    for (const pending of inflight) { pending.abort(new ViewToolError(reason)); break }
```

2 failed | 25 passed。變紅：`abortPending 中止全部進行中的呼叫`、`extra 沒有 signal 或不是 AbortSignal 時照樣可用，自己的中止仍然有效`。兩條測試都同時掛兩筆 inflight，只有一筆的話這個突變會全綠。

突變 6：`view_snapshot` 的預設 scope 改成 `full`。

```diff
-      runTool(runtime, extra, (signal) => runtime.controller.snapshot(args.scope ?? 'viewport', signal)), always),
+      runTool(runtime, extra, (signal) => runtime.controller.snapshot(args.scope ?? 'full', signal)), always),
```

1 failed | 26 passed。變紅：`view_snapshot 省略 scope 時用 viewport，給 full 時用 full`。同一條測試也叫一次帶 `scope: 'full'`，所以「永遠傳 viewport」的反向突變一樣會紅。

突變 7：`dispose()` 把 `abortPending` 移到最後。

```diff
-      abortPending(MSG.sessionEnded)
       watcher.dispose()
       settle.dispose()
       handoff.abortAll()
+      abortPending(MSG.sessionEnded)
```

1 failed | 26 passed。變紅：`dispose 先中止進行中的呼叫，再依序收 watcher、settle、handoff`。順序是靠在 pending 呼叫的 signal 上掛 `abort` 監聽器、把 `'abort'` 推進同一個陣列驗的，不是只數呼叫次數。

突變 8：`createSdkMcpServer` 漏掉 `timeout`。

```diff
     tools: createTools(runtime),
-    timeout: TOOL_CALL_TIMEOUT_MS,
   })
```

1 failed | 27 passed。變紅：`server 帶 11 分鐘的工具呼叫上限，不受 MCP_TOOL_TIMEOUT 影響`。該測試同時比 `HANDOFF_TIMEOUT_MS + 60_000` 與字面值 `660_000`，兩邊都改才騙得過去。

- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/server.ts tests/view-tools/server.test.ts
git commit -m "feat: view-tools 的程序內 MCP server 組裝與錯誤包裝"
```

---

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

---

### Task 12: HandoffCard 與 renderToolOverride

`request_handoff` 的卡片跟其他七個工具不一樣：它不是「看模型做了什麼」，而是「使用者現在要動手」。
預設的 `ToolCall` 只有標頭加可展開的參數與結果，畫不出按鈕，也畫不出「已等待 3 分鐘」。裁決 2 選了
最小的接法：`fold.ts` 不動、不新增 Block 種類，改在 `Turn` 加一個 `renderToolOverride`，由 `App`
依 `block.name === REQUEST_HANDOFF_TOOL` 決定要不要整張換掉。`ToolBlock` 已經有 `id`／`name`／
`input`／`result`／`status`／`deniedReason`，畫一張交接卡需要的東西一個都不缺。

`renderToolOverride` 與既有的 `renderToolExtra` 是兩種不同的東西，不能合成一個：`renderToolExtra`
是「在預設卡片底下再加一塊」（批准卡走這條），`renderToolOverride` 是「這張卡我自己畫」。回傳
`undefined` 就是「這個工具沒有專用卡」，走回預設的 `ToolCall`；判斷要看**回傳值**而不是「有沒有給
這個 callback」，否則 App 一掛上 callback，所有工具的卡片就全部消失。

卡片的六種樣貌先併成一個 `Phase`（`preparing`／`pending`／`stale`／`done`／`error`／`denied`），
之後每一塊內容只問 `phase` 一次。直接在 JSX 裡到處寫 `status === 'running' && !historical` 的話，
同一組布林運算會重複五次，改一次規則要改五個地方。契約 §12 只給四個 class modifier，所以
`preparing` 與 `pending` 共用 `--pending`、`denied` 與 `error` 共用 `--error`（依裁決 25）。

「已等待」有三個坑，都實測過。第一，起算點 `mountedAt` 要用惰性初始值取一次，每次重畫重取的話
永遠停在「不到 1 分鐘」。第二，重算間隔是 30 秒（`formatElapsed` 的最小刻度是一分鐘，30 秒讓跨分鐘
那一刻最多晚半分鐘才顯示），計時器只在 `pending` 排：歷史對話的交接不會有下文，繼續數秒數是騙人，
還會在使用者翻舊對話時留一堆醒著的 interval。第三，`now` 放進 ref 再讀，呼叫端每次重畫給一個新函式
時 interval 不會被拆掉重排，否則永遠等不到第一次到期。

「按兩次只送一次」原本寫成 `if (notified) return` 加 `disabled={notified}`，突變測試當場拆穿：
拿掉那行 guard 測試照樣全綠（見 Step 13 的突變 2）。原因有兩層，jsdom 對停用的按鈕根本不發第二個
click，而同一個批次裡的第二次點擊讀到的 `notified` 還是這一輪 render 的 `false`。改成 ref 記旗標，
測試改用同一個 `act` 內連發兩個 `MouseEvent`，這才是真的在測那件事。

**Files:**
- Create `src/renderer/components/HandoffCard.tsx`（169 行）
- Create `src/renderer/components/HandoffCard.css`（74 行）
- Modify `src/renderer/components/Turn.tsx`
  - 第 1 行 import 加 `Fragment`
  - 第 11 行後（`renderToolExtra` 之後）加 `renderToolOverride?`，並在 `TurnProps` 之後加 `RenderOptions`
  - 第 33-38 行 `renderBlock` 簽章改成收 `opts: RenderOptions`
  - 第 44-52 行 `case 'tool'` 改成先問 override
  - 第 60 行 `TurnImpl` 解構加 `renderToolOverride`、組出 `opts`
  - 第 65 行 `renderBlock` 呼叫改成傳 `opts`
  - 第 75 行後 memo 比較函式加 `renderToolOverride` 參考相等
- Modify `src/renderer/components/Conversation.tsx`
  - 第 20 行後（`ConversationProps.renderToolExtra` 之後）加 `renderToolOverride?`
  - 第 23 行參數解構加 `renderToolOverride`
  - 第 53 行後傳給 `Turn`
- Modify `src/renderer/App.tsx`
  - 第 3 行後加 `import { HandoffCard }`
  - 第 9 行後加 `import { REQUEST_HANDOFF_TOOL } from '../shared/view-tools.js'`
  - 第 87 行（`App` 的檔頭註解，`標題列（Task 11…` 之前）加一段交接卡的說明
  - 第 109 行後（`renderToolExtra` 的 `useCallback` 之後）加 `renderToolOverride`
  - 第 128 行後把 `renderToolOverride` 傳給 `Conversation`
- Test:
  - Create `tests/handoff-card.test.tsx`（313 行、21 個測試）
  - Modify `tests/conversation.test.tsx`：`renderToolExtra 沒給時…` 那個 `it` 之後加四個 `it`

三個 Plan A 測試檔（`tests/app-title-bar.test.tsx`、`tests/use-approvals.test.tsx`、
`tests/use-conversation.test.tsx`）的假 `YesChefApi` 由 Task 11 補上 `handoffDone`，本 task 不動。

**Interfaces:**
- Consumes：
  - Task 0：`REQUEST_HANDOFF_TOOL: string`（`src/shared/view-tools.ts`，值 `'mcp__yeschef__request_handoff'`）
  - Task 11：`formatElapsed(ms: number): string`（`src/renderer/components/relative-time.ts`）、
    `YesChefApi.handoffDone(toolUseId: string): void`（`src/shared/ipc.ts`，preload 已曝露）
  - Plan A 既有：`formatValue(value: unknown): string`（`ToolCall.tsx`）、
    `ToolBlock = Extract<Block, { kind: 'tool' }>`（`block-equals.ts`）
- Produces：
  - `interface HandoffCardProps { block: ToolBlock; historical: boolean; onDone: (toolUseId: string) => void; now?: () => number }`
  - `function HandoffCard(props: HandoffCardProps)`
  - `HANDOFF_BUTTON_TEXT`／`HANDOFF_NOTIFIED_TEXT`／`HANDOFF_INCOMPLETE_TEXT`／
    `HANDOFF_PREPARING_TEXT`／`HANDOFF_NO_REASON_TEXT`（五個 `const`，契約 §12 逐字）
  - `TurnProps.renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined`
  - `ConversationProps.renderToolOverride?`（同簽章）
  - 下游：Task 13（`ipc-bridge.ts` 的 `handoff:done` handler 接收這張卡送出的通知）、
    Task 14（實機驗收第 20 到 22 項）

- [ ] **Step 1：寫失敗的測試（`renderToolOverride`）**

`tests/conversation.test.tsx`：在既有的 `it('renderToolExtra 沒給時不影響渲染，工具卡片照常出現', …)`
之後插入四個 `it`（同一個 `describe('Conversation', …)` 內，沿用檔案既有的 `tool()`／`viewOf()` helper）。

```tsx
  // 裁決 2：交接卡不新增 Block 種類，改用 renderToolOverride 整張換掉。
  it('renderToolOverride 回傳節點時取代整張 ToolCall，並收到 block 與 historical', () => {
    const block = tool({ name: 'mcp__yeschef__request_handoff', status: 'running' })
    const seen: Array<readonly [ToolBlock, boolean]> = []
    const renderToolOverride = (b: ToolBlock, historical: boolean) => {
      seen.push([b, historical])
      return <div className="fake-handoff">交接 {b.id}</div>
    }
    const { container } = render(
      <Conversation view={viewOf([block])} historical={true} renderToolOverride={renderToolOverride} />
    )
    expect(container.querySelector('.fake-handoff')?.textContent).toBe('交接 tu_1')
    // 整張換掉：預設卡片的任何一塊都不該留下。
    expect(container.querySelector('.tool-call')).toBeNull()
    expect(container.querySelector('.tool-head')).toBeNull()
    expect(seen).toEqual([[block, true]])
  })

  it('renderToolOverride 回傳 undefined 時退回預設的 ToolCall，renderToolExtra 照常生效', () => {
    const { container } = render(
      <Conversation
        view={viewOf([tool({ status: 'awaiting-approval' })])}
        historical={false}
        renderToolOverride={() => undefined}
        renderToolExtra={() => <div className="approval-card">要批准嗎</div>}
      />
    )
    expect(container.querySelector('.tool-call')).not.toBeNull()
    expect(container.querySelector('.tool-status')?.textContent).toBe('等待批准')
    expect(container.querySelector('.tool-extra .approval-card')?.textContent).toBe('要批准嗎')
  })

  // 同一個 turn 裡兩個工具，只有其中一個被接管：逐個 block 判斷，不是整個 turn 一刀切。
  it('renderToolOverride 只接管它認得的那個 block', () => {
    const handoff = tool({ id: 'tu_h', name: 'mcp__yeschef__request_handoff' })
    const bash = tool({ id: 'tu_b', name: 'Bash' })
    const { container } = render(
      <Conversation
        view={viewOf([handoff, bash])}
        historical={false}
        renderToolOverride={(b) => (b.name === 'mcp__yeschef__request_handoff' ? <div className="fake-handoff" /> : undefined)}
      />
    )
    expect(container.querySelectorAll('.fake-handoff')).toHaveLength(1)
    const tools = container.querySelectorAll('.tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.querySelector('.tool-name')?.textContent).toBe('Bash')
  })

  // memo 的比較函式漏了 renderToolOverride 的話，換一個新的 callback 畫面會停在舊結果。
  it('turn 內容不變但 renderToolOverride 換人時要重畫（memo 比較函式不得漏欄位）', () => {
    const view = viewOf([tool({ name: 'mcp__yeschef__request_handoff' })])
    const { container, rerender } = render(
      <Conversation view={view} historical={false} renderToolOverride={() => <div className="fake-handoff">第一版</div>} />
    )
    expect(container.querySelector('.fake-handoff')?.textContent).toBe('第一版')
    rerender(
      <Conversation view={view} historical={false} renderToolOverride={() => <div className="fake-handoff">第二版</div>} />
    )
    expect(container.querySelector('.fake-handoff')?.textContent).toBe('第二版')
  })
```

第四個測試刻意讓 `view` 兩次都是**同一個物件**：turn 的內容完全沒變，唯一變的是 callback 的參考。
memo 的比較函式若漏了這個欄位，`blocksEqual` 會說「一樣」，畫面就停在第一版。

- [ ] **Step 2：跑測試確認失敗**

```bash
npx vitest run tests/conversation.test.tsx
```

實測（worktree `wt-12`）：

```
     × renderToolOverride 回傳節點時取代整張 ToolCall，並收到 block 與 historical 11ms
     × renderToolOverride 只接管它認得的那個 block 5ms
     × turn 內容不變但 renderToolOverride 換人時要重畫（memo 比較函式不得漏欄位） 3ms
 Tests  3 failed | 27 passed (30)
```

第二個新測試（回 `undefined` 退回預設）這時就是綠的：`renderToolOverride` 還不存在，React 會忽略
這個未知的 prop，卡片本來就照畫。它是**回歸護欄**，真正的價值在 Step 13 的突變 3。

- [ ] **Step 3：最小實作（`Turn.tsx`、`Conversation.tsx`）**

`src/renderer/components/Turn.tsx`，第 1 行改成：

```tsx
import { Fragment, memo, useState, type ReactNode } from 'react'
```

第 11 行（`readonly renderToolExtra?: …`）之後、`TurnProps` 的 `}` 之前加一行，並在 `TurnProps`
整段之後加 `RenderOptions`：

```tsx
  /** 回傳非 undefined 時取代預設的 ToolCall（整張卡）。裁決 2（docs/superpowers/plan-b/CONTRACT.md） */
  readonly renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined
}

/**
 * renderBlock 的第三個參數。三個欄位刻意宣告成「必填但可以是 undefined」而不是選填：
 * TurnImpl 直接把解構出來的 props 原樣裝進去就好，不必為了每個可能不存在的 callback
 * 各寫一次條件展開。
 */
interface RenderOptions {
  readonly historical: boolean
  readonly renderToolExtra: ((block: ToolBlock) => ReactNode) | undefined
  readonly renderToolOverride: ((block: ToolBlock, historical: boolean) => ReactNode | undefined) | undefined
}
```

第 33-38 行的 `renderBlock` 簽章（四個參數那份）換成兩行：

```tsx
function renderBlock(block: Block, index: number, opts: RenderOptions) {
  const { historical, renderToolExtra, renderToolOverride } = opts
```

第 44 行的 `case 'tool':` 到它的 `)` 為止，整段換成（多一組大括號讓 `const override` 有自己的作用域）：

```tsx
    case 'tool': {
      // 裁決 2：交接卡不新增 Block 種類，由呼叫端依 block.name 決定要不要整張換掉。
      const override = renderToolOverride?.(block, historical)
      if (override !== undefined) return <Fragment key={index}>{override}</Fragment>
      return (
        <ToolCall
          key={index}
          block={block}
          historical={historical}
          {...(renderToolExtra === undefined ? {} : { renderExtra: renderToolExtra })}
        />
      )
    }
```

`<Fragment key={index}>` 不能省：`renderBlock` 的回傳值直接進 `turn.blocks.map()` 的陣列，React
對陣列元素要 key，而呼叫端給的節點身上不會有。

第 60 行與第 65 行：

```tsx
function TurnImpl({ turn, historical, renderToolExtra, renderToolOverride }: TurnProps) {
  const opts: RenderOptions = { historical, renderToolExtra, renderToolOverride }
```

```tsx
        {turn.blocks.map((block, i) => renderBlock(block, i, opts))}
```

第 75 行（`prev.renderToolExtra === next.renderToolExtra &&`）之後加一行：

```tsx
    prev.renderToolOverride === next.renderToolOverride &&
```

`src/renderer/components/Conversation.tsx`，第 20 行之後加兩行，第 23 行的參數解構拆成多行：

```tsx
  /** 原樣傳給 Turn：回傳非 undefined 時取代預設的 ToolCall（裁決 2）。 */
  readonly renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined
}

export function Conversation({
  view,
  historical,
  renderToolExtra,
  renderToolOverride,
}: ConversationProps) {
```

第 53 行之後加一行，沿用檔案既有的條件展開寫法：

```tsx
          {...(renderToolOverride === undefined ? {} : { renderToolOverride })}
```

- [ ] **Step 4：跑測試確認通過**

```bash
npx vitest run tests/conversation.test.tsx
```

實測（worktree `wt-12`）：

```
 Test Files  1 passed (1)
      Tests  30 passed (30)
```

- [ ] **Step 5：寫失敗的測試（`HandoffCard`）**

新建 `tests/handoff-card.test.tsx`。這一步先寫前三個 `describe`（卡片本身），第四個 `describe`
（App 接線）留到 Step 9。檔案完整內容如下，Step 9 只會在檔尾追加。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  HandoffCard,
  HANDOFF_BUTTON_TEXT,
  HANDOFF_INCOMPLETE_TEXT,
  HANDOFF_NOTIFIED_TEXT,
  HANDOFF_NO_REASON_TEXT,
  HANDOFF_PREPARING_TEXT,
} from '../src/renderer/components/HandoffCard.js'
import { App } from '../src/renderer/App.js'
import { REQUEST_HANDOFF_TOOL } from '../src/shared/view-tools.js'
import type { ToolBlock } from '../src/renderer/components/block-equals.js'
import type { Event } from '../src/shared/events.js'
import type { SessionSummary, YesChefApi } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * 基準時刻刻意不是 0：卡片顯示的是 `now() - mountedAt`，用 0 當基準的話
 * 「忘了減 mountedAt」這個突變會巧合通過（0 減不減都是 0）。
 */
const BASE = 1_764_000_000_000

function block(over: Partial<ToolBlock> = {}): ToolBlock {
  return {
    kind: 'tool',
    id: 'toolu_1',
    name: REQUEST_HANDOFF_TOOL,
    input: { reason: '請幫我登入' },
    status: 'running',
    ...over,
  }
}

function textOf(container: HTMLElement, selector: string): string | undefined {
  return container.querySelector(selector)?.textContent ?? undefined
}

describe('HandoffCard 各狀態的內容（契約 §12 狀態對照表）', () => {
  it('streaming-input：標題加準備交接，沒有理由、等待時間或按鈕', () => {
    const { container } = render(
      <HandoffCard block={block({ status: 'streaming-input', input: undefined })} historical={false} onDone={vi.fn()} />
    )
    expect(textOf(container, '.handoff-card__title')).toBe('交接給使用者')
    expect(textOf(container, '.handoff-card__reason')).toBe(HANDOFF_PREPARING_TEXT)
    expect(container.querySelector('.handoff-card__elapsed')).toBeNull()
    expect(container.querySelector('.handoff-card__button')).toBeNull()
    expect(container.querySelector('.handoff-card__result')).toBeNull()
    expect(container.querySelector('.handoff-card--pending')).not.toBeNull()
  })

  it('running 且非歷史：理由、已等待與按鈕都在，class 是 --pending', () => {
    const { container } = render(
      <HandoffCard block={block()} historical={false} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__reason')).toBe('請幫我登入')
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')
    expect(textOf(container, '.handoff-card__button')).toBe(HANDOFF_BUTTON_TEXT)
    expect(container.querySelector('.handoff-card--pending')).not.toBeNull()
  })

  it('awaiting-approval 且非歷史：與 running 一樣有按鈕', () => {
    const { container } = render(
      <HandoffCard block={block({ status: 'awaiting-approval' })} historical={false} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__button')).toBe(HANDOFF_BUTTON_TEXT)
    expect(container.querySelector('.handoff-card__elapsed')).not.toBeNull()
  })

  it.each([
    ['input 不是物件', 'abc' as unknown],
    ['input 沒有 reason', { note: '無關欄位' } as unknown],
    ['reason 是空字串', { reason: '' } as unknown],
    ['reason 不是字串', { reason: 42 } as unknown],
  ])('理由取不到時用 HANDOFF_NO_REASON_TEXT：%s', (_label, input) => {
    const { container } = render(
      <HandoffCard block={block({ input })} historical={false} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__reason')).toBe(HANDOFF_NO_REASON_TEXT)
  })

  it('running 但 historical：顯示未完成，沒有按鈕也沒有等待時間，class 是 --stale', () => {
    const { container } = render(
      <HandoffCard block={block()} historical={true} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__reason')).toBe('請幫我登入')
    expect(textOf(container, '.handoff-card__result')).toBe(HANDOFF_INCOMPLETE_TEXT)
    expect(container.querySelector('.handoff-card__button')).toBeNull()
    expect(container.querySelector('.handoff-card__elapsed')).toBeNull()
    expect(container.querySelector('.handoff-card--stale')).not.toBeNull()
    expect(container.querySelector('.handoff-card--pending')).toBeNull()
  })

  it('done：結果是 [{ type: text }] 時取 text，class 是 --done', () => {
    const { container } = render(
      <HandoffCard
        block={block({ status: 'done', result: [{ type: 'text', text: '使用者已完成，網址 https://a.test/ok' }] })}
        historical={false}
        onDone={vi.fn()}
      />
    )
    expect(textOf(container, '.handoff-card__result')).toBe('使用者已完成，網址 https://a.test/ok')
    expect(container.querySelector('.handoff-card--done')).not.toBeNull()
    expect(container.querySelector('.handoff-card__button')).toBeNull()
  })

  it.each([
    ['第一個元素不是 text 型別', [{ type: 'image', data: 'x' }], '[\n  {\n    "type": "image",\n    "data": "x"\n  }\n]'],
    ['結果不是陣列', { ok: true }, '{\n  "ok": true\n}'],
  ])('done：%s 時退回 formatValue', (_label, result, expected) => {
    const { container } = render(
      <HandoffCard block={block({ status: 'done', result })} historical={false} onDone={vi.fn()} />
    )
    expect(textOf(container, '.handoff-card__result')).toBe(expected)
  })

  it('error：class 加 --error，結果文字照樣顯示', () => {
    const { container } = render(
      <HandoffCard
        block={block({ status: 'error', result: [{ type: 'text', text: '交接逾時' }] })}
        historical={false}
        onDone={vi.fn()}
      />
    )
    expect(container.querySelector('.handoff-card--error')).not.toBeNull()
    expect(textOf(container, '.handoff-card__result')).toBe('交接逾時')
  })

  it('denied：有 deniedReason 用它，沒有時用「已拒絕」', () => {
    const withReason = render(
      <HandoffCard block={block({ status: 'denied', deniedReason: '使用者按了拒絕' })} historical={false} onDone={vi.fn()} />
    )
    expect(textOf(withReason.container, '.handoff-card__result')).toBe('使用者按了拒絕')
    cleanup()
    const without = render(<HandoffCard block={block({ status: 'denied' })} historical={false} onDone={vi.fn()} />)
    expect(textOf(without.container, '.handoff-card__result')).toBe('已拒絕')
  })
})
```

接著兩個 `describe`（按鈕與計時器）：

```tsx
describe('HandoffCard 的「我好了」按鈕', () => {
  it('按一下用 block.id 呼叫 onDone，按鈕變成停用的已通知', () => {
    const onDone = vi.fn()
    const { container } = render(
      <HandoffCard block={block({ id: 'toolu_abc' })} historical={false} onDone={onDone} now={() => BASE} />
    )
    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    fireEvent.click(button)
    expect(onDone.mock.calls).toEqual([['toolu_abc']])
    expect(button.textContent).toBe(HANDOFF_NOTIFIED_TEXT)
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  /**
   * 兩次點擊在同一個批次裡送出：React 還沒重畫，`disabled` 還沒掛上去，
   * handler 讀到的 `notified` 也還是這一輪的 false。只靠這兩者都擋不住，
   * 卡片必須自己記住已經送過了。用 fireEvent 連點兩次測不到這件事：
   * fireEvent 之間 React 已經重畫，jsdom 對停用的按鈕根本不發第二個 click。
   */
  it('同一批次連按兩次只呼叫一次 onDone', () => {
    const onDone = vi.fn()
    const { container } = render(
      <HandoffCard block={block({ id: 'toolu_abc' })} historical={false} onDone={onDone} now={() => BASE} />
    )
    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls).toEqual([['toolu_abc']])
  })
})

describe('HandoffCard 的已等待時間每 30 秒重算', () => {
  let current = BASE
  const now = (): number => current

  beforeEach(() => {
    current = BASE
    vi.useFakeTimers()
  })

  it('未滿 30 秒不重算，滿 30 秒才重算', () => {
    const { container } = render(<HandoffCard block={block()} historical={false} onDone={vi.fn()} now={now} />)
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')

    // 時鐘已經走過一分半，但計時器還差 1 毫秒沒到期：畫面必須還是舊值。
    current = BASE + 90_000
    act(() => {
      vi.advanceTimersByTime(29_999)
    })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 1 分鐘')

    // 第二次到期要再重算一次，證明是週期性的而不是只跑一次。
    current = BASE + 3 * 60_000
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 3 分鐘')
  })

  it('historical 的等待中卡片不排計時器', () => {
    render(<HandoffCard block={block()} historical={true} onDone={vi.fn()} now={now} />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('done 的卡片不排計時器', () => {
    render(<HandoffCard block={block({ status: 'done', result: [] })} historical={false} onDone={vi.fn()} now={now} />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卸載後計時器要清掉', () => {
    const { unmount } = render(<HandoffCard block={block()} historical={false} onDone={vi.fn()} now={now} />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

計時器那個測試的三段推進不能合併。`29_999` 那一段擋住「間隔比 30 秒短」的實作，
`+1` 那一段擋住「間隔比 30 秒長」與「乾脆沒排計時器」，最後一段擋住「只用 `setTimeout` 跑一次」。
時鐘的推進與計時器的推進刻意脫鉤（`current` 直接跳到 `BASE + 90_000`，計時器只走 29_999 毫秒），
不然「顯示的是計時器走過的時間」這個錯誤實作會巧合同值。

- [ ] **Step 6：跑測試確認失敗**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`，`HandoffCard.tsx` 還不存在）：

```
 FAIL  tests/handoff-card.test.tsx [ tests/handoff-card.test.tsx ]
Error: Failed to resolve import "../src/renderer/components/HandoffCard.js" from "tests/handoff-card.test.tsx". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 7：最小實作（`HandoffCard.tsx`）**

新建 `src/renderer/components/HandoffCard.tsx`（169 行）：

```tsx
import { useEffect, useRef, useState } from 'react'
import { formatElapsed } from './relative-time.js'
import { formatValue } from './ToolCall.js'
import type { ToolBlock } from './block-equals.js'
import './HandoffCard.css'

export interface HandoffCardProps {
  readonly block: ToolBlock
  readonly historical: boolean
  readonly onDone: (toolUseId: string) => void
  /** 測試注入；預設 Date.now。 */
  readonly now?: () => number
}

export const HANDOFF_BUTTON_TEXT = '我好了'
export const HANDOFF_NOTIFIED_TEXT = '已通知'
export const HANDOFF_INCOMPLETE_TEXT = '未完成（對話中途結束）'
export const HANDOFF_PREPARING_TEXT = '準備交接…'
export const HANDOFF_NO_REASON_TEXT = '（未說明理由）'

const TITLE_TEXT = '交接給使用者'
const DENIED_FALLBACK_TEXT = '已拒絕'

/**
 * 已等待文字的重算間隔（契約 §12）。formatElapsed 的最小刻度是一分鐘，
 * 30 秒讓跨分鐘那一刻最多晚半分鐘才顯示，而每分鐘只醒兩次。
 */
const TICK_MS = 30_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `input.reason` 是非空字串才用，其餘一律 HANDOFF_NO_REASON_TEXT（契約 §12）。 */
function reasonOf(input: unknown): string {
  if (!isRecord(input)) return HANDOFF_NO_REASON_TEXT
  const reason = input.reason
  return typeof reason === 'string' && reason !== '' ? reason : HANDOFF_NO_REASON_TEXT
}

/** 契約 §12：result 是陣列且第一個元素是 `{ type: 'text', text }` 時取 text，否則 formatValue。 */
function resultTextOf(result: unknown): string {
  if (!Array.isArray(result)) return formatValue(result)
  const first: unknown = result[0]
  if (!isRecord(first)) return formatValue(result)
  if (first.type !== 'text' || typeof first.text !== 'string') return formatValue(result)
  return first.text
}

/**
 * 卡片的六種樣貌。把 `status` 與 `historical` 兩個輸入先併成一個 phase，
 * 之後每一塊內容都只問 phase 一次，不必在 JSX 裡到處重複同一組布林運算。
 */
type Phase = 'preparing' | 'pending' | 'stale' | 'done' | 'error' | 'denied'

function phaseOf(status: ToolBlock['status'], historical: boolean): Phase {
  switch (status) {
    case 'streaming-input':
      return 'preparing'
    case 'running':
    case 'awaiting-approval':
      return historical ? 'stale' : 'pending'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'denied':
      return 'denied'
  }
}

/** 裁決 25：契約 §12 只給四個 modifier，denied 與 error 共用 --error，preparing 與等待中共用 --pending。 */
const MODIFIER: Record<Phase, string> = {
  preparing: 'pending',
  pending: 'pending',
  stale: 'stale',
  done: 'done',
  error: 'error',
  denied: 'error',
}

function resultOf(phase: Phase, block: ToolBlock): string | undefined {
  switch (phase) {
    case 'preparing':
    case 'pending':
      return undefined
    case 'stale':
      return HANDOFF_INCOMPLETE_TEXT
    case 'denied':
      return block.deniedReason ?? DENIED_FALLBACK_TEXT
    case 'done':
    case 'error':
      return resultTextOf(block.result)
  }
}

/**
 * `request_handoff` 的專用工具卡（裁決 2，docs/superpowers/plan-b/CONTRACT.md）。
 *
 * 「已等待」不是每秒重畫，也不是只在父層重繪時才更新：卡片自己排一個 30 秒的
 * interval，只有 `pending`（進行中且不是歷史對話）才排。歷史對話的交接永遠不會
 * 有下文，讓它繼續數秒數只會騙人，也會在使用者翻舊對話時留一堆醒著的計時器。
 *
 * `mountedAt` 用惰性初始值取一次就不再變：交接的起算點是卡片出現的時刻，
 * 每次重畫都重取會讓等待時間永遠停在「不到 1 分鐘」。
 */
export function HandoffCard({ block, historical, onDone, now = Date.now }: HandoffCardProps) {
  const phase = phaseOf(block.status, historical)
  const [mountedAt] = useState<number>(now)
  const [tick, setTick] = useState<number>(now)
  const [notified, setNotified] = useState<boolean>(false)
  // 已通知的旗標要另外用 ref 記一份：同一個批次裡送進來的第二次點擊，讀到的
  // `notified` 還是這一輪 render 的 false，只靠 state 擋不住（disabled 也還沒掛上去）。
  const notifiedRef = useRef<boolean>(false)

  // now 放進 ref：呼叫端若每次重畫都給一個新的函式（App 沒有，但測試與未來的呼叫端
  // 可能會），interval 不該因此被拆掉重排，否則永遠等不到第一次 30 秒。
  const nowRef = useRef<() => number>(now)
  useEffect(() => {
    nowRef.current = now
  }, [now])

  useEffect(() => {
    if (phase !== 'pending') return undefined
    const id = setInterval(() => {
      setTick(nowRef.current())
    }, TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [phase])

  /**
   * 主程序對同一個 toolUseId 只認第一次通知，第二次會記一筆「找不到 pending」的
   * 錯誤。卡片自己擋住連按，畫面上也才看得出第一次已經送出去了。
   */
  const done = (): void => {
    if (notifiedRef.current) return
    notifiedRef.current = true
    setNotified(true)
    onDone(block.id)
  }

  const result = resultOf(phase, block)

  return (
    <div
      className={`handoff-card handoff-card--${MODIFIER[phase]}`}
      role="group"
      aria-label="交接給使用者"
      data-testid="handoff-card"
      data-tool-use-id={block.id}
    >
      <p className="handoff-card__title">{TITLE_TEXT}</p>
      <p className="handoff-card__reason">
        {phase === 'preparing' ? HANDOFF_PREPARING_TEXT : reasonOf(block.input)}
      </p>
      {phase === 'pending' && (
        <p className="handoff-card__elapsed">已等待 {formatElapsed(tick - mountedAt)}</p>
      )}
      {result !== undefined && <p className="handoff-card__result">{result}</p>}
      {phase === 'pending' && (
        <button type="button" className="handoff-card__button" disabled={notified} onClick={done}>
          {notified ? HANDOFF_NOTIFIED_TEXT : HANDOFF_BUTTON_TEXT}
        </button>
      )}
    </div>
  )
}
```

`useState<number>(now)` 這個寫法是把 `now` 本身當惰性初始化函式傳給 `useState`，React 只在第一次
render 呼叫它一次。`useState(now())` 會每次重畫都算一遍（雖然結果被丟掉），意思一樣但多做事。

新建 `src/renderer/components/HandoffCard.css`（74 行）。`ApprovalCard.css` 一個字不動，
兩張卡各管各的：

```css
/* request_handoff 的專用卡片（契約 §12）。ApprovalCard.css 不動，兩張卡各自管自己的樣式。 */

.handoff-card {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid #2a6a7a;
  border-left-width: 3px;
  border-radius: 4px;
  background: #101a1c;
}

/* 還在等使用者：邊框亮一點，這是畫面上唯一在等人動作的東西。 */
.handoff-card--pending {
  border-color: #58a9c9;
}

/* 歷史對話裡沒有下文的交接。 */
.handoff-card--stale {
  border-color: #4a4d40;
  opacity: 0.75;
}

.handoff-card--done {
  border-color: #3f7a4a;
}

.handoff-card--error {
  border-color: #8a4a2a;
}

.handoff-card__title {
  margin: 0 0 4px;
  font-weight: 600;
}

.handoff-card__reason {
  margin: 0 0 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

.handoff-card__elapsed {
  margin: 0 0 8px;
  font-size: 0.85em;
  opacity: 0.7;
}

.handoff-card__result {
  margin: 0 0 6px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

.handoff-card__button {
  padding: 4px 12px;
  border: 1px solid #4a4d40;
  border-radius: 3px;
  background: #23261c;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.handoff-card__button:hover:not(:disabled) {
  background: #2d3124;
}

.handoff-card__button:disabled {
  cursor: default;
  opacity: 0.6;
}
```

`.handoff-card__result` 用 `<p>` 加 `white-space: pre-wrap`，不用 `<pre>`：同一個位置要輪流裝
`HANDOFF_INCOMPLETE_TEXT`、`deniedReason` 與 JSON 三種東西，換標籤等於多一個分支。三段文字各自
落在哪個 class 依裁決 25。

- [ ] **Step 8：跑測試確認通過**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`，這時第四個 `describe` 還沒寫）：

```
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

- [ ] **Step 9：寫失敗的測試（App 接線）**

在 `tests/handoff-card.test.tsx` 檔尾追加假 api 與第四個 `describe`：

```tsx
/** App 只認 window.yeschef，這裡給一份剛好夠用的假 api。 */
function createFakeApi(): {
  readonly api: YesChefApi
  readonly handoffDone: ReturnType<typeof vi.fn>
  emit(events: readonly Event[]): void
} {
  const listeners = new Set<(events: readonly Event[]) => void>()
  const handoffDone = vi.fn()
  const api: YesChefApi = {
    onEvents: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    onApprovalAsk: () => () => undefined,
    onSessionState: () => () => undefined,
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: (): Promise<readonly SessionSummary[]> => Promise.resolve([]),
    startNew: () => undefined,
    openHistory: () => undefined,
    handoffDone,
    projectDir: '/Users/x/Projects/demo',
  }
  return {
    api,
    handoffDone,
    emit: (events) => {
      act(() => {
        for (const l of listeners) l(events)
      })
    },
  }
}

const HANDOFF_EVENT: Event = {
  kind: 'tool-use',
  messageId: 'msg_1',
  index: 0,
  id: 'toolu_h1',
  name: REQUEST_HANDOFF_TOOL,
  input: { reason: '請登入這個網站' },
}

const BASH_EVENT: Event = {
  kind: 'tool-use',
  messageId: 'msg_1',
  index: 1,
  id: 'toolu_b1',
  name: 'Bash',
  input: { command: 'ls' },
}

describe('App 把 request_handoff 的工具卡換成 HandoffCard', () => {
  it('交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emit([{ kind: 'message-start', messageId: 'msg_1' }, HANDOFF_EVENT, BASH_EVENT])

    expect(container.querySelectorAll('.handoff-card')).toHaveLength(1)
    expect(textOf(container, '.handoff-card__reason')).toBe('請登入這個網站')
    // 非交接工具不受影響：Bash 那一格照樣是 ToolCall。
    const tools = container.querySelectorAll('.tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.querySelector('.tool-name')?.textContent).toBe('Bash')
  })

  it('按下「我好了」呼叫 api.handoffDone 並帶上 tool use id', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emit([{ kind: 'message-start', messageId: 'msg_1' }, HANDOFF_EVENT])

    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    fireEvent.click(button)
    expect(fake.handoffDone.mock.calls).toEqual([['toolu_h1']])
  })
})
```

第一個測試同一輪放兩個工具而不是只放交接那一個：只放一個的話，「所有工具都換成 HandoffCard」
這個突變照樣全綠（見 Step 13 的突變 4）。

- [ ] **Step 10：跑測試確認失敗**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`，`App.tsx` 還沒接）：

```
     × 交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall
     × 按下「我好了」呼叫 api.handoffDone 並帶上 tool use id
       Error: 找不到按鈕
 Tests  2 failed | 19 passed (21)
```

- [ ] **Step 11：最小實作（`App.tsx`）**

`src/renderer/App.tsx`，第 3 行之後加一行、第 9 行之後加一行：

```tsx
import { HandoffCard } from './components/HandoffCard.js'
```

```tsx
import { REQUEST_HANDOFF_TOOL } from '../shared/view-tools.js'
```

第 87 行（`App` 檔頭註解裡 ` * 標題列（Task 11，裁決 21）：` 那一行）之前插入：

```tsx
 * 交接卡（Task 12，裁決 2）：`renderToolOverride` 只認工具名稱，fold.ts 不必知道
 * 有交接這回事。回 undefined 的那條路就是「這個工具沒有專用卡」，Conversation
 * 照樣畫預設的 ToolCall。
 *
```

第 109 行（`renderToolExtra` 的 `useCallback` 結尾 `)`）之後加：

```tsx

  const renderToolOverride = useCallback(
    (block: ToolBlock, historical: boolean) =>
      block.name === REQUEST_HANDOFF_TOOL ? (
        <HandoffCard block={block} historical={historical} onDone={api.handoffDone} />
      ) : undefined,
    [api]
  )
```

第 128 行（`renderToolExtra={renderToolExtra}`）之後加一行：

```tsx
          renderToolOverride={renderToolOverride}
```

依賴陣列是 `[api]` 而不是 `[]`：`api.handoffDone` 是從 `window.yeschef` 取的，`api` 換了就要重建。
`api` 在真實環境永遠是同一個物件，所以這個 callback 實際上不會重建，`Turn` 的 memo 擋得住。

`api.handoffDone` 直接當成函式參考傳出去，不用 `(id) => api.handoffDone(id)` 包一層：preload 的
`handoffDone` 是物件字面值裡的箭頭函式，沒有用到 `this`，跟既有的 `onOpen={api.openHistory}` 同一種
寫法。

三個 Plan A 測試檔（`app-title-bar`、`use-approvals`、`use-conversation`）手刻的假 `YesChefApi`
少了必填的 `handoffDone`（契約 §11.3、裁決 23），補樁由 Task 11 負責，執行順序在本 task 之前，
這裡不動那三個檔案。

- [ ] **Step 12：跑測試確認通過**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`）：

```
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

整個套件與型別檢查（`npx vitest run` 的基準是 Task 11 之後的 489 個測試；本 task 加 25 個）：

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
```

```
 Test Files  26 passed (26)
      Tests  514 passed (514)
```

`tsc --noEmit` 0 error（前提是 Task 11 已補上三個 Plan A 測試檔的 `handoffDone` 樁）。

覆蓋率（`npx vitest run --coverage`）：

```
All files          |   93.44 |    87.08 |   95.87 |   95.58
```

Stmts 93.44 ≥ 93、Branch 87.08 ≥ 86，符合契約 §14 的判準。`HandoffCard.tsx` 與 `Turn.tsx` 沒出現在
覆蓋率表裡：報表設了 `skipFull`，四項都 100% 的檔案不列。

- [ ] **Step 13：突變測試**

七個突變，全部在 worktree `wt-12` 實測，每個跑完立刻還原並確認回綠。

**突變 1（`HandoffCard.tsx`）：`phaseOf` 忽略 `historical`。**

```tsx
    case 'running':
    case 'awaiting-approval':
      return 'pending'          // 突變：原本是 historical ? 'stale' : 'pending'
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅兩個：

```
     × running 但 historical：顯示未完成，沒有按鈕也沒有等待時間，class 是 --stale
     × historical 的等待中卡片不排計時器
 Tests  2 failed | 19 passed (21)
```

歷史對話裡冒出一顆能按的「我好了」按鈕，是這張卡最糟的失效方式：那次交接的 pending 早就不存在，
按下去只會在主程序留一筆假錯誤。還原後 `21 passed (21)`。

**突變 2（`HandoffCard.tsx`）：拿掉 `notifiedRef` 這道 guard，只留 state 與 `disabled`。**

```tsx
  const done = (): void => {
    setNotified(true)         // 突變：拿掉 notifiedRef.current 的判斷與設值
    onDone(block.id)
  }
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 同一批次連按兩次只呼叫一次 onDone
 Tests  1 failed | 20 passed (21)
```

**這個突變是本 task 最重要的一個發現。** 第一版的實作寫的是 `if (notified) return`（讀 state），
測試寫的是 `fireEvent.click(button)` 連按三次，跑這個突變**全綠**：`fireEvent` 之間 React 已經重畫，
按鈕變成 `disabled`，jsdom 對停用的表單控制項根本不發第二個 click，測試從頭到尾只點得到一次。
而且讀 state 的 guard 對真正的雙擊（同一個批次、`notified` 還是 `false`）也擋不住。修法是兩邊都改：
實作改用 `notifiedRef`（依裁決 25），測試改成在同一個 `act` 內連發兩個 `MouseEvent`。
還原後 `21 passed (21)`。

**突變 3（`Turn.tsx`）：override 的判斷改看 callback 存不存在，而不是看回傳值。**

```tsx
      const override = renderToolOverride?.(block, historical)
      if (renderToolOverride !== undefined) return <Fragment key={index}>{override}</Fragment>
```

```bash
npx vitest run tests/conversation.test.tsx tests/handoff-card.test.tsx
```

變紅三個：

```
     × 交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall
     × renderToolOverride 回傳 undefined 時退回預設的 ToolCall，renderToolExtra 照常生效
     × renderToolOverride 只接管它認得的那個 block
 Tests  3 failed | 48 passed (51)
```

這是接法本身最容易寫錯的一步：App 一掛上 callback，畫面上所有工具卡就全部變空白。
還原後 `51 passed (51)`。

**突變 4（`App.tsx`）：不看工具名稱，每個工具都換成 HandoffCard。**

```tsx
  const renderToolOverride = useCallback(
    (block: ToolBlock, historical: boolean) => (
      <HandoffCard block={block} historical={historical} onDone={api.handoffDone} />
    ),
    [api]
  )
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall
 Tests  1 failed | 20 passed (21)
```

那個測試的 turn 裡刻意放了 Bash 與 request_handoff 兩個工具。只放一個交接工具的話，這個突變
會全綠：`.handoff-card` 找得到、理由也對，斷言全部命中，錯誤實作照樣通過。還原後 `21 passed (21)`。

**突變 5（`HandoffCard.tsx`）：`TICK_MS` 從 `30_000` 改成 `1_000`。**

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 未滿 30 秒不重算，滿 30 秒才重算
 Tests  1 failed | 20 passed (21)
```

推進 29_999 毫秒那一段擋住了它：間隔一秒的話畫面早就更新成「1 分鐘」。契約 §12 寫的是 30 秒，
只測「會更新」不測「什麼時候更新」的話，這個數字等於沒有被任何測試釘住。還原後 `21 passed (21)`。

**突變 6（`HandoffCard.tsx`）：`mountedAt` 每次重畫都重取。**

```tsx
  const mountedAt = now()      // 突變：原本是 const [mountedAt] = useState<number>(now)
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 未滿 30 秒不重算，滿 30 秒才重算
 Tests  1 failed | 20 passed (21)
```

`tick` 與 `mountedAt` 同時前進，差永遠是 0，等待時間永遠停在「不到 1 分鐘」。基準時刻用
`BASE = 1_764_000_000_000` 而不是 0，才擋得住另一種變體（忘了減 `mountedAt`、直接顯示
`formatElapsed(tick)`）：用 0 當基準的話兩者巧合同值。還原後 `21 passed (21)`。

**突變 7（`Turn.tsx`）：memo 比較函式漏掉 `renderToolOverride`。**

```tsx
    prev.renderToolExtra === next.renderToolExtra &&
    // 突變：刪掉 prev.renderToolOverride === next.renderToolOverride &&
    prev.turn.role === next.turn.role &&
```

```bash
npx vitest run tests/conversation.test.tsx tests/handoff-card.test.tsx
```

變紅：

```
     × turn 內容不變但 renderToolOverride 換人時要重畫（memo 比較函式不得漏欄位）
 Tests  1 failed | 50 passed (51)
```

還原後 `51 passed (51)`。

七個突變全部還原後跑一次完整套件確認沒有殘留：

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git diff --stat
```

```
 Test Files  26 passed (26)
      Tests  514 passed (514)
```

`git diff --stat` 只剩下本 task 與上游 Task 0／11 的檔案改動，沒有任何突變殘留。

- [ ] **Step 14：提交**

```bash
git add \
  src/renderer/components/HandoffCard.tsx \
  src/renderer/components/HandoffCard.css \
  src/renderer/components/Turn.tsx \
  src/renderer/components/Conversation.tsx \
  src/renderer/App.tsx \
  tests/handoff-card.test.tsx \
  tests/conversation.test.tsx
git commit -m "feat: 交接卡與 renderToolOverride"
```

---

### Task 13: session options 帶 mcpServers、agent-host autoAllow、ipc-bridge 接 viewTools

這個 task 把 `src/main/view-tools/` 接進既有的三條線：query 的 options 要帶 MCP server、`canUseTool` 要能跳過政策放行的工具、bridge 要接 `handoff:done` 這條 IPC 並在收尾時中止等待中的工具。三處都是既有檔案的小改動，共同點是「沒有 view tools 時行為與子專案 A 完全相同」：`mcpServers` 沒給就不出現在 options 物件裡、`autoAllow` 沒給就不出現在 host 的 deps 裡、`viewTools` 沒給就沒有 `abortPending` 呼叫。既有的 65 個測試一個都不改，這是本 task 的主要驗收條件。

三個「不出現這個 key」不是潔癖。`session-options.test.ts` 與 `agent-host.test.ts` 都有拿整個物件做 `toEqual`／`toMatchObject` 的斷言，多一個值為 `undefined` 的欄位會讓它們變紅；更麻煩的是 SDK 的 `Options.mcpServers` 是 `Record<string, McpServerConfig>`，傳 `undefined` 進去的語意沒有寫在型別註解裡，不如根本不傳。實作用條件展開 `...(x === undefined ? {} : { x })`，與 `session-args.ts` 既有的 `resume` 同一個寫法。

`autoAllow` 的位置只有一個正確答案：`requestApproval` 之前。放在之後等於批准卡已經送到 renderer，使用者看到一張卡片、程式卻自己決定放行，畫面與行為是兩套答案。`autoAllow` 丟例外時往批准流程倒而不是往 allow 倒：一個政策函式的 bug 不該變成自動放行，也不該中斷整條 query（`canUseTool` 若 reject，SDK 那一側的行為不在契約裡）。這一段自己一個 `try`，不與批准流程的 `try` 合併，否則例外會被下面那個 catch 接住而變成 deny，與契約說的「視同 false」不同。

`abortPending` 排在 `host.teardown()` 與 `host.interrupt()` 之前（裁決 11）。順序反過來會死結：teardown 要等 SDK 把進行中的 tool call 收完，而那個 tool call 正卡在一個 `handoff` 或 `settle` 的等待上，等的就是這一句 `abortPending`。`interrupt-query` 也要，理由是使用者換對話時進行中的等待沒有人會再回應它。這裡用 `runEffect` 的 switch 而不是包在 `host` 裡：agent-host 不認識 view tools，這是規格 §7「AbortSignal 從 agent-host 的 teardown 傳進 controller」被裁決 11 改掉的地方。

`ViewToolHooks` 用 `Pick<ViewTools, ...>` 而不是重寫一份三個方法的介面：Task 10 改 `ViewTools` 的簽章時，這裡會直接過不了 typecheck，而不是安靜地漂移。bridge 只需要三個方法，`dispose()` 由 `index.ts` 收（Task 14），`server` 由 `session-options` 收。

**前置：** Task 0（`src/main/view-tools/errors.ts` 的 `MSG`）、Task 10（`src/main/view-tools/server.ts` 的 `ViewTools` 型別）、Task 11（`src/shared/ipc.ts` 的 `IPC.handoffDone`、`parseHandoffDone`）必須先完成，本 task 直接 import 它們。

**Files:**

- Modify `src/main/session-args.ts`（第 1 到 2 行加 import；`SessionArgsInput` 第 4 到 11 行加一個欄位；`SessionOptions` 第 13 到 24 行加一個欄位；`buildSessionOptions` 的 return 第 66 到 71 行加一行條件展開）
- Modify `src/main/session-options.ts`（第 1 行加 import；`createSessionOptionsFactory` 第 14 到 26 行加第四個參數並往下傳）
- Modify `src/main/agent-host.ts`（`AgentHostDeps` 第 295 到 307 行加 `autoAllow?`；`canUseTool` 第 385 到 404 行在開頭加一段）
- Modify `src/main/ipc-bridge.ts`（第 5 到 12 行的 ipc import 加 `parseHandoffDone`；第 24 到 25 行後加兩個 import 與 `ViewToolHooks`；`IpcBridgeDeps` 第 41 到 58 行加 `viewTools?`；`createIpcBridge` 第 64 到 66 行加區域變數；`ensureHost` 第 148 到 161 行傳 `autoAllow`；`runEffect` 第 163 到 203 行的 `interrupt-query` 與 `teardown-query` 分支；第 308 行 `onIntentStartNew` 之前加 `onHandoffDone`；`dispose` 第 332 到 347 行解除監聽；第 349 到 353 行註冊監聽）
- Test `tests/session-options.test.ts`（加 import 與一個 describe，四個案例）
- Test `tests/agent-host.test.ts`（`setupHost` 加一個 override，加一個 describe，四個案例）
- Test `tests/ipc-bridge.test.ts`（`Rig` 與 `setup` 加假 viewTools，加一個 describe，八個案例）

**Interfaces:**

Consumes：
- Task 0 `src/main/view-tools/errors.ts`：`MSG.sessionEnded`（值為 `'對話已結束'`）
- Task 10 `src/main/view-tools/server.ts`：`export interface ViewTools { readonly server: McpSdkServerConfigWithInstance; autoAllow(toolName: string, toolUseId: string): boolean; handoffDone(toolUseId: string): void; abortPending(reason: string): void; dispose(): Promise<void> }`
- Task 11 `src/shared/ipc.ts`：`IPC.handoffDone`（值為 `'handoff:done'`）、`export function parseHandoffDone(raw: unknown): HandoffDonePayload | null`、`export interface HandoffDonePayload { readonly toolUseId: string }`
- SDK：`import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'`

Produces（Task 14 的 `index.ts` 接線依賴這三個簽章）：
```ts
// src/main/session-options.ts
export function createSessionOptionsFactory(
  projectDir: string,
  appDir: string,
  sessions: Pick<SessionStore, 'cwdOf'>,
  mcpServers?: Readonly<Record<string, McpServerConfig>>
): (resumeSessionId?: string) => SessionOptions
// src/main/agent-host.ts
export interface AgentHostDeps { /* 既有欄位不變 */ readonly autoAllow?: (toolName: string, toolUseId: string) => boolean }
// src/main/ipc-bridge.ts
export type ViewToolHooks = Pick<ViewTools, 'autoAllow' | 'handoffDone' | 'abortPending'>
export interface IpcBridgeDeps { /* 既有欄位不變 */ readonly viewTools?: ViewToolHooks }
```

---

## A 組：session options 帶 mcpServers

- [ ] **Step A1: 寫失敗的測試**

在 `tests/session-options.test.ts` 第 5 行的 import 上面補一行：

```ts
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
```

再把以下整段接在檔案最後（既有的三個案例與 `beforeEach` 都不動）：

```ts
/** 假的 MCP server config：型別上是合法的 stdio 設定，內容不會被執行。 */
const FAKE_SERVER: McpServerConfig = { type: 'stdio', command: 'noop' }
const SERVERS: Readonly<Record<string, McpServerConfig>> = { yeschef: FAKE_SERVER }

describe('契約 §11.1：mcpServers 只在給了的時候出現', () => {
  it('沒給 mcpServers 時 options 連這個 key 都沒有', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir))
    expect('mcpServers' in factory()).toBe(false)
    expect('mcpServers' in factory('s-old')).toBe(false)
  })

  it('給了 mcpServers 時原樣帶進 options', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir), SERVERS)
    const options = factory()
    expect('mcpServers' in options).toBe(true)
    expect(options.mcpServers).toBe(SERVERS)
  })

  it('resume 時 mcpServers 一樣帶著，且不影響 cwd 與 resume 的選擇', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir), SERVERS)
    const options = factory('s-old')
    expect(options.mcpServers).toEqual({ yeschef: FAKE_SERVER })
    expect(options.cwd).toBe(otherDir)
    expect(options.resume).toBe('s-old')
  })

  it('工廠每次呼叫都帶同一份 mcpServers，不是只有第一次', () => {
    const factory = createSessionOptionsFactory(projectDir, appDir, storeReturning(otherDir), SERVERS)
    factory()
    expect(factory('s-2').mcpServers).toBe(SERVERS)
    expect(factory().mcpServers).toBe(SERVERS)
  })
})
```

第一個案例用 `'mcpServers' in options` 而不是 `toBeUndefined()`：後者對「key 存在但值是 undefined」也會通過，那正是要擋的實作。第四個案例呼叫三次工廠：`mcpServers` 若被實作成只在第一次閉包裡取值（例如誤寫成某種一次性快取），第二、三次就會漏掉。

- [ ] **Step A2: 跑測試確認失敗**

```bash
npx vitest run tests/session-options.test.ts
```

預期：`tsc` 層面就過不了（`createSessionOptionsFactory` 只收三個參數），vitest 會在四個新案例都報 `Expected 3 arguments, but got 4` 或執行期 `options.mcpServers` 為 `undefined`。既有三個案例仍然通過。

- [ ] **Step A3: 最小實作**

`src/main/session-args.ts`，在第 2 行 `import { resolve, sep } from 'node:path'` 之後加：

```ts
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
```

`SessionArgsInput` 的 `resumeSessionId` 之後加：

```ts
  /**
   * 程序內 MCP server。子專案 B 由 `index.ts` 傳入 `{ yeschef: viewTools.server }`。
   * 沒給時輸出的 `SessionOptions` 完全不帶 `mcpServers` 這個 key（契約 §11.1）。
   */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>
```

`SessionOptions` 的 `resume?: string` 之後加：

```ts
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>
```

`buildSessionOptions` 的 return，在 `resume` 那一行之後加：

```ts
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
```

`src/main/session-options.ts` 第 1 行之前加 import，並改工廠簽章：

```ts
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { buildSessionOptions, type SessionOptions } from './session-args.js'
import type { SessionStore } from './session-store.js'
```

```ts
export function createSessionOptionsFactory(
  projectDir: string,
  appDir: string,
  sessions: Pick<SessionStore, 'cwdOf'>,
  mcpServers?: Readonly<Record<string, McpServerConfig>>
): (resumeSessionId?: string) => SessionOptions {
  return (resumeSessionId) =>
    buildSessionOptions({
      projectDir:
        (resumeSessionId === undefined ? undefined : sessions.cwdOf(resumeSessionId)) ?? projectDir,
      appDir,
      resumeSessionId,
      mcpServers,
    })
}
```

工廠這裡把 `mcpServers` 無條件寫進 `buildSessionOptions` 的參數物件（值可能是 `undefined`）：`tsconfig.json` 沒開 `exactOptionalPropertyTypes`，這樣合法，而「不帶 key」的責任集中在 `buildSessionOptions` 一處，不散成兩處。

- [ ] **Step A4: 跑測試確認通過**

```bash
npx vitest run tests/session-options.test.ts
npx tsc --noEmit
```

預期：7 passed（既有 3 + 新增 4），tsc 無輸出。

---

## B 組：agent-host 的 autoAllow

- [ ] **Step B1: 寫失敗的測試**

`tests/agent-host.test.ts` 的 `setupHost`（約第 160 行）加一個 override 並往 `createAgentHost` 傳。改兩處：

```ts
function setupHost(overrides?: {
  requestApproval?: (ask: ApprovalAsk) => Promise<{ decision: 'allow' | 'deny'; reason?: string }>
  autoStart?: false
  /** 契約 §11.2：政策放行。沒給時等同 host 沒收到這個 dep。 */
  autoAllow?: (toolName: string, toolUseId: string) => boolean
}) {
```

```ts
    merge: CFG,
    clock,
    autoAllow: overrides?.autoAllow,
  })
  if (overrides?.autoStart !== false) host.start()
```

再把以下整段插在 `describe('createAgentHost：錯誤不靜默', ...)` 之前：

```ts
describe('契約 §11.2：autoAllow 讓政策放行的工具跳過批准流程', () => {
  it('回 true 時直接 allow，requestApproval 完全沒被呼叫', async () => {
    const asked: ApprovalAsk[] = []
    const s = setupHost({
      // 刻意回 deny：autoAllow 若被移到批准流程之後才問，結果會變成 deny。
      requestApproval: (ask) => {
        asked.push(ask)
        return Promise.resolve({ decision: 'deny' as const, reason: '不該走到這裡' })
      },
      autoAllow: () => true,
    })
    const result = await s.canUseTool()!(
      'mcp__yeschef__view_click',
      { ref: 's1-e2' },
      { toolUseID: 'toolu_click' }
    )
    expect(result).toEqual({ behavior: 'allow', updatedInput: { ref: 's1-e2' } })
    expect(asked).toEqual([])
    expect(s.errors).toEqual([])
    s.fq.end()
    await s.host.teardown()
  })

  it('autoAllow 拿得到工具名稱與這一次的 toolUseId', async () => {
    const seen: [string, string][] = []
    const s = setupHost({
      autoAllow: (name, id) => {
        seen.push([name, id])
        return name === 'mcp__yeschef__view_click'
      },
    })
    await s.canUseTool()!('mcp__yeschef__view_click', {}, { toolUseID: 'toolu_a' })
    await s.canUseTool()!('mcp__yeschef__view_eval', {}, { toolUseID: 'toolu_b' })
    expect(seen).toEqual([
      ['mcp__yeschef__view_click', 'toolu_a'],
      ['mcp__yeschef__view_eval', 'toolu_b'],
    ])
    s.fq.end()
    await s.host.teardown()
  })

  it('回 false 時走既有批准流程，結果由 requestApproval 決定', async () => {
    const asked: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        asked.push(ask)
        return Promise.resolve({ decision: 'deny' as const, reason: '使用者按了拒絕' })
      },
      autoAllow: () => false,
    })
    const result = await s.canUseTool()!(
      'mcp__yeschef__view_eval',
      { expression: '1' },
      { toolUseID: 'toolu_eval' }
    )
    expect(result).toEqual({ behavior: 'deny', message: '使用者按了拒絕' })
    expect(asked.map((a) => a.toolUseId)).toEqual(['toolu_eval'])
    s.fq.end()
    await s.host.teardown()
  })

  it('autoAllow 丟例外時視同 false：onError 收到，結果由批准流程決定', async () => {
    const asked: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        asked.push(ask)
        return Promise.resolve({ decision: 'allow' as const })
      },
      autoAllow: () => {
        throw new Error('政策表壞了')
      },
    })
    const result = await s.canUseTool()!('Bash', { command: 'ls' }, { toolUseID: 'toolu_x' })
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(asked.map((a) => a.toolName)).toEqual(['Bash'])
    expect(s.errors.map((e) => e.message).join()).toMatch(/政策表壞了/)
    s.fq.end()
    await s.host.teardown()
  })
})
```

第一個案例的 `requestApproval` 刻意回 deny：只斷言結果是 allow 的話，「autoAllow 排在 requestApproval 之後」這個突變照樣通得過（批准流程回 allow 時兩者同值）。回 deny 讓正確與錯誤實作的結果不同，再加上 `asked` 為空的斷言，兩道都擋。第一個案例的 `input` 是非空物件 `{ ref: 's1-e2' }`：空物件會讓「`updatedInput` 忘了帶原 input」的突變與正確實作巧合同值。第四個案例的 `requestApproval` 回 allow 而 `autoAllow` 丟例外：若例外被實作成「往 allow 倒」，結果會與正確實作相同，所以另外斷言 `asked` 確實收到那一筆，證明真的走過批准流程。

- [ ] **Step B2: 跑測試確認失敗**

```bash
npx vitest run tests/agent-host.test.ts
```

預期：四個新案例全紅。`autoAllow` 這個 dep 還不存在，tsc 會報 `Object literal may only specify known properties`；執行期 `canUseTool` 一律走批准流程，第一個案例拿到 `{ behavior: 'deny', message: '不該走到這裡' }`。既有 35 個案例通過。

- [ ] **Step B3: 最小實作**

`src/main/agent-host.ts` 的 `AgentHostDeps`，在 `clock?: MergerClock` 之後加：

```ts
  /**
   * 回 true 時 `canUseTool` 直接 allow，不進批准流程（契約 §11.2）。
   * 預設沒有這個函式，等同一律 false：既有行為不變。
   */
  readonly autoAllow?: (toolName: string, toolUseId: string) => boolean
```

`canUseTool` 開頭（既有的 `try {` 之前）插入：

```ts
    // 政策放行的工具不打擾使用者（契約 §11.2）。這一段必須在 requestApproval
    // 之前：放在之後等於卡片已經送到 renderer，再自動放行就是兩套答案。
    // autoAllow 丟例外時視同 false 往批准流程倒，不讓一個政策函式的 bug 中斷 query。
    try {
      if (deps.autoAllow?.(toolName, options.toolUseID) === true) {
        return { behavior: 'allow', updatedInput: toolInput }
      }
    } catch (err) {
      deps.onError(asError(err, `工具 ${toolName} 的自動放行判斷失敗`))
    }
```

這一段自己一個 `try`，不併進下面那個：併進去的話例外會被既有的 catch 接住，變成 `{ behavior: 'deny' }`，與契約的「視同 false」不同。`=== true` 而不是直接當條件用：`autoAllow` 是外來函式，回傳非布林值時應該當作沒放行。

- [ ] **Step B4: 跑測試確認通過**

```bash
npx vitest run tests/agent-host.test.ts
npx tsc --noEmit
```

預期：39 passed（既有 35 + 新增 4），tsc 無輸出。

---

## C 組：ipc-bridge 接 viewTools

- [ ] **Step C1: 寫失敗的測試**

`tests/ipc-bridge.test.ts` 改四處，既有 27 個案例一字不動（`setup()` 維持零參數可呼叫）。

第一處，第 32 行的 import 改成：

```ts
import {
  createIpcBridge,
  type SessionSource,
  type ViewToolHooks,
} from '../src/main/ipc-bridge.js'
```

第二處，`Rig` 介面的 `fire` 之後加兩個成員，並改 `setup` 的簽章：

```ts
  fire(channel: string, payload?: unknown): void
  /** `viewTools.handoffDone()` 收到的 id，依序。沒開 viewTools 時永遠是空的。 */
  readonly handoffIds: string[]
  /** 換掉假 viewTools 的 `autoAllow` 回傳值。 */
  setAutoAllow(value: boolean): void
}

/** `withViewTools: true` 時 bridge 收得到假的 view tools，三個方法都記進 `calls`。 */
function setup(options?: { withViewTools?: true }): Rig {
```

第三處，在 `const bridge = createIpcBridge({` 之前插入假的 hooks，並在 deps 裡條件帶入：

```ts
  const handoffIds: string[] = []
  let autoAllowValue = true
  const viewTools: ViewToolHooks = {
    autoAllow: (toolName, toolUseId) => {
      calls.push(`autoAllow(${toolName},${toolUseId})`)
      return autoAllowValue
    },
    handoffDone: (toolUseId) => {
      calls.push(`handoffDone(${toolUseId})`)
      handoffIds.push(toolUseId)
    },
    abortPending: (reason) => {
      calls.push(`abortPending(${reason})`)
    },
  }

  const bridge = createIpcBridge({
    webContents: webContents as never,
    ...(options?.withViewTools === true ? { viewTools } : {}),
```

三個方法都寫進既有的 `calls` 陣列，跟 `interrupt`／`teardown`／`denyAll` 同一個陣列：呼叫順序才驗得出來，這是本組唯一擋得住「abortPending 排在 host 之後」的手段。

第四處，`setup` 的 return 物件在 `fire` 之後加：

```ts
    handoffIds,
    setAutoAllow: (value) => {
      autoAllowValue = value
    },
```

最後把以下整段接在檔案最後：

```ts
describe('契約 §11.4：bridge 接上 view tools', () => {
  it('ensureHost 把 viewTools.autoAllow 傳給 host，呼叫結果原樣轉回', async () => {
    const rig = setup({ withViewTools: true })
    rig.fire(IPC.intentStartNew)
    await settle()

    const autoAllow = rig.hostDeps().autoAllow
    expect(autoAllow).toBeTypeOf('function')
    expect(autoAllow!('mcp__yeschef__view_click', 'toolu_1')).toBe(true)
    rig.setAutoAllow(false)
    expect(autoAllow!('mcp__yeschef__view_eval', 'toolu_2')).toBe(false)
    expect(rig.calls.filter((c) => c.startsWith('autoAllow'))).toEqual([
      'autoAllow(mcp__yeschef__view_click,toolu_1)',
      'autoAllow(mcp__yeschef__view_eval,toolu_2)',
    ])
  })

  it('沒有 viewTools 時 host 的 deps 連 autoAllow 這個 key 都沒有', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()

    expect('autoAllow' in rig.hostDeps()).toBe(false)
  })

  it('裁決 11：teardown 與 interrupt 都先 abortPending 才動 host', async () => {
    const rig = setup({ withViewTools: true })
    rig.fire(IPC.intentStartNew)
    await settle()
    rig.calls.length = 0

    rig.fire(IPC.intentOpenHistory, { sessionId: 's-2' })
    await settle()

    expect(rig.calls).toEqual([
      'denyAll(切換 session)',
      'abortPending(對話已結束)',
      'interrupt',
      'abortPending(對話已結束)',
      'teardown',
      'events(reset)',
      'loadHistory(s-2)',
      'events(user-text,session-end)',
      'send(session:state)',
    ])
  })

  it('dispose 的收尾一樣先 abortPending', async () => {
    const rig = setup({ withViewTools: true })
    rig.fire(IPC.intentStartNew)
    await settle()
    rig.calls.length = 0

    await rig.bridge.dispose()

    expect(rig.calls).toEqual([
      'denyAll(視窗已關閉)',
      'abortPending(對話已結束)',
      'interrupt',
      'abortPending(對話已結束)',
      'teardown',
    ])
  })

  it('handoff:done 驗過 payload 之後把 toolUseId 交給 viewTools', () => {
    const rig = setup({ withViewTools: true })
    rig.fire(IPC.handoffDone, { toolUseId: 'toolu_handoff' })

    expect(rig.handoffIds).toEqual(['toolu_handoff'])
    expect(rig.errors).toEqual([])
  })

  it('壞掉的 handoff:done payload 被丟棄，不呼叫 handoffDone', () => {
    const rig = setup({ withViewTools: true })
    rig.fire(IPC.handoffDone, { toolUseId: '' })
    rig.fire(IPC.handoffDone, 'toolu_handoff')
    rig.fire(IPC.handoffDone, undefined)

    expect(rig.handoffIds).toEqual([])
    expect(rig.errors).toHaveLength(3)
    expect(rig.errors.map((e) => e.message).join()).toMatch(/payload 形狀不符/)
  })

  it('沒有 viewTools 時收到 handoff:done 只記錄，不丟例外', () => {
    const rig = setup()
    rig.fire(IPC.handoffDone, { toolUseId: 'toolu_handoff' })

    expect(rig.errors.map((e) => e.message)).toEqual(['收到 handoff:done 但沒有 view tools'])
  })

  it('dispose 之後 handoff:done 的監聽已解除', async () => {
    const rig = setup({ withViewTools: true })
    await rig.bridge.dispose()

    expect(() => rig.fire(IPC.handoffDone, { toolUseId: 'toolu_late' })).toThrow(/沒有註冊/)
    expect(rig.handoffIds).toEqual([])
  })
})
```

第三個案例斷言整個 `calls` 陣列而不是只挑 `abortPending` 出來看：這條路徑一次跑 `interrupt-query` 與 `teardown-query` 兩個 effect，只斷言「有兩筆 abortPending」的話，兩筆都排在 host 之後也會通過。壞 payload 那個案例送三種不同的壞形狀（空字串、非物件、`undefined`），並斷言錯誤筆數是 3：只送一種的話，「只擋 null 不擋空字串」這類半套驗證會漏掉。`setAutoAllow` 讓同一個 `autoAllow` 前後回不同值，擋掉「把回傳值寫死成 true」的實作。

- [ ] **Step C2: 跑測試確認失敗**

```bash
npx vitest run tests/ipc-bridge.test.ts
```

預期：`ViewToolHooks` 與 `IPC.handoffDone` 在 bridge 端還不存在，tsc 報找不到匯出；執行期八個新案例全紅（`rig.fire(IPC.handoffDone, …)` 拋 `沒有註冊 handoff:done`，`rig.hostDeps().autoAllow` 是 `undefined`，`calls` 裡沒有 `abortPending`）。既有 27 個案例通過。

- [ ] **Step C3: 最小實作**

`src/main/ipc-bridge.ts`，第 5 到 12 行的 import 清單加一項（維持字母序，放在 `parseApprovalReply` 之後）：

```ts
  parseHandoffDone,
```

第 25 行 `import type { SessionOptions } from './session-args.js'` 之後加：

```ts
import { MSG } from './view-tools/errors.js'
import type { ViewTools } from './view-tools/server.js'

/**
 * bridge 只用得到 `ViewTools` 的三個方法（契約 §11.4）。用 `Pick` 而不是重寫一份
 * 介面：Task 10 改簽章時這裡直接過不了 typecheck。
 */
export type ViewToolHooks = Pick<ViewTools, 'autoAllow' | 'handoffDone' | 'abortPending'>
```

`IpcBridgeDeps` 的 `createRegistry?` 之後加：

```ts
  /** 子專案 B 的右窗格工具。沒有時整條 bridge 的行為與子專案 A 完全相同。 */
  readonly viewTools?: ViewToolHooks
```

`createIpcBridge` 開頭 `const createHost = …` 之後加：

```ts
  /** 取一次就固定。後面全部用這個區域變數，省掉每個呼叫點的非空斷言。 */
  const viewTools = deps.viewTools
```

`ensureHost` 的 `createHost({ … })`，在 `requestApproval` 之後加：

```ts
      // 契約 §11.4：沒有 viewTools 就不帶這個 key，host 走既有的全數送批准。
      ...(viewTools === undefined
        ? {}
        : { autoAllow: (name: string, id: string) => viewTools.autoAllow(name, id) }),
```

包一層箭頭函式而不是直接寫 `autoAllow: viewTools.autoAllow`：`ViewTools` 是介面方法，實作端可能用得到 `this`，拆下來單獨傳會斷掉繫結。

`runEffect` 的兩個分支改成：

```ts
      case 'interrupt-query':
        // 裁決 11：等待中的工具（settle、handoff）先收到「對話已結束」，
        // 再動 host。反過來的話 teardown 會等在一個永遠不會回的 tool call 上。
        viewTools?.abortPending(MSG.sessionEnded)
        await ensureHost().interrupt()
        return
      case 'teardown-query':
        viewTools?.abortPending(MSG.sessionEnded)
        await ensureHost().teardown()
        return
```

`onIntentStartNew` 之前加新的 handler：

```ts
  const onHandoffDone = (_e: unknown, raw: unknown): void =>
    guard(IPC.handoffDone, () => {
      const payload = parseHandoffDone(raw)
      if (payload === null) return rejectPayload(IPC.handoffDone, raw)
      if (viewTools === undefined) {
        deps.logError(new Error('收到 handoff:done 但沒有 view tools'))
        return
      }
      viewTools.handoffDone(payload.toolUseId)
    })
```

`dispose()` 的 `removeListener` 群組加一行（排在 `intentOpenHistory` 之後、`removeHandler` 之前）：

```ts
    ipcMain.removeListener(IPC.handoffDone, onHandoffDone)
```

檔案最後的註冊區加一行（排在 `intentOpenHistory` 之後、`handle` 之前）：

```ts
  ipcMain.on(IPC.handoffDone, onHandoffDone)
```

- [ ] **Step C4: 跑測試確認通過**

```bash
npx vitest run tests/ipc-bridge.test.ts
npx tsc --noEmit
npx vitest run
```

預期：`ipc-bridge` 35 passed（既有 27 + 新增 8）；tsc 無輸出；全套測試通過。

---

- [ ] **Step 5: 突變測試**

以下六個突變在 worktree `wt-13`（HEAD `00213ba`，上游用最小 stub 補齊）實跑過，每一個都改實作、跑測試、還原、確認回綠。基準：三個測試檔 81 passed（`session-options` 7、`agent-host` 39、`ipc-bridge` 35），`tsc --noEmit` 無輸出。

| # | 突變 | 變紅的測試 |
|---|---|---|
| 1 | `agent-host.ts`：把 autoAllow 那一段移到 `requestApproval` 之後、`toPermissionResult` 之前 | `回 true 時直接 allow，requestApproval 完全沒被呼叫`、`autoAllow 丟例外時視同 false：onError 收到，結果由批准流程決定`（2 failed / 37 passed） |
| 2 | `agent-host.ts`：拿掉 autoAllow 外面的 `try/catch`，只留 `if` | `autoAllow 丟例外時視同 false：onError 收到，結果由批准流程決定`（1 failed / 38 passed） |
| 3 | `agent-host.ts`：allow 時回 `updatedInput: {}` | `回 true 時直接 allow，requestApproval 完全沒被呼叫`（1 failed / 38 passed） |
| 4 | `ipc-bridge.ts`：兩個分支都把 `abortPending` 移到 `await ensureHost().…()` 之後 | `裁決 11：teardown 與 interrupt 都先 abortPending 才動 host`、`dispose 的收尾一樣先 abortPending`（2 failed / 33 passed） |
| 5 | `ipc-bridge.ts`：`onHandoffDone` 不驗證，直接 `const payload = raw as { toolUseId: string }` | `壞掉的 handoff:done payload 被丟棄，不呼叫 handoffDone`（1 failed / 34 passed） |
| 6 | `ipc-bridge.ts`：`ensureHost` 改成無條件 `autoAllow: viewTools?.autoAllow` | `沒有 viewTools 時 host 的 deps 連 autoAllow 這個 key 都沒有`（1 failed / 34 passed） |

另外一個 `session-args.ts` 的突變：把條件展開改成無條件的 `mcpServers: input.mcpServers`，`沒給 mcpServers 時 options 連這個 key 都沒有` 變紅（1 failed / 6 passed）。這一條驗證了 A 組第一個案例用 `'mcpServers' in options` 而不是 `toBeUndefined()` 的必要性：後者對這個突變是全綠的。

突變 1 是本組最重要的一個。它示範了為什麼第一個案例的 `requestApproval` 要回 deny：若改回 allow，突變 1 的結果與正確實作完全相同，只剩 `asked` 那一行斷言擋得住。兩道一起放。

- [ ] **Step 6: 提交**

```bash
git add src/main/session-args.ts src/main/session-options.ts src/main/agent-host.ts src/main/ipc-bridge.ts \
        tests/session-options.test.ts tests/agent-host.test.ts tests/ipc-bridge.test.ts
git commit -m "feat: session options 帶 mcpServers、agent-host autoAllow、ipc-bridge 接 view tools"
```

---

## 撰寫時的實機驗證紀錄

在 worktree `wt-13`（`git worktree add … HEAD`，`node_modules` 連到主工作樹）跑過：

- 動手之前 `npx vitest run tests/session-options.test.ts tests/agent-host.test.ts tests/ipc-bridge.test.ts` → 3 files、65 passed，全綠。
- 本 task 的實作與測試全部寫進 worktree 後 → 3 files、81 passed；`npx tsc --noEmit` 無輸出。
- 上游未完成的部分用最小 stub 補：`src/main/view-tools/errors.ts` 只放 `MSG.sessionEnded`、`src/main/view-tools/server.ts` 只放 `ViewTools` 介面（照契約 §10.3 逐字）、`src/shared/ipc.ts` 加 `IPC.handoffDone`、`HandoffDonePayload`、`parseHandoffDone`（照契約 §11.3 逐字）。實際執行本 task 時這三份由 Task 0、10、11 提供，不要再寫 stub。
- worktree 已 `git worktree remove --force` 清掉，沒有任何內容提交。

---

### Task 14: index.ts 接線、實機 fixture、RESULTS-05 與規格回寫

這是子專案 B 的最後一個 task，把前面十四個 task 的產物接成一個跑得起來的 app，再補上三份沒有程式碼但少不了的東西：實機抓回來的 AX fixture、實機驗收紀錄、規格的修訂紀錄。

`src/main/index.ts` 在 vitest 的 coverage exclude 清單裡（契約 §0），所以接線本身沒有測試縫。裁決 17 要求「CDP 或 view tools 建立失敗時仍開視窗、只停用右窗格工具」，這條規則有三條分支（attach 失敗、create 失敗、兩者都成功），全塞進 index.ts 等於三條分支永遠沒人驗。作法是把這段抽成 `src/main/view-tools/startup.ts` 的 `startViewTools()`（裁決 34 授權 Task 14 命名），index.ts 只剩「呼叫它、把回傳的兩個欄位往下傳」。

`startViewTools()` 回傳的物件在成功與失敗兩條路徑上形狀相同：`mcpServers` 與 `viewTools` 成功時有值、失敗時是 `undefined`，`dispose()` 成功時做兩步收尾、失敗時是 no-op。這樣 index.ts 一個 `if` 都不用寫。契約 §13 的無工具路徑是無條件傳 `undefined`（裁決 35），傳 `undefined` 與不傳在這兩個消費端是同一件事，這一點在 Task 13 已經釘死：`session-args.ts` 用 `...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers })` 決定要不要放這個 key，`createSessionOptionsFactory` 本來就是把可能為 `undefined` 的 `mcpServers` 無條件往下傳；`ipc-bridge.ts` 的 `ensureHost` 用 `...(viewTools === undefined ? {} : { autoAllow: … })`（見 task-13.md Step A3 與 Step C3，兩處都有對應的測試）。少掉的兩條 if 換來的是 index.ts 只有一條路徑。

`attach` 與 `create` 是注入進來的，不是 `startup.ts` 自己 import。理由是 index.ts 因此可以直接寫 `attach: attachCdp`、`create: createViewToolServer` 兩個裸參考，不需要任何轉接函式；轉接函式寫在 index.ts 就是寫在沒有測試的檔案裡。`attach` 收的是 `WebContents` 而不是 `WebContentsView`，正是為了讓 `attachCdp` 直接對得上。

實機 fixture 這一段有一個實跑之後才發現、已回到源頭修好的問題。`tests/fixtures/view/form.html`（Task 4 產出）的 `<label>` 若在標籤文字與 `<input>` 之間留空白，Chromium 算出來的可及名稱會帶尾端空白（`textbox "電子郵件 "`），Task 4 的測試用「角色｜名稱」查 `FORM_BOXES` 就查不到矩形，八個節點會掉到五個。契約 §14 說兩份 fixture「差異只能在 nodeId 與屬性順序」，所以 task-4.md 的 HTML 已改成不留空白（裁決 36）；本 task 的 Step C1 只確認，不修改 Task 4 的檔。拿掉空白之後，實機 fixture 與手寫 fixture 通過同一組 45 個測試（已實跑，見 Step C4）。

**Files:**

- Create `src/main/view-tools/startup.ts`（84 行）
- Create `spikes/capture-ax.ts`（77 行）
- Create `tests/fixtures/ax/form.real.json`（由 `npm run spike:ax` 產出，Electron 44 實機 34 個節點）
- Create `tests/fixtures/view/cross-site-outer.html`（19 行）與 `tests/fixtures/view/cross-site-inner.html`（18 行）：裁決 34 的跨站 iframe 驗收頁面
- Create `docs/RESULTS-05-b-view-tools.md`（驗收模板，結果欄由執行者填）
- Modify `src/main/index.ts`（第 1 到 10 行的 import；第 13 行 `INITIAL_AGENT_URL`；第 107 到 150 行的 `createWindow`；第 152 到 156 行的 `app.whenReady()`）
- Modify `tests/view-tools/snapshot.test.ts`（Task 4 產出：`AX_FIXTURES` 一行加 `'form.real.json'`）
- Modify `package.json`（`scripts` 加 `spike:ax`；`dependencies` 的 `@anthropic-ai/claude-agent-sdk` 改精確版本）
- Modify `vitest.config.ts`（第 17 到 18 行 `agent-view.ts` 的排除註解）
- Modify `docs/specs/2026-09-03-yeschef-b-view-tools-design.md`（§11 修訂紀錄表加 22 列）
- Test: `tests/view-tools/startup.test.ts`（190 行，9 個案例）

**Interfaces:**

Consumes：

```ts
// src/shared/view-tools.ts（Task 0）
export const VIEW_TOOL_SERVER_NAME = 'yeschef'
// src/main/cdp.ts（Task 1）
export interface AttachCdpOptions { readonly onListenerError?: (error: Error) => void }
export interface CdpSession { send; detach(): void; getAttachedTargets; getRearmErrors; onEvent }
export function attachCdp(wc: WebContents, opts?: AttachCdpOptions): Promise<CdpSession>
// src/main/agent-host.ts（Plan A 既有）
export interface MergerClock { now(): number; setTimer(fn, ms): unknown; clearTimer(handle): void }
export const SYSTEM_CLOCK: MergerClock
// src/main/view-tools/server.ts（Task 10）
export interface ViewToolDeps {
  readonly view: WebContentsView; readonly cdp: CdpSession; readonly clock: MergerClock
  readonly projectDir: string; readonly logError: (error: Error) => void
}
export interface ViewTools {
  readonly server: McpSdkServerConfigWithInstance
  autoAllow(toolName: string, toolUseId: string): boolean
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
  dispose(): Promise<void>
}
export function createViewToolServer(deps: ViewToolDeps): Promise<ViewTools>
// src/main/session-options.ts（Task 13）
export function createSessionOptionsFactory(
  projectDir: string, appDir: string, sessions: Pick<SessionStore, 'cwdOf'>,
  mcpServers?: Readonly<Record<string, McpServerConfig>>
): (resumeSessionId?: string) => SessionOptions
// src/main/ipc-bridge.ts（Task 13）
export type ViewToolHooks = Pick<ViewTools, 'autoAllow' | 'handoffDone' | 'abortPending'>
export interface IpcBridgeDeps { /* 既有欄位不變 */ readonly viewTools?: ViewToolHooks }
// tests/view-tools/snapshot.test.ts（Task 4）
const AX_FIXTURES = ['form.json'] as const
```

Produces（B 的最後一個 task，沒有下游 task 會 import；以下是給組裝與日後維護的簽章）：

```ts
// src/main/view-tools/startup.ts
export const VIEW_TOOLS_DISABLED_PREFIX = '[yeschef] 右窗格工具停用：'
export interface ViewToolStartupDeps {
  readonly view: WebContentsView
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
  readonly warn: (line: string) => void
  readonly attach: (wc: WebContents, opts: AttachCdpOptions) => Promise<CdpSession>
  readonly create: (deps: ViewToolDeps) => Promise<ViewTools>
}
export interface ViewToolStartup {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>> | undefined
  readonly viewTools: ViewTools | undefined
  dispose(): Promise<void>
}
export function startViewTools(deps: ViewToolStartupDeps): Promise<ViewToolStartup>
// src/main/index.ts
export function createWindow(): Promise<BaseWindow>
```

---

## A 組：可單元測試的接線（`startup.ts`）

- [ ] **Step A1: 寫失敗的測試**

先確認目錄存在（Task 0 到 13 執行過的話已經有）：`mkdir -p src/main/view-tools tests/view-tools`。

建立 `tests/view-tools/startup.test.ts`，完整內容如下。`setup()` 用三個選項（`attachFails`／`createFails`／`detachFails`）長出四種情境，共用同一組記錄陣列；`calls` 記事件順序，`logged` 與 `warned` 分開記，因為裁決 17 要的是「記一筆錯誤」與「印一行給人看」兩件事，合在一起測就分不出實作漏了哪一件。

```ts
import { describe, expect, it } from 'vitest'
import type { WebContents, WebContentsView } from 'electron'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { VIEW_TOOL_SERVER_NAME } from '../../src/shared/view-tools.js'
import type { MergerClock } from '../../src/main/agent-host.js'
import type { AttachCdpOptions, CdpSession } from '../../src/main/cdp.js'
import type { ViewToolDeps, ViewTools } from '../../src/main/view-tools/server.js'
import {
  VIEW_TOOLS_DISABLED_PREFIX,
  startViewTools,
  type ViewToolStartupDeps,
} from '../../src/main/view-tools/startup.js'

const SERVER = { type: 'sdk', name: VIEW_TOOL_SERVER_NAME } as unknown as McpSdkServerConfigWithInstance
const CLOCK: MergerClock = { now: () => 0, setTimer: () => 0, clearTimer: () => {} }

interface Rig {
  readonly deps: ViewToolStartupDeps
  readonly calls: string[]
  readonly logged: Error[]
  readonly warned: string[]
  readonly created: ViewToolDeps[]
  readonly attachOpts: AttachCdpOptions[]
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly viewTools: ViewTools
}

interface RigOptions {
  readonly attachFails?: unknown
  readonly createFails?: unknown
  readonly detachFails?: unknown
}

function setup(options: RigOptions = {}): Rig {
  const calls: string[] = []
  const logged: Error[] = []
  const warned: string[] = []
  const created: ViewToolDeps[] = []
  const attachOpts: AttachCdpOptions[] = []
  const webContents = { id: 7 } as unknown as WebContents
  const view = { webContents } as unknown as WebContentsView

  const cdp = {
    send: () => Promise.reject(new Error('未使用')),
    detach: () => {
      calls.push('cdp.detach')
      if (options.detachFails !== undefined) throw options.detachFails
    },
    getAttachedTargets: () => [],
    getRearmErrors: () => [],
    onEvent: () => () => {},
  } as unknown as CdpSession

  const viewTools: ViewTools = {
    server: SERVER,
    autoAllow: () => true,
    handoffDone: () => {},
    abortPending: () => {},
    dispose: () => {
      calls.push('viewTools.dispose')
      return Promise.resolve()
    },
  }

  const deps: ViewToolStartupDeps = {
    view,
    clock: CLOCK,
    projectDir: '/proj',
    logError: (error) => logged.push(error),
    warn: (line) => warned.push(line),
    attach: (wc, opts) => {
      calls.push(`attach(${(wc as unknown as { id: number }).id})`)
      attachOpts.push(opts)
      return options.attachFails === undefined ? Promise.resolve(cdp) : Promise.reject(options.attachFails)
    },
    create: (createDeps) => {
      calls.push('create')
      created.push(createDeps)
      return options.createFails === undefined
        ? Promise.resolve(viewTools)
        : Promise.reject(options.createFails)
    },
  }

  return { deps, calls, logged, warned, created, attachOpts, view, cdp, viewTools }
}

describe('契約 §13：成功路徑', () => {
  it('mcpServers 只有 yeschef 一個鍵，值是 viewTools.server 本人', async () => {
    const rig = setup()
    const startup = await startViewTools(rig.deps)

    expect(Object.keys(startup.mcpServers ?? {})).toEqual([VIEW_TOOL_SERVER_NAME])
    expect(startup.mcpServers?.[VIEW_TOOL_SERVER_NAME]).toBe(SERVER)
    expect(startup.viewTools).toBe(rig.viewTools)
    expect(rig.warned).toEqual([])
    expect(rig.logged).toEqual([])
  })

  it('create 拿到的是 attach 回來的那一個 cdp，attach 拿到 onListenerError', async () => {
    const rig = setup()
    await startViewTools(rig.deps)

    expect(rig.calls).toEqual(['attach(7)', 'create'])
    expect(rig.created).toHaveLength(1)
    expect(rig.created[0]?.cdp).toBe(rig.cdp)
    expect(rig.created[0]?.view).toBe(rig.view)
    expect(rig.created[0]?.clock).toBe(CLOCK)
    expect(rig.created[0]?.projectDir).toBe('/proj')
    expect(rig.created[0]?.logError).toBe(rig.deps.logError)
    expect(rig.attachOpts[0]?.onListenerError).toBe(rig.deps.logError)
  })

  it('dispose 先收 viewTools 再 detach cdp', async () => {
    const rig = setup()
    const startup = await startViewTools(rig.deps)
    rig.calls.length = 0
    await startup.dispose()

    expect(rig.calls).toEqual(['viewTools.dispose', 'cdp.detach'])
  })
})

describe('裁決 17／34：attachCdp 失敗', () => {
  it('不建 view tools、不 detach，兩個欄位都是 undefined', async () => {
    const rig = setup({ attachFails: new Error('debugger 已被佔用') })
    const startup = await startViewTools(rig.deps)

    expect(startup.mcpServers).toBeUndefined()
    expect(startup.viewTools).toBeUndefined()
    expect(rig.calls).toEqual(['attach(7)'])
    expect(rig.warned).toEqual([`${VIEW_TOOLS_DISABLED_PREFIX}debugger 已被佔用`])
    expect(rig.logged.map((e) => e.message)).toEqual(['debugger 已被佔用'])
  })

  it('dispose 是 no-op：沒有 cdp 可以 detach', async () => {
    const rig = setup({ attachFails: new Error('debugger 已被佔用') })
    const startup = await startViewTools(rig.deps)
    rig.calls.length = 0
    await startup.dispose()
    await startup.dispose()

    expect(rig.calls).toEqual([])
  })

  it('丟出的不是 Error 時照樣印得出訊息', async () => {
    const rig = setup({ attachFails: 'debugger 沒回應' })
    await startViewTools(rig.deps)

    expect(rig.warned).toEqual([`${VIEW_TOOLS_DISABLED_PREFIX}debugger 沒回應`])
    expect(rig.logged[0]).toBeInstanceOf(Error)
    expect(rig.logged[0]?.message).toBe('debugger 沒回應')
  })
})

describe('裁決 34：createViewToolServer 失敗', () => {
  it('先 detach cdp 再走無工具路徑', async () => {
    const rig = setup({ createFails: new Error('Accessibility.enable 失敗') })
    const startup = await startViewTools(rig.deps)

    expect(startup.mcpServers).toBeUndefined()
    expect(startup.viewTools).toBeUndefined()
    expect(rig.calls).toEqual(['attach(7)', 'create', 'cdp.detach'])
    expect(rig.warned).toEqual([`${VIEW_TOOLS_DISABLED_PREFIX}Accessibility.enable 失敗`])
  })

  it('detach 自己也丟例外時兩個錯誤都記下來，順序是先啟動失敗後收尾失敗', async () => {
    const rig = setup({
      createFails: new Error('Accessibility.enable 失敗'),
      detachFails: new Error('debugger 已 detach'),
    })
    const startup = await startViewTools(rig.deps)

    expect(rig.logged.map((e) => e.message)).toEqual(['Accessibility.enable 失敗', 'debugger 已 detach'])
    expect(startup.viewTools).toBeUndefined()
  })

  it('dispose 不會第二次 detach', async () => {
    const rig = setup({ createFails: new Error('Accessibility.enable 失敗') })
    const startup = await startViewTools(rig.deps)
    rig.calls.length = 0
    await startup.dispose()

    expect(rig.calls).toEqual([])
  })
})
```

三個案例特別擋住會讓測試變盲的實作。第一個案例斷言的是 `Object.keys()` 的完整陣列與 `toBe(SERVER)` 兩件事：只斷言 `mcpServers` 非 undefined 的話，鍵名寫死成別的字串、或值放成 `viewTools` 本身，兩種錯誤都通得過。「dispose 先收 viewTools 再 detach cdp」斷言整個 `calls` 陣列而不是各自被呼叫過：兩步順序反過來也會讓兩個名字都出現。「detach 自己也丟例外」那個案例斷言 `logged` 的訊息陣列有序：`report()` 與 `detachQuietly()` 對調位置時筆數不變、內容不變，只有順序變。

- [ ] **Step A2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/startup.test.ts
```

預期：`src/main/view-tools/startup.ts` 還不存在，vitest 直接報 `Failed to load url ../../src/main/view-tools/startup.js`，整個檔案 0 個案例被收集。

- [ ] **Step A3: 最小實作**

建立 `src/main/view-tools/startup.ts`，完整內容如下（84 行）：

```ts
import type { WebContents, WebContentsView } from 'electron'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { VIEW_TOOL_SERVER_NAME } from '../../shared/view-tools.js'
import type { MergerClock } from '../agent-host.js'
import type { AttachCdpOptions, CdpSession } from '../cdp.js'
import type { ViewToolDeps, ViewTools } from './server.js'

/** 停用時印在 console 的那一行前綴（契約 §13，裁決 17）。 */
export const VIEW_TOOLS_DISABLED_PREFIX = '[yeschef] 右窗格工具停用：'

export interface ViewToolStartupDeps {
  readonly view: WebContentsView
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
  /** 印那一行；index.ts 給 console.error。 */
  readonly warn: (line: string) => void
  readonly attach: (wc: WebContents, opts: AttachCdpOptions) => Promise<CdpSession>
  readonly create: (deps: ViewToolDeps) => Promise<ViewTools>
}

export interface ViewToolStartup {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>> | undefined
  readonly viewTools: ViewTools | undefined
  dispose(): Promise<void>
}

/** 裁決 34 的無工具路徑。兩個欄位都是 undefined，dispose 什麼都不做。 */
const NO_TOOLS: ViewToolStartup = {
  mcpServers: undefined,
  viewTools: undefined,
  dispose: () => Promise.resolve(),
}

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

function report(deps: ViewToolStartupDeps, error: Error): void {
  deps.logError(error)
  deps.warn(`${VIEW_TOOLS_DISABLED_PREFIX}${error.message}`)
}

/** cdp 收不掉不該再蓋掉原本的啟動失敗，記下來就好。 */
function detachQuietly(cdp: CdpSession, logError: (error: Error) => void): void {
  try {
    cdp.detach()
  } catch (raw) {
    logError(toError(raw))
  }
}

export async function startViewTools(deps: ViewToolStartupDeps): Promise<ViewToolStartup> {
  let cdp: CdpSession
  try {
    cdp = await deps.attach(deps.view.webContents, { onListenerError: deps.logError })
  } catch (raw) {
    report(deps, toError(raw))
    return NO_TOOLS
  }

  let viewTools: ViewTools
  try {
    viewTools = await deps.create({
      view: deps.view,
      cdp,
      clock: deps.clock,
      projectDir: deps.projectDir,
      logError: deps.logError,
    })
  } catch (raw) {
    report(deps, toError(raw))
    detachQuietly(cdp, deps.logError)
    return NO_TOOLS
  }

  return {
    mcpServers: { [VIEW_TOOL_SERVER_NAME]: viewTools.server },
    viewTools,
    dispose: async () => {
      await viewTools.dispose()
      cdp.detach()
    },
  }
}
```

`NO_TOOLS` 是模組層級的常數而不是每次現做一個物件：三個欄位都不帶狀態，兩條失敗路徑回同一個參考不會互相影響。成功路徑的 `dispose` 則是閉包，因為它要記住這一次的 `viewTools` 與 `cdp`。

- [ ] **Step A4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/startup.test.ts
npx tsc --noEmit -p tsconfig.json
```

預期：9 個案例全綠、`tsc` 0 error。已在 worktree 實跑（Electron 44、vitest 4.1.11）：`Tests 9 passed (9)`。

- [ ] **Step A5: 突變測試**

五個突變都已在 worktree 實跑，每一個都至少讓一個案例變紅，還原後回綠。

| # | 突變 | 變紅的測試 |
|---|---|---|
| 1 | `create` 失敗的 catch 拿掉 `detachQuietly(cdp, deps.logError)` | `先 detach cdp 再走無工具路徑`、`detach 自己也丟例外時兩個錯誤都記下來，順序是先啟動失敗後收尾失敗`（2 failed / 7 passed） |
| 2 | `mcpServers` 的鍵寫死成 `'view-tools'` | `mcpServers 只有 yeschef 一個鍵，值是 viewTools.server 本人`（1 failed / 8 passed） |
| 3 | 成功路徑的 `dispose` 改成先 `cdp.detach()` 再 `await viewTools.dispose()` | `dispose 先收 viewTools 再 detach cdp`（1 failed / 8 passed） |
| 4 | `create` 失敗時 `detachQuietly` 排到 `report` 前面 | `detach 自己也丟例外時兩個錯誤都記下來，順序是先啟動失敗後收尾失敗`（1 failed / 8 passed） |
| 5 | `report()` 只 `warn` 不 `logError` | `不建 view tools、不 detach，兩個欄位都是 undefined`、`丟出的不是 Error 時照樣印得出訊息`、`detach 自己也丟例外時兩個錯誤都記下來…`（3 failed / 6 passed） |

突變 4 是這一組裡最能說明問題的一個：呼叫次數、錯誤筆數、回傳值全部不變，只有 `logged` 陣列的順序變了。如果第五個案例當初只寫 `expect(rig.logged).toHaveLength(2)`，這個突變就會全綠。

每個突變的操作：改 `src/main/view-tools/startup.ts`、跑 `npx vitest run tests/view-tools/startup.test.ts`、記下紅的案例名稱、還原檔案、再跑一次確認 `Tests 9 passed (9)`。

- [ ] **Step A6: 提交**

```bash
git add src/main/view-tools/startup.ts tests/view-tools/startup.test.ts
git commit -m "feat: view tools 啟動接線與失敗時的無工具路徑"
```

---

## B 組：index.ts 接線與兩份設定檔

- [ ] **Step B1: 改 `src/main/index.ts`**

第 9 行 `import { createIpcBridge } from './ipc-bridge.js'` 之後、第 10 行 `import { PROJECT_DIR_ARG }` 之前插入四行：

```ts
import { attachCdp } from './cdp.js'
import { SYSTEM_CLOCK } from './agent-host.js'
import { createViewToolServer } from './view-tools/server.js'
import { startViewTools } from './view-tools/startup.js'
```

第 13 行改成（規格 §9 就是這樣寫的；`https://example.com` 是 Plan A 的暫定值）：

```ts
const INITIAL_AGENT_URL = 'about:blank'
```

`createWindow` 整個換成以下內容（第 107 到 150 行）：

```ts
export async function createWindow(): Promise<BaseWindow> {
  // 守衛排在開視窗之前：設定錯誤時不要先閃一個視窗再退出。
  const projectDir = requireProjectDir()
  // 裁決 7：SDK 型別在 session-store 轉成 SessionSummary，不穿過 IPC。
  const sessions = createSessionStore({ listSessions, getSessionMessages })
  const logError = (error: Error): void => {
    console.error('[yeschef]', error)
  }

  const win = new BaseWindow({ width: 1600, height: 900, titleBarStyle: 'hiddenInset' })
  const conversationView = createConversationView(projectDir)
  const agentView = createAgentView()

  win.contentView.addChildView(conversationView)
  win.contentView.addChildView(agentView)

  const applyLayout = (): void => {
    const { width, height } = win.getContentBounds()
    const { left, right } = splitBounds({ width, height }, DEFAULT_RATIO)
    conversationView.setBounds(left)
    agentView.setBounds(right)
  }
  applyLayout()
  win.on('resize', applyLayout)

  // 裁決 17（docs/superpowers/plan-b/CONTRACT.md）：CDP 或 view tools 建立失敗時
  // 兩個欄位都是 undefined，視窗照開，左窗格照常可用，右窗格只剩手動瀏覽。
  const startup = await startViewTools({
    view: agentView,
    clock: SYSTEM_CLOCK,
    projectDir,
    logError,
    warn: (line) => {
      console.error(line)
    },
    attach: attachCdp,
    create: createViewToolServer,
  })

  // 裁決 20：resume 時工廠向 store 問那場對話原本的 cwd。
  const sessionOptions = createSessionOptionsFactory(
    projectDir,
    app.getAppPath(),
    sessions,
    startup.mcpServers
  )

  const bridge = createIpcBridge({
    webContents: conversationView.webContents,
    sessionOptions,
    sessions,
    logError,
    viewTools: startup.viewTools,
  })

  // 視窗關閉是狀態機的 `window-closed`：dispose() 會跑完三步收尾再解掉 handler。
  win.on('closed', () => {
    bridge.dispose().catch((err: unknown) => {
      console.error('[yeschef] 收尾失敗:', err)
    })
    startup.dispose().catch((err: unknown) => {
      console.error('[yeschef] 右窗格工具收尾失敗:', err)
    })
  })

  loadRenderer(conversationView)
  loadAgentPage(agentView, INITIAL_AGENT_URL)
  return win
}
```

最後把第 152 到 156 行的 `app.whenReady()` 改成把 promise 交出去，既有的 `.catch` 才接得到 async 失敗（契約 §13）：

```ts
app
  .whenReady()
  .then(() => createWindow())
  .catch((err: unknown) => {
    console.error('[yeschef] 應用初始化失敗:', err)
    process.exit(1)
  })
```

`logError` 從原本寫在 `createIpcBridge` 參數裡的行內箭頭函式提成區域常數：bridge 與 `startViewTools` 要用同一個，`startup.test.ts` 也靠「`create` 拿到的 `logError` 與 deps 給的是同一個參考」這條斷言釘住這件事。`startup.dispose()` 與 `bridge.dispose()` 不串成一條 promise 鏈：兩邊互不相依，串起來只會讓前一個失敗吃掉後一個的收尾。

- [ ] **Step B2: 改 `package.json`**

`scripts` 加一行（放在 `spike:oopif` 之後，沿用既有三個 spike 的 esbuild 打包再交給 electron 的寫法）：

```json
    "spike:ax": "esbuild spikes/capture-ax.ts --bundle --platform=node --format=cjs --external:electron --outfile=.spike-out/capture-ax.cjs && electron .spike-out/capture-ax.cjs"
```

`dependencies` 的 SDK 改成精確版本（裁決 34）：

```json
    "@anthropic-ai/claude-agent-sdk": "0.3.258",
```

裁決 8 用的 `extra._meta['claudecode/toolUseId']` 是 SDK 的私有欄位，`^0.3.258` 允許的任何一次 patch 升版都可能讓 `request_handoff` 靜默拿不到 id。釘死之後，升版是一個要先重跑探針的決定，不是 `npm install` 的副作用。

- [ ] **Step B3: 改 `vitest.config.ts`**

第 17 到 18 行的排除項註解改掉（契約 §14）：

```ts
        // 純 Electron API 組裝，無可測邏輯
        'src/main/agent-view.ts',
```

`src/main/index.ts` 那一列的註解不動：「可測的工廠已抽到 session-options.ts」現在多一個 `startup.ts`，但那句話仍然成立。

- [ ] **Step B4: 跑全部測試與型別檢查**

```bash
npx tsc --noEmit -p tsconfig.json
npm run test
npm run test:coverage
```

預期：`tsc` 0 error；vitest 全綠；coverage Stmts ≥ 93、Branch ≥ 86（契約 §14 的判準）。`tsc` 已在 worktree 對 A 組加 B 組的改動實跑過，0 error。

- [ ] **Step B5: 提交**

```bash
git add src/main/index.ts package.json vitest.config.ts
git commit -m "feat: index.ts 接上 view tools 與 MCP server"
```

---

## C 組：實機 AX fixture（`spikes/capture-ax.ts` 與 `form.real.json`）

- [ ] **Step C1: 確認 `tests/fixtures/view/form.html` 的三個 `<label>` 沒有空白**

執行：`grep -n '<label>' tests/fixtures/view/form.html`

預期三行都是標籤文字直接接 `<input`，中間沒有空白（Task 4 依裁決 36 建檔時就是這樣）：

```html
      <label>電子郵件<input type="email" name="email" required /></label>
      <label>收件人<input type="text" name="recipient" value="王小明" /></label>
      <label>訂閱電子報<input type="checkbox" name="news" checked /></label>
```

若有空白，表示 Task 4 的執行者沒照 task-4.md 建檔：回頭修 Task 4 的 commit，不要在本 task 改它。理由是實跑量到的：留著空白時 Chromium 算出來的可及名稱是 `電子郵件 `（尾端一個空白），Task 4 的 `boxesFor()` 用「角色｜名稱」查 `FORM_BOXES`，查不到就不給矩形，`fixture 守衛` 那個案例的 `expect(boxesFor(nodes).size).toBe(FORM_BOXES.size)` 會從 8 掉到 5。頁面的其他部分一個字都不能動：`display: none` 的按鈕、沒有 alt 的 `<img>`、`disabled` 按鈕都是 Task 4 刻意放的，實機那份也要有它們。

- [ ] **Step C2: 建 `spikes/capture-ax.ts`**

完整內容如下（77 行）：

```ts
import { app, BaseWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachCdp } from '../src/main/cdp.js'
import { createAgentView } from '../src/main/agent-view.js'

/** 載入完成後再等一下，讓 AX 樹算完（圖片解碼、字型套用都會改變 ignored 狀態）。 */
const SETTLE_MS = 1500

const DEFAULT_PAGE = 'tests/fixtures/view/form.html'
const DEFAULT_OUT = 'tests/fixtures/ax/form.real.json'

interface AxNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value?: unknown }
  readonly name?: { readonly value?: unknown }
  readonly backendDOMNodeId?: number
}

function argOr(index: number, fallback: string): string {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  return args[index] ?? fallback
}

function label(node: AxNode): string {
  const role = typeof node.role?.value === 'string' ? node.role.value : '(無 role)'
  const name = typeof node.name?.value === 'string' ? node.name.value : ''
  return `${role}|${name}`
}

async function run(): Promise<void> {
  const pageArg = argOr(0, DEFAULT_PAGE)
  const outArg = argOr(1, DEFAULT_OUT)
  const pageUrl = pageArg.includes('://') ? pageArg : pathToFileURL(resolve(pageArg)).href
  const outPath = resolve(outArg)

  const win = new BaseWindow({ width: 1200, height: 800 })
  const agent = createAgentView()
  win.contentView.addChildView(agent)
  agent.setBounds({ x: 0, y: 0, width: 1200, height: 800 })

  await agent.webContents.loadURL(pageUrl)
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  const cdp = await attachCdp(agent.webContents)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('Accessibility.enable')
    const { nodes } = await cdp.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree')

    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify({ nodes }, null, 2)}\n`, 'utf8')

    console.log(`頁面：${pageUrl}`)
    console.log(`輸出：${outPath}`)
    console.log(`節點數：${nodes.length}`)
    console.log('--- ignored === false 且有 backendDOMNodeId 的節點 ---')
    for (const node of nodes) {
      if (node.ignored === false && node.backendDOMNodeId !== undefined) {
        console.log(`  ${label(node)}  backendDOMNodeId=${node.backendDOMNodeId}`)
      }
    }
  } finally {
    cdp.detach()
  }
  app.quit()
}

app
  .whenReady()
  .then(run)
  .catch((e: unknown) => {
    console.error('capture-ax 執行失敗：', e)
    app.exit(1)
  })
```

三個設計選擇。第一，兩個位置參數（頁面、輸出路徑）都有預設值，所以最常見的用法是 `npm run spike:ax` 不帶參數；之後要抓別的頁面（例如 §8.1 的跨站 iframe fixture）就 `npm run spike:ax -- tests/fixtures/view/cross-site.html tests/fixtures/ax/cross-site.real.json`。第二，`attachCdp` 只傳一個參數：這個腳本不訂閱事件，不需要 `onListenerError`，少一個參數就不會綁死 Task 1 的第二參數形狀。第三，印出「`ignored === false` 且有 `backendDOMNodeId`」的清單：Task 4 的候選門檻就是這兩條加角色白名單，抓完直接對著這份清單就看得出來有沒有漏掉節點，不必先跑測試。

- [ ] **Step C3: 跑 spike 產出 fixture**

```bash
npm run spike:ax
```

預期輸出（已在 worktree 用 Electron 44 實跑，macOS 26.6.2 arm64；`節點數` 與 `backendDOMNodeId` 兩欄可能因 Chromium 版本而異，角色與名稱不該變）：

```
頁面：file:///…/tests/fixtures/view/form.html
輸出：/…/tests/fixtures/ax/form.real.json
節點數：34
--- ignored === false 且有 backendDOMNodeId 的節點 ---
  RootWebArea|訂單確認  backendDOMNodeId=1
  heading|訂單  backendDOMNodeId=8
  generic|  backendDOMNodeId=9
  link|說明  backendDOMNodeId=20
  StaticText|   backendDOMNodeId=37
  image|商品圖  backendDOMNodeId=21
  StaticText|   backendDOMNodeId=38
  image|  backendDOMNodeId=25
  StaticText|訂單  backendDOMNodeId=29
  LabelText|  backendDOMNodeId=10
  LabelText|  backendDOMNodeId=13
  checkbox|訂閱電子報  backendDOMNodeId=17
  button|刪除  backendDOMNodeId=18
  StaticText|說明  backendDOMNodeId=36
  StaticText|電子郵件  backendDOMNodeId=30
  textbox|電子郵件  backendDOMNodeId=11
  StaticText|收件人  backendDOMNodeId=31
  textbox|收件人  backendDOMNodeId=14
  StaticText|刪除  backendDOMNodeId=34
  generic|  backendDOMNodeId=12
  generic|  backendDOMNodeId=15
  StaticText|王小明  backendDOMNodeId=32
```

驗收條件（不符合就是抓錯了，不要硬把測試改成通過）：

1. 八個角色名稱組合齊全：`heading|訂單`、`textbox|電子郵件`、`textbox|收件人`、`checkbox|訂閱電子報`、`button|刪除`、`link|說明`、`image|商品圖`、`image|`（最後一個名稱為空字串）。
2. 名稱尾端沒有多餘空白。有的話回頭看 Step C1 的三個 `<label>` 改了沒有。
3. `display: none` 的按鈕「隱藏」不在清單裡（實跑結果是整個節點不出現在 AX 樹）。
4. `nodes` 陣列順序不是前序（實跑第一筆是 `RootWebArea`，第二、三筆是兩個 `role: none` 的節點，第四筆才是 `heading`）。手寫 fixture 也刻意打亂，兩份都在釘同一條規則。
5. 檔案裡的 `checked` 是 `{ "type": "tristate", "value": "true" }`、`disabled` 是 `{ "type": "boolean", "value": true }`、`required` 是 `{ "type": "boolean", "value": true }`。task-4.md Step 1a 對 `checked` 的形狀原本標的是推論，這次實跑證實了字串版本。

`form.real.json` 的 `RootWebArea` 節點帶一個 `url` property，值是抓取那台機器上的 `file://` 絕對路徑。這不影響任何測試（`snapshot.ts` 只讀 `role`／`name`／`value`／`childIds`／`ignored`／`backendDOMNodeId` 與 §6 states 表列的 property），照原樣提交就好。

- [ ] **Step C4: 把實機 fixture 加進 Task 4 的測試**

`tests/view-tools/snapshot.test.ts` 只改一行：

```ts
const AX_FIXTURES = ['form.json', 'form.real.json'] as const
```

```bash
npx vitest run tests/view-tools/snapshot.test.ts
```

預期：從 39 個案例變成 45 個（`fixture 守衛` 的 `it.each` 加一個、`describe.each` 的五個案例對第二份 fixture 各再跑一次），全綠。已在 worktree 實跑：`Tests 45 passed (45)`。

這一步不需要另外寫測試：Task 4 的測試本來就是為了對兩份 fixture 各跑一次而寫的（`AX_FIXTURES` 的註解就是這樣說的），Task 14 的工作是把第二份餵進去並確認它真的過。實跑之前先跑一次 `AX_FIXTURES` 已加、fixture 還沒抓的狀態，會看到 `ENOENT: tests/fixtures/ax/form.real.json`，那就是這一組的紅。

- [ ] **Step C5: 提交**

```bash
git add spikes/capture-ax.ts tests/fixtures/ax/form.real.json tests/view-tools/snapshot.test.ts
git commit -m "test: 實機 AX fixture 與 capture-ax spike"
```

---

## D 組：實機驗收（`docs/RESULTS-05-b-view-tools.md`）

- [ ] **Step D1: 建跨站 iframe fixture**

裁決 34：同一個 host 的兩個 port 是同一個 site，Chromium 不會切成 OOPIF，測不到 offset 那條路徑。主頁走 `localhost`、iframe 走 `127.0.0.1` 才是跨站。

`tests/fixtures/view/cross-site-outer.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>跨站外層</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 0; }
      h1 { margin: 0; padding: 40px 60px; }
      iframe { display: block; margin-left: 137px; width: 480px; height: 240px; border: 1px solid #888; }
    </style>
  </head>
  <body>
    <h1>外層</h1>
    <iframe src="http://127.0.0.1:8182/cross-site-inner.html" title="內層"></iframe>
  </body>
</html>
```

`tests/fixtures/view/cross-site-inner.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>跨站內層</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 53px 71px; }
      #out { font-family: ui-monospace, Menlo, monospace; }
    </style>
  </head>
  <body>
    <button type="button" id="hit">內層按鈕</button>
    <p id="out">未點擊</p>
    <script>
      document.getElementById('hit').addEventListener('click', (e) => {
        document.getElementById('out').textContent = `已點擊 ${e.clientX},${e.clientY}`
      })
    </script>
  </body>
</html>
```

iframe 的 `margin-left` 與內層的 `padding` 都刻意取非零且互不相同的值：offset 算錯（例如漏加、或加成 iframe 的 border box 左上角而不是 content 左上角）時，點下去的座標會落在按鈕之外，`#out` 就還是「未點擊」。offset 為 0 的版面會讓正確與錯誤實作巧合同值，這是 Plan A 踩過的盲點。

起兩個服務（在 `tests/fixtures/view/` 底下各開一個終端機）：

```bash
python3 -m http.server 8181 --bind 127.0.0.1 -d tests/fixtures/view
python3 -m http.server 8182 --bind 127.0.0.1 -d tests/fixtures/view
```

主頁用 `http://localhost:8181/cross-site-outer.html` 開。兩個服務都綁 `127.0.0.1`，`localhost` 在 macOS 上解析到同一個位址，所以第一個服務用 `localhost` 名稱也連得到。

- [ ] **Step D2: 建 `docs/RESULTS-05-b-view-tools.md`**

格式沿 `docs/RESULTS-04-a-sdk-host.md`：檔頭記環境、每一組先寫檢查步驟再放結果表，表欄是「# / 操作 / 預期 / 結果 / 現象」。**「結果」與「現象」兩欄由執行者實測後填**，計畫不預先寫任何結果。完整模板如下：

````md
# Plan B 右窗格工具實機驗收結果

量測日期：<填>
機器：<填，例：macOS 26.6.2、arm64、16 GB>
Node / Electron / SDK 版本：<填，SDK 應為 0.3.258（裁決 34 已釘死）>
分支與起點：<填分支名與 HEAD>
量測方法：`npm run build` 之後 `YESCHEF_PROJECT_DIR=<拋棄式目錄> npx electron . --remote-debugging-port=9333`，
左窗格用 CDP `Runtime.evaluate` 送訊息與按按鈕，右窗格的實際狀態用同一個 CDP 連線讀，
主程序 log 導到檔案後 grep。本地 fixture 由 `python3 -m http.server` 起在 8181／8182 兩個 port。

判準（規格 §8.2）：25 項至少 23 項 ✓，且 #9 `view_click`、#12 `view_type`、#20 `request_handoff` 三項必須 ✓。

---

## A. 八個工具的成功路徑與進門檢查

### 檢查步驟

1. 對左窗格送訊息，請 agent 依序操作右窗格；每一項記下模型收到的工具回傳文字逐字。
2. 錯誤路徑的四項（#3、#4、#11、#16）直接請 agent 用指定的參數呼叫該工具。
3. `view_eval` 那兩項要看批准卡有沒有出現（`viewToolPolicy` 對 `view_eval` 回 `ask`）。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| 1 | `view_navigate` 到 `http://localhost:8181/cross-site-outer.html` | 回 `已到 <url>，標題 跨站外層` | | |
| 2 | `view_navigate` 到 `http://127.0.0.1:1/` | 回 `無法開啟 <url>：<errorText>` | | |
| 3 | `view_navigate` 到 `ftp://example.com/` | 回 `只接受 http、https、file 開頭的網址` | | |
| 4 | `view_navigate` 到 projectDir 外的 `file://` | 回 `只允許開啟 <projectDir> 底下的本地檔案` | | |
| 5 | `view_snapshot` 不帶 scope（預設 viewport） | 只列可視節點，`[page] <title> <url>` 開頭 | | |
| 6 | `view_snapshot` 帶 `scope: 'full'` | 節點數不少於 #5，ref 從 `s<id>-e0` 起連續遞增，heading／image 沒有 ref | | |
| 7 | 對節點數超過 400 的頁面 `view_snapshot` | 尾端出現 `（還有 N 個節點未列出，請縮小範圍或捲動後重拍）` | | |
| 8 | `view_screenshot` | 回一張 PNG，`可視範圍 <w>×<h>，網址 <url>`，`w` 不超過 1280 | | |
| 9 | `view_click` 點 form.html 的「刪除」以外的按鈕（必須 ✓） | 回 `已點擊 button "<name>"`，頁面真的有反應 | | |
| 10 | `view_click` 點「說明」連結 | 回 `已點擊 link "說明"` 加一行 `網址變為 <url>` | | |
| 11 | 先手動點頁面讓 ref 失效，再用舊 ref `view_click` | 回 `snapshot s<id> 已過期（原因：userInput），請先呼叫 view_snapshot` | | |
| 12 | `view_type` 對「收件人」輸入文字（必須 ✓） | 回 `已輸入 <N> 字元到 textbox "收件人"`，欄位值變成 <原值 + 新字> | | |
| 13 | `view_type` 帶 `clear: true`（裁決 12） | 欄位只剩新輸入的字，舊的「王小明」不見 | | |
| 14 | `view_type` 帶 `submit: true` | 表單送出，回傳多一行 `網址變為 <url>` | | |
| 15 | `view_press` 依序按 `Tab`、`Enter`、`Backspace` | 各回 `已按 <key>`，焦點與內容的變化與預期一致 | | |
| 16 | `view_press` 按 `F13` | 回 `不支援的按鍵 F13，可用：<白名單>` | | |
| 17 | `view_eval` 求值 `[1, NaN, 1/0].join(',')` 與 `NaN` | 前者回字串，後者回 `NaN`（`unserializableValue`，裁決 28） | | |
| 18 | `view_eval` 任一次呼叫 | 每一次都出現批准卡，卡片顯示完整表達式 | | |
| 19 | `view_eval` 求值長度超過 8192 字元的字串 | 截到 8192 再接 `（已截斷，原長 <N> 字元）` | | |

## B. 交接、跨站 iframe 與工具排程

### 檢查步驟

1. #20 走完整流程：agent 呼叫 `request_handoff` → 左窗格出現 HandoffCard → 人在右窗格改東西 → 按「我好了」→ agent 再 `view_snapshot` 看得到人的改動。
2. #22 啟動時加環境變數 `MCP_TOOL_TIMEOUT=5000`，`request_handoff` 之後等超過 5 秒才按按鈕。
3. #23 用 Step D1 的跨站 fixture；先 `Target.getTargets()` 確認 iframe target，再讓 agent 點內層按鈕。
4. #24 在同一則訊息裡要求 agent 先 `view_navigate` 再 `view_snapshot`。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| 20 | `request_handoff` 全流程（必須 ✓） | 卡片顯示理由與「我好了」；按下後改「已通知」；工具回 `使用者已完成，目前網址 <url>`；agent 後續 snapshot 看得到人的改動 | | |
| 21 | 前一筆還在等時再叫一次 `request_handoff` | 回 `已有一筆交接等待中（<reason>），請等使用者完成` | | |
| 22 | `MCP_TOOL_TIMEOUT=5000` 下 `request_handoff` 等超過 5 秒（裁決 32） | 工具沒有被 SDK 提前中止，按下按鈕後照常回 `使用者已完成…` | | |
| 23 | 跨站 iframe：`Target.getTargets()` 有 `type === 'iframe' && attached === true`；`view_click` 點內層按鈕（裁決 34、9） | target 出現；內層 `#out` 變成 `已點擊 <x>,<y>`，座標落在按鈕範圍內 | | |
| 24 | 同一則訊息叫 `view_navigate` 加 `view_snapshot`（裁決 33） | 兩個工具依序執行，snapshot 拍到的是導航後的新頁 | | |
| 25 | 手動點右窗格三次、按幾個鍵，再 `view_snapshot` | 第一行是插手摘要（`使用者在你上次操作後點了 3 次、按了 N 個鍵，…`），舊 ref 已失效 | | |

## C. 補充記錄（不計入 25 項判準）

| 項目 | 要記什麼 | 結果 |
|---|---|---|
| 裁決 26 | 跨站 iframe 的 `Target.getTargets()` 回傳裡，父 target 是記在 `parentId` 還是 `parentFrameId`？兩個都有值嗎？把該筆 targetInfo 的 JSON 原樣貼上 | |
| 規格 §10 | `Accessibility.getFullAXTree` 耗時：MDN 首頁與 GitHub PR 頁各 5 次的毫秒數。超過 1 秒要改 `Accessibility.queryAXTree` 分段取 | |
| 裁決 17 | 讓 `attachCdp` 失敗（例如啟動前先用別的 client 佔住 debugger），確認視窗照開、左窗格可用、console 有 `[yeschef] 右窗格工具停用：<message>` | |
| 裁決 11 | 工具等待中切換對話，確認等待中的工具收到 `對話已結束` | |
| 規格 §7 | 右窗格頁面的 `target="_blank"` 連結仍在原地導航，沒有跳出新視窗 | |
| 規格 §10 | `view_type` 對 contenteditable 與一個自訂輸入元件是否有效 | |

## D. 待辦與偏差

（實測與預期不符的項目逐條寫在這裡：現象、判斷是缺陷還是預期外的環境因素、後續動作。全部相符就寫「無」。）
````

- [ ] **Step D3: 執行實機驗收並填表**

照模板的檢查步驟跑完 25 項與 6 項補充記錄，把「結果」欄填成 ✓／✗，「現象」欄寫觀察到的逐字訊息。判準未達（少於 23 項 ✓，或三個必測項有任一項 ✗）時不要改判準，把偏差寫進 D 節並停下來回報。

- [ ] **Step D4: 提交**

```bash
git add tests/fixtures/view/cross-site-outer.html tests/fixtures/view/cross-site-inner.html docs/RESULTS-05-b-view-tools.md
git commit -m "docs: 右窗格工具實機驗收結果與跨站 fixture"
```

---

## E 組：規格 §11 修訂紀錄

- [ ] **Step E1: 回寫 `docs/specs/2026-09-03-yeschef-b-view-tools-design.md` §11**

裁決 18 指定 §4、§6.1、§6.3、§6.4、§7、§9 六節的差異由 Task 14 回寫；逐節對照契約之後另外找到 §5（裁決 12）與 §8.1（裁決 34）各一條，一併列入。只列真的有差異的，契約與規格說法一致的地方不列。

§11 現有的表頭與初版那一列不動，在初版那一列下面接以下 22 列（日期都是 `2026-09-03`）：

```md
| 2026-09-03 | §4 | `AxNode.ref` 原為必填 → 改選填：只有可操作角色配 ref，heading／image 沒有 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `AxNode` 加 `backendNodeId`、`sessionId`：`view_click`／`view_type` 要拿 backendNodeId 對該 frame 的 session 下 CDP 指令 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `RefTable.entries` 的值原為 `{ sessionId?, backendNodeId }` → 加 `role`、`name`：回傳文字 `已點擊 <role> "<name>"` 要用 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `Snapshot` 加 `title`、`scope`，`FrameSnapshot` 加 `frameId`、`url`：snapshot 文字的 `[page] <title> <url>` 與 `[iframe k] <url>` 要用 | 契約 §5、裁決 18 |
| 2026-09-03 | §4 | `HandoffPort`（`expect`／`done`）→ 由 `ViewTools`（`server`／`autoAllow`／`handoffDone`／`abortPending`／`dispose`）取代：`expect()` 不需要，toolUseId 由工具 handler 的 `extra` 直接取 | 裁決 3、8 |
| 2026-09-03 | §4 | ref 的 `e<n>` 原文未訂起始值（範例是 `s12-e7`）→ 定為從 0 起（`s12-e0`），structural 節點不佔號 | 裁決 22 |
| 2026-09-03 | §5 | `view_type` 的 clear 原為「送 Meta+A 與 Backspace 的 keyDown／keyUp」→ keyDown `a` 要帶 `commands: ['selectAll']`：macOS 的 Meta+A 不會進 renderer 的編輯指令 | 裁決 12 |
| 2026-09-03 | §6.1 | 原文「啟用 `Page`、`DOM`、`Network`、`Accessibility` 四個域」→ `Page`／`Runtime` 由 cdp.ts 在 root 啟用，`DOM`／`Network`／`Accessibility` 由 watch.ts 在 root 與每個 iframe session 啟用；OOPIF session 不需 `Page.enable` | 裁決 5、24 |
| 2026-09-03 | §6.3 | 插手摘要原文只有一種句型 → 三種變體：網址變、網址相同時改成 `網址仍是 <url>`、`navigations` 為 0 且網址相同時省略網址那段，避免出現「網址從 A 變成 A」 | 裁決 15 |
| 2026-09-03 | §6.4、§9 | 原文「fold 把 `tool-use` 投影成 HandoffBlock」→ `fold.ts` 不動，renderer 以 `block.name === REQUEST_HANDOFF_TOOL` 判斷，卡片走 `Turn`／`Conversation` 新增的 `renderToolOverride` | 裁決 2 |
| 2026-09-03 | §6.4、§9 | 原文「`canUseTool` 放行 `request_handoff` 時把 `toolUseID` 交給 `handoff.ts`」→ toolUseId 改由工具 handler 的 `extra._meta['claudecode/toolUseId']` 取（探針已證實）；`agent-host.ts` 只多一個純政策的 `autoAllow?` dep，不認識 handoff | 裁決 3、8 |
| 2026-09-03 | §6.4 | 原文「id 對不上（過期的卡片）就忽略並 `logError`」→ 改記進 `earlyDone` FIFO（上限 8），之後同 id 的 `begin()` 立即回 `done`：按鈕按一次就停用，早到的 done 不該讓 agent 白等 10 分鐘 | 裁決 31 |
| 2026-09-03 | §7 | 原文「非 http／https／file 的網址由 zod 進門擋下」→ zod shape 只宣告型別，值檢查在 controller，錯誤訊息才會是 `errors.ts` `MSG` 表的字 | 裁決 10 |
| 2026-09-03 | §7 | 原文「`view_eval` 丟例外回 `exceptionDetails.text`」→ 先用 `exceptionDetails.exception?.description`，沒有才用 `.text` | 裁決 28 |
| 2026-09-03 | §7 | 原文「`AbortSignal` 從 agent-host 的 teardown 傳進 controller」→ 改由 `ipc-bridge.ts` 在 `interrupt-query`／`teardown-query` effect 之前呼叫 `viewTools.abortPending`，server.ts 內部再用 AbortController 傳給 controller | 裁決 11 |
| 2026-09-03 | §7 | 原文「未附著 N 由 frame 樹的 iframe 數減 `getAttachedTargets()` 數」→ N 是 AX 樹抓不到的 frame 數（root 與每個 iframe target 的 `Page.getFrameTree` 聯集減去有 AX 樹的） | 裁決 6 |
| 2026-09-03 | §7 | 原文「`cdp.send` 逾時 10 秒」→ 逾時改在 controller 的 `call()` 做，`cdp.ts` 不加逾時邏輯 | 裁決 14 |
| 2026-09-03 | §8.1 | 原文「兩個本地 port 模擬跨站 iframe」→ 同一 host 不同 port 是同一個 site，Chromium 不會切成 OOPIF；改成 `localhost` 主頁加 `127.0.0.1` iframe | 裁決 34 |
| 2026-09-03 | §9 | 原文「`src/main/cdp.ts` 不動」→ 加 `onEvent`、`AttachedTargetInfo.sessionId`、`attachCdp(wc, opts?)`：`CdpSession` 原本沒有事件訂閱，watch 與 settle 需要 CDP 事件 | 裁決 1 |
| 2026-09-03 | §9 | 原文 `SessionOptions` 的 `mcpServers?: Record<string, McpSdkServerConfigWithInstance>` → `Readonly<Record<string, McpServerConfig>>`（SDK `Options.mcpServers` 的型別），且沒給 `mcpServers` 時 options 連這個 key 都不出現 | 契約 §11.1 |
| 2026-09-03 | §9 | 原文「`ipc-bridge.ts` 轉給 `HandoffPort.done(toolUseId)`」→ 轉給 `ViewToolHooks.handoffDone(toolUseId)`；沒有 view tools 時只 `logError` | 裁決 3、契約 §11.4 |
| 2026-09-03 | §9 | 原文「`HandoffCard.tsx` 樣式沿用 ApprovalCard」→ 自己一份 `HandoffCard.css`，`ApprovalCard.css` 不動 | 契約 §12、裁決 25 |
```

- [ ] **Step E2: 確認沒有改到規格的其他章節**

```bash
git diff --stat docs/specs/2026-09-03-yeschef-b-view-tools-design.md
```

預期：只有 §11 那一段被加了 22 行，`1 file changed, 22 insertions(+)`。規格本文不改：修訂紀錄的用途就是留下「原文寫什麼、為什麼改」，直接把本文改掉會讓這份紀錄失去對照。

- [ ] **Step E3: 提交**

```bash
git add docs/specs/2026-09-03-yeschef-b-view-tools-design.md
git commit -m "docs: 規格 §11 補上契約定稿與原文的 22 條差異"
```

---

## 收尾檢查

- [ ] **Step F1: 全案驗收**

```bash
npx tsc --noEmit -p tsconfig.json
npm run test
npm run test:coverage
```

預期：`tsc` 0 error、vitest 全綠、Stmts ≥ 93、Branch ≥ 86（契約 §14）。覆蓋率沒過就看 `src/main/view-tools/` 底下哪個檔案的分支沒被走到，補測試，不要調判準也不要把檔案加進 exclude。

- [ ] **Step F2: 確認 exclude 清單只有四項**

`vitest.config.ts` 的 `coverage.exclude` 應該仍是四項：`src/**/*.d.ts`、`src/renderer/main.tsx`、`src/main/index.ts`、`src/main/agent-view.ts`。B 新增的十幾個檔案一個都不在裡面（`startup.ts` 就是為了不讓接線邏輯躲進 `index.ts` 的排除項才存在的）。
