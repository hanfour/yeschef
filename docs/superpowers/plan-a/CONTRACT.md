# 子專案 A 的型別契約（控制端定義，所有 task 必須照此）

本檔由控制端維護。任何 task 需要偏離此契約，必須回報並取得裁決，不得自行更改。

## 已查證的 fixture 事實（2026-09-02，實機數過）

`tests/fixtures/events/03-sdk-live-stream.jsonl`，54 行，32 筆 `stream_event`：

| 子型別 | 筆數 | 首見行 | 關鍵欄位 |
|---|---:|---:|---|
| `message_start` | 2 | 11 | `message.id`（msg_011...）、`message.model` |
| `content_block_start` | 4 | 12 | `index`、`content_block.type`、`content_block.name` |
| `content_block_delta/thinking_delta` | 4 | 14 | `index`、`delta.thinking` |
| `content_block_delta/signature_delta` | 2 | 17 | `index`、`delta.signature` |
| `content_block_stop` | 4 | 19 | `index` |
| `content_block_delta/input_json_delta` | 4 | 21 | `index`、`delta.partial_json` |
| `message_delta` | 2 | 27 | `delta.stop_reason`、`usage` |
| `message_stop` | 2 | 28 | 無 |
| `content_block_delta/text_delta` | 8 | 42 | `index`、`delta.text` |

其他關鍵事實：

- `content_block` 的 `index` **每則訊息各自從 0 開始**（第 12 行 index=0、第 20 行 index=1、第 33 行又回到 index=0）。去重鍵必須是 `(messageId, index)`，不能只用 index
- `tool_use_result` 在 `user` 訊息的**頂層**，不在 `content` 裡（第 30 行）。形狀：`{stdout, stderr, interrupted, isImage, noOutputExpected}`。這是規格 §6「工具展開後看得到未經處理的 stdout/stderr」的唯一來源
- 8 筆 `text_delta` 串接為 466 字元，第 50 行的完整 `text` 也是 466 字元。**同一份內容會到達兩次**，`fold()` 必須去重否則畫面會渲染兩遍
- `tests/fixtures/events/04-session-history.jsonl` 是 `getSessionMessages()` 的真實產物，6 則，型別只有 `user` 與 `assistant`，`message` 形狀為 `{role, content}`，頂層另有 `timestamp`（`.d.ts` 未宣告）

## Event（Task 3 產出，Task 4／8／11 讀取）

```ts
export type Event =
  | { kind: 'session-start'; sessionId: string; cwd?: string; model?: string }
  | { kind: 'message-start'; messageId: string; model?: string }
  | { kind: 'block-start'; messageId: string; index: number
      blockType: 'text' | 'thinking' | 'tool_use'
      toolName?: string; toolUseId?: string }
  | { kind: 'text-delta';         messageId: string; index: number; text: string }
  | { kind: 'thinking-delta';     messageId: string; index: number; text: string }
  | { kind: 'tool-input-delta';   messageId: string; index: number; partialJson: string }
  | { kind: 'block-stop';         messageId: string; index: number }
  // 完整快照。live 路徑在 delta 之後才到，歷史路徑只有這些。
  | { kind: 'text';     messageId?: string; index?: number; text: string }
  | { kind: 'thinking'; messageId?: string; index?: number; text: string }
  | { kind: 'tool-use'; messageId?: string; index?: number
      id: string; name: string; input: unknown }
  | { kind: 'tool-result';     id: string; content: unknown; isError: boolean }
  | { kind: 'tool-raw-output'; id: string; stdout: string; stderr: string; interrupted: boolean }
  | { kind: 'user-text';       text: string }
  | { kind: 'permission-denied'; toolName: string; toolUseId: string; message?: string }
  | { kind: 'session-end'; isError: boolean
      costUsd?: number; numTurns?: number; apiErrorStatus?: unknown
      errorMessage?: string }                       // 裁決 17
  | { kind: 'reset' }                                // 裁決 22：main 合成，normalizer 不產出
  | { kind: 'unknown'; raw: unknown }
```

**硬性規則：認不出來的輸入一律產出 `unknown`，不得回空陣列丟棄。**

但要區分兩種情況，這條線在 2026-09-02 的裁決 1 確立：

| 情況 | 處置 |
|---|---|
| **認得出來但沒有可渲染內容** | 回空陣列，並在程式碼註解寫明為什麼 |
| **認不出來** | 產出 `unknown` |

「認得出來但無內容」的清單（窮舉，新增必須經裁決）：`system` 的 hook／status／thinking_tokens 子型別、`rate_limit_event`、`signature_delta`（thinking 的簽章，不可顯示）、`message_delta`（stop_reason 與 usage，統計併入 `session-end`）、`message_stop`。

裁決理由：原本只列兩類，導致一場兩輪對話會產生 6 張原始 JSON 卡片（`signature_delta` ×2、`message_delta` ×2、`message_stop` ×2）。那不是「讓人知道有東西沒處理」，是雜訊。

### 裁決 2（2026-09-02）：`normalizeLive` 不是純函式，改用游標

實機確認：`content_block_start` / `content_block_delta` / `content_block_stop` **不帶 message id**，只有 `message_start` 帶（fixture 03 的第 11、32 行）。所以 delta 類事件的 `messageId` 無法從自身取得。

正式介面改為**呼叫端持有游標**，與 Task 5 的狀態機同一個模式（純函式加上呼叫端持有狀態）：

```ts
export interface LiveCursor {
  readonly messageId: string   // 尚未收到 message_start 時是空字串
  readonly model?: string
  readonly openIndex: number   // 當下開著的 content block 索引，沒有時是 -1
}
export interface LiveStep {
  readonly events: readonly Event[]
  readonly cursor: LiveCursor
}
export const INITIAL_CURSOR: LiveCursor = { messageId: '', openIndex: -1 }
export function stepLive(msg: unknown, cursor: LiveCursor): LiveStep
```

（2026-09-02 依 Task 3 定稿修訂：`openIndex` 是因為 `content_block_delta` 在部分 SDK 版本也不帶 `index`，
游標要記住開著的 block；`messageId` 用空字串而不是 `undefined`，讓 `INITIAL_CURSOR` 是一個完整物件。）

**不得使用 module 層級的可變狀態，也不得提供依賴這種狀態的包裝函式**（例如舊版的 `normalizeLive()` 與
`resetLiveNormalizer()`）。游標由 Task 8 的 agent-host 持有，每個 session 一份，切換 session 時重建。
測試需要「一次餵整段 fixture」時，用 `tests/helpers/live-events.ts` 的純函式
`liveEvents(msgs: readonly unknown[]): readonly Event[]`（從 `INITIAL_CURSOR` 起以 `stepLive` 逐則歸約），
Task 3 建立，Task 4／4B 的測試共用。

