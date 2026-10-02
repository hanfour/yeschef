import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Pool } from 'mysql2/promise'
import { allChecksPassed, redactSensitiveText, validateRunLabel, type AcceptanceCheck } from './error-intake-acceptance-helpers.js'
import {
  clearErrorRows, createDatabasePool, createTargetWorktree, installTargetDependencies,
  readConfig, readConfiguredEnvironment, releaseWorktreePorts, resetTestDatabase,
  startTargetDev, stopProcessGroup, validateInputs, type AcceptanceConfig, type WorktreeInfo,
} from './error-intake-acceptance-runtime.js'
import {
  receiverEndpoint, verifyBrowserError, verifyFourHundredNotCollected, verifyOversizedBody, verifyReceiverRateLimit,
  verifyServerFiveHundred, waitForTargetHealthy, type BrowserCheck, type ServerErrorCheck,
} from './error-intake-acceptance-checks.js'
import {
  ghPullRequestState, launchAcceptanceApp, readTaskAndGroupEvidence, waitForChefTask,
  type ApprovalRecord, type ChefEvidence,
} from './error-intake-acceptance-ui.js'
import { setupDatabaseAndEnable } from './error-intake-acceptance-form.js'
import { cleanup, type RuntimeContext } from './group-acceptance-runtime.js'
import { readTasks } from './group-acceptance-state.js'

declare const __dirname: string

const ROOT = resolve(__dirname, '..')
const BROWSER_HARNESS = join(ROOT, '.spike-out/error-intake-browser-window.cjs')
const CHECK_ORDER = [
  'preflight-inputs', 'test-database-reset', 'target-project-worktree', 'target-project-dependency-install',
  'target-project-orm-generate', 'yeschef-database-and-enable-ui', 'target-project-env-variable-names',
  'target-project-dev-port-ownership', 'target-project-dev-health', 'spec-11-3-enable-and-draft-pr',
  'spec-11-4-backend-5xx', 'spec-11-5-4xx-not-collected', 'spec-11-6-browser-error',
  'spec-11-7-browser-mask', 'spec-11-8-oversized-body', 'spec-11-8-receiver-rate-limit', 'cleanup',
] as const

interface RunReport {
  readonly runLabel: string
  readonly startedAt: string
  finishedAt?: string
  worktreePath?: string
  devPid?: number
  devStopped?: boolean
  yeschefClosed?: boolean
  chef?: ChefEvidence
  pullRequest?: { readonly url?: string; readonly isDraft: boolean; readonly headRefName?: string; readonly state?: string; readonly error?: string }
  configuredEnvMissingNames?: readonly string[]
  checks: readonly AcceptanceCheck[]
}

interface RunState {
  readonly outputPath: string
  readonly report: RunReport
  readonly checks: Map<string, AcceptanceCheck>
  readonly record: (check: string, ok: boolean, detail: unknown) => void
  config?: AcceptanceConfig
  database?: Pool
  worktree?: WorktreeInfo
  appContext?: RuntimeContext
  devProcess?: ChildProcess
  task?: ChefEvidence
  priorTaskIds: readonly string[]
  approvals: readonly ApprovalRecord[]
  invalidEnvFileApproval: boolean
  secretValues: readonly string[]
  failure?: string
  serverCheck?: ServerErrorCheck
  browserCheck?: BrowserCheck
}

async function main(): Promise<void> {
  const state = createRunState()
  try { await executeAcceptance(state) } catch (error) { state.failure = safeFailure(error, state.secretValues) }
  await finishRun(state)
  for (const check of state.report.checks) process.stdout.write(`${JSON.stringify(check)}\n`)
  process.stdout.write(`${JSON.stringify({ check: 'worktree-path', ok: state.worktree !== undefined, detail: state.worktree?.path ?? '尚未建立' })}\n`)
  process.exitCode = allChecksPassed(state.report.checks) ? 0 : 1
}

