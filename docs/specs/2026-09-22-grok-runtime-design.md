# Grok 對話:第三種 agent runtime

- 日期:2026-09-22
- 狀態:設計完成,實作計畫見 docs/superpowers/plans/2026-09-22-grok-runtime.md
- 依據:`docs/specs/2026-09-09-yeschef-5b-codex-adapter-design.md`(Codex 作為第二種對話核心的介面)、`docs/specs/2026-09-12-codex-view-tools-design.md`(Codex 接右窗格工具)、`docs/specs/2026-09-22-test-machines-design.md`(`view_login`)

## 1. 要解決什麼

本機已安裝 xAI 的 `grok` CLI(1.0.40),使用者要在 yeschef 開 Grok 對話,能力要跟 Codex 對話一樣:新對話、串流輸出、工具批准卡片、右窗格瀏覽器工具與測試機登入、worktree、歷史對話續接、主廚路由可選 grok 模型。

`grok agent stdio` 講的是 ACP(Agent Client Protocol,JSON-RPC 2.0 over stdio,換行分隔),跟 `codex app-server` 同一種形狀。yeschef 的 `Conversation` 介面(`src/main/conversation.ts`)已經把 provider 差異封裝掉,Codex 那份 `src/main/codex/` 是現成範本。

一件要先說清楚的事:CLI 裝在本機,模型在 grok.com(`grok models` 顯示 logged in with grok.com),對話內容與工具結果會送出去。測試機密碼由主行程填表,不進模型,不受影響。

## 2. 已決定的事

| 題目 | 決定 |
|---|---|
| 範圍 | 跟 Codex 同等:對話、批准、右窗格工具、worktree、歷史續接、Chef 路由 |
| 接法 | 每個對話一個 `grok agent stdio` 子行程,不用共用 leader,不用每回合 `grok -p` |
| 右窗格工具怎麼掛 | 每對話一個 localhost streamable HTTP MCP server,經 `session/new` 的 `mcpServers` 交給 grok;`type: "sdk"` 的 in-process 形狀 grok 不收 |
| 批准 | 全走 ACP `session/request_permission`,進現有批准卡片;子行程不帶 `--always-approve` 與 `--permission-mode` |
| 模型 | 一般對話用 grok 的預設(目前 grok-4.7,effort high),沒有模型 UI;Chef 路由可選四個 grok 模型 |
| 歷史 | 用 ACP `session/list` 與 `session/load`,不讀 `~/.grok/sessions` 的檔案格式 |
| 全域 MCP server | grok 會把 `~/.grok/config.toml` 的 MCP server 併進每個 session,第一版不干預 |
| provider 型別 | 三處 enum 改成從一份 `PROVIDERS` 表導出 |

## 3. `grok` CLI 的事實

以下是 2026-09-22 對 `grok 1.0.40` 探測的結果,實作以此為準;版本升級後要重驗。

- `grok agent stdio`:stdin/stdout 上的 JSON-RPC 2.0,換行分隔。stderr 會有 tracing 格式的 log(含全域 MCP server 連線失敗的 ERROR),要收下來寫 log,不能當成致命錯誤。
- `initialize`(`protocolVersion: 1`)回應:`agentCapabilities.loadSession: true`、`mcpCapabilities: { http: true, sse: true }`、`sessionCapabilities: { list, resume, close }`、`authMethods`(`cached_token` 讀 `~/.grok/auth.json`)、`_meta.modelState.availableModels`(四個模型)。
- `availableModels` 的一筆逐字長這樣:id 欄位叫 `modelId` 不是 `id`,`reasoningEfforts` 是物件陣列而且在 `_meta` 底下,每個物件的 `id` 才是要送回去的字串。

  ```json
  {
    "modelId": "grok-4.7",
    "name": "Grok 4.7",
    "description": "...",
    "_meta": {
      "totalContextTokens": 500000,
      "agentType": "grok-build-plan",
      "supportsReasoningEffort": true,
      "reasoningEffort": "high",
      "reasoningEfforts": [
        { "id": "xhigh", "value": "xhigh", "label": "Extra High", "description": "...", "default": false },
        { "id": "high", "value": "high", "label": "High", "description": "...", "default": true }
      ]
    }
  }
  ```
