import { mask } from '@yeschef/error-intake'
import type {
  ErrorIntakeGroup,
  ErrorIntakeSettingsInput,
  ErrorIntakeSettingsView,
  ErrorIntakeStatus,
} from '../../shared/error-intake.js'
import type { StoredConfig, StoredWriter } from './store.js'

export function settingsView(config: StoredConfig): ErrorIntakeSettingsView {
  return {
    host: config.host, port: config.port, database: config.database, tls: config.tls,
    adminUsername: config.adminUsername,
    hasAdminPassword: config.adminPasswordCiphertext !== null,
    hasAppPassword: config.appPasswordCiphertext !== null,
    schemaVersion: config.schemaVersion,
    packageSource: config.packageSource,
  }
}

export function statusFromConfig(config: StoredConfig, connected: boolean, schemaVersion: number | null, passwordNeedsReentry = false): ErrorIntakeStatus {
  return { connected, passwordNeedsReentry, schemaVersion, lastCleanupAt: config.lastCleanupAt, lastCleanup: config.lastCleanup }
}

export function isDatabaseChanged(current: StoredConfig, settings: ErrorIntakeSettingsInput): boolean {
  return current.host !== settings.host || current.port !== settings.port || current.database !== settings.database
}

export function clearDatabaseStateOnChange(config: StoredConfig, changed: boolean): StoredConfig {
  return changed ? {
    ...config, appPasswordCiphertext: null, appUsername: 'ei_yeschef', schemaVersion: null,
    projectWriters: [], enabledProjects: [], lastCleanupAt: null, lastCleanup: null,
  } : config
}

export function errorGroups(raw: unknown): ErrorIntakeGroup[] {
  if (!Array.isArray(raw)) return []
  const rows: ErrorIntakeGroup[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const row = value as Record<string, unknown>
    if ((row.source !== 'server' && row.source !== 'browser') || typeof row.error_type !== 'string') continue
    if (row.environment !== 'local' && row.environment !== 'staging' && row.environment !== 'production') continue
    rows.push({ source: row.source, error_type: mask(row.error_type),
      route: typeof row.route === 'string' ? mask(row.route) : null, environment: row.environment })
  }
  return rows
}

const RESERVED_PROJECT_CODES: ReadonlySet<string> = new Set(['yeschef', 'sidepane'])

export function validateProjectCode(projectId: string, projectCode: string): void {
  if (projectId.trim() === '') throw new Error('專案識別碼不可為空')
  if (!/^[a-z0-9-]{1,28}$/.test(projectCode)) throw new Error('專案代號須為 1 至 28 字的小寫英數或連字號')
  // 寫入帳號叫 ei_<代號>，不能和 app 帳號同名：新安裝是 ei_yeschef，改名前建立的是 ei_sidepane。
  if (RESERVED_PROJECT_CODES.has(projectCode)) throw new Error(`${projectCode} 為保留的專案代號`)
}

export function validateWriterOwnership(config: StoredConfig, id: string, code: string): StoredWriter | undefined {
  const duplicate = config.projectWriters.find((writer) => writer.projectCode === code && writer.projectId !== id)
  if (duplicate !== undefined) throw new Error('此專案代號已被其他專案使用')
  const existing = config.projectWriters.find((writer) => writer.projectId === id)
  if (existing !== undefined && existing.projectCode !== code) throw new Error('已建立的專案代號不可直接更改')
  return existing
}

export function replaceWriter(config: StoredConfig, existing: StoredWriter | undefined, id: string, code: string, cipher: string): StoredWriter[] {
  const next: StoredWriter = { projectId: id, projectCode: code, passwordCiphertext: cipher }
  return existing === undefined ? [...config.projectWriters, next]
    : config.projectWriters.map((writer) => writer.projectId === id ? next : writer)
}

export function buildWriterUrl(config: StoredConfig, projectCode: string, password: string): string {
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host
  const options = new URLSearchParams({ timezone: 'Z' })
  if (config.tls) options.set('ssl', JSON.stringify({ rejectUnauthorized: true }))
  const username = encodeURIComponent(writerUsername(projectCode))
  return `mysql://${username}:${encodeURIComponent(password)}@${host}:${config.port}/${encodeURIComponent(config.database)}?${options.toString()}`
}

export function writerUsername(projectCode: string): string {
  if (!/^[a-z0-9-]{1,28}$/.test(projectCode)) throw new Error('專案代號須為 1 至 28 字的小寫英數或連字號')
  const username = `ei_${projectCode.replaceAll('-', '_')}`
  if (username.length > 32) throw new Error('MySQL 帳號名稱超過 32 字')
  return username
}
