# 在介面裡把 worktree 分支合回主分支

- 日期:2026-09-23
- 狀態:設計完成,實作計畫見 docs/superpowers/plans/2026-09-23-worktree-merge.md
- 依據:`docs/specs/2026-09-15-tab-worktree-design.md`(對話分頁的 worktree;本規格取消它「不做合併按鈕」那一條)、`docs/specs/2026-09-22-grok-runtime-design.md`(對話的 `isBusy()` 與 `userInput`)

## 1. 要解決什麼

對話分頁可以開在自己的 worktree 裡,幾個 agent 各自在自己的分支上工作。做完之後要把分支合回主分支,現在只能自己到終端下 git 指令。這份規格在「查看 diff」面板加一個合併按鈕,合併過程中主目錄永遠不會處在衝突狀態,衝突留在 worktree 裡交給那個對話的 agent 解。

## 2. 已決定的事

| 題目 | 決定 |
|---|---|
| 合併對象 | 主目錄(專案 `rootPath`)目前所在的分支。不寫死 `main`,不推遠端,不開 PR |
| 做法 | 兩段式:先把目標分支 merge 進 worktree 分支,再在主目錄 `merge --ff-only` worktree 分支 |
| 衝突 | 只會發生在第一段(worktree 裡)。往那個對話送一句話請 agent 解,人也可以自己在終端解;主目錄永遠乾淨 |
| worktree 有未提交改動 | 合併前自動 `add -A` 並 commit,訊息固定 |
| 主目錄有未提交改動或 detached HEAD | 拒絕合併並說明。yeschef 不替人在主目錄 commit |
| agent 回合進行中 | 拒絕合併,等回合結束 |
| 合併之後 | 分頁、worktree、分支都留著,可以繼續做下一輪再合併。關分頁沿用既有流程,分支已合併就順便 `branch -d` |
| 不做 | rebase、改寫歷史、衝突編輯器、巢狀 repo 的合併、push、PR |

## 3. git 操作:`src/main/merge.ts`

```ts
export interface MergeDeps {
  readonly run: GitRun                 // src/main/git-run.ts 的 createGitRun 產物
  readonly logError: (error: Error) => void
}
export interface MergeArgs {
  readonly rootPath: string
  readonly worktreePath: string
  readonly label: string               // 分頁標籤,只拿來組 commit 訊息
  readonly agentBusy: () => boolean
}
export type MergeResult =
  | { kind: 'merged'; target: string; branch: string; commits: number | undefined }  // 數不出來時不帶數字
  | { kind: 'conflict'; target: string; branch: string; files: readonly string[] }
  | { kind: 'conflictPending'; files: readonly string[] }
  | { kind: 'rootDirty'; files: readonly string[] }
  | { kind: 'rootDetached' }
  | { kind: 'agentBusy' }
  | { kind: 'failed'; message: string }
export interface MergeStatus {
  readonly kind: 'status'
  readonly branch: string
  readonly target: string | null       // 主目錄 detached 時為 null
  readonly ahead: number               // rev-list --count <target>..<branch>
  readonly dirty: boolean              // worktree 有未提交改動
  readonly conflictPending: boolean    // worktree 有 MERGE_HEAD
}
// 顯示用的 message(含 status 的那一行)由 IPC 層統一組(§4),merge.ts 只回事實。
export function createMerge(deps: MergeDeps): {
  status(args: Pick<MergeArgs, 'rootPath' | 'worktreePath'>): Promise<MergeStatus | { kind: 'failed'; message: string }>
  merge(args: MergeArgs): Promise<MergeResult>
  abort(args: Pick<MergeArgs, 'worktreePath' | 'agentBusy'>): Promise<{ kind: 'aborted' } | { kind: 'agentBusy' } | { kind: 'failed'; message: string }>
}
```

### 3.1 `merge` 的順序

前置檢查,任一不過就回報,什麼都不動:

1. `agentBusy()` 為 true → `agentBusy`。
2. 主目錄 `git -c core.quotePath=false status --porcelain` 非空 → `rootDirty`,files 是那些路徑(關掉 quotePath,中文檔名才不會變成八進位跳脫)。
3. 主目錄 `git symbolic-ref --short HEAD`:成功的值是目標分支;失敗且 stderr 含 `not a symbolic ref` → `rootDetached`;其他失敗(目錄不在、不是 repo、index.lock)→ `failed` 帶 stderr 的那行,不叫人「切回分支」。worktree 的分支名同樣三態,detached 才回 `MSG.worktreeDetached`。
4. worktree `git rev-parse -q --verify MERGE_HEAD` 成功 → `conflictPending`,files 是 `git diff --name-only --diff-filter=U`。
5. worktree 分支名用 `git symbolic-ref --short HEAD` 讀,不從路徑猜。

第一段(cwd 是 worktree):

6. `git add -A -- . ':!.claude/settings.local.json'`。那個檔是建 worktree 時複製進去的(tab-worktree 規格 §3),不進歷史。
7. `git status --porcelain` 非空才 `git commit -m "yeschef:合併前自動提交(<label>)"`。
8. `git merge --no-edit <target>`。exit 0(含 Already up to date)往下;失敗時查 `git rev-parse -q --verify MERGE_HEAD`:在 → `conflict`(worktree 留在 merge 中),files 用 `git diff --name-only --diff-filter=U` 查,查不到就空陣列;不在 → `failed`,message 取 stderr 裡說明原因的那行(`fatal:`、`error:`、`CONFLICT` 優先於 `hint:`)。

第二段(cwd 是主目錄):

9. 先算 `rev-list --count <target>..<branch>`(第一段之後算,數字就是真正會進主分支的 commit 數,含 merge commit;算不出來時 `commits` 不帶,訊息改用 `mergedNoCount`,不說「已是最新」),再 `git merge --ff-only <branch>`。成功 → `merged`;失敗 → `failed`(兩段之間主目錄被動過)。

### 3.2 衝突之後

- 回 `conflict` 的同時,IPC 層往那個對話送 `MSG.agentConflict(target, files)`(見 §6),走現有 `userInput`。
- agent 解完並 commit 後,使用者再按一次合併:步驟 4 看不到 `MERGE_HEAD`,步驟 8 是 Already up to date,直接第二段。agent 沒解完就再按 → `conflictPending`。
- `abort`:先看 `agentBusy()`(agent 正在解衝突時不能把它腳下的 merge 拿掉),再 worktree `git merge --abort`,回到步驟 7 之後的狀態。

### 3.3 `status`

主目錄與 worktree 各查一次:目標分支(detached 為 null)、worktree 分支、`rev-list --count`、`status --porcelain -- . ':!.claude/settings.local.json'`(排除跟 `add` 同一個檔,否則 `dirty` 永遠是 true)、`MERGE_HEAD`。worktree 自己 detached 時回 `failed` 帶 `MSG.worktreeDetached`。UI 開面板時查一次,合併與放棄之後各查一次,不輪詢。

## 4. IPC:`worktree:merge`

`src/shared/worktree-merge.ts`,照 `src/shared/test-machines.ts` 的寫法:

```ts
export const WORKTREE_MERGE_CHANNEL = 'worktree:merge'
export const WorktreeMergeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), projectId: z.string().min(1), tabId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('merge'), projectId: z.string().min(1), tabId: z.string().min(1) }).strict(),
  z.object({ action: z.literal('abort'), projectId: z.string().min(1), tabId: z.string().min(1) }).strict(),
])
export const WorktreeMergeResponseSchema = z.discriminatedUnion('kind', [ …MergeStatus、MergeResult、aborted、error 各一,每個成員各自 .strict()… ])   // zod 4 的 discriminatedUnion 本身沒有 .strict()
```

回應只帶顯示用的資料:分支名、檔案相對路徑、commit 數、訊息。每一種回應都帶組好的 `message`(含 `status`),因為 renderer 不能 import 主行程的 `MSG`;元件自己的介面文字(按鈕名、載入中)留在元件裡。不帶絕對路徑以外的東西(檔案清單是相對 worktree 的路徑)。

handler 在新檔 `src/main/worktree-merge-ipc.ts`,跟 `test-machines/ipc.ts` 一樣檢查 sender。進行中的旗標抽在 `src/main/merge-locks.ts`(`createMergeLocks()`,純記憶體),鎖的範圍照它動到什麼:

| 動作 | 鍵 | 為什麼 |
|---|---|---|
| `merge` | `projectId` | 第二段跑在主目錄,同一個專案同時只允許一個 merge |
| `abort` | `projectId/tabId` | 只動那個 worktree,以分頁為單位 |
| `status` | 不拿鎖 | 唯讀 |