- `session/new` 參數:`cwd`、`mcpServers`。`mcpServers` 接受兩種形狀:stdio `{ name, command, args, env }` 與 http `{ name, type: "http", url, headers: [{ name, value }] }`。回應含 `sessionId` 與 `models`。
- session 建立過程會發 `_x.ai/session/setup`(phase 進度)、`_x.ai/mcp/init_progress`、`_x.ai/mcp/server_status`(某個 MCP server 連不上時 `status: "unavailable"`,附 `reason` 與 `detail`)、`_x.ai/models/update`、`_x.ai/settings/update`、`_x.ai/announcements/update`、`_x.ai/session_notification`(`model_changed`、`hook_execution`)。
- 對話事件是標準 ACP `session/update`,`update.sessionUpdate` 為 `agent_message_chunk`、`agent_thought_chunk`、`user_message_chunk`、`tool_call`、`tool_call_update`、`plan`、`available_commands_update`。
- 批准是 agent 發給 client 的請求 `session/request_permission`,參數含 `sessionId`、`toolCall`(`toolCallId`、`title`、`kind`、`rawInput`)、`options`(各有 `optionId`、`name`、`kind`;kind 為 `allow_once`、`allow_always`、`reject_once`、`reject_always`)。回應 `{ outcome: { outcome: "selected", optionId } }` 或 `{ outcome: { outcome: "cancelled" } }`。
- `session/list`(參數 `cwd`)回 `sessions[]`,每筆有 `sessionId`、`cwd`、`updatedAt`、`_meta["x.ai/session"]`(含 `kind`、標題等)。`session/close`(參數 `sessionId`)回 `_meta["x.ai/closeOutcome"]: "closed"`。兩者已用 1.0.40 驗過。
- session 存在 `~/.grok/sessions/<URL 編碼的 cwd>/<sessionId>/`,`session/load`(參數 `sessionId`、`cwd`、`mcpServers`)會把歷史用 `session/update` 重播。探測時 `session/close` 之後緊接著 `session/load` 在 3.5 秒內沒有回應,重播要花多久、以及 close 過的 session 能不能在同一個行程再 load,留給 spike 驗;實作上 `openHistory` 一律開新的子行程 load,不在同一個行程裡 close 再 load。
- 沒登入時 `initialize` 仍成功,`session/new` 或 `session/prompt` 才會失敗;`authMethods` 有列 `grok.com`,但登入要在終端機跑 `grok login`。

## 4. 型別與 provider 表

### 4.1 `PROVIDERS`

`src/shared/projects.ts`:

```ts
export const PROVIDERS = ['claude', 'codex', 'grok'] as const
export type Provider = (typeof PROVIDERS)[number]
export const providerSchema = z.enum(PROVIDERS)
```

`src/main/projects-schema.ts` 與 `src/shared/chef.ts` 各自的 `z.enum(['claude', 'codex'])` 刪掉,改 import `providerSchema`。

### 4.2 `PROVIDER_LABELS`

同檔:

```ts
export const PROVIDER_LABELS: Readonly<Record<Provider, { name: string; tabTitle: string }>> = {
  claude: { name: 'Claude', tabTitle: 'Claude 對話' },
  codex: { name: 'Codex', tabTitle: 'codex 對話' },   // 小寫沿用既有值,改了會讓舊分頁的編號重來
  grok: { name: 'Grok', tabTitle: 'Grok 對話' },
}
```

