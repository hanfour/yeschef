import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkWriterTableIsolation, closePool, createWriterAccount, dropPrivateProbe, dropWriterAccount, rebuildAcceptanceDatabase } from "./database.js";
import { runPackageChecks } from "./package-checks.js";
import { isolatedNodeEnv, runCommand } from "./processes.js";
import { ACCEPTANCE_DATABASE, validateRootDatabaseUrl } from "./pure.js";
import { CheckReporter } from "./report.js";
import { createAcceptanceProjects } from "./projects.js";
import { reportReadmeAlignment } from "./readme-check.js";
import { recordProjectSkipped, runProjectSuite } from "./suite.js";
import type { Pool } from "mysql2/promise";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const resultsRoot = join(packageRoot, "acceptance", "results");

interface Inputs {
  readonly rootUrl: string;
  readonly tarball: string;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly label: string;
}

async function runAcceptance(): Promise<void> {
  const reporter = new CheckReporter();
  const accounts: string[] = [];
  let database: Pool | undefined;
  let workRoot: string | undefined;
  let inputs: Inputs | undefined;

  try {
    inputs = await readInputs(reporter);
    if (inputs) {
      workRoot = await mkdtemp(join(tmpdir(), "ei-pkg-accept-"));
      await reportReadmeAlignment(packageRoot, reporter);
      await runPackageChecks(packageRoot, inputs.nodePath, join(workRoot, "npm-cache"), reporter);
      database = await initializeDatabase(inputs.rootUrl, reporter);
      await runFrameworkProjects(inputs, workRoot, database, accounts, reporter);
    }
  } catch (error) {
    reporter.add("runner", "unexpected failure", false, safeFailure(error));
  } finally {
    if (database) await cleanupDatabase(database, accounts, reporter);
    if (workRoot) await removeWorkDirectory(workRoot, reporter);
  }

  const label = inputs?.label ?? makeLabel("node-unknown");
  const passed = reporter.passed;
  const checked = reporter.checks.length + 1;
  reporter.add("summary", "all checks passed", passed, `${checked} checks recorded; ${passed ? "passed" : "one or more failed"}; report ${label}.json`);
  const saved = await saveReport(label, inputs?.nodeVersion ?? "unknown", reporter);
  process.exitCode = reporter.passed && saved ? 0 : 1;
}

async function readInputs(reporter: CheckReporter): Promise<Inputs | undefined> {
  const rootUrl = process.env.EI_PKG_ROOT_URL;
  const rootValidation = validateRootDatabaseUrl(rootUrl);
  reporter.add("preflight", "root MySQL URL targets ei_pkg_accept", rootValidation.ok, rootValidation.ok ? "root connection targets ei_pkg_accept" : rootValidation.detail);

  const tarball = await validateTarball(process.env.EI_PKG_TARBALL);
  reporter.add("preflight", "absolute npm tarball exists", tarball !== undefined, tarball ? "absolute .tgz file found" : "EI_PKG_TARBALL must be an absolute path to an existing .tgz file");

  const node = await validateNodeExecutable(process.env.EI_PKG_NODE);
  reporter.add("preflight", "Node 20 or Node 24 executable", node !== undefined, node ? `Node ${node.version}` : "EI_PKG_NODE must point to an executable Node 20 or Node 24 binary");

  if (!rootValidation.ok || !rootUrl || !tarball || !node) return undefined;
  return { rootUrl, tarball, nodePath: node.path, nodeVersion: node.version, label: makeLabel(`node${node.major}`) };
}

