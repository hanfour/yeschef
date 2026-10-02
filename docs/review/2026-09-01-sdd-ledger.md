# SDD ledger — plan: docs/superpowers/plans/2026-08-31-yeschef-shell-and-spikes.md

Spec: docs/specs/2026-08-31-yeschef-design.md（已讀，為裁決依據）
分支: feat/shell-and-spikes（非 worktree）

Ruling: 用分支而非 git worktree — repo 是今天新建、沒有其他進行中的工作，
  且 worktree 會讓 node_modules 與 electron-rebuild 要裝兩份 — 若之後真的需要
  平行開發，成本是當時再開 worktree 並重裝相依。

## 派工前衝突掃描

### 跨 task 共用檔案／介面

| Task 對 | 共用項 | 生產端 | 消費端 | 結果 |
|---|---|---|---|---|
| 1 → 4 | `SpawnArgsInput`, `buildSpawnArgs` | T1 定義 `{projectDir, mcpServerCommand, mcpServerArgs}` | T4 `createPtyHost({input:{同三欄}})` | 一致 |
| 2 → 3 | `splitBounds`, `Bounds`, `Size` | T2 回 `{left,right}`，`Bounds{x,y,width,height}` | T3 傳給 `view.setBounds()` | 一致，形狀符合 Electron Rectangle |
| 2 → 7 | `splitBounds` | 同上 | T7 取 `right.width/height` 算點擊座標 | 一致 |
| 3 → 7 | `createAgentView()` | T3 定義 | T7 呼叫 | 一致 |
| 3 → 8 | `createAgentView()` | T3 定義 | T8 呼叫 | 一致 |
| 3 → 4 | `src/main/index.ts`, `src/preload/terminal.ts`, `src/renderer/index.html` | T3 建立 | T4 修改 | 一致，T3 的 preload 是空橋接，T4 填內容 |
| 6 → 7 | `attachCdp`, `CdpSession.send<T>` | T6 定義 `params?: object` | T7 帶 params 呼叫 | 一致 |
| 6 → 8 | `attachCdp`, `CdpSession.send<T>` | 同上 | T8 不帶 params 呼叫 `Target.getTargets` | 一致，params 為選用 |
| 6 → 7 | `tests/fixtures/click-counter.html` | T6 建立 | T7 載入 | 一致 |
| 1,3,5,7,8 | `package.json` 的 scripts | 各自新增 | 各自新增 | 無衝突，但實作者須「新增」而非「取代」既有 scripts。已寫入各 task 派工說明 |

### 各 task 自洽性

| Task | 檢查 | 結果 |
|---|---|---|
| 1 | 8 個測試 vs 實作的 8 條行為 | 一致 |
| 2 | 6 個測試 vs 實作；累計數 8+6=14 | 一致 |
| 3 | 建立的檔案 vs T4 後續修改的檔案 | 一致 |
| 3 | renderer 載入方式 | **不一致，見 Ruling 1** |
| 4 | 引用尚不存在的 `mcp.js` | 計畫已明說是預期行為，一致 |
| 5 | `measure-memory.ts` 的 match 字串 | 次要問題，見 Ruling 3 |
| 6 | 3 個測試；累計數 14+3=17 | 一致 |
| 7 | 打包格式 vs 程式碼用的模組語法 | **不一致，見 Ruling 2** |
| 8 | 腳本與判準 | 一致 |

### 裁決

Ruling 1: Task 3 的 `src/main/index.ts` 載入 renderer 時，必須先看
  `process.env['ELECTRON_RENDERER_URL']`，有值就 `loadURL(該值)`，沒有才
  `loadFile(...)` — 計畫寫死 `loadFile`，但 electron-vite 在 dev 模式下 renderer
  由 dev server 提供而不是檔案，寫死會讓 `npm run dev` 開出空白左窗格 —
  若判斷錯，代價是 production build 載入路徑要改回來，一行。

Ruling 2: Task 7 的 `spikes/probe-input-focus.ts` 必須用 `__dirname` 而非
  `import.meta.dirname` — 計畫的執行指令用 esbuild `--format=cjs` 打包，CJS 輸出
  裡沒有 `import.meta` — 若判斷錯，代價是改回 ESM 打包並確認 Electron 能載入 .mjs。

