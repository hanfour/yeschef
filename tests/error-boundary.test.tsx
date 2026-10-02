// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DialogBoundary, RootBoundary } from '../src/renderer/components/ErrorBoundary.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Boom(): never {
  throw new Error('元件壞掉了')
}

it('最外層：元件出錯時顯示錯誤與重新載入，不是整片空白', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const reload = vi.fn()
  render(<RootBoundary reload={reload}><Boom /></RootBoundary>)
  expect(screen.getByRole('alert').textContent).toContain('畫面發生錯誤')
  expect(screen.getByRole('alert').textContent).toContain('元件壞掉了')
  fireEvent.click(screen.getByRole('button', { name: '重新載入' }))
  expect(reload).toHaveBeenCalledTimes(1)
})

it('對話框：出錯時只換掉這個對話框，按關閉交回呼叫端，旁邊的內容照常顯示', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const onClose = vi.fn()
  render(
    <div>
      <p>主畫面還在</p>
      <DialogBoundary onClose={onClose}><Boom /></DialogBoundary>
    </div>
  )
  expect(screen.getByText('主畫面還在')).not.toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('這個視窗發生錯誤')
  fireEvent.click(screen.getByRole('button', { name: '關閉' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('沒出錯時原樣顯示子元件', () => {
  render(<DialogBoundary onClose={() => {}}><p>正常內容</p></DialogBoundary>)
  expect(screen.getByText('正常內容')).not.toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('出錯時把錯誤寫進 console，方便開 DevTools 追查', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<DialogBoundary onClose={() => {}}><Boom /></DialogBoundary>)
  expect(error.mock.calls.some((call) => call.some((arg) => String(arg).includes('[yeschef] 畫面元件出錯')))).toBe(true)
})
