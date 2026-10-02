import type { CodexViewTools } from '../src/main/codex/conversation.js'
import type { CodexConversationDeps } from '../src/main/codex/conversation.js'
import { codexViewToolSpecs } from '../src/main/codex/conversation.js'
import type { ViewToolInvocation } from '../src/main/view-tools/tool-defs.js'
import { MSG } from '../src/main/view-tools/errors.js'
import { VIEW_TOOL_NAMES } from '../src/shared/view-tools.js'
import { PEER_MSG, PeerError } from '../src/main/peer/errors.js'
import type { PeerTools } from '../src/main/peer/service.js'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { codexPeerToolSpecs, createCodexConversation, MSG_NOT_LOGGED_IN, MSG_NO_CODEX } from '../src/main/codex/conversation.js'
import { createApprovalRegistry, type ApprovalRequest } from '../src/main/approval.js'
import type { CodexClient, CodexClientDeps, ApprovalKind, DynamicToolCallParams } from '../src/main/codex/client.js'
import type { Event } from '../src/shared/events.js'
import type { ConversationSink } from '../src/main/conversation.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

const callParams = (callId = 'exec-1', tool = 'ask_peer'): DynamicToolCallParams =>
  ({ threadId: 'th-new', turnId: 'tu-1', callId, tool })

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

interface Rig {
  clientDeps(): CodexClientDeps
  readonly core: ReturnType<typeof createCodexConversation>
  readonly calls: string[]
  readonly events: Event[]
  readonly states: string[]
  readonly asks: ApprovalRequest[]
  readonly errors: string[]
  readonly pendingCounts: number[]
  readonly busy: boolean[]
  readonly started: Array<[string, string | undefined]>
  /** 假 client 收到的通知處理器,用來灌 codex 的通知。 */
  notify(method: string, params: unknown): void
  /** 觸發一次批准請求,回傳 codex 會收到的 decision。 */
  approve(kind: ApprovalKind, params: Record<string, unknown>): Promise<'accept' | 'decline'>
  killDuringStart(): void
  failStart(message: string): void
  exit(code: number | null): void
}

function setup(options: {
  onTurnProduced?: () => void; onBusyChange?: (busy: boolean) => void
  onSessionEnded?: (id: string, event: Event) => void
  initialThreadId?: string
  commandExists?: boolean
  peerTools?: PeerTools
  viewTools?: CodexViewTools
  chefTools?: NonNullable<CodexConversationDeps['chefTools']>
  send?: () => Promise<void>
  loadHistory?: (id: string) => Promise<readonly unknown[]>
} = {}): Rig {
  let capturedDeps: CodexClientDeps | undefined
  const calls: string[] = []
  const events: Event[] = []
  const states: string[] = []
  const asks: ApprovalRequest[] = []
  const errors: string[] = []
  const pendingCounts: number[] = []
  const busy: boolean[] = []
  const started: Array<[string, string | undefined]> = []
  let onEvents: (method: string, params: unknown) => void = () => {}
  let onApproval: (kind: ApprovalKind, params: Record<string, unknown>) => Promise<'accept' | 'decline'> = async () => 'decline'
  let onExit: (code: number | null) => void = () => {}
  let exitDuringStart = false
  let startError: string | null = null
  let running = false

  const sink: ConversationSink = {
    events: (batch) => { events.push(...batch); calls.push(`events(${batch.map((e) => e.kind).join(',')})`) },
    state: (s) => { states.push(s.kind); calls.push(`state(${s.kind})`) },
    approvalAsk: (payload) => { asks.push(payload); calls.push(`ask(${payload.toolUseId})`) },
    approvalSettled: (id) => { calls.push(`settled(${id})`) },
  }

  const core = createCodexConversation({
    sink,
    onTurnProduced: options?.onTurnProduced,
    loadHistory: options.loadHistory ?? (async () => [{ type: 'agentMessage', id: 'a', text: 'history' }]),
    ...(options.peerTools === undefined ? {} : { peerTools: options.peerTools }),
    ...(options.viewTools === undefined ? {} : { viewTools: options.viewTools }),
    ...(options.chefTools === undefined ? {} : { chefTools: options.chefTools }),
    cwd: '/p/alpha',
    logError: (e) => { errors.push(e.message) },
    onSessionEnded: options?.onSessionEnded,
    onSessionStarted: (id, cwd) => { started.push([id, cwd]) },
    onPendingApprovalsChange: (n) => { pendingCounts.push(n) },
    onBusyChange: (b) => { busy.push(b); options.onBusyChange?.(b) },
    ...(options.initialThreadId === undefined ? {} : { initialThreadId: options.initialThreadId }),
    approvalTimeoutMs: 60_000,
    createRegistry: createApprovalRegistry,
    commandExists: () => options.commandExists ?? true,
    createClient: (d) => {
      capturedDeps = d
      onExit = d.onExit
      onEvents = d.onEvents
      onApproval = d.onApproval
      const client: CodexClient = {
        start: async (threadId) => {
          calls.push(`start(${threadId ?? '-'})`)
          if (exitDuringStart) { onExit(1); throw new Error('子程序在 handshake 中途退出') }
          if (startError !== null) throw new Error(startError)
          running = true
          return { threadId: threadId ?? 'th-new', model: 'gpt-6-astra' }
        },
        send: async (text) => { calls.push(`send(${text})`); await options.send?.() },
        interrupt: async () => { calls.push('interrupt') },
        teardown: async () => { calls.push('teardown'); running = false },
        isRunning: () => running,
      }
      return client
    },
  })

  return {
    clientDeps: () => {
      if (capturedDeps === undefined) throw new Error('測試尚未建立 client')
      return capturedDeps
    },
    core, calls, events, states, asks, errors, pendingCounts, busy, started,
    notify: (method, params) => { onEvents(method, params) },
    approve: (kind, params) => onApproval(kind, params),
    killDuringStart: () => { exitDuringStart = true },
    failStart: (message) => { startError = message },
    exit: (code) => { onExit(code) },
  }
}

