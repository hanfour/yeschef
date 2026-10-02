import { mask } from '@yeschef/error-intake'
import type { ErrorIntakeEnvironment, ErrorIntakeGroupStatus, ErrorIntakePullGroup, ErrorFixGroup } from '../../shared/error-intake.js'
import type { ChefTask } from '../../shared/chef.js'
import type { ErrorIntakePool } from './database.js'
import { query } from './database.js'
import { cleanErrorContent, errorFixGroupIds, parseErrorFixReport } from './pull.js'

export interface ErrorIntakePullList {
  readonly environments: readonly ErrorIntakeEnvironment[]
  readonly selectedEnvironment: ErrorIntakeEnvironment
  readonly newGroups: readonly ErrorIntakePullGroup[]
  readonly inProgressGroups: readonly ErrorIntakePullGroup[]
}

export interface ErrorIntakePullOperations {
  listPullErrors(projectId: string, environment?: ErrorIntakeEnvironment): Promise<ErrorIntakePullList>
  getErrorFixData(projectId: string, groupIds: readonly string[]): Promise<readonly ErrorFixGroup[]>
  markErrorGroupsInProgress(projectId: string, groupIds: readonly string[], taskId: string): Promise<void>
  updateGroupStatus(projectId: string, groupId: string, status: Exclude<ErrorIntakeGroupStatus, 'in_progress'>): Promise<void>
  completeErrorFix(task: Pick<ChefTask, 'id' | 'projectId' | 'goal' | 'status' | 'reason' | 'report'>): Promise<void>
}

export type ErrorIntakeReader = <T>(
  projectId: string,
  work: (pool: ErrorIntakePool, projectCode: string) => Promise<T>,
) => Promise<T>

export class ErrorIntakePullError extends Error {}

export function createErrorIntakePullOperations(withReader: ErrorIntakeReader): ErrorIntakePullOperations {
  return {
    listPullErrors: (projectId, environment) => withReader(projectId, (pool, code) => listPullErrors(pool, code, environment)),
    getErrorFixData: (projectId, groupIds) => withReader(projectId, (pool, code) => readErrorFixData(pool, code, groupIds)),
    markErrorGroupsInProgress: (projectId, groupIds, taskId) => withReader(projectId, (pool, code) => markInProgress(pool, code, groupIds, taskId)),
    updateGroupStatus: (projectId, groupId, status) => withReader(projectId, (pool, code) => updateStatus(pool, code, groupId, status)),
    completeErrorFix: task => withReader(task.projectId, (pool, code) => writeBackTask(pool, code, task)),
  }
}

async function listPullErrors(pool: ErrorIntakePool, project: string, environment?: ErrorIntakeEnvironment): Promise<ErrorIntakePullList> {
  const [rawEnvironments] = await query(pool,
    "SELECT DISTINCT environment FROM error_group WHERE project = ? ORDER BY FIELD(environment, 'local', 'staging', 'production')", [project])
  const environments = readEnvironments(rawEnvironments)
  const selected = environment !== undefined && environments.includes(environment)
    ? environment
    : environments[0] ?? 'production'
  const [rawNew] = await query(pool,
    "SELECT id, environment, error_type, message, count, last_seen_at, route, regressed_at, status_note FROM error_group WHERE project = ? AND environment = ? AND status = 'new' ORDER BY last_seen_at DESC LIMIT 100",
    [project, selected])
  const [rawInProgress] = await query(pool,
    "SELECT id, environment, error_type, message, count, last_seen_at, route, regressed_at, status_note FROM error_group WHERE project = ? AND status = 'in_progress' ORDER BY last_seen_at DESC LIMIT 100",
    [project])
  return { environments, selectedEnvironment: selected, newGroups: readGroups(rawNew), inProgressGroups: readGroups(rawInProgress) }
}

