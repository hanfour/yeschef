import { describe, it, expect } from 'vitest'
import type { Event } from '../src/shared/events.js'
import {
  DEFAULT_MERGE_CONFIG,
  INITIAL_MERGE_STATE,
  INTERRUPT_TIMEOUT_MS,
  TEARDOWN_TIMEOUT_MS,
  createAgentHost,
  createEventMerger,
  mergeAccept,
  mergeFlush,
  mergeTick,
  mergeWakeAt,
  toPermissionResult,
  type CanUseToolFn,
  type MergeConfig,
  type MergeState,
  type QueryHandle,
  type UserTurn,
} from '../src/main/agent-host.js'
import type { ApprovalAsk } from '../src/main/approval.js'
import type { SessionOptions } from '../src/main/session-args.js'
import { manualClock } from './helpers/manual-clock.js'

// merger 純函式（mergeAccept／mergeTick／mergeFlush／toPermissionResult）的測試在 tests/event-merge.test.ts

/** 產生可辨識的事件序列：text 就是序號，用來斷言順序與筆數。與 event-merge.test.ts 同款，兩檔各自持有以免測試互相 import。 */
function seq(n: number, offset = 0): readonly Event[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'text-delta' as const,
    messageId: 'm-1',
    index: 0,
    text: String(offset + i),
  }))
}

const CFG: MergeConfig = { frameMs: 16, maxBatchSize: 4 }

/** 把一連串批次攤平，用來跟輸入序列逐一比對。與 event-merge.test.ts 同款，兩檔各自持有以免測試互相 import。 */
function flat(batches: readonly (readonly Event[])[]): string[] {
  return batches.flatMap((b) => b.map((e) => (e.kind === 'text-delta' ? e.text : e.kind)))
}

describe('createEventMerger（合併器外層）', () => {
  it('滿一幀才把批次交出去，且只交一次', () => {
    const { clock, advance } = manualClock()
    const batches: (readonly Event[])[] = []
    const merger = createEventMerger({ onBatch: (b) => batches.push(b), config: CFG, clock })
    merger.accept(seq(2))
    expect(batches).toEqual([])
    advance(16)
    expect(flat(batches)).toEqual(['0', '1'])
    advance(1000)
    expect(batches).toHaveLength(1)
  })

  it('超過批次上限時不等計時器，同一個 tick 就送出滿批', () => {
    const { clock } = manualClock()
    const batches: (readonly Event[])[] = []
    const merger = createEventMerger({ onBatch: (b) => batches.push(b), config: CFG, clock })
    merger.accept(seq(9))
    expect(batches.map((b) => b.length)).toEqual([4, 4])
  })

  it('flush 立刻交出殘留事件，dispose 之後不再有任何回呼', () => {
    const { clock, advance } = manualClock()
    const batches: (readonly Event[])[] = []
    const merger = createEventMerger({ onBatch: (b) => batches.push(b), config: CFG, clock })
    merger.accept(seq(2))
    merger.flush()
    expect(flat(batches)).toEqual(['0', '1'])
    merger.dispose()
    merger.accept(seq(2, 9))
    advance(1000)
    expect(batches).toHaveLength(1)
  })
})

