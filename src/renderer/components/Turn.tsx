import { Fragment, memo, useState, type ReactNode } from 'react'
import type { Block, Turn as TurnModel } from '../../shared/fold.js'
import type { YesChefApi } from '../../shared/ipc.js'
import { TranslateBar } from './TranslateBar.js'
import { Markdown } from './Markdown.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { CompactBoundary } from './CompactBoundary.js'
import { PeerQuestion, type PeerQuestionStatus } from './PeerQuestion.js'
import { CompactSummary } from './CompactSummary.js'
import { ToolCall, formatValue } from './ToolCall.js'
import { blocksEqual, type ToolBlock } from './block-equals.js'

export interface TurnProps {
  readonly translate?: YesChefApi['translate']
  readonly peerFor?: (questionId: string) => { status?: PeerQuestionStatus; onAnswer?: (text: string) => void; onCancel?: () => void }

  readonly turn: TurnModel
  readonly historical: boolean
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
  /** 回傳非 undefined 時取代預設的 ToolCall（整張卡）。裁決 2（docs/superpowers/plan-b/CONTRACT.md） */
  readonly renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined
  /** assistant 那一側的標示。codex 對話給 'codex';沒給就是 Claude。 */
  readonly assistantLabel?: string
}

interface RenderOptions {
  readonly translate: TurnProps['translate']
  /** 只有 assistant 的文字要翻譯:使用者自己打的字不需要,多一顆按鈕只是雜訊。 */
  readonly role: TurnModel['role']
  readonly peerFor: TurnProps['peerFor']
  readonly historical: boolean
  readonly renderToolExtra: ((block: ToolBlock) => ReactNode) | undefined
  readonly renderToolOverride: ((block: ToolBlock, historical: boolean) => ReactNode | undefined) | undefined
}

/** 規格 §8：認不出來的事件渲染成可展開的原始 JSON，不靜默丟棄。 */
function UnknownBlock({ raw }: { readonly raw: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="unknown-block">
      <button
        type="button"
        className="unknown-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        未知事件
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && <pre className="unknown-raw">{formatValue(raw)}</pre>}
    </section>
  )
}

function renderBlock(block: Block, index: number, opts: RenderOptions) {
  const { historical, renderToolExtra, renderToolOverride, peerFor } = opts
  switch (block.kind) {
    case 'text':
      return <Fragment key={index}>
        <Markdown markdown={block.markdown} complete={block.complete} />
        {opts.role === 'assistant' && block.complete === true && opts.translate !== undefined &&
          <TranslateBar key={block.markdown} text={block.markdown} translate={opts.translate} />}
      </Fragment>
    case 'thinking':
      return <ThinkingBlock key={index} text={block.text} complete={block.complete} />
    case 'tool': {
      const override = renderToolOverride?.(block, historical)
      if (override !== undefined) return <Fragment key={index}>{override}</Fragment>
      return (
        <ToolCall
          key={index}
          block={block}
          historical={historical}
          {...(renderToolExtra === undefined ? {} : { renderExtra: renderToolExtra })}
        />
      )
    }
    case 'peer-question': {
      const extra = historical ? {} : peerFor?.(block.questionId) ?? {}
      return <PeerQuestion key={index} question={block} {...extra} />
    }
    case 'compact-summary':
      return <CompactSummary key={index} text={block.text} />
    case 'compact-boundary':
      return (
        <CompactBoundary
          key={index}
          trigger={block.trigger}
          preTokens={block.preTokens}
          {...(block.postTokens === undefined ? {} : { postTokens: block.postTokens })}
        />
      )
    case 'unknown':
      return <UnknownBlock key={index} raw={block.raw} />
  }
}

export const DEFAULT_ASSISTANT_LABEL = 'Claude'

/**
 * 壓縮摘要與同伴提問的 role 都是 user,但都不是使用者說的話。整個 turn 只有那一種
 * 區塊時換標籤,否則畫面會把它們掛在「你」名下。
 */
function roleLabel(turn: TurnModel, assistantLabel: string): string {
  const only = (kind: Block['kind']): boolean => turn.blocks.length > 0 && turn.blocks.every((b) => b.kind === kind)
  if (only('compact-summary')) return '系統'
  if (only('peer-question')) return '同伴提問'
  return turn.role === 'user' ? '你' : assistantLabel
}

function TurnImpl({ turn, historical, translate, renderToolExtra, renderToolOverride, peerFor, assistantLabel = DEFAULT_ASSISTANT_LABEL }: TurnProps) {
  const opts: RenderOptions = { historical, translate, role: turn.role, renderToolExtra, renderToolOverride, peerFor }
  return (
    <article className={'turn turn-' + turn.role}>
      <div className="turn-role">{roleLabel(turn, assistantLabel)}</div>
      <div className="turn-blocks">
        {turn.blocks.map((block, i) => renderBlock(block, i, opts))}
      </div>
    </article>
  )
}

export const Turn = memo(
  TurnImpl,
  (prev, next) =>
    prev.translate === next.translate &&
    prev.peerFor === next.peerFor &&
    prev.historical === next.historical &&
    prev.assistantLabel === next.assistantLabel &&
    prev.renderToolExtra === next.renderToolExtra &&
    prev.renderToolOverride === next.renderToolOverride &&
    prev.turn.role === next.turn.role &&
    prev.turn.messageId === next.turn.messageId &&
    blocksEqual(prev.turn.blocks, next.turn.blocks)
)
