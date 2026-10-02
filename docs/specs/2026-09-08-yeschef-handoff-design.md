# 子專案 E:交接記錄與換 session

## 0. 這個子專案的位置

使用者的需求原話:「我們能不依賴 agentic context 去紀錄專案,然後能確保 context 在達到自定義長度時候,自動切換到新的 session 繼續。」

拆成兩件事:

1. 專案「做到哪」記在對話 context 之外的檔案,任何模型(Claude、codex、grok)都讀得到。
2. context 到使用者設定的長度時,自動開一條新 session 接著做,而且接得上。

依賴子專案 D(`docs/specs/2026-09-07-yeschef-projects-design.md`):D 把對話分頁定義成一條 thread,底下一串 session;E 負責交接檔、機械快照、換 session 的交易與門檻。分兩期:E1 先做手動的「交接並開新 session」,驗證接續品質;E2 再開自動門檻。

本規格的判斷依據:本機安裝的 Agent SDK 0.3.258 型別檔(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`)、Claude Code 官方文件、與 codex(gpt-6-astra)兩輪討論、社群既有工具調查。細節見第 12 節。

E 也負責後端切換需要的資料基礎:`SessionLink` 記 provider、故障交接的恢復包、工具結果的四類判定。codex 接手本身(app-server 連線、批准對應、右窗格工具)是 roadmap 另一個子專案,不在 E 的實作範圍;E1 先補齊目前已知的跨後端欄位與規則,之後接 codex 時少改一次狀態檔格式。第 3.1、4.4、5.4、6、9.1 節是這部分。

## 1. 為什麼是換 session,不是控制壓縮

Claude Code 自己的 auto-compact 在 context 接近上限時把歷史換成一份摘要。那份摘要是模型在 context 最滿時生成、使用前不能編輯;PreCompact hook 只能放行或擋下這一次壓縮,不能改寫摘要內容;`custom_instructions` 只在手動 `/compact <文字>` 時有值。所以「看得見、能編輯」這個需求在壓縮路線上做不到。

換 session 的代價是多出三件事:交接檔的版本、新舊 session 的歸屬、失敗時的恢復。第 6 節把這三件事寫成一個有落盤階段的交易。

Claude Code 的 auto-compact 保留不動,當作最後一層保護:若一個回合太長、在我們來得及換之前就被壓縮,PostCompact hook 給的 `compact_summary` 另存成備援檔(第 5.3 節)。不用 `DISABLE_COMPACT=1` 關掉它,也不在 PreCompact 回 `decision: 'block'`:擋掉只是延後,真的撞到 context 上限時請求會直接失敗,沒有出口可以接自己的流程。

## 2. 已定案的取捨

| 項目 | 決定 |
|---|---|
| 換 session 或壓縮 | 換 session;auto-compact 留作保護,不擋、不關 |
| 長期事實 | 不另建。專案文件與 CLAUDE.md 是事實來源,Claude Code 的 auto memory 照舊當索引 |
| 當前工作狀態 | 交接檔 `handoff.md`,每條 thread 一份,使用者可直接編輯 |
| 機械資料來源 | 既有 SDK 訊息串流(tool_use 配 tool_result),不靠 agent 自律,也不需要 hook |
| 意圖段的更新時機 | 三個:門檻到、按「交接並開新 session」、按「寫交接」 |
| 門檻 | `min(rawMaxTokens × 50%, autoCompactThreshold − 20k)`;可改成絕對 token;缺值時停用自動換 |
| 交接檔位置 | `<project>/.yeschef/threads/<threadId>/`;git repo 加進 `info/exclude`;`<userData>` 留一份恢復副本 |
| 新 session 怎麼收到交接 | SDK 的 SessionStart hook 回呼回 `initialUserMessage`,一次性 |
| 切換時機 | 只在回合之間;回合進行中、有待批准、有背景工具、有 elicitation 時不切 |
| 分期 | E1 手動按鈕;E2 自動門檻 |
| 模型層備援 | 只傳 SDK 的 `fallbackModel` 設定並顯示實際用到的模型;宿主不自己重試、不自己在 Claude 模型間輪替 |
| 後端 | `SessionLink.provider`;E1 只會出現 `'claude'`。codex 接手是 roadmap 另一個子專案 |
| 故障交接 | 舊 session 已不能用時,宿主寫不可變的 `recovery-<txId>.json`,不覆蓋 handoff.md;新 session 先核對,不自動重做 |
| 跨後端切換 | 第一版只有手動按鈕;自動切換等有故障資料再開 |

## 3. SDK 0.3.258 提供的能力與本規格的用法

以下都在本機 `sdk.d.ts` 核對過行號,實際行為在 E1 實機驗收時確認。

| 能力 | 用途 |
|---|---|
| `Query.getContextUsage({ detail: 'summary' })` → `totalTokens`、`rawMaxTokens`、`percentage`、`autoCompactThreshold`、`isAutoCompactEnabled` | 每回合結束後讀一次,判斷是否到門檻。`summary` 用上一回應的 usage 估,不打 token-count API |
| `SessionStartHookInput.context_tokens`(resume/fork 時) | 官方對「context 大小」的定義:最後一個回應的 input + cache_read + cache_creation + output。與我們的估法一致 |
| `SessionStartHookSpecificOutput.initialUserMessage` | 新 session 的第一則 user message 帶交接檔內容 |
| `PostCompactHookInput.compact_summary` | 備援:auto-compact 先發生時把摘要另存 |
| `SDKCompactBoundaryMessage.compact_metadata.pre_tokens / post_tokens` | 記進 thread 的事件紀錄,供事後檢視 |
| `Options.hooks` | 在 SDK 內註冊 SessionStart、PostCompact、Stop 回呼,不用寫 shell hook |
| `Options.resume`、`forkSession` | 不用於換 session:fork 會保留分岔點以前的 context,不是乾淨交接。只在 D 的 sleeping session 恢復時用 `resume` |
| `Options.fallbackModel` | 逗號分隔清單,SDK 在主模型 overloaded 或 unavailable 時依序嘗試,每個新回合先回主模型。yeschef 只把設定傳下去(第 3.1 節) |
| `PostModelSwitchHookInput.from_model / to_model / source` | `source: 'auto'` 就是 fallback 生效;記進 `SessionLink.models`,工具列顯示目前模型 |
| `Options.tools: []` | 接收回合禁用工具。`allowedTools` 是自動放行清單,不是限制,不能拿來禁用 |
| `SDKRateLimitEvent.rate_limit_info` | 訂閱帳號的限流狀態:`status`、`rateLimitType`、`resetsAt`、`overageStatus`、`overageDisabledReason`、`errorCode`。第 9.1 節的錯誤分類讀它 |
| `SDKResultError.subtype`、`api_error_status`、`is_error` | 回合終止原因。目前 `events.ts` 的 `resultEvents` 只留 `api_error_status`、丟掉 `subtype`,E1 要補留 |

一條與本題無直接關係、但影響子專案 A 的發現:`session-args.ts` 沒設 `systemPrompt`,依官方文件省略時是 minimal prompt,不是 `claude_code` preset。這代表目前 yeschef 的對話沒有 Claude Code 的預設系統提示。是否改成 `{ type: 'preset', preset: 'claude_code', snapshot: true }` 另案處理,不在 E 的範圍;E1 驗收時要先確定這件事,因為它影響接續品質的量測基準。

### 3.1 fallbackModel 的接線

`session-args.ts` 的 `SessionArgsInput` 與 `SessionOptions` 各加一個 `readonly fallbackModel?: string`,`buildSessionOptions()` 有值時才帶這個 key(缺省時輸出物件完全沒有 `fallbackModel`,與 `mcpServers` 同一條規則)。`session-options.ts` 的 `createSessionOptionsFactory` 多收一個參數傳給 builder。`agent-host.ts` 已把整個 options 展開傳給 `query()`,不用改。設定來源是 yeschef 的設定檔,預設空;`model` 可以走同一條路補上,但不是前提。

驗證三件事:設定缺省時 options 沒有這個 key;有值時字串原樣抵達 `queryFn`;多次 resume 仍帶著。

## 4. 資料模型

### 4.1 thread 與 session 鏈(定義在 D 的狀態檔)

D 的 `ProjectEntry` 增加 `threads`,`TabEntry` 的對話分頁增加 `threadId`。型別定義放 D 規格 §4.1,這裡列 E 會讀寫的欄位:

```ts
interface ThreadEntry {
  readonly id: string
  readonly sessions: readonly SessionLink[]   // 依時間排序,最後一筆是現行
  readonly handoffVersion: number             // handoff.md 的版本,每次寫入 +1
  readonly switchPhase: SwitchPhase           // 第 6 節的交易階段,落盤
  readonly createdAt: number
}

interface SessionLink {
  readonly linkId: string                      // 宿主產生,鏈上唯一;跨後端的引用都用它
  readonly provider: 'claude' | 'codex'        // E1 只會出現 'claude'
  readonly sessionId: string                   // 該 provider 的原生 id,只給對應的 adapter 用
  readonly transcriptPath: string | null       // Claude 有本機 transcript;沒有的 provider 為 null
  readonly parentLinkId: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly endReason: 'handoff' | 'failure-recovery' | 'user' | null
  readonly models: readonly string[]           // system/init 與 PostModelSwitch 回報過的模型,去重;不假設一個 session 只有一個
}

interface SwitchTarget {
  readonly provider: 'claude' | 'codex'
  readonly requestedModel: string | null       // 不知道就 null,不拿 requestedModel 冒充實際模型
}

type SwitchMode = 'handoff' | 'failure-recovery'

type SwitchPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly startedAt: number }
  | { readonly kind: 'spawning'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly handoffVersion: number; readonly recoveryRequired: boolean }
  | { readonly kind: 'receiving'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly newLinkId: string; readonly newSessionId: string }
