# 子專案 D 多專案實機驗收結果

量測日期:2026-09-08
機器:macOS 26.6.2(Darwin 25.6.0)、arm64
Node 24.18.0 / Electron 44.0.0(Chrome 152.0.7977.54)/ Agent SDK 0.3.258
分支與起點:feat/d-projects,起點 97401f9,量測時 HEAD cf8d501

量測方法:`npm run build` 之後 `npx electron . --remote-debugging-port=9333 --user-data-dir=/tmp/yeschef-d-acceptance/userData`,
狀態檔預先寫好兩個專案(`/tmp/yeschef-d-a`、`/tmp/yeschef-d-b`),第三個專案 `/tmp/yeschef-d-c` 在記憶體那一項才補進狀態檔。
左窗格用 CDP `Runtime.evaluate` 操作 DOM、xterm 用 `Input.insertText`,畫面以 `Page.captureScreenshot` 為準,
工具回傳逐字從 SDK session jsonl 讀(`~/.claude/projects/-private-tmp-yeschef-d-a/` 等),主程序 log 導到 `main.log`,
終端的 cwd 用 `lsof -a -p <pid> -d cwd` 讀 pty 程序自己的工作目錄。全程沒有動到真正的 userData:
驗完 `~/Library/Application Support/yeschef/` 底下依然沒有 `yeschef-projects.json`,
`/tmp/yeschef-d-acceptance/userData/` 則有 `yeschef-projects.json` 加 `.bak.0`、`.bak.1` 兩份輪替備份。

## 結果表(規格 §7 實機驗收)

