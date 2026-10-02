import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { createPool, type Pool } from 'mysql2/promise'
import { missingEnvironmentNames, parseRootDatabaseUrl, portOwnerIsInWorktree, taskTimeoutMinutes, type RootDatabaseConnection } from './error-intake-acceptance-helpers.js'

export interface AcceptanceConfig {
  readonly runLabel: string
  readonly targetRepo: string
  readonly targetGithubRepo: string
  readonly targetEnvFile: string
  readonly packageSource: string
  readonly timeoutMinutes: number
  readonly database: RootDatabaseConnection
  readonly databaseUrl: string
  readonly secretValues: readonly string[]
}

export interface WorktreeInfo {
  readonly parentDir: string
  readonly path: string
}

export interface CommandResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly errorCode?: string
}

export interface PortOwner {
  readonly pid: number
  readonly cwd?: string
}

export function readConfig(env: NodeJS.ProcessEnv): AcceptanceConfig {
  const targetRepo = env['TARGET_REPO']
  const targetGithubRepo = env['TARGET_GITHUB_REPO']
  const targetEnvFile = env['TARGET_ENV_FILE']
  if (targetRepo === undefined || targetRepo.trim() === '') throw new Error('缺少 TARGET_REPO')
  if (targetGithubRepo === undefined || targetGithubRepo.trim() === '') throw new Error('缺少 TARGET_GITHUB_REPO')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetGithubRepo)) {
    throw new Error('TARGET_GITHUB_REPO 必須是 owner/repository 格式')
  }
  if (targetEnvFile === undefined || targetEnvFile.trim() === '') throw new Error('缺少 TARGET_ENV_FILE')
  if (!isProjectRelativePath(targetEnvFile)) throw new Error('TARGET_ENV_FILE 必須是 TARGET_REPO 內的相對路徑')
  const runLabel = env['RUN_LABEL']
  const databaseUrl = env['EI_TEST_DB_ROOT_URL']
  const packageSource = env['EI_PACKAGE_SOURCE']
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('缺少 EI_TEST_DB_ROOT_URL')
  if (packageSource === undefined || !isAbsolute(packageSource)) throw new Error('EI_PACKAGE_SOURCE 必須是絕對路徑')
  const database = parseRootDatabaseUrl(databaseUrl)
  return {
    runLabel: runLabel ?? '',
    targetRepo: expandHome(targetRepo),
    targetGithubRepo,
    targetEnvFile,
    packageSource,
    timeoutMinutes: taskTimeoutMinutes(env['EI_TASK_TIMEOUT_MINUTES']),
    database,
    databaseUrl,
    secretValues: [databaseUrl, database.password],
  }
}

export async function validateInputs(config: AcceptanceConfig): Promise<void> {
  const packageStat = await stat(config.packageSource).catch(() => undefined)
  if (packageStat === undefined || !packageStat.isFile() || !config.packageSource.endsWith('.tgz')) {
    throw new Error('EI_PACKAGE_SOURCE 必須指向存在的 .tgz 檔案')
  }
  const repo = await realpath(config.targetRepo).catch(() => undefined)
  if (repo === undefined) throw new Error('TARGET_REPO 路徑不存在')
  const envFile = await stat(join(repo, config.targetEnvFile)).catch(() => undefined)
  if (envFile === undefined || !envFile.isFile()) throw new Error('TARGET_ENV_FILE 在 TARGET_REPO 中不存在或不是檔案')
}

export function createDatabasePool(connection: RootDatabaseConnection): Pool {
  return createPool({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    connectTimeout: 10_000,
    connectionLimit: 4,
    multipleStatements: false,
  })
}

export async function resetTestDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP DATABASE IF EXISTS `error_intake_test`')
  await pool.query('CREATE DATABASE `error_intake_test` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
}

export async function clearErrorRows(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM `error_intake_test`.`error_event`')
  await pool.query('DELETE FROM `error_intake_test`.`error_group`')
}

export async function createTargetWorktree(
  config: AcceptanceConfig,
  onCreated: (worktree: WorktreeInfo) => void,
): Promise<WorktreeInfo> {
  const repo = await realpath(config.targetRepo)
  // 取實體路徑：macOS 的 /var 是 symlink，之後跟 git、lsof 回報的路徑比對才會一致。
  const parentDir = await realpath(await mkdtemp(join(tmpdir(), `yeschef-error-intake-${config.runLabel}-`)))
  const path = join(parentDir, 'demo-app')
  const fetched = spawnSync('git', ['-C', repo, 'fetch', 'origin', 'main'], { stdio: 'ignore' })
  assertSpawnSuccess(fetched, 'git fetch origin main')
  const added = spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', path, 'origin/main'], { stdio: 'ignore' })
  assertSpawnSuccess(added, 'git worktree add')
  onCreated({ parentDir, path })
  await copyProjectEnvironment(repo, path, config.targetEnvFile)
  return { parentDir, path }
}

