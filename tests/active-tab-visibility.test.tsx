// @vitest-environment jsdom
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TAB_FADE_WIDTH, useActiveTabVisibility } from '../src/renderer/hooks/useActiveTabVisibility.js'
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('切換到欄外分頁只調整水平捲動，不捲動整個工作台', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const left = this.getAttribute('data-tab') === 'second' ? 280 : 0
    const width = this.getAttribute('role') === 'tablist' ? 200 : 100
    return { x: left, y: 30, left, right: left + width, width, top: 30, bottom: 60, height: 30, toJSON: () => ({}) }
  })
  function Harness({ selected }: { selected: string }) {
    const ref = useRef<HTMLDivElement>(null)
    useActiveTabVisibility(ref, selected)
    return <div ref={ref} role="tablist"><button data-tab="first" role="tab" aria-selected={selected === 'first'}>一</button><button data-tab="second" role="tab" aria-selected={selected === 'second'}>二</button></div>
  }
  const { container, rerender } = render(<Harness selected="first" />)
  const list = container.querySelector<HTMLElement>('[role=tablist]')!
  Object.defineProperties(list, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 400 },
  })
  list.scrollTop = 12
  rerender(<Harness selected="second" />)
  expect(list.scrollLeft).toBeGreaterThan(0)
  expect(list.scrollTop).toBe(12)
})

it('前景分頁捲入可視範圍並避開右側淡出區', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const left = this.getAttribute('data-tab') === 'last' ? 280 : 0
    const width = this.getAttribute('role') === 'tablist' ? 200 : 100
    return { x: left, y: 30, left, right: left + width, width, top: 30, bottom: 60, height: 30, toJSON: () => ({}) }
  })
  function Harness({ selected }: { selected: string }) {
    const ref = useRef<HTMLDivElement>(null)
    useActiveTabVisibility(ref, selected, TAB_FADE_WIDTH)
    return <div ref={ref} role="tablist"><button data-tab="first" role="tab" aria-selected={selected === 'first'}>一</button><button data-tab="last" role="tab" aria-selected={selected === 'last'}>最後</button></div>
  }
  const { container, rerender } = render(<Harness selected="first" />)
  const list = container.querySelector<HTMLElement>('[role=tablist]')!
  Object.defineProperties(list, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 400 },
  })

  rerender(<Harness selected="last" />)

  expect(list.scrollLeft).toBe(200)
})
