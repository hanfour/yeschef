import { describe, expect, it, vi } from 'vitest'
import { createGitRun, type GitExecFile } from '../src/main/git-run.js'

describe('createGitRun', () => {
  it('成功：傳入 git、參數副本、cwd 與 32 MiB 上限，回傳 stdout', async () => {
    const execFileFn = vi.fn<GitExecFile>((_file, _args, _options, callback) => {
      callback(null, 'main\nfeature\n', 'warning')
    })
    const args = Object.freeze(['branch', '--format=%(refname:short)'])
    expect(await createGitRun(execFileFn)(args, '/repo')).toEqual({ ok: true, out: 'main\nfeature\n' })
    expect(execFileFn).toHaveBeenCalledWith('git', args, { cwd: '/repo', maxBuffer: 32 * 1024 * 1024 }, expect.any(Function))
    expect(execFileFn.mock.calls[0]?.[1]).not.toBe(args)
  })

  it.each(['fatal: branch exists', ''])('git 非零：保留 stderr 或原始錯誤訊息（%s）', async (stderr) => {
    const execFileFn: GitExecFile = (_file, _args, _options, callback) => {
      callback(Object.assign(new Error('exit code 1'), { code: 1, cmd: 'git' }), 'partial', stderr)
    }
    expect(await createGitRun(execFileFn)([], '/repo')).toEqual({ ok: false, out: stderr || 'exit code 1' })
  })

  it.each(['', 'partial stderr'])('超出上限：明確區分輸出過大與 git 失敗（%s）', async (stderr) => {
    const execFileFn: GitExecFile = (_file, _args, _options, callback) => {
      callback(Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', cmd: 'git',
      }), 'partial', stderr)
    }
    expect(await createGitRun(execFileFn)([], '/repo')).toEqual({
      ok: false, out: 'git 輸出太大，超過 32 MiB 擷取上限；這是輸出容量限制，不代表 git 本身失敗。',
    })
  })
})
