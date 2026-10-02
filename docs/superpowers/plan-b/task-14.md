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

