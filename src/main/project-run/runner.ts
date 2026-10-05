import { basename, resolve, relative, isAbsolute, join } from 'node:path'
import type { ProjectRunConfig, ProjectRunStatus } from '../../shared/project-run.js'
import type { ProjectRunChild, ProjectRunPortInspection, ProjectRunRunner, ProjectRunRunnerDeps } from './types.js'
export type { ProjectRunRunner, ProjectRunRunnerDeps } from './types.js'

interface Runtime {
  readonly projectId: string
  rootPath: string
  projectName: string
  config: ProjectRunConfig
  status: ProjectRunStatus
  child?: ProjectRunChild
  generation: number
  stopping: boolean
  everRunning: boolean
  restartTimes: number[]
  watchStop?: () => void
  debounce?: ReturnType<typeof setTimeout>
  lines: string[]
  partial: Record<'stdout' | 'stderr', string>
}

const MAX_LOG_LINES = 2000
const RESTART_WINDOW = 5 * 60_000
const MAX_AUTOMATIC_RESTARTS = 3
const WATCH_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.yeschef']
const EMPTY_STATUS = (projectId: string): ProjectRunStatus => ({ projectId, state: 'stopped', restarted: false })

function replacePort(value: string, port: number): string {
  return value.replaceAll('{port}', String(port))
}

function serviceUrl(config: ProjectRunConfig, port: number): string {
  return replacePort(config.url, port)
}

function readyUrl(config: ProjectRunConfig, port: number): string {
  return new URL(config.readyPath, serviceUrl(config, port)).toString()
}