describe('第一則訊息', () => {
  it('start 之後 send;畫面有使用者的話與 session-start,狀態轉 live', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.calls.filter((c) => c.startsWith('start') || c.startsWith('send'))).toEqual(['start(-)', 'send(你好)'])
    expect(r.events.map((e) => e.kind)).toEqual(['reset', 'user-text', 'session-start'])
    expect(r.events[2]).toEqual({ kind: 'session-start', sessionId: 'th-new', cwd: '/p/alpha', model: 'gpt-6-astra' })
    expect(r.states.at(-1)).toBe('live')
    expect(r.busy).toEqual([true])
  })

  it('threadId 記進 onSessionStarted,路由器才存得進 thread', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.started).toEqual([['th-new', '/p/alpha']])
  })

  it('第二則訊息不再 start,直接 send', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('一')
    await flush()
    r.core.userInput('二')
    await flush()
    expect(r.calls.filter((c) => c.startsWith('start'))).toEqual(['start(-)'])
    expect(r.calls.filter((c) => c.startsWith('send'))).toEqual(['send(一)', 'send(二)'])
  })

  it('重開 app:帶 initialThreadId 時狀態是 viewing,第一則訊息走 resume', async () => {
    const r = setup({ initialThreadId: 'th-old' })
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-old' })
    r.core.activate()
    r.core.userInput('接續')
    await flush()
    expect(r.calls.filter((c) => c.startsWith('start'))).toEqual(['start(th-old)'])
  })

  it('PATH 沒有 codex:不 spawn,畫面出錯誤,busy 解除', async () => {
    const r = setup({ commandExists: false })
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.calls.some((c) => c.startsWith('start'))).toBe(false)
    expect(r.events.at(-1)).toEqual({ kind: 'session-end', isError: true, errorMessage: MSG_NO_CODEX })
    expect(r.core.busyStartedAt()).toBeNull()
    expect(r.busy).toEqual([true, false])
  })

  it('未登入:thread/start 失敗時畫面出可讀的錯誤', async () => {
    const r = setup()
    r.failStart('thread/start:{"message":"not logged in"}')
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    const last = r.events.at(-1)
    expect(last?.kind).toBe('session-end')
    expect(last).toMatchObject({ isError: true })
    expect((last as { errorMessage?: string }).errorMessage).toContain(MSG_NOT_LOGGED_IN)
    expect(r.core.isBusy()).toBe(false)
  })
})

describe('通知翻成事件', () => {
  it('codex 的通知經 mapper 進畫面', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.notify('item/agentMessage/delta', { itemId: 'i1', delta: '嗨', threadId: 't', turnId: 'u' })
    r.notify('item/completed', { item: { type: 'agentMessage', id: 'i1', text: '嗨' }, threadId: 't', turnId: 'u', completedAtMs: 1 })
    expect(r.events.map((e) => e.kind)).toContain('text-delta')
    expect(r.events.map((e) => e.kind)).toContain('text')
  })

  it('turn/completed 讓 busy 解除', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.core.isBusy()).toBe(true)
    r.notify('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })
    expect(r.core.isBusy()).toBe(false)
    expect(r.core.busyStartedAt()).toBeNull()
    expect(r.busy).toEqual([true, false])
  })

  it('背景時事件記進 log 不送出,切回前景重播', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const before = r.events.length
    r.notify('item/completed', { item: { type: 'agentMessage', id: 'i9', text: '背景講的話' }, threadId: 't', turnId: 'u', completedAtMs: 1 })
    expect(r.events.length).toBe(before)
    r.core.activate()
    expect(r.events.some((e) => e.kind === 'text' && (e as { text: string }).text === '背景講的話')).toBe(true)
    expect(r.events[before]).toEqual({ kind: 'reset' })
  })
})

describe('批准', () => {
  const cmdParams = { itemId: 'c1', threadId: 't', turnId: 'u', startedAtMs: 1, command: 'rm x', cwd: '/p', reason: '要刪檔' }

  it('前景:commandExecution 送批准卡,欄位是 Bash 與指令', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    const decision = r.approve('command', cmdParams)
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.asks[0]).toMatchObject({ toolUseId: 'c1', toolName: 'Bash', input: { command: 'rm x', cwd: '/p', reason: '要刪檔' } })
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    expect(await decision).toBe('accept')
  })

  it('fileChange 的卡片是 Edit,input 只有 reason(請求本身沒有 changes)', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    const decision = r.approve('fileChange', { itemId: 'f1', threadId: 't', turnId: 'u', startedAtMs: 1, reason: '改檔' })
    await flush()
    expect(r.asks[0]).toMatchObject({ toolUseId: 'f1', toolName: 'Edit', input: { reason: '改檔' } })
    r.core.approvalReply(r.asks[0]!.requestId, 'deny')
    expect(await decision).toBe('decline')
  })

  it('fileChange 只關聯同 thread／turn 的完整 item 證據', async () => {
    const r = setup(); r.core.activate(); r.core.userInput('改檔'); await flush()
    const changes = [{ path: '/p/alpha/a.ts', kind: { type: 'add' }, diff: '+ hello' }]
    r.notify('item/started', { threadId: 't', turnId: 'u', item: { type: 'fileChange', id: 'f1', changes } })
    const matching = r.approve('fileChange', { itemId: 'f1', threadId: 't', turnId: 'u' }); await flush()
    expect(r.asks.at(-1)?.input).toMatchObject({ changes })
    expect(r.asks.at(-1)?.validateEvidence).toBeUndefined() // functions never cross IPC
    r.core.approvalReply(r.asks.at(-1)!.requestId, 'deny'); await matching
    const wrong = r.approve('fileChange', { itemId: 'f1', threadId: 't', turnId: 'different' }); await flush()
    expect(r.asks.at(-1)?.input).not.toHaveProperty('changes')
    r.core.approvalReply(r.asks.at(-1)!.requestId, 'deny'); await wrong
  })

  it('背景:批准立即送卡,pendingApprovals 加一;切回前景不重送', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const decision = r.approve('command', cmdParams)
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.core.pendingApprovals()).toBe(1)
    expect(r.pendingCounts).toEqual([1])
    r.core.activate()
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.core.pendingApprovals()).toBe(1)
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    expect(await decision).toBe('accept')
  })

  it('逾時回 decline', async () => {
    vi.useFakeTimers()
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await vi.advanceTimersByTimeAsync(0)
    const decision = r.approve('command', cmdParams)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await decision).toBe('decline')
    vi.useRealTimers()
  })
})