```

`committed` 不是一個階段:提交就是把新 session 推進 `sessions`、舊的補 `endedAt` 與 `endReason`、`switchPhase` 回 `idle`,三件事在同一次原子寫入完成。

`src/shared/projects.ts` 現在的 `SessionLink` 與 `SwitchPhase` 是 D 做的版本(`sessionId`、`parentSessionId`,沒有 `provider`),狀態檔 `schemaVersion` 為 1。E1 升到 2,讀到版本 1 時做一次轉換:`linkId = sessionId`、`provider = 'claude'`、`parentLinkId = parentSessionId`、`transcriptPath` 沿用、`models = []`;`switchPhase` 非 `idle` 的補 `mode: 'handoff'` 與 `target: { provider: 'claude', requestedModel: null }`,`spawning` 補 `recoveryRequired: false`,`receiving` 補 `newLinkId = newSessionId`。轉換後寫回版本 2。既有狀態檔不能因為升版而讀不到。

### 4.2 專案內的交接目錄

```
<project>/.yeschef/
  threads/<threadId>/
    handoff.md          # 交接檔,使用者可編輯
    snapshot.json       # 機械快照,程式維護
    compact-<n>.md      # auto-compact 先發生時的備援摘要
    recovery-<txId>.json # 故障交接的恢復包(5.4),寫一次不再改
