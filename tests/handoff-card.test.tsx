// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { App } from '../src/renderer/App.js'
import {
  HandoffCard,
  HANDOFF_BUTTON_TEXT,
  HANDOFF_INCOMPLETE_TEXT,
  HANDOFF_NOTIFIED_TEXT,
  HANDOFF_NO_REASON_TEXT,
  HANDOFF_PREPARING_TEXT,
} from '../src/renderer/components/HandoffCard.js'
import { REQUEST_HANDOFF_TOOL } from '../src/shared/view-tools.js'
import type { ToolBlock } from '../src/renderer/components/block-equals.js'
import type { Event } from '../src/shared/events.js'
import type { EventsBatchPayload, SessionSummary, YesChefApi } from '../src/shared/ipc.js'
import { createFakeYesChef, ONE_PROJECT, type FakeYesChef } from './helpers/fake-yeschef.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const BASE = 1_764_000_000_000

function block(over: Partial<ToolBlock> = {}): ToolBlock {
  return {
    kind: 'tool',
    id: 'toolu_1',
    name: REQUEST_HANDOFF_TOOL,
    input: { reason: '請幫我登入' },
    status: 'running',
    ...over,
  }
}

function textOf(container: HTMLElement, selector: string): string | undefined {
  return container.querySelector(selector)?.textContent ?? undefined
}

describe('HandoffCard 各狀態的內容（契約 §12 狀態對照表）', () => {
  it('streaming-input：標題加準備交接，沒有理由、等待時間或按鈕', () => {
    const { container } = render(<HandoffCard block={block({ status: 'streaming-input', input: undefined })} historical={false} onDone={vi.fn()} />)
    expect(textOf(container, '.handoff-card__title')).toBe('交接給使用者')
    expect(textOf(container, '.handoff-card__reason')).toBe(HANDOFF_PREPARING_TEXT)
    expect(container.querySelector('.handoff-card__elapsed')).toBeNull()
    expect(container.querySelector('.handoff-card__button')).toBeNull()
    expect(container.querySelector('.handoff-card__result')).toBeNull()
    expect(container.querySelector('.handoff-card--pending')).not.toBeNull()
  })

  it('running 且非歷史：理由、已等待與按鈕都在，class 是 --pending', () => {
    const { container } = render(<HandoffCard block={block()} historical={false} onDone={vi.fn()} now={() => BASE} />)
    expect(textOf(container, '.handoff-card__reason')).toBe('請幫我登入')
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')
    expect(textOf(container, '.handoff-card__button')).toBe(HANDOFF_BUTTON_TEXT)
    expect(container.querySelector('.handoff-card--pending')).not.toBeNull()
  })

  it('awaiting-approval 且非歷史：與 running 一樣有按鈕', () => {
    const { container } = render(<HandoffCard block={block({ status: 'awaiting-approval' })} historical={false} onDone={vi.fn()} now={() => BASE} />)
    expect(textOf(container, '.handoff-card__button')).toBe(HANDOFF_BUTTON_TEXT)
    expect(container.querySelector('.handoff-card__elapsed')).not.toBeNull()
  })

  it.each([
    ['input 不是物件', 'abc' as unknown],
    ['input 沒有 reason', { note: '無關欄位' } as unknown],
    ['reason 是空字串', { reason: '' } as unknown],
    ['reason 不是字串', { reason: 42 } as unknown],
  ])('理由取不到時用 HANDOFF_NO_REASON_TEXT：%s', (_label, input) => {
    const { container } = render(<HandoffCard block={block({ input })} historical={false} onDone={vi.fn()} now={() => BASE} />)
    expect(textOf(container, '.handoff-card__reason')).toBe(HANDOFF_NO_REASON_TEXT)
  })

  it('running 但 historical：顯示未完成，沒有按鈕也沒有等待時間，class 是 --stale', () => {
    const { container } = render(<HandoffCard block={block()} historical={true} onDone={vi.fn()} now={() => BASE} />)
    expect(textOf(container, '.handoff-card__reason')).toBe('請幫我登入')
    expect(textOf(container, '.handoff-card__result')).toBe(HANDOFF_INCOMPLETE_TEXT)
    expect(container.querySelector('.handoff-card__button')).toBeNull()
    expect(container.querySelector('.handoff-card__elapsed')).toBeNull()
    expect(container.querySelector('.handoff-card--stale')).not.toBeNull()
    expect(container.querySelector('.handoff-card--pending')).toBeNull()
  })

  it('done：結果是 [{ type: text }] 時取 text，class 是 --done', () => {
    const { container } = render(<HandoffCard block={block({ status: 'done', result: [{ type: 'text', text: '使用者已完成，網址 https://a.test/ok' }] })} historical={false} onDone={vi.fn()} />)
    expect(textOf(container, '.handoff-card__result')).toBe('使用者已完成，網址 https://a.test/ok')
    expect(container.querySelector('.handoff-card--done')).not.toBeNull()
    expect(container.querySelector('.handoff-card__button')).toBeNull()
  })

  it.each([
    ['第一個元素不是 text 型別', [{ type: 'image', data: 'x' }], '[\n  {\n    "type": "image",\n    "data": "x"\n  }\n]'],
    ['結果不是陣列', { ok: true }, '{\n  "ok": true\n}'],
  ])('done：%s 時退回 formatValue', (_label, result, expected) => {
    const { container } = render(<HandoffCard block={block({ status: 'done', result })} historical={false} onDone={vi.fn()} />)
    expect(textOf(container, '.handoff-card__result')).toBe(expected)
  })

  it('error：class 加 --error，結果文字照樣顯示', () => {
    const { container } = render(<HandoffCard block={block({ status: 'error', result: [{ type: 'text', text: '交接逾時' }] })} historical={false} onDone={vi.fn()} />)
    expect(container.querySelector('.handoff-card--error')).not.toBeNull()
    expect(textOf(container, '.handoff-card__result')).toBe('交接逾時')
  })

  it('denied：有 deniedReason 用它，沒有時用「已拒絕」', () => {
    const withReason = render(<HandoffCard block={block({ status: 'denied', deniedReason: '使用者按了拒絕' })} historical={false} onDone={vi.fn()} />)
    expect(textOf(withReason.container, '.handoff-card__result')).toBe('使用者按了拒絕')
    cleanup()
    const without = render(<HandoffCard block={block({ status: 'denied' })} historical={false} onDone={vi.fn()} />)
    expect(textOf(without.container, '.handoff-card__result')).toBe('已拒絕')
  })
})

