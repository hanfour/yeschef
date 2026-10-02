# 子專案 P:session 之間的阻塞式問答

## 0. 範圍與依賴

依 roadmap 2026-09-09 的裁決,本期只做單機、兩個 session 之間的阻塞式問答,訊息經檔案信箱傳遞。

使用者的需求原話:「多模型互動,不管是 claude 對 claude 還是 claude 對 codex 或是 codex 對
claude,他們是可以直接在不同的 session 做交互的」,並選定「兩個同時做不同事,中途互相問」。

依賴:子專案 B 的程序內 MCP server(工具掛在那裡)、子專案 D 的 thread 與 session 鏈、
子專案 E 規格 §4.1 的狀態檔版本 2(見 3.3)。codex 側的可行性見
`docs/RESULTS-11-codex-dynamic-tools.md`。

一個 D 沒有做、本子專案卻需要的前置:每個專案多個對話。D 的資料模型允許多個對話分頁
(`TabEntry` 的 `contentType: 'conversation'` 各帶 `threadId`),但 `ipc-bridge.ts` 的執行期是
每個專案一個 conversation core(`Map<projectId, Slot>`),畫面上也只有一個「Claude 對話」分頁。
「同一專案裡兩個 Claude session」在現況下開不出來。這個前置列在第 8 節的 5a 之前,叫 D2。

## 1. 為什麼是阻塞式問答,不是訊息匯流排

使用者要的是「中途互相問」。一問一答、問的人等答案,這件事用兩個工具加一個檔案目錄就能表達,
每個問題都以回答、取消或逾時之一結束;session 結束、重啟與檔案錯誤的處理見第 7 節。

訊息匯流排(非同步、多對多、廣播)是 roadmap §3.1 說的「重寫 Orca 迭代最多次的那塊」。
它解的是這份規格刻意不解的問題:兩個以上的 session、不等答案的通知、排程。真的需要時再開,
不在這裡預留。

## 2. 已定案的取捨

| 項目 | 決定 |
|---|---|
| 形式 | 一問一答,問的那方阻塞到收到答案或逾時 |
| 訊息種類 | 模型用的只有 `question` 與 `answer`;宿主另以 `cancel` 記取消。沒有通知、沒有廣播 |
| 工具 | `ask_peer`、`answer_peer` 兩個;不做 `list_peers`,`to` 解析失敗時錯誤訊息列出有誰 |
| 傳遞 | 每專案一個檔案信箱 `<project>/.yeschef/mail/`,一則訊息一個檔案 |
| 對方怎麼收到 | 注入對方 session 一則訊息,標明是同伴提問;對方回合進行中就排隊,不插隊 |
| 答案怎麼認 | 對方明確呼叫 `answer_peer(id, text)`,不拿對方的下一段輸出當答案 |
| 逾時 | 10 分鐘,沿用 B 的交接工具;到了 `ask_peer` 以錯誤結束,回合繼續 |
| 死鎖 | A 等 B 時 B 問 A,宿主立刻拒絕 B 的問題並告訴它先回答 |
| 人的介入 | 每則未決問題兩邊畫面都有「代替回答」與「取消」 |
| 重啟 | 未決問題一律取消,不恢復阻塞中的工具呼叫 |
| 清理 | 不清,檔案留著當紀錄 |
| 分期 | D2 每專案多個對話(前置,另立規格)→ 5b codex adapter(另立規格)→ 5c Claude 對 codex;5a 在 D2 之後幾乎免費,依需求 |

## 3. 資料模型

### 3.1 信箱

```
<project>/.yeschef/mail/
  question-<questionId>.json
  answer-<questionId>.json      # 有這個檔就是已答
  cancel-<questionId>.json      # 有這個檔就是已取消(逾時、對方結束、人取消、重啟)
```

三個檔名都用 question 的 id。answer 與 cancel 各有自己的 `PeerMessage.id`,但檔名與
`inReplyTo` 都是 question id,查狀態時只看檔名。

