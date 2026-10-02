import { realpath, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PermissionStateSchema, PermissionsRequestSchema, AuditSchema, type PermissionState, type PermissionsResponse, type PermissionAudit } from '../../shared/permissions.js'
import { createApprovalRegistry, type ApprovalRegistryOptions, type ApprovalOutcome, type ApprovalRequest } from '../approval.js'
import { collectEvidence, hash, within } from './evidence.js'
import { ReviewResultSchema, type Reviewer } from './reviewer.js'
import { canonicalToolName } from '../../shared/tool-name.js'
export interface PermissionContext { projectId: string; conversationId: string; cwd: string }
export interface SaveDialogResult { canceled: boolean; filePath?: string }
export type ShowSaveDialog = (options: { title: string; defaultPath: string; filters: { name: string; extensions: string[] }[] }) => Promise<SaveDialogResult>
const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const cap = (value: string): string => value.length > 200 ? value.slice(0, 200) : value
/** 只留下可安全顯示的摘要，絕不含檔案內容、old_string/new_string 或完整輸入。 */
export function auditSummary(request: ApprovalRequest): string {
  const input = record(request.input)
  if (request.toolName === 'Bash') {
    const command = input && typeof input.command === 'string' ? input.command.trim().replace(/\s+/g, ' ') : ''
    return cap(command || request.toolName)
  }
  if (['Write', 'Edit', 'MultiEdit'].includes(request.toolName)) {
    if (input && typeof input.file_path === 'string') return cap(input.file_path)
    if (input && Array.isArray(input.changes)) {
      const paths = input.changes.map(change => record(change)?.path).filter((p): p is string => typeof p === 'string')
      if (paths.length) return cap(paths.length > 1 ? `${paths[0]} (+${paths.length - 1})` : paths[0]!)
    }
    return request.toolName
  }
  if (request.toolName === 'Read' && input && typeof input.file_path === 'string') return cap(input.file_path)
  return request.toolName
}
export interface PermissionService {
  handle(raw: unknown): Promise<PermissionsResponse>
  registry(context: PermissionContext, options: ApprovalRegistryOptions): ReturnType<typeof createApprovalRegistry>
  dispose(): Promise<void>
}
export async function createPermissionService(dir: string, reviewer: Reviewer, projectExists: (id: string) => boolean, logError: (error: Error) => void, showSaveDialog?: ShowSaveDialog): Promise<PermissionService> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'policies.json'), auditFile = join(dir, 'audit.json')
  let state: PermissionState = { revision: 0, paused: false, policies: [] }
  let audit: PermissionAudit[] = []
  let storageError = ''
  try { state = PermissionStateSchema.parse(JSON.parse(await readFile(file, 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { storageError = '授權檔案無法讀取，已停用自動批准'; logError(error as Error) } }
  try {
    audit = AuditSchema.array().parse(JSON.parse(await readFile(auditFile, 'utf8'))).slice(-200)
      .map(entry => ({ ...entry, tool: canonicalToolName(entry.tool) }))
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError(error as Error) }
  let writes = Promise.resolve()
  let closed = false
  let changing = false
  const running = new Set<string>()
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  const atomic = async (path: string, value: unknown) => {
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(tmp, path)
  }
  const enqueue = (work: () => Promise<void>) => { const task = writes.then(work); writes = task.catch(error => { logError(error as Error) }); return task }
  const snapshot = (): PermissionsResponse => ({ kind: 'state', state, audit: [...audit].reverse(), ...(storageError ? { error: storageError } : {}) })
  function log(context: PermissionContext, request: ApprovalRequest, outcome: ApprovalOutcome | null, revision: number, reason = '') {
    audit = [...audit, { id: randomUUID(), at: new Date().toISOString(), projectId: context.projectId, conversationId: context.conversationId, tool: request.toolName, decision: outcome?.decision ?? 'manual', source: outcome?.source ?? (outcome ? 'user' : 'system'), reason: (outcome?.reason ?? reason).slice(0, 1000), revision, requestHash: hash({ tool: request.toolName, input: request.input }), summary: auditSummary(request) } satisfies PermissionAudit].slice(-200)
    const saved = [...audit]
    void enqueue(() => atomic(auditFile, saved)).catch(() => { storageError = '審核紀錄寫入失敗，已停用自動批准'; publish() })
  }
  async function exportAudit(projectId: string): Promise<PermissionsResponse> {
    if (!showSaveDialog) return { kind: 'error', message: '匯出功能未啟用' }
    const rows = [...audit].filter(a => a.projectId === projectId).reverse()
    const date = new Date().toISOString().slice(0, 10)
    const result = await showSaveDialog({
      title: '匯出授權紀錄',
      defaultPath: `yeschef-授權紀錄-${projectId.slice(0, 8)}-${date}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return snapshot()
    try {
      await writeFile(result.filePath, JSON.stringify(rows, null, 2), 'utf8')
      return { kind: 'exported', path: result.filePath }
    } catch (error) { logError(error as Error); return { kind: 'error', message: '匯出授權紀錄失敗' } }
  }
  async function forbidden(context: PermissionContext, request: ApprovalRequest): Promise<ApprovalOutcome | null> {
    const version = state.revision
    if (changing || closed) return { decision: 'deny', source: 'system', reason: '授權正在變更或工作台已關閉，請重試' }
    const policy = state.policies.find(p => p.projectId === context.projectId)
    if (!policy || !['Read', 'Write', 'Edit', 'MultiEdit'].includes(request.toolName)) return null
    const input = request.input as { file_path?: unknown; changes?: unknown[] } | null
    const paths: string[] = []
    if (typeof input?.file_path === 'string') paths.push(input.file_path)
    if (Array.isArray(input?.changes)) for (const raw of input.changes) {
      const change = raw as { path?: unknown; kind?: { move_path?: unknown; movePath?: unknown } } | null
      for (const p of [change?.path, change?.kind?.move_path, change?.kind?.movePath]) if (typeof p === 'string') paths.push(p)
    }
    const roots = [resolve(context.cwd), await realpath(context.cwd)]
    if (version !== state.revision || changing || closed) return { decision: 'deny', source: 'system', reason: '授權規則已變更，請重試' }
    if (paths.some(path => roots.some(root => policy.excluded.some(p => within(resolve(root, p), resolve(root, path)))))) return { decision: 'deny', reason: '命中專案禁止路徑，需先修改授權設定', source: 'rule' }
    return null
  }
  async function evaluate(context: PermissionContext, request: ApprovalRequest, signal: AbortSignal, progress: (status: 'checking' | 'reviewing' | 'manual', reason: string) => void): Promise<ApprovalOutcome | null> {
    const revision = state.revision
    const manual = (reason: string) => { if (!signal.aborted) { progress('manual', reason); log(context, request, null, revision, reason) } return null }
    const policy = state.policies.find(p => p.projectId === context.projectId)
    const prohibited = await forbidden(context, request)
    if (signal.aborted) return null
    if (prohibited) return prohibited
    if (closed || changing || storageError || !policy || !projectExists(context.projectId)) return manual(storageError || '未設定自動授權')
    if (request.executionCwd && resolve(request.executionCwd) !== resolve(context.cwd)) return manual('對話執行目錄與授權工作目錄不同')
    if (request.validateEvidence && !request.validateEvidence()) return manual('工具證據已失效')
    let evidence
    try { evidence = await collectEvidence(request, context.cwd) }
    catch { return manual('無法驗證路徑或檔案版本') }
    if (signal.aborted) return null
    if (!evidence) return manual('此工具或證據不在自動批准支援範圍')
    if (state.paused || policy.mode === 'manual' || !policy[evidence.operation]) return manual('目前設定由使用者批准')
    if (revision !== state.revision || changing) return manual('授權規則已變更')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true }); listeners.add(cancel)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      let outcome: ApprovalOutcome = { decision: 'allow', source: 'rule', reason: '符合專案檔案授權' }
      if (policy.mode === 'review') {
        if (!policy.purpose.trim()) return manual('請先設定審核目的')
        if (running.has(context.projectId)) return manual('此專案已有審核工作，這筆交由你確認')
        running.add(context.projectId)
        progress('reviewing', '獨立 Claude 審核 · 最長 30 秒 · 可直接允許或拒絕接管')
        timeout = setTimeout(cancel, 30_000)
        const reviewHash = hash({ requestId: request.requestId, context, revision, purpose: policy.purpose, evidence: evidence.fingerprint })
        const job = Promise.resolve().then(() => reviewer({ requestHash: reviewHash, purpose: policy.purpose, operation: evidence!.operation, paths: evidence!.paths, input: evidence!.input }, controller.signal))
        // Keep the concurrency slot until the actual worker exits, even after timeout.
        void job.finally(() => running.delete(context.projectId)).catch(() => {})
        const result = await Promise.race([job, new Promise<never>((_, reject) => {
          const stop = () => reject(Error('審核已取消或逾時'))
          controller.signal.addEventListener('abort', stop, { once: true })
          if (controller.signal.aborted) stop()
        })])
        const checked = ReviewResultSchema.parse(result)
        if (checked.requestHash !== reviewHash) return manual('審核請求不一致')
        if (checked.verdict === 'ask-user') return manual(checked.reason)
        outcome = { decision: checked.verdict, source: 'review', reason: checked.reason }
      }
      if (signal.aborted) return null
      if (controller.signal.aborted || changing || storageError || revision !== state.revision || closed) return manual('審核已取消或授權變更')
      const current = await collectEvidence(request, context.cwd)
      if (!current || current.fingerprint !== evidence.fingerprint || (request.validateEvidence && !request.validateEvidence())) return manual('審核期間操作內容或檔案已改變')
      if (signal.aborted || controller.signal.aborted || revision !== state.revision || changing) return null
      return { ...outcome, authorizationVersion: revision }
    } catch { return manual('審核未完成或回傳無效，請由你確認') }
    finally { clearTimeout(timeout); listeners.delete(cancel); signal.removeEventListener('abort', cancel); controller.abort() }
  }
  return {
    async handle(raw) {
      const parsed = PermissionsRequestSchema.safeParse(raw)
      if (!parsed.success) return { kind: 'error', message: '授權請求格式不正確' }
      const request = parsed.data
      if (request.action === 'get') return snapshot()
      if (request.action === 'export') return exportAudit(request.projectId)
      if (closed || changing) return { kind: 'error', message: '設定正在儲存，請稍後重試' }
      if (request.revision !== state.revision) return { kind: 'error', message: '設定已變更，請重新讀取後再儲存' }
      if (request.action === 'save') {
        if (!projectExists(request.policy.projectId)) return { kind: 'error', message: '專案已不存在' }
        if (request.policy.mode === 'review' && !request.policy.purpose.trim()) return { kind: 'error', message: 'Agent 審核需要明確的審核目的' }
        if (request.policy.excluded.some(p => isAbsolute(p) || p.includes('\0') || p.split(/[\\/]/).includes('..'))) return { kind: 'error', message: '禁止路徑必須是專案內的相對路徑' }
      }
      changing = true; publish()
      try {
        const next = request.action === 'pause' ? { ...state, paused: request.paused, revision: state.revision + 1 }
          : { ...state, policies: [...state.policies.filter(p => p.projectId !== request.policy.projectId), request.policy], revision: state.revision + 1 }
        await enqueue(() => atomic(file, next))
        state = next; storageError = ''; return snapshot()
      } catch { return { kind: 'error', message: '授權設定儲存失敗，未套用變更' } }
      finally { changing = false; publish() }
    },
    registry(context, options) {
      return createApprovalRegistry({ ...options,
        finalize: outcome => outcome.decision === 'allow' && (closed || changing || outcome.authorizationVersion !== state.revision)
          ? { decision: 'deny', source: 'system', reason: '授權規則已變更，請重新提出請求' } : outcome,
        validateAllow: async request => {
          const prohibited = await forbidden(context, request)
          if (prohibited) return prohibited
          if (request.validateEvidence && !request.validateEvidence()) return { decision: 'deny', source: 'system', reason: '此工具請求已失效' }
          return { decision: 'allow', source: 'user', authorizationVersion: state.revision }
        },
        evaluate: (request, signal, progress) => evaluate(context, request, signal, progress),
        onDecision: (request, outcome) => { log(context, request, outcome, state.revision); options.onDecision?.(request, outcome) },
      })
    },
    async dispose() { closed = true; publish(); await writes },
  }
}
