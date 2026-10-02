# 每個對話一個瀏覽器,加上網址列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每個對話擁有自己的瀏覽器(獨立 partition、獨立 CDP),右窗格顯示前景對話的那一個,並提供網址列。

**Architecture:** 新的 `browser-sessions.ts` 持有 `Map<conversationId, BrowserSession>`,第一次用到才建 view、CDP 與一份 `ViewTools`。MCP server 在對話啟動時就建立,`invoke` 的第一步是 `ensure(conversationId)`。前景守衛(`isActive`、`MSG.browserBusy`)整個移除。renderer 透過 `browser:command`(invoke)、`browser:state`、`browser:sessions`、`browser:get` 四條 IPC 操作與顯示。

**Tech Stack:** Electron 44(`WebContentsView`、`webContents.debugger`)、TypeScript 7、React 19、zod、vitest、@anthropic-ai/claude-agent-sdk。

**Spec:** `docs/specs/2026-09-21-per-conversation-browser-design.md`

## Global Constraints

- partition 名稱一律是 `agent:<conversationId>`,不加 `persist:` 前綴。
- view 的安全設定照 `src/main/agent-view.ts` 現況:不給 preload、`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: false`、`setBackgroundThrottling(false)`。
- 八個瀏覽器工具的名稱、參數、回傳格式不變;`view-tools/policy.ts` 不動。
- `controller-*.ts`、`settle.ts`、`watch.ts`、`snapshot*.ts`、`frame-offset.ts`、`handoff.ts` 的實作不動,只允許改名 `activeProjectDir` → `projectDir`。
- 所有給人或給模型看的字串用繁體中文,集中在 `src/main/view-tools/errors.ts` 的 `MSG`。
- 不可變更新:狀態用新物件取代,不就地修改(`sessions = new Map([...sessions, [id, entry]])`)。
- 每個函式 50 行以內,每個檔案 400 行以內,縮排不超過 3 層。
- 先寫測試並確認失敗,再寫實作。測試指令:`npx vitest run <檔案>`;全部:`npm test`;型別:`npm run typecheck`。
- commit 訊息格式 `<type>: <description>`,結尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/shared/browser-url.ts` | 新增 | 網址列輸入正規化(純函式) |
| `src/shared/browser-ipc.ts` | 新增 | 四條瀏覽器 IPC 的型別與 parser |
| `src/shared/ipc.ts` | 修改 | `IPC` 加四個頻道名;`YesChefApi` 加四個方法 |
| `src/shared/projects.ts` | 修改 | `TabEntry.lastUrl`;`isTabEntry` 驗它 |
| `src/main/projects-schema.ts` | 修改 | `tabSchema.lastUrl` |
| `src/main/projects-state.ts` | 修改 | `setTabLastUrl`、`tabLastUrl` |
| `src/main/view-tools/server.ts` | 修改 | 每個 session 一份的 `ViewTools`:沒有前景守衛、沒有 MCP server |
| `src/main/view-tools/conversation-server.ts` | 新增 | 每個對話一份的 MCP server,`invoke` 先 `resolve()` 再轉給 `ViewTools` |
| `src/main/view-tools/startup.ts`、`controller-types.ts`、`controller-page.ts` | 修改 | `activeProjectDir` 改名 `projectDir`;startup 傳 `onBusyChange` |
| `src/main/view-tools/errors.ts` | 修改 | 加 `browserUnavailable`、`notUrl`;刪 `browserBusy` |
| `src/main/agent-view.ts` | 修改 | 收 partition 參數 |
| `src/main/view-switch.ts` | 新增 | `PlaceableView` 轉接物件 |
| `src/main/browser-sessions.ts` | 新增 | session 登錄表 |
| `src/main/browser-commands.ts` | 新增 | 處理 `browser:command` |
| `src/main/index.ts` | 修改 | 拿掉單一 `agentView`,接上 sessions |
| `src/main/ipc-bridge.ts` | 修改 | `switchTo` 呼叫 `show`;`closeSlot` 呼叫 `dispose`;`runtimeFor` 拿掉 `isActive` |
| `src/main/conversation.ts` | 修改 | `ViewToolHooks` 改成獨立介面 |
| `src/preload/bridge.ts` | 修改 | 四個新方法 |
| `src/renderer/hooks/useBrowser.ts` | 新增 | 收 `browser:state` 與 `browser:sessions` |
| `src/renderer/components/BrowserBar.tsx`、`.css` | 新增 | 網址列 |
| `src/renderer/components/BrowserEmpty.tsx` | 新增 | 空狀態 |
| `src/renderer/components/PanelGroup.tsx`、`App.tsx` | 修改 | 接上網址列與空狀態 |
| `src/renderer/components/LeftPane.tsx`、`ProjectBar.tsx` | 修改 | 地球圖示 |
| `spikes/measure-browser-sessions.ts`、`spikes/fixtures/session-page.html` | 新增 | 記憶體量測 |
| `tests/helpers/fake-yeschef.ts` | 修改 | 假 API 補四個方法 |

---

### Task 1: 網址列輸入正規化

**Files:**
- Create: `src/shared/browser-url.ts`
- Test: `tests/browser-url.test.ts`

**Interfaces:**
- Produces: `normalizeBrowserInput(raw: string): BrowserInput`,`type BrowserInput = { kind: 'empty' } | { kind: 'url'; url: string } | { kind: 'not-url' }`

`localhost:3000` 看起來像「協定是 localhost」,所以本機位址的判斷必須排在協定判斷之前;`example.com:8080` 同理,協定判斷只認 `://` 形式與一份固定清單。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/browser-url.test.ts
import { describe, expect, it } from 'vitest'
import { normalizeBrowserInput } from '../src/shared/browser-url.js'

