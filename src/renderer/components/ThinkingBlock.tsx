import { memo, useState } from 'react'

export interface ThinkingBlockProps {
  readonly text: string
  readonly complete: boolean
}

function ThinkingBlockImpl({ text, complete }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  return (
    <section className="thinking-block">
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {complete ? '思考過程' : '思考中'}
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && <pre className="thinking-text">{text}</pre>}
    </section>
  )
}

export const ThinkingBlock = memo(ThinkingBlockImpl)
