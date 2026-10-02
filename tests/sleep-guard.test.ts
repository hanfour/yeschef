import { describe, expect, it } from 'vitest'
import { createSleepGuard } from '../src/main/sleep-guard.js'

function fake() {
  let calls: readonly string[] = []
  let started: ReadonlySet<number> = new Set<number>()
  let nextId = 1
  const deps = {
    start: () => { const id = nextId++; started = new Set([...started, id]); calls = [...calls, `start:${String(id)}`]; return id },
    stop: (id: number) => { started = new Set([...started].filter((value) => value !== id)); calls = [...calls, `stop:${String(id)}`] },
    isStarted: (id: number) => started.has(id),
    log: (line: string) => { calls = [...calls, `log:${line}`] },
  }
  return { deps, calls: () => calls, withdraw: () => { started = new Set() } }
}

describe('sleep-guard', () => {
  it('有工作就 start 一次,重複說有工作不會再 start', () => {
    const { deps, calls } = fake()
    const guard = createSleepGuard(deps)
    guard.setSignal('conversations', true)
    guard.setSignal('conversations', true)
    expect(calls()).toEqual(['start:1', 'log:[yeschef] 擋睡眠:有對話在執行'])
    expect(guard.isBlocking()).toBe(true)
  })

  it('沒工作就 stop,重複說沒工作不會再 stop', () => {
    const { deps, calls } = fake()
    const guard = createSleepGuard(deps)
    guard.setSignal('conversations', false)
    expect(calls()).toEqual([])
    guard.setSignal('conversations', true)
    guard.setSignal('conversations', false)
    guard.setSignal('conversations', false)
    expect(calls()).toEqual(['start:1', 'log:[yeschef] 擋睡眠:有對話在執行', 'stop:1', 'log:[yeschef] 放行睡眠:全部閒置'])
    expect(guard.isBlocking()).toBe(false)
  })

  it('系統把 blocker 撤掉之後(isStarted 變 false),下一次有工作會重新 start', () => {
    const { deps, calls, withdraw } = fake()
    const guard = createSleepGuard(deps)
    guard.setSignal('conversations', true)
    withdraw()
    guard.setSignal('conversations', true)
    expect(calls().filter((c) => c.startsWith('start'))).toEqual(['start:1', 'start:2'])
  })

  it('dispose 會 stop 並且之後不再作用', () => {
    const { deps, calls } = fake()
    const guard = createSleepGuard(deps)
    guard.setSignal('conversations', true)
    guard.dispose()
    guard.setSignal('conversations', true)
    expect(calls().filter((c) => !c.startsWith('log'))).toEqual(['start:1', 'stop:1'])
  })
})

it('兩種訊號交叉時共用 blocker,最後一個訊號關閉才放行', () => {
  const { deps, calls } = fake()
  const guard = createSleepGuard(deps)
  guard.setSignal('conversations', true)
  guard.setSignal('remote', true)
  guard.setSignal('conversations', false)
  expect(guard.isBlocking()).toBe(true)
  guard.setSignal('remote', false)
  expect(calls()).toEqual(['start:1', 'log:[yeschef] 擋睡眠:有對話在執行', 'stop:1', 'log:[yeschef] 放行睡眠:全部閒置'])
})

it('遠端啟動有專屬訊息,另一訊號更新時也可恢復被撤掉的 blocker', () => {
  const { deps, calls, withdraw } = fake()
  const guard = createSleepGuard(deps)
  guard.setSignal('remote', true)
  expect(calls()).toContain('log:[yeschef] 擋睡眠:有遠端連線')
  withdraw()
  guard.setSignal('conversations', false)
  expect(calls().filter((c) => c.startsWith('start'))).toEqual(['start:1', 'start:2'])
  withdraw()
  guard.setSignal('remote', false)
  expect(guard.isBlocking()).toBe(false)
  guard.dispose()
  guard.dispose()
})
