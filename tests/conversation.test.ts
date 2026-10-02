import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw new Error('測試不該走到真的 SDK')
  },
}))

import {
  createConversation,
  type Conversation,
  type ConversationSink,
} from '../src/main/conversation.js'
import type { Event } from '../src/shared/events.js'
import type { AgentHost, AgentHostDeps } from '../src/main/agent-host.js'
import { createApprovalRegistry, type ApprovalAsk, type ApprovalRequest } from '../src/main/approval.js'
import type { SessionOptions } from '../src/main/session-args.js'

const OPTIONS: SessionOptions = {
  cwd: '/p',
  permissionMode: 'default',
  includePartialMessages: true,
  settingSources: ['project', 'local'],
}
const HISTORY: readonly Event[] = [
  { kind: 'user-text', text: '舊的問題' },
  { kind: 'session-end', isError: false },
]
const START_S9: Event = { kind: 'session-start', sessionId: 's-9', cwd: '/p' }
const END_OK: Event = { kind: 'session-end', isError: false }
const say = (text: string): Event => ({ kind: 'user-text', text })
const ASK = { toolName: 'Bash', toolUseId: 'tu-1', input: { command: 'ls' }, title: '執行 ls' }
const ask = (toolUseId: string): ApprovalAsk => ({ toolUseId, toolName: 'Bash', input: {} })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

/** 讓已 resolve 的 promise 鏈全部跑完:假 host 的 promise 都是立刻 resolve,一個 macrotask 就夠。 */
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

interface Rig {
  readonly core: Conversation
  readonly calls: string[]
  readonly errors: Error[]
  readonly busyChanges: boolean[]
  readonly pendingCounts: number[]
  readonly started: string[]
  readonly asks: ApprovalRequest[]
  hostDeps(): AgentHostDeps
  endOnStart(): void
  readonly events: Event[]
  failSend(): void
  /** 讓 `host.send()` 直接丟例外,用來測 pending 鏈的 catch。 */
  throwSend(): void
  failHistory(): void
}

function setup(options?: { onTurnProduced?: () => void; onBusyChange?: (busy: boolean) => void; onSessionEnded?: (id: string, event: Event) => void; initialSessionId?: string; withViewTools?: true; approvalTimeoutMs?: number | null }): Rig {
  const calls: string[] = []
  const errors: Error[] = []
  const events: Event[] = []
  let endOnStart = false
  const busyChanges: boolean[] = []
  const pendingCounts: number[] = []
  const started: string[] = []
  const asks: ApprovalRequest[] = []
  let hostDeps: AgentHostDeps | null = null
  let sendSucceeds = true
  let sendThrows = false
  let historyFails = false

  const fakeHost: AgentHost = {
    start: (resume, initial) => {
      calls.push(`start(${resume ?? '-'},${initial ?? '-'})`)
      if (endOnStart) hostDeps?.onEnded()
    },
    send: (text) => {
      calls.push(`send(${text})`)
      if (sendThrows) throw new Error('送出爆炸')
      return sendSucceeds
    },
    interrupt: () => {
      calls.push('interrupt')
      return Promise.resolve()
    },
    teardown: () => {
      calls.push('teardown')
      return Promise.resolve()
    },
  }
  const sink: ConversationSink = {
    events: (batch) => {
      events.push(...batch)
      calls.push(`events(${batch.map((e) => e.kind).join(',')})`)
    },
    state: (state) => {
      calls.push(`state(${state.kind})`)
    },
    approvalAsk: (payload) => {
      asks.push(payload)
      calls.push(`ask(${payload.toolUseId})`)
    },
    approvalSettled: (requestId) => {
      calls.push(`settled(${requestId})`)
    },
  }
  const core = createConversation({
    sink,
    onTurnProduced: options?.onTurnProduced,
    sessionOptions: () => OPTIONS,
    loadHistory: (sessionId) => {
      calls.push(`loadHistory(${sessionId})`)
      return historyFails ? Promise.reject(new Error('磁碟壞了')) : Promise.resolve(HISTORY)
    },
    logError: (error) => {
      errors.push(error)
    },
    onSessionEnded: options?.onSessionEnded,
    onSessionStarted: (sessionId) => {
      started.push(sessionId)
    },
    onPendingApprovalsChange: (count) => {
      pendingCounts.push(count)
    },
    onBusyChange: (busy) => { busyChanges.push(busy); options?.onBusyChange?.(busy) },
    approvalTimeoutMs: options?.approvalTimeoutMs === undefined ? 60_000 : options.approvalTimeoutMs,
    createHost: (d) => {
      hostDeps = d
      return fakeHost
    },
    createRegistry: createApprovalRegistry,
    ...(options?.initialSessionId === undefined ? {} : { initialSessionId: options.initialSessionId }),
    ...(options?.withViewTools === undefined
      ? {}
      : {
          viewTools: {
            autoAllow: () => false,
            handoffDone: (id: string) => {
              calls.push(`handoffDone(${id})`)
            },
            abortPending: (reason: string) => {
              calls.push(`abortPending(${reason})`)
            },
          },
        }),
  })
  return {
    core,
    calls,
    errors,
    busyChanges,
    pendingCounts,
    started,
    asks,
    hostDeps: () => {
      if (hostDeps === null) throw new Error('host 尚未建立')
      return hostDeps
    },
    events,
    endOnStart: () => { endOnStart = true },
    failSend: () => {
      sendSucceeds = false
    },
    throwSend: () => {
      sendThrows = true
    },
    failHistory: () => {
      historyFails = true
    },
  }
}

