# 子專案 B 的型別契約（控制端定義，所有 task 必須照此）

本檔由控制端維護。任何 task 需要偏離此契約，必須在回報裡寫「契約疑慮」並取得裁決，不得自行更改。
規格：`docs/specs/2026-09-03-yeschef-b-view-tools-design.md`（下文簡稱「規格」）。契約與規格衝突時以本檔的裁決為準，裁決會回寫規格 §11。

## 0. 已查證的事實（2026-09-03，讀原始碼與 `node_modules` 確認）

| 事實 | 值 |
|---|---|
| SDK 版本 | `@anthropic-ai/claude-agent-sdk` 0.3.258 |
| `tool()` 簽章 | `tool<Schema extends AnyZodRawShape>(name, description, zodShape, handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>, extras?)` |
| `createSdkMcpServer()` 簽章 | `createSdkMcpServer({ name, version?, tools?, timeout? }): McpSdkServerConfigWithInstance` |
| `Options.mcpServers` 型別 | `Record<string, McpServerConfig>`；`McpSdkServerConfigWithInstance` 可直接當值 |
| `CallToolResult` 來源 | `@modelcontextprotocol/sdk/types.js` |
| 模型看到的工具名 | `mcp__<server name>__<tool name>`，例：`mcp__yeschef__view_click` |
| zod | SDK 的 peer dependency `^4.0.0`，`node_modules/zod` 已有 4.5.4，但 `package.json` 沒列 |
| `@modelcontextprotocol/sdk` | 1.30.0 已在 `node_modules`（SDK 的相依） |
| `canUseTool` 簽章（agent-host.ts） | `(toolName, toolInput, { toolUseID, title?, displayName? }) => Promise<SdkPermissionResult>` |
| Electron `debugger` message 事件 | `(event, method: string, params: unknown, sessionId: string)`；主 target 的 `sessionId` 是空字串 |
| `CdpSession`（cdp.ts 現況） | `send<T>(method, params?, sessionId?)`、`detach()`、`getAttachedTargets()`、`getRearmErrors()`；沒有事件訂閱 |
| `AttachedTargetInfo`（現況） | `{ targetId, type, url }`，沒有 `sessionId` |
| fold.ts 的 tool Block | `{ kind: 'tool', id, name, input, inputPartial?, result?, deniedReason?, raw?, status }`，`status` 是 `'streaming-input' \| 'awaiting-approval' \| 'denied' \| 'running' \| 'done' \| 'error'` |
| `Turn` / `Conversation` props | `{ view／turn, historical, renderToolExtra?: (block: ToolBlock) => ReactNode }`；`Turn` 是 `memo`，比較函式含 `renderToolExtra` 參考相等 |
| `MergerClock` | `{ now(), setTimer(fn, ms): unknown, clearTimer(handle) }`，`SYSTEM_CLOCK` 在 `src/main/agent-host.ts` |
| `IpcBridgeDeps` | `{ webContents, sessionOptions, sessions, logError, queryFn?, approvalTimeoutMs?, createHost?, createRegistry? }` |
| `AgentHostDeps` | `{ queryFn, sessionOptions, requestApproval, onBatch, onError, onEnded, merge?, clock? }` |
| session-machine effects | `'deny-all-approvals' \| 'interrupt-query' \| 'teardown-query' \| 'start-query' \| 'load-history'` |
| vitest coverage exclude | `src/**/*.d.ts`、`src/renderer/main.tsx`、`src/main/index.ts`、`src/main/agent-view.ts`（註解寫「子專案 B，本分支不碰」） |
| 探針（2026-09-03 實跑 `query()` 加一個 SDK MCP 工具） | `canUseTool` 對 SDK MCP 工具會被呼叫，`toolUseID` 等於 assistant 訊息裡 `tool_use` block 的 `id`；handler 的 `extra` 是 MCP SDK 的 `RequestHandlerExtra`，含 `signal: AbortSignal`、`requestId`、`_meta: { 'claudecode/toolUseId': <同一個 id>, progressToken }`；模型先叫了 `ToolSearch` 才找到 MCP 工具（MCP 工具預設是延遲載入） |
| `tests/agent-host.test.ts` 的 `manualClock()` | 檔內私有；`advance()` 不看到期時間，一次觸發全部 timer，不能拿來測 500ms 與 5 秒兩個 timer 並存的情況 |

## 1. 模組與檔案

```
src/shared/view-tools.ts            工具名稱常數（main 與 renderer 共用）
src/main/view-tools/policy.ts       viewToolPolicy()
src/main/view-tools/errors.ts       ViewToolError、訊息常數
src/main/view-tools/refs.ts         ref 解析與 RefTable
src/main/view-tools/keys.ts         view_press 按鍵表
src/main/view-tools/urls.ts         網址檢查（協定與 file:// 範圍）
src/main/view-tools/snapshot.ts     純函式：AX 樹 → Snapshot／RefTable／文字
src/main/view-tools/snapshot-collect.ts  用 CDP 蒐集 snapshot 所需輸入（frame、AX 樹、box、offset）
src/main/view-tools/settle.ts       網路靜默與 load 等待
src/main/view-tools/watch.ts        失效偵測、agentActing、InterventionLog
src/main/view-tools/handoff.ts      交接等待
src/main/view-tools/controller.ts   八個工具的實際動作（CDP）；Task 9 依 400 行上限拆成 controller-types／-core／-page／-input／-eval 五個子檔，對外匯出只從 controller.ts 轉出
src/main/view-tools/server.ts       createViewToolServer()：zod、tool()、錯誤包裝、ViewTools
src/main/cdp.ts                     加 onEvent、AttachedTargetInfo.sessionId、attachCdp 第二參數
src/main/session-args.ts            SessionOptions 加 mcpServers?
src/main/session-options.ts         工廠多收 mcpServers
src/main/agent-host.ts              AgentHostDeps 加 autoAllow?
src/main/ipc-bridge.ts              IpcBridgeDeps 加 viewTools?；handoff:done handler；teardown 前 abortPending
src/shared/ipc.ts                   IPC.handoffDone、HandoffDonePayload、parseHandoffDone、YesChefApi.handoffDone
src/preload/bridge.ts               handoffDone
src/renderer/components/relative-time.ts   加 formatElapsed()
src/renderer/components/HandoffCard.tsx／.css
src/renderer/components/Turn.tsx、Conversation.tsx   加 renderToolOverride?
src/renderer/App.tsx                接 HandoffCard
src/main/index.ts                   接線
tests/helpers/manual-clock.ts       manualClock()（看到期時間）
tests/fixtures/ax/*.json            getFullAXTree 的回傳（手寫一份與 CDP 形狀一致；實機再補一份真的）
tests/fixtures/view/*.html          實機驗收用頁面
spikes/capture-ax.ts                實機抓 AX 樹存成 fixture 的腳本
docs/RESULTS-05-b-view-tools.md     實機驗收結果
```

檔案上限 400 行（規格 §3 沒訂，沿用全域 coding-style 的 200 到 400 行；超過就拆）。

## 2. 共用常數（`src/shared/view-tools.ts`，Task 0 產出）

```ts
export const VIEW_TOOL_SERVER_NAME = 'yeschef'
export const VIEW_TOOL_PREFIX = `mcp__${VIEW_TOOL_SERVER_NAME}__`
export const VIEW_TOOL_NAMES = [
  'view_navigate', 'view_snapshot', 'view_screenshot', 'view_click',
  'view_type', 'view_press', 'view_eval', 'request_handoff',
] as const
export type ViewToolName = (typeof VIEW_TOOL_NAMES)[number]
/** 模型看到的完整名稱，例：fullToolName('view_click') === 'mcp__yeschef__view_click' */
export function fullToolName(name: ViewToolName): string
export const REQUEST_HANDOFF_TOOL = fullToolName('request_handoff')   // 'mcp__yeschef__request_handoff'
export const VIEW_EVAL_TOOL = fullToolName('view_eval')
```

