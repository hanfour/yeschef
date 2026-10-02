import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalAskPayload, ApprovalDecision, YesChefApi } from '../../shared/ipc.js'

export interface Approvals {
  /** 目前這個對話的待決請求。 */
  readonly pending: readonly ApprovalAskPayload[]
  /**
   * 其他對話(含其他專案)的待決請求,依到達順序。D2 規格 §11:批准一律送到
   * 人正在看的畫面,不再扣住等人切過去。
   */
  readonly foreign: readonly ApprovalAskPayload[]
  reply(requestId: string, decision: ApprovalDecision): void
}

/**
 * 待回答的批准請求:主行程 registry 的鏡像。
 *
 * 三個訂閱:
 * - `onApprovalAsk`:到達順序累積,每筆帶 `projectId`,不可變地換新陣列
 * - `onApprovalSettled`:主行程說某筆了結了(回覆、逾時、denyAll),就拿掉那一筆
 * - `onSessionState`:只訂閱不動作,保留給之後需要時用;了結一律以 settled 為準
 *
 * 沒有任何「清空」動作。切對話只是換 `conversationId` 這個過濾條件:切走的卡移到 foreign,
 * 切回來再移回 pending(RESULTS-08 記的那個窄窗口就是這樣補起來的)。先前在切換時
 * 清空的作法有時序問題:`projects:state` 與新專案的 ask 同一批到達時,清空會把剛到
 * 的卡一起清掉。鏡像設計下兩則各自更新自己的狀態,沒有東西可以搶跑。
 *
 * 移除只是「不再顯示」,不是「代替使用者回答」:了結那一筆在主程序已經有結果,
 * renderer 這邊再送回覆只會撞到一個不存在的 requestId。
 */
export function useApprovals(api: YesChefApi, conversationId: string | null): Approvals {
  const [all, setAll] = useState<readonly ApprovalAskPayload[]>([])

  const touched = useRef(new Set<string>())
  useEffect(() => {
    let alive = true
    touched.current = new Set()
    const offAsk = api.onApprovalAsk((ask) => {
      touched.current.add(ask.requestId)
      setAll((prev) => prev.some((p) => p.requestId === ask.requestId) ? prev.map(p => p.requestId === ask.requestId ? ask : p) : [...prev, ask])
    })
    const offSettled = api.onApprovalSettled(({ requestId }) => {
      touched.current.add(requestId)
      setAll((prev) => prev.some((p) => p.requestId === requestId) ? prev.filter((p) => p.requestId !== requestId) : prev)
    })
    api.getApprovals().then((initial) => {
      if (!alive) return
      setAll((prev) => {
        const restored = initial.filter((ask) => !touched.current.has(ask.requestId))
        return restored.length === 0 ? prev : [...restored, ...prev]
      })
    }).catch((cause: unknown) => {
      if (alive) console.error('讀取批准請求失敗', cause)
    })
    return () => { alive = false; offAsk(); offSettled() }
  }, [api])

  useEffect(() => api.onSessionState(() => {}), [api])

  const pending = useMemo(
    () => (conversationId === null ? [] : all.filter((a) => a.conversationId === conversationId)),
    [all, conversationId]
  )

  const foreign = useMemo(
    () => all.filter((a) => a.conversationId !== conversationId),
    [all, conversationId]
  )

  const reply = useCallback(
    (requestId: string, decision: ApprovalDecision): void => {
      touched.current.add(requestId)
      api.replyApproval({ requestId, decision })
      setAll((prev) => prev.filter((p) => p.requestId !== requestId))
    },
    [api]
  )

  return useMemo(() => ({ pending, foreign, reply }), [pending, foreign, reply])
}
