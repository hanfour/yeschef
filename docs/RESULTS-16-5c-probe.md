# 5c 接線前的協定探測

量測日期:2026-09-10
codex-cli 0.153.4 / macOS 26.6.2 / Node 24.18.0

RESULTS-11 已經驗過「宿主可以給 codex 一個 dynamic tool 並阻塞回覆」。這次要接真的線,
三件事會決定接法,先問協定再設計。用一支獨立探針直接對 `codex app-server` 說話。

## 三個問題與答案

| 問題 | 答案 | 證據 |
|---|---|---|
| `thread/resume` 收不收 `dynamicTools`? | 收。resume 之後工具還在,叫得動 | resume 帶兩個工具沒有報錯;之後的 turn 成功呼叫 `answer_peer` |
| 兩個工具能不能並存? | 能。codex 會挑對的那個 | 同一個 thread 先叫 `ask_peer`、後叫 `answer_peer`,參數都對 |
| 工具回失敗時 codex 怎麼反應? | item 的 status 變成 `failed`,錯誤文字會進到模型的最終答案 | 回 `{ success: false, contentItems: [...「這個專案沒有別的同伴」] }`,codex 的最終答案就是那句話 |

## 形狀

伺服器對宿主的請求:

```json
{ "method": "item/tool/call",
  "params": { "threadId": "…", "turnId": "…", "callId": "exec-…", "tool": "ask_peer",
              "arguments": { "question": "專案代號是什麼" } } }
```

宿主的回覆:

```json
{ "result": { "success": true, "contentItems": [{ "type": "inputText", "text": "同伴回答:…" }] } }
```

同一顆呼叫在通知流裡出現兩次:`item/started` 帶 `status: "inProgress"`,
`item/completed` 帶 `status: "completed"` 或 `"failed"` 與 `contentItems`。
yeschef 的 mapper 已經把 `dynamicToolCall` 對到 `tool-use`,工具名稱原樣用,不必再改。

## 一個踩到的坑

`turn/start` 的回應只代表「收到了」,不代表回合結束。第一次探針把它當成結束,
三個 turn 在同一秒「跑完」,thread 其實是空的,接著 `thread/resume` 回
「rollout … is empty」。回合結束要等 `turn/completed` 或 `turn/failed` 的通知。
yeschef 的 client 本來就是這樣做的,這個坑只發生在探針。

## 對 5c 接線的意義

- 兩邊的工具形狀一致:Claude 那邊是程序內 MCP 工具,codex 那邊是 dynamic tool,
  都是「宿主收到呼叫、阻塞、回文字」。錯誤都以文字回給模型,不必另開錯誤通道。
- `thread/start` 與 `thread/resume` 都要帶 `dynamicTools`,少一邊就是「重開 app 之後
  那個 codex 對話不能問也不能答」。
- 注入走既有的 `send()`(`turn/start`),codex 的 `userInput` 本來就會在本機推一則
  `user-text`,所以 `fold` 的同伴提問解析在 codex 這側自動成立,不必另外處理。
