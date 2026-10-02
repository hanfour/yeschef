# RESULTS-20:主分頁區與瀏覽器分頁(增量 3a)實機驗收

- 日期:2026-09-11
- 分支:`panel-group`
- 規格:`docs/specs/2026-09-11-shell-regions-design.md` §3 與增量 3a
- 計畫:`docs/superpowers/plans/2026-09-11-panel-group.md`

## 1. 設計前的量測

右窗格要能藏起來,但 agent 的 view tools 會對它截圖與操作。寫計畫前先用最小的 Electron 程式量過兩次,
結果一致,記在規格 §3:`setVisible(false)` 之後截圖仍拿得到即時內容,但頁面計時器降到十分之一、
`visibilityState` 變 `hidden`;加上 `setBackgroundThrottling(false)` 之後計時器照常、`visibilityState` 維持 `visible`。
所以右窗格一律關掉背景降速。

## 2. 自動測試

| 項目 | 結果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npx vitest run` | 81 檔、1668 測試全過 |
| `npm run build` | 成功 |

## 3. 實機驗收

主行程開 `--inspect=9229`,從 inspector 直接讀兩個 view 的 `getBounds()` 與 `getVisible()`;
renderer 那一側用 CDP 讀 `.panel-body` 的 `getBoundingClientRect()`。兩邊都讀值,不靠截圖目測。

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 1 | 開起來 | renderer 佔滿視窗;瀏覽器等於 `.panel-body` | renderer `0,0,1600,900`;瀏覽器 `801,38,799,833` 可見,`.panel-body` 邊界 `800.5,37.5,1600,871` ✓ |
| 2 | 按「收起右側」 | 瀏覽器不可見;左欄佔滿 | `visible: false`,`.main-column` 寬 1600 ✓ |
| 3 | 按「展開右側」 | 瀏覽器回到原位 | `visible: true`,bounds 回到同一個矩形 ✓ |
| 4 | 主行程把視窗改成 1200×800 | 瀏覽器跟著 `.panel-body` | 瀏覽器 `601,38,599,734`,`.panel-body` `601,38,600,734`(當時是修 1px 之前的版本,見 §4)✓ |
| 5 | renderer 縮放 1.25 | 主行程乘上倍率 | `.panel-body` CSS `480,37,480,574` × 1.25 = `600,46.25,600,717.5`,瀏覽器 `600,46,600,718` ✓ |
| 6 | 收起後正常結束 app 再開 | 一開就是收起的 | 按鈕是「展開右側」,瀏覽器 `visible: false` ✓ |
| 7 | 收起狀態下讓 agent 用 `view_navigate` 開 example.com 再 `view_screenshot` | 截圖拿得到內容 | agent 回答截圖大標題是「Example Domain」,期間瀏覽器一直 `visible: false` ✓ |

第 5 項是 Task 1 審查的疑問:主行程只在視窗 resize 或 renderer 回報時才讀縮放倍率,
倍率變了但 CSS px 沒變的話會漏更新。實測縮放會讓 renderer 的 viewport 從 1600 變成 1280 CSS px,
`.panel-body` 的 CSS 矩形跟著變、renderer 自己重新回報,這個版面下不會漏。

第 6 項第一次沒過,原因是測法:按下收起 1 秒後就 `kill -9`,Chromium 的 localStorage 是非同步寫盤的,
還沒落地就被殺掉。改成從主行程 `app.quit()` 正常結束後重開就過了。

## 4. 驗收時發現並修掉的問題

**瀏覽器右邊界多出 1px。** `.panel-body` 的左邊界是 800.5(`.panel-group` 有 1px 左框線),
renderer 原本把 x 與寬度各自四捨五入:x 800.5 → 801、寬 799.5 → 800,右邊界算成 1601,超出視窗 1px,
靠主行程的裁切才沒出事。改成四條邊各自取整數再相減,現在回報 `801,38,799,833`,右邊界剛好 1600。

**StrictMode 下瀏覽器會被藏起來。** 這是 codex 實作 Task 2 時抓到的計畫缺陷:
`main.tsx` 包了 `StrictMode`,它會「掛載 → 清理 → 再掛載」一次。清理那一步送出 `null`,
但去重用的 `last` 還記著舊矩形,再掛載時判斷「一樣」就不重送,主行程最後收到的是 `null`。
修法是清理時把 `last` 也設成 `null`,並補一條包 `StrictMode` 的測試。

**IPC 監聽器在初始化途中關窗會留下來。** codex 實作 Task 1 時指出:原本收尾放在既有的 closed handler,
但那個 handler 要等 `await startViewTools` 之後才註冊。改成在 `ipcMain.on` 旁邊就近 `win.once('closed')`。

## 5. 已知但不在這次範圍

**收起狀態開 app 時右半邊會先閃一下。** renderer 回報之前主行程照規格用對半切把瀏覽器顯示出來,
所以在 renderer 送出 `null` 之前,右半邊會看到白色的 `about:blank`。
從主行程內部每 10ms 讀一次可見度,量兩次:視窗出現後 204ms / 185ms 顯示,380ms / 369ms 藏起,
實際顯示 176ms 與 184ms。
改成「還沒回報前先藏著」就不會閃,而且那時 renderer 的右半邊已經畫了深色的主分頁區,不會是空白;
但這跟規格 §3「還沒量到之前用對半切」相反,要改需要先改規格。

**分界線不能拖。** 規格增量 3a 已說明理由:分界線緊貼右窗格的原生 view,滑鼠越過分界就進了另一個 webContents,
pointer capture 能不能收到要另外量。

## 6. 最終審查後的收尾

沒有阻斷性問題。採納四條:

- **主行程在縮放不是 1 時會把 1px 溢出帶回來。** renderer 已經改成取邊界,但主行程乘上倍率後
  又把 x 與寬度各自取整數。倍率 1.25、y 38、高 834 時底邊算成 1091,實際是 1090,壓到狀態列的框線。
  主行程也改成四條邊各自取整數再相減,補一條倍率 1.25 的測試。
- **收起時的 `null` 改在畫面繪出前送出**(`useLayoutEffect`)。原本左欄已經撐滿的那一格畫面裡,
  瀏覽器還蓋在左欄右半邊上。
- **拿掉 `aria-pressed`。** 按鈕文字已經隨狀態切換,再加 `aria-pressed={!collapsed}` 讀出來是
  「收起右側,已按下」,意思相反。
- **收起狀態的存檔移出 setState 的 updater。** updater 要是純函式,StrictMode 會呼叫它兩次。

另外把「右窗格在任何情況下都不降速」的代價寫進規格 §3。

審查的第 2 點(renderer 重新載入時瀏覽器停在哪)我從主行程直接讀值:展開狀態 reload 後
50ms、300ms、1s、3s 瀏覽器都停在原位 `801,38,799,833`;收起狀態 reload 後同樣四個時間點都是藏著的。
