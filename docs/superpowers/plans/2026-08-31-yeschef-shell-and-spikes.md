# yeschef 外殼與三個 spike 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出 yeschef 的最小可用外殼（左窗格跑真的 `claude` CLI、右窗格是可被 CDP 驅動的獨立瀏覽器），並用三個量測回答規格第 8 節的三個 spike，產出閘門判斷所需的數據。

**Architecture:** 單一 Electron 應用。主程序建立一個 `BaseWindow`，掛兩個子 view：左邊是 renderer（xterm.js）透過 IPC 與主程序的 PTY 子程序通訊，PTY 裡跑真的 `claude` 二進位檔；右邊是 `WebContentsView`，用獨立 `persist:agent` partition，透過 `webContents.debugger` 取得 CDP。純邏輯（啟動參數組裝、佈局計算、CDP 封裝）走 TDD，Electron 整合層用手動檢查清單與量測腳本驗證。

**Tech Stack:** Electron（穩定版，最低 30，需 `WebContentsView`）、TypeScript、Vite（electron-vite）、Vitest、xterm.js、node-pty

**Spec:** `docs/specs/2026-08-31-yeschef-design.md`

## Global Constraints

以下為專案層級要求，每個 task 的驗收隱含包含本節。數值直接引自規格。

- 平台只做 macOS。不處理 Windows 與 Linux 建置。
- 右窗格必須用 `WebContentsView`。**不可**使用 `<webview>` 標籤或 `BrowserView`（後者自 Electron 30 起 deprecated）。
- 右窗格 partition 必須是 `persist:agent`，且**不給 preload**。內容由主程序主動取。
- 生 `claude` 子程序時 cwd 必須是使用者實際工作的專案目錄，**不可**用 app 自身目錄。原因：`~/.claude/usage-data/ingest-jsonl.mjs` 的排除規則同時作用在 session cwd 與碰到的檔案路徑，超過 50% 落在 `EXCLUDE_PATHS` 就整場不計入評量。
- 傳 MCP 設定用 `claude --mcp-config <json>`。**不可**加 `--strict-mcp-config`，那會關掉使用者既有的 per-project MCP 設定。
- 記憶體淨增加相對基準線（iTerm2 313 MB 加 chrome-devtools-mcp 開的 Chrome）不得超過 +150 MB。
- 資料不可變：函式回傳新物件，不修改參數。
- 單一檔案典型 200 到 400 行，上限 800 行。
- 測試覆蓋率 80% 以上（僅計可單元測試的純邏輯模組，Electron 整合層不計入）。

## 檔案結構

```
yeschef/
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
├── vitest.config.ts
├── src/
│   ├── main/
│   │   ├── index.ts              app 進入點、視窗與兩個 view 的組裝
│   │   ├── layout.ts             左右窗格幾何計算（純函式）
│   │   ├── spawn-args.ts         claude 啟動參數組裝（純函式）
│   │   ├── pty-host.ts           node-pty 子程序生命週期與 IPC 橋接
│   │   ├── agent-view.ts         WebContentsView 建立與 partition 設定
│   │   └── cdp.ts                webContents.debugger 附著與指令封裝
│   ├── renderer/
│   │   ├── index.html
│   │   ├── terminal.ts           xterm.js 掛載與 IPC 綁定
│   │   └── terminal.css
│   └── shared/
│       └── ipc.ts                IPC 頻道名稱與訊息型別（主程序與 renderer 共用）
├── spikes/
│   ├── measure-memory.ts
│   ├── probe-input-focus.ts
│   └── probe-oopif.ts
├── tests/
│   ├── fixtures/click-counter.html
│   ├── spawn-args.test.ts
│   ├── layout.test.ts
│   └── cdp.test.ts
└── docs/
    ├── specs/2026-08-31-yeschef-design.md
    ├── superpowers/plans/2026-08-31-yeschef-shell-and-spikes.md
    └── RESULTS-01-memory.md   （Task 5 產出）
        RESULTS-02-input-focus.md （Task 7 產出）
        RESULTS-03-oopif.md    （Task 8 產出）
```

責任切分理由：`spawn-args.ts` 與 `layout.ts` 是純函式且是最容易寫錯又最容易測的部分，獨立成檔。`pty-host.ts` 與 `agent-view.ts` 各自封裝一個 Electron 資源的生命週期。`cdp.ts` 獨立是因為後續第二份計畫的 9 個 MCP 工具全部建在它上面。

---

### Task 1: claude 啟動參數組裝

這個 task 同時建立專案骨架與測試管線，因為它的產出需要它們。

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/main/spawn-args.ts`
- Test: `tests/spawn-args.test.ts`

**Interfaces:**
- Consumes: 無
- Produces:
  - `interface SpawnArgsInput { readonly projectDir: string; readonly mcpServerCommand: string; readonly mcpServerArgs: readonly string[] }`
  - `interface SpawnArgs { readonly command: string; readonly args: readonly string[]; readonly cwd: string }`
  - `function buildSpawnArgs(input: SpawnArgsInput): SpawnArgs`

- [ ] **Step 1: 建立專案骨架**

```bash
cd ~/Projects/yeschef
npm init -y
npm i -D typescript vitest @types/node
npx tsc --init
```

寫 `package.json` 的 scripts 區段（保留 npm init 產生的其他欄位）：

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

寫 `vitest.config.ts`：

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: { include: ['src/main/spawn-args.ts', 'src/main/layout.ts', 'src/main/cdp.ts'] },
  },
})
```

