# 在介面裡把 worktree 分支合回主分支 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「查看 diff」面板加一條合併列,把對話分頁的 worktree 分支合回主目錄目前的分支;衝突留在 worktree 裡交給那個對話的 agent 解,主目錄永遠乾淨。

**Architecture:** 兩段式合併。第一段在 worktree 裡 `git merge --no-edit <target>`,衝突只會發生在這裡;第二段在主目錄 `git merge --ff-only <branch>`,所以主目錄不可能停在 merge 中。git 操作全部收在 `src/main/merge.ts`,它不 throw,只回 discriminated union。IPC 走一條新的 invoke 頻道 `worktree:merge`,形狀照 `test-machines` 那組;renderer 只有一個 hook 加一個元件,掛在 `DevelopmentDiff` 最上方。

**Tech Stack:** Electron 44、TypeScript 7(strict)、React 19、zod 4、vitest 4、`git-run.ts` 的 `createGitRun`。

**Spec:** `docs/specs/2026-09-23-worktree-merge-design.md`

## Global Constraints

- TypeScript strict,既有 eslint 規則,`npm run typecheck` 與 `npm test`(vitest)每個 task 結束都要綠。
- 不新增依賴。
- 程式與註解用台灣繁體中文,不用破折號,粗體一段最多一處;使用者看得到的訊息放在 `src/main/merge.ts` 的 `MSG`。
- 檔案 800 行以內,函式 50 行以內(工廠函式外層 closure 不算),不 mutate 既有物件,不用 `console.log`(用 deps 的 `logError`)。
- 跑 git 一律透過 `git-run.ts` 的 `run`,不自己 spawn;`merge.ts` 不 throw,全部回 discriminated union。
- 主目錄永遠不會處於 merge 中的狀態;yeschef 不在主目錄 commit。
- 既有 worktree 建立與關分頁流程不變,只加「已合併就 `branch -d`」。
- implementer 不 commit(controller 會 commit),但每個 task 最後一步仍寫出 commit 訊息。
- 新 CSS 只用 `theme.css` 的 token,受 `tests/theme-rules.test.ts` 約束。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/shared/worktree-merge.ts` | 新增 | 頻道常數、request/response 的 zod schema 與型別 |
| `src/main/merge.ts` | 新增 | `createMerge` 的 `status` / `merge` / `abort`,以及 `MSG` |
| `src/main/worktree-merge-ipc.ts` | 新增 | `worktree:merge` 的 handler,sender 檢查、`locate`、衝突時送 `userInput` |
| `src/main/worktree.ts` | 修改 | `removeWorktree` 移除成功後,分支已合併就 `branch -d` |
| `src/main/ipc-bridge.ts` | 修改 | `IpcBridge` 多一個 `conversationFor(projectId, tabId)` |
| `src/main/index.ts` | 修改 | 建 `createMerge`、註冊與解除 `WORKTREE_MERGE_CHANNEL` |
| `src/shared/ipc.ts` | 修改 | `YesChefApi` 多一個 `worktreeMerge` |
| `src/preload/bridge.ts` | 修改 | `worktreeMerge` 的 invoke 實作,請求與回應都過 schema |
| `src/renderer/hooks/useWorktreeMerge.ts` | 新增 | 查 status、送 merge/abort、之後重查 |
| `src/renderer/components/WorktreeMergeBar.tsx` | 新增 | 合併列的六種狀態 |
| `src/renderer/components/WorktreeMergeBar.css` | 新增 | 合併列樣式,只用 theme token |
| `src/renderer/components/DevelopmentDiff.tsx` | 修改 | 面板最上方掛合併列 |
| `src/renderer/components/PanelGroup.tsx` | 修改 | 依 `projects` 查出這個對話的 worktree 歸屬 |
| `src/renderer/App.tsx` | 修改 | 把 `projects.view.projects` 傳給 `PanelGroup` |
| `tests/helpers/fake-yeschef.ts` | 修改 | 假 api 補 `worktreeMerge` |
| `tests/worktree-merge-schema.test.ts` | 新增 | schema 的收與不收 |
| `tests/merge.test.ts` | 新增 | 假 `run` 驗 `merge` / `status` / `abort` |
| `tests/merge-real-git.test.ts` | 新增 | 真 git 的整合測試 |
| `tests/worktree-merge-ipc.test.ts` | 新增 | handler 的 sender、schema、衝突送訊息 |
| `tests/worktree-merge-bar.test.tsx` | 新增 | 六種狀態的畫面與按鈕 |
| `tests/worktree.test.ts` | 修改 | 補 `branch -d` 三條,並修既有兩條呼叫序列斷言 |
| `tests/development-diff-view.test.tsx` | 修改 | 補「有 worktree 才出現合併列」 |
| `docs/RESULTS-38-worktree-merge.md` | 新增 | 驗收結果骨架 |
| `docs/specs/2026-09-15-tab-worktree-design.md` | 修改 | §3.5、§3.6、§4 三處更正 |

---

### Task 1: `src/shared/worktree-merge.ts` 的頻道與 schema

**Files:**
- Create: `src/shared/worktree-merge.ts`
- Test: `tests/worktree-merge-schema.test.ts`

**Interfaces:**
- Produces:

```ts
export const WORKTREE_MERGE_CHANNEL = 'worktree:merge'
export const WorktreeMergeRequestSchema: z.ZodDiscriminatedUnion<...>
export const WorktreeMergeResponseSchema: z.ZodDiscriminatedUnion<...>
export type WorktreeMergeRequest = z.infer<typeof WorktreeMergeRequestSchema>
export type WorktreeMergeResponse = z.infer<typeof WorktreeMergeResponseSchema>
export type WorktreeMergeStatusResponse = Extract<WorktreeMergeResponse, { kind: 'status' }>
```

- 後面每個 task 都用這兩個型別:Task 5 的 handler 回 `WorktreeMergeResponse`,Task 6 的 hook 收它。
- 注意:zod 4 的 `z.discriminatedUnion(...)` 沒有 `.strict()` 方法,嚴格只能寫在每個成員上。規格 §4 那段示意碼把 `.strict()` 寫在 union 外層,照抄會 typecheck 失敗。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/worktree-merge-schema.test.ts
import { describe, expect, it } from 'vitest'
import {
  WORKTREE_MERGE_CHANNEL,
  WorktreeMergeRequestSchema,
  WorktreeMergeResponseSchema,
} from '../src/shared/worktree-merge.js'

describe('worktree:merge 的頻道與請求', () => {
  it('頻道名固定', () => {
    expect(WORKTREE_MERGE_CHANNEL).toBe('worktree:merge')
  })

  it.each(['status', 'merge', 'abort'])('%s 三個欄位收得下', (action) => {
    expect(WorktreeMergeRequestSchema.safeParse({ action, projectId: 'p1', tabId: 't1' }).success).toBe(true)
  })

  it('多餘欄位不收', () => {
    expect(WorktreeMergeRequestSchema.safeParse({ action: 'merge', projectId: 'p1', tabId: 't1', rootPath: '/repo' }).success).toBe(false)
  })

  it.each([
    { action: 'push', projectId: 'p1', tabId: 't1' },
    { action: 'merge', projectId: '', tabId: 't1' },
    { action: 'merge', projectId: 'p1', tabId: '' },
    { action: 'merge', projectId: 'p1' },
  ])('形狀不對不收:%j', (raw) => {
    expect(WorktreeMergeRequestSchema.safeParse(raw).success).toBe(false)
  })
})

describe('worktree:merge 的回應', () => {
  it.each([
    { kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: false, conflictPending: false, message: '分支 task → main,領先 2 個 commit' },
    { kind: 'status', branch: 'task', target: null, ahead: 0, dirty: true, conflictPending: true, message: '主目錄不在任何分支上(detached HEAD),先切回分支' },
    { kind: 'merged', target: 'main', branch: 'task', commits: 2, message: '已合併到 main(2 個 commit)' },
    { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突' },
    { kind: 'conflictPending', files: ['src/a.ts'], message: '上一次的衝突還沒解完:src/a.ts' },
    { kind: 'rootDirty', files: ['src/b.ts'], message: '主目錄有未提交的改動' },
    { kind: 'rootDetached', message: '主目錄不在任何分支上' },
    { kind: 'agentBusy', message: 'agent 還在工作' },
    { kind: 'failed', message: '合併失敗:fatal' },
    { kind: 'aborted' },
    { kind: 'error', message: '這個分頁沒有 worktree' },
  ])('十一種回應都收:%j', (raw) => {
    expect(WorktreeMergeResponseSchema.safeParse(raw).success).toBe(true)
  })

  it('回應多欄位不收,ahead 不收負數', () => {
    expect(WorktreeMergeResponseSchema.safeParse({ kind: 'aborted', extra: 1 }).success).toBe(false)
    expect(WorktreeMergeResponseSchema.safeParse({ kind: 'status', branch: 'task', target: 'main', ahead: -1, dirty: false, conflictPending: false, message: 'x' }).success).toBe(false)
  })

  it('不帶絕對路徑以外的資料:conflict 只有四個欄位', () => {
    const shape = WorktreeMergeResponseSchema.safeParse({
      kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突', worktreePath: '/repo/.worktrees/task',
    })
    expect(shape.success).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/worktree-merge-schema.test.ts`
Expected: FAIL,`Cannot find module '../src/shared/worktree-merge.js'`

- [ ] **Step 3: 寫出 schema**

```ts
// src/shared/worktree-merge.ts
import { z } from 'zod'

export const WORKTREE_MERGE_CHANNEL = 'worktree:merge'

const id = z.string().min(1)
const files = z.array(z.string())
const count = z.number().int().nonnegative()

/** renderer 只送 projectId 與 tabId,路徑一律由主行程從 projects state 查(規格 §4)。 */
export const WorktreeMergeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), projectId: id, tabId: id }).strict(),
  z.object({ action: z.literal('merge'), projectId: id, tabId: id }).strict(),
  z.object({ action: z.literal('abort'), projectId: id, tabId: id }).strict(),
])

/**
 * 回應只帶顯示用的資料:分支名、相對 worktree 的檔案路徑、commit 數、訊息。
 * 每一種都帶 message,整串文字在主行程的 MSG 組好,renderer 不重組字串。
 */
export const WorktreeMergeResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('status'),
    branch: z.string(),
    target: z.string().nullable(),
    ahead: count,
    dirty: z.boolean(),
    conflictPending: z.boolean(),
    message: z.string(),
  }).strict(),
  z.object({ kind: z.literal('merged'), target: z.string(), branch: z.string(), commits: count, message: z.string() }).strict(),
  z.object({ kind: z.literal('conflict'), target: z.string(), branch: z.string(), files, message: z.string() }).strict(),
  z.object({ kind: z.literal('conflictPending'), files, message: z.string() }).strict(),
  z.object({ kind: z.literal('rootDirty'), files, message: z.string() }).strict(),
  z.object({ kind: z.literal('rootDetached'), message: z.string() }).strict(),
  z.object({ kind: z.literal('agentBusy'), message: z.string() }).strict(),
  z.object({ kind: z.literal('failed'), message: z.string() }).strict(),
  z.object({ kind: z.literal('aborted') }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])

export type WorktreeMergeRequest = z.infer<typeof WorktreeMergeRequestSchema>
export type WorktreeMergeResponse = z.infer<typeof WorktreeMergeResponseSchema>
export type WorktreeMergeStatusResponse = Extract<WorktreeMergeResponse, { kind: 'status' }>
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/worktree-merge-schema.test.ts` 與 `npm run typecheck`
Expected: PASS,typecheck 乾淨

- [ ] **Step 5: Commit**

```bash
git add src/shared/worktree-merge.ts tests/worktree-merge-schema.test.ts
git commit -m "feat: add worktree merge ipc schema"
```

---

### Task 2: `src/main/merge.ts` 的 status、merge、abort

**Files:**
- Create: `src/main/merge.ts`
- Test: `tests/merge.test.ts`

**Interfaces:**
- Consumes:`WorktreeDeps['run']`(`src/main/worktree.ts`),簽名是
  `(args: readonly string[], cwd: string) => Promise<{ readonly ok: boolean; readonly out: string }>`。
- Produces:

```ts
export type GitRun = WorktreeDeps['run']
export interface MergeDeps { readonly run: GitRun; readonly logError: (error: Error) => void }
export interface MergeArgs {
  readonly rootPath: string
  readonly worktreePath: string
  readonly label: string
  readonly agentBusy: () => boolean
}
export type MergeRefusal =
  | { readonly kind: 'conflictPending'; readonly files: readonly string[] }
  | { readonly kind: 'rootDirty'; readonly files: readonly string[] }
  | { readonly kind: 'rootDetached' }
  | { readonly kind: 'agentBusy' }
  | { readonly kind: 'failed'; readonly message: string }
export type MergeResult =
  | { readonly kind: 'merged'; readonly target: string; readonly branch: string; readonly commits: number }
  | { readonly kind: 'conflict'; readonly target: string; readonly branch: string; readonly files: readonly string[] }
  | MergeRefusal
export interface MergeStatus {
  readonly kind: 'status'
  readonly branch: string
  readonly target: string | null
  readonly ahead: number
  readonly dirty: boolean
  readonly conflictPending: boolean
}
export type MergeStatusResult = MergeStatus | { readonly kind: 'failed'; readonly message: string }
export type AbortResult = { readonly kind: 'aborted' } | { readonly kind: 'failed'; readonly message: string }
export interface MergeService {
  status(args: Pick<MergeArgs, 'rootPath' | 'worktreePath'>): Promise<MergeStatusResult>
  merge(args: MergeArgs): Promise<MergeResult>
  abort(args: Pick<MergeArgs, 'worktreePath'>): Promise<AbortResult>
}
export function createMerge(deps: MergeDeps): MergeService
export const MSG: { ... }   // 見 Step 3
```

- Task 5 的 handler 會 import `createMerge`、`MergeService`、`MSG`;Task 3 的整合測試 import `createMerge`。
- 對規格的三處補充:
  1. `MergeStatus` 多一個 `kind: 'status'` 判別欄位(規格 §3 沒寫,但 `MergeStatus | Failed` 沒有共同判別鍵,加了才能 narrow)。
  2. `MSG` 多一個 `worktreeDetached` 與一個 `status(...)`,前者是 worktree 自己 detached 的情況,後者是合併列平常態那行字。
  3. `commits` 的計算時機:規格 §3.1 第 9 點寫「合併前算好」,改成第一段 `git merge --no-edit <target>` 成功之後、第二段 ff 之前算。合併前算會漏掉第一段產生的 merge commit,合併後算出來的 `rev-list --count <target>..<branch>` 才是真正會進主分支的 commit 數。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/merge.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createMerge, MSG, type MergeDeps } from '../src/main/merge.js'

const ROOT = '/repo'
const WT = '/repo/.worktrees/task'
const EXCLUDE = ':!.claude/settings.local.json'
const ok = (out = '') => ({ ok: true, out })
const no = (out: string) => ({ ok: false, out })

/** 一路順利合併時的九次 git 呼叫;每個案例只改它要改的那一筆。 */
function base(): Record<string, { ok: boolean; out: string }> {
  return {
    [`${ROOT}|status --porcelain`]: ok(''),
    [`${ROOT}|symbolic-ref --short HEAD`]: ok('main\n'),
    [`${WT}|rev-parse -q --verify MERGE_HEAD`]: no(''),
    [`${WT}|symbolic-ref --short HEAD`]: ok('task\n'),
    [`${WT}|add -A -- . ${EXCLUDE}`]: ok(''),
    [`${WT}|status --porcelain -- . ${EXCLUDE}`]: ok(''),
    [`${WT}|rev-list --count main..task`]: ok('2\n'),
    [`${WT}|merge --no-edit main`]: ok(''),
    [`${ROOT}|merge --ff-only task`]: ok(''),
  }
}

function fake(overrides: Record<string, { ok: boolean; out: string }> = {}) {
  const table = { ...base(), ...overrides }
  const calls: string[] = []
  const run = vi.fn<MergeDeps['run']>(async (args, cwd) => {
    const key = `${cwd}|${args.join(' ')}`
    calls.push(key)
    return table[key] ?? ok('')
  })
  const logError = vi.fn<MergeDeps['logError']>()
  return { run, logError, calls, service: createMerge({ run, logError }) }
}

const args = (agentBusy = false) => ({ rootPath: ROOT, worktreePath: WT, label: '加購價上限', agentBusy: () => agentBusy })

describe('merge 的前置檢查', () => {
  it('agent 忙碌時不跑任何 git', async () => {
    const f = fake()
    expect(await f.service.merge(args(true))).toEqual({ kind: 'agentBusy' })
    expect(f.run).not.toHaveBeenCalled()
  })

  it('主目錄有未提交改動就拒絕,並列出路徑', async () => {
    const f = fake({ [`${ROOT}|status --porcelain`]: ok(' M src/a.ts\n?? src/b.ts\n') })
    expect(await f.service.merge(args())).toEqual({ kind: 'rootDirty', files: ['src/a.ts', 'src/b.ts'] })
    expect(f.calls).toEqual([`${ROOT}|status --porcelain`])
  })

  it('主目錄 detached 就拒絕', async () => {
    const f = fake({ [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal: ref HEAD is not a symbolic ref') })
    expect(await f.service.merge(args())).toEqual({ kind: 'rootDetached' })
    expect(f.calls).not.toContain(`${WT}|merge --no-edit main`)
  })

  it('worktree 還在 merge 中就回 conflictPending', async () => {
    const f = fake({
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: ok('abc123\n'),
      [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\nsrc/b.ts\n'),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'conflictPending', files: ['src/a.ts', 'src/b.ts'] })
    expect(f.calls).not.toContain(`${WT}|add -A -- . ${EXCLUDE}`)
  })

  it('worktree 分支名用 symbolic-ref 讀,不從路徑猜', async () => {
    const f = fake({ [`${WT}|symbolic-ref --short HEAD`]: ok('feature/別的名字\n'), [`${WT}|rev-list --count main..feature/別的名字`]: ok('1\n') })
    expect(await f.service.merge(args())).toEqual({ kind: 'merged', target: 'main', branch: 'feature/別的名字', commits: 1 })
    expect(f.calls).toContain(`${ROOT}|merge --ff-only feature/別的名字`)
  })

  it('worktree 也 detached 時回 failed', async () => {
    const f = fake({ [`${WT}|symbolic-ref --short HEAD`]: no('fatal') })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: MSG.worktreeDetached })
  })
})

describe('merge 的自動提交', () => {
  it('有改動就 add 並 commit,排除本機設定檔', async () => {
    const f = fake({ [`${WT}|status --porcelain -- . ${EXCLUDE}`]: ok('A  src/a.ts\n') })
    expect(await f.service.merge(args())).toMatchObject({ kind: 'merged' })
    expect(f.run).toHaveBeenCalledWith(['add', '-A', '--', '.', EXCLUDE], WT)
    expect(f.run).toHaveBeenCalledWith(['commit', '-m', MSG.autoCommit('加購價上限')], WT)
  })

  it('沒有改動就不 commit', async () => {
    const f = fake()
    expect(await f.service.merge(args())).toMatchObject({ kind: 'merged' })
    expect(f.calls.some((key) => key.includes('|commit'))).toBe(false)
  })

  it('commit 失敗回 failed 的第一行', async () => {
    const f = fake({
      [`${WT}|status --porcelain -- . ${EXCLUDE}`]: ok('A  src/a.ts\n'),
      [`${WT}|commit -m ${MSG.autoCommit('加購價上限')}`]: no('fatal: 無法提交\n第二行\n'),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'fatal: 無法提交' })
  })
})

describe('merge 的兩段', () => {
  it('第一段衝突時回 conflict,不做第二段', async () => {
    const f = fake({
      [`${WT}|merge --no-edit main`]: no('CONFLICT (content): Merge conflict in src/a.ts'),
      [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\n'),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'] })
    expect(f.calls).not.toContain(`${ROOT}|merge --ff-only task`)
  })

  it('第一段失敗但沒有衝突檔案時回 failed', async () => {
    const f = fake({
      [`${WT}|merge --no-edit main`]: no('fatal: 無法合併\n細節\n'),
      [`${WT}|diff --name-only --diff-filter=U`]: ok(''),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'fatal: 無法合併' })
    expect(f.calls).not.toContain(`${ROOT}|merge --ff-only task`)
  })

  it('第二段 ff 失敗回 failed', async () => {
    const f = fake({ [`${ROOT}|merge --ff-only task`]: no('fatal: Not possible to fast-forward\n') })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'fatal: Not possible to fast-forward' })
  })

  it('commits 在第一段成功之後才算,順序固定', async () => {
    const f = fake()
    expect(await f.service.merge(args())).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: 2 })
    expect(f.calls).toEqual([
      `${ROOT}|status --porcelain`,
      `${ROOT}|symbolic-ref --short HEAD`,
      `${WT}|rev-parse -q --verify MERGE_HEAD`,
      `${WT}|symbolic-ref --short HEAD`,
      `${WT}|add -A -- . ${EXCLUDE}`,
      `${WT}|status --porcelain -- . ${EXCLUDE}`,
      `${WT}|merge --no-edit main`,
      `${WT}|rev-list --count main..task`,
      `${ROOT}|merge --ff-only task`,
    ])
  })

  it('第一段失敗時不算 commits', async () => {
    const f = fake({
      [`${WT}|merge --no-edit main`]: no('CONFLICT (content): Merge conflict in src/a.ts'),
      [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\n'),
    })
    expect(await f.service.merge(args())).toMatchObject({ kind: 'conflict' })
    expect(f.calls.some((key) => key.includes('rev-list'))).toBe(false)
  })

  it('已是最新時 commits 為 0', async () => {
    const f = fake({ [`${WT}|rev-list --count main..task`]: ok('0\n') })
    expect(await f.service.merge(args())).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: 0 })
  })

  it('run 丟例外時記錄並回 failed', async () => {
    const f = fake()
    f.run.mockRejectedValueOnce(new Error('missing git'))
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'missing git' })
    expect(f.logError).toHaveBeenCalledWith(expect.objectContaining({ message: 'missing git' }))
  })
})

describe('status', () => {
  it('五個欄位都查出來', async () => {
    const f = fake({
      [`${WT}|status --porcelain -- . ${EXCLUDE}`]: ok(' M src/a.ts\n'),
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: ok('abc\n'),
    })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT })).toEqual({
      kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: true, conflictPending: true,
    })
  })

  it('主目錄 detached 時 target 為 null,ahead 為 0,不查 rev-list', async () => {
    const f = fake({ [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal') })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT })).toEqual({
      kind: 'status', branch: 'task', target: null, ahead: 0, dirty: false, conflictPending: false,
    })
    expect(f.calls.some((key) => key.includes('rev-list'))).toBe(false)
  })

  it('rev-list 失敗時 ahead 當 0,不整個失敗', async () => {
    const f = fake({ [`${WT}|rev-list --count main..task`]: no('fatal: bad revision') })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT })).toMatchObject({ ahead: 0 })
  })

  it('worktree detached 時回 failed', async () => {
    const f = fake({ [`${WT}|symbolic-ref --short HEAD`]: no('fatal') })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT })).toEqual({ kind: 'failed', message: MSG.worktreeDetached })
  })
})

describe('abort', () => {
  it('送 merge --abort 到 worktree', async () => {
    const f = fake()
    expect(await f.service.abort({ worktreePath: WT })).toEqual({ kind: 'aborted' })
    expect(f.calls).toEqual([`${WT}|merge --abort`])
  })

  it('失敗回 failed 的第一行', async () => {
    const f = fake({ [`${WT}|merge --abort`]: no('fatal: 沒有進行中的合併\n第二行\n') })
    expect(await f.service.abort({ worktreePath: WT })).toEqual({ kind: 'failed', message: 'fatal: 沒有進行中的合併' })
  })
})

