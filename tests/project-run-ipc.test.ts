import { describe, expect, it, vi } from 'vitest'
import { createProjectRunIpcHandler, type ProjectRunIpcDeps } from '../src/main/project-run/ipc.js'
import type { ProjectRunConfig } from '../src/shared/project-run.js'
import type { ProjectRunRunner } from '../src/main/project-run/runner.js'
import type { ProjectRunStatus } from '../src/shared/project-run.js'

const CONFIG: ProjectRunConfig = {
  version: 1, command: 'node server.mjs --port {port}', cwd: '.', port: 4310,
  url: 'http://127.0.0.1:{port}/', readyPath: '/', env: {}, portStrategy: 'placeholder',
  watch: { enabled: false, include: ['**/*'], exclude: [] }, openInBrowser: true,
}

function rig() {
  let stored: ProjectRunConfig | undefined
  let status: ProjectRunStatus = { projectId: 'p1', state: 'stopped', restarted: false }
  const calls: unknown[] = []
  const acknowledgeRestart = vi.fn()
  const deps: ProjectRunIpcDeps = {
    isTrustedSender: sender => sender === 'trusted',
    projectRoot: id => id === 'p1' ? '/project' : undefined,
    projectName: id => id === 'p1' ? 'Demo Project' : undefined,
    configStore: {
      load: async () => stored,
      save: async (_id, config) => { stored = config as ProjectRunConfig },
      removeProject: async () => {},
    },
    runner: {
      start: vi.fn(async (_id, _root, config, options) => {
        calls.push(['start', config, options])
        status = { projectId: 'p1', state: 'running', restarted: false, port: config.port }
        return status
      }),
      stop: vi.fn(async () => { status = { projectId: 'p1', state: 'stopped', restarted: false }; return status }),
      restart: vi.fn(async () => status),
      snapshot: () => status,
      logs: () => ['recent log'],
      acknowledgeRestart,
      stopAll: async () => {},
      managedServices: () => [],
      subscribe: () => () => {},
    } as ProjectRunRunner,
    discover: async () => [{ command: 'npm run dev', cwd: '.', port: 4310, source: 'package.json scripts.dev' }],
    readLog: async () => 'disk log',
    logPath: id => `/user-data/project-run/logs/${id}.log`,
    openInBrowser: async id => { calls.push(['open', id]) },
    refreshBrowser: async id => { calls.push(['refresh', id]) },
    openLog: async path => { calls.push(['openLog', path]); return '' },
    logError: () => {},
  }
  return { handler: createProjectRunIpcHandler(deps), deps, calls, acknowledgeRestart, get config() { return stored } }
}

describe('createProjectRunIpcHandler', () => {
  it('拒絕非 renderer 來源，取得候選和設定狀態', async () => {
    const h = rig()
    await expect(h.handler({ sender: 'foreign' }, { action: 'get', projectId: 'p1' })).resolves.toEqual({
      kind: 'error', message: '不接受此來源的專案執行請求',
    })
    await expect(h.handler({ sender: 'trusted' }, { action: 'get', projectId: 'p1' })).resolves.toMatchObject({
      kind: 'state', candidates: [{ source: 'package.json scripts.dev' }],
      snapshot: { state: 'stopped' }, logs: ['recent log'], logPath: '/user-data/project-run/logs/p1.log',
    })
  })

  it('保存後按 start 使用專案根目錄設定，並能開啟服務與完整紀錄', async () => {
    const h = rig()
    await expect(h.handler({ sender: 'trusted' }, { action: 'save', projectId: 'p1', config: CONFIG })).resolves.toMatchObject({ kind: 'state', config: CONFIG })
    await expect(h.handler({ sender: 'trusted' }, { action: 'start', projectId: 'p1', useFreePort: true })).resolves.toMatchObject({ snapshot: { state: 'running' } })
    await h.handler({ sender: 'trusted' }, { action: 'open', projectId: 'p1' })
    await h.handler({ sender: 'trusted' }, { action: 'openLog', projectId: 'p1' })
    expect(h.calls).toContainEqual(['start', CONFIG, { useFreePort: true, projectName: 'Demo Project' }])
    expect(h.calls).toContainEqual(['open', 'p1'])
    expect(h.calls).toContainEqual(['openLog', '/user-data/project-run/logs/p1.log'])
  })

  it('重新整理會清除重啟提示，錯誤 payload 不進服務', async () => {
    const h = rig()
    await expect(h.handler({ sender: 'trusted' }, { action: 'save', projectId: 'missing', config: CONFIG })).resolves.toMatchObject({ kind: 'error' })
    await h.handler({ sender: 'trusted' }, { action: 'refresh', projectId: 'p1' })
    expect(h.calls).toContainEqual(['refresh', 'p1'])
    expect(h.acknowledgeRestart).toHaveBeenCalledWith('p1')
  })
})