```

git repo 的處理:用 `git rev-parse --git-path info/exclude` 找到排除檔(不假設 `.git` 是目錄,worktree 時它不是),加一行 `/.yeschef/`,已存在就不重複加。這不動任何被追蹤的檔案。非 git 專案直接寫。

`git clean -fdx` 會刪掉被忽略的檔案,所以 `<userData>/yeschef-threads/<threadId>/` 留一份同步副本;讀取時專案內的優先,不存在才用副本並提示使用者。

### 4.3 handoff.md 的格式

目標 1,500 tokens,上限 3,000 tokens。超過上限時宿主拒絕寫入並提示,不自動截斷。

```markdown
---
version: 7
sourceSessionId: <uuid>
cwd: /Users/.../project
head: 3d61641
branch: feat/x
writtenAt: 2026-09-08T10:12:00+08:00
---

## 目標與驗收
## 限制與已決定的事
## 已完成(附證據:檔案、commit、測試)
## 未完成
## 下一步
## 阻礙
## 待使用者回答
```

七個標題固定,宿主讀取時檢查都在,缺任一個就視為格式錯誤,提示使用者修而不是猜。推測性的內容要標「(推測)」。這組欄位參考 Cline memory bank 的 `activeContext.md` 與 `progress.md`,以及 codex 討論的建議。

### 4.4 snapshot.json 的內容

```ts
type Outcome = 'not_executed' | 'completed' | 'failed_no_effect' | 'unknown'

interface ToolOperation {
  readonly operationId: string                 // 宿主產生
  readonly linkId: string                      // 屬於鏈上哪一段
  readonly turnId: string | null
  readonly nativeToolUseId: string | null      // Claude 的 tool_use id;拿不到就 null
  readonly parentOperationId: string | null    // sub-agent 內的操作指向外層那一筆
  readonly name: string
  readonly input: unknown
  readonly phase: 'requested' | 'running' | 'terminal'
  readonly outcome: Outcome | null             // 執行中為 null;故障封存時轉 'unknown'
  readonly reason: string | null               // 判成該 outcome 的依據,例如 'tool_result is_error'、'no tool_result before session end'
  readonly requestedAt: number
  readonly settledAt: number | null
}