`normalizeHistory` 維持純函式，不需要游標。assistant 行的 `messageId` 取 `message.id`（API 訊息 id），不取每行的
`uuid`：歷史檔把一則 API 訊息的每個 content block 各寫成一行 `SessionMessage`，每行有自己的 `uuid`；fixture 04 的
4 行 assistant 只有 2 個 `message.id`，用 `uuid` 會把一個回合拆成兩個 turn。（2026-09-02 codex 第二輪抓到本段原本
寫成「用 `uuid`」，與 Task 3 的實作和測試不符，依 fixture 改正；Task 3 只補註解與一組斷言。）

### 裁決 3（2026-09-02）：`tool_use_result` 有兩種形狀

實測：fixture 01／03 是物件 `{stdout, stderr, interrupted, isImage, noOutputExpected}`，fixture 02（權限拒絕）是**純字串**。

轉接器要統一成同一種：字串形式當作 `stdout`，`stderr` 空字串，`interrupted` false。

### 裁決 4（2026-09-02）：歷史對話沒有原始輸出，這是已知限制

`getSessionMessages()` 的產物不含 `tool_use_result`，所以 `tool-raw-output` 是 live 專屬。規格 §6 的「工具展開後看得到未經處理的 stdout／stderr」在檢視歷史對話時不存在。

Task 11 必須知道：歷史對話的工具呼叫展開後要顯示「這是歷史對話，沒有保存原始輸出」，不得顯示空的展開區塊讓人以為工具沒有輸出。

## ConversationView（Task 4 產出，Task 9／10／11 讀取）

```ts
export interface ConversationView {
  readonly sessionId?: string
  readonly turns: readonly Turn[]
  readonly cost?: { readonly usd?: number; readonly turns?: number }
  readonly ended: boolean
}

export interface Turn {
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
  readonly blocks: readonly Block[]
}

export type Block =
  | { kind: 'text';     markdown: string; complete: boolean }
  | { kind: 'thinking'; text: string;     complete: boolean }
  | { kind: 'tool'
      id: string; name: string
      input: unknown            // 完整快照到達後才有值
      inputPartial?: string     // input_json_delta 的累積，串流中顯示用
      result?: unknown
      raw?: { stdout: string; stderr: string; interrupted: boolean }
      deniedReason?: string     // 裁決 12：status 為 denied 時的拒絕理由，result 維持 undefined
      status: 'streaming-input' | 'awaiting-approval' | 'denied' | 'running' | 'done' | 'error' }
  | { kind: 'unknown'; raw: unknown }
```

**去重規則**：同一個 `(messageId, index)` 的完整快照到達時，**取代**由 delta 累積出來的內容，不是附加。理由是兩者是同一份內容的兩種送達方式。

**`complete` 的來源**（2026-09-02 裁決 5 修訂）：

| 情況 | complete |
|---|---|
| live 路徑收到該 block 的 `block-stop` | `true` |
| live 路徑收到 `session-end`（整場結束，不會再有內容） | 其餘所有 block 一律 `true` |
| 歷史路徑（`normalizeHistory` 產出） | `true`。歷史訊息已持久化，依定義是完成的 |
| 使用者的訊息（`user-text`） | `true`。使用者按下送出時它就完成了 |
| 其餘 | `false` |

裁決理由：原本只寫「`block-stop` 是唯一來源」，導致歷史對話的每一個 block 都是 `complete: false`，UI 會在一段早就結束的對話尾端畫游標。Task 4 的撰寫者發現並回報。

## IPC 契約（Task 8 定義，Task 9／10／11 讀取）

2026-09-02 裁決 6、7 修訂後：

```ts
export const IPC = {
  eventsBatch:   'agent:events',          // main → renderer，Event[] 批次
  userInput:     'agent:input',           // renderer → main，string
  approvalAsk:   'agent:approval:ask',    // main → renderer，ApprovalAskPayload（裁決 11／28）
  approvalReply: 'agent:approval:reply',  // renderer → main，{ requestId, decision }
  sessionList:   'session:list',          // renderer → main，回 SessionSummary[]（非 SDK 型別）
  sessionState:  'session:state',         // main → renderer，SessionState
  // 意圖頻道（裁決 6）。renderer 送意圖，不送 effect。
  intentStartNew:    'session:intent:start-new',     // renderer → main，無 payload
  intentOpenHistory: 'session:intent:open-history',  // renderer → main，{ sessionId }
} as const
```

`SessionSummary` 是本專案自訂的窄型別，不得讓 SDK 的 `SDKSessionInfo` 穿過 IPC：

```ts
export interface SessionSummary {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly gitBranch?: string
}
```

### 裁決 6（2026-09-02）：session 狀態機搬到主程序

**Task 5 的檔案位置從 `src/renderer/session-machine.ts` 改為 `src/main/session-machine.ts`。** 函式本身完全不變（純函式），改的只是誰持有它。

問題（Task 8 撰寫者回報）：狀態機在 renderer，但它產出的 `start-query`／`interrupt-query`／`teardown-query` 全部是主程序的操作，而 IPC 頻道裡沒有它們的入口。main 只能從 `agent:input` 與 `session:open` 反推意圖，造成兩個後果：從 `viewing` 開一條全新對話做不到；三步收尾的順序在 renderer 與 main 各有一份。

後者尤其糟：把收尾做成 effects 陣列的**唯一理由**就是讓順序集中在一處且可測，分成兩份等於白做。

新的分工：

| 角色 | 職責 |
|---|---|
| renderer | 送**意圖**（`start-new`／`open-history`／`user-input`），不送 effect。從 `session:state` 收狀態更新用於畫面 |
| main | 持有 `SessionState`，收到意圖呼叫 `transition()`，照 effects 陣列順序執行，然後把新狀態推回 renderer |

判斷錯的代價：狀態機的單元測試不受影響（純函式），要改的只有 import 路徑與呼叫端。

### 裁決 7（2026-09-02）：SDK 型別不得穿過 IPC

`session:list` 原本寫回 `SDKSessionInfo[]`。改為本專案自訂的 `SessionSummary[]`，由 main 側轉換。

理由與正規化層（裁決 2）同一個：SDK 型別是外部契約，讓它穿過 IPC 等於把 SDK 版本變動的衝擊直接傳到 UI。

### 裁決 8（2026-09-02）：批准 payload 的形狀重複，接受現行緩解

`ApprovalAskPayload`（Task 8）與 `ApprovalRequest`（Task 6）是兩份同形狀宣告，靠賦值時的型別標註擋漂移。

