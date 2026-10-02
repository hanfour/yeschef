import { lstat, realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import { takeUnseenRequestRecords, readGroup, readTasks, taskById, type ChefTask, type GroupMessage } from './group-acceptance-state.js'
import { delay, initializeProject, launchApp, prepareFixture, type RuntimeContext } from './group-acceptance-runtime.js'
import { checkErrorIntakeSummary, isPathWithin, pullRequestUrl, redactSensitiveText, type CheckErrorIntakeSummary } from './error-intake-acceptance-helpers.js'
import type { AcceptanceConfig } from './error-intake-acceptance-runtime.js'
import type { CdpConnection } from './group-acceptance-cdp.js'

export interface ApprovalRecord {
  readonly requestId: string
  readonly toolName: string
  readonly summary: string
  readonly decision: 'allowed' | 'denied'
  readonly envFileCheck?: string
}

export interface ChefEvidence {
  readonly taskId?: string
  readonly status: string
  readonly reason?: string
  readonly report?: { readonly outcome: string; readonly summary: string }
  readonly units: readonly { readonly id: string; readonly title: string; readonly status: string }[]
  readonly attempts: readonly {
    readonly workerId: string
    readonly provider: string
    readonly unitId: string
    readonly status: string
    readonly reason?: string
    readonly result?: { readonly isError: boolean; readonly errorMessage?: string }
  }[]
  readonly messages: readonly { readonly kind: string; readonly from: string; readonly text: string }[]
  readonly checkErrorIntake: CheckErrorIntakeSummary
  readonly pullRequestUrl?: string
  readonly approvalRecords: readonly ApprovalRecord[]
  readonly invalidEnvFileApproval: boolean
}

export async function launchAcceptanceApp(worktree: string): Promise<RuntimeContext> {
  const context = await prepareFixture(worktree)
  try {
    await launchApp(context)
    await initializeProject(context)
    return context
  } catch (error) {
    await import('./group-acceptance-runtime.js').then(({ cleanup }) => cleanup(context))
    throw error
  }
}

export async function waitForChefTask(
  context: RuntimeContext,
  priorTaskIds: readonly string[],
  worktree: string,
  config: AcceptanceConfig,
  writeProgress: (line: string) => void,
  onApprovals: (records: readonly ApprovalRecord[], invalidEnvFileApproval: boolean) => void = () => {},
): Promise<ChefEvidence> {
  const task = await waitForNewChefTask(context, priorTaskIds)
  if (task === undefined) throw new Error('找不到新建立的錯誤收集主廚任務')
  const approvals: ApprovalRecord[] = []
  const handled = new Set<string>()
  let invalidEnvFileApproval = false
  let latest: ChefTask | undefined = task
  let lastProgressAt = Date.now()
  const deadline = Date.now() + config.timeoutMinutes * 60_000
  while (Date.now() < deadline) {
    const outcome = await handleApprovalCards(context, worktree, approvals, handled, config.secretValues)
    invalidEnvFileApproval ||= outcome.invalidEnvFileApproval
    onApprovals(approvals, invalidEnvFileApproval)
    latest = taskById(await readTasks(context), task.id)
    if (latest !== undefined && isTerminalTask(latest.status)) break
    if (Date.now() - lastProgressAt >= 30_000) {
      writeProgress(progressLine(latest, approvals.length, config.secretValues))
      lastProgressAt = Date.now()
    }
    await delay(1_000)
  }
  latest = taskById(await readTasks(context), task.id) ?? latest
  const timedOut = latest !== undefined && !isTerminalTask(latest.status)
  const messages = await readGroup(context)
  return buildChefEvidence(latest, messages, approvals, invalidEnvFileApproval, timedOut, config.secretValues)
}

export async function readTaskAndGroupEvidence(
  context: RuntimeContext,
  taskId: string | undefined,
  approvals: readonly ApprovalRecord[],
  invalidEnvFileApproval: boolean,
  secrets: readonly string[],
): Promise<ChefEvidence> {
  const task = taskById(await readTasks(context), taskId)
  return buildChefEvidence(task, await readGroup(context), approvals, invalidEnvFileApproval, false, secrets)
}

export async function ghPullRequestState(url: string | undefined): Promise<{
  readonly isDraft: boolean
  readonly headRefName?: string
  readonly state?: string
  readonly error?: string
}> {
  if (url === undefined) return { isDraft: false, error: '沒有從主廚工具結果或群組訊息找到 PR 網址' }
  const result = spawnSync('gh', ['pr', 'view', url, '--json', 'isDraft,headRefName,state'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.error !== undefined || result.status !== 0) return { isDraft: false, error: 'gh pr view 執行失敗' }
  try {
    const value = JSON.parse(result.stdout) as { isDraft?: unknown; headRefName?: unknown; state?: unknown }
    return {
      isDraft: value.isDraft === true,
      ...(typeof value.headRefName === 'string' ? { headRefName: value.headRefName } : {}),
      ...(typeof value.state === 'string' ? { state: value.state } : {}),
    }
  } catch {
    return { isDraft: false, error: 'gh pr view 回傳 JSON 格式無效' }
  }
}

async function handleApprovalCards(
  context: RuntimeContext,
  worktree: string,
  records: ApprovalRecord[],
  handled: Set<string>,
  secrets: readonly string[],
): Promise<{ readonly invalidEnvFileApproval: boolean }> {
  const page = requirePage(context)
  const requests = await page.evaluate<readonly ApprovalAskPayload[]>('window.yeschef.getApprovals()')
  let invalidEnvFileApproval = false
  for (const ask of requests) {
    if (ask.projectId !== context.projectId || handled.has(ask.requestId)) continue
    const toolName = ask.toolName.split('__').at(-1) ?? ask.toolName
    const envFile = toolName === 'configure_error_intake_env' ? inputEnvFile(ask.input) : undefined
    const envCheck = toolName === 'configure_error_intake_env'
      ? await checkIgnoredEnvFile(worktree, envFile)
      : undefined
    const decision = envCheck === undefined || envCheck.ok ? 'allowed' : 'denied'
    const clicked = await clickApproval(page, ask.requestId, decision === 'allowed' ? 'allow' : 'deny')
    if (!clicked) continue
    const record = {
      requestId: ask.requestId,
      toolName,
      summary: summarizeInput(ask.input, envFile, secrets),
      decision,
      ...(envCheck === undefined ? {} : { envFileCheck: envCheck.detail }),
    } satisfies ApprovalRecord
    records.push(...takeUnseenRequestRecords([record], handled))
    if (decision === 'denied') invalidEnvFileApproval = true
  }
  return { invalidEnvFileApproval }
}

async function checkIgnoredEnvFile(worktree: string, rawEnvFile: string | undefined): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (rawEnvFile === undefined || rawEnvFile.trim() === '' || rawEnvFile.includes('\\')) {
    return { ok: false, detail: 'envFile must be a project path' }
  }
  // 與 yeschef 的工具一致：專案內的絕對路徑先換成相對路徑（Codex 主廚會傳絕對路徑）。
  const envFile = rawEnvFile.startsWith('/') ? await worktreeRelative(worktree, rawEnvFile) : rawEnvFile
  if (envFile === undefined) return { ok: false, detail: 'envFile is not inside worktree' }
  const parts = envFile.split('/')
  if (parts.some((part) => part === '..' || part === '')) return { ok: false, detail: 'envFile escapes or is not inside worktree' }
  const root = await realpath(worktree)
  const target = resolve(root, envFile)
  if (!isPathWithin(root, target)) return { ok: false, detail: 'envFile is not inside worktree' }
  const safePath = await checkNoSymlink(root, parts)
  if (!safePath) return { ok: false, detail: 'envFile contains a symlink or unsafe path component' }
  const ignored = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', relative(root, target)], { stdio: 'ignore' })
  return ignored.status === 0
    ? { ok: true, detail: 'envFile is inside worktree and git check-ignore passed' }
    : { ok: false, detail: 'git check-ignore did not confirm envFile is ignored' }
}

async function worktreeRelative(worktree: string, absolute: string): Promise<string | undefined> {
  for (const root of [worktree, await realpath(worktree)]) {
    const candidate = relative(root, absolute)
    if (candidate !== '' && !candidate.startsWith('..') && !candidate.startsWith('/')) return candidate
  }
  return undefined
}

async function checkNoSymlink(root: string, parts: readonly string[]): Promise<boolean> {
  let cursor = root
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part)
    try {
      const details = await lstat(cursor)
      if (details.isSymbolicLink() || (index < parts.length - 1 && !details.isDirectory())) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
  }
  return true
}