位置與 `info/exclude` 的規則沿用 E 規格 §4.2。`<userData>` 的副本放
`<userData>/yeschef-mail/<projectId>/`,每次寫主檔成功後同步寫一份;副本寫失敗只記錯誤。
讀取時以專案內的信箱為準,專案內整個目錄不存在才用副本,不逐檔混用兩邊。
寫入用暫存檔加 rename,與狀態檔同一套。

一個問題的狀態由三個檔案的存在與否決定,沒有另外的狀態欄位要同步:

| question | answer | cancel | 狀態 |
|---|---|---|---|
| 無 | 無 | 無 | 不存在 |
| 有 | 無 | 無 | 未決 |
| 有 | 有 | 無 | 已答 |
| 有 | 無 | 有 | 已取消 |
| 有 | 有 | 有 | 異常。宿主寫 answer 前先查 cancel,寫 cancel 前先查 answer,正常不會發生;掃到就記錯誤,狀態當已取消 |
| 無 | 有或無 | 有或無(至少一有) | 異常。缺 question 的終態檔,掃到就記錯誤並略過 |

終態檔(answer、cancel)壞掉時同上,記錯誤並略過,那個問題視為未決,由逾時收掉。

### 3.2 訊息

```ts
interface PeerMessage {
  readonly id: string                    // 宿主產生,每則唯一
  readonly kind: 'question' | 'answer' | 'cancel'
  readonly from: PeerRef                 // 這則訊息代表誰。人代答時仍是被代答的那個 session
  readonly to: PeerRef
  readonly actor: 'session' | 'user' | 'host'   // 實際寫這則的是模型、人、還是宿主(逾時、重啟、對方結束)
  readonly inReplyTo: string | null      // answer 與 cancel 一定等於 question 的 id
  readonly text: string                  // cancel 的 text 是原因
  readonly createdAt: number
  readonly deadlineAt: number | null     // 只有 question 有值:createdAt + 600_000
}

interface PeerRef {
  readonly linkId: string                // E 規格 §4.1 的 SessionLink.linkId
  readonly provider: 'claude' | 'codex'
}
```

`to` 必須指定一個 session,不能是「任何人」。指定之後畫面才能標示提問者與回答者,宿主也才能
依雙方的等待關係判斷死鎖(第 6 節)。

### 3.3 與 E 共用的欄位

`linkId` 與 `provider` 在 E 規格 §4.1 的狀態檔版本 2。本子專案採用 E 規格 §4.1 定義的
版本 2 全套欄位與版本 1 的轉換規則(`linkId = sessionId`、`provider = 'claude'`、
`parentLinkId = parentSessionId`、`models = []`、`switchPhase` 補 `mode` 與 `target`),
不是只拉兩個欄位:兩份規格對「版本 2 長什麼樣」只能有一個答案,否則 E 重開時無法再升到 2。
E 暫停的是它的流程(交接、換 session),不是它的資料欄位。

## 4. 工具

兩邊形狀一樣。Claude 那邊掛在 B 的程序內 MCP server(每專案一份),codex 那邊是
`thread/start` 的 dynamic tool。宿主只有一份 `askPeer`、`answerPeer` 實作,兩邊只是接線不同。

### 4.1 `ask_peer`

```ts
ask_peer({ question: string; to?: string })
```

- 回傳:對方的 `answer.text`。
- 錯誤:`to` 解析不到(第 5 節)、死鎖(第 6 節)、逾時、對方 session 結束、被人取消。每種各一句
  繁中,照 B 的 `MSG` 表的做法集中在一處。
- 阻塞:MCP 工具呼叫要能等 10 分鐘,B 的裁決 32 已把 `createSdkMcpServer` 的 `timeout` 設成
  `HANDOFF_TIMEOUT_MS + 60_000`,這裡沿用同一個值。codex 那邊 `item/tool/call` 是 server 對
  client 的請求,回覆前 turn 不結束(RESULTS-11)。
