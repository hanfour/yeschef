import { isAbsolute, relative, resolve } from 'node:path'

export const ERROR_INTAKE_TEST_DATABASE = 'error_intake_test'
export const REQUIRED_ERROR_INTAKE_ENV = [
  'ERROR_INTAKE_DATABASE_URL',
  'ERROR_INTAKE_PROJECT',
  'APP_ENV',
] as const

export interface RootDatabaseConnection {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
}

export interface AcceptanceCheck {
  readonly check: string
  readonly ok: boolean
  readonly detail: string
}

export interface CheckErrorIntakeSummary {
  readonly called: boolean
  readonly counts: readonly number[]
  readonly returnedMoreThanZero: boolean
}

export function parseRootDatabaseUrl(value: string): RootDatabaseConnection {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('EI_TEST_DB_ROOT_URL 格式無效')
  }
  if (parsed.protocol !== 'mysql:') throw new Error('EI_TEST_DB_ROOT_URL 必須使用 mysql://')
  let database: string
  try {
    database = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    throw new Error('EI_TEST_DB_ROOT_URL 資料庫名稱格式無效')
  }
  if (database !== ERROR_INTAKE_TEST_DATABASE) {
    throw new Error(`EI_TEST_DB_ROOT_URL 資料庫名稱必須是 ${ERROR_INTAKE_TEST_DATABASE}`)
  }
  if (parsed.hostname === '' || parsed.username === '') throw new Error('EI_TEST_DB_ROOT_URL 缺少主機或帳號')
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  }
}

export function validateRunLabel(value: string | undefined): string {
  if (value === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(value)) {
    throw new Error('RUN_LABEL 必須是 1 到 32 個英數字、底線或連字號，且以英數字開頭')
  }
  return value
}

export function taskTimeoutMinutes(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 150
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error('EI_TASK_TIMEOUT_MINUTES 必須是正整數')
  return minutes
}

export function isPathWithin(root: string, candidate: string): boolean {
  const from = resolve(root)
  const to = resolve(candidate)
  const path = relative(from, to)
  return path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

export function portOwnerIsInWorktree(cwd: string | undefined, worktree: string): boolean {
  return cwd !== undefined && (resolve(cwd) === resolve(worktree) || isPathWithin(worktree, cwd))
}

export function missingEnvironmentNames(content: string, required: readonly string[] = REQUIRED_ERROR_INTAKE_ENV): readonly string[] {
  const names = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match?.[1] !== undefined) names.add(match[1])
  }
  return required.filter((name) => !names.has(name))
}

export function checkErrorIntakeSummary(events: readonly unknown[]): CheckErrorIntakeSummary {
  const uses = events.flatMap((event) => {
    const item = record(event)
    return item?.['kind'] === 'tool-use' && isCheckTool(item['name']) && typeof item['id'] === 'string'
      ? [item['id']]
      : []
  })
  const counts = uses.flatMap((id) => {
    const result = events.find((event) => {
      const item = record(event)
      return item?.['kind'] === 'tool-result' && item['id'] === id
    })
    return result === undefined ? [] : parseReportedCounts(record(result)?.['content'])
  })
  return { called: uses.length > 0, counts, returnedMoreThanZero: counts.some((count) => count > 0) }
}

export function pullRequestUrl(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const match = stringifyContent(value).match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/i)
    if (match?.[0] !== undefined) return match[0]
  }
  return undefined
}

export function redactSensitiveText(value: string, secrets: readonly string[] = []): string {
  let text = value
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, '***')
  }
  return text
    .replace(/\bmysql(?:2)?:\/\/[^\s"'<>]+/gi, 'mysql://***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
}

export function allChecksPassed(checks: readonly AcceptanceCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.ok)
}

function isCheckTool(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.split('__').at(-1) === 'check_error_intake'
}

function parseReportedCounts(value: unknown): readonly number[] {
  return Array.from(stringifyContent(value).matchAll(/查到\s*(\d+)\s*個錯誤群/g))
    .flatMap((match) => match[1] === undefined ? [] : [Number(match[1])])
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(stringifyContent).join('\n')
  const item = record(value)
  if (item === undefined) return ''
  if (typeof item['text'] === 'string') return item['text']
  return JSON.stringify(value) ?? ''
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 從前端原始碼找出主廚設定給 installErrorReporter 的 endpoint。路徑由主廚依專案的 proxy 決定
 * （目標專案的前端可能會由 proxy 移除 /api），驗收不能寫死。只接受同源的絕對路徑。
 */
export function extractReporterEndpoint(source: string): string | undefined {
  const match = /installErrorReporter\(\s*\{[^}]*?endpoint\s*:\s*(["'`])(\/[^"'`\s]*)\1/s.exec(source)
  return match?.[2]
}
