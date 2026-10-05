import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectRunRunner, type ProjectRunRunnerDeps } from '../src/main/project-run/runner.js'
import type { ProjectRunConfig } from '../src/shared/project-run.js'

const CONFIG: ProjectRunConfig = {
  version: 1, command: 'node server.js --port {port}', cwd: '.', port: 3000,
  url: 'http://127.0.0.1:{port}/', readyPath: '/', env: {}, portStrategy: 'placeholder',
  watch: { enabled: true, include: ['**/*.js'], exclude: [] }, openInBrowser: false,
}

function harness(overrides: Partial<ProjectRunRunnerDeps> = {}) {
  let pid = 1000
  let occupied: { pid: number; processName: string } | undefined
  const groups = new Set<number>()
  const exits = new Map<number, (code: number | null, signal: string | null) => void>()
  const outputs = new Map<number, (stream: 'stdout' | 'stderr', chunk: string) => void>()
  const children: number[] = []
  const watchers: Array<() => void> = []
  const signals: Array<[number, string]> = []
  let surviveKill = false
  let surviveTerm = false
  const deps: ProjectRunRunnerDeps = {
    shell: '/bin/zsh',
    spawn: (_shell, _args, options) => {
      const childPid = ++pid
      children.push(childPid)
      groups.add(childPid)
      return {
        pid: childPid,
        onExit: callback => exits.set(childPid, callback),
        onOutput: callback => { outputs.set(childPid, callback); return () => { outputs.delete(childPid) } },
        options,
      }
    },
    signalGroup: (pgid, signal) => {
      signals.push([pgid, signal])
      if (signal === 'SIGTERM' && surviveTerm) return
      if (signal === 'SIGKILL' && surviveKill) return
      groups.delete(pgid)
      exits.get(pgid)?.(signal === 'SIGTERM' ? 0 : null, signal)
    },
    groupAlive: pgid => groups.has(pgid),
    inspectPort: async port => occupied === undefined || port === 3011 ? { kind: 'free' } : { kind: 'occupied', ...occupied },
    findFreePort: async () => 3011,
    processName: async () => 'node',
    httpGet: async () => ({ status: 200 }),
    appendLog: async () => {},
    readLog: async () => '',
    watch: (_root, _options, changed) => { watchers.push(changed); return () => {} },
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle),
    openInBrowser: async () => {},
    postUnexpectedExit: async () => {},
    logError: () => {},
    ...overrides,
  }
  const runner = createProjectRunRunner(deps)
  return {
    runner, children, watchers, signals,
    setOccupied(value: { pid: number; processName: string } | undefined) { occupied = value },
    surviveKill(value: boolean) { surviveKill = value },
    surviveTerm(value: boolean) { surviveTerm = value },
    exit(pidToExit: number) { exits.get(pidToExit)?.(137, null) },
    output(childPid: number, chunk: string) { outputs.get(childPid)?.('stdout', chunk) },
  }
}

afterEach(() => vi.useRealTimers())

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve()
}