describe('MSG', () => {
  it('自動提交訊息帶分頁標籤', () => {
    expect(MSG.autoCommit('加購價上限')).toBe('yeschef:合併前自動提交(加購價上限)')
  })

  it('給 agent 的那句帶目標分支與檔案', () => {
    expect(MSG.agentConflict('main', ['src/a.ts', 'src/b.ts'])).toContain('main')
    expect(MSG.agentConflict('main', ['src/a.ts', 'src/b.ts'])).toContain('src/a.ts、src/b.ts')
    expect(MSG.agentConflict('main', [])).toContain('請解決衝突')
  })

  it('平常態那行字在 dirty 時多一段', () => {
    expect(MSG.status('task', 'main', 2, false)).toBe('分支 task → main,領先 2 個 commit')
    expect(MSG.status('task', 'main', 2, true)).toBe('分支 task → main,領先 2 個 commit(含未提交的改動)')
    expect(MSG.upToDate('main')).toBe('已是最新,沒有要合併的 commit')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/merge.test.ts`
Expected: FAIL,`Cannot find module '../src/main/merge.js'`

- [ ] **Step 3: 寫出 `merge.ts`**

```ts
// src/main/merge.ts
import type { WorktreeDeps } from './worktree.js'

export type GitRun = WorktreeDeps['run']

export interface MergeDeps {
  readonly run: GitRun
  readonly logError: (error: Error) => void
}

export interface MergeArgs {
  readonly rootPath: string
  readonly worktreePath: string
  /** 分頁標籤,只拿來組自動提交的訊息。 */
  readonly label: string
  readonly agentBusy: () => boolean
}

export type MergeRefusal =
  | { readonly kind: 'conflictPending'; readonly files: readonly string[] }
  | { readonly kind: 'rootDirty'; readonly files: readonly string[] }
  | { readonly kind: 'rootDetached' }
  | { readonly kind: 'agentBusy' }
  | { readonly kind: 'failed'; readonly message: string }

export type MergeResult =
  | { readonly kind: 'merged'; readonly target: string; readonly branch: string; readonly commits: number }
  | { readonly kind: 'conflict'; readonly target: string; readonly branch: string; readonly files: readonly string[] }
  | MergeRefusal

export interface MergeStatus {
  readonly kind: 'status'
  readonly branch: string
  /** 主目錄 detached 時為 null。 */
  readonly target: string | null
  readonly ahead: number
  readonly dirty: boolean
  readonly conflictPending: boolean
}

export type MergeStatusResult = MergeStatus | { readonly kind: 'failed'; readonly message: string }
export type AbortResult = { readonly kind: 'aborted' } | { readonly kind: 'failed'; readonly message: string }

export interface MergeService {
  status(args: Pick<MergeArgs, 'rootPath' | 'worktreePath'>): Promise<MergeStatusResult>
  merge(args: MergeArgs): Promise<MergeResult>
  abort(args: Pick<MergeArgs, 'worktreePath'>): Promise<AbortResult>
}

/** 建 worktree 時複製進去的本機設定不進歷史(tab-worktree 規格 §3)。 */
const EXCLUDE_LOCAL_SETTINGS = ':!.claude/settings.local.json'
const WORKTREE_SCOPE: readonly string[] = ['--', '.', EXCLUDE_LOCAL_SETTINGS]

export const MSG = {
  rootDirty: (files: readonly string[]) => `主目錄有未提交的改動,先處理再合併:${files.join('、')}`,
  rootDetached: '主目錄不在任何分支上(detached HEAD),先切回分支',
  worktreeDetached: 'worktree 不在任何分支上,無法合併',
  agentBusy: 'agent 還在工作,等這個回合結束再合併',
  conflict: (target: string, branch: string, files: readonly string[]) =>
    `主分支 ${target} 合進 ${branch} 時有衝突:${files.join('、')}。已請 agent 處理`,
  conflictPending: (files: readonly string[]) => `上一次的衝突還沒解完:${files.join('、')}`,
  failed: (message: string) => `合併失敗:${message}`,
  merged: (target: string, commits: number) => `已合併到 ${target}(${String(commits)} 個 commit)`,
  upToDate: (_target: string) => '已是最新,沒有要合併的 commit',
  autoCommit: (label: string) => `yeschef:合併前自動提交(${label})`,
  status: (branch: string, target: string, ahead: number, dirty: boolean) =>
    `分支 ${branch} → ${target},領先 ${String(ahead)} 個 commit${dirty ? '(含未提交的改動)' : ''}`,
  agentConflict: (target: string, files: readonly string[]) =>
    `主分支 ${target} 已合進目前分支,但有衝突:${files.join('、')}。請解決衝突、確認測試後提交(merge commit)。完成後我會再按合併。`,
} as const

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** git 失敗時只取第一行:多行細節放進 UI 一列裡看不清楚。 */
function firstLine(out: string): string {
  return out.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '未知的 git 錯誤'
}

function names(out: string): readonly string[] {
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/** `git status --porcelain` 每行前三個字元是狀態碼。 */
function porcelainPaths(out: string): readonly string[] {
  return out.split('\n').filter((line) => line.length > 3).map((line) => line.slice(3))
}

export function createMerge(deps: MergeDeps): MergeService {
  const branchOf = async (cwd: string): Promise<string | undefined> => {
    const head = await deps.run(['symbolic-ref', '--short', 'HEAD'], cwd)
    const value = head.ok ? head.out.trim() : ''
    return value.length > 0 ? value : undefined
  }

  const conflictFiles = async (cwd: string): Promise<readonly string[]> => {
    const listed = await deps.run(['diff', '--name-only', '--diff-filter=U'], cwd)
    return listed.ok ? names(listed.out) : []
  }

  const hasMergeHead = async (cwd: string): Promise<boolean> =>
    (await deps.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)).ok

  const aheadOf = async (cwd: string, target: string, branch: string): Promise<number> => {
    const counted = await deps.run(['rev-list', '--count', `${target}..${branch}`], cwd)
    const value = Number(counted.ok ? counted.out.trim() : '')
    return Number.isInteger(value) && value >= 0 ? value : 0
  }

  const dirtyPaths = async (cwd: string): Promise<readonly string[] | undefined> => {
    const listed = await deps.run(['status', '--porcelain', ...WORKTREE_SCOPE], cwd)
    return listed.ok ? porcelainPaths(listed.out) : undefined
  }

  /** 五道前置檢查,任一不過就回報,什麼都不動(規格 §3.1)。 */
  const precheck = async (
    args: MergeArgs,
  ): Promise<{ readonly kind: 'ok'; readonly target: string; readonly branch: string } | MergeRefusal> => {
    if (args.agentBusy()) return { kind: 'agentBusy' }
    const rootStatus = await deps.run(['status', '--porcelain'], args.rootPath)
    if (rootStatus.ok === false) return { kind: 'failed', message: firstLine(rootStatus.out) }
    const dirty = porcelainPaths(rootStatus.out)
    if (dirty.length > 0) return { kind: 'rootDirty', files: dirty }
    const target = await branchOf(args.rootPath)
    if (target === undefined) return { kind: 'rootDetached' }
    if (await hasMergeHead(args.worktreePath)) {
      return { kind: 'conflictPending', files: await conflictFiles(args.worktreePath) }
    }
    const branch = await branchOf(args.worktreePath)
    if (branch === undefined) return { kind: 'failed', message: MSG.worktreeDetached }
    return { kind: 'ok', target, branch }
  }

  /** 合併前先把 worktree 的未提交改動固定成一個 commit;沒有改動就什麼都不做。 */
  const autoCommit = async (args: MergeArgs): Promise<MergeRefusal | undefined> => {
    const added = await deps.run(['add', '-A', ...WORKTREE_SCOPE], args.worktreePath)
    if (added.ok === false) return { kind: 'failed', message: firstLine(added.out) }
    const staged = await dirtyPaths(args.worktreePath)
    if (staged === undefined) return { kind: 'failed', message: MSG.worktreeDetached }
    if (staged.length === 0) return undefined
    const committed = await deps.run(['commit', '-m', MSG.autoCommit(args.label)], args.worktreePath)
    return committed.ok ? undefined : { kind: 'failed', message: firstLine(committed.out) }
  }

  /** 第一段:把目標分支併進 worktree 分支。衝突只會發生在這裡。 */
  const joinTarget = async (
    args: MergeArgs, target: string, branch: string,
  ): Promise<{ readonly kind: 'ok' } | Extract<MergeResult, { kind: 'conflict' | 'failed' }>> => {
    const joined = await deps.run(['merge', '--no-edit', target], args.worktreePath)
    if (joined.ok) return { kind: 'ok' }
    const files = await conflictFiles(args.worktreePath)
    if (files.length > 0) return { kind: 'conflict', target, branch, files }
    return { kind: 'failed', message: firstLine(joined.out) }
  }

  const merge = async (args: MergeArgs): Promise<MergeResult> => {
    try {
      const checked = await precheck(args)
      if (checked.kind !== 'ok') return checked
      const { target, branch } = checked
      const refused = await autoCommit(args)
      if (refused !== undefined) return refused
      const joined = await joinTarget(args, target, branch)
      if (joined.kind !== 'ok') return joined
      // 第一段成功之後才算:這時 target..branch 就是真正會進主分支的 commit,含第一段產生的 merge commit。
      const commits = await aheadOf(args.worktreePath, target, branch)
      // 第二段一定是 fast-forward,主目錄因此永遠不會停在 merge 中。
      const fast = await deps.run(['merge', '--ff-only', branch], args.rootPath)
      if (fast.ok === false) return { kind: 'failed', message: firstLine(fast.out) }
      return { kind: 'merged', target, branch, commits }
    } catch (error) {
      const failure = asError(error)
      deps.logError(failure)
      return { kind: 'failed', message: failure.message }
    }
  }

  const status = async (args: Pick<MergeArgs, 'rootPath' | 'worktreePath'>): Promise<MergeStatusResult> => {
    try {
      const branch = await branchOf(args.worktreePath)
      if (branch === undefined) return { kind: 'failed', message: MSG.worktreeDetached }
      const target = await branchOf(args.rootPath) ?? null
      const dirty = await dirtyPaths(args.worktreePath)
      if (dirty === undefined) return { kind: 'failed', message: MSG.worktreeDetached }
      return {
        kind: 'status',
        branch,
        target,
        ahead: target === null ? 0 : await aheadOf(args.worktreePath, target, branch),
        dirty: dirty.length > 0,
        conflictPending: await hasMergeHead(args.worktreePath),
      }
    } catch (error) {
      const failure = asError(error)
      deps.logError(failure)
      return { kind: 'failed', message: failure.message }
    }
  }

  const abort = async (args: Pick<MergeArgs, 'worktreePath'>): Promise<AbortResult> => {
    try {
      const aborted = await deps.run(['merge', '--abort'], args.worktreePath)
      return aborted.ok ? { kind: 'aborted' } : { kind: 'failed', message: firstLine(aborted.out) }
    } catch (error) {
      const failure = asError(error)
      deps.logError(failure)
      return { kind: 'failed', message: failure.message }
    }
  }

  return { status, merge, abort }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/merge.test.ts` 與 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/merge.ts tests/merge.test.ts
git commit -m "feat: add two-stage worktree merge service"
```

---

### Task 3: 真 git 的整合測試

**Files:**
- Test: `tests/merge-real-git.test.ts`
- Modify(只有在測出 bug 時):`src/main/merge.ts`

**Interfaces:**
- Consumes:Task 2 的 `createMerge(deps: MergeDeps): MergeService`、`MSG`;`src/main/git-run.ts` 的
  `createGitRun(execFileFn: GitExecFile): WorktreeDeps['run']`,把 `node:child_process` 的 `execFile` 直接傳進去。
- Produces:沒有新的匯出。這個 task 的產出是「`merge.ts` 對真的 git 成立」這件事;若跑出 bug 就在這個 task 裡改 `merge.ts`,並在 `tests/merge.test.ts` 補一條對應的假 `run` 案例。
- 環境:vitest 預設環境就是 node,`vitest.config.ts` 沒有全域 `environment`,只有需要 DOM 的檔案在第一行寫 `// @vitest-environment jsdom`。這個檔案不要寫那行。暫存目錄照 `tests/development-diff.test.ts` 的作法:`mkdtemp(join(tmpdir(), ...))`,`afterEach` 一併 `rm`。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/merge-real-git.test.ts
import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGitRun } from '../src/main/git-run.js'
import { createMerge, MSG } from '../src/main/merge.js'

// 這些案例會開真的 git 子行程,全套跑的時候要留餘裕。
vi.setConfig({ testTimeout: 30000 })

const exec = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-merge-test-'))
  roots.push(root)
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Synthetic')
  await git(root, 'config', 'user.email', 'synthetic@example.invalid')
  await git(root, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(root, 'file.txt'), 'base\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'base')
  const worktreePath = join(root, '.worktrees', 'task')
  await git(root, 'worktree', 'add', worktreePath, '-b', 'task')
  const logError = vi.fn<(error: Error) => void>()
  const service = createMerge({ run: createGitRun(execFile), logError })
  const args = { rootPath: root, worktreePath, label: '加購價上限', agentBusy: () => false }
  return { root, worktreePath, git, service, logError, args }
}

it('worktree 提交後合併成功,主目錄的 log 有那個 commit', async () => {
  const r = await rig()
  await writeFile(join(r.worktreePath, 'file.txt'), 'from worktree\n')
  await r.git(r.worktreePath, 'commit', '-am', 'worktree 的修改')
  expect(await r.service.status({ rootPath: r.root, worktreePath: r.worktreePath }))
    .toEqual({ kind: 'status', branch: 'task', target: 'main', ahead: 1, dirty: false, conflictPending: false })
  expect(await r.service.merge(r.args)).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: 1 })
  expect(await r.git(r.root, 'log', '--oneline')).toContain('worktree 的修改')
  expect(await readFile(join(r.root, 'file.txt'), 'utf8')).toBe('from worktree\n')
  expect(r.logError).not.toHaveBeenCalled()
})

it('worktree 有未提交改動時先自動提交,再合併;本機設定檔不進歷史', async () => {
  const r = await rig()
  await writeFile(join(r.worktreePath, 'file.txt'), 'uncommitted\n')
  await exec('mkdir', ['-p', join(r.worktreePath, '.claude')])
  await writeFile(join(r.worktreePath, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Read"]}}')
  expect(await r.service.merge(r.args)).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: 1 })
  expect(await r.git(r.root, 'log', '--oneline')).toContain(MSG.autoCommit('加購價上限'))
  const tracked = await r.git(r.root, 'ls-files')
  expect(tracked).not.toContain('settings.local.json')
  expect(tracked).toContain('file.txt')
})

it('兩邊改同一個檔時第一次得到 conflict,解完再按一次得到 merged', async () => {
  const r = await rig()
  await writeFile(join(r.worktreePath, 'file.txt'), 'from worktree\n')
  await r.git(r.worktreePath, 'commit', '-am', 'worktree 的修改')
  await writeFile(join(r.root, 'file.txt'), 'from root\n')
  await r.git(r.root, 'commit', '-am', '主目錄的修改')

  expect(await r.service.merge(r.args)).toEqual({ kind: 'conflict', target: 'main', branch: 'task', files: ['file.txt'] })
  // 主目錄不能被第一段影響:HEAD 還在自己的 commit 上,而且沒有 MERGE_HEAD。
  expect(await r.git(r.root, 'log', '-1', '--pretty=%s')).toContain('主目錄的修改')
  await expect(exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: r.root })).rejects.toThrow()

  // 還沒解完就再按一次:回 conflictPending。
  expect(await r.service.merge(r.args)).toEqual({ kind: 'conflictPending', files: ['file.txt'] })

  await writeFile(join(r.worktreePath, 'file.txt'), 'resolved\n')
  await r.git(r.worktreePath, 'add', 'file.txt')
  await r.git(r.worktreePath, 'commit', '--no-edit')

  // commits 在第一段之後才算,所以這裡是 worktree 自己的 commit 加上解衝突的 merge commit。
  const second = await r.service.merge(r.args)
  expect(second).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: 2 })
  expect(await readFile(join(r.root, 'file.txt'), 'utf8')).toBe('resolved\n')
})

