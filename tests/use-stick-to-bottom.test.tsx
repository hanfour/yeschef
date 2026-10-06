// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useStickToBottom } from '../src/renderer/hooks/useStickToBottom.js'

/** jsdom 沒有版面：用可調的高度與可讀寫的 scrollTop 造出可捲清單，並手動觸發 ResizeObserver。 */
function installLayout() {
  const proto = HTMLDivElement.prototype as unknown as Record<string, unknown>
  const tops = new WeakMap<object, number>()
  const size = { scrollHeight: 1000, clientHeight: 200 }
  const observers: (() => void)[] = []
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => size.scrollHeight })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => size.clientHeight })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: object) { return tops.get(this) ?? 0 },
    set(this: object, value: number) { tops.set(this, Math.min(value, Math.max(0, size.scrollHeight - size.clientHeight))) },
  })
  const original = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { observers.push(callback) }
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver
  return {
    size,
    resize: () => { act(() => { for (const callback of observers) callback() }) },
    restore: () => {
      delete proto['scrollHeight']; delete proto['clientHeight']; delete proto['scrollTop']
      globalThis.ResizeObserver = original
    },
  }
}

function Feed({ items }: { readonly items: readonly string[] }) {
  const { listRef, contentRef, away, onScroll, jumpToLatest } = useStickToBottom(items)
  return (
    <div>
      <div data-testid="list" ref={listRef} onScroll={onScroll}><div ref={contentRef}>{items.map(item => <p key={item}>{item}</p>)}</div></div>
      {away ? <button type="button" onClick={jumpToLatest}>↓ 回到最新訊息</button> : null}
    </div>
  )
}

let layout: ReturnType<typeof installLayout> | null = null
afterEach(() => { cleanup(); layout?.restore(); layout = null })

describe('useStickToBottom', () => {
  it('隱藏期間（高度 0）進來的訊息，重新顯示時捲到底', () => {
    layout = installLayout()
    layout.size.clientHeight = 0
    layout.size.scrollHeight = 0
    const { rerender } = render(<Feed items={['a']} />)
    rerender(<Feed items={['a', 'b', 'c']} />)
    const list = screen.getByTestId('list')
    expect(list.scrollTop).toBe(0)
    layout.size.clientHeight = 200
    layout.size.scrollHeight = 1000
    layout.resize()
    expect(list.scrollTop).toBe(800)
    expect(screen.queryByRole('button', { name: '↓ 回到最新訊息' })).toBeNull()
  })

  it('內容高度在畫出後才變大（例如排版完成），仍然貼底', () => {
    layout = installLayout()
    render(<Feed items={['a']} />)
    const list = screen.getByTestId('list')
    expect(list.scrollTop).toBe(800)
    layout.size.scrollHeight = 1500
    layout.resize()
    expect(list.scrollTop).toBe(1300)
  })

  it('往上捲後顯示回到最新訊息；新訊息不搶捲動位置；點按鈕回到底並恢復追蹤', () => {
    layout = installLayout()
    const { rerender } = render(<Feed items={['a']} />)
    const list = screen.getByTestId('list')
    list.scrollTop = 100
    fireEvent.scroll(list)
    layout.size.scrollHeight = 2000
    rerender(<Feed items={['a', 'b']} />)
    expect(list.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: '↓ 回到最新訊息' }))
    expect(list.scrollTop).toBe(1800)
    expect(screen.queryByRole('button', { name: '↓ 回到最新訊息' })).toBeNull()
    layout.size.scrollHeight = 2500
    rerender(<Feed items={['a', 'b', 'c']} />)
    expect(list.scrollTop).toBe(2300)
  })

  it('隱藏時觸發的捲動事件（全為 0）不會把狀態誤判為離開底部', () => {
    layout = installLayout()
    render(<Feed items={['a']} />)
    const list = screen.getByTestId('list')
    layout.size.clientHeight = 0
    layout.size.scrollHeight = 0
    fireEvent.scroll(list)
    layout.size.clientHeight = 200
    layout.size.scrollHeight = 1200
    layout.resize()
    expect(list.scrollTop).toBe(1000)
  })
})
