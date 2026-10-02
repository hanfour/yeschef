# 子專案 5b:codex 對話分頁

## 0. 範圍與依賴

codex 對話分頁是另一種 conversation core。renderer、fold、批准卡、Recents 都只認 `Event`、
`SessionState`、`ApprovalAskPayload` 三個型別;5b 寫一個把 codex app-server 協定翻成這三個型別的
adapter,接到 D 的 `ProjectRuntime`。renderer 一行不改。

依賴:子專案 D2(第二個對話需要多對話執行期)、子專案 B 的批准 registry、
`docs/RESULTS-11-codex-dynamic-tools.md` 的協定實測。被依賴:子專案 P 的 5c。

不做:codex 特有的畫面(`plan`、`collabAgentToolCall`、`webSearch`)第一版當未知事件;
`acceptForSession` 與 execpolicy 修正;右窗格工具給 codex 用(那是 5c 之後的事)。

## 1. 資料流

```
codex app-server(stdio JSON-RPC,每個 codex 對話一個子程序)
   ↓ 通知 item/*、turn/*、thread/*;請求 item/*/requestApproval
CodexAdapter(src/main/codex/)
   ↓ Event[]、SessionState、ApprovalRequest
ConversationSink(ipc-bridge 既有的那一個,D2 之後帶 conversationId)
   ↓ IPC
renderer(不動)
```

adapter 對外的介面與 D 的 `Conversation` 相同:`activate`、`deactivate`、`dispose`、
`userInput`、`interrupt`、`replay`、`heldApprovals`。`ipc-bridge` 依 `TabEntry.provider`
決定 `createSlot` 用哪一個工廠。

## 2. 事件對應

codex 的 `ThreadItem` 有 19 種,只對應用得到的,其餘一律 `unknown`(既有的 unknown block 畫成
可展開的「未知事件」,不靜默丟)。

| codex | yeschef `Event` | 備註 |
|---|---|---|
| `thread/started` | `session-start`,`sessionId` 用 thread id,`model` 從 `thread/start` 回應取 | |
| `item/agentMessage/delta` | `text-delta`,`messageId = item.id`,`index = 0` | fold 的去重鍵是 `(messageId, index)` |
| `item/completed` `agentMessage` | `text` 完整快照 | `phase` 為 `commentary` 與 `final_answer` 都是文字 |
| `item/completed` `reasoning` | `thinking` | `summary` 有值用 summary,否則 `content` |
| `item/started` `commandExecution` | `tool-use`,`name: 'Bash'`,`input: { command, cwd }`,`id = item.id` | 沿用 Bash 的畫法 |
| `item/completed` `commandExecution` | `tool-result` 加 `tool-raw-output`(`aggregatedOutput`、`exitCode`) | `status` 不是 `completed` 就 `isError` |
| `item/started` / `completed` `fileChange` | `tool-use` `name: 'Edit'`,`input: { changes }` / `tool-result` | 沿用 Edit 的畫法 |
| `mcpToolCall`、`dynamicToolCall` | `tool-use` / `tool-result`,`name` 用 `tool` | 5c 的 `ask_peer` 走這條 |
| `contextCompaction` | `compact-boundary`,`trigger: 'auto'`,沒有 token 數就不畫數字 | 沿用壓縮分隔線 |
| `turn/completed` | `session-end`(`isError: false`) | D 的 `busy` 靠它解除 |
| turn 以錯誤結束 | `session-end` `isError: true`,`message` 用 `error.message` | 走既有錯誤卡 |
| `thread/tokenUsage/updated` | 併進 `session-end` 的 `cost`,只有 `turns` 與 token 數,沒有 USD | 畫面顯示 token 數 |
| `userMessage`、`plan`、`webSearch`、`hookPrompt`、其餘 | `unknown` | 看實際頻率再決定要不要專門畫 |

