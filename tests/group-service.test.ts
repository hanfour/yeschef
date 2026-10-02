// tests/group-service.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroupStore } from '../src/main/group/store.js'
import { createGroupService, mentionsIn, type DeliverOutcome, type GroupService } from '../src/main/group/service.js'
import { MSG } from '../src/main/group/messages.js'
import { GENERAL_THREAD_ID, GROUP_ALL_THREADS, GroupMessageSchema, type GroupMessagesPayload } from '../src/shared/group.js'
import type { ChefTask } from '../src/shared/chef.js'

const roots: string[] = []
const services: GroupService[] = []
let rigCounter = 0
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function chefTask(over: Partial<ChefTask> = {}): ChefTask {
  return {
    id: 'task-1', projectId: 'p1', cwd: '/repo', goal: '把整份報表補完', followups: [],
    policy: { mode: 'auto', allowed: ['claude:c'], maxExecutions: 8, deadlineMinutes: 60 },
    status: 'running', createdAt: 0, deadlineAt: 0,
    units: [
      { id: 'u1', parentId: null, title: '規劃與執行', goal: 'g', kind: 'analysis', status: 'running' },
      { id: 'u2', parentId: 'u1', title: '實作', goal: 'g', kind: 'code', status: 'running' },
    ],
    attempts: [
      { id: 'a1', unitId: 'u1', workerId: 'chef-conv', provider: 'claude', model: 'sonnet', status: 'running', startedAt: 0, reason: '', events: [], pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false },
      { id: 'a2', unitId: 'u2', workerId: 'codex-conv', provider: 'codex', model: 'gpt-5', sessionId: 'codex-thread', status: 'running', startedAt: 0, reason: '', events: [], pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false },
    ],
    reason: '', cancelRequested: false, needsReconciliation: false, ...over,
  }
}

async function rig(options: { tasks?: readonly ChefTask[]; deliver?: DeliverOutcome; deliverThrows?: boolean; onChangeThrows?: boolean; hasProjectError?: Error; startFails?: boolean; startFailureMessage?: string; resumeFailure?: string; root?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'yeschef-group-svc-'))
  if (options.root === undefined) roots.push(root)
  const errors: Error[] = []
  const delivered: { conversationId: string; text: string }[] = []
  const resumed: { taskId: string; message: string }[] = []
  const opened: { projectId: string; provider: string; sessionId: string; tabLabel: string }[] = []
  const pushes: GroupMessagesPayload[] = []
  const diskStore = createGroupStore(root, (error) => errors.push(error))
  let readCount = 0
  let appendCount = 0
  let tasks = options.tasks ?? []
  let counter = 0
  const idPrefix = ++rigCounter
  const service = createGroupService({
    store: {
      ...diskStore,
      append: (message) => {
        appendCount++
        return diskStore.append(message)
      },
      read: async (projectId) => {
        readCount++
        return diskStore.read(projectId)
      },
    },
    chef: {
      tasksOf: (projectId) => tasks.filter((t) => t.projectId === projectId),
      start: async (projectId, goal) => {
        if (options.startFails === true) return { kind: 'error', message: options.startFailureMessage ?? MSG.noModels }
        const created = chefTask({ id: `task-${tasks.length + 1}`, projectId, goal, attempts: [] })
        tasks = [...tasks, created]
        return { kind: 'ok', taskId: created.id }
      },
      resume: async (taskId, message) => {
        resumed.push({ taskId, message })
        return options.resumeFailure === undefined
          ? { kind: 'ok' }
          : { kind: 'error', message: options.resumeFailure }
      },
    },
    deliver: (_projectId, conversationId, text) => {
      delivered.push({ conversationId, text })
      if (options.deliverThrows === true) throw new Error('deliver failed')
      return options.deliver ?? { kind: 'delivered', busy: false }
    },
    hasProject: (projectId) => {
      if (options.hasProjectError !== undefined) throw options.hasProjectError
      return projectId === 'p1'
    },
    onChange: (payload) => {
      if (options.onChangeThrows === true && payload.projectId === 'p1') throw new Error('push failed')
      pushes.push(payload)
    },
    openParticipant: (input) => { opened.push(input) },
    newId: () => `r${idPrefix}-m${++counter}`,
    now: () => 1_700_000_000_000,
    logError: (error) => errors.push(error),
  })
  services.push(service)
  return {
    root, service, errors, delivered, resumed, opened, pushes,
    readCount: () => readCount,
    appendCount: () => appendCount,
    readStored: () => diskStore.read('p1'),
    tasksNow: () => tasks,
  }
}