describe('其他動作', () => {
  it('子程序在 handshake 中途死掉:只推一張錯誤卡', async () => {
    const r = setup()
    r.killDuringStart()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.events.filter((e) => e.kind === 'session-end')).toHaveLength(1)
    expect(r.core.isBusy()).toBe(false)
  })

  it('startNew 在回合進行中先中斷再收掉', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.startNew()
    await flush()
    expect(r.calls.indexOf('interrupt')).toBeGreaterThan(-1)
    expect(r.calls.indexOf('interrupt')).toBeLessThan(r.calls.lastIndexOf('teardown'))
  })

  it('startNew 之後,舊 client 才到的事件不落進新對話', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.startNew()
    await flush()
    const afterReset = r.events.length
    // 中斷造成的 turn/completed 在 reset 之後才到
    r.notify('turn/completed', { threadId: 't', turn: { id: 'u', status: 'interrupted' } })
    expect(r.events.length).toBe(afterReset)
    expect(r.core.sessionState()).toEqual({ kind: 'idle' })
  })

  it('startNew 清掉上一個 thread 的 token 累計', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 4200 } } })
    r.core.startNew()
    await flush()
    r.core.userInput('新對話')
    await flush()
    r.notify('turn/completed', { turn: { status: 'completed' } })
    expect(r.events.at(-1)).toEqual({ kind: 'session-end', isError: false })
  })

  it('子程序在回合中死掉:畫面出錯誤、busy 解除、狀態回 viewing', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.exit(1)
    expect(r.events.at(-1)).toMatchObject({ kind: 'session-end', isError: true })
    expect(r.core.isBusy()).toBe(false)
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-new' })
  })

  it('子程序在回合之外死掉:狀態回 viewing,不多推事件', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.notify('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })
    const before = r.events.length
    r.exit(0)
    expect(r.events.length).toBe(before)
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-new' })
  })

  it('startNew 把前景與背景的批准都收掉', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    const foreground = r.approve('command', { itemId: 'c1', threadId: 't', turnId: 'u', startedAtMs: 1, command: 'x', cwd: '/p' })
    await flush()
    r.core.deactivate()
    const background = r.approve('command', { itemId: 'c2', threadId: 't', turnId: 'u', startedAtMs: 1, command: 'y', cwd: '/p' })
    await flush()
    expect(r.core.pendingApprovals()).toBe(2)
    r.core.startNew()
    await flush()
    expect(await foreground).toBe('decline')
    expect(await background).toBe('decline')
    expect(r.core.pendingApprovals()).toBe(0)
  })

  it('startNew:收掉子程序、清畫面、狀態回 idle', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.startNew()
    await flush()
    expect(r.calls).toContain('teardown')
    expect(r.events.at(-1)).toEqual({ kind: 'reset' })
    expect(r.core.sessionState()).toEqual({ kind: 'idle' })
    expect(r.core.isBusy()).toBe(false)
  })

  it('deactivate:回合已結束就收掉子程序;回合進行中等它結束', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    await flush()
    expect(r.calls.filter((c) => c === 'teardown')).toEqual([])
    r.notify('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })
    await flush()
    expect(r.calls).toContain('teardown')
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-new' })
  })

  it('從未啟用的核心收到背景輸入後立即停用，啟動完成且回合結束才休眠', async () => {
    const r = setup()
    r.core.userInput('背景提問')
    r.core.deactivate()
    await flush()
    expect(r.calls).toEqual(['start(-)', 'send(背景提問)'])
    expect(r.core.isActive()).toBe(false)
    expect(r.core.isBusy()).toBe(true)
    r.notify('turn/completed', { threadId: 'th-new', turn: { id: 'u', status: 'completed' } })
    await flush()
    expect(r.calls).toEqual(['start(-)', 'send(背景提問)', 'teardown'])
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-new' })
    expect(r.errors).toEqual([])
    await r.core.dispose()
  })

  it('handoffDone 記錯誤,不做事', () => {
    const r = setup()
    r.core.handoffDone('t-1')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('交接')
  })

  it('openHistory 載入後 viewing,下次輸入 resume 該 thread', async () => {
    const loadHistory = vi.fn(async () => [{ type: 'agentMessage', id: 'a', text: 'history' }])
    const r = setup({ loadHistory })
    r.core.activate()
    r.core.openHistory('t1')
    await flush()
    expect(loadHistory).toHaveBeenCalledExactlyOnceWith('t1')
    expect(r.events.slice(1)).toEqual([
      { kind: 'reset' }, { kind: 'text', messageId: 'a', index: 0, text: 'history' },
      { kind: 'session-end', isError: false },
    ])
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 't1' })
    r.core.userInput('next')
    await flush()
    expect(r.calls).toContain('start(t1)')
  })

  it('開歷史先中斷正在跑的 client', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('hi')
    await flush()
    r.core.openHistory('t1')
    await flush()
    expect(r.calls.indexOf('interrupt')).toBeLessThan(r.calls.indexOf('teardown'))
    expect(r.calls.indexOf('teardown')).toBeLessThan(r.calls.indexOf('events(text,session-end)'))
    expect(r.core.isBusy()).toBe(false)
    r.core.handoffDone('t-1')
    expect(r.errors[0]).toContain('交接')
  })

  it('dispose:有進行中的回合先 interrupt 再收掉,扣住的批准以 deny 收尾', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const decision = r.approve('command', { itemId: 'c1', threadId: 't', turnId: 'u', startedAtMs: 1, command: 'x', cwd: '/p' })
    await flush()
    await r.core.dispose()
    expect(r.calls).toContain('interrupt')
    expect(r.calls).toContain('teardown')
    expect(await decision).toBe('decline')
  })

  it('replay 在背景不動作', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const before = r.events.length
    r.core.replay()
    expect(r.events.length).toBe(before)
  })
})

