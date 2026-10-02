import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeHistory, stepLive, INITIAL_CURSOR, type Event } from '../src/shared/events.js'
import { liveEvents } from './helpers/live-events.js'

/** 讀一份錄下的事件流。規格 §9：案例來自真實資料而非測試自己造的。 */
function readFixture(name: string): readonly unknown[] {
  return readFileSync(`tests/fixtures/events/${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

const LIVE = readFixture('03-sdk-live-stream')
const HISTORY = readFixture('04-session-history')
const DENIED = readFixture('02-permission-denied')
const TOOL_USE = readFixture('01-tool-use-bash')

function tally(events: readonly Event[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
  return counts
}

function pick<K extends Event['kind']>(
  events: readonly Event[],
  kind: K
): Extract<Event, { kind: K }>[] {
  return events.filter((e): e is Extract<Event, { kind: K }> => e.kind === kind)
}

/** 逐則走一遍，收集「產出 0 個 Event」的那幾則原始訊息（游標照常推進）。 */
function silentMessages(msgs: readonly unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let cursor = INITIAL_CURSOR
  for (const m of msgs) {
    const step = stepLive(m, cursor)
    cursor = step.cursor
    if (step.events.length === 0) out.push(m as Record<string, unknown>)
  }
  return out
}

/** 把一則 live 訊息標成可讀的類別名，stream_event 要看進 event.type 與 delta.type。 */
function labelOf(m: Record<string, unknown>): string {
  if (m['type'] === 'system') return `system/${String(m['subtype'])}`
  if (m['type'] !== 'stream_event') return String(m['type'])
  const ev = m['event'] as Record<string, unknown> | undefined
  const evType = String(ev?.['type'])
  if (evType !== 'content_block_delta') return evType
  const delta = ev?.['delta'] as Record<string, unknown> | undefined
  return `content_block_delta/${String(delta?.['type'])}`
}

describe('fixture 守衛', () => {
  it('三份 fixture 都讀得到內容（fixture 被誤刪時所有測試會對空陣列跑迴圈然後全過）', () => {
    expect(LIVE.length).toBeGreaterThanOrEqual(50)
    expect(HISTORY.length).toBeGreaterThanOrEqual(6)
    expect(DENIED.length).toBeGreaterThanOrEqual(20)
  })

  it('live fixture 含足量 stream_event（逐字串流的測試對象）', () => {
    const n = LIVE.filter((m) => (m as { type?: unknown }).type === 'stream_event').length
    expect(n).toBeGreaterThanOrEqual(30)
  })
})

describe('stepLive 對真實 live fixture 的完整產出', () => {
  const events = liveEvents(LIVE)

  // 這是本 task 最重要的一條：任何被刪掉的分支都會讓某個數字對不上。
  it('各類 Event 的筆數精確吻合實機數過的數字', () => {
    expect(tally(events)).toEqual({
      'session-start': 1,
      'message-start': 2,
      'block-start': 4,
      'thinking-delta': 4,
      'text-delta': 8,
      'tool-input-delta': 4,
      'block-stop': 4,
      thinking: 2,
      text: 1,
      'tool-use': 1,
      'tool-result': 1,
      'tool-raw-output': 1,
      'session-end': 1,
    })
  })

  it('fixture 03 全程 0 個 unknown（裁決 1 的六種都認得出來）', () => {
    expect(pick(events, 'unknown')).toHaveLength(0)
  })

  it('54 行裡有 21 行產出 0 個 Event，而且全在裁決 1 的窮舉清單裡', () => {
    const empty = silentMessages(LIVE)
    expect(empty).toHaveLength(21)
    for (const m of empty) {
      expect([
        'system/hook_started',
        'system/hook_response',
        'system/status',
        'system/thinking_tokens',
        'rate_limit_event',
        'content_block_delta/signature_delta',
        'message_delta',
        'message_stop',
      ]).toContain(labelOf(m))
    }
  })

  it('裁決 1 的清單覆蓋 signature_delta ×2、message_delta ×2、message_stop ×2', () => {
    const labels = silentMessages(LIVE).map(labelOf)
    const count = (label: string): number => labels.filter((l) => l === label).length
    expect(count('content_block_delta/signature_delta')).toBe(2)
    expect(count('message_delta')).toBe(2)
    expect(count('message_stop')).toBe(2)
  })
})

describe('stepLive 的串流欄位', () => {
  const events = liveEvents(LIVE)

  it('text_delta 串接出的 466 字元與後到的完整快照一字不差（去重的前提）', () => {
    const streamed = pick(events, 'text-delta')
      .map((e) => e.text)
      .join('')
    const snapshot = pick(events, 'text')
      .map((e) => e.text)
      .join('')
    expect(streamed).toHaveLength(466)
    expect(snapshot).toBe(streamed)
  })

  it('input_json_delta 串接出合法 JSON，且等於完整快照的 input', () => {
    const partial = pick(events, 'tool-input-delta')
      .map((e) => e.partialJson)
      .join('')
    expect(partial).not.toBe('')
    expect(JSON.parse(partial)).toEqual(pick(events, 'tool-use')[0]?.input)
  })

  it('content_block_stop 產出 block-stop，它是 complete 欄位的唯一來源', () => {
    const stops = pick(events, 'block-stop')
    expect(stops).toHaveLength(4)
    expect(stops.map((e) => e.index)).toEqual([0, 1, 0, 1])
  })

  it('index 每則訊息各自從 0 開始，所以去重鍵必須是 (messageId, index)', () => {
    const starts = pick(events, 'block-start')
    expect(starts.map((e) => e.index)).toEqual([0, 1, 0, 1])
    const ids = [...new Set(starts.map((e) => e.messageId))]
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^msg_/)
  })

  it('block-start 帶得出工具名稱與 toolUseId', () => {
    const toolStart = pick(events, 'block-start').find((e) => e.blockType === 'tool_use')
    expect(toolStart?.toolName).toBe('Bash')
    expect(toolStart?.toolUseId).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
  })

  it('delta 與其後的完整快照落在同一個 (messageId, index)', () => {
    const delta = pick(events, 'text-delta')[0]
    const snap = pick(events, 'text')[0]
    expect(delta).toBeDefined()
    expect(snap?.messageId).toBe(delta?.messageId)
    expect(snap?.index).toBe(delta?.index)
  })

  it('message_start 產出 message-start 並帶 model', () => {
    const starts = pick(events, 'message-start')
    expect(starts).toHaveLength(2)
    expect(starts[0]?.model).toBe('claude-opus-5')
  })
})

describe('stepLive 的非串流訊息', () => {
  const events = liveEvents(LIVE)

  it('system/init 產出 session-start，帶 sessionId 與 cwd', () => {
    const start = pick(events, 'session-start')[0]
    expect(start?.sessionId).toBe('a727625f-71c3-49c8-8646-2414bede4756')
    expect(start?.cwd).toContain('/sdkprobe')
  })

  it('tool_use_result 在 user 訊息頂層而非 content 內，產出 tool-raw-output（規格 §6）', () => {
    const raw = pick(events, 'tool-raw-output')[0]
    expect(raw?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(raw?.stdout).toContain('cap.txt')
    expect(raw?.stderr).toBe('')
    expect(raw?.interrupted).toBe(false)
  })

  it('result 產出 session-end，帶成本與輪數', () => {
    const end = pick(events, 'session-end')[0]
    expect(end?.isError).toBe(false)
    expect(end?.costUsd).toBeCloseTo(0.3197795)
    expect(end?.numTurns).toBe(2)
  })

  it('result 帶 errors 陣列時，session-end 的 errorMessage 以換行接起來（裁決 17）', () => {
    const end = pick(
      stepLive(
        {
          type: 'result',
          is_error: true,
          api_error_status: 529,
          errors: ['overloaded', 'retry later'],
        },
        INITIAL_CURSOR
      ).events,
      'session-end'
    )[0]
    expect(end?.isError).toBe(true)
    expect(end?.apiErrorStatus).toBe(529)
    expect(end?.errorMessage).toBe('overloaded\nretry later')
  })

  it('result 沒有 errors 時，session-end 不帶 errorMessage 欄位（裁決 17）', () => {
    const end = pick(
      stepLive({ type: 'result', is_error: false }, INITIAL_CURSOR).events,
      'session-end'
    )[0]
    expect(end).toBeDefined()
    expect(end !== undefined && 'errorMessage' in end).toBe(false)
  })

  it('system/permission_denied 產出 permission-denied（fixture 02）', () => {
    const denied = pick(liveEvents(DENIED), 'permission-denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]?.toolName).toBe('Bash')
    expect(denied[0]?.toolUseId).toBe('toolu_015NDSGktRsH8rWhzAALV3vY')
    expect(denied[0]?.message).toContain('was blocked')
  })

  it('tool_use_result 是字串時照樣產出 tool-raw-output（fixture 02 的實際形狀）', () => {
    const raw = pick(liveEvents(DENIED), 'tool-raw-output')[0]
    expect(raw?.stdout).toContain('was blocked')
    expect(raw?.stderr).toBe('')
  })
})

/**
 * 修正 5（RESULTS 待辦第 9 列前半，Ruling 14 修訂）：Write／Edit／Read／Grep 等所有
 * 非 Bash 工具的 `tool_use_result` 各是自家形狀（SDK `ToolOutputSchemas` 聯集，除
 * Bash 外沒有共同欄位），統一判準是「物件，且沒有 stdout／stderr」。內容已經在
 * 同一則訊息的 tool_result 區塊裡，這裡沒有第二份可渲染的東西，回空陣列而不是
 * unknown。unknown 只留給非物件非字串（陣列、數字、布林）與缺 toolUseId 的畸形情況。
 */
describe('修正 5：非 Bash 工具的結構化 tool_use_result 不畫 unknown 卡片', () => {
  const toolResultBlock = {
    type: 'tool_result',
    tool_use_id: 'toolu_write',
    content: 'File created successfully at: /x/hello.txt',
    is_error: false,
  }

  it('Write 的結構化結果（帶 type 欄位）不產出 unknown 也不產出 tool-raw-output', () => {
    const input = {
      type: 'user',
      message: { content: [toolResultBlock] },
      tool_use_result: {
        type: 'create',
        filePath: '/x/hello.txt',
        content: 'hi\n',
        structuredPatch: [],
        originalFile: null,
        userModified: false,
      },
    }
    const events = stepLive(input, INITIAL_CURSOR).events
    expect(events.map((e) => e.kind)).toEqual(['tool-result'])
  })

  it('Edit 的結構化結果（FileEditOutput，沒有 type 欄位）一樣不產出 unknown', () => {
    const input = {
      type: 'user',
      message: { content: [toolResultBlock] },
      tool_use_result: {
        filePath: '/x/hello.txt',
        oldString: 'hi',
        newString: 'hello',
        originalFile: 'hi\n',
        structuredPatch: [],
        userModified: false,
        replaceAll: false,
      },
    }
    const events = stepLive(input, INITIAL_CURSOR).events
    expect(events.map((e) => e.kind)).toEqual(['tool-result'])
  })

  it('沒有 type、也沒有 stdout／stderr 的物件一律視為結構化結果，回空陣列（Ruling 14）', () => {
    const input = {
      type: 'user',
      message: { content: [toolResultBlock] },
      tool_use_result: { foo: 1 },
    }
    const events = stepLive(input, INITIAL_CURSOR).events
    expect(events.map((e) => e.kind)).toEqual(['tool-result'])
  })

  it.each([
    [{ type: 'text', text: '完成' }],
    [{ type: 'text', text: '完成' }, { type: 'image', data: 'AQID', mimeType: 'image/png' }],
  ])('MCP 內容陣列只產出 tool-result 並保留內容: %j', (...content) => {
    const input = {
      type: 'user',
      message: { content: [{ ...toolResultBlock, content }] },
      tool_use_result: content,
    }
    const events = stepLive(input, INITIAL_CURSOR).events
    expect(events).toEqual([{ kind: 'tool-result', id: toolResultBlock.tool_use_id, content, isError: false }])
  })
})

describe('normalizeHistory 對真實 history fixture', () => {
  const events = HISTORY.flatMap((m) => [...normalizeHistory(m)])

  it('各類 Event 的筆數精確吻合', () => {
    expect(tally(events)).toEqual({
      'user-text': 1,
      thinking: 2,
      'tool-use': 1,
      'tool-result': 1,
      text: 1,
    })
  })

  it('六行裡沒有任何一行產出零個 Event', () => {
    for (const [i, m] of HISTORY.entries()) {
      expect(normalizeHistory(m).length, `第 ${i + 1} 行`).toBeGreaterThan(0)
    }
  })

  it('使用者提問轉成 user-text', () => {
    expect(pick(events, 'user-text')[0]?.text).toContain('echo hello > cap.txt')
  })

  it('tool_use 轉成 tool-use，input 是解析好的物件', () => {
    const tool = pick(events, 'tool-use')[0]
    expect(tool?.name).toBe('Bash')
    expect(tool?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect((tool?.input as { command?: string }).command).toContain('echo hello')
  })

  it('讀取舊 MCP 工具事件時改用 YesChef 前綴', () => {
    const history = normalizeHistory({
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'legacy', name: 'mcp__sidepane__view_click', input: {} }] },
    })
    expect(pick(history, 'tool-use')[0]?.name).toBe('mcp__yeschef__view_click')

    const live = stepLive({
      type: 'stream_event', event: {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'legacy-live', name: 'mcp__sidepane__view_click' },
      },
    }, INITIAL_CURSOR)
    expect(pick(live.events, 'block-start')[0]?.toolName).toBe('mcp__yeschef__view_click')
  })

  it('tool_result 轉成 tool-result，isError 讀得到', () => {
    const result = pick(events, 'tool-result')[0]
    expect(result?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(result?.isError).toBe(false)
    expect(String(result?.content)).toContain('cap.txt')
  })

  it('assistant 的完整回答帶得出 messageId，且沒有 index（歷史路徑沒有 delta 要去重）', () => {
    const text = pick(events, 'text')[0]
    expect(text?.messageId).toBe('msg_011CecHvmWYSkjexndc45ePc')
    expect(text?.index).toBeUndefined()
    expect(text?.text).toContain('| 項目 | 值 |')
    // messageId 取 message.id 不取每行的 uuid：4 行 assistant 是 2 則 API 訊息各拆成 2 行
    const assistantIds = events.flatMap((e) => ('messageId' in e ? [e.messageId] : []))
    expect(assistantIds).toHaveLength(4)
    expect(new Set(assistantIds).size).toBe(2)
  })

  it('history 沒有 tool_use_result，所以不產出 tool-raw-output', () => {
    expect(pick(events, 'tool-raw-output')).toHaveLength(0)
  })
})

describe('裁決 1：認得出來但沒有可渲染內容的輸入回空陣列', () => {
  const silent: readonly [string, unknown][] = [
    [
      'signature_delta',
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'abc' },
        },
      },
    ],
    [
      'message_delta',
      {
        type: 'stream_event',
        event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
      },
    ],
    ['message_stop', { type: 'stream_event', event: { type: 'message_stop' } }],
    ['rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }],
    ['system/status', { type: 'system', subtype: 'status', status: 'requesting' }],
    [
      'system/api_retry',
      { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, delay_ms: 2000 },
    ],
  ]

  it.each(silent)('%s 回空陣列且游標不變', (_label, input) => {
    const step = stepLive(input, INITIAL_CURSOR)
    expect(step.events).toEqual([])
    expect(step.cursor).toEqual(INITIAL_CURSOR)
  })
})

describe('認不出來的輸入一律產出 unknown，不丟棄也不拋錯', () => {
  const cases: readonly [string, unknown][] = [
    ['未知 type', { type: 'brand_new_sdk_event', payload: 42 }],
    ['null', null],
    ['字串', 'not an event'],
  ]

  it.each(cases)('stepLive：%s', (_label, input) => {
    const events = stepLive(input, INITIAL_CURSOR).events
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('unknown')
    expect((events[0] as { raw: unknown }).raw).toEqual(input)
  })

  it.each(cases)('normalizeHistory：%s', (_label, input) => {
    const events = normalizeHistory(input)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('unknown')
    expect((events[0] as { raw: unknown }).raw).toEqual(input)
  })

  it('未知的 system 子型別也產出 unknown（例外清單只有五個子型別）', () => {
    const events = stepLive({ type: 'system', subtype: 'brand_new_subtype' }, INITIAL_CURSOR).events
    expect(events.map((e) => e.kind)).toEqual(['unknown'])
  })

  it('未知的 stream_event 子型別也產出 unknown（裁決 1 的清單是窮舉的）', () => {
    const events = stepLive(
      { type: 'stream_event', event: { type: 'brand_new_stream_event' } },
      INITIAL_CURSOR
    ).events
    expect(events.map((e) => e.kind)).toEqual(['unknown'])
  })

  it('未知的 content block 型別產出 unknown 而非整則訊息消失', () => {
    const events = normalizeHistory({
      type: 'assistant',
      message: {
        id: 'msg_x',
        content: [{ type: 'server_tool_use', id: 'x' }, { type: 'text', text: 'hi' }],
      },
    })
    expect(events.map((e) => e.kind)).toEqual(['unknown', 'text'])
  })

  // 修正回合 1：畸形 user 訊息與 assistantMessageEvents 對稱，回 unknown 而非靜默回空陣列。
  const malformedUser: readonly [string, Record<string, unknown>][] = [
    ['message 缺欄位', { type: 'user' }],
    ['message 是 null', { type: 'user', message: null }],
    ['content 是空陣列', { type: 'user', message: { content: [] } }],
    ['content 型別不對（數字）', { type: 'user', message: { content: 42 } }],
  ]

  it.each(malformedUser)('stepLive：畸形 user 訊息（%s）產出 unknown', (_label, input) => {
    expect(stepLive(input, INITIAL_CURSOR).events).toEqual([{ kind: 'unknown', raw: input }])
  })

  it.each(malformedUser)('normalizeHistory：畸形 user 訊息（%s）產出 unknown', (_label, input) => {
    expect(normalizeHistory(input)).toEqual([{ kind: 'unknown', raw: input }])
  })

  it('content 是空字串時仍算合法，產出 user-text 而非 unknown', () => {
    const input = { type: 'user', message: { content: '' } }
    expect(normalizeHistory(input)).toEqual([{ kind: 'user-text', text: '' }])
  })
})

describe('reset 由 main 合成，正規化層永遠不產出（裁決 22）', () => {
  it('四份 fixture 跑完都沒有任何 reset', () => {
    const all: readonly Event[] = [
      ...liveEvents(TOOL_USE),
      ...liveEvents(DENIED),
      ...liveEvents(LIVE),
      ...liveEvents(HISTORY),
      ...HISTORY.flatMap((m) => [...normalizeHistory(m)]),
    ]
    expect(all.length).toBeGreaterThan(0)
    expect(all.filter((e) => e.kind === 'reset')).toHaveLength(0)
  })
})

describe('轉接器不修改輸入，且是純函式', () => {
  it('stepLive 不修改傳入的訊息', () => {
    const input = JSON.parse(JSON.stringify(LIVE[11])) as unknown
    const snapshot = JSON.stringify(input)
    stepLive(input, INITIAL_CURSOR)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('normalizeHistory 不修改傳入的訊息', () => {
    const input = JSON.parse(JSON.stringify(HISTORY[5])) as unknown
    const snapshot = JSON.stringify(input)
    normalizeHistory(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('stepLive 對同一個 cursor 呼叫兩次得到相同結果，且不改動傳入的 cursor', () => {
    const a = stepLive(LIVE[10], INITIAL_CURSOR)
    const b = stepLive(LIVE[10], INITIAL_CURSOR)
    expect(a).toEqual(b)
    expect(INITIAL_CURSOR).toEqual({ messageId: '', openIndex: -1 })
  })

  it('user 訊息裡未知型別的 content block 產出 unknown，不被丟棄', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: '從未見過的 user block', payload: 1 }] },
    }
    const events = normalizeHistory(msg)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('unknown')
  })

  it('content_block_start 形狀不符時產出 unknown', () => {
    // content_block 的 type 不在 text／thinking／tool_use 三者之內。
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: '沒見過的 block 型別' },
      },
    }
    const step = stepLive(msg, INITIAL_CURSOR)
    expect(step.events).toHaveLength(1)
    expect(step.events[0]?.kind).toBe('unknown')
  })

  it('未知的 delta 型別產出 unknown，不被丟棄', () => {
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: '沒見過的 delta 型別', value: 'x' },
      },
    }
    const step = stepLive(msg, INITIAL_CURSOR)
    expect(step.events).toHaveLength(1)
    expect(step.events[0]?.kind).toBe('unknown')
  })

  it('兩個獨立游標互不影響：推進過的那個不會沾到另一個（裁決 2）', () => {
    const blockStop = { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
    const advanced = stepLive(LIVE[10], INITIAL_CURSOR).cursor
    expect(advanced.messageId).toMatch(/^msg_/)
    const fromAdvanced = stepLive(blockStop, advanced).events
    expect(pick(fromAdvanced, 'block-stop')[0]?.messageId).toBe(advanced.messageId)
    const fromFresh = stepLive(blockStop, INITIAL_CURSOR).events
    expect(pick(fromFresh, 'block-stop')[0]?.messageId).toBe('')
  })
})

describe('system/compact_boundary 產出 compact-boundary', () => {
  const boundary = (metadata: unknown) => ({
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 's-1',
    compact_metadata: metadata,
  })

  it('auto 觸發:帶 trigger、pre_tokens、post_tokens', () => {
    const events = stepLive(boundary({ trigger: 'auto', pre_tokens: 70422, post_tokens: 27775 }), INITIAL_CURSOR).events
    expect(events).toEqual([{ kind: 'compact-boundary', trigger: 'auto', preTokens: 70422, postTokens: 27775 }])
  })

  it('manual 觸發、沒有 post_tokens 時不帶那個 key', () => {
    const events = stepLive(boundary({ trigger: 'manual', pre_tokens: 50000 }), INITIAL_CURSOR).events
    expect(events).toEqual([{ kind: 'compact-boundary', trigger: 'manual', preTokens: 50000 }])
  })

  it('缺 compact_metadata 時回 unknown,不猜', () => {
    const events = stepLive({ type: 'system', subtype: 'compact_boundary', session_id: 's-1' }, INITIAL_CURSOR).events
    expect(events.map((e) => e.kind)).toEqual(['unknown'])
  })

  it('pre_tokens 不是數字、或 trigger 不在兩個值之內,回 unknown', () => {
    expect(stepLive(boundary({ trigger: 'auto', pre_tokens: '70422' }), INITIAL_CURSOR).events.map((e) => e.kind)).toEqual(['unknown'])
    expect(stepLive(boundary({ trigger: 'weird', pre_tokens: 1 }), INITIAL_CURSOR).events.map((e) => e.kind)).toEqual(['unknown'])
  })

  it('不動 cursor', () => {
    const cursor = { messageId: 'm-1', openIndex: 2 }
    expect(stepLive(boundary({ trigger: 'auto', pre_tokens: 1 }), cursor).cursor).toBe(cursor)
  })
})

describe('壓縮摘要的 user 訊息不是使用者說的話', () => {
  const summary = (extra: Record<string, unknown>) => ({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued…' }] },
    ...extra,
  })

  it('live 路徑:isCompactSummary 為 true 時產出 compact-summary,不是 user-text', () => {
    const events = stepLive(summary({}), INITIAL_CURSOR).events
    expect(events).toEqual([{ kind: 'compact-summary', text: 'This session is being continued…' }])
  })

  it('歷史路徑同樣認得這個旗標', () => {
    expect(normalizeHistory(summary({})).map((e) => e.kind)).toEqual(['compact-summary'])
  })

  it('沒有旗標的一般 user 訊息仍然是 user-text', () => {
    const plain = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '嗨' }] } }
    expect(stepLive(plain, INITIAL_CURSOR).events).toEqual([{ kind: 'user-text', text: '嗨' }])
  })

  it('旗標不是 true(例如字串)時不當成摘要', () => {
    const events = stepLive(summary({ isCompactSummary: 'yes' }), INITIAL_CURSOR).events
    expect(events.map((e) => e.kind)).toEqual(['user-text'])
  })

  it('live 串流用的是 isSynthetic,不是 isCompactSummary(實測形狀)', () => {
    const live = {
      type: 'user',
      isSynthetic: true,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued…' }] },
    }
    expect(stepLive(live, INITIAL_CURSOR).events.map((e) => e.kind)).toEqual(['compact-summary'])
  })

  it('content 是字串時也收得到', () => {
    const asString = { type: 'user', isSynthetic: true, message: { role: 'user', content: '摘要' } }
    expect(stepLive(asString, INITIAL_CURSOR).events).toEqual([{ kind: 'compact-summary', text: '摘要' }])
  })
})