describe('@ 解析', () => {
  it('用參與者 label 的最長前綴解析中文與相似名稱', () => {
    expect(mentionsIn('@主廚幫我看一下', ['主廚'])).toEqual({ hits: ['主廚'], misses: [] })
    expect(mentionsIn('@codex-10的部分', ['codex-1', 'codex-10'])).toEqual({ hits: ['codex-10'], misses: [] })
  })

  it('保留英文空白行為,未知名稱退回 regex', () => {
    expect(mentionsIn('@codex-1 幫我看一下 @主廚', ['codex-1', '主廚'])).toEqual({ hits: ['codex-1', '主廚'], misses: [] })
    expect(mentionsIn('沒有提到任何人', [])).toEqual({ hits: [], misses: [] })
    expect(mentionsIn('信箱 a@b.com 只會掃到點號前那段', [])).toEqual({ hits: [], misses: ['b'] })
    expect(mentionsIn('@不存在的人', ['主廚'])).toEqual({ hits: [], misses: ['不存在的人'] })
    expect(mentionsIn(`@${'x'.repeat(50)}`, []).misses[0]).toHaveLength(40)
  })
})

describe('send', () => {
  it('沒有 @ 就送給這條 thread 的主廚,注入文字帶來源標記', async () => {
    const r = await rig({ tasks: [chefTask()] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '先補測試' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    expect(r.delivered).toEqual([{ conversationId: 'chef-conv', text: `${MSG.injection('你')}\n先補測試` }])
  })

  it('@ 命中就送給那個參與者,不送主廚', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@codex-1 換個做法' })
    expect(r.delivered.map((d) => d.conversationId)).toEqual(['codex-conv'])
  })

  it('@ 已離開的 worker 不送,混合收件人只送仍在場者', async () => {
    const task = chefTask({ attempts: [
      ...chefTask().attempts,
      { id: 'a3', unitId: 'u2', workerId: 'grok-conv', provider: 'grok', model: 'grok-4', status: 'running', startedAt: 1, reason: '', events: [], pendingTools: [], backgroundWork: false, denied: false, deniedTimedOut: false, awaitingApproval: false },
    ] })
    const r = await rig({ tasks: [task] })
    await r.service.handle({ action: 'get', projectId: 'p1' })
    r.service.write({
      projectId: 'p1', threadId: 'task-1', from: { kind: 'agent', conversationId: 'codex-conv', label: 'codex-1', provider: 'codex', role: 'worker' },
      kind: 'left', text: 'codex-1 離開', unitId: 'u2',
    })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@codex-1 @grok-1 請看一下' })
    expect(r.delivered.map((delivery) => delivery.conversationId)).toEqual(['grok-conv'])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.find((message) => message.from.kind === 'system')?.text).toBe(MSG.participantLeft('codex-1'))
    expect(state.messages.find((message) => message.from.kind === 'user')).toMatchObject({
      mentions: ['codex-1', 'grok-1'], deliveredMentions: ['grok-1'],
    })
  })

  it('同一個 worker 在 left 後重新 joined 就能再次收到訊息', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'get', projectId: 'p1' })
    const sender = { kind: 'agent' as const, conversationId: 'codex-conv', label: 'codex-1', provider: 'codex' as const, role: 'worker' as const }
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: sender, kind: 'left', text: '離開', unitId: 'u2' })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: sender, kind: 'joined', text: '重新加入', unitId: 'u2' })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@codex-1 再看一下' })
    expect(r.delivered.map((delivery) => delivery.conversationId)).toEqual(['codex-conv'])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.some((message) => message.from.kind === 'system' && message.text === MSG.participantLeft('codex-1'))).toBe(false)
  })

  it('中文 @label 後面直接接文字仍送給命中的參與者', async () => {
    const r = await rig({ tasks: [chefTask()] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@主廚幫我看一下' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    expect(r.delivered).toEqual([{ conversationId: 'chef-conv', text: `${MSG.injection('你')}\n@主廚幫我看一下` }])
  })

  it('@ 沒命中就補一則 system 訊息,而且誰都不送', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@不存在的人 在嗎' })
    expect(r.delivered).toEqual([])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((m) => m.text)).toEqual(['@不存在的人 在嗎', MSG.mentionNotFound(['不存在的人'])])
    expect(state.messages[1]?.from).toEqual({ kind: 'system' })
  })

  it('2000 個 miss 的 system 說明通過 schema 並寫進快取與儲存', async () => {
    const r = await rig({ tasks: [chefTask()] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@a'.repeat(2000) })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    expect(r.delivered).toEqual([])

    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages).toHaveLength(2)
    const explanation = state.messages[1]
    expect(explanation?.from).toEqual({ kind: 'system' })
    expect(explanation?.text).toContain('等 1995 個')
    expect(GroupMessageSchema.safeParse(explanation).success).toBe(true)
    await vi.waitFor(async () => expect(await r.readStored()).toHaveLength(2))
  })

  it('11 個 @ 寫入後的快取與檔案訊息都符合 schema', async () => {
    const r = await rig({ tasks: [chefTask()] })
    const text = Array.from({ length: 11 }, (_, index) => `@missing${index}`).join(' ')
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]?.mentions).toHaveLength(10)
    expect(state.messages.every((message) => GroupMessageSchema.safeParse(message).success)).toBe(true)
    await vi.waitFor(async () => {
      const stored = await r.readStored()
      expect(stored).toHaveLength(2)
      expect(stored.every((message) => GroupMessageSchema.safeParse(message).success)).toBe(true)
    })
  })

  it('對象忙碌時照樣送,並補一則 system 訊息', async () => {
    const r = await rig({ tasks: [chefTask()], deliver: { kind: 'delivered', busy: true } })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '先補測試' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.at(-1)?.text).toBe(MSG.busy('主廚'))
    expect(r.delivered).toHaveLength(1)
  })

  it('對話已經關掉時仍回 sent,並留下一則 system 訊息', async () => {
    const r = await rig({ tasks: [chefTask()], deliver: { kind: 'missing' } })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '在嗎' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((m) => m.text)).toEqual(['在嗎', MSG.noConversation('主廚')])
  })

  it.each(['blocked', 'cancelled'] as const)('%s 任務收到沒有 @ 的訊息時接續,不送到已關閉的主廚對話', async status => {
    const r = await rig({ tasks: [chefTask({ status })] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '繼續合併 #137' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    expect(r.delivered).toEqual([])
    expect(r.resumed).toEqual([{ taskId: 'task-1', message: '繼續合併 #137' }])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map(message => ({ from: message.from.kind, text: message.text }))).toEqual([
      { from: 'user', text: '繼續合併 #137' },
      { from: 'system', text: MSG.taskResuming },
    ])
  })

  it('@主廚 在已停止任務上會接續', async () => {
    const r = await rig({ tasks: [chefTask({ status: 'blocked' })] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@主廚 繼續合併 #137' })
    expect(r.delivered).toEqual([])
    expect(r.resumed).toEqual([{ taskId: 'task-1', message: '@主廚 繼續合併 #137' }])
  })

  it('需要核對的任務不呼叫 resume,說明工作目錄與卡住原因', async () => {
    const reason = '權限請求逾時沒有回覆，任務已暫停'
    const r = await rig({ tasks: [chefTask({ status: 'blocked', needsReconciliation: true, reason })] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '繼續合併 #137' })
    expect(r.delivered).toEqual([])
    expect(r.resumed).toEqual([])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.at(-1)?.text).toBe(MSG.reconciliationRequired(reason))
  })

  it('接續失敗時仍記錄使用者訊息並附上原因', async () => {
    const r = await rig({ tasks: [chefTask({ status: 'cancelled' })], resumeFailure: '工作目錄目前使用中' })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '繼續工作' })
    expect(r.delivered).toEqual([])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map(message => message.text)).toEqual(['繼續工作', MSG.resumeFailed('工作目錄目前使用中')])
  })

  it('卡住任務中 @worker 維持送往該工作者,不觸發接續', async () => {
    const r = await rig({ tasks: [chefTask({ status: 'blocked' })], deliver: { kind: 'missing' } })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@codex-1 看一下合併狀態' })
    expect(r.delivered.map(delivery => delivery.conversationId)).toEqual(['codex-conv'])
    expect(r.resumed).toEqual([])
  })

  it('deliver 拋錯時仍回 sent,並留下使用者與 system 訊息', async () => {
    const r = await rig({ tasks: [chefTask()], deliverThrows: true })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '在嗎' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((message) => ({ from: message.from.kind, text: message.text }))).toEqual([
      { from: 'user', text: '在嗎' },
      { from: 'system', text: MSG.noConversation('主廚') },
    ])
    expect(r.errors.map((error) => error.message)).toContain('deliver failed')
  })

  it('在 general 送訊息會開新任務,訊息的 threadId 直接用新的 taskId', async () => {
    const r = await rig()
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GENERAL_THREAD_ID, text: '把整份報表補完' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((m) => ({ threadId: m.threadId, kind: m.kind, text: m.text }))).toEqual([
      { threadId: 'task-1', kind: 'goal', text: '把整份報表補完' },
      { threadId: 'task-1', kind: 'text', text: MSG.threadOpened('把整份報表補完') },
    ])
    expect(r.delivered).toEqual([])
  })

  it('全部優先選最新 queued, running 或 stopping,即使有較新的卡住任務', async () => {
    const taskWithChef = (id: string, status: ChefTask['status'], createdAt: number, needsReconciliation = false): ChefTask => {
      const task = chefTask({ id, status, createdAt, needsReconciliation })
      return { ...task, attempts: task.attempts.map((attempt, index) => ({ ...attempt, workerId: `${id}-worker-${index}` })) }
    }
    const r = await rig({ tasks: [
      taskWithChef('old-running', 'running', 5),
      taskWithChef('new-queued', 'queued', 9),
      taskWithChef('newest-stopping', 'stopping', 15),
      taskWithChef('ignored-blocked', 'blocked', 20, true),
    ] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GROUP_ALL_THREADS, text: '問最新目標' })
    expect(response).toEqual({ kind: 'sent', threadId: 'newest-stopping' })
    expect(r.delivered[0]?.conversationId).toBe('newest-stopping-worker-0')
  })

  it('全部 sentinel 沒有進行中任務、最新任務卡住時接續它,不開新目標', async () => {
    const r = await rig({ tasks: [chefTask({ status: 'blocked' })] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GROUP_ALL_THREADS, text: '繼續合併 #137' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    expect(r.resumed).toEqual([{ taskId: 'task-1', message: '繼續合併 #137' }])
  })

  it('全部 sentinel 最新任務已結束時改走 general 開新目標', async () => {
    const r = await rig({ tasks: [chefTask({ status: 'completed' })] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GROUP_ALL_THREADS, text: '開新目標' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-2' })
    expect(r.resumed).toEqual([])
  })

  it('全部沒有進行中任務時選最新且仍佔用工作目錄的 blocked 任務', async () => {
    const blocked = (id: string, createdAt: number, needsReconciliation: boolean): ChefTask => chefTask({
      id, status: 'blocked', createdAt, needsReconciliation, reason: '需核對',
    })
    const r = await rig({ tasks: [
      blocked('free-old', 5, true),
      blocked('held-old', 10, true),
      blocked('free-newest', 30, false),
      blocked('held-newest', 20, true),
    ] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GROUP_ALL_THREADS, text: '繼續' })
    expect(response).toEqual({ kind: 'sent', threadId: 'held-newest' })
    expect(r.resumed).toEqual([])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.at(-1)?.text).toBe(MSG.reconciliationRequired('需核對'))
  })

  it('已有 leased 任務時 general 訊息仍寫入並補 system 說明', async () => {
    const reason = '工作目錄已有執行中的任務'
    const r = await rig({
      tasks: [chefTask({ status: 'queued', createdAt: 10 })],
      startFails: true,
      startFailureMessage: MSG.startFailed(reason),
    })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GENERAL_THREAD_ID, text: '做點什麼' })
    expect(response).toEqual({ kind: 'sent', threadId: GENERAL_THREAD_ID })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((message) => ({
      threadId: message.threadId,
      from: message.from.kind,
      kind: message.kind,
      text: message.text,
    }))).toEqual([
      { threadId: GENERAL_THREAD_ID, from: 'user', kind: 'text', text: '做點什麼' },
      { threadId: GENERAL_THREAD_ID, from: 'system', kind: 'text', text: MSG.startFailed(reason) },
    ])
  })

  it('已經有主廚的 thread 直接 deliver,不開新任務', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '再補一點' })
    expect(r.tasksNow()).toHaveLength(1)
  })

  it('不存在的專案回 error', async () => {
    const r = await rig()
    expect(await r.service.handle({ action: 'get', projectId: 'nope' })).toEqual({ kind: 'error', message: MSG.noProject })
  })

  it('形狀不對的請求回 error', async () => {
    const r = await rig()
    const response = await r.service.handle({ action: 'send', projectId: 'p1' })
    expect(response.kind).toBe('error')
  })

  it('空白訊息回固定的格式錯誤訊息', async () => {
    const r = await rig()
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '' })
    expect(response).toEqual({ kind: 'error', message: MSG.badRequest })
    expect(r.errors).toHaveLength(1)
  })

  it('非預期錯誤回固定訊息並記錄原始錯誤', async () => {
    const original = new Error('project lookup failed')
    const r = await rig({ hasProjectError: original })
    expect(await r.service.handle({ action: 'get', projectId: 'p1' })).toEqual({ kind: 'error', message: MSG.badRequest })
    expect(r.errors).toContain(original)
  })
})