接受。理由是 Task 6 的 `approval.ts` 在 `src/main/`，而 `shared/ipc.ts` 不應反向依賴 main。型別標註的賦值檢查足以在編譯期抓到漂移。

## 全域約束（每個 task 都適用）

見計畫的 Global Constraints 一節。特別強調兩條：

1. **每個含測試的 task 必須做突變測試**：把實作換成錯誤版本、確認測試變紅、還原確認回綠，兩次輸出貼進報告。本計畫的前三個 task 在審查中全部被證明測試可被錯誤實作滿足。
2. **不得靜默丟棄**：認不出來的事件、失敗的 promise、解析不了的內容，一律要有可見的產出。


### 裁決 9（2026-09-02）：Electron 維持兩欄，Task 7 不需要

Task 9 的撰寫者對照規格 §3 的架構圖提出：「左＋中窗格」是**一個** React renderer，
內含 Recents 側邊欄與對話；右窗格是獨立的 `WebContentsView`。所以 Electron 層只切兩塊。

判定：正確。側邊欄與對話的分割是 React 內部的 CSS grid，不經過 Electron 的 view 幾何，
也不需要 IPC。拖曳側邊欄寬度是純 CSS 的事。

**後果：Task 7（layout 擴三欄）不進計畫。** 既有的 `splitBounds` 已經夠用，不需要
`splitThreeBounds`，既有 6 個測試維持原樣。

`task-7.md` 保留在 `docs/superpowers/plan-a/` 供日後參考（若之後真的要把側邊欄做成獨立
的 WebContentsView，那份設計可以直接用），但不組裝進計畫。

它的一個發現與 task 存廢無關、仍然成立：測試參數若讓正確實作與錯誤實作巧合給出
同一個答案，突變就測不到。那條已記在本檔的發現清單裡。

判斷錯的代價：若日後側邊欄需要獨立的 WebContentsView（例如要讓它能被 CDP 操控），
把 `task-7.md` 拿回來即可，設計已經寫好且驗算過。

### 裁決 10（2026-09-02）：Markdown 元件收原始值不收物件

Task 9 的決策，控制端確認：`Markdown` 的 props 是 `markdown: string` 與
`complete: boolean` 兩個原始值，不是整個 `Block` 物件。

理由：`fold()` 是純函式，每幀產生新的 `Block` 物件識別碼。prop 若是物件，
`React.memo` 的淺比較每次都不相等，memo 完全失效。逐字串流下這是每秒數十次的
整棵子樹重繪。

Task 9 已用突變（`useMemo` 的 deps 改成 `[]`）驗證這條測得到。


### 裁決 11（2026-09-02）：批准請求無法帶 toolUseId，改用內容比對

> 2026-09-02 晚間作廢，由裁決 28 取代：重查 `sdk.d.ts`（0.3.252 與 0.3.258 皆同，第 248 行）
> 確認 `CanUseTool` 的 options 有必填的 `toolUseID: string`，下面「不含 tool_use_id」的前提是錯的。
> 保留原文只為了讓已讀過的人知道改了什麼；payload 帶 `title`／`displayName` 的部分仍然有效。

Task 4B 指出 `approvalAsk` 沒有 `toolUseId`，Task 9 無從對應到正確的 Block。

實查 SDK 型別後確認：**`CanUseTool` 的 options 不含 tool_use_id**，只有
`signal`、`suggestions`、`blockedPath`、`decisionReason`、`title`、`displayName`。
所以這個缺口不能靠加欄位解決。

對應方式改為：**`toolName` 加 `input` 深度相等**，比對範圍限定在尚未收到
`tool-result` 的 tool block。

已知特殊情況：同一輪裡對同一個工具用完全相同的參數呼叫兩次，會標到其中任意一個。
判定為可接受，因為兩者完全相同，標錯無實質後果。

**同時修正 approvalAsk 的 payload**，帶上 SDK 提供的兩個欄位：

```ts
interface ApprovalAskPayload {
  readonly requestId: string
  readonly toolUseId: string     // 裁決 28 補上：來自 CanUseTool options 的 toolUseID
  readonly toolName: string
  readonly input: unknown
  readonly title?: string        // SDK 產的完整提示句，官方建議優先用它
  readonly displayName?: string  // 短名詞片語，適合按鈕標籤
}
```

規格 §6 原本寫「顯示工具名稱與完整 input」。改為：有 `title` 就用 `title`，
沒有才退回工具名稱加 input。SDK 的註解明說不要自己從 toolName 加 input 重建提示文字。

### 裁決 12（2026-09-02）：Block.tool 新增 deniedReason

Task 4B 目前把拒絕的訊息塞進 `result`，因為 `Block.tool` 沒有專門欄位。

新增 `deniedReason?: string`。理由是 `result` 的語意是工具的執行結果，而被拒絕的
工具根本沒有執行，兩者混用會讓 UI 無從分辨「工具跑完回傳了這段文字」與「工具被擋下來，
這是擋下來的理由」。

### 裁決 13（2026-09-02）：歷史對話裡沒有 tool_result 的工具呼叫視為 done

Task 4B 指出歷史對話若缺 `tool_result`，狀態會永遠停在 `running`。

與裁決 5 同一個道理：歷史訊息已持久化，依定義是完成的。歷史路徑產出的 tool block
若沒有對應的 `tool-result`，狀態設為 `done`，`result` 留空，UI 顯示「無保存的結果」。

live 路徑不適用此規則：live 的 `running` 是真的還在跑。

### 裁決 14（2026-09-02）：`SessionState` 物件穿 IPC，型別搬到 shared；`YesChefApi` 定稿

裁決 6 把狀態機搬進 main 後，renderer 要知道的不只是 `'idle' | 'live' | 'viewing'` 三個字，
還要知道**正在看哪一場**（Recents 要標示目前選中的那一筆，裁決 4 的歷史文案要靠 `viewing` 判斷）。
所以 `session:state` 的 payload 改為 Task 5 的 `SessionState` 物件，不是字串。

型別位置：`SessionState` 從 `src/main/session-machine.ts` 搬到 `src/shared/session-state.ts`
（只有型別，五行）。Task 5 與 Task 8 都從那裡 import；shared 不反向依賴 main。

`window.yeschef` 的定稿形狀（Task 8 產出，取代 task-8.md 內的舊版）：