寫 `tsconfig.json`（覆蓋 tsc --init 的產出）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "spikes"]
}
```

- [ ] **Step 2: 寫失敗的測試**

`tests/spawn-args.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { buildSpawnArgs } from '../src/main/spawn-args.js'

const base = {
  projectDir: '/Users/me/Projects/some-repo',
  mcpServerCommand: 'node',
  mcpServerArgs: ['/Users/me/Projects/yeschef/dist/mcp.js'],
}

describe('buildSpawnArgs', () => {
  it('cwd 是使用者的專案目錄，不是 app 目錄', () => {
    expect(buildSpawnArgs(base).cwd).toBe('/Users/me/Projects/some-repo')
  })

  it('生的是 claude', () => {
    expect(buildSpawnArgs(base).command).toBe('claude')
  })

  it('帶 --mcp-config', () => {
    expect(buildSpawnArgs(base).args).toContain('--mcp-config')
  })

  it('絕對不帶 --strict-mcp-config，那會關掉使用者既有的 MCP 設定', () => {
    expect(buildSpawnArgs(base).args).not.toContain('--strict-mcp-config')
  })

  it('--mcp-config 後面接的是合法 JSON，且註冊名為 yeschef 的 stdio server', () => {
    const args = buildSpawnArgs(base).args
    const idx = args.indexOf('--mcp-config')
    const parsed = JSON.parse(args[idx + 1]!)
    expect(parsed.mcpServers.yeschef).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/Users/me/Projects/yeschef/dist/mcp.js'],
    })
  })

  it('不修改傳入的物件', () => {
    const input = { ...base, mcpServerArgs: ['a'] }
    const snapshot = JSON.stringify(input)
    buildSpawnArgs(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('projectDir 是相對路徑時丟錯', () => {
    expect(() => buildSpawnArgs({ ...base, projectDir: './relative' })).toThrow(
      'projectDir 必須是絕對路徑'
    )
  })

  it('projectDir 是空字串時丟錯', () => {
    expect(() => buildSpawnArgs({ ...base, projectDir: '' })).toThrow(
      'projectDir 必須是絕對路徑'
    )
  })
})
```

- [ ] **Step 3: 執行測試，確認失敗**

Run: `npm test`
Expected: FAIL，訊息類似 `Failed to resolve import "../src/main/spawn-args.js"`

- [ ] **Step 4: 寫最小實作**

`src/main/spawn-args.ts`：

```typescript
export interface SpawnArgsInput {
  /** 使用者實際工作的專案目錄。決定 Insights 的歸屬，必須是絕對路徑。 */
  readonly projectDir: string
  /** 本 app 的 MCP server 啟動指令 */
  readonly mcpServerCommand: string
  /** 本 app 的 MCP server 啟動參數 */
  readonly mcpServerArgs: readonly string[]
}

export interface SpawnArgs {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

/**
 * 組出 claude 子程序的啟動參數。
 *
 * 兩個不可協商的約束：
 * 1. cwd 必須是使用者的專案目錄，否則 Insights 的歸屬會跑掉。
 * 2. 不可帶 --strict-mcp-config，否則使用者既有的 per-project MCP 設定會被關掉。
 */
export function buildSpawnArgs(input: SpawnArgsInput): SpawnArgs {
  if (!input.projectDir.startsWith('/')) {
    throw new Error('projectDir 必須是絕對路徑')
  }

  const mcpConfig = {
    mcpServers: {
      yeschef: {
        type: 'stdio',
        command: input.mcpServerCommand,
        args: [...input.mcpServerArgs],
      },
    },
  }

  return {
    command: 'claude',
    args: ['--mcp-config', JSON.stringify(mcpConfig)],
    cwd: input.projectDir,
  }
}
```

- [ ] **Step 5: 執行測試，確認通過**

Run: `npm test`
Expected: PASS，8 個測試全綠

- [ ] **Step 6: 提交**

```bash
git add package.json tsconfig.json vitest.config.ts src/main/spawn-args.ts tests/spawn-args.test.ts
git commit -m "feat: claude 啟動參數組裝，鎖住 cwd 與 mcp-config 兩個約束"
```

---

### Task 2: 左右窗格幾何計算

**Files:**
- Create: `src/main/layout.ts`
- Test: `tests/layout.test.ts`

**Interfaces:**
- Consumes: 無
- Produces:
  - `interface Bounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }`
  - `interface Size { readonly width: number; readonly height: number }`
  - `function splitBounds(container: Size, ratio: number): { readonly left: Bounds; readonly right: Bounds }`
  - `const MIN_RATIO = 0.2`, `const MAX_RATIO = 0.8`

- [ ] **Step 1: 寫失敗的測試**

`tests/layout.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { splitBounds, MIN_RATIO, MAX_RATIO } from '../src/main/layout.js'

describe('splitBounds', () => {
  it('ratio 0.5 時對半分', () => {
    const { left, right } = splitBounds({ width: 1600, height: 900 }, 0.5)
    expect(left).toEqual({ x: 0, y: 0, width: 800, height: 900 })
    expect(right).toEqual({ x: 800, y: 0, width: 800, height: 900 })
  })

  it('容器寬度是奇數時，兩格不重疊也不留縫', () => {
    const { left, right } = splitBounds({ width: 1601, height: 900 }, 0.5)
    expect(right.x).toBe(left.width)
    expect(left.width + right.width).toBe(1601)
  })

  it('ratio 低於下限時夾到下限', () => {
    const { left } = splitBounds({ width: 1000, height: 600 }, 0.05)
    expect(left.width).toBe(Math.round(1000 * MIN_RATIO))
  })

  it('ratio 高於上限時夾到上限', () => {
    const { left } = splitBounds({ width: 1000, height: 600 }, 0.99)
    expect(left.width).toBe(Math.round(1000 * MAX_RATIO))
  })

  it('兩格高度都等於容器高度', () => {
    const { left, right } = splitBounds({ width: 1200, height: 777 }, 0.4)
    expect(left.height).toBe(777)
    expect(right.height).toBe(777)
  })

  it('不修改傳入的物件', () => {
    const container = { width: 1000, height: 600 }
    const snapshot = JSON.stringify(container)
    splitBounds(container, 0.5)
    expect(JSON.stringify(container)).toBe(snapshot)
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/layout.test.ts`
Expected: FAIL，無法解析 `../src/main/layout.js`

- [ ] **Step 3: 寫最小實作**

`src/main/layout.ts`：

```typescript
export interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

/** 左窗格最少佔 20%，最多佔 80%。避免拖到看不見。 */
export const MIN_RATIO = 0.2
export const MAX_RATIO = 0.8

/**
 * 把容器切成左右兩格。
 *
 * 右格寬度用減法算而非乘法，確保奇數寬度時兩格加起來剛好等於容器，
 * 不會出現 1px 的縫或重疊。
 */
export function splitBounds(
  container: Size,
  ratio: number
): { readonly left: Bounds; readonly right: Bounds } {
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
  const leftWidth = Math.round(container.width * clamped)

  return {
    left: { x: 0, y: 0, width: leftWidth, height: container.height },
    right: {
      x: leftWidth,
      y: 0,
      width: container.width - leftWidth,
      height: container.height,
    },
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test`
Expected: PASS，14 個測試全綠（Task 1 的 8 個加本 task 的 6 個）

- [ ] **Step 5: 提交**

```bash
git add src/main/layout.ts tests/layout.test.ts
git commit -m "feat: 左右窗格幾何計算，奇數寬度不留縫"
```

---

### Task 3: Electron 外殼與右窗格

**Files:**
- Create: `electron.vite.config.ts`
- Create: `src/main/agent-view.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/terminal.ts`
- Create: `src/renderer/index.html`
- Modify: `package.json`（加 electron 相依與 dev/build script）

**Interfaces:**
- Consumes: `splitBounds`, `Bounds`, `Size` from `src/main/layout.ts`
- Produces:
  - `function createAgentView(): WebContentsView`
  - `src/main/index.ts` 匯出 `createWindow(): BaseWindow`（供 spike 腳本重用）

- [ ] **Step 1: 安裝相依**

```bash
cd ~/Projects/yeschef
npm i -D electron electron-vite vite
```

- [ ] **Step 2: 寫 electron-vite 設定**

`electron.vite.config.ts`：

```typescript
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { rollupOptions: { input: 'src/main/index.ts' } } },
  preload: { build: { rollupOptions: { input: 'src/preload/terminal.ts' } } },
  renderer: { root: 'src/renderer', build: { rollupOptions: { input: 'src/renderer/index.html' } } },
})
```

`package.json` 的 scripts 加入：

```json
{
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview"
  }
}
```

- [ ] **Step 3: 寫右窗格**

`src/main/agent-view.ts`：

```typescript
import { WebContentsView } from 'electron'

/** 右窗格用的 partition。與使用者的 Chrome 及本 app 的 default session 都不共用。 */
export const AGENT_PARTITION = 'persist:agent'

/**
 * 建立 agent 用的瀏覽器 view。
 *
 * 不給 preload：這個 view 會載入任意網站，任何注入的橋接都是攻擊面。
 * 內容一律由主程序透過 CDP 主動取，不由頁面主動推。
 */
export function createAgentView(): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      partition: AGENT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })
}
```

- [ ] **Step 4: 寫主程序與最小 renderer**

`src/main/index.ts`：

```typescript
import { app, BaseWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import { splitBounds } from './layout.js'
import { createAgentView } from './agent-view.js'

const DEFAULT_RATIO = 0.5

export function createWindow(): BaseWindow {
  const win = new BaseWindow({ width: 1600, height: 900, titleBarStyle: 'hiddenInset' })

  const terminalView = new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/terminal.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const agentView = createAgentView()

  win.contentView.addChildView(terminalView)
  win.contentView.addChildView(agentView)

  const applyLayout = (): void => {
    const [width, height] = win.getContentSize()
    const { left, right } = splitBounds({ width, height }, DEFAULT_RATIO)
    terminalView.setBounds(left)
    agentView.setBounds(right)
  }

  applyLayout()
  win.on('resize', applyLayout)

  void terminalView.webContents.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  void agentView.webContents.loadURL('https://example.com')

  return win
}

void app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
```

`src/preload/terminal.ts`（本 task 先留空橋接，Task 4 才填內容）：

```typescript
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('yeschef', {})
```

`src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>yeschef</title>
    <style>
      html, body { margin: 0; height: 100%; background: #12140f; color: #d8dcd4; }
      #placeholder { font: 13px ui-monospace, monospace; padding: 16px; }
    </style>
  </head>
  <body>
    <div id="placeholder">左窗格待接 PTY（Task 4）</div>
  </body>
</html>
```

- [ ] **Step 5: 手動驗證，逐項打勾**

Run: `npm run dev`

Electron 整合層沒有合適的單元測試方式，改用固定檢查清單。逐項確認：

1. 視窗開啟，左右兩格各佔一半，中間沒有縫也沒有重疊
2. 拉動視窗大小，兩格跟著變，比例維持 0.5
3. 右格顯示 example.com 的內容
4. **在右格直接用滑鼠點連結，頁面會導航。**這證明人可以直接操作 agent 的瀏覽器
5. partition 隔離：在右格導到 `https://example.com`，開 DevTools（`agentView.webContents.openDevTools()` 暫時加一行）在 Console 執行 `document.cookie = "probe=1"`。關掉 app 重開，確認你日常的 Chrome 裡沒有這個 cookie，而右格重開後有。驗完把那行 `openDevTools` 刪掉

- [ ] **Step 6: 提交**

```bash
git add electron.vite.config.ts src/main/index.ts src/main/agent-view.ts src/preload/terminal.ts src/renderer/index.html package.json package-lock.json
git commit -m "feat: Electron 外殼與獨立 partition 的右窗格"
```

---

### Task 4: 左窗格接 PTY 跑真的 claude

**Files:**
- Create: `src/shared/ipc.ts`
- Create: `src/main/pty-host.ts`
- Create: `src/renderer/terminal.ts`
- Create: `src/renderer/terminal.css`
- Modify: `src/preload/terminal.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/index.html`

**Interfaces:**
- Consumes: `buildSpawnArgs`, `SpawnArgsInput` from `src/main/spawn-args.ts`
- Produces:
  - `const IPC` 頻道常數物件
  - `interface PtyHost { write(data: string): void; resize(cols: number, rows: number): void; dispose(): void }`
  - `function createPtyHost(opts: { input: SpawnArgsInput; cols: number; rows: number; onData(d: string): void; onExit(code: number): void }): PtyHost`

- [ ] **Step 1: 安裝相依並為 Electron 重建原生模組**

```bash
npm i node-pty @xterm/xterm @xterm/addon-fit
npm i -D @electron/rebuild
npx electron-rebuild -f -w node-pty
```

`node-pty` 是原生模組，用 npm 裝的版本是為 Node 的 ABI 編的，直接在 Electron 裡 require 會拋 `NODE_MODULE_VERSION` 不符。上面第三行是必要步驟，不是選配。每次升級 Electron 都要重跑一次。

- [ ] **Step 2: 定義 IPC 契約**

`src/shared/ipc.ts`：

```typescript
export const IPC = {
  /** main → renderer：PTY 的輸出 */
  ptyData: 'pty:data',
  /** renderer → main：使用者的鍵盤輸入 */
  ptyInput: 'pty:input',
  /** renderer → main：終端機尺寸改變 */
  ptyResize: 'pty:resize',
  /** main → renderer：claude 子程序結束 */
  ptyExit: 'pty:exit',
} as const

export interface ResizePayload {
  readonly cols: number
  readonly rows: number
}
```

- [ ] **Step 3: 寫 PTY host**

`src/main/pty-host.ts`：

```typescript
import { spawn } from 'node-pty'
import { buildSpawnArgs, type SpawnArgsInput } from './spawn-args.js'

export interface PtyHost {
  write(data: string): void
  resize(cols: number, rows: number): void
  dispose(): void
}

export interface PtyHostOptions {
  readonly input: SpawnArgsInput
  readonly cols: number
  readonly rows: number
  onData(data: string): void
  onExit(code: number): void
}

/**
 * 生一個跑真 claude 二進位檔的 PTY。
 *
 * cwd 來自 buildSpawnArgs，也就是使用者的專案目錄。這決定 Insights 的歸屬，
 * 不可改成 app 自身目錄。
 */
export function createPtyHost(options: PtyHostOptions): PtyHost {
  const { command, args, cwd } = buildSpawnArgs(options.input)

  const pty = spawn(command, [...args], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd,
    env: { ...process.env },
  })

  pty.onData(options.onData)
  pty.onExit(({ exitCode }) => options.onExit(exitCode))

  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    dispose: () => pty.kill(),
  }
}
```

- [ ] **Step 4: 接上 preload 與主程序**

`src/preload/terminal.ts` 改寫為：

```typescript
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ResizePayload } from '../shared/ipc.js'

contextBridge.exposeInMainWorld('yeschef', {
  onData: (cb: (data: string) => void) =>
    ipcRenderer.on(IPC.ptyData, (_e, data: string) => cb(data)),
  onExit: (cb: (code: number) => void) =>
    ipcRenderer.on(IPC.ptyExit, (_e, code: number) => cb(code)),
  write: (data: string) => ipcRenderer.send(IPC.ptyInput, data),
  resize: (payload: ResizePayload) => ipcRenderer.send(IPC.ptyResize, payload),
})
```

`src/main/index.ts` 在 `createWindow` 內、`applyLayout()` 之後加入：

```typescript
  const ptyHost = createPtyHost({
    input: {
      projectDir: process.env.YESCHEF_PROJECT_DIR ?? process.cwd(),
      mcpServerCommand: 'node',
      mcpServerArgs: [join(import.meta.dirname, '../main/mcp.js')],
    },
    cols: 80,
    rows: 24,
    onData: (d) => terminalView.webContents.send(IPC.ptyData, d),
    onExit: (c) => terminalView.webContents.send(IPC.ptyExit, c),
  })

  ipcMain.on(IPC.ptyInput, (_e, data: string) => ptyHost.write(data))
  ipcMain.on(IPC.ptyResize, (_e, p: ResizePayload) => ptyHost.resize(p.cols, p.rows))
  win.on('closed', () => ptyHost.dispose())
```

並在檔案頂端補上 import：

```typescript
import { app, BaseWindow, WebContentsView, ipcMain } from 'electron'
import { createPtyHost } from './pty-host.js'
import { IPC, type ResizePayload } from '../shared/ipc.js'
```

`mcp.js` 這個路徑在本計畫範圍內還不存在，Task 1 的測試只驗參數組裝的形狀，claude 啟動時會回報連不上該 MCP server 並繼續執行。這是預期行為，MCP server 是閘門之後第二份計畫的內容。

- [ ] **Step 5: 寫 renderer 的終端機**

`src/renderer/terminal.css`：

```css
html, body { margin: 0; height: 100%; background: #12140f; overflow: hidden; }
#term { height: 100%; padding: 8px; box-sizing: border-box; }
```

`src/renderer/terminal.ts`：

```typescript
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

declare global {
  interface Window {
    yeschef: {
      onData(cb: (data: string) => void): void
      onExit(cb: (code: number) => void): void
      write(data: string): void
      resize(p: { cols: number; rows: number }): void
    }
  }
}

const term = new Terminal({
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 13,
  theme: { background: '#12140f', foreground: '#d8dcd4' },
  allowProposedApi: true,
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('term')!)
fit.fit()

window.yeschef.onData((d) => term.write(d))
window.yeschef.onExit((c) => term.write(`\r\n[claude 已結束，代碼 ${c}]\r\n`))
term.onData((d) => window.yeschef.write(d))

const syncSize = (): void => {
  fit.fit()
  window.yeschef.resize({ cols: term.cols, rows: term.rows })
}
syncSize()
window.addEventListener('resize', syncSize)
```

`src/renderer/index.html` 的 body 改為：

```html
  <body>
    <div id="term"></div>
    <script type="module" src="./terminal.ts"></script>
  </body>
```

- [ ] **Step 6: 手動驗證（這是 Spike 1 的 TUI 那一半）**

Run: `YESCHEF_PROJECT_DIR=$HOME/Workspace npm run dev`

逐項確認並記錄結果：

1. 左格出現 claude 的歡迎畫面，可以正常對話
2. 進 plan mode，畫面的框線與顏色正確，離開後不留殘影
3. 按 `ctrl+O` 展開思考內容，捲動正常
4. 貼上一段十行以上的文字，不會被逐行送出（bracketed paste 有生效）
5. 拉動視窗改變寬度，終端機重排且 claude 的畫面跟著重繪，不錯位
6. 在左格打字的同時，右格的網頁仍然可以用滑鼠點
7. 關閉視窗，用 `ps aux | grep claude` 確認子程序有被收掉

任何一項不過就記下現象，這是 Spike 1 的產出之一。

- [ ] **Step 7: 提交**

```bash
git add src/shared/ipc.ts src/main/pty-host.ts src/main/index.ts src/preload/terminal.ts src/renderer/
git commit -m "feat: 左窗格接 PTY 跑真的 claude CLI"
```

---

### Task 5: Spike 1 記憶體量測

**Files:**
- Create: `spikes/measure-memory.ts`
- Create: `docs/RESULTS-01-memory.md`
- Modify: `package.json`（加 `spike:memory` script）

**Interfaces:**
- Consumes: 無（獨立腳本，讀 `ps` 輸出）
- Produces: `docs/RESULTS-01-memory.md`，供閘門判斷

判準：yeschef 全部程序的 RSS 總和，減去基準線（iTerm2 加 chrome-devtools-mcp 開的 Chrome 的 RSS 總和），淨變化不得超過 +150 MB。

- [ ] **Step 1: 寫量測腳本**

`spikes/measure-memory.ts`：

```typescript
import { execSync } from 'node:child_process'

interface Group {
  readonly label: string
  /** 命令列必須包含其中任一字串才算進這一組 */
  readonly match: readonly string[]
}

const GROUPS: readonly Group[] = [
  { label: 'yeschef', match: ['yeschef', 'electron-vite'] },
  { label: 'claude CLI', match: ['/claude'] },
  { label: '基準線 iTerm2', match: ['iTerm.app'] },
  { label: '基準線 chrome-devtools-mcp 的 Chrome', match: ['chrome-devtools-mcp/chrome-profile'] },
]

function rssByGroup(group: Group): { readonly totalMb: number; readonly count: number } {
  const lines = execSync('ps -Ao rss,command', { encoding: 'utf8' }).split('\n').slice(1)
  const hits = lines.filter((l) => group.match.some((m) => l.includes(m)))
  const kb = hits.reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0] ?? 0), 0)
  return { totalMb: Math.round(kb / 1024), count: hits.length }
}

for (const group of GROUPS) {
  const { totalMb, count } = rssByGroup(group)
  console.log(`${group.label.padEnd(38)} ${String(totalMb).padStart(6)} MB  (${count} 個程序)`)
}
```

`package.json` 的 scripts 加入：

```json
{
  "scripts": {
    "spike:memory": "node --experimental-strip-types spikes/measure-memory.ts"
  }
}
```

- [ ] **Step 2: 量基準線**

只開 iTerm2 跑 `claude`，另外用 chrome-devtools MCP 開一個 Chrome 並導到一個重的網頁（用 `https://www.notion.so` 或任何你日常會測的複雜頁面）。等 60 秒讓記憶體穩定。

Run: `npm run spike:memory`

把「基準線 iTerm2」與「基準線 chrome-devtools-mcp 的 Chrome」兩列的數字記下來。

- [ ] **Step 3: 量 yeschef**

關掉上一步的 iTerm2 與那個 Chrome。開 yeschef，右格導到**同一個網頁**，左格跑 `claude` 並送出一個會產生輸出的問題。等 60 秒。

Run: `npm run spike:memory`

- [ ] **Step 4: 寫結果文件**

`docs/RESULTS-01-memory.md`，用以下結構（數字填實測值）：

```markdown
# Spike 1 結果：記憶體與 TUI 可用性

量測日期：
機器：16 GB M1
量測方法：ps -Ao rss,command 依命令列分組加總，穩定 60 秒後取值

## 記憶體

| 組別 | RSS |
|---|---|
| 基準線 iTerm2 | ___ MB |
| 基準線 Chrome（chrome-devtools-mcp profile） | ___ MB |
| 基準線合計 | ___ MB |
| yeschef 全部程序 | ___ MB |
| claude CLI（兩種情境相同，不計入差額） | ___ MB |
| **淨變化** | **___ MB** |

判準 +150 MB：通過 / 未通過

## TUI 可用性（Task 4 Step 6 的七項）

| 檢查項 | 結果 | 現象 |
|---|---|---|
| 1 歡迎畫面與對話 | | |
| 2 plan mode 框線與殘影 | | |
| 3 ctrl+O 展開與捲動 | | |
| 4 貼上十行文字 | | |
| 5 resize 重排 | | |
| 6 左格打字時右格可點 | | |
| 7 關閉後子程序回收 | | |

## 結論
```

- [ ] **Step 5: 提交**

```bash
git add spikes/measure-memory.ts docs/RESULTS-01-memory.md package.json
git commit -m "spike: 記憶體與 TUI 可用性量測結果"
```

---

### Task 6: CDP 附著與指令封裝

**Files:**
- Create: `src/main/cdp.ts`
- Create: `tests/cdp.test.ts`
- Create: `tests/fixtures/click-counter.html`

**Interfaces:**
- Consumes: 無
- Produces:
  - `class CdpError extends Error { readonly code: string }`
  - `function toCdpError(raw: unknown): CdpError`
  - `interface CdpSession { send<T>(method: string, params?: object): Promise<T>; detach(): void }`
  - `function attachCdp(wc: WebContents): Promise<CdpSession>`

- [ ] **Step 1: 寫 fixture 頁面**

`tests/fixtures/click-counter.html`：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>click-counter</title>
    <style>
      body { margin: 0; display: grid; place-items: center; height: 100vh; font: 16px system-ui; }
      #btn { width: 240px; height: 120px; font-size: 20px; }
    </style>
  </head>
  <body>
    <button id="btn">click me</button>
    <script>
      window.__clicks = 0
      document.getElementById('btn').addEventListener('click', () => {
        window.__clicks += 1
      })
    </script>
  </body>
</html>
```

- [ ] **Step 2: 寫失敗的測試**

`tests/cdp.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { toCdpError, CdpError } from '../src/main/cdp.js'

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
})
```

- [ ] **Step 3: 執行測試，確認失敗**

Run: `npm test tests/cdp.test.ts`
Expected: FAIL，無法解析 `../src/main/cdp.js`

- [ ] **Step 4: 寫實作**

`src/main/cdp.ts`：

```typescript
import type { WebContents } from 'electron'

