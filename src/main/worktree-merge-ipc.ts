import { WorktreeMergeRequestSchema, type WorktreeMergeRequest, type WorktreeMergeResponse } from '../shared/worktree-merge.js'
import { MSG, type AbortResult, type MergeResult, type MergeService, type MergeStatusResult } from './merge.js'
import type { MergeLocks } from './merge-locks.js'

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
  /** 跟 projects-ipc 共用同一份:關分頁那邊要看得到這裡的合併還在不在跑。 */
  readonly locks: MergeLocks
  readonly isTrustedSender: (sender: unknown) => boolean
  readonly logError: (error: Error) => void
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 合併結果轉成 renderer 看得到的形狀:只留分支名、相對路徑、commit 數與一句話。 */
function toResponse(result: MergeResult): WorktreeMergeResponse {
  switch (result.kind) {
    case 'merged': {
      const { commits, target } = result
      // 數字算不出來時不能說「已是最新」:合併確實做了,只是不知道進去幾個 commit。
      const message = commits === undefined
        ? MSG.mergedNoCount(target)
        : commits === 0 ? MSG.upToDate(target) : MSG.merged(target, commits)
      return { kind: 'merged', target, branch: result.branch, ...(commits === undefined ? {} : { commits }), message }
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
  if (result.kind === 'aborted') return { kind: 'aborted' }
  if (result.kind === 'agentBusy') return { kind: 'agentBusy', message: MSG.agentBusy }
  return { kind: 'failed', message: MSG.failed(result.message) }
}

/**
 * `worktree:merge` 的 ipcMain.handle 處理器(合併規格 §4)。
 * 來源不對直接回 error,不碰 git;路徑一律從 projects state 查,renderer 只給 id。
 */
export function createWorktreeMergeHandler(
  deps: WorktreeMergeIpcDeps,
): (event: { sender: unknown }, raw: unknown) => Promise<WorktreeMergeResponse> {
  const agentBusyFor = (request: WorktreeMergeRequest): { isBusy: () => boolean; conversation: ReturnType<WorktreeMergeIpcDeps['conversation']> } => {
    const conversation = deps.conversation(request.projectId, request.tabId)
    return { isBusy: () => conversation?.isBusy() ?? false, conversation }
  }

  const runMerge = async (request: WorktreeMergeRequest, found: WorktreeMergeTarget): Promise<WorktreeMergeResponse> => {
    const { isBusy, conversation } = agentBusyFor(request)
    const result = await deps.merge.merge({ ...found, agentBusy: isBusy })
    // 衝突留在 worktree 裡,請那個對話的 agent 解;人也可以自己在終端解。
    if (result.kind === 'conflict') conversation?.userInput(MSG.agentConflict(result.target, result.files))
    return toResponse(result)
  }

  // agent 可能正在那個 worktree 裡解衝突;放棄合併等於把它腳下的 merge 拿掉,所以跟
  // merge 一樣先查 agentBusy(merge.ts 的 abort() 在任何 git 指令之前就擋掉)。
  const runAbort = async (request: WorktreeMergeRequest, found: WorktreeMergeTarget): Promise<WorktreeMergeResponse> => {
    const { isBusy } = agentBusyFor(request)
    return toAbortResponse(await deps.merge.abort({ worktreePath: found.worktreePath, agentBusy: isBusy }))
  }

  /**
   * 鎖拿不到就直接回 inProgress,不碰 git。鎖的範圍由鍵決定:
   * `merge` 是整個專案(第二段跑在主目錄,同專案的兩個分頁同時合併會互相踩到),
   * `abort` 是單一分頁(只動那個 worktree)。`status` 唯讀,不進來。
   */
  const runExclusive = async (key: string, run: () => Promise<WorktreeMergeResponse>): Promise<WorktreeMergeResponse> => {
    if (deps.locks.acquire(key) === false) return { kind: 'failed', message: MSG.inProgress }
    try {
      return await run()
    } finally {
      deps.locks.release(key)
    }
  }

  return async (event, raw) => {
    try {
      if (deps.isTrustedSender(event.sender) === false) return { kind: 'error', message: MSG_UNTRUSTED }
      const parsed = WorktreeMergeRequestSchema.safeParse(raw)
      if (parsed.success === false) return { kind: 'error', message: MSG_BAD_REQUEST }
      const request = parsed.data
      const found = deps.locate(request.projectId, request.tabId)
      if (found === undefined) return { kind: 'error', message: MSG_NO_WORKTREE }
      if (request.action === 'status') return toStatusResponse(await deps.merge.status(found))
      const abort = request.action === 'abort'
      const key = abort ? `${request.projectId}/${request.tabId}` : request.projectId
      const run = (): Promise<WorktreeMergeResponse> => (abort ? runAbort(request, found) : runMerge(request, found))
      return await runExclusive(key, run)
    } catch (error) {
      const failure = asError(error)
      deps.logError(failure)
      return { kind: 'failed', message: MSG.failed(failure.message) }
    }
  }
}
