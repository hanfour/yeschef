import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContentsView } from 'electron'
import { createBrowserCommands } from '../src/main/browser-commands.js'
import type { BrowserSession } from '../src/main/browser-sessions.js'
import { MSG } from '../src/main/view-tools/errors.js'

let calls: string[]
let foreground: string | null
let existing: BrowserSession | undefined
let ensureFails: boolean

function fakeSession(): BrowserSession {
  const webContents = {
    navigationHistory: {
      canGoBack: () => true, canGoForward: () => false,
      goBack: () => { calls.push('goBack') }, goForward: () => { calls.push('goForward') },
    },
    reload: () => { calls.push('reload') },
    stop: () => { calls.push('stop') },
  }
  return { view: { webContents } as unknown as WebContentsView, tools: {} as BrowserSession['tools'] }
}

function setup() {
  return createBrowserCommands({
    sessions: {
      ensure: (id) => {
        calls.push(`ensure:${id}`)
        if (ensureFails) return Promise.reject(new Error(MSG.browserUnavailable))
        existing = existing ?? fakeSession()
        return Promise.resolve(existing)
      },
      get: () => existing,
    },
    foregroundId: () => foreground,
    projectDirOf: (id) => (id === 'c1' ? '/專案' : undefined),
    loadPage: (_view, url) => { calls.push(`load:${url}`) },
    logError: vi.fn(),
  })
}

beforeEach(() => { calls = []; foreground = 'c1'; existing = undefined; ensureFails = false })

describe('navigate', () => {
  it('正規化、過白名單、ensure、載入', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'localhost:3000' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['ensure:c1', 'load:http://localhost:3000/'])
  })

  it('不是網址:不建瀏覽器', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'hello world' })).resolves.toEqual({ ok: false, message: MSG.notUrl })
    expect(calls).toEqual([])
  })

  it('空字串:不做事,回 ok', async () => {
    await expect(setup().run({ kind: 'navigate', url: '  ' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('協定不在白名單:不建瀏覽器', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'javascript:alert(1)' })).resolves.toEqual({ ok: false, message: MSG.badScheme })
    expect(calls).toEqual([])
  })

  it('專案目錄以外的 file://', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'file:///etc/passwd' })).resolves.toEqual({ ok: false, message: MSG.outsideProject('/專案') })
  })

  it('專案目錄底下的 file:// 放行', async () => {
    await expect(setup().run({ kind: 'navigate', url: 'file:///專案/out/index.html' })).resolves.toEqual({ ok: true })
  })

  it('file:// 帶非 localhost 的 host,轉不成本機路徑:回 invalidUrl', async () => {
    const url = 'file://not-localhost/etc/passwd'
    await expect(setup().run({ kind: 'navigate', url })).resolves.toEqual({ ok: false, message: MSG.invalidUrl(url) })
  })

  it('ensure 失敗回 browserUnavailable', async () => {
    ensureFails = true
    await expect(setup().run({ kind: 'navigate', url: 'a.test' })).resolves.toEqual({ ok: false, message: MSG.browserUnavailable })
  })

  it('沒有前景對話:不做事,回 ok', async () => {
    foreground = null
    await expect(setup().run({ kind: 'navigate', url: 'a.test' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('前景對話不在任何專案裡', async () => {
    foreground = 'orphan'
    await expect(setup().run({ kind: 'navigate', url: 'a.test' })).resolves.toEqual({ ok: false, message: MSG.sessionEnded })
  })
})

describe('其餘四個指令', () => {
  it('沒有 session 時不做事,也不建', async () => {
    for (const kind of ['back', 'forward', 'reload', 'stop'] as const) {
      await expect(setup().run({ kind })).resolves.toEqual({ ok: true })
    }
    expect(calls).toEqual([])
  })

  it('有 session 時各自轉給 webContents;不能往前就不叫 goForward', async () => {
    existing = fakeSession()
    const commands = setup()
    for (const kind of ['back', 'forward', 'reload', 'stop'] as const) await commands.run({ kind })
    expect(calls).toEqual(['goBack', 'reload', 'stop'])
  })
})
