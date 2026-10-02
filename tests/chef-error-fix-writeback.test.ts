import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createChefService, type ChefService } from '../src/main/chef/service.js'

const roots: string[] = []
const services: ChefService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('主廚終止時回寫 error-fix 一次，重啟後不重複', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chef-error-fix-'))
  roots.push(root)
  const task = {
    id: 'task-1', projectId: 'p1', cwd: root,
    goal: '<error-data>群 ID：group-1</error-data>', purpose: 'error-fix', followups: [],
    policy: { mode: 'auto', allowed: ['claude:model'], maxExecutions: 20, deadlineMinutes: 120 },
    status: 'completed', createdAt: 1, deadlineAt: 2, units: [], attempts: [],
    reason: '完成', cancelRequested: false, needsReconciliation: false,
  }
  await writeFile(join(root, 'tasks.json'), JSON.stringify([task]))
  const onTaskEnded = vi.fn(async () => {})
  const logError = vi.fn()
  const makeService = () => createChefService({
    dir: root, catalog: { list: async () => ({ models: [], notices: [] }) }, rootOf: () => root,
    busyIn: () => false, startWorker: async () => ({ stop: async () => true }), logError,
    onTaskEnded,
  } as Parameters<typeof createChefService>[0])

  services.push(await makeService())
  await vi.waitFor(() => expect(onTaskEnded).toHaveBeenCalledTimes(1))
  const saved = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')) as { errorFixWrittenFor?: string }[]
  expect(saved[0]?.errorFixWrittenFor).toBe('completed|完成')
  await services.pop()?.dispose()

  services.push(await makeService())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(onTaskEnded).toHaveBeenCalledTimes(1)
})

// 審查發現：先卡住、接續後才完成時，第一次回寫就把旗標設上，完成時的 PR 網址不會再寫回。
it('卡住後接續完成時再回寫一次，內容沒變就不重複', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chef-error-fix-'))
  roots.push(root)
  const base = {
    id: 'task-1', projectId: 'p1', cwd: root,
    goal: '<error-data>群 ID：group-1</error-data>', purpose: 'error-fix', followups: [],
    policy: { mode: 'auto', allowed: ['claude:model'], maxExecutions: 20, deadlineMinutes: 120 },
    createdAt: 1, deadlineAt: 2, units: [], attempts: [], cancelRequested: false, needsReconciliation: false,
  }
  const onTaskEnded = vi.fn(async (_task: { status: string }) => {})
  const makeService = () => createChefService({
    dir: root, catalog: { list: async () => ({ models: [], notices: [] }) }, rootOf: () => root,
    busyIn: () => false, startWorker: async () => ({ stop: async () => true }), logError: vi.fn(),
    onTaskEnded,
  } as Parameters<typeof createChefService>[0])
  await writeFile(join(root, 'tasks.json'), JSON.stringify([{ ...base, status: 'blocked', reason: '工具請求被拒絕' }]))
  services.push(await makeService())
  await vi.waitFor(() => expect(onTaskEnded).toHaveBeenCalledTimes(1))
  await services.pop()?.dispose()

  // 模擬接續後完成：保留已寫入的紀錄，只改狀態與報告。
  const saved = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')) as Record<string, unknown>[]
  await writeFile(join(root, 'tasks.json'), JSON.stringify([{ ...saved[0], status: 'completed', reason: '已開 PR',
    report: { unitId: 'u1', outcome: 'completed', summary: 'group-1：https://github.com/o/r/pull/1', checks: [] } }]))
  services.push(await makeService())
  await vi.waitFor(() => expect(onTaskEnded).toHaveBeenCalledTimes(2))
  expect(onTaskEnded.mock.calls[1]?.[0]).toMatchObject({ status: 'completed' })
  await services.pop()?.dispose()

  services.push(await makeService())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(onTaskEnded).toHaveBeenCalledTimes(2)
})

it('error-fix 回寫失敗只記錄錯誤，不改變已結束的任務狀態', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chef-error-fix-fail-'))
  roots.push(root)
  const task = {
    id: 'task-2', projectId: 'p1', cwd: root, goal: '<error-data>群 ID：group-2</error-data>',
    purpose: 'error-fix', followups: [], policy: { mode: 'auto', allowed: ['claude:model'], maxExecutions: 20, deadlineMinutes: 120 },
    status: 'blocked', createdAt: 1, deadlineAt: 2, units: [], attempts: [], reason: '權限被拒', cancelRequested: false, needsReconciliation: false,
  }
  await writeFile(join(root, 'tasks.json'), JSON.stringify([task]))
  const errors: Error[] = []
  const service = await createChefService({
    dir: root, catalog: { list: async () => ({ models: [], notices: [] }) }, rootOf: () => root,
    busyIn: () => false, startWorker: async () => ({ stop: async () => true }),
    logError: error => errors.push(error), onTaskEnded: async () => { throw new Error('write failed') },
  } as Parameters<typeof createChefService>[0])
  services.push(service)
  await vi.waitFor(() => expect(errors.some(error => error.message === 'write failed')).toBe(true))
  const state = await service.handle({ action: 'get' })
  expect(state.kind === 'state' && state.state.tasks[0]?.status).toBe('blocked')
})

it('任務尚未啟動 worker 前的錯誤群狀態寫入失敗時，移除排隊任務', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chef-error-fix-start-'))
  roots.push(root)
  const startWorker = vi.fn(async () => ({ stop: async () => true }))
  const service = await createChefService({
    dir: join(root, 'chef'), catalog: { list: async () => ({ models: [{
      key: 'claude:model', provider: 'claude', model: 'model', label: 'Claude', description: '', recommended: true,
    }], notices: [] }) }, rootOf: () => root, busyIn: () => false, startWorker, logError: () => {},
  })
  services.push(service)
  await expect(service.start('p1', 'error target', {
    mode: 'auto', allowed: ['claude:model'], maxExecutions: 20, deadlineMinutes: 120,
  }, 'error-fix', async () => { throw new Error('狀態寫入失敗') })).rejects.toThrow('狀態寫入失敗')
  const state = await service.handle({ action: 'get' })
  expect(state.kind === 'state' && state.state.tasks).toHaveLength(0)
  expect(startWorker).not.toHaveBeenCalled()
})