| # | 項目 | 結果 | 佐證 |
|---|---|---|---|
| 1 | 兩個專案各開終端,cwd 各自正確、切走不死 | 通過 | `01-a-pwd.png` 顯示 `/tmp/yeschef-d-a`、`01-b-pwd.png` 顯示 `/tmp/yeschef-d-b`;`lsof` 讀到兩個 pty zsh 的 cwd 分別是 `/private/tmp/yeschef-d-a`、`/private/tmp/yeschef-d-b`;`01-a-back.png` 切回 A 後終端分頁還在、剛才的 `pwd` 輸出還在;狀態檔兩個專案的 `tabs` 各是 `["conversation","terminal"]` |
| 2 | A 跑長回合,切到 B 再回來看得到結果 | 通過 | `02-b-while-a-runs.png` 的 B 是自己的空對話,一個字元的串流都沒有;等 45 秒切回 A,`02-a-result.png` 有完整的 1 到 120 與「數完了」,composer 提示變成「輸入以接續這條對話」;狀態檔 A 的 `threads[0].sessions` 多一筆 `51d033d7-de15-41b9-9089-d2ef94c3e66e`,與 `-private-tmp-yeschef-d-a/` 底下新出現的 jsonl 檔名相同;`main.log` 沒有任何 `[yeschef]` 開頭的行 |
| 3 | A 的批准在背景只顯示記號,切回才出批准卡 | 通過(工具改用 `rm`,原因見「與派工單的差異」) | 在 A 送出後 1.5 秒切到 B:`{ pending: 1, cards: 0, title: "yeschef-d-b" }`,`03-b-marker.png` 看得到 A 那格的黃點 `●`;在 B 待 45 秒(超過批准登錄表的 30 秒計時)記號還在,`pending` 仍是 1,證明背景的批准沒有進登錄表;切回 A 後 `{ pending: 0, cards: 1 }`,`03-a-card.png` 是完整的批准卡;按「允許 Bash」後 `/tmp/yeschef-d-a/probe-delete2.txt` 真的被刪掉,回答是「執行完成」 |
| 4a | 切換專案右窗格回到各自的 lastUrl | 通過 | 啟動時 active 是 A,右窗格 target 的 url 是 `file:///tmp/yeschef-d-a/index.html`;切到 B(當時沒有 lastUrl)變 `about:blank`;在 B 用 `view_navigate` 開自己的頁面後,A ↔ B 來回切,右窗格 url 每次都回到該專案的頁面;狀態檔的 `lastUrl` 是 `["file:///tmp/yeschef-d-a/index.html","file:///tmp/yeschef-d-b/index.html"]`;`04-a-right.png` 是「這是 A」、`04-b-right.png` 是「這是 B」 |
| 4b | 檔案範圍跟著 active 專案 | 通過 | 在 B 請它開 `file:///tmp/yeschef-d-a/index.html`,B 的 session jsonl 裡該 `tool_result` 是 `只允許開啟 /tmp/yeschef-d-b 底下的本地檔案`、`is_error: true`;右窗格 url 五次取樣都是 `file:///tmp/yeschef-d-b/index.html`,沒有動;`05-restored-b.png` 是同一段對話的畫面 |
| 4c | 背景專案呼叫瀏覽器工具回「瀏覽器正由前景專案使用」 | 通過 | 在 A 送出 `view_snapshot` 請求後 2 秒切到 B,A 的 jsonl 裡該 `tool_result` 逐字是 `瀏覽器正由前景專案使用`、`is_error: true`;右窗格 url 25 秒內五次取樣都是 B 的頁面,沒有被 A 蓋掉 |
| 4d | 前景專案的瀏覽器工具正常 | 通過 | 切回 A 再送一次同樣的請求,不切走,`tool_result` 是 `使用者在你上次操作後點了 0 次、按了 0 個鍵，網址從 about:blank 變成 file:///tmp/yeschef-d-a/index.html` 加 `[page] 專案 A 的頁面 file:///tmp/yeschef-d-a/index.html` 加 `heading "這是 A"` |
| 5 | 關掉再開:清單、active、分頁還原;openIdsOnShutdown 有寫 | 通過(要把 SIGTERM 送給 Electron 主行程) | SIGTERM 送給 pid 檔裡那個 pid 只殺掉 `npx` 外殼,Electron 主行程還活著、`openIdsOnShutdown` 是空的;送給 Electron 主行程才走 `before-quit`:`activeId` 是 A、`openIdsOnShutdown` 是兩個 id、兩個專案的 `tabs` 各是 `["conversation","terminal"]`,沒有孤兒 pty。重開後 `05-restored.png` 的標題列是 `yeschef-d-a`、專案列兩格、A 的分頁列是「Claude 對話」加一個 zsh 分頁、右窗格是 A 的頁面;`05-restored-terminal.png` 的終端是全新的空 shell(規格 §4.2:內容不存);切到 B 也還原成「Claude 對話」加 zsh |
| 6 | 記憶體(見下) | 617 MB → 697 MB | `mem-2-projects.txt`、`mem-3-projects.txt` |
| 7 | 資料夾不存在:標示不可用、不移除 | 通過 | 搬走 `/tmp/yeschef-d-c` 重開:`{ unavailable: 1, projects: 3 }`,C 那格的 class 是 `project-chip on unavailable`,`06-unavailable.png` 看得到刪除線與紅色 `!`;切到 C 時左窗格是 `資料夾 /tmp/yeschef-d-c 不存在` 加「重新指定資料夾」「移除專案」兩顆按鈕,`.quick-launch button` 是 0 個,分頁列是空的 |
| 7b | 重新指定資料夾(以改狀態檔模擬)後送一則訊息 | 通過 | 關掉 app 把 C 的 `rootPath` 改成 `/tmp/yeschef-d-c-moved` 再開:`unavailable` 回到 0、`.pane-unavailable` 不見了、分頁列還原成「Claude 對話」加 zsh;送一則新訊息,`07b-relocated.png` 同時看得到搬家前那一輪的「好」與新一輪的「搬家」;`main.log` 沒有 `projectDir 不存在`;逐字稿新條目的 `cwd` 是 `/private/tmp/yeschef-d-c-moved`,詳見「對規劃的影響」第 4 點 |

## 補充檢查

Task 14 note 提到的情境:狀態檔有三個專案但 `activeId` 是 `null`。改狀態檔重開,沒有 crash,右窗格 target 的 url 是 `about:blank`,
DOM 查詢回 `{"selected":0,"chips":3,"empty":"加入專案開始使用","slots":1}`:專案列三格都沒有 `aria-selected="true"`,左窗格顯示空提示,
唯一那個 `.pane-slot` 是永遠掛著的對話 slot,它的 `hidden` 是 true、`getClientRects()` 0 個、外層 `.pane-area` 也 hidden,畫面上看不到。
截圖 `09-active-null.png`(標題列是「尚未加入專案」),`main-null.log` 只有 DevTools 那一行,沒有 `Error`、`TypeError`、`unhandled`;檢查完狀態檔已還原。

## 最終 review 後的修正與補驗

整支分支的最終 review 提出四個 Important,程式面修了三個:
I1 批准卡改在 `projects:state` 到達時清空,原本 `[activeId]` 的 effect 在 React 的排程下可能晚於新專案的 `approval:ask`,把剛到的卡一起清掉;
I2 專案路徑進登錄表前先 realpath,「本專案」的 Recents 原本在 `/tmp` 這類 symlink 路徑下永遠是空的;
I3 狀態檔 schemaVersion 不認得時改名失敗改成記錯誤,不再讓 app 退出。

