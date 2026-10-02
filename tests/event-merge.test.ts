import { describe, it, expect } from 'vitest'
import type { Event } from '../src/shared/events.js'
import {
  DEFAULT_MERGE_CONFIG,
  INITIAL_MERGE_STATE,
  mergeAccept,
  mergeFlush,
  mergeTick,
  mergeWakeAt,
  toPermissionResult,
  type MergeConfig,
  type MergeState,
} from '../src/main/agent-host.js'

/** 產生可辨識的事件序列：text 就是序號，用來斷言順序與筆數。與 agent-host.test.ts 同款，兩檔各自持有以免測試互相 import。 */
function seq(n: number, offset = 0): readonly Event[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'text-delta' as const,
    messageId: 'm-1',
    index: 0,
    text: String(offset + i),
  }))
}

const CFG: MergeConfig = { frameMs: 16, maxBatchSize: 4 }

/** 把一連串批次攤平，用來跟輸入序列逐一比對。與 agent-host.test.ts 同款，兩檔各自持有以免測試互相 import。 */
function flat(batches: readonly (readonly Event[])[]): string[] {
  return batches.flatMap((b) => b.map((e) => (e.kind === 'text-delta' ? e.text : e.kind)))
}

describe('mergeAccept：一幀之內累積，不立刻送', () => {
  it('未滿一幀也未滿批次上限時不產生批次', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(2), 1000, CFG)
    expect(r.batches).toEqual([])
    expect(r.state.pending).toHaveLength(2)
    expect(r.state.frameStartedAt).toBe(1000)
  })

  it('第二次 accept 不重設幀的起點（一直進來的事件不能無限延後送出）', () => {
    const a = mergeAccept(INITIAL_MERGE_STATE, seq(1), 1000, CFG)
    const b = mergeAccept(a.state, seq(1, 1), 1010, CFG)
    expect(b.state.frameStartedAt).toBe(1000)
  })

  it('空的 incoming 是 no-op，且不會開啟一個空幀', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, [], 1000, CFG)
    expect(r.batches).toEqual([])
    expect(r.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('不修改傳入的 state 與 incoming', () => {
    const incoming = seq(3)
    const state = INITIAL_MERGE_STATE
    const before = JSON.stringify({ state, incoming })
    mergeAccept(state, incoming, 1000, CFG)
    expect(JSON.stringify({ state, incoming })).toBe(before)
  })
})

describe('mergeAccept：批次上限', () => {
  it('達到上限時立刻切出滿批，餘數留在新的一幀', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(6), 1000, CFG)
    expect(r.batches).toHaveLength(1)
    expect(flat(r.batches)).toEqual(['0', '1', '2', '3'])
    expect(flat([r.state.pending])).toEqual(['4', '5'])
    expect(r.state.frameStartedAt).toBe(1000)
  })

  it('一次灌進大量事件會切成多個滿批，全部在同一次呼叫內送出', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(10), 1000, CFG)
    expect(r.batches.map((b) => b.length)).toEqual([4, 4])
    expect(r.state.pending).toHaveLength(2)
  })

  it('剛好整除時餘數為空，幀關閉', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(8), 1000, CFG)
    expect(r.batches.map((b) => b.length)).toEqual([4, 4])
    expect(r.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('不變量：任何一步之後 pending 都少於批次上限', () => {
    let state: MergeState = INITIAL_MERGE_STATE
    for (let i = 0; i < 40; i += 1) {
      state = mergeAccept(state, seq(3, i * 3), 1000 + i, CFG).state
      expect(state.pending.length).toBeLessThan(CFG.maxBatchSize)
    }
  })
})

