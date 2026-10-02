### Task 3: Event 型別與兩個正規化轉接器

**2026-09-02 依裁決 17 修訂**：`Event` 的 `session-end` 分支加 `errorMessage?: string`；
`resultEvents()` 從 `result` 訊息的 `errors`（字串陣列且非空時）以 `'\n'` 接成一段文字放進
該欄位，沒有就不帶。新增兩條測試與第 5 個突變，測試計數與提交訊息隨之更新（見下方標記處）。

**2026-09-02 依裁決 1、2、22 再次修訂**（三處，全部實跑驗過）：

- 裁決 2：刪掉 module 層級游標。對外只有 `stepLive`／`LiveCursor`／`LiveStep`／`INITIAL_CURSOR`，
  沒有 `normalizeLive` 與 `resetLiveNormalizer`。測試要一次餵整段 fixture 時，用新建的
  `tests/helpers/live-events.ts` 的純函式 `liveEvents()`。
- 裁決 1：`signature_delta`／`message_delta`／`message_stop` 改回空陣列，不再產出 `unknown`。
  fixture 03 因此從 6 個 `unknown` 變成 0 個，靜默行數從 15 變成 21。
- 裁決 22：`Event` 聯集加 `{ kind: 'reset' }`，`stepLive`／`normalizeHistory` 都不產出它。

規格 §4.1 的正規化層。live 與歷史兩條路徑的事件形狀不同，這一層把它們統一成同一個窄型別，
`fold()` 與所有 UI 元件之後只認 `Event`，SDK 演進的衝擊被擋在這一層。

兩個轉接器的參數型別**刻意是 `unknown` 而非 SDK 型別**：這裡是與 SDK 交接的地方，SDK 版本一變型別標註就
說謊，只有執行期檢查算數。

**跨模型審查（2026-09-02）推翻了本 task 的前一版，五項發現全部納入下方實作與測試：**

1. 前一版只處理 `content_block_delta` 的 `text_delta` 與 `thinking_delta`，其餘 `return []`。
   32 筆 `stream_event` 丟掉 20 筆，三份 fixture 105 行有 69 行產出 0 個 Event。
2. `content_block_stop` 被丟掉，而它是 `ConversationView` 裡 `complete` 欄位的唯一來源。
3. `input_json_delta` 被丟掉，工具呼叫從開始到完成之間畫面上完全沒東西。Write／Edit 的參數是
   幾千 token，那段時間就是一片空白。
4. 沒有 index 與 messageId，delta 累積出的內容與後到的完整快照無從去重。實機數過：8 筆
   `text_delta` 串接為 466 字元，第 50 行的完整 `text` 也是 466 字元，**同一份內容到達兩次**。
5. `tool_use_result`（規格 §6「展開後看得到未經處理的 stdout／stderr」的唯一來源）根本沒被讀到，
   它在 `user` 訊息的**頂層**，不在 `content` 裡。

而且前一版 13 個測試在整段 `stream_event` 處理刪掉之後照樣全過，因為「抓得到文字內容」那條的斷言
是 `'text-delta' || 'text'`，完整訊息就滿足了。下方測試因此改成**筆數精確斷言**：對
`03-sdk-live-stream.jsonl` 跑完之後，用一個 `toEqual` 比對所有 Event 類別的確切筆數，任何被刪掉
的分支都會讓某個數字對不上。

**live 路徑的呼叫方式（裁決 2）**：`content_block_start` ／ `content_block_delta` ／
`content_block_stop` 這三種 stream event **不帶 message id**（實機查證：整份 fixture 只有第
11、18、25、32、39、50 行出現 `msg_...`），而契約要求 delta 類 Event 的 `messageId` 是必填，
兩者只能靠一個跨訊息的游標調和。游標由呼叫端自己持有：從 `INITIAL_CURSOR` 起，每收一則訊息
呼叫 `stepLive(msg, cursor)`，把回傳的 `cursor` 存回去。Task 8 的 agent-host 每場 session 一份，
切換 session 時重建。本模組沒有任何 module 層級的可變狀態。

**Files:**
- Create: `src/shared/events.ts`
- Create: `tests/helpers/live-events.ts`
- Create: `tests/events.test.ts`

