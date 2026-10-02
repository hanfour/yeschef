import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChefService, type ChefService, type WorkerRequest } from '../src/main/chef/service.js'
import type { GroupMessageInput } from '../src/main/group/service.js'
import { MSG } from '../src/main/group/messages.js'
import type { ChefModel, ChefPolicy } from '../src/shared/chef.js'
import type { GroupMessage } from '../src/shared/group.js'

vi.setConfig({ testTimeout: 15000 })

const models: ChefModel[] = [
  { key: 'claude:c', provider: 'claude', model: 'c', label: 'Claude default', description: '', recommended: true },
  { key: 'codex:x', provider: 'codex', model: 'x', label: 'Codex default', description: '', recommended: true },
]
const roots: string[] = []
const services: ChefService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function rig(options: { writeThrows?: boolean; withGroup?: boolean; maxExecutions?: number; models?: readonly ChefModel[]; globalReasoningEffort?: string } = {}) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'yeschef-chef-group-')))
  roots.push(root)
  const started: WorkerRequest[] = []
  const errors: Error[] = []
  const written: GroupMessageInput[] = []
  let recent: readonly GroupMessage[] = []
  const available = options.models ?? models
  const service = await createChefService({
    dir: join(root, 'tasks'),
    catalog: { list: async () => ({ models: [...available], notices: [], ...(options.globalReasoningEffort === undefined ? {} : { globalReasoningEffort: options.globalReasoningEffort }) }) },
    rootOf: (id: string) => (id === 'p' ? root : undefined),
    busyIn: () => false,
    logError: (error: Error) => errors.push(error),
    startWorker: async (request: WorkerRequest) => {
      started.push(request)
      return { stop: async () => true }
    },
    ...(options.withGroup === false ? {} : {
      group: {
        write: (input: GroupMessageInput) => {
          if (options.writeThrows === true) throw new Error('群組寫入壞了')
          written.push(input)
        },
        recent: (_projectId: string, _threadId: string, limit: number) => Promise.resolve(recent.slice(-limit)),
      },
    }),
  })
  services.push(service)
  const policy: ChefPolicy = { mode: 'auto', allowed: available.map((m) => m.key), maxExecutions: options.maxExecutions ?? 8, deadlineMinutes: 60 }
  const start = async () => {
    const result = await service.handle({ action: 'start', projectId: 'p', goal: '把整份報表補完', policy })
    expect(result.kind).toBe('state')
    await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(1))
    return started[0]!
  }
  const end = (id: string, over: Record<string, unknown> = {}) =>
    service.observe(id, [{ kind: 'session-end', isError: false, ...over } as never])
  return { root, service, started, errors, written, start, end, setRecent: (next: readonly GroupMessage[]) => { recent = next } }
}

const texts = (written: readonly GroupMessageInput[]) => written.map((w) => `${w.kind}:${w.text}`)

it('主廚起來時寫一則 joined,prompt 帶群組說明', async () => {
  const r = await rig()
  const chief = await r.start()
  expect(chief.prompt).toContain(MSG.chefPrompt)
  expect(texts(r.written)).toEqual([`joined:${MSG.joined('主廚', '規劃與執行', 'c')}`])
  expect(r.written[0]?.from).toEqual({ kind: 'agent', conversationId: chief.id, label: '主廚', provider: 'claude', role: 'chef' })
  expect(r.written[0]?.threadId).toBe(chief.taskId)
})

