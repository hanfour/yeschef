# 子專案 D:以專案整理工作

## 0. 這個子專案的位置

yeschef 目前有 A(Agent SDK 宿主,左窗格對話)、B(右窗格瀏覽器)、C(左窗格分頁與終端機)三塊在 main。這個子專案把「一個固定目錄」換成「多個可切換的專案」:切換專案時,對話、終端分頁、右窗格的檔案範圍一起跟著切。

對應 `docs/specs/2026-09-07-yeschef-roadmap.md` 第 1 項。roadmap 第 2 項(預覽)、第 4 項(tmux 與手機)在這之後,不在本子專案。

設計時參考了實測的 Orca 1.4.197 資料模型(`docs/specs/2026-09-07-orca-adoptable-design.md`),採用與不採用的分野寫在第 8 節。

對話分頁在本規格是一條 thread(一串 session);交接檔、換 session 的交易與門檻在子專案 E(`docs/specs/2026-09-08-yeschef-handoff-design.md`)。D 只負責 thread 與 session 鏈的存放與顯示。

## 1. 前提

現在 `projectDir` 是啟動時從 `YESCHEF_PROJECT_DIR` 讀一次,穿進四個地方:SDK 對話的 cwd、終端機的 cwd、右窗格 `checkNavigateUrl` 的本地檔案範圍、標題列。要支援多專案,這四樣都要能在執行期跟著換。

## 2. 已定案的取捨

| 項目 | 決定 |
|---|---|
| 切專案的範圍 | 對話與終端都跟著切,右窗格檔案範圍也跟著切 |
| 背景專案 | 繼續跑,回來看得到結果 |
| 背景對話的成本 | 用 sleeping session:只有進行中的回合持有活串流,跑完只留 session id 與 transcript 路徑 |
| 背景待批准 | 在該專案上顯示記號,不打斷前景;切回去才顯示批准卡 |
| 切換器位置 | 分頁列上方一列專案 |
| 右窗格 | 只有一個 WebContentsView;每個專案記自己的 URL,切換時還原;背景專案呼叫瀏覽器工具回明確錯誤 |
| 專案是什麼 | 任意資料夾,不強制 git repo |
| 專案數量上限 | 這一版不設上限,但要量測記憶體並記進 RESULTS |
| 對話分頁是什麼 | 一條 thread:一串 session 依時間排列,最後一筆是現行。`startNew` 開新 thread;同一條 thread 上換 session 由 E 負責 |

## 3. 架構

### 3.1 主行程持有專案登錄表,renderer 只認 id

主行程維護唯一的登錄表:`id → { rootPath, name }`,id 由主行程產生。renderer 切換專案、開終端、呼叫瀏覽器工具時都只送 id,不送路徑。

這條是安全要求,不只是整潔:終端機的 cwd 與右窗格能開哪些本地檔都由這個值決定。若讓 renderer 傳原始路徑,任何連得上終端 ws 的東西就能指定任意目錄開一個有完整權限的 shell。C 目前把 cwd 固定在伺服器端是安全的,改成多專案後必須用 id 查表維持同樣的性質。

### 3.2 四個子系統怎麼跟著切

| 子系統 | 現在 | 改成 |
|---|---|---|
| 終端機 cwd | `startTerminalServer(cwd)` 固定一個 | `open` 訊息帶 `projectId`,伺服器查登錄表換 cwd;查不到就送 exit 並關連線。這會改動 C 規格 §5 的協定:`open` 多一個必填 `projectId`,對應的契約要一併更新 |
| Claude 對話 | 單一 sessionOptions 工廠 | 每個專案一組;主行程用 map 持有各專案的對話狀態 |
| 右窗格檔案範圍 | `checkNavigateUrl(url, projectDir)` 固定 | 用當前 active 專案的 rootPath |
| Recents | 列出全部 session | 依 thread 分組,一條 thread 一列,展開才看到各 session;預設只列當前專案,可切換成全部。點舊 session 進入唯讀 viewing 模式 |
| 標題列 | 顯示 projectDir | 顯示當前專案名 |

### 3.3 背景專案的對話:sleeping session

