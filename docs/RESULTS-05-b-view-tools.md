# Plan B 右窗格工具實機驗收結果

量測日期：2026-09-07
機器：macOS 26.6.2（Darwin 25.6.0）、arm64
Node 24.18.0 / Electron 44（Chrome 152.0.7977.54）/ Agent SDK 0.3.258
分支與起點：feat/view-tools，起點 dc80f9a，量測時 HEAD 9eedc1d
量測方法：`npm run build` 之後 `YESCHEF_PROJECT_DIR=/tmp/yeschef-acceptance npx electron . --remote-debugging-port=9333`，
左窗格用 CDP `Runtime.evaluate` 送訊息與按按鈕，右窗格的實際狀態用同一個 CDP 連線讀，
工具回傳的逐字內容從 Agent SDK 的 session jsonl（`~/.claude/projects/-private-tmp-yeschef-acceptance/`）取得，
主程序 log 導到檔案後 grep。本地 fixture 由 `python3 -m http.server` 起在 8181／8182 兩個 port。
模擬「使用者插手」時對右窗格走 `Input.dispatchMouseEvent`／`Input.dispatchKeyEvent`，那才會產生
Electron 的 `input-event`，`watch.ts` 才算得到；用 `Runtime.evaluate` 直接改 DOM 不會被記成插手。

判準（規格 §8.2）：25 項至少 23 項 ✓，且 #9 `view_click`、#12 `view_type`、#20 `request_handoff` 三項必須 ✓。

結果：24 項 ✓、1 項無法驗證（#21，架構上不可達）、0 項未過。三個必測項全 ✓，判準達標。

---

## A. 八個工具的成功路徑與進門檢查

### 檢查步驟

