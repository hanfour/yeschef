import { useEffect, useRef, useState } from 'react'
import { formatElapsed } from './relative-time.js'
import { formatValue } from './ToolCall.js'
import type { ToolBlock } from './block-equals.js'
import './HandoffCard.css'

export interface HandoffCardProps {
  readonly block: ToolBlock
  readonly historical: boolean
  readonly onDone: (toolUseId: string) => void
  /** 測試注入；預設 Date.now。 */
  readonly now?: () => number
}

export const HANDOFF_BUTTON_TEXT = '我好了'
export const HANDOFF_NOTIFIED_TEXT = '已通知'
export const HANDOFF_INCOMPLETE_TEXT = '未完成（對話中途結束）'
export const HANDOFF_PREPARING_TEXT = '準備交接…'
export const HANDOFF_NO_REASON_TEXT = '（未說明理由）'

const TITLE_TEXT = '交接給使用者'
const DENIED_FALLBACK_TEXT = '已拒絕'
const TICK_MS = 30_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function reasonOf(input: unknown): string {
  if (!isRecord(input)) return HANDOFF_NO_REASON_TEXT
  const reason = input.reason
  return typeof reason === 'string' && reason !== '' ? reason : HANDOFF_NO_REASON_TEXT
}

function resultTextOf(result: unknown): string {
  if (!Array.isArray(result)) return formatValue(result)
  const first: unknown = result[0]
  if (!isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') return formatValue(result)
  return first.text
}

type Phase = 'preparing' | 'pending' | 'stale' | 'done' | 'error' | 'denied'

function phaseOf(status: ToolBlock['status'], historical: boolean): Phase {
  switch (status) {
    case 'streaming-input': return 'preparing'
    case 'running':
    case 'awaiting-approval': return historical ? 'stale' : 'pending'
    case 'done': return 'done'
    case 'error': return 'error'
    case 'denied': return 'denied'
  }
}

const MODIFIER: Record<Phase, string> = {
  preparing: 'pending', pending: 'pending', stale: 'stale', done: 'done', error: 'error', denied: 'error',
}

function resultOf(phase: Phase, block: ToolBlock): string | undefined {
  switch (phase) {
    case 'preparing':
    case 'pending': return undefined
    case 'stale': return HANDOFF_INCOMPLETE_TEXT
    case 'denied': return block.deniedReason ?? DENIED_FALLBACK_TEXT
    case 'done':
    case 'error': return resultTextOf(block.result)
  }
}

export function HandoffCard({ block, historical, onDone, now = Date.now }: HandoffCardProps) {
  const phase = phaseOf(block.status, historical)
  const [mountedAt] = useState<number>(now)
  const [tick, setTick] = useState<number>(now)
  const [notified, setNotified] = useState(false)
  // 同一批次連點兩次時 state 尚未更新，只靠 state 擋不住，因此另外用 ref 記旗標。
  const notifiedRef = useRef(false)
  const nowRef = useRef(now)

  useEffect(() => { nowRef.current = now }, [now])
  useEffect(() => {
    if (phase !== 'pending') return undefined
    const id = setInterval(() => setTick(nowRef.current()), TICK_MS)
    return () => clearInterval(id)
  }, [phase])

  // 同一批次連點兩次時讀到的 state 仍是 false，必須先檢查 ref 才能只通知一次。
  const done = (): void => {
    if (notifiedRef.current) return
    notifiedRef.current = true
    setNotified(true)
    onDone(block.id)
  }

  const result = resultOf(phase, block)
  return (
    <div className={`handoff-card handoff-card--${MODIFIER[phase]}`} role="group" aria-label="交接給使用者" data-testid="handoff-card" data-tool-use-id={block.id}>
      <p className="handoff-card__title">{TITLE_TEXT}</p>
      <p className="handoff-card__reason">{phase === 'preparing' ? HANDOFF_PREPARING_TEXT : reasonOf(block.input)}</p>
      {phase === 'pending' && <p className="handoff-card__elapsed">已等待 {formatElapsed(tick - mountedAt)}</p>}
      {result !== undefined && <p className="handoff-card__result">{result}</p>}
      {phase === 'pending' && (
        <button type="button" className="handoff-card__button" disabled={notified} onClick={done}>
          {notified ? HANDOFF_NOTIFIED_TEXT : HANDOFF_BUTTON_TEXT}
        </button>
      )}
    </div>
  )
}