renderer 只 import 這個檔（不 import `src/main/**`）。

## 3. 批准政策（`policy.ts`，Task 0 產出）

```ts
export type ToolDecision = 'allow' | 'ask'
/** 純函式。八個工具中除 view_eval 之外都 'allow'；其他任何名稱（含未知的 mcp__yeschef__xxx）都 'ask'。 */
export function viewToolPolicy(toolName: string): ToolDecision
```

白名單比對，不是前綴比對：`mcp__yeschef__view_eval` 與 `mcp__yeschef__somethingelse` 都回 `'ask'`。

## 4. cdp.ts 的新增（Task 1 產出）

### 裁決 1：cdp.ts 要動，加事件訂閱與 sessionId

規格 §9 寫 `cdp.ts` 不動，但 `CdpSession` 沒有任何事件訂閱，watch／settle 需要 `Page.frameNavigated`、`DOM.documentUpdated`、`Network.*`、`Page.loadEventFired`。三個新增都是加法，既有呼叫端不受影響：

```ts
export type CdpEventListener = (method: string, params: unknown, sessionId?: string) => void
export type Unsubscribe = () => void

export interface AttachedTargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  readonly sessionId: string        // 新增：對這個 target 下指令要用的 sessionId
}

export interface CdpSession {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>
  detach(): void
  getAttachedTargets(): readonly AttachedTargetInfo[]
  getRearmErrors(): readonly CdpError[]
  /** 新增。主 target 的事件 sessionId 為 undefined（Electron 給的空字串在這裡轉掉）。 */
  onEvent(listener: CdpEventListener): Unsubscribe
}

export interface AttachCdpOptions {
  /** listener 丟出的例外交到這裡；沒給就丟掉。listener 例外不得中斷 debugger 的 message 迴圈。 */
  readonly onListenerError?: (error: Error) => void
}
export async function attachCdp(wc: WebContents, opts?: AttachCdpOptions): Promise<CdpSession>
```

規則：

- `onEvent` 收到的是**每一則** debugger message，含 `Target.attachedToTarget`／`detachedFromTarget`（cdp.ts 自己處理完後照樣廣播）。
- listener 依註冊順序同步呼叫；一個丟例外不影響其他 listener。
- `detach()` 之後不再廣播；已註冊的 listener 由呼叫端自己解除（`dispose()` 時），cdp.ts 不代為清除。
- cdp.ts 仍只在 root 與每個子 target `enable` `Page` 與 `Runtime`。`DOM`／`Network`／`Accessibility` 由 view-tools 啟用（§9 裁決 5）。
- `getAttachedTargets()` 的既有欄位不變，只多 `sessionId`。

規格 §6.1「attachCdp 啟用四個域」與 §9「cdp.ts 不動」要改：由 Task 14 一併回寫規格 §11。

## 5. 資料結構（規格 §4 為基礎，以下為定稿）

放在 `src/main/view-tools/types.ts`（Task 0 產出，只有型別）：

```ts
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface Point { readonly x: number; readonly y: number }

export interface AxNode {
  readonly ref?: string               // 可操作角色才有；heading／image 沒有
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: Rect               // 主視窗 viewport 座標（已加 frame offset）
  readonly states: readonly string[]  // 見 §6 的 states 表
  readonly backendNodeId: number
  readonly sessionId?: string         // 主 target 與同行程 frame 為 undefined
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
  readonly unattachedFrames: number   // AX 樹抓不到的 frame 數（裁決 6）
  readonly truncated: number          // 超過 400 個節點時被截掉的數量
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

與規格 §4 的差異（Task 14 回寫規格）：`AxNode.ref` 改為選填、加 `backendNodeId`／`sessionId`；`RefEntry` 加 `role`／`name`（`view_click` 的回傳文字需要）；`Snapshot` 加 `title`／`scope`；`FrameSnapshot` 加 `frameId`／`url`。`HandoffPort` 由 §10 的 `ViewTools` 取代。

## 6. snapshot 純函式（`snapshot.ts`，Task 4 產出）

```ts
export interface AxRawNode {             // Accessibility.getFullAXTree 回傳的 nodes[] 元素，只列用到的欄位
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
  readonly offset: Point                          // OOPIF 才非零（裁決 7）
  readonly nodes: readonly AxRawNode[]
  readonly boxes: ReadonlyMap<number, Rect>       // backendNodeId → border 矩形（frame 自身座標，尚未加 offset）
}
export interface SnapshotInput {
  readonly id: number
  readonly takenAt: number
  readonly url: string
  readonly title: string
  readonly scope: 'viewport' | 'full'
  readonly viewport: Rect                         // { x: 0, y: 0, width, height }
  readonly frames: readonly FrameInput[]
  readonly unattachedFrames: number
}
export interface SnapshotResult {
  readonly snapshot: Snapshot
  readonly refs: RefTable
  readonly text: string
}
export const MAX_SNAPSHOT_NODES = 400
export const INTERACTIVE_ROLES: ReadonlySet<string>   // button link textbox searchbox combobox checkbox radio switch slider tab menuitem option listbox spinbutton
export const STRUCTURAL_ROLES: ReadonlySet<string>    // heading image
export function buildSnapshot(input: SnapshotInput): SnapshotResult
export function rectsIntersect(a: Rect, b: Rect): boolean
export function formatSnapshotText(snapshot: Snapshot, intervention?: string | null): string
```

規則（全部由 Task 4 的測試釘死）：

1. 走訪順序：每個 frame 從 `nodes[0]` 起依 `childIds` 深度優先（`nodes` 陣列本身的順序不可靠）。找不到的 childId 略過。
2. 候選節點：`ignored === false`，`role.value` 是字串且在 `INTERACTIVE_ROLES` 或 `STRUCTURAL_ROLES`，`backendDOMNodeId` 存在，且 `boxes` 有它的矩形（沒有矩形代表 `getBoxModel` 失敗，例如 `display: none`，直接略過）。`STRUCTURAL_ROLES` 另外要求 `name` 非空。
3. `bounds` = 矩形加上 frame `offset`。`scope === 'viewport'` 時 `rectsIntersect(bounds, viewport)` 為 false 的略過（邊緣相切算有交集，即 `a.x + a.width >= b.x` 這種閉區間比較）。
4. 依 frame 順序、frame 內依走訪順序累計；第 401 個起不收，`truncated` = 被丟掉的數量。
5. ref 編號 `e<n>`：n 從 0 起，只有 `INTERACTIVE_ROLES` 的節點配 ref 並遞增；structural 節點不佔號。
6. `states`：從 `properties` 取，順序固定為 `disabled, checked, unchecked, mixed, expanded, collapsed, selected, required, focused, readonly, pressed`；對應規則：`disabled === true` → `disabled`；`checked` 的值 `'true'`／`true` → `checked`、`'false'`／`false` → `unchecked`、`'mixed'` → `mixed`；`expanded === true` → `expanded`、`=== false` → `collapsed`；`selected === true`、`required === true`、`focused === true`、`readonly === true`、`pressed` 的值 `'true'`／`true` → `pressed`。其他 property 不看。
7. `value`：`value.value` 是字串且非空才帶。
8. `RefTable.entries` 的 key 是完整 ref（`s12-e7`），`invalidatedBy` 不設。

文字格式（`formatSnapshotText`）：

```
使用者在你上次操作後點了 3 次、按了 12 個鍵，網址從 <fromUrl> 變成 <url>   ← intervention 有給才有
[iframe 未附著 2 個]                                                          ← unattachedFrames > 0 才有
[page] <title> <url>
s12-e0 button "送出"
s12-e1 textbox "電子郵件" value="a@b.c" (required)
heading "訂單"
image "商品圖"
[iframe 1] <frame url>
s12-e2 link "說明"
（還有 37 個節點未列出，請縮小範圍或捲動後重拍）                            ← truncated > 0 才有
```

每個節點一行：`<ref> <role> "<name>"`，有 value 加 ` value="<value>"`，有 states 加 ` (<states 以、連接>)`；structural 節點沒有 ref 欄。`name` 與 `value` 裡的雙引號與換行以 `\"`、`\n` 逸出。第一個 frame 用 `[page]`，其餘用 `[iframe k]`（k 從 1 起）。

