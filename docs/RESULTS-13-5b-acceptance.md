# 子專案 5b 的實機驗收

量測日期:2026-09-10
機器:macOS 26.6.2(Darwin 25.6.0)、arm64、16 GB
Node 24.18.0 / Electron 44.0.0 / codex-cli 0.153.4
版本:分支 `5b-codex-adapter`

## 0. 範圍

規格 `docs/specs/2026-09-09-yeschef-5b-codex-adapter-design.md` §8 列的六項。
單元測試在驗收前已全綠(64 檔 1372 條、Stmts 93.2 / Branch 87.84)。

操作方式沿用 RESULTS-12:`npx electron . --remote-debugging-port=9334 --user-data-dir=<fixture>`,
用 CDP 連上 renderer。協定層另外寫了一支獨立探針直接對 `codex app-server` 說話,
用來把「yeschef 的錯」與「協定的事實」分開。

## 1. 六項結果

| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| 1 | 開 codex 對話,送一則要它跑 `ls` | 通過(修兩個缺陷後) | 兩個 Bash tool block 都「完成」,模型答出檔案數;`~/.codex/sessions` 多一個 thread |
| 2 | 要它改一個檔案 | 通過(修一個缺陷後) | 出 Edit 的批准卡,允許後 `note.txt` 內容真的變成 `CODEX-WAS-HERE` |
| 3 | 切到別的對話再切回 | 通過 | 背景時 `codex app-server` 行程數 2 → 0;切回後 pane 內容與 tool block 數與切走前相同 |
| 4 | app 重啟後在 codex 對話送第二則 | 通過 | 重啟後畫面是空的(規格預期),送第二則走 `thread/resume`,codex 答得出重啟前種下的代號 `MELON-8842` |
| 5 | 回合進行中中斷 | 通過 | 按輸入框旁的「新對話」:`turn/interrupt` 送出、畫面出現「回合已中斷」、子程序 2.3 秒內收掉;關分頁也可以,會先問「回合進行中，確定關閉？」 |
| 6 | 未登入 | 通過(修一個缺陷後) | 把 `~/.codex/auth.json` 改名後,畫面是「codex 未登入,請在終端執行 `codex login`(unexpected status 401 …)」;還原後正常 |

## 2. 驗收抓到的五個缺陷

單元測試 1372 條全綠、覆蓋率過門檻、六輪 Claude 審查(含一輪 opus 全分支審查)都沒有抓到這五個。

### 2.1 codex 的每個工具呼叫都畫成「未知事件」

`fold.ts:509` 對沒有 `messageId` 的 `tool-use` 一律走 `applyUnknown`,而 mapper 產生的
`tool-use` 沒有帶 `messageId`。結果:codex 每一次工具呼叫在畫面上都是可展開的「未知事件」,
批准卡因為找不到對應的 tool block,顯示成「這個請求還沒對應到畫面上的工具呼叫」掛在對話尾端。

mapper 的單元測試驗的是 `Event` 的形狀,那個形狀本身沒有錯;錯的是它與 fold 之間的契約。
修法是補 `messageId: id, index: 0`,並加一條「餵進 fold 之後真的是 tool block」的跨層測試。

### 2.2 codex 在唯讀沙箱裡,檔案編輯連問都不問就被拒

`thread/start` 不指定 `sandbox` 時,codex 用預設值 `read-only`(探針從 `thread/start` 的回應讀到
`{ type: 'readOnly', networkAccess: false }`)。實機表現是 codex 直接回「目前環境為唯讀,
無法用檔案編輯工具修改」,不送批准請求。規格 §5 的參數表沒有列 `sandbox`。

`SandboxMode` 有三個值:`read-only`、`workspace-write`、`danger-full-access`。改用 `workspace-write`:
寫入限工作區內,工作區以外與破壞性的動作仍由 `approvalPolicy: 'untrusted'` 送批准請求過來。

### 2.3 未登入時走的不是 `thread/start`

規格 §6 假設未登入會讓 `thread/start` 回錯。實際上 handshake 照樣成功,是後面的 turn 向 API
要資料時才收到 401,錯誤從 `turn/completed` 的 `turn.error.message` 來。所以
`startFailureMessage`(只處理 `start()` 失敗)永遠碰不到這個情況,使用者看到的是上游原文,
沒有任何可行動的提示。判斷改放在 mapper,兩條路共用同一份。

### 2.4 codex 分頁沒有停止或開新對話的入口