function createRunState(): RunState {
  const rawLabel = process.env['RUN_LABEL']
  const runLabel = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(rawLabel ?? '') ? rawLabel as string : 'invalid-run-label'
  const report: RunReport = { runLabel, startedAt: new Date().toISOString(), checks: [] }
  const checks = new Map<string, AcceptanceCheck>()
  const state: RunState = {
    outputPath: join(ROOT, '.spike-out/error-intake', `${runLabel}.json`),
    report,
    checks,
    record: (check, ok, detail) => {
      const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
      checks.set(check, { check, ok, detail: redactSensitiveText(text ?? '', state.secretValues) })
    },
    priorTaskIds: [],
    approvals: [],
    invalidEnvFileApproval: false,
    secretValues: [],
  }
  return state
}

async function executeAcceptance(state: RunState): Promise<void> {
  state.config = readConfig(process.env)
  state.secretValues = state.config.secretValues
  delete process.env['EI_TEST_DB_ROOT_URL']
  validateRunLabel(state.config.runLabel)
  await validateInputs(state.config)
  state.record('preflight-inputs', true, { runLabel: state.config.runLabel, databaseName: 'error_intake_test', taskTimeoutMinutes: state.config.timeoutMinutes })
  state.database = createDatabasePool(state.config.database)
  // EI_REUSE_WORKTREE：只對主廚已裝好的 worktree 重跑交叉驗證，不重建資料庫、不再跑主廚（主廚安裝一輪要一小時以上）。
  const reuse = process.env['EI_REUSE_WORKTREE']
  if (reuse !== undefined && reuse !== '') {
    const path = await realpath(reuse)
    state.worktree = { parentDir: dirname(path), path }
    state.report.worktreePath = state.worktree.path
    state.record('reuse-worktree', true, { path: state.worktree.path, note: '只跑交叉驗證，不算一輪完整驗收' })
  } else {
    await resetTestDatabase(state.database)
    state.record('test-database-reset', true, 'error_intake_test 已刪除並重建')
    await prepareWorktree(state)
    await enableChef(state)
  }
  await verifyWorktreeEnvironmentAndPorts(state)
  await runTargetProjectDevChecks(state)
  recordEnableResult(state)
}

async function prepareWorktree(state: RunState): Promise<void> {
  const config = requiredConfig(state)
  state.worktree = await createTargetWorktree(config, (created) => {
    state.worktree = created
    state.report.worktreePath = created.path
  })
  state.record('target-project-worktree', true, { path: state.worktree.path, base: 'origin/main', envCopied: config.targetEnvFile })
  const results = await installTargetDependencies(state.worktree.path)
  state.record('target-project-dependency-install', results[0]?.code === 0, commandDetail(results[0]))
  if (results[0]?.code !== 0) throw new Error('pnpm install --frozen-lockfile 失敗')
  state.record('target-project-orm-generate', results[1]?.code === 0, commandDetail(results[1]))
  if (results[1]?.code !== 0) throw new Error('pnpm prisma:generate 失敗')
}

async function enableChef(state: RunState): Promise<void> {
  const config = requiredConfig(state)
  const worktree = requiredWorktree(state)
  state.appContext = await launchAcceptanceApp(worktree.path)
  state.priorTaskIds = await setupDatabaseAndEnable(state.appContext, config)
  state.record('yeschef-database-and-enable-ui', true, '資料庫可連線、schema 版本 1，已由 UI 啟用目標專案')
  state.task = await waitForChefTask(
    state.appContext, state.priorTaskIds, worktree.path, config,
    (line) => { process.stdout.write(`${redactSensitiveText(line, state.secretValues)}\n`) },
    (approvals, invalid) => { state.approvals = approvals; state.invalidEnvFileApproval ||= invalid },
  )
  state.report.chef = state.task
  await recordPullRequest(state, state.task)
}

async function recordPullRequest(state: RunState, task: ChefEvidence): Promise<void> {
  const prState = await ghPullRequestState(task.pullRequestUrl)
  state.report.pullRequest = { ...(task.pullRequestUrl === undefined ? {} : { url: task.pullRequestUrl }), ...prState }
}

