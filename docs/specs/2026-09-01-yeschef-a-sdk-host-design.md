# yeschef A：SDK 宿主與對話渲染 設計規格

日期：2026-09-01
狀態：待審
子專案：A（四個子專案 A／B／C／D 中的第一個，C 已併入 A）

## 0. 這份規格取代了什麼

原規格 `docs/specs/2026-08-31-yeschef-design.md` 的以下段落被本文取代：

| 原規格段落 | 原本寫的 | 取代為 |
|---|---|---|
| §4 架構 | 左窗格 xterm.js 加 node-pty 跑 `claude` CLI | 主程序用 Agent SDK 的 `query()` 宿主 agent，renderer 渲染事件 |
| §4.1 第一點 | 左窗格跑真 `claude` 二進位檔 | SDK 亦寫逐字稿，Insights 前提照樣成立（見 §1） |
| §4.1 第四點 | app 自建 MCP server，claude CLI 連進來 | SDK 匯出 `createSdkMcpServer` 與 `tool`，工具在同一程序內註冊，不需獨立 MCP server 程序 |
| §5 MCP 介面 | 九個工具透過 stdio MCP server | 移到子專案 B，改為 in-process SDK 工具 |
| §7 錯誤處理 | 部分項目針對 PTY 與 MCP 連線 | 見本文 §8 |

原規格的 §2（限制）、§3（不做什麼）、§8（驗證計畫）、§10（交付形式）不受影響。

**§2.1 的 Insights 資料流限制完全不變**：`claude` session 的歸屬由 cwd 決定，而 `~/.claude/usage-data/ingest-jsonl.mjs` 的排除規則同時作用在 session cwd 與碰到的檔案路徑。

## 1. 這份設計建立在四個已查證的事實上

全部於 2026-09-01 實測，不是文件推論。

| 事實 | 證據 |
|---|---|
| Agent SDK 會寫逐字稿到 `~/.claude/projects/` | 用 `query()` 跑一輪，產生 67,002 bytes 的 `.jsonl`，路徑與 CLI 一致。Insights 讀得到 |
| `canUseTool` 提供互動式逐次批准 | 回呼被呼叫一次，帶 `toolName: "Bash"` 與完整 `input`；回 `allow` 後工具實際執行 |
| 事件模型很小 | 5 種頂層 type（`system`／`assistant`／`user`／`result`／`rate_limit_event`），4 種 content block（`thinking`／`tool_use`／`text`／`tool_result`） |
| SDK 提供 session 管理 API | 匯出 `listSessions`、`getSessionMessages`、`getSessionInfo`、`forkSession`、`renameSession`、`deleteSession`、`tagSession` |
| `SDKSessionInfo` 含 Recents 所需的全部欄位 | `sessionId`、`summary`、`lastModified`、`cwd?`、`customTitle?`、`firstPrompt?`、`gitBranch?`、`tag?`、`createdAt?`、`fileSize?` |
| `Query` 介面可中斷與即時改設定 | `interrupt()`、`setPermissionMode()`、`setModel()`、`setMaxThinkingTokens()` |

反面事實，一併記錄：`claude -p --output-format=stream-json` 這條 CLI 路徑**沒有**逐次批准。實測 `--permission-mode manual` 加雙向 stream-json，串流上不出現任何 control request，只有事後的 `system/permission_denied` 事件。本版 CLI 也沒有 `--permission-prompt-tool` 旗標。這是選 SDK 而非 CLI 的決定性理由。

SDK 版本：`@anthropic-ai/claude-agent-sdk@0.3.252`

## 2. 範圍

### 2.1 A 包含

SDK 宿主、逐字串流的對話渲染、`canUseTool` 的內嵌批准 UI、Recents 側邊欄與 session 切換、工具呼叫摺疊與展開後的原始輸出。

### 2.2 A 不包含

九個右窗格工具（子專案 B）、文件面板（子專案 D）、打包與簽章、多視窗、任何 `dangerouslySkipPermissions` 類的旁路。

### 2.3 使用者已定案的四個取捨

| 項目 | 決定 |
|---|---|
| 每天用的門檻 | 要有 Recents 才算堪用，所以原子專案 C 併入 A |
| 串流單位 | 逐字，像桌面版。代價是渲染器要處理未完成的 markdown |
| 終端機逃生口 | 不保留獨立終端機，改為工具呼叫展開後看得到未經處理的 stdout／stderr |
| 記憶體預算 | 先不設限，做完再量。原規格的 +150 MB 暫停適用 |

