// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ApprovalCard } from '../src/renderer/components/ApprovalCard.js'
import { PendingStrip, jumpToApproval } from '../src/renderer/components/PendingStrip.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'

const ask: ApprovalAskPayload = { requestId: 'r"\\1', projectId: 'p1', conversationId: 'c1', toolUseId: 'tu1', toolName: 'Bash', input: {} }
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalScroll === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
})

it('每個工具一列，允許與拒絕帶各自的識別碼', () => {
  const reply = vi.fn()
  const onJump = vi.fn()
  render(<PendingStrip active={[ask, { ...ask, requestId: 'r2', toolName: 'Read' }]} reply={reply} onJump={onJump} />)
  const first = screen.getByText('Bash 在等你批准').parentElement
  const second = screen.getByText('Read 在等你批准').parentElement
  if (first === null || second === null) throw new Error('找不到提示列')
  expect(within(first).getAllByRole('button').map((button) => button.textContent)).toEqual(['前往', '允許', '拒絕'])
  fireEvent.click(within(first).getByRole('button', { name: '允許' }))
  fireEvent.click(within(second).getByRole('button', { name: '拒絕' }))
  expect(reply.mock.calls).toEqual([[ask.requestId, 'allow'], ['r2', 'deny']])
})

it('前往只捲動並聚焦自己範圍的卡片，特殊識別碼也能定位', () => {
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  const { container } = render(<>
    <ApprovalCard ask={ask} onDecide={vi.fn()} />
    <section data-testid="own">
      <PendingStrip active={[ask]} reply={vi.fn()} onJump={(id) => jumpToApproval(container.querySelector('section'), id)} />
      <ApprovalCard ask={ask} onDecide={vi.fn()} />
    </section>
  </>)
  const card = within(screen.getByTestId('own')).getByTestId('approval-card')
  const focus = vi.spyOn(card, 'focus')
  fireEvent.click(screen.getByRole('button', { name: '前往' }))
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'center' })
  expect(scroll.mock.contexts).toEqual([card])
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  expect(document.activeElement).toBe(card)
})

it.each(['missing', 'throws'] as const)('捲動方法 %s 時仍可聚焦；沒有目標時安全略過', (mode) => {
  if (mode === 'missing') Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => { throw new Error('無法捲動') } })
  const { container } = render(<ApprovalCard ask={ask} onDecide={vi.fn()} />)
  expect(() => jumpToApproval(null, ask.requestId)).not.toThrow()
  expect(() => jumpToApproval(container, '不存在')).not.toThrow()
  jumpToApproval(container, ask.requestId)
  expect(document.activeElement).toBe(screen.getByTestId('approval-card'))
})

it.each(['允許', '拒絕'] as const)('連按兩次%s只回覆一次，該列三顆按鈕停用且不影響其他列', (label) => {
  const reply = vi.fn()
  const onJump = vi.fn()
  const secondAsk = { ...ask, requestId: 'r2', toolName: 'Read' }
  const { rerender } = render(<PendingStrip active={[ask, secondAsk]} reply={reply} onJump={onJump} />)
  const row = screen.getByText('Bash 在等你批准').parentElement
  if (row === null) throw new Error('找不到提示列')
  const button = within(row).getByRole('button', { name: label })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(reply.mock.calls).toEqual([[ask.requestId, label === '允許' ? 'allow' : 'deny']])
  rerender(<PendingStrip active={[secondAsk, { ...ask }]} reply={reply} onJump={onJump} />)
  for (const action of within(row).getAllByRole<HTMLButtonElement>('button')) {
    expect(action.disabled).toBe(true)
    fireEvent.click(action)
  }
  expect(reply).toHaveBeenCalledTimes(1)
  expect(onJump).not.toHaveBeenCalled()
  const other = screen.getByText('Read 在等你批准').parentElement
  if (other === null) throw new Error('找不到另一提示列')
  for (const action of within(other).getAllByRole<HTMLButtonElement>('button')) expect(action.disabled).toBe(false)
  fireEvent.click(within(other).getByRole('button', { name: '允許' }))
  expect(reply).toHaveBeenLastCalledWith('r2', 'allow')
})
