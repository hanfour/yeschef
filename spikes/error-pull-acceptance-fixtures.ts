import { fingerprint } from '../packages/error-intake/src/fingerprint.js'
import { parseErrorFixReport } from '../src/main/error-intake/pull.js'
import { redactSensitiveText } from './error-intake-acceptance-helpers.js'

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface ErrorGroupFixture {
  readonly id: string
  readonly project: 'demo-app'
  readonly environment: 'local'
  readonly fingerprint: string
  readonly source: 'server' | 'browser'
  readonly error_type: string
  readonly message: string
  readonly top_frame: string
  readonly route: string
  readonly count: number
  readonly first_seen_at: Date
  readonly last_seen_at: Date
  readonly status: 'new'
  readonly status_note: null
}

export interface ErrorEventFixture {
  readonly id: string
  readonly group_id: string
  readonly occurred_at: Date
  readonly message: string
  readonly stack: string
  readonly release_tag: null
  readonly user_agent: null
  readonly request_method: null
  readonly status_code: null
}

export interface ErrorPullFixtures {
  readonly groups: readonly [ErrorGroupFixture, ErrorGroupFixture]
  readonly events: readonly [ErrorEventFixture, ErrorEventFixture, ErrorEventFixture, ErrorEventFixture]
}

export interface PullRequestRef {
  readonly number: number
  readonly url: string
  readonly headRefName: string
}

export interface RemoteChangeSnapshot {
  readonly branches: readonly string[]
  readonly pullRequests: readonly PullRequestRef[]
}

export interface RemoteChangeComparison {
  readonly addedBranches: readonly string[]
  readonly addedPullRequests: readonly PullRequestRef[]
  readonly ok: boolean
}

export function ulidFromParts(timestampMs: number, entropy: Uint8Array): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs >= 2 ** 48 || entropy.length !== 10) {
    throw new Error('ULID 需要 48 位毫秒時間與 80 位 entropy')
  }
  let randomness = 0n
  for (const byte of entropy) randomness = (randomness << 8n) | BigInt(byte)
  let value = (BigInt(timestampMs) << 80n) | randomness
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = `${ULID_ALPHABET[Number(value & 31n)]}${encoded}`
    value >>= 5n
  }
  return encoded
}

export function createErrorPullFixtures(
  timestampMs: number,
  groupIds: readonly [string, string],
  eventIds: readonly [string, string, string, string],
): ErrorPullFixtures {
  const firstSeen = new Date(timestampMs - 1_000)
  const lastSeen = new Date(timestampMs)
  const server = serverError()
  const browser = browserError()
  const groups = [
    makeGroup(groupIds[0], 'server', server, firstSeen, lastSeen),
    makeGroup(groupIds[1], 'browser', browser, firstSeen, lastSeen),
  ] as const
  return {
    groups,
    events: [
      makeEvent(eventIds[0], groupIds[0], firstSeen, server.message, server.stack),
      makeEvent(eventIds[1], groupIds[0], lastSeen, server.message, `${server.stack}\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)`),
      makeEvent(eventIds[2], groupIds[1], firstSeen, browser.message, browser.stack),
      makeEvent(eventIds[3], groupIds[1], lastSeen, browser.message, `${browser.stack}\n    at EI_ACCEPTANCE executeJavaScript sample 2`),
    ],
  }
}

export function parseRemoteBranches(output: string): readonly string[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const ref = line.trim().split(/\s+/).at(-1)
    return ref?.startsWith('refs/heads/fix/error-') === true ? [ref.slice('refs/heads/'.length)] : []
  }).sort()
}

export function parsePullRequestList(output: string): readonly PullRequestRef[] {
  let parsed: unknown
  try { parsed = JSON.parse(output) } catch { throw new Error('gh pr list 回傳 JSON 格式無效') }
  if (!Array.isArray(parsed)) throw new Error('gh pr list 回傳值不是陣列')
  return parsed.flatMap((value) => {
    if (!isRecord(value) || !Number.isInteger(value['number']) || typeof value['url'] !== 'string' || typeof value['headRefName'] !== 'string') {
      throw new Error('gh pr list 回傳欄位不完整')
    }
    return [{ number: value['number'] as number, url: value['url'], headRefName: value['headRefName'] }]
  }).sort((left, right) => left.number - right.number)
}

export function compareRemoteChanges(before: RemoteChangeSnapshot, after: RemoteChangeSnapshot): RemoteChangeComparison {
  const oldBranches = new Set(before.branches)
  const oldPullRequests = new Set(before.pullRequests.map((pr) => `${pr.number}:${pr.headRefName}`))
  const addedBranches = after.branches.filter((branch) => !oldBranches.has(branch))
  const addedPullRequests = after.pullRequests.filter((pr) => !oldPullRequests.has(`${pr.number}:${pr.headRefName}`))
  return { addedBranches, addedPullRequests, ok: addedBranches.length === 0 && addedPullRequests.length === 0 }
}

export function parseNoPullRequestResults(
  summary: string,
  groupIds: readonly string[],
): readonly { readonly groupId: string; readonly noPullRequest: boolean; readonly reason: string }[] {
  const outcomes = parseErrorFixReport(summary, groupIds)
  return groupIds.map((groupId) => {
    const outcome = outcomes.get(groupId) ?? ''
    const match = /^不開 PR[，,]\s*(.+)$/.exec(outcome)
    return { groupId, noPullRequest: match !== null, reason: match?.[1]?.trim() ?? '' }
  })
}