describe('同伴工具', () => {
  const fakePeerTools = (over: Partial<PeerTools> = {}): PeerTools => ({
    askPeer: async () => '預設答案',
    answerPeer: async () => '已回答',
    ...over,
  })

  it('沒給 peerTools 時不帶工具規格', async () => {
    const h = setup()
    h.core.userInput('你好')
    await flush()
    expect(h.clientDeps().dynamicTools).toBeUndefined()
  })

  it('給了就帶兩個工具規格,名稱與描述都對', async () => {
    const h = setup({ peerTools: fakePeerTools() })
    h.core.userInput('你好')
    await flush()
    const tools = h.clientDeps().dynamicTools
    expect(tools?.map((t) => t.name)).toEqual(['ask_peer', 'answer_peer'])
    expect(tools?.map((t) => t.type)).toEqual(['function', 'function'])
    for (const t of tools ?? []) expect(t.description.length).toBeGreaterThan(0)
  })

  it('ask_peer 轉給服務,答案回給 codex', async () => {
    const seen: Array<[string, string | undefined]> = []
    const h = setup({ peerTools: fakePeerTools({ askPeer: async (q, to) => { seen.push([q, to]); return '同伴說好' } }) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('ask_peer', { question: '在嗎', to: 'bbbb2222' }, callParams())
    expect(seen).toEqual([['在嗎', 'bbbb2222']])
    expect(out).toEqual({ ok: true, text: '同伴說好' })
  })

  it('ask_peer 缺 question 時回錯誤,不呼叫服務', async () => {
    let called = false
    const h = setup({ peerTools: fakePeerTools({ askPeer: async () => { called = true; return 'x' } }) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('ask_peer', { to: 'bbbb2222' }, callParams())
    expect(called).toBe(false)
    expect(out?.ok).toBe(false)
  })

  it('to 給了但不是有效字串時回錯誤,不呼叫服務(規格 §5)', async () => {
    let called = false
    const h = setup({ peerTools: fakePeerTools({ askPeer: async () => { called = true; return 'x' } }) })
    h.core.userInput('你好')
    await flush()
    for (const bad of ['', 3, null, {}]) {
      const out = await h.clientDeps().onDynamicToolCall?.('ask_peer', { question: '在嗎', to: bad }, callParams())
      expect(out?.ok, String(bad)).toBe(false)
    }
    expect(called).toBe(false)
  })

  it('answer_peer 轉給服務', async () => {
    const seen: Array<[string, string]> = []
    const h = setup({ peerTools: fakePeerTools({ answerPeer: async (id, text) => { seen.push([id, text]); return '已回答' } }) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('answer_peer', { id: 'q-1', text: '我在' }, callParams())
    expect(seen).toEqual([['q-1', '我在']])
    expect(out).toEqual({ ok: true, text: '已回答' })
  })

  it('answer_peer 缺參數時回錯誤', async () => {
    const h = setup({ peerTools: fakePeerTools() })
    h.core.userInput('你好')
    await flush()
    expect((await h.clientDeps().onDynamicToolCall?.('answer_peer', { id: 'q-1' }, callParams()))?.ok).toBe(false)
    expect((await h.clientDeps().onDynamicToolCall?.('answer_peer', { text: '我在' }, callParams()))?.ok).toBe(false)
  })

  it('服務丟錯時把訊息當成回給模型的文字', async () => {
    const h = setup({ peerTools: fakePeerTools({ askPeer: async () => { throw new PeerError('這個專案沒有別的同伴') } }) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('ask_peer', { question: '有人嗎' }, callParams())
    expect(out).toEqual({ ok: false, text: '這個專案沒有別的同伴' })
  })

  it('不認得的工具名稱回錯誤', async () => {
    const h = setup({ peerTools: fakePeerTools() })
    h.core.userInput('你好')
    await flush()
    expect((await h.clientDeps().onDynamicToolCall?.('view_click', {}, callParams()))?.ok).toBe(false)
  })
})

describe('同伴工具的執行期邊界', () => {
  it('必填參數不是非空字串時不呼叫服務', async () => {
    const askPeer = vi.fn(async () => '答案')
    const answerPeer = vi.fn(async () => '已回答')
    const h = setup({ peerTools: { askPeer, answerPeer } })
    h.core.userInput('你好')
    await flush()
    const call = h.clientDeps().onDynamicToolCall!
    for (const args of [null, undefined, [], '字串', 1, { question: '' }, { question: 1 }]) {
      expect(await call('ask_peer', args, callParams())).toEqual({ ok: false, text: PEER_MSG.askPeerNeedsQuestion })
    }
    for (const args of [null, [], { id: '', text: '我在' }, { id: 'q-1', text: 1 }, { id: 1, text: '我在' }, { id: 'q-1', text: '' }]) {
      expect(await call('answer_peer', args, callParams())).toEqual({ ok: false, text: PEER_MSG.answerPeerNeedsBoth })
    }
    expect(askPeer).not.toHaveBeenCalled()
    expect(answerPeer).not.toHaveBeenCalled()
  })

  it('完全不帶 to 就是不指定,交給服務自己解析', async () => {
    const askPeer = vi.fn(async () => '答案')
    const h = setup({ peerTools: { askPeer, answerPeer: async () => '已回答' } })
    h.core.userInput('你好')
    await flush()
    expect(await h.clientDeps().onDynamicToolCall!('ask_peer', Object.freeze({ question: '在嗎' }), callParams())).toEqual({ ok: true, text: '答案' })
    expect(askPeer).toHaveBeenLastCalledWith('在嗎', undefined)
  })

  it('answer_peer 的 PeerError 回文字,其他例外原樣往 client 丟', async () => {
    const failure = new Error('非預期失敗')
    const h = setup({ peerTools: {
      askPeer: async () => { throw failure },
      answerPeer: async () => { throw new PeerError('找不到問題') },
    } })
    h.core.userInput('你好')
    await flush()
    const call = h.clientDeps().onDynamicToolCall!
    await expect(call('ask_peer', { question: '在嗎' }, callParams())).rejects.toBe(failure)
    expect(await call('answer_peer', { id: 'q-1', text: '我在' }, callParams())).toEqual({ ok: false, text: '找不到問題' })
  })

  it('工具規格沿用共用描述,每次回傳獨立物件', () => {
    const specs = codexPeerToolSpecs()
    expect(specs.map((t) => t.description)).toEqual([PEER_MSG.askPeerDescription, PEER_MSG.answerPeerDescription])
    expect(specs.map((t) => t.inputSchema)).toEqual([
      { type: 'object', properties: { question: { type: 'string' }, to: { type: 'string' } }, required: ['question'] },
      { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
    ])
    expect(codexPeerToolSpecs()[0]).not.toBe(specs[0])
  })
})


it('背景 codex 結束回報 tokens,replay 不重複回報', async () => {
  const ended = vi.fn()
  const r = setup({ onSessionEnded: ended })
  r.core.activate()
  r.core.userInput('嗨')
  await flush()
  r.core.deactivate()
  r.notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 4200 } } })
  r.notify('turn/completed', { turn: { status: 'completed' } })
  expect(ended).toHaveBeenCalledExactlyOnceWith('th-new', { kind: 'session-end', isError: false, tokens: 4200 })
  r.core.replay()
  expect(ended).toHaveBeenCalledTimes(1)
})

it('回合結束通知閒置時同步投遞的新回合結束後才休眠', async () => {
  let injected = false
  const r = setup({ onBusyChange: (busy) => {
    if (busy || injected) return
    injected = true
    deliver('第二則提問')
  } })
  const deliver = (text: string): void => {
    r.core.userInput(text)
    r.core.deactivate()
  }
  deliver('第一則提問')
  await flush()
  expect(r.core.isBusy()).toBe(true)
  r.notify('turn/completed', { threadId: 'th-new', turn: { id: 'u1', status: 'completed' } })
  await flush()
  expect(r.calls).toEqual(['start(-)', 'send(第一則提問)', 'send(第二則提問)'])
  expect(r.core.sessionState()).toEqual({ kind: 'live', sessionId: 'th-new' })
  expect(r.core.isBusy()).toBe(true)
  expect(r.core.isActive()).toBe(false)
  r.notify('turn/completed', { threadId: 'th-new', turn: { id: 'u2', status: 'completed' } })
  await flush()
  expect(r.calls).toEqual(['start(-)', 'send(第一則提問)', 'send(第二則提問)', 'teardown'])
  expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-new' })
  expect(r.core.isBusy()).toBe(false)
  expect(r.errors).toEqual([])
  await r.core.dispose()
})

it('歷史載入失敗會顯示錯誤並恢復非 live 狀態', async () => {
  const r = setup({ loadHistory: async () => { throw new Error('讀不到') } })
  r.core.activate()
  r.core.openHistory('bad')
  await flush()
  expect(r.events.at(-1)).toMatchObject({ kind: 'session-end', isError: true })
  expect(r.errors[0]).toContain('讀不到')
  expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'bad' })
})
it('載入歷史途中 startNew 不會被舊回應覆蓋', async () => {
  let resolve: (items: readonly unknown[]) => void = () => {}
  const r = setup({ loadHistory: () => new Promise((done) => { resolve = done }) })
  r.core.activate()
  r.core.openHistory('old')
  await flush()
  r.core.startNew()
  resolve([{ type: 'agentMessage', id: 'old', text: '過期' }])
  await flush()
  expect(r.core.sessionState()).toEqual({ kind: 'idle' })
  expect(r.events.at(-1)).toEqual({ kind: 'reset' })
})

it('歷史尚未讀完就輸入,訊息仍留在 RESET 後並接續所選 thread', async () => {
  const r = setup()
  r.core.activate()
  r.core.openHistory('t1')
  r.core.userInput('next')
  await flush()
  expect(r.events.slice(1).map((e) => e.kind)).toEqual(['reset', 'user-text', 'session-start'])
  expect(r.calls).toContain('start(t1)')
  expect(r.core.isBusy()).toBe(true)
})


describe('歷史切換立即回饋', () => {
  it('openHistory 同步推 RESET 與 viewing', () => {
    const r = setup()
    r.core.activate()
    const before = r.events.length
    r.core.openHistory('old')
    expect(r.events.slice(before)).toEqual([{ kind: 'reset' }])
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'old' })
    expect(r.states.at(-1)).toBe('viewing')
  })

  it('載入中輸入同步顯示並 busy,晚到歷史不能覆蓋', async () => {
    let resolve: (items: readonly unknown[]) => void = () => {}
    const r = setup({ loadHistory: () => new Promise((done) => { resolve = done }) })
    r.core.activate()
    r.core.openHistory('old')
    await flush()
    r.core.userInput('接續')
    expect(r.events.at(-1)).toEqual({ kind: 'user-text', text: '接續' })
    expect(r.core.isBusy()).toBe(true)
    resolve([{ type: 'agentMessage', id: 'late', text: '過期歷史' }])
    await flush()
    expect(r.events.some((e) => e.kind === 'text')).toBe(false)
    expect(r.events.some((e) => e.kind === 'session-end')).toBe(false)
    expect(r.calls).toContain('start(old)')
    r.notify('turn/completed', { turn: { status: 'completed' } })
    expect(r.core.isBusy()).toBe(false)
  })

  it('send 尚未完成時 openHistory 同步 interrupt', async () => {
    let finish: () => void = () => {}
    const r = setup({ send: () => new Promise<void>((done) => { finish = done }) })
    r.core.activate()
    r.core.userInput('執行中')
    await flush()
    r.core.openHistory('old')
    expect(r.calls).toContain('interrupt')
    finish()
    await flush()
    expect(r.calls).toContain('teardown')
  })
})


it('重開 app 啟用後載回 initialThreadId 的歷史', async () => {
  const loadHistory = vi.fn(async () => [{ type: 'agentMessage', id: 'restored', text: '還原內容' }])
  const r = setup({ initialThreadId: 'saved', loadHistory })
  r.core.activate()
  await flush()
  expect(loadHistory).toHaveBeenCalledExactlyOnceWith('saved')
  expect(r.events).toEqual([
    { kind: 'reset' },
    { kind: 'text', messageId: 'restored', index: 0, text: '還原內容' },
    { kind: 'session-end', isError: false },
  ])
  r.core.replay()
  await flush()
  expect(loadHistory).toHaveBeenCalledTimes(1)
})

it('歷史載入中連送兩則輸入都會接續所選 thread', async () => {
  const r = setup()
  r.core.activate()
  r.core.openHistory('selected')
  r.core.userInput('第一則')
  r.core.userInput('第二則')
  await flush()
  expect(r.calls.filter((call) => call.startsWith('send('))).toEqual(['send(第一則)', 'send(第二則)'])
})

describe('右窗格工具', () => {
  const OK: ViewToolInvocation = { ok: true, output: { kind: 'text', text: '已到 https://a.test/,標題 A' } }
  const SHOT: ViewToolInvocation = {
    ok: true,
    output: { kind: 'image', text: '可視範圍 800×600', dataBase64: 'CCCC', mimeType: 'image/png' },
  }

  /** 假的 CodexViewTools:記下每次 invoke 的參數,結果由測試逐次排隊。 */
  function fakeViewTools(results: ViewToolInvocation[]): CodexViewTools & {
    readonly seen: Array<[string, unknown, string | null]>
    readonly dones: string[]
  } {
    const seen: Array<[string, unknown, string | null]> = []
    const dones: string[] = []
    return {
      seen,
      dones,
      invoke: async (name, args, ctx) => {
        seen.push([name, args, ctx.callId])
        return results.shift() ?? OK
      },
      handoffDone: (toolUseId) => { dones.push(toolUseId) },
    }
  }

  it('給了 viewTools 就把九個工具規格帶給 codex,名字平鋪、順序照契約', async () => {
    const view = fakeViewTools([])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    expect(h.clientDeps().dynamicTools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES])
    for (const spec of h.clientDeps().dynamicTools ?? []) {
      expect(spec.type, spec.name).toBe('function')
      expect(spec.description.length, spec.name).toBeGreaterThan(0)
      expect(spec.inputSchema['type'], spec.name).toBe('object')
    }
  })

  it('同時有 viewTools 與 peerTools 時十個工具都帶,view 在前(RESULTS-22 §5:平鋪十個照單全收)', async () => {
    const h = setup({ viewTools: fakeViewTools([]), peerTools: { askPeer: async () => 'a', answerPeer: async () => 'b' } })
    h.core.userInput('你好')
    await flush()
    expect(h.clientDeps().dynamicTools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES, 'ask_peer', 'answer_peer'])
  })

  it('白名單工具直接分派,callId 當 ctx.callId,不問批准', async () => {
    const view = fakeViewTools([OK])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.(
      'view_click', { ref: 's1-e0' }, callParams('exec-7', 'view_click'))
    expect(view.seen).toEqual([['view_click', { ref: 's1-e0' }, 'exec-7']])
    expect(out).toEqual({ ok: true, text: '已到 https://a.test/,標題 A' })
    expect(h.asks).toEqual([])
  })

  it.each(['allow', 'deny'] as const)('view_navigate 先顯示網址並等待批准，決定為 %s', async (decision) => {
    const view = fakeViewTools([OK])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const args = { url: 'https://a.test/' }
    const pending = h.clientDeps().onDynamicToolCall?.(
      'view_navigate', args, callParams('exec-nav', 'view_navigate'))
    await flush()
    expect(h.asks).toHaveLength(1)
    expect(h.asks[0]).toMatchObject({
      toolUseId: 'exec-nav', toolName: 'view_navigate', input: args,
    })
    expect(view.seen).toEqual([])
    const ask = h.asks[0]
    if (ask === undefined) throw new Error('缺少導航批准請求')
    h.core.approvalReply(ask.requestId, decision)
    await flush()
    const out = await pending
    if (decision === 'allow') {
      expect(out).toEqual({ ok: true, text: '已到 https://a.test/,標題 A' })
      expect(view.seen).toEqual([['view_navigate', args, 'exec-nav']])
    } else {
      expect(out).toMatchObject({ ok: false })
      expect(view.seen).toEqual([])
    }
  })

  it('只接 view 時未知工具回 unknownTool，同伴工具仍回缺服務', async () => {
    const view = fakeViewTools([])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    for (const tool of ['不存在', 'ask_peer', 'answer_peer']) {
      const result = await h.clientDeps().onDynamicToolCall?.(tool, {}, callParams('exec-1', tool))
      expect(result).toEqual({ ok: false, text: tool === '不存在' ? PEER_MSG.unknownTool(tool) : PEER_MSG.peerToolsMissing })
    }
    expect(view.seen).toEqual([])
  })

  it('交接缺 callId 時原樣傳 null，讓工具入口回 handoffNoId', async () => {
    const view = fakeViewTools([{ ok: false, text: MSG.handoffNoId }])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const result = await h.clientDeps().onDynamicToolCall?.('request_handoff', { reason: 'x' }, {
      ...callParams(), callId: null,
    })
    expect(result).toEqual({ ok: false, text: MSG.handoffNoId })
    expect(view.seen).toEqual([['request_handoff', { reason: 'x' }, null]])
  })

  it('需批准的工具缺 callId 時拒絕執行，不建立無法追蹤的批准卡', async () => {
    const view = fakeViewTools([])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const result = await h.clientDeps().onDynamicToolCall?.('view_eval', { expression: '1' }, {
      ...callParams(), callId: null,
    })
    expect(result).toEqual({ ok: false, text: MSG.badArgs('view_eval', 'callId') })
    expect(view.seen).toEqual([])
    expect(h.asks).toEqual([])
  })

  it('截圖回 data URL,文字照樣帶著(規格 §3:圖用 data URL)', async () => {
    const h = setup({ viewTools: fakeViewTools([SHOT]) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('view_screenshot', {}, callParams('exec-8', 'view_screenshot'))
    expect(out).toEqual({
      ok: true, text: '可視範圍 800×600', imageDataUrl: 'data:image/png;base64,CCCC',
    })
  })

  it('view_eval 先問批准,批准卡的 toolUseId 是 callId;允許後才分派', async () => {
    const view = fakeViewTools([OK])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const pending = h.clientDeps().onDynamicToolCall?.('view_eval', { expression: 'document.title' }, callParams('exec-9', 'view_eval'))
    await flush()
    expect(h.asks.map((a) => [a.toolUseId, a.toolName])).toEqual([['exec-9', 'view_eval']])
    expect(h.asks[0]?.input).toEqual({ expression: 'document.title' })
    expect(view.seen).toEqual([])
    const requestId = h.asks[0]?.requestId ?? ''
    h.core.approvalReply(requestId, 'allow')
    await flush()
    expect(await pending).toEqual({ ok: true, text: '已到 https://a.test/,標題 A' })
    expect(view.seen).toEqual([['view_eval', { expression: 'document.title' }, 'exec-9']])
  })

  it('拒絕 view_eval 時回拒絕原因,不呼叫 invoke', async () => {
    const view = fakeViewTools([OK])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const pending = h.clientDeps().onDynamicToolCall?.('view_eval', { expression: 'x()' }, callParams('exec-a', 'view_eval'))
    await flush()
    h.core.approvalReply(h.asks[0]?.requestId ?? '', 'deny')
    await flush()
    expect((await pending)?.ok).toBe(false)
    expect(view.seen).toEqual([])
  })

  it('configure_error_intake_env 先問批准卡，允許後才呼叫主廚工具', async () => {
    const call = vi.fn(async () => ({ ok: true, text: '已寫入 3 個變數' }))
    const chefTools: NonNullable<CodexConversationDeps['chefTools']> = {
      specs: [{ type: 'function', name: 'configure_error_intake_env', description: '寫入設定', inputSchema: { type: 'object' } }],
      call,
    }
    const h = setup({ chefTools })
    h.core.userInput('你好')
    await flush()
    const args = { envFile: '.env.local' }
    const pending = h.clientDeps().onDynamicToolCall?.('configure_error_intake_env', args, callParams('setup-call', 'configure_error_intake_env'))
    await flush()
    expect(h.asks).toHaveLength(1)
    expect(h.asks[0]).toMatchObject({ toolUseId: 'setup-call', toolName: 'configure_error_intake_env', input: args })
    expect(call).not.toHaveBeenCalled()
    h.core.approvalReply(h.asks[0]!.requestId, 'allow')
    await flush()
    expect(await pending).toEqual({ ok: true, text: '已寫入 3 個變數' })
    expect(call).toHaveBeenCalledExactlyOnceWith('configure_error_intake_env', args, 'setup-call')
  })

  it('check_error_intake 不顯示批准卡', async () => {
    const call = vi.fn(async () => ({ ok: true, text: '查到 0 個錯誤群' }))
    const chefTools: NonNullable<CodexConversationDeps['chefTools']> = {
      specs: [{ type: 'function', name: 'check_error_intake', description: '查詢', inputSchema: { type: 'object' } }],
      call,
    }
    const h = setup({ chefTools })
    h.core.userInput('你好')
    await flush()
    await expect(h.clientDeps().onDynamicToolCall?.('check_error_intake', { sinceMinutes: 5 }, callParams('check-call', 'check_error_intake')))
      .resolves.toEqual({ ok: true, text: '查到 0 個錯誤群' })
    expect(h.asks).toEqual([])
    expect(call).toHaveBeenCalledExactlyOnceWith('check_error_intake', { sinceMinutes: 5 }, 'check-call')
  })

  it('invoke 回失敗時原樣把文字講給模型', async () => {
    const h = setup({ viewTools: fakeViewTools([{ ok: false, text: MSG.sessionEnded }]) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('view_click', { ref: 's1-e0' }, callParams('exec-b', 'view_click'))
    expect(out).toEqual({ ok: false, text: MSG.sessionEnded })
  })

  it('沒給 viewTools 時不帶 view 工具規格,同伴工具照舊', async () => {
    const h = setup({ peerTools: { askPeer: async () => 'a', answerPeer: async () => 'b' } })
    h.core.userInput('你好')
    await flush()
    expect(h.clientDeps().dynamicTools?.map((t) => t.name)).toEqual(['ask_peer', 'answer_peer'])
  })

  it('handoffDone 轉給 runtime 的交接;沒接 viewTools 時記錯誤', async () => {
    const view = fakeViewTools([])
    const h = setup({ viewTools: view })
    h.core.handoffDone('exec-c')
    expect(view.dones).toEqual(['exec-c'])
    const bare = setup()
    bare.core.handoffDone('exec-d')
    expect(bare.errors.some((e) => e.includes('exec-d'))).toBe(true)
  })

  it('codexViewToolSpecs 每次回獨立物件,inputSchema 不共用', () => {
    const first = codexViewToolSpecs()
    expect(codexViewToolSpecs()[0]).not.toBe(first[0])
    expect(codexViewToolSpecs()[0]?.inputSchema).not.toBe(first[0]?.inputSchema)
  })
})

it('回合開始時間只在 idle 轉 busy 時記錄，結束清空', async () => {
  vi.setSystemTime(1000)
  const { core } = setup()
  expect(core.busyStartedAt()).toBeNull()
  core.userInput('問題')
  await flush()
  expect(core.busyStartedAt()).toBe(1000)
  vi.setSystemTime(5000)
  core.userInput('追加')
  await flush()
  expect(core.busyStartedAt()).toBe(1000)
  core.startNew()
  await flush()
  expect(core.busyStartedAt()).toBeNull()
  core.userInput('下一輪')
  await flush()
  expect(core.busyStartedAt()).toBe(5000)
  core.startNew()
  await flush()
  expect(core.busyStartedAt()).toBeNull()
  await core.dispose()
})

it('本回合產出旗標在背景也更新、只通知一次，下一回合重設', async () => {
  const produced = vi.fn()
  const rig = setup({ onTurnProduced: produced })
  expect(rig.core.turnProduced()).toBe(false)
  rig.core.userInput('問題')
  expect(rig.core.turnProduced()).toBe(false)
  await flush()
  rig.notify('item/started', { item: { type: 'userMessage', id: 'user', content: [] } })
  expect(rig.core.turnProduced()).toBe(false)
  rig.notify('item/agentMessage/delta', { itemId: 'i1', delta: '回答', threadId: 't', turnId: 'u' })
  expect(rig.core.turnProduced()).toBe(true)
  expect(produced).toHaveBeenCalledTimes(1)
  rig.notify('item/started', { item: { type: 'userMessage', id: 'user', content: [] } })
  rig.notify('item/agentMessage/delta', { itemId: 'i1', delta: '回答', threadId: 't', turnId: 'u' })
  expect(rig.core.turnProduced()).toBe(true)
  expect(produced).toHaveBeenCalledTimes(1)
  rig.notify('turn/completed', { turn: { status: 'completed' } })
  rig.core.userInput('下一輪')
  expect(rig.core.turnProduced()).toBe(false)
  rig.core.activate()
  rig.core.replay()
  expect(rig.core.turnProduced()).toBe(false)
  await flush()
  await rig.core.dispose()
})

it('codex 先跑指令、還沒有任何文字時就算已經在回應', async () => {
  const rig = setup({})
  rig.core.userInput('請跑指令')
  await flush()
  rig.notify('item/started', { item: { type: 'userMessage', id: 'user', content: [] } })
  expect(rig.core.turnProduced()).toBe(false)
  // codex 的 mapper 產的是 tool-use,不是 Claude 的 streaming 事件;
  // 一輪先跑 shell 是最常見的形狀,不能整輪停在「模型思考中」。
  rig.notify('item/started', { item: { type: 'commandExecution', id: 'cmd1', command: 'ls' } })
  expect(rig.core.turnProduced()).toBe(true)
  await rig.core.dispose()
})

it('codex 只有 reasoning 完成也算已經在回應', async () => {
  const rig = setup({})
  rig.core.userInput('想一下')
  await flush()
  expect(rig.core.turnProduced()).toBe(false)
  rig.notify('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['先看看檔案'] } })
  expect(rig.core.turnProduced()).toBe(true)
  await rig.core.dispose()
})