Ruling 3: Task 5 的 `measure-memory.ts` 的 `yeschef` 比對字串會同時命中量測腳本
  自己與任何從該目錄啟動的程序 — 保留現狀不修 — 輸出有列程序數，量測時人看得出來 —
  若判斷錯，代價是該次量測數字偏高，重跑一次即可。

## 執行紀錄
Task 1: dispatched (implementer, haiku; BASE 02fd7b3)
Task 1: implementer DONE (196067c, 8/8 通過) — 已派 task reviewer (sonnet)
Task 1: minor (deferred): 報告寫的錯誤訊息 '專案目錄必須是絕對路徑' 與實際碼／測試的 'projectDir 必須是絕對路徑' 不符（僅報告文字有誤，碼與測試一致）
Task 1: minor (deferred): package-lock.json 未隨 Task 1 提交（Task 3 Step 6 的 git add 已含它，屆時自然解決）
Task 1: minor (deferred): projectDir 的驗證假設一定是 string；Task 4 接上 IPC 邊界時若有 any 型別穿透會拋 TypeError 而非領域錯誤
Task 1: complete (commits 02fd7b3..196067c, review clean)
Task 2: implementer DONE (d561f07, 14/14 通過)
Task 2: 已派 task reviewer (sonnet, BASE 196067c HEAD d561f07)
Task 2: minor (deferred): container.width 為負時會把負值傳進 left.width 與 right.width（plan-mandated，brief Step 3 就是這個無驗證版本；Electron 內容尺寸不會是負數，風險低）
Task 2: minor (deferred): clamp 測試用 0.05/0.99 而非剛好 MIN_RATIO/MAX_RATIO（reviewer 已手算確認邊界為包含，屬覆蓋廣度而非正確性）
Task 2: complete (commits 196067c..d561f07, review clean)

Ruling: Task 3 Step 5 與 Task 4 Step 6 的「手動檢查清單」不由實作者執行 —
  那些項目需要人用滑鼠點、肉眼看畫面、跨 app 比對 cookie，subagent 做不到，
  硬做只會產生假的通過紀錄 — 實作者只負責「建置成功、啟動不崩、輸出無錯誤」，
  並以 DONE_WITH_CONCERNS 回報手動項待人工驗證；所有手動項集中到 Task 5 的
  RESULTS-01-memory.md 由使用者一次做完 — 若判斷錯，代價是使用者在 Task 5
  才發現 Task 3 的視覺缺陷，需回頭修一次。
Task 3: implementer DONE_WITH_CONCERNS (67e439e) — build/test/啟動三項過，但自審發現 preload 靜默未載入
Ruling: preload 改為輸出 CommonJS 的 terminal.cjs，main 引用 .cjs，左窗格維持 sandbox: true —
  Electron 的 sandbox preload 必須是 CommonJS，ESM preload 需要 sandbox: false；
  為了一個十行的橋接檔關掉 sandbox 不划算 — 要求實作者用它先前找出這個 bug 的
  同一個 CDP 手法實測 window.yeschef 有定義，不接受推論 —
  若判斷錯（CJS preload 在此版 Electron 也不通），代價是改用 sandbox: false 加 ESM preload，
  安全性下降一級但功能可行，且只影響左窗格（右窗格本來就沒有 preload）。
Task 3: 修正完成並實測 (cbe6886) — 左窗格 window.yeschef 為 object，右窗格 undefined；CJS preload 在 Electron 44 可行，sandbox 未降
Task 3: review = Needs fixes（2 Important、4 Minor）；安全邊界四項檢查全過（右窗格無 preload、partition 正確、無除錯殘留、隔離未削弱）
Ruling: Important 2「void 吞掉 load 的 rejection」標為 plan-mandated，但採納 reviewer 意見要求修正 —
  brief 原文確實寫 void，然而規格 §7 錯誤處理明訂「記錄並在 UI 顯示，不靜默失敗」，
  且使用者全域規則寫「Never silently swallow errors」，規格優先於計畫原文 —
  若判斷錯，代價是多三行 catch 與一則 console.error，無下行風險。
Ruling: Minor 6「沒有 typecheck 關卡」提升進本次修正輪，不留給最終審查 —
  它是 Important 1 得以一路綠燈的根因，而 Task 4、6、7、8 都會再加 TypeScript，
  不裝這個關卡等於讓同型錯誤在後面四個 task 重複發生 —
  若判斷錯，代價是多一個 npm script。
