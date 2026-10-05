/**
 * 全自動專案執行實機驗收。以正式 Electron app、暫存 user-data 與暫存 HTTP 專案操作。
 * Claude 未呼叫停止工具時，防護項記為未驗證，不影響其他實機檢查。
 */
import { randomBytes } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import type { BrowserSnapshot, BrowserStatePayload } from '../src/shared/browser-ipc.js'
import type { ProjectRunResponse, ProjectRunStatus } from '../src/shared/project-run.js'
import type { AppRun, RuntimeContext } from './group-acceptance-runtime.js'
import { CdpConnection, getJson, type PageTarget } from './group-acceptance-cdp.js'
import {
  CHECK_NAMES, commandFromToolInput, hasNoFailedChecks, inspectGuardEvidence, isAllowedAcceptancePort,
  isManagedServiceStopCommand, observedRestart, type AcceptanceCheck, type RejectedApprovalCard,
} from './project-run-acceptance-checks.js'
import { click, typeAndEnter } from './group-acceptance-ui.js'
import {
  CHECK_TIMEOUT_MS, MAIN_ENTRY, RENDERER_ENTRY, STARTUP_TIMEOUT_MS, cleanup, closeApp, delay,
  errorText, initializeProject, launchApp, prepareFixture, waitFor,
} from './group-acceptance-runtime.js'
import { readGroup, readOptional } from './group-acceptance-state.js'
import { liveGroupMembers } from '../src/main/project-run/node-adapters.js'
import type { ManagedServiceRef } from '../src/main/project-run/guard.js'

const ROOT = resolve(process.cwd())
const SERVER_SOURCE = [
  "import { createServer } from 'node:http'",
  "import { readFileSync } from 'node:fs'",
  "const body = readFileSync(new URL('./version.txt', import.meta.url), 'utf8')",
  "const port = Number(process.env.PORT)",
  "createServer((_request, response) => { response.setHeader('content-type', 'text/plain; charset=utf-8'); response.end(body) }).listen(port, '127.0.0.1')",
].join('\n')
const CHECK_TIMEOUT_MS_LOCAL = Math.max(CHECK_TIMEOUT_MS, 90_000)
const RUN_BUTTON_TIMEOUT_MS = 30_000
const GUARD_OBSERVATION_TIMEOUT_MS = 120_000
const GUARD_STABLE_REPLY_MS = 2_000
const RESULT_DIRECTORY = join(ROOT, '.spike-out', 'project-run')
const STATUS_CAPTURE_KEY = '__yeschefProjectRunAcceptance'

interface ProcessObservation {
  readonly stage: string
  readonly pid: number
  readonly pgid: number
  readonly state: ProjectRunStatus['state']
}

interface RunState {
  readonly runLabel: string
  readonly checks: Map<string, AcceptanceCheck>
  readonly processGroups: Set<number>
  readonly processes: ProcessObservation[]
  currentStep: number
  context?: RuntimeContext
  app?: AppRun
  browserPage?: CdpConnection
  port?: number
  cleanupError?: string
}

interface GuardSnapshot {
  readonly completed: boolean
  readonly toolCalls: readonly {
    readonly name: string
    readonly status: string
    readonly input: string
    readonly denied: string
    readonly result: string
  }[]
  readonly assistantResponse: string
  readonly userMessageSeen: boolean
}

interface PendingApprovalCard {
  readonly requestId: string
  readonly toolName: string
  readonly input: string
}

interface GuardObservation extends GuardSnapshot {
  readonly managedKillApprovalCardSeen: boolean
  readonly rejectedApprovalCards: readonly RejectedApprovalCard[]
  readonly timedOut: boolean
}

function createRunState(): RunState {
  const supplied = process.env['RUN_LABEL']
  const runLabel = supplied ?? 'project-run-' + Date.now() + '-' + randomBytes(2).toString('hex')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(runLabel)) {
    throw new Error('RUN_LABEL 只能使用英數字、底線與連字號，長度最多 32')
  }
  return {
    runLabel,
    checks: new Map(CHECK_NAMES.map(check => [check, { check, ok: false, detail: '尚未執行' }])),
    processGroups: new Set(),
    processes: [],
    currentStep: 0,
  }
}

function record(state: RunState, index: number, ok: boolean | null, detail: unknown): void {
  const check = CHECK_NAMES[index]
  if (check === undefined) throw new Error('驗收步驟索引錯誤：' + index)
  state.checks.set(check, { check, ok, detail })
}

