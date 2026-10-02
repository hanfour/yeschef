# RESULTS-24:codex 對話的歷史清單 實機驗收

- 日期:2026-09-12
- 分支:`codex-history`,四個實作 commit(codex gpt-6-astra 實作,sonnet 逐 Task 審查,opus 整支審查)
- 規格:`docs/specs/2026-09-11-shell-regions-design.md` 增量 2 的「codex 的歷史清單還沒做」
- 計畫:`docs/superpowers/plans/2026-09-12-codex-history.md`

## 1. 資料來源的決定

不解析 `~/.codex/sessions/*.jsonl`,也不讀 `~/.codex/state_5.sqlite`:那兩個是實作細節。用 app-server 協定的
`thread/list`(可依 cwd 過濾、依更新時間排序)與 `thread/items/list`。每次列表起一支短命的 `codex app-server`,
查完就 kill;同一個 cwd 在途中的請求共用同一個 promise。

## 2. 自動測試

typecheck 0 error;89 檔、1799 測試全過;Stmts 94.17%、Branch 89.99%;build 成功。

## 3. 實機驗收

在主行程的 `session:list` handler 外面包一層計時。

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 1 | 開一個 codex 對話 | 側邊欄有這個專案的 thread | 1 筆,第一句是「請用 yeschef 的 view_navigate…」;列表 2589ms ✓ |
| 2 | 切「全部」 | 其他專案的也出現,附 cwd | 50 筆(上限),19 個不同 cwd;列表 1914ms ✓ |
| 3 | 點一筆 | 對話區換成那條的內容,角色是 codex,沒有「進行中」 | 4 個 turn,角色「你 / codex」,狀態列空 ✓ |
| 4 | 在那條上輸入「我們剛才在做什麼?」 | 回覆接著上文,同一個 thread 的 jsonl 變長 | 答「我們剛才在測試我是否有 yeschef 的瀏覽與截圖工具…」;寫進 2026-09-11 建的 `01a09090` 那個檔(35 行、5 則 user),沒有開新 thread ✓ |
| 5 | codex 起不來 | 側邊欄顯示錯誤原因 | 未驗:跑著的 app 裡沒辦法讓 `codex` 起不來。單元測試有涵蓋 reject 路徑,`Recents` 用既有的 `recents-error` 顯示 |

列表每次冷啟動一支 app-server 約 2 秒。`useSessions` 每次 turn 結束後重拉,兩秒內看得到清單更新,可接受;
要更快就得常駐一支,那要管它的生命週期與登入狀態變化,現在不做。

## 4. 實作與審查中修掉的

- **歷史回放不完整**(codex 實作 Task 2 時指出,是計畫的缺陷):計畫寫「跟 `itemCompleted` 一樣」,但 `itemCompleted`
  對 `userMessage` 回空(5c 的決定:live 的使用者文字由宿主自己推)、對工具只出結果沒有 tool-use。改成每個 item
  先走 `itemStarted` 再 `itemCompleted`,`userMessage` 在歷史這條路出 `user-text`。
- 同一個 cwd 在途中的列表請求共用(兩個分頁同時拉不會起兩支子程序)。
- `items()` 翻頁最多 20 頁(4000 筆),原本只靠 cursor 去重防無限迴圈。
- `loadHistory` 從選填改必填,拿掉沒人走到的 fallback。
- `CODEX_SIDEBAR_HINT` 與過期註解刪掉;`rootPathOf?: never` 是計畫的筆誤。

## 5. 留著的

- `tests/codex-mapper.test.ts` 裡 `userMessage` 的 fixture 用 `type: 'inputText'`,實際 schema 是 `'text'`;
  因為 live 路徑不看 content 所以無害,之後順手改。

## 6. 最終審查後的修正

**阻斷:開歷史時吞輸入。** `openHistory` 原本把使用者輸入延到歷史載完(冷啟動一支 app-server 約 2 秒),
中斷又排在正在跑的 `send` 後面,所以載入期間按 Enter 畫面沒反應、正在跑時點歷史要等回合結束。
改成 `openHistory` 同步推 RESET、同步設 viewing、同步 `interrupt()`;`userInput` 不再延後。
實機:點歷史當下送字,0.5 秒後字已在畫面、狀態列「1 個進行中」,回合結束回覆接著同一條 thread。
取捨:載入中送了字的話,晚到的歷史批次會被丟掉(不蓋掉剛送的那則),畫面只剩新的一輪;
上下文在 codex 那邊沒少(回覆帶 72k tokens)。要看歷史再點一次那條就好。

一併做的:重開 app 後 codex 分頁 `replay` 會走 `openHistory` 把歷史載回來(實機:重開後 6 個 turn 都在,
之前是空的);`items()` 壞掉的 entry 跳過不整份 throw;列表錯誤套 `withAuthHint` 與找不到 codex 的人話;
`useSessions` 沒人用的 `enabled` 參數刪掉;不帶 cwd 的列表子程序用 `homedir` 不用 `process.cwd()`。

沒做:列表結果的 TTL 快取(每回合結束重拉一次約 2 秒),先看真實使用再說。