describe('openParticipant', () => {
  it('依 thread attempt 開啟歷史並使用群組 participant label 與 unit title', async () => {
    const task = chefTask({ units: [
      { id: 'u1', parentId: null, title: '規劃', goal: 'g', kind: 'analysis', status: 'running' },
      { id: 'u2', parentId: 'u1', title: '合併 PR #137', goal: 'g', kind: 'code', status: 'running' },
    ] })
    const r = await rig({ tasks: [task] })

    const response = await r.service.handle({
      action: 'openParticipant', projectId: 'p1', threadId: 'task-1', conversationId: 'codex-conv',
    })

    expect(response).toEqual({ kind: 'opened' })
    expect(r.opened).toEqual([{
      projectId: 'p1', provider: 'codex', sessionId: 'codex-thread', tabLabel: 'codex-1 · 合併 PR #137',
    }])
  })

  it('attempt 找不到 sessionId 時不開新分頁並回歷史提示', async () => {
    const task = chefTask({ attempts: chefTask().attempts.map((attempt) => ({ ...attempt, sessionId: undefined })) })
    const r = await rig({ tasks: [task] })

    const response = await r.service.handle({
      action: 'openParticipant', projectId: 'p1', threadId: 'task-1', conversationId: 'codex-conv',
    })

    expect(response).toEqual({ kind: 'error', message: MSG.closedConversationHint })
    expect(r.opened).toEqual([])
  })
})

