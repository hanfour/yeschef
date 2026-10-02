import { describe, expect, it, vi } from 'vitest'
import {
  createWorktreeMergeHandler,
  MSG_BAD_REQUEST,
  MSG_NO_WORKTREE,
  MSG_UNTRUSTED,
  type WorktreeMergeIpcDeps,
} from '../src/main/worktree-merge-ipc.js'
import { createMerge, MSG, type MergeDeps } from '../src/main/merge.js'
import { createMergeLocks } from '../src/main/merge-locks.js'

const ROOT = '/repo'
const WT = '/repo/.worktrees/task'
const EXCLUDE = ':!.claude/settings.local.json'
const TRUSTED = { sender: 'trusted' }
const UNTRUSTED = { sender: 'other' }
const ok = (out = '') => ({ ok: true, out })
const no = (out: string) => ({ ok: false, out })

type Reply = { ok: boolean; out: string }
/** 同一個指令前後兩次要回不同結果時(MERGE_HEAD 在第一段之後才出現)給一組序列,用完停在最後一筆。 */
type Replies = Reply | readonly Reply[]

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
  }
}

/** 依指令查回應,序列的那幾筆依呼叫次序取,用完停在最後一筆;沒列到的指令當成空的成功。 */
function replier(table: Record<string, Replies>): (key: string) => Reply {
  const seen = new Map<string, number>()
  return (key) => {
    const replies = table[key]
    if (replies === undefined) return ok('')
    if (Array.isArray(replies) === false) return replies as Reply
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    return replies[Math.min(index, replies.length - 1)] as Reply
  }
}