/** 前景 + 開新 query + 送一則輸入 + SDK 回 session-start:之後就是「live 且回合進行中」。 */
async function liveBusy(rig: Rig): Promise<void> {
  rig.core.activate()
  rig.core.startNew()
  await flush()
  rig.core.userInput('嗨')
  await flush()
  rig.hostDeps().onBatch([START_S9])
  await flush()
  rig.calls.length = 0
}

describe('createConversation:初始狀態與 activate', () => {
  it('沒有 initialSessionId 就是 idle;activate 送 reset 與狀態', () => {
    const rig = setup()
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
    expect(rig.core.isActive()).toBe(false)
    rig.core.activate()
    expect(rig.core.isActive()).toBe(true)
    expect(rig.calls).toEqual(['events(reset)', 'state(idle)'])
  })

  it('有 initialSessionId 從 viewing 起步;activate 重讀 transcript', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-1' })
    rig.core.activate()
    await flush()
    expect(rig.calls).toEqual([
      'events(reset)',
      'loadHistory(s-1)',
      'events(user-text,session-end)',
      'state(viewing)',
    ])
  })

  it('activate 兩次只做一次', () => {
    const rig = setup()
    rig.core.activate()
    rig.core.activate()
    expect(rig.calls).toEqual(['events(reset)', 'state(idle)'])
  })

  it('replay 在前景重送目前內容;背景不動', () => {
    const rig = setup()
    rig.core.replay()
    expect(rig.calls).toEqual([])
    rig.core.activate()
    rig.core.replay()
    expect(rig.calls).toEqual(['events(reset)', 'state(idle)', 'events(reset)', 'state(idle)'])
  })

  it('讀歷史失敗:記錄並補一張錯誤卡', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.failHistory()
    rig.core.activate()
    await flush()
    expect(rig.calls).toEqual(['events(reset)', 'loadHistory(s-1)', 'events(session-end)', 'state(viewing)'])
    expect(rig.errors.map((e) => e.message)).toEqual(['load-history：磁碟壞了'])
  })
})

