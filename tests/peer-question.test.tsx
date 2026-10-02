// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PeerQuestion } from '../src/renderer/components/PeerQuestion.js'

afterEach(cleanup)

const question = { provider: 'claude', fromLinkId: 'aaaa1111', questionId: 'q-1', text: '要用哪個欄位?' }

describe('PeerQuestion', () => {
  it('畫出誰問的與問題本身', () => {
    render(<PeerQuestion question={question} />)
    expect(screen.getByText('要用哪個欄位?')).not.toBeNull()
    expect(screen.getByTestId('peer-from').textContent).toContain('claude · aaaa1111')
  })

  it('沒有給狀態時不畫狀態列', () => {
    render(<PeerQuestion question={question} />)
    expect(screen.queryByTestId('peer-status')).toBeNull()
  })
})

describe('人的介入', () => {
  it('未決時畫出兩顆按鈕,取消直接呼叫', async () => {
    const onCancel = vi.fn()
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 3 }} onAnswer={() => {}} onCancel={onCancel} />)
    expect(screen.getByTestId('peer-status').textContent).toContain('等你回答，對方已等 3 秒')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('代替回答:按下之後出現輸入框,送出把文字交出去', async () => {
    const onAnswer = vi.fn()
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 0 }} onAnswer={onAnswer} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '代替回答' }))
    fireEvent.change(screen.getByRole('textbox', { name: '代替回答的內容' }), { target: { value: '我幫他答' } })
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(onAnswer).toHaveBeenCalledWith('我幫他答')
  })

  it('空白的代替回答不送出', async () => {
    const onAnswer = vi.fn()
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 0 }} onAnswer={onAnswer} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '代替回答' }))
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('沒有給兩個回呼時不畫按鈕', () => {
    render(<PeerQuestion question={question} status={{ kind: 'waiting', waitedSeconds: 0 }} />)
    expect(screen.queryByRole('button', { name: '代替回答' })).toBeNull()
  })
})