不為每個開著的專案養一條活 SDK 串流。每個專案的對話有兩種狀態:

- live:有進行中的回合,持有 SDK 串流。切走時**不中斷**,讓它跑完。
- sleeping:沒有進行中的回合,只留 `{ sessionId, transcriptPath, lastState }`,不持有串流。`sessionId` 永遠是該 thread 的 `sessions` 最後一筆(E 換 session 後會推進)。

轉換規則:切走時若回合進行中,維持 live 直到該回合結束,結束後轉 sleeping。切回來時若是 sleeping,先讀 transcript 把既有內容顯示出來(只是看不需要連線),等使用者送下一則訊息才用 sessionId resume(`session-options.ts` 已會在 resume 時向 store 問該對話原本的 cwd)。這樣切回去是即時的,不會為了看一眼就開一條連線。

這樣「同時開 N 個專案」的成本是 N 份小狀態加上「實際正在跑的回合數」條串流,而不是 N 條串流。這個做法取自 Orca 的 `sleepingAgentSessionsByPaneKey`,它記的就是 session id 與 transcript 路徑、`connectionId` 為 null。

### 3.4 右窗格:一個 view,每個專案記自己的 URL

右窗格維持單一 WebContentsView。每個專案記 `lastUrl`,切換專案時把 view 導到該專案的 lastUrl(沒有就 `about:blank`)。`checkNavigateUrl` 用 active 專案的 rootPath 當範圍。

背景專案的 agent 呼叫任何瀏覽器工具時,回一個明確錯誤(「瀏覽器正由前景專案使用」),不要讓兩個專案互相蓋畫面。這是單一 view 的誠實限制:Orca 是每個工作情境各自一組瀏覽器分頁才沒有這個問題,若之後確定需要,再考慮每專案一個 view。

## 4. 資料模型與持久化

### 4.1 狀態檔

放 `<userData>/yeschef-projects.json`:

```ts
interface ProjectsState {
  readonly schemaVersion: 1
  readonly projects: readonly ProjectEntry[]
  readonly activeId: string | null
  readonly openIdsOnShutdown: readonly string[]
}

interface ProjectEntry {
  readonly id: string          // uuid,主行程產生
  readonly rootPath: string
  readonly name: string        // 預設取資料夾名,可改
  readonly addedAt: number
  readonly lastOpenedAt: number
  readonly tabs: readonly TabEntry[]
  readonly lastUrl: string | null   // 右窗格
  readonly threads: readonly ThreadEntry[]   // 每個對話分頁一條,型別在 E 規格 §4.1
}

interface TabEntry {
  readonly id: string
  readonly contentType: 'conversation' | 'terminal'
  readonly label: string            // 自動,例如指令名
  readonly customLabel: string | null
  readonly command?: string
  readonly sortOrder: number
  readonly lastFocusedAt: number
  readonly threadId?: string        // contentType 為 'conversation' 時必填,對應 threads[].id
}
```

每個專案的 `tabs` 一定包含且只包含一個 `contentType: 'conversation'` 的分頁,永遠排第一、不可關閉,沿用 C 對 Claude 分頁的規則;終端分頁可開可關。

寫入用原子寫(先寫暫存檔再 rename),並保留兩份輪替備份 `.bak.0`、`.bak.1`。讀取時 `schemaVersion` 不認得就當成空狀態並保留原檔,不要覆蓋掉使用者資料。以上三點(版本、原子寫加輪替備份、記關閉時開著哪些)取自 Orca 的 `orca-data.json`。

### 4.2 終端內容不自己存

分頁清單會還原,終端**內容**不由我們存檔。roadmap 第 4 項接上 tmux 後,接回時由 tmux 重繪(`docs/RESULTS-07-tmux-spike.md` 已實測)。在 tmux 接上之前,還原的分頁是空的新終端。

### 4.3 還原的正確性

Orca 用 `terminalPtyIncarnationsByPaneKey` 記 pty 世代、`terminalSurfaceTombstonesByPaneKey` 記已關閉的分頁。這兩個概念在 tmux 接上後才真的需要(避免還原時復活已關掉的分頁、或把新舊 pty 世代搞混),本子專案先只記到「分頁清單」這一層,並在 roadmap 第 4 項補上。