describe('網址列輸入正規化', () => {
  it('空白回 empty', () => {
    expect(normalizeBrowserInput('   ')).toEqual({ kind: 'empty' })
  })

  it('已有協定的原樣往下,只去頭尾空白', () => {
    expect(normalizeBrowserInput(' https://a.test/x ')).toEqual({ kind: 'url', url: 'https://a.test/x' })
    expect(normalizeBrowserInput('file:///tmp/a.html')).toEqual({ kind: 'url', url: 'file:///tmp/a.html' })
  })

  it('沒有 // 的已知協定也原樣往下,交給白名單擋', () => {
    expect(normalizeBrowserInput('javascript:alert(1)')).toEqual({ kind: 'url', url: 'javascript:alert(1)' })
    expect(normalizeBrowserInput('about:blank')).toEqual({ kind: 'url', url: 'about:blank' })
  })

  it('本機位址補 http://', () => {
    expect(normalizeBrowserInput('localhost:3000/path')).toEqual({ kind: 'url', url: 'http://localhost:3000/path' })
    expect(normalizeBrowserInput('127.0.0.1:5173')).toEqual({ kind: 'url', url: 'http://127.0.0.1:5173' })
    expect(normalizeBrowserInput('[::1]:8080')).toEqual({ kind: 'url', url: 'http://[::1]:8080' })
    expect(normalizeBrowserInput('localhost')).toEqual({ kind: 'url', url: 'http://localhost' })
  })

  it('含點且沒有空白的補 https://,帶 port 也一樣', () => {
    expect(normalizeBrowserInput('example.com')).toEqual({ kind: 'url', url: 'https://example.com' })
    expect(normalizeBrowserInput('example.com:8080/a')).toEqual({ kind: 'url', url: 'https://example.com:8080/a' })
  })

  it('其餘不是網址', () => {
    expect(normalizeBrowserInput('hello world')).toEqual({ kind: 'not-url' })
    expect(normalizeBrowserInput('測試機首頁')).toEqual({ kind: 'not-url' })
    expect(normalizeBrowserInput('a. b')).toEqual({ kind: 'not-url' })
  })

  it('localhostx 不算本機位址', () => {
    expect(normalizeBrowserInput('localhostx')).toEqual({ kind: 'not-url' })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/browser-url.test.ts`
Expected: FAIL,找不到 `../src/shared/browser-url.js`

- [ ] **Step 3: 實作**

```ts
// src/shared/browser-url.ts
/** 網址列輸入的正規化(規格 §5.3)。純函式,renderer 顯示錯誤與 main 實際導航共用。 */
export type BrowserInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'not-url' }

/** 要排在協定判斷之前:`localhost:3000` 的形狀跟「協定 localhost」一樣。 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i
const SCHEME_WITH_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i
/** 沒有 `//` 的協定只認這幾個;原樣往下,由 checkNavigateUrl 的白名單決定放不放行。 */
const BARE_SCHEME = /^(about|javascript|data|blob|mailto):/i

export function normalizeBrowserInput(raw: string): BrowserInput {
  const text = raw.trim()
  if (text === '') return { kind: 'empty' }
  if (LOCAL_HOST.test(text)) return { kind: 'url', url: `http://${text}` }
  if (SCHEME_WITH_SLASHES.test(text) || BARE_SCHEME.test(text)) return { kind: 'url', url: text }
  if (text.includes('.') && !/\s/.test(text)) return { kind: 'url', url: `https://${text}` }
  return { kind: 'not-url' }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/browser-url.test.ts`
Expected: PASS,7 個測試

- [ ] **Step 5: Commit**

```bash
git add src/shared/browser-url.ts tests/browser-url.test.ts
git commit -m "feat: normalize address bar input"
```

---

### Task 2: 瀏覽器 IPC 的型別、parser 與 preload

**Files:**
- Create: `src/shared/browser-ipc.ts`
- Modify: `src/shared/ipc.ts`(`IPC` 物件、`YesChefApi` 介面)
- Modify: `src/preload/bridge.ts`
- Modify: `tests/helpers/fake-yeschef.ts`
- Test: `tests/browser-ipc.test.ts`、`tests/preload-bridge.test.ts`

**Interfaces:**
- Produces(`src/shared/browser-ipc.ts`):

```ts
export type BrowserCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' | 'forward' | 'reload' | 'stop' }
export type BrowserCommandResult = { readonly ok: true } | { readonly ok: false; readonly message: string }
export interface BrowserStatePayload {
  readonly conversationId: string; readonly url: string; readonly title: string
  readonly loading: boolean; readonly canGoBack: boolean; readonly canGoForward: boolean
}
export interface BrowserSessionEntry { readonly conversationId: string; readonly busy: boolean }
export interface BrowserSnapshot { readonly states: readonly BrowserStatePayload[]; readonly sessions: readonly BrowserSessionEntry[] }
export function parseBrowserCommand(raw: unknown): BrowserCommand | null
export function parseBrowserCommandResult(raw: unknown): BrowserCommandResult | null
export function parseBrowserState(raw: unknown): BrowserStatePayload | null
export function parseBrowserSessions(raw: unknown): readonly BrowserSessionEntry[] | null
export function parseBrowserSnapshot(raw: unknown): BrowserSnapshot | null
```

- Produces(`IPC`):`browserCommand: 'browser:command'`、`browserState: 'browser:state'`、`browserSessions: 'browser:sessions'`、`browserGet: 'browser:get'`
- Produces(`YesChefApi`):`browserCommand(cmd: BrowserCommand): Promise<BrowserCommandResult>`、`getBrowser(): Promise<BrowserSnapshot>`、`onBrowserState(cb: (s: BrowserStatePayload) => void): Unsubscribe`、`onBrowserSessions(cb: (s: readonly BrowserSessionEntry[]) => void): Unsubscribe`

`browser:get` 規格沒列,是為了 renderer 重新載入後取回目前狀態,做法與既有的 `approvals:get`、`projects:get` 相同。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/browser-ipc.test.ts
import { describe, expect, it } from 'vitest'
import {
  parseBrowserCommand, parseBrowserCommandResult, parseBrowserSessions, parseBrowserSnapshot, parseBrowserState,
} from '../src/shared/browser-ipc.js'

const STATE = { conversationId: 'c1', url: 'https://a.test/', title: 'A', loading: false, canGoBack: true, canGoForward: false }

describe('parseBrowserCommand', () => {
  it('五種 kind 都收', () => {
    expect(parseBrowserCommand({ kind: 'navigate', url: 'a.test' })).toEqual({ kind: 'navigate', url: 'a.test' })
    for (const kind of ['back', 'forward', 'reload', 'stop'] as const) {
      expect(parseBrowserCommand({ kind })).toEqual({ kind })
    }
  })

  it('navigate 缺 url 或 url 不是字串就拒收', () => {
    expect(parseBrowserCommand({ kind: 'navigate' })).toBeNull()
    expect(parseBrowserCommand({ kind: 'navigate', url: 3 })).toBeNull()
  })

  it('多餘欄位不帶過去', () => {
    expect(parseBrowserCommand({ kind: 'back', conversationId: 'x' })).toEqual({ kind: 'back' })
  })

  it('不認得的 kind 與非物件拒收', () => {
    expect(parseBrowserCommand({ kind: 'close' })).toBeNull()
    expect(parseBrowserCommand('back')).toBeNull()
    expect(parseBrowserCommand(null)).toBeNull()
  })

  it('url 超過 8192 字元拒收', () => {
    expect(parseBrowserCommand({ kind: 'navigate', url: 'a'.repeat(8193) })).toBeNull()
  })
})

describe('其餘 parser', () => {
  it('parseBrowserCommandResult', () => {
    expect(parseBrowserCommandResult({ ok: true })).toEqual({ ok: true })
    expect(parseBrowserCommandResult({ ok: false, message: '這不是網址' })).toEqual({ ok: false, message: '這不是網址' })
    expect(parseBrowserCommandResult({ ok: false })).toBeNull()
  })

  it('parseBrowserState 六個欄位缺一不可', () => {
    expect(parseBrowserState(STATE)).toEqual(STATE)
    const { title: _title, ...missing } = STATE
    expect(parseBrowserState(missing)).toBeNull()
    expect(parseBrowserState({ ...STATE, loading: 'no' })).toBeNull()
  })

  it('parseBrowserSessions 收陣列,任一筆壞掉就整包拒收', () => {
    expect(parseBrowserSessions([{ conversationId: 'c1', busy: true }])).toEqual([{ conversationId: 'c1', busy: true }])
    expect(parseBrowserSessions([])).toEqual([])
    expect(parseBrowserSessions([{ conversationId: 'c1' }])).toBeNull()
    expect(parseBrowserSessions({})).toBeNull()
  })

  it('parseBrowserSnapshot', () => {
    expect(parseBrowserSnapshot({ states: [STATE], sessions: [{ conversationId: 'c1', busy: false }] }))
      .toEqual({ states: [STATE], sessions: [{ conversationId: 'c1', busy: false }] })
    expect(parseBrowserSnapshot({ states: [STATE] })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/browser-ipc.test.ts`
Expected: FAIL,找不到 `../src/shared/browser-ipc.js`

- [ ] **Step 3: 實作 `src/shared/browser-ipc.ts`**

```ts
// src/shared/browser-ipc.ts
import { isRecord } from './ipc.js'

export type BrowserCommand =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'back' | 'forward' | 'reload' | 'stop' }

export type BrowserCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export interface BrowserStatePayload {
  readonly conversationId: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

export interface BrowserSessionEntry {
  readonly conversationId: string
  readonly busy: boolean
}

export interface BrowserSnapshot {
  readonly states: readonly BrowserStatePayload[]
  readonly sessions: readonly BrowserSessionEntry[]
}

/** 網址列的輸入上限。超過這個長度的字串不會是人打的網址。 */
export const BROWSER_URL_MAX_LENGTH = 8192
const SIMPLE_KINDS = ['back', 'forward', 'reload', 'stop'] as const

export function parseBrowserCommand(raw: unknown): BrowserCommand | null {
  if (!isRecord(raw)) return null
  const kind = raw['kind']
  if (kind === 'navigate') {
    const url = raw['url']
    if (typeof url !== 'string' || url.length > BROWSER_URL_MAX_LENGTH) return null
    return { kind, url }
  }
  const simple = SIMPLE_KINDS.find((k) => k === kind)
  return simple === undefined ? null : { kind: simple }
}

export function parseBrowserCommandResult(raw: unknown): BrowserCommandResult | null {
  if (!isRecord(raw)) return null
  if (raw['ok'] === true) return { ok: true }
  const message = raw['message']
  return raw['ok'] === false && typeof message === 'string' ? { ok: false, message } : null
}

export function parseBrowserState(raw: unknown): BrowserStatePayload | null {
  if (!isRecord(raw)) return null
  const { conversationId, url, title, loading, canGoBack, canGoForward } = raw
  if (typeof conversationId !== 'string' || typeof url !== 'string' || typeof title !== 'string') return null
  if (typeof loading !== 'boolean' || typeof canGoBack !== 'boolean' || typeof canGoForward !== 'boolean') return null
  return { conversationId, url, title, loading, canGoBack, canGoForward }
}

function parseSessionEntry(raw: unknown): BrowserSessionEntry | null {
  if (!isRecord(raw)) return null
  const { conversationId, busy } = raw
  return typeof conversationId === 'string' && typeof busy === 'boolean' ? { conversationId, busy } : null
}

function parseAll<T>(raw: unknown, parse: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(raw)) return null
  const parsed = raw.map(parse)
  return parsed.every((item): item is T => item !== null) ? parsed : null
}

export function parseBrowserSessions(raw: unknown): readonly BrowserSessionEntry[] | null {
  return parseAll(raw, parseSessionEntry)
}

export function parseBrowserSnapshot(raw: unknown): BrowserSnapshot | null {
  if (!isRecord(raw)) return null
  const states = parseAll(raw['states'], parseBrowserState)
  const sessions = parseBrowserSessions(raw['sessions'])
  return states === null || sessions === null ? null : { states, sessions }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/browser-ipc.test.ts`
Expected: PASS

- [ ] **Step 5: `src/shared/ipc.ts` 加頻道名與 API 方法**

在 `IPC` 物件的 `browserBounds: 'layout:browser-bounds',` 後面加:

```ts
  /** renderer → main(invoke):網址列的指令,作用在前景對話的瀏覽器。 */
  browserCommand: 'browser:command',
  /** main → renderer:某個對話的瀏覽器狀態變了。 */
  browserState: 'browser:state',
  /** main → renderer:哪些對話有瀏覽器、哪些正在被工具操作。 */
  browserSessions: 'browser:sessions',
  /** renderer → main(invoke):renderer 重新載入後取回目前全部狀態。 */
  browserGet: 'browser:get',
```

檔案開頭的 import 區加:

```ts
import type { BrowserCommand, BrowserCommandResult, BrowserSessionEntry, BrowserSnapshot, BrowserStatePayload } from './browser-ipc.js'
```

`browser-ipc.ts` 只從 `ipc.ts` 拿 `isRecord` 這個執行期的值,`ipc.ts` 只從 `browser-ipc.ts` 拿型別(`import type` 編譯後消失),不構成執行期的循環相依。

在 `YesChefApi` 介面的 `setBrowserBounds(rect: RectPayload | null): void` 後面加:

```ts
  browserCommand(command: BrowserCommand): Promise<BrowserCommandResult>
  getBrowser(): Promise<BrowserSnapshot>
  onBrowserState(cb: (state: BrowserStatePayload) => void): Unsubscribe
  onBrowserSessions(cb: (sessions: readonly BrowserSessionEntry[]) => void): Unsubscribe
```

- [ ] **Step 6: 寫 preload 的失敗測試**

先讀 `tests/preload-bridge.test.ts` 開頭,沿用它 mock `electron` 的 `ipcRenderer`(`invoke`、`send`、`on`、`removeListener`)與取得 `api` 的方式,在檔尾加一個 describe:

```ts
describe('瀏覽器 IPC', () => {
  it('browserCommand 只送 kind 與 url,回傳值過 parser', async () => {
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: false, message: '這不是網址' })
    const dirty = { kind: 'navigate', url: 'hello world', extra: 1 } as never
    await expect(api.browserCommand(dirty)).resolves.toEqual({ ok: false, message: '這不是網址' })
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('browser:command', { kind: 'navigate', url: 'hello world' })
  })

  it('browserCommand 回傳形狀不符就 reject', async () => {
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: 'yes' })
    await expect(api.browserCommand({ kind: 'back' })).rejects.toThrow('browser:command 回傳的形狀不符')
  })

  it('onBrowserState 丟掉形狀不符的 payload', () => {
    const seen: unknown[] = []
    api.onBrowserState((s) => { seen.push(s) })
    const listener = ipcRenderer.on.mock.calls.find(([ch]) => ch === 'browser:state')?.[1] as (e: unknown, raw: unknown) => void
    listener({}, { conversationId: 'c1' })
    listener({}, { conversationId: 'c1', url: 'u', title: 't', loading: false, canGoBack: false, canGoForward: false })
    expect(seen).toHaveLength(1)
  })
})
```

`ipcRenderer` 與 `api` 的變數名以該測試檔現有的為準;名稱不同時只改這三個測試裡的引用,斷言內容不變。

Run: `npx vitest run tests/preload-bridge.test.ts`
Expected: FAIL,`api.browserCommand is not a function`

- [ ] **Step 7: 實作 preload**

`src/preload/bridge.ts` 的 import 區加:

```ts
import {
  parseBrowserCommandResult, parseBrowserSessions, parseBrowserSnapshot, parseBrowserState, type BrowserCommand,
} from '../shared/browser-ipc.js'
```

在 `api` 物件的 `setBrowserBounds` 後面加:

```ts
  browserCommand: (command) => {
    // 只把已知欄位送過去:renderer 物件上多出來的東西不該進主行程。
    const clean: BrowserCommand = command.kind === 'navigate' ? { kind: 'navigate', url: command.url } : { kind: command.kind }
    return invokeParsed(IPC.browserCommand, clean, parseBrowserCommandResult, 'browser:command 回傳的形狀不符')
  },
  getBrowser: () => invokeParsed(IPC.browserGet, undefined, parseBrowserSnapshot, 'browser:get 回傳的形狀不符'),
  onBrowserState: (cb) => subscribe(IPC.browserState, parseBrowserState, cb),
  onBrowserSessions: (cb) => subscribe(IPC.browserSessions, parseBrowserSessions, cb),
```

- [ ] **Step 8: 假 API 補四個方法**

`tests/helpers/fake-yeschef.ts`:照檔案裡 `onProjects: on(projectListeners)` 的寫法,加兩組 listener 陣列 `browserStateListeners`、`browserSessionsListeners`,並在回傳的物件上提供 `emitBrowserState(state)`、`emitBrowserSessions(list)`(照現有 `emitProjects` 的寫法)。API 物件加:

```ts
    browserCommand: (command) => {
      calls.push(`browserCommand:${JSON.stringify(command)}`)
      return Promise.resolve(browserCommandResult)
    },
    getBrowser: () => Promise.resolve({ states: [], sessions: [] }),
    onBrowserState: on(browserStateListeners),
    onBrowserSessions: on(browserSessionsListeners),
```

`browserCommandResult` 是 helper 內的 `let browserCommandResult: BrowserCommandResult = { ok: true }`,並提供 `setBrowserCommandResult(next)` 讓測試換掉。

- [ ] **Step 9: 跑測試與型別檢查**

Run: `npx vitest run tests/browser-ipc.test.ts tests/preload-bridge.test.ts && npm run typecheck`
Expected: 全部 PASS,typecheck 沒有錯誤

- [ ] **Step 10: Commit**

```bash
git add src/shared/browser-ipc.ts src/shared/ipc.ts src/preload/bridge.ts tests/browser-ipc.test.ts tests/preload-bridge.test.ts tests/helpers/fake-yeschef.ts
git commit -m "feat: add browser command and state IPC contracts"
```

---

### Task 3: 每個對話分頁記自己的 lastUrl

**Files:**
- Modify: `src/shared/projects.ts`(`TabEntry`、`isTabEntry`)
- Modify: `src/main/projects-schema.ts`(`tabSchema`)
- Modify: `src/main/projects-state.ts`
- Test: `tests/projects-state.test.ts`、`tests/projects-shared.test.ts`、`tests/projects-store.test.ts`

**Interfaces:**
- Produces:`TabEntry.lastUrl?: string | null`
- Produces(`projects-state.ts`):`setTabLastUrl(state: ProjectsState, tabId: string, url: string): ProjectsState`、`tabLastUrl(project: ProjectEntry, tabId: string): string | null`

`tabLastUrl` 的繼承規則(規格 §4.6):分頁有自己的 `lastUrl`(含 `null`)就用它;沒有(`undefined`)時,只有專案裡 `sortOrder` 最小的對話分頁拿專案層級的 `lastUrl`,其他分頁回 `null`。

- [ ] **Step 1: 寫失敗的測試**

在 `tests/projects-state.test.ts` 檔尾加(`project()`、`tab()` 這類建測試資料的 helper 以該檔現有的為準;沒有的話用下面的 `entry`):

```ts
import { setTabLastUrl, tabLastUrl } from '../src/main/projects-state.js'
import type { ProjectEntry, ProjectsState, TabEntry } from '../src/shared/projects.js'
import { PROJECTS_SCHEMA_VERSION } from '../src/shared/projects.js'

function convTab(id: string, sortOrder: number, extra: Partial<TabEntry> = {}): TabEntry {
  return { id, contentType: 'conversation', label: id, customLabel: null, sortOrder, lastFocusedAt: 0, threadId: `t-${id}`, ...extra }
}
function entry(tabs: readonly TabEntry[], lastUrl: string | null): ProjectEntry {
  return { id: 'p1', rootPath: '/p1', name: 'p1', addedAt: 0, lastOpenedAt: 0, tabs, lastUrl, threads: [] }
}
function stateOf(p: ProjectEntry): ProjectsState {
  return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [p], activeId: p.id, openIdsOnShutdown: [] }
}

describe('每個對話的 lastUrl', () => {
  it('setTabLastUrl 只改那個分頁,回傳新狀態,不動原本的', () => {
    const before = stateOf(entry([convTab('a', 0), convTab('b', 1)], null))
    const after = setTabLastUrl(before, 'b', 'https://b.test/')
    expect(after.projects[0]?.tabs.map((t) => t.lastUrl)).toEqual([undefined, 'https://b.test/'])
    expect(before.projects[0]?.tabs[1]?.lastUrl).toBeUndefined()
  })

  it('值沒變就回傳同一個物件,不觸發多餘的存檔', () => {
    const before = stateOf(entry([convTab('a', 0, { lastUrl: 'https://a.test/' })], null))
    expect(setTabLastUrl(before, 'a', 'https://a.test/')).toBe(before)
  })

  it('找不到分頁就原樣回傳', () => {
    const before = stateOf(entry([convTab('a', 0)], null))
    expect(setTabLastUrl(before, 'zzz', 'https://a.test/')).toBe(before)
  })

  it('tabLastUrl:自己有值用自己的', () => {
    const p = entry([convTab('a', 0, { lastUrl: 'https://a.test/' })], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBe('https://a.test/')
  })

  it('tabLastUrl:沒有自己的值時,只有 sortOrder 最小的對話分頁繼承專案層級的值', () => {
    const p = entry([convTab('b', 5), convTab('a', 2)], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBe('https://old.test/')
    expect(tabLastUrl(p, 'b')).toBeNull()
  })

  it('tabLastUrl:終端分頁不算,不會搶走繼承', () => {
    const term: TabEntry = { id: 't', contentType: 'terminal', label: 't', customLabel: null, sortOrder: 0, lastFocusedAt: 0 }
    const p = entry([term, convTab('a', 1)], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBe('https://old.test/')
  })

  it('tabLastUrl:自己的值是 null 就是 null,不往上繼承', () => {
    const p = entry([convTab('a', 0, { lastUrl: null })], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBeNull()
  })
})
```

在 `tests/projects-store.test.ts` 加一個向下相容的測試(沿用該檔寫暫存狀態檔再 `load` 的 helper;若該檔是直接測 `parseProjectsState`,就改成對它斷言):

```ts
it('沒有 lastUrl 欄位的舊分頁照常讀得進來,有的也保留', () => {
  const oldTab = { id: 'a', contentType: 'conversation', label: 'a', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 't1' }
  const newTab = { ...oldTab, id: 'b', threadId: 't2', lastUrl: 'https://b.test/' }
  const raw = {
    schemaVersion: PROJECTS_SCHEMA_VERSION,
    projects: [{ id: 'p', rootPath: '/p', name: 'p', addedAt: 0, lastOpenedAt: 0, tabs: [oldTab, newTab], lastUrl: null,
      threads: [{ id: 't1', sessions: [], handoffVersion: 0, switchPhase: 'idle', createdAt: 0 }, { id: 't2', sessions: [], handoffVersion: 0, switchPhase: 'idle', createdAt: 0 }] }],
    activeId: 'p', openIdsOnShutdown: [],
  }
  const parsed = parseProjectsState(raw)
  expect(parsed?.projects[0]?.tabs.map((t) => t.lastUrl)).toEqual([undefined, 'https://b.test/'])
})
```

`switchPhase` 的合法值以 `projects-schema.ts` 的 `switchPhaseSchema` 為準;`'idle'` 不在其中的話換成 enum 的第一個值。

在 `tests/projects-shared.test.ts` 加(`parseProjectsView` 的完整合法輸入沿用該檔現有的 fixture,只改 tabs):

```ts
it('isTabEntry 收 lastUrl 是字串或 null,其他型別拒收', () => {
  expect(parseProjectsView(viewWithTab({ lastUrl: 'https://a.test/' }))).not.toBeNull()
  expect(parseProjectsView(viewWithTab({ lastUrl: null }))).not.toBeNull()
  expect(parseProjectsView(viewWithTab({ lastUrl: 3 }))).toBeNull()
})
```

`viewWithTab(extra)` 是在該檔新增的小 helper:拿現有的合法 view fixture,把第一個專案第一個分頁換成 `{ ...原分頁, ...extra }`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-state.test.ts tests/projects-store.test.ts tests/projects-shared.test.ts`
Expected: FAIL,`setTabLastUrl` 不存在;`lastUrl: 3` 那一筆目前會通過

- [ ] **Step 3: 實作**

`src/shared/projects.ts` 的 `TabEntry` 介面,在 `provider?: Provider` 後面加:

```ts
  /** 這個對話的瀏覽器最後停在哪(每對話瀏覽器規格 §4.6)。undefined 表示從沒記過,見 projects-state 的 tabLastUrl。 */
  readonly lastUrl?: string | null
```

同檔的 `isTabEntry`,在既有條件串的最後加一項:

```ts
    (raw['lastUrl'] === undefined || raw['lastUrl'] === null || typeof raw['lastUrl'] === 'string')
```

`src/main/projects-schema.ts` 的 `tabSchema`,在 `provider: providerSchema.optional(),` 後面加:

```ts
  lastUrl: z.string().nullable().optional(),
```

`src/main/projects-state.ts`,放在 `setLastUrl` 後面:

```ts
/** 每對話瀏覽器規格 §4.6。值沒變回傳同一個 state,service 才不會多排一次存檔。 */
export function setTabLastUrl(state: ProjectsState, tabId: string, url: string): ProjectsState {
  const owner = findProjectByTab(state, tabId)
  if (owner === undefined) return state
  if (owner.tabs.some((t) => t.id === tabId && t.lastUrl === url)) return state
  return updateProject(state, owner.id, (p) => ({
    ...p,
    tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, lastUrl: url } : t)),
  }))
}

/**
 * 分頁自己的 lastUrl;從沒記過時,只有 sortOrder 最小的對話分頁繼承專案層級的舊值。
 * 專案層級的欄位是單一瀏覽器時期留下的,不再寫入。
 */
export function tabLastUrl(project: ProjectEntry, tabId: string): string | null {
  const tab = project.tabs.find((t) => t.id === tabId)
  if (tab === undefined) return null
  if (tab.lastUrl !== undefined) return tab.lastUrl
  const first = conversationTabs(project).reduce<TabEntry | undefined>(
    (acc, t) => (acc === undefined || t.sortOrder < acc.sortOrder ? t : acc),
    undefined
  )
  return first?.id === tabId ? project.lastUrl : null
}
```

`updateProject`、`findProjectByTab`、`conversationTabs` 都已經在這個檔案裡。`TabEntry` 若還沒被這個檔 import,加進既有的 `import type { ... } from '../shared/projects.js'`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/projects-state.test.ts tests/projects-store.test.ts tests/projects-shared.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/projects.ts src/main/projects-schema.ts src/main/projects-state.ts tests/projects-state.test.ts tests/projects-store.test.ts tests/projects-shared.test.ts
git commit -m "feat: remember last browser url per conversation tab"
```

---
### Task 4: view tools 拆成「每個 session 的工具」與「每個對話的 MCP server」

**Files:**
- Modify: `src/main/view-tools/server.ts`
- Create: `src/main/view-tools/conversation-server.ts`
- Modify: `src/main/view-tools/startup.ts`、`src/main/view-tools/controller-types.ts:21`、`src/main/view-tools/controller-page.ts:26`
- Modify: `src/main/view-tools/errors.ts`
- Modify: `src/main/conversation.ts:30`
- Test: `tests/view-tools/server.test.ts`、`tests/view-tools/conversation-server.test.ts`(新)、`tests/view-tools/startup.test.ts`

**Interfaces:**
- Produces(`server.ts`):

```ts
export interface ViewToolDeps {
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly clock: MergerClock
  /** 這個 session 所屬專案的 rootPath。對話已不在任何專案裡時丟 ViewToolError(MSG.sessionEnded)。 */
  readonly projectDir: () => string
  readonly logError: (error: Error) => void
  /** 進行中的工具呼叫從 0 變 1、從 1 變 0 時各叫一次。 */
  readonly onBusyChange?: (busy: boolean) => void
}
export interface ViewTools {
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
  busy(): boolean
  dispose(): Promise<void>
}
export function createViewToolServer(deps: ViewToolDeps): Promise<ViewTools>
```

- Produces(`conversation-server.ts`):

```ts
export interface ConversationViewServerDeps {
  /** 取得這個對話的 ViewTools;第一次呼叫時才建 view 與 CDP。失敗就 reject。 */
  readonly resolve: () => Promise<ViewTools>
  readonly peer?: PeerTools
  readonly logError: (error: Error) => void
}
export interface ConversationViewServer {
  readonly server: McpSdkServerConfigWithInstance
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  dispose(): void
}
export function createConversationViewServer(deps: ConversationViewServerDeps): ConversationViewServer
```

- Produces(`conversation.ts`):

```ts
export interface ViewToolHooks {
  autoAllow(toolName: string, toolUseId: string): boolean
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
}
```

- Produces(`errors.ts`):`MSG.browserUnavailable = '這個對話的瀏覽器無法啟動，請再試一次'`、`MSG.notUrl = '這不是網址'`;`MSG.browserBusy` 這個 Task 先留著,Task 7 刪。

原本 `forProject(isActive, peer)` 同時做三件事:前景守衛、每個對話的 inflight、每個對話的 MCP server。現在每個 session 只服務一個對話,inflight 直接屬於 `ViewTools`;MCP server 搬到 `conversation-server.ts`,因為它必須在 view 存在之前就建立。

- [ ] **Step 1: 改名 `activeProjectDir` → `projectDir`**

四個位置,只改名字,不改行為:

- `src/main/view-tools/controller-types.ts:21`:`readonly activeProjectDir: () => string` → `readonly projectDir: () => string`
- `src/main/view-tools/controller-page.ts:26`:`checkNavigateUrl(url, deps.activeProjectDir())` → `checkNavigateUrl(url, deps.projectDir())`
- `src/main/view-tools/startup.ts:16` 與 `:86`:介面欄位與傳遞處都改成 `projectDir`;並在 `ViewToolStartupDeps` 加 `readonly onBusyChange?: (busy: boolean) => void`,在呼叫 `deps.create({...})` 的物件裡加 `...(deps.onBusyChange === undefined ? {} : { onBusyChange: deps.onBusyChange }),`
- `src/main/view-tools/server.ts`:`ViewToolDeps` 的欄位與 `createViewController({...})` 裡的 `activeProjectDir: deps.activeProjectDir` → `projectDir: deps.projectDir`

再用 grep 確認測試檔:`grep -rn activeProjectDir tests src/main/view-tools`,測試裡出現的也一起改名。`src/main/index.ts` 與 `src/main/ipc-bridge.ts` 裡的 `activeProjectDir` 是另一個函式,這一步不要動。

Run: `npm run typecheck`
Expected: 只剩 `src/main/index.ts` 傳給 `startViewTools` 的那一處報錯(Task 7 會整段換掉)。先在那一處把 `activeProjectDir,` 改成 `projectDir: activeProjectDir,` 讓型別檢查通過。

- [ ] **Step 2: 加錯誤訊息**

`src/main/view-tools/errors.ts` 的 `MSG`,在 `browserBusy` 那一行後面加:

```ts
  browserUnavailable: '這個對話的瀏覽器無法啟動，請再試一次',
  notUrl: '這不是網址',
```

- [ ] **Step 3: 改寫 `server.test.ts` 的 helper,並刪掉前景守衛的測試**

`tests/view-tools/server.test.ts`:

1. import 改成 `import { createViewToolServer, type ViewTools } from '../../src/main/view-tools/server.js'`,另外加 `import { createConversationViewServer, type ConversationViewServer } from '../../src/main/view-tools/conversation-server.js'`。
2. 刪掉 `let active: boolean` 與 `beforeEach` 裡的 `active = true`。`let project: ProjectViewTools` 改成 `let project: ConversationViewServer`。加一個 `let busyChanges: boolean[]`,`beforeEach` 裡設成 `[]`。
3. `build()` 換成:

```ts
/** 建一個 session 的工具,並替它的對話建一份 MCP server;shared.serverOptions 之後就是這一份的內容。 */
async function build(peer?: PeerTools): Promise<ViewTools> {
  const tools = await createViewToolServer({
    view: { webContents } as unknown as WebContentsView,
    cdp,
    clock: testClock.clock,
    projectDir: () => '/專案',
    logError,
    onBusyChange: (busy) => { busyChanges.push(busy) },
  })
  project = createConversationViewServer({ resolve: () => Promise.resolve(tools), logError, ...(peer === undefined ? {} : { peer }) })
  return tools
}
```

   原本呼叫 `tools.forProject(() => active, peer)` 來掛同伴工具的測試,改成 `await build(peer)`。

4. 整個刪掉這五個測試(它們測的是被移除的前景守衛):
   - `isActive 回 false 時八個工具都回 browserBusy，不呼叫 controller 也不 logError`
   - `背景時被擋下的呼叫沒有進 inflight：之後 abortPending 只中止真正進行中的那一筆`
   - `背景對話也能用:isActive 是 false 時不回 browserBusy`
   - `背景回答傳遞 id 與 text，不讀前景守衛`
   - `非前景回 browserBusy,連 controller 都不呼叫`
   連同只被它們用到的 `BUSY_ARGS` 常數一起刪。
5. 這三個測試改寫:
   - `forProject 每次各建一個 server 實例，工具 handler 不共用` → 刪掉(一個 session 只有一個對話)。
   - `專案的 abortPending 只中止自己的呼叫，共用的 abortPending 中止全部` → 改名 `abortPending 中止這個 session 全部進行中的呼叫`,內容只留「兩個進行中的呼叫,`tools.abortPending('原因')` 後兩個 signal 都 aborted」。
   - `專案 dispose 以 sessionEnded 中止自己的呼叫`、`dispose 過的專案就算還是前景也回 sessionEnded…`、`dispose 之後回 sessionEnded` → 把 `project.dispose()` 保留(它現在是 `ConversationViewServer.dispose()`),斷言不變:之後的呼叫回 `MSG.sessionEnded`、不呼叫 controller。「中止進行中的呼叫」那一段改成呼叫 `await tools.dispose()`。
6. 其餘用到 `project.invoke(...)` 或 `call(...)` 的測試不用改:`ConversationViewServer` 有同名的 `invoke`。
7. 用到 `tools.autoAllow` 的測試 `autoAllow 只看 policy：view_eval 與未知名稱不放行` 刪掉,`policy.ts` 自己的測試已經涵蓋。
8. 檔尾加 busy 通知的測試:

```ts
describe('busy 通知', () => {
  it('第一筆呼叫開始時通知 true,最後一筆結束時通知 false,中間不重複通知', async () => {
    const tools = await build()
    let release: (v: ToolOutput) => void = () => {}
    ctrl('snapshot').mockImplementationOnce(() => new Promise<ToolOutput>((resolve) => { release = resolve }))
    const slow = tools.invoke('view_snapshot', {}, { callId: 'a' })
    await tools.invoke('view_press', { key: 'Tab' }, { callId: 'b' })
    expect(busyChanges).toEqual([true])
    expect(tools.busy()).toBe(true)
    release(OK_TEXT)
    await slow
    expect(busyChanges).toEqual([true, false])
    expect(tools.busy()).toBe(false)
  })
})
```

Run: `npx vitest run tests/view-tools/server.test.ts`
Expected: FAIL,找不到 `conversation-server.js`

- [ ] **Step 4: 改 `server.ts`**

1. `ViewToolDeps` 照 Interfaces 區塊改(`projectDir`、`onBusyChange`)。
2. 刪掉 `ProjectViewTools` 介面,`ViewTools` 介面照 Interfaces 區塊改。
3. `Inflight` 與 `ToolRuntime`:

```ts
interface Inflight {
  calls: readonly { readonly controller: AbortController; readonly handoff: boolean }[]
}

interface ToolRuntime {
  readonly controller: ViewController
  readonly inflight: Inflight
  readonly isDisposed: () => boolean
  readonly logError: (error: Error) => void
  readonly onBusyChange: (busy: boolean) => void
}
```

4. `invokeTool` 換成(刪掉 `isActive` 那一行,加 busy 通知):

```ts
/**
 * 後端無關的入口(codex view tools 規格 §4.1)。登記 inflight、合併 signal、
 * 把任何結果或例外轉成 ViewToolInvocation。永不 reject。
 */
async function invokeTool(runtime: ToolRuntime, name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation> {
  if (runtime.isDisposed()) return { ok: false, text: MSG.sessionEnded }
  const def = viewToolDef(name)
  if (def === undefined) return { ok: false, text: MSG.unknownTool(name) }
  const own = new AbortController()
  setCalls(runtime, [...runtime.inflight.calls, { controller: own, handoff: name === 'request_handoff' }])
  try {
    // 裁決 19:自己的中止與外面(MCP 的 extra.signal)的中止都要能停掉等待。
    const signal = ctx.signal === undefined ? own.signal : AbortSignal.any([own.signal, ctx.signal])
    return { ok: true, output: await def.run(runtime.controller, args, { callId: ctx.callId }, signal) }
  } catch (error) {
    return { ok: false, text: toErrorText(error, runtime.logError) }
  } finally {
    setCalls(runtime, runtime.inflight.calls.filter((call) => call.controller !== own))
  }
}

/** inflight 只從這裡改,0 與非 0 之間切換時才通知。 */
function setCalls(runtime: ToolRuntime, next: Inflight['calls']): void {
  const wasBusy = runtime.inflight.calls.length > 0
  runtime.inflight.calls = next
  const isBusy = next.length > 0
  if (wasBusy !== isBusy) runtime.onBusyChange(isBusy)
}
```

   `abortAll` 裡直接指定 `inflight.calls = ...` 的那一行,改成收 `runtime` 並呼叫 `setCalls(runtime, ...)`,函式簽名變成 `abortAll(runtime: ToolRuntime, reason: string, disposing = false)`。

5. `toErrorText` 加上 `export`(conversation-server 要用)。把 `toCallToolResult`、`errorResult`、`extraSignal`、`runPeerTool`、`createPeerTools`、`createTools`、`PEER_TOOL_DESCRIPTIONS`、`SERVER_VERSION`、`TOOL_CALL_TIMEOUT_MS` 整段剪下,留給 Step 5 貼到新檔。`server.ts` 不再 import `createSdkMcpServer`、`tool`、`PeerError`、`PEER_MSG`、`PeerTools`、`CallToolResult`、`z`。
6. `createViewToolServer` 的後半段(從 `/** 每個對話一份 inflight 登錄…` 到 `return {…}`)換成:

```ts
    let disposed = false
    const runtime: ToolRuntime = {
      controller,
      inflight: { calls: [] },
      isDisposed: () => disposed,
      logError: deps.logError,
      onBusyChange: deps.onBusyChange ?? (() => {}),
    }
    return {
      invoke: (name, args, ctx) => invokeTool(runtime, name, args, ctx),
      handoffDone: (toolUseId) => { handoff.done(toolUseId) },
      abortPending: (reason) => { abortAll(runtime, reason) },
      busy: () => runtime.inflight.calls.length > 0,
      dispose: async () => {
        disposed = true
        abortAll(runtime, MSG.sessionEnded, true)
        activeWatcher.dispose()
        settle.dispose()
        handoff.abortAll()
      },
    }
```

   檔頭那段說明 `forProject` 的註解改成:「組裝一個 session 的工具:watcher、settle、handoff、controller 各一份,跟著這個 session 的 view。MCP server 在 conversation-server.ts。」

- [ ] **Step 5: 建 `conversation-server.ts`**

```ts
// src/main/view-tools/conversation-server.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { PEER_MSG, PeerError } from '../peer/errors.js'
import type { PeerTools } from '../peer/service.js'
import { VIEW_TOOL_SERVER_NAME } from '../../shared/view-tools.js'
import { MSG } from './errors.js'
import { HANDOFF_TIMEOUT_MS, readToolUseId } from './handoff.js'
import { toErrorText, type ViewTools } from './server.js'
import { VIEW_TOOL_DEFS, type InvokeContext, type ViewToolInvocation } from './tool-defs.js'

export interface ConversationViewServerDeps {
  /** 取得這個對話的 ViewTools;第一次呼叫時才建 view 與 CDP(每對話瀏覽器規格 §4.3)。失敗就 reject。 */
  readonly resolve: () => Promise<ViewTools>
  /** 給了就多掛 ask_peer 與 answer_peer;那兩個不需要瀏覽器,不會觸發 resolve。 */
  readonly peer?: PeerTools
  readonly logError: (error: Error) => void
}

export interface ConversationViewServer {
  readonly server: McpSdkServerConfigWithInstance
  /** Claude 與 codex 兩個殼共用的入口。永不 reject。 */
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  /** 之後的呼叫一律回 sessionEnded。session 本身由 browser-sessions 收。 */
  dispose(): void
}

const SERVER_VERSION = '0.1.0'
/**
 * 工具呼叫上限(裁決 32)。SDK 預設讀 MCP_TOOL_TIMEOUT 環境變數,明寫成 11 分鐘,
 * request_handoff 的 10 分鐘等待才不會被環境設定砍掉。
 */
const TOOL_CALL_TIMEOUT_MS = HANDOFF_TIMEOUT_MS + 60_000
```

   接著把 Step 4 剪下的 `PEER_TOOL_DESCRIPTIONS`、`toCallToolResult`、`errorResult`、`extraSignal`、`runPeerTool`、`createPeerTools`、`createTools` 原樣貼上,然後:

```ts
export function createConversationViewServer(deps: ConversationViewServerDeps): ConversationViewServer {
  let disposed = false
  const invoke = async (name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation> => {
    if (disposed) return { ok: false, text: MSG.sessionEnded }
    let tools: ViewTools
    try {
      tools = await deps.resolve()
    } catch (error) {
      deps.logError(error instanceof Error ? error : new Error(String(error)))
      return { ok: false, text: MSG.browserUnavailable }
    }
    // resolve 期間對話可能被關掉。
    if (disposed) return { ok: false, text: MSG.sessionEnded }
    return tools.invoke(name, args, ctx)
  }
  const server = createSdkMcpServer({
    name: VIEW_TOOL_SERVER_NAME,
    version: SERVER_VERSION,
    tools: [
      ...createTools(invoke),
      ...(deps.peer === undefined ? [] : createPeerTools(deps.peer, deps.logError)),
    ],
    timeout: TOOL_CALL_TIMEOUT_MS,
  })
  return { server, invoke, dispose: () => { disposed = true } }
}
```

- [ ] **Step 6: 寫 `conversation-server.test.ts`**

```ts
// tests/view-tools/conversation-server.test.ts
import { describe, expect, it, vi } from 'vitest'
import { MSG } from '../../src/main/view-tools/errors.js'
import { createConversationViewServer } from '../../src/main/view-tools/conversation-server.js'
import type { ViewTools } from '../../src/main/view-tools/server.js'

function fakeTools(): ViewTools & { invoke: ReturnType<typeof vi.fn> } {
  return {
    invoke: vi.fn(() => Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: '好了' } })),
    handoffDone: vi.fn(), abortPending: vi.fn(), busy: () => false, dispose: () => Promise.resolve(),
  }
}

describe('每個對話的 view server', () => {
  it('建立時不呼叫 resolve;第一次 invoke 才呼叫', async () => {
    const tools = fakeTools()
    const resolve = vi.fn(() => Promise.resolve(tools))
    const server = createConversationViewServer({ resolve, logError: vi.fn() })
    expect(resolve).not.toHaveBeenCalled()
    await server.invoke('view_snapshot', {}, { callId: 'a' })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(tools.invoke).toHaveBeenCalledWith('view_snapshot', {}, { callId: 'a' })
  })

  it('resolve 失敗回 browserUnavailable 並記錯;下一次呼叫會再試', async () => {
    const tools = fakeTools()
    const logError = vi.fn()
    const resolve = vi.fn<() => Promise<ViewTools>>()
      .mockRejectedValueOnce(new Error('CDP 附著逾時'))
      .mockResolvedValueOnce(tools)
    const server = createConversationViewServer({ resolve, logError })
    await expect(server.invoke('view_snapshot', {}, { callId: 'a' })).resolves.toEqual({ ok: false, text: MSG.browserUnavailable })
    expect(logError).toHaveBeenCalledTimes(1)
    await expect(server.invoke('view_snapshot', {}, { callId: 'b' })).resolves.toMatchObject({ ok: true })
  })

  it('dispose 之後不呼叫 resolve,直接回 sessionEnded', async () => {
    const resolve = vi.fn(() => Promise.resolve(fakeTools()))
    const server = createConversationViewServer({ resolve, logError: vi.fn() })
    server.dispose()
    await expect(server.invoke('view_snapshot', {}, { callId: 'a' })).resolves.toEqual({ ok: false, text: MSG.sessionEnded })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolve 還沒回來對話就被關掉:回 sessionEnded,不把呼叫交給工具', async () => {
    const tools = fakeTools()
    let release: (t: ViewTools) => void = () => {}
    const server = createConversationViewServer({
      resolve: () => new Promise<ViewTools>((r) => { release = r }), logError: vi.fn(),
    })
    const pending = server.invoke('view_snapshot', {}, { callId: 'a' })
    server.dispose()
    release(tools)
    await expect(pending).resolves.toEqual({ ok: false, text: MSG.sessionEnded })
    expect(tools.invoke).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 7: `conversation.ts` 的 `ViewToolHooks` 改成獨立介面**

`src/main/conversation.ts:30`:

```ts
/** 對話核心需要的右窗格工具那一小片。autoAllow 在瀏覽器建立之前就會被問到,所以不綁在 ViewTools 上。 */
export interface ViewToolHooks {
  autoAllow(toolName: string, toolUseId: string): boolean
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
}
```

該檔若因此不再用到 `ViewTools` 型別,把它從 import 移掉。

- [ ] **Step 8: `startup.test.ts` 改名欄位**

`tests/view-tools/startup.test.ts` 裡的 `activeProjectDir` 全部改成 `projectDir`。加一個測試:

```ts
it('onBusyChange 原樣交給 create', async () => {
  const onBusyChange = vi.fn()
  const create = vi.fn(() => Promise.resolve(fakeViewTools()))
  await startViewTools({ ...baseDeps(), create, onBusyChange })
  expect(create.mock.calls[0]?.[0]).toMatchObject({ onBusyChange })
})
```

`baseDeps()` 與 `fakeViewTools()` 以該檔現有的 helper 為準;`fakeViewTools()` 回傳的物件要改成新的 `ViewTools` 形狀(`invoke`、`handoffDone`、`abortPending`、`busy`、`dispose`)。

- [ ] **Step 9: 跑測試**

Run: `npx vitest run tests/view-tools && npm run typecheck`
Expected: `tests/view-tools` 全部 PASS。typecheck 會在 `src/main/index.ts` 的 `runtimeFor`(用到 `forProject`、`shared.autoAllow`)報錯,這一步先用最小改動讓它編得過:

```ts
    const shared = startup.viewTools
    const own = shared === undefined ? undefined : createConversationViewServer({
      resolve: () => Promise.resolve(shared),
      logError,
      ...(chef?.worker(conversationId) ? {} : { peer: peer.forConversation(conversationId) }),
    })
```

   `viewTools` hooks 改成 `autoAllow: (toolName) => viewToolPolicy(toolName) === 'allow'`、`handoffDone: (id) => shared.handoffDone(id)`、`abortPending: (reason) => shared.abortPending(reason)`;`codexViewTools.invoke` 用 `own.invoke`。import `createConversationViewServer` 與 `viewToolPolicy`。這段是過渡寫法,此時所有對話仍共用一個 view,而且沒有前景守衛;Task 7 換成每對話一份。不要在 Task 4 與 Task 7 之間發版。

Run: `npm test`
Expected: 全部 PASS。`tests/ipc-bridge.test.ts` 若有斷言 `browserBusy` 的測試,留到 Task 7 處理,這裡不應該失敗(bridge 還沒改)。

- [ ] **Step 10: Commit**

```bash
git add src/main/view-tools src/main/conversation.ts src/main/index.ts tests/view-tools
git commit -m "refactor: split view tools into per-session tools and per-conversation MCP server"
```

---

### Task 5: view 轉接物件、partition 參數與 session 登錄表

**Files:**
- Create: `src/main/view-switch.ts`、`src/main/browser-sessions.ts`
- Modify: `src/main/agent-view.ts`
- Test: `tests/view-switch.test.ts`、`tests/browser-sessions.test.ts`

**Interfaces:**
- Consumes:`PlaceableView`(`browser-placement.ts`)、`ViewToolStartup`(`view-tools/startup.ts`:`{ viewTools: ViewTools | undefined; dispose(): Promise<void> }`)、`ViewTools`(Task 4)、`BrowserStatePayload`、`BrowserSessionEntry`、`BrowserSnapshot`(Task 2)、`MSG.browserUnavailable`、`MSG.sessionEnded`
- Produces(`view-switch.ts`):

```ts
export interface ViewSwitch extends PlaceableView { target(view: PlaceableView | null): void }
export function createViewSwitch(): ViewSwitch
```

- Produces(`agent-view.ts`):`agentPartitionFor(conversationId: string): string`、`createAgentView(deps: AgentViewDeps, partition: string): WebContentsView`;刪掉 `AGENT_PARTITION`
- Produces(`browser-sessions.ts`):

```ts
export interface BrowserSession { readonly view: WebContentsView; readonly tools: ViewTools }
export interface StartToolsArgs {
  readonly view: WebContentsView
  readonly projectDir: () => string
  readonly onBusyChange: (busy: boolean) => void
}
export interface BrowserSessionsDeps {
  createView(conversationId: string): WebContentsView
  addChildView(view: WebContentsView): void
  removeChildView(view: WebContentsView): void
  loadPage(view: WebContentsView, url: string): void
  startTools(args: StartToolsArgs): Promise<ViewToolStartup>
  /** 對話目前所屬專案的 rootPath;每次用到都重查,專案被重新指定資料夾時不必另外同步。 */
  projectDirOf(conversationId: string): string | undefined
  readonly switcher: ViewSwitch
  /** 換了顯示目標之後,讓 placement 把目前的矩形套到新的 view 上。 */
  relayout(): void
  onState(state: BrowserStatePayload): void
  onSessions(sessions: readonly BrowserSessionEntry[]): void
  onNavigated(conversationId: string, url: string): void
  logError(error: Error): void
}
export interface BrowserSessions {
  ensure(conversationId: string): Promise<BrowserSession>
  get(conversationId: string): BrowserSession | undefined
  show(conversationId: string | null): void
  dispose(conversationId: string): Promise<void>
  disposeAll(): Promise<void>
  snapshot(): BrowserSnapshot
}
export function createBrowserSessions(deps: BrowserSessionsDeps): BrowserSessions
```

規格 §4.4 寫「session 建立時記下 rootPath,relocate 時更新」。這裡改成每次用到都用 `projectDirOf(conversationId)` 重查,效果相同,少一條同步的路。Task 10 會把規格那一句改成跟實作一致。

- [ ] **Step 1: 寫 view-switch 的失敗測試**

```ts
// tests/view-switch.test.ts
import { describe, expect, it } from 'vitest'
import type { PlaceableView } from '../src/main/browser-placement.js'
import { createViewSwitch } from '../src/main/view-switch.js'

function fakeView(name: string, calls: string[]): PlaceableView {
  return {
    setBounds: (b) => { calls.push(`${name}:bounds:${b.x},${b.y},${b.width},${b.height}`) },
    setVisible: (v) => { calls.push(`${name}:visible:${String(v)}`) },
  }
}

describe('view 轉接物件', () => {
  it('沒有目標時 setBounds 與 setVisible 都不做事,也不丟例外', () => {
    const sw = createViewSwitch()
    expect(() => { sw.setBounds({ x: 0, y: 0, width: 1, height: 1 }); sw.setVisible(true) }).not.toThrow()
  })

  it('指令轉給目前的目標', () => {
    const calls: string[] = []
    const sw = createViewSwitch()
    sw.target(fakeView('a', calls))
    sw.setVisible(true)
    sw.setBounds({ x: 1, y: 2, width: 3, height: 4 })
    expect(calls).toEqual(['a:visible:true', 'a:bounds:1,2,3,4'])
  })

  it('換目標時先把舊的藏起來;新的不主動顯示,等 placement 來套', () => {
    const calls: string[] = []
    const sw = createViewSwitch()
    sw.target(fakeView('a', calls))
    sw.target(fakeView('b', calls))
    expect(calls).toEqual(['a:visible:false'])
  })

  it('目標改成 null 會藏掉舊的;同一個目標再指定一次不做事', () => {
    const calls: string[] = []
    const sw = createViewSwitch()
    const a = fakeView('a', calls)
    sw.target(a)
    sw.target(a)
    sw.target(null)
    expect(calls).toEqual(['a:visible:false'])
  })
})
```

Run: `npx vitest run tests/view-switch.test.ts`
Expected: FAIL,找不到 `view-switch.js`

- [ ] **Step 2: 實作 view-switch**

```ts
// src/main/view-switch.ts
import type { Bounds } from './layout.js'
import type { PlaceableView } from './browser-placement.js'

/**
 * createBrowserPlacement 只認一個固定的 view。把這個轉接物件交給它,
 * 實際收指令的是「目前顯示的那個 session 的 view」(每對話瀏覽器規格 §4.5)。
 */
export interface ViewSwitch extends PlaceableView {
  /** 換目標:舊的先藏起來。新的不在這裡顯示,呼叫端接著叫 placement.relayout() 套矩形。 */
  target(view: PlaceableView | null): void
}

export function createViewSwitch(): ViewSwitch {
  let current: PlaceableView | null = null
  return {
    setBounds: (bounds: Bounds): void => { current?.setBounds(bounds) },
    setVisible: (visible: boolean): void => { current?.setVisible(visible) },
    target: (next): void => {
      if (next === current) return
      current?.setVisible(false)
      current = next
    },
  }
}
```

Run: `npx vitest run tests/view-switch.test.ts`
Expected: PASS

- [ ] **Step 3: `agent-view.ts` 收 partition**

```ts
/** 每個對話自己的 partition。沒有 `persist:` 前綴:只在記憶體裡,對話關閉就清掉(每對話瀏覽器規格 §2)。 */
export function agentPartitionFor(conversationId: string): string {
  return `agent:${conversationId}`
}
```

刪掉 `export const AGENT_PARTITION = 'persist:agent'` 與它的註解。`createAgentView(deps: AgentViewDeps)` 改成 `createAgentView(deps: AgentViewDeps, partition: string)`,`webPreferences.partition` 用參數。`AgentViewDeps.currentProjectDir` 的註解改成「這個 view 所屬對話的專案根目錄;對話已不在任何專案裡時回 undefined。」錯誤訊息裡的「右窗格」不用改。

`src/main/index.ts` 目前的呼叫先改成 `createAgentView({ … }, 'persist:agent')` 讓型別通過,Task 7 會整段拿掉。

- [ ] **Step 4: 寫 browser-sessions 的失敗測試**

```ts
// tests/browser-sessions.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContentsView } from 'electron'
import { createBrowserSessions, type BrowserSessionsDeps, type StartToolsArgs } from '../src/main/browser-sessions.js'
import { createViewSwitch } from '../src/main/view-switch.js'
import type { ViewToolStartup } from '../src/main/view-tools/startup.js'
import type { ViewTools } from '../src/main/view-tools/server.js'
import { MSG } from '../src/main/view-tools/errors.js'

type Handler = (...args: unknown[]) => void

function fakeView(id: string, log: string[]) {
  const handlers = new Map<string, Handler[]>()
  const webContents = {
    on: (event: string, h: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), h]) },
    getURL: () => `https://${id}.test/`,
    getTitle: () => `標題 ${id}`,
    isLoading: () => false,
    isDestroyed: () => false,
    close: () => { log.push(`${id}:close`) },
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
  }
  const view = {
    webContents,
    setVisible: (v: boolean) => { log.push(`${id}:visible:${String(v)}`) },
    setBounds: () => { log.push(`${id}:bounds`) },
  }
  const emit = (event: string, ...args: unknown[]): void => { for (const h of handlers.get(event) ?? []) h(...args) }
  return { view: view as unknown as WebContentsView, emit }
}