## 3. 架構

```
┌─ Electron 主程序 ──────────────────────────────────────────┐
│                                                            │
│  SDK query()  ──事件──▶  每幀合併器（不留存，直接推送）     │
│      ▲                          │                          │
│      │ 使用者輸入                │ 批次推送                  │
│      │                          ▼                          │
│  canUseTool ◀──批准/拒絕──┐   IPC                          │
│                          │     │                          │
│  ┌── 左＋中窗格 ─────────┼─────▼──┐  ┌── 右窗格 ────────┐  │
│  │ React renderer        │        │  │ WebContentsView  │  │
│  │  · Recents 側邊欄     │        │  │ persist:agent    │  │
│  │  · 對話（事件的投影） │        │  │ （子專案 B）     │  │
│  │  · 內嵌批准卡片 ──────┘        │  │                  │  │
│  └───────────────────────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 3.1 四條資料流

**輸入**：renderer → IPC → main 寫進 SDK 的輸入串流。

**事件**：SDK → main 以幀為單位合併後批次推給 renderer → renderer 累積成事件陣列，畫面從它投影。逐字串流下事件量大，一個 token 一次 IPC 會塞爆。合併只把事件裝進陣列一起送，事件本身不加工。

**批准**：`canUseTool` 在 main 觸發，送請求給 renderer、掛著等回覆、再回 `allow` 或 `deny`。

**Recents**：renderer 要清單 → main 呼叫 `listSessions()`（不帶 `dir`，跨全部專案）。點選 → main 呼叫 `getSessionMessages(id)` 拿事件重播。

### 3.2 三個架構決定

**一次只有一個活躍 session。** 點歷史對話是唯讀顯示，一輸入就 `resume` 並收掉原本的活躍 query。理由是同時兩個 query 會讓批准請求不知道屬於誰。

收掉的順序固定為三步：等待中的批准 promise 以 `deny` 結束、呼叫 `query.interrupt()` 中止進行中的工具、再收掉 query。三步都要有明確結果，不得留置任何掛起的 promise。

**事件累積在 renderer，main 不留存。** main 的合併器只把一幀內到達的事件裝進陣列推走；活躍 session 的事件陣列由 renderer 的 hook 持有。歷史一律走 `getSessionMessages` 現拿。不自建持久化，SDK 已在寫逐字稿，再存一份就有兩份真相。代價：renderer 重載（開發模式整頁重載）時進行中的 live 對話畫面清空，歷史對話可從 Recents 重開。（2026-09-02 修訂，原文是「事件存放區在 main，只存活躍 session」，見 §12。）

**Recents 跨專案，新 session 綁啟動時的目錄。** `YESCHEF_PROJECT_DIR` 決定新對話開在哪，也就是 Insights 的歸屬。點別的專案的歷史對話則用它原本的 cwd `resume`，因為那場對話本來就屬於那個專案。代價是標題列必須顯示當前對話所屬的目錄。

## 4. 投影函式與視圖模型

### 4.1 正規化層（自審補入）

live 與歷史兩條路徑的事件形狀不同，已查證：

| 來源 | 型別 | 形狀 |
|---|---|---|
| `query()` 非同步迭代 | `SDKMessage` | 約 18 個變體的聯集，含 `stream_event`（token delta）、`SDKPartialAssistantMessage`、`SDKResultMessage`、各種 hook 訊息 |
| `getSessionMessages()` | `SessionMessage` | `{ type: 'user' \| 'assistant' \| 'system', uuid, session_id, message: unknown, parent_tool_use_id, parent_agent_id }` |

因此 `fold()` 不得直接吃 SDK 型別。中間放一層正規化：

```
normalizeLive(msg: SDKMessage)        → readonly Event[]
normalizeHistory(msg: SessionMessage) → readonly Event[]
```

`Event` 是本專案自己定義的窄型別，只涵蓋渲染需要的東西。SDK 的多數變體（hook 訊息、plugin 安裝、狀態回報）映射為零個 Event 或一個 `unknown` Event。

這一層的價值不只是統一形狀：SDK 演進時的衝擊被擋在轉接器這一層，`fold()` 與所有 UI 元件不受影響。認不出來的輸入一律產出 `unknown` Event 而非丟棄。

### 4.2 投影函式

renderer 的核心是純函式，沒有累積狀態、沒有副作用：

```
fold(events: readonly Event[]) → ConversationView
```

```ts
type Block =
  | { kind: 'text';     markdown: string; complete: boolean }
  | { kind: 'thinking'; text: string;     complete: boolean }
  | { kind: 'tool';     name: string; input: unknown;
      result?: string; raw?: string;
      status: 'awaiting-approval' | 'denied' | 'running' | 'done' | 'error' }
  | { kind: 'unknown';  raw: unknown }

