# 全分支最終審查：yeschef 外殼與三個 spike

**Merge base:** `02fd7b3601369e31ed29b17915d79e0ba628ce1c`
**Head:** `24f33be`
**審查日期:** 2026-09-01
**驗證動作:** `npm test`（51 綠）、`npm run typecheck`（過）、`npm run build`（過）、`npm run spike:memory`（實跑）、`npx vitest run --coverage`（失敗，缺相依）、`tsc` 探針驗證 `CdpSession` 公開介面

---

## 整體評估

這支分支可以當第二份計畫的地基，但**不是現在這個狀態**。骨架切得乾淨（`src/` 8 檔 535 行，最大 155 行）、`npm test` 51 綠、`typecheck` 與 `build` 都過、全 repo 已無 `void` 吞 promise、三個 spike 各自有腳本。真正的問題只有一個而且很集中：**規格 §2.1 那條「cwd 必須是使用者的專案目錄，不可用 app 自身目錄」——整個專案存在的理由——在單元測試裡被斷言、在產品接線裡被違反，而且兩條有文件的啟動路徑（`npm run dev`、`npm run start`）都會踩到。** 這是第四次「測試全綠但測的是測試自己造的設定」。修掉 C1 與 I2、I4 之後，地基是可信的。

---

## 延後項分類

### 合併前必修（5 條）

| # | 項目 | 理由 |
|---|---|---|
| Task 4 #10 | `YESCHEF_PROJECT_DIR` 未設時退回 `process.cwd()` | 延後條件寫的是「尚未打包，故延後」，但規格 §10 明訂 v1 不打包，這個觸發條件永遠不會到，延後等於永久豁免。見 Critical 1。 |
| Task 3 #8 | 右窗格未設 `setWindowOpenHandler` | 一行修。RESULTS-01 區塊 3 第 4 項就要人「在右格直接用滑鼠點連結」，即將進行的手動驗證會踩到；且開出獨立視窗違反 §3.3「不做多視窗」。 |
| Task 6 #21 | `attachCdp` 的 catch 無條件 detach | 3 行修（`const weAttached = !wc.debugger.isAttached()`）。第二份計畫的 9 個工具全建在 `cdp.ts` 上，一旦出現第二個 attach 呼叫端，失敗的第二次會拆掉第一個 session。趁只有一個呼叫端時修最便宜。 |
| Task 4 #12 | renderer 與 preload 各自宣告同一份 API 形狀 | `src/shared/ipc.ts` 存在的目的就是放這個。第二份計畫會大幅擴充這座橋，契約先歸位比事後拆便宜。 |
| Task 5 #16 | `padEnd(38)` CJK 對齊 | 破例列入：我實跑 `npm run spike:memory`，輸出確實歪掉，而這是使用者要照著抄數字進表格的那份輸出。純顯示但成本近零。 |

### 留到第二份計畫（5 條）

- Task 2 #4（`container.width` 為負無驗證）：等真的加拖曳分隔線時一併加，現在 ratio 固定 0.5，不可達。
- Task 4 #11（resize 無節流）：拖曳視窗會對 claude 連發 SIGWINCH，屬體感問題，等 TUI 手動驗證第 5 項有實際現象再修。
- Task 4 #13（dev reload 顯示假的「claude 已結束」）：已被 RESULTS-01 區塊 4 第 3 項收錄為待驗證項，不會遺失。等實測結果再決定要不要加世代檢查。
- Task 4 #14（`pty.kill()` 多次呼叫）：RESULTS-01 TUI 第 7 項會間接碰到。
- Task 4 #15（ipcMain listener 未依 `event.sender` 過濾）：單視窗不觸發，且 §3.3 明訂不做多視窗，可能永遠不需要。第二份計畫若引入 handoff 橫幅等額外 view 再看。

### 已自然解決（5 條）

- Task 1 #2（package-lock 未提交）：已在本次 diff 內。
- Task 1 #3（`projectDir` 假設是 string）：`projectDir` 不經過 IPC，由主程序 env 提供，型別確定是 string。這條的隱憂換了形式出現在 C1。
- Task 3 #9（`void app.whenReady()`）：現在是 `.then().catch()` 加 `process.exit(1)`；grep 過全 repo，已無 `void` 吞 promise。
- Task 5 #17（負向樣本名不副實）：現在的樣本是 `/Users/someone/other-project/...Electron.app/...`，字面含 `Electron.app` 而不含 `yeschef`，名副其實了。
- Task 5 #18、#19（測試重複、輸出順序）：#18 的行號已失效，現在 `:16-22` 與 `:116-122` 分別測 `GROUPS[0]` 與 `GROUPS[1]`，是不同群組的合法覆蓋；#19 實跑確認 `其中 electron-vite` 就印在 `yeschef` 下一行，相鄰。