describe('thread 清單', () => {
  it('general 永遠在最前面,工作目錄佔用狀態來自 chef task', async () => {
    const r = await rig({ tasks: [chefTask()] })
    expect(r.service.threadsOf('p1')).toEqual([
      { id: GENERAL_THREAD_ID, title: '未分派', status: 'open', createdAt: 0, holdsWorkspace: false, participants: [] },
      {
        id: 'task-1', title: '把整份報表補完', status: 'running', createdAt: 0, holdsWorkspace: true,
        participants: [
          { label: '主廚', conversationId: 'chef-conv', provider: 'claude', role: 'chef', unitTitle: '規劃與執行' },
          { label: 'codex-1', conversationId: 'codex-conv', provider: 'codex', role: 'worker', unitTitle: '實作', sessionId: 'codex-thread' },
        ],
      },
    ])
  })
})

describe('write 與 recent', () => {
  it('write 之後 recent 拿得到,而且會推播', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'get', projectId: 'p1' })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'delegated', text: MSG.delegated('實作', 'code') })
    expect((await r.service.recent('p1', 'task-1', 20)).map((m) => m.text)).toEqual([MSG.delegated('實作', 'code')])
    await vi.waitFor(() => expect(r.pushes).toHaveLength(1))
    expect(r.pushes[0]?.messages.map((m) => m.kind)).toEqual(['delegated'])
    expect(r.pushes[0]?.threads[0]?.id).toBe(GENERAL_THREAD_ID)
  })

  it('4000 字的 blocked reason 經 MSG 截斷後可寫入且符合 schema', async () => {
    const r = await rig()
    const reason = 'x'.repeat(4000)
    r.service.write({
      projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'blocked',
      text: MSG.unitBlocked('codex-1', '實作', reason),
    })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.text.length).toBeLessThanOrEqual(4000)
    expect(state.messages.every((message) => GroupMessageSchema.safeParse(message).success)).toBe(true)
    await vi.waitFor(async () => expect(await r.readStored()).toHaveLength(1))
  })

  it('schema 不合格的訊息不進快取、推播或儲存,並記錄錯誤', async () => {
    const r = await rig()
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'blocked', text: 'x'.repeat(4001) })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages).toEqual([])
    expect(r.appendCount()).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.pushes).toEqual([])
  })

  it('dispose 後 write 不再追加訊息', async () => {
    const r = await rig()
    await r.service.dispose()
    const appendCount = r.appendCount()
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '不應寫入' })
    expect(r.appendCount()).toBe(appendCount)
  })

  it('同一輪事件迴圈裡的多則合併成一批', async () => {
    const r = await rig({ tasks: [chefTask()] })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '一' })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '二' })
    await vi.waitFor(() => expect(r.pushes).toHaveLength(1))
    expect(r.pushes[0]?.messages.map((m) => m.text)).toEqual(['一', '二'])
  })

  it('一個專案 onChange 拋錯不會中斷後續推播', async () => {
    const r = await rig({ onChangeThrows: true })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '拋錯的專案' })
    r.service.write({ projectId: 'p2', threadId: 'task-2', from: { kind: 'system' }, kind: 'joined', text: '仍要送出的專案' })
    await vi.waitFor(() => expect(r.pushes).toHaveLength(1))
    expect(r.pushes[0]?.projectId).toBe('p2')
    expect(r.errors.map((error) => error.message).filter((message) => message === 'push failed')).toHaveLength(1)
  })

  it('recent 依 threadId 過濾,只回最後 limit 則', async () => {
    const r = await rig({ tasks: [chefTask()] })
    for (let i = 0; i < 25; i++) {
      r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'progress', text: `第 ${i} 則` })
    }
    r.service.write({ projectId: 'p1', threadId: '別條', from: { kind: 'system' }, kind: 'progress', text: '不該出現' })
    const recent = await r.service.recent('p1', 'task-1', 20)
    expect(recent).toHaveLength(20)
    expect(recent[0]?.text).toBe('第 5 則')
    expect(recent.some((m) => m.text === '不該出現')).toBe(false)
  })

  it('重開之後 recent 讀得到上一輪落地的訊息', async () => {
    const first = await rig({ tasks: [chefTask()] })
    first.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '重開前寫的' })
    await first.service.dispose()
    // 同一個目錄再開一份 service:記憶體是空的,recent 要自己去 store 把歷史載回來。
    const second = await rig({ tasks: [chefTask()], root: first.root })
    expect((await second.service.recent('p1', 'task-1', 20)).map((m) => m.text)).toEqual(['重開前寫的'])
  })

  it('recent 初次查詢時合併磁碟歷史與記憶體新訊息', async () => {
    const first = await rig({ tasks: [chefTask()] })
    first.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '重開前寫的' })
    await first.service.dispose()
    const second = await rig({ tasks: [chefTask()], root: first.root })
    second.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '重開後剛寫的' })
    expect((await second.service.recent('p1', 'task-1', 20)).map((message) => message.text)).toEqual(['重開前寫的', '重開後剛寫的'])
  })

  it('同一專案併發載入共用一次 store read', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await Promise.all([
      r.service.recent('p1', 'task-1', 20),
      r.service.handle({ action: 'get', projectId: 'p1' }),
    ])
    expect(r.readCount()).toBe(1)
  })

  it('寫入失敗只 logError,不往外拋', async () => {
    const r = await rig({ tasks: [chefTask()] })
    expect(() => r.service.write({ projectId: '../壞', threadId: 'task-1', from: { kind: 'system' }, kind: 'progress', text: 'x' })).not.toThrow()
    await vi.waitFor(() => expect(r.errors.length).toBeGreaterThan(0))
  })
})
