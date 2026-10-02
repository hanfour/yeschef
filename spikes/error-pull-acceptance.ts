import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Pool } from 'mysql2/promise'
import { allChecksPassed, validateRunLabel, type AcceptanceCheck } from './error-intake-acceptance-helpers.js'
import {
  createDatabasePool, createTargetWorktree, installTargetDependencies, readConfig, resetTestDatabase,
  validateInputs, type AcceptanceConfig, type WorktreeInfo,
} from './error-intake-acceptance-runtime.js'
import { insertErrorPullFixtures, readErrorGroupStates, verifyErrorPullFixtures, waitForErrorGroupWriteback } from './error-pull-acceptance-database.js'
import { setupDatabaseAndEnable } from './error-intake-acceptance-form.js'
import {
  launchAcceptanceApp, readTaskAndGroupEvidence, type ChefEvidence,
} from './error-intake-acceptance-ui.js'
import { cleanup, delay, type RuntimeContext } from './group-acceptance-runtime.js'
import { ulidFromParts, createErrorPullFixtures, compareRemoteChanges, inspectErrorFixGoal, parseNoPullRequestResults,
  parsePullRequestList, parseRemoteBranches, redactAcceptanceText, type ErrorPullFixtures, type RemoteChangeSnapshot } from './error-pull-acceptance-fixtures.js'
import {
  cancelSetupTask, cancelTimedOutTask, handleApprovalCards, openErrorPullAndStartTask, readChefTasks, recordExpectedToolFailures,
  type ErrorPullApprovalRecord, type SetupCancellationEvidence,
} from './error-pull-acceptance-ui.js'

declare const __dirname: string

const ROOT = resolve(__dirname, '..')
const CHECK_ORDER = [
  'preflight-inputs', 'remote-baseline', 'test-database-reset', 'target-project-worktree', 'target-project-dependency-install',
  'target-project-orm-generate', 'yeschef-database-and-enable-ui', 'setup-task-cancelled', 'setup-worktree-released',
  'error-groups-seeded', 'pull-dialog-selection', 'error-fix-purpose-and-status', 'error-fix-completed-report',
  'prohibited-tool-approvals-failed', 'error-groups-writeback', 'remote-branches-unchanged', 'remote-pull-requests-unchanged', 'task-goal-safe', 'cleanup',
] as const

interface RunReport {
  readonly runLabel: string
  readonly startedAt: string
  finishedAt?: string
  worktreePath?: string
  yeschefClosed?: boolean
  setupTask?: { readonly id?: string; readonly status: string; readonly ipcStatus: string; readonly approvals: readonly ErrorPullApprovalRecord[]; readonly evidence?: ChefEvidence }
  errorFixTask?: { readonly id?: string; readonly status: string; readonly timedOut: boolean; readonly report?: string; readonly approvals: readonly ErrorPullApprovalRecord[]; readonly evidence?: ChefEvidence }
  remoteBefore?: RemoteChangeSnapshot
  remoteAfter?: RemoteChangeSnapshot
  groupIds?: readonly string[]
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
  fixtures?: ErrorPullFixtures
  setup?: SetupCancellationEvidence
  fixTask?: Awaited<ReturnType<typeof readChefTasks>>[number]
  fixTimedOut: boolean
  fixApprovals: ErrorPullApprovalRecord[]
  remoteBefore?: RemoteChangeSnapshot
  failure?: string
}

async function main(): Promise<void> {
  const state = createRunState()
  try { await execute(state) } catch (error) { state.failure = safeFailure(error, state.config?.secretValues ?? []) }
  await finish(state)
  for (const check of state.report.checks) process.stdout.write(`${JSON.stringify(check)}\n`)
  process.stdout.write(`${JSON.stringify({ check: 'worktree-path', ok: state.worktree !== undefined, detail: state.worktree?.path ?? '尚未建立' })}\n`)
  process.exitCode = allChecksPassed(state.report.checks) ? 0 : 1
}