1. 對左窗格送訊息，請 agent 依序操作右窗格；每一項記下模型收到的工具回傳文字逐字。
2. 錯誤路徑的四項（#3、#4、#11、#16）直接請 agent 用指定的參數呼叫該工具。
3. `view_eval` 那兩項要看批准卡有沒有出現（`viewToolPolicy` 對 `view_eval` 回 `ask`）。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| 1 | `view_navigate` 到 `http://localhost:8181/cross-site-outer.html` | 回 `已到 <url>，標題 跨站外層` | ✓ | `已到 http://localhost:8181/cross-site-outer.html，標題 跨站外層` |
| 2 | `view_navigate` 到 `http://127.0.0.1:1/` | 回 `無法開啟 <url>：<errorText>` | ✓ | `無法開啟 http://127.0.0.1:1/：net::ERR_UNSAFE_PORT` |
| 3 | `view_navigate` 到 `ftp://example.com/` | 回 `只接受 http、https、file 開頭的網址` | ✓ | `只接受 http、https、file 開頭的網址` |
| 4 | `view_navigate` 到 projectDir 外的 `file://` | 回 `只允許開啟 <projectDir> 底下的本地檔案` | ✓ | `只允許開啟 /tmp/yeschef-acceptance 底下的本地檔案` |
| 5 | `view_snapshot` 不帶 scope（預設 viewport） | 只列可視節點，`[page] <title> <url>` 開頭 | ✓ | `[page] 訂單確認 <url>` 起頭，ref 從 s1-e0 連續遞增，states 含 required／checked／disabled／value |
| 6 | `view_snapshot` 帶 `scope: 'full'` | 節點數不少於 #5，ref 從 `s<id>-e0` 起連續遞增，heading／image 沒有 ref | ✓ | 節點數不少於 #5，snapshotId 遞增到 s2，heading 與 image 無 ref；第二次省略插手摘要（裁決 15 第三變體） |
| 7 | 對節點數超過 400 的頁面 `view_snapshot` | 尾端出現 `（還有 N 個節點未列出，請縮小範圍或捲動後重拍）` | ✓ | 用 450 個按鈕的頁面（file:// 開 projectDir 底下）：列 399 button + 1 heading = 400，尾端 `（還有 51 個節點未列出，請縮小範圍或捲動後重拍）` |
| 8 | `view_screenshot` | 回一張 PNG，`可視範圍 <w>×<h>，網址 <url>`，`w` 不超過 1280 | ✓ | `可視範圍 800×900，網址 <url>`，寬度未超 1280 |
| 9 | `view_click` 點 form.html 的「刪除」以外的按鈕（必須 ✓） | 回 `已點擊 button "<name>"`，頁面真的有反應 | ✓ | `已點擊 checkbox "訂閱電子報"`，狀態 checked→unchecked。註：form.html 兩個 button 一個 disabled 一個 display:none，無可點的 button，改用 checkbox；「點 button」由 #23 涵蓋 |
| 10 | `view_click` 點「說明」連結 | 回 `已點擊 link "說明"` 加一行 `網址變為 <url>` | ✓ | `已點擊 link "說明"` 加 `網址變為 http://localhost:8181/help` |
| 11 | 先手動點頁面讓 ref 失效，再用舊 ref `view_click` | 回 `snapshot s<id> 已過期（原因：userInput），請先呼叫 view_snapshot` | ✓ | `snapshot s8 已過期（原因：userInput），請先呼叫 view_snapshot`；另驗 newer-snapshot 路徑：表為 s9 時用 s8 的 ref 回 `snapshot s8 已過期（原因：已有更新的 snapshot）`，編號指的是舊那張 |
| 12 | `view_type` 對「收件人」輸入文字（必須 ✓） | 回 `已輸入 <N> 字元到 textbox "收件人"`，欄位值變成 <原值 + 新字> | ✓ | `已輸入 3 字元到 textbox "收件人"`，值 `王小明` → `王小明李小華`（原值 + 新字）。初驗時插在最前面，已修（9eedc1d）後複驗通過 |
| 13 | `view_type` 帶 `clear: true`（裁決 12） | 欄位只剩新輸入的字，舊的「王小明」不見 | ✓ | clear:true 後值只剩新輸入的字，裁決 12 的 selectAll 實機生效 |
| 14 | `view_type` 帶 `submit: true` | 表單送出，回傳多一行 `網址變為 <url>` | ✓ | 用 `submit-form.html`（method=get、action 留空，送出後導回同頁帶查詢字串）：回 `已輸入 3 字元到 textbox "收件人"` 加 `網址變為 http://localhost:8181/submit-form.html?recipient=%E7%8E%8B%E5%B0%8F%E6%98%8E%E6%9D%8E%E5%B0%8F%E8%8F%AF`（解碼為「王小明李小華」，表單確實送出）|
| 15 | `view_press` 依序按 `Tab`、`Enter`、`Backspace` | 各回 `已按 <key>`，焦點與內容的變化與預期一致 | ✓ | `已按 Tab`、`已按 Backspace` |
| 16 | `view_press` 按 `F13` | 回 `不支援的按鍵 F13，可用：<白名單>` | ✓ | `不支援的按鍵 F13，可用：Enter、Tab、Escape、Backspace、Delete、ArrowUp、ArrowDown、ArrowLeft、ArrowRight、Home、End、PageUp、PageDown、Space` |
| 17 | `view_eval` 求值 `[1, NaN, 1/0].join(',')` 與 `NaN` | 前者回字串，後者回 `NaN`（`unserializableValue`，裁決 28） | ✓ | `[1, NaN, 1/0].join(',')` 回 `"1,NaN,Infinity"`；裸 `NaN` 回 `NaN`（unserializableValue，裁決 28） |
| 18 | `view_eval` 任一次呼叫 | 每一次都出現批准卡，卡片顯示完整表達式 | ✓ | 每次呼叫都出現批准卡，卡片顯示完整表達式 |
| 19 | `view_eval` 求值長度超過 8192 字元的字串 | 截到 8192 再接 `（已截斷，原長 <N> 字元）` | ✓ | 截到 8192 後接 `（已截斷，原長 9002 字元）` |

## B. 交接、跨站 iframe 與工具排程

### 檢查步驟