## 7. ref（`refs.ts`，Task 2 產出）

```ts
export interface ParsedRef { readonly snapshotId: number; readonly nodeIndex: number }
/** 't' 開頭不接受，只接受 /^s(\d+)-e(\d+)$/。格式錯回 null。 */
export function parseRef(ref: string): ParsedRef | null
export function formatRef(snapshotId: number, nodeIndex: number): string     // 's12-e7'
export const EMPTY_REFS: RefTable                                            // snapshotId 0、entries 空
export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable   // 回新表：同 snapshotId、entries 空、invalidatedBy = reason
export type RefLookup =
  | { readonly kind: 'ok'; readonly entry: RefEntry }
  | { readonly kind: 'bad-format' }
  | { readonly kind: 'stale'; readonly snapshotId: number; readonly reason: InvalidationReason | 'newer-snapshot' }
  | { readonly kind: 'missing'; readonly snapshotId: number; readonly ref: string }
export function lookupRef(table: RefTable, ref: string): RefLookup
```

`lookupRef` 規則：格式錯 → `bad-format`；`parsed.snapshotId !== table.snapshotId` → `stale`（reason `'newer-snapshot'`）；相等但 `table.invalidatedBy` 有值 → `stale`（reason 就是它）；相等、未失效、entries 沒有 → `missing`；否則 `ok`。全部純函式，不改輸入。

## 8. 按鍵表與網址檢查（Task 3 產出）

`keys.ts`：

```ts
export interface KeyDef {
  readonly key: string; readonly code: string; readonly windowsVirtualKeyCode: number
  readonly text?: string            // 有 text 的鍵用 keyDown，沒有的用 rawKeyDown（Puppeteer 的作法）
}
export const KEY_TABLE: ReadonlyMap<string, KeyDef>
export const KEY_NAMES: readonly string[]   // 供錯誤訊息列出，順序固定：Enter、Tab、Escape、Backspace、Delete、ArrowUp、ArrowDown、ArrowLeft、ArrowRight、Home、End、PageUp、PageDown、Space
export function lookupKey(name: string): KeyDef | null   // 大小寫敏感
```

| name | key | code | vk | text |
|---|---|---|---:|---|
| Enter | Enter | Enter | 13 | `\r` |
| Tab | Tab | Tab | 9 | |
| Escape | Escape | Escape | 27 | |
| Backspace | Backspace | Backspace | 8 | |
| Delete | Delete | Delete | 46 | |
| ArrowUp／Down／Left／Right | 同名 | 同名 | 38／40／37／39 | |
| Home | Home | Home | 36 | |
| End | End | End | 35 | |
| PageUp | PageUp | PageUp | 33 | |
| PageDown | PageDown | PageDown | 34 | |
| Space | ` `（空白字元） | Space | 32 | ` ` |

`urls.ts`：

```ts
export type UrlCheck =
  | { readonly kind: 'ok'; readonly url: string }            // 正規化後（new URL().href）
  | { readonly kind: 'bad-scheme' }
  | { readonly kind: 'outside-project'; readonly projectDir: string }
  | { readonly kind: 'invalid' }                              // new URL() 丟例外
export function checkNavigateUrl(raw: string, projectDir: string): UrlCheck
```

規則：`new URL(raw)` 失敗 → `invalid`；protocol 不在 `http:`／`https:`／`file:` → `bad-scheme`；`file:` 時 `fileURLToPath` 後 `path.resolve`，結果等於 `projectDir` 或以 `projectDir + path.sep` 開頭才 `ok`，否則 `outside-project`。`projectDir` 由呼叫端傳入時已是 realpath（index.ts 的 `requireProjectDir()` 已做）；目標檔不做 realpath（檔案可能還不存在）。

## 9. snapshot 蒐集、settle、watch、handoff

### 9.1 `snapshot-collect.ts`（Task 5 產出）

```ts
export interface CollectDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly currentUrl: () => string       // wc.getURL()
  readonly currentTitle: () => string     // wc.getTitle()
  readonly now: () => number
  readonly logError: (error: Error) => void
}
export const MAX_BOX_LOOKUPS = 1500
export async function collectSnapshotInput(deps: CollectDeps, id: number, scope: 'viewport' | 'full'): Promise<SnapshotInput>
```

### 裁決 5：域的啟用由 view-tools 做

`createViewToolServer` 建構時對 root `send('DOM.enable')`、`Network.enable`、`Accessibility.enable`；對 `getAttachedTargets()` 裡每個 `type === 'iframe'` 的 target 用其 `sessionId` 做同樣三個 enable；之後 `onEvent` 收到 `Target.attachedToTarget` 且 `targetInfo.type === 'iframe'` 時對新 `sessionId` 再做一次。非 `iframe` 的 target（auto-attach 也會附著 worker，worker 沒有 DOM 域）不送。enable 失敗記 `logError` 不丟出（target 可能在 enable 前就 detach）。這件事放在 `watch.ts`（它已經在聽 attachedToTarget）。

### 裁決 6：frame 的發現與 unattachedFrames 的定義

RESULTS-03 實測：root session 的 `Page.getFrameTree` 只列同行程的子 frame，OOPIF 不在裡面；OOPIF 只能從附著的 target 得知。

1. root session `Page.getFrameTree` → 遞迴攤平 `frameTree`（`frame.id`、`frame.url`、`frame.parentId`、`childFrames`），這些 frame 的 `sessionId` 為 undefined。
2. `getAttachedTargets()` 中 `type === 'iframe'` 的每個 target：`frameId = targetId`、`sessionId` 用它的；再對這個 session 呼叫 `Page.getFrameTree` 攤平，納入它裡面的同行程子 frame（`sessionId` 同這個 target）。
3. 每個 frame 呼叫 `Accessibility.getFullAXTree({ frameId })`：送到它的 `sessionId`（undefined 就是 root）。呼叫失敗（CdpError）的 frame 略過並計入 `unattachedFrames`，錯誤 `logError`。
4. `getRearmErrors()` 非空時 `unattachedFrames` 至少為 1（規格 §7：另加一行的資訊來源就是這個數字）。

規格 §7「N 由 frame 樹的 iframe 數減 getAttachedTargets() 數」改為上述定義（抓不到 AX 樹的就是沒附著的）。

### 裁決 7：座標與 offset