function createRunState(): RunState {
  const rawLabel = process.env['RUN_LABEL']
  const runLabel = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(rawLabel ?? '') ? rawLabel as string : 'invalid-run-label'
  const checks = new Map<string, AcceptanceCheck>()
  const state: RunState = {
    outputPath: join(ROOT, '.spike-out/error-pull', `${runLabel}.json`),
    report: { runLabel, startedAt: new Date().toISOString(), checks: [] }, checks,
    record: (check, ok, detail) => checks.set(check, { check, ok, detail: safeText(toText(detail), state.config?.secretValues ?? []) }),
    fixTimedOut: false, fixApprovals: [],
  }
  return state
}

async function execute(state: RunState): Promise<void> {
  state.config = readConfig(process.env)
  delete process.env['EI_TEST_DB_ROOT_URL']
  validateRunLabel(state.config.runLabel)
  await validateInputs(state.config)
  state.record('preflight-inputs', true, { runLabel: state.config.runLabel, databaseName: 'error_intake_test', taskTimeoutMinutes: state.config.timeoutMinutes })
  state.remoteBefore = await readRemoteSnapshot(state.config.targetRepo, state.config.targetGithubRepo)
  state.report.remoteBefore = state.remoteBefore
  state.record('remote-baseline', true, summarizeRemote(state.remoteBefore))
  state.database = createDatabasePool(state.config.database)
  await resetTestDatabase(state.database)
  state.record('test-database-reset', true, 'error_intake_test 已刪除並重建')
  await prepareWorktree(state)
  await enableAndCancelSetup(state)
  await runErrorPull(state)
  await capturePostRunChecks(state)
}

async function prepareWorktree(state: RunState): Promise<void> {
  const config = requiredConfig(state)
  state.worktree = await createTargetWorktree(config, (created) => {
    state.worktree = created
    state.report.worktreePath = created.path
  })
  state.record('target-project-worktree', true, { path: state.worktree.path, base: 'origin/main', envCopied: config.targetEnvFile })
  const results = await installTargetDependencies(state.worktree.path)
  state.record('target-project-dependency-install', results[0]?.code === 0, commandResult(results[0]))
  if (results[0]?.code !== 0) throw new Error('pnpm install --frozen-lockfile 失敗')
  state.record('target-project-orm-generate', results[1]?.code === 0, commandResult(results[1]))
  if (results[1]?.code !== 0) throw new Error('pnpm prisma:generate 失敗')
}

async function enableAndCancelSetup(state: RunState): Promise<void> {
  const context = await launchAcceptanceApp(requiredWorktree(state).path)
  state.appContext = context
  const priorTaskIds = await setupDatabaseAndEnable(context, requiredConfig(state))
  state.record('yeschef-database-and-enable-ui', true, '資料庫已由 UI 初始化，目標專案已由 UI 啟用')
  state.setup = await cancelSetupTask(context, priorTaskIds, requiredConfig(state))
  const setup = state.setup
  const stopped = ['cancelled', 'blocked'].includes(setup.task.status)
  const denied = setup.approvals.every((approval) => approval.decision === 'denied' && approval.phase === 'setup')
  state.report.setupTask = {
    id: setup.task.id, status: setup.task.status, ipcStatus: setup.ipcStatus, approvals: setup.approvals,
    evidence: await readTaskAndGroupEvidence(context, setup.task.id, setup.approvals, false, requiredConfig(state).secretValues),
  }
  // 停止回應當下任務可能還在「等執行者確認停止」（blocked），稍後才變成 cancelled；兩次都是停止狀態即可。
  // 工作目錄是否已釋放，由後面能否開出修錯誤任務驗證。
  const ipcStopped = ['cancelled', 'blocked'].includes(setup.ipcStatus)
  state.record('setup-task-cancelled', stopped && ipcStopped && denied && setup.noPendingApprovals, {
    taskId: setup.task.id, status: setup.task.status, ipcStatus: setup.ipcStatus, approvalsDenied: denied, noPendingApprovals: setup.noPendingApprovals,
  })
  if (!stopped || !ipcStopped) throw new Error('安裝用主廚任務未經 IPC 確認停止')
}