export class CdpError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'CdpError'
    this.code = code
  }
}

/** CDP 的錯誤形狀不固定，統一成 CdpError 才能在上層一致處理。 */
export function toCdpError(raw: unknown): CdpError {
  if (typeof raw === 'string') return new CdpError(raw, 'unknown')
  if (raw && typeof raw === 'object') {
    const o = raw as { code?: unknown; message?: unknown }
    const message = typeof o.message === 'string' ? o.message : '未知的 CDP 錯誤'
    const code = o.code === undefined ? 'unknown' : String(o.code)
    return new CdpError(message, code)
  }
  return new CdpError('未知的 CDP 錯誤', 'unknown')
}

export interface CdpSession {
  send<T>(method: string, params?: object): Promise<T>
  detach(): void
}

/**
 * 附著 CDP 並開啟 flat 模式的自動附著。
 *
 * flatten: true 是必要的：Electron 強制 strict site isolation，跨站 iframe
 * （金流、SSO 登入框）是獨立的 OOPIF target。沒有這個設定，單一 session
 * 看不到那些 iframe，而 agent 會以為自己成功了。
 */
export async function attachCdp(wc: WebContents): Promise<CdpSession> {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')

  const send = async <T,>(method: string, params: object = {}): Promise<T> => {
    try {
      return (await wc.debugger.sendCommand(method, params)) as T
    } catch (e) {
      throw toCdpError(e)
    }
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })

  return { send, detach: () => wc.debugger.detach() }
}
```

- [ ] **Step 5: 執行測試，確認通過**

Run: `npm test`
Expected: PASS，17 個測試全綠

`attachCdp` 的實際行為由 Task 7 與 Task 8 的量測腳本驗證，那需要 Electron 執行環境，不在 vitest 涵蓋範圍。

- [ ] **Step 6: 提交**

```bash
git add src/main/cdp.ts tests/cdp.test.ts tests/fixtures/click-counter.html
git commit -m "feat: CDP 附著封裝，開啟 flat 模式自動附著"
```

---

### Task 7: Spike 2 無焦點輸入注入量測

**Files:**
- Create: `spikes/probe-input-focus.ts`
- Create: `docs/RESULTS-02-input-focus.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: `attachCdp`, `CdpSession` from `src/main/cdp.ts`；`createAgentView` from `src/main/agent-view.ts`；`splitBounds` from `src/main/layout.ts`
- Produces: `docs/RESULTS-02-input-focus.md`

