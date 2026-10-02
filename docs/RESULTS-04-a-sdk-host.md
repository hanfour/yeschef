# Plan A 整合驗收結果

量測日期：2026-09-03
機器：macOS 26.6.2、arm64、16 GB
Node / Electron / SDK 版本：Node v24.18.0、Electron 44.0.0、`@anthropic-ai/claude-agent-sdk@0.3.258`（claude CLI 2.1.251／逐字稿記到 2.1.258）
分支與起點：`feat/a-sdk-host`，HEAD `c1958c5`
量測方法：`npm run build` 之後 `YESCHEF_PROJECT_DIR=<目錄> npx electron . --remote-debugging-port=9333`，以 CDP `Runtime.evaluate` 對左窗格操作 DOM（textarea 用原生 setter 加 `input` 事件、按鈕用 `click`），主程序 log 導到檔案後 grep，結果與現象即時記錄

專案目錄一律用兩個拋棄式目錄，不碰任何真實專案：

- `probe-a`＝`/tmp/probe-a`
- `probe-b`＝同一層的 `scratchpad/probe-b`

真的開成 query 並得到回答的次數：15 次。另外 2 次是 F 組故意用無效金鑰讓它拿到 401（沒有回答），1 次在 Task 1 的守衛階段就沒開成 query（B3b），1 次在 idle 狀態被靜默丟棄（A 組之外的意外發現，見待辦第 1 列）。

---

## A. 啟動與守門

### 檢查步驟

1. `npm run build`，確認 `out/preload/bridge.cjs` 存在且非 0 位元組。
2. A1／A2／A2b 各跑一次 `npx electron .`，環境變數依表格設定，看 stderr 與 `echo $?`。因為是直接跑 `npx electron .` 而不是經 npm script，拿到的就是 Electron 自己的 exit code，不必再從 `ELIFECYCLE` 反推。
3. A3 建 `t12/proj-link` 符號連結指向 `probe-b`，用連結路徑啟動、送一則訊息，再看 `~/.claude/projects` 底下哪個目錄被寫到、以及 `.jsonl` 裡的 `cwd`。
4. A4 另外跑一次 `npm run start`（`electron-vite preview`）確認打包後的啟動路徑也開得起來。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| A1 | 不設環境變數 | 印出未設定訊息加三行指示、沒有視窗、exit code 1 | ✓ | stderr 逐字為 `[yeschef] 未設定環境變數 YESCHEF_PROJECT_DIR` 加四行指示；`echo $?` 是 1；沒有任何視窗。守衛在 `createWindow()` 的第一行，`new BaseWindow` 之前就丟出例外。另外會多印一段 `[yeschef] 應用初始化失敗: Error: 未設定環境變數 ...` 的堆疊，那是 `failStartup` 在 `app.exit(1)` 之後刻意 `throw` 被最外層 `.catch` 接到的結果，不是第二個錯誤 |
| A2 | 設成不存在的目錄 `/nope/nope` | 印出 `YESCHEF_PROJECT_DIR 的值不可用：projectDir 不存在：/nope/nope`；exit code 1 | ✓ | 訊息逐字相符；exit code 1；無視窗 |
| A2b | 設成 app 自身目錄 `$PWD` | 印出「不可為 app 自身目錄或其子目錄」與逐字稿會落在被排除路徑的說明；exit code 1 | ✓ | `projectDir 不可為 app 自身目錄或其子目錄：/Users/me/Projects/yeschef` 加「這會讓這場 session 的逐字稿落在被 Insights 排除的路徑下。」；exit code 1；無視窗 |
| A2c（額外） | 設成相對路徑 `../yeschef` | 應被絕對路徑檢查擋下 | ✓ | `projectDir 必須是絕對路徑`；exit code 1。這一列不在簡報的三十九項內，順手補的負面案例 |
| A3 | 用 symlink 路徑啟動並送一則訊息 | `cwd` 是 realpath、檔案落在 realpath 編碼的目錄下 | ✓ | 逐字稿落在 `-private-tmp-claude-501--Users-...-scratchpad-probe-b`，`~/.claude/projects` 底下沒有任何 `proj-link` 字樣的目錄；`.jsonl` 裡 25 筆帶 `cwd` 的列全部是 `/private/tmp/.../scratchpad/probe-b`，等於 `realpath probe-b`。簡報第 347 行的推論成立 |
| A4 | build 後看 `bridge.cjs`，再 `npm run start` | build 成功、`bridge.cjs` 非 0、start 開得起來、左窗格是對話介面 | ✓ | `out/preload/bridge.cjs` 5358 bytes；`npm run start` 印出三段 vite build 與 `starting electron app...`，起 1 個 main 加 2 個 renderer 程序（左對話窗格與右 agent 窗格各一），log 沒有載入失敗。左窗格畫面本身是用同一份 `out/` 產物、以 `npx electron .` 加 CDP 讀 DOM 確認的（`.title-bar`、`.recents-item` 100 列、`.composer-input` 都在），因為 `electron-vite preview` 不接受 `--remote-debugging-port`，會以 `CACError: Unknown option --remoteDebuggingPort` 結束 |

---

## B. Insights 歸屬

### 檢查步驟