async function validateTarball(value: string | undefined): Promise<string | undefined> {
  if (!value || !isAbsolute(value) || !value.endsWith(".tgz")) return undefined;
  try {
    const path = await realpath(value);
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

async function validateNodeExecutable(value: string | undefined): Promise<{ readonly path: string; readonly version: string; readonly major: number } | undefined> {
  if (!value || !isAbsolute(value)) return undefined;
  try {
    const path = await realpath(value);
    await access(path, constants.X_OK);
    const result = await runCommand(path, ["--version"], {
      cwd: packageRoot,
      env: isolatedNodeEnv(path),
      timeoutMs: 10_000,
    });
    const version = /^v?(20|24)\.\d+\.\d+\s*$/.exec(result.stdout.trim());
    if (result.code !== 0 || !version) return undefined;
    const major = Number(version[1]);
    return { path, version: result.stdout.trim().replace(/^v/, ""), major };
  } catch {
    return undefined;
  }
}

async function initializeDatabase(rootUrl: string, reporter: CheckReporter): Promise<Pool | undefined> {
  try {
    const database = await rebuildAcceptanceDatabase(rootUrl);
    reporter.add("database", "rebuild ei_pkg_accept and run MIGRATIONS", true, `database rebuilt; package migrations applied; schema ${ACCEPTANCE_DATABASE}`);
    return database;
  } catch (error) {
    reporter.add("database", "rebuild ei_pkg_accept and run MIGRATIONS", false, safeFailure(error));
    return undefined;
  }
}

async function runFrameworkProjects(
  inputs: Inputs,
  workRoot: string,
  database: Pool | undefined,
  accounts: string[],
  reporter: CheckReporter,
): Promise<void> {
  const projects = createAcceptanceProjects();
  if (!database) {
    for (const project of projects) recordProjectSkipped(project, reporter, "database setup failed; project checks were not run");
    return;
  }
  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index]!;
    await runSingleProject(project, index, inputs, workRoot, database, accounts, reporter);
  }
}

async function runSingleProject(
  project: ReturnType<typeof createAcceptanceProjects>[number],
  index: number,
  inputs: Inputs,
  workRoot: string,
  database: Pool,
  accounts: string[],
  reporter: CheckReporter,
): Promise<void> {
  try {
    const writer = await createWriterAccount(database, inputs.rootUrl, project.projectCode);
    accounts.push(writer.username);
    reporter.add(project.kind, "least-privilege writer account", true, "created with grants for the three error tables");
    if (index === 0) await checkWriterPermissions(writer.url, reporter);
    await runProjectSuite(project, {
      workRoot,
      packageRoot,
      tarball: inputs.tarball,
      nodePath: inputs.nodePath,
      electronPath: join(repositoryRoot, "node_modules", ".bin", "electron"),
      database,
      writer,
      reporter,
    });
  } catch (error) {
    recordProjectSkipped(project, reporter, `account or project setup failed (${safeFailure(error)})`);
  }
}

async function checkWriterPermissions(writerUrl: string, reporter: CheckReporter): Promise<void> {
  try {
    const isolated = await checkWriterTableIsolation(writerUrl);
    reporter.add("database", "writer cannot read or write other tables", isolated, isolated ? "SELECT, INSERT, and CREATE probes were denied" : "one or more unrelated table probes were allowed");
  } catch (error) {
    reporter.add("database", "writer cannot read or write other tables", false, safeFailure(error));
  }
}

async function cleanupDatabase(database: Pool, accounts: readonly string[], reporter: CheckReporter): Promise<void> {
  let usersRemoved = true;
  for (const username of accounts) {
    try {
      await dropWriterAccount(database, username);
    } catch {
      usersRemoved = false;
    }
  }
  reporter.add("cleanup", "remove temporary writer accounts", usersRemoved, usersRemoved ? "all generated accounts were dropped" : "one or more generated accounts could not be dropped");
  try {
    await dropPrivateProbe(database);
    reporter.add("cleanup", "remove private table probe", true, "probe table dropped");
  } catch (error) {
    reporter.add("cleanup", "remove private table probe", false, safeFailure(error));
  }
  try {
    await closePool(database);
    reporter.add("cleanup", "close administrator connection", true, "connection closed");
  } catch (error) {
    reporter.add("cleanup", "close administrator connection", false, safeFailure(error));
  }
}

async function removeWorkDirectory(workRoot: string, reporter: CheckReporter): Promise<void> {
  try {
    await rm(workRoot, { recursive: true, force: true });
    reporter.add("cleanup", "remove temporary projects", true, "temporary directory removed");
  } catch (error) {
    reporter.add("cleanup", "remove temporary projects", false, safeFailure(error));
  }
}

async function saveReport(label: string, nodeVersion: string, reporter: CheckReporter): Promise<boolean> {
  try {
    await mkdir(resultsRoot, { recursive: true });
    await writeFile(join(resultsRoot, `${label}.json`), JSON.stringify({ label, nodeVersion, checks: reporter.checks }, null, 2), { mode: 0o600 });
    return true;
  } catch {
    process.stderr.write("Could not write the credential-free acceptance result file.\n");
    return false;
  }
}

function safeFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return "operation failed";
  const name = "name" in error && typeof error.name === "string" ? error.name : "Error";
  const code = "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : undefined;
  return code ? `${name} (${code})` : name;
}

function makeLabel(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${prefix}-${timestamp}-${randomBytes(3).toString("hex")}`;
}

void runAcceptance();
