<!-- docs/RESULTS-37-grok-runtime.md -->
# RESULTS-37:Grok 對話

- 日期:2026-09-23
- 規格:`docs/specs/2026-09-22-grok-runtime-design.md`
- 計畫:`docs/superpowers/plans/2026-09-22-grok-runtime.md`
- `grok` 版本:`grok 1.0.40 (eb1a2256660d)`

## 1. 單元測試

| 檔案 | 測試數 | 結果 |
|---|---|---|
| `tests/providers.test.ts` | 11 | 通過 |
| `tests/jsonrpc-stdio.test.ts` | 15 | 通過 |
| `tests/grok-mapper.test.ts` | 20 | 通過 |
| `tests/grok-client.test.ts` | 20 | 通過 |
| `tests/view-tools-http-server.test.ts` | 12 | 通過 |
| `tests/grok-conversation.test.ts` | 27 | 通過 |
| `tests/grok-catalog.test.ts` | 11 | 通過 |
| `tests/grok-view-tools.test.ts` | 8 | 通過 |
| `tests/chef-view-tools.test.ts` | 5 | 通過 |
| `tests/chef-models.test.ts` | 3 | 通過 |
| `tests/ipc-bridge.test.ts` | 108 | 通過 |
| `tests/left-pane.test.tsx` | 32 | 通過 |
| `npm test` 全套 | 2633(144 個檔案) | 通過 |

`npm run typecheck` 也乾淨跑完,沒有錯誤。

## 2. Spike

修正三個問題後,`npm run spike:grok` 用真的 `grok` 跑了一次,十行 JSON 全部 `ok:true`,
`process.exit(0)`。以下逐行照原樣貼:

```text
{"check":"session/new 帶 http mcpServers","ok":true,"detail":"sessionId=01a0ca20-b750-75e0-877e-0ea48d53a579 models=0 metaKeys=[grokShell,defaultAuthMethodId,x.ai/mcp/sdk,x.ai/pluginDirs,currentWorkingDirectory,agentVersion,agentId,agentInstanceId,hostname,modelState,mcpServers,mcpApps,metadata,availableCommands,cancelRewind,sessionRecap,feedbackTraceOffer,voiceMode]"}
{"check":"回合結束","ok":true,"detail":"stopReason=end_turn"}
{"check":"tools/call 打到 yeschef 的 MCP server","ok":true,"detail":"view_snapshot"}
{"check":"request_permission 進得來","ok":true,"detail":"這次沒有需要批准的工具"}
{"check":"事件進得了 mapper","ok":true,"detail":"message-start,block-start,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,unknown,block-stop,block-start,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,text-delta,block-stop,tool-use,tool-result,block-start,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,block-stop,tool-use,tool-result,block-start,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,thinking-delta,block-stop,block-start,text-delta,text-delta,text-delta,text-delta,text-delta"}
{"check":"tools/call 帶的 _meta","ok":true,"detail":"{\"progressToken\":1}"}
{"check":"initialize 之後的每一筆請求都帶 Mcp-Session-Id","ok":true,"detail":"initialize 之後共 4 筆;全部依序=[server/discover:無, initialize:無, notifications/initialized:有, GET:有, tools/list:有, tools/call:有]"}
{"check":"session/list 列得到剛才的 session","ok":true,"detail":"共 3 筆"}
{"check":"session/load 重播得出事件","ok":true,"detail":"user-text,message-start,block-start,thinking-delta,block-stop,block-start,text-delta,block-stop,tool-use,block-start,thinking-delta,block-stop,tool-use,block-start,thinking-delta,block-stop,block-start,text-delta"}
{"check":"session/load 重播計時","ok":true,"detail":"session/update 通知 9 則,耗時 3073ms(含 initialize)"}
```

四個核心項目與三項控制者加驗的項目結果:

- **`session/new` 帶 http mcpServers**:grok 連得上,拿到 sessionId。`metaKeys` 是另外
  用一個獨立的 `initialize` 探測子行程量到的,`modelState` 這個 key 真的存在;主流程那個
  session 的 `client.models()` 這次是 0,原因已經查清楚:`availableModels` 的每一筆用
  `modelId` 當 id,不是 `readModels()` 當時找的 `id`,`reasoningEfforts` 也是物件陣列而且
  在 `_meta` 底下。`readModels()` 已經改成讀真實形狀,`chef/models.ts` 改成共用
  `grokCatalog.models()`,逐字形狀記在規格 §3。
- **`tools/call` 打到 yeschef 的 MCP server**:`view_snapshot` 真的被呼叫,回傳文字也真的
  被 grok 讀回去(回合結束訊息用到那段文字)。
- **`request_permission` 進得來**:grok 自己沒有為這次呼叫要求批准,沒能實測這條路徑,
  只確認了介面接得上。修正後 yeschef 側的政策對 grok 也生效,`view_snapshot` 是 allow,
  所以仍不會出卡;`view_eval` 這類 ask 的工具才會。
- **`session/list` / `session/load`**:`session/list` 列得到剛才的 session,`session/load`
  重播出使用者輸入、思考、文字與兩次工具呼叫,共 9 則 `session/update`,耗時約 3 秒(含
  `initialize`)。
- **`tools/call` 的 `_meta`**:grok 送的 `_meta` 只有 `{"progressToken":1}`,沒有任何形式的
  ACP `toolCallId`。這是網路層攔截到的原始請求體,不是 yeschef 自己選擇性解析出來的結果。
