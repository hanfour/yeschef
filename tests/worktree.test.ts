import { describe, expect, it, vi } from 'vitest'
import { createWorktree, ensureIgnored, existingSlugs, isGitRepo, removeWorktree, slugify, worktreeDirName, type WorktreeDeps } from '../src/main/worktree'

const root = '/repo with spaces'
const tabId = '12345678-abcd'
const ok = (out = '') => ({ ok: true, out })
function fake() {
  return {
    run: vi.fn<WorktreeDeps['run']>().mockResolvedValue(ok()),
    readFile: vi.fn<WorktreeDeps['readFile']>().mockResolvedValue(undefined),
    writeFile: vi.fn<WorktreeDeps['writeFile']>().mockResolvedValue(undefined),
    mkdir: vi.fn<WorktreeDeps['mkdir']>().mockResolvedValue(undefined),
    copyFile: vi.fn<WorktreeDeps['copyFile']>().mockResolvedValue(undefined),
    rm: vi.fn<WorktreeDeps['rm']>().mockResolvedValue(undefined),
    logError: vi.fn<WorktreeDeps['logError']>(),
  }
}

describe('slugify', () => {
  it.each([
    [' 加購 Price @上限! ', '加購-Price-上限'],
    ['@#$! ---', 'tab-12345678'],
    ['a'.repeat(40), 'a'.repeat(32)],
    ['😀' + 'a'.repeat(32), 'a'.repeat(31)],
    [' '.repeat(32) + 'tail', 'tab-12345678'],
    ['_A一鿿-é', '_A一鿿'],
  ])('%s → %s', (input, expected) => expect(slugify(input, [], tabId)).toBe(expected))
  it('避開分支與目錄名稱且不修改輸入', () => {
    const taken = Object.freeze(['task', 'task-2'])
    expect(slugify('task', taken, tabId)).toBe('task-3')
    expect(taken).toEqual(['task', 'task-2'])
  })
  it('退回名稱也檢查重複', () => {
    expect(slugify('', ['tab-12345678'], tabId)).toBe('tab-12345678-2')
  })
  it('最多試到 99，耗盡後失敗', () => {
    const taken = ['task', ...Array.from({ length: 97 }, (_, i) => `task-${i + 2}`)]
    expect(slugify('task', taken, tabId)).toBe('task-99')
    expect(() => slugify('task', [...taken, 'task-99'], tabId)).toThrow()
  })
})

describe('git 與忽略規則', () => {
  it('以 git-dir 檢查 repository', async () => {
    const deps = fake()
    expect(await isGitRepo(deps, root)).toBe(true)
    expect(deps.run).toHaveBeenCalledWith(['rev-parse', '--git-dir'], root)
    deps.run.mockResolvedValue({ ok: false, out: 'not a repo' })
    expect(await isGitRepo(deps, root)).toBe(false)
    deps.run.mockRejectedValue(new Error('missing git'))
    expect(await isGitRepo(deps, root)).toBe(false)
    expect(deps.logError).toHaveBeenCalled()
  })
  it.each([
    [undefined, '.worktrees\n'],
    ['', '.worktrees\n'],
    ['node_modules', 'node_modules\n.worktrees\n'],
    ['node_modules\n', 'node_modules\n.worktrees\n'],
    ['# .worktrees\n', '# .worktrees\n.worktrees\n'],
    ['.worktrees/\n', '.worktrees/\n.worktrees\n'],
    ['  .worktrees/ \r\n', '  .worktrees/ \r\n.worktrees\n'],
  ])('追加精確且無斜線的忽略行', async (before, after) => {
    const deps = fake()
    deps.readFile.mockResolvedValue(before)
    await ensureIgnored(deps, root, '.worktrees')
    expect(deps.readFile).toHaveBeenCalledWith(`${root}/.gitignore`)
    expect(deps.writeFile).toHaveBeenCalledWith(`${root}/.gitignore`, after)
  })
  it.each(['.worktrees', 'other\n.worktrees\n'])('已有 %s 不重寫', async before => {
    const deps = fake()
    deps.readFile.mockResolvedValue(before)
    await ensureIgnored(deps, root, '.worktrees')
    expect(deps.writeFile).not.toHaveBeenCalled()
  })
  it('沿用 worktrees 的忽略名稱', async () => {
    const deps = fake()
    await ensureIgnored(deps, root, 'worktrees')
    expect(deps.writeFile).toHaveBeenCalledWith(`${root}/.gitignore`, 'worktrees\n')
  })
  it('合併目錄 basename 與分支名稱', async () => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok(`worktree ${root}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${root}/.worktrees/中文 task\nHEAD def\ndetached\n`)).mockResolvedValueOnce(ok('main\nfeature/task\n'))
    expect(await existingSlugs(deps, root)).toEqual(['repo with spaces', '中文 task', 'main', 'feature/task'])
    expect(deps.run.mock.calls).toEqual([
      [['worktree', 'list', '--porcelain'], root],
      [['branch', '--format=%(refname:short)'], root],
    ])
  })
})