function fakeTools(log: string[], id: string): ViewTools {
  return {
    invoke: () => Promise.resolve({ ok: false as const, text: '' }),
    handoffDone: () => {}, abortPending: () => {}, busy: () => false,
    dispose: () => { log.push(`${id}:tools.dispose`); return Promise.resolve() },
  }
}

let log: string[]
let views: Map<string, ReturnType<typeof fakeView>>
let startArgs: Map<string, StartToolsArgs>
let startResult: (id: string) => Promise<ViewToolStartup>
let states: unknown[]
let sessionPushes: unknown[]
let navigated: string[]
let currentBuild: string

function setup(overrides: Partial<BrowserSessionsDeps> = {}) {
  const deps: BrowserSessionsDeps = {
    createView: (id) => { currentBuild = id; const v = fakeView(id, log); views.set(id, v); return v.view },
    addChildView: () => { log.push(`${currentBuild}:add`) },
    removeChildView: () => { log.push('remove') },
    loadPage: (_view, url) => { log.push(`${currentBuild}:load:${url}`) },
    startTools: (args) => { startArgs.set(currentBuild, args); return startResult(currentBuild) },
    projectDirOf: (id) => (id === 'gone' ? undefined : `/專案/${id}`),
    switcher: createViewSwitch(),
    relayout: () => { log.push('relayout') },
    onState: (s) => { states.push(s) },
    onSessions: (s) => { sessionPushes.push(s) },
    onNavigated: (id, url) => { navigated.push(`${id}:${url}`) },
    logError: vi.fn(),
    ...overrides,
  }
  return createBrowserSessions(deps)
}