**Interfaces:**
- Consumes: `tests/fixtures/events/*.jsonl`（已錄下的真實事件流，不動）
- Produces:
  - `type Event`（契約原文照抄，含裁決 22 的 `{ kind: 'reset' }`）
  - `function stepLive(msg: unknown, cursor: LiveCursor): LiveStep`
  - `function normalizeHistory(msg: unknown): readonly Event[]`
  - `interface LiveCursor`、`interface LiveStep`、`const INITIAL_CURSOR`
  - `function liveEvents(msgs: readonly unknown[]): readonly Event[]`（`tests/helpers/live-events.ts`，
    測試專用的純函式，Task 4／4B 的測試共用）

- [ ] **Step 1: 寫失敗的測試**

先寫測試共用的輔助檔 `tests/helpers/live-events.ts`（裁決 2：測試要一次餵整段 fixture 時
用它，不再有 module 層級游標可以歸零）：

```typescript
import { stepLive, INITIAL_CURSOR, type Event, type LiveCursor } from '../../src/shared/events.js'

/**
 * 測試用：一次餵完一整段 live 訊息，回傳所有 Event。
 * 從 INITIAL_CURSOR 起用 stepLive 逐則歸約，把每步的 events 串起來。純函式，沒有跨呼叫狀態，
 * 兩次呼叫互不影響，正式程式碼的游標由 Task 8 的 agent-host 自己持有（裁決 2）。
 */
export function liveEvents(msgs: readonly unknown[]): readonly Event[] {
  const seed: { readonly events: readonly Event[]; readonly cursor: LiveCursor } = {
    events: [],
    cursor: INITIAL_CURSOR,
  }
  return msgs.reduce<typeof seed>((acc, msg) => {
    const step = stepLive(msg, acc.cursor)
    return { events: [...acc.events, ...step.events], cursor: step.cursor }
  }, seed).events
}
```

`vitest.config.ts` 的 `test.include` 是 `tests/**/*.test.ts`（Task 9 之後是
`tests/**/*.test.{ts,tsx}`），兩種寫法都不會把 `tests/helpers/live-events.ts` 當測試檔跑，
不必改設定。

`tests/events.test.ts`：

```typescript
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

  it('未知的 system 子型別也產出 unknown（例外清單只有四個子型別）', () => {
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
```

**這份測試的三類硬性要求各自落在哪裡**：

| 要求 | 測試 |
|---|---|
| fixture 非空守衛 | `describe('fixture 守衛')` 兩條。三份 fixture 各有下限，另加 `stream_event` 筆數下限 |
| 筆數精確斷言 | 「各類 Event 的筆數精確吻合實機數過的數字」，單一 `toEqual` 涵蓋 13 個類別共 34 筆 |
| `normalizeHistory` 用真實 fixture | `describe('normalizeHistory 對真實 history fixture')` 七條全部餵 `04-session-history.jsonl` |
| 未知輸入三條 | `it.each` 的未知 type／`null`／字串，兩個轉接器各跑一次，共 6 個案例 |
| 裁決 1 的空陣列清單 | `describe('裁決 1：認得出來但沒有可渲染內容的輸入回空陣列')` 五個案例，加上「21 行產出 0 個 Event」與「清單覆蓋 ×2×2×2」兩條 |

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/events.test.ts`
Expected: FAIL，無法解析 `../src/shared/events.js`

- [ ] **Step 3: 寫最小實作**

`src/shared/events.ts`：

```typescript
/**
 * SDK 事件到本專案窄型別的正規化層（規格 §4.1）。
 *
 * 兩個轉接器的參數是 `unknown` 而非 SDK 型別：這裡是與 SDK 交接的地方，SDK 版本一變型別標註就
 * 說謊，只有執行期檢查算數。認不出來的輸入一律產出 `unknown` Event；認得出來但沒有可渲染內容
 * 的那幾種（裁決 1 的窮舉清單）回空陣列，每一處都在註解寫明理由。
 */

