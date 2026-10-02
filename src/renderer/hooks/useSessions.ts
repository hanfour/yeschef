import { useEffect, useState } from 'react'
import type { SessionState } from '../../shared/session-state.js'
import type { SessionSummary, YesChefApi } from '../../shared/ipc.js'
import type { SessionListScope } from '../../shared/projects.js'

export interface UseSessions {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly error?: string
}

const IDLE: SessionState = { kind: 'idle' }

/** 目前選中的那一筆（裁決 14）。idle 沒有選中的 session。 */
export function currentSessionId(state: SessionState): string | undefined {
  return state.kind === 'idle' ? undefined : state.sessionId
}

/**
 * 依 SessionState 產生的重載鍵。用字串而不是直接把 state 物件放進 deps：
 * main 每次推 session:state 都是新物件，用物件當 deps 會讓每一次推送都重打一次
 * listSessions。內容相同就不重載，內容變了才重載。
 */
function reloadKey(state: SessionState): string {
  return `${state.kind}:${currentSessionId(state) ?? ''}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : '讀取歷史對話清單失敗'
}

/**
 * @param refresh 額外的重載觸發。狀態沒變但內容變了的情況只有一種：live 對話在
 * 同一個 sessionId 底下又結束了一個回合，摘要與排序都該更新。呼叫端傳一個每回合
 * 遞增的數字，這裡就把它併進重載鍵。
 * @param scope 列哪個專案的（規格 §3.2）：`projectId: null` 是全部。併進重載鍵的是
 * `projectId` 字串而不是物件本身，呼叫端每次 render 給新物件也不會重載。
 */
export function useSessions(
  api: YesChefApi,
  refresh: number,
  scope: SessionListScope,
  conversationId: string | null,
  enabled = true,
): UseSessions {
  const [received, setReceived] = useState<{ owner: string | null; state: SessionState }>({ owner: conversationId, state: IDLE })
  const state = received.owner === conversationId ? received.state : IDLE
  const source = `${scope.projectId ?? "*"}:${scope.provider ?? "claude"}`
  const [loadedSource, setLoadedSource] = useState(source)
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(
    () =>
      enabled ? api.onSessionState((payload) => {
        if (payload.conversationId === conversationId) setReceived({ owner: conversationId, state: payload.state })
      }) : undefined,
    [api, conversationId, enabled]
  )


  const projectKey = scope.projectId ?? '*'
  const provider = scope.provider
  const key = `${reloadKey(state)}:${refresh}:${projectKey}:${provider ?? 'claude'}`
  useEffect(() => {
    if (!enabled) return
    // cancelled 擋的是慢的舊請求蓋掉快的新請求：連按兩筆歷史對話時會有兩次
    // listSessions 同時在飛，先發的後回就會把畫面倒退回舊清單。
    let cancelled = false
    api
      .listSessions({ projectId: projectKey === '*' ? null : projectKey, ...(provider === undefined ? {} : { provider }) })
      .then((list) => {
        if (cancelled) return
        setLoadedSource(source)
        setSessions(list)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 不清空 sessions：清單讀不到時，把上一次讀到的留在畫面上比變成空白有用。
        if (loadedSource !== source) setSessions([])
        setLoadedSource(source)
        setError(messageOf(err))
      })
    return () => {
      cancelled = true
    }
  }, [api, key, enabled])

  const current = currentSessionId(state)
  return {
    sessions: loadedSource === source ? sessions : [],
    ...(current === undefined ? {} : { current }),
    ...(error === undefined || loadedSource !== source ? {} : { error }),
  }
}
