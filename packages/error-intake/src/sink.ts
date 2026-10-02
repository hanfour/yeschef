import { randomBytes } from "node:crypto";
import { createPool } from "mysql2/promise";
import { fingerprint } from "./fingerprint.js";
import { mask, normalizeRoute, topFrameFromStack, truncateUtf8 } from "./shared.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.js";
import type { ErrorEnvironment, ErrorIntakeLogger, ErrorReport, ErrorSink, FingerprintInput } from "./types.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_NEW_GROUPS_PER_HOUR = 200;
const MAX_EVENT_SAMPLES = 20;
const ERROR_LOG_INTERVAL_MS = 10 * 60 * 1000;

interface SqlPool {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  readonly pool?: {
    on(event: "acquire" | "release", listener: (connection: { stream: { ref(): void; unref(): void } }) => void): void;
  };
}

interface GroupRow {
  readonly id: string;
  readonly status: string;
}

interface SafeReport {
  readonly source: ErrorReport["source"];
  readonly errorType: string;
  readonly message: string;
  readonly stack: string;
  readonly topFrame: string;
  readonly route: string | null;
  readonly occurredAt: Date;
  readonly release: string | null;
  readonly userAgent: string | null;
  readonly requestMethod: string | null;
  readonly statusCode: number | null;
}

interface SinkState {
  schemaState: "unknown" | "valid" | "invalid";
  schemaCheck: Promise<boolean> | undefined;
  writeTail: Promise<void>;
  closed: boolean;
  closing: boolean;
  closePromise: Promise<void> | undefined;
}

export interface CreateMysqlSinkOptions {
  readonly url: string;
  readonly project: string;
  readonly environment: ErrorEnvironment;
  readonly logger?: ErrorIntakeLogger;
}

export interface MysqlSink extends ErrorSink {
  close(): Promise<void>;
}

export function createMysqlSink(options: CreateMysqlSinkOptions): MysqlSink {
  const pool = createPool({ uri: options.url, connectionLimit: 2, waitForConnections: true, queueLimit: 0 }) as unknown as SqlPool;
  pool.pool?.on("acquire", (connection) => connection.stream.ref());
  pool.pool?.on("release", (connection) => connection.stream.unref());
  return createSink(pool, options);
}

function createSink(pool: SqlPool, options: CreateMysqlSinkOptions): MysqlSink {
  const logger = createFailureLogger(options.logger);
  const state: SinkState = {
    schemaState: "unknown",
    schemaCheck: undefined,
    writeTail: Promise.resolve(),
    closed: false,
    closing: false,
    closePromise: undefined,
  };
  return {
    record: (report) => enqueueRecord(pool, options, state, logger, report),
    close: () => closeSink(pool, state, logger),
  };
}

function enqueueRecord(
  pool: SqlPool,
  options: CreateMysqlSinkOptions,
  state: SinkState,
  logger: ReturnType<typeof createFailureLogger>,
  report: ErrorReport,
): Promise<void> {
  if (state.closing || state.closed) return Promise.resolve();
  // 在收到錯誤的當下記時間：寫入會排隊，等到輪到寫入才記，資料庫慢時時間會偏移，同一秒的樣本也會被誤擋。
  const stamped: ErrorReport = report.occurredAt instanceof Date ? report : { ...report, occurredAt: new Date() };
  const write = state.writeTail.then(async () => {
    if (state.closed) return;
    try {
      if (!(await hasCurrentSchema(
        pool,
        () => state.schemaState,
        (value) => { state.schemaState = value; },
        () => state.schemaCheck,
        (value) => { state.schemaCheck = value; },
        () => logger.once("schema-mismatch", "Error intake schema version mismatch; writes disabled"),
      ))) return;
      await writeReport(pool, options, stamped);
    } catch (error) {
      logger.failure(error, "write");
    }
  });
  state.writeTail = write.catch(() => undefined);
  return write;
}

function closeSink(
  pool: SqlPool,
  state: SinkState,
  logger: ReturnType<typeof createFailureLogger>,
): Promise<void> {
  if (state.closePromise) return state.closePromise;
  state.closing = true;
  state.closePromise = (async () => {
    await state.writeTail;
    state.closed = true;
    try {
      await pool.end();
    } catch (error) {
      logger.failure(error, "close");
    }
  })();
  return state.closePromise;
}

