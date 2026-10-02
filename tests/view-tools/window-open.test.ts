import { describe, it, expect } from 'vitest'
import { decideWindowOpen } from '../../src/main/view-tools/window-open.js'
import { MSG } from '../../src/main/view-tools/errors.js'

/**
 * `setWindowOpenHandler` 收到的網址是頁面自己給的，不經過 view_navigate，
 * 所以原本完全沒有套 §7 的協定與專案範圍限制。這組測試釘住的就是那條路
 * 與 view_navigate 走同一份判斷。
 *
 * projectDir 同 urls.test.ts：只做字串比對，不必真的存在。
 */
const PROJECT_DIR = '/Users/tester/Projects/yeschef-fixture'

describe('decideWindowOpen：放行的情況', () => {
  it('http 網址放行，回正規化後的 url', () => {
    expect(decideWindowOpen('http://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'navigate',
      url: 'http://example.com/a',
    })
  })

  it('https 網址放行', () => {
    expect(decideWindowOpen('https://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'navigate',
      url: 'https://example.com/a',
    })
  })

  it('專案目錄底下的 file: 網址放行', () => {
    expect(decideWindowOpen(`file://${PROJECT_DIR}/out/report.html`, PROJECT_DIR)).toEqual({
      kind: 'navigate',
      url: `file://${PROJECT_DIR}/out/report.html`,
    })
  })
})

describe('decideWindowOpen：擋下的情況', () => {
  it('專案目錄外的 file: 網址擋下，理由與 view_navigate 同一句', () => {
    expect(decideWindowOpen('file:///Users/tester/.ssh/id_rsa', PROJECT_DIR)).toEqual({
      kind: 'block',
      reason: MSG.outsideProject(PROJECT_DIR),
    })
  })

  it('前綴相同但不是子目錄的路徑擋下', () => {
    expect(decideWindowOpen(`file://${PROJECT_DIR}-secrets/a.html`, PROJECT_DIR)).toEqual({
      kind: 'block',
      reason: MSG.outsideProject(PROJECT_DIR),
    })
  })

  it('白名單外的協定擋下', () => {
    expect(decideWindowOpen('data:text/html,<h1>x</h1>', PROJECT_DIR)).toEqual({
      kind: 'block',
      reason: MSG.badScheme,
    })
  })

  it('解析不了的網址擋下', () => {
    expect(decideWindowOpen('not a url', PROJECT_DIR)).toEqual({
      kind: 'block',
      reason: MSG.invalidUrl('not a url'),
    })
  })

  it('沒有 active 專案時一律擋下，不丟例外', () => {
    expect(decideWindowOpen('https://example.com/a', undefined)).toEqual({
      kind: 'block',
      reason: MSG.noActiveProject,
    })
  })

  it('沒有 active 專案時，file: 網址同樣擋下', () => {
    expect(decideWindowOpen(`file://${PROJECT_DIR}/a.html`, undefined)).toEqual({
      kind: 'block',
      reason: MSG.noActiveProject,
    })
  })
})
