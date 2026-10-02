import { describe, expect, it } from 'vitest'
import { decideRendererNavigation, guardRendererNavigation, type GuardableWebContents } from '../src/main/renderer-guard.js'

describe('decideRendererNavigation', () => {
  it('http 與 https 交給系統瀏覽器', () => {
    expect(decideRendererNavigation('https://example.com/a')).toEqual({ kind: 'external', url: 'https://example.com/a' })
    expect(decideRendererNavigation('http://example.com')).toEqual({ kind: 'external', url: 'http://example.com/' })
  })

  it('同一個來源(dev server 熱重載)放行,不交給系統瀏覽器', () => {
    expect(decideRendererNavigation('http://localhost:5173/', 'http://localhost:5173')).toEqual({ kind: 'self' })
    expect(decideRendererNavigation('http://localhost:5173/index.html?t=1', 'http://localhost:5173')).toEqual({ kind: 'self' })
    expect(decideRendererNavigation('http://localhost:5174/', 'http://localhost:5173')).toEqual({ kind: 'external', url: 'http://localhost:5174/' })
    expect(decideRendererNavigation('https://example.com/', 'http://localhost:5173')).toEqual({ kind: 'external', url: 'https://example.com/' })
  })

  it('其他 scheme 與壞網址一律擋', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'yeschef://x', 'not a url']) {
      expect(decideRendererNavigation(url)).toEqual({ kind: 'block' })
    }
  })
})

function fakeContents() {
  let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined
  let windowOpen: ((details: { url: string }) => { action: 'deny' }) | undefined
  const contents: GuardableWebContents = {
    on: (_event, listener) => { navigate = listener },
    setWindowOpenHandler: (handler) => { windowOpen = handler },
  }
  return {
    contents,
    navigate: (url: string) => {
      let prevented = false
      navigate?.({ preventDefault: () => { prevented = true } }, url)
      return prevented
    },
    open: (url: string) => windowOpen?.({ url }),
  }
}

describe('guardRendererNavigation', () => {
  it('點連結:頁面不導走,https 交給系統瀏覽器,file 不開', () => {
    const opened: string[] = []
    const errors: string[] = []
    const f = fakeContents()
    guardRendererNavigation(f.contents, { openExternal: async (u) => { opened.push(u) }, logError: (e) => { errors.push(e.message) } })
    expect(f.navigate('https://example.com/')).toBe(true)
    expect(f.navigate('file:///etc/passwd')).toBe(true)
    expect(opened).toEqual(['https://example.com/'])
    expect(errors).toEqual(['左窗格擋下導航:file:///etc/passwd'])
  })

  it('dev server 的整頁重載不擋、不開系統瀏覽器', () => {
    const opened: string[] = []
    const f = fakeContents()
    guardRendererNavigation(f.contents, { openExternal: async (u) => { opened.push(u) }, logError: () => {}, ownOrigin: 'http://localhost:5173' })
    expect(f.navigate('http://localhost:5173/?reload=1')).toBe(false)
    expect(f.navigate('https://example.com/')).toBe(true)
    expect(opened).toEqual(['https://example.com/'])
  })

  it('開新視窗一律拒絕,https 一樣交給系統瀏覽器', () => {
    const opened: string[] = []
    const f = fakeContents()
    guardRendererNavigation(f.contents, { openExternal: async (u) => { opened.push(u) }, logError: () => {} })
    expect(f.open('https://example.com/')).toEqual({ action: 'deny' })
    expect(opened).toEqual(['https://example.com/'])
  })

  it('系統瀏覽器開失敗會記錯誤', async () => {
    const errors: string[] = []
    const f = fakeContents()
    guardRendererNavigation(f.contents, { openExternal: async () => { throw new Error('no browser') }, logError: (e) => { errors.push(e.message) } })
    f.navigate('https://example.com/')
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toEqual(['no browser'])
  })
})
