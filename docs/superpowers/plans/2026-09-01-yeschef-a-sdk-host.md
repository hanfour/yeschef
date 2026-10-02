# yeschef A：SDK 宿主與對話渲染 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Agent SDK 取代 PTY 與 xterm.js，做出逐字串流的對話渲染、內嵌批准 UI 與 Recents 側邊欄，讓左中兩窗格達到可每天使用的程度。

**Architecture:** 主程序用 `query()` 宿主 agent，事件經正規化層轉成本專案自訂的窄 `Event` 型別後，以幀為單位合併推給 renderer；renderer 用純函式 `fold()` 把事件投影成畫面。`canUseTool` 在主程序觸發，透過 IPC 的待決 promise 向 renderer 取得批准。歷史對話走 `getSessionMessages` 加另一個轉接器，之後與 live 共用同一條渲染路徑。

**Tech Stack:** Electron、TypeScript、React、`react-markdown` + `remark-gfm` + `rehype-highlight`、`@anthropic-ai/claude-agent-sdk`、Vitest

**Spec:** `docs/specs/2026-09-01-yeschef-a-sdk-host-design.md`

## Global Constraints

以下為專案層級要求，每個 task 的驗收隱含包含本節。數值直接引自規格。

- 平台只做 macOS。
- 生 agent 時 cwd 必須是使用者實際工作的專案目錄，**不可**用 app 自身目錄。原因：`~/.claude/usage-data/ingest-jsonl.mjs` 的排除規則同時作用在 session cwd 與碰到的檔案路徑，超過 50% 落在 `EXCLUDE_PATHS` 就整場不計入公司評量。這是整個專案的前提。
- **不准用 `void` 吞 promise**。專案規則 Never silently swallow errors；規格 §8 明訂不得靜默失敗。
- **不得靜默丟棄認不出來的事件。** 一律產出 `unknown` Event 並在 UI 渲染成可展開的原始 JSON 卡片。
- 資料不可變：函式回傳新物件，不修改參數。
- **每個 task 提交時 `npm run typecheck` 與 `npm test` 必須全綠。** 中間狀態不准壞掉。這條決定了 PTY 殘留（`pty-host.ts`／`spawn-args.ts`／`preload/terminal.ts`）的刪除時機：Task 0 排在最前面一次拆掉並同時把 `main/index.ts` 改成最小外殼，其他 task 不各自刪一點。
- 單一檔案典型 200 到 400 行，上限 800 行。
- 不使用 `dangerouslySetInnerHTML` 渲染模型產出的內容。
- 不得使用 `dangerouslySkipPermissions` 或任何權限旁路。
- 右窗格（`src/main/agent-view.ts`）與 CDP（`src/main/cdp.ts`）**本計畫完全不動**，它們屬子專案 B。
- **每個含測試的 task，驗收步驟必須包含一次突變測試**：把實作換成最簡單的錯誤版本（例如 `return ''`、刪掉某個分支），跑測試確認會紅，還原後確認回綠，兩次輸出都貼進報告。
  理由：本計畫在動工前的跨模型審查中，三個 task 的測試全部被證明可被錯誤實作滿足（`return ''` 通過 157 個前綴案例；刪掉圍欄判斷通過全部 9 個測試；刪掉整段 `stream_event` 處理通過全部 13 個測試）。「有測試」與「測試有用」是兩件事，而唯一能分辨的方式是把實作弄壞看它會不會紅。

## 檔案結構

2026-09-02 依契約裁決 6、9、14、20、21 修訂：狀態機搬到 main、Electron 維持兩欄、`SessionState` 型別放 shared、跨專案 resume 帶原 cwd、標題列顯示當前目錄。

2026-09-02 晚間依 codex 三份審查（介面一致、執行順序、規格覆蓋）與契約裁決 22 到 28 再修訂：`reset` 事件決定畫面何時清空（不靠 `session:state`）、`dispatch` 的 effects 跨 action 串行、SDK 由 Task 7 加裝並釘 0.3.258、事件累積在 renderer（規格 §3 同步修訂）、`MarkdownBoundary` 讓解析失敗退回純文字、前綴測試改用 9617 字的規格複本、批准請求帶 `toolUseId` 改成 id 比對（裁決 11 作廢）。Task 3 的 `normalizeLive`／`resetLiveNormalizer` 刪除，只剩純函式 `stepLive`，測試共用 `tests/helpers/live-events.ts`。

```
src/
├── main/
│   ├── index.ts             視窗與兩窗格組裝（改寫；requireProjectDir 守衛、createSessionOptionsFactory）
│   ├── layout.ts            左右兩欄幾何（不動；側邊欄是 renderer 內的 CSS grid）
│   ├── agent-view.ts        右窗格（不動）
│   ├── cdp.ts               CDP（不動）
│   ├── session-args.ts      SDK options 組裝，含 cwd/appDir 守衛（取代 spawn-args.ts）
│   ├── session-machine.ts   idle/live/viewing 狀態機（純函式；main 持有，renderer 只讀狀態）
│   ├── agent-host.ts        query() 生命週期、事件合併、interrupt
│   ├── approval.ts          canUseTool 的待決 promise 註冊表
│   ├── session-store.ts     listSessions / getSessionMessages 的包裝，歷史載入尾端補 session-end，cwdOf（裁決 20）
│   └── ipc-bridge.ts        持有 SessionState，收意圖、跑 transition、照 effects 順序執行、推送事件
├── preload/
│   └── bridge.ts            取代 terminal.ts，提供 window.yeschef（含 projectDir，裁決 21）
├── renderer/
│   ├── main.tsx             掛載
│   ├── App.tsx              標題列＋側邊欄＋對話的 CSS grid，組合三個 hook，含 Composer 輸入框
│   ├── App.css              版面樣式（--sidebar-width、.title-bar、.composer）
│   ├── global.d.ts          window.yeschef 的型別宣告
│   ├── approvals.ts         批准請求與 tool block 的對應（純函式，以 toolUseId 比對，裁決 28）
│   ├── title.ts             標題列文字 titleFor（純函式，裁決 21）
│   ├── hooks/
│   │   ├── useConversation.ts   訂閱事件與狀態，收到 reset 才清空（裁決 22），fold 成 ConversationView
│   │   ├── useApprovals.ts      待決批准清單
│   │   └── useSessions.ts       Recents 清單載入
│   └── components/
│       ├── Conversation.tsx / Turn.tsx / ToolCall.tsx / ThinkingBlock.tsx / Conversation.css
│       ├── block-equals.ts      Block 淺比較（Turn 的 memo 用，純函式）
│       ├── ApprovalCard.tsx / ApprovalCard.css
│       ├── Markdown.tsx / Markdown.css   含 MarkdownBoundary（解析失敗退回純文字，裁決 26）
│       ├── Recents.tsx / Recents.css
│       └── relative-time.ts     「3 分鐘前」相對時間（純函式）
└── shared/
    ├── ipc.ts               頻道、payload 型別、執行期驗證、PROJECT_DIR_ARG（改寫）
    ├── session-state.ts     SessionState 型別（main 與 renderer 共用）
    ├── events.ts            Event 型別與兩個正規化轉接器（stepLive／normalizeHistory，皆為純函式）
    ├── fold.ts              Event[] → ConversationView（純函式）
    └── markdown-stream.ts   未完成 markdown 的推測性收尾（純函式）
tests/
├── helpers/live-events.ts          liveEvents()：從 INITIAL_CURSOR 起用 stepLive 逐則歸約（Task 3 建立，Task 4／4B 共用）
└── fixtures/markdown/real-doc.md   規格文件的一次性複本，前綴測試的真實文件（裁決 27）
```

`events.ts`、`fold.ts`、`markdown-stream.ts` 放 `shared/` 而非 `renderer/`：它們是純函式、無 DOM 依賴，放共用處讓主程序側的測試也能直接引用，且未來若要在主程序做事件摘要不必搬家。

`shared/` 不得 import `main/` 或 `renderer/`；`renderer/` 不得 import `main/`。

## 作廢清單

以下檔案在本計畫中刪除，它們的功能由 SDK 取代：

- `src/main/pty-host.ts`
- `src/renderer/terminal.ts`、`src/renderer/terminal.css`
- `src/main/spawn-args.ts`（由 `session-args.ts` 取代，驗證邏輯保留）
- `tests/spawn-args.test.ts`（由 `tests/session-args.test.ts` 取代）
- `src/preload/terminal.ts`（由 `preload/bridge.ts` 取代）
- `node-pty`、`@xterm/xterm`、`@xterm/addon-fit` 相依（package.json 移除；`allowScripts` 裡的 `node-pty@1.1.0` 一併拿掉）。刪檔與移除相依全部集中在 Task 0

`spikes/` 底下三支腳本與 `docs/RESULTS-*.md` 保留不動，它們是已完成的驗證紀錄。

---

---

### Task 0: 拆除 PTY 殘留，主程序改成最小外殼

第一個 task 先拆不先建。理由是 Global Constraints 要求每個 task 提交時 typecheck 與測試全綠，而 PTY 時代的檔案彼此 import（`index.ts` → `pty-host.ts` → `spawn-args.ts`；`index.ts` 與 `preload/terminal.ts` → `shared/ipc.ts` 的 PTY 頻道）。若讓後面的 task 各刪一點，Task 1 刪 `spawn-args.ts` 會讓 `pty-host.ts` 編譯失敗，Task 8 改寫 `shared/ipc.ts` 會讓 `index.ts` 編譯失敗。一次拆掉，後面每個 task 都站在乾淨的地基上。

拆完的 `index.ts` 只做四件事：開視窗、建左右兩個 `WebContentsView`、套 `splitBounds` 版面、載入左邊的 renderer 與右邊的網址。沒有 IPC、沒有 agent。Task 8 會在這個外殼上接 `createIpcBridge`。

`YESCHEF_PROJECT_DIR` 守衛暫時消失是刻意的：本 task 之後主程序不會生任何 claude 程序，守衛沒有對象。Task 8 接 agent-host 時把它接回去（該 task 的 Files 與驗收清單都有這一條）。

`shared/ipc.ts` 與 `tests/ipc.test.ts` **不動**：它們是純函式、沒人 import 也照樣編譯與通過，Task 8 會整支改寫。本 task 只刪有 Electron 或 node-pty 相依的檔案。

**Files:**
- Modify: `src/main/index.ts`（整支改寫成最小外殼，見 Step 2）
- Create: `src/preload/bridge.ts`（空殼，讓 preload 建置鏈有效；Task 8 填內容）
- Modify: `src/renderer/index.html`（佔位頁，Task 9 整份改寫）
- Modify: `electron.vite.config.ts`（preload input 改 `bridge.ts`）
- Modify: `vitest.config.ts`（coverage include 拿掉 `spawn-args.ts`）
- Modify: `package.json`（移除 `node-pty`、`@xterm/xterm`、`@xterm/addon-fit`、`@electron/rebuild`，與 `allowScripts` 的 `node-pty@1.1.0`）
- Delete: `src/main/pty-host.ts`
- Delete: `src/main/spawn-args.ts`、`tests/spawn-args.test.ts`
- Delete: `src/preload/terminal.ts`
- Delete: `src/renderer/terminal.ts`、`src/renderer/terminal.css`

**Interfaces:**
- Consumes: `splitBounds`（`src/main/layout.ts`，不動）、`createAgentView`（`src/main/agent-view.ts`，不動）
- Produces: `createWindow(): BaseWindow`（`src/main/index.ts`）。Task 8 在 `createWindow` 內部接 bridge，介面不變

本 task 沒有新測試，突變測試不適用。驗收靠 typecheck、既有測試、`electron-vite build` 與一次手動啟動。

- [ ] **Step 1: 刪檔與移除相依**

```bash
git rm src/main/pty-host.ts src/main/spawn-args.ts tests/spawn-args.test.ts \
       src/preload/terminal.ts src/renderer/terminal.ts src/renderer/terminal.css
npm uninstall node-pty @xterm/xterm @xterm/addon-fit @electron/rebuild
```

`@electron/rebuild` 只為 node-pty 的原生模組重建而裝，沒有 script 引用它（`grep rebuild package.json` 只會命中 devDependencies 那一行），一併移除。

`package.json` 的 `allowScripts` 區塊手動拿掉 `"node-pty@1.1.0": true` 那一行。`npm uninstall` 不會動這個自訂欄位。

Run: `npm run typecheck`
Expected: FAIL，`src/main/index.ts` 找不到 `./pty-host.js`。這是預期的中間狀態，Step 2 修。

- [ ] **Step 2: 改寫 `src/main/index.ts`**

整支換成：

```typescript
import { app, BaseWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import { splitBounds } from './layout.js'
import { createAgentView } from './agent-view.js'

const DEFAULT_RATIO = 0.5
const INITIAL_AGENT_URL = 'https://example.com'

/** 建一個帶失敗 URL 與訊息的本地錯誤頁，給窗格 loadURL/loadFile 失敗時用。 */
function buildErrorPageUrl(failedUrl: string, message: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { font: 14px ui-monospace, Menlo, monospace; background: #12140f; color: #d8dcd4; padding: 2rem; }
    h1 { font-size: 16px; }
    code { color: #f0a0a0; word-break: break-all; }
  </style><h1>[yeschef] 頁面載入失敗</h1><p>URL：<code>${escape(failedUrl)}</code></p><p>${escape(message)}</p>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function createConversationView(): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
}

function loadRenderer(view: WebContentsView): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    view.webContents.loadURL(rendererUrl).catch((err: unknown) => {
      console.error('[yeschef] 左窗格載入失敗:', rendererUrl, err)
    })
    return
  }
  const rendererFile = join(import.meta.dirname, '../renderer/index.html')
  view.webContents.loadFile(rendererFile).catch((err: unknown) => {
    console.error('[yeschef] 左窗格載入失敗:', rendererFile, err)
  })
}

function loadAgentPage(view: WebContentsView, url: string): void {
  view.webContents.loadURL(url).catch((err: unknown) => {
    console.error('[yeschef] 右窗格載入失敗:', url, err)
    const message = err instanceof Error ? err.message : String(err)
    if (view.webContents.isDestroyed()) return
    view.webContents.loadURL(buildErrorPageUrl(url, message)).catch((e: unknown) => {
      console.error('[yeschef] 右窗格錯誤頁也載入失敗:', e)
    })
  })
}

export function createWindow(): BaseWindow {
  const win = new BaseWindow({ width: 1600, height: 900, titleBarStyle: 'hiddenInset' })
  const conversationView = createConversationView()
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

  loadRenderer(conversationView)
  loadAgentPage(agentView, INITIAL_AGENT_URL)
  return win
}

app.whenReady().then(() => {
  createWindow()
}).catch((err: unknown) => {
  console.error('[yeschef] 應用初始化失敗:', err)
  process.exit(1)
})

app.on('window-all-closed', () => {
  app.quit()
})
```

左窗格的變數從 `terminalView` 改名 `conversationView`：它之後裝的是對話，不是終端機。

- [ ] **Step 3: preload 空殼、renderer 佔位、建置設定**

`src/preload/bridge.ts`：

```typescript
// Task 8 在這裡用 contextBridge 曝露 window.yeschef。
// 目前刻意留空：renderer 尚無 IPC 需求，先讓 preload 的建置鏈維持有效。
export {}
```

`src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>yeschef</title>
  </head>
  <body>
    <div id="root">renderer 由 Task 9 接手</div>
  </body>
</html>
```

`electron.vite.config.ts` 的 preload input：

```diff
-        input: 'src/preload/terminal.ts',
+        input: 'src/preload/bridge.ts',
```

`vitest.config.ts` 的 coverage include 拿掉 `'src/main/spawn-args.ts',` 那一行。

- [ ] **Step 4: 驗證三件事**

Run: `npm run typecheck`
Expected: 無錯誤。

Run: `npm test`
Expected: PASS。總數比上一次少 12（`spawn-args.test.ts` 的 12 條），其餘 47 條不變。把實際數字記進報告。

Run: `npm run build`
Expected: 成功，`out/preload/bridge.cjs` 存在（`ls out/preload/`）。

手動啟動一次：`npm run start`。預期看到一個視窗，左半是「renderer 由 Task 9 接手」的白底文字，右半是 example.com。關掉視窗程序結束。截圖或用一句話寫進報告。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor: 拆除 PTY 與 xterm 殘留，主程序改成兩窗格最小外殼"
```

`git add -A` 在這個 task 是刻意的：刪檔、改設定、改 lockfile 都要進同一個提交。提交前 `git status` 確認沒有多餘的檔案（`out/` 與 `.spike-out/` 已在 `.gitignore`）。

---

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

---

### Task 2: 未完成 markdown 的推測性收尾

逐字串流的主要技術風險。

**跨模型審查（2026-09-02）對本 task 的發現，已納入下方測試：**

原本的四條斷言全是否定式（沒有奇數圍欄／反引號／粗體、尾端沒有半列表格），因此 `return ''` 通過全部 157 個前綴案例。另有一個把「圍欄內外之分」整個拿掉的實作通過全部 9 個測試，**包括那條名為「圍欄內的反引號不算行內標記」的測試**，因為它唯一的斷言在數圍欄行數，跟反引號無關。

修法是加一條肯定式斷言（輸出必須保留輸入的完整行），並把圍欄那條改成真的檢查內容。

**Files:**
- Create: `src/shared/markdown-stream.ts`
- Create: `tests/markdown-stream.test.ts`
- Create: `tests/fixtures/markdown/real-doc.md`

**Interfaces:**
- Consumes: 無
- Produces: `function closeIncomplete(text: string): string`

- [ ] **Step 1: 準備真實文件 fixture（裁決 27）**

```bash
mkdir -p tests/fixtures/markdown
cp docs/specs/2026-09-01-yeschef-a-sdk-host-design.md tests/fixtures/markdown/real-doc.md
```

這是本 task 動工當下的完整複本，`cp` 一次，之後不跟著規格改：規格文件後續再修訂，這份 fixture 維持原樣，前綴測試的案例數才不會隨規格變動而跟著變。

Run: `wc -m tests/fixtures/markdown/real-doc.md`
Expected: 9617（2026-09-02 實測）。規格 §9 要求「一份約 3000 字的真實文件」，這份文件的字數遠超規格要求的規模，含表格、圍欄、清單、粗體、行內程式碼。

- [ ] **Step 2: 寫失敗的測試**

`tests/markdown-stream.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { closeIncomplete } from '../src/shared/markdown-stream.js'

/** 手寫文件：刻意涵蓋四條規則各自的觸發條件 */
const CRAFTED = [
  '# 標題',
  '',
  '這是一段**粗體**與 `行內程式碼` 的文字。',
  '',
  '| 欄位 | 說明 |',
  '|---|---|',
  '| foo | 第一列 |',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '結尾，含 `token` 與 **強調**。',
].join('\n')

/** 真實回答：從錄下的事件流取出模型實際產生的回答 */
const REAL_ANSWER: string = (() => {
  const lines = readFileSync('tests/fixtures/events/03-sdk-live-stream.jsonl', 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const texts: string[] = []
  for (const d of lines) {
    if (d['type'] !== 'assistant') continue
    const msg = d['message'] as Record<string, unknown> | undefined
    for (const b of (msg?.['content'] as Record<string, unknown>[] | undefined) ?? []) {
      if (b['type'] === 'text') texts.push(String(b['text']))
    }
  }
  return texts.join('\n\n')
})()

/**
 * 真實文件：規格文件的完整複本（裁決 27，Step 1 準備好的 fixture）。
 * 規格 §9 要求「一份約 3000 字的真實文件產生約 3000 個案例」，這裡達到規格的規模。
 */
const REAL_DOC: string = readFileSync('tests/fixtures/markdown/real-doc.md', 'utf8')

const fenceLines = (s: string): number => s.split('\n').filter((l) => l.startsWith('```')).length

const inlineTicks = (s: string): number => {
  let inFence = false
  let n = 0
  for (const line of s.split('\n')) {
    if (line.startsWith('```')) { inFence = !inFence; continue }
    if (!inFence) n += (line.match(/`/g) ?? []).length
  }
  return n
}

const boldMarks = (s: string): number => (s.match(/\*\*/g) ?? []).length
const lastLine = (s: string): string => s.split('\n').at(-1) ?? ''

/** 輸入的所有「完整行」（最後一行以外）必須原樣保留在輸出開頭 */
const completeLinesOf = (s: string): string => {
  const lines = s.split('\n')
  return lines.length <= 1 ? '' : lines.slice(0, -1).join('\n')
}

describe('closeIncomplete', () => {
  it('真實回答取得到內容（防止 fixture 變動後測試空跑）', () => {
    expect(REAL_ANSWER.length).toBeGreaterThan(200)
  })

  it('真實文件達到規格 §9 的規模（防止 fixture 變動後測試空跑）', () => {
    expect(REAL_DOC.length).toBeGreaterThanOrEqual(3000)
  })

  it('完整文件原樣通過', () => {
    expect(closeIncomplete(CRAFTED)).toBe(CRAFTED)
    expect(closeIncomplete(REAL_ANSWER)).toBe(REAL_ANSWER)
    expect(closeIncomplete(REAL_DOC)).toBe(REAL_DOC)
  })

  it('未收尾的圍欄會被補上，且原始內容保留', () => {
    const src = '```ts\nconst x = 1'
    const out = closeIncomplete(src)
    expect(fenceLines(out) % 2).toBe(0)
    expect(out.startsWith(src)).toBe(true)
  })

  it('寫到一半的表格列會被扣住，但前面的列保留', () => {
    const out = closeIncomplete('| a | b |\n|---|---|\n| foo')
    expect(out).toBe('| a | b |\n|---|---|')
  })

  it('已收尾的表格列不會被扣住', () => {
    const src = '| a | b |\n|---|---|\n| foo | bar |'
    expect(closeIncomplete(src)).toBe(src)
  })

  it('未閉合的行內反引號會被補上', () => {
    const out = closeIncomplete('文字 `token')
    expect(inlineTicks(out) % 2).toBe(0)
    expect(out.startsWith('文字 `token')).toBe(true)
  })

  it('未閉合的粗體會被補上', () => {
    const out = closeIncomplete('文字 **強調')
    expect(boldMarks(out) % 2).toBe(0)
    expect(out.startsWith('文字 **強調')).toBe(true)
  })

  // 這一條專門擋「拿掉圍欄內外之分」的錯誤實作
  it('圍欄內的反引號與星號不參與配對，輸出不得被加料', () => {
    const src = '```py\nt = x ** 2  # `註解`\n```'
    expect(closeIncomplete(src)).toBe(src)
  })

  it('圍欄未收尾時，圍欄內的反引號同樣不參與配對', () => {
    const src = '```py\nt = x ** 2  # `註解`'
    const out = closeIncomplete(src)
    expect(out).toBe(src + '\n```')
  })

  // 本 task 的核心測試。REAL_DOC 是規格文件的完整複本，前綴數量達上萬，
  // 逐一跑 closeIncomplete 加四個檢查函式；實測這一條在本機跑 614ms，
  // 遠低於 vitest 預設的 5 秒 timeout，不需要加長。
  it.each([
    ['手寫文件', CRAFTED],
    ['真實回答', REAL_ANSWER],
    ['真實文件', REAL_DOC],
  ])('%s 的每一個前綴都產出結構完整且保留輸入的輸出', (_label, doc) => {
    const failures: string[] = []
    for (let i = 1; i <= doc.length; i += 1) {
      const prefix = doc.slice(0, i)
      let out: string
      try {
        out = closeIncomplete(prefix)
      } catch (e) {
        failures.push(`長度 ${i} 拋錯: ${String(e)}`)
        continue
      }
      // 肯定式斷言：這一條擋掉 return ''、只回第一行、以及任何丟失內容的實作
      const kept = completeLinesOf(prefix)
      if (kept !== '' && !out.startsWith(kept)) {
        failures.push(`長度 ${i} 未保留輸入的完整行`)
      }
      if (fenceLines(out) % 2 !== 0) failures.push(`長度 ${i} 圍欄數為奇數`)
      if (inlineTicks(out) % 2 !== 0) failures.push(`長度 ${i} 行內反引號為奇數`)
      if (boldMarks(out) % 2 !== 0) failures.push(`長度 ${i} 粗體標記為奇數`)
      const l = lastLine(out)
      if (l.startsWith('|') && !l.endsWith('|') && l.trim() !== '|')
        failures.push(`長度 ${i} 尾端留下未收尾的表格列`)
    }
    expect(failures.slice(0, 8)).toEqual([])
    expect(failures).toHaveLength(0)
  })
})
```

**注意**：`completeLinesOf` 對「尾端被扣住的表格列」是相容的，因為被扣掉的一定是最後一行，而這條斷言只檢查最後一行以外的部分。

- [ ] **Step 3: 執行測試，確認失敗**

Run: `npm test tests/markdown-stream.test.ts`
Expected: FAIL，無法解析 `../src/shared/markdown-stream.js`

- [ ] **Step 4: 寫最小實作**

真實文件 fixture（Step 1，裁決 27）跑前綴迴圈時踢出一個原版沒抓到的組合缺陷：規格文件裡有欄位內容含跳脫管線字元的表格列，例如 `` `{ type: 'user' \| 'assistant' \| 'system', ... }` ``。原本規則 1 只檢查 `last.endsWith('|')` 判斷這一列是否收尾，但跳脫用的 `\|` 結尾字元同樣是 `|`，會被誤判成「已收尾」，於是這一列不會被規則 1 扣住；接著規則 3 發現這一列的反引號數量是奇數（cell 裡的程式碼片段還沒收尾），在行尾補一個反引號，收尾後的最後一個字元從 `|` 變成 `` ` ``，這時再檢查「表格列是否收尾」就不成立了。手寫的 `CRAFTED` 與錄下的 `REAL_ANSWER` 都沒有這種欄位內跳脫管線的寫法，所以這個缺陷在裁決 27 之前的版本裡不會被任何測試踩到。修法是把「是否收尾」的判斷從單純 `endsWith('|')` 換成 `endsWithUnescapedPipe`：往前數 `|` 前面連續反斜線的個數，奇數個代表被跳脫，不算收尾。

`src/shared/markdown-stream.ts`：

```typescript
/**
 * 尾端的 `|` 是不是表格欄位分隔符：往前數連續反斜線，偶數個（含 0）代表這個
 * `|` 沒被跳脫，是真正的收尾；奇數個代表它是 `\|`，儲存格內容裡的文字，不是
 * 收尾。真實文件 fixture（裁決 27）裡 `{ type: 'user' \| 'assistant' }` 這種
 * 欄位就是這樣寫，原本只看 `endsWith('|')` 的版本會把這一列誤判成已收尾。
 */
function endsWithUnescapedPipe(s: string): boolean {
  if (!s.endsWith('|')) return false
  let backslashes = 0
  let i = s.length - 2
  while (i >= 0 && s[i] === '\\') {
    backslashes += 1
    i -= 1
  }
  return backslashes % 2 === 0
}

/**
 * 把串流到一半的 markdown 補成結構完整的形式，供解析器使用。
 *
 * 四條規則，只對副本操作：
 * 1. 尾端寫到一半的表格列先扣住（下一個 token 到齊自然恢復）
 * 2. 圍欄數為奇數時補一個收尾
 * 3. 圍欄外未閉合的行內反引號補上
 * 4. 圍欄外未閉合的粗體標記補上
 *
 * 規則 3、4 必須排除圍欄內的內容：程式碼裡的 ** 與 ` 不是 markdown 標記。
 * 補上的字元一律接在最後一個非圍欄行，避免破壞圍欄結構。
 */
export function closeIncomplete(text: string): string {
  const lines = text.split('\n')

  // 規則 1：用 endsWithUnescapedPipe 而非單純 endsWith('|')，
  // 否則儲存格裡跳脫的 \| 會被誤判成這一列已經收尾。
  const last = lines.at(-1) ?? ''
  const isPartialRow = last.startsWith('|') && !endsWithUnescapedPipe(last) && last.trim() !== '|'
  const kept = isPartialRow ? lines.slice(0, -1) : lines

  // 規則 3、4 的計數：只看圍欄之外
  let inFence = false
  let ticks = 0
  let bold = 0
  let lastNonFenceIdx = -1
  kept.forEach((line, i) => {
    if (line.startsWith('```')) { inFence = !inFence; return }
    if (inFence) return
    lastNonFenceIdx = i
    ticks += (line.match(/`/g) ?? []).length
    bold += (line.match(/\*\*/g) ?? []).length
  })

  const tail = (ticks % 2 === 1 ? '`' : '') + (bold % 2 === 1 ? '**' : '')
  const withTail = [...kept]
  if (tail !== '' && lastNonFenceIdx >= 0) {
    withTail[lastNonFenceIdx] = (withTail[lastNonFenceIdx] ?? '') + tail
  }

  // 規則 2：最後補圍欄，確保它在最尾端
  const fenceCount = withTail.filter((l) => l.startsWith('```')).length
  const out = fenceCount % 2 === 0 ? withTail : [...withTail, '```']

  return out.join('\n')
}
```

- [ ] **Step 5: 執行測試，確認通過**

Run: `npm test tests/markdown-stream.test.ts`
Expected: PASS，13 個測試（含三份文件各自的前綴迴圈）。實跑輸出：

```
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  737ms (transform 26ms, setup 0ms, import 35ms, tests 622ms, environment 0ms)
```

`REAL_DOC`（9617 字）那一列的前綴迴圈單獨跑 614ms，遠低於 vitest 預設的 5 秒 timeout，不需要加長。

- [ ] **Step 6: 突變測試（強制步驟）**

四個突變各跑一次，每一個都必須讓測試變紅（實測結果，三份文件的前綴迴圈都在跑，紅的測試數比原本只有兩份文件時多）：

| 突變 | 預期紅的測試 | 實測結果 |
|---|---|---|
| 整個函式改成 `return ''` | 前綴迴圈的「未保留輸入的完整行」 | 紅。`11 failed \| 2 passed`：三份文件的前綴迴圈與「完整文件原樣通過」都變紅 |
| 拿掉 `if (inFence) return`（不分圍欄內外） | 「圍欄內的反引號與星號不參與配對」 | 紅。`2 failed \| 11 passed`：那條與「圍欄未收尾時，圍欄內的反引號同樣不參與配對」一起變紅 |
| 規則 1 的表格判斷改成永遠 `false` | 前綴迴圈的「尾端留下未收尾的表格列」 | 紅。`4 failed \| 9 passed`：三份文件的前綴迴圈與「寫到一半的表格列會被扣住」一起變紅 |
| `endsWithUnescapedPipe(last)` 改回 `last.endsWith('\|')`（即修正前的版本） | 真實文件那一列的前綴迴圈 | 紅。只有真實文件的前綴迴圈變紅，失敗在前綴長度 4512 與 4527（含 `\|` 的表格列）；`CRAFTED` 與 `REAL_ANSWER` 沒有這種寫法，不受影響 |

四次都在改完後單獨跑 `vitest run`，還原程式碼後再跑一次確認回到「13 passed」，且與備份逐位元組比對一致。任何一個突變後測試仍然全綠，表示該條測試沒有測到它宣稱要測的東西，停下來回報；這裡四個都如預期變紅。

- [ ] **Step 7: 提交**

```bash
git add src/shared/markdown-stream.ts tests/markdown-stream.test.ts tests/fixtures/markdown/real-doc.md
git commit -m "feat: 未完成 markdown 的推測性收尾，含肯定式前綴斷言與規格規模的真實文件"
```

---

### Task 3: Event 型別與兩個正規化轉接器

**2026-09-02 依裁決 17 修訂**：`Event` 的 `session-end` 分支加 `errorMessage?: string`；
`resultEvents()` 從 `result` 訊息的 `errors`（字串陣列且非空時）以 `'\n'` 接成一段文字放進
該欄位，沒有就不帶。新增兩條測試與第 5 個突變，測試計數與提交訊息隨之更新（見下方標記處）。

**2026-09-02 依裁決 1、2、22 再次修訂**（三處，全部實跑驗過）：

- 裁決 2：刪掉 module 層級游標。對外只有 `stepLive`／`LiveCursor`／`LiveStep`／`INITIAL_CURSOR`，
  沒有 `normalizeLive` 與 `resetLiveNormalizer`。測試要一次餵整段 fixture 時，用新建的
  `tests/helpers/live-events.ts` 的純函式 `liveEvents()`。
- 裁決 1：`signature_delta`／`message_delta`／`message_stop` 改回空陣列，不再產出 `unknown`。
  fixture 03 因此從 6 個 `unknown` 變成 0 個，靜默行數從 15 變成 21。
- 裁決 22：`Event` 聯集加 `{ kind: 'reset' }`，`stepLive`／`normalizeHistory` 都不產出它。

規格 §4.1 的正規化層。live 與歷史兩條路徑的事件形狀不同，這一層把它們統一成同一個窄型別，
`fold()` 與所有 UI 元件之後只認 `Event`，SDK 演進的衝擊被擋在這一層。

兩個轉接器的參數型別**刻意是 `unknown` 而非 SDK 型別**：這裡是與 SDK 交接的地方，SDK 版本一變型別標註就
說謊，只有執行期檢查算數。

**跨模型審查（2026-09-02）推翻了本 task 的前一版，五項發現全部納入下方實作與測試：**

1. 前一版只處理 `content_block_delta` 的 `text_delta` 與 `thinking_delta`，其餘 `return []`。
   32 筆 `stream_event` 丟掉 20 筆，三份 fixture 105 行有 69 行產出 0 個 Event。
2. `content_block_stop` 被丟掉，而它是 `ConversationView` 裡 `complete` 欄位的唯一來源。
3. `input_json_delta` 被丟掉，工具呼叫從開始到完成之間畫面上完全沒東西。Write／Edit 的參數是
   幾千 token，那段時間就是一片空白。
4. 沒有 index 與 messageId，delta 累積出的內容與後到的完整快照無從去重。實機數過：8 筆
   `text_delta` 串接為 466 字元，第 50 行的完整 `text` 也是 466 字元，**同一份內容到達兩次**。
5. `tool_use_result`（規格 §6「展開後看得到未經處理的 stdout／stderr」的唯一來源）根本沒被讀到，
   它在 `user` 訊息的**頂層**，不在 `content` 裡。

而且前一版 13 個測試在整段 `stream_event` 處理刪掉之後照樣全過，因為「抓得到文字內容」那條的斷言
是 `'text-delta' || 'text'`，完整訊息就滿足了。下方測試因此改成**筆數精確斷言**：對
`03-sdk-live-stream.jsonl` 跑完之後，用一個 `toEqual` 比對所有 Event 類別的確切筆數，任何被刪掉
的分支都會讓某個數字對不上。

**live 路徑的呼叫方式（裁決 2）**：`content_block_start` ／ `content_block_delta` ／
`content_block_stop` 這三種 stream event **不帶 message id**（實機查證：整份 fixture 只有第
11、18、25、32、39、50 行出現 `msg_...`），而契約要求 delta 類 Event 的 `messageId` 是必填，
兩者只能靠一個跨訊息的游標調和。游標由呼叫端自己持有：從 `INITIAL_CURSOR` 起，每收一則訊息
呼叫 `stepLive(msg, cursor)`，把回傳的 `cursor` 存回去。Task 8 的 agent-host 每場 session 一份，
切換 session 時重建。本模組沒有任何 module 層級的可變狀態。

**Files:**
- Create: `src/shared/events.ts`
- Create: `tests/helpers/live-events.ts`
- Create: `tests/events.test.ts`

**Interfaces:**
- Consumes: `tests/fixtures/events/*.jsonl`（已錄下的真實事件流，不動）
- Produces:
  - `type Event`（契約原文照抄，含裁決 22 的 `{ kind: 'reset' }`）
  - `function stepLive(msg: unknown, cursor: LiveCursor): LiveStep`
  - `function normalizeHistory(msg: unknown): readonly Event[]`
  - `interface LiveCursor`、`interface LiveStep`、`const INITIAL_CURSOR`
  - `function liveEvents(msgs: readonly unknown[]): readonly Event[]`（`tests/helpers/live-events.ts`，
    測試專用的純函式，Task 4／4B 的測試共用）

- [ ] **Step 1: 寫失敗的測試**

先寫測試共用的輔助檔 `tests/helpers/live-events.ts`（裁決 2：測試要一次餵整段 fixture 時
用它，不再有 module 層級游標可以歸零）：

```typescript
import { stepLive, INITIAL_CURSOR, type Event, type LiveCursor } from '../../src/shared/events.js'

/**
 * 測試用：一次餵完一整段 live 訊息，回傳所有 Event。
 * 從 INITIAL_CURSOR 起用 stepLive 逐則歸約，把每步的 events 串起來。純函式，沒有跨呼叫狀態，
 * 兩次呼叫互不影響，正式程式碼的游標由 Task 8 的 agent-host 自己持有（裁決 2）。
 */
export function liveEvents(msgs: readonly unknown[]): readonly Event[] {
  const seed: { readonly events: readonly Event[]; readonly cursor: LiveCursor } = {
    events: [],
    cursor: INITIAL_CURSOR,
  }
  return msgs.reduce<typeof seed>((acc, msg) => {
    const step = stepLive(msg, acc.cursor)
    return { events: [...acc.events, ...step.events], cursor: step.cursor }
  }, seed).events
}
```

`vitest.config.ts` 的 `test.include` 是 `tests/**/*.test.ts`（Task 9 之後是
`tests/**/*.test.{ts,tsx}`），兩種寫法都不會把 `tests/helpers/live-events.ts` 當測試檔跑，
不必改設定。

`tests/events.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeHistory, stepLive, INITIAL_CURSOR, type Event } from '../src/shared/events.js'
import { liveEvents } from './helpers/live-events.js'

/** 讀一份錄下的事件流。規格 §9：案例來自真實資料而非測試自己造的。 */
function readFixture(name: string): readonly unknown[] {
  return readFileSync(`tests/fixtures/events/${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

const LIVE = readFixture('03-sdk-live-stream')
const HISTORY = readFixture('04-session-history')
const DENIED = readFixture('02-permission-denied')
const TOOL_USE = readFixture('01-tool-use-bash')

function tally(events: readonly Event[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
  return counts
}

function pick<K extends Event['kind']>(
  events: readonly Event[],
  kind: K
): Extract<Event, { kind: K }>[] {
  return events.filter((e): e is Extract<Event, { kind: K }> => e.kind === kind)
}

/** 逐則走一遍，收集「產出 0 個 Event」的那幾則原始訊息（游標照常推進）。 */
function silentMessages(msgs: readonly unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let cursor = INITIAL_CURSOR
  for (const m of msgs) {
    const step = stepLive(m, cursor)
    cursor = step.cursor
    if (step.events.length === 0) out.push(m as Record<string, unknown>)
  }
  return out
}

/** 把一則 live 訊息標成可讀的類別名，stream_event 要看進 event.type 與 delta.type。 */
function labelOf(m: Record<string, unknown>): string {
  if (m['type'] === 'system') return `system/${String(m['subtype'])}`
  if (m['type'] !== 'stream_event') return String(m['type'])
  const ev = m['event'] as Record<string, unknown> | undefined
  const evType = String(ev?.['type'])
  if (evType !== 'content_block_delta') return evType
  const delta = ev?.['delta'] as Record<string, unknown> | undefined
  return `content_block_delta/${String(delta?.['type'])}`
}

describe('fixture 守衛', () => {
  it('三份 fixture 都讀得到內容（fixture 被誤刪時所有測試會對空陣列跑迴圈然後全過）', () => {
    expect(LIVE.length).toBeGreaterThanOrEqual(50)
    expect(HISTORY.length).toBeGreaterThanOrEqual(6)
    expect(DENIED.length).toBeGreaterThanOrEqual(20)
  })

  it('live fixture 含足量 stream_event（逐字串流的測試對象）', () => {
    const n = LIVE.filter((m) => (m as { type?: unknown }).type === 'stream_event').length
    expect(n).toBeGreaterThanOrEqual(30)
  })
})

describe('stepLive 對真實 live fixture 的完整產出', () => {
  const events = liveEvents(LIVE)

  // 這是本 task 最重要的一條：任何被刪掉的分支都會讓某個數字對不上。
  it('各類 Event 的筆數精確吻合實機數過的數字', () => {
    expect(tally(events)).toEqual({
      'session-start': 1,
      'message-start': 2,
      'block-start': 4,
      'thinking-delta': 4,
      'text-delta': 8,
      'tool-input-delta': 4,
      'block-stop': 4,
      thinking: 2,
      text: 1,
      'tool-use': 1,
      'tool-result': 1,
      'tool-raw-output': 1,
      'session-end': 1,
    })
  })

  it('fixture 03 全程 0 個 unknown（裁決 1 的六種都認得出來）', () => {
    expect(pick(events, 'unknown')).toHaveLength(0)
  })

  it('54 行裡有 21 行產出 0 個 Event，而且全在裁決 1 的窮舉清單裡', () => {
    const empty = silentMessages(LIVE)
    expect(empty).toHaveLength(21)
    for (const m of empty) {
      expect([
        'system/hook_started',
        'system/hook_response',
        'system/status',
        'system/thinking_tokens',
        'rate_limit_event',
        'content_block_delta/signature_delta',
        'message_delta',
        'message_stop',
      ]).toContain(labelOf(m))
    }
  })

  it('裁決 1 的清單覆蓋 signature_delta ×2、message_delta ×2、message_stop ×2', () => {
    const labels = silentMessages(LIVE).map(labelOf)
    const count = (label: string): number => labels.filter((l) => l === label).length
    expect(count('content_block_delta/signature_delta')).toBe(2)
    expect(count('message_delta')).toBe(2)
    expect(count('message_stop')).toBe(2)
  })
})

describe('stepLive 的串流欄位', () => {
  const events = liveEvents(LIVE)

  it('text_delta 串接出的 466 字元與後到的完整快照一字不差（去重的前提）', () => {
    const streamed = pick(events, 'text-delta')
      .map((e) => e.text)
      .join('')
    const snapshot = pick(events, 'text')
      .map((e) => e.text)
      .join('')
    expect(streamed).toHaveLength(466)
    expect(snapshot).toBe(streamed)
  })

  it('input_json_delta 串接出合法 JSON，且等於完整快照的 input', () => {
    const partial = pick(events, 'tool-input-delta')
      .map((e) => e.partialJson)
      .join('')
    expect(partial).not.toBe('')
    expect(JSON.parse(partial)).toEqual(pick(events, 'tool-use')[0]?.input)
  })

  it('content_block_stop 產出 block-stop，它是 complete 欄位的唯一來源', () => {
    const stops = pick(events, 'block-stop')
    expect(stops).toHaveLength(4)
    expect(stops.map((e) => e.index)).toEqual([0, 1, 0, 1])
  })

  it('index 每則訊息各自從 0 開始，所以去重鍵必須是 (messageId, index)', () => {
    const starts = pick(events, 'block-start')
    expect(starts.map((e) => e.index)).toEqual([0, 1, 0, 1])
    const ids = [...new Set(starts.map((e) => e.messageId))]
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^msg_/)
  })

  it('block-start 帶得出工具名稱與 toolUseId', () => {
    const toolStart = pick(events, 'block-start').find((e) => e.blockType === 'tool_use')
    expect(toolStart?.toolName).toBe('Bash')
    expect(toolStart?.toolUseId).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
  })

  it('delta 與其後的完整快照落在同一個 (messageId, index)', () => {
    const delta = pick(events, 'text-delta')[0]
    const snap = pick(events, 'text')[0]
    expect(delta).toBeDefined()
    expect(snap?.messageId).toBe(delta?.messageId)
    expect(snap?.index).toBe(delta?.index)
  })

  it('message_start 產出 message-start 並帶 model', () => {
    const starts = pick(events, 'message-start')
    expect(starts).toHaveLength(2)
    expect(starts[0]?.model).toBe('claude-opus-5')
  })
})

describe('stepLive 的非串流訊息', () => {
  const events = liveEvents(LIVE)

  it('system/init 產出 session-start，帶 sessionId 與 cwd', () => {
    const start = pick(events, 'session-start')[0]
    expect(start?.sessionId).toBe('a727625f-71c3-49c8-8646-2414bede4756')
    expect(start?.cwd).toContain('/sdkprobe')
  })

  it('tool_use_result 在 user 訊息頂層而非 content 內，產出 tool-raw-output（規格 §6）', () => {
    const raw = pick(events, 'tool-raw-output')[0]
    expect(raw?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(raw?.stdout).toContain('cap.txt')
    expect(raw?.stderr).toBe('')
    expect(raw?.interrupted).toBe(false)
  })

  it('result 產出 session-end，帶成本與輪數', () => {
    const end = pick(events, 'session-end')[0]
    expect(end?.isError).toBe(false)
    expect(end?.costUsd).toBeCloseTo(0.3197795)
    expect(end?.numTurns).toBe(2)
  })

  it('result 帶 errors 陣列時，session-end 的 errorMessage 以換行接起來（裁決 17）', () => {
    const end = pick(
      stepLive(
        {
          type: 'result',
          is_error: true,
          api_error_status: 529,
          errors: ['overloaded', 'retry later'],
        },
        INITIAL_CURSOR
      ).events,
      'session-end'
    )[0]
    expect(end?.isError).toBe(true)
    expect(end?.apiErrorStatus).toBe(529)
    expect(end?.errorMessage).toBe('overloaded\nretry later')
  })

  it('result 沒有 errors 時，session-end 不帶 errorMessage 欄位（裁決 17）', () => {
    const end = pick(
      stepLive({ type: 'result', is_error: false }, INITIAL_CURSOR).events,
      'session-end'
    )[0]
    expect(end).toBeDefined()
    expect(end !== undefined && 'errorMessage' in end).toBe(false)
  })

  it('system/permission_denied 產出 permission-denied（fixture 02）', () => {
    const denied = pick(liveEvents(DENIED), 'permission-denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]?.toolName).toBe('Bash')
    expect(denied[0]?.toolUseId).toBe('toolu_015NDSGktRsH8rWhzAALV3vY')
    expect(denied[0]?.message).toContain('was blocked')
  })

  it('tool_use_result 是字串時照樣產出 tool-raw-output（fixture 02 的實際形狀）', () => {
    const raw = pick(liveEvents(DENIED), 'tool-raw-output')[0]
    expect(raw?.stdout).toContain('was blocked')
    expect(raw?.stderr).toBe('')
  })
})

describe('normalizeHistory 對真實 history fixture', () => {
  const events = HISTORY.flatMap((m) => [...normalizeHistory(m)])

  it('各類 Event 的筆數精確吻合', () => {
    expect(tally(events)).toEqual({
      'user-text': 1,
      thinking: 2,
      'tool-use': 1,
      'tool-result': 1,
      text: 1,
    })
  })

  it('六行裡沒有任何一行產出零個 Event', () => {
    for (const [i, m] of HISTORY.entries()) {
      expect(normalizeHistory(m).length, `第 ${i + 1} 行`).toBeGreaterThan(0)
    }
  })

  it('使用者提問轉成 user-text', () => {
    expect(pick(events, 'user-text')[0]?.text).toContain('echo hello > cap.txt')
  })

  it('tool_use 轉成 tool-use，input 是解析好的物件', () => {
    const tool = pick(events, 'tool-use')[0]
    expect(tool?.name).toBe('Bash')
    expect(tool?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect((tool?.input as { command?: string }).command).toContain('echo hello')
  })

  it('tool_result 轉成 tool-result，isError 讀得到', () => {
    const result = pick(events, 'tool-result')[0]
    expect(result?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(result?.isError).toBe(false)
    expect(String(result?.content)).toContain('cap.txt')
  })

  it('assistant 的完整回答帶得出 messageId，且沒有 index（歷史路徑沒有 delta 要去重）', () => {
    const text = pick(events, 'text')[0]
    expect(text?.messageId).toBe('msg_011CecHvmWYSkjexndc45ePc')
    expect(text?.index).toBeUndefined()
    expect(text?.text).toContain('| 項目 | 值 |')
    // messageId 取 message.id 不取每行的 uuid：4 行 assistant 是 2 則 API 訊息各拆成 2 行
    const assistantIds = events.flatMap((e) => ('messageId' in e ? [e.messageId] : []))
    expect(assistantIds).toHaveLength(4)
    expect(new Set(assistantIds).size).toBe(2)
  })

  it('history 沒有 tool_use_result，所以不產出 tool-raw-output', () => {
    expect(pick(events, 'tool-raw-output')).toHaveLength(0)
  })
})

describe('裁決 1：認得出來但沒有可渲染內容的輸入回空陣列', () => {
  const silent: readonly [string, unknown][] = [
    [
      'signature_delta',
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'abc' },
        },
      },
    ],
    [
      'message_delta',
      {
        type: 'stream_event',
        event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
      },
    ],
    ['message_stop', { type: 'stream_event', event: { type: 'message_stop' } }],
    ['rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }],
    ['system/status', { type: 'system', subtype: 'status', status: 'requesting' }],
  ]

  it.each(silent)('%s 回空陣列且游標不變', (_label, input) => {
    const step = stepLive(input, INITIAL_CURSOR)
    expect(step.events).toEqual([])
    expect(step.cursor).toEqual(INITIAL_CURSOR)
  })
})

describe('認不出來的輸入一律產出 unknown，不丟棄也不拋錯', () => {
  const cases: readonly [string, unknown][] = [
    ['未知 type', { type: 'brand_new_sdk_event', payload: 42 }],
    ['null', null],
    ['字串', 'not an event'],
  ]

  it.each(cases)('stepLive：%s', (_label, input) => {
    const events = stepLive(input, INITIAL_CURSOR).events
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('unknown')
    expect((events[0] as { raw: unknown }).raw).toEqual(input)
  })

  it.each(cases)('normalizeHistory：%s', (_label, input) => {
    const events = normalizeHistory(input)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('unknown')
    expect((events[0] as { raw: unknown }).raw).toEqual(input)
  })

  it('未知的 system 子型別也產出 unknown（例外清單只有四個子型別）', () => {
    const events = stepLive({ type: 'system', subtype: 'brand_new_subtype' }, INITIAL_CURSOR).events
    expect(events.map((e) => e.kind)).toEqual(['unknown'])
  })

  it('未知的 stream_event 子型別也產出 unknown（裁決 1 的清單是窮舉的）', () => {
    const events = stepLive(
      { type: 'stream_event', event: { type: 'brand_new_stream_event' } },
      INITIAL_CURSOR
    ).events
    expect(events.map((e) => e.kind)).toEqual(['unknown'])
  })

  it('未知的 content block 型別產出 unknown 而非整則訊息消失', () => {
    const events = normalizeHistory({
      type: 'assistant',
      message: {
        id: 'msg_x',
        content: [{ type: 'server_tool_use', id: 'x' }, { type: 'text', text: 'hi' }],
      },
    })
    expect(events.map((e) => e.kind)).toEqual(['unknown', 'text'])
  })
})

describe('reset 由 main 合成，正規化層永遠不產出（裁決 22）', () => {
  it('四份 fixture 跑完都沒有任何 reset', () => {
    const all: readonly Event[] = [
      ...liveEvents(TOOL_USE),
      ...liveEvents(DENIED),
      ...liveEvents(LIVE),
      ...liveEvents(HISTORY),
      ...HISTORY.flatMap((m) => [...normalizeHistory(m)]),
    ]
    expect(all.length).toBeGreaterThan(0)
    expect(all.filter((e) => e.kind === 'reset')).toHaveLength(0)
  })
})

describe('轉接器不修改輸入，且是純函式', () => {
  it('stepLive 不修改傳入的訊息', () => {
    const input = JSON.parse(JSON.stringify(LIVE[11])) as unknown
    const snapshot = JSON.stringify(input)
    stepLive(input, INITIAL_CURSOR)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('normalizeHistory 不修改傳入的訊息', () => {
    const input = JSON.parse(JSON.stringify(HISTORY[5])) as unknown
    const snapshot = JSON.stringify(input)
    normalizeHistory(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('stepLive 對同一個 cursor 呼叫兩次得到相同結果，且不改動傳入的 cursor', () => {
    const a = stepLive(LIVE[10], INITIAL_CURSOR)
    const b = stepLive(LIVE[10], INITIAL_CURSOR)
    expect(a).toEqual(b)
    expect(INITIAL_CURSOR).toEqual({ messageId: '', openIndex: -1 })
  })

  it('兩個獨立游標互不影響：推進過的那個不會沾到另一個（裁決 2）', () => {
    const blockStop = { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    const advanced = stepLive(LIVE[10], INITIAL_CURSOR).cursor
    expect(advanced.messageId).toMatch(/^msg_/)
    const fromAdvanced = stepLive(blockStop, advanced).events
    expect(pick(fromAdvanced, 'block-stop')[0]?.messageId).toBe(advanced.messageId)
    const fromFresh = stepLive(blockStop, INITIAL_CURSOR).events
    expect(pick(fromFresh, 'block-stop')[0]?.messageId).toBe('')
  })
})
```

**這份測試的三類硬性要求各自落在哪裡**：

| 要求 | 測試 |
|---|---|
| fixture 非空守衛 | `describe('fixture 守衛')` 兩條。三份 fixture 各有下限，另加 `stream_event` 筆數下限 |
| 筆數精確斷言 | 「各類 Event 的筆數精確吻合實機數過的數字」，單一 `toEqual` 涵蓋 13 個類別共 34 筆 |
| `normalizeHistory` 用真實 fixture | `describe('normalizeHistory 對真實 history fixture')` 七條全部餵 `04-session-history.jsonl` |
| 未知輸入三條 | `it.each` 的未知 type／`null`／字串，兩個轉接器各跑一次，共 6 個案例 |
| 裁決 1 的空陣列清單 | `describe('裁決 1：認得出來但沒有可渲染內容的輸入回空陣列')` 五個案例，加上「21 行產出 0 個 Event」與「清單覆蓋 ×2×2×2」兩條 |

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/events.test.ts`
Expected: FAIL，無法解析 `../src/shared/events.js`

- [ ] **Step 3: 寫最小實作**

`src/shared/events.ts`：

```typescript
/**
 * SDK 事件到本專案窄型別的正規化層（規格 §4.1）。
 *
 * 兩個轉接器的參數是 `unknown` 而非 SDK 型別：這裡是與 SDK 交接的地方，SDK 版本一變型別標註就
 * 說謊，只有執行期檢查算數。認不出來的輸入一律產出 `unknown` Event；認得出來但沒有可渲染內容
 * 的那幾種（裁決 1 的窮舉清單）回空陣列，每一處都在註解寫明理由。
 */

export type Event =
  | { kind: 'session-start'; sessionId: string; cwd?: string; model?: string }
  | { kind: 'message-start'; messageId: string; model?: string }
  | {
      kind: 'block-start'
      messageId: string
      index: number
      blockType: 'text' | 'thinking' | 'tool_use'
      toolName?: string
      toolUseId?: string
    }
  | { kind: 'text-delta'; messageId: string; index: number; text: string }
  | { kind: 'thinking-delta'; messageId: string; index: number; text: string }
  | { kind: 'tool-input-delta'; messageId: string; index: number; partialJson: string }
  | { kind: 'block-stop'; messageId: string; index: number }
  // 完整快照。live 路徑在 delta 之後才到，歷史路徑只有這些。
  | { kind: 'text'; messageId?: string; index?: number; text: string }
  | { kind: 'thinking'; messageId?: string; index?: number; text: string }
  | {
      kind: 'tool-use'
      messageId?: string
      index?: number
      id: string
      name: string
      input: unknown
    }
  | { kind: 'tool-result'; id: string; content: unknown; isError: boolean }
  | { kind: 'tool-raw-output'; id: string; stdout: string; stderr: string; interrupted: boolean }
  | { kind: 'user-text'; text: string }
  | { kind: 'permission-denied'; toolName: string; toolUseId: string; message?: string }
  | {
      kind: 'session-end'
      isError: boolean
      costUsd?: number
      numTurns?: number
      apiErrorStatus?: unknown
      // 2026-09-02 依裁決 17 新增：result 訊息的 errors（字串陣列）以 '\n' 接成一段文字。
      errorMessage?: string
    }
  // 2026-09-02 依裁決 22 新增：main 合成，normalizer 不產出。
  | { kind: 'reset' }
  | { kind: 'unknown'; raw: unknown }

const unknownEvent = (raw: unknown): readonly Event[] => [{ kind: 'unknown', raw }]

// ---- 執行期型別守衛。對外來資料一律不信任 ----

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function asIndex(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}
function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : []
}
/** 2026-09-02 依裁決 17 新增：result 的 errors 欄位守衛，非字串陣列一律回 undefined。 */
function asStringArray(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as readonly string[])
    : undefined
}

// ---- content block 的映射。live 的完整快照與歷史共用同一份，形狀本來就一樣 ----

function assistantBlockToEvents(
  block: unknown,
  messageId: string | undefined,
  index: number | undefined
): readonly Event[] {
  const b = asRecord(block)
  if (b === null) return unknownEvent(block)
  const at = {
    ...(messageId === undefined ? {} : { messageId }),
    ...(index === undefined ? {} : { index }),
  }
  switch (b['type']) {
    case 'text': {
      const text = asString(b['text'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'text', ...at, text }]
    }
    case 'thinking': {
      const text = asString(b['thinking'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'thinking', ...at, text }]
    }
    case 'tool_use': {
      const id = asString(b['id'])
      const name = asString(b['name'])
      if (id === undefined || name === undefined) return unknownEvent(block)
      return [{ kind: 'tool-use', ...at, id, name, input: b['input'] }]
    }
    default:
      return unknownEvent(block)
  }
}

function userBlockToEvents(block: unknown): readonly Event[] {
  const b = asRecord(block)
  if (b === null) return unknownEvent(block)
  switch (b['type']) {
    case 'text': {
      const text = asString(b['text'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'user-text', text }]
    }
    case 'tool_result': {
      const id = asString(b['tool_use_id'])
      if (id === undefined) return unknownEvent(block)
      return [{ kind: 'tool-result', id, content: b['content'], isError: b['is_error'] === true }]
    }
    default:
      return unknownEvent(block)
  }
}

/**
 * `tool_use_result` 有兩種實測到的形狀，這裡統一成一種：
 * 物件 `{stdout, stderr, interrupted, ...}`（fixture 01／03），以及純字串（fixture 02 的
 * 權限拒絕，內容是 `Error: ... was blocked`）。字串就是那次執行的原始輸出，當成 stdout。
 * 規格 §6 的「展開後看得到未經處理的 stdout／stderr」只有這個來源。
 */
function rawOutputEvents(raw: unknown, toolUseId: string | undefined): readonly Event[] {
  if (raw === undefined || raw === null) return []
  if (toolUseId === undefined) return unknownEvent(raw)
  if (typeof raw === 'string') {
    return [{ kind: 'tool-raw-output', id: toolUseId, stdout: raw, stderr: '', interrupted: false }]
  }
  const r = asRecord(raw)
  if (r === null) return unknownEvent(raw)
  const stdout = asString(r['stdout'])
  const stderr = asString(r['stderr'])
  if (stdout === undefined && stderr === undefined) return unknownEvent(raw)
  return [
    {
      kind: 'tool-raw-output',
      id: toolUseId,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      interrupted: r['interrupted'] === true,
    },
  ]
}

function firstToolResultId(events: readonly Event[]): string | undefined {
  for (const e of events) if (e.kind === 'tool-result') return e.id
  return undefined
}

/** `tool_use_result` 在 user 訊息的頂層，不在 `content` 裡。它掛在同一則訊息的 tool_result 上。 */
function userMessageEvents(msg: Record<string, unknown>): readonly Event[] {
  const message = asRecord(msg['message'])
  const content = message === null ? undefined : message['content']
  const blocks: readonly unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content)
  const fromBlocks = blocks.flatMap(userBlockToEvents)
  return [...fromBlocks, ...rawOutputEvents(msg['tool_use_result'], firstToolResultId(fromBlocks))]
}

function assistantMessageEvents(
  msg: Record<string, unknown>,
  fallbackMessageId: string | undefined,
  openIndex: number | undefined
): readonly Event[] {
  const message = asRecord(msg['message'])
  if (message === null) return unknownEvent(msg)
  const messageId = asString(message['id']) ?? fallbackMessageId
  const blocks = asArray(message['content'])
  if (blocks.length === 0) return unknownEvent(msg)
  /**
   * 只有單一 block 時才敢貼 index。`includePartialMessages: true` 下 SDK 一個 block 發一則
   * assistant 訊息（實機查證：四份 fixture 全部的 assistant 訊息 content 長度都是 1），
   * 這時當下開著的 block index 就是它。多 block 時無從對應，index 留空，由 fold 依序附加。
   */
  const index = blocks.length === 1 ? openIndex : undefined
  return blocks.flatMap((b) => assistantBlockToEvents(b, messageId, index))
}

function resultEvents(msg: Record<string, unknown>): readonly Event[] {
  const costUsd = asNumber(msg['total_cost_usd'])
  const numTurns = asNumber(msg['num_turns'])
  const apiErrorStatus = msg['api_error_status']
  // 2026-09-02 依裁決 17：errors 是字串陣列且非空才接成 errorMessage，否則不帶該欄位。
  const errors = asStringArray(msg['errors'])
  const errorMessage = errors !== undefined && errors.length > 0 ? errors.join('\n') : undefined
  return [
    {
      kind: 'session-end',
      isError: msg['is_error'] === true,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(numTurns === undefined ? {} : { numTurns }),
      ...(apiErrorStatus === undefined || apiErrorStatus === null ? {} : { apiErrorStatus }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
  ]
}

// ---- live 路徑的游標 ----

/**
 * `content_block_start` ／ `content_block_delta` ／ `content_block_stop` 這三種 stream event
 * **不帶 message id**（實機查證：整份 03 fixture 只有第 11、18、25、32、39、50 行出現 `msg_...`），
 * 而 index 每則訊息各自從 0 重數，所以去重鍵必須是 `(messageId, index)`。兩件事只能靠一個跨訊息
 * 的游標調和：`messageId` 由 `message_start` 設定，`openIndex` 記住當下開著的 block，
 * 用來把後到的完整快照貼回正確的 index。
 */
export interface LiveCursor {
  readonly messageId: string
  readonly model?: string
  readonly openIndex: number
}

export interface LiveStep {
  readonly events: readonly Event[]
  readonly cursor: LiveCursor
}

export const INITIAL_CURSOR: LiveCursor = { messageId: '', openIndex: -1 }

/**
 * 裁決 1 的「認得出來但沒有可渲染內容」清單，`system` 的部分：hook／status／thinking_tokens。
 * 它們對渲染沒有意義且數量大（54 行的 fixture 裡佔 14 行）。其餘的 subtype 一律產出 unknown。
 */
const SILENT_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'hook_started',
  'hook_response',
  'status',
  'thinking_tokens',
])

function systemStep(m: Record<string, unknown>, cursor: LiveCursor): LiveStep {
  const subtype = m['subtype']
  if (subtype === 'init') {
    const sessionId = asString(m['session_id'])
    if (sessionId === undefined) return { events: unknownEvent(m), cursor }
    const cwd = asString(m['cwd'])
    const model = asString(m['model'])
    return {
      events: [
        {
          kind: 'session-start',
          sessionId,
          ...(cwd === undefined ? {} : { cwd }),
          ...(model === undefined ? {} : { model }),
        },
      ],
      cursor,
    }
  }
  if (subtype === 'permission_denied') {
    const toolName = asString(m['tool_name'])
    const toolUseId = asString(m['tool_use_id'])
    if (toolName === undefined || toolUseId === undefined) return { events: unknownEvent(m), cursor }
    const message = asString(m['message'])
    return {
      events: [
        {
          kind: 'permission-denied',
          toolName,
          toolUseId,
          ...(message === undefined ? {} : { message }),
        },
      ],
      cursor,
    }
  }
  if (typeof subtype === 'string' && SILENT_SYSTEM_SUBTYPES.has(subtype)) {
    return { events: [], cursor }
  }
  return { events: unknownEvent(m), cursor }
}

function streamEventStep(ev: Record<string, unknown>, cursor: LiveCursor): LiveStep {
  switch (ev['type']) {
    case 'message_start': {
      const message = asRecord(ev['message'])
      const messageId = message === null ? undefined : asString(message['id'])
      if (messageId === undefined) return { events: unknownEvent(ev), cursor }
      const model = message === null ? undefined : asString(message['model'])
      return {
        events: [{ kind: 'message-start', messageId, ...(model === undefined ? {} : { model }) }],
        cursor: { messageId, ...(model === undefined ? {} : { model }), openIndex: -1 },
      }
    }
    case 'content_block_start': {
      const index = asIndex(ev['index'])
      const cb = asRecord(ev['content_block'])
      const t = cb === null ? undefined : cb['type']
      const blockType = t === 'text' || t === 'thinking' || t === 'tool_use' ? t : undefined
      if (index === undefined || blockType === undefined || cb === null) {
        return { events: unknownEvent(ev), cursor }
      }
      const toolName = asString(cb['name'])
      const toolUseId = asString(cb['id'])
      return {
        events: [
          {
            kind: 'block-start',
            messageId: cursor.messageId,
            index,
            blockType,
            ...(toolName === undefined ? {} : { toolName }),
            ...(toolUseId === undefined ? {} : { toolUseId }),
          },
        ],
        cursor: { ...cursor, openIndex: index },
      }
    }
    case 'content_block_delta': {
      const index = asIndex(ev['index'])
      const d = asRecord(ev['delta'])
      if (index === undefined || d === null) return { events: unknownEvent(ev), cursor }
      const at = { messageId: cursor.messageId, index }
      switch (d['type']) {
        case 'text_delta': {
          const text = asString(d['text'])
          return text === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'text-delta', ...at, text }], cursor }
        }
        case 'thinking_delta': {
          const text = asString(d['thinking'])
          return text === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'thinking-delta', ...at, text }], cursor }
        }
        case 'input_json_delta': {
          const partialJson = asString(d['partial_json'])
          return partialJson === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'tool-input-delta', ...at, partialJson }], cursor }
        }
        // 裁決 1：signature_delta 是 thinking block 的密碼學簽章，不可顯示，也沒有任何
        // 可渲染內容。它認得出來，只是沒東西畫，所以回空陣列而不是產出一張原始 JSON 卡片。
        case 'signature_delta':
          return { events: [], cursor }
        default:
          return { events: unknownEvent(ev), cursor }
      }
    }
    case 'content_block_stop': {
      const index = asIndex(ev['index'])
      if (index === undefined) return { events: unknownEvent(ev), cursor }
      return {
        events: [{ kind: 'block-stop', messageId: cursor.messageId, index }],
        cursor: { ...cursor, openIndex: -1 },
      }
    }
    // 裁決 1：message_delta 帶的是 stop_reason 與 usage，統計已經由 result 訊息併進
    // session-end；message_stop 沒有任何欄位。兩者都認得出來但畫不出東西，回空陣列。
    // 游標不動：messageId 留到下一個 message_start 才換，跟其他不推進游標的分支一致。
    case 'message_delta':
    case 'message_stop':
      return { events: [], cursor }
    default:
      return { events: unknownEvent(ev), cursor }
  }
}

/**
 * live 轉接器：純函式，游標明著收進參數與回傳值。呼叫端（Task 8 的 agent-host）每場 session
 * 自己持有一份游標，從 `INITIAL_CURSOR` 起，每收一則訊息就把回傳的 `cursor` 存回去。
 */
export function stepLive(msg: unknown, cursor: LiveCursor): LiveStep {
  const m = asRecord(msg)
  if (m === null) return { events: unknownEvent(msg), cursor }
  switch (m['type']) {
    case 'system':
      return systemStep(m, cursor)
    case 'stream_event': {
      const ev = asRecord(m['event'])
      return ev === null ? { events: unknownEvent(m), cursor } : streamEventStep(ev, cursor)
    }
    case 'assistant': {
      const fallback = cursor.messageId === '' ? undefined : cursor.messageId
      const openIndex = cursor.openIndex >= 0 ? cursor.openIndex : undefined
      return { events: assistantMessageEvents(m, fallback, openIndex), cursor }
    }
    case 'user':
      return { events: userMessageEvents(m), cursor }
    case 'result':
      return { events: resultEvents(m), cursor }
    // 裁決 1：純粹的用量回報，認得出來但沒有可渲染內容。
    case 'rate_limit_event':
      return { events: [], cursor }
    default:
      return { events: unknownEvent(m), cursor }
  }
}

/**
 * `getSessionMessages()` 的產物。形狀是 `{type, uuid, session_id, message, ...}`：user 行的 `message`
 * 只有 `{role, content}`；assistant 行的 `message` 是完整的 API 訊息（`id`、`model`、`content`、`usage` 等）。
 * 沒有 stream event，所以不需要游標，也沒有 index。`messageId` 取 `message.id` 不取每行的 `uuid`：
 * 歷史檔把一則 API 訊息的每個 block 各寫成一行，fixture 04 的 4 行 assistant 只有 2 個 `message.id`。
 */
export function normalizeHistory(msg: unknown): readonly Event[] {
  const m = asRecord(msg)
  if (m === null) return unknownEvent(msg)
  switch (m['type']) {
    case 'user':
      return userMessageEvents(m)
    case 'assistant':
      return assistantMessageEvents(m, undefined, undefined)
    default:
      return unknownEvent(m)
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/events.test.ts`
Expected: PASS，46 個測試（38 個 `it`，其中三個 `it.each` 分別展開 5、3、3 個案例）。
2026-09-02 於暫時 worktree 實跑：

```
 Test Files  1 passed (1)
      Tests  46 passed (46)
```

Run: `npm run typecheck`
Expected: 無錯誤。`src/shared/events.ts` 實測 420 行（裁決 2 刪掉 module 游標與兩個包裝
函式，裁決 22 加了一行型別），在單檔 800 行的上限內。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

七個突變各跑一次，每一個都必須讓測試變紅。前三個是「看起來還會過」的那種：事件照樣產出、
數量甚至不變，錯的是內容或欄位。第 5 個對應裁決 17，第 6 個對應裁決 1，第 7 個對應裁決 22。
下表的紅燈條數與測試名稱都是 2026-09-02 在暫時 worktree 實跑的結果。

| # | 突變 | 實測紅的測試 |
|---|---|---|
| 1 | `content_block_stop` 那個 case 改成 `return { events: [], cursor: { ...cursor, openIndex: -1 } }` | 「各類 Event 的筆數精確吻合」、「54 行裡有 21 行產出 0 個 Event」、「content_block_stop 產出 block-stop」、「兩個獨立游標互不影響」（4 條，實跑 4 紅 42 綠） |
| 2 | 刪掉 `input_json_delta` 那個 case（讓它落到 `default` 產出 unknown） | 「各類 Event 的筆數精確吻合」、「fixture 03 全程 0 個 unknown」、「input_json_delta 串接出合法 JSON」（3 條，實跑 3 紅 43 綠） |
| 3 | `message_start` 的回傳游標不記 messageId（`cursor: { ...cursor, openIndex: -1 }`） | 「index 每則訊息各自從 0 開始」、「delta 與其後的完整快照落在同一個 (messageId, index)」、「兩個獨立游標互不影響」（3 條，實跑 3 紅 43 綠） |
| 4 | `stepLive` 與 `normalizeHistory` 的 `default` 都改成回空陣列（靜默丟棄） | 「stepLive：未知 type」、「normalizeHistory：未知 type」（2 條，實跑 2 紅 44 綠） |
| 5 | `resultEvents` 不讀 `errors`（刪掉 `errorMessage` 那行 spread） | 「result 帶 errors 陣列時，session-end 的 errorMessage 以換行接起來（裁決 17）」（1 條，實跑 1 紅 45 綠） |
| 6 | 裁決 1 的三種改回產出 unknown（`signature_delta`／`message_delta`／`message_stop`） | 「各類 Event 的筆數精確吻合」、「fixture 03 全程 0 個 unknown」、「54 行裡有 21 行」、「裁決 1 的清單覆蓋 ×2×2×2」、裁決 1 空陣列組的三條（7 條，實跑 7 紅 39 綠） |
| 7 | `message_delta`／`message_stop` 改成產出 `{ kind: 'reset' }` | 上面第 6 項的前四條裡的三條、裁決 1 空陣列組的兩條、「四份 fixture 跑完都沒有任何 reset」（6 條，實跑 6 紅 40 綠） |

突變 2 值得特別看：它**沒有丟棄任何東西**，`input_json_delta` 照樣變成一個 unknown Event，
所以任何只斷言「事件沒有消失」的測試都會照樣綠。擋住它的是筆數精確斷言、「0 個 unknown」
與 JSON 串接那三條。

突變 3 更值得看：**筆數一個都沒變**，34 個 Event 全部照樣產出，只有 `messageId` 全成了空字串。
後果是 `fold()` 的去重鍵 `(messageId, index)` 在兩則訊息之間撞在一起，同一段回答渲染兩遍。
擋得住它的是那三條檢查 messageId 內容的測試。

**突變 5 的實測輸出**（裁決 17。刪掉 `resultEvents` 裡
`...(errorMessage === undefined ? {} : { errorMessage })` 那行）：

```
 FAIL  tests/events.test.ts > stepLive 的非串流訊息 > result 帶 errors 陣列時，session-end 的 errorMessage 以換行接起來（裁決 17）
AssertionError: expected undefined to be 'overloaded\nretry later' // Object.is equality
 Tests  1 failed | 45 passed (46)
```

只有目標測試變紅：`errorMessage` 欄位整個不會出現在產出的 Event 上，`end?.errorMessage`
讀到 `undefined`。緊鄰的「result 沒有 errors 時，session-end 不帶 errorMessage 欄位」
那條不受影響，因為它本來就斷言沒有這個欄位，跟這個突變的效果巧合一致，不構成防線。

**突變 6 的實測輸出**（裁決 1。三種改回 `unknownEvent(ev)`）：

```
 FAIL  tests/events.test.ts > stepLive 對真實 live fixture 的完整產出 > fixture 03 全程 0 個 unknown（裁決 1 的六種都認得出來）
AssertionError: expected [ …(6) ] to have a length of +0 but got 6
 FAIL  tests/events.test.ts > stepLive 對真實 live fixture 的完整產出 > 54 行裡有 21 行產出 0 個 Event，而且全在裁決 1 的窮舉清單裡
AssertionError: expected [ { type: 'system', …(6) }, …(14) ] to have a length of 21 but got 15
 Tests  7 failed | 39 passed (46)
```

15 與 6 這兩個數字就是裁決 1 之前的行為，這條突變等於把修訂整個退回去，七條防線同時倒下。

任何一個突變後測試仍然全綠，表示該條測試沒有測到它宣稱要測的東西，停下來回報。
七次的紅燈輸出與還原後的綠燈（`Tests  46 passed (46)`）都貼進報告，且每次還原都重新跑過
`tsc --noEmit` 確認無殘留的型別錯誤。

- [ ] **Step 6: 跑完整測試套件**

Run: `npm test`
Expected: PASS。總數在執行當下的既有總數上加 46，把實際數字記進報告。

- [ ] **Step 7: 提交**

```bash
git add src/shared/events.ts tests/helpers/live-events.ts tests/events.test.ts
git commit -m "feat: Event 型別與 stepLive/normalizeHistory 兩個正規化轉接器，含筆數精確斷言、裁決 1 的空陣列清單與裁決 22 的 reset"
```

---

### Task 4: fold 核心：文字與思考區塊

**2026-09-02 依裁決 17 修訂**：`ConversationView` 加 `error?`，`fold()` 在 `session-end` 的
`isError: true` 時設定（`isError: false` 時維持 undefined），新增兩條測試與第 6 個突變。

**2026-09-02 依裁決 1、2、22 再次修訂**：

- 裁決 2：測試改用 Task 3 建立的 `tests/helpers/live-events.ts` 的 `liveEvents()`，
  不再有 `runLive`／`resetLiveNormalizer`／`beforeEach`。
- 裁決 1：fixture 03 不再產出 6 個 `unknown`。原本「6 個 unknown Event 全部落到 Block 裡」
  那條拆成兩條：fixture 03 的 unknown block 數是 0，加一條手工合成 `unknown` 事件驗
  `applyUnknown` 的掛載位置。新增第 8 個突變守住後者。
- 裁決 22：`applyEvent` 加 `case 'reset': return INITIAL_VIEW`，一條測試，第 7 個突變。

規格 §4.2 要的 `fold(events) → ConversationView`，把 Task 3 正規化出來的 `Event[]` 投影成
畫面要的資料結構。**範圍已縮小**：本 task 只處理 `text`、`thinking`、`unknown` 三種
Block；`tool_use` 相關事件只產出一個 `status: 'streaming-input'` 的最小佔位，工具的
狀態推進（`running`／`done`／`error`／`awaiting-approval`／`denied` 之間怎麼轉換）留給
Task 4B。這一點在程式碼註解與下面的實作裡都會標明。

**三件必須做對的事**（CONTRACT.md 已裁決，這裡照做）：

1. **去重。** 同一份內容以兩種方式送達：8 筆 `text-delta` 累積出 466 字元，之後一個
   完整 `text` 快照也是 466 字元。完整快照要「取代」delta 累積的內容，不是附加。
   鍵是 `(messageId, index)`。
2. **index 會重置。** 每則訊息的 block index 各自從 0 開始（fixture 03 第 12 行
   index=0、第 20 行 index=1、第 33 行又回到 index=0）。只用 index 當鍵會把不同訊息
   的 block 混在一起。
3. **`complete` 有三個來源（2026-09-02 裁決 5、15）。** `block-stop`：該 block
   單獨設完成。`session-end`：一次把所有 text／thinking block 設完成，不分是否
   曾收到各自的 `block-stop`。`user-text` 建立時：直接完成，使用者按下送出那刻
   就已經完成。歷史路徑不是第四個特例，是第二條規則的自然結果：載入端
   （Task 11 的 `session-store.ts`）在 `normalizeHistory` 產出的事件尾端補一筆
   `session-end`，歷史對話因此走同一條規則變完成。

**設計取捨：turn 的先後順序跟 turn 裝了哪些 block，分成兩份全域資料，不是每個 turn
自己揹一份 blocks 陣列。**

第一版實作圖省事，把 block 直接放進各自 turn 自己的陣列裡：先用 `messageId` 找到
turn，再用 `index` 找 turn 內的 block。這版本讓「去重：完整快照取代 delta」的測試
通過，也讓「index 重置」的測試通過，但拿「把鍵從 `(messageId, index)` 改成只用
`index`」這個突變去驗證時，**測試仍然全綠，沒有一條變紅**。

原因是 `messageId` 這個維度其實已經靠「先找到哪個 turn」悄悄補上了：搜尋範圍本來就
被限制在同一個 turn 的 blocks 陣列裡，`(messageId, index)` 退化成只剩 `index` 在做
事，鍵裡帶不帶 `messageId` 結果都一樣。這正是任務說明裡提到的「看起來還會過的突
變」：斷言對、名字對，但實作的資料結構讓 messageId 這個防線形同虛設。

修法是把去重查找攤平成一份全域、跨所有 turn 的 `records` 清單，比對鍵時不先按
turn 分流，直接對整份清單比對。這樣「鍵要不要帶 messageId」才是唯一防線：拿掉它，
兩則訊息的 index=0 會真的撞在一起。turn 的先後順序另外記在 `turnOrder`，最後再用
`turnId` 把 `records` 分組回各自的 turn（`buildTurns`）。改完之後同一個突變會準確
命中「index 重置」測試（見 Step 5，附有實際跑出的紅燈輸出）。

**Files:**
- Create: `src/shared/fold.ts`
- Create: `tests/fold.test.ts`

**Interfaces:**
- Consumes: `src/shared/events.ts` 的 `Event`（Task 3 產出）、`tests/helpers/live-events.ts` 的
  `liveEvents()`（Task 3 建立）、`tests/fixtures/events/*.jsonl`
- Produces:
  - `interface ConversationView { sessionId?, turns, cost?, ended, error? }`
  - `interface Turn { role, messageId?, blocks }`
  - `type Block`（`text` | `thinking` | `tool` | `unknown`，契約原文照抄）
  - `function fold(events: readonly Event[]): ConversationView`

  下游用法：Task 9／10／11 的 React 元件讀取 `ConversationView`，每次收到新的一批
  `Event` 就把累積到當下的完整事件陣列整包丟給 `fold()` 重算。`fold()` 是純函式，
  沒有跨呼叫狀態，不是餵單一新事件做增量更新，跟 Task 3 `stepLive` 的游標模式是
  兩回事。

**`complete` 規則的由來（2026-09-02 裁決 5、15 定案，記錄理由不是留待裁決）：**

第一版實作發現「`complete` 嚴格只由 `block-stop` 決定」這條字面規則，對歷史
路徑與使用者訊息有副作用：history 的 assistant 訊息沒有 `block-stop` 事件
（Task 3 的 `normalizeHistory` 從不產出這個 kind），照字面會永遠停在
`complete: false`。UI 若把 `complete: false` 顯示成「還在串流中」（例如游標
閃爍），已經講完的歷史對話會被誤判成仍在輸出。

這個發現回報後，裁決 5 先加了「`session-end` 到達時其餘所有 block 一律
`complete: true`」；裁決 15 進一步統一機制：不給 Event 加「這個 block 來自哪
條路徑」的欄位（那是為特殊情況開洞），改成規定**歷史路徑由載入端（Task 11 的
`session-store.ts`）在 `normalizeHistory` 產出的事件尾端補一筆
`{ kind: 'session-end', isError: false }`**，讓歷史對話走與 live 收尾同一條
規則。`fold()` 因此只認三種 complete 來源，不需要知道事件是從哪條路徑來的：

| 來源 | 效果 |
|---|---|
| `block-stop` | 該 block 單獨設 `complete: true` |
| `session-end` | 目前所有 `text`／`thinking` block 一併設 `complete: true`（不論是否曾收到 `block-stop`） |
| `user-text` 建立時 | 直接 `complete: true` |

本 task 的測試同時驗證兩個層面：`fold()` 收到 `session-end` 時確實把 block
設完成（見 Step 1「complete 的來源」），以及 `fold()` 本身不會替歷史路徑
「偷偷」補完成，那是載入端明確補一筆事件才會發生的事，兩者由誰負責在
「history 路徑與 session-end 的分工」測試組裡看得見。

- [ ] **Step 1: 寫失敗的測試**

`tests/fold.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fold, type ConversationView, type Turn, type Block } from '../src/shared/fold.js'
import { normalizeHistory, type Event } from '../src/shared/events.js'
import { liveEvents } from './helpers/live-events.js'

/** 讀一份錄下的事件流。規格 §9：案例來自真實資料而非測試自己造的。 */
function readFixture(name: string): readonly unknown[] {
  return readFileSync(`tests/fixtures/events/${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

function runHistory(msgs: readonly unknown[]): readonly Event[] {
  return msgs.flatMap((m) => [...normalizeHistory(m)])
}

function allBlocks(view: ConversationView): readonly Block[] {
  return view.turns.flatMap((t: Turn) => t.blocks)
}

describe('fixture 守衛', () => {
  it('live 與 history fixture 都讀得到內容（fixture 被誤刪時測試會對空陣列跑然後全過）', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const HISTORY = readFixture('04-session-history')
    expect(LIVE.length).toBeGreaterThanOrEqual(50)
    expect(HISTORY.length).toBeGreaterThanOrEqual(6)
  })
})

describe('去重：同一個 (messageId, index) 的完整快照取代 delta 累積，不是附加', () => {
  it('8 筆 text-delta 疊出 466 字元，完整快照到達後仍是 466 字元而非 932', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    // fixture 第 42-49 行：8 筆 text_delta 疊出 466 字元；第 50 行的完整 text 也是 466 字元
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.markdown).toHaveLength(466)
  })
})

describe('index 重置：不同訊息各自從 0 開始的 block index 不能混在一起', () => {
  it('兩則訊息各自的 index=0 thinking block 各自獨立，不被合併成一個', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const assistantTurns = view.turns.filter((t) => t.role === 'assistant')
    // fixture 第 12 行（msg1 index=0）與第 33 行（msg2 index=0）都是 thinking block-start，
    // 若去重鍵只用 index 會被誤判成同一個 block
    expect(assistantTurns).toHaveLength(2)
    expect(assistantTurns[0]?.messageId).toBe('msg_011CecHvRnPBQEKKkvdkgXkj')
    expect(assistantTurns[1]?.messageId).toBe('msg_011CecHvmWYSkjexndc45ePc')
    const thinkingBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'thinking' }> => b.kind === 'thinking'
    )
    expect(thinkingBlocks).toHaveLength(2)
  })
})

describe('complete 的來源：block-stop 或 session-end（裁決 5、15）', () => {
  it('拿掉最後一個 block-stop（第 51 行）且截掉尾端的 result 訊息（第 52-54 行），text block 仍是 complete:false', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    // 只餵到第 50 行：完整 text 快照已經到，但 block-stop（51）與 result 訊息
    // （52-54，會產出 session-end）都還沒到，兩個 complete 來源都不在場
    const withoutStopAndResult = LIVE.slice(0, 50)
    const view = fold(liveEvents(withoutStopAndResult))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.complete).toBe(false)
  })

  it('只截掉第 51 行的 block-stop、保留尾端的 result 訊息，text block 因 session-end 而 complete:true', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    // 拿掉陣列裡的第 51 行（index 50），52-54 行原樣保留，session-end 仍會發生
    const withoutBlockStopOnly = [...LIVE.slice(0, 50), ...LIVE.slice(51)]
    const view = fold(liveEvents(withoutBlockStopOnly))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.complete).toBe(true)
  })

  it('餵完整事件流（含第 51 行的 block-stop）後 text block 變成 complete:true', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks[0]?.complete).toBe(true)
  })
})

describe('tool_use：只給最小佔位，狀態推進不在本 task 範圍', () => {
  it('live 路徑：block-start 產出佔位後，後續 tool-input-delta／tool-use／tool-result 都不改動它', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const toolBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool'
    )
    // fixture 第 20 行：msg1 index=1 是 tool_use block-start，name=Bash
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]).toEqual({
      kind: 'tool',
      id: 'toolu_01L2YCZHqTvRDmdkNpsprfCQ',
      name: 'Bash',
      input: undefined,
      status: 'streaming-input',
    })
  })

  it('history 路徑：沒有 block-start，tool-use 快照本身是唯一機會，直接把 id/name/input 填進佔位', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    const toolBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool'
    )
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]?.status).toBe('streaming-input')
    expect(toolBlocks[0]?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(toolBlocks[0]?.name).toBe('Bash')
    expect(toolBlocks[0]?.input).toEqual({
      command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
      description: 'Write hello to cap.txt and verify',
    })
  })
})

describe('history 路徑：assistant 訊息沒有 index，多個 block 依序附加進同一個 turn', () => {
  it('同一個 messageId 的 thinking 與 tool_use 兩個 block 依序附加，不互相取代', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    // fixture 04 第 2、3 行都是 msg_011CecHvRnPBQEKKkvdkgXkj：先 thinking 後 tool_use
    const turn = view.turns.find((t) => t.messageId === 'msg_011CecHvRnPBQEKKkvdkgXkj')
    expect(turn).toBeDefined()
    expect(turn?.blocks.map((b) => b.kind)).toEqual(['thinking', 'tool'])
  })
})

describe('history 路徑與 session-end 的分工（裁決 15：載入端補一筆）', () => {
  // 只看 assistant turn 的 block：user-text 建立時就直接 complete:true（另一條
  // 規則），跟這裡要驗證的「history 的 assistant block 要靠 session-end 才變完成」
  // 是兩回事，混進來會讓斷言失真。
  function assistantCompletable(view: ConversationView) {
    return view.turns
      .filter((t) => t.role === 'assistant')
      .flatMap((t) => t.blocks)
      .filter(
        (b): b is Extract<Block, { kind: 'text' | 'thinking' }> => b.kind === 'text' || b.kind === 'thinking'
      )
  }

  it('fixture 04 本身沒有 session-end，fold(normalizeHistory 產出) 的 assistant text／thinking block 全部 complete:false', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    const completable = assistantCompletable(view)
    // fixture 04：msg1 一個 thinking，msg2 一個 thinking 加一個 text，共 3 個
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === false)).toBe(true)
  })

  it('載入端補一筆 { kind: session-end, isError: false } 後，同一批 assistant block 全部變 complete:true', () => {
    const HISTORY = readFixture('04-session-history')
    const events: readonly Event[] = [...runHistory(HISTORY), { kind: 'session-end', isError: false }]
    const view = fold(events)
    const completable = assistantCompletable(view)
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === true)).toBe(true)
  })
})

describe('不得靜默丟棄：認不出來的事件仍要有可見產出', () => {
  it('fixture 03 全程沒有 unknown Event，fold 之後也沒有 unknown block（裁決 1）', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const events = liveEvents(LIVE)
    // 裁決 1：signature_delta／message_delta／message_stop 認得出來但沒有可渲染內容，
    // Task 3 回空陣列，所以這份 fixture 一個 unknown 都不該有
    expect(events.filter((e) => e.kind === 'unknown')).toHaveLength(0)
    const view = fold(events)
    expect(allBlocks(view).filter((b) => b.kind === 'unknown')).toHaveLength(0)
  })

  it('手工合成的 unknown 事件掛到當下最後一個 turn 上，不憑空消失', () => {
    const raw = { type: 'brand_new_sdk_event', payload: 42 }
    const events: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg-1' },
      { kind: 'text', messageId: 'msg-1', index: 0, text: 'hi' },
      { kind: 'unknown', raw },
    ]
    const view = fold(events)
    const lastTurn = view.turns[view.turns.length - 1]
    expect(lastTurn?.messageId).toBe('msg-1')
    // 只看排列與 unknown block 本身：complete 是另一組規則的事，混進來會讓這條測試
    // 對不相干的改動變紅
    expect(lastTurn?.blocks.map((b) => b.kind)).toEqual(['text', 'unknown'])
    expect(lastTurn?.blocks[1]).toEqual({ kind: 'unknown', raw })
  })
})

describe('user-text：每個事件各自開一個新的 user turn，建立時直接 complete:true（裁決 5、15）', () => {
  it('history fixture 第 1 行的使用者訊息變成一個 role: user 的 turn，complete 不等 block-stop 或 session-end', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    const userTurns = view.turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0]?.blocks).toEqual([
      { kind: 'text', markdown: expect.stringContaining('echo hello'), complete: true },
    ])
  })
})

describe('reset：畫面從這裡重新開始（裁決 22）', () => {
  it('reset 之前的事件不出現在結果裡，結果等於只餵 reset 之後的事件', () => {
    const before: readonly Event[] = [
      { kind: 'session-start', sessionId: 'sess-old' },
      { kind: 'message-start', messageId: 'msg-old' },
      { kind: 'text', messageId: 'msg-old', index: 0, text: '上一場的內容' },
      { kind: 'session-end', isError: true, errorMessage: 'boom' },
    ]
    const after: readonly Event[] = [
      { kind: 'session-start', sessionId: 'sess-new' },
      { kind: 'message-start', messageId: 'msg-new' },
      { kind: 'text', messageId: 'msg-new', index: 0, text: '新的一場' },
    ]
    const view = fold([...before, { kind: 'reset' }, ...after])
    expect(view).toEqual(fold(after))
    expect(JSON.stringify(view)).not.toContain('上一場的內容')
    expect(view.sessionId).toBe('sess-new')
    expect(view.ended).toBe(false)
    expect(view.error).toBeUndefined()
  })
})

describe('session 層級欄位', () => {
  it('session-start 設定 sessionId，session-end 設定 ended 與 cost', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    // fixture 第 9 行 session_id，第 54 行 total_cost_usd／num_turns
    expect(view.sessionId).toBe('a727625f-71c3-49c8-8646-2414bede4756')
    expect(view.ended).toBe(true)
    expect(view.cost?.usd).toBeCloseTo(0.3197795)
    expect(view.cost?.turns).toBe(2)
  })

  it('沒有收到 session-end 之前 ended 是 false', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const withoutResult = LIVE.slice(0, 53)
    const view = fold(liveEvents(withoutResult))
    expect(view.ended).toBe(false)
  })

  it('isError 的 session-end 之後 view.error 帶 message 與 apiErrorStatus（裁決 17）', () => {
    const events: readonly Event[] = [
      { kind: 'session-end', isError: true, errorMessage: 'boom', apiErrorStatus: 500 },
    ]
    const view = fold(events)
    expect(view.error).toEqual({ message: 'boom', apiErrorStatus: 500 })
  })

  it('正常 session-end 之後 view.error 是 undefined（裁決 17）', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    expect(view.ended).toBe(true)
    expect(view.error).toBeUndefined()
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/fold.test.ts`
Expected: FAIL，`fold`、`ConversationView`、`Turn`、`Block` 都無法從 `../src/shared/fold.js`
解析出來（檔案還不存在）。

執行本 task 前提：`src/shared/events.ts` 與 `tests/helpers/live-events.ts`（都是 Task 3
產出）必須已經存在於專案中，否則那兩條 import 本身就會編譯失敗，Step 2 看到的會是
模組找不到而非「fold 還沒實作」，兩者要分辨清楚。

- [ ] **Step 3: 寫最小實作**

`src/shared/fold.ts` 完整內容（前半：型別、去重鍵、turn 與 block 的存放機制）：

```typescript
/**
 * 把 Event 流投影成畫面要的 ConversationView（規格 4.2）。
 *
 * 本檔只處理 text、thinking、unknown 三種 Block。tool_use 相關事件只產出一個
 * status: streaming-input 的最小佔位，狀態推進（running/done/error 等）留給 Task 4B。
 */

import type { Event } from './events.js'

export interface ConversationView {
  readonly sessionId?: string
  readonly turns: readonly Turn[]
  readonly cost?: { readonly usd?: number; readonly turns?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增：session-end 的 isError:true 時由 fold() 設定，isError:false 維持 undefined。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

export interface Turn {
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
  readonly blocks: readonly Block[]
}

export type Block =
  | { readonly kind: 'text'; readonly markdown: string; readonly complete: boolean }
  | { readonly kind: 'thinking'; readonly text: string; readonly complete: boolean }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly inputPartial?: string
      readonly result?: unknown
      readonly raw?: { readonly stdout: string; readonly stderr: string; readonly interrupted: boolean }
      readonly status: 'streaming-input' | 'awaiting-approval' | 'denied' | 'running' | 'done' | 'error'
    }
  | { readonly kind: 'unknown'; readonly raw: unknown }

/*
 * 內部工作模型：turn 的先後順序與身分，跟 turn 裝了哪些 block，分成兩份全域資料，
 * 不是每個 turn 自己揹一份 blocks 陣列。原因是去重規則的核心矛盾就發生在這裡：
 *
 * 規格明講去重鍵必須是 (messageId, index) 的組合，理由是 index 每則訊息各自從 0
 * 開始，只用 index 會把不同訊息的 block 混在一起。若實作把 block 直接放進各自
 * turn 自己的陣列裡（先用 messageId 找到 turn，再用 index 找 turn 內的 block），
 * messageId 這個維度其實已經靠「先找到哪個 turn」悄悄補上了，(messageId, index)
 * 會退化成只剩 index 在做事：那樣的話，去重鍵不管有沒有帶 messageId，結果都一樣，
 * 「把鍵改成只用 index」這種錯誤實作會完全測不出來，因為 turn 的分隔已經先擋掉問題。
 *
 * 所以這裡刻意用一份全域、跨所有 turn 的 records 清單，去重查找不先按 turn 分流，
 * 直接對整份清單比對鍵。這樣鍵要不要帶 messageId 才是唯一防線，錯了會真的讓兩則
 * 訊息的 index=0 撞在一起。turn 的先後順序另外記在 turnOrder，最後再用 turnId
 * 把 records 分組回各自的 turn。
 */

interface TurnMeta {
  readonly turnId: string
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
}

/** key 為 null 表示不可去重（history 路徑的 assistant 訊息沒有 index），一律附加。 */
interface BlockRecord {
  readonly turnId: string
  readonly key: string | null
  readonly block: Block
}

interface WorkingView {
  readonly sessionId?: string
  readonly turnOrder: readonly TurnMeta[]
  readonly records: readonly BlockRecord[]
  readonly cost?: { readonly usd?: number; readonly turns?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增，見 sessionEndError。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

const INITIAL_VIEW: WorkingView = { turnOrder: [], records: [], ended: false }

/**
 * 去重鍵：用 JSON.stringify 把 messageId 與 index 兩個維度編碼成同一個字串，
 * 不必自己挑分隔字元、也不必煩惱 messageId 裡會不會剛好出現那個分隔字元。
 * index 是 undefined 時代表 history 路徑的多 block 訊息（沒有 index 可用），
 * 回傳 null，呼叫端據此改成一律附加而非查表比對。
 */
function blockKey(messageId: string, index: number | undefined): string | null {
  return index === undefined ? null : JSON.stringify([messageId, index])
}

// ---- turn 身分：assistant 用 messageId 本身當 turnId，user 每次生一個新的 ----

function hasAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): boolean {
  return turnOrder.some((t) => t.role === 'assistant' && t.messageId === messageId)
}

/** 確保 messageId 有一個 assistant turn 存在；不存在就在陣列尾端新增。turnId 直接用 messageId。 */
function ensureAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): readonly TurnMeta[] {
  return hasAssistantTurn(turnOrder, messageId)
    ? turnOrder
    : [...turnOrder, { turnId: messageId, role: 'assistant' as const, messageId }]
}

/**
 * 全域去重：查找與寫入都對整份 records 清單直接比對 key，不先按 turnId 分流。
 * 這是讓「鍵要不要帶 messageId」這件事真正有意義的關鍵設計，見檔案開頭的說明。
 *
 * key 為 null（history 路徑，沒有 index）：一律新增一筆 record，不查表，效果
 * 等同附加在該 turn 的尾端（buildTurns 依 records 原始順序分組，天然保序）。
 * key 不為 null：查表命中就整份「取代」原本的 block（不是附加），查不到就新增
 * 並記住這把 key。build 收到既有 block（找不到就是 undefined），由呼叫端決定
 * 要不要延續舊內容（例如 text-delta 要接、完整快照要蓋）。
 */
function placeBlock(
  records: readonly BlockRecord[],
  turnId: string,
  key: string | null,
  build: (existing: Block | undefined) => Block
): readonly BlockRecord[] {
  const existing = key === null ? undefined : records.find((r) => r.key === key)
  if (existing === undefined) return [...records, { turnId, key, block: build(undefined) }]
  return records.map((r) => (r.key === key ? { ...r, block: build(existing.block) } : r))
}

// ---- text／thinking：delta 累加，完整快照取代 ----

function applyTextDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'text' ? existing.markdown : ''
    return { kind: 'text', markdown: prev + text, complete: false }
  })
}

function applyThinkingDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'thinking' ? existing.text : ''
    return { kind: 'thinking', text: prev + text, complete: false }
  })
}

/**
 * 完整快照「取代」delta 累積出來的內容，不是附加：同一份內容用兩種方式送達，
 * 只算一份。key 為 null（history，無 index）時 placeBlock 一律新增，效果等同附加。
 * complete 延續既有值：block-stop 或 session-end 先到或後到都不影響這裡的判斷，
 * 這裡只是不要把已經標記的 complete 蓋回 false（見 applyBlockStop、applySessionEnd）。
 */
function applyTextSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'text' ? existing.complete : false
    return { kind: 'text', markdown: text, complete }
  })
}

function applyThinkingSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'thinking' ? existing.complete : false
    return { kind: 'thinking', text, complete }
  })
}

/**
 * complete 的來源之一（另外兩個是 applySessionEnd 與 user-text 建立時，見裁決
 * 5、15）。這裡只讓「收到 block-stop 的那一個」block 變完成，其餘不動。
 */
function applyBlockStop(records: readonly BlockRecord[], messageId: string, index: number): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing === undefined) {
      // 協定不應該讓 block-stop 搶在任何內容之前抵達；真的發生時不要吃掉這個事件，
      // 留一個看得見的痕跡而不是靜默略過。
      return { kind: 'unknown', raw: { note: 'block-stop 沒有對應的 block', messageId, index } }
    }
    if (existing.kind === 'text' || existing.kind === 'thinking') return { ...existing, complete: true }
    // tool／unknown 沒有 complete 欄位，工具的狀態推進留給 Task 4B，這裡維持原樣。
    return existing
  })
}

/**
 * complete 的另一個來源（裁決 5、15）：session-end 到達時，「其餘所有」
 * text／thinking block 一律變完成，不分是否曾收到各自的 block-stop。這裡回傳
 * 新陣列，每筆需要改的 record 也是新物件，不就地改動舊的。
 *
 * tool block 這裡刻意不動：running -> done 的推進是裁決 15 的另一半，屬於
 * Task 4B 的範圍（它接手 updateToolBlock 之後，會在同一個 case 補上那段）。
 *
 * 歷史路徑不是這裡的特例：載入端（Task 11 的 session-store.ts）在
 * normalizeHistory 產出的事件尾端補一筆 session-end，會自然走到這個函式，
 * fold() 本身不需要知道事件是從哪條路徑來的。
 */
function applySessionEnd(records: readonly BlockRecord[]): readonly BlockRecord[] {
  return records.map((r) => {
    if (r.block.kind !== 'text' && r.block.kind !== 'thinking') return r
    return { ...r, block: { ...r.block, complete: true } }
  })
}

/**
 * session-end 的第四個效果（裁決 17，跟上面的 complete 規則是兩件事）：isError 為 true
 * 時把 errorMessage／apiErrorStatus 收進 view.error，兩個欄位都用條件展開避免寫入
 * undefined 鍵；isError 為 false 時回傳 undefined，讓 error 維持不設。
 */
function sessionEndError(
  event: Extract<Event, { kind: 'session-end' }>
): WorkingView['error'] {
  if (event.isError !== true) return undefined
  return {
    ...(event.errorMessage === undefined ? {} : { message: event.errorMessage }),
    ...(event.apiErrorStatus === undefined ? {} : { apiErrorStatus: event.apiErrorStatus }),
  }
}

```

`src/shared/fold.ts` 後半（tool_use 佔位、user turn、unknown 事件、主 reduce、對外的 `fold`）：

```typescript
// ---- tool_use：只給最小佔位，狀態推進留給 Task 4B ----

function applyBlockStart(
  records: readonly BlockRecord[],
  messageId: string,
  index: number,
  blockType: 'text' | 'thinking' | 'tool_use',
  toolName: string | undefined,
  toolUseId: string | undefined
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, () => {
    if (blockType === 'text') return { kind: 'text', markdown: '', complete: false }
    if (blockType === 'thinking') return { kind: 'thinking', text: '', complete: false }
    return { kind: 'tool', id: toolUseId ?? '', name: toolName ?? '', input: undefined, status: 'streaming-input' }
  })
}

/**
 * live 路徑：block-start 已經放了佔位，這裡忠實維持原狀，不推進狀態（Task 4B 的工作）。
 * history 路徑：tool-use 是該工具呼叫唯一會抵達的事件，沒有 block-start 可以先佔位，
 * 這裡是唯一機會拿到 id、name、input，直接填入，而不是留空等一個永遠不會來的事件。
 * 兩種情況 status 都固定 streaming-input，這裡只是把已知資料塞進最小佔位，不是狀態推進。
 */
function applyToolUseSnapshot(
  records: readonly BlockRecord[],
  messageId: string,
  index: number | undefined,
  id: string,
  name: string,
  input: unknown
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing !== undefined) return existing
    return { kind: 'tool', id, name, input, status: 'streaming-input' }
  })
}

// ---- user turn：每個 user-text 都開一個新 turn，不嘗試合併 ----

/**
 * Event 沒有給 user 訊息任何跨 block 的關聯鍵（不像 assistant 有 messageId），
 * 所以無法判斷連續兩個 user-text 事件是不是同一則原始訊息拆出來的兩個 block。
 * 這裡選擇保守：每個 user-text 都開一個新 turn，寧可把同一則訊息的多個文字
 * block 拆成多個 turn，也不要誤把兩則不相干的使用者訊息合併成一個 turn。
 *
 * complete 直接是 true（裁決 5、15 的第三個來源）：使用者按下送出的那一刻，
 * 這則訊息就已經完成，不需要等任何後續事件。
 */
function applyUserText(view: WorkingView, text: string): WorkingView {
  const turnId = 'user-' + String(view.turnOrder.length)
  const block: Block = { kind: 'text', markdown: text, complete: true }
  return {
    ...view,
    turnOrder: [...view.turnOrder, { turnId, role: 'user' as const }],
    records: [...view.records, { turnId, key: null, block }],
  }
}

/**
 * 沒有任何 turn 可歸屬、又不能靜默丟棄的事件（Task 3 判定「認不出來」而產出的
 * unknown，以及缺 messageId 的完整快照）：掛到目前最後一個 turn 上；連一個 turn
 * 都還沒有就新開一個 assistant turn 來裝它，避免事件憑空消失。
 */
function applyUnknown(view: WorkingView, raw: unknown): WorkingView {
  const block: Block = { kind: 'unknown', raw }
  const last = view.turnOrder[view.turnOrder.length - 1]
  if (last === undefined) {
    const turnId = 'unknown-' + String(view.turnOrder.length)
    return {
      ...view,
      turnOrder: [...view.turnOrder, { turnId, role: 'assistant' as const }],
      records: [...view.records, { turnId, key: null, block }],
    }
  }
  return { ...view, records: [...view.records, { turnId: last.turnId, key: null, block }] }
}

// ---- 主 reduce：一個 Event 對應一次狀態轉換 ----

function applyEvent(view: WorkingView, event: Event): WorkingView {
  switch (event.kind) {
    case 'session-start':
      return { ...view, sessionId: event.sessionId }
    case 'message-start':
      return { ...view, turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId) }
    case 'block-start':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStart(view.records, event.messageId, event.index, event.blockType, event.toolName, event.toolUseId),
      }
    case 'text-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyTextDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'thinking-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyThinkingDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'tool-input-delta':
      // 工具狀態推進留給 Task 4B，這裡刻意不處理，也不丟棄事件本身，它仍在
      // Event 流裡，Task 4B 會讀它，只是這個 fold() 版本選擇忽略它。
      return view
    case 'block-stop':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStop(view.records, event.messageId, event.index),
      }
    case 'text':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyTextSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'thinking':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyThinkingSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'tool-use':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyToolUseSnapshot(view.records, event.messageId, event.index, event.id, event.name, event.input),
          }
    case 'tool-result':
    case 'tool-raw-output':
    case 'permission-denied':
      // 同樣是工具狀態推進的一部分，留給 Task 4B。
      return view
    case 'user-text':
      return applyUserText(view, event.text)
    case 'session-end': {
      // 裁決 17：error 是 session-end 的第四個效果，跟 ended／cost／block complete
      // 三件事並列，用同一次 reduce 更新算完，不另開一次遍歷。
      const error = sessionEndError(event)
      return {
        ...view,
        ended: true,
        cost: {
          ...(event.costUsd === undefined ? {} : { usd: event.costUsd }),
          ...(event.numTurns === undefined ? {} : { turns: event.numTurns }),
        },
        records: applySessionEnd(view.records),
        ...(error === undefined ? {} : { error }),
      }
    }
    // 裁決 22：畫面從這裡重新開始。reset 由 Task 8 的 ipc-bridge 合成，正規化層不產出它。
    // 之前累積的 turn、block、sessionId、cost、error 全部丟掉，回到初始狀態。
    case 'reset':
      return INITIAL_VIEW
    case 'unknown':
      return applyUnknown(view, event.raw)
  }
}

function buildTurns(turnOrder: readonly TurnMeta[], records: readonly BlockRecord[]): readonly Turn[] {
  return turnOrder.map((tm) => ({
    role: tm.role,
    ...(tm.messageId === undefined ? {} : { messageId: tm.messageId }),
    blocks: records.filter((r) => r.turnId === tm.turnId).map((r) => r.block),
  }))
}

/**
 * fold 核心：把整條 Event 流投影成一份 ConversationView 快照。純函式，沒有任何
 * 跨呼叫狀態：呼叫端要拿到最新畫面，就把累積到當下的完整事件陣列整包丟進來重算，
 * 不是餵單一新事件做增量更新（跟 stepLive 的游標模式是兩回事）。
 */
export function fold(events: readonly Event[]): ConversationView {
  const view = events.reduce(applyEvent, INITIAL_VIEW)
  return {
    ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
    turns: buildTurns(view.turnOrder, view.records),
    ...(view.cost === undefined ? {} : { cost: view.cost }),
    ended: view.ended,
    ...(view.error === undefined ? {} : { error: view.error }),
  }
}
```

`src/shared/fold.ts` 完整檔案實測 410 行，在單檔 800 行的上限內（裁決 5、15 版是 381 行；
裁決 17 加了 `error?` 欄位、`sessionEndError` 函式及其註解，以及 `session-end` case
與 `fold()` 回傳值裡的條件展開；裁決 22 再加 `reset` 那個 case 與註解）。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/fold.test.ts`
Expected: PASS，19 個測試（裁決 5、15 加 3 個 complete 測試；裁決 17 加 2 個
「session 層級欄位」的 error 測試；裁決 1 把 unknown 那條拆成 2 條、裁決 22 加 1 條 reset）。

實測（2026-09-02 依裁決 1、2、22 重跑：`git worktree add` 一個暫時工作區，材料化本 task 與
Task 3 的 `events.ts`／`live-events.ts`／`events.test.ts`／`fold.ts`／`fold.test.ts`，
`npx vitest run`）：

```
 RUN  v4.1.11

 Test Files  2 passed (2)
      Tests  65 passed (65)
```

（65 = Task 3 的 `events.test.ts` 46 個 + 本 task `fold.test.ts` 19 個，同一次指令
`npx vitest run tests/events.test.ts tests/fold.test.ts` 跑出。單獨只跑
`fold.test.ts` 是 `Tests  19 passed (19)`。）

Run: `npm run typecheck`
Expected: 無錯誤。實測 `tsc --noEmit` 對兩個檔案都乾淨通過，`noUncheckedIndexedAccess`
底下唯一需要注意的是 `applyUnknown` 裡 `view.turnOrder[view.turnOrder.length - 1]`
這個手動陣列索引，型別是 `TurnMeta | undefined`，程式碼用 `if (last === undefined)`
明確處理，不是靠斷言蓋過去。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

八個突變各跑一次，每一個都必須讓測試變紅。**突變 1、2 是任務指名要驗的**，
突變 3、4、5 對應 complete 規則（裁決 5、15），突變 6 對應裁決 17 的 `error` 欄位，
突變 7 對應裁決 22 的 `reset`，突變 8 對應裁決 1 之後 `applyUnknown` 唯一的防線。
下表的紅燈條數與測試名稱都是 2026-09-02 在暫時 worktree 實跑的結果。

| # | 突變 | 改法 | 實測紅的測試 |
|---|---|---|---|
| 1 | 拿掉去重邏輯 | `placeBlock` 裡 `const existing = key === null ? undefined : records.find(...)` 改成 `const existing = undefined`，強迫每次都當成沒找到 | 6 條（見下方紅燈輸出） |
| 2 | 鍵從 `(messageId, index)` 改成只用 `index` | `blockKey` 的 `JSON.stringify([messageId, index])` 改成 `JSON.stringify([index])` | 「index 重置：兩則訊息各自的 index=0 thinking block 各自獨立」與「tool_use：live 路徑」共 2 條 |
| 3 | `complete` 不等 block-stop／session-end，快照一到就當完成 | `applyTextSnapshot` 的 `complete` 不再延續既有值，直接寫死 `true` | 「complete 的來源」的第一條（拿掉 block-stop 且截掉 result）；連帶命中「history 路徑與 session-end 的分工」的第一條，因為兩者都經過同一個 `applyTextSnapshot`。共 2 條 |
| 4 | `session-end` 不把 block 設 complete | `applyEvent` 的 `session-end` case 拿掉 `records: applySessionEnd(view.records)` 這一行 | 「complete 的來源」的第二條（只截掉 block-stop、保留 result）；「history 路徑與 session-end 的分工」的第二條（補一筆 session-end 後全部變 true）。共 2 條 |
| 5 | `user-text` 建立為 `complete:false` | `applyUserText` 的 `block` 字面量改回 `complete: false` | 「user-text：…建立時直接 complete:true」1 條 |
| 6 | `sessionEndError` 不判斷 `isError`，無論如何都回傳 error 物件 | `sessionEndError` 的 `if (event.isError !== true) return undefined` 拿掉，直接組 error 物件回傳 | 「正常 session-end 之後 view.error 是 undefined（裁決 17）」1 條 |
| 7 | `reset` 不清空 | `case 'reset'` 從 `return INITIAL_VIEW` 改成 `return view` | 「reset 之前的事件不出現在結果裡」1 條 |
| 8 | `unknown` 事件靜默丟棄 | `case 'unknown'` 從 `return applyUnknown(view, event.raw)` 改成 `return view` | 「手工合成的 unknown 事件掛到當下最後一個 turn 上」1 條 |

**突變 1 的實測輸出**（`placeBlock` 的 `existing` 強制設成 `undefined`）：

```
 FAIL  tests/fold.test.ts > 去重：同一個 (messageId, index) 的完整快照取代 delta 累積，不是附加
 > 8 筆 text-delta 疊出 466 字元，完整快照到達後仍是 466 字元而非 932
AssertionError: expected [ { kind: 'text', …(2) }, …(9) ] to have a length of 1 but got 10
 Tests  6 failed | 13 passed (19)
```

去重拿掉後，8 筆 delta 加 1 筆完整快照各自變成獨立 block，`textBlocks` 從 1 筆暴增
成 10 筆，目標測試變紅。同一個機制也讓 thinking-delta 的累加被打斷，msg1 那個
thinking block 從 1 筆暴增成多筆，連帶讓「index 重置」那條（斷言 `thinkingBlocks`
長度為 2）一起紅；另外還波及「complete 的來源」前兩條、「tool_use」的 live 路徑
那條，以及「fixture 03 全程沒有 unknown block」那條（`applyBlockStop` 查不到既有
block，四個 `block-stop` 各生一個 unknown block），共 6 個測試。這些測試都間接依賴
「同一個 block 只會有一筆紀錄」這個前提，去重一壞，連帶炸出的範圍比原本設想的更廣，
不是只有直接斷言去重行為的那一條。還原後重跑：`Tests  19 passed (19)`。

**突變 2 的實測輸出**（`blockKey` 只用 `JSON.stringify([index])`）：

```
 FAIL  tests/fold.test.ts > index 重置：不同訊息各自從 0 開始的 block index 不能混在一起
 > 兩則訊息各自的 index=0 thinking block 各自獨立，不被合併成一個
AssertionError: expected [ Array(1) ] to have a length of 2 but got 1
 FAIL  tests/fold.test.ts > tool_use：只給最小佔位，狀態推進不在本 task 範圍
 > live 路徑：block-start 產出佔位後，後續 tool-input-delta／tool-use／tool-result 都不改動它
AssertionError: expected [] to have a length of 1 but got +0
 Tests  2 failed | 17 passed (19)
```

msg1 與 msg2 的 index=0（都是 thinking block-start）鍵撞在一起：msg2 的
thinking block-start 找到 msg1 那筆舊 record（鍵同樣是 `[0]`），就地把內容換成
自己的，但 `turnId` 欄位沒有跟著換，那筆 record 仍然掛在 msg1 底下，`buildTurns`
用 `turnId` 分組時，msg2 的 turn 就少了這個 block，`thinkingBlocks` 從 2 筆掉到
只剩 1 筆（msg1、msg2 的 thinking 內容疊成同一筆，最後寫入的贏）。

同樣的碰撞也發生在 index=1：msg1 的 tool_use block-start 先佔用鍵 `[1]`，msg2 的
text block-start 後到，一樣「就地取代」那筆 record 的內容，把它從 tool 佔位換成
完整的 text block（466 字元、complete:true），`turnId` 一樣沒換。msg1 原本應該
有的那個 tool 佔位因此被整個蓋掉、憑空消失，`toolBlocks` 從 1 筆掉到 0 筆，對應
上面第二條紅燈輸出的 `expected [] to have a length of 1 but got +0`。
還原後重跑：`Tests  19 passed (19)`。

這組突變值得記一筆：**第一版實作（block 直接放進各自 turn 的陣列裡）完全測不出
這個突變**：測試全綠，因為 turn 的分隔本身已經用 messageId 分流過一次，鍵裡
帶不帶 messageId 不影響結果。改成全域 `records` 清單、查找不先按 turn 分流之後，
突變才會真正命中。這是撰寫本 task 時實際踩到、改掉的坑，不是紙上假設。

**突變 3 的實測輸出**（`applyTextSnapshot` 的 `complete` 寫死 `true`）：

```
 FAIL  tests/fold.test.ts > complete 的來源：block-stop 或 session-end（裁決 5、15）
 > 拿掉最後一個 block-stop（第 51 行）且截掉尾端的 result 訊息（第 52-54 行），text block 仍是 complete:false
AssertionError: expected true to be false // Object.is equality
 FAIL  tests/fold.test.ts > history 路徑與 session-end 的分工（裁決 15：載入端補一筆）
 > fixture 04 本身沒有 session-end，fold(normalizeHistory 產出) 的 assistant text／thinking block 全部 complete:false
AssertionError: expected false to be true // Object.is equality
 Tests  2 failed | 17 passed (19)
```

`applyTextSnapshot` 是 live 與 history 兩條路徑共用的函式（live 的完整 text 快照、
history 的 assistant 訊息都走它），寫死 `complete: true` 因此同時命中兩條測試：
live 那條「沒收到 block-stop 也沒收到 session-end 就該是 false」，以及 history 那條
「沒補 session-end 之前 assistant block 該是 false」。兩者都是同一個函式的同一顆
bug 造成，不是各自獨立的巧合。還原後重跑：`Tests  19 passed (19)`。

**突變 4 的實測輸出**（`applyEvent` 的 `session-end` case 拿掉
`records: applySessionEnd(view.records)`）：

```
 FAIL  tests/fold.test.ts > complete 的來源：block-stop 或 session-end（裁決 5、15）
 > 只截掉第 51 行的 block-stop、保留尾端的 result 訊息，text block 因 session-end 而 complete:true
AssertionError: expected false to be true // Object.is equality
 FAIL  tests/fold.test.ts > history 路徑與 session-end 的分工（裁決 15：載入端補一筆）
 > 載入端補一筆 { kind: session-end, isError: false } 後，同一批 assistant block 全部變 complete:true
AssertionError: expected false to be true // Object.is equality
 Tests  2 failed | 17 passed (19)
```

精準命中兩條測試：live 路徑靠 session-end 補完成的那條，以及 history 路徑靠載入端
補一筆 session-end 才變完成的那條。這兩條正是裁決 15「session-end 是唯一收尾訊號，
歷史路徑靠補一筆吃到同一條規則」這件事在測試裡的具體體現，拿掉 `applySessionEnd`
的呼叫，兩條防線一起消失。還原後重跑：`Tests  19 passed (19)`。

**突變 5 的實測輸出**（`applyUserText` 的 `block` 字面量改回
`complete: false`）：

```
 FAIL  tests/fold.test.ts > user-text：每個事件各自開一個新的 user turn，建立時直接 complete:true（裁決 5、15）
 > history fixture 第 1 行的使用者訊息變成一個 role: user 的 turn，complete 不等 block-stop 或 session-end
AssertionError: expected [ { kind: 'text', …(2) } ] to deeply equal [ { kind: 'text', …(2) } ]
 Tests  1 failed | 18 passed (19)
```

只有目標測試變紅，其餘 18 個不受影響，包含「history 路徑與 session-end 的分工」
那兩條：它們刻意只看 assistant turn 的 block（見 Step 1 的 `assistantCompletable`
輔助函式），不會被 user-text 的行為干擾，兩件事的測試範圍互不干擾。還原後重跑：
`Tests  19 passed (19)`。

**突變 6 的實測輸出**（裁決 17。`sessionEndError` 拿掉
`if (event.isError !== true) return undefined` 這行，無論 isError 為何都組 error 物件）：

```
 FAIL  tests/fold.test.ts > session 層級欄位 > 正常 session-end 之後 view.error 是 undefined（裁決 17）
AssertionError: expected {} to be undefined
 Tests  1 failed | 18 passed (19)
```

只有目標測試變紅：live fixture 完整跑完後 `isError` 是 `false`（Task 3「result 產出
session-end，帶成本與輪數」那條驗過的同一份 fixture），拿掉判斷後 `sessionEndError`
不分 isError 一律回傳（可能是空的）error 物件，`view.error` 從 `undefined` 變成 `{}`，
斷言 `toBeUndefined()` 落空。其餘 16 條不受影響，包含「isError 的 session-end 之後
view.error 帶 message 與 apiErrorStatus」那條：它驗證的是 error 物件的內容正確，這個
突變沒有改內容組裝邏輯，只是多了不該有的空物件，兩條測試踩的是同一個函式的不同面向。
還原後重跑：`Tests  19 passed (19)`。

**突變 7 的實測輸出**（裁決 22。`case 'reset'` 改成 `return view`）：

```
 FAIL  tests/fold.test.ts > reset：畫面從這裡重新開始（裁決 22） > reset 之前的事件不出現在結果裡，結果等於只餵 reset 之後的事件
AssertionError: expected { sessionId: 'sess-new', …(4) } to deeply equal { sessionId: 'sess-new', …(2) }
 Tests  1 failed | 18 passed (19)
```

**突變 8 的實測輸出**（`case 'unknown'` 改成 `return view`）：

```
 FAIL  tests/fold.test.ts > 不得靜默丟棄：認不出來的事件仍要有可見產出 > 手工合成的 unknown 事件掛到當下最後一個 turn 上，不憑空消失
AssertionError: expected [ 'text' ] to deeply equal [ 'text', 'unknown' ]
 Tests  1 failed | 18 passed (19)
```

裁決 1 之後 fixture 03 一個 unknown 都不產出，靠 fixture 已經測不到 `applyUnknown`，
這條合成測試是它唯一的防線。

八次突變後都確認測試變紅、還原後確認 19 個測試全綠，且每次還原都重新跑過
`tsc --noEmit` 確認無殘留的型別錯誤（2026-09-02 於暫時 worktree 實測，過程見上方
Step 4 的實測區塊）。

- [ ] **Step 6: 確認 coverage 已涵蓋 fold.ts**

`vitest.config.ts` 不必改：Task 1 已把 `'src/shared/**/*.ts'` 放進 `coverage.include`，
`src/shared/fold.ts` 與 Task 3 的 `src/shared/events.ts` 都被這個 glob 涵蓋（裁決 19：
每個 task 只增刪自己的檔案，不重寫整份清單）。

Run: `npx vitest run --coverage tests/fold.test.ts`
Expected: 覆蓋率報表出現 `src/shared/fold.ts` 一列，行覆蓋率 ≥ 80%。
實測（2026-09-02 於暫時 worktree，同時跑 `events.test.ts` 與 `fold.test.ts`）：
`fold.ts` 行覆蓋 95.83%、`events.ts` 97.67%。

- [ ] **Step 7: 執行完整測試套件**

Run: `npm test`
Expected: PASS。本文件撰寫當下（2026-09-02），專案既有測試共 59 個（`spawn-args`
11、`layout` 6、`ipc` 14、`cdp` 10、`measure-memory` 18，實際跑過 `npm test` 確認），
這是 Task 3／6／7 都還沒套用到專案時的基準數字。

執行本 task 時，Task 3（`events.ts` 與 `events.test.ts`）必須已經先套用，因為
`fold.ts` 直接 import 它的 `Event` 型別；Task 6、7 不是 `fold.ts` 的依賴，順序上
不影響本 task。實際總數 = 執行當下的既有總數 + 19（本 task 新增的 `fold.test.ts`，
先依裁決 5、15 從 12 條增為 15 條，依裁決 17 增為 17 條，再依裁決 1、22 增為 19 條）。
把當下實際跑出的數字記進報告，不要照抄本文件的 59 這個基準值，它只在 Task 3／6／7
都還沒套用的情況下成立。2026-09-02 的驗證 worktree 是從 `feat/a-sdk-host` 的 HEAD 開的
（Task 0、1、2 都還沒套用，所以既有測試仍是那 5 個檔 59 條），加上 Task 3 的 46 條與
本 task 的 19 條，`npm test` 是 `Test Files 7 passed`、`Tests 124 passed`。Task 0 刪
`spawn-args.test.ts`、Task 1 加 `session-args.test.ts` 之後這個基準會變，以當下實跑為準。

- [ ] **Step 8: 提交**

```bash
git add src/shared/fold.ts tests/fold.test.ts
git commit -m "feat: fold 核心，text/thinking 去重與 index 重置，complete 依裁決 5/15 三源決定，view.error 依裁決 17、reset 依裁決 22，tool_use 留最小佔位給 Task 4B"
```

---

### Task 4B: fold 的工具區塊狀態機

**2026-09-02 依裁決 1、2、17、22 修訂**：本 task 給的 `fold.ts` 與 `fold.test.ts` 都是**完整
檔案**，取代 Task 4 的版本，兩份都以 Task 4 的最終版為底重做，實跑驗過：

- 裁決 17：Task 4 最終版的 `sessionEndError()`、`ConversationView.error` 與兩條 error 測試
  全部保留。上一版本 task 的 `session-end` case 片段是在裁決 17 之前寫的，照著貼會把這個功能刪掉。
- 裁決 22：`case 'reset': return INITIAL_VIEW` 與對應測試保留。
- 裁決 2：測試改用 `tests/helpers/live-events.ts` 的 `liveEvents()`，不再有 `runLive`／
  `resetLiveNormalizer`／`beforeEach`。
- 裁決 1：fixture 03 不再產出 6 個 `unknown`，「不得靜默丟棄」那組改成 Task 4 最終版的兩條。
- 測試數從 28 改成 35（Task 4 的 19 條裡 17 條照留、2 條 `tool_use` 最小佔位斷言被本 task 的
  狀態轉移測試取代，加上本 task 的 18 條）。突變清單合併成 13 條。

Task 4 把 `tool_use` 相關事件縮到只剩一個 `status: 'streaming-input'` 的最小佔位，
狀態怎麼從那裡推進到 `running`／`done`／`error`／`denied`，留給這個 task。本 task
擴充同一個 `src/shared/fold.ts`，讓 `Block` 的 `tool` 變體吃滿 CONTRACT.md 定義的
六個狀態，不新增檔案。型別契約只多一個欄位：`Block` 的 `tool` 變體新增
`deniedReason?: string`（2026-09-02 裁決 12），其餘型別不變。

**設計判斷：`awaiting-approval` 由 Task 9 的 UI 層管理，`fold()` 不產生這個狀態**

結論先講：`fold()` 永遠不會把任何 tool block 標成 `awaiting-approval`。這個狀態的
存在與退出完全交給 Task 9。理由：

1. CONTRACT.md 的 `Event` 聯集裡沒有任何一種事件代表「正在等待批准」。批准走的是
   `canUseTool` 回呼加上 IPC 的 `approvalAsk`／`approvalReply`（CONTRACT.md 的 IPC
   一節），跟 SDK 訊息流是兩條完全分開的管線：`fold()` 只吃 `Event[]`，這條管線
   上的東西它天生看不到。
2. `fold()` 的契約明講是「純函式，沒有任何跨呼叫狀態」。核准中的 `requestId` 活在
   Task 6 的 `ApprovalRegistry` 裡，不在事件流裡，`fold()` 沒有管道拿到。
3. 就算想用「input 已知、還沒有 tool-result／permission-denied」這段沉默去猜測
   「正在等批准」，這個猜測不可靠：同一段沉默也會發生在「工具已經在跑，只是還沒
   回來」（例如一個慢的 Bash 指令）。這兩種情況從 `fold()` 的視角是同一個訊號，
   差別只在於當下的權限模式要不要問人，而這個資訊 `fold()` 沒有。
4. 所以 tool-use 完整快照到達時，`fold()` 誠實地推進到它唯一能確定的下一步：
   `running`。Task 10 疊加 UI 層的批准提示（裁決 28：以 `block.id === ask.toolUseId`
   找到對應的 tool block，由 `applyPendingApprovals` 疊加 `status: 'awaiting-approval'`），
   在畫面上蓋一層「等待批准」的視覺，不動 `fold()` 本身的狀態。

**裁決 28 定案**：`approvalAsk` 的 payload 是 `{ requestId, toolUseId, toolName, input,
title?, displayName? }`。本 task 原本記錄的疑慮（同一個工具短時間內發出兩次幾乎一樣的
呼叫時對不準確切的 `id`）先由裁決 11 以內容比對回應，2026-09-02 重查 `sdk.d.ts` 發現
`CanUseTool` 的 options 本來就有必填的 `toolUseID`，裁決 28 改成直接帶 `toolUseId`，
內容比對作廢。細節見文件末尾「契約疑慮」第 1 項。

**Files:**
- Modify: `src/shared/fold.ts`（Step 3 給完整檔案，取代 Task 4 的版本。差別是：新增六個
  函式、改寫 `applyToolUseSnapshot`、`Block` 的 `tool` 變體加 `deniedReason?: string`
  （裁決 12）、`applyEvent` 的 `session-end` case 疊加 `applyToolsSessionEnd`（裁決 15）。
  `ConversationView`／`Turn`／`sessionEndError`／`reset` case 一字不動）
- Modify: `tests/fold.test.ts`（Step 1 給完整檔案，取代 Task 4 的版本，35 個測試。
  Task 4 的 19 條裡 17 條照留，2 條 `tool_use` 最小佔位斷言被本 task 的狀態轉移測試取代，
  理由見下一節）

**Interfaces:**
- Consumes: Task 3 的 `Event`（特別是 `tool-input-delta`／`tool-use`／`tool-result`／
  `tool-raw-output`／`permission-denied`／`session-end` 這六種）與 `tests/helpers/live-events.ts`
  的 `liveEvents()`、Task 4 內部的 `WorkingView`／`BlockRecord`／`placeBlock`／
  `applyUnknown`／`applySessionEnd`（不匯出，本 task 直接複用；`applySessionEnd` 是
  Task 4 因裁決 5、15 新增的函式，只碰 `text`／`thinking` block，本 task 的
  `applyToolsSessionEnd` 只碰 `tool` block，兩者在同一個 `session-end` case 疊加呼叫）
- Produces：對外簽名不變，仍是 `function fold(events: readonly Event[]): ConversationView`。
  差別在回傳的 `Block`（`kind: 'tool'`）現在會真的推進 `status`、填 `result`／`raw`；
  `status: 'denied'` 時額外填 `deniedReason`（裁決 12，`result` 維持 `undefined`）；
  `session-end` 到達時，所有 `running`／`streaming-input` 的 tool block 收尾成
  `done`，`result` 維持 `undefined`（裁決 15）。

**與 Task 4 的相容性：只有兩條既有斷言被取代，其餘 17 條照留**

Task 4 的「tool_use：只給最小佔位」那組測試，斷言 live 與 history 兩條路徑跑完
整份 fixture 後 `status` 都停在 `streaming-input`。這在 Task 4 的範圍內是對的（它
刻意不處理 `tool-use`／`tool-result`），但本 task 一旦接手狀態推進，兩份 fixture
（`03-sdk-live-stream.jsonl`、`04-session-history.jsonl`）都在那顆 Bash 工具呼叫
之後接了一個 `is_error:false` 的 `tool_result`，所以完整跑完後，正確答案是
`status: 'done'`，不會再是 `streaming-input`。這不是我選擇要改，是事實：fixture
本來就録到了完整的工具生命週期，Task 4 只是還沒有程式碼去讀那段尾巴。

實測驗證（見 Step 4／5，已在 worktree 跑過）：兩條路徑跑完 `status` 確實都是
`'done'`，`id`／`name`／`input` 不變。下面 Step 1 的測試檔案把這兩條換成本 task 的
狀態轉移測試（live 六條、history 三條）。

Task 4 其餘 17 條測試逐字保留，包含裁決 5、15 的 complete 三源、裁決 17 的兩條
`view.error`、裁決 22 的 `reset`，以及裁決 1 之後改寫的兩條 unknown。本 task 對
`session-end` 的測試（tool block 收尾那一半）與 Task 4 的（text／thinking 那一半）
是互補的，兩組同時在檔案裡。

- [ ] **Step 1: 寫失敗的測試**

`tests/fold.test.ts`（完整檔案，取代 Task 4 的版本；第一段：fixture／輔助函式，以及
Task 4 逐字保留的前四組測試）：

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fold, type ConversationView, type Turn, type Block } from '../src/shared/fold.js'
import { normalizeHistory, type Event } from '../src/shared/events.js'
import { liveEvents } from './helpers/live-events.js'

/** 讀一份錄下的事件流。規格 §9：案例來自真實資料而非測試自己造的。 */
function readFixture(name: string): readonly unknown[] {
  return readFileSync(`tests/fixtures/events/${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

function runHistory(msgs: readonly unknown[]): readonly Event[] {
  return msgs.flatMap((m) => [...normalizeHistory(m)])
}

function allBlocks(view: ConversationView): readonly Block[] {
  return view.turns.flatMap((t: Turn) => t.blocks)
}

function toolBlocksOf(view: ConversationView) {
  return allBlocks(view).filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool')
}

const LIVE = readFixture('03-sdk-live-stream')
const HISTORY = readFixture('04-session-history')
const DENIED = readFixture('02-permission-denied')

describe('fixture 守衛', () => {
  it('三份 fixture 都讀得到內容（fixture 被誤刪時測試會對空陣列跑然後全過）', () => {
    expect(LIVE.length).toBeGreaterThanOrEqual(50)
    expect(HISTORY.length).toBeGreaterThanOrEqual(6)
    expect(DENIED.length).toBeGreaterThanOrEqual(20)
  })
})

describe('去重：同一個 (messageId, index) 的完整快照取代 delta 累積，不是附加', () => {
  it('8 筆 text-delta 疊出 466 字元，完整快照到達後仍是 466 字元而非 932', () => {
    const view = fold(liveEvents(LIVE))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    // fixture 第 42-49 行：8 筆 text_delta 疊出 466 字元；第 50 行的完整 text 也是 466 字元
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.markdown).toHaveLength(466)
  })
})

describe('index 重置：不同訊息各自從 0 開始的 block index 不能混在一起', () => {
  it('兩則訊息各自的 index=0 thinking block 各自獨立，不被合併成一個', () => {
    const view = fold(liveEvents(LIVE))
    const assistantTurns = view.turns.filter((t) => t.role === 'assistant')
    // fixture 第 12 行（msg1 index=0）與第 33 行（msg2 index=0）都是 thinking block-start，
    // 若去重鍵只用 index 會被誤判成同一個 block
    expect(assistantTurns).toHaveLength(2)
    expect(assistantTurns[0]?.messageId).toBe('msg_011CecHvRnPBQEKKkvdkgXkj')
    expect(assistantTurns[1]?.messageId).toBe('msg_011CecHvmWYSkjexndc45ePc')
    const thinkingBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'thinking' }> => b.kind === 'thinking'
    )
    expect(thinkingBlocks).toHaveLength(2)
  })
})

describe('complete 的來源：block-stop 或 session-end（裁決 5、15）', () => {
  it('拿掉最後一個 block-stop（第 51 行）且截掉尾端的 result 訊息（第 52-54 行），text block 仍是 complete:false', () => {
    // 只餵到第 50 行：完整 text 快照已經到，但 block-stop（51）與 result 訊息
    // （52-54，會產出 session-end）都還沒到，兩個 complete 來源都不在場
    const view = fold(liveEvents(LIVE.slice(0, 50)))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.complete).toBe(false)
  })

  it('只截掉第 51 行的 block-stop、保留尾端的 result 訊息，text block 因 session-end 而 complete:true', () => {
    // 拿掉陣列裡的第 51 行（index 50），52-54 行原樣保留，session-end 仍會發生
    const withoutBlockStopOnly = [...LIVE.slice(0, 50), ...LIVE.slice(51)]
    const view = fold(liveEvents(withoutBlockStopOnly))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.complete).toBe(true)
  })

  it('餵完整事件流（含第 51 行的 block-stop）後 text block 變成 complete:true', () => {
    const view = fold(liveEvents(LIVE))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks[0]?.complete).toBe(true)
  })
})

```

以下六段對應六個狀態的轉移，全部用真實 fixture 03 的 Bash 工具呼叫（第 20-30 行：
`block-start`→4 筆 `tool-input-delta`→完整快照→`block-stop`→`tool-result`＋
`tool-raw-output`）分段餵入，用 `.slice(0, N)` 卡住餵到哪一行：

```typescript
describe('Bash 工具生命週期（真實 fixture 03，line 20-30）', () => {
  it('block-start 後：streaming-input，input 未知', () => {
    const view = fold(liveEvents(LIVE.slice(0, 20)))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual({
      kind: 'tool',
      id: 'toolu_01L2YCZHqTvRDmdkNpsprfCQ',
      name: 'Bash',
      input: undefined,
      status: 'streaming-input',
    })
  })

  it('4 筆 tool-input-delta 累積進 inputPartial，狀態仍是 streaming-input', () => {
    const view = fold(liveEvents(LIVE.slice(0, 24)))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('streaming-input')
    expect(tools[0]?.input).toBeUndefined()
    expect(tools[0]?.inputPartial).toBe(
      '{"command": "echo hello > cap.txt && ls -l cap.txt && cat cap.txt", "description": "Write hello to cap.txt and verify"}'
    )
  })

  it('完整快照到達：input 有值，狀態推進到 running', () => {
    const view = fold(liveEvents(LIVE.slice(0, 25)))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('running')
    expect(tools[0]?.input).toEqual({
      command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
      description: 'Write hello to cap.txt and verify',
    })
  })

  it('block-stop（第 26 行）不改動 tool block（tool 沒有 complete 欄位）', () => {
    const view = fold(liveEvents(LIVE.slice(0, 26)))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('running')
  })

  it('tool-result(isError:false) 與 tool-raw-output（第 30 行同一則訊息）到達：done，raw 與 result 都填入', () => {
    const view = fold(liveEvents(LIVE.slice(0, 30)))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBe('-rw-r--r--@ 1 me  wheel  6  9月  1 15:03 cap.txt\nhello')
    expect(tools[0]?.raw).toEqual({
      stdout: '-rw-r--r--@ 1 me  wheel  6  9月  1 15:03 cap.txt\nhello',
      stderr: '',
      interrupted: false,
    })
  })

  it('完整跑完整份 fixture：狀態最終停在 done（取代 Task 4 原本「停在 streaming-input」的斷言）', () => {
    const view = fold(liveEvents(LIVE))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
  })
})

```

裁決 15 的另一半（Task 4 只收尾 `text`／`thinking`，`tool` block 收尾是本 task 的
範圍，見 Step 3）：`session-end` 到達時，`running`／`streaming-input` 的 tool
block 一律收尾成 `done`，`result` 維持 `undefined`；`denied`／`done`／`error`
已經是終態，不受影響。前兩條各自截斷真實 fixture 03 到「running 但 tool-result
還沒到」（第 29 行）與「streaming-input，快照都還沒到」（第 24 行）的那一刻，
補一筆合成的 `session-end` 事件（跟 Task 11 的 `session-store.ts` 幫歷史對話補
`session-end` 是同一種手法，見裁決 15）：

```typescript
describe('session-end：running／streaming-input 的 tool block 收尾（裁決 15）', () => {
  it('running 的 tool block 在 session-end 之後變成 done，result 維持 undefined', () => {
    // 第 20-29 行：tool-use 完整快照已到（running，見上一組第 25 行），tool-result
    // 還沒到（第 30 行）。query 在這一刻結束，running 不會再等到結果。
    const events = [...liveEvents(LIVE.slice(0, 29)), { kind: 'session-end' as const, isError: false }]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBeUndefined()
  })

  it('streaming-input 的 tool block 在 session-end 之後也變成 done（快照沒到就代表串流被中斷）', () => {
    const events = [...liveEvents(LIVE.slice(0, 24)), { kind: 'session-end' as const, isError: false }]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBeUndefined()
  })

  it('denied 是終態，session-end 不覆蓋', () => {
    const events = [...liveEvents(DENIED), { kind: 'session-end' as const, isError: false }]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('denied')
  })

  it('done／error 已經是終態，session-end 不覆蓋', () => {
    const errorEvents: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg-err' },
      { kind: 'block-start', messageId: 'msg-err', index: 1, blockType: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_ERR' },
      { kind: 'tool-use', messageId: 'msg-err', index: 1, id: 'toolu_ERR', name: 'Bash', input: { command: 'false' } },
      { kind: 'tool-result', id: 'toolu_ERR', content: 'command exited 1', isError: true },
      { kind: 'session-end', isError: false },
    ]
    expect(toolBlocksOf(fold(errorEvents))[0]?.status).toBe('error')

    const doneEvents = [...liveEvents(LIVE.slice(0, 30)), { kind: 'session-end' as const, isError: false }]
    expect(toolBlocksOf(fold(doneEvents))[0]?.status).toBe('done')
  })
})

```

`permission-denied` 的兩個要求分開驗證：狀態轉移本身（用真實 fixture 02，它剛好
也證明了「denied 是終態」這件事），以及「多個工具呼叫同時存在時不能標錯」（真實
fixture 沒有兩個工具同時掛著的情境，這裡手工建構 `Event[]`（`fold()` 本來就吃
`Event[]`，不必經過 `stepLive`，這樣構造不算脫離「測 fold()」的範圍）：

```typescript
describe('permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉', () => {
  it('permission_denied 先到 → denied（deniedReason 有值，result 維持 undefined）；隨後 isError:true 的 tool-result 到達 → 仍是 denied 不是 error', () => {
    const view = fold(liveEvents(DENIED))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.id).toBe('toolu_015NDSGktRsH8rWhzAALV3vY')
    expect(tools[0]?.status).toBe('denied')
    // 裁決 12：拒絕理由填 deniedReason，不再塞進 result（result 的語意是工具的
    // 執行結果，denied 的工具根本沒有執行）
    expect(tools[0]?.deniedReason).toEqual(expect.stringContaining('was blocked'))
    expect(tools[0]?.result).toBeUndefined()
    // tool_use_result 是字串形式（裁決 3），raw 仍然要填，跟 status／deniedReason 是不同維度
    expect(tools[0]?.raw).toEqual({
      stdout: expect.stringContaining('was blocked'),
      stderr: '',
      interrupted: false,
    })
  })

  it('沒有前置 block-start（fixture 02 全程沒有 stream_event）時，tool-use 快照本身直接新建 running', () => {
    const view = fold(liveEvents(DENIED.slice(0, 15))) // 只到 tool_use 快照，permission_denied 第 16 行還沒到
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('running')
    expect(tools[0]?.input).toEqual({
      command: 'rm -f nonexistent-probe.txt',
      description: 'Remove nonexistent-probe.txt if present',
    })
  })
})

describe('permission-denied 精準對應到正確 block（合成資料）', () => {
  const twoToolEvents: readonly Event[] = [
    { kind: 'message-start', messageId: 'msg-multi' },
    { kind: 'block-start', messageId: 'msg-multi', index: 1, blockType: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_AAA' },
    { kind: 'tool-use', messageId: 'msg-multi', index: 1, id: 'toolu_AAA', name: 'Bash', input: { command: 'rm -rf /' } },
    { kind: 'block-start', messageId: 'msg-multi', index: 3, blockType: 'tool_use', toolName: 'Read', toolUseId: 'toolu_BBB' },
    { kind: 'tool-use', messageId: 'msg-multi', index: 3, id: 'toolu_BBB', name: 'Read', input: { file_path: '/etc/hosts' } },
    { kind: 'permission-denied', toolName: 'Read', toolUseId: 'toolu_BBB', message: '危險指令被擋下' },
  ]

  it('只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響', () => {
    // 刻意讓被拒絕的是「後加入 records 的那一個」：如果查找邏輯退化成「抓第一個
    // tool block」而不是真的比對 id，這條測試才會被準確命中，見 Step 5 突變 2，
    // 這不是隨手安排，是驗算過的（先前一版把 denied 目標放在第一個工具上，突變
    // 2 完全測不出來，findIndex 天生回傳第一個符合的元素，撞上了）。
    const view = fold(twoToolEvents)
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(2)
    const aaa = tools.find((t) => t.id === 'toolu_AAA')
    const bbb = tools.find((t) => t.id === 'toolu_BBB')
    expect(bbb?.status).toBe('denied')
    expect(bbb?.deniedReason).toBe('危險指令被擋下')
    expect(bbb?.result).toBeUndefined()
    expect(aaa?.status).toBe('running')
    expect(aaa?.result).toBeUndefined()
  })
})

describe('tool-result(isError:true) 且從未被 denied：純粹的執行失敗（合成資料，理由：現有 fixture 唯一的 isError:true 案例是 fixture 02 的拒絕情境，無法單獨驗證「失敗」不牽動「拒絕」的邏輯）', () => {
  it('status 變成 error，不是 denied', () => {
    const events: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg-err' },
      { kind: 'block-start', messageId: 'msg-err', index: 1, blockType: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_ERR' },
      { kind: 'tool-use', messageId: 'msg-err', index: 1, id: 'toolu_ERR', name: 'Bash', input: { command: 'false' } },
      { kind: 'tool-result', id: 'toolu_ERR', content: 'command exited 1', isError: true },
    ]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('error')
    expect(tools[0]?.result).toBe('command exited 1')
  })
})

describe('孤兒事件不靜默丟棄：tool-result／tool-raw-output／permission-denied 找不到對應 block', () => {
  it('tool-result 指名一個不存在的 id 時，產出可見的 unknown block 而不是被吞掉', () => {
    const events: readonly Event[] = [
      { kind: 'user-text', text: '隨便說點什麼開一個 turn' },
      { kind: 'tool-result', id: 'toolu_NOWHERE', content: 'x', isError: false },
    ]
    const view = fold(events)
    const unknowns = allBlocks(view).filter((b) => b.kind === 'unknown')
    expect(unknowns).toHaveLength(1)
    expect(toolBlocksOf(view)).toHaveLength(0)
  })
})

```

歷史路徑：更正 Task 4 的斷言，並補上裁決 4 要求的「無原始輸出」測試：

```typescript
describe('history 路徑（fixture 04）：tool block 的 status 與 raw', () => {
  it('id/name/input 不變；status 因為第 4 行有 tool_result 而推進到 done，不再停在 streaming-input', () => {
    const view = fold(runHistory(HISTORY))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(tools[0]?.name).toBe('Bash')
    expect(tools[0]?.input).toEqual({
      command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
      description: 'Write hello to cap.txt and verify',
    })
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBe('-rw-r--r--@ 1 me  wheel  6  9月  1 15:03 cap.txt\nhello')
  })

  it('裁決 4：history 沒有 tool-raw-output，raw 必須是 undefined（明確的「無」），不是空字串組成的物件', () => {
    const view = fold(runHistory(HISTORY))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.raw).toBeUndefined()
    // 反例對照：live 路徑同一顆工具的 raw 是有內容的物件，兩者不該長得一樣，
    // UI（Task 11）要能靠 raw === undefined 分辨「歷史對話沒存」跟「工具沒輸出」
    const liveView = fold(liveEvents(LIVE))
    expect(toolBlocksOf(liveView)[0]?.raw).not.toBeUndefined()
  })

  it('裁決 13／15 的分工：拿掉 tool_result（第 4 行）後 fold(history) 停在 running；載入端補一筆 session-end 才變成 done', () => {
    // HISTORY[3]（0-based）就是第 4 行的 tool_result 訊息（實測 fixture 04 確認：
    // 第 1 行 user、第 2 行 thinking、第 3 行 tool_use、第 4 行 tool_result）
    const withoutToolResult = HISTORY.filter((_, i) => i !== 3)
    const events = runHistory(withoutToolResult)

    const runningView = fold(events)
    const runningTools = toolBlocksOf(runningView)
    expect(runningTools).toHaveLength(1)
    expect(runningTools[0]?.status).toBe('running')

    // Task 11 的 session-store.ts 在載入歷史時於事件尾端補這一筆（裁決 15）
    const endedView = fold([...events, { kind: 'session-end', isError: false }])
    const endedTools = toolBlocksOf(endedView)
    expect(endedTools[0]?.status).toBe('done')
    expect(endedTools[0]?.result).toBeUndefined()
  })
})

```

最後一段是 Task 4 剩下的測試，逐字保留（前四組已經放在檔案開頭）：

```typescript
describe('history 路徑：assistant 訊息沒有 index，多個 block 依序附加進同一個 turn', () => {
  it('同一個 messageId 的 thinking 與 tool_use 兩個 block 依序附加，不互相取代', () => {
    const view = fold(runHistory(HISTORY))
    // fixture 04 第 2、3 行都是 msg_011CecHvRnPBQEKKkvdkgXkj：先 thinking 後 tool_use
    const turn = view.turns.find((t) => t.messageId === 'msg_011CecHvRnPBQEKKkvdkgXkj')
    expect(turn).toBeDefined()
    expect(turn?.blocks.map((b) => b.kind)).toEqual(['thinking', 'tool'])
  })
})

describe('history 路徑與 session-end 的分工（裁決 15：載入端補一筆）', () => {
  // 只看 assistant turn 的 block：user-text 建立時就直接 complete:true（另一條
  // 規則），跟這裡要驗證的「history 的 assistant block 要靠 session-end 才變完成」
  // 是兩回事，混進來會讓斷言失真。
  function assistantCompletable(view: ConversationView) {
    return view.turns
      .filter((t) => t.role === 'assistant')
      .flatMap((t) => t.blocks)
      .filter(
        (b): b is Extract<Block, { kind: 'text' | 'thinking' }> => b.kind === 'text' || b.kind === 'thinking'
      )
  }

  it('fixture 04 本身沒有 session-end，fold(normalizeHistory 產出) 的 assistant text／thinking block 全部 complete:false', () => {
    const view = fold(runHistory(HISTORY))
    const completable = assistantCompletable(view)
    // fixture 04：msg1 一個 thinking，msg2 一個 thinking 加一個 text，共 3 個
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === false)).toBe(true)
  })

  it('載入端補一筆 { kind: session-end, isError: false } 後，同一批 assistant block 全部變 complete:true', () => {
    const events: readonly Event[] = [...runHistory(HISTORY), { kind: 'session-end', isError: false }]
    const view = fold(events)
    const completable = assistantCompletable(view)
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === true)).toBe(true)
  })
})

describe('不得靜默丟棄：認不出來的事件仍要有可見產出', () => {
  it('fixture 03 全程沒有 unknown Event，fold 之後也沒有 unknown block（裁決 1）', () => {
    const events = liveEvents(LIVE)
    // 裁決 1：signature_delta／message_delta／message_stop 認得出來但沒有可渲染內容，
    // Task 3 回空陣列，所以這份 fixture 一個 unknown 都不該有
    expect(events.filter((e) => e.kind === 'unknown')).toHaveLength(0)
    const view = fold(events)
    expect(allBlocks(view).filter((b) => b.kind === 'unknown')).toHaveLength(0)
  })

  it('手工合成的 unknown 事件掛到當下最後一個 turn 上，不憑空消失', () => {
    const raw = { type: 'brand_new_sdk_event', payload: 42 }
    const events: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg-1' },
      { kind: 'text', messageId: 'msg-1', index: 0, text: 'hi' },
      { kind: 'unknown', raw },
    ]
    const view = fold(events)
    const lastTurn = view.turns[view.turns.length - 1]
    expect(lastTurn?.messageId).toBe('msg-1')
    // 只看排列與 unknown block 本身：complete 是另一組規則的事，混進來會讓這條測試
    // 對不相干的改動變紅
    expect(lastTurn?.blocks.map((b) => b.kind)).toEqual(['text', 'unknown'])
    expect(lastTurn?.blocks[1]).toEqual({ kind: 'unknown', raw })
  })
})

describe('user-text：每個事件各自開一個新的 user turn，建立時直接 complete:true（裁決 5、15）', () => {
  it('history fixture 第 1 行的使用者訊息變成一個 role: user 的 turn，complete 不等 block-stop 或 session-end', () => {
    const view = fold(runHistory(HISTORY))
    const userTurns = view.turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0]?.blocks).toEqual([
      { kind: 'text', markdown: expect.stringContaining('echo hello'), complete: true },
    ])
  })
})

describe('reset：畫面從這裡重新開始（裁決 22）', () => {
  it('reset 之前的事件不出現在結果裡，結果等於只餵 reset 之後的事件', () => {
    const before: readonly Event[] = [
      { kind: 'session-start', sessionId: 'sess-old' },
      { kind: 'message-start', messageId: 'msg-old' },
      { kind: 'text', messageId: 'msg-old', index: 0, text: '上一場的內容' },
      { kind: 'session-end', isError: true, errorMessage: 'boom' },
    ]
    const after: readonly Event[] = [
      { kind: 'session-start', sessionId: 'sess-new' },
      { kind: 'message-start', messageId: 'msg-new' },
      { kind: 'text', messageId: 'msg-new', index: 0, text: '新的一場' },
    ]
    const view = fold([...before, { kind: 'reset' }, ...after])
    expect(view).toEqual(fold(after))
    expect(JSON.stringify(view)).not.toContain('上一場的內容')
    expect(view.sessionId).toBe('sess-new')
    expect(view.ended).toBe(false)
    expect(view.error).toBeUndefined()
  })
})

describe('session 層級欄位', () => {
  it('session-start 設定 sessionId，session-end 設定 ended 與 cost', () => {
    const view = fold(liveEvents(LIVE))
    // fixture 第 9 行 session_id，第 54 行 total_cost_usd／num_turns
    expect(view.sessionId).toBe('a727625f-71c3-49c8-8646-2414bede4756')
    expect(view.ended).toBe(true)
    expect(view.cost?.usd).toBeCloseTo(0.3197795)
    expect(view.cost?.turns).toBe(2)
  })

  it('沒有收到 session-end 之前 ended 是 false', () => {
    const view = fold(liveEvents(LIVE.slice(0, 53)))
    expect(view.ended).toBe(false)
  })

  it('isError 的 session-end 之後 view.error 帶 message 與 apiErrorStatus（裁決 17）', () => {
    const events: readonly Event[] = [
      { kind: 'session-end', isError: true, errorMessage: 'boom', apiErrorStatus: 500 },
    ]
    const view = fold(events)
    expect(view.error).toEqual({ message: 'boom', apiErrorStatus: 500 })
  })

  it('正常 session-end 之後 view.error 是 undefined（裁決 17）', () => {
    const view = fold(liveEvents(LIVE))
    expect(view.ended).toBe(true)
    expect(view.error).toBeUndefined()
  })
})
```

35 個測試的來源：Task 4 最終版 19 條裡 17 條逐字保留（`tool_use` 最小佔位那 2 條被
取代）；本 task 新增 18 條：Bash 生命週期 6 條、`session-end` 收尾 tool block 4 條、
`permission-denied` 用 fixture 02 的 2 條、`permission-denied` 精準對應 1 條、
純粹執行失敗 1 條、孤兒事件 1 條、history 路徑 3 條。17 + 18 = 35。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/fold.test.ts`
Expected: FAIL。`fold.ts` 現在還是 Task 4 的版本（已含裁決 5、15 的 `applySessionEnd`
與 `applyUserText` 的 `complete:true`，但 `applyToolResult`／`applyToolRawOutput`／
`applyPermissionDenied`／`applyToolInputDelta`／`applyToolsSessionEnd` 都不存在），
但因為這些都是內部函式（`fold.test.ts` 只 import `fold` 本身），實際會看到的不是
「找不到函式」，而是新測試斷言值錯誤，例如「block-stop 不改動 tool block」讀到
`status` 停在 `'streaming-input'`（因為 Task 4 版本的 `tool-input-delta`／
`tool-result` 是 no-op，`applyToolUseSnapshot` 也還不推進到 `running`），跟預期的
`'running'`／`'done'` 對不上；`inputPartial` 的測試會讀到 `undefined`。

實測（把 Task 4 最終版的 `fold.ts` 放進 worktree，只套用本 task 的 `fold.test.ts`，
不套用本 task 對 `fold.ts` 的修改）：`Tests  17 failed | 18 passed (35)`。18 條
PASS 的是「block-start 後：streaming-input」與 17 條逐字保留自 Task 4 的測試；
其餘 17 條全部涉及工具狀態推進、`deniedReason` 或 `session-end` 收尾 tool block，
全部 FAIL，符合預期。

- [ ] **Step 3: 寫最小實作**

`src/shared/fold.ts` 完整檔案，取代 Task 4 的版本。跟 Task 4 最終版的差別只有四處：
`Block` 的 `tool` 變體加 `deniedReason?: string`（裁決 12）、`applyToolUseSnapshot`
從「有既有 block 就原樣不動」改成「填 input、推進到 running」、新增六個工具狀態函式、
`applyEvent` 的四個 case 接上它們。`ConversationView`／`Turn`／`sessionEndError`
（裁決 17）／`case 'reset'`（裁決 22）與其餘所有函式一字不動。

第一段：檔案開頭的說明、三個對外型別（`Block` 的 `tool` 變體多了 `deniedReason`）、
內部工作模型與去重機制。

```typescript
/**
 * 把 Event 流投影成畫面要的 ConversationView（規格 4.2）。
 *
 * text、thinking、unknown 三種 Block 之外，tool block 的六個狀態推進也在這裡
 * （streaming-input / running / done / error / denied，awaiting-approval 由 Task 10 疊加）。
 */

import type { Event } from './events.js'

export interface ConversationView {
  readonly sessionId?: string
  readonly turns: readonly Turn[]
  readonly cost?: { readonly usd?: number; readonly turns?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增：session-end 的 isError:true 時由 fold() 設定，isError:false 維持 undefined。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

export interface Turn {
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
  readonly blocks: readonly Block[]
}

export type Block =
  | { readonly kind: 'text'; readonly markdown: string; readonly complete: boolean }
  | { readonly kind: 'thinking'; readonly text: string; readonly complete: boolean }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly inputPartial?: string
      readonly result?: unknown
      readonly deniedReason?: string
      readonly raw?: { readonly stdout: string; readonly stderr: string; readonly interrupted: boolean }
      readonly status: 'streaming-input' | 'awaiting-approval' | 'denied' | 'running' | 'done' | 'error'
    }
  | { readonly kind: 'unknown'; readonly raw: unknown }

/*
 * 內部工作模型：turn 的先後順序與身分，跟 turn 裝了哪些 block，分成兩份全域資料，
 * 不是每個 turn 自己揹一份 blocks 陣列。原因是去重規則的核心矛盾就發生在這裡：
 *
 * 規格明講去重鍵必須是 (messageId, index) 的組合，理由是 index 每則訊息各自從 0
 * 開始，只用 index 會把不同訊息的 block 混在一起。若實作把 block 直接放進各自
 * turn 自己的陣列裡（先用 messageId 找到 turn，再用 index 找 turn 內的 block），
 * messageId 這個維度其實已經靠「先找到哪個 turn」悄悄補上了，(messageId, index)
 * 會退化成只剩 index 在做事：那樣的話，去重鍵不管有沒有帶 messageId，結果都一樣，
 * 「把鍵改成只用 index」這種錯誤實作會完全測不出來，因為 turn 的分隔已經先擋掉問題。
 *
 * 所以這裡刻意用一份全域、跨所有 turn 的 records 清單，去重查找不先按 turn 分流，
 * 直接對整份清單比對鍵。這樣鍵要不要帶 messageId 才是唯一防線，錯了會真的讓兩則
 * 訊息的 index=0 撞在一起。turn 的先後順序另外記在 turnOrder，最後再用 turnId
 * 把 records 分組回各自的 turn。
 */

interface TurnMeta {
  readonly turnId: string
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
}

/** key 為 null 表示不可去重（history 路徑的 assistant 訊息沒有 index），一律附加。 */
interface BlockRecord {
  readonly turnId: string
  readonly key: string | null
  readonly block: Block
}

interface WorkingView {
  readonly sessionId?: string
  readonly turnOrder: readonly TurnMeta[]
  readonly records: readonly BlockRecord[]
  readonly cost?: { readonly usd?: number; readonly turns?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增，見 sessionEndError。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

const INITIAL_VIEW: WorkingView = { turnOrder: [], records: [], ended: false }

/**
 * 去重鍵：用 JSON.stringify 把 messageId 與 index 兩個維度編碼成同一個字串，
 * 不必自己挑分隔字元、也不必煩惱 messageId 裡會不會剛好出現那個分隔字元。
 * index 是 undefined 時代表 history 路徑的多 block 訊息（沒有 index 可用），
 * 回傳 null，呼叫端據此改成一律附加而非查表比對。
 */
function blockKey(messageId: string, index: number | undefined): string | null {
  return index === undefined ? null : JSON.stringify([messageId, index])
}

// ---- turn 身分：assistant 用 messageId 本身當 turnId，user 每次生一個新的 ----

function hasAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): boolean {
  return turnOrder.some((t) => t.role === 'assistant' && t.messageId === messageId)
}

/** 確保 messageId 有一個 assistant turn 存在；不存在就在陣列尾端新增。turnId 直接用 messageId。 */
function ensureAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): readonly TurnMeta[] {
  return hasAssistantTurn(turnOrder, messageId)
    ? turnOrder
    : [...turnOrder, { turnId: messageId, role: 'assistant' as const, messageId }]
}

/**
 * 全域去重：查找與寫入都對整份 records 清單直接比對 key，不先按 turnId 分流。
 * 這是讓「鍵要不要帶 messageId」這件事真正有意義的關鍵設計，見檔案開頭的說明。
 *
 * key 為 null（history 路徑，沒有 index）：一律新增一筆 record，不查表，效果
 * 等同附加在該 turn 的尾端（buildTurns 依 records 原始順序分組，天然保序）。
 * key 不為 null：查表命中就整份「取代」原本的 block（不是附加），查不到就新增
 * 並記住這把 key。build 收到既有 block（找不到就是 undefined），由呼叫端決定
 * 要不要延續舊內容（例如 text-delta 要接、完整快照要蓋）。
 */
function placeBlock(
  records: readonly BlockRecord[],
  turnId: string,
  key: string | null,
  build: (existing: Block | undefined) => Block
): readonly BlockRecord[] {
  const existing = key === null ? undefined : records.find((r) => r.key === key)
  if (existing === undefined) return [...records, { turnId, key, block: build(undefined) }]
  return records.map((r) => (r.key === key ? { ...r, block: build(existing.block) } : r))
}

```

第二段：text／thinking 的 delta 累加與快照取代、`applyBlockStop`、`applySessionEnd`
（只碰 text／thinking），以及裁決 17 的 `sessionEndError`。這一段與 Task 4 最終版
逐字相同。

```typescript
// ---- text／thinking：delta 累加，完整快照取代 ----

function applyTextDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'text' ? existing.markdown : ''
    return { kind: 'text', markdown: prev + text, complete: false }
  })
}

function applyThinkingDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'thinking' ? existing.text : ''
    return { kind: 'thinking', text: prev + text, complete: false }
  })
}

/**
 * 完整快照「取代」delta 累積出來的內容，不是附加：同一份內容用兩種方式送達，
 * 只算一份。key 為 null（history，無 index）時 placeBlock 一律新增，效果等同附加。
 * complete 延續既有值：block-stop 或 session-end 先到或後到都不影響這裡的判斷，
 * 這裡只是不要把已經標記的 complete 蓋回 false（見 applyBlockStop、applySessionEnd）。
 */
function applyTextSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'text' ? existing.complete : false
    return { kind: 'text', markdown: text, complete }
  })
}

function applyThinkingSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'thinking' ? existing.complete : false
    return { kind: 'thinking', text, complete }
  })
}

/**
 * complete 的來源之一（另外兩個是 applySessionEnd 與 user-text 建立時，見裁決
 * 5、15）。這裡只讓「收到 block-stop 的那一個」block 變完成，其餘不動。
 */
function applyBlockStop(records: readonly BlockRecord[], messageId: string, index: number): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing === undefined) {
      // 協定不應該讓 block-stop 搶在任何內容之前抵達；真的發生時不要吃掉這個事件，
      // 留一個看得見的痕跡而不是靜默略過。
      return { kind: 'unknown', raw: { note: 'block-stop 沒有對應的 block', messageId, index } }
    }
    if (existing.kind === 'text' || existing.kind === 'thinking') return { ...existing, complete: true }
    // tool／unknown 沒有 complete 欄位，block-stop 對它們沒有意義，維持原樣。
    return existing
  })
}

/**
 * complete 的另一個來源（裁決 5、15）：session-end 到達時，「其餘所有」
 * text／thinking block 一律變完成，不分是否曾收到各自的 block-stop。這裡回傳
 * 新陣列，每筆需要改的 record 也是新物件，不就地改動舊的。
 *
 * tool block 這裡不動：running -> done 的推進是裁決 15 的另一半，由
 * applyToolsSessionEnd 負責，兩者在同一個 case 疊加呼叫。
 *
 * 歷史路徑不是這裡的特例：載入端（Task 11 的 session-store.ts）在
 * normalizeHistory 產出的事件尾端補一筆 session-end，會自然走到這個函式，
 * fold() 本身不需要知道事件是從哪條路徑來的。
 */
function applySessionEnd(records: readonly BlockRecord[]): readonly BlockRecord[] {
  return records.map((r) => {
    if (r.block.kind !== 'text' && r.block.kind !== 'thinking') return r
    return { ...r, block: { ...r.block, complete: true } }
  })
}

/**
 * session-end 的第四個效果（裁決 17，跟上面的 complete 規則是兩件事）：isError 為 true
 * 時把 errorMessage／apiErrorStatus 收進 view.error，兩個欄位都用條件展開避免寫入
 * undefined 鍵；isError 為 false 時回傳 undefined，讓 error 維持不設。
 */
function sessionEndError(
  event: Extract<Event, { kind: 'session-end' }>
): WorkingView['error'] {
  if (event.isError !== true) return undefined
  return {
    ...(event.errorMessage === undefined ? {} : { message: event.errorMessage }),
    ...(event.apiErrorStatus === undefined ? {} : { apiErrorStatus: event.apiErrorStatus }),
  }
}

```

第三段：`block-start` 的最小佔位，以及改寫過的 `applyToolUseSnapshot`。history 沒有
前置 `block-start` 時（`existing` 是 `undefined`）新建也直接落在 `running`，不特別
區分 live／history，兩者的差異已經完全由「`existing` 有沒有東西」表達。

```typescript
// ---- tool_use：block-start 的最小佔位 ----

function applyBlockStart(
  records: readonly BlockRecord[],
  messageId: string,
  index: number,
  blockType: 'text' | 'thinking' | 'tool_use',
  toolName: string | undefined,
  toolUseId: string | undefined
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, () => {
    if (blockType === 'text') return { kind: 'text', markdown: '', complete: false }
    if (blockType === 'thinking') return { kind: 'thinking', text: '', complete: false }
    return { kind: 'tool', id: toolUseId ?? '', name: toolName ?? '', input: undefined, status: 'streaming-input' }
  })
}

/**
 * 完整快照到達：填 input 並推進到 running。live 路徑上 block-start 已經放了佔位，
 * history 路徑沒有 block-start，tool-use 快照是該工具呼叫唯一會抵達的事件，這裡新建。
 * 兩者的差別已經完全由「existing 有沒有東西」表達，不必另外分支。
 *
 * 這裡不會產生 awaiting-approval：Event 聯集裡沒有任何一種事件代表「正在等待批准」，
 * 批准走的是 canUseTool 加 IPC，跟 SDK 訊息流是兩條分開的管線。fold() 誠實地推進到
 * 它唯一能確定的下一步 running，等待批准的視覺由 Task 10 的 applyPendingApprovals 疊加。
 */
function applyToolUseSnapshot(
  records: readonly BlockRecord[],
  messageId: string,
  index: number | undefined,
  id: string,
  name: string,
  input: unknown
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing !== undefined && existing.kind === 'tool') {
      return { ...existing, id, name, input, status: 'running' }
    }
    return { kind: 'tool', id, name, input, status: 'running' }
  })
}

```

第四段：本 task 新增的六個函式。`tool-result`／`tool-raw-output`／`permission-denied`
這三種事件只帶 `id`（或 `toolUseId`），不帶 `messageId`／`index`（契約的 `Event` 型別
就是這樣定義的，沒得選），所以不能沿用 `blockKey`／`placeBlock` 那套 `(messageId, index)`
查找，得直接在全域 `records` 裡找 `block.id` 相符的那一筆。找不到就不靜默丟棄，掛一個
看得見的 `unknown` block（跟 `applyBlockStop` 找不到對應 block 時的處置一致）。

```typescript
// ---- 工具區塊狀態機（tool-input-delta／tool-result／tool-raw-output／permission-denied）----

type ToolBlock = Extract<Block, { kind: 'tool' }>

/** tool-input-delta：累積進 inputPartial，狀態不變。 */
function applyToolInputDelta(
  records: readonly BlockRecord[],
  messageId: string,
  index: number,
  partialJson: string
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing !== undefined && existing.kind === 'tool') {
      return { ...existing, inputPartial: (existing.inputPartial ?? '') + partialJson }
    }
    // 協定應該保證 block-start 先到，這裡仍防禦性地開一個佔位承接，不吃掉事件。
    return { kind: 'tool', id: '', name: '', input: undefined, inputPartial: partialJson, status: 'streaming-input' }
  })
}

/**
 * 依 id（不是 messageId／index）找到對應的 tool block 並用 updater 更新它。
 * tool-result／tool-raw-output／permission-denied 三種事件只帶 id，契約的 Event 型別
 * 就是這樣定義的，沒得選。找不到就不靜默丟棄，用 applyUnknown 掛一個看得見的痕跡。
 */
function updateToolBlock(
  view: WorkingView,
  id: string,
  orphanNote: string,
  updater: (existing: ToolBlock) => ToolBlock
): WorkingView {
  const idx = view.records.findIndex((r) => r.block.kind === 'tool' && r.block.id === id)
  if (idx === -1) return applyUnknown(view, { note: orphanNote, id })
  const target = view.records[idx]
  const existingBlock = target?.block
  if (target === undefined || existingBlock === undefined || existingBlock.kind !== 'tool') return view
  const updatedRecord = { ...target, block: updater(existingBlock) }
  return { ...view, records: view.records.map((r, i) => (i === idx ? updatedRecord : r)) }
}

/**
 * tool-result：done／error。denied 是終態，一旦被拒絕，之後補到的 tool-result
 * （SDK 會生成一則「已封鎖」的合成結果讓對話能繼續）不得把 denied 蓋回 error。
 * 這正是 fixture 02 的真實序列（permission_denied 先到，隨後 user 訊息帶
 * isError:true 的 tool_result），不擋的話 UI 會把「使用者拒絕」顯示成「執行失敗」。
 */
function applyToolResult(view: WorkingView, id: string, content: unknown, isError: boolean): WorkingView {
  return updateToolBlock(view, id, 'tool-result 沒有對應的 tool block', (existing) =>
    existing.status === 'denied' ? existing : { ...existing, result: content, status: isError ? 'error' : 'done' }
  )
}

/**
 * tool-raw-output：填 raw，狀態不變，不受 denied／error／done 影響。裁決 4：
 * history 路徑永遠不會有這個事件，所以 history 的 tool block 的 raw 永遠停在
 * undefined，這是刻意的缺席，不是遺漏。
 */
function applyToolRawOutput(
  view: WorkingView,
  id: string,
  stdout: string,
  stderr: string,
  interrupted: boolean
): WorkingView {
  return updateToolBlock(view, id, 'tool-raw-output 沒有對應的 tool block', (existing) => ({
    ...existing,
    raw: { stdout, stderr, interrupted },
  }))
}

/**
 * permission-denied：denied，是終態（見 applyToolResult 的說明）。裁決 12：拒絕理由
 * 填 deniedReason，不塞進 result（result 的語意是工具的執行結果，被拒絕的工具根本
 * 沒有執行）。message 缺席時給一句預設文案，UI 不必另外處理「denied 但沒有理由」。
 */
function applyPermissionDenied(view: WorkingView, toolUseId: string, message: string | undefined): WorkingView {
  return updateToolBlock(view, toolUseId, 'permission-denied 沒有對應的 tool block', (existing) => ({
    ...existing,
    status: 'denied',
    deniedReason: message ?? '權限被拒絕',
  }))
}

/**
 * session-end 收尾工具區塊（裁決 15，另一半是 applySessionEnd，只碰 text／thinking）：
 * running 收尾成 done，result 維持 undefined（沒有真正的結果，不造假一個）。
 * streaming-input 一併收尾：query 已經結束，輸入快照卻還沒到，代表串流被中斷，
 * 不可能再有內容進來。denied／done／error 已經是終態，原樣不動。
 *
 * 只碰 kind === 'tool' 的 record，跟 applySessionEnd 操作不相交的 block kind，
 * 兩者在 applyEvent 的 session-end case 疊加呼叫，順序不影響結果。
 */
function applyToolsSessionEnd(records: readonly BlockRecord[]): readonly BlockRecord[] {
  return records.map((r) => {
    if (r.block.kind !== 'tool') return r
    if (r.block.status !== 'running' && r.block.status !== 'streaming-input') return r
    return { ...r, block: { ...r.block, status: 'done' as const } }
  })
}

```

第五段：user turn 與 unknown 的掛載，與 Task 4 最終版逐字相同。

```typescript
// ---- user turn：每個 user-text 都開一個新 turn，不嘗試合併 ----

/**
 * Event 沒有給 user 訊息任何跨 block 的關聯鍵（不像 assistant 有 messageId），
 * 所以無法判斷連續兩個 user-text 事件是不是同一則原始訊息拆出來的兩個 block。
 * 這裡選擇保守：每個 user-text 都開一個新 turn，寧可把同一則訊息的多個文字
 * block 拆成多個 turn，也不要誤把兩則不相干的使用者訊息合併成一個 turn。
 *
 * complete 直接是 true（裁決 5、15 的第三個來源）：使用者按下送出的那一刻，
 * 這則訊息就已經完成，不需要等任何後續事件。
 */
function applyUserText(view: WorkingView, text: string): WorkingView {
  const turnId = 'user-' + String(view.turnOrder.length)
  const block: Block = { kind: 'text', markdown: text, complete: true }
  return {
    ...view,
    turnOrder: [...view.turnOrder, { turnId, role: 'user' as const }],
    records: [...view.records, { turnId, key: null, block }],
  }
}

/**
 * 沒有任何 turn 可歸屬、又不能靜默丟棄的事件（Task 3 判定「認不出來」而產出的
 * unknown，以及缺 messageId 的完整快照）：掛到目前最後一個 turn 上；連一個 turn
 * 都還沒有就新開一個 assistant turn 來裝它，避免事件憑空消失。
 */
function applyUnknown(view: WorkingView, raw: unknown): WorkingView {
  const block: Block = { kind: 'unknown', raw }
  const last = view.turnOrder[view.turnOrder.length - 1]
  if (last === undefined) {
    const turnId = 'unknown-' + String(view.turnOrder.length)
    return {
      ...view,
      turnOrder: [...view.turnOrder, { turnId, role: 'assistant' as const }],
      records: [...view.records, { turnId, key: null, block }],
    }
  }
  return { ...view, records: [...view.records, { turnId: last.turnId, key: null, block }] }
}

```

第六段：主 reduce 與對外的 `fold`。跟 Task 4 最終版的差別是四個 case：
`tool-input-delta` 從「忽略」改成呼叫 `applyToolInputDelta`（跟其他 delta 事件一樣要先
`ensureAssistantTurn`，因為這個事件帶 `messageId`）；`tool-result`／`tool-raw-output`／
`permission-denied` 從「忽略」改成呼叫對應的新函式；`session-end` case 在
`applySessionEnd` 外面包一層 `applyToolsSessionEnd`。`ended`／`cost`／`sessionEndError`
與 `case 'reset'` 都不動。

```typescript
// ---- 主 reduce：一個 Event 對應一次狀態轉換 ----

function applyEvent(view: WorkingView, event: Event): WorkingView {
  switch (event.kind) {
    case 'session-start':
      return { ...view, sessionId: event.sessionId }
    case 'message-start':
      return { ...view, turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId) }
    case 'block-start':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStart(view.records, event.messageId, event.index, event.blockType, event.toolName, event.toolUseId),
      }
    case 'text-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyTextDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'thinking-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyThinkingDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'tool-input-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyToolInputDelta(view.records, event.messageId, event.index, event.partialJson),
      }
    case 'block-stop':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStop(view.records, event.messageId, event.index),
      }
    case 'text':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyTextSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'thinking':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyThinkingSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'tool-use':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyToolUseSnapshot(view.records, event.messageId, event.index, event.id, event.name, event.input),
          }
    // 這三種只帶 id，不帶 messageId／index，所以不呼叫 ensureAssistantTurn，
    // updateToolBlock 直接對 records 操作。
    case 'tool-result':
      return applyToolResult(view, event.id, event.content, event.isError)
    case 'tool-raw-output':
      return applyToolRawOutput(view, event.id, event.stdout, event.stderr, event.interrupted)
    case 'permission-denied':
      return applyPermissionDenied(view, event.toolUseId, event.message)
    case 'user-text':
      return applyUserText(view, event.text)
    case 'session-end': {
      // 裁決 17：error 是 session-end 的第四個效果，跟 ended／cost／block complete
      // 三件事並列，用同一次 reduce 更新算完，不另開一次遍歷。
      const error = sessionEndError(event)
      return {
        ...view,
        ended: true,
        cost: {
          ...(event.costUsd === undefined ? {} : { usd: event.costUsd }),
          ...(event.numTurns === undefined ? {} : { turns: event.numTurns }),
        },
        // applySessionEnd 只碰 text／thinking，applyToolsSessionEnd 只碰 tool，
        // 兩者操作不相交的 block kind，疊加順序不影響結果。
        records: applyToolsSessionEnd(applySessionEnd(view.records)),
        ...(error === undefined ? {} : { error }),
      }
    }
    // 裁決 22：畫面從這裡重新開始。reset 由 Task 8 的 ipc-bridge 合成，正規化層不產出它。
    // 之前累積的 turn、block、sessionId、cost、error 全部丟掉，回到初始狀態。
    case 'reset':
      return INITIAL_VIEW
    case 'unknown':
      return applyUnknown(view, event.raw)
  }
}

function buildTurns(turnOrder: readonly TurnMeta[], records: readonly BlockRecord[]): readonly Turn[] {
  return turnOrder.map((tm) => ({
    role: tm.role,
    ...(tm.messageId === undefined ? {} : { messageId: tm.messageId }),
    blocks: records.filter((r) => r.turnId === tm.turnId).map((r) => r.block),
  }))
}

/**
 * fold 核心：把整條 Event 流投影成一份 ConversationView 快照。純函式，沒有任何
 * 跨呼叫狀態：呼叫端要拿到最新畫面，就把累積到當下的完整事件陣列整包丟進來重算，
 * 不是餵單一新事件做增量更新（跟 stepLive 的游標模式是兩回事）。
 */
export function fold(events: readonly Event[]): ConversationView {
  const view = events.reduce(applyEvent, INITIAL_VIEW)
  return {
    ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
    turns: buildTurns(view.turnOrder, view.records),
    ...(view.cost === undefined ? {} : { cost: view.cost }),
    ended: view.ended,
    ...(view.error === undefined ? {} : { error: view.error }),
  }
}
```

`src/shared/fold.ts` 完整檔案實測 524 行（Task 4 最終版 410 行加上本 task 的六個函式與
`deniedReason` 欄位），仍在單檔 800 行的上限內。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/fold.test.ts`
Expected: PASS，35 個測試。

實測（`git worktree add` 出一份獨立工作樹，材料化 Task 3 的 `events.ts` 與
`tests/helpers/live-events.ts`、本文件的 `fold.ts` 與 `fold.test.ts`，用專案既有的
vitest／tsc 實際跑過，不是紙上推演）：

```
 RUN  v4.1.11

 Test Files  1 passed (1)
      Tests  35 passed (35)
   Duration  144ms
```

Run: `npm run typecheck`
Expected: 無錯誤。實測 `tsc --noEmit`（`strict`＋`noUncheckedIndexedAccess`）乾淨
通過。唯一需要注意型別窄化的地方是 `updateToolBlock` 裡 `view.records[idx]`：
`noUncheckedIndexedAccess` 下型別是 `BlockRecord | undefined`，程式碼用
`if (target === undefined || existingBlock === undefined || existingBlock.kind !== 'tool') return view`
明確處理，不是靠斷言蓋過去；理論上 `findIndex` 已經篩過 `kind === 'tool'`，這個
分支不會真的走到，但型別系統沒辦法從 `findIndex` 的 predicate 反推 `records[idx]`
的型別，寧可留一個不會觸發的安全網也不要用 `!` 斷言繞過去。

Run: `npm test`（同一個 worktree，跑既有五個測試檔＋Task 3 的 `events.test.ts`
＋本 task 的 `fold.test.ts`）：`Test Files  7 passed (7)`、`Tests  140 passed (140)`
（`spawn-args` 11、`layout` 6、`ipc` 14、`cdp` 10、`measure-memory` 18、
`events` 46、`fold` 35）。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

十三個突變：本 task 的 `fold.ts` 是完整檔案，所以 Task 4 的八條也要在這個檔案上重跑一次，
與本 task 自己的五條合併成一張表。每一條都在 worktree 裡真的改程式碼、真的跑 `vitest run`、
記下紅燈輸出，再還原、重新跑一次確認回到 35 個全綠，全部是實際跑出來的，不是預測。

沿用自 Task 4 的八條（編號沿用 Task 4，紅燈條數以本 task 的 35 條測試為準重跑）：

| # | 突變 | 實測紅的測試 |
|---|---|---|
| 1 | `placeBlock` 的 `existing` 強制設成 `undefined`（拿掉去重） | 13 條（Task 4 那六條，加上工具生命週期與 denied 對應共七條，見下方輸出） |
| 2 | `blockKey` 改成 `JSON.stringify([index])` | 「index 重置」、「完整跑完整份 fixture：狀態最終停在 done」、「裁決 4：history 沒有 tool-raw-output」共 3 條 |
| 3 | `applyTextSnapshot` 的 `complete` 寫死 `true` | 「complete 的來源」第一條與「history 路徑與 session-end 的分工」第一條，共 2 條 |
| 4 | `session-end` case 改成 `applyToolsSessionEnd(view.records)`（不呼叫 `applySessionEnd`） | 「complete 的來源」第二條與「history 路徑與 session-end 的分工」第二條，共 2 條 |
| 5 | `applyUserText` 的 `complete` 改回 `false` | 「user-text」1 條 |
| 6 | `sessionEndError` 拿掉 `if (event.isError !== true) return undefined` | 「正常 session-end 之後 view.error 是 undefined（裁決 17）」1 條 |
| 7 | `case 'reset'` 改成 `return view` | 「reset 之前的事件不出現在結果裡」1 條 |
| 8 | `case 'unknown'` 改成 `return view` | 「手工合成的 unknown 事件掛到當下最後一個 turn 上」1 條 |

本 task 自己的五條（編號沿用本 task 原本的 1 到 5，以 B 開頭區別）：

| # | 突變 | 改法 | 實測紅的測試 |
|---|---|---|---|
| B1 | denied 不再是終態 | `applyToolResult` 拿掉 `existing.status === 'denied' ? existing :` 這個守衛，改成 `tool-result` 永遠覆蓋 status | 「permission_denied 先到 → denied」（fixture 02）與「denied 是終態，session-end 不覆蓋」共 2 條 |
| B2 | `updateToolBlock` 查找不比對 id | `findIndex((r) => r.block.kind === 'tool' && r.block.id === id)` 改成 `findIndex((r) => r.block.kind === 'tool')` | 「只有後建立的 toolu_BBB 變成 denied」1 條 |
| B3 | tool-use 快照不推進狀態 | `applyToolUseSnapshot` 的兩個分支都拿掉 `status: 'running'`，既有 block 保留原 status、新建 block 改回 `status: 'streaming-input'` | 「完整快照到達：input 有值，狀態推進到 running」等 5 條 |
| B4 | session-end 不推進 running／streaming-input → done | `applyEvent` 的 `session-end` case 拿掉 `applyToolsSessionEnd(...)` 這層包裝，只留 `applySessionEnd(view.records)` | 「session-end：running／streaming-input 的 tool block 收尾」組裡的 running／streaming-input 兩條，加上 history「裁決 13／15 的分工」那條，共 3 條 |
| B5 | denied 把訊息塞回 result、不填 deniedReason | `applyPermissionDenied` 改回 `...(message === undefined ? {} : { result: message })`，拿掉 `deniedReason: message ?? '權限被拒絕'` | 「permission_denied 先到 → denied」（fixture 02）與「只有後建立的 toolu_BBB 變成 denied」共 2 條 |

突變 4 與 B4 動的是同一行的兩半：4 拿掉裡層的 `applySessionEnd`（text／thinking 不再收尾），
B4 拿掉外層的 `applyToolsSessionEnd`（tool 不再收尾），紅的測試互不重疊，兩條都要跑。

**突變 1 的實測輸出**（去重拿掉之後波及最廣的一條）：

```
 Tests  13 failed | 22 passed (35)
```

紅的是：去重 1 條、index 重置 1 條、complete 來源 2 條、Bash 生命週期 5 條、
`session-end` 收尾 2 條、denied 精準對應 1 條、「fixture 03 全程沒有 unknown block」1 條。
最後那條是因為 `applyBlockStop` 查不到既有 block 時會生一個 unknown block，四個
`block-stop` 就是四個。還原後重跑：`Tests  35 passed (35)`。

**突變 B1 的實測輸出**：

**突變 1 的實測輸出**：

```
 FAIL  tests/fold.test.ts > session-end：running／streaming-input 的 tool block 收尾（裁決 15） > denied 是終態，session-end 不覆蓋
AssertionError: expected 'error' to be 'denied' // Object.is equality
 FAIL  tests/fold.test.ts > permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉 > permission_denied 先到 → denied（deniedReason 有值，result 維持 undefined）；隨後 isError:true 的 tool-result 到達 → 仍是 denied 不是 error
AssertionError: expected 'error' to be 'denied' // Object.is equality
 Tests  2 failed | 33 passed (35)
```

兩條變紅，其餘 33 條不受影響，這正是**「看起來還會過」的那種突變**：如果只看
「tool-result(isError:true) 且從未被 denied」那條，它斷言的是一個從未被拒絕的
block，跟這個守衛完全不相干，兩種實作結果一樣，看不出 denied 的優先權被拿掉了。
沒有這兩條專門對「denied 之後又收到 tool-result」序列斷言的測試，這個 bug 會直接
漏進 Task 9：使用者明明點了拒絕，畫面卻顯示成「執行失敗」。還原後重跑：
`Tests  35 passed (35)`。

**突變 B2 的實測輸出**：

```
 FAIL  tests/fold.test.ts > permission-denied 精準對應到正確 block（合成資料）
 > 只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響
AssertionError: expected 'running' to be 'denied' // Object.is equality
 Tests  1 failed | 34 passed (35)
```

這條也在草稿階段被驗算修過一次，記在這裡因為過程本身就是「不要假設」的示範：
第一版把被拒絕的目標放在 `twoToolEvents` 裡**第一個**建立的工具（`toolu_AAA`）
上。`Array.prototype.findIndex` 找到的第一個符合 `kind === 'tool'` 的 record
剛好就是它，所以那一版即使把 `&& r.block.id === id` 整段拿掉，`toolu_AAA` 依然
會被找到、依然變成 `denied`，測試全綠，**跟 Task 4 自己踩過的坑同一個模式**：斷言
和名字都對，但資料剛好讓查找邏輯的漏洞沒有機會顯現。改成把 denied 目標放在
`twoToolEvents` 陣列裡**第二個**建立的工具（`toolu_BBB`）之後，`findIndex`
不比對 id 時只會抓到第一個（`toolu_AAA`），跟預期的 `toolu_BBB` 對不上，才會真的
變紅（如上面的實測輸出）。還原後重跑：`Tests  35 passed (35)`。

**突變 B3 的實測輸出**：

```
 FAIL  tests/fold.test.ts > Bash 工具生命週期（真實 fixture 03，line 20-30） > 完整快照到達：input 有值，狀態推進到 running
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > Bash 工具生命週期（真實 fixture 03，line 20-30） > block-stop（第 26 行）不改動 tool block（tool 沒有 complete 欄位）
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉 > 沒有前置 block-start（fixture 02 全程沒有 stream_event）時，tool-use 快照本身直接新建 running
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > permission-denied 精準對應到正確 block（合成資料） > 只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > history 路徑（fixture 04）：tool block 的 status 與 raw > 裁決 13／15 的分工：拿掉 tool_result（第 4 行）後 fold(history) 停在 running；載入端補一筆 session-end 才變成 done
AssertionError: expected 'streaming-input' to be 'running'
 Tests  5 failed | 30 passed (35)
```

五條變紅，全部是直接依賴「快照到達會推進到 running」這件事的測試，包含連鎖影響
到「denied 對應」測試裡對照組 `toolu_AAA` 的斷言（它預期維持 `running`，這個突變
下它從未離開過 `streaming-input`），以及 history 裁決 13／15 的分工測試（它的第一段
斷言就是 `running`，快照都推不進 `running`，自然連帶變紅）。這是本 task 五個突變裡
**最直接、最不需要巧思就能抓到**的一個，用來對照 B1／B2／B5 那種需要專門測試才抓得到
的類型。還原後重跑：`Tests  35 passed (35)`，並重新跑過 `tsc --noEmit` 確認無殘留的
型別錯誤。

**突變 B4 的實測輸出**：

```
 FAIL  tests/fold.test.ts > session-end：running／streaming-input 的 tool block 收尾（裁決 15） > running 的 tool block 在 session-end 之後變成 done，result 維持 undefined
AssertionError: expected 'running' to be 'done' // Object.is equality
 FAIL  tests/fold.test.ts > session-end：running／streaming-input 的 tool block 收尾（裁決 15） > streaming-input 的 tool block 在 session-end 之後也變成 done（快照沒到就代表串流被中斷）
AssertionError: expected 'streaming-input' to be 'done' // Object.is equality
 FAIL  tests/fold.test.ts > history 路徑（fixture 04）：tool block 的 status 與 raw > 裁決 13／15 的分工：拿掉 tool_result（第 4 行）後 fold(history) 停在 running；載入端補一筆 session-end 才變成 done
AssertionError: expected 'running' to be 'done' // Object.is equality
 Tests  3 failed | 32 passed (35)
```

三條變紅：兩條直接測 session-end 收尾，一條是 history 路徑靠 session-end 收尾才
變 done 的分工測試（裁決 13／15）。這條突變抓的正是「拿掉這個 task 對裁決 15
的一半實作」這件事，若沒有這三條，本 task 加的 `applyToolsSessionEnd` 形同沒測到。
還原後重跑：`Tests  35 passed (35)`。

**突變 B5 的實測輸出**：

```
 FAIL  tests/fold.test.ts > permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉 > permission_denied 先到 → denied（deniedReason 有值，result 維持 undefined）；隨後 isError:true 的 tool-result 到達 → 仍是 denied 不是 error
AssertionError: expected undefined to deeply equal StringContaining "was blocked"
 FAIL  tests/fold.test.ts > permission-denied 精準對應到正確 block（合成資料） > 只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響
AssertionError: expected undefined to be '危險指令被擋下' // Object.is equality
 Tests  2 failed | 33 passed (35)
```

兩條變紅：`deniedReason` 讀到 `undefined`。這條突變抓的是裁決 12 的核心，若沒有
這兩條專門斷言 `deniedReason` 有值且 `result` 是 `undefined` 的測試，退回舊行為
（塞進 result）一樣能讓其他 33 條測試全綠，因為其他測試都不檢查 `deniedReason`。
還原後重跑：`Tests  35 passed (35)`。

十三條突變全部跑過，每條都至少讓一條測試變紅，沒有無效或重複的條目：Task 4 的八條
在本 task 的 35 條測試上仍然各自命中，本 task 的五條命中工具狀態推進的五個面向。

- [ ] **Step 6: 執行完整測試套件**

Run: `npm test`
Expected: PASS。本 task 沒有新增檔案，`tests/fold.test.ts` 的測試數從 Task 4 的 19
變成本 task 的 35。專案總數 = Task 4 完成時的總數 − 19 ＋ 35。本 task 給的
`fold.test.ts` 已經含 Task 4 全部保留下來的 17 條，不需要再手動合併任何東西。
把執行當下的實際數字記進報告，不要照抄本文件的數字，它是撰寫當下的快照。
2026-09-02 的驗證 worktree 是從 `feat/a-sdk-host` 的 HEAD 開的（Task 0、1、2 都還沒
套用，既有測試是 5 個檔 59 條），加上 Task 3 的 46 條與本 task 的 35 條，實測
`Test Files 7 passed`、`Tests 140 passed`。

執行本 task 前提：Task 4 的 `fold.ts`／`fold.test.ts` 必須已經套用到專案（本 task 的兩個
完整檔案是在它之上做的，Step 2 的失敗計數也是在它上面量的）。Task 3 的 `events.ts` 與
`tests/helpers/live-events.ts` 同樣必須先於 Task 4 存在。Task 5／6／7 不是 `fold.ts`
的依賴，順序上不影響本 task。

- [ ] **Step 7: 提交**

```bash
git add src/shared/fold.ts tests/fold.test.ts
git commit -m "feat: fold 的工具區塊狀態機，六個狀態的推進規則、denied 終態與 deniedReason、session-end 收尾（保留裁決 17 的 error 與裁決 22 的 reset）"
```

## 契約疑慮（不擅自更動，記錄理由）

本節原本記錄三項疑慮，控制端已在 2026-09-02 分別以裁決 11／28、12、13／15 定案。
記錄留著，改成陳述已定案的結論，供之後讀這份文件的人知道問題怎麼收的。

1. **`approvalAsk` 帶 `toolUseId`（裁決 28 定案，取代裁決 11）。** CONTRACT.md 的 IPC 一節
   原本只寫 `{ requestId, toolName, input }`，本 task 原本的疑慮是：要把「等待批准」
   精準疊到正確的 Block 上，需要一個能對回 `id` 的鍵，同一個工具短時間內發出兩次幾乎
   一樣的呼叫時對不準。裁決 11 先以「`toolName` 加 `input` 深度相等比對」回應；
   2026-09-02 重查 `sdk.d.ts`（0.3.258 第 248 行）發現 `CanUseTool` 的 options 有必填的
   `toolUseID`，裁決 28 改成 payload 直接帶 `toolUseId`，Task 10 的
   `applyPendingApprovals`（純函式）以 `block.id === ask.toolUseId` 疊加
   `status: 'awaiting-approval'`，`fold()` 本身不動，內容比對與它的特殊情況全部消失。
   `approvalAsk` payload 另外有 `title`／`displayName` 兩個 SDK 欄位供 UI 顯示提示句用
   （裁決 11 留下的部分）；本 task 不讀這些欄位。

2. **`result` 欄位一物二用（裁決 12 定案）。** 本 task 原本借用 `Block.tool.result`
   承接拒絕原因，控制端裁決：新增獨立的 `deniedReason?: string` 欄位，`result`
   的語意收回單純的「工具執行結果」。本文件的實作與測試已經照裁決 12 更新：
   `applyPermissionDenied` 填 `deniedReason`，不再動 `result`；denied 狀態下
   `result` 維持 `undefined`。

3. **歷史工具呼叫若沒有對應的 `tool_result`（裁決 13、15 定案）。** 本 task 原本
   的疑慮是：這類 tool block 的 `status` 會永遠停在 `running`。控制端裁決 15
   統一了收尾機制：`fold()` 收到 `session-end` 時，所有 `running`／
   `streaming-input` 的 tool block 一律收尾成 `done`，`result` 維持 `undefined`；
   歷史路徑由 Task 11 的 `session-store.ts` 在 `normalizeHistory` 產出的事件
   尾端補一筆 `{ kind: 'session-end', isError: false }`，走同一條規則，不需要
   `fold()` 知道事件來自哪條路徑。本文件的 Step 1「裁決 13／15 的責任分工」測試
   與 Step 5 突變 4 已經驗證這條規則。

4. **CONTRACT.md 的 `Block` 型別片段沒有同步裁決 12（已解決）。** 本 task 上一版
   回報的不一致：契約「## ConversationView」段落照抄的 `Block` 型別片段少了
   `deniedReason`。2026-09-02 覆查，契約那段已經補上
   `deniedReason?: string // 裁決 12：status 為 denied 時的拒絕理由，result 維持 undefined`，
   兩處一致，這一項結案。

---

### Task 5: session 狀態機

規格 §7 的三個狀態與轉移，寫成純函式。副作用由呼叫端執行，狀態機只**描述**該做什麼。

這個設計的理由：切換 session 的收尾有三個步驟且順序固定（規格 §3.2），如果狀態機直接執行副作用，那個順序就只能靠整合測試驗證，而整合測試在 Electron 裡跑不動。把 effects 做成資料之後，順序變成可以用單元測試斷言的東西。

**Files:**
- Create: `src/shared/session-state.ts`（只有 `SessionState` 型別，裁決 14：renderer 與 main 都要用，放 shared）
- Create: `src/main/session-machine.ts`
- Create: `tests/session-machine.test.ts`
- Modify: `vitest.config.ts`（`coverage.include` 加一行 `'src/main/session-machine.ts'`）

**Interfaces:**
- Consumes: `ApprovalRegistry.denyAll(reason)` 的存在（Task 6），但只在 effect 裡描述，不直接呼叫
- Produces:
  - `type SessionState = { kind: 'idle' } | { kind: 'live'; sessionId?: string } | { kind: 'viewing'; sessionId: string }`
  - `type Action = { kind: 'start-new' } | { kind: 'open-history'; sessionId: string } | { kind: 'user-input'; text: string } | { kind: 'session-ended' } | { kind: 'window-closed' }`
  - `type Effect = { kind: 'deny-all-approvals'; reason: string } | { kind: 'interrupt-query' } | { kind: 'teardown-query' } | { kind: 'start-query'; resumeSessionId?: string; initialInput?: string } | { kind: 'load-history'; sessionId: string }`
  - `function transition(state: SessionState, action: Action): { readonly state: SessionState; readonly effects: readonly Effect[] }`

下游用法（裁決 6、14）：Task 8 的 `ipc-bridge.ts` 持有 `SessionState`，收到 renderer 的意圖（`intentStartNew`／`intentOpenHistory`／`userInput`）時呼叫 `transition`，然後**照 effects 陣列的順序**逐一執行，再把新狀態從 `session:state` 推回 renderer。`deny-all-approvals` 對應 `registry.denyAll(reason)`，`start-query` 對應 agent-host，`load-history` 對應 Task 11 的 `SessionStore.loadHistory`。renderer 只讀 `SessionState`，不呼叫 `transition`。

- [ ] **Step 1: 寫失敗的測試**

`tests/session-machine.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { transition, type Effect } from '../src/main/session-machine.js'
import type { SessionState } from '../src/shared/session-state.js'

const kinds = (effects: readonly Effect[]): string[] => effects.map((e) => e.kind)

describe('transition：從 idle 出發', () => {
  const idle: SessionState = { kind: 'idle' }

  it('start-new 進入 live 並要求開一個新 query', () => {
    const r = transition(idle, { kind: 'start-new' })
    expect(r.state.kind).toBe('live')
    expect(kinds(r.effects)).toEqual(['start-query'])
    expect(r.effects[0]).toEqual({ kind: 'start-query' })
  })

  it('open-history 進入 viewing 並要求載入歷史', () => {
    const r = transition(idle, { kind: 'open-history', sessionId: 's-1' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-1' })
    expect(kinds(r.effects)).toEqual(['load-history'])
  })

  it('user-input 在 idle 是不合法轉移，狀態不變且無 effect', () => {
    const r = transition(idle, { kind: 'user-input', text: '你好' })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })

  it('session-ended 在 idle 是無害的 no-op', () => {
    const r = transition(idle, { kind: 'session-ended' })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })
})

describe('transition：從 live 出發', () => {
  const live: SessionState = { kind: 'live', sessionId: 's-live' }

  it('session-ended 回到 idle，不需要收尾（query 自己結束了）', () => {
    const r = transition(live, { kind: 'session-ended' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(kinds(r.effects)).toEqual([])
  })

  it('window-closed 走完整的三步收尾', () => {
    const r = transition(live, { kind: 'window-closed' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(kinds(r.effects)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query'])
  })

  it('open-history 先收尾再載入歷史，順序不可對調', () => {
    const r = transition(live, { kind: 'open-history', sessionId: 's-2' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-2' })
    expect(kinds(r.effects)).toEqual([
      'deny-all-approvals',
      'interrupt-query',
      'teardown-query',
      'load-history',
    ])
  })

  it('user-input 在 live 不改變狀態，也不產生 effect（輸入直接送進既有 query）', () => {
    const r = transition(live, { kind: 'user-input', text: '繼續' })
    expect(r.state).toEqual(live)
    expect(r.effects).toEqual([])
  })
})

describe('transition：從 viewing 出發', () => {
  const viewing: SessionState = { kind: 'viewing', sessionId: 's-old' }

  it('user-input 接續該 session，帶上 resume 與第一則輸入', () => {
    const r = transition(viewing, { kind: 'user-input', text: '接著問' })
    expect(r.state).toEqual({ kind: 'live', sessionId: 's-old' })
    expect(kinds(r.effects)).toEqual(['start-query'])
    expect(r.effects[0]).toEqual({
      kind: 'start-query',
      resumeSessionId: 's-old',
      initialInput: '接著問',
    })
  })

  it('切到另一條歷史對話不需要收尾（viewing 沒有活躍 query）', () => {
    const r = transition(viewing, { kind: 'open-history', sessionId: 's-new' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-new' })
    expect(kinds(r.effects)).toEqual(['load-history'])
  })

  it('start-new 從 viewing 開新對話', () => {
    const r = transition(viewing, { kind: 'start-new' })
    expect(r.state.kind).toBe('live')
    expect(kinds(r.effects)).toEqual(['start-query'])
  })

  it('window-closed 只回 idle，不需要 query 相關的收尾', () => {
    const r = transition(viewing, { kind: 'window-closed' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(r.effects).toEqual([])
  })
})

describe('收尾順序（規格 §3.2）', () => {
  it('deny-all-approvals 必須早於 interrupt-query，interrupt-query 必須早於 teardown-query', () => {
    const r = transition({ kind: 'live', sessionId: 'x' }, { kind: 'window-closed' })
    const k = kinds(r.effects)
    expect(k.indexOf('deny-all-approvals')).toBeLessThan(k.indexOf('interrupt-query'))
    expect(k.indexOf('interrupt-query')).toBeLessThan(k.indexOf('teardown-query'))
  })

  it('deny-all-approvals 帶著可讀的理由，會顯示在對話裡', () => {
    const a = transition({ kind: 'live' }, { kind: 'window-closed' }).effects[0]
    const b = transition({ kind: 'live' }, { kind: 'open-history', sessionId: 's' }).effects[0]
    expect(a).toEqual({ kind: 'deny-all-approvals', reason: '視窗已關閉' })
    expect(b).toEqual({ kind: 'deny-all-approvals', reason: '切換 session' })
  })
})

describe('不可變性', () => {
  it('不修改傳入的 state', () => {
    const state: SessionState = { kind: 'live', sessionId: 's-1' }
    const snapshot = JSON.stringify(state)
    transition(state, { kind: 'window-closed' })
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('回傳的 state 是新物件，不是傳入的那一個', () => {
    const state: SessionState = { kind: 'live', sessionId: 's-1' }
    const r = transition(state, { kind: 'user-input', text: 'x' })
    // user-input 在 live 不改狀態，但仍須回傳新物件而非同一個參考
    expect(r.state).not.toBe(state)
    expect(r.state).toEqual(state)
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/session-machine.test.ts`
Expected: FAIL，無法解析 `../src/main/session-machine.js`

- [ ] **Step 3: 寫最小實作**

`src/shared/session-state.ts`（裁決 14。純型別檔，renderer 的 Recents 與 main 的狀態機共用；shared 不得 import main）：

```typescript
/** session 生命週期的三個狀態（規格 §7）。物件而非字串：viewing 要帶正在看哪一場。 */
export type SessionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'live'; readonly sessionId?: string }
  | { readonly kind: 'viewing'; readonly sessionId: string }
```

`src/main/session-machine.ts`：

```typescript
/**
 * session 的狀態機。純函式，不執行副作用。
 *
 * effects 是「該做什麼」的描述，由呼叫端照陣列順序執行。這樣設計是因為
 * 規格 §3.2 規定切換 session 的收尾有三步且順序固定，而順序如果藏在
 * 命令式的程式碼裡，就只能靠跑得起 Electron 的整合測試來驗證。
 */

import type { SessionState } from '../shared/session-state.js'
export type { SessionState }

export type Action =
  | { readonly kind: 'start-new' }
  | { readonly kind: 'open-history'; readonly sessionId: string }
  | { readonly kind: 'user-input'; readonly text: string }
  | { readonly kind: 'session-ended' }
  | { readonly kind: 'window-closed' }

export type Effect =
  | { readonly kind: 'deny-all-approvals'; readonly reason: string }
  | { readonly kind: 'interrupt-query' }
  | { readonly kind: 'teardown-query' }
  | { readonly kind: 'start-query'; readonly resumeSessionId?: string; readonly initialInput?: string }
  | { readonly kind: 'load-history'; readonly sessionId: string }

export interface TransitionResult {
  readonly state: SessionState
  readonly effects: readonly Effect[]
}

/**
 * 收掉一個活躍 query 的三步驟，順序固定（規格 §3.2）。
 *
 * 先 deny 待決的批准：那些 promise 掛在 SDK 的 canUseTool 上，不結束就會讓
 * interrupt 卡住。再 interrupt 中止進行中的工具。最後才收掉 query。
 */
function teardownLive(reason: string): readonly Effect[] {
  return [
    { kind: 'deny-all-approvals', reason },
    { kind: 'interrupt-query' },
    { kind: 'teardown-query' },
  ]
}

export function transition(state: SessionState, action: Action): TransitionResult {
  switch (state.kind) {
    case 'idle':
      switch (action.kind) {
        case 'start-new':
          return { state: { kind: 'live' }, effects: [{ kind: 'start-query' }] }
        case 'open-history':
          return {
            state: { kind: 'viewing', sessionId: action.sessionId },
            effects: [{ kind: 'load-history', sessionId: action.sessionId }],
          }
        default:
          // user-input 與 session-ended 在 idle 沒有意義。不拋錯，回原狀態的複本。
          return { state: { kind: 'idle' }, effects: [] }
      }

    case 'live':
      switch (action.kind) {
        case 'session-ended':
          // query 自己結束了，不需要收尾
          return { state: { kind: 'idle' }, effects: [] }
        case 'window-closed':
          return { state: { kind: 'idle' }, effects: teardownLive('視窗已關閉') }
        case 'open-history':
          return {
            state: { kind: 'viewing', sessionId: action.sessionId },
            effects: [
              ...teardownLive('切換 session'),
              { kind: 'load-history', sessionId: action.sessionId },
            ],
          }
        case 'start-new':
          return {
            state: { kind: 'live' },
            effects: [...teardownLive('切換 session'), { kind: 'start-query' }],
          }
        case 'user-input':
          // 已經有活躍 query，輸入直接送進去，不經狀態機
          return { state: { ...state }, effects: [] }
      }

    case 'viewing':
      switch (action.kind) {
        case 'user-input':
          return {
            state: { kind: 'live', sessionId: state.sessionId },
            effects: [
              { kind: 'start-query', resumeSessionId: state.sessionId, initialInput: action.text },
            ],
          }
        case 'open-history':
          return {
            state: { kind: 'viewing', sessionId: action.sessionId },
            effects: [{ kind: 'load-history', sessionId: action.sessionId }],
          }
        case 'start-new':
          return { state: { kind: 'live' }, effects: [{ kind: 'start-query' }] }
        case 'window-closed':
        case 'session-ended':
          // viewing 沒有活躍 query，不需要收尾
          return { state: { kind: 'idle' }, effects: [] }
      }
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/session-machine.test.ts`
Expected: PASS，17 個測試

Run: `npm run typecheck`
Expected: 乾淨。`switch` 的窮舉性由 TypeScript 檢查，漏掉任何一個 action 會編譯失敗。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

三個突變各跑一次，每個都必須讓測試變紅：

| # | 突變 | 預期紅的測試 |
|---|---|---|
| 1 | `teardownLive` 的三個 effect 順序對調成 `[teardown-query, interrupt-query, deny-all-approvals]` | 「收尾順序」的兩條，以及 live 的 `window-closed` 與 `open-history` |
| 2 | `idle` 的 `default` 分支改成回 `{ state, effects: [{ kind: 'start-query' }] }`（把不合法轉移當成合法） | 「user-input 在 idle 是不合法轉移」 |
| 3 | `viewing` 的 `user-input` 拿掉 `resumeSessionId`（只傳 `initialInput`） | 「user-input 接續該 session，帶上 resume 與第一則輸入」 |

**突變 1 最重要**：它是這個 task 存在的理由。如果順序錯了而測試不紅，那把 effects 做成資料就沒有意義了，不如直接寫命令式程式碼。

**突變 3 是「看起來還會過」的那種**：狀態轉移完全正確、`start-query` 也發出去了，只是少了一個欄位。後果是使用者以為在接續舊對話，實際上開了一條新的，而 Insights 的歸屬也會跟著錯。

三次的紅燈輸出與還原後的綠燈都貼進報告。

- [ ] **Step 6: 加 coverage 條目，執行完整測試套件**

`vitest.config.ts` 的 `coverage.include` 加一行，其餘既有條目不動（裁決 19：每個 task 只增刪
自己的檔案，不重寫整份清單）。`src/shared/session-state.ts` 只有型別，被 Task 1 的
`'src/shared/**/*.ts'` 涵蓋但沒有可執行的行，不需另列。

```diff
   coverage: {
     include: [
       // ...既有條目不動...
+      'src/main/session-machine.ts',
     ],
   },
```

Run: `npm test`
Expected: PASS。把總數記進報告。

- [ ] **Step 7: 提交**

```bash
git add src/shared/session-state.ts src/main/session-machine.ts tests/session-machine.test.ts vitest.config.ts
git commit -m "feat: session 狀態機，收尾順序以 effects 陣列表達並可測"
```

---

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

---

### Task 7: session-store（Recents 資料層）

Recents 這件事分成兩半：資料從哪來、畫面怎麼畫。本 task 只做前一半，也就是 main 側把 SDK 的 session API 包成本專案窄型別的 `src/main/session-store.ts`。後一半（`Recents.tsx`／`useSessions.ts`／`relative-time.ts`）是 Task 11。拆開的理由是排程：Task 8 的 `ipc-bridge.ts` 以 `SessionSource` 之名注入 `SessionStore`，所以資料層必須排在 Task 8 之前，而 renderer 那一半要等 Task 9B 的 App 版面，只能排最後。

三個設計判斷值得先講清楚。

**第一，`listSessions()` 不帶 `dir`。** 規格 §3.1 寫明「main 呼叫 `listSessions()`（不帶 `dir`，跨全部專案）」，§3.2 又補了理由：`YESCHEF_PROJECT_DIR` 只決定新對話開在哪，點別的專案的歷史對話是用它原本的 cwd `resume`。實查 SDK 型別（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts@0.3.258`，第 992 行的 `listSessions` 與第 997 行起的 `ListSessionsOptions`）確認 `dir` 是選填（第 1002 行），省略時「returns sessions across all projects」。所以照規格不傳。代價是實測數字：這台機器 `~/.claude/projects` 底下有 940 場 session，不帶 `dir` 也不帶 `limit` 的一次呼叫要 536 到 736 毫秒，序列化成 JSON 是 426 KB；帶 `limit: 100` 是 84 毫秒、39 KB。所以 `list()` 一律帶 `limit`（預設 100）。同一次實測也確認了 SDK 自己已經照 `lastModified` 由新到舊排序，且 `limit` 取的是最新的 N 筆，不是任意 N 筆，`limit` 因此不會漏掉最近的對話。`ListSessionsOptions.includeProgrammatic` 預設是 `true`（第 1028 行的註解），這一點很重要而且不能改：yeschef 自己開的對話正是 SDK session（entrypoint `sdk-ts`），傳 `false` 會讓使用者剛講完的那一場從 Recents 消失。

本檔引用的 `sdk.d.ts` 行號一律以 **0.3.258** 為準（裁決 24 釘的版本）：`listSessions` 992、`getSessionMessages` 797、`CanUseTool` 209、`ListSessionsOptions` 997、`includeProgrammatic` 1028。

**第二，SDK 呼叫失敗一律拋出，不回 `{ ok: false }`。** Task 8 Step 5 `ipc-bridge.ts` 的 `onSessionList` handler已經是「catch、`logError`、往上拋」的形狀，註解也寫明「回空陣列會被當成這台機器沒有歷史對話，那是靜默失敗」。`invoke` 的 reject 會走到 preload 再走到 Task 11 的 `useSessions` 的 `.catch`，錯誤訊息直接顯示在側邊欄。改成 Result 型別等於在同一條路徑上並存兩套錯誤語彙，而 Task 8 那一段還是得再包一次。所以這裡拋出 `Error`，並用 `cause` 掛住原始例外供主程序記錄。

**第三，歷史對話的事件流尾端補一筆 `session-end`（裁決 15）。** `loadHistory` 的產出是 `normalizeHistory` 逐則展開的結果加上 `{ kind: 'session-end', isError: false }`。這一筆不是造假：歷史訊息已經持久化，那場對話確實結束了。沒有它，`fold()` 跑完 fixture 04 之後每一個 text 與 thinking block 都是 `complete: false`，UI 會在一段早就結束的對話尾端畫游標（已用突變實測，見 Step 5 的突變 1）。同一段裡另一個必須知道的事實是裁決 4：`getSessionMessages()` 的產物不含 `tool_use_result`，所以 `loadHistory` 產出的事件裡永遠不會有 `tool-raw-output`。Task 9B 的 ToolCall 依 `historical` 顯示「這是歷史對話，沒有保存原始輸出」，來源就是這裡的缺席，本 task 有一條測試把這個缺席釘住。

實機驗證：本檔所有「已驗證」「實測」都指在 worktree（`git worktree add`，`npm install` 之後再 `npm install @anthropic-ai/claude-agent-sdk@0.3.258`）裡真的跑過 `npx tsc --noEmit -p .` 與 `npx vitest run`。最近一輪（2026-09-02 裁決 24 之後）材料化的上游是 Task 3 的 `events.ts`、Task 4／4B 的 `fold.ts`、Task 5 的狀態機、Task 6 的 `approval.ts` 與 Task 8 的 `ipc.ts`／`agent-host.ts`／`ipc-bridge.ts`，`tsc --noEmit -p .` 0 error，`tests/session-store.test.ts` 是 `Tests 19 passed (19)`，全 worktree 8 個測試檔 164 個測試全綠。四個突變逐一改壞、跑紅、還原、回綠，輸出見 Step 5。

**Files:**
- Create: `src/main/session-store.ts`
- Create: `tests/session-store.test.ts`
- Modify: `src/shared/ipc.ts`（只加 `SessionSummary` 這一個介面，見下面 Interfaces 的說明）
- Modify: `vitest.config.ts`（coverage 的 `include` 加 `src/main/session-store.ts`）
- Modify: `package.json`／`package-lock.json`（Step 0：加裝 `@anthropic-ai/claude-agent-sdk@0.3.258`，裁決 24）

`vitest.config.ts` 的 `test.include` 不動：那一行（改成 `'tests/**/*.test.{ts,tsx}'`）由 Task 9 做一次，本 task 的測試檔是 `.ts`，現行設定收得到。

**Interfaces:**
- Consumes:
  - `function normalizeHistory(msg: unknown): readonly Event[]`、`type Event`（Task 3，`src/shared/events.ts`）
  - `function fold(events: readonly Event[]): ConversationView`（Task 4／4B，`src/shared/fold.ts`）：只有 `tests/session-store.test.ts` 用它做端到端斷言，產品程式碼不依賴。這條測試要求 `fold()` 已依裁決 15 實作（`session-end` 到達時 text／thinking block 設 `complete: true`、`running`／`streaming-input` 的 tool block 設 `status: 'done'`）。Task 4 的 `applySessionEnd` 負責前半、Task 4B 的 `applyToolsSessionEnd` 負責後半，兩者在 `applyEvent` 的 `session-end` case 疊加呼叫。**Task 4B 已依裁決 15 實作**，本 task 直接依賴，不需要在這裡補。
- Produces:
  - `src/shared/ipc.ts`
    - `interface SessionSummary`（裁決 7 的六個欄位）
  - `src/main/session-store.ts`
    - `interface SdkSessionInfo`（`SDKSessionInfo` 用得到的七個欄位的窄複本）
    - `type ListSessionsFn = (options?: { limit?: number }) => Promise<readonly SdkSessionInfo[]>`
    - `type GetSessionMessagesFn = (sessionId: string) => Promise<readonly unknown[]>`
    - `interface SessionStore { list(): Promise<readonly SessionSummary[]>; loadHistory(sessionId: string): Promise<readonly Event[]>; cwdOf(sessionId: string): string | undefined }`
      （`cwdOf` 是裁決 20 加的：回傳最近一次 `list()` 結果裡該筆的 `cwd`，沒列過或該筆沒有 `cwd` 回 `undefined`）
    - `interface SessionStoreDeps { readonly listSessions: ListSessionsFn; readonly getSessionMessages: GetSessionMessagesFn; readonly limit?: number }`
    - `function createSessionStore(deps: SessionStoreDeps): SessionStore`
    - `const DEFAULT_SESSION_LIST_LIMIT = 100`

**`SessionSummary` 由本 task 加進 `src/shared/ipc.ts`，Task 8 改寫該檔時原樣保留。** 契約把 `SessionSummary` 記在 Task 8 的產出裡，但 Task 7 排在 Task 8 之前，`session-store.ts` 的 `list()` 回傳型別就是它，沒有它這個 task 編不過。解法是本 task 自己在 `src/shared/ipc.ts` 加上這個介面（原文照抄裁決 7，一個字不改），Task 8 的 Step 3 整支改寫 `ipc.ts` 時把這段留著。兩邊的字面完全相同，所以不論誰先做，結果的檔案內容一致：

```typescript
export interface SessionSummary {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly gitBranch?: string
}
```

下游用法：Task 8 的 `ipc-bridge.ts` 以 `SessionSource` 之名注入本 task 的 `SessionStore`，`session:list` handler 呼叫 `list()`，Task 5 的 `load-history` effect 呼叫 `loadHistory(sessionId)` 然後把回傳的 `Event[]` 從 `agent:events` 推出去。另外 Task 8 的 `index.ts` 用 `createSessionOptionsFactory(projectDir, sessions)` 接 `cwdOf`：resume 一場歷史對話時，`cwd` 用該場對話自己的目錄，`cwdOf` 回 `undefined` 才退回 `YESCHEF_PROJECT_DIR`（裁決 20）。組裝點（`src/main/index.ts`）這樣接：

```typescript
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { createSessionStore } from './session-store.js'

const sessions = createSessionStore({ listSessions, getSessionMessages })
```

這是唯一一處把 `SessionStore` 接上真正的 SDK。SDK 改形狀時這兩行會過不了 `tsc`，其餘程式碼都只看得到 `SdkSessionInfo` 這個窄型別。**這段接線本身由 Task 8 做**（`src/main/index.ts` 是 Task 8 的檔案），本 task 只負責讓它接得上，不改 `index.ts`。

- [ ] **Step 0: 安裝 SDK**

裁決 24：`@anthropic-ai/claude-agent-sdk` 由本 task 加裝，版本釘 0.3.258。本 task 的組裝點
（`src/main/index.ts`，Task 8 做）與 Step 6 的手動檢查都 import 它，所以安裝要排在寫實作之前。

```bash
npm install @anthropic-ai/claude-agent-sdk@0.3.258
```

Expected: `package.json` 的 `dependencies` 出現這一項，此時它是唯一一項：

```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "^0.3.258"
}
```

- [ ] **Step 1: 寫失敗的測試**

`tests/session-store.test.ts`。`getSessionMessages` 的假回傳直接用錄下來的真實產物 `tests/fixtures/events/04-session-history.jsonl`（6 則，型別只有 `user` 與 `assistant`，含一顆 Bash 工具呼叫與它的 `tool_result`）。`listSessions` 的假回傳則是手寫的，因為要測的是空字串、空白字串這些真實資料裡剛好沒有的情況（實測 940 筆裡 `summary` 空的有 0 筆，但 SDK 型別註解說它是「custom title, auto-generated summary, or first prompt」三選一，三個都沒有時會是空字串，所以退回鏈仍然必要）。

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSessionStore, type SdkSessionInfo } from '../src/main/session-store.js'
import { fold } from '../src/shared/fold.js'
import type { Event } from '../src/shared/events.js'

const HISTORY: readonly unknown[] = readFileSync(
  'tests/fixtures/events/04-session-history.jsonl',
  'utf8'
)
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as unknown)

const info = (over: Partial<SdkSessionInfo> & { sessionId: string }): SdkSessionInfo => ({
  summary: '摘要',
  lastModified: 1,
  ...over,
})

function storeOf(infos: readonly SdkSessionInfo[], messages: readonly unknown[] = HISTORY) {
  const calls: { limit?: number }[] = []
  const store = createSessionStore({
    listSessions: async (options) => {
      calls.push({ ...(options?.limit === undefined ? {} : { limit: options.limit }) })
      return infos
    },
    getSessionMessages: async () => messages,
  })
  return { store, calls }
}

describe('SessionStore.list：SDK 型別轉成 SessionSummary（裁決 7）', () => {
  it('只留下契約的六個欄位，SDK 專屬欄位不外洩', async () => {
    const { store } = storeOf([
      info({
        sessionId: 'a-1',
        summary: '摘要',
        lastModified: 1000,
        cwd: '/p',
        customTitle: '自訂',
        gitBranch: 'main',
        firstPrompt: '不該出現',
      }),
    ])
    const [first] = await store.list()
    expect(first).toEqual({
      sessionId: 'a-1',
      summary: '摘要',
      lastModified: 1000,
      cwd: '/p',
      customTitle: '自訂',
      gitBranch: 'main',
    })
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'customTitle',
      'cwd',
      'gitBranch',
      'lastModified',
      'sessionId',
      'summary',
    ])
  })

  it('沒有的選填欄位不會變成 undefined 屬性', async () => {
    const { store } = storeOf([info({ sessionId: 'a-2' })])
    const [first] = await store.list()
    expect(Object.keys(first ?? {}).sort()).toEqual(['lastModified', 'sessionId', 'summary'])
  })
})

describe('SessionStore.list：標題退回鏈', () => {
  it('summary 是空字串時退回 firstPrompt 的前 80 字', async () => {
    const long = 'x'.repeat(200)
    const { store } = storeOf([info({ sessionId: 'b-1', summary: '', firstPrompt: long })])
    const [first] = await store.list()
    expect(first?.summary).toHaveLength(80)
    expect(first?.summary).toBe('x'.repeat(80))
  })

  it('summary 只有空白也算空', async () => {
    const { store } = storeOf([info({ sessionId: 'b-2', summary: '   ', firstPrompt: '第一句' })])
    const [first] = await store.list()
    expect(first?.summary).toBe('第一句')
  })

  it('summary 與 firstPrompt 都空時退回 sessionId 前 8 碼', async () => {
    const { store } = storeOf([
      info({ sessionId: '0123456789abcdef', summary: '', firstPrompt: '' }),
    ])
    const [first] = await store.list()
    expect(first?.summary).toBe('01234567')
  })

  it('summary 有內容時不動它，也不被 firstPrompt 蓋掉', async () => {
    const { store } = storeOf([info({ sessionId: 'b-4', summary: '真摘要', firstPrompt: '第一句' })])
    const [first] = await store.list()
    expect(first?.summary).toBe('真摘要')
  })
})

describe('SessionStore.list：排序與不可變性', () => {
  // 輸入刻意亂序，且四筆的正確順序跟輸入順序沒有任何一位重合，
  // 拿掉排序時整條斷言都會不同，不會因為第一筆剛好對而漏抓。
  const shuffled: readonly SdkSessionInfo[] = [
    info({ sessionId: 'c-mid', lastModified: 200 }),
    info({ sessionId: 'c-old', lastModified: 100 }),
    info({ sessionId: 'c-new', lastModified: 400 }),
    info({ sessionId: 'c-late', lastModified: 300 }),
  ]

  it('依 lastModified 新到舊排序', async () => {
    const { store } = storeOf(shuffled)
    const list = await store.list()
    expect(list.map((s) => s.sessionId)).toEqual(['c-new', 'c-late', 'c-mid', 'c-old'])
  })

  it('不修改 SDK 回傳的陣列', async () => {
    const input = [...shuffled]
    const store = createSessionStore({
      listSessions: async () => input,
      getSessionMessages: async () => HISTORY,
    })
    await store.list()
    expect(input.map((s) => s.sessionId)).toEqual(['c-mid', 'c-old', 'c-new', 'c-late'])
  })

  it('帶 limit 呼叫 SDK，不無上限抓全機器的 session', async () => {
    const { store, calls } = storeOf(shuffled)
    await store.list()
    expect(calls).toEqual([{ limit: 100 }])
  })
})

describe('SessionStore.cwdOf：跨專案 resume 的 cwd（裁決 20）', () => {
  // 兩筆的 cwd 刻意不同，且問的是第二筆：退化成「永遠回第一筆的 cwd」的實作
  // 會在這裡變紅，不會因為只有一筆而巧合通過。
  const twoProjects: readonly SdkSessionInfo[] = [
    info({ sessionId: 'd-1', cwd: '/Users/x/Projects/alpha' }),
    info({ sessionId: 'd-2', cwd: '/Users/x/Projects/beta' }),
  ]

  it('list() 之後回得出該筆自己的 cwd', async () => {
    const { store } = storeOf(twoProjects)
    await store.list()
    expect(store.cwdOf('d-2')).toBe('/Users/x/Projects/beta')
    expect(store.cwdOf('d-1')).toBe('/Users/x/Projects/alpha')
  })

  it('該筆沒有 cwd 時回 undefined，不是空字串', async () => {
    const { store } = storeOf([info({ sessionId: 'd-3' })])
    await store.list()
    expect(store.cwdOf('d-3')).toBeUndefined()
  })

  it('還沒 list() 過就問，回 undefined', () => {
    const { store } = storeOf(twoProjects)
    expect(store.cwdOf('d-1')).toBeUndefined()
  })
})

describe('SessionStore.list：錯誤不得靜默變成空清單', () => {
  it('listSessions 拋錯時 list() reject，並保留原因', async () => {
    const cause = new Error('EACCES ~/.claude/projects')
    const store = createSessionStore({
      listSessions: async () => {
        throw cause
      },
      getSessionMessages: async () => HISTORY,
    })
    await expect(store.list()).rejects.toThrow('讀取歷史對話清單失敗')
    await expect(store.list()).rejects.toHaveProperty('cause', cause)
  })
})

describe('SessionStore.loadHistory', () => {
  it('逐則 normalizeHistory 展開，尾端補一筆 session-end（裁決 15）', async () => {
    const { store } = storeOf([])
    const events = await store.loadHistory('s-1')
    expect(events.length).toBeGreaterThan(HISTORY.length)
    expect(events.at(-1)).toEqual({ kind: 'session-end', isError: false })
    expect(events.filter((e) => e.kind === 'session-end')).toHaveLength(1)
  })

  it('產出不含 tool-raw-output：歷史對話沒有保存原始輸出（裁決 4）', async () => {
    const { store } = storeOf([])
    const events = await store.loadHistory('s-1')
    expect(events.some((e) => e.kind === 'tool-use')).toBe(true)
    expect(events.some((e) => e.kind === 'tool-raw-output')).toBe(false)
  })

  it('餵進 fold 之後每一個 block 都是完成狀態，尾端不會畫游標', async () => {
    const { store } = storeOf([])
    const view = fold(await store.loadHistory('s-1'))
    const blocks = view.turns.flatMap((t) => t.blocks)
    expect(blocks.length).toBeGreaterThan(0)
    const incomplete = blocks
      .filter((b) => b.kind === 'text' || b.kind === 'thinking')
      .filter((b) => !b.complete)
    expect(incomplete).toEqual([])
    expect(blocks.filter((b) => b.kind === 'tool' && b.status === 'running')).toEqual([])
    expect(view.ended).toBe(true)
  })

  it('認不出來的歷史訊息產出 unknown，不丟棄', async () => {
    const { store } = storeOf([], [{ type: '未知型別', uuid: 'u-1' }])
    const events = await store.loadHistory('s-1')
    expect(events.map((e) => e.kind)).toEqual(['unknown', 'session-end'])
  })

  it('空的歷史也照樣補 session-end', async () => {
    const { store } = storeOf([], [])
    const events: readonly Event[] = await store.loadHistory('s-1')
    expect(events).toEqual([{ kind: 'session-end', isError: false }])
  })

  it('getSessionMessages 拋錯時 loadHistory reject，帶著 sessionId', async () => {
    const store = createSessionStore({
      listSessions: async () => [],
      getSessionMessages: async () => {
        throw new Error('ENOENT')
      },
    })
    await expect(store.loadHistory('s-404')).rejects.toThrow('s-404')
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

先確認 `vitest.config.ts` 收得到這支測試：本 task 的檔案是 `.ts`，專案現行的 `include: ['tests/**/*.test.ts']` 就收得到，不用改。`.tsx` 那條（改成 `'tests/**/*.test.{ts,tsx}'`）由 Task 9 做一次，本 task 只確認、不動它。

Run: `npm test tests/session-store.test.ts`
Expected: FAIL，無法解析 `../src/main/session-store.js`（檔案還不存在）。

- [ ] **Step 3: 寫最小實作**

`src/main/session-store.ts`：

```typescript
/**
 * Recents 的資料來源：把 SDK 的 session API 包成本專案的窄介面（裁決 7）。
 *
 * 這一層不做執行期形狀驗證。理由是它的兩個依賴由組裝點直接接上 SDK 的
 * listSessions／getSessionMessages，型別在編譯期就對上了；真正跨越不可信
 * 界線的是 IPC，那一關由 Task 8 的 parseSessionSummaries 把守。在這裡再驗
 * 一次只是同一件事寫兩遍。
 */

import { normalizeHistory, type Event } from '../shared/events.js'
import type { SessionSummary } from '../shared/ipc.js'

/**
 * SDK 的 SDKSessionInfo 裡本專案真的會讀的欄位（sdk.d.ts@0.3.258 第 4968 行）。
 * 用窄複本而不是直接 import SDK 型別：SDK 加欄位不會影響這裡，SDK 拿掉這七個
 * 之中任何一個，組裝點那一行會過不了 tsc，那正是我們要的訊號。
 */
export interface SdkSessionInfo {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly firstPrompt?: string
  readonly gitBranch?: string
}

export type ListSessionsFn = (options?: { limit?: number }) => Promise<readonly SdkSessionInfo[]>
export type GetSessionMessagesFn = (sessionId: string) => Promise<readonly unknown[]>

export interface SessionStore {
  list(): Promise<readonly SessionSummary[]>
  loadHistory(sessionId: string): Promise<readonly Event[]>
  /**
   * 裁決 20：最近一次 `list()` 結果裡該筆的 `cwd`，給跨專案 resume 用。
   * 沒列過、或該筆沒有 `cwd`，回 `undefined`。
   */
  cwdOf(sessionId: string): string | undefined
}

export interface SessionStoreDeps {
  readonly listSessions: ListSessionsFn
  readonly getSessionMessages: GetSessionMessagesFn
  readonly limit?: number
}

/**
 * 實測（2026-09-02，本機 940 場 session）：不帶 limit 的 listSessions() 要
 * 536 到 736 毫秒、序列化 426 KB；limit 100 是 84 毫秒、39 KB。側邊欄一次也
 * 看不完一百筆，這個上限沒有實際損失。同一次實測確認 SDK 自己就是由新到舊
 * 排序，limit 取的是最新的 N 筆。
 */
export const DEFAULT_SESSION_LIST_LIMIT = 100
const FIRST_PROMPT_MAX = 80
const SESSION_ID_PREFIX = 8

/**
 * summary 的退回鏈。SDK 的註解說 summary 是「custom title、auto-generated
 * summary 或 first prompt」三選一，三者都沒有時它是空字串，此時清單會出現
 * 一整排無法辨識的空白列。退到 firstPrompt，再退到 sessionId 前 8 碼：後者
 * 醜但至少可以分辨兩筆不同的對話。
 */
function fallbackTitle(info: SdkSessionInfo): string {
  const summary = info.summary.trim()
  if (summary !== '') return summary
  const firstPrompt = (info.firstPrompt ?? '').trim()
  if (firstPrompt !== '') return firstPrompt.slice(0, FIRST_PROMPT_MAX)
  return info.sessionId.slice(0, SESSION_ID_PREFIX)
}

function toSummary(info: SdkSessionInfo): SessionSummary {
  return {
    sessionId: info.sessionId,
    summary: fallbackTitle(info),
    lastModified: info.lastModified,
    ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
    ...(info.customTitle === undefined ? {} : { customTitle: info.customTitle }),
    ...(info.gitBranch === undefined ? {} : { gitBranch: info.gitBranch }),
  }
}

function wrap(cause: unknown, message: string): Error {
  return new Error(message, { cause })
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const limit = deps.limit ?? DEFAULT_SESSION_LIST_LIMIT
  /**
   * 裁決 20：sessionId 到 cwd 的對照表，只有 `list()` 會換掉它，而且是整份換新的
   * `ReadonlyMap`，不就地 `set`。就地改的話，前一次 `list()` 已經消失的 session
   * 會永遠留在表裡，`cwdOf` 會回一個 SDK 早就不認得的目錄。
   */
  let cwds: ReadonlyMap<string, string> = new Map()

  return {
    async list() {
      let infos: readonly SdkSessionInfo[]
      try {
        infos = await deps.listSessions({ limit })
      } catch (cause) {
        // 不回空陣列：那會被當成「這台機器沒有歷史對話」，是靜默失敗（規格 §8）。
        throw wrap(cause, '讀取歷史對話清單失敗，Recents 無法顯示')
      }
      // 複製再排序：sort 會就地改動陣列，而這個陣列是 SDK 的，不是我們的。
      // SDK 目前已經由新到舊排好，這一行仍然保留：那是 SDK 的實作細節不是它的契約。
      const summaries = [...infos].sort((a, b) => b.lastModified - a.lastModified).map(toSummary)
      cwds = new Map(
        summaries.flatMap((s) => (s.cwd === undefined ? [] : [[s.sessionId, s.cwd] as const]))
      )
      return summaries
    },

    async loadHistory(sessionId) {
      let messages: readonly unknown[]
      try {
        messages = await deps.getSessionMessages(sessionId)
      } catch (cause) {
        throw wrap(cause, `讀取歷史對話 ${sessionId} 失敗`)
      }
      const events = messages.flatMap((m) => [...normalizeHistory(m)])
      // 裁決 15：歷史訊息已持久化，這場對話確實結束了，補這一筆不是造假。
      // 少了它，fold() 會讓每個 block 停在 complete: false，UI 在早就結束的
      // 對話尾端畫游標。
      return [...events, { kind: 'session-end', isError: false }]
    },

    cwdOf(sessionId) {
      return cwds.get(sessionId)
    },
  }
}
```

`vitest.config.ts` 的 coverage 那一段加一行（裁決 19：只用 diff 加自己的檔案，不重寫整份清單；`test.include` 不動）：

```diff
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/main/session-store.ts',
       ],
     },
```

`session-store.ts` 進得了這份清單，是因為它跟清單上其他成員同性質：不需要 jsdom、不需要 React，兩個依賴都用假函式注入就跑得起來。`src/shared/ipc.ts` 不用另外加：裁決 19 的基底清單已經有 `src/shared/**/*.ts` 這個 glob 涵蓋它。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/session-store.test.ts`
Expected: PASS，19 個測試（裁決 20 的 `cwdOf` 佔其中三條）。實跑輸出：

```
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

Run: `npm run typecheck`
Expected: 無錯誤。`session-store.ts` 共 131 行，在單檔上限內。已在 worktree 實測 `npx tsc --noEmit -p .`，`session-store.ts` 與 `tests/session-store.test.ts` 都沒有錯誤。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

四個突變，全部在 worktree 裡實際跑過：改壞、跑紅、還原、回綠。每一個都是「看起來合理」的寫法，不是明顯的破壞。

| # | 突變 | 變紅的測試 |
|---|---|---|
| 1 | `loadHistory` 直接回 `messages.flatMap(...)`，不補 `session-end` | 4 條 |
| 2 | `list()` 拿掉 `.sort(...)`，只保留 `[...infos].map(toSummary)` | 1 條 |
| 3 | `fallbackTitle` 拿掉 `firstPrompt` 那一段，空 summary 直接退到 sessionId | 2 條 |
| 4 | `list()` 成功後忘了換掉 `cwds` 對照表（拿掉 `cwds = new Map(...)` 那三行） | 1 條 |

**突變 1 是這個 task 存在的理由之一。** 少了那一筆 `session-end`，歷史對話的每一個 block 都停在 `complete: false`，畫面會在一段早就結束的對話尾端畫游標。輸出：

```
 × 逐則 normalizeHistory 展開，尾端補一筆 session-end（裁決 15） 2ms
 × 餵進 fold 之後每一個 block 都是完成狀態，尾端不會畫游標 3ms
 × 認不出來的歷史訊息產出 unknown，不丟棄 0ms
 × 空的歷史也照樣補 session-end 0ms
AssertionError: expected 6 to be greater than 6
AssertionError: expected [ { kind: 'thinking', …(2) }, …(2) ] to deeply equal []
AssertionError: expected [ 'unknown' ] to deeply equal [ 'unknown', 'session-end' ]
AssertionError: expected [] to deeply equal [ { kind: 'session-end', …(1) } ]
 Tests  4 failed | 15 passed (19)
```

「餵進 fold」那條測試的斷言順序刻意先驗 block 再驗 `ended`：`ended: false` 也會紅，但那個訊息不會告訴讀者真正的症狀是哪個 block 沒收尾。

突變 2 的輸出。四筆的正確順序與輸入順序沒有任何一位重合，所以整條斷言都不同，不會因為第一筆剛好對就漏抓：

```
 × 依 lastModified 新到舊排序 4ms
AssertionError: expected [ 'c-mid', 'c-old', 'c-new', 'c-late' ] to deeply equal [ 'c-new', 'c-late', 'c-mid', 'c-old' ]
 Tests  1 failed | 18 passed (19)
```

突變 3 的輸出。`b-1`／`b-2` 是那兩筆的 sessionId，紅燈訊息直接顯示退回鏈少了中間那一段：

```
 × summary 是空字串時退回 firstPrompt 的前 80 字 4ms
 × summary 只有空白也算空 1ms
AssertionError: expected 'b-1' to have a length of 80 but got 3
AssertionError: expected 'b-2' to be '第一句' // Object.is equality
 Tests  2 failed | 17 passed (19)
```

突變 4 的輸出（裁決 20）。它是這一組裡最容易被寫成「看起來對」的一種：`cwdOf` 讀得到一個空 Map，回 `undefined`，`list()` 照樣正確，Recents 也照樣顯示，只有 resume 會悄悄用錯目錄：

```
 × list() 之後回得出該筆自己的 cwd 2ms
AssertionError: expected undefined to be '/Users/x/Projects/beta' // Object.is equality
 Tests  1 failed | 18 passed (19)
```

四個突變逐一還原後都跑回綠燈：`Tests 19 passed (19)`。最後一次是全 worktree 一起跑，
`Test Files 8 passed (8)`、`Tests 164 passed (164)`（其中 19 個是本 task 的，其餘是
Task 6 的 13 條、Task 8 的 98 條，以及 worktree 裡既有的 cdp／layout／measure-memory）。

- [ ] **Step 6: 執行完整測試套件與 typecheck**

Run: `npm run typecheck`
Expected: 無錯誤

Run: `npm test`
Expected: PASS。本 task 為總數加 19。

- [ ] **Step 7: 提交**

```bash
git add src/main/session-store.ts \
  src/shared/ipc.ts \
  tests/session-store.test.ts \
  vitest.config.ts \
  package.json package-lock.json
git commit -m "feat: session-store 資料層，歷史載入補 session-end"
```

## 手動檢查清單（本 task commit 當下就能做的部分）

裁決 18：手動檢查只放在跑得起來的那個 task。本 task 完成時 renderer 還是佔位頁面，側邊欄看不到東西，所以「Recents 列得出來」「點歷史對話」這些端對端項目都不在這裡，歸 Task 12。這裡只留一件現在就驗得到的事：`listSessions` 真的讀得到 `~/.claude/projects`。用一支五行的臨時腳本確認（不進版控）：

```bash
node --experimental-strip-types -e "
import('@anthropic-ai/claude-agent-sdk').then(async (sdk) => {
  const t = Date.now()
  const list = await sdk.listSessions({ limit: 100 })
  console.log(list.length, Date.now() - t, 'ms')
})"
```

預期：筆數不超過 100，耗時在百毫秒等級（本機實測 84 毫秒）。

## 契約疑慮（照契約字面做完，列出待裁決）

**一、`createSessionStore` 的 deps 沒有 `projectDir`：已由接縫補記定案。** CONTRACT.md 的接縫補記（2026-09-02）明寫「`createSessionStore` 不收 `projectDir`：規格 §3.1／§3.2 定 Recents 跨專案，`listSessions()` 不帶 `dir`，預設 `limit: 100`」。本 task 實作的就是這個版本 `{ listSessions, getSessionMessages }` 再加一個選填的 `limit`，不再是待裁決事項，這裡只記錄依據。`getSessionMessages` 同理也不帶 `dir`，否則別的專案的 session 會找不到（`sdk.d.ts@0.3.258` 第 803 行的 `GetSessionMessagesOptions.dir` 註解：省略時 searches all projects；函式本身在第 797 行）。

**二、Task 8 的 `SessionSource` 與契約的 `SessionStore` 形狀：已一致。** 撰寫當時 Task 8 的 `SessionSource` 是 `{ list(), messages(sessionId): Promise<readonly unknown[]> }`，ipc-bridge 自己做 `normalizeHistory` 的展開；契約與裁決 15 則把「`normalizeHistory` 展開加補 `session-end`」放進 `SessionStore.loadHistory`。Task 8 之後已改成 `SessionSource { list(); loadHistory(sessionId): Promise<readonly Event[]> }`（見 Task 8 Step 5 `ipc-bridge.ts` 的介面宣告），ipc-bridge 不再自己展開。這裡保留是為了說明為何 `loadHistory` 的展開責任在本 task。

**三、`SessionSummary` 的歸屬。** 契約把它記在 Task 8 的產出裡，本 task 因為排在 Task 8 之前而必須自己加（見 Interfaces 一節）。字面完全相同，先做的那個 task 加完後另一個就是 no-op，跟 `vitest.config.ts` 的 `include` 是同一種情況。建議控制端在契約的元件介面一節註明「`SessionSummary` 由 Task 7 首次加入 `src/shared/ipc.ts`，Task 8 保留」。

---

### Task 8: SDK 宿主與 IPC 橋接

> **2026-09-02 依裁決 6／7／11／14／15 修訂**
>
> 本檔初稿寫在這五個裁決定案之前，以下是這次改動的清單：
>
> - **裁決 6**：`session:open` 作廢，改為 `session:intent:start-new` 與 `session:intent:open-history`
>   兩個意圖頻道。狀態機（Task 5 的 `transition`）搬進 `ipc-bridge.ts`，三個 renderer 入口與兩個
>   內部事件都走 `transition`，再照 effects 陣列順序執行。原本「從 `agent:input` 與 `session:open`
>   反推生命週期」的程式碼與那一段「`start-new` 的缺口」說明全部刪除。
> - **裁決 7**：`SessionSummary` 補齊契約的六個欄位（多了 `customTitle`／`gitBranch`）。
> - **裁決 11**：`ApprovalAskPayload` 加 `title?`／`displayName?`，由 `canUseTool` 的 options 帶進來。
> - **裁決 14**：`session:state` 送 `SessionState` 物件而非字串，`SessionStateName` 作廢；
>   `YesChefApi` 改為 `startNew()`／`openHistory(id)`；新增 `src/renderer/global.d.ts`。
> - **裁決 15**：`load-history` 直接吃 Task 7 的 `SessionStore.loadHistory()`，
>   `normalizeHistory` 與補 `session-end` 都在 Task 11 做完，bridge 不再自己展開歷史訊息。
>
> 連帶改動：`AgentHost` 從「建構即開 query」改為帶 `start()` 的長生命週期物件（`start-query`
> effect 需要一個可以重複開關 query 的把手），並新增 `onEnded` 回呼讓 query 自然結束時能送出
> `session-ended`。`ipc-bridge.ts` 從「不可測」變成可測：用 `vi.mock('electron')` 換掉 Electron，
> 加上 `tests/ipc-bridge.test.ts`。

> **2026-09-02 第二輪：依裁決 16／17、Task 0 與 Task 7 的既成事實修訂**
>
> - **裁決 16**：Task 6 的 `request()` 改收單一物件 `request(ask: ApprovalAsk)`，`ApprovalRequest`
>   自己帶 `title?`／`displayName?`，registry 補 `requestId` 後整個物件交給 `sendRequest`。
>   本檔上一輪那個 `pendingMeta` 閉包槽位（連同它的死碼討論）全部刪除，`canUseTool` 直接組出
>   一個 `ApprovalAsk`。`ApprovalMeta` 改名 `CanUseToolOptions`，語意只剩「SDK options 的窄化」。
> - **裁決 17 第 3 點**：`for await` 迭代器 throw 時，除了 `onError` 之外還合成一筆
>   `{ kind: 'session-end', isError: true, errorMessage }` 走同一條 events 通道，
>   由 `fold()` 變成對話尾端的錯誤卡片。不另設連線狀態 UI，狀態機照常回 idle。
> - **Task 0 已先跑**：`src/preload/terminal.ts`、`pty-host.ts`、`spawn-args.ts` 都已刪，
>   `src/preload/bridge.ts` 已存在（`export {}` 空殼），`electron.vite.config.ts` 的 preload
>   input 已指向它，`src/main/index.ts` 已是兩窗格最小外殼。所以本檔的 `bridge.ts` 從 Create
>   改 Modify，`Delete: src/preload/terminal.ts` 刪掉，並新增 `Modify: src/main/index.ts`
>   （Step 5b：接上 `YESCHEF_PROJECT_DIR` 守衛、`createSessionStore` 與 `createIpcBridge`）。
> - **Task 11 拆成 Task 7 與 Task 11**：`src/main/session-store.ts` 是 **Task 7** 的產出，
>   本檔所有「Task 11 的 session-store」改成 Task 7。
> - **`IpcBridgeDeps.window` 改成 `webContents`**：Task 0 之後主視窗是 `BaseWindow` 加兩個
>   `WebContentsView`，沒有 `BrowserWindow` 可傳。bridge 只需要一個送得出訊息的對象；
>   視窗的 `closed` 事件改由 `index.ts` 接，呼叫 `bridge.dispose()`。

> **2026-09-02 第三輪：依裁決 22／23／24／28 修訂**
>
> - **裁決 22**：`runEffect` 合成 `{ kind: 'reset' }`。`start-query` 且
>   `resumeSessionId === undefined` 時在 `host.start()` 之前 `pushBatch([{ kind: 'reset' }])`，
>   resume 不推；`load-history` 把它排在歷史事件最前面一起走 `pushHistory`。
>   `Event` 聯集的那一行由 Task 3 加，本檔只使用它。
> - **裁決 23**：`dispatch` 的 effects 跨 action 串行。bridge 持有 `let pending: Promise<void>`，
>   `transition` 與 `state` 更新維持同步，effects 與狀態推送接在鏈尾，
>   `track(IPC.sessionState, ...)` 與 `track` 本身刪除，`dispose` 也接在同一條鏈上。
> - **裁決 24**：SDK 的 `npm install` 搬到 Task 7 的 Step 0，本檔 Step 7 改成
>   `npm ls @anthropic-ai/claude-agent-sdk` 確認 0.3.258；`package.json` 不再是本檔的檔案。
> - **裁決 28**：`ApprovalAskPayload` 與 `canUseTool` 的 ask 加 `toolUseId`，來源是
>   SDK options 的 `toolUseID`（`sdk.d.ts@0.3.258` 第 248 行，必填）。`CanUseToolOptions`
>   跟著加一個必填欄位，`parseApprovalAsk` 檢查它是非空字串。裁決 11「options 沒有
>   tool_use_id」那句註解一併改掉。

整份計畫第一個整合層 task。前七個都是純函式，本 task 負責把它們接到 SDK 與 Electron 上：
`buildSessionOptions`（Task 1）組出 options、`query()` 起 session、`stepLive`（Task 3）逐則轉成
`Event`、`createApprovalRegistry`（Task 6）承接 `canUseTool`，最後以幀為單位合併推給 renderer。

**五個設計決定，各自對應一個已知的踩坑：**

1. **合併有批次上限，超過的部分不延後也不丟，切成滿批立刻送。** 規格 §3.1 給的方向是「以幀為單位
   合併」，16 毫秒。逐字串流下正常速率是每幀一兩筆，但工具結果回填、compact 切點、歷史重播這三種
   情況會在同一個 tick 內灌進上千筆。沒有上限的話，一次 `webContents.send` 要序列化整包，renderer
   收到後一次 `fold()` 全量，畫面卡好幾幀。上限設 128：**超出的部分在同一個 tick 內就切成滿批送出**，
   不是丟掉、也不是壓到下一幀，所以上限只影響「一次 send 多大」，不影響「事件何時到、以什麼順序到」。
2. **不用 `break` 收 query。** `query()` 回傳的是 `AsyncGenerator`，`for await` 迴圈裡 `break` 會隱式
   呼叫 `query.return()`。這有兩個問題：`return()` 不會中止已經在跑的工具（工具照樣跑完，只是沒人收
   結果），而且 SDK 對 `return()` 的清理程度不在契約裡。正確順序是 `interrupt()` → `close()` →
   讓迴圈**自然結束** → `await` 那個迴圈的 promise。所以 pump 迴圈裡沒有 `break`：唯一的退出方式是
   生成器結束。另外 `interrupt()` 是控制請求，**只有 streaming input 模式支援**，所以 `prompt` 必須
   是 `AsyncIterable`，不能傳字串，這也正是使用者輸入要有輸入佇列的原因。
3. **preload 的箭頭函式一律加大括號。** `ipcRenderer.on()` 與 `removeListener()` 為了鏈式呼叫都
   `return this`。`onData: (cb) => ipcRenderer.on(ch, ...)` 這種簡潔箭頭會把 `ipcRenderer` 本體當成回傳
   值，而 `contextBridge` 會連回傳值一起 proxy 過去，renderer 拿到 `window.yeschef.onData(cb)` 的
   回傳值就等於拿到完整的 `ipcRenderer`，可以對任意頻道 `send`／`invoke`，context isolation 形同虛設。
   這是上一個分支的 Critical。本 task 的規則：**任何直接呼叫 `ipcRenderer` 的箭頭函式，函式體一律用
   大括號**，回傳值只能是我們自己造的東西（unsubscribe 閉包或 Promise）。
4. **IPC 兩端每一筆 payload 都要執行期驗證。** renderer 是我們自己的程式碼，但它跑在另一個程序、可能
   是舊版 bundle、也可能被 DevTools 手動戳。上一個分支出過 handler 標了 `(data: string)` 但執行期收到
   物件，主程序拋未捕捉例外整個掛掉。本 task 的規則：每個 `ipcMain.on`／`handle` 的第一件事是呼叫
   `parseX()`，回 `null` 就記錄並丟棄；handler 整個 body 包在 try/catch 裡，**絕不讓例外流回 Electron
   的 IPC dispatcher**。反向（main → renderer）同樣在 preload 驗證後才交給 renderer 的 callback。

5. **狀態機住在 bridge，renderer 只送意圖（裁決 6）。** `ipc-bridge.ts` 持有一個 `SessionState`
   槽位，三個 renderer 入口（`agent:input`／`session:intent:start-new`／`session:intent:open-history`）
   與兩個內部事件（query 自然結束、`dispose()`）都先呼叫 `transition(state, action)`，再**照 effects
   陣列的順序**執行。這樣規格 §3.2 的三步收尾只有一份，而且那一份是 Task 5 的純函式測得到的資料。
   初稿的做法是 main 從 `agent:input` 與 `session:open` 反推生命週期，代價是從 `viewing` 開一條全新
   對話做不到，收尾順序在 renderer 與 main 各有一份。裁決 6 把這條路封掉了。

**合併放哪裡**：純函式核心（`mergeAccept`／`mergeTick`／`mergeFlush`）與合併器外層都放 `agent-host.ts`。
`agent-host.ts` 全程不碰 electron、對 SDK 只有 `import type`，所以它整支可以在 node 環境單元測試。

**`ipc-bridge.ts` 怎麼測**：初稿把它列為「不可測」，只靠手動檢查清單。裁決 6 之後它變成整個
session 生命週期的接線處，那份順序不能只靠人眼看。做法是在測試檔頂端 `vi.mock('electron')` 與
`vi.mock('@anthropic-ai/claude-agent-sdk')` 換掉兩個載不起來的模組，再從 `IpcBridgeDeps` 注入
假的 host 與註冊表，把每一次呼叫記進同一個陣列，順序斷言只看那個陣列。已在 worktree 實測：
`vitest` 在 node 環境跑得起來，反轉 effects 順序的突變會讓指名的三條測試變紅。手動檢查清單保留，
它驗的是 Electron 本身的行為（preload 的暴露面、真的視窗關閉），那部分還是測不到。

**Files:**
- Create: `src/main/agent-host.ts`
- Create: `src/main/ipc-bridge.ts`
- Create: `src/renderer/global.d.ts`（裁決 14：`window.yeschef` 的全域型別宣告）
- Create: `tests/agent-host.test.ts`
- Create: `tests/ipc-bridge.test.ts`（裁決 6：effects 執行順序）
- Modify: `src/preload/bridge.ts`（Task 0 已建好 `export {}` 空殼，這裡填內容；
  含裁決 21 的 `readProjectDir()`：從 `process.argv` 取 `PROJECT_DIR_ARG`）
- Modify: `src/main/index.ts`（Step 5b：在 Task 0 的兩窗格外殼上接
  `YESCHEF_PROJECT_DIR` 守衛、`createSessionStore` 與 `createIpcBridge`。`createWindow` 介面不變。
  env 讀取與守衛抽成 `requireProjectDir()`。裁決 20：`createSessionOptionsFactory` 改收
  `projectDir` 與 `sessions`；裁決 21：左窗格多 `webPreferences.additionalArguments`）
- Modify: `src/shared/ipc.ts`（整支改寫，PTY 時代的四個頻道與 `parseResizePayload` 刪除。
  Task 0 之後已經沒有人 import 它，改寫不會弄壞別人的 typecheck。
  比裁決 14 的定稿多一個常數 `PROJECT_DIR_ARG` 與 `YesChefApi` 的第九個成員
  `readonly projectDir: string`，兩者都是裁決 21）
- Modify: `tests/ipc.test.ts`（整支改寫，`describe('parseResizePayload', ...)` 刪除）
- Modify: `vitest.config.ts`（coverage include 加入 `src/main/agent-host.ts` 與
  `src/main/ipc-bridge.ts`；`src/preload/bridge.ts` **不列入**，它 `contextBridge.exposeInMainWorld`
  在 node 環境沒有意義，改用手動檢查清單）

`package.json` **不動**：`@anthropic-ai/claude-agent-sdk@0.3.258` 由 Task 7 的 Step 0 裝好
（裁決 24），本 task 只在 Step 7 用 `npm ls` 確認它在。

PTY 時代的檔案（`src/preload/terminal.ts` 等）已由 Task 0 刪除，本 task 不再處理。

**Interfaces:**
- Consumes:
  - `buildSessionOptions` / `SessionOptions`（Task 1）
  - `stepLive` / `INITIAL_CURSOR` / `LiveCursor` / `Event`（Task 3）。`Event` 聯集的
    `{ kind: 'reset' }` 由 Task 3 加（裁決 22），`stepLive`／`normalizeHistory` 永遠不產出它；
    本 task 的 `ipc-bridge.ts` 是唯一產出它的地方
  - `transition` / `Action` / `Effect`（Task 5，`src/main/session-machine.ts`）
  - `SessionState`（Task 5，`src/shared/session-state.ts`）
  - `createApprovalRegistry` / `ApprovalAsk` / `ApprovalOutcome` / `ApprovalRequest`（Task 6，裁決 16）
  - `createSessionStore` / `SessionStore`（Task 7，`src/main/session-store.ts`；
    bridge 只依賴介面 `list()` 與 `loadHistory(sessionId)`，`index.ts` 才碰實作，
    並且用 `cwdOf(sessionId)` 決定 resume 的 cwd，裁決 20）
  - `createWindow` 的外殼（Task 0，`src/main/index.ts`）
  - SDK 的 `query` / `listSessions` / `getSessionMessages`（`@anthropic-ai/claude-agent-sdk`）
- Produces（`src/shared/ipc.ts`）:
  - `const IPC`（契約原文照抄的八個頻道）
  - `const PROJECT_DIR_ARG = '--yeschef-project-dir='`（裁決 21，`index.ts` 與 `bridge.ts` 共用）
  - `type ApprovalDecision`、`type Unsubscribe`
  - `interface ApprovalAskPayload`（含裁決 11 的 `title?`／`displayName?`）、`ApprovalReplyPayload`、
    `IntentOpenHistoryPayload`、`SessionSummary`（裁決 7 的六欄）、
    `YesChefApi`（裁決 14 定稿，加裁決 21 的第九個成員 `projectDir`）
  - `parseUserInput` / `parseApprovalReply` / `parseIntentOpenHistory` / `parseApprovalAsk` /
    `parseEventsBatch` / `parseSessionState` / `parseSessionSummaries`
- Produces（`src/renderer/global.d.ts`）:
  - `declare global { interface Window { readonly yeschef: YesChefApi } }`
- Produces（`src/main/agent-host.ts`）:
  - `interface MergeConfig`、`MergeState`、`MergeStep`；`const DEFAULT_MERGE_CONFIG`、`INITIAL_MERGE_STATE`
  - `mergeAccept(state, incoming, now, config?)` / `mergeTick(state, now, config?)` /
    `mergeFlush(state)` / `mergeWakeAt(state, config?)`：全部純函式，不碰計時器
  - `createEventMerger(opts): EventMerger`（合併器外層，時鐘與計時器可注入）
  - `toPermissionResult(outcome, input): SdkPermissionResult`
  - `interface QueryHandle`、`UserTurn`、`CanUseToolOptions`；`type QueryFn`、`CanUseToolFn`、
    `SdkPermissionResult`
  - `createAgentHost(deps): AgentHost`（`start(resumeSessionId?, initialInput?)` / `send` /
    `interrupt` / `teardown`）
- Produces（`src/main/ipc-bridge.ts`）:
  - `interface SessionSource`（與契約文末 Task 7 的 `SessionStore` 同形狀，以這個名字當注入點）、
    `IpcBridgeDeps`（`webContents`／`sessionOptions`／`sessions`／`logError` 加三個測試用的選填項）、
    `IpcBridge`（只有 `dispose()`）
  - `createIpcBridge(deps): IpcBridge`

下游用法：Task 9 的 App 透過 `window.yeschef` 訂閱事件、批准請求與 `SessionState`，並用
`sendInput`／`startNew`／`openHistory` 送意圖。Task 5 的五個 effect 在 `ipc-bridge.ts` 的
`runEffect` 裡各對應一件事：`deny-all-approvals` → `registry.denyAll()`、`interrupt-query` →
`host.interrupt()`、`teardown-query` → `host.teardown()`、`start-query` → `host.start()`、
`load-history` → `sessions.loadHistory()`。一個 action 之內的順序由 Task 5 的陣列決定，
bridge 只照著跑；action 與 action 之間由裁決 23 的 `pending` 鏈串起來，前一個 action 的
effects 全部跑完並推出 `SessionState`，下一個才開始。`start-query`（非 resume）與
`load-history` 另外各合成一筆 `{ kind: 'reset' }` 走 events 通道（裁決 22）。

- [ ] **Step 1a: 寫失敗的測試（IPC payload 驗證）**

`tests/ipc.test.ts` 整支改寫（原本測 `parseResizePayload`，那個頻道已作廢）：

```typescript
import { describe, it, expect } from 'vitest'
import {
  IPC,
  MAX_INPUT_LENGTH,
  parseApprovalAsk,
  parseApprovalReply,
  parseEventsBatch,
  parseIntentOpenHistory,
  parseSessionState,
  parseSessionSummaries,
  parseUserInput,
} from '../src/shared/ipc.js'

describe('IPC 頻道名稱與契約一致', () => {
  it('八個頻道逐字比對', () => {
    expect(IPC).toEqual({
      eventsBatch: 'agent:events',
      userInput: 'agent:input',
      approvalAsk: 'agent:approval:ask',
      approvalReply: 'agent:approval:reply',
      sessionList: 'session:list',
      sessionState: 'session:state',
      intentStartNew: 'session:intent:start-new',
      intentOpenHistory: 'session:intent:open-history',
    })
  })
})

describe('parseUserInput', () => {
  it('接受一般字串', () => {
    expect(parseUserInput('你好')).toBe('你好')
  })
  it('空字串回 null（沒有東西可送給 SDK）', () => {
    expect(parseUserInput('')).toBeNull()
  })
  it('非字串一律回 null', () => {
    for (const bad of [null, undefined, 42, {}, [], true, { text: 'hi' }]) {
      expect(parseUserInput(bad)).toBeNull()
    }
  })
  it('超過上限回 null（擋住整包貼上的巨型 payload）', () => {
    expect(parseUserInput('a'.repeat(MAX_INPUT_LENGTH))).not.toBeNull()
    expect(parseUserInput('a'.repeat(MAX_INPUT_LENGTH + 1))).toBeNull()
  })
})

describe('parseApprovalReply', () => {
  it('allow 與 deny 都接受，且回傳新物件（不把外來物件直接放行）', () => {
    const raw = { requestId: 'r-1', decision: 'allow', 額外欄位: '應被丟掉' }
    expect(parseApprovalReply(raw)).toEqual({ requestId: 'r-1', decision: 'allow' })
    expect(parseApprovalReply({ requestId: 'r-2', decision: 'deny' })).toEqual({
      requestId: 'r-2',
      decision: 'deny',
    })
  })
  it('decision 不是 allow/deny 回 null', () => {
    for (const d of ['yes', 'ALLOW', '', 1, null, undefined]) {
      expect(parseApprovalReply({ requestId: 'r-1', decision: d })).toBeNull()
    }
  })
  it('requestId 缺漏或非字串回 null', () => {
    expect(parseApprovalReply({ decision: 'allow' })).toBeNull()
    expect(parseApprovalReply({ requestId: '', decision: 'allow' })).toBeNull()
    expect(parseApprovalReply({ requestId: 7, decision: 'allow' })).toBeNull()
  })
  it('非物件回 null（陣列也算非物件）', () => {
    for (const bad of [null, undefined, 'r-1', 3, []]) {
      expect(parseApprovalReply(bad)).toBeNull()
    }
  })
})

describe('parseIntentOpenHistory', () => {
  it('接受帶 sessionId 的物件', () => {
    expect(parseIntentOpenHistory({ sessionId: 's-1' })).toEqual({ sessionId: 's-1' })
  })
  it('空字串或缺漏回 null', () => {
    expect(parseIntentOpenHistory({ sessionId: '' })).toBeNull()
    expect(parseIntentOpenHistory({})).toBeNull()
    expect(parseIntentOpenHistory('s-1')).toBeNull()
  })
})

describe('parseApprovalAsk（main → renderer，preload 側驗證）', () => {
  it('input 可以是任何值，但 requestId、toolUseId 與 toolName 必須是非空字串', () => {
    expect(
      parseApprovalAsk({ requestId: 'r-1', toolUseId: 'toolu_1', toolName: 'Bash', input: null })
    ).toEqual({
      requestId: 'r-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: null,
    })
    expect(
      parseApprovalAsk({ requestId: 'r-1', toolUseId: 'toolu_1', toolName: '', input: {} })
    ).toBeNull()
    expect(parseApprovalAsk({ toolUseId: 'toolu_1', toolName: 'Bash', input: {} })).toBeNull()
  })

  it('裁決 28：缺 toolUseId 判為無效，型別不對也一樣', () => {
    expect(parseApprovalAsk({ requestId: 'r-1', toolName: 'Bash', input: {} })).toBeNull()
    expect(
      parseApprovalAsk({ requestId: 'r-1', toolUseId: '', toolName: 'Bash', input: {} })
    ).toBeNull()
    expect(
      parseApprovalAsk({ requestId: 'r-1', toolUseId: 7, toolName: 'Bash', input: {} })
    ).toBeNull()
  })

  it('裁決 11：title 與 displayName 是選填字串，會被帶過去', () => {
    expect(
      parseApprovalAsk({
        requestId: 'r-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        title: 'Claude 想執行 ls',
        displayName: '執行指令',
      })
    ).toEqual({
      requestId: 'r-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: {},
      title: 'Claude 想執行 ls',
      displayName: '執行指令',
    })
  })

  it('沒帶 title／displayName 時不憑空補上欄位', () => {
    const parsed = parseApprovalAsk({
      requestId: 'r-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: {},
    })
    expect(parsed).not.toHaveProperty('title')
    expect(parsed).not.toHaveProperty('displayName')
  })

  it('title／displayName 不是字串時整筆回 null，不默默丟掉那個欄位', () => {
    expect(
      parseApprovalAsk({
        requestId: 'r-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        title: 7,
      })
    ).toBeNull()
    expect(
      parseApprovalAsk({
        requestId: 'r-1',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: {},
        displayName: {},
      })
    ).toBeNull()
  })
})

describe('parseEventsBatch', () => {
  it('接受一串帶 kind 的物件，並保持順序與筆數', () => {
    const batch = [
      { kind: 'text-delta', messageId: 'm-1', index: 0, text: 'a' },
      { kind: 'block-stop', messageId: 'm-1', index: 0 },
    ]
    expect(parseEventsBatch(batch)).toEqual(batch)
  })
  it('空陣列回 null（不該有空批次送到 renderer）', () => {
    expect(parseEventsBatch([])).toBeNull()
  })
  it('任何一筆缺 kind，整批回 null', () => {
    expect(parseEventsBatch([{ kind: 'text', text: 'a' }, { text: 'b' }])).toBeNull()
  })
  it('非陣列回 null', () => {
    for (const bad of [null, undefined, {}, 'text', 5]) {
      expect(parseEventsBatch(bad)).toBeNull()
    }
  })
})

describe('parseSessionState（裁決 14：物件不是字串）', () => {
  it('三種 kind 各自回新造的物件', () => {
    expect(parseSessionState({ kind: 'idle' })).toEqual({ kind: 'idle' })
    expect(parseSessionState({ kind: 'live' })).toEqual({ kind: 'live' })
    expect(parseSessionState({ kind: 'live', sessionId: 's-1' })).toEqual({
      kind: 'live',
      sessionId: 's-1',
    })
    expect(parseSessionState({ kind: 'viewing', sessionId: 's-1' })).toEqual({
      kind: 'viewing',
      sessionId: 's-1',
    })
  })

  it('viewing 一定要有非空 sessionId', () => {
    expect(parseSessionState({ kind: 'viewing' })).toBeNull()
    expect(parseSessionState({ kind: 'viewing', sessionId: '' })).toBeNull()
    expect(parseSessionState({ kind: 'viewing', sessionId: 3 })).toBeNull()
  })

  it('live 的 sessionId 可以省略，但給了就必須是非空字串', () => {
    expect(parseSessionState({ kind: 'live', sessionId: '' })).toBeNull()
    expect(parseSessionState({ kind: 'live', sessionId: 3 })).toBeNull()
  })

  it('舊的字串形式一律回 null（renderer 拿到舊 bundle 時不能靜默通過）', () => {
    for (const bad of ['idle', 'live', 'viewing', { kind: 'busy' }, null, []]) {
      expect(parseSessionState(bad)).toBeNull()
    }
  })

  it('回的是新物件，額外欄位被切掉', () => {
    const raw = { kind: 'viewing', sessionId: 's-1', 額外欄位: '應被丟掉' }
    const parsed = parseSessionState(raw)
    expect(parsed).toEqual({ kind: 'viewing', sessionId: 's-1' })
    expect(parsed).not.toBe(raw)
  })
})

describe('parseSessionSummaries', () => {
  it('接受合法清單並只留契約的六個欄位', () => {
    const raw = [
      {
        sessionId: 's-1',
        summary: '修 bug',
        lastModified: 1,
        cwd: '/p',
        customTitle: '我的標題',
        gitBranch: 'main',
        fileSize: 99,
      },
      { sessionId: 's-2', summary: '寫測試', lastModified: 2 },
    ]
    expect(parseSessionSummaries(raw)).toEqual([
      {
        sessionId: 's-1',
        summary: '修 bug',
        lastModified: 1,
        cwd: '/p',
        customTitle: '我的標題',
        gitBranch: 'main',
      },
      { sessionId: 's-2', summary: '寫測試', lastModified: 2 },
    ])
  })
  it('選填欄位型別不符時整份回 null，不默默丟掉那一筆', () => {
    const base = { sessionId: 's-1', summary: 'a', lastModified: 1 }
    expect(parseSessionSummaries([{ ...base, customTitle: 7 }])).toBeNull()
    expect(parseSessionSummaries([{ ...base, gitBranch: [] }])).toBeNull()
    expect(parseSessionSummaries([{ ...base, cwd: 1 }])).toBeNull()
  })
  it('空陣列是合法的（使用者可能真的沒有歷史對話）', () => {
    expect(parseSessionSummaries([])).toEqual([])
  })
  it('任何一筆形狀不符，整份回 null', () => {
    expect(parseSessionSummaries([{ sessionId: 's-1', summary: 'a' }])).toBeNull()
    expect(parseSessionSummaries([{ summary: 'a', lastModified: 1 }])).toBeNull()
    expect(parseSessionSummaries('s-1')).toBeNull()
  })
})
```

- [ ] **Step 1b: 寫失敗的測試（事件合併，純函式，不碰計時器）**

`tests/agent-host.test.ts` 上半段。合併的測試**只用明確傳入的 `now`**，不用 `vi.useFakeTimers`：
合併規則本身跟真實時間無關，把它跟計時器綁在一起會讓「規則錯了」與「計時器沒觸發」兩種失敗混在一起。

```typescript
import { describe, it, expect } from 'vitest'
import type { Event } from '../src/shared/events.js'
import {
  DEFAULT_MERGE_CONFIG,
  INITIAL_MERGE_STATE,
  createAgentHost,
  createEventMerger,
  mergeAccept,
  mergeFlush,
  mergeTick,
  mergeWakeAt,
  toPermissionResult,
  type CanUseToolFn,
  type MergeConfig,
  type MergeState,
  type QueryHandle,
  type UserTurn,
} from '../src/main/agent-host.js'
import type { ApprovalAsk } from '../src/main/approval.js'
import type { SessionOptions } from '../src/main/session-args.js'

/** 產生可辨識的事件序列：text 就是序號，用來斷言順序與筆數。 */
function seq(n: number, offset = 0): readonly Event[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'text-delta' as const,
    messageId: 'm-1',
    index: 0,
    text: String(offset + i),
  }))
}

const CFG: MergeConfig = { frameMs: 16, maxBatchSize: 4 }

/** 把一連串批次攤平，用來跟輸入序列逐一比對。 */
function flat(batches: readonly (readonly Event[])[]): string[] {
  return batches.flatMap((b) => b.map((e) => (e.kind === 'text-delta' ? e.text : e.kind)))
}

describe('mergeAccept：一幀之內累積，不立刻送', () => {
  it('未滿一幀也未滿批次上限時不產生批次', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(2), 1000, CFG)
    expect(r.batches).toEqual([])
    expect(r.state.pending).toHaveLength(2)
    expect(r.state.frameStartedAt).toBe(1000)
  })

  it('第二次 accept 不重設幀的起點（一直進來的事件不能無限延後送出）', () => {
    const a = mergeAccept(INITIAL_MERGE_STATE, seq(1), 1000, CFG)
    const b = mergeAccept(a.state, seq(1, 1), 1010, CFG)
    expect(b.state.frameStartedAt).toBe(1000)
  })

  it('空的 incoming 是 no-op，且不會開啟一個空幀', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, [], 1000, CFG)
    expect(r.batches).toEqual([])
    expect(r.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('不修改傳入的 state 與 incoming', () => {
    const incoming = seq(3)
    const state = INITIAL_MERGE_STATE
    const before = JSON.stringify({ state, incoming })
    mergeAccept(state, incoming, 1000, CFG)
    expect(JSON.stringify({ state, incoming })).toBe(before)
  })
})

describe('mergeAccept：批次上限', () => {
  it('達到上限時立刻切出滿批，餘數留在新的一幀', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(6), 1000, CFG)
    expect(r.batches).toHaveLength(1)
    expect(flat(r.batches)).toEqual(['0', '1', '2', '3'])
    expect(flat([r.state.pending])).toEqual(['4', '5'])
    expect(r.state.frameStartedAt).toBe(1000)
  })

  it('一次灌進大量事件會切成多個滿批，全部在同一次呼叫內送出', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(10), 1000, CFG)
    expect(r.batches.map((b) => b.length)).toEqual([4, 4])
    expect(r.state.pending).toHaveLength(2)
  })

  it('剛好整除時餘數為空，幀關閉', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(8), 1000, CFG)
    expect(r.batches.map((b) => b.length)).toEqual([4, 4])
    expect(r.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('不變量：任何一步之後 pending 都少於批次上限', () => {
    let state: MergeState = INITIAL_MERGE_STATE
    for (let i = 0; i < 40; i += 1) {
      state = mergeAccept(state, seq(3, i * 3), 1000 + i, CFG).state
      expect(state.pending.length).toBeLessThan(CFG.maxBatchSize)
    }
  })
})

describe('合併不得弄丟或改變事件順序', () => {
  it('任意 accept／tick 交錯之後，所有批次串接加上 pending 等於原始序列', () => {
    const chunks = [3, 1, 9, 2, 5, 1, 1, 14, 2]
    let state: MergeState = INITIAL_MERGE_STATE
    let emitted: string[] = []
    let produced = 0
    let now = 1000

    for (const size of chunks) {
      const a = mergeAccept(state, seq(size, produced), now, CFG)
      produced += size
      state = a.state
      emitted = [...emitted, ...flat(a.batches)]

      now += 20 // 超過 frameMs，下一次 tick 必定觸發
      const t = mergeTick(state, now, CFG)
      state = t.state
      emitted = [...emitted, ...flat(t.batches)]
    }
    const f = mergeFlush(state)
    emitted = [...emitted, ...flat(f.batches)]

    expect(emitted).toEqual(Array.from({ length: produced }, (_, i) => String(i)))
    expect(f.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('批次上限造成的切割不會改變相鄰事件的先後', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(7), 1000, CFG)
    expect([...flat(r.batches), ...flat([r.state.pending])]).toEqual([
      '0', '1', '2', '3', '4', '5', '6',
    ])
    // 上一幀殘留的 pending 一定排在這一次的 incoming 之前。從空的 pending 出發
    // 測不到這件事：串接寫反了，空陣列接在哪一頭結果都一樣。
    const next = mergeAccept(r.state, seq(3, 7), 1020, CFG)
    expect([...flat(next.batches), ...flat([next.state.pending])]).toEqual([
      '4', '5', '6', '7', '8', '9',
    ])
  })

  it('合併只打包不加工：批次裡的事件物件與輸入是同一個參考', () => {
    const incoming = seq(2)
    const r = mergeFlush(mergeAccept(INITIAL_MERGE_STATE, incoming, 1000, CFG).state)
    expect(r.batches[0]?.[0]).toBe(incoming[0])
    expect(r.batches[0]?.[1]).toBe(incoming[1])
  })
})

describe('mergeTick 與 mergeWakeAt', () => {
  it('滿一幀才送', () => {
    const s = mergeAccept(INITIAL_MERGE_STATE, seq(2), 1000, CFG).state
    expect(mergeTick(s, 1015, CFG).batches).toEqual([])
    const fired = mergeTick(s, 1016, CFG)
    expect(flat(fired.batches)).toEqual(['0', '1'])
    expect(fired.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('pending 為空時 tick 是 no-op，不產生空批次', () => {
    expect(mergeTick(INITIAL_MERGE_STATE, 9999, CFG)).toEqual({
      state: INITIAL_MERGE_STATE,
      batches: [],
    })
  })

  it('mergeWakeAt 回傳這一幀的絕對截止時間，沒有 pending 時回 null', () => {
    expect(mergeWakeAt(INITIAL_MERGE_STATE, CFG)).toBeNull()
    const s = mergeAccept(INITIAL_MERGE_STATE, seq(1), 1000, CFG).state
    expect(mergeWakeAt(s, CFG)).toBe(1016)
  })

  it('預設設定是規格 §3.1 的 16 毫秒', () => {
    expect(DEFAULT_MERGE_CONFIG.frameMs).toBe(16)
    expect(DEFAULT_MERGE_CONFIG.maxBatchSize).toBeGreaterThan(0)
  })
})

describe('mergeFlush', () => {
  it('把 pending 一次送完並回到初始狀態', () => {
    const s = mergeAccept(INITIAL_MERGE_STATE, seq(3), 1000, CFG).state
    const r = mergeFlush(s)
    expect(flat(r.batches)).toEqual(['0', '1', '2'])
    expect(r.state).toEqual(INITIAL_MERGE_STATE)
  })
  it('沒有 pending 時不產生批次', () => {
    expect(mergeFlush(INITIAL_MERGE_STATE).batches).toEqual([])
  })
})

describe('toPermissionResult：ApprovalOutcome → SDK 的 PermissionResult', () => {
  it('allow 帶上原始 input 當 updatedInput', () => {
    const input = { command: 'ls' }
    expect(toPermissionResult({ decision: 'allow' }, input)).toEqual({
      behavior: 'allow',
      updatedInput: input,
    })
  })
  it('deny 一定要有 message，SDK 靠它渲染拒絕原因', () => {
    expect(toPermissionResult({ decision: 'deny', reason: '逾時未回覆' }, {})).toEqual({
      behavior: 'deny',
      message: '逾時未回覆',
    })
  })
  it('deny 沒帶 reason 時填預設字串，不得是空字串或 undefined', () => {
    const r = toPermissionResult({ decision: 'deny' }, {})
    expect(r.behavior).toBe('deny')
    expect(r.behavior === 'deny' && r.message.length).toBeGreaterThan(0)
  })
  it('不修改傳入的 input', () => {
    const input = { command: 'ls' }
    toPermissionResult({ decision: 'allow' }, input)
    expect(input).toEqual({ command: 'ls' })
  })
})
```

- [ ] **Step 1c: 寫失敗的測試（合併器外層與 agent-host）**

`tests/agent-host.test.ts` 下半段。合併器外層與 host 的時鐘、計時器全部注入，測試自己推時間，
不用 `vi.useFakeTimers`（避免跟 `await` 的 microtask 排程互相打架）。

```typescript
/** 手動時鐘：計時器不會自己跑，測試呼叫 advance() 才觸發。 */
function manualClock(): {
  clock: { now: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void }
  advance: (ms: number) => void
} {
  let now = 0
  let nextId = 1
  const timers = new Map<number, () => void>()
  return {
    clock: {
      now: () => now,
      setTimer: (fn) => {
        const id = nextId
        nextId += 1
        timers.set(id, fn)
        return id
      },
      clearTimer: (h) => {
        timers.delete(h as number)
      },
    },
    advance: (ms) => {
      now += ms
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) fn()
    },
  }
}

describe('createEventMerger（合併器外層）', () => {
  it('滿一幀才把批次交出去，且只交一次', () => {
    const { clock, advance } = manualClock()
    const batches: (readonly Event[])[] = []
    const merger = createEventMerger({ onBatch: (b) => batches.push(b), config: CFG, clock })
    merger.accept(seq(2))
    expect(batches).toEqual([])
    advance(16)
    expect(flat(batches)).toEqual(['0', '1'])
    advance(1000)
    expect(batches).toHaveLength(1)
  })

  it('超過批次上限時不等計時器，同一個 tick 就送出滿批', () => {
    const { clock } = manualClock()
    const batches: (readonly Event[])[] = []
    const merger = createEventMerger({ onBatch: (b) => batches.push(b), config: CFG, clock })
    merger.accept(seq(9))
    expect(batches.map((b) => b.length)).toEqual([4, 4])
  })

  it('flush 立刻交出殘留事件，dispose 之後不再有任何回呼', () => {
    const { clock, advance } = manualClock()
    const batches: (readonly Event[])[] = []
    const merger = createEventMerger({ onBatch: (b) => batches.push(b), config: CFG, clock })
    merger.accept(seq(2))
    merger.flush()
    expect(flat(batches)).toEqual(['0', '1'])
    merger.dispose()
    merger.accept(seq(2, 9))
    advance(1000)
    expect(batches).toHaveLength(1)
  })
})

/** 假的 query()：可控制何時吐訊息、何時結束，並記錄 interrupt／close 被叫了幾次。 */
function createFakeQuery(): {
  handle: QueryHandle
  emit: (msg: unknown) => void
  end: () => void
  stats: { interrupts: number; closes: number }
} {
  const queued: unknown[] = []
  let waiting: ((r: IteratorResult<unknown>) => void) | null = null
  let ended = false
  const stats = { interrupts: 0, closes: 0 }

  const end = (): void => {
    if (ended) return
    ended = true
    const w = waiting
    waiting = null
    if (w) w({ value: undefined, done: true })
  }
  const emit = (msg: unknown): void => {
    const w = waiting
    if (w) {
      waiting = null
      w({ value: msg, done: false })
      return
    }
    queued.push(msg)
  }
  const handle: QueryHandle = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (queued.length > 0) return Promise.resolve({ value: queued.shift(), done: false })
        if (ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<unknown>>((resolve) => {
          waiting = resolve
        })
      },
    }),
    interrupt: () => {
      stats.interrupts += 1
      return Promise.resolve()
    },
    close: () => {
      stats.closes += 1
      end()
    },
  }
  return { handle, emit, end, stats }
}

const MESSAGE_START = {
  type: 'stream_event',
  event: { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5' } },
}
const TEXT_DELTA = {
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
}

const OPTIONS: SessionOptions = { cwd: '/p', permissionMode: 'default', includePartialMessages: true }

/**
 * 裁決 6 之後 host 是長生命週期物件：建構不開 query，`start()` 才開。
 * 這個 helper 建好之後直接 `start()`，讓原本那批測試的前提維持不變。
 */
function setupHost(overrides?: {
  requestApproval?: (ask: ApprovalAsk) => Promise<{ decision: 'allow' | 'deny'; reason?: string }>
  autoStart?: false
}) {
  const fq = createFakeQuery()
  const { clock, advance } = manualClock()
  const batches: (readonly Event[])[] = []
  const errors: Error[] = []
  const resumes: (string | undefined)[] = []
  let ended = 0
  let prompt: AsyncIterable<UserTurn> | null = null
  let canUseTool: CanUseToolFn | null = null

  const host = createAgentHost({
    queryFn: (params) => {
      prompt = params.prompt
      canUseTool = params.options.canUseTool
      return fq.handle
    },
    sessionOptions: (resume) => {
      resumes.push(resume)
      return resume === undefined ? OPTIONS : { ...OPTIONS, resume }
    },
    requestApproval:
      overrides?.requestApproval ?? (() => Promise.resolve({ decision: 'allow' as const })),
    onBatch: (b) => batches.push(b),
    onError: (e) => errors.push(e),
    onEnded: () => {
      ended += 1
    },
    merge: CFG,
    clock,
  })
  if (overrides?.autoStart !== false) host.start()
  return {
    host,
    fq,
    advance,
    batches,
    errors,
    resumes,
    ended: () => ended,
    prompt: () => prompt,
    canUseTool: () => canUseTool,
  }
}

describe('createAgentHost：事件路徑', () => {
  it('游標由 host 持有：message_start 之後的 delta 帶得到 messageId', async () => {
    const s = setupHost()
    s.fq.emit(MESSAGE_START)
    s.fq.emit(TEXT_DELTA)
    s.fq.end()
    await s.host.teardown()

    const events = s.batches.flat()
    const delta = events.find((e) => e.kind === 'text-delta')
    expect(delta).toBeDefined()
    expect(delta && 'messageId' in delta && delta.messageId).toBe('msg_1')
  })

  it('teardown 會把還在緩衝裡的事件送完，一筆都不吞', async () => {
    const s = setupHost()
    s.fq.emit(MESSAGE_START)
    s.fq.emit(TEXT_DELTA)
    s.fq.end()
    expect(s.batches).toEqual([]) // 還沒滿一幀
    await s.host.teardown()
    expect(s.batches.flat().length).toBeGreaterThan(0)
  })

  it('teardown 之後不再產生任何批次', async () => {
    const s = setupHost()
    s.fq.emit(MESSAGE_START)
    s.fq.end()
    await s.host.teardown()
    const count = s.batches.length
    s.advance(10_000)
    expect(s.batches).toHaveLength(count)
  })

  it('認不出來的訊息走 unknown Event，不被丟棄', async () => {
    const s = setupHost()
    s.fq.emit({ type: '從未見過的型別' })
    s.fq.end()
    await s.host.teardown()
    expect(s.batches.flat().some((e) => e.kind === 'unknown')).toBe(true)
  })
})

describe('createAgentHost：輸入與收尾', () => {
  it('send 把文字包成 user turn 推進 prompt 串流', async () => {
    const s = setupHost()
    expect(s.host.send('你好')).toBe(true)
    const iterator = s.prompt()![Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({
      type: 'user',
      message: { role: 'user', content: '你好' },
      parent_tool_use_id: null,
    })
    s.fq.end()
    await s.host.teardown()
  })

  it('start 的 initialInput 直接排進串流，resume 進得了 options（viewing → live 的第一則）', async () => {
    const s = setupHost({ autoStart: false })
    s.host.start('s-1', '接著問')
    expect(s.resumes).toEqual(['s-1'])
    const first = await s.prompt()![Symbol.asyncIterator]().next()
    expect(first.value).toMatchObject({ message: { content: '接著問' } })
    s.fq.end()
    await s.host.teardown()
  })

  it('start 之前 send 回 false：沒有 query 就沒有地方可送', () => {
    const s = setupHost({ autoStart: false })
    expect(s.host.send('太早了')).toBe(false)
  })

  it('已有活躍 query 時再 start 是接線錯誤，回報而不是偷偷開第二條', () => {
    const s = setupHost()
    s.host.start()
    expect(s.errors.map((e) => e.message).join()).toMatch(/已有活躍 query/)
  })

  it('query 自己走完時通知 onEnded（裁決 6：bridge 據此送 session-ended）', async () => {
    const s = setupHost()
    s.fq.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(s.ended()).toBe(1)
    // 自己結束的 query 不算被收掉，teardown 不會重複收
    await s.host.teardown()
    expect(s.fq.stats.closes).toBe(0)
  })

  it('teardown 收掉的 query 不觸發 onEnded（那是我們收的，不是它自己結束的）', async () => {
    const s = setupHost()
    await s.host.teardown()
    expect(s.ended()).toBe(0)
  })

  it('teardown 之後可以再 start 一條新的 query', async () => {
    const s = setupHost()
    await s.host.teardown()
    s.host.start('s-2')
    expect(s.resumes).toEqual([undefined, 's-2'])
    expect(s.host.send('新的一輪')).toBe(true)
  })

  it('teardown 呼叫 close，並等到事件迴圈真的結束才 resolve', async () => {
    const s = setupHost()
    await s.host.teardown()
    expect(s.fq.stats.closes).toBe(1)
  })

  it('teardown 之後 send 回 false，不會再有東西進 SDK', async () => {
    const s = setupHost()
    await s.host.teardown()
    expect(s.host.send('太晚了')).toBe(false)
  })

  it('teardown 可以重複呼叫，只真的收一次', async () => {
    const s = setupHost()
    await Promise.all([s.host.teardown(), s.host.teardown()])
    await s.host.teardown()
    expect(s.fq.stats.closes).toBe(1)
  })

  it('interrupt 轉呼叫 query.interrupt，且不收掉 query（之後還能繼續送輸入）', async () => {
    const s = setupHost()
    await s.host.interrupt()
    expect(s.fq.stats.interrupts).toBe(1)
    expect(s.fq.stats.closes).toBe(0)
    expect(s.host.send('繼續')).toBe(true)
    s.fq.end()
    await s.host.teardown()
  })

  it('teardown 之後 interrupt 是無害的 no-op', async () => {
    const s = setupHost()
    await s.host.teardown()
    await s.host.interrupt()
    expect(s.fq.stats.interrupts).toBe(0)
  })
})

/** SDK options 的最小形狀：裁決 28 之後 `toolUseID` 是必填的。 */
const OPTS = { toolUseID: 'toolu_1' }

describe('createAgentHost：canUseTool', () => {
  it('allow 轉成 behavior allow，input 原樣帶回', async () => {
    const s = setupHost()
    const result = await s.canUseTool()!('Bash', { command: 'ls' }, OPTS)
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    s.fq.end()
    await s.host.teardown()
  })

  it('deny 轉成 behavior deny，理由帶進 message', async () => {
    const s = setupHost({
      requestApproval: () => Promise.resolve({ decision: 'deny' as const, reason: '批准逾時' }),
    })
    expect(await s.canUseTool()!('Bash', { command: 'rm -rf /' }, OPTS)).toEqual({
      behavior: 'deny',
      message: '批准逾時',
    })
    s.fq.end()
    await s.host.teardown()
  })

  it('批准流程本身丟錯時 deny 並回報，不讓 canUseTool 的 promise 掛死', async () => {
    const s = setupHost({ requestApproval: () => Promise.reject(new Error('註冊表壞了')) })
    const result = await s.canUseTool()!('Bash', {}, OPTS)
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(s.errors.map((e) => e.message).join()).toMatch(/註冊表壞了/)
    s.fq.end()
    await s.host.teardown()
  })

  it('裁決 11／16／28：toolUseId、toolName、input、title、displayName 併成一個 ask 送進註冊表', async () => {
    const seen: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        seen.push(ask)
        return Promise.resolve({ decision: 'allow' as const })
      },
    })
    await s.canUseTool()!('Bash', { command: 'ls' }, {
      toolUseID: 'toolu_ls',
      title: 'Claude 想執行 ls',
      displayName: '執行指令',
    })
    expect(seen).toEqual([
      {
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: 'toolu_ls',
        title: 'Claude 想執行 ls',
        displayName: '執行指令',
      },
    ])
    s.fq.end()
    await s.host.teardown()
  })

  it('裁決 28：兩次呼叫各自帶自己的 toolUseId，不共用', async () => {
    const seen: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        seen.push(ask)
        return Promise.resolve({ decision: 'allow' as const })
      },
    })
    await s.canUseTool()!('Bash', {}, { toolUseID: 'toolu_a' })
    await s.canUseTool()!('Read', {}, { toolUseID: 'toolu_b' })
    expect(seen.map((a) => a.toolUseId)).toEqual(['toolu_a', 'toolu_b'])
    s.fq.end()
    await s.host.teardown()
  })
})

describe('createAgentHost：錯誤不靜默', () => {
  it('事件迴圈丟錯時走 onError，且 teardown 仍然 resolve', async () => {
    const fq = createFakeQuery()
    const errors: Error[] = []
    const broken: QueryHandle = {
      ...fq.handle,
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('串流中斷')),
      }),
    }
    const host = createAgentHost({
      queryFn: () => broken,
      sessionOptions: () => OPTIONS,
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: () => {},
      onError: (e) => errors.push(e),
      onEnded: () => {},
    })
    host.start()
    await host.teardown()
    expect(errors.map((e) => e.message).join()).toMatch(/串流中斷/)
  })

  it('裁決 17：事件流中斷合成一筆 isError 的 session-end，走同一條 events 通道', async () => {
    const batches: (readonly Event[])[] = []
    const errors: Error[] = []
    let ended = 0
    const broken: QueryHandle = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('SDK 程序不見了')),
      }),
      interrupt: () => Promise.resolve(),
      close: () => {},
    }
    const host = createAgentHost({
      queryFn: () => broken,
      sessionOptions: () => OPTIONS,
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: (b) => batches.push(b),
      onError: (e) => errors.push(e),
      onEnded: () => {
        ended += 1
      },
    })
    host.start()
    await new Promise((r) => setTimeout(r, 0))

    const ends = batches.flat().filter((e) => e.kind === 'session-end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ isError: true, errorMessage: 'SDK 程序不見了' })
    // 錯誤仍然走 onError（不靜默），狀態機仍然收得到 onEnded（照常回 idle）
    expect(errors.map((e) => e.message).join()).toMatch(/SDK 程序不見了/)
    expect(ended).toBe(1)
    await host.teardown()
  })

  it('裁決 20：sessionOptions 組不出來時不開 query，合成 session-end 走錯誤卡片', () => {
    const batches: (readonly Event[])[] = []
    const errors: Error[] = []
    let queries = 0
    let ended = 0
    const host = createAgentHost({
      queryFn: () => {
        queries += 1
        throw new Error('不該開得成 query')
      },
      sessionOptions: () => {
        throw new Error('projectDir 不存在：/gone')
      },
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: (b) => batches.push(b),
      onError: (e) => errors.push(e),
      onEnded: () => {
        ended += 1
      },
    })
    host.start('s-gone')

    expect(queries).toBe(0)
    expect(batches).toHaveLength(1)
    const only = batches[0] ?? []
    expect(only).toHaveLength(1)
    const end = only[0]
    expect(end?.kind).toBe('session-end')
    expect(end && end.kind === 'session-end' && end.isError).toBe(true)
    expect(end && end.kind === 'session-end' && end.errorMessage).toContain('不存在')
    expect(errors.map((e) => e.message).join()).toMatch(/不存在/)
    expect(ended).toBe(1)
  })

  it('close 丟錯時回報但不影響 teardown 完成', async () => {
    const fq = createFakeQuery()
    const errors: Error[] = []
    const host = createAgentHost({
      queryFn: () => ({
        ...fq.handle,
        close: () => {
          fq.end()
          throw new Error('close 爆炸')
        },
      }),
      sessionOptions: () => OPTIONS,
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: () => {},
      onError: (e) => errors.push(e),
      onEnded: () => {},
    })
    host.start()
    await host.teardown()
    expect(errors.map((e) => e.message).join()).toMatch(/close 爆炸/)
  })
})
```

- [ ] **Step 1d: 寫失敗的測試（bridge 的 effects 執行順序，裁決 6）**

`tests/ipc-bridge.test.ts`。這份測試只問一件事：**effects 有沒有照 Task 5 給的順序被執行**。
所以假的 host、假的註冊表、假的 sessionStore 全部把呼叫寫進同一個 `calls` 陣列，斷言就是
對那個陣列做 `toEqual`。用 `toEqual` 而不是 `toContain` 是刻意的：少一步、多一步、順序對調
三種壞法都要抓得到。

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `ipc-bridge.ts` import electron 與 SDK，兩者在 node 環境都載不起來，所以換成替身。
 * 要驗的是裁決 6 的接線，不是 Electron 本身，替身只要記錄呼叫就夠。
 */
const listeners = new Map<string, (...args: unknown[]) => void>()
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => void) => {
      listeners.set(channel, fn)
    },
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
    removeListener: (channel: string) => {
      listeners.delete(channel)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    },
  },
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw new Error('測試不該走到真的 SDK')
  },
}))

import { createIpcBridge, type SessionSource } from '../src/main/ipc-bridge.js'
import { IPC } from '../src/shared/ipc.js'
import type { Event } from '../src/shared/events.js'
import type { AgentHost, AgentHostDeps } from '../src/main/agent-host.js'
import { createApprovalRegistry } from '../src/main/approval.js'
import type { SessionOptions } from '../src/main/session-args.js'

const OPTIONS: SessionOptions = {
  cwd: '/p',
  permissionMode: 'default',
  includePartialMessages: true,
}
const HISTORY: readonly Event[] = [
  { kind: 'user-text', text: '舊的問題' },
  { kind: 'session-end', isError: false },
]

interface Rig {
  readonly calls: string[]
  readonly sent: { channel: string; payload: unknown }[]
  readonly errors: Error[]
  readonly bridge: { dispose(): Promise<void> }
  readonly hostDeps: () => AgentHostDeps
  /**
   * 裁決 23：讓某一筆 `loadHistory(sessionId)` 掛著不回，等 `release` 或
   * `failHistory` 才了結。沒有 `defer` 過的 sessionId 照舊立刻回傳。
   * 三個都不要求呼叫順序：先 `release` 再被 `loadHistory` 取用也成立。
   */
  defer(sessionId: string): void
  release(sessionId: string): void
  failHistory(sessionId: string, message: string): void
  fire(channel: string, payload?: unknown): void
}

function setup(): Rig {
  listeners.clear()
  handlers.clear()
  const calls: string[] = []
  const sent: { channel: string; payload: unknown }[] = []
  const errors: Error[] = []
  let hostDeps: AgentHostDeps | null = null

  /**
   * sessionId → 可以從測試外部了結的閘門（裁決 23）。promise 在 `defer()` 當下就建好，
   * 所以「先 release 再被 loadHistory 取用」與反過來都成立，測試不必猜串行的時機。
   */
  interface Gate {
    readonly promise: Promise<readonly Event[]>
    readonly open: () => void
    readonly fail: (error: Error) => void
  }
  const gates = new Map<string, Gate>()
  const gateOf = (sessionId: string): Gate => {
    const existing = gates.get(sessionId)
    if (existing !== undefined) return existing
    let open = (): void => {}
    let fail = (_error: Error): void => {}
    const promise = new Promise<readonly Event[]>((resolve, reject) => {
      open = () => {
        resolve(HISTORY)
      }
      fail = reject
    })
    const created: Gate = { promise, open, fail }
    gates.set(sessionId, created)
    return created
  }

  const fakeHost: AgentHost = {
    start: (resume, initial) => {
      calls.push(`start(${resume ?? '-'},${initial ?? '-'})`)
    },
    send: (text) => {
      calls.push(`send(${text})`)
      return true
    },
    interrupt: () => {
      calls.push('interrupt')
      return Promise.resolve()
    },
    teardown: () => {
      calls.push('teardown')
      return Promise.resolve()
    },
  }

  const sessions: SessionSource = {
    list: () => Promise.resolve([]),
    loadHistory: (id: string) => {
      calls.push(`loadHistory(${id})`)
      const gate = gates.get(id)
      return gate === undefined ? Promise.resolve(HISTORY) : gate.promise
    },
  }

  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload })
      if (channel === IPC.sessionState) calls.push('send(session:state)')
      // 裁決 22：reset 要驗它排在 host.start 之前、排在歷史事件最前面，
      // 所以事件批次也記進同一個 calls 陣列，順序才看得出來。
      if (channel === IPC.eventsBatch) {
        calls.push(`events(${(payload as readonly Event[]).map((e) => e.kind).join(',')})`)
      }
    },
  }

  const bridge = createIpcBridge({
    webContents: webContents as never,
    sessionOptions: () => OPTIONS,
    sessions,
    logError: (e) => errors.push(e),
    createHost: (deps) => {
      hostDeps = deps
      return fakeHost
    },
    // 真的註冊表包一層，只為了把 denyAll 記進 calls：時序要跟真品一致。
    createRegistry: (opts) => {
      const real = createApprovalRegistry(opts)
      return {
        ...real,
        denyAll: (reason) => {
          calls.push(`denyAll(${reason})`)
          real.denyAll(reason)
        },
      }
    },
  })

  return {
    calls,
    sent,
    errors,
    bridge,
    hostDeps: () => {
      if (hostDeps === null) throw new Error('host 尚未建立')
      return hostDeps
    },
    defer: (sessionId) => {
      gateOf(sessionId)
    },
    release: (sessionId) => {
      gateOf(sessionId).open()
    },
    failHistory: (sessionId, message) => {
      gateOf(sessionId).fail(new Error(message))
    },
    fire: (channel, payload) => {
      const fn = listeners.get(channel)
      if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
      fn({}, payload)
    },
  }
}

/** effects 是 async 的，斷言前要讓已排定的工作跑完。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  listeners.clear()
  handlers.clear()
})
```

（測試本體接下去，同一個檔案）

```typescript
describe('裁決 6：bridge 持有狀態機，照 effects 陣列順序執行', () => {
  it('live 狀態下的 intentOpenHistory：denyAll → interrupt → teardown → loadHistory → 推狀態', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()
    rig.calls.length = 0

    rig.fire(IPC.intentOpenHistory, { sessionId: 's-2' })
    await settle()

    expect(rig.calls).toEqual([
      'denyAll(切換 session)',
      'interrupt',
      'teardown',
      'loadHistory(s-2)',
      'events(reset,user-text,session-end)',
      'send(session:state)',
    ])
  })

  it('deny-all-approvals 排在 interrupt 之前：待決的批准先收到 deny', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()

    // 開一筆待決批准：registry.request 會同步呼叫 sendRequest 送到 renderer。
    const pending = rig.hostDeps().requestApproval({
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'toolu_ls',
      title: 'Claude 想執行 ls',
    })
    rig.calls.length = 0

    rig.fire(IPC.intentOpenHistory, { sessionId: 's-2' })
    const outcome = await pending
    expect(outcome.decision).toBe('deny')
    expect(outcome.reason).toBe('切換 session')
    expect(rig.calls[0]).toBe('denyAll(切換 session)')
    await settle()
    expect(rig.calls).toEqual([
      'denyAll(切換 session)',
      'interrupt',
      'teardown',
      'loadHistory(s-2)',
      'events(reset,user-text,session-end)',
      'send(session:state)',
    ])
  })

  it('viewing 狀態下的 intentStartNew：start 之後才推狀態，且不做收尾', async () => {
    const rig = setup()
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-1' })
    await settle()
    rig.calls.length = 0

    rig.fire(IPC.intentStartNew)
    await settle()

    expect(rig.calls).toEqual(['events(reset)', 'start(-,-)', 'send(session:state)'])
  })

  it('viewing 狀態下的 userInput：開新 query 並以該 sessionId resume', async () => {
    const rig = setup()
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-old' })
    await settle()
    rig.calls.length = 0

    rig.fire(IPC.userInput, '接著問')
    await settle()

    expect(rig.calls).toEqual(['start(s-old,接著問)', 'send(session:state)'])
    // 不得再走 host.send()：那則輸入已經由 start 的 initialInput 送出去了。
    expect(rig.calls).not.toContain('send(接著問)')
  })

  it('live 狀態下的 userInput 直接進既有 query，不重開', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()
    rig.calls.length = 0

    rig.fire(IPC.userInput, '繼續')
    await settle()

    expect(rig.calls.filter((c) => c.startsWith('start('))).toEqual([])
    expect(rig.calls).toContain('send(繼續)')
  })

  it('推給 renderer 的是 SessionState 物件（裁決 14），不是字串', async () => {
    const rig = setup()
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-1' })
    await settle()

    const states = rig.sent.filter((s) => s.channel === IPC.sessionState).map((s) => s.payload)
    expect(states).toEqual([{ kind: 'viewing', sessionId: 's-1' }])
  })

  it('query 自然結束時 host 回報 onEnded，狀態回到 idle', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()
    rig.calls.length = 0

    rig.hostDeps().onEnded()
    await settle()

    const states = rig.sent.filter((s) => s.channel === IPC.sessionState).map((s) => s.payload)
    expect(states.at(-1)).toEqual({ kind: 'idle' })
    expect(rig.calls).toEqual(['send(session:state)'])
  })

  it('dispose 走 window-closed 的三步收尾', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()
    rig.calls.length = 0

    await rig.bridge.dispose()

    expect(rig.calls).toEqual(['denyAll(視窗已關閉)', 'interrupt', 'teardown'])
  })

  it('壞掉的 intentOpenHistory payload 被丟棄，不改變狀態也不丟例外', async () => {
    const rig = setup()
    rig.fire(IPC.intentOpenHistory, { sessionId: '' })
    await settle()

    expect(rig.calls).toEqual([])
    expect(rig.errors.map((e) => e.message).join()).toMatch(/payload 形狀不符/)
  })
})

describe('裁決 11／16／28：approvalAsk 帶上 SDK 的 toolUseId、title 與 displayName', () => {
  it('meta 進得了送給 renderer 的 payload', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()

    void rig.hostDeps().requestApproval({
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'toolu_ls',
      title: 'Claude 想執行 ls',
      displayName: '執行指令',
    })

    const ask = rig.sent.find((s) => s.channel === IPC.approvalAsk)
    expect(ask?.payload).toMatchObject({
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'toolu_ls',
      title: 'Claude 想執行 ls',
      displayName: '執行指令',
    })
    await rig.bridge.dispose()
  })

  it('兩筆請求各自帶自己的 meta，不互相污染（裁決 16：ask 是一個物件）', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()
    const deps = rig.hostDeps()

    void deps.requestApproval({ toolName: 'Bash', input: {}, toolUseId: 'toolu_a', title: '第一筆' })
    void deps.requestApproval({ toolName: 'Read', input: {}, toolUseId: 'toolu_b' })

    const asks = rig.sent
      .filter((s) => s.channel === IPC.approvalAsk)
      .map((s) => s.payload as { toolName: string; toolUseId: string; title?: string })
    expect(asks).toHaveLength(2)
    expect(asks.map((a) => a.toolUseId)).toEqual(['toolu_a', 'toolu_b'])
    expect(asks[0]?.title).toBe('第一筆')
    expect(asks[1]?.title).toBeUndefined()
    await rig.bridge.dispose()
  })
})

/**
 * 規格 §9 的四種結果，這裡驗前兩種走完整條 IPC：`canUseTool` 側的 promise 收到
 * 的值就是 renderer 按下去的那個決定。逾時與 deny-all 由 Task 6 的註冊表測試守著
 * （`tests/approval.test.ts`），這裡不重複。
 */
describe('批准的端對端：renderer 的回覆送得回 canUseTool', () => {
  /** 送出一筆批准請求，回傳它的 requestId 與掛著的 promise。 */
  const askOnce = (rig: Rig): { requestId: string; outcome: Promise<{ decision: string; reason?: string }> } => {
    const outcome = rig.hostDeps().requestApproval({
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'toolu_ls',
    })
    const sent = rig.sent.find((s) => s.channel === IPC.approvalAsk)
    const requestId = (sent?.payload as { requestId: string }).requestId
    return { requestId, outcome }
  }

  it('回 allow：requestApproval 的 promise resolve 成 allow', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()
    const { requestId, outcome } = askOnce(rig)

    rig.fire(IPC.approvalReply, { requestId, decision: 'allow' })

    expect(await outcome).toEqual({ decision: 'allow' })
    expect(rig.errors).toEqual([])
    await rig.bridge.dispose()
  })

  it('回 deny：resolve 成 deny，reason 由註冊表決定（這一路沒有人塞理由，所以沒有 reason）', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()
    const { requestId, outcome } = askOnce(rig)

    rig.fire(IPC.approvalReply, { requestId, decision: 'deny' })

    // Task 6 的 `reply()` 走 `settle(requestId, { decision })`，沒有 reason 欄位；
    // 有 reason 的是逾時、送不出去與 denyAll 那三條路。
    expect(await outcome).toEqual({ decision: 'deny' })
    expect(rig.errors).toEqual([])
    await rig.bridge.dispose()
  })

  it('找不到 requestId（已逾時或已 denyAll）只記錄，不丟例外', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()

    rig.fire(IPC.approvalReply, { requestId: 'r-不存在', decision: 'allow' })

    expect(rig.errors.map((e) => e.message).join()).toMatch(/找不到 r-不存在/)
    await rig.bridge.dispose()
  })

  it('壞掉的 approvalReply payload 被丟棄', async () => {
    const rig = setup()
    rig.fire(IPC.approvalReply, { requestId: 1 })
    expect(rig.errors.map((e) => e.message).join()).toMatch(/payload 形狀不符/)
  })
})

describe('裁決 22：畫面何時清空由事件流裡的 reset 決定', () => {
  it('intentStartNew 推的第一個批次是 [reset]，且排在 host.start 之前', async () => {
    const rig = setup()
    rig.fire(IPC.intentStartNew)
    await settle()

    const batches = rig.sent.filter((s) => s.channel === IPC.eventsBatch).map((s) => s.payload)
    expect(batches[0]).toEqual([{ kind: 'reset' }])
    expect(rig.calls).toEqual(['events(reset)', 'start(-,-)', 'send(session:state)'])
  })

  it('intentOpenHistory 推的第一批第一筆是 reset，緊接著才是歷史事件', async () => {
    const rig = setup()
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-1' })
    await settle()

    const batches = rig.sent
      .filter((s) => s.channel === IPC.eventsBatch)
      .map((s) => s.payload as readonly Event[])
    expect(batches[0]).toEqual([{ kind: 'reset' }, ...HISTORY])
  })

  it('viewing 的輸入走 resume，不推 reset：歷史要留在畫面上', async () => {
    const rig = setup()
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-old' })
    await settle()
    rig.sent.length = 0
    rig.calls.length = 0

    rig.fire(IPC.userInput, '接著問')
    await settle()

    expect(rig.sent.filter((s) => s.channel === IPC.eventsBatch)).toEqual([])
    expect(rig.calls).toEqual(['start(s-old,接著問)', 'send(session:state)'])
  })
})

describe('裁決 23：dispatch 的 effects 跨 action 串行', () => {
  it('連點兩筆 Recents：後到的先 resolve 也不會插隊，最後推的是後點的那一場', async () => {
    const rig = setup()
    rig.defer('s-1')
    rig.defer('s-2')

    rig.fire(IPC.intentOpenHistory, { sessionId: 's-1' })
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-2' })
    await settle()
    // s-1 還掛著，s-2 的 loadHistory 連叫都還沒叫
    expect(rig.calls).toEqual(['loadHistory(s-1)'])

    rig.release('s-2') // 後到的先放行
    await settle()
    expect(rig.calls).toEqual(['loadHistory(s-1)'])

    rig.release('s-1')
    await settle()

    expect(rig.calls).toEqual([
      'loadHistory(s-1)',
      'events(reset,user-text,session-end)',
      'send(session:state)',
      'loadHistory(s-2)',
      'events(reset,user-text,session-end)',
      'send(session:state)',
    ])
    const states = rig.sent.filter((s) => s.channel === IPC.sessionState).map((s) => s.payload)
    expect(states.at(-1)).toEqual({ kind: 'viewing', sessionId: 's-2' })
  })

  it('前一個 action 的 effect 失敗只記錄，後面的 action 照常執行並推狀態', async () => {
    const rig = setup()
    rig.defer('s-bad')
    rig.defer('s-good')

    rig.fire(IPC.intentOpenHistory, { sessionId: 's-bad' })
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-good' })
    await settle()

    rig.failHistory('s-bad', '讀取歷史對話 s-bad 失敗')
    await settle()
    rig.release('s-good')
    await settle()

    expect(rig.errors.map((e) => e.message).join()).toMatch(/effects\(open-history\)/)
    expect(rig.calls).toEqual([
      'loadHistory(s-bad)',
      'send(session:state)',
      'loadHistory(s-good)',
      'events(reset,user-text,session-end)',
      'send(session:state)',
    ])
    const states = rig.sent.filter((s) => s.channel === IPC.sessionState).map((s) => s.payload)
    expect(states.at(-1)).toEqual({ kind: 'viewing', sessionId: 's-good' })
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/agent-host.test.ts tests/ipc.test.ts tests/ipc-bridge.test.ts`
Expected: FAIL，無法解析 `../src/main/agent-host.js` 與 `../src/main/ipc-bridge.js`；
`src/shared/ipc.ts` 沒有那些 `parseX` 匯出。

- [ ] **Step 3: 改寫 `src/shared/ipc.ts`**

```typescript
import type { Event } from './events.js'
import type { SessionState } from './session-state.js'

/**
 * IPC 頻道。名稱與 CONTRACT.md 逐字一致，改名等於改契約。
 */
export const IPC = {
  /** main → renderer：合併後的 Event 批次 */
  eventsBatch: 'agent:events',
  /** renderer → main：使用者輸入（字串） */
  userInput: 'agent:input',
  /** main → renderer：批准請求 */
  approvalAsk: 'agent:approval:ask',
  /** renderer → main：批准回覆 */
  approvalReply: 'agent:approval:reply',
  /** renderer → main（invoke）：歷史對話清單 */
  sessionList: 'session:list',
  /** main → renderer：session 狀態（SessionState 物件，裁決 14） */
  sessionState: 'session:state',
  /** renderer → main：開一條全新對話。無 payload（裁決 6） */
  intentStartNew: 'session:intent:start-new',
  /** renderer → main：開啟一條歷史對話（裁決 6） */
  intentOpenHistory: 'session:intent:open-history',
} as const

/**
 * 裁決 21：左窗格的 preload 靠 `webPreferences.additionalArguments` 拿
 * `YESCHEF_PROJECT_DIR`，旗標名放在這裡，`index.ts` 與 `bridge.ts` 都 import 它。
 * 不開一條 invoke 頻道的理由：這是啟動時就固定的一個字串。
 */
export const PROJECT_DIR_ARG = '--yeschef-project-dir='

export type ApprovalDecision = 'allow' | 'deny'
export type Unsubscribe = () => void

/**
 * 與 Task 6 的 `ApprovalRequest` 逐欄位相同（加上裁決 11 的兩個選填欄位與裁決 28 的
 * `toolUseId`）。ipc-bridge 用一次型別標註的賦值來確保兩者不漂移（裁決 8）。
 */
export interface ApprovalAskPayload {
  readonly requestId: string
  /** SDK `CanUseTool` options 的 `toolUseID`。renderer 靠它找到對應的 tool block（裁決 28） */
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
  /** SDK 產的完整提示句，官方建議優先用它（裁決 11） */
  readonly title?: string
  /** 短名詞片語，適合按鈕標籤（裁決 11） */
  readonly displayName?: string
}

export interface ApprovalReplyPayload {
  readonly requestId: string
  readonly decision: ApprovalDecision
}

export interface IntentOpenHistoryPayload {
  readonly sessionId: string
}

/**
 * 歷史對話摘要（裁決 7 的六個欄位）。刻意是本專案自訂的窄型別，
 * 不是 SDK 的 `SDKSessionInfo`：SDK 型別不該穿過 IPC 進到 renderer，
 * 欄位會隨版本增減，而 renderer 沒有東西擋。
 */
export interface SessionSummary {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly gitBranch?: string
}

/** 單則輸入的長度上限。整份檔案貼進輸入框時擋住，避免一次序列化幾十 MB。 */
export const MAX_INPUT_LENGTH = 100_000

/**
 * preload 透過 contextBridge 曝露給 renderer 的 `window.yeschef` 形狀。
 * 三個 `on*` 回傳解除訂閱的函式：React 的 effect 清理需要它，
 * 而且**回傳我們自己的閉包**可以杜絕「不小心把 ipcRenderer 回傳出去」那條路。
 */
export interface YesChefApi {
  onEvents(cb: (events: readonly Event[]) => void): Unsubscribe
  onApprovalAsk(cb: (request: ApprovalAskPayload) => void): Unsubscribe
  onSessionState(cb: (state: SessionState) => void): Unsubscribe
  sendInput(text: string): void
  replyApproval(reply: ApprovalReplyPayload): void
  listSessions(): Promise<readonly SessionSummary[]>
  startNew(): void                      // → IPC.intentStartNew
  openHistory(sessionId: string): void  // → IPC.intentOpenHistory
  /** 標題列要顯示的啟動目錄。純字串不是函式，preload 從 process.argv 取（裁決 21）。 */
  readonly projectDir: string           // 裁決 21
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * 以下每個 parse 函式都是 IPC 進 main 時的執行期驗證。
 *
 * renderer 是我們自己的程式碼，但它跑在另一個程序：可能是重新載入前的舊 bundle、
 * 可能被 DevTools 手動 send、也可能是 preload 版本與 main 版本對不上。上一個分支
 * 就出過 handler 標了 `(data: string)` 但執行期收到物件，主程序拋未捕捉例外。
 * 型別標註在執行期不存在，所以入口一定要有真的檢查。
 *
 * 一律回傳**新造的物件**，不把外來物件直接放行，額外欄位在這裡被切掉。
 */
export function parseUserInput(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (v.length === 0 || v.length > MAX_INPUT_LENGTH) return null
  return v
}

export function parseApprovalReply(v: unknown): ApprovalReplyPayload | null {
  if (!isRecord(v)) return null
  const decision = v.decision
  if (!isNonEmptyString(v.requestId)) return null
  if (decision !== 'allow' && decision !== 'deny') return null
  return { requestId: v.requestId, decision }
}

export function parseIntentOpenHistory(v: unknown): IntentOpenHistoryPayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.sessionId)) return null
  return { sessionId: v.sessionId }
}

/**
 * `title`／`displayName` 是裁決 11 加的，型別不符時整筆回 null 而不是丟掉那個欄位：
 * 悄悄丟掉會讓 UI 退回「工具名稱加 input」而沒有人知道為什麼。
 *
 * `toolUseId` 是裁決 28 加的，必填。它缺席時 renderer 找不到對應的 tool block，
 * 卡片會畫在對話尾端；讓這種 payload 通過等於把一個看得見的錯誤變成看不見的錯位。
 */
export function parseApprovalAsk(v: unknown): ApprovalAskPayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.requestId)) return null
  if (!isNonEmptyString(v.toolUseId)) return null
  if (!isNonEmptyString(v.toolName)) return null
  if (v.title !== undefined && typeof v.title !== 'string') return null
  if (v.displayName !== undefined && typeof v.displayName !== 'string') return null
  const title = optionalString(v.title)
  const displayName = optionalString(v.displayName)
  return {
    requestId: v.requestId,
    toolUseId: v.toolUseId,
    toolName: v.toolName,
    input: v.input,
    ...(title === undefined ? {} : { title }),
    ...(displayName === undefined ? {} : { displayName }),
  }
}

/**
 * 批次只做淺檢查：確認是非空陣列、每筆都是帶 `kind` 字串的物件。
 * 不逐一比對 `Event` 的每個變體，那份判斷屬於 Task 3 的正規化層，
 * 在這裡重寫一份只會多出一個會漂移的真相來源。
 */
export function parseEventsBatch(v: unknown): readonly Event[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  for (const item of v) {
    if (!isRecord(item)) return null
    if (!isNonEmptyString(item.kind)) return null
  }
  return v as readonly Event[]
}

/**
 * 裁決 14：`session:state` 送的是 `SessionState` 物件，不是字串。
 * `viewing` 必有非空 `sessionId`（Recents 要靠它標出目前選中的那一筆）；
 * `live` 的 `sessionId` 可以省略，因為 SDK 要吐出第一則訊息之後才知道 id。
 * 一律回新造的物件，額外欄位在這裡被切掉。
 */
export function parseSessionState(v: unknown): SessionState | null {
  if (!isRecord(v)) return null
  if (v.kind === 'idle') return { kind: 'idle' }
  if (v.kind === 'viewing') {
    if (!isNonEmptyString(v.sessionId)) return null
    return { kind: 'viewing', sessionId: v.sessionId }
  }
  if (v.kind === 'live') {
    if (v.sessionId === undefined) return { kind: 'live' }
    if (!isNonEmptyString(v.sessionId)) return null
    return { kind: 'live', sessionId: v.sessionId }
  }
  return null
}

export function parseSessionSummaries(v: unknown): readonly SessionSummary[] | null {
  if (!Array.isArray(v)) return null
  const out: SessionSummary[] = []
  for (const item of v) {
    if (!isRecord(item)) return null
    if (!isNonEmptyString(item.sessionId)) return null
    if (typeof item.summary !== 'string') return null
    if (typeof item.lastModified !== 'number' || !Number.isFinite(item.lastModified)) return null
    if (item.cwd !== undefined && typeof item.cwd !== 'string') return null
    if (item.customTitle !== undefined && typeof item.customTitle !== 'string') return null
    if (item.gitBranch !== undefined && typeof item.gitBranch !== 'string') return null
    const cwd = optionalString(item.cwd)
    const customTitle = optionalString(item.customTitle)
    const gitBranch = optionalString(item.gitBranch)
    out.push({
      sessionId: item.sessionId,
      summary: item.summary,
      lastModified: item.lastModified,
      ...(cwd === undefined ? {} : { cwd }),
      ...(customTitle === undefined ? {} : { customTitle }),
      ...(gitBranch === undefined ? {} : { gitBranch }),
    })
  }
  return out
}
```

- [ ] **Step 3b: 寫 `src/renderer/global.d.ts`（裁決 14）**

```typescript
import type { YesChefApi } from '../shared/ipc.js'

declare global {
  interface Window {
    readonly yeschef: YesChefApi
  }
}
```

`readonly` 是刻意的：renderer 不該有任何程式碼去覆寫 `window.yeschef`，
`contextBridge` 給的那個物件是唯一來源。

- [ ] **Step 4: 寫 `src/main/agent-host.ts`（上半：事件合併）**

```typescript
import { INITIAL_CURSOR, stepLive, type Event, type LiveCursor } from '../shared/events.js'
import type { ApprovalAsk, ApprovalOutcome } from './approval.js'
import type { SessionOptions } from './session-args.js'

// ───────────────────────── 事件合併（純函式） ─────────────────────────

export interface MergeConfig {
  /** 一幀的長度。規格 §3.1 給的方向。 */
  readonly frameMs: number
  /**
   * 單一批次的事件數上限。
   *
   * 逐字串流的正常速率下一幀只有一兩筆，這個上限碰不到。它擋的是三種爆量情況：
   * 工具結果一次回填、compact 切點一次吐出整段歷史、歷史對話重播。沒有上限時
   * 一次 `webContents.send` 要序列化整包，renderer 收到後一次 fold 全量，畫面停住。
   *
   * 超過上限的處理是**在同一次呼叫內切成滿批送出**，不是丟掉、也不是壓到下一幀。
   * 所以這個上限只影響「一次 send 多大」，不影響事件何時到、以什麼順序到。
   */
  readonly maxBatchSize: number
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = { frameMs: 16, maxBatchSize: 128 }

export interface MergeState {
  readonly pending: readonly Event[]
  /** 這一幀的起點。null 表示沒有待送事件。 */
  readonly frameStartedAt: number | null
}

export const INITIAL_MERGE_STATE: MergeState = { pending: [], frameStartedAt: null }

export interface MergeStep {
  readonly state: MergeState
  /** 這一步要送出的批次，依序送。永遠不含空批次。 */
  readonly batches: readonly (readonly Event[])[]
}

const NO_BATCHES: readonly (readonly Event[])[] = []

function configOf(config?: MergeConfig): MergeConfig {
  return config ?? DEFAULT_MERGE_CONFIG
}

/**
 * 收下新事件。
 *
 * 不變量：回傳的 `state.pending.length` 永遠小於 `maxBatchSize`。
 * 不變量：`batches` 串接起來再接上 `state.pending`，等於舊的 pending 接上 incoming。
 */
export function mergeAccept(
  state: MergeState,
  incoming: readonly Event[],
  now: number,
  config?: MergeConfig
): MergeStep {
  if (incoming.length === 0) return { state, batches: NO_BATCHES }

  const cfg = configOf(config)
  const all = [...state.pending, ...incoming]
  const fullCount = Math.floor(all.length / cfg.maxBatchSize)
  const batches: (readonly Event[])[] = []
  for (let i = 0; i < fullCount; i += 1) {
    batches.push(all.slice(i * cfg.maxBatchSize, (i + 1) * cfg.maxBatchSize))
  }
  const rest = all.slice(fullCount * cfg.maxBatchSize)

  if (rest.length === 0) return { state: INITIAL_MERGE_STATE, batches }

  // 已經開著的幀不因為新事件而延後截止：起點只在幀是新開的、或剛切完滿批時重設。
  const frameStartedAt = batches.length === 0 && state.frameStartedAt !== null ? state.frameStartedAt : now
  return { state: { pending: rest, frameStartedAt }, batches }
}

/** 幀到期就把 pending 整包送出。未到期或沒有 pending 時是 no-op。 */
export function mergeTick(state: MergeState, now: number, config?: MergeConfig): MergeStep {
  const wakeAt = mergeWakeAt(state, config)
  if (wakeAt === null || now < wakeAt) return { state, batches: NO_BATCHES }
  return { state: INITIAL_MERGE_STATE, batches: [state.pending] }
}

/** 不管幀有沒有到期，立刻送完。收尾時用，確保緩衝裡的事件不被吞掉。 */
export function mergeFlush(state: MergeState): MergeStep {
  if (state.pending.length === 0) return { state, batches: NO_BATCHES }
  return { state: INITIAL_MERGE_STATE, batches: [state.pending] }
}

/** 這一幀的絕對截止時間。合併器外層用它算 setTimeout 的延遲，純函式本身不碰計時器。 */
export function mergeWakeAt(state: MergeState, config?: MergeConfig): number | null {
  if (state.frameStartedAt === null || state.pending.length === 0) return null
  return state.frameStartedAt + configOf(config).frameMs
}

// ───────────────────────── 合併器外層（有狀態） ─────────────────────────

export interface MergerClock {
  readonly now: () => number
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
}

export const SYSTEM_CLOCK: MergerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface EventMerger {
  accept(events: readonly Event[]): void
  flush(): void
  dispose(): void
}

export interface EventMergerOptions {
  readonly onBatch: (events: readonly Event[]) => void
  readonly config?: MergeConfig
  readonly clock?: MergerClock
}

/**
 * 把純函式的合併規則接上真實計時器。時鐘可注入，所以測試不必動用 fake timers。
 */
export function createEventMerger(options: EventMergerOptions): EventMerger {
  const cfg = configOf(options.config)
  const clock = options.clock ?? SYSTEM_CLOCK
  let state: MergeState = INITIAL_MERGE_STATE
  let timer: unknown = null
  let disposed = false

  const cancelTimer = (): void => {
    if (timer === null) return
    clock.clearTimer(timer)
    timer = null
  }

  const apply = (step: MergeStep): void => {
    state = step.state
    for (const batch of step.batches) options.onBatch(batch)
    cancelTimer()
    const wakeAt = mergeWakeAt(state, cfg)
    if (wakeAt === null || disposed) return
    timer = clock.setTimer(onTimer, Math.max(0, wakeAt - clock.now()))
  }

  function onTimer(): void {
    timer = null
    if (disposed) return
    apply(mergeTick(state, clock.now(), cfg))
  }

  return {
    accept: (events) => {
      if (disposed) return
      apply(mergeAccept(state, events, clock.now(), cfg))
    },
    flush: () => {
      if (disposed) return
      apply(mergeFlush(state))
    },
    dispose: () => {
      disposed = true
      cancelTimer()
    },
  }
}
```

- [ ] **Step 4（續）: 寫 `src/main/agent-host.ts`（下半：SDK 宿主）**

```typescript
// ───────────────────────── SDK 的窄化型別 ─────────────────────────

/**
 * `query()` 回傳值中我們真正用到的部分。
 *
 * 刻意不 import SDK 的 `Query`：這裡是與 SDK 交接的地方，跟 Task 3 的正規化層同一個理由。
 * 窄化到三件事（迭代、interrupt、close）之後，SDK 版本變動的衝擊面就只有
 * `ipc-bridge.ts` 裡那一行轉接，而且那一行有型別檢查擋著。
 */
export interface QueryHandle extends AsyncIterable<unknown> {
  /**
   * 回傳型別刻意是 `Promise<unknown>`：SDK 0.3.258 的 `Query.interrupt()` 回的是
   * `Promise<SDKControlInterruptResponse | undefined>`，標成 `Promise<void>` 會讓
   * `ipc-bridge.ts` 的 `defaultQueryFn` 那一行過不了 typecheck（worktree 實測）。
   * 我們不看這個回傳值。
   */
  interrupt(): Promise<unknown>
  close(): void
}

/** 送進 prompt 串流的一則使用者輸入。欄位對齊 SDK 的 `SDKUserMessage`。 */
export interface UserTurn {
  readonly type: 'user'
  readonly message: { readonly role: 'user'; readonly content: string }
  readonly parent_tool_use_id: null
}

export type SdkPermissionResult =
  | { readonly behavior: 'allow'; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string }

/**
 * SDK 的 `CanUseTool` options 裡我們真正用到的三個欄位（裁決 11／28）。
 * 已查證：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（0.3.258）
 * 第 209 行宣告 `CanUseTool`，第 233 行是 `title?: string`、第 238 行是
 * `displayName?: string`、第 248 行是**必填**的 `toolUseID: string`。
 * 裁決 11 當時誤判為「沒有 tool_use_id」而改用內容比對，裁決 28 已把它作廢。
 *
 * 只宣告這三個欄位是刻意的：函式參數是逆變位置，SDK 那個更寬的
 * options（含必填的 `signal`）仍然指派得進來，而我們不必跟著它的其他欄位走。
 * 欄位名與 Task 6 的 `ApprovalAsk` 對齊（`toolUseID` 是 SDK 的拼法，我們的
 * 欄位叫 `toolUseId`），`canUseTool` 只要補上 `toolName` 與 `input` 就是一個
 * 完整的 ask（裁決 16）。
 */
export interface CanUseToolOptions {
  readonly toolUseID: string
  readonly title?: string
  readonly displayName?: string
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions
) => Promise<SdkPermissionResult>

export type QueryFn = (params: {
  readonly prompt: AsyncIterable<UserTurn>
  readonly options: SessionOptions & { readonly canUseTool: CanUseToolFn }
}) => QueryHandle

/** Task 6 的 `ApprovalOutcome` → SDK 的 `PermissionResult`。 */
export function toPermissionResult(
  outcome: ApprovalOutcome,
  input: Record<string, unknown>
): SdkPermissionResult {
  if (outcome.decision === 'allow') return { behavior: 'allow', updatedInput: input }
  return { behavior: 'deny', message: outcome.reason ?? '使用者拒絕' }
}

// ───────────────────────── 輸入佇列 ─────────────────────────

interface InputQueue {
  push(turn: UserTurn): boolean
  close(): void
  readonly stream: AsyncIterable<UserTurn>
}

/**
 * `prompt` 必須是 AsyncIterable 而不能是字串：`interrupt()` 是控制請求，
 * SDK 只在 streaming input 模式下支援。這個佇列就是那個串流。
 * 只有 SDK 一個讀取端，所以只需要一個等待中的 resolver。
 */
function createInputQueue(): InputQueue {
  const buffered: UserTurn[] = []
  let waiting: ((r: IteratorResult<UserTurn>) => void) | null = null
  let closed = false

  return {
    push: (turn) => {
      if (closed) return false
      const w = waiting
      if (w) {
        waiting = null
        w({ value: turn, done: false })
        return true
      }
      buffered.push(turn)
      return true
    },
    close: () => {
      if (closed) return
      closed = true
      const w = waiting
      if (w) {
        waiting = null
        w({ value: undefined, done: true })
      }
    },
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const head = buffered.shift()
          if (head !== undefined) return Promise.resolve({ value: head, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise<IteratorResult<UserTurn>>((resolve) => {
            waiting = resolve
          })
        },
      }),
    },
  }
}

// ───────────────────────── 宿主 ─────────────────────────

export interface AgentHostDeps {
  readonly queryFn: QueryFn
  /** 包住 `buildSessionOptions()`（Task 1）；resume 目標由 `start()` 傳入。 */
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  /** 接 Task 6 的 `registry.request(ask)`（裁決 16：一個物件，含 title／displayName）。 */
  readonly requestApproval: (ask: ApprovalAsk) => Promise<ApprovalOutcome>
  readonly onBatch: (events: readonly Event[]) => void
  readonly onError: (error: Error) => void
  /** query 自己走完時通知呼叫端（裁決 6：bridge 據此送 `session-ended` action）。 */
  readonly onEnded: () => void
  readonly merge?: MergeConfig
  readonly clock?: MergerClock
}

/**
 * 裁決 6 之後 host 是**長生命週期**物件：建構不開 query，`start()` 才開，
 * `teardown()` 之後還可以再 `start()`。
 *
 * 初稿是「建構即開 query」，那是因為當時 bridge 靠反推生命週期，換 session 就整個
 * 重建 host。狀態機搬進 main 之後 `start-query` 變成一個 effect，effect 需要的是一個
 * 可以重複開關的把手，不是一次性的建構子。
 */
export interface AgentHost {
  /** 對應 Task 5 的 `start-query` effect。已有活躍 query 時是接線錯誤，回報後忽略。 */
  start(resumeSessionId?: string, initialInput?: string): void
  /** 回傳 false 表示沒有活躍 query，這則輸入沒有被送出。呼叫端要處理，不得忽略。 */
  send(text: string): boolean
  /** 中止進行中的工具，但不收掉 query：之後還可以繼續送輸入。 */
  interrupt(): Promise<void>
  /** 收掉目前的 query。resolve 之後保證不會再有 `onBatch`。可重複呼叫。 */
  teardown(): Promise<void>
}

/** query 收不掉時的最長等待。超過就記錄並放行，不讓視窗關閉卡住。 */
export const TEARDOWN_TIMEOUT_MS = 2_000

/** 把任何丟出來的東西包成帶上下文的 Error。`ipc-bridge` 也用它，所以匯出。 */
export function asError(err: unknown, context: string): Error {
  const detail = err instanceof Error ? err.message : String(err)
  const wrapped = new Error(`${context}：${detail}`)
  if (err instanceof Error && err.stack !== undefined) wrapped.stack = err.stack
  return wrapped
}

function toUserTurn(text: string): UserTurn {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

/** 一條活躍 query 的全部可變狀態。換 session 就整個換掉，不留半條舊的。 */
interface LiveQuery {
  readonly handle: QueryHandle
  readonly input: InputQueue
  readonly merger: EventMerger
  /** 裁決 2：游標一個 query 一份。module 層級不得有可變狀態。 */
  cursor: LiveCursor
  torndown: boolean
  /** 事件迴圈的完成訊號。物件建好之後才填，所以不是 readonly。 */
  settled: Promise<void>
}

export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const clock = deps.clock ?? SYSTEM_CLOCK
  let current: LiveQuery | null = null
  let teardownPromise: Promise<void> | null = null

  const canUseTool: CanUseToolFn = async (toolName, toolInput, options) => {
    try {
      // 裁決 16：整個 ask 一個物件送進去，registry 補 requestId 再原樣轉給 sendRequest。
      // tsconfig 沒開 exactOptionalPropertyTypes，undefined 直接賦給選填欄位即可，
      // 不必條件展開。`toolUseId` 來自 SDK options 的 `toolUseID`（裁決 28），
      // renderer 靠它把卡片掛到對應的 tool block 上。
      const outcome = await deps.requestApproval({
        toolName,
        input: toolInput,
        toolUseId: options.toolUseID,
        title: options.title,
        displayName: options.displayName,
      })
      return toPermissionResult(outcome, toolInput)
    } catch (err) {
      // 批准流程壞掉時往 deny 倒。掛著不回覆會讓整條 query 卡死（規格 §8）。
      deps.onError(asError(err, `工具 ${toolName} 的批准流程失敗`))
      return { behavior: 'deny', message: '批准流程失敗，已拒絕' }
    }
  }

  /** query 自己走完（不是我們收的）：把緩衝送完、關掉合併器，再通知呼叫端。 */
  const finishNaturally = (q: LiveQuery): void => {
    if (q.torndown) return
    q.merger.flush()
    q.merger.dispose()
    if (current === q) current = null
    deps.onEnded()
  }

  /**
   * 事件迴圈。裡面**沒有 break**：唯一的退出方式是生成器自己結束。
   *
   * 中途 break 會隱式呼叫 `query.return()`，那既不中止進行中的工具（工具照樣跑完，
   * 只是沒人收結果），SDK 對 `return()` 的清理程度也不在契約裡。收尾走
   * interrupt → close → 迴圈自然結束 → await 這個 promise。
   */
  const pump = (q: LiveQuery): Promise<void> =>
    (async () => {
      for await (const msg of q.handle) {
        const step = stepLive(msg, q.cursor)
        q.cursor = step.cursor
        q.merger.accept(step.events)
      }
    })().then(
      () => {
        finishNaturally(q)
      },
      (err: unknown) => {
        deps.onError(asError(err, 'SDK 事件流中斷'))
        // 裁決 17 第 3 點：事件流中斷不另設連線狀態 UI，合成一筆 isError 的
        // session-end 走同一條 events 通道，由 fold() 變成對話尾端的錯誤卡片。
        // 走 merger 而不是直接 onBatch，這筆才會排在前面那些事件之後。
        q.merger.accept([
          {
            kind: 'session-end',
            isError: true,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        ])
        finishNaturally(q)
      }
    )

  const waitForPump = (q: LiveQuery): Promise<void> =>
    new Promise((resolve) => {
      let settled = false
      let timeoutHandle: unknown = null
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timeoutHandle !== null) clock.clearTimer(timeoutHandle)
        resolve()
      }
      timeoutHandle = clock.setTimer(() => {
        deps.onError(new Error(`query 未在 ${TEARDOWN_TIMEOUT_MS} 毫秒內結束，強制收尾`))
        finish()
      }, TEARDOWN_TIMEOUT_MS)
      q.settled.then(finish, finish)
    })

  return {
    start: (resumeSessionId, initialInput) => {
      if (current !== null) {
        // 狀態機保證 start-query 之前一定有 teardown-query，走到這裡就是接線錯了。
        deps.onError(new Error('start()：已有活躍 query，先 teardown 才能再開'))
        return
      }
      // 裁決 20：resume 用的是歷史 session 自己的 cwd，那個目錄可能已經被刪掉，
      // 也可能落在 app 自身目錄底下，兩種都會被 Task 1 的守衛擋下來。組不出
      // options 就不開 query，改走裁決 17 的同一條路：合成一筆 isError 的
      // session-end，讓狀態機回 idle、renderer 畫出錯誤卡片，而不是卡在沒有
      // query 的 live。
      let options: SessionOptions
      try {
        options = deps.sessionOptions(resumeSessionId)
      } catch (err) {
        const error = asError(err, '無法組出 session options')
        deps.onError(error)
        // 這裡沒有 merger（query 還沒開），所以直接走 onBatch。
        deps.onBatch([{ kind: 'session-end', isError: true, errorMessage: error.message }])
        deps.onEnded()
        return
      }
      const input = createInputQueue()
      const merger = createEventMerger({ onBatch: deps.onBatch, config: deps.merge, clock })
      const handle = deps.queryFn({
        prompt: input.stream,
        options: { ...options, canUseTool },
      })
      const q: LiveQuery = {
        handle,
        input,
        merger,
        cursor: INITIAL_CURSOR,
        torndown: false,
        settled: Promise.resolve(),
      }
      current = q
      q.settled = pump(q)
      if (initialInput !== undefined && initialInput.length > 0) input.push(toUserTurn(initialInput))
    },

    send: (text) => {
      if (current === null) return false
      return current.input.push(toUserTurn(text))
    },

    interrupt: async () => {
      const q = current
      if (q === null) return
      try {
        await q.handle.interrupt()
      } catch (err) {
        deps.onError(asError(err, 'interrupt 失敗'))
      }
    },

    teardown: () => {
      if (teardownPromise !== null) return teardownPromise
      const q = current
      if (q === null) return Promise.resolve()
      q.torndown = true
      current = null
      q.input.close()
      try {
        q.handle.close()
      } catch (err) {
        deps.onError(asError(err, 'close 失敗'))
      }
      teardownPromise = waitForPump(q).then(() => {
        q.merger.flush() // 緩衝裡的事件一筆都不吞
        q.merger.dispose()
        teardownPromise = null
      })
      return teardownPromise
    },
  }
}
```

- [ ] **Step 5: 寫 `src/main/ipc-bridge.ts`（裁決 6：這裡持有狀態機）**

這支是組裝點：Electron 的 `ipcMain`、Task 5 的狀態機、Task 6 的註冊表、`agent-host` 與
Task 7 的 `SessionStore` 在這裡接起來。它自己不做任何判斷，`transition()` 算出什麼就執行什麼。
測試用 `vi.mock('electron')` 換掉 Electron（Step 1d），真的需要 Electron 的部分留給 Step 10 的手動清單。

**注入的是 `webContents` 不是 `BrowserWindow`。** Task 0 之後主視窗是 `BaseWindow` 加兩個
`WebContentsView`，整個專案已經沒有 `BrowserWindow` 可以傳。bridge 需要的只有「一個送得出
訊息的對象」，視窗的生命週期不歸它管：`index.ts` 在視窗 `closed` 時呼叫 `dispose()`，
`dispose()` 走狀態機的 `window-closed` 收尾。少一個依賴，測試也少一層假物件。

```typescript
import { ipcMain, type WebContents } from 'electron'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { Event } from '../shared/events.js'
import type { SessionState } from '../shared/session-state.js'
import {
  IPC,
  parseApprovalReply,
  parseIntentOpenHistory,
  parseUserInput,
  type ApprovalAskPayload,
  type SessionSummary,
} from '../shared/ipc.js'
import { createApprovalRegistry, type ApprovalRequest } from './approval.js'
import {
  DEFAULT_MERGE_CONFIG,
  INITIAL_MERGE_STATE,
  asError,
  createAgentHost,
  mergeAccept,
  mergeFlush,
  type AgentHost,
  type QueryFn,
} from './agent-host.js'
import { transition, type Action, type Effect } from './session-machine.js'
import type { SessionOptions } from './session-args.js'

/**
 * 唯一一處把我們的窄型別接上真正的 SDK。
 * SDK 改形狀時這一行會過不了 typecheck，那正是目的：衝擊面只剩一行。
 */
const defaultQueryFn: QueryFn = (params) =>
  sdkQuery({ prompt: params.prompt, options: params.options })

/** Task 7 的 `SessionStore`（契約文末的介面）。這裡只依賴介面，不依賴實作。 */
export interface SessionSource {
  list(): Promise<readonly SessionSummary[]>
  /** 已經是 Event：normalizeHistory 逐則展開、尾端補 session-end（裁決 15）都在 Task 7 做完。 */
  loadHistory(sessionId: string): Promise<readonly Event[]>
}

export interface IpcBridgeDeps {
  /**
   * 對話窗格的 `webContents`。刻意不是 `BrowserWindow`：Task 0 之後主視窗是
   * `BaseWindow` 加兩個 `WebContentsView`，根本沒有 `BrowserWindow` 可傳。
   * bridge 只需要一個送得出訊息的對象，視窗的生命週期由 `index.ts` 管，
   * 它在 `closed` 時呼叫 `dispose()`。
   */
  readonly webContents: WebContents
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  readonly sessions: SessionSource
  readonly logError: (error: Error) => void
  readonly queryFn?: QueryFn
  readonly approvalTimeoutMs?: number
  /** 測試用：換掉 host 的建構方式。預設是 `createAgentHost`。 */
  readonly createHost?: typeof createAgentHost
  /** 測試用：換掉批准註冊表的建構方式。預設是 `createApprovalRegistry`。 */
  readonly createRegistry?: typeof createApprovalRegistry
}

export interface IpcBridge {
  dispose(): Promise<void>
}

export function createIpcBridge(deps: IpcBridgeDeps): IpcBridge {
  const queryFn = deps.queryFn ?? defaultQueryFn
  const createHost = deps.createHost ?? createAgentHost

  /**
   * 裁決 6：狀態機住在主程序，bridge 是它唯一的持有者。
   * 這是 bridge 的私有可變槽位：每次 transition 之後**賦一個新物件**，不就地修改。
   */
  let state: SessionState = { kind: 'idle' }
  let disposed = false

  const contents = (): WebContents | null => {
    if (disposed || deps.webContents.isDestroyed()) return null
    return deps.webContents
  }

  /** 送不出去就 throw。Task 6 的註冊表把 throw 當成「視窗關了」的訊號，立即 deny。 */
  const sendOrThrow = (channel: string, payload: unknown): void => {
    const wc = contents()
    if (wc === null) throw new Error(`${channel}：webContents 已銷毀`)
    wc.send(channel, payload)
  }

  const sendBestEffort = (channel: string, payload: unknown): void => {
    const wc = contents()
    if (wc === null) {
      // 收尾途中送不出去是預期行為，不必吵；其餘情況要留下記錄。
      if (!disposed) deps.logError(new Error(`${channel}：視窗已不可用，這則訊息未送達`))
      return
    }
    wc.send(channel, payload)
  }

  const registry = (deps.createRegistry ?? createApprovalRegistry)({
    timeoutMs: deps.approvalTimeoutMs,
    sendRequest: (request: ApprovalRequest) => {
      // 型別標註的賦值：Task 6 的 ApprovalRequest 與契約的 approvalAsk payload
      // 一旦欄位漂移，這裡就過不了 typecheck（裁決 8）。裁決 16 之後 title 與
      // displayName 由 registry 一路帶過來，bridge 不必自己拼。
      const payload: ApprovalAskPayload = request
      sendOrThrow(IPC.approvalAsk, payload)
    },
  })

  const pushBatch = (events: readonly Event[]): void => {
    sendBestEffort(IPC.eventsBatch, events)
  }

  /**
   * 歷史重播沒有時間軸可言，但一樣要吃批次上限：一場長對話會產出上千個 Event，
   * 一次送過去就是一個巨大的序列化。借用同一組合併函式做切割，規則只有一份。
   */
  const pushHistory = (events: readonly Event[]): void => {
    const accepted = mergeAccept(INITIAL_MERGE_STATE, events, 0, DEFAULT_MERGE_CONFIG)
    const rest = mergeFlush(accepted.state)
    for (const batch of accepted.batches) pushBatch(batch)
    for (const batch of rest.batches) pushBatch(batch)
  }

  /**
   * 裁決 23：effects 跨 action 串行的那條鏈。`dispatch` 把每個 action 的 effects
   * 接在鏈尾，所以兩個 action 先後到達時，第二個的 effects 不會跟第一個的交錯。
   */
  let pending: Promise<void> = Promise.resolve()

  let host: AgentHost | null = null

  const ensureHost = (): AgentHost => {
    if (host !== null) return host
    host = createHost({
      queryFn,
      sessionOptions: deps.sessionOptions,
      requestApproval: (ask) => registry.request(ask),
      onBatch: pushBatch,
      onError: deps.logError,
      onEnded: () => {
        dispatch({ kind: 'session-ended' })
      },
    })
    return host
  }

  /** 一個 effect 對應一件事。順序由 Task 5 的陣列決定，這裡只照著跑。 */
  const runEffect = async (effect: Effect): Promise<void> => {
    switch (effect.kind) {
      case 'deny-all-approvals':
        registry.denyAll(effect.reason)
        return
      case 'interrupt-query':
        await ensureHost().interrupt()
        return
      case 'teardown-query':
        await ensureHost().teardown()
        return
      case 'start-query':
        // 裁決 22：一條全新對話（沒有 resume 目標）在 host.start() 之前先推
        // `{ kind: 'reset' }`，renderer 據此清掉上一場的事件。resume 不推：
        // 那則輸入是接在歷史後面的新回合，歷史要留在畫面上。
        if (effect.resumeSessionId === undefined) pushBatch([{ kind: 'reset' }])
        ensureHost().start(effect.resumeSessionId, effect.initialInput)
        return
      case 'load-history':
        // 裁決 22：reset 排在歷史事件最前面，跟它們走同一條 events 通道，
        // 所以「先清空再畫歷史」的順序由通道本身保證，不靠 `session:state` 的時序。
        pushHistory([{ kind: 'reset' }, ...(await deps.sessions.loadHistory(effect.sessionId))])
        return
    }
  }

  /**
   * 裁決 6 的核心：所有意圖都走這一條。
   * transition 算出新狀態與 effects，**照陣列順序**逐一執行，再把新狀態推回 renderer。
   *
   * 裁決 23：`transition` 與 `state` 的更新是同步的（意圖的先後就是 transition 的先後），
   * 但 effects 與狀態推送接在 `pending` 鏈尾，跨 action 也串行。少了這條鏈，連點兩筆
   * Recents 時兩次 `loadHistory` 誰先回來誰先推，最後送出的 `SessionState` 可能是先點
   * 的那一筆；live 中按「新對話」再立刻點歷史，第二個 action 的 `teardown` 會跟第一個
   * 的 `start` 交錯，出現「狀態是 viewing 但 host 裡有活躍 query」。
   *
   * 一個 action 的 effect 失敗只記錄，不阻斷後面的 action：`catch` 放在 `runEffects`
   * 之後、推狀態之前，鏈本身永遠不會進入 rejected。
   * 推的是這次 transition 算出的 `result.state`，不是可變槽位，免得被下一次 transition 蓋掉。
   */
  const dispatch = (action: Action): void => {
    const result = transition(state, action)
    state = result.state
    pending = pending
      .then(() => runEffects(result.effects))
      .catch((err: unknown) => {
        deps.logError(asError(err, `effects(${action.kind})`))
      })
      .then(() => {
        sendBestEffort(IPC.sessionState, result.state)
      })
  }

  const runEffects = async (effects: readonly Effect[]): Promise<void> => {
    for (const effect of effects) await runEffect(effect)
  }

  const guard = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      // handler 的例外絕不能流回 Electron 的 IPC dispatcher，那會讓主程序整個掛掉。
      deps.logError(asError(err, label))
    }
  }

  const rejectPayload = (channel: string, raw: unknown): void => {
    deps.logError(new Error(`${channel}：payload 形狀不符（${typeof raw}），已丟棄`))
  }

  const onUserInput = (_e: unknown, raw: unknown): void =>
    guard(IPC.userInput, () => {
      const text = parseUserInput(raw)
      if (text === null) return rejectPayload(IPC.userInput, raw)
      // live 時 transition 不產 effect，輸入直接進既有 query；
      // viewing 時 transition 產 start-query（帶 resume 與這則輸入），host 自己送出。
      const wasLive = state.kind === 'live'
      dispatch({ kind: 'user-input', text })
      if (!wasLive) return
      if (!ensureHost().send(text)) {
        deps.logError(new Error(`${IPC.userInput}：session 已收尾，這則輸入未送出`))
      }
    })

  const onApprovalReply = (_e: unknown, raw: unknown): void =>
    guard(IPC.approvalReply, () => {
      const reply = parseApprovalReply(raw)
      if (reply === null) return rejectPayload(IPC.approvalReply, raw)
      if (!registry.reply(reply.requestId, reply.decision)) {
        deps.logError(new Error(`${IPC.approvalReply}：找不到 ${reply.requestId}，可能已逾時`))
      }
    })

  const onIntentStartNew = (): void =>
    guard(IPC.intentStartNew, () => {
      dispatch({ kind: 'start-new' })
    })

  const onIntentOpenHistory = (_e: unknown, raw: unknown): void =>
    guard(IPC.intentOpenHistory, () => {
      const payload = parseIntentOpenHistory(raw)
      if (payload === null) return rejectPayload(IPC.intentOpenHistory, raw)
      dispatch({ kind: 'open-history', sessionId: payload.sessionId })
    })

  const onSessionList = async (): Promise<readonly SessionSummary[]> => {
    try {
      return await deps.sessions.list()
    } catch (err) {
      const error = asError(err, IPC.sessionList)
      deps.logError(error)
      // 往上丟：renderer 的 invoke 會 reject，錯誤在 UI 上看得見。
      // 回空陣列會被當成「這台機器沒有歷史對話」，那是靜默失敗（規格 §8）。
      throw error
    }
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    ipcMain.removeListener(IPC.userInput, onUserInput)
    ipcMain.removeListener(IPC.approvalReply, onApprovalReply)
    ipcMain.removeListener(IPC.intentStartNew, onIntentStartNew)
    ipcMain.removeListener(IPC.intentOpenHistory, onIntentOpenHistory)
    ipcMain.removeHandler(IPC.sessionList)
    // 不走 dispatch：視窗都關了，沒有 renderer 可以收 `session:state`。
    // 收尾仍然接在 `pending` 鏈尾（裁決 23）：還沒跑完的 action 先跑完，
    // 收尾才動手，否則會出現「query 已收掉但前一個 action 又把它 start 起來」。
    const result = transition(state, { kind: 'window-closed' })
    state = result.state
    pending = pending.then(() => runEffects(result.effects))
    await pending
  }

  ipcMain.on(IPC.userInput, onUserInput)
  ipcMain.on(IPC.approvalReply, onApprovalReply)
  ipcMain.on(IPC.intentStartNew, onIntentStartNew)
  ipcMain.on(IPC.intentOpenHistory, onIntentOpenHistory)
  ipcMain.handle(IPC.sessionList, onSessionList)

  return { dispose }
}
```

**裁決 6 已經把「`start-new` 的缺口」解掉了。** 初稿在這裡有一段說明：契約當時只有七個頻道，
沒有「開新對話」的入口，main 只能從 `agent:input` 與 `session:open` 反推生命週期，因此
從 `viewing` 回到一條全新對話做不到，而且規格 §3.2 的三步收尾在 renderer 與 main 各有一份。
新增 `session:intent:start-new` 與 `session:intent:open-history` 兩個意圖頻道、把狀態機搬進本檔之後，
兩個後果都不存在了：`start-new` 是一個明確的意圖，收尾順序只剩 Task 5 的 effects 陣列一份。

- [ ] **Step 6: 填 `src/preload/bridge.ts`（Task 0 已建好空殼）**

```typescript
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  PROJECT_DIR_ARG,
  parseApprovalAsk,
  parseEventsBatch,
  parseSessionState,
  parseSessionSummaries,
  type YesChefApi,
  type Unsubscribe,
} from '../shared/ipc.js'

/**
 * 這支檔案的鐵律：**任何直接呼叫 `ipcRenderer` 的箭頭函式，函式體一律用大括號。**
 *
 * `ipcRenderer.on()` 與 `ipcRenderer.removeListener()` 為了鏈式呼叫都 `return this`。
 * 簡潔箭頭 `(cb) => ipcRenderer.on(ch, h)` 會把 `ipcRenderer` 本體當成回傳值，而
 * contextBridge 連回傳值一起 proxy，renderer 只要接住 `window.yeschef.onEvents(cb)`
 * 的回傳值，就拿到了完整的 ipcRenderer，可以對任意頻道 send／invoke，context
 * isolation 等於沒有。這是上一個分支的 Critical，成因就是少了一對大括號。
 *
 * 大括號讓函式體變成敘述清單，回傳值只能是我們明寫的東西：unsubscribe 閉包或 Promise。
 */
function subscribe<T>(
  channel: string,
  parse: (raw: unknown) => T | null,
  cb: (value: T) => void
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, raw: unknown): void => {
    const parsed = parse(raw)
    if (parsed === null) {
      // main 也要驗：版本不一致或頻道撞名時，寧可丟一則錯誤也不要把壞資料交給 React。
      console.error(`[yeschef] ${channel} 收到形狀不符的 payload，已丟棄`, raw)
      return
    }
    cb(parsed)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * 裁決 21：`index.ts` 建左窗格時把 `YESCHEF_PROJECT_DIR` 放進
 * `webPreferences.additionalArguments`，這裡從 `process.argv` 取回來。
 * 找不到就給空字串並記錄：標題列空一格是可見的失敗，拋錯會讓整個 preload 掛掉，
 * 連對話都用不了，代價不成比例。
 */
function readProjectDir(): string {
  const arg = process.argv.find((a) => a.startsWith(PROJECT_DIR_ARG))
  if (arg === undefined) {
    console.error('[yeschef] preload 沒收到 --yeschef-project-dir')
    return ''
  }
  return arg.slice(PROJECT_DIR_ARG.length)
}

const api: YesChefApi = {
  onEvents: (cb) => subscribe(IPC.eventsBatch, parseEventsBatch, cb),
  onApprovalAsk: (cb) => subscribe(IPC.approvalAsk, parseApprovalAsk, cb),
  onSessionState: (cb) => subscribe(IPC.sessionState, parseSessionState, cb),

  sendInput: (text) => {
    ipcRenderer.send(IPC.userInput, text)
  },

  replyApproval: (reply) => {
    ipcRenderer.send(IPC.approvalReply, { requestId: reply.requestId, decision: reply.decision })
  },

  listSessions: async () => {
    const raw: unknown = await ipcRenderer.invoke(IPC.sessionList)
    const parsed = parseSessionSummaries(raw)
    if (parsed === null) throw new Error('session:list 回傳的形狀不符，無法顯示歷史對話')
    return parsed
  },

  startNew: () => {
    ipcRenderer.send(IPC.intentStartNew)
  },

  openHistory: (sessionId) => {
    ipcRenderer.send(IPC.intentOpenHistory, { sessionId })
  },

  // 純字串成員，跟三個 on* 一起穿過 contextBridge。啟動時就固定，不需要 IPC。
  projectDir: readProjectDir(),
}

contextBridge.exposeInMainWorld('yeschef', api)
```

三個 `on*` 用簡潔箭頭是安全的：它們回傳的是 `subscribe()` 造出來的閉包，不是 `ipcRenderer`。
真正危險的是**直接**呼叫 `ipcRenderer.on`／`removeListener` 的那兩行，它們都在大括號裡。

- [ ] **Step 6b: 改寫 `src/main/index.ts`，把 bridge 接到 Task 0 的外殼上**

Task 0 留下的是一個只會開視窗、切版面、載兩個頁面的外殼：沒有 IPC、沒有 agent、
也沒有 `YESCHEF_PROJECT_DIR` 守衛（Task 0 刻意拆掉，因為那時候主程序不會生任何 claude 程序）。
本 step 把三件東西接上去，`createWindow(): BaseWindow` 的簽章不變。

**守衛排在開視窗之前。** `YESCHEF_PROJECT_DIR` 設錯是規格 §2.1 的靜默失敗：agent 正常運作、
沒有錯誤，月底才發現 Insights 少了一批 session。所以啟動時先空跑一次 `buildSessionOptions`，
失敗就印出「怎麼設」再 `app.exit(1)`，不要先閃一個視窗才退出。`failStartup` 的回傳型別是
`never`：`app.exit()` 不會立刻中斷同步流程，後面那個 `throw` 才是真的停下來的地方，
而 `never` 也讓 TypeScript 知道之後的程式碼裡 `projectDir` 已經是 `string`。

**`sessionOptions` 是函式不是值。** 狀態機的 `start-query` effect 會帶 `resumeSessionId`，
每次開 query 都要重算一次 options。守衛只做一次，收在 `requireProjectDir()` 裡，回傳的字串
交給工廠與左窗格的 preload 兩邊用；之後每次呼叫工廠回傳的函式，都是同一組已驗過的路徑。

**裁決 20：resume 用該場對話原本的 cwd。** 工廠因此多收 `sessions`，`resumeSessionId` 有值時
先問 `sessions.cwdOf()`，問不到才退回 `YESCHEF_PROJECT_DIR`。點別的專案的歷史對話時，
逐字稿要落在那個專案底下，不是落在啟動目錄底下（規格 §3.2）。這也決定了宣告順序：
`createSessionStore` 要排在 `createSessionOptionsFactory` 之前，工廠才拿得到 `cwdOf`。
`cwdOf` 的來源是最近一次 `list()`，而 renderer 要先看得到 Recents 才點得下去，所以
真正 resume 的時候那份對照表一定已經填好了。

**裁決 21：`YESCHEF_PROJECT_DIR` 也要交給 renderer。** 走的是左窗格的
`webPreferences.additionalArguments`，不是新開一條 IPC 頻道：這是啟動時就固定的一個字串。
右窗格（`createAgentView()`）沒有 preload，不加這個旗標。

```typescript
import { app, BaseWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { splitBounds } from './layout.js'
import { createAgentView } from './agent-view.js'
import { buildSessionOptions, type SessionOptions } from './session-args.js'
import { createSessionStore, type SessionStore } from './session-store.js'
import { createIpcBridge } from './ipc-bridge.js'
import { PROJECT_DIR_ARG } from '../shared/ipc.js'

const DEFAULT_RATIO = 0.5
const INITIAL_AGENT_URL = 'https://example.com'
/** 規格 §2.1：這個目錄決定 Insights 的歸屬，設錯是靜默失敗，所以啟動時就擋。 */
const PROJECT_DIR_ENV = 'YESCHEF_PROJECT_DIR'

/** 建一個帶失敗 URL 與訊息的本地錯誤頁，給窗格 loadURL/loadFile 失敗時用。 */
function buildErrorPageUrl(failedUrl: string, message: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { font: 14px ui-monospace, Menlo, monospace; background: #12140f; color: #d8dcd4; padding: 2rem; }
    h1 { font-size: 16px; }
    code { color: #f0a0a0; word-break: break-all; }
  </style><h1>[yeschef] 頁面載入失敗</h1><p>URL：<code>${escape(failedUrl)}</code></p><p>${escape(message)}</p>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function createConversationView(projectDir: string): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 裁決 21：preload 從 process.argv 讀回這個值，放進 YesChefApi.projectDir。
      additionalArguments: [`${PROJECT_DIR_ARG}${projectDir}`],
    },
  })
}

function loadRenderer(view: WebContentsView): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    // dev 模式開 DevTools：Step 10 的 preload 暴露面檢查清單要在這個 console 執行。
    // 只在 dev 開，打包後的 app 不該自己彈開發者工具。
    view.webContents.openDevTools({ mode: 'detach' })
    view.webContents.loadURL(rendererUrl).catch((err: unknown) => {
      console.error('[yeschef] 左窗格載入失敗:', rendererUrl, err)
    })
    return
  }
  const rendererFile = join(import.meta.dirname, '../renderer/index.html')
  view.webContents.loadFile(rendererFile).catch((err: unknown) => {
    console.error('[yeschef] 左窗格載入失敗:', rendererFile, err)
  })
}

function loadAgentPage(view: WebContentsView, url: string): void {
  view.webContents.loadURL(url).catch((err: unknown) => {
    console.error('[yeschef] 右窗格載入失敗:', url, err)
    const message = err instanceof Error ? err.message : String(err)
    if (view.webContents.isDestroyed()) return
    view.webContents.loadURL(buildErrorPageUrl(url, message)).catch((e: unknown) => {
      console.error('[yeschef] 右窗格錯誤頁也載入失敗:', e)
    })
  })
}

/** 設定錯誤時印出可以照做的指示再結束。回傳型別是 never，呼叫端因此不必再處理。 */
function failStartup(reason: string): never {
  console.error(
    `[yeschef] ${reason}\n` +
      `請用專案目錄的絕對路徑設定 ${PROJECT_DIR_ENV} 之後再啟動，例如：\n` +
      `  ${PROJECT_DIR_ENV}="$HOME/Projects/你的專案" npm run dev\n` +
      `這個目錄決定 Insights 的歸屬（規格 §2.1）：設成 app 自己的目錄會讓整場對話的\n` +
      `逐字稿落在被排除的路徑下，而且完全沒有錯誤訊息，月底才會發現少了一批 session。`
  )
  app.exit(1)
  // app.exit() 不會立刻中斷同步流程，這一行才是真的停下來的地方。
  throw new Error(reason)
}

/**
 * `YESCHEF_PROJECT_DIR` 的守衛，啟動時做一次。
 *
 * 先空跑一次 `buildSessionOptions`：守衛失敗要在開視窗之前爆出來，
 * 而不是等使用者輸入第一則訊息才發現。回傳環境變數的原字串，
 * 之後交給 `createSessionOptionsFactory`（裁決 20）與左窗格的 preload（裁決 21），
 * 兩邊拿的是同一次讀取的值。
 */
function requireProjectDir(): string {
  const projectDir = process.env[PROJECT_DIR_ENV]
  if (projectDir === undefined || projectDir.length === 0) {
    failStartup(`未設定環境變數 ${PROJECT_DIR_ENV}`)
  }
  try {
    buildSessionOptions({ projectDir, appDir: app.getAppPath() })
  } catch (err) {
    failStartup(
      `${PROJECT_DIR_ENV} 的值不可用：${err instanceof Error ? err.message : String(err)}`
    )
  }
  return projectDir
}

/**
 * 回傳的函式每次開 query 都會呼叫，`resumeSessionId` 由狀態機的 `start-query` effect 帶進來。
 *
 * 裁決 20：resume 一場歷史對話時，cwd 用那場對話自己的目錄（`sessions.cwdOf()`），
 * 問不到才退回 `projectDir`。只依賴 `cwdOf` 一個方法，所以參數型別是
 * `Pick<...>`：這裡不需要 `list()` 與 `loadHistory()`。
 */
function createSessionOptionsFactory(
  projectDir: string,
  sessions: Pick<SessionStore, 'cwdOf'>
): (resumeSessionId?: string) => SessionOptions {
  const appDir = app.getAppPath()
  return (resumeSessionId) =>
    buildSessionOptions({
      projectDir:
        (resumeSessionId === undefined ? undefined : sessions.cwdOf(resumeSessionId)) ?? projectDir,
      appDir,
      resumeSessionId,
    })
}

export function createWindow(): BaseWindow {
  // 守衛排在開視窗之前：設定錯誤時不要先閃一個視窗再退出。
  const projectDir = requireProjectDir()
  // 裁決 7：SDK 型別在 session-store 轉成 SessionSummary，不穿過 IPC。
  const sessions = createSessionStore({ listSessions, getSessionMessages })
  // 裁決 20：resume 時工廠向 store 問那場對話原本的 cwd。
  const sessionOptions = createSessionOptionsFactory(projectDir, sessions)

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

  const bridge = createIpcBridge({
    webContents: conversationView.webContents,
    sessionOptions,
    sessions,
    logError: (error) => {
      console.error('[yeschef]', error)
    },
  })

  // 視窗關閉是狀態機的 `window-closed`：dispose() 會跑完三步收尾再解掉 handler。
  win.on('closed', () => {
    bridge.dispose().catch((err: unknown) => {
      console.error('[yeschef] 收尾失敗:', err)
    })
  })

  loadRenderer(conversationView)
  loadAgentPage(agentView, INITIAL_AGENT_URL)
  return win
}

app
  .whenReady()
  .then(() => {
    createWindow()
  })
  .catch((err: unknown) => {
    console.error('[yeschef] 應用初始化失敗:', err)
    process.exit(1)
  })

app.on('window-all-closed', () => {
  app.quit()
})
```

`createSessionStore({ listSessions, getSessionMessages })` 是唯一一處把 SDK 的兩個 session 函式
接進來的地方（裁決 7：SDK 型別在 Task 7 的 store 裡轉成 `SessionSummary`，不穿過 IPC）。
`createHost` 與 `createRegistry` 不傳，用 `ipc-bridge.ts` 的預設值，那兩個注入點只給測試用。

- [ ] **Step 7: 加裝相依與設定，執行測試**

SDK 已由 Task 7 的 Step 0 裝好（裁決 24，版本釘 0.3.258），本 task 只確認它在：

```bash
npm ls @anthropic-ai/claude-agent-sdk
npm test tests/agent-host.test.ts tests/ipc.test.ts tests/ipc-bridge.test.ts
```

`npm ls` 的預期輸出：

```
yeschef@1.0.0 /path/to/yeschef
└── @anthropic-ai/claude-agent-sdk@0.3.258
```

版本不是 0.3.258（或整個不在）就停下來：本檔的 `CanUseToolOptions` 依 0.3.258 的
`sdk.d.ts` 第 233／238／248 行寫成，版本不對時 `defaultQueryFn` 那一行的 typecheck
會用另一份型別。

`vitest.config.ts` 的 `coverage.include` 只加兩行，其餘既有條目一律不動（裁決 19：
每個 task 只增刪自己的檔案，不重寫整份清單，以免蓋掉前面 task 加的項目，例如 Task 7 的
`src/main/session-store.ts`）：

```diff
   coverage: {
     include: [
       // ...既有條目不動...
+      'src/main/agent-host.ts',
+      'src/main/ipc-bridge.ts',
     ],
   },
```

`src/main/session-machine.ts` 已由 Task 5 加入 coverage（路徑是裁決 6 改的，原本在 `src/renderer/`）。
`src/shared/ipc.ts` 已在清單裡（Task 1 之後由 `src/shared/**/*.ts` 涵蓋）。
`src/main/ipc-bridge.ts` 在 `vi.mock('electron')` 之後測得到，所以列入。
`src/preload/bridge.ts` **不列入**：它整支就是 `contextBridge.exposeInMainWorld`，
在 node 環境沒有等價行為，硬列進去只會得到一個永遠 0% 的數字。

Expected: 全綠。已在 worktree 實測（2026-09-02 裁決 22／23／24／28 之後重跑，SDK 0.3.258）：
把本檔所有程式碼區塊，連同 Task 3 的真 `events.ts`（含 `{ kind: 'reset' }`）、Task 4／4B 的
真 `fold.ts`、Task 5 的狀態機、Task 6 的真 `approval.ts`、Task 7 的真 `session-store.ts`
材料化之後，`npx tsc --noEmit -p .` 0 error，本 task 的三個測試檔：

```
 tests/agent-host.test.ts   Tests  49 passed (49)
 tests/ipc.test.ts          Tests  29 passed (29)
 tests/ipc-bridge.test.ts   Tests  20 passed (20)
```

三個檔合計 98。全 worktree 一起跑是 `Test Files 8 passed (8)`、`Tests 164 passed (164)`
（另外 19 條是 Task 7、13 條是 Task 6，其餘是 worktree 既有的 cdp／layout／measure-memory）。

- [ ] **Step 8: typecheck**

Run: `npm run typecheck`
Expected: 0 error。特別確認 `ipc-bridge.ts` 的 `defaultQueryFn` 那一行過得了，它是我們的窄
型別與真正 SDK 型別之間唯一的接縫，過得了才代表 `QueryHandle`／`UserTurn`／`SdkPermissionResult`
真的與 SDK 相容。

- [ ] **Step 9: 突變測試（強制）**

每一項都要：改壞 → 跑測試 → 貼失敗輸出 → 還原 → 跑測試 → 貼通過輸出。
只確認「有紅」不夠，**必須確認紅的是指名的那條**；如果紅的是別條，代表指名的那條沒有真的在測。

| # | 改壞的地方 | 怎麼改 | 必須變紅的測試 |
|---|---|---|---|
| 1 | `mergeAccept` 的滿批切割（丟事件） | 只切第一批，餘數直接扔掉：`const rest: readonly Event[] = []` | `合併不得弄丟或改變事件順序 > 任意 accept／tick 交錯之後，所有批次串接加上 pending 等於原始序列`、`mergeAccept：批次上限 > 一次灌進大量事件會切成多個滿批` |
| 2 | `mergeAccept` 的串接順序（改順序） | `const all = [...incoming, ...state.pending]` | `合併不得弄丟或改變事件順序 > 批次上限造成的切割不會改變相鄰事件的先後`（那條測試的第二段：從一個 pending 非空的 state 再 accept 一次。「任意 accept／tick 交錯」那條抓不到，它每一輪都推進超過 frameMs，pending 永遠是空的，串接寫反了結果一樣） |
| 3 | `mergeTick` 忘記清空 pending（重複送） | `return { state, batches: [state.pending] }` | `合併不得弄丟或改變事件順序 > 任意 accept／tick 交錯之後…等於原始序列`（會多出重複事件）、`mergeTick 與 mergeWakeAt > 滿一幀才送` |
| 4 | `toPermissionResult` 的 deny 分支 | 改成 `return { behavior: 'allow', updatedInput: input }` | `toPermissionResult > deny 一定要有 message`、`createAgentHost：canUseTool > deny 轉成 behavior deny` |
| 5 | `parseApprovalReply` 放寬 decision 檢查 | 改成 `if (typeof decision !== 'string') return null` | `parseApprovalReply > decision 不是 allow/deny 回 null` |
| 6 | agent-host 的游標不回寫（裁決 2 的核心） | pump 迴圈裡刪掉 `cursor = step.cursor` | `createAgentHost：事件路徑 > 游標由 host 持有：message_start 之後的 delta 帶得到 messageId` |
| 7 | `teardown` 不 flush | 刪掉 `q.merger.flush()` | `createAgentHost：輸入與收尾 > teardown 會把還在緩衝裡的事件送完，一筆都不吞` |
| 8 | **effects 反向執行**（裁決 6 的核心） | `runEffects` 改成 `for (const effect of [...effects].reverse())` | `裁決 6 > live 狀態下的 intentOpenHistory：denyAll → interrupt → teardown → loadHistory → 推狀態`、`… deny-all-approvals 排在 interrupt 之前`、`… dispose 走 window-closed 的三步收尾` |
| 9 | `canUseTool` 不把 toolUseId／title／displayName 併進 ask（裁決 16／28） | `deps.requestApproval({ toolName, input: toolInput })` | `createAgentHost：canUseTool > 裁決 11／16／28：toolUseId、toolName、input、title、displayName 併成一個 ask 送進註冊表`、`createAgentHost：canUseTool > 裁決 28：兩次呼叫各自帶自己的 toolUseId，不共用` |
| 10 | `parseSessionState` 不驗 viewing 的 sessionId | `return { kind: 'viewing', sessionId: String(v.sessionId ?? '') }` | `parseSessionState > viewing 一定要有非空 sessionId` |
| 11 | viewing 的輸入既 `start` 又 `send`（重複送） | `onUserInput` 拿掉 `wasLive` 的判斷，一律呼叫 `ensureHost().send(text)` | `裁決 6 > viewing 狀態下的 userInput：開新 query 並以該 sessionId resume` |
| 12 | **事件流中斷只通知不留痕**（裁決 17 的核心） | pump 的 reject 分支刪掉 `q.merger.accept([...])`，只留 `onError` 與 `finishNaturally` | `createAgentHost：錯誤不靜默 > 裁決 17：事件流中斷合成一筆 isError 的 session-end，走同一條 events 通道` |
| 13 | **組不出 options 時忘了收尾**（裁決 20） | `start()` 的 catch 分支刪掉 `deps.onEnded()`，只留 `onError` 與 `onBatch` | `createAgentHost：錯誤不靜默 > 裁決 20：sessionOptions 組不出來時不開 query，合成 session-end 走錯誤卡片` |
| 14 | **`start-query` 不推 reset**（裁決 22） | `runEffect` 的 `start-query` 刪掉 `if (effect.resumeSessionId === undefined) pushBatch([{ kind: 'reset' }])` | `裁決 22 > intentStartNew 推的第一個批次是 [reset]，且排在 host.start 之前`、`裁決 6 > viewing 狀態下的 intentStartNew：start 之後才推狀態，且不做收尾` |
| 15 | **`load-history` 的 reset 放到尾端**（裁決 22） | `pushHistory([...(await deps.sessions.loadHistory(effect.sessionId)), { kind: 'reset' }])` | `裁決 22 > intentOpenHistory 推的第一批第一筆是 reset，緊接著才是歷史事件`、`裁決 6 > live 狀態下的 intentOpenHistory：denyAll → interrupt → teardown → loadHistory → 推狀態` |
| 16 | **`pending = pending.then(...)` 改回不接鏈**（裁決 23） | `dispatch` 改回 `const done = runEffects(result.effects).catch(...)`，狀態推送接在 `done` 之後，`pending` 不再賦值 | `裁決 23 > 連點兩筆 Recents：後到的先 resolve 也不會插隊，最後推的是後點的那一場` |
| 17 | **`parseApprovalAsk` 不驗 toolUseId**（裁決 28） | 刪掉 `if (!isNonEmptyString(v.toolUseId)) return null`，改成 `toolUseId: String(v.toolUseId ?? '')` | `parseApprovalAsk > 裁決 28：缺 toolUseId 判為無效，型別不對也一樣` |
| 18 | **批准回覆對不上 canUseTool 的 promise**（規格 §9） | `onApprovalReply` 把 `registry.reply(reply.requestId, reply.decision)` 的 `decision` 寫死成 `'deny'` | `批准的端對端 > 回 allow：requestApproval 的 promise resolve 成 allow` |

第 1、2、3 項專門針對「合併把事件弄丟、改順序、送兩次」這三種壞法，它們是本 task 唯一
不可能靠整合測試補救的地方：事件一旦在合併層被弄丟，畫面上只是「少了幾個字」，沒有人會
發現那是 bug。

**第 8 項是裁決 6 存在的理由。** 把收尾做成 effects 陣列的唯一好處就是順序集中在一處且可測；
順序反了卻沒有測試變紅，那這個設計就白做了。已在 worktree 實測，三條指名的測試全部變紅，
還原後回綠。

**第 12 項是裁決 17 的核心。** 只呼叫 `onError` 的話，錯誤只出現在主程序的 log 裡，
使用者看到的是一場對話停在半途、沒有任何說明。合成事件讓「這場對話因錯誤結束」變成畫面上
看得見的東西，而且走的是同一條 events 通道，不必為它另開一種 UI 狀態。

**第 13 項擋的是「錯誤卡片畫出來了，狀態機卻回不了 idle」。** 少了 `onEnded()`，
bridge 收不到 `query-ended`，狀態停在 `live`，使用者看得到錯誤卻按不了下一步。

**第 14、15 項是裁決 22 的核心。** 沒有 reset，`useConversation` 只能靠 `session:state`
猜什麼時候清空，而那個推論在三種轉移上是相反的（見裁決 22 的表）。第 15 項的症狀是
reset 排到尾端時畫面照樣清空，只是清掉的是剛載入的歷史。

**第 16 項是裁決 23 的核心。** 不接鏈的版本在單一 action 的測試裡全綠，只有兩個 action
先後到達、且第二個先回來時才看得出差別，所以那條測試用的是可外部放行的 `loadHistory`。

上一輪這裡曾有一項「`ipc-bridge` 不帶 meta」，用的是一個 `pendingMeta` 閉包槽位。
裁決 16 把 `request()` 改成收單一物件之後，那個槽位（以及它連帶的一個永遠測不到的
`try/finally`）整段刪除，第 9 項改為驗 `canUseTool` 有沒有把 SDK options 併進 ask。

十八項全部在 worktree 實跑（2026-09-02 裁決 22／23／24／28 之後），每一項都改壞、跑紅、
還原、回綠，紅的都包含表格指名的那一條。三個測試檔一起跑的輸出：

```
###### 突變 1  Tests 10 failed | 88 passed (98)
###### 突變 2  Tests  1 failed | 97 passed (98)   × 批次上限造成的切割不會改變相鄰事件的先後
###### 突變 3  Tests  3 failed | 95 passed (98)
###### 突變 4  Tests  3 failed | 95 passed (98)
###### 突變 5  Tests  1 failed | 97 passed (98)
###### 突變 6  Tests  1 failed | 97 passed (98)
###### 突變 7  Tests  3 failed | 95 passed (98)
###### 突變 8  Tests  3 failed | 95 passed (98)
###### 突變 9  Tests  2 failed | 96 passed (98)
###### 突變 10 Tests  1 failed | 97 passed (98)
###### 突變 11 Tests  2 failed | 96 passed (98)
###### 突變 12 Tests  1 failed | 97 passed (98)
###### 突變 13 Tests  1 failed | 97 passed (98)
###### 突變 14 Tests  2 failed | 96 passed (98)
###### 突變 15 Tests  5 failed | 93 passed (98)
###### 突變 16 Tests  2 failed | 96 passed (98)
###### 突變 17 Tests  1 failed | 97 passed (98)
###### 突變 18 Tests  1 failed | 97 passed (98)
###### 還原    Tests 98 passed (98)
```

第 13 項的紅燈訊息：

```
 × 裁決 20：sessionOptions 組不出來時不開 query，合成 session-end 走錯誤卡片 2ms
AssertionError: expected +0 to be 1 // Object.is equality
```

第 2 項在這一輪之前抓不到：「任意 accept／tick 交錯」那條每一輪都推進超過 `frameMs`，
`pending` 永遠是空的，`[...pending, ...incoming]` 寫成 `[...incoming, ...pending]`
結果一模一樣。Step 1b 的「批次上限造成的切割不會改變相鄰事件的先後」因此補了第二段：
從一個 `pending` 非空的 state 再 accept 一次。

- [ ] **Step 10: Electron 手動檢查清單**

`preload/bridge.ts` 沒有單元測試，`ipc-bridge.ts` 的單元測試（Step 1d）用的是 Electron 的替身，
所以真正的 Electron 行為只有這份清單驗得到。體例照 `docs/RESULTS-01-memory.md`，
結果填進本 task 的完成報告。

**這份清單只留 Task 8 當下驗得起來的項目（裁決 18）。** 本 task 完成時 renderer 還是 Task 0 的
佔位頁（`<div id="root">renderer 由 Task 9 接手</div>`）：沒有對話流、沒有批准卡片、沒有 Recents，
那些是 Task 9／9B／10／11 的東西。驗不了的項目搬到 Task 12 的整合檢查清單，不留在這裡當
永遠打不了勾的格子。

啟動方式：`YESCHEF_PROJECT_DIR=$HOME/你的專案 npm run dev`
（Step 6b 的 `loadRenderer` 在 dev 模式會自動開 DevTools，下面兩塊都在那個 console 執行。）

**區塊 1：preload 的暴露面（最高優先，上一個分支的 Critical）**

在佔位頁面的 DevTools console 逐條執行：

| # | 檢查項 | 指令 | 期望 | 結果 |
|---|---|---|---|---|
| 1 | 只提供九個成員 | `Object.keys(window.yeschef).sort()` | `['listSessions','onApprovalAsk','onEvents','onSessionState','openHistory','projectDir','replyApproval','sendInput','startNew']` | ✓ / ✗ |
| 2 | 訂閱的回傳值是 unsubscribe，不是 ipcRenderer | `const u = window.yeschef.onEvents(()=>{}); typeof u` | `'function'` | ✓ / ✗ |
| 3 | 回傳值上沒有 IPC 能力 | `[u.send, u.invoke, u.on, u.sendSync]` | 四個都是 `undefined` | ✓ / ✗ |
| 4 | 全域找不到 ipcRenderer | `window.ipcRenderer ?? window.require ?? window.electron` | `undefined` | ✓ / ✗ |
| 5 | unsubscribe 真的解得掉 | 呼叫 `u()` 後 `window.yeschef.sendInput('哈囉')`，callback 不再被叫到 | 不再觸發 | ✓ / ✗ |
| 6 | 啟動目錄過得了 additionalArguments（裁決 21） | `window.yeschef.projectDir` | 等於啟動時給的 `YESCHEF_PROJECT_DIR`，不是空字串 | ✓ / ✗ |

第 3 項是本 task 的核心驗收：只要少一對大括號，`u` 就會是 `ipcRenderer`，這一列立刻變紅。

第 6 項驗的是裁決 21 唯一沒有單元測試守著的一段。空字串代表 `additionalArguments` 沒有傳到
沙箱 preload 的 `process.argv`，主程序 console 同時會有 `preload 沒收到` 那一行；補救方式是
改成一條 `invoke` 頻道，只動 `bridge.ts`／`ipc-bridge.ts` 與 Task 11 的一個 hook。

**區塊 2：收尾與壞 payload**

| # | 檢查項 | 做法 | 結果 |
|---|---|---|---|
| 1 | 壞 payload 不會弄掛主程序 | console 執行 `window.yeschef.sendInput(123)`（型別要先 `as any`），主程序只記錄錯誤 | ✓ / ✗ |
| 2 | 壞的批准回覆同上 | 用 DevTools 直接 send `{requestId:1}` 到 `agent:approval:reply` | ✓ / ✗ |
| 3 | 關視窗後 `for await` 迴圈確實結束（沒有觸發 `TEARDOWN_TIMEOUT_MS` 的錯誤記錄） | console 執行 `window.yeschef.sendInput('說一句話')`，等主程序 log 出現 events 之後關視窗，看主程序 log | ✓ / ✗ |

第 3 項驗的是「不用 `break` 收 query」這個決定：如果 `close()` 不足以讓生成器結束，
會看到「query 未在 2000 毫秒內結束，強制收尾」，那就要回頭改收尾順序。

其餘端對端檢查（對話流、批准卡片、Recents、切換 session 拒絕）在 Task 12 的整合檢查清單。

- [ ] **Step 11: 驗收**

- `npm test` 全綠，`npm run typecheck` 0 error
- `src/main/agent-host.ts` 與 `src/main/ipc-bridge.ts` 的行覆蓋率各 ≥ 80%
- 十八項突變測試各自貼出「紅」與「綠」兩次輸出，且紅的是表格指名的那一條
- 區塊 1 五項與區塊 2 三項填完，區塊 1 第 3 列必須是 ✓
- `npm run build` 成功，`out/preload/bridge.cjs` 有內容（不再是 Task 0 的空殼）
- 全專案 grep 不到 `session:open`、`openSession`、`SessionStateName`、`parseSessionOpen`
- 每支新檔案都在 800 行以內

- [ ] **Step 12: 提交**

```bash
git add src/shared/ipc.ts src/renderer/global.d.ts src/main/agent-host.ts \
        src/main/ipc-bridge.ts src/main/index.ts src/preload/bridge.ts \
        tests/ipc.test.ts tests/agent-host.test.ts tests/ipc-bridge.test.ts \
        vitest.config.ts
git commit -m "feat: SDK 宿主與 IPC 橋接，session 狀態機由主程序持有"
```

---

**初稿的三條疑慮都已裁決，以下是結論（不需要再回報）：**

1. **`session:list` 的回傳型別**：**裁決 7** 採納了本 task 的窄型別。`session:list` 回
   `SessionSummary[]`，由 main 側從 SDK 的 `SDKSessionInfo` 轉換。裁決 7 之後契約又補了
   `customTitle` 與 `gitBranch` 兩個選填欄位，所以是六欄不是四欄。理由與正規化層（裁決 2）
   同一個：SDK 型別是外部契約，讓它穿過 IPC 等於把 SDK 版本變動的衝擊直接傳到 UI。
2. **狀態機的 effect 沒有對應的 IPC 頻道**：**裁決 6** 把狀態機從 renderer 搬到
   `src/main/session-machine.ts`，並新增 `session:intent:start-new` 與
   `session:intent:open-history` 兩個意圖頻道。renderer 送意圖不送 effect，main 持有
   `SessionState`、呼叫 `transition()`、照 effects 陣列順序執行、再把新狀態從 `session:state`
   推回去。原本兩個代價（從 viewing 開新對話做不到、三步收尾兩份）都消失。
   **裁決 14** 接著把 `session:state` 的 payload 從字串改為 `SessionState` 物件，
   型別放 `src/shared/session-state.ts`。
3. **`ApprovalAskPayload` 與 Task 6 的 `ApprovalRequest` 是兩份宣告**：**裁決 8** 接受現行緩解。
   理由是 `approval.ts` 在 `src/main/`，而 `shared/ipc.ts` 不應反向依賴 main；一行型別標註的賦值
   （`const payload: ApprovalAskPayload = request`）足以在編譯期抓到漂移。
4. **`title`／`displayName` 怎麼從 `canUseTool` 送到 renderer**（第二輪的疑慮）：**裁決 16**
   採納了改簽章而不是在 agent-host 側夾帶。Task 6 的 `request()` 改收單一物件
   `request(ask: ApprovalAsk)`，`ApprovalRequest` 自己帶那兩個欄位，registry 補 `requestId`
   之後整個物件交給 `sendRequest`。本檔上一輪那個「賦值後同步讀取」的閉包槽位是隱性耦合，
   已整段刪除；`canUseTool` 現在直接組出一個完整的 ask。

---

### Task 9: React 版面與 Markdown 渲染元件

**範圍限定**：只做外殼（`main.tsx`／`App.tsx`）與 `Markdown` 元件本身。對話元件（`Conversation`／`Turn`／`ToolCall`，會用到 `ConversationView`）是 Task 9B；批准卡片是 Task 10；Recents 側邊欄的實際內容是 Task 11。這裡的 `App.tsx` 兩欄都只放靜態佔位文字。

`react-markdown@10.1.0` / `remark-gfm@4.0.1` / `rehype-highlight@7.0.2` 的實際行為（HTML 是否被跳脫、`rehype-highlight` 預設語言集、直接渲染 `<Markdown>` 進 jsdom 的輸出）已用真實套件版本、`vite build`、`vitest run`（jsdom）逐一跑過驗證，不是查文件推論；下面「已驗證」字樣指的就是這件事，實際指令與輸出見 Step 5。

**設計依據：`App.tsx` 這一層不畫右窗格的第三欄，這是裁決 9 定案的結論。**

裁決 9（`CONTRACT.md`）判定：規格 §3 的「左＋中窗格」是同一個 React renderer（Recents 側邊欄＋對話），右窗格是子專案 B 的 `agent-view.ts`，一個獨立的 Electron `WebContentsView`，不在這個 React tree 裡渲染。Electron 層維持兩欄，側邊欄與對話的分割是 React 內部的 CSS grid，不經過 Electron 的 view 幾何，也不需要 IPC。Task 7（layout 擴三欄）因此不進計畫，既有的 `splitBounds` 已經夠用。所以這裡的 `App.tsx` 只需要兩個真的 DOM 區塊：`sidebar` 與 `conversation`，不留空白的第三欄佔位 div，那個位置本來就不在這個 React tree 裡。

補一句給下游：`App.tsx` 的兩個佔位區塊會依序被 Task 11（`sidebar` 換成 `Recents`）與 Task 9B（`conversation` 換成 `Conversation` 加輸入框）取代，Task 10 再加批准疊加；本 task 只交付佔位。

側邊欄寬度是 renderer 自己的版面常數，不 import 任何 `src/main/` 的東西。`src/main/layout.ts` 管的是 Electron view 的像素幾何（左 renderer 與右 `WebContentsView` 的分割，裁決 9），側邊欄在 renderer 內部是 CSS grid 的事，兩者沒有共用值的必要，renderer bundle 也不該 import main 的模組。寬度定成 `App.css` 的 CSS 自訂屬性 `--sidebar-width: 280px`。

**Files:**
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/App.css`
- Create: `src/renderer/components/Markdown.tsx`
- Create: `src/renderer/components/Markdown.css`
- Create: `tests/markdown-component.test.tsx`
- Modify: `src/renderer/index.html`（整份改寫）
- Modify: `tsconfig.json`（加一行 `"jsx": "react-jsx"`）
- Modify: `vitest.config.ts`（`test.include` 的 glob 加上 `tsx`，見 Step 1 前的說明）
- Modify: `package.json`（加相依，見 Step 3）

`App.css`／`Markdown.css` 是原始清單沒列的追加檔案：元件與樣式分檔，符合每檔聚焦、避免把版面樣式硬塞進 JSX inline style 的原則。都很小，不算擴大範圍。

`electron.vite.config.ts` 不需要動。renderer 的 build target 已經指向 `src/renderer/index.html`，改的只是在 Task 0 留下的佔位 `index.html` 加一個 `<script>` 指到 `main.tsx`。Vite 的 esbuild 轉譯本來就會讀 `tsconfig.json` 的 `jsx` 設定去轉譯 `.tsx`，不需要另外裝 `@vitejs/plugin-react`。已用 `vite build` 對這幾個檔案實測成功（Step 5）。代價是開發模式沒有 React Fast Refresh（元件狀態不會在存檔後保留，會整頁重載），這是本 task 可以接受的取捨，不在阻塞範圍；之後如果覺得 dev loop 太慢，加這個外掛是後續 task 的事，不影響本 task 產出的正確性。

**Interfaces:**
- Consumes:
  - `function closeIncomplete(text: string): string`（Task 2，`src/shared/markdown-stream.ts`）
- Produces:
  - `interface MarkdownProps { readonly markdown: string; readonly complete: boolean }`
  - `const Markdown: React.MemoExoticComponent<(props: MarkdownProps) => ...>`（`src/renderer/components/Markdown.tsx`）
  - `class MarkdownBoundary extends Component<{ readonly markdown: string; readonly children: ReactNode }, { readonly failed: boolean }>`（`src/renderer/components/Markdown.tsx`，裁決 26：markdown 解析失敗時該 block 退回純文字，供測試直接掛載）
  - `function App(): ...`（`src/renderer/App.tsx`，掛載 sidebar／conversation 兩個佔位區塊）
  - renderer 的掛載點：`main.tsx` 對 `#root` 呼叫 `createRoot(...).render(<App />)`

  **下游用法（Task 9B 必看）**：`Markdown` 的 props 是**兩個原始值**（`markdown: string`、`complete: boolean`），不是整個 `Block`。Task 9B 畫 `Turn`／`ToolCall` 時，對 `kind === 'text'` 的 block 要呼叫 `<Markdown markdown={block.markdown} complete={block.complete} />`，**不能**寫成 `<Markdown block={block} />`。原因見下面「效能決策」一節：把整個 `block` 物件當單一 prop 丟進去，會讓這裡做的 memo 完全失效，因為 `fold()` 每幀都會產生新的 `Block` 物件（即使內容沒變）。

## 效能與體積的兩個技術決策

### 1. 逐幀重新渲染：memo 鍵是「markdown 字串與 complete 的值」，不是 block 物件

規格 §4.2／§5 定的路是：`fold(events) → ConversationView` 是純函式，沒有累積狀態；§5 又明講選「逐幀整份重解析」不做增量解析。合起來看：main 側每幀（約 16ms）把新事件推給 renderer，renderer 每次都重新呼叫 `fold(全部事件)`，而 `fold` 是純函式、不可變資料。這代表**就算某個早就結束的 turn 內容完全沒變，它在新一輪 `fold()` 產出的 `ConversationView` 裡也是一個全新的 `Block` 物件**（`readonly` 陣列與物件字面量每次都重建，這正是 CLAUDE.md 的不可變規則要求的行為，不是 bug）。

如果 `Markdown` 元件的 prop 是「整個 block 物件」，`React.memo` 預設的淺比較會比對 `block` 這個 prop 本身的參照，每幀都不同，於是每個已完成的歷史 block 都會被判定為「變了」而重新跑一次 `closeIncomplete` 加 `react-markdown` 的完整解析管線。這正是逐幀整份重解析要付的代價，且完全是白付的，因為內容根本沒變。

修法不是「更聰明地比較物件」，是**把 prop 換成基本型別**：`markdown: string`、`complete: boolean`。JS 字串是值比較（`"a" === "a"` 恆真，不看是哪次配置出來的），所以只要呼叫端傳的是 `block.markdown` 與 `block.complete` 這兩個基本值而不是整個物件，`React.memo` 的預設淺比較天生就是正確的「內容沒變就跳過重繪」，不需要寫自訂比較函式。元件內部再用 `useMemo(() => ..., [markdown])` 包住 `closeIncomplete` 加 `<ReactMarkdown>` 的建立，雙重保險：即使外層因為別的原因重繪（例如父層多傳了一個沒變的 prop 導致 `memo` 沒擋下來),只要 `markdown` 這個依賴值沒變，也不會重新建立 `ReactMarkdown` 元素。

還在串流中的最後一個 block 每幀 `markdown` 內容都在變長，這條 memo 天生擋不住它、也不該擋：那正是規格 §5 說「訊息長度有限，重解析便宜」所指的那一個 block。這個決策省的是其餘 N-1 個已完成 block 的重複解析，不是省正在串流那一個的。

已用突變測試驗證：把 `useMemo` 的依賴陣列從 `[markdown]` 改成 `[]`，畫面會卡在第一次渲染的內容，串流看起來像是停住了（Step 5 突變 2 有實際紅燈輸出）。

### 2. `rehype-highlight` 只用預設的 `common` 語言集（37 種），不傳 `languages: all`

查了 `rehype-highlight@7.0.2` 原始碼（`lib/index.js`）：`languages` 選項不給就是 `lowlight` 的 `common` 匯出，37 種語言（含 `javascript`／`typescript`／`python`／`bash`／`json`／`yaml`／`sql`／`css`／`xml`／`markdown`／`diff` 等）；`all` 是完整 190 種。也就是說**「只註冊常用語言」是這個套件不寫 `languages` 選項時的內建行為，不需要自己動手挑一份清單去維護**。維護一份子集清單只會製造一個要跟著 highlight.js 版本更新的額外負擔，解決一個套件作者已經解決過的問題。

體積差異已用 `vite build`（production, minify）實測，把 `Markdown` 元件真的接進一個入口點量測（不是憑印象）：

| `languages` 選項 | JS 產出（min） | gzip |
|---|---:|---:|
| 不傳（預設 `common`，37 種） | 513.49 kB | 159.34 kB |
| 傳 `all`（190 種） | 1,256.48 kB | 407.34 kB |

`all` 比 `common` 重了約 248 kB（gzip 後）。決定：**不傳 `languages` 選項，用預設值**。理由除了體積，還有一個：`rehype-highlight` 對辨識不出的語言不會丟例外：原始碼裡遇到 `Unknown language` 只是呼叫 `file.message`（等於一筆警告）然後 `return`，該 code block 保留純文字不高亮，不會讓整則訊息壞掉。這剛好符合規格 §8「markdown 解析失敗，該 block 退回純文字，不讓整則訊息壞掉」的精神，即使遇到 37 種之外的語言也一樣安全，不需要額外包 try/catch。

## `vitest.config.ts`：`jsdom` 用 per-file 註記，`include` 加 `tsx`

**決定**：`tests/markdown-component.test.tsx` 檔案最上方加 `// @vitest-environment jsdom` 這一行註記（Vitest 官方支援的逐檔覆寫語法），`vitest.config.ts` 的 `environment` 不動。`test.include` 則必須改：現在是 `'tests/**/*.test.ts'`，`.tsx` 測試檔完全不會被收進來（在本 repo 實測 `npx vitest run tests/foo.test.tsx` 得到「No test files found」）。改成 `'tests/**/*.test.{ts,tsx}'`，這一行是 Step 1 的一部分，寫測試之前先改。

理由：現有 4 個測試檔（`layout`／`cdp`／`ipc`／`measure-memory`；`spawn-args` 已在 Task 0 刪除）全是純 Node 函式測試，沒有一個碰 DOM。把 `vitest.config.ts` 的 `test.environment` 整個改成 `'jsdom'` 會讓這 4 個檔案也套上 jsdom 全域（`window`／`document`／`navigator`），其中 `measure-memory.test.ts` 量的是真實 process 記憶體，跟渲染完全無關，沒理由承擔 jsdom 初始化的額外開銷與潛在的全域污染風險。per-file 註記把影響範圍精確收在唯一需要它的檔案，改動也只有一行。

`package.json` 需要加 `jsdom` 當 devDependency（環境套件本身，Vitest 執行期才會真的 `require` 它），這件事跟上面的「加在哪」是兩回事，兩者都需要。

- [ ] **Step 1: 寫失敗的測試**

`tests/markdown-component.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Markdown, MarkdownBoundary } from '../src/renderer/components/Markdown.js'

afterEach(() => {
  cleanup()
})

/** 涵蓋表格、程式碼圍欄、行內程式碼、粗體四種語法，跟 Task 2 的 CRAFTED 同一份文件。 */
const CRAFTED = [
  '# 標題',
  '',
  '這是一段**粗體**與 `行內程式碼` 的文字。',
  '',
  '| 欄位 | 說明 |',
  '|---|---|',
  '| foo | 第一列 |',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '結尾，含 `token` 與 **強調**。',
].join('\n')

describe('Markdown', () => {
  it('表格渲染成對應的 DOM 元素', () => {
    const { container } = render(
      <Markdown markdown={'| a | b |\n|---|---|\n| 1 | 2 |'} complete />
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('程式碼區塊渲染成 pre/code 並套用語法高亮', () => {
    const { container } = render(<Markdown markdown={'```js\nconst x = 1\n```'} complete />)
    expect(container.querySelector('pre code')).not.toBeNull()
    // 語法高亮的 span 存在，確認 rehype-highlight 真的接上了，不是只有 <pre><code> 空殼
    expect(container.querySelector('.hljs-keyword')).not.toBeNull()
  })

  it('行內程式碼渲染成 code，且不在 pre 裡面', () => {
    const { container } = render(<Markdown markdown="hello `world`" complete />)
    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.closest('pre')).toBeNull()
  })

  it('complete 為 false 時尾端有游標，為 true 時沒有', () => {
    const streaming = render(<Markdown markdown="hi" complete={false} />)
    expect(streaming.container.querySelector('.markdown-cursor')).not.toBeNull()

    const done = render(<Markdown markdown="hi" complete />)
    expect(done.container.querySelector('.markdown-cursor')).toBeNull()
  })

  it('原始 <script> 不會被執行，只以文字呈現', () => {
    const { container } = render(
      <Markdown markdown="before <script>alert(1)</script> after" complete />
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('帶 onerror 的 <img> 不會被建成真的 DOM 元素', () => {
    const { container } = render(
      <Markdown markdown="<img src=x onerror=alert(1)>" complete />
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('未完成的 markdown 不會讓元件崩潰：每個前綴都渲染出東西且不拋錯', () => {
    for (let i = 1; i <= CRAFTED.length; i += 1) {
      const prefix = CRAFTED.slice(0, i)
      expect(() => {
        const { container, unmount } = render(<Markdown markdown={prefix} complete={false} />)
        // 用「掛了一個元素」而非「文字不為空」判斷有渲染出東西：
        // 單一 `#`（合法但無文字的 ATX 標題）這種前綴，textContent 是空的，
        // 但 wrapper 底下確實掛了 <h1></h1>，不是渲染失敗。
        expect(container.firstElementChild).not.toBeNull()
        unmount()
      }).not.toThrow()
    }
  })

  // 這一條專門擋「拿掉 closeIncomplete 這一步」的錯誤實作：
  // 表格資料列送到一半（`| f`，還沒收到第二欄與收尾的 |）時，
  // closeIncomplete 會把這一列整條扣住，畫面只有表頭；
  // 拿掉這一步，remark-gfm 會把 `| f` 當成一列已完成的資料列直接渲染出 <td>f</td>，
  // 使用者會看到半列資料閃一下，下一個 token 到齊後內容才「跳一下」變成正確的列。
  it('串流中的表格資料列在收尾前不會提前渲染出資料格', () => {
    const partial = '| 欄位 | 說明 |\n|---|---|\n| f'
    const { container } = render(<Markdown markdown={partial} complete={false} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('tbody')).toBeNull()
    expect(container.querySelectorAll('td')).toHaveLength(0)
  })

  // 這一條專門擋「memo 的依賴陣列寫錯」（例如把 [markdown] 誤寫成 []）：
  // 那樣的錯誤實作會讓元件第一次渲染後就再也不重新解析，畫面卡在第一幀，
  // 逐字串流會整段停住不動。
  it('markdown 內容改變時，畫面要換成新內容（防止 memo 依賴寫錯）', () => {
    const { container, rerender } = render(<Markdown markdown="第一段" complete={false} />)
    expect(container.textContent).toContain('第一段')

    rerender(<Markdown markdown="第一段，接上更多字" complete={false} />)
    expect(container.textContent).toContain('第一段，接上更多字')
  })
})

// 裁決 26：markdown 解析失敗時該 block 退回純文字，不讓整則訊息壞掉。
// 直接掛載 MarkdownBoundary（不經過 Markdown），子元件在 render() 就 throw，
// 用來確認退回邏輯本身，跟 react-markdown 會不會真的拋錯是兩回事。
describe('MarkdownBoundary', () => {
  function Boom(): never {
    throw new Error('boom')
  }

  it('子元件渲染拋錯時，退回顯示傳入的 markdown 純文字', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <MarkdownBoundary markdown={'# 標題\n\n未完成的 **粗體**'}>
        <Boom />
      </MarkdownBoundary>
    )
    const fallback = container.querySelector('pre.markdown-fallback')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toBe('# 標題\n\n未完成的 **粗體**')
    consoleError.mockRestore()
  })

  it('markdown 換掉之後重設，children 不再拋錯時改顯示 children', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container, rerender } = render(
      <MarkdownBoundary markdown="第一段">
        <Boom />
      </MarkdownBoundary>
    )
    expect(container.querySelector('pre.markdown-fallback')).not.toBeNull()

    rerender(
      <MarkdownBoundary markdown="第二段">
        <p>正常內容</p>
      </MarkdownBoundary>
    )
    expect(container.querySelector('pre.markdown-fallback')).toBeNull()
    expect(container.textContent).toContain('正常內容')
    consoleError.mockRestore()
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

先確認 `vitest.config.ts` 的 `include` 已改成 `'tests/**/*.test.{ts,tsx}'`。若看到「No test files found」，是 glob 沒改，不是預期的失敗。

Run: `npm test tests/markdown-component.test.tsx`
Expected: FAIL，無法解析 `../src/renderer/components/Markdown.js`（檔案還不存在），也無法解析 `@testing-library/react`（還沒裝）。

- [ ] **Step 3: 寫最小實作**

**3a. `package.json`**：`dependencies` 加四個、`devDependencies` 加五個，版本用 2026-09-02 當天 `npm view` 查到的最新版釘死：

```diff
   "dependencies": {
+    "react": "^19.2.8",
+    "react-dom": "^19.2.8",
+    "react-markdown": "^10.1.0",
+    "remark-gfm": "^4.0.1",
+    "rehype-highlight": "^7.0.2"
   },
```

Task 0 已把 `@xterm/*`、`node-pty`、`@electron/rebuild` 移除；`@anthropic-ai/claude-agent-sdk` 由 Task 7 加（裁決 24），此時 `dependencies` 只有它一項。

```diff
   "devDependencies": {
     "@types/node": "^26.4.0",
+    "@types/react": "^19.2.18",
+    "@types/react-dom": "^19.2.5",
+    "@testing-library/react": "^16.3.3",
+    "jsdom": "^30.0.1",
     "@vitest/coverage-v8": "^4.1.11",
     "electron": "^44.0.0",
     "electron-vite": "^5.0.0",
     "typescript": "^7.0.2",
     "vite": "^7.3.6",
     "vitest": "^4.1.11"
   },
```

不加 `@testing-library/jest-dom`：上面的測試全部用 `.not.toBeNull()`／`.toHaveLength()`／`.toContain()`，都是 vitest 內建的 `expect` 就有的斷言，沒有用到 `toBeInTheDocument()` 這類 jest-dom 專屬 matcher，裝了也是死重量。

**3a 之後（裁決 24）：** 改完 `package.json` 立刻跑一次安裝。

Run: `npm install`
Expected: 成功結束，`node_modules/react` 存在。

**3b. `tsconfig.json`**：只加一行。

```diff
     "strict": true,
     "noUncheckedIndexedAccess": true,
     "esModuleInterop": true,
     "skipLibCheck": true,
+    "jsx": "react-jsx",
     "types": ["node"]
```

`"types"` 陣列不用加 `"react"`。已用 `tsc --noEmit` 實測：只要檔案本身有 `import { ... } from 'react'`（本 task 每個 `.tsx` 都有），`@types/react` 對全域 `JSX` 命名空間的擴充就會被 program 讀到，`"types": ["node"]` 這個限制只擋「沒被任何檔案匯入、純靠自動全域掃描」的套件，不擋顯式 import 帶進來的型別。唯一要避開的坑是**不要**幫函式回傳型別標 `: JSX.Element`：那樣寫需要額外顯式 import `JSX` 型別（TypeScript 5.1 之後 automatic JSX runtime 的已知限制），不標註、讓 TS 自己推論回傳型別就沒事，也更省事。下面所有元件都不標。

**3c. `src/renderer/index.html`（整份改寫）**：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>yeschef</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

**3d. `src/renderer/main.tsx`**：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

const container = document.getElementById('root')
if (!container) {
  throw new Error('yeschef: index.html 缺少 #root，renderer 無法掛載')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

沒有 `#root` 就丟出明確錯誤而不是靜默失敗，呼應全域約束「不得靜默丟棄」：找不到掛載點是設定錯誤，應該讓它在畫面上炸出一個看得到的錯誤，不是留一個空白視窗讓人猜發生了什麼事。

**3e. `src/renderer/App.tsx`**：

```tsx
import './App.css'

/**
 * 三窗格架構（規格 §3）裡「左＋中」這一個 React renderer（裁決 9）。
 *
 * 右窗格（agent-view，子專案 B）是獨立的 Electron WebContentsView，Electron 層
 * 維持兩欄，不在這個 tree 裡渲染，這裡也不留空白第三欄佔位：那個位置由主程序決定，
 * 跟這裡的 CSS 佈局無關。
 *
 * 側邊欄寬度是 renderer 自己的版面常數（App.css 的 --sidebar-width），不 import
 * 任何 src/main/ 的東西：主程序的 layout.ts 管的是 Electron view 的像素幾何，
 * 側邊欄在這裡是 CSS grid 的事，兩者沒有共用值的必要。
 *
 * 側邊欄與對話目前都只有靜態佔位，會依序被下游 task 取代：
 * - sidebar → Recents（Task 11）
 * - conversation → Conversation 加輸入框（Task 9B），Task 10 再加批准疊加
 */
export function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <p className="placeholder">Recents（Task 11）</p>
      </aside>
      <main className="conversation">
        <p className="placeholder">對話（Task 9B／10）</p>
      </main>
    </div>
  )
}
```

**3f. `src/renderer/App.css`**：

```css
html,
body,
#root {
  height: 100%;
  margin: 0;
}

.app {
  --sidebar-width: 280px;

  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  height: 100%;
  font-family: ui-monospace, Menlo, monospace;
  color: #d8dcd4;
  background: #12140f;
}

.sidebar {
  border-right: 1px solid #2a2d24;
  overflow-y: auto;
}

.conversation {
  overflow-y: auto;
}

.placeholder {
  padding: 12px;
  opacity: 0.6;
}
```

**3g. `src/renderer/components/Markdown.tsx`**：

```tsx
import { Component, memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { closeIncomplete } from '../../shared/markdown-stream.js'
import './Markdown.css'

export interface MarkdownProps {
  readonly markdown: string
  readonly complete: boolean
}

// 模組層級常數，不是每次渲染重建的陣列字面量：react-markdown 拿 remarkPlugins／
// rehypePlugins 陣列的參照去判斷要不要重跑 unified 的 processor 快取，如果這兩個
// 陣列每次渲染都是新的字面量，等於每次都告訴它「外掛設定變了」，白白多一層失效。
const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeHighlight]

interface MarkdownBoundaryProps {
  readonly markdown: string
  readonly children: ReactNode
}

interface MarkdownBoundaryState {
  readonly failed: boolean
}

/**
 * markdown 解析失敗時該 block 退回純文字，不讓整則訊息壞掉（裁決 26）。
 * React 19 仍只能用類別元件攔截子樹渲染時拋出的錯誤，沒有對應的 hooks 寫法。
 */
export class MarkdownBoundary extends Component<MarkdownBoundaryProps, MarkdownBoundaryState> {
  state: MarkdownBoundaryState = { failed: false }

  static getDerivedStateFromError(): MarkdownBoundaryState {
    return { failed: true }
  }

  componentDidUpdate(prevProps: MarkdownBoundaryProps) {
    if (this.props.markdown !== prevProps.markdown && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (this.state.failed) {
      return <pre className="markdown-fallback">{this.props.markdown}</pre>
    }
    return this.props.children
  }
}

/**
 * 把一段可能未完成的 markdown 字串渲染成內容。
 *
 * 逐字串流下每幀都可能重新收到同一個 block 的最新內容（規格 §5：逐幀整份
 * 重解析，不做增量解析）。解析前一律先過 closeIncomplete（Task 2）把奇數圍欄、
 * 未閉合的行內標記、寫到一半的表格列處理掉，再交給 react-markdown，不分
 * complete 是 true 還是 false 都跑這一步：complete 為 true 時的輸入本來就是
 * 結構完整的文字，closeIncomplete 對它是不動作（Task 2 已證明「完整文件原樣
 * 通過」），統一跑一次比分兩條路徑判斷更簡單，也不會漏掉「以為完整結果其實
 * 是舊資料」這種特殊情況。
 *
 * 不用 rehype-raw：react-markdown 預設就不把 markdown 裡的原始 HTML 解析成
 * 真的元素（模型輸出的 `<script>`／`<img onerror=...>` 會被當成文字跳脫顯示），
 * 這正是規格 §5.1 選 react-markdown 而非「轉 HTML 字串+ dangerouslySetInnerHTML」
 * 的理由。加 rehype-raw 或任何把原始 HTML 放行的外掛都會打破這個保護，本元件
 * 刻意不加。
 *
 * ReactMarkdown 外面包一層 MarkdownBoundary（裁決 26）：react-markdown 在渲染期
 * 解析失敗會拋錯，沒有它會一路炸到 React 根，一個 block 壞掉就變成整則訊息消失。
 * 接住之後改顯示原始 markdown 純文字，下一幀內容換了（markdown prop 改變）才
 * 重新嘗試解析。
 */
function MarkdownImpl({ markdown, complete }: MarkdownProps) {
  const body = useMemo(() => {
    const safe = closeIncomplete(markdown)
    return (
      <MarkdownBoundary markdown={markdown}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
          {safe}
        </ReactMarkdown>
      </MarkdownBoundary>
    )
  }, [markdown])

  return (
    <div className="markdown-block">
      {body}
      {!complete && <span className="markdown-cursor" aria-hidden="true" />}
    </div>
  )
}

// 用 memo 包起來，且 props 只收基本型別（markdown 字串、complete 布林值），
// 不收整個 Block 物件，理由見計畫的「效能決策」一節，呼叫端必須配合這個約定。
export const Markdown = memo(MarkdownImpl)
```

**3h. `src/renderer/components/Markdown.css`**：

```css
.markdown-block {
  white-space: normal;
}

.markdown-cursor {
  display: inline-block;
  width: 0.5em;
  height: 1em;
  vertical-align: text-bottom;
  background: currentColor;
  animation: markdown-cursor-blink 1s steps(1) infinite;
}

@keyframes markdown-cursor-blink {
  50% {
    opacity: 0;
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/markdown-component.test.tsx`
Expected: PASS，11 個測試（9 個 `Markdown` 加 2 個 `MarkdownBoundary`，裁決 26）。實跑輸出：

```
 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  922ms (transform 38ms, setup 0ms, import 174ms, tests 352ms, environment 311ms)
```

Run: `npm run typecheck`
Expected: 無錯誤。這一步已用上面完整的九個檔案（`main.tsx`／`App.tsx`／`App.css`／`Markdown.tsx`／`Markdown.css`／`index.html`／`tsconfig.json` 的 diff／`package.json` 的 diff／測試檔）在一個獨立目錄裡裝了真實版本的套件實測過 `tsc --noEmit`，通過，不是憑印象寫的程式碼。

Run: `npm test`
Expected: PASS，總數在既有基礎上加 11。實測（Task 0 的 4 個既有測試檔加本 task 加 Task 2）：`Test Files 6 passed (6)`、`Tests 72 passed (72)`。

- [ ] **Step 5: 突變測試（強制步驟，已用上面同一份實作跑過，不是紙上談兵）**

三個突變，每一個都已經照 Step 3 的完整程式碼實際改過、跑過 `vitest run` 拿到紅燈、還原後確認回綠燈：

| # | 突變 | 預期紅的測試 | 實測結果 |
|---|---|---|---|
| 1（**強制**：拿掉 closeIncomplete 這一步） | 把 `MarkdownImpl` 裡的 `const safe = closeIncomplete(markdown)` 改成 `const safe = markdown` | 「串流中的表格資料列在收尾前不會提前渲染出資料格」 | 紅。`tbody`／`td` 提前出現：`<tbody><tr><td>f</td><td /></tr></tbody>`，斷言 `toBeNull()` 收到一個真的 `<tbody>` 元素，失敗。其餘測試仍綠（1 failed \| 10 passed） |
| 2 | `useMemo` 的依賴陣列從 `[markdown]` 改成 `[]` | 「markdown 內容改變時，畫面要換成新內容」 | 紅。`AssertionError: expected '第一段' to contain '第一段，接上更多字'`：`rerender` 後畫面沒換，卡在第一次渲染的內容（1 failed \| 10 passed） |
| 3 | 把 `{!complete && <span className="markdown-cursor" .../>}` 改成無條件的 `<span className="markdown-cursor" .../>` | 「complete 為 false 時尾端有游標，為 true 時沒有」 | 紅。`complete: true` 時仍然渲染出 `<span aria-hidden="true" class="markdown-cursor" />`，斷言 `toBeNull()` 收到真的元素，失敗（1 failed \| 10 passed） |
| 4（裁決 26） | `MarkdownBoundary` 的 `getDerivedStateFromError` 改成 `return { failed: false }` | 「子元件渲染拋錯時，退回顯示傳入的 markdown 純文字」與「markdown 換掉之後重設，children 不再拋錯時改顯示 children」 | 紅。子元件拋出的 `Error: boom` 沒被接住，兩條 `MarkdownBoundary` 測試都失敗（2 failed \| 9 passed） |

四次都在改完後單獨跑 `vitest run`，還原程式碼後再跑一次確認回到「11 passed」，且與備份逐位元組比對一致。任何一個突變後測試仍然全綠，代表該條測試沒測到它宣稱要測的東西，要停下來回報。這裡四個都如預期變紅，不需要回報。

（第 5 個非強制項一併做了：拿掉 `rehypePlugins`，只留 `remarkPlugins`，`.hljs-keyword` 那條斷言變紅：`rehype-highlight` 沒接上時 code block 只有裸的 `<pre><code>`，沒有語法高亮的 span，1 failed \| 10 passed。）

- [ ] **Step 6: 執行完整測試套件與建置**

Run: `npm test`
Expected: PASS，總數在前面 task 的基礎上加 11（本 task 新增的 `markdown-component.test.tsx`，含 `MarkdownBoundary` 的 2 條）。

Run: `npm run typecheck`
Expected: 無錯誤。

Run: `npm run build`（`electron-vite build`）
Expected: main／preload／renderer 三端都成功打包，`out/renderer/index.html` 這條鏈含 `main.tsx`／`App.tsx`／`Markdown.tsx`。實跑輸出：`out/renderer/assets/index-*.js  555.26 kB`，超過 vite 的 500 kB chunk size 預設警告門檻，這是 `react` + `react-markdown` 的解析管線加 37 種語法高亮語言本身的重量，不是本 task 的退步；要不要上 code splitting（動態 `import()`）是效能調校階段的事，這裡先記一筆，留給之後量測記憶體與啟動時間的 task 判斷。單獨跑 `npx vite build --config electron.vite.config.ts`（不經 `electron-vite` CLI）會因為解析不了 electron-vite 的三段式設定而失敗（`Could not resolve entry module "index.html"`），這裡改成一律用 `npm run build`。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/main.tsx src/renderer/App.tsx src/renderer/App.css \
  src/renderer/components/Markdown.tsx src/renderer/components/Markdown.css \
  src/renderer/index.html tests/markdown-component.test.tsx \
  tsconfig.json vitest.config.ts package.json package-lock.json
git commit -m "feat: React 版面與 Markdown 渲染元件，逐幀重解析改用基本型別 prop 做 memo"
```

---

### Task 9B: 對話元件（Conversation／Turn／ToolCall／useConversation）

> **2026-09-02 依裁決 17 與接縫補記修訂**
>
> `Conversation` 依裁決 17 第 4 點加一張錯誤卡片（`view.error` 存在時渲染），新增兩條測試與突變 M8。
> `vitest.config.ts` 的 `test.include` 已由 Task 9 定案，本 task 只在 Step 2 確認，不再重複列為待改項目。
> 回報事項第 4、5、6 條依裁決 12、17 改寫為已定案結論。測試數由 34 增至 36，突變數由 7 增至 8。
>
> **2026-09-02 晚間依裁決 22 再修訂**
>
> 清空畫面的判斷從 `sessionState` 換一場改成事件流裡的 `{ kind: 'reset' }` 標記。`sameSession` 刪除，
> 新增純函式 `appendEvents`；`onSessionState` 只更新狀態。Step 1 換掉兩條測試、加六條，M1 改成
> 「收到 reset 不清空」。測試數由 36 增至 42。

把 Task 4／4B 的 `ConversationView` 畫成畫面，並把 Task 8 的 `window.yeschef` 接上 React。
Task 9 已經備妥外殼與 `Markdown` 元件，本 task 補上中間那一段：訂閱事件、投影成 view、逐 block 渲染。
批准卡片本體是 Task 10（本 task 只留 `renderToolExtra` 這個插入點），Recents 是 Task 11。

**設計取捨一：`fold()` 每幀重建物件，所以 `React.memo` 必須自帶比較函式，否則等於沒寫。**

`fold()` 是純函式，每次呼叫都從空 view 重播整條事件流，連內容一個字都沒變的 turn 也會拿到全新的
`Turn` 物件、全新的 `blocks` 陣列、全新的 `Block` 物件。`React.memo` 預設的淺比較看的是參照，
每幀都不相等，於是 memo 每次都放行。這不是「memo 效果差」，是 memo 完全不會命中，寫了只是裝飾。
Task 9 的解法（改傳原始值）在 `Markdown` 這一層有效，但 `Turn` 與 `ToolCall` 收的是 block 物件本身，
拆不成幾個原始值。所以這裡改用第二種解法：`memo(Component, areEqual)` 加一個逐欄位比較的純函式
`blockEquals`，放在獨立的 `block-equals.ts` 讓它能被單獨測。

比較函式對 `input` 與 `result` 用參照比較（`Object.is`），對 `raw` 用逐欄位比較。這個差別有實據：
`fold()` 把 `event.input`／`event.content` 原樣傳進 Block，而事件陣列是附加式的、元素本身從不重建，
所以同一次工具呼叫的 `input` 在每一幀都是同一個物件；`raw` 則是 `applyToolRawOutput` 每次重新組出來的
新物件，用參照比會永遠不等。判斷錯的代價不對稱：參照比較最壞的結果是多重繪一次（畫面正確、效能損失），
比較函式漏了欄位則會讓畫面停在舊資料（畫面錯誤）。所以參照比較用在安全的方向，漏欄位那一側靠測試擋。

**設計取捨二：批准卡片畫在摺疊區之外。**

`renderToolExtra` 的回傳值放在 `.tool-extra`，位置在卡片底部但不在 `open` 的條件裡面。理由是規格 §6
說批准出現時「對話已經卡住，無法繼續往下」，若把它塞進預設摺疊的工具內容裡，使用者會看到一個停住的
畫面卻找不到要按什麼。同理，`status === 'awaiting-approval'` 的卡片預設展開（規格 §6 要求顯示完整
input），作法是 `const open = override ?? block.status === 'awaiting-approval'`：使用者手動點過就以他的
選擇為準，沒點過就由狀態決定。用一個 `boolean | undefined` 的 state 表達「使用者有沒有表示過意見」，
比用 `useEffect` 去同步兩個狀態少一個特殊情況。

**設計取捨三：清空畫面的分界寫在事件流裡，不從 `session:state` 推論（裁決 22）。**

`onEvents` 收到的批次一律附加；批次裡出現 `{ kind: 'reset' }` 時，只保留最後一個 `reset` 之後的事件，
先前累積的全部丟掉，`reset` 本身也不留。`onSessionState` 只更新 `state`，不動 `events`。

理由是資料放在對的地方：「畫面從這裡重新開始」是事件流自己的分段，由主程序在推事件時合成
（Task 8 的 `ipc-bridge.ts`：全新 query 之前推一筆，載入歷史時放在歷史事件最前面），跟同一條頻道的
其他事件共用先後順序，所以 `session:state` 什麼時候到都不影響畫面內容。反過來用狀態差異推論的話，
有三處判斷會相反：`live` 轉 `idle`（query 結束或出錯）要保留裁決 17 的錯誤卡片、`viewing{A}` 轉
`live{A}`（輸入即 resume）要保留歷史、`live{}` 轉 `live{}`（live 中按新對話）才是真的要清。

`state` 與 `events` 仍然合在同一份 `{ state, events }`：拆成兩個 `useState` 的話，其中一個的更新函式
就得呼叫另一個的 setter，而 React 的更新函式必須是純的（StrictMode 會重複呼叫）。合成一份之後，
附加與截斷都是同一個純表達式算出來的。

截斷的部分抽成獨立的匯出函式 `appendEvents(prev, batch)`。原因是 `fold()` 自己也認得 `reset`
（裁決 22 給 Task 4 的那一條：`case 'reset': return INITIAL_VIEW`），所以 hook 少截一次，畫面看起來
一模一樣，差別只在累積陣列會無限長。這件事透過 `view` 觀察不到，只能直接測那個純函式，Step 5 的
M1 就掛在它上面。

**已驗證的範圍**：下面所有標「已驗證」「實測」的句子，都是在 `git worktree` 裡裝上真實套件版本
（react 19.2.8／@testing-library/react 16.3.3／jsdom 30.0.1）、把上游 task 的程式碼材料化之後，
實際跑過 `tsc --noEmit` 與 `vitest run` 得到的結果。42 個新測試全綠、8 個突變全部如預期變紅，
指令與輸出見 Step 4、Step 5。

**Files:**
- Create: `src/renderer/components/Conversation.tsx`
- Create: `src/renderer/components/Turn.tsx`
- Create: `src/renderer/components/ToolCall.tsx`
- Create: `src/renderer/components/ThinkingBlock.tsx`
- Create: `src/renderer/components/block-equals.ts`
- Create: `src/renderer/components/Conversation.css`
- Create: `src/renderer/hooks/useConversation.ts`
- Create: `tests/conversation.test.tsx`
- Create: `tests/use-conversation.test.tsx`
- Modify: `src/renderer/App.tsx`（換掉對話佔位，加輸入框）
- Modify: `src/renderer/App.css`（`.conversation` 改成直向 flex，加 `.composer`）
- Modify: `vitest.config.ts`（coverage 加新檔。`include` 的 `.tsx` glob 由 Task 9 負責，本 task 不動那一行）

兩個追加檔案的理由：`block-equals.ts` 是純函式，抽出來才能單獨測（Step 5 的突變 M6 就靠它），
`Conversation.css` 一份涵蓋四個元件的樣式，不切成四個十行的檔案。`UnknownBlock` 沒有獨立成檔，
它只有十幾行且只被 `Turn` 用到，留在 `Turn.tsx` 內。

**Interfaces:**
- Consumes:
  - `fold(events: readonly Event[]): ConversationView`、`ConversationView`、`Turn`、`Block`
    （Task 4／4B，`src/shared/fold.ts`）。`Block` 的 `kind: 'tool'` 依裁決 12 含 `deniedReason?: string`；
    `ConversationView` 依裁決 17 另含 `error?: { readonly message?: string; readonly apiErrorStatus?: unknown }`
  - `Event`（Task 3，`src/shared/events.ts`）
  - `SessionState`（Task 5，`src/shared/session-state.ts`，裁決 14）
  - `YesChefApi`（Task 8，`src/shared/ipc.ts`，以契約裁決 14 的定稿版為準）
  - `Markdown`、`MarkdownProps`（Task 9，`src/renderer/components/Markdown.tsx`）
  - `window.yeschef`（Task 8 的 `src/renderer/global.d.ts`）
- Produces:
  - `type ToolBlock = Extract<Block, { kind: 'tool' }>`（宣告在 `block-equals.ts`，由 `Conversation.tsx`
    再匯出一次，讓 Task 10 可以照契約寫 `import type { ToolBlock } from './Conversation.js'`）
  - `interface ConversationProps { view; historical; renderToolExtra? }`
  - `function Conversation(props: ConversationProps)`
  - `function useConversation(api: YesChefApi): { view: ConversationView; sessionState: SessionState }`
    （`src/renderer/hooks/useConversation.ts`，同檔另出 `appendEvents`、`INITIAL_SESSION_STATE`）
  - `appendEvents(prev: readonly Event[], batch: readonly Event[]): readonly Event[]`
    （同檔。裁決 22 的截斷規則，抽出來才測得到，見設計取捨三）
  - `blockEquals(a: Block, b: Block): boolean`、`blocksEqual(a, b): boolean`（`block-equals.ts`）
  - `NO_RESULT_TEXT`、`HISTORICAL_RAW_TEXT`、`PENDING_RAW_TEXT`、`formatValue(value: unknown): string`
    （`ToolCall.tsx`。文案做成常數是為了讓測試斷言與實作共用同一份字串，改文案不會讓測試變成空轉）

  **下游用法（Task 10 必看）**：`renderToolExtra` 進了 `Turn` 與 `ToolCall` 的 memo 比較函式，
  用參照比較。Task 10 傳進來的函式**必須**用 `useCallback` 包住，否則每次 App 重繪都是新函式，
  兩層 memo 全部失效，等於本 task 的效能工作歸零。另外 `ToolCall` 對每一個 tool block 都會呼叫
  `renderToolExtra`，不只在 `awaiting-approval` 時呼叫，Task 10 自行判斷該不該回傳內容。

  回傳型別一律不標註（不寫 `: JSX.Element`），沿用 Task 9 查證過的慣例：標了就得額外顯式 import
  `JSX` 型別，讓 TS 自己推論則不必。契約的 `export function Conversation(props: ConversationProps): JSX.Element`
  只有回傳標註這一處沒有照抄，參數型別與名稱逐字相同，推論出來的型別也相同。

- [ ] **Step 1: 寫失敗的測試**

先確認 `vitest.config.ts` 的 `test.include` 已經是 `'tests/**/*.test.{ts,tsx}'`（Task 9 改的）。
若還是 `'tests/**/*.test.ts'`，後面兩個測試檔**一次也不會被執行**，而且不是報錯是靜默跳過：
已實測把兩個 `.tsx` 測試檔放進 `tests/` 之後跑 `npx vitest run` 得到「Test Files 4 passed」
（只有既有的 `.ts` 檔），連指名 `npx vitest run tests/conversation.test.tsx` 都回
「No test files found, exiting with code 1」。改成 `{ts,tsx}` 之後同一批檔案跑出「Test Files 6 passed」，
兩種寫法都實跑過。

本 task 只加 coverage 的六個條目，其餘既有條目不動（裁決 19：每個 task 只增刪自己的檔案，
不重寫整份清單）：

```diff
   test: {
     include: ['tests/**/*.test.{ts,tsx}'],
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/renderer/components/block-equals.ts',
+        'src/renderer/components/Conversation.tsx',
+        'src/renderer/components/Turn.tsx',
+        'src/renderer/components/ToolCall.tsx',
+        'src/renderer/components/ThinkingBlock.tsx',
+        'src/renderer/hooks/useConversation.ts',
       ],
     },
   },
```

`tests/conversation.test.tsx`（純渲染，view 全部手工建構，不經過 `fold()`）：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Conversation } from '../src/renderer/components/Conversation.js'
import {
  HISTORICAL_RAW_TEXT,
  NO_RESULT_TEXT,
  PENDING_RAW_TEXT,
} from '../src/renderer/components/ToolCall.js'
import { blockEquals, blocksEqual } from '../src/renderer/components/block-equals.js'
import type { Block, ConversationView, Turn } from '../src/shared/fold.js'
import type { ToolBlock } from '../src/renderer/components/block-equals.js'

afterEach(() => {
  cleanup()
})

/**
 * 工具參數刻意用同一個物件：fold() 是把 Event 上的 input 原樣傳進 Block，
 * 而事件陣列是附加式的、元素本身從不重建，所以真實管線裡同一次工具呼叫的
 * input 在每一幀都是同一個物件參照。測試要模擬這個前提，blockEquals 才是
 * 在測它真正會遇到的輸入。
 */
const LS_INPUT = { command: 'ls' }

function tool(over: Partial<ToolBlock> = {}): ToolBlock {
  return { kind: 'tool', id: 'tu_1', name: 'Bash', input: LS_INPUT, status: 'done', ...over }
}

function viewOf(blocks: readonly Block[], role: Turn['role'] = 'assistant'): ConversationView {
  return { turns: [{ role, messageId: 'msg_1', blocks }], ended: false }
}

/** 展開工具卡片：卡片標頭是唯一的 .tool-head 按鈕。 */
function expand(container: HTMLElement, selector: string): void {
  const head = container.querySelector(selector)
  if (head === null) throw new Error('找不到可展開的標頭：' + selector)
  fireEvent.click(head)
}

describe('Conversation', () => {
  it('沒有任何 turn 時渲染空清單而不崩潰', () => {
    const { container } = render(<Conversation view={{ turns: [], ended: false }} historical={false} />)
    expect(container.querySelector('.conversation-list')).not.toBeNull()
    expect(container.querySelectorAll('.turn')).toHaveLength(0)
  })

  it('user 與 assistant 兩個 turn 各自渲染，順序不變', () => {
    const view: ConversationView = {
      turns: [
        { role: 'user', blocks: [{ kind: 'text', markdown: '幫我看看', complete: true }] },
        { role: 'assistant', messageId: 'msg_1', blocks: [{ kind: 'text', markdown: '好的', complete: true }] },
      ],
      ended: false,
    }
    const { container } = render(<Conversation view={view} historical={false} />)
    const turns = container.querySelectorAll('.turn')
    expect(turns).toHaveLength(2)
    expect(turns[0]?.className).toContain('turn-user')
    expect(turns[0]?.textContent).toContain('幫我看看')
    expect(turns[1]?.className).toContain('turn-assistant')
    expect(turns[1]?.textContent).toContain('好的')
  })

  // 裁決 10：text block 一律拆成 markdown／complete 兩個原始值傳給 Markdown。
  // 表格變成 <table> 證明真的走了 Markdown 的解析管線，不是直接印字串。
  it('text block 交給 Markdown 渲染，markdown 語法真的被解析', () => {
    const { container } = render(
      <Conversation view={viewOf([{ kind: 'text', markdown: '| a | b |\n|---|---|\n| 1 | 2 |', complete: true }])} historical={false} />
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  // complete 必須逐 block 傳遞，不能寫死。fold() 讓收過 block-stop 的 block complete=true，
  // 所以「只有最後一個未完成的 block 有游標」是逐字串流時的正確畫面。
  it('只有 complete 為 false 的 text block 尾端有游標', () => {
    const { container } = render(
      <Conversation
        view={viewOf([
          { kind: 'text', markdown: '已完成的第一段', complete: true },
          { kind: 'text', markdown: '還在寫的第二段', complete: false },
        ])}
        historical={false}
      />
    )
    const cursors = container.querySelectorAll('.markdown-cursor')
    expect(cursors).toHaveLength(1)
    const blocks = container.querySelectorAll('.markdown-block')
    expect(blocks[0]?.querySelector('.markdown-cursor')).toBeNull()
    expect(blocks[1]?.querySelector('.markdown-cursor')).not.toBeNull()
  })

  it('thinking block 預設摺疊，點開才看得到內容', () => {
    const { container } = render(
      <Conversation view={viewOf([{ kind: 'thinking', text: '我先確認目錄結構', complete: true }])} historical={false} />
    )
    expect(container.textContent).not.toContain('我先確認目錄結構')
    expand(container, '.thinking-head')
    expect(container.querySelector('.thinking-text')?.textContent).toBe('我先確認目錄結構')
  })

  it('tool block 預設摺疊成一行標頭，點開才看得到參數', () => {
    const { container } = render(<Conversation view={viewOf([tool()])} historical={false} />)
    expect(container.querySelector('.tool-head')?.textContent).toContain('Bash')
    expect(container.querySelector('.tool-body')).toBeNull()
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-input')?.textContent).toContain('"command": "ls"')
  })

  // streaming-input：inputPartial 是半截 JSON，只能原文顯示。
  it('streaming-input 顯示 inputPartial 原文，不嘗試解析', () => {
    const partial = '{"command":"npm ru'
    const { container } = render(
      <Conversation view={viewOf([tool({ status: 'streaming-input', input: undefined, inputPartial: partial })])} historical={false} />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-input-partial')?.textContent).toBe(partial)
    expect(container.querySelector('.tool-input')).toBeNull()
  })

  // 裁決 12：拒絕理由在 deniedReason，不在 result。
  it('denied 顯示 deniedReason，不把 result 當成拒絕理由', () => {
    const { container } = render(
      <Conversation
        view={viewOf([tool({ status: 'denied', deniedReason: '使用者不允許刪除檔案', result: 'Tool call was blocked' })])}
        historical={false}
      />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-denied')?.textContent).toBe('使用者不允許刪除檔案')
    expect(container.textContent).not.toContain('Tool call was blocked')
  })

  // 裁決 15：done 但沒有結果，要說出來而不是留白。
  it('done 且 result 為 undefined 時顯示「工具沒有回傳結果」', () => {
    const { container } = render(
      <Conversation view={viewOf([tool({ status: 'done', result: undefined })])} historical={false} />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-no-result')?.textContent).toBe(NO_RESULT_TEXT)
  })

  it('done 且有 result 時顯示 result，且不顯示「沒有回傳結果」', () => {
    const { container } = render(
      <Conversation view={viewOf([tool({ status: 'done', result: 'total 24\nsrc' })])} historical={false} />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-result')?.textContent).toContain('total 24')
    expect(container.querySelector('.tool-no-result')).toBeNull()
  })

  // 裁決 4：同一個 block（raw 都是 undefined），只有 historical 決定文案。
  // 兩個方向都要驗：漏了任一邊，「文案寫死」與「不看 historical」都測不出來。
  it('historical 為 true 時原始輸出區顯示歷史限制說明，為 false 時不顯示', () => {
    const block = tool({ status: 'done', result: 'ok', raw: undefined })

    const hist = render(<Conversation view={viewOf([block])} historical />)
    expand(hist.container, '.tool-head')
    expect(hist.container.querySelector('.tool-raw-absent')?.textContent).toBe(HISTORICAL_RAW_TEXT)

    cleanup()

    const live = render(<Conversation view={viewOf([block])} historical={false} />)
    expand(live.container, '.tool-head')
    expect(live.container.querySelector('.tool-raw-absent')?.textContent).toBe(PENDING_RAW_TEXT)
    expect(live.container.textContent).not.toContain(HISTORICAL_RAW_TEXT)
  })

  it('live 且有 raw 時顯示未經處理的 stdout 與 stderr', () => {
    const { container } = render(
      <Conversation
        view={viewOf([tool({ raw: { stdout: 'src\ntests', stderr: 'ls: warn', interrupted: false } })])}
        historical={false}
      />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-stdout')?.textContent).toBe('src\ntests')
    expect(container.querySelector('.tool-stderr')?.textContent).toBe('ls: warn')
  })

  // 規格 §8：不靜默丟棄。
  it('unknown block 可展開看到原始 JSON', () => {
    const raw = { type: 'system', subtype: '沒見過的子型別' }
    const { container } = render(<Conversation view={viewOf([{ kind: 'unknown', raw }])} historical={false} />)
    expect(container.querySelector('.unknown-head')).not.toBeNull()
    expect(container.querySelector('.unknown-raw')).toBeNull()
    expand(container, '.unknown-head')
    expect(container.querySelector('.unknown-raw')?.textContent).toContain('沒見過的子型別')
  })

  it('awaiting-approval：狀態標籤與 renderToolExtra 的結果都不必展開就看得到', () => {
    const block = tool({ status: 'awaiting-approval', input: { command: 'rm -rf /' } })
    const seen: ToolBlock[] = []
    const renderToolExtra = (b: ToolBlock) => {
      seen.push(b)
      return <div className="approval-card">要執行 {b.name} 嗎</div>
    }
    const { container } = render(
      <Conversation view={viewOf([block])} historical={false} renderToolExtra={renderToolExtra} />
    )
    expect(container.querySelector('.tool-status')?.textContent).toBe('等待批准')
    expect(container.querySelector('.tool-extra .approval-card')?.textContent).toBe('要執行 Bash 嗎')
    // 等待批准時預設展開，使用者不必多按一下就看得到完整 input（規格 §6）
    expect(container.querySelector('.tool-input')?.textContent).toContain('rm -rf /')
    expect(seen[0]).toBe(block)
  })

  it('renderToolExtra 沒給時不影響渲染，工具卡片照常出現', () => {
    const { container } = render(<Conversation view={viewOf([tool()])} historical={false} />)
    expect(container.querySelector('.tool-call')).not.toBeNull()
    expect(container.querySelector('.tool-extra')?.textContent).toBe('')
  })

  // memo 的比較函式漏欄位會讓畫面停在舊狀態。fold() 每幀產生全新的 Block 物件，
  // 所以這裡刻意用「內容不同但形狀相同」的新物件重繪。
  it('狀態從 running 變成 done 時，標頭的狀態標籤要跟著換（memo 比較函式不得漏欄位）', () => {
    const view1 = viewOf([tool({ status: 'running' })])
    const { container, rerender } = render(<Conversation view={view1} historical={false} />)
    expect(container.querySelector('.tool-status')?.textContent).toBe('執行中')

    // 只改 status，其餘欄位（含 result）逐字相同：這樣 memo 的比較函式若漏了 status，
    // 就沒有別的欄位替它把不相等這件事撿回來，突變才測得到。
    const view2 = viewOf([tool({ status: 'done' })])
    rerender(<Conversation view={view2} historical={false} />)
    expect(container.querySelector('.tool-status')?.textContent).toBe('完成')
  })

  it('串流中的 text 每幀變長時畫面跟著變長', () => {
    const { container, rerender } = render(
      <Conversation view={viewOf([{ kind: 'text', markdown: '第一', complete: false }])} historical={false} />
    )
    expect(container.textContent).toContain('第一')
    rerender(<Conversation view={viewOf([{ kind: 'text', markdown: '第一段更長', complete: false }])} historical={false} />)
    expect(container.textContent).toContain('第一段更長')
  })

  it('blockEquals 分辨 thinking／unknown 與跨型別的比較', () => {
    expect(blockEquals({ kind: 'thinking', text: 'x', complete: true }, { kind: 'thinking', text: 'x', complete: true })).toBe(true)
    expect(blockEquals({ kind: 'thinking', text: 'x', complete: true }, { kind: 'thinking', text: 'y', complete: true })).toBe(false)
    const raw = { note: '沒見過' }
    expect(blockEquals({ kind: 'unknown', raw }, { kind: 'unknown', raw })).toBe(true)
    expect(blockEquals({ kind: 'unknown', raw }, { kind: 'unknown', raw: { note: '沒見過' } })).toBe(false)
    expect(blockEquals({ kind: 'text', markdown: 'a', complete: true }, { kind: 'thinking', text: 'a', complete: true })).toBe(false)
    expect(blockEquals(tool(), { kind: 'unknown', raw: null })).toBe(false)
  })

  it('blocksEqual 逐項比較，長度不同直接判不等', () => {
    const a: readonly Block[] = [{ kind: 'text', markdown: 'x', complete: true }]
    expect(blocksEqual(a, a)).toBe(true)
    expect(blocksEqual(a, [{ kind: 'text', markdown: 'x', complete: true }])).toBe(true)
    expect(blocksEqual(a, [...a, { kind: 'text', markdown: 'y', complete: false }])).toBe(false)
  })

  it('blockEquals 認得內容相同的兩個新物件，也認得欄位不同', () => {
    const sharedRaw = { stdout: 'a', stderr: '', interrupted: false }
    expect(blockEquals(tool({ raw: sharedRaw }), tool({ raw: sharedRaw }))).toBe(true)
    expect(blockEquals(tool(), tool())).toBe(true)
    expect(blockEquals(tool(), tool({ status: 'error' }))).toBe(false)
    expect(blockEquals(tool(), tool({ deniedReason: '不給' }))).toBe(false)
    expect(blockEquals(tool(), tool({ raw: { stdout: 'a', stderr: '', interrupted: false } }))).toBe(false)
    expect(blockEquals({ kind: 'text', markdown: 'a', complete: false }, { kind: 'text', markdown: 'a', complete: true })).toBe(false)
    // input 用參照比較：內容相同但是不同物件時判為不等，代價只是多重繪一次，
    // 不會讓畫面停在舊資料（比較保守的方向）。
    expect(blockEquals(tool(), tool({ input: { command: 'ls' } }))).toBe(false)
  })

  it('input 含迴圈參照時不讓整個 turn 崩潰', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular['self'] = circular
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { container } = render(<Conversation view={viewOf([tool({ input: circular })])} historical={false} />)
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-input')?.textContent).toContain('object')
    spy.mockRestore()
  })

  // 裁決 17：session-end 帶 isError:true 時 fold() 會在 ConversationView 上設 error，
  // Conversation 要把它畫成一張獨立的錯誤卡片，不影響既有 cost 卡片的位置與條件。
  it('view.error 存在時渲染錯誤卡片，含標題、message 與 API 狀態', () => {
    const view: ConversationView = {
      turns: [{ role: 'assistant', messageId: 'msg_1', blocks: [{ kind: 'text', markdown: '算到一半', complete: false }] }],
      ended: true,
      error: { message: 'SDK 連線中斷', apiErrorStatus: 529 },
    }
    const { container } = render(<Conversation view={view} historical={false} />)
    const card = container.querySelector('[role="alert"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('對話因錯誤結束')
    expect(card?.textContent).toContain('SDK 連線中斷')
    expect(card?.textContent).toContain('API 狀態：529')
  })

  // ended 刻意是 true：驗的是「error 沒有值」這件事本身觸發不出卡片，不是靠「對話還沒結束」
  // 這個巧合擋住（否則把顯示條件誤改成看 view.ended 也會通過，見 Step 5 的 M8）。
  it('view.error 不存在時沒有錯誤卡片，即使對話已經正常結束', () => {
    const view: ConversationView = {
      turns: [{ role: 'assistant', messageId: 'msg_1', blocks: [{ kind: 'text', markdown: '正常結束', complete: true }] }],
      ended: true,
    }
    const { container } = render(<Conversation view={view} historical={false} />)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
```

`tests/use-conversation.test.tsx`（hook 與 App 的接線。App 的輸入框測試放這裡而不是另開第三個檔案，
因為它跟 hook 用的是同一個假 `YesChefApi`，兩者測的都是「renderer 怎麼接上 `window.yeschef`」）：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { appendEvents, useConversation } from '../src/renderer/hooks/useConversation.js'
import { App, LIVE_PLACEHOLDER, VIEWING_PLACEHOLDER } from '../src/renderer/App.js'
import { HISTORICAL_RAW_TEXT } from '../src/renderer/components/ToolCall.js'
import type { Event } from '../src/shared/events.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { YesChefApi, SessionSummary } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

interface Fake {
  readonly api: YesChefApi
  emitEvents(events: readonly Event[]): void
  emitState(state: SessionState): void
  readonly sent: string[]
  readonly unsubscribed: () => number
}

/**
 * 假的 YesChefApi。只實作 Task 9B 會用到的三個成員，其餘照介面補上會拋錯的樁，
 * 這樣元件若不小心呼叫了不該呼叫的東西，測試會直接炸而不是靜默通過。
 */
function createFake(): Fake {
  const eventCbs: Array<(events: readonly Event[]) => void> = []
  const stateCbs: Array<(state: SessionState) => void> = []
  const sent: string[] = []
  let unsubscribed = 0

  const api: YesChefApi = {
    onEvents(cb) {
      eventCbs.push(cb)
      return () => {
        unsubscribed += 1
      }
    },
    onSessionState(cb) {
      stateCbs.push(cb)
      return () => {
        unsubscribed += 1
      }
    },
    onApprovalAsk() {
      return () => undefined
    },
    sendInput(text) {
      sent.push(text)
    },
    replyApproval() {
      throw new Error('Task 9B 不該呼叫 replyApproval')
    },
    listSessions(): Promise<readonly SessionSummary[]> {
      throw new Error('Task 9B 不該呼叫 listSessions')
    },
    startNew() {
      throw new Error('Task 9B 不該呼叫 startNew')
    },
    openHistory() {
      throw new Error('Task 9B 不該呼叫 openHistory')
    },
    projectDir: '/Users/x/Projects/demo',
  }

  return {
    api,
    emitEvents(events) {
      act(() => {
        eventCbs.forEach((cb) => cb(events))
      })
    },
    emitState(state) {
      act(() => {
        stateCbs.forEach((cb) => cb(state))
      })
    },
    sent,
    unsubscribed: () => unsubscribed,
  }
}

const say = (text: string): Event => ({ kind: 'user-text', text })
const RESET: Event = { kind: 'reset' }

/*
 * appendEvents 直接測，不透過 hook：`fold()` 自己也把 `reset` 當成「回到空 view」
 * （裁決 22 給 Task 4 的那一條），所以 hook 少截一次，`view` 看起來完全一樣，
 * 差別只在累積陣列會一直長下去。這件事只有對著純函式才觀察得到。
 */
describe('appendEvents', () => {
  it('批次裡沒有 reset 時原樣接在後面', () => {
    expect(appendEvents([say('舊')], [say('新一'), say('新二')])).toEqual([
      say('舊'),
      say('新一'),
      say('新二'),
    ])
  })

  it('批次裡有 reset 時只留它之後的事件，先前累積的與 reset 本身都不留', () => {
    expect(appendEvents([say('舊')], [RESET, say('新')])).toEqual([say('新')])
  })

  it('批次裡有兩個 reset 時以最後一個為準', () => {
    expect(appendEvents([say('舊')], [RESET, say('中間'), RESET, say('新')])).toEqual([say('新')])
  })

  it('批次只有 reset 時回空陣列', () => {
    expect(appendEvents([say('舊')], [RESET])).toEqual([])
  })
})

describe('useConversation', () => {
  it('初始為 idle 與空對話', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))
    expect(result.current.sessionState).toEqual({ kind: 'idle' })
    expect(result.current.view.turns).toHaveLength(0)
  })

  it('多批事件以不可變方式累積，先後順序不變', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitEvents([say('第一句')])
    fake.emitEvents([say('第二句'), say('第三句')])

    expect(result.current.view.turns).toHaveLength(3)
    expect(result.current.view.turns.map((t) => t.blocks[0])).toEqual([
      { kind: 'text', markdown: '第一句', complete: true },
      { kind: 'text', markdown: '第二句', complete: true },
      { kind: 'text', markdown: '第三句', complete: true },
    ])
  })

  it('批次裡 reset 之前的事件不進畫面', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitEvents([say('上一場的話')])
    fake.emitEvents([RESET, say('第一句'), say('第二句')])

    expect(result.current.view.turns.map((t) => t.blocks[0])).toEqual([
      { kind: 'text', markdown: '第一句', complete: true },
      { kind: 'text', markdown: '第二句', complete: true },
    ])
  })

  it('reset 自己走一批也算數，之後的事件從空畫面重新累積', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitEvents([say('A 場')])
    fake.emitEvents([RESET])
    expect(result.current.view.turns).toHaveLength(0)

    fake.emitEvents([say('B 場')])

    expect(result.current.view.turns).toHaveLength(1)
    expect(result.current.view.turns[0]?.blocks[0]).toEqual({
      kind: 'text',
      markdown: 'B 場',
      complete: true,
    })
  })

  it('同一批有兩個 reset 時只留最後一個之後的事件', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitEvents([say('丟掉一'), RESET, say('丟掉二'), RESET, say('留下來')])

    expect(result.current.view.turns).toHaveLength(1)
    expect(result.current.view.turns[0]?.blocks[0]).toEqual({
      kind: 'text',
      markdown: '留下來',
      complete: true,
    })
  })

  // 裁決 22 的三處反例，逐一釘住：狀態變了，事件一律不清。
  it('live 變 idle 不清事件，裁決 17 的錯誤卡片留在畫面上', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitState({ kind: 'live', sessionId: 's-1' })
    fake.emitEvents([say('跑一下'), { kind: 'session-end', isError: true, errorMessage: '連線中斷' }])
    fake.emitState({ kind: 'idle' })

    expect(result.current.view.turns).toHaveLength(1)
    expect(result.current.view.error?.message).toBe('連線中斷')
  })

  it('viewing 變 live（輸入即 resume）不清事件，歷史留在畫面上', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitState({ kind: 'viewing', sessionId: 's-a' })
    fake.emitEvents([say('歷史的一句')])
    fake.emitState({ kind: 'live', sessionId: 's-a' })

    expect(result.current.sessionState).toEqual({ kind: 'live', sessionId: 's-a' })
    expect(result.current.view.turns).toHaveLength(1)
  })

  it('同一場的狀態重送不清空已累積的事件', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitState({ kind: 'live', sessionId: 's-1' })
    fake.emitEvents([say('串到一半')])
    fake.emitState({ kind: 'live', sessionId: 's-1' })

    expect(result.current.view.turns).toHaveLength(1)
  })

  it('unmount 時兩個訂閱都解除', () => {
    const fake = createFake()
    const { unmount } = renderHook(() => useConversation(fake.api))
    unmount()
    expect(fake.unsubscribed()).toBe(2)
  })
})

describe('App', () => {
  it('Enter 送出並清空輸入框', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '幫我跑測試' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(fake.sent).toEqual(['幫我跑測試'])
    expect(input.value).toBe('')
  })

  it('Shift+Enter 不送出，內容保留', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '第一行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(fake.sent).toEqual([])
    expect(input.value).toBe('第一行')
  })

  it('輸入法組字中的 Enter 不送出（中文輸入選字用的 Enter）', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '測試' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    expect(fake.sent).toEqual([])
  })

  it('只有空白時不送出', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(fake.sent).toEqual([])
  })

  it('viewing 時輸入框提示改成接續這條對話', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    expect(input?.placeholder).toBe(LIVE_PLACEHOLDER)

    fake.emitState({ kind: 'viewing', sessionId: 's-1' })
    expect(input?.placeholder).toBe(VIEWING_PLACEHOLDER)
  })

  it('事件到達時對話出現在畫面上', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

    fake.emitEvents([say('你好'), { kind: 'text', messageId: 'm1', index: 0, text: '哈囉' }])

    expect(container.querySelector('.conversation-list')?.textContent).toContain('你好')
    expect(container.querySelector('.conversation-list')?.textContent).toContain('哈囉')
  })

  // 裁決 4 的端到端接線：historical 是從 sessionState.kind 推出來的，不是寫死的 prop。
  it('viewing 時工具卡片展開後顯示歷史對話沒有原始輸出', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

    fake.emitState({ kind: 'viewing', sessionId: 's-1' })
    fake.emitEvents([
      { kind: 'tool-use', messageId: 'm1', index: 0, id: 'tu_9', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 'tu_9', content: 'src', isError: false },
      { kind: 'session-end', isError: false },
    ])

    const head = container.querySelector('.tool-head')
    if (head === null) throw new Error('找不到工具卡片')
    fireEvent.click(head)

    expect(container.querySelector('.tool-raw-absent')?.textContent).toBe(HISTORICAL_RAW_TEXT)
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`
Expected: FAIL，訊息是解析不到 `../src/renderer/components/Conversation.js`、`ToolCall.js`、
`block-equals.js`、`../src/renderer/hooks/useConversation.js`（檔案都還不存在），
以及 `App.js` 沒有匯出 `LIVE_PLACEHOLDER`／`VIEWING_PLACEHOLDER`。
若看到「No test files found, exiting with code 1」，是 Task 9 的 `include` glob 沒改到，不是預期的失敗。

- [ ] **Step 3: 寫最小實作**

沒有新相依。Task 9 已經裝好 `react`／`react-dom`／`@types/react`／`@types/react-dom`／
`@testing-library/react`／`jsdom`，也已經在 `tsconfig.json` 加了 `"jsx": "react-jsx"`。

**3a. `src/renderer/components/block-equals.ts`**（純函式，memo 的比較依據）：

```typescript
import type { Block } from '../../shared/fold.js'

export type ToolBlock = Extract<Block, { kind: 'tool' }>

function rawEquals(a: ToolBlock['raw'], b: ToolBlock['raw']): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.stdout === b.stdout && a.stderr === b.stderr && a.interrupted === b.interrupted
}

export function blockEquals(a: Block, b: Block): boolean {
  if (a === b) return true
  switch (a.kind) {
    case 'text':
      return b.kind === 'text' && a.markdown === b.markdown && a.complete === b.complete
    case 'thinking':
      return b.kind === 'thinking' && a.text === b.text && a.complete === b.complete
    case 'unknown':
      return b.kind === 'unknown' && Object.is(a.raw, b.raw)
    case 'tool':
      return (
        b.kind === 'tool' &&
        a.id === b.id &&
        a.name === b.name &&
        a.status === b.status &&
        a.inputPartial === b.inputPartial &&
        a.deniedReason === b.deniedReason &&
        Object.is(a.input, b.input) &&
        Object.is(a.result, b.result) &&
        rawEquals(a.raw, b.raw)
      )
  }
}

export function blocksEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((block, i) => {
    const other = b[i]
    return other !== undefined && blockEquals(block, other)
  })
}
```

`input`／`result` 用 `Object.is`、`raw` 逐欄位比，理由見開頭的設計取捨一。`unknown` 的 `raw` 同樣用
參照比較：它是 Task 3 直接從原始訊息帶過來的物件，同一筆事件在每一幀都是同一個參照。

**3b. `src/renderer/components/ToolCall.tsx`**：

```tsx
import { memo, useState, type ReactNode } from 'react'
import { blockEquals, type ToolBlock } from './block-equals.js'

export interface ToolCallProps {
  readonly block: ToolBlock
  readonly historical: boolean
  readonly renderExtra?: (block: ToolBlock) => ReactNode
}

const STATUS_LABEL: Record<ToolBlock['status'], string> = {
  'streaming-input': '接收參數中',
  'awaiting-approval': '等待批准',
  denied: '已拒絕',
  running: '執行中',
  done: '完成',
  error: '失敗',
}

export const NO_RESULT_TEXT = '工具沒有回傳結果'
export const HISTORICAL_RAW_TEXT = '這是歷史對話，沒有保存原始輸出'
export const PENDING_RAW_TEXT = '尚未收到原始輸出'

/** JSON.stringify 會對迴圈參照丟例外，也會對 undefined 回傳 undefined，兩種都要接住。 */
export function formatValue(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function ToolCallImpl({ block, historical, renderExtra }: ToolCallProps) {
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  const open = override ?? block.status === 'awaiting-approval'
  const settled = block.status === 'done' || block.status === 'error'

  return (
    <section className="tool-call" data-status={block.status}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <span className="tool-name">{block.name === '' ? '（未知工具）' : block.name}</span>
        <span className="tool-status">{STATUS_LABEL[block.status]}</span>
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>

      {open && (
        <div className="tool-body">
          <h4 className="tool-section-title">參數</h4>
          {block.status === 'streaming-input' ? (
            <pre className="tool-input-partial">{block.inputPartial ?? ''}</pre>
          ) : (
            <pre className="tool-input">
              {block.input === undefined ? '（沒有收到參數）' : formatValue(block.input)}
            </pre>
          )}

          {block.status === 'denied' && (
            <>
              <h4 className="tool-section-title">拒絕原因</h4>
              <p className="tool-denied">{block.deniedReason ?? '（沒有提供拒絕原因）'}</p>
            </>
          )}

          {settled && (
            <>
              <h4 className="tool-section-title">結果</h4>
              {block.result === undefined ? (
                <p className="tool-no-result">{NO_RESULT_TEXT}</p>
              ) : (
                <pre className="tool-result">{formatValue(block.result)}</pre>
              )}
            </>
          )}

          <h4 className="tool-section-title">原始輸出</h4>
          {historical ? (
            <p className="tool-raw-absent">{HISTORICAL_RAW_TEXT}</p>
          ) : block.raw === undefined ? (
            <p className="tool-raw-absent">{PENDING_RAW_TEXT}</p>
          ) : (
            <div className="tool-raw">
              <pre className="tool-stdout">{block.raw.stdout}</pre>
              <pre className="tool-stderr">{block.raw.stderr}</pre>
              {block.raw.interrupted && <p className="tool-interrupted">執行被中斷</p>}
            </div>
          )}
        </div>
      )}

      <div className="tool-extra">{renderExtra?.(block)}</div>
    </section>
  )
}

export const ToolCall = memo(
  ToolCallImpl,
  (prev, next) =>
    blockEquals(prev.block, next.block) &&
    prev.historical === next.historical &&
    prev.renderExtra === next.renderExtra
)
```

四個對應裁決的地方，都刻意寫成三個分支而不是「有值就顯示」：`streaming-input` 走
`inputPartial` 原文（半截 JSON 不能 parse），`denied` 走 `deniedReason`（裁決 12），
`done`／`error` 沒有 `result` 時說出「沒有回傳結果」（裁決 15），原始輸出區在 `historical`
為真時說明歷史對話沒有保存（裁決 4）。每一格都有文字，沒有任何一個狀態會給出空白區塊。

**3c. `src/renderer/components/ThinkingBlock.tsx`**：

```tsx
import { memo, useState } from 'react'

export interface ThinkingBlockProps {
  readonly text: string
  readonly complete: boolean
}

function ThinkingBlockImpl({ text, complete }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  return (
    <section className="thinking-block">
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {complete ? '思考過程' : '思考中'}
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && <pre className="thinking-text">{text}</pre>}
    </section>
  )
}

export const ThinkingBlock = memo(ThinkingBlockImpl)
```

thinking 的 props 是兩個原始值（裁決 10 對 `Markdown` 的同一個理由），所以這裡用預設的淺比較就夠，
不必自訂比較函式。thinking 內容不走 markdown 解析：它是模型的內部推理，用 `<pre>` 原樣呈現最誠實。

**3d. `src/renderer/components/Turn.tsx`**：

```tsx
import { memo, useState, type ReactNode } from 'react'
import type { Block, Turn as TurnModel } from '../../shared/fold.js'
import { Markdown } from './Markdown.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolCall, formatValue } from './ToolCall.js'
import { blocksEqual, type ToolBlock } from './block-equals.js'

export interface TurnProps {
  readonly turn: TurnModel
  readonly historical: boolean
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
}

/** 規格 §8：認不出來的事件渲染成可展開的原始 JSON，不靜默丟棄。 */
function UnknownBlock({ raw }: { readonly raw: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="unknown-block">
      <button
        type="button"
        className="unknown-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        未知事件
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && <pre className="unknown-raw">{formatValue(raw)}</pre>}
    </section>
  )
}

function renderBlock(
  block: Block,
  index: number,
  historical: boolean,
  renderToolExtra?: (block: ToolBlock) => ReactNode
) {
  switch (block.kind) {
    case 'text':
      return <Markdown key={index} markdown={block.markdown} complete={block.complete} />
    case 'thinking':
      return <ThinkingBlock key={index} text={block.text} complete={block.complete} />
    case 'tool':
      return (
        <ToolCall
          key={index}
          block={block}
          historical={historical}
          {...(renderToolExtra === undefined ? {} : { renderExtra: renderToolExtra })}
        />
      )
    case 'unknown':
      return <UnknownBlock key={index} raw={block.raw} />
  }
}

const ROLE_LABEL: Record<TurnModel['role'], string> = { user: '你', assistant: 'Claude' }

function TurnImpl({ turn, historical, renderToolExtra }: TurnProps) {
  return (
    <article className={'turn turn-' + turn.role}>
      <div className="turn-role">{ROLE_LABEL[turn.role]}</div>
      <div className="turn-blocks">
        {turn.blocks.map((block, i) => renderBlock(block, i, historical, renderToolExtra))}
      </div>
    </article>
  )
}

export const Turn = memo(
  TurnImpl,
  (prev, next) =>
    prev.historical === next.historical &&
    prev.renderToolExtra === next.renderToolExtra &&
    prev.turn.role === next.turn.role &&
    prev.turn.messageId === next.turn.messageId &&
    blocksEqual(prev.turn.blocks, next.turn.blocks)
)
```

`renderBlock` 的 `switch` 沒有 `default`：`Block` 是四選一的聯集，少處理一種 TS 會在編譯期報錯，
這比執行期的 fallback 早得多。block 的 key 用陣列索引，因為 `fold()` 產出的 block 只會在尾端增加或
原地取代，不會重新排序（`placeBlock` 命中時是 `records.map` 就地換掉，順序不動）。

`renderToolExtra` 為 `undefined` 時用展開語法整個不傳，而不是傳 `renderExtra={undefined}`：
兩者對 React 是同一件事，但前者在 `exactOptionalPropertyTypes` 之類的嚴格設定下也成立。

**3e. `src/renderer/components/Conversation.tsx`**：

```tsx
import type { ReactNode } from 'react'
import type { ConversationView } from '../../shared/fold.js'
import { Turn } from './Turn.js'
import type { ToolBlock } from './block-equals.js'
import './Conversation.css'

export type { ToolBlock }

export interface ConversationProps {
  readonly view: ConversationView
  readonly historical: boolean
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
}

export function Conversation({ view, historical, renderToolExtra }: ConversationProps) {
  return (
    <div className="conversation-list">
      {view.turns.map((turn, i) => (
        <Turn
          key={turn.messageId ?? 'turn-' + String(i)}
          turn={turn}
          historical={historical}
          {...(renderToolExtra === undefined ? {} : { renderToolExtra })}
        />
      ))}
      {view.error !== undefined && (
        <div className="error-card" role="alert">
          <p className="error-title">對話因錯誤結束</p>
          {view.error.message !== undefined && <p className="error-message">{view.error.message}</p>}
          {view.error.apiErrorStatus !== undefined && (
            <p className="error-status">API 狀態：{String(view.error.apiErrorStatus)}</p>
          )}
        </div>
      )}
      {view.ended && view.cost !== undefined && (
        <p className="conversation-cost">
          {view.cost.turns === undefined ? '' : String(view.cost.turns) + ' 輪'}
          {view.cost.usd === undefined ? '' : ' · US$' + view.cost.usd.toFixed(4)}
        </p>
      )}
    </div>
  )
}
```

`Conversation` 本身不包 memo：它的 `view` prop 每幀都是新物件，包了也不會命中，而它自己只做一次
`map`，成本在 `Turn` 那一層擋掉就夠了。turn 的 key 優先用 `messageId`（assistant turn 的穩定身分），
user turn 沒有 `messageId`，退回索引，這也是穩定的，因為 turn 只會在尾端增加。

`cost` 那一段是規格 §8「SDK query 中途錯誤要渲染成卡片」的一半：`session-end` 帶回來的花費與
輪數顯示在對話尾端。另一半是裁決 17 定案的 `.error-card`：`view.error` 存在時（`fold()` 收到
`isError: true` 的 `session-end` 時設定，`isError: false` 時不設，屬於 Task 4 的範圍，本 task
只假設欄位存在並渲染）在 turns 之後、cost 卡片之前顯示一張卡片，`message`／`apiErrorStatus`
各自有值才顯示對應那一行，位置與 cost 卡片互不影響，cost 卡片原本的顯示條件不變。

**3f. `src/renderer/components/Conversation.css`**：

```css
.conversation-list { flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding: 16px; }
.turn { display: grid; grid-template-columns: 72px 1fr; gap: 12px; }
.turn-role { opacity: 0.6; }
.tool-call, .thinking-block, .unknown-block { border: 1px solid #2a2d24; border-radius: 6px; }
.tool-head, .thinking-head, .unknown-head {
  display: flex; gap: 8px; width: 100%; padding: 6px 10px;
  background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.tool-status { opacity: 0.6; }
.chevron { margin-left: auto; }
.tool-body { padding: 0 10px 10px; }
.tool-section-title { margin: 8px 0 4px; font-size: 0.85em; opacity: 0.6; font-weight: normal; }
.tool-input, .tool-input-partial, .tool-result, .tool-stdout, .tool-stderr, .thinking-text, .unknown-raw {
  margin: 0; padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
}
.tool-stderr:empty { display: none; }
.tool-raw-absent, .tool-no-result { opacity: 0.6; font-style: italic; }
.tool-call[data-status='denied'] { border-color: #6d3b3b; }
.tool-call[data-status='error'] { border-color: #6d5a3b; }
.tool-call[data-status='awaiting-approval'] { border-color: #3b556d; }
.error-card { border: 1px solid #6d3b3b; border-radius: 6px; padding: 10px; }
.error-title { margin: 0 0 4px; font-weight: bold; }
.error-message, .error-status { margin: 4px 0 0; opacity: 0.8; }
.conversation-cost { opacity: 0.5; font-size: 0.85em; }
```

`data-status` 放在 DOM 上讓狀態的顏色由 CSS 決定，元件不必為了配色多帶一組 className。
`.tool-stderr:empty` 讓沒有 stderr 的工具不會多出一塊空白，但 DOM 節點仍在（測試可以斷言它是空字串，
而不是斷言它不存在，兩者的意思不一樣）。

**3g. `src/renderer/hooks/useConversation.ts`**：

```typescript
import { useEffect, useMemo, useState } from 'react'
import type { Event } from '../../shared/events.js'
import type { YesChefApi } from '../../shared/ipc.js'
import type { SessionState } from '../../shared/session-state.js'
import { fold, type ConversationView } from '../../shared/fold.js'

export const INITIAL_SESSION_STATE: SessionState = { kind: 'idle' }

interface Accumulated {
  readonly state: SessionState
  readonly events: readonly Event[]
}

const INITIAL_ACCUMULATED: Accumulated = { state: INITIAL_SESSION_STATE, events: [] }

/** 批次裡最後一個 reset 的位置，沒有就是 -1。不用 Array.prototype.findLastIndex：那是 ES2023，
 *  tsconfig 的 target 是 ES2022，型別上看不到它。 */
function lastResetIndex(batch: readonly Event[]): number {
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    if (batch[i]?.kind === 'reset') return i
  }
  return -1
}

/**
 * 附加一批事件（裁決 22）。批次裡有 `reset` 時，只保留最後一個 `reset` 之後的事件，
 * 先前累積的全部丟掉，`reset` 本身也不留。
 *
 * `fold()` 自己也認得 `reset`，所以這裡少截一次不會讓畫面出錯，只會讓累積陣列一直長下去。
 * 抽成匯出的純函式是為了讓那件事測得到（Step 5 的 M1）。
 */
export function appendEvents(
  prev: readonly Event[],
  batch: readonly Event[]
): readonly Event[] {
  const cut = lastResetIndex(batch)
  return cut === -1 ? [...prev, ...batch] : batch.slice(cut + 1)
}

export function useConversation(api: YesChefApi): {
  readonly view: ConversationView
  readonly sessionState: SessionState
} {
  const [acc, setAcc] = useState<Accumulated>(INITIAL_ACCUMULATED)

  useEffect(() => {
    const offEvents = api.onEvents((batch) => {
      setAcc((prev) =>
        batch.length === 0 ? prev : { ...prev, events: appendEvents(prev.events, batch) }
      )
    })
    const offState = api.onSessionState((next) => {
      setAcc((prev) => ({ ...prev, state: next }))
    })
    return () => {
      offEvents()
      offState()
    }
  }, [api])

  const view = useMemo(() => fold(acc.events), [acc.events])
  return { view, sessionState: acc.state }
}
```

三個細節：空批次直接回原本的 state（不產生新物件，省掉一次沒有內容的重繪）；事件用展開語法附加，
不用 `push`（不可變規則）；`useMemo` 的依賴是 `acc.events` 這個陣列的參照，只有真的收到新事件時
才會重跑 `fold()`，`sessionState` 自己變動不會觸發整份重算。

`onSessionState` 這一支只換 `state`，任何情況都不動 `events`（裁決 22）。主程序在同一場對話裡重送
同一個狀態、query 結束後從 `live` 回到 `idle`、輸入接續歷史時從 `viewing` 轉 `live`，這三種到達都不會
影響畫面內容。

`useEffect` 的依賴是 `[api]`。實務上 `window.yeschef` 由 preload 建立一次就不再變，所以訂閱只做一次；
測試裡傳的假 api 也是同一個物件。若哪天 api 真的換了，effect 會先解除舊訂閱再訂閱新的，不會漏掉清理。

**3h. `src/renderer/App.tsx`**（Task 9 的版本改兩處：對話佔位換成真的 `Conversation`，加輸入框）：

```tsx
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Conversation } from './components/Conversation.js'
import { useConversation } from './hooks/useConversation.js'
import type { SessionState } from '../shared/session-state.js'
import './App.css'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly onSend: (text: string) => void
}

function Composer({ placeholder, onSend }: ComposerProps) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        className="composer-input"
        aria-label="輸入訊息"
        rows={3}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="composer-send">送出</button>
    </form>
  )
}

function placeholderFor(state: SessionState): string {
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

export function App() {
  const { view, sessionState } = useConversation(window.yeschef)

  return (
    <div className="app">
      <aside className="sidebar">
        <p className="placeholder">Recents（Task 11）</p>
      </aside>
      <main className="conversation">
        <Conversation view={view} historical={sessionState.kind === 'viewing'} />
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => window.yeschef.sendInput(text)}
        />
      </main>
    </div>
  )
}
```

`<aside className="sidebar">` 那一段維持 Task 9 交出來的樣子，本 task 一個字都不動（含它的寬度寫法）。

`e.nativeEvent.isComposing` 這一行是給中文輸入用的：注音或拼音選字時按的 Enter 會先走一次 keydown，
沒有這個判斷會在選字的當下把半成品送出去。這是 macOS 上用中文輸入的人每天都會踩到的情況，不是假想威脅。

送出前 `trim()`，空白字串不送：規格沒有明文，但送一則只有空白的訊息會白白起一次 query。
`Composer` 自己持有輸入文字，不上提到 `App`：文字只有送出的那一刻需要被外面知道。

批准時「輸入框停用」（規格 §6）本 task 不做：判斷依據是有沒有待決的批准請求，
而那份資料由 Task 10 的 `useApprovals` 持有。Task 10 接手時給 `Composer` 加一個 `disabled` prop 即可。

**3i. `src/renderer/App.css`**（`.conversation` 改一條、加 `.composer` 與 `.composer-input` 兩條；下面是改完之後的完整檔案，逐字取代 Task 9 那一份。`html, body, #root`／`.app`／`.sidebar` 三條與 Task 9 相同，一字不改）：

```css
html,
body,
#root {
  height: 100%;
  margin: 0;
}

.app {
  --sidebar-width: 280px;

  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  height: 100%;
  font-family: ui-monospace, Menlo, monospace;
  color: #d8dcd4;
  background: #12140f;
}

.sidebar {
  border-right: 1px solid #2a2d24;
  overflow-y: auto;
}

.conversation { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.placeholder { padding: 12px; opacity: 0.6; }
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #2a2d24; }
.composer-input { flex: 1 1 auto; resize: vertical; font: inherit; }
```

捲動從 `.conversation` 移到 `.conversation-list`：輸入框要固定在底部，只有訊息清單捲動。
`min-height: 0` 是 flex 子項要能捲動的必要條件（預設 `min-height: auto` 會讓它被內容撐開而不出現捲軸）。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`
Expected: PASS，43 個測試（`conversation` 23、`use-conversation` 20）。已在 worktree 用材料化的
`fold.ts`（含裁決 17 的 `ConversationView.error?` 欄位與裁決 22 的 `case 'reset'`）實測，實際輸出是
「Test Files 2 passed (2)」「Tests 43 passed (43)」。

Run: `npm run typecheck`
Expected: 無錯誤。已在 worktree 實測 `npx tsc --noEmit` 退出碼 0。實測的前提是先把
`src/renderer/terminal.ts`、`src/preload/terminal.ts`、`src/main/pty-host.ts`（Task 0 刪除）、
`src/main/index.ts`（Task 0 改寫）、`tests/ipc.test.ts`（Task 8 改寫）移出去，否則它們對舊
`shared/ipc.ts` 的引用會蓋掉真正的錯誤訊息。本 task 產出的九個檔案自身沒有任何型別錯誤。

Run: `npm test`
Expected: PASS，總數在既有基礎上加 43。全專案總數要看當下材料化了哪些上游 task，本次修訂的
worktree（Task 3／4／4B／5／8 的 shared 型別與 `global.d.ts`、Task 9／9B／10 的程式碼與測試，
加上 repo 既有的 `cdp`／`layout`／`measure-memory`／`spawn-args` 四個測試檔）跑出來是
「Test Files 9 passed，Tests 139 passed」。

Run: `npx vitest run --coverage`
Expected: 新增檔案的敘述覆蓋率都在 89% 以上。下表是 2026-09-02 晚間依裁決 22 修訂後，用
`npx vitest run --coverage tests/conversation.test.tsx tests/use-conversation.test.tsx` 實測的值
（coverage 的 `include` 暫時加上 `src/renderer/**/*.{ts,tsx}` 才量得到元件）。

| 檔案 | % Stmts | % Branch |
|---|---:|---:|
| `Conversation.tsx` | 100 | 88.23 |
| `ToolCall.tsx` | 93.75 | 75.67 |
| `ThinkingBlock.tsx` | 100 | 83.33 |
| `block-equals.ts` | 89.47 | 84.21 |
| `useConversation.ts` | 100 | 83.33 |

`Turn.tsx` 與 `Markdown.tsx` 兩個檔案在 v8 provider 的報表裡沒有出現獨立的一列（元件層的測試
確實渲染過它們，M5 的突變也是掛在 `Turn.tsx` 上並且變紅）。這兩列的數字暫缺，實作者跑
`--coverage` 時若看到它們就照實補上。

未覆蓋的分支都是防禦性的空值處理（`inputPartial ?? ''`、`deniedReason ?? '（沒有提供拒絕原因）'`、
`name === '' ? '（未知工具）'`、`interrupted` 為真的那一支）。這些在正常資料流下不會發生，
留著是因為它們代表「資料缺了也要有東西可看」，不是死碼。

- [ ] **Step 5: 突變測試（強制步驟，八個突變全部實跑過）**

每一個突變都照 Step 3 的完整程式碼改過、跑
`npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`（43 個測試）、
記下變紅的測試名稱、還原、確認回綠。

| # | 突變 | 變紅的測試 | 實測結果 |
|---|---|---|---|
| M1（強制：裁決 22 的 reset） | `appendEvents` 的 `return cut === -1 ? [...prev, ...batch] : batch.slice(cut + 1)` 改成一律 `return [...prev, ...batch]` | 「批次裡有 reset 時只留它之後的事件，先前累積的與 reset 本身都不留」「批次裡有兩個 reset 時以最後一個為準」「批次只有 reset 時回空陣列」 | 紅，3 failed / 40 passed。三條都在 `appendEvents` 那一組 |
| M2（強制：裁決 4 的文案開關） | `ToolCall` 的 `{historical ? <p>{HISTORICAL_RAW_TEXT}</p> : block.raw === undefined ? ...}` 拿掉 `historical` 那一支 | 「historical 為 true 時原始輸出區顯示歷史限制說明，為 false 時不顯示」「viewing 時工具卡片展開後顯示歷史對話沒有原始輸出」 | 紅，2 failed / 41 passed。歷史對話的工具改顯示「尚未收到原始輸出」，等於告訴使用者再等一下，而它永遠不會來 |
| M3（裁決 12） | 拒絕原因那一行改成 `{formatValue(block.result)}`（Task 4B 定稿前的做法） | 「denied 顯示 deniedReason，不把 result 當成拒絕理由」 | 紅，1 failed / 42 passed。畫面顯示 SDK 合成的 `Tool call was blocked`，而不是使用者拒絕的理由 |
| M4（裁決 15） | 結果區改成無條件的 `<pre className="tool-result">{formatValue(block.result)}</pre>` | 「done 且 result 為 undefined 時顯示『工具沒有回傳結果』」 | 紅，1 failed / 42 passed。`formatValue(undefined)` 回空字串，畫面是一塊空白 |
| M5 | `Turn` 的 `<Markdown ... complete={block.complete} />` 改成 `complete` 寫死 | 「只有 complete 為 false 的 text block 尾端有游標」 | 紅，1 failed / 42 passed。串流中的最後一段沒有游標，看起來像已經講完 |
| M6 | `blockEquals` 的 tool 分支拿掉 `a.status === b.status &&` | 「狀態從 running 變成 done 時，標頭的狀態標籤要跟著換（memo 比較函式不得漏欄位）」「blockEquals 認得內容相同的兩個新物件，也認得欄位不同」 | 紅，2 failed / 41 passed |
| M7 | `streaming-input` 的參數區改成 `{formatValue(block.input)}` | 「streaming-input 顯示 inputPartial 原文，不嘗試解析」 | 紅，1 failed / 42 passed。串流中的 `input` 還是 undefined，畫面全空 |
| M8（裁決 17，強制） | `Conversation` 錯誤卡片的顯示條件從 `view.error !== undefined` 改成 `view.ended`（不看 error） | 「view.error 不存在時沒有錯誤卡片，即使對話已經正常結束」「viewing 時工具卡片展開後顯示歷史對話沒有原始輸出」 | 紅，2 failed / 41 passed。兩條測試的 view 都是 `ended: true` 但沒帶 `error`，`view.error.message` 讀到 `undefined.message` 直接拋例外，整棵樹連帶炸掉，比單純多顯示一張卡片更明顯 |

八個突變逐一還原後都跑回「Test Files 2 passed (2)」「Tests 43 passed (43)」，與突變前逐字相同。

**M1 只有 `appendEvents` 那一組測得到，hook 層的三條 reset 測試對它是盲的。** 原因是 `fold()` 自己
也有 `case 'reset': return INITIAL_VIEW`（裁決 22 給 Task 4 的那一條），hook 少截一次時 `view` 完全
一樣，差別只在累積陣列會一直長下去。這是計畫至今第八次「測試名字對、斷言對，但正確與錯誤實作
在挑的資料下同值」，處置方式跟 M6 一樣：把判準抽成獨立的純函式再直接測它。hook 層那三條仍然留著，
它們釘的是「畫面確實從 reset 之後重新開始」這個對外行為，跟截斷是不是發生在 hook 裡是兩件事。

**M8 的第二條測試第一次是盲的，改用 `ended: true` 才命中。** 起草時直接用 `viewOf(...)` 建構 view，
它的 `ended` 預設是 `false`；套用突變（條件從 `view.error !== undefined` 改成 `view.ended`）之後，
`ended: false` 讓正確條件與 mutant 條件算出同一個結果（都不顯示卡片），這條測試完全測不出來，
是本計畫第七次「測試名字對、斷言對，但挑的資料讓正確與錯誤實作巧合同值」。改成手工建構
`ended: true` 且不帶 `error` 的 view 之後才真的擋住：這正是規格要防的情境（對話正常結束，
不該冒出一張錯誤卡片），mutant 在這個情境下會讀到 `view.error.message`，`view.error` 是
`undefined`，直接拋例外。

M8 單獨還原後再跑一次 `npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`：
「Test Files 2 passed (2)」「Tests 43 passed (43)」，與突變前逐字相同。

**M6 第一次是盲的，測試改過才命中。** 初版的那條測試把 `running` 改成 `done` 的同時也把 `result` 從
`undefined` 改成 `'ok'`，於是 `blockEquals` 靠 `Object.is(a.result, b.result)` 就判出不相等，
拿掉 `status` 比較照樣重繪，元件層的測試全綠，只有 `blockEquals` 的單元測試變紅。改成
「只改 `status`、其餘欄位逐字相同」之後才真的擋住。這是本計畫第六次「測試名字對、斷言對，
但挑的資料讓正確與錯誤實作巧合同值」，模式跟 Task 7 的側邊欄寬度、Task 4B 的第一顆工具是同一個。

M6 順帶證明了一件事：`Turn` 的 `memo` 真的會命中。若 memo 從來沒攔下任何一次重繪，
拿掉比較函式裡的一個欄位不會有任何可觀察的後果，測試就不會紅。它紅了，代表比較函式回傳 true 時
React 確實跳過了那次渲染。這是本 task 效能主張的直接證據，不是推論。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/Conversation.tsx src/renderer/components/Conversation.css \
  src/renderer/components/Turn.tsx src/renderer/components/ToolCall.tsx \
  src/renderer/components/ThinkingBlock.tsx src/renderer/components/block-equals.ts \
  src/renderer/hooks/useConversation.ts \
  src/renderer/App.tsx src/renderer/App.css \
  tests/conversation.test.tsx tests/use-conversation.test.tsx vitest.config.ts
git commit -m "feat: 對話元件與 useConversation，memo 改用逐欄位比較函式，加裁決 17 錯誤卡片"
```

## 回報事項（不擅自更動，記錄理由）

1. **`vitest.config.ts` 的 `test.include` 已由 Task 9 定案，本 task 不再重複宣告。** 接縫補記已定案：
   `test.include` 改成 `'tests/**/*.test.{ts,tsx}'` 只在 Task 9 做一次，9B／10／11 不再重複宣告，
   只在 Step 2 確認。本 task 仍要改 `vitest.config.ts`，但只加六個 coverage 條目，不動 `include`
   那一行；若 Step 2 看到「No test files found, exiting with code 1」，代表 Task 9 沒做完，不是
   本 task 的問題。本 task 兩種 glob 都實跑過：舊的收 4 個檔，`{ts,tsx}` 收 6 個。

2. **契約的 `Conversation` 簽章有回傳型別標註，本 task 沒照抄那一段。** 契約寫
   `export function Conversation(props: ConversationProps): JSX.Element`，實作寫成不標註回傳型別。
   理由是 Task 9 已查證：標 `JSX.Element` 需要額外顯式 import `JSX` 型別（automatic JSX runtime 的
   已知限制），不標則由 TS 推論。參數型別與元件名稱逐字相同，對呼叫端沒有差別。

3. **`ToolBlock` 的宣告位置。** 契約把 `export type ToolBlock = Extract<Block, { kind: 'tool' }>` 列在
   `Conversation.tsx` 底下。實作把它宣告在 `block-equals.ts`（那裡最先需要它），再由 `Conversation.tsx`
   `export type { ToolBlock }` 轉出一次。Task 10 照契約從 `Conversation.js` import 完全可行。

4. **`Block.tool` 的 `deniedReason` 已由裁決 12 定案。** Task 4B 現行程式碼已經照裁決 12 寫
   `deniedReason`（拒絕理由填 `deniedReason`，`result` 維持 `undefined`）。本 task 的 `ToolCall`
   讀 `block.deniedReason`，與 Task 4B 定案版本一致，M3 那條突變測試的實機行為對得上，不再是
   待裁決疑慮。

5. **`session-end` 的錯誤資訊已由裁決 17 定案。** `ConversationView` 加
   `error?: { readonly message?: string; readonly apiErrorStatus?: unknown }`，`fold()` 收到
   `isError: true` 的 `session-end` 時設定它（屬於 Task 4 的範圍），`Conversation` 在對話尾端渲染
   `.error-card`，內容是「對話因錯誤結束」、`message`（若有）、`apiErrorStatus`（若有）。本 task
   已依裁決 17 第 4 點實作（見 Step 3e、Step 1 的兩條新測試、Step 5 的 M8），不再是待裁決疑慮。

6. **規格 §8 的「事件流中斷時顯示連線狀態」已由裁決 17 定案：不另設連線狀態 UI。** Task 8 的
   agent-host 在事件流中斷（`for await` 迭代器 throw，例如 SDK 程序崩潰或連線斷掉）時，把錯誤轉成
   一筆合成的 `{ kind: 'session-end', isError: true, errorMessage: err.message }`，走同一條 events
   通道，再走原本的 onEnded，狀態機照常回 `idle`。本 task 因此不需要另外處理連線狀態，第 4 點的
   錯誤卡片已經涵蓋這個情境。

---

### Task 10: 工具批准卡片端到端

> **2026-09-02 晚間依裁決 28 修訂**
>
> `CanUseTool` 的 options 有必填的 `toolUseID`，裁決 11 的內容比對前提是錯的。`deepEqual` 與它的
> 那組測試整組刪除，四個出口改成比 `block.id === ask.toolUseId` 與 block 狀態。突變表重做。

批准請求走的是 `canUseTool` 加 IPC 那條管線，跟 SDK 的訊息流完全分開，所以 `fold()` 看不到它
（Task 4B 的設計判斷）。`awaiting-approval` 這個狀態的唯一來源因此是 UI 層。至於「哪個請求對應
畫面上哪一個 tool block」，裁決 28 已經定案：`ApprovalAskPayload` 帶 `toolUseId`，就是 SDK 給
`canUseTool` 的 `options.toolUseID`，跟 `Block.id`（來自 `content_block_start` 的 tool_use id）
是同一個值。本 task 把這條規則寫成三個純函式，加上一個訂閱 hook 與一張內嵌卡片，湊成規格 §6 要的
「批准內嵌在對話流，不用彈窗」。

**三條規則。**

1. `matchApproval(view, ask)`：回傳 `id === ask.toolUseId` 且狀態是 `running` 或 `streaming-input`
   的 tool block，找不到就是 `undefined`。
2. `findAskForBlock(block, pending)`：block 的狀態還開著（`running`／`streaming-input`／
   `awaiting-approval`）時回 `pending.find((a) => a.toolUseId === block.id)`，`denied`／`done`／
   `error` 一律 `undefined`。`applyPendingApprovals` 只標它命中的那些。
3. `unmatchedAsks(view, pending)`：回傳 view 裡完全找不到 `id === toolUseId` 的那些 ask。找得到
   但已經關閉的不算未對應，也不畫。

第 2 條的狀態集合比第 1 條多一個 `awaiting-approval`，這是刻意的：`applyPendingApprovals` 會把
命中的 block 標成 `awaiting-approval`，而 `renderToolExtra` 拿到的是標過的那份 view，若
`findAskForBlock` 不認 `awaiting-approval`，卡片會在標記生效的下一幀自己消失。換句話說，
`findAskForBlock` 的輸入是標過的 view，`matchApproval` 的輸入是 `fold()` 直接產出的 raw view，
兩者各有一條測試釘住。私有的 `matches(block, ask)` 因此拆成兩個小述詞（`isOpen` 與
`stillOpenForCard`），比對鍵仍然只有一份。

**ask 先到、block 後到仍然可能，那些請求要畫在對話尾端。** `canUseTool` 是 SDK 在決定要不要執行
工具時走 control 通道回呼的，tool block 的快照則是走每幀合併的事件通道，兩者到達 renderer 的
先後沒有保證。批准請求先到、`tool_use` 快照後到是正常情況，此時畫面上還沒有那個 id 的 block 可以
掛卡片。這種請求不能靜默丟棄（規格 §8）：使用者不回答，主程序那個 promise 就掛著，直到 Task 6 的
計時器逾時把它拒絕掉。所以 `unmatchedAsks` 把它們挑出來，`App` 畫在對話尾端。

**逾時被拒絕之後卡片要消失。** Task 6 的計時器逾時把請求 deny 掉時，主程序會推出
`permission-denied` 事件，`fold()` 把那個 block 推進到 `denied`。`findAskForBlock` 對已關閉的
block 回 `undefined`，卡片跟著消失；`unmatchedAsks` 也不會把它撿回對話尾端，因為 view 裡找得到
那個 id。使用者看到的可見記錄是 block 上的 `deniedReason`，不是一張按了沒反應的卡片。

實機驗證：本檔所有「已驗證」都指在 worktree（`git worktree add`，`npm install` 裝好 react 19.2.8
／@testing-library/react 16.3.3／jsdom 30.0.1）裡真的跑過 `npx tsc --noEmit` 與 `npx vitest run`。
測試數與突變結果見 Step 4、Step 5。

**Files:**
- Create: `src/renderer/approvals.ts`
- Create: `src/renderer/hooks/useApprovals.ts`
- Create: `src/renderer/components/ApprovalCard.tsx`
- Create: `src/renderer/components/ApprovalCard.css`
- Create: `tests/approvals.test.ts`
- Create: `tests/approval-card.test.tsx`
- Create: `tests/use-approvals.test.tsx`
- Modify: `src/renderer/App.tsx`（在 Task 9B 的版本上加三個插入點，並把 `Composer` 的 `disabled`
  接起來）
- Modify: `vitest.config.ts`（只加 coverage 的 `src/renderer/approvals.ts`。`test.include` 那一行
  由 Task 9 改一次成 `'tests/**/*.test.{ts,tsx}'`，接縫補記定 9B／10／11 不重複宣告，只在
  Step 2 確認）

**Interfaces:**
- Consumes:
  - `ApprovalAskPayload`（`requestId`／`toolUseId`／`toolName`／`input`／`title?`／`displayName?`，
    `toolUseId` 由裁決 28 加入）、`ApprovalDecision`、`YesChefApi`（裁決 14 定稿版）：
    `src/shared/ipc.ts`（Task 8）
  - `SessionState`：`src/shared/session-state.ts`（Task 5，裁決 14）
  - `ConversationView`／`Turn`／`Block`：`src/shared/fold.ts`（Task 4／4B）
  - `ToolBlock`、`Conversation`、`ConversationProps.renderToolExtra`：
    `src/renderer/components/Conversation.tsx`（Task 9B）
  - `useConversation(api): { view, sessionState }`：`src/renderer/hooks/useConversation.ts`（Task 9B）
- Produces:
  - `function matchApproval(view: ConversationView, ask: ApprovalAskPayload): ToolBlock | undefined`
  - `function findAskForBlock(block: ToolBlock, pending: readonly ApprovalAskPayload[]): ApprovalAskPayload | undefined`
  - `function applyPendingApprovals(view: ConversationView, pending: readonly ApprovalAskPayload[]): ConversationView`
  - `function unmatchedAsks(view: ConversationView, pending: readonly ApprovalAskPayload[]): readonly ApprovalAskPayload[]`
  - `interface Approvals { readonly pending: readonly ApprovalAskPayload[]; reply(requestId: string, decision: ApprovalDecision): void }`
  - `function useApprovals(api: YesChefApi): Approvals`
  - `interface ApprovalCardProps { readonly ask: ApprovalAskPayload; readonly onDecide: (requestId: string, decision: ApprovalDecision) => void; readonly unmatched?: boolean }`
  - `function ApprovalCard(props: ApprovalCardProps)`、`function formatToolInput(input: unknown): string`
  - `src/renderer/App.tsx` 的 `ComposerProps` 加一個 `readonly disabled?: boolean`（Task 9B 明文
    把「批准時輸入框停用」交棒給本 task，規格 §6）。`Composer` 不是匯出的元件，Task 11 不碰它，
    這一條只是記錄本 task 對 `App.tsx` 的第四處改動。

依賴順序：本 task 排在 Task 9B 之後（要 `Conversation` 的 `renderToolExtra` 接縫與
`useConversation`）。`App.tsx` 的演進順序是 9 → 9B → 10 → 11（接縫補記），本 task 給的完整檔案
就是 Task 9B 的版本加上自己的改動，Task 11 再在這份之上換掉側邊欄。回傳型別一律不標
`JSX.Element`，沿用 Task 9 的慣例。

- [ ] **Step 1a: 寫失敗的測試（純函式）**

`tests/approvals.test.ts`（Node 環境，不需要 jsdom）：

```typescript
import { describe, it, expect } from 'vitest'
import {
  applyPendingApprovals,
  findAskForBlock,
  matchApproval,
  unmatchedAsks,
} from '../src/renderer/approvals.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import type { Block, ConversationView } from '../src/shared/fold.js'
import type { ToolBlock } from '../src/renderer/components/Conversation.js'

/**
 * 工具名稱、tool_use_id 與 input 全部取自 tests/fixtures/events/03-sdk-live-stream.jsonl
 * 裡那顆真的 Bash 呼叫。view 本身是手組的：這一層測的是「兩個資料結構怎麼對上」，
 * 不是 fold() 怎麼組 view，把 fold 拉進來只會讓失敗訊息指向別人家的程式碼。
 */
const BASH_ID = 'toolu_01L2YCZHqTvRDmdkNpsprfCQ'
const BASH_INPUT = {
  command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
  description: 'Write hello to cap.txt and verify',
}

function toolBlock(
  id: string,
  status: ToolBlock['status'],
  input: unknown = BASH_INPUT,
  extra: { readonly name?: string; readonly result?: unknown } = {}
): ToolBlock {
  return {
    kind: 'tool',
    id,
    name: extra.name ?? 'Bash',
    input,
    result: extra.result,
    status,
  }
}

function viewOf(...blocks: readonly Block[]): ConversationView {
  return { turns: [{ role: 'assistant', messageId: 'msg_01', blocks }], ended: false }
}

/** toolUseId 預設就是那顆 Bash 的 id：多數案例要的是「對得上」。 */
function ask(over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId: 'req-1',
    toolUseId: BASH_ID,
    toolName: 'Bash',
    input: BASH_INPUT,
    ...over,
  }
}

describe('matchApproval', () => {
  it('toolUseId 對得上且狀態是 running 時命中', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    expect(matchApproval(view, ask())?.id).toBe(BASH_ID)
  })

  it('狀態是 streaming-input 也命中（input 還沒到齊不影響）', () => {
    const partial: ToolBlock = {
      kind: 'tool',
      id: BASH_ID,
      name: 'Bash',
      input: undefined,
      status: 'streaming-input',
    }
    expect(matchApproval(viewOf(partial), ask())?.id).toBe(BASH_ID)
  })

  it('toolUseId 對不上不命中，即使工具名稱與參數一模一樣', () => {
    const view = viewOf(toolBlock('toolu_OTHER', 'running'))
    expect(matchApproval(view, ask())).toBeUndefined()
  })

  it('同名同參數的兩個 block，各自的 ask 只掛到自己的 id', () => {
    const first = toolBlock('toolu_A', 'running')
    const second = toolBlock('toolu_B', 'running')
    const view = viewOf(first, second)
    expect(matchApproval(view, ask({ requestId: 'r1', toolUseId: 'toolu_A' }))?.id).toBe('toolu_A')
    expect(matchApproval(view, ask({ requestId: 'r2', toolUseId: 'toolu_B' }))?.id).toBe('toolu_B')
  })

  it('狀態是 denied／done／error 的 block 不命中', () => {
    for (const status of ['denied', 'done', 'error'] as const) {
      expect(matchApproval(viewOf(toolBlock(BASH_ID, status)), ask())).toBeUndefined()
    }
  })

  // matchApproval 的輸入是 fold() 直接產出的 raw view，那裡不會有 awaiting-approval
  // （它是 applyPendingApprovals 標上去的）。卡片要不要繼續畫由 findAskForBlock 決定。
  it('已經標成 awaiting-approval 的 block 不命中', () => {
    expect(matchApproval(viewOf(toolBlock(BASH_ID, 'awaiting-approval')), ask())).toBeUndefined()
  })

  it('跨 turn 尋找，text／thinking／unknown block 一律跳過', () => {
    const view: ConversationView = {
      turns: [
        { role: 'user', blocks: [{ kind: 'text', markdown: '跑一下', complete: true }] },
        {
          role: 'assistant',
          blocks: [
            { kind: 'thinking', text: '想一下', complete: true },
            { kind: 'unknown', raw: { hello: 'world' } },
            toolBlock(BASH_ID, 'running'),
          ],
        },
      ],
      ended: false,
    }
    expect(matchApproval(view, ask())?.id).toBe(BASH_ID)
  })

  it('沒有任何 tool block 時回 undefined', () => {
    expect(matchApproval({ turns: [], ended: false }, ask())).toBeUndefined()
  })
})

describe('findAskForBlock', () => {
  it('running 的 block 回 toolUseId 相同的那一筆', () => {
    const block = toolBlock(BASH_ID, 'running')
    const pending = [ask({ requestId: 'req-other', toolUseId: 'toolu_OTHER' }), ask()]
    expect(findAskForBlock(block, pending)?.requestId).toBe('req-1')
  })

  // applyPendingApprovals 標過之後 block 是 awaiting-approval，renderToolExtra 讀的
  // 就是標過的那份 view。這裡若不認 awaiting-approval，卡片會在標記生效的下一幀消失。
  it('awaiting-approval 的 block 仍然找得到那筆請求', () => {
    const block = toolBlock(BASH_ID, 'awaiting-approval')
    expect(findAskForBlock(block, [ask()])?.requestId).toBe('req-1')
  })

  it('block 已 denied 時回 undefined（逾時被拒絕後卡片跟著消失）', () => {
    const block = toolBlock(BASH_ID, 'denied')
    expect(findAskForBlock(block, [ask()])).toBeUndefined()
  })

  it('block 已 done 或 error 時回 undefined', () => {
    for (const status of ['done', 'error'] as const) {
      expect(findAskForBlock(toolBlock(BASH_ID, status), [ask()])).toBeUndefined()
    }
  })

  it('pending 裡沒有同一個 toolUseId 時回 undefined', () => {
    const block = toolBlock(BASH_ID, 'running')
    expect(findAskForBlock(block, [ask({ toolUseId: 'toolu_OTHER' })])).toBeUndefined()
    expect(findAskForBlock(block, [])).toBeUndefined()
  })
})

describe('applyPendingApprovals', () => {
  it('命中的 block 狀態改成 awaiting-approval', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const next = applyPendingApprovals(view, [ask()])
    expect(next.turns[0]?.blocks[0]).toMatchObject({
      kind: 'tool',
      id: BASH_ID,
      status: 'awaiting-approval',
    })
  })

  it('沒命中的 block 與其他 block 一字不改', () => {
    const other = toolBlock('toolu_OTHER', 'running', { command: 'ls' })
    const text: Block = { kind: 'text', markdown: '嗨', complete: false }
    const view = viewOf(other, toolBlock(BASH_ID, 'running'), text)
    const next = applyPendingApprovals(view, [ask()])
    expect(next.turns[0]?.blocks[0]).toBe(other)
    expect(next.turns[0]?.blocks[2]).toBe(text)
  })

  it('已經 denied 的 block 不會被標成 awaiting-approval', () => {
    const view = viewOf(toolBlock(BASH_ID, 'denied'))
    expect(applyPendingApprovals(view, [ask()])).toBe(view)
  })

  it('不修改傳進來的 view（純函式）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const before = JSON.stringify(view)
    applyPendingApprovals(view, [ask()])
    expect(JSON.stringify(view)).toBe(before)
    expect(view.turns[0]?.blocks[0]).toMatchObject({ status: 'running' })
  })

  it('沒有任何 block 被改到時回傳同一個 view 物件（memo 的淺比較要用）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    expect(applyPendingApprovals(view, [])).toBe(view)
    expect(applyPendingApprovals(view, [ask({ toolUseId: 'toolu_OTHER' })])).toBe(view)
  })

  it('重複套用是等冪的，且第二次回傳同一個物件', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const once = applyPendingApprovals(view, [ask()])
    expect(applyPendingApprovals(once, [ask()])).toBe(once)
  })

  it('多個 turn 各自命中', () => {
    const view: ConversationView = {
      turns: [
        { role: 'assistant', blocks: [toolBlock('t1', 'running', { command: 'ls' })] },
        { role: 'assistant', blocks: [toolBlock('t2', 'running', { command: 'pwd' })] },
      ],
      ended: false,
    }
    const next = applyPendingApprovals(view, [
      ask({ requestId: 'r1', toolUseId: 't1' }),
      ask({ requestId: 'r2', toolUseId: 't2' }),
    ])
    expect(next.turns.map((t) => (t.blocks[0] as ToolBlock).status)).toEqual([
      'awaiting-approval',
      'awaiting-approval',
    ])
  })
})

describe('unmatchedAsks', () => {
  it('view 裡沒有那個 id 時算未對應（規格 §8：不得靜默丟棄）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const early = ask({ requestId: 'req-early', toolUseId: 'toolu_NOT_YET', toolName: 'Write' })
    expect(unmatchedAsks(view, [ask(), early]).map((a) => a.requestId)).toEqual(['req-early'])
  })

  // 逾時被 deny 之後卡片消失，可見記錄是 block 上的 deniedReason，不是對話尾端
  // 又冒出一張按了沒反應的卡片。
  it('block 已 denied 時那筆 ask 不算未對應', () => {
    const view = viewOf(toolBlock(BASH_ID, 'denied'))
    expect(unmatchedAsks(view, [ask()])).toEqual([])
  })

  it('block 已 done 或 error 時那筆 ask 一樣不算未對應', () => {
    for (const status of ['done', 'error'] as const) {
      expect(unmatchedAsks(viewOf(toolBlock(BASH_ID, status)), [ask()])).toEqual([])
    }
  })

  it('全部對應得到時回空陣列', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    expect(unmatchedAsks(view, [ask()])).toEqual([])
  })

  it('同名同參數的兩個 block，兩筆 ask 各自掛自己的 id，沒有未對應', () => {
    const view = viewOf(toolBlock('toolu_A', 'running'), toolBlock('toolu_B', 'running'))
    const pending = [
      ask({ requestId: 'r1', toolUseId: 'toolu_A' }),
      ask({ requestId: 'r2', toolUseId: 'toolu_B' }),
    ]
    expect(unmatchedAsks(view, pending)).toEqual([])
  })

  it('對話裡完全沒有 tool block 時，所有請求都是未對應', () => {
    const view: ConversationView = { turns: [], ended: false }
    const pending = [
      ask({ requestId: 'r1', toolUseId: 'toolu_A' }),
      ask({ requestId: 'r2', toolUseId: 'toolu_B' }),
    ]
    expect(unmatchedAsks(view, pending)).toEqual(pending)
  })
})
```

- [ ] **Step 1b: 寫失敗的測試（卡片）**

`tests/approval-card.test.tsx`。第一行的 `// @vitest-environment jsdom` 是 Vitest 官方的逐檔
覆寫語法，沿用 Task 9 的作法，不改 `vitest.config.ts` 的全域 environment：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard, formatToolInput } from '../src/renderer/components/ApprovalCard.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'

afterEach(cleanup)

const BASH_INPUT = {
  command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
  description: 'Write hello to cap.txt and verify',
}

function ask(over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId: 'req-1',
    toolUseId: 'toolu_01L2YCZHqTvRDmdkNpsprfCQ',
    toolName: 'Bash',
    input: BASH_INPUT,
    ...over,
  }
}

describe('formatToolInput', () => {
  it('物件排版成多行 JSON', () => {
    expect(formatToolInput({ command: 'ls' })).toBe('{\n  "command": "ls"\n}')
  })

  it('字串原樣、undefined 有明確文案', () => {
    expect(formatToolInput('ls -l')).toBe('ls -l')
    expect(formatToolInput(undefined)).toBe('（沒有參數）')
  })

  it('有環的物件不丟錯（卡片一定要畫得出來）', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => formatToolInput(cyclic)).not.toThrow()
    expect(formatToolInput(cyclic)).toContain('object')
  })
})

describe('ApprovalCard 的文案', () => {
  it('有 title 時用 title，不自己拼 toolName 加 input', () => {
    render(<ApprovalCard ask={ask({ title: '要讓 Claude 執行這個指令嗎？' })} onDecide={vi.fn()} />)
    expect(screen.getByText('要讓 Claude 執行這個指令嗎？')).not.toBeNull()
    expect(screen.queryByText('Bash')).toBeNull()
  })

  it('沒有 title 時退回工具名稱加格式化的 input', () => {
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} />)
    expect(screen.getByText('Bash')).not.toBeNull()
    const card = screen.getByTestId('approval-card')
    expect(card.textContent).toContain('echo hello > cap.txt')
    expect(card.textContent).toContain('Write hello to cap.txt and verify')
  })

  it('title 是空字串時仍退回工具名稱加 input', () => {
    render(<ApprovalCard ask={ask({ title: '' })} onDecide={vi.fn()} />)
    expect(screen.getByText('Bash')).not.toBeNull()
  })

  it('有 displayName 時按鈕是「允許 {displayName}」，沒有就是「允許」', () => {
    const { unmount } = render(
      <ApprovalCard ask={ask({ displayName: '執行指令' })} onDecide={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: '允許 執行指令' })).not.toBeNull()
    unmount()
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: '允許' })).not.toBeNull()
  })

  it('未對應的請求多一段說明，一樣有兩個按鈕（規格 §8）', () => {
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} unmatched />)
    expect(screen.getByTestId('approval-card').textContent).toContain('還沒對應到畫面上的工具呼叫')
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})

describe('ApprovalCard 的回答', () => {
  it('點允許送 allow，點拒絕送 deny，兩者都帶 requestId', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-42' })} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: '允許' }))
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }))
    expect(onDecide.mock.calls).toEqual([
      ['req-42', 'allow'],
      ['req-42', 'deny'],
    ])
  })

  it('卡片有焦點時 y 允許、n 拒絕，大寫也算', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-7' })} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    expect(document.activeElement).toBe(card)
    fireEvent.keyDown(card, { key: 'y' })
    fireEvent.keyDown(card, { key: 'N' })
    expect(onDecide.mock.calls).toEqual([
      ['req-7', 'allow'],
      ['req-7', 'deny'],
    ])
  })

  it('焦點在卡片外的元素時，y／n 不生效', () => {
    const onDecide = vi.fn()
    render(
      <div>
        <input data-testid="outside" />
        <ApprovalCard ask={ask()} onDecide={onDecide} />
      </div>
    )
    const outside = screen.getByTestId('outside')
    outside.focus()
    expect(document.activeElement).toBe(outside)
    fireEvent.keyDown(outside, { key: 'y' })
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('卡片裡的按鈕有焦點時 y／n 一樣生效（事件從子節點冒上來）', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-9' })} onDecide={onDecide} />)
    const allow = screen.getByRole('button', { name: '允許' })
    allow.focus()
    fireEvent.keyDown(allow, { key: 'y' })
    expect(onDecide.mock.calls).toEqual([['req-9', 'allow']])
  })

  it('帶修飾鍵的 y／n 不算（Cmd+Y 是系統快捷鍵）', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    fireEvent.keyDown(card, { key: 'y', metaKey: true })
    fireEvent.keyDown(card, { key: 'n', ctrlKey: true })
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('其他按鍵不觸發任何決定', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    for (const key of ['a', 'Enter', 'Escape', ' ']) {
      fireEvent.keyDown(card, { key })
    }
    expect(onDecide).not.toHaveBeenCalled()
  })
})
```

「焦點在卡片外的元素時 y／n 不生效」這條是本檔最重要的一條：它擋的是「用
`document.addEventListener('keydown')` 做快捷鍵」那個看起來合理的寫法。那樣寫的話，使用者在
輸入框裡打一個 y 就把工具批准送出去了。Step 5 的突變 5 就是這個。

- [ ] **Step 1c: 寫失敗的測試（hook）**

`tests/use-approvals.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useApprovals } from '../src/renderer/hooks/useApprovals.js'
import { App } from '../src/renderer/App.js'
import type { ApprovalAskPayload, ApprovalReplyPayload, YesChefApi } from '../src/shared/ipc.js'
import type { SessionState } from '../src/shared/session-state.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * 假的 YesChefApi。preload 的真品要 Electron，這裡只需要「訂閱得到、送得出去」
 * 這兩件事，所以自己拿兩個 Set 當事件來源，順便可以斷言訂閱有沒有解除。
 */
function createFakeApi(): {
  readonly api: YesChefApi
  readonly replies: ApprovalReplyPayload[]
  emitAsk(ask: ApprovalAskPayload): void
  emitState(state: SessionState): void
  listenerCounts(): { ask: number; state: number }
} {
  const askListeners = new Set<(ask: ApprovalAskPayload) => void>()
  const stateListeners = new Set<(state: SessionState) => void>()
  const replies: ApprovalReplyPayload[] = []

  const api: YesChefApi = {
    onEvents: () => () => undefined,
    onApprovalAsk: (cb) => {
      askListeners.add(cb)
      return () => {
        askListeners.delete(cb)
      }
    },
    onSessionState: (cb) => {
      stateListeners.add(cb)
      return () => {
        stateListeners.delete(cb)
      }
    },
    sendInput: () => undefined,
    replyApproval: (reply) => {
      replies.push(reply)
    },
    listSessions: () => Promise.resolve([]),
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: '/Users/x/Projects/demo',
  }

  return {
    api,
    replies,
    emitAsk: (ask) => {
      act(() => {
        for (const l of askListeners) l(ask)
      })
    },
    emitState: (state) => {
      act(() => {
        for (const l of stateListeners) l(state)
      })
    },
    listenerCounts: () => ({ ask: askListeners.size, state: stateListeners.size }),
  }
}

function ask(requestId: string, over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId,
    toolUseId: `toolu_${requestId}`,
    toolName: 'Bash',
    input: { command: 'ls' },
    ...over,
  }
}

describe('useApprovals', () => {
  it('一開始沒有待決請求，且已經訂閱兩個頻道', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    expect(result.current.pending).toEqual([])
    expect(fake.listenerCounts()).toEqual({ ask: 1, state: 1 })
  })

  it('依到達順序累積，且每次都是新陣列（不就地 push）', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))

    fake.emitAsk(ask('req-1'))
    const afterFirst = result.current.pending
    fake.emitAsk(ask('req-2', { toolName: 'Write' }))

    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1', 'req-2'])
    expect(result.current.pending).not.toBe(afterFirst)
    expect(afterFirst.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('同一個 requestId 重送不會疊出第二張卡片', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-1'))
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('reply 把決定送給 main，並把那一筆從 pending 移除', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-2'))

    act(() => {
      result.current.reply('req-1', 'allow')
    })

    expect(fake.replies).toEqual([{ requestId: 'req-1', decision: 'allow' }])
    // 卡片按了就要消失：這條是「按了沒反應」那個 bug 的守門員。
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-2'])
  })

  it('reply 只移除指定的那一筆，deny 一樣送得出去', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-2'))
    fake.emitAsk(ask('req-3'))

    act(() => {
      result.current.reply('req-2', 'deny')
    })

    expect(fake.replies).toEqual([{ requestId: 'req-2', decision: 'deny' }])
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1', 'req-3'])
  })

  it('回覆一個不存在的 requestId 不影響 pending，但仍然送出去', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))

    act(() => {
      result.current.reply('req-does-not-exist', 'deny')
    })

    expect(fake.replies).toHaveLength(1)
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('session 狀態離開 live 就清空 pending（main 側已 denyAll）', () => {
    for (const state of [
      { kind: 'idle' } as const,
      { kind: 'viewing', sessionId: 's-1' } as const,
    ]) {
      const fake = createFakeApi()
      const { result, unmount } = renderHook(() => useApprovals(fake.api))
      fake.emitAsk(ask('req-1'))
      expect(result.current.pending).toHaveLength(1)

      fake.emitState(state)

      expect(result.current.pending).toEqual([])
      expect(fake.replies).toEqual([]) // 清空不等於代替使用者回答
      unmount()
    }
  })

  it('狀態還是 live 時不清空', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitState({ kind: 'live', sessionId: 's-1' })
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('清空之後新的請求照樣收得到', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitState({ kind: 'idle' })
    fake.emitAsk(ask('req-2'))
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-2'])
  })

  it('卸載時兩個訂閱都解除', () => {
    const fake = createFakeApi()
    const { unmount } = renderHook(() => useApprovals(fake.api))
    expect(fake.listenerCounts()).toEqual({ ask: 1, state: 1 })
    unmount()
    expect(fake.listenerCounts()).toEqual({ ask: 0, state: 0 })
  })
})

describe('App 與批准的接線', () => {
  /**
   * 規格 §6「批准時輸入框停用」。Task 9B 的 Composer 留了 disabled 這個 prop
   * 沒有接，本 task 接上：pending 非空就停用，pending 清空就恢復。
   *
   * 這條放在本檔而不是另開一個 App 測試檔：要斷言的東西完全由 useApprovals 的
   * pending 決定，跟這裡既有的假 api 是同一套裝置。
   */
  it('有待決請求時輸入框與送出鍵都停用，請求清掉之後恢復', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    const send = container.querySelector('.composer-send')
    if (input === null || send === null) throw new Error('找不到輸入框或送出鍵')

    expect(input.disabled).toBe(false)
    expect((send as HTMLButtonElement).disabled).toBe(false)

    fake.emitAsk(ask('req-1'))
    expect(input.disabled).toBe(true)
    expect((send as HTMLButtonElement).disabled).toBe(true)

    // 離開 live 會清空 pending（main 側已 denyAll），輸入框跟著恢復。
    fake.emitState({ kind: 'idle' })
    expect(input.disabled).toBe(false)
    expect((send as HTMLButtonElement).disabled).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test tests/approvals.test.ts tests/approval-card.test.tsx tests/use-approvals.test.tsx
```

Expected: FAIL。三個檔案都無法解析 `../src/renderer/approvals.js`、
`../src/renderer/components/ApprovalCard.js`、`../src/renderer/hooks/useApprovals.js`（都還不存在）。

**兩個 `.tsx` 檔在改設定前根本不會被收集**（已實測）。`vitest.config.ts` 現行的
`include: ['tests/**/*.test.ts']` 不涵蓋 `.test.tsx`，即使在指令列指定檔名也一樣，Vitest 只會回：

```
No test files found, exiting with code 1

filter: tests/approval-card.test.tsx
include: tests/**/*.test.ts
```

Task 9 已經把 `include` 改成 `'tests/**/*.test.{ts,tsx}'`（接縫補記：這件事只做一次）。開工前
先確認那一行真的在，不在就先補上，本 task 的兩個 `.tsx` 測試檔才收得進來。這條同樣影響 Task 9
的 `tests/markdown-component.test.tsx`，見文末的「跨 task 發現」。

- [ ] **Step 3a: 最小實作（設定與純函式）**

`vitest.config.ts` 只動 coverage 那一段（裁決 19：只用 diff 加自己的檔案，不重寫整份清單。`test.include` 由 Task 9 負責，本 task 不碰）：

```diff
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/renderer/approvals.ts',
       ],
     },
```

coverage 只加 `approvals.ts`：hook 與元件要 jsdom 與 React 才跑得起來，跟既有 coverage 清單
（全是純函式模組）不同性質，維持清單只放純函式的慣例。

`src/renderer/approvals.ts`：

```typescript
/**
 * 批准請求與 tool block 的對應（裁決 28）。全部是純函式，不碰 React 也不碰 IPC。
 *
 * 對應的鍵是 tool_use id：`ApprovalAskPayload.toolUseId` 來自 SDK 給 `canUseTool`
 * 的 `options.toolUseID`，`Block.id` 來自同一顆 tool_use 的快照，兩者是同一個值。
 */
import type { ApprovalAskPayload } from '../shared/ipc.js'
import type { ConversationView, Turn } from '../shared/fold.js'
import type { ToolBlock } from './components/Conversation.js'

/**
 * 工具還在跑，還沒有任何了結：這種 block 才是批准請求該找的目標。
 * `streaming-input` 也算，因為批准請求可能比 tool_use 的完整快照先到。
 */
function isOpen(block: ToolBlock): boolean {
  return block.status === 'running' || block.status === 'streaming-input'
}

/**
 * 這個 block 底下還要不要繼續畫卡片。比 `isOpen` 多一個 `awaiting-approval`：
 * 那個狀態是 `applyPendingApprovals` 自己標上去的，而 `renderToolExtra` 拿到的
 * 正是標過的 view，這裡若不認它，卡片會在標記生效的下一幀自己消失。
 *
 * `denied`／`done`／`error` 一律不畫：Task 6 的計時器逾時把請求 deny 掉之後，
 * 主程序會推 `permission-denied`，block 進到 `denied`，卡片跟著收掉，可見記錄
 * 換成 block 上的 `deniedReason`（規格 §8 要的是「有東西可看」，不是「卡片留著」）。
 */
function stillOpenForCard(block: ToolBlock): boolean {
  return isOpen(block) || block.status === 'awaiting-approval'
}

function toolBlocksOf(turns: readonly Turn[]): readonly ToolBlock[] {
  return turns.flatMap((turn) => turn.blocks.filter((b): b is ToolBlock => b.kind === 'tool'))
}

/**
 * 這筆請求對應到哪個 block。輸入是 `fold()` 直接產出的 raw view，所以狀態只認
 * `running` 與 `streaming-input`（`awaiting-approval` 在那份資料裡不會出現）。
 */
export function matchApproval(
  view: ConversationView,
  ask: ApprovalAskPayload
): ToolBlock | undefined {
  return toolBlocksOf(view.turns).find((block) => block.id === ask.toolUseId && isOpen(block))
}

/**
 * 這個 block 底下要畫哪一筆請求的卡片。輸入是 `applyPendingApprovals` 標過的 view。
 * id 是一對一的，`find` 命中就只有那一筆。
 */
export function findAskForBlock(
  block: ToolBlock,
  pending: readonly ApprovalAskPayload[]
): ApprovalAskPayload | undefined {
  if (!stillOpenForCard(block)) return undefined
  return pending.find((ask) => ask.toolUseId === block.id)
}

/**
 * 把命中的 tool block 的狀態改成 `awaiting-approval`，其餘原樣。
 *
 * `fold()` 永遠不產生這個狀態（Task 4B 的設計判斷：批准走 canUseTool 那條管線，
 * 事件流裡看不到），所以這一層是它唯一的來源。
 *
 * 沒有任何 block 被改到時回傳**原本那個 view 物件**，不是內容相同的新物件：
 * 下游元件會用 `React.memo` 的淺比較擋重繪（裁決 10 同一個理由），每幀無條件
 * 造新物件等於讓那層比較永遠不成立。
 */
export function applyPendingApprovals(
  view: ConversationView,
  pending: readonly ApprovalAskPayload[]
): ConversationView {
  if (pending.length === 0) return view

  let viewChanged = false
  const turns = view.turns.map((turn) => {
    let turnChanged = false
    const blocks = turn.blocks.map((block) => {
      if (block.kind !== 'tool') return block
      if (findAskForBlock(block, pending) === undefined) return block
      if (block.status === 'awaiting-approval') return block
      turnChanged = true
      return { ...block, status: 'awaiting-approval' as const }
    })
    if (!turnChanged) return turn
    viewChanged = true
    return { ...turn, blocks }
  })

  return viewChanged ? { ...view, turns } : view
}

/**
 * view 裡完全找不到那個 id 的請求，要渲染在對話尾端（規格 §8：不得靜默丟棄）。
 * 來源是 `canUseTool` 早於 tool_use 快照到達，對應的 block 還沒進畫面。
 *
 * 判準只看 id 在不在，不看狀態：id 找得到但 block 已經關閉（逾時被 deny、
 * 執行完畢）的那些，卡片本來就該收掉，不能再從對話尾端冒出來一次。
 */
export function unmatchedAsks(
  view: ConversationView,
  pending: readonly ApprovalAskPayload[]
): readonly ApprovalAskPayload[] {
  if (pending.length === 0) return pending
  const ids = new Set(toolBlocksOf(view.turns).map((block) => block.id))
  return pending.filter((ask) => !ids.has(ask.toolUseId))
}
```

`ToolBlock` 從 Task 9B 的 `Conversation.tsx` 匯入，不在這裡重宣告一份。這是 `import type`，
編譯後整行消失，純函式模組在執行期不會因此相依 React。

- [ ] **Step 3b: 最小實作（卡片）**

`src/renderer/components/ApprovalCard.tsx`：

```tsx
import type { KeyboardEvent } from 'react'
import type { ApprovalAskPayload, ApprovalDecision } from '../../shared/ipc.js'
import './ApprovalCard.css'

export interface ApprovalCardProps {
  readonly ask: ApprovalAskPayload
  readonly onDecide: (requestId: string, decision: ApprovalDecision) => void
  /** 這筆請求沒有對應到任何 tool block，卡片畫在對話尾端（規格 §8）。 */
  readonly unmatched?: boolean
}

function isNonEmpty(v: string | undefined): v is string {
  return v !== undefined && v !== ''
}

/**
 * 把 input 變成看得懂的字。JSON.stringify 對 undefined 回傳 undefined、
 * 對有環的物件會丟錯，兩種都退回 String()：批准卡片的內容再怎麼難看都必須
 * 畫得出來，這裡丟錯等於使用者連拒絕的按鈕都看不到。
 */
export function formatToolInput(input: unknown): string {
  if (input === undefined) return '（沒有參數）'
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}

/**
 * 內嵌在對話流裡的批准卡片（規格 §6：不用彈窗）。
 *
 * 文案優先用 `ask.title`：那是 SDK 產的完整提示句，SDK 的註解明說不要自己
 * 從 toolName 加 input 重建（裁決 28 保留了裁決 11 的這一條）。沒有 title 才退回
 * 工具名稱加 input。`toolUseId` 只用來對應 block，不畫在卡片上。
 *
 * y／n 快捷鍵掛在卡片根節點的 onKeyDown 上，不是 document 上。React 的合成
 * 事件只會在事件目標落在這棵子樹裡時觸發，所以「卡片（或卡片裡的按鈕）有焦點」
 * 這個條件是結構本身保證的，不必自己比對 document.activeElement。掛 document
 * 會讓使用者在輸入框裡打 y 就送出批准。
 */
export function ApprovalCard({ ask, onDecide, unmatched = false }: ApprovalCardProps) {
  const allowLabel = isNonEmpty(ask.displayName) ? `允許 ${ask.displayName}` : '允許'

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // 有修飾鍵時放行：Cmd+Y／Ctrl+N 是瀏覽器與系統的快捷鍵，不是我們的。
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key !== 'y' && key !== 'n') return
    event.preventDefault()
    onDecide(ask.requestId, key === 'y' ? 'allow' : 'deny')
  }

  return (
    <div
      className={unmatched ? 'approval-card approval-card--unmatched' : 'approval-card'}
      role="group"
      aria-label="工具批准請求"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-testid="approval-card"
      data-request-id={ask.requestId}
    >
      {unmatched ? (
        <p className="approval-card__notice">
          這個請求還沒對應到畫面上的工具呼叫，回答它之後對話才會繼續。
        </p>
      ) : null}

      {isNonEmpty(ask.title) ? (
        <p className="approval-card__prompt">{ask.title}</p>
      ) : (
        <div className="approval-card__prompt">
          <p className="approval-card__tool">{ask.toolName}</p>
          <pre className="approval-card__input">{formatToolInput(ask.input)}</pre>
        </div>
      )}

      <div className="approval-card__actions">
        <button type="button" onClick={() => onDecide(ask.requestId, 'allow')}>
          {allowLabel}
        </button>
        <button type="button" onClick={() => onDecide(ask.requestId, 'deny')}>
          拒絕
        </button>
      </div>

      <p className="approval-card__hint">卡片有焦點時：y 允許、n 拒絕</p>
    </div>
  )
}
```

`src/renderer/components/ApprovalCard.css`：

```css
.approval-card {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid #7a6a2a;
  border-left-width: 3px;
  border-radius: 4px;
  background: #1c1a10;
}

.approval-card:focus {
  outline: 1px solid #c9b458;
  outline-offset: 1px;
}

.approval-card--unmatched {
  border-color: #8a4a2a;
}

.approval-card__notice {
  margin: 0 0 6px;
  color: #e0a37a;
}

.approval-card__prompt {
  margin: 0 0 8px;
}

.approval-card__tool {
  margin: 0 0 4px;
  font-weight: 600;
}

.approval-card__input {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

.approval-card__actions {
  display: flex;
  gap: 8px;
}

.approval-card__actions button {
  padding: 4px 12px;
  border: 1px solid #4a4d40;
  border-radius: 3px;
  background: #23261c;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.approval-card__actions button:hover {
  background: #2d3124;
}

.approval-card__hint {
  margin: 6px 0 0;
  font-size: 0.85em;
  opacity: 0.6;
}

/* 對話尾端那一串「未對應」的請求。 */
.approval-tail {
  padding: 0 12px 12px;
}
```

卡片根節點的 `tabIndex={0}` 讓它自己可以被 Tab 選到，快捷鍵才有「取得焦點」這件事可言。不做
自動搶焦點：一次可能有多張卡片，搶焦點會讓捲軸跳動，也讓「哪一張會吃到 y」變得不可預期。

- [ ] **Step 3c: 最小實作（hook 與 App 的三個插入點）**

`src/renderer/hooks/useApprovals.ts`：

```typescript
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApprovalAskPayload, ApprovalDecision, YesChefApi } from '../../shared/ipc.js'

export interface Approvals {
  readonly pending: readonly ApprovalAskPayload[]
  reply(requestId: string, decision: ApprovalDecision): void
}

/**
 * 待回答的批准請求。
 *
 * 兩個訂閱：
 * - `onApprovalAsk`：到達順序累積，不可變地換新陣列
 * - `onSessionState`：狀態離開 `live` 就清空
 *
 * 清空只是「不再顯示」，不是「代替使用者回答」。切換 session 時 main 側的
 * 狀態機第一步就是 `registry.denyAll()`（Task 5 的收尾三步、Task 6 的註冊表），
 * 那些 promise 在主程序已經以 deny 了結，renderer 這邊再送一次回覆只會撞到
 * 一個不存在的 requestId。
 */
export function useApprovals(api: YesChefApi): Approvals {
  const [pending, setPending] = useState<readonly ApprovalAskPayload[]>([])

  useEffect(
    () =>
      api.onApprovalAsk((ask) => {
        setPending((prev) =>
          // 同一個 requestId 重送（例如 main 重試）不疊第二張卡片。
          prev.some((p) => p.requestId === ask.requestId) ? prev : [...prev, ask]
        )
      }),
    [api]
  )

  useEffect(
    () =>
      api.onSessionState((state) => {
        if (state.kind !== 'live') setPending([])
      }),
    [api]
  )

  const reply = useCallback(
    (requestId: string, decision: ApprovalDecision): void => {
      api.replyApproval({ requestId, decision })
      setPending((prev) => prev.filter((p) => p.requestId !== requestId))
    },
    [api]
  )

  return useMemo(() => ({ pending, reply }), [pending, reply])
}
```

`src/renderer/App.tsx`（在 Task 9B 的 3h 版本上加四處；下面是加完之後的完整檔案，逐字取代原檔。
`Composer`／`placeholderFor`／兩個 placeholder 常數／`<aside>` 佔位全部逐字保留 9B 的樣子，
側邊欄那一段是 Task 11 的位置，本 task 不動它的內容）：

```tsx
import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Conversation, type ToolBlock } from './components/Conversation.js'
import { ApprovalCard } from './components/ApprovalCard.js'
import { useConversation } from './hooks/useConversation.js'
import { useApprovals } from './hooks/useApprovals.js'
import { applyPendingApprovals, findAskForBlock, unmatchedAsks } from './approvals.js'
import type { SessionState } from '../shared/session-state.js'
import './App.css'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly onSend: (text: string) => void
  /** 有待決的批准請求時停用（規格 §6）。Task 9B 把這個 prop 留給 Task 10 接上。 */
  readonly disabled?: boolean
}

function Composer({ placeholder, onSend, disabled = false }: ComposerProps) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        className="composer-input"
        aria-label="輸入訊息"
        rows={3}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="composer-send" disabled={disabled}>
        送出
      </button>
    </form>
  )
}

function placeholderFor(state: SessionState): string {
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

/**
 * 「左＋中」這一個 React renderer（規格 §3，裁決 9）。右窗格是獨立的
 * WebContentsView，由主程序疊在視窗上，不在這棵 tree 裡。
 *
 * 批准的三個插入點（Task 10）：
 * 1. `applyPendingApprovals`：把命中的 tool block 標成 awaiting-approval
 * 2. `renderToolExtra`：把卡片畫進對應的 ToolCall 底部
 * 3. `unmatchedAsks`：對應不到 block 的請求畫在對話尾端，不靜默丟棄
 * 4. `Composer` 的 `disabled`：有待決請求時輸入框停用（規格 §6，9B 交棒）
 *
 * 第 2 點的命中查找一定要走 `findAskForBlock`，不能在這裡重寫一次比對：
 * 兩份比對邏輯遲早會漂移成「狀態標在 A、卡片畫在 B」。
 */
export function App() {
  const api = window.yeschef
  const { view: rawView, sessionState } = useConversation(api)
  const { pending, reply } = useApprovals(api)

  const view = useMemo(() => applyPendingApprovals(rawView, pending), [rawView, pending])
  const orphans = useMemo(() => unmatchedAsks(view, pending), [view, pending])

  const renderToolExtra = useCallback(
    (block: ToolBlock) => {
      const ask = findAskForBlock(block, pending)
      return ask === undefined ? null : <ApprovalCard ask={ask} onDecide={reply} />
    },
    [pending, reply]
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <p className="placeholder">Recents（Task 11）</p>
      </aside>
      <main className="conversation">
        <Conversation
          view={view}
          historical={sessionState.kind === 'viewing'}
          renderToolExtra={renderToolExtra}
        />
        {orphans.length > 0 ? (
          <div className="approval-tail">
            {orphans.map((ask) => (
              <ApprovalCard key={ask.requestId} ask={ask} onDecide={reply} unmatched />
            ))}
          </div>
        ) : null}
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => api.sendInput(text)}
          disabled={pending.length > 0}
        />
      </main>
    </div>
  )
}
```

`orphans` 算在 `view`（已套過 `applyPendingApprovals`）上而不是 `rawView` 上，兩者結果相同：
`awaiting-approval` 不在「已了結」那三個狀態裡，套過之後仍然命中。用 `view` 是因為那是畫面上
真的渲染的那份資料，算「誰沒被畫出來」就該對著它算。

跟 9B 的差別只有四處：檔首多四個 import、`ComposerProps` 多一個 `disabled?: boolean`（`textarea`
與送出鍵都吃它）、`App` 內多三行 hook 與 memo、`<main>` 裡多了 `renderToolExtra`／尾端卡片／
`disabled` 這三個接點。`onSend` 從 9B 的 `window.yeschef.sendInput(text)` 改成 `api.sendInput(text)`：
`api` 就是同一個 `window.yeschef`，本 task 已經把它取成區域常數，兩處用法不該分歧。

`Composer` 內部不再多寫一個「`disabled` 時 `submit()` 直接 return」的守衛：停用的 `textarea` 不會
發 keydown，停用的按鈕也不會送出 form，多那一行是在防一個 DOM 不允許發生的事。

- [ ] **Step 4: 跑測試確認通過**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` 無輸出；本 task 三個檔案 51 個測試全綠（`approvals` 26、`approval-card` 14、
`use-approvals` 11）。實跑輸出：

```
 Test Files  3 passed (3)
      Tests  51 passed (51)
```

全專案的總數要看當下材料化了哪些上游 task。2026-09-02 晚間依裁決 28 修訂後的驗證 worktree
（材料化 Task 3／4／4B／5／8 的 shared 型別與 `global.d.ts`、Task 9／9B／10 的程式碼與測試，
加上 repo 既有的 `cdp`／`layout`／`measure-memory`／`spawn-args` 四個測試檔）跑出來是：

```
 Test Files  9 passed (9)
      Tests  139 passed (139)
```

`npx tsc --noEmit -p .` 退出碼 0。`npx vitest run --coverage tests/approvals.test.ts` 量到
`src/renderer/approvals.ts` 的 % Stmts 97.22、% Branch 95.45，唯一沒走到的是
`unmatchedAsks` 的 `pending.length === 0` 提早返回。

- [ ] **Step 5: 突變測試**

七個突變全部在 worktree 實跑過：改壞、跑紅、還原、回綠。指令一律是
`npx vitest run tests/approvals.test.ts tests/approval-card.test.tsx tests/use-approvals.test.tsx`
（51 個測試）。

**突變 1：`matchApproval` 忽略狀態（已 denied 的 block 也命中）。**

```typescript
export function matchApproval(
  view: ConversationView,
  ask: ApprovalAskPayload
): ToolBlock | undefined {
  return toolBlocksOf(view.turns).find((block) => block.id === ask.toolUseId)
}
```

```
× 狀態是 denied／done／error 的 block 不命中
× 已經標成 awaiting-approval 的 block 不命中
Tests  2 failed | 49 passed (51)
```

實際後果：逾時被 deny 之後那個 id 還在 view 裡，`matchApproval` 照樣回傳它，呼叫端會以為
那筆請求還等得到回答。

**突變 2：`unmatchedAsks` 改用 `findAskForBlock` 判斷（已關閉的 block 上的 ask 被算成未對應）。**

```typescript
  const shown = new Set<string>()
  for (const block of toolBlocksOf(view.turns)) {
    const found = findAskForBlock(block, pending)
    if (found !== undefined) shown.add(found.requestId)
  }
  return pending.filter((ask) => !shown.has(ask.requestId))
```

```
× block 已 denied 時那筆 ask 不算未對應
× block 已 done 或 error 時那筆 ask 一樣不算未對應
Tests  2 failed | 49 passed (51)
```

這是最像正確答案的一個突變：讀起來完全合理，一般情況也對。錯的是逾時那條路：main 已經
deny 了，block 進到 `denied`，卡片本來就該收掉，這個版本卻把同一筆請求從對話尾端又畫一次，
使用者按下去只會在主程序 log 一句「找不到 requestId」。

**突變 3：`findAskForBlock` 忽略狀態（拿掉 `stillOpenForCard` 那一行）。**

```
× block 已 denied 時回 undefined（逾時被拒絕後卡片跟著消失）
× block 已 done 或 error 時回 undefined
× 已經 denied 的 block 不會被標成 awaiting-approval
Tests  3 failed | 48 passed (51)
```

第三條是 `applyPendingApprovals` 的連帶後果：它只標 `findAskForBlock` 命中的 block，判準一鬆，
已經拒絕的工具會被改回「等待批准」。

**突變 4：`findAskForBlock` 的狀態集合少了 `awaiting-approval`（`stillOpenForCard` 換成 `isOpen`）。**

```
× awaiting-approval 的 block 仍然找得到那筆請求
Tests  1 failed | 50 passed (51)
```

只有一條紅，但那一條就是這個設計的關鍵：`applyPendingApprovals` 標完之後 `renderToolExtra`
拿到的是標過的 view，判準若跟 `matchApproval` 完全一樣，卡片會在標記生效的下一幀自己消失。

**突變 5：`useApprovals.reply` 不從 pending 移除。**

```typescript
const reply = useCallback(
  (requestId: string, decision: ApprovalDecision): void => {
    api.replyApproval({ requestId, decision })
  },
  [api]
)
```

```
× reply 把決定送給 main，並把那一筆從 pending 移除
× reply 只移除指定的那一筆，deny 一樣送得出去
Tests  2 failed | 49 passed (51)
```

實際後果就是「按了允許，卡片還在那裡」。

**突變 6：y／n 改成 `document` 全域監聽。**

```tsx
useEffect(() => {
  const handler = (event: globalThis.KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key !== 'y' && key !== 'n') return
    event.preventDefault()
    onDecide(ask.requestId, key === 'y' ? 'allow' : 'deny')
  }
  document.addEventListener('keydown', handler)
  return () => document.removeEventListener('keydown', handler)
})
```

```
× 焦點在卡片外的元素時，y／n 不生效
Tests  1 failed | 50 passed (51)
```

只有一條紅，但那一條就是規格要的行為：快捷鍵只在卡片取得焦點時生效。其餘的（含「卡片有
焦點時 y 允許」）在這個錯誤實作下照樣全綠，這正是為什麼那條否定式測試不能省。

**突變 7：`App` 不把 `disabled` 傳給 `Composer`（`Composer` 的 prop 與預設值都留著）。**

```tsx
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => api.sendInput(text)}
        />
```

```
 × 有待決請求時輸入框與送出鍵都停用，請求清掉之後恢復 14ms
AssertionError: expected false to be true // Object.is equality
 Tests  1 failed | 50 passed (51)
```

這個突變值得特別列：`Composer` 那一半（prop 宣告、`textarea` 與按鈕的 `disabled={disabled}`）
全部留著，`tsc` 也過得了，因為 `disabled?` 是選填的。錯的只是 App 忘了接。整份計畫裡唯一會
發現這件事的就是這條測試，所以它不能省。

七個突變逐一還原後都跑回全綠，全專案重跑：

```
 Test Files  9 passed (9)
      Tests  139 passed (139)
```

- [ ] **Step 6: 提交**

```bash
git add src/renderer/approvals.ts \
        src/renderer/hooks/useApprovals.ts \
        src/renderer/components/ApprovalCard.tsx \
        src/renderer/components/ApprovalCard.css \
        src/renderer/App.tsx \
        tests/approvals.test.ts \
        tests/approval-card.test.tsx \
        tests/use-approvals.test.tsx \
        vitest.config.ts
git commit -m "feat: 工具批准卡片端到端（toolUseId 比對、未對應請求不丟棄）"
```

## 跨 task 發現：`.test.tsx` 現在不會被 Vitest 收集

`vitest.config.ts` 的 `include: ['tests/**/*.test.ts']` 不涵蓋 `.test.tsx`，指令列指定檔名也
救不了（檔名過濾是在 `include` 找到的檔案裡篩）。實測輸出見 Step 2。

這條不只影響本 task：Task 9 建立的 `tests/markdown-component.test.tsx` 在現行設定下同樣一個
測試都不會跑，而 Task 9 的 Step 4 寫著跑過 `npm test tests/markdown-component.test.tsx`。
接縫補記已把這行的歸屬定給 Task 9（改成 `'tests/**/*.test.{ts,tsx}'`，只做一次），本 task 與
9B／11 只在 Step 2 確認。建議控制端順手確認 Task 9 的 9 個測試在補上這行之後是不是真的全綠。

## 手動檢查清單（Electron 裡才驗得到的部分）

自動測試涵蓋不到 preload 與真實 IPC，下面五項在 `npm run dev` 裡人工確認：

1. 一個需要批准的工具（例如 Bash）跑起來時，卡片出現在該工具呼叫的正下方，不是彈窗
2. 按「允許」後卡片消失、工具繼續執行；按「拒絕」後工具不執行，對話裡留下拒絕的記錄
3. 卡片點一下取得焦點後按 y／n 有效；焦點在輸入框時打 y 不會誤送
4. 卡片還在時輸入框停用、按下允許或拒絕之後恢復（規格 §6；`disabled` 的接線在本 task，
   Step 1c 有自動測試，這裡確認真實 Electron 裡也是同一個行為）
5. 批准出現時切換到另一條歷史對話：卡片消失，且主程序沒有留下掛著的 promise
   （Task 6 的 `denyAll` 已處理，看 log 確認）

## 契約疑慮

1. **`findAskForBlock` 認 `awaiting-approval`，`matchApproval` 不認，兩者的狀態集合不同。**
   裁決 28 對兩個函式都只寫了 `running`／`streaming-input`，但 `applyPendingApprovals` 會把命中的
   block 標成 `awaiting-approval`，而 `renderToolExtra` 讀的正是標過的那份 view。若 `findAskForBlock`
   照字面只認兩個狀態，卡片會在標記生效的下一幀消失。本 task 依裁決 28 括號裡「請自己決定輸入是
   raw view 還是標過的 view」那一句，選了「`findAskForBlock` 吃標過的 view，狀態集合多一個
   `awaiting-approval`；`matchApproval` 吃 raw view，維持兩個狀態」，兩邊各有一條測試與一個突變
   （突變 4、突變 1）。若控制端要改成兩者一致，改的是 `stillOpenForCard` 與那兩條測試。

2. **契約的 renderer 元件介面沒有 `findAskForBlock` 與 `unmatchedAsks`。** 裁決 28 的內文已經定義了
   這兩個函式的行為，但契約「renderer 元件介面」那一節的簽章清單裡仍然只有 `matchApproval` 與
   `applyPendingApprovals`。建議把兩行補進去，讓 Task 12 的驗收知道有這兩個出口。

3. **`App.tsx` 的三方修改已依接縫補記定序，不再是疑慮。** CONTRACT.md 的接縫補記
   （2026-09-02）把演進順序定成 9 → 9B → 10 → 11，並要求每個 task 給的完整檔案必須是前一個
   task 的檔案加上自己的改動。本 task 已照辦：上面 Step 3c 的完整檔案就是 Task 9B Step 3h
   那一份，加上四處改動（三個批准插入點與 `Composer` 的 `disabled`），`Composer`／
   `placeholderFor`／兩個 placeholder 常數／`<aside>` 佔位逐字保留。Task 11 再在這一份之上把
   `<aside>` 換成 `<Recents>`。「誰後做誰負責合併」的寫法補記已明文不接受，本檔不再出現。

4. **`useApprovals` 只在收到非 `live` 的 `SessionState` 時清空 pending，掛載時不清。** 掛載
   當下還沒收到任何狀態推送，此時清空與不清空沒有差別（pending 本來就是空的）；但如果之後
   Task 8 改成掛載時不推初始狀態，而 renderer 又是在 live 中途重新載入的，pending 會是空的、
   舊請求也收不到，這種情況只能靠 main 側重送。目前不處理，記一筆。

---

### Task 11: Recents 側邊欄

規格 §2.3 把「要有 Recents 才算堪用」列為每天用得下去的門檻。那條門檻分成兩半：資料從哪來、畫面怎麼畫。前一半是 Task 7 的 `src/main/session-store.ts`（排在 Task 8 之前，因為 Task 8 的 `ipc-bridge.ts` 要注入它）；本 task 是後一半，renderer 側的 `useSessions` 加 `Recents` 元件加一個相對時間的純函式，以及把 `App.tsx` 的側邊欄佔位換掉。

本 task 排最後，理由是它動的 `App.tsx` 必須疊在 Task 10 交出來的那一版之上。接縫補記把演進順序定成 9 → 9B → 10 → 11，每個 task 給的完整檔案都是前一個 task 的檔案加上自己的改動。所以 Step 3d 的 `App.tsx` 是 Task 10 Step 3c 那一份，只把 `<aside>` 裡的佔位換成 `<Recents>`，其餘一行不動。

`Recents` 本身刻意做得笨。清單是一個 `<ul>`，每筆一個 `<button>`，標題取 `customTitle` 優先否則 `summary`，時間交給一個十五行的純函式 `formatRelativeTime(ms, now)`，`gitBranch` 有才畫。沒有虛擬捲動、沒有搜尋、沒有分組，因為 Task 7 的 `limit: 100` 已經把資料量壓在一百筆以內，加那些東西是在解決還不存在的問題。

`useSessions` 自己訂閱 `session:state`，不從 Task 9B 的 `useConversation` 拿。理由有兩個：一是側邊欄不該為了知道「現在選中哪一場」而依賴對話元件，兩者唯一的共通點只是都讀同一個狀態；二是這樣本 task 可以獨立測，不必連著 9B 一起跑。多一個 `onSessionState` 訂閱者的成本是一個閉包。

實機驗證：本檔所有「已驗證」「實測」都指在 worktree（`git worktree add`，`npm install` 裝好 react 19.2.8／react-dom 19.2.8／@testing-library/react 16.3.3／jsdom 30.0.1／vitest 4.1.11／typescript 7.0.2）裡真的跑過 `npx tsc --noEmit -p .` 與 `npx vitest run`。材料化的上游是 Task 3／4／4B／5／8 的 shared 型別與 `global.d.ts`、Task 7／9／9B／10 的程式碼與測試，`App.tsx` 依 9B → 10 → 11 的順序套過兩次，最後一版就是 Step 3d 這一份。全專案 12 個測試檔 181 個測試全綠、`tsc` 退出碼 0，本 task 的兩個測試檔佔其中 31 個。三個突變逐一改壞、跑紅、還原、回綠，輸出見 Step 5。

裁決 21 補記（2026-09-02，本次修訂加）：標題列的 `title.ts`、`tests/app-title-bar.test.tsx`、`App.tsx`／`App.css` 的 header 改動是這次依裁決 21 補上的，只在文件層面推演過，還沒有像上一段那樣真的在 worktree 跑過 `vitest run`／`tsc --noEmit`。加上這批之後全專案會是 13 個測試檔、184 個測試（本 task 佔 34），但這個數字要等 Task 11 實際動工時重新在 worktree 跑一次才能當「已驗證」。

**Files:**
- Create: `src/renderer/hooks/useSessions.ts`
- Create: `src/renderer/components/Recents.tsx`
- Create: `src/renderer/components/Recents.css`
- Create: `src/renderer/components/relative-time.ts`
- Create: `tests/recents.test.tsx`
- Create: `tests/use-sessions.test.tsx`
- Create: `src/renderer/title.ts`
- Create: `tests/app-title-bar.test.tsx`
- Modify: `src/renderer/App.tsx`（Task 10 的版本，把 `<aside>` 裡的佔位換成 `<Recents>`，並在最上面加 `<header className="title-bar">`，裁決 21）
- Modify: `src/renderer/App.css`（加 `.title-bar` 樣式，`.app` 的 grid 改成兩欄兩列，裁決 21）
- Modify: `tests/use-conversation.test.tsx`（Task 9B 的假 `YesChefApi` 有一個「Task 9B 不該呼叫 listSessions」的拋錯樁；本 task 之後 `App` 掛上 `Recents`，`useSessions` 一掛載就會呼叫它，那個樁要改成回空清單。細節與實測輸出見 Step 3e）
- Modify: `vitest.config.ts`（裁決 19 指派給本 task 的三個 coverage 條目：`relative-time.ts`、`useSessions.ts`、`title.ts`。`test.include` 那一行由 Task 9 做一次，本 task 只在 Step 2 確認）

`Recents` 自己的樣式全在 `Recents.css` 裡，這個檔案本 task 不動。標題列的取值邏輯拆進 `title.ts`，理由跟 `relative-time.ts` 一樣：純函式獨立成檔，容易單獨看懂，也讓 `App.tsx` 不用把條件判斷寫在 JSX 裡。

`Recents.tsx` 沒有列進 coverage：裁決 19 指派給本 task 的就是 `relative-time.ts` 與 `useSessions.ts` 兩個，元件本身由 `tests/recents.test.tsx` 的 20 條測試守著，不另外算覆蓋率。

**Interfaces:**
- Consumes:
  - `interface SessionSummary`（Task 7 首次加入 `src/shared/ipc.ts`，Task 8 改寫該檔時保留；六個欄位照裁決 7）
  - `interface YesChefApi`（Task 8，`src/shared/ipc.ts`，以裁決 14 定稿版為準）：用到的是 `onSessionState`、`listSessions`、`startNew`、`openHistory`，加上裁決 21 的 `projectDir`（標題列）
  - `type SessionState`（Task 5，`src/shared/session-state.ts`）
  - `window.yeschef`（Task 8 的 `src/renderer/global.d.ts`）
  - `App.tsx` 的 Task 10 版本（Task 10 Step 3c 的完整檔案）：本 task 的 Step 3d 是它加上一處改動
  - `SessionStore`／`createSessionStore`（Task 7，`src/main/session-store.ts`）：**只在敘述層面**。renderer 不 import main，本 task 的程式碼一個字都碰不到 `session-store.ts`。真正的關係是這條鏈：Task 7 的 `list()` 回傳 `SessionSummary[]`，Task 8 的 `session:list` handler 把它送過 IPC，`useSessions` 呼叫 `api.listSessions()` 收到同一份資料。所以 Task 7 的三件事會直接顯示在側邊欄上：`limit: 100` 決定清單最多幾筆、`lastModified` 由新到舊的排序決定顯示順序、`summary` 的退回鏈決定沒有摘要的那幾筆長什麼樣。這三件事本 task 都不重做也不覆寫。
- Produces:
  - `src/renderer/components/relative-time.ts`
    - `function formatRelativeTime(ms: number, now: number): string`
  - `src/renderer/title.ts`
    - `function titleFor(projectDir: string, current: string | undefined, sessions: readonly SessionSummary[]): string`（裁決 21：標題列文字）
  - `src/renderer/components/Recents.tsx`
    - `interface RecentsProps`（契約四個 props 加一個選填的 `error?: string`，接縫補記已接受）
    - `function Recents(props: RecentsProps)`（回傳型別不標註，照 Task 9 的慣例）
  - `src/renderer/hooks/useSessions.ts`
    - `interface UseSessions { readonly sessions: readonly SessionSummary[]; readonly current?: string; readonly error?: string }`
    - `function useSessions(api: YesChefApi): UseSessions`
    - `function currentSessionId(state: SessionState): string | undefined`

- [ ] **Step 1a: 寫失敗的測試（Recents，jsdom 環境）**

`tests/recents.test.tsx`。檔首用 Task 9 定下的 per-file 註記 `// @vitest-environment jsdom`，不動 `vitest.config.ts` 的 `environment`。時間用 `vi.setSystemTime` 凍住，`formatRelativeTime` 本身是純函式，另外直接測。

「點清單第二筆」與「點第三筆」這兩條是刻意的：只點第一筆的話，「`onOpen` 永遠傳 `sessions[0].sessionId`」這個退化實作照樣全綠。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Recents, type RecentsProps } from '../src/renderer/components/Recents.js'
import { formatRelativeTime } from '../src/renderer/components/relative-time.js'
import type { SessionSummary } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const THREE: readonly SessionSummary[] = [
  { sessionId: 's-1', summary: '第一場', lastModified: NOW - 2 * MINUTE, gitBranch: 'main' },
  { sessionId: 's-2', summary: '第二場', lastModified: NOW - 3 * HOUR, customTitle: '自訂標題' },
  { sessionId: 's-3', summary: '第三場', lastModified: NOW - 5 * DAY },
]

function renderRecents(over: Partial<RecentsProps> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const onOpen = vi.fn()
  const onStartNew = vi.fn()
  const utils = render(
    <Recents sessions={THREE} onOpen={onOpen} onStartNew={onStartNew} {...over} />
  )
  return { ...utils, onOpen, onStartNew }
}

describe('formatRelativeTime', () => {
  it.each([
    ['一分鐘內是剛剛', NOW - 30_000, '剛剛'],
    ['未滿一小時用分鐘', NOW - 59 * MINUTE, '59 分鐘前'],
    ['未滿一天用小時', NOW - 23 * HOUR, '23 小時前'],
    ['未滿三十天用天', NOW - 29 * DAY, '29 天前'],
    ['超過三十天用日期', Date.UTC(2026, 0, 15), '2026-01-15'],
  ])('%s', (_label, ms, expected) => {
    expect(formatRelativeTime(ms, NOW)).toBe(expected)
  })

  it('剛好一分鐘就進位成 1 分鐘前，不再是剛剛', () => {
    expect(formatRelativeTime(NOW - MINUTE, NOW)).toBe('1 分鐘前')
  })

  it('時鐘偏差導致的未來時間顯示剛剛，不顯示負數', () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe('剛剛')
  })

  it('不是有限數字時給明確文案，不產生 Invalid Date', () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('時間不明')
  })
})

describe('Recents 清單', () => {
  it('每一筆都畫出來，customTitle 優先於 summary', () => {
    const { container } = renderRecents()
    const titles = [...container.querySelectorAll('.recents-title')].map((n) => n.textContent)
    expect(titles).toEqual(['第一場', '自訂標題', '第三場'])
  })

  it('顯示相對時間', () => {
    const { container } = renderRecents()
    const times = [...container.querySelectorAll('time')].map((n) => n.textContent)
    expect(times).toEqual(['2 分鐘前', '3 小時前', '5 天前'])
  })

  it('有 gitBranch 才顯示分支', () => {
    const { container } = renderRecents()
    const branches = [...container.querySelectorAll('.recents-branch')].map((n) => n.textContent)
    expect(branches).toEqual(['main'])
  })

  it('current 那一筆才有高亮，其餘沒有', () => {
    const { container } = renderRecents({ current: 's-2' })
    const items = [...container.querySelectorAll('.recents-item')]
    expect(items.map((n) => n.classList.contains('is-current'))).toEqual([false, true, false])
    expect(items.map((n) => n.getAttribute('aria-current'))).toEqual([null, 'true', null])
  })

  it('沒有 current 時三筆都不高亮', () => {
    const { container } = renderRecents()
    expect(container.querySelectorAll('.is-current')).toHaveLength(0)
  })
})

describe('Recents 互動', () => {
  // 點第二筆而不是第一筆：實作若退化成永遠傳第一筆的 sessionId，這條會紅。
  it('點清單第二筆時帶著那一筆的 sessionId 呼叫 onOpen', () => {
    const { container, onOpen, onStartNew } = renderRecents()
    const items = container.querySelectorAll('.recents-item')
    fireEvent.click(items[1] as Element)
    expect(onOpen.mock.calls).toEqual([['s-2']])
    expect(onStartNew).not.toHaveBeenCalled()
  })

  it('點第三筆帶第三筆的 sessionId', () => {
    const { container, onOpen } = renderRecents()
    fireEvent.click(container.querySelectorAll('.recents-item')[2] as Element)
    expect(onOpen.mock.calls).toEqual([['s-3']])
  })

  it('新對話按鈕呼叫 onStartNew，不呼叫 onOpen', () => {
    const { container, onOpen, onStartNew } = renderRecents()
    fireEvent.click(container.querySelector('.recents-new') as Element)
    expect(onStartNew).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('Recents 的空清單與錯誤', () => {
  it('沒有歷史對話時給明確文案', () => {
    const { container } = renderRecents({ sessions: [] })
    expect(container.querySelector('.recents-empty')?.textContent).toBe('還沒有歷史對話')
    expect(container.querySelector('.recents-error')).toBeNull()
  })

  it('載入失敗時顯示錯誤，且不顯示「還沒有歷史對話」', () => {
    const { container } = renderRecents({ sessions: [], error: '讀取歷史對話清單失敗' })
    expect(container.querySelector('.recents-error')?.textContent).toBe('讀取歷史對話清單失敗')
    expect(container.querySelector('.recents-empty')).toBeNull()
  })

  it('錯誤與舊清單同時存在時，兩者都看得到', () => {
    const { container } = renderRecents({ error: '讀取歷史對話清單失敗' })
    expect(container.querySelector('.recents-error')).not.toBeNull()
    expect(container.querySelectorAll('.recents-item')).toHaveLength(3)
  })

  it('新對話按鈕在錯誤狀態下仍然可用', () => {
    const { container, onStartNew } = renderRecents({ sessions: [], error: '壞了' })
    fireEvent.click(container.querySelector('.recents-new') as Element)
    expect(onStartNew).toHaveBeenCalledTimes(1)
  })
})
```
- [ ] **Step 1b: 寫失敗的測試（useSessions，jsdom 環境）**

`tests/use-sessions.test.tsx`。假的 `YesChefApi` 記錄 `listSessions` 被叫了幾次、`onSessionState` 的取消訂閱被叫了幾次，並提供一個 `push(state)` 把狀態推給所有監聽者。`respond(call)` 讓每一次呼叫可以回不同結果，用來測「第一次成功、第二次失敗」這種順序。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useSessions } from '../src/renderer/hooks/useSessions.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { SessionSummary, YesChefApi } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
})

const one: SessionSummary = { sessionId: 's-1', summary: '第一場', lastModified: 1 }
const two: SessionSummary = { sessionId: 's-2', summary: '第二場', lastModified: 2 }

interface Harness {
  readonly api: YesChefApi
  push(state: SessionState): void
  readonly listCalls: () => number
  readonly unsubscribed: () => number
}

function harness(
  respond: (call: number) => Promise<readonly SessionSummary[]> = async () => [one]
): Harness {
  let calls = 0
  let unsubscribed = 0
  const listeners: ((s: SessionState) => void)[] = []
  const api = {
    onEvents: () => () => undefined,
    onApprovalAsk: () => () => undefined,
    onSessionState: (cb: (s: SessionState) => void) => {
      listeners.push(cb)
      return () => {
        unsubscribed += 1
      }
    },
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: () => {
      calls += 1
      return respond(calls)
    },
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: '/Users/x/Projects/demo',
  } as unknown as YesChefApi
  return {
    api,
    push: (state) => {
      act(() => {
        for (const l of listeners) l(state)
      })
    },
    listCalls: () => calls,
    unsubscribed: () => unsubscribed,
  }
}

describe('useSessions 的載入時機', () => {
  it('掛載時就載入一次清單', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.sessions).toEqual([one])
    })
    expect(h.listCalls()).toBe(1)
  })

  it('一場新對話結束後（live → idle）重新載入，Recents 才會出現那一筆', async () => {
    const h = harness(async (call) => (call === 1 ? [] : [two]))
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    expect(result.current.sessions).toEqual([])

    h.push({ kind: 'live' })
    h.push({ kind: 'idle' })

    await waitFor(() => {
      expect(result.current.sessions).toEqual([two])
    })
    expect(h.listCalls()).toBe(3)
  })

  it('切到另一場歷史對話會重載', async () => {
    const h = harness()
    renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    h.push({ kind: 'viewing', sessionId: 's-b' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(3)
    })
  })

  it('內容相同的狀態重複推送不重載，避免每一次推播都打一次 SDK', async () => {
    const h = harness()
    renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await Promise.resolve()
    expect(h.listCalls()).toBe(2)
  })

  it('卸載時取消 session:state 訂閱', async () => {
    const h = harness()
    const { unmount } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    unmount()
    expect(h.unsubscribed()).toBe(1)
  })
})

describe('useSessions 的 current', () => {
  it('viewing 時 current 是正在看的那一場', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    h.push({ kind: 'viewing', sessionId: 's-old' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-old')
    })
  })

  it('live 帶 sessionId 時 current 是那一場', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    h.push({ kind: 'live', sessionId: 's-live' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-live')
    })
  })

  it('idle 沒有 current', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    h.push({ kind: 'viewing', sessionId: 's-old' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-old')
    })
    h.push({ kind: 'idle' })
    await waitFor(() => {
      expect(result.current.current).toBeUndefined()
    })
  })
})

describe('useSessions 的錯誤處理', () => {
  it('載入失敗時給出錯誤訊息，而不是安靜地變成空清單', async () => {
    const h = harness(async () => {
      throw new Error('讀取歷史對話清單失敗，Recents 無法顯示')
    })
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.error).toBe('讀取歷史對話清單失敗，Recents 無法顯示')
    })
    expect(result.current.sessions).toEqual([])
  })

  it('失敗時保留上一次讀到的清單，畫面不會突然清空', async () => {
    const h = harness(async (call) => {
      if (call === 1) return [one]
      throw new Error('壞了')
    })
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.sessions).toEqual([one])
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(result.current.error).toBe('壞了')
    })
    expect(result.current.sessions).toEqual([one])
  })

  it('重試成功後錯誤訊息清掉', async () => {
    const h = harness(async (call) => {
      if (call === 1) throw new Error('壞了')
      return [two]
    })
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.error).toBe('壞了')
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(result.current.sessions).toEqual([two])
    })
    expect(result.current.error).toBeUndefined()
  })
})
```

- [ ] **Step 1c: 寫失敗的測試（App 標題列，jsdom 環境，裁決 21）**

`tests/app-title-bar.test.tsx`。這個假 `YesChefApi` 跟 1a／1b 的都不一樣：`onSessionState` 要支援多個訂閱者（`useConversation` 與 `useSessions`各訂一份），`listSessions` 要真的回資料而不是拋錯樁，因為標題列的第二、三條測試就是要看 `sessions` 裡的 `cwd`。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { App } from '../src/renderer/App.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { SessionSummary, YesChefApi } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PROJECT_DIR = '/Users/x/Projects/demo'

function createFake(sessions: readonly SessionSummary[]): {
  readonly api: YesChefApi
  push(state: SessionState): void
} {
  const stateListeners = new Set<(state: SessionState) => void>()
  const api: YesChefApi = {
    onEvents: () => () => undefined,
    onApprovalAsk: () => () => undefined,
    onSessionState: (cb) => {
      stateListeners.add(cb)
      return () => {
        stateListeners.delete(cb)
      }
    },
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: () => Promise.resolve(sessions),
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: PROJECT_DIR,
  }
  return {
    api,
    push: (state) => {
      act(() => {
        for (const l of stateListeners) l(state)
      })
    },
  }
}

function titleBarText(container: HTMLElement) {
  return container.querySelector('.title-bar')?.textContent
}

describe('App 標題列（裁決 21）', () => {
  it('idle 時顯示 api.projectDir', () => {
    const fake = createFake([])
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    expect(titleBarText(container)).toBe(PROJECT_DIR)
  })

  it('viewing 一筆有 cwd 的 session 時顯示該 cwd', async () => {
    const withCwd: SessionSummary = {
      sessionId: 's-1',
      summary: '一場對話',
      lastModified: 1,
      cwd: '/Users/x/Projects/other',
    }
    const fake = createFake([withCwd])
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

    fake.push({ kind: 'viewing', sessionId: 's-1' })

    await waitFor(() => {
      expect(titleBarText(container)).toBe('/Users/x/Projects/other')
    })
  })

  it('viewing 一筆沒有 cwd 的 session 時顯示「目錄不明」', async () => {
    const noCwd: SessionSummary = { sessionId: 's-2', summary: '另一場對話', lastModified: 1 }
    const fake = createFake([noCwd])
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

    fake.push({ kind: 'viewing', sessionId: 's-2' })

    await waitFor(() => {
      expect(titleBarText(container)).toBe('目錄不明')
    })
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

先確認 `vitest.config.ts` 的 `include` 收得到 `.tsx`：

```
include: ['tests/**/*.test.{ts,tsx}'],
```

這一行由 Task 9 改（接縫補記定它只做一次），本 task 只確認在不在，不在就先補上再往下走。不是預防性的檢查：專案原本的 `include` 只寫 `*.test.ts`，picomatch 不把 `.test.tsx` 算進去，而且是靜默的，不警告、不失敗、就是不執行。在 worktree 裡放一個只有 `expect(1).toBe(1)` 的 `tests/smoke.test.tsx` 跑 `npx vitest run`，結果是 `Test Files 4 passed (4)`，而當時的 `.test.ts` 檔正好就是 4 個，那個 `.tsx` 完全沒跑。補上 pattern 之後同一個指令變成 `Test Files 5 passed (5)`。

Run: `npm test tests/recents.test.tsx tests/use-sessions.test.tsx tests/app-title-bar.test.tsx`
Expected: FAIL，無法解析 `../src/renderer/components/Recents.js`、`../src/renderer/components/relative-time.js`、`../src/renderer/hooks/useSessions.js`；`app-title-bar.test.tsx` 這份會等到 Step 3d 加上 `<header className="title-bar">` 之後才真的變綠，Step 3a／3b／3c 做完的當下它仍然是紅的（`.title-bar` 找不到）

- [ ] **Step 3: 寫最小實作**

`vitest.config.ts` 的 coverage 加兩行（裁決 19：只用 diff 加自己的檔案，不重寫整份清單）：

```diff
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/renderer/components/relative-time.ts',
+        'src/renderer/hooks/useSessions.ts',
+        'src/renderer/title.ts',
       ],
     },
```
**3a. `src/renderer/components/relative-time.ts`**：

```typescript
/** 相對時間文案。純函式，now 由呼叫端傳入，測試不需要動系統時鐘。 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return '時間不明'
  const diff = now - ms
  // diff 為負是時鐘偏差（session 檔的 mtime 比本機時間新）。顯示「剛剛」而不是
  // 負數的分鐘，因為使用者要的是「這場很新」這個訊息，不是精確的時間差。
  if (diff < MINUTE) return '剛剛'
  if (diff < HOUR) return `${String(Math.floor(diff / MINUTE))} 分鐘前`
  if (diff < DAY) return `${String(Math.floor(diff / HOUR))} 小時前`
  if (diff < 30 * DAY) return `${String(Math.floor(diff / DAY))} 天前`
  return new Date(ms).toISOString().slice(0, 10)
}
```
**3b. `src/renderer/components/Recents.tsx` 與 `Recents.css`**：

```tsx
import type { SessionSummary } from '../../shared/ipc.js'
import { formatRelativeTime } from './relative-time.js'
import './Recents.css'

export interface RecentsProps {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly onOpen: (sessionId: string) => void
  readonly onStartNew: () => void
  /** 契約四個 props 之外唯一的追加，理由見本檔末的「契約疑慮」。 */
  readonly error?: string
}

/** 裁決 7 的 SessionSummary 兩個欄位都可能是標題，customTitle 是使用者自己下的，優先。 */
function titleOf(s: SessionSummary): string {
  const custom = (s.customTitle ?? '').trim()
  return custom === '' ? s.summary : custom
}

export function Recents({ sessions, current, onOpen, onStartNew, error }: RecentsProps) {
  const at = Date.now()
  return (
    <nav className="recents" aria-label="歷史對話">
      <button type="button" className="recents-new" onClick={onStartNew}>
        新對話
      </button>
      {error === undefined ? null : (
        <p className="recents-error" role="alert">
          {error}
        </p>
      )}
      {/* 有錯誤時不顯示「還沒有歷史對話」：讀不到跟真的沒有是兩件事，
          顯示成後者等於用一句安慰的話蓋掉一個故障。 */}
      {error === undefined && sessions.length === 0 ? (
        <p className="recents-empty">還沒有歷史對話</p>
      ) : null}
      <ul className="recents-list">
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <button
              type="button"
              className={s.sessionId === current ? 'recents-item is-current' : 'recents-item'}
              aria-current={s.sessionId === current ? 'true' : undefined}
              onClick={() => {
                onOpen(s.sessionId)
              }}
            >
              <span className="recents-title">{titleOf(s)}</span>
              <span className="recents-meta">
                <time dateTime={new Date(s.lastModified).toISOString()}>
                  {formatRelativeTime(s.lastModified, at)}
                </time>
                {s.gitBranch === undefined ? null : (
                  <span className="recents-branch">{s.gitBranch}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

```css
.recents { display: flex; flex-direction: column; height: 100%; }
.recents-new { margin: 8px; padding: 6px 10px; cursor: pointer; }
.recents-error { margin: 8px; color: #ff9a8c; }
.recents-empty { margin: 8px; opacity: 0.6; }
.recents-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.recents-item { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 6px 10px; border: 0; background: none; color: inherit; text-align: left; cursor: pointer; }
.recents-item.is-current { background: #232720; }
.recents-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recents-meta { display: flex; gap: 8px; font-size: 11px; opacity: 0.6; }
```
**3c. `src/renderer/hooks/useSessions.ts`**：

這個 hook 自己訂閱 `session:state`，不從 Task 9B 的 `useConversation` 拿。理由有兩個：一是側邊欄不該為了知道「現在選中哪一場」而依賴對話元件，兩者唯一的共通點只是都讀同一個狀態；二是這樣本 task 可以獨立測，不必等 9B。多一個 `onSessionState` 訂閱者的成本是一個閉包。

```typescript
import { useEffect, useState } from 'react'
import type { SessionState } from '../../shared/session-state.js'
import type { SessionSummary, YesChefApi } from '../../shared/ipc.js'

export interface UseSessions {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly error?: string
}

const IDLE: SessionState = { kind: 'idle' }

/** 目前選中的那一筆（裁決 14）。idle 沒有選中的 session。 */
export function currentSessionId(state: SessionState): string | undefined {
  return state.kind === 'idle' ? undefined : state.sessionId
}

/**
 * 依 SessionState 產生的重載鍵。用字串而不是直接把 state 物件放進 deps：
 * main 每次推 session:state 都是新物件，用物件當 deps 會讓每一次推送都重打一次
 * listSessions。內容相同就不重載，內容變了才重載。
 */
function reloadKey(state: SessionState): string {
  return `${state.kind}:${currentSessionId(state) ?? ''}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : '讀取歷史對話清單失敗'
}

export function useSessions(api: YesChefApi): UseSessions {
  const [state, setState] = useState<SessionState>(IDLE)
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => api.onSessionState(setState), [api])

  const key = reloadKey(state)
  useEffect(() => {
    // cancelled 擋的是慢的舊請求蓋掉快的新請求：連按兩筆歷史對話時會有兩次
    // listSessions 同時在飛，先發的後回就會把畫面倒退回舊清單。
    let cancelled = false
    api
      .listSessions()
      .then((list) => {
        if (cancelled) return
        setSessions(list)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 不清空 sessions：清單讀不到時，把上一次讀到的留在畫面上比變成空白有用。
        setError(messageOf(err))
      })
    return () => {
      cancelled = true
    }
  }, [api, key])

  const current = currentSessionId(state)
  return {
    sessions,
    ...(current === undefined ? {} : { current }),
    ...(error === undefined ? {} : { error }),
  }
}
```

一個已知的限制寫在這裡免得日後有人當成 bug：一場全新對話在 `session-start` 到達之前，`SessionState` 是 `{ kind: 'live' }` 沒有 `sessionId`（Task 5 的 `transition` 對 `start-new` 就是這樣回的），所以那段期間 `current` 是 `undefined`，Recents 沒有任何一筆高亮。這是誠實的：那場對話還沒有 id，清單上也還沒有它。等 Task 8 之後把 `session-start` 的 sessionId 回填進 `SessionState`，這裡不用改就會自動正確。

**3c-2. `src/renderer/title.ts`**（裁決 21：標題列文字，跟 `relative-time.ts` 一樣拆成獨立的純函式檔）：

```typescript
import type { SessionSummary } from '../shared/ipc.js'

const UNKNOWN_DIR = '目錄不明'

/**
 * 標題列文字（裁決 21）。沒有正在看哪一場（idle 或全新 live）時顯示目前專案的目錄；
 * 有 current 時顯示那一筆 session 記錄的 cwd，沒記到 cwd 就顯示「目錄不明」。
 * 找不到那個 sessionId（理論上不會發生，current 一定來自 sessions 同一份 session:state）
 * 的處理方式跟「有這筆但沒 cwd」相同，都是 undefined，不需要另外判斷。
 */
export function titleFor(
  projectDir: string,
  current: string | undefined,
  sessions: readonly SessionSummary[]
): string {
  if (current === undefined) return projectDir
  return sessions.find((s) => s.sessionId === current)?.cwd ?? UNKNOWN_DIR
}
```

**3d. `src/renderer/App.tsx`**（Task 10 的版本改兩處：`<aside>` 裡的佔位換成 `<Recents>`，最上面加 `<header className="title-bar">`；下面是改完之後的完整檔案，逐字取代原檔）：

```tsx
import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Conversation, type ToolBlock } from './components/Conversation.js'
import { ApprovalCard } from './components/ApprovalCard.js'
import { Recents } from './components/Recents.js'
import { useConversation } from './hooks/useConversation.js'
import { useApprovals } from './hooks/useApprovals.js'
import { useSessions } from './hooks/useSessions.js'
import { applyPendingApprovals, findAskForBlock, unmatchedAsks } from './approvals.js'
import { titleFor } from './title.js'
import type { SessionState } from '../shared/session-state.js'
import './App.css'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly onSend: (text: string) => void
  /** 有待決的批准請求時停用（規格 §6）。Task 9B 把這個 prop 留給 Task 10 接上。 */
  readonly disabled?: boolean
}

function Composer({ placeholder, onSend, disabled = false }: ComposerProps) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        className="composer-input"
        aria-label="輸入訊息"
        rows={3}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="composer-send" disabled={disabled}>
        送出
      </button>
    </form>
  )
}

function placeholderFor(state: SessionState): string {
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

/**
 * 「左＋中」這一個 React renderer（規格 §3，裁決 9）。右窗格是獨立的
 * WebContentsView，由主程序疊在視窗上，不在這棵 tree 裡。
 *
 * 批准的三個插入點（Task 10）：
 * 1. `applyPendingApprovals`：把命中的 tool block 標成 awaiting-approval
 * 2. `renderToolExtra`：把卡片畫進對應的 ToolCall 底部
 * 3. `unmatchedAsks`：對應不到 block 的請求畫在對話尾端，不靜默丟棄
 * 4. `Composer` 的 `disabled`：有待決請求時輸入框停用（規格 §6，9B 交棒）
 *
 * 側邊欄（Task 11）：`useSessions` 自己訂閱 session:state，不從 useConversation 拿。
 *
 * 第 2 點的命中查找一定要走 `findAskForBlock`，不能在這裡重寫一次比對：
 * 兩份比對邏輯遲早會漂移成「狀態標在 A、卡片畫在 B」。
 *
 * 標題列（Task 11，裁決 21）：跨專案的 Recents 讓使用者看得到別的目錄的歷史對話，
 * 代價是要有個地方講清楚「現在看的到底是哪個目錄」，取值邏輯交給 `titleFor`。
 */
export function App() {
  const api = window.yeschef
  const { view: rawView, sessionState } = useConversation(api)
  const { pending, reply } = useApprovals(api)
  const { sessions, current, error } = useSessions(api)

  const view = useMemo(() => applyPendingApprovals(rawView, pending), [rawView, pending])
  const orphans = useMemo(() => unmatchedAsks(view, pending), [view, pending])

  const renderToolExtra = useCallback(
    (block: ToolBlock) => {
      const ask = findAskForBlock(block, pending)
      return ask === undefined ? null : <ApprovalCard ask={ask} onDecide={reply} />
    },
    [pending, reply]
  )

  return (
    <div className="app">
      <header className="title-bar">{titleFor(api.projectDir, current, sessions)}</header>
      <aside className="sidebar">
        <Recents
          sessions={sessions}
          current={current}
          error={error}
          onOpen={api.openHistory}
          onStartNew={api.startNew}
        />
      </aside>
      <main className="conversation">
        <Conversation
          view={view}
          historical={sessionState.kind === 'viewing'}
          renderToolExtra={renderToolExtra}
        />
        {orphans.length > 0 ? (
          <div className="approval-tail">
            {orphans.map((ask) => (
              <ApprovalCard key={ask.requestId} ask={ask} onDecide={reply} unmatched />
            ))}
          </div>
        ) : null}
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => api.sendInput(text)}
          disabled={pending.length > 0}
        />
      </main>
    </div>
  )
}
```

跟 Task 10 那一版的差別是五行 import 與 hook 呼叫、`<aside>` 裡的一個元素，加上最上面的 `<header className="title-bar">`。`<main>` 那一半一個字都沒動。

`titleFor` 只取三個原始值（`projectDir` 字串、`current` 字串或 undefined、`sessions` 陣列），不吃整個 `api` 物件：跟 Task 9 對 `Markdown` 的要求同一個理由，呼叫端傳基本值，函式本身才好單獨想清楚、單獨測。

`current={current}` 與 `error={error}` 直接寫，不用 `{...(current === undefined ? {} : { current })}` 這種條件展開：接縫補記已確認 `tsconfig.json` 沒開 `exactOptionalPropertyTypes`，`string | undefined` 賦給 `?: string` 直接可過。已在 worktree 實測 `npx tsc --noEmit -p .` 退出碼 0。

`onOpen={api.openHistory}` 與 `onStartNew={api.startNew}` 直接傳函式參照，不包 `useCallback`：`api` 就是 `window.yeschef`，由 preload 建立一次就不再變，它身上的方法參照也跟著穩定。`Recents` 沒有 memo，包了也省不到什麼。

**3d-2. `src/renderer/App.css`**（Task 9B 那一份加 `.title-bar`，`.app` 的 grid 從一列改兩列；下面是完整檔案，逐字取代原檔，`.conversation`／`.placeholder`／`.composer`／`.composer-input` 四條是 Task 9B 定的，一行不改）：

```css
html,
body,
#root {
  height: 100%;
  margin: 0;
}

.app {
  --sidebar-width: 280px;

  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  grid-template-rows: auto 1fr;
  height: 100%;
  font-family: ui-monospace, Menlo, monospace;
  color: #d8dcd4;
  background: #12140f;
}

.title-bar {
  grid-column: 1 / -1;
  padding: 4px 10px;
  font-family: ui-monospace, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid #2a2d24;
}

.sidebar {
  border-right: 1px solid #2a2d24;
  overflow-y: auto;
}

.conversation { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.placeholder { padding: 12px; opacity: 0.6; }
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #2a2d24; }
.composer-input { flex: 1 1 auto; resize: vertical; font: inherit; }
```

`.app` 原本只定 `grid-template-columns`（兩欄一列，`<aside>` 與 `<main>` 各佔一格），沒有明講 `grid-template-rows`，因為當時只有一列。加 `<header>` 之後改成兩欄兩列：第一列給標題列，`grid-column: 1 / -1` 讓它跨滿兩欄；第二列還是 `<aside>` 跟 `<main>` 各占一欄，跟 Task 9 那一版一樣不用另外標 `grid-row`，CSS grid 的 auto-placement 本來就會把接下來兩個子元素依序放進第二列。`.sidebar` 之後那四條是 Task 9B 為輸入框改的，本 task 一行不動，列在這裡只是因為「完整檔案」的規矩要求逐字照抄。

**3e. `tests/use-conversation.test.tsx` 的假 api 改一個樁**（Task 9B 的檔案，本 task 動一處）：

Task 9B 的假 `YesChefApi` 把它不該用到的三個成員做成會拋錯的樁，`listSessions` 是其中之一。本 task 之後 `App` 掛上了 `Recents`，`useSessions` 一掛載就呼叫 `api.listSessions()`，於是 9B 那七條 `App` 測試全部炸掉。這不是 9B 寫錯，是接縫本身：那個樁在寫的當下是對的。改法是讓它回一個空清單。

```diff
     listSessions(): Promise<readonly SessionSummary[]> {
-      throw new Error('Task 9B 不該呼叫 listSessions')
+      // Task 11 之後 App 會掛上 Recents，useSessions 一掛載就呼叫這個。
+      // 本檔測的是對話那一半，回空清單即可。
+      return Promise.resolve([])
     },
```

`startNew` 與 `openHistory` 那兩個樁不用動：`App` 只是把它們當 prop 傳給 `Recents`，沒有呼叫，除非測試去點側邊欄的按鈕（9B 那七條都不點）。

不改這一行的實測後果（worktree 裡先套上 Step 3d 的 `App.tsx`、暫不改這個樁）：

```
 × Enter 送出並清空輸入框 11ms
 × Shift+Enter 不送出，內容保留 2ms
 × 輸入法組字中的 Enter 不送出（中文輸入選字用的 Enter） 2ms
 × 只有空白時不送出 2ms
 × viewing 時輸入框提示改成接續這條對話 1ms
 × 事件到達時對話出現在畫面上 1ms
 × viewing 時工具卡片展開後顯示歷史對話沒有原始輸出 1ms
Error: Task 9B 不該呼叫 listSessions
 Test Files  1 failed | 11 passed (12)
      Tests  7 failed | 153 passed (160)
```

改完之後同一個指令回到全綠。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/recents.test.tsx`
Expected: PASS，20 個測試（`formatRelativeTime` 的 `it.each` 展開成 5 個）

Run: `npm test tests/use-sessions.test.tsx`
Expected: PASS，11 個測試

Run: `npm test tests/use-conversation.test.tsx`
Expected: PASS，13 個測試（Step 3e 改完之後）

Run: `npm run typecheck`
Expected: 無錯誤。三支產品程式碼分別是 17／63／66 行，加上 `App.tsx` 的 129 行，全部在單檔上限內。

以上四個指令都在 worktree 裡對這份計畫的實際程式碼跑過（`react@19.2.8`、`@testing-library/react@16.3.3`、`jsdom@30.0.1`、`vitest@4.1.11`、`typescript@7.0.2`），不是推論。

Run: `npm test tests/app-title-bar.test.tsx`
Expected: PASS，3 個測試（idle 顯示 `projectDir`、viewing 有 `cwd` 的一筆、viewing 沒有 `cwd` 的一筆各一條）。`title.ts` 本身很短（約 14 行），`App.tsx` 加 header 之後約 131 行，都在單檔上限內；這一項是本次依裁決 21 補的，行數與測試結果尚未重新在 worktree 跑過，實作時要補做一次上面那句「不是推論」涵蓋的驗證。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

三個突變，全部在 worktree 裡實際跑過，紅燈輸出照抄。每一個都是「看起來合理」的寫法，不是明顯的破壞。

| # | 突變 | 變紅的測試 |
|---|---|---|
| 1 | `useSessions` 的載入 effect deps 從 `[api, key]` 改成 `[api]` | 5 條 |
| 2 | 同一個 deps 改成 `[api, state]`（直接放狀態物件） | 1 條 |
| 3 | `Recents` 的 `onClick` 改成 `onOpen(sessions[0]?.sessionId ?? s.sessionId)` | 2 條 |
| 4 | `titleFor` 永遠回 `projectDir`，不看 `current`／`sessions` | 2 條 |

突變 1 的輸出。這是規格 §2.3「要有 Recents 才算堪用」的核心：講完一場新對話之後清單不更新，剛剛那一場就不見了：

```
 × 一場新對話結束後（live → idle）重新載入，Recents 才會出現那一筆 1016ms
 × 切到另一場歷史對話會重載 1005ms
 × 內容相同的狀態重複推送不重載，避免每一次推播都打一次 SDK 1005ms
 × 失敗時保留上一次讀到的清單，畫面不會突然清空 1058ms
 × 重試成功後錯誤訊息清掉 1058ms
AssertionError: expected [] to deeply equal [ { sessionId: 's-2', …(2) } ]
 Tests  5 failed | 6 passed (11)
```

**突變 2 是最需要提防的那種**：`[api, state]` 看起來比 `[api, key]` 更自然，功能上也「對」（狀態一變就重載），錯的是次數。main 每推一次 `session:state` 就是一個新物件，於是每一次推播都打一次 SDK。輸出：

```
 × 內容相同的狀態重複推送不重載，避免每一次推播都打一次 SDK 7ms
AssertionError: expected 4 to be 2 // Object.is equality
 Tests  1 failed | 10 passed (11)
```

突變 3 的輸出。點第二筆與第三筆這兩條測試就是為了它存在，只點第一筆的話這個退化實作照樣全綠：

```
 × 點清單第二筆時帶著那一筆的 sessionId 呼叫 onOpen 8ms
 × 點第三筆帶第三筆的 sessionId 3ms
 Tests  2 failed | 18 passed (20)
```

前三個突變逐一還原後都跑回綠燈，最後一次是全專案一起跑：`Test Files 12 passed (12)`、`Tests 181 passed (181)`（其中 31 個是本 task 新增的，其餘是 worktree 裡既有的 cdp／layout／measure-memory／spawn-args 與材料化的上游測試）。這是裁決 21 之前的實測結果。

突變 4 是本次依裁決 21 補的，未在 worktree 跑過，靠讀 `titleFor` 的程式碼推：把 `current === undefined` 那個分支拿掉、永遠回 `projectDir`，`tests/app-title-bar.test.tsx` 三條裡「idle 顯示 `projectDir`」那一條本來就期待 `projectDir`，不受影響；「viewing 有 cwd」與「viewing 沒有 cwd」這兩條分別期待 `/Users/x/Projects/other` 與「目錄不明」，都會被改成收到 `projectDir`，兩條一起變紅，不是只有一條。還原後預期跟其他三個突變一樣回到全綠。

- [ ] **Step 6: 執行完整測試套件與 typecheck**

Run: `npm run typecheck`
Expected: 無錯誤

Run: `npm test`
Expected: PASS。本 task 為總數加 34（`recents` 20、`use-sessions` 11、`app-title-bar` 3，最後一個是裁決 21 補的）。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/hooks/useSessions.ts \
  src/renderer/components/Recents.tsx src/renderer/components/Recents.css \
  src/renderer/components/relative-time.ts \
  src/renderer/title.ts \
  src/renderer/App.tsx src/renderer/App.css \
  tests/recents.test.tsx tests/use-sessions.test.tsx \
  tests/app-title-bar.test.tsx \
  tests/use-conversation.test.tsx \
  vitest.config.ts
git commit -m "feat: Recents 側邊欄接上 App，加標題列顯示目前目錄"
```

## 手動檢查清單（需要真的跑起來的部分）

單元測試碰不到的四件事，接上 Task 7 的 `session-store` 與 Task 8 的組裝點之後手動確認：

| # | 檢查 | 操作 | 預期 |
|---|---|---|---|
| 1 | Recents 真的列得出來 | `YESCHEF_PROJECT_DIR=$HOME/你的專案 npm run dev` | 側邊欄出現最近 100 筆，跨全部專案，最新的在最上面 |
| 2 | 新對話結束後清單更新 | 開新對話、問一句、等它答完 | 那一場出現在清單第一列 |
| 3 | 點歷史對話 | 點第二列 | 該筆高亮、對話區顯示歷史內容、工具呼叫展開後看到裁決 4 的文案 |
| 4 | `.title-bar` 標題列跟著切換（裁決 21） | 點別的專案的歷史對話，再按「開新對話」 | 標題列先換成那場對話原本的目錄，按「開新對話」後換回 `YESCHEF_PROJECT_DIR` |

裁決 18 明文保留 Task 11 的手動清單：本 task 是最後一個，commit 當下 Task 7 的資料層、Task 8 的 IPC、Task 9／9B／10 的 UI 都已經在，這三項現在就操作得到。第 1 與第 3 項驗的其實是 Task 7 那一半的產出（清單怎麼來、歷史怎麼載），本 task 只負責畫，兩邊接不上時先看 Task 7。第 4 項是裁決 21 加的，跨兩個裁決：`cwd` 從哪來要看裁決 20（跨專案 resume 帶原本的 cwd），標題列怎麼畫是本 task 的 `titleFor`。更完整的端對端驗收在 Task 12。

## 契約疑慮（照契約字面做完，列出待裁決）

**一、`RecentsProps` 多一個選填的 `error?: string`：接縫補記已接受，不再是疑慮。** 契約原本定四個 props。接縫補記（2026-09-02）明寫「`RecentsProps` 加 `readonly error?: string`：載入失敗時由 Recents 自己顯示錯誤並抑制『還沒有歷史對話』」。這裡記錄理由供日後查閱：「不顯示空清單」這件事只有 `Recents` 自己做得到，錯誤如果畫在 `App` 那一層，`Recents` 仍然會同時顯示「還沒有歷史對話」，等於用一句安慰的話蓋掉一個故障。選填欄位對 Task 9B 與 Task 10 沒有影響，兩者都不用 `Recents`。

**二、`createSessionStore` 不收 `projectDir`：接縫補記已定案，且不在本 task 範圍。** 補記明寫「規格 §3.1／§3.2 定 Recents 跨專案，`listSessions()` 不帶 `dir`，預設 `limit: 100`」。實作在 Task 7，本 task 只是那個決定的下游：側邊欄看得到別的專案的對話，是因為 Task 7 沒帶 `dir`。這裡不需要裁決，記錄依賴關係。

**三、Task 8 的 `SessionSource` 與契約的 `SessionStore` 形狀：已一致。** 這條屬 Task 7 與 Task 8 之間的接縫，Task 8 的 `SessionSource` 已是 `{ list(); loadHistory(sessionId): Promise<readonly Event[]> }`（見 Task 7 的契約疑慮二）。本 task 只在它壞掉時看得到症狀：點歷史對話之後對話區的每一個 block 停在未完成狀態，尾端畫游標。

**四、本 task 動了 Task 9B 的測試檔。** Step 3e 改的是 `tests/use-conversation.test.tsx` 裡一個假 api 的樁。按「不動別的 task 檔」的慣例這需要一句說明：那不是計畫檔而是程式碼，而且改動的必要性完全由本 task 引入（`App` 掛上 `Recents` 之後才會呼叫 `listSessions`）。誰引入誰負責，所以列在本 task 的 Files 與提交清單裡。若控制端偏好由 Task 9B 預先把樁寫成回空清單，本 task 的 Step 3e 就變成 no-op，其餘不受影響。

---

### Task 12: 整合驗收（端對端手動檢查清單）

這是整份計畫的最後一個 task，不寫新功能。它存在的理由是裁決 18：每個 task 的手動檢查只能包含該 task commit 當下就能操作的項目，所以「要整個 app 跑起來才驗得到」的項目全部被推到這裡。前面每個 task 都只驗了自己那一層，沒有人驗過這些零件裝在一起會怎樣。

本 task 做三件事：

1. 逐項執行下面 A 到 H 八組檢查，每一項填 `✓ / ✗` 與「現象」欄。
2. 對發現的缺陷做一次分流：20 行以內且不改任何介面的修正在本 task 直接做並補上單元測試；其餘記進待辦，不硬修。判準寫在 Step 9。
3. 產出 `docs/RESULTS-04-a-sdk-host.md`，體例照 `docs/RESULTS-01-memory.md`（量測日期、機器、量測方法、步驟、結果表、判準）。

**不重複已經驗過的項目。** Task 8 的 Step 10已經驗完 preload 的暴露面五項與壞 payload 兩項，Task 10 的手動清單（Step 6 之後的「手動檢查清單」一節）已經驗完批准卡片的鍵盤操作，Task 11 的手動清單（Step 7 之後的「手動檢查清單」一節）已經驗完 Recents 的三項。本清單只在需要「整條路徑一起動」時引用它們，寫成「Task 11 清單第 3 項在此重跑一次」，不抄內容。

Task 8 Step 10 區塊 2 的十項與區塊 3 的三項在本清單被拆進三組，對照如下，任何一項都沒有被丟掉：

| 原出處 | 原項目 | 本清單位置 |
|---|---|---|
| 區塊 2 第 1、2 項 | 逐字出現、長回覆完整 | C1、C2 |
| 區塊 2 第 3、4、5 項 | 批准卡片內嵌、允許、拒絕 | D1、D2、D3 |
| 區塊 2 第 6 到 10 項 | Recents 五項 | E1 到 E5 |
| 區塊 3 第 1 項 | 批准中關視窗無殘留 | D5 |
| 區塊 3 第 2 項 | 批准中切換 session | D6 |
| 區塊 3 第 5 項 | 批准逾時 | D4 |

**Files:**
- Create: `docs/RESULTS-04-a-sdk-host.md`（本 task 的唯一必產出）
- Modify: 視 Step 9 的分流結果而定，事前無法列舉。每一筆修改都要在 `RESULTS-04` 的「本 task 做掉的修正」一節留下檔案與行數

**Interfaces:**
- Consumes: 全部十一個 task 的產出。本 task 不定義新介面，也不得修改任何既有介面（Step 9 的判準第二條）
- Produces: `docs/RESULTS-04-a-sdk-host.md`

本 task 沒有新的單元測試，突變測試不適用。若 Step 9 做了修正，該修正必須附一條會因它變綠的測試，那條測試照 Global Constraints 做突變驗證。

---

- [ ] **Step 0: 準備環境與報告範本**

先建 `docs/RESULTS-04-a-sdk-host.md` 的範本再開始跑，理由是清單有三十九項，跑到一半才開檔案會漏記現象。範本的完整內容見 Step 10。

環境準備四件事：

```bash
# 1. 確認在正確的分支且工作區乾淨
git status
git branch --show-current   # 預期 feat/a-sdk-host

# 2. 準備兩個目錄：本次要用的專案目錄，以及一個「別的專案」（B3、E1 要用）
ls -d "$HOME/Projects/你的專案"
ls -t ~/.claude/projects | head -20   # 先看一眼現況，B 組要比對前後差異

# 3. 記下起始狀態，B1 用它判斷哪個目錄是新出現的
ls -t ~/.claude/projects > /tmp/projects-before.txt

# 4. 確認 API key 可用（F 組會故意弄壞它，先確認壞掉之前是好的）
echo "${ANTHROPIC_API_KEY:0:8}..."
```

啟動指令固定為：

```bash
YESCHEF_PROJECT_DIR="$HOME/Projects/你的專案" npm run dev
```

`npm run dev` 在 dev 模式會自動開 DevTools（Task 8 Step 6b 的 `loadRenderer`），A、C、D、E、F 幾組要看主程序 log 的地方都在啟動這個終端機的視窗裡看，要看 renderer 錯誤的地方在 DevTools 的 console 看。兩處都要看，只看一邊會把「畫面沒反應」誤判成「功能沒做」。

在報告的表頭記下：量測日期、機器（`sw_vers -productVersion`、`uname -m`、記憶體大小）、Node 與 Electron 版本（`node -v`、`npx electron -v`）、`@anthropic-ai/claude-agent-sdk` 版本（`npm ls @anthropic-ai/claude-agent-sdk`）。這些數字之後對不上時要靠它們判斷是環境變了還是程式壞了。

---

- [ ] **Step 1: A 組，啟動與守門（5 項）**

守門的實作在 Task 1 Step 3 的 `buildSessionOptions`，呼叫點在 Task 8 Step 6b 的 `requireProjectDir`（啟動時空跑一次）與 `createSessionOptionsFactory`。這一組驗的是「設錯環境變數時會不會是靜默失敗」，規格 §3.2（第 89 行）說明了為什麼要擋：`YESCHEF_PROJECT_DIR` 決定新對話開在哪，也就是 Insights 的歸屬。

每一項都是啟動一次、看終端機、關掉，不需要進到 UI。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| A1 | 不設環境變數：`unset YESCHEF_PROJECT_DIR; npm run dev`，然後 `echo $?` | 終端機印出 `[yeschef] 未設定環境變數 YESCHEF_PROJECT_DIR` 加三行怎麼設的指示；沒有任何視窗閃出來；exit code 是 1 | ✓ / ✗ | |
| A2 | 設成不存在的目錄：`YESCHEF_PROJECT_DIR=/nope/nope npm run dev` | 印出 `YESCHEF_PROJECT_DIR 的值不可用：projectDir 不存在：/nope/nope`；exit code 1 | ✓ / ✗ | |
| A2b | 設成 app 自身目錄：`YESCHEF_PROJECT_DIR=$PWD npm run dev` | 印出「不可為 app 自身目錄或其子目錄」與「逐字稿會落在被 Insights 排除的路徑下」；exit code 1 | ✓ / ✗ | |
| A3 | 設成 symlink：`ln -s "$HOME/Projects/你的專案" /tmp/proj-link`，用 `/tmp/proj-link` 啟動，送一則訊息，然後看新產生的 `.jsonl` 第一列的 `cwd` 與它所在的目錄名 | `cwd` 是 realpath 後的 `$HOME/Projects/你的專案`，檔案落在該路徑編碼的目錄下，不是 `-private-tmp-proj-link`。見下方註記 | ✓ / ✗ | |
| A4 | `npm run build` 之後 `ls -l out/preload/bridge.cjs`，再 `YESCHEF_PROJECT_DIR=... npm run start` | build 成功；`bridge.cjs` 存在且大小不是 0（Task 0 的空殼是 0 到數十位元組，Task 8 填完之後應該是數 KB）；`start` 開得起來，左窗格是對話介面不是白畫面 | ✓ / ✗ | |

A1 到 A2b 的三項共同要驗的是「不是白畫面」：如果看到視窗先開出來、左窗格空白、終端機沒有訊息，代表守衛的位置跑到 `createWindow` 之後了，那是 Step 6b 明確排除的順序。

`exit code` 的取法：`npm run dev` 會被 npm 包一層，用 `npm run dev; echo "exit=$?"` 看到的可能是 npm 的 code 而不是 Electron 的。要確認 Electron 自己的 code，改看終端機是否出現 `ELIFECYCLE` 加 `Command failed with exit code 1`，或直接跑 `npx electron-vite dev; echo "exit=$?"`。兩種都記進現象欄。

A3 的依據：Task 1 的 `buildSessionOptions` 回傳 `cwd: input.projectDir`，是使用者給的原字串，`realpathSync.native()` 只用在守衛的比對。symlink 路徑會原樣交給 SDK 當 spawn 的 cwd，但 CLI 讀的是 `process.cwd()`，而 macOS 的 `getcwd(3)` 回傳的是解析過符號連結的實體路徑（本機驗證：`cd /tmp && node -p process.cwd()` 印 `/private/tmp`）。所以逐字稿的 `cwd` 欄位與所在目錄都會是 realpath，與 Task 1 傳什麼字串無關。這一項若是 ✗，代表 CLI 的行為與上述不同，把實際的 `cwd` 值與目錄名寫進現象欄，分流交給 Step 9。

---

- [ ] **Step 2: B 組，Insights 歸屬（3 項加 1 個負面案例）**

這一組是整個專案存在的理由。規格 §1（第 23 行）第一條已查證事實是「Agent SDK 會寫逐字稿到 `~/.claude/projects/`，路徑與 CLI 一致，Insights 讀得到」；規格 §2.3（第 50 行）把 Recents 列為堪用門檻。如果 yeschef 的對話沒有落在正確的專案目錄下，前面十一個 task 做的每一件事都不算數，而且這是靜默失敗，畫面上一切正常。

目錄的編碼規則：專案路徑的每一個 `/` 換成 `-`。實機確認過（本機 `~/.claude/projects` 底下 39 個目錄，例如 `/private/tmp` 對應 `-private-tmp`）。不要自己算，用 `ls -t` 看哪個目錄剛被更新最準。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| B1 | 用 `YESCHEF_PROJECT_DIR="$HOME/Projects/你的專案"` 啟動，完成一則來回對話（問一句、等它答完）。關掉之後跑 `ls -t ~/.claude/projects \| head -3` 與 `diff /tmp/projects-before.txt <(ls -t ~/.claude/projects)` | 最上面那個目錄是 `$HOME/Projects/你的專案` 的 `/` 換 `-` 版本；該目錄下 `ls -t \| head -1` 是一個剛產生的 `.jsonl` | ✓ / ✗ | |
| B2 | 對 B1 的那個 `.jsonl` 跑 `head -1 檔案 \| jq -r .cwd`，另外跑 `realpath "$HOME/Projects/你的專案"` | 兩者相等 | ✓ / ✗ | |
| B3 | 重新啟動（環境變數維持 B1 的值），在 Recents 點一條屬於**別的專案**的歷史對話，輸入一句話接續它。等它答完之後看該 session 的 `.jsonl` 新增的列 | 新增的列落在那個專案的目錄，`jq -r .cwd` 是那個專案的路徑，不是 `YESCHEF_PROJECT_DIR` | ✓ / ✗ | |
| B3b | 在 Recents 點一條目錄已不存在的歷史對話（找一個 `~/.claude/projects` 底下對應路徑已刪除的目錄，或臨時 `mv` 走一個測試用專案），輸入一句話 | 對話尾端出現 `.error-card`，內容含「projectDir 不存在」；輸入框回到可用；主程序沒有未捕捉的例外（裁決 20） | ✓ / ✗ | |

B1 的輔助指令：找出這一場的檔案並看第一列的關鍵欄位。

```bash
DIR=$(ls -t ~/.claude/projects | head -1)
F=$(ls -t ~/.claude/projects/"$DIR"/*.jsonl | head -1)
echo "$F"
head -1 "$F" | jq '{cwd, sessionId, version, type}'
```

B2 的判準寫「等於 realpath」而不是「等於環境變數的字面值」，是為了讓 A3 的結果在這裡再被看見一次：若 A3 顯示 `cwd` 是原字串，B2 在非 symlink 的一般情況下仍會過（原字串本來就等於 realpath），兩項合起來才看得出問題只在 symlink 這條路徑上。

B3 的依據是裁決 20（`CONTRACT.md` 檔尾）：Task 7 的 `SessionStore.cwdOf()` 記住最近一次 `list()` 每筆的 `cwd`，Task 8 `index.ts` 的 `createSessionOptionsFactory(projectDir, sessions)` 在 resume 時用它取代 `YESCHEF_PROJECT_DIR`。所以新增的列要落在那個專案的目錄。若 B3 ✗，先在主程序 log 看 `start-query` 那一筆帶的 `cwd` 是哪個：是 `YESCHEF_PROJECT_DIR` 代表 `cwdOf` 沒接上（歸屬 Task 8 `index.ts`）；是正確的專案目錄但檔案仍落在別處，代表 CLI 對跨目錄 resume 另有行為，把觀察到的行為寫進現象欄，那是要記下的 SDK 事實。

B3 另外附帶一個負面案例 B3b：在 Recents 點一條目錄已不存在的歷史對話（`ls -t ~/.claude/projects` 裡找一個對應路徑已刪除的目錄，或臨時 `mv` 走一個測試用專案），輸入一句話。預期是對話尾端出現 `.error-card`，內容含 Task 1 守衛的訊息「projectDir 不存在」，輸入框回到可用；不是主程序例外、也不是卡在轉圈。這驗的是裁決 20 第三條：`start()` 組不出 options 時走合成的 `session-end`。表中的 B3b 就是這一項。

---

- [ ] **Step 3: C 組，對話流（6 項）**

從 Task 8 Step 10 區塊 2 搬來的第 1、2 項在這裡，另外四項是規格 §5、§6、§8 有寫但沒有任何 task 的手動清單接住的部分。全部在同一次 `npm run dev` 裡跑完。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| C1 | 在輸入框送出「用三段話說明什麼是 CRDT」 | 文字逐字出現，不是整段跳出來。盯著看得到字一個一個長出來，游標在未完成的段落尾端 | ✓ / ✗ | |
| C2 | 送出「把 1 到 200 每個數字寫成一行，格式是 `n = 平方`」（會產生遠超過 128 個 Event） | 內容完整到 200、順序正確、沒有任何一段出現兩次。用 DevTools 選取整段複製出來，`grep -c "^1 = "` 應該是 1 | ✓ / ✗ | |
| C3 | 承 C2，觀察 DevTools console 與主程序 log | 沒有任何未捕捉的例外；主程序 log 沒有「批次丟棄」「送不出去」之類的訊息 | ✓ / ✗ | |
| C4 | 送出「寫一段 40 行的 TypeScript 範例」，在它還在輸出程式碼區塊的中途按暫停鍵截圖或錄影 | 未閉合的程式碼區塊在串流中途也是完整的程式碼區塊樣式，不會把後面的內容整段吃進去，也不會整則訊息變成純文字（Task 2 的 `closeIncomplete` 在真實資料上的表現） | ✓ / ✗ | |
| C5 | 送出「跑 `ls -la` 然後告訴我有幾個檔案」，批准之後看那個工具呼叫 | 工具呼叫預設摺疊成一行（規格 §6 第 161 行）；點開之後看得到未經處理的 stdout，包含 `total` 那一行與權限字串，不是被整理過的摘要 | ✓ / ✗ | |
| C6 | 整場對話結束後看對話尾端 | 出現一張 cost 卡片，含花費與輪數；沒有出現 `.error-card`；沒有任何一張原始 JSON 的 unknown 卡片。若出現 unknown 卡片，把 `raw` 的內容整段抄進現象欄 | ✓ / ✗ | |

C6 的 unknown 卡片是刻意留成觀察項而不是失敗項。裁決 1 窮舉了五類「認得出來但沒有可渲染內容」的事件，一場正常對話不該產生任何 unknown 卡片。若真的出現，那是 SDK 送來了契約沒列舉的東西，把 `raw` 抄下來就是下一次修正規格的證據，本身不算 bug。

C2 的判準寫成可以用指令檢查的形式（`grep -c`），理由是「內容完整、順序正確、沒有重複段落」肉眼看兩百行看不出來。去重的實作依據是裁決 1 前面那段查證事實：同一份內容會經由 `text_delta` 與完整 `text` 到達兩次，`fold()` 沒去重畫面就會渲染兩遍。C2 就是在驗這件事。

---

- [ ] **Step 4: D 組，批准的四種結局（6 項）**

規格 §8（第 181 行）列了四種結局，Task 6 的單元測試已經在假 IPC 上各驗過一次。這一組驗的是同樣四種結局在真的 Electron 裡有沒有留下**使用者看得到的記錄**，以及主程序有沒有殘留程序。Task 10 的手動清單第 1 到第 4 項已經驗過卡片的位置與鍵盤操作，這裡不重複，只在 D1 引用它。

每一項做完都要跑一次殘留檢查：

```bash
ps aux | grep -c "[c]laude"      # 關掉 yeschef 之後應該回到基準值
ps aux | grep "[c]laude" | head  # 若不是基準值，把整行抄進現象欄
```

基準值先量一次：yeschef 完全沒開的時候跑上面第一行，記下數字。之後每一項比對的是「關掉 yeschef 之後有沒有回到這個數字」，不是「等於 0」，因為使用者自己的終端機可能也開著 claude。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| D1 | 送出「跑 `ls` 看看這個目錄」，等批准卡片出現 | 卡片內嵌在對話流、在該工具呼叫的正下方，不是彈窗；顯示 SDK 給的 `title`，沒有 `title` 才退回工具名加完整 input（裁決 16）；卡片掛在 `toolUseId` 相同的那個工具區塊上，同名同參數的兩個工具各掛各的（裁決 28）；輸入框在卡片出現期間停用。位置與鍵盤操作引用 Task 10 清單第 1 到第 3 項，此處只確認在完整的 app 裡仍然成立 | ✓ / ✗ | |
| D2 | 承 D1 按「允許」 | 卡片消失，工具實際執行，展開後看得到未經處理的 stdout（與 C5 同一條路徑，這裡驗的是「按允許之後才跑」這個順序）；輸入框恢復可用 | ✓ / ✗ | |
| D3 | 再送一次同樣的要求，這次按「拒絕」 | 工具不執行；對話裡留下可見的拒絕記錄，不是靜默略過；該工具區塊顯示拒絕理由（裁決 12 的 `deniedReason`），不是把理由塞在結果欄位裡假裝工具跑完了；輸入框恢復可用 | ✓ / ✗ | |
| D4 | 再送一次，卡片出現後放著不動，計時到 30 秒以上 | 逾時後自動拒絕；卡片從畫面消失，不留一張按了沒反應的卡片；該工具區塊顯示含「逾時」與毫秒數的拒絕理由（Task 6 的理由字串，經裁決 28 的 id 比對掛回區塊）；輸入框解鎖；主程序 log 有對應記錄 | ✓ / ✗ | |
| D5 | 再送一次，卡片還開著的時候直接關掉視窗 | 主程序在數秒內結束；`ps aux \| grep -c "[c]laude"` 回到基準值；主程序 log 依序出現 `denyAll(視窗已關閉)`、`interrupt`、`teardown` 三步（規格 §3.2 定的收尾順序） | ✓ / ✗ | |
| D6 | 再送一次，卡片還開著的時候點 Recents 裡另一條歷史對話 | 卡片消失；對話區只剩那條歷史對話的內容，剛才 live 那一場的 turn 一個都不在（裁決 22 的 `reset`）；主程序 log 出現 `denyAll(切換 session)` 之後才有 `teardown`，順序不可顛倒；沒有掛著不會結束的 promise | ✓ / ✗ | |

D4 的 30 秒要真的等。若嫌久，先確認 `createApprovalRegistry` 的 `timeoutMs` 沒有被呼叫端覆寫成別的值（Task 6 Step 3 `createApprovalRegistry` 的預設是 `30_000`），確認之後再等。不要為了跑快改成 3 秒然後宣稱驗過，那樣驗到的是測試環境不是產品。

D5 與 D6 的重點都在 log 的**順序**。三步收尾做成 effects 陣列的唯一理由就是讓順序集中在一處且可測（裁決 6）。若 log 顯示 `teardown` 先於 `denyAll`，代表 effects 的執行不是照陣列順序跑，那是必須修的問題，即使畫面上看起來一切正常。

---

- [ ] **Step 5: E 組，Recents 與 session 切換（8 項）**

Task 8 Step 10 區塊 2 的第 6 到第 10 項在這裡。Task 11 的手動清單前三項在 Task 11 完成當下已經驗過一次，本組在 E1、E2、E6 重跑它們，理由是那時候 Task 11 是最後一個 renderer task、批准與錯誤卡片的互動還沒接上，重跑一次確認裝在一起之後沒有壞。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| E1 | 啟動後直接看側邊欄（Task 11 清單第 1 項在此重跑一次） | 列出最近 100 筆，跨全部專案（看得到不屬於 `YESCHEF_PROJECT_DIR` 的對話），最新的在最上面，相對時間顯示正常 | ✓ / ✗ | |
| E2 | 點第二列的歷史對話（Task 11 清單第 3 項在此重跑一次） | 該筆高亮；對話區重播出歷史內容，且只有這一場的內容（裁決 22）；輸入框提示變成「輸入以接續這條對話」；歷史裡的工具呼叫展開後顯示裁決 4 的文案（歷史對話沒有保存原始輸出），不是空的展開區塊 | ✓ / ✗ | |
| E3 | 承 E2，在 viewing 狀態下輸入一句話送出 | 進入 live 並接續該 session；新的回答接在歷史內容後面，不是清空重來（裁決 22：resume 不推 `reset`）；主程序 log 顯示 `start-query` 帶著 `resume` | ✓ / ✗ | |
| E4 | 重新點一條歷史對話進 viewing，然後按「開新對話」 | 畫面清空，輸入框回到全新對話的提示（不是「輸入以接續這條對話」）；Recents 的選取取消；這是裁決 6 補上的缺口，在裁決 6 之前 renderer 根本送不出這個意圖 | ✓ / ✗ | |
| E5 | 開一場新對話，問一句，等它完全答完，看側邊欄 | Recents 的選取回到未選中；DevTools console 裡 `session:state` 最後收到的是 `kind: 'idle'`；對話內容（含最後一段回答）留在畫面上，不因狀態變 `idle` 而清空（裁決 22） | ✓ / ✗ | |
| E6 | 承 E5，重新載入或等清單刷新（Task 11 清單第 2 項在此重跑一次） | 剛才那一場出現在清單第一列 | ✓ / ✗ | |
| E7 | 啟動後先看標題列；點一條屬於別的專案的歷史對話；再按「開新對話」 | 啟動時標題列是 `YESCHEF_PROJECT_DIR` 的值；點歷史對話後換成那個專案的 `cwd`；按「開新對話」後換回 `YESCHEF_PROJECT_DIR`（裁決 21）。歷史對話沒有 `cwd` 欄位時顯示「目錄不明」 | ✓ / ✗ | |
| E8 | 在一秒內連點兩條不同的歷史對話（先 A 再 B） | 畫面最終是 B 的內容，沒有 A 的殘留；高亮與標題列都對應 B；主程序 log 裡兩次 `loadHistory` 依點擊順序各自完成後才推狀態，最後一次 `session:state` 是 `viewing` 且 `sessionId` 是 B（裁決 23） | ✓ / ✗ | |

E7 的依據是裁決 21：標題列的值在 renderer 算出來，idle 或全新 live 用 `window.yeschef.projectDir`（preload 從 `process.argv` 的 `--yeschef-project-dir=` 取），有 `current` 時用 Recents 清單裡該筆的 `cwd`。若啟動時標題列是空字串，先在 DevTools console 看 `window.yeschef.projectDir`：空字串代表沙箱 preload 拿不到 `additionalArguments`，那是裁決 21 末段預先寫好的退路（改成一條 `invoke` 頻道），記進待辦歸屬 Task 8 加 Task 11，不在本 task 修。

E5 的 `session:state` 怎麼看：在 DevTools console 執行下面這段，然後再跑一次對話。

```js
window.yeschef.onSessionState((s) => console.log('[state]', JSON.stringify(s)))
```

---

- [ ] **Step 6: F 組，錯誤卡片（3 項）**

裁決 17 把規格 §8 的兩列（SDK query 中途錯誤、事件流中斷）合成同一張 `.error-card`。這一組驗的是「錯誤有沒有變成畫面上的東西」，因為上一個分支的教訓正是錯誤只進 console。`.error-card` 的實作在 Task 9B Step 3e 的 `Conversation.tsx`。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| F1 | `ANTHROPIC_API_KEY=sk-ant-invalid-000 YESCHEF_PROJECT_DIR=... npm run dev`，送出一則訊息 | 對話尾端出現 `.error-card`，內容含「對話因錯誤結束」與具體的錯誤訊息（不是空白的一張卡）；若 SDK 有給 `api_error_status`，卡片上也看得到 | ✓ / ✗ | |
| F2 | 承 F1，看輸入框與側邊欄 | 輸入框回到可用（不是永遠停用也不是永遠轉圈）；狀態回到 `idle` 之後 `.error-card` 仍留在畫面上，不被清掉（裁決 22）；可以再送下一則訊息而不需要重開 app | ✓ / ✗ | |
| F3 | 正常啟動，送出一則會跑很久的訊息，在串流中途把網路關掉（關 Wi-Fi 或 `sudo ifconfig en0 down`） | 事件流中斷之後對話尾端一樣出現 `.error-card`，不是畫面停住看起來像還在想；主程序 log 有對應的錯誤記錄；沒有殘留的 claude 程序 | ✓ / ✗ | |

F1 的判準第一句是「不是 console 裡的一行紅字」。檢查方式：先把 DevTools 關掉再做一次，只看畫面。如果只看畫面看不出剛才出了錯，這一項是 ✗，不管 console 裡寫得多清楚。

F3 驗的是裁決 17 的第 3 點：`for await` 迭代器 throw 時，agent-host 把錯誤轉成一筆合成的 `{ kind: 'session-end', isError: true, errorMessage }` 走同一條 events 通道。若 F3 是畫面停住而 console 有錯，代表那個合成事件沒送出去或送出去了但 `fold()` 沒設 `view.error`，兩者都要看 DevTools 裡收到的最後幾筆 event 才分得出來：

```js
window.yeschef.onEvents((evts) => console.log('[events]', evts.map((e) => e.kind).join(',')))
```

F3 做完記得把網路開回來。

---

- [ ] **Step 7: G 組，記憶體重量（3 項）**

規格 §10（第 206 行）把「Spike 1 的記憶體量測」列為待重量：xterm.js 換成 React 加 `react-markdown` 加 `rehype-highlight`，數字一定會變。規格 §2.3 也記了使用者的決定：記憶體先不設限，做完再量，原本的 +150 MB 暫停適用。所以這一組要的是數字本身，判準欄寫「參考」不寫「通過／未通過」。

步驟完全照 `docs/RESULTS-01-memory.md` 的「量測步驟」跑，不重寫。差別只有一處：Spike 1 的 yeschef 量測步驟第 4 步是「在左格執行 claude 並送出問題」，現在左格沒有終端機，改成「在左格的輸入框送出一個會產生長輸出的問題，等它答完」。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| G1 | 基準線量測：開 iTerm2 跑 `claude`，另開 chrome-devtools-mcp 的 Chrome 導到與 Spike 1 相同的 URL，等 60 秒，`npm run spike:memory` | 「基準線 iTerm2」與「基準線 chrome-devtools-mcp 的 Chrome」兩列都非 0 MB 且程序數 > 1 | ✓ / ✗ | |
| G2 | yeschef 量測：關掉前面兩個，`YESCHEF_PROJECT_DIR=... npm run start` 開起來，右格導到同一個 URL，左格送出一個長問題並等它答完，等 60 秒，`npm run spike:memory` | 「claude CLI」與「yeschef」兩列都非 0 MB 且程序數 > 1 | ✓ / ✗ | |
| G3 | 把四組數字填進 `RESULTS-04` 的表，並與 `docs/RESULTS-01-memory.md` 的同名列並排 | 兩份表格的列名一致，看得出哪一列變大、變多少 | ✓ / ✗ | |

G1、G2 的健全性檢查是 0 MB 就無效，這一點照抄 Spike 1 不打折。`GROUPS` 的比對字串在 `spikes/measure-memory.ts` 第 10 到 16 行：

- `yeschef` 這一組是 `mode: 'substr'`，比對 `yeschef` 與 `electron-vite` 兩個字串。用 `npm run start`（`electron-vite preview`）啟動時命令列裡還有沒有 `electron-vite` 這個字要實際看一眼，`ps -Ao rss,comm,command | grep -i yeschef | head` 就知道。若 yeschef 那列是 0 MB，先改 `GROUPS` 再量，不要拿 0 去填表。
- 改 `GROUPS` 屬於本 task 允許的修正（`spikes/measure-memory.ts` 已在 `vitest.config.ts` 的 coverage include 裡，`filterHits` 有既有測試），但要在 `RESULTS-04` 記下改了哪一行與為什麼。

G2 的表格照 `RESULTS-01` 的八列填：基準線 iTerm2、基準線 Chrome、基準線合計、yeschef 全部程序、其中 electron-vite、claude CLI、淨變化（含 dev 工具）、淨變化（扣除 electron-vite）。`npm run start` 是 `electron-vite preview`，不是打包後的產物，所以 electron-vite 那一列可能仍有值，照實填。

---

- [ ] **Step 8: H 組，收尾檢查（5 項）**

前面七組驗的是行為，這一組驗的是「上一個時代的東西有沒有真的清掉」與「交付門檻有沒有守住」。全部是指令，貼原始輸出進報告，不要只寫「都過了」。

| # | 指令 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| H1 | `grep -rn "pty:\|node-pty\|xterm" src/ tests/ spikes/ package.json electron.vite.config.ts` | 無命中（規格 §10 把 `pty-host.ts`、`terminal.ts`、PTY 橋接全列為作廢） | ✓ / ✗ | |
| H2 | `grep -rn "session:open\|openSession\|SessionStateName\|parseSessionOpen" src/ tests/` | 無命中（裁決 14 作廢了 `openSession` 與 `session:open` 頻道） | ✓ / ✗ | |
| H3 | `npm test` | 全綠。把總測試數記進報告，與各 task 報告的數字相加對照 | ✓ / ✗ | |
| H4 | `npm run typecheck` | 0 error | ✓ / ✗ | |
| H5 | `find src -name '*.ts' -o -name '*.tsx' \| xargs wc -l \| sort -rn \| head -20` | 每一支 800 行以內。把前 20 名整段貼進報告 | ✓ / ✗ | |

H1 的 grep 範圍刻意包含 `package.json`：Task 0 從相依裡移除了 `node-pty`、`@xterm/xterm`、`@xterm/addon-fit`、`@electron/rebuild` 與 `allowScripts` 的 `node-pty@1.1.0`，若 `allowScripts` 那一行還在，`npm uninstall` 不會動它，這裡才抓得到。命中 `docs/` 底下的舊文件不算失敗，那些是歷史紀錄，所以 grep 不掃 `docs/`。

H5 若有檔案超過 800 行，記進待辦並標出是哪一支、超出多少。本 task 不做拆檔，拆檔是會動介面的改動。

補一項覆蓋率的抽查（不列入八組計數）：`npm run test:coverage`，確認 `src/main/agent-host.ts`、`src/main/ipc-bridge.ts`、`src/shared/fold.ts` 三支的行覆蓋率各自 ≥ 80%。這三支是事件路徑上最長的三段，若覆蓋率掉下來，代表某個 task 的測試在合併之後失效了。

---

- [ ] **Step 9: 缺陷分流**

八組跑完會得到一份 ✗ 清單。每一筆用同一組判準決定去向，判準先寫死，不在看到缺陷之後才決定要不要修，那樣會變成「簡單的都修、難的都記待辦」。

**在本 task 直接修的條件，三條全部成立才算：**

1. 修改的程式碼在 20 行以內（用 `git diff --stat` 的數字，不含測試與註解）。
2. 不改任何介面：`CONTRACT.md` 裡列出的型別、`YesChefApi` 的簽章、IPC 頻道名、任何 export 的函式簽章都不動。
3. 有一條會因這個修正從紅變綠的單元測試。測試照 Global Constraints 做突變驗證：把修正換回錯誤版本、確認測試變紅、還原確認回綠，兩次輸出貼進 `RESULTS-04`。

三條有任何一條不成立，記進 `RESULTS-04` 的「待辦」一節，格式固定三欄：

| 現象 | 推測原因 | 建議歸屬的 task |
|---|---|---|

「現象」寫看到的東西，不寫判斷（寫「B3 的 `.jsonl` 落在 `YESCHEF_PROJECT_DIR` 的目錄，`cwd` 是 `/Users/x/Projects/yeschef`」，不寫「resume 的 cwd 傳錯了」）。「推測原因」才寫判斷，而且要標明是推測。「建議歸屬」寫 task 編號加一句理由。

依 Step 1 到 Step 8 的內容，以下兩筆若 ✗ 的去向在跑之前就定好，省得重新推一次：

- B3 的跨專案 resume cwd（裁決 20）：若 log 顯示 `start-query` 帶的 cwd 是 `YESCHEF_PROJECT_DIR`，問題在 `index.ts` 的 `createSessionOptionsFactory` 沒用 `cwdOf`，通常在 20 行內且不動介面，本 task 直接修並補 `tests/session-store.test.ts` 或 `tests/session-args.test.ts` 的測試；若 cwd 正確而檔案仍落在別處，記待辦，那是 SDK 行為，不是本專案的程式碼。
- E7 的標題列（裁決 21）：若 `window.yeschef.projectDir` 是空字串，記待辦歸屬 Task 8 加 Task 11，改法裁決 21 已寫。若 `projectDir` 正確但標題列沒跟著 `current` 換，問題在 Task 11 的 `titleFor`，20 行內、不動介面，本 task 直接修。

---

- [ ] **Step 10: 產出 `docs/RESULTS-04-a-sdk-host.md`**

體例照 `docs/RESULTS-01-memory.md`：表頭四行、每個區塊先寫量測步驟再寫結果表、判準單獨一節。範本如下，八組的表格直接把 Step 1 到 Step 8 的表整份搬過去（含「結果」與「現象」兩欄），不要改寫成散文。

```markdown
# Plan A 整合驗收結果

量測日期：
機器：
Node / Electron / SDK 版本：
量測方法：`YESCHEF_PROJECT_DIR=... npm run dev`，逐項人工操作，結果與現象即時記錄

## A. 啟動與守門
### 檢查步驟
### 結果表

## B. Insights 歸屬
## C. 對話流
## D. 批准的四種結局
## E. Recents 與 session 切換
## F. 錯誤卡片
## G. 記憶體
（表格照 RESULTS-01 的八列，並附 Spike 1 的同名數字做對照）

| 組別 | Spike 1 | 本次 | 變化 |
|---|---|---|---|

## H. 收尾檢查
（每一項貼原始輸出）

## 本 task 做掉的修正
| 檔案 | 改了幾行 | 為什麼 | 對應的測試 | 突變驗證 |
|---|---|---|---|---|

## 待辦
| 現象 | 推測原因 | 建議歸屬的 task |
|---|---|---|

## 判準
- A 到 F、H 兩組：全部 ✓ 才算通過。任何一項 ✗ 且未在本 task 修掉，必須出現在待辦
- G 組：只記數字與健全性檢查，不設通過門檻（規格 §2.3：記憶體先不設限）
- 三十九項的完成度：___ / 39
```

`RESULTS-02-input-focus.md` 與 `RESULTS-03-oopif.md` 已經佔掉 02 與 03 的編號，本檔用 04，檔名 `RESULTS-04-a-sdk-host.md`。

---

- [ ] **Step 11: 提交**

```bash
git add docs/RESULTS-04-a-sdk-host.md
# 若 Step 9 做了修正，把改到的檔案與對應的測試一起加進來，例如：
# git add src/main/session-args.ts tests/session-args.test.ts spikes/measure-memory.ts
git status   # 確認沒有夾帶 out/、.spike-out/ 或量測用的暫存檔
git commit -m "docs: Plan A 整合驗收結果"
```

提交訊息固定是這一句。若 Step 9 做了修正，修正與報告放同一個提交：報告裡的「本 task 做掉的修正」那一節就是這個提交的說明，拆成兩個提交反而讓兩邊都看不完整。

---

## 撰寫本清單時對照出的三件事（已處理）

這三筆是撰寫本清單時對照契約與各 task 產出發現的，寫在這裡讓執行者知道來歷，不需要再查一次。

**一、`buildSessionOptions` 的回傳 `cwd` 沒有經過 realpath。** 查證後不需要改：CLI 讀的是 `process.cwd()`，macOS 的 `getcwd(3)` 回傳實體路徑，逐字稿的位置與 `cwd` 欄位都會是 realpath。A3 改成驗這個事實。

**二、跨專案 resume 沒有帶回原本的 cwd。** 已成裁決 20，由 Task 7 的 `cwdOf` 與 Task 8 的 `createSessionOptionsFactory(projectDir, sessions)` 補上；組不出 options 時走合成的 `session-end`。B3 與 B3b 驗它。

**三、規格 §3.2 的標題列沒有任何 task 產出。** 已成裁決 21，由 Task 8 的 `YesChefApi.projectDir` 與 Task 11 的 `<header className="title-bar">` 補上。E7 驗它。

另註：Task 1／Task 8 的程式碼註解把 `YESCHEF_PROJECT_DIR` 靜默失敗的理由標成「規格 §2.1」，實際內容在 §3.2；本檔引用時用 §3.2。
