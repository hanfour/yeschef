// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useElapsedSeconds } from '../src/renderer/elapsed.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useElapsedSeconds', () => {
  it('active 時每秒加一', () => {
    const { result } = renderHook(() => useElapsedSeconds(true))
    expect(result.current).toBe(0)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(result.current).toBe(3)
  })

  it('active 是 false 時固定回 0,也不起計時器', () => {
    const { result } = renderHook(() => useElapsedSeconds(false))
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(result.current).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('從 active 變成不 active 時歸零並停掉計時器', () => {
    const { result, rerender } = renderHook(({ a }: { a: boolean }) => useElapsedSeconds(a), {
      initialProps: { a: true },
    })
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(result.current).toBe(2)
    rerender({ a: false })
    expect(result.current).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卸載時停掉計時器', () => {
    const { unmount } = renderHook(() => useElapsedSeconds(true))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('指定起點立即顯示累計秒數，背景返回延續並可切換下一輪', () => {
  vi.setSystemTime(10000)
  const { result, rerender } = renderHook(({ active, since }) => useElapsedSeconds(active, since), {
    initialProps: { active: true, since: 2000 },
  })
  expect(result.current).toBe(8)
  rerender({ active: false, since: 2000 })
  expect(result.current).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  act(() => { vi.advanceTimersByTime(5000) })
  rerender({ active: true, since: 2000 })
  expect(result.current).toBe(13)
  rerender({ active: true, since: 20000 })
  expect(result.current).toBe(0)
})
