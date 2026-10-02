// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { PanelDivider } from '../src/renderer/components/PanelDivider.js'

import { PANEL_WIDTH_KEY } from '../src/renderer/hooks/usePanelWidth.js'

// jsdom 沒有實作 pointer capture,補一組空的:要驗的是拖曳的收尾,不是瀏覽器的 capture。
Element.prototype.setPointerCapture ??= () => undefined
Element.prototype.releasePointerCapture ??= () => undefined

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.style.removeProperty('--panel-width')
})

describe('PanelDivider', () => {
  it('拖曳中卸載後不會存下任何寬度', () => {
    const { getByRole, unmount } = render(<PanelDivider onDragging={() => {}} />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 492, pointerId: 1 })
    unmount()
    // 卸載後不管對誰發事件都不該寫入,包含視窗的備援事件。
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull()
  })

  it('拖曳中只改畫面,放開才存檔', () => {
    const { getByRole } = render(<PanelDivider onDragging={() => {}} />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 492, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('532px')
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull()
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('532')
  })

  it('右鍵按在把手上不會進入拖曳', () => {
    const { getByRole } = render(<PanelDivider onDragging={() => {}} />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, button: 2 })
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull()
  })

  it('方向鍵也能調寬度,Shift 一次調大格', () => {
    const { getByRole } = render(<PanelDivider onDragging={() => {}} />)
    const handle = getByRole('separator')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('496')
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('544')
    fireEvent.keyDown(handle, { key: 'a' })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('544')
  })

  it('系統中斷指標(pointercancel)也會收尾,不會繼續跟著滑鼠跑', () => {
    const { getByRole } = render(<PanelDivider onDragging={() => {}} />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 492, pointerId: 1 })
    fireEvent.pointerCancel(handle, { pointerId: 1 })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('532')
    // 收尾之後再移動不該再跟著跑
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('532px')
  })

  it('重新掛載會恢復儲存寬度,拖曳保留起點偏移', () => {
    localStorage.setItem(PANEL_WIDTH_KEY, '320')
    const { getByRole } = render(<PanelDivider onDragging={() => {}} />)
    expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('320px')
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 })
    expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('340px')
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('340')
  })

})

it.each(['pointerUp', 'pointerCancel'] as const)('onDragging 在按下與 %s 各通知一次', (end) => {
  const onDragging = vi.fn()
  const { getByRole } = render(<PanelDivider onDragging={onDragging} />)
  const handle = getByRole('separator')
  fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: false })
  expect(onDragging).not.toHaveBeenCalled()
  fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: true })
  expect(onDragging.mock.calls).toEqual([[true]])
  fireEvent[end](handle, { pointerId: 1 })
  fireEvent.pointerUp(handle, { pointerId: 1 })
  expect(onDragging.mock.calls).toEqual([[true], [false]])
  expect(handle.getAttribute('aria-valuemin')).toBe('320')
  expect(handle.getAttribute('aria-valuemax')).toBe('544')
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(handle.getAttribute('aria-valuenow')).toBe('496')
})

it('拖曳中卸載也解除父層旗標,不提交寬度', () => {
  const onDragging = vi.fn()
  const { getByRole, unmount } = render(<PanelDivider onDragging={onDragging} />)
  fireEvent.pointerDown(getByRole('separator'), { clientX: 512, pointerId: 1, isPrimary: true })
  unmount()
  expect(onDragging.mock.calls).toEqual([[true], [false]])
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull()
})

