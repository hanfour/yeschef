import type { ChefAttempt, ChefModel, ChefPolicy } from '../../shared/chef.js'
import type { Event } from '../../shared/events.js'
import type { Provider } from '../../shared/projects.js'

/**
 * 各種工作預設偏好哪一家。review 不設固定偏好(拿掉這個 kind,不落到 DEFAULT_PREFERRED),
 * 只靠 crossCheck 加「跟上一次不同家」的分:兩家時等於舊版「一定換一家」,三家時另外兩家
 * 打平手,再由 recommended 與既有 tie-break 決定。設了固定偏好會跟 crossCheck 的 +10 打平
 * (lastProvider 剛好等於偏好的那家時),破壞「一定換家」的舊行為。
 */
const PREFERRED_BY_KIND: Readonly<Record<string, Provider>> = {
  code: 'codex', test: 'codex', analysis: 'claude', docs: 'claude',
}
const DEFAULT_PREFERRED: Provider = 'claude'

export function isModelUnavailableError(apiErrorStatus: unknown, message: string): boolean {
  const explicitStatus = typeof apiErrorStatus === 'number' && Number.isInteger(apiErrorStatus)
    ? apiErrorStatus
    : typeof apiErrorStatus === 'string' && /^\s*\d{3}\s*$/.test(apiErrorStatus) ? Number(apiErrorStatus) : undefined
  const statusIs404 = explicitStatus === undefined
    ? /\b(?:status|HTTP)\s*[:=]?\s*404\b/i.test(message)
    : explicitStatus === 404
  if (!statusIs404) return false
  return /\bmodel_not_found\b|\bmodel\b[^.!?;\n]{0,100}\b(?:not found|does not exist|doesn't exist|not supported|unsupported|unavailable)\b|\b(?:does not exist|doesn't exist|not supported|unsupported|unavailable)\b[^.!?;\n]{0,100}\bmodel\b/i.test(message)
}

export function chooseModel(models: readonly ChefModel[], policy: ChefPolicy, kind: string, attempts: readonly ChefAttempt[], lastProvider?: string, unavailableModelKeys: readonly string[] = []): ChefModel | undefined {
  const failed = new Set(attempts.filter(a => a.status === 'failed').map(a => `${a.provider}:${a.model}`))
  const modelUnavailable = new Set(unavailableModelKeys)
  const providerFailures = attempts.filter(a => a.status === 'failed' && a.failureKind !== 'model-unavailable')
  const unavailableProviders = new Set(providerFailures.filter(a => /not.?logged|登入|unauthoriz|quota|額度/i.test(a.reason)).map(a => a.provider))
  const eligible = models.filter(m => policy.allowed.includes(m.key) && !unavailableProviders.has(m.provider) && !failed.has(m.key) && !modelUnavailable.has(m.key) && (policy.mode !== 'pinned' || m.key === policy.preferred))
  const preferredProvider = kind === 'review' ? undefined : (PREFERRED_BY_KIND[kind] ?? DEFAULT_PREFERRED)
  // review 要換一雙眼睛:跟上一次同一家就不加分,不同家才加。
  const crossCheck = (m: ChefModel): number => (kind === 'review' && lastProvider !== undefined && m.provider !== lastProvider ? 10 : 0)
  const score = (m: ChefModel) => (policy.mode === 'preferred' && m.key === policy.preferred ? 100 : 0) + (m.provider === preferredProvider ? 10 : 0) + crossCheck(m) + (m.recommended ? 5 : 0) - (providerFailures.some(a => a.provider === m.provider) ? 30 : 0)
  return eligible
    .map((model, index) => ({ model, index }))
    .sort((a, b) => score(b.model) - score(a.model) || a.index - b.index)[0]?.model
}
export function providerFailure(event: Extract<Event, { kind: 'session-end' }>): boolean {
  if (!event.isError) return false
  const message = event.errorMessage ?? ''
  if (isModelUnavailableError(event.apiErrorStatus, message)) return false
  if (/interrupt|cancel|停止|max.?turn|budget|預算/i.test(message)) return false
  if ([401, 403, 429, 500, 502, 503, 504].includes(Number(event.apiErrorStatus))) return true
  if (/denied|批准|拒絕/i.test(message)) return false
  return /rate.?limit|overload|quota|unauthoriz|not.?logged|認證|登入|額度|未登入|連線|connection|network|ECONN|ENOTFOUND|timed.?out|timeout|SDK 事件流中斷|process (?:exited|terminated)|spawn.*ENOENT|子程序.*結束|model.*(?:unavailable|not.found)|模型.*不可用|找不到 (?:codex|grok)/i.test(message)
}
export function backgroundResult(event: Extract<Event, { kind: 'tool-result' }>, tool: Extract<Event, { kind: 'tool-use' }> | undefined): boolean {
  if (tool?.name !== 'Bash') return false
  const input = tool.input as { run_in_background?: unknown } | null
  if (input?.run_in_background === true && !event.isError) return true
  const text = typeof event.content === 'string' ? event.content.trim() : ''
  return /^(?:Command running in background with ID:|Process running with session ID)/i.test(text)
}

type ToolResultEvent = Extract<Event, { kind: 'tool-result' }>
type ToolUseEvent = Extract<Event, { kind: 'tool-use' }>

/** tool-result 的內容可能是字串或 content block 陣列，取出純文字。 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(block => (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') ? (block as { text: string }).text : '').join('\n')
  return ''
}

/** 背景啟動的 Bash 回傳的工作 ID；看得出是背景工作但沒有 ID 時回 '?'（永遠不會被清掉，維持保守判定）。 */
export function startedBackgroundId(event: ToolResultEvent, tool: ToolUseEvent | undefined): string | undefined {
  if (!backgroundResult(event, tool)) return undefined
  const match = /(?:background with ID|session ID)[:\s]+([A-Za-z0-9_-]+)/i.exec(resultText(event.content))
  return match?.[1] ?? '?'
}

/**
 * 被停掉或確認已結束的背景工作 ID。TaskStop（舊名 KillShell）成功即視為停止；
 * TaskOutput（舊名 BashOutput）只有在回報的狀態是已結束時才算。
 */
export function stoppedBackgroundId(event: ToolResultEvent, tool: ToolUseEvent | undefined): string | undefined {
  if (tool === undefined || event.isError) return undefined
  const input = (tool.input ?? {}) as { task_id?: unknown; shell_id?: unknown; bash_id?: unknown }
  const id = [input.task_id, input.shell_id, input.bash_id].find((value): value is string => typeof value === 'string' && value !== '')
  if (id === undefined) return undefined
  if (['TaskStop', 'KillShell', 'KillBash'].includes(tool.name)) return id
  if (!['TaskOutput', 'BashOutput'].includes(tool.name)) return undefined
  return /<status>\s*(?:completed|failed|killed|exited)\s*<\/status>|"status"\s*:\s*"(?:completed|failed|killed|exited)"/i.test(resultText(event.content)) ? id : undefined
}