it('委派寫 delegated,工作者起來寫 joined,完成寫 progress', async () => {
  const r = await rig()
  const chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  expect(texts(r.written).at(-1)).toBe(`delegated:${MSG.delegated('實作', 'code')}`)
  expect(r.written.at(-1)?.from).toEqual({ kind: 'system' })

  r.end(chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const writer = r.started[1]!
  expect(texts(r.written).at(-1)).toBe(`joined:${MSG.joined('codex-1', '實作', 'x')}`)

  r.service.observe(writer.id, [
    { kind: 'tool-use', id: 'edit', name: 'Edit', input: { file_path: 'a' } },
    { kind: 'tool-result', id: 'edit', isError: false, content: 'done' },
  ])
  r.end(writer.id)
  await vi.waitFor(() => expect(texts(r.written)).toContain(`progress:${MSG.unitDone('codex-1', '實作')}`))
})

it('Codex worker 的 joined 訊息與 attempt 記錄實際 effort', async () => {
  const gpt55: ChefModel = {
    key: 'codex:gpt-5.5', provider: 'codex', model: 'gpt-5.5', label: 'GPT 5.5', description: '', recommended: true,
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort, description: '' })),
    defaultReasoningEffort: 'medium',
  }
  const r = await rig({ models: [models[0]!, gpt55], globalReasoningEffort: 'max' })
  const chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  r.end(chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))

  const worker = r.started[1]!
  expect(worker).toMatchObject({ provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'xhigh' })
  expect(worker.tabLabel).toBe('codex-1 · 實作')
  expect(texts(r.written).at(-1)).toBe(`joined:${MSG.joined('codex-1', '實作', 'gpt-5.5', 'xhigh')}`)
  expect(r.service.worker(worker.id)).toMatchObject({ reasoningEffort: 'xhigh' })
  const result = await r.service.handle({ action: 'get' })
  expect(result.kind === 'state' ? result.state.tasks[0]?.attempts.at(-1)?.reasoningEffort : undefined).toBe('xhigh')
})

it('工作者卡住寫 blocked', async () => {
  const r = await rig()
  const chief = await r.start()
  r.service.observe(chief.id, [{ kind: 'tool-use', id: 'pending', name: 'Bash', input: { command: 'gh pr create' } }])
  r.end(chief.id)
  await vi.waitFor(() => expect(texts(r.written).some((t) => t.startsWith('blocked:'))).toBe(true))
  const blocked = r.written.find((w) => w.kind === 'blocked')!
  expect(blocked.text).toContain('主廚')
  expect(blocked.text).toContain('規劃與執行')
  expect(blocked.from).toMatchObject({ kind: 'agent', label: '主廚' })
  expect(r.written.filter((w) => w.kind === 'blocked')).toHaveLength(1)
})

it('任務因執行次數上限卡住時寫一則 system blocked', async () => {
  const r = await rig({ maxExecutions: 1 })
  const chief = await r.start()
  r.end(chief.id)
  await vi.waitFor(() => expect(r.service.tasksOf('p')[0]?.status).toBe('blocked'))
  const blocked = r.written.filter((w) => w.kind === 'blocked')
  expect(blocked).toHaveLength(1)
  expect(blocked[0]).toMatchObject({ from: { kind: 'system' } })
  expect(blocked[0]?.text).toContain('執行次數上限')
})

it('模型故障改派時寫 left', async () => {
  const r = await rig()
  const chief = await r.start()
  r.end(chief.id, { isError: true, apiErrorStatus: 503, errorMessage: 'service unavailable' })
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const left = r.written.find((w) => w.kind === 'left')
  expect(left?.text).toContain('主廚')
  expect(left?.text).toContain('service unavailable')
})