async function hasCurrentSchema(
  pool: SqlPool,
  getState: () => "unknown" | "valid" | "invalid",
  setState: (state: "valid" | "invalid") => void,
  getCheck: () => Promise<boolean> | undefined,
  setCheck: (check: Promise<boolean> | undefined) => void,
  logMismatch: () => void,
): Promise<boolean> {
  const state = getState();
  if (state === "valid") return true;
  if (state === "invalid") return false;
  const pending = getCheck();
  if (pending) return pending;
  const check = (async () => {
    const [rows] = await pool.execute("SELECT schema_version FROM error_intake_meta WHERE id = 1");
    const version = (rows as readonly { readonly schema_version: number }[])[0]?.schema_version;
    if (version !== SCHEMA_VERSION) {
      setState("invalid");
      logMismatch();
      return false;
    }
    setState("valid");
    return true;
  })();
  setCheck(check);
  try {
    return await check;
  } finally {
    setCheck(undefined);
  }
}

async function writeReport(
  pool: SqlPool,
  options: CreateMysqlSinkOptions,
  input: ErrorReport,
): Promise<void> {
  const report = safeReport(input);
  const fingerprint = fingerprintReport(report);
  const now = report.occurredAt;
  const existing = await findGroup(pool, options, fingerprint);
  const overflow = !existing && await exceedsGroupQuota(pool, options, Date.now());
  const targetFingerprint = overflow ? "overflow" : fingerprint;
  const group = overflow ? await findGroup(pool, options, targetFingerprint) : existing;
  const proposedId = group?.id ?? createUlid(now.getTime());

  await upsertGroup(pool, options, report, targetFingerprint, proposedId);
  // 另一個行程可能同時建立了同一個群，upsert 撞到唯一鍵時用的是對方的 id；樣本要掛在實際存在的群上。
  const groupId = group?.id ?? (await findGroup(pool, options, targetFingerprint))?.id ?? proposedId;
  await insertSample(pool, groupId, report);
  await trimSamples(pool, groupId);
}

async function findGroup(pool: SqlPool, options: CreateMysqlSinkOptions, fingerprint: string): Promise<GroupRow | undefined> {
  const [rows] = await pool.execute(
    "SELECT id, status FROM error_group WHERE project = ? AND environment = ? AND fingerprint = ? LIMIT 1",
    [options.project, options.environment, fingerprint],
  );
  return (rows as readonly GroupRow[])[0];
}

async function upsertGroup(
  pool: SqlPool,
  options: CreateMysqlSinkOptions,
  report: SafeReport,
  fingerprint: string,
  id: string,
): Promise<void> {
  const sql = `INSERT INTO error_group
    (id, project, environment, fingerprint, source, error_type, message, top_frame, route, count, first_seen_at, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'new')
    ON DUPLICATE KEY UPDATE
      count = count + 1,
      last_seen_at = VALUES(last_seen_at),
      regressed_at = IF(status = 'resolved', VALUES(last_seen_at), regressed_at),
      resolved_at = IF(status = 'resolved', NULL, resolved_at),
      status_note = IF(status = 'resolved', NULL, status_note),
      status = IF(status = 'resolved', 'new', status)`;
  await pool.execute(sql, [
    id, options.project, options.environment, fingerprint, report.source, report.errorType,
    report.message, report.topFrame, report.route, report.occurredAt, report.occurredAt,
  ]);
}

async function insertSample(pool: SqlPool, groupId: string, report: SafeReport): Promise<void> {
  const start = new Date(report.occurredAt);
  start.setMilliseconds(0);
  const end = new Date(start.getTime() + 1000);
  const sql = `INSERT INTO error_event
    (id, group_id, occurred_at, message, stack, release_tag, user_agent, request_method, status_code)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? FROM DUAL
    WHERE NOT EXISTS (
      SELECT 1 FROM error_event WHERE group_id = ? AND occurred_at >= ? AND occurred_at < ?
    )`;
  await pool.execute(sql, [
    createUlid(report.occurredAt.getTime()), groupId, report.occurredAt, report.message, report.stack,
    report.release, report.userAgent, report.requestMethod, report.statusCode, groupId, start, end,
  ]);
}