beforeEach(() => {
  log = []; views = new Map(); startArgs = new Map(); states = []; sessionPushes = []; navigated = []; currentBuild = ''
  startResult = (id) => Promise.resolve({
    viewTools: fakeTools(log, id),
    dispose: () => { log.push(`${id}:startup.dispose`); return Promise.resolve() },
  })
})

describe('ensure', () => {
  it('建立的順序:藏起來、加進視窗、先載入空白頁、再附著工具', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    expect(log.slice(0, 3)).toEqual(['a:visible:false', 'a:add', 'a:load:about:blank'])
    expect(sessions.get('a')).toBeDefined()
  })

  it('同一個 id 同時 ensure 兩次只建一份', async () => {
    const sessions = setup()
    const [first, second] = await Promise.all([sessions.ensure('a'), sessions.ensure('a')])
    expect(first).toBe(second)
    expect(log.filter((l) => l === 'a:add')).toHaveLength(1)
  })

  it('工具啟動失敗:reject browserUnavailable,view 被收掉,表裡沒有殘留,下一次會重試', async () => {
    const sessions = setup()
    const ok = startResult
    startResult = () => Promise.resolve({ viewTools: undefined, dispose: () => Promise.resolve() })
    await expect(sessions.ensure('a')).rejects.toThrow(MSG.browserUnavailable)
    expect(log).toContain('remove')
    expect(log).toContain('a:close')
    expect(sessions.get('a')).toBeUndefined()
    startResult = ok
    await expect(sessions.ensure('a')).resolves.toBeDefined()
  })

  it('projectDir 每次重查;對話已不在任何專案裡時丟 sessionEnded', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    expect(startArgs.get('a')?.projectDir()).toBe('/專案/a')
    await sessions.ensure('gone')
    expect(() => startArgs.get('gone')?.projectDir()).toThrow(MSG.sessionEnded)
  })

  it('建好之後推一次 sessions 與該對話的狀態', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    expect(sessionPushes.at(-1)).toEqual([{ conversationId: 'a', busy: false }])
    expect(states.at(-1)).toEqual({ conversationId: 'a', url: 'https://a.test/', title: '標題 a', loading: false, canGoBack: true, canGoForward: false })
  })
})

describe('show', () => {
  it('先藏舊的,再 relayout 讓新的被套上矩形', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await sessions.ensure('b')
    sessions.show('a')
    log = []
    sessions.show('b')
    expect(log).toEqual(['a:visible:false', 'relayout'])
  })

  it('show 一個還沒有 session 的對話:全部藏起來;之後 ensure 完成就自動顯示', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessions.show('a')
    log = []
    sessions.show('b')
    expect(log).toEqual(['a:visible:false', 'relayout'])
    log = []
    await sessions.ensure('b')
    expect(log.at(-1)).toBe('relayout')
  })

  it('show(null) 全部藏起來', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessions.show('a')
    log = []
    sessions.show(null)
    expect(log).toEqual(['a:visible:false', 'relayout'])
  })
})

describe('事件', () => {
  it('did-navigate 記 lastUrl 並推狀態;子框架的 in-page 導航不記', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    states = []
    views.get('a')?.emit('did-navigate', {}, 'https://a.test/next')
    views.get('a')?.emit('did-navigate-in-page', {}, 'https://a.test/frame', false)
    views.get('a')?.emit('did-navigate-in-page', {}, 'https://a.test/#x', true)
    expect(navigated).toEqual(['a:https://a.test/next', 'a:https://a.test/#x'])
    expect(states).toHaveLength(2)
    void sessions
  })

  it('載入開始、結束與標題變更都推狀態', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    states = []
    for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) views.get('a')?.emit(event)
    expect(states).toHaveLength(3)
    void sessions
  })

  it('onBusyChange 觸發 sessions 重推', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessionPushes = []
    startArgs.get('a')?.onBusyChange(true)
    expect(sessionPushes).toHaveLength(1)
    void sessions
  })

  it('renderer 行程當掉就收掉那個 session', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    views.get('a')?.emit('render-process-gone')
    await vi.waitFor(() => { expect(sessions.get('a')).toBeUndefined() })
  })
})

