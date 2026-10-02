import { useState } from 'react'
import { Markdown } from './Markdown.js'
import './CompactSummary.css'

/**
 * auto-compact 之後 SDK 注入的摘要。它佔的篇幅很長而且平常不需要讀,
 * 所以預設收合;要查「模型現在記得什麼」時才展開。
 */
export function CompactSummary({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="compact-summary">
      <button
        type="button"
        className="compact-summary-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        壓縮摘要
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <div className="compact-summary-body">
          <Markdown markdown={text} complete />
        </div>
      )}
    </section>
  )
}