- 同一個 session 同一時間只能有一個未決的問題:工具本身是阻塞的,這件事自然成立;宿主仍然檢查,
  第二次呼叫直接回錯誤。

### 4.2 `answer_peer`

```ts
answer_peer({ id: string; text: string })
```

- 寫 `answer-<id>.json`,立刻回「已回答」。
- 錯誤:`id` 不存在、已答、已取消、問題不是問這個 session 的。

### 4.3 工具描述

描述要讓模型知道什麼時候該用:「向同一個專案裡另一個正在工作的 AI 同伴提問,會等到對方回覆。
只有你不知道答案而同伴可能知道時才用;不要用它閒聊或確認自己已經知道的事。」

不在描述裡列出有誰。同伴會來來去去,而 codex 的 dynamic tool 描述在 `thread/start` 就定了,
Claude 的 MCP 工具描述在 server 建立時就定了,兩邊都改不了。有誰由 `to` 的錯誤訊息告訴模型。

## 5. `to` 的解析

`to` 選填。宿主看同一專案裡除了問的那方之外還活著的 session:

| 活著的其他 session | 處理 |
|---|---|
| 0 個 | 錯誤:「這個專案沒有別的同伴」 |
| 1 個 | `to` 省略就是它;`to` 有給就要對得上 |
| 2 個以上 | `to` 必填;錯誤訊息列出每一個:`linkId` 前 8 碼、provider、最近一則使用者訊息的前 40 字 |

`to` 先比對完整 `linkId`,對不上再比對前 8 碼;前 8 碼對到超過一個時回錯誤並列出完整 id。
只有一個候選但 `to` 對不上時,同樣回錯誤並列出那一個。所有解析失敗的錯誤訊息都列候選。

「活著」的定義:D 的 conversation core 存在且未 dispose,或 codex adapter 的 thread 存在且
未結束。解析完成到寫檔之間目標可能剛好結束:寫 question 之後注入失敗(core 已 dispose、
`turn/start` 回錯誤),宿主寫 cancel(原因「同伴已結束」),`ask_peer` 以那個原因結束。

## 6. 注入、逾時、死鎖、介入

### 6.1 注入對方 session

宿主寫完 question 檔之後,注入對方 session 一則訊息:

```
同伴(codex,01a084bf)提問:<question.text>
用 answer_peer 回答,id 是 <id>。答不出來也要回答「答不出來」加原因,不要不回。
```

- Claude:走現有的串流輸入,跟使用者打字同一條路。
- codex:`turn/start`,`input: [{ type: 'text', text }]`。
- 對方回合進行中:排隊,等它的回合結束再注入。Claude 看 conversation core 的 `busy`,codex 看
  `turn/completed`。不用 `turn/steer` 插隊,插隊會打斷對方正在做的事。
- 排隊期間問的那方繼續等,10 分鐘的逾時從 question 寫入時算,不從注入時算:問的那方感受到的
  是「我等了多久」。
- 答的那方在背景時,注入照樣進行,它的回合在背景跑。它若用到需要批准的工具,那張卡會出現在
  人正在看的畫面上,標明是哪個對話要求的(D2 規格 §11,2026-09-10 修訂)。人不必先猜要切到
  哪裡去按。批准逾時 5 分鐘,問題的上限 10 分鐘,一張沒人理的卡不會把提問拖到逾時之外。

### 6.2 畫面

注入的訊息在對方畫面畫成獨立一輪,角色標「同伴提問」,不是「你」。做法同壓縮摘要那次:
`events.ts` 認出來源、`fold.ts` 自成一輪、`Turn.tsx` 換標籤。對方的 `answer_peer` 呼叫畫成
「回答同伴」。問的那方畫面上,`ask_peer` 那個 tool block 在等待期間顯示「等同伴回答,已等 n 秒」,
收到答案後顯示答案。

