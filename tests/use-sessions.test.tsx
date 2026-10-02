// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useSessions } from '../src/renderer/hooks/useSessions.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { SessionStatePayload, SessionSummary, YesChefApi } from '../src/shared/ipc.js'
import type { SessionListScope } from '../src/shared/projects.js'

afterEach(() => {
  cleanup()
})

const one: SessionSummary = { sessionId: 's-1', summary: '第一場', lastModified: 1 }
const two: SessionSummary = { sessionId: 's-2', summary: '第二場', lastModified: 2 }

interface Harness {
  readonly api: YesChefApi
  push(state: SessionState, conversationId?: string): void
  readonly listCalls: () => number
  readonly unsubscribed: () => number
  readonly scopes: () => readonly (string | null)[]
}

const PROJECT: SessionListScope = { projectId: 'p-1' }

function harness(
  respond: (call: number) => Promise<readonly SessionSummary[]> = async () => [one]
): Harness {
  let calls = 0
  let unsubscribed = 0
  const scopes: (string | null)[] = []
  const listeners: ((s: SessionStatePayload) => void)[] = []
  const api = {
    onEvents: () => () => undefined,
    onApprovalAsk: () => () => undefined,
    onSessionState: (cb: (s: SessionStatePayload) => void) => {
      listeners.push(cb)
      return () => {
        unsubscribed += 1
      }
    },
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: (scope: SessionListScope) => {
      calls += 1
      scopes.push(scope.projectId)
      return respond(calls)
    },
    startNew: () => undefined,
    openHistory: () => undefined,
    terminalEndpoint: vi.fn(),
  } as unknown as YesChefApi
  return {
    api,
    push: (state, conversationId = 'p-1-conv') => {
      act(() => {
        for (const l of listeners) l({ conversationId, state })
      })
    },
    listCalls: () => calls,
    unsubscribed: () => unsubscribed,
    scopes: () => scopes,
  }
}

describe('useSessions 的載入時機', () => {
  it('掛載時就載入一次清單', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(result.current.sessions).toEqual([one])
    })
    expect(h.listCalls()).toBe(1)
  })

  it('一場新對話結束後（live → idle）重新載入，Recents 才會出現那一筆', async () => {
    const h = harness(async (call) => (call === 1 ? [] : [two]))
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    expect(result.current.sessions).toEqual([])

    h.push({ kind: 'live' })
    h.push({ kind: 'idle' })

    await waitFor(() => {
      expect(result.current.sessions).toEqual([two])
    })
    expect(h.listCalls()).toBe(3)
  })

  it('切到另一場歷史對話會重載', async () => {
    const h = harness()
    renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    h.push({ kind: 'viewing', sessionId: 's-b' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(3)
    })
  })

  it('內容相同的狀態重複推送不重載，避免每一次推播都打一次 SDK', async () => {
    const h = harness()
    renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await Promise.resolve()
    expect(h.listCalls()).toBe(2)
  })

  it('refresh 變動時重載一次：live 的每一個回合結束都要讓 Recents 跟上', async () => {
    const h = harness()
    const { rerender } = renderHook(({ refresh }: { refresh: number }) => useSessions(h.api, refresh, PROJECT, 'p-1-conv'), {
      initialProps: { refresh: 0 },
    })
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })

    rerender({ refresh: 1 })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
  })

  it('scope 改變時重載,且每次都把 projectId 傳給 listSessions(null 代表全部)', async () => {
    const h = harness()
    const { rerender } = renderHook(({ scope }: { scope: SessionListScope }) => useSessions(h.api, 0, scope, 'p-1-conv'), {
      initialProps: { scope: PROJECT },
    })
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })

    rerender({ scope: { projectId: null } })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    rerender({ scope: { projectId: 'p-2' } })
    await waitFor(() => {
      expect(h.listCalls()).toBe(3)
    })
    expect(h.scopes()).toEqual(['p-1', null, 'p-2'])
  })

  it('內容相同的 scope 物件換新參照不重載', async () => {
    const h = harness()
    const { rerender } = renderHook(({ scope }: { scope: SessionListScope }) => useSessions(h.api, 0, scope, 'p-1-conv'), {
      initialProps: { scope: { projectId: 'p-1' } },
    })
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    rerender({ scope: { projectId: 'p-1' } })
    await Promise.resolve()
    expect(h.listCalls()).toBe(1)
  })

  it('卸載時取消 session:state 訂閱', async () => {
    const h = harness()
    const { unmount } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    unmount()
    expect(h.unsubscribed()).toBe(1)
  })
})

describe('useSessions 的 current', () => {
  it('viewing 時 current 是正在看的那一場', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    h.push({ kind: 'viewing', sessionId: 's-old' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-old')
    })
  })

  it('live 帶 sessionId 時 current 是那一場', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    h.push({ kind: 'live', sessionId: 's-live' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-live')
    })
  })

  it('idle 沒有 current', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    h.push({ kind: 'viewing', sessionId: 's-old' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-old')
    })
    h.push({ kind: 'idle' })
    await waitFor(() => {
      expect(result.current.current).toBeUndefined()
    })
  })
})

describe('useSessions 的錯誤處理', () => {
  it('載入失敗時給出錯誤訊息，而不是安靜地變成空清單', async () => {
    const h = harness(async () => {
      throw new Error('讀取歷史對話清單失敗，Recents 無法顯示')
    })
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(result.current.error).toBe('讀取歷史對話清單失敗，Recents 無法顯示')
    })
    expect(result.current.sessions).toEqual([])
  })

  it('失敗時保留上一次讀到的清單，畫面不會突然清空', async () => {
    const h = harness(async (call) => {
      if (call === 1) return [one]
      throw new Error('壞了')
    })
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(result.current.sessions).toEqual([one])
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(result.current.error).toBe('壞了')
    })
    expect(result.current.sessions).toEqual([one])
  })

  it('重試成功後錯誤訊息清掉', async () => {
    const h = harness(async (call) => {
      if (call === 1) throw new Error('壞了')
      return [two]
    })
    const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
    await waitFor(() => {
      expect(result.current.error).toBe('壞了')
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(result.current.sessions).toEqual([two])
    })
    expect(result.current.error).toBeUndefined()
  })
})

it('別的 conversationId 的 session:state 不改 current', async () => {
  const h = harness()
  const { result } = renderHook(() => useSessions(h.api, 0, PROJECT, 'p-1-conv'))
  h.push({ kind: 'viewing', sessionId: 'mine' })
  await waitFor(() => expect(result.current.current).toBe('mine'))
  h.push({ kind: 'live', sessionId: 'other' }, 'other')
  expect(result.current.current).toBe('mine')
})