### 不需處理（7 條）

Task 1 #1、Task 3 #6（兩條都是 task 報告的文字錯誤，報告不是交付物，碼與設定本身正確）；Task 2 #5（clamp 邊界已手算確認，屬覆蓋廣度）；Task 3 #7（`webviewTag` 預設即 false）；Task 6 #20（`String(o.code)` 在 CDP 協定下不可達）；Task 8 #22（註解函式名錯字，`probe-oopif.ts:96` 寫 `checkExcludedButAttached()`，實際是 `findExcludedButAttached()`，仍在，順手改即可）。

---

## 跨 task 發現

### 1. 模組邊界與重複

八個實作者沒有做出重複實作，這點意外地乾淨。唯一的內容重複是 `src/preload/terminal.ts` 與 `src/renderer/terminal.ts:6-15` 各宣告一次 `window.yeschef` 的形狀。

真正的邊界問題是**職責滑落**：重建 frame 樹、判定 eTLD+1 跨站的邏輯（`findPageIframeTargets`、`isCrossSite`、`approximateSite`）只存在於 `spikes/probe-oopif.ts`。但規格 §7 第一列要求 snapshot 固定回報「有 N 個 iframe 未附著」，那個 N 需要分母，而分母只有 spike 有。第二份計畫要嘛把這三個函式搬進 `src/`，要嘛重寫一次。`src/main/cdp.ts` 只能回答分子。

檔案大小全部合規：`src/` 最大 155 行，`spikes/probe-oopif.ts` 421 行（混了量測、分類、格式化、站點清單四件事，在 800 上限內但超過 200-400 的典型值）。

### 2. `cdp.ts` 遞迴 re-arm 對產品的影響

**對 Task 7 腳本無影響。** `probe-input-focus.ts` 載的是 `data:` URL 與本地 fixture，沒有 iframe 也沒有 worker，遞迴路徑不會被觸發。

**對產品有三個影響，一個比 `attachedTargets` 更嚴重。**

首先，auto-attach 不分型別。任意網站的每個 worker、service worker、iframe 都會被附著並各自再發一次 `setAutoAttach`。重頁面上是 O(N) 額外 CDP 往返加事件噪音。可接受，但要知道。

其次，`detach()` 不清 `attachedTargets` 這件事，**在正常導覽下不咬人**——`Target.detachedFromTarget` 會自清。真正咬人的是外部 detach：DevTools 被打開、webContents 被銷毀、target crash。這些情況不會送 `detachedFromTarget`，`detached` 旗標也還是 `false`，於是 `getAttachedTargets()` 繼續回傳一份陳舊清單。§7 要求的「未附著揭露」會少報，agent 以為自己看得到全部。這正是規格要防的靜默失敗。順帶一提，RESULTS-01 區塊 3 第 5 項的 cookie 驗證步驟就叫使用者加 `openDevTools()`，那在第二份計畫接上 CDP 之後會直接跟 debugger 衝突。

第三個影響最大，也是最該在閘門會議上講的：**附著得到，但呼叫端驅動不了。** 見 Important 1。

### 3. 錯誤處理是否一致

四種模式並存但不互相矛盾：`console.error` 後繼續（IPC 邊界、載入失敗）、`CdpError` 包裝並保留 `cause`、`rearmErrors` 累積、有效性閘門以非零碼結束。分工是合理的：邊界驗證失敗該丟棄不該中止、CDP 錯誤該保留形狀、部分失敗該累積不該拖垮全部、量測無效該讓機器而非人眼發現。

兩處漏掉：

- `rearmErrors` 這個機制蓋出來就是為了讓呼叫端看得見失敗，結果唯一的呼叫端把它藏在 `OOPIF_DEBUG` 後面（Important 4）。
- 三個 spike 只有兩個有閘門，缺的那個正是唯一還沒跑的（Important 3）。

做對的地方值得記一筆：PTY 啟動失敗會把錯誤訊息寫進終端機給人看（`index.ts:104-109`），不是只進 console。這是全 repo 唯一一處把錯誤真的送到使用者眼前的地方。

### 4. 測試的真實性