export type Event =
  | { kind: 'session-start'; sessionId: string; cwd?: string; model?: string }
  | { kind: 'message-start'; messageId: string; model?: string }
  | {
      kind: 'block-start'
      messageId: string
      index: number
      blockType: 'text' | 'thinking' | 'tool_use'
      toolName?: string
      toolUseId?: string
    }
  | { kind: 'text-delta'; messageId: string; index: number; text: string }
  | { kind: 'thinking-delta'; messageId: string; index: number; text: string }
  | { kind: 'tool-input-delta'; messageId: string; index: number; partialJson: string }
  | { kind: 'block-stop'; messageId: string; index: number }
  // 完整快照。live 路徑在 delta 之後才到，歷史路徑只有這些。
  | { kind: 'text'; messageId?: string; index?: number; text: string }
  | { kind: 'thinking'; messageId?: string; index?: number; text: string }
  | {
      kind: 'tool-use'
      messageId?: string
      index?: number
      id: string
      name: string
      input: unknown
    }
  | { kind: 'tool-result'; id: string; content: unknown; isError: boolean }
  | { kind: 'tool-raw-output'; id: string; stdout: string; stderr: string; interrupted: boolean }
  | { kind: 'user-text'; text: string }
  | { kind: 'permission-denied'; toolName: string; toolUseId: string; message?: string }
  | {
      kind: 'session-end'
      isError: boolean
      costUsd?: number
      numTurns?: number
      apiErrorStatus?: unknown
      // 2026-09-02 依裁決 17 新增：result 訊息的 errors（字串陣列）以 '\n' 接成一段文字。
      errorMessage?: string
    }
  // 2026-09-02 依裁決 22 新增：main 合成，normalizer 不產出。
  | { kind: 'reset' }
  | { kind: 'unknown'; raw: unknown }

const unknownEvent = (raw: unknown): readonly Event[] => [{ kind: 'unknown', raw }]

// ---- 執行期型別守衛。對外來資料一律不信任 ----

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function asIndex(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}
function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : []
}
/** 2026-09-02 依裁決 17 新增：result 的 errors 欄位守衛，非字串陣列一律回 undefined。 */
function asStringArray(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as readonly string[])
    : undefined
}

// ---- content block 的映射。live 的完整快照與歷史共用同一份，形狀本來就一樣 ----

function assistantBlockToEvents(
  block: unknown,
  messageId: string | undefined,
  index: number | undefined
): readonly Event[] {
  const b = asRecord(block)
  if (b === null) return unknownEvent(block)
  const at = {
    ...(messageId === undefined ? {} : { messageId }),
    ...(index === undefined ? {} : { index }),
  }
  switch (b['type']) {
    case 'text': {
      const text = asString(b['text'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'text', ...at, text }]
    }
    case 'thinking': {
      const text = asString(b['thinking'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'thinking', ...at, text }]
    }
    case 'tool_use': {
      const id = asString(b['id'])
      const name = asString(b['name'])
      if (id === undefined || name === undefined) return unknownEvent(block)
      return [{ kind: 'tool-use', ...at, id, name, input: b['input'] }]
    }
    default:
      return unknownEvent(block)
  }
}

function userBlockToEvents(block: unknown): readonly Event[] {
  const b = asRecord(block)
  if (b === null) return unknownEvent(block)
  switch (b['type']) {
    case 'text': {
      const text = asString(b['text'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'user-text', text }]
    }
    case 'tool_result': {
      const id = asString(b['tool_use_id'])
      if (id === undefined) return unknownEvent(block)
      return [{ kind: 'tool-result', id, content: b['content'], isError: b['is_error'] === true }]
    }
    default:
      return unknownEvent(block)
  }
}

/**
 * `tool_use_result` 有兩種實測到的形狀，這裡統一成一種：
 * 物件 `{stdout, stderr, interrupted, ...}`（fixture 01／03），以及純字串（fixture 02 的
 * 權限拒絕，內容是 `Error: ... was blocked`）。字串就是那次執行的原始輸出，當成 stdout。
 * 規格 §6 的「展開後看得到未經處理的 stdout／stderr」只有這個來源。
 */
function rawOutputEvents(raw: unknown, toolUseId: string | undefined): readonly Event[] {
  if (raw === undefined || raw === null) return []
  if (toolUseId === undefined) return unknownEvent(raw)
  if (typeof raw === 'string') {
    return [{ kind: 'tool-raw-output', id: toolUseId, stdout: raw, stderr: '', interrupted: false }]
  }
  const r = asRecord(raw)
  if (r === null) return unknownEvent(raw)
  const stdout = asString(r['stdout'])
  const stderr = asString(r['stderr'])
  if (stdout === undefined && stderr === undefined) return unknownEvent(raw)
  return [
    {
      kind: 'tool-raw-output',
      id: toolUseId,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      interrupted: r['interrupted'] === true,
    },
  ]
}

