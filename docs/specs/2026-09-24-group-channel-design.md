# 群組頻道:人、主廚與各 agent 在同一條訊息流

- 日期:2026-09-24
- 狀態:設計完成,待寫實作計畫
- 依據:`docs/PLAN-auto-chef-routing-2026-09-21.md`(主廚的任務、工作單位與執行紀錄)、`docs/specs/2026-09-09-yeschef-peer-design.md`(跨對話注入的前例)
- 後續:分工表(另一份規格,把 `chooseModel` 從評分改成查表)

## 1. 要解決什麼

現在 Claude、Codex 與 Grok 各自有一條對話,使用者要在分頁之間切換才知道誰在做什麼。主廚已經會自動派工,但它沒有畫面也不會說話,你只能在對話框填表單開任務,看卡片式的摘要。

這份規格加一種分頁:群組。你在裡面跟主廚設目標,主廚拆任務派給各 agent,派工、進度、完成與卡住都出現在同一條流上,你可以 `@` 某個 agent 直接跟它說話。要看某個 agent 的完整過程,點進它自己的分頁。

## 2. 已決定的事

| 題目 | 決定 |
|---|---|
| 群組與個別分頁的關係 | 新增第三種分頁,個別對話分頁不動 |
| 訊息流的來源 | 群組有自己的 `GroupMessage[]`,不聚合既有對話的事件,`fold()` 不改 |
| agent 在群組說什麼 | 里程碑自動產生,另加 `say_to_group` 讓它主動發言 |
| 誰會被觸發 | 只有你的訊息會 deliver 給 agent;里程碑與 `say_to_group` 不觸發任何人 |
| 你的訊息送給誰 | 預設當前 thread 的主廚,`@label` 指定某個 agent |
| thread | 就是現有的 `ChefTask`,一個專案一個群組,裡面每個目標一個 thread |
| 主廚 | 一個真的對話(現有的 chef worker),不是規則引擎 |
| 主廚 guard | 群組送訊息略過 guard,那是被管理的對話唯一該被說話的地方 |

## 3. 資料

### 3.1 `GroupMessage`

`src/shared/group.ts`:

```ts
export const GROUP_CHANNEL = 'group:manage'

export const GroupSenderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
  z.object({
    kind: z.literal('agent'),
    conversationId: z.string().min(1),
    label: z.string().min(1).max(40),
    provider: providerSchema,
    role: z.enum(['chef', 'worker']),
  }).strict(),
])

export const GroupMessageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  threadId: z.string().min(1),              // ChefTask.id 或 'general'
  at: z.number().int().nonnegative(),       // epoch ms
  from: GroupSenderSchema,
  kind: z.enum(['text', 'goal', 'delegated', 'progress', 'report', 'blocked', 'joined', 'left']),
  text: z.string().max(4000),
  mentions: z.array(z.string().max(40)).max(10),
  deliveredMentions: z.array(z.string().max(40)).max(10).optional(), // 實際送達的收件人
  unitId: z.string().optional(),
}).strict()
```

`label` 是參與者在群組裡的名字。主廚固定叫 `主廚`;worker 叫 `<provider>-<序號>`,序號是該 thread 裡該家的第幾個 attempt(`codex-1`、`codex-2`、`grok-1`)。label 在寫入訊息時就算好並存進去,之後 attempt 增減都不會改動歷史訊息上的名字。

### 3.2 儲存

每個專案一個 append-only 的 NDJSON,放 `<userData>/yeschef-group/<projectId>.ndjson`。追加一則寫一行;程式中斷最多壞最後一行,讀取時跳過解析失敗的行並記一次 log。不放專案目錄的理由跟同伴信箱一樣:那裡可能被 `git clean -fdx` 清掉。

讀取只取最後 2000 則。啟動時檔案超過 5 MB 就裁掉前半(讀進來、留後半、原子寫回),記一行 log。

```ts
export interface GroupStore {
  append(message: GroupMessage): Promise<void>
  read(projectId: string): Promise<readonly GroupMessage[]>   // 最後 2000 則,舊到新
  dispose(): Promise<void>
}
export function createGroupStore(dir: string, logError: (e: Error) => void): GroupStore
```

`append` 內部對同一個專案序列化寫入(一條 promise 鏈),避免兩個來源同時追加時交錯成壞行。

### 3.3 thread 清單

thread 不另外存,每次從主廚的任務算出來:

