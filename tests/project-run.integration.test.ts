import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createProjectRunNodeAdapters } from '../src/main/project-run/node-adapters.js'
import { createProjectRunRunner } from '../src/main/project-run/runner.js'
import type { ProjectRunConfig } from '../src/shared/project-run.js'

const roots: string[] = []
const runners: ReturnType<typeof createProjectRunRunner>[] = []
const CONFIG: ProjectRunConfig = {
  version: 1,
  command: 'node server.mjs --port {port}',
  cwd: '.',
  port: 0,
  url: 'http://127.0.0.1:{port}/',
  readyPath: '/health',
  env: {},
  portStrategy: 'placeholder',
  watch: { enabled: true, include: ['version.txt'], exclude: [] },
  openInBrowser: false,
}

const SERVER = [
  "import { createServer } from 'node:http'",
  "import { readFileSync } from 'node:fs'",
  "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
  "console.log('server started', port)",
  // 啟動時讀一次：只有真的重啟後才會回應新內容，才能驗證「檔案變動重啟」。
  "const version = readFileSync('version.txt', 'utf8')",
  "createServer((request, response) => { response.statusCode = request.url === '/health' ? 204 : 200; response.end(version) }).listen(port, '127.0.0.1')",
].join('\n')

afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.stopAll()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T | undefined
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (predicate(last)) return last
    } catch { /* listener may be between stop and restart */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`等待服務狀態逾時，最後結果：${String(last)}`)
}

function listen(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function responseText(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/`)).text()
}

describe('專案執行真實子程序整合', () => {
  it('啟動就緒、外部 port 佔用、檔案重啟、外部 kill 自動重啟與群組停止', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-run-integration-'))
    roots.push(root)
    await writeFile(join(root, 'server.mjs'), SERVER)
    await writeFile(join(root, 'version.txt'), 'v1')
    const adapters = createProjectRunNodeAdapters(join(root, 'user-data'))
    const unexpected: number[] = []
    const runner = createProjectRunRunner({
      ...adapters,
      shell: process.env['SHELL'] ?? '/bin/sh',
      openInBrowser: async () => {},
      postUnexpectedExit: async (_projectId, exit) => { unexpected.push(exit.at) },
      logError: error => { throw error },
    })
    runners.push(runner)

    const port = await adapters.findFreePort()
    const config = { ...CONFIG, port }
    await expect(runner.start('project', root, config)).resolves.toMatchObject({ state: 'running', port })
    await expect(responseText(port)).resolves.toBe('v1')

    const occupiedPort = await adapters.findFreePort()
    const occupiedServer = await listen(occupiedPort)
    const collision = await runner.start('occupied', root, { ...config, port: occupiedPort, watch: { ...config.watch, enabled: false } })
    expect(collision).toMatchObject({ state: 'failed', conflict: { pid: expect.any(Number), processName: expect.any(String) } })
    await new Promise<void>((resolve, reject) => occupiedServer.close(error => error ? reject(error) : resolve()))

    await writeFile(join(root, 'version.txt'), 'v2')
    await waitFor(() => responseText(port), value => value === 'v2')
    // 新程序可能先回應，runner 的就緒輪詢下一輪才改成 running。
    await waitFor(async () => runner.snapshot('project'), value => value.state === 'running')
    expect(runner.snapshot('project')).toMatchObject({ state: 'running', restarted: true })

    const groupId = runner.snapshot('project').pgid
    if (groupId === undefined) throw new Error('missing process group id')
    const killedPid = runner.snapshot('project').pid
    process.kill(-groupId, 'SIGKILL')
    // 等到換成新的程序；只看 running 會在偵測到結束之前就成立。
    await waitFor(async () => runner.snapshot('project'), value => value.state === 'running' && value.pid !== undefined && value.pid !== killedPid)
    expect(unexpected).toHaveLength(1)
    await expect(responseText(port)).resolves.toBe('v2')

    const stoppedGroup = runner.snapshot('project').pgid
    await expect(runner.stop('project')).resolves.toMatchObject({ state: 'stopped' })
    if (stoppedGroup === undefined) throw new Error('missing process group id after restart')
    await waitFor(async () => adapters.groupAlive(stoppedGroup), alive => !alive)
    await expect(fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)).resolves.toBe(false)

    await waitFor(() => readFile(adapters.logPath('project'), 'utf8'), text => text.includes('server started'))
  }, 120_000)
})