```ts
export interface YesChefApi {
  onEvents(cb: (events: readonly Event[]) => void): Unsubscribe
  onApprovalAsk(cb: (request: ApprovalAskPayload) => void): Unsubscribe
  onSessionState(cb: (state: SessionState) => void): Unsubscribe
  sendInput(text: string): void
  replyApproval(reply: ApprovalReplyPayload): void
  listSessions(): Promise<readonly SessionSummary[]>
  startNew(): void                      // → IPC.intentStartNew
  openHistory(sessionId: string): void  // → IPC.intentOpenHistory
  readonly projectDir: string           // 裁決 21：YESCHEF_PROJECT_DIR 的原字串，preload 從 process.argv 取
}
```

`openSession` 與 `session:open` 頻道作廢。`parseSessionState` 改為驗證物件形狀
（`kind` 三選一；`viewing` 必有非空 `sessionId`；`live` 的 `sessionId` 可省略）。

`window.yeschef` 的全域型別宣告放在 `src/renderer/global.d.ts`（Task 8 建立），內容：
`declare global { interface Window { readonly yeschef: YesChefApi } }`。

### 裁決 15（2026-09-02）：`session-end` 是唯一的「收尾」訊號，歷史載入時補一筆

裁決 5 的表格列了四種 complete 來源，裁決 13 又為歷史工具加了一條。實作上這些都要
`fold()` 知道事件「來自哪條路徑」，而 Event 型別裡沒有這個欄位，加了就是為特殊情況開洞。

改為一條規則：**`fold()` 收到 `session-end` 時，所有 text／thinking block 設 `complete: true`，
所有 `running` 的 tool block 設 `status: 'done'`（`result` 維持 undefined）。**

歷史路徑由載入端（Task 11 的 `session-store.ts`）在 `normalizeHistory` 產出的事件後**補一筆**
`{ kind: 'session-end', isError: false }`。歷史訊息已持久化，這場對話確實結束了，補這筆不是造假。

裁決 5 表格的四行行為不變，但機制統一：

| 情況 | 現在怎麼達成 |
|---|---|
| live 收到 `block-stop` | 該 block `complete: true`（不變） |
| live 收到 `session-end` | 全部 complete，running → done |
| 歷史路徑 | 載入端補 `session-end`，走同一條 |
| `user-text` | 建立時直接 `complete: true`（使用者按下送出它就完成了） |

裁決 13 的「live 路徵不適用」一句作廢：live 的 query 結束後不可能還有工具真的在跑，
停在 `running` 是說謊。兩條路徑都一樣：沒有結果就是 `done` 加 `result: undefined`，
UI 顯示「工具沒有回傳結果」。歷史對話另外在原始輸出區顯示裁決 4 的文案，
判斷依據是 `SessionState.kind === 'viewing'`，那是 UI 層本來就有的資訊。

判斷錯的代價：若 SDK 在中斷時其實會補 `tool_result`，這條規則只是多餘不會錯；
若不補，沒有這條規則畫面會永遠顯示 running。

### 裁決 16（2026-09-02）：`ApprovalRegistry.request` 改收一個物件

Task 6 的 `request(toolName: string, input: unknown)` 沒有位置放裁決 11 的 `title`／`displayName`。
在 agent-host 側另外夾帶（例如用閉包變數在呼叫 `request()` 前先存起來、讓 `sendRequest` 再合併）
是隱性耦合，不採用。

改為：

```ts
// src/main/approval.ts（Task 6）
export interface ApprovalRequest {
  readonly requestId: string
  readonly toolName: string
  readonly input: unknown
  readonly title?: string
  readonly displayName?: string
}
export type ApprovalAsk = Omit<ApprovalRequest, 'requestId'>

interface ApprovalRegistry {
  request(ask: ApprovalAsk): Promise<ApprovalOutcome>   // registry 補 requestId 後整個物件交給 sendRequest
  reply(requestId: string, decision: ApprovalDecision): boolean
  denyAll(reason: string): void
  pendingCount(): number
}
```

`ApprovalRequest` 與 `ApprovalAskPayload` 維持裁決 8 的同形雙宣告。

Task 8 的 `canUseTool` 呼叫方式：

```ts
registry.request({ toolName, input, title: options.title, displayName: options.displayName })
```

`tsconfig.json` 沒開 `exactOptionalPropertyTypes`，`title: undefined` 可以直接賦給 `title?: string`，
不需要條件展開。`parseApprovalAsk`（Task 8）驗 `title`／`displayName` 若存在必為字串。

## renderer 元件介面（Task 9B／10／11 之間的接縫，控制端定義）

三個 task 平行撰寫，接縫先定死。任一方需要偏離，回報裁決。

```ts
// Task 9B 產出：src/renderer/components/Conversation.tsx
export type ToolBlock = Extract<Block, { kind: 'tool' }>

export interface ConversationProps {
  readonly view: ConversationView
  readonly historical: boolean          // SessionState.kind === 'viewing'；裁決 4 文案的開關
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
                                        // Task 10 用它把 ApprovalCard 插進對應的 ToolCall 底部
}
export function Conversation(props: ConversationProps): JSX.Element

// Task 9B 產出：src/renderer/hooks/useConversation.ts
// 訂閱 onEvents 與 onSessionState；批次含 reset 時只留最後一個 reset 之後的事件（裁決 22），sessionState 只鏡射；view 用 useMemo(fold)
export function appendEvents(prev: readonly Event[], batch: readonly Event[]): readonly Event[]
                                        // 截斷邏輯抽成純函式匯出，讓「收到 reset 不清空」的突變在 hook 之外測得到
export function useConversation(api: YesChefApi): {
  readonly view: ConversationView
  readonly sessionState: SessionState
}

// Task 10 產出：src/renderer/approvals.ts（純函式）與 hooks/useApprovals.ts、components/ApprovalCard.tsx
export function matchApproval(view: ConversationView, ask: ApprovalAskPayload): ToolBlock | undefined
                                        // 裁決 28：block.id === ask.toolUseId，且 block 狀態是 running 或 streaming-input
export function applyPendingApprovals(view: ConversationView, pending: readonly ApprovalAskPayload[]): ConversationView
                                        // 命中的 block status 改 'awaiting-approval'，其餘原樣；純函式
export function findAskForBlock(block: ToolBlock, pending: readonly ApprovalAskPayload[]): ApprovalAskPayload | undefined
                                        // 裁決 28：吃 applyPendingApprovals 標過的 view 裡的 block；block 狀態是 running、
                                        // streaming-input 或 awaiting-approval 才回傳 pending.find(a => a.toolUseId === block.id)
export function unmatchedAsks(view: ConversationView, pending: readonly ApprovalAskPayload[]): readonly ApprovalAskPayload[]
                                        // 裁決 28：view 裡完全沒有 id === toolUseId 的 ask；只看 id 不看狀態
export function useApprovals(api: YesChefApi): {
  readonly pending: readonly ApprovalAskPayload[]
  reply(requestId: string, decision: ApprovalDecision): void
}

// Task 11 產出：src/main/session-store.ts 與 src/renderer/components/Recents.tsx、hooks/useSessions.ts
export interface SessionStore {
  list(): Promise<readonly SessionSummary[]>          // 裁決 7：SDK 型別在這裡轉成 SessionSummary
  loadHistory(sessionId: string): Promise<readonly Event[]>
                                        // normalizeHistory 逐則展開，尾端補 session-end（裁決 15）
}
export function createSessionStore(deps: { listSessions: ..., getSessionMessages: ... }): SessionStore
export interface RecentsProps {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string                           // SessionState 裡的 sessionId
  readonly onOpen: (sessionId: string) => void
  readonly onStartNew: () => void
}
```

