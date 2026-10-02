import type { YesChefApi } from '../../shared/ipc.js'
import type { PeerQuestionStatus } from './PeerQuestion.js'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversationView } from '../../shared/fold.js'
import { Turn } from './Turn.js'
import type { ToolBlock } from './block-equals.js'
import './Conversation.css'
import { formatCost } from '../format-cost.js'

export type { ToolBlock }

/**
 * 距離底部多少像素以內仍算「貼底」。
 *
 * 不設容差的話，逐字串流時每多一個字就把清單撐高一點，使用者手指還沒離開就被判成
 * 「已經離開底部」，之後的內容再也不會自動跟上。40px 大約是一行的高度。
 */
const STICK_THRESHOLD_PX = 40

export interface ConversationProps {
  readonly translate?: YesChefApi['translate']
  readonly peerFor?: (questionId: string) => { status?: PeerQuestionStatus; onAnswer?: (text: string) => void; onCancel?: () => void }

  readonly view: ConversationView
  readonly historical: boolean
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
  /** 原樣傳給 Turn：回傳非 undefined 時取代預設的 ToolCall（裁決 2）。 */
  readonly renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined
  /** assistant 那一側的標示,傳給每個 Turn。 */
  readonly assistantLabel?: string
}

export function Conversation({ view, historical, translate, renderToolExtra, renderToolOverride, peerFor, assistantLabel }: ConversationProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [away, setAway] = useState(false)
  /**
   * 使用者是否貼在底部。初值為 true：reset 之後清單是空的，空清單本來就貼底，
   * 所以開一場新對話或點開歷史對話都會落在最新一則，而不是停在頂端。
   */
  const stick = useRef<boolean>(true)

  const onScroll = (): void => {
    const el = listRef.current
    if (el === null) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
    setAway(!stick.current)
  }

  // 用 useLayoutEffect 而不是 useEffect：捲動位置要在瀏覽器繪製前就定好，
  // 否則每多一段文字都會先閃一下舊位置。使用者往上捲之後 stick 是 false，
  // 這裡什麼都不做，控制權留在使用者手上。
  useLayoutEffect(() => {
    const el = listRef.current
    if (!view.turns.length) stick.current = true
    if (el === null || !stick.current) return
    el.scrollTop = el.scrollHeight
    setAway(false)
  }, [view])

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const el = listRef.current
      if (!el || !el.clientHeight) return
      if (stick.current) el.scrollTop = el.scrollHeight
      onScroll()
    })
    if (listRef.current) observer.observe(listRef.current)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div className={`conversation-scroll-shell${!view.turns.length && !view.error ? ' is-empty' : ''}`}>
    <div className="conversation-list" ref={listRef} onScroll={onScroll}>
      <div className="conversation-content" ref={contentRef}>
      {view.turns.map((turn, i) => (
        <Turn
          key={turn.messageId ?? 'turn-' + String(i)}
          turn={turn}
          translate={translate}
          {...(peerFor === undefined ? {} : { peerFor })}
          historical={historical}
          {...(assistantLabel === undefined ? {} : { assistantLabel })}
          {...(renderToolExtra === undefined ? {} : { renderToolExtra })}
          {...(renderToolOverride === undefined ? {} : { renderToolOverride })}
        />
      ))}
      {view.error !== undefined && (
        <div className="error-card" role="alert">
          <p className="error-title">對話因錯誤結束</p>
          {view.error.message !== undefined && <p className="error-message">{view.error.message}</p>}
          {view.error.apiErrorStatus !== undefined && (
            <p className="error-status">API 狀態：{String(view.error.apiErrorStatus)}</p>
          )}
        </div>
      )}
      {view.ended && view.cost !== undefined && (
        <p className="conversation-cost">{formatCost(view.cost)}</p>
      )}
      </div>
    </div>
    {away && <button type="button" className="conversation-latest" onClick={() => {
      const el = listRef.current
      if (!el) return
      stick.current = true; el.scrollTop = el.scrollHeight; setAway(false)
    }}>↓ 回到最新訊息</button>}
    </div>
  )
}