describe('dispose', () => {
  it('正在顯示的先藏,再收工具、移出視窗、關 webContents', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessions.show('a')
    log = []
    await sessions.dispose('a')
    expect(log).toEqual(['a:visible:false', 'a:startup.dispose', 'remove', 'a:close'])
    expect(sessions.get('a')).toBeUndefined()
    expect(sessionPushes.at(-1)).toEqual([])
  })

  it('沒有 session 的 id 不做事', async () => {
    const sessions = setup()
    await expect(sessions.dispose('zzz')).resolves.toBeUndefined()
  })

  it('建立途中被 dispose:建完立刻收掉,ensure reject sessionEnded', async () => {
    let release: (s: ViewToolStartup) => void = () => {}
    startResult = () => new Promise((r) => { release = r })
    const sessions = setup()
    const pending = sessions.ensure('a')
    const disposing = sessions.dispose('a')
    release({ viewTools: fakeTools(log, 'a'), dispose: () => { log.push('a:startup.dispose'); return Promise.resolve() } })
    await expect(pending).rejects.toThrow(MSG.sessionEnded)
    await disposing
    expect(log).toContain('a:startup.dispose')
    expect(sessions.get('a')).toBeUndefined()
  })

  it('disposeAll 收掉全部,之後的 ensure reject sessionEnded', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await sessions.ensure('b')
    await sessions.disposeAll()
    expect(sessions.snapshot()).toEqual({ states: [], sessions: [] })
    await expect(sessions.ensure('c')).rejects.toThrow(MSG.sessionEnded)
  })
})
```

Run: `npx vitest run tests/browser-sessions.test.ts`
Expected: FAIL,找不到 `browser-sessions.js`

- [ ] **Step 5: 實作 browser-sessions**

```ts
// src/main/browser-sessions.ts
import type { WebContentsView } from 'electron'
import type { BrowserSessionEntry, BrowserSnapshot, BrowserStatePayload } from '../shared/browser-ipc.js'
import { MSG, ViewToolError } from './view-tools/errors.js'
import type { ViewTools } from './view-tools/server.js'
import type { ViewToolStartup } from './view-tools/startup.js'
import type { ViewSwitch } from './view-switch.js'

export interface BrowserSession {
  readonly view: WebContentsView
  readonly tools: ViewTools
}

export interface StartToolsArgs {
  readonly view: WebContentsView
  readonly projectDir: () => string
  readonly onBusyChange: (busy: boolean) => void
}

export interface BrowserSessionsDeps {
  createView(conversationId: string): WebContentsView
  addChildView(view: WebContentsView): void
  removeChildView(view: WebContentsView): void
  loadPage(view: WebContentsView, url: string): void
  startTools(args: StartToolsArgs): Promise<ViewToolStartup>
  /** 對話目前所屬專案的 rootPath;每次用到都重查,專案被重新指定資料夾時不必另外同步。 */
  projectDirOf(conversationId: string): string | undefined
  readonly switcher: ViewSwitch
  relayout(): void
  onState(state: BrowserStatePayload): void
  onSessions(sessions: readonly BrowserSessionEntry[]): void
  onNavigated(conversationId: string, url: string): void
  logError(error: Error): void
}

export interface BrowserSessions {
  ensure(conversationId: string): Promise<BrowserSession>
  get(conversationId: string): BrowserSession | undefined
  show(conversationId: string | null): void
  dispose(conversationId: string): Promise<void>
  disposeAll(): Promise<void>
  snapshot(): BrowserSnapshot
}

interface Entry {
  readonly session: BrowserSession
  readonly startup: ViewToolStartup
}

/** CDP 指令要等 renderer 行程存在才收得到,所以附著前先讓 view 開始載入,不必等它載完。 */
const INITIAL_URL = 'about:blank'

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

function stateOf(conversationId: string, view: WebContentsView): BrowserStatePayload {
  const wc = view.webContents
  return {
    conversationId,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  }
}

/**
 * 每個對話一個瀏覽器(每對話瀏覽器規格 §3、§4.1)。第一次用到才建,對話關閉時收掉。
 * 這裡是唯一加入與移除 agent view 的地方。
 */
export function createBrowserSessions(deps: BrowserSessionsDeps): BrowserSessions {
  let entries: ReadonlyMap<string, Entry> = new Map()
  let building: ReadonlyMap<string, Promise<BrowserSession>> = new Map()
  /** 建立途中被 dispose 的 id:建完要立刻收掉。 */
  let cancelled: ReadonlySet<string> = new Set()
  let shownId: string | null = null
  let closed = false

  const pushSessions = (): void => {
    deps.onSessions([...entries].map(([conversationId, e]) => ({ conversationId, busy: e.session.tools.busy() })))
  }
  const pushState = (id: string): void => {
    const entry = entries.get(id)
    if (entry !== undefined && !entry.session.view.webContents.isDestroyed()) deps.onState(stateOf(id, entry.session.view))
  }

  const removeView = (view: WebContentsView): void => {
    deps.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  const retarget = (): void => {
    const entry = shownId === null ? undefined : entries.get(shownId)
    deps.switcher.target(entry?.session.view ?? null)
    deps.relayout()
  }

  const watch = (id: string, view: WebContentsView): void => {
    const wc = view.webContents
    const navigatedTo = (url: string): void => { deps.onNavigated(id, url); pushState(id) }
    wc.on('did-navigate', (_event, url) => { navigatedTo(url) })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) navigatedTo(url) })
    wc.on('did-start-loading', () => { pushState(id) })
    wc.on('did-stop-loading', () => { pushState(id) })
    wc.on('page-title-updated', () => { pushState(id) })
    wc.on('render-process-gone', () => { dispose(id).catch((err: unknown) => { deps.logError(toError(err)) }) })
  }

  const projectDir = (id: string) => (): string => {
    const dir = deps.projectDirOf(id)
    if (dir === undefined) throw new ViewToolError(MSG.sessionEnded)
    return dir
  }

  const build = async (id: string): Promise<BrowserSession> => {
    const view = deps.createView(id)
    view.setVisible(false)
    deps.addChildView(view)
    deps.loadPage(view, INITIAL_URL)
    const startup = await deps.startTools({ view, projectDir: projectDir(id), onBusyChange: pushSessions })
    const wasCancelled = cancelled.has(id) || closed
    if (startup.viewTools === undefined || wasCancelled) {
      await startup.dispose().catch((err: unknown) => { deps.logError(toError(err)) })
      removeView(view)
      throw new Error(wasCancelled ? MSG.sessionEnded : MSG.browserUnavailable)
    }
    const session: BrowserSession = { view, tools: startup.viewTools }
    entries = new Map([...entries, [id, { session, startup }]])
    watch(id, view)
    if (shownId === id) retarget()
    pushSessions()
    pushState(id)
    return session
  }

  const ensure = (id: string): Promise<BrowserSession> => {
    if (closed) return Promise.reject(new Error(MSG.sessionEnded))
    const ready = entries.get(id)
    if (ready !== undefined) return Promise.resolve(ready.session)
    const running = building.get(id)
    if (running !== undefined) return running
    const task = build(id).finally(() => {
      building = new Map([...building].filter(([key]) => key !== id))
      cancelled = new Set([...cancelled].filter((key) => key !== id))
    })
    building = new Map([...building, [id, task]])
    return task
  }

  async function dispose(id: string): Promise<void> {
    const running = building.get(id)
    if (running !== undefined) {
      cancelled = new Set([...cancelled, id])
      await running.catch(() => {})
      return
    }
    const entry = entries.get(id)
    if (entry === undefined) return
    entries = new Map([...entries].filter(([key]) => key !== id))
    if (shownId === id) deps.switcher.target(null)
    await entry.startup.dispose().catch((err: unknown) => { deps.logError(toError(err)) })
    removeView(entry.session.view)
    pushSessions()
  }

  return {
    ensure,
    get: (id) => entries.get(id)?.session,
    show: (id) => { shownId = id; retarget() },
    dispose,
    disposeAll: async () => {
      closed = true
      await Promise.all([...new Set([...entries.keys(), ...building.keys()])].map((id) => dispose(id)))
    },
    snapshot: () => ({
      states: [...entries].filter(([, e]) => !e.session.view.webContents.isDestroyed()).map(([id, e]) => stateOf(id, e.session.view)),
      sessions: [...entries].map(([conversationId, e]) => ({ conversationId, busy: e.session.tools.busy() })),
    }),
  }
}
```

`ViewToolError` 若沒有從 `view-tools/errors.ts` 匯出(grep `export class ViewToolError`),就用那個檔實際匯出它的位置。

- [ ] **Step 6: 跑測試**

Run: `npx vitest run tests/browser-sessions.test.ts tests/view-switch.test.ts tests/browser-placement.test.ts && npm run typecheck`
Expected: PASS。`dispose` 測試裡 `log` 的順序若多出一筆 `relayout`,表示 `dispose` 走了 `retarget()`;實作刻意只叫 `switcher.target(null)`,不 relayout(沒有東西要顯示)。

- [ ] **Step 7: Commit**

```bash
git add src/main/view-switch.ts src/main/browser-sessions.ts src/main/agent-view.ts src/main/index.ts tests/view-switch.test.ts tests/browser-sessions.test.ts
git commit -m "feat: add per-conversation browser session registry"
```

---

### Task 6: 處理 `browser:command`

**Files:**
- Create: `src/main/browser-commands.ts`
- Test: `tests/browser-commands.test.ts`

**Interfaces:**
- Consumes:`normalizeBrowserInput`(Task 1)、`BrowserCommand`、`BrowserCommandResult`(Task 2)、`BrowserSessions`(Task 5)、`checkNavigateUrl`(`view-tools/urls.ts`)、`MSG`
- Produces:

```ts
export interface BrowserCommandsDeps {
  readonly sessions: Pick<BrowserSessions, 'ensure' | 'get'>
  foregroundId(): string | null
  projectDirOf(conversationId: string): string | undefined
  loadPage(view: WebContentsView, url: string): void
  logError(error: Error): void
}
export function createBrowserCommands(deps: BrowserCommandsDeps): { run(command: BrowserCommand): Promise<BrowserCommandResult> }
```

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/browser-commands.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContentsView } from 'electron'
import { createBrowserCommands } from '../src/main/browser-commands.js'
import type { BrowserSession } from '../src/main/browser-sessions.js'
import { MSG } from '../src/main/view-tools/errors.js'

let calls: string[]
let foreground: string | null
let existing: BrowserSession | undefined
let ensureFails: boolean

function fakeSession(): BrowserSession {
  const webContents = {
    navigationHistory: {
      canGoBack: () => true, canGoForward: () => false,
      goBack: () => { calls.push('goBack') }, goForward: () => { calls.push('goForward') },
    },
    reload: () => { calls.push('reload') },
    stop: () => { calls.push('stop') },
  }
  return { view: { webContents } as unknown as WebContentsView, tools: {} as BrowserSession['tools'] }
}

function setup() {
  return createBrowserCommands({
    sessions: {
      ensure: (id) => {
        calls.push(`ensure:${id}`)
        if (ensureFails) return Promise.reject(new Error(MSG.browserUnavailable))
        existing = existing ?? fakeSession()
        return Promise.resolve(existing)
      },
      get: () => existing,
    },
    foregroundId: () => foreground,
    projectDirOf: (id) => (id === 'c1' ? '/專案' : undefined),
    loadPage: (_view, url) => { calls.push(`load:${url}`) },
    logError: vi.fn(),
  })
}

beforeEach(() => { calls = []; foreground = 'c1'; existing = undefined; ensureFails = false })

describe('navigate', () => {
  it('正規化、過白名單、ensure、載入', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'localhost:3000' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['ensure:c1', 'load:http://localhost:3000/'])
  })

  it('不是網址:不建瀏覽器', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'hello world' })).resolves.toEqual({ ok: false, message: MSG.notUrl })
    expect(calls).toEqual([])
  })

  it('空字串:不做事,回 ok', async () => {
    await expect(setup().run({ kind: 'navigate', url: '  ' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('協定不在白名單:不建瀏覽器', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'javascript:alert(1)' })).resolves.toEqual({ ok: false, message: MSG.badScheme })
    expect(calls).toEqual([])
  })

  it('專案目錄以外的 file://', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'file:///etc/passwd' })).resolves.toEqual({ ok: false, message: MSG.outsideProject('/專案') })
  })

  it('專案目錄底下的 file:// 放行', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'file:///專案/out/index.html' })).resolves.toEqual({ ok: true })
  })

  it('ensure 失敗回 browserUnavailable', async () => {
    ensureFails = true
    await expect(setup().run({ kind: 'navigate', url: 'a.test' })).resolves.toEqual({ ok: false, message: MSG.browserUnavailable })
  })

  it('沒有前景對話:不做事,回 ok', async () => {
    foreground = null
    await expect(setup().run({ kind: 'navigate', url: 'a.test' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('前景對話不在任何專案裡', async () => {
    foreground = 'orphan'
    await expect(setup().run({ kind: 'navigate', url: 'a.test' })).resolves.toEqual({ ok: false, message: MSG.sessionEnded })
  })
})

describe('其餘四個指令', () => {
  it('沒有 session 時不做事,也不建', async () => {
    for (const kind of ['back', 'forward', 'reload', 'stop'] as const) {
      await expect(setup().run({ kind })).resolves.toEqual({ ok: true })
    }
    expect(calls).toEqual([])
  })

  it('有 session 時各自轉給 webContents;不能往前就不叫 goForward', async () => {
    existing = fakeSession()
    const commands = setup()
    for (const kind of ['back', 'forward', 'reload', 'stop'] as const) await commands.run({ kind })
    expect(calls).toEqual(['goBack', 'reload', 'stop'])
  })
})
```

Run: `npx vitest run tests/browser-commands.test.ts`
Expected: FAIL,找不到 `browser-commands.js`

- [ ] **Step 2: 實作**

```ts
// src/main/browser-commands.ts
import type { WebContentsView } from 'electron'
import type { BrowserCommand, BrowserCommandResult } from '../shared/browser-ipc.js'
import { normalizeBrowserInput } from '../shared/browser-url.js'
import type { BrowserSessions } from './browser-sessions.js'
import { MSG } from './view-tools/errors.js'
import { checkNavigateUrl, type UrlCheck } from './view-tools/urls.js'

export interface BrowserCommandsDeps {
  readonly sessions: Pick<BrowserSessions, 'ensure' | 'get'>
  foregroundId(): string | null
  projectDirOf(conversationId: string): string | undefined
  loadPage(view: WebContentsView, url: string): void
  logError(error: Error): void
}

const OK: BrowserCommandResult = { ok: true }
const fail = (message: string): BrowserCommandResult => ({ ok: false, message })

function rejection(check: Exclude<UrlCheck, { kind: 'ok' }>, raw: string): string {
  if (check.kind === 'bad-scheme') return MSG.badScheme
  if (check.kind === 'outside-project') return MSG.outsideProject(check.projectDir)
  return MSG.invalidUrl(raw)
}

/** 網址列的指令(每對話瀏覽器規格 §5.2)。一律作用在前景對話;人輸入的網址跟 view_navigate 過同一份檢查。 */
export function createBrowserCommands(deps: BrowserCommandsDeps): { run(command: BrowserCommand): Promise<BrowserCommandResult> } {
  const navigate = async (id: string, raw: string): Promise<BrowserCommandResult> => {
    const input = normalizeBrowserInput(raw)
    if (input.kind === 'empty') return OK
    if (input.kind === 'not-url') return fail(MSG.notUrl)
    const projectDir = deps.projectDirOf(id)
    if (projectDir === undefined) return fail(MSG.sessionEnded)
    const check = checkNavigateUrl(input.url, projectDir)
    if (check.kind !== 'ok') return fail(rejection(check, input.url))
    try {
      const session = await deps.sessions.ensure(id)
      deps.loadPage(session.view, check.url)
      return OK
    } catch (raw) {
      deps.logError(raw instanceof Error ? raw : new Error(String(raw)))
      return fail(MSG.browserUnavailable)
    }
  }

  const simple = (id: string, kind: Exclude<BrowserCommand['kind'], 'navigate'>): BrowserCommandResult => {
    const wc = deps.sessions.get(id)?.view.webContents
    if (wc === undefined) return OK
    if (kind === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (kind === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (kind === 'reload') wc.reload()
    if (kind === 'stop') wc.stop()
    return OK
  }

  return {
    run: async (command) => {
      const id = deps.foregroundId()
      if (id === null) return OK
      return command.kind === 'navigate' ? navigate(id, command.url) : simple(id, command.kind)
    },
  }
}
```