拿不到鎖就回 `failed` 帶 `MSG.inProgress`,不碰 git;renderer 那側按鈕在等回應時也停用,兩層都擋。同一份 locks 也給 `projects-ipc`(§5)。deps:

```ts
interface WorktreeMergeIpcDeps {
  readonly merge: ReturnType<typeof createMerge>
  readonly locate: (projectId: string, tabId: string) => { rootPath: string; worktreePath: string; label: string } | undefined
  readonly conversation: (projectId: string, tabId: string) => { isBusy(): boolean; userInput(text: string): void } | undefined
  readonly locks: MergeLocks                 // 與 projects-ipc 共用
  readonly logError: (error: Error) => void
}
```

`agentBusy` 不只看對話核心的 `isBusy()`:主廚(chef)guard 有值的分頁也算忙碌,那個工作目錄正歸主廚任務調度。`merge` 與 `abort` 都吃這個判斷,所以 agent 忙的時候放棄合併一樣被拒(`abort` 會拿掉 agent 腳下的 merge)。guard 有值時衝突那句話也不送進對話。

`locate` 從 projects state 查(分頁沒有 `worktreePath` 回 undefined → 回 `error`;label 用 `customLabel ?? label`);`conversation` 從 ipc-bridge 新加的 `conversationFor(projectId, tabId)` 拿,`tabId` 就是對話 id,只看已經建起來的對話,不會為了送訊息新開一個 agent session。對話還沒開過時 `isBusy` 視為 false,衝突訊息會送不到 agent,列入 RESULTS 已知限制(合併按鈕只在開著的對話面板裡,實際上碰不到)。

## 5. 資料

不新增持久化欄位。帶 worktree 的分頁關閉多一道檢查:那個專案正在 merge(`locks.isBusy(projectId)`),或那個分頁正在 abort(`locks.isBusy(projectId/tabId)`),就回 `MSG.closeWhileMerging`,worktree 不移除、分頁也不關。合併跑到一半把目錄抽走,git 會停在半路。沒有 `worktreePath` 的分頁(終端、一般對話)關閉不碰 git,合併中照常關。

唯一動到既有流程的是關分頁:`removeWorktree` 成功移除後,若在主目錄跑 `git branch --merged`(不帶參數,等於 HEAD;detached 時也不會出錯)含這個分支就 `git branch -d <branch>`;失敗只 `logError`,不擋關分頁。tab-worktree 規格 §3 的「分支保留」改成「未合併的分支保留」。

## 6. 訊息

`src/main/merge.ts` 的 `MSG`:

| 鍵 | 內容 |
|---|---|
| `rootDirty(files)` | 主目錄有未提交的改動,先處理再合併:`<files>` |
| `rootDetached` | 主目錄不在任何分支上(detached HEAD),先切回分支 |
| `agentBusy` | agent 還在工作,等這個回合結束再合併 |
| `conflict(target, branch, files)` | 主分支 `<target>` 合進 `<branch>` 時有衝突:`<files>`。已請 agent 處理(files 為空時省掉冒號那段) |
| `conflictPending(files)` | 上一次的衝突還沒解完:`<files>`(files 為空時省掉冒號那段) |
| `failed(message)` | 合併失敗:`<message>` |
| `inProgress` | 上一次的合併還在進行中 |
| `closeWhileMerging` | 合併進行中,請稍後再關閉分頁 |
| `merged(target, commits)` | 已合併到 `<target>`(`<commits>` 個 commit) |
| `mergedNoCount(target)` | 已合併到 `<target>`(算不出 commit 數時用,不說「已是最新」) |
| `upToDate(target)` | 已是最新,沒有要合併的 commit |
| `autoCommit(label)` | yeschef:合併前自動提交(`<label>`) |
| `status(branch, target, ahead, dirty)` | 分支 `<branch>` → `<target>`,領先 `<ahead>` 個 commit(dirty 時加「含未提交的改動」) |
| `worktreeDetached` | worktree 不在任何分支上(detached HEAD),先切回分支 |
| `statusFailed(message)` | 讀不到 worktree 狀態:`<message>`(git status 失敗時,帶 stderr 第一行) |
| `agentConflict(target, files)` | 主分支 `<target>` 已合進目前分支,但有衝突:`<files>`。請解決衝突、確認測試後提交(merge commit)。完成後我會再按合併。 |