type Turn = { role: 'user' | 'assistant'; blocks: readonly Block[] }
```

`unknown` 這一格是刻意的：遇到沒見過的事件型別，渲染成可展開的原始 JSON 卡片，**不得靜默丟棄**。SDK 會演進，而靜默丟棄是本專案已經吃過十次虧的模式。

## 5. 未完成的 markdown

逐字串流的主要風險。串到一半的文字會出現半個表格列、未收尾的程式碼圍欄、未閉合的行內標記。

**推測性收尾。** 解析前掃一遍累積文字的副本：反引號圍欄數為奇數就補收尾、最後一行像寫到一半的表格列就扣住不渲染、未閉合的行內標記補上。不動原始文字。

**逐幀整份重解析。** 不做增量解析。訊息長度有限，重解析便宜，而增量解析要處理的特殊情況遠多於它省下的時間，且其狀態機出錯的方式極難追。

最後一個 block 標 `complete: false`，UI 在尾端畫游標。

### 5.1 技術選型

React 加 `react-markdown`（`remark-gfm` 支援表格）加 `rehype-highlight` 做語法高亮。

選 `react-markdown` 而非「markdown 轉 HTML 字串再 `dangerouslySetInnerHTML`」的理由有二：模型產出的內容以原始 HTML 注入是實際的注入風險，`react-markdown` 預設不放行原始 HTML；以及它產出 React 元素，逐幀整份重解析時由 React 做差異比對，不會每幀重建整棵 DOM。

「每幀」定義為約 16 毫秒的合併窗口。實際批次大小與幀預算待實作時量測，但合併發生在 main 側、只做打包不加工事件這一點是設計約束，不隨量測改變。

## 6. 工具呼叫與批准

工具呼叫預設摺疊成一行（例如 `Ran 2 commands ›`），展開後顯示未經處理的 stdout／stderr。這是使用者選擇的終端機逃生口形式。

批准**內嵌在對話流**，不用彈窗。出現在該工具呼叫的位置，顯示工具名稱與完整 input，下方兩個按鈕，同時輸入框停用直到回答。卡片標題優先用 SDK `canUseTool` 送來的 `title`／`displayName`（實作計畫裁決 16），沒有時退回工具名。

歷史對話（`getSessionMessages`）不含 `tool_use_result`，所以檢視歷史時工具展開後看不到原始 stdout／stderr。展開區塊要顯示「這是歷史對話，沒有保存原始輸出」，不能留一塊空白讓人以為工具沒有輸出（裁決 4）。

選內嵌的理由：使用者看得到是什麼上下文導致這個請求。彈窗「不會被錯過」的優勢在此不需要，因為對話已經卡住，無法繼續往下。

## 7. Session 生命週期

```
idle ──開新對話──▶ live ──結束或關閉──▶ idle
idle ──使用者輸入──▶ live（新對話，這則輸入是第一句）
live ──session-start（SDK 吐出 id）──▶ live（帶 sessionId）

viewing ──使用者輸入──▶ live（resume，舊 query 收掉）
   ▲
   └── 點 Recents 的歷史對話（唯讀）
