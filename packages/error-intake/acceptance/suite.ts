import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "mysql2/promise";
import type { WriterAccount } from "./database.js";
import type { AcceptanceProject } from "./projects.js";
import type { CheckReporter } from "./report.js";
import { acquireFreePort, isolatedNodeEnv, runCommand, startManagedProcess, stopProcessGroup, type ManagedProcess } from "./processes.js";
import {
  containsRawMarkers,
  hasBrowserFailure,
  readProjectCounts,
  readServerFailureMetrics,
  type ProjectCounts,
} from "./observations.js";

const COMMAND_TIMEOUT_MS = 12 * 60_000;
const SERVER_FAILURE_MARKERS: Readonly<Record<AcceptanceProject["kind"], string>> = {
  "express4-cjs": "EI_ACCEPTANCE_SERVER_FAILURE",
  "express5-esm": "EI_ACCEPTANCE_SERVER_FAILURE",
  "nest-cjs": "EI_ACCEPTANCE_SERVER_FAILURE",
  "next-app": "EI_ACCEPTANCE_NEXT_SERVER_FAILURE",
};

export interface SuiteOptions {
  readonly workRoot: string;
  readonly packageRoot: string;
  readonly tarball: string;
  readonly nodePath: string;
  readonly electronPath: string;
  readonly database: Pool;
  readonly writer: WriterAccount;
  readonly reporter: CheckReporter;
}

export async function runProjectSuite(project: AcceptanceProject, options: SuiteOptions): Promise<void> {
  await runProject(project, options);
}

export function recordProjectSkipped(project: AcceptanceProject, reporter: CheckReporter, detail: string): void {
  reporter.add(project.kind, "least-privilege writer account", false, detail);
  reporter.add(project.kind, "install tarball and framework", false, detail);
  recordCompilationSkipped(project, reporter, detail);
  recordUnrunProjectChecks(project, reporter, detail);
}

async function runProject(project: AcceptanceProject, options: SuiteOptions): Promise<void> {
  const projectDir = join(options.workRoot, project.kind);
  await writeProject(projectDir, project);
  const installOk = await installProject(project, projectDir, options);
  options.reporter.add(project.kind, "install tarball and framework", installOk, installOk ? "npm install completed" : "npm install failed or timed out");
  if (!installOk) {
    recordCompilationSkipped(project, options.reporter, "compilation skipped because installation failed");
    recordUnrunProjectChecks(project, options.reporter, "runtime checks skipped because installation failed");
    return;
  }
  const compileOk = await compileProject(project, projectDir, options);
  if (!compileOk) {
    recordUnrunProjectChecks(project, options.reporter, "runtime checks skipped because build or compilation failed");
    return;
  }
  const server = await startProjectServer(project, projectDir, options);
  options.reporter.add(project.kind, "server startup", server !== undefined, server ? `ready on port ${server.port}; pid ${server.process.pid}` : "server did not become ready on an available port");
  if (!server) {
    recordUnrunProjectChecks(project, options.reporter, "HTTP checks skipped because the server did not start");
    return;
  }
  try {
    await checkServerErrors(project, server.port, options);
    if (project.kind === "next-app") await checkNextBrowserError(project, projectDir, server.port, options);
    await checkBrowserReceiver(project, server.port, options);
  } finally {
    await stopProcessGroup(server.process);
  }
}

