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
  // 開發機自己的 hooks(pre-commit、commit-msg)不該跑進這個測試:那會讓結果跟著個人設定跑。
  await git(root, 'config', 'core.hooksPath', '/dev/null')
  // 不讀使用者自己的全域 .gitignore(例如可能排除 .claude/settings.local.json),
  // 否則這個測試的結果會被開發機的個人設定影響。
  await git(root, 'config', 'core.excludesfile', '/dev/null')
  await writeFile(join(root, 'file.txt'), 'base\n')
  // 正式流程建立 worktree 前會把 .worktrees 加進 .gitignore(見 worktree.ts 的 ensureIgnored),
  // 否則主目錄的 status --porcelain 會把這個內部目錄當成未追蹤檔案,誤判 rootDirty。
  await writeFile(join(root, '.gitignore'), '.worktrees\n')
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
  // 主目錄不能被第一段影響:HEAD 還在自己的 commit 上,沒有 MERGE_HEAD,工作目錄也乾淨。
  expect(await r.git(r.root, 'log', '-1', '--pretty=%s')).toContain('主目錄的修改')
  await expect(exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: r.root })).rejects.toThrow()
  expect(await r.git(r.root, 'status', '--porcelain')).toBe('')

  // 衝突態不必等下一次合併才看得到:status 直接說 conflictPending。
  expect(await r.service.status({ rootPath: r.root, worktreePath: r.worktreePath }))
    .toMatchObject({ kind: 'status', conflictPending: true })

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
  expect(await r.service.abort({ worktreePath: r.worktreePath, agentBusy: () => false })).toEqual({ kind: 'aborted' })
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

it('兩段之間主目錄被動過:第二段 ff 失敗,訊息是 fatal 那行,主目錄仍然乾淨', async () => {
  const r = await rig()
  await writeFile(join(r.worktreePath, 'file.txt'), 'from worktree\n')
  await r.git(r.worktreePath, 'commit', '-am', 'worktree 的修改')
  const real = createGitRun(execFile)
  const logError = vi.fn<(error: Error) => void>()
  // 第二段開跑前主目錄多一個 commit,ff 就不可能成立。
  const service = createMerge({
    run: async (args, cwd) => {
      if (args[0] === 'merge' && args[1] === '--ff-only') await r.git(r.root, 'commit', '--allow-empty', '-m', '插隊的提交')
      return real(args, cwd)
    },
    logError,
  })
  const result = await service.merge(r.args)
  expect(result).toMatchObject({ kind: 'failed' })
  const message = result.kind === 'failed' ? result.message : ''
  // git 把 hint: 排在 fatal: 前面,訊息要挑說明原因的那行。
  expect(message.startsWith('fatal:')).toBe(true)
  expect(message).toContain('fast-forward')
  expect(await r.git(r.root, 'status', '--porcelain')).toBe('')
  await expect(exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: r.root })).rejects.toThrow()
})

it('主目錄 detached 時拒絕', async () => {
  const r = await rig()
  await r.git(r.root, 'checkout', '--detach')
  expect(await r.service.merge(r.args)).toEqual({ kind: 'rootDetached' })
  expect(await r.service.status({ rootPath: r.root, worktreePath: r.worktreePath }))
    .toMatchObject({ target: null, ahead: 0 })
})