async function runErrorPull(state: RunState): Promise<void> {
  const config = requiredConfig(state)
  const context = requiredContext(state)
  const now = Date.now()
  const groupIds = [newUlid(now), newUlid(now)] as const
  const eventIds = [newUlid(now), newUlid(now), newUlid(now), newUlid(now)] as const
  state.fixtures = createErrorPullFixtures(now, groupIds, eventIds)
  state.report.groupIds = groupIds
  await insertErrorPullFixtures(requiredDatabase(state), state.fixtures)
  state.record('error-groups-seeded', await verifyErrorPullFixtures(requiredDatabase(state), state.fixtures), { groupIds, samplesPerGroup: 2 })
  const task = await openErrorPullAndStartTask(context, groupIds, [state.setup?.task.id ?? ''])
  state.fixTask = task
  state.record('pull-dialog-selection', task !== undefined, { environment: 'local', selectedGroupIds: groupIds, taskId: task?.id ?? 'not-started' })
  if (task === undefined) throw new Error('拉錯誤 UI 沒有建立包含兩群資料的 error-fix 任務')
  const rowsAtStart = await readErrorGroupStates(requiredDatabase(state), groupIds)
  const startedStatus = rowsAtStart.length === 2 && rowsAtStart.every((row) => row.status === 'in_progress' && row.statusNote?.includes(task.id) === true)
  const purposeOk = task.purpose === 'error-fix' && resolve(task.cwd) === resolve(requiredWorktree(state).path)
  state.record('error-fix-purpose-and-status', purposeOk && startedStatus, {
    taskId: task.id, purpose: task.purpose ?? 'missing', taskCwdMatchesWorktree: resolve(task.cwd) === resolve(requiredWorktree(state).path),
    groups: rowsAtStart.map((row) => ({ id: row.id, status: row.status, noteHasTaskId: row.statusNote?.includes(task.id) === true })),
  })
  const setupReleased = ['cancelled', 'blocked'].includes(state.setup?.task.status ?? '') && purposeOk && task.id !== state.setup?.task.id
  state.record('setup-worktree-released', setupReleased, { setupStatus: state.setup?.task.status, newTaskId: task.id, cwdMatchesWorktree: purposeOk })
  await waitForErrorFix(state, task.id)
}

async function waitForErrorFix(state: RunState, taskId: string): Promise<void> {
  const context = requiredContext(state)
  const config = requiredConfig(state)
  const handled = new Set<string>()
  const deadline = Date.now() + config.timeoutMinutes * 60_000
  let lastProgressAt = Date.now()
  while (Date.now() < deadline) {
    await handleApprovalCards(context, 'error-fix', state.fixApprovals, handled, config.secretValues)
    state.fixTask = (await readChefTasks(context)).find((task) => task.id === taskId) ?? state.fixTask
    if (state.fixTask !== undefined && isTerminal(state.fixTask.status)) break
    if (Date.now() - lastProgressAt >= 30_000) {
      process.stdout.write(`${safeText(JSON.stringify(progress(state.fixTask, state.fixApprovals.length)), config.secretValues)}\n`)
      lastProgressAt = Date.now()
    }
    await delay(1_000)
  }
  state.fixTask = (await readChefTasks(context)).find((task) => task.id === taskId) ?? state.fixTask
  state.fixTimedOut = state.fixTask !== undefined && !isTerminal(state.fixTask.status)
  if (state.fixTimedOut) {
    state.record('error-fix-completed-report', false, { taskId, status: state.fixTask?.status, timedOut: true })
    state.fixTask = await cancelTimedOutTask(context, taskId, state.fixApprovals, config.secretValues) ?? state.fixTask
  }
  await handleApprovalCards(context, 'error-fix', state.fixApprovals, handled, config.secretValues)
  state.fixApprovals = [...recordExpectedToolFailures(state.fixTask, state.fixApprovals)]
  const evidence = await readTaskAndGroupEvidence(context, taskId, state.fixApprovals, false, config.secretValues)
  state.report.errorFixTask = {
    id: taskId, status: state.fixTask?.status ?? 'missing', timedOut: state.fixTimedOut,
    report: state.fixTask?.report?.summary, approvals: state.fixApprovals, evidence,
  }
  if (!state.fixTimedOut) {
    const results = parseNoPullRequestResults(state.fixTask?.report?.summary ?? '', requiredGroupIds(state))
    const reportOk = state.fixTask?.status === 'completed' && results.length === 2 &&
      results.every((result) => result.noPullRequest && result.reason.trim() !== '')
    state.record('error-fix-completed-report', reportOk, { taskId, status: state.fixTask?.status ?? 'missing', results })
  }
  const expectedDenials = state.fixApprovals.filter((approval) => approval.expectedFailure)
  state.record('prohibited-tool-approvals-failed', expectedDenials.every((approval) => approval.decision === 'denied' && approval.failureRecorded === true), {
    denied: expectedDenials.map((approval) => ({ toolName: approval.toolName, failureRecorded: approval.failureRecorded === true })),
  })
}

