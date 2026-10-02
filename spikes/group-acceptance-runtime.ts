import { randomUUID, randomInt } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { CdpConnection, getJson, rendererTarget, type BrowserVersion } from './group-acceptance-cdp.js'
import { readProjectState, takeUnseenRequestRecords } from './group-acceptance-state.js'

declare const __dirname: string

const ROOT = resolve(__dirname, '..')
export const MAIN_ENTRY = join(ROOT, 'out/main/index.js')
export const RENDERER_ENTRY = resolve(ROOT, 'out/renderer/index.html')
export const OUTPUT_NAMES = [
  '#1 新目標與主廚回應',
  '#2 委派工作者與跳轉分頁',
  '#3 worker 發言不觸發主廚新回合',
  '#4 @ Codex worker 收到並回覆但不回流',
  '#5 不存在的 @ 沒有送達',
  '#6 完成與卡住里程碑',
  '#7 重啟後訊息與 thread 篩選相同',
] as const
export const STARTUP_TIMEOUT_MS = 45_000
export const CHECK_TIMEOUT_MS = 210_000
export const SHORT_TIMEOUT_MS = 45_000

export interface CheckResult {
  readonly check: string
  readonly ok: boolean
  readonly detail: string
}

export interface AppRun {
  readonly child: ChildProcess
  readonly pid: number
  readonly port: number
  page?: CdpConnection
}

export interface RuntimeContext {
  readonly tempRoot: string
  readonly userData: string
  readonly projectDir: string
  projectId: string
  readonly runId: string
  readonly goal: string
  readonly grokBin: string
  readonly path: string
  readonly apps: AppRun[]
  currentApp?: AppRun
  taskId?: string
  threadId?: string
  modelPoolSafe?: boolean
  chefId?: string
  workerId?: string
  workerUnitId?: string
  codexId?: string
  codexLabel?: string
  chefRoundsAtWorkerJoin?: number
  beforeRestart?: readonly string[]
}

interface Probe<T> {
  readonly done: boolean
  readonly value?: T
  readonly detail: string
}

interface ApprovalRecord {
  readonly requestId: string
  readonly conversationId: string
  readonly toolName: string
  readonly summary: string
}

interface ApprovalCapture {
  readonly ctx: RuntimeContext
  readonly records: ApprovalRecord[]
}

let activeApprovalCapture: ApprovalCapture | undefined
const handledApprovalRequestIds = new Set<string>()

export const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : `non-Error: ${String(error)}`
}

export function clipped(value: string, max = 220): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

export function goalTitle(ctx: RuntimeContext): string {
  return Array.from(ctx.goal.trim()).slice(0, 60).join('')
}

export async function waitFor<T>(
  target: string,
  timeoutMs: number,
  probe: () => Promise<Probe<T>>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = '尚未取得狀態'
  while (Date.now() < deadline) {
    if (activeApprovalCapture !== undefined) await serviceApprovalCards(activeApprovalCapture)
    const state = await probe()
    if (activeApprovalCapture !== undefined) await serviceApprovalCards(activeApprovalCapture)
    last = state.detail
    if (state.done) return state.value as T
    await delay(300)
  }
  throw new Error(`逾時等待「${target}」；上限 ${timeoutMs} ms；最後狀態：${last}`)
}

async function serviceApprovalCards(capture: ApprovalCapture): Promise<void> {
  const page = capture.ctx.currentApp?.page
  if (page === undefined) return
  const handled = [...handledApprovalRequestIds]
  const result = await page.evaluate<{
    readonly foreign?: { readonly projectId: string; readonly conversationId: string; readonly toolName: string }
    readonly approved: readonly ApprovalRecord[]
  }>(`(() => {
    const cards = Array.from(document.querySelectorAll('.approval-card[data-request-id]'));
    const foreign = cards.find(card => card.dataset.projectId !== ${JSON.stringify(capture.ctx.projectId)});
    if (foreign) return { foreign: { projectId: foreign.dataset.projectId || 'missing', conversationId: foreign.dataset.conversationId || 'missing', toolName: foreign.dataset.toolName || 'missing' }, approved: [] };
    const known = new Set(${JSON.stringify(handled)});
    const approved = [];
    for (const card of cards) {
      const requestId = card.dataset.requestId || '';
      if (!requestId || known.has(requestId)) continue;
      const button = card.querySelector('.approval-card__actions button.primary');
      if (!(button instanceof HTMLButtonElement) || button.disabled) continue;
      const toolName = card.dataset.toolName || card.querySelector('.approval-card__tool')?.textContent?.trim() || '未知工具';
      const summary = card.querySelector('.approval-card__input')?.textContent?.trim() || card.querySelector('.approval-card__prompt')?.textContent?.trim() || '';
      const conversationId = card.dataset.conversationId || 'missing';
      button.click();
      known.add(requestId);
      approved.push({ requestId, conversationId, toolName, summary: summary.slice(0, 180) });
    }
    return { approved };
  })()`)
  if (result.foreign !== undefined) {
    throw new Error(`發現非暫存專案批准卡，未按下允許：${JSON.stringify(result.foreign)}`)
  }
  capture.records.push(...takeUnseenRequestRecords(result.approved, handledApprovalRequestIds))
}

