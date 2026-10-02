import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChefService, type ChefService, type WorkerRequest } from '../src/main/chef/service.js'
import type { UiCheckFile } from '../src/main/chef/ui-check/types.js'
import type { ChefModel, ChefPolicy, ChefTask } from '../src/shared/chef.js'

const models: ChefModel[] = [{ key: 'claude:c', provider: 'claude', model: 'c', label: 'Claude', description: '', recommended: true }]
const roots: string[] = [], services: ChefService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function rig(readUiCheckFiles: (key: string, cwd: string) => Promise<readonly UiCheckFile[]>) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'yeschef-ui-check-')))
  roots.push(root)
  const started: WorkerRequest[] = []
  const service = await createChefService({
    dir: join(root, 'tasks'), catalog: { list: async () => ({ models, notices: [] }) },
    rootOf: (id) => id === 'p' ? root : undefined, busyIn: () => false,
    startWorker: async (request) => { started.push(request); return { stop: async () => true } },
    readUiCheckFiles, logError: () => {},
  })
  services.push(service)
  const policy: ChefPolicy = { mode: 'auto', allowed: ['claude:c'], maxExecutions: 6, deadlineMinutes: 30 }
  async function task(): Promise<ChefTask> {
    const response = await service.handle({ action: 'get' })
    if (response.kind !== 'state') throw Error(response.message)
    return response.state.tasks[0]!
  }
  return { root, service, policy, started, task }
}

function end(service: ChefService, workerId: string) {
  service.observe(workerId, [{ kind: 'session-end', isError: false }])
}

async function review(r: Awaited<ReturnType<typeof rig>>) {
  await r.service.start('p', '完成介面工作', r.policy)
  await vi.waitFor(() => expect(r.started).toHaveLength(1))
  const chief = r.started[0]!
  await r.service.delegate(chief.id, { title: '介面實作', kind: 'code', goal: '修改介面檔案' })
  end(r.service, chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const worker = r.started[1]!
  r.service.observe(worker.id, [
    { kind: 'tool-use', id: 'write-ui', name: 'Write', input: { file_path: 'src/Card.css' } },
    { kind: 'tool-result', id: 'write-ui', isError: false, content: 'wrote CSS' },
  ])
  end(r.service, worker.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  return { worker, reviewer: r.started[2]! }
}

function report(workerId: string, uiFindings?: { id: string; resolution: 'fixed' | 'kept'; reason: string }[]) {
  return {
    outcome: 'completed' as const, summary: '完成介面修改與檢查',
    checks: [{ workerId, toolUseId: 'write-ui' }],
    ...(uiFindings === undefined ? {} : { uiFindings }),
  }
}

it('驗收提示列出 CSS 發現，漏回報編號與 error kept 都被拒絕', async () => {
  const r = await rig(async () => [{ path: 'src/Card.css', text: '.badge { font-size: 10px; }\n' }])
  const { worker, reviewer } = await review(r)
  expect(reviewer.prompt).toContain('<ui-check>')
  expect(reviewer.prompt).toContain('F1 tiny-text src/Card.css:1')
  expect((await r.task()).uiCheck?.files).toEqual(['src/Card.css'])
  await expect(r.service.report(reviewer.id, report(worker.id))).rejects.toThrow('缺少編號：F1')
  await expect(r.service.report(reviewer.id, report(worker.id, [{ id: 'F1', resolution: 'kept', reason: '需要保留' }]))).rejects.toThrow('錯誤級')
  await expect(r.service.report(reviewer.id, { ...report(worker.id), uiFindings: [{ id: 'F1', resolution: 'fixed' }] })).rejects.toThrow('回報格式不正確')
})

it('fixed 會重讀檔案，五行內仍有問題會拒絕，修好後接受', async () => {
  let files: UiCheckFile[] = [{ path: 'src/Card.css', text: '.badge { font-size: 10px; }\n' }]
  const r = await rig(async () => files), { worker, reviewer } = await review(r)
  const fixed = [{ id: 'F1', resolution: 'fixed' as const, reason: '已調整字級' }]
  await expect(r.service.report(reviewer.id, report(worker.id, fixed))).rejects.toThrow('仍未修好：F1')
  files = [{ path: 'src/Card.css', text: '\n\n\n\n\n.badge { font-size: 10px; }\n' }]
  await expect(r.service.report(reviewer.id, report(worker.id, fixed))).rejects.toThrow('仍未修好：F1')
  files = [{ path: 'src/Card.css', text: '.badge { font-size: 11px; }\n' }]
  await expect(r.service.report(reviewer.id, report(worker.id, fixed))).resolves.toMatchObject({ recorded: true })
  end(r.service, reviewer.id)
  await vi.waitFor(async () => expect((await r.task()).status).toBe('completed'))
})

it('fixed 後改由有效略過註解擋下時接受，並保存略過原因', async () => {
  let files: UiCheckFile[] = [{ path: 'src/Card.css', text: '.badge { font-size: 10px; }\n' }]
  const r = await rig(async () => files), { worker, reviewer } = await review(r)
  files = [{ path: 'src/Card.css', text: '/* yeschef-ui-ignore tiny-text: 舊版相容 */\n.badge { font-size: 10px; }\n' }]
  const fixed = [{ id: 'F1', resolution: 'fixed' as const, reason: '依專案相容需求保留' }]
  await expect(r.service.report(reviewer.id, report(worker.id, fixed))).resolves.toMatchObject({ recorded: true })
  const state = await r.task()
  expect(state.uiCheck?.findings).toHaveLength(0)
  expect(state.uiCheck?.skipped).toMatchObject([{ ruleId: 'tiny-text', reason: '舊版相容' }])
  expect(state.uiCheck?.skipped?.[0]).not.toHaveProperty('id')
  end(r.service, reviewer.id)
  await vi.waitFor(async () => expect((await r.task()).status).toBe('completed'))
})

it('略過註解缺少原因時仍視為未修好', async () => {
  let files: UiCheckFile[] = [{ path: 'src/Card.css', text: '.badge { font-size: 10px; }\n' }]
  const r = await rig(async () => files), { worker, reviewer } = await review(r)
  files = [{ path: 'src/Card.css', text: '/* yeschef-ui-ignore tiny-text: */\n.badge { font-size: 10px; }\n' }]
  const fixed = [{ id: 'F1', resolution: 'fixed' as const, reason: '改用略過註解' }]
  await expect(r.service.report(reviewer.id, report(worker.id, fixed))).rejects.toThrow('仍未修好：F1')
})

it('warning 可用有原因的 kept 回報，空白原因會被拒絕', async () => {
  const r = await rig(async () => [{ path: 'src/Card.css', text: '.card { border-left: 4px solid red; }\n' }])
  const { worker, reviewer } = await review(r)
  const empty = [{ id: 'F1', resolution: 'kept' as const, reason: '   ' }]
  await expect(r.service.report(reviewer.id, report(worker.id, empty))).rejects.toThrow('必須說明處理原因：F1')
  await expect(r.service.report(reviewer.id, report(worker.id, [{ ...empty[0]!, reason: '目前需保留作狀態標示' }]))).resolves.toMatchObject({ recorded: true })
})

it('掃描範圍為空時不加驗收區塊，舊式 report_result 維持可用', async () => {
  const r = await rig(async () => [])
  const { worker, reviewer } = await review(r)
  expect(reviewer.prompt).not.toContain('<ui-check>')
  expect((await r.task()).uiCheck).toBeUndefined()
  await expect(r.service.report(reviewer.id, report(worker.id))).resolves.toMatchObject({ recorded: true })
})
