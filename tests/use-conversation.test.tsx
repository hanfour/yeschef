// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { appendEvents, useConversation } from '../src/renderer/hooks/useConversation.js'
import { App, LIVE_PLACEHOLDER, VIEWING_PLACEHOLDER } from '../src/renderer/App.js'
import { HISTORICAL_RAW_TEXT } from '../src/renderer/components/ToolCall.js'
import type { Event } from '../src/shared/events.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { EventsBatchPayload, SessionStatePayload, YesChefApi, SessionSummary } from '../src/shared/ipc.js'
import type { ProjectsView } from '../src/shared/projects.js'
import { createFakeYesChef, ONE_PROJECT } from './helpers/fake-yeschef.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

interface Fake {
  readonly eventCbs: Array<(p: EventsBatchPayload) => void>
  readonly stateCbs: Array<(p: SessionStatePayload) => void>
  readonly api: YesChefApi
  emitEvents(events: readonly Event[]): void
  emitState(state: SessionState): void
  emitProjects(view: ProjectsView): void
  readonly sent: string[]
  readonly unsubscribed: () => number
}

/**
 * 假的 YesChefApi。底是共用的 `createFakeYesChef`(專案那幾個成員都由它補齊),
 * 上面覆蓋本檔要觀察的訂閱與送出;不該被呼叫的成員仍蓋成會拋錯的樁,
 * 這樣元件若不小心呼叫了不該呼叫的東西,測試會直接炸而不是靜默通過。
 */
function createFake(): Fake {
  const shared = createFakeYesChef()
  const eventCbs: Array<(p: EventsBatchPayload) => void> = []
  const stateCbs: Array<(p: SessionStatePayload) => void> = []
  const sent: string[] = []
  let unsubscribed = 0

  const api: YesChefApi = {
    ...shared.api,
    onEvents(cb) {
      eventCbs.push(cb)
      return () => {
        unsubscribed += 1
      }
    },
    onSessionState(cb) {
      stateCbs.push(cb)
      return () => {
        unsubscribed += 1
      }
    },
    onApprovalAsk() {
      return () => undefined
    },
    async conversationTools(request) { if (request.action === 'send') { sent.push(request.text); return { kind: 'sent' } } return { kind: 'error', message: 'unused' } },
    sendInput(text) {
      sent.push(text)
    },
    replyApproval() {
      throw new Error('Task 9B 不該呼叫 replyApproval')
    },
    listSessions(): Promise<readonly SessionSummary[]> {
      // Task 11 之後 App 會掛上 Recents，useSessions 一掛載就呼叫這個。
      // 本檔測的是對話那一半，回空清單即可。
      return Promise.resolve([])
    },
    startNew() {
      throw new Error('Task 9B 不該呼叫 startNew')
    },
    openHistory() {
      throw new Error('Task 9B 不該呼叫 openHistory')
    },
    handoffDone() {
      throw new Error('Task 9B 不該呼叫 handoffDone')
    },
    terminalEndpoint: vi.fn(),
  }

  return {
    api,
    eventCbs,
    stateCbs,
    emitEvents(events) {
      act(() => {
        eventCbs.forEach((cb) => cb({ conversationId: 'p-1-conv', events }))
      })
    },
    emitState(state) {
      act(() => {
        stateCbs.forEach((cb) => cb({ conversationId: 'p-1-conv', state }))
      })
    },
    emitProjects: shared.emitProjects,
    sent,
    unsubscribed: () => unsubscribed,
  }
}

const say = (text: string): Event => ({ kind: 'user-text', text })
const RESET: Event = { kind: 'reset' }

/*
 * appendEvents 直接測，不透過 hook：`fold()` 自己也把 `reset` 當成「回到空 view」
 * （裁決 22 給 Task 4 的那一條），所以 hook 少截一次，`view` 看起來完全一樣，
 * 差別只在累積陣列會一直長下去。這件事只有對著純函式才觀察得到。
 */
describe('appendEvents', () => {
  it('批次裡沒有 reset 時原樣接在後面', () => {
    expect(appendEvents([say('舊')], [say('新一'), say('新二')])).toEqual([
      say('舊'),
      say('新一'),
      say('新二'),
    ])
  })

  it('批次裡有 reset 時只留它之後的事件，先前累積的與 reset 本身都不留', () => {
    expect(appendEvents([say('舊')], [RESET, say('新')])).toEqual([say('新')])
  })

  it('批次裡有兩個 reset 時以最後一個為準', () => {
    expect(appendEvents([say('舊')], [RESET, say('中間'), RESET, say('新')])).toEqual([say('新')])
  })

  it('批次只有 reset 時回空陣列', () => {
    expect(appendEvents([say('舊')], [RESET])).toEqual([])
  })
})

