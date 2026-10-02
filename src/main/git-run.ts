import type { ExecFileException } from 'node:child_process'
import type { WorktreeDeps } from './worktree.js'

const GIT_MAX_BUFFER_MIB = 32
const GIT_MAX_BUFFER = GIT_MAX_BUFFER_MIB * 1024 * 1024

export type GitExecFile = (
  file: string,
  args: string[],
  options: { readonly cwd: string; readonly maxBuffer: number },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void

/** 限定 git 輸出容量，並區分擷取上限與 git 本身的錯誤。 */
export function createGitRun(execFileFn: GitExecFile): WorktreeDeps['run'] {
  return (args, cwd) => new Promise((resolve) => {
    execFileFn('git', [...args], { cwd, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true, out: stdout })
        return
      }
      const out = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? `git 輸出太大，超過 ${String(GIT_MAX_BUFFER_MIB)} MiB 擷取上限；這是輸出容量限制，不代表 git 本身失敗。`
        : stderr || error.message
      resolve({ ok: false, out })
    })
  })
}