async function installProject(project: AcceptanceProject, projectDir: string, options: SuiteOptions): Promise<boolean> {
  const env = isolatedEnv(options.nodePath, options.workRoot);
  const tarball = await runCommand("npm", ["install", options.tarball], { cwd: projectDir, env, timeoutMs: COMMAND_TIMEOUT_MS });
  if (!succeeded(tarball)) return false;
  const dependencies = [...project.dependencies, ...project.devDependencies];
  if (dependencies.length === 0) return true;
  const installed = await runCommand("npm", ["install", "--no-audit", "--no-fund", ...dependencies], {
    cwd: projectDir,
    env,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return succeeded(installed);
}

async function compileProject(project: AcceptanceProject, projectDir: string, options: SuiteOptions): Promise<boolean> {
  if (project.kind === "express4-cjs" || project.kind === "express5-esm") {
    options.reporter.add(project.kind, "TypeScript compilation", true, "not applicable to this JavaScript sample");
    return true;
  }
  const result = await runCommand("npm", ["run", "build"], {
    cwd: projectDir,
    env: isolatedEnv(options.nodePath, options.workRoot),
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const ok = succeeded(result);
  const check = project.kind === "nest-cjs" ? "tsc compile (module node16)" : "next build";
  // 失敗時附上輸出的最後幾行（不含連線字串，建置輸出只有專案自己的訊息），否則無從判斷原因。
  const tail = `${result.stdout}\n${result.stderr}`.split("\n").filter(line => line.trim() !== "").slice(-12).join(" | ").slice(-1500);
  options.reporter.add(project.kind, check, ok, ok ? "completed successfully" : `build or compilation failed (code=${result.code}, timedOut=${result.timedOut}): ${tail}`);
  return ok;
}

async function startProjectServer(
  project: AcceptanceProject,
  projectDir: string,
  options: SuiteOptions,
): Promise<{ readonly process: ManagedProcess; readonly port: number } | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await acquireFreePort();
    const token = randomBytes(12).toString("hex");
    const env = appEnv(options.nodePath, options.writer, project.projectCode, port, token);
    const process = spawnProjectServer(project, projectDir, env, port, options.nodePath);
    if (await waitUntilReady(process, project.kind, port, token)) return { process, port };
    await stopProcessGroup(process);
  }
  return undefined;
}

function spawnProjectServer(
  project: AcceptanceProject,
  projectDir: string,
  env: NodeJS.ProcessEnv,
  port: number,
  nodePath: string,
): ManagedProcess {
  if (project.kind === "express4-cjs") return startManagedProcess(nodePath, ["server.cjs"], { cwd: projectDir, env });
  if (project.kind === "express5-esm") return startManagedProcess(nodePath, ["server.mjs"], { cwd: projectDir, env });
  if (project.kind === "nest-cjs") return startManagedProcess(nodePath, ["dist/main.js"], { cwd: projectDir, env });
  return startManagedProcess("npm", ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: projectDir, env });
}

async function waitUntilReady(process: ManagedProcess, kind: AcceptanceProject["kind"], port: number, token: string): Promise<boolean> {
  const path = kind === "next-app" ? "/api/acceptance-ready" : "/";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.child.exitCode !== null || process.child.signalCode !== null || process.state.error) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1_500) });
      if (response.status === 200 && await response.text() === token) return true;
      await delay(300);
    } catch {
      await delay(300);
    }
  }
  return false;
}

async function checkServerErrors(project: AcceptanceProject, port: number, options: SuiteOptions): Promise<void> {
  const marker = SERVER_FAILURE_MARKERS[project.kind];
  const statuses = await triggerServerErrors(port);
  const metrics = await waitForServerMetrics(options.database, project.projectCode, marker);
  const ok = statuses.length === 3 && statuses.every((status) => status === 500) &&
    metrics.groupCount === 1 && metrics.count === 3 && metrics.samples === 3 && metrics.statusCode === 500;
  const check = project.kind === "next-app" ? "onRequestError and 500 grouping" : "500 grouping and samples";
  options.reporter.add(project.kind, check, ok, `statuses=${statuses.join(",") || "none"}; groups=${metrics.groupCount}; count=${metrics.count}; samples=${metrics.samples}; status=${metrics.statusCode ?? "none"}`);

  const before = await readProjectCounts(options.database, project.projectCode);
  const badRequestStatus = await requestStatus(`http://127.0.0.1:${port}/bad-request`);
  await delay(700);
  const after = await readProjectCounts(options.database, project.projectCode);
  const badRequestOk = badRequestStatus === 400 && sameCounts(before, after);
  options.reporter.add(project.kind, "400 does not write to MySQL", badRequestOk, `status=${badRequestStatus ?? "no response"}; groups delta=${after.groups - before.groups}; samples delta=${after.samples - before.samples}`);
}

async function triggerServerErrors(port: number): Promise<readonly (number | undefined)[]> {
  const statuses: (number | undefined)[] = [];
  for (let index = 0; index < 3; index += 1) {
    const status = await requestStatus(`http://127.0.0.1:${port}/boom`);
    statuses.push(status);
    if (index < 2) await delay(1_100);
  }
  return statuses;
}