兩邊都看得到誰在問誰、答了什麼。

同伴提問、回答、取消都不在 SDK 的逐字稿裡(注入的訊息在逐字稿裡是一則普通的 user message,
answer 與 cancel 完全不在)。所以切回專案的重播、開歷史對話的檢視,都要由宿主在該 session 的
事件流裡合併信箱裡 `from` 或 `to` 等於這個 `linkId` 的訊息,依 `createdAt` 排進去。
這是第 7 節「重啟時兩邊畫面各留一則」能成立的機制:那一則來自信箱,不是來自逐字稿。

### 6.3 逾時

`deadlineAt = createdAt + 600_000`。宿主每 5 秒掃一次未決問題(與 B 的 handoff 逾時同一個
時鐘來源,可注入),過期就寫 `cancel`(原因「同伴 10 分鐘內沒有回答」),讓 `ask_peer` 以那個
原因結束。10 分鐘是產品預設,不是服務承諾。

同一次掃描也負責把答案交給等待中的 `ask_peer`:`answer_peer` 寫完檔之後直接在行程內喚醒
等待方,掃描只是行程內喚醒失敗時(例如寫檔方是人、或另一個行程)的後盾,答案最多晚 5 秒送達。
answer 檔壞掉(不是 JSON、缺 `text`)時不等逾時,立刻寫 cancel(原因「答案檔損毀」)。

### 6.4 死鎖

只有一種形狀:A 正在等 B,B 又問 A。宿主收到 B 對 A 的 question 時先查「A 是否有未決問題,
且 `to` 是 B」,是就不寫檔,直接回 B 錯誤:「對方正在等你回答 #<id>,先回答它」。

不做更一般的偵測(三方以上的環)。第 2 節限制一問一答、每個 session 同時只有一個未決問題,
三方環要三個 session 同時各卡一個問題,而且本子專案只支援兩邊。

### 6.5 人的介入

每則未決問題在兩邊畫面都有兩顆按鈕:

- 「代替回答」:開一個輸入框,送出就是幫對方寫 answer 檔,`from` 沿用原問題的 `to`
  (provider 因此正確),`actor: 'user'`。
- 「取消」:寫 cancel(原因「使用者取消」),`actor: 'user'`,`ask_peer` 立刻以錯誤結束。

各種 cancel 的欄位:

| 原因 | from | to | actor |
|---|---|---|---|
| 逾時 | 原問題的 to | 原問題的 from | host |
| 同伴已結束 | 原問題的 to | 原問題的 from | host |
| 提問方已結束 | 原問題的 from | 原問題的 to | host |
| 重啟時取消 | 原問題的 to | 原問題的 from | host |
| 使用者取消 | 原問題的 to | 原問題的 from | user |

這是 roadmap §5「單一輸入控制者」的具體形式:模型之間的對話,人隨時接得走。

## 7. 失敗

| 情況 | 處理 |
|---|---|
| 問的那方 session 結束(dispose、換 session、崩潰後重啟) | 宿主寫 cancel(原因「提問方已結束」)。對方之後呼叫 `answer_peer` 拿到「問題已取消」,不是靜默吞掉 |
| 答的那方 session 結束 | 宿主立刻寫 cancel(原因「同伴已結束」),`ask_peer` 不等 10 分鐘 |
| app 重啟 | 啟動時掃信箱,所有未決問題寫 cancel(原因「重啟時取消」)。兩邊畫面各留一則。本期不做工具呼叫的持久化與重新綁定,重啟後只取消舊問題並更新對話紀錄裡那個工具的狀態 |
| 信箱目錄不可寫(唯讀、權限) | `ask_peer` 回錯誤,不 fallback 到行程內佇列。fallback 會讓「有時候走檔案、有時候不走」變成第二套行為 |
| question 檔壞掉(不是 JSON、缺欄位) | 掃到就記錯誤並略過,不刪。人可以自己看 |