`item/started` 與 `item/completed` 的 `agentMessage` 可能只來一次(沒有 delta):adapter 以
`item/completed` 的完整快照為準,delta 只是先畫。

## 3. 批准

codex 的兩種批准請求(`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`)
都是 server 對 client 的 JSON-RPC 請求,回覆前 turn 不動。adapter 送進 D 的
`ApprovalRegistry.request()`:

| 欄位 | commandExecution | fileChange |
|---|---|---|
| `toolUseId` | `itemId` | `itemId` |
| `toolName` | `Bash` | `Edit` |
| `input` | `{ command, cwd, reason }` | `{ changes, reason }` |

之後的批准卡、背景扣住、待批准記號、settled 通知、30 秒逾時全部沿用。

decision 對應:

| 批准卡 | codex `decision` | 說明 |
|---|---|---|
| 允許 | `accept` | 只這一次 |
| 拒絕 | `decline` | turn 繼續。不用 `cancel`,那會中斷整個 turn,跟 Claude 那邊「拒絕後模型繼續」不一致 |
| 30 秒逾時 | `decline` | 同上 |

`thread/start` 與 `thread/resume` 的 `approvalPolicy` 用 `untrusted`:可信集合以外的都問,
跟 Claude 那邊 `permissionMode: 'default'` 的精神一樣,由 app 問。問太多再放寬。

`item/tool/requestUserInput`(codex 要問使用者問題)第一版回空答案並記 log,畫成未知事件。

## 4. 中斷

D 的 `interrupt-query` effect 對到 `turn/interrupt { threadId, turnId }`。adapter 從
`turn/started` 記下現行 `turnId`,沒有進行中的 turn 就不送。

## 5. 行程與生命週期

一個 codex 對話一個 `codex app-server` 子程序,stdio,cwd 是專案根目錄。

| D 的狀態機 | Claude | codex |
|---|---|---|
| 第一次送訊息 | 開 `query()` | spawn → `initialize`(`clientInfo` 加 `capabilities.experimentalApi: true`)→ `initialized` → `thread/start`(`cwd`、`approvalPolicy: 'untrusted'`、`dynamicTools: []`)→ `turn/start` |
| 之後每則訊息 | 串流輸入 | `turn/start`,`input: [{ type: 'text', text }]` |
| 切到背景,回合結束 | sleep | 關 stdin → 等 2 秒 → SIGTERM;thread 留在 `~/.codex/sessions` |
| 切回前景送訊息 | `resume` | spawn → `initialize` → `initialized` → `thread/resume { threadId }` → `turn/start` |
| app 重啟 | 同上 | 同上,`threadId` 存在 `SessionLink.sessionId`、`provider: 'codex'` |
| dispose | teardown | 有進行中 turn 先 `turn/interrupt` → 關 stdin → 等 2 秒 → SIGTERM |

背景時收掉子程序是刻意的:跟 Claude 對稱,記憶體有上限。代價是切回來第一則多等 spawn 加
resume,RESULTS-11 量到 `initialize` 與 `thread/start` 都在 100 毫秒內。

每個請求 adapter 統一加 `jsonrpc: "2.0"`,單元測試釘住(RESULTS-11 的坑:缺了會靜默不回)。

## 6. 錯誤

| 情況 | 處理 |
|---|---|
| codex 未登入 | `thread/start` 回錯 → `session-end` `isError`,message「codex 未登入,請在終端執行 `codex login`」 |
| 子程序非零退出或 stdout 斷 | `session-end` `isError`,走既有錯誤卡;D 的 `onError` 記 log |
| `turn/start` 回 JSON-RPC 錯誤 | 同上,message 用 `error.message` |
| 非 JSON 的 stdout 行 | 記 log 略過(RESULTS-11 的 spike 就是這樣處理) |
| 請求 30 秒沒回應(`initialize`、`thread/start`) | 視為子程序壞掉,SIGTERM,`session-end` `isError` |

## 7. 分頁列與入口

