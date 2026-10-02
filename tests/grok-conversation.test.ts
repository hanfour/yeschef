import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGrokConversation, grokStartFailureMessage, pickPermissionOption,
  type GrokConversationDeps, type GrokViewTools,
} from '../src/main/grok/conversation.js'
import type { ApprovalAsk, ApprovalDecision } from '../src/main/approval.js'
import { MSG, MSG_NO_GROK, type AcpMcpServer, type GrokClient, type GrokClientDeps, type PermissionOption } from '../src/main/grok/client.js'
import type { ApprovalRequest } from '../src/main/approval.js'
import type { ConversationSink } from '../src/main/conversation.js'
import type { Event } from '../src/shared/events.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

const MCP: AcpMcpServer = {
  name: 'yeschef', type: 'http', url: 'http://127.0.0.1:51234/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer tok-abc' }],
}

const OPTIONS: readonly PermissionOption[] = [
  { optionId: 'a1', name: '允許一次', kind: 'allow_once' },
  { optionId: 'a2', name: '總是允許', kind: 'allow_always' },
  { optionId: 'r1', name: '拒絕', kind: 'reject_once' },
  { optionId: 'r2', name: '總是拒絕', kind: 'reject_always' },
]

function setup(options: {
  commandExists?: boolean
  initialSessionId?: string
  viewTools?: GrokViewTools
  bootError?: string
} = {}) {
  const events: Event[] = []
  const states: string[] = []
  const asks: ApprovalRequest[] = []
  const errors: string[] = []
  const busy: boolean[] = []
  const order: string[] = []
  let captured: GrokClientDeps | undefined
  let alive = false
  const prompts: unknown[][] = []
  let settlePrompt: (result: { stopReason: string | undefined }) => void = () => {}

  const sink: ConversationSink = {
    events: (batch) => { events.push(...batch) },
    state: (state) => { states.push(state.kind) },
    approvalAsk: (request) => { asks.push(request) },
    approvalSettled: () => {},
  }

  const client: GrokClient = {
    get sessionId() { return captured?.resume ?? 's-new' },
    prompt: (blocks) => {
      prompts.push([...blocks])
      return new Promise((resolve) => { settlePrompt = resolve })
    },
    cancel: () => { order.push('cancel'); return Promise.resolve() },
    close: () => { order.push('client.close'); alive = false; return Promise.resolve() },
    models: () => [],
    isRunning: () => alive,
  }

  const deps: GrokConversationDeps = {
    sink,
    cwd: '/p/alpha',
    logError: (e) => { errors.push(e.message) },
    onBusyChange: (next) => { busy.push(next) },
    commandExists: () => options.commandExists !== false,
    ...(options.initialSessionId === undefined ? {} : { initialSessionId: options.initialSessionId }),
    ...(options.viewTools === undefined ? {} : { viewTools: options.viewTools }),
    createClient: (clientDeps) => {
      captured = clientDeps
      if (options.bootError !== undefined) return Promise.reject(new Error(options.bootError))
      alive = true
      return Promise.resolve(client)
    },
  }

  const core = createGrokConversation(deps)
  core.activate()
  return {
    core, events, states, asks, errors, busy, order, prompts,
    clientDeps: () => { if (captured === undefined) throw new Error('還沒建 client'); return captured },
    finishTurn: async (stopReason = 'end_turn') => { settlePrompt({ stopReason }); await flush() },
    kinds: () => events.map((e) => e.kind),
  }
}

function fakeViewTools(order: string[]): GrokViewTools & { ask?: (a: ApprovalAsk) => Promise<ApprovalDecision> } {
  const tools = {
    mcpServers: () => Promise.resolve([MCP]),
    useApproval: (request: (a: ApprovalAsk) => Promise<ApprovalDecision>) => { tools.ask = request },
    requestApproval: async (toolName: string, input: unknown) => tools.ask?.({ toolUseId: 'grok-view-test', toolName, input }) ?? 'deny',
    handoffDone: () => { order.push('handoffDone') },
    close: () => { order.push('viewTools.close'); return Promise.resolve() },
    ask: undefined as undefined | ((a: ApprovalAsk) => Promise<ApprovalDecision>),
  }
  return tools
}

