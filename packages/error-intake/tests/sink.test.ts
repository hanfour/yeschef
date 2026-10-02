import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorEnvironment, ErrorReport } from "../src/types.js";

const mysqlMock = vi.hoisted(() => ({ pool: undefined as unknown, options: undefined as unknown }));
vi.mock("mysql2/promise", () => ({ createPool: (options: unknown) => { mysqlMock.options = options; return mysqlMock.pool; } }));

import { createMysqlSink, resolveEnvironment } from "../src/index.js";

interface TestGroup {
  id: string;
  project: string;
  environment: ErrorEnvironment;
  fingerprint: string;
  source: string;
  errorType: string;
  message: string;
  topFrame: string;
  route: string | null;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  status: string;
  statusNote: string | null;
  resolvedAt: Date | null;
  regressedAt: Date | null;
}

interface TestEvent {
  id: string;
  groupId: string;
  occurredAt: Date;
  message: string;
  stack: string;
}

class FakePool {
  readonly groups = new Map<string, TestGroup>();
  readonly events: TestEvent[] = [];
  readonly statements: string[] = [];
  readonly listeners = new Map<string, (connection: { readonly stream: { ref(): void; unref(): void } }) => void>();
  readonly pool = {
    on: (event: string, listener: (connection: { readonly stream: { ref(): void; unref(): void } }) => void) => {
      this.listeners.set(event, listener);
    },
  };
  version = 1;
  failCode: string | undefined;
  ended = false;

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    if (this.failCode) throw Object.assign(new Error("simulated database failure"), { code: this.failCode });
    const statement = sql.replace(/\s+/g, " ").trim();
    this.statements.push(statement);
    if (statement.startsWith("SELECT schema_version")) return [[{ schema_version: this.version }], []];
    if (statement.startsWith("SELECT COUNT(*) AS group_count")) return [[{ group_count: this.countCreated(values) }], []];
    if (statement.startsWith("SELECT id, status FROM error_group")) return [this.find(values), []];
    if (statement.startsWith("INSERT INTO error_group")) return [this.upsert(values), []];
    if (statement.startsWith("INSERT INTO error_event")) return [this.insertEvent(values), []];
    if (statement.startsWith("DELETE FROM error_event")) return [this.trimEvents(values), []];
    throw new Error(`Unexpected SQL: ${statement}`);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  private find(values: readonly unknown[]): TestGroup[] {
    const [project, environment, fingerprint] = values;
    const group = [...this.groups.values()].find((item) => item.project === project && item.environment === environment && item.fingerprint === fingerprint);
    return group ? [{ ...group }] : [];
  }

  private countCreated(values: readonly unknown[]): number {
    const [project, environment, start, end] = values;
    return [...this.groups.values()].filter((group) =>
      group.project === project && group.environment === environment &&
      group.firstSeenAt >= (start as Date) && group.firstSeenAt < (end as Date),
    ).length;
  }

  private upsert(values: readonly unknown[]): { readonly affectedRows: number } {
    const [id, project, environment, fingerprint, source, errorType, message, topFrame, route, firstSeenAt, lastSeenAt] = values;
    const current = [...this.groups.values()].find((group) => group.project === project && group.environment === environment && group.fingerprint === fingerprint);
    if (current) {
      current.count += 1;
      current.lastSeenAt = lastSeenAt as Date;
      if (current.status === "resolved") {
        current.regressedAt = lastSeenAt as Date;
        current.resolvedAt = null;
        current.statusNote = null;
        current.status = "new";
      }
      return { affectedRows: 2 };
    }
    this.groups.set(String(id), {
      id: String(id), project: String(project), environment: environment as ErrorEnvironment,
      fingerprint: String(fingerprint), source: String(source), errorType: String(errorType),
      message: String(message), topFrame: String(topFrame), route: route as string | null,
      count: 1, firstSeenAt: firstSeenAt as Date, lastSeenAt: lastSeenAt as Date,
      status: "new", statusNote: null, resolvedAt: null, regressedAt: null,
    });
    return { affectedRows: 1 };
  }