function portNumber(): number {
  return randomInt(31_000, 56_000)
}

function electronPath(): string {
  const requireFromRepo = createRequire(join(ROOT, 'package.json'))
  const candidate = requireFromRepo('electron') as unknown
  if (typeof candidate !== 'string' || candidate === '') throw new Error('Node 環境沒有解析到 Electron 執行檔路徑')
  return candidate
}

function appEnvironment(ctx: RuntimeContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    YESCHEF_PROJECT_DIR: ctx.projectDir,
    PATH: `${ctx.grokBin}${delimiter}${ctx.path}`,
  }
}

export async function launchApp(ctx: RuntimeContext): Promise<AppRun> {
  const port = portNumber()
  const child = spawn(electronPath(), [
    `--user-data-dir=${ctx.userData}`,
    `--remote-debugging-port=${port}`,
    MAIN_ENTRY,
  ], { cwd: ROOT, env: appEnvironment(ctx), stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('Electron 主行程沒有 PID')
  const appRun: AppRun = { child, pid: child.pid, port }
  ctx.apps.push(appRun)
  ctx.currentApp = appRun
  try {
    appRun.page = await connectRenderer(port, child)
  } catch (error) {
    await signalPid(appRun.pid, 'SIGTERM')
    if (!(await waitForExit(child, 5_000))) {
      await signalPid(appRun.pid, 'SIGKILL')
      await waitForExit(child, 5_000)
    }
    throw error
  }
  return appRun
}

async function connectRenderer(port: number, child: ChildProcess): Promise<CdpConnection> {
  const target = await waitFor('out/renderer/index.html renderer target', STARTUP_TIMEOUT_MS, async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron pid=${child.pid} 已結束 code=${child.exitCode} signal=${child.signalCode}`)
    }
    try {
      const found = await rendererTarget(port, RENDERER_ENTRY)
      return found === undefined
        ? { done: false, detail: `CDP 有回應，尚無精確 renderer target port=${port}` }
        : { done: true, value: found, detail: found.url }
    } catch (error) {
      return { done: false, detail: `port=${port} ${errorText(error)}` }
    }
  })
  const page = await CdpConnection.connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  return page
}

export async function capture(
  results: Map<string, CheckResult>,
  ctx: RuntimeContext,
  name: (typeof OUTPUT_NAMES)[number],
  action: () => Promise<{ readonly ok: boolean; readonly detail: string }>,
): Promise<void> {
  const approvalCapture: ApprovalCapture = { ctx, records: [] }
  activeApprovalCapture = approvalCapture
  try {
    const result = await action()
    await serviceApprovalCards(approvalCapture)
    results.set(name, { check: name, ok: result.ok, detail: JSON.stringify({ result: result.detail, approved: approvalCapture.records }) })
  } catch (error) {
    results.set(name, { check: name, ok: false, detail: JSON.stringify({ error: errorText(error), approved: approvalCapture.records }) })
  } finally {
    activeApprovalCapture = undefined
  }
}

export async function prepareFixture(projectDirOverride?: string): Promise<RuntimeContext> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), 'yeschef-group-acceptance-')))
  try {
    const userData = join(tempRoot, 'user-data')
    const projectDir = projectDirOverride ?? join(tempRoot, 'project')
    const grokBin = join(tempRoot, 'bin')
    const runId = randomUUID()
    // /proc 是作業系統保留位置，一般專案不能在裡面建立檔案；review 必須回報 blocked。
    const goal = `[group-acceptance ${runId}] 在這個暫存 git 專案裡做驗收：先在群組回報開始，再委派一個 kind=code 工作單位建立並讀回 codex-receipt.md，工作者開始後用 say_to_group 回報進度。另一個驗收條件要求在 /proc/yeschef-group-${runId} 建立輸出檔，禁止換路徑；該要求無法在此專案完成。完成工作單位後，review 必須用 report_result 回報 blocked，說明不可完成的絕對路徑。`
    await Promise.all([mkdir(userData, { recursive: true }), mkdir(projectDir, { recursive: true }), mkdir(grokBin, { recursive: true })])
    const grokShim = join(grokBin, process.platform === 'win32' ? 'grok.cmd' : 'grok')
    const shimText = process.platform === 'win32'
      ? '@echo off\r\necho YESCHEF_GROUP_GROK_DISABLED 1>&2\r\nexit /b 127\r\n'
      : '#!/bin/sh\nprintf "%s\\n" YESCHEF_GROUP_GROK_DISABLED >&2\nexit 127\n'
    await writeFile(grokShim, shimText, 'utf8')
    if (process.platform !== 'win32') await chmod(grokShim, 0o700)
    const grokProbe = spawnSync('grok', ['--version'], {
      cwd: projectDir,
      env: { ...process.env, PATH: `${grokBin}${delimiter}${process.env['PATH'] ?? ''}` },
      encoding: 'utf8',
    })
    if (!`${grokProbe.stdout ?? ''}${grokProbe.stderr ?? ''}`.includes('YESCHEF_GROUP_GROK_DISABLED')) {
      throw new Error('暫存 PATH 無法遮蔽 Grok，未啟動 yeschef app')
    }
    if (projectDirOverride === undefined) {
      const repo = spawnSync('git', ['init', '--quiet'], { cwd: projectDir, encoding: 'utf8' })
      if (repo.status !== 0) throw new Error(`暫存 git repo 建立失敗：${repo.stderr}`)
    }
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: projectDir, encoding: 'utf8' })
    // macOS 的 /var 是 /private/var 的 symlink，git 回的是實體路徑；兩邊都取實體路徑再比。
    if (top.status !== 0 || await realpath(top.stdout.trim()) !== await realpath(projectDir)) throw new Error('暫存專案不是預期的新 git repo')
    return {
      tempRoot, userData, projectDir, projectId: '', runId, goal,
      grokBin, path: process.env['PATH'] ?? '', apps: [],
    }
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true })
    throw error
  }
}

export async function initializeProject(ctx: RuntimeContext): Promise<void> {
  const state = await waitFor('YESCHEF_PROJECT_DIR 種入暫存專案', STARTUP_TIMEOUT_MS, async () => {
    const value = await readProjectState(ctx)
    const project = value?.projects.find((candidate) => resolve(candidate.rootPath) === resolve(ctx.projectDir))
    return project === undefined
      ? { done: false, detail: `project 尚未出現在 ${join(ctx.userData, 'yeschef-projects.json')}` }
      : { done: true, value: project, detail: `projectId=${project.id} rootPath=${project.rootPath}` }
  })
  ctx.projectId = state.id
}

export async function closeApp(ctx: RuntimeContext, run: AppRun): Promise<void> {
  run.page?.close()
  try {
    const version = await getJson<BrowserVersion>(`http://127.0.0.1:${run.port}/json/version`)
    const browser = await CdpConnection.connect(version.webSocketDebuggerUrl)
    await browser.send('Browser.close')
    browser.close()
  } catch {
    // 下面用主行程 PID 清理；連線關閉失敗不會略過收尾。
  }
  const exited = await waitForExit(run.child, 12_000)
  if (!exited) await signalPid(run.pid, 'SIGTERM')
  if (!(await waitForExit(run.child, 5_000))) {
    await signalPid(run.pid, 'SIGKILL')
    await waitForExit(run.child, 5_000)
  }
  if (ctx.currentApp === run) ctx.currentApp = undefined
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolveExit(false) }, timeoutMs)
    const onExit = (): void => { clearTimeout(timer); resolveExit(true) }
    child.once('exit', onExit)
  })
}

async function signalPid(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export async function cleanup(ctx: RuntimeContext | undefined): Promise<void> {
  if (ctx === undefined) return
  for (const run of [...ctx.apps].reverse()) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) continue
    try {
      await closeApp(ctx, run)
    } catch {
      await signalPid(run.pid, 'SIGKILL').catch(() => {})
    }
  }
  if (process.env['KEEP_TMP'] !== '1') await rm(ctx.tempRoot, { recursive: true, force: true })
  else process.stderr.write(`KEEP_TMP=1，保留 spike 暫存目錄 ${ctx.tempRoot}\n`)
}
