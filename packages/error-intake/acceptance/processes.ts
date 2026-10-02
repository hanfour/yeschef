import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { delimiter, dirname } from "node:path";

const CAPTURE_LIMIT = 2_000_000;

export interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly spawnError: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly state: { code: number | null; signal: NodeJS.Signals | null; error: string | undefined };
  readonly output: { stdout: string; stderr: string };
  stopped: boolean;
}

export function startManagedProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): ManagedProcess {
  if (process.platform === "win32") throw new Error("POSIX process groups are required for acceptance cleanup");
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("Acceptance child process did not start");

  const state = { code: null as number | null, signal: null as NodeJS.Signals | null, error: undefined as string | undefined };
  const output = { stdout: "", stderr: "" };
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      state.code = code;
      state.signal = signal;
      resolve();
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      state.error = error.code ?? "SPAWN_ERROR";
      resolve();
    });
  });
  child.stdout?.on("data", (chunk: Buffer) => { output.stdout = appendBounded(output.stdout, chunk.toString()); });
  child.stderr?.on("data", (chunk: Buffer) => { output.stderr = appendBounded(output.stderr, chunk.toString()); });
  return { pid: child.pid, child, closed, state, output, stopped: false };
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<CommandResult> {
  const managed = startManagedProcess(command, args, options);
  const timedOut = !(await waitForClose(managed, options.timeoutMs));
  if (timedOut) await stopProcessGroup(managed);
  const result = {
    code: managed.state.code,
    signal: managed.state.signal,
    timedOut,
    spawnError: managed.state.error,
    stdout: managed.output.stdout,
    stderr: managed.output.stderr,
  };
  await stopProcessGroup(managed);
  return result;
}

export async function stopProcessGroup(managed: ManagedProcess): Promise<void> {
  if (managed.stopped) return;
  managed.stopped = true;
  signalGroup(managed.pid, "SIGTERM");
  await Promise.race([managed.closed, delay(1_000)]);
  signalGroup(managed.pid, "SIGKILL");
  await Promise.race([managed.closed, delay(1_000)]);
}

export async function acquireFreePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Could not inspect the temporary port")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function waitForClose(managed: ManagedProcess, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    managed.closed.then(() => true),
    new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return completed;
}

export function isolatedNodeEnv(nodePath: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["EI_PKG_ROOT_URL", "EI_PKG_TARBALL", "EI_PKG_NODE", "ERROR_INTAKE_DATABASE_URL", "ERROR_INTAKE_PROJECT", "APP_ENV", "NODE_ENV", "npm_config_production", "npm_config_omit"]) {
    delete env[key];
  }
  return {
    ...env,
    ...extra,
    PATH: `${dirname(nodePath)}${delimiter}${env.PATH ?? ""}`,
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

function appendBounded(previous: string, next: string): string {
  const combined = previous + next;
  return combined.length > CAPTURE_LIMIT ? combined.slice(-CAPTURE_LIMIT) : combined;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
