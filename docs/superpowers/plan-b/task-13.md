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