```

`viewing` 的事件來自 `getSessionMessages`，經 `normalizeHistory` 轉成 `Event[]` 之後，走跟 `live` 同一條渲染路徑（§4.1）。差別只在輸入框顯示「輸入以接續這條對話」。

狀態機（`transition(state, action) → { state, effects }`）是純函式，放在主程序 `src/main/session-machine.ts`（裁決 6）。renderer 只送意圖（`start-new`／`open-history`／`user-input`），main 呼叫 `transition()`、照 effects 陣列順序執行（拒絕所有掛著的批准 → 中斷 query → 收掉 query → 開新 query 或載入歷史），再把新的 `SessionState` 推回 renderer。收尾順序因此只有一份，而且可以在 node 環境測。

## 8. 錯誤處理

| 情況 | 處置 |
|---|---|
| 未知事件型別 | 渲染成可展開的原始 JSON 卡片，不丟棄 |
| markdown 解析失敗 | 該 block 退回純文字，不讓整則訊息壞掉 |
| 批准逾時 | 拒絕，並在對話裡留下可見記錄。拒絕是安全的方向，靜默掛住不是 |
| 批准時 renderer 未就緒或視窗已關 | 同上，拒絕並記錄 |
| SDK query 中途錯誤 | `result` 事件的 `is_error`、`errors` 與 `api_error_status` 渲染成對話尾端的錯誤卡片（「對話因錯誤結束」），不是 console |
| 事件流中斷（query 迭代器拋錯） | main 合成一筆 `session-end { isError: true, errorMessage }` 走同一條事件通道，renderer 顯示同一張錯誤卡片；狀態機照常回 `idle`，不另設連線狀態 UI（裁決 17） |
| 切換 session 時舊 query 卡在批准 | 該 promise 以 `deny` 結束後才收掉 query |

## 9. 測試

| 對象 | 方式 |
|---|---|
| `normalizeLive` / `normalizeHistory` | 純函式。用真實錄下的事件流當 fixture。必含一條「未知型別產出 unknown Event 而非丟棄」的測試 |
| `fold()` | 純函式。輸入是正規化後的 `Event[]`，fixture 由上一項產生 |
| 串流 markdown | 前綴測試：一份約 3000 字的真實文件產生約 3000 個案例，每個斷言不拋錯且結構完整 |
| `canUseTool` 的 IPC 契約 | 四種結局各一：allow、deny、逾時、視窗關閉。用假 IPC 通道在 main 測，不需 Electron |
| session 狀態機 | 純函式的狀態轉移，含「從 viewing 進 live 時收掉舊 query」 |
| Electron 整合 | 手動檢查清單 |

前兩項是測試重心。共同特徵是**案例來自真實資料而非測試自己造的**。上一個分支的教訓是「有測試」與「測試有用」是兩件事：當時 41 個測試全綠，但它們沒有 import 產品實際使用的設定，把設定改壞照樣全過。

## 10. 現有分支的存活與作廢

| 現有成果 | 狀態 |
|---|---|
| `src/main/agent-view.ts` | 存活，不動。子專案 B 使用 |
| `src/main/cdp.ts`（含遞迴 re-arm） | 存活，不動。子專案 B 的地基 |
| `src/main/layout.ts` | 存活，不動。Electron 層維持兩欄（左：React renderer 含 Recents 與對話；右：`WebContentsView`），側邊欄與對話的分割是 React 內的 CSS grid（裁決 9） |
| `src/main/spawn-args.ts` | 作廢（Task 0 刪除），由 `src/main/session-args.ts` 取代。cwd 與 appDir 的守衛照樣需要，只是從組 CLI 參數變成組 SDK 的 `options.cwd`，且改用 `fs.realpathSync.native()` 比對 |
| Spike 2（無焦點注入 200/200 ×3） | 存活，測的是右窗格 |
| Spike 3（跨站 iframe 16/16） | 存活，測的是右窗格 |
| `src/main/pty-host.ts` | 作廢。SDK 不需要 PTY |
| `src/renderer/terminal.ts`（xterm.js） | 作廢。換成對話渲染器 |
| `src/preload/terminal.ts` 的 PTY 橋接 | 作廢（Task 0 刪除），由 `src/preload/bridge.ts` 取代。IPC 契約整組換掉 |
| Spike 1 的 TUI 七項 | 作廢。沒有 TUI 要檢查 |
| Spike 1 的記憶體量測 | 待重量。xterm.js 換成渲染器，數字會變 |

## 11. 已知風險與未決事項

| 項目 | 狀態 |
|---|---|
| 逐字串流的 IPC 流量與合併策略 | 每幀合併是設計決定，實際的幀預算與批次大小待實作時量測 |
| 渲染器的記憶體成本 | 選型已定（§5.1），成本待做完量測。使用者已同意先不設限 |
| SDK 版本演進 | `unknown` 事件卡片加正規化層（§4.1）是對此的緩解。SDK 改變形狀時只需改轉接器，`fold()` 與 UI 不受影響 |
| `interrupt()` 對已送出的工具的實際效果 | 介面存在（§1），但中止一個正在跑的 Bash 指令是否真的能停下來，待實作時實測 |
| 模型與權限模式的即時切換 | `setModel()`、`setPermissionMode()` 可用，對應使用者截圖右下角的控制項，但**不在 A 的範圍**，列此備忘 |
| `fold()` 每幀全量重算 | 成本隨事件數平方成長。終審量測（Node v24）：事件數 203／2015／8060／24120 對應單幀 0.4／1.0／2.4／10.0 ms，整場累計 1／24／419／5159 ms。觸發條件是單場 live 累積兩萬個事件以上；到那個量級才需要改成增量 fold |
| live 去重依賴 SDK 的事件順序 | 目前靠 SDK 把 assistant 的完整快照排在 `content_block_stop` 之前（fixture 03 實測順序）。SDK 若把兩者對調，去重會失效而且是靜默的：畫面上同一段文字出現兩次，沒有任何錯誤 |
| `index.html` 尚無 CSP meta | 補之前要先驗證 dev 模式 HMR 需要的 `connect-src`（vite 的 websocket）與 inline script 需求，否則 dev 會整個載不起來 |
| `agent-host.teardown()` 的重入守衛 | 以 `teardownPromise` 為準，不綁定當下的 query。目前由 ipc-bridge 的 effects 串行保證安全（同一時間只有一條收尾在跑），抽出 event-merge.ts 時要一併改成綁定 query |

## 12. 修訂紀錄

| 日期 | 章節 | 修訂 | 依據 |
|---|---|---|---|
| 2026-09-02 | §3 圖、§3.1 事件、§3.2 第二項 | 事件存放區從 main 移到 renderer。main 只做每幀合併，不留存；存放區在 main 唯一的用途是 renderer 重載後重新同步，沒有資料流讀它，多一條 `invoke` 頻道換不到東西 | 實作計畫契約裁決 25 |
| 2026-09-03 | §7 | idle 狀態下的使用者輸入直接開新對話，不再是靜默丟棄的 no-op | Task 12 驗收 RESULTS-04 待辦第 1 列 |
| 2026-09-03 | §3.1／§4 | user-text 由 main 在送出使用者輸入時合成：現行 SDK 的 streaming input 模式不會把送進去的 `UserTurn` 回送成 user 訊息，live 對話裡原本看不到自己說了什麼 | Task 12 驗收 RESULTS-04 待辦第 2 列 |
| 2026-09-03 | §4.1（裁決 1 的窮舉清單） | `system/api_retry` 與非 Bash 工具的結構化 `tool_use_result`（Write／Edit／Read／Grep 等所有非 Bash 工具，物件且無 stdout／stderr 即視為結構化結果，Ruling 14）列為認得出來但沒有可渲染內容，回空陣列而非 unknown | Task 12 驗收 RESULTS-04 待辦第 9 列 |
| 2026-09-03 | §6 | 輸入框停用的判準改成「還在等使用者回答的請求」，不是「收到過的請求」：批准逾時是主程序自己 deny 掉的，renderer 收不到通知 | Task 12 驗收 RESULTS-04 待辦第 4 列 |
| 2026-09-03 | §7、§8、§11 | 終審修正摘要：歷史載入失敗與未送出輸入改走 events 通道成錯誤卡；interrupt 加 2 秒保險絲；對話清單貼底捲動；session-started action 與 Recents 每回合重載；preload 與 resume cwd 補測試；coverage 改排除制 | 整分支終審報告 |
| 2026-09-03 | §7／§11（已知未修，只記錄，不改正文） | (a) 現行 SDK 對 `canUseTool` 的 deny 只回 `is_error` 的 `tool_result`，不發 `permission_denied`，`denied` 狀態在真實運作中走不到（待辦第 5 列）；(b) streaming input 模式下 query 在 `result` 之後不結束，`live` 要到關視窗或切換 session 才離開，§7 的「結束」實際只有出錯與關閉兩條路（待辦第 3 列）。症狀（進行中的對話不出現在 Recents）已由終審修正處理：session-started action 與每回合重載，live 語意不變；(c) 401 時 `result.errors` 是空陣列，錯誤字串以一般助理文字出現，錯誤卡片沒有訊息欄（待辦第 7 列）；(d) 本版 CLI 對唯讀 Bash（如 `ls`）不呼叫 `canUseTool`（待辦第 8 列）；(e) 主程序沒有收尾三步（deny-all／interrupt／teardown）的記錄點（待辦第 6 列） | Task 12 驗收 RESULTS-04 待辦第 3、5、6、7、8 列 |
