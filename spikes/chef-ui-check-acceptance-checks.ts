import { relative, resolve, sep, isAbsolute } from 'node:path'
import type { ChefTask } from '../src/shared/chef.js'
import { scanUiFiles } from '../src/main/chef/ui-check/scan.js'

export interface AcceptanceCheck {
  readonly check: string
  readonly ok: boolean
  readonly detail: unknown
}

export interface ApprovalDecision {
  readonly decision: 'allowed' | 'denied'
  readonly external: boolean
  readonly reason: string
}

export function timeoutMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 40
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('CHEF_UI_CHECK_TIMEOUT_MINUTES 必須是正整數')
  return value
}

export function classifyApproval(toolName: string, input: unknown, projectDir: string): ApprovalDecision {
  const tool = toolName.split('__').at(-1)?.toLowerCase() ?? toolName.toLowerCase()
  const values = record(input)
  const command = typeof values?.['command'] === 'string' ? values['command']
    : typeof values?.['cmd'] === 'string' ? values['cmd'] : ''
  if (isExternalCommand(tool, command)) return { decision: 'denied', external: true, reason: '外部指令拒絕' }
  // view_* 只操作這個對話自己的瀏覽器窗格（例如驗收時讀卡片的實際樣式），不碰檔案與外部服務。
  if (tool.startsWith('view_')) return { decision: 'allowed', external: false, reason: '對話瀏覽器工具放行' }
  if (tool === 'bash') {
    const cwd = typeof values?.['cwd'] === 'string' ? values['cwd'] : projectDir
    if (!withinOrSame(projectDir, cwd)) return { decision: 'denied', external: false, reason: '工作目錄超出示範專案' }
    if (/(?:^|[\s"'=])\.\.(?:[/\\]|$)/.test(command)) return { decision: 'denied', external: false, reason: '指令路徑超出示範專案' }
    if (/\bgit\s+(?:-C\s+\S+\s+)?(?:commit|checkout|switch|branch|worktree|reset|restore|clean)\b/i.test(command)) {
      return { decision: 'denied', external: false, reason: '示範專案基準狀態不得改寫' }
    }
    return command.trim() === ''
      ? { decision: 'denied', external: false, reason: '缺少本機指令' }
      : { decision: 'allowed', external: false, reason: '示範專案內本機指令放行' }
  }
  const paths = approvalPaths(tool, values, projectDir)
  const pathIsAllowed = tool === 'glob' || tool === 'grep' ? withinOrSame : within
  if (paths.length > 0 && paths.every((path) => pathIsAllowed(projectDir, path))) {
    return { decision: 'allowed', external: false, reason: '示範專案檔案操作放行' }
  }
  return { decision: 'denied', external: false, reason: paths.length === 0 ? '不支援的工具或缺少檔案路徑' : '檔案路徑超出示範專案' }
}

export function inspectTask(task: ChefTask | undefined, stylesText: string | undefined): readonly AcceptanceCheck[] {
  if (task === undefined) return missingTaskChecks()
  const review = inspectReviewPrompt(task)
  const findingCoverage = inspectFindingCoverage(task)
  const rejections = countUiCheckReportRejections(task)
  const finalStatus = task.status === 'completed'
  const stripe = inspectSideStripeResolution(task, stylesText)
  return [
    { check: 'review-ui-check-prompt', ok: review.ok, detail: review.detail },
    { check: 'ui-findings-covered-with-reasons', ok: findingCoverage.ok, detail: findingCoverage.detail },
    { check: 'ui-check-report-result-rejections', ok: true, detail: { count: rejections } },
    { check: 'task-completed', ok: finalStatus, detail: { status: task.status } },
    { check: 'side-stripe-final-resolution', ok: stripe.ok, detail: stripe.detail },
  ]
}

export function countUiCheckReportRejections(task: ChefTask): number {
  const seen = new Set<string>()
  for (const attempt of task.attempts) {
    const events = attempt.events.filter(isRecord)
    const reportCalls = new Set(events.flatMap((event) =>
      event['kind'] === 'tool-use' && typeof event['id'] === 'string' && isReportResult(event['name'])
        ? [event['id']]
        : []))
    for (const event of events) {
      if (event['kind'] !== 'tool-result' || event['isError'] !== true || typeof event['id'] !== 'string' ||
          !reportCalls.has(event['id']) || !contentText(event['content']).includes('介面檢查')) continue
      seen.add(`${attempt.id}:${event['id']}`)
    }
  }
  return seen.size
}

export function classifyExternalCommand(toolName: string, command: string): boolean {
  return isExternalCommand(toolName.split('__').at(-1)?.toLowerCase() ?? toolName.toLowerCase(), command)
}

function missingTaskChecks(): readonly AcceptanceCheck[] {
  return [
    { check: 'review-ui-check-prompt', ok: false, detail: { reason: '主廚任務不存在' } },
    { check: 'ui-findings-covered-with-reasons', ok: false, detail: { reason: '主廚任務不存在' } },
    { check: 'ui-check-report-result-rejections', ok: true, detail: { count: 0, eventsAvailable: false } },
    { check: 'task-completed', ok: false, detail: { status: 'missing' } },
    { check: 'side-stripe-final-resolution', ok: false, detail: { reason: '主廚任務不存在' } },
  ]
}

function inspectReviewPrompt(task: ChefTask): { readonly ok: boolean; readonly detail: unknown } {
  const reviewUnits = task.units.filter((unit) => unit.kind === 'review')
  const reviewIds = new Set(reviewUnits.map((unit) => unit.id))
  const events = task.attempts.filter((attempt) => reviewIds.has(attempt.unitId)).flatMap((attempt) => attempt.events)
  const userPrompts = events.flatMap((event) => {
    const value = record(event)
    return value?.['kind'] === 'user-text' && typeof value['text'] === 'string' ? [value['text']] : []
  })
  const eventText = events.map(eventTextValue).filter(Boolean).join('\n')
  const sourceAvailable = userPrompts.length > 0 || eventText.includes('<ui-check>')
  if (sourceAvailable) {
    const prompt = [...userPrompts, eventText].join('\n')
    const hasTag = prompt.includes('<ui-check>')
    const hasSideStripe = prompt.includes('side-stripe')
    return {
      ok: reviewUnits.length > 0 && hasTag && hasSideStripe,
      detail: { reviewUnits: reviewUnits.length, evidence: 'attempt-events', hasUiCheckTag: hasTag, hasSideStripe },
    }
  }
  const hasSideStripeFinding = task.uiCheck?.findings.some((finding) => finding.ruleId === 'side-stripe') === true
  return {
    ok: reviewUnits.length > 0 && hasSideStripeFinding,
    detail: { reviewUnits: reviewUnits.length, evidence: 'task.uiCheck.findings fallback', promptTextAvailable: false, hasSideStripeFinding },
  }
}

function inspectFindingCoverage(task: ChefTask): { readonly ok: boolean; readonly detail: unknown } {
  const expected = task.uiCheck?.findings.map((finding) => finding.id) ?? []
  const reports = task.report?.uiFindings ?? []
  const byId = new Map(reports.map((finding) => [finding.id, finding]))
  const missing = expected.filter((id) => !byId.has(id))
  const missingReasons = expected.filter((id) => (byId.get(id)?.reason.trim() ?? '') === '')
  return {
    ok: expected.length > 0 && missing.length === 0 && missingReasons.length === 0,
    detail: { expectedIds: expected, reportedIds: reports.map((finding) => finding.id), missing, missingReasons },
  }
}

function inspectSideStripeResolution(task: ChefTask, stylesText: string | undefined): { readonly ok: boolean; readonly detail: unknown } {
  const findings = task.uiCheck?.findings.filter((finding) => finding.ruleId === 'side-stripe') ?? []
  const reports = new Map((task.report?.uiFindings ?? []).map((finding) => [finding.id, finding]))
  const finalFindings = stylesText === undefined ? undefined : scanUiFiles([{ path: 'styles.css', text: stylesText }]).findings
    .filter((finding) => finding.ruleId === 'side-stripe')
  const resolutions = findings.map((finding) => {
    const report = reports.get(finding.id)
    return {
      id: finding.id,
      resolution: report?.resolution ?? 'missing',
      reasonProvided: (report?.reason.trim().length ?? 0) > 0,
    }
  })
  const ok = findings.length > 0 && resolutions.every((item) => {
    if (!item.reasonProvided) return false
    if (item.resolution === 'fixed') return finalFindings !== undefined && finalFindings.length === 0
    return item.resolution === 'kept'
  })
  return {
    ok,
    detail: {
      resolutions,
      finalStylesheetAvailable: stylesText !== undefined,
      remainingSideStripeCount: finalFindings?.length ?? null,
    },
  }
}

function approvalPaths(tool: string, input: Record<string, unknown> | undefined, projectDir: string): string[] {
  if (input === undefined) return []
  if (['glob', 'grep'].includes(tool)) {
    const path = typeof input['path'] === 'string' ? input['path'] : projectDir
    return [resolve(projectDir, path)]
  }
  if (!['read', 'write', 'edit', 'multiedit'].includes(tool)) return []
  const direct = typeof input['file_path'] === 'string' ? [input['file_path']]
    : typeof input['path'] === 'string' ? [input['path']] : []
  const changes = Array.isArray(input['changes'])
    ? input['changes'].flatMap((change) => typeof record(change)?.['path'] === 'string' ? [record(change)!['path'] as string] : [])
    : []
  const paths = [...direct, ...changes]
  return paths.map((path) => resolve(projectDir, path))
}

function isExternalCommand(tool: string, command: string): boolean {
  if (tool === 'gh' || tool === 'git' || tool.startsWith('git ')) return true
  return /\bgh\b/i.test(command) ||
    /\bgit\s+(?:-C\s+\S+\s+)?(?:push|fetch|pull|clone|remote|submodule\s+update)\b/i.test(command) ||
    /\b(?:curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn)\s+(?:install|add|publish|login|exec\s+.*(?:curl|wget))\b/i.test(command)
}

function within(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(root, candidate))
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function withinOrSame(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function isReportResult(value: unknown): boolean {
  return typeof value === 'string' && value.split('__').at(-1) === 'report_result'
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('\n')
  const item = record(value)
  if (item === undefined) return ''
  if (typeof item['text'] === 'string') return item['text']
  return Object.values(item).map(contentText).join('\n')
}

function eventTextValue(event: unknown): string {
  const value = record(event)
  return value !== undefined && typeof value['text'] === 'string' ? value['text'] : ''
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return record(value) !== undefined
}
