import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Provider = 'claude' | 'codex' | 'grok'
export type GroupKind = 'text' | 'goal' | 'delegated' | 'progress' | 'report' | 'blocked' | 'joined' | 'left'

export interface Sender {
  readonly kind: 'user' | 'system' | 'agent'
  readonly conversationId?: string
  readonly label?: string
  readonly provider?: Provider
  readonly role?: 'chef' | 'worker'
}

export interface GroupMessage {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly at: number
  readonly from: Sender
  readonly kind: GroupKind
  readonly text: string
  readonly mentions: readonly string[]
  readonly unitId?: string
}

export function takeUnseenRequestRecords<T extends { readonly requestId: string }>(records: readonly T[], seen: Set<string>): T[] {
  const fresh: T[] = []
  for (const record of records) {
    if (seen.has(record.requestId)) continue
    seen.add(record.requestId)
    fresh.push(record)
  }
  return fresh
}

export interface GroupDomRow {
  readonly from: string
  readonly text: string
}

export interface CurrentCodexWorker {
  readonly conversationId: string
  readonly label: string
}

export interface ChefUnit {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly parentId: string | null
  readonly status: string
}

export interface ChefAttempt {
  readonly id: string
  readonly unitId: string
  readonly workerId: string
  readonly provider: Provider
  readonly model: string
  readonly status: string
  readonly reason?: string
  readonly awaitingApproval?: boolean
  readonly pendingTools?: readonly string[]
  readonly startedAt: number
  readonly endedAt?: number
  readonly events?: readonly unknown[]
}

export interface ChefTask {
  readonly id: string
  readonly goal: string
  readonly status: string
  readonly reason?: string
  readonly policy: { readonly allowed: readonly string[] }
  readonly units: readonly ChefUnit[]
  readonly attempts: readonly ChefAttempt[]
  readonly report?: { readonly outcome: 'completed' | 'blocked'; readonly summary: string }
}

export interface ProjectTab {
  readonly id: string
  readonly contentType: string
  readonly label: string
  readonly lastFocusedAt: number
  readonly chefTaskId?: string
}

export interface ProjectState {
  readonly projects: readonly {
    readonly id: string
    readonly rootPath: string
    readonly tabs: readonly ProjectTab[]
  }[]
}

export interface AcceptancePaths {
  readonly userData: string
  readonly projectId: string
}

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

export function parseLines<T>(text: string | undefined): readonly T[] {
  if (text === undefined || text.trim() === '') return []
  return text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as T]
    } catch {
      return []
    }
  })
}

export async function readGroup(paths: AcceptancePaths): Promise<readonly GroupMessage[]> {
  if (paths.projectId === '') return []
  const path = join(paths.userData, 'yeschef-group', `${paths.projectId}.ndjson`)
  return parseLines<GroupMessage>(await readOptional(path))
}

export async function readTasks(paths: Pick<AcceptancePaths, 'userData'>): Promise<readonly ChefTask[]> {
  const text = await readOptional(join(paths.userData, 'chef', 'tasks.json'))
  if (text === undefined) return []
  try {
    return JSON.parse(text) as ChefTask[]
  } catch {
    return []
  }
}

export async function readProjectState(paths: Pick<AcceptancePaths, 'userData'>): Promise<ProjectState | undefined> {
  const text = await readOptional(join(paths.userData, 'yeschef-projects.json'))
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as ProjectState
  } catch {
    return undefined
  }
}

export function taskById(tasks: readonly ChefTask[], taskId: string | undefined): ChefTask | undefined {
  return taskId === undefined ? undefined : tasks.find((task) => task.id === taskId)
}

function isInputTurn(event: unknown, input: string): boolean {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return false
  const value = event as Record<string, unknown>
  return value['kind'] === 'user-text' && typeof value['text'] === 'string' && value['text'].includes(input)
}

function inputTurnCounts(task: ChefTask | undefined, input: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const attempt of task?.attempts ?? []) {
    const count = (attempt.events ?? []).filter((event) => isInputTurn(event, input)).length
    if (count > 0) counts.set(attempt.workerId, (counts.get(attempt.workerId) ?? 0) + count)
  }
  return counts
}

