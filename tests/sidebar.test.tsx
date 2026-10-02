// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '../src/renderer/components/Sidebar.js'

import { SIDEBAR_WIDTH_KEY } from '../src/renderer/hooks/useSidebarWidth.js'

// jsdom 沒有實作 pointer capture,補一組空的:要驗的是拖曳的收尾,不是瀏覽器的 capture。
Element.prototype.setPointerCapture ??= () => undefined
Element.prototype.releasePointerCapture ??= () => undefined

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.style.removeProperty('--sidebar-width')
})

describe('Sidebar', () => {
  it('拖曳中卸載後不會存下任何寬度', () => {
    const { getByRole, unmount } = render(<Sidebar />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 })
    unmount()
    // 卸載後不管對誰發事件都不該寫入,包含視窗的備援事件。
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull()
  })

  it('拖曳中只改畫面,放開才存檔', () => {
    const { getByRole } = render(<Sidebar />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('340px')
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull()
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340')
  })

  it('右鍵按在把手上不會進入拖曳', () => {
    const { getByRole } = render(<Sidebar />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1, button: 2 })
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull()
  })

  it('方向鍵也能調寬度,Shift 一次調大格', () => {
    const { getByRole } = render(<Sidebar />)
    const handle = getByRole('separator')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('296')
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('232')
    fireEvent.keyDown(handle, { key: 'a' })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('232')
  })

  it('系統中斷指標(pointercancel)也會收尾,不會繼續跟著滑鼠跑', () => {
    const { getByRole } = render(<Sidebar />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 })
    fireEvent.pointerCancel(handle, { pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340')
    // 收尾之後再移動不該再跟著跑
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('340px')
  })

  it('重新掛載會恢復儲存寬度,拖曳保留起點偏移', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '320')
    const { getByRole } = render(<Sidebar />)
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('320px')
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 420, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('340px')
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340')
  })

  it('拖曳把手會改寬度並存起來', () => {
    const { container } = render(<Sidebar><p>清單</p></Sidebar>)
    const handle = container.querySelector('.sidebar-resizer')
    expect(handle).not.toBeNull()
    if (handle === null) throw new Error('找不到側邊欄把手')
    expect(handle.parentElement).toBe(container.querySelector('.sidebar')?.parentElement)
    fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 340, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340')
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('340px')
  })

  it('呼叫端傳 false 進來時不畫內容', () => {
    const has = false
    render(<Sidebar>{has && <p>清單</p>}</Sidebar>)
    expect(screen.queryByText('清單')).toBeNull()
  })

  it('有內容時畫內容', () => {
    render(<Sidebar><p>清單</p></Sidebar>)
    expect(screen.getByText('清單')).not.toBeNull()
  })

  it('沒有內容時側邊欄本身還在', () => {
    const { container } = render(<Sidebar />)
    expect(screen.queryByText('清單')).toBeNull()
    expect(container.querySelector('.sidebar')).not.toBeNull()
  })

  it('在第一個拖曳後,第二個拖曳的起點要接續目前寬度', () => {
    const { container } = render(
      <>
        <Sidebar><p>A</p></Sidebar>
        <Sidebar><p>B</p></Sidebar>
      </>
    )
    const [first, second] = [...container.querySelectorAll('.sidebar-resizer')]
    if (first === undefined || second === undefined) throw new Error('兩個把手應該都在')
    // 第一個從預設 280 拖到 400
    fireEvent.pointerDown(first, { clientX: 280, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(first, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(first, { clientX: 400, pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('400')
    // 第二個在目前寬度 400 的邊界按下,不動滑鼠就放開,寬度不該跳回它自己記得的舊值
    fireEvent.pointerDown(second, { clientX: 400, pointerId: 2, isPrimary: true })
    fireEvent.pointerMove(second, { clientX: 400, pointerId: 2 })
    fireEvent.pointerUp(second, { clientX: 400, pointerId: 2 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('400')
  })
})

it.each(['lostPointerCapture', 'pointerUp', 'pointerCancel'] as const)(
  '%s 即使沒有元素 pointerup 也只提交一次並停止拖曳', (end) => {
    const saved = vi.spyOn(Storage.prototype, 'setItem')

    const { getByRole } = render(<Sidebar />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 })
    expect(saved).not.toHaveBeenCalled()
    fireEvent[end](end === 'lostPointerCapture' ? handle : window, { pointerId: 1 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340')
    expect(saved).toHaveBeenCalledTimes(1)

    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    fireEvent.pointerCancel(window, { pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(saved).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('340px')

  }
)

it('沒有移動也能由視窗收尾,收尾與卸載都移除兩種視窗監聽', () => {
  const added = vi.spyOn(window, 'addEventListener')
  const removed = vi.spyOn(window, 'removeEventListener')

  const { getByRole, unmount } = render(<Sidebar />)
  const handle = getByRole('separator')
  fireEvent.pointerDown(handle, { clientX: 280, pointerId: 1, isPrimary: true })
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull()

  for (const type of ['pointerup', 'pointercancel']) {
    const listener = added.mock.calls.find(([event]) => event === type)?.[1]
    expect(listener).toBeTypeOf('function')
    expect(added).toHaveBeenCalledWith(type, listener, { once: true })
    expect(removed).toHaveBeenCalledWith(type, listener)
  }
  added.mockClear()
  removed.mockClear()
  fireEvent.pointerDown(handle, { clientX: 280, pointerId: 2, isPrimary: true })
  unmount()
  for (const type of ['pointerup', 'pointercancel']) {
    const listener = added.mock.calls.find(([event]) => event === type)?.[1]
    expect(listener).toBeTypeOf('function')
    expect(removed).toHaveBeenCalledWith(type, listener)
  }
  fireEvent.pointerCancel(window, { pointerId: 2 })
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull()

})