async function waitForServerMetrics(pool: Pool, project: string, marker: string) {
  let previous = "";
  let stable = 0;
  let metrics = await readServerFailureMetrics(pool, project, marker);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    metrics = await readServerFailureMetrics(pool, project, marker);
    const signature = `${metrics.groupCount}:${metrics.count}:${metrics.samples}:${metrics.statusCode}`;
    stable = metrics.groupCount === 1 && metrics.count === 3 && metrics.samples === 3 ? stable + Number(signature === previous) : 0;
    if (stable >= 3) return metrics;
    previous = signature;
    await delay(250);
  }
  return metrics;
}

async function checkBrowserReceiver(project: AcceptanceProject, port: number, options: SuiteOptions): Promise<void> {
  const endpoint = receiverPath(project.kind);
  const headers = project.kind === "next-app" ? { "x-forwarded-for": "198.51.100.31" } : {};
  // 頻率限制以時鐘的整分鐘計算，下面 31 次請求若跨過整分鐘會重新計數；離下一分鐘不到 20 秒就先等到下一分鐘。
  await waitForFreshMinute();
  const beforeOversize = await readProjectCounts(options.database, project.projectCode);
  const oversizeResponse = await postText(endpointUrl(port, endpoint), oversizedPayload(), headers);
  const afterOversize = await readProjectCounts(options.database, project.projectCode);
  const oversizeOk = oversizeResponse === 204 && sameCounts(beforeOversize, afterOversize);
  options.reporter.add(project.kind, "over 16 KB report is dropped", oversizeOk, `status=${oversizeResponse ?? "no response"}; database unchanged=${sameCounts(beforeOversize, afterOversize)}`);

  const sensitiveResponse = await postText(endpointUrl(port, endpoint), JSON.stringify(browserPayload()), headers);
  const browserStored = await hasBrowserFailure(options.database, project.projectCode, "EI_ACCEPTANCE_BROWSER_PAYLOAD");
  const rawFound = await containsRawMarkers(options.database, project.projectCode, sensitiveMarkers);
  const maskedOk = sensitiveResponse === 204 && browserStored && !rawFound;
  options.reporter.add(project.kind, "text/plain browser report and masking", maskedOk, `status=${sensitiveResponse ?? "no response"}; browser group=${browserStored}; raw markers present=${rawFound}`);

  const rateStatuses = await sendRateLimitSequence(port, endpoint, headers);
  const thirtyFirst = await sendThirtyFirst(port, endpoint, headers);
  const rateOk = oversizeResponse === 204 && sensitiveResponse === 204 && rateStatuses.length === 28 &&
    rateStatuses.every((status) => status === 204) && thirtyFirst === 429;
  options.reporter.add(project.kind, "same source request 31 returns 429", rateOk, `first 30 accepted=${rateOk}; request 31 status=${thirtyFirst ?? "no response"}`);
}

async function sendRateLimitSequence(port: number, endpoint: string, headers: Readonly<Record<string, string>>): Promise<readonly (number | undefined)[]> {
  const statuses: (number | undefined)[] = [];
  for (let index = 0; index < 28; index += 1) {
    statuses.push(await postText(endpointUrl(port, endpoint), JSON.stringify(browserPayload()), headers));
  }
  return statuses;
}

async function sendThirtyFirst(port: number, endpoint: string, headers: Readonly<Record<string, string>>): Promise<number | undefined> {
  return postText(endpointUrl(port, endpoint), JSON.stringify(browserPayload()), headers);
}

async function checkNextBrowserError(project: AcceptanceProject, projectDir: string, port: number, options: SuiteOptions): Promise<void> {
  const browserDir = join(projectDir, "electron-probe");
  await mkdir(browserDir, { recursive: true });
  await writeFile(join(browserDir, "package.json"), JSON.stringify({ name: "electron-probe", version: "1.0.0", main: "main.cjs" }));
  await writeFile(join(browserDir, "main.cjs"), electronMainSource);
  let process: ManagedProcess | undefined;
  let received = false;
  try {
    process = startManagedProcess(options.electronPath, [browserDir], {
      cwd: browserDir,
      env: { ...isolatedNodeEnv(options.nodePath), EI_ACCEPTANCE_URL: `http://127.0.0.1:${port}/` },
    });
    received = await waitForBrowserError(options.database, project.projectCode, "EI_ACCEPTANCE_BROWSER_FAILURE");
  } catch {
    received = false;
  } finally {
    if (process) await stopProcessGroup(process);
  }
  options.reporter.add(project.kind, "Electron uncaught client error reaches MySQL", received, received ? "source browser group was recorded" : "Electron did not produce a browser error group");
}