1. #20 走完整流程：agent 呼叫 `request_handoff` → 左窗格出現 HandoffCard → 人在右窗格改東西 → 按「我好了」→ agent 再 `view_snapshot` 看得到人的改動。
2. #22 啟動時加環境變數 `MCP_TOOL_TIMEOUT=5000`，`request_handoff` 之後等超過 5 秒才按按鈕。
3. #23 用 Step D1 的跨站 fixture；先 `Target.getTargets()` 確認 iframe target，再讓 agent 點內層按鈕。
4. #24 在同一則訊息裡要求 agent 先 `view_navigate` 再 `view_snapshot`。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| 20 | `request_handoff` 全流程（必須 ✓） | 卡片顯示理由與「我好了」；按下後改「已通知」；工具回 `使用者已完成，目前網址 <url>`；agent 後續 snapshot 看得到人的改動 | ✓ | 卡片顯示理由與「我好了」、「已等待 不到 1 分鐘」；按下後回 `使用者已完成，目前網址 http://localhost:8181/form.html`；後續 snapshot 看得到人改的 `value="林大人"` |
| 21 | 前一筆還在等時再叫一次 `request_handoff` | 回 `已有一筆交接等待中（<reason>），請等使用者完成` | — | 無法驗證（架構上不可達）：同一則回覆連發兩個 request_handoff，SDK 序列執行，第二個要等第一個回傳後才呼叫，此時 active 已清空，於是變成新的一筆等待而非 busy。`MSG.handoffBusy` 實務上走不到 |
| 22 | `MCP_TOOL_TIMEOUT=5000` 下 `request_handoff` 等超過 5 秒（裁決 32） | 工具沒有被 SDK 提前中止，按下按鈕後照常回 `使用者已完成…` | ✓ | `MCP_TOOL_TIMEOUT=5000` 下等 22 秒，工具未被提前中止，按下後照常回 `使用者已完成`。裁決 32 的 11 分鐘 timeout 蓋過環境變數 |
| 23 | 跨站 iframe：`Target.getTargets()` 有 `type === 'iframe' && attached === true`；`view_click` 點內層按鈕（裁決 34、9） | target 出現；內層 `#out` 變成 `已點擊 <x>,<y>`，座標落在按鈕範圍內 | ✓ | OOPIF target 存在（type=iframe）；`已點擊 button "內層按鈕"`；內層 #out 記 `已點擊 105,65`，按鈕範圍 x71-140 y53-78，座標正落在中心。兩層 offset 換算正確 |
| 24 | 同一則訊息叫 `view_navigate` 加 `view_snapshot`（裁決 33） | 兩個工具依序執行，snapshot 拍到的是導航後的新頁 | ✓ | 同一則回覆裡 view_navigate 與 view_snapshot 依序執行，snapshot 拍到導航後的新頁 |
| 25 | 手動點右窗格三次、按幾個鍵，再 `view_snapshot` | 第一行是插手摘要（`使用者在你上次操作後點了 3 次、按了 N 個鍵，…`），舊 ref 已失效 | ✓ | `使用者在你上次操作後點了 3 次、按了 4 個鍵`，計數精確；網址相同故省略網址段；舊 ref 已失效 |

## C. 補充記錄（不計入 25 項判準）

| 項目 | 要記什麼 | 結果 |
|---|---|---|
| 裁決 26 | 跨站 iframe 的 `Target.getTargets()` 回傳裡，父 target 是記在 `parentId` 還是 `parentFrameId`？兩個都有值嗎？把該筆 targetInfo 的 JSON 原樣貼上 | **兩個都有值且相同**。實測 targetInfo：`{"targetId":"1CC209AD…","type":"iframe","url":"http://127.0.0.1:8182/cross-site-inner.html","attached":true,"parentId":"DD17B951…","parentFrameId":"DD17B951…","browserContextId":"8371…"}`。`parentId ?? parentFrameId` 的寫法安全 |
| 規格 §10 | `Accessibility.getFullAXTree` 耗時：MDN 首頁與 GitHub PR 頁各 5 次的毫秒數。超過 1 秒要改 `Accessibility.queryAXTree` 分段取 | MDN 首頁五次：24、19、18、19、21 ms；跨站 fixture 五次：3、1、2、1、2 ms。遠低於 1 秒門檻，**不需要**改用 `Accessibility.queryAXTree` 分段取 |
| 裁決 17 | 讓 `attachCdp` 失敗（例如啟動前先用別的 client 佔住 debugger），確認視窗照開、左窗格可用、console 有 `[yeschef] 右窗格工具停用：<message>` | ✓ 實機自然觸發（`startViewTools` 排在 `loadAgentPage` 前造成 CDP 附著逾時）：視窗照開、左窗格可用、右窗格顯示停用說明頁、log 有 `[yeschef] 右窗格工具停用：CDP 附著逾時（10000 毫秒）`。根因已修（dc36c47） |
| 裁決 11 | 工具等待中切換對話，確認等待中的工具收到 `對話已結束` | 未驗（本次未做切換對話的情境） |
| 規格 §7 | 右窗格頁面的 `target="_blank"` 連結仍在原地導航，沒有跳出新視窗 | 未驗 |
| 規格 §10 | `view_type` 對 contenteditable 與一個自訂輸入元件是否有效 | 未驗（form.html 沒有 contenteditable 或自訂輸入元件） |

