import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Pool } from 'mysql2/promise'
import { extractReporterEndpoint, redactSensitiveText } from './error-intake-acceptance-helpers.js'
import type { CheckResult } from './group-acceptance-runtime.js'

const ROOT = resolve(__dirname, '..')
const SERVER_ENDPOINT = 'http://127.0.0.1:3001/auth/me'
const FRONTEND_ORIGIN = 'http://localhost:5021'
const REQUIRED_MASK_VALUES = [
  'jane@example.com',
  'Bearer abc.def.ghi',
  'https://x.test/p?key=leak123',
  '0912345678',
] as const

export interface ServerErrorCheck {
  readonly check: CheckResult
  readonly statuses: readonly number[]
  readonly groupCount: number
  readonly occurrenceCount: number
  readonly sampleCount: number
}

export interface BrowserCheck {
  readonly sourceCheck: CheckResult
  readonly maskingCheck: CheckResult
  readonly harnessExitCode: number | null
}

export interface DatabaseSnapshot {
  readonly groups: number
  readonly occurrences: number
  readonly samples: number
}

/* AuthGuard returns 401 without a token. A fake Bearer token reaches
 * UserAuthService; an unreachable auth gateway produces a 503 response. */
export async function waitForTargetHealthy(child: ChildProcess | undefined, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = '健康檢查尚未成功'
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`pnpm dev 已結束 (code=${child.exitCode})`)
    if (child?.signalCode !== null && child?.signalCode !== undefined) throw new Error(`pnpm dev 已結束 (signal=${child.signalCode})`)
    const [api, frontend] = await Promise.all([probe('http://127.0.0.1:3001/health'), probe('http://localhost:5021')])
    if (api && frontend) return 'API /health 與前端 HTTP 皆可連線'
    last = `API=${api ? 'ready' : 'waiting'}, frontend=${frontend ? 'ready' : 'waiting'}`
    await pause(500)
  }
  throw new Error(`目標專案 dev 健康檢查逾時 (${last})`)
}

export async function verifyServerFiveHundred(pool: Pool): Promise<ServerErrorCheck> {
  const statuses: number[] = []
  for (let index = 0; index < 3; index++) {
    const response = await fetch(SERVER_ENDPOINT, {
      headers: { authorization: 'Bearer yeschef-error-intake-fake-token' },
      signal: AbortSignal.timeout(15_000),
    })
    statuses.push(response.status)
    await response.arrayBuffer()
    if (index < 2) await pause(1_100)
  }
  // 錯誤是非同步寫入的：回應先回來，寫入稍後才完成。等筆數穩定再判斷。
  await settledSnapshot(pool, 'server')
  const rows = await queryRows(pool, `SELECT g.id, g.source, g.count,
    (SELECT COUNT(*) FROM error_intake_test.error_event e WHERE e.group_id = g.id) AS samples
    FROM error_intake_test.error_group g WHERE g.project = ? AND g.source = 'server'`, ['demo-app'])
  const groupCount = rows.length
  const occurrenceCount = rows.reduce((sum, row) => sum + numberValue(row['count']), 0)
  const sampleCount = rows.reduce((sum, row) => sum + numberValue(row['samples']), 0)
  const ok = statuses.length === 3 && statuses.every((status) => status >= 500 && status < 600) &&
    groupCount === 1 && occurrenceCount === 3 && sampleCount === 3 && rows[0]?.['source'] === 'server'
  return {
    check: { check: 'spec-11-4-backend-5xx', ok, detail: JSON.stringify({ statuses, groupCount, occurrenceCount, sampleCount, source: rows[0]?.['source'] }) },
    statuses, groupCount, occurrenceCount, sampleCount,
  }
}