function firstToolResultId(events: readonly Event[]): string | undefined {
  for (const e of events) if (e.kind === 'tool-result') return e.id
  return undefined
}

/** `tool_use_result` 在 user 訊息的頂層，不在 `content` 裡。它掛在同一則訊息的 tool_result 上。 */
function userMessageEvents(msg: Record<string, unknown>): readonly Event[] {
  const message = asRecord(msg['message'])
  const content = message === null ? undefined : message['content']
  const blocks: readonly unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content)
  const fromBlocks = blocks.flatMap(userBlockToEvents)
  return [...fromBlocks, ...rawOutputEvents(msg['tool_use_result'], firstToolResultId(fromBlocks))]
}

function assistantMessageEvents(
  msg: Record<string, unknown>,
  fallbackMessageId: string | undefined,
  openIndex: number | undefined
): readonly Event[] {
  const message = asRecord(msg['message'])
  if (message === null) return unknownEvent(msg)
  const messageId = asString(message['id']) ?? fallbackMessageId
  const blocks = asArray(message['content'])
  if (blocks.length === 0) return unknownEvent(msg)
  /**
   * 只有單一 block 時才敢貼 index。`includePartialMessages: true` 下 SDK 一個 block 發一則
   * assistant 訊息（實機查證：四份 fixture 全部的 assistant 訊息 content 長度都是 1），
   * 這時當下開著的 block index 就是它。多 block 時無從對應，index 留空，由 fold 依序附加。
   */
  const index = blocks.length === 1 ? openIndex : undefined
  return blocks.flatMap((b) => assistantBlockToEvents(b, messageId, index))
}

function resultEvents(msg: Record<string, unknown>): readonly Event[] {
  const costUsd = asNumber(msg['total_cost_usd'])
  const numTurns = asNumber(msg['num_turns'])
  const apiErrorStatus = msg['api_error_status']
  // 2026-09-02 依裁決 17：errors 是字串陣列且非空才接成 errorMessage，否則不帶該欄位。
  const errors = asStringArray(msg['errors'])
  const errorMessage = errors !== undefined && errors.length > 0 ? errors.join('\n') : undefined
  return [
    {
      kind: 'session-end',
      isError: msg['is_error'] === true,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(numTurns === undefined ? {} : { numTurns }),
      ...(apiErrorStatus === undefined || apiErrorStatus === null ? {} : { apiErrorStatus }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
  ]
}

// ---- live 路徑的游標 ----

/**
 * `content_block_start` ／ `content_block_delta` ／ `content_block_stop` 這三種 stream event
 * **不帶 message id**（實機查證：整份 03 fixture 只有第 11、18、25、32、39、50 行出現 `msg_...`），
 * 而 index 每則訊息各自從 0 重數，所以去重鍵必須是 `(messageId, index)`。兩件事只能靠一個跨訊息
 * 的游標調和：`messageId` 由 `message_start` 設定，`openIndex` 記住當下開著的 block，
 * 用來把後到的完整快照貼回正確的 index。
 */
export interface LiveCursor {
  readonly messageId: string
  readonly model?: string
  readonly openIndex: number
}

export interface LiveStep {
  readonly events: readonly Event[]
  readonly cursor: LiveCursor
}

export const INITIAL_CURSOR: LiveCursor = { messageId: '', openIndex: -1 }

/**
 * 裁決 1 的「認得出來但沒有可渲染內容」清單，`system` 的部分：hook／status／thinking_tokens。
 * 它們對渲染沒有意義且數量大（54 行的 fixture 裡佔 14 行）。其餘的 subtype 一律產出 unknown。
 */
const SILENT_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'hook_started',
  'hook_response',
  'status',
  'thinking_tokens',
])