1. 事前把 `ls -t ~/.claude/projects` 存成基準（39 個目錄）。
2. B1／B2 用 `YESCHEF_PROJECT_DIR=probe-a` 跑完整場對話，關掉後 `diff` 基準與現況，再對新目錄下的 `.jsonl` 取 `cwd`。
3. B3 維持 `YESCHEF_PROJECT_DIR=probe-a`，在 Recents 點 `probe-b` 的那一場歷史對話，送出一句會寫檔的話，看檔案寫到哪、`.jsonl` 長在哪。
4. B3b 先把 `probe-b` 目錄改名搬走，再啟動、點同一場歷史對話並送出一句。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| B1 | probe-a 完成一則來回對話後比對目錄 | 最上面是 probe-a 路徑的 `/` 換 `-` 版本，底下有剛產生的 `.jsonl` | ✓ | `diff` 只多出兩列，正是 `...scratchpad-probe-a` 與 `...scratchpad-probe-b`，沒有任何其他目錄被寫到；`ls -t` 第一名是 probe-a 的目錄，底下是 `b0ad26fe-4aa2-408a-b42f-29199d95a884.jsonl` |
| B2 | `jq -r .cwd` 對照 `realpath probe-a` | 兩者相等 | ✓ | 該檔所有帶 `cwd` 的列只有一個值 `/tmp/probe-a`，與 `realpath` 逐字相同。註：第一列的 `type` 是 `queue-operation`，沒有 `cwd` 欄位，所以要取「第一筆有 cwd 的列」而不是 `head -1` |
| B3 | probe-a 啟動，resume probe-b 的歷史對話 | 新增的列落在 probe-b 的目錄，`cwd` 是 probe-b 而不是 `YESCHEF_PROJECT_DIR` | ✓ | 三個獨立證據都指向 probe-b：批准卡片顯示的 `file_path` 是 `.../probe-b/b3.txt`；檔案實際建立在 `probe-b/`，`probe-a/` 沒有 `b3.txt`；probe-b 的 `.jsonl` 由 63615 成長到 71448 bytes，新增列的 `cwd` 仍是 probe-b。同時 `window.yeschef.projectDir` 是 probe-a，確認環境變數沒被改掉。裁決 20 的 `cwdOf` 接上了 |
| B3b | 目錄已不存在的歷史對話送出一句 | 對話尾端出現 `.error-card` 含「projectDir 不存在」；輸入框回到可用；主程序沒有未捕捉例外 | ✓ | 錯誤卡片文字：「對話因錯誤結束 無法組出 session options：projectDir 不存在：/private/tmp/.../scratchpad/probe-b」；`session:state` 走 `live` 之後回 `idle`；輸入框 `disabled` 是 false；主程序 log 是一筆 `[yeschef] Error: 無法組出 session options：...`，帶完整 `[cause]` 鏈（Ruling 8 的 `cause` 有效），不是未捕捉例外 |

測試 session 落在 `~/.claude/projects` 的這兩個目錄，沒有其他目錄被寫到：

- `-private-tmp-claude-501--Users-me-Projects-5ea649be-700d-4774-9234-7cbf0fe0ea2e-scratchpad-probe-a`（6 個 `.jsonl`）
- `-private-tmp-claude-501--Users-me-Projects-5ea649be-700d-4774-9234-7cbf0fe0ea2e-scratchpad-probe-b`（1 個 `.jsonl`）

---

## C. 對話流

### 檢查步驟

全部在同一次啟動（`YESCHEF_PROJECT_DIR=probe-a`）裡跑完。串流是否逐字，用兩種取樣互相對照：一是頁面內 `setInterval` 每 40 到 50 毫秒記一次 `.conversation-list` 的 `innerText.length`，二是掛 `MutationObserver` 在每一次 React commit 記一次。後者是必要的，因為 SDK 一則回覆只送十幾筆 `text-delta`，整段在數百毫秒內結束，固定間隔取樣會漏掉中間狀態。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| C1 | 送出「用三段話說明什麼是 CRDT」 | 文字逐字出現，不是整段跳出來，游標在未完成段落尾端 | ✓ | 事件計數：`text-delta` 25 筆加 1 筆完整 `text`，全文 898 字元。`MutationObserver` 版本（C4 的同一場）看到 10 個長度遞增的中間狀態，且 `.markdown-cursor` 在其中 5 到 9 幀存在、完成後消失。不是一次到位 |
| C2 | 送出「把 1 到 200 每個數字寫成一行，格式是 `n = 平方`」 | 內容完整到 200、順序正確、沒有任何一段出現兩次 | ✓ | 為了避免模型改用工具，實際送出的是「直接在回覆裡把 1 到 200 每個數字寫成一行，格式是 n = 平方，不要使用任何工具」。抓出的 `n = n²` 配對 200 組，第一組 `1 = 1`、最後一組 `200 = 40000`，`n` 連續 1 到 200、無重複、平方值全對，`1 = 1` 只出現一次。判準原本寫成 `grep -c "^1 = "`，實際上 markdown 段落會把換行併成空白，所以改用正規表示式抓配對，判準等價。同一份內容經 `text-delta` 與完整 `text` 到達兩次而畫面只有一份，`fold()` 的去重有效 |
| C3 | 承 C2 看 console 與主程序 log | 沒有未捕捉例外；log 沒有批次丟棄之類的訊息 | ✓ | renderer 端 `console` 陣列、`window.onerror`、`unhandledrejection` 全空；整場 run2 的主程序 log 只有一行 `DevTools listening on ws://...`，沒有任何 `[yeschef]` 開頭的記錄 |
| C4 | 送出「寫一段 40 行的 TypeScript 範例」，看串流中途的程式碼區塊 | 未閉合的圍欄在中途也是完整的程式碼區塊，不吃掉後面內容、不整則變純文字 | ✓ | `MutationObserver` 記到 22 次 commit、10 個長度不同的中間狀態（130、312、474、644、825、1012、1180、1373、1512 字元）。每一個中間狀態的 DOM 都已經是 `<pre><code class="hljs language-typescript">`，尾端文字（例如 `};\n\n/** 讀值：只要還有一個 tag 沒被標記，元`）留在程式碼區塊裡；沒有任何一幀出現「內容超過 5000 字元卻沒有 `pre code`」的純文字退回。Task 2 的 `closeIncomplete` 在真實資料上成立 |
| C5 | 送出「跑 `ls -la` 然後告訴我有幾個檔案」，看工具呼叫 | 預設摺疊成一行；展開後看得到未經處理的 stdout，含 `total` 那一行與權限字串 | ✓ | 摺疊時整個區塊只有一行 `Bash 完成 ›`，`.tool-body` 根本不在 DOM 裡；點開後三段標題「參數／結果／原始輸出」，`.tool-stdout` 逐字是 `total 8\ndrwxr-xr-x@   3 me  wheel    96  ...\n-rw-r--r--@   1 me  wheel    10  ... README.md`，`total` 與權限字串都在，沒有被整理過。保留一點：這一次 `ls -la` 完全沒有觸發批准請求，`canUseTool` 沒有被呼叫，工具直接執行完成，所以「批准之後」這個前提沒有成立。批准路徑改用 Write 在 D 組驗（見待辦第 8 列） |
| C6 | 整場對話結束後看尾端 | 出現含花費與輪數的 cost 卡片；沒有 `.error-card`；沒有 unknown 卡片 | ✓ | `.conversation-cost` 顯示「2 輪 · US$0.6871」（換算 `view.cost.turns` 與 `usd`）；整場沒有 `.error-card`。unknown 卡片有一張，依簡報第 135 行這是觀察項不是失敗項，`raw` 整段抄錄如下 |

C6 的 unknown 卡片 `raw`（Write 工具的 `tool_use_result`，契約沒有列舉這個形狀）：

