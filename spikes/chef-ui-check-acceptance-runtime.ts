import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import { ChefTaskSchema, type ChefPolicy, type ChefResponse, type ChefTask } from '../src/shared/chef.js'
import type { ProjectsView } from '../src/shared/projects.js'
import { scanUiFiles } from '../src/main/chef/ui-check/scan.js'
import type { RuntimeContext } from './group-acceptance-runtime.js'
import { classifyApproval } from './chef-ui-check-acceptance-checks.js'

export const DEMO_FILES = {
  'index.html': `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>示範專案</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main>
    <h1>服務狀態</h1>
    <p>主要服務目前正常運作。</p>
    <p>最近一次更新時間為今天上午九點。</p>
    <p>若有變更，請查看維護紀錄。</p>
  </main>
</body>
</html>
`,
  'styles.css': `:root {
  font-family: Arial, sans-serif;
  color: #27333c;
  background: #f3f6f7;
}

body {
  margin: 0;
}

main {
  max-width: 720px;
  margin: 64px auto;
  padding: 24px;
  background: #fdfdfd;
}

h1 {
  margin: 0 0 16px;
  font-size: 28px;
  line-height: 1.25;
}

p {
  margin: 0 0 12px;
  font-size: 16px;
  line-height: 1.6;
}
`,
} as const

export const CHEF_GOAL = '在 index.html 加一張提示卡片：淺黃色背景、左側 4px 實線橘色邊框（border-left: 4px solid #e8590c），內文寫『系統維護通知』。樣式寫在 styles.css。'

export interface ApprovalRecord {
  readonly requestId: string
  readonly toolName: string
  readonly decision: 'allowed' | 'denied'
  readonly reason: string
  readonly external: boolean
}

export async function createDemoProject(context: RuntimeContext): Promise<{ readonly commit: string }> {
  for (const [name, text] of Object.entries(DEMO_FILES)) await writeFile(join(context.projectDir, name), text, 'utf8')
  const baseline = scanUiFiles(Object.entries(DEMO_FILES).map(([path, text]) => ({ path, text })))
  if (baseline.findings.length > 0 || baseline.invalidIgnores.length > 0) throw new Error('示範專案初始檔案觸發介面規則')
  const hooksDir = join(context.tempRoot, 'empty-git-hooks')
  await mkdir(hooksDir, { recursive: true })
  runGit(context.projectDir, ['add', '--', 'index.html', 'styles.css'])
  runGit(context.projectDir, [
    '-c', `core.hooksPath=${hooksDir}`, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=YesChef Acceptance', '-c', 'user.email=yeschef@example.invalid',
    'commit', '--quiet', '-m', 'Initial clean UI check fixture',
  ])
  const commit = runGit(context.projectDir, ['rev-parse', 'HEAD']).trim()
  const count = runGit(context.projectDir, ['rev-list', '--count', 'HEAD']).trim()
  const status = runGit(context.projectDir, ['status', '--porcelain']).trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit) || count !== '1' || status !== '') throw new Error('示範專案基準 commit 驗證失敗')
  return { commit }
}

export async function startChefTask(context: RuntimeContext): Promise<{ readonly taskId: string; readonly policy: ChefPolicy }> {
  const page = context.currentApp?.page
  if (page === undefined) throw new Error('renderer CDP 尚未連線')
  const response = await page.evaluate<ChefResponse>(`window.yeschef.manageChef({ action: 'get' })`)
  if (response.kind !== 'state' || response.state.models.length === 0) throw new Error('無法從主廚 get 取得可用模型')
  const projects = await page.evaluate<ProjectsView>('window.yeschef.getProjects()')
  const project = projects.projects.find((candidate) => resolve(candidate.rootPath) === resolve(context.projectDir))
  if (project === undefined || project.id !== context.projectId) throw new Error('getProjects 未回傳暫存示範專案 ID')
  const policy: ChefPolicy = {
    mode: 'auto',
    allowed: response.state.models.map((model) => model.key),
    maxExecutions: 6,
    deadlineMinutes: 120,
  }
  const start = await page.evaluate<ChefResponse>(`window.yeschef.manageChef(${JSON.stringify({
    action: 'start', projectId: project.id, goal: CHEF_GOAL, policy,
  })})`)
  if (start.kind !== 'state') throw new Error('主廚 start 未建立任務')
  const task = [...start.state.tasks].reverse().find((candidate) => candidate.goal === CHEF_GOAL)
  if (task === undefined) throw new Error('主廚 start 回應缺少示範任務')
  return { taskId: task.id, policy }
}

export async function readTask(context: RuntimeContext, taskId: string): Promise<ChefTask | undefined> {
  let value: unknown
  try { value = JSON.parse(await readFile(join(context.userData, 'chef', 'tasks.json'), 'utf8')) } catch { return undefined }
  if (!Array.isArray(value)) return undefined
  for (const candidate of value) {
    const parsed = ChefTaskSchema.safeParse(candidate)
    if (parsed.success && parsed.data.id === taskId) return parsed.data
  }
  return undefined
}

export async function handleApprovalCards(
  context: RuntimeContext,
  records: ApprovalRecord[],
  handled: Set<string>,
): Promise<void> {
  const page = context.currentApp?.page
  if (page === undefined) return
  const requests = await page.evaluate<readonly ApprovalAskPayload[]>('window.yeschef.getApprovals()')
  for (const ask of requests) {
    if (ask.projectId !== context.projectId || handled.has(ask.requestId)) continue
    const decision = classifyApproval(ask.toolName, ask.input, context.projectDir)
    if (!(await clickApproval(page, ask.requestId, decision.decision === 'allowed' ? 'allow' : 'deny'))) continue
    handled.add(ask.requestId)
    records.push({
      requestId: ask.requestId,
      toolName: ask.toolName.split('__').at(-1) ?? ask.toolName,
      decision: decision.decision,
      reason: decision.reason,
      external: decision.external,
    })
  }
}

export async function cancelChefTask(context: RuntimeContext, taskId: string): Promise<void> {
  const page = context.currentApp?.page
  if (page === undefined) return
  await page.evaluate(`window.yeschef.manageChef({ action: 'cancel', taskId: ${JSON.stringify(taskId)} })`)
}

async function clickApproval(page: NonNullable<RuntimeContext['currentApp']>['page'] & {}, requestId: string, decision: 'allow' | 'deny'): Promise<boolean> {
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

function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
  if (result.error !== undefined || result.status !== 0) throw new Error('示範專案 Git 初始化失敗')
  return result.stdout
}