async function readErrorFixData(pool: ErrorIntakePool, project: string, groupIds: readonly string[]): Promise<readonly ErrorFixGroup[]> {
  validateGroupIds(groupIds)
  const placeholders = groupIds.map(() => '?').join(', ')
  const [rawGroups] = await query(pool,
    `SELECT id, environment, fingerprint, error_type, message, count, last_seen_at, route, regressed_at, status_note FROM error_group WHERE project = ? AND status = 'new' AND id IN (${placeholders})`,
    [project, ...groupIds])
  const groups = readFixGroups(rawGroups)
  if (groups.length !== groupIds.length) throw new ErrorIntakePullError('有錯誤群已不再是新錯誤，請重新整理清單')
  const [rawEvents] = await query(pool,
    `SELECT group_id, stack FROM (SELECT e.group_id, e.stack, ROW_NUMBER() OVER (PARTITION BY e.group_id ORDER BY e.occurred_at DESC) AS sample_order FROM error_event e JOIN error_group g ON e.group_id = g.id WHERE g.project = ? AND g.status = 'new' AND g.id IN (${placeholders})) AS samples WHERE sample_order <= 3 ORDER BY group_id, sample_order`,
    [project, ...groupIds])
  const stacks = readStacks(rawEvents)
  return groups.map(group => ({ ...group, stacks: stacks.get(group.id) ?? [] }))
}

async function markInProgress(pool: ErrorIntakePool, project: string, groupIds: readonly string[], taskId: string): Promise<void> {
  validateGroupIds(groupIds)
  const placeholders = groupIds.map(() => '?').join(', ')
  await inTransaction(pool, async () => {
    const [result] = await query(pool,
      `UPDATE error_group SET status = 'in_progress', status_note = ? WHERE project = ? AND status = 'new' AND id IN (${placeholders})`,
      [taskId, project, ...groupIds])
    if (affectedRows(result) !== groupIds.length) throw new ErrorIntakePullError('錯誤群狀態已變更，請重新整理清單')
  })
}

async function updateStatus(pool: ErrorIntakePool, project: string, groupId: string, status: Exclude<ErrorIntakeGroupStatus, 'in_progress'>): Promise<void> {
  if (status !== 'new' && status !== 'resolved' && status !== 'ignored') throw new ErrorIntakePullError('錯誤群狀態不正確')
  const [rows] = await query(pool, 'SELECT id FROM error_group WHERE project = ? AND id = ?', [project, groupId])
  if (!Array.isArray(rows) || rows.length === 0) throw new ErrorIntakePullError('找不到這個專案的錯誤群')
  await query(pool,
    "UPDATE error_group SET status = ?, resolved_at = IF(? = 'resolved', UTC_TIMESTAMP(3), NULL) WHERE project = ? AND id = ?",
    [status, status, project, groupId])
}

async function writeBackTask(
  pool: ErrorIntakePool,
  project: string,
  task: Pick<ChefTask, 'id' | 'goal' | 'status' | 'reason' | 'report'>,
): Promise<void> {
  if (!['completed', 'blocked', 'cancelled'].includes(task.status)) return
  const groupIds = errorFixGroupIds(task.goal)
  if (groupIds.length === 0) throw new ErrorIntakePullError('錯誤修正任務沒有可回寫的群 ID')
  const outcomes = parseErrorFixReport(task.report?.summary ?? '', groupIds)
  await inTransaction(pool, async () => {
    for (const groupId of groupIds) {
      const detail = task.status === 'completed'
        ? outcomes.get(groupId) ?? '報告未列出這個錯誤的 PR 結果'
        : `${task.status === 'blocked' ? '任務卡住' : '任務已停止'}：${mask(task.reason)}`
      const note = limitNote(`${task.id}；${groupId}：${detail}`)
      await query(pool,
        "UPDATE error_group SET status_note = ? WHERE project = ? AND id = ? AND status = 'in_progress' AND status_note = ?",
        [note, project, groupId, task.id])
    }
  })
}

