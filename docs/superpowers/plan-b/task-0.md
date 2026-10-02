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
