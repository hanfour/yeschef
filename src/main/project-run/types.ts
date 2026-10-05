import type { ProjectRunConfig, ProjectRunStatus } from '../../shared/project-run.js'

export interface ProjectRunChild {
  readonly pid: number
  onExit(callback: (code: number | null, signal: string | null) => void): void
  onOutput(callback: (stream: 'stdout' | 'stderr', chunk: string) => void): () => void
}

export interface ProjectRunPortInspection {
  readonly kind: 'free' | 'occupied'
  readonly pid?: number
  readonly processName?: string
  readonly projectName?: string
}

export interface ProjectRunRunnerDeps {
  readonly shell: string
  spawn(shell: string, args: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>>; readonly detached: true }): ProjectRunChild
  signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void | Promise<void>
  groupAlive(pgid: number): boolean | Promise<boolean>
  inspectPort(port: number): Promise<ProjectRunPortInspection>
  findFreePort(): Promise<number>
  processName(pid: number): Promise<string>
  httpGet(url: string, timeoutMs: number): Promise<{ readonly status: number }>
  appendLog(projectId: string, line: string): Promise<void>
  readLog(projectId: string): Promise<string>
  watch(root: string, options: { readonly include: readonly string[]; readonly exclude: readonly string[] }, changed: () => void): () => void
  now(): number
  sleep(ms: number): Promise<void>
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  openInBrowser(projectId: string, url: string): Promise<void>
  postUnexpectedExit(projectId: string, exit: { readonly code: number | null; readonly signal: string | null; readonly at: number }): Promise<void>
  logError(error: Error): void
}

export interface ProjectRunRunner {
  start(projectId: string, rootPath: string, config: ProjectRunConfig, options?: { readonly useFreePort?: boolean; readonly projectName?: string }): Promise<ProjectRunStatus>
  stop(projectId: string): Promise<ProjectRunStatus>
  restart(projectId: string): Promise<ProjectRunStatus>
  snapshot(projectId: string): ProjectRunStatus
  logs(projectId: string): readonly string[]
  acknowledgeRestart(projectId: string): void
  stopAll(): Promise<void>
  managedServices(projectId?: string): readonly { readonly pid: number; readonly pgid: number; readonly processName: string; readonly port: number; readonly command: string }[]
  subscribe(listener: (projectId: string, status: ProjectRunStatus, logs: readonly string[]) => void): () => void
}
