# 子專案 D2 的實機驗收

量測日期:2026-09-09
機器:macOS 26.6.2(Darwin 25.6.0)、arm64、16 GB
Node 24.18.0 / Electron 44.0.0 / Agent SDK 0.3.258
版本:main `b6280bd`(D2 全部合併後)

## 0. 範圍

規格 `docs/specs/2026-09-09-yeschef-d2-multi-conversation-design.md` §6 列的六項實機驗收。
單元測試在合併前已全綠(60 檔 1276 條、覆蓋率 Stmts 93.95 / Branch 88.84),這份文件只記實機結果。

操作方式沿用 RESULTS-09:`npx electron . --remote-debugging-port=9333 --user-data-dir=<fixture>`,
用 CDP 連上 renderer 送訊息、讀 DOM。`--user-data-dir` 同時決定 `app.getPath('userData')`,
所以狀態檔的位置與內容都可以事前擺好,不必經過原生資料夾選擇器。

fixture:`/private/tmp/yeschef-d2-acc/` 底下兩個專案資料夾,狀態檔一開始是**版本 1**。

## 1. 六項結果

| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| 1 | 同一專案開兩個 Claude 對話,各送一則 | 通過 | 兩個 pane 各只有自己的回覆;狀態檔兩條 thread、兩個不同 sessionId;`~/.claude/projects` 兩份 transcript |
| 2 | A 對話跑長回合,切到 B 對話送訊息,再切回 A | 通過 | A 的 250 字回答完整並收尾(`1 輪 · US$`);B 的 pane 沒有 A 的任何字 |
| 3 | A 對話的批准在背景到達,切到 B 看不到,切回 A 看得到 | 通過 | 在 B 時前景卡數 0、全部卡數 0;A 分頁與專案格同時亮記號;切回 A 後 412 毫秒出現卡片;允許後 `probe.txt` 真的被刪 |
| 4 | 關掉 A 對話,B 照常;關最後一個被拒 | 通過 | 剩一個時關閉鈕 `disabled`、title 為「至少留一個對話」;回合進行中先問「回合進行中，確定關閉？」,取消不關、確認才關 |
| 5 | 版本 1 的狀態檔重開 | 通過 | 升到版本 2、對話分頁補 `provider: 'claude'`、`.bak.0` 保留版本 1;舊 thread 接上後模型答得出前四輪的內容 |
| 6 | 記憶體 | 通過 | 1 個對話 820 MB,3 個對話各跑過 1 回合 828 MB,差 8 MB(查核線 150 MB) |

### 第 1 項的細節

點「新對話」開第二個分頁,標籤是「Claude 對話 2」。兩則訊息各自要求回一個水果編號,
結果 pane0 只有「蘋果一號」、pane1 只有「香蕉二號」,互相沒有對方的字。

狀態檔:

```
tab tab-a      label='Claude 對話'   provider=claude threadId=th-a
tab 25faf6df…  label='Claude 對話 2' provider=claude threadId=e836134e…
thread th-a:      sessions=[(00c78c7a, claude, 00c78c7a, parentLinkId=None, models=[])]
thread e836134e…: sessions=[(d27b705d, claude, d27b705d, parentLinkId=None, models=[])]
```

`linkId` 等於 `sessionId`、`provider` 為 `claude`、`models` 為空,與 E 規格 §4.1 對 D2 的預期一致。

### 第 3 項的細節

送出 `rm probe.txt` 後 900 毫秒切到 B,批准請求在 A 的背景到達。這時:

- 前景(B)的卡數 0,整個 renderer 的卡數也是 0,代表請求真的扣在主行程,沒有送出來
- A 的分頁亮 `.tab-pending`,active 專案格也亮
- 切回 A 之後 412 毫秒卡片出現,按允許後檔案被刪

分頁層的記號與專案層的記號同時成立,與規格 §4 一致。

### 第 4 項的細節

關掉不在回合中的對話分頁不問;剩下一個時關閉鈕停用。開新分頁時,前面已經關掉了
「Claude 對話」,新分頁的標籤是「Claude 對話 3」而不是重複的 2,序號取的是現有標籤的
最大值加一。這是整條分支最終審查修的項目,實機確認生效。

### 第 5 項的細節

