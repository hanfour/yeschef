// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StatusBar } from '../src/renderer/components/StatusBar.js'

afterEach(cleanup)

describe('StatusBar', () => {
  it('沒有進行中的工作時顯示就緒', () => {
    const { container } = render(<StatusBar busy={0} pending={0} peerPending={0} />)
    expect(container.querySelector('.status-bar')).not.toBeNull()
    expect(container.querySelector('.status-bar')?.textContent).toBe('就緒')
  })

  it('三個數字各自只在大於零時出現', () => {
    render(<StatusBar busy={2} pending={0} peerPending={1} />)
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('2 個進行中')
    expect(text).toContain('1 則同伴提問')
    expect(text).not.toContain('待批准')
  })

  it('花費三個欄位各自可缺', () => {
    render(<StatusBar busy={0} pending={0} peerPending={0} cost={{ turns: 3 }} />)
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('3 輪')
    expect(text).not.toContain('US$')
    expect(text).not.toContain('tokens')
  })

  it('花費齊全時三個都畫,金額四位小數、token 有千分位', () => {
    render(<StatusBar busy={0} pending={0} peerPending={0} cost={{ turns: 2, usd: 0.1637, tokens: 204910 }} />)
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('2 輪')
    expect(text).toContain('US$0.1637')
    expect(text).toContain('204,910 tokens')
  })

  it('有待批准又給了跳轉時是按鈕,點了會呼叫', () => {
    const onJump = vi.fn()
    render(<StatusBar busy={0} pending={2} peerPending={0} onJumpToPending={onJump} />)
    const button = screen.getByRole('button', { name: '2 個待批准' })
    fireEvent.click(button)
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('沒給跳轉時待批准是純文字,不是按鈕', () => {
    render(<StatusBar busy={0} pending={2} peerPending={0} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('.status-bar')?.textContent).toContain('2 個待批准')
  })
})

it('進行中有 callback 才能點，零個時不畫', () => {
  const onJump = vi.fn()
  const { rerender } = render(<StatusBar busy={2} pending={0} peerPending={0} onJumpToBusy={onJump} />)
  const button = screen.getByRole('button', { name: '2 個進行中' })
  expect(button.className).toBe('status-item status-busy')
  fireEvent.click(button)
  expect(onJump).toHaveBeenCalledTimes(1)
  rerender(<StatusBar busy={2} pending={0} peerPending={0} />)
  expect(screen.getByText('2 個進行中').tagName).toBe('SPAN')
  rerender(<StatusBar busy={0} pending={0} peerPending={0} onJumpToBusy={onJump} />)
  expect(screen.queryByText(/進行中/)).toBeNull()
})