async function verifyWorktreeEnvironmentAndPorts(state: RunState): Promise<void> {
  const worktree = requiredWorktree(state)
  const config = requiredConfig(state)
  const envCheck = await readConfiguredEnvironment(join(worktree.path, config.targetEnvFile))
  state.report.configuredEnvMissingNames = envCheck.missing
  state.record('target-project-env-variable-names', envCheck.missing.length === 0, { file: config.targetEnvFile, missingNames: envCheck.missing })
  const stoppedPids = await releaseWorktreePorts(worktree.path, [3001, 5021])
  state.record('target-project-dev-port-ownership', true, { ports: [3001, 5021], stoppedWorktreePids: stoppedPids })
  if (envCheck.missing.length > 0) throw new Error(`TARGET_ENV_FILE 缺少變數名稱：${envCheck.missing.join(', ')}`)
  await clearErrorRows(requiredDatabase(state))
}

async function runTargetProjectDevChecks(state: RunState): Promise<void> {
  state.devProcess = startTargetDev(requiredWorktree(state).path)
  if (state.devProcess.pid === undefined) throw new Error('pnpm dev 沒有 PID')
  state.report.devPid = state.devProcess.pid
  const health = await waitForTargetHealthy(state.devProcess)
  state.record('target-project-dev-health', true, { pid: state.devProcess.pid, health })
  await verifyBackendChecks(state)
  await verifyBrowserAndReceiverChecks(state)
}

async function verifyBackendChecks(state: RunState): Promise<void> {
  const database = requiredDatabase(state)
  state.serverCheck = await verifyServerFiveHundred(database)
  state.record(state.serverCheck.check.check, state.serverCheck.check.ok, state.serverCheck.check.detail)
  const fourxx = await verifyFourHundredNotCollected(database)
  state.record(fourxx.check, fourxx.ok, fourxx.detail)
}

async function verifyBrowserAndReceiverChecks(state: RunState): Promise<void> {
  // 瀏覽器視窗用 worktree 旁的獨立目錄，不依賴暫時的 yeschef（只跑交叉驗證時沒有它）。
  const browserUserData = join(requiredWorktree(state).parentDir, 'browser-user-data')
  state.browserCheck = await verifyBrowserError(
    requiredDatabase(state), BROWSER_HARNESS, browserUserData,
    `EI_BROWSER_${requiredConfig(state).runLabel}_${randomUUID()}`, state.secretValues,
  )
  state.record(state.browserCheck.sourceCheck.check, state.browserCheck.sourceCheck.ok, state.browserCheck.sourceCheck.detail)
  state.record(state.browserCheck.maskingCheck.check, state.browserCheck.maskingCheck.ok, state.browserCheck.maskingCheck.detail)
  // 接收端點的路徑由主廚依專案 proxy 決定，從 worktree 讀出實際設定。
  const endpoint = state.worktree === undefined ? undefined : await receiverEndpoint(state.worktree.path)
  state.record('receiver-endpoint', endpoint !== undefined, endpoint ?? '前端找不到 installErrorReporter 的 endpoint 設定')
  if (endpoint === undefined) return
  const oversized = await verifyOversizedBody(requiredDatabase(state), endpoint)
  state.record(oversized.check, oversized.ok, oversized.detail)
  const rateLimit = await verifyReceiverRateLimit(endpoint)
  state.record(rateLimit.check, rateLimit.ok, rateLimit.detail)
}

function recordEnableResult(state: RunState): void {
  const task = state.task
  if (task === undefined) return
  const configureCalls = task.approvalRecords.filter((approval) => approval.toolName === 'configure_error_intake_env')
  const serverOk = state.serverCheck?.check.ok === true
  const browserOk = state.browserCheck?.sourceCheck.ok === true && state.browserCheck.maskingCheck.ok
  const ok = task.status === 'completed' && task.checkErrorIntake.called && task.checkErrorIntake.returnedMoreThanZero &&
    configureCalls.some((approval) => approval.decision === 'allowed' && approval.envFileCheck?.includes('git check-ignore passed')) &&
    !task.invalidEnvFileApproval && state.report.configuredEnvMissingNames?.length === 0 &&
    state.report.pullRequest?.isDraft === true && serverOk && browserOk
  state.record('spec-11-3-enable-and-draft-pr', ok, {
    taskStatus: task.status, reason: task.reason, report: task.report, attempts: task.attempts,
    groupMessages: task.messages, checkErrorIntake: task.checkErrorIntake, approvals: task.approvalRecords,
    invalidEnvFileApproval: task.invalidEnvFileApproval, envVariablesPresent: state.report.configuredEnvMissingNames?.length === 0,
    pullRequest: state.report.pullRequest, crossChecks: { backend5xx: serverOk, browserAndMasking: browserOk },
  })
}