interface Snapshot {
  readonly schemaVersion: number
  readonly throughEventSeq: number             // 快照涵蓋到的事件序號
  readonly coverage: 'complete' | 'incomplete'
  readonly gaps: readonly { fromSeq: number; toSeq: number; reason: string }[]
  readonly sourceStopped: boolean              // 來源 session 是否已確認停止
  readonly operations: readonly ToolOperation[]
  readonly backgroundTasks: readonly { id: string; operationId: string; status: 'running' | 'stopped' | 'unknown' }[]
  readonly files: readonly { path: string; op: 'edit' | 'write' | 'create'; at: number }[]
  readonly commands: readonly { cmd: string; cwd: string; exitCode: number | null; at: number }[]
  readonly git: { head: string; branch: string; dirty: boolean } | null
  readonly lastTurnEndedAt: number
}
```

只記事實,不記推論。`files` 與 `commands` 是從 `operations` 整理出來給交接模板看的摘要,`files` 只收 `outcome === 'completed'` 的寫入類操作。`files`、`commands`、`operations` 各保留最近 200 筆,但 `outcome` 為 `'unknown'` 或 `null` 的 operation 不受這個上限淘汰。

四類結果的判定:

- `not_executed`:執行前就被擋下(批准被拒、宿主守衛拒絕),沒有送到工具。
- `completed`:收到對應的 `tool_result` 且 `is_error` 為 false,而且不符合下面 `unknown` 列的任何例外(例如 `Bash` 非零退出碼)。只代表該工具的契約完成,不代表任務驗收通過。
- `failed_no_effect`:收到 `tool_result` 且 `is_error` 為 true,而且該工具是唯讀的(`Read`、`Grep`、`Glob`、右窗格的讀取類工具)。
- `unknown`:其餘全部,而且優先於 `completed` 判定。包括 `tool_use` 沒有對應 `tool_result`、寫入類工具回 `is_error`、timeout、abort、`Bash` 非零 exit code(不論 `is_error` 是什麼);這些都不能證明沒有副作用。「背景程序已啟動」只證明啟動完成,對應的 `backgroundTasks` 項目記 `running`。

`coverage` 標 `incomplete` 的情況:事件序號有缺口、sub-agent 執行過工具(sub-agent 的操作不逐筆記,`gaps` 記一筆 reason `'subagent'`)、右窗格工具的 CDP 在回傳前斷線。

## 5. 交接檔怎麼產生

### 5.1 機械段:從 SDK 訊息串流

主行程已經在讀每一則 SDK 訊息(A 的狀態機)。E 在同一條路上加一個觀察者:

- 每則事件帶遞增序號 `seq`,`Snapshot.throughEventSeq` 跟著走。
- `tool_use` 一到就建一筆 `ToolOperation`(`phase: 'requested'`);`outcome` 依對應的 `tool_result`、執行前的拒絕事件、或 session 終止狀態判定,規則在 4.4。`tool_use` 只證明模型要求執行。
- `outcome` 為 `completed` 的 `Edit`、`Write`、`NotebookEdit` 記進 `files`;`Bash` 記指令、cwd 與退出碼;MCP 工具記名稱。
- sub-agent(`parent_tool_use_id` 非空)的操作不逐筆記,但 `coverage` 標 `incomplete`、`gaps` 記一筆。
- 每則事件立刻追加寫入(增量落盤),回合結束(result 訊息)時再算一次 git 狀態並整理成 `snapshot.json`。崩潰時最多丟掉最後一則事件。

不用 hook 抓這些:SDK 串流本來就有,hook 只是同一份資料的另一個入口。roadmap 裡的 hook 項目維持選用。

### 5.2 意圖段:三個時機各跑一個小回合

三個時機都做同一件事:在現行 session 送一則固定模板的 user message,要求模型只輸出 handoff.md 的七個段落,`maxTurns: 1`,回應上限 800 tokens,不准用工具(`tools: []` 加守衛,第 9 節)。宿主收到後檢查格式與大小,通過才原子寫入、`handoffVersion + 1`。

模板要說明:snapshot.json 的內容會由宿主附在訊息裡,模型不必重列檔案清單,把篇幅留給意圖、決策與下一步。

門檻觸發的那一次是在 context 還有一半空間時跑的,品質不會因為快滿而變差。這一回合本身會再讓 context 長一點,所以第 6 節的交易有防重入:`preparing` 期間不再看門檻。

### 5.3 備援:auto-compact 先發生時

PostCompact hook 收到 `compact_summary` 就寫 `compact-<n>.md`,並在 thread 事件紀錄裡記一筆 `compact_boundary` 的 `pre_tokens`、`post_tokens`。不把它併進 handoff.md:它是 Claude Code 的摘要,不是使用者審過的交接。回合結束後照常判斷門檻,該換就換。

### 5.4 故障交接:舊 session 已經不能用時

5.2 的意圖回合要舊模型還能回話。回合因第 9.1 節允許接手的錯誤終止時,舊模型已經不能回覆,宿主改用手上的資料組一份恢復包 `recovery-<txId>.json`,寫一次不再改,不動版本 N 的 handoff.md:

```ts
interface RecoveryPack {
  readonly schemaVersion: number
  readonly kind: 'failure-recovery'
  readonly txId: string
  readonly createdAt: number
  readonly source: { linkId: string; provider: 'claude' | 'codex'; sessionId: string; failedTurnId: string | null }
  readonly target: SwitchTarget
  readonly project: { projectId: string; cwd: string }
  readonly baseline: { handoffVersion: number; handoffText: string; sha256: string; throughEventSeq: number } | null
  readonly journal: { fromSeq: number; throughSeq: number; complete: boolean; gaps: Snapshot['gaps']; events: readonly JournalEvent[] }
  readonly operations: readonly ToolOperation[]
  readonly unknownOperationIds: readonly string[]
  readonly backgroundTasks: Snapshot['backgroundTasks']
  readonly closedApprovalRequests: readonly { requestId: string; toolName: string; closedAs: 'denied-on-failure' }[]
  readonly queuedInputs: readonly string[]
  readonly workspace: { head: string; branch: string; dirty: boolean; observedAt: number } | null
  readonly browser: { url: string | null; available: boolean; observedAt: number }
  readonly sourceStopped: boolean
}

type JournalEvent =
  | { seq: number; kind: 'user'; text: string }
  | { seq: number; kind: 'assistant'; text: string; complete: boolean }
  | { seq: number; kind: 'operation'; operationId: string }
```

`baseline` 是最後一次成功寫入的 handoff.md;從沒寫過就是 null,`journal` 從 thread 開頭算。`queuedInputs` 只收恢復包建立前已排進佇列的訊息;之後送出的留在 thread 佇列,commit 後依序送進新 session。`journal.events` 只留使用者原文、assistant 文字與它有沒有寫完、操作的引用;assistant 說「已完成」不算執行證據,證據只在 `operations`。恢復包超過接收回合的預算(handoff.md 上限 3,000 tokens 的兩倍)時,宿主不靜默截掉未知操作或最新的使用者指示,而是停下來提示使用者先手動寫一版 handoff.md 再接手。

接收回合的模板改用故障版:說明這是故障恢復資料、`baseline` 只涵蓋到 `throughEventSeq`(為 null 時說明「尚無交接版本」,目前任務從日誌整理)、之後的事件可能含沒做完的操作;這一回合不能用工具,只回覆交接版本(或「尚無」)、cwd、目前任務,以及對每一筆 `unknownOperationIds` 的核對計畫(讀檔案現況、查背景程序、重看瀏覽器)。沒有結果不代表沒有執行;不得重送原命令、重按提交、重新寫入或回滾,查不到證據就維持未知並告訴使用者。

## 6. 換 session 的交易

兩種模式走同一個交易:`handoff` 是正常交接,`failure-recovery` 是舊 session 已經不能用時的接手(5.4)。差別在 `preparing` 做什麼、`spawning` 怎麼回退。

```
idle
 │ handoff:門檻到(E2)或使用者按「交接並開新 session」(E1)
 │   且:回合已結束、無待批准、無背景工具、無 elicitation
 │ failure-recovery:回合因允許接手的錯誤終止(9.1),使用者按「用新 session 接手」
 ▼
