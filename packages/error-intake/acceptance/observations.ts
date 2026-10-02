import type { Pool } from "mysql2/promise";
import { readRows } from "./database.js";
import { containsAny } from "./pure.js";

export interface ProjectCounts {
  readonly groups: number;
  readonly samples: number;
}

export interface ServerFailureMetrics {
  readonly groupCount: number;
  readonly count: number;
  readonly samples: number;
  readonly route: string | null;
  readonly statusCode: number | null;
}

interface CountRow {
  readonly group_total: number | string;
  readonly sample_total: number | string;
}

interface ServerRow {
  readonly id: string;
  readonly count: number | string;
  readonly route: string | null;
  readonly samples: number | string;
  readonly status_code: number | string | null;
}

export async function readProjectCounts(pool: Pool, project: string): Promise<ProjectCounts> {
  const rows = await readRows<CountRow>(pool, `
    SELECT
      (SELECT COUNT(*) FROM error_group WHERE project = ?) AS group_total,
      (SELECT COUNT(*) FROM error_event e JOIN error_group g ON g.id = e.group_id WHERE g.project = ?) AS sample_total
  `, [project, project]);
  return { groups: numeric(rows[0]?.group_total), samples: numeric(rows[0]?.sample_total) };
}

export async function readServerFailureMetrics(
  pool: Pool,
  project: string,
  marker: string,
): Promise<ServerFailureMetrics> {
  const rows = await readRows<ServerRow>(pool, `
    SELECT g.id, g.count, g.route,
      (SELECT COUNT(*) FROM error_event e WHERE e.group_id = g.id) AS samples,
      (SELECT MAX(e.status_code) FROM error_event e WHERE e.group_id = g.id) AS status_code
    FROM error_group g
    WHERE g.project = ? AND g.source = 'server' AND g.message LIKE ?
  `, [project, `%${marker}%`]);
  const row = rows[0];
  return {
    groupCount: rows.length,
    count: numeric(row?.count),
    samples: numeric(row?.samples),
    route: row?.route ?? null,
    statusCode: row?.status_code === null || row?.status_code === undefined ? null : numeric(row.status_code),
  };
}

export async function hasBrowserFailure(pool: Pool, project: string, marker: string): Promise<boolean> {
  const rows = await readRows<{ readonly id: string }>(pool, `
    SELECT id FROM error_group
    WHERE project = ? AND source = 'browser' AND message LIKE ?
  `, [project, `%${marker}%`]);
  return rows.length > 0;
}

export async function containsRawMarkers(
  pool: Pool,
  project: string,
  markers: readonly string[],
): Promise<boolean> {
  const rows = await readRows<{ readonly content: string }>(pool, `
    SELECT CONCAT_WS(' ', error_type, message, top_frame, route) AS content
    FROM error_group WHERE project = ?
    UNION ALL
    SELECT CONCAT_WS(' ', e.message, e.stack, e.release_tag, e.user_agent) AS content
    FROM error_event e JOIN error_group g ON g.id = e.group_id WHERE g.project = ?
  `, [project, project]);
  return rows.some((row) => containsAny(row.content, markers));
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