async function finishRun(state: RunState): Promise<void> {
  await capturePartialChefEvidence(state)
  await cleanupProcesses(state)
  await closeDatabase(state)
  if (state.checks.get('cleanup') === undefined) state.record('cleanup', true, '目標專案 dev 與暫時 yeschef 已關閉')
  state.report.finishedAt = new Date().toISOString()
  state.report.checks = CHECK_ORDER.map((name) => state.checks.get(name) ?? {
    check: name,
    ok: false,
    detail: `未執行；${state.failure ?? '前置流程未完成'}`,
  })
  await writeReport(state.outputPath, state.report, state.secretValues)
}

async function capturePartialChefEvidence(state: RunState): Promise<void> {
  const context = state.appContext
  if (context === undefined || state.task !== undefined) return
  const tasks = await readTasks(context).catch(() => [])
  const candidate = tasks.find((task) => !state.priorTaskIds.includes(task.id) && task.goal.includes('安裝並設定錯誤收集'))
  state.task = await readTaskAndGroupEvidence(context, candidate?.id, state.approvals, state.invalidEnvFileApproval, state.secretValues).catch(() => undefined)
  if (state.task === undefined) return
  state.report.chef = state.task
  await recordPullRequest(state, state.task)
  recordEnableResult(state)
}

async function cleanupProcesses(state: RunState): Promise<void> {
  if (state.devProcess !== undefined) await cleanupDevProcess(state)
  if (state.appContext !== undefined) await cleanupYesChef(state)
}

async function cleanupDevProcess(state: RunState): Promise<void> {
  try {
    await stopProcessGroup(state.devProcess)
    state.report.devStopped = true
  } catch (error) {
    state.report.devStopped = false
    state.record('cleanup', false, `demo-app dev 行程群組結束失敗：${safeFailure(error, state.secretValues)}`)
  }
}

async function cleanupYesChef(state: RunState): Promise<void> {
  try {
    await cleanup(state.appContext)
    state.report.yeschefClosed = true
  } catch (error) {
    state.report.yeschefClosed = false
    state.record('cleanup', false, `暫時 yeschef 關閉失敗：${safeFailure(error, state.secretValues)}`)
  }
}

async function closeDatabase(state: RunState): Promise<void> {
  if (state.database === undefined) return
  await state.database.end().catch(() => { state.record('cleanup', false, 'MySQL pool 關閉失敗') })
}

async function writeReport(path: string, report: RunReport, secrets: readonly string[]): Promise<void> {
  await mkdir(join(ROOT, '.spike-out/error-intake'), { recursive: true })
  const text = redactSensitiveText(JSON.stringify(report, null, 2), secrets)
  await writeFile(path, `${text}\n`, { encoding: 'utf8', mode: 0o600 })
}

function commandDetail(result: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly errorCode?: string } | undefined): unknown {
  return result === undefined ? { code: null, error: 'command result missing' } : {
    code: result.code,
    signal: result.signal,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  }
}

function requiredConfig(state: RunState): AcceptanceConfig {
  if (state.config === undefined) throw new Error('驗收設定尚未讀取')
  return state.config
}

function requiredWorktree(state: RunState): WorktreeInfo {
  if (state.worktree === undefined) throw new Error('目標專案 worktree 尚未建立')
  return state.worktree
}

function requiredDatabase(state: RunState): Pool {
  if (state.database === undefined) throw new Error('MySQL 測試連線尚未建立')
  return state.database
}

function safeFailure(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'UnknownError'
  return redactSensitiveText(message, secrets).slice(0, 600)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeFailure(error, [])}\n`)
  process.exitCode = 1
})
