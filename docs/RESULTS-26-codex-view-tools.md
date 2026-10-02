# RESULTS-26:codex 對話接上右窗格瀏覽器工具 實機驗收

- 日期:2026-09-12
- 分支:`codex-view-tools`,五個實作 commit(opus 寫計畫、codex gpt-6-astra 實作、sonnet 逐 Task 審查、opus 整支審查)
- 規格:`docs/specs/2026-09-12-codex-view-tools-design.md`;協定實測 `docs/RESULTS-22-codex-view-tools-probe.md`
- 計畫:`docs/superpowers/plans/2026-09-12-codex-view-tools.md`

## 1. 設計前做的事

roadmap §2.1 明寫「B 的瀏覽器工具只接 Claude,終端裡的 codex 接不上」。先派研究員比較兩條接法
(`dynamicTools` 與獨立 MCP server),再用探針對 `codex app-server` 實測九個協定問題(RESULTS-22),
其中三件直接決定設計:圖片只吃 `data:` URL、工具名要平鋪(namespace 會改名)、同一 thread 內工具不併發。
接法選 `dynamicTools`:批准、網址白名單、rootPath 限制、前景互斥、切走中止全是主行程既有零件。

## 2. 自動測試

typecheck 0 error;89 檔、1802 測試全過;Stmts 94.14%、Branch 89.77%;build 成功。

## 3. 實機驗收

新開一個 codex 對話,請它列出工具:八個 `view_*`、`ask_peer`、`request_handoff` 都在。

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 1 | `view_navigate` example.com 再 `view_screenshot`,問大標題 | 答「Example Domain」;圖不是 base64;有預覽按鈕 | 答對;tool block 裡是 1598×1666 的 `<img>`,「在側邊預覽開啟」在,文字區沒有 base64 ✓(codex 自己截了兩次) |
| 2 | `view_eval` 讀 `document.title` | 批准卡在那個 tool block 底下;允許後拿到 | 卡在 `.tool-call` 裡;結果「Example Domain」✓ |
| 3 | `request_handoff` 等待中切到別的對話 | 收到「瀏覽器正由前景對話使用」 | 工具回那句,codex 回報「交接結果:瀏覽器正由前景對話使用」✓ |
| 4 | `view_navigate` 開 `file:///etc/passwd` | 被擋 | tool block 標「失敗」,訊息說只能開專案資料夾底下的本地檔案 ✓ |
| 5 | `request_handoff`,人按「我好了」 | codex 收到完成 | 「交接結果:使用者已完成,目前網址 https://example.com/」✓(修過一次,見 §4) |
| 6 | 關 app 重開,同一條 thread 直接 `view_snapshot` | 可用 | 答「目前頁面標題是 Example Domain」✓ |

第一輪驗收用的是既有的 codex 對話,它對每個問題都回「沒有這些工具」:那條 thread 稍早(接線之前)
它自己說過沒有,resume 之後模型延續自己的答案。新開對話就正常。驗收要用新對話。

## 4. 驗收抓到的缺陷

**`request_handoff` 完成後工具回「對話已結束」。** 追根因:`controller-eval.ts` 對 `handoff.begin()` 回的
`outcome` 只認 `done`/`timeout`,其餘一律寫死 `sessionEnded`,中止的真正原因被蓋掉;codex 那條路呼叫
`invoke` 不帶 `signal`,能中止 `request_handoff` 的只剩專案級那顆 `own.signal`,而它會被 `switchTo` 的
`abortPending(browserBusy)` 與兩條 dispose 掃到。既有測試全部 mock 掉 `handoff.js` 或用假 viewTools,
沒有一條同時跑真的 handoff、真的 `invokeTool`、不帶 signal 的 ctx 與等待中的 `abortPending`。

修法:`request_handoff` 的等待只有 dispose(對話真的結束)能中止,`browserBusy` 不能:它的設計就是
「等人操作,人可能切去別的地方再回來」;`outcome` 不是 done/timeout 時 throw `signal.reason` 讓原因看得到;
切走與收 slot 的地方加診斷 log。先寫了會失敗的測試(不 mock handoff)才改。

第一輪是誰中止的沒有定位到:那一輪我沒切分頁,修正後重跑等了兩分鐘沒有任何中止、log 也沒噴。
若再發生,log 會指出是 `switchTo` 還是 `closeSlot`。

另外是驗收腳本自己的錯:交接卡的按鈕文字是「我好了」,我前兩輪按的是 tool block 收合列上的「完成›」。

## 5. 審查中修掉或記錄的

- 規格兩處錯(計畫作者抓到):批准白名單裝的是 `mcp__yeschef__` 全名,平鋪名字直接查會讓八個工具全要批准;
  交接卡與批准卡的比對用全名,codex 的 block 是平鋪名不會畫成卡。
- `callId` 缺失時給 `null` 不給空字串(讓 `handoffNoId` 接住);只接 view、沒接 peer 時未知工具名回 `unknownTool`;
  `server.ts` 三處註解「每專案一份」改「每對話一份」(`runtimeFor` 每對話呼叫一次 `forProject`)。
- 記錄不做:`codexViewToolSpecs` 只淺拷貝 `inputSchema`(沒有寫入者);`view_eval` 批准逾時沒有直接測試
  (機制與既有 deny 路徑相同);codex slot 也建了一份用不到的 SDK MCP server(幾 KB)。
- 安全面(整支審查):`view_navigate` 到任意 http/https 不需批准,等於給 `workspace-write` 沙箱下的 codex
  一條把資料編進 URL 送出去的管道。與 Claude 同政策、規格 §5 的非目標,但這是併入後真正新增的攻擊面,記在 roadmap。