I1 與 I2 這兩項是連線與時序層的改動,單元測試給過假保證,所以補跑實機:

| # | 檢查 | 結果 | 佐證 |
|---|---|---|---|
| 12 | 本專案 Recents 在 realpath 形式的 rootPath 下有內容 | 通過 | 種子 `YESCHEF_PROJECT_DIR=/tmp/yeschef-d-a`,全新 userData 的狀態檔寫的是 `/private/tmp/yeschef-d-a`;送一則不用工具的訊息後,「本專案」有 2 筆(`.recents-item`),切到「全部」是 100 筆,切回「本專案」仍是 2 筆;`10-recents-own-project.png` |
| 13 | 送出立刻要批准、1 秒內切走、記號出現後切回,3 次都拿回批准卡 | 通過 | 3 次切回後 DOM 都有 1 張 `.approval-card`、`.project-pending` 歸 0;點回 A 到卡片出現分別是 146 ms、39 ms、143 ms(記號從切走算起分別在 3526 ms、1007 ms、1508 ms 出現);三次都按「允許」,`QUICK-1`、`QUICK-2`、`QUICK-3` 都真的被刪掉,log 裡沒有批准逾時。A 當時的作用中分頁是終端,卡片在隱藏的對話 slot 裡,所以 `11-quick-switch-card-1.png` 拍到的是 zsh 分頁,不是卡片的視覺佐證 |

第 12 項的同一次啟動另外確認兩件事:終端分頁 `pwd` 印 `/private/tmp/yeschef-d-a`(`lsof` 讀 pty zsh 的 cwd 相同),
`view_navigate` 開 `file:///private/tmp/yeschef-d-a/index.html` 成功,右窗格 target 的 title 是 `fix-check`,
agent 回「頁面標題是 fix-check。」,沒有出現不在專案目錄的錯誤(`10-terminal-pwd.png`、`10-navigate-realpath.png`)。
兩次啟動的 `main-fix.log` 與 `main-fix-quick.log` 都沒有批准逾時。各有一行 `[yeschef] Error: interrupt 失敗：Cannot write to terminated process`,
寫在送 SIGTERM 關 app 的時候:關機流程對已經結束回合的 query 呼叫 `interrupt()`,SDK 子程序早已收掉,與批准無關,見「對規劃的影響」。
第 13 項用的是本文件其他項目共用的 userData,狀態檔在開始前備份、做完還原,所以上面各節描述的最終狀態仍然成立。

## 記憶體

| 情境 | yeschef 全樹 | 程序數 | 對照 |
|---|---|---|---|
| 2 個專案、各 1 終端、A 跑過 6 回合 | 617 MB | 10 | RESULTS-06:2 終端加 tmux 353 MB |
| 3 個專案、各 1 終端 | 697 MB | 10 | 比 2 個專案多 80 MB,低於 150 MB 的查核線 |

`electron-vite` 那列兩次都是 0 MB / 0 個程序,理由見 RESULTS-04 §附註 2。
`yeschef` 這一組是 `spikes/measure-memory.ts` 拿 `yeschef` 這個子字串比對 `ps` 整行抓出來的,
抓到的是 Electron 自己的行程;量測檔只記整組的總量與程序數,沒有逐個行程的名稱,所以這裡不列細項;
終端的 pty shell 由 `nodePty.spawn` 起,`ps` 那行是 `/bin/zsh`,不含 `yeschef`,所以不在這一組裡。
617 MB 與 697 MB 算的都只有 Electron 行程,80 MB 的差額也全在 Electron 行程內,
來源是第三個專案的狀態,加上它的 renderer 掛載的終端與對話畫面。
程序數兩次都是 10,因為多一個專案不會多開 Electron 行程。
`ps` 確認 Electron 主行程底下沒有任何 `claude` 子程序:sleeping session 確實睡著,回合結束後 SDK 的程序已收掉。

## 覆蓋率

`npm run test:coverage`(最終 review 後的修正併入之後):56 個測試檔、1149 個測試全綠。
`All files` 那行是 Stmts 93.79%、Branch 89.33%、Funcs 93.77%、Lines 95.54%(門檻 93 / 86),兩項都過。

## 實機找到的缺陷

| 缺陷 | 修法 | commit |
|---|---|---|
| 還原的終端 hidden 掛載時 pty 以 80×24 起,展開後 p10k 印出初始化警告一行 | 未修(延後),見「觀察」 | — |

