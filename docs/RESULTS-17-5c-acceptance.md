# 子專案 5c 的實機驗收

量測日期:2026-09-10
機器:macOS 26.6.2(Darwin 25.6.0)、arm64、16 GB
Node 24.18.0 / Electron 44.0.0 / codex-cli 0.153.4
版本:分支 `5c-codex-peer`

## 0. 範圍

計畫 `docs/superpowers/plans/2026-09-10-yeschef-5c-codex-peer.md` 的驗收表六項:
同一個專案裡一個 Claude 對話與一個 codex 對話互相問答。
單元測試在驗收前已全綠(74 檔 1603 條,Stmts 93.52 / Branch 88.61)。
協定事實在 `docs/RESULTS-16-5c-probe.md`,接線前先問過協定,沒有猜。

## 1. 六項結果

| # | 項目 | 結果 | 證據 |
|---|---|---|---|
| 1 | Claude 問 codex | 通過 | codex 那一輪是「同伴提問 claude · 65244c14」;它用 `answer_peer` 回答,畫面顯示「回答同伴」,答案回到 Claude 的工具結果 |
| 2 | codex 問 Claude | 通過 | Claude 那一輪是「同伴提問 codex · 01a08a6c」;答案回到 codex 的最終回覆 |
| 3 | codex 不給 `to`、專案裡有兩個同伴 | 通過 | 工具狀態是「失敗」,codex 貼出的原文是「這個專案有多個同伴,to 要指定一個:65244c14(claude)、fe0aa273(claude):只回一句:我是第三個。」 |
| 4 | codex 問 Claude 之後,Claude 反過來問 codex | 通過 | Claude 拿到「對方正在等你回答 #37a01e2c…,先回答它」,並把那段原文當成答案回給 codex |
| 5 | 在 Claude 那側按「代替回答」回覆 codex 的提問 | 通過 | codex 的 `ask_peer` 拿到那段文字;answer 檔 `actor` 是 `user`,`from` 是被問方 Claude 的 linkId |
| 6 | 關掉 app 再開,在 codex 對話再問一次 | 通過 | 重開後走 `thread/resume`,`ask_peer` 照樣叫得動,問題寫進信箱、答案回到 codex |

信箱裡兩個方向都有,`provider` 一邊 `claude` 一邊 `codex`:

```
question 65244c14/claude -> 01a08a6c/codex | README 第一行是什麼?
question 01a08a6c/codex -> 65244c14/claude | 你是哪個模型?
answer   01a08a6c/codex -> 65244c14/claude | README.md 第一行是:# 跨模型驗收
answer   65244c14/claude -> 01a08a6c/codex | 我是 Claude,模型是 Opus 5…
answer(user) 65244c14/claude -> 01a08a6c/codex | 人代答:不用等了…
```

## 2. 驗收抓到的缺陷

### 2.1 codex 那側的同伴提問角色標成「你」(已修)

第一項一跑就看到:codex 收到的提問內容對、標示對,但那一輪的角色是「你」而不是「同伴提問」。

成因是兩層疊起來的。codex 會把使用者自己的訊息以 `userMessage` 回送一次,而 mapper 沒有處理
那種項目,它掉進「認不得」產生兩個未知事件;`Turn` 的角色標籤要求「整輪只有同伴提問區塊」
才換標籤,多了那兩個就不成立。

`userMessage` 畫成未知事件這件事 `docs/RESULTS-13-5b-acceptance.md` §5 記過但沒修,
當時的代價只是畫面上多兩個空標記。5c 之後它多了一個後果,所以修了:mapper 對 `userMessage`
回空陣列,註解寫明「codex 把使用者自己的訊息回送一次,本機已經推過,不重複畫」。

## 3. 最終審查抓到、驗收看不到的兩項(已修)

- **提問方那側的兩顆按鈕在 codex 不會出現。** `ConversationPane` 還在硬比對有 `mcp__yeschef__`
  前綴的工具名稱,codex 的裸名永遠不相等。規格 §6.5 說「每則未決問題在兩邊畫面都有兩顆按鈕」,
  在 codex 提問方那側等於少了一半的煞車。驗收表第 5 項只驗 Claude 側代答,所以跑完六項也抓不到。
- **提問方畫面把對方標成 `claude`。** 5c 之前只有 Claude 進得了同伴登錄,寫死是對的;
  現在 codex 也能被問。`PeerPending` 補了 `targetProvider`,值取自問題的 `to.provider`。

## 4. 記錄不修的一項

codex 在 `ask_peer` 阻塞中被按「新對話」時,那條路沒有通知同伴服務,而 `turn/interrupt`
沒有逾時。關分頁那條路有 `conversationEnded` 擋著(已驗),開新對話那條的最壞情況需要
codex 在有未回覆的工具呼叫時不回 `turn/interrupt`,那沒有實測過。要修得先探測那個行為,
不該用猜的改。成本:codex 對話在等同伴時按新對話,可能要等對方回答或逾時才送得出下一則。

## 5. 一併記下的事

- codex 這側的兩個工具不需要批准(dynamic tool 不走批准政策),與 Claude 那側把它們放進
  免批准清單一致。`answer_peer` 只寫 `<專案>/.yeschef/mail/`,而 codex 的沙箱是
  `workspace-write`,那個目錄它本來就寫得到,沒有擴權。
- codex 回答同伴時仍然要走自己的批准卡。驗收第一項花了四分鐘,其中三分半是在等兩張
  Bash 批准。這與規格 §6.3 記的「答的那方在背景時批准會被扣住」是同一件事的延伸:
  現在批准不扣住了(第二階段改的),但還是要人按。