/** 假的 query()：可控制何時吐訊息、何時結束，並記錄 interrupt／close 被叫了幾次。 */
function createFakeQuery(): {
  handle: QueryHandle
  emit: (msg: unknown) => void
  end: () => void
  /** 讓之後的 `interrupt()` 回一個永不 resolve 的 promise，用來測保險絲。 */
  hangInterrupt: () => void
  /** 讓 `close()` 不結束迭代器，造出「query 收不掉」的處境。 */
  hangClose: () => void
  stats: { interrupts: number; closes: number }
} {
  const queued: unknown[] = []
  let waiting: ((r: IteratorResult<unknown>) => void) | null = null
  let ended = false
  const stats = { interrupts: 0, closes: 0 }
  let interruptHangs = false
  let closeHangs = false

  const end = (): void => {
    if (ended) return
    ended = true
    const w = waiting
    waiting = null
    if (w) w({ value: undefined, done: true })
  }
  const emit = (msg: unknown): void => {
    const w = waiting
    if (w) {
      waiting = null
      w({ value: msg, done: false })
      return
    }
    queued.push(msg)
  }
  const handle: QueryHandle = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (queued.length > 0) return Promise.resolve({ value: queued.shift(), done: false })
        if (ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<unknown>>((resolve) => {
          waiting = resolve
        })
      },
    }),
    interrupt: () => {
      stats.interrupts += 1
      return interruptHangs ? new Promise<unknown>(() => {}) : Promise.resolve()
    },
    close: () => {
      stats.closes += 1
      if (!closeHangs) end()
    },
  }
  return {
    handle,
    emit,
    end,
    hangInterrupt: () => {
      interruptHangs = true
    },
    hangClose: () => {
      closeHangs = true
    },
    stats,
  }
}