- `DOM.getBoxModel({ backendNodeId })` 送到該節點所屬 session；取 `model.border` 四點的最小外接矩形。回傳座標是**該 session 的頂層 frame** 的 viewport 座標：root session 的（含其同行程子 frame）就是主視窗座標，`offset = {0,0}`；OOPIF session 的（含其同行程子 frame）要加上這個 OOPIF 在主視窗裡的位置。
- `FrameInput.offset` = 該 frame 所屬 session 的 offset。`resolveFrameOffset(deps, sessionId)`：
  1. `getAttachedTargets()` 找 `sessionId` 對應的 `targetId` T。
  2. root `Target.getTargets()` 找 `targetId === T` 的 entry，取 `parentId ?? parentFrameId` 為 P（裁決 26：RESULTS-03 的探針就是這樣讀的，兩個欄位哪個有值尚未分開驗證；`getTargets` 回整個 browser context 的 target，所以要用 `targetId` 精確比對，不能拿清單順序當結構）。
  3. 父 session：`getAttachedTargets()` 中 `targetId === P` 的 `sessionId`；找不到（P 是頁面本身）就是 root。
  4. 在父 session `DOM.getFrameOwner({ frameId: T })` → `backendNodeId` → 同一個父 session `DOM.getBoxModel` → `content` 四點的左上角。
  5. `offset = 左上角 + resolveFrameOffset(父 session)`（父是 root 時為 `{0,0}`）。
  任一步失敗往外丟（CdpError 原樣；步驟 1 或 3 找不到 session／target → `CdpError` code `'frame-detached'`）。`collectSnapshotInput` 對每個 session 呼叫時自己 catch：該 session 的 offset 用 `{0,0}`、`logError`，frame 照常列入（refs 仍可用來 `view_type`）；click（裁決 9）不 catch，錯誤到工具端變成 `cdpFailed`，不拿 iframe 內座標去點主頁（裁決 29）。同一次 snapshot 內以 `sessionId` 快取，不重算：簽章為 `resolveFrameOffset(deps, sessionId, cache = new Map<string, Point>())`，第三參數選填，controller（裁決 9）用兩參數呼叫。root `Page.getFrameTree`／`Page.getLayoutMetrics` 失敗直接往外丟（CdpError，工具端變成 `cdpFailed`）；`cssVisualViewport` 形狀不對丟 `CdpError` code `invalid-response`。超過 `MAX_BOX_LOOKUPS` 時以 `nodes` 陣列順序取前 N 個。
- `viewport` 由 root `Page.getLayoutMetrics` 的 `cssVisualViewport.clientWidth／clientHeight` 取得，`x`、`y` 為 0。
- 候選節點（角色白名單且未 ignored）超過 `MAX_BOX_LOOKUPS` 時，多出的不查 box、不進 `boxes`（等同被 `buildSnapshot` 規則 2 略過）並 `logError` 一次。box 查詢逐個 `await`（不並發：一次幾百個 CDP 指令並發會讓 Electron debugger 排隊到逾時）。

### 9.2 `settle.ts`（Task 8 產出）

```ts
export const SETTLE_QUIET_MS = 500
export const SETTLE_TIMEOUT_MS = 5_000
export const NAVIGATE_TIMEOUT_MS = 8_000
export type SettleOutcome = 'quiet' | 'timeout' | 'aborted'
export interface SettleWaitOptions { readonly quietMs: number; readonly timeoutMs: number; readonly signal?: AbortSignal }
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

規則：

- 建構時 `cdp.onEvent` 訂閱；`dispose()` 解除。所有 session 的 `Network.*` 都算（iframe 的請求也會擋住互動）。
- `Network.requestWillBeSent`：`type === 'EventSource'` 不計（永不結束）；其他以 `requestId` 為鍵加入 inflight 集合，值帶 `sessionId` 與送出時間。`Network.loadingFinished`／`loadingFailed` **只比對 `requestId`**，不管事件來自哪個 session。同一個 `requestId` 重送（redirect）不重複加、不重設時間。
  - 裁決 30 原本要求鍵帶 `sessionId`（假設各 session 的 Network agent 各自編號），**已被實機推翻**：跨站 iframe 的文件請求由 root 送 `requestWillBeSent`、由子 session 送 `loadingFinished`，兩者的 `requestId` 相同。鍵帶 sessionId 會讓這種請求永遠配不到結束事件，`view_navigate` 對任何含 OOPIF 的頁面固定逾時（見 RESULTS-05 D 節第 2 項）。
  - 另設 `INFLIGHT_MAX_AGE_MS = 30_000` 的老化上限，處理真正永不結束的請求（SSE、長輪詢）：超過上限的條目在計算 inflight 時移除。上限刻意大於單次等待預算（`NAVIGATE_TIMEOUT_MS` 8 秒），當次等待寧可誠實逾時，也不用假靜默救它。
- `Page.frameNavigated` 且 `frame.parentId` 為 undefined 且 `sessionId` 為 undefined（root session 的主 frame 換頁；OOPIF session 自己的頂層 frame 也沒有 parentId，不算）時清空 inflight（舊頁的請求不會再有 finished）。
- `Target.detachedFromTarget`（root session 收到，`params.sessionId` 是走掉的子 session）→ 遍歷 inflight，移除值的 `sessionId` 等於走掉那個的項目：iframe 載入中被移除，它的請求不會再有 finished（裁決 30 的這個目的維持不變，只是比對方式從鍵前綴改成比對值）。
- `waitForQuiet` 呼叫當下 inflight 為 0 就從當下起算 quietMs，不是立刻回 quiet。
- 兩個計時器都用注入的 `clock`；resolve 後清掉另一個。`signal` 已 aborted 就立即回 `'aborted'`。
- `waitForLoad`：先等 `Page.loadEventFired` 或 `Page.navigatedWithinDocument`（都只認 `sessionId` 為 undefined 的那則；hash 與 SPA 的同文件導航只發後者，裁決 30），到了之後剩餘時間交給 `waitForQuiet`；兩者都沒到就回 `'timeout'`。

### 9.3 `watch.ts`（Task 6 產出）

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
  setRefs(table: RefTable): void                 // view_snapshot 成功後放入新表
  intervention(): InterventionLog
  /** 回傳目前的 log 並歸零：clicks／keys／navigations 為 0，fromUrl 為 webContents.getURL()。 */
  takeIntervention(): InterventionLog
  /** 工具動作期間呼叫；期間的 input-event 與 frameNavigated 不算使用者插手。可重入（計數）。 */
  runAsAgent<T>(fn: () => Promise<T>): Promise<T>
  dispose(): void
}
export function createWatcher(deps: WatchDeps): Promise<Watcher>       // async：建構時做裁決 5 的 enable
export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null
```

規則：

- `DOM.documentUpdated`（任何 session）→ `setRefs(invalidateRefs(refs, 'documentUpdated'))`。
- `Page.frameNavigated` 且主 frame（`frame.parentId` 為 undefined 且 `sessionId` 為 undefined，定義同 §9.2）→ 失效原因 `navigated`；非 agent 動作期間另 `navigations + 1`。
- `input-event`：`type === 'mouseDown'` → `clicks + 1`；`type === 'keyDown'` → `keys + 1`；兩者都使 refs 失效（`userInput`）。agent 動作期間（`runAsAgent` 內）一律不計、不失效。`type` 的其他值（mouseMove、mouseUp、keyUp、char、mouseWheel）不計。
- 失效只在 `refs().entries.size > 0` 或尚未失效時換新表；已失效的表不再重建（第一個原因保留）。
- `summarizeIntervention`：三個計數都是 0 → `null`；否則 `使用者在你上次操作後點了 <clicks> 次、按了 <keys> 個鍵，網址從 <fromUrl> 變成 <currentUrl>`；`fromUrl === currentUrl` 時最後一段改成 `網址仍是 <currentUrl>`；`navigations` 計數不進文字，只用來決定要不要提網址（`navigations === 0` 且網址相同時省略網址那段）。

規格 §6.3 文字只有一種形式，這裡多兩個變體（網址沒變）是為了不讓「網址從 A 變成 A」這種句子出現；Task 14 回寫規格。

### 9.4 `handoff.ts`（Task 7 產出）

```ts
export const HANDOFF_TIMEOUT_MS = 10 * 60_000
export const EARLY_DONE_MAX = 8
export interface HandoffWaitResult { readonly outcome: HandoffOutcome }
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
export function createHandoff(clock: MergerClock, logError: (error: Error) => void): Handoff
/** 從 MCP handler 的 extra 取 toolUseId（裁決 8）。取不到回 null。 */
export function readToolUseId(extra: unknown): string | null
```

### 裁決 8：toolUseId 從 handler 的 `extra._meta['claudecode/toolUseId']` 取

