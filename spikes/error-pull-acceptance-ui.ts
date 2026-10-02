import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import type { ChefTask } from '../src/shared/chef.js'
import { hasFailedToolCall, isProhibitedExternalEffect, redactAcceptanceText } from './error-pull-acceptance-fixtures.js'
import { delay, type RuntimeContext } from './group-acceptance-runtime.js'
import { clickButton, requirePage, waitForNewChefTask, waitForValue, type ApprovalRecord } from './error-intake-acceptance-ui.js'
import type { AcceptanceConfig } from './error-intake-acceptance-runtime.js'
import type { CdpConnection } from './group-acceptance-cdp.js'

export interface ErrorPullApprovalRecord extends ApprovalRecord {
  readonly toolUseId: string
  readonly phase: 'setup' | 'error-fix'
  readonly expectedFailure: boolean
  readonly failureRecorded?: boolean
  readonly decisionReason?: string
}

export interface SetupCancellationEvidence {
  readonly task: ChefTask
  readonly ipcStatus: string
  readonly approvals: readonly ErrorPullApprovalRecord[]
  readonly noPendingApprovals: boolean
}

export async function cancelSetupTask(
  context: RuntimeContext,
  previousTaskIds: readonly string[],
  config: AcceptanceConfig,
): Promise<SetupCancellationEvidence> {
  const observed = await waitForNewChefTask(context, previousTaskIds)
  if (observed === undefined) throw new Error('啟用後未找到安裝錯誤收集主廚任務')
  const initial = await findTask(context, observed.id)
  if (initial === undefined) throw new Error('安裝主廚任務未出現在 chef/tasks.json')
  const page = requirePage(context)
  const cancelKey = `__errorPullCancel_${initial.id.replace(/[^a-zA-Z0-9_]/g, '_')}`
  await page.evaluate(`(() => {
    const key = ${JSON.stringify(cancelKey)};
    window[key] = { done: false, kind: 'pending', status: 'pending' };
    window.yeschef.manageChef({ action: 'cancel', taskId: ${JSON.stringify(initial.id)} }).then(response => {
      const task = response.kind === 'state' ? response.state.tasks.find(item => item.id === ${JSON.stringify(initial.id)}) : undefined;
      window[key] = { done: true, kind: response.kind, status: task?.status ?? 'missing' };
    }).catch(() => { window[key] = { done: true, kind: 'error', status: 'error' }; });
    return true;
  })()`)
  const approvals: ErrorPullApprovalRecord[] = []
  const handled = new Set<string>()
  let latest = await findTask(context, initial.id) ?? initial
  let ipc = { done: false, kind: 'pending', status: 'pending' }
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await handleApprovalCards(context, 'setup', approvals, handled, config.secretValues)
    latest = await findTask(context, initial.id) ?? latest
    ipc = await readCancelResult(page, cancelKey)
    if (isTerminal(latest.status) && ipc.done) break
    await delay(250)
  }
  await handleApprovalCards(context, 'setup', approvals, handled, config.secretValues)
  latest = await findTask(context, initial.id) ?? latest
  const pending = await page.evaluate<readonly ApprovalAskPayload[]>('window.yeschef.getApprovals()')
  return {
    task: latest,
    ipcStatus: ipc.kind === 'state' ? ipc.status : ipc.kind,
    approvals,
    noPendingApprovals: pending.every((ask) => ask.projectId !== context.projectId),
  }
}