async function clickApproval(page: CdpConnection, requestId: string, decision: 'allow' | 'deny'): Promise<boolean> {
  return await page.evaluate<boolean>(`(() => {
    const card = Array.from(document.querySelectorAll('.approval-card[data-request-id]'))
      .find(node => node.dataset.requestId === ${JSON.stringify(requestId)});
    if (!(card instanceof HTMLElement)) return false;
    const buttons = Array.from(card.querySelectorAll('button'));
    const button = buttons.find(node => ${decision === 'allow'
      ? "node.classList.contains('primary')"
      : "node.textContent?.trim() === '拒絕'"});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)
}

export async function waitForNewChefTask(context: RuntimeContext, previousIds: readonly string[]): Promise<ChefTask | undefined> {
  const old = new Set(previousIds)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const task = (await readTasks(context)).find((candidate) => !old.has(candidate.id) && candidate.goal.includes('安裝並設定錯誤收集'))
    if (task !== undefined) return task
    await delay(250)
  }
  return undefined
}

function buildChefEvidence(
  task: ChefTask | undefined,
  messages: readonly GroupMessage[],
  approvals: readonly ApprovalRecord[],
  invalidEnvFileApproval: boolean,
  timedOut: boolean,
  secrets: readonly string[],
): ChefEvidence {
  const events = task?.attempts.flatMap((attempt) => attempt.events ?? []) ?? []
  const prValues = [
    ...events.map((event) => event),
    ...messages.map((message) => message.text),
    task?.report?.summary,
  ]
  const url = pullRequestUrl(prValues)
  return {
    ...(task === undefined ? {} : { taskId: task.id }),
    status: timedOut ? 'timeout' : task?.status ?? 'missing',
    ...(timedOut ? { reason: '主廚任務逾時' } : task?.reason === undefined ? {} : { reason: redactSensitiveText(task.reason, secrets) }),
    ...(task?.report === undefined ? {} : { report: {
      outcome: task.report.outcome,
      summary: redactSensitiveText(task.report.summary, secrets).slice(0, 1_200),
    } }),
    units: (task?.units ?? []).map((unit) => ({ id: unit.id, title: redactSensitiveText(unit.title, secrets), status: unit.status })),
    attempts: (task?.attempts ?? []).map((attempt) => attemptEvidence(attempt, secrets)),
    messages: messages.map((message) => ({
      kind: message.kind,
      from: message.from.label ?? message.from.kind,
      text: redactSensitiveText(message.text, secrets).slice(0, 700),
    })),
    checkErrorIntake: checkErrorIntakeSummary(events),
    ...(url === undefined ? {} : { pullRequestUrl: url }),
    approvalRecords: approvals.map((record) => ({ ...record, summary: redactSensitiveText(record.summary, secrets) })),
    invalidEnvFileApproval,
  }
}

function attemptEvidence(attempt: ChefTask['attempts'][number], secrets: readonly string[]): ChefEvidence['attempts'][number] {
  const end = [...(attempt.events ?? [])].reverse().find((event) => isRecord(event) && event['kind'] === 'session-end')
  const endRecord = isRecord(end) ? end : undefined
  const errorMessage = typeof endRecord?.['errorMessage'] === 'string'
    ? redactSensitiveText(endRecord['errorMessage'], secrets)
    : undefined
  return {
    workerId: attempt.workerId,
    provider: attempt.provider,
    unitId: attempt.unitId,
    status: attempt.status,
    ...(attempt.reason === undefined ? {} : { reason: redactSensitiveText(attempt.reason, secrets).slice(0, 350) }),
    ...(endRecord === undefined ? {} : { result: { isError: endRecord['isError'] === true, ...(errorMessage === undefined ? {} : { errorMessage }) } }),
    ...toolDiagnostics(attempt, secrets),
  }
}

/**
 * 「仍有背景工作或工具結果不明」的診斷：列出沒拿到結果的工具呼叫與背景執行的 Bash。
 * 主廚的事件存在暫時的 user-data，驗收結束就刪掉，所以這裡先摘要存進報告（輸入與輸出都經過遮罩）。
 */
function toolDiagnostics(attempt: ChefTask['attempts'][number], secrets: readonly string[]): Record<string, unknown> {
  const raw = attempt as unknown as Record<string, unknown>
  const events = (attempt.events ?? []).filter(isRecord)
  const finished = new Set(events.filter((event) => event['kind'] === 'tool-result').map((event) => String(event['id'] ?? event['toolUseId'] ?? '')))
  const summary = (event: Record<string, unknown>) => ({
    id: String(event['id'] ?? ''),
    name: String(event['name'] ?? ''),
    input: redactSensitiveText(JSON.stringify(event['input'] ?? null), secrets).slice(0, 240),
  })
  const uses = events.filter((event) => event['kind'] === 'tool-use')
  return {
    pendingTools: Array.isArray(raw['pendingTools']) ? raw['pendingTools'] : [],
    backgroundWork: raw['backgroundWork'] === true,
    openTools: uses.filter((event) => !finished.has(String(event['id'] ?? ''))).map(summary),
    backgroundBash: uses.filter((event) => event['name'] === 'Bash' && isRecord(event['input']) && event['input']['run_in_background'] === true).map(summary),
    toolUseCount: uses.length,
  }
}

export function requirePage(context: RuntimeContext): CdpConnection {
  const page = context.currentApp?.page
  if (page === undefined) throw new Error('yeschef renderer CDP 尚未連線')
  return page
}

export async function clickButton(page: CdpConnection, label: string): Promise<void> {
  const found = await page.evaluate<boolean>(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent?.trim() === ${JSON.stringify(label)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)
  if (found) return
  await waitForValue(page, `按鈕「${label}」`, `(() => Array.from(document.querySelectorAll('button')).some(node => node.textContent?.trim() === ${JSON.stringify(label)} && !node.disabled))()`)
  const clicked = await page.evaluate<boolean>(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent?.trim() === ${JSON.stringify(label)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`無法按下「${label}」`)
}

export async function waitForValue(page: CdpConnection, target: string, expression: string): Promise<boolean> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate<boolean>(expression)) return true
    } catch {
      // Renderer 導航期間可能短暫失去 runtime context，下一輪再確認。
    }
    await delay(250)
  }
  throw new Error(`等待「${target}」逾時`)
}

function inputEnvFile(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input['envFile'] !== 'string') return undefined
  return input['envFile']
}

function summarizeInput(input: unknown, envFile: string | undefined, secrets: readonly string[]): string {
  if (envFile !== undefined || isConfigureInput(input)) return `envFile=${envFile ?? 'missing'}`
  let text: string
  try { text = JSON.stringify(input) ?? String(input) } catch { text = '[unserializable input]' }
  return redactSensitiveText(text, secrets).slice(0, 220)
}

function isConfigureInput(input: unknown): boolean {
  return isRecord(input) && 'envFile' in input
}

function isTerminalTask(status: string): boolean {
  return ['completed', 'blocked', 'cancelled'].includes(status)
}

function progressLine(task: ChefTask | undefined, approvalsProcessed: number, secrets: readonly string[]): string {
  const current = task?.units.find((unit) => unit.status === 'running') ?? task?.units.at(-1)
  return JSON.stringify({
    check: 'error-intake-progress',
    status: task?.status ?? 'starting',
    currentUnit: redactSensitiveText(current?.title ?? '尚未排程', secrets),
    approvalsProcessed,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