describe('createConversation:session 切換(照搬 bridge 的順序)', () => {
  it('idle 的 startNew:reset 後開新 query', async () => {
    const rig = setup()
    rig.core.activate()
    rig.calls.length = 0
    rig.core.startNew()
    await flush()
    expect(rig.calls).toEqual(['events(reset)', 'start(-,-)', 'state(live)'])
  })

  it('live 的 openHistory:interrupt、teardown、reset、讀歷史', async () => {
    const rig = setup({ withViewTools: true })
    await liveBusy(rig)
    rig.core.openHistory('s-2')
    await flush()
    expect(rig.calls).toEqual([
      'abortPending(對話已結束)',
      'interrupt',
      'abortPending(對話已結束)',
      'teardown',
      'events(reset)',
      'loadHistory(s-2)',
      'events(user-text,session-end)',
      'state(viewing)',
    ])
  })

  it('viewing 的 userInput:用 resume 開新 query,不 reset', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.core.activate()
    await flush()
    rig.calls.length = 0
    rig.core.userInput('續')
    await flush()
    expect(rig.calls).toEqual(['start(s-1,續)', 'state(live)'])
  })

  it('live 的 userInput 直接 send', async () => {
    const rig = setup()
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.calls.length = 0
    rig.core.userInput('嗨')
    await flush()
    expect(rig.calls).toEqual(['state(live)', 'send(嗨)'])
  })

  it('send 失敗:記錄並補「已收尾」錯誤卡', async () => {
    const rig = setup()
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.failSend()
    rig.calls.length = 0
    rig.core.userInput('x')
    await flush()
    expect(rig.calls).toEqual(['state(live)', 'send(x)', 'events(session-end)'])
    expect(rig.errors).toHaveLength(1)
    expect(rig.errors[0]?.message).toContain('已收尾')
  })

  it('session-start 事件:更新狀態並回報 onSessionStarted', async () => {
    const rig = setup()
    await liveBusy(rig)
    expect(rig.core.sessionState()).toEqual({ kind: 'live', sessionId: 's-9' })
    expect(rig.started).toEqual(['s-9'])
  })

  it('userInput 的 pending 鏈拋錯:只記錄,鏈不會停在 rejected', async () => {
    const rig = setup()
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.throwSend()
    rig.calls.length = 0
    rig.core.userInput('炸')
    await flush()
    expect(rig.errors.map((e) => e.message)).toEqual(['agent:input：送出爆炸'])
    // 鏈還活著:下一個 action 的 effects 照跑。鏈若停在 rejected,start-query 會被整段
    // 跳過(沒有 start(-,-)),而且會多一筆 effects(start-new) 的錯誤。
    rig.core.startNew()
    await flush()
    expect(rig.calls).toContain('start(-,-)')
    expect(rig.errors.map((e) => e.message)).toEqual(['agent:input：送出爆炸'])
  })
})