async function capturePostRunChecks(state: RunState): Promise<void> {
  const groupIds = requiredGroupIds(state)
  const task = state.fixTask
  const results = parseNoPullRequestResults(task?.report?.summary ?? '', groupIds)
  const expectedReasons = results.filter((result) => result.noPullRequest && result.reason !== '')
  const notes = task?.status === 'completed' && expectedReasons.length === groupIds.length
    ? await waitForErrorGroupWriteback(requiredDatabase(state), groupIds, task.id, expectedReasons)
    : await readErrorGroupStates(requiredDatabase(state), groupIds)
  const noteOk = task !== undefined && notes.length === groupIds.length && notes.every((row) => {
    const outcome = results.find((result) => result.groupId === row.id)
    return row.status === 'in_progress' && row.statusNote?.includes(task.id) === true &&
      outcome?.noPullRequest === true && outcome.reason !== '' && row.statusNote.includes(outcome.reason)
  })
  state.record('error-groups-writeback', noteOk, {
    taskId: task?.id ?? 'missing', groups: notes.map((row) => ({
      id: row.id, status: row.status, noteHasTaskId: row.statusNote?.includes(task?.id ?? '\u0000') === true,
      noteHasNoPrReason: results.some((result) => result.groupId === row.id && result.noPullRequest && result.reason !== '' && row.statusNote?.includes(result.reason)),
    })),
  })
  const goalSafety = inspectErrorFixGoal(task?.goal ?? '', groupIds, requiredConfig(state).secretValues)
  state.record('task-goal-safe', goalSafety.hasErrorData && goalSafety.hasAllGroupIds &&
    !goalSafety.hasDatabasePassword && !goalSafety.hasConnectionString, goalSafety)
}

