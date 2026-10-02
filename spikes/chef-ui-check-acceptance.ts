import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { allChecksPassed, type AcceptanceCheck } from './error-intake-acceptance-helpers.js'
import { cleanup, delay, initializeProject, launchApp, prepareFixture, type RuntimeContext } from './group-acceptance-runtime.js'
import { inspectTask, timeoutMinutes } from './chef-ui-check-acceptance-checks.js'
import {
  cancelChefTask, createDemoProject, handleApprovalCards, readTask, startChefTask,
  type ApprovalRecord,
} from './chef-ui-check-acceptance-runtime.js'
import type { ChefTask } from '../src/shared/chef.js'

declare const __dirname: string

const ROOT = resolve(__dirname, '..')
const CHECK_ORDER = [
  'fixture-baseline-commit', 'app-started', 'task-started', 'review-ui-check-prompt',
  'ui-findings-covered-with-reasons', 'ui-check-report-result-rejections', 'task-completed',
  'side-stripe-final-resolution', 'external-command-approvals-denied', 'fixture-retained', 'app-closed',
] as const

interface RunReport {
  readonly runLabel: string
  readonly startedAt: string
  finishedAt?: string
  timeoutMinutes?: number
  paths: { projectDir?: string; userDataDir?: string; tasksFile?: string; stylesFile?: string }
  policy?: { mode: string; modelCount: number; maxExecutions: number; deadlineMinutes: number }
  task?: {
    id: string
    status: string
    timedOut: boolean
    unitCount: number
    unitKinds: readonly string[]
    uiFindingIds: readonly string[]
    uiFindings: readonly { id: string; resolution: string; reasonProvided: boolean }[]
  }
  approvals: readonly ApprovalRecord[]
  checks: readonly AcceptanceCheck[]
  failureStage?: string
}

type DetailedCheck = Omit<AcceptanceCheck, 'detail'> & { readonly detail: unknown }

interface RunState {
  readonly report: RunReport
  readonly checks: Map<string, DetailedCheck>
  readonly record: (check: string, ok: boolean, detail: unknown) => void
  context?: RuntimeContext
  task?: ChefTask
  taskId?: string
  timedOut: boolean
  timeout: number
  approvals: ApprovalRecord[]
  failureStage?: string
}

async function main(): Promise<void> {
  const state = createRunState()
  try {
    await execute(state)
  } catch {
    state.failureStage ??= 'acceptance-runtime'
  }
  await finish(state)
  for (const check of state.report.checks) process.stdout.write(`${JSON.stringify(check)}\n`)
  process.exitCode = allChecksPassed(state.report.checks) ? 0 : 1
}

function createRunState(): RunState {
  const suppliedLabel = process.env['RUN_LABEL']
  const runLabel = suppliedLabel === undefined || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(suppliedLabel)
    ? suppliedLabel ?? `ui-check-${Date.now()}-${randomBytes(2).toString('hex')}`
    : 'invalid-run-label'
  const checks = new Map<string, DetailedCheck>()
  const state: RunState = {
    report: { runLabel, startedAt: new Date().toISOString(), paths: {}, approvals: [], checks: [] },
    checks,
    record: (check, ok, detail) => checks.set(check, { check, ok, detail }),
    timedOut: false,
    timeout: 40,
    approvals: [],
  }
  return state
}

async function execute(state: RunState): Promise<void> {
  state.failureStage = 'timeout-configuration'
  state.timeout = timeoutMinutes(process.env['CHEF_UI_CHECK_TIMEOUT_MINUTES'])
  state.report.timeoutMinutes = state.timeout

  state.failureStage = 'demo-project'
  const context = await prepareFixture()
  state.context = context
  state.report.paths = {
    projectDir: context.projectDir,
    userDataDir: context.userData,
    tasksFile: join(context.userData, 'chef', 'tasks.json'),
    stylesFile: join(context.projectDir, 'styles.css'),
  }
  const baseline = await createDemoProject(context)
  state.record('fixture-baseline-commit', true, { initialCommit: baseline.commit, clean: true, commitCount: 1 })

  state.failureStage = 'app-startup'
  await launchApp(context)
  await initializeProject(context)
  state.record('app-started', true, { projectIdAvailable: context.projectId !== '' })

  state.failureStage = 'chef-task-start'
  const started = await startChefTask(context)
  state.taskId = started.taskId
  state.report.policy = {
    mode: started.policy.mode,
    modelCount: started.policy.allowed.length,
    maxExecutions: started.policy.maxExecutions,
    deadlineMinutes: started.policy.deadlineMinutes,
  }
  state.record('task-started', true, { taskId: started.taskId, policySource: 'manageChef(get) models and ChefManager defaults', projectIdSource: 'getProjects()' })
  state.failureStage = 'chef-task-wait'
  await waitForTask(state, started.taskId)
  state.failureStage = undefined
}