- [ ] **Step 3: 跑測試**

Run: `npx vitest run tests/browser-commands.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/browser-commands.ts tests/browser-commands.test.ts
git commit -m "feat: handle address bar commands for the foreground conversation"
```

---

### Task 7: 主行程接線:拿掉單一 agentView 與前景守衛

**Files:**
- Modify: `src/main/ipc-bridge.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/view-tools/errors.ts`(刪 `browserBusy`)
- Test: `tests/ipc-bridge.test.ts`

**Interfaces:**
- Consumes:Task 3 的 `setTabLastUrl`、`tabLastUrl`;Task 4 的 `createConversationViewServer`、`ViewToolHooks`;Task 5 的 `createBrowserSessions`、`createViewSwitch`、`createAgentView(deps, partition)`、`agentPartitionFor`;Task 6 的 `createBrowserCommands`
- Produces(`ipc-bridge.ts`):

```ts
// IpcBridgeDeps
readonly runtimeFor: (projectId: string, cwd: string, conversationId: string) => ProjectRuntime
/** 每對話瀏覽器:前景換人時換顯示,對話收掉時收瀏覽器。沒給就沒有瀏覽器。 */
readonly browser?: { show(conversationId: string | null): void; dispose(conversationId: string): Promise<void> }
```

- [ ] **Step 1: 改 `tests/ipc-bridge.test.ts` 的 rig 與三個測試**

1. rig 的 `runtimeFor: (projectId, rootPath, _isActive, conversationId) => {` 改成 `runtimeFor: (projectId, rootPath, conversationId) => {`。第 85 行附近若有 `isActive: () => active` 是給假 core 用的,不要動。
2. rig 加一個 `browser` 紀錄並傳給 `createIpcBridge`:

```ts
  const browserLog: string[] = []
  // …createIpcBridge({ … 內加:
    browser: {
      show: (id) => { browserLog.push(`show:${id ?? 'null'}`); timeline.push(`browser.show:${id ?? 'null'}`) },
      dispose: (id) => { browserLog.push(`dispose:${id}`); log.push(`${id}.browser.dispose`); return Promise.resolve() },
    },
```

   並把 `browserLog` 放進 rig 回傳的物件。
3. 三個斷言 `browserBusy` 的測試改寫:
   - `activeId 改變:先推 projects:state,再舊 core deactivate、舊 view tools 收 browserBusy、新 core activate` → 改名 `activeId 改變:先推 projects:state,再舊 core deactivate、新 core activate,右窗格換成新前景的瀏覽器`;`expect(rig.aborts).toEqual(['tab-a:瀏覽器正由前景對話使用'])` 換成 `expect(rig.aborts).toEqual([])` 與 `expect(rig.browserLog.at(-1)).toBe('show:tab-b')`。
   - `同專案切分頁:舊對話 deactivate、view tools 收 browserBusy、新對話 activate;先推 projects:state` → 同樣的兩個替換,`show:` 後面接該測試切過去的分頁 id。
   - `codex 分頁切走時,它的右窗格呼叫收到 browserBusy(規格 §4.3)` → 改名 `codex 分頁切走時,它的右窗格呼叫不被中止`,斷言改成 `expect(rig.aborts).toEqual([])`。
4. 第 1237、1246、1254 行的 `toEqual([A, worktreePath, expect.any(Function), 'worktree-tab'])` 與兩個 `toHaveBeenLastCalledWith(A, '/private/tmp/alpha', expect.any(Function), 'tab-a')`,拿掉中間的 `expect.any(Function)`。
5. 加三個新測試(放在專案切換那個 describe 裡;`makeRig`、`twoProjects`、`A`、`B`、`NOW`、`setActive` 都是該檔現有的):

```ts
  it('建立時就顯示初始前景對話的瀏覽器', () => {
    const rig = makeRig(twoProjects())
    expect(rig.browserLog).toEqual(['show:tab-a'])
  })

  it('沒有專案時 show(null)', () => {
    const rig = makeRig(EMPTY_PROJECTS_STATE)
    expect(rig.browserLog).toEqual(['show:null'])
  })

  it('關閉對話:core 收完之後才收 runtime 與瀏覽器', async () => {
    const rig = makeRig(twoProjects())
    await rig.bridge.disposeConversation('tab-a')
    const tail = rig.log.filter((l) => l.startsWith('tab-a.')).slice(-3)
    expect(tail).toEqual(['tab-a.dispose', 'tab-a.runtime.dispose', 'tab-a.browser.dispose'])
  })
```

   `tab-a.dispose` 這個字串以假 core 的 `dispose` 實際寫進 `log` 的為準(在 rig 的 `createConversation` 假實作裡找)。

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: FAIL(型別與新斷言)

- [ ] **Step 2: 改 `ipc-bridge.ts`**

1. `IpcBridgeDeps.runtimeFor` 的簽名與註解照 Interfaces 區塊改;加 `browser` 欄位。
2. 兩處呼叫(約第 330、347 行)`deps.runtimeFor(projectId, cwd, () => currentId === conversationId, conversationId)` → `deps.runtimeFor(projectId, cwd, conversationId)`。
3. `switchTo`:

```ts
  /** 舊對話退到背景(回合跑完才 sleep);它的瀏覽器照常運作,只是右窗格改顯示新前景的那一個。專案切換與同專案切分頁都走這裡。 */
  const switchTo = (nextId: string | null): void => {
    if (nextId === currentId) return
    const prev = currentId === null ? undefined : slots.get(currentId)
    currentId = nextId
    prev?.core.deactivate()
    deps.browser?.show(nextId)
    activeSlot()?.core.activate()
  }
```

   `currentId` 初值是 `null`,初始前景也是 `null` 時 `switchTo(null)` 第一行就 return,`show(null)` 不會被呼叫。檔尾 `switchTo(foregroundConversationId(deps.projects.state()))` 那一行換成:

```ts
  const initialId = foregroundConversationId(deps.projects.state())
  if (initialId === null) deps.browser?.show(null)
  switchTo(initialId)
```

4. `closeSlot` 的 `finally`:

```ts
    } finally {
      slot.runtime?.dispose?.()
      await deps.browser?.dispose(conversationId).catch((err: unknown) => {
        deps.logError(asError(err, `browser.dispose(${conversationId})`))
      })
    }
```

5. 移除不再用到的 `MSG` import(若該檔其他地方還有用到 `MSG` 就留著)。

- [ ] **Step 3: 跑 bridge 測試**

Run: `npx vitest run tests/ipc-bridge.test.ts tests/codex-conversation.test.ts`
Expected: PASS

- [ ] **Step 4: 改 `index.ts`**

以下行號是現況,改之前先用 grep 對一次。

1. 刪掉:`const agentView = createAgentView(…)`、`win.contentView.addChildView(agentView)`、`loadAgentPage(agentView, INITIAL_AGENT_URL)`、`const startup = await startViewTools({…})` 整段與後面 `if (win.isDestroyed()) { await startup.dispose()… }` 裡的 `startup.dispose()`(`return win` 留著)、`rememberUrl` 與兩個 `agentView.webContents.on(...)`、切換專案時 `loadAgentPage(agentView, agentUrlFor(next))` 的那個 `service.subscribe`(連同 `unsubscribe` 變數與 `closed` handler 裡的 `unsubscribe()`)、檔尾的 `loadAgentPage(agentView, startup.viewTools === undefined ? … : agentUrlFor(…))`、`closed` handler 裡的 `startup.dispose()…`、函式 `agentUrlFor` 與常數 `INITIAL_AGENT_URL`、`activeProjectDir`/`resolveActiveProjectDir` 若已無人使用。`shouldRemember` 留著。
2. `createBrowserPlacement` 的 `view: agentView` 改成 `view: switcher`,在它前面加 `const switcher = createViewSwitch()`。
3. 在 `peer` 建好之後、`runtimeFor` 之前加:

```ts
  const projectDirOfConversation = (conversationId: string): string | undefined =>
    findProjectByTab(service.state(), conversationId)?.rootPath

  const sendToRenderer = (channel: string, payload: unknown): void => {
    if (!conversationView.webContents.isDestroyed()) conversationView.webContents.send(channel, payload)
  }

  // 每對話瀏覽器規格 §3:第一次用到才建,對話關閉時收掉。
  const browserSessions = createBrowserSessions({
    createView: (conversationId) => createAgentView(
      { currentProjectDir: () => projectDirOfConversation(conversationId), logError },
      agentPartitionFor(conversationId)
    ),
    addChildView: (view) => { win.contentView.addChildView(view) },
    removeChildView: (view) => { if (!win.isDestroyed()) win.contentView.removeChildView(view) },
    loadPage: loadAgentPage,
    startTools: ({ view, projectDir, onBusyChange }) => startViewTools({
      view, projectDir, onBusyChange,
      clock: SYSTEM_CLOCK,
      logError,
      warn: (line) => { console.error(line) },
      attach: attachCdp,
      create: createViewToolServer,
    }),
    projectDirOf: projectDirOfConversation,
    switcher,
    relayout: () => { placement.relayout() },
    onState: (state) => { sendToRenderer(IPC.browserState, state) },
    onSessions: (list) => { sendToRenderer(IPC.browserSessions, list) },
    // 規格 §4.6:導航完成才記,所以錯誤頁與 about:blank 不會蓋掉上次的頁面。
    onNavigated: (conversationId, url) => {
      if (shouldRemember(url)) service.update((s) => setTabLastUrl(s, conversationId, url))
    },
    logError,
  })
  const browserCommands = createBrowserCommands({
    sessions: browserSessions,
    foregroundId: () => foregroundConversationId(service.state()),
    projectDirOf: projectDirOfConversation,
    loadPage: loadAgentPage,
    logError,
  })
```

4. `runtimeFor` 換成:

```ts
  // 每個對話一份 MCP server;瀏覽器本身等第一次工具呼叫才建(規格 §4.3)。
  const runtimeFor = (_projectId: string, cwd: string, conversationId: string): ProjectRuntime => {
    const own = createConversationViewServer({
      resolve: async () => (await browserSessions.ensure(conversationId)).tools,
      logError,
      ...(chef?.worker(conversationId) ? {} : { peer: peer.forConversation(conversationId) }),
    })
    const sessionOptions = createSessionOptionsFactory(
      cwd,
      appDir,
      liveCwd,
      { [VIEW_TOOL_SERVER_NAME]: own.server },
      { window: autoCompactWindow(), baseEnv: process.env },
      () => sharedSkills?.runtime().plugins ?? []
    )
    const tools = (): ViewTools | undefined => browserSessions.get(conversationId)?.tools
    return {
      sessionOptions,
      codexSkillRoots: () => sharedSkills?.runtime().roots ?? [],
      viewTools: {
        autoAllow: (toolName) => viewToolPolicy(toolName) === 'allow',
        handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
        abortPending: (reason) => { tools()?.abortPending(reason) },
      },
      codexViewTools: {
        invoke: (name, args, ctx) => own.invoke(name, args, ctx),
        handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
      },
      dispose: () => { own.dispose() },
    }
  }
```

5. `createIpcBridge({ … })` 的參數加 `browser: { show: (id) => { browserSessions.show(id) }, dispose: (id) => browserSessions.dispose(id) },`。
6. 註冊兩個 handler,放在 `ipcMain.handle(IPC.previewRead, onPreviewRead)` 附近,沿用那裡檢查 sender 的寫法:

```ts
  ipcMain.handle(IPC.browserCommand, async (event, raw: unknown) => {
    if (event.sender !== conversationView.webContents) throw new Error(`${IPC.browserCommand} 只接受左窗格的呼叫`)
    const command = parseBrowserCommand(raw)
    if (command === null) {
      logError(new Error(`${IPC.browserCommand} 收到格式不對的 payload`))
      return { ok: false, message: MSG.internal('指令格式不對') }
    }
    return browserCommands.run(command)
  })
  ipcMain.handle(IPC.browserGet, (event) => {
    if (event.sender !== conversationView.webContents) throw new Error(`${IPC.browserGet} 只接受左窗格的呼叫`)
    return browserSessions.snapshot()
  })
  win.once('closed', () => {
    ipcMain.removeHandler(IPC.browserCommand)
    ipcMain.removeHandler(IPC.browserGet)
  })
```

7. `closed` handler 裡,把原本 `startup.dispose()…` 的位置換成排在 `bridge.dispose()` 之後:在 `.then(() => bridge.dispose())` 後面接 `.then(() => browserSessions.disposeAll())`。
8. composeView 要把每個分頁的有效 `lastUrl` 送給 renderer:`src/main/ipc-bridge.ts` 的 `composeView` 裡 `tabs: p.tabs.map(tab => { … })` 改成

```ts
          tabs: p.tabs.map((tab) => {
            const worker = deps.chef?.worker(tab.id)
            const withUrl = tab.contentType === 'conversation' ? { ...tab, lastUrl: tabLastUrl(p, tab.id) } : tab
            return worker ? { ...withUrl, chefTaskId: worker.taskId } : withUrl
          }),
```

   並在 `tests/ipc-bridge.test.ts` 加:

```ts
  it('projects:state 的對話分頁帶有效的 lastUrl:專案層級的舊值只給 sortOrder 最小的那個', () => {
    const base = twoProjects()
    const rig = makeRig({ ...base, projects: base.projects.map((p) => (p.id === A ? { ...p, lastUrl: 'https://old.test/' } : p)) })
    const tabs = rig.view().projects.find((p) => p.id === A)?.tabs.filter((t) => t.contentType === 'conversation') ?? []
    expect(tabs[0]?.lastUrl).toBe('https://old.test/')
    expect(tabs.slice(1).every((t) => t.lastUrl === null)).toBe(true)
  })
```

9. import 整理:加 `createBrowserSessions`、`createBrowserCommands`、`createViewSwitch`、`agentPartitionFor`、`createConversationViewServer`、`viewToolPolicy`、`parseBrowserCommand`、`setTabLastUrl`、`findProjectByTab`、`foregroundConversationId`、`MSG`、`type ViewTools`;移除不再用到的 `setLastUrl`、`checkNavigateUrl`、`buildErrorPageUrl`(先 grep 確認該檔沒有別處在用)。

- [ ] **Step 5: 刪 `MSG.browserBusy`**

Run: `grep -rn browserBusy src tests`
Expected: 只剩 `src/main/view-tools/errors.ts` 那一行。刪掉它。還有別處就先處理那一處。

- [ ] **Step 6: 全部測試與型別**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS

- [ ] **Step 7: 實機冒煙測試**

Run: `npm run dev`

1. 開兩個對話分頁。在分頁甲叫 agent「用瀏覽器開 https://example.com 並告訴我標題」,不等它結束就切到分頁乙,叫 agent「用瀏覽器開 https://www.iana.org 並告訴我標題」。
   Expected: 兩邊都回報正確標題,沒有人收到「瀏覽器正由前景對話使用」。
2. 來回切兩個分頁。
   Expected: 右窗格分別顯示 example.com 與 iana.org。
3. 關掉分頁甲,執行 `ps aux | grep -c "[E]lectron Helper (Renderer)"`,跟關之前比。
   Expected: 少 1。

此時還沒有網址列(Task 8),右窗格在沒有 session 的對話是空的深色區塊,這是預期的。

- [ ] **Step 8: Commit**

```bash
git add src/main tests/ipc-bridge.test.ts
git commit -m "feat: give every conversation its own sandboxed browser"
```

---

### Task 8: renderer 的網址列與空狀態

**Files:**
- Create: `src/renderer/hooks/useBrowser.ts`、`src/renderer/components/BrowserBar.tsx`、`src/renderer/components/BrowserBar.css`、`src/renderer/components/BrowserEmpty.tsx`
- Modify: `src/renderer/components/PanelGroup.tsx`、`src/renderer/App.tsx`
- Modify: `src/renderer/components/Icon.tsx`(加四個圖示)
- Test: `tests/use-browser.test.tsx`、`tests/browser-bar.test.tsx`、`tests/panel-group.test.tsx`

**Interfaces:**
- Consumes:`YesChefApi` 的 `browserCommand`、`getBrowser`、`onBrowserState`、`onBrowserSessions`(Task 2);`TabEntry.lastUrl`(Task 3、Task 7 由 `projects:state` 帶過來);`foregroundConversationId`(`src/renderer/foreground.ts`)
- Produces:

```ts
// useBrowser.ts
export interface Browser {
  stateOf(conversationId: string | null): BrowserStatePayload | undefined
  readonly sessions: readonly BrowserSessionEntry[]
  run(command: BrowserCommand): Promise<BrowserCommandResult>
}
export function useBrowser(api: Pick<YesChefApi, 'browserCommand' | 'getBrowser' | 'onBrowserState' | 'onBrowserSessions'>): Browser

// BrowserBar.tsx
export interface BrowserBarProps {
  readonly state: BrowserStatePayload | undefined
  /** 沒有 session 時網址列預填的值(該對話的 lastUrl)。 */
  readonly fallbackUrl: string
  readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>
}

// PanelGroup 新增的 props
readonly browser: { readonly state: BrowserStatePayload | undefined; readonly lastUrl: string | null; readonly run: BrowserBarProps['run'] }
```