Task 8 的 `ipc-bridge.ts` 在裁決 6 之後持有狀態機，`load-history` effect 的執行就是呼叫
`sessionStore.loadHistory()` 然後把結果從 `agent:events` 推出去。所以 Task 8 讀取 Task 11 的
`SessionStore` 介面（以 `SessionSource` 之名注入，Task 8 已有這個注入點），Task 11 實作它。

### 裁決 17（2026-09-02）：query 錯誤與事件流中斷合流成一張錯誤卡片

規格 §8 有兩列沒有 task 承接：「SDK query 中途錯誤：`is_error` 與 `api_error_status` 渲染成錯誤卡片」
與「事件流中斷：對話頂端顯示連線狀態」。兩者都是「這場對話不正常地結束了」，不需要兩套 UI。

改動四處：

1. Task 3 `session-end` Event 加 `errorMessage?: string`。live 路徑從 result 訊息的 `errors`
   （若是字串陣列）以 `'\n'` 接起來；沒有就不帶。
2. Task 4 `ConversationView` 加 `error?: { readonly message?: string; readonly apiErrorStatus?: unknown }`。
   `fold()` 收到 `isError: true` 的 `session-end` 時設定它；`isError: false` 時不設。
3. Task 8 agent-host：`for await` 迭代器 throw（SDK 程序崩潰、連線斷掉）時，把錯誤轉成一筆合成的
   `{ kind: 'session-end', isError: true, errorMessage: err.message }` 走同一條 events 通道，
   再走原本的 onEnded。「事件流中斷」不另設連線狀態 UI，狀態機照常回 idle。
4. Task 9B `Conversation`：`view.error` 存在時在對話尾端渲染 `.error-card`，內容是
   「對話因錯誤結束」、`message`（若有）、`apiErrorStatus`（若有，`String()` 後顯示）。
   `cost` 那張卡片的位置與條件不變。

### 裁決 18（2026-09-02）：手動檢查清單只放在跑得起來的那個 task

Task 8 的 Step 10 原本有三個區塊的 Electron 手動檢查，其中「文字逐字出現」「批准卡片」
「Recents」「切換 session 拒絕」都要 Task 9／9B／10／11 的 renderer 才看得到，而 Task 8
完成時 renderer 仍是 Task 0 的佔位頁面。這些項目在 Task 8 無法執行，驗收條款等於空話。

規則：每個 task 的手動檢查只能包含該 task commit 當下就能操作的項目。

- Task 8 保留：區塊 1（preload 暴露面五項，於佔位頁面的 DevTools console 執行）、
  區塊 3 的壞 payload 兩項與「關視窗後 for-await 結束」一項。dev 模式要能開 DevTools。
- Task 10、Task 11 各自的手動清單維持（它們完成時對應 UI 已存在）。
- 其餘端對端項目（對話流、批准四種結局、Recents 開歷史與接續、切換 session 拒絕、錯誤卡片、
  `YESCHEF_PROJECT_DIR` 守門、Insights 歸屬檢查、記憶體重量、`npm run build`／`start`）
  集中在 Task 12 的整合檢查清單，Task 12 是整份計畫的驗收 task，不寫程式碼。

### 裁決 19（2026-09-02）：`vitest.config.ts` 的 coverage.include 只增刪、不重寫

Task 4、6、8 各自貼了一份「改為」的完整 `coverage.include` 清單，三份互不一致：Task 4 的還有
Task 0 已刪的 `spawn-args.ts`，Task 8 的把 Task 1 的 `src/shared/**/*.ts` 換回逐檔列舉並漏了
Task 7 的 `session-store.ts`。照著做，後面的 task 會蓋掉前面 task 加的條目。

規則：
- Task 1 一次把清單定成 `session-args.ts`、`layout.ts`、`cdp.ts`、`src/shared/**/*.ts`、
  `spikes/measure-memory.ts`（Task 0 已先拿掉 `spawn-args.ts`）。
- 之後每個 task 只用 diff 加自己的檔案那幾行，不重寫整份清單。`src/shared/` 底下的新檔
  （`events.ts`、`fold.ts`、`markdown-stream.ts`、`session-state.ts`）已被 glob 涵蓋，不另列。
- 各 task 負責的條目：Task 5 `session-machine.ts`、Task 6 `approval.ts`、Task 7 `session-store.ts`、
  Task 8 `agent-host.ts` 與 `ipc-bridge.ts`、Task 9B 六個 renderer 檔、Task 10 `approvals.ts`、
  Task 11 `relative-time.ts` 與 `useSessions.ts`（以各 task 檔內的 diff 為準）。
- `test.include` 改成 `tests/**/*.test.{ts,tsx}` 只在 Task 9 做一次（接縫補記已定）。

### 接縫補記（2026-09-02，撰寫者回報後由控制端定案）

- Task 11 拆成兩個 task：**Task 7 = `src/main/session-store.ts`**（排在 Task 4B 之後、Task 8 之前，
  補原 Task 7 作廢的空位），**Task 11 = Recents renderer**（`Recents.tsx`／`useSessions.ts`／
  `relative-time.ts`，排最後）。上面「Task 11 產出」那段的 `SessionStore` 改記為 Task 7 產出。
- `createSessionStore` 不收 `projectDir`：規格 §3.1／§3.2 定 Recents 跨專案，`listSessions()` 不帶 `dir`，
  預設 `limit: 100`（本機實測 940 筆不帶 limit 要 536 到 736 ms，帶 limit 100 為 84 ms）。
- `RecentsProps` 加 `readonly error?: string`：載入失敗時由 Recents 自己顯示錯誤並抑制「還沒有歷史對話」。
- Task 11 另產出 `useSessions(api: YesChefApi): { sessions, current?, error? }` 與 `formatRelativeTime(ms, now)`。
- Task 10 另產出 `findAskForBlock(block, pending)` 與 `unmatchedAsks(view, pending)`；App 只能用
  `findAskForBlock` 決定卡片掛在誰底下，不得重寫比對。對應不到 block 的請求畫在對話尾端。