Task 3: minor (deferred): 報告對 allowScripts 三筆的成因敘述不正確（electron 44 已無 install script，改為 lazy download）；設定內容本身正確
Task 3: minor (deferred): 左窗格未寫 webviewTag: false（預設即 false，非漏洞，但與右窗格不對稱）
Task 3: minor (deferred): 右窗格未設 setWindowOpenHandler，target=_blank 會開出獨立視窗跳出版面（仍在 persist:agent 下，非隔離破口）
Task 3: 人工驗證提醒（併入 Task 5）：titleBarStyle 'hiddenInset' 搭配兩個 view 都從 y:0 起算，macOS 紅綠燈按鈕可能疊在左窗格內容上
Task 3: fix round 1/5 dispatched → d3db59b（修 1 getContentBounds、修 2 三處 catch、修 3 typecheck script）
Task 3: fix round 1/5 (3 addressed, 0 open; commits cbe6886..d3db59b)
Task 3: minor (deferred): index.ts 底部的 void app.whenReady().then(...) 是同一類靜默吞 rejection 模式，本輪未觸及
Task 3: complete (commits d561f07..d3db59b, review clean)
Task 4: implementer DONE_WITH_CONCERNS (8ec6dfc) — typecheck/test 14-14/build 三 target 過；PTY 實測 lsof 確認 cwd 正確、掛真 pty、使用者既有 MCP server 有被拉起、關閉無殘留
Task 4: review = Needs fixes（4 Important 全為 plan-mandated 或結構性、4 Minor）
Ruling: 四個 Important 全部要修，不因 plan-mandated 而放行 —
  #1 preload 隱式回傳洩漏 ipcRenderer：規格 §4.1 的原則是「任何注入的橋接都是攻擊面」，
     而這個寫法把 sandbox 想守的線讓出去；
  #2 IPC 邊界零驗證：使用者全域規則「ALWAYS validate at system boundaries」與規格 §7 不得靜默失敗；
  #3 ipcMain 監聽器不移除、send 無 destroyed 守衛：資源洩漏與 main process 未捕捉例外；
  #4 PTY 早於 renderer 載入完成就生起來，開場輸出可能被丟棄：規格 §8 Spike 1 的第 1 項判準
     就是「左格出現 claude 的歡迎畫面」，這個 bug 會讓閘門判準本身變成不穩定 —
  若判斷錯，代價是多寫約 40 行與一組 parseResizePayload 的測試，無下行風險。
Ruling: Minor 2「renderer 缺 window.yeschef 存在性守衛」提升進本輪 —
  它把「preload 沒載到」從全黑無訊息變成看得見的訊息，而 Task 5 的人工檢查清單
  必須能分辨「preload 壞了」與「claude 壞了」，否則那份清單的結果無法解讀 —
  若判斷錯，代價是三行。
Ruling: Minor 1 的後半「buildSpawnArgs 的 throw 落進沒有 .catch() 的 whenReady 鏈」提升進本輪 —
  環境變數給相對路徑時視窗會建好但所有載入被跳過，這正是本專案已出現三次的靜默失效模式 —
  若判斷錯，代價是一個 try/catch。
Task 4: minor (deferred): 無 YESCHEF_PROJECT_DIR 時退回 process.cwd()，打包後從 Finder 啟動 cwd 是 / 會通過絕對路徑檢查（尚未打包，故延後）
Task 4: minor (deferred): resize 無節流，拖曳視窗邊緣會對 claude 連發 SIGWINCH
Task 4: minor (deferred): renderer 與 preload 各自宣告一次同一份 API 形狀，會漂移且編譯器不抱怨
Task 4: ⚠️ 待人工確認（併入 Task 5）：electron-rebuild 是否真的跑過（node-pty 1.1.0 走 N-API 有 prebuild，未重建也可能會動，只在 Electron 升版後露餡）；renderer 是否真的畫得出畫面
Task 4: fix round 1 第一次派工失敗 — sonnet 觸及 session rate limit（8pm Asia/Taipei 重置），實作者未做任何修改即中止，工作區乾淨
Ruling: 改用 haiku 重派同一輪修正，不等到 8pm —
  本輪六項修正的確切程式碼我已寫進指示，屬抄寫加測試，依 Model Selection 本來就該用最便宜層級；
  且可藉此判斷該限制是模型層級還是帳號層級 —
  若判斷錯（帳號層級，haiku 也會失敗），代價是一次失敗的派工，立刻就知道，改為等待重置。
