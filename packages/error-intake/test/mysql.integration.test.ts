import { randomUUID } from "node:crypto";
import { createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMysqlSink, MIGRATIONS } from "../src/index.js";

const url = process.env.ERROR_INTAKE_TEST_MYSQL_URL;
const integrationTest = url ? it : it.skip;
const project = `integration-${randomUUID().slice(0, 8)}`;

describe("MySQL integration", () => {
  const adminPool = url ? createPool({ uri: url, connectionLimit: 2 }) : undefined;

  beforeAll(async () => {
    if (!adminPool) return;
    for (const migration of MIGRATIONS) await adminPool.execute(migration);
  });

  afterAll(async () => {
    if (!adminPool) return;
    await adminPool.execute("DELETE FROM error_group WHERE project = ?", [project]);
    await adminPool.end();
  });

  integrationTest("writes, reads, masks, and regresses grouped errors", async () => {
    if (!url || !adminPool) return;
    const sink = createMysqlSink({ url, project, environment: "local" });
    const repeated = {
      source: "server" as const,
      errorType: "TypeError",
      message: "Cannot read item",
      stack: "TypeError: Cannot read item\n at load (/app/api.js:4:2)",
      topFrame: "at load (/app/api.js:4:2)",
      route: "/items/:id",
    };
    try {
      for (let index = 0; index < 3; index += 1) {
        await sink.record({ ...repeated, occurredAt: new Date(Date.now() + index * 1000) });
      }
      const [groupRows] = await adminPool.execute(
        "SELECT id, count, status, regressed_at FROM error_group WHERE project = ? AND environment = 'local' AND error_type = 'TypeError'",
        [project],
      );
      const grouped = (groupRows as unknown as readonly GroupRow[])[0];
      if (!grouped) throw new Error("Expected a grouped error row");
      expect(grouped?.count).toBe(3);
      const [eventRows] = await adminPool.execute("SELECT id FROM error_event WHERE group_id = ?", [grouped.id]);
      expect(eventRows).toHaveLength(3);

      const maskedMessage = "email jane@example.com Bearer secret-token https://gw.test/auth-gateway?key=gateway-leak number 1234567890 password=hunter2";
      await sink.record({ ...repeated, errorType: "MaskedError", message: maskedMessage, stack: maskedMessage, occurredAt: new Date(Date.now() + 4000) });
      const [maskedRows] = await adminPool.execute(
        "SELECT message FROM error_group WHERE project = ? AND error_type = 'MaskedError'",
        [project],
      );
      const masked = (maskedRows as unknown as readonly { readonly message: string }[])[0]?.message ?? "";
      expect(masked).toContain("<email>");
      expect(masked).toContain("<token>");
      expect(masked).toContain("https://gw.test/auth-gateway");
      expect(masked).toContain("<number>");
      expect(masked).toContain("password=<redacted>");
      expect(masked).not.toMatch(/jane@example\.com|secret-token|gateway-leak|1234567890|hunter2/);

      await adminPool.execute("UPDATE error_group SET status = 'resolved', resolved_at = NOW(3) WHERE id = ?", [grouped.id]);
      await sink.record({ ...repeated, occurredAt: new Date(Date.now() + 5000) });
      const [regressedRows] = await adminPool.execute("SELECT status, regressed_at FROM error_group WHERE id = ?", [grouped.id]);
      const regressed = (regressedRows as unknown as readonly Pick<GroupRow, "status" | "regressed_at">[])[0];
      expect(regressed?.status).toBe("new");
      expect(regressed?.regressed_at).not.toBeNull();
    } finally {
      await sink.close();
    }
  });

  // 同一個 sink 內寫入會排隊；會撞在一起的是多個行程（多個部署實例）。兩個 sink 同時寫同一個新錯誤時，
  // 都查不到群、各自產生 id；後寫的那筆要用實際存在的群 id 寫樣本，不能因外鍵失敗而掉樣本。
  integrationTest("keeps samples when two processes record the same new error at once", async () => {
    if (!url || !adminPool) return;
    const failures: string[] = [];
    const logger = (message: string): void => { failures.push(message); };
    const sinks = [createMysqlSink({ url, project, environment: "local", logger }), createMysqlSink({ url, project, environment: "local", logger })];
    const base = { source: "server" as const, errorType: "RangeError", message: "Concurrent burst", stack: "RangeError: Concurrent burst\n at burst (/app/burst.js:1:1)", topFrame: "at burst (/app/burst.js:1:1)", route: "/burst" };
    try {
      await Promise.all([0, 1, 2, 3].map((index) => sinks[index % 2]!.record({ ...base, occurredAt: new Date(Date.now() + index * 1000) })));
      const [groups] = await adminPool.execute("SELECT id, count FROM error_group WHERE project = ? AND error_type = 'RangeError'", [project]);
      const rows = groups as unknown as readonly Pick<GroupRow, "id" | "count">[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.count).toBe(4);
      const groupId = rows[0]?.id ?? "";
      const [events] = await adminPool.execute("SELECT COUNT(*) AS n FROM error_event WHERE group_id = ?", [groupId]);
      expect((events as unknown as readonly { readonly n: number }[])[0]?.n).toBe(4);
      expect(failures).toEqual([]);
    } finally {
      await Promise.all(sinks.map((sink) => sink.close()));
    }
  });
});

interface GroupRow {
  readonly id: string;
  readonly count: number;
  readonly status: string;
  readonly regressed_at: Date | null;
}