function systemStep(m: Record<string, unknown>, cursor: LiveCursor): LiveStep {
  const subtype = m['subtype']
  if (subtype === 'init') {
    const sessionId = asString(m['session_id'])
    if (sessionId === undefined) return { events: unknownEvent(m), cursor }
    const cwd = asString(m['cwd'])
    const model = asString(m['model'])
    return {
      events: [
        {
          kind: 'session-start',
          sessionId,
          ...(cwd === undefined ? {} : { cwd }),
          ...(model === undefined ? {} : { model }),
        },
      ],
      cursor,
    }
  }
  if (subtype === 'permission_denied') {
    const toolName = asString(m['tool_name'])
    const toolUseId = asString(m['tool_use_id'])
    if (toolName === undefined || toolUseId === undefined) return { events: unknownEvent(m), cursor }
    const message = asString(m['message'])
    return {
      events: [
        {
          kind: 'permission-denied',
          toolName,
          toolUseId,
          ...(message === undefined ? {} : { message }),
        },
      ],
      cursor,
    }
  }
  if (typeof subtype === 'string' && SILENT_SYSTEM_SUBTYPES.has(subtype)) {
    return { events: [], cursor }
  }
  return { events: unknownEvent(m), cursor }
}

function streamEventStep(ev: Record<string, unknown>, cursor: LiveCursor): LiveStep {
  switch (ev['type']) {
    case 'message_start': {
      const message = asRecord(ev['message'])
      const messageId = message === null ? undefined : asString(message['id'])
      if (messageId === undefined) return { events: unknownEvent(ev), cursor }
      const model = message === null ? undefined : asString(message['model'])
      return {
        events: [{ kind: 'message-start', messageId, ...(model === undefined ? {} : { model }) }],
        cursor: { messageId, ...(model === undefined ? {} : { model }), openIndex: -1 },
      }
    }
    case 'content_block_start': {
      const index = asIndex(ev['index'])
      const cb = asRecord(ev['content_block'])
      const t = cb === null ? undefined : cb['type']
      const blockType = t === 'text' || t === 'thinking' || t === 'tool_use' ? t : undefined
      if (index === undefined || blockType === undefined || cb === null) {
        return { events: unknownEvent(ev), cursor }
      }
      const toolName = asString(cb['name'])
      const toolUseId = asString(cb['id'])
      return {
        events: [
          {
            kind: 'block-start',
            messageId: cursor.messageId,
            index,
            blockType,
            ...(toolName === undefined ? {} : { toolName }),
            ...(toolUseId === undefined ? {} : { toolUseId }),
          },
        ],
        cursor: { ...cursor, openIndex: index },
      }
    }
    case 'content_block_delta': {
      const index = asIndex(ev['index'])
      const d = asRecord(ev['delta'])
      if (index === undefined || d === null) return { events: unknownEvent(ev), cursor }
      const at = { messageId: cursor.messageId, index }
      switch (d['type']) {
        case 'text_delta': {
          const text = asString(d['text'])
          return text === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'text-delta', ...at, text }], cursor }
        }
        case 'thinking_delta': {
          const text = asString(d['thinking'])
          return text === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'thinking-delta', ...at, text }], cursor }
        }
        case 'input_json_delta': {
          const partialJson = asString(d['partial_json'])
          return partialJson === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'tool-input-delta', ...at, partialJson }], cursor }
        }
        // 裁決 1：signature_delta 是 thinking block 的密碼學簽章，不可顯示，也沒有任何
        // 可渲染內容。它認得出來，只是沒東西畫，所以回空陣列而不是產出一張原始 JSON 卡片。
        case 'signature_delta':
          return { events: [], cursor }
        default:
          return { events: unknownEvent(ev), cursor }
      }
    }
    case 'content_block_stop': {
      const index = asIndex(ev['index'])
      if (index === undefined) return { events: unknownEvent(ev), cursor }
      return {
        events: [{ kind: 'block-stop', messageId: cursor.messageId, index }],
        cursor: { ...cursor, openIndex: -1 },
      }
    }
    // 裁決 1：message_delta 帶的是 stop_reason 與 usage，統計已經由 result 訊息併進
    // session-end；message_stop 沒有任何欄位。兩者都認得出來但畫不出東西，回空陣列。
    // 游標不動：messageId 留到下一個 message_start 才換，跟其他不推進游標的分支一致。
    case 'message_delta':
    case 'message_stop':
      return { events: [], cursor }
    default:
      return { events: unknownEvent(ev), cursor }
  }
}