Task 4: fix round 1/5 → 5bb6810（六項全修，28/28 測試；修 1 與修 4 的 GUI 實測未完成，實作者誠實標明）
Task 4: fix round 1/5 (6 addressed, 0 open; commits 8ec6dfc..5bb6810)
Task 4: minor (deferred): did-finish-load 重複觸發時（dev reload），舊世代 PtyHost 的 onExit closure 會在新 PtyHost 接好後才觸發，顯示假的「claude 已結束」訊息。無世代檢查，只有 isDestroyed 守衛。正常單次載入不會發生
Task 4: 觀察 (deferred): pty.kill() 在一個視窗生命週期內可能被呼叫多次，node-pty 對已回收程序再 kill 是否會同步 throw 未驗證（pty-host.ts 本輪未動）
Task 4: 觀察 (deferred): ipcMain 的兩個 listener 未依 event.sender 過濾，日後若開多視窗會互收鍵盤輸入與 resize（既存問題，非本輪引入）
Task 4: complete (commits d3db59b..5bb6810, review clean)
Task 5: implementer DONE_WITH_CONCERNS — 量測腳本與四區塊檢查表已備；樣本輸出 claude CLI 僅 3 MB 與實測 480-528 MB 不符，疑比對字串抓錯程序
Task 5: fix → 5db0d6c（claude 比對改 basename，claude CLI 由 3 MB 修正為 3361 MB / 10 程序；已實際提交）
Task 5: fix round 2 → 35a1a16。根因：macOS 的 ps -Ao comm 截斷到 15 字元，basename 永遠取不到 Electron。
  改整行子字串比對 'Electron.app' 後實測 yeschef 470 MB / 5 程序、claude CLI 3450 MB / 11 程序。殘留程序已清。
Task 5: review = Needs fixes（2 Critical、4 Important、4 Minor）
Ruling: 兩個 Critical 的修法是「回到 brief 原本的 match: ['yeschef', 'electron-vite']」而非再想新方案 —
  reviewer 指出指令列本身含 /Projects/yeschef/，原設計就是專案範圍限定的，且能抓到 electron-vite 包裝程序；
  第二輪改成 'Electron.app' 是把範圍改寬，方向反了 —
  若判斷錯，代價是量測腳本再修一輪。
  附註：我在派工前掃描的 Ruling 3 只檢查了 yeschef 那組的誤命中風險，沒檢查 claude 那組會不會根本抓不到，掃描深度不足。
Ruling: Important 6「比對邏輯與 execSync 未分離、無法單元測試」提升為本輪必修 —
  這個函式在本 task 已改三輪，而 reviewer 指出抽出純函式後兩行測試就能抓到兩個 Critical；
  這是防止第四輪的控制措施，不是風格建議 —
  若判斷錯，代價是多一個純函式與一組測試。
Ruling: Minor 8、9、10 提升進本輪（幽靈檔名 electron-main.ts、假的 bash code block、方法敘述與實際指令不符）—
  這三項都在使用者要照著做的那份文件裡，而該文件的唯一存在理由就是讓使用者不必回頭翻程式碼；
  文件裡的事實錯誤會直接讓使用者去找不存在的檔案 —
  若判斷錯，代價是三行文件修正。
Task 5: minor (deferred): padEnd(38) 用 UTF-16 code unit 計算，CJK 標籤實際顯示寬度多 3 到 6 欄（brief 原始腳本就有，非本輪引入）
Task 5: fix rounds 3-4 → 7cf0970, d892d35（回復 brief 原比對、抽 filterHits 純函式加 13 測試、三項文件事實錯誤、拆出 electron-vite 136 MB 並改判準基準）
Task 5: re-review 結果 = 七項 findings 全部 addressed，但 fix diff 自身引入 2 個 Important
  (1) spikes/measure-memory.ts:25 的自我排除檢查 '--pid <pid>' 是死碼，無任何呼叫路徑會產生該字串，ps 也不輸出 pid 欄
  (2) tests/measure-memory.test.ts 從未測到真正的 GROUPS（未 export），13 個測試各自造 group 字面值；
      把 GROUPS[0].match 改回 ['Electron.app'] 會讓 41 個測試全綠，正是本 task 已重複三次的回歸型態