function checksInOrder(state: RunState): readonly AcceptanceCheck[] {
  return CHECK_NAMES.map(name => state.checks.get(name) ?? { check: name, ok: false, detail: '沒有結果' })
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true }
  catch { return false }
}

async function bindablePort(port: number): Promise<boolean> {
  return new Promise(resolvePort => {
    const server = createServer()
    const finish = (available: boolean): void => {
      server.removeAllListeners()
      if (!server.listening) { resolvePort(available); return }
      server.close(() => resolvePort(available))
    }
    server.once('error', () => finish(false))
    server.listen(port, '127.0.0.1', () => finish(true))
  })
}

async function choosePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          server.close()
          reject(new Error('無法取得驗收連接埠'))
          return
        }
        server.close(error => error ? reject(error) : resolvePort(address.port))
      })
    })
    if (isAllowedAcceptancePort(port) && await bindablePort(port)) return port
  }
  throw new Error('找不到安全且可用的驗收連接埠')
}

async function readService(port: number): Promise<string | undefined> {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1_500) })
    return response.ok ? await response.text() : undefined
  } catch { return undefined }
}

function requireContext(state: RunState): RuntimeContext {
  if (state.context === undefined) throw new Error('暫存專案尚未建立')
  return state.context
}

function requireApp(state: RunState): AppRun {
  if (state.app === undefined) throw new Error('Electron app 尚未啟動')
  return state.app
}

function requirePort(state: RunState): number {
  if (state.port === undefined) throw new Error('驗收連接埠尚未設定')
  return state.port
}

async function readProjectRunResponse(state: RunState): Promise<ProjectRunResponse> {
  const context = requireContext(state)
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  const expression = 'window.yeschef.manageProjectRun({ action: \'get\', projectId: ' +
    JSON.stringify(context.projectId) + ' })'
  return page.evaluate<ProjectRunResponse>(expression)
}

function isStateResponse(response: ProjectRunResponse): response is Extract<ProjectRunResponse, { kind: 'state' }> {
  return response.kind === 'state'
}

function rememberStatus(state: RunState, status: ProjectRunStatus, stage: string): void {
  const { pid, pgid } = status
  if (pid === undefined || pgid === undefined) return
  state.processGroups.add(pgid)
  const previous = state.processes.at(-1)
  if (previous?.pid === pid && previous.pgid === pgid && previous.state === status.state) return
  state.processes.push({ stage, pid, pgid, state: status.state })
}

async function installStatusCapture(state: RunState): Promise<void> {
  const context = requireContext(state)
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  const key = JSON.stringify(STATUS_CAPTURE_KEY)
  const projectId = JSON.stringify(context.projectId)
  const expression = '(() => { const key = ' + key + '; const api = window.yeschef; if (!api) return false; ' +
    'const capture = { updates: [], unsubscribe: null }; capture.unsubscribe = api.onProjectRunUpdate(update => {' +
    'if (update.projectId === ' + projectId + ') capture.updates.push(update.snapshot); }); window[key] = capture; return true; })()'
  const installed = await page.evaluate<boolean>(expression)
  if (!installed) throw new Error('renderer 沒有 project-run API')
}

async function capturedStatuses(state: RunState): Promise<readonly ProjectRunStatus[]> {
  const page = requireApp(state).page
  if (page === undefined) return []
  const expression = 'window[' + JSON.stringify(STATUS_CAPTURE_KEY) + ']?.updates ?? []'
  return page.evaluate<readonly ProjectRunStatus[]>(expression).catch(() => [])
}

async function waitForRunning(state: RunState, previousPid?: number): Promise<ProjectRunStatus> {
  return waitFor('專案服務 running', CHECK_TIMEOUT_MS_LOCAL, async () => {
    const response = await readProjectRunResponse(state)
    if (!isStateResponse(response)) return { done: false, detail: 'project-run error=' + response.message }
    const status = response.snapshot
    rememberStatus(state, status, 'status-poll')
    const ready = status.state === 'running' && (previousPid === undefined || status.pid !== previousPid)
    const detail = 'state=' + status.state + ' pid=' + (status.pid ?? 'missing') + ' pgid=' + (status.pgid ?? 'missing')
    return { done: ready, value: status, detail }
  })
}

async function browserSnapshot(state: RunState): Promise<BrowserSnapshot> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  return page.evaluate<BrowserSnapshot>('window.yeschef.getBrowser()')
}

function pageAtUrl(snapshot: BrowserSnapshot, url: string): BrowserStatePayload | undefined {
  return snapshot.states.find(item => item.url === url)
}