preparing ──失敗──▶ idle(顯示原因;handoff 留在舊 session,failure-recovery 舊 session 維持故障狀態)
 │ handoff:5.2 的意圖回合成功、handoff.md 寫入、版本 +1
 │ failure-recovery:凍結輸入、結束所有待批准、確認舊執行者已停止、整理事件日誌、寫並驗證 recovery-<txId>.json
 ▼
spawning ───確認未送達且候選已關閉──▶ idle(顯示原因)
 │          送達結果未知──▶ 留在 spawning,recoveryRequired = true
 │ 新 session 啟動;SessionStart hook 回 initialUserMessage = handoff.md 全文或恢復包
 │ 收到新 session 的 system/init
 ▼
receiving ──失敗──▶ 恢復新 session(見下),不退回舊的
 │ 新 session 第一個回合:禁用工具,只複述任務與下一步,核對 cwd 與交接版本;故障模式再列核對計畫
 ▼
commit:sessions 推進新 session、舊 session 標 endReason、switchPhase 回 idle(一次原子寫入)
```

規則:

- `preparing` 失敗回 `idle`。handoff 模式下舊 session 的對話沒有被覆寫或刪改(意圖回合是它的最後一個回合),照常可用;failure-recovery 模式下舊 session 維持故障狀態,不自動 `resume`。兩種模式準備失敗都可以再按一次。
- `spawning` 只在兩件事都確認時才回 `idle`:交接訊息沒送達、候選 session 已關閉。送達結果未知(送出當下連線斷、或候選程序已啟動但在 init 前斷線,無法確認 `initialUserMessage` 是否已注入)就留在 `spawning` 並記 `recoveryRequired: true`,不自動再開第二個候選;使用者按「繼續恢復」時 `resume` 候選並補做核對。收到 `system/init` 就進 `receiving`,之後的問題都照 `receiving` 的規則處理。
- 進入 `receiving` 之後失敗(斷線、崩潰),重啟時看到 `switchPhase.kind === 'receiving'` 就 `resume` 新 session 並補做核對,不退回舊的:新 session 可能已經有內容,退回會造成兩條線各做一半。
- 重啟時看到 `preparing` 回 `idle`。看到 `spawning`,不論 `recoveryRequired`(崩潰可能發生在送出之後、旗標寫入之前),先查候選 session 是否存在(D 的 session 清單或 transcript 檔):不存在才回 `idle`,存在就 `resume` 候選並補做核對。
- commit 時 handoff 模式的 `handoffVersion` 已在 preparing 加過;failure-recovery 模式版本不動,恢復包引用的是 baseline(可能為 null)。新 `SessionLink.parentLinkId` 指舊那段,舊那段的 `endReason` 依模式記 `'handoff'` 或 `'failure-recovery'`。
- 恢復包有 `unknownOperationIds` 時,新 session 的寫入類工具(`Edit`、`Write`、`NotebookEdit`、`Bash`、右窗格的操作類工具)由宿主在 `canUseTool` 擋下並在對話裡說明原因,直到使用者在恢復卡片上按「已核對」。讀取類工具不擋。
- `initialUserMessage` 綁 `txId`,只對這一次啟動生效;之後 D 的 sleeping 恢復走 `resume`,不會再注入。
- 切換期間使用者送出的訊息進佇列,綁 thread,commit 後送進新 session;草稿也綁 thread 不丟。failure-recovery 模式下,恢復包建立前已在佇列的訊息另外寫進 `queuedInputs`。
- 同一條 thread 兩次切換之間至少隔 3 個回合,避免連環切換;failure-recovery 不受這條限制,但每個失敗回合最多成功提交一次接手交易:準備失敗可重試,已有候選 session 時繼續恢復該候選,不再開新的。
- 換過後端之後不自動切回。手動切回算一次新的 handoff 交接、開新 session,不 `resume` 鏈上較早那段,否則會漏掉中間那段的工作。

接收回合的模板要求模型:讀完交接後用不超過 200 字說出「目前任務、下一步、待你回答的問題」,不執行任何動作。使用者看到這一則就知道接上沒有。沒接上時改 handoff.md,按「重新接收」:宿主關掉這個候選(它只跑過禁用工具的接收回合,沒有東西會丟)、用改過的檔案再開一個候選,`txId` 不變、階段回 `spawning`,不受 3 回合冷卻限制。故障模式的模板在 5.4。

## 7. 門檻與訊號(E2)

每個回合結束(result 訊息)後呼叫 `getContextUsage({ detail: 'summary' })`,拿 `totalTokens`、`rawMaxTokens`、`autoCompactThreshold`、`isAutoCompactEnabled`。

```
threshold = userAbsolute ?? min(rawMaxTokens × userPercent, autoCompactThreshold − 20_000)
userPercent 預設 0.5
```

停用自動換(顯示在對話分頁,不靜默)的情況:

- `isAutoCompactEnabled` 為 false 或 `autoCompactThreshold` 缺值:算不出安全上限。
- 算出的 threshold 小於「新 session 初始 context + 3,000」:換過去馬上又到門檻。
- 使用者關掉自動換。

20k 是經驗緩衝,擋不住一個回合就吃掉 40k 的情形;那種情形由第 5.3 節的備援接住。50% 是試驗預設,E2 驗收要量實際的切換次數與額外 tokens 再調。

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 會把 auto-compact 的門檻拉下來,RESULTS-10 實測有效:設 40000 之後 `autoCompactThreshold` 從 970,616 變成 70,616、`autocompactSource` 從 `auto` 變成 `env`,實機也確認 context 到 70,354 時觸發壓縮並掉到 27,777。值被夾在下限 100,000,所以門檻的地板是 70,616。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 在本機沒有作用。
這推翻本節原本寫的「我們的門檻已經在它前面,挪它沒有意義」:在 E 不存在的情況下,這個環境變數本身就能把穩定狀態的 context 壓到 7 萬,成本問題大部分由它解決。E 要證明的因此不再是成本,而是壓縮給不了的東西:交接檔可讀可改、跨模型可攜、分段歷史。這三項要先確認是不是真需求,再決定 E 的範圍。

## 8. UI

對話分頁的工具列增加:

```
┌──────────────────────────────────────────────────────┐
│ Claude 對話   context ▓▓▓▓▓░░░░░ 48%   寫交接  交接並開新 session │
└──────────────────────────────────────────────────────┘
```

- context 條用 `percentage`,顏色只有兩態:低於門檻、高於門檻。
- 「寫交接」跑 5.2 的意圖回合,不換 session。
- 「交接並開新 session」跑第 6 節的交易。
- 交易進行中兩個按鈕都停用,顯示目前階段(準備交接 / 啟動新 session / 確認接續)。
- 對話內容裡,換 session 的位置畫一條分隔線:「已換到新 session(第 n 段),前一段唯讀」。點分隔線上方的內容進入 D 的 viewing 模式看舊 session。
- Recents 依 thread 分組,一條 thread 一列,展開才看到各 session。
- 設定:自動換開關、百分比或絕對 token、門檻到時是「直接換」或「先提示」。E1 預設不自動;E2 預設自動但先提示。
- 「Claude 對話」後面顯示 `system/init` 回報的模型,PostModelSwitch 到了就更新;`fallbackModel` 生效時看得出換了。
- 回合以錯誤終止時,對話裡出現一張錯誤卡片:分類後的中文說明、`resetsAt` 有值時顯示幾點解除、「重試」與「用新 session 接手」兩個按鈕。「重試」在限流時冷卻 60 秒,有 `resetsAt` 就冷卻到那個時間;60 秒是產品預設,不是服務承諾。「用新 session 接手」只在 9.1 的錯誤表允許且按鈕前置檢查通過時可按。
- 按「用新 session 接手」先出確認框:目標(E1 只有 Claude;codex 子專案上線後可選)、cwd、未知操作數;按鈕「交接並切換」與「取消」。有未知操作時寫「接手後先核對,不會自動重做」;舊執行者還可能在寫入時停用按鈕並說明。
- 透過故障接手建立的新 session,分隔線文字改為「已從故障 session 恢復(第 n 段),前一段唯讀」,下方一張恢復卡片列未知操作,「已核對」按鈕解除寫入鎖。

handoff.md 不在 app 內提供編輯器:它是專案裡的一個 markdown 檔,使用者用自己的編輯器改。app 只在按「交接並開新 session」時重新讀取磁碟上的版本。

## 9. 錯誤處理與安全

- handoff.md 是使用者可編輯的檔案,讀取時當資料處理:檢查大小上限與七個標題,通過才用;不通過提示使用者修,不自動修。
- 寫入 `info/exclude` 失敗(唯讀、權限)不阻擋流程,提示一次並繼續寫專案內檔案。
- 接收回合禁用工具,三層:SDK 的 `tools: []`(`allowedTools: []` 是自動放行清單,不會禁用任何工具)、宿主的 `canUseTool` 在接收回合一律拒絕並記 log、模板說明。
- 重啟後每條 thread 只有一個現行 session:由 `switchPhase` 與 `sessions` 最後一筆決定,規則在第 6 節。
- 意圖回合與接收回合都算成本:正常交接是意圖、接收兩個回合,故障交接只有接收一個。實際的模型呼叫次數與額外 tokens 在 E1 驗收量。
- 專案內 `.yeschef/` 只放交接、快照與恢復包,不放 token 或憑證。快照與恢復包記的是 agent 在對話裡跑的 Bash 指令與工具輸入(`ToolOperation.input`),這些內容 agent 本來就看得到、transcript 也已經記著;終端分頁的輸入不記。指令含機密時宿主不做遮蔽:遮蔽做不完整反而讓人以為安全,而且 `.yeschef/` 已排除在 git 之外。

### 9.1 回合終止時的分類與動作

分類是純函式:輸入 result 訊息的 `subtype`、`api_error_status`、`is_error`、`errors`,以及本 session 最後一則 `rate_limit_event`,輸出一個錯誤類別:`rate_limit`、`overloaded`、`server`、`model_unavailable`、`transport`、`auth`、`permission`、`invalid_request`、`context_limit`、`execution_limit`(maxTurns、budget)、`cancelled`、`unknown`。實作時逐一對照 `sdk.d.ts` 的 `SDKResultError` 與 HTTP 狀態碼,對不上的一律 `unknown`。

限流的判讀:`rate_limit_info.status` 為 `allowed_warning` 不算失敗;`overageStatus: 'rejected'` 不代表方案內用量已用完(`tests/fixtures/events/01-tool-use-bash.jsonl:16` 就是 `status: 'allowed'` 配 `overageStatus: 'rejected'`);只有 `status: 'rejected'` 或回合以 429 終止才算 `rate_limit`。訂閱帳號的週限制跨模型共用,所以限流時宿主不在 Claude 模型間輪替。`resetsAt` 在 fixture 裡是 Unix 秒,但單位沒有文件保證,E1 實機用真實事件對照 Claude 的 `/usage` 畫面確認一次。

| 錯誤或條件 | 動作 |
|---|---|
| SDK 還在自己重試(`api_retry`) | 宿主不介入。目前 `events.ts` 把 `api_retry` 靜音,E1 改成在對話裡顯示「重試中(第 n 次)」 |
| 本機啟動失敗,而且能證明沒送出任何輸入 | 宿主同模型重試 1 次 |
| SDK 重試耗盡的 `overloaded`、`server`、`model_unavailable`;`rate_limit` | 停下,顯示原因、「重試」(有冷卻)與「用新 session 接手」 |
| `transport`(串流中斷)且已確認舊執行者停止、恢復資料可用 | 同上 |
| `auth`、`permission`、`invalid_request`、`context_limit`、`execution_limit`、`cancelled` | 停下顯示原因,不給接手:這些不是換 session 能解的,context 上限由第 7 節的門檻處理 |
| 工具失敗、單純沒回應、舊執行者可能還在寫、`unknown`、恢復包驗證失敗 | 停下顯示原因,不給接手 |

「用新 session 接手」按鈕的前置檢查:舊執行者已停止(`sourceStopped`)、目標可用(Claude 已登入;codex 子專案上線後檢查對應的登入)、恢復資料齊全(事件日誌與快照讀得到)。恢復包本身在 `preparing` 建立並驗證格式與大小,不過就回 `idle` 並顯示原因。每個失敗回合最多成功提交一次接手,不自動切回。

自動接手不在 E 的範圍。之後要開,前提全部要成立:使用者事先啟用並指定目標;錯誤屬於上表可接手的類別;SDK 已停止重試;來源與背景工作都已停止;待批准與 elicitation 都已結束;事件日誌沒有缺口;所有操作都有 `not_executed`、`completed` 或 `failed_no_effect` 的證據,一筆 `unknown` 都不能有;目標的權限設定與工具能力驗收通過。每個失敗回合最多自動接手一次。

## 10. 測試與驗收

單元測試:

- 門檻公式:各種 `rawMaxTokens`、`autoCompactThreshold` 組合,缺值與非正值的停用判斷,絕對 token 覆寫。
- 機械段:`tool_use` 與 `tool_result` 配對、`is_error` 不記 files、sub-agent 略過、200 筆上限。
- handoff.md 驗證:七個標題、大小上限、frontmatter 欄位。
- 交易狀態機:每個階段的成功與失敗轉換;重啟時從 `preparing` / `spawning` / `receiving` 各自的恢復;`spawning` 送達未知記 `recoveryRequired`、重啟走恢復不回 `idle`;3 回合冷卻;failure-recovery 每個失敗回合只一次。
- 錯誤分類純函式:每個 `subtype`、`api_error_status`、`rate_limit_info` 組合各一例,對不上的回 `unknown`;`allowed_warning` 與 `overageStatus: 'rejected'` 不算失敗。
- 四類結果:有 `tool_result` 且非錯、唯讀工具錯誤、寫入工具錯誤、沒有 `tool_result`、批准被拒、`Bash` 非零退出、背景啟動;`unknown` 不被 200 筆上限淘汰;sub-agent 觸發 `incomplete` 與 `gaps`。
- 恢復包:baseline 與 journal 的切點、`unknownOperationIds` 與 `operations` 一致、超預算時拒絕、格式驗證。
- `tools: []` 與守衛:接收回合 `canUseTool` 一律拒絕;恢復後寫入類工具被擋、讀取類放行、按「已核對」解鎖。
- `fallbackModel`:缺省不帶 key、有值原樣到 `queryFn`、resume 保留。
- 狀態檔 1 → 2 轉換:每個欄位的預設值;非 `idle` 的 `switchPhase` 補齊;轉換後再讀不再轉。
- `info/exclude` 寫入:一般 repo、worktree、已存在該行、非 git。
- 佇列:切換期間送出的訊息在 commit 後進新 session、順序不變。

覆蓋率沿專案門檻(Stmts ≥ 93、Branch ≥ 86)。

實機驗收(E1,手動按鈕):

三個情境,每個至少跑 3 次:重構到一半(改了 3 個檔、測試紅)、debug 到一半(找到原因、還沒修)、寫規格到一半(定了 5 條、剩 2 條在討論)。每個情境事先固定:檢查點、使用者已回答過的問題、禁止的動作、預期的下一步。

每次看:

1. 接收回合是否說對任務、限制、下一步,且不重問已回答的問題。
2. 接下來的 3 次工具操作:允許重新讀檔與跑測試確認,不允許重做已完成的修改或重問。
3. 新 session id 不同、cwd 正確、交接版本與磁碟一致;續作後該情境的測試通過。
4. 量:成功率、每次交接的額外 tokens、從按鈕到接收回合結束的秒數;與同一情境直接 `resume` 舊 session 的表現對照。

故障注入:意圖回合超時、`initialUserMessage` 注入後新 session 沒回 init、`receiving` 期間 kill app 再開、有待批准時按按鈕、有背景 Bash 時按按鈕。每項確認重啟後只有一條現行 session,舊 session 的既有對話沒被覆寫,結束資訊只在 commit 時更新。

故障交接的注入:回合中殺 SDK 子程序(`transport`)再按「用新 session 接手」,看接收回合列出核對計畫、寫入類工具被擋、按「已核對」後才放行;用 fixture 注入 `status: 'rejected'` 的限流事件,看錯誤卡片與冷卻。不刻意耗盡真實配額,真的遇到限流時再補一次實機紀錄。

實機驗收(E2,自動門檻):在 E1 全過之後,把門檻暫設 20k 跑一個 10 回合的長任務,看它切幾次、每次接上沒有、額外 tokens 多少。

結果寫 `docs/RESULTS-09-handoff.md`。

## 11. 不採用的做法

- 主動 `/compact <指示>` 代替換 session:摘要不能預先編輯,不符需求。
- `DISABLE_COMPACT=1` 或 PreCompact `block`:拿掉最後一層保護,撞到上限時沒有出口。
- 用 hook 收集機械資料:SDK 串流已經有同一份資料。
- `forkSession`:保留分岔點以前的 context,不是乾淨交接。
- 在 app 內做 handoff.md 編輯器:使用者有自己的編輯器。
- groove Rotator 的自適應門檻與品質觸發:第一版用固定公式,量過再說。
- 另建長期記憶檔(Cline 六檔式):專案文件、CLAUDE.md、auto memory 已經在做,再建一套會有兩份事實。
- 宿主自己在 Claude 模型之間輪替:SDK 的 `fallbackModel` 已經做,而且訂閱限流跨模型共用,輪替沒有用。
- 用 `allowedTools: []` 禁用工具:它是自動放行清單。
- 把自動跨後端切換放進 E:先提供手動切換,有實際故障紀錄再評估自動。
- 為了多後端整個改成 ACP 一類的統一協定:Claude 走 SDK 已夠用,其他後端各加一個 adapter 接到同一個介面就好,介面草案放 roadmap 的 codex 子專案。
- 右窗格工具給 codex 用時另架 Streamable HTTP 的 MCP server:0.153.4 的 app-server 有 `dynamicTools`(experimental),宿主可以在同一條 JSON-RPC 連線直接提供工具;spike 失敗才退回 HTTP。

## 12. 參考

SDK 型別:`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 0.3.258,`getContextUsage`、`SessionStartHookSpecificOutput`、`PostCompactHookInput`、`SDKCompactBoundaryMessage`、`Options.hooks`。

