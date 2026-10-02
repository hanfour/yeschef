import { describe, it, expect } from 'vitest'
import { transition, type Effect } from '../src/main/session-machine.js'
import type { SessionState } from '../src/shared/session-state.js'

const kinds = (effects: readonly Effect[]): string[] => effects.map((e) => e.kind)

describe('transition：從 idle 出發', () => {
  const idle: SessionState = { kind: 'idle' }

  it('start-new 進入 live 並要求開一個新 query', () => {
    const r = transition(idle, { kind: 'start-new' })
    expect(r.state.kind).toBe('live')
    expect(kinds(r.effects)).toEqual(['start-query'])
    expect(r.effects[0]).toEqual({ kind: 'start-query' })
  })

  it('open-history 進入 viewing 並要求載入歷史', () => {
    const r = transition(idle, { kind: 'open-history', sessionId: 's-1' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-1' })
    expect(kinds(r.effects)).toEqual(['load-history'])
  })

  it('user-input 在 idle 直接開新對話，這則輸入是第一句', () => {
    const r = transition(idle, { kind: 'user-input', text: '你好' })
    expect(r.state).toEqual({ kind: 'live' })
    expect(kinds(r.effects)).toEqual(['start-query'])
    expect(r.effects[0]).toEqual({ kind: 'start-query', initialInput: '你好' })
  })

  it('session-ended 在 idle 是無害的 no-op', () => {
    const r = transition(idle, { kind: 'session-ended' })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })

  it('window-closed 在 idle 是無害的 no-op', () => {
    const r = transition(idle, { kind: 'window-closed' })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })
})

describe('transition：從 live 出發', () => {
  const live: SessionState = { kind: 'live', sessionId: 's-live' }

  it('session-ended 回到 idle，不需要收尾（query 自己結束了）', () => {
    const r = transition(live, { kind: 'session-ended' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(kinds(r.effects)).toEqual([])
  })

  it('window-closed 走完整的三步收尾', () => {
    const r = transition(live, { kind: 'window-closed' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(kinds(r.effects)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query'])
  })

  it('open-history 先收尾再載入歷史，順序不可對調', () => {
    const r = transition(live, { kind: 'open-history', sessionId: 's-2' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-2' })
    expect(kinds(r.effects)).toEqual([
      'deny-all-approvals',
      'interrupt-query',
      'teardown-query',
      'load-history',
    ])
  })

  it('user-input 在 live 不改變狀態，也不產生 effect（輸入直接送進既有 query）', () => {
    const r = transition(live, { kind: 'user-input', text: '繼續' })
    expect(r.state).toEqual(live)
    expect(r.effects).toEqual([])
  })

  it('start-new 從 live 開新對話，收尾後無 sessionId', () => {
    const r = transition({ kind: 'live' }, { kind: 'start-new' })
    expect(r.state).toEqual({ kind: 'live' })
    expect(kinds(r.effects)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query', 'start-query'])
    expect(r.effects[0]).toEqual({ kind: 'deny-all-approvals', reason: '切換 session' })
    expect(r.effects[3]).toEqual({ kind: 'start-query' })
  })
})

describe('transition：從 viewing 出發', () => {
  const viewing: SessionState = { kind: 'viewing', sessionId: 's-old' }

  it('user-input 接續該 session，帶上 resume 與第一則輸入', () => {
    const r = transition(viewing, { kind: 'user-input', text: '接著問' })
    expect(r.state).toEqual({ kind: 'live', sessionId: 's-old' })
    expect(kinds(r.effects)).toEqual(['start-query'])
    expect(r.effects[0]).toEqual({
      kind: 'start-query',
      resumeSessionId: 's-old',
      initialInput: '接著問',
    })
  })

  it('切到另一條歷史對話不需要收尾（viewing 沒有活躍 query）', () => {
    const r = transition(viewing, { kind: 'open-history', sessionId: 's-new' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-new' })
    expect(kinds(r.effects)).toEqual(['load-history'])
  })

  it('start-new 從 viewing 開新對話', () => {
    const r = transition(viewing, { kind: 'start-new' })
    expect(r.state.kind).toBe('live')
    expect(kinds(r.effects)).toEqual(['start-query'])
  })

  it('window-closed 只回 idle，不需要 query 相關的收尾', () => {
    const r = transition(viewing, { kind: 'window-closed' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(r.effects).toEqual([])
  })

  it('session-ended 在 viewing 只回 idle，不需要收尾', () => {
    const r = transition({ kind: 'viewing', sessionId: 's-1' }, { kind: 'session-ended' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(r.effects).toEqual([])
  })
})

describe('收尾順序（規格 §3.2）', () => {
  it('deny-all-approvals 必須早於 interrupt-query，interrupt-query 必須早於 teardown-query', () => {
    const r = transition({ kind: 'live', sessionId: 'x' }, { kind: 'window-closed' })
    const k = kinds(r.effects)
    expect(k.indexOf('deny-all-approvals')).toBeLessThan(k.indexOf('interrupt-query'))
    expect(k.indexOf('interrupt-query')).toBeLessThan(k.indexOf('teardown-query'))
  })

  it('deny-all-approvals 帶著可讀的理由，會顯示在對話裡', () => {
    const a = transition({ kind: 'live' }, { kind: 'window-closed' }).effects[0]
    const b = transition({ kind: 'live' }, { kind: 'open-history', sessionId: 's' }).effects[0]
    expect(a).toEqual({ kind: 'deny-all-approvals', reason: '視窗已關閉' })
    expect(b).toEqual({ kind: 'deny-all-approvals', reason: '切換 session' })
  })
})

describe('session-started：live 對話拿到 SDK 給的 session id', () => {
  it('live 收到 session-started 時把 id 寫進狀態，不產生 effect', () => {
    const r = transition({ kind: 'live' }, { kind: 'session-started', sessionId: 's-new' })
    expect(r.state).toEqual({ kind: 'live', sessionId: 's-new' })
    expect(r.effects).toEqual([])
  })

  it('idle 忽略 session-started：收尾後遲到的那一筆不可以把狀態翻回 live', () => {
    const r = transition({ kind: 'idle' }, { kind: 'session-started', sessionId: 's-late' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(r.effects).toEqual([])
  })

  it('viewing 忽略 session-started：歷史重播不改變正在看哪一場', () => {
    const r = transition(
      { kind: 'viewing', sessionId: 's-old' },
      { kind: 'session-started', sessionId: 's-new' }
    )
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-old' })
    expect(r.effects).toEqual([])
  })
})

describe('不可變性', () => {
  it('不修改傳入的 state', () => {
    const state: SessionState = { kind: 'live', sessionId: 's-1' }
    const snapshot = JSON.stringify(state)
    transition(state, { kind: 'window-closed' })
    expect(JSON.stringify(state)).toBe(snapshot)
  })

  it('回傳的 state 是新物件，不是傳入的那一個', () => {
    const state: SessionState = { kind: 'live', sessionId: 's-1' }
    const r = transition(state, { kind: 'user-input', text: 'x' })
    // user-input 在 live 不改狀態，但仍須回傳新物件而非同一個參考
    expect(r.state).not.toBe(state)
    expect(r.state).toEqual(state)
  })
})

describe('sleep:專案切到背景後收掉串流(規格 D §3.3)', () => {
  it('live 有 sessionId 時轉 viewing 並走三步收尾,之後再輸入才 resume', () => {
    const r = transition({ kind: 'live', sessionId: 's-1' }, { kind: 'sleep' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-1' })
    expect(r.effects.map((e) => e.kind)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query'])
    expect(r.effects[0]).toEqual({ kind: 'deny-all-approvals', reason: '專案切到背景' })
  })
  it('live 還沒有 sessionId 時只能回 idle', () => {
    const r = transition({ kind: 'live' }, { kind: 'sleep' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(r.effects.map((e) => e.kind)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query'])
  })
  it('idle 與 viewing 忽略 sleep', () => {
    expect(transition({ kind: 'idle' }, { kind: 'sleep' })).toEqual({ state: { kind: 'idle' }, effects: [] })
    expect(transition({ kind: 'viewing', sessionId: 's-2' }, { kind: 'sleep' }))
      .toEqual({ state: { kind: 'viewing', sessionId: 's-2' }, effects: [] })
  })
  it('sleep 後 user-input 帶 resume', () => {
    const slept = transition({ kind: 'live', sessionId: 's-1' }, { kind: 'sleep' }).state
    const r = transition(slept, { kind: 'user-input', text: '繼續' })
    expect(r.effects).toEqual([{ kind: 'start-query', resumeSessionId: 's-1', initialInput: '繼續' }])
  })
})
