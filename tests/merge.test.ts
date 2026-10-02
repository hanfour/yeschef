import { describe, expect, it, vi } from 'vitest'
import { createMerge, MSG, type MergeDeps } from '../src/main/merge.js'

const ROOT = '/repo'
const WT = '/repo/.worktrees/task'
const EXCLUDE = ':!.claude/settings.local.json'
const ok = (out = '') => ({ ok: true, out })
const no = (out: string) => ({ ok: false, out })

type Reply = { ok: boolean; out: string }
/** 同一個指令前後兩次要回不同結果時(例如 MERGE_HEAD 在第一段之後才出現)給一組序列,用完停在最後一筆。 */
type Replies = Reply | readonly Reply[]

/** 一路順利合併時的九次 git 呼叫;每個案例只改它要改的那一筆。 */
function base(): Record<string, Replies> {
  return {
    [`${ROOT}|-c core.quotePath=false status --porcelain`]: ok(''),
    [`${ROOT}|symbolic-ref --short HEAD`]: ok('main\n'),
    [`${WT}|rev-parse -q --verify MERGE_HEAD`]: no(''),
    [`${WT}|symbolic-ref --short HEAD`]: ok('task\n'),
    [`${WT}|add -A -- . ${EXCLUDE}`]: ok(''),
    [`${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`]: ok(''),
    [`${WT}|rev-list --count main..task`]: ok('2\n'),
    [`${WT}|merge --no-edit main`]: ok(''),
    [`${ROOT}|merge --ff-only task`]: ok(''),
    [`${WT}|diff --name-only --diff-filter=U`]: ok(''),
    [`${WT}|commit -m ${MSG.autoCommit('加購價上限')}`]: ok(''),
    [`${WT}|merge --abort`]: ok(''),
  }
}

function fake(overrides: Record<string, Replies> = {}) {
  const table = { ...base(), ...overrides }
  const calls: string[] = []
  const seen = new Map<string, number>()
  const run = vi.fn<MergeDeps['run']>(async (args, cwd) => {
    const key = `${cwd}|${args.join(' ')}`
    calls.push(key)
    const replies = table[key]
    // 假的 run 對沒列進表裡的指令直接失敗:漏掉一筆時是這裡出聲,不是靜悄悄回成功。
    if (replies === undefined) throw new Error(`測試沒有替這個 git 指令準備回應:${key}`)
    if (Array.isArray(replies) === false) return replies as Reply
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    return replies[Math.min(index, replies.length - 1)] as Reply
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
    const f = fake({ [`${ROOT}|-c core.quotePath=false status --porcelain`]: ok(' M src/a.ts\n?? src/b.ts\n') })
    expect(await f.service.merge(args())).toEqual({ kind: 'rootDirty', files: ['src/a.ts', 'src/b.ts'] })
    expect(f.calls).toEqual([`${ROOT}|-c core.quotePath=false status --porcelain`])
  })

  it('quotePath 關閉,中文檔名不被顯示成八進位跳脫', async () => {
    const f = fake({ [`${ROOT}|-c core.quotePath=false status --porcelain`]: ok(' M 中文檔.ts\n') })
    expect(await f.service.merge(args())).toEqual({ kind: 'rootDirty', files: ['中文檔.ts'] })
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
    const f = fake({
      [`${WT}|symbolic-ref --short HEAD`]: ok('feature/別的名字\n'),
      [`${WT}|rev-list --count main..feature/別的名字`]: ok('1\n'),
      [`${ROOT}|merge --ff-only feature/別的名字`]: ok(''),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'merged', target: 'main', branch: 'feature/別的名字', commits: 1 })
    expect(f.calls).toContain(`${ROOT}|merge --ff-only feature/別的名字`)
  })

  it('worktree 也 detached 時回 failed', async () => {
    const f = fake({ [`${WT}|symbolic-ref --short HEAD`]: no('fatal: ref HEAD is not a symbolic ref') })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: MSG.worktreeDetached })
  })

  it('worktree 的 symbolic-ref 失敗而不是 detached 時,訊息是 git 的原話,不是「切回分支」', async () => {
    const f = fake({ [`${WT}|symbolic-ref --short HEAD`]: no('fatal: not a git repository') })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'fatal: not a git repository' })
  })

  it('主目錄的 symbolic-ref 失敗而不是 detached 時回 failed,不誤判成 rootDetached', async () => {
    const f = fake({ [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal: not a git repository') })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'fatal: not a git repository' })
  })

  it('主目錄 status 失敗時回 failed 的第一行', async () => {
    const f = fake({ [`${ROOT}|-c core.quotePath=false status --porcelain`]: no('fatal: Unable to create index.lock\n細節\n') })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'fatal: Unable to create index.lock' })
    expect(f.calls).toEqual([`${ROOT}|-c core.quotePath=false status --porcelain`])
  })
})

