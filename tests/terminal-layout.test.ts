import { describe, expect, it } from 'vitest'
import { centerTerminal, screenSize } from '../src/renderer/terminal-layout.js'

describe('screenSize', () => {
  it('computes the text area from the current grid, not from the DOM', () => {
    expect(screenSize(100, 40, { width: 7.8, height: 17 })).toEqual({ width: 780, height: 680 })
  })

  it('returns undefined until xterm has measured a cell (terminal opened while hidden)', () => {
    expect(screenSize(80, 24, { width: 0, height: 0 })).toBeUndefined()
    expect(screenSize(80, 24, undefined)).toBeUndefined()
  })
})

describe('centerTerminal', () => {
  it('splits the leftover space evenly on both axes', () => {
    // 600 寬放 72 列 × 8px = 576，剩 24（含 14px 捲軸）；400 高放 23 行 × 17px = 391，剩 9
    expect(centerTerminal({ width: 600, height: 400 }, { width: 576, height: 391 })).toEqual({ left: 12, top: 4, width: 588 })
  })

  it('keeps the text right edge as far from the host edge as the left offset', () => {
    const host = { width: 613, height: 377 }
    const screen = { width: 592, height: 374 }
    const { left, top } = centerTerminal(host, screen)
    expect(host.width - (left + screen.width) - left).toBeLessThanOrEqual(1)
    expect(host.height - (top + screen.height) - top).toBeLessThanOrEqual(1)
  })

  it('never goes negative when the screen is larger than the host', () => {
    expect(centerTerminal({ width: 100, height: 50 }, { width: 120, height: 60 })).toEqual({ left: 0, top: 0, width: 100 })
  })
})
