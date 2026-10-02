import { describe, expect, it } from 'vitest'
import {
  GENERAL_THREAD_ID,
  GROUP_CHANNEL,
  GroupMessageSchema,
  GroupRequestSchema,
  GroupResponseSchema,
  GroupThreadSchema,
  SayToGroupSchema,
  isMilestone,
  parseGroupMessagesPayload,
  parseGroupOpen,
  targetThreadForAll,
  type GroupThread,
} from '../src/shared/group.js'

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm1', projectId: 'p1', threadId: 't1', at: 1_700_000_000_000,
  from: { kind: 'user' }, kind: 'text', text: '嗨', mentions: [], ...over,
})

describe('群組頻道與訊息', () => {
  it('頻道名與 general 的 id 固定', () => {
    expect(GROUP_CHANNEL).toBe('group:manage')
    expect(GENERAL_THREAD_ID).toBe('general')
  })

  it.each([
    { kind: 'user' },
    { kind: 'system' },
    { kind: 'agent', conversationId: 'c1', label: 'codex-1', provider: 'codex', role: 'worker' },
    { kind: 'agent', conversationId: 'c2', label: '主廚', provider: 'claude', role: 'chef' },
  ])('三種 sender 都收:%j', (from) => {
    expect(GroupMessageSchema.safeParse(message({ from })).success).toBe(true)
  })

  it.each(['text', 'goal', 'delegated', 'progress', 'report', 'blocked', 'joined', 'left'])('八種 kind 都收:%s', (kind) => {
    expect(GroupMessageSchema.safeParse(message({ kind })).success).toBe(true)
  })

  it('unitId 選填,mentions 最多十個', () => {
    expect(GroupMessageSchema.safeParse(message({ unitId: 'u1' })).success).toBe(true)
    expect(GroupMessageSchema.safeParse(message({ mentions: ['codex-2'], deliveredMentions: ['codex-2'] })).success).toBe(true)
    expect(GroupMessageSchema.safeParse(message({ mentions: Array.from({ length: 11 }, () => 'a') })).success).toBe(false)
    expect(GroupMessageSchema.safeParse(message({ deliveredMentions: Array.from({ length: 11 }, () => 'a') })).success).toBe(false)
  })

  it.each([
    message({ extra: 1 }),
    message({ at: -1 }),
    message({ at: 1.5 }),
    message({ kind: 'whisper' }),
    message({ from: { kind: 'agent', conversationId: 'c1', label: 'x', provider: 'openai', role: 'worker' } }),
    message({ from: { kind: 'agent', conversationId: 'c1', label: 'x', provider: 'codex' } }),
    message({ text: 'x'.repeat(4001) }),
    message({ projectId: '' }),
  ])('形狀不對不收:%j', (raw) => {
    expect(GroupMessageSchema.safeParse(raw).success).toBe(false)
  })

  it('里程碑是 text 與 goal 以外的 kind', () => {
    expect(isMilestone(GroupMessageSchema.parse(message({ kind: 'joined' })))).toBe(true)
    expect(isMilestone(GroupMessageSchema.parse(message({ kind: 'text' })))).toBe(false)
    expect(isMilestone(GroupMessageSchema.parse(message({ kind: 'goal' })))).toBe(false)
  })
})

describe('thread', () => {
  const thread = { id: 't1', title: '把測試補完', status: 'running', createdAt: 5, participants: [
    { label: '主廚', conversationId: 'c1', provider: 'claude', role: 'chef' },
    { label: 'codex-1', conversationId: 'c2', provider: 'codex', role: 'worker', unitTitle: '實作' },
  ] }
  it('完整的 thread 收得下', () => {
    expect(GroupThreadSchema.safeParse(thread).success).toBe(true)
  })
  it('舊 thread 預設不佔用工作目錄,新 thread 保留明確值', () => {
    expect(GroupThreadSchema.parse(thread).holdsWorkspace).toBe(false)
    expect(GroupThreadSchema.parse({ ...thread, holdsWorkspace: true }).holdsWorkspace).toBe(true)
  })
  it.each(['open', 'queued', 'running', 'stopping', 'completed', 'blocked', 'cancelled'])('七種狀態:%s', (status) => {
    expect(GroupThreadSchema.safeParse({ ...thread, status }).success).toBe(true)
  })
  it('多餘欄位、未知狀態與缺 createdAt 都不收', () => {
    expect(GroupThreadSchema.safeParse({ ...thread, extra: 1 }).success).toBe(false)
    expect(GroupThreadSchema.safeParse({ ...thread, status: 'paused' }).success).toBe(false)
    const { createdAt: _dropped, ...withoutCreatedAt } = thread
    expect(GroupThreadSchema.safeParse(withoutCreatedAt).success).toBe(false)
  })
})

