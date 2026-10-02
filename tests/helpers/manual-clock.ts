import type { MergerClock } from '../../src/main/agent-host.js'

interface TimerEntry {
  readonly due: number
  readonly fn: () => void
}

/**
 * 手動時鐘：計時器不會自己跑，測試呼叫 advance() 才觸發（契約 §14 第一點）。
 *
 * `setTimer(fn, ms)` 記 `due = now + ms`。`advance(ms)` 先把 `now` 推進，
 * 再依 `due` 由小到大逐一觸發所有 `due <= now` 的 timer：每觸發一個就重新掃描一次
 * 目前還在的 timer，所以 timer 回呼裡新排的 timer 若也到期（例如再排一個 0ms
 * 的 timer），會在同一次 advance() 呼叫裡被一併觸發，不必呼叫第二次 advance()。
 *
 * 取代 `tests/agent-host.test.ts` 原本檔內私有的 `manualClock()`：舊版 `advance()`
 * 不看到期時間、一次觸發全部 timer，測不出「500ms 與 5 秒兩個 timer 並存時
 * advance(600) 只觸發前者」這種情境，settle.ts／handoff.ts 的測試需要這個能力。
 */
export function manualClock(start = 0): {
  readonly clock: MergerClock
  advance(ms: number): void
  now(): number
} {
  let now = start
  let nextId = 1
  const timers = new Map<number, TimerEntry>()

  function fireDue(): void {
    for (;;) {
      let earliestId: number | null = null
      let earliestDue = Infinity
      for (const [id, entry] of timers) {
        if (entry.due <= now && entry.due < earliestDue) {
          earliestId = id
          earliestDue = entry.due
        }
      }
      if (earliestId === null) return
      const entry = timers.get(earliestId)
      timers.delete(earliestId)
      entry?.fn()
    }
  }

  const clock: MergerClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId
      nextId += 1
      timers.set(id, { due: now + ms, fn })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
  }

  return {
    clock,
    advance(ms) {
      now += ms
      fireDue()
    },
    now: () => now,
  }
}