判準：三種焦點狀態各 200 次，後兩種（左窗格聚焦、視窗失焦）的注入成功率須達 99%。

- [ ] **Step 1: 寫量測腳本**

`spikes/probe-input-focus.ts`：

```typescript
import { app, BaseWindow, WebContentsView } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { attachCdp, type CdpSession } from '../src/main/cdp.js'
import { createAgentView } from '../src/main/agent-view.js'
import { splitBounds } from '../src/main/layout.js'

const ITERATIONS = 200

interface Scenario {
  readonly label: string
  focus(win: BaseWindow, terminal: WebContentsView, agent: WebContentsView): void
}

const SCENARIOS: readonly Scenario[] = [
  { label: '右窗格聚焦', focus: (_w, _t, a) => a.webContents.focus() },
  { label: '左窗格聚焦（使用者在打字）', focus: (_w, t) => t.webContents.focus() },
  { label: '整個視窗失焦', focus: (w) => w.blur() },
]

async function clickCount(cdp: CdpSession): Promise<number> {
  const r = await cdp.send<{ result: { value: number } }>('Runtime.evaluate', {
    expression: 'window.__clicks',
    returnByValue: true,
  })
  return r.result.value
}

async function run(): Promise<void> {
  const win = new BaseWindow({ width: 1600, height: 900 })
  const terminal = new WebContentsView({ webPreferences: { sandbox: true } })
  const agent = createAgentView()
  win.contentView.addChildView(terminal)
  win.contentView.addChildView(agent)

  const { left, right } = splitBounds({ width: 1600, height: 900 }, 0.5)
  terminal.setBounds(left)
  agent.setBounds(right)

  await terminal.webContents.loadURL('data:text/html,<input autofocus>')
  const fixture = pathToFileURL(
    join(import.meta.dirname, '../tests/fixtures/click-counter.html')
  ).href
  await agent.webContents.loadURL(fixture)

  const cdp = await attachCdp(agent.webContents)

  // 按鈕在右窗格中央。座標是相對 view 而非視窗。
  const x = Math.round(right.width / 2)
  const y = Math.round(right.height / 2)

  for (const scenario of SCENARIOS) {
    await agent.webContents.executeJavaScript('window.__clicks = 0')
    scenario.focus(win, terminal, agent)
    await new Promise((r) => setTimeout(r, 300))

    for (let i = 0; i < ITERATIONS; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      })
    }

    await new Promise((r) => setTimeout(r, 500))
    const got = await clickCount(cdp)
    const rate = ((got / ITERATIONS) * 100).toFixed(1)
    console.log(`${scenario.label.padEnd(26)} ${got}/${ITERATIONS}  成功率 ${rate}%`)
  }

  cdp.detach()
  app.quit()
}

void app.whenReady().then(run)
```

