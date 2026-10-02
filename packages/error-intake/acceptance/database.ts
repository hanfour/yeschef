import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "mysql2/promise";
import { MIGRATIONS } from "../dist/index.js";
import { ACCEPTANCE_DATABASE } from "./pure.js";

const PRIVATE_PROBE = "ei_pkg_accept_private_probe";
const WRITER_USERS = [
  "ei_w_express4_cjs",
  "ei_w_express5_esm",
  "ei_w_nest_cjs",
  "ei_w_next_app",
] as const;
const EXPECTED_ACCESS_ERRORS = new Set(["ER_TABLEACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_SPECIFIC_ACCESS_DENIED_ERROR"]);

export interface WriterAccount {
  readonly username: string;
  readonly url: string;
}

export async function rebuildAcceptanceDatabase(rootUrl: string): Promise<Pool> {
  // 重建時資料庫還不存在，先用不指定資料庫的連線；`USE` 只影響 pool 中的一條連線，所以建好後另開指定資料庫的 pool。
  const serverUrl = new URL(rootUrl);
  serverUrl.pathname = "/";
  const admin = createPool({ uri: serverUrl.toString(), connectionLimit: 1 });
  try {
    for (const username of WRITER_USERS) await admin.query(`DROP USER IF EXISTS '${username}'@'%'`);
    await admin.query(`DROP DATABASE IF EXISTS \`${ACCEPTANCE_DATABASE}\``);
    await admin.query(`CREATE DATABASE \`${ACCEPTANCE_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await admin.end();
  }
  const pool = createPool({ uri: rootUrl, connectionLimit: 3, waitForConnections: true, queueLimit: 0 });
  try {
    for (const migration of MIGRATIONS) await pool.query(migration);
    await pool.query(`CREATE TABLE \`${PRIVATE_PROBE}\` (id INT NOT NULL PRIMARY KEY, value VARCHAR(20) NOT NULL)`);
    await pool.query(`INSERT INTO \`${PRIVATE_PROBE}\` (id, value) VALUES (1, 'private')`);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function createWriterAccount(rootPool: Pool, rootUrl: string, projectCode: string): Promise<WriterAccount> {
  const username = `ei_w_${projectCode.slice("ei_acc_".length)}`;
  const password = randomBytes(32).toString("hex");
  const account = `'${username}'@'%'`;
  await rootPool.query(`DROP USER IF EXISTS ${account}`);
  await rootPool.query(`CREATE USER ${account} IDENTIFIED BY ?`, [password]);
  await rootPool.query(`GRANT SELECT, INSERT, UPDATE ON \`${ACCEPTANCE_DATABASE}\`.\`error_group\` TO ${account}`);
  await rootPool.query(`GRANT SELECT, INSERT, DELETE ON \`${ACCEPTANCE_DATABASE}\`.\`error_event\` TO ${account}`);
  await rootPool.query(`GRANT SELECT ON \`${ACCEPTANCE_DATABASE}\`.\`error_intake_meta\` TO ${account}`);
  const writerUrl = new URL(rootUrl);
  writerUrl.username = username;
  writerUrl.password = password;
  return { username, url: writerUrl.href };
}

export async function dropWriterAccount(rootPool: Pool, username: string): Promise<void> {
  await rootPool.query(`DROP USER IF EXISTS '${username}'@'%'`);
}

export async function dropPrivateProbe(rootPool: Pool): Promise<void> {
  await rootPool.query(`DROP TABLE IF EXISTS \`${PRIVATE_PROBE}\``);
}

export async function checkWriterTableIsolation(writerUrl: string): Promise<boolean> {
  const pool = createPool({ uri: writerUrl, connectionLimit: 1, waitForConnections: true, queueLimit: 0 });
  try {
    await pool.query("SELECT 1");
    const selectDenied = await expectAccessDenied(pool, `SELECT value FROM \`${ACCEPTANCE_DATABASE}\`.\`${PRIVATE_PROBE}\` WHERE id = 1`);
    const insertDenied = await expectAccessDenied(pool, `INSERT INTO \`${ACCEPTANCE_DATABASE}\`.\`${PRIVATE_PROBE}\` (id, value) VALUES (2, 'blocked')`);
    const createDenied = await expectAccessDenied(pool, `CREATE TABLE \`${ACCEPTANCE_DATABASE}\`.\`ei_pkg_accept_forbidden\` (id INT)`);
    return selectDenied && insertDenied && createDenied;
  } finally {
    await pool.end();
  }
}

export async function readRows<T>(pool: Pool, sql: string, values: readonly unknown[] = []): Promise<readonly T[]> {
  const [rows] = await pool.query(sql, [...values]);
  return rows as T[];
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}

async function expectAccessDenied(pool: Pool, sql: string): Promise<boolean> {
  try {
    await pool.query(sql);
    return false;
  } catch (error) {
    return EXPECTED_ACCESS_ERRORS.has(errorCode(error));
  }
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code : "";
}