export async function copyProjectEnvironment(sourceRepo: string, worktree: string, envFile: string): Promise<void> {
  const source = join(sourceRepo, envFile)
  const target = join(worktree, envFile)
  await copyFile(source, target)
  await chmod(target, 0o600)
}

export async function installTargetDependencies(worktree: string): Promise<readonly CommandResult[]> {
  const install = await runSilentCommand('pnpm', ['install', '--frozen-lockfile'], worktree)
  if (install.code !== 0) return [install]
  const generated = await runSilentCommand('pnpm', ['prisma:generate'], worktree)
  return [install, generated]
}

export async function readConfiguredEnvironment(path: string): Promise<{ readonly missing: readonly string[] }> {
  const content = await readFile(path, 'utf8')
  return { missing: missingEnvironmentNames(content) }
}

export function inspectPortOwners(port: number): readonly PortOwner[] {
  const listed = spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  if (listed.error !== undefined) throw new Error(`lsof 執行失敗 (${listed.error.name})`)
  if (listed.status !== 0 && listed.stdout.trim() === '') return []
  return listed.stdout.split(/\r?\n/).flatMap((line) => {
    const pid = Number(line.trim())
    return Number.isInteger(pid) && pid > 0 ? [{ pid, cwd: processCwd(pid) }] : []
  })
}

export async function releaseWorktreePorts(worktree: string, ports: readonly number[]): Promise<readonly number[]> {
  const stopped: number[] = []
  for (const port of ports) {
    const owners = inspectPortOwners(port)
    for (const owner of owners) {
      if (!portOwnerIsInWorktree(owner.cwd, worktree)) {
        throw new Error(`連接埠 ${port} 被外部行程占用 (pid=${owner.pid})，cwd 不在本次 worktree`)
      }
      await terminatePid(owner.pid)
      stopped.push(owner.pid)
    }
  }
  return stopped
}

export function startTargetDev(worktree: string): ChildProcess {
  const child = spawn('pnpm', ['dev'], {
    cwd: worktree,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      AUTH_GATEWAY_URL: 'http://127.0.0.1:1',
      SERVICE_A_URL: 'http://127.0.0.1:1',
      AUTH_GATEWAY_KEY: 'error-intake-acceptance',
    },
    stdio: 'ignore',
  })
  return child
}

export async function stopProcessGroup(child: ChildProcess | undefined): Promise<void> {
  if (child?.pid === undefined) return
  sendProcessSignal(child.pid, 'SIGTERM', process.platform !== 'win32')
  if (await processGroupAlive(child.pid, 5_000)) {
    sendProcessSignal(child.pid, 'SIGKILL', process.platform !== 'win32')
    await processGroupAlive(child.pid, 2_000)
  }
}

export async function runSilentCommand(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return await new Promise((resolveCommand) => {
    const child = spawn(command, [...args], { cwd, stdio: 'ignore' })
    child.once('error', (error: NodeJS.ErrnoException) => resolveCommand({ code: null, signal: null, errorCode: error.code ?? error.name }))
    child.once('exit', (code, signal) => resolveCommand({ code, signal }))
  })
}

async function terminatePid(pid: number): Promise<void> {
  sendProcessSignal(pid, 'SIGTERM', false)
  await waitForPidExit(pid, 4_000)
  if (pidExists(pid)) {
    sendProcessSignal(pid, 'SIGKILL', false)
    await waitForPidExit(pid, 2_000)
  }
}

function assertSpawnSuccess(result: ReturnType<typeof spawnSync>, label: string): void {
  if (result.error !== undefined || result.status !== 0) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
    throw new Error(`${label} 失敗${code === undefined ? '' : ` (${code})`}`)
  }
}

function processCwd(pid: number): string | undefined {
  const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) return undefined
  return result.stdout.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1)
}

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(value)
}

function isProjectRelativePath(value: string): boolean {
  if (isAbsolute(value)) return false
  const normalized = normalize(value)
  return normalized !== '..' && !normalized.startsWith(`..${sep}`) && normalized !== '.'
}

function sendProcessSignal(pid: number, signal: NodeJS.Signals, group: boolean): void {
  try {
    process.kill(group ? -pid : pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function processGroupAlive(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && pidExists(-pid)) await pause(100)
  return pidExists(-pid)
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && pidExists(pid)) await pause(100)
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolvePause) => { setTimeout(resolvePause, ms) })
}
