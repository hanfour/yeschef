export interface SleepGuardDeps {
  start(): number
  stop(id: number): void
  isStarted(id: number): boolean
  log(line: string): void
}

export interface SleepGuard {
  setSignal(name: 'conversations' | 'remote', on: boolean): void
  dispose(): void
  isBlocking(): boolean
}

export const MSG_BLOCK = '[yeschef] 擋睡眠:有對話在執行'
export const MSG_REMOTE = '[yeschef] 擋睡眠:有遠端連線'
export const MSG_RELEASE = '[yeschef] 放行睡眠:全部閒置'

/**
 * 有對話在跑或遠端連線就擋系統睡眠,全部閒置就放行(roadmap §2.2:主機睡著沒有任何方案能繼續運算,
 * 所以在需要的時候不讓它睡;閒置時放行,不耗電池)。
 * 每次都先問 isStarted:系統可能自己把 blocker 撤掉(例如使用者強制睡眠後醒來),
 * 那時 id 還在但已經沒作用,要重新 start。
 */
export function createSleepGuard(deps: SleepGuardDeps): SleepGuard {
  let id: number | undefined
  let disposed = false
  let signals = { conversations: false, remote: false }
  const blocking = (): boolean => id !== undefined && deps.isStarted(id)
  return {
    setSignal: (name, on) => {
      if (disposed) return
      signals = { ...signals, [name]: on }
      const busy = signals.conversations || signals.remote
      if (busy && !blocking()) {
        id = deps.start()
        deps.log(signals.conversations ? MSG_BLOCK : MSG_REMOTE)
      } else if (!busy && id !== undefined) {
        if (deps.isStarted(id)) deps.stop(id)
        id = undefined
        deps.log(MSG_RELEASE)
      }
    },
    dispose: () => {
      if (id !== undefined && deps.isStarted(id)) deps.stop(id)
      id = undefined
      disposed = true
    },
    isBlocking: blocking,
  }
}