describe('HandoffCard 的「我好了」按鈕', () => {
  it('按一下用 block.id 呼叫 onDone，按鈕變成停用的已通知', () => {
    const onDone = vi.fn()
    const { container } = render(<HandoffCard block={block({ id: 'toolu_abc' })} historical={false} onDone={onDone} now={() => BASE} />)
    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    fireEvent.click(button)
    expect(onDone.mock.calls).toEqual([['toolu_abc']])
    expect(button.textContent).toBe(HANDOFF_NOTIFIED_TEXT)
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('同一批次連按兩次只呼叫一次 onDone', () => {
    const onDone = vi.fn()
    const { container } = render(<HandoffCard block={block({ id: 'toolu_abc' })} historical={false} onDone={onDone} now={() => BASE} />)
    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls).toEqual([['toolu_abc']])
  })
})

describe('HandoffCard 的已等待時間每 30 秒重算', () => {
  let current = BASE
  const now = (): number => current

  beforeEach(() => {
    current = BASE
    vi.useFakeTimers()
  })

  it('未滿 30 秒不重算，滿 30 秒才重算', () => {
    const { container } = render(<HandoffCard block={block()} historical={false} onDone={vi.fn()} now={now} />)
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')
    current = BASE + 90_000
    act(() => { vi.advanceTimersByTime(29_999) })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')
    act(() => { vi.advanceTimersByTime(1) })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 1 分鐘')
    current = BASE + 3 * 60_000
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 3 分鐘')
  })

  it('historical 的等待中卡片不排計時器', () => {
    render(<HandoffCard block={block()} historical={true} onDone={vi.fn()} now={now} />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('done 的卡片不排計時器', () => {
    render(<HandoffCard block={block({ status: 'done', result: [] })} historical={false} onDone={vi.fn()} now={now} />)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('卸載後計時器要清掉', () => {
    const { unmount } = render(<HandoffCard block={block()} historical={false} onDone={vi.fn()} now={now} />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

/** 底是共用的 `createFakeYesChef`(專案那幾個成員由它補齊),上面只覆蓋本檔要觀察的兩件事。 */
function createFakeApi(): {
  readonly api: YesChefApi
  readonly handoffDone: ReturnType<typeof vi.fn>
  emit(events: readonly Event[]): void
  emitProjects: FakeYesChef['emitProjects']
} {
  const shared = createFakeYesChef()
  const listeners = new Set<(payload: EventsBatchPayload) => void>()
  const handoffDone = vi.fn()
  const api: YesChefApi = {
    ...shared.api,
    onEvents: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onApprovalAsk: () => () => undefined,
    onSessionState: () => () => undefined,
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: (): Promise<readonly SessionSummary[]> => Promise.resolve([]),
    startNew: () => undefined,
    openHistory: () => undefined,
    handoffDone,
    terminalEndpoint: vi.fn(),
  }
  return {
    api,
    handoffDone,
    emit: (events) => act(() => { for (const listener of listeners) listener({ conversationId: 'p-1-conv', events }) }),
    emitProjects: shared.emitProjects,
  }
}

const HANDOFF_EVENT: Event = {
  kind: 'tool-use', messageId: 'msg_1', index: 0, id: 'toolu_h1', name: REQUEST_HANDOFF_TOOL,
  input: { reason: '請登入這個網站' },
}

const BASH_EVENT: Event = {
  kind: 'tool-use', messageId: 'msg_1', index: 1, id: 'toolu_b1', name: 'Bash', input: { command: 'ls' },
}

describe('App 把 request_handoff 的工具卡換成 HandoffCard', () => {
  it('codex 的平鋪工具名也畫成 HandoffCard(dynamic tool 沒有前綴)', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    fake.emit([
      { kind: 'message-start', messageId: 'msg_1' },
      { kind: 'tool-use', messageId: 'msg_1', index: 0, id: 'exec-1', name: 'request_handoff', input: { reason: '請登入這個網站' } },
    ])
    expect(container.querySelectorAll('.handoff-card')).toHaveLength(1)
    expect(textOf(container, '.handoff-card__reason')).toBe('請登入這個網站')
  })
  it('交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    fake.emit([{ kind: 'message-start', messageId: 'msg_1' }, HANDOFF_EVENT, BASH_EVENT])
    expect(container.querySelectorAll('.handoff-card')).toHaveLength(1)
    expect(textOf(container, '.handoff-card__reason')).toBe('請登入這個網站')
    const tools = container.querySelectorAll('.tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.querySelector('.tool-name')?.textContent).toBe('Bash')
  })

  it('按下「我好了」呼叫 api.handoffDone 並帶上 tool use id', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    fake.emit([{ kind: 'message-start', messageId: 'msg_1' }, HANDOFF_EVENT])
    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    fireEvent.click(button)
    expect(fake.handoffDone.mock.calls).toEqual([['toolu_h1']])
  })
})


describe('codex 平鋪工具名的批准卡', () => {
  it('view_eval 以 callId 配對到工具底下,不落到尾端', () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    fake.emitEvents([
      { kind: 'message-start', messageId: 'msg_1' },
      { kind: 'tool-use', messageId: 'msg_1', index: 0, id: 'exec-eval', name: 'view_eval', input: { expression: 'document.title' } },
    ])
    fake.emitAsk({
      projectId: 'p-1', conversationId: 'p-1-conv', requestId: 'approval-eval',
      toolUseId: 'exec-eval', toolName: 'view_eval', input: { expression: 'document.title' },
    })
    expect(container.querySelectorAll('.tool-call [data-testid="approval-card"]')).toHaveLength(1)
    expect(container.querySelector('.approval-tail')).toBeNull()
  })
})