it('衝突中途 abort,worktree 回到解衝突前的狀態', async () => {
  const r = await rig()
  await writeFile(join(r.worktreePath, 'file.txt'), 'from worktree\n')
  await r.git(r.worktreePath, 'commit', '-am', 'worktree 的修改')
  await writeFile(join(r.root, 'file.txt'), 'from root\n')
  await r.git(r.root, 'commit', '-am', '主目錄的修改')
  expect(await r.service.merge(r.args)).toMatchObject({ kind: 'conflict' })
  expect(await r.service.abort({ worktreePath: r.worktreePath })).toEqual({ kind: 'aborted' })
  expect(await readFile(join(r.worktreePath, 'file.txt'), 'utf8')).toBe('from worktree\n')
  expect(await r.service.status({ rootPath: r.root, worktreePath: r.worktreePath }))
    .toMatchObject({ conflictPending: false, dirty: false })
})

it('主目錄有未提交改動時拒絕,什麼都不動', async () => {
  const r = await rig()
  await writeFile(join(r.worktreePath, 'file.txt'), 'from worktree\n')
  await r.git(r.worktreePath, 'commit', '-am', 'worktree 的修改')
  await writeFile(join(r.root, 'file.txt'), 'dirty\n')
  expect(await r.service.merge(r.args)).toEqual({ kind: 'rootDirty', files: ['file.txt'] })
  expect(await r.git(r.root, 'log', '--oneline')).not.toContain('worktree 的修改')
})

it('主目錄 detached 時拒絕', async () => {
  const r = await rig()
  await r.git(r.root, 'checkout', '--detach')
  expect(await r.service.merge(r.args)).toEqual({ kind: 'rootDetached' })
  expect(await r.service.status({ rootPath: r.root, worktreePath: r.worktreePath }))
    .toMatchObject({ target: null, ahead: 0 })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/merge-real-git.test.ts`
Expected: 全部 FAIL 或部分 FAIL。這個 task 開始時 `merge.ts` 已存在(Task 2),所以預期是:
第一條「worktree 提交後合併成功」可能直接過,其餘幾條會暴露真 git 與假 `run` 的差異。
把每一條失敗的訊息記下來,Step 3 逐條修。

- [ ] **Step 3: 依失敗訊息修 `merge.ts`,每修一處就在 `tests/merge.test.ts` 補一條假 `run` 的對應案例**

已知會踩到的三件事,先確認實作有照下面這樣寫:

1. `git commit --no-edit` 解完衝突之後,第二次 `merge --no-edit main` 會印
   `Already up to date.` 並且 exit 0,所以 `joinTarget` 走 `{ kind: 'ok' }`,不需要特別處理。
2. `git rev-parse -q --verify MERGE_HEAD` 在沒有 MERGE_HEAD 時 exit 1 且 stderr 為空,
   `createGitRun` 會回 `{ ok: false, out: error.message }`。`hasMergeHead` 只看 `ok`,不看 `out`,是對的。
3. `git add -A -- . ':!.claude/settings.local.json'` 的 pathspec magic 在 `execFile` 下不經過 shell,
   不需要跳脫。若 git 版本抱怨 `:!`,改成 `:(exclude).claude/settings.local.json` 並同步改
   `tests/merge.test.ts` 的 `EXCLUDE` 常數與 Task 5 之後所有引用。

若真的改了 `merge.ts`,在 `tests/merge.test.ts` 加一條:

```ts
it('真 git 回歸:第二次合併遇到 Already up to date 時直接做第二段', async () => {
  const f = fake({ [`${WT}|merge --no-edit main`]: ok('Already up to date.\n') })
  expect(await f.service.merge(args())).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: 2 })
  expect(f.calls).toContain(`${ROOT}|merge --ff-only task`)
})
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/merge-real-git.test.ts tests/merge.test.ts` 與 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/merge-real-git.test.ts tests/merge.test.ts src/main/merge.ts
git commit -m "test: cover worktree merge against real git"
```

---

### Task 4: 關分頁時刪掉已合併的分支

**Files:**
- Modify: `src/main/worktree.ts:105-136`(`removeWorktree`)
- Test: `tests/worktree.test.ts:180-293`(`describe('removeWorktree')`)

**Interfaces:**
- Consumes:`WorktreeDeps`(既有,不改形狀)。
- Produces:`removeWorktree(deps, rootPath, path)` 的簽名與回傳值完全不變,仍是
  `Promise<{ kind: 'removed' } | { kind: 'dirty' } | { kind: 'failed'; message: string }>`。
  新行為只發生在 `worktree remove` 成功之後,失敗只 `logError`,不改回傳值,也不擋關分頁。
- 對既有測試的影響:`removeWorktree` 在 `worktree remove` 前多一次
  `['-C', path, 'symbolic-ref', '--short', 'HEAD']`。假 `run` 的預設回應是 `ok('')`,分支名因此是空字串
  並被當成「讀不到」,所以 `branch --merged` 不會被呼叫,`toHaveBeenLastCalledWith(['worktree','remove',path])`
  那幾條仍然成立。只有三條「逐一比對呼叫序列或次數」的既有測試要改,Step 3 列出改法。

- [ ] **Step 1: 寫失敗的測試**

在 `tests/worktree.test.ts` 的 `describe('removeWorktree')` 裡加三條:

```ts
  it('分支已合併時移除 worktree 後刪分支', async () => {
    const deps = fake()
    deps.run.mockImplementation(async (args) => {
      if (args[2] === 'symbolic-ref') return ok('task\n')
      if (args[0] === 'branch' && args[1] === '--merged') return ok('* main\n  task\n  other\n')
      return ok('')
    })
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.run.mock.calls).toEqual([
      [['-C', path, 'status', '--porcelain', '-uall', '--ignored'], root],
      [['-C', path, 'symbolic-ref', '--short', 'HEAD'], root],
      [['worktree', 'remove', path], root],
      [['branch', '--merged'], root],
      [['branch', '-d', 'task'], root],
    ])
    expect(deps.logError).not.toHaveBeenCalled()
  })

  it('分支未合併時不刪分支', async () => {
    const deps = fake()
    deps.run.mockImplementation(async (args) => {
      if (args[2] === 'symbolic-ref') return ok('task\n')
      if (args[0] === 'branch' && args[1] === '--merged') return ok('* main\n  other\n')
      return ok('')
    })
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.run).toHaveBeenLastCalledWith(['branch', '--merged'], root)
    expect(deps.run.mock.calls.some((call) => call[0][1] === '-d')).toBe(false)
    expect(deps.logError).not.toHaveBeenCalled()
  })

  it('branch -d 失敗只記錄,仍回 removed', async () => {
    const deps = fake()
    deps.run.mockImplementation(async (args) => {
      if (args[2] === 'symbolic-ref') return ok('task\n')
      if (args[0] === 'branch' && args[1] === '--merged') return ok('  task\n')
      if (args[0] === 'branch' && args[1] === '-d') return { ok: false, out: "error: the branch 'task' is not fully merged" }
      return ok('')
    })
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.logError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('not fully merged') }))
  })
```

同時把既有三條改成下面這樣(它們逐一比對呼叫序列或次數,多一次 `symbolic-ref` 之後會失敗):

```ts
  // 原本第 231 行起的「刪除副本失敗仍嘗試 git 移除」
  it.each([true, false])('刪除副本失敗仍嘗試 git 移除（成功：%s）', async succeeds => {
    const deps = fake()
    const error = new Error('permission denied')
    deps.run.mockImplementation(async (args) => {
      if (args[2] === 'status') return ok('?? .claude/settings.local.json\n')
      if (args[2] === 'symbolic-ref') return ok('')
      if (args[0] === 'worktree') return { ok: succeeds, out: 'contains untracked files' }
      return ok('')
    })
    deps.rm.mockRejectedValue(error)
    expect(await removeWorktree(deps, root, path)).toEqual(succeeds
      ? { kind: 'removed' }
      : { kind: 'failed', message: `無法移除 worktree ${path}，已留在原地。原因：contains untracked files` })
    expect(deps.rm).toHaveBeenCalledExactlyOnceWith(`${path}/.claude/settings.local.json`)
    expect(deps.logError).toHaveBeenNthCalledWith(1, error)
    expect(deps.run).toHaveBeenLastCalledWith(['worktree', 'remove', path], root)
  })

  // 原本第 250 行起的「乾淨才移除且不刪分支或 force」,改名並補上讀分支那一步
  it('乾淨才移除,讀不到分支名就不碰分支', async () => {
    const deps = fake()
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.run.mock.calls).toEqual([
      [['-C', path, 'status', '--porcelain', '-uall', '--ignored'], root],
      [['-C', path, 'symbolic-ref', '--short', 'HEAD'], root],
      [['worktree', 'remove', path], root],
    ])
  })

  // 原本第 281 行起的「status/remove 失敗以中文說明」
  it.each([false, true])('status/remove 失敗以中文說明路徑、留在原地與 git 原因', async clean => {
    const deps = fake()
    if (clean) deps.run.mockResolvedValueOnce(ok())
    deps.run.mockResolvedValue({ ok: false, out: 'refused' })
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'failed', message: `無法移除 worktree ${path}，已留在原地。原因：refused` })
    expect(deps.run).toHaveBeenCalledTimes(clean ? 3 : 1)
  })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/worktree.test.ts`
Expected: 新的三條 FAIL(呼叫序列裡沒有 `symbolic-ref`、`branch --merged`、`branch -d`);
改過的三條也 FAIL,因為實作還沒加那一步。

- [ ] **Step 3: 改 `removeWorktree`**

在 `src/main/worktree.ts` 的 `removeWorktree` 上方加一個輔助函式:

```ts
/**
 * 分支已經合併進主目錄目前的 HEAD 就順手刪掉(合併規格 §5)。
 * 讀不到分支名、查不到清單或刪不掉都只記錄:worktree 已經移除,關分頁不該因此失敗。
 */
async function deleteMergedBranch(deps: WorktreeDeps, rootPath: string, branch: string): Promise<void> {
  if (branch.length === 0) return
  try {
    const merged = await deps.run(['branch', '--merged'], rootPath)
    if (merged.ok === false) throw new Error(merged.out)
    const names = merged.out.split('\n').map(line => line.replace(/^[*+]?\s+/, '').trim()).filter(line => line.length > 0)
    if (names.includes(branch) === false) return
    const deleted = await deps.run(['branch', '-d', branch], rootPath)
    if (deleted.ok === false) throw new Error(deleted.out)
  } catch (error) {
    deps.logError(asError(error))
  }
}
```

然後把 `removeWorktree` 裡 `await runChecked(deps, ['worktree', 'remove', path], rootPath)` 那一行前後改成:

```ts
    // 分支名要在移除之前讀:移除之後那個目錄已經不在了。
    const head = await deps.run(['-C', path, 'symbolic-ref', '--short', 'HEAD'], rootPath)
    const branch = head.ok ? head.out.trim() : ''
    await runChecked(deps, ['worktree', 'remove', path], rootPath)
    await deleteMergedBranch(deps, rootPath, branch)
    return { kind: 'removed' }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/worktree.test.ts` 與 `npm run typecheck`