export async function verifyFourHundredNotCollected(pool: Pool): Promise<CheckResult> {
  const before = await settledSnapshot(pool, 'server')
  const response = await fetch(SERVER_ENDPOINT, { signal: AbortSignal.timeout(15_000) })
  await response.arrayBuffer()
  // 給可能的非同步寫入足夠時間；若 4xx 被記錄，這段時間內一定會出現。
  await pause(3_000)
  const after = await settledSnapshot(pool, 'server')
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  return {
    check: 'spec-11-5-4xx-not-collected',
    ok: response.status === 401 && unchanged,
    detail: JSON.stringify({ status: response.status, before, after }),
  }
}

export async function verifyBrowserError(
  pool: Pool,
  harnessPath: string,
  browserUserData: string,
  marker: string,
  secrets: readonly string[],
): Promise<BrowserCheck> {
  const harnessExitCode = await runBrowserWindow(harnessPath, browserUserData, marker)
  const rows = await waitForBrowserRows(pool, marker)
  const databaseRows = await allErrorContent(pool)
  const hasRawValues = REQUIRED_MASK_VALUES.some((secret) => databaseRows.some((value) => value.includes(secret)))
  const detail = JSON.stringify({ rows: rows.length, hasRawValues, harnessExitCode })
  return {
    sourceCheck: { check: 'spec-11-6-browser-error', ok: rows.length > 0 && rows.some((row) => row['source'] === 'browser') && harnessExitCode === 0, detail },
    maskingCheck: { check: 'spec-11-7-browser-mask', ok: rows.length > 0 && !hasRawValues && harnessExitCode === 0, detail: redactSensitiveText(detail, secrets) },
    harnessExitCode,
  }
}

/** 主廚設定給 installErrorReporter 的接收端點，換成前端同源的完整網址；找不到回 undefined。 */
export async function receiverEndpoint(worktreePath: string): Promise<string | undefined> {
  const files = await new Promise<string[]>((resolveFiles) => {
    const child = spawn('git', ['-C', worktreePath, 'grep', '-l', 'installErrorReporter', '--', 'apps'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('close', () => resolveFiles(out.split('\n').filter((line) => line.trim() !== '')))
  })
  for (const file of files) {
    const endpoint = extractReporterEndpoint(await readFile(join(worktreePath, file), 'utf8'))
    if (endpoint !== undefined) return `${FRONTEND_ORIGIN}${endpoint}`
  }
  return undefined
}

export async function verifyReceiverRateLimit(endpoint: string): Promise<CheckResult> {
  await waitForNextMinute()
  const statuses: number[] = []
  for (let index = 0; index < 31; index++) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    })
    statuses.push(response.status)
    await response.arrayBuffer()
  }
  const ok = statuses.slice(0, 30).every((status) => status === 204) && statuses[30] === 429
  return {
    check: 'spec-11-8-receiver-rate-limit',
    ok,
    detail: JSON.stringify({ requestCount: statuses.length, firstThirty429Count: statuses.slice(0, 30).filter((status) => status === 429).length, status31: statuses[30] }),
  }
}

export async function verifyOversizedBody(pool: Pool, endpoint: string): Promise<CheckResult> {
  await waitForNextMinute()
  const marker = `EI_OVERSIZE_${Date.now()}`
  const before = await databaseSnapshot(pool, 'browser')
  const report = {
    errorType: 'Error', message: `${marker}${'x'.repeat(900)}`, stack: 'x'.repeat(8_000), route: '/oversize',
  }
  const body = `${' '.repeat(8_000)}${JSON.stringify(report)}`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  await response.arrayBuffer()
  const after = await databaseSnapshot(pool, 'browser')
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  return {
    check: 'spec-11-8-oversized-body',
    ok: Buffer.byteLength(body, 'utf8') > 16 * 1024 && response.status === 204 && unchanged,
    detail: JSON.stringify({ requestBytes: Buffer.byteLength(body, 'utf8'), status: response.status, before, after }),
  }
}