- [ ] **Step 1: 寫 `useBrowser` 的失敗測試**

```tsx
// tests/use-browser.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useBrowser } from '../src/renderer/hooks/useBrowser.js'
import type { BrowserSessionEntry, BrowserSnapshot, BrowserStatePayload } from '../src/shared/browser-ipc.js'

afterEach(cleanup)

const state = (conversationId: string, url: string): BrowserStatePayload =>
  ({ conversationId, url, title: '', loading: false, canGoBack: false, canGoForward: false })

function fakeApi(initial: BrowserSnapshot = { states: [], sessions: [] }) {
  let onState: (s: BrowserStatePayload) => void = () => {}
  let onSessions: (s: readonly BrowserSessionEntry[]) => void = () => {}
  return {
    api: {
      browserCommand: () => Promise.resolve({ ok: true as const }),
      getBrowser: () => Promise.resolve(initial),
      onBrowserState: (cb: typeof onState) => { onState = cb; return () => {} },
      onBrowserSessions: (cb: typeof onSessions) => { onSessions = cb; return () => {} },
    },
    pushState: (s: BrowserStatePayload) => { act(() => { onState(s) }) },
    pushSessions: (s: readonly BrowserSessionEntry[]) => { act(() => { onSessions(s) }) },
  }
}

describe('useBrowser', () => {
  it('掛載時用 getBrowser 取回目前狀態', async () => {
    const { api } = fakeApi({ states: [state('c1', 'https://a.test/')], sessions: [{ conversationId: 'c1', busy: false }] })
    const { result } = renderHook(() => useBrowser(api))
    await waitFor(() => { expect(result.current.stateOf('c1')?.url).toBe('https://a.test/') })
    expect(result.current.sessions).toEqual([{ conversationId: 'c1', busy: false }])
  })

  it('每個對話各記一份狀態,互不覆蓋', async () => {
    const { api, pushState } = fakeApi()
    const { result } = renderHook(() => useBrowser(api))
    pushState(state('c1', 'https://a.test/'))
    pushState(state('c2', 'https://b.test/'))
    pushState(state('c1', 'https://a.test/next'))
    expect(result.current.stateOf('c1')?.url).toBe('https://a.test/next')
    expect(result.current.stateOf('c2')?.url).toBe('https://b.test/')
    expect(result.current.stateOf(null)).toBeUndefined()
  })

  it('sessions 清單裡消失的對話,它的狀態也一起丟掉', async () => {
    const { api, pushState, pushSessions } = fakeApi()
    const { result } = renderHook(() => useBrowser(api))
    pushSessions([{ conversationId: 'c1', busy: false }])
    pushState(state('c1', 'https://a.test/'))
    pushSessions([])
    expect(result.current.stateOf('c1')).toBeUndefined()
  })

  it('晚到的 getBrowser 結果不蓋掉已經收到的推送', async () => {
    let release: (s: BrowserSnapshot) => void = () => {}
    const base = fakeApi()
    const api = { ...base.api, getBrowser: () => new Promise<BrowserSnapshot>((r) => { release = r }) }
    const { result } = renderHook(() => useBrowser(api))
    base.pushState(state('c1', 'https://new.test/'))
    await act(async () => { release({ states: [state('c1', 'https://old.test/')], sessions: [] }) })
    expect(result.current.stateOf('c1')?.url).toBe('https://new.test/')
  })
})
```

Run: `npx vitest run tests/use-browser.test.tsx`
Expected: FAIL,找不到 `useBrowser.js`

- [ ] **Step 2: 實作 `useBrowser`**

```ts
// src/renderer/hooks/useBrowser.ts
import { useCallback, useEffect, useState } from 'react'
import type { BrowserCommand, BrowserCommandResult, BrowserSessionEntry, BrowserStatePayload } from '../../shared/browser-ipc.js'
import type { YesChefApi } from '../../shared/ipc.js'

export interface Browser {
  stateOf(conversationId: string | null): BrowserStatePayload | undefined
  readonly sessions: readonly BrowserSessionEntry[]
  run(command: BrowserCommand): Promise<BrowserCommandResult>
}

type States = ReadonlyMap<string, BrowserStatePayload>
type BrowserApi = Pick<YesChefApi, 'browserCommand' | 'getBrowser' | 'onBrowserState' | 'onBrowserSessions'>

/** 每個對話的瀏覽器狀態都收著:切換對話時網址列手上已經有新前景的最新狀態(每對話瀏覽器規格 §5.2)。 */
export function useBrowser(api: BrowserApi): Browser {
  const [states, setStates] = useState<States>(new Map())
  const [sessions, setSessions] = useState<readonly BrowserSessionEntry[]>([])

  useEffect(() => {
    let alive = true
    const offState = api.onBrowserState((next) => {
      setStates((prev) => new Map([...prev, [next.conversationId, next]]))
    })
    const offSessions = api.onBrowserSessions((next) => {
      setSessions(next)
      const live = new Set(next.map((s) => s.conversationId))
      setStates((prev) => new Map([...prev].filter(([id]) => live.has(id))))
    })
    api.getBrowser().then((snapshot) => {
      if (!alive) return
      // 推送比這份快照新:已經有的不蓋。
      setStates((prev) => new Map([...snapshot.states.map((s) => [s.conversationId, s] as const), ...prev]))
      setSessions((prev) => (prev.length > 0 ? prev : snapshot.sessions))
    }).catch((err: unknown) => { console.error('[yeschef] browser:get 失敗', err) })
    return () => { alive = false; offState(); offSessions() }
  }, [api])

  const stateOf = useCallback((id: string | null) => (id === null ? undefined : states.get(id)), [states])
  const run = useCallback((command: BrowserCommand) => api.browserCommand(command), [api])
  return { stateOf, sessions, run }
}
```

Run: `npx vitest run tests/use-browser.test.tsx`
Expected: PASS

- [ ] **Step 3: 寫 `BrowserBar` 的失敗測試**

```tsx
// tests/browser-bar.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserBar } from '../src/renderer/components/BrowserBar.js'
import type { BrowserCommand, BrowserCommandResult, BrowserStatePayload } from '../src/shared/browser-ipc.js'

afterEach(cleanup)

const STATE: BrowserStatePayload = { conversationId: 'c1', url: 'https://a.test/', title: 'A', loading: false, canGoBack: true, canGoForward: false }

function setup(state: BrowserStatePayload | undefined, result: BrowserCommandResult = { ok: true }, fallbackUrl = '') {
  const run = vi.fn((_c: BrowserCommand) => Promise.resolve(result))
  const utils = render(<BrowserBar state={state} fallbackUrl={fallbackUrl} run={run} />)
  const input = screen.getByRole('textbox', { name: '網址' }) as HTMLInputElement
  return { run, input, ...utils }
}

describe('BrowserBar', () => {
  it('顯示目前網址;上一頁可按,下一頁不可按', () => {
    const { input } = setup(STATE)
    expect(input.value).toBe('https://a.test/')
    expect((screen.getByRole('button', { name: '上一頁' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '下一頁' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('沒有 session:預填 fallbackUrl,三個導覽按鈕都不可按', () => {
    const { input } = setup(undefined, { ok: true }, 'https://last.test/')
    expect(input.value).toBe('https://last.test/')
    for (const name of ['上一頁', '下一頁', '重新整理']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('按 Enter 送 navigate', async () => {
    const { run, input } = setup(STATE)
    fireEvent.change(input, { target: { value: 'localhost:3000' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => { expect(run).toHaveBeenCalledWith({ kind: 'navigate', url: 'localhost:3000' }) })
  })

  it('被拒絕時在輸入框下方顯示原因;再打字就清掉', async () => {
    const { input } = setup(STATE, { ok: false, message: '這不是網址' })
    fireEvent.change(input, { target: { value: 'hello world' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect((await screen.findByRole('alert')).textContent).toBe('這不是網址')
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('按 Esc 還原成目前網址', () => {
    const { input } = setup(STATE)
    fireEvent.change(input, { target: { value: '打到一半' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('https://a.test/')
  })

  it('沒在編輯時,網址跟著狀態更新;編輯中不被蓋掉', () => {
    const { input, rerender, run } = setup(STATE)
    rerender(<BrowserBar state={{ ...STATE, url: 'https://a.test/next' }} fallbackUrl="" run={run} />)
    expect(input.value).toBe('https://a.test/next')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '打到一半' } })
    rerender(<BrowserBar state={{ ...STATE, url: 'https://a.test/third' }} fallbackUrl="" run={run} />)
    expect(input.value).toBe('打到一半')
  })

  it('換了對話就丟掉編輯中的內容與錯誤', async () => {
    const { input, rerender, run } = setup(STATE, { ok: false, message: '這不是網址' })
    fireEvent.change(input, { target: { value: 'x y' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await screen.findByRole('alert')
    rerender(<BrowserBar state={{ ...STATE, conversationId: 'c2', url: 'https://b.test/' }} fallbackUrl="" run={run} />)
    expect(input.value).toBe('https://b.test/')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('載入中時重新整理變成停止', () => {
    const { run } = setup({ ...STATE, loading: true })
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(run).toHaveBeenCalledWith({ kind: 'stop' })
  })
})
```

Run: `npx vitest run tests/browser-bar.test.tsx`
Expected: FAIL,找不到 `BrowserBar.js`

- [ ] **Step 4: 實作 `BrowserBar`**

`src/renderer/components/Icon.tsx` 的圖示表加四個(沿用該檔 24×24、stroke 的畫法):

```tsx
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  reload: <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>,
  stop: <path d="M6 6l12 12M18 6L6 18" />,
```

`Icon` 的 `name` 型別若是手寫的 union,把這四個名字加進去。

```tsx
// src/renderer/components/BrowserBar.tsx
import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { BrowserCommand, BrowserCommandResult, BrowserStatePayload } from '../../shared/browser-ipc.js'
import { Icon } from './Icon.js'
import './BrowserBar.css'

export interface BrowserBarProps {
  readonly state: BrowserStatePayload | undefined
  /** 沒有 session 時網址列預填的值(該對話的 lastUrl)。 */
  readonly fallbackUrl: string
  readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>
}

/** 網址列(每對話瀏覽器規格 §5.1)。一律作用在前景對話的瀏覽器。 */
export function BrowserBar({ state, fallbackUrl, run }: BrowserBarProps): React.ReactElement {
  const current = state?.url ?? fallbackUrl
  const owner = state?.conversationId ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // 換了對話:編輯到一半的內容與錯誤都屬於上一個對話。
  useEffect(() => { setDraft(null); setError(null) }, [owner])

  const send = (command: BrowserCommand): void => {
    run(command).then((result) => {
      setError(result.ok ? null : result.message)
      if (result.ok) setDraft(null)
    }).catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
  }

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault()
    send({ kind: 'navigate', url: draft ?? current })
    input.current?.blur()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    setDraft(null)
    setError(null)
    input.current?.blur()
  }

  const hasSession = state !== undefined
  const loading = state?.loading ?? false
  return (
    <form className="browser-bar" onSubmit={onSubmit}>
      <button type="button" className="browser-bar-button" aria-label="上一頁" disabled={!(state?.canGoBack ?? false)}
        onClick={() => { send({ kind: 'back' }) }}><Icon name="back" /></button>
      <button type="button" className="browser-bar-button" aria-label="下一頁" disabled={!(state?.canGoForward ?? false)}
        onClick={() => { send({ kind: 'forward' }) }}><Icon name="forward" /></button>
      <button type="button" className="browser-bar-button" aria-label={loading ? '停止' : '重新整理'} disabled={!hasSession}
        onClick={() => { send({ kind: loading ? 'stop' : 'reload' }) }}><Icon name={loading ? 'stop' : 'reload'} /></button>
      <div className="browser-bar-field">
        <input ref={input} type="text" aria-label="網址" className="browser-bar-input" spellCheck={false} autoComplete="off"
          placeholder="輸入網址" value={draft ?? current} aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'browser-bar-error'}
          onFocus={(event) => { event.currentTarget.select() }}
          onChange={(event) => { setDraft(event.currentTarget.value); setError(null) }}
          onKeyDown={onKeyDown} />
        {error === null ? null : <p id="browser-bar-error" role="alert" className="browser-bar-error">{error}</p>}
      </div>
    </form>
  )
}
```

```css
/* src/renderer/components/BrowserBar.css */
.browser-bar { display: flex; flex: none; align-items: flex-start; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--ui-border); background: var(--ui-surface); }
.browser-bar-button { width: 28px; height: 28px; padding: 0; border-color: transparent; background: transparent; color: var(--ui-muted); }
.browser-bar-field { flex: 1; min-width: 0; }
.browser-bar-input { width: 100%; height: 28px; padding: 0 10px; font-size: 12px; }
.browser-bar-input[aria-invalid="true"] { border-color: var(--ui-danger); }
.browser-bar-error { margin: 4px 2px 0; font-size: 11px; color: var(--ui-danger); }
```

配色與圓角這一版沿用現有 token;整體視覺在後續的 Apple design 規格一起處理,這裡不另外設計。

Run: `npx vitest run tests/browser-bar.test.tsx`
Expected: PASS

- [ ] **Step 5: 空狀態元件**

```tsx
// src/renderer/components/BrowserEmpty.tsx
import type React from 'react'

export interface BrowserEmptyProps {
  readonly lastUrl: string | null
  readonly onOpen: (url: string) => void
}

/** 前景對話還沒有瀏覽器時顯示(每對話瀏覽器規格 §5.4)。此時主行程沒有 view 疊在上面。 */
export function BrowserEmpty({ lastUrl, onOpen }: BrowserEmptyProps): React.ReactElement {
  if (lastUrl === null) return <div className="browser-empty"><p>這個對話還沒開過瀏覽器</p></div>
  return (
    <div className="browser-empty">
      <p>上次停在 <span className="browser-empty-url">{lastUrl}</span></p>
      <button type="button" onClick={() => { onOpen(lastUrl) }}>開啟</button>
    </div>
  )
}
```

`BrowserBar.css` 檔尾加:

```css
.browser-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; padding: 24px; color: var(--ui-muted); font-size: 13px; text-align: center; }
.browser-empty p { margin: 0; }
.browser-empty-url { color: var(--ui-text); font-family: var(--ui-mono); font-size: 12px; overflow-wrap: anywhere; }
```

`BrowserEmpty.tsx` 開頭加 `import './BrowserBar.css'`。

- [ ] **Step 6: `PanelGroup` 的失敗測試**

`tests/panel-group.test.tsx` 的 `setup` 改成收第二個參數並傳 `browser`:

```tsx
function setup(collapsed: boolean, browser: Partial<PanelGroupProps['browser']> = {}) {
  // …原本的內容…
  const run = vi.fn(() => Promise.resolve({ ok: true as const }))
  const utils = render(<PanelGroup dragging={false} previews={[]} activeId="browser" onActivate={() => {}} onClose={() => {}} api={api} collapsed={collapsed}
    browser={{ state: undefined, lastUrl: null, run, ...browser }} />)
  return { sent, run, ...utils }
}
```

import 加 `type PanelGroupProps`。該檔其他直接 `render(<PanelGroup …/>)` 的地方都補上 `browser={{ state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }}`。加測試:

```tsx
  it('瀏覽器分頁在前景時有網址列;回報的矩形是網址列下方的內容區', () => {
    setup(false)
    expect(screen.getByRole('textbox', { name: '網址' })).toBeTruthy()
  })

  it('預覽分頁在前景時沒有網址列', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    stubRect()
    const api = { conversationTools: async () => ({ kind: 'error' as const, message: 'test' }), setBrowserBounds: () => {}, readPreview: async () => ({ kind: 'rejected' as const, message: 'x' }) }
    render(<PanelGroup dragging={false} activeId="p1" onActivate={() => {}} onClose={() => {}} api={api} collapsed={false}
      previews={[{ id: 'p1', title: 'a.md', revision: 0, source: { kind: 'file', path: '/a.md' } }]}
      browser={{ state: undefined, lastUrl: null, run: () => Promise.resolve({ ok: true }) }} />)
    expect(screen.queryByRole('textbox', { name: '網址' })).toBeNull()
  })

  it('沒有 session 且有 lastUrl:顯示「上次停在」,按開啟送 navigate', () => {
    const { run } = setup(false, { lastUrl: 'https://last.test/' })
    expect(screen.getByText('https://last.test/')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '開啟' }))
    expect(run).toHaveBeenCalledWith({ kind: 'navigate', url: 'https://last.test/' })
  })

  it('有 session 時不顯示空狀態', () => {
    setup(false, { state: { conversationId: 'c1', url: 'https://a.test/', title: '', loading: false, canGoBack: false, canGoForward: false } })
    expect(screen.queryByText('這個對話還沒開過瀏覽器')).toBeNull()
  })
```

