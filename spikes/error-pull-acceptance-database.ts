import type { Pool } from 'mysql2/promise'
import type { ErrorPullFixtures } from './error-pull-acceptance-fixtures.js'

export interface ErrorGroupStatusRow {
  readonly id: string
  readonly status: string
  readonly statusNote: string | null
}

export async function insertErrorPullFixtures(pool: Pool, fixtures: ErrorPullFixtures): Promise<void> {
  const groupSql = `INSERT INTO error_intake_test.error_group
    (id, project, environment, fingerprint, source, error_type, message, top_frame, route, count,
     first_seen_at, last_seen_at, status, status_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  for (const group of fixtures.groups) {
    await pool.execute(groupSql, [group.id, group.project, group.environment, group.fingerprint, group.source,
      group.error_type, group.message, group.top_frame, group.route, group.count, group.first_seen_at,
      group.last_seen_at, group.status, group.status_note])
  }
  const eventSql = `INSERT INTO error_intake_test.error_event
    (id, group_id, occurred_at, message, stack, release_tag, user_agent, request_method, status_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  for (const event of fixtures.events) {
    await pool.execute(eventSql, [event.id, event.group_id, event.occurred_at, event.message, event.stack,
      event.release_tag, event.user_agent, event.request_method, event.status_code])
  }
}

export async function verifyErrorPullFixtures(pool: Pool, fixtures: ErrorPullFixtures): Promise<boolean> {
  const ids = [fixtures.groups[0].id, fixtures.groups[1].id] as const
  const rows = await readErrorGroupStates(pool, ids)
  const [rawEvents] = await pool.query(
    'SELECT group_id, COUNT(*) AS samples FROM error_intake_test.error_event WHERE group_id IN (?, ?) GROUP BY group_id',
    fixtures.groups.map((group) => group.id),
  )
  const counts = Array.isArray(rawEvents) ? rawEvents.map((row) => Number((row as Record<string, unknown>)['samples'])) : []
  return rows.length === 2 && rows.every((row) => row.status === 'new') && counts.length === 2 && counts.every((count) => count === 2)
}

export async function readErrorGroupStates(pool: Pool, ids: readonly [string, string]): Promise<readonly ErrorGroupStatusRow[]> {
  const [rows] = await pool.query('SELECT id, status, status_note FROM error_intake_test.error_group WHERE id IN (?, ?)', [...ids])
  if (!Array.isArray(rows)) return []
  return rows.flatMap((value) => {
    const row = value as Record<string, unknown>
    return typeof row['id'] === 'string' && typeof row['status'] === 'string'
      ? [{ id: row['id'], status: row['status'], statusNote: typeof row['status_note'] === 'string' ? row['status_note'] : null }]
      : []
  })
}

export async function waitForErrorGroupWriteback(
  pool: Pool,
  ids: readonly [string, string],
  taskId: string,
  reasons: readonly { readonly groupId: string; readonly reason: string }[],
): Promise<readonly ErrorGroupStatusRow[]> {
  const deadline = Date.now() + 30_000
  let rows = await readErrorGroupStates(pool, ids)
  while (Date.now() < deadline && !writebackReady(rows, taskId, reasons)) {
    await delay(500)
    rows = await readErrorGroupStates(pool, ids)
  }
  return rows
}

function writebackReady(
  rows: readonly ErrorGroupStatusRow[],
  taskId: string,
  reasons: readonly { readonly groupId: string; readonly reason: string }[],
): boolean {
  return rows.length === 2 && rows.every((row) => {
    const outcome = reasons.find((value) => value.groupId === row.id)
    return row.status === 'in_progress' && row.statusNote?.includes(taskId) === true &&
      outcome !== undefined && outcome.reason !== '' && row.statusNote.includes(outcome.reason)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
}