十一項驗收全部第一次就通過,唯一一項缺陷延後處理,本次沒有修法 commit。
下面兩節記的是派工單假設與實機不同的地方,不是程式缺陷。

## 與派工單的差異

**批准流程的觸發工具**。派工單假設 `permissionMode: 'default'` 之下 `Bash` 一定進批准流程。
實際上安全的讀取類指令直接放行:`cat MARKER` 從送出到拿到 `marker-a` 只花 2 秒,
jsonl 裡沒有任何批准紀錄,`canUseTool` 根本沒被呼叫到。
(本節原本把這件事歸因於使用者層的 `permissions.defaultMode: "auto"`,那是錯的。
RESULTS-09 在使用者層設定確定不載入的情況下重測,`cat` 仍然不被問:
`'default'` 的定義本來就只對 dangerous operations 提問。)破壞性指令仍然會問:同一個 session 送 `rm <檔案>` 就出現批准卡,
前景不理它 30 秒後工具回 `批准請求逾時（30000ms 內未收到回覆）`。
驗收第 3 項因此改用 `rm` 觸發,測到的是同一條 `canUseTool` → `requestApproval` 路徑。

其他三處選擇器與派工單寫的不同,實機以程式碼為準:
專案名在 `<header class="title-bar">`,`document.title` 一直是 `yeschef`,沒有跟著專案走;
分頁的作用中狀態是 `.tab-strip .tab.on`,不是 `.tab.active`;
背景專案的分頁不在 DOM 裡,`document.querySelectorAll(".pane-slot")` 只列得到 active 專案那一組。

## 需要人工的項目

| 項目 | 為什麼機器測不了 | 怎麼驗 |
|---|---|---|
| 「+」加入專案 | 系統資料夾對話框,CDP 開不了 | 按 `+`,選任一資料夾,專案列多一格且成為 active |
| 不可用專案的「重新指定」 | 同上 | 搬走資料夾後重開,點該專案的「重新指定資料夾」,選新位置,`!` 消失。本次以改狀態檔模擬到第 7b 項,按鈕本身沒按過 |
| 退出方式 | 本次用 SIGTERM 觸發 before-quit | 真的按 Cmd+Q,重開後 `openIdsOnShutdown` 非空 |
| 連按兩次 Cmd+Q 仍會退出 | Cmd+Q 送不進 CDP | Task 14 的 `before-quit` 用同步旗標把第一次退出請求擋下來寫關機紀錄,第二次放行;連按兩次要能真的退出,不能卡住 |

## 觀察

隱藏狀態下掛載的終端,pty 以 80×24 開,第一次顯示才由 ResizeObserver 調成實際大小。
冷啟動後第一次展開還原的終端,`.xterm-screen` 在 0.3 秒與 3.3 秒兩次量到都只有 86 px(約 10 欄),
容器是 800 px,下一張截圖之後再量就回到 783 px;app 跑一陣子之後做同樣的動作,0.5 秒就已經是 783 px。
看得見的痕跡是還原出來的終端多印一段 powerlevel10k 的 `Console output during zsh initialization detected`,
一開始就在前景開的終端沒有這一段。這個反覆排版會自己修正、不掉資料,本次不改。

## 對規劃的影響

- `YESCHEF_PROJECT_DIR` 現在只是狀態檔為空時的種子,不再是必填;A／B／C 的 RESULTS 裡的啟動指令是歷史紀錄,不改。
- 用 `npx electron .` 起 app 時,shell 的 `$!` 是 npm 外殼的 pid,不是 Electron 主行程。SIGTERM 送給外殼只殺外殼,
  Electron 收不到、`before-quit` 不會跑、關機紀錄不會寫。之後寫驗收腳本要用
  `ps -Ao pid,ppid,comm | grep "electron/dist/Electron.app/Contents/MacOS/Electron$"` 找到真正的主行程再送信號。
- 讀取類的 `Bash` 不經過本 app 的批准卡就執行,這關係到規格對「預設要問」的假設。
  原本記的原因是使用者層 `permissions.defaultMode: "auto"` 蓋過明寫的 `permissionMode: 'default'`,
  RESULTS-09 證實那是錯的歸因:`'default'` 本來就只對 dangerous operations 提問,
  `settingSources` 與 app 端的 `canUseTool` 都改變不了這件事。
  子專案 E 若要保證每個工具都問,要走 `dontAsk` 或自己的 PreToolUse hook。