## 8. 分期

| 期 | 內容 | 驗收 |
|---|---|---|
| D2 | 每個專案多個對話分頁:執行期改成每個對話一個 conversation core 與一份 MCP server,批准與待批准記號依對話而非專案。D 的資料模型已允許,只改執行期與分頁列 | 同一專案開兩個 Claude 對話,各自送訊息、各自批准、切走切回都對 |
| 5a | 信箱、兩個工具、注入、畫面、逾時、死鎖、介入、重啟取消、重播合併。只有 Claude 對 Claude,依賴 D2 | 第 10 節的實機五項 |
| 5b | codex adapter:yeschef 裡的 codex 對話分頁。`item/*` 通知轉成現有的 `Event`,`item/commandExecution/requestApproval` 與 `item/fileChange/requestApproval` 對到批准卡,`thread/tokenUsage/updated` 對到用量顯示,錯誤對到現有的錯誤卡。5b 另立子專案,完成後可獨立提供 codex 對話分頁 | 另立規格 |
| 5c | codex 那邊接 `ask_peer` 與 `answer_peer`(dynamic tools),跨模型跑通 | 第 10 節五項再跑一次,兩個方向 |

順序(2026-09-09 使用者裁決,同日更正):D2 → 5b → 5c,5a 依需求。原本想先做 5b 避開 D2,
理由是「codex 對話與 Claude 對話天生是兩個 core」;那句話只對了 core 那一層,`agent:events` 與
`session:state` 是每個專案一條、renderer 每個專案一個 view,同一專案第二個對話不管是誰都需要 D2。
使用者的例子是「Claude 寫規格、codex 實作」,跨模型仍是主要目標,所以 D2 之後先 5b 不先 5a。
D2 與 5b 各自另立規格。

## 9. 安全

- 信箱在 `.yeschef/` 裡,不進 git,內容是兩個模型之間的問答文字。跟 E 規格 §9 同一條規則:
  不遮蔽,遮蔽做不完整反而讓人以為安全。
- `to` 只能指向同一專案的 session。跨專案不做:那是另一個範圍的問題,而且 D 的每專案一份
  MCP server 本來就把工具限制在專案內。
- 注入的訊息以「同伴提問」開頭,模型看得出來源;但它跟使用者訊息走同一條路,模型可以被同伴
  的問題帶著走。這是本設計接受的事,人的介入(6.5)是它的煞車。

## 10. 測試與驗收

單元測試:

- 信箱狀態判定:三個檔案的八種組合,含四種異常的記錯誤與略過。
- `to` 解析:零個、一個(省略與指定)、多個(缺 `to`、對得上、對不上)、前 8 碼比對。
- 死鎖:A 等 B 時 B 問 A 被拒;A 等 B 時 B 呼叫 `answer_peer` 回答 A 的問題照常成功。
- 逾時:時鐘可注入,599 秒不取消、600 秒取消,原因正確。
- 每個 session 同時一個未決問題:第二次 `ask_peer` 回錯誤。
- 重啟掃描:未決全取消、已答已取消不動、壞檔略過並記錯誤。
- `answer_peer` 的四種錯誤。
- 排隊:對方 `busy` 時不注入,`busy` 解除後注入一次。
- 事件與 fold:同伴提問自成一輪、`answer_peer` 的 tool block 標籤;重播與歷史檢視從信箱合併同伴訊息,順序依 `createdAt`。

覆蓋率沿專案門檻(Stmts ≥ 93、Branch ≥ 86)。

實機(5a):

