import { describe, expect, it } from 'vitest'
import {
  parseBrowserCommand, parseBrowserCommandResult, parseBrowserSessions, parseBrowserSnapshot, parseBrowserState,
} from '../src/shared/browser-ipc.js'

const STATE = { conversationId: 'c1', url: 'https://a.test/', title: 'A', loading: false, canGoBack: true, canGoForward: false }

describe('parseBrowserCommand', () => {
  it('五種 kind 都收', () => {
    expect(parseBrowserCommand({ kind: 'navigate', url: 'a.test' })).toEqual({ kind: 'navigate', url: 'a.test' })
    for (const kind of ['back', 'forward', 'reload', 'stop'] as const) {
      expect(parseBrowserCommand({ kind })).toEqual({ kind })
    }
  })

  it('navigate 缺 url 或 url 不是字串就拒收', () => {
    expect(parseBrowserCommand({ kind: 'navigate' })).toBeNull()
    expect(parseBrowserCommand({ kind: 'navigate', url: 3 })).toBeNull()
  })

  it('多餘欄位不帶過去', () => {
    expect(parseBrowserCommand({ kind: 'back', conversationId: 'x' })).toEqual({ kind: 'back' })
  })

  it('不認得的 kind 與非物件拒收', () => {
    expect(parseBrowserCommand({ kind: 'close' })).toBeNull()
    expect(parseBrowserCommand('back')).toBeNull()
    expect(parseBrowserCommand(null)).toBeNull()
    expect(parseBrowserCommand({})).toBeNull()
  })

  it('url 超過 8192 字元拒收', () => {
    expect(parseBrowserCommand({ kind: 'navigate', url: 'a'.repeat(8193) })).toBeNull()
  })
})

describe('其餘 parser', () => {
  it('parseBrowserCommandResult', () => {
    expect(parseBrowserCommandResult({ ok: true })).toEqual({ ok: true })
    expect(parseBrowserCommandResult({ ok: false, message: '這不是網址' })).toEqual({ ok: false, message: '這不是網址' })
    expect(parseBrowserCommandResult({ ok: false })).toBeNull()
  })

  it('parseBrowserState 六個欄位缺一不可', () => {
    expect(parseBrowserState(STATE)).toEqual(STATE)
    const { title: _title, ...missing } = STATE
    expect(parseBrowserState(missing)).toBeNull()
    expect(parseBrowserState({ ...STATE, loading: 'no' })).toBeNull()
  })

  it('parseBrowserSessions 收陣列,任一筆壞掉就整包拒收', () => {
    expect(parseBrowserSessions([{ conversationId: 'c1', busy: true }])).toEqual([{ conversationId: 'c1', busy: true }])
    expect(parseBrowserSessions([])).toEqual([])
    expect(parseBrowserSessions([{ conversationId: 'c1' }])).toBeNull()
    expect(parseBrowserSessions({})).toBeNull()
  })

  it('parseBrowserSnapshot', () => {
    expect(parseBrowserSnapshot({ states: [STATE], sessions: [{ conversationId: 'c1', busy: false }] }))
      .toEqual({ states: [STATE], sessions: [{ conversationId: 'c1', busy: false }] })
    expect(parseBrowserSnapshot({ states: [STATE] })).toBeNull()
  })
})