抽查四個測試檔，結論是**測試檔本身沒問題，破口在測試與產品的接縫**。

- `tests/cdp.test.ts` 是這批新增裡最有價值的。假的 `wc.debugger` 是真的在跑 `attachCdp` 的邏輯：遞迴 re-arm、`rearmErrors` 累積、`detached` 旗標本身（那條特地繞過 `removeListener` 直接呼叫監聽器本體，測的是旗標不是移除動作）。這是真測試。
- `tests/spawn-args.test.ts`、`tests/ipc.test.ts` 斷言用字面值，綁在產品邏輯上。
- `tests/measure-memory.test.ts` 已改用真的 `GROUPS`，Task 5 的問題修掉了。但樣本全是手寫的,沒有任何一條對真實 `ps` 輸出格式做斷言。我實跑驗證過：`ps -Ao rss,comm,command` 在管線下不截斷（最長行 1958 字元），`comm` 欄位截到 16 字元，跟手寫樣本的格式一致。這次沒事，但這個保證來自我剛剛跑的那次，不是來自測試。
- `tests/layout.test.ts` 的兩條 clamp 測試用 `Math.round(1000 * MIN_RATIO)` 當期望值，等於把實作抄一遍；同檔的 0.5 與奇數寬度兩條是字面期望，整體還行。

**第四次出現了，在接縫上。** `tests/spawn-args.test.ts:11` 寫著 `it('cwd 是使用者的專案目錄，不是 app 目錄')` 並且通過，因為它自己餵了 `/Users/me/Projects/some-repo`。而唯一的產品呼叫端 `src/main/index.ts:84` 傳的是 `process.cwd()`，在兩條有文件的啟動路徑下就是 app 目錄。`buildSpawnArgs` 唯一的驗證是 `startsWith('/')`，app 目錄完全通過。測試綠、程式不報錯、數字（路徑）算得出來，但它回答的不是要問的問題。

還有一件事：計畫的「覆蓋率 80% 以上」**從未被量過**。`npx vitest run --coverage` 直接失敗（`MISSING DEPENDENCY '@vitest/coverage-v8'`），而且 `vitest.config.ts:6` 的 include 漏了兩個確實有單元測試的純邏輯模組。

### 5. 規格覆蓋

| 規格條目 | 狀態 |
|---|---|
| §2 真 claude 二進位檔 | ✓ `pty-host.ts` spawn `claude` |
| §2 獨立 partition | ✓ `persist:agent` |
| §2 人可直接操作右窗格 | ✓ 真的 WebContentsView |
| §2 只做 macOS | ✓（無明確平台守衛，但也沒有跨平台程式碼） |
| §2.1 cwd = 使用者專案目錄 | **✗ 見 Critical 1** |
| §4 WebContentsView、非 BrowserView/webview | ✓ |
| §4 不給 preload | ✓ |
| §4 `webContents.debugger` | ✓ `cdp.ts` |
| §4 `--mcp-config` 不加 `--strict-mcp-config` | ✓ 有測試 |
| §7 跨站 iframe：`flatten: true` | ✓ 且超額做了遞迴 re-arm |
| §7 snapshot 標出 N 個未附著 | 能力不在 `src/`（見發現 1），屬第二份計畫但地基不完整 |
| §7 claude 結束：保留輸出／**提供重啟**／不自動重生 | 保留輸出 ✓、不自動重生 ✓、**提供重啟 ✗**（無任何重啟入口） |
| §8 三個 spike 腳本 | ✓ 齊備 |
| §8 Spike 3 對 5 個真實站 | 最終跑 3 站，RESULTS-03 有交代每一站為何拿掉 |
| §9 fixture 端到端測試 | 第二份計畫，`click-counter.html` 已起頭 |
| §10 `npm run build` 加本地執行、不簽章 | ✓ build 跑過，通過 |

「提供重啟」那一列判定為範圍邊界（Task 4 的驗收沒列），但它是 §7 表格裡明寫的處置，且不在第二份計畫宣告涵蓋的 §5／§5.0／§6 之內，容易兩邊落空。建議明確寫進第二份計畫。

另外：**沒有 README。** §10 說交付形式是「`npm run build` 加本地執行」，但整個 repo 沒有一份文件說怎麼跑（要設哪個環境變數、要不要先 electron-rebuild）。

### 6. 三份 RESULTS 的可用性

以「一個沒讀過這串對話的人拿到它們，能不能做完」為準：