describe('送出與回合', () => {
  it('userInput 先畫 user-text,再開 client 並送 session/prompt', async () => {
    const r = setup()
    r.core.userInput('你好')
    // setup() 已先呼叫 activate(),events[0] 是那時 replay() 送出的 reset;
    // userInput 送出的 user-text 接在它後面(對齊 codex 對話同一種情境的測試)。
    expect(r.events[1]).toEqual({ kind: 'user-text', text: '你好' })
    await flush()
    expect(r.prompts).toEqual([[{ type: 'text', text: '你好' }]])
    expect(r.clientDeps().cwd).toBe('/p/alpha')
    expect(r.kinds()).toContain('session-start')
    expect(r.states).toContain('live')
    expect(r.busy[0]).toBe(true)
  })

  it('mcpServers 從 viewTools 拿,原樣交給 client', async () => {
    const order: string[] = []
    const r = setup({ viewTools: fakeViewTools(order) })
    r.core.userInput('你好')
    await flush()
    expect(r.clientDeps().mcpServers).toEqual([MCP])
  })

  it('沒有 viewTools 時 mcpServers 是空陣列', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    expect(r.clientDeps().mcpServers).toEqual([])
  })

  it('prompt 回來才算回合結束,session-end 只發一次', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    expect(r.core.isBusy()).toBe(true)
    await r.finishTurn('end_turn')
    expect(r.kinds().filter((k) => k === 'session-end')).toHaveLength(1)
    expect(r.core.isBusy()).toBe(false)
  })

  it('回合進行中再送:先 cancel 再送新的 prompt', async () => {
    const r = setup()
    r.core.userInput('第一句')
    await flush()
    r.core.userInput('第二句')
    await flush()
    expect(r.order).toContain('cancel')
    expect(r.prompts).toHaveLength(2)
  })

  it('附件只帶路徑文字:grok 的 promptCapabilities.image 是 false', async () => {
    const r = setup()
    r.core.userInput('看這張', [{ name: 'a.png', path: '/p/a.png', kind: 'image', mime: 'image/png' }])
    await flush()
    const blocks = r.prompts[0] as { type: string; text: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toContain('/p/a.png')
    // grok 沒有原生圖片管道,那句「Images are attached as native image inputs」會誤導它去找不存在的輸入。
    expect(blocks[0]?.text).not.toContain('native image inputs')
  })

  it('boot 失敗且排了兩句:只留一張錯誤卡,不重複', async () => {
    const r = setup({ bootError: '磁碟已滿' })
    r.core.userInput('第一句')
    r.core.userInput('第二句')
    await flush()
    await flush()
    expect(r.events.filter((e) => e.kind === 'session-end')).toHaveLength(1)
  })
})

describe('批准', () => {
  it('request_permission 進批准卡片,allow 選 allow_once 的 optionId', async () => {
    const r = setup()
    r.core.userInput('改檔案')
    await flush()
    const outcome = r.clientDeps().onPermission({
      toolCallId: 'call-1', title: '寫入 README.md', kind: 'edit', rawInput: { path: 'README.md' }, options: OPTIONS,
    })
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.asks[0]).toMatchObject({ toolUseId: 'call-1', toolName: '寫入 README.md', displayName: 'edit', input: { path: 'README.md' } })
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    await expect(outcome).resolves.toEqual({ outcome: 'selected', optionId: 'a1' })
  })

  it('deny 選 reject_once', async () => {
    const r = setup()
    r.core.userInput('改檔案')
    await flush()
    const outcome = r.clientDeps().onPermission({ toolCallId: 'c', title: 't', kind: 'edit', rawInput: {}, options: OPTIONS })
    await flush()
    r.core.approvalReply(r.asks[0]!.requestId, 'deny')
    await expect(outcome).resolves.toEqual({ outcome: 'selected', optionId: 'r1' })
  })

  it('沒有任何可選項就回 cancelled', async () => {
    const r = setup()
    r.core.userInput('改檔案')
    await flush()
    const outcome = r.clientDeps().onPermission({ toolCallId: 'c', title: 't', kind: 'edit', rawInput: {}, options: [] })
    await flush()
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    await expect(outcome).resolves.toEqual({ outcome: 'cancelled' })
  })

  it('pickPermissionOption:沒有 *_once 時退回第一個同向的選項', () => {
    const onlyAlways: readonly PermissionOption[] = [
      { optionId: 'a2', name: '總是允許', kind: 'allow_always' },
      { optionId: 'r2', name: '總是拒絕', kind: 'reject_always' },
    ]
    expect(pickPermissionOption(onlyAlways, 'allow')).toBe('a2')
    expect(pickPermissionOption(onlyAlways, 'deny')).toBe('r2')
    expect(pickPermissionOption(OPTIONS, 'allow')).toBe('a1')
    expect(pickPermissionOption([], 'allow')).toBeUndefined()
  })
})