renderer 與 main 裡所有 `provider === 'codex' ? … : …` 的顯示分支(`NewConversationForm.tsx`、`ConversationPane.tsx`、`WorkspaceHistory.tsx`、`ChefManager.tsx`、`projects-state.ts` 的分頁預設標籤)改查這張表。行為分支(`ipc-bridge.ts` 的 slot 建立、`view-tools/policy.ts`、`chef/routing.ts`)改成 `Record<Provider, …>`,TypeScript 會在少一列時報錯。

既有存檔裡的 `provider` 只會是 `claude` 或 `codex`,schema 放寬不影響讀取。

## 5. 主行程 runtime:`src/main/grok/`

### 5.1 共用的 JSON-RPC stdio

`src/main/codex/rpc.ts` 搬到 `src/main/jsonrpc-stdio.ts`,匯出名稱不變,codex 只改 import。它已經處理:換行分隔、請求與回應配對、server → client 的請求轉發。grok 多用到的只有一點:通知的 method 以 `_x.ai/` 開頭的要能被訂閱者忽略而不進 `unknown` 事件(見 5.3)。

### 5.2 `client.ts`

```ts
export interface GrokClient {
  readonly sessionId: string
  prompt(blocks: readonly PromptBlock[]): Promise<PromptResult>   // session/prompt,回 stopReason
  cancel(): Promise<void>                                          // session/cancel
  close(): Promise<void>                                           // session/close 後結束子行程
  models(): readonly GrokModel[]                                   // initialize 回應的 availableModels
}

export interface GrokClientDeps {
  readonly cwd: string
  readonly mcpServers: readonly AcpMcpServer[]                     // 6. 的 http server
  readonly model?: string
  readonly resume?: string                                         // 有值時用 session/load 而不是 session/new,歷史從 onUpdate 重播
  readonly onUpdate: (method: string, params: unknown) => void     // session/update 與 _x.ai/session_notification 都送,mapper 需要 model_changed
  readonly onPermission: (req: PermissionRequest) => Promise<PermissionOutcome>
  readonly onStderr: (line: string) => void
  readonly onExit: (code: number | null) => void
  readonly spawn?: typeof nodeSpawnGrok                            // 測試接縫
}

export function createGrokClient(deps: GrokClientDeps): Promise<GrokClient>
```

- `spawn('grok', ['agent', 'stdio', ...(model ? ['--model', model] : [])], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })`。找不到指令(`ENOENT`)丟 `MSG_NO_GROK = 'PATH 找不到 grok,請先安裝'`。
- 啟動順序:`initialize` → `session/new` → resolve。`session/new` 失敗時把子行程收掉再 reject,錯誤訊息照 grok 回的 `error.message`;訊息含 `auth`、`login`、`unauthorized` 其中之一時前面加「請先在終端機執行 `grok login`」。
- `session/request_permission` 進來時呼叫 `onPermission`,拿到 outcome 再回。yeschef 這邊回覆前對話被 dispose,回 `{ outcome: "cancelled" }`。
- 只處理 `sessionId` 等於自己的 `session/update` 與 `session/request_permission`;不同 id 的記 log 後丟棄。

### 5.3 `mapper.ts`

`session/update` 轉成 `src/shared/events.ts` 的 `Event`。對應表:

| ACP | Event |
|---|---|
| `session/new` 回應 | `session-start { sessionId, cwd, model }` |
| 第一個 `agent_message_chunk` 或 `agent_thought_chunk` | 先發 `message-start { messageId }`,messageId 用 `grok-<sessionId>-<turn>` |
| `agent_message_chunk`(`content.type: text`) | `text-delta`(區塊開始時先 `block-start`) |
| `agent_thought_chunk` | `thinking-delta` |
| `user_message_chunk`(只在 `session/load` 重播出現) | `user-text` |
| `tool_call` | `tool-use { id: toolCallId, name: title 或 kind, input: rawInput }` |
| `tool_call_update` 帶 `status: completed`/`failed` | `tool-result { id, content, isError }`;`rawOutput` 有 stdout 時另發 `tool-raw-output` |
| `plan` | `text` 一段(條列 entries,標題「計畫」);不做新事件種類 |
| `session/prompt` 回應 `stopReason` | `session-end`;`cancelled` 也算結束 |
| `_x.ai/session_notification` 的 `model_changed` | 更新之後 `message-start` 帶的 model。params 形狀跟 `session/update` 一樣:`{ sessionId, update: { sessionUpdate: "model_changed", model_id, reasoning_effort } }`;同一個 method 的 `hook_execution` 忽略 |
| 其他 `_x.ai/*`、`available_commands_update` | 忽略,不產生 `unknown` |
| 看不懂的 `sessionUpdate` | `unknown { raw }` |

`session/prompt` 回應是回合結束的唯一依據,不用猜「多久沒事件」。

### 5.4 `conversation.ts`

`createGrokConversation(deps): Conversation`,結構照 `createCodexConversation`:

| 方法 | 做法 |
|---|---|
| `userInput(text, attachments)` | 組 `PromptBlock`(文字;附件第一版只帶路徑當文字說明,grok 的 `promptCapabilities.image` 是 false),`client.prompt()`。回合進行中再送:先 `cancel()` 再送,跟 Codex 一樣 |
| `approvalReply(requestId, decision)` | 找到掛著的 `onPermission` promise,`allow` → 選 `kind === 'allow_once'` 的 option,`deny` → `reject_once`;沒有對應 kind 時退回第一個 allow 或 reject 的 option |
| `startNew()` | 關掉現有 client,開新的 |
| `openHistory(sessionId)` | 新 client 用 `session/load`,重播進 mapper,再回到可輸入狀態 |
| `handoffDone` | 比照 Codex |
| `dispose()` | `client.close()`(先 `session/close` 再結束子行程)→ 關 HTTP MCP server,順序固定 |
| `activityEvents` | 只有 live 事件。Codex 有 `items()` 可回溯讀,grok 沒有對應 API,關掉分頁再開就查不到之前的寫檔證據,diff 那側對 grok 只看得到這次開著時的改動 |
| `deactivate()` | 不收子行程。Codex 有 `thread/resume` 可接回去不重播,grok 只有 `session/load`,收掉再回來會把整段歷史重播一次;代價是每個開著的 Grok 分頁常駐一個 `grok agent stdio`。`replay()` 也不自動 load,重開 app 後第一次輸入才 `session/load` |

子行程意外結束(`onExit` 非 0 或 signal):發 `session-end` 與一段錯誤文字,對話回到可重新開始的狀態。stderr 每行進 `logError`,不進對話。

### 5.5 `catalog.ts`

```ts
export interface GrokCatalog {
  models(): Promise<readonly GrokModel[]>
  list(cwd?: string): Promise<readonly SessionSummary[]>          // session/list,形狀跟 CodexCatalog.list 一致,ipc-bridge 用同一張表查
}
```

開一個短命的 `grok agent stdio`,`initialize` 後取模型,`session/list` 取該 cwd 的 session(id、title、updatedAt),然後結束。同一個連線兩件事一起做,結果各快取 30 秒。跟 `chef/models.ts` 用 `codex app-server` 拿 `model/list` 同一種做法。找不到 `grok` 時回空清單,不丟錯,歷史清單與 Chef 不能因為沒裝 grok 而壞掉。

### 5.6 `ipc-bridge.ts`

`createSlot` 的「if codex else claude」改成:

```ts
const factories: Record<Provider, (args: SlotArgs) => Conversation> = { claude, codex, grok }
```

grok 那列從 `deps.grokViewTools`(6. 的 server 工廠)拿到 `mcpServers` 後呼叫 `createGrokConversation`。`transcriptPath` 對 grok 為 null,與 Codex 相同。