const MESSAGE_START = {
  type: 'stream_event',
  event: { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5' } },
}
const TEXT_DELTA = {
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
}

const OPTIONS: SessionOptions = {
  cwd: '/p',
  permissionMode: 'default',
  includePartialMessages: true,
  settingSources: ['project', 'local'],
}

/**
 * 裁決 6 之後 host 是長生命週期物件：建構不開 query，`start()` 才開。
 * 這個 helper 建好之後直接 `start()`，讓原本那批測試的前提維持不變。
 */
function setupHost(overrides?: {
  requestApproval?: (ask: ApprovalAsk) => Promise<{ decision: 'allow' | 'deny'; reason?: string }>
  autoStart?: false
  /** 契約 §11.2：政策放行。沒給時等同 host 沒收到這個 dep。 */
  autoAllow?: (toolName: string, toolUseId: string) => boolean
}) {
  const fq = createFakeQuery()
  const { clock, advance } = manualClock()
  const batches: (readonly Event[])[] = []
  const errors: Error[] = []
  const resumes: (string | undefined)[] = []
  let ended = 0
  let prompt: AsyncIterable<UserTurn> | null = null
  let canUseTool: CanUseToolFn | null = null

  const host = createAgentHost({
    queryFn: (params) => {
      prompt = params.prompt
      canUseTool = params.options.canUseTool
      return fq.handle
    },
    sessionOptions: (resume) => {
      resumes.push(resume)
      return resume === undefined ? OPTIONS : { ...OPTIONS, resume }
    },
    requestApproval:
      overrides?.requestApproval ?? (() => Promise.resolve({ decision: 'allow' as const })),
    onBatch: (b) => batches.push(b),
    onError: (e) => errors.push(e),
    onEnded: () => {
      ended += 1
    },
    merge: CFG,
    clock,
    autoAllow: overrides?.autoAllow,
  })
  if (overrides?.autoStart !== false) host.start()
  return {
    host,
    fq,
    advance,
    batches,
    errors,
    resumes,
    ended: () => ended,
    prompt: () => prompt,
    canUseTool: () => canUseTool,
  }
}

describe('createAgentHost：事件路徑', () => {
  it('游標由 host 持有：message_start 之後的 delta 帶得到 messageId', async () => {
    const s = setupHost()
    s.fq.emit(MESSAGE_START)
    s.fq.emit(TEXT_DELTA)
    s.fq.end()
    await s.host.teardown()

    const events = s.batches.flat()
    const delta = events.find((e) => e.kind === 'text-delta')
    expect(delta).toBeDefined()
    expect(delta && 'messageId' in delta && delta.messageId).toBe('msg_1')
  })

  it('teardown 會把還在緩衝裡的事件送完，一筆都不吞', async () => {
    const s = setupHost()
    s.fq.emit(MESSAGE_START)
    s.fq.emit(TEXT_DELTA)
    s.fq.end()
    expect(s.batches).toEqual([]) // 還沒滿一幀
    await s.host.teardown()
    expect(s.batches.flat().length).toBeGreaterThan(0)
  })

  it('teardown 之後不再產生任何批次', async () => {
    const s = setupHost()
    s.fq.emit(MESSAGE_START)
    s.fq.end()
    await s.host.teardown()
    const count = s.batches.length
    s.advance(10_000)
    expect(s.batches).toHaveLength(count)
  })

  it('認不出來的訊息走 unknown Event，不被丟棄', async () => {
    const s = setupHost()
    s.fq.emit({ type: '從未見過的型別' })
    s.fq.end()
    await s.host.teardown()
    expect(s.batches.flat().some((e) => e.kind === 'unknown')).toBe(true)
  })
})

describe('createAgentHost：輸入與收尾', () => {
  it('附件初始輸入與續接都以原生圖片及文件內容交付，畫面只顯示檔名', async () => {
    const s = setupHost({ autoStart: false })
    const attachments = [{ name: 'photo.png', path: '/copy/photo.png', kind: 'image' as const, mime: 'image/png' as const, data: 'aW1hZ2U=' }, { name: 'notes.md', path: '/copy/notes.md', kind: 'text' as const, mime: 'application/octet-stream' as const, text: '# private document contents' }]
    s.host.start('session', '', attachments)
    const first = await s.prompt()![Symbol.asyncIterator]().next()
    expect(first.value.message.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('# private document contents') }), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }])
    expect(s.host.send('繼續', attachments)).toBe(true)
    const second = await s.prompt()![Symbol.asyncIterator]().next()
    expect(second.value.message.content[1]).toMatchObject({ type: 'image' })
    s.fq.end(); await s.host.teardown()
    expect(s.batches.flat().filter(e => e.kind === 'user-text')).toEqual([{ kind: 'user-text', text: '附件：photo.png、notes.md' }, { kind: 'user-text', text: '繼續\n\n附件：photo.png、notes.md' }])
  })

  it('send 把文字包成 user turn 推進 prompt 串流', async () => {
    const s = setupHost()
    expect(s.host.send('你好')).toBe(true)
    const iterator = s.prompt()![Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({
      type: 'user',
      message: { role: 'user', content: '你好' },
      parent_tool_use_id: null,
    })
    s.fq.end()
    await s.host.teardown()
  })

  it('start 的 initialInput 直接排進串流，resume 進得了 options（viewing → live 的第一則）', async () => {
    const s = setupHost({ autoStart: false })
    s.host.start('s-1', '接著問')
    expect(s.resumes).toEqual(['s-1'])
    const first = await s.prompt()![Symbol.asyncIterator]().next()
    expect(first.value).toMatchObject({ message: { content: '接著問' } })
    s.fq.end()
    await s.host.teardown()
  })

  it('start 之前 send 回 false：沒有 query 就沒有地方可送', () => {
    const s = setupHost({ autoStart: false })
    expect(s.host.send('太早了')).toBe(false)
  })

  it('已有活躍 query 時再 start 是接線錯誤，回報而不是偷偷開第二條', () => {
    const s = setupHost()
    s.host.start()
    expect(s.errors.map((e) => e.message).join()).toMatch(/已有活躍 query/)
  })

  it('query 自己走完時通知 onEnded（裁決 6：bridge 據此送 session-ended）', async () => {
    const s = setupHost()
    s.fq.end()
    await new Promise((r) => setTimeout(r, 0))
    expect(s.ended()).toBe(1)
    // 自己結束的 query 不算被收掉，teardown 不會重複收
    await s.host.teardown()
    expect(s.fq.stats.closes).toBe(0)
  })

  it('teardown 收掉的 query 不觸發 onEnded（那是我們收的，不是它自己結束的）', async () => {
    const s = setupHost()
    await s.host.teardown()
    expect(s.ended()).toBe(0)
  })

  it('teardown 之後可以再 start 一條新的 query', async () => {
    const s = setupHost()
    await s.host.teardown()
    s.host.start('s-2')
    expect(s.resumes).toEqual([undefined, 's-2'])
    expect(s.host.send('新的一輪')).toBe(true)
  })

  it('teardown 呼叫 close，並等到事件迴圈真的結束才 resolve', async () => {
    const s = setupHost()
    await s.host.teardown()
    expect(s.fq.stats.closes).toBe(1)
  })

  it('teardown 之後 send 回 false，不會再有東西進 SDK', async () => {
    const s = setupHost()
    await s.host.teardown()
    expect(s.host.send('太晚了')).toBe(false)
  })

  it('teardown 可以重複呼叫，只真的收一次', async () => {
    const s = setupHost()
    await Promise.all([s.host.teardown(), s.host.teardown()])
    await s.host.teardown()
    expect(s.fq.stats.closes).toBe(1)
  })

  it('interrupt 轉呼叫 query.interrupt，且不收掉 query（之後還能繼續送輸入）', async () => {
    const s = setupHost()
    await s.host.interrupt()
    expect(s.fq.stats.interrupts).toBe(1)
    expect(s.fq.stats.closes).toBe(0)
    expect(s.host.send('繼續')).toBe(true)
    s.fq.end()
    await s.host.teardown()
  })

  it('teardown 之後 interrupt 是無害的 no-op', async () => {
    const s = setupHost()
    await s.host.teardown()
    await s.host.interrupt()
    expect(s.fq.stats.interrupts).toBe(0)
  })

  it('teardown 逾時 2 秒強制放行，不讓關視窗卡在收不掉的 query', async () => {
    const s = setupHost()
    // close() 不結束迭代器，pump 因此永遠跑不完：這就是「query 收不掉」。
    s.fq.hangClose()

    let settled = false
    const p = s.host.teardown().then(() => {
      settled = true
    })
    // 多跑幾輪微任務，確認不是因為還沒排到才看起來沒 resolve。
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(settled).toBe(false)
    expect(s.errors).toEqual([])

    s.advance(TEARDOWN_TIMEOUT_MS)
    await p

    expect(settled).toBe(true)
    expect(s.errors.map((e) => e.message).join()).toMatch(/強制收尾/)
  })

  it('interrupt 逾時 2 秒仍然 resolve，並記錄一筆錯誤讓後面的收尾照跑', async () => {
    const s = setupHost()
    s.fq.hangInterrupt()

    let settled = false
    const p = s.host.interrupt().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    s.advance(INTERRUPT_TIMEOUT_MS)
    await p

    expect(settled).toBe(true)
    expect(s.errors.map((e) => e.message).join()).toMatch(/interrupt 逾時/)
    s.fq.end()
    await s.host.teardown()
  })

  it('interrupt 及時回來時計時器被清掉，不會事後補一筆逾時錯誤', async () => {
    const s = setupHost()
    await s.host.interrupt()
    s.advance(INTERRUPT_TIMEOUT_MS * 10)
    expect(s.errors).toEqual([])
    s.fq.end()
    await s.host.teardown()
  })
})

