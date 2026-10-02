// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard, formatToolInput } from '../src/renderer/components/ApprovalCard.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'

afterEach(cleanup)

const BASH_INPUT = {
  command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
  description: 'Write hello to cap.txt and verify',
}

function ask(over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId: 'req-1',
    projectId: 'p-1',
    conversationId: 'p-1-conv',
    toolUseId: 'toolu_01L2YCZHqTvRDmdkNpsprfCQ',
    toolName: 'Bash',
    input: BASH_INPUT,
    ...over,
  }
}

describe('formatToolInput', () => {
  it('物件排版成多行 JSON', () => {
    expect(formatToolInput({ command: 'ls' })).toBe('{\n  "command": "ls"\n}')
  })

  it('字串原樣、undefined 有明確文案', () => {
    expect(formatToolInput('ls -l')).toBe('ls -l')
    expect(formatToolInput(undefined)).toBe('（沒有參數）')
  })

  it('有環的物件不丟錯（卡片一定要畫得出來）', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => formatToolInput(cyclic)).not.toThrow()
    expect(formatToolInput(cyclic)).toContain('object')
  })
})

describe('ApprovalCard 的文案', () => {
  it('有 title 時用 title，不自己拼 toolName 加 input', () => {
    render(<ApprovalCard ask={ask({ title: '要讓 Claude 執行這個指令嗎？' })} onDecide={vi.fn()} />)
    expect(screen.getByText('要讓 Claude 執行這個指令嗎？')).not.toBeNull()
    expect(screen.queryByText('Bash')).toBeNull()
  })

  it('沒有 title 時退回工具名稱加格式化的 input', () => {
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} />)
    expect(screen.getByText('Bash')).not.toBeNull()
    const card = screen.getByTestId('approval-card')
    expect(card.textContent).toContain('echo hello > cap.txt')
    expect(card.textContent).toContain('Write hello to cap.txt and verify')
  })

  it('title 是空字串時仍退回工具名稱加 input', () => {
    render(<ApprovalCard ask={ask({ title: '' })} onDecide={vi.fn()} />)
    expect(screen.getByText('Bash')).not.toBeNull()
  })

  it('有 displayName 時按鈕是「允許 {displayName}」，沒有就是「允許」', () => {
    const { unmount } = render(
      <ApprovalCard ask={ask({ displayName: '執行指令' })} onDecide={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: '允許 執行指令' })).not.toBeNull()
    unmount()
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: '允許' })).not.toBeNull()
  })

  it('未對應的請求多一段說明，一樣有兩個按鈕（規格 §8）', () => {
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} unmatched />)
    expect(screen.getByTestId('approval-card').textContent).toContain('還沒對應到畫面上的工具呼叫')
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})

describe('ApprovalCard 的回答', () => {
  // 一張卡片只回答得了一次（見下面的「回答之後不再接受第二次」），所以兩個方向
  // 各用一張新卡片驗，不在同一張上連按。
  it('點允許送 allow，點拒絕送 deny，兩者都帶 requestId', () => {
    const allowDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-42' })} onDecide={allowDecide} />)
    fireEvent.click(screen.getByRole('button', { name: '允許' }))
    expect(allowDecide.mock.calls).toEqual([['req-42', 'allow']])

    cleanup()

    const denyDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-42' })} onDecide={denyDecide} />)
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }))
    expect(denyDecide.mock.calls).toEqual([['req-42', 'deny']])
  })

  it('卡片有焦點時 y 允許、n 拒絕，大寫也算', () => {
    const allowDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-7' })} onDecide={allowDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    expect(document.activeElement).toBe(card)
    fireEvent.keyDown(card, { key: 'y' })
    expect(allowDecide.mock.calls).toEqual([['req-7', 'allow']])

    cleanup()

    const denyDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-7' })} onDecide={denyDecide} />)
    const second = screen.getByTestId('approval-card')
    second.focus()
    fireEvent.keyDown(second, { key: 'N' })
    expect(denyDecide.mock.calls).toEqual([['req-7', 'deny']])
  })

  it('焦點在卡片外的元素時，y／n 不生效', () => {
    const onDecide = vi.fn()
    render(
      <div>
        <input data-testid="outside" />
        <ApprovalCard ask={ask()} onDecide={onDecide} />
      </div>
    )
    const outside = screen.getByTestId('outside')
    outside.focus()
    expect(document.activeElement).toBe(outside)
    fireEvent.keyDown(outside, { key: 'y' })
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('卡片裡的按鈕有焦點時 y／n 一樣生效（事件從子節點冒上來）', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-9' })} onDecide={onDecide} />)
    const allow = screen.getByRole('button', { name: '允許' })
    allow.focus()
    fireEvent.keyDown(allow, { key: 'y' })
    expect(onDecide.mock.calls).toEqual([['req-9', 'allow']])
  })

  it('帶修飾鍵的 y／n 不算（Cmd+Y 是系統快捷鍵）', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    fireEvent.keyDown(card, { key: 'y', metaKey: true })
    fireEvent.keyDown(card, { key: 'n', ctrlKey: true })
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('其他按鍵不觸發任何決定', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    for (const key of ['a', 'Enter', 'Escape', ' ']) {
      fireEvent.keyDown(card, { key })
    }
    expect(onDecide).not.toHaveBeenCalled()
  })
})

describe('ApprovalCard 回答之後不再接受第二次', () => {
  it('連按兩次允許只送出一次決定，兩顆按鈕都停用', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const allow = screen.getByRole('button', { name: '允許' })
    const deny = screen.getByRole('button', { name: '拒絕' })

    fireEvent.click(allow)
    fireEvent.click(allow)

    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(onDecide).toHaveBeenCalledWith('req-1', 'allow')
    expect((allow as HTMLButtonElement).disabled).toBe(true)
    expect((deny as HTMLButtonElement).disabled).toBe(true)
  })

  it('按下允許之後再按拒絕不再送出第二個決定', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)

    fireEvent.click(screen.getByRole('button', { name: '允許' }))
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }))

    expect(onDecide).toHaveBeenCalledTimes(1)
  })

  it('回答之後 y／n 快捷鍵也不再送出決定', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()

    fireEvent.keyDown(card, { key: 'y' })
    fireEvent.keyDown(card, { key: 'y' })
    fireEvent.keyDown(card, { key: 'n' })

    expect(onDecide).toHaveBeenCalledTimes(1)
  })
})


describe('別的對話的批准卡', () => {
  it('有 origin 時畫出標示,點了呼叫 onJump', async () => {
    const onJump = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={() => {}} origin={{ label: 'proj5 · B', onJump }} />)
    const button = screen.getByRole('button', { name: 'proj5 · B' })
    fireEvent.click(button)
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('沒有 origin 時不畫標示', () => {
    render(<ApprovalCard ask={ask()} onDecide={() => {}} />)
    expect(screen.queryByTestId('approval-origin')).toBeNull()
  })
})