`PreviewTab` 的欄位以 `src/renderer/previews.ts` 的型別為準,上面的 fixture 缺欄位時照型別補齊。

Run: `npx vitest run tests/panel-group.test.tsx`
Expected: FAIL

- [ ] **Step 7: 改 `PanelGroup.tsx`**

`PanelGroupProps` 加:

```ts
  readonly browser: {
    readonly state: BrowserStatePayload | undefined
    readonly lastUrl: string | null
    readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>
  }
```

函式參數解構加 `browser`。`<div className="panel-body" ref={body}>` 前面加:

```tsx
      {activeId === BROWSER_TAB_ID
        ? <BrowserBar state={browser.state} fallbackUrl={browser.lastUrl ?? ''} run={browser.run} />
        : null}
```

`.panel-body` 裡面的內容改成:

```tsx
        {activeId === BROWSER_TAB_ID && browser.state === undefined
          ? <BrowserEmpty lastUrl={browser.lastUrl} onOpen={(url) => { void browser.run({ kind: 'navigate', url }) }} />
          : null}
        {/* 原本 activePreview 那一段照舊 */}
```

`void browser.run(...)`:空狀態按鈕的失敗訊息不在這裡顯示。導航失敗時 session 不會建立,空狀態還在,人可以改用網址列再試一次並看到錯誤。

import `BrowserBar`、`BrowserEmpty` 與三個型別。

- [ ] **Step 8: 接上 `App.tsx`**

```tsx
  const browser = useBrowser(api)
  const activeProject = projects.view.projects.find((p) => p.id === projects.view.activeId)
  const foregroundId = foregroundConversationId(activeProject)
  const foregroundLastUrl = activeProject?.tabs.find((t) => t.id === foregroundId)?.lastUrl ?? null
```

該檔若已經有算出 active 專案或前景對話 id 的變數,就用現有的,不要重算。`<PanelGroup …>` 加 `browser={{ state: browser.stateOf(foregroundId), lastUrl: foregroundLastUrl, run: browser.run }}`。

`tests/app.test.tsx` 用的是 `tests/helpers/fake-yeschef.ts`(Task 2 已補方法),應該不用改。

- [ ] **Step 9: 跑測試**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 10: 實機確認**

Run: `npm run dev`

1. 新對話的右窗格顯示「這個對話還沒開過瀏覽器」。在網址列輸入 `example.com` 按 Enter。
   Expected: 頁面載入,網址列變成 `https://example.com/`,原生 view 沒有蓋到網址列。
2. 輸入 `hello world` 按 Enter。
   Expected: 輸入框下方出現「這不是網址」。
3. 點頁面上的連結,再按上一頁、下一頁、重新整理。
   Expected: 都有作用;載入中按鈕變成停止。
4. 拖動中間的分隔線、改變視窗大小、Cmd + 與 Cmd - 縮放。
   Expected: 原生 view 始終貼齊網址列下方,沒有 1px 的縫或重疊。

- [ ] **Step 11: Commit**

```bash
git add src/renderer tests/use-browser.test.tsx tests/browser-bar.test.tsx tests/panel-group.test.tsx
git commit -m "feat: add address bar and empty state to the browser panel"
```

---

### Task 9: 分頁與專案列上的瀏覽器記號

**Files:**
- Create: `src/renderer/browser-context.ts`
- Modify: `src/renderer/App.tsx`、`src/renderer/components/LeftPane.tsx`、`src/renderer/components/LeftPane.css`、`src/renderer/components/ProjectBar.tsx`、`src/renderer/components/ProjectBar.css`
- Test: `tests/left-pane.test.tsx`、`tests/project-bar.test.tsx`

**Interfaces:**
- Consumes:`Browser.sessions`(Task 8)
- Produces:`BrowserSessionsContext: React.Context<readonly BrowserSessionEntry[]>`,預設值 `[]`

用 context 而不是 props:`LeftPane` 與 `ProjectBar` 現有的測試不需要改,沒包 Provider 時就是沒有任何記號。

規格 §6 寫「對話分頁與側欄」。側欄列的是歷史紀錄,沒有每個對話的執行中標示可以比照;專案列已經有「專案裡有對話在執行」的記號,所以改放專案列。Task 10 會把規格那一句改成一致。

- [ ] **Step 1: 寫失敗的測試**

`tests/left-pane.test.tsx`,加在 `describe('LeftPane 對話分頁', …)` 裡面(`twoConvs`、`renderConv`、`WS`、`fakeProjects` 都是該檔現有的):

```tsx
import { BrowserSessionsContext } from '../src/renderer/browser-context.js'

  it('有瀏覽器的對話分頁顯示地球記號;正在被操作時標示為操作中', () => {
    render(
      <BrowserSessionsContext.Provider value={[{ conversationId: 'a-conv', busy: false }, { conversationId: 'a-conv2', busy: true }]}>
        <LeftPane projects={fakeProjects({ activeId: 'a', projects: [twoConvs] }).projects} renderConversation={renderConv} endpoint={WS} />
      </BrowserSessionsContext.Provider>
    )
    expect(screen.getAllByRole('img', { name: '有瀏覽器' })).toHaveLength(1)
    expect(screen.getAllByRole('img', { name: '瀏覽器操作中' })).toHaveLength(1)
  })

  it('沒有 Provider 時沒有任何瀏覽器記號', () => {
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [twoConvs] }).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(screen.queryByRole('img', { name: '有瀏覽器' })).toBeNull()
    expect(screen.queryByRole('img', { name: '瀏覽器操作中' })).toBeNull()
  })
```

`tests/project-bar.test.tsx`,加在 `describe('ProjectBar', …)` 裡面。`projectView('a')` 預設的對話分頁 id 是 `a-conv`(見 `tests/helpers/fake-yeschef.ts` 的 `projectView`;不是的話換成那裡實際的 id):

```tsx
import { BrowserSessionsContext } from '../src/renderer/browser-context.js'

  it('專案底下有對話的瀏覽器正在被操作時,專案格顯示記號', () => {
    render(
      <BrowserSessionsContext.Provider value={[{ conversationId: 'a-conv', busy: true }]}>
        <ProjectBar projects={fakeProjects(TWO).projects} />
      </BrowserSessionsContext.Provider>
    )
    expect(screen.getAllByRole('img', { name: '瀏覽器操作中' })).toHaveLength(1)
  })

  it('只有閒置的瀏覽器時,專案格不顯示記號', () => {
    render(
      <BrowserSessionsContext.Provider value={[{ conversationId: 'a-conv', busy: false }]}>
        <ProjectBar projects={fakeProjects(TWO).projects} />
      </BrowserSessionsContext.Provider>
    )
    expect(screen.queryByRole('img', { name: '瀏覽器操作中' })).toBeNull()
  })
```

Run: `npx vitest run tests/left-pane.test.tsx tests/project-bar.test.tsx`
Expected: FAIL,找不到 `browser-context.js`

- [ ] **Step 2: 實作**

```ts
// src/renderer/browser-context.ts
import { createContext } from 'react'
import type { BrowserSessionEntry } from '../shared/browser-ipc.js'

/** 哪些對話有瀏覽器、哪些正在被工具操作(每對話瀏覽器規格 §6)。沒包 Provider 就是空的。 */
export const BrowserSessionsContext = createContext<readonly BrowserSessionEntry[]>([])
```

`App.tsx`:在 `<PreviewContext.Provider …>` 外面包 `<BrowserSessionsContext.Provider value={browser.sessions}>`。

`LeftPane.tsx`:加一個同檔的小元件,並在 `TabStrip` 裡 `tab-busy` 那個 span 前面放 `<BrowserMark tabId={tab.id} />`。

```tsx
function BrowserMark({ tabId }: { readonly tabId: string }): React.ReactElement | null {
  const session = useContext(BrowserSessionsContext).find((s) => s.conversationId === tabId)
  if (session === undefined) return null
  const label = session.busy ? '瀏覽器操作中' : '有瀏覽器'
  return <span className={`tab-browser${session.busy ? ' is-busy' : ''}`} role="img" aria-label={label} title={label}><Icon name="globe" /></span>
}
```

`useContext` 與 `Icon` 若還沒 import 就加上。

`LeftPane.css` 加:

```css
.tab-browser { display: inline-flex; color: var(--ui-subtle); }
.tab-browser .ui-icon { width: 12px; height: 12px; }
.tab-browser.is-busy { color: var(--ui-info); animation: tab-browser-pulse 1.2s ease-in-out infinite; }
@keyframes tab-browser-pulse { 50% { opacity: .35; } }
```

`theme.css` 已經有 `prefers-reduced-motion` 的全域規則,這個動畫在減少動態效果的設定下會自動停掉。

`ProjectBar.tsx`:元件開頭加 `const browserSessions = useContext(BrowserSessionsContext)`,在 `project-busy` 那個 span 前面加:

```tsx
              {p.tabs.some((t) => browserSessions.some((s) => s.busy && s.conversationId === t.id)) ? (
                <span className="project-browser" role="img" aria-label="瀏覽器操作中" title="瀏覽器操作中"><Icon name="globe" /></span>
              ) : null}
```

`ProjectBar.css` 加:

```css
.project-browser { display: inline-flex; color: var(--ui-info); }
.project-browser .ui-icon { width: 12px; height: 12px; }
```

- [ ] **Step 3: 跑測試**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer tests/left-pane.test.tsx tests/project-bar.test.tsx
git commit -m "feat: mark conversations that own a browser"
```

---

### Task 10: 記憶體量測、實機驗收、規格同步

**Files:**
- Create: `spikes/measure-browser-sessions.ts`、`spikes/fixtures/session-page.html`
- Modify: `package.json`(加一個 script)
- Create: `docs/RESULTS-34-per-conversation-browser.md`
- Modify: `docs/specs/2026-09-21-per-conversation-browser-design.md`

- [ ] **Step 1: 固定的測試頁**

```html
<!-- spikes/fixtures/session-page.html -->
<!doctype html>
<meta charset="utf-8">
<title>session page</title>
<body>
<script>
  // 固定的工作量:2000 個節點加一個 1MB 左右的陣列。每次量測用同一份,不連外部網站。
  for (let i = 0; i < 2000; i++) {
    const el = document.createElement('p')
    el.textContent = `列 ${i} ` + 'x'.repeat(80)
    document.body.append(el)
  }
  window.__keep = Array.from({ length: 131072 }, (_, i) => i * 1.5)
</script>
```

- [ ] **Step 2: 量測腳本**

```ts
// spikes/measure-browser-sessions.ts
/**
 * 量每多一個 browser session 多用多少記憶體(每對話瀏覽器規格 §9.3)。
 * 用跟產品同一個 createAgentView 與 attachCdp,只是不起對話。
 * 輸出一行 JSON:{ page, counts: [{ sessions, totalKB }], perSessionKB }
 */
import { app, BaseWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// 這支腳本由 esbuild 打包成 cjs 再交給 electron 跑(見 package.json 的 spike:sessions),所以用 __dirname。
import { agentPartitionFor, createAgentView } from '../src/main/agent-view.js'
import { attachCdp } from '../src/main/cdp.js'

const COUNTS = [0, 1, 3, 6] as const
const SETTLE_MS = 3000
const page = process.argv.includes('--page=fixture')
  ? pathToFileURL(join(__dirname, 'fixtures/session-page.html')).href
  : 'about:blank'

const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
const totalKB = (): number => app.getAppMetrics().reduce((sum, p) => sum + p.memory.workingSetSize, 0)

async function main(): Promise<void> {
  await app.whenReady()
  const win = new BaseWindow({ width: 1200, height: 800, show: false })
  const counts: { sessions: number; totalKB: number }[] = []
  let made = 0
  for (const target of COUNTS) {
    while (made < target) {
      const view = createAgentView({ currentProjectDir: () => join(__dirname, 'fixtures'), logError: (e) => { console.error(e) } }, agentPartitionFor(`spike-${made}`))
      win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 1200, height: 800 })
      await view.webContents.loadURL(page)
      await attachCdp(view.webContents, { onListenerError: (e) => { console.error(e) } })
      made += 1
    }
    await wait(SETTLE_MS)
    counts.push({ sessions: target, totalKB: totalKB() })
  }
  const first = counts[0]
  const last = counts.at(-1)
  const perSessionKB = first === undefined || last === undefined ? 0 : Math.round((last.totalKB - first.totalKB) / last.sessions)
  console.log(JSON.stringify({ page, counts, perSessionKB }))
  app.quit()
}

main().catch((err: unknown) => { console.error(err); app.exit(1) })
```

`package.json` 的 scripts 加(照 `spike:oopif` 的寫法):

```json
    "spike:sessions": "esbuild spikes/measure-browser-sessions.ts --bundle --platform=node --format=cjs --external:electron --outfile=.spike-out/measure-browser-sessions.cjs && cp -R spikes/fixtures .spike-out/ && electron .spike-out/measure-browser-sessions.cjs",
```

打包後 `__dirname` 是 `.spike-out/`,fixture 從 `.spike-out/fixtures/` 讀,`cp -R` 就是為了這個。`tsconfig.json` 若因 `__dirname` 報型別錯誤,在腳本開頭加 `declare const __dirname: string`。

- [ ] **Step 3: 跑量測,每組兩次**

```bash
npm run spike:sessions                    # about:blank 第一次
npm run spike:sessions                    # about:blank 第二次
npm run spike:sessions -- --page=fixture  # 固定頁 第一次
npm run spike:sessions -- --page=fixture  # 固定頁 第二次
```

Expected: 每次輸出一行 JSON。四次之間不要改腳本或 fixture;改了就四次全部重跑。

- [ ] **Step 4: 實機驗收**

Run: `npm run build && npm start`

照規格 §9.2 的八項逐項做。第 2 項(cookie 隔離)的做法:在對話甲的網址列開 `https://example.com`,叫 agent 用 `view_eval` 執行 `document.cookie = 'probe=1; path=/'; document.cookie`;在對話乙開同一個網址,叫 agent 用 `view_eval` 執行 `document.cookie`。
Expected: 甲回傳含 `probe=1`,乙回傳不含。

- [ ] **Step 5: 寫結果文件**

`docs/RESULTS-34-per-conversation-browser.md`,內容三段:

1. 記憶體:一張表,四列(兩種頁面各兩次),欄位是 0、1、3、6 個 session 的 totalKB 與 perSessionKB;下面一句話寫兩次之間的差距,以及依這個數字是否建議加 view 數量上限、上限多少。
2. 實機驗收:§9.2 的八項,每項 ✓ 或 ✗,✗ 的寫實際看到什麼。
3. 已知限制:驗收時發現但這一版不處理的事,沒有就寫「無」。

數字直接貼腳本的輸出,不要四捨五入成「約幾百 MB」。

- [ ] **Step 6: 規格同步**

`docs/specs/2026-09-21-per-conversation-browser-design.md`:

- 狀態改成 `已實作,驗收見 docs/RESULTS-34-per-conversation-browser.md`。
- §4.4 最後兩句(「改成 session 建立時就記下…更新 `rootPath`。」)換成:「改成每個 session 用到專案目錄時,用自己的 conversationId 查目前所屬專案的 `rootPath`。`ViewToolDeps.activeProjectDir` 改名為 `projectDir`。每次重查,專案被重新指定資料夾時不需要另外同步。」
- §5.2 的表加一列:`browser:get`|renderer → main|renderer 重新載入後取回全部 session 的狀態,回傳 `{ states, sessions }`。並把 `browser:command` 那一列補上「用 invoke,回傳 `{ ok: true }` 或 `{ ok: false, message }`」。
- §5.3 第 2 條換成:「`協定://` 形式的,以及 `about:`、`javascript:`、`data:`、`blob:`、`mailto:` 開頭的,原樣往下,由白名單決定放不放行。」並把第 2、3 條對調順序(本機位址先判斷),加一句原因:`localhost:3000` 的形狀跟協定一樣。
- §6 的「對話分頁與側欄」改成「對話分頁與專案列」,後面補一句:專案列只在該專案有瀏覽器正在被操作時顯示。
- §7 最後一段改成:「`MSG.browserBusy` 已刪除。」
- §2 的「view 數量上限」那一列,依 Step 5 的結論更新。

- [ ] **Step 7: 覆蓋率**

Run: `npm run test:coverage`
Expected: 新增的六個檔案(`browser-url.ts`、`browser-ipc.ts`、`view-switch.ts`、`browser-sessions.ts`、`browser-commands.ts`、`conversation-server.ts`)行覆蓋率都在 80% 以上。不到的補測試。

- [ ] **Step 8: Commit**

```bash
git add spikes package.json docs
git commit -m "docs: record per-conversation browser acceptance and memory results"
```