官方文件:

- auto-compact 門檻與設定:https://code.claude.com/docs/en/model-config
- hooks(PreCompact、PostCompact、SessionStart):https://code.claude.com/docs/en/hooks
- 壓縮後保留什麼:https://code.claude.com/docs/en/context-window
- SDK 系統提示預設:https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- 訂閱方案的限流:https://support.claude.com/en/articles/8325606-what-is-the-pro-plan、https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work、https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan

codex app-server(0.153.4,本機 `codex app-server generate-json-schema [--experimental]` 產出):`initialize`、`initialized`、`thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`;`ThreadStartParams.dynamicTools` 與 `item/tool/call` 只在 `--experimental` 出現。官方文件:https://learn.chatgpt.com/docs/app-server

社群工具(都是 CLI 外部 watcher,沒有一個嵌在 SDK 宿主內;採用它們的設計,不採用程式):

- grooveai-dev/groove 的 Rotator.js:kill + respawn、交接鏈、冷卻。本規格的交易與冷卻參考它。
- za3ter123/claude-context-autopilot、sure-scale/claude-code-auto-compact:監看門檻自動 `/compact`,失敗退回存檔加 `/clear`。
- f3kpclon/claude-code-handoff、Sting25/claude-code-handoff:門檻到時快照 git 狀態與決策。
- Cline memory bank:`activeContext.md`、`progress.md` 的欄位。

