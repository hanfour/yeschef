// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useBrowser } from '../src/renderer/hooks/useBrowser.js'
import type { BrowserSessionEntry, BrowserSnapshot, BrowserStatePayload } from '../src/shared/browser-ipc.js'

afterEach(cleanup)

const state = (conversationId: string, url: string): BrowserStatePayload =>
  ({ conversationId, url, title: '', loading: false, canGoBack: false, canGoForward: false })

function fakeApi(initial: BrowserSnapshot = { states: [], sessions: [] }) {
  let onState: (s: BrowserStatePayload) => void = () => {}
  let onSessions: (s: readonly BrowserSessionEntry[]) => void = () => {}
  return {
    api: {
      browserCommand: () => Promise.resolve({ ok: true as const }),
      getBrowser: () => Promise.resolve(initial),
      onBrowserState: (cb: typeof onState) => { onState = cb; return () => {} },
      onBrowserSessions: (cb: typeof onSessions) => { onSessions = cb; return () => {} },
    },
    pushState: (s: BrowserStatePayload) => { act(() => { onState(s) }) },
    pushSessions: (s: readonly BrowserSessionEntry[]) => { act(() => { onSessions(s) }) },
  }
}

describe('useBrowser', () => {
  it('掛載時用 getBrowser 取回目前狀態', async () => {
    const { api } = fakeApi({ states: [state('c1', 'https://a.test/')], sessions: [{ conversationId: 'c1', busy: false }] })
    const { result } = renderHook(() => useBrowser(api))
    await waitFor(() => { expect(result.current.stateOf('c1')?.url).toBe('https://a.test/') })
    expect(result.current.sessions).toEqual([{ conversationId: 'c1', busy: false }])
  })

  it('每個對話各記一份狀態,互不覆蓋', async () => {
    const { api, pushState } = fakeApi()
    const { result } = renderHook(() => useBrowser(api))
    pushState(state('c1', 'https://a.test/'))
    pushState(state('c2', 'https://b.test/'))
    pushState(state('c1', 'https://a.test/next'))
    expect(result.current.stateOf('c1')?.url).toBe('https://a.test/next')
    expect(result.current.stateOf('c2')?.url).toBe('https://b.test/')
    expect(result.current.stateOf(null)).toBeUndefined()
  })

  it('sessions 清單裡消失的對話,它的狀態也一起丟掉', async () => {
    const { api, pushState, pushSessions } = fakeApi()
    const { result } = renderHook(() => useBrowser(api))
    pushSessions([{ conversationId: 'c1', busy: false }])
    pushState(state('c1', 'https://a.test/'))
    pushSessions([])
    expect(result.current.stateOf('c1')).toBeUndefined()
  })

  it('晚到的 getBrowser 結果不蓋掉已經收到的推送', async () => {
    let release: (s: BrowserSnapshot) => void = () => {}
    const base = fakeApi()
    const api = { ...base.api, getBrowser: () => new Promise<BrowserSnapshot>((r) => { release = r }) }
    const { result } = renderHook(() => useBrowser(api))
    base.pushState(state('c1', 'https://new.test/'))
    await act(async () => { release({ states: [state('c1', 'https://old.test/')], sessions: [] }) })
    expect(result.current.stateOf('c1')?.url).toBe('https://new.test/')
  })

  it('推送已經把某個對話清掉之後,晚到的快照不會把它放回來', async () => {
    let release: (s: BrowserSnapshot) => void = () => {}
    const base = fakeApi()
    const api = { ...base.api, getBrowser: () => new Promise<BrowserSnapshot>((r) => { release = r }) }
    const { result } = renderHook(() => useBrowser(api))
    base.pushSessions([{ conversationId: 'c1', busy: false }])
    base.pushState(state('c1', 'https://a.test/'))
    base.pushSessions([])
    await act(async () => {
      release({ states: [state('c1', 'https://old.test/')], sessions: [{ conversationId: 'c1', busy: false }] })
    })
    expect(result.current.stateOf('c1')).toBeUndefined()
    expect(result.current.sessions).toEqual([])
  })
})
