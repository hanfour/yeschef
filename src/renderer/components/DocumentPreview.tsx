import { useCallback, useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PreviewLocation } from '../../shared/preview.js'
import { fileNameOf } from '../../shared/preview.js'
import { Markdown } from './Markdown.js'

interface Props {
  readonly text: string
  readonly path: string
  readonly projectId: string
  readonly location?: PreviewLocation
  readonly refresh: () => void
  readonly renderImage: (src: string, alt: string) => ReactNode
}

interface Heading { anchor: string; title: string; depth: number }

function reveal(root: HTMLElement, target: HTMLElement, focus = false): void {
  root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - 16
  if (focus) {
    target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
  }
}

export function DocumentPreview({ text, path, projectId, location, refresh, renderImage }: Props) {
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  const outlineRef = useRef<HTMLDetailsElement>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const search = useDeferredValue(query)
  const [matchCount, setMatchCount] = useState(0)
  const [matchIndex, setMatchIndex] = useState(0)
  const [line, setLine] = useState('')
  const [notice, setNotice] = useState('')

  const navigate = useCallback((destination: PreviewLocation) => {
    const root = contentRef.current
    if (!root) return
    root.querySelectorAll('.preview-target').forEach(el => el.classList.remove('preview-target'))
    let target: HTMLElement | undefined
    if (destination.anchor !== undefined) {
      target = Array.from(root.querySelectorAll<HTMLElement>('[data-preview-anchor]'))
        .find(el => el.dataset.previewAnchor === destination.anchor)
      setNotice(target ? '' : `找不到章節：${destination.anchor}`)
    } else if (destination.line !== undefined) {
      const number = destination.line
      if (!Number.isSafeInteger(number) || number < 1 || number > text.split('\n').length) {
        setNotice(`行號須介於 1 與 ${text.split('\n').length} 之間`)
        return
      }
      const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-source-start]'))
      const containing = blocks.filter(el => Number(el.dataset.sourceStart) <= number && Number(el.dataset.sourceEnd) >= number)
      containing.sort((a, b) => (Number(a.dataset.sourceEnd) - Number(a.dataset.sourceStart)) - (Number(b.dataset.sourceEnd) - Number(b.dataset.sourceStart)))
      target = containing[0] ?? blocks.find(el => Number(el.dataset.sourceStart) >= number) ?? blocks.at(-1)
      setNotice(target ? `已定位至第 ${number} 行所在段落` : '文件沒有可定位的內容')
    }
    if (target) {
      target.classList.add('preview-target')
      reveal(root, target, true)
      if (outlineRef.current) outlineRef.current.open = false
    }
  }, [text])

  useLayoutEffect(() => {
    const root = contentRef.current
    if (!root) return
    setHeadings(Array.from(root.querySelectorAll<HTMLElement>('[data-preview-anchor]'), el => ({
      anchor: el.dataset.previewAnchor ?? '', title: el.textContent || '未命名章節', depth: Number(el.tagName.slice(1)),
    })))
    if (location) navigate(location)
  }, [text, location, navigate])

  useLayoutEffect(() => {
    const marks = contentRef.current?.querySelectorAll<HTMLElement>('[data-preview-match]')
    setMatchCount(new Set(Array.from(marks ?? [], el => el.dataset.previewMatch)).size)
    setMatchIndex(0)
  }, [text, search])

  useLayoutEffect(() => {
    const root = contentRef.current
    if (!root) return
    let first: HTMLElement | undefined
    root.querySelectorAll<HTMLElement>('[data-preview-match]').forEach(mark => {
      const active = Number(mark.dataset.previewMatch) === matchIndex
      mark.classList.toggle('preview-current-match', active)
      if (active && !first) first = mark
    })
    if (first) reveal(root, first)
  }, [matchIndex, matchCount, search, text])

  const moveMatch = (step: number) => {
    if (matchCount) setMatchIndex(index => (index + step + matchCount) % matchCount)
  }
  const openSearch = () => {
    setSearchOpen(true)
    searchRef.current?.focus()
  }
  const closeSearch = () => {
    setQuery('')
    setSearchOpen(false)
    searchToggleRef.current?.focus()
  }

  return <section className="document-preview" aria-label="文件預覽" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openSearch()
    }
    if (event.key === 'Escape' && searchOpen) {
      event.preventDefault()
      closeSearch()
    } else if (event.key === 'Escape' && outlineRef.current?.open) {
      outlineRef.current.open = false
      outlineRef.current.querySelector('summary')?.focus()
    }
  }}>
    <div className="document-toolbar">
      <span className="document-name" title={path}>{fileNameOf(path)}</span>
      <button ref={searchToggleRef} type="button" onClick={openSearch} aria-expanded={searchOpen}>搜尋</button>
      <button type="button" onClick={refresh} title="重新讀取檔案">重新整理</button>
    </div>
    <div className="document-navigation">
      <details ref={outlineRef} className="document-outline">
        <summary>章節目錄 <span>{headings.length}</span></summary>
        <nav aria-label="章節目錄">
          {headings.length === 0 ? <p>此文件沒有標題</p> : headings.map(heading =>
            <button type="button" key={heading.anchor} style={{ paddingLeft: `${12 + (heading.depth - 1) * 12}px` }}
              onClick={() => navigate({ anchor: heading.anchor })}>{heading.title}</button>)}
        </nav>
      </details>
      <form className="document-line" onSubmit={event => { event.preventDefault(); navigate({ line: Number(line) }) }}>
        <input aria-label="原始文件行號" placeholder="行號" type="number" min="1" max={text.split('\n').length}
          value={line} onChange={event => setLine(event.target.value)} required />
        <button type="submit">前往</button>
      </form>
    </div>
    {searchOpen && <div className="document-search">
      <input ref={searchRef} autoFocus aria-label="搜尋文件" type="search" placeholder="搜尋文件內容…" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) }
        }} />
      <output aria-live="polite">{search !== query ? '搜尋中…' : query.trim() ? `${matchCount ? matchIndex + 1 : 0} / ${matchCount}` : ''}</output>
      <button type="button" aria-label="上一個搜尋結果" disabled={!matchCount} onClick={() => moveMatch(-1)}>↑</button>
      <button type="button" aria-label="下一個搜尋結果" disabled={!matchCount} onClick={() => moveMatch(1)}>↓</button>
      <button type="button" aria-label="關閉搜尋" onClick={closeSearch}>×</button>
    </div>}
    <div className="document-notice" role="status">{notice}</div>
    <div ref={contentRef} className="preview-pane preview-markdown" tabIndex={0} aria-label="文件內容">
      <Markdown markdown={text} complete renderImage={renderImage} documentPath={path} projectId={projectId}
        onNavigate={navigate} search={search} />
    </div>
  </section>
}
