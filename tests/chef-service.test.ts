import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChefService, type ChefService, type WorkerRequest } from '../src/main/chef/service.js'
import { createConversation, type Conversation, type ConversationSink } from '../src/main/conversation.js'
import type { AgentHost, AgentHostDeps } from '../src/main/agent-host.js'
import type { ApprovalOutcome } from '../src/main/approval.js'
import type { SessionOptions } from '../src/main/session-args.js'
import type { ChefModel, ChefPolicy, ChefTask } from '../src/shared/chef.js'
import type { Event } from '../src/shared/events.js'
import type { GroupMessageInput } from '../src/main/group/service.js'
vi.setConfig({ testTimeout: 15000 })
const models: ChefModel[] = [{ key: 'claude:c', provider: 'claude', model: 'c', label: 'Claude default', description: '', recommended: true }, { key: 'codex:x', provider: 'codex', model: 'x', label: 'Codex default', description: '', recommended: true }]
const retryModels: ChefModel[] = [
  models[0]!,
  { key: 'codex:gpt-6-astra', provider: 'codex', model: 'gpt-6-astra', label: 'Codex Astra', description: '', recommended: true },
  { key: 'codex:gpt-5', provider: 'codex', model: 'gpt-5', label: 'Codex fallback', description: '', recommended: false },
]
const unsupportedAstra = 'unexpected status 404 Not Found: Model "gpt-6-astra" is not supported by any configured account in this group, url: https://api.example.com/responses, request id: red-test'
const roots: string[] = [], services: ChefService[] = []
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function rig(options: { stopped?: boolean; start?: (request: WorkerRequest) => Promise<void>; onStop?: () => Promise<void>; models?: readonly ChefModel[]; maxExecutions?: number; busy?: boolean; groupWriteThrows?: boolean; now?: () => number } = {}) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'yeschef-chef-'))); roots.push(root)
  const started: WorkerRequest[] = [], ready: string[] = [], stopped: string[] = [], errors: Error[] = []
  const available = [...(options.models ?? models)]
  const milestones: GroupMessageInput[] = []
  const catalog = { list: async () => ({ models: available, notices: [] }) }
  const deps = { dir: join(root, 'tasks'), catalog, rootOf: (id: string) => id === 'p' ? root : undefined, busyIn: () => options.busy === true, logError: (e: Error) => errors.push(e), ...(options.now ? { now: options.now } : {}), group: { write: (message: GroupMessageInput) => { if (options.groupWriteThrows) throw Error('group write failed'); milestones.push(message) }, recent: async () => [] }, startWorker: async (request: WorkerRequest) => { started.push(request); await options.start?.(request); ready.push(request.id); return { stop: async () => { await options.onStop?.(); stopped.push(request.id); return options.stopped !== false } } } }
  const service = await createChefService(deps); services.push(service)
  const policy: ChefPolicy = { mode: 'auto', allowed: available.map(m => m.key), maxExecutions: options.maxExecutions ?? 6, deadlineMinutes: 30 }
  async function task(): Promise<ChefTask> { const response = await service.handle({ action: 'get' }); if (response.kind !== 'state') throw Error(response.message); return response.state.tasks[0]! }
  async function start(over: Partial<ChefPolicy> = {}, goal = '完成可驗證的合成工作') { const result = await service.handle({ action: 'start', projectId: 'p', goal, policy: { ...policy, ...over } }); expect(result.kind).toBe('state'); await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(1)); return started[0]! }
  const end = (id: string, over: Partial<Extract<Event, { kind: 'session-end' }>> = {}) => service.observe(id, [{ kind: 'session-end', isError: false, ...over }])
  return { root, deps, service, started, ready, stopped, errors, milestones, start, task, end, policy }
}
it('主廚委派序列執行、按工作類型選模型，驗收引用真實工具結果才完成', async () => {
  const r = await rig(), chief = await r.start()
  expect(chief.provider).toBe('claude')
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  await r.service.delegate(chief.id, { title: '測試', kind: 'test', goal: '執行測試' })
  expect(r.started).toHaveLength(1)
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const writer = r.started[1]!
  expect(writer.provider).toBe('codex'); expect(writer.prompt).toContain('直接完成本次工作')
  await expect(r.service.delegate(writer.id, { title: '重複', kind: 'code', goal: '修改檔案' })).rejects.toThrow('不能再次委派')
  r.service.observe(writer.id, [{ kind: 'session-start', sessionId: 'sx', model: 'actual-x' }, { kind: 'tool-use', id: 'edit', name: 'Edit', input: { file_path: 'a' } }, { kind: 'tool-result', id: 'edit', isError: false, content: 'done' }]); r.end(writer.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(3)); const test = r.started[2]!
  r.service.observe(test.id, [{ kind: 'tool-use', id: 'test', name: 'Bash', input: { command: 'npm test' } }, { kind: 'tool-result', id: 'test', isError: false, content: 'tests passed' }]); r.end(test.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(4)); const review = r.started[3]!
  expect(review.provider).toBe('claude'); expect(r.stopped).toEqual([chief.id, writer.id, test.id])
  await expect(r.service.report(review.id, { outcome: 'completed', summary: 'done', checks: [] })).rejects.toThrow('工具結果')
  await r.service.report(review.id, { outcome: 'completed', summary: '實作及測試完成', checks: [{ workerId: writer.id, toolUseId: 'edit' }, { workerId: test.id, toolUseId: 'test' }] })
  r.end(review.id); await vi.waitFor(async () => expect((await r.task()).status).toBe('completed'))
  expect((await r.task()).attempts[1]?.actualModel).toBe('actual-x')
  expect(r.service.sources(review.id)).toContainEqual({ provider: 'codex', sessionId: 'sx' })
})
it('載入舊主廚任務時將已保存的 MCP 工具事件名稱轉成 YesChef 前綴', async () => {
  const r = await rig(), worker = await r.start()
  r.service.observe(worker.id, [{ kind: 'tool-use', id: 'legacy-tool', name: 'mcp__sidepane__view_click', input: {} }])
  await r.service.dispose()
  const path = join(r.deps.dir, 'tasks.json')
  const oldTasks = JSON.parse(await readFile(path, 'utf8')) as ChefTask[]
  expect(oldTasks[0]?.attempts[0]?.events).toContainEqual(expect.objectContaining({ name: 'mcp__sidepane__view_click' }))

  const reloaded = await createChefService(r.deps)
  services.push(reloaded)
  await reloaded.dispose()
  const migratedTasks = JSON.parse(await readFile(path, 'utf8')) as ChefTask[]
  expect(migratedTasks[0]?.attempts[0]?.events).toContainEqual(expect.objectContaining({ name: 'mcp__yeschef__view_click' }))
})
it('503 後先確認舊 worker 停止再改派，checkpoint 保留已完成工具，不跨 provider resume', async () => {
  const r = await rig(), first = await r.start()
  r.service.observe(first.id, [{ kind: 'session-start', sessionId: 'original', model: 'actual-c' }, { kind: 'tool-use', id: 'read', name: 'Read', input: { file_path: 'a' } }, { kind: 'tool-result', id: 'read', isError: false, content: 'existing work' }])
  r.end(first.id, { isError: true, apiErrorStatus: 503, errorMessage: 'service unavailable' })
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  expect(r.stopped).toEqual([first.id]); expect(r.started[1]?.provider).toBe('codex')
  expect(r.started[1]?.prompt).toContain('existing work'); expect(r.started[1]).not.toHaveProperty('resumeSessionId')
})
it('worker 用完回合上限時不卡住，同一單元帶著 checkpoint 接續', async () => {
  const r = await rig(), first = await r.start()
  r.service.observe(first.id, [{ kind: 'session-start', sessionId: 'turns', model: 'actual-c' }, { kind: 'tool-use', id: 'w', name: 'Write', input: { file_path: 'plan.md' } }, { kind: 'tool-result', id: 'w', isError: false, content: 'half of the plan written' }])
  r.end(first.id, { isError: true, errorMessage: 'Reached maximum number of turns (64)' })
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  expect(r.started[1]?.prompt).toContain('half of the plan written')
  const state = await r.service.handle({ action: 'get' })
  if (state.kind !== 'state') throw new Error('state expected')
  const task = state.state.tasks.at(-1)!
  expect(task.status).toBe('running')
  expect(task.attempts[0]?.status).toBe('done')
  expect(task.attempts[0]?.reason).toContain('回合上限')
})
it('同一單元連續用完回合上限超過接續次數後才卡住', async () => {
  const r = await rig()
  await r.start()
  for (let index = 0; index < 4; index += 1) {
    await vi.waitFor(() => expect(r.started).toHaveLength(index + 1))
    r.end(r.started[index]!.id, { isError: true, errorMessage: 'Reached maximum number of turns (64)' })
  }
  await vi.waitFor(async () => {
    const state = await r.service.handle({ action: 'get' })
    if (state.kind !== 'state') throw new Error('state expected')
    expect(state.state.tasks.at(-1)?.status).toBe('blocked')
  })
  expect(r.started).toHaveLength(4)
  const state = await r.service.handle({ action: 'get' })
  if (state.kind === 'state') expect(state.state.tasks.at(-1)?.reason).toContain('回合上限')
})
it('error-intake 任務的群組里程碑不帶資料庫連線字串', async () => {
  const r = await rig()
  const secret = 'mysql://ei_project:never-show-this@db.test/errors'
  const goal = '安裝錯誤收集工具，連線字串留在主行程設定中'
  const taskId = await r.service.start('p', goal, r.policy, 'error-intake-setup')
  await vi.waitFor(() => expect(r.started).toHaveLength(1))
  const state = await r.service.handle({ action: 'get' })
  expect(state.kind).toBe('state')
  if (state.kind === 'state') expect(state.state.tasks.find((task) => task.id === taskId)?.purpose).toBe('error-intake-setup')
  expect(JSON.stringify(r.milestones)).not.toContain(secret)
})
it('上游不支援 Astra 時，同一個 code 單位改派到另一個 Codex 模型並寫 left', async () => {
  const r = await rig({ models: retryModels }), chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const first = r.started[1]!
  r.end(first.id, { isError: true, apiErrorStatus: 404, errorMessage: unsupportedAstra })
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  const task = await r.task(), unit = task.units.find((candidate) => candidate.kind === 'code')
  expect(r.started[1]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' })
  expect(r.started[2]).toMatchObject({ provider: 'codex', model: 'gpt-5', title: '實作' })
  expect(task.attempts.filter((attempt) => attempt.unitId === unit?.id).map((attempt) => attempt.status)).toEqual(['failed', 'running'])
  expect(r.milestones.some((message) => message.kind === 'left' && message.from.kind === 'agent' && message.text.includes('not supported'))).toBe(true)
  expect(r.milestones.some((message) => message.kind === 'blocked' && message.unitId === unit?.id)).toBe(false)
})
it('task 內第一個 code 單位遇到不可用模型後，第二個 code 單位不再選它', async () => {
  const r = await rig({ models: retryModels }), chief = await r.start()
  await r.service.delegate(chief.id, { title: '第一項實作', kind: 'code', goal: '先完成第一項' })
  await r.service.delegate(chief.id, { title: '第二項實作', kind: 'code', goal: '再完成第二項' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  expect(r.started[1]).toMatchObject({ model: 'gpt-6-astra', title: '第一項實作' })
  r.end(r.started[1]!.id, { isError: true, apiErrorStatus: 404, errorMessage: unsupportedAstra })
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  expect(r.started[2]).toMatchObject({ model: 'gpt-5', title: '第一項實作' })
  r.end(r.started[2]!.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(4))
  expect(r.started[3]).toMatchObject({ model: 'gpt-5', title: '第二項實作' })
})
it('任務 A 的模型不可用會暫時排除任務 B 的首次選擇，24 小時後可重新選用', async () => {
  const clock = { value: 1_800_000_000_000 }
  const models: ChefModel[] = [
    { key: 'codex:gpt-6-sol', provider: 'codex', model: 'gpt-6-sol', label: 'Codex Sol', description: '', recommended: true },
    { key: 'codex:gpt-5', provider: 'codex', model: 'gpt-5', label: 'Codex fallback', description: '', recommended: false },
  ]
  const r = await rig({ models, now: () => clock.value })
  const first = await r.start()
  expect(first.model).toBe('gpt-6-sol')
  r.end(first.id, { isError: true, apiErrorStatus: 404, errorMessage: 'unexpected status 404 Not Found: Model "gpt-6-sol" is not supported by any configured account in this group' })
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const firstTaskFallback = r.started[1]!
  expect(firstTaskFallback.model).toBe('gpt-5')
  await r.service.report(firstTaskFallback.id, { outcome: 'completed', summary: '任務 A 完成', checks: [] })
  r.end(firstTaskFallback.id)
  await vi.waitFor(async () => {
    const response = await r.service.handle({ action: 'get' })
    expect(response.kind === 'state' ? response.state.tasks[0]?.status : undefined).toBe('completed')
  })

  await r.service.handle({ action: 'start', projectId: 'p', goal: '任務 B', policy: r.policy })
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  const secondTaskWorker = r.started[2]!
  expect(secondTaskWorker.model).toBe('gpt-5')
  const state = await r.service.handle({ action: 'get' })
  expect(state).toMatchObject({ kind: 'state', state: { unavailableModels: [{ key: 'codex:gpt-6-sol', expiresAt: clock.value + 24 * 60 * 60 * 1000 }] } })
  await r.service.report(secondTaskWorker.id, { outcome: 'completed', summary: '任務 B 完成', checks: [] })
  r.end(secondTaskWorker.id)
  await vi.waitFor(async () => {
    const response = await r.service.handle({ action: 'get' })
    expect(response.kind === 'state' ? response.state.tasks.at(-1)?.status : undefined).toBe('completed')
  })

  await r.service.handle({ action: 'start', projectId: 'p', goal: '僅允許冷卻中的模型', policy: { ...r.policy, allowed: ['codex:gpt-6-sol'] } })
  await vi.waitFor(async () => {
    const response = await r.service.handle({ action: 'get' })
    expect(response.kind === 'state' ? response.state.tasks.at(-1)?.status : undefined).toBe('blocked')
  })
  const blockedState = await r.service.handle({ action: 'get' })
  if (blockedState.kind === 'state') expect(blockedState.state.tasks.at(-1)).toMatchObject({ reason: '沒有可用且獲授權的候選模型；請檢查連線或模型池。', attempts: [] })
  expect(r.started).toHaveLength(3)

  clock.value += 24 * 60 * 60 * 1000 + 1
  await r.service.handle({ action: 'start', projectId: 'p', goal: '任務 C', policy: r.policy })
  await vi.waitFor(() => expect(r.started).toHaveLength(4))
  expect(r.started[3]?.model).toBe('gpt-6-sol')
})
it('一般 provider 故障的排序影響仍只限於原工作單位', async () => {
  const r = await rig({ models: retryModels }), chief = await r.start()
  await r.service.delegate(chief.id, { title: '第一項實作', kind: 'code', goal: '先完成第一項' })
  await r.service.delegate(chief.id, { title: '第二項實作', kind: 'code', goal: '再完成第二項' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  r.end(r.started[1]!.id, { isError: true, apiErrorStatus: 503, errorMessage: 'service unavailable' })
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  expect(r.started[2]).toMatchObject({ provider: 'claude', title: '第一項實作' })
  r.end(r.started[2]!.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(4))
  expect(r.started[3]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', title: '第二項實作' })
})
it('所有 Codex 模型都回報模型不可用後才改派到 Claude', async () => {
  const r = await rig({ models: retryModels }), chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  r.end(r.started[1]!.id, { isError: true, apiErrorStatus: 404, errorMessage: unsupportedAstra })
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  r.end(r.started[2]!.id, { isError: true, apiErrorStatus: 404, errorMessage: 'unexpected status 404 Not Found: Model "gpt-5" does not exist' })
  await vi.waitFor(() => expect(r.started).toHaveLength(4))
  expect(r.started[1]?.provider).toBe('codex')
  expect(r.started[2]?.provider).toBe('codex')
  expect(r.started[3]).toMatchObject({ provider: 'claude', title: '實作' })
})
it('未登入錯誤仍排除整個 provider', async () => {
  const r = await rig({ models: retryModels }), chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  r.end(r.started[1]!.id, { isError: true, apiErrorStatus: 401, errorMessage: 'not logged in' })
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  expect(r.started[1]?.provider).toBe('codex')
  expect(r.started[2]).toMatchObject({ provider: 'claude', title: '實作' })
})
it('模型不可用改派到 maxExecutions 上限時停止並說明原因', async () => {
  const r = await rig({ models: retryModels, maxExecutions: 3 }), chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  r.end(r.started[1]!.id, { isError: true, apiErrorStatus: 404, errorMessage: unsupportedAstra })
  await vi.waitFor(() => expect(r.started).toHaveLength(3))
  r.end(r.started[2]!.id, { isError: true, apiErrorStatus: 404, errorMessage: 'unexpected status 404 Not Found: Model "gpt-5" does not exist' })
  await vi.waitFor(async () => expect((await r.task()).status).toBe('blocked'))
  const task = await r.task()
  expect(r.started).toHaveLength(3)
  expect(task.attempts.at(-1)?.status).toBe('failed')
  expect(task.reason).toContain('執行次數上限')
})
it.each(['pending', 'unconfirmed'] as const)('%s 不會觸發不安全改派', async kind => {
  const r = await rig({ stopped: kind !== 'unconfirmed' }), first = await r.start()
  if (kind === 'pending') r.service.observe(first.id, [{ kind: 'tool-use', id: 'write', name: 'Bash', input: { command: 'gh pr create' } }])
  r.end(first.id, { isError: true, apiErrorStatus: 503 })
  await vi.waitFor(async () => expect((await r.task()).status).toBe('blocked'))
  expect(r.started).toHaveLength(1); expect((await r.task()).needsReconciliation).toBe(true)
})
it.each([
  { timedOut: false, reason: '工具請求被拒絕；不會透過改派繞過決定。' },
  { timedOut: true, reason: '權限請求逾時沒有回覆，任務已暫停；在群組回覆即可接續。' },
])('權限拒絕 timedOut=$timedOut 不要求核對且保留原因', async ({ timedOut, reason }) => {
  const r = await rig(), first = await r.start()
  r.service.denied(first.id, { timedOut })
  r.end(first.id)
  await vi.waitFor(async () => expect((await r.task()).status).toBe('blocked'))
  const task = await r.task()
  expect(task).toMatchObject({ reason, needsReconciliation: false })
  expect(task.attempts[0]).toMatchObject({ denied: true, deniedTimedOut: timedOut })
  expect(r.started).toHaveLength(1)
})
it('測試失敗／一般錯誤與固定模式不當成可改派的模型故障', async () => {
  const r = await rig(), first = await r.start({ mode: 'pinned', preferred: 'claude:c' })
  r.end(first.id, { isError: true, apiErrorStatus: 503 })
  await vi.waitFor(async () => expect((await r.task()).status).toBe('blocked')); expect(r.started).toHaveLength(1)
})
it('相同工作目錄同時送兩個 start 只有一個取得租約，普通對話受 guard 保護', async () => {
  const r = await rig()
  const policy = { mode: 'auto', allowed: models.map(m => m.key), maxExecutions: 6, deadlineMinutes: 30 }
  const result = await Promise.all([r.service.handle({ action: 'start', projectId: 'p', goal: 'A', policy }), r.service.handle({ action: 'start', projectId: 'p', goal: 'B', policy })])
  expect(result.filter(r => r.kind === 'state')).toHaveLength(1)
  expect(r.service.guard('manual', r.root)).toContain('主廚任務使用中')
})
it('新目標被需要核對的主廚任務擋下時指出目標與狀態', async () => {
  const goal = 'PR 都被 approved 了，可以合併 #137，並核對最後的部署記錄'
  const prefix = Array.from(goal).slice(0, 30).join('')
  const r = await rig({ stopped: false }), first = await r.start({}, goal)
  r.end(first.id)
  await vi.waitFor(async () => expect((await r.task()).needsReconciliation).toBe(true))
  const result = await r.service.handle({ action: 'start', projectId: 'p', goal: '新的目標', policy: r.policy })
  expect(result).toMatchObject({
    kind: 'error',
    message: `工作目錄被主廚任務「${prefix}」佔著（卡住，需要核對），請先到主廚視窗處理或停止它`,
  })
})
it('執行中的主廚任務擋下新目標時標示執行中', async () => {
  const r = await rig(), first = await r.start({}, '正在驗收的目標')
  const result = await r.service.handle({ action: 'start', projectId: 'p', goal: '新的目標', policy: r.policy })
  expect(result).toEqual({
    kind: 'error',
    message: '工作目錄被主廚任務「正在驗收的目標」佔著（執行中），請先到主廚視窗處理或停止它',
  })
  expect(r.started).toEqual([first])
})
it('一般對話佔用工作目錄時使用對話提示', async () => {
  const r = await rig({ busy: true })
  const result = await r.service.handle({ action: 'start', projectId: 'p', goal: '新的目標', policy: r.policy })
  expect(result).toEqual({ kind: 'error', message: '這個工作目錄有對話正在執行，請等它結束' })
})
it('使用者停止後不改派，保留進度並可用明確補充接續', async () => {
  const r = await rig(), first = await r.start()
  const task = await r.task(); await r.service.handle({ action: 'cancel', taskId: task.id })
  expect(r.milestones.at(-1)).toMatchObject({ kind: 'blocked', from: { kind: 'system' } })
  expect(r.milestones.at(-1)?.text).toContain('使用者停止')
  expect(r.milestones.at(-1)?.text).toContain('在這個目標裡回覆即可接續')
  r.end(first.id, { isError: true, apiErrorStatus: 503 }); await new Promise(resolve => setTimeout(resolve, 10))
  expect(r.started).toHaveLength(1); expect((await r.task()).status).toBe('cancelled')
  await r.service.handle({ action: 'resume', taskId: task.id, reconciled: false, message: '新增限制：不要發布' })
  await vi.waitFor(() => expect(r.started).toHaveLength(2)); expect(r.started[1]?.prompt).toContain('新增限制')
})
it('blockUnit 的里程碑已帶接續提示時不再寫任務層重複訊息', async () => {
  const r = await rig({ stopped: false }), first = await r.start()
  r.end(first.id)
  await vi.waitFor(async () => expect((await r.task()).status).toBe('blocked'))
  const terminal = r.milestones.filter(message => message.kind === 'blocked')
  expect(terminal).toHaveLength(1)
  // 舊執行者沒確認停止，需要核對：群組回覆不會接續，提示要指向主廚視窗。
  expect(terminal[0]?.text).toContain('按群組下方的「確認後接續」')
  expect(terminal[0]?.text).not.toContain('在這個目標裡回覆即可接續')
})
it('任務層直接卡住時寫入含原因與接續提示的系統訊息', async () => {
  const r = await rig({ maxExecutions: 1 }), first = await r.start()
  r.end(first.id)
  await vi.waitFor(async () => expect((await r.task()).status).toBe('blocked'))
  const terminal = r.milestones.filter(message => message.kind === 'blocked')
  expect(terminal).toHaveLength(1)
  expect(terminal[0]).toMatchObject({ from: { kind: 'system' } })
  expect(terminal[0]?.text).toContain('已達本任務的時間或執行次數上限')
  expect(terminal[0]?.text).toContain('在這個目標裡回覆即可接續')
})
it('工作台關閉時群組寫入失敗不會讓 dispose 失敗', async () => {
  const r = await rig({ groupWriteThrows: true })
  await r.start()
  await expect(r.service.dispose()).resolves.toBeUndefined()
})
it('cancel 停止 worker 並關閉對話時,無逾時批准會 settle 成 deny', async () => {
  let core: Conversation | undefined
  let hostDeps: AgentHostDeps | undefined
  let approval: Promise<ApprovalOutcome> | undefined
  const sink: ConversationSink = { events: () => {}, state: () => {}, approvalAsk: () => {}, approvalSettled: () => {} }
  const host: AgentHost = { start: () => {}, send: () => true, interrupt: async () => {}, teardown: async () => {} }
  const r = await rig({
    start: async () => {
      const sessionOptions: SessionOptions = { cwd: r.root, permissionMode: 'default', includePartialMessages: true, settingSources: [] }
      core = createConversation({
        sink, sessionOptions: () => sessionOptions, loadHistory: async () => [], logError: () => {}, approvalTimeoutMs: null,
        createHost: deps => { hostDeps = deps; return host },
      })
      core.activate()
      core.startNew()
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!hostDeps) throw Error('對話 host 尚未建立')
      approval = hostDeps.requestApproval({ toolUseId: 'toolu_merge', toolName: 'Bash', input: { command: 'gh pr merge 137' } })
    },
    onStop: async () => { await core?.dispose() },
  })
  const first = await r.start()
  await vi.waitFor(() => expect(r.ready).toContain(first.id))
  expect(core?.pendingApprovals()).toBe(1)
  await r.service.handle({ action: 'cancel', taskId: (await r.task()).id })
  await expect(approval).resolves.toEqual({ decision: 'deny', reason: '視窗已關閉' })
  expect(core?.pendingApprovals()).toBe(0)
})
it('舊版因權限被拒而要求核對的任務，讀取時拿掉核對，可直接接續', async () => {
  const r = await rig(); await r.start()
  await r.service.dispose()
  const records = JSON.parse(await readFile(join(r.deps.dir, 'tasks.json'), 'utf8'))
  const denied = { ...records[0], status: 'blocked', needsReconciliation: true, cancelRequested: false, reason: '工具請求被拒絕；不會透過改派繞過決定。',
    attempts: [{ ...records[0].attempts[0], status: 'blocked', denied: true, shutdownConfirmed: true, pendingTools: [], backgroundWork: false }] }
  const unclear = { ...denied, id: 'unclear', attempts: [{ ...denied.attempts[0], pendingTools: ['tool-1'] }] }
  const unconfirmed = { ...denied, id: 'unconfirmed', attempts: [{ ...denied.attempts[0], shutdownConfirmed: false }] }
  await writeFile(join(r.deps.dir, 'tasks.json'), JSON.stringify([denied, unclear, unconfirmed]))
  const restored = await createChefService(r.deps); services.push(restored)
  const response = await restored.handle({ action: 'get' }); if (response.kind !== 'state') throw Error(response.message)
  expect(response.state.tasks.map(t => [t.id, t.needsReconciliation])).toEqual([[denied.id, false], ['unclear', true], ['unconfirmed', true]])
})
it('未知中斷在重啟後保持 blocked，未確認不能自動恢復', async () => {
  const r = await rig(), first = await r.start()
  await r.service.dispose()
  const records = JSON.parse(await readFile(join(r.deps.dir, 'tasks.json'), 'utf8'))
  delete records[0].attempts[0].deniedTimedOut
  records[0].status = 'running'; records[0].cancelRequested = false; records[0].attempts[0].status = 'running'
  await writeFile(join(r.deps.dir, 'tasks.json'), JSON.stringify(records))
  const restored = await createChefService(r.deps); services.push(restored)
  const response = await restored.handle({ action: 'get' }); if (response.kind !== 'state') throw Error(response.message)
  expect(response.state.tasks[0]).toMatchObject({ status: 'blocked', needsReconciliation: true, attempts: [{ deniedTimedOut: false }] })
  expect(await restored.handle({ action: 'resume', taskId: response.state.tasks[0]!.id, reconciled: false })).toMatchObject({ kind: 'error' })
  expect(r.started.map(r => r.id)).toEqual([first.id])
})
it('工具輸出提到 background 不會將 Read 誤認成正在執行的背景程序', async () => {
  const r = await rig(), first = await r.start()
  r.service.observe(first.id, [{ kind: 'tool-use', id: 'read', name: 'Read', input: { file_path: 'docs' } }, { kind: 'tool-result', id: 'read', content: 'Command running in background with ID: example', isError: false }])
  await r.service.report(first.id, { outcome: 'completed', summary: '已閱讀文件', checks: [{ workerId: first.id, toolUseId: 'read' }] }); r.end(first.id)
  await vi.waitFor(async () => expect((await r.task()).status).toBe('completed'))
})

// 實機驗收第六輪：驗收者背景啟動 API 實際觸發錯誤，之後即使停掉，任務仍被判成「仍有背景工作」而卡住。
const bgStart = (id: string, taskId: string) => [
  { kind: 'tool-use' as const, id, name: 'Bash', input: { command: 'pnpm exec nest start', run_in_background: true } },
  { kind: 'tool-result' as const, id, content: `Command running in background with ID: ${taskId}`, isError: false },
]
it.each([
  ['TaskStop', { task_id: 'bg1' }, 'Successfully stopped task: bg1', false],
  ['TaskStop（舊參數 shell_id）', { shell_id: 'bg1' }, 'stopped', false],
  ['KillShell（舊名稱）', { shell_id: 'bg1' }, 'Successfully killed shell: bg1', false],
  ['TaskOutput 顯示已結束', { task_id: 'bg1', block: false, timeout: 1 }, '<status>completed</status>', false],
] as const)('背景程序以 %s 結束後，不判定需要核對，任務照常往下走', async (name, input, content, isError) => {
  const r = await rig(), first = await r.start()
  const tool = name.startsWith('KillShell') ? 'KillShell' : name.startsWith('TaskOutput') ? 'TaskOutput' : 'TaskStop'
  r.service.observe(first.id, [...bgStart('bash1', 'bg1'), { kind: 'tool-use', id: 'stop1', name: tool, input }, { kind: 'tool-result', id: 'stop1', content, isError }])
  await r.service.report(first.id, { outcome: 'completed', summary: '已驗證', checks: [{ workerId: first.id, toolUseId: 'bash1' }] }); r.end(first.id)
  // 用過 Bash 算有改動，主廚會再排驗收單位，所以任務繼續執行；重點是第一個執行者正常結束、沒有被判定需要核對。
  await vi.waitFor(async () => expect((await r.task()).attempts[0]).toMatchObject({ status: 'done', backgroundWork: false }))
  expect(await r.task()).toMatchObject({ needsReconciliation: false })
  expect((await r.task()).status).not.toBe('blocked')
})
it('需要核對而卡住的任務，沒有執行者在跑時可以由使用者取消結束', async () => {
  const r = await rig(), first = await r.start()
  r.service.observe(first.id, bgStart('bash1', 'bg1'))
  r.end(first.id)
  await vi.waitFor(async () => expect(await r.task()).toMatchObject({ status: 'blocked', needsReconciliation: true }))
  // 實際經營時：使用者核對後要結束任務，原本取消永遠停在 blocked「停止尚未確認」，唯一出路是接續（會再執行排隊的工作）。
  await r.service.handle({ action: 'cancel', taskId: (await r.task()).id })
  const task = await r.task()
  expect(task.status).toBe('cancelled')
  expect(task.reason).toContain('未經核對')
  // 群組訊息曾重複成「使用者停止，已保存進度。使用者停止，已保存進度。先前的…」。
  const ended = r.milestones.filter(m => m.text.includes('未經核對')).at(-1)!.text
  expect(ended.match(/使用者停止/g)?.length ?? 0).toBeLessThanOrEqual(1)
})
it('背景程序沒有停掉、或 TaskOutput 顯示仍在執行時，結束後仍判定需要核對', async () => {
  for (const extra of [[], [{ kind: 'tool-use' as const, id: 'out1', name: 'TaskOutput', input: { task_id: 'bg1', block: false, timeout: 1 } }, { kind: 'tool-result' as const, id: 'out1', content: '<status>running</status>', isError: false }]]) {
    const r = await rig(), first = await r.start()
    r.service.observe(first.id, [...bgStart('bash1', 'bg1'), ...extra])
    r.end(first.id)
    await vi.waitFor(async () => expect(await r.task()).toMatchObject({ status: 'blocked', needsReconciliation: true }))
  }
})
it('停掉的是別的背景程序時，原本那個仍算在執行', async () => {
  const r = await rig(), first = await r.start()
  r.service.observe(first.id, [...bgStart('bash1', 'bg1'), { kind: 'tool-use', id: 'stop1', name: 'TaskStop', input: { task_id: 'other' } }, { kind: 'tool-result', id: 'stop1', content: 'stopped', isError: false }])
  r.end(first.id)
  await vi.waitFor(async () => expect(await r.task()).toMatchObject({ status: 'blocked', needsReconciliation: true }))
})

// 實機驗收第七輪：規劃者把基準檢查丟到背景後就結束本回合，背景工作還在跑，任務因此被判定需要核對。
// 第八輪：規則寫死 TaskStop，Codex 驗收者沒有這個工具，於是不啟動服務、不做實際驗證。工具名稱只給 Claude。
it('主廚與工作者的指示都要求檢查在前景執行、服務驗證完停掉；TaskStop 只出現在 Claude 的指示', async () => {
  const r = await rig(), first = await r.start()
  expect(r.started[0]?.provider).toBe('claude')
  expect(r.started[0]?.prompt).toMatch(/前景/)
  expect(r.started[0]?.prompt).toContain('TaskStop')
  await r.service.delegate(first.id, { title: '實作', goal: '改程式', kind: 'code' }); r.end(first.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  expect(r.started[1]?.provider).toBe('codex')
  expect(r.started[1]?.prompt).toMatch(/前景/)
  expect(r.started[1]?.prompt).toMatch(/停掉/)
  expect(r.started[1]?.prompt).not.toContain('TaskStop')
})

it('啟動途中取消，factory 回來後立即停止且釋放租約', async () => {
  let ready!: () => void
  const r = await rig({ start: () => new Promise(resolve => { ready = resolve }) })
  const first = await r.start()
  await r.service.handle({ action: 'cancel', taskId: (await r.task()).id })
  ready()
  await vi.waitFor(async () => expect((await r.task()).status).toBe('cancelled'))
  expect(r.stopped).toEqual([first.id]); expect(r.service.guard('manual', r.root)).toBeUndefined()
})
it('完成回覆早於 factory 回傳時先等 handle，不能誤判停止失敗', async () => {
  let service!: ChefService
  const r = await rig({ start: async request => { service.observe(request.id, [{ kind: 'session-end', isError: true, apiErrorStatus: 503 }]); await new Promise(resolve => setTimeout(resolve, 20)) } })
  service = r.service; await r.start()
  await vi.waitFor(() => expect(r.started.length).toBeGreaterThanOrEqual(2))
  expect(r.stopped.length).toBeGreaterThanOrEqual(1)
})
it('主廚控制工具不能充作實作驗證，progress 只列真實工作結果', async () => {
  const r = await rig(), chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const worker = r.started[1]!
  r.service.observe(worker.id, [{ kind: 'tool-use', id: 'progress', name: 'task_progress', input: {} }, { kind: 'tool-result', id: 'progress', isError: false, content: 'task state' }])
  r.end(worker.id); await vi.waitFor(() => expect(r.started).toHaveLength(3))
  const reviewer = r.started[2]!
  expect((await r.service.progress(reviewer.id)).attempts.find(a => a.workerId === worker.id)?.receipts).toEqual([])
  await expect(r.service.report(reviewer.id, { outcome: 'completed', summary: 'done', checks: [{ workerId: worker.id, toolUseId: 'progress' }] })).rejects.toThrow('控制工具')
})
it('progress 回傳保持精簡：單元目標截短，避免被存成專案外的檔案', async () => {
  const r = await rig(), chief = await r.start()
  const longGoal = '修改檔案並說明。'.repeat(700)
  for (const title of ['一', '二', '三']) await r.service.delegate(chief.id, { title, kind: 'code', goal: `${title}：${longGoal}` })
  r.end(chief.id)
  for (let index = 1; index <= 3; index += 1) {
    await vi.waitFor(() => expect(r.started).toHaveLength(index + 1))
    const worker = r.started[index]!
    r.service.observe(worker.id, [{ kind: 'tool-use', id: `b${index}`, name: 'Bash', input: { command: 'npm test' } }, { kind: 'tool-result', id: `b${index}`, isError: false, content: 'x'.repeat(20000) }])
    r.end(worker.id)
  }
  await vi.waitFor(() => expect(r.started).toHaveLength(5))
  const progress = await r.service.progress(r.started[4]!.id)
  expect(progress.units.every(u => u.goal.length <= 400)).toBe(true)
  expect(JSON.stringify(progress).length).toBeLessThan(20000)
})
it('較早的實作單元在 progress 仍有可引用的工具結果，驗收能以它回報完成', async () => {
  const r = await rig({ maxExecutions: 20 }), chief = await r.start()
  for (const title of ['一', '二', '三', '四', '五', '六', '七']) await r.service.delegate(chief.id, { title, kind: 'code', goal: `完成第${title}項` })
  r.end(chief.id)
  for (let index = 1; index <= 7; index += 1) {
    await vi.waitFor(() => expect(r.started).toHaveLength(index + 1))
    const worker = r.started[index]!
    r.service.observe(worker.id, [{ kind: 'tool-use', id: `edit${index}`, name: 'Edit', input: { file_path: `f${index}` } }, { kind: 'tool-result', id: `edit${index}`, isError: false, content: `edited ${index}` }])
    r.end(worker.id)
  }
  await vi.waitFor(() => expect(r.started).toHaveLength(9))
  const reviewer = r.started[8]!
  const progress = await r.service.progress(reviewer.id)
  // 實際經營時：13 次執行時前面單元的 receipts 被清空，驗收者無從引用，任務無法登錄完成。
  const checks = progress.attempts.filter(a => a.receipts.length > 0 && a.workerId !== chief.id && a.workerId !== reviewer.id).map(a => ({ workerId: a.workerId, toolUseId: a.receipts.at(-1)!.toolUseId }))
  expect(checks).toHaveLength(7)
  await expect(r.service.report(reviewer.id, { outcome: 'completed', summary: 'done', checks })).resolves.toMatchObject({ recorded: true })
})
it('say_to_group 不能充作實作驗證', async () => {
  const r = await rig(), chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  r.end(chief.id); await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const worker = r.started[1]!
  r.service.observe(worker.id, [{ kind: 'tool-use', id: 'group-message', name: 'say_to_group', input: { text: '我已完成' } }, { kind: 'tool-result', id: 'group-message', isError: false, content: '已送進專案群組。' }])
  r.end(worker.id); await vi.waitFor(() => expect(r.started).toHaveLength(3))
  const reviewer = r.started[2]!
  expect((await r.service.progress(reviewer.id)).attempts.find(a => a.workerId === worker.id)?.receipts).toEqual([])
  await expect(r.service.report(reviewer.id, { outcome: 'completed', summary: 'done', checks: [{ workerId: worker.id, toolUseId: 'group-message' }] })).rejects.toThrow('控制工具')
})
