# codex 對話接上右窗格瀏覽器工具

- 日期:2026-09-12
- 狀態:設計定案,待實作
- 依據:`docs/specs/2026-09-07-yeschef-roadmap.md` §2.1 與 §4 第 7 項;`docs/RESULTS-22-codex-view-tools-probe.md`(九個協定問題的實測)

## 1. 要解決什麼

右窗格的八個瀏覽器工具(`view_navigate`、`view_snapshot`、`view_screenshot`、`view_click`、`view_type`、
`view_press`、`view_eval`、`request_handoff`)只接給 Claude Agent SDK。codex 對話 2026-09-12 實測沒有這些工具。
roadmap §2.1 把「A+B+C 不等於整合工作流」列為明確限制,這一步把 codex 接上。

## 2. 接法:走 `dynamicTools`,跟 `ask_peer` 同一條路

不起獨立的 MCP server 程序。理由:批准、網址白名單、rootPath 限制、前景互斥、切走時中止,全部是主行程裡
既有的零件(`view-tools/policy.ts`、`urls.ts`、`controller-core.ts`、`server.ts` 的 `runTool`);獨立程序得把這些
再做一遍,還要改使用者的全域 `~/.codex/config.toml`。

## 3. 協定上已經實測的事(RESULTS-22)

| 事 | 結論 | 設計怎麼用 |
|---|---|---|
| 圖片 | `contentItems` 的 `inputImage.imageUrl` 吃 `data:` 與 `file://`,不吃 `https://` | 截圖回 `[{inputText}, {inputImage: 'data:image/png;base64,…'}]` |
| 多項內容 | 文字與圖都進模型 | 同上 |
| 工具名 | 10 個平鋪照單全收;namespace 會把名字變成 `view__click` | 平鋪,名字跟 Claude 那邊一樣(不加 `mcp__yeschef__` 前綴,codex 沒有這個慣例) |
| `deferLoading` | 平鋪時被拒 | 不用 |
| 同一 thread 併發 | 不會,app-server 一顆一顆發 | 不必自己序列化 |
| 兩個 thread 搶 | `threadId`、`callId` 都不同;輸家看提示決定重試或放棄 | 沿用前景守衛:非前景對話呼叫回 `success:false` 加 `MSG.browserBusy` |
| 逾時 | 60 秒不會被 codex 取消;`turn/interrupt` 後遲到的回覆被靜默丟棄 | `request_handoff` 的 10 分鐘等待可行;回覆 promise 不必特別處理中斷 |
| 批准時序 | `item/started` 與 `item/tool/call` 同一刻,`item/started` 在前 | 批准卡掛在那個 tool block 底下,人看得到是誰要的 |
| `callId` | 與 `item/started` 的 `item.id` 同值 | `request_handoff` 用 `callId` 當 `toolUseId` |
| resume | `thread/resume` 帶 8 個工具後全在 | 沿用 `client.ts` 現有的 resume 帶 `dynamicTools` |

## 4. 設計

### 4.1 工具定義一份,兩個殼

`server.ts` 現在把「工具定義(zod)+ handler」綁在 SDK 的 `tool()` 裡。拆成:

- `ProjectViewTools.invoke(name, args, ctx): Promise<ToolOutput>`:與後端無關的入口,做前景守衛、`inflight` 登記、
  合併 AbortSignal、呼叫 controller。`ctx = { signal?: AbortSignal; callId: string }`。
- Claude 的殼:`tool(name, description, zodShape, (args, extra) => invoke(name, args, { signal: extra.signal, callId: extra._meta.toolUseId }))`,行為不變。
- codex 的殼:`dynamicTools` 規格陣列由同一份定義產生(`{ type:'function', name, description, inputSchema }`,
  inputSchema 從 zod 轉 JSON Schema);`onDynamicToolCall(tool, args, params)` 分派到 `invoke`,`callId` 從
  `DynamicToolCallParams.callId` 取。回覆:`ToolOutput.kind === 'image'` 時 `[{type:'inputText', text}, {type:'inputImage', imageUrl: dataUrl}]`,
  否則 `[{type:'inputText', text}]`;錯誤 `{ success:false, contentItems:[{type:'inputText', text}] }`。

