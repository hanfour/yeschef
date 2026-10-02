import { describe, expect, it } from 'vitest'
import { manualClock } from '../helpers/manual-clock.js'

describe('manualClock', () => {
  it('now() 預設從 0 起，advance 之後累加', () => {
    const { clock, advance, now } = manualClock()
    expect(now()).toBe(0)
    expect(clock.now()).toBe(0)
    advance(100)
    expect(now()).toBe(100)
    expect(clock.now()).toBe(100)
    advance(50)
    expect(now()).toBe(150)
  })

  it('可指定起始時間', () => {
    const { now } = manualClock(1000)
    expect(now()).toBe(1000)
  })

  it('advance(600) 只觸發 500ms 的 timer，5000ms 的還沒到期', () => {
    const { clock, advance } = manualClock()
    const fired: string[] = []
    clock.setTimer(() => fired.push('short'), 500)
    clock.setTimer(() => fired.push('long'), 5000)
    advance(600)
    expect(fired).toEqual(['short'])
  })

  it('之後再 advance 到 5000ms，長 timer 才觸發', () => {
    const { clock, advance } = manualClock()
    const fired: string[] = []
    clock.setTimer(() => fired.push('short'), 500)
    clock.setTimer(() => fired.push('long'), 5000)
    advance(600)
    advance(4400)
    expect(fired).toEqual(['short', 'long'])
  })

  it('due 剛好等於 now 就要觸發（比較式是 <=，不是 <）', () => {
    const { clock, advance } = manualClock()
    let fired = false
    clock.setTimer(() => {
      fired = true
    }, 500)
    advance(500)
    expect(fired).toBe(true)
  })

  it('依到期時間由小到大觸發，不是依註冊順序', () => {
    const { clock, advance } = manualClock()
    const order: string[] = []
    // 刻意用「先註冊的反而晚到期」的順序，讓「不排序、按註冊順序觸發」的突變會被測出來。
    clock.setTimer(() => order.push('due-300'), 300)
    clock.setTimer(() => order.push('due-100'), 100)
    clock.setTimer(() => order.push('due-200'), 200)
    advance(300)
    expect(order).toEqual(['due-100', 'due-200', 'due-300'])
  })

  it('timer 回呼裡新排一個 0ms timer，會在同一輪 advance() 觸發', () => {
    const { clock, advance } = manualClock()
    const order: string[] = []
    clock.setTimer(() => {
      order.push('first')
      clock.setTimer(() => order.push('second'), 0)
    }, 100)
    advance(100)
    expect(order).toEqual(['first', 'second'])
  })

  it('回呼裡新排的 timer 若還沒到期，要等下一次 advance()', () => {
    const { clock, advance } = manualClock()
    const order: string[] = []
    clock.setTimer(() => {
      order.push('first')
      clock.setTimer(() => order.push('second'), 1000)
    }, 100)
    advance(100)
    expect(order).toEqual(['first'])
    advance(1000)
    expect(order).toEqual(['first', 'second'])
  })

  it('clearTimer 之後不會觸發', () => {
    const { clock, advance } = manualClock()
    let fired = false
    const handle = clock.setTimer(() => {
      fired = true
    }, 100)
    clock.clearTimer(handle)
    advance(200)
    expect(fired).toBe(false)
  })

  it('已觸發的 timer 不會重複觸發', () => {
    const { clock, advance } = manualClock()
    let count = 0
    clock.setTimer(() => {
      count += 1
    }, 100)
    advance(100)
    advance(1000)
    expect(count).toBe(1)
  })
})