/**
 * 修正 3（RESULTS 待辦第 2 列）：SDK 在 streaming input 模式下不會把我們 push 進去的
 * `UserTurn` 回送成 `user` 訊息，`start()`／`send()` 因此要各自合成一筆 `user-text`
 * 走 merger（不是直接 onBatch，理由同第 431 行附近的註解：排在前面的事件之後）。
 */
describe('createAgentHost：使用者輸入合成 user-text（修正 3）', () => {
  it('start(undefined, 初始輸入) 合成的 user-text 排在任何 SDK 事件之前', async () => {
    const s = setupHost({ autoStart: false })
    s.host.start(undefined, '第一句')
    s.fq.emit(MESSAGE_START)
    s.fq.emit(TEXT_DELTA)
    s.fq.end()
    await s.host.teardown()

    const events = s.batches.flat()
    expect(events[0]).toEqual({ kind: 'user-text', text: '第一句' })
    expect(events.some((e) => e.kind === 'text-delta')).toBe(true)
  })

  it('start() 後 send() 合成對應的 user-text，且 send 回 true', async () => {
    const s = setupHost()
    expect(s.host.send('第二句')).toBe(true)
    s.fq.end()
    await s.host.teardown()

    const events = s.batches.flat()
    expect(events).toContainEqual({ kind: 'user-text', text: '第二句' })
  })

  it('teardown 之後 send 回 false，不再合成新的 user-text', async () => {
    const s = setupHost()
    await s.host.teardown()
    const before = s.batches.flat().length

    expect(s.host.send('太晚了')).toBe(false)

    const events = s.batches.flat()
    expect(events).toHaveLength(before)
    expect(events.some((e) => e.kind === 'user-text' && e.text === '太晚了')).toBe(false)
  })
})