Ruling: 進第 5 輪（上限）修這兩項 —
  測試不涵蓋真實設定，等於 Important 3 的目的（防止第四輪）沒有達成，那是加測試的唯一理由；
  死碼的自我排除比沒有更糟，因為它讓人以為有防護 —
  若第 5 輪仍未收斂，我依 breaker 規則逐項裁決，不再派工。
Task 5: minor (deferred): 負向測試樣本 'Other Electron App.app' 不含字面字串 'Electron.app'（空格阻斷），名不副實
Task 5: minor (deferred): tests/measure-memory.test.ts:44-51 與 :20-26 近乎重複，灌測試數但無新涵蓋
Task 5: minor (deferred): console 輸出把 electron-vite 子集列印在兩個基準線之後，與其母列 yeschef 不相鄰
Task 5: fix round 5/5 → 597b3dc（export GROUPS、真實設定回歸測試、死碼自我排除改為比對 measure-memory 檔名）
Task 5: 控制端獨立驗證：手動把 GROUPS[0].match 改為 ['Electron.app'] → 2 個測試失敗；git checkout 還原 → 41/41。回歸防護為真，非宣稱。
Task 5: fix round 5/5 re-review = 全數 addressed，無新破壞
Task 5: complete (commits 5bb6810..597b3dc, 5 fix rounds, review clean)
Task 6: implementer DONE (a0f16ef, 44/44) — commit 已驗證真實存在，工作區乾淨
Task 6: review = Needs fixes（2 Important 皆 plan-mandated、3 Minor）；spec 完全相符，逐行比對確認實作與 brief 範例碼一致
Ruling: 兩個 Important 都要修，且都是我寫在 task-6-brief.md 範例碼裡的缺陷，非實作者偏離 —
  #1 toCdpError 丟掉原始錯誤的 stack 與 cause：規格 §7 要求錯誤可見，而這個 wrapper 的存在理由就是可診斷性，
     Task 7、8 跨 5 個網站出間歇性失敗時這是唯一線索；
  #2 attachCdp 中途失敗留下半附著 debugger 且呼叫端無把手：資源洩漏，而 Task 8 設計就是重複 attach/detach —
  若判斷錯，代價是多一個 cause 欄位與一組 try/catch，無下行風險。
Ruling: Minor 1「attach 在 try/catch 之外，同步失敗會拋原始 Error 而非 CdpError」併入本輪 —
  修 #2 的 try/catch 自然涵蓋它，分開處理反而要寫兩次 —
  若判斷錯，代價是錯誤型別一致性稍差。
Task 6: minor (deferred): String(o.code) 對 unknown 值理論上可能因 toString 拋錯而爆掉（CDP 協定的 code 恆為數字，實務不可達）
Task 6: 觀察: 實作者自審宣稱「錯誤處理完整、無吞掉、自審無發現」，但兩個 Important 都沒抓到。後續 task 對自審報告的採信權重應維持在低
Task 6: fix round 1/5 → b66afd6（CdpError 保留 cause、attachCdp 統一 try/catch 並在失敗時 detach、補 cause 測試 45/45）
Task 6: fix round 1/5 (2 addressed, 0 open; commits a0f16ef..b66afd6)
Task 6: minor (deferred): attachCdp 的 catch 無條件 detach，未追蹤「這次呼叫是否為附著者」。
  Task 7、8 下 attachCdp 是 webContents.debugger 的唯一擁有者（已 grep 確認 agent-view.ts 不碰），故非阻擋；
  但若日後有第二個 CDP 消費者共用同一個 WebContents（手動 DevTools、其他模組），send 失敗會拆掉對方的連線。
  修法（供 MCP 工具層那份計畫參考）：const attachedHere = !wc.debugger.isAttached()，catch 內僅在 attachedHere 時 detach
Task 6: complete (commits 597b3dc..b66afd6, review clean)
Task 7: implementer BLOCKED (faf9162) — 三態皆 200/200 但實作者自行判定無效並回報 BLOCKED
Task 7: 控制端獨立驗證：ioreg 確認 CGSSessionScreenIsLocked = True，診斷屬實。
  鎖定期間 loginwindow 獨佔 WindowServer 焦點仲裁，三種焦點狀態在 OS 層級相同，測不出差異。