function insideRoot(rootPath: string, cwd: string): boolean {
  const rel = relative(rootPath, cwd)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function active(status: ProjectRunStatus): boolean {
  return status.state === 'starting' || status.state === 'running' || status.state === 'restarting'
}

export function createProjectRunRunner(deps: ProjectRunRunnerDeps): ProjectRunRunner {
  const runtimes = new Map<string, Runtime>()
  const listeners = new Set<(projectId: string, status: ProjectRunStatus, logs: readonly string[]) => void>()

  const publish = (runtime: Runtime): void => {
    for (const listener of listeners) {
      try { listener(runtime.projectId, runtime.status, runtime.lines.slice()) }
      catch (error) { deps.logError(asError(error)) }
    }
  }

  const setStatus = (runtime: Runtime, status: ProjectRunStatus): void => {
    runtime.status = status
    publish(runtime)
  }

  const append = (runtime: Runtime, text: string): void => {
    const lines = [...runtime.lines, text].slice(-MAX_LOG_LINES)
    runtime.lines = lines
    void deps.appendLog(runtime.projectId, text).catch(error => deps.logError(asError(error)))
    publish(runtime)
  }

  const flushPartial = (runtime: Runtime): void => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = runtime.partial[stream]
      if (text !== '') append(runtime, text)
      runtime.partial[stream] = ''
    }
  }

  const attachChild = (runtime: Runtime, child: ProjectRunChild, generation: number): void => {
    child.onOutput((stream, chunk) => {
      if (generation !== runtime.generation) return
      const parts = `${runtime.partial[stream]}${chunk}`.split(/\r?\n/)
      runtime.partial[stream] = parts.pop() ?? ''
      for (const line of parts) append(runtime, line)
    })
    child.onExit((code, signal) => { void handleExit(runtime, generation, code, signal) })
  }

  const stopGroup = async (pgid: number): Promise<boolean> => {
    if (!await deps.groupAlive(pgid)) return true
    await Promise.resolve(deps.signalGroup(pgid, 'SIGTERM')).catch(error => deps.logError(asError(error)))
    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      if (!await deps.groupAlive(pgid)) return true
      await deps.sleep(100)
    }
    if (!await deps.groupAlive(pgid)) return true
    await Promise.resolve(deps.signalGroup(pgid, 'SIGKILL')).catch(error => deps.logError(asError(error)))
    for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
      if (!await deps.groupAlive(pgid)) return true
      await deps.sleep(100)
    }
    return !await deps.groupAlive(pgid)
  }

  const closeWatch = (runtime: Runtime): void => {
    runtime.watchStop?.()
    runtime.watchStop = undefined
    if (runtime.debounce !== undefined) deps.clearTimeout(runtime.debounce)
    runtime.debounce = undefined
  }

  const watchRuntime = (runtime: Runtime): void => {
    if (!runtime.config.watch.enabled || runtime.watchStop !== undefined) return
    const cwd = resolve(runtime.rootPath, runtime.config.cwd)
    const exclude = [...new Set([...WATCH_EXCLUDES, ...runtime.config.watch.exclude])]
    try {
      runtime.watchStop = deps.watch(cwd, { include: runtime.config.watch.include, exclude }, () => {
        if (runtime.debounce !== undefined) deps.clearTimeout(runtime.debounce)
        runtime.debounce = deps.setTimeout(() => {
          runtime.debounce = undefined
          void restartRuntime(runtime).catch(error => { fail(runtime, asError(error).message) })
        }, 1000)
      })
    } catch (error) {
      const failure = asError(error)
      deps.logError(failure)
      append(runtime, `檔案監看啟動失敗：${failure.message}`)
    }
  }

  async function loadPreviousLogs(runtime: Runtime): Promise<void> {
    if (runtime.lines.length > 0) return
    try { runtime.lines = (await deps.readLog(runtime.projectId)).split(/\r?\n/).filter(Boolean).slice(-MAX_LOG_LINES) }
    catch (error) { deps.logError(asError(error)) }
  }

  async function launch(runtime: Runtime, useFreePort: boolean, wasRestart: boolean): Promise<ProjectRunStatus> {
    const generation = ++runtime.generation
    const root = resolve(runtime.rootPath)
    const cwd = resolve(root, runtime.config.cwd)
    if (!insideRoot(root, cwd)) return fail(runtime, '工作目錄必須位於專案資料夾內')
    await loadPreviousLogs(runtime)
    if (generation !== runtime.generation) return runtime.status

    let port = runtime.config.port
    let inspection: ProjectRunPortInspection
    try { inspection = await deps.inspectPort(port) }
    catch (error) {
      if (generation !== runtime.generation) return runtime.status
      return fail(runtime, `無法檢查連接埠：${asError(error).message}`)
    }
    if (generation !== runtime.generation) return runtime.status
    const managedOwner = [...runtimes.values()].find(other => other !== runtime && active(other.status) && other.status.port === port)
    if (managedOwner !== undefined) {
      const pid = managedOwner.status.pid ?? managedOwner.status.pgid ?? 1
      inspection = {
        kind: 'occupied', pid, processName: managedOwner.status.command ?? 'YesChef 管理的服務',
        projectName: managedOwner.projectName,
      }
    }
    if (inspection.kind === 'occupied') {
      if (!useFreePort || runtime.config.portStrategy !== 'placeholder') {
        const status: ProjectRunStatus = {
          ...EMPTY_STATUS(runtime.projectId), state: 'failed', port,
          ...(inspection.pid === undefined ? {} : { conflict: {
            pid: inspection.pid, processName: inspection.processName ?? '未知程序',
            ...(inspection.projectName === undefined ? {} : { projectName: inspection.projectName }),
          } }),
          error: '連接埠已被其他程序使用', restarted: wasRestart,
        }
        setStatus(runtime, status)
        return status
      }
      try { port = await deps.findFreePort() }
      catch (error) {
        if (generation !== runtime.generation) return runtime.status
        return fail(runtime, `找不到空著的連接埠：${asError(error).message}`)
      }
      if (generation !== runtime.generation) return runtime.status
      try { inspection = await deps.inspectPort(port) }
      catch (error) {
        if (generation !== runtime.generation) return runtime.status
        return fail(runtime, `無法檢查連接埠：${asError(error).message}`)
      }
      if (generation !== runtime.generation) return runtime.status
      if (inspection.kind !== 'free') return fail(runtime, `找不到可用連接埠（${port} 仍被使用）`)
    }

    const command = replacePort(runtime.config.command, port)
    const env = Object.fromEntries(Object.entries(runtime.config.env).map(([key, value]) => [key, replacePort(value, port)]))
    const initial: ProjectRunStatus = {
      projectId: runtime.projectId,
      state: wasRestart ? 'restarting' : 'starting',
      port,
      url: serviceUrl(runtime.config, port),
      command,
      restarted: wasRestart,
    }
    setStatus(runtime, initial)
    let child: ProjectRunChild
    try {
      child = deps.spawn(deps.shell, ['-lc', command], {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
      })
    } catch (error) {
      return fail(runtime, asError(error).message, initial)
    }
    runtime.child = child
    runtime.stopping = false
    const pgid = child.pid
    let processName = basename(command.split(/\s+/)[0] ?? '')
    setStatus(runtime, { ...initial, pid: child.pid, pgid, processName })
    attachChild(runtime, child, generation)
    try { processName = await deps.processName(child.pid) || processName } catch { /* 使用命令名稱作為保護規則的備援 */ }
    if (generation !== runtime.generation) return runtime.status
    setStatus(runtime, { ...runtime.status, processName })
    return waitUntilReady(runtime, generation, port, wasRestart)
  }

  async function waitUntilReady(runtime: Runtime, generation: number, port: number, wasRestart: boolean): Promise<ProjectRunStatus> {
    const startedAt = deps.now()
    const target = readyUrl(runtime.config, port)
    while (generation === runtime.generation && deps.now() - startedAt < 90_000) {
      if (runtime.status.state === 'failed' || runtime.status.state === 'stopped') return runtime.status
      try {
        const response = await deps.httpGet(target, 500)
        if (response.status < 500) {
          runtime.everRunning = true
          setStatus(runtime, { ...runtime.status, state: 'running', error: undefined })
          watchRuntime(runtime)
          if (!wasRestart && runtime.config.openInBrowser && runtime.status.url !== undefined) {
            await deps.openInBrowser(runtime.projectId, runtime.status.url).catch(error => deps.logError(asError(error)))
          }
          return runtime.status
        }
      } catch { /* 服務啟動期間連線失敗,下次輪詢再試 */ }
      await deps.sleep(500)
    }
    if (generation !== runtime.generation) return runtime.status
    const pid = runtime.status.pgid
    runtime.stopping = true
    if (pid !== undefined) await stopGroup(pid)
    if (generation !== runtime.generation) return runtime.status
    runtime.stopping = false
    return fail(runtime, '服務在 90 秒內沒有就緒，請檢查紀錄')
  }

  async function handleExit(runtime: Runtime, generation: number, code: number | null, signal: string | null): Promise<void> {
    if (generation !== runtime.generation || runtime.stopping) return
    runtime.stopping = true
    flushPartial(runtime)
    const at = deps.now()
    const previous = runtime.status
    runtime.status = { ...previous, state: 'failed', lastExit: { at, code, signal }, error: `服務已結束（${signal ?? code ?? '未知'}）` }
    publish(runtime)
    if (!runtime.everRunning) {
      if (previous.pgid !== undefined && await deps.groupAlive(previous.pgid)) {
        const stopped = await stopGroup(previous.pgid)
        if (!stopped) runtime.status = { ...runtime.status, error: '啟動失敗，且無法清除程序群組' }
      }
      runtime.stopping = false
      publish(runtime)
      return
    }
    await deps.postUnexpectedExit(runtime.projectId, { code, signal, at }).catch(error => deps.logError(asError(error)))
    if (generation !== runtime.generation) return
    if (previous.pgid !== undefined && await deps.groupAlive(previous.pgid)) {
      const stopped = await stopGroup(previous.pgid)
      if (!stopped) { runtime.stopping = false; fail(runtime, '無法清除已結束服務的程序群組'); return }
    }
    if (generation !== runtime.generation) return
    runtime.restartTimes = runtime.restartTimes.filter(time => at - time < RESTART_WINDOW)
    if (runtime.restartTimes.length >= MAX_AUTOMATIC_RESTARTS) {
      runtime.stopping = false
      closeWatch(runtime)
      setStatus(runtime, { ...runtime.status, state: 'failed', error: '服務在五分鐘內自動重啟三次仍結束，請檢查紀錄' })
      return
    }
    runtime.restartTimes = [...runtime.restartTimes, at]
    setStatus(runtime, { ...runtime.status, state: 'restarting' })
    runtime.stopping = false
    await launch(runtime, false, true)
  }

  function fail(runtime: Runtime, error: string, base: ProjectRunStatus = runtime.status): ProjectRunStatus {
    const status = { ...base, projectId: runtime.projectId, state: 'failed' as const, error }
    setStatus(runtime, status)
    return status
  }

  async function restartRuntime(runtime: Runtime): Promise<ProjectRunStatus> {
    if (runtime.status.state === 'stopped') return runtime.status
    const oldPgid = runtime.status.pgid
    runtime.generation += 1
    runtime.stopping = true
    closeWatch(runtime)
    setStatus(runtime, { ...runtime.status, state: 'restarting', error: undefined })
    if (oldPgid !== undefined && !await stopGroup(oldPgid)) return fail(runtime, '停止服務失敗，程序群組仍有成員')
    runtime.child = undefined
    runtime.stopping = false
    runtime.everRunning = true
    return launch(runtime, false, true)
  }

  async function stop(projectId: string): Promise<ProjectRunStatus> {
    const runtime = runtimes.get(projectId)
    if (runtime === undefined) return EMPTY_STATUS(projectId)
    const oldPgid = runtime.status.pgid
    runtime.generation += 1
    runtime.stopping = true
    closeWatch(runtime)
    if (oldPgid !== undefined && !await stopGroup(oldPgid)) {
      return fail(runtime, '停止服務失敗，程序群組仍有成員', runtime.status)
    }
    runtime.child = undefined
    runtime.stopping = false
    runtime.everRunning = false
    setStatus(runtime, EMPTY_STATUS(projectId))
    return runtime.status
  }

  return {
    async start(projectId, rootPath, config, options = {}) {
      const current = runtimes.get(projectId)
      if (current !== undefined && active(current.status)) return current.status
      const runtime: Runtime = current ?? {
        projectId, rootPath, projectName: options.projectName ?? basename(rootPath), config, status: EMPTY_STATUS(projectId), generation: 0,
        stopping: false, everRunning: false, restartTimes: [], lines: [], partial: { stdout: '', stderr: '' },
      }
      runtime.rootPath = rootPath
      runtime.projectName = options.projectName ?? basename(rootPath)
      runtime.config = config
      runtime.status = { ...runtime.status, restarted: false }
      runtime.restartTimes = []
      runtime.everRunning = false
      runtimes.set(projectId, runtime)
      return launch(runtime, options.useFreePort ?? false, false)
    },
    stop,
    async restart(projectId) {
      const runtime = runtimes.get(projectId)
      if (runtime === undefined) return EMPTY_STATUS(projectId)
      return restartRuntime(runtime)
    },
    snapshot(projectId) { return runtimes.get(projectId)?.status ?? EMPTY_STATUS(projectId) },
    logs(projectId) { return runtimes.get(projectId)?.lines.slice() ?? [] },
    acknowledgeRestart(projectId) {
      const runtime = runtimes.get(projectId)
      if (runtime?.status.restarted) setStatus(runtime, { ...runtime.status, restarted: false })
    },
    async stopAll() { await Promise.all([...runtimes.keys()].map(stop)) },
    managedServices(projectId) {
      return [...runtimes.values()].filter(runtime => (projectId === undefined || runtime.projectId === projectId)
        && active(runtime.status) && runtime.status.pid !== undefined
        && runtime.status.pgid !== undefined && runtime.status.port !== undefined).map(runtime => ({
        pid: runtime.status.pid!, pgid: runtime.status.pgid!, processName: runtime.status.processName ?? 'sh',
        port: runtime.status.port!, command: runtime.status.command ?? runtime.config.command,
      }))
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