/** SDK options 的最小形狀：裁決 28 之後 `toolUseID` 是必填的。 */
const OPTS = { toolUseID: 'toolu_1' }

describe('createAgentHost：canUseTool', () => {
  it('allow 轉成 behavior allow，input 原樣帶回', async () => {
    const s = setupHost()
    const result = await s.canUseTool()!('Bash', { command: 'ls' }, OPTS)
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    s.fq.end()
    await s.host.teardown()
  })

  it('deny 轉成 behavior deny，理由帶進 message', async () => {
    const s = setupHost({
      requestApproval: () => Promise.resolve({ decision: 'deny' as const, reason: '批准逾時' }),
    })
    expect(await s.canUseTool()!('Bash', { command: 'rm -rf /' }, OPTS)).toEqual({
      behavior: 'deny',
      message: '批准逾時',
    })
    s.fq.end()
    await s.host.teardown()
  })

  it('批准流程本身丟錯時 deny 並回報，不讓 canUseTool 的 promise 掛死', async () => {
    const s = setupHost({ requestApproval: () => Promise.reject(new Error('註冊表壞了')) })
    const result = await s.canUseTool()!('Bash', {}, OPTS)
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(s.errors.map((e) => e.message).join()).toMatch(/註冊表壞了/)
    s.fq.end()
    await s.host.teardown()
  })

  it('裁決 11／16／28：toolUseId、toolName、input、title、displayName 併成一個 ask 送進註冊表', async () => {
    const seen: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        seen.push(ask)
        return Promise.resolve({ decision: 'allow' as const })
      },
    })
    await s.canUseTool()!('Bash', { command: 'ls' }, {
      toolUseID: 'toolu_ls',
      title: 'Claude 想執行 ls',
      displayName: '執行指令',
    })
    expect(seen).toEqual([
      {
        toolName: 'Bash',
        executionCwd: '/p',
        validateEvidence: expect.any(Function),
        input: { command: 'ls' },
        toolUseId: 'toolu_ls',
        title: 'Claude 想執行 ls',
        displayName: '執行指令',
      },
    ])
    s.fq.end()
    await s.host.teardown()
  })

  it('裁決 28：兩次呼叫各自帶自己的 toolUseId，不共用', async () => {
    const seen: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        seen.push(ask)
        return Promise.resolve({ decision: 'allow' as const })
      },
    })
    await s.canUseTool()!('Bash', {}, { toolUseID: 'toolu_a' })
    await s.canUseTool()!('Read', {}, { toolUseID: 'toolu_b' })
    expect(seen.map((a) => a.toolUseId)).toEqual(['toolu_a', 'toolu_b'])
    s.fq.end()
    await s.host.teardown()
  })
})

