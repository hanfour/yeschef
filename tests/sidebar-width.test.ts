// @vitest-environment jsdom
import { globSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampWidth, readWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_WIDTH_KEY, writeWidth } from '../src/renderer/hooks/useSidebarWidth.js'

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

describe('側邊欄寬度', () => {
  it('無法讀取儲存空間時使用預設值', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('停用') })
    expect(readWidth()).toBe(SIDEBAR_DEFAULT)
  })

  it('無法寫入儲存空間時不拋例外', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('額滿') })
    expect(() => writeWidth(320)).not.toThrow()
  })

  it('寫入會限制範圍並四捨五入', () => {
    writeWidth(9999)
    expect(readWidth()).toBe(SIDEBAR_MAX)
    writeWidth(10)
    expect(readWidth()).toBe(SIDEBAR_MIN)
    writeWidth(320.6)
    expect(readWidth()).toBe(321)
  })

  it('沒存過就是預設值', () => {
    expect(readWidth()).toBe(SIDEBAR_DEFAULT)
  })

  it('存過就讀回來', () => {
    writeWidth(320)
    expect(readWidth()).toBe(320)
  })

  it('超出上下限會夾回範圍內', () => {
    expect(clampWidth(10)).toBe(SIDEBAR_MIN)
    expect(clampWidth(9999)).toBe(SIDEBAR_MAX)
  })

  it('存進去的壞值不會讓畫面爛掉', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, 'abc')
    expect(readWidth()).toBe(SIDEBAR_DEFAULT)
  })
})

describe('CSS 的預設寬度', () => {
  const cssFiles = (): readonly { readonly file: string; readonly text: string }[] =>
    globSync('src/renderer/**/*.css').map((file) => ({ file, text: readFileSync(file, 'utf8') }))

  it('fallback 的數字跟 SIDEBAR_DEFAULT 一致', () => {
    const css = readFileSync('src/renderer/components/LeftPane.css', 'utf8')
    const match = /var\(--sidebar-width,\s*(\d+)px\)/.exec(css)
    expect(match?.[1]).toBe(String(SIDEBAR_DEFAULT))
  })

  it.each(['sidebar', 'panel'])('沒有任何選擇器定義 --%s-width', (name) => {
    // 任何比 :root 更近的祖先只要宣告過這個變數,就會蓋掉 useSidebarWidth 設在
    // documentElement 上的值,拖曳整個失效。只用 var() 的 fallback 就不可能發生。
    // 註解裡也會出現這個名字,所以要求前面是 `{` 或 `;` 或行首,後面緊接冒號。
    const declaring = cssFiles().filter(({ text }) => new RegExp('(^|[{;])\\s*--' + name + '-width\\s*:', 'm').test(text))
    expect(declaring.map(({ file }) => file)).toEqual([])
  })
})