| # | 項目 | 通過條件 |
|---|---|---|
| 1 | A 問 B,B 答,A 的回合用到答案 | A 的最終回覆包含 B 給的內容;兩邊畫面各有「同伴提問」與「回答同伴」 |
| 2 | B 回合進行中時 A 問 | B 的回合先跑完,才出現同伴提問;A 的等待秒數看得到 |
| 3 | 人代替回答 | A 拿到人寫的文字;B 的畫面看得到這題被人答了 |
| 4 | A 等 B 時 B 問 A | B 的 `ask_peer` 立刻回錯誤,A 的問題不受影響 |
| 5 | A 問 B 之後殺掉 app 重開 | A、B 畫面各一則「重啟時取消」;信箱裡有 cancel 檔 |

每項至少跑 2 次,樣本變異的教訓見 `~/.claude/rules/common/measurement.md`。

## 11. 不採用的做法

- 拿對方的下一段輸出當答案:分不出工具呼叫、反問、答一半,協定會有模糊地帶(第 2 節)。
- 訊息匯流排:見第 1 節。
- 行程內佇列取代檔案:codex 那邊之後可能不在同一個行程(app-server daemon 模式),E 規格已把
  `.yeschef/` 定成兩邊都讀得到的地方。代價是多一層 watch。
- `turn/steer` 插隊:打斷對方正在做的事。
- `list_peers` 工具:`to` 解析失敗時已回傳同伴清單,本期不另提供。
- 恢復重啟前阻塞中的 `ask_peer`:本期不做工具呼叫的持久化與重新綁定;重啟後取消舊問題,並更新對話紀錄裡那個工具的狀態。

## 12. 參考

- `docs/RESULTS-11-codex-dynamic-tools.md`:codex app-server `dynamicTools` 的實測,含
  `initialize` 要宣告 `experimentalApi`、請求要帶 `jsonrpc: "2.0"`。
- `docs/specs/2026-09-08-yeschef-handoff-design.md` §4.1、§4.2、§9:`SessionLink` 欄位、
  `.yeschef/` 目錄規則、不遮蔽的理由。
- `docs/superpowers/plan-b/CONTRACT.md` 裁決 32:MCP 工具的逾時設定。
- `src/main/view-tools/handoff.ts`:阻塞式工具的既有實作。

## 13. 修訂紀錄

| 日期 | 章節 | 變更 | 依據 |
|---|---|---|---|
| 2026-09-09 | 全 | 初版。三節設計逐節經使用者確認 | roadmap 2026-09-09 裁決、RESULTS-11 |
| 2026-09-09 | §2、§3.1、§3.2、§5、§6.5、§7、§11 | 套用 codex 第一輪審查看得到的 12 條:狀態表補異常組合、檔名用 question id、`actor` 欄位、`to` 前綴歧義、cancel 欄位對應表、訊息種類前後矛盾 | codex 審查(輸出被截斷,前 8 條遺失) |
| 2026-09-09 | §2、§8 | 使用者裁決順序改為 5b → 5c,D2 與 5a 延後到有需求。實作委派 codex gpt-6-astra | 使用者裁決 |
| 2026-09-09 | §2、§8 | 更正:IPC 頻道與 renderer view 都是每專案一份,第二個對話不論後端都需要 D2。順序改為 D2 → 5b → 5c | 5b 設計第二節時發現 |
| 2026-09-09 | §0、§3.3、§6.1、§6.2、§6.3、§8、§10 | 自查:D 每專案只有一個 core,同專案兩個 Claude session 開不出來,加前置 D2;版本 2 改採 E 的全套欄位;同伴訊息不在逐字稿,重播與歷史要從信箱合併;答的那方在背景時批准會被扣住;答案送達最多晚 5 秒、答案檔損毀立即取消;測試清單一條講不通的改掉 | 外部審查兩次因記憶體不足被殺,改自查 |
| 2026-09-10 | §6.3、§8 | 5a 拆兩階段:第一階段(機制與兩個工具)完成並實機驗收。背景對話的批准不再扣住,改由人正在看的畫面授權(D2 規格 §11);第二階段一起做 §6.2 的畫面與 §6.5 的人的介入 | 使用者裁決 |