describe('契約 §11.2：autoAllow 讓政策放行的工具跳過批准流程', () => {
  it('回 true 時直接 allow，requestApproval 完全沒被呼叫', async () => {
    const asked: ApprovalAsk[] = []
    const s = setupHost({
      // 刻意回 deny：autoAllow 若被移到批准流程之後才問，結果會變成 deny。
      requestApproval: (ask) => {
        asked.push(ask)
        return Promise.resolve({ decision: 'deny' as const, reason: '不該走到這裡' })
      },
      autoAllow: () => true,
    })
    const result = await s.canUseTool()!(
      'mcp__yeschef__view_click',
      { ref: 's1-e2' },
      { toolUseID: 'toolu_click' }
    )
    expect(result).toEqual({ behavior: 'allow', updatedInput: { ref: 's1-e2' } })
    expect(asked).toEqual([])
    expect(s.errors).toEqual([])
    s.fq.end()
    await s.host.teardown()
  })

  it('autoAllow 拿得到工具名稱與這一次的 toolUseId', async () => {
    const seen: [string, string][] = []
    const s = setupHost({
      autoAllow: (name, id) => {
        seen.push([name, id])
        return name === 'mcp__yeschef__view_click'
      },
    })
    await s.canUseTool()!('mcp__yeschef__view_click', {}, { toolUseID: 'toolu_a' })
    await s.canUseTool()!('mcp__yeschef__view_eval', {}, { toolUseID: 'toolu_b' })
    expect(seen).toEqual([
      ['mcp__yeschef__view_click', 'toolu_a'],
      ['mcp__yeschef__view_eval', 'toolu_b'],
    ])
    s.fq.end()
    await s.host.teardown()
  })

  it('回 false 時走既有批准流程，結果由 requestApproval 決定', async () => {
    const asked: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        asked.push(ask)
        return Promise.resolve({ decision: 'deny' as const, reason: '使用者按了拒絕' })
      },
      autoAllow: () => false,
    })
    const result = await s.canUseTool()!(
      'mcp__yeschef__view_eval',
      { expression: '1' },
      { toolUseID: 'toolu_eval' }
    )
    expect(result).toEqual({ behavior: 'deny', message: '使用者按了拒絕' })
    expect(asked.map((a) => a.toolUseId)).toEqual(['toolu_eval'])

    s.fq.end()
    await s.host.teardown()
  })

  it('autoAllow 丟例外時視同 false：onError 收到，結果由批准流程決定', async () => {
    const asked: ApprovalAsk[] = []
    const s = setupHost({
      requestApproval: (ask) => {
        asked.push(ask)
        return Promise.resolve({ decision: 'allow' as const })
      },
      autoAllow: () => {
        throw new Error('政策表壞了')
      },
    })
    const result = await s.canUseTool()!('Bash', { command: 'ls' }, { toolUseID: 'toolu_x' })
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(asked.map((a) => a.toolName)).toEqual(['Bash'])
    expect(s.errors.map((e) => e.message).join()).toMatch(/政策表壞了/)
    s.fq.end()
    await s.host.teardown()
  })
})