**RESULTS-02 能，而且是三份裡最好的。** 狀態（BLOCKED）與理由講得清楚，「一次有效的執行長什麼樣」給了四條可機械檢查的判準（三行診斷互不相同、無逾時註記、印出有效結論、`echo $?` 為 0），還誠實揭露了 `app.hide()` 量到「隱藏」而非「僅僅失焦」的解讀落差並給了替代量法。唯一缺的是重跑後要把新數字填到哪裡（沒有填空欄，不像 RESULTS-01）。

**RESULTS-03 能，但要花時間。** 314 行、四輪、三個已失效的結論。把現行結論搬到最前面並在每個舊結論加「已失效」標記，這個處理是對的，讀者不會抄到錯的判準行。兩個殘留風險：一是頭條 16/16 的關鍵證據（reviewer 的獨立對照探針、16 條父子鏈重建）沒有進版本庫，讀者只能靠 `OOPIF_DEBUG=1` 自己重建大部分；二是重跑次數「2 次獨立重跑」（第 224 行）與「連續 4 次獨立重跑」（第 251 行）不一致。

**RESULTS-01 做不完，而它是唯一全待執行的那份。** 三個具體障礙見 Important 3、5、6、9。最壞情況是：使用者在 cwd 錯的狀態下把七項 TUI 全部勾完，記憶體數字也抄了，然後卡在區塊 4 第 1 項那個不可能通過的檢查上，卻沒有任何地方告訴他 usage 根本沒進 Insights。

---

## Issues

### Critical (Must Fix)

#### C1. `src/main/index.ts:84` — 規格最硬的那條限制，被唯一的產品呼叫端違反

```typescript
projectDir: process.env.YESCHEF_PROJECT_DIR ?? process.cwd(),
```

`npm run dev` 與 `npm run start`（`electron-vite preview`）兩條路徑下，Electron 都是由 electron-vite 從專案根目錄啟動，`process.cwd()` 就是 `/Users/me/Projects/yeschef`，也就是規格 §2.1 明文禁止的「app 自身目錄」。`buildSpawnArgs`（`src/main/spawn-args.ts:24`）唯一的驗證是 `startsWith('/')`，這個路徑完全通過。

**因果鏈：**

1. `src/main/index.ts:84` 把 `process.cwd()` 當 fallback 傳進 `createPtyHost`。
2. `src/main/pty-host.ts:25-32` 用 `buildSpawnArgs` 回傳的 `cwd` 生 `claude` 子程序。
3. `claude` CLI 把該次 session 的逐字稿寫進 `~/.claude/projects/<cwd 編碼>/*.jsonl`，cwd 記成 yeschef 專案目錄。
4. `~/.claude/usage-data/ingest-jsonl.mjs` 的排除規則同時作用在 session cwd 與碰到的檔案路徑，超過 50% 落在 `EXCLUDE_PATHS` 就整場不計（規格 §2.1）。
5. 規格 §11 已經記著「若專案置於 `~/Projects/` 並比照排除，開發它本身不計入評量」。所以後果不只是歸屬跑掉，很可能是整場 session 被直接丟棄。

**使用者會看到什麼：** 什麼都看不到。沒有錯誤、沒有警告、沒有 UI 提示。左窗格的 claude 正常運作、對話正常、TUI 七項檢查全部會通過。要等到月底看 `report.html` 少了一整批 session 才會發現。這正是規格 §7 定調「不得靜默失敗」要防的那種事，而且踩在整個專案存在的前提上（公司用 Insights 做每月評量）。

**為什麼逐 task 審查沒抓到：** 三個原因疊在一起。

- Task 1 只審純函式。`tests/spawn-args.test.ts:11` 的測試名字就叫「cwd 是使用者的專案目錄，不是 app 目錄」，它通過，因為它自己餵了 `/Users/me/Projects/some-repo`。在 Task 1 的視野裡這條限制是有測試保護的。
- Task 4 接上 IPC 與 PTY 時，審查確實注意到了，記成延後項：「無 `YESCHEF_PROJECT_DIR` 時退回 `process.cwd()`，打包後從 Finder 啟動 cwd 是 `/` 會通過絕對路徑檢查（尚未打包，故延後）」。但那條延後的觸發條件寫成「打包後」，而規格 §10 明訂 v1 不打包、不簽章、不做安裝檔，所以觸發條件永遠不會到，延後等於永久豁免。同時那條延後只想到 Finder 啟動的 `/`，沒想到更常見的情況是 `npm run dev` / `npm run start` 下 cwd 就是 app 自己的目錄。
- 沒有任何一個 task 的範圍是「把測試斷言的東西跟產品實際傳的東西對起來看」。這是全分支審查才看得到的接縫。