describe('worktreeDirName', () => {
  it.each([
    [false, false, '.worktrees'],
    [true, false, '.worktrees'],
    [false, true, 'worktrees'],
    [true, true, '.worktrees'],
  ])('hidden=%s visible=%s → %s', async (hidden, visible, expected) => {
    const deps = fake()
    deps.run.mockResolvedValueOnce({ ok: hidden, out: '' }).mockResolvedValueOnce({ ok: visible, out: '' })
    expect(await worktreeDirName(deps, root)).toBe(expected)
    expect(deps.run.mock.calls).toEqual([
      [['-C', `${root}/.worktrees`, 'rev-parse', '--git-dir'], root],
      [['-C', `${root}/worktrees`, 'rev-parse', '--git-dir'], root],
    ])
  })
})

describe('createWorktree', () => {
  const source = `${root}/.claude/settings.local.json`
  const destination = `${root}/.worktrees/task/.claude/settings.local.json`
  it.each(['來源有', '來源沒有', '目的地已存在', '複製丟例外'])('%s 時保留建立結果並正確處理本機設定', async scenario => {
    const deps = fake()
    deps.readFile.mockImplementation(async path => {
      if (path === source && scenario !== '來源沒有') return '{"permissions":{"allow":["Read"]}}'
      if (path === destination && scenario === '目的地已存在') return '{}'
      return undefined
    })
    const failure = new Error('無法複製設定')
    if (scenario === '複製丟例外') deps.copyFile.mockRejectedValue(failure)
    expect(await createWorktree(deps, root, 'task', tabId)).toEqual({ kind: 'ok', path: `${root}/.worktrees/task`, slug: 'task' })
    expect(deps.readFile).toHaveBeenCalledWith(source)
    if (scenario === '來源沒有' || scenario === '目的地已存在') {
      expect(deps.mkdir).not.toHaveBeenCalled()
      expect(deps.copyFile).not.toHaveBeenCalled()
    } else {
      expect(deps.mkdir).toHaveBeenCalledWith(`${root}/.worktrees/task/.claude`)
      expect(deps.copyFile).toHaveBeenCalledWith(source, destination)
      expect(deps.run.mock.invocationCallOrder.at(-1)).toBeLessThan(deps.mkdir.mock.invocationCallOrder[0] ?? 0)
      expect(deps.mkdir.mock.invocationCallOrder[0]).toBeLessThan(deps.copyFile.mock.invocationCallOrder[0] ?? 0)
    }
    expect(deps.logError.mock.calls).toEqual(scenario === '複製丟例外' ? [[failure]] : [])
  })

  it('先查重、忽略再從 HEAD 建立', async () => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok('task\n'))
    expect(await createWorktree(deps, root, 'task', tabId)).toEqual({ kind: 'ok', path: `${root}/.worktrees/task-2`, slug: 'task-2' })
    expect(deps.run).toHaveBeenLastCalledWith(['worktree', 'add', `${root}/.worktrees/task-2`, '-b', 'task-2'], root)
    expect(deps.writeFile.mock.invocationCallOrder[0]).toBeLessThan(deps.run.mock.invocationCallOrder.at(-1) ?? 0)
  })
  it('沿用實體 worktrees 目錄建立', async () => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok())
      .mockResolvedValueOnce({ ok: false, out: 'directory missing' }).mockResolvedValueOnce(ok())
    expect(await createWorktree(deps, root, 'task', tabId)).toEqual({ kind: 'ok', path: `${root}/worktrees/task`, slug: 'task' })
    expect(deps.writeFile).toHaveBeenCalledWith(`${root}/.gitignore`, 'worktrees\n')
  })
  it('目錄探測拋出例外時不建立', async () => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error('probe failure'))
    expect(await createWorktree(deps, root, 'task', tabId)).toEqual({ kind: 'failed', message: 'probe failure' })
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(deps.run).toHaveBeenCalledTimes(3)
  })
  it.each([0, 1, 2])('git 第 %i 步失敗保留輸出並停止', async step => {
    const deps = fake()
    deps.run.mockImplementation(async args => {
      const operation = args[0] === 'branch' ? 1 : args[1] === 'add' ? 2 : 0
      return operation === step ? { ok: false, out: 'git failure\n' } : ok()
    })
    expect(await createWorktree(deps, root, 'task', tabId)).toEqual({ kind: 'failed', message: 'git failure\n' })
  })
  it.each(['read', 'write', 'run'])('%s 拋出例外回 failed', async operation => {
    const deps = fake()
    if (operation === 'read') deps.readFile.mockRejectedValue(new Error('failure'))
    if (operation === 'write') deps.writeFile.mockRejectedValue(new Error('failure'))
    if (operation === 'run') deps.run.mockRejectedValue('failure')
    expect(await createWorktree(deps, root, 'task', tabId)).toEqual({ kind: 'failed', message: 'failure' })
    expect(deps.logError).toHaveBeenCalledWith(expect.any(Error))
  })
  it('名稱耗盡不寫檔也不建立', async () => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(['task', ...Array.from({ length: 98 }, (_, i) => `task-${i + 2}`)].join('\n')))
    expect(await createWorktree(deps, root, 'task', tabId)).toMatchObject({ kind: 'failed' })
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(deps.run).toHaveBeenCalledTimes(2)
  })
})