## 7. UI:`WorktreeMergeBar`

只放在「查看 diff」面板(`DevelopmentDiff`)最上方,分頁有 `worktreePath` 才出現。對話工具列不加按鈕。

| 狀態 | 顯示 | 按鈕 |
|---|---|---|
| 平常 | `分支 <branch> → <target>,領先 <ahead> 個 commit`;dirty 時多「(含未提交的改動)」 | 「合併」(`primary`);ahead 為 0 且不 dirty 時停用並顯示 `upToDate` |
| 進行中 | 「合併中」 | 停用 |
| 衝突 | 整列 `--warning`,列出檔案,說明已請 agent 處理、解完再按一次 | 「合併」可按、「放棄合併」 |
| 成功 | `merged` 那句,重查 status 後回平常態 | 「合併」(此時停用,領先 0) |
| 拒絕 | 同一列顯示 `rootDirty` / `rootDetached` / `agentBusy` / `failed` 的原因 | 「合併」可按 |
| detached | `target` 為 null:顯示 `rootDetached` | 停用 |
| 衝突(來自 status) | `status.conflictPending` 為 true 等同衝突態:開面板查一次就整列 `--warning`、顯示「解完再按一次」,不必先按過合併。status 不帶檔案清單,所以那時不列檔案 | 「合併」可按、「放棄合併」 |

元件 `src/renderer/components/WorktreeMergeBar.tsx` 與 `.css`,hook `src/renderer/hooks/useWorktreeMerge.ts`(呼叫 `bridge.worktreeMerge`)。樣式只用 `theme.css` 的 token,受 `tests/theme-rules.test.ts` 約束。

## 8. 測試

| 檔案 | 驗什麼 |
|---|---|
| `tests/merge.test.ts` | 假 `run`(照 `tests/worktree.test.ts`,記錄 args 序列、依序回應):八種 `MergeResult` 各一;自動 commit 排除 `.claude/settings.local.json`;沒改動不 commit;`conflict` 時不做第二段;第二段 ff 失敗回 `failed`;`status` 的五個欄位;`abort` 送的指令 |
| `tests/worktree-merge-ipc.test.ts` | sender 檢查;schema 拒絕多餘欄位;分頁沒有 worktree 回 `error`;`merge` 得到 `conflict` 時 `userInput` 被呼叫一次且內容是 `MSG.agentConflict`;`agentBusy` 時沒有任何 git 呼叫 |
| `tests/worktree.test.ts`(補) | 分支已合併時 `removeWorktree` 後 `branch -d`;未合併不刪;`branch -d` 失敗只 log |
| `tests/worktree-merge-bar.test.tsx` | 六種狀態的畫面與按鈕停用條件;合併後重查 status;放棄後重查 |
| `tests/merge-real-git.test.ts` | 真的 git:暫存目錄 `git init`、建 worktree、兩邊改同一個檔並提交,用真的 `createGitRun` 跑 `merge` 得到 `conflict`;手動解掉衝突並 commit,再跑得到 `merged`,主目錄 `log` 含 worktree 的 commit。不需要 Electron,進 `npm test` |

## 9. 實機驗收(寫進 `docs/RESULTS-38-worktree-merge.md`)

1. 開帶 worktree 的對話,要 agent 改一個檔並提交,按合併,主目錄 `git log` 有那個 commit。
2. 主目錄手動改同一個檔並提交,再按合併:衝突列出現,對話收到 `agentConflict`,agent 解完提交,再按合併成功。
3. worktree 有未提交改動時按合併:先看到自動提交的 commit,再合併成功。
4. 主目錄有未提交改動時按合併:被拒並列出檔案。
5. agent 回合中按合併:被拒。
6. 合併後關分頁:worktree 移除、分支被刪;未合併的分支關分頁後仍在。

## 10. 範圍外

不 push、不開 PR、不 rebase、不做衝突編輯器、不合併巢狀 repo(只合 worktree 所在的主 repo)、不處理主目錄在別的 worktree 裡的情況(`rootPath` 本身就是 worktree 時,目標分支就是它目前的分支,行為相同)。