describe('merge 的自動提交', () => {
  it('有改動就 add 並 commit,排除本機設定檔', async () => {
    const f = fake({ [`${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`]: ok('A  src/a.ts\n') })
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
      [`${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`]: ok('A  src/a.ts\n'),
      [`${WT}|commit -m ${MSG.autoCommit('加購價上限')}`]: no('fatal: 無法提交\n第二行\n'),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: 'fatal: 無法提交' })
  })

  it('worktree 讀狀態失敗且非 detached 時回 MSG.statusFailed,不誤判 detached', async () => {
    const f = fake({ [`${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`]: no('fatal: Unable to create index.lock') })
    expect(await f.service.merge(args())).toEqual({ kind: 'failed', message: MSG.statusFailed('fatal: Unable to create index.lock') })
  })
})

describe('merge 的兩段', () => {
  it('第一段衝突時回 conflict,不做第二段', async () => {
    const f = fake({
      // 前置檢查時還沒有 MERGE_HEAD,第一段失敗之後才有。
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: [no(''), ok('abc123\n')],
      [`${WT}|merge --no-edit main`]: no('CONFLICT (content): Merge conflict in src/a.ts'),
      [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\n'),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'conflict', target: 'main', branch: 'task', files: ['src/a.ts'] })
    expect(f.calls).not.toContain(`${ROOT}|merge --ff-only task`)
  })

  it('第一段失敗後 MERGE_HEAD 在,但查不到衝突檔案時仍回 conflict,files 為空', async () => {
    const f = fake({
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: [no(''), ok('abc123\n')],
      [`${WT}|merge --no-edit main`]: no('CONFLICT (modify/delete): src/a.ts'),
      [`${WT}|diff --name-only --diff-filter=U`]: no('fatal: 讀不到索引'),
    })
    expect(await f.service.merge(args())).toEqual({ kind: 'conflict', target: 'main', branch: 'task', files: [] })
    expect(f.calls).not.toContain(`${ROOT}|merge --ff-only task`)
  })

  it('第一段失敗且沒有 MERGE_HEAD 時回 failed', async () => {
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

  it('ff 失敗的訊息挑 fatal 那行,不挑 hint', async () => {
    const stderr = [
      "hint: Diverging branches can't be fast-forwarded, you need to either:",
      'hint: ',
      'hint:   git merge --no-ff',
      'fatal: Not possible to fast-forward, aborting.',
    ].join('\n')
    const f = fake({ [`${ROOT}|merge --ff-only task`]: no(stderr) })
    const result = await f.service.merge(args())
    expect(result).toEqual({ kind: 'failed', message: 'fatal: Not possible to fast-forward, aborting.' })
    expect(MSG.failed('fatal: Not possible to fast-forward, aborting.'))
      .toBe('合併失敗:fatal: Not possible to fast-forward, aborting.')
  })

  it('rev-list 失敗時 merged 不帶 commit 數', async () => {
    const f = fake({ [`${WT}|rev-list --count main..task`]: no('fatal: bad revision') })
    expect(await f.service.merge(args())).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: undefined })
  })

  it('commits 在第一段成功之後才算,順序固定', async () => {
    const f = fake()
    expect(await f.service.merge(args())).toEqual({ kind: 'merged', target: 'main', branch: 'task', commits: 2 })
    expect(f.calls).toEqual([
      `${ROOT}|-c core.quotePath=false status --porcelain`,
      `${ROOT}|symbolic-ref --short HEAD`,
      `${WT}|rev-parse -q --verify MERGE_HEAD`,
      `${WT}|symbolic-ref --short HEAD`,
      `${WT}|add -A -- . ${EXCLUDE}`,
      `${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`,
      `${WT}|merge --no-edit main`,
      `${WT}|rev-list --count main..task`,
      `${ROOT}|merge --ff-only task`,
    ])
  })

  it('第一段失敗時不算 commits', async () => {
    const f = fake({
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: [no(''), ok('abc123\n')],
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
      [`${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`]: ok(' M src/a.ts\n'),
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: ok('abc\n'),
    })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT })).toEqual({
      kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: true, conflictPending: true,
    })
  })

  it('讀狀態失敗且非 detached 時回 MSG.statusFailed', async () => {
    const f = fake({ [`${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`]: no('fatal: Unable to create index.lock') })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT })).toEqual({ kind: 'failed', message: MSG.statusFailed('fatal: Unable to create index.lock') })
  })

  it('主目錄 detached 時 target 為 null,ahead 為 0,不查 rev-list', async () => {
    const f = fake({ [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal: ref HEAD is not a symbolic ref') })
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
    const f = fake({ [`${WT}|symbolic-ref --short HEAD`]: no('fatal: ref HEAD is not a symbolic ref') })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT })).toEqual({ kind: 'failed', message: MSG.worktreeDetached })
  })

  it('worktree 的 symbolic-ref 失敗而不是 detached 時,訊息是 git 的原話', async () => {
    const f = fake({ [`${WT}|symbolic-ref --short HEAD`]: no('fatal: not a git repository') })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT }))
      .toEqual({ kind: 'failed', message: 'fatal: not a git repository' })
  })

  it('主目錄的 symbolic-ref 失敗而不是 detached 時回 failed,不當成 detached', async () => {
    const f = fake({ [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal: not a git repository') })
    expect(await f.service.status({ rootPath: ROOT, worktreePath: WT }))
      .toEqual({ kind: 'failed', message: 'fatal: not a git repository' })
  })
})

describe('abort', () => {
  it('送 merge --abort 到 worktree', async () => {
    const f = fake()
    expect(await f.service.abort({ worktreePath: WT, agentBusy: () => false })).toEqual({ kind: 'aborted' })
    expect(f.calls).toEqual([`${WT}|merge --abort`])
  })

  it('失敗回 failed 的第一行', async () => {
    const f = fake({ [`${WT}|merge --abort`]: no('fatal: 沒有進行中的合併\n第二行\n') })
    expect(await f.service.abort({ worktreePath: WT, agentBusy: () => false })).toEqual({ kind: 'failed', message: 'fatal: 沒有進行中的合併' })
  })

  it('agent 忙碌時不跑任何 git,直接回 agentBusy', async () => {
    const f = fake()
    expect(await f.service.abort({ worktreePath: WT, agentBusy: () => true })).toEqual({ kind: 'agentBusy' })
    expect(f.run).not.toHaveBeenCalled()
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

  it('worktree detached 訊息採規格 §6 逐字', () => {
    expect(MSG.worktreeDetached).toBe('worktree 不在任何分支上(detached HEAD),先切回分支')
  })

  it('conflictPending 清單為空時不留懸空冒號', () => {
    expect(MSG.conflictPending([])).toBe('上一次的衝突還沒解完')
    expect(MSG.conflictPending(['src/a.ts'])).toBe('上一次的衝突還沒解完:src/a.ts')
  })

  it('conflict 清單為空時也不留懸空冒號', () => {
    expect(MSG.conflict('main', 'task', [])).toBe('主分支 main 合進 task 時有衝突。已請 agent 處理')
    expect(MSG.conflict('main', 'task', ['src/a.ts'])).toBe('主分支 main 合進 task 時有衝突:src/a.ts。已請 agent 處理')
  })

  it('算不出 commit 數時只說合併到哪裡', () => {
    expect(MSG.mergedNoCount('main')).toBe('已合併到 main')
  })

  it('合併進行中關分頁的那句', () => {
    expect(MSG.closeWhileMerging).toBe('合併進行中,請稍後再關閉分頁')
  })
})