### 4.2 批准

codex 的 dynamic tool 呼叫不經 codex 自己的批准流程。`onDynamicToolCall` 先問 `viewToolPolicy(fullToolName(name), 'codex')`
(白名單裝的是 `mcp__yeschef__` 全名,平鋪名字直接傳會落到「未知 → ask」,八個工具全要批准):
`ask` 的(`view_eval` 與 `view_navigate`)先 `await requestApproval(...)`(`codex/conversation.ts:157` 那個通用的),
拒絕就回 `success:false` 與拒絕原因;允許再 `invoke`。批准卡的 `toolUseId` 用 `callId`,它跟畫面上那個 tool block 的
`item.id` 同值,卡會掛在正確的 block 底下。
codex 跑在沒有網路的 `workspace-write` 沙箱裡,`view_navigate` 也須批准,避免把資料編進任意 HTTP/HTTPS URL 外送而繞過沙箱限制;批准卡保留工具名稱與包含網址的輸入。

### 4.3 前景互斥與切走中止

`ipc-bridge.ts` 的 codex 分支現在不呼叫 `runtimeFor`,所以沒有 viewTools、沒有 `isActive`。改成跟 Claude 分支一樣
拿 `runtime`,`isActive = () => currentId === conversationId`,`switchTo` 的 `abortPending(MSG.browserBusy)` 對 codex slot
一樣生效。非前景對話呼叫工具回 `success:false` + `MSG.browserBusy`。

### 4.4 `request_handoff`

沿用 `handoff.ts`:`callId` 當 `toolUseId`,人按「完成」時 `handoffDone(callId)`。`codex/conversation.ts:341` 的
`handoffDone` 從「codex 對話沒有交接卡」改成轉給 runtime 的 handoff。

### 4.5 畫面

`mapper.ts` 的 `dynamicToolCall` 已經把 tool-use 與 tool-result 畫出來。兩處要改:`ConversationPane` 決定畫交接卡
與批准卡的比對用的是全名(`REQUEST_HANDOFF_TOOL`),codex 的 block 名字是平鋪的,改成兩種名字都認(`isViewToolName`);`tool-result` 的 content 是原始
`contentItems`,`extractImages`(`tool-images.ts`)要多認一種形狀:`{ type:'inputImage', imageUrl:'data:…' }`,
這樣 codex 的截圖也直接畫出來、也能開側邊預覽。

## 5. 非目標

- Claude 那邊不變;codex 除 `view_eval` 外多一個 `view_navigate` 需要批准,其餘白名單工具自動允許。
- 不做 codex 端的 MCP server。
- 兩個 codex 對話同時操作瀏覽器:跟現在 Claude 一樣只有前景那個能用。

## 6. 驗收

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | codex 對話:`view_navigate` 開 example.com(先出現批准卡,允許)再 `view_screenshot`,問大標題 | 答「Example Domain」;tool block 展開是圖不是 base64;截圖旁有「在側邊預覽開啟」 |
| 2 | codex 對話:`view_eval` 讀 `document.title` | 批准卡掛在那個 tool block 底下;允許後拿到標題 |
| 3 | codex 在跑 view 工具時切到另一個對話 | 它收到 `MSG.browserBusy`;切回來再叫可以 |
| 4 | codex 對話:`view_navigate` 開 `file:///etc/passwd` | 被 `checkNavigateUrl` 擋,回錯誤文字 |
| 5 | codex `request_handoff` | 交接卡出現;按完成後 codex 收到「完成」並接續 |
| 6 | 關 app 重開,同一條 codex thread 再叫 `view_snapshot` | 可用(resume 帶了工具) |