`index.ts` 的 `runtimeFor` 多收第四個參數 `provider`:grok 且 `chef.worker(conversationId)` 有值時,把 Chef 的三個工具交給 `createConversationViewServer` 的 `chefTools`;Claude 走 `sessionOptions.mcpServers.chef`、Codex 走 dynamicTools,不從這裡拿,避免模型同時看到兩份 `report_result`。

## 6. 右窗格工具:每對話一個 localhost MCP server

### 6.1 `src/main/view-tools/http-server.ts`

```ts
export interface ViewToolHttpServer {
  readonly url: string             // http://127.0.0.1:<port>/mcp
  readonly token: string
  close(): Promise<void>
}
export function startViewToolHttpServer(makeView: () => ConversationViewServer, logError: (e: Error) => void): Promise<ViewToolHttpServer>
```

- 內容是現有的每對話 `createConversationViewServer`(`conversation-server.ts`)產出的 MCP server,多包一層 `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`,掛在 `node:http` 的 `createServer`,`listen(0, '127.0.0.1')`。`createSdkMcpServer(...).instance` 是 agent SDK 自己打包的那份 class,`instanceof` 我們 `node_modules` 的 `McpServer` 為 false,但 `connect(transport)` 可用,所以沿用同一份,不另建第二份工具定義。
- transport 要 stateful:`sessionIdGenerator: () => randomUUID()` 加 `enableJsonResponse: true`。stateless 在第二個請求就會丟 `Stateless transport cannot be reused across requests`。grok 的 MCP client 要帶 `Mcp-Session-Id`,這一點由 spike 驗。
- 一個 grok 子行程等於一個 MCP session 等於一個 transport。`openHistory` 與 crash 後重啟都會開新的子行程,接班的那一個會從頭送 `initialize`;同一份 transport 收到第二次只會回「Server already initialized」。所以 server 收的是工廠而不是單一 view:沒帶 `Mcp-Session-Id` 的 `initialize` 進來時,把目前的 transport 與 view 收掉,用工廠換一份新的再走握手。同一時間只有一個子行程,所以是替換,不是 session 表。
- 對話是 Chef worker 時,同一個 server 多 `delegate_task`、`task_progress`、`report_result` 三個工具,呼叫走跟 codex dynamicTools 相同的處理函式;非 worker 的對話沒有這三個。
- 工具清單同一份 `VIEW_TOOL_DEFS` 加 `ask_peer`、`answer_peer`,名稱與描述跟 Claude、Codex 那側一樣。工具呼叫進同一個 `invoke()`,批准政策照 `view-tools/policy.ts`。
- `@modelcontextprotocol/sdk` 從間接依賴改成 `package.json` 直接依賴,版本 `1.30.0`(跟 `@anthropic-ai/claude-agent-sdk` 帶的同一版,`node_modules` 不會多一份)。

### 6.2 安全

- token:`randomBytes(32).toString('base64url')`,每個 server 一個。
- 每個請求檢查三件事,任一不過就 401 並結束連線,不回 MCP 錯誤:`Authorization` 等於 `Bearer <token>`;`socket.remoteAddress` 是 `127.0.0.1` 或 `::1`;`Host` 等於 `127.0.0.1:<port>`(擋 DNS rebinding)。
- token 只出現在 `session/new` 的 `mcpServers[].headers`,不寫檔、不進 log、不進 renderer、不進事件。
- server 的生命週期等於對話:`dispose()` 先 `session/close` 再 `close()`;反過來 grok 的 MCP client 會在關閉時把 handshake 錯誤噴到 stderr。

### 6.3 交給 grok 的形狀

```json
{ "name": "yeschef", "type": "http", "url": "http://127.0.0.1:<port>/mcp",
  "headers": [{ "name": "Authorization", "value": "Bearer <token>" }] }
```

### 6.4 全域 MCP server