async function readRemoteSnapshot(repo: string, githubRepo: string): Promise<RemoteChangeSnapshot> {
  const branches = spawnSync('git', ['-C', repo, 'ls-remote', '--heads', 'origin', 'fix/error-*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (branches.error !== undefined || branches.status !== 0) throw new Error('git ls-remote 讀取 fix/error-* 分支失敗')
  const prs = spawnSync('gh', ['pr', 'list', '--repo', githubRepo, '--state', 'all', '--search', 'head:fix/error-', '--json', 'number,url,headRefName', '--limit', '1000'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (prs.error !== undefined || prs.status !== 0) throw new Error('gh pr list 讀取 fix/error-* PR 失敗')
  return { branches: parseRemoteBranches(branches.stdout), pullRequests: parsePullRequestList(prs.stdout) }
}

function summarizeRemote(snapshot: RemoteChangeSnapshot): unknown {
  return { branchCount: snapshot.branches.length, pullRequests: snapshot.pullRequests.map((pr) => ({ number: pr.number, headRefName: pr.headRefName })) }
}

async function finish(state: RunState): Promise<void> {
  if (state.appContext !== undefined) {
    await cleanup(state.appContext).then(() => { state.report.yeschefClosed = true })
      .catch((error) => { state.report.yeschefClosed = false; state.record('cleanup', false, safeFailure(error, state.config?.secretValues ?? [])) })
  }
  await captureRemoteChecks(state)
  if (state.database !== undefined) await state.database.end().catch(() => { state.record('cleanup', false, 'MySQL pool 關閉失敗') })
  if (state.checks.get('cleanup') === undefined) state.record('cleanup', state.appContext === undefined || state.report.yeschefClosed === true, '暫時 yeschef 已關閉；目標專案 worktree 保留')
  state.report.finishedAt = new Date().toISOString()
  state.report.checks = CHECK_ORDER.map((check) => state.checks.get(check) ?? {
    check, ok: false, detail: `未執行；${state.failure ?? '前置流程未完成'}`,
  })
  await mkdir(dirname(state.outputPath), { recursive: true })
  const json = safeText(JSON.stringify(state.report, null, 2), state.config?.secretValues ?? [])
  await writeFile(state.outputPath, `${json}\n`, 'utf8')
}

async function captureRemoteChecks(state: RunState): Promise<void> {
  if (state.checks.has('remote-branches-unchanged')) return
  if (state.config === undefined) {
    state.record('remote-branches-unchanged', false, '驗收設定未初始化')
    state.record('remote-pull-requests-unchanged', false, '驗收設定未初始化')
    return
  }
  try {
    const config = requiredConfig(state)
    const after = await readRemoteSnapshot(config.targetRepo, config.targetGithubRepo)
    state.report.remoteAfter = after
    const before = state.remoteBefore
    const comparison = before === undefined ? { addedBranches: [], addedPullRequests: [], ok: false } : compareRemoteChanges(before, after)
    state.record('remote-branches-unchanged', before !== undefined && comparison.addedBranches.length === 0, comparison.addedBranches)
    state.record('remote-pull-requests-unchanged', before !== undefined && comparison.addedPullRequests.length === 0, comparison.addedPullRequests)
  } catch (error) {
    const detail = safeFailure(error, requiredConfig(state).secretValues)
    state.record('remote-branches-unchanged', false, detail)
    state.record('remote-pull-requests-unchanged', false, detail)
  }
}

function newUlid(timestampMs: number): string {
  return ulidFromParts(timestampMs, randomBytes(10))
}

function commandResult(result: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly errorCode?: string } | undefined): unknown {
  if (result === undefined) return { code: null, error: 'command not started' }
  return { code: result.code, signal: result.signal, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }) }
}

function progress(task: RunState['fixTask'], approvalsProcessed: number): unknown {
  const unit = task?.units.find((value) => value.status === 'running') ?? task?.units.at(-1)
  return { check: 'error-pull-progress', status: task?.status ?? 'starting', currentUnit: unit?.title ?? '尚未排程', approvalsProcessed }
}

function isTerminal(status: string): boolean {
  return ['completed', 'blocked', 'cancelled'].includes(status)
}

function safeFailure(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : '非 Error 例外'
  return safeText(message, secrets)
}

function safeText(value: string, secrets: readonly string[]): string {
  return redactAcceptanceText(value, secrets)
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? String(value) } catch { return '[unserializable]' }
}

function requiredConfig(state: RunState): AcceptanceConfig {
  if (state.config === undefined) throw new Error('驗收設定未初始化')
  return state.config
}

function requiredDatabase(state: RunState): Pool {
  if (state.database === undefined) throw new Error('資料庫連線未初始化')
  return state.database
}

function requiredWorktree(state: RunState): WorktreeInfo {
  if (state.worktree === undefined) throw new Error('目標專案 worktree 尚未建立')
  return state.worktree
}

function requiredContext(state: RunState): RuntimeContext {
  if (state.appContext === undefined) throw new Error('暫時 yeschef 尚未啟動')
  return state.appContext
}

function requiredGroupIds(state: RunState): readonly [string, string] {
  const ids = state.fixtures?.groups.map((group) => group.id)
  if (ids?.length !== 2) throw new Error('error group fixture 尚未建立')
  return [ids[0] as string, ids[1] as string]
}

if (resolve(process.argv[1] ?? '') === resolve(join(ROOT, '.spike-out/error-pull-acceptance.cjs'))) void main()