describe('合併不得弄丟或改變事件順序', () => {
  it('任意 accept／tick 交錯之後，所有批次串接加上 pending 等於原始序列', () => {
    const chunks = [3, 1, 9, 2, 5, 1, 1, 14, 2]
    let state: MergeState = INITIAL_MERGE_STATE
    let emitted: string[] = []
    let produced = 0
    let now = 1000

    for (const size of chunks) {
      const a = mergeAccept(state, seq(size, produced), now, CFG)
      produced += size
      state = a.state
      emitted = [...emitted, ...flat(a.batches)]

      now += 20 // 超過 frameMs，下一次 tick 必定觸發
      const t = mergeTick(state, now, CFG)
      state = t.state
      emitted = [...emitted, ...flat(t.batches)]
    }
    const f = mergeFlush(state)
    emitted = [...emitted, ...flat(f.batches)]

    expect(emitted).toEqual(Array.from({ length: produced }, (_, i) => String(i)))
    expect(f.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('批次上限造成的切割不會改變相鄰事件的先後', () => {
    const r = mergeAccept(INITIAL_MERGE_STATE, seq(7), 1000, CFG)
    expect([...flat(r.batches), ...flat([r.state.pending])]).toEqual([
      '0', '1', '2', '3', '4', '5', '6',
    ])
    // 上一幀殘留的 pending 一定排在這一次的 incoming 之前。從空的 pending 出發
    // 測不到這件事：串接寫反了，空陣列接在哪一頭結果都一樣。
    const next = mergeAccept(r.state, seq(3, 7), 1020, CFG)
    expect([...flat(next.batches), ...flat([next.state.pending])]).toEqual([
      '4', '5', '6', '7', '8', '9',
    ])
  })

  it('合併只打包不加工：批次裡的事件物件與輸入是同一個參考', () => {
    const incoming = seq(2)
    const r = mergeFlush(mergeAccept(INITIAL_MERGE_STATE, incoming, 1000, CFG).state)
    expect(r.batches[0]?.[0]).toBe(incoming[0])
    expect(r.batches[0]?.[1]).toBe(incoming[1])
  })
})

describe('mergeTick 與 mergeWakeAt', () => {
  it('滿一幀才送', () => {
    const s = mergeAccept(INITIAL_MERGE_STATE, seq(2), 1000, CFG).state
    expect(mergeTick(s, 1015, CFG).batches).toEqual([])
    const fired = mergeTick(s, 1016, CFG)
    expect(flat(fired.batches)).toEqual(['0', '1'])
    expect(fired.state).toEqual(INITIAL_MERGE_STATE)
  })

  it('pending 為空時 tick 是 no-op，不產生空批次', () => {
    expect(mergeTick(INITIAL_MERGE_STATE, 9999, CFG)).toEqual({
      state: INITIAL_MERGE_STATE,
      batches: [],
    })
  })

  it('mergeWakeAt 回傳這一幀的絕對截止時間，沒有 pending 時回 null', () => {
    expect(mergeWakeAt(INITIAL_MERGE_STATE, CFG)).toBeNull()
    const s = mergeAccept(INITIAL_MERGE_STATE, seq(1), 1000, CFG).state
    expect(mergeWakeAt(s, CFG)).toBe(1016)
  })

  it('預設設定是規格 §3.1 的 16 毫秒', () => {
    expect(DEFAULT_MERGE_CONFIG.frameMs).toBe(16)
    expect(DEFAULT_MERGE_CONFIG.maxBatchSize).toBeGreaterThan(0)
  })
})

describe('mergeFlush', () => {
  it('把 pending 一次送完並回到初始狀態', () => {
    const s = mergeAccept(INITIAL_MERGE_STATE, seq(3), 1000, CFG).state
    const r = mergeFlush(s)
    expect(flat(r.batches)).toEqual(['0', '1', '2'])
    expect(r.state).toEqual(INITIAL_MERGE_STATE)
  })
  it('沒有 pending 時不產生批次', () => {
    expect(mergeFlush(INITIAL_MERGE_STATE).batches).toEqual([])
  })
})

describe('toPermissionResult：ApprovalOutcome → SDK 的 PermissionResult', () => {
  it('allow 帶上原始 input 當 updatedInput', () => {
    const input = { command: 'ls' }
    expect(toPermissionResult({ decision: 'allow' }, input)).toEqual({
      behavior: 'allow',
      updatedInput: input,
    })
  })
  it('deny 一定要有 message，SDK 靠它渲染拒絕原因', () => {
    expect(toPermissionResult({ decision: 'deny', reason: '逾時未回覆' }, {})).toEqual({
      behavior: 'deny',
      message: '逾時未回覆',
    })
  })
  it('deny 沒帶 reason 時填預設字串，不得是空字串或 undefined', () => {
    const r = toPermissionResult({ decision: 'deny' }, {})
    expect(r.behavior).toBe('deny')
    expect(r.behavior === 'deny' && r.message.length).toBeGreaterThan(0)
  })
  it('不修改傳入的 input', () => {
    const input = { command: 'ls' }
    toPermissionResult({ decision: 'allow' }, input)
    expect(input).toEqual({ command: 'ls' })
  })
})

/** 手動時鐘：計時器不會自己跑，測試呼叫 advance() 才觸發。與 agent-host.test.ts 同款，兩檔各自持有以免測試互相 import。 */
function manualClock(): {
  clock: { now: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void }
  advance: (ms: number) => void
} {
  let now = 0
  let nextId = 1
  const timers = new Map<number, () => void>()
  return {
    clock: {
      now: () => now,
      setTimer: (fn) => {
        const id = nextId
        nextId += 1
        timers.set(id, fn)
        return id
      },
      clearTimer: (h) => {
        timers.delete(h as number)
      },
    },
    advance: (ms) => {
      now += ms
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) fn()
    },
  }
}
