import { useState } from 'react'
import type { ApprovalAskPayload, ApprovalDecision } from '../../shared/ipc.js'
import './PendingStrip.css'

/** 限定在自己的 pane 查找，避免命中背景對話的副本；不把請求識別碼插進 CSS 選擇器。 */
export function jumpToApproval(root: HTMLElement | null, requestId: string): void {
  const card = Array.from(root?.querySelectorAll<HTMLElement>('.approval-card[data-request-id]') ?? [])
    .find((node) => node.dataset.requestId === requestId)
  if (card === undefined) return
  try {
    card.scrollIntoView({ block: 'center' })
  } catch {
    // 測試環境或不支援捲動的宿主仍可使用卡片的鍵盤操作。
  }
  card.focus({ preventScroll: true })
}

interface PendingStripProps {
  readonly active: readonly ApprovalAskPayload[]
  readonly reply: (requestId: string, decision: ApprovalDecision) => void
  readonly onJump: (requestId: string) => void
}

/** 每列依請求識別碼保留回答狀態，重排或其他列更新不會解除停用。 */
function PendingRow({ ask, reply, onJump }: Omit<PendingStripProps, 'active'> & { readonly ask: ApprovalAskPayload }) {
  const [answered, setAnswered] = useState(false)
  const decide = (decision: ApprovalDecision): void => {
    if (answered) return
    setAnswered(true)
    reply(ask.requestId, decision)
  }

  return (
    <div className="pending-strip__row">
      <span>{ask.toolName} 在等你批准</span>
      <div className="pending-strip__actions">
        <button type="button" disabled={answered} onClick={() => onJump(ask.requestId)}>前往</button>
        <button type="button" disabled={answered} onClick={() => decide('allow')}>允許</button>
        <button type="button" disabled={answered} onClick={() => decide('deny')}>拒絕</button>
      </div>
    </div>
  )
}

export function PendingStrip({ active, reply, onJump }: PendingStripProps) {
  return (
    <div className="pending-strip" role="region" aria-label="待批准工具">
      {active.map((ask) => (
        <PendingRow key={ask.requestId} ask={ask} reply={reply} onJump={onJump} />
      ))}
    </div>
  )
}