```json
{
  "type": "create",
  "filePath": "/tmp/probe-a/hello.txt",
  "content": "hi\n",
  "structuredPatch": [],
  "originalFile": null,
  "userModified": false
}
```

F1 那一場另外產生 10 張 unknown 卡片，全部是 `system` 的 `api_retry` 子型別，格式一致，抄第一張：

```json
{
  "type": "system",
  "subtype": "api_retry",
  "attempt": 1,
  "max_retries": 10,
  "retry_delay_ms": 576,
  "error_status": 401,
  "error": "authentication_failed",
  "session_id": "90678228-1cda-488d-a470-e6794f000098",
  "uuid": "f491347a-af5f-4322-aac7-c827ae2ee37c"
}
```

---

## D. 批准的四種結局

### 檢查步驟

殘留檢查不用 `ps aux | grep -c "[c]laude"`：執行本次驗收的終端機自己就跑著四到五個 `claude` 程序，基準值會飄。改用精確的比對字串 `pgrep -f "claude-agent-sdk-darwin-arm64/claude"`，那是 SDK 從 `node_modules` spawn 出來的那一個，yeschef 沒開時它必然是 0。

`ls -la` 這類唯讀 Bash 指令在本版 CLI 會被自動批准（見 C5 與待辦第 8 列），所以 D1 到 D6 一律用 Write 觸發：送出「在目前目錄建立 <檔名> 內容 <字串>」。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| D1 | 等批准卡片出現 | 卡片內嵌在該工具呼叫正下方、不是彈窗；優先顯示 `title`，沒有才退回工具名加完整 input；靠 `toolUseId` 掛在對應區塊；輸入框停用 | ✓ | 卡片的 DOM 位置是 `.tool-call > .tool-extra > [data-testid=approval-card]`，`.tool-call` 的三個子節點依序是 `tool-head`／`tool-body`／`tool-extra`；`document.querySelectorAll("dialog, [role=dialog]").length` 是 0，不是彈窗。SDK 這次只給 `displayName: "Write"`、沒有給 `title`，所以卡片走退回路徑，顯示工具名 `Write` 加完整 input 的 JSON，允許鍵標籤是「允許 Write」（裁決 16 的兩條分支都照做了）。批准請求的 `toolUseId` 是 `toolu_01B62Y4kWyryKYmk4D1rh2Za`，對應的 tool block 狀態變成 `awaiting-approval`，另一顆已完成的 Bash block 沒有掛卡片。`.composer-input` 與 `.composer-send` 都 `disabled`。卡片底部有「卡片有焦點時：y 允許、n 拒絕」提示。保留一點：「同名同參數的兩個工具各掛各的」沒有單獨觸發到，需要模型同時發兩顆同名同參數的工具呼叫，本次沒有出現，這一條由 Task 10 的單元測試涵蓋 |
| D2 | 按「允許」 | 卡片消失，工具實際執行，展開看得到結果；輸入框恢復可用 | ✓ | 點下去之後卡片數歸 0，`hello.txt` 的 mtime 是 02:39，晚於送出時間，確認是按允許之後才跑；tool block 進 `done`，展開後「結果」欄是 `File created successfully at: .../probe-a/hello.txt ...`；輸入框 `disabled` 回到 false。Write 沒有 `tool-raw-output` 事件，所以「原始輸出」欄顯示 `尚未收到原始輸出`，這是 `PENDING_RAW_TEXT` 的正常路徑（Bash 才有原始輸出，見 C5） |
| D3 | 再送一次，按「拒絕」 | 工具不執行；留下可見的拒絕記錄；該區塊顯示 `deniedReason`，不是把理由塞在結果欄位裡 | ✗ | 前半成立：`bye.txt` 沒有被建立，模型回「已取消，bye.txt 沒有建立」，輸入框恢復可用，記錄看得見。後半不成立：該 tool block 的 `data-status` 是 `error`、狀態標籤是「失敗」，不是 `denied`；沒有「拒絕原因」欄，理由字串 `使用者拒絕` 出現在「結果」欄與 `.tool-stdout`（`Error: 使用者拒絕`）。事件流裡完全沒有 `permission-denied`，只有 `tool-result` 加 `tool-raw-output`。詳見待辦第 5 列 |
| D4 | 再送一次，放著不動超過 30 秒 | 逾時自動拒絕；卡片消失；區塊顯示含「逾時」與毫秒數的拒絕理由；輸入框解鎖；主程序 log 有記錄 | ✗ | 逾時本身有效：工具沒執行（`timeout.txt` 不存在），理由字串是「批准請求逾時（30000ms 內未收到回覆）」，「逾時」與毫秒數都在，模型也回「批准請求在 30 秒內沒收到回覆而逾時」。三處不符：一、理由跟 D3 一樣落在「結果」欄，區塊是 `error` 不是 `denied`；二、**輸入框沒有解鎖**，卡片消失之後 `.composer-input` 與 `.composer-send` 仍然 `disabled`，再送任何訊息都送不出去，只能切換 session 才解得開，這是本次最嚴重的一項，詳見待辦第 4 列；三、主程序 log 全場只有 `DevTools listening` 一行，逾時沒有留下任何記錄。另外卡片從畫面消失的時間量到 68 秒而不是 30 秒，但那是量測誤差：視窗沒有前景焦點時 renderer 的計時器被瀏覽器節流，頁面內的輪詢跟著變慢，主程序那支 30 秒計時器不受影響（理由字串已經證明它是 30000ms 觸發的） |
| D5 | 卡片還開著時直接關掉視窗 | 主程序數秒內結束；claude 程序回到基準值；log 依序出現 `denyAll(視窗已關閉)`、`interrupt`、`teardown` | ✓（有保留） | 用 CDP 對 browser target 送 `Browser.close`（`osascript` 那條路先試過，`System Events` 取不到 `window 1 of process "Electron"`，回 `-1719` 索引錯誤，依規定不再重試）。關閉前 SDK 的 claude 子程序 1 個，關閉後 1.7 秒內 electron 與該子程序都歸 0，`d5.txt` 沒有被建立（批准確實被 deny 掉）。保留的是 log 那一句：主程序**沒有任何一處記錄這三步**，程式碼裡 `denyAll`／`interrupt`／`teardown` 都不寫 log，所以順序無法從 log 讀出來。可以確認的間接證據是 log 裡沒有 `query 未在 2000 毫秒內結束，強制收尾`（`TEARDOWN_TIMEOUT_MS`）：掛著的 `canUseTool` promise 若沒有先被 `denyAll` 了結，`for await` 迴圈不會在兩秒內結束，那行一定會出現。這正是 Task 8 Step 10 區塊 2 第 3 項要的結論。順序本身由 `tests/session-machine.test.ts` 與 `tests/ipc-bridge.test.ts` 涵蓋。見待辦第 6 列 |
| D6 | 卡片還開著時點另一條歷史對話 | 卡片消失；對話區只剩那條歷史的內容；log 出現 `denyAll(切換 session)` 之後才有 `teardown`；沒有掛著不結束的 promise | ✓（有保留） | 切換前：1 張卡片、1 個 tool block、輸入框停用。點下 probe-b 那一條之後 7.0 秒完成切換，卡片歸 0、tool block 歸 0、輸入框恢復可用；對話區只有 probe-b 那場的兩個 turn（「你 只回答數字：1+1」與「Claude 2」），剛才 live 那一場的 turn 一個都不在（裁決 22 的 `reset` 有效）；標題列與高亮都換成 probe-b；`d6.txt` 沒有被建立。`session:state` 依序是 `live` 然後 `viewing`，沒有卡住。保留點與 D5 相同：log 沒有記錄點，順序讀不出來，但同樣沒有出現強制收尾那一行 |