describe('useConversation', () => {
  it('初始為 idle 與空對話', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))
    expect(result.current.sessionState).toEqual({ kind: 'idle' })
    expect(result.current.view.turns).toHaveLength(0)
  })

  it('多批事件以不可變方式累積，先後順序不變', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))

    fake.emitEvents([say('第一句')])
    fake.emitEvents([say('第二句'), say('第三句')])

    expect(result.current.view.turns).toHaveLength(3)
    expect(result.current.view.turns.map((t) => t.blocks[0])).toEqual([
      { kind: 'text', markdown: '第一句', complete: true },
      { kind: 'text', markdown: '第二句', complete: true },
      { kind: 'text', markdown: '第三句', complete: true },
    ])
  })

  it('批次裡 reset 之前的事件不進畫面', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))

    fake.emitEvents([say('上一場的話')])
    fake.emitEvents([RESET, say('第一句'), say('第二句')])

    expect(result.current.view.turns.map((t) => t.blocks[0])).toEqual([
      { kind: 'text', markdown: '第一句', complete: true },
      { kind: 'text', markdown: '第二句', complete: true },
    ])
  })

  it('reset 自己走一批也算數，之後的事件從空畫面重新累積', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))

    fake.emitEvents([say('A 場')])
    fake.emitEvents([RESET])
    expect(result.current.view.turns).toHaveLength(0)

    fake.emitEvents([say('B 場')])

    expect(result.current.view.turns).toHaveLength(1)
    expect(result.current.view.turns[0]?.blocks[0]).toEqual({
      kind: 'text',
      markdown: 'B 場',
      complete: true,
    })
  })

  it('同一批有兩個 reset 時只留最後一個之後的事件', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))

    fake.emitEvents([say('丟掉一'), RESET, say('丟掉二'), RESET, say('留下來')])

    expect(result.current.view.turns).toHaveLength(1)
    expect(result.current.view.turns[0]?.blocks[0]).toEqual({
      kind: 'text',
      markdown: '留下來',
      complete: true,
    })
  })

  // 裁決 22 的三處反例，逐一釘住：狀態變了，事件一律不清。
  it('live 變 idle 不清事件，裁決 17 的錯誤卡片留在畫面上', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))

    fake.emitState({ kind: 'live', sessionId: 's-1' })
    fake.emitEvents([say('跑一下'), { kind: 'session-end', isError: true, errorMessage: '連線中斷' }])
    fake.emitState({ kind: 'idle' })

    expect(result.current.view.turns).toHaveLength(1)
    expect(result.current.view.error?.message).toBe('連線中斷')
  })

  it('viewing 變 live（輸入即 resume）不清事件，歷史留在畫面上', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))

    fake.emitState({ kind: 'viewing', sessionId: 's-a' })
    fake.emitEvents([say('歷史的一句')])
    fake.emitState({ kind: 'live', sessionId: 's-a' })

    expect(result.current.sessionState).toEqual({ kind: 'live', sessionId: 's-a' })
    expect(result.current.view.turns).toHaveLength(1)
  })

  it('同一場的狀態重送不清空已累積的事件', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))

    fake.emitState({ kind: 'live', sessionId: 's-1' })
    fake.emitEvents([say('串到一半')])
    fake.emitState({ kind: 'live', sessionId: 's-1' })

    expect(result.current.view.turns).toHaveLength(1)
  })

  it('unmount 時兩個訂閱都解除', () => {
    const fake = createFake()
    const { unmount } = renderHook(() => useConversation(fake.api, 'p-1-conv'))
    unmount()
    expect(fake.unsubscribed()).toBe(2)
  })
})

describe('useConversation 的 turnEnds', () => {
  const END: Event = { kind: 'session-end', isError: false }

  it('數 session-end 的筆數，reset 之後歸零', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))
    expect(result.current.turnEnds).toBe(0)

    fake.emitEvents([say('一'), END])
    expect(result.current.turnEnds).toBe(1)

    fake.emitEvents([say('二'), END])
    expect(result.current.turnEnds).toBe(2)

    fake.emitEvents([RESET])
    expect(result.current.turnEnds).toBe(0)
  })
})

describe('App', () => {
  it('Enter 送出並清空輸入框', async () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '幫我跑測試' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(fake.sent).toEqual(['幫我跑測試'])
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('Shift+Enter 不送出，內容保留', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '第一行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })

    expect(fake.sent).toEqual([])
    expect(input.value).toBe('第一行')
  })

  it('輸入法組字中的 Enter 不送出（中文輸入選字用的 Enter）', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '測試' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    expect(fake.sent).toEqual([])
  })

  it('只有空白時不送出', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(fake.sent).toEqual([])
  })

  it('viewing 時輸入框提示改成接續這條對話', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const input = container.querySelector('textarea')
    expect(input?.placeholder).toBe(LIVE_PLACEHOLDER)

    fake.emitState({ kind: 'viewing', sessionId: 's-1' })
    expect(input?.placeholder).toBe(VIEWING_PLACEHOLDER)
  })

  it('事件到達時對話出現在畫面上', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)

    fake.emitEvents([say('你好'), { kind: 'text', messageId: 'm1', index: 0, text: '哈囉' }])

    expect(container.querySelector('.conversation-list')?.textContent).toContain('你好')
    expect(container.querySelector('.conversation-list')?.textContent).toContain('哈囉')
  })

  // 裁決 4 的端到端接線：historical 是從 sessionState.kind 推出來的，不是寫死的 prop。
  it('viewing 時工具卡片展開後顯示歷史對話沒有原始輸出', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)

    fake.emitState({ kind: 'viewing', sessionId: 's-1' })
    fake.emitEvents([
      { kind: 'tool-use', messageId: 'm1', index: 0, id: 'tu_9', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', id: 'tu_9', content: 'src', isError: false },
      { kind: 'session-end', isError: false },
    ])

    const head = container.querySelector('.tool-head')
    if (head === null) throw new Error('找不到工具卡片')
    fireEvent.click(head)

    expect(container.querySelector('.tool-raw-absent')?.textContent).toBe(HISTORICAL_RAW_TEXT)
  })
})

  it('只收自己 conversationId 的事件與狀態', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))
    act(() => {
      for (const cb of fake.eventCbs) cb({ conversationId: 'other', events: [{ kind: 'user-text', text: '不是我的' }] })
      for (const cb of fake.stateCbs) cb({ conversationId: 'other', state: { kind: 'live', sessionId: 'x' } })
    })
    expect(result.current.view.turns).toEqual([])
    expect(result.current.sessionState).toEqual({ kind: 'idle' })
  })
