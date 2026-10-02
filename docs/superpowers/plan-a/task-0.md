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