function setup(options: {
  readonly git?: Record<string, Replies>
  readonly located?: boolean
  readonly busy?: boolean
  readonly hasConversation?: boolean
} = {}) {
  const calls: string[] = []
  const reply = replier({ ...base(), ...options.git })
  const run = vi.fn<MergeDeps['run']>(async (args, cwd) => {
    const key = `${cwd}|${args.join(' ')}`
    calls.push(key)
    return reply(key)
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
    locks: createMergeLocks(),
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
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: [no(''), ok('abc123\n')],
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
      [`${WT}|rev-parse -q --verify MERGE_HEAD`]: [no(''), ok('abc123\n')],
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

  // 審查追加:commit 數算不出來時不能說「已是最新」,那會讓人以為根本沒東西可合。
  it('算不出 commit 數時只說合併到哪裡,不說已是最新', async () => {
    const h = setup({ git: { [`${WT}|rev-list --count main..task`]: no('fatal: bad revision') } })
    await expect(h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })).resolves.toEqual({
      kind: 'merged', target: 'main', branch: 'task', message: MSG.mergedNoCount('main'),
    })
  })

  it.each([
    ['rootDirty', { [`${ROOT}|-c core.quotePath=false status --porcelain`]: ok(' M src/a.ts\n') }, { kind: 'rootDirty', files: ['src/a.ts'], message: MSG.rootDirty(['src/a.ts']) }],
    ['rootDetached', { [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal: ref HEAD is not a symbolic ref') }, { kind: 'rootDetached', message: MSG.rootDetached }],
    ['conflictPending', { [`${WT}|rev-parse -q --verify MERGE_HEAD`]: ok('abc\n'), [`${WT}|diff --name-only --diff-filter=U`]: ok('src/a.ts\n') }, { kind: 'conflictPending', files: ['src/a.ts'], message: MSG.conflictPending(['src/a.ts']) }],
    ['failed', { [`${ROOT}|merge --ff-only task`]: no('fatal: 無法 ff\n') }, { kind: 'failed', message: MSG.failed('fatal: 無法 ff') }],
  ])('%s 附上 MSG 的訊息', async (_label, git, expected) => {
    await expect(setup({ git }).onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })).resolves.toEqual(expected)
  })

  it('status 回五個欄位加一句話', async () => {
    const h = setup({ git: { [`${WT}|-c core.quotePath=false status --porcelain -- . ${EXCLUDE}`]: ok(' M src/a.ts\n') } })
    await expect(h.onEvent(TRUSTED, { action: 'status', projectId: 'p1', tabId: 't1' })).resolves.toEqual({
      kind: 'status', branch: 'task', target: 'main', ahead: 2, dirty: true, conflictPending: false,
      message: MSG.status('task', 'main', 2, true),
    })
  })

  it('status 在主目錄 detached 時說明原因', async () => {
    const h = setup({ git: { [`${ROOT}|symbolic-ref --short HEAD`]: no('fatal: ref HEAD is not a symbolic ref') } })
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

  it('abort 時 agent 忙就不跑任何 git,回 agentBusy', async () => {
    const h = setup({ busy: true })
    await expect(h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't1' }))
      .resolves.toEqual({ kind: 'agentBusy', message: MSG.agentBusy })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('status 與 abort(agent 不忙時)都不會呼叫對話的 userInput', async () => {
    const h = setup()
    await h.onEvent(TRUSTED, { action: 'status', projectId: 'p1', tabId: 't1' })
    await h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't1' })
    expect(h.userInput).not.toHaveBeenCalled()
  })

  it('handler 自己丟例外時記錄並回 error', async () => {
    const h = setup()
    h.run.mockRejectedValue(new Error('missing git'))
    await expect(h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't1' }))
      .resolves.toEqual({ kind: 'failed', message: MSG.failed('missing git') })
    expect(h.logError).toHaveBeenCalled()
  })

  // 審查追加:同一個分頁的 merge/abort 不能同時跑兩份,擋在第一次 git 呼叫之前。
  it('merge 進行中時第二個立刻回 inProgress,git 只跑一次;第一個結束後第三個可以再跑', async () => {
    const reply = replier(base())
    const calls: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let gated = false
    const run = vi.fn<MergeDeps['run']>(async (args, cwd) => {
      const key = `${cwd}|${args.join(' ')}`
      calls.push(key)
      if (!gated) {
        gated = true
        await gate
      }
      return reply(key)
    })
    const logError = vi.fn<(error: Error) => void>()
    const userInput = vi.fn<(text: string) => void>()
    const deps: WorktreeMergeIpcDeps = {
      merge: createMerge({ run, logError }),
      locate: (projectId, tabId) =>
        projectId === 'p1' && tabId === 't1' ? { rootPath: ROOT, worktreePath: WT, label: '加購價上限' } : undefined,
      conversation: () => ({ isBusy: () => false, userInput }),
      locks: createMergeLocks(),
      isTrustedSender: (sender) => sender === 'trusted',
      logError,
    }
    const onEvent = createWorktreeMergeHandler(deps)

    const first = onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })
    const second = await onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })
    expect(second).toEqual({ kind: 'failed', message: MSG.inProgress })
    expect(calls).toEqual([`${ROOT}|-c core.quotePath=false status --porcelain`])

    release?.()
    await expect(first).resolves.toEqual({
      kind: 'merged', target: 'main', branch: 'task', commits: 2, message: MSG.merged('main', 2),
    })

    const third = await onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })
    expect(third).toEqual({
      kind: 'merged', target: 'main', branch: 'task', commits: 2, message: MSG.merged('main', 2),
    })
  })

  /** 第一個 git 呼叫卡住不放,用來觀察鎖擋住了誰。 */
  function gated() {
    const reply = replier(base())
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let gatedOnce = false
    const run = vi.fn<MergeDeps['run']>(async (args, cwd) => {
      if (gatedOnce === false) {
        gatedOnce = true
        await gate
      }
      return reply(`${cwd}|${args.join(' ')}`)
    })
    const logError = vi.fn<(error: Error) => void>()
    const onEvent = createWorktreeMergeHandler({
      merge: createMerge({ run, logError }),
      // 兩個專案共用同一組假路徑:這幾條測的是鎖的範圍,不是路徑查表。
      locate: () => ({ rootPath: ROOT, worktreePath: WT, label: '加購價上限' }),
      conversation: () => ({ isBusy: () => false, userInput: vi.fn() }),
      locks: createMergeLocks(),
      isTrustedSender: (sender) => sender === 'trusted',
      logError,
    })
    return { onEvent, release: () => { release?.() } }
  }

  // 審查追加:merge 的第二段跑在主目錄,同一個專案的兩個分頁同時合併會互相踩到,
  // 所以鎖的範圍是專案,不是分頁。
  it('同專案另一個分頁在 merge 中時,這個分頁的 merge 回 inProgress', async () => {
    const h = gated()
    const first = h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })
    expect(await h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't2' }))
      .toEqual({ kind: 'failed', message: MSG.inProgress })
    h.release()
    await expect(first).resolves.toMatchObject({ kind: 'merged' })
  })

  it('別的專案在 merge 中不擋這個專案', async () => {
    const h = gated()
    const first = h.onEvent(TRUSTED, { action: 'merge', projectId: 'p1', tabId: 't1' })
    expect(await h.onEvent(TRUSTED, { action: 'merge', projectId: 'p2', tabId: 't2' }))
      .toMatchObject({ kind: 'merged' })
    h.release()
    await expect(first).resolves.toMatchObject({ kind: 'merged' })
  })

  // abort 只動那個 worktree,鎖到分頁就夠;同專案別的分頁還能放棄自己的合併。
  it('abort 的鎖是分頁:同分頁第二個回 inProgress,別的分頁不受影響', async () => {
    const h = gated()
    const first = h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't1' })
    expect(await h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't1' }))
      .toEqual({ kind: 'failed', message: MSG.inProgress })
    expect(await h.onEvent(TRUSTED, { action: 'abort', projectId: 'p1', tabId: 't2' }))
      .toEqual({ kind: 'aborted' })
    h.release()
    await expect(first).resolves.toEqual({ kind: 'aborted' })
  })
})