**這是本分支第四次「宣稱做到但沒生效」，且屬於「數字算得出來、程式不報錯，但它回答的不是要問的問題」那一類。**

**怎麼修（三選一，建議全做）：**

1. `createWindow()` 裡若 `YESCHEF_PROJECT_DIR` 未設就不 spawn，把「請設定 YESCHEF_PROJECT_DIR 指向你的專案目錄後重開」寫進終端機 view（`index.ts:104-109` 已有現成的錯誤顯示路徑，直接沿用）。
2. `buildSpawnArgs` 增加一條驗證：`projectDir` 若等於 app 自身目錄則丟錯，並補一條餵 app 目錄的失敗測試，讓測試真的能抓到這個接縫。
3. RESULTS-01 的兩處啟動步驟（第 21 行、第 129 行）改成 `YESCHEF_PROJECT_DIR=$HOME/你的專案 npm run start`。grep 確認 `YESCHEF_PROJECT_DIR` 目前只出現在 `src/main/index.ts:84` 與計畫文件的 `Run:` 行，三份 RESULTS 都沒提到它，而使用者要照著做的是 RESULTS，不是計畫。

**沒有第二個 Critical。** 其餘全部落在 Important 與 Minor。

### Important (Should Fix)

#### I1. `src/main/cdp.ts:32, 43` — 附著得到，但呼叫端無法對子 session 下任何指令

用 `tsc` 探針實測確認兩件事：

```
probe.ts(4,49): error TS2554: Expected 1-2 arguments, but got 3.
probe.ts(7,23): error TS2339: Property 'sessionId' does not exist on type 'AttachedTargetInfo'.
```

`CdpSession.send<T>(method, params?)` 的公開簽章沒有 `sessionId`（實作內部有，但沒導出），且 `AttachedTargetInfo` 只有 `{targetId, type, url}`，不含 `sessionId`。所以外部呼叫端既無法取得子 session 的 id，也無法把指令送進去。

為什麼重要：Spike 3 量到的 100% 是「附著率」，不是「可驅動率」。第二份計畫的 `view_click`、`view_type`、`view_snapshot` 一旦目標落在跨站 iframe（也就是規格 §7 第一列點名的金流與 SSO 登入框），全都需要對子 session 發 `Runtime.evaluate` / `DOM.*` / `Input.*`。現在的介面做不到。閘門通過之後第一件事就會撞牆。

怎麼修：`AttachedTargetInfo` 加 `readonly sessionId: string`；`CdpSession.send` 簽章加第三個 `sessionId?: string`（實作已經支援，只是型別沒導出）。兩處都是加欄位，不破壞既有呼叫端。

#### I2. `src/main/cdp.ts:132-136` — 外部 detach 之後 `getAttachedTargets()` 回傳陳舊清單

`detach()` 設 `detached = true`、移除監聽器、呼叫 `wc.debugger.detach()`，但不清空 `attachedTargets`。更重要的是**沒有處理 debugger 被外部 detach**（DevTools 被打開、webContents 被銷毀、target crash），那些情況不送 `Target.detachedFromTarget`，`detached` 也不會變 true。

為什麼重要：§7 第一列要求 snapshot 固定回報「有 N 個 iframe 未附著」。分子從陳舊清單來，未附著數少報，agent 以為自己看得到全部。另外 `wc.debugger.detach()` 沒包 try/catch，重複 detach 或對已銷毀的 webContents detach 會丟錯。

怎麼修：`detach()` 裡 `attachedTargets.clear()`，並把 `wc.debugger.detach()` 包 try/catch 讓它冪等；註冊 `wc.debugger.on('detach', ...)`，在裡面設 `detached = true` 並清空 map。

#### I3. `spikes/measure-memory.ts` — 三個 spike 裡唯一沒有有效性閘門的，偏偏是唯一還沒跑的

`probe-input-focus.ts:227-246` 與 `probe-oopif.ts:394-402` 都會自己判定量測無效並以非零碼結束。`measure-memory.ts:51-54` 只是印五行就結束，沒有任何判定。

