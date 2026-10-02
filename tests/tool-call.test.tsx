// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PreviewContext, type OpenPreviewRequest } from '../src/renderer/preview-context.js'
import { ToolCall } from '../src/renderer/components/ToolCall.js'
import { ASK_PEER_TOOL, ANSWER_PEER_TOOL } from '../src/shared/peer-tools.js'
import type { ToolBlock } from '../src/renderer/components/block-equals.js'

afterEach(cleanup)

const block = (over: Partial<ToolBlock>): ToolBlock => ({
  kind: 'tool', id: 't1', name: 'Bash', input: {}, status: 'running', ...over,
} as ToolBlock)

describe('ask_peer 的等待狀態', () => {
  it('執行中時狀態字是「等同伴回答,已等 0 秒」', () => {
    render(<ToolCall block={block({ name: ASK_PEER_TOOL })} historical={false} />)
    expect(screen.getByText('等同伴回答，已等 0 秒')).not.toBeNull()
  })

  it('完成之後回到一般狀態字', () => {
    render(<ToolCall block={block({ name: ASK_PEER_TOOL, status: 'done' })} historical={false} />)
    expect(screen.getByText('完成')).not.toBeNull()
  })

  it('別的工具執行中還是「執行中」', () => {
    render(<ToolCall block={block({ name: 'Bash' })} historical={false} />)
    expect(screen.getByText('執行中')).not.toBeNull()
  })
})

it('renderExtra 的內容畫在 tool block 底下', () => {
  render(
    <ToolCall
      block={block({ name: ASK_PEER_TOOL })}
      historical={false}
      renderExtra={() => <button type="button">代替回答</button>}
    />
  )
  expect(screen.getByRole('button', { name: '代替回答' })).not.toBeNull()
})

it('answer_peer 工具名顯示回答同伴', () => {
  render(<ToolCall block={block({ name: ANSWER_PEER_TOOL })} historical={false} />)
  expect(screen.getByText('回答同伴')).toBeTruthy()
})

it('codex 的裸名也認得:ask_peer 顯示等待秒數', () => {
  render(<ToolCall block={block({ name: 'ask_peer' })} historical={false} />)
  expect(screen.queryByText('等同伴回答，已等 0 秒')).not.toBeNull()
})

it('codex 的裸名也認得:answer_peer 顯示「回答同伴」', () => {
  render(<ToolCall block={block({ name: 'answer_peer', status: 'done' })} historical={false} />)
  expect(screen.queryByText('回答同伴')).not.toBeNull()
})

describe('工具結果裡的圖片', () => {
  const shotResult = [
    { type: 'text', text: '可視範圍 799×833' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]

  it('畫成 <img>,不把 base64 印成文字', () => {
    const { container } = render(<ToolCall block={block({ status: 'done', result: shotResult })} historical={false} />)
    const head = container.querySelector('.tool-head')
    if (head === null) throw new Error('找不到工具卡片標頭')
    fireEvent.click(head)
    const img = container.querySelector('.tool-image img')
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(container.querySelector('.tool-result')?.textContent).not.toContain('"AAAA"')
  })

  it('沒有圖的結果照舊', () => {
    const { container } = render(<ToolCall block={block({ status: 'done', result: 'ok' })} historical={false} />)
    const head = container.querySelector('.tool-head')
    if (head === null) throw new Error('找不到工具卡片標頭')
    fireEvent.click(head)
    expect(container.querySelector('.tool-image')).toBeNull()
  })
})

describe('開預覽的入口', () => {
  const shotResult = [
    { type: 'text', text: '可視範圍 799×833' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]

  const withContext = (ui: React.ReactElement) => {
    const opened: OpenPreviewRequest[] = []
    const utils = render(<PreviewContext.Provider value={(r) => { opened.push(r) }}>{ui}</PreviewContext.Provider>)
    return { opened, ...utils }
  }

  it('截圖旁的按鈕送出 image 請求', () => {
    const { opened, container } = withContext(<ToolCall block={block({ id: 't9', status: 'done', result: shotResult })} historical={false} />)
    const head = container.querySelector('.tool-head')
    if (head === null) throw new Error('找不到工具卡片標頭')
    fireEvent.click(head)
    fireEvent.click(screen.getByRole('button', { name: '在側邊預覽開啟' }))
    expect(opened).toEqual([{ kind: 'image', dataUrl: 'data:image/png;base64,AAAA', key: 't9:0' }])
  })

  it('Write 寫了一份 Markdown,收合時也看得到「預覽」', () => {
    const { opened } = withContext(<ToolCall block={block({ name: 'Write', status: 'done', input: { file_path: '/p/docs/a.md', content: '# x' } })} historical={false} />)
    fireEvent.click(screen.getByRole('button', { name: '預覽' }))
    expect(opened).toEqual([{ kind: 'file', path: '/p/docs/a.md' }])
  })

  it('codex 截圖用 path 欄位', () => {
    const { opened } = withContext(<ToolCall block={block({ name: '截圖', status: 'done', input: { path: '/p/shot.png' } })} historical={false} />)
    fireEvent.click(screen.getByRole('button', { name: '預覽' }))
    expect(opened).toEqual([{ kind: 'file', path: '/p/shot.png' }])
  })

  it('副檔名不能預覽就不畫', () => {
    withContext(<ToolCall block={block({ name: 'Write', status: 'done', input: { file_path: '/p/run.sh' } })} historical={false} />)
    expect(screen.queryByRole('button', { name: '預覽' })).toBeNull()
  })

  it('沒有 Provider 就兩顆都不畫', () => {
    render(<ToolCall block={block({ name: 'Write', status: 'done', input: { file_path: '/p/a.md' } })} historical={false} />)
    expect(screen.queryByRole('button', { name: '預覽' })).toBeNull()
  })
})

describe('檔案還沒改好時不畫預覽', () => {
  it('Edit 在等批准或還在串流參數時沒有「預覽」,done 之後才有', () => {
    const input = { file_path: '/p/a.md', old_string: 'x', new_string: 'y' }
    const opened: OpenPreviewRequest[] = []
    const { rerender } = render(
      <PreviewContext.Provider value={(r) => { opened.push(r) }}>
        <ToolCall block={block({ name: 'Edit', status: 'awaiting-approval', input })} historical={false} />
      </PreviewContext.Provider>
    )
    expect(screen.queryByRole('button', { name: '預覽' })).toBeNull()
    for (const status of ['streaming-input', 'running', 'error'] as const) {
      rerender(
        <PreviewContext.Provider value={(r) => { opened.push(r) }}>
          <ToolCall block={block({ name: 'Edit', status, input })} historical={false} />
        </PreviewContext.Provider>
      )
      expect(screen.queryByRole('button', { name: '預覽' })).toBeNull()
    }
    rerender(
      <PreviewContext.Provider value={(r) => { opened.push(r) }}>
        <ToolCall block={block({ name: 'Edit', status: 'done', input })} historical={false} />
      </PreviewContext.Provider>
    )
    expect(screen.queryByRole('button', { name: '預覽' })).not.toBeNull()
  })
})

