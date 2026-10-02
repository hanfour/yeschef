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