**依控制端 Ruling 13，D5 與 D6 維持「✓（有保留）」，不改成 ✗。** 理由：預期欄那句「log 依序出現三步」是簡報自己補的證據形式，規格 §3.2 規定的是順序本身，而順序由 `tests/session-machine.test.ts` 與 `tests/ipc-bridge.test.ts` 的純函式測試逐條驗證；本次實測到的可觀察結果（主程序數秒內結束、SDK 子程序歸 0、log 裡沒有 `TEARDOWN_TIMEOUT_MS` 的強制收尾記錄）與規格一致。「主程序沒有收尾記錄點」這件事本身已經記在待辦第 6 列。這是裁決，不是漏驗。

---

## E. Recents 與 session 切換

### 檢查步驟

側邊欄與標題列的狀態一律讀 DOM（`.recents-item`、`.recents-item.is-current`、`aria-current`、`.title-bar`、`.composer-input` 的 `placeholder`），`session:state` 用 `window.yeschef.onSessionState` 收進陣列後一次讀出。點歷史對話全部走 `.recents-item` 的 `click`。真實使用者的歷史對話只點開看，一次都沒有送出輸入；會送輸入的 E3 與 B3 一律用 probe-a／probe-b 自己產生的 session。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| E1 | 啟動後直接看側邊欄 | 最近 100 筆、跨全部專案、最新在最上面、相對時間正常 | ✓ | `listSessions()` 回 100 筆，DOM 也是 100 個 `.recents-item`；100 筆裡有 17 個不同的 `cwd`，包含 `/Users/me/Projects`、`/Users/me/helm` 等不屬於 `YESCHEF_PROJECT_DIR` 的專案；`lastModified` 由新到舊完全單調；相對時間顯示「剛剛」「5 分鐘前」「26 分鐘前」「50 分鐘前」 |
| E2 | 點第二列的歷史對話 | 該筆高亮；重播歷史內容且只有這一場；提示變成「輸入以接續這條對話」；工具展開顯示裁決 4 的文案 | ✓ | 點 probe-a 那一場：`aria-current` 只有 1 個、`.is-current` 落在該列；重播 17 個 turn，第一個是「你 用三段話說明什麼是 CRDT」，前一次檢視的另一場內容全部消失（裁決 22）；placeholder 是「輸入以接續這條對話」；三個 tool block 展開後「原始輸出」欄都是「這是歷史對話，沒有保存原始輸出」，`.tool-stdout` 一個都沒有，不是空白區塊。歷史事件種類：`reset`／`user-text`／`thinking`／`text`／`tool-use`／`tool-result`／`session-end`，共 26 筆 |
| E3 | 承 E2，viewing 狀態送出一句 | 進 live 並接續；新回答接在歷史後面不清空；log 顯示 `start-query` 帶 `resume` | ✓（有保留） | 送出「只回答數字：2+2」，turn 由 17 變 18，第一個 turn 仍是 CRDT 那則，最後一個是「Claude 4」；這一批事件裡沒有 `reset`（裁決 22：resume 不推 reset）；`session:state` 變成 `{"kind":"live","sessionId":"b0ad26fe-..."}`。log 那一句無法驗證，主程序沒有記錄 `start-query`，改用逐字稿佐證：resume 之後寫的是**同一個** `.jsonl`（`b0ad26fe-...jsonl` 由 150867 成長到 166084 bytes），沒有新開檔案，確認 `resume` 有帶到 |
| E4 | 點歷史進 viewing 後按「開新對話」 | 畫面清空；提示回到全新對話；Recents 取消選取 | ✓ | 按下之後只推一筆 `reset` 事件，`.conversation-list` 的文字歸零、turn 歸零；placeholder 回到「輸入訊息，Enter 送出，Shift+Enter 換行」；`aria-current` 的數量是 0；標題列回到 probe-a |
| E5 | 開新對話問一句等它答完，看側邊欄 | Recents 回到未選中；`session:state` 最後收到 `idle`；對話內容留在畫面上 | ✗ | 兩項成立：Recents 沒有任何一列被選中（全新 live 沒有 `sessionId`，`currentSessionId` 回 `undefined`），回答與 cost 卡片留在畫面上沒有被清掉。一項不成立：`session:state` 最後收到的是 `{"kind":"live"}`，`idle` 一直沒有來。原因是 streaming input 模式下 SDK 的 `for await` 迭代器在 `result` 之後不會結束（還等著下一則輸入），`finishNaturally` 不會被呼叫，`session-ended` 這個 action 就永遠不送。規格 §7 畫的 `live ──結束或關閉──▶ idle` 只有在事件流出錯（見 F3）或視窗關閉時才會走到。詳見待辦第 3 列 |
| E6 | 重新載入或等清單刷新 | 剛才那一場出現在清單第一列 | ✓ | 下一次啟動後 `listSessions()` 第一筆就是 `b0ad26fe-...`，摘要是最後一則提示「在目前目錄建立 bye.txt 內容 bye」，`cwd` 是 probe-a；DOM 第一列顯示「在目前目錄建立 bye.txt 內容 bye 剛剛 HEAD」 |
| E7 | 看標題列在 idle／viewing／開新對話三種情況 | idle 顯示 `YESCHEF_PROJECT_DIR`；viewing 顯示該場的 `cwd`；按開新對話換回；沒有 `cwd` 時顯示「目錄不明」 | ✓ | 啟動時標題列逐字是 `.../scratchpad/probe-a`，`window.yeschef.projectDir` 同值（裁決 21 的 `additionalArguments` 這條路在沙箱 preload 下有效，沒有落到空字串的退路）；點 probe-b 那一場之後標題列變成 `.../scratchpad/probe-b`；按「開新對話」之後回到 probe-a。第四種情況也驗到了：100 筆裡有 11 筆沒有 `cwd`，點其中一筆（`aa9c49c1-...`）之後標題列顯示「目錄不明」 |
| E8 | 一秒內連點兩條不同的歷史對話 | 最終是 B 的內容、沒有 A 的殘留；高亮與標題列都對應 B；最後一次 `session:state` 是 B 的 `viewing` | ✓ | 先點索引 1（A，一場 turn 很多的真實對話），間隔 120 毫秒再點索引 0（B，probe-b 那場兩個 turn 的）。`session:state` 依點擊順序收到兩筆 `viewing`，最後一筆是 B 的 `sessionId`；畫面最終只有 B 的兩個 turn，A 的內容一個字都不在；`.is-current` 與 `aria-current` 都在 B；標題列是 probe-b 的路徑。裁決 23 的 `pending` 鏈有效 |