export async function cancelTimedOutTask(
  context: RuntimeContext,
  taskId: string,
  records: ErrorPullApprovalRecord[],
  secrets: readonly string[],
): Promise<ChefTask | undefined> {
  const page = requirePage(context)
  const key = `__errorPullTimeoutCancel_${taskId.replace(/[^a-zA-Z0-9_]/g, '_')}`
  await page.evaluate(`(() => {
    const key = ${JSON.stringify(key)};
    window[key] = { done: false, kind: 'pending', status: 'pending' };
    window.yeschef.manageChef({ action: 'cancel', taskId: ${JSON.stringify(taskId)} }).then(response => {
      const task = response.kind === 'state' ? response.state.tasks.find(item => item.id === ${JSON.stringify(taskId)}) : undefined;
      window[key] = { done: true, kind: response.kind, status: task?.status ?? 'missing' };
    }).catch(() => { window[key] = { done: true, kind: 'error', status: 'error' }; });
    return true;
  })()`)
  const handled = new Set(records.map((record) => record.requestId))
  const deadline = Date.now() + 120_000
  let task = await findTask(context, taskId)
  let ipc = { done: false, kind: 'pending', status: 'pending' }
  while (Date.now() < deadline) {
    await handleApprovalCards(context, 'error-fix', records, handled, secrets)
    task = await findTask(context, taskId) ?? task
    ipc = await readCancelResult(page, key)
    if (task !== undefined && isTerminal(task.status) && ipc.done) return task
    await delay(250)
  }
  return await findTask(context, taskId) ?? task
}

export async function openErrorPullAndStartTask(
  context: RuntimeContext,
  groupIds: readonly [string, string],
  excludedTaskIds: readonly string[],
): Promise<ChefTask | undefined> {
  const page = requirePage(context)
  await openErrorPullDialog(page, context.projectId)
  await selectLocalGroups(page, groupIds)
  await submitSelectedGroups(page)
  return await waitForFixTask(context, groupIds, excludedTaskIds)
}

async function openErrorPullDialog(page: CdpConnection, projectId: string): Promise<void> {
  await page.evaluate(`window.yeschef.openGroup(${JSON.stringify(projectId)})`)
  await clickButton(page, '拉錯誤')
  await waitForValue(page, '拉錯誤對話框', `document.querySelector('.error-pull-dialog[open]') !== null`)
}