Ruling: Task 7 的量測交由使用者在解鎖的 session 執行，併入人工驗證清單 —
  這是環境限制，換模型或補脈絡都無解，實作者已做對照組（AppleScript 叫 Finder 到前景亦失敗）排除腳本問題 —
  若判斷錯（其實有可繞過的方式），代價是使用者多跑一次指令。
  腳本本身仍須通過 review，因為它的設計決定使用者那次執行能不能產出有效數字。
Task 7: review = Needs fixes（2 Important，皆與「使用者解鎖後重跑會不會拿到無效數字卻不自知」有關）
  spec 全數相符；座標相對 view 正確、計數三態不污染、__dirname 覆寫已套用、結果文件未把無效的 200/200/200 當通過
Ruling: 兩個 Important 都要修，且必須在使用者重跑之前修完 —
  這個腳本產出的是決定 Spike 2 通過與否的數字，而目前它在焦點未切換時會印出漂亮的假通過；
  這次靠實作者用眼睛比對才識破，不能把同樣的責任丟給使用者 —
  若判斷錯，代價是多一組斷言與一次 app.hide() 的嘗試，無下行風險。
Task 7: 讚許（值得記錄）：實作者拿到三態皆 200/200（照判準是完美通過）卻自行判定無效並回報 BLOCKED，
  另做 AppleScript 對照組排除腳本問題。這是本專案至今唯一一次主動識破自己的假 PASS。
Task 7: fix round 1/5 → 7545237（有效性閘門 + 情境3改 app.hide()）
Task 7: 控制端獨立驗證：npm run spike:input 實跑，印出「量測無效：焦點狀態未能真正切換」並逐條列出三個比較失敗原因，結束碼 1。閘門為真，非宣稱。
Task 7: fix round 1/5 re-review = 全數 addressed，閘門在解鎖情境下經逐條分析不會反向誤判（三個條件都是差異比較而非寫死絕對值）
Ruling: 進 fix round 2 修三項，理由是使用者只會跑一次，那次必須產出可解讀的結果 —
  (1) 300ms 等待是為 win.blur()（同步）設的，情境 3 改 app.hide()（OS 層級非同步）後未重新驗證；
      超時會誤判為無效，且輸出與真失敗無法區分，使用者會誤以為 spike 沒過；
  (2) app.hide() 讓視窗「隱藏」而非「僅失焦」，與 brief 描述的真實情境（切到別的 app、視窗仍可見）不等價，
      情境 3 若量到低成功率，其對規格 §8 降級方案的意義不同，文件需提醒；
  (3) checkValidity 用 results[0]/[1]/[2] 隱含綁定 SCENARIOS 順序，改順序會靜默壞掉 —
  若判斷錯，代價是多一段輪詢與兩段文件說明。
Task 7: fix round 2/5 → 54de6cf（輪詢取代固定 300ms 並標註逾時、checkValidity 改語意 key、文件補「隱藏≠僅失焦」解讀落差）
Task 7: 控制端獨立驗證：實跑輸出情境1、2 帶「逾時 3000ms，狀態可能未穩定」，情境3 無逾時標記
  （鎖定下其目標狀態 winFocused=false 本來就成立，量不到 app.hide() 的效果）。總執行 9 秒，未卡住。
Task 7: fix round 2/5 re-review = 全數 addressed，無新破壞
  關鍵確認：逾時只影響診斷行文字，不影響 state 內容；逾時後回傳最後一次實際取樣值，
  checkValidity 拿真實值比較，故逾時不會造成假陽性或假陰性，只會讓失敗案例多等 3 秒再如實回報
