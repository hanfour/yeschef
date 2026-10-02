import { formatCost, type ConversationCost } from '../format-cost.js'
import './StatusBar.css'

export type { ConversationCost }

export interface StatusBarProps {
  /** 全部專案加起來,回合進行中的對話數。 */
  readonly busy: number
  /** 全部專案加起來,有批准在等的對話數。 */
  readonly pending: number
  /** 未決的同伴提問筆數。 */
  readonly peerPending: number
  /** 前景那個對話的花費;還沒有就不給。 */
  readonly cost?: ConversationCost
  /** 提供跳轉後，使用者不必逐一找出正在執行的對話。 */
  readonly onJumpToBusy?: () => void
  /** 有給而且 pending 大於零時,「待批准」是可點的。 */
  readonly onJumpToPending?: () => void
}

/**
 * 視窗底部那一條。只負責顯示,不自己訂閱任何東西:數字由 App 從既有的
 * `projects:state` 與 `peer:state` 算好交下來(設計 §4 增量 1)。
 *
 * 沒有資料的欄位整個不畫,不畫 0 也不畫佔位符號:狀態列的用處是「一眼看出有事」,
 * 一排零會讓有事的那個數字混在裡面。閒置時顯示就緒,高度維持不變。
 */
export function StatusBar({ busy, pending, peerPending, cost, onJumpToPending, onJumpToBusy }: StatusBarProps) {
  const busyLabel = `${String(busy)} 個進行中`
  const pendingLabel = `${String(pending)} 個待批准`
  return (
    <footer className="status-bar">
      {busy === 0 && pending === 0 && peerPending === 0 && <span className="status-idle">就緒</span>}
      {busy > 0
        ? onJumpToBusy === undefined
          ? <span className="status-item">{busyLabel}</span>
          : <button type="button" className="status-item status-busy" onClick={onJumpToBusy}>{busyLabel}</button>
        : null}
      {pending > 0
        ? onJumpToPending === undefined
          ? <span className="status-item status-pending">{pendingLabel}</span>
          : (
            <button type="button" className="status-item status-pending" onClick={onJumpToPending}>
              {pendingLabel}
            </button>
          )
        : null}
      {peerPending > 0 ? <span className="status-item">{String(peerPending)} 則同伴提問</span> : null}
      {cost === undefined ? null : <span className="status-item status-cost">{formatCost(cost)}</span>}
    </footer>
  )
}
