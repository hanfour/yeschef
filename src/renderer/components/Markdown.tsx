import { Component, memo, useContext, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { closeIncomplete } from '../../shared/markdown-stream.js'
import { previewLocationOfLink, previewPathOfLink, type PreviewLocation } from '../../shared/preview.js'
import { PreviewContext } from '../preview-context.js'
import { remarkPreviewPaths } from '../remark-preview-paths.js'
import { rehypeDocument, rehypeDocumentSearch } from '../rehype-document.js'
import './Markdown.css'

export interface MarkdownProps {
  readonly markdown: string
  readonly complete: boolean
  readonly renderImage?: (src: string, alt: string) => ReactNode
  readonly documentPath?: string
  readonly projectId?: string
  readonly onNavigate?: (location: PreviewLocation) => void
  readonly search?: string
}

// 模組層級常數，不是每次渲染重建的陣列字面量：react-markdown 拿 remarkPlugins／
// rehypePlugins 陣列的參照去判斷要不要重跑 unified 的 processor 快取，如果這兩個
// 陣列每次渲染都是新的字面量，等於每次都告訴它「外掛設定變了」，白白多一層失效。
const remarkPlugins = [remarkGfm]
const previewRemarkPlugins = [remarkGfm, remarkPreviewPaths]
const rehypePlugins = [rehypeHighlight]

interface MarkdownBoundaryProps {
  readonly markdown: string
  readonly children: ReactNode
}

interface MarkdownBoundaryState {
  readonly failed: boolean
}

/**
 * markdown 解析失敗時該 block 退回純文字，不讓整則訊息壞掉（裁決 26）。
 * React 19 仍只能用類別元件攔截子樹渲染時拋出的錯誤，沒有對應的 hooks 寫法。
 */
export class MarkdownBoundary extends Component<MarkdownBoundaryProps, MarkdownBoundaryState> {
  state: MarkdownBoundaryState = { failed: false }

  static getDerivedStateFromError(): MarkdownBoundaryState {
    return { failed: true }
  }

  componentDidUpdate(prevProps: MarkdownBoundaryProps) {
    if (this.props.markdown !== prevProps.markdown && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (this.state.failed) {
      return <pre className="markdown-fallback">{this.props.markdown}</pre>
    }
    return this.props.children
  }
}

/**
 * 把一段可能未完成的 markdown 字串渲染成內容。
 *
 * 逐字串流下每幀都可能重新收到同一個 block 的最新內容（規格 §5：逐幀整份
 * 重解析，不做增量解析）。解析前一律先過 closeIncomplete（Task 2）把奇數圍欄、
 * 未閉合的行內標記、寫到一半的表格列處理掉，再交給 react-markdown，不分
 * complete 是 true 還是 false 都跑這一步：complete 為 true 時的輸入本來就是
 * 結構完整的文字，closeIncomplete 對它是不動作（Task 2 已證明「完整文件原樣
 * 通過」），統一跑一次比分兩條路徑判斷更簡單，也不會漏掉「以為完整結果其實
 * 是舊資料」這種特殊情況。
 *
 * 不用 rehype-raw：react-markdown 預設就不把 markdown 裡的原始 HTML 解析成
 * 真的元素（模型輸出的 `<script>`／`<img onerror=...>` 會被當成文字跳脫顯示），
 * 這正是規格 §5.1 選 react-markdown 而非「轉 HTML 字串+ dangerouslySetInnerHTML」
 * 的理由。加 rehype-raw 或任何把原始 HTML 放行的外掛都會打破這個保護，本元件
 * 刻意不加。
 *
 * ReactMarkdown 外面包一層 MarkdownBoundary（裁決 26）：react-markdown 在渲染期
 * 解析失敗會拋錯，沒有它會一路炸到 React 根，一個 block 壞掉就變成整則訊息消失。
 * 接住之後改顯示原始 markdown 純文字，下一幀內容換了（markdown prop 改變）才
 * 重新嘗試解析。
 */
// 預覽圖片允許 data URL；連結仍沿用原有的 URL 過濾。
function MarkdownImpl({ markdown, complete, renderImage, documentPath, projectId, onNavigate, search = '' }: MarkdownProps) {
  const openPreview = useContext(PreviewContext)
  const documentPlugins = useMemo(() => onNavigate === undefined ? rehypePlugins :
    [rehypeHighlight, rehypeDocument, [rehypeDocumentSearch, { query: search }] as [typeof rehypeDocumentSearch, { query: string }]], [onNavigate, search])
  const components = useMemo<Components>(() => ({
    ...(renderImage === undefined ? {} : {
      img: ({ src, alt }: { src?: string | Blob; alt?: string }) => renderImage(typeof src === 'string' ? src : '', alt ?? ''),
    }),
    a: ({ href, children, title }) => {
      const path = href === undefined ? undefined : previewPathOfLink(href, documentPath)
      const location = href === undefined ? undefined : previewLocationOfLink(href)
      if (href?.startsWith('#') && onNavigate) {
        return <a href={href} title={title} onClick={event => {
          event.preventDefault()
          onNavigate(location ?? { line: 1 })
        }}>{children}</a>
      }
      return <a href={href} title={title} onClick={openPreview === undefined || path === undefined ? undefined : (event) => {
        event.preventDefault()
        openPreview({ kind: 'file', path, ...(projectId === undefined ? {} : { projectId }), ...(location === undefined ? {} : { location }) })
      }}>{children}</a>
    },
  }), [renderImage, openPreview, documentPath, projectId, onNavigate])
  const body = useMemo(() => {
    const safe = closeIncomplete(markdown)
    return (
      <MarkdownBoundary markdown={markdown}>
        <ReactMarkdown remarkPlugins={openPreview === undefined ? remarkPlugins : previewRemarkPlugins} rehypePlugins={documentPlugins}
          components={components} urlTransform={(url, key) => {
            if (key === 'src' && renderImage !== undefined) return url
            if (key === 'href' && openPreview !== undefined && previewPathOfLink(url) !== undefined) return url
            return defaultUrlTransform(url)
          }}>
          {safe}
        </ReactMarkdown>
      </MarkdownBoundary>
    )
  }, [markdown, renderImage, components, openPreview, documentPlugins])

  return (
    <div className="markdown-block">
      {body}
      {!complete && <span className="markdown-cursor" aria-hidden="true" />}
    </div>
  )
}

// 用 memo 避免重跑解析；呼叫端須維持 renderImage 的參考穩定。
export const Markdown = memo(MarkdownImpl)