Expected: PASS(既有 `createWorktree`、`slugify` 的案例不受影響)

- [ ] **Step 5: Commit**

```bash
git add src/main/worktree.ts tests/worktree.test.ts
git commit -m "feat: delete merged branch when closing a worktree tab"
```

---

### Task 5: `worktree:merge` 的 IPC

**Files:**
- Create: `src/main/worktree-merge-ipc.ts`
- Modify: `src/main/ipc-bridge.ts:149-154`(`IpcBridge` 介面)與 `src/main/ipc-bridge.ts:952`(回傳物件)
- Modify: `src/main/index.ts`(import、建 service、註冊與解除)
- Modify: `src/shared/ipc.ts:177-183`(`YesChefApi`)
- Modify: `src/preload/bridge.ts:6,111-116`
- Modify: `tests/helpers/fake-yeschef.ts:102`
- Test: `tests/worktree-merge-ipc.test.ts`

**Interfaces:**
- Consumes:Task 1 的 `WORKTREE_MERGE_CHANNEL`、`WorktreeMergeRequestSchema`、`WorktreeMergeResponseSchema`、
  `WorktreeMergeResponse`;Task 2 的 `createMerge`、`MergeService`、`MergeResult`、`MergeStatusResult`、`AbortResult`、`MSG`。
- Produces:

```ts
// src/main/worktree-merge-ipc.ts
export const MSG_UNTRUSTED = '不接受此來源的合併請求'
export const MSG_BAD_REQUEST = '合併請求無效'
export const MSG_NO_WORKTREE = '這個分頁沒有 worktree,沒有可以合併的分支'
export interface WorktreeMergeTarget {
  readonly rootPath: string
  readonly worktreePath: string
  readonly label: string
}
export interface WorktreeMergeIpcDeps {
  readonly merge: MergeService
  readonly locate: (projectId: string, tabId: string) => WorktreeMergeTarget | undefined
  readonly conversation: (projectId: string, tabId: string) => { isBusy(): boolean; userInput(text: string): void } | undefined
  readonly isTrustedSender: (sender: unknown) => boolean
  readonly logError: (error: Error) => void
}
export function createWorktreeMergeHandler(
  deps: WorktreeMergeIpcDeps,
): (event: { sender: unknown }, raw: unknown) => Promise<WorktreeMergeResponse>
```

```ts
// src/main/ipc-bridge.ts 的 IpcBridge 多一個方法
conversationFor(projectId: string, tabId: string): { isBusy(): boolean; userInput(text: string): void } | undefined
```

```ts
// src/shared/ipc.ts 的 YesChefApi 多一個方法
worktreeMerge(payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse>
```

- Task 6 的 hook 只用 `YesChefApi['worktreeMerge']` 這個型別。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/worktree-merge-ipc.test.ts
import { describe, expect, it, vi } from 'vitest'
import {
  createWorktreeMergeHandler,
  MSG_BAD_REQUEST,
  MSG_NO_WORKTREE,
  MSG_UNTRUSTED,
  type WorktreeMergeIpcDeps,
} from '../src/main/worktree-merge-ipc.js'
import { createMerge, MSG, type MergeDeps } from '../src/main/merge.js'

const ROOT = '/repo'
const WT = '/repo/.worktrees/task'
const EXCLUDE = ':!.claude/settings.local.json'
const TRUSTED = { sender: 'trusted' }
const UNTRUSTED = { sender: 'other' }
const ok = (out = '') => ({ ok: true, out })
const no = (out: string) => ({ ok: false, out })

function base(): Record<string, { ok: boolean; out: string }> {
  return {
    [`${ROOT}|status --porcelain`]: ok(''),
    [`${ROOT}|symbolic-ref --short HEAD`]: ok('main\n'),
    [`${WT}|rev-parse -q --verify MERGE_HEAD`]: no(''),
    [`${WT}|symbolic-ref --short HEAD`]: ok('task\n'),
    [`${WT}|add -A -- . ${EXCLUDE}`]: ok(''),
    [`${WT}|status --porcelain -- . ${EXCLUDE}`]: ok(''),
    [`${WT}|rev-list --count main..task`]: ok('2\n'),
    [`${WT}|merge --no-edit main`]: ok(''),
    [`${ROOT}|merge --ff-only task`]: ok(''),
  }
}

function setup(options: {
  readonly git?: Record<string, { ok: boolean; out: string }>
  readonly located?: boolean
  readonly busy?: boolean
  readonly hasConversation?: boolean
} = {}) {
  const table = { ...base(), ...options.git }
  const calls: string[] = []
  const run = vi.fn<MergeDeps['run']>(async (args, cwd) => {
    calls.push(`${cwd}|${args.join(' ')}`)
    return table[`${cwd}|${args.join(' ')}`] ?? ok('')
  })
  const logError = vi.fn<(error: Error) => void>()
  const userInput = vi.fn<(text: string) => void>()
  const conversation = { isBusy: () => options.busy === true, userInput }
  const deps: WorktreeMergeIpcDeps = {
    merge: createMerge({ run, logError }),
    locate: (projectId, tabId) =>
      options.located === false || projectId !== 'p1' || tabId !== 't1'
        ? undefined
        : { rootPath: ROOT, worktreePath: WT, label: '加購價上限' },
    conversation: () => (options.hasConversation === false ? undefined : conversation),
    isTrustedSender: (sender) => sender === 'trusted',
    logError,
  }
  return { onEvent: createWorktreeMergeHandler(deps), calls, run, userInput, logError }
}