規格 §8 第 5 項寫「回合進行中按停止」,但 yeschef 沒有獨立的停止按鈕:Claude 那邊的中斷
是由「開新對話」與「開啟歷史對話」觸發的,而那兩個按鈕在 Recents 側欄裡。5b 讓 codex 分頁
不畫 Recents(那份清單是 Claude 的 session),連帶把這兩個入口也拿掉了。發現當下,codex 對話
能中斷回合的唯一操作是關掉分頁,而那會丟掉對話內容。

補法是在輸入框那一列給 codex 分頁一顆「新對話」(文案與 Recents 裡那顆一致),不為了一顆按鈕
重開一個 280 px 的側欄。實機驗:回合進行中按它,`turn/interrupt` 送出、畫面出現「回合已中斷」、
子程序 2.3 秒內收掉、分頁保留。

### 2.5 換新對話之後,舊回合的中斷訊息落進新對話

補上按鈕之後才看得到:按「新對話」時 `startNew()` 同步清空 log 並推 `RESET`,而中斷造成的
`turn/completed`(status `interrupted`)在那之後才到,於是新的空對話開頭就掛著
「對話因錯誤結束 回合已中斷」。

修法是給每個 client 一個世代編號,`startNew()` 換代,舊 client 之後才到的事件一律丟掉。

## 3. 協定的三個事實(獨立探針量到)

探針直接起 `codex app-server`,用 yeschef 送的同一組參數,記下每一則 server → client 的訊息。

- `item/commandExecution/requestApproval` 這個方法名與時機都成立:`approvalPolicy: 'untrusted'`
  下 codex 會送它,回 `{ decision: 'accept' }` 指令就執行,`turn/completed` 是 `completed`。
  這兩個方法名原本只從 schema 的檔名推出來,沒有實跑過。
- 不回覆或回錯誤時,codex 的 stderr 記 `Rejected("rejected by user")`,turn 照常結束。
  也就是「認不得的請求一定要回覆」這條防線的失效模式是安全的:不會掛住,只會被當成拒絕。
- `thread/start` 不指定 `sandbox` 的預設值是 `{ type: 'readOnly', networkAccess: false }`。

## 4. 量測方法上的一個教訓

第 2 項與第 5 項各判錯一次,兩次都是同一個原因:拿畫面上的東西當「回合結束」的訊號。

第一次用「文字長度連續 6 秒沒變」,模型在 thinking 階段不動 DOM,提早觸發(RESULTS-12 記過)。
第二次改用「文字裡出現 token 統計」,但那個統計是整場對話的 footer,一直在尾端,
第二則訊息送出後立刻就「看到」它。

第三次才對:注入一個監看器聽 `agent:events`,數該對話收到幾則 `session-end`。那是回合結束時
才會出現、而且只出現一次的標記。

同一條規則被同一個人踩三次,代表它值得寫成工具而不是筆記:驗收腳本的
`sendAndApprove()` 現在內建這個等待,呼叫端不必自己決定怎麼等。

## 5. 沒有處理的項目

- **沒有「只中斷、不重開」的操作**。Claude 與 codex 兩邊都一樣:中斷一定伴隨換一場對話。
  真正的停止鈕(保留對話內容、只中止進行中的工具)是兩邊共同的缺口,不屬於 5b。
- **`userMessage` 畫成「未知事件」**。那是 codex 把使用者自己的訊息回送一次,對話裡已經有了,
  所以 mapper 刻意不畫;但畫面上會出現兩個空的「未知事件」標記。可以在 mapper 把
  `userMessage` 改成回空陣列,代價是失去「有東西沒被處理」的可見性。
- 規格 §8 的六項以外沒有驗:右窗格工具(5b 不做)、`dynamicTools`(5c 才用)。

## 6. 對規劃的影響

- 5b 的六項驗收全部通過,codex 對話分頁可以開始真實使用。驗收過程本身補了兩項規格沒寫的東西:
  codex 分頁的「新對話」入口,以及換對話時舊 client 的事件隔離。
- 5c(Claude 對 codex 的 `ask_peer`)可以接著做:協定層的 `item/tool/call` 在 RESULTS-11
  已驗過,而 5b 這次確認了 `dynamicTools` 需要的 `experimentalApi` 宣告與批准接線都在。
- 「兩層之間的契約要有跨層測試」這條進了 `docs/CONCLUSIONS.md`:5b 的四個缺陷有三個是
  單元測試涵蓋不到的層與層之間,一個是規格對外部行為的假設錯誤。實機驗收不是走過場。
