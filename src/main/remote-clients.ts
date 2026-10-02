import { SYSTEM_CLOCK, type MergerClock } from './agent-host.js'

export interface RemoteClientsDeps {
  run(args: readonly string[]): Promise<string>
  ownPids(): ReadonlySet<number>
  onChange(hasRemote: boolean): void
  intervalMs?: number
  clock?: Pick<MergerClock, 'setTimer' | 'clearTimer'>
  logError(error: Error): void
}

export function createRemoteClientsWatcher(deps: RemoteClientsDeps) {
  const clock = deps.clock ?? SYSTEM_CLOCK
  let generation = 0
  let active = false
  let timer: unknown
  let hasRemote = false

  const poll = async (current: number): Promise<void> => {
    let output = ''
    try {
      output = await deps.run(['list-clients', '-F', '#{session_name} #{client_pid}'])
    } catch {
      // tmux 未安裝或 server 未啟動是正常狀態,視為沒有遠端連線。
    }
    if (!active || current !== generation) return
    try {
      const own = deps.ownPids()
      const next = output.split(/\r?\n/).some((line) => {
        const match = /^\s*sp-\S*\s+([1-9]\d*)\s*$/.exec(line)
        const pid = Number(match?.[1])
        return Number.isSafeInteger(pid) && !own.has(pid)
      })
      if (next !== hasRemote) {
        hasRemote = next
        deps.onChange(next)
      }
    } catch (cause) {
      deps.logError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      // 等本輪完成才排下一輪;停止或重新啟動後,舊結果不可再排程。
      if (active && current === generation) {
        timer = clock.setTimer(() => { void poll(current) }, deps.intervalMs ?? 15000)
      }
    }
  }

  return {
    start: (): void => {
      if (active) return
      active = true
      generation += 1
      void poll(generation)
    },
    stop: (): void => {
      active = false
      generation += 1
      clock.clearTimer(timer)
      timer = undefined
    },
  }
}