Task 7: complete (commits b66afd6..54de6cf, 2 fix rounds, review clean)
Task 7: ⚠️ 量測待使用者在解鎖 session 執行 npm run spike:input（環境限制，非程式缺陷）
Task 8: implementer DONE (6057b79) — 找到兩個計數 bug：Target.getTargets 非單頁範圍（Stripe 164%、w3schools 717%）、querySelectorAll 穿不透 shadow DOM。修正後 16/16=100%，3 個有效測站
Task 8: review = Needs fixes（1 Critical、4 Important、5 Minor）
  C1: 實作者自己記錄的 accounts.google.com/gsi/button（第二層跨站 SSO 登入框）attached=false，
      同時從分子（被 attached 篩掉）與分母（DOM 走訪穿不透跨來源 contentDocument）消失，該站算成 1/1=100%。
      計入後 16/17 = 94.1% < 95%，閘門翻盤。Stripe 的巢狀 hCaptcha 未於深度 2 列舉，真實值只會更低。
  根因在產品程式碼：src/main/cdp.ts:50 的 Target.setAutoAttach 只在根 page session 發一次，
      flat 模式 auto-attach 不遞迴，每個被自動附著的子 session 必須自己再發一次。一次根層呼叫只到深度 1。
Ruling: 授權本輪修改 src/main/cdp.ts（原派工禁止碰 src/）—
  這不是 spike 的計數瑕疵而是產品缺陷：agent 看不到巢狀跨站 iframe，正是規格 §7 要求
  「snapshot 必須標出有 N 個 iframe 未附著，寧可讓 agent 知道自己瞎了」要防的情況；
  修在 spike 裡等於讓量測通過而產品仍然瞎 —
  若判斷錯（遞迴 re-arm 有副作用），代價是 Task 6 的 review 結論要重看一次，且可回退為只改 spike 並如實回報 94.1%。
Ruling: 控制端讀錯一處已更正：Turnstile 是 inPage=0/attached=1（偵測器盲），非 1 個 iframe 附著 0 個。
  該站的真正問題是 I1 的分類錯誤，不是覆蓋率 0%。
Task 8: fix round 1 → cfb6fe9。三項重大結果：
  (1) 遞迴 re-arm 有效：accounts.google.com/gsi/button（深度 2 SSO 登入框）attached=true，
      frame tree 的 parentFrameId 直接證實，2000ms 內附著。產品缺陷已修（src/main/cdp.ts）
  (2) 第一輪的 100% 是假象：遞迴 bug 讓分子分母同時隱形互相抵銷。修好後三站變 detector-blind
  (3) 量測方法撞到根本限制：分母用頁面內 DOM 走訪，天生穿不透跨站 iframe 往下查，
      且 contentDocument===null 偵測的是 cross-origin 而非 cross-site
      （Google Maps Embed 與頂層同站不同源，Chromium 不建立獨立 target，量成 0/1=0% 但非真實失敗）
Ruling: 再一輪，把分母改由 CDP frame tree 計算而非頁面內 DOM —
  現行方法無法產出可用數字，規格 §8 的 95% 判準無從評估，而閘門正是這份計畫的目的；
  實作者已在本輪用 Target.getTargets() 的 frame tree 證實深度 2 附著，機制已驗證可用；
  frame tree 能看到巢狀 frame，也能用 eTLD+1 比對區分 site 與 origin，兩個缺陷一次解決 —
  若判斷錯，代價是這一輪白做，退回「方法論不足以評估，但產品缺陷已找到並修復」作為 Spike 3 的結論。
Task 8: fix round 2 → 080cae4。分母改 CDP frame tree + eTLD+1，detector-blind 完全消失，
  三站 16/16 = 100%，深度 1~3 逐層列出（Stripe 深度 3: 2/2），4 次獨立重跑結構一致
Ruling: 接受實作者提出的技術性偏離，**錯的是我的指示** —
  我寫「跟頂層 frame 比 eTLD+1」，但 OOPIF 的建立條件是「frame 的 site 與直接父層不同」而非與頂層不同；
  照我的原文做會讓 Google Identity 深度 2 的 SSO 登入框（accounts.google.com，與頂層同站、
  與直接父層 appspot.com 跨站）從分母消失，而那正是本輪要驗證的核心案例 —
  實作者未默默改而是標出來問，處理正確 —
  若判斷錯，代價是分母偏寬、覆蓋率被低估，方向保守不會造成假 PASS。
