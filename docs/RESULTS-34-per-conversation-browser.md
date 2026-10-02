# 每個對話一個瀏覽器:記憶體量測與實機驗收

日期:2026-09-22。對應規格 docs/specs/2026-09-21-per-conversation-browser-design.md。

## 1. 記憶體

量測方法:`spikes/measure-browser-sessions.ts`,用與正式程式碼相同的 `createAgentView`(`src/main/agent-view.ts`)
與 `attachCdp`(`src/main/cdp.ts`)在一個隱藏視窗(`show: false`)裡建立 0、1、3、6 個 session,每組建完等 3 秒,
讀 `app.getAppMetrics()` 全部行程 `workingSetSize` 加總。頁面分兩組:`about:blank`,以及一個固定頁
(`spikes/fixtures/session-page.html`,2000 個 DOM 節點加一個約 1MB 的陣列)。每組各跑兩次,腳本與 fixture
全程沒有更動。

| 頁面 | 次別 | 0 個 (KB) | 1 個 (KB) | 3 個 (KB) | 6 個 (KB) | perSessionKB |
|---|---|---|---|---|---|---|
| about:blank | 第一次 | 241440 | 354352 | 531040 | 796480 | 92507 |
| about:blank | 第二次 | 241360 | 354240 | 530960 | 796208 | 92475 |
| 固定頁 | 第一次 | 241456 | 375696 | 593376 | 919600 | 113024 |
| 固定頁 | 第二次 | 241392 | 375728 | 593456 | 919504 | 113019 |

腳本輸出,原樣貼上:

```
{"page":"about:blank","counts":[{"sessions":0,"totalKB":241440},{"sessions":1,"totalKB":354352},{"sessions":3,"totalKB":531040},{"sessions":6,"totalKB":796480}],"perSessionKB":92507}
{"page":"about:blank","counts":[{"sessions":0,"totalKB":241360},{"sessions":1,"totalKB":354240},{"sessions":3,"totalKB":530960},{"sessions":6,"totalKB":796208}],"perSessionKB":92475}
{"page":"file:///Users/me/Projects/yeschef/.spike-out/fixtures/session-page.html","counts":[{"sessions":0,"totalKB":241456},{"sessions":1,"totalKB":375696},{"sessions":3,"totalKB":593376},{"sessions":6,"totalKB":919600}],"perSessionKB":113024}
{"page":"file:///Users/me/Projects/yeschef/.spike-out/fixtures/session-page.html","counts":[{"sessions":0,"totalKB":241392},{"sessions":1,"totalKB":375728},{"sessions":3,"totalKB":593456},{"sessions":6,"totalKB":919504}],"perSessionKB":113019}
```

同一種頁面兩次量測的差距很小:`about:blank` 是 32 KB(92507 對 92475,相對差距 0.03%),固定頁是 5 KB
(113024 對 113019,相對差距 0.004%),數字穩定可信。以較貼近實際使用的固定頁為準,每個 session 大約多用
113000 KB(約 110 MB);6 個 session 合計比 0 個多用約 678000 KB(第一次 678144 KB、第二次 678112 KB,約
662 MB)。這一版不加 view 數量上限:
目前每個 session 都是對話第一次用到才建立,個位數 session 時的用量在這個機器上完全可控;之後若同時運作的
對話數常態變得更多,再依當時實際量到的數字決定要不要加上限、上限多少。

## 2. 實機驗收

八項裡的 #2 #6 用 `npm run spike:acceptance` 在真的 Electron 裡驗過(2026-09-22,兩次都過;腳本說明見
docs/RESULTS-35-test-machines.md §1)。其餘六項要看畫面或操作 app,仍標未驗收。

| # | 項目 | 狀態 | 怎麼驗 |
|---|---|---|---|
| 1 | 兩個對話各自導航,互不阻擋 | 未驗收 | `npm run build && npm start`,開兩個對話,各自叫 agent 用 `view_navigate` 開不同頁面,確認兩邊都成功、沒有人收到「瀏覽器正由前景對話使用」 |
| 2 | cookie 隔離 | ✓ | 兩個 partition 各一個 view 開同一個 origin,甲執行 `document.cookie = 'probe=1; path=/'` 後讀回 `probe=1`,乙讀 `document.cookie` 是空字串。人工驗法: 在對話甲的網址列開 `https://example.com`,叫 agent 用 `view_eval` 執行 `document.cookie = 'probe=1; path=/'; document.cookie`;在對話乙開同一個網址,叫 agent 用 `view_eval` 執行 `document.cookie`,確認甲回傳含 `probe=1`、乙回傳不含 |
| 3 | 切換分頁時頁面與網址列一起換 | 未驗收 | 切換對話分頁,確認右窗格的頁面與網址列一起換,網址列沒有殘留舊對話的網址 |
| 4 | 網址列輸入正規化 | 未驗收 | 手動在網址列輸入 `localhost:<port>`、`example.com`、一串中文,確認分別是載入、載入、顯示錯誤 |
| 5 | 上一頁/下一頁/重新整理/停止 | 未驗收 | 四個按鈕各按一次,確認行為符合預期 |
| 6 | 關閉對話收掉 renderer 行程 | ✓ | `app.getAppMetrics()` 裡 type 為 Tab 的行程,關掉一個 session 前是 2、後是 1。人工驗法: 關閉一個有瀏覽器的對話,用 `ps` 確認它的 renderer 行程消失 |
| 7 | 主廚 worker 開頁面,地球圖示顯示 | 未驗收 | 讓主廚派一個 worker 去開頁面,確認分頁上出現地球圖示,點進去看到它當下的畫面 |
| 8 | 重啟後 lastUrl 空狀態 | 未驗收 | 重啟 app,確認有 `lastUrl` 的對話顯示「上次停在」的空狀態,按開啟後正常載入 |

## 3. 已知限制

- 這一版沒有 view 數量上限,見第 1 節的量測結論。
- Task 7、Task 8 原本規劃的人工 smoke test 這一輪改成用 `npm run build` 驗證打包得過,所以瀏覽器接線還沒有在
  真正跑起來的 Electron app 裡驗過,見第 2 節八項。
- 專案搬動資料夾之後,舊 core 若有一個還在等待中的 `request_handoff`,這個 session 不會被中止,要等滿 10
  分鐘逾時才結束。