## 5. UI

分頁列上方加一列專案:

```
┌────────────────────────────────────────┐
│ mirage ●  │ yeschef │ helm │    +     │  專案列
├────────────────────────────────────────┤
│ Claude 對話 │ zsh × │ codex ×  │   +    │  該專案的分頁
├────────────────────────────────────────┤
│                左窗格內容               │
└────────────────────────────────────────┘
```

- 每個專案一格,顯示名稱;有待批准時顯示一個記號。
- 「+」開 Electron 的資料夾選擇器加入專案;任意資料夾即可。
- 切換專案:換掉分頁列與左窗格內容,右窗格導到該專案的 lastUrl,背景專案的對話與終端繼續。
- 專案可移除(只從清單移除,不動磁碟)。

## 6. 錯誤處理與安全

- 終端 `open` 帶未知或缺少的 `projectId`:送一則 exit(code 非 0)後關連線,不要退回任何預設目錄。
- 專案資料夾在啟動時不存在(被搬走或刪除):該專案標示為不可用,不移除也不自動改路徑,由使用者決定重新指定或移除。
- 背景專案呼叫瀏覽器工具:回明確錯誤,不改變前景畫面。
- 狀態檔損毀:讀不成功就退到備份,備份也壞就當空狀態並保留原檔。
- 沿用 C 的既有安全性質:終端 ws 只綁 `127.0.0.1`、Origin 檢查照舊。

## 7. 測試與驗收

單元測試:

- 登錄表:新增、移除、依 id 查 rootPath、未知 id 的處理。
- 狀態檔:序列化與還原、schemaVersion 不認得的處理、備份輪替、損毀退回。
- 分頁狀態:每個專案各自的分頁清單、切換專案不互相影響、關掉 active 分頁的行為(沿用 C 規格 §6 的規則:切回 Claude 分頁)。
- sleeping session 的狀態轉換:進行中切走維持 live、回合結束轉 sleeping、切回來從 sleeping 恢復。
- 瀏覽器工具的專案守衛:非 active 專案呼叫回錯誤。

覆蓋率沿專案門檻(Stmts ≥ 93、Branch ≥ 86),`index.ts` 維持排除。

實機驗收(照 B 與 C 的教訓,單元測試綠不代表可用):

1. 加入兩個專案,分別開終端,確認 cwd 各自正確、不互相串。
2. 在專案 A 送一個會跑一陣子的 Claude 回合,切到專案 B,回來看得到結果。
3. 專案 A 的 agent 要批准時,在專案列看到記號、前景不被打斷;切回去才出現批准卡。
4. 切換專案時右窗格回到該專案上次的 URL;背景專案呼叫瀏覽器工具得到明確錯誤。
5. 關掉 app 再開,專案清單、active 專案、分頁清單都還原。
6. 量測開兩到三個專案時的記憶體,寫進 RESULTS。

結果寫 `docs/RESULTS-08-projects.md`。

## 8. 不採用 Orca 的部分

- repo / project / worktree 三層模型(`repos`、`projects`、`worktreeMeta`):那是為了 worktree fanout。yeschef 一個專案就是一個資料夾。
- `orchestration.db` 的 runs、tasks、coordinator、federation 那套平行機制。
- 每個工作情境各自一組瀏覽器分頁:yeschef 這一版用單一 view 加 per-project URL(第 3.4 節)。
- 專案分組、SSH 遠端專案、專案顏色標記:這一版不做。

## 9. 修訂紀錄

| 日期 | 章節 | 變更 | 依據 |
|---|---|---|---|
| 2026-09-07 | 全 | 初版 | brainstorming 與實測 Orca 1.4.197 資料模型 |
| 2026-09-08 | §0、§2、§3.2、§3.3、§4.1 | 對話分頁定義為 thread;Recents 依 thread 分組並預設只列當前專案;sleeping 指向鏈上最後一筆;`ProjectEntry.threads` 與 `TabEntry.threadId` | 子專案 E 規格 |