- Task 10 接手 9B 留下的 `Composer` `disabled` prop：`pending.length > 0` 時輸入框停用（規格 §6）。
- `useApprovals` 掛載時不會清空 main 端已在待決的請求：renderer 在 live 中途重載時，舊請求由
  Task 6 的 30 秒逾時拒絕。接受這個限制，不加同步協定。
- `vitest.config.ts` 的 `test.include` 改成 `'tests/**/*.test.{ts,tsx}'` 只在 Task 9 做一次；
  9B／10／11 不再重複宣告，只在 Step 2 確認。
- `App.tsx` 的演進順序定為 9 → 9B → 10 → 11，每個 task 給的完整檔案必須是前一個 task 檔案加上自己的改動；
  「誰後做誰負責合併」這種寫法不接受。
- `tsconfig.json` 沒開 `exactOptionalPropertyTypes`，`current={current}` 這種 `string | undefined`
  賦給 `?: string` 的寫法直接可過，不需要條件展開。

### 裁決 20（2026-09-02）：跨專案 resume 帶原本的 cwd；組不出 options 時走錯誤卡片

規格 §3.2：「點別的專案的歷史對話則用它原本的 cwd `resume`，因為那場對話本來就屬於那個專案。」
Task 12 撰寫者對照後發現沒有任何 task 把 `SessionSummary.cwd` 接到 `start-query`：Task 8 的
`sessionOptions(resumeSessionId)` 一律用 `YESCHEF_PROJECT_DIR`。CLI 2.1.251 的內建字串也印證了
規格的方向：互動模式對跨目錄的 resume 直接顯示「This conversation is from a different directory.
To resume, run: cd … && claude --resume …」，也就是 CLI 自己認定 resume 要回到原目錄做。

規則（只動 Task 7 與 Task 8，狀態機、IPC 頻道、`SessionSource` 都不動）：

- Task 7：`SessionStore` 加 `cwdOf(sessionId: string): string | undefined`，回傳最近一次 `list()`
  結果裡該筆的 `cwd`；沒列過或該筆沒有 `cwd` 回 `undefined`。實作是 `list()` 每次成功後換掉一個
  `ReadonlyMap<string, string>`（新建，不就地改）。sessionId 只可能來自 `list()` 的結果，所以
  「沒列過」在正常流程不會發生，但型別上要老實回 `undefined`。
- Task 8 `index.ts`：環境變數的讀取與守衛（含啟動時的 dry-run）抽成 `requireProjectDir(): string`，
  只在 `createWindow()` 開頭呼叫一次，回傳的字串同時交給工廠（本裁決）與左窗格的 preload（裁決 21）。
  工廠簽章是 `createSessionOptionsFactory(projectDir: string, sessions: Pick<SessionStore, 'cwdOf'>)`，
  回傳的函式是 `(resumeSessionId) => buildSessionOptions({ projectDir: (resumeSessionId === undefined
  ? undefined : sessions.cwdOf(resumeSessionId)) ?? projectDir, appDir, resumeSessionId })`。
  `IpcBridgeDeps.sessionOptions` 與 `AgentHostDeps.sessionOptions` 的簽章不變。
- Task 8 `agent-host.ts`：`start()` 呼叫 `deps.sessionOptions(resumeSessionId)` 要包 try/catch。
  拋錯時（歷史 session 的目錄已被刪除、或落在 app 自身目錄下，都是 Task 1 守衛會丟的情況）：
  `deps.onError(err)`、`deps.onBatch([{ kind: 'session-end', isError: true, errorMessage }])`、
  `deps.onEnded()`，然後 return，不呼叫 `queryFn`。這樣狀態機回到 `idle`、renderer 畫出裁決 17 的
  錯誤卡片，而不是卡在沒有 query 的 `live`。需要一條測試釘住「不呼叫 queryFn、合成 session-end、
  onEnded 各一次」，並做突變（拿掉 `deps.onEnded()`）。
- 守衛不為 resume 開例外：resume 進 app 自身目錄的 session 會得到錯誤卡片，訊息就是 Task 1 的
  那兩行。這是可見的失敗，比靜默把逐字稿寫進被排除的目錄好。

判斷錯的代價：若 SDK 的 `resume` 其實會忽略 `options.cwd` 而自己用原目錄，本裁決多傳的 cwd 無害。
若歷史 session 的 `cwd` 欄位缺失，退回 `YESCHEF_PROJECT_DIR`，行為與裁決前相同。

### 裁決 21（2026-09-02）：標題列顯示當前對話所屬的目錄

規格 §3.2 把這件事寫成跨專案 Recents 的代價：「代價是標題列必須顯示當前對話所屬的目錄。」
沒有任何 task 產出它。使用者的核心需求是 Insights 歸屬，看不到目前對話落在哪個目錄，裁決 20
修好了也沒人知道。

規則：

- renderer 拿 `YESCHEF_PROJECT_DIR` 的方式是 Electron 的 `webPreferences.additionalArguments`：
  Task 8 `index.ts` 建左窗格的 `WebContentsView` 時傳 `additionalArguments: [`--yeschef-project-dir=${projectDir}`]`
  （只加在左窗格，`createAgentView()` 的右窗格沒有 preload，不加）。`bridge.ts` 用
  `process.argv.find((a) => a.startsWith('--yeschef-project-dir='))` 取值，去掉前綴後放進
  `YesChefApi.projectDir`（純字串，不是函式）；找不到時給空字串並 `console.error`，不拋錯。
  旗標名以常數 `PROJECT_DIR_ARG = '--yeschef-project-dir='` 放在 `src/shared/ipc.ts`，index.ts
  與 bridge.ts 都 import 它。不走 IPC 的理由：這是啟動時就固定的一個字串，開一條 invoke 頻道
  加一個 async hook 是三倍的程式碼。
- `YesChefApi` 因此有第 9 個成員 `readonly projectDir: string`（裁決 14 的區塊已同步）。
  Task 9、9B、10、11 測試裡每一份假 `YesChefApi` 都要補 `projectDir: '/Users/x/Projects/demo'`
  之類的值，否則 typecheck 不過。
- Task 11 的 `App.tsx`（最終版）在 `<aside>` 與對話區之上加一列 `<header className="title-bar">`，
  內容規則：`useSessions` 的 `current` 為 `undefined`（idle 或全新 live）時顯示 `api.projectDir`；
  有 `current` 時顯示 `sessions` 裡該筆的 `cwd`；該筆沒有 `cwd` 時顯示「目錄不明」。三種情況各一條
  App 測試。樣式放 `App.css`，一行文字、等寬字型、不換行、超出以 `text-overflow: ellipsis` 截尾。
