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
  /** `commits` 算不出來時是 undefined:數字只是說明用的,算不出來不該讓合併看起來像失敗或沒事做。 */
  | { readonly kind: 'merged'; readonly target: string; readonly branch: string; readonly commits: number | undefined }
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
export type AbortResult =
  | { readonly kind: 'aborted' }
  | { readonly kind: 'agentBusy' }
  | { readonly kind: 'failed'; readonly message: string }

export interface MergeService {
  status(args: Pick<MergeArgs, 'rootPath' | 'worktreePath'>): Promise<MergeStatusResult>
  merge(args: MergeArgs): Promise<MergeResult>
  /** agent 正在解衝突時放棄合併會把它腳下的 merge 拿掉,跟 merge() 一樣先查 agentBusy,任何 git 都還沒跑。 */
  abort(args: Pick<MergeArgs, 'worktreePath' | 'agentBusy'>): Promise<AbortResult>
}

/** 建 worktree 時複製進去的本機設定不進歷史(tab-worktree 規格 §3)。 */
const EXCLUDE_LOCAL_SETTINGS = ':!.claude/settings.local.json'
const WORKTREE_SCOPE: readonly string[] = ['--', '.', EXCLUDE_LOCAL_SETTINGS]

export const MSG = {
  rootDirty: (files: readonly string[]) => `主目錄有未提交的改動,先處理再合併:${files.join('、')}`,
  rootDetached: '主目錄不在任何分支上(detached HEAD),先切回分支',
  worktreeDetached: 'worktree 不在任何分支上(detached HEAD),先切回分支',
  agentBusy: 'agent 還在工作,等這個回合結束再合併',
  inProgress: '上一次的合併還在進行中',
  closeWhileMerging: '合併進行中,請稍後再關閉分頁',
  conflict: (target: string, branch: string, files: readonly string[]) =>
    files.length > 0
      ? `主分支 ${target} 合進 ${branch} 時有衝突:${files.join('、')}。已請 agent 處理`
      : `主分支 ${target} 合進 ${branch} 時有衝突。已請 agent 處理`,
  conflictPending: (files: readonly string[]) =>
    files.length > 0 ? `上一次的衝突還沒解完:${files.join('、')}` : '上一次的衝突還沒解完',
  statusFailed: (message: string) => `讀不到 worktree 狀態:${message}`,
  failed: (message: string) => `合併失敗:${message}`,
  merged: (target: string, commits: number) => `已合併到 ${target}(${String(commits)} 個 commit)`,
  mergedNoCount: (target: string) => `已合併到 ${target}`,
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

/** 真正說明失敗原因的那一行開頭。 */
const LOUD = /^(fatal:|error:|CONFLICT)/
/** 建議與進度,放進 UI 一列裡看了也不知道發生什麼事。 */
const QUIET = /^(hint:|Auto-merging|Merge )/

/**
 * git 失敗時只取一行:多行細節放進 UI 一列裡看不清楚。
 * git 會把 `hint:` 排在 `fatal:` 前面(例如 ff 失敗),所以先挑說明原因的那行。
 */
function firstLine(out: string): string {
  const lines = out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  return lines.find((line) => LOUD.test(line))
    ?? lines.find((line) => QUIET.test(line) === false)
    ?? lines[0]
    ?? '未知的 git 錯誤'
}

function names(out: string): readonly string[] {
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/** `git status --porcelain` 每行前三個字元是狀態碼。 */
function porcelainPaths(out: string): readonly string[] {
  return out.split('\n').filter((line) => line.length > 3).map((line) => line.slice(3))
}

/**
 * 分支名的三種結果。detached 與「指令根本沒跑起來」是兩件事:目錄不在、不是 repo、
 * index.lock 都會讓 symbolic-ref 失敗,那時不該叫人「切回分支」。
 */
type BranchOf =
  | { readonly kind: 'branch'; readonly name: string }
  | { readonly kind: 'detached' }
  | { readonly kind: 'failed'; readonly message: string }

export function createMerge(deps: MergeDeps): MergeService {
  const branchOf = async (cwd: string): Promise<BranchOf> => {
    const head = await deps.run(['symbolic-ref', '--short', 'HEAD'], cwd)
    const name = head.ok ? head.out.trim() : ''
    if (name.length > 0) return { kind: 'branch', name }
    // detached HEAD 時 git 說的是 `fatal: ref HEAD is not a symbolic ref`。
    if (head.ok === false && head.out.includes('not a symbolic ref')) return { kind: 'detached' }
    return { kind: 'failed', message: firstLine(head.out) }
  }

  const conflictFiles = async (cwd: string): Promise<readonly string[]> => {
    const listed = await deps.run(['diff', '--name-only', '--diff-filter=U'], cwd)
    return listed.ok ? names(listed.out) : []
  }

  const hasMergeHead = async (cwd: string): Promise<boolean> =>
    (await deps.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)).ok

  /** 算不出來時回 undefined,呼叫端自己決定要當 0 還是不顯示數字。 */
  const aheadOf = async (cwd: string, target: string, branch: string): Promise<number | undefined> => {
    const counted = await deps.run(['rev-list', '--count', `${target}..${branch}`], cwd)
    if (counted.ok === false) return undefined
    const value = Number(counted.out.trim())
    return Number.isInteger(value) && value >= 0 ? value : undefined
  }

  type DirtyPaths = { readonly ok: true; readonly files: readonly string[] } | { readonly ok: false; readonly message: string }

  /** 失敗原因(index.lock、目錄被刪、權限等)保留給呼叫端,不能摺成 detached 判斷。 */
  const dirtyPaths = async (cwd: string): Promise<DirtyPaths> => {
    const listed = await deps.run(['-c', 'core.quotePath=false', 'status', '--porcelain', ...WORKTREE_SCOPE], cwd)
    return listed.ok ? { ok: true, files: porcelainPaths(listed.out) } : { ok: false, message: firstLine(listed.out) }
  }

  /** 五道前置檢查,任一不過就回報,什麼都不動(規格 §3.1)。 */
  const precheck = async (
    args: MergeArgs,
  ): Promise<{ readonly kind: 'ok'; readonly target: string; readonly branch: string } | MergeRefusal> => {
    if (args.agentBusy()) return { kind: 'agentBusy' }
    const rootStatus = await deps.run(['-c', 'core.quotePath=false', 'status', '--porcelain'], args.rootPath)
    if (rootStatus.ok === false) return { kind: 'failed', message: firstLine(rootStatus.out) }
    const dirty = porcelainPaths(rootStatus.out)
    if (dirty.length > 0) return { kind: 'rootDirty', files: dirty }
    const target = await branchOf(args.rootPath)
    if (target.kind === 'detached') return { kind: 'rootDetached' }
    if (target.kind === 'failed') return { kind: 'failed', message: target.message }
    if (await hasMergeHead(args.worktreePath)) {
      return { kind: 'conflictPending', files: await conflictFiles(args.worktreePath) }
    }
    const branch = await branchOf(args.worktreePath)
    if (branch.kind === 'detached') return { kind: 'failed', message: MSG.worktreeDetached }
    if (branch.kind === 'failed') return { kind: 'failed', message: branch.message }
    return { kind: 'ok', target: target.name, branch: branch.name }
  }

  /** 合併前先把 worktree 的未提交改動固定成一個 commit;沒有改動就什麼都不做。 */
  const autoCommit = async (args: MergeArgs): Promise<MergeRefusal | undefined> => {
    const added = await deps.run(['add', '-A', ...WORKTREE_SCOPE], args.worktreePath)
    if (added.ok === false) return { kind: 'failed', message: firstLine(added.out) }
    const staged = await dirtyPaths(args.worktreePath)
    if (staged.ok === false) return { kind: 'failed', message: MSG.statusFailed(staged.message) }
    if (staged.files.length === 0) return undefined
    const committed = await deps.run(['commit', '-m', MSG.autoCommit(args.label)], args.worktreePath)
    return committed.ok ? undefined : { kind: 'failed', message: firstLine(committed.out) }
  }

  /** 第一段:把目標分支併進 worktree 分支。衝突只會發生在這裡。 */
  const joinTarget = async (
    args: MergeArgs, target: string, branch: string,
  ): Promise<{ readonly kind: 'ok' } | Extract<MergeResult, { kind: 'conflict' | 'failed' }>> => {
    const joined = await deps.run(['merge', '--no-edit', target], args.worktreePath)
    if (joined.ok) return { kind: 'ok' }
    // 衝突態看 MERGE_HEAD,不看檔案清單:清單查不到(索引壞了、權限)不代表沒有衝突,
    // 那時回 failed 會讓 UI 以為什麼都沒發生,worktree 卻停在 merge 中。
    if (await hasMergeHead(args.worktreePath) === false) return { kind: 'failed', message: firstLine(joined.out) }
    return { kind: 'conflict', target, branch, files: await conflictFiles(args.worktreePath) }
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
      if (branch.kind === 'detached') return { kind: 'failed', message: MSG.worktreeDetached }
      if (branch.kind === 'failed') return { kind: 'failed', message: branch.message }
      const found = await branchOf(args.rootPath)
      if (found.kind === 'failed') return { kind: 'failed', message: found.message }
      const target = found.kind === 'branch' ? found.name : null
      const dirty = await dirtyPaths(args.worktreePath)
      if (dirty.ok === false) return { kind: 'failed', message: MSG.statusFailed(dirty.message) }
      return {
        kind: 'status',
        branch: branch.name,
        target,
        ahead: target === null ? 0 : await aheadOf(args.worktreePath, target, branch.name) ?? 0,
        dirty: dirty.files.length > 0,
        conflictPending: await hasMergeHead(args.worktreePath),
      }
    } catch (error) {
      const failure = asError(error)
      deps.logError(failure)
      return { kind: 'failed', message: failure.message }
    }
  }

  const abort = async (args: Pick<MergeArgs, 'worktreePath' | 'agentBusy'>): Promise<AbortResult> => {
    // agent 可能正在那個 worktree 裡解衝突;放棄合併等於把它腳下的 merge 拿掉,跟
    // merge() 一樣,這個檢查在任何 git 指令之前。
    if (args.agentBusy()) return { kind: 'agentBusy' }
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