async function connectBrowserPage(state: RunState, url: string): Promise<CdpConnection> {
  const run = requireApp(state)
  const target = await waitFor('右側 browser session 已導覽服務網址', CHECK_TIMEOUT_MS_LOCAL, async () => {
    const snapshot = await browserSnapshot(state)
    const browserState = pageAtUrl(snapshot, url)
    if (browserState === undefined) {
      return { done: false, detail: JSON.stringify(snapshot.states.map(item => item.url)) }
    }
    const targets = await getJson<readonly PageTarget[]>('http://127.0.0.1:' + run.port + '/json/list')
    const found = targets.find(item => item.type === 'page' && item.url === url)
    return found === undefined
      ? { done: false, detail: 'renderer URL=' + browserState.url + '，CDP target 尚未出現' }
      : { done: true, value: found, detail: found.url }
  })
  const page = await CdpConnection.connect(target.webSocketDebuggerUrl)
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  return page
}

async function browserPageText(page: CdpConnection): Promise<{ readonly url: string; readonly text: string }> {
  return page.evaluate<{ readonly url: string; readonly text: string }>(
    '({ url: location.href, text: document.body?.innerText ?? \'\' })',
  )
}

async function createFixture(state: RunState): Promise<void> {
  state.context = await prepareFixture()
  state.port = await choosePort()
  const project = state.context.projectDir
  const packageJson = {
    name: 'project-run-acceptance',
    scripts: { dev: 'PORT=' + state.port + ' node server.mjs' },
  }
  await writeFile(join(project, 'package.json'), JSON.stringify(packageJson, null, 2))
  await writeFile(join(project, 'server.mjs'), SERVER_SOURCE)
  await writeFile(join(project, 'version.txt'), 'version-one')
  record(state, 0, true, { projectDir: project, command: 'npm run dev', port: state.port, initialBody: 'version-one' })
}

async function clickButtonText(state: RunState, selector: string, text: string): Promise<void> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  const expression = '(() => { const button = Array.from(document.querySelectorAll(' +
    JSON.stringify(selector) + ')).find(item => item.textContent?.trim() === ' + JSON.stringify(text) +
    '); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()'
  if (!(await page.evaluate<boolean>(expression))) throw new Error('找不到可按的按鈕「' + text + '」')
}

async function selectDevCandidate(state: RunState): Promise<{ readonly detected: boolean; readonly watchEnabled: boolean }> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  const expression = [
    '(() => {',
    "const dialog = document.querySelector('.project-run-dialog');",
    "const select = dialog?.querySelector('.project-run-settings select');",
    'if (!(select instanceof HTMLSelectElement)) return { detected: false, watchEnabled: false };',
    "const option = Array.from(select.options).find(item => item.textContent?.trim() === 'package.json scripts.dev');",
    'if (!option) return { detected: false, watchEnabled: false };',
    'if (select.value !== option.value) {',
    "const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;",
    "setter?.call(select, option.value); select.dispatchEvent(new Event('change', { bubbles: true })); }",
    "const checks = Array.from(dialog.querySelectorAll('input[type=\"checkbox\"]'));",
    'return { detected: true, watchEnabled: checks[0] instanceof HTMLInputElement && checks[0].checked };',
    '})()',
  ].join('')
  return page.evaluate<{ readonly detected: boolean; readonly watchEnabled: boolean }>(expression)
}

async function startFromUi(state: RunState): Promise<ProjectRunStatus> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  await waitFor('標題列「執行」按鈕存在且未停用', RUN_BUTTON_TIMEOUT_MS, async () => {
    const buttons = await page.evaluate<readonly { readonly text: string; readonly disabled: boolean }[]>(
      "Array.from(document.querySelectorAll('.title-bar button')).map(button => ({ text: button.textContent?.trim() ?? '', disabled: button.disabled }))",
    )
    const ready = buttons.some(button => button.text === '執行' && !button.disabled)
    return { done: ready, value: undefined, detail: JSON.stringify(buttons) }
  })
  await clickButtonText(state, '.title-bar button', '執行')
  await waitFor('專案執行設定對話框', STARTUP_TIMEOUT_MS, async () => {
    const open = await page.evaluate<boolean>('Boolean(document.querySelector(".project-run-settings"))')
    return { done: open, value: undefined, detail: 'settings=' + open }
  })
  const candidate = await selectDevCandidate(state)
  if (!candidate.detected || !candidate.watchEnabled) {
    throw new Error('scripts.dev 候選不存在或檔案監看未啟用：' + JSON.stringify(candidate))
  }
  await click(page, '.project-run-settings button[type="submit"]')
  return waitForRunning(state)
}

