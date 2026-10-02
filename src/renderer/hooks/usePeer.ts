import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PeerPendingView, YesChefApi } from '../../shared/ipc.js'

export interface Peer {
  /** 目前所有未決的同伴提問(所有專案)。元件自己挑出與自己有關的那一則。 */
  readonly pending: readonly PeerPendingView[]
  answer(questionId: string, text: string): void
  cancel(questionId: string): void
}

/**
 * 未決的同伴提問:主行程 `PeerService` 的鏡像。整份重推,不做增量:未決問題的數量
 * 是個位數,增量的複雜度換不到什麼。
 */
export function usePeer(api: YesChefApi): Peer {
  const [pending, setPending] = useState<readonly PeerPendingView[]>([])

  useEffect(() => {
    let alive = true
    let pushed = false
    const unsubscribe = api.onPeerState((state) => {
      pushed = true
      setPending(state.pending)
    })
    api.getPeer().then((state) => {
      if (alive && !pushed) setPending(state.pending)
    }).catch((cause: unknown) => {
      if (alive) console.error('讀取同伴提問失敗', cause)
    })
    return () => { alive = false; unsubscribe() }
  }, [api])

  const answer = useCallback(
    (questionId: string, text: string): void => { api.answerPeerAsUser({ questionId, text }) },
    [api]
  )
  const cancel = useCallback(
    (questionId: string): void => { api.cancelPeer({ questionId }) },
    [api]
  )

  return useMemo(() => ({ pending, answer, cancel }), [pending, answer, cancel])
}