`package.json` 的 scripts 加入：

```json
{
  "scripts": {
    "spike:input": "esbuild spikes/probe-input-focus.ts --bundle --platform=node --format=cjs --external:electron --outfile=.spike-out/probe-input-focus.cjs && electron .spike-out/probe-input-focus.cjs"
  }
}
```

Electron 不能直接跑 `.ts`，所以先用 esbuild 打包成 CommonJS 再交給 electron。esbuild 已隨 vite 一起安裝，不需另外裝。`--external:electron` 是必要的，electron 模組由執行環境提供，打包進去會壞。

把 `.spike-out/` 加進 `.gitignore`。

- [ ] **Step 2: 執行量測**

Run: `npm run spike:input`
Expected: 三行輸出，各含成功次數與百分比

- [ ] **Step 3: 寫結果文件**

`docs/RESULTS-02-input-focus.md`：

```markdown
# Spike 2 結果：右窗格無焦點時的 CDP 輸入注入

量測日期：
Electron 版本：
每種狀態次數：200

| 焦點狀態 | 成功次數 | 成功率 | 判準 99% |
|---|---|---|---|
| 右窗格聚焦 | ___/200 | ___% | |
| 左窗格聚焦（使用者在打字） | ___/200 | ___% | |
| 整個視窗失焦 | ___/200 | ___% | |

## 結論

通過 / 未通過。未通過時採用規格 §8 已定的降級方案：agent 執行 view 工具期間，
主程序主動把焦點移到右窗格並在左窗格顯示「agent 操作中」遮罩，操作結束後把焦點還回去。

## 附註
```