/**
 * live 轉接器：純函式，游標明著收進參數與回傳值。呼叫端（Task 8 的 agent-host）每場 session
 * 自己持有一份游標，從 `INITIAL_CURSOR` 起，每收一則訊息就把回傳的 `cursor` 存回去。
 */
export function stepLive(msg: unknown, cursor: LiveCursor): LiveStep {
  const m = asRecord(msg)
  if (m === null) return { events: unknownEvent(msg), cursor }
  switch (m['type']) {
    case 'system':
      return systemStep(m, cursor)
    case 'stream_event': {
      const ev = asRecord(m['event'])
      return ev === null ? { events: unknownEvent(m), cursor } : streamEventStep(ev, cursor)
    }
    case 'assistant': {
      const fallback = cursor.messageId === '' ? undefined : cursor.messageId
      const openIndex = cursor.openIndex >= 0 ? cursor.openIndex : undefined
      return { events: assistantMessageEvents(m, fallback, openIndex), cursor }
    }
    case 'user':
      return { events: userMessageEvents(m), cursor }
    case 'result':
      return { events: resultEvents(m), cursor }
    // 裁決 1：純粹的用量回報，認得出來但沒有可渲染內容。
    case 'rate_limit_event':
      return { events: [], cursor }
    default:
      return { events: unknownEvent(m), cursor }
  }
}

/**
 * `getSessionMessages()` 的產物。形狀是 `{type, uuid, session_id, message, ...}`：user 行的 `message`
 * 只有 `{role, content}`；assistant 行的 `message` 是完整的 API 訊息（`id`、`model`、`content`、`usage` 等）。
 * 沒有 stream event，所以不需要游標，也沒有 index。`messageId` 取 `message.id` 不取每行的 `uuid`：
 * 歷史檔把一則 API 訊息的每個 block 各寫成一行，fixture 04 的 4 行 assistant 只有 2 個 `message.id`。
 */
export function normalizeHistory(msg: unknown): readonly Event[] {
  const m = asRecord(msg)
  if (m === null) return unknownEvent(msg)
  switch (m['type']) {
    case 'user':
      return userMessageEvents(m)
    case 'assistant':
      return assistantMessageEvents(m, undefined, undefined)
    default:
      return unknownEvent(m)
  }
}
```

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/events.test.ts`
Expected: PASS，46 個測試（38 個 `it`，其中三個 `it.each` 分別展開 5、3、3 個案例）。
2026-09-02 於暫時 worktree 實跑：

```
 Test Files  1 passed (1)
      Tests  46 passed (46)
```

Run: `npm run typecheck`
Expected: 無錯誤。`src/shared/events.ts` 實測 420 行（裁決 2 刪掉 module 游標與兩個包裝
函式，裁決 22 加了一行型別），在單檔 800 行的上限內。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

七個突變各跑一次，每一個都必須讓測試變紅。前三個是「看起來還會過」的那種：事件照樣產出、
數量甚至不變，錯的是內容或欄位。第 5 個對應裁決 17，第 6 個對應裁決 1，第 7 個對應裁決 22。
下表的紅燈條數與測試名稱都是 2026-09-02 在暫時 worktree 實跑的結果。

