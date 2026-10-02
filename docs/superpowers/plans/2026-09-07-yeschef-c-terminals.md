# 子專案 C:終端機與分頁左窗格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把左窗格從只有 Claude 對話,改成「對話與終端機」的分頁容器,終端機能跑任何 CLI(claude／codex／grok／zsh),直接操作本機。

**Architecture:** 主行程開一個只綁 `127.0.0.1` 的 websocket 伺服器,每條連線配一個 node-pty;renderer 用 xterm 連上去,全部走 JSON text frame。左窗格是分頁容器:第一個分頁是現有的 Claude 對話(A 原封不動),其餘是終端分頁。只有「問 port」走一次 IPC,終端資料全走 websocket,為手機遠端那條鋪路。

**Tech Stack:** Electron 44、React 19、Vitest 4、node-pty、ws、@xterm/xterm、@xterm/addon-fit。

**Spec:** `docs/specs/2026-09-07-yeschef-c-terminals-design.md`

## Global Constraints

- 新增相依:`node-pty`、`ws`、`@xterm/xterm`、`@xterm/addon-fit`;`@electron/rebuild` 當 devDependency。Electron 44、React 19、Vitest 不升版。
- ws 伺服器只綁 `127.0.0.1`,絕不綁 `0.0.0.0`,這一版不做認證(pty 是有完整權限的 shell,localhost-only 是安全關鍵)。
- 終端機全走 websocket 的 JSON text frame:client 送 `open`／`input`／`resize`,server 送 `output`／`exit`。第一則必須是 `open`,之前的訊息一律忽略;壞訊息 log 後忽略、不關連線。
- 只有「問 ws port」走一次 IPC(`terminal:endpoint`);Terminal 元件只認一個 ws URL、不碰 IPC。
- pty spawn:shell 用 `process.env.SHELL` 或 `zsh`,`cwd` 是 projectDir,`name: 'xterm-color'`,`env: process.env`;快捷指令用 `command + '\r'` 寫進 pty。
- Claude 分頁永遠第一個、不可關;終端分頁可關;關掉 active 的終端分頁就切回 Claude 分頁。
- Recents 側欄只在 Claude 分頁顯示。
- 快捷四個:claude、codex、grok、zsh。
- 每個 `src/` 檔案不超過 400 行(測試檔不限,沿 Plan A／B 慣例);純函式模組不 import Electron;`src/shared/` 不 import `src/main/` 或 `src/renderer/`。
- 覆蓋率 Stmts ≥ 93、Branch ≥ 86;`src/main/index.ts` 維持排除。
- commit 訊息 `<type>: <description>`,繁體中文台灣用語,不加任何 trailer;`git add` 逐一列檔名,`git add` 與 `git commit` 分成兩條獨立指令、不用 `&&` 串測試或 typecheck。

---

### Task 0: 地基:node-pty 在這個 Electron build 跑得起來

這一步不是 TDD,是把最容易卡住的原生模組先驗通,並留下之後每個 task 都要的 build 設定。通不過就停下重評估(備案:換 pty 函式庫,或用 `child_process` 加 `script` 模擬 pty)。

**Files:**
- Modify: `package.json`(加相依與一個 `rebuild:native` script)
- Modify: `electron.vite.config.ts`(main 加 `externalizeDepsPlugin`)
- Create: `spikes/probe-pty.ts`(丟棄式,驗完刪)
- Create: `docs/RESULTS-06-c-terminals.md`(記錄 node-pty 版本、rebuild 做法、grok 的實際 CLI 指令)

- [ ] **Step 1: 裝相依**

```bash
npm install node-pty ws @xterm/xterm @xterm/addon-fit
npm install -D @electron/rebuild @types/ws
```

- [ ] **Step 2: main 外部化原生模組**

`electron.vite.config.ts` 的 main 區塊加 `externalizeDepsPlugin`,讓 `node-pty` 與 `ws` 不被 rollup 打包(原生 `.node` 無法打包):

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'src/main/index.ts' } },
  },
  // preload 與 renderer 維持原樣
```

- [ ] **Step 3: 對 Electron ABI 重編 node-pty**

`package.json` 的 `scripts` 加一行:

```json
"rebuild:native": "electron-rebuild --force --only node-pty"
```

執行 `npm run rebuild:native`。若 node-pty 已附對應 Electron 44 的 prebuild、載入不報錯,這步可略,但仍把結論記進 RESULTS-06。

- [ ] **Step 4: 寫丟棄式 spike**

`spikes/probe-pty.ts`:主行程 spawn `zsh`,把輸出印到 console,再自動送一行 `echo PTY_OK` 驗證。

```ts
import { app } from 'electron'
import * as pty from 'node-pty'

