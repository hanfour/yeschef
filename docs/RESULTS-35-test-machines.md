# 測試機設定與 view_login:實機驗收與已知限制

日期:2026-09-22。對應規格 docs/specs/2026-09-22-test-machines-design.md。

## 1. 實機驗收

七項裡的 #2 #3 #4 #5 用 `npm run spike:acceptance` 在真的 Electron 裡驗過(`spikes/acceptance-browser.ts`:起兩個本機
http 伺服器當測試機,載入 `spikes/fixtures/login-page.html`,走跟產品同一份 `createViewToolServer`),2026-09-22 跑兩次,
兩次都 11 項通過、0 項失敗、沒有任何 `logError`。#1 #6 #7 需要人操作或看真的 app,仍標未驗收。

| # | 項目 | 狀態 | 怎麼做,怎樣算通過 |
|---|---|---|---|
| 1 | Keychain 授權提示次數與換 build 後能否解密 | 未驗收 | `npm run dev` 下存一組密碼,數 macOS 跳出授權提示幾次;重啟 app 再讀一次,再數一次;然後重新 build 一次,確認舊密文能不能解開。三個數字都記下來就算做完 |
| 2 | 用 view_login 登入測試機 | ✓ | 腳本用 `view_snapshot` 取 ref 後呼叫 `view_login`,頁面收到的表單值是 `{ u: 'qa', p: <密碼> }`,回傳文字是「已用 staging 的帳密送出登入，目前網址 http://127.0.0.1:<port>/login」,不含帳號與密碼。有 `submitRef`(點按鈕)與沒有(密碼欄按 Enter)兩條路都過。人工驗法: 對著測試機的登入頁叫 agent「用 staging 登入」,確認 agent 只呼叫 `view_snapshot` 與 `view_login` 兩個工具;頁面登入成功算通過 |
| 3 | 密碼欄回傳前已清空 | ✓ | 送出後不跳轉的單頁表單(最難清的情況),`view_login` 回傳後 `document.getElementById('password').value` 是空字串,帳號欄仍是 `qa`;兩條送出路徑都一樣。人工驗法: 登入後叫 agent 用 `view_eval` 讀密碼欄的 `value`;回傳空字串算通過。整體審查把這一項列為風險最高的未驗收項目,原因是單元測試只證明送出了清空指令;這次在真的 Chromium 裡讀到空字串,這個疑慮已解 |
| 4 | snapshot 與 screenshot 不洩漏密碼 | ✓ | 先用 `view_type` 把密碼打進欄位再 `view_snapshot`,那一行是 `textbox "密碼" value="•••••••••••••"`(Chromium 的無障礙樹對密碼欄回遮罩字元);`view_screenshot` 存成 `.spike-out/acceptance-screenshot.png`,人看過,密碼欄是一排圓點。人工驗法: 分別叫 `view_snapshot`、`view_screenshot`,兩者輸出都看不到密碼明文算通過 |
| 5 | origin 不符時不填表單 | ✓ | 把 view 導到另一個 port 的同一份頁面再呼叫,回「目前頁面不是 http://127.0.0.1:<port>，不會填入帳密」,兩個欄位都是空字串。另外驗了整體審查的 C1:把搜尋框當 `passwordRef`,回「不是密碼欄位」,搜尋框沒被填、搜尋按鈕沒被按。人工驗法: 把頁面導到另一個網站再叫 `view_login`;回應文字提到「目前頁面不是」,且頁面上沒有任何欄位被填算通過 |
| 6 | 移除專案連帶刪除測試機檔 | 未驗收 | 移除一個設過測試機的專案,確認 `<userData>/test-machines/` 底下對應的 `.json` 消失算通過 |
| 7 | log 與對話紀錄不含密碼 | 未驗收 | 對整段操作期間的對話紀錄與 `logError` 輸出 grep 密碼明文,grep 不到算通過 |

## 2. Keychain 行為

這一輪沒有量測,原因同第 1 節:agent 沒有能力觸發或觀察 macOS 的授權提示。規格 §8.3 列的兩個問題留待人工
驗收時回答:

- 第一次存密碼跳幾次授權提示、重啟後第一次讀又跳幾次。
- 換一次 build 之後,舊密文能不能用新的簽章解開,還是要求重新輸入密碼。

驗法見第 1 節第 1 項。

## 3. 已知限制

- 密文解不開時,設定畫面的清單仍顯示「已設定」,不是「未設定」:這是 Task 2 裁決後的設計,`hasPassword`
  只代表有沒有存密文,不代表能不能解密(`src/main/test-machines/service.ts:115`)。使用者要判斷密碼是否
  還有效,要靠實際叫 `view_login`,這時會回「密碼解不開」的訊息(`src/main/view-tools/errors.ts:51`)。
- 密碼欄的清空一律會嘗試(`type(passwordRef, '', true, false, …)`),只有 ref 表因為頁面跳轉
  (`invalidatedBy === 'navigated'`)而失效時才安靜略過,欄位這時已經不在頁面上
  (`src/main/view-tools/controller-login.ts:102`)。如果送出登入之後、清空之前,使用者的操作讓 ref 表因為
  `userInput` 而非頁面跳轉失效,清空的嘗試會因為 ref 已過期而丟例外,`logError` 記下一次錯誤,回傳給模型的
  文字也會多加一行 `MSG.loginClearFailed`,提醒密碼欄可能還留在欄位裡、不要用 `view_eval` 讀它
  (`controller-login.ts:101-136`、`src/main/view-tools/errors.ts:59`)。更穩妥的做法(填密碼前先記下
  `backendNodeId`,直接用它清,不查 ref 表)記在 `.superpowers/sdd/2026-09-22-test-machines/progress.md` 的
  Task 4 段落裡,列為待辦,這一輪沒有動工。
- 節點型別檢查(`src/main/view-tools/controller-login.ts:71-90`)只能確認 `passwordRef` 指到一個
  `<input type="password">`,不能判斷這個欄位是不是頁面真正的登入密碼欄;頁面刻意放一個假的密碼欄位也會
  通過檢查。這種情況目前沒有額外防護,agent 遇到可疑頁面時仍要靠 `request_handoff` 交給人工處理。
- 設定檔本身損毀或格式不對時,`list`、`upsert`、`remove` 都回讀取失敗的錯誤(`TEXT.unreadable`),沒有從
  畫面上提供修復路徑,要靠人手動刪除 `<userData>/test-machines/<projectId>.json` 才能重建
  (`src/main/test-machines/service.ts:76-91`、`:136`;裁決保留現狀,不修)。
- production 的 `view_login` 在 Task 5 接上真正的 `credentials` 之前是尚未串接的假訊息,一律回「找不到測試
  機」;Task 5 已經把它換掉。
- `Credentials` 型別在 `src/main/test-machines/service.ts` 與 `src/main/view-tools/controller-types.ts`
  兩個檔案各自宣告一份,欄位形狀相同,沒有共用同一個定義。
