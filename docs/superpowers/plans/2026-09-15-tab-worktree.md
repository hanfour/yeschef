# 對話開在自己的 git worktree 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立對話時可以選「在新的 worktree 開」,那個對話的 agent 就在自己的目錄工作,不會跟同專案其他對話互相蓋檔案。

**Architecture:** 主行程加一個純粹的 worktree 模組(注入 `run` 與 `fs`,不 import Electron),`TabEntry` 加選填 `worktreePath`,建對話的 IPC payload 加選填 `worktreeName`;對話的 SDK cwd 與右窗格的檔案範圍改用 `tab.worktreePath ?? rootPath`。終端分頁不動。

**Spec:** `docs/specs/2026-09-15-tab-worktree-design.md`

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess`;無 `any`/`!`;不可就地修改;繁體中文註解說明為什麼。
- commit `<type>: <描述>`,繁體中文,不加 trailer。測試不用 jest-dom(不新增 `tests/setup.ts`、不改 `vitest.config.ts`)。
- Stmts ≥ 93、Branch ≥ 86。既有測試不改弱。
- 狀態檔 `schemaVersion` 不變:新欄位一律選填,舊檔照讀。
- IPC 進主行程的 payload 過 parse 回傳新物件。
- 所有 git 指令經注入的 `run`,不直接 import `child_process`(模組要能純測)。
- slug 規則固定:取輸入前 32 字、空白轉 `-`、只留 `[A-Za-z0-9一-鿿_-]`、去掉頭尾的 `-`;
  結果為空字串就用 `tab-<tabId 前 8 碼>`;與既有分支或目錄重複就加 `-2`、`-3`,最多試到 `-99`。
- `.gitignore` 補的那一行固定是 `.worktrees`(**不帶斜線**:帶斜線只擋目錄,擋不住同名的符號連結,RESULTS-21 踩過)。
- 使用者看到的字串固定:選項標籤 `在新的 worktree 開`、輸入框 placeholder `這個對話要做什麼`、
  關閉時的訊息 `worktree 還有未提交的改動,留在 <path>,請自己處理`。

---

### Task 1: worktree 模組(純函式加 run 注入)

**Files:** Create `src/main/worktree.ts`、`tests/worktree.test.ts`

**Interfaces:**
- `slugify(input: string, taken: readonly string[], tabId: string): string`
- `interface WorktreeDeps { run(args: readonly string[], cwd: string): Promise<{ readonly ok: boolean; readonly out: string }>; readFile(path: string): Promise<string | undefined>; writeFile(path: string, text: string): Promise<void>; logError(e: Error): void }`
- `isGitRepo(deps, rootPath): Promise<boolean>`:`git rev-parse --git-dir`。
- `worktreeDirName(deps, rootPath): Promise<'.worktrees' | 'worktrees'>`:兩個都在或都不在回 `.worktrees`(規格 §3.2)。
- `ensureIgnored(deps, rootPath, dirName): Promise<void>`:`.gitignore` 沒有那一行就追加(檔案不存在就建),
  比對時整行 trim 後等於 `dirName` 或 `dirName + '/'` 都算已經有。
- `existingSlugs(deps, rootPath): Promise<readonly string[]>`:`git worktree list --porcelain` 解析出的目錄 basename,
  加上 `git branch --format=%(refname:short)` 的分支名。
- `createWorktree(deps, rootPath, wanted: string, tabId: string): Promise<{ kind: 'ok'; path: string; slug: string } | { kind: 'failed'; message: string }>`:
  依序 `existingSlugs` → `slugify` → `ensureIgnored` → `git worktree add <rootPath>/<dir>/<slug> -b <slug>`;任何一步失敗回 `failed` 與 git 的輸出。
- `removeWorktree(deps, rootPath, path): Promise<{ kind: 'removed' } | { kind: 'dirty' } | { kind: 'failed'; message: string }>`:
  先 `git -C <path> status --porcelain -uall`,有輸出回 `dirty`(**不移除、不加 `--force`**,規格 §3.5);
  乾淨就 `git worktree remove <path>`,失敗回 `failed`。分支不刪。

- [ ] Step 1:寫失敗測試。`slugify`:中英文混合、全部是符號時退回 `tab-xxxxxxxx`、重複加 `-2`、超過 32 字截斷;
  `worktreeDirName` 四種組合;`ensureIgnored` 三種(沒有檔案、有檔案沒那行、已經有那行且結尾帶斜線也算有);
  `createWorktree` 成功與 `git worktree add` 失敗;`removeWorktree` 三種結果,`dirty` 時斷言**沒有**呼叫 `worktree remove`。
- [ ] Step 2:`npx vitest run tests/worktree.test.ts` 確認失敗。
- [ ] Step 3:實作。
- [ ] Step 4:`npm run typecheck`、`npx vitest run`、`npm run test:coverage` 過。
- [ ] Step 5:`git commit -m "feat: worktree 的建立、命名與移除"`

---

### Task 2: 狀態、IPC 與建立流程

**Files:** `src/shared/projects.ts`(`TabEntry.worktreePath?`、`ConversationOpenPayload.worktreeName?`、`parseConversationOpen`)、
`src/main/projects-state.ts`(`NewConversationInput.worktreePath?`、`openConversationTab` 寫進 entry)、
`src/main/projects-ipc.ts:182-183`、`src/main/projects-schema.ts`、`src/main/index.ts`(注入 `run`/fs 的實作)、
`src/preload/bridge.ts`(`openConversation` 多帶選填參數)、`src/shared/ipc.ts`(`YesChefApi.openConversation` 簽名)、
測試:`tests/projects-shared.test.ts`(parse)、`tests/projects-state.test.ts`、`tests/projects-ipc.test.ts`、`tests/projects-store.test.ts`(舊檔相容)、`tests/preload-bridge.test.ts`

- `parseConversationOpen` 多收選填 `worktreeName`(非空字串才收,型別不對整包回 null)。
- `projects-ipc` 的 `onConversationOpen` 改成 async:有 `worktreeName` 時先 `createWorktree`,
  成功就把 `worktreePath` 一起寫進 tab;失敗就 `logError` 並**照常建立對話**(不開 worktree),不要整個不建。
- `openConversation(projectId, provider, worktreeName?)` 一路傳到主行程。
- 舊狀態檔沒有 `worktreePath` 照讀(schema 選填)。

- [ ] Step 1 到 5 同上(測試先行、逐步驗、一個 commit:`feat: 建立對話時可以指定 worktree`)。

---

### Task 3: cwd 與範圍改用 worktreePath,分頁標題顯示 slug

**Files:** `src/main/ipc-bridge.ts`(建 slot 時的 `cwd`、`runtimeFor` 的 rootPath)、`src/main/index.ts`(`currentProjectDir`/`activeProjectDir`)、
`src/renderer/components/LeftPane.tsx`(`labelOf`)、測試:`tests/ipc-bridge.test.ts`、`tests/left-pane.test.tsx`

- `createSlot` 裡 Claude 與 codex 兩條路的 cwd 都改成 `tab.worktreePath ?? rootPath`;
  `runtimeFor` 傳的 rootPath 同樣(右窗格 `file://` 的範圍檢查要跟著那個對話的目錄)。