探針（§0）確認 MCP handler 的 `extra._meta` 帶 `claudecode/toolUseId`，值等於 `canUseTool` 的 `toolUseID` 與 `tool-use` 事件的 `id`。server.ts 用 handoff.ts 匯出的 `readToolUseId(extra): string | null`（`isRecord(extra) && isRecord(extra._meta) && isNonEmptyString(extra._meta['claudecode/toolUseId'])`）取出交給 `controller.requestHandoff(toolUseId, reason, signal)`；取不到丟 `ViewToolError(MSG.handoffNoId)`。規格 §6.4 的 `HandoffPort.expect` 不需要，`autoAllow` 是純政策。

## 10. 錯誤、controller、server

### 10.1 `errors.ts`（Task 0 產出）

```ts
/** 訊息已是給模型看的繁體中文，server.ts 直接回 isError 文字，不再包裝。 */
export class ViewToolError extends Error { readonly name = 'ViewToolError' }
export const MSG = {
  viewGone: '右窗格不存在',
  badScheme: '只接受 http、https、file 開頭的網址',
  invalidUrl: (raw: string) => `網址無法解析：${raw}`,
  outsideProject: (projectDir: string) => `只允許開啟 ${projectDir} 底下的本地檔案`,
  navigateFailed: (url: string, errorText: string) => `無法開啟 ${url}：${errorText}`,
  navigateTimeout: (url: string) => `頁面在 8 秒內未載入完成，目前網址 ${url}`,
  settleTimeout: (seconds: number) => `頁面在 ${seconds} 秒內未靜默，請 snapshot 確認狀態`,
  refFormat: 'ref 格式應為 s<數字>-e<數字>',
  refStale: (snapshotId: number, reason: string) => `snapshot s${snapshotId} 已過期（原因：${reason}），請先呼叫 view_snapshot`,
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

`refStale` 的 reason 字串：`documentUpdated`／`navigated`／`userInput` 照原字，`newer-snapshot` 改寫成 `已有更新的 snapshot`。

### 10.2 `controller.ts`（Task 9 產出）

```ts
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
export const CDP_CALL_TIMEOUT_MS = 10_000
export const EVAL_MAX_CHARS = 8_192
export const SCREENSHOT_MAX_WIDTH = 1_280
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

每個方法：進門先 `webContents.isDestroyed()` → 丟 `ViewToolError(MSG.viewGone)`，再 `signal.aborted` → 丟 `ViewToolError(MSG.sessionEnded)`；`waitForQuiet`／`waitForLoad` 回 `'aborted'` 一律丟 `sessionEnded`（裁決 28）；整個動作包在 `watcher.runAsAgent()` 裡（`requestHandoff` 例外：等待期間使用者的操作是預期的，不包）。所有 `cdp.send` 經 `call()`：用 `clock` 計 `CDP_CALL_TIMEOUT_MS` 逾時，逾時丟 `CdpError`（code `'timeout'`）。

各方法的固定流程（規格 §5 為基礎）：

| 方法 | 步驟 | 回傳 |
|---|---|---|
| `navigate` | `checkNavigateUrl` → 非 ok 丟對應 MSG；`Page.navigate({ url })`（root，url 是 `checkNavigateUrl` 正規化後的字串，`navigateFailed` 也用它）→ `errorText` 非空丟 `navigateFailed`；`settle.waitForLoad({ quietMs: 500, timeoutMs: 8000, signal })` → `timeout` 丟 `navigateTimeout(getURL())`、`aborted` 丟 `sessionEnded` | `navigated(getURL(), getTitle())` |
| `snapshot` | `id = 上次 + 1`（controller 內的計數器，從 1 起）；`collectSnapshotInput` → `buildSnapshot`；`watcher.setRefs(refs)`；`summary = summarizeIntervention(watcher.takeIntervention(), getURL())` | `formatSnapshotText(snapshot, summary)` |
| `screenshot` | `Page.getLayoutMetrics` 取 `cssVisualViewport` 寬高；`Page.captureScreenshot({ format: 'png', clip: { x: 0, y: 0, width, height, scale } })`，`scale = min(1, 1280 / width)` | `ToolImage`，`text` 為 `screenshot(round(width*scale), round(height*scale), url)` |
| `click` | `lookupRef(watcher.refs(), ref)` → bad-format／stale／missing 丟對應 MSG；`DOM.scrollIntoViewIfNeeded({ backendNodeId })`（entry.sessionId）；`DOM.getBoxModel`（失敗丟 `refDetached`）→ border 中心加 frame offset（裁決 9）；`Input.dispatchMouseEvent` mousePressed 與 mouseReleased（root，`button: 'left'`，`clickCount: 1`）；`settle.waitForQuiet({ 500, 5000, signal })` → timeout 丟 `settleTimeout(5)` | `clicked(role, name)`，`getURL()` 前後不同時再加一行 `urlChanged(url)` |
| `type` | lookup 同上；`DOM.focus({ backendNodeId })`（entry.sessionId）；`clear` → keyDown `a`（`modifiers: 4`，`commands: ['selectAll']`，vk 65，code `KeyA`）、keyUp，再 Backspace 走 §8 的 `dispatchKey` 規則（無 `text` 所以送 `rawKeyDown`／`keyUp`，與 `view_press('Backspace')` 相同）；`Input.insertText({ text })`（root）；`submit` → Enter keyDown／keyUp 後 `waitForQuiet` 同 click | `typed(text.length, role, name)`；submit 導航時加 `urlChanged` |
| `press` | `lookupKey(key)` 為 null 丟 `badKey`；`Input.dispatchKeyEvent`（root）`type` 依 `text` 有無選 `keyDown`／`rawKeyDown`，再 `keyUp`；`waitForQuiet` 同 click | `pressed(key)` |
| `evaluate` | `Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })`（root）；`exceptionDetails` 存在 → 丟 `ViewToolError(exceptionDetails.exception?.description ?? exceptionDetails.text)`；結果 `result.unserializableValue ?? JSON.stringify(result.value)`（`NaN`、`Infinity`、`1n` 只有 `unserializableValue`；`JSON.stringify` 回 undefined → `'undefined'`，裁決 28）；超過 8192 字元截到 8192 再接 `evalTruncated(原長)` | 文字 |
| `requestHandoff` | `handoff.begin(toolUseId, reason, signal)` → outcome `done` → `handoffDone(getURL())`、`timeout` → `handoffTimeout(getURL())`、`session-ended` → 丟 `ViewToolError(MSG.sessionEnded)` | 文字 |

### 裁決 9：OOPIF 的點擊座標

`RefEntry` 不存 offset。`click` 時若 `entry.sessionId` 有值，重新以裁決 7 的方式算一次該 session 的 offset（`Target.getTargets` 找父 target、父 session 的 `DOM.getFrameOwner` 與 `getBoxModel`）。理由：iframe 位置在 snapshot 之後可能因捲動而變，存下來的會過期。這段抽成 `snapshot-collect.ts` 的 `resolveFrameOffset(deps, sessionId): Promise<Point>` 給兩邊共用。

### 10.3 `server.ts`（Task 10 產出）

```ts
export interface ViewToolDeps {
  readonly view: WebContentsView            // 用到 view.webContents
  readonly cdp: CdpSession
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
}
export interface ViewTools {
  readonly server: McpSdkServerConfigWithInstance
  /** agent-host 的 canUseTool 先問這個：true 直接 allow。目前只是 viewToolPolicy(toolName) === 'allow'；toolUseId 保留給日後記錄用。 */
  autoAllow(toolName: string, toolUseId: string): boolean
  /** ipc-bridge 收到 handoff:done。 */
  handoffDone(toolUseId: string): void
  /** session 收尾：中止所有等待中的工具（settle、handoff）。reason 目前只用 MSG.sessionEnded。 */
  abortPending(reason: string): void
  dispose(): Promise<void>
}
export async function createViewToolServer(deps: ViewToolDeps): Promise<ViewTools>
```

規則：

