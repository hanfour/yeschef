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
  // commits 算不出來(rev-list 失敗)時整個欄位不帶,訊息只說合併到哪裡。
  z.object({ kind: z.literal('merged'), target: z.string(), branch: z.string(), commits: count.optional(), message: z.string() }).strict(),
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