為什麼重要：它的失效模式會產生一個看起來大幅通過的假結果。比對字串一旦失效（`yeschef` 這個 substring 沒出現在 ps 行裡），該列變 0 MB，淨變化算出來是大幅負值，判準看起來輕鬆通過。實跑確認腳本在 yeschef 未執行時就是印 `yeschef 0 MB (0 個程序)`，跟「比對失效」的輸出一模一樣，靠輸出本身分不出來。目前唯一的防線是 RESULTS-01 第 28-35 行的散文，而散文正是另外兩個 spike 已經放棄的做法。

怎麼修：加閘門，yeschef 組 `count === 0` 或 `totalMb < 100` 時印「量測無效：比對字串可能失效」並 `process.exit(1)`；基準線階段用 `--baseline` 旗標放行（那個階段 yeschef 本來就該是 0）。

#### I4. `spikes/probe-oopif.ts:288-290` — `rearmErrors` 只在 `OOPIF_DEBUG` 下印

`getRearmErrors()` 這個 API 的存在理由就是「呼叫端要能看到這裡曾經失敗過」（`cdp.ts:45-48` 的註解自己這樣寫）。結果全 repo 唯一的呼叫端把它藏在 debug 環境變數後面。

為什麼重要：與「不得靜默失敗」直接矛盾，而且 RESULTS-03 第 227-242 行那次產出頭條 16/16 的執行**沒有開 `OOPIF_DEBUG`**，所以無從得知當時有沒有 re-arm 失敗。這次結論仍然成立（re-arm 失敗會讓孫代進不了分子但仍在分母，覆蓋率會掉，而它是 100%），但使用者重跑時看不到這條訊號。

怎麼修：`printSiteResult()` 裡無條件印一行 `re-arm 失敗 N 次`（N > 0 時），完整訊息仍留在 `OOPIF_DEBUG`。

#### I5. `docs/RESULTS-01-memory.md:123` — 這個檢查項不可能通過

> 檢查 `npm install` 或 `npm run build` 的日誌，確認有執行 electron-rebuild

`package.json` 沒有 `postinstall`，也沒有任何 script 呼叫 `electron-rebuild`（`@electron/rebuild` 只是 devDependency），grep 確認過。所以日誌永遠不會出現它，這個項目如寫只可能勾 ✗，而使用者不知道該勾 ✗ 是因為真的沒重建、還是因為檢查方式本身錯了。

怎麼修：把檢查項改成可執行的動作，「跑 `npx electron-rebuild -f -w node-pty`，然後啟動 app 確認左窗格出得來（若 node-pty ABI 不符，`index.ts:102` 的 catch 會把錯誤寫進終端機）」；或在 `package.json` 加 `"postinstall": "electron-rebuild -f -w node-pty"`，讓日誌真的有東西可查。

#### I6. `docs/RESULTS-01-memory.md:28-41` — 健全性檢查沒綁到階段，會誤導

「量測前的健全性檢查」要求 yeschef 那列是「數百 MB 且程序數 > 1」，否則「此次量測無效」。但這一節排在基準線與 yeschef 兩段步驟之後，讀者無法判斷它屬於哪一段。在基準線階段（yeschef 尚未啟動）那列必然是 0 MB，照字面會得出「量測無效」的錯誤結論。

同一節另有一處自相矛盾：「claude CLI 那列：數字應為**數百 MB 等級**（實測約 2300 到 3500 MB）」，2300 到 3500 是數千不是數百，而規格 §3.2 給的是 480 到 530 MB。我實跑量到 3129 MB / 8 個程序（含本次審查自己的 claude 程序），所以那個範圍是量測當下環境的產物，不是通則。iTerm2 那條也已經漂移：文件寫「實測約 340 到 350 MB」，我量到 426 MB。

怎麼修：把健全性檢查拆成兩塊，各自放進「基準線量測」與「yeschef 量測」的步驟末尾；把 claude CLI 與 iTerm2 的絕對數字範圍改成相對判準（「非 0 且程序數 > 1」），不要寫死跟環境綁死的區間。

#### I7. `vitest.config.ts:6` — 「覆蓋率 80% 以上」從未被量過，而且 include 漏了兩個模組

`npx vitest run --coverage` 直接失敗：`MISSING DEPENDENCY 'Cannot find dependency @vitest/coverage-v8'`。所以這條計畫層級的約束沒有任何證據支撐。

另外 include 只有 `spawn-args.ts`、`layout.ts`、`cdp.ts`，漏了 `src/shared/ipc.ts`（`parseResizePayload`，14 個測試）與 `spikes/measure-memory.ts`（`filterHits`，12 個測試），兩個都是可單元測試的純邏輯模組，都已經有測試，卻不在計數範圍內。