void app.whenReady().then(() => {
  const shell = process.env.SHELL ?? 'zsh'
  const p = pty.spawn(shell, [], { name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
  let out = ''
  p.onData((d) => { out += d; process.stdout.write(d) })
  p.onExit(({ exitCode }) => { console.log('[probe] exit', exitCode); app.quit() })
  p.write('echo PTY_OK\r')
  setTimeout(() => { console.log('[probe] contains PTY_OK:', out.includes('PTY_OK')); p.kill() }, 1500)
})
```

- [ ] **Step 5: 跑 spike**

```bash
npx esbuild spikes/probe-pty.ts --bundle --platform=node --format=cjs --external:electron --external:node-pty --outfile=.spike-out/probe-pty.cjs
npx electron .spike-out/probe-pty.cjs
```

Expected:console 印出 `[probe] contains PTY_OK: true`。若 node-pty 載入報 ABI 錯,回 Step 3 重編;仍不行就 BLOCKED,在 RESULTS-06 記下錯誤並提備案。

- [ ] **Step 6: 記錄並清掉丟棄物**

把 node-pty 版本、是否需要 rebuild、`grok` 的實際 CLI 指令名稱寫進 `docs/RESULTS-06-c-terminals.md`(格式沿 `docs/RESULTS-05-*.md` 的表頭)。刪掉 `spikes/probe-pty.ts` 與 `.spike-out/`。保留 `electron.vite.config.ts`、`package.json`、`package-lock.json` 的改動。

- [ ] **Step 7: 確認既有測試沒被相依影響**

```bash
npx vitest run --testTimeout=30000
npm run typecheck
```

Expected:全綠(既有 markdown-stream 在預設 timeout 偶爾逾時是既知 flake,單獨跑該檔會過)。

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts docs/RESULTS-06-c-terminals.md
git commit -m "chore: 裝 node-pty 與終端機相依,驗過 Electron 原生模組地基"
```

---

### Task 1: terminal-server.ts:websocket 加 pty 的伺服器

**Files:**
- Create: `src/main/terminal-server.ts`
- Test: `tests/terminal-server.test.ts`

**Interfaces:**
- Consumes:無(只依標準庫與 `ws`、`node-pty`,用注入的 factory 讓測試不碰真的 pty)。
- Produces:
```ts
export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
export interface SocketLike {
  on(event: 'message', cb: (raw: string) => void): void
  on(event: 'close', cb: () => void): void
  send(text: string): void
  close(): void
}
export interface SpawnPtyOptions { cols: number; rows: number; cwd: string; shell: string }
export type SpawnPty = (opts: SpawnPtyOptions) => PtyLike
export function handleConnection(socket: SocketLike, spawn: SpawnPty, cwd: string, logError: (e: Error) => void): void
export interface TerminalServer { port: number; close(): Promise<void> }
export function startTerminalServer(cwd: string, logError: (e: Error) => void): Promise<TerminalServer>
```

- [ ] **Step 1: 寫 handleConnection 的失敗測試**

`tests/terminal-server.test.ts`:用假 socket 與假 pty,不碰真的 node-pty。

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleConnection, type PtyLike, type SocketLike, type SpawnPty } from '../src/main/terminal-server.js'

function fakePty() {
  const p: any = { dataCb: null, exitCb: null, writes: [], resizes: [], killed: false }
  p.onData = (cb: (d: string) => void) => { p.dataCb = cb }
  p.onExit = (cb: (e: { exitCode: number }) => void) => { p.exitCb = cb }
  p.write = (d: string) => p.writes.push(d)
  p.resize = (c: number, r: number) => p.resizes.push([c, r])
  p.kill = () => { p.killed = true }
  return p as PtyLike & typeof p
}
function fakeSocket() {
  const s: any = { msgCb: null, closeCb: null, sent: [], closed: false }
  s.on = (ev: string, cb: any) => { if (ev === 'message') s.msgCb = cb; else s.closeCb = cb }
  s.send = (t: string) => s.sent.push(t)
  s.close = () => { s.closed = true }
  return s as SocketLike & typeof s
}
const noop = () => {}

describe('handleConnection', () => {
  it('open 用給的 cols/rows/cwd spawn,command 寫進 pty 帶 \\r', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const spawn: SpawnPty = vi.fn(() => pty) as any
    handleConnection(socket, spawn, '/proj', noop)
    socket.msgCb(JSON.stringify({ type: 'open', cols: 100, rows: 30, command: 'codex' }))
    expect(spawn).toHaveBeenCalledWith({ cols: 100, rows: 30, cwd: '/proj', shell: expect.any(String) })
    expect(pty.writes).toEqual(['codex\r'])
  })

  it('open 之前的訊息一律忽略', () => {
    const socket = fakeSocket(); const spawn: SpawnPty = vi.fn(() => fakePty()) as any
    handleConnection(socket, spawn, '/proj', noop)
    socket.msgCb(JSON.stringify({ type: 'input', data: 'x' }))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('open 後 input 寫進 pty、resize 呼叫 pty.resize', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, '/proj', noop)
    socket.msgCb(JSON.stringify({ type: 'open', cols: 80, rows: 24 }))
    socket.msgCb(JSON.stringify({ type: 'input', data: 'ls\r' }))
    socket.msgCb(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }))
    expect(pty.writes).toEqual(['ls\r'])
    expect(pty.resizes).toEqual([[90, 20]])
  })

  it('pty 輸出送成 output,結束送 exit 再關 socket', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, '/proj', noop)
    socket.msgCb(JSON.stringify({ type: 'open', cols: 80, rows: 24 }))
    pty.dataCb('hello')
    expect(socket.sent).toContain(JSON.stringify({ type: 'output', data: 'hello' }))
    pty.exitCb({ exitCode: 0 })
    expect(socket.sent).toContain(JSON.stringify({ type: 'exit', code: 0 }))
    expect(socket.closed).toBe(true)
  })

  it('socket 關閉時 kill pty', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, '/proj', noop)
    socket.msgCb(JSON.stringify({ type: 'open', cols: 80, rows: 24 }))
    socket.closeCb()
    expect(pty.killed).toBe(true)
  })

  it('壞訊息 log 後忽略,不關連線', () => {
    const socket = fakeSocket(); const logError = vi.fn()
    handleConnection(socket, () => fakePty(), '/proj', logError)
    socket.msgCb('這不是 json')
    socket.msgCb(JSON.stringify({ nope: 1 }))
    expect(socket.closed).toBe(false)
    expect(logError).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑測試看它失敗**

Run: `npx vitest run tests/terminal-server.test.ts`
Expected:FAIL,找不到 `../src/main/terminal-server.js`。

- [ ] **Step 3: 寫 handleConnection 最小實作**

```ts
export function handleConnection(
  socket: SocketLike,
  spawn: SpawnPty,
  cwd: string,
  logError: (e: Error) => void
): void {
  let pty: PtyLike | null = null
  const shell = process.env.SHELL ?? 'zsh'

  socket.on('message', (raw) => {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      logError(new Error('終端機收到非 JSON 訊息,已忽略'))
      return
    }
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
      logError(new Error('終端機收到缺 type 的訊息,已忽略'))
      return
    }
    const m = msg as { type: string; [k: string]: unknown }

    if (m.type === 'open') {
      if (pty !== null) return
      const cols = typeof m.cols === 'number' ? m.cols : 80
      const rows = typeof m.rows === 'number' ? m.rows : 24
      pty = spawn({ cols, rows, cwd, shell })
      pty.onData((data) => socket.send(JSON.stringify({ type: 'output', data })))
      pty.onExit(({ exitCode }) => {
        socket.send(JSON.stringify({ type: 'exit', code: exitCode }))
        socket.close()
      })
      if (typeof m.command === 'string' && m.command.length > 0) pty.write(m.command + '\r')
      return
    }
    if (pty === null) return // open 之前的其他訊息忽略
    if (m.type === 'input' && typeof m.data === 'string') { pty.write(m.data); return }
    if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      pty.resize(m.cols, m.rows); return
    }
    logError(new Error(`終端機收到不認得的訊息 type=${m.type},已忽略`))
  })

  socket.on('close', () => { if (pty !== null) pty.kill() })
}
```

- [ ] **Step 4: 跑測試看它通過**

Run: `npx vitest run tests/terminal-server.test.ts`
Expected:PASS。

- [ ] **Step 5: 加 startTerminalServer(真的 ws 加 node-pty)**

在同檔加,綁 `127.0.0.1:0`(系統給空 port),真的 spawn 用 node-pty:

```ts
import { WebSocketServer, type WebSocket } from 'ws'
import * as nodePty from 'node-pty'

const realSpawn: SpawnPty = ({ cols, rows, cwd, shell }) =>
  nodePty.spawn(shell, [], { name: 'xterm-color', cols, rows, cwd, env: process.env }) as unknown as PtyLike

export function startTerminalServer(cwd: string, logError: (e: Error) => void): Promise<TerminalServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    wss.on('error', reject)
    wss.on('listening', () => {
      const addr = wss.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      wss.on('connection', (ws: WebSocket) => {
        const socket: SocketLike = {
          on: (ev: any, cb: any) => {
            if (ev === 'message') ws.on('message', (d) => cb(d.toString()))
            else ws.on('close', cb)
          },
          send: (t) => ws.send(t),
          close: () => ws.close(),
        }
        handleConnection(socket, realSpawn, cwd, logError)
      })
      resolve({
        port,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      })
    })
  })
}
```

- [ ] **Step 6: typecheck 加全測**

Run: `npm run typecheck` 然後 `npx vitest run tests/terminal-server.test.ts`
Expected:兩者皆過。

- [ ] **Step 7: Commit**

```bash
git add src/main/terminal-server.ts tests/terminal-server.test.ts
git commit -m "feat: 終端機的 websocket 加 pty 伺服器"
```

---

### Task 2: endpoint 接線(shared／preload／ipc-bridge／index)

**Files:**
- Modify: `src/shared/ipc.ts`(加 `terminal:endpoint` 常數、型別、parse)
- Modify: `src/preload/bridge.ts`(api 加 `terminalEndpoint`)
- Modify: `src/main/ipc-bridge.ts`(處理 `terminal:endpoint`)
- Modify: `src/main/index.ts`(啟動 terminal-server,把 port 交給 bridge)
- Test: `tests/ipc.test.ts`(加 parseTerminalEndpoint)、`tests/ipc-bridge.test.ts`(加 endpoint handler)

**Interfaces:**
- Consumes:Task 1 的 `startTerminalServer`。
- Produces:`YesChefApi.terminalEndpoint(): Promise<TerminalEndpoint>`、`TerminalEndpoint = { port: number }`、`parseTerminalEndpoint(raw): TerminalEndpoint | null`、`IPC.terminalEndpoint = 'terminal:endpoint'`。

- [ ] **Step 1: 寫 parseTerminalEndpoint 的失敗測試**

`tests/ipc.test.ts` 加:

```ts
import { parseTerminalEndpoint } from '../src/shared/ipc.js'

describe('parseTerminalEndpoint', () => {
  it('接受 { port } 數字', () => {
    expect(parseTerminalEndpoint({ port: 51234 })).toEqual({ port: 51234 })
  })
  it('port 不是數字回 null', () => {
    expect(parseTerminalEndpoint({ port: '51234' })).toBeNull()
    expect(parseTerminalEndpoint(null)).toBeNull()
    expect(parseTerminalEndpoint({})).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試看它失敗**

Run: `npx vitest run tests/ipc.test.ts`
Expected:FAIL,`parseTerminalEndpoint` 未匯出。

- [ ] **Step 3: 在 shared/ipc.ts 實作**

在 `IPC` 物件加 `terminalEndpoint: 'terminal:endpoint'`(插在 `intentOpenHistory` 之後、`} as const` 之前,用文字錨點定位),並加:

```ts
export interface TerminalEndpoint { readonly port: number }

export function parseTerminalEndpoint(raw: unknown): TerminalEndpoint | null {
  if (!isRecord(raw)) return null
  const port = raw['port']
  return typeof port === 'number' && Number.isFinite(port) ? { port } : null
}
```

在 `YesChefApi` 介面加 `terminalEndpoint(): Promise<TerminalEndpoint>`。

- [ ] **Step 4: 跑測試看它通過**

Run: `npx vitest run tests/ipc.test.ts`
Expected:PASS。

- [ ] **Step 5: preload 接上(注意大括號鐵律)**

`src/preload/bridge.ts` 的 `api` 物件加(用大括號函式體,不可簡潔箭頭):

```ts
  terminalEndpoint: () => {
    return ipcRenderer.invoke(IPC.terminalEndpoint) as Promise<TerminalEndpoint>
  },
```

import 補 `TerminalEndpoint`。既有測試檔若有假 `YesChefApi`,補 `terminalEndpoint: vi.fn()` 樁(照 Plan B 裁決 23 的做法)。

- [ ] **Step 6: ipc-bridge 處理 endpoint 的失敗測試**

`tests/ipc-bridge.test.ts` 的 setup 讓 bridge 拿到一個 port,加案例:

```ts
it('terminal:endpoint 回設定的 port', async () => {
  const rig = setup({ terminalPort: 51234 })
  const result = await rig.invoke('terminal:endpoint')
  expect(result).toEqual({ port: 51234 })
})
```

`Rig`／`setup` 加一個選填 `terminalPort`,沒給就不註冊(沒有 view tools 時行為與現況相同的同一套寫法)。

- [ ] **Step 7: ipc-bridge 實作**

`IpcBridgeDeps` 加選填 `terminalPort?: number`;`createIpcBridge` 用 `ipcMain.handle(IPC.terminalEndpoint, () => ({ port: deps.terminalPort }))`,只在 `terminalPort !== undefined` 時註冊,`dispose` 時 `removeHandler`。

- [ ] **Step 8: index.ts 啟動伺服器**

`createWindow` 裡(建 bridge 之前)`const term = await startTerminalServer(projectDir, logError)`,把 `term.port` 傳進 `createIpcBridge` 的 `terminalPort`;`win.on('closed')` 的收尾加 `void term.close()`。這一步無測試縫(index.ts 排除)。

- [ ] **Step 9: 全測加 typecheck**

Run: `npx vitest run` 然後 `npm run typecheck`
Expected:皆過(measure-memory 在沙箱外驗)。

- [ ] **Step 10: Commit**

```bash
git add src/shared/ipc.ts src/preload/bridge.ts src/main/ipc-bridge.ts src/main/index.ts tests/ipc.test.ts tests/ipc-bridge.test.ts
git commit -m "feat: 接上 terminal:endpoint,啟動時開終端機伺服器"
```

---

### Task 3: useTerminals.ts:分頁狀態

**Files:**
- Create: `src/renderer/hooks/useTerminals.ts`
- Test: `tests/use-terminals.test.tsx`

**Interfaces:**
- Consumes:無。
- Produces:
```ts
export type Tab =
  | { readonly id: 'claude'; readonly kind: 'conversation' }
  | { readonly id: string; readonly kind: 'terminal'; readonly title: string; readonly command?: string }
export interface TerminalsApi {
  readonly tabs: readonly Tab[]
  readonly activeId: string
  readonly sidebarVisible: boolean
  openTerminal(title: string, command?: string): void
  activate(id: string): void
  close(id: string): void
}
export function useTerminals(): TerminalsApi
```

- [ ] **Step 1: 寫 reducer 的失敗測試**

`tests/use-terminals.test.tsx`,用 `@testing-library/react` 的 `renderHook`(專案已用於其他 hook 測試):

```ts
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTerminals } from '../src/renderer/hooks/useTerminals.js'

