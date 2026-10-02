import { useEffect, useMemo, useState } from 'react'
import type { Event } from '../../shared/events.js'
import type { YesChefApi } from '../../shared/ipc.js'
import type { SessionState } from '../../shared/session-state.js'
import { fold, type ConversationView } from '../../shared/fold.js'
import { appendEvents } from '../../shared/event-log.js'

export const INITIAL_SESSION_STATE: SessionState = { kind: 'idle' }

interface Accumulated {
  readonly state: SessionState
  readonly events: readonly Event[]
}

const INITIAL_ACCUMULATED: Accumulated = { state: INITIAL_SESSION_STATE, events: [] }

/**
 * 附加一批事件（裁決 22）的規則搬到 `shared/event-log.ts`：main 的 `conversation.ts`
 * 切回前景重播時要算出同一份內容，規則只能有一份。這裡重新匯出，既有的匯入點不必改。
 */
export { appendEvents }

export function useConversation(api: YesChefApi, conversationId: string): {
  readonly view: ConversationView
  readonly sessionState: SessionState
  readonly turnEnds: number
} {
  const [acc, setAcc] = useState<Accumulated>(INITIAL_ACCUMULATED)

  useEffect(() => {
    // 每個對話分頁一份 hook(D2)。別的對話的流在這裡就丟掉,不進 state。
    setAcc(INITIAL_ACCUMULATED)
    const offEvents = api.onEvents((payload) => {
      if (payload.conversationId !== conversationId || payload.events.length === 0) return
      setAcc((prev) => ({ ...prev, events: appendEvents(prev.events, payload.events) }))
    })
    const offState = api.onSessionState((payload) => {
      if (payload.conversationId !== conversationId) return
      setAcc((prev) => ({ ...prev, state: payload.state }))
    })
    return () => {
      offEvents()
      offState()
    }
  }, [api, conversationId])

  const view = useMemo(() => fold(acc.events), [acc.events])
  const turnEnds = useMemo(
    () => acc.events.filter((e) => e.kind === 'session-end').length,
    [acc.events]
  )
  return { view, sessionState: acc.state, turnEnds }
}
