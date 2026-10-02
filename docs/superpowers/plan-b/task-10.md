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
