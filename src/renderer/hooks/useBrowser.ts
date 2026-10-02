import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserCommand, BrowserCommandResult, BrowserSessionEntry, BrowserStatePayload } from '../../shared/browser-ipc.js'
import type { YesChefApi } from '../../shared/ipc.js'

export interface Browser {
  stateOf(conversationId: string | null): BrowserStatePayload | undefined
  readonly sessions: readonly BrowserSessionEntry[]
  run(command: BrowserCommand): Promise<BrowserCommandResult>
}

type States = ReadonlyMap<string, BrowserStatePayload>
type BrowserApi = Pick<YesChefApi, 'browserCommand' | 'getBrowser' | 'onBrowserState' | 'onBrowserSessions'>

/** 每個對話的瀏覽器狀態都收著:切換對話時網址列手上已經有新前景的最新狀態(每對話瀏覽器規格 §5.2)。 */
export function useBrowser(api: BrowserApi): Browser {
  const [states, setStates] = useState<States>(new Map())
  const [sessions, setSessions] = useState<readonly BrowserSessionEntry[]>([])
  // 最近一次 onBrowserSessions 推送當下還活著的對話 id;null 表示還沒收過推送。
  // 晚到的 getBrowser 快照只能對這個集合以內的對話生效,不然它可能把推送已經
  // 判定「session 沒了」的對話重新放回來(推送永遠比快照新)。
  const liveIds = useRef<ReadonlySet<string> | null>(null)

  useEffect(() => {
    let alive = true
    const offState = api.onBrowserState((next) => {
      setStates((prev) => new Map([...prev, [next.conversationId, next]]))
    })
    const offSessions = api.onBrowserSessions((next) => {
      setSessions(next)
      const live = new Set(next.map((s) => s.conversationId))
      liveIds.current = live
      setStates((prev) => new Map([...prev].filter(([id]) => live.has(id))))
    })
    api.getBrowser().then((snapshot) => {
      if (!alive) return
      const live = liveIds.current
      const fresh = live === null ? snapshot.states : snapshot.states.filter((s) => live.has(s.conversationId))
      // 推送比這份快照新:已經有的不蓋。
      setStates((prev) => new Map([...fresh.map((s) => [s.conversationId, s] as const), ...prev]))
      if (live === null) setSessions((prev) => (prev.length > 0 ? prev : snapshot.sessions))
    }).catch((err: unknown) => { console.error('[yeschef] browser:get 失敗', err) })
    return () => { alive = false; offState(); offSessions() }
  }, [api])

  const stateOf = useCallback((id: string | null) => (id === null ? undefined : states.get(id)), [states])
  const run = useCallback((command: BrowserCommand) => api.browserCommand(command), [api])
  return { stateOf, sessions, run }
}