describe('createConversation:前景／背景與 sleep', () => {
  it('從未啟用的核心收到背景輸入後停用，等回合結束才休眠', async () => {
    const rig = setup()
    rig.core.userInput('背景提問')
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual(['start(-,背景提問)'])
    expect(rig.core.isActive()).toBe(false)
    expect(rig.core.isBusy()).toBe(true)
    rig.hostDeps().onBatch([START_S9, END_OK])
    await flush()
    expect(rig.calls).toEqual(['start(-,背景提問)', 'interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-9' })
    expect(rig.errors).toEqual([])
    await rig.core.dispose()
  })

  it('從未 activate 的既有對話收到輸入直接 resume，一次送出並保持背景', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.core.userInput('背景提問')
    await flush()
    expect(rig.calls).toEqual(['start(s-1,背景提問)'])
    expect(rig.core.isActive()).toBe(false)
    expect(rig.core.isBusy()).toBe(true)
    expect(rig.core.sessionState()).toEqual({ kind: 'live', sessionId: 's-1' })
    expect(rig.errors).toEqual([])
    await rig.core.dispose()
  })

  it('背景時不推事件;切回前景重播 reset 之後的 log', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    rig.hostDeps().onBatch([say('背景產生的')])
    expect(rig.calls).toEqual([])
    rig.core.activate()
    expect(rig.calls).toEqual(['events(reset,session-start,user-text)', 'state(live)'])
  })

  it('回合進行中切到背景:等 session-end 才 sleep,切回來重讀 transcript', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual([])
    expect(rig.core.sessionState()).toEqual({ kind: 'live', sessionId: 's-9' })
    rig.hostDeps().onBatch([END_OK])
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-9' })
    rig.calls.length = 0
    rig.core.activate()
    await flush()
    expect(rig.calls).toEqual([
      'events(reset)',
      'loadHistory(s-9)',
      'events(user-text,session-end)',
      'state(viewing)',
    ])
  })

  it('背景回合結束前排入的輸入在 sleep 後 resume 並送出一次', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    rig.core.userInput('同伴提問')
    rig.hostDeps().onBatch([END_OK])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-9' })
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown', 'start(s-9,同伴提問)'])
    expect(rig.core.isBusy()).toBe(true)
    rig.core.activate()
    expect(rig.errors).toEqual([])
    expect(rig.events.filter((e) => e.kind === 'session-end' && e.isError)).toEqual([])
  })

  it('重試的 query 仍收尾時只記一則錯誤 session-end，不再重試', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.endOnStart()
    rig.core.deactivate()
    rig.core.userInput('同伴提問')
    rig.hostDeps().onBatch([END_OK])
    await flush()
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown', 'start(s-9,同伴提問)'])
    expect(rig.errors).toHaveLength(1)
    expect(rig.core.isBusy()).toBe(false)
    rig.core.activate()
    expect(rig.events.filter((e) => e.kind === 'session-end' && e.isError)).toEqual([
      { kind: 'session-end', isError: true, errorMessage: '這則輸入未送出（session 已切換）：同伴提問' },
    ])
  })

  it('沒有回合進行中切到背景:立刻 sleep', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.hostDeps().onBatch([END_OK])
    await flush()
    rig.calls.length = 0
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-9' })
  })

  it('還沒拿到 session id 就切到背景:sleep 回 idle', async () => {
    const rig = setup()
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.calls.length = 0
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
  })

  it('背景時 query 自己結束:轉 idle,不再等 session-end', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    rig.hostDeps().onEnded()
    await flush()
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
    rig.core.activate()
    expect(rig.calls).toEqual(['events(reset,session-start)', 'state(idle)'])
  })

  it('idle 或 viewing 時 deactivate 不發任何 effect', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.core.activate()
    await flush()
    rig.calls.length = 0
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual([])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-1' })
  })

  it('startNew 清掉回合進行中的記號:接著切到背景會立刻 sleep', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.startNew()
    await flush()
    rig.calls.length = 0
    rig.core.deactivate()
    await flush()
    // busy 沒清掉的話這裡只會記下 sleepPending,一個 effect 都不會發。
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
  })

  it('startNew 與 openHistory 清掉等待中的 sleep:回合結束不會收掉新的 query', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    rig.core.startNew()
    await flush()
    rig.calls.length = 0
    // 這一筆 session-end 屬於新開的 query。sleepPending 沒清掉的話它會觸發 sleep,
    // 把剛開起來的 query 連同狀態一起收掉。
    rig.hostDeps().onBatch([END_OK])
    await flush()
    expect(rig.calls).toEqual([])
    expect(rig.core.sessionState()).toEqual({ kind: 'live' })

    const viewer = setup()
    await liveBusy(viewer)
    viewer.core.deactivate()
    viewer.core.openHistory('s-2')
    await flush()
    viewer.calls.length = 0
    viewer.hostDeps().onBatch([END_OK])
    await flush()
    expect(viewer.calls).toEqual([])
    expect(viewer.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-2' })
  })
})

describe('createConversation:批准', () => {
  it('前景直接送 ask;回覆後 promise 了結', async () => {
    const rig = setup()
    await liveBusy(rig)
    const outcome = rig.hostDeps().requestApproval(ask('t1'))
    expect(rig.calls).toEqual(['ask(t1)'])
    expect(rig.pendingCounts).toEqual([1])
    rig.core.approvalReply(rig.asks[0]?.requestId ?? '', 'allow')
    await expect(outcome).resolves.toEqual({ decision: 'allow' })
  })

  it('approvalReply 找不到 requestId 只記錄', () => {
    const rig = setup()
    rig.core.approvalReply('nope', 'allow')
    expect(rig.errors.map((e) => e.message)).toEqual(['agent:approval:reply：找不到 nope，可能已逾時'])
  })

  it('query 自己結束時等待中的批准一起 deny,不會留到下次 activate', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ask('t5'))
    expect(rig.core.pendingApprovals()).toBe(1)
    rig.hostDeps().onEnded()
    await flush()
    await expect(outcome).resolves.toEqual({ decision: 'deny', reason: '對話已結束' })
    expect(rig.core.pendingApprovals()).toBe(0)
    expect(rig.pendingCounts.at(-1)).toBe(0)
    rig.calls.length = 0
    rig.core.activate()
    expect(rig.calls.some((call) => call.startsWith('ask('))).toBe(false)
  })
})