Task 8: fix round 2 re-review（opus）= All findings addressed, no new Critical。
  reviewer 自寫獨立探針做「拿掉 re-arm」對照實驗，證明分母含未附著 frame（對照組該站算 1/2），
  並從原始 target 資料重建 16 個 frame 的父子鏈，逐一對上 5/9/2。判定「有條件可信」。
  三個條件：(1) 量的是「已建立 target 的跨站 OOPIF 中附著了多少」，無 target 的不在分母；
  (2) 兩處分母排除規則（eTLD+1 取兩段、URL 無 host 當同站）方向都是縮小分母、抬高覆蓋率，
      三站實際影響為零但文件未寫方向且免責理由舉錯例；(3) 16 個樣本統計上分不出 100% 與略低於 95%
  結論：可做 go/no-go，但要當「無觀察到 miss 的定性證據」而非「已證明 ≥95%」，§8 降級處置必須保留
Ruling: 進 fix round 3，只修文件危害與不可達分支，不再動量測 —
  RESULTS-03 依序含三個判準行（:22 通過、:153 未通過、:223/:235 通過），
  且開頭 banner 指向的「## 修正輪」正好是那個 0%／未通過的章節；
  這份文件是閘門的唯一產物，使用者有很實際的機會讀到錯的那一行 —
  若判斷錯，代價是一輪文件編輯。
Task 8: fix round 3 → 24f33be（文件重排、detector-blind 改真檢查但不接分類、四處事實錯誤、補 6 個 re-arm 測試 45→51）
Task 8: 控制端獨立驗證：RESULTS-03 現行結論在標題後第 5 行含完整表格，被取代章節全數標「已失效」，
  :251 明確改以 reviewer 對照實驗為分母正確的證據而非 detector-blind 是否觸發。測試 51/51。
Task 8: fix round 3/5 re-review = All findings addressed，無新 Critical/Important
  reviewer 做破壞性實驗（移除 src/main/cdp.ts:111-117 的 armAutoAttach 呼叫）：6 個新測試中 3 個失敗
  （:107 子 session re-arm、:129 孫代遞迴、:174 re-arm 失敗記錄），已 git checkout 還原、51/51、工作區乾淨
Task 8: minor (deferred): spikes/probe-oopif.ts:96 註解寫 checkExcludedButAttached()，實際函式名為 findExcludedButAttached()
Task 8: complete (commits 6057b79..24f33be, 3 fix rounds, review clean)

## 最終整支分支審查（opus）
結果：1 Critical、11 Important、10 Minor。完整報告在 final-review.md
C1: src/main/index.ts:84 的 process.cwd() fallback 在 dev/start 下就是 app 自身目錄，
    違反規格 §2.1，session 很可能整場不計入 Insights，且完全靜默
  三個原因疊加導致逐 task 沒抓到：
  (1) Task 1 的測試名叫「cwd 是使用者的專案目錄，不是 app 目錄」且通過 —— 但它自己餵值，
      在 Task 1 的視野裡這條限制看起來有測試保護
  (2) Task 4 有注意到但記成延後項，觸發條件寫「打包後」；規格 §10 明訂 v1 不打包，
      所以延後等於永久豁免。且只想到 Finder 啟動的 /，沒想到 dev/start 下 cwd 就是 app 目錄
  (3) 沒有任何 task 的範圍是「把測試斷言的東西跟產品實際傳的東西對起來看」
Ruling: 控制端自認：這是我寫的計畫的缺陷，而且我在 Task 4 review 時親手把它標成 deferred
  並接受了「打包後才會發生」這個錯誤的觸發條件。同一個模式我在 Task 5 抓到過
  （掃描只檢查「會不會多抓」沒檢查「會不會漏抓」），這次沒有套用。
Ruling: 覆蓋率 80% 這條 Global Constraint 從未被量過（缺 @vitest/coverage-v8，vitest run --coverage 直接失敗），
  且 include 漏了 src/shared/ipc.ts 與 spikes/measure-memory.ts 兩個已有測試的純邏輯模組 —
  這是我寫進計畫卻沒有任何驗證機制的約束，八個 task 都「遵守」了一條沒人量過的規則 —
  併入本次唯一的修正波修掉。
最終修正波: b0f59a7（11 項全修，59 測試，覆蓋率 branches 78.48% 未達 80% 如實回報）
最終 scoped re-review: All findings addressed, no new breakage. 分支可結案
  核心驗證：reviewer 用暫時探針加 Electron 自傳的 --app-path 雙重確認 appDir 在 dev 與 build
  兩條路徑都精確等於專案根目錄，C1 的守衛真正擋得住