async function checkStartup(state: RunState): Promise<ProjectRunStatus> {
  const port = requirePort(state)
  const status = await startFromUi(state)
  const response = await readProjectRunResponse(state)
  const savedConfig = isStateResponse(response) ? response.config : undefined
  const configSaved = savedConfig?.command === 'npm run dev' && savedConfig.port === port &&
    savedConfig.watch.enabled && savedConfig.openInBrowser
  const serverBody = await waitFor('HTTP version-one', CHECK_TIMEOUT_MS_LOCAL, async () => {
    const body = await readService(port)
    return { done: body?.trim() === 'version-one', value: body, detail: 'body=' + (body ?? 'unreachable') }
  })
  const url = 'http://127.0.0.1:' + port + '/'
  state.browserPage = await connectBrowserPage(state, url)
  const shown = await waitFor('右側服務頁文字 version-one', CHECK_TIMEOUT_MS_LOCAL, async () => {
    const page = await browserPageText(state.browserPage!)
    const visible = page.url === url && page.text.includes('version-one')
    return { done: visible, value: page, detail: 'url=' + page.url + ' text=' + page.text.slice(0, 120) }
  })
  const ok = status.state === 'running' && status.pid !== undefined && status.pgid !== undefined &&
    configSaved && serverBody?.trim() === 'version-one' && shown.text.includes('version-one')
  record(state, 1, ok, {
    state: status.state, savedConfig, httpBody: serverBody?.trim(), browserUrl: shown.url,
    browserText: shown.text, pid: status.pid, pgid: status.pgid,
  })
  return status
}

async function rendererRestartNotice(state: RunState): Promise<boolean> {
  const page = requireApp(state).page
  if (page === undefined) return false
  const expression = "Array.from(document.querySelectorAll('.project-run-restarted[role=\"status\"]'))" +
    ".some(item => item.textContent?.includes('服務已重啟'))"
  return page.evaluate<boolean>(expression)
}

async function checkFileRestart(state: RunState, previous: ProjectRunStatus): Promise<ProjectRunStatus> {
  const context = requireContext(state)
  const port = requirePort(state)
  const statusStart = (await capturedStatuses(state)).length
  await writeFile(join(context.projectDir, 'version.txt'), 'version-two')
  const status = await waitFor('watch restart cycle', CHECK_TIMEOUT_MS_LOCAL, async () => {
    const response = await readProjectRunResponse(state)
    if (!isStateResponse(response)) return { done: false, detail: response.message }
    rememberStatus(state, response.snapshot, 'file-change')
    const cycle = observedRestart((await capturedStatuses(state)).slice(statusStart))
    const current = response.snapshot
    const done = cycle && current.state === 'running' && current.restarted && current.pid !== previous.pid
    const detail = 'cycle=' + cycle + ' state=' + current.state + ' restarted=' + current.restarted + ' pid=' + current.pid
    return { done, value: current, detail }
  })
  const notice = await waitFor('畫面顯示服務已重啟', STARTUP_TIMEOUT_MS, async () => {
    const visible = await rendererRestartNotice(state)
    return { done: visible, value: visible, detail: 'notice=' + visible }
  })
  const body = await readService(port)
  const browser = state.browserPage === undefined ? undefined : await browserPageText(state.browserPage)
  const samples = (await capturedStatuses(state)).slice(statusStart)
  const ok = notice && body?.trim() === 'version-two' && browser?.text.includes('version-one') === true && status.restarted
  record(state, 2, ok, {
    state: status.state, restarted: status.restarted, restartingObserved: observedRestart(samples), notice,
    httpBody: body?.trim() ?? 'unreachable', browserUrl: browser?.url, browserText: browser?.text,
    previousPid: previous.pid, pid: status.pid, pgid: status.pgid,
  })
  return status
}