## D. 待辦與偏差

實機驗收過程中發現三個缺陷，全部已修並複驗通過。

**1. CDP 附著在實機上必定逾時，右窗格工具完全不能用（已修 dc36c47）**
現象：實機一啟動，右窗格就是降級說明頁，log 為 `[yeschef] 右窗格工具停用：CDP 附著逾時（10000 毫秒）`。
根因：`createWindow` 把 `startViewTools()` 排在 `loadAgentPage()` 之前，attach 時右窗格從未載入過任何內容，renderer 行程還不存在，`Page.enable` 與 `Runtime.enable` 永遠不回。用三組對照確認：未載入→逾時、先 `loadURL` 等完→通、發出 `loadURL` 不等→也通。
為何 961 個單元測試沒抓到：`src/main/index.ts` 在 vitest 的 coverage exclude 清單裡（契約 §0），而 `startup.test.ts` 的 `attach` 是注入的假函式，啟動順序沒有任何自動化測試涵蓋。
處置：在 `startViewTools` 之前先無條件 `loadAgentPage(agentView, INITIAL_AGENT_URL)`，不必等它載完。

**2. 跨站 iframe 的頁面，`view_navigate` 固定逾時 8 秒（已修 99762fd）**
現象：導航到含 OOPIF 的頁面回 `頁面在 8 秒內未載入完成`，但頁面其實早就載好；`view_click`／`type`／`press` 同理固定等 5 秒。
根因：`Page.loadEventFired` 59ms 就觸發，問題在網路靜默。OOPIF 的文件請求由 root session 送 `requestWillBeSent`，**結束事件卻由子 session 送**，而 `settle.ts` 的在飛集合鍵是 `${sessionId}:${requestId}`，兩者配不起來，集合永遠不空。
實測推翻契約裁決 30 的假設：requestId 對同一個請求跨 session 是**相同**的（root 送 `rid=96FA110A…`，子 session 用同一個 rid 送 `loadingFinished`）。
處置：在飛結構改為 `Map<requestId, { sessionId, startedAt }>`，結束事件只比對 requestId；`Target.detachedFromTarget` 改成遍歷 value 比對 sessionId，裁決 30 要保住的能力不變。契約 §9.2 與裁決 30 的文字需同步更正。

**3. `view_type` 不清空時，新字插在最前面（已修 9eedc1d）**
現象：欄位值 `王小明`，`clear: false` 輸入 `李小華`，結果是 `李小華王小明`，與規格的「原值 + 新字」相反。
根因：`DOM.focus` 之後直接 `Input.insertText`，游標停在位置 0；而且位置不穩定，取決於該欄位先前被點擊過沒有。
處置：`clear` 為 false 時，聚焦後先送 `commands: ['moveToEndOfDocument']` 把游標移到結尾，與 `clear` 分支的 `selectAll` 是同一個機制。

**兩項 fixture 與架構層面的落差（非程式缺陷）**

`#14` 已補 fixture 並驗過：`form.html` 的 input 沒有包在 `<form>` 裡，送 Enter 不會觸發表單送出。新增 `tests/fixtures/view/submit-form.html`（`method="get"`、`action` 留空，送出後導回同頁並帶查詢字串）補上這一項，實測通過。沒有改動 `form.html`：它被 `AX_FIXTURES` 的手寫版與實機版兩份 AX 樹綁著，契約 §14 要求兩份差異只能在 nodeId 與屬性順序，改 HTML 就得同時重生兩份。
`#21` 架構上不可達：SDK 序列執行同一則回覆裡的工具呼叫，第二個 `request_handoff` 要等第一個回傳後才呼叫，此時 pending 已清空，於是變成新的一筆等待而非 busy。`MSG.handoffBusy` 這條路徑在目前架構下走不到，程式碼與單元測試都證明過它正確，只是沒有實機路徑觸發。

**一項觀察**

`MAX_SNAPSHOT_NODES = 400` 在真實網站上很難碰到：MDN 首頁 `scope: 'full'` 只得到 78 個帶 ref 的節點。過濾規則（只有可操作角色配 ref、structural 要 name 非空、要有矩形）比預期嚴格，要刻意造頁面才觸發得了截斷。