---

## F. 錯誤卡片

### 檢查步驟

F1 的無效金鑰只透過 Electron 子程序的環境變數 `ANTHROPIC_API_KEY=sk-ant-invalid-000` 設定，沒有動 keychain、沒有動 `~/.claude` 底下任何設定檔、沒有跑 `security` 指令。

F3 原本寫的是關 Wi-Fi。實際改成殺掉 SDK spawn 出來的 claude 子程序（`kill -9 $(pgrep -f "claude-agent-sdk-darwin-arm64/claude")`），理由有二：關掉整台機器的網路會影響操作者本身；而裁決 17 第 3 點要驗的是「`for await` 迭代器 throw 時走不走同一條 events 通道」，殺子程序比斷網更直接命中那個路徑。這一項的判準與現象都照實記錄，替代做法寫在這裡供審查判斷。

### 結果表

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| F1 | 無效金鑰啟動後送一則訊息 | 尾端出現 `.error-card`，含「對話因錯誤結束」與具體錯誤訊息；有 `api_error_status` 也要看得到 | ✗ | 卡片有出現，不是空白的一張：`<p class="error-title">對話因錯誤結束</p><p class="error-status">API 狀態：401</p>`，`api_error_status` 看得到。不成立的是「具體的錯誤訊息」：`view.error.message` 是 `undefined`，卡片裡沒有 `.error-message` 這一段。具體字串 `Failed to authenticate. API Error: 401 API key is invalid.` 是以一般助理回覆的 turn 出現在對話裡，不在卡片上。把 DevTools 關掉只看畫面仍然看得出出了錯（卡片加那則回覆），所以不是「只有 console 裡一行紅字」，但卡片本身少了訊息欄。詳見待辦第 7 列。附帶產生 10 張 `system/api_retry` 的 unknown 卡片（raw 見 C 組） |
| F2 | 承 F1 看輸入框與側邊欄 | 輸入框回到可用；狀態回 `idle` 後 `.error-card` 仍留著；可以再送下一則而不必重開 | ✓（有保留） | 輸入框 `disabled` 是 false，不是永遠停用也不是永遠轉圈；再送一則「只回答數字：2+2」送得出去，不必重開 app；`.error-card` 只有一張、內容不變，沒有被清掉。保留點同 E5：狀態沒有回到 `idle`（一直是 `live`），所以「狀態回到 idle 之後卡片仍留著」這個前提在本次沒有成立，卡片留著這件事本身成立 |
| F3 | 串流中途中斷事件流 | 尾端一樣出現 `.error-card`；主程序 log 有錯誤記錄；沒有殘留的 claude 程序 | ✓ | 送出「用五段話說明 Raft 共識演算法」，串流到 5 筆事件時殺掉子程序。卡片文字是「對話因錯誤結束 Claude Code process terminated by signal SIGKILL」，畫面沒有停在還在想的樣子；事件序列最後一筆是合成的 `session-end`；`session:state` 由 `live` 回到 `idle`（這是本次唯一自然走到 idle 的路徑）；輸入框可用；主程序 log 有 `[yeschef] Error: SDK 事件流中斷：Claude Code process terminated by signal SIGKILL`，帶完整 `[cause]`（`errorClass: 'process_killed_by_signal'`）；`pgrep` 殘留 0 個。裁決 17 第 3 點完全照做 |

---

## G. 記憶體

### 量測步驟

照 `docs/RESULTS-01-memory.md` 的「量測步驟」跑，兩處與原文不同，都記在這裡：

1. 第 4 步「在左格執行 claude 並送出問題」改成「在左格的輸入框送出一個會產生長輸出的問題，等它答完」，這是簡報第 220 行指定的替換。實際送出的是「用五段話說明什麼是 Raft 共識演算法」，回覆 1580 字元，花費 US$0.2352。
2. 啟動方式用 `npx electron .`（`npm run build` 的產物）而不是 `npm run start`。理由是本次驗收全程以 CDP 驅動，而 `electron-vite preview` 不接受 `--remote-debugging-port`。副作用是程序樹裡沒有 `electron-vite`，所以「其中 electron-vite」那一列必然是 0，反過來說 `yeschef` 那一列本身就已經是「扣除 electron-vite」的數字。

`GROUPS` 沒有改動：`yeschef` 那一列不是 0 MB，簡報第 230 行的修改條件沒有成立，本 task 因此沒有動 `spikes/measure-memory.ts`。

### 量測結果

| 組別 | Spike 1 | 本次 | 變化 |
|---|---|---|---|
| 基準線 iTerm2 | 未量（`RESULTS-01` 表格是空的） | 238 MB（6 個程序） | 無法比較 |
| 基準線 Chrome（chrome-devtools-mcp profile） | 未量 | 0 MB（0 個程序） | 無法比較 |
| 基準線合計 | 未量 | 238 MB | 無法比較 |
| yeschef 全部程序（含 dev 工具） | 未量 | 880 MB（8 個程序） | 無法比較 |
| 其中 electron-vite（dev 專用，打包後不存在） | 未量 | 0 MB（0 個程序） | 無法比較 |
| claude CLI（兩種情境相同，不計入差額） | 未量 | 1408 MB（4 個程序） | 無法比較 |
| **淨變化（含 dev 工具鏈）** | 未量 | **880 MB** | 無法比較 |
| **淨變化（扣除 electron-vite，推估打包後的實際佔用）** | 未量 | **880 MB** | 無法比較 |