- [ ] **Step 4: 提交**

```bash
git add spikes/probe-input-focus.ts docs/RESULTS-02-input-focus.md package.json
git commit -m "spike: 無焦點輸入注入量測結果"
```

---

### Task 8: Spike 3 跨站 iframe 覆蓋率量測

**Files:**
- Create: `spikes/probe-oopif.ts`
- Create: `docs/RESULTS-03-oopif.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: `attachCdp` from `src/main/cdp.ts`；`createAgentView` from `src/main/agent-view.ts`
- Produces: `docs/RESULTS-03-oopif.md`

判準：跨站 iframe 的 CDP target 附著覆蓋率須達 95%。

- [ ] **Step 1: 寫量測腳本**

`spikes/probe-oopif.ts`：

```typescript
import { app, BaseWindow } from 'electron'
import { attachCdp } from '../src/main/cdp.js'
import { createAgentView } from '../src/main/agent-view.js'

/** 這些站都含跨站 iframe。若某站已改版，換成同類型的站並在結果文件註明。 */
const SITES: readonly string[] = [
  'https://www.google.com/recaptcha/api2/demo',
  'https://docs.stripe.com/payments/quickstart',
  'https://developers.google.com/identity/gsi/web/tools/configurator',
  'https://www.w3schools.com/html/html_iframe.asp',
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe',
]