- Task 12 的 E 組加一項：點別的專案的歷史對話後，標題列換成那個專案的目錄；按「開新對話」後換回
  `YESCHEF_PROJECT_DIR`。

判斷錯的代價：若沙箱 preload 的 `process.argv` 拿不到 `additionalArguments`（Electron 文件說拿得到），
標題列會是空字串且主程序 console 有錯誤，Task 12 的 A4 與 E 組會抓到；改法是換成一條 `invoke`
頻道，只動 Task 8 的 `bridge.ts`／`ipc-bridge.ts` 與 Task 11 的一個 hook。

### 裁決 22（2026-09-02）：事件流裡的 `reset` 標記決定畫面何時清空，不靠 `session:state`

codex 審查（p2 順序）指出：`load-history` 是先推事件、effects 跑完才推 `SessionState`，而 Task 9B 的
`useConversation` 在 `sessionState` 換一場時清空事件，於是剛載入的歷史會被緊接著到的 `viewing` 狀態清掉。
控制端逐一對照 Task 5 的轉移表與 `sameSession(a, b)`（kind 與 sessionId 都相同才算同一場）後，發現靠
狀態差異決定清空還有三處判斷相反：

| 轉移 | 應該 | `sameSession` 的結果 |
|---|---|---|
| `live` → `idle`（query 自然結束或錯誤） | 保留，裁決 17／20 的錯誤卡片就在這些事件裡 | 清空 |
| `viewing{A}` → `live{A}`（輸入即 resume） | 保留歷史，新回合接在後面 | 清空 |
| `live{}` → `live{}`（live 中按「新對話」） | 清空 | 保留（與同狀態重送無法區分） |

根本原因是資料放錯地方：「畫面從這裡重新開始」是事件流自己的分界，不是 UI 狀態的推論。規則：

- `Event` 新增 `{ kind: 'reset' }`（`src/shared/events.ts`，Task 3）。`stepLive`／`normalizeHistory` 永遠不產出它；
  它由 Task 8 的 `ipc-bridge.ts` 在 `runEffect` 合成：`start-query` 且 `resumeSessionId === undefined` 時，
  在 `host.start()` 之前 `pushBatch([{ kind: 'reset' }])`；`load-history` 時把它放在歷史事件最前面一起走
  `pushHistory([{ kind: 'reset' }, ...events])`。resume 的 `start-query` 不推，歷史留在畫面上。
- `fold()`（Task 4）：`case 'reset': return INITIAL_VIEW`。一條測試：reset 前的事件不出現在結果裡。
- `useConversation`（Task 9B）：事件批次一律附加；批次裡含 `reset` 時只保留最後一個 `reset` 之後的事件
  （reset 本身可丟）。`onSessionState` 只更新 `state`，不再清空事件；`sameSession` 刪除，Interfaces 同步。
  突變 M1 改成「收到 reset 不清空」。補充（2026-09-02，Package C 實作回報）：`fold()` 也認得 `reset`，所以
  hook 少截一次對 `view` 沒有可觀察的差別，M1 在 hook 層的三條測試下不會紅；截斷邏輯因此抽成匯出的純函式
  `appendEvents(prev, batch)` 並直接測它，M1 才測得到。
- Task 10 的 `useApprovals` 不變：待決卡片仍在狀態離開 `live` 時清空，那是另一件事。

同一條事件頻道保證了先後順序，`session:state` 什麼時候到都不影響畫面內容。

判斷錯的代價：若 SDK 在 resume 時重播歷史訊息（目前實測不會，Task 3 fixture 04 是 `getSessionMessages` 的產物，
resume 的 query 只送新回合），畫面會出現兩份歷史；修法是 resume 也推 `reset`，一行。

### 裁決 23（2026-09-02）：`dispatch` 的 effects 跨 action 串行

codex 審查（p2 順序）指出 `ipc-bridge.ts` 的 `dispatch` 只在單一 action 內照順序跑 effects，兩個 action 先後到達時
各自的 `runEffects` 並行。控制端確認兩個實際會發生的壞結果：連點兩筆 Recents 時，兩次 `loadHistory` 誰先回來
誰先推，最後推出去的 `SessionState` 可能是先點的那一筆；live 中按「新對話」後立刻點歷史，第二個 action 的
`teardown` 與第一個 action 的 `start` 交錯，會出現「狀態是 `viewing` 但 host 裡有活躍 query」。

規則：`ipc-bridge.ts` 持有一條 `let pending: Promise<void> = Promise.resolve()`。`dispatch` 仍同步算
`transition` 並更新 `state`（意圖的先後就是 transition 的先後），但 effects 與狀態推送接在鏈尾：

```ts
pending = pending
  .then(() => runEffects(result.effects))
  .catch((err: unknown) => { deps.logError(asError(err, `effects(${action.kind})`)) })
  .then(() => { sendBestEffort(IPC.sessionState, result.state) })
```

一個 action 的 effect 失敗只記錄，不阻斷後面的 action。原本的 `track(IPC.sessionState, done.then(...))` 刪除。
測試：`loadHistory` 用可延後 resolve 的假物件，連續 `fire(intentOpenHistory, s-1)`、`fire(intentOpenHistory, s-2)`，
先 resolve s-2 再 resolve s-1，`rig.calls` 仍是 `loadHistory(s-1)`、`send(session:state)`、`loadHistory(s-2)`、
`send(session:state)`，且最後一次推的狀態是 `viewing{s-2}`。

### 裁決 24（2026-09-02）：`@anthropic-ai/claude-agent-sdk` 由 Task 7 加裝，版本釘 0.3.258

codex 審查（p2 順序）指出 Task 7 的 `session-store.ts` 與手動檢查都 import SDK，但 `npm install` 排在 Task 8 Step 7；
Task 9 又寫「`@anthropic-ai/claude-agent-sdk` 由 Task 3 加」，而 Task 3 沒有 import SDK（只用 fixture）。
另外 Task 9 用 diff 改 `package.json` 之後沒有任何一步跑 `npm install`。

規則：

- Task 7 在寫實作之前加一步 `npm install @anthropic-ai/claude-agent-sdk@0.3.258`，Step 7 的 `git add` 加上
  `package.json package-lock.json`。0.3.258 是 2026-09-02 `npm view` 的最新版；本契約引用的 `sdk.d.ts` 行號
  以這一版為準（`listSessions` 第 992 行、`getSessionMessages` 第 797 行、`CanUseTool` 第 209 行）。
