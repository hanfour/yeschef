import { createPool } from 'mysql2/promise'
import { missingAdminPermissions } from './permissions.js'

export interface ErrorIntakePool {
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>
  end(): Promise<void>
}

export interface ErrorIntakePoolOptions {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database?: string
  readonly timezone: 'Z'
  readonly ssl?: { readonly rejectUnauthorized: true }
  readonly connectionLimit: number
}

export class MissingPermissionsError extends Error {
  constructor(readonly missing: readonly string[]) { super('missing permissions') }
}

export class CleanupFailure extends Error {
  constructor(readonly deletedEvents: number, readonly deletedGroups: number, readonly code: string | undefined) {
    super('cleanup failed')
  }
}

export function createMysqlPool(options: ErrorIntakePoolOptions): ErrorIntakePool {
  return createPool(options) as unknown as ErrorIntakePool
}

export async function assertAdminPermissions(pool: ErrorIntakePool, database: string): Promise<void> {
  const [rows] = await query(pool, 'SHOW GRANTS FOR CURRENT_USER()')
  const missing = missingAdminPermissions(asRows(rows), database)
  if (missing.length > 0) throw new MissingPermissionsError(missing)
}

export async function ensureUser(
  pool: ErrorIntakePool,
  database: string,
  username: string,
  password: string,
  grants: readonly { readonly table: string; readonly privileges: string }[],
): Promise<void> {
  await query(pool, 'DROP USER IF EXISTS ?@?', [username, '%'])
  await query(pool, 'CREATE USER ?@? IDENTIFIED BY ?', [username, '%', password])
  await grantTables(pool, database, username, grants)
}

export async function grantTables(
  pool: ErrorIntakePool,
  database: string,
  username: string,
  grants: readonly { readonly table: string; readonly privileges: string }[],
): Promise<void> {
  for (const grant of grants) await query(pool, `GRANT ${grant.privileges} ON ??.?? TO ?@?`, [database, grant.table, username, '%'])
}

export async function selectDatabase(pool: ErrorIntakePool, database: string): Promise<void> {
  await query(pool, 'USE ??', [database])
}

export async function readSchemaVersion(pool: ErrorIntakePool): Promise<number | null> {
  const [rows] = await query(pool, 'SELECT schema_version FROM error_intake_meta WHERE id = 1')
  const value = asRows(rows)[0]?.schema_version
  const version = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN
  return Number.isInteger(version) ? version : null
}

export async function readSchemaVersionIfPresent(pool: ErrorIntakePool): Promise<number | null> {
  try { return await readSchemaVersion(pool) } catch { return null }
}

export async function cleanRows(pool: ErrorIntakePool): Promise<{ deletedEvents: number; deletedGroups: number }> {
  let deletedEvents = 0
  let deletedGroups = 0
  try {
    const events = await query(pool, "DELETE FROM error_event WHERE occurred_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)")
    deletedEvents += affectedRows(events[0])
    const oldGroupEvents = await query(pool, "DELETE FROM error_event WHERE group_id IN (SELECT id FROM error_group WHERE status IN ('resolved', 'ignored') AND last_seen_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 90 DAY))")
    deletedEvents += affectedRows(oldGroupEvents[0])
    const groups = await query(pool, "DELETE FROM error_group WHERE status IN ('resolved', 'ignored') AND last_seen_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 90 DAY)")
    deletedGroups = affectedRows(groups[0])
    return { deletedEvents, deletedGroups }
  } catch (raw) {
    throw new CleanupFailure(deletedEvents, deletedGroups, safeErrorCode(raw))
  }
}

/** mysql2 錯誤代碼。只接受大寫英數與底線，避免把訊息內容當代碼帶出。 */
export function dbErrorCode(raw: unknown): string | undefined {
  return typeof raw === 'object' && raw !== null && 'code' in raw && typeof raw.code === 'string' && /^[A-Z0-9_]+$/.test(raw.code)
    ? raw.code
    : undefined
}

/**
 * 給畫面看的連線失敗原因。使用者看不到主程序紀錄，要直接說出該改哪個欄位；
 * 只用代碼與使用者自己填的主機、連接埠、資料庫名稱，不帶 mysql2 的原始訊息（可能含帳號或連線字串）。
 */
export function connectionFailureMessage(raw: unknown, target: { readonly host: string; readonly port: number; readonly database: string }): string {
  const code = dbErrorCode(raw)
  const where = `${target.host}:${target.port}`
  switch (code) {
    case 'ECONNREFUSED': return `連不到 ${where}，請確認主機與連接埠，以及 MySQL 是否在執行`
    case 'ENOTFOUND': case 'EAI_AGAIN': return `找不到主機 ${target.host}`
    case 'ETIMEDOUT': return `連線 ${where} 逾時，請確認網路與防火牆`
    case 'ER_ACCESS_DENIED_ERROR': return '管理者帳號或密碼錯誤'
    case 'ER_BAD_DB_ERROR': return `資料庫 ${target.database} 不存在，請先建立`
    case 'HANDSHAKE_SSL_ERROR': return 'TLS 連線失敗：憑證無法驗證（例如自簽憑證）。本機測試可取消勾選 TLS'
    case 'HANDSHAKE_NO_SSL_SUPPORT': return 'MySQL 沒有開啟 TLS，請取消勾選 TLS，或在 MySQL 設定憑證'
    default: return code === undefined ? '連線或初始化失敗' : `連線或初始化失敗（錯誤代碼 ${code}）`
  }
}

export function logDbError(logError: (error: Error) => void, label: string, raw: unknown): void {
  const code = typeof raw === 'object' && raw !== null && 'code' in raw && typeof raw.code === 'string' && /^[A-Z0-9_]+$/.test(raw.code)
    ? ` (${raw.code})`
    : ''
  logError(new Error(`${label}${code}`))
}

export async function query(pool: ErrorIntakePool, sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
  return pool.query(sql, values)
}

function asRows(raw: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
}

function affectedRows(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null || !('affectedRows' in raw)) return 0
  const value = Number(raw.affectedRows)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function safeErrorCode(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !('code' in raw) || typeof raw.code !== 'string') return undefined
  return /^[A-Z0-9_]+$/.test(raw.code) ? raw.code : undefined
}
