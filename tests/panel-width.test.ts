// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampWidth, readWidth, PANEL_MIN, PANEL_WIDTH_KEY, writeWidth } from '../src/renderer/hooks/usePanelWidth.js'

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('主分頁區寬度', () => {
  it('無法讀取儲存空間時使用預設值', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('停用') })
    expect(readWidth()).toBe(window.innerWidth / 2)
  })

  it('無法寫入儲存空間時不拋例外', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('額滿') })
    expect(() => writeWidth(320)).not.toThrow()
  })

  it('寫入會限制範圍並四捨五入', () => {
    writeWidth(9999)
    expect(readWidth()).toBe(window.innerWidth - 480)
    writeWidth(10)
    expect(readWidth()).toBe(PANEL_MIN)
    writeWidth(320.6)
    expect(readWidth()).toBe(321)
  })

  it('沒存過就是預設值', () => {
    expect(readWidth()).toBe(window.innerWidth / 2)
  })

  it('存過就讀回來', () => {
    writeWidth(320)
    expect(readWidth()).toBe(320)
  })

  it('超出上下限會夾回範圍內', () => {
    expect(clampWidth(10, window.innerWidth)).toBe(PANEL_MIN)
    expect(clampWidth(9999, window.innerWidth)).toBe(window.innerWidth - 480)
  })

  it('存進去的壞值不會讓畫面爛掉', () => {
    localStorage.setItem(PANEL_WIDTH_KEY, 'abc')
    expect(readWidth()).toBe(window.innerWidth / 2)
  })
})


it('上限依視窗寬度改變', () => {
  expect(clampWidth(900, 1200)).toBe(720)
  expect(clampWidth(900, 1000)).toBe(520)
})