export function inspectErrorFixGoal(goal: string, groupIds: readonly string[], secrets: readonly string[]) {
  const data = /<error-data>\n([\s\S]*?)\n<\/error-data>/i.exec(goal)?.[1] ?? ''
  return {
    hasErrorData: data !== '',
    hasAllGroupIds: groupIds.every((groupId) => data.includes(`群 ID：${groupId}`)),
    hasDatabasePassword: secrets.some((secret) => secret !== '' && includesSecret(goal, secret)),
    hasConnectionString: /\b(?:mysql|mariadb):\/\//i.test(goal),
  }
}

export function isProhibitedExternalEffect(toolName: string, input: unknown): boolean {
  const inputText = typeof input === 'string' ? input : stringify(input)
  const command = `${toolName}\n${inputText}`
  return /\bgh\s+pr\s+create\b/i.test(command) ||
    /\bgh\s+api\b[^\n]*\/pulls?\b/i.test(command) ||
    /\bgit\s+(?:-C\s+\S+\s+)?(?:push|commit)\b/i.test(command) ||
    /\bgit\s+(?:-C\s+\S+\s+)?switch\b[^\n]*\s(?:-c|--create)\b/i.test(command) ||
    /\bgit\s+(?:-C\s+\S+\s+)?checkout\b[^\n]*\s(?:-b|--branch)\b/i.test(command) ||
    /\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\b[^\n]*\s(?:-b|--branch)\b/i.test(command) ||
    /\bgit\s+(?:-C\s+\S+\s+)?branch\s+(?!-(?:a|r)\b|--(?:list|show-current)\b)\S+/i.test(command)
}

export function hasFailedToolCall(events: readonly unknown[], toolUseId: string): boolean {
  return events.some((value) => isRecord(value) && (
    value['kind'] === 'tool-result' && value['id'] === toolUseId && value['isError'] === true ||
    value['kind'] === 'permission-denied' && value['toolUseId'] === toolUseId
  ))
}

export function redactAcceptanceText(value: string, secrets: readonly string[]): string {
  const variants = new Set<string>()
  for (const secret of secrets) {
    if (secret === '') continue
    let encoded = secret
    try { variants.add(encodeURIComponent(secret)) } catch { /* Keep raw and JSON escaped forms. */ }
    for (let depth = 0; depth < 4; depth += 1) {
      variants.add(encoded)
      try { encoded = JSON.stringify(encoded).slice(1, -1) } catch { break }
    }
  }
  return redactSensitiveText(value, [...variants])
}

function includesSecret(value: string, secret: string): boolean {
  if (value.includes(secret)) return true
  try { if (value.includes(encodeURIComponent(secret))) return true } catch { /* Invalid surrogate remains checked raw. */ }
  const escaped = JSON.stringify(secret).slice(1, -1)
  return escaped !== secret && value.includes(escaped)
}

function makeGroup(
  id: string,
  source: 'server' | 'browser',
  error: { readonly errorType: string; readonly message: string; readonly topFrame: string; readonly route: string },
  firstSeen: Date,
  lastSeen: Date,
): ErrorGroupFixture {
  return {
    id, project: 'demo-app', environment: 'local',
    fingerprint: fingerprint({ source, errorType: error.errorType, message: error.message, topFrame: error.topFrame, route: error.route }),
    source, error_type: error.errorType, message: error.message, top_frame: error.topFrame, route: error.route,
    count: 2, first_seen_at: firstSeen, last_seen_at: lastSeen, status: 'new', status_note: null,
  }
}

function makeEvent(id: string, groupId: string, occurredAt: Date, message: string, stack: string): ErrorEventFixture {
  return { id, group_id: groupId, occurred_at: occurredAt, message, stack, release_tag: null, user_agent: null, request_method: null, status_code: null }
}

function serverError() {
  const message = '外部認證服務 auth gateway 連線被拒絕（ECONNREFUSED）'
  return {
    errorType: 'ServiceUnavailableException', message,
    topFrame: 'backend/src/auth/user-auth.service.ts:UserAuthService.getCurrentUser', route: '/auth/me',
    stack: `ServiceUnavailableException: ${message}\n    at UserAuthService.getCurrentUser (backend/src/auth/user-auth.service.ts:42:17)\n    at AuthController.me (backend/src/auth/auth.controller.ts:28:24)\n    at RouterExecutionContext.create (node_modules/@nestjs/core/router/router-execution-context.js:38:29)\n    at RouterProxy.callback (node_modules/@nestjs/core/router/router-proxy.js:9:17)`,
  }
}

function browserError() {
  const message = 'EI_ACCEPTANCE injected error: TypeError injected by the acceptance program through executeJavaScript on /billing'
  return {
    errorType: 'TypeError', message, topFrame: 'executeJavaScript:<anonymous>', route: '/billing',
    stack: `TypeError: ${message}\n    at eval (eval at executeJavaScript (<anonymous>), <anonymous>:1:20)\n    at EI_ACCEPTANCE error-pull acceptance executeJavaScript harness (/spikes/error-pull-acceptance.ts:1:1)`,
  }
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value) } catch { return '[unserializable]' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