export async function runBrowserWindow(harnessPath: string, userData: string, marker: string): Promise<number | null> {
  await mkdir(userData, { recursive: true })
  const executable = electronExecutable()
  return await new Promise<number | null>((resolveExit) => {
    const child = spawn(executable, [harnessPath], {
      cwd: ROOT,
      env: browserEnvironment(userData, marker),
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    child.once('error', () => resolveExit(null))
    child.once('exit', (code) => resolveExit(code))
    setTimeout(() => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      }
    }, 45_000).unref()
  })
}

/** 連續兩次讀到相同的筆數才回傳，最多等 10 秒。 */
export async function settledSnapshot(pool: Pool, source: 'server' | 'browser'): Promise<DatabaseSnapshot> {
  let previous = await databaseSnapshot(pool, source)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await pause(700)
    const current = await databaseSnapshot(pool, source)
    if (JSON.stringify(current) === JSON.stringify(previous)) return current
    previous = current
  }
  return previous
}

export async function databaseSnapshot(pool: Pool, source: 'server' | 'browser'): Promise<DatabaseSnapshot> {
  const [rows] = await pool.query(`SELECT COUNT(*) AS groups_total, COALESCE(SUM(count), 0) AS occurrences_total,
    (SELECT COUNT(*) FROM error_intake_test.error_event e JOIN error_intake_test.error_group g2 ON g2.id = e.group_id WHERE g2.project = ? AND g2.source = ?) AS samples_total
    FROM error_intake_test.error_group WHERE project = ? AND source = ?`, ['demo-app', source, 'demo-app', source])
  const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
  return {
    groups: numberValue(row?.['groups_total']),
    occurrences: numberValue(row?.['occurrences_total']),
    samples: numberValue(row?.['samples_total']),
  }
}

async function waitForBrowserRows(pool: Pool, marker: string): Promise<readonly Record<string, unknown>[]> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const rows = await queryRows(pool, `SELECT g.source, g.error_type, g.message, g.top_frame, g.route,
      e.message AS event_message, e.stack AS event_stack, e.release_tag, e.user_agent
      FROM error_intake_test.error_group g LEFT JOIN error_intake_test.error_event e ON e.group_id = g.id
      WHERE g.project = ? AND g.source = 'browser' AND LOCATE(?, g.message) > 0`, ['demo-app', marker])
    if (rows.length > 0) return rows
    await pause(250)
  }
  return []
}

async function queryRows(pool: Pool, sql: string, values: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
  const [rows] = await pool.query(sql, [...values])
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : []
}

async function allErrorContent(pool: Pool): Promise<readonly string[]> {
  const rows = await queryRows(pool, `SELECT CONCAT_WS('\\n', g.project, g.environment, g.fingerprint, g.source,
    g.error_type, g.message, g.top_frame, g.route, g.status_note, e.message, e.stack, e.release_tag,
    e.user_agent, e.request_method, e.status_code) AS content
    FROM error_intake_test.error_group g LEFT JOIN error_intake_test.error_event e ON e.group_id = g.id`, [])
  return rows.flatMap((row) => typeof row['content'] === 'string' ? [row['content']] : [])
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForNextMinute(): Promise<void> {
  const remaining = 60_000 - (Date.now() % 60_000)
  await pause(remaining + 100)
}

function electronExecutable(): string {
  const requireFromRepo = createRequire(join(ROOT, 'package.json'))
  const path = requireFromRepo('electron') as unknown
  if (typeof path !== 'string' || path === '') throw new Error('無法解析 Electron 執行檔路徑')
  return path
}

function browserEnvironment(userData: string, marker: string): NodeJS.ProcessEnv {
  const { EI_TEST_DB_ROOT_URL: _databaseUrl, ...safeEnvironment } = process.env
  return { ...safeEnvironment, EI_BROWSER_USER_DATA: userData, EI_BROWSER_MARKER: marker }
}

function numberValue(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function pause(ms: number): Promise<void> {
  return new Promise((resolvePause) => { setTimeout(resolvePause, ms) })
}