async function inTransaction(pool: ErrorIntakePool, work: () => Promise<void>): Promise<void> {
  await query(pool, 'START TRANSACTION')
  try {
    await work()
    await query(pool, 'COMMIT')
  } catch (error) {
    await query(pool, 'ROLLBACK').catch(() => {})
    throw error
  }
}

function readEnvironments(raw: unknown): ErrorIntakeEnvironment[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(value => {
    const environment = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).environment : undefined
    return environment === 'local' || environment === 'staging' || environment === 'production' ? [environment] : []
  })
}

function readGroups(raw: unknown): ErrorIntakePullGroup[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(row => {
    const group = asGroup(row)
    if (group === undefined) return []
    return [{
      id: group.id, environment: group.environment, errorType: group.errorType, message: group.message,
      count: group.count, lastSeenAt: group.lastSeenAt, route: group.route,
      regressedAt: group.regressedAt, statusNote: group.statusNote,
    }]
  })
}

function readFixGroups(raw: unknown): ErrorFixGroup[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(row => {
    const group = asGroup(row)
    if (group === undefined || typeof group.fingerprint !== 'string') return []
    return [{ ...group, fingerprint: group.fingerprint, stacks: [] }]
  })
}

interface ParsedGroup {
  readonly id: string
  readonly environment: ErrorIntakeEnvironment
  readonly errorType: string
  readonly message: string
  readonly count: number
  readonly lastSeenAt: string
  readonly route: string | null
  readonly regressedAt: string | null
  readonly statusNote: string | null
  readonly fingerprint?: string
}

function asGroup(raw: unknown): ParsedGroup | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.error_type !== 'string' || typeof row.message !== 'string') return undefined
  if (row.environment !== 'local' && row.environment !== 'staging' && row.environment !== 'production') return undefined
  if (typeof row.count !== 'number' || !Number.isInteger(row.count) || row.count < 0) return undefined
  return {
    id: row.id, environment: row.environment, errorType: cleanErrorContent(row.error_type), message: cleanErrorContent(row.message), count: row.count,
    lastSeenAt: dateText(row.last_seen_at), route: typeof row.route === 'string' ? cleanErrorContent(row.route) : null,
    regressedAt: nullableDateText(row.regressed_at),
    statusNote: typeof row.status_note === 'string' ? cleanErrorContent(row.status_note) : null,
    ...(typeof row.fingerprint === 'string' ? { fingerprint: row.fingerprint } : {}),
  }
}

function readStacks(raw: unknown): ReadonlyMap<string, string[]> {
  const stacks = new Map<string, string[]>()
  if (!Array.isArray(raw)) return stacks
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const row = value as Record<string, unknown>
    if (typeof row.group_id !== 'string' || typeof row.stack !== 'string') continue
    const current = stacks.get(row.group_id) ?? []
    stacks.set(row.group_id, [...current, row.stack])
  }
  return stacks
}

function validateGroupIds(groupIds: readonly string[]): void {
  if (groupIds.length < 1 || groupIds.length > 10 || new Set(groupIds).size !== groupIds.length) {
    throw new ErrorIntakePullError('請選擇 1 到 10 個不同的錯誤群')
  }
}

function dateText(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  return typeof raw === 'string' ? raw : ''
}

function nullableDateText(raw: unknown): string | null {
  if (raw == null) return null
  return dateText(raw)
}

function affectedRows(raw: unknown): number {
  return typeof raw === 'object' && raw !== null && 'affectedRows' in raw && typeof raw.affectedRows === 'number'
    ? raw.affectedRows
    : 0
}

function limitNote(value: string): string {
  const text = cleanErrorContent(value)
  const suffix = '…'
  let end = text.length
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > 1000 - Buffer.byteLength(suffix)) end -= 1
  return end < text.length ? `${text.slice(0, end)}${suffix}` : text
}