/** 從頁面內數出跨來源的 iframe：能讀到 contentDocument 的是同源，讀不到的是跨站。 */
const COUNT_CROSS_ORIGIN = `
  [...document.querySelectorAll('iframe')].filter((f) => {
    try { return f.contentDocument === null } catch { return true }
  }).length
`

async function run(): Promise<void> {
  const win = new BaseWindow({ width: 1400, height: 900 })
  const agent = createAgentView()
  win.contentView.addChildView(agent)
  agent.setBounds({ x: 0, y: 0, width: 1400, height: 900 })

  for (const site of SITES) {
    try {
      await agent.webContents.loadURL(site)
      await new Promise((r) => setTimeout(r, 4000))

      const cdp = await attachCdp(agent.webContents)
      const inPage = await agent.webContents.executeJavaScript(COUNT_CROSS_ORIGIN)
      const { targetInfos } = await cdp.send<{ targetInfos: { type: string }[] }>(
        'Target.getTargets'
      )
      const attached = targetInfos.filter((t) => t.type === 'iframe').length
      const rate = inPage === 0 ? 'n/a' : `${((attached / inPage) * 100).toFixed(0)}%`

      console.log(`${site}\n  頁面內跨站 iframe ${inPage}，附著 target ${attached}，覆蓋率 ${rate}`)
      cdp.detach()
    } catch (e) {
      console.log(`${site}\n  失敗：${String(e)}`)
    }
  }

  app.quit()
}