describe('歷史與重新開始', () => {
  it('openHistory 用 resume 開新 client,重播完發 session-end', async () => {
    const r = setup()
    r.core.openHistory('s-old')
    await flush()
    expect(r.clientDeps().resume).toBe('s-old')
    expect(r.kinds()[0]).toBe('reset')
    expect(r.kinds()).toContain('session-start')
    expect(r.kinds().at(-1)).toBe('session-end')
    expect(r.states).toContain('viewing')
  })

  it('重播中到達的 session/update 進對話', async () => {
    const r = setup()
    r.core.openHistory('s-old')
    await flush()
    r.clientDeps().onUpdate('session/update', {
      sessionId: 's-old',
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '舊的一句' } },
    })
    await flush()
    expect(r.events.some((e) => e.kind === 'user-text' && e.text === '舊的一句')).toBe(true)
  })

  it('重開 app 的 initialSessionId:第一次輸入才 resume', async () => {
    const r = setup({ initialSessionId: 's-saved' })
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-saved' })
    r.core.userInput('接著做')
    await flush()
    expect(r.clientDeps().resume).toBe('s-saved')
  })

  it('startNew 清空並收掉 client', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    await r.finishTurn()
    r.core.startNew()
    await flush()
    expect(r.order).toContain('client.close')
    expect(r.core.sessionState()).toEqual({ kind: 'idle' })
  })
})