D2 的「新對話」按鈕只開 Claude;5b 加「新 codex 對話」。分頁標籤「codex 對話」。
`TabEntry.provider: 'codex'`。PATH 沒有 `codex` 時按鈕仍在,按下去的對話第一則就走第 6 節
「未登入」那條錯誤,訊息改成「PATH 找不到 codex,請先安裝」。

## 8. 測試與驗收

單元(adapter 全部用假的 stdio 對測,不起真的 codex):

- 事件對應表每一列一測,含 `unknown` 的落入。
- `text-delta` 的 `messageId`、`index` 與 fold 對得上:delta 之後來完整快照不重複。
- 批准:兩種請求進 registry 的欄位;允許 → `accept`、拒絕 → `decline`、逾時 → `decline`。
- 生命週期:第一則 spawn 的請求順序;背景 sleep 收掉子程序;resume 用 `thread/resume`;
  dispose 有進行中 turn 先 interrupt。
- `jsonrpc` 欄位每個請求都有。
- 六種錯誤各一測。

實機:

| # | 項目 | 通過條件 |
|---|---|---|
| 1 | 開 codex 對話,送一則要它跑 `ls` | 畫面有 Bash 的 tool block、輸出、最終回覆;`~/.codex/sessions` 多一個 thread |
| 2 | 要它改一個檔案 | 出批准卡(Edit),允許後檔案真的改了;拒絕後 codex 回覆說被拒 |
| 3 | 切到別的對話再切回 | codex 對話的畫面完整;子程序在背景時已收掉(`ps` 看不到) |
| 4 | app 重啟後在 codex 對話送第二則 | 走 `thread/resume`,codex 記得第一則的內容 |
| 5 | 回合進行中按停止 | `turn/interrupt` 送出,畫面出現中斷 |
| 6 | 未登入(暫時把 `~/.codex/auth.json` 改名) | 錯誤卡文字正確,還原後正常 |

## 9. 不採用的做法

- 另做一套 codex 畫面:差異只在名字,收在 adapter 裡畫面共用,5c 兩邊才長得一樣。
- `approvalPolicy: 'never'`(spike 的設定):批准要經 app,不能繞過。
- 背景時保留 app-server 子程序:每個對話一個常駐行程,記憶體沒有上限。
- 用 `codex app-server daemon` 共用一個 server:多一層 socket 與 `proxy`,而且 daemon 的生命週期不歸 yeschef 管。

## 10. 參考

- `docs/RESULTS-11-codex-dynamic-tools.md`
- `docs/specs/2026-09-09-yeschef-d2-multi-conversation-design.md`
- `docs/specs/2026-09-09-yeschef-peer-design.md` §8
- codex app-server 0.153.4 的 schema:`codex app-server generate-json-schema --experimental --out <DIR>`

## 11. 修訂紀錄

| 日期 | 章節 | 變更 | 依據 |
|---|---|---|---|
| 2026-09-09 | 全 | 初版。兩節設計逐節經使用者確認 | RESULTS-11、schema 0.153.4 |
| 2026-09-10 | §2、§3、§0 | 實作後補四項:`session-start` 由 `thread/start` 的回應產生(回應才有 model,`thread/resume` 沒有 `thread/started` 通知),mapper 對 `thread/started` 回空;`fileChange` 的批准卡 input 只有 `reason`(`FileChangeRequestApprovalParams` 沒有 `changes` 欄位,diff 在 `item/started` 已畫進 tool block);codex 對話不畫 Recents 側欄也不查 Claude 的 session 清單(那份清單對 codex 沒有意義);`session-end` 加選填的 `tokens`,回合結尾顯示 token 數 | 實作與整條分支最終審查 |
| 2026-09-10 | §6 | 30 秒逾時只套在 `initialize` 與 `thread/start`;`turn/start` 與 `turn/interrupt` 不設逾時(回合可能跑很久) | 最終審查 |