- **`Mcp-Session-Id`**:grok 的 MCP client 行為正確。`initialize` 之前先送一次
  `server/discover`(grok 私有的探測方法),這一筆跟 `initialize` 本身都還沒拿到 session id,
  不算違規;檢查改成找出 `initialize` 的位置,只斷言它之後的請求,detail 列出的四筆
  (`notifications/initialized`、`GET`、`tools/list`、`tools/call`)全部都正確帶了
  `Mcp-Session-Id`。

跑的過程中,`view-tools/http-server.ts` 的 transport 還噴了幾行沒被四個核心項目或三個加驗
項目直接檢查、但很重要的錯誤,原樣記在這裡:

```
右窗格工具的 MCP 傳輸錯誤:Bad Request: Server not initialized
右窗格工具的 MCP 傳輸錯誤:Bad Request: Mcp-Session-Id header is required
右窗格工具的 MCP 傳輸錯誤:Invalid Request: Server already initialized
```

第一行是 grok 送 `server/discover` 時,server 還沒收到 `initialize` 所以正常拒絕,grok 自己
不理會這個拒絕,照樣送 `initialize` 並成功,這行無害。後兩行發生在 `session/load` 重播
那一段:重播用的是第二個 `grok agent stdio` 子行程,它照 grok 自己的協定重新做一次
`server/discover` + `initialize`,但 yeschef 這邊的 HTTP MCP server 是同一個
`StreamableHTTPServerTransport` 執行個體(`createGrokViewTools` 在 `view-tools.ts` 裡把
`http` 這個 promise 快取起來,同一個對話分頁的整個生命週期只開一次,見該檔案
`http ??= start(...)` 那一行),這個 transport 只支援撐一個 client session,已經被第一個
子行程初始化過,第二個子行程的 `initialize` 直接被拒絕。這一版的 `session/load` 沒有因此
壞掉,是因為重播完全是讀 grok 自己存的歷史紀錄,不需要真的呼叫任何右窗格工具;但這代表
第二個子行程的 MCP 連線其實是壞的。這一點後來修掉了,見第 4 節。

## 3. 實機驗收

| # | 項目 | 結果 | 實際看到的 |
|---|---|---|---|
| 1 | 「+ Grok」開新對話,送一句話,串流顯示回覆 | 未驗收 | |
| 2 | 要它改一個檔案,批准卡片出現;允許後改動完成,拒絕後它停下 | 未驗收 | |
| 3 | 要它用右窗格開一個網址並截圖,右窗格真的動,截圖回到對話 | 未驗收 | |
| 4 | 設定一台測試機,要它 `view_login`,回覆不含帳密,右窗格已登入 | 未驗收 | |
| 5 | 關掉分頁再從歷史對話點開同一個 session,內容完整 | 未驗收 | |
| 6 | Chef 允許的模型勾一個 grok 模型,任務被路由到 Grok 對話,跑完後 Chef 收到 report_result | 未驗收 | |
| 7 | 把 `grok` 從 PATH 拿掉再開 Grok 對話,卡片顯示「PATH 找不到 grok,請先安裝」,Claude 與 Codex 不受影響 | 未驗收 | |

## 4. 已知限制

- **`request_handoff` 對 grok 目前用不了,`_meta` 問題已經有答案**。spike 攔到的
  `tools/call` 請求體裡,`_meta` 只有 `{"progressToken":1}`,沒有 `claudecode/toolUseId`
  或任何等效欄位。`src/main/view-tools/handoff.ts` 的 `readToolUseId()` 專門找
  `extra._meta['claudecode/toolUseId']`,對 grok 這個欄位永遠不存在,`ctx.callId` 一定是
  `null`。也就是說 `request_handoff` 沒有任何辦法把等待狀態跟 grok 那一次特定的工具呼叫
  對起來,這條路目前對 grok 是壞的,不是「還沒測」,是「這個版本的協定資訊不夠做這件事」。
- **grok 分頁退到背景不收子行程**。grok 沒有「接回去但不重播」的方法,收掉再回來只能
  `session/load`,那會把整段歷史重播一次。代價是每個開著的 Grok 分頁常駐一個
  `grok agent stdio`。這次 spike 沒有量記憶體佔用,留到實機驗收第 5 項時一起量。
- **Grok 對話的 diff 只看得到 live 的寫檔事件**。grok 沒有「讀某個 session 的歷史項目」
  這種 API,分頁關掉再開,之前那一段的改動不會出現在 diff 的檔案清單裡。
- **`deactivate` 與 `replay` 不自動載入歷史**。與 codex 不同,分頁切到背景時 grok 的子行程
  不收掉(見上一條);但如果子行程真的因為別的原因(故障、`openHistory`)重開,`replay()`
  只重播目前記在記憶體裡的 log,不會自動呼叫 `session/load`,要等使用者自己輸入下一句話
  才會接回去。這是 `src/main/grok/conversation.ts` 裡寫明的設計取捨,不是這次 spike 發現的
  bug。
- **第二個子行程的 MCP 已可接上**。spike 當時第二個 `grok agent stdio` 的 `initialize` 會被
  `Server already initialized` 拒絕。`startViewToolHttpServer` 已改成收 view 工廠:沒帶
  `Mcp-Session-Id` 的 `initialize` 進來時,把目前的 transport 與 view 收掉換一份新的,
  接班的子行程因此握得了手,`tools/call` 也打得進來。第 3 節的實機驗收第 5 項仍要實際驗一次
  「子行程重開後再送一句要用工具的話」。