怎麼修：`npm i -D @vitest/coverage-v8`、加 `"test:coverage": "vitest run --coverage"`、把上述兩個檔案加進 include、跑一次把數字記進閘門紀錄。

#### I8. `src/main/agent-view.ts:12-21` — 右窗格無 `setWindowOpenHandler`

任何 `target="_blank"` 連結會開出一個獨立的 BrowserWindow。這違反規格 §3.3 明列的「不做多視窗」，而且那個新 WebContents 不在 CDP session 的掌握內，第二份計畫的 agent 會直接失去頁面，且沒有任何訊號。

即時的影響：RESULTS-01 區塊 3 第 4 項要人「在右格直接用滑鼠點連結，頁面會導航」。example.com 只有一個連結且非 `_blank`，這次不會踩到，但只要驗證者順手導到別的站就會。

怎麼修：`webContents.setWindowOpenHandler(({ url }) => { void loadInPlace(url); return { action: 'deny' } })`，或最低限度直接 `deny`。

#### I9. `src/main/index.ts:86` — `--mcp-config` 指向不存在的 `mcp.js`

```typescript
mcpServerArgs: [join(import.meta.dirname, '../main/mcp.js')],
```

解析出來是 `out/main/mcp.js`。build 過之後 `out/main/` 只有 `index.js`。所以每次啟動，claude CLI 都會嘗試 `node out/main/mcp.js`、失敗、在 TUI 裡報 MCP server 連線錯誤。

為什麼重要：即將進行的 Spike 1 手動 TUI 驗證（七項）會在滿螢幕 MCP 錯誤的狀態下進行，而 RESULTS-01 完全沒提這是預期的。驗證者有機會把它判成外殼壞掉，或反過來把真正的問題歸因成「反正那個 MCP 錯誤是已知的」。

怎麼修：在 RESULTS-01 區塊 2 開頭加一行說明這是預期現象（MCP server 是第二份計畫）；或在 `createPtyHost` 前檢查該檔存在，不存在就不帶 `--mcp-config`。後者比較乾淨，且不影響 `buildSpawnArgs` 的既有測試。

#### I10. `src/main/index.ts:126-138` — 兩個窗格的載入失敗只進 console

PTY 失敗那條做對了（寫進終端機給人看），但左右窗格 `loadURL`/`loadFile` 失敗只 `console.error`。打包後的 GUI app 沒有人看 console，這在使用者感受上等同靜默失敗，右窗格會是一片空白，沒有任何說明。

怎麼修：右窗格失敗時 `loadURL` 一個 `data:text/html` 的本地錯誤頁，帶上失敗的 URL 與訊息；左窗格失敗時 renderer 起不來，`index.ts:104` 那條路徑也用不上，至少要讓視窗標題或右窗格顯示狀態。

#### I11. `src/main/cdp.ts:140-153` — attach 失敗時無條件 detach（延後項 Task 6 #21）

`if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')` 表示這次呼叫可能不是附著者，但 catch 區塊一律 `wc.debugger.detach()`。目前只有一個呼叫端所以不可達；第二份計畫一旦出現第二個 attach 呼叫端，一次失敗的 attach 會把另一個正在工作的 session 拆掉，而且是靜默的（catch 裡刻意忽略 detach 失敗）。

怎麼修：`const weAttached = !wc.debugger.isAttached()` 記在最前面，catch 裡只在 `weAttached` 為 true 時 detach。

### Minor (Nice to Have)