三個必須跟著數字一起看的說明：

- 兩個「基準線」列不是簡報 G1 要的那組基準線。G1 要的是「人為開一個 iTerm2 跑 claude、另開一個 chrome-devtools-mcp 的 Chrome」的對照組，本次沒有做（見下表 G1）。這兩列是本機當下的環境值：iTerm2 是操作者原本就開著的，Chrome 那一列是 0 因為沒有用那個 profile 開過 Chrome。
- `yeschef` 那一列的 880 MB **包含** SDK spawn 出來的 claude 子程序（單獨 285 MB）。`GROUPS` 的 `yeschef` 是 substr 比對，而那個二進位檔的路徑是 `.../yeschef/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`，字串裡就有 `yeschef`。扣掉它，Electron 本身約 595 MB（main 223 MB、兩個 renderer 124 MB 與 93 MB、兩個 helper 66 MB 與 52 MB、node 包裝 47 MB）。
- `claude CLI` 那一列 1408 MB／4 個程序幾乎全部是執行本次驗收的操作者自己那個 Claude Code session，不是 yeschef 開出來的。yeschef 未啟動時量到的同一列是 1412 MB／4 個程序，兩次幾乎相同，可以據此判斷 yeschef 對這一列沒有貢獻。

| # | 操作 | 預期 | 結果 | 現象 |
|---|---|---|---|---|
| G1 | 基準線量測（iTerm2 跑 claude 加另一個 Chrome） | 兩列都非 0 MB 且程序數 > 1 | 未執行（需人工） | 需要真人在桌面開 iTerm2 跑 `claude`、另外開一個用 `chrome-devtools-mcp/chrome-profile` 的 Chrome 並導到指定 URL。CDP 只能驅動已經起來的 yeschef，起不了這兩個程式；`osascript` 這條路在本機也走不通（`System Events` 取不到 Electron 的視窗，回 -1719，判斷是輔助使用權限未開）。不偽造數字 |
| G2 | yeschef 量測 | 「claude CLI」與「yeschef」兩列都非 0 MB 且程序數 > 1 | ✓ | yeschef 880 MB／8 個程序，claude CLI 1408 MB／4 個程序，兩列都非 0 且程序數大於 1，健全性檢查通過。`ps -Ao rss,comm,command \| grep -i yeschef` 抽查列出的程序與 8 這個數字對得上 |
| G3 | 與 `RESULTS-01` 同名列並排 | 兩份表格列名一致，看得出哪一列變大、變多少 | ✓（有保留） | 列名逐字照 `RESULTS-01` 的八列排好，本次的數字全部填上。變化欄填不了：`docs/RESULTS-01-memory.md` 的量測結果表至今仍是 `___ MB` 的空白範本，Spike 1 沒有留下任何數字可以對照。這一點本身就是要記下來的結論 |

判準依規格 §2.3：記憶體先不設限，本組只記數字與健全性檢查，不設通過門檻。

---

## H. 收尾檢查

### H1 `grep -rn "pty:\|node-pty\|xterm" src/ tests/ spikes/ package.json electron.vite.config.ts`

```
tests/fixtures/markdown/real-doc.md:13:| §4 架構 | 左窗格 xterm.js 加 node-pty 跑 `claude` CLI | 主程序用 Agent SDK 的 `query()` 宿主 agent，renderer 渲染事件 |
tests/fixtures/markdown/real-doc.md:221:| `src/renderer/terminal.ts`（xterm.js） | 作廢。換成對話渲染器 |
tests/fixtures/markdown/real-doc.md:224:| Spike 1 的記憶體量測 | 待重量。xterm.js 換成渲染器，數字會變 |
```

結果 ✓。三筆命中都在 `tests/fixtures/markdown/real-doc.md`，那是 Task 2 拿本專案規格全文當串流 markdown 測試素材的 fixture，命中的是文件內文，跟 `docs/` 底下的歷史紀錄同一類，不是程式碼也不是相依。`src/`、`spikes/`、`package.json`、`electron.vite.config.ts` 全部零命中；`package.json` 的 `allowScripts` 只剩 `esbuild@0.25.12`、`esbuild@0.28.2`、`fsevents@2.3.3`，`node-pty@1.1.0` 那一行不在了。

### H2 `grep -rn "session:open\|openSession\|SessionStateName\|parseSessionOpen" src/ tests/`

```
（無輸出，exit code 1）
```

結果 ✓。

### H3 `npm test`

```
 Test Files  22 passed (22)
      Tests  441 passed (441)
   Start at  02:22:57
   Duration  2.04s (transform 894ms, setup 0ms, import 3.02s, tests 2.87s, environment 4.48s)
```

結果 ✓。441 條、22 個檔案全綠。各 task 報告寫的舊數字（181、184 等）是當時的中間值，現況以這裡為準。

補充的覆蓋率抽查（`npm run test:coverage`，不列入八組計數）：

```
 src/main           |   90.77 |    79.79 |   95.41 |   92.77 |
  agent-host.ts     |   91.09 |    80.76 |   95.12 |   93.29 |
  ipc-bridge.ts     |   85.49 |    73.17 |   90.62 |   89.65 |
 src/shared         |   93.38 |    86.44 |     100 |   97.78 |
  fold.ts           |   95.79 |    88.46 |     100 |   95.95 |
All files           |   93.02 |    84.76 |   98.03 |   95.68 |
```

三支指定檔案的行覆蓋率分別是 93.29%、89.65%、95.95%，都在 80% 以上。

### H4 `npm run typecheck`

```
> yeschef@1.0.0 typecheck
> tsc --noEmit
（無輸出）
exit=0
```

結果 ✓，0 error。

### H5 `find src -name '*.ts' -o -name '*.tsx' | xargs wc -l | sort -rn | head -20`

```
    4167 total
     543 src/main/agent-host.ts
     541 src/shared/fold.ts
     434 src/shared/events.ts
     305 src/main/ipc-bridge.ts
     223 src/shared/ipc.ts
     184 src/main/index.ts
     176 src/main/approval.ts
     167 src/main/cdp.ts
     136 src/renderer/App.tsx
     132 src/main/session-machine.ts
     131 src/main/session-store.ts
     107 src/renderer/approvals.ts
     106 src/renderer/components/ToolCall.tsx
      97 src/renderer/components/Markdown.tsx
      92 src/renderer/components/ApprovalCard.tsx
      91 src/preload/bridge.ts
      79 src/renderer/components/Turn.tsx
      70 src/main/session-args.ts
      66 src/renderer/hooks/useSessions.ts
```