async function trimSamples(pool: SqlPool, groupId: string): Promise<void> {
  await pool.execute(
    `DELETE FROM error_event WHERE group_id = ? AND id NOT IN (
      SELECT id FROM (
        SELECT id FROM error_event WHERE group_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ${MAX_EVENT_SAMPLES}
      ) AS recent_samples
    )`,
    [groupId, groupId],
  );
}

function safeReport(report: ErrorReport): SafeReport {
  const stack = truncateUtf8(mask(report.stack ?? ""), 8192);
  const route = report.route == null ? null : normalizeRoute(mask(report.route)).slice(0, 300);
  const topFrame = truncateUtf8(mask(report.topFrame ?? topFrameFromStack(stack, report.source)), 500);
  return {
    source: report.source,
    errorType: truncateUtf8(mask(report.errorType), 200) || "Error",
    message: truncateUtf8(mask(report.message), 1000),
    stack,
    topFrame,
    route,
    occurredAt: report.occurredAt instanceof Date ? report.occurredAt : new Date(),
    release: report.release == null ? null : truncateUtf8(mask(report.release), 100),
    userAgent: report.userAgent == null ? null : truncateUtf8(mask(report.userAgent), 300),
    requestMethod: report.requestMethod == null ? null : truncateUtf8(mask(report.requestMethod.toUpperCase()), 10),
    statusCode: report.statusCode ?? null,
  };
}

function fingerprintReport(report: SafeReport): string {
  const input: FingerprintInput = {
    source: report.source,
    errorType: report.errorType,
    message: report.message,
    topFrame: report.topFrame,
    route: report.route,
  };
  return fingerprint(input);
}

async function exceedsGroupQuota(pool: SqlPool, options: CreateMysqlSinkOptions, timestamp: number): Promise<boolean> {
  const start = hourStart(timestamp);
  const end = start + 3_600_000;
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS group_count FROM error_group
     WHERE project = ? AND environment = ? AND first_seen_at >= ? AND first_seen_at < ?`,
    [options.project, options.environment, new Date(start), new Date(end)],
  );
  const count = Number((rows as readonly { readonly group_count: number | string }[])[0]?.group_count ?? 0);
  return count >= MAX_NEW_GROUPS_PER_HOUR;
}

function hourStart(timestamp: number): number {
  return Math.floor(timestamp / 3_600_000) * 3_600_000;
}

function errorCategory(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const candidate = error as { readonly code?: unknown; readonly name?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  return code ?? name ?? "unknown";
}

function safeLog(logger: ErrorIntakeLogger | undefined, message: string): void {
  try {
    (logger ?? ((text) => console.error(text)))(message);
  } catch {
    // 記錄器失敗不能影響呼叫端。
  }
}

function createFailureLogger(logger: ErrorIntakeLogger | undefined) {
  const previous = new Map<string, number>();
  return {
    once(key: string, message: string) {
      if (previous.has(key)) return;
      previous.set(key, Date.now());
      safeLog(logger, message);
    },
    failure(error: unknown, operation: string) {
      const category = errorCategory(error);
      const key = `${operation}:${category}`;
      const now = Date.now();
      const last = previous.get(key);
      if (last !== undefined && now - last < ERROR_LOG_INTERVAL_MS) return;
      previous.set(key, now);
      safeLog(logger, `Error intake ${operation} failed (${category}); details omitted`);
    },
  };
}

function createUlid(timestamp: number): string {
  const time = BigInt(timestamp);
  const random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  return `${encodeCrockford(time, 10)}${encodeCrockford(random, 16)}`;
}

function encodeCrockford(value: bigint, length: number): string {
  let remaining = value;
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result = `${ALPHABET[Number(remaining & 31n)]}${result}`;
    remaining >>= 5n;
  }
  return result;
}

export function resolveEnvironment(env: Readonly<Record<string, string | undefined>>): ErrorEnvironment {
  const appEnvironment = env.APP_ENV;
  if (appEnvironment === "local" || appEnvironment === "staging" || appEnvironment === "production") return appEnvironment;
  return env.NODE_ENV === "development" || env.NODE_ENV === "test" ? "local" : "production";
}

export { MIGRATIONS, SCHEMA_VERSION };
