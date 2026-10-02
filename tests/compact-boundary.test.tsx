// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CompactBoundary } from '../src/renderer/components/CompactBoundary.js'
import { Turn } from '../src/renderer/components/Turn.js'

afterEach(cleanup)

describe('CompactBoundary', () => {
  it('沒有 preTokens 時只畫標籤,不畫數字', () => {
    const { container, getByRole } = render(<CompactBoundary trigger="auto" />)
    expect(getByRole('separator').getAttribute('aria-label')).toBe('對話已壓縮')
    expect(container.querySelector('.compact-boundary-tokens')).toBeNull()
  })

  it('auto 觸發:顯示「對話已壓縮」與千分位的前後 token', () => {
    const { container } = render(<CompactBoundary trigger="auto" preTokens={70422} postTokens={27775} />)
    const text = container.textContent ?? ''
    expect(text).toContain('對話已壓縮')
    expect(text).toContain('70,422')
    expect(text).toContain('27,775')
    expect(container.querySelector('[role="separator"]')).not.toBeNull()
  })

  it('manual 觸發:文案改成手動壓縮', () => {
    const { container } = render(<CompactBoundary trigger="manual" preTokens={50000} />)
    expect(container.textContent).toContain('手動壓縮')
  })

  it('沒有 postTokens 時只顯示壓縮前的數字,不出現箭頭', () => {
    const { container } = render(<CompactBoundary trigger="auto" preTokens={50000} />)
    const text = container.textContent ?? ''
    expect(text).toContain('50,000')
    expect(text).not.toContain('→')
  })
})

describe('壓縮摘要的 turn', () => {
  const turn = {
    role: 'user' as const,
    blocks: [{ kind: 'compact-summary' as const, text: 'This session is being continued…' }],
  }

  it('角色標籤不是「你」:那不是使用者說的話', () => {
    const { container } = render(<Turn turn={turn} historical={false} />)
    expect(container.querySelector('.turn-role')?.textContent).not.toBe('你')
  })

  it('預設收合,展開才看得到內容', () => {
    const { container, getByRole } = render(<Turn turn={turn} historical={false} />)
    expect(container.textContent).not.toContain('being continued')
    fireEvent.click(getByRole('button', { name: /壓縮摘要/ }))
    expect(container.textContent).toContain('being continued')
  })
})