結果 ✓。最長的 `src/main/agent-host.ts` 543 行，離 800 行還有距離，沒有需要記進待辦的檔案。

---

## 本 task 做掉的修正

| 檔案 | 改了幾行 | 為什麼 | 對應的測試 | 突變驗證 |
|---|---|---|---|---|
| （無） | 0 | 下面九筆全部至少踩到 Step 9 三條判準的其中一條，沒有一筆三條同時成立 | | |

`git diff --stat` 只有一個檔案：

```
 docs/RESULTS-04-a-sdk-host.md | 347 ++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 347 insertions(+)
```

最接近可以動手的是待辦第 4 列（批准逾時之後輸入框永久停用）。它的修正確實在 20 行以內、也寫得出紅轉綠的單元測試，但卡在第二條：`CONTRACT.md` 第 527 行把這件事寫死成「Task 10 接手 9B 留下的 `Composer` `disabled` prop：`pending.length > 0` 時輸入框停用（規格 §6）」。要修就得改掉這句契約，那是介面改動，依判準不在本 task 做。

## 待辦

| 現象 | 推測原因 | 建議歸屬的 task |
|---|---|---|
| 1. 剛啟動（`session:state` 是 `idle`）時在輸入框打字並按送出，畫面沒有任何變化：`onEvents` 一筆都沒收到、輸入框的文字被清空、對話區空白、主程序 log 一行都沒有。要先按「新對話」才送得出去 | 推測是 `session-machine.ts` 的 `fromIdle` 把 `user-input` 定義成不合法轉移（回原狀態、零 effect），`ipc-bridge.ts` 的 `onUserInput` 又對非 live 直接 `return`，兩邊都不留記錄，於是變成靜默丟棄。這是刻意的設計（`tests/session-machine.test.ts` 第 23 行明寫「user-input 在 idle 是不合法轉移」、規格 §7 的圖也是 `idle ──開新對話──▶ live`），但 idle 的 placeholder 顯示的是「輸入訊息，Enter 送出」，UI 沒有把「要先開新對話」講出來 | Task 5 加 Task 9B。要嘛 `fromIdle` 的 `user-input` 直接產 `start-query`（帶 `initialInput`），要嘛 idle 時把輸入框停用或換提示文字。前者比較符合使用者預期，但會動到狀態機的契約，需要先裁決 |
| 2. live 對話中送出的訊息，自己那一則不會出現在對話區。同一場對話用 Recents 點回去看，使用者的 turn 就都在（E2 的第一個 turn 是「你 用三段話說明什麼是 CRDT」） | 推測是 SDK 在 streaming input 模式下不會把我們送進去的 `UserTurn` 回送成 `user` 訊息，所以 `normalizeLive` 產不出 `user-text` 事件；`normalizeHistory` 讀 `getSessionMessages` 時才看得到那些列。`fold.ts` 與 `Turn.tsx` 都已經有 `role: 'user'` 的路徑（`ROLE_LABEL` 有「你」），缺的是事件來源 | Task 8。`agent-host.ts` 的 `send()`／`start()` 在把文字推進 `InputQueue` 的同時，補推一筆 `{ kind: 'user-text', text }` 進 `onBatch` 最直接，且不必動 fold 與 renderer |
| 3. 一場對話答完之後 `session:state` 停在 `live`，`idle` 一直不來（E5）。連帶效果是 SDK spawn 的 claude 子程序在整個 app 生命週期都活著（`pgrep` 從對話結束到關視窗都是 1） | 推測是 streaming input 模式下 `query()` 的 async iterator 在 `result` 訊息之後不會結束（它還在等下一則輸入），所以 `agent-host.ts` 的 `pump()` 不會走到 `finishNaturally`，`onEnded` 不呼叫，`session-ended` 這個 action 就不會送。規格 §7 的 `live ──結束或關閉──▶ idle` 目前只有兩條路走得到：事件流出錯（F3 驗到了）與關視窗 | Task 5 加 Task 8。需要先裁決 `live` 的語意：是「有活躍 query」還是「agent 正在做事」。若採後者，`session-end` 事件本身就該推一個 action；若採前者，規格 §7 的圖要改，E5 的判準跟著改 |
| 4. 批准卡片放著不回答滿 30 秒之後，主程序照約定 deny 掉了（工具沒執行、理由字串是「批准請求逾時（30000ms 內未收到回覆）」），卡片也從畫面上消失，但 `.composer-input` 與 `.composer-send` 仍然 `disabled`，之後在同一場 live 對話裡再也送不出任何訊息，只有切到別的 session 才解得開 | 推測是 `useApprovals` 的 `pending` 只有兩個清空來源：使用者按按鈕後的 `reply()`，以及 `session:state` 離開 `live`。逾時是在主程序 `approval.ts` 的計時器裡了結的，renderer 收不到任何通知，`pending` 就一直留著那一筆；卡片之所以消失是因為 tool block 進了終態、`findAskForBlock` 不再回傳它，但 `App.tsx` 的 `disabled={pending.length > 0}` 看的是另一個數字 | Task 6 加 Task 8 加 Task 10。乾淨的做法是主程序在 `settle()` 時多送一則「這筆請求已了結」給 renderer（新頻道，屬介面改動）；退而求其次是把 `disabled` 改成「畫面上真的還有卡片」，但那要一併改掉 `CONTRACT.md` 第 527 行寫死的 `pending.length > 0` |
| 5. 使用者按「拒絕」或批准逾時之後，該工具區塊的 `data-status` 是 `error`、狀態標籤是「失敗」，沒有「拒絕原因」欄；理由字串（`使用者拒絕`／`批准請求逾時（30000ms 內未收到回覆）`）出現在「結果」欄與 `.tool-stdout` 的 `Error: ...` 裡。事件流裡沒有出現過任何一筆 `permission-denied` | 推測是 `canUseTool` 回 `{ behavior: 'deny', message }` 之後，SDK 把它當成一個 `is_error` 的 `tool_result` 送回來，不另外發 `system/permission_denied`。`events.ts` 第 276 行那條 `subtype === 'permission_denied'` 的路徑是照 `-p` CLI 的事件流寫的（fixture 02 就是那條路徑錄的），走 SDK 的 `canUseTool` 時碰不到，於是 `fold.ts` 的 `denied` 狀態與 `deniedReason`（裁決 12）在真實運作中是死路 | Task 4B 加 Task 8。可行的做法是主程序在 deny 時自己合成一筆 `permission-denied` 事件（`toolUseId` 已經有了，裁決 28），讓 fold 走既有的 `denied` 分支；改動同時跨越正規化層與宿主，不是 20 行以內的事 |
| 6. D5、D6、E3、B3 的判準都寫「主程序 log 出現 …」，但主程序從頭到尾只印 `DevTools listening` 一行。`denyAll`／`interrupt`／`teardown`／`start-query` 四處都沒有記錄點，只有 `logError` 這一條路會輸出 | 推測是 Task 5 把收尾順序做成 effects 陣列時，只保證「順序集中在一處且可測」，沒有一併加上執行時的記錄。順序目前只驗得到單元測試那一層（`tests/session-machine.test.ts`、`tests/ipc-bridge.test.ts`），整合層拿不到證據。間接證據是 log 裡從來沒有出現 `query 未在 2000 毫秒內結束，強制收尾`，那表示 `denyAll` 確實排在 `teardown` 前面 | Task 8。在 `ipc-bridge.ts` 的 `runEffect` 開頭加一行 `console.log('[yeschef] effect', effect.kind, ...)` 就能讓 D5／D6 的判準變成可驗證的。這是新增行為（會多出 log 輸出），不是修 bug，交由後續 task 判斷要不要做 |
| 7. 無效金鑰時 `.error-card` 只畫出「對話因錯誤結束」與「API 狀態：401」，沒有 `.error-message` 那一段；具體字串 `Failed to authenticate. API Error: 401 API key is invalid.` 是以一般助理回覆的 turn 出現在對話裡 | 推測是 `fold()` 在處理 `session-end { isError: true }` 時只把 `apiErrorStatus` 填進 `view.error`，`message` 沒有從 `result` 事件的哪個欄位取到值（`errorMessage` 是 `undefined`）。規格 §8 那一列寫的是「`result` 事件的 `is_error`、`errors` 與 `api_error_status` 渲染成錯誤卡片」，`errors` 這個欄位可能在本版 SDK 換了名字或位置 | Task 3 加 Task 4B。要先錄一份 401 情境的真實事件流當 fixture，確認 `result` 訊息裡具體訊息放在哪個欄位，再補上 `errorMessage` 的取值 |
| 8. 送出「跑 `ls -la` 然後告訴我有幾個檔案」時 `canUseTool` 完全沒有被呼叫，Bash 工具直接執行完成（tool block 由 `streaming-input` 一路到 `done`，沒有 `awaiting-approval` 這一段）。同一個 app、同一個 `permissionMode: 'default'` 之下，Write 每一次都會問 | 推測是本版 claude CLI（2.1.251）對它判定為唯讀的 Bash 指令有內建的自動批准，那一層在 `canUseTool` 之前。影響到的是規格 §6 對「哪些工具會問」的預期，以及簡報 C5 把「批准之後」當成前提這件事 | 沒有歸屬的 task，屬於要記進規格的 SDK 事實。建議寫進規格 §1 的已查證事實表，並把日後所有批准相關的手動檢查一律改用 Write 這類會問的工具 |
| 9. 一場正常對話會產生契約沒有列舉的事件：Write 完成後的 `tool_use_result` 是 `{type:"create", filePath, content, structuredPatch, originalFile, userModified}`，畫成一張 unknown 卡片；401 情境會連續產生 10 張 `system/api_retry` 的 unknown 卡片（raw 全文在 C 組） | 推測是裁決 1 窮舉五類事件時用的樣本沒有涵蓋 Write 的結果形狀與 API 重試事件。依簡報第 135 行這不算 bug，unknown 卡片本來就是「不靜默丟棄」的設計，但連續 10 張重試卡片夾在對話裡會蓋掉真正的內容 | Task 3。把這兩種形狀補進 `events.ts` 的正規化：`tool_use_result` 的 create／edit 形狀併進 `tool-raw-output` 或另設一種事件，`api_retry` 可以考慮折疊成一行而不是十張卡片 |