async function selectLocalGroups(page: CdpConnection, groupIds: readonly [string, string]): Promise<void> {
  await waitForValue(page, '本機錯誤清單', `(() => {
    const select = document.querySelector('.error-pull-dialog select[aria-label="錯誤環境"]');
    return select instanceof HTMLSelectElement && Array.from(select.options).some(option => option.value === 'local');
  })()`)
  const selectedLocal = await page.evaluate<boolean>(`(() => {
    const select = document.querySelector('.error-pull-dialog select[aria-label="錯誤環境"]');
    if (!(select instanceof HTMLSelectElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'local');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  if (!selectedLocal) throw new Error('拉錯誤對話框沒有環境選擇器')
  const ids = [...groupIds]
  await waitForValue(page, '兩個錯誤群列在新錯誤清單', `(() => {
    const ids = ${JSON.stringify(ids)};
    const select = document.querySelector('.error-pull-dialog select[aria-label="錯誤環境"]');
    return select instanceof HTMLSelectElement && select.value === 'local' && ids.every(id =>
      document.querySelector('.error-pull-dialog input[aria-label="選取錯誤群 ' + id + '"]') instanceof HTMLInputElement);
  })()`)
  // 每次點擊都重新查元素，點完再等勾選狀態生效：React 重繪後先前取得的元素參考可能已不在畫面上。
  for (const id of ids) {
    await page.evaluate(`(() => {
      const input = document.querySelector('.error-pull-dialog input[aria-label="選取錯誤群 ${id}"]');
      if (input instanceof HTMLInputElement && !input.disabled && !input.checked) input.click();
    })()`)
    await waitForValue(page, `勾選錯誤群 ${id}`, `(() => {
      const input = document.querySelector('.error-pull-dialog input[aria-label="選取錯誤群 ${id}"]');
      return input instanceof HTMLInputElement && input.checked;
    })()`).catch(() => { throw new Error('拉錯誤清單無法勾選兩個指定錯誤群') })
  }
}

async function submitSelectedGroups(page: CdpConnection): Promise<void> {
  await waitForValue(page, '交給主廚按鈕可用', `(() => Array.from(document.querySelectorAll('.error-pull-dialog button')).some(button =>
    button.textContent?.trim() === '交給主廚（2）' && !button.disabled))()`)
  const submitted = await page.evaluate<boolean>(`(() => {
    const button = Array.from(document.querySelectorAll('.error-pull-dialog button')).find(node => node.textContent?.trim() === '交給主廚（2）');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`)
  if (!submitted) throw new Error('無法按下交給主廚')
}

async function waitForFixTask(
  context: RuntimeContext,
  groupIds: readonly [string, string],
  excludedTaskIds: readonly string[],
): Promise<ChefTask | undefined> {
  const ids = [...groupIds]
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const task = (await readChefTasks(context)).find((candidate) => !excludedTaskIds.includes(candidate.id) &&
      candidate.purpose === 'error-fix' && candidate.goal.includes('<error-data>') && ids.every((id) => candidate.goal.includes(id)))
    if (task !== undefined) return task
    await delay(250)
  }
  return undefined
}

export async function handleApprovalCards(
  context: RuntimeContext,
  phase: 'setup' | 'error-fix',
  records: ErrorPullApprovalRecord[],
  handled: Set<string>,
  secrets: readonly string[],
): Promise<void> {
  const page = requirePage(context)
  const requests = await page.evaluate<readonly ApprovalAskPayload[]>('window.yeschef.getApprovals()')
  for (const ask of requests) {
    if (ask.projectId !== context.projectId || handled.has(ask.requestId)) continue
    const prohibited = phase === 'error-fix' && isProhibitedExternalEffect(ask.toolName, ask.input)
    const decision = phase === 'setup' || prohibited ? 'denied' : 'allowed'
    if (!(await clickApproval(page, ask.requestId, decision === 'allowed' ? 'allow' : 'deny'))) continue
    handled.add(ask.requestId)
    records.push({
      requestId: ask.requestId,
      toolUseId: ask.toolUseId,
      toolName: ask.toolName.split('__').at(-1) ?? ask.toolName,
      summary: redactAcceptanceText(approvalInputSummary(ask.input), secrets).slice(0, 240),
      decision,
      phase,
      expectedFailure: prohibited,
      ...(phase === 'setup' ? { decisionReason: '安裝任務不納入本次驗收，依要求拒絕' } : {}),
      ...(prohibited ? { decisionReason: '會新增分支、commit、push 或建立 PR 的操作必須失敗' } : {}),
    })
  }
}

export function recordExpectedToolFailures(
  task: ChefTask | undefined,
  approvals: readonly ErrorPullApprovalRecord[],
): readonly ErrorPullApprovalRecord[] {
  const events = task?.attempts.flatMap((attempt) => attempt.events ?? []) ?? []
  return approvals.map((approval) => approval.expectedFailure
    ? { ...approval, failureRecorded: hasFailedToolCall(events, approval.toolUseId) }
    : approval)
}

export async function readChefTasks(context: RuntimeContext): Promise<readonly ChefTask[]> {
  let content: string
  try { content = await readFile(join(context.userData, 'chef', 'tasks.json'), 'utf8') } catch { return [] }
  try {
    const parsed: unknown = JSON.parse(content)
    return Array.isArray(parsed) ? parsed.filter(isChefTask) : []
  } catch { return [] }
}

async function findTask(context: RuntimeContext, taskId: string): Promise<ChefTask | undefined> {
  return (await readChefTasks(context)).find((task) => task.id === taskId)
}

async function readCancelResult(page: CdpConnection, key: string): Promise<{ done: boolean; kind: string; status: string }> {
  return await page.evaluate(`window[${JSON.stringify(key)}] ?? { done: false, kind: 'pending', status: 'pending'}`) as {
    done: boolean; kind: string; status: string
  }
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

function isChefTask(value: unknown): value is ChefTask {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['goal'] === 'string' &&
    typeof value['status'] === 'string' && Array.isArray(value['attempts'])
}

function isTerminal(status: string): boolean {
  return status === 'cancelled' || status === 'blocked'
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value) } catch { return '[unserializable]' }
}

function approvalInputSummary(input: unknown): string {
  if (typeof input === 'string') return input
  if (isRecord(input) && typeof input['command'] === 'string') return input['command']
  return stringify(input)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