describe('請求與回應', () => {
  it.each([
    { action: 'get', projectId: 'p1' },
    { action: 'send', projectId: 'p1', threadId: 'general', text: '做一份報表' },
    { action: 'openParticipant', projectId: 'p1', threadId: 'task-1', conversationId: 'worker-1' },
  ])('請求都收:%j', (raw) => {
    expect(GroupRequestSchema.safeParse(raw).success).toBe(true)
  })

  it.each([
    { action: 'get', projectId: 'p1', extra: 1 },
    { action: 'send', projectId: 'p1', threadId: 'general', text: '' },
    { action: 'send', projectId: 'p1', threadId: 'general', text: 'x'.repeat(4001) },
    { action: 'send', projectId: 'p1', text: 'hi' },
    { action: 'openParticipant', projectId: 'p1', conversationId: 'worker-1' },
    { action: 'peek', projectId: 'p1' },
  ])('請求形狀不對不收:%j', (raw) => {
    expect(GroupRequestSchema.safeParse(raw).success).toBe(false)
  })

  it.each([
    { kind: 'state', messages: [message()], threads: [{ id: 'general', title: '未分派', status: 'open', createdAt: 0, participants: [] }] },
    { kind: 'sent', threadId: 't1' },
    { kind: 'opened' },
    { kind: 'error', message: '找不到這個專案' },
  ])('回應都收:%j', (raw) => {
    expect(GroupResponseSchema.safeParse(raw).success).toBe(true)
  })

  it('回應多欄位不收', () => {
    expect(GroupResponseSchema.safeParse({ kind: 'sent', threadId: 't1', extra: 1 }).success).toBe(false)
  })
})

describe('推播與開分頁的 payload', () => {
  it('形狀對就回新物件', () => {
    const payload = { projectId: 'p1', messages: [message()], threads: [{ id: 'general', title: '未分派', status: 'open', createdAt: 0, participants: [] }] }
    expect(parseGroupMessagesPayload(payload)?.projectId).toBe('p1')
    expect(parseGroupMessagesPayload(payload)?.messages).toHaveLength(1)
  })
  it.each([null, {}, { projectId: 'p1' }, { projectId: 'p1', messages: [{ id: 'x' }], threads: [] }])('形狀不對回 null:%j', (raw) => {
    expect(parseGroupMessagesPayload(raw)).toBeNull()
  })
  it('開分頁只收 projectId', () => {
    expect(parseGroupOpen({ projectId: 'p1' })).toEqual({ projectId: 'p1' })
    expect(parseGroupOpen({ projectId: 'p1', label: 'x' })).toEqual({ projectId: 'p1' })
    expect(parseGroupOpen({ projectId: '' })).toBeNull()
    expect(parseGroupOpen('p1')).toBeNull()
  })
})

describe('say_to_group 的參數', () => {
  it('一到兩千字之間', () => {
    expect(SayToGroupSchema.safeParse({ text: '我打算先補測試' }).success).toBe(true)
    expect(SayToGroupSchema.safeParse({ text: '' }).success).toBe(false)
    expect(SayToGroupSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false)
    expect(SayToGroupSchema.safeParse({ text: 'ok', extra: 1 }).success).toBe(false)
  })
})

describe('targetThreadForAll', () => {
  const thread = (id: string, status: GroupThread['status'], createdAt: number, holdsWorkspace = false): GroupThread =>
    ({ id, title: id, status, createdAt, holdsWorkspace, participants: [] })
  const general = thread(GENERAL_THREAD_ID, 'open', 0)

  it('最新的任務卡住但沒佔著工作目錄(權限被拒):仍送給它接續,不開新目標', () => {
    expect(targetThreadForAll([general, thread('old', 'completed', 1), thread('stuck', 'blocked', 2)])?.id).toBe('stuck')
  })

  it('較舊的卡住任務不搶訊息:最新的任務已結束就回未分派', () => {
    expect(targetThreadForAll([general, thread('stuck', 'blocked', 1), thread('done', 'completed', 2)])?.id).toBe(GENERAL_THREAD_ID)
    expect(targetThreadForAll([general, thread('stuck', 'blocked', 1), thread('stopped', 'cancelled', 2)])?.id).toBe(GENERAL_THREAD_ID)
  })

  it('執行中的任務優先,其次是佔著工作目錄的卡住任務', () => {
    expect(targetThreadForAll([general, thread('run', 'running', 1), thread('stuck', 'blocked', 2)])?.id).toBe('run')
    expect(targetThreadForAll([general, thread('holding', 'blocked', 1, true), thread('done', 'completed', 2)])?.id).toBe('holding')
  })
})