- `spikes/probe-oopif.ts:305-308` — `finally { cdp.detach() }` 裡的 detach 若丟錯（頁面已崩潰、debugger 已斷），會蓋掉 `return`，讓一次成功的量測被外層 catch 記成 `load-failed`。包 try/catch 即可。
- `spikes/probe-oopif.ts:190-197` — `findExcludedButAttached()` 只報「被排除但已附著」。真正會灌高覆蓋率的方向是「被排除且未附著」（同站 frame 沒進分母又沒附著），那個方向沒有診斷。實務上不太可能發生（armed session 下的子代都會附著），但一致性檢查報的是無害方向這件事值得記一筆。
- `spikes/probe-oopif.ts:96` — 註解寫 `checkExcludedButAttached()`，實際函式名 `findExcludedButAttached()`（延後項 Task 8 #22）。
- `spikes/measure-memory.ts:53` — `padEnd(38)` 用 UTF-16 code unit 算，CJK 標籤實際顯示會歪，實跑確認。已列入「合併前必修」。
- `src/main/index.ts:8` — `DEFAULT_RATIO` 住在 `index.ts`，`MIN_RATIO`/`MAX_RATIO` 住在 `layout.ts`，三個同族常數分居兩檔。
- `spikes/probe-input-focus.ts:182` 用 `__dirname`（依賴 esbuild 打成 CJS），`src/` 用 `import.meta.dirname`。兩種模組慣例混用，換打包方式會壞。
- `spikes/probe-input-focus.ts:132-162` — `checkValidity` 只比「三種情境互不相同」，不比絕對值。理論上三態全部反過來也會通過。實務不可達，且 RESULTS-02 第 124-129 行已經把絕對期望值寫給人看了。
- `docs/RESULTS-03-oopif.md:224` 寫「2 次獨立重跑」，`:251` 寫「連續 4 次獨立重跑」。
- `src/preload/terminal.ts` 與 `src/renderer/terminal.ts:6-15` 的 API 形狀重複（延後項 Task 4 #12，已列入「合併前必修」）。
- 沒有 README。規格 §10 的交付形式是「`npm run build` 加本地執行」，但沒有任何文件說明啟動需要 `YESCHEF_PROJECT_DIR`、是否需要先 `electron-rebuild`。

---

## 給閘門的建議

**Spike 3（已完成，16/16）：結論可信，但要在會議上把「附著」與「可驅動」分開講。** 分母改用 CDP frame 樹是對的修法，跟直接父層比 eTLD+1 也是對的（隔離邊界發生在相鄰兩層之間）。reviewer 的獨立對照實驗（拿掉遞迴 re-arm，深度 2 的 SSO 登入框變回 `attached:false` 但仍留在分母）是這份結論最有力的證據，因為它證明分母不隨附著結果變動，那正是第一輪「分子分母同時隱形、互相抵銷」那個假象的根因。這個排查過程的品質高於本分支平均水準。

但 100% 是附著率。**Important 1 說明呼叫端目前無法對任何一個附著到的子 session 下指令。** 閘門若把 Spike 3 判成「跨站 iframe 這個風險已排除」，第二份計畫寫第一個 `view_click` 時就會發現風險只排除了一半。建議把 I1 的修正（兩個型別欄位）併進閘門通過的條件，成本很低。

樣本量的揭露文件自己做得很誠實（rule of three 上界約 19%，3 站 16 個 frame 分不出 100% 與略低於 95%），規格 §8 原本要 5 站也如實記了為何剩 3 站。沒有要加碼的保留。

**Spike 2（待解鎖重跑）：腳本可以直接重跑，不需要改。** 有效性閘門、輪詢、語意 key 比對三項修正都到位，`app.hide()` 與「僅僅失焦」的落差也誠實寫出來並給了替代量法。RESULTS-02 的「一次有效的執行長什麼樣」四條判準足以讓沒讀過對話的人自己判斷結果能不能用。唯一建議：重跑前先確認 `YESCHEF_PROJECT_DIR` 那件事不影響它（不影響，這支 spike 不 spawn claude），然後把新數字補進文件時順手加填空欄。

**Spike 1（全待執行）：這是三個裡最脆的一個，建議在使用者動手之前先修 C1、I3、I5、I6、I9。** 理由不是程式碼品質差，而是它同時具備三個條件：唯一還沒跑、唯一沒有機器閘門、失效方向剛好是「看起來通過」。目前若照 RESULTS-01 逐條做下去，最可能的結局是七項 TUI 全勾、記憶體數字抄完、卡在區塊 4 第 1 項，而全程沒有任何地方告訴使用者 usage 沒進 Insights。這五項加起來大約半天。

**要不要繼續做第二份計畫：要，但先過 C1。** 程式碼品質本身沒有讓我擔心的地方，切分清楚、錯誤處理模式雖多但不互相矛盾、`cdp.test.ts` 的假 debugger 是真的在測產品邏輯、三份 RESULTS 有兩份可以直接交給沒讀過對話的人。這支分支的問題集中在「純函式做對了、接線接錯了」這一個模式上（C1 是最嚴重的一例，I9 是同一模式的輕量版），而不是分散的品質問題。修掉那個模式，地基是穩的。

也建議把 I1、I2、I11 三項（全都在 `cdp.ts`）一起排進第二份計畫的第一個 task，而不是散落在各個 MCP 工具的實作裡，那個檔案是 9 個工具的共同基礎，等 9 個呼叫端都寫完再改介面會貴很多。
