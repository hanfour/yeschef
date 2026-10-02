import { basename, join } from 'node:path'

export interface WorktreeDeps {
  run(args: readonly string[], cwd: string): Promise<{ readonly ok: boolean; readonly out: string }>
  readFile(path: string): Promise<string | undefined>
  writeFile(path: string, text: string): Promise<void>
  mkdir(path: string): Promise<void>
  /** 複製時以獨占建立保護目的地，不覆蓋既有檔案。 */
  copyFile(source: string, destination: string): Promise<void>
  rm(path: string): Promise<void>
  logError(e: Error): void
}

type DirName = '.worktrees' | 'worktrees'
type Failed = { kind: 'failed'; message: string }

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function runChecked(deps: WorktreeDeps, args: readonly string[], rootPath: string): Promise<string> {
  const result = await deps.run(args, rootPath)
  if (result.ok === false) throw new Error(result.out)
  return result.out
}

export function slugify(input: string, taken: readonly string[], tabId: string): string {
  const cleaned = Array.from(input).slice(0, 32).join('')
    .replace(/\s/g, '-').replace(/[^A-Za-z0-9一-鿿_-]/g, '').replace(/^-+|-+$/g, '')
  const base = cleaned || `tab-${tabId.slice(0, 8)}`
  // 耗盡時停止，避免覆蓋已有分支或無限制重試。
  const candidates = [base, ...Array.from({ length: 98 }, (_, index) => `${base}-${index + 2}`)]
  const available = candidates.find(candidate => taken.includes(candidate) === false)
  if (available === undefined) throw new Error('worktree 名稱已用完 (最多試到 -99)')
  return available
}

export async function isGitRepo(deps: WorktreeDeps, rootPath: string): Promise<boolean> {
  try {
    return (await deps.run(['rev-parse', '--git-dir'], rootPath)).ok
  } catch (error) {
    deps.logError(asError(error))
    return false
  }
}

export async function worktreeDirName(deps: WorktreeDeps, rootPath: string): Promise<DirName> {
  // git -C 會先切換目錄，藉此辨識空目錄而不依賴未注入的檔案系統。
  const hidden = await deps.run(['-C', join(rootPath, '.worktrees'), 'rev-parse', '--git-dir'], rootPath)
  const visible = await deps.run(['-C', join(rootPath, 'worktrees'), 'rev-parse', '--git-dir'], rootPath)
  return hidden.ok === false && visible.ok ? 'worktrees' : '.worktrees'
}

export async function ensureIgnored(deps: WorktreeDeps, rootPath: string, dirName: DirName): Promise<void> {
  const path = join(rootPath, '.gitignore')
  const text = await deps.readFile(path) ?? ''
  const ignored = text.split('\n').some(line => line.trim() === dirName)
  if (ignored) return
  const separator = text.length > 0 && text.endsWith('\n') === false ? '\n' : ''
  await deps.writeFile(path, `${text}${separator}${dirName}\n`)
}

export async function existingSlugs(deps: WorktreeDeps, rootPath: string): Promise<readonly string[]> {
  const worktrees = await runChecked(deps, ['worktree', 'list', '--porcelain'], rootPath)
  const branches = await runChecked(deps, ['branch', '--format=%(refname:short)'], rootPath)
  return [
    ...worktrees.split('\n').filter(line => line.startsWith('worktree ')).map(line => basename(line.slice(9))),
    ...branches.split('\n').map(line => line.trim()).filter(line => line.length > 0),
  ]
}

async function copyLocalSettings(deps: WorktreeDeps, rootPath: string, path: string): Promise<void> {
  try {
    const source = join(rootPath, '.claude', 'settings.local.json')
    const destination = join(path, '.claude', 'settings.local.json')
    if (await deps.readFile(source) === undefined) return
    if (await deps.readFile(destination) !== undefined) return
    await deps.mkdir(join(path, '.claude'))
    await deps.copyFile(source, destination)
  } catch (error) {
    // 設定複製失敗不影響已建立的 worktree，保留錯誤供使用者查閱。
    deps.logError(asError(error))
  }
}

export async function createWorktree(
  deps: WorktreeDeps, rootPath: string, wanted: string, tabId: string,
): Promise<{ kind: 'ok'; path: string; slug: string } | Failed> {
  try {
    const taken = await existingSlugs(deps, rootPath)
    const slug = slugify(wanted, taken, tabId)
    const dirName = await worktreeDirName(deps, rootPath)
    await ensureIgnored(deps, rootPath, dirName)
    const path = join(rootPath, dirName, slug)
    await runChecked(deps, ['worktree', 'add', path, '-b', slug], rootPath)
    await copyLocalSettings(deps, rootPath, path)
    return { kind: 'ok', path, slug }
  } catch (error) {
    const failure = asError(error)
    deps.logError(failure)
    return { kind: 'failed', message: failure.message }
  }
}

/**
 * 分支已經合併進主目錄目前的 HEAD 就順手刪掉(合併規格 §5)。
 * 讀不到分支名、查不到清單或刪不掉都只記錄:worktree 已經移除,關分頁不該因此失敗。
 */
async function deleteMergedBranch(
  deps: WorktreeDeps, rootPath: string, head: { readonly ok: boolean; readonly out: string },
): Promise<void> {
  if (head.ok === false) {
    // detached 的 worktree 本來就沒有分支可刪,那是正常情況;其他原因才值得記一筆。
    if (head.out.includes('not a symbolic ref') === false) deps.logError(new Error(head.out))
    return
  }
  const branch = head.out.trim()
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

export async function removeWorktree(
  deps: WorktreeDeps, rootPath: string, path: string,
): Promise<{ kind: 'removed' } | { kind: 'dirty' } | Failed> {
  try {
    const status = await runChecked(deps, ['-C', path, 'status', '--porcelain', '-uall', '--ignored'], rootPath)
    const entries = status.split('\n').filter(line => line.length > 0)
    const isLocalCopy = (line: string): boolean =>
      (line.startsWith('?? ') || line.startsWith('!! '))
      && line.slice(3) === '.claude/settings.local.json'
    if (entries.some(line => isLocalCopy(line) === false)) {
      deps.logError(new Error(`worktree 還有未提交的改動,留在 ${path},請自己處理`))
      return { kind: 'dirty' }
    }
    if (entries.some(isLocalCopy)) {
      // 整個 worktree 即將刪除，設定中的權限授權不是工作成果。
      // 重新批准的成本遠低於 worktree 永遠卡住，因此不比對內容。
      // 留下未追蹤的副本會讓 git 拒絕移除，只刪設定檔，保留 .claude 目錄。
      try {
        await deps.rm(join(path, '.claude', 'settings.local.json'))
      } catch (error) {
        // 刪除失敗只記錄，仍由後續 git 移除決定結果。
        deps.logError(asError(error))
      }
    }
    // 分支名要在移除之前讀:移除之後那個目錄已經不在了。讀不讀得到都要等移除成功才處理，
    // 失敗只記錄不擋關分頁。
    const head = await deps.run(['-C', path, 'symbolic-ref', '--short', 'HEAD'], rootPath)
    await runChecked(deps, ['worktree', 'remove', path], rootPath)
    await deleteMergedBranch(deps, rootPath, head)
    return { kind: 'removed' }
  } catch (error) {
    const failure = asError(error)
    deps.logError(failure)
    return { kind: 'failed', message: `無法移除 worktree ${path}，已留在原地。原因：${failure.message}` }
  }
}
