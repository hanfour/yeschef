# 子專案 D2:每個專案多個對話

## 0. 範圍與依賴

D 的資料模型允許一個專案有多個對話分頁(`TabEntry` 的 `contentType: 'conversation'` 各帶
`threadId`),但執行期是每個專案一個 conversation core(`ipc-bridge.ts` 的 `Map<projectId, Slot>`),
`agent:events` 與 `session:state` 每個專案一條,renderer 的 `useConversation` 每個專案一個 view,
分頁列只畫一個「Claude 對話」。D2 把執行期與畫面補到跟資料模型一樣:一個專案可以開多個對話,
每個對話一個 core、一個 view、自己的批准。

依賴:子專案 D。被依賴:子專案 5b(codex 對話是第二個對話)、子專案 P 的 5a。
E 規格 §4.1 的狀態檔版本 2(`SessionLink.linkId`、`provider`)在這裡一起升,
理由見 P 規格 §3.3。

不做:對話分頁的拖曳排序、分割畫面同時顯示兩個對話。分頁列的行為沿用 C:同時只看一個。

## 1. 已定案的取捨

| 項目 | 決定 |
|---|---|
| 對話的識別 | 用 `TabEntry.id`(狀態檔裡持久化),叫 `conversationId`。不新增另一個 id |
| core 的對應 | 一個對話分頁一個 core;slot 依 `conversationId` 而不是 `projectId` |
| IPC | `agent:events`、`session:state`、`agent:approval:ask` 三個頻道的 payload 都帶 `conversationId`;`approval:ask` 保留 `projectId`(昨天加的),兩個都要 |
| renderer | `useConversation` 改成每個對話分頁一份 view,依 `conversationId` 分流;`useApprovals` 的過濾從 `projectId` 改成 `conversationId` |
| 前景 | 同時只有一個對話是前景(active 專案的 active 分頁);其他對話回合照跑、事件記 log。批准原本扣住,2026-09-10 改成一律送到人正在看的畫面(見 §11) |
| 分頁列 | 「+」旁多一個「新對話」;每個對話分頁可關閉,關閉前若回合進行中要確認 |
| `provider` | `TabEntry` 的 conversation 分頁加 `provider: 'claude' \| 'codex'`,版本 1 讀進來預設 `'claude'`;D2 只會建 `'claude'`,`'codex'` 由 5b 建 |
| 狀態檔 | `schemaVersion` 升到 2,採用 E 規格 §4.1 的全套欄位與轉換規則 |
| Recents | 「本專案」不變(依 cwd);點歷史對話時開在**現行**對話分頁,不自動新開分頁 |
| thread 共用 | 一條 thread 只給一個對話分頁指著。點的歷史 session 已經是別的分頁的 thread 時,為現行分頁另建一條 thread、起點是同一場 session;兩個 core 不會 resume 同一個 session 去續寫同一份 transcript |

## 2. 資料模型

`src/shared/projects.ts`:

```ts
interface TabEntry {
  // 既有欄位不動
  readonly provider?: 'claude' | 'codex'     // contentType 為 'conversation' 時有值;缺就是 'claude'
}
```

`SessionLink` 依 E 規格 §4.1 版本 2:加 `linkId`、`provider`、`parentLinkId`、`models`;
`SwitchPhase` 補 `mode` 與 `target`。版本 1 的轉換規則照 E 規格。

`src/shared/ipc.ts`:

```ts
interface ConversationScoped { readonly conversationId: string }
// agent:events 的 payload 從 Event[] 改成 { conversationId, events }
// session:state 從 SessionState 改成 { conversationId, state }
// ApprovalAskPayload 加 conversationId
```

三個頻道的 `parse*` 都要驗 `conversationId` 是非空字串,缺就整筆丟棄並記錯誤,規則同
`parseApprovalAsk` 對 `projectId` 的做法。

## 3. 主行程

`ipc-bridge.ts`:

- `slots: Map<conversationId, Slot>`,`Slot` 加 `projectId`。
- `createSlot(conversationId)`:從狀態檔找到那個分頁與它的專案,`runtimeFor(projectId, rootPath, isActive)`
  的 `isActive` 改成「這個對話是前景」。
- `switchTo(nextConversationId)`:前一個對話 `deactivate()`,下一個 `activate()`。專案切換時
  用該專案的 active 分頁;分頁切換(同專案)也走這裡。
- `projects.subscribe`:專案被移除或 rootPath 變動時 dispose 該專案底下所有對話的 slot;
  對話分頁被關閉時 dispose 那一個 slot(回合進行中先 interrupt,沿用 D 的收尾順序)。
- sink 補 `conversationId`:`events`、`state`、`approvalAsk` 三個都在 sink 包裝層加,core 不知道自己是誰
  (同 `projectId` 的做法)。
- `agent:input` 送給前景對話的 core。沒有前景對話(專案沒有對話分頁)時記錯誤丟棄。

`view-tools`:每個對話一份 MCP server(現在是每個專案一份),前景守衛改成「這個對話是前景」。
右窗格仍然只有一個,背景對話呼叫瀏覽器工具回 `MSG.browserBusy`,規則不變。

`projects-state.ts`:

- `openConversationTab(state, projectId, tabId, threadId, now)`:新增一個 conversation 分頁與一條空 thread,
  `sortOrder` 排在最後,`lastFocusedAt = now`(新開的立刻成為 active 分頁)。
- `closeTab` 現在拒絕關 conversation 分頁(D 的規則:對話分頁至少一個);改成「一個專案至少留一個
  conversation 分頁」,關掉最後一個才拒絕。
- `pointTabAt`、`startThread`、`pointConversationAt`、`recordSession`、`lastSessionId` 這些現在假設
  「專案的對話分頁」是單數(`conversationTab(entry)`),全部改成收 `conversationId`。

## 4. renderer

- `useConversation(api, conversationId)`:訂閱 `agent:events` 與 `session:state`,只收
  `conversationId` 相符的;每個掛載中的對話分頁一份。
- `LeftPane`:conversation 分頁比照終端分頁,曾經 active 過的都常駐掛載、用 `hidden` 切換
  (C 的 `useSeen` 規則),切走不卸載才不會丟串流中的畫面。
- `useApprovals(api, conversationId)`:過濾條件從 `projectId` 換成 `conversationId`,其餘不動。
- `Composer` 送到前景對話。
- 分頁列:conversation 分頁顯示 `provider` 的名字(「Claude 對話」「codex 對話」)加序號或
  自訂標籤;「新對話」按鈕只開 `'claude'`,`'codex'` 的入口由 5b 加。
- 待批准記號(D 的黃點)從專案格移到分頁:哪個對話扣著批准,那個分頁亮。專案格維持「底下任一
  對話有」就亮。

## 5. 失敗

| 情況 | 處理 |
|---|---|
| 狀態檔版本 1 | 依 E 規格 §4.1 轉換成版本 2 後寫回;conversation 分頁補 `provider: 'claude'` |
| 狀態檔裡的對話分頁指到不存在的 thread | 建 slot 時記錯誤,那個分頁當新對話:`initialSessionId` 為空,畫面是空的,狀態檔不動;下一次收到 `session-started` 時為這個分頁補一條 thread 再記 session,之後就接得上 |
| 關閉回合進行中的對話分頁 | 先問「回合進行中,確定關閉?」;確定就 interrupt 再 dispose |
| 關最後一個 conversation 分頁 | 拒絕,提示「至少留一個對話」 |
| 兩個對話同時要右窗格 | 背景那個回 `MSG.browserBusy`,同 D |

## 6. 測試與驗收

單元:

- 狀態檔版本 1 → 2 的轉換,每個欄位的預設值;版本 2 再讀不再轉。
- `openConversationTab`、`closeTab` 的「至少留一個」、`recordSession` 收 `conversationId` 後的去重。
- 三個 IPC parse 對 `conversationId` 的驗證。
- `ipc-bridge`:兩個對話各自的事件不互串;切分頁 deactivate／activate 的順序與 D 相同;
  關閉對話分頁 dispose 正確的 slot;移除專案 dispose 底下全部。
- `useConversation` 依 `conversationId` 分流;`useApprovals` 依 `conversationId` 過濾。
- 待批准記號:分頁層與專案層。

實機:

| # | 項目 | 通過條件 |
|---|---|---|
| 1 | 同一專案開兩個 Claude 對話,各送一則 | 兩個畫面各只有自己的回覆,jsonl 是兩個不同的 session |
| 2 | A 對話跑長回合,切到 B 對話送訊息,再切回 A | A 的結果完整;B 的畫面沒有 A 的字 |
| 3 | A 對話的批准在背景到達,切到 B 看不到,切回 A 看得到 | 同 RESULTS-08 第 3 項,但分頁層 |
| 4 | 關掉 A 對話,B 照常;關最後一個被拒 | 提示文字正確 |
| 5 | 版本 1 的狀態檔重開 | 升到版本 2,對話分頁 `provider: 'claude'`,舊 thread 照常接上 |
| 6 | 記憶體 | 3 個對話各跑過 1 回合,比單一對話多不超過 150 MB(RESULTS-08 的查核線) |

## 7. 不採用的做法

- 保留每專案一個 core,codex 對話用另一套 IPC:兩套通道,renderer 要認兩種,5c 的 `ask_peer` 兩邊長不一樣。
- 對話分頁另設一個 id 不用 `TabEntry.id`:多一個要同步的東西。
- 分割畫面同時顯示兩個對話:C 的分頁模型是同時只看一個,先不打破。

## 8. 修訂紀錄

| 日期 | 章節 | 變更 | 依據 |
|---|---|---|---|
| 2026-09-09 | 全 | 初版。內容在 5b 設計第二節前經使用者確認 | P 規格自查、5b 設計 |
| 2026-09-09 | §1、§5 | 實作後補:thread 不給兩個分頁共用;「指到不存在的 thread」的處理講明是記錯、當新對話、下一場 session 自癒 | 整條分支最終審查的 Important 1、2 |
| 2026-09-09 | §6 | 六項實機驗收全部通過 | `docs/RESULTS-12-d2-acceptance.md` |

## 11. 批准由前景授權(2026-09-10 修訂)

原本的做法:對話在背景時發出的批准扣在主行程,不送給 renderer,等那個對話被切到前景才一次
放出來。分頁上只有一個待批准記號。這在單人一次只顧一個對話時可行,但同伴問答讓對話會在背景
自己動起來,答的那一方一旦需要批准就卡住,而人不知道要切到哪裡去按。

改成:任何對話發出的批准都直接送給 renderer,卡片出現在人正在看的畫面上。

| 項目 | 決定 |
|---|---|
| 扣住 | 拿掉。`requestApproval` 不再看自己是不是前景,一律進批准登錄表 |
| 卡片位置 | 前景對話的畫面。不屬於這個對話的卡片排在自己的卡片之後 |
| 標示 | 別的對話的卡片標明專案名與對話標籤,例如「proj5 · B」 |
| 跳轉 | 點那個標示就切到那個專案與對話 |
| 逾時 | 30 秒改成 5 分鐘,前景背景同一個值。卡片現在一定在人眼前,30 秒是為了「你正在看的那張卡」選的,對別的對話的卡太短 |
| 待批准記號 | 來源從「扣住的數量」改成「這個對話有幾張在等的卡」 |
| 跨專案 | 一併適用。批准 payload 本來就帶 `projectId` 與 `conversationId`,renderer 只有一份,不必新增頻道 |

代價:真的沒人理的卡會把那個對話卡住 5 分鐘而不是 30 秒。同伴問答的上限是 10 分鐘,還在預算內。