it.each(['lostPointerCapture', 'pointerUp', 'pointerCancel'] as const)(
  '%s 即使沒有元素 pointerup 也只提交一次並停止拖曳', (end) => {
    const saved = vi.spyOn(Storage.prototype, 'setItem')
    const onDragging = vi.fn()
    const { getByRole } = render(<PanelDivider onDragging={onDragging} />)
    const handle = getByRole('separator')
    fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(handle, { clientX: 492, pointerId: 1 })
    expect(saved).not.toHaveBeenCalled()
    fireEvent[end](end === 'lostPointerCapture' ? handle : window, { pointerId: 1 })
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('532')
    expect(saved).toHaveBeenCalledTimes(1)
    expect(onDragging.mock.calls).toEqual([[true], [false]])
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    fireEvent.pointerCancel(window, { pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(saved).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('532px')
    expect(onDragging.mock.calls).toEqual([[true], [false]])
  }
)

it('沒有移動也能由視窗收尾,收尾與卸載都移除兩種視窗監聽', () => {
  const added = vi.spyOn(window, 'addEventListener')
  const removed = vi.spyOn(window, 'removeEventListener')
  const onDragging = vi.fn()
  const { getByRole, unmount } = render(<PanelDivider onDragging={onDragging} />)
  const handle = getByRole('separator')
  fireEvent.pointerDown(handle, { clientX: 512, pointerId: 1, isPrimary: true })
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull()
  expect(onDragging.mock.calls).toEqual([[true], [false]])
  for (const type of ['pointerup', 'pointercancel']) {
    const listener = added.mock.calls.find(([event]) => event === type)?.[1]
    expect(listener).toBeTypeOf('function')
    expect(added).toHaveBeenCalledWith(type, listener, { once: true })
    expect(removed).toHaveBeenCalledWith(type, listener)
  }
  added.mockClear()
  removed.mockClear()
  fireEvent.pointerDown(handle, { clientX: 512, pointerId: 2, isPrimary: true })
  unmount()
  for (const type of ['pointerup', 'pointercancel']) {
    const listener = added.mock.calls.find(([event]) => event === type)?.[1]
    expect(listener).toBeTypeOf('function')
    expect(removed).toHaveBeenCalledWith(type, listener)
  }
  fireEvent.pointerCancel(window, { pointerId: 2 })
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull()
  expect(onDragging.mock.calls).toEqual([[true], [false], [true], [false]])
})

it('視窗縮小夾限畫面與 ARIA,保留儲存值,後續鍵盤從畫面寬度調整', () => {
  const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600)
  localStorage.setItem(PANEL_WIDTH_KEY, '1000')
  const { getByRole, unmount } = render(<PanelDivider onDragging={() => {}} />)
  const handle = getByRole('separator')
  expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('1000px')
  viewport.mockReturnValue(1200)
  fireEvent.resize(window)
  expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('720px')
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('1000')
  expect(handle.getAttribute('aria-valuemax')).toBe('720')
  expect(handle.getAttribute('aria-valuenow')).toBe('720')
  viewport.mockReturnValue(1600)
  fireEvent.resize(window)
  expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('720px')
  expect(handle.getAttribute('aria-valuemax')).toBe('1120')
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('704')
  viewport.mockReturnValue(700)
  fireEvent.resize(window)
  expect(handle.getAttribute('aria-valuemax')).toBe('320')
  expect(handle.getAttribute('aria-valuenow')).toBe('320')
  unmount()
  document.documentElement.style.setProperty('--panel-width', '900px')
  fireEvent.resize(window)
  expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('900px')
})

it('視窗縮小以未提交的預覽寬度夾限,重新拖曳從畫面寬度開始', () => {
  const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600)
  localStorage.setItem(PANEL_WIDTH_KEY, '800')
  const { getByRole } = render(<PanelDivider onDragging={() => {}} />)
  const handle = getByRole('separator')
  fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1, isPrimary: true })
  fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 })
  viewport.mockReturnValue(1200)
  fireEvent.resize(window)
  expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('720px')
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('800')
  fireEvent.pointerUp(handle, { pointerId: 1 })
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('720')
  viewport.mockReturnValue(1600)
  fireEvent.resize(window)
  fireEvent.pointerDown(handle, { clientX: 800, pointerId: 2, isPrimary: true })
  fireEvent.pointerMove(handle, { clientX: 780, pointerId: 2 })
  expect(document.documentElement.style.getPropertyValue('--panel-width')).toBe('740px')
})