- 工廠是 async：要等 `createWatcher`（裁決 5 的 enable）。
- zod shape 只宣告型別，值檢查在 controller（訊息才會是 `MSG` 的字）：`view_navigate { url: z.string() }`、`view_snapshot { scope: z.enum(['viewport','full']).optional() }`、`view_screenshot {}`、`view_click { ref: z.string() }`、`view_type { ref: z.string(), text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional() }`、`view_press { key: z.string() }`、`view_eval { expression: z.string() }`、`request_handoff { reason: z.string() }`。
- 每個工具的 description 是一句繁體中文（給模型看），寫在 server.ts 的常數表 `TOOL_DESCRIPTIONS`。
- 選填參數的預設值在 server 端補齊再呼叫 controller（裁決 27）：`view_snapshot` 的 `scope ?? 'viewport'`；`view_type` 的 `clear ?? false`、`submit ?? false`。
- 測試檔照 §14 一對一放 `tests/view-tools/server.test.ts`，測試把 `controller.ts` 模組 mock 掉。
- 每次 handler 呼叫建立一個 `AbortController`，放進 `inflight: Set<AbortController>`，結束移出；`abortPending()` 對全部 `abort()`。傳給 controller 的 signal 是 `AbortSignal.any([own.signal, extra.signal])`（`extra.signal` 存在且是 AbortSignal 才合併；Electron 44 的 Node 有 `AbortSignal.any`）。
- 八個 `tool()` 都帶 `extras: { alwaysLoad: true }`：探針顯示 MCP 工具預設延遲載入，模型要先叫 `ToolSearch` 才看得到；右窗格工具是主要功能，不該多一回合。
- 錯誤轉換（`toToolResult`）：`ToolOutput` → `{ content: [{ type: 'text', text }] }` 或 `{ content: [{ type: 'text', text }, { type: 'image', data, mimeType }] }`；`ViewToolError` → `{ content: [{ type: 'text', text: message }], isError: true }`；`CdpError` → `MSG.cdpFailed(code, message)`；其他 → `logError` 後 `MSG.internal(message)`。handler 永不 reject。
- `dispose()`：`abortPending(MSG.sessionEnded)`、`watcher.dispose()`、`settle.dispose()`、`handoff.abortAll()`，依這個順序。四步都是同步，宣告成 async 是為了 §13 index.ts 的 `.then(() => cdp.detach())`。不 `cdp.detach()`（cdp 是 index.ts 建的，index.ts 收）。
- `server` = `createSdkMcpServer({ name: VIEW_TOOL_SERVER_NAME, version: '0.1.0', tools: [...], timeout: HANDOFF_TIMEOUT_MS + 60_000 })`：SDK 的工具呼叫上限預設讀 `MCP_TOOL_TIMEOUT` 環境變數，明寫 11 分鐘讓 `request_handoff` 的 10 分鐘不受環境影響（裁決 32）。
- 不加序列化鎖、工具不設 `annotations`：Claude Code 對沒有 `readOnlyHint` 的 MCP 工具序列執行，同一則訊息的 `view_navigate` + `view_snapshot` 會依序跑（裁決 33；RESULTS-05 實機驗這一條）。

## 11. session options、agent-host、ipc-bridge、IPC、preload（Task 11、13 產出）

### 11.1 `session-args.ts`／`session-options.ts`（Task 13）

```ts
// session-args.ts
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
export interface SessionArgsInput { readonly projectDir: string; readonly appDir: string; readonly resumeSessionId?: string; readonly mcpServers?: Readonly<Record<string, McpServerConfig>> }
export interface SessionOptions { readonly cwd: string; readonly permissionMode: 'default'; readonly includePartialMessages: true; readonly resume?: string; readonly mcpServers?: Readonly<Record<string, McpServerConfig>> }
// session-options.ts
export function createSessionOptionsFactory(projectDir: string, appDir: string, sessions: Pick<SessionStore, 'cwdOf'>, mcpServers?: Readonly<Record<string, McpServerConfig>>): (resumeSessionId?: string) => SessionOptions
```

`mcpServers` 沒給時 `SessionOptions` 不帶這個 key（不是 `undefined` 值），既有測試的 `toEqual` 才不會受影響。

### 11.2 `agent-host.ts`（Task 13）

```ts
export interface AgentHostDeps {
  // …既有欄位不變
  /** 回 true 時 canUseTool 直接 allow，不進批准流程。預設一律 false。 */
  readonly autoAllow?: (toolName: string, toolUseId: string) => boolean
}
```

`canUseTool` 開頭：`if (deps.autoAllow?.(toolName, options.toolUseID) === true) return { behavior: 'allow', updatedInput: toolInput }`。`autoAllow` 丟例外視同 false 並 `onError`。其餘不動。

### 11.3 `ipc.ts`／`preload/bridge.ts`（Task 11）

```ts
// ipc.ts
export const IPC = { /* 既有 */ handoffDone: 'handoff:done' } as const
export interface HandoffDonePayload { readonly toolUseId: string }
export function parseHandoffDone(raw: unknown): HandoffDonePayload | null    // isRecord 且 toolUseId 是非空字串
export interface YesChefApi { /* 既有 */ handoffDone(toolUseId: string): void }
// preload/bridge.ts
handoffDone: (toolUseId) => { ipcRenderer.send(IPC.handoffDone, { toolUseId } satisfies HandoffDonePayload) },
```

### 11.4 `ipc-bridge.ts`（Task 13）

```ts
export type ViewToolHooks = Pick<ViewTools, 'autoAllow' | 'handoffDone' | 'abortPending'>
export interface IpcBridgeDeps { /* 既有 */ readonly viewTools?: ViewToolHooks }
```

- `ensureHost()` 建 host 時傳 `autoAllow: deps.viewTools?.autoAllow`（沒有 viewTools 就不傳這個 key）。
- `ipcMain.on(IPC.handoffDone, …)`：`parseHandoffDone` 失敗 → `rejectPayload`；成功 → `deps.viewTools?.handoffDone(toolUseId)`；沒有 viewTools 時 `logError(new Error('收到 handoff:done 但沒有 view tools'))`。
- `runEffect` 的 `'teardown-query'`：先 `deps.viewTools?.abortPending(MSG.sessionEnded)` 再 `host.teardown()`。`'interrupt-query'` 也先 `abortPending`（使用者換對話時進行中的等待要停）。
- `dispose()` 多解除 `handoffDone` handler。

規格 §7「AbortSignal 從 agent-host 的 teardown 傳進 controller」改為：bridge 在 teardown／interrupt effect 前呼叫 `abortPending`，server.ts 內部用 AbortController 傳給 controller。agent-host 不知道 view tools 的存在。

## 12. renderer（Task 11、12 產出）

### 裁決 2：fold.ts 不動，交接卡由工具名稱決定

規格 §6.4 說 fold 投影成 HandoffBlock。tool Block 已經有 `id`／`name`／`input`／`result`／`status`，足夠畫卡片，不需要新的 Block 種類。renderer 以 `block.kind === 'tool' && block.name === REQUEST_HANDOFF_TOOL` 判斷。

```ts
// relative-time.ts（Task 11）
/** 已等待時間。< 60_000 → '不到 1 分鐘'；否則 `${Math.floor(ms / 60_000)} 分鐘`。ms 為負或非有限數 → '不到 1 分鐘'。 */
export function formatElapsed(ms: number): string

// Turn.tsx／Conversation.tsx（Task 12）
export interface TurnProps {
  readonly turn: Turn
  readonly historical: boolean
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
  /** 回傳非 undefined 時取代預設的 ToolCall（整張卡）。 */
  readonly renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined
}
// Conversation 同樣多 renderToolOverride?，原樣傳給 Turn；Turn 的 memo 比較函式加 renderToolOverride 參考相等。

// HandoffCard.tsx（Task 12）
export interface HandoffCardProps {
  readonly block: ToolBlock
  readonly historical: boolean
  readonly onDone: (toolUseId: string) => void
  readonly now?: () => number           // 測試注入；預設 Date.now
}
export const HANDOFF_BUTTON_TEXT = '我好了'
export const HANDOFF_NOTIFIED_TEXT = '已通知'
export const HANDOFF_INCOMPLETE_TEXT = '未完成（對話中途結束）'
export const HANDOFF_PREPARING_TEXT = '準備交接…'
export const HANDOFF_NO_REASON_TEXT = '（未說明理由）'
export function HandoffCard(props: HandoffCardProps): JSX.Element
```