describe('createWorktreeMergeHandler', () => {
  it('不信任的來源回 error,不跑 git', async () => {
    const h = setup()
    await expect(h.onEvent(UNTRUSTED, { action: 'status', projectId: 'p1', tabId: 't1' }))
      .resolves.toEqual({ kind: 'error', message: MSG_UNTRUSTED })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('schema 拒絕多餘欄位與未知 action', async () => {
    const h = setup()
    await expect(h.onEvent(TRUSTED, { action: 'status', projectId: 'p1', tabId: 't1', rootPath: '/elsewhere' }))
      .resolves.toEqual({ kind: 'error', message: MSG_BAD_REQUEST })
    await expect(h.onEvent(TRUSTED, { action: 'push', projectId: 'p1', tabId: 't1' }))
      .resolves.toEqual({ kind: 'error', message: MSG_BAD_REQUEST })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('分頁沒有 worktree 回 error', async () => {
    const h = setup({ located: false })
    await expect(h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' }))
      .resolves.toEqual({ kind: 'error', message: MSG_NO_WORKTREE })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('agent 忙碌時沒有任何 git 呼叫', async () => {
    const h = setup({ busy: true })
    await expect(h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' }))
      .resolves.toEqual({ kind: 'agentBusy', message: MSG.agentBusy })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.userInput).not.toHaveBeenCalled()
  })

  it('衝突時往對話送一次 agentConflict', async () => {
    const h = setup({ git: {
      [`${WT}|merge --no-edit main`]: no('CONFLICT'),
      [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\n'),
    } })
    await expect(h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })).resolves.toEqual({
      kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'],
      message: MSG.conflict('main', 'task', ['src/a.ts']),
    })
    expect(h.userInput).toHaveBeenCalledExactlyOnceWith(MSG.agentConflict('main', ['src/a.ts']))
  })

  it('找不到對話時仍回 conflict,只是沒有人可以通知', async () => {
    const h = setup({ hasConversation: false, git: {
      [`${WT}|merge --no-edit main`]: no('CONFLICT'),
      [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\n'),
    } })
    await expect(h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' }))
      .resolves.toMatchObject({ kind: 'conflict' })
    expect(h.userInput).not.toHaveBeenCalled()
  })

  it('成功時帶 merged 的訊息;領先 0 時改用 upToDate', async () => {
    await expect(setup().onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })).resolves.toEqual({
      kind: 'merged', target: 'main', branch: 'task', commits: 2, message: MSG.merged('main', 2),
    })
    const quiet = setup({ git: { [`${WT}|rev-list --count main..task`]: ok('0\n') } })
    await expect(quiet.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })).resolves.toEqual({
      kind: 'merged', target: 'main', branch: 'task', commits: 0, message: MSG.upToDate('main'),
    })
  })

  it.each([
    ['rootDirty', { [`${ROOT}|status --porcelain`]: ok(' M src/a.ts\n') }, { kind: 'rootDirty', files: ['src/a.ts'], message: MSG.rootDirty(['src/a.ts']) }],
    ['rootDetached', { [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal') }, { kind: 'rootDetached', message: MSG.rootDetached }],
    ['conflictPending', { [`${WT}|rev-parse -q --verify MERGE_HEAD`]: ok('abc\n'), [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\n') }, { kind: 'conflictPending', files: ['src/a.ts'], message: MSG.conflictPending(['src/a.ts']) }],
    ['failed', { [`${ROOT}|merge --ff-only task`]: no('fatal: 無法 ff\n') }, { kind: 'failed', message: MSG.failed('fatal: 無法 ff') }],
  ])('%s 附上 MSG 的訊息', async (_label, git, expected) => {
    await expect(setup({ git }).onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })).resolves.toEqual(expected)
  })

  it('status 回五個欄位加一句話', async () => {
    const h = setup({ git: { [`${WT}|status --porcelain -- . ${EXCLUDE}`]: ok(' M src/a.ts\n') } })
    await expect(h.onEvent(TRUSTED, { action: 'status', projectId: 'p1', tabId: 't1' })).resolves.toEqual({
      kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: true, conflictPending: false,
      message: MSG.status('task', 'main', 2, true),
    })
  })

  it('status 在主目錄 detached 時說明原因', async () => {
    const h = setup({ git: { [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal') } })
    await expect(h.onEvent(TRUSTED, { action: 'status', projectId: 'p1', tabId: 't1' })).resolves.toEqual({
      kind: 'status', branch: 'task', target: null, ahead: 0, dirty: false, conflictPending: false,
      message: MSG.rootDetached,
    })
  })

  it('status 領先 0 且乾淨時說已是最新', async () => {
    const h = setup({ git: { [`${WT}|rev-list --count main..task`]: ok('0\n') } })
    await expect(h.onEvent(TRUSTED, { action: 'status', projectId: 'p1', tabId: 't1' }))
      .resolves.toMatchObject({ message: MSG.upToDate('main') })
  })

  it('abort 送 merge --abort', async () => {
    const h = setup()
    await expect(h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't1' })).resolves.toEqual({ kind: 'aborted' })
    expect(h.calls).toEqual([`${WT}|merge --abort`])
  })

  it('handler 自己丟例外時記錄並回 error', async () => {
    const h = setup()
    h.run.mockRejectedValue(new Error('missing git'))
    await expect(h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't1' }))
      .resolves.toEqual({ kind: 'failed', message: MSG.failed('missing git') })
    expect(h.logError).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/worktree-merge-ipc.test.ts`
Expected: FAIL,`Cannot find module '../src/main/worktree-merge-ipc.js'`

- [ ] **Step 3: 寫 handler**

```ts
// src/main/worktree-merge-ipc.ts
import { WorktreeMergeRequestSchema, type WorktreeMergeRequest, type WorktreeMergeResponse } from '../shared/worktree-merge.js'
import { MSG, type AbortResult, type MergeResult, type MergeService, type MergeStatusResult } from './merge.js'

export const MSG_UNTRUSTED = '不接受此來源的合併請求'
export const MSG_BAD_REQUEST = '合併請求無效'
export const MSG_NO_WORKTREE = '這個分頁沒有 worktree,沒有可以合併的分支'

export interface WorktreeMergeTarget {
  readonly rootPath: string
  readonly worktreePath: string
  /** 分頁標籤,只拿來組自動提交的訊息。 */
  readonly label: string
}

export interface WorktreeMergeIpcDeps {
  readonly merge: MergeService
  /** 從 projects state 查;分頁不存在或沒有 worktreePath 回 undefined。 */
  readonly locate: (projectId: string, tabId: string) => WorktreeMergeTarget | undefined
  /** 從 ipc-bridge 的對話查表拿;對話還沒開起來時回 undefined。 */
  readonly conversation: (projectId: string, tabId: string) => { isBusy(): boolean; userInput(text: string): void } | undefined
  readonly isTrustedSender: (sender: unknown) => boolean
  readonly logError: (error: Error) => void
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 合併結果轉成 renderer 看得到的形狀:只留分支名、相對路徑、commit 數與一句話。 */
function toResponse(result: MergeResult): WorktreeMergeResponse {
  switch (result.kind) {
    case 'merged':
      return {
        kind: 'merged', target: result.target, branch: result.branch, commits: result.commits,
        message: result.commits === 0 ? MSG.upToDate(result.target) : MSG.merged(result.target, result.commits),
      }
    case 'conflict':
      return {
        kind: 'conflict', target: result.target, branch: result.branch, files: [...result.files],
        message: MSG.conflict(result.target, result.branch, result.files),
      }
    case 'conflictPending':
      return { kind: 'conflictPending', files: [...result.files], message: MSG.conflictPending(result.files) }
    case 'rootDirty':
      return { kind: 'rootDirty', files: [...result.files], message: MSG.rootDirty(result.files) }
    case 'rootDetached':
      return { kind: 'rootDetached', message: MSG.rootDetached }
    case 'agentBusy':
      return { kind: 'agentBusy', message: MSG.agentBusy }
    case 'failed':
      return { kind: 'failed', message: MSG.failed(result.message) }
  }
}

function toStatusResponse(result: MergeStatusResult): WorktreeMergeResponse {
  if (result.kind === 'failed') return { kind: 'failed', message: MSG.failed(result.message) }
  const message = result.target === null
    ? MSG.rootDetached
    : result.ahead === 0 && result.dirty === false
      ? MSG.upToDate(result.target)
      : MSG.status(result.branch, result.target, result.ahead, result.dirty)
  return {
    kind: 'status', branch: result.branch, target: result.target,
    ahead: result.ahead, dirty: result.dirty, conflictPending: result.conflictPending, message,
  }
}

function toAbortResponse(result: AbortResult): WorktreeMergeResponse {
  return result.kind === 'aborted' ? { kind: 'aborted' } : { kind: 'failed', message: MSG.failed(result.message) }
}

/**
 * `worktree:merge` 的 ipcMain.handle 處理器(合併規格 §4)。
 * 來源不對直接回 error,不碰 git;路徑一律從 projects state 查,renderer 只給 id。
 */
export function createWorktreeMergeHandler(
  deps: WorktreeMergeIpcDeps,
): (event: { sender: unknown }, raw: unknown) => Promise<WorktreeMergeResponse> {
  const runMerge = async (request: WorktreeMergeRequest, found: WorktreeMergeTarget): Promise<WorktreeMergeResponse> => {
    const conversation = deps.conversation(request.projectId, request.tabId)
    const result = await deps.merge.merge({ ...found, agentBusy: () => conversation?.isBusy() ?? false })
    // 衝突留在 worktree 裡,請那個對話的 agent 解;人也可以自己在終端解。
    if (result.kind === 'conflict') conversation?.userInput(MSG.agentConflict(result.target, result.files))
    return toResponse(result)
  }

  return async (event, raw) => {
    if (deps.isTrustedSender(event.sender) === false) return { kind: 'error', message: MSG_UNTRUSTED }
    const parsed = WorktreeMergeRequestSchema.safeParse(raw)
    if (parsed.success === false) return { kind: 'error', message: MSG_BAD_REQUEST }
    const request = parsed.data
    const found = deps.locate(request.projectId, request.tabId)
    if (found === undefined) return { kind: 'error', message: MSG_NO_WORKTREE }
    try {
      if (request.action === 'status') return toStatusResponse(await deps.merge.status(found))
      if (request.action === 'abort') return toAbortResponse(await deps.merge.abort(found))
      return await runMerge(request, found)
    } catch (error) {
      const failure = asError(error)
      deps.logError(failure)
      return { kind: 'failed', message: MSG.failed(failure.message) }
    }
  }
}
```

- [ ] **Step 4: 在 `ipc-bridge.ts` 加 `conversationFor`**

`IpcBridge` 介面(第 149 行起)加一行:

```ts
export interface IpcBridge {
  startChefWorker(request: WorkerRequest): Promise<WorkerHandle>
  hasBusyWork(cwd: string): boolean
  dispose(): Promise<void>
  disposeConversation(conversationId: string): Promise<void>
  /** 合併用:依 projectId 與分頁 id 拿到那個對話的忙碌狀態與輸入口(合併規格 §4)。 */
  conversationFor(projectId: string, tabId: string): { isBusy(): boolean; userInput(text: string): void } | undefined
}
```

在 `disposeConversation` 的定義附近加實作:

```ts
  /**
   * 忙碌狀態只看已經建起來的 slot:沒有 slot 就表示這個對話還沒跑過,當然不忙。
   * 送訊息才用 slotFor 把 slot 建起來,作法與 peer registry 那組一致。
   */
  const conversationFor = (projectId: string, tabId: string): { isBusy(): boolean; userInput(text: string): void } | undefined => {
    const owner = findProject(deps.projects.state(), projectId)
    const tab = owner?.tabs.find((t) => t.id === tabId && t.contentType === 'conversation')
    if (tab === undefined) return undefined
    return {
      isBusy: () => slots.get(tabId)?.core.isBusy() ?? false,
      userInput: (text: string) => { slotFor(tabId)?.core.userInput(text) },
    }
  }
```

最後一行改成:

```ts
  return { dispose, disposeConversation, startChefWorker, hasBusyWork, conversationFor }
```

- [ ] **Step 5: 在 `index.ts` 註冊**

import 區加兩行:

```ts
import { createMerge } from './merge.js'
import { createWorktreeMergeHandler } from './worktree-merge-ipc.js'
import { WORKTREE_MERGE_CHANNEL } from '../shared/worktree-merge.js'
```

`findProject` 已經在 `./projects-state.js` 的 import 清單裡就不用動;沒有的話把它加進第 67 行那條 import。

在 `ipcMain.handle(TEST_MACHINES_CHANNEL, ...)` 那段之後加:

```ts
  // 合併走同一支 git run,與 worktree 建立、移除共用輸出上限與錯誤分類。
  const mergeService = createMerge({ run: worktree.run, logError })
  ipcMain.handle(WORKTREE_MERGE_CHANNEL, createWorktreeMergeHandler({
    merge: mergeService,
    locate: (projectId, tabId) => {
      const project = findProject(service.state(), projectId)
      const tab = project?.tabs.find((entry) => entry.id === tabId)
      if (project === undefined || tab?.worktreePath === undefined) return undefined
      return { rootPath: project.rootPath, worktreePath: tab.worktreePath, label: tab.customLabel ?? tab.label }
    },
    conversation: (projectId, tabId) => bridge.conversationFor(projectId, tabId),
    isTrustedSender: (sender) => sender === conversationView.webContents,
    logError,
  }))
```

在同一個 `win.once('closed', ...)` 裡加一行:

```ts
    ipcMain.removeHandler(WORKTREE_MERGE_CHANNEL)
```

- [ ] **Step 6: 加 renderer 那一端**

`src/shared/ipc.ts` 頂部加 import,`YesChefApi` 在 `manageTestMachines` 下面加一行:

```ts
import type { WorktreeMergeRequest, WorktreeMergeResponse } from './worktree-merge.js'
```

```ts
  manageTestMachines(payload: TestMachinesRequest): Promise<TestMachinesResponse>
  /** worktree 分支合回主目錄目前的分支(合併規格 §4)。 */
  worktreeMerge(payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse>
```

`src/preload/bridge.ts` 加 import,並在 `manageTestMachines` 後面加一個成員:

```ts
import { WORKTREE_MERGE_CHANNEL, WorktreeMergeRequestSchema, WorktreeMergeResponseSchema } from '../shared/worktree-merge.js'
```

```ts
  worktreeMerge: (payload) => {
    return invokeParsed(WORKTREE_MERGE_CHANNEL, WorktreeMergeRequestSchema.parse(payload), (raw) => {
      const result = WorktreeMergeResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '合併回傳格式不正確')
  },
```

`tests/helpers/fake-yeschef.ts` 在 `manageTestMachines` 那行下面加:

```ts
    worktreeMerge: async () => ({ kind: 'error', message: '測試未設定合併' }),
```

`tests/preload-bridge.test.ts` 加一條:

```ts
it('worktreeMerge:請求先過 schema,回應過 schema,壞的回應 reject', async () => {
  const api = await loadBridge()
  replies.set('worktree:merge', { kind: 'aborted' })
  await expect(api.worktreeMerge({ action: 'abort', projectId: 'p', tabId: 't' })).resolves.toEqual({ kind: 'aborted' })
  expect(invoked.at(-1)).toEqual({ channel: 'worktree:merge', payload: { action: 'abort', projectId: 'p', tabId: 't' } })
  replies.set('worktree:merge', { kind: 'merged', target: 'main', branch: 'task', commits: 1, message: 'x', worktreePath: '/repo/.worktrees/task' })
  await expect(api.worktreeMerge({ action: 'merge', projectId: 'p', tabId: 't' })).rejects.toThrow('合併回傳格式不正確')
  replies.delete('worktree:merge')
})
```

- [ ] **Step 7: 跑測試確認通過**

Run: `npx vitest run tests/worktree-merge-ipc.test.ts tests/preload-bridge.test.ts tests/ipc-bridge.test.ts` 與 `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/worktree-merge-ipc.ts src/main/ipc-bridge.ts src/main/index.ts \
  src/shared/ipc.ts src/preload/bridge.ts tests/worktree-merge-ipc.test.ts \
  tests/preload-bridge.test.ts tests/helpers/fake-yeschef.ts
git commit -m "feat: expose worktree merge over ipc"
```

---

### Task 6: `useWorktreeMerge` 與 `WorktreeMergeBar`

**Files:**
- Create: `src/renderer/hooks/useWorktreeMerge.ts`
- Create: `src/renderer/components/WorktreeMergeBar.tsx`
- Create: `src/renderer/components/WorktreeMergeBar.css`
- Test: `tests/worktree-merge-bar.test.tsx`

**Interfaces:**
- Consumes:Task 1 的 `WorktreeMergeResponse`、`WorktreeMergeStatusResponse`;Task 5 的 `YesChefApi['worktreeMerge']`。
- Produces:

```ts
// src/renderer/hooks/useWorktreeMerge.ts
export type WorktreeMergeOutcome = Exclude<WorktreeMergeResponse, { kind: 'status' }>
export interface WorktreeMergeView {
  readonly status: WorktreeMergeStatusResponse | undefined
  readonly outcome: WorktreeMergeOutcome | undefined
  readonly busy: boolean
  readonly merge: () => void
  readonly abort: () => void
}
export function useWorktreeMerge(
  worktreeMerge: YesChefApi['worktreeMerge'], projectId: string, tabId: string,
): WorktreeMergeView
```

```tsx
// src/renderer/components/WorktreeMergeBar.tsx
export interface WorktreeMergeBarProps {
  readonly merge: YesChefApi['worktreeMerge']
  readonly projectId: string
  readonly tabId: string
}
export function WorktreeMergeBar(props: WorktreeMergeBarProps): React.ReactElement
```

- Task 7 只用 `WorktreeMergeBar` 這一個元件與這三個 prop。
- 文案分工:git 結果那幾句都從回應的 `message` 來(主行程的 `MSG` 組好),元件裡只留三段固定的介面文字(`合併`、`合併中…`、`放棄合併`、載入中與衝突提示),跟其他 renderer 元件一致。

- [ ] **Step 1: 寫失敗的測試**

```tsx
// tests/worktree-merge-bar.test.tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { WorktreeMergeBar } from '../src/renderer/components/WorktreeMergeBar.js'
import type { WorktreeMergeRequest, WorktreeMergeResponse } from '../src/shared/worktree-merge.js'

afterEach(cleanup)

const STATUS_AHEAD: WorktreeMergeResponse = {
  kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: false, conflictPending: false,
  message: '分支 task → main,領先 2 個 commit',
}
const STATUS_CLEAN: WorktreeMergeResponse = {
  kind: 'status', branch: 'task', target: 'main', ahead: 0, dirty: false, conflictPending: false,
  message: '已是最新,沒有要合併的 commit',
}
const STATUS_DETACHED: WorktreeMergeResponse = {
  kind: 'status', branch: 'task', target: null, ahead: 0, dirty: false, conflictPending: false,
  message: '主目錄不在任何分支上(detached HEAD),先切回分支',
}

function mount(replies: readonly WorktreeMergeResponse[]) {
  const requests: WorktreeMergeRequest[] = []
  let index = 0
  const merge = vi.fn(async (payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse> => {
    requests.push(payload)
    const reply = replies[index] ?? replies.at(-1) ?? STATUS_AHEAD
    index += 1
    return reply
  })
  render(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t1" />)
  return { requests }
}

const button = (name: string) => screen.getByRole('button', { name })

it('平常態顯示分支與領先數,合併按鈕可按', async () => {
  const m = mount([STATUS_AHEAD])
  await screen.findByText(/領先 2 個 commit/)
  expect(button('合併')).not.toBeDisabled()
  expect(screen.queryByRole('button', { name: '放棄合併' })).toBeNull()
  expect(m.requests).toEqual([{ action: 'status', projectId: 'p1', tabId: 't1' }])
})

it('已是最新時合併按鈕停用', async () => {
  mount([STATUS_CLEAN])
  await screen.findByText(/已是最新/)
  expect(button('合併')).toBeDisabled()
})

it('主目錄 detached 時說明原因並停用', async () => {
  mount([STATUS_DETACHED])
  await screen.findByText(/detached HEAD/)
  expect(button('合併')).toBeDisabled()
})

it('合併成功後顯示結果並重查 status', async () => {
  const m = mount([
    STATUS_AHEAD,
    { kind: 'merged', target: 'main', branch: 'task', commits: 2, message: '已合併到 main(2 個 commit)' },
    STATUS_CLEAN,
  ])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(/已合併到 main/)
  expect(m.requests).toEqual([
    { action: 'status', projectId: 'p1', tabId: 't1' },
    { action: 'merge', projectId: 'p1', tabId: 't1' },
    { action: 'status', projectId: 'p1', tabId: 't1' },
  ])
  expect(button('合併')).toBeDisabled()
})

it('衝突時整列標記,列出檔案,兩顆按鈕都在', async () => {
  mount([
    STATUS_AHEAD,
    { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts', 'src/b.ts'], message: '主分支 main 合進 task 時有衝突:src/a.ts、src/b.ts。已請 agent 處理' },
    STATUS_AHEAD,
  ])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(/已請 agent 處理/)
  expect(screen.getByText('src/a.ts')).toBeTruthy()
  expect(screen.getByText('src/b.ts')).toBeTruthy()
  expect(document.querySelector('.worktree-merge-bar.is-conflict')).not.toBeNull()
  expect(button('合併')).not.toBeDisabled()
  expect(button('放棄合併')).not.toBeDisabled()
})

it('放棄合併之後重查 status,回到平常態', async () => {
  const m = mount([
    STATUS_AHEAD,
    { kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'], message: '有衝突' },
    STATUS_AHEAD,
    { kind: 'aborted' },
    STATUS_AHEAD,
  ])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByRole('button', { name: '放棄合併' })
  await act(async () => { button('放棄合併').click() })
  await screen.findByText(/領先 2 個 commit/)
  expect(screen.queryByRole('button', { name: '放棄合併' })).toBeNull()
  expect(m.requests.map((r) => r.action)).toEqual(['status', 'merge', 'status', 'abort', 'status'])
})

it.each([
  ['rootDirty', { kind: 'rootDirty', files: ['src/a.ts'], message: '主目錄有未提交的改動,先處理再合併:src/a.ts' }, /先處理再合併/],
  ['agentBusy', { kind: 'agentBusy', message: 'agent 還在工作,等這個回合結束再合併' }, /等這個回合結束/],
  ['failed', { kind: 'failed', message: '合併失敗:fatal' }, /合併失敗/],
] as const)('被拒時同一列顯示原因,合併仍可按(%s)', async (_label, refusal, pattern) => {
  mount([STATUS_AHEAD, refusal as WorktreeMergeResponse, STATUS_AHEAD])
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(pattern)
  expect(button('合併')).not.toBeDisabled()
})

it('invoke 丟例外時顯示錯誤,不讓畫面卡在合併中', async () => {
  const merge = vi.fn(async (payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse> => {
    if (payload.action === 'status') return STATUS_AHEAD
    throw new Error('合併回傳格式不正確')
  })
  render(<WorktreeMergeBar merge={merge} projectId="p1" tabId="t1" />)
  await screen.findByText(/領先 2 個 commit/)
  await act(async () => { button('合併').click() })
  await screen.findByText(/合併回傳格式不正確/)
  expect(button('合併')).not.toBeDisabled()
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/worktree-merge-bar.test.tsx`
Expected: FAIL,`Cannot find module '../src/renderer/components/WorktreeMergeBar.js'`

- [ ] **Step 3: 寫 hook**

```ts
// src/renderer/hooks/useWorktreeMerge.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { WorktreeMergeResponse, WorktreeMergeStatusResponse } from '../../shared/worktree-merge.js'

export type WorktreeMergeOutcome = Exclude<WorktreeMergeResponse, { kind: 'status' }>

export interface WorktreeMergeView {
  readonly status: WorktreeMergeStatusResponse | undefined
  /** 最近一次 merge 或 abort 的結果;`aborted` 不留,放棄之後回到平常態。 */
  readonly outcome: WorktreeMergeOutcome | undefined
  readonly busy: boolean
  readonly merge: () => void
  readonly abort: () => void
}

const FAILED = '合併請求失敗'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : FAILED
}

/** 開面板時查一次,合併與放棄之後各查一次,不輪詢(合併規格 §3.3)。 */
export function useWorktreeMerge(
  worktreeMerge: YesChefApi['worktreeMerge'], projectId: string, tabId: string,
): WorktreeMergeView {
  const [status, setStatus] = useState<WorktreeMergeStatusResponse>()
  const [outcome, setOutcome] = useState<WorktreeMergeOutcome>()
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await worktreeMerge({ action: 'status', projectId, tabId })
      if (!alive.current) return
      if (response.kind === 'status') setStatus(response)
      else setOutcome(response)
    } catch (error) {
      if (alive.current) setOutcome({ kind: 'error', message: messageOf(error) })
    }
  }, [worktreeMerge, projectId, tabId])

  useEffect(() => { void refresh() }, [refresh])

  const send = useCallback(async (action: 'merge' | 'abort'): Promise<void> => {
    setBusy(true)
    try {
      const response = await worktreeMerge({ action, projectId, tabId })
      if (!alive.current) return
      setOutcome(response.kind === 'status' || response.kind === 'aborted' ? undefined : response)
      await refresh()
    } catch (error) {
      if (alive.current) setOutcome({ kind: 'error', message: messageOf(error) })
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [worktreeMerge, projectId, tabId, refresh])

  const merge = useCallback((): void => { void send('merge') }, [send])
  const abort = useCallback((): void => { void send('abort') }, [send])
  return { status, outcome, busy, merge, abort }
}
```

- [ ] **Step 4: 寫元件與樣式**

```tsx
// src/renderer/components/WorktreeMergeBar.tsx
import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import { useWorktreeMerge, type WorktreeMergeOutcome } from '../hooks/useWorktreeMerge.js'
import './WorktreeMergeBar.css'

export interface WorktreeMergeBarProps {
  readonly merge: YesChefApi['worktreeMerge']
  readonly projectId: string
  readonly tabId: string
}

const LABEL = {
  region: 'worktree 合併',
  loading: '正在讀取分支狀態…',
  merging: '合併中',
  merge: '合併',
  abort: '放棄合併',
  hint: '解完衝突並提交之後,再按一次合併。',
} as const

function outcomeMessage(outcome: WorktreeMergeOutcome | undefined): string | undefined {
  if (outcome === undefined || outcome.kind === 'aborted') return undefined
  return outcome.message
}

function outcomeFiles(outcome: WorktreeMergeOutcome | undefined): readonly string[] {
  return outcome !== undefined && 'files' in outcome ? outcome.files : []
}

/**
 * 「查看 diff」面板最上方的合併列(合併規格 §7)。
 * 六種狀態共用同一列:平常、進行中、衝突、成功、被拒、detached。
 */
export function WorktreeMergeBar({ merge, projectId, tabId }: WorktreeMergeBarProps): React.ReactElement {
  const view = useWorktreeMerge(merge, projectId, tabId)
  const conflicted = view.outcome?.kind === 'conflict' || view.outcome?.kind === 'conflictPending'
  const settled = view.status !== undefined && view.status.target !== null
    && view.status.ahead === 0 && view.status.dirty === false
  const disabled = view.busy || view.status === undefined || view.status.target === null || (settled && !conflicted)
  const files = outcomeFiles(view.outcome)
  const text = view.busy ? LABEL.merging : outcomeMessage(view.outcome) ?? view.status?.message ?? LABEL.loading
  return (
    <section className={`worktree-merge-bar${conflicted ? ' is-conflict' : ''}`} aria-label={LABEL.region}>
      <p className="worktree-merge-text" role="status">{text}</p>
      {files.length > 0 && (
        <ul className="worktree-merge-files">{files.map((file) => <li key={file}>{file}</li>)}</ul>
      )}
      {conflicted && <p className="worktree-merge-hint">{LABEL.hint}</p>}
      <div className="worktree-merge-actions">
        <button type="button" className="primary" disabled={disabled} onClick={view.merge}>{LABEL.merge}</button>
        {conflicted && <button type="button" disabled={view.busy} onClick={view.abort}>{LABEL.abort}</button>}
      </div>
    </section>
  )
}
```

```css
/* src/renderer/components/WorktreeMergeBar.css */
.worktree-merge-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 12px; margin-bottom: 12px; border: 1px solid var(--separator); border-radius: var(--radius-m); background: var(--bg-raised); }
.worktree-merge-text { margin: 0; flex: 1; min-width: 160px; font-size: var(--text-s); color: var(--label); overflow-wrap: anywhere; }
.worktree-merge-hint { width: 100%; margin: 0; font-size: var(--text-xs); color: var(--label-2); }
.worktree-merge-files { width: 100%; margin: 0; padding-left: 20px; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--label-2); overflow-wrap: anywhere; }
.worktree-merge-actions { display: flex; gap: 8px; }
.worktree-merge-bar.is-conflict { border-color: var(--warning); background: color-mix(in srgb, var(--warning) 12%, transparent); }
.worktree-merge-bar.is-conflict .worktree-merge-text { color: var(--warning); }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/worktree-merge-bar.test.tsx tests/theme-rules.test.ts` 與 `npm run typecheck`
Expected: PASS(`theme-rules` 會檢查沒有 hex、沒有 `!important`、`border-radius` 與 `font-size` 只用尺度、具名色彩只能出現在 `color-mix(` 裡)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/hooks/useWorktreeMerge.ts src/renderer/components/WorktreeMergeBar.tsx \
  src/renderer/components/WorktreeMergeBar.css tests/worktree-merge-bar.test.tsx
git commit -m "feat: add worktree merge bar"
```

---

### Task 7: 把合併列掛進「查看 diff」面板

**Files:**
- Modify: `src/renderer/components/DevelopmentDiff.tsx:1-5,43-44`
- Modify: `src/renderer/components/PanelGroup.tsx:20-35,42-48,77`
- Modify: `src/renderer/App.tsx:209-212`
- Test: `tests/development-diff-view.test.tsx`

**Interfaces:**
- Consumes:Task 6 的 `WorktreeMergeBar({ merge, projectId, tabId })`;`src/shared/projects.ts` 的 `ProjectView`
  (它的 `tabs: readonly TabEntry[]` 帶得到 `worktreePath`,renderer 不用再問主行程)。
- Produces:

```tsx
// src/renderer/components/DevelopmentDiff.tsx
export function DevelopmentDiff({ api, conversationId, worktree }: {
  api: Pick<YesChefApi, 'conversationTools'> & Partial<Pick<YesChefApi, 'worktreeMerge'>>
  conversationId: string
  worktree?: { readonly projectId: string }
}): React.ReactElement
```

```tsx
// src/renderer/components/PanelGroup.tsx 的 PanelGroupProps 兩處變動
readonly api: Pick<YesChefApi, 'setBrowserBounds' | 'readPreview' | 'conversationTools'>
  & Partial<Pick<YesChefApi, 'worktreeMerge'>>
/** 用來查出 diff 分頁那個對話有沒有 worktree;沒給就不顯示合併列。 */
readonly projects?: readonly ProjectView[]
```

- 兩個新東西都是選用的:`tests/panel-group.test.tsx` 與 `tests/fixtures/conversation-tools.tsx` 現在的呼叫因此不用改。
- `conversationId` 就是 `TabEntry.id`(見 `src/main/ipc-bridge.ts` 第 171 行的註解),所以合併列的 `tabId` 直接用 `conversationId`,不另外傳。

- [ ] **Step 1: 寫失敗的測試**

在 `tests/development-diff-view.test.tsx` 末尾加兩條:

```tsx
it('分頁有 worktree 時面板最上方出現合併列', async () => {
  const worktreeMerge = vi.fn(async () => ({
    kind: 'status' as const, branch: 'task', target: 'main', ahead: 1, dirty: false, conflictPending: false,
    message: '分支 task → main,領先 1 個 commit',
  }))
  render(<DevelopmentDiff conversationId="t1" worktree={{ projectId: 'p1' }} api={{
    conversationTools: async () => ({ kind: 'repositories', repositories: [], warnings: [] }),
    worktreeMerge,
  }} />)
  await screen.findByText(/領先 1 個 commit/)
  expect(worktreeMerge).toHaveBeenCalledWith({ action: 'status', projectId: 'p1', tabId: 't1' })
  const bar = screen.getByLabelText('worktree 合併')
  const panel = screen.getByLabelText('開發變更 diff')
  expect(panel.firstElementChild).toBe(bar)
})

it('分頁沒有 worktree 時不顯示合併列', async () => {
  render(<DevelopmentDiff conversationId="t1" api={{
    conversationTools: async () => ({ kind: 'repositories', repositories: [], warnings: [] }),
  }} />)
  await screen.findByText(/尚無本次對話可驗證的 repo 修改紀錄/)
  expect(screen.queryByLabelText('worktree 合併')).toBeNull()
})
```

第 2 行的 import 要多一個 `vi`:

```ts
import { afterEach, expect, it, vi } from 'vitest'
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/development-diff-view.test.tsx`
Expected: FAIL,`worktree` 這個 prop 不存在(typecheck)且找不到 `worktree 合併` 這個 region

- [ ] **Step 3: 改 `DevelopmentDiff`**

第 1 到 5 行改成:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { DiffResult, DiffRepositories } from '../../shared/conversation-tools.js'
import { WorktreeMergeBar } from './WorktreeMergeBar.js'
import './DevelopmentDiff.css'
export function DevelopmentDiff({ api, conversationId, worktree }: {
  api: Pick<YesChefApi, 'conversationTools'> & Partial<Pick<YesChefApi, 'worktreeMerge'>>
  conversationId: string
  /** 這個對話開在自己的 worktree 時才給;`conversationId` 同時就是分頁 id。 */
  worktree?: { readonly projectId: string }
}) {
```

第 43 到 44 行(`<section>` 開頭)改成:

```tsx
  return <section className="development-diff" aria-label="開發變更 diff">
    {worktree !== undefined && api.worktreeMerge !== undefined
      && <WorktreeMergeBar merge={api.worktreeMerge} projectId={worktree.projectId} tabId={conversationId} />}
    <header><h2>開發變更</h2>
```

- [ ] **Step 4: 改 `PanelGroup` 與 `App`**

`PanelGroup.tsx` 的 import 加一行:

```tsx
import type { ProjectView } from '../../shared/projects.js'
```

`PanelGroupProps` 的 `api` 那行與新的 `projects` 那行:

```tsx
  readonly api: Pick<YesChefApi, 'setBrowserBounds' | 'readPreview' | 'conversationTools'>
    & Partial<Pick<YesChefApi, 'worktreeMerge'>>
  /** 用來查出 diff 分頁那個對話有沒有 worktree;沒給就不顯示合併列。 */
  readonly projects?: readonly ProjectView[]
```

解構加 `projects = []`:

```tsx
export function PanelGroup({ ref, api, collapsed, dragging, previews, activeId, onActivate, onClose, browser, projects = [] }: PanelGroupProps): React.ReactElement {
```

`const activePreview = ...` 下面加一行:

```tsx
  // 對話分頁 id 就是 conversationId,所以直接拿它去 projects 裡找 worktree 歸屬。
  // 先把 source 取出來再查,narrowing 才穿得過下面那個 closure。
  const diffSource = activePreview?.source.kind === 'diff' ? activePreview.source : undefined
  const diffOwner = diffSource === undefined
    ? undefined
    : projects.find((project) => project.tabs.some((tab) => tab.id === diffSource.conversationId && tab.worktreePath !== undefined))
```

第 77 行的 `<DevelopmentDiff …>` 改成:

```tsx
        {activePreview === undefined ? null : activePreview.source.kind === 'diff' ? <DevelopmentDiff key={`${activePreview.id}:${activePreview.revision}`} api={api} conversationId={activePreview.source.conversationId} {...(diffOwner === undefined ? {} : { worktree: { projectId: diffOwner.id } })} /> : <PreviewPane key={`${activePreview.id}:${String(activePreview.revision)}`} api={api} source={activePreview.source} />}
```

`App.tsx` 第 209 行起的 `<PanelGroup …>` 加一個 prop:

```tsx
            <PanelGroup ref={panelGroup} dragging={dragging || skillsOpen || permissionsOpen || chefOpen || testMachinesOpen} api={api} collapsed={panelHidden}
              previews={previewTabs.tabs.previews} activeId={previewTabs.tabs.activeId}
              projects={projects.view.projects}
              onActivate={previewTabs.activate} onClose={previewTabs.close}
              browser={{ conversationId: foregroundId, state: browser.stateOf(foregroundId), lastUrl: foregroundLastUrl, run: browser.run }} />
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/development-diff-view.test.tsx tests/panel-group.test.tsx tests/app.test.tsx` 與 `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/DevelopmentDiff.tsx src/renderer/components/PanelGroup.tsx \
  src/renderer/App.tsx tests/development-diff-view.test.tsx
git commit -m "feat: show merge bar in the development diff panel"
```

---

### Task 8: 驗收文件骨架與 tab-worktree 規格更正

**Files:**
- Create: `docs/RESULTS-38-worktree-merge.md`
- Modify: `docs/specs/2026-09-15-tab-worktree-design.md:76,82,93`

**Interfaces:**
- Consumes:前七個 task 的測試檔名(填 §1 的表)與 `tests/merge-real-git.test.ts` 的輸出(填 §2)。
- Produces:沒有程式介面。這個 task 的產出是一份骨架,六項實機驗收一律先寫「未驗收」,由人實機跑完再填。

- [ ] **Step 1: 寫 `docs/RESULTS-38-worktree-merge.md`**

```markdown
<!-- docs/RESULTS-38-worktree-merge.md -->
# RESULTS-38:在介面裡把 worktree 分支合回主分支

- 日期:2026-09-23
- 規格:`docs/specs/2026-09-23-worktree-merge-design.md`
- 計畫:`docs/superpowers/plans/2026-09-23-worktree-merge.md`
- `git` 版本:(填實際跑的版本,`git --version`)

## 1. 單元測試

| 檔案 | 測試數 | 結果 |
|---|---|---|
| `tests/worktree-merge-schema.test.ts` | (填) | (填) |
| `tests/merge.test.ts` | (填) | (填) |
| `tests/worktree-merge-ipc.test.ts` | (填) | (填) |
| `tests/worktree.test.ts` | (填) | (填) |
| `tests/worktree-merge-bar.test.tsx` | (填) | (填) |
| `tests/development-diff-view.test.tsx` | (填) | (填) |
| `tests/preload-bridge.test.ts` | (填) | (填) |
| `npm test` 全套 | (填) | (填) |

`npm run typecheck` 的結果:(填)

## 2. 真 git 整合測試

`npx vitest run tests/merge-real-git.test.ts` 的輸出:

```
(貼完整輸出)
```

六條各驗什麼:

| 案例 | 驗到的事 |
|---|---|
| worktree 提交後合併成功 | 主目錄 `git log` 有 worktree 的 commit,檔案內容換成 worktree 的版本 |
| 未提交改動先自動提交 | 自動提交訊息進了歷史,`.claude/settings.local.json` 沒有被追蹤 |
| 兩邊改同一個檔 | 第一次 `conflict`、主目錄沒有 MERGE_HEAD、再按一次 `conflictPending`、解完之後 `merged` |
| 衝突中途放棄 | `merge --abort` 後 worktree 回到解衝突前,`status` 的 `conflictPending` 為 false |
| 主目錄有未提交改動 | `rootDirty`,主目錄的 log 沒有多出東西 |
| 主目錄 detached | `rootDetached`,`status` 的 `target` 為 null |

## 3. 實機驗收(規格 §9)

| # | 步驟 | 預期 | 結果 |
|---|---|---|---|
| 1 | 開帶 worktree 的對話,要 agent 改一個檔並提交,按合併 | 主目錄 `git log` 有那個 commit | 未驗收 |
| 2 | 主目錄手動改同一個檔並提交,再按合併;agent 解完提交後再按一次 | 第一次出現衝突列且對話收到 `agentConflict`,第二次合併成功 | 未驗收 |
| 3 | worktree 有未提交改動時按合併 | 先看到自動提交的 commit,再合併成功 | 未驗收 |
| 4 | 主目錄有未提交改動時按合併 | 被拒並列出檔案 | 未驗收 |
| 5 | agent 回合中按合併 | 被拒 | 未驗收 |
| 6 | 合併後關分頁;另一個未合併的分頁也關掉 | 已合併的 worktree 移除且分支被刪,未合併的分支仍在 | 未驗收 |

## 4. 已知限制

- 只合 worktree 所在的主 repo,巢狀 repo 不處理(規格 §10)。
- 不 push、不開 PR、不 rebase、沒有衝突編輯器。
- 合併對象固定是主目錄目前所在的分支。主目錄自己是別的 worktree 時,目標就是它當下的分支。
- `status` 不輪詢:開面板查一次,合併與放棄之後各查一次。在別的地方(終端)改了 git 狀態,要按合併或重開面板才會反映。
- 對話還沒開起來時,衝突那句話送不到 agent(沒有對話核心),衝突列仍會列出檔案,人可以自己在終端解。
```

- [ ] **Step 2: 更正 `docs/specs/2026-09-15-tab-worktree-design.md`**

第 76 行:

```markdown
- 乾淨:直接移除 worktree,未合併的分支留著(分支很便宜,砍掉反而可能砍掉有用的 commit);
  已經合併進主目錄目前分支的則順便 `git branch -d`(合併規格 §5)。
```

第 82 行:

```markdown
- 不做「把 worktree 的改動合回主分支」的按鈕。(已由 `docs/specs/2026-09-23-worktree-merge-design.md` 取消,
  現在「查看 diff」面板最上方有合併列。)
```

第 93 行那一列:

```markdown
| 4 | 關掉乾淨的那個對話 | worktree 被移除,未合併的分支還在;已合併的分支被刪掉 |
```

- [ ] **Step 3: 確認沒有把測試弄壞**

Run: `npm test` 與 `npm run typecheck`
Expected: 全綠。文件改動不影響測試,但這是最後一個 task,要跑一次全套。

- [ ] **Step 4: Commit**

```bash
git add docs/RESULTS-38-worktree-merge.md docs/specs/2026-09-15-tab-worktree-design.md
git commit -m "docs: add worktree merge results skeleton"
```

---

## Self-Review

**1. 規格覆蓋**

| 規格章節 | 對應 task |
|---|---|
| §2 已決定的事 | Task 2(合併對象、兩段式、衝突、自動提交、拒絕條件)、Task 4(關分頁刪分支) |
| §3 `merge.ts` 的型別 | Task 2 |
| §3.1 merge 的順序 | Task 2 Step 3 的 `precheck` / `autoCommit` / `joinTarget` / `merge`。第 9 點的 `commits` 在第一段之後算,規格 §3.1 已同步成同樣的順序,理由在 Task 2 的 Interfaces 第 3 點 |
| §3.2 衝突之後 | Task 5(`userInput` 送 `agentConflict`)、Task 2(`conflictPending`、`abort`) |
| §3.3 status | Task 2 的 `status`、Task 6 的 hook(不輪詢) |
| §4 IPC | Task 1(schema)、Task 5(handler、`locate`、`conversation`) |
| §5 資料與關分頁 | Task 4 |
| §6 訊息 | Task 2 的 `MSG`,Task 5 把它組進回應的 `message` |
| §7 UI | Task 6(六種狀態)、Task 7(掛進 `DevelopmentDiff`) |
| §8 測試 | Task 2、3、4、5、6、7 的測試檔 |
| §9 實機驗收 | Task 8 |
| §10 範圍外 | Task 8 的「已知限制」 |

沒有找到沒人負責的章節。

**2. Placeholder 掃描**

- 沒有「類似 Task N」:Task 3 與 Task 5 的假 `run` 表格各自寫完整,沒有叫人回頭抄 Task 2。
- 沒有「補上錯誤處理」:每個 catch 分支都寫出實際回傳值。
- 沒有裸的「寫測試」:每一條測試都有可貼的程式碼。
- `docs/RESULTS-38-worktree-merge.md` 裡的「(填)」是刻意的:那是要人實機跑完才會有的數字,不是計畫的缺口。

**3. 型別一致**

- `MergeService` 在 Task 2 定義,Task 3、Task 5 都用同一個名字。
- `WorktreeMergeResponse` 在 Task 1 定義,Task 5 回它、Task 6 收它。
- `MSG` 的每個鍵在 Task 2 定義,Task 5 只用 `rootDirty`、`rootDetached`、`agentBusy`、`conflict`、`conflictPending`、`failed`、`merged`、`upToDate`、`agentConflict`,Task 2 的測試用 `autoCommit`、`status`、`upToDate`、`agentConflict`、`worktreeDetached`,都在表裡。
- `conversationFor(projectId, tabId)` 在 Task 5 定義並在同一個 task 的 `index.ts` 接線,沒有第二個名字。
- `WorktreeMergeBar` 的三個 prop(`merge`、`projectId`、`tabId`)在 Task 6 定義,Task 7 照樣傳。
- `useWorktreeMerge(worktreeMerge, projectId, tabId)` 的參數順序,Task 6 的元件與測試一致。
- `commits` 的型別與語意沒變(`number`,進入主分支的 commit 數),只有計算時機變了,所以 Task 1 的 schema、Task 5 的 `toResponse`、Task 6 的畫面都不受影響。
