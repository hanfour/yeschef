import { execFileSync, spawn, execFile } from 'node:child_process'
import { watch as watchFs } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { basename, join, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectRunRunnerDeps } from './runner.js'

const execFileAsync = promisify(execFile)
const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface ProjectRunNodeAdapters extends Omit<ProjectRunRunnerDeps, 'shell' | 'openInBrowser' | 'postUnexpectedExit' | 'logError'> {
  logPath(projectId: string): string
}

export function createProjectRunNodeAdapters(userDataDir: string): ProjectRunNodeAdapters {
  const logsDir = join(userDataDir, 'project-run', 'logs')
  const logQueues = new Map<string, Promise<void>>()
  const logPath = (projectId: string): string => {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('專案識別碼格式不正確')
    return join(logsDir, `${projectId}.log`)
  }

  const appendLog = (projectId: string, line: string): Promise<void> => {
    const path = logPath(projectId)
    const previous = logQueues.get(projectId) ?? Promise.resolve()
    const task = previous.then(async () => {
      await mkdir(logsDir, { recursive: true, mode: 0o700 })
      const size = await stat(path).then(result => result.size, () => 0)
      if (size + Buffer.byteLength(line) + 1 > MAX_LOG_BYTES) {
        await rm(`${path}.1`, { force: true })
        await rename(path, `${path}.1`).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      }
      await appendFile(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    })
    logQueues.set(projectId, task.catch(() => {}))
    return task
  }

  const readLog = async (projectId: string): Promise<string> => {
    try { return await readFile(logPath(projectId), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  const processName = async (pid: number): Promise<string> => {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 2000 })
    return basename(stdout.trim())
  }

  const ownerOf = async (port: number): Promise<{ readonly pid: number; readonly processName: string }> => {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 2500 })
    const pid = Number(stdout.trim().split(/\s+/)[0])
    if (!Number.isInteger(pid) || pid < 1) throw new Error(`無法取得連接埠 ${port} 的程序識別碼`)
    return { pid, processName: await processName(pid).catch(() => '未知程序') }
  }

  const inspectPort = async (port: number) => {
    const occupied = await new Promise<boolean>(resolveResult => {
      const socket = createConnection({ host: '127.0.0.1', port })
      const finish = (value: boolean): void => { socket.destroy(); resolveResult(value) }
      socket.setTimeout(300)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(true))
      socket.once('error', error => finish((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'))
    })
    if (!occupied) return { kind: 'free' as const }
    return { kind: 'occupied' as const, ...await ownerOf(port) }
  }

  const findFreePort = async (): Promise<number> => new Promise((resolveResult, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('無法取得空連接埠')))
        return
      }
      const port = address.port
      server.close(error => error ? reject(error) : resolveResult(port))
    })
  })

  const watch = (root: string, options: { readonly include: readonly string[]; readonly exclude: readonly string[] }, changed: () => void): (() => void) => {
    const watcher = watchFs(root, { recursive: true }, (_event, filename) => {
      if (filename === null) return
      const path = filename.toString().split(sep).join('/')
      const excluded = options.exclude.some(pattern => pattern.includes('*')
        ? globRegex(pattern).test(path)
        : path.split('/').some(part => part === pattern))
      if (excluded) return
      if (options.include.some(pattern => globRegex(pattern).test(path))) changed()
    })
    return () => watcher.close()
  }

  return {
    logPath,
    appendLog,
    readLog,
    processName,
    inspectPort,
    findFreePort,
    async httpGet(url, timeoutMs) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, { method: 'GET', signal: controller.signal })
        return { status: response.status }
      } finally {
        clearTimeout(timeout)
      }
    },
    watch,
    now: Date.now,
    sleep: ms => new Promise(resolveResult => setTimeout(resolveResult, ms)),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: timer => clearTimeout(timer),
    spawn(shell, args, options) {
      const child = spawn(shell, [...args], { cwd: options.cwd, env: { ...options.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      if (child.pid === undefined) throw new Error('無法啟動服務程序')
      return {
        pid: child.pid,
        onExit(callback) { child.once('exit', (code, signal) => callback(code, signal)) },
        onOutput(callback) {
          const stdout = (chunk: Buffer | string): void => callback('stdout', chunk.toString())
          const stderr = (chunk: Buffer | string): void => callback('stderr', chunk.toString())
          child.stdout?.on('data', stdout)
          child.stderr?.on('data', stderr)
          return () => { child.stdout?.off('data', stdout); child.stderr?.off('data', stderr) }
        },
      }
    },
    signalGroup(pgid, signal) {
      try { process.kill(-pgid, signal) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ESRCH') return
        // macOS 對只剩 zombie 的群組回 EPERM：沒有活著的成員就等於已經結束。
        if (code === 'EPERM' && liveGroupMembers(pgid).length === 0) return
        throw error
      }
    },
    groupAlive(pgid) {
      try { process.kill(-pgid, 0); return true }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ESRCH') return false
        if (code === 'EPERM') return liveGroupMembers(pgid).length > 0
        throw error
      }
    },
  }
}

/** 程序群組中還活著的成員（排除 zombie）。 */
export function liveGroupMembers(pgid: number): number[] {
  const output = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 5000 })
  return parseLiveGroupMembers(output, pgid)
}

export function parseLiveGroupMembers(psOutput: string, pgid: number): number[] {
  return psOutput.split('\n').map(line => line.trim().split(/\s+/)).filter(row => row.length >= 3 && Number(row[1]) === pgid && !row[2]!.startsWith('Z')).map(row => Number(row[0]))
}

function globRegex(pattern: string): RegExp {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1
      if (pattern[index + 1] === '/') { index += 1; expression += '(?:.*/)?' }
      else expression += '.*'
    } else if (char === '*') expression += '[^/]*'
    else if (char === '?') expression += '[^/]'
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${expression}$`)
}
