import { useState, type KeyboardEvent } from 'react'
import type { ApprovalAskPayload, ApprovalDecision } from '../../shared/ipc.js'
import './ApprovalCard.css'

export interface ApprovalCardProps {
  readonly ask: ApprovalAskPayload
  readonly onDecide: (requestId: string, decision: ApprovalDecision) => void
  /** 這筆請求沒有對應到任何 tool block，卡片畫在對話尾端（規格 §8）。 */
  readonly unmatched?: boolean

  /**
   * 這張卡不屬於目前的對話(D2 規格 §11)。有值就在卡片頂端畫一個可點的來源標示,
   * 點了跳到那個專案與對話。
   */
  readonly origin?: { readonly label: string; readonly onJump: () => void }
}

function isNonEmpty(v: string | undefined): v is string {
  return v !== undefined && v !== ''
}

/**
 * 把 input 變成看得懂的字。JSON.stringify 對 undefined 回傳 undefined、
 * 對有環的物件會丟錯，兩種都退回 String()：批准卡片的內容再怎麼難看都必須
 * 畫得出來，這裡丟錯等於使用者連拒絕的按鈕都看不到。
 */
export function formatToolInput(input: unknown): string {
  if (input === undefined) return '（沒有參數）'
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}

/**
 * 內嵌在對話流裡的批准卡片（規格 §6：不用彈窗）。
 *
 * 文案優先用 `ask.title`：那是 SDK 產的完整提示句，SDK 的註解明說不要自己
 * 從 toolName 加 input 重建（裁決 28 保留了裁決 11 的這一條）。沒有 title 才退回
 * 工具名稱加 input。`toolUseId` 只用來對應 block，不畫在卡片上。
 *
 * y／n 快捷鍵掛在卡片根節點的 onKeyDown 上，不是 document 上。React 的合成
 * 事件只會在事件目標落在這棵子樹裡時觸發，所以「卡片（或卡片裡的按鈕）有焦點」
 * 這個條件是結構本身保證的，不必自己比對 document.activeElement。掛 document
 * 會讓使用者在輸入框裡打 y 就送出批准。
 */
export function ApprovalCard({ ask, onDecide, unmatched = false, origin }: ApprovalCardProps) {
  const allowLabel = isNonEmpty(ask.displayName) ? `允許 ${ask.displayName}` : '允許'
  /**
   * 這張卡片是否已經回答過。
   *
   * 主程序的註冊表對同一個 requestId 只認第一次回覆，第二次會記一筆「找不到
   * requestId」的錯誤。卡片本身不擋的話，手快連按兩下就會製造那筆假錯誤，
   * 而且畫面上完全看不出第一次已經送出去了。
   */
  const [answered, setAnswered] = useState<boolean>(false)

  const decide = (decision: ApprovalDecision): void => {
    if (answered) return
    setAnswered(true)
    onDecide(ask.requestId, decision)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // 有修飾鍵時放行：Cmd+Y／Ctrl+N 是瀏覽器與系統的快捷鍵，不是我們的。
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key !== 'y' && key !== 'n') return
    event.preventDefault()
    // 快捷鍵與按鈕走同一個出口，否則按鈕停用了還能用鍵盤送出第二次。
    decide(key === 'y' ? 'allow' : 'deny')
  }

  return (
    <div
      className={unmatched ? 'approval-card approval-card--unmatched' : 'approval-card'}
      role="group"
      aria-label="工具批准請求"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-testid="approval-card"
      data-request-id={ask.requestId}
      data-project-id={ask.projectId}
      data-conversation-id={ask.conversationId}
      data-tool-name={ask.toolName}
    >
      {origin === undefined ? null : (
        <button
          type="button"
          className="approval-origin"
          data-testid="approval-origin"
          onClick={origin.onJump}
        >
          {origin.label}
        </button>
      )}
      {unmatched ? (
        <p className="approval-card__notice">
          這個請求還沒對應到畫面上的工具呼叫，回答它之後對話才會繼續。
        </p>
      ) : null}

      {isNonEmpty(ask.title) ? (
        <p className="approval-card__prompt">{ask.title}</p>
      ) : (
        <div className="approval-card__prompt">
          <p className="approval-card__tool">{ask.toolName}</p>
          <pre className="approval-card__input">{formatToolInput(ask.input)}</pre>
        </div>
      )}

      {ask.reviewStatus && <p role="status">{ask.reviewStatus === 'reviewing' ? 'Agent 審核中' : ask.reviewStatus === 'checking' ? '檢查授權中' : '等你確認'} · {ask.reviewReason}</p>}
      <div className="approval-card__actions">
        <button type="button" className="primary" disabled={answered} onClick={() => decide('allow')}>
          {allowLabel}
        </button>
        <button type="button" disabled={answered} onClick={() => decide('deny')}>
          拒絕
        </button>
      </div>

      <p className="approval-card__hint">卡片有焦點時：y 允許、n 拒絕</p>
    </div>
  )
}