void app.whenReady().then(run)
```

`package.json` 的 scripts 加入：

```json
{
  "scripts": {
    "spike:oopif": "esbuild spikes/probe-oopif.ts --bundle --platform=node --format=cjs --external:electron --outfile=.spike-out/probe-oopif.cjs && electron .spike-out/probe-oopif.cjs"
  }
}
```

- [ ] **Step 2: 執行量測**

Run: `npm run spike:oopif`
Expected: 五組輸出，各含頁面內跨站 iframe 數、附著 target 數、覆蓋率

- [ ] **Step 3: 寫結果文件**

`docs/RESULTS-03-oopif.md`：

```markdown
# Spike 3 結果：跨站 iframe 的 CDP 覆蓋率

量測日期：
Electron 版本：
Chromium 版本：

| 站點 | 頁面內跨站 iframe | 附著 target | 覆蓋率 |
|---|---:|---:|---:|
| recaptcha demo | | | |
| stripe quickstart | | | |
| google identity configurator | | | |
| w3schools iframe | | | |
| mdn iframe | | | |
| **加權平均** | | | |

判準 95%：通過 / 未通過

## 結論

未通過時的處置：E2E 情境明確排除跨站金流與 SSO 頁，並在 `view_snapshot`
的回傳中固定標出「有 N 個 iframe 未附著」，讓 agent 知道自己看不到。

## 附註（含站點若已改版的替換說明）
```

- [ ] **Step 4: 提交**

```bash
git add spikes/probe-oopif.ts docs/RESULTS-03-oopif.md package.json
git commit -m "spike: 跨站 iframe CDP 覆蓋率量測結果"
```

---

## 閘門

三份 `RESULTS-*.md` 齊備後停下來，不要自動往下寫 MCP 工具層。

| Spike | 判準 | 未通過時 |
|---|---|---|
| 1 記憶體 | 淨變化 ≤ +150 MB | 重新檢視方案選擇。規格 §3.1 的視窗編排方案是備案 |
| 1 TUI | 七項檢查全過 | 個別修，除非是 xterm.js 本身無法支援的行為 |
| 2 輸入注入 | 後兩種焦點狀態 ≥ 99% | 採用規格 §8 已定的焦點切換加遮罩降級方案 |
| 3 iframe 覆蓋率 | ≥ 95% | E2E 情境排除跨站金流與 SSO，snapshot 固定回報未附著數 |

閘門通過後的下一份計畫涵蓋規格 §5 的 9 個 MCP 工具、§5.0 的 ref 生命週期、§6 的人機交接，以及 §9 的 fixture 端到端測試。
