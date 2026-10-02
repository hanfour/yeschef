import { describe, it, expect, vi } from 'vitest'
import { manualClock } from '../helpers/manual-clock.js'
import {
  createHandoff,
  readToolUseId,
  HANDOFF_TIMEOUT_MS,
  EARLY_DONE_MAX,
  type HandoffWaitResult,
} from '../../src/main/view-tools/handoff.js'
import { ViewToolError, MSG } from '../../src/main/view-tools/errors.js'

/** 每個測試各自的 clock、logError 收集器與 handoff 實例，互不共用狀態。 */
function setup() {
  const { clock, advance } = manualClock()
  const errors: Error[] = []
  const logError = (error: Error): void => {
    errors.push(error)
  }
  const handoff = createHandoff(clock, logError)
  return { clock, advance, errors, handoff }
}

describe('createHandoff', () => {
  it('pending() 初始為 null', () => {
    const { handoff } = setup()
    expect(handoff.pending()).toBeNull()
  })

  it('begin() 建立 pending，reason 與 askedAt 依 clock.now()（非建構時間）', () => {
    const { advance, handoff } = setup()
    advance(1000)
    const wait = handoff.begin('t1', '需要登入')
    void wait.catch(() => {})
    expect(handoff.pending()).toEqual({ toolUseId: 't1', reason: '需要登入', askedAt: 1000 })
    handoff.done('t1')
  })

  it('已有 pending 時第二次 begin 立刻拒絕（handoffBusy），第一筆不受影響', async () => {
    const { handoff } = setup()
    const wait1 = handoff.begin('t1', '原因A')
    await expect(handoff.begin('t2', '原因B')).rejects.toThrow(ViewToolError)
    await expect(handoff.begin('t2', '原因B')).rejects.toThrow(MSG.handoffBusy('原因A'))
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1', reason: '原因A' }))
    handoff.done('t1')
    await expect(wait1).resolves.toEqual({ outcome: 'done' })
  })

  it('done 在逾時前 resolve done，timer 已清：之後 advance 不再第二次 resolve 或 logError', async () => {
    const { advance, handoff, errors } = setup()
    const spy = vi.fn()
    const wait = handoff.begin('t1', 'x')
    void wait.then(spy)
    handoff.done('t1')
    await expect(wait).resolves.toEqual({ outcome: 'done' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(handoff.pending()).toBeNull()
    advance(HANDOFF_TIMEOUT_MS)
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(0)
  })

  it('done 傳入不符 pending 的 id（裁決 31）：記進 earlyDone、不 logError，原本那筆 pending 不受影響', async () => {
    const { handoff, errors } = setup()
    const wait = handoff.begin('t1', 'x')
    handoff.done('other-id')
    expect(errors).toHaveLength(0)
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1' }))
    handoff.done('t1')
    await expect(wait).resolves.toEqual({ outcome: 'done' })
  })

  it('done 在沒有 pending 時（裁決 31）：記進 earlyDone、不 logError、不丟例外', () => {
    const { handoff, errors } = setup()
    expect(() => handoff.done('nope')).not.toThrow()
    expect(errors).toHaveLength(0)
  })

  it('早到的 done（裁決 31）：之後 begin 帶同一個 id 立即回 done，不建立 pending', async () => {
    const { handoff, errors } = setup()
    handoff.done('t1')
    expect(handoff.pending()).toBeNull()
    await expect(handoff.begin('t1', '理由')).resolves.toEqual({ outcome: 'done' })
    expect(handoff.pending()).toBeNull()
    expect(errors).toHaveLength(0)
  })

  it('早到的 done 用過一次就消耗掉：同一個 id 第二次 begin 是正常新的一筆', async () => {
    const { handoff } = setup()
    handoff.done('t1')
    await expect(handoff.begin('t1', '理由A')).resolves.toEqual({ outcome: 'done' })
    const wait2 = handoff.begin('t1', '理由B')
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1', reason: '理由B' }))
    handoff.done('t1')
    await expect(wait2).resolves.toEqual({ outcome: 'done' })
  })

  it('earlyDone 命中優先於 handoffBusy：即使目前有別筆 pending 也能立即回 done', async () => {
    const { handoff } = setup()
    const wait1 = handoff.begin('t1', '原因A')
    handoff.done('t2')
    await expect(handoff.begin('t2', '原因B')).resolves.toEqual({ outcome: 'done' })
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1' }))
    handoff.done('t1')
    await expect(wait1).resolves.toEqual({ outcome: 'done' })
  })

  it('earlyDone 有 FIFO 上限 EARLY_DONE_MAX：超過時淘汰最舊的一筆', async () => {
    const { handoff } = setup()
    for (let i = 0; i <= EARLY_DONE_MAX; i += 1) handoff.done(`id-${i}`)
    const waitEvicted = handoff.begin('id-0', '正常一筆')
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 'id-0' }))
    handoff.done('id-0')
    await expect(waitEvicted).resolves.toEqual({ outcome: 'done' })
    await expect(handoff.begin('id-1', 'x')).resolves.toEqual({ outcome: 'done' })
    await expect(handoff.begin(`id-${EARLY_DONE_MAX}`, 'x')).resolves.toEqual({ outcome: 'done' })
  })

  it('abortAll 清空 earlyDone（裁決 31）：清空後同一個 id 的 begin 不再立即回 done', async () => {
    const { handoff } = setup()
    handoff.done('t1')
    handoff.abortAll()
    const wait = handoff.begin('t1', '理由')
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't1', reason: '理由' }))
    handoff.done('t1')
    await expect(wait).resolves.toEqual({ outcome: 'done' })
  })

  it('逾時：到 HANDOFF_TIMEOUT_MS 前不 resolve（到期排序，不是 advance 就全部觸發）', async () => {
    const { advance, handoff } = setup()
    const wait = handoff.begin('t1', 'x')
    let settled: HandoffWaitResult | undefined
    void wait.then((r) => { settled = r })
    advance(HANDOFF_TIMEOUT_MS - 1)
    await Promise.resolve()
    expect(settled).toBeUndefined()
    expect(handoff.pending()).not.toBeNull()
    advance(1)
    await Promise.resolve()
    expect(settled).toEqual({ outcome: 'timeout' })
    expect(handoff.pending()).toBeNull()
  })

  it('逾時後 pending 已清：之後可以再 begin（不會被舊 pending 卡成 handoffBusy）', async () => {
    const { advance, handoff } = setup()
    const wait1 = handoff.begin('t1', 'x')
    advance(HANDOFF_TIMEOUT_MS)
    await expect(wait1).resolves.toEqual({ outcome: 'timeout' })
    const wait2 = handoff.begin('t2', 'y')
    handoff.done('t2')
    await expect(wait2).resolves.toEqual({ outcome: 'done' })
  })

  it('abortAll 對沒有 pending 時是 no-op：不丟例外、不 logError', () => {
    const { handoff, errors } = setup()
    expect(() => handoff.abortAll()).not.toThrow()
    expect(errors).toHaveLength(0)
    expect(handoff.pending()).toBeNull()
  })

  it('abortAll 對有 pending 時 resolve session-ended 並清 timer：之後 advance 不再 logError 或第二次 resolve', async () => {
    const { advance, handoff, errors } = setup()
    const spy = vi.fn()
    const wait = handoff.begin('t1', 'x')
    void wait.then(spy)
    handoff.abortAll()
    await expect(wait).resolves.toEqual({ outcome: 'session-ended' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(handoff.pending()).toBeNull()
    advance(HANDOFF_TIMEOUT_MS)
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(0)
  })

  it('abortAll 之後開新的 begin：舊 pending 的逾時 timer 不能提前結束新的 pending（驗證 clearTimer 有實際生效）', async () => {
    const { advance, handoff } = setup()
    const wait1 = handoff.begin('t1', 'x')
    advance(100)
    handoff.abortAll()
    await expect(wait1).resolves.toEqual({ outcome: 'session-ended' })
    const wait2 = handoff.begin('t2', 'y')
    let settled2: HandoffWaitResult | undefined
    void wait2.then((r) => { settled2 = r })
    advance(HANDOFF_TIMEOUT_MS - 100)
    await Promise.resolve()
    expect(settled2).toBeUndefined()
    expect(handoff.pending()).toEqual(expect.objectContaining({ toolUseId: 't2' }))
    advance(100)
    await Promise.resolve()
    expect(settled2).toEqual({ outcome: 'timeout' })
  })

  it('signal 建立時已 aborted：立即 session-ended，不建立 pending', async () => {
    const { handoff } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(handoff.begin('t1', 'x', controller.signal)).resolves.toEqual({ outcome: 'session-ended' })
    expect(handoff.pending()).toBeNull()
  })

  it('signal 事後 abort：resolve session-ended 並清 pending 與 timer', async () => {
    const { advance, handoff, errors } = setup()
    const controller = new AbortController()
    const wait = handoff.begin('t1', 'x', controller.signal)
    controller.abort()
    await expect(wait).resolves.toEqual({ outcome: 'session-ended' })
    expect(handoff.pending()).toBeNull()
    advance(HANDOFF_TIMEOUT_MS)
    await Promise.resolve()
    expect(errors).toHaveLength(0)
  })
})

describe('readToolUseId', () => {
  it('extra 不是物件回 null', () => {
    expect(readToolUseId(undefined)).toBeNull()
    expect(readToolUseId(null)).toBeNull()
    expect(readToolUseId('x')).toBeNull()
    expect(readToolUseId(42)).toBeNull()
  })

  it('_meta 缺回 null', () => {
    expect(readToolUseId({})).toBeNull()
  })

  it('_meta 不是物件回 null', () => {
    expect(readToolUseId({ _meta: 'nope' })).toBeNull()
    expect(readToolUseId({ _meta: null })).toBeNull()
  })

  it('id 不是字串回 null', () => {
    expect(readToolUseId({ _meta: { 'claudecode/toolUseId': 123 } })).toBeNull()
  })

  it('id 是空字串回 null', () => {
    expect(readToolUseId({ _meta: { 'claudecode/toolUseId': '' } })).toBeNull()
  })

  it('正常取出 toolUseId', () => {
    expect(readToolUseId({ _meta: { 'claudecode/toolUseId': 'abc-123' } })).toBe('abc-123')
  })
})
