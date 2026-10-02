import type { SessionSummary } from '../shared/ipc.js'
import type { ThreadEntry } from '../shared/projects.js'

export interface ThreadGroup {
  readonly key: string
  readonly head: SessionSummary
  readonly rest: readonly SessionSummary[]
}

const newestFirst = (a: SessionSummary, b: SessionSummary): number => b.lastModified - a.lastModified

const newestOf = (members: readonly SessionSummary[]): SessionSummary | undefined =>
  members.reduce<SessionSummary | undefined>((best, m) => (best === undefined || m.lastModified > best.lastModified ? m : best), undefined)

/**
 * 依 thread 分組(規格 §3.2 Recents 那一列)。
 * - 同一條 thread 的 session 合成一組;head 是鏈上最後一筆(有在清單裡的話),
 *   否則取該組最新的一筆;rest 新到舊。
 * - 不屬於任何 thread 的 session(別的工具開的、或 D 之前的歷史)各自一組。
 * - 組之間依 head.lastModified 新到舊。
 * 一個 session 只會出現在一組:先處理的 thread 先收走。
 */
export function groupSessions(sessions: readonly SessionSummary[], threads: readonly ThreadEntry[]): readonly ThreadGroup[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s] as const))
  const claimed = new Set<string>()
  const grouped: ThreadGroup[] = []

  for (const thread of threads) {
    const members = thread.sessions
      .map((l) => byId.get(l.sessionId))
      .filter((s): s is SessionSummary => s !== undefined && !claimed.has(s.sessionId))
    if (members.length === 0) continue
    for (const m of members) claimed.add(m.sessionId)
    const lastId = thread.sessions.at(-1)?.sessionId
    const head = members.find((m) => m.sessionId === lastId) ?? newestOf(members)
    if (head === undefined) continue
    grouped.push({ key: `thread:${thread.id}`, head, rest: members.filter((m) => m !== head).sort(newestFirst) })
  }

  const solo = sessions.filter((s) => !claimed.has(s.sessionId)).map((s) => ({ key: `solo:${s.sessionId}`, head: s, rest: [] }))
  return [...grouped, ...solo].sort((a, b) => newestFirst(a.head, b.head))
}