- 搬走資料夾再 resume 的實測結果比預期好,但有一個要記下來的行為:
  新回合的 `cwd` 確實換成新的 `rootPath`(jsonl 新條目寫 `/private/tmp/yeschef-d-c-moved`,Ruling T14-1 的退路有效),
  SDK 卻把新回合續寫回原本那份逐字稿,檔案路徑仍在舊的編碼目錄 `~/.claude/projects/-private-tmp-yeschef-d-c/` 底下,
  同一個檔案裡因此出現兩種 `cwd`(舊的 13 筆、新的 5 筆)。
  沒有出現 `No conversation found with session ID`,對話內容完整接續。
  E 規格的 thread／session 鏈若要靠 `transcriptPath` 反推專案,得知道搬家之後這條路徑不會跟著改。
- 背景專案的分頁不掛載在 DOM 裡,所以背景專案的終端要等第一次切過去才會真的起 pty。
  規格 §2 說背景專案「繼續跑」指的是對話核心,不含還沒開過的終端分頁,實機行為與這個讀法一致。
- 終端要在 spawn pty 之前就拿到真實尺寸,或是等第一次顯示才 spawn,不要先用 80×24 起再改。
  這件事歸 roadmap 的終端項目,D 不處理。
- I1 的根本修法是讓 `agent:approval:ask` 帶 `projectId`,renderer 依 activeId 過濾,就不需要「切換時清空」這個動作。
  這同時解決另一種情況:前景時已經送到 renderer 的批准,切走再切回拿不回卡片,只能等 30 秒逾時 deny。歸 E 或 roadmap。
- 啟動時 transcript 讀兩次:`ipc-bridge.ts` 建構時 `switchTo` 先 `activate()`(那時 renderer 還沒載入,送不到),
  第一次 `projects:get` 再 `replay()` 讀第二次。可讓建構時只設 `currentId`,等第一次 `projects:get` 才 activate。
- `openIdsOnShutdown` 目前只有寫沒有讀(規格 §4.1 要求記下來)。E 若不打算用,roadmap 要說明這個欄位是為誰而記。
- `projects-state.ts` 的 `recordSession` 只跟鏈上最後一筆去重,同一個 sessionId 隔著別的 session 再出現會重複記一筆。
  E 在同一條 thread 上換 session 時會碰到。
- 第 13 項切回 A 時,待批准記號會清掉,但 A 的作用中分頁是終端,卡片在對話分頁裡看不到:記號一消失使用者就沒有任何提示,
  要自己切到對話分頁才會發現。建議切回時若有待批准就自動切到對話分頁,或記號留到卡片真的顯示過才清。歸 E 或 roadmap。
- 關機時 `interrupt-query` 對已經結束回合的 query 呼叫 `interrupt()`,SDK 子程序已收掉,`agent-host.ts` 把 rejection 記成
  `interrupt 失敗：Cannot write to terminated process`。行為無害,但每次關機都留一筆錯誤 log;host 知道 query 已結束就該跳過 interrupt。歸 roadmap。
- 重新指定資料夾會把該專案的 core 收掉重建:對話正在 live 時進行中的回合會被 teardown,使用者沒有提示;
  保留下來的終端分頁也還連著舊 cwd 起的 shell。兩者都符合規格 §6,建議在 `Unavailable` 面板或 relocate 成功後多一句提示。

## 截圖

全部在 `/tmp/yeschef-d-acceptance/` 底下:
`01-a-pwd.png`、`01-b-pwd.png`、`01-a-back.png`、`01-a-back-settled.png`、`02-b-while-a-runs.png`、`02-a-result.png`、
`03-b-marker.png`、`03-a-card.png`、`04-a.png`、`04-b.png`、`04-a-right.png`、`04-b-right.png`、
`05-restored.png`、`05-restored-terminal.png`、`05-restored-b.png`、`06-c-terminal.png`、
`06-unavailable.png`、`07b-relocated.png`、`08-reflow-after-paint.png`、`09-active-null.png`、
`10-recents-own-project.png`、`10-terminal-pwd.png`、`10-navigate-realpath.png`、`11-quick-switch-card-1.png`。
記憶體原始輸出在 `mem-2-projects.txt`、`mem-3-projects.txt`,
主程序 log 在 `main.log`、`main-null.log`、`main-fix.log`、`main-fix-quick.log`。
fixture 的最終狀態:`/tmp/yeschef-d-a`、`/tmp/yeschef-d-b` 在原位,C 留在 `/tmp/yeschef-d-c-moved`,
狀態檔裡 C 的 `rootPath` 指的就是搬過去之後的位置。
補驗把 `/tmp/yeschef-d-a/index.html` 換成標題為 `fix-check` 的頁面,第 4a 項截圖裡的「這是 A」是換掉之前的內容。