grok 會把 `~/.grok/config.toml` 設定的 MCP server 併進每個 session(`mcp_merge` 階段)。第一版不干預:這跟使用者在終端機開 `grok` 的行為一致。這些 server 的工具批准同樣經 `request_permission` 走 yeschef 的卡片。`_x.ai/mcp/server_status` 回 `unavailable` 時記一行 log,不顯示在對話裡。

## 7. 批准

- `session/request_permission` 轉 `ApprovalAsk`:`toolUseId: toolCall.toolCallId`、`toolName: toolCall.title`(沒有就用 `kind`)、`input: toolCall.rawInput`、`title: toolCall.title`、`displayName` 用 `kind`。進同一個 `createApprovalRegistry`,renderer 的卡片不改。
- 回覆只選 `allow_once` 與 `reject_once`。不選 `*_always`:那會存進 grok 自己的 session 狀態,yeschef 管不到,也對不上現有的權限管理畫面。
- `view-tools/policy.ts`:grok 的 `view_navigate` 是 `allow`,跟 Claude 相同。Codex 那條 `ask` 是因為 codex 沙箱的網路限制,grok 預設沒開沙箱,沒有同樣的繞過問題。
- grok 的 view 工具在 yeschef 這側同樣經過 `viewToolPolicy`,ask 的工具走同一個批准卡片;grok 自己另外問的話會多一張它的卡。閘門在 `grok/view-tools.ts`,包在交給 `createConversationViewServer` 的 `resolve` 外面,拒絕時回 `MSG.approvalDenied`。`tools/call` 沒有帶 toolUseId,卡片的 id 由閘門合成。
- 批准逾時沿用 `approvalTimeoutMs`,逾時回 `reject_once`。

## 8. 歷史對話與 Chef

### 8.1 歷史清單

側欄「歷史對話」與 WorkspaceHistory 的來源多一種:`grokCatalog.list(cwd)`,每筆標 `provider: 'grok'`。點開走 `Conversation.openHistory(sessionId)` → `session/load`。沒裝 grok 時這個來源是空的,清單其他部分照常。

### 8.2 Chef

- `chef/models.ts` 的 `grok()` 呼叫 `grokCatalog.models()`,把 `GrokModel` 轉成 key `grok:<id>` 的模型項。它不自己 spawn 也不自己解析:同一份探測與歷史清單共用一個短命子行程與快取,解析只有 `client.ts` 的 `readModels` 一份。`index.ts` 把建好的 `grokCatalog` 傳進 `createChefModelCatalog`。
- `chef/routing.ts` 的挑模型改 `Record<Provider, …>`。
- `ChefManager` 的允許模型清單多一組 Grok。
- review 的挑模型規則原本是 claude 與 codex 二選一翻轉,三家之後改成 kind → provider 查表,再加「跟上一次不同家」的加分。
- 路由到 Grok 的 worker 透過 6.1 的三個 Chef 工具回報,`report_result` 進 Chef 的同一個處理函式。

## 9. Renderer

- `LeftPane.tsx` 多一顆「+ Grok」,呼叫同一個 `start('grok')`,走 `conversations:open`。
- 顯示文字全部改查 `PROVIDER_LABELS`。
- 找不到 grok 指令或未登入時,對話卡片顯示 5.2 的訊息,文案形狀比照 Codex 的 `MSG_NO_CODEX`。

## 10. 不會變的東西與範圍外