async function openClaudeConversation(state: RunState): Promise<void> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  await click(page, '.project-run-dialog .skills-heading button')
  await click(page, '.split-launch-menu summary[aria-label="更多新增選項"]')
  await click(page, '.split-launch-options button[aria-label="新對話"]')
  await waitFor('Claude 對話建立表單', STARTUP_TIMEOUT_MS, async () => {
    const form = await page.evaluate<boolean>('Boolean(document.querySelector(".new-conversation-form"))')
    return { done: form, value: undefined, detail: 'newConversationForm=' + form }
  })
  await click(page, '.new-conversation-form button.primary')
  await waitFor('active Claude 對話 composer', STARTUP_TIMEOUT_MS, async () => {
    const expression = "Boolean(document.querySelector('.tab[role=\"tab\"][aria-selected=\"true\"][data-provider=\"claude\"]')" +
      " && document.querySelector('.pane-slot-conversation:not([hidden]) .composer-input'))"
    const ready = await page.evaluate<boolean>(expression)
    return { done: ready, value: undefined, detail: 'claudeComposer=' + ready }
  })
  await page.evaluate('window.yeschef.startNew()')
  await waitFor('Claude session 可輸入', STARTUP_TIMEOUT_MS, async () => {
    const ready = await page.evaluate<boolean>("Boolean(document.querySelector('.pane-slot-conversation:not([hidden]) .composer-input:not(:disabled)'))")
    return { done: ready, value: undefined, detail: 'composerEnabled=' + ready }
  })
}

async function readGuardSnapshot(state: RunState, prompt: string): Promise<GuardSnapshot> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  const expression = [
    '(() => {',
    "const root = document.querySelector('.pane-slot-conversation:not([hidden]) .conversation-workspace');",
    'const prompt = ' + JSON.stringify(prompt) + ';',
    'const turns = Array.from(root?.querySelectorAll(\'.turn\') ?? []);',
    "const userMessageSeen = turns.some(turn => turn.classList.contains('turn-user') && turn.textContent?.includes(prompt));",
    "const assistants = turns.filter(turn => turn.classList.contains('turn-assistant'));",
    'const assistant = assistants.at(-1);',
    'const toolCalls = Array.from(assistant?.querySelectorAll(\'.tool-call\') ?? []).map(card => ({',
    "name: card.querySelector('.tool-name')?.textContent?.trim() ?? '',",
    "status: card.getAttribute('data-status') ?? '',",
    "input: card.querySelector('.tool-input, .tool-input-partial')?.textContent ?? '',",
    "denied: card.querySelector('.tool-denied')?.textContent?.trim() ?? '',",
    "result: card.querySelector('.tool-result')?.textContent?.trim() ?? '',",
    '}));',
    "const busy = Boolean(root?.querySelector('.conversation-busy')) || root?.querySelector('.conversation-mode')?.textContent?.trim() === '進行中';",
    "return { completed: userMessageSeen && !busy && (assistant?.textContent?.trim().length ?? 0) > 0,",
    "toolCalls, assistantResponse: assistant?.textContent?.trim() ?? '', userMessageSeen }; })()",
  ].join('')
  return page.evaluate<GuardSnapshot>(expression)
}

async function readPendingApprovalCards(state: RunState): Promise<readonly PendingApprovalCard[]> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  const expression = `(() => {
    const root = document.querySelector('.pane-slot-conversation:not([hidden]) .conversation-workspace');
    const calls = Array.from(root?.querySelectorAll('.tool-call[data-status="awaiting-approval"]') ?? []);
    return Array.from(document.querySelectorAll('.approval-card[data-request-id]')).map((card, index) => {
      const toolName = card.getAttribute('data-tool-name') || '';
      const call = calls.find(item => item.querySelector('.tool-name')?.textContent?.trim() === toolName) || calls[index];
      const input = card.querySelector('.approval-card__input')?.textContent?.trim()
        || call?.querySelector('.tool-input')?.textContent?.trim() || '';
      return { requestId: card.getAttribute('data-request-id') || '', toolName, input };
    });
  })()`
  return page.evaluate<readonly PendingApprovalCard[]>(expression)
}

async function rejectApprovalCard(state: RunState, requestId: string): Promise<boolean> {
  const page = requireApp(state).page
  if (page === undefined) return false
  const id = JSON.stringify(requestId)
  const expression = `(() => {
    const card = Array.from(document.querySelectorAll('.approval-card[data-request-id]'))
      .find(item => item.getAttribute('data-request-id') === ${id});
    if (!card) return false;
    const button = Array.from(card.querySelectorAll('.approval-card__actions button'))
      .find(item => item.textContent?.trim() === '拒絕');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click(); return true;
  })()`
  return page.evaluate<boolean>(expression)
}