async function waitForBrowserError(pool: Pool, project: string, marker: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await hasBrowserFailure(pool, project, marker)) return true;
    await delay(500);
  }
  return false;
}

async function writeProject(projectDir: string, project: AcceptanceProject): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "package.json"), JSON.stringify(project.packageJson, null, 2));
  for (const [relativePath, content] of Object.entries(project.files)) {
    const path = join(projectDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function recordUnrunProjectChecks(project: AcceptanceProject, reporter: CheckReporter, detail: string): void {
  reporter.add(project.kind, "server startup", false, detail);
  reporter.add(project.kind, project.kind === "next-app" ? "onRequestError and 500 grouping" : "500 grouping and samples", false, detail);
  reporter.add(project.kind, "400 does not write to MySQL", false, detail);
  if (project.kind === "next-app") reporter.add(project.kind, "Electron uncaught client error reaches MySQL", false, detail);
  reporter.add(project.kind, "over 16 KB report is dropped", false, detail);
  reporter.add(project.kind, "text/plain browser report and masking", false, detail);
  reporter.add(project.kind, "same source request 31 returns 429", false, detail);
}

function recordCompilationSkipped(project: AcceptanceProject, reporter: CheckReporter, detail: string): void {
  if (project.kind === "express4-cjs" || project.kind === "express5-esm") {
    reporter.add(project.kind, "TypeScript compilation", true, "not applicable to this JavaScript sample");
    return;
  }
  reporter.add(project.kind, project.kind === "nest-cjs" ? "tsc compile (module node16)" : "next build", false, detail);
}

function isolatedEnv(nodePath: string, workRoot: string): NodeJS.ProcessEnv {
  return isolatedNodeEnv(nodePath, { npm_config_cache: join(workRoot, "npm-cache") });
}

function appEnv(nodePath: string, writer: WriterAccount, project: string, port: number, token: string): NodeJS.ProcessEnv {
  return {
    ...isolatedNodeEnv(nodePath),
    ERROR_INTAKE_DATABASE_URL: writer.url,
    ERROR_INTAKE_PROJECT: project,
    APP_ENV: "local",
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    EI_ACCEPTANCE_READY_TOKEN: token,
  };
}

async function requestStatus(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.status;
  } catch {
    return undefined;
  }
}

async function postText(url: string, body: string, headers: Readonly<Record<string, string>>): Promise<number | undefined> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    return response.status;
  } catch {
    return undefined;
  }
}

function receiverPath(kind: AcceptanceProject["kind"]): string {
  return kind === "next-app" ? "/api/error-intake" : "/error-intake";
}

function endpointUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function oversizedPayload(): string {
  return JSON.stringify({ errorType: "OversizeReport", message: "x".repeat(16 * 1024), stack: "" });
}

function browserPayload(): { readonly errorType: string; readonly message: string; readonly stack: string; readonly route: string } {
  return {
    errorType: "AcceptanceBrowserError",
    message: "EI_ACCEPTANCE_BROWSER_PAYLOAD jane@example.com Bearer abc.def.ghi https://x.test/p?key=leak123 0912345678",
    stack: "AcceptanceBrowserError\n at render (/app/page.js:1:1)",
    route: "/acceptance/12345",
  };
}

const sensitiveMarkers = [
  "jane@example.com",
  "Bearer abc.def.ghi",
  "https://x.test/p?key=leak123",
  "leak123",
  "0912345678",
];

const electronMainSource = `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 900, height: 650, show: true });
  void window.loadURL(process.env.EI_ACCEPTANCE_URL);
});
`;

function succeeded(result: { readonly code: number | null; readonly timedOut: boolean; readonly spawnError: string | undefined }): boolean {
  return result.code === 0 && !result.timedOut && result.spawnError === undefined;
}

function sameCounts(left: ProjectCounts, right: ProjectCounts): boolean {
  return left.groups === right.groups && left.samples === right.samples;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFreshMinute(): Promise<void> {
  const intoMinute = Date.now() % 60_000;
  if (intoMinute > 40_000) await delay(60_000 - intoMinute + 100);
}