describe('useTerminals', () => {
  it('初始只有 Claude 分頁且為 active,側欄顯示', () => {
    const { result } = renderHook(() => useTerminals())
    expect(result.current.tabs).toEqual([{ id: 'claude', kind: 'conversation' }])
    expect(result.current.activeId).toBe('claude')
    expect(result.current.sidebarVisible).toBe(true)
  })
  it('開終端分頁會加上並切成 active,側欄關掉', () => {
    const { result } = renderHook(() => useTerminals())
    act(() => result.current.openTerminal('codex', 'codex'))
    expect(result.current.tabs).toHaveLength(2)
    const t = result.current.tabs[1]
    expect(t.kind).toBe('terminal')
    expect(result.current.activeId).toBe(t.id)
    expect(result.current.sidebarVisible).toBe(false)
  })
  it('每個終端分頁 id 不同', () => {
    const { result } = renderHook(() => useTerminals())
    act(() => result.current.openTerminal('zsh'))
    act(() => result.current.openTerminal('zsh'))
    const ids = result.current.tabs.filter((t) => t.kind === 'terminal').map((t) => t.id)
    expect(new Set(ids).size).toBe(2)
  })
  it('關掉 active 的終端分頁會切回 Claude', () => {
    const { result } = renderHook(() => useTerminals())
    act(() => result.current.openTerminal('codex', 'codex'))
    const id = result.current.activeId
    act(() => result.current.close(id))
    expect(result.current.activeId).toBe('claude')
    expect(result.current.tabs).toHaveLength(1)
  })
  it('關掉非 active 的分頁不改 active', () => {
    const { result } = renderHook(() => useTerminals())
    act(() => result.current.openTerminal('a'))
    const first = result.current.activeId
    act(() => result.current.openTerminal('b'))
    act(() => result.current.close(first))
    expect(result.current.activeId).not.toBe(first)
    expect(result.current.tabs).toHaveLength(2)
  })
  it('close Claude 分頁一律忽略', () => {
    const { result } = renderHook(() => useTerminals())
    act(() => result.current.close('claude'))
    expect(result.current.tabs).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑測試看它失敗**

Run: `npx vitest run tests/use-terminals.test.tsx`
Expected:FAIL,`useTerminals` 未匯出。

- [ ] **Step 3: 最小實作**

```ts
import { useCallback, useMemo, useRef, useState } from 'react'

const CLAUDE_TAB: Tab = { id: 'claude', kind: 'conversation' }

export function useTerminals(): TerminalsApi {
  const [tabs, setTabs] = useState<readonly Tab[]>([CLAUDE_TAB])
  const [activeId, setActiveId] = useState<string>('claude')
  const seq = useRef(0)

  const openTerminal = useCallback((title: string, command?: string) => {
    const id = `term-${(seq.current += 1)}`
    const tab: Tab = command === undefined
      ? { id, kind: 'terminal', title }
      : { id, kind: 'terminal', title, command }
    setTabs((prev) => [...prev, tab])
    setActiveId(id)
  }, [])

  const activate = useCallback((id: string) => setActiveId(id), [])

  const close = useCallback((id: string) => {
    if (id === 'claude') return
    setTabs((prev) => prev.filter((t) => t.id !== id))
    setActiveId((cur) => (cur === id ? 'claude' : cur))
  }, [])

  const sidebarVisible = activeId === 'claude'
  return useMemo(
    () => ({ tabs, activeId, sidebarVisible, openTerminal, activate, close }),
    [tabs, activeId, sidebarVisible, openTerminal, activate, close]
  )
}
```

- [ ] **Step 4: 跑測試看它通過**

Run: `npx vitest run tests/use-terminals.test.tsx`
Expected:PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/useTerminals.ts tests/use-terminals.test.tsx
git commit -m "feat: 左窗格分頁狀態 useTerminals"
```

---

### Task 4: terminal-client.ts 與 Terminal.tsx

把 websocket 協定的 client 抽成純模組(可測),Terminal 元件只是 xterm 的膠水且只認一個 ws URL、不碰 IPC。

**Files:**
- Create: `src/renderer/terminal-client.ts`
- Create: `src/renderer/components/Terminal.tsx`
- Create: `src/renderer/components/Terminal.css`
- Test: `tests/terminal-client.test.ts`

**Interfaces:**
- Consumes:無(用瀏覽器的 `WebSocket` 全域,測試注入假的)。
- Produces:
```ts
export interface TerminalClient {
  open(cols: number, rows: number, command?: string): void
  sendInput(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}
export interface TerminalClientHandlers {
  onOutput(data: string): void
  onExit(code: number | null): void
}
export type SocketFactory = (url: string) => WebSocket
export function createTerminalClient(
  url: string,
  handlers: TerminalClientHandlers,
  makeSocket?: SocketFactory
): TerminalClient
```

- [ ] **Step 1: 寫 terminal-client 的失敗測試**

`tests/terminal-client.test.ts`,注入一個假 WebSocket:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTerminalClient } from '../src/renderer/terminal-client.js'

function fakeSocket() {
  const s: any = { sent: [], readyState: 1, onopen: null, onmessage: null, onclose: null, closed: false }
  s.send = (t: string) => s.sent.push(t)
  s.close = () => { s.closed = true }
  s.OPEN = 1
  return s
}

describe('terminal-client', () => {
  it('open 送 open 訊息(連線已開時)', () => {
    const s = fakeSocket()
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn() }, () => s as any)
    s.onopen?.()
    c.open(80, 24, 'codex')
    expect(s.sent).toContain(JSON.stringify({ type: 'open', cols: 80, rows: 24, command: 'codex' }))
  })
  it('連線還沒開時 open 先排隊,開了才送', () => {
    const s = fakeSocket(); s.readyState = 0
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn() }, () => s as any)
    c.open(80, 24)
    expect(s.sent).toHaveLength(0)
    s.readyState = 1; s.onopen?.()
    expect(s.sent).toContain(JSON.stringify({ type: 'open', cols: 80, rows: 24 }))
  })
  it('sendInput 與 resize 送對應訊息', () => {
    const s = fakeSocket()
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn() }, () => s as any)
    s.onopen?.()
    c.sendInput('ls\r'); c.resize(90, 20)
    expect(s.sent).toContain(JSON.stringify({ type: 'input', data: 'ls\r' }))
    expect(s.sent).toContain(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }))
  })
  it('收到 output 呼叫 onOutput,收到 exit 呼叫 onExit', () => {
    const s = fakeSocket(); const onOutput = vi.fn(); const onExit = vi.fn()
    createTerminalClient('ws://x', { onOutput, onExit }, () => s as any)
    s.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hi' }) })
    s.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) })
    expect(onOutput).toHaveBeenCalledWith('hi')
    expect(onExit).toHaveBeenCalledWith(0)
  })
  it('壞訊息忽略,不丟例外', () => {
    const s = fakeSocket(); const onOutput = vi.fn()
    createTerminalClient('ws://x', { onOutput, onExit: vi.fn() }, () => s as any)
    expect(() => s.onmessage?.({ data: '不是 json' })).not.toThrow()
    expect(onOutput).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑測試看它失敗**

Run: `npx vitest run tests/terminal-client.test.ts`
Expected:FAIL,`createTerminalClient` 未匯出。

- [ ] **Step 3: 實作 terminal-client.ts**

```ts
export function createTerminalClient(
  url: string,
  handlers: TerminalClientHandlers,
  makeSocket: SocketFactory = (u) => new WebSocket(u)
): TerminalClient {
  const ws = makeSocket(url)
  const queue: string[] = []
  let open = false

  const flush = () => { while (queue.length > 0) ws.send(queue.shift() as string) }
  const send = (obj: unknown) => {
    const text = JSON.stringify(obj)
    if (open && ws.readyState === ws.OPEN) ws.send(text)
    else queue.push(text)
  }

  ws.onopen = () => { open = true; flush() }
  ws.onmessage = (ev: MessageEvent) => {
    let msg: unknown
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) return
    const m = msg as { type: string; data?: unknown; code?: unknown }
    if (m.type === 'output' && typeof m.data === 'string') handlers.onOutput(m.data)
    else if (m.type === 'exit') handlers.onExit(typeof m.code === 'number' ? m.code : null)
  }

  return {
    open: (cols, rows, command) =>
      send(command === undefined ? { type: 'open', cols, rows } : { type: 'open', cols, rows, command }),
    sendInput: (data) => send({ type: 'input', data }),
    resize: (cols, rows) => send({ type: 'resize', cols, rows }),
    close: () => ws.close(),
  }
}
```

- [ ] **Step 4: 跑測試看它通過**

Run: `npx vitest run tests/terminal-client.test.ts`
Expected:PASS。

- [ ] **Step 5: 寫 Terminal.tsx(xterm 膠水)**

只認 `endpoint`(ws URL)與選填 `command`,掛載時建 xterm 加 fit、建 client、接線,`ResizeObserver` 觸發 fit 加 `resize`,unmount 時 `close`。

```tsx
import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createTerminalClient } from '../terminal-client.js'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'

export function Terminal({ endpoint, command }: { readonly endpoint: string; readonly command?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new XTerm({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    const client = createTerminalClient(endpoint, {
      onOutput: (d) => term.write(d),
      onExit: () => term.write('\r\n[已結束]\r\n'),
    })
    client.open(term.cols, term.rows, command)
    const offData = term.onData((d) => client.sendInput(d))
    const ro = new ResizeObserver(() => { fit.fit(); client.resize(term.cols, term.rows) })
    ro.observe(host)
    return () => { ro.disconnect(); offData.dispose(); client.close(); term.dispose() }
  }, [endpoint, command])

  return <div className="terminal-host" ref={hostRef} />
}
```

`Terminal.css`:`.terminal-host { width: 100%; height: 100%; }`。

- [ ] **Step 6: typecheck 加全測**

Run: `npm run typecheck` 然後 `npx vitest run tests/terminal-client.test.ts`
Expected:皆過。Terminal.tsx 的 xterm 實際顯示由 Task 6 的實機 smoke 蓋,不寫脆弱的 DOM 斷言。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/terminal-client.ts src/renderer/components/Terminal.tsx src/renderer/components/Terminal.css tests/terminal-client.test.ts
git commit -m "feat: 終端機 websocket client 與 xterm 元件"
```

---

### Task 5: LeftPane.tsx 與 App.tsx 改寫

把左窗格變成分頁容器。現有 App 的對話內容(Recents 側欄加 Conversation 加 Composer)保持邏輯不變,搬進「Claude 對話」分頁;新增終端分頁與快捷。

**Files:**
- Create: `src/renderer/components/LeftPane.tsx`
- Create: `src/renderer/components/LeftPane.css`
- Modify: `src/renderer/App.tsx`(把現有對話 JSX 當成一個 node 傳給 LeftPane;新增 endpoint 解析)
- Test: `tests/left-pane.test.tsx`

**Interfaces:**
- Consumes:Task 3 的 `useTerminals`、Task 4 的 `Terminal`、Task 2 的 `window.yeschef.terminalEndpoint`。
- Produces:
```ts
export interface LeftPaneProps {
  readonly conversation: React.ReactNode
  readonly endpoint: string | null
}
export function LeftPane(props: LeftPaneProps): React.ReactElement
export const QUICK_LAUNCH: readonly { readonly label: string; readonly command?: string }[]
```

- [ ] **Step 1: 寫 LeftPane 的失敗測試(把 Terminal 換成樁)**

`tests/left-pane.test.tsx`。用 `vi.mock` 把 `Terminal` 換成樁,避免 jsdom 掛 xterm:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
vi.mock('../src/renderer/components/Terminal.js', () => ({
  Terminal: ({ command }: { command?: string }) => <div data-testid="term">{command ?? 'zsh'}</div>,
}))
import { LeftPane } from '../src/renderer/components/LeftPane.js'

const conv = <div data-testid="conv">對話內容</div>

describe('LeftPane', () => {
  it('初始顯示 Claude 對話,Claude 分頁沒有關閉鈕', () => {
    render(<LeftPane conversation={conv} endpoint="ws://127.0.0.1:1" />)
    expect(screen.getByTestId('conv')).toBeTruthy()
    const claudeTab = screen.getByRole('tab', { name: /Claude/ })
    expect(claudeTab.querySelector('.tab-close')).toBeNull()
  })
  it('按快捷 codex 會開一個終端分頁並顯示 Terminal', () => {
    render(<LeftPane conversation={conv} endpoint="ws://127.0.0.1:1" />)
    fireEvent.click(screen.getByRole('button', { name: 'codex' }))
    expect(screen.getByTestId('term').textContent).toBe('codex')
    expect(screen.queryByTestId('conv')).toBeNull()
  })
  it('終端分頁可關,關掉切回 Claude 對話', () => {
    render(<LeftPane conversation={conv} endpoint="ws://127.0.0.1:1" />)
    fireEvent.click(screen.getByRole('button', { name: 'zsh' }))
    fireEvent.click(screen.getByRole('button', { name: '關閉分頁' }))
    expect(screen.getByTestId('conv')).toBeTruthy()
  })
  it('endpoint 還沒好時終端分頁顯示連線中', () => {
    render(<LeftPane conversation={conv} endpoint={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'zsh' }))
    expect(screen.getByText('終端機連線中')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑測試看它失敗**

Run: `npx vitest run tests/left-pane.test.tsx`
Expected:FAIL,`LeftPane` 未匯出。

- [ ] **Step 3: 實作 LeftPane.tsx**

```tsx
import { useTerminals } from '../hooks/useTerminals.js'
import { Terminal } from './Terminal.js'
import './LeftPane.css'

export const QUICK_LAUNCH = [
  { label: 'claude', command: 'claude' },
  { label: 'codex', command: 'codex' },
  { label: 'grok', command: 'grok' }, // grok 的實際 CLI 指令以 RESULTS-06 為準,不同就改這一行
  { label: 'zsh' },
] as const

export function LeftPane({ conversation, endpoint }: LeftPaneProps) {
  const term = useTerminals()
  const active = term.tabs.find((t) => t.id === term.activeId)

  return (
    <div className="left-pane">
      <div className="tab-strip" role="tablist">
        {term.tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === term.activeId}
            className={`tab${t.id === term.activeId ? ' on' : ''}`}
            onClick={() => term.activate(t.id)}
          >
            <span>{t.kind === 'conversation' ? 'Claude 對話' : t.title}</span>
            {t.kind === 'terminal' && (
              <button
                type="button"
                className="tab-close"
                aria-label="關閉分頁"
                onClick={(e) => { e.stopPropagation(); term.close(t.id) }}
              >×</button>
            )}
          </div>
        ))}
        <div className="quick-launch">
          {QUICK_LAUNCH.map((q) => (
            <button key={q.label} type="button" onClick={() => term.openTerminal(q.label, q.command)}>
              {q.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pane-area">
        {active?.kind === 'conversation' && conversation}
        {active?.kind === 'terminal' &&
          (endpoint === null
            ? <div className="term-loading">終端機連線中</div>
            : <Terminal key={active.id} endpoint={endpoint} command={active.command} />)}
      </div>
    </div>
  )
}
```

`LeftPane.css`:tab-strip 橫排、`.tab.on` 底線用 accent、`.pane-area { flex: 1; min-height: 0 }`、`.term-loading` 置中灰字。沿用 `App.css` 既有變數。

- [ ] **Step 4: 改寫 App.tsx**

App 保留 `useConversation`／`useApprovals`／`useSessions` 與所有既有邏輯,把原本 `<div className="app">` 裡「title-bar 之後的 sidebar 加 main」那段 JSX 收成一個變數 `conversation`,改成:

```tsx
const conversation = (
  <>
    <aside className="sidebar">{/* 原本的 Recents 整段,不動 */}</aside>
    <main className="conversation">{/* 原本的 Conversation + approval-tail + Composer,不動 */}</main>
  </>
)
return (
  <div className="app">
    <header className="title-bar">{titleFor(api.projectDir, current, sessions)}</header>
    <LeftPane conversation={conversation} endpoint={endpoint} />
  </div>
)
```

新增 endpoint 解析(掛載時問一次):

```tsx
const [endpoint, setEndpoint] = useState<string | null>(null)
useEffect(() => {
  let alive = true
  api.terminalEndpoint().then(
    ({ port }) => { if (alive) setEndpoint(`ws://127.0.0.1:${port}`) },
    (err: unknown) => { console.error('[yeschef] 取終端機 port 失敗', err) }
  )
  return () => { alive = false }
}, [api])
```

`.app` 的 CSS 從「title-bar / sidebar / main 三格」改成「title-bar 在上、LeftPane 占滿其餘」;sidebar 與 main 的既有樣式移到 LeftPane 的 `.pane-area` 底下沿用。

- [ ] **Step 5: 跑 LeftPane 測試與既有 renderer 測試**

Run: `npx vitest run tests/left-pane.test.tsx tests/conversation.test.tsx tests/use-conversation.test.tsx`
Expected:皆過(既有對話測試不受影響,因為對話邏輯與 JSX 沒動,只是被包進 LeftPane)。

- [ ] **Step 6: 全測加 typecheck**

Run: `npx vitest run` 然後 `npm run typecheck`
Expected:皆過。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/LeftPane.tsx src/renderer/components/LeftPane.css src/renderer/App.tsx tests/left-pane.test.tsx
git commit -m "feat: 左窗格改成對話與終端機的分頁容器"
```

---

### Task 6: 實機 smoke 與 RESULTS-06 驗收

單元測試蓋不到 node-pty 的真實行為與 xterm 顯示,照 Plan B 的教訓,用一次 Electron 實機驗收收尾。index.ts 在 coverage 排除清單,這個 task 沒有新單元測試。

**Files:**
- Modify: `docs/RESULTS-06-c-terminals.md`(填驗收結果)

- [ ] **Step 1: build 並啟動**

```bash
npm run build
YESCHEF_PROJECT_DIR=/tmp/yeschef-c npx electron . --remote-debugging-port=9333
```

Expected:app 開起來,左窗格是 Claude 對話分頁,上面有分頁列與 claude/codex/grok/zsh 快捷,右窗格瀏覽器(B)照舊。

- [ ] **Step 2: 開終端分頁跑指令**

按 `zsh` 快捷,在終端裡打 `echo hi`,看得到 `hi`;按 `codex`,看得到 codex 起來(或它的提示);確認 `grok` 的實際 CLI 指令名稱,對就記進 RESULTS-06,不對就改 `LeftPane.tsx` 的 `QUICK_LAUNCH` 那一行並重驗。

- [ ] **Step 3: resize 與關閉**

把視窗改大改小,終端機跟著 reflow;關一個終端分頁,用 `ps` 確認對應的 pty 程序被收掉、沒有孤兒;關掉 active 分頁會切回 Claude 對話。

- [ ] **Step 4: 安全確認**

從本機的區域網路 IP(不是 127.0.0.1)連那個 ws port,應該連不上(只綁 localhost)。做法:`lsof -nP -iTCP -sTCP:LISTEN | grep <port>` 確認位址是 `127.0.0.1:<port>` 而不是 `*:<port>`。

- [ ] **Step 5: 不回歸確認**

Claude 對話分頁能正常送訊息、收批准卡;右窗格瀏覽器(B)的工具在有終端分頁時行為不變(可挑 view_navigate 加 view_snapshot 各一次)。

- [ ] **Step 6: 填 RESULTS-06 並提交**

把六步結果、node-pty 版本與 rebuild 做法、grok 的實際 CLI 指令寫進 `docs/RESULTS-06-c-terminals.md`。

```bash
git add docs/RESULTS-06-c-terminals.md
git commit -m "docs: 子專案 C 終端機實機驗收結果"
```

---

## 自我檢查(寫計畫者自填,非派工)

**Spec 覆蓋**:§2.1 分頁容器→Task 5;web-first ws 伺服器→Task 1;快捷→Task 5;生命週期→Task 3 加 Task 5;terminal-server 測試→Task 1;實機 smoke→Task 6。§3.1 三決定分別落在 Task 1(ws)、Task 5(分頁)、Task 5(快捷不寫適配層)。§5 協定→Task 1 加 Task 4。§7 只綁 127.0.0.1→Task 1 加 Task 6 Step 4。§8 spike→Task 0。§9 測試與驗收→各 task 的測試加 Task 6。無缺口。

**型別一致**:`terminalEndpoint`／`TerminalEndpoint`/`{port}` 在 Task 2 定義,Task 5 消費一致;`TerminalClient`／`createTerminalClient` 在 Task 4 定義,Terminal.tsx 用一致;`useTerminals`/`Tab` 在 Task 3 定義,LeftPane 用一致;`open`／`input`／`resize`／`output`／`exit` 協定在 Task 1(server)與 Task 4(client)兩端字串一致。

**風險排序**:Task 0(node-pty 原生模組)最可能卡,所以排最前面當 gate,通不過就停。


