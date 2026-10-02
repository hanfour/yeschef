import { describe, it, expect } from 'vitest'
import { checkNavigateUrl } from '../../src/main/view-tools/urls.js'

/**
 * projectDir 不需要真的存在：契約明講「不對目標做 realpath」，checkNavigateUrl
 * 只做字串層級的路徑比對，不碰檔案系統，所以固定字串路徑就夠測。
 */
const PROJECT_DIR = '/Users/tester/Projects/yeschef-fixture'

describe('checkNavigateUrl：允許的協定', () => {
  it('http:// 通過，回傳正規化後的 url', () => {
    expect(checkNavigateUrl('http://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: 'http://example.com/a',
    })
  })

  it('https:// 通過', () => {
    expect(checkNavigateUrl('https://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: 'https://example.com/a',
    })
  })

  it('大寫 scheme（HTTP://）也通過，且正規化後的 url 是小寫協定', () => {
    expect(checkNavigateUrl('HTTP://example.com/a', PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: 'http://example.com/a',
    })
  })
})

describe('checkNavigateUrl：不允許的協定', () => {
  it.each([['javascript:alert(1)'], ['data:text/plain,hi'], ['about:blank'], ['chrome://settings']])(
    '%s 回 bad-scheme',
    (raw) => {
      expect(checkNavigateUrl(raw, PROJECT_DIR)).toEqual({ kind: 'bad-scheme' })
    }
  )
})

describe('checkNavigateUrl：無法解析', () => {
  it('沒有 scheme 的字串（example.com）回 invalid', () => {
    expect(checkNavigateUrl('example.com', PROJECT_DIR)).toEqual({ kind: 'invalid' })
  })

  it('完全不是網址的字串回 invalid', () => {
    expect(checkNavigateUrl('這不是網址 有空格', PROJECT_DIR)).toEqual({ kind: 'invalid' })
  })

  it('file:// 帶 host（非 localhost）回 invalid：fileURLToPath 轉不出本機路徑', () => {
    expect(checkNavigateUrl('file://host/path', PROJECT_DIR)).toEqual({ kind: 'invalid' })
  })
})

describe('checkNavigateUrl：file: 的專案目錄範圍', () => {
  it('projectDir 底下的檔案回 ok', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}/a.html`, PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: `file://${PROJECT_DIR}/a.html`,
    })
  })

  it('路徑恰好等於 projectDir 本身（無子路徑）回 ok', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}`, PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: `file://${PROJECT_DIR}`,
    })
  })

  it('用 .. 跳出 projectDir，正規化後在外面，回 outside-project', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}/../other/a.html`, PROJECT_DIR)).toEqual({
      kind: 'outside-project',
      projectDir: PROJECT_DIR,
    })
  })

  it('用百分號編碼的 %2e%2e 跳出 projectDir，回 outside-project', () => {
    // 防止以編碼的 .. 繞過 projectDir 的路徑檢查。
    expect(checkNavigateUrl(`file://${PROJECT_DIR}/%2e%2e/other/a.html`, PROJECT_DIR)).toEqual({
      kind: 'outside-project',
      projectDir: PROJECT_DIR,
    })
  })

  it('前綴陷阱：projectDir-suffix 不是 projectDir 底下，回 outside-project', () => {
    // "/…/yeschef-fixture-suffix" 以 "/…/yeschef-fixture" 開頭（字串層級），
    // 但不在它底下：少了結尾分隔符的前綴比對會誤判成 ok，必須是 outside-project。
    expect(checkNavigateUrl(`file://${PROJECT_DIR}-suffix/a.html`, PROJECT_DIR)).toEqual({
      kind: 'outside-project',
      projectDir: PROJECT_DIR,
    })
  })

  it('含 %20 與中文的路徑，解碼後在 projectDir 底下，回 ok', () => {
    const raw = `file://${PROJECT_DIR}/a%20b/%E4%B8%AD%E6%96%87.html`
    expect(checkNavigateUrl(raw, PROJECT_DIR)).toEqual({
      kind: 'ok',
      url: raw,
    })
  })

  it('projectDir 帶結尾斜線時，判斷結果與不帶斜線一致（ok 案例）', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}/a.html`, `${PROJECT_DIR}/`)).toEqual({
      kind: 'ok',
      url: `file://${PROJECT_DIR}/a.html`,
    })
  })

  it('projectDir 帶結尾斜線時，判斷結果與不帶斜線一致（outside-project 案例）', () => {
    expect(checkNavigateUrl(`file://${PROJECT_DIR}-suffix/a.html`, `${PROJECT_DIR}/`)).toEqual({
      kind: 'outside-project',
      projectDir: `${PROJECT_DIR}/`,
    })
  })
})