- Task 8 Step 7 刪掉 `npm install` 那一行，改成 `npm ls @anthropic-ai/claude-agent-sdk` 確認已裝。
- Task 9 Step 3a 之後加一步 `npm install`，並把「由 Task 3 加」改成「由 Task 7 加，此時 `dependencies`
  只有它一項」。

### 裁決 25（2026-09-02）：事件累積在 renderer，main 不設事件存放區（規格 §3 修訂）

規格 §3 的圖與 §3.2 寫「事件存放區在 main，只存活躍 session」。計畫從 Task 8 到 Task 9B 都沒有建這個存放區：
main 的 `event-merger` 只做每幀合併就推走，累積在 renderer 的 `useConversation`。codex 審查（p3 規格覆蓋）指出
這是未覆蓋項。

控制端判定：存放區在 main 唯一的用途是 renderer 重載後重新同步，目前沒有任何一條資料流讀它。加上它要多一條
`invoke` 頻道與第 10 個 `YesChefApi` 成員，換來的只是開發模式整頁重載時不必等下一批事件。規格改成計畫的做法，
並在規格 §3／§3.2 註明修訂；代價寫進規格：renderer 重載時，進行中的 live 對話畫面清空，歷史對話可從 Recents 重開。

### 裁決 26（2026-09-02）：Markdown 解析失敗時該 block 退回純文字

規格 §8：「markdown 解析失敗：該 block 退回純文字，不讓整則訊息壞掉。」Task 9 的 `Markdown.tsx` 沒有任何錯誤處理，
`react-markdown` 在渲染期拋錯會一路炸到 React 根。

規則：`Markdown.tsx` 加一個類別元件 `MarkdownBoundary`（React 19 的 error boundary 仍只能用類別）：
`static getDerivedStateFromError()` 設 `failed: true`；`render()` 在 `failed` 時輸出
`<pre className="markdown-fallback">{markdown}</pre>`，否則輸出 children；`componentDidUpdate` 在 `markdown`
prop 改變且 `failed` 為 true 時重設為 false（下一幀的內容重新嘗試解析）。`MarkdownImpl` 用它包住 `<ReactMarkdown>`。
匯出 `MarkdownBoundary` 供測試：測試用一個 `render()` 就 `throw` 的子元件，斷言 fallback 的文字等於原始 markdown；
測試期間 `vi.spyOn(console, 'error').mockImplementation(() => {})` 壓掉 React 的錯誤紀錄，測完還原。
`Markdown.css` 加 `.markdown-fallback { white-space: pre-wrap; }`。

### 裁決 27（2026-09-02）：前綴測試的真實文件要達到規格的規模

規格 §9：「一份約 3000 字的真實文件產生約 3000 個案例」。Task 2 的 `REAL` 是從 fixture 03 抽出的模型回答，
實測只有 466 字，測試只斷言 `> 200`。

規則：Task 2 新增 `tests/fixtures/markdown/real-doc.md`，內容是 `docs/specs/2026-09-01-yeschef-a-sdk-host-design.md`
在 Task 2 動工當下的完整複本（`cp` 一次，之後不跟著規格改；9617 字（2026-09-02 依裁決 25 修訂後），含表格、圍欄、清單、粗體、行內程式碼，
是真實對話產出的文件）。測試多一個 `REAL_DOC` 案例，斷言 `REAL_DOC.length >= 3000`；原本從 fixture 03 抽的
`REAL` 改名 `REAL_ANSWER`，斷言維持 `> 200`。`it.each` 三列。Task 9 的元件層前綴測試（每個前綴都 render 進 jsdom）
維持用短文件，那一條測的是元件不崩，不是規格 §9 這一項。

### 裁決 28（2026-09-02）：批准請求帶 `toolUseId`，裁決 11 的內容比對作廢

重查 `sdk.d.ts`（0.3.252 與 0.3.258 的第 248 行皆是 `toolUseID: string`，必填）：`CanUseTool` 的 options 有
tool_use id。裁決 11 的前提錯了，因它而生的 `deepEqual`、「同名同參數取第一個未收 result 的 block」、
「兩筆內容相同的請求只有一個位置」這些特殊情況全部消失。同時修掉一個沒人處理的情況：批准逾時後 main 已 deny，
renderer 的卡片卻留在畫面上等人按，按了只會在主程序 log 一句「找不到 requestId」。

規則：

- Task 6 `ApprovalRequest` 加 `readonly toolUseId: string`；Task 8 的 `canUseTool` 從 `options.toolUseID`
  取值傳進 `requestApproval`；`src/shared/ipc.ts` 的 `ApprovalAskPayload` 加同名欄位（parse 函式若檢查欄位，
  一併檢查它是字串）。裁決 8 的型別標註賦值會抓漏。
- Task 10 `approvals.ts`：刪除 `deepEqual`。`matchApproval(view, ask)` 回傳 `id === ask.toolUseId` 且狀態是
  `running` 或 `streaming-input` 的 tool block，否則 `undefined`。`findAskForBlock(block, pending)` 回傳
  `pending.find((a) => a.toolUseId === block.id)`，且只在 block 狀態是 `running`、`streaming-input` 或
  `awaiting-approval` 時回傳（補充 2026-09-02：`findAskForBlock` 讀的是 `applyPendingApprovals` 標過的 view，
  命中的 block 下一幀就是 `awaiting-approval`，不認它卡片會在標記生效的下一幀消失；`matchApproval` 讀 raw view，
  只認前兩個），已 `denied`／`done`／`error` 的 block 一律 `undefined`（逾時被 deny 後卡片跟著消失，這就是「可見記錄」：
  block 上的 `deniedReason` 或錯誤結果）。`unmatchedAsks(view, pending)` 回傳 view 裡完全找不到
  `id === toolUseId` 的 ask（block 快照還沒到，仍畫在對話尾端）；找得到但已關閉的 ask 不畫、不算 unmatched。
  `applyPendingApprovals` 只掛 `findAskForBlock` 命中的。
- Task 10 的設計說明段落重寫：刪掉 deepEqual 與鍵順序那兩段，改寫成上面三條規則與「為什麼 ask 先到、
  block 後到仍然可能」（canUseTool 走 control 通道，block 快照走每幀合併的事件通道）。
- 所有測試裡的假 ask 與假 `ApprovalAskPayload` 補 `toolUseId`。
- 契約「IPC 契約」區塊的 `ApprovalAskPayload` 同步加欄位。

判斷錯的代價：若某個 SDK 版本的 `toolUseID` 在執行期缺席（型別說必填），`matchApproval` 永遠找不到 block，
所有卡片會畫在對話尾端而不是掛在工具上；Task 12 的手動檢查「批准卡片出現在對應的工具區塊上」會抓到。