```ts
export interface GroupParticipant {
  readonly label: string
  readonly conversationId: string
  readonly provider: Provider
  readonly role: 'chef' | 'worker'
  readonly unitTitle?: string
}
export interface GroupThread {
  readonly id: string                 // ChefTask.id 或 'general'
  readonly title: string              // task.goal 前 60 字;general 是「未分派」
  readonly status: 'open' | ChefTask['status']
  readonly createdAt: number          // task.createdAt;general 固定 0。§5 挑「最近活動的進行中 thread」要用
  readonly holdsWorkspace: boolean    // task 尚佔工作目錄,包含 needsReconciliation 的 blocked 任務
  readonly participants: readonly GroupParticipant[]
}
```

`general` 永遠存在,排在最前面,裝還沒變成目標的訊息。

## 4. 誰寫進群組

三個來源:

| 來源 | 路徑 | 觸發誰 |
|---|---|---|
| 你 | composer 送 `group:manage` 的 `send` | 沒 `@` 就是當前 thread 的主廚;`@label` 就是那個 agent |
| 主廚與 worker | 新工具 `say_to_group(text)` | 不觸發任何人 |
| 系統 | chef service 在五個時機自動寫 | 不觸發任何人 |

### 4.1 `say_to_group`

加進 `src/main/chef/tools.ts` 的 `CHEF_TOOL_NAMES`,三家共用同一份定義(Claude 走 SDK MCP、Codex 走 dynamicTools、Grok 走 HTTP MCP server)。參數 `{ text: z.string().min(1).max(2000) }`。角色開放:主廚拿得到全部四個工具,worker 拿得到 `task_progress` 與 `say_to_group`。一般對話分頁不是主廚管理的對話,拿不到這個工具。

描述文字:「在專案群組裡對人與其他工作者說一句話。用在需要讓大家知道的事:你打算怎麼做、遇到什麼取捨、需要誰配合。不用在逐步進度上,那些會自動出現。」

### 4.2 系統里程碑

chef service 多一個選填的 dep `group?: { write(input: GroupMessageInput): void }`,在五個時機呼叫:

| 時機 | kind | 內容 |
|---|---|---|
| `delegate()` 排進新 unit | `delegated` | 主廚把 `<title>` 交給 `<kind>` 的工作者 |
| `drain()` 起一個 attempt | `joined` | `<label>` 加入,負責 `<unit.title>`,用 `<model>`;codex 另附實際推理強度 |
| `progress()` 被呼叫 | 不寫 | 查詢不是事件 |
| `finish()` unit 完成 | `progress` | `<label>` 完成 `<unit.title>` |
| `finish()` unit 卡住或 `block()` | `blocked` | `<label>` 卡在 `<unit.title>`:`<reason>` |
| `report()` 生效(task 收尾) | `report` | 任務結束:`<outcome>`,`<summary>` 前 500 字 |
| attempt 結束且 unit 還沒完成 | `left` | `<label>` 離開,`<reason>` |

寫入失敗只記 log,不影響主廚的任務流程。

上游回 404 並說明模型不存在或不被支援時,那個 attempt 記成 `failed`(`failureKind: 'model-unavailable'`),unit 回到可再派的狀態,群組寫 `left` 而不是 `blocked`。同一個 task 之後的所有 unit 都不再選這個模型;同 provider 的其他模型照常參與排序。其他失敗類型維持只在同一個 unit 內排除。改派同樣受 `maxExecutions` 限制。

改派的候選同分時,依模型清單的原始順序(codex 為 `model/list` 回傳的順序),不依字母順序。

主廚起 codex worker 時在 `turn/start` 明確帶 `effort`,不靠繼承使用者的全域設定。值由 `src/main/codex/reasoning-effort.ts` 決定:全域值(先用 app-server 的 `config/read`,讀不到才讀 `~/.codex/config.toml` 的 `model_reasoning_effort`)在該模型的 `supportedReasoningEfforts` 內就照用;不在就取不超過全域值的最高一級(例如 `max` 降到 `xhigh`);全域值讀不到或模型沒有支援清單就不帶,由 codex 用模型預設。

### 4.3 `task_progress` 回傳群組訊息

`service.progress(workerId)` 改成 async,回傳多一個欄位 `groupMessages`,是該 thread 最近 20 則(`text` 各截 300 字),從 store 讀而不是只看記憶體,這樣重開 app 之後接續任務時主廚仍看得到先前的群組訊息。`tools.ts` 的 `call` 本身已經是 async,只要多一個 `await`。主廚想知道群裡發生什麼就自己查,系統不推播給它,所以不會有「worker 每報一次進度就害主廚跑一輪」的成本。