卡片內容：

| `block.status` | `historical` | 顯示 |
|---|---|---|
| `streaming-input` | 任一 | 標題「交接給使用者」、`HANDOFF_PREPARING_TEXT` |
| `running`、`awaiting-approval` | false | 標題、理由（`input.reason` 為非空字串才用，否則 `HANDOFF_NO_REASON_TEXT`）、`已等待 <formatElapsed(now - mountedAt)>`（每 30 秒重算）、按鈕 `HANDOFF_BUTTON_TEXT`；按下後 `onDone(block.id)` 一次，按鈕改成 disabled 的 `HANDOFF_NOTIFIED_TEXT` |
| `running`、`awaiting-approval` | true | 標題、理由、`HANDOFF_INCOMPLETE_TEXT`，無按鈕、無等待時間 |
| `done` | 任一 | 標題、理由、結果文字 |
| `error` | 任一 | 標題、理由、結果文字（class 加 `--error`） |
| `denied` | 任一 | 標題、理由、`deniedReason ?? '已拒絕'` |

結果文字的取法：`block.result` 是陣列且第一個元素 `{ type: 'text', text }` → 用 `text`；否則 `formatValue(block.result)`（`ToolCall.tsx` 既有）。

class 名：`.handoff-card`、`.handoff-card--pending`／`--done`／`--error`／`--stale`、`.handoff-card__title`、`.handoff-card__reason`、`.handoff-card__elapsed`、`.handoff-card__result`、`.handoff-card__button`。樣式在 `HandoffCard.css`，不動 `ApprovalCard.css`。

`mountedAt` 是掛載時 `useState(now)` 的惰性初始值，不在 props 或事件模型裡。modifier 與狀態的對應（裁決 25）：`streaming-input`、`running`／`awaiting-approval`（非 historical）→ `--pending`；`running`／`awaiting-approval`（historical）→ `--stale`；`done` → `--done`；`error`、`denied` → `--error`。文字歸屬：`HANDOFF_PREPARING_TEXT` 放 `__reason`；`HANDOFF_INCOMPLETE_TEXT`、`deniedReason ?? '已拒絕'` 與 done／error 的結果文字都放 `__result`。標題「交接給使用者」是模組內私有常數，不匯出。按鈕防連按用 ref 旗標（disabled 按鈕不會再收到 click，state guard 是死碼）。

App.tsx：`renderToolOverride = useCallback((block, historical) => block.name === REQUEST_HANDOFF_TOOL ? <HandoffCard block={block} historical={historical} onDone={api.handoffDone} /> : undefined, [api])`，傳給 `Conversation`。Composer 的 disabled 條件不變（交接中仍可打字）。

## 13. index.ts 接線（Task 14）

```ts
const INITIAL_AGENT_URL = 'about:blank'
export async function createWindow(): Promise<BaseWindow>
// createAgentView() 之後：
const cdp = await attachCdp(agentView.webContents, { onListenerError: logError })
const viewTools = await createViewToolServer({ view: agentView, cdp, clock: SYSTEM_CLOCK, projectDir, logError })
const sessionOptions = createSessionOptionsFactory(projectDir, app.getAppPath(), sessions, { [VIEW_TOOL_SERVER_NAME]: viewTools.server })
const bridge = createIpcBridge({ webContents, sessionOptions, sessions, logError, viewTools })
win.on('closed', () => { bridge.dispose(); void viewTools.dispose().then(() => cdp.detach()).catch(logError) })
```

`app.whenReady().then(() => createWindow())` 既有的 `.catch` 照樣接住 async 失敗。`attachCdp` 或 `createViewToolServer` 失敗屬啟動失敗：`logError` 後仍開視窗但不帶 `mcpServers`／`viewTools`（左窗格照常可用，右窗格只剩手動瀏覽），並在 console 印一行 `[yeschef] 右窗格工具停用：<message>`。失敗路徑（裁決 34）：`attachCdp` 失敗 → 沒有 cdp；`createViewToolServer` 失敗 → 先 `cdp.detach()`（失敗 `logError`）。兩種都走同一條無工具路徑：`createSessionOptionsFactory(projectDir, app.getAppPath(), sessions, mcpServers)` 與 `createIpcBridge({ webContents, sessionOptions, sessions, logError, viewTools })`，兩個參數在無工具路徑是 `undefined`；index.ts 端無條件傳，不寫成兩條呼叫（Task 13 兩處都用條件展開，傳 `undefined` 與不傳行為相同，裁決 35）。這段抽成可單元測試的函式（檔名與簽章由 Task 14 定，放 `src/main/view-tools/`）。`package.json` 的 `@anthropic-ai/claude-agent-sdk` 改精確版本 `0.3.258`：裁決 8 的 `_meta['claudecode/toolUseId']` 是私有欄位，升版前要重跑探針。

## 14. 測試與 fixture

- `tests/helpers/manual-clock.ts`（Task 0）：`export function manualClock(start = 0): { clock: MergerClock; advance(ms: number): void; now(): number }`。`setTimer` 記 `due = now + ms`；`advance(ms)` 把 `now` 推進，依 `due` 由小到大觸發所有 `due <= now` 的 timer（觸發中新排的 timer 若也到期，同一輪一併觸發）。`tests/agent-host.test.ts` 改 import 這個 helper 並刪掉檔內私有版本（行為相容：既有測試只用單一 timer）。
- 假 `CdpSession`（各 task 自建，形狀一致）：`{ send: vi.fn(), onEvent(listener) 記錄並回 unsubscribe, emit(method, params, sessionId?) 觸發, getAttachedTargets, getRearmErrors }`。Task 1 在 `tests/helpers/fake-cdp.ts` 提供 `createFakeCdp()`，之後的 task 一律 import 它，不重寫。
- `tests/fixtures/ax/form.json`（Task 4 手寫）：形狀與 `Accessibility.getFullAXTree` 一致（`{ nodes: AxRawNode[] }`），內容對應 `tests/fixtures/view/form.html`：一個 heading、兩個 textbox（一個 required、一個有 value）、一個 checkbox（checked）、一個 disabled button、一個 link、一個 `display: none` 的 button（AX 樹裡 ignored 或沒有 box）、一個 image 有 alt、一個沒有 alt 的 image。Task 14 用 `spikes/capture-ax.ts` 從實機抓 `form.real.json`，同一組測試對兩份 fixture 都要過（差異只能在 nodeId 與屬性順序）。
- 實機跨站 iframe fixture（裁決 34）：主頁 `http://localhost:<p1>/…`，iframe `src` 用 `http://127.0.0.1:<p2>/…`。同一 host 不同 port 是同一個 site，Chromium 不會切成 OOPIF，規格 §8.1 寫的「兩個本地 port」測不到 offset 路徑。驗收先以 `Target.getTargets()` 斷言出現 `type === 'iframe' && attached === true` 的 target，再測 offset。RESULTS-05 另加兩項：同一則訊息叫 `view_navigate` + `view_snapshot`，snapshot 要是新頁（裁決 33）；`MCP_TOOL_TIMEOUT=5000` 環境下 `request_handoff` 等超過 5 秒仍正常（裁決 32）。
- 測試檔一對一：`tests/view-tools/<module>.test.ts`；renderer 的用 `// @vitest-environment jsdom`。
- 判準沿規格 §8：coverage Stmts ≥ 93、Branch ≥ 86（`npm run test:coverage`），`tsc --noEmit` 0 error。vitest coverage exclude 保留 `agent-view.ts`，註解改為「純 Electron API 組裝，無可測邏輯」。
- 實機驗收以 25 項為判準表（規格 §8.2：至少 23 項 ✓，`view_click`、`view_type`、`request_handoff` 必須 ✓）；裁決 32／33／34 與規格 §10 新增的量測項另列「補充記錄」，記錄結果但不計入 23／25（裁決 37）。
- `tests/fixtures/view/form.html` 的 `<label>` 文字與 `<input>` 之間不留空白（Chromium 的可及名稱會帶尾端空白，實機 fixture 與手寫 fixture 的名稱就對不上）；這是 Task 4 建檔時就要做對的事，Task 14 只確認不修改（裁決 36）。