export function inputTurnCountsByParticipant(task: ChefTask | undefined, input: string): readonly { readonly conversationId: string; readonly count: number }[] {
  return [...inputTurnCounts(task, input)].map(([conversationId, count]) => ({ conversationId, count }))
}

export function participantsWithNewInputTurn(before: ChefTask | undefined, after: ChefTask | undefined, input: string): readonly string[] {
  const beforeCounts = inputTurnCounts(before, input)
  return [...inputTurnCounts(after, input)].flatMap(([conversationId, count]) =>
    count > (beforeCounts.get(conversationId) ?? 0) ? [conversationId] : [])
}

export function chefRoundCount(task: ChefTask): number {
  const ids = new Set(task.units.filter((unit) => unit.parentId === null || unit.kind === 'review').map((unit) => unit.id))
  return task.attempts.filter((attempt) => ids.has(attempt.unitId)).length
}

export function taskSummary(task: ChefTask | undefined): string {
  if (task === undefined) return 'task 尚未寫入 chef/tasks.json'
  return JSON.stringify({
    id: task.id,
    status: task.status,
    reason: task.reason?.slice(0, 180),
    rounds: chefRoundCount(task),
    units: task.units.map((unit) => ({ id: unit.id, title: unit.title, kind: unit.kind, status: unit.status })),
    attempts: task.attempts.map((attempt) => ({ workerId: attempt.workerId, provider: attempt.provider, unitId: attempt.unitId, status: attempt.status, reason: attempt.reason?.slice(0, 140), awaitingApproval: attempt.awaitingApproval, pendingTools: attempt.pendingTools?.length ?? 0 })),
    providers: task.policy.allowed.map((key) => key.split(':', 1)[0]),
  })
}

export function groupDetail(message: GroupMessage | undefined): string {
  if (message === undefined) return '沒有符合的持久化群組訊息'
  const text = message.text.length <= 220 ? message.text : `${message.text.slice(0, 220)}…`
  return JSON.stringify({ kind: message.kind, sender: message.from, thread: message.threadId, at: message.at, text })
}

export function currentCodexWorker(messages: readonly GroupMessage[], unitId: string): CurrentCodexWorker | undefined {
  let current: CurrentCodexWorker | undefined
  for (const message of messages) {
    const sender = message.from
    if (message.unitId !== unitId || sender.kind !== 'agent' || sender.role !== 'worker' || sender.provider !== 'codex') continue
    if (message.kind === 'joined' && sender.conversationId !== undefined && sender.label !== undefined) {
      current = { conversationId: sender.conversationId, label: sender.label }
    } else if (message.kind === 'left' && current?.conversationId === sender.conversationId) {
      current = undefined
    }
  }
  return current
}

export function normalizeGroupText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function hasVisibleGroupText(rows: readonly GroupDomRow[], expected: string): boolean {
  const normalizedExpected = normalizeGroupText(expected)
  return rows.some((row) => normalizeGroupText(row.text).includes(normalizedExpected))
}

export function groupDomRowsEqual(actual: readonly GroupDomRow[], expected: readonly GroupDomRow[]): boolean {
  return actual.length === expected.length && actual.every((row, index) => {
    const other = expected[index]
    return other !== undefined && row.from === other.from && normalizeGroupText(row.text) === normalizeGroupText(other.text)
  })
}

export function messageSignature(messages: readonly GroupMessage[]): readonly string[] {
  return messages.map((message) => JSON.stringify({
    id: message.id,
    from: message.from.kind === 'agent' ? message.from.label : message.from.kind,
    text: message.text,
    at: message.at,
  }))
}

export function expectedGroupRows(messages: readonly GroupMessage[]): readonly GroupDomRow[] {
  return messages.map((message) => ({
    from: message.from.kind === 'agent' ? message.from.label ?? '' : message.from.kind === 'user' ? '你' : '系統',
    text: message.text,
  }))
}