describe('故障與收尾', () => {
  it('PATH 沒有 grok:卡片顯示那一句,不加前綴', async () => {
    const r = setup({ commandExists: false })
    r.core.userInput('你好')
    await flush()
    const ended = r.events.find((e) => e.kind === 'session-end')
    expect(ended).toMatchObject({ isError: true, errorMessage: MSG_NO_GROK })
    expect(r.core.isBusy()).toBe(false)
  })

  it('未登入:錯誤訊息前面補 grok login', async () => {
    const r = setup({ bootError: `${MSG.loginFirst}(unauthorized)` })
    r.core.userInput('你好')
    await flush()
    expect(r.events.find((e) => e.kind === 'session-end')).toMatchObject({ errorMessage: expect.stringContaining(MSG.loginFirst) })
  })

  it('子行程意外結束:發 session-end,狀態回到可重新開始', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    r.clientDeps().onExit(1)
    await flush()
    expect(r.events.find((e) => e.kind === 'session-end')).toMatchObject({ isError: true })
    expect(r.core.isBusy()).toBe(false)
    expect(r.core.sessionState().kind).toBe('viewing')
  })

  it('stderr 只進 logError,不進對話', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    const before = r.events.length
    r.clientDeps().onStderr('ERROR mcp server weather unavailable')
    expect(r.events).toHaveLength(before)
    expect(r.errors.some((e) => e.includes('weather'))).toBe(true)
  })

  it('全域 MCP server 連不上:記一行 log,不進對話(規格 §6.4)', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    const before = r.events.length
    r.clientDeps().onUpdate('_x.ai/mcp/server_status', {
      sessionId: 's-new', name: 'weather', status: 'unavailable', reason: 'connect_failed', detail: 'ECONNREFUSED',
    })
    await flush()
    expect(r.events).toHaveLength(before)
    expect(r.errors.some((e) => e.includes('weather') && e.includes('connect_failed'))).toBe(true)
  })

  it('dispose 的順序:client.close 在 viewTools.close 之前', async () => {
    const order: string[] = []
    const r = setup({ viewTools: fakeViewTools(order) })
    r.core.userInput('你好')
    await flush()
    const disposing = r.core.dispose()
    await vi.advanceTimersByTimeAsync(0)
    await disposing
    expect(r.order.concat(order).filter((s) => s.endsWith('close'))).toEqual(['client.close', 'viewTools.close'])
  })

  it('右窗格工具的批准走同一個 registry:等待期間 pendingApprovals 是 1,卡片也送得出去', async () => {
    const order: string[] = []
    const view = fakeViewTools(order)
    const r = setup({ viewTools: view })
    expect(view.ask).toBeDefined()
    const decision = view.ask?.({ toolUseId: 'call-9', toolName: 'view_eval', input: { expression: '1' } })
    await flush()
    expect(r.core.pendingApprovals()).toBe(1)
    expect(r.asks.map((a) => a.toolName)).toEqual(['view_eval'])
    r.core.approvalReply(r.asks[0]!.requestId, 'deny')
    expect(await decision).toBe('deny')
    expect(r.core.pendingApprovals()).toBe(0)
  })

  it('grokStartFailureMessage:找不到 grok 不加前綴,其餘加', () => {
    expect(grokStartFailureMessage(new Error(MSG_NO_GROK))).toBe(MSG_NO_GROK)
    expect(grokStartFailureMessage(new Error('磁碟已滿'))).toBe('grok 啟動失敗:磁碟已滿')
  })

  it('prompt 被拒絕:錯誤訊息用 rpcErrorMessage 拆開,不留 method 與整包 JSON', async () => {
    const events: Event[] = []
    const sink: ConversationSink = {
      events: (batch) => { events.push(...batch) },
      state: () => {},
      approvalAsk: () => {},
      approvalSettled: () => {},
    }
    let rejectPrompt: (error: Error) => void = () => {}
    const client: GrokClient = {
      get sessionId() { return 's-new' },
      prompt: () => new Promise((_resolve, reject) => { rejectPrompt = reject }),
      cancel: () => Promise.resolve(),
      close: () => Promise.resolve(),
      models: () => [],
      isRunning: () => true,
    }
    const deps: GrokConversationDeps = {
      sink,
      cwd: '/p/alpha',
      logError: () => {},
      commandExists: () => true,
      createClient: () => Promise.resolve(client),
    }
    const core = createGrokConversation(deps)
    core.activate()
    core.userInput('你好')
    await flush()
    rejectPrompt(new Error('session/prompt:{"code":-32000,"message":"模型忙碌"}'))
    await flush()
    const ended = events.find((e) => e.kind === 'session-end') as Extract<Event, { kind: 'session-end' }> | undefined
    expect(ended).toMatchObject({ isError: true })
    expect(ended?.errorMessage).toContain('模型忙碌')
    expect(ended?.errorMessage).not.toContain('session/prompt:{')
  })

  it('cancel 後再送:第一回合被丟棄的 settle 不發 session-end,也不影響第二回合的 busy', async () => {
    const events: Event[] = []
    const busyLog: boolean[] = []
    const sink: ConversationSink = {
      events: (batch) => { events.push(...batch) },
      state: () => {},
      approvalAsk: () => {},
      approvalSettled: () => {},
    }
    let resolveFirst: ((result: { stopReason: string | undefined }) => void) | null = null
    let promptCount = 0
    const client: GrokClient = {
      get sessionId() { return 's-new' },
      prompt: () => {
        promptCount += 1
        if (promptCount === 1) return new Promise((resolve) => { resolveFirst = resolve })
        return new Promise(() => {}) // 第二回合在這個測試裡不需要結束
      },
      cancel: () => {
        // 逼出最壞的時序:cancel() 同步讓第一回合的 prompt 以 cancelled 收尾,
        // 比第二回合的 ensureClient／runTurn 還快抵達。
        resolveFirst?.({ stopReason: 'cancelled' })
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
      models: () => [],
      isRunning: () => true,
    }
    const deps: GrokConversationDeps = {
      sink,
      cwd: '/p/alpha',
      logError: () => {},
      onBusyChange: (b) => { busyLog.push(b) },
      commandExists: () => true,
      createClient: () => Promise.resolve(client),
    }
    const core = createGrokConversation(deps)
    core.activate()
    core.userInput('第一句')
    await flush()
    core.userInput('第二句')
    await flush()

    expect(core.isBusy()).toBe(true)
    expect(core.busyStartedAt()).not.toBeNull()
    expect(events.some((e) => e.kind === 'session-end')).toBe(false)
  })

  it('回合中子行程意外結束:client 先 reject prompt 再呼叫 onExit(跟真 client 同一個順序),session-end 只發一次', async () => {
    const events: Event[] = []
    const ended: Array<[string, Event]> = []
    const sink: ConversationSink = {
      events: (batch) => { events.push(...batch) },
      state: () => {},
      approvalAsk: () => {},
      approvalSettled: () => {},
    }
    let rejectPrompt: (error: Error) => void = () => {}
    let onExitHandler: (code: number | null) => void = () => {}
    const client: GrokClient = {
      get sessionId() { return 's-new' },
      prompt: () => new Promise((_resolve, reject) => { rejectPrompt = reject }),
      cancel: () => Promise.resolve(),
      close: () => Promise.resolve(),
      models: () => [],
      isRunning: () => true,
    }
    const deps: GrokConversationDeps = {
      sink,
      cwd: '/p/alpha',
      logError: () => {},
      onSessionEnded: (id, event) => { ended.push([id, event]) },
      commandExists: () => true,
      createClient: (clientDeps) => {
        onExitHandler = clientDeps.onExit
        return Promise.resolve(client)
      },
    }
    const core = createGrokConversation(deps)
    core.activate()
    core.userInput('你好')
    await flush()
    // client.ts 的 detach() 就是這個順序:先 rejectAll(讓 prompt promise reject),
    // 同一個 tick 裡再呼叫 onExit,兩者都還在 reject 的微任務跑之前。
    rejectPrompt(new Error('grok 子行程已結束(code 1)'))
    onExitHandler(1)
    await flush()

    expect(events.filter((e) => e.kind === 'session-end')).toHaveLength(1)
    expect(ended).toHaveLength(1)
  })

  it('client 還在 boot 時連送兩句:兩句都要送到 grok,第二句送出前先 cancel 第一句', async () => {
    const events: Event[] = []
    const order: string[] = []
    const sink: ConversationSink = {
      events: (batch) => { events.push(...batch) },
      state: () => {},
      approvalAsk: () => {},
      approvalSettled: () => {},
    }
    let releaseBoot: () => void = () => {}
    const client: GrokClient = {
      get sessionId() { return 's-new' },
      prompt: (blocks) => {
        const text = (blocks[0] as { type: string; text: string }).text
        order.push(`prompt:${text}`)
        return new Promise(() => {}) // 這個測試不需要任何一回合真的結束
      },
      cancel: () => { order.push('cancel'); return Promise.resolve() },
      close: () => Promise.resolve(),
      models: () => [],
      isRunning: () => true,
    }
    const deps: GrokConversationDeps = {
      sink,
      cwd: '/p/alpha',
      logError: () => {},
      commandExists: () => true,
      // createClient 的 promise 卡住,模擬子行程還在 spawn、initialize、session/new 的期間。
      createClient: () => new Promise((resolve) => { releaseBoot = () => resolve(client) }),
    }
    const core = createGrokConversation(deps)
    core.activate()
    core.userInput('第一句')
    await flush()
    core.userInput('第二句')
    await flush()
    // client 還在 boot,userInput 裡同步那次 cancel 當時 client 還是 null,沒東西可呼叫。
    expect(order).toEqual([])

    releaseBoot()
    await flush()

    expect(order).toEqual(['prompt:第一句', 'cancel', 'prompt:第二句'])
    expect(core.isBusy()).toBe(true)
  })
})