  private insertEvent(values: readonly unknown[]): { readonly affectedRows: number } {
    const [id, groupId, occurredAt, message, stack, , , , , , start, end] = values;
    const exists = this.events.some((event) => event.groupId === groupId && event.occurredAt >= (start as Date) && event.occurredAt < (end as Date));
    if (exists) return { affectedRows: 0 };
    this.events.push({ id: String(id), groupId: String(groupId), occurredAt: occurredAt as Date, message: String(message), stack: String(stack) });
    return { affectedRows: 1 };
  }

  private trimEvents(values: readonly unknown[]): { readonly affectedRows: number } {
    const groupId = String(values[0]);
    const recent = this.events.filter((event) => event.groupId === groupId)
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id))
      .slice(0, 20);
    const retained = new Set(recent.map((event) => event.id));
    const before = this.events.length;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]?.groupId === groupId && !retained.has(this.events[index]?.id ?? "")) this.events.splice(index, 1);
    }
    return { affectedRows: before - this.events.length };
  }
}

describe("createMysqlSink", () => {
  let pool: FakePool;

  beforeEach(() => {
    pool = new FakePool();
    mysqlMock.pool = pool;
  });

  it("groups repeated errors, increments count, and keeps one sample per second", async () => {
    const sink = createMysqlSink(options());
    await sink.record(report({ occurredAt: new Date("2026-10-01T10:00:00.100Z") }));
    await sink.record(report({ occurredAt: new Date("2026-10-01T10:00:00.900Z") }));
    const group = onlyGroup(pool);
    expect(group.count).toBe(2);
    expect(pool.events).toHaveLength(1);
    await sink.close();
  });

  it("stamps occurredAt when the error is recorded, not when the queued write runs", async () => {
    // 第一筆在等資料庫時，後面的錯誤排隊；若等到寫入時才補時間，兩筆會落在同一秒，第二筆樣本被擋掉。
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const execute = pool.execute.bind(pool);
      pool.execute = async (sql, values) => {
        if (sql.includes("schema_version")) await gate;
        return execute(sql, values);
      };
      const sink = createMysqlSink(options());
      const { occurredAt: _omit, ...withoutTime } = report();
      vi.setSystemTime(new Date("2026-10-01T10:00:00.950Z"));
      const first = sink.record(withoutTime);
      vi.setSystemTime(new Date("2026-10-01T10:00:02.050Z"));
      const second = sink.record(withoutTime);
      vi.setSystemTime(new Date("2026-10-01T10:00:05.000Z"));
      release();
      await Promise.all([first, second]);
      expect(onlyGroup(pool).count).toBe(2);
      expect(pool.events.map((event) => event.occurredAt.toISOString())).toEqual([
        "2026-10-01T10:00:00.950Z", "2026-10-01T10:00:02.050Z",
      ]);
      await sink.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes resolved groups back to new and records regression time", async () => {
    const sink = createMysqlSink(options());
    await sink.record(report());
    const group = onlyGroup(pool);
    group.status = "resolved";
    group.resolvedAt = new Date("2026-09-30T00:00:00.000Z");
    await sink.record(report({ occurredAt: new Date("2026-10-01T10:00:01.000Z") }));
    expect(group.status).toBe("new");
    expect(group.resolvedAt).toBeNull();
    expect(group.regressedAt).toEqual(new Date("2026-10-01T10:00:01.000Z"));
    await sink.close();
  });

  it("retains at most twenty recent samples per group", async () => {
    const sink = createMysqlSink(options());
    for (let second = 0; second < 25; second += 1) {
      await sink.record(report({ occurredAt: new Date(`2026-10-01T10:00:${String(second).padStart(2, "0")}.000Z`) }));
    }
    expect(pool.events).toHaveLength(20);
    expect(pool.events.some((event) => event.occurredAt.getUTCSeconds() === 24)).toBe(true);
    expect(pool.events.some((event) => event.occurredAt.getUTCSeconds() === 4)).toBe(false);
    await sink.close();
  });

  it("caps new groups at two hundred and merges later groups into overflow", async () => {
    const sink = createMysqlSink(options());
    const now = Date.now();
    for (let index = 0; index < 202; index += 1) {
      await sink.record(report({ errorType: `ErrorType-${index}`, occurredAt: new Date(now + index * 1000) }));
    }
    const normalGroups = [...pool.groups.values()].filter((group) => group.fingerprint !== "overflow");
    const overflow = [...pool.groups.values()].find((group) => group.fingerprint === "overflow");
    expect(normalGroups).toHaveLength(200);
    expect(overflow?.count).toBe(2);
    await sink.record(report({ errorType: "ErrorType-0", occurredAt: new Date(now + 203_000) }));
    expect(normalGroups[0]?.count).toBe(2);
    await sink.close();
  });

  it("stops after a schema version mismatch and logs it once", async () => {
    pool.version = 0;
    const logger = vi.fn();
    const sink = createMysqlSink({ ...options(), logger });
    await sink.record(report());
    await sink.record(report({ message: "another message" }));
    expect(pool.groups.size).toBe(0);
    expect(logger).toHaveBeenCalledTimes(1);
    await sink.close();
  });

  it("swallows database errors and rate limits repeated logs", async () => {
    vi.useFakeTimers();
    pool.failCode = "ECONNREFUSED";
    const logger = vi.fn();
    const sink = createMysqlSink({ ...options(), logger });
    await expect(sink.record(report())).resolves.toBeUndefined();
    await expect(sink.record(report())).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60 * 1000);
    await sink.record(report());
    expect(logger).toHaveBeenCalledTimes(2);
    await sink.close();
    vi.useRealTimers();
  });

  it("closes its pool and resolves environments", async () => {
    const sink = createMysqlSink(options());
    await sink.close();
    expect(pool.ended).toBe(true);
    expect(resolveEnvironment({ APP_ENV: "staging", NODE_ENV: "test" })).toBe("staging");
    expect(resolveEnvironment({ APP_ENV: "invalid", NODE_ENV: "development" })).toBe("local");
    expect(resolveEnvironment({ NODE_ENV: "production" })).toBe("production");
  });

  it("finishes queued writes before closing the pool", async () => {
    const sink = createMysqlSink(options());
    const write = sink.record(report());
    const close = sink.close();
    await Promise.all([write, close]);
    expect(pool.groups).toHaveProperty("size", 1);
    expect(pool.ended).toBe(true);
  });

  it("keeps active MySQL sockets referenced and releases idle sockets", async () => {
    const sink = createMysqlSink(options());
    const ref = vi.fn();
    const unref = vi.fn();
    const connection = { stream: { ref, unref } };
    expect(mysqlMock.options).toMatchObject({ connectionLimit: 2, waitForConnections: true });
    pool.listeners.get("acquire")?.(connection);
    pool.listeners.get("release")?.(connection);
    expect(ref).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    await sink.close();
  });

  it("writes regression time before the status change in the upsert", async () => {
    const sink = createMysqlSink(options());
    await sink.record(report());
    const upsert = pool.statements.find((statement) => statement.startsWith("INSERT INTO error_group")) ?? "";
    expect(upsert.indexOf("regressed_at =")).toBeLessThan(upsert.indexOf("status = IF"));
    await sink.close();
  });
});

function options() {
  return { url: "mysql://test:test@localhost/test", project: "test-project", environment: "local" as const };
}

function report(overrides: Partial<ErrorReport> = {}): ErrorReport {
  return {
    source: "server",
    errorType: "TypeError",
    message: "Cannot read value",
    stack: "TypeError: Cannot read value\n at run (/app/source.js:10:2)",
    topFrame: "at run (/app/source.js:10:2)",
    route: "/items/:id",
    occurredAt: new Date("2026-10-01T10:00:00.000Z"),
    ...overrides,
  };
}

function onlyGroup(database: FakePool): TestGroup {
  const group = [...database.groups.values()][0];
  if (!group) throw new Error("Expected an error group");
  return group;
}
