# codex app-server dynamicTools 可行性

量測日期:2026-09-09
codex-cli 0.153.4 / macOS 26.6.2 / Node 24.18.0

roadmap 2026-09-09 裁決的第 2 步:多模型互動走「檔案信箱加 `ask_peer` 工具」之前,先驗 codex
那邊能不能讓宿主提供工具。E 規格 §12 查過 0.153.4 的 app-server 有 `ThreadStartParams.dynamicTools`,
標實驗性,沒有實跑過。

## 結果

成立。宿主用 stdio JSON-RPC 起 `codex app-server`,在 `thread/start` 帶一個 `ask_peer` 工具,
`turn/start` 要它用那個工具問同伴;codex 送 `item/tool/call` 過來,宿主回覆後,codex 把回覆用進最終答案。

| 步驟 | 內容 | 耗時 |
|---|---|---|
| `initialize` | `clientInfo` 加 `capabilities.experimentalApi: true` | 即時 |
| `thread/start` | `dynamicTools: [{ type: 'function', name: 'ask_peer', description, inputSchema }]`,`approvalPolicy: 'never'` | 即時 |
| `turn/start` | `input: [{ type: 'text', text: '用 ask_peer 問同伴專案代號…' }]` | |
| codex 先回一句 | `我會用 ask_peer 詢問同伴。` | 4 秒 |
| `item/tool/call` ← | `{ tool: 'ask_peer', arguments: { question: '專案代號是什麼' }, callId, threadId, turnId }` | 7 秒 |
| 宿主回覆 | `{ success: true, contentItems: [{ type: 'inputText', text: '同伴回答:專案代號是 ZANTHER-7719。' }] }` | 即時 |
| codex 最終答案 | `代號是 ZANTHER-7719` | 12 秒 |
| `turn/completed` | items 含 `dynamicToolCall`(status completed)與 `agentMessage`(phase final_answer) | |

## 踩到的三個坑

- 請求一定要帶 `jsonrpc: "2.0"`。沒帶的話 app-server 不回任何東西,stdout 與 stderr 都是空的,
  沒有錯誤訊息。
- `dynamicTools` 要在 `initialize` 宣告 `capabilities.experimentalApi: true`,否則 `thread/start`
  回 `-32600 thread/start.dynamicTools requires experimentalApi capability`。
- `generate-json-schema` 的 `--out <DIR>` 必填,產出 47 個檔案。`DynamicToolSpec`、`UserInput` 這類
  型別不在總表的 `definitions`,在各自參數檔(`v2/ThreadStartParams.json`、`v2/TurnStartParams.json`)
  自己的 `definitions` 裡。

## 對 #5 規格的意義

- `ask_peer` 在兩邊的形狀可以一致:Claude 那邊是 B 的程序內 MCP 工具,codex 那邊是 dynamic tool,
  都是「宿主收到呼叫、阻塞、回文字」。
- codex 的一個 turn 內可以等宿主很久:`item/tool/call` 是 server 對 client 的請求,回覆前 turn
  不會結束。逾時要宿主自己管,沿用 B 的 10 分鐘。
- 通知流裡有 `thread/tokenUsage/updated` 與 `account/rateLimits/updated`,codex 側的用量可以顯示。
- 每個 turn 前後各有一對 `hook/started` / `hook/completed`,是 codex 自己的 hook,與 yeschef 無關。
- `approvalPolicy: 'never'` 只是 spike 用;正式接線時 codex 的批准(`item/commandExecution/requestApproval`、
  `item/fileChange/requestApproval`)要對到 yeschef 的批准卡,那是接線工作的主體。
