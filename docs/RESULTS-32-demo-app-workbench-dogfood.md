# demo-app 真實協作工作台接班

日期：2026-09-17。目的：開發 demo-app 的同時實際使用 YesChef；後續主導、同伴問答、瀏覽器驗收需留在工作台內。

## 已完成的接入

- 正常結束原開發視窗後，以 `npm run dev -- --watch --remoteDebuggingPort 9336` 重啟同一份 YesChef userData，保留原 demo-app 對話。
- 外部操作器透過 loopback CDP 操作 YesChef 左窗格的按鈕、輸入框與批准卡；不直接代替內部模型執行 demo-app 工作，也不直接操控右側頁面來假冒 view 工具成功。
- 在既有 `demo-app` 專案建立 Claude 協作者與 Codex 主廚，交接已完成 A–E 的基線，下一項為後續程式碼審查。

| 角色 | UI 分頁 | 對話 ID | Session/link ID |
| --- | --- | --- | --- |
| 主廚 | codex 對話 | task-a | link-a |
| 審查協作者 | Claude 對話 2 | task-b | link-b |

專案 ID：`demo-project-id`。路徑：`/Users/me/Projects/demo-app`。

## 實測結果

1. 主廚在 YesChef 對話裡只讀核對 demo-app HEAD、乾淨工作樹與交付報告。
2. 主廚實際呼叫 `ask_peer`，指定上述 Claude link ID；question ID 為 `question-a`。
3. 協作者分頁收到同伴提問，讀取程式後實際呼叫 `answer_peer`。主廚收到答案，未由人代答，也未使用外部子代理通信。
4. 主廚實際呼叫 `view_navigate`；經 YesChef 批准卡允許後，共用右窗格開啟 `http://localhost:5021`。
5. 主廚實際呼叫 `view_snapshot`，確認標題 demo-app Console、登入文字與登入按鈕；右側停在 `/login?redirect=%2Fdashboard`。
6. 主廚整理同伴提出的送審後修改風險、並發考量與下一輪驗收條件。本次接班不修改 demo-app 程式。

`view_navigate` 的 Codex 批准要求符合目前 `src/main/view-tools/policy.ts`，不是工具故障。外部操作者只放行已檢查且已授權的唯讀命令與本機導航，沒有整體自動批准策略。

## 後續工作方式

- 繼續既有 YesChef 主廚／協作者 session，讓使用者可以看到分工、工具執行、批准與成果。
- demo-app 的測試命令由工作台內的對話或終端執行，UI 驗收使用 YesChef 共用瀏覽器；工具不可用時先記錄與修復工作台缺口。
- 這個外部對話是工作台操作者，並非已被遷移進 YesChef 的同一個 session；內部 Codex 是接受明確交接的新 session。
- 不把本次接入測試擴張成 YesChef 所有能力已驗收；本次尚未測試 `request_handoff`、worktree 建立或長時間多輪開發。

## 待改善的使用體驗

- 新對話的角色名稱未直接呈現：目前是「Claude 對話 2」「codex 對話」，主廚／審查分工靠開場訊息辨識。尚未看到可直接重新命名的 UI。
- 外部操作者需要重啟開啟 loopback CDP 才能使用工作台；尚無面向外部 agent 的正式接入介面。CDP 是本次本機驗收入口，不是新增的產品 API。

操作腳本與當次畫面暫存於 `/private/tmp/yeschef-dogfood-20260917/`；對話與同伴問答由 YesChef 自身持久化。

## 後續完整開發實測（同日）

主廚與協作者沿用上述 session 完成一輪程式碼審查，並透過共用右窗格檢查待審內容修改、退回後重送與權限更新。工作台內只讀核對驗收結果；這些結果不是外部瀏覽器代跑。

實測另外觀察到以下工作台問題，尚未在本次修正：

- 多次 `view_navigate` 或觸發導頁的 `view_click` 顯示失敗，但下一次 `view_snapshot` 與右窗格 URL 顯示已完成導頁。包含登入／登出及管理頁導向；目前藉由新快照恢復，尚未確認根因。後續需區分導頁取消、文件切換與實際操作失敗，避免代理重複操作。
- 首次較長的同伴程式審查超過問答時限；協作者仍持續工作，主廚重新提問後才取得結論。後續需改善逾時後的進度與結果銜接，不應由操作者代答。
- 原生檔案輸入、下拉選單在本輪需要經逐次批准的 `view_eval` 操作。可考慮提供明確的上傳與選項選取工具，降低代理使用頁面 JavaScript 的需求。

執行權限與新版 Codex 歷史恢復的兩個阻擋已另於 [相容性修正紀錄](RESULTS-33-codex-runtime-compat.md) 記錄並修正。
