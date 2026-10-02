// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Markdown, MarkdownBoundary } from '../src/renderer/components/Markdown.js'
import { PreviewContext } from '../src/renderer/preview-context.js'

afterEach(() => {
  cleanup()
})

/** 涵蓋表格、程式碼圍欄、行內程式碼、粗體四種語法，跟 Task 2 的 CRAFTED 同一份文件。 */
const CRAFTED = [
  '# 標題',
  '',
  '這是一段**粗體**與 `行內程式碼` 的文字。',
  '',
  '| 欄位 | 說明 |',
  '|---|---|',
  '| foo | 第一列 |',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '結尾，含 `token` 與 **強調**。',
].join('\n')

describe('Markdown', () => {
  it('表格渲染成對應的 DOM 元素', () => {
    const { container } = render(
      <Markdown markdown={'| a | b |\n|---|---|\n| 1 | 2 |'} complete />
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  it('程式碼區塊渲染成 pre/code 並套用語法高亮', () => {
    const { container } = render(<Markdown markdown={'```js\nconst x = 1\n```'} complete />)
    expect(container.querySelector('pre code')).not.toBeNull()
    // 語法高亮的 span 存在，確認 rehype-highlight 真的接上了，不是只有 <pre><code> 空殼
    expect(container.querySelector('.hljs-keyword')).not.toBeNull()
  })

  it('行內程式碼渲染成 code，且不在 pre 裡面', () => {
    const { container } = render(<Markdown markdown="hello `world`" complete />)
    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.closest('pre')).toBeNull()
  })

  it('complete 為 false 時尾端有游標，為 true 時沒有', () => {
    const streaming = render(<Markdown markdown="hi" complete={false} />)
    expect(streaming.container.querySelector('.markdown-cursor')).not.toBeNull()

    const done = render(<Markdown markdown="hi" complete />)
    expect(done.container.querySelector('.markdown-cursor')).toBeNull()
  })

  it('原始 <script> 不會被執行，只以文字呈現', () => {
    const { container } = render(
      <Markdown markdown="before <script>alert(1)</script> after" complete />
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('帶 onerror 的 <img> 不會被建成真的 DOM 元素', () => {
    const { container } = render(
      <Markdown markdown="<img src=x onerror=alert(1)>" complete />
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('空字串不拋錯，渲染出空內容', () => {
    expect(() => {
      const { container } = render(<Markdown markdown="" complete={false} />)
      expect(container.textContent).toBe('')
    }).not.toThrow()
  })

  it('未完成的 markdown 不會讓元件崩潰：每個前綴都渲染出東西且不拋錯', () => {
    // i 從 0 起算：空字串是串流的第一幀，那一幀也不可以拋錯。
    for (let i = 0; i <= CRAFTED.length; i += 1) {
      const prefix = CRAFTED.slice(0, i)
      expect(() => {
        const { container, unmount } = render(<Markdown markdown={prefix} complete={false} />)
        // 用「掛了一個元素」而非「文字不為空」判斷有渲染出東西：
        // 單一 `#`（合法但無文字的 ATX 標題）這種前綴，textContent 是空的，
        // 但 wrapper 底下確實掛了 <h1></h1>，不是渲染失敗。
        // 空字串（i 為 0）例外：沒有內容就沒有元素可掛，不拋錯就算通過。
        if (i > 0) expect(container.firstElementChild).not.toBeNull()
        unmount()
      }).not.toThrow()
    }
    // 逾時明確給 30 秒：這一條要渲染 CRAFTED 的每一個前綴，單獨跑約 1.5 秒，
    // 全套平行時會超過 vitest 預設的 5 秒。同 markdown-stream.test.ts:154。
  }, 30_000)

  // 這一條專門擋「拿掉 closeIncomplete 這一步」的錯誤實作：
  // 表格資料列送到一半（`| f`，還沒收到第二欄與收尾的 |）時，
  // closeIncomplete 會把這一列整條扣住，畫面只有表頭；
  // 拿掉這一步，remark-gfm 會把 `| f` 當成一列已完成的資料列直接渲染出 <td>f</td>，
  // 使用者會看到半列資料閃一下，下一個 token 到齊後內容才「跳一下」變成正確的列。
  it('串流中的表格資料列在收尾前不會提前渲染出資料格', () => {
    const partial = '| 欄位 | 說明 |\n|---|---|\n| f'
    const { container } = render(<Markdown markdown={partial} complete={false} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('tbody')).toBeNull()
    expect(container.querySelectorAll('td')).toHaveLength(0)
  })

  // 這一條專門擋「memo 的依賴陣列寫錯」（例如把 [markdown] 誤寫成 []）：
  // 那樣的錯誤實作會讓元件第一次渲染後就再也不重新解析，畫面卡在第一幀，
  // 逐字串流會整段停住不動。
  it('markdown 內容改變時，畫面要換成新內容（防止 memo 依賴寫錯）', () => {
    const { container, rerender } = render(<Markdown markdown="第一段" complete={false} />)
    expect(container.textContent).toContain('第一段')

    rerender(<Markdown markdown="第一段，接上更多字" complete={false} />)
    expect(container.textContent).toContain('第一段，接上更多字')
  })
})

// 裁決 26：markdown 解析失敗時該 block 退回純文字，不讓整則訊息壞掉。
// 直接掛載 MarkdownBoundary（不經過 Markdown），子元件在 render() 就 throw，
// 用來確認退回邏輯本身，跟 react-markdown 會不會真的拋錯是兩回事。
describe('MarkdownBoundary', () => {
  function Boom(): never {
    throw new Error('boom')
  }

  it('子元件渲染拋錯時，退回顯示傳入的 markdown 純文字', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <MarkdownBoundary markdown={'# 標題\n\n未完成的 **粗體**'}>
        <Boom />
      </MarkdownBoundary>
    )
    const fallback = container.querySelector('pre.markdown-fallback')
    expect(fallback).not.toBeNull()
    expect(fallback?.textContent).toBe('# 標題\n\n未完成的 **粗體**')
    consoleError.mockRestore()
  })

  it('markdown 換掉之後重設，children 不再拋錯時改顯示 children', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container, rerender } = render(
      <MarkdownBoundary markdown="第一段">
        <Boom />
      </MarkdownBoundary>
    )
    expect(container.querySelector('pre.markdown-fallback')).not.toBeNull()

    rerender(
      <MarkdownBoundary markdown="第二段">
        <p>正常內容</p>
      </MarkdownBoundary>
    )
    expect(container.querySelector('pre.markdown-fallback')).toBeNull()
    expect(container.textContent).toContain('正常內容')
    consoleError.mockRestore()
  })
})

it('沒有 renderImage 時相對圖片維持原樣', () => {
  const { container } = render(<Markdown markdown="![a](x.png)" complete />)
  expect(container.querySelector('img')?.getAttribute('src')).toBe('x.png')
})

it('renderImage 更新時重繪圖片', () => {
  const { container, rerender } = render(<Markdown markdown="![a](x.png)" complete renderImage={(src, alt) => <span>{`${alt}:${src}`}</span>} />)
  expect(container.textContent).toBe('a:x.png')
  rerender(<Markdown markdown="![a](x.png)" complete renderImage={() => <span>更新</span>} />)
  expect(container.textContent).toBe('更新')
})

it('文件連結與行內路徑開右側預覽，行號不當作檔名', () => {
  const open = vi.fn()
  render(<PreviewContext.Provider value={open}><Markdown complete markdown={'[報告](docs/report.md:12)\n\n`docs/report.md:12:3`\n\n[絕對路徑](/project/report.md#L12)'} /></PreviewContext.Provider>)
  for (const name of ['報告', 'docs/report.md:12:3', '絕對路徑']) {
    expect(fireEvent.click(screen.getByRole('link', { name }))).toBe(false)
  }
  expect(open.mock.calls).toEqual([
    [{ kind: 'file', path: 'docs/report.md', location: { line: 12 } }],
    [{ kind: 'file', path: 'docs/report.md', location: { line: 12 } }],
    [{ kind: 'file', path: '/project/report.md', location: { line: 12 } }],
  ])
})

it('圍欄、既有連結標籤與遠端網址不會被誤轉成本機預覽', () => {
  const open = vi.fn()
  const { container } = render(<PreviewContext.Provider value={open}><Markdown complete markdown={'```\ndocs/report.md\n```\n\n[`README.md`](https://example.com/README.md)\n\n[x](javascript:alert%281%29)'} /></PreviewContext.Provider>)
  expect(container.querySelector('pre a')).toBeNull()
  expect(container.querySelector('a a')).toBeNull()
  const remote = screen.getByRole('link', { name: 'README.md' })
  expect(remote.getAttribute('href')).toBe('https://example.com/README.md')
  fireEvent.click(remote)
  expect(open).not.toHaveBeenCalled()
  expect(container.querySelectorAll('a')[1]?.getAttribute('href')).toBe('')
})
