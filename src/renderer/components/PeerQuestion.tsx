import { useState } from 'react'
import type { PeerInjection } from '../../shared/peer-tools.js'
import './PeerQuestion.css'

export type PeerQuestionStatus =
  | { readonly kind: 'waiting'; readonly waitedSeconds: number }
  | { readonly kind: 'answered' }
  | { readonly kind: 'cancelled'; readonly reason: string }

export interface PeerQuestionProps {
  readonly question: PeerInjection
  /** 沒有給就不畫狀態列:歷史檢視拿不到狀態時就是這樣。 */
  readonly status?: PeerQuestionStatus
  readonly onAnswer?: (text: string) => void
  readonly onCancel?: () => void
}

function statusText(status: PeerQuestionStatus): string {
  if (status.kind === 'waiting') return `等你回答，對方已等 ${String(status.waitedSeconds)} 秒`
  if (status.kind === 'answered') return '已回答'
  return `已取消:${status.reason}`
}

/** 同伴提問自成一輪(P 規格 §6.2)。未決時可由人代替回答或取消。 */
export function PeerQuestion({ question, status, onAnswer, onCancel }: PeerQuestionProps) {
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState('')
  const canAct = onAnswer !== undefined && onCancel !== undefined && status?.kind === 'waiting'

  return (
    <section className="peer-question">
      <div className="peer-question-head" data-testid="peer-from">
        {question.provider} · {question.fromLinkId}
      </div>
      <div className="peer-question-text">{question.text}</div>
      {status === undefined ? null : (
        <div className="peer-question-status" data-testid="peer-status">{statusText(status)}</div>
      )}
      {!canAct ? null : (
        <div className="peer-question-actions">
          {drafting ? (
            <>
              <textarea
                className="peer-question-draft"
                aria-label="代替回答的內容"
                rows={3}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const trimmed = draft.trim()
                  if (trimmed === '') return
                  onAnswer(trimmed)
                  setDraft('')
                  setDrafting(false)
                }}
              >
                送出
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setDrafting(true)}>代替回答</button>
          )}
          <button type="button" onClick={onCancel}>取消</button>
        </div>
      )}
    </section>
  )
}