- Claude 與 Codex 的行為不變;`codex/rpc.ts` 搬家只是路徑。
- 不做模型選單、不做 reasoning effort 設定、不做 `--worktree`(worktree 由 yeschef 自己管,跟 Codex 一樣)。
- 不讀 `~/.grok/sessions` 的檔案。
- 不處理 grok 的 `session/request_permission` 之外的 client 端能力(`fs/read_text_file`、`terminal/*` 在 `initialize` 都宣告成 false,grok 會自己做)。
- 圖片附件:grok 的 `promptCapabilities.image` 是 false,附件只帶路徑文字,附帶的指示句也換成沒有提原生圖片輸入的那一版。
- `request_handoff` 對 grok:維持文件化限制。`tools/call` 的 `_meta` 只有 `progressToken`,拿不到 toolUseId,spike 已證實。之後可用單槽 handoff 的 looseMatch 做,這一版不做。
- `GrokProcess` 在 `grok/client.ts` 自己定義,不 import codex 的 `CodexProcess`;兩個介面長一樣是刻意的,grok 不依賴 codex 模組。
- `providerSchema` 放在 `src/shared/projects.ts` 會讓它 import zod;renderer 早就因 `shared/chef.ts`、`shared/test-machines.ts` 打包了 zod,檔頭那句「不引入 zod」改掉。

## 11. 測試與驗收

### 11.1 單元測試(vitest,不碰真行程)

| 檔案 | 驗什麼 |
|---|---|
| `tests/grok-mapper.test.ts` | 用探測抓下來的 ACP 通知當 fixture:文字與 thought 的 chunk 合成 delta、`tool_call` 與 `tool_call_update` 成對、`plan`、`model_changed` 影響下一個 `message-start`、`_x.ai/*` 與 `available_commands_update` 不產生 `unknown`、看不懂的 `sessionUpdate` 才是 `unknown` |
| `tests/grok-client.test.ts` | 假 stdio:`initialize` → `session/new` → `prompt` 的順序與參數(`mcpServers` 帶對形狀)、`request_permission` 轉 `onPermission` 且回覆帶 `optionId`、dispose 中的請求回 `cancelled`、`ENOENT` 變 `MSG_NO_GROK`、不同 `sessionId` 的通知丟棄、stderr 進 `onStderr` |
| `tests/grok-conversation.test.ts` | 假 client:`Conversation` 每個方法;回合中再送先 cancel;`openHistory` 重播;子行程意外結束後 `session-end`;dispose 順序(close 在 HTTP server 之前) |
| `tests/grok-catalog.test.ts` | 一個連線取模型與 session 清單、快取 30 秒、找不到 grok 回空清單 |
| `tests/view-tools-http-server.test.ts` | 沒 token 401、錯 token 401、`Host` 不符 401、正確請求能 `tools/list` 與 `tools/call`、`close()` 後連不上 |
| `tests/providers.test.ts` | 三處 schema 都接受 `grok`;`PROVIDER_LABELS` 與行為表對 `PROVIDERS` 每一項都有值 |
| 既有 codex 測試 | `rpc.ts` 搬家後全綠 |

### 11.2 Spike(真的 `grok`,手動跑,不進 `npm test`)

`npm run spike:grok`:開 session、掛 http MCP server、送一句要它呼叫 `view_snapshot` 的 prompt,驗證 `tools/call` 真的打到 yeschef 的 server、`request_permission` 進來、回 allow 後回合結束;再驗 `session/list` 列得到剛才的 session、`session/load` 重播出同樣的事件。每項印一行 JSON。這會用到 grok.com 的額度。

### 11.3 實機驗收(寫進 RESULTS)

1. 「+ Grok」開新對話,送一句話,串流顯示回覆。
2. 要它改一個檔案,批准卡片出現,允許後改動完成;拒絕後它停下。
3. 要它用右窗格開一個網址並截圖,右窗格真的動,截圖回到對話。
4. 設定一台測試機,要它 `view_login`,回覆不含帳密,右窗格已登入。
5. 關掉分頁再從歷史對話點開同一個 session,內容完整。
6. Chef 允許的模型勾一個 grok 模型,任務被路由到 Grok 對話,跑完後 Chef 收到 `report_result`。
7. 把 `grok` 從 PATH 拿掉再開 Grok 對話,卡片顯示「PATH 找不到 grok,請先安裝」,Claude 與 Codex 對話不受影響。