使用者 `@` 給其他參與者且已送達的訊息,在 `groupMessages` 裡帶 `mentions` 與 `deliveredToParticipant: true`。`task_progress` 的工具說明寫明這類訊息已由對方處理,主廚只當背景資訊,不另開 unit 代辦或重做。`@` 主廚本人或沒有 `@` 的訊息不帶這兩個欄位。

### 4.4 任務結束與期限延長

任務因期限、使用者停止或工作台關閉而停止或卡住時,群組寫入一則系統訊息,說明原因並提示「在這個目標裡回覆即可接續」。工作單位已寫過卡住里程碑時,該則里程碑包含相同提示,不再重複寫任務層訊息。

預設期限為 120 分鐘,主廚控制台可設定 1 至 240 分鐘。期限剩 10 分鐘且至少有一個執行中的 attempt 時,主廚以一次性無工具判斷詢問是否延長;同一個期限只問一次,延長後的新期限可再問。到期時若判斷仍在進行,最多等 2 分鐘,之後視為不延長。每次延長最多 60 分鐘,任務從建立起最多 8 小時。延長、決定不延長與判斷失敗都寫入群組。

## 5. 送訊息與 `@` 解析

`send` 的處理順序。前置檢查(專案不存在、文字為空)失敗才回 `error` 且不寫訊息;走到寫入之後的每一種結果都回 `sent`,狀況用 `system` 訊息說明,這樣輸入框會清空、畫面上看得到發生什麼事:

1. 解析 `@label`:用 `/@([\w\u4e00-\u9fff-]{1,40})/g` 掃出所有被提到的名字,跟該 thread 的參與者 label 比對。有不存在的名字就回一則 `system` 訊息說找不到,並且仍然寫入你的訊息(不 deliver)。參與者在該 thread 最後一則屬於他的里程碑是 `left` 時視為已離開:不 deliver,寫一則 `system` 訊息 `participantLeft`;同一則訊息裡其他有效的收件人照送。之後同一個參與者再 `joined` 就恢復可送。判斷規則是 `src/shared/group.ts` 的 `activeGroupParticipants`,主行程與 renderer 的 `@` 建議清單共用。
2. 寫入你的訊息(`kind` 為 `text`,或該 thread 還沒有任何訊息時為 `goal`)。
3. 決定 deliver 對象:有命中的 `@` 就送給第一個命中的參與者;沒有就送給該 thread 的主廚。畫面上選「全部」時,優先挑 `status` 為 `queued`、`running` 或 `stopping` 且 `createdAt` 最大的 thread;沒有符合時,挑最新且 `holdsWorkspace` 為 true 的 `blocked` thread;再沒有,而所有任務中最新的一個是 `blocked`(例如權限被拒而暫停,不佔工作目錄),就送給它接續;都沒有才走「未分派」。較舊的卡住任務不搶訊息,否則會一直擋住開新目標。規則由 `src/shared/group.ts` 的 `targetThreadForAll` 實作,renderer 的建議清單共用同一個函式。`general` 沒有主廚,見 §6。
4. 訊息送到 `blocked` 或 `cancelled` thread 時,若沒有 `@` 或只 `@主廚`,就把文字附加到任務並接續,不送往已關閉的主廚對話。若 `needsReconciliation` 為 true,不接續也不略過核對,只記錄訊息並說明要先到主廚視窗確認工作目錄。`@` worker 維持原本送給參與者的規則。
5. deliver:走 `IpcBridge` 新增的 `deliverToManaged(projectId, conversationId, text)`。它檢查對話存在且屬於該專案,略過主廚的 `guard`,直接呼叫核心的 `userInput`。文字前面加一行來源標記 `[群組 · 你]`,讓 agent 知道這句話來自群組而不是它自己的分頁。
6. 對象正在工作中(`isBusy()` 為真)時照樣送,並補一則 `system` 訊息「`<label>` 正在工作中,訊息已送出」。行為跟你在那個分頁直接打字一樣,不另外排隊。

略過 guard 的理由寫在程式註解裡:guard 存在是為了擋「從一般介面打擾被主廚管理的對話」,群組是這件事唯一該發生的地方。

## 6. 主廚接目標與 thread

在 `general` 或沒有主廚的 thread 送訊息時,群組 service 呼叫 chef service 新增的內部方法 `start(projectId, goal, policy): Promise<string>` 開一個新任務,它回傳新的 taskId;`handle({ action: 'start' })` 也改成呼叫它再回 snapshot,IPC 契約不變:

- `policy` 用現有的預設:`mode: 'auto'`、`allowed` 是該專案全部可用模型、`maxExecutions: 8`、`deadlineMinutes: 120`。分工表那份規格會換掉這裡。
- 任務建立後,你那則訊息的 `threadId` 從 `general` 改寫成新的 `taskId`(訊息還沒寫入前就知道 taskId,所以直接用新的)。
- 寫一則 `system` 訊息:「開了新目標:`<goal 前 60 字>`,主廚即將就位」。
- 主廚 worker 由 chef 的 `drain()` 自己起,起來時 `joined` 里程碑會出現。
- 主廚的第一個 prompt 由 chef 現有邏輯給,額外附一段:這個任務在專案群組裡進行,用 `say_to_group` 對人與其他工作者說話,用 `task_progress` 看群裡發生什麼。

已經有主廚的 thread,訊息直接 deliver 給主廚,不開新任務。

## 7. IPC

`src/shared/group.ts` 續:

```ts
export const GroupRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), projectId: z.string().min(1) }).strict(),
  z.object({
    action: z.literal('send'),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    text: z.string().min(1).max(4000),
  }).strict(),
])

export const GroupResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), messages: z.array(GroupMessageSchema), threads: z.array(GroupThreadSchema) }).strict(),
  z.object({ kind: z.literal('sent'), threadId: z.string() }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])
```

handler 在 `src/main/group/ipc.ts`,跟 `test-machines/ipc.ts` 一樣檢查 sender。

新訊息用推播,不輪詢:`IPC.groupMessages = 'group:messages'`,payload `{ projectId, messages }`,每次追加後批次送(同一輪事件迴圈內的多則合併成一批)。renderer 收到就往清單後面接。preload 兩端各自 `parse`。thread 清單變動時一併重送整份 `threads`,所以 payload 是 `{ projectId, messages, threads }`。

## 8. 畫面

`TabContentType` 多第三個值 `group`。每個專案固定有一個群組分頁,`isTabEntry` 接受這個值,`threadId` 與 `provider` 都不帶。主行程在載入狀態檔與新增專案時補上缺少的群組分頁(沿用 `openGroupTab` 的冪等規則),並拒絕關閉它;renderer 不畫它的關閉鈕。群組分頁依 `src/shared/projects.ts` 的 `sortTabs` 固定排第一。

分頁列右側的新增動作是一顆分割按鈕:主按鈕開上次用的 provider 的新對話(存在 `localStorage`,預設 Claude),箭頭展開「對話」(Claude、Codex、Grok)與「終端機」兩段選單。分頁放不下時分頁列可橫向捲動,不顯示原生捲軸,有內容溢出的一側邊緣淡出;前景分頁改變時自動捲進可視範圍。

元件 `src/renderer/components/GroupPane.tsx` 加 `.css`,hook `src/renderer/hooks/useGroup.ts`。版面三段:

| 區塊 | 內容 |
|---|---|
| 上方 | thread 膠囊橫列:`全部 ｜ 未分派 ｜ <title>(<status> · N 人)`。點一個就篩選下面的訊息流,預設全部。「全部」與「未分派」不縮;目標膠囊最寬 30ch,超出以省略號截斷,完整文字在 `title` |
| 中間 | 訊息流。每則一列:label 色塊(依 provider 取 `--accent` 系列,你固定一色)、相對時間、內容。里程碑用 `--bg-raised` 的底與 `--text-xs`,跟一般發言區隔。`from` 帶 `conversationId` 的訊息右側一顆小按鈕跳到那個分頁 |
| 下方 | composer。多行輸入,`@` 觸發參與者自動完成,Enter 送出、Shift+Enter 換行,與現有 composer 一致 |

捲動貼底沿用 `Conversation.tsx` 的做法。CSS 只用 `theme.css` 的 token,受 `tests/theme-rules.test.ts` 約束。

## 9. 訊息

`src/main/group/messages.ts` 的 `MSG`,都是繁體中文:

| 鍵 | 內容 |
|---|---|
| `injection(label)` | `[群組 · <label>]` |
| `mentionNotFound(names)` | 群組裡沒有 `<names>`,訊息沒有送給任何人 |
| `busy(label)` | `<label>` 正在工作中,訊息已送出 |
| `threadOpened(goal)` | 開了新目標:`<goal>`,主廚即將就位 |
| `noProject` | 找不到這個專案 |
| `noConversation(label)` | `<label>` 的對話已經關閉 |
| `participantLeft(label)` | `<label>` 已經離開這個目標,訊息沒有送出 |
| `taskResuming` | 任務接續中,主廚會讀到你這則訊息 |
| `reconciliationRequired(reason)` | 任務卡住:`<reason>`。舊執行者可能留下沒核對的工具結果,請到主廚視窗確認工作目錄後按接續。 |
| `resumeFailed(reason)` | 任務接續失敗:`<reason>` |
| `noChef` | 主廚服務沒有啟動,現在開不了新目標 |
| `noModels` | 沒有可用的模型,請先在主廚控制台重新整理模型 |
| `startFailed(reason)` | 開新目標失敗:`<reason>` |
| `delegated(title, kind)` | 主廚把「`<title>`」交給 `<kind>` 的工作者 |
| `joined(label, unitTitle, model, effort?)` | `<label>` 加入,負責「`<unitTitle>`」,用 `<model>`,有指定時接「,推理強度 `<effort>`」 |
| `left(label, reason)` | `<label>` 離開:`<reason>` |
| `unitDone(label, unitTitle)` | `<label>` 完成「`<unitTitle>`」 |
| `unitBlocked(label, unitTitle, reason)` | `<label>` 卡在「`<unitTitle>`」:`<reason>` |
| `taskReport(outcome, summary)` | 任務`<完成 / 卡住>`:`<summary>` |
| `chefPrompt` | 這個任務在專案群組裡進行。用 `say_to_group` 對人與其他工作者說話,用 `task_progress` 看群裡發生什麼。 |

## 10. 測試

| 檔案 | 驗什麼 |
|---|---|
| `tests/group-schema.test.ts` | 三種 sender、八種 kind、多餘欄位被拒、request 與 response 的每個成員 |
| `tests/group-store.test.ts` | 追加後讀得回來;壞行被跳過且記一次 log;超過 2000 則只回最後 2000;超過 5 MB 裁半後舊訊息還在、新訊息接得上;同時追加兩則不會交錯 |
| `tests/group-service.test.ts` | 假的 chef 與 deliver:`@` 命中送對人、沒命中補 system 訊息且不 deliver、沒有 `@` 送主廚、`general` 送訊息會開任務並改寫 threadId、對象忙碌時仍送出並補 system、對話不存在時回 error |
| `tests/group-ipc.test.ts` | sender 檢查、schema 拒絕多餘欄位、`get` 回最後 N 則與 thread 清單、`send` 回 `sent` |
| `tests/chef-group-milestones.test.ts` | 五個時機各寫一則、內容與 label 正確、寫入失敗不影響任務流程 |
| `tests/chef-view-tools.test.ts`(補) | worker 拿得到 `task_progress` 與 `say_to_group`,拿不到 `delegate_task`;主廚四個都有;`say_to_group` 真的寫進 store |
| `tests/use-group.test.tsx` | 初次載入呼叫 `get`;推播來的訊息接在後面;換專案時清空並重新載入 |
| `tests/group-pane.test.tsx` | 三個區塊都在;thread 篩選;里程碑與一般發言的樣式不同;`@` 自動完成列出參與者;送出呼叫 api;跳分頁按鈕 |

## 11. 實機驗收(寫進 `docs/RESULTS-39-group-channel.md`)

1. 開群組分頁,打一句目標,看到「開了新目標」與主廚 `joined`,主廚開始回話。
2. 主廚派工後,群組出現 `delegated` 與新工作者的 `joined`,點旁邊的按鈕跳得到那個分頁。
3. 某個 worker 用 `say_to_group` 說話,群組看得到,而且主廚沒有因此跑一輪。
4. `@codex-1` 說一句話,那個 agent 收到並回應,它的回應不會自動進群組。
5. `@不存在的人` 說話,群組出現「找不到這個人」,訊息沒送出去。
6. 一個 unit 完成與一個 unit 卡住,群組各出現一則對應的里程碑。
7. 關掉 app 再開,群組訊息還在,thread 篩選仍正確。

## 12. 範圍外

不改 `fold()` 與個別對話分頁;不做 agent 之間的自由對談(只有 `say_to_group` 單向發言);不做 `@all`;不做語音;群組訊息不進任何 agent 的 context,除非主廚自己用 `task_progress` 查;不做訊息編輯與刪除;不做跨專案的群組。分工表是另一份規格。
