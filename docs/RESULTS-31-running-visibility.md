# RESULTS-31:看得出 agent 有沒有在作業

- 日期:2026-09-15
- 分支:`running-visibility`,五個 commit(`5ea264d`、`ae32fe8`、`3780c69`、`8bec49b`、`a9fbb0e`)
- 起因:使用者說「我時常不知道他有沒有在作業,像是現在我就不知道他是停了還是有再繼續執行」

## 做了什麼

四件事:

| | 位置 | 內容 |
|---|---|---|
| 1 | 分頁列與專案列 | 執行中的分頁加 `◐` 記號,放在既有的 `●`(待批准)之前 |
| 2 | 狀態列 | 「N 個進行中」變成可點,跳到第一個在跑的對話 |
| 3 | 前景對話底部 | 顯示「執行中 N 秒」,超過一分鐘換成「N 分 N 秒」 |
| 4 | 同上 | agent 還沒產出任何內容時顯示「模型思考中 N 秒」 |

## 四輪修正各自解掉的東西

第 1 版四項都有,但實機一量,第 3、4 兩項的數字是錯的。

**「模型思考中」形同虛設。** 第一版用「turn 數有沒有變多」當條件,但 `message-start`(還沒有內容的
訊息骨架)與使用者自己的訊息回聲都會讓 turn +1。25ms 取樣到的第一筆就已經是「執行中 0 秒」。
改成算 assistant 的 block 數(`ae32fe8`)。

**「執行中 N 秒」量的是「你盯著它多久」。** `useElapsedSeconds` 從 `active` 翻成 true 起算,
切走再切回從 0 重數;而狀態列跳過去看到的一定是「執行中 0 秒」,跳過去的用意就是想知道跑多久。
改成主行程在 `setBusy(true)` 記 `busyStartedAt`,經 `ProjectsView.busySince` 送給渲染端(`3780c69`)。

**用 ref 記回合起點在真機上不成立。** 背景對話收不到事件(`conversation.ts` 的 `emit` 有 `if (active)`),
切回前景走的是 `replay()` 推 `[RESET, ...log]`,`RESET` 把 view 清成 `INITIAL_VIEW`。
後果是切回前景時 block 數先掉到 0 再爬,明明有輸出卻閃「模型思考中」;從狀態列跳到一個從沒前景過的
分頁時,pane 全新掛載記下起點 0,replay 灌進歷史就超過 0,「模型思考中」永遠不出現。
同一個 commit 改成只看最後一個 turn。

**`busy` 早於使用者訊息回聲。** Claude 路徑是 `dispatch(user-input)` 之後同步 `setBusy(true)`,
而 `user-text` 要等 `pending` 鏈裡的 `ensureHost().send(text)` 才合成。中間這段 `lastTurn` 還是上一輪的
assistant turn,於是第二輪以後會顯示「執行中 0 秒」。對話睡著要 resume 時這不是一幀而是好幾秒。
改成主行程維護 `turnProduced`,經 `producingTabIds` 送出,渲染端不再猜(`8bec49b`)。

**codex 一輪先跑指令會整輪停在「模型思考中」。** 上一項的判斷條件列的是 Claude streaming 的事件種類
(`block-start`/`text-delta`/`thinking-delta`/`tool-input-delta`),codex 的 mapper 產的是
`tool-use`/`text`/`thinking`,一個都不在裡面。改成 `src/shared/events.ts` 的 `isTurnContentEvent`
反向列舉:排除 `session-start`/`session-end`/`message-start`/`user-text`/`reset`,其餘預設算內容(`a9fbb0e`)。
預設方向選 true,是因為漏列的後果(早一點顯示「執行中」)比整輪卡在思考中輕。

## 實機量測

每次都先比對 `document.querySelector('script').src` 的 bundle 檔名再開始量。

Claude,25ms 取樣,同一個對話連送兩句:

| | 第一輪 | 第二輪 |
|---|---|---|
| 思考中 | 26ms 起 | 25ms 起 |
| 換執行中 | 2855ms「執行中 2 秒」 | 1253ms「執行中 1 秒」 |

切分頁,250ms 取樣:思考中 0→1 秒 → 執行中 2 秒 → 切到別的分頁「(無)」 → 切回「執行中 7 秒」。

codex,25ms 取樣,那一輪第一件事是 shell 的批准卡:27ms 思考中 → 2480ms 執行中。

## 兩個量測失誤

兩個都不是程式的問題,是量的方式錯了,記下來免得重犯。

1. **連到的是舊的 electron 進程。** 第一輪量到「還是沒有思考中」,結論全錯。CDP 的
   `/json/list` 回的是上個 session 留著的進程,載入的 bundle 檔名早就不存在。是加了臨時
   `data-dbg` 屬性讀到 `undefined` 才發現。之後一律先比對 bundle 檔名。
2. **以為切了分頁其實沒切。** `activateTab` 收的是 `{ projectId, tabId }`,我當成兩個字串參數,
   所以「切走再切回」量到的只是同一個窗格繼續跑。是去讀 `activeTabId` 才發現。

## 審查抓到而測試沒抓到的

- 「執行中 N 秒」量錯對象:1962 則測試全綠,而且有一則把錯誤行為寫死(切回前景後斷言「執行中 0 秒」)。
- ref 在 replay 之後不成立:對應的測試模擬的是「背景 pane 收到事件」,主行程不會這樣做。
- codex 的回歸:那一輪的新測試只灌 `agentMessage/delta`,所以全綠。

## 已知且接受的

- `elapsed.ts` 在 `since` 有值時於 render 內算 `Date.now()`,把它改成 `return seconds` 全部測試照樣綠。
  React 19 下無害(值只拿去顯示),但那行沒有測試守著。
- `isTurnContentEvent` 有 `default`,所以新增事件種類時 compiler 不會提醒你來看這個函式。
- 歷史載入未完成時使用者就送出,歷史事件會讓 `turnProduced` 提早翻成 true,那一輪直接顯示「執行中」。
- `vitest.config.ts` 沒有設 `thresholds`,覆蓋率是人工把關的數字。