describe('removeWorktree', () => {
  const path = `${root}/.worktrees/task`
  it('設定副本必須刪除完成後才交給 git 移除', async () => {
    const deps = fake()
    const destination = `${path}/.claude/settings.local.json`
    deps.run.mockResolvedValueOnce(ok('?? .claude/settings.local.json\n'))
    let finishDeletion: (() => void) | undefined
    const deletion = new Promise<void>(resolve => { finishDeletion = resolve })
    deps.rm.mockReturnValue(deletion)
    const removal = removeWorktree(deps, root, path)
    await vi.waitFor(() => expect(deps.rm).toHaveBeenCalledExactlyOnceWith(destination))
    expect(deps.run).toHaveBeenCalledTimes(1)
    finishDeletion?.()
    expect(await removal).toEqual({ kind: 'removed' })
    expect(deps.run).toHaveBeenLastCalledWith(['worktree', 'remove', path], root)
    expect(deps.logError).not.toHaveBeenCalled()
  })
  it.each([
    ['?? ', '{}', '{}'],
    ['!! ', '{}', '{}'],
    ['?? ', '{}', '{"changed":true}'],
    ['!! ', '{}', '{"changed":true}'],
    ['!! ', undefined, '{}'],
    ['?? ', '{}', undefined],
  ])('%s 設定副本一律刪除且不讀檔比對（來源：%s，副本：%s）', async (prefix, source, destination) => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok(`${prefix}.claude/settings.local.json\n`))
    deps.readFile.mockImplementation(async file => file === `${root}/.claude/settings.local.json` ? source : destination)
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.rm).toHaveBeenCalledExactlyOnceWith(`${path}/.claude/settings.local.json`)
    expect(deps.run).toHaveBeenLastCalledWith(['worktree', 'remove', path], root)
  })
  it.each([
    '?? .claude/settings.local.json\n!! .env\n',
    '!! .claude/settings.local.json\n?? .env\n',
    '!! .env\n?? .claude/settings.local.json\n',
  ])('設定副本與其他檔案並存時不刪除任何檔案：%s', async out => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok(out))
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'dirty' })
    expect(deps.rm).not.toHaveBeenCalled()
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.run).toHaveBeenCalledTimes(1)
  })
  it('沒有設定檔時直接移除，不呼叫 rm', async () => {
    const deps = fake()
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.rm).not.toHaveBeenCalled()
    expect(deps.run).toHaveBeenLastCalledWith(['worktree', 'remove', path], root)
  })
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
  it.each([' M tracked\n', '?? untracked\n'])('有改動保留 worktree', async out => {
    const deps = fake()
    deps.run.mockResolvedValue(ok(out))
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'dirty' })
    expect(deps.run.mock.calls).toEqual([[['-C', path, 'status', '--porcelain', '-uall', '--ignored'], root]])
  })
  it('乾淨才移除,讀不到分支名就不碰分支', async () => {
    const deps = fake()
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.run.mock.calls).toEqual([
      [['-C', path, 'status', '--porcelain', '-uall', '--ignored'], root],
      [['-C', path, 'symbolic-ref', '--short', 'HEAD'], root],
      [['worktree', 'remove', path], root],
    ])
  })
  it.each([
    ['乾淨', '', 'removed'],
    ['其他被忽略的檔案', '!! .env\n', 'dirty'],
    ['未追蹤的檔案', '?? notes.txt\n', 'dirty'],
    ['已修改的檔案', ' M tracked\n', 'dirty'],
    ['設定所在目錄被忽略', '!! .claude/\n', 'dirty'],
    ['已追蹤的設定有改動', ' M .claude/settings.local.json\n', 'dirty'],
    ['引號包住的其他路徑', '?? ".claude/other settings.json"\n', 'dirty'],
  ])('%s 時正確保留或移除並記錄路徑', async (_label, out, kind) => {
    const deps = fake()
    deps.run.mockResolvedValueOnce(ok(out))
    expect(await removeWorktree(deps, root, path)).toEqual({ kind })
    expect(deps.run).toHaveBeenNthCalledWith(1, ['-C', path, 'status', '--porcelain', '-uall', '--ignored'], root)
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.rm).not.toHaveBeenCalled()
    if (kind === 'dirty') {
      expect(deps.run).toHaveBeenCalledTimes(1)
      expect(deps.logError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(path) }))
    } else {
      expect(deps.run).toHaveBeenLastCalledWith(['worktree', 'remove', path], root)
      expect(deps.logError).not.toHaveBeenCalled()
    }
  })
  it.each([false, true])('status/remove 失敗以中文說明路徑、留在原地與 git 原因', async clean => {
    const deps = fake()
    if (clean) deps.run.mockResolvedValueOnce(ok())
    deps.run.mockResolvedValue({ ok: false, out: 'refused' })
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'failed', message: `無法移除 worktree ${path}，已留在原地。原因：refused` })
    expect(deps.run).toHaveBeenCalledTimes(clean ? 3 : 1)
  })
  it('執行例外回 failed', async () => {
    const deps = fake()
    deps.run.mockRejectedValue(new Error('missing git'))
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'failed', message: `無法移除 worktree ${path}，已留在原地。原因：missing git` })
  })
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
  it('分支名讀不到時記錄一次再跳過,仍回 removed', async () => {
    const deps = fake()
    deps.run.mockImplementation(async (args) => {
      if (args[2] === 'symbolic-ref') return { ok: false, out: 'fatal: 索引讀不到' }
      return ok('')
    })
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.run.mock.calls.some((call) => call[0][0] === 'branch')).toBe(false)
    expect(deps.logError).toHaveBeenCalledExactlyOnceWith(new Error('fatal: 索引讀不到'))
  })
  // 審查追加:detached 的 worktree 沒有分支可刪,那是正常情況,不是錯誤。
  it('worktree 是 detached 時靜默跳過,不記錯誤', async () => {
    const deps = fake()
    deps.run.mockImplementation(async (args) => {
      if (args[2] === 'symbolic-ref') return { ok: false, out: 'fatal: ref HEAD is not a symbolic ref' }
      return ok('')
    })
    expect(await removeWorktree(deps, root, path)).toEqual({ kind: 'removed' })
    expect(deps.run.mock.calls.some((call) => call[0][0] === 'branch')).toBe(false)
    expect(deps.logError).not.toHaveBeenCalled()
  })
})


it('第 32 字元是空白且超過長度上限時不留下尾端連字號', () => {
  expect(slugify(`${'a'.repeat(31)} more`, [], 'tab-id')).toBe('a'.repeat(31))
})