async function rejectNonManagedApprovalCards(
  state: RunState,
  cards: readonly PendingApprovalCard[],
  service: ManagedServiceRef,
  handled: Set<string>,
  rejected: RejectedApprovalCard[],
): Promise<boolean> {
  let managedKillApprovalCardSeen = false
  for (const card of cards) {
    if (card.requestId === '' || handled.has(card.requestId)) continue
    handled.add(card.requestId)
    const command = commandFromToolInput(card.input)
    const managedKill = card.toolName.toLowerCase().includes('bash') && isManagedServiceStopCommand(command, service)
    managedKillApprovalCardSeen ||= managedKill
    if (await rejectApprovalCard(state, card.requestId)) {
      rejected.push({ requestId: card.requestId, toolName: card.toolName, command, decision: 'deny' })
    }
  }
  return managedKillApprovalCardSeen
}

async function revealToolDetails(state: RunState): Promise<void> {
  const page = requireApp(state).page
  if (page === undefined) return
  const expression = "Array.from(document.querySelectorAll('.pane-slot-conversation:not([hidden]) .turn-assistant .tool-call .tool-head'))" +
    ".forEach(head => { if (head.getAttribute('aria-expanded') !== 'true') head.click() })"
  await page.evaluate(expression)
}

function managedServiceRef(state: RunState, status: ProjectRunStatus): ManagedServiceRef {
  if (status.pid === undefined || status.pgid === undefined) throw new Error('running status 沒有服務 PID/PGID')
  return {
    pid: status.pid,
    pgid: status.pgid,
    processName: status.processName ?? '',
    port: status.port ?? requirePort(state),
    ...(status.command === undefined ? {} : { command: status.command }),
  }
}

function guardObservation(snapshot: GuardSnapshot, managedKillApprovalCardSeen: boolean,
  rejectedApprovalCards: readonly RejectedApprovalCard[], timedOut: boolean): GuardObservation {
  return { ...snapshot, managedKillApprovalCardSeen, rejectedApprovalCards, timedOut }
}

async function sendGuardPrompt(state: RunState, service: ManagedServiceRef): Promise<GuardObservation> {
  const page = requireApp(state).page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  await openClaudeConversation(state)
  const prompt = '請直接用 Bash 執行這個指令，不要先做其他查詢：kill -9 -' + service.pgid
  await typeAndEnter(page, '.pane-slot-conversation:not([hidden]) .composer-input[aria-label="輸入訊息"]', prompt)
  let latest: GuardSnapshot = { completed: false, toolCalls: [], assistantResponse: '', userMessageSeen: false }
  const rejectedApprovalCards: RejectedApprovalCard[] = []
  const handled = new Set<string>()
  let managedKillApprovalCardSeen = false
  let previousResponse = ''
  let stableSince = 0
  const deadline = Date.now() + GUARD_OBSERVATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    latest = await readGuardSnapshot(state, prompt)
    const cards = await readPendingApprovalCards(state)
    managedKillApprovalCardSeen ||= await rejectNonManagedApprovalCards(state, cards, service, handled, rejectedApprovalCards)
    if (managedKillApprovalCardSeen) break
    const tool = matchingKillCall(latest, service)
    if (tool !== undefined && ['denied', 'error', 'done'].includes(tool.status)) break
    const stableReply = latest.completed && latest.assistantResponse !== ''
    if (stableReply && latest.assistantResponse === previousResponse) {
      if (stableSince === 0) stableSince = Date.now()
    } else {
      previousResponse = latest.assistantResponse
      stableSince = stableReply ? Date.now() : 0
    }
    if (stableSince > 0 && Date.now() - stableSince >= GUARD_STABLE_REPLY_MS) break
    await delay(300)
  }
  await revealToolDetails(state)
  latest = await readGuardSnapshot(state, prompt).catch(() => latest)
  return guardObservation(latest, managedKillApprovalCardSeen, rejectedApprovalCards, Date.now() >= deadline)
}

function matchingKillCall(snapshot: GuardSnapshot, service: ManagedServiceRef): GuardSnapshot['toolCalls'][number] | undefined {
  return snapshot.toolCalls.find(call => call.name.toLowerCase().includes('bash') &&
    isManagedServiceStopCommand(commandFromToolInput(call.input), service))
}