分兩段驗。第一段在啟動時:手寫一份版本 1 的狀態檔(兩個專案、空的 session 鏈),
開 app 後檔案變成 `schemaVersion: 2`,兩個對話分頁補上 `provider: 'claude'`,
`.bak.0` 留著版本 1 的原檔。

第二段驗「舊 thread 照常接上」:把跑過四輪對話的版本 2 狀態檔降級回版本 1 的欄位形狀
(`SessionLink` 只留 `sessionId`、`transcriptPath`、`parentSessionId`、`startedAt`、`endedAt`、
`endReason`,分頁拿掉 `provider`),重開 app。結果:

- 檔案升到版本 2,`linkId` 補成 `sessionId`,`provider` 補 `claude`,`models` 補空陣列
- 畫面載入該場對話的完整歷史
- 續問「把前面回覆過的水果編號依序列出」,模型答出香蕉二號、芭樂三號、荔枝四號、龍眼五號

## 2. 記憶體的結構

全樹 RSS 的組成(1 個對話、回合結束後穩定):

| 行程 | RSS |
|---|---:|
| Electron 主行程 | 195 MB |
| renderer 與其他 Electron 子行程(4 個) | 355 MB |
| Agent SDK 的 CLI 子行程 | 269 MB |
| 合計 | 820 MB |

多開對話不會等比增加,因為背景對話的回合一結束就 sleep 並收掉串流,SDK 子行程跟著結束。
三個對話各跑過一回合之後,行程數仍是 6 個(只有前景那個對話有 SDK 子行程),
全樹 828 MB。這是 D 的 sleeping session 設計在多對話下的直接結果:同時活著的 SDK 子行程
數量等於「前景對話加上還在跑回合的背景對話」,不是對話分頁的總數。

## 3. 量測方法上的兩個教訓

### 「畫面沒動」不等於回合結束

第一版的第 2 項判定用「前景 pane 的文字長度連續 6 秒沒變」當回合結束的訊號,判成失敗。
實際上模型在 thinking 階段不產生任何 DOM 變動,6 秒穩定會提早觸發;腳本讀完就結束,
而畫面在那之後才補上。

兩次受控重現(切走時已輸出 474 字、切走時尚未開始輸出各一次)都顯示行為正確:
切回來 2 秒內 replay 送出完整內容。判定改成「等畫面出現回合統計」而不是「等它不動」。

判斷一個非同步流程有沒有結束,要找它結束時才會出現的標記,不要用「一段時間沒有變化」。

### 記憶體的基準要在同一個實例裡取

第一次量到 3 個對話比 1 個對話多 269 MB,超過查核線。那個基準是跑過多輪長文對話的
app 實例,而比較對象是同一個實例後來的狀態,兩邊的對話量不同。

重啟成乾淨起點後,基準 820 MB、三個對話 828 MB。差別不在對話數,在那一刻有沒有活著的
SDK 子行程。比較記憶體要固定「同一個 app 實例、同樣的回合狀態」,否則量到的是別的東西。

## 4. 一筆良性的收尾錯誤

兩輪驗收的主行程 log 各只有一筆錯誤,都發生在 app 關閉時:

```
[yeschef] Error: interrupt 失敗：Cannot write to terminated process
```

SIGTERM 先收掉了 SDK 的 CLI 子行程,`dispose()` 的 `interrupt-query` 才跑到,寫不進去。
`logError` 正確攔下,不影響收尾。這不是 D2 引入的行為。

## 5. 沒有驗到的項目

規格 §5 的「兩個對話同時要右窗格,背景那個回 `MSG.browserBusy`」不在 §6 的六項裡,這次沒驗。
文案在最終審查時已從「瀏覽器正由前景專案使用」改成「瀏覽器正由前景對話使用」,
單元測試涵蓋了守衛本身,實機沒跑過。

## 6. 對規劃的影響

- D2 的六項驗收全部通過,多對話可以開始真實使用。
- 記憶體的上限由「同時活著的 SDK 子行程數」決定,不是分頁數。之後要限制同時進行的
  回合數時,這是該管的量。
- 子專案 5b 的 codex 對話分頁會在同一個位置多起一個 `codex app-server` 子程序,
  5b 規格 §5 的「背景時收掉子程序」與這裡量到的結構一致,可以沿用同一條上限規則。