| # | 突變 | 實測紅的測試 |
|---|---|---|
| 1 | `content_block_stop` 那個 case 改成 `return { events: [], cursor: { ...cursor, openIndex: -1 } }` | 「各類 Event 的筆數精確吻合」、「54 行裡有 21 行產出 0 個 Event」、「content_block_stop 產出 block-stop」、「兩個獨立游標互不影響」（4 條，實跑 4 紅 42 綠） |
| 2 | 刪掉 `input_json_delta` 那個 case（讓它落到 `default` 產出 unknown） | 「各類 Event 的筆數精確吻合」、「fixture 03 全程 0 個 unknown」、「input_json_delta 串接出合法 JSON」（3 條，實跑 3 紅 43 綠） |
| 3 | `message_start` 的回傳游標不記 messageId（`cursor: { ...cursor, openIndex: -1 }`） | 「index 每則訊息各自從 0 開始」、「delta 與其後的完整快照落在同一個 (messageId, index)」、「兩個獨立游標互不影響」（3 條，實跑 3 紅 43 綠） |
| 4 | `stepLive` 與 `normalizeHistory` 的 `default` 都改成回空陣列（靜默丟棄） | 「stepLive：未知 type」、「normalizeHistory：未知 type」（2 條，實跑 2 紅 44 綠） |
| 5 | `resultEvents` 不讀 `errors`（刪掉 `errorMessage` 那行 spread） | 「result 帶 errors 陣列時，session-end 的 errorMessage 以換行接起來（裁決 17）」（1 條，實跑 1 紅 45 綠） |
| 6 | 裁決 1 的三種改回產出 unknown（`signature_delta`／`message_delta`／`message_stop`） | 「各類 Event 的筆數精確吻合」、「fixture 03 全程 0 個 unknown」、「54 行裡有 21 行」、「裁決 1 的清單覆蓋 ×2×2×2」、裁決 1 空陣列組的三條（7 條，實跑 7 紅 39 綠） |
| 7 | `message_delta`／`message_stop` 改成產出 `{ kind: 'reset' }` | 上面第 6 項的前四條裡的三條、裁決 1 空陣列組的兩條、「四份 fixture 跑完都沒有任何 reset」（6 條，實跑 6 紅 40 綠） |

突變 2 值得特別看：它**沒有丟棄任何東西**，`input_json_delta` 照樣變成一個 unknown Event，
所以任何只斷言「事件沒有消失」的測試都會照樣綠。擋住它的是筆數精確斷言、「0 個 unknown」
與 JSON 串接那三條。

突變 3 更值得看：**筆數一個都沒變**，34 個 Event 全部照樣產出，只有 `messageId` 全成了空字串。
後果是 `fold()` 的去重鍵 `(messageId, index)` 在兩則訊息之間撞在一起，同一段回答渲染兩遍。
擋得住它的是那三條檢查 messageId 內容的測試。

**突變 5 的實測輸出**（裁決 17。刪掉 `resultEvents` 裡
`...(errorMessage === undefined ? {} : { errorMessage })` 那行）：

```
 FAIL  tests/events.test.ts > stepLive 的非串流訊息 > result 帶 errors 陣列時，session-end 的 errorMessage 以換行接起來（裁決 17）
AssertionError: expected undefined to be 'overloaded\nretry later' // Object.is equality
 Tests  1 failed | 45 passed (46)
```

只有目標測試變紅：`errorMessage` 欄位整個不會出現在產出的 Event 上，`end?.errorMessage`
讀到 `undefined`。緊鄰的「result 沒有 errors 時，session-end 不帶 errorMessage 欄位」
那條不受影響，因為它本來就斷言沒有這個欄位，跟這個突變的效果巧合一致，不構成防線。

**突變 6 的實測輸出**（裁決 1。三種改回 `unknownEvent(ev)`）：

```
 FAIL  tests/events.test.ts > stepLive 對真實 live fixture 的完整產出 > fixture 03 全程 0 個 unknown（裁決 1 的六種都認得出來）
AssertionError: expected [ …(6) ] to have a length of +0 but got 6
 FAIL  tests/events.test.ts > stepLive 對真實 live fixture 的完整產出 > 54 行裡有 21 行產出 0 個 Event，而且全在裁決 1 的窮舉清單裡
AssertionError: expected [ { type: 'system', …(6) }, …(14) ] to have a length of 21 but got 15
 Tests  7 failed | 39 passed (46)
```

15 與 6 這兩個數字就是裁決 1 之前的行為，這條突變等於把修訂整個退回去，七條防線同時倒下。

任何一個突變後測試仍然全綠，表示該條測試沒有測到它宣稱要測的東西，停下來回報。
七次的紅燈輸出與還原後的綠燈（`Tests  46 passed (46)`）都貼進報告，且每次還原都重新跑過
`tsc --noEmit` 確認無殘留的型別錯誤。

- [ ] **Step 6: 跑完整測試套件**

Run: `npm test`
Expected: PASS。總數在執行當下的既有總數上加 46，把實際數字記進報告。

- [ ] **Step 7: 提交**

```bash
git add src/shared/events.ts tests/helpers/live-events.ts tests/events.test.ts
git commit -m "feat: Event 型別與 stepLive/normalizeHistory 兩個正規化轉接器，含筆數精確斷言、裁決 1 的空陣列清單與裁決 22 的 reset"
```