## 13. 修訂紀錄

| 日期 | 章節 | 變更 | 依據 |
|---|---|---|---|
| 2026-09-08 | 全 | 初版 | 使用者需求、SDK 0.3.258 型別、codex 兩輪討論、社群工具調查 |
| 2026-09-08 | §0、§2、§3、§3.1、§4.1、§4.2、§4.4、§5.1、§5.2、§5.4、§6、§8、§9、§9.1、§10、§11、§12 | 後端切換的資料基礎:`SessionLink.provider` 與 `linkId`、狀態檔升版 2、四類工具結果、恢復包與 failure-recovery 模式、`spawning` 回退規則、錯誤分類與動作表、`tools: []` 取代 `allowedTools: []`、`fallbackModel` 接線 | 模型備援可行性討論(codex 兩輪)、SDK 0.3.258 型別、codex 0.153.4 app-server schema |
| 2026-09-08 | §1、§7 | 暫停實作。使用者確認動機是成本,而 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 已把 context 壓到 7 萬並接進 yeschef;§1「看得見做不到」前半有誤,摘要以 user message 注入看得見;§7 的理由已更正。剩下的價值(交接檔可改、跨模型、分段歷史)等真實使用一週後再決定,重開時範圍改為品質 | `docs/RESULTS-10-context-cost.md`、roadmap §9 |