it('任務收尾寫 report,摘要截到五百字', async () => {
  const r = await rig()
  const chief = await r.start()
  r.end(chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const review = r.started[1]!
  await r.service.report(review.id, { outcome: 'completed', summary: '全部做完了'.repeat(200), checks: [] })
  r.end(review.id)
  await vi.waitFor(() => expect(r.written.some((w) => w.kind === 'report')).toBe(true))
  const report = r.written.find((w) => w.kind === 'report')!
  expect(report.text.startsWith('任務完成:')).toBe(true)
  expect(report.text.length).toBeLessThanOrEqual('任務完成:'.length + 500)
  expect(report.from).toEqual({ kind: 'system' })
})

it('群組寫入失敗只 logError,任務照常走完', async () => {
  const r = await rig({ writeThrows: true })
  const chief = await r.start()
  r.end(chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  expect(r.errors.some((e) => e.message.includes('群組'))).toBe(true)
  const review = r.started[1]!
  await r.service.report(review.id, { outcome: 'completed', summary: '任務完成', checks: [] })
  r.end(review.id)
  await vi.waitFor(() => expect(r.service.tasksOf('p')[0]?.status).toBe('completed'))
})

it('progress 對已送達的 worker @ 帶收件人與標記,主廚與一般訊息不帶', async () => {
  const r = await rig()
  const chief = await r.start()
  r.setRecent([
    {
      id: 'm0', projectId: 'p', threadId: chief.taskId, at: 0, kind: 'text' as const,
      mentions: ['codex-2'], deliveredMentions: ['codex-2'], from: { kind: 'user' as const }, text: 'x'.repeat(400),
    },
    {
      id: 'm1', projectId: 'p', threadId: chief.taskId, at: 1, kind: 'text' as const,
      mentions: ['主廚'], from: { kind: 'user' as const }, text: '@主廚 請看一下',
    },
    {
      id: 'm2', projectId: 'p', threadId: chief.taskId, at: 2, kind: 'text' as const,
      mentions: [], from: { kind: 'user' as const }, text: '一般背景訊息',
    },
    ...Array.from({ length: 2 }, (_, i) => ({
    id: `m${i}`, projectId: 'p', threadId: chief.taskId, at: i, kind: 'text' as const, mentions: [],
    from: { kind: 'agent' as const, conversationId: 'c', label: 'codex-1', provider: 'codex' as const, role: 'worker' as const },
    text: 'x'.repeat(400),
    })),
  ])
  const progress = await r.service.progress(chief.id)
  expect(progress.groupMessages).toHaveLength(5)
  expect(progress.groupMessages[0]?.from).toBe('你')
  expect(progress.groupMessages[0]?.text).toHaveLength(300)
  expect(progress.groupMessages[0]).toMatchObject({ mentions: ['codex-2'], deliveredToParticipant: true })
  expect(progress.groupMessages[1]).not.toHaveProperty('mentions')
  expect(progress.groupMessages[1]).not.toHaveProperty('deliveredToParticipant')
  expect(progress.groupMessages[2]).not.toHaveProperty('mentions')
  expect(progress.groupMessages[2]).not.toHaveProperty('deliveredToParticipant')
  expect(progress.groupMessages[3]?.from).toBe('codex-1')
  expect(progress.attempts).toHaveLength(1)
})

it('沒接 group dep 時 progress 的群組訊息為空', async () => {
  const r = await rig({ withGroup: false })
  const chief = await r.start()
  expect((await r.service.progress(chief.id)).groupMessages).toEqual([])
})

it('start 回新的 taskId,目標為空時丟錯且不留下任務', async () => {
  const r = await rig()
  const policy = { mode: 'auto' as const, allowed: models.map((m) => m.key), maxExecutions: 8, deadlineMinutes: 60 }
  const taskId = await r.service.start('p', '把整份報表補完', policy)
  expect(r.service.tasksOf('p').map((t) => t.id)).toEqual([taskId])
  await expect(r.service.start('p', '   ', policy)).rejects.toThrow('請輸入任務目標')
  expect(r.service.tasksOf('p')).toHaveLength(1)
  await expect(r.service.start('別的專案', '做點什麼', policy)).rejects.toThrow('專案已不存在')
})

it('sayToGroup 寫一則 text,不是目前執行者就拒絕', async () => {
  const r = await rig()
  const chief = await r.start()
  await r.service.sayToGroup(chief.id, { text: '我打算先補測試' })
  expect(texts(r.written).at(-1)).toBe('text:我打算先補測試')
  expect(r.written.at(-1)?.from).toMatchObject({ kind: 'agent', label: '主廚' })
  await expect(r.service.sayToGroup('不存在', { text: '嗨' })).rejects.toThrow('找不到主廚任務')
  await expect(r.service.sayToGroup(chief.id, { text: '' })).rejects.toThrow()
})

it('tasksOf 只回那個專案的任務', async () => {
  const r = await rig()
  await r.start()
  expect(r.service.tasksOf('p')).toHaveLength(1)
  expect(r.service.tasksOf('別的專案')).toHaveLength(0)
})

it('tasksOf 回傳隔離的淺拷貝並清空 attempt events', async () => {
  const r = await rig()
  const chief = await r.start()
  r.service.observe(chief.id, [
    { kind: 'tool-use', id: 'proof', name: 'Read', input: { file_path: 'report.md' } },
    { kind: 'tool-result', id: 'proof', isError: false, content: '已讀取報表' },
  ])
  const task = r.service.tasksOf('p')[0]!
  const attempt = task.attempts[0]!
  expect(attempt.events).toEqual([])
  task.goal = '外部修改'
  attempt.status = 'failed'
  attempt.events.push({ kind: 'tool-result', id: 'fake', isError: false, content: '假資料' })
  expect(r.service.tasksOf('p')[0]?.goal).toBe('把整份報表補完')
  const progress = await r.service.progress(chief.id)
  expect(progress.attempts[0]?.status).toBe('running')
  expect(progress.attempts[0]?.receipts).toHaveLength(1)
})
