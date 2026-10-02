import { describe, expect, it, vi } from 'vitest'
import { createCopyModeGuard, hasWheelUp, isOnlyTerminalReports } from '../src/main/tmux-copy-mode.js'

// xterm.js 在 tmux 開啟 SGR 滑鼠回報（1006）時送的格式：ESC [ < 按鍵碼 ; 欄 ; 列 M
const SGR_WHEEL_UP = '\x1b[<64;10;5M'
const SGR_WHEEL_DOWN = '\x1b[<65;10;5M'
const SGR_CTRL_WHEEL_UP = '\x1b[<80;10;5M'
const SGR_LEFT_PRESS = '\x1b[<0;10;5M'
// 舊式 X10 回報：ESC [ M 再接三個位元組，按鍵碼 + 32
const X10_WHEEL_UP = `\x1b[M${String.fromCharCode(64 + 32)}${String.fromCharCode(10 + 32)}${String.fromCharCode(5 + 32)}`

describe('hasWheelUp', () => {
  it('recognizes SGR and X10 wheel-up reports, including with modifiers', () => {
    expect(hasWheelUp(SGR_WHEEL_UP)).toBe(true)
    expect(hasWheelUp(SGR_CTRL_WHEEL_UP)).toBe(true)
    expect(hasWheelUp(X10_WHEEL_UP)).toBe(true)
    expect(hasWheelUp(SGR_LEFT_PRESS + SGR_WHEEL_UP)).toBe(true)
  })

  it('ignores wheel-down, clicks and plain keys', () => {
    expect(hasWheelUp(SGR_WHEEL_DOWN)).toBe(false)
    expect(hasWheelUp(SGR_LEFT_PRESS)).toBe(false)
    expect(hasWheelUp('ls\r')).toBe(false)
    expect(hasWheelUp('\x1b[A')).toBe(false)
  })
})

describe('isOnlyTerminalReports', () => {
  it('is true for mouse and focus reports only', () => {
    expect(isOnlyTerminalReports(SGR_WHEEL_UP + SGR_WHEEL_DOWN)).toBe(true)
    expect(isOnlyTerminalReports(X10_WHEEL_UP)).toBe(true)
    expect(isOnlyTerminalReports('\x1b[I')).toBe(true)
    expect(isOnlyTerminalReports('\x1b[O')).toBe(true)
  })

  it('is false once anything the user typed is mixed in', () => {
    expect(isOnlyTerminalReports('a')).toBe(false)
    expect(isOnlyTerminalReports('\x1b[A')).toBe(false)
    expect(isOnlyTerminalReports(SGR_WHEEL_UP + 'q')).toBe(false)
    expect(isOnlyTerminalReports('')).toBe(false)
  })
})

describe('createCopyModeGuard', () => {
  it('cancels copy mode once before the first key after a wheel-up', () => {
    const cancel = vi.fn()
    const guard = createCopyModeGuard(cancel)
    guard(SGR_WHEEL_UP)
    guard(SGR_WHEEL_UP)
    expect(cancel).not.toHaveBeenCalled()
    guard('l')
    expect(cancel).toHaveBeenCalledTimes(1)
    guard('s')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does nothing for keys typed without scrolling first', () => {
    const cancel = vi.fn()
    const guard = createCopyModeGuard(cancel)
    guard('ls\r')
    guard(SGR_LEFT_PRESS)
    guard('x')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps waiting through wheel-down and focus reports', () => {
    const cancel = vi.fn()
    const guard = createCopyModeGuard(cancel)
    guard(SGR_WHEEL_UP)
    guard(SGR_WHEEL_DOWN)
    guard('\x1b[I')
    expect(cancel).not.toHaveBeenCalled()
    guard('q')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('treats a key in the same chunk as the wheel-up as a key typed afterwards', () => {
    const cancel = vi.fn()
    const guard = createCopyModeGuard(cancel)
    guard(SGR_WHEEL_UP + 'a')
    expect(cancel).not.toHaveBeenCalled()
    guard('b')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
