import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { GroupMessage, GroupThread } from '../../shared/group.js'

export interface Group {
  readonly messages: readonly GroupMessage[]
  readonly threads: readonly GroupThread[]
  /** 第一份狀態到了沒。false 時畫面不顯示「還沒有訊息」,避免載入中先閃一下。 */
  readonly loaded: boolean
  readonly error: string | undefined
  /** 送出成功回 true;回 false 時 `error` 已經帶著原因。 */
  send(threadId: string, text: string): Promise<boolean>
  /** 以單一群組 IPC 重開或聚焦 participant 的歷史對話。 */
  openParticipant(threadId: string, conversationId: string): Promise<boolean>
}

export type GroupApi = Pick<YesChefApi, 'manageGroup' | 'onGroupMessages'>

const SEND_FAILED = '訊息沒有送出'
const LOAD_FAILED = '讀取群組訊息失敗'
const OPEN_FAILED = '無法開啟這段對話'

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

interface Accumulated {
  readonly messages: readonly GroupMessage[]
  readonly threads: readonly GroupThread[]
}

const EMPTY: Accumulated = { messages: [], threads: [] }

/** 已有的 id 不再接一次:推播批次與初次 get 可能重疊。 */
function merge(previous: readonly GroupMessage[], incoming: readonly GroupMessage[]): readonly GroupMessage[] {
  const known = new Set(previous.map((m) => m.id))
  const fresh = incoming.filter((message) => {
    if (known.has(message.id)) return false
    known.add(message.id)
    return true
  })
  return fresh.length === 0 ? previous : [...previous, ...fresh]
}

/**
 * 群組頻道的 renderer 端狀態(群組規格 §7)。
 * 先訂閱再 `get`:反過來的話,invoke 回來之前主行程推的那一批會漏掉。
 */
export function useGroup(api: GroupApi, projectId: string): Group {
  const [acc, setAcc] = useState<Accumulated>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const aliveRef = useRef(true)
  const currentProjectIdRef = useRef(projectId)
  useLayoutEffect(() => { currentProjectIdRef.current = projectId }, [projectId])
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  useGroupLoading(api, projectId, setAcc, setLoaded, setError)

  const send = useCallback(async (threadId: string, text: string): Promise<boolean> => {
    const sendingProjectId = projectId
    try {
      const response = await api.manageGroup({ action: 'send', projectId, threadId, text })
      if (!aliveRef.current) return false
      if (currentProjectIdRef.current === sendingProjectId) {
        setError(response.kind === 'error' ? response.message : undefined)
      }
      return response.kind !== 'error'
    } catch (cause) {
      if (aliveRef.current && currentProjectIdRef.current === sendingProjectId) {
        setError(messageOf(cause, SEND_FAILED))
      }
      return false
    }
  }, [api, projectId])

  const openParticipant = useCallback(async (threadId: string, conversationId: string): Promise<boolean> => {
    const openingProjectId = projectId
    try {
      const response = await api.manageGroup({ action: 'openParticipant', projectId, threadId, conversationId })
      if (!aliveRef.current) return false
      if (currentProjectIdRef.current === openingProjectId) {
        setError(response.kind === 'error' ? response.message : undefined)
      }
      return response.kind === 'opened'
    } catch (cause) {
      if (aliveRef.current && currentProjectIdRef.current === openingProjectId) {
        setError(messageOf(cause, OPEN_FAILED))
      }
      return false
    }
  }, [api, projectId])
  return useMemo(
    () => ({ messages: acc.messages, threads: acc.threads, loaded, error, send, openParticipant }),
    [acc, loaded, error, send, openParticipant]
  )
}

function useGroupLoading(
  api: GroupApi,
  projectId: string,
  setAcc: Dispatch<SetStateAction<Accumulated>>,
  setLoaded: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | undefined>>
): void {
  useEffect(() => {
    let alive = true
    let receivedPush = false
    setAcc(EMPTY)
    setLoaded(false)
    setError(undefined)
    const unsubscribe = api.onGroupMessages((payload) => {
      if (!alive || payload.projectId !== projectId) return
      receivedPush = true
      setAcc((prev) => ({ messages: merge(prev.messages, payload.messages), threads: payload.threads }))
    })
    api.manageGroup({ action: 'get', projectId })
      .then((response) => {
        if (!alive) return
        if (response.kind === 'state') {
          setAcc((prev) => ({
            messages: merge(response.messages, prev.messages),
            threads: receivedPush ? prev.threads : response.threads,
          }))
        } else if (response.kind === 'error') {
          setError(response.message)
        }
        setLoaded(true)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setError(messageOf(cause, LOAD_FAILED))
        setLoaded(true)
      })
    return () => { alive = false; unsubscribe() }
  }, [api, projectId])
}