describe('createConversation:handoff 與 dispose', () => {
  it('沒有 view tools 時 handoffDone 只記錄', () => {
    const rig = setup()
    rig.core.handoffDone('h1')
    expect(rig.errors.map((e) => e.message)).toEqual(['收到 handoff:done 但沒有 view tools'])
  })

  it('有 view tools 時轉交 handoffDone', () => {
    const rig = setup({ withViewTools: true })
    rig.core.handoffDone('h1')
    expect(rig.calls).toEqual(['handoffDone(h1)'])
  })

  it('dispose:live 收尾、等待中的批准 deny、之後不再推 sink', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ask('t4'))
    await rig.core.dispose()
    expect(rig.calls).toEqual(['ask(t4)', `settled(${rig.asks[0]!.requestId})`, 'interrupt', 'teardown'])
    await expect(outcome).resolves.toEqual({ decision: 'deny', reason: '視窗已關閉' })
    rig.core.activate()
    expect(rig.calls).toEqual(['ask(t4)', `settled(${rig.asks[0]!.requestId})`, 'interrupt', 'teardown'])
  })

  it('dispose:idle 時等待中的批准也要 deny', async () => {
    const rig = setup({ approvalTimeoutMs: null })
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.hostDeps().onEnded()
    await flush()
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ask('t6'))
    expect(rig.core.pendingApprovals()).toBe(1)
    await vi.advanceTimersByTimeAsync(3_600_000)
    const stillPending = await Promise.race([outcome, Promise.resolve('pending')])
    expect(stillPending).toBe('pending')
    await rig.core.dispose()
    // idle 的 window-closed 沒有 effects,靠 dispose 自己收才不會把 ask 永遠掛著。
    await expect(outcome).resolves.toEqual({ decision: 'deny', reason: '視窗已關閉' })
    expect(rig.core.pendingApprovals()).toBe(0)
    expect(rig.pendingCounts.at(-1)).toBe(0)
  })

  it('dispose:viewing 時等待中的批准也要 deny', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.core.activate()
    await flush()
    rig.core.userInput('續')
    await flush()
    rig.core.openHistory('s-2')
    await flush()
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-2' })
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ask('t7'))
    expect(rig.core.pendingApprovals()).toBe(1)
    await rig.core.dispose()
    await expect(outcome).resolves.toEqual({ decision: 'deny', reason: '視窗已關閉' })
    expect(rig.core.pendingApprovals()).toBe(0)
    expect(rig.pendingCounts.at(-1)).toBe(0)
  })
})

describe('busy', () => {
  it('一開始不 busy;userInput 之後 busy,session-end 之後不 busy;只在改變時通知', async () => {
    const rig = setup()
    expect(rig.core.isBusy()).toBe(false)
    rig.core.userInput('hi')
    await flush()
    expect(rig.core.isBusy()).toBe(true)
    rig.hostDeps().onBatch([START_S9, say('hi')])
    expect(rig.core.isBusy()).toBe(true)
    rig.hostDeps().onBatch([END_OK])
    expect(rig.core.busyStartedAt()).toBeNull()
    expect(rig.core.isBusy()).toBe(false)
    expect(rig.busyChanges).toEqual([true, false])
  })

  it('startNew 與 openHistory 都把 busy 清掉', async () => {
    const rig = setup()
    rig.core.userInput('hi')
    await flush()
    rig.core.startNew()
    expect(rig.core.isBusy()).toBe(false)
    rig.core.userInput('again')
    await flush()
    rig.core.openHistory('s-old')
    expect(rig.core.isBusy()).toBe(false)
    expect(rig.busyChanges).toEqual([true, false, true, false])
  })

  it('host onEnded 也把 busy 清掉', async () => {
    const rig = setup()
    rig.core.userInput('hi')
    await flush()
    rig.hostDeps().onEnded()
    expect(rig.core.isBusy()).toBe(false)
  })
})

describe('批准不再扣住(D2 規格 §11)', () => {
  it('背景時的批准照樣送出去,不扣在主行程', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ASK)
    await flush()
    expect(rig.asks).toHaveLength(1)
    expect(rig.core.pendingApprovals()).toBe(1)
    rig.core.approvalReply(rig.asks[0]!.requestId, 'allow')
    expect(await outcome).toEqual({ decision: 'allow' })
    expect(rig.core.pendingApprovals()).toBe(0)
  })

  it('待批准數量變動時通知一次', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    void rig.hostDeps().requestApproval(ASK)
    await flush()
    rig.core.approvalReply(rig.asks[0]!.requestId, 'deny')
    await flush()
    expect(rig.pendingCounts).toEqual([1, 0])
  })

  it('切到前景不會把同一筆批准再送一次', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    void rig.hostDeps().requestApproval(ASK)
    await flush()
    rig.core.activate()
    await flush()
    expect(rig.asks).toHaveLength(1)
  })

  it('換 session 時把在等的批准全部拒絕', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ASK)
    await flush()
    rig.core.startNew()
    await flush()
    expect((await outcome).decision).toBe('deny')
    expect(rig.core.pendingApprovals()).toBe(0)
  })
})