- `index.ts` 的 `currentProjectDir()`/`activeProjectDir()`:前景對話有 `worktreePath` 就回它。
- 分頁標題:有 `worktreePath` 時在標題後面加 ` · <slug>`(slug 從路徑的 basename 取)。
- 測試:兩種 provider 的 slot 拿到的 cwd;`activeProjectDir` 跟著前景對話變;分頁標題。

- [ ] Step 1 到 5(commit:`feat: 有 worktree 的對話在自己的目錄工作`)。

---

### Task 4: 建立對話的 UI 與關閉時的處理

**Files:** `src/renderer/components/LeftPane.tsx`(新對話那兩顆按鈕旁的選項與輸入)、新 `src/renderer/components/NewConversationForm.tsx` + `.css`(若拆得開)、
`src/main/projects-ipc.ts`(關分頁時移除 worktree)、`src/main/index.ts`(接 `removeWorktree`)、
測試:`tests/left-pane.test.tsx`、`tests/projects-ipc.test.ts`

- UI:按「新對話」時展開一小塊:一個核取方塊 `在新的 worktree 開` 與一個輸入框(placeholder `這個對話要做什麼`),
  加「建立」。沒勾就是現在的行為。**專案不是 git repo 時整個選項不畫**(`ProjectView` 加選填 `isGitRepo`,
  主行程在推 view 時算一次;算的成本是一次 `git rev-parse`,只在專案清單變動時算)。
- 關閉分頁:`closeTab` 那條路,tab 有 `worktreePath` 時呼叫 `removeWorktree`;`dirty` 就把訊息交給 renderer 顯示
  (沿用既有的錯誤顯示路徑,或 `logError` 後由狀態列/對話區顯示,看現場哪條最短)。
- 測試:非 git repo 不畫選項;勾了並輸入後 `openConversation` 帶 `worktreeName`;關閉乾淨的會呼叫移除、`dirty` 的不會。

- [ ] Step 1 到 5(commit:`feat: 新對話可以開在 worktree,關閉時乾淨才移除`)。

## 驗收(我用真的 app 跑,規格 §4 六項)

1. git repo 專案建對話勾 worktree 輸入「測試一」→ 分頁標題帶 slug、`git worktree list` 多一條、`.gitignore` 有 `.worktrees`
2. 在那個對話叫 agent 改檔 → 改的是 worktree 那份,主目錄不變
3. 另一個對話改同一個檔 → 互不影響
4. 關掉乾淨的 → worktree 移除、分支還在
5. 關掉有改動的 → worktree 留著、畫面說明留在哪
6. 非 git 資料夾 → 沒有選項


### Task 5：修正 Task 3 審查的四項問題

- [x] 先補測試，確認 `/`、空字串、`///` 的標題，以及設定複製的四種情境會失敗，再修改實作。
- [x] 分頁路徑取不到 slug 時保留原標題，`runtimeFor` 的參數與註解改用 `cwd`。
- [x] Git 建立成功後複製 `.claude/settings.local.json`，來源不存在或目的地已存在時跳過，複製失敗只記錄錯誤。同步更新 `src/main/index.ts` 的注入與所有測試假 deps，複製採用獨占建立以避免覆蓋。
- [x] 在規格記錄 Insights 歸戶與 codex 歷史 thread 的已知行為，保留尚未進行 CLI 整合驗證的限制。
- [x] 新增 `npm run test:worktree`，集中執行 worktree、分頁及 IPC 的相關測試。

檢查結果與提交狀態記錄於 `.superpowers/sdd/2026-09-15-tab-worktree/task-5-report.md`。