第 1、2、4、9 列在 Task 12B 修正（見 git log 2026-09-03 以 `fix:` 開頭的五個 commit）；第 3、5、6、7 列需介面或設計變更，留後續 task，已記入規格 §12。第 8 列是 SDK 與 CLI 的行為事實不是缺陷，維持原樣。

## 判準

- A 到 F、H 兩組：全部 ✓ 才算通過。任何一項 ✗ 且未在本 task 修掉，必須出現在待辦
- G 組：只記數字與健全性檢查，不設通過門檻（規格 §2.3：記憶體先不設限）
- 三十九項的完成度：**34 / 39 通過**

分項統計。分母是簡報定義的三十九個原始項目：A 5、B 3、C 6、D 6、E 8、F 3、G 3、H 5。B 組的標題寫「3 項加 1 個負面案例」，`B3b` 是那個負面案例，不在三十九裡；`A2c` 是本次順手補的負面案例，也不在三十九裡。兩者一起列在補充列。

| 組別 | 原始項目 | ✓ | ✗ | 未執行 |
|---|---:|---:|---:|---:|
| A 啟動與守門 | 5 | 5 | 0 | 0 |
| B Insights 歸屬 | 3 | 3 | 0 | 0 |
| C 對話流 | 6 | 6 | 0 | 0 |
| D 批准的四種結局 | 6 | 4 | 2 | 0 |
| E Recents 與 session 切換 | 8 | 7 | 1 | 0 |
| F 錯誤卡片 | 3 | 2 | 1 | 0 |
| G 記憶體 | 3 | 2 | 0 | 1 |
| H 收尾檢查 | 5 | 5 | 0 | 0 |
| 合計 | 39 | 34 | 4 | 1 |

補充列（不計入 39）：`A2c` 與 `B3b` 共 2 列，皆 ✓。連同補充列，結果表實際有 40 列、36 個 ✓。

39 − 4 − 1 = 34。四項 ✗ 是 D3、D4、E5、F1，一項未執行是 G1（需人工，理由寫在 G 組表格裡）。四項全部進了待辦，沒有一項被漏掉。另外 D5、D6、E3、F2、G3 標的是「✓（有保留）」，計入 ✓，保留的內容各自寫在現象欄，主要集中在「主程序沒有 log 記錄點」（待辦第 6 列）與「狀態不回 idle」（待辦第 3 列）這兩件事上。