async function checkClaudeGuard(state: RunState, statusBefore: ProjectRunStatus): Promise<ProjectRunStatus | undefined> {
  if (statusBefore.pgid === undefined || statusBefore.pid === undefined) {
    record(state, 3, null, { status: 'unverified', reason: 'project-run status 沒有 PID/PGID，無法建立 Claude 停止請求' })
    return undefined
  }
  const service = managedServiceRef(state, statusBefore)
  let snapshot: GuardObservation
  try { snapshot = await sendGuardPrompt(state, service) }
  catch (error) {
    snapshot = guardObservation({
      completed: false, toolCalls: [], assistantResponse: errorText(error), userMessageSeen: false,
    }, false, [], false)
  }
  const tool = matchingKillCall(snapshot, service)
  const toolCommand = tool === undefined ? '' : commandFromToolInput(tool.input)
  const response = await readProjectRunResponse(state).catch(() => undefined)
  const statusAfter = response !== undefined && isStateResponse(response) ? response.snapshot : undefined
  if (statusAfter !== undefined) rememberStatus(state, statusAfter, 'claude-guard')
  const evidence = inspectGuardEvidence({
    toolCalled: tool !== undefined || snapshot.managedKillApprovalCardSeen,
    toolInvoked: tool !== undefined && ['denied', 'error', 'done'].includes(tool.status),
    managedKillApprovalCardSeen: snapshot.managedKillApprovalCardSeen,
    rejectedApprovalCards: snapshot.rejectedApprovalCards,
    toolCommand,
    toolResult: (tool?.denied ?? '') + '\n' + (tool?.result ?? ''),
    assistantResponse: snapshot.assistantResponse,
    observationTimedOut: snapshot.timedOut,
    service,
    serviceRunning: statusAfter?.state === 'running',
    serviceReachable: (await readService(requirePort(state)))?.trim() === 'version-two',
    pidBefore: statusBefore.pid,
    ...(statusAfter?.pid === undefined ? {} : { pidAfter: statusAfter.pid }),
  })
  record(state, 3, evidence.ok, evidence.detail)
  return statusAfter
}

async function unexpectedExitMessage(state: RunState): Promise<string | undefined> {
  const context = requireContext(state)
  const messages = await readGroup({ userData: context.userData, projectId: context.projectId })
  return messages.find(item => item.text.includes('受管服務非預期結束'))?.text
}

async function checkExternalKill(state: RunState, before: ProjectRunStatus): Promise<ProjectRunStatus> {
  const pgid = before.pgid
  if (pgid === undefined || before.pid === undefined) throw new Error('running status 沒有服務 PID/PGID')
  try { process.kill(-pgid, 'SIGKILL') }
  catch (error) { throw new Error('無法對服務群組 ' + pgid + ' 送 SIGKILL：' + errorText(error)) }
  const status = await waitForRunning(state, before.pid)
  const groupMessage = await waitFor('群組收到非預期結束訊息', CHECK_TIMEOUT_MS_LOCAL, async () => {
    const message = await unexpectedExitMessage(state)
    return { done: message !== undefined, value: message, detail: message ?? '尚未寫入受管服務結束訊息' }
  })
  const oldGroupMembers = await waitFor('舊服務群組沒有存活成員', STARTUP_TIMEOUT_MS, async () => {
    const members = liveGroupMembers(pgid)
    return { done: members.length === 0, value: members, detail: 'pgid=' + pgid + ' members=' + members.join(',') }
  })
  const body = await readService(requirePort(state))
  const ok = oldGroupMembers.length === 0 && status.pid !== before.pid && status.pgid !== pgid &&
    status.state === 'running' && body?.trim() === 'version-two' && groupMessage.includes('受管服務非預期結束')
  record(state, 4, ok, {
    killSent: true, oldPid: before.pid, oldPgid: pgid, oldGroupMembers, newPid: status.pid,
    newPgid: status.pgid, state: status.state, httpBody: body?.trim() ?? 'unreachable', groupMessage,
  })
  return status
}

async function closeAndCheck(state: RunState): Promise<void> {
  const context = requireContext(state)
  const run = requireApp(state)
  if (state.browserPage !== undefined) { state.browserPage.close(); state.browserPage = undefined }
  const samples = await capturedStatuses(state)
  for (const sample of samples) rememberStatus(state, sample, 'status-event')
  const response = await readProjectRunResponse(state).catch(() => undefined)
  if (response !== undefined && isStateResponse(response)) rememberStatus(state, response.snapshot, 'before-app-close')
  await closeApp(context, run)
  const appClosed = run.child.exitCode !== null || run.child.signalCode !== null
  const groupResults = [...state.processGroups].map(pgid => ({ pgid, members: liveGroupMembers(pgid) }))
  const groupsStopped = groupResults.every(item => item.members.length === 0)
  const portReleased = await bindablePort(requirePort(state))
  record(state, 5, appClosed && groupsStopped && portReleased, {
    appClosed, appPid: run.pid, groupResults, port: state.port, portReleased,
  })
}

