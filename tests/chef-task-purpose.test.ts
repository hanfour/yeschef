import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createChefService, type ChefService } from '../src/main/chef/service.js'

const roots: string[] = []
const services: ChefService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('仍可讀取沒有 purpose 欄位的舊 tasks.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chef-task-purpose-'))
  roots.push(root)
  const dir = join(root, 'chef')
  await mkdir(dir)
  const oldTask = {
    id: 'old-task', projectId: 'p1', cwd: root, goal: '既有工作', followups: [],
    policy: { mode: 'auto', allowed: ['claude:model'], maxExecutions: 8, deadlineMinutes: 120 },
    status: 'completed', createdAt: 1, deadlineAt: 2,
    units: [{ id: 'unit-1', parentId: null, title: '規劃與執行', goal: '既有工作', kind: 'analysis', status: 'done' }],
    attempts: [], reason: '完成', cancelRequested: false, needsReconciliation: false,
  }
  await writeFile(join(dir, 'tasks.json'), JSON.stringify([oldTask]))
  const service = await createChefService({
    dir, catalog: { list: async () => ({ models: [], notices: [] }) }, rootOf: () => root,
    busyIn: () => false, startWorker: async () => ({ stop: async () => true }), logError: () => {},
  })
  services.push(service)
  const state = await service.handle({ action: 'get' })
  expect(state.kind).toBe('state')
  if (state.kind === 'state') expect(state.state.tasks[0]).not.toHaveProperty('purpose')
})