it('背景 live 結束回報當下 session,歷史與 replay 不重複回報', async () => {
  const ended = vi.fn()
  const r = setup({ onSessionEnded: ended })
  await liveBusy(r)
  r.core.deactivate()
  const event: Event = { kind: 'session-end', isError: false, costUsd: 0.12, numTurns: 3 }
  r.hostDeps().onBatch([event])
  await flush()
  expect(ended).toHaveBeenCalledExactlyOnceWith('s-9', event)
  r.core.activate()
  await flush()
  r.core.replay()
  expect(ended).toHaveBeenCalledTimes(1)
})

it.each(['session-end', 'onEnded'] as const)('%s 通知閒置時同步投遞的新回合結束後才休眠', async (ending) => {
  let injected = false
  const rig = setup({ onBusyChange: (busy) => {
    if (busy || injected) return
    injected = true
    deliver('第二則提問')
  } })
  const deliver = (text: string): void => {
    rig.core.userInput(text)
    rig.core.deactivate()
  }
  deliver('第一則提問')
  await flush()
  rig.hostDeps().onBatch([START_S9])
  expect(rig.core.isBusy()).toBe(true)
  if (ending === 'session-end') rig.hostDeps().onBatch([END_OK])
  else rig.hostDeps().onEnded()
  expect(rig.core.sessionState()).toEqual({ kind: 'live', sessionId: 's-9' })
  await flush()
  expect(rig.calls).toEqual(['start(-,第一則提問)', 'send(第二則提問)'])
  expect(rig.core.isBusy()).toBe(true)
  expect(rig.core.isActive()).toBe(false)
  rig.hostDeps().onBatch([END_OK])
  await flush()
  expect(rig.calls).toEqual(['start(-,第一則提問)', 'send(第二則提問)', 'interrupt', 'teardown'])
  expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-9' })
  expect(rig.core.isBusy()).toBe(false)
  expect(rig.errors).toEqual([])
  await rig.core.dispose()
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
  rig.hostDeps().onBatch([{ kind: 'message-start', messageId: 'm2' }])
  expect(rig.core.turnProduced()).toBe(false)
  rig.hostDeps().onBatch([{ kind: 'text-delta', messageId: 'm', index: 0, text: '回答' }])
  expect(rig.core.turnProduced()).toBe(true)
  expect(produced).toHaveBeenCalledTimes(1)
  rig.hostDeps().onBatch([{ kind: 'message-start', messageId: 'm2' }])
  rig.hostDeps().onBatch([{ kind: 'text-delta', messageId: 'm', index: 0, text: '回答' }])
  expect(rig.core.turnProduced()).toBe(true)
  expect(produced).toHaveBeenCalledTimes(1)
  rig.hostDeps().onBatch([END_OK])
  rig.core.userInput('下一輪')
  expect(rig.core.turnProduced()).toBe(false)
  rig.core.activate()
  rig.core.replay()
  expect(rig.core.turnProduced()).toBe(false)
  await flush()
  await rig.core.dispose()
})

it.each<Event>([
  { kind: 'block-start', messageId: 'm', index: 0, blockType: 'tool_use' },
  { kind: 'text-delta', messageId: 'm', index: 0, text: '回答' },
  { kind: 'thinking-delta', messageId: 'm', index: 0, text: '思考' },
  { kind: 'tool-input-delta', messageId: 'm', index: 0, partialJson: '{}' },
])('首筆內容事件 $kind 會標記產出，同回合追加輸入不重設', async (event) => {
  const rig = setup()
  rig.core.userInput('問題')
  await flush()
  rig.hostDeps().onBatch([event])
  expect(rig.core.turnProduced()).toBe(true)
  rig.core.userInput('追加')
  expect(rig.core.turnProduced()).toBe(true)
  await flush()
  await rig.core.dispose()
})