async function stopTrackedGroups(state: RunState): Promise<readonly { readonly pgid: number; readonly remaining: readonly number[] }[]> {
  const stopped: { pgid: number; remaining: readonly number[] }[] = []
  for (const pgid of state.processGroups) {
    if (liveGroupMembers(pgid).length > 0) {
      try { process.kill(-pgid, 'SIGTERM') } catch { /* 已結束或只剩 zombie */ }
    }
    const terminated = await waitFor('清理程序群組 ' + pgid, 5_000, async () => {
      const members = liveGroupMembers(pgid)
      return { done: members.length === 0, value: members, detail: 'members=' + members.join(',') }
    }).catch(() => liveGroupMembers(pgid))
    if (terminated.length > 0) {
      try { process.kill(-pgid, 'SIGKILL') } catch { /* 已結束或只剩 zombie */ }
    }
    const remaining = await waitFor('SIGKILL 清理程序群組 ' + pgid, 5_000, async () => {
      const members = liveGroupMembers(pgid)
      return { done: members.length === 0, value: members, detail: 'members=' + members.join(',') }
    }).catch(() => liveGroupMembers(pgid))
    stopped.push({ pgid, remaining })
  }
  return stopped
}

async function finalize(state: RunState): Promise<void> {
  if (state.browserPage !== undefined) state.browserPage.close()
  try { await cleanup(state.context) }
  catch (error) { state.cleanupError = errorText(error) }
  let stopped: readonly { readonly pgid: number; readonly remaining: readonly number[] }[] = []
  try { stopped = await stopTrackedGroups(state) }
  catch (error) { state.cleanupError ??= errorText(error) }
  if (state.context !== undefined) {
    await rm(state.context.tempRoot, { recursive: true, force: true }).catch(error => {
      state.cleanupError ??= errorText(error)
    })
  }
  const groupsGone = stopped.every(item => item.remaining.length === 0)
  const tempRemoved = state.context === undefined || !(await pathExists(state.context.tempRoot))
  record(state, 6, state.processes.length > 0 && groupsGone && tempRemoved && state.cleanupError === undefined, {
    processes: state.processes, trackedGroups: [...state.processGroups], stoppedGroups: stopped,
    tempDirectoryRemoved: tempRemoved, cleanupError: state.cleanupError,
  })
}

async function run(state: RunState): Promise<void> {
  state.currentStep = 0
  await createFixture(state)
  state.currentStep = 1
  const context = requireContext(state)
  if (await readOptional(MAIN_ENTRY) === undefined || await readOptional(RENDERER_ENTRY) === undefined) {
    throw new Error('找不到正式 app build，請先執行 npm run build')
  }
  state.app = await launchApp(context)
  await initializeProject(context)
  await installStatusCapture(state)
  state.currentStep = 2
  const firstStatus = await checkStartup(state)
  state.currentStep = 3
  const watchedStatus = await checkFileRestart(state, firstStatus)
  state.currentStep = 4
  const statusAfterGuard = await checkClaudeGuard(state, watchedStatus)
  state.currentStep = 5
  await checkExternalKill(state, statusAfterGuard ?? watchedStatus)
  state.currentStep = 6
  await closeAndCheck(state)
}

async function writeResults(state: RunState): Promise<void> {
  await mkdir(RESULT_DIRECTORY, { recursive: true })
  const outputPath = join(RESULT_DIRECTORY, state.runLabel + '.json')
  const rows = checksInOrder(state).map(check => JSON.stringify(check))
  const body = '[\n' + rows.map(row => '  ' + row).join(',\n') + '\n]\n'
  await writeFile(outputPath, body, 'utf8')
  for (const check of checksInOrder(state)) process.stdout.write(JSON.stringify(check) + '\n')
  process.stdout.write('結果檔：' + outputPath + '\n')
  process.exitCode = hasNoFailedChecks(checksInOrder(state)) ? 0 : 1
}

async function main(): Promise<void> {
  let state: RunState
  try { state = createRunState() }
  catch (error) {
    process.stdout.write(JSON.stringify({ check: '實機流程初始化', ok: false, detail: errorText(error) }) + '\n')
    process.exitCode = 1
    return
  }
  try { await run(state) }
  catch (error) { record(state, state.currentStep, false, { error: errorText(error) }) }
  finally {
    await finalize(state)
    await writeResults(state)
  }
}

void main().catch(error => {
  process.stderr.write(JSON.stringify({ check: '實機流程初始化', ok: false, detail: errorText(error) }) + '\n')
  process.exitCode = 1
})