## 15. 裁決一覽

| 編號 | 內容 | 位置 |
|---|---|---|
| 1 | cdp.ts 加 `onEvent`、`AttachedTargetInfo.sessionId`、`attachCdp(wc, opts?)` | §4 |
| 2 | fold.ts 不動；renderer 以 `block.name === REQUEST_HANDOFF_TOOL` 判斷交接卡；`Turn`／`Conversation` 加 `renderToolOverride` | §12 |
| 3 | `ViewTools` 取代規格的 `HandoffPort`；`autoAllow` 是純政策 | §10.3 |
| 4 | zod 4 加為直接相依（`npm i zod@^4`）；`import { z } from 'zod'` | Task 0 |
| 5 | `DOM`／`Network`／`Accessibility` 由 watch.ts 啟用（root、既有 iframe target、之後附著的 target） | §9.1 |
| 6 | frame 發現：root 與每個 iframe target 的 `Page.getFrameTree` 聯集；`unattachedFrames` = AX 樹抓不到的 frame 數 | §9.1 |
| 7 | offset 以 session 為單位：root 為 0；OOPIF 由 `Target.getTargets` 的 `parentId` 找父 session，`getFrameOwner` + `getBoxModel` content 左上角遞迴相加 | §9.1 |
| 8 | handoff 的 toolUseId 從 handler `extra._meta['claudecode/toolUseId']` 取（探針已證實） | §9.4 |
| 9 | OOPIF 點擊時重算 offset，不存進 RefEntry | §10.2 |
| 10 | zod shape 只宣告型別，值檢查在 controller | §10.3 |
| 11 | AbortSignal 改由 bridge 在 teardown／interrupt effect 前呼叫 `viewTools.abortPending` | §11.4 |
| 12 | `view_type` 的 clear 用 `dispatchKeyEvent` 帶 `commands: ['selectAll']`（macOS 的 Meta+A 不會進 renderer 的編輯指令，要靠這個欄位）；實機驗收必測 | §10.2 |
| 13 | `view_navigate` 走 `Page.navigate`（不用 `wc.loadURL`）：同一條 CDP 路徑且拿得到 `errorText` | §10.2 |
| 14 | `cdp.send` 的 10 秒逾時在 controller 的 `call()` 做，不改 cdp.ts | §10.2 |
| 15 | 插手摘要三種變體（網址變／網址同／只有點鍵） | §9.3 |
| 16 | `manualClock` 抽到 `tests/helpers/manual-clock.ts` 並看到期時間；`createFakeCdp` 在 `tests/helpers/fake-cdp.ts` | §14 |
| 17 | 啟動時 CDP 或 view tools 建立失敗不阻止開視窗，只停用右窗格工具 | §13 |
| 18 | 規格 §4／§6.1／§6.3／§6.4／§7／§9 的差異由 Task 14 回寫規格 §11 修訂紀錄 | 各節 |
| 19 | 八個 `tool()` 帶 `alwaysLoad: true`；controller 的 signal 合併 `extra.signal` | §10.3 |
| 20 | ref 的 snapshotId 比目前表大仍是 `stale/newer-snapshot`，不另設原因（只會是 model 自己編的） | §7 |
| 21 | 主 frame 的判定統一為 `frame.parentId` 與 `sessionId` 都是 undefined；settle 與 watch 同一個定義。`SettleTracker.dispose()` 讓還在等的 waitFor* 以 `'aborted'` 結束 | §9.2、§9.3 |
| 22 | `formatSnapshotText` 第二參數收 `string \| null \| undefined`，controller 直接傳 `summarizeIntervention` 的結果；ref 的 `n` 從 0 起（`s12-e0`）；一個 frame 沒有節點仍印 frame 標頭；同一 snapshot 內 `nodeId` 重複或成環的節點只印一次 | §6 |
| 23 | IPC 鍵沿用既有 camelCase：`IPC.handoffDone`（值 `'handoff:done'`）；`YesChefApi.handoffDone` 是必填，Task 11 一併補 Plan A 三個測試檔（`app-title-bar`、`use-approvals`、`use-conversation`）的假 api | §11.3 |
| 24 | 域啟用只有 `DOM`／`Network`／`Accessibility`（root 與每個 iframe session）；`Page`／`Runtime` 由 cdp.ts 在 root 啟用，OOPIF session 不需 `Page.enable`（只用 root 主 frame 的 Page 事件；`getFrameTree` 不需 enable） | §9.1 |
| 25 | HandoffCard 的 modifier 對應、文字歸屬、私有標題常數、ref 旗標防連按（見 §12 表格下方） | §12 |
| 26 | 父 target 讀 `parentId ?? parentFrameId`（探針作法，Task 14 實機要記錄實際有值的欄位進 RESULTS-05）；`resolveFrameOffset` 第三參數 `cache` 選填；getFrameTree／getLayoutMetrics 失敗往外丟 | §9.1 |
| 27 | server 端補選填預設：`scope ?? 'viewport'`、`clear ?? false`、`submit ?? false`；`dispose()` 四步順序固定 | §10.3 |
| 28 | controller 進門檢查 `signal.aborted`、settle 回 `'aborted'` 都丟 `sessionEnded`；`navigateFailed` 用正規化網址；type 的 Backspace 走 §8 規則；evaluate 處理 `unserializableValue` 與巢狀 `exception.description`；controller 拆五個子檔 | §10.2、§1 |
| 29 | `resolveFrameOffset` 失敗往外丟（找不到 session → code `'frame-detached'`）；snapshot 端 catch 成 `{0,0}` + logError；click 端不 catch（fail closed） | §9.1 |
| 30 | settle 的 inflight key 為 `${sessionId ?? 'root'}:${requestId}`；`Target.detachedFromTarget` 清該 session；`waitForLoad` 也認 `Page.navigatedWithinDocument` | §9.2 |
| 31 | handoff `done()` 沒對上 pending 時記 `earlyDone`（上限 `EARLY_DONE_MAX = 8`），`begin()` 命中立即 done；`abortAll` 清空 | §9.4 |
| 32 | `createSdkMcpServer` 帶 `timeout: HANDOFF_TIMEOUT_MS + 60_000`，不受 `MCP_TOOL_TIMEOUT` 影響 | §10.3 |
| 33 | 不加序列化鎖、不設 annotations；依 Claude Code 對 MCP 工具的序列執行；RESULTS-05 實機驗 | §10.3、§14 |
| 34 | 實機跨站 fixture 用 `localhost` + `127.0.0.1`；啟動失敗路徑的清理與無工具路徑；SDK 版本改精確 `0.3.258` | §13、§14 |
| 35 | index.ts 無工具路徑無條件傳 `undefined` 給 `mcpServers`／`viewTools`，不寫兩條呼叫 | §13 |
| 36 | `form.html` 的 label 文字與 input 之間不留空白，源頭在 Task 4 改好；Task 14 不跨 task 修檔 | §14 |
| 37 | 實機驗收 25 項為判準表，裁決 32／33／34 與規格 §10 的量測項列補充記錄不計判準 | §14 |