describe('createProjectRunRunner', () => {
  it('從 stopped 啟動至 running，重複啟動不建立第二個程序', async () => {
    const h = harness()
    await expect(h.runner.start('p1', '/project', CONFIG)).resolves.toMatchObject({ state: 'running', port: 3000 })
    await expect(h.runner.start('p1', '/project', CONFIG)).resolves.toMatchObject({ state: 'running' })
    expect(h.children).toHaveLength(1)
  })

  it('HTTP 4xx 仍代表服務已就緒', async () => {
    const h = harness({ httpGet: async () => ({ status: 404 }) })
    await expect(h.runner.start('p1', '/project', CONFIG)).resolves.toMatchObject({ state: 'running' })
  })

  it('記憶體紀錄只保留最後 2000 行', async () => {
    const h = harness()
    await h.runner.start('p1', '/project', CONFIG)
    const child = h.children[0]
    if (child === undefined) throw new Error('missing child')
    h.output(child, Array.from({ length: 2005 }, (_, index) => `line ${index}\n`).join(''))
    expect(h.runner.logs('p1')).toHaveLength(2000)
    expect(h.runner.logs('p1')[0]).toBe('line 5')
    expect(h.runner.logs('p1').at(-1)).toBe('line 2004')
  })

  it('連接埠檢查等待期間按停止，不會在之後啟動程序', async () => {
    let release!: (result: { kind: 'free' }) => void
    const pending = new Promise<{ kind: 'free' }>(resolve => { release = resolve })
    const h = harness({ inspectPort: async () => pending })
    const starting = h.runner.start('p1', '/project', CONFIG)
    await settle()
    await h.runner.stop('p1')
    release({ kind: 'free' })
    await expect(starting).resolves.toMatchObject({ state: 'stopped' })
    expect(h.children).toHaveLength(0)
  })

  it('分辨空 port、本服務已佔用與外部程序佔用', async () => {
    const h = harness()
    await h.runner.start('p1', '/project', CONFIG)
    await expect(h.runner.start('p1', '/project', CONFIG)).resolves.toMatchObject({ state: 'running' })
    await h.runner.stop('p1')
    h.setOccupied({ pid: 9000, processName: 'python' })
    await expect(h.runner.start('p2', '/project', CONFIG)).resolves.toMatchObject({
      state: 'failed', conflict: { pid: 9000, processName: 'python' },
    })
    expect(h.children).toHaveLength(1)
  })

  it('另一個專案管理的服務佔用埠時顯示 owner 專案名稱', async () => {
    const h = harness()
    await h.runner.start('owner', '/projects/owner', CONFIG, { projectName: 'Owner Project' })
    await expect(h.runner.start('requester', '/projects/requester', CONFIG, { projectName: 'Requester Project' }))
      .resolves.toMatchObject({ state: 'failed', conflict: { projectName: 'Owner Project' } })
    expect(h.children).toHaveLength(1)
  })

  it('placeholder port 可改用空 port，command、env 與 URL 一起替換', async () => {
    const h = harness()
    h.setOccupied({ pid: 9000, processName: 'python' })
    const result = await h.runner.start('p1', '/project', { ...CONFIG, env: { PORT: '{port}' } }, { useFreePort: true })
    expect(result).toMatchObject({ state: 'running', port: 3011, url: 'http://127.0.0.1:3011/' })
    expect(h.runner.snapshot('p1').command).toContain('--port 3011')
  })

  it('readyPath 每 500 ms 輪詢，90 秒未得到小於 500 回應就失敗', async () => {
    vi.useFakeTimers()
    const h = harness({ httpGet: async () => ({ status: 503 }) })
    const starting = h.runner.start('p1', '/project', CONFIG)
    await vi.advanceTimersByTimeAsync(90_000)
    await expect(starting).resolves.toMatchObject({ state: 'failed' })
  })

  it('檔案變更防抖一秒後重啟服務', async () => {
    vi.useFakeTimers()
    const opened: string[] = []
    const h = harness({ openInBrowser: async (_projectId, url) => { opened.push(url) } })
    await h.runner.start('p1', '/project', { ...CONFIG, openInBrowser: true })
    expect(opened).toEqual(['http://127.0.0.1:3000/'])
    h.watchers[0]?.()
    await vi.advanceTimersByTimeAsync(999)
    expect(h.children).toHaveLength(1)
    h.watchers[0]?.()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(h.children).toHaveLength(2)
    expect(h.runner.snapshot('p1')).toMatchObject({ state: 'running', restarted: true })
    expect(opened).toHaveLength(1)
  })

  it('五分鐘內最多自動重啟三次，第四次非預期結束轉 failed', async () => {
    const h = harness()
    await h.runner.start('p1', '/project', CONFIG)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = h.children.at(-1)
      if (current === undefined) throw new Error('missing child')
      h.exit(current)
      await settle()
    }
    expect(h.children).toHaveLength(4)
    expect(h.runner.snapshot('p1').state).toBe('failed')
  })

  it('停止先送 SIGTERM，再確認程序群組已清空', async () => {
    const h = harness()
    await h.runner.start('p1', '/project', CONFIG)
    await expect(h.runner.stop('p1')).resolves.toMatchObject({ state: 'stopped' })
    expect(h.signals.map(([, signal]) => signal)).toEqual(['SIGTERM'])
  })

  it('SIGTERM 後十秒仍有群組成員就送 SIGKILL 並再次確認', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.surviveTerm(true)
    await h.runner.start('p1', '/project', CONFIG)
    const stopping = h.runner.stop('p1')
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(stopping).resolves.toMatchObject({ state: 'stopped' })
    expect(h.signals.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('SIGKILL 後程序群組仍存在時不假報 stopped', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.surviveKill(true)
    h.surviveTerm(true)
    await h.runner.start('p1', '/project', CONFIG)
    const stopping = h.runner.stop('p1')
    await vi.advanceTimersByTimeAsync(11_000)
    await expect(stopping).resolves.toMatchObject({ state: 'failed' })
  })
})