async function waitForTask(state: RunState, taskId: string): Promise<void> {
  const context = requireContext(state)
  const deadline = Date.now() + state.timeout * 60_000
  const handled = new Set<string>()
  let latest = await readTask(context, taskId)
  let lastProgressAt = Date.now()
  while (Date.now() < deadline) {
    await handleApprovalCards(context, state.approvals, handled)
    latest = await readTask(context, taskId) ?? latest
    if (latest !== undefined && isTerminal(latest.status)) break
    if (Date.now() - lastProgressAt >= 30_000) {
      process.stdout.write(`${JSON.stringify(progress(latest))}\n`)
      lastProgressAt = Date.now()
    }
    await delay(1_000)
  }
  latest = await readTask(context, taskId) ?? latest
  state.timedOut = latest === undefined || !isTerminal(latest.status)
  if (state.timedOut) {
    await cancelChefTask(context, taskId).catch(() => {})
    latest = await settleTimedOutTask(state, taskId, handled, latest)
  }
  await handleApprovalCards(context, state.approvals, handled).catch(() => {})
  state.task = await readTask(context, taskId) ?? latest
}

async function settleTimedOutTask(state: RunState, taskId: string, handled: Set<string>, initial?: ChefTask): Promise<ChefTask | undefined> {
  const context = requireContext(state)
  const deadline = Date.now() + 30_000
  let latest = initial
  while (Date.now() < deadline) {
    await handleApprovalCards(context, state.approvals, handled).catch(() => {})
    latest = await readTask(context, taskId) ?? latest
    if (latest !== undefined && isTerminal(latest.status)) break
    await delay(1_000)
  }
  return latest
}

async function finish(state: RunState): Promise<void> {
  const context = state.context
  if (context !== undefined) {
    const keepTmp = process.env['KEEP_TMP']
    process.env['KEEP_TMP'] = '1'
    try { await cleanup(context) } catch { state.failureStage ??= 'app-cleanup' }
    finally {
      if (keepTmp === undefined) delete process.env['KEEP_TMP']
      else process.env['KEEP_TMP'] = keepTmp
    }
  }
  if (context !== undefined && state.taskId !== undefined) {
    state.task = await readTask(context, state.taskId).catch(() => state.task)
  }
  const stylesText = context === undefined
    ? undefined
    : await readFile(join(context.projectDir, 'styles.css'), 'utf8').catch(() => undefined)
  const taskChecks = inspectTask(state.task, stylesText)
  for (const check of taskChecks) state.checks.set(check.check, check)
  const externalApprovals = state.approvals.filter((approval) => approval.external)
  state.record('external-command-approvals-denied', externalApprovals.every((approval) => approval.decision === 'denied'), {
    count: externalApprovals.length,
    denied: externalApprovals.filter((approval) => approval.decision === 'denied').length,
  })
  const retained = context !== undefined && await pathsExist(context)
  state.record('fixture-retained', retained, context === undefined
    ? { retained: false, reason: 'fixture was not created' }
    : { retained, projectDir: context.projectDir, userDataDir: context.userData })
  const closed = context === undefined || context.apps.every((app) => app.child.exitCode !== null || app.child.signalCode !== null)
  state.record('app-closed', closed, { closed })
  if (state.failureStage !== undefined) state.report.failureStage = state.failureStage
  state.report.approvals = state.approvals
  if (state.task !== undefined) state.report.task = taskSummary(state.task, state.timedOut)
  state.report.finishedAt = new Date().toISOString()
  state.report.checks = CHECK_ORDER.map((name) => state.checks.get(name) ?? {
    check: name, ok: false, detail: { reason: '檢查未執行', failureStage: state.failureStage ?? 'unknown' },
  }).map((check) => ({ ...check, detail: JSON.stringify(check.detail) }))
  await writeReport(state.report)
}

function taskSummary(task: ChefTask, timedOut: boolean): NonNullable<RunReport['task']> {
  return {
    id: task.id,
    status: task.status,
    timedOut,
    unitCount: task.units.length,
    unitKinds: task.units.map((unit) => unit.kind),
    uiFindingIds: task.uiCheck?.findings.map((finding) => finding.id) ?? [],
    uiFindings: (task.report?.uiFindings ?? []).map((finding) => ({
      id: finding.id,
      resolution: finding.resolution,
      reasonProvided: finding.reason.trim().length > 0,
    })),
  }
}

function progress(task: ChefTask | undefined): unknown {
  const current = task?.units.find((unit) => unit.status === 'running') ?? task?.units.at(-1)
  return {
    check: 'chef-ui-check-progress',
    status: task?.status ?? 'starting',
    unitCount: task?.units.length ?? 0,
    currentUnitKind: current?.kind ?? 'unscheduled',
  }
}

function isTerminal(status: string): boolean {
  return ['completed', 'blocked', 'cancelled'].includes(status)
}

function requireContext(state: RunState): RuntimeContext {
  if (state.context === undefined) throw new Error('暫存 runtime 尚未建立')
  return state.context
}

async function pathsExist(context: RuntimeContext): Promise<boolean> {
  try {
    await Promise.all([
      access(context.projectDir),
      access(context.userData),
      access(join(context.userData, 'chef', 'tasks.json')),
      access(join(context.projectDir, 'styles.css')),
    ])
    return true
  } catch {
    return false
  }
}

async function writeReport(report: RunReport): Promise<void> {
  const directory = join(ROOT, '.spike-out', 'chef-ui-check')
  const label = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(report.runLabel) ? report.runLabel : 'invalid-run-label'
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    process.stderr.write('Chef UI acceptance report could not be written.\n')
    process.exitCode = 1
  }
}

if (resolve(process.argv[1] ?? '') === resolve(join(__dirname, 'chef-ui-check-acceptance.cjs'))) {
  void main()
}