describe('createAgentHost：錯誤不靜默', () => {
  it('事件迴圈丟錯時走 onError，且 teardown 仍然 resolve', async () => {
    const fq = createFakeQuery()
    const errors: Error[] = []
    const broken: QueryHandle = {
      ...fq.handle,
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('串流中斷')),
      }),
    }
    const host = createAgentHost({
      queryFn: () => broken,
      sessionOptions: () => OPTIONS,
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: () => {},
      onError: (e) => errors.push(e),
      onEnded: () => {},
    })
    host.start()
    await host.teardown()
    expect(errors.map((e) => e.message).join()).toMatch(/串流中斷/)
  })

  it('裁決 17：事件流中斷合成一筆 isError 的 session-end，走同一條 events 通道', async () => {
    const batches: (readonly Event[])[] = []
    const errors: Error[] = []
    let ended = 0
    const broken: QueryHandle = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('SDK 程序不見了')),
      }),
      interrupt: () => Promise.resolve(),
      close: () => {},
    }
    const host = createAgentHost({
      queryFn: () => broken,
      sessionOptions: () => OPTIONS,
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: (b) => batches.push(b),
      onError: (e) => errors.push(e),
      onEnded: () => {
        ended += 1
      },
    })
    host.start()
    await new Promise((r) => setTimeout(r, 0))

    const ends = batches.flat().filter((e) => e.kind === 'session-end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ isError: true, errorMessage: 'SDK 程序不見了' })
    // 錯誤仍然走 onError（不靜默），狀態機仍然收得到 onEnded（照常回 idle）
    expect(errors.map((e) => e.message).join()).toMatch(/SDK 程序不見了/)
    expect(ended).toBe(1)
    await host.teardown()
  })

  it('裁決 20：sessionOptions 組不出來時不開 query，合成 session-end 走錯誤卡片', () => {
    const batches: (readonly Event[])[] = []
    const errors: Error[] = []
    let queries = 0
    let ended = 0
    const host = createAgentHost({
      queryFn: () => {
        queries += 1
        throw new Error('不該開得成 query')
      },
      sessionOptions: () => {
        throw new Error('projectDir 不存在：/gone')
      },
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: (b) => batches.push(b),
      onError: (e) => errors.push(e),
      onEnded: () => {
        ended += 1
      },
    })
    host.start('s-gone')

    expect(queries).toBe(0)
    expect(batches).toHaveLength(1)
    const only = batches[0] ?? []
    expect(only).toHaveLength(1)
    const end = only[0]
    expect(end?.kind).toBe('session-end')
    expect(end && end.kind === 'session-end' && end.isError).toBe(true)
    expect(end && end.kind === 'session-end' && end.errorMessage).toContain('不存在')
    expect(errors.map((e) => e.message).join()).toMatch(/不存在/)
    expect(ended).toBe(1)
  })

  it('Ruling 9：queryFn 同步 throw 時合成錯誤 session-end 並回報 onEnded', () => {
    const batches: (readonly Event[])[] = []
    const errors: Error[] = []
    let ended = 0
    const host = createAgentHost({
      queryFn: () => {
        throw new Error('SDK CLI 不見了')
      },
      sessionOptions: () => OPTIONS,
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: (b) => batches.push(b),
      onError: (e) => errors.push(e),
      onEnded: () => {
        ended += 1
      },
    })
    host.start()

    expect(batches).toHaveLength(1)
    const only = batches[0] ?? []
    expect(only).toHaveLength(1)
    const end = only[0]
    expect(end?.kind).toBe('session-end')
    expect(end && end.kind === 'session-end' && end.isError).toBe(true)
    expect(end && end.kind === 'session-end' && end.errorMessage).toContain('SDK CLI 不見了')
    expect(errors.map((e) => e.message).join()).toMatch(/SDK CLI 不見了/)
    // onEnded 是關鍵：少了它狀態機停在 live，使用者看得到錯誤卻按不了下一步。
    expect(ended).toBe(1)
    // 沒有留下半條活躍 query：send 回 false，之後還 start 得起來。
    expect(host.send('之後的輸入')).toBe(false)
  })

  it('close 丟錯時回報但不影響 teardown 完成', async () => {
    const fq = createFakeQuery()
    const errors: Error[] = []
    const host = createAgentHost({
      queryFn: () => ({
        ...fq.handle,
        close: () => {
          fq.end()
          throw new Error('close 爆炸')
        },
      }),
      sessionOptions: () => OPTIONS,
      requestApproval: () => Promise.resolve({ decision: 'allow' as const }),
      onBatch: () => {},
      onError: (e) => errors.push(e),
      onEnded: () => {},
    })
    host.start()
    await host.teardown()
    expect(errors.map((e) => e.message).join()).toMatch(/close 爆炸/)
  })
})
