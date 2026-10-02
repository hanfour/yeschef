### Task 4: fold 核心：文字與思考區塊

**2026-09-02 依裁決 17 修訂**：`ConversationView` 加 `error?`，`fold()` 在 `session-end` 的
`isError: true` 時設定（`isError: false` 時維持 undefined），新增兩條測試與第 6 個突變。

**2026-09-02 依裁決 1、2、22 再次修訂**：

- 裁決 2：測試改用 Task 3 建立的 `tests/helpers/live-events.ts` 的 `liveEvents()`，
  不再有 `runLive`／`resetLiveNormalizer`／`beforeEach`。
- 裁決 1：fixture 03 不再產出 6 個 `unknown`。原本「6 個 unknown Event 全部落到 Block 裡」
  那條拆成兩條：fixture 03 的 unknown block 數是 0，加一條手工合成 `unknown` 事件驗
  `applyUnknown` 的掛載位置。新增第 8 個突變守住後者。
- 裁決 22：`applyEvent` 加 `case 'reset': return INITIAL_VIEW`，一條測試，第 7 個突變。

規格 §4.2 要的 `fold(events) → ConversationView`，把 Task 3 正規化出來的 `Event[]` 投影成
畫面要的資料結構。**範圍已縮小**：本 task 只處理 `text`、`thinking`、`unknown` 三種
Block；`tool_use` 相關事件只產出一個 `status: 'streaming-input'` 的最小佔位，工具的
狀態推進（`running`／`done`／`error`／`awaiting-approval`／`denied` 之間怎麼轉換）留給
Task 4B。這一點在程式碼註解與下面的實作裡都會標明。

**三件必須做對的事**（CONTRACT.md 已裁決，這裡照做）：

1. **去重。** 同一份內容以兩種方式送達：8 筆 `text-delta` 累積出 466 字元，之後一個
   完整 `text` 快照也是 466 字元。完整快照要「取代」delta 累積的內容，不是附加。
   鍵是 `(messageId, index)`。
2. **index 會重置。** 每則訊息的 block index 各自從 0 開始（fixture 03 第 12 行
   index=0、第 20 行 index=1、第 33 行又回到 index=0）。只用 index 當鍵會把不同訊息
   的 block 混在一起。
3. **`complete` 有三個來源（2026-09-02 裁決 5、15）。** `block-stop`：該 block
   單獨設完成。`session-end`：一次把所有 text／thinking block 設完成，不分是否
   曾收到各自的 `block-stop`。`user-text` 建立時：直接完成，使用者按下送出那刻
   就已經完成。歷史路徑不是第四個特例，是第二條規則的自然結果：載入端
   （Task 11 的 `session-store.ts`）在 `normalizeHistory` 產出的事件尾端補一筆
   `session-end`，歷史對話因此走同一條規則變完成。

**設計取捨：turn 的先後順序跟 turn 裝了哪些 block，分成兩份全域資料，不是每個 turn
自己揹一份 blocks 陣列。**

第一版實作圖省事，把 block 直接放進各自 turn 自己的陣列裡：先用 `messageId` 找到
turn，再用 `index` 找 turn 內的 block。這版本讓「去重：完整快照取代 delta」的測試
通過，也讓「index 重置」的測試通過，但拿「把鍵從 `(messageId, index)` 改成只用
`index`」這個突變去驗證時，**測試仍然全綠，沒有一條變紅**。

原因是 `messageId` 這個維度其實已經靠「先找到哪個 turn」悄悄補上了：搜尋範圍本來就
被限制在同一個 turn 的 blocks 陣列裡，`(messageId, index)` 退化成只剩 `index` 在做
事，鍵裡帶不帶 `messageId` 結果都一樣。這正是任務說明裡提到的「看起來還會過的突
變」：斷言對、名字對，但實作的資料結構讓 messageId 這個防線形同虛設。

修法是把去重查找攤平成一份全域、跨所有 turn 的 `records` 清單，比對鍵時不先按
turn 分流，直接對整份清單比對。這樣「鍵要不要帶 messageId」才是唯一防線：拿掉它，
兩則訊息的 index=0 會真的撞在一起。turn 的先後順序另外記在 `turnOrder`，最後再用
`turnId` 把 `records` 分組回各自的 turn（`buildTurns`）。改完之後同一個突變會準確
命中「index 重置」測試（見 Step 5，附有實際跑出的紅燈輸出）。

**Files:**
- Create: `src/shared/fold.ts`
- Create: `tests/fold.test.ts`

**Interfaces:**
- Consumes: `src/shared/events.ts` 的 `Event`（Task 3 產出）、`tests/helpers/live-events.ts` 的
  `liveEvents()`（Task 3 建立）、`tests/fixtures/events/*.jsonl`
- Produces:
  - `interface ConversationView { sessionId?, turns, cost?, ended, error? }`
  - `interface Turn { role, messageId?, blocks }`
  - `type Block`（`text` | `thinking` | `tool` | `unknown`，契約原文照抄）
  - `function fold(events: readonly Event[]): ConversationView`

  下游用法：Task 9／10／11 的 React 元件讀取 `ConversationView`，每次收到新的一批
  `Event` 就把累積到當下的完整事件陣列整包丟給 `fold()` 重算。`fold()` 是純函式，
  沒有跨呼叫狀態，不是餵單一新事件做增量更新，跟 Task 3 `stepLive` 的游標模式是
  兩回事。

**`complete` 規則的由來（2026-09-02 裁決 5、15 定案，記錄理由不是留待裁決）：**

第一版實作發現「`complete` 嚴格只由 `block-stop` 決定」這條字面規則，對歷史
路徑與使用者訊息有副作用：history 的 assistant 訊息沒有 `block-stop` 事件
（Task 3 的 `normalizeHistory` 從不產出這個 kind），照字面會永遠停在
`complete: false`。UI 若把 `complete: false` 顯示成「還在串流中」（例如游標
閃爍），已經講完的歷史對話會被誤判成仍在輸出。

這個發現回報後，裁決 5 先加了「`session-end` 到達時其餘所有 block 一律
`complete: true`」；裁決 15 進一步統一機制：不給 Event 加「這個 block 來自哪
條路徑」的欄位（那是為特殊情況開洞），改成規定**歷史路徑由載入端（Task 11 的
`session-store.ts`）在 `normalizeHistory` 產出的事件尾端補一筆
`{ kind: 'session-end', isError: false }`**，讓歷史對話走與 live 收尾同一條
規則。`fold()` 因此只認三種 complete 來源，不需要知道事件是從哪條路徑來的：

| 來源 | 效果 |
|---|---|
| `block-stop` | 該 block 單獨設 `complete: true` |
| `session-end` | 目前所有 `text`／`thinking` block 一併設 `complete: true`（不論是否曾收到 `block-stop`） |
| `user-text` 建立時 | 直接 `complete: true` |

本 task 的測試同時驗證兩個層面：`fold()` 收到 `session-end` 時確實把 block
設完成（見 Step 1「complete 的來源」），以及 `fold()` 本身不會替歷史路徑
「偷偷」補完成，那是載入端明確補一筆事件才會發生的事，兩者由誰負責在
「history 路徑與 session-end 的分工」測試組裡看得見。

- [ ] **Step 1: 寫失敗的測試**

`tests/fold.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fold, type ConversationView, type Turn, type Block } from '../src/shared/fold.js'
import { normalizeHistory, type Event } from '../src/shared/events.js'
import { liveEvents } from './helpers/live-events.js'

/** 讀一份錄下的事件流。規格 §9：案例來自真實資料而非測試自己造的。 */
function readFixture(name: string): readonly unknown[] {
  return readFileSync(`tests/fixtures/events/${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

function runHistory(msgs: readonly unknown[]): readonly Event[] {
  return msgs.flatMap((m) => [...normalizeHistory(m)])
}

function allBlocks(view: ConversationView): readonly Block[] {
  return view.turns.flatMap((t: Turn) => t.blocks)
}

describe('fixture 守衛', () => {
  it('live 與 history fixture 都讀得到內容（fixture 被誤刪時測試會對空陣列跑然後全過）', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const HISTORY = readFixture('04-session-history')
    expect(LIVE.length).toBeGreaterThanOrEqual(50)
    expect(HISTORY.length).toBeGreaterThanOrEqual(6)
  })
})

describe('去重：同一個 (messageId, index) 的完整快照取代 delta 累積，不是附加', () => {
  it('8 筆 text-delta 疊出 466 字元，完整快照到達後仍是 466 字元而非 932', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    // fixture 第 42-49 行：8 筆 text_delta 疊出 466 字元；第 50 行的完整 text 也是 466 字元
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.markdown).toHaveLength(466)
  })
})

describe('index 重置：不同訊息各自從 0 開始的 block index 不能混在一起', () => {
  it('兩則訊息各自的 index=0 thinking block 各自獨立，不被合併成一個', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const assistantTurns = view.turns.filter((t) => t.role === 'assistant')
    // fixture 第 12 行（msg1 index=0）與第 33 行（msg2 index=0）都是 thinking block-start，
    // 若去重鍵只用 index 會被誤判成同一個 block
    expect(assistantTurns).toHaveLength(2)
    expect(assistantTurns[0]?.messageId).toBe('msg_011CecHvRnPBQEKKkvdkgXkj')
    expect(assistantTurns[1]?.messageId).toBe('msg_011CecHvmWYSkjexndc45ePc')
    const thinkingBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'thinking' }> => b.kind === 'thinking'
    )
    expect(thinkingBlocks).toHaveLength(2)
  })
})

describe('complete 的來源：block-stop 或 session-end（裁決 5、15）', () => {
  it('拿掉最後一個 block-stop（第 51 行）且截掉尾端的 result 訊息（第 52-54 行），text block 仍是 complete:false', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    // 只餵到第 50 行：完整 text 快照已經到，但 block-stop（51）與 result 訊息
    // （52-54，會產出 session-end）都還沒到，兩個 complete 來源都不在場
    const withoutStopAndResult = LIVE.slice(0, 50)
    const view = fold(liveEvents(withoutStopAndResult))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.complete).toBe(false)
  })

  it('只截掉第 51 行的 block-stop、保留尾端的 result 訊息，text block 因 session-end 而 complete:true', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    // 拿掉陣列裡的第 51 行（index 50），52-54 行原樣保留，session-end 仍會發生
    const withoutBlockStopOnly = [...LIVE.slice(0, 50), ...LIVE.slice(51)]
    const view = fold(liveEvents(withoutBlockStopOnly))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.complete).toBe(true)
  })

  it('餵完整事件流（含第 51 行的 block-stop）後 text block 變成 complete:true', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks[0]?.complete).toBe(true)
  })
})

describe('tool_use：只給最小佔位，狀態推進不在本 task 範圍', () => {
  it('live 路徑：block-start 產出佔位後，後續 tool-input-delta／tool-use／tool-result 都不改動它', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    const toolBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool'
    )
    // fixture 第 20 行：msg1 index=1 是 tool_use block-start，name=Bash
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]).toEqual({
      kind: 'tool',
      id: 'toolu_01L2YCZHqTvRDmdkNpsprfCQ',
      name: 'Bash',
      input: undefined,
      status: 'streaming-input',
    })
  })

  it('history 路徑：沒有 block-start，tool-use 快照本身是唯一機會，直接把 id/name/input 填進佔位', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    const toolBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool'
    )
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]?.status).toBe('streaming-input')
    expect(toolBlocks[0]?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(toolBlocks[0]?.name).toBe('Bash')
    expect(toolBlocks[0]?.input).toEqual({
      command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
      description: 'Write hello to cap.txt and verify',
    })
  })
})

describe('history 路徑：assistant 訊息沒有 index，多個 block 依序附加進同一個 turn', () => {
  it('同一個 messageId 的 thinking 與 tool_use 兩個 block 依序附加，不互相取代', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    // fixture 04 第 2、3 行都是 msg_011CecHvRnPBQEKKkvdkgXkj：先 thinking 後 tool_use
    const turn = view.turns.find((t) => t.messageId === 'msg_011CecHvRnPBQEKKkvdkgXkj')
    expect(turn).toBeDefined()
    expect(turn?.blocks.map((b) => b.kind)).toEqual(['thinking', 'tool'])
  })
})

describe('history 路徑與 session-end 的分工（裁決 15：載入端補一筆）', () => {
  // 只看 assistant turn 的 block：user-text 建立時就直接 complete:true（另一條
  // 規則），跟這裡要驗證的「history 的 assistant block 要靠 session-end 才變完成」
  // 是兩回事，混進來會讓斷言失真。
  function assistantCompletable(view: ConversationView) {
    return view.turns
      .filter((t) => t.role === 'assistant')
      .flatMap((t) => t.blocks)
      .filter(
        (b): b is Extract<Block, { kind: 'text' | 'thinking' }> => b.kind === 'text' || b.kind === 'thinking'
      )
  }

  it('fixture 04 本身沒有 session-end，fold(normalizeHistory 產出) 的 assistant text／thinking block 全部 complete:false', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    const completable = assistantCompletable(view)
    // fixture 04：msg1 一個 thinking，msg2 一個 thinking 加一個 text，共 3 個
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === false)).toBe(true)
  })

  it('載入端補一筆 { kind: session-end, isError: false } 後，同一批 assistant block 全部變 complete:true', () => {
    const HISTORY = readFixture('04-session-history')
    const events: readonly Event[] = [...runHistory(HISTORY), { kind: 'session-end', isError: false }]
    const view = fold(events)
    const completable = assistantCompletable(view)
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === true)).toBe(true)
  })
})

describe('不得靜默丟棄：認不出來的事件仍要有可見產出', () => {
  it('fixture 03 全程沒有 unknown Event，fold 之後也沒有 unknown block（裁決 1）', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const events = liveEvents(LIVE)
    // 裁決 1：signature_delta／message_delta／message_stop 認得出來但沒有可渲染內容，
    // Task 3 回空陣列，所以這份 fixture 一個 unknown 都不該有
    expect(events.filter((e) => e.kind === 'unknown')).toHaveLength(0)
    const view = fold(events)
    expect(allBlocks(view).filter((b) => b.kind === 'unknown')).toHaveLength(0)
  })

  it('手工合成的 unknown 事件掛到當下最後一個 turn 上，不憑空消失', () => {
    const raw = { type: 'brand_new_sdk_event', payload: 42 }
    const events: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg-1' },
      { kind: 'text', messageId: 'msg-1', index: 0, text: 'hi' },
      { kind: 'unknown', raw },
    ]
    const view = fold(events)
    const lastTurn = view.turns[view.turns.length - 1]
    expect(lastTurn?.messageId).toBe('msg-1')
    // 只看排列與 unknown block 本身：complete 是另一組規則的事，混進來會讓這條測試
    // 對不相干的改動變紅
    expect(lastTurn?.blocks.map((b) => b.kind)).toEqual(['text', 'unknown'])
    expect(lastTurn?.blocks[1]).toEqual({ kind: 'unknown', raw })
  })
})

describe('user-text：每個事件各自開一個新的 user turn，建立時直接 complete:true（裁決 5、15）', () => {
  it('history fixture 第 1 行的使用者訊息變成一個 role: user 的 turn，complete 不等 block-stop 或 session-end', () => {
    const HISTORY = readFixture('04-session-history')
    const view = fold(runHistory(HISTORY))
    const userTurns = view.turns.filter((t) => t.role === 'user')
    expect(userTurns).toHaveLength(1)
    expect(userTurns[0]?.blocks).toEqual([
      { kind: 'text', markdown: expect.stringContaining('echo hello'), complete: true },
    ])
  })
})

describe('reset：畫面從這裡重新開始（裁決 22）', () => {
  it('reset 之前的事件不出現在結果裡，結果等於只餵 reset 之後的事件', () => {
    const before: readonly Event[] = [
      { kind: 'session-start', sessionId: 'sess-old' },
      { kind: 'message-start', messageId: 'msg-old' },
      { kind: 'text', messageId: 'msg-old', index: 0, text: '上一場的內容' },
      { kind: 'session-end', isError: true, errorMessage: 'boom' },
    ]
    const after: readonly Event[] = [
      { kind: 'session-start', sessionId: 'sess-new' },
      { kind: 'message-start', messageId: 'msg-new' },
      { kind: 'text', messageId: 'msg-new', index: 0, text: '新的一場' },
    ]
    const view = fold([...before, { kind: 'reset' }, ...after])
    expect(view).toEqual(fold(after))
    expect(JSON.stringify(view)).not.toContain('上一場的內容')
    expect(view.sessionId).toBe('sess-new')
    expect(view.ended).toBe(false)
    expect(view.error).toBeUndefined()
  })
})

describe('session 層級欄位', () => {
  it('session-start 設定 sessionId，session-end 設定 ended 與 cost', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    // fixture 第 9 行 session_id，第 54 行 total_cost_usd／num_turns
    expect(view.sessionId).toBe('a727625f-71c3-49c8-8646-2414bede4756')
    expect(view.ended).toBe(true)
    expect(view.cost?.usd).toBeCloseTo(0.3197795)
    expect(view.cost?.turns).toBe(2)
  })

  it('沒有收到 session-end 之前 ended 是 false', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const withoutResult = LIVE.slice(0, 53)
    const view = fold(liveEvents(withoutResult))
    expect(view.ended).toBe(false)
  })

  it('isError 的 session-end 之後 view.error 帶 message 與 apiErrorStatus（裁決 17）', () => {
    const events: readonly Event[] = [
      { kind: 'session-end', isError: true, errorMessage: 'boom', apiErrorStatus: 500 },
    ]
    const view = fold(events)
    expect(view.error).toEqual({ message: 'boom', apiErrorStatus: 500 })
  })

  it('正常 session-end 之後 view.error 是 undefined（裁決 17）', () => {
    const LIVE = readFixture('03-sdk-live-stream')
    const view = fold(liveEvents(LIVE))
    expect(view.ended).toBe(true)
    expect(view.error).toBeUndefined()
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/fold.test.ts`
Expected: FAIL，`fold`、`ConversationView`、`Turn`、`Block` 都無法從 `../src/shared/fold.js`
解析出來（檔案還不存在）。

執行本 task 前提：`src/shared/events.ts` 與 `tests/helpers/live-events.ts`（都是 Task 3
產出）必須已經存在於專案中，否則那兩條 import 本身就會編譯失敗，Step 2 看到的會是
模組找不到而非「fold 還沒實作」，兩者要分辨清楚。

- [ ] **Step 3: 寫最小實作**

`src/shared/fold.ts` 完整內容（前半：型別、去重鍵、turn 與 block 的存放機制）：

```typescript
/**
 * 把 Event 流投影成畫面要的 ConversationView（規格 4.2）。
 *
 * 本檔只處理 text、thinking、unknown 三種 Block。tool_use 相關事件只產出一個
 * status: streaming-input 的最小佔位，狀態推進（running/done/error 等）留給 Task 4B。
 */

import type { Event } from './events.js'

export interface ConversationView {
  readonly sessionId?: string
  readonly turns: readonly Turn[]
  readonly cost?: { readonly usd?: number; readonly turns?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增：session-end 的 isError:true 時由 fold() 設定，isError:false 維持 undefined。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

export interface Turn {
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
  readonly blocks: readonly Block[]
}

export type Block =
  | { readonly kind: 'text'; readonly markdown: string; readonly complete: boolean }
  | { readonly kind: 'thinking'; readonly text: string; readonly complete: boolean }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly inputPartial?: string
      readonly result?: unknown
      readonly raw?: { readonly stdout: string; readonly stderr: string; readonly interrupted: boolean }
      readonly status: 'streaming-input' | 'awaiting-approval' | 'denied' | 'running' | 'done' | 'error'
    }
  | { readonly kind: 'unknown'; readonly raw: unknown }

/*
 * 內部工作模型：turn 的先後順序與身分，跟 turn 裝了哪些 block，分成兩份全域資料，
 * 不是每個 turn 自己揹一份 blocks 陣列。原因是去重規則的核心矛盾就發生在這裡：
 *
 * 規格明講去重鍵必須是 (messageId, index) 的組合，理由是 index 每則訊息各自從 0
 * 開始，只用 index 會把不同訊息的 block 混在一起。若實作把 block 直接放進各自
 * turn 自己的陣列裡（先用 messageId 找到 turn，再用 index 找 turn 內的 block），
 * messageId 這個維度其實已經靠「先找到哪個 turn」悄悄補上了，(messageId, index)
 * 會退化成只剩 index 在做事：那樣的話，去重鍵不管有沒有帶 messageId，結果都一樣，
 * 「把鍵改成只用 index」這種錯誤實作會完全測不出來，因為 turn 的分隔已經先擋掉問題。
 *
 * 所以這裡刻意用一份全域、跨所有 turn 的 records 清單，去重查找不先按 turn 分流，
 * 直接對整份清單比對鍵。這樣鍵要不要帶 messageId 才是唯一防線，錯了會真的讓兩則
 * 訊息的 index=0 撞在一起。turn 的先後順序另外記在 turnOrder，最後再用 turnId
 * 把 records 分組回各自的 turn。
 */

interface TurnMeta {
  readonly turnId: string
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
}

/** key 為 null 表示不可去重（history 路徑的 assistant 訊息沒有 index），一律附加。 */
interface BlockRecord {
  readonly turnId: string
  readonly key: string | null
  readonly block: Block
}

interface WorkingView {
  readonly sessionId?: string
  readonly turnOrder: readonly TurnMeta[]
  readonly records: readonly BlockRecord[]
  readonly cost?: { readonly usd?: number; readonly turns?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增，見 sessionEndError。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

const INITIAL_VIEW: WorkingView = { turnOrder: [], records: [], ended: false }

/**
 * 去重鍵：用 JSON.stringify 把 messageId 與 index 兩個維度編碼成同一個字串，
 * 不必自己挑分隔字元、也不必煩惱 messageId 裡會不會剛好出現那個分隔字元。
 * index 是 undefined 時代表 history 路徑的多 block 訊息（沒有 index 可用），
 * 回傳 null，呼叫端據此改成一律附加而非查表比對。
 */
function blockKey(messageId: string, index: number | undefined): string | null {
  return index === undefined ? null : JSON.stringify([messageId, index])
}

// ---- turn 身分：assistant 用 messageId 本身當 turnId，user 每次生一個新的 ----

function hasAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): boolean {
  return turnOrder.some((t) => t.role === 'assistant' && t.messageId === messageId)
}

/** 確保 messageId 有一個 assistant turn 存在；不存在就在陣列尾端新增。turnId 直接用 messageId。 */
function ensureAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): readonly TurnMeta[] {
  return hasAssistantTurn(turnOrder, messageId)
    ? turnOrder
    : [...turnOrder, { turnId: messageId, role: 'assistant' as const, messageId }]
}

/**
 * 全域去重：查找與寫入都對整份 records 清單直接比對 key，不先按 turnId 分流。
 * 這是讓「鍵要不要帶 messageId」這件事真正有意義的關鍵設計，見檔案開頭的說明。
 *
 * key 為 null（history 路徑，沒有 index）：一律新增一筆 record，不查表，效果
 * 等同附加在該 turn 的尾端（buildTurns 依 records 原始順序分組，天然保序）。
 * key 不為 null：查表命中就整份「取代」原本的 block（不是附加），查不到就新增
 * 並記住這把 key。build 收到既有 block（找不到就是 undefined），由呼叫端決定
 * 要不要延續舊內容（例如 text-delta 要接、完整快照要蓋）。
 */
function placeBlock(
  records: readonly BlockRecord[],
  turnId: string,
  key: string | null,
  build: (existing: Block | undefined) => Block
): readonly BlockRecord[] {
  const existing = key === null ? undefined : records.find((r) => r.key === key)
  if (existing === undefined) return [...records, { turnId, key, block: build(undefined) }]
  return records.map((r) => (r.key === key ? { ...r, block: build(existing.block) } : r))
}

// ---- text／thinking：delta 累加，完整快照取代 ----

function applyTextDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'text' ? existing.markdown : ''
    return { kind: 'text', markdown: prev + text, complete: false }
  })
}

function applyThinkingDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'thinking' ? existing.text : ''
    return { kind: 'thinking', text: prev + text, complete: false }
  })
}

/**
 * 完整快照「取代」delta 累積出來的內容，不是附加：同一份內容用兩種方式送達，
 * 只算一份。key 為 null（history，無 index）時 placeBlock 一律新增，效果等同附加。
 * complete 延續既有值：block-stop 或 session-end 先到或後到都不影響這裡的判斷，
 * 這裡只是不要把已經標記的 complete 蓋回 false（見 applyBlockStop、applySessionEnd）。
 */
function applyTextSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'text' ? existing.complete : false
    return { kind: 'text', markdown: text, complete }
  })
}

function applyThinkingSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'thinking' ? existing.complete : false
    return { kind: 'thinking', text, complete }
  })
}

/**
 * complete 的來源之一（另外兩個是 applySessionEnd 與 user-text 建立時，見裁決
 * 5、15）。這裡只讓「收到 block-stop 的那一個」block 變完成，其餘不動。
 */
function applyBlockStop(records: readonly BlockRecord[], messageId: string, index: number): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing === undefined) {
      // 協定不應該讓 block-stop 搶在任何內容之前抵達；真的發生時不要吃掉這個事件，
      // 留一個看得見的痕跡而不是靜默略過。
      return { kind: 'unknown', raw: { note: 'block-stop 沒有對應的 block', messageId, index } }
    }
    if (existing.kind === 'text' || existing.kind === 'thinking') return { ...existing, complete: true }
    // tool／unknown 沒有 complete 欄位，工具的狀態推進留給 Task 4B，這裡維持原樣。
    return existing
  })
}

/**
 * complete 的另一個來源（裁決 5、15）：session-end 到達時，「其餘所有」
 * text／thinking block 一律變完成，不分是否曾收到各自的 block-stop。這裡回傳
 * 新陣列，每筆需要改的 record 也是新物件，不就地改動舊的。
 *
 * tool block 這裡刻意不動：running -> done 的推進是裁決 15 的另一半，屬於
 * Task 4B 的範圍（它接手 updateToolBlock 之後，會在同一個 case 補上那段）。
 *
 * 歷史路徑不是這裡的特例：載入端（Task 11 的 session-store.ts）在
 * normalizeHistory 產出的事件尾端補一筆 session-end，會自然走到這個函式，
 * fold() 本身不需要知道事件是從哪條路徑來的。
 */
function applySessionEnd(records: readonly BlockRecord[]): readonly BlockRecord[] {
  return records.map((r) => {
    if (r.block.kind !== 'text' && r.block.kind !== 'thinking') return r
    return { ...r, block: { ...r.block, complete: true } }
  })
}

/**
 * session-end 的第四個效果（裁決 17，跟上面的 complete 規則是兩件事）：isError 為 true
 * 時把 errorMessage／apiErrorStatus 收進 view.error，兩個欄位都用條件展開避免寫入
 * undefined 鍵；isError 為 false 時回傳 undefined，讓 error 維持不設。
 */
function sessionEndError(
  event: Extract<Event, { kind: 'session-end' }>
): WorkingView['error'] {
  if (event.isError !== true) return undefined
  return {
    ...(event.errorMessage === undefined ? {} : { message: event.errorMessage }),
    ...(event.apiErrorStatus === undefined ? {} : { apiErrorStatus: event.apiErrorStatus }),
  }
}

```

`src/shared/fold.ts` 後半（tool_use 佔位、user turn、unknown 事件、主 reduce、對外的 `fold`）：

```typescript
// ---- tool_use：只給最小佔位，狀態推進留給 Task 4B ----

function applyBlockStart(
  records: readonly BlockRecord[],
  messageId: string,
  index: number,
  blockType: 'text' | 'thinking' | 'tool_use',
  toolName: string | undefined,
  toolUseId: string | undefined
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, () => {
    if (blockType === 'text') return { kind: 'text', markdown: '', complete: false }
    if (blockType === 'thinking') return { kind: 'thinking', text: '', complete: false }
    return { kind: 'tool', id: toolUseId ?? '', name: toolName ?? '', input: undefined, status: 'streaming-input' }
  })
}

/**
 * live 路徑：block-start 已經放了佔位，這裡忠實維持原狀，不推進狀態（Task 4B 的工作）。
 * history 路徑：tool-use 是該工具呼叫唯一會抵達的事件，沒有 block-start 可以先佔位，
 * 這裡是唯一機會拿到 id、name、input，直接填入，而不是留空等一個永遠不會來的事件。
 * 兩種情況 status 都固定 streaming-input，這裡只是把已知資料塞進最小佔位，不是狀態推進。
 */
function applyToolUseSnapshot(
  records: readonly BlockRecord[],
  messageId: string,
  index: number | undefined,
  id: string,
  name: string,
  input: unknown
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing !== undefined) return existing
    return { kind: 'tool', id, name, input, status: 'streaming-input' }
  })
}

// ---- user turn：每個 user-text 都開一個新 turn，不嘗試合併 ----

/**
 * Event 沒有給 user 訊息任何跨 block 的關聯鍵（不像 assistant 有 messageId），
 * 所以無法判斷連續兩個 user-text 事件是不是同一則原始訊息拆出來的兩個 block。
 * 這裡選擇保守：每個 user-text 都開一個新 turn，寧可把同一則訊息的多個文字
 * block 拆成多個 turn，也不要誤把兩則不相干的使用者訊息合併成一個 turn。
 *
 * complete 直接是 true（裁決 5、15 的第三個來源）：使用者按下送出的那一刻，
 * 這則訊息就已經完成，不需要等任何後續事件。
 */
function applyUserText(view: WorkingView, text: string): WorkingView {
  const turnId = 'user-' + String(view.turnOrder.length)
  const block: Block = { kind: 'text', markdown: text, complete: true }
  return {
    ...view,
    turnOrder: [...view.turnOrder, { turnId, role: 'user' as const }],
    records: [...view.records, { turnId, key: null, block }],
  }
}

/**
 * 沒有任何 turn 可歸屬、又不能靜默丟棄的事件（Task 3 判定「認不出來」而產出的
 * unknown，以及缺 messageId 的完整快照）：掛到目前最後一個 turn 上；連一個 turn
 * 都還沒有就新開一個 assistant turn 來裝它，避免事件憑空消失。
 */
function applyUnknown(view: WorkingView, raw: unknown): WorkingView {
  const block: Block = { kind: 'unknown', raw }
  const last = view.turnOrder[view.turnOrder.length - 1]
  if (last === undefined) {
    const turnId = 'unknown-' + String(view.turnOrder.length)
    return {
      ...view,
      turnOrder: [...view.turnOrder, { turnId, role: 'assistant' as const }],
      records: [...view.records, { turnId, key: null, block }],
    }
  }
  return { ...view, records: [...view.records, { turnId: last.turnId, key: null, block }] }
}

// ---- 主 reduce：一個 Event 對應一次狀態轉換 ----

function applyEvent(view: WorkingView, event: Event): WorkingView {
  switch (event.kind) {
    case 'session-start':
      return { ...view, sessionId: event.sessionId }
    case 'message-start':
      return { ...view, turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId) }
    case 'block-start':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStart(view.records, event.messageId, event.index, event.blockType, event.toolName, event.toolUseId),
      }
    case 'text-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyTextDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'thinking-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyThinkingDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'tool-input-delta':
      // 工具狀態推進留給 Task 4B，這裡刻意不處理，也不丟棄事件本身，它仍在
      // Event 流裡，Task 4B 會讀它，只是這個 fold() 版本選擇忽略它。
      return view
    case 'block-stop':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStop(view.records, event.messageId, event.index),
      }
    case 'text':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyTextSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'thinking':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyThinkingSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'tool-use':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyToolUseSnapshot(view.records, event.messageId, event.index, event.id, event.name, event.input),
          }
    case 'tool-result':
    case 'tool-raw-output':
    case 'permission-denied':
      // 同樣是工具狀態推進的一部分，留給 Task 4B。
      return view
    case 'user-text':
      return applyUserText(view, event.text)
    case 'session-end': {
      // 裁決 17：error 是 session-end 的第四個效果，跟 ended／cost／block complete
      // 三件事並列，用同一次 reduce 更新算完，不另開一次遍歷。
      const error = sessionEndError(event)
      return {
        ...view,
        ended: true,
        cost: {
          ...(event.costUsd === undefined ? {} : { usd: event.costUsd }),
          ...(event.numTurns === undefined ? {} : { turns: event.numTurns }),
        },
        records: applySessionEnd(view.records),
        ...(error === undefined ? {} : { error }),
      }
    }
    // 裁決 22：畫面從這裡重新開始。reset 由 Task 8 的 ipc-bridge 合成，正規化層不產出它。
    // 之前累積的 turn、block、sessionId、cost、error 全部丟掉，回到初始狀態。
    case 'reset':
      return INITIAL_VIEW
    case 'unknown':
      return applyUnknown(view, event.raw)
  }
}

function buildTurns(turnOrder: readonly TurnMeta[], records: readonly BlockRecord[]): readonly Turn[] {
  return turnOrder.map((tm) => ({
    role: tm.role,
    ...(tm.messageId === undefined ? {} : { messageId: tm.messageId }),
    blocks: records.filter((r) => r.turnId === tm.turnId).map((r) => r.block),
  }))
}

/**
 * fold 核心：把整條 Event 流投影成一份 ConversationView 快照。純函式，沒有任何
 * 跨呼叫狀態：呼叫端要拿到最新畫面，就把累積到當下的完整事件陣列整包丟進來重算，
 * 不是餵單一新事件做增量更新（跟 stepLive 的游標模式是兩回事）。
 */
export function fold(events: readonly Event[]): ConversationView {
  const view = events.reduce(applyEvent, INITIAL_VIEW)
  return {
    ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
    turns: buildTurns(view.turnOrder, view.records),
    ...(view.cost === undefined ? {} : { cost: view.cost }),
    ended: view.ended,
    ...(view.error === undefined ? {} : { error: view.error }),
  }
}
```

`src/shared/fold.ts` 完整檔案實測 410 行，在單檔 800 行的上限內（裁決 5、15 版是 381 行；
裁決 17 加了 `error?` 欄位、`sessionEndError` 函式及其註解，以及 `session-end` case
與 `fold()` 回傳值裡的條件展開；裁決 22 再加 `reset` 那個 case 與註解）。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/fold.test.ts`
Expected: PASS，19 個測試（裁決 5、15 加 3 個 complete 測試；裁決 17 加 2 個
「session 層級欄位」的 error 測試；裁決 1 把 unknown 那條拆成 2 條、裁決 22 加 1 條 reset）。

實測（2026-09-02 依裁決 1、2、22 重跑：`git worktree add` 一個暫時工作區，材料化本 task 與
Task 3 的 `events.ts`／`live-events.ts`／`events.test.ts`／`fold.ts`／`fold.test.ts`，
`npx vitest run`）：

```
 RUN  v4.1.11

 Test Files  2 passed (2)
      Tests  65 passed (65)
```

（65 = Task 3 的 `events.test.ts` 46 個 + 本 task `fold.test.ts` 19 個，同一次指令
`npx vitest run tests/events.test.ts tests/fold.test.ts` 跑出。單獨只跑
`fold.test.ts` 是 `Tests  19 passed (19)`。）

Run: `npm run typecheck`
Expected: 無錯誤。實測 `tsc --noEmit` 對兩個檔案都乾淨通過，`noUncheckedIndexedAccess`
底下唯一需要注意的是 `applyUnknown` 裡 `view.turnOrder[view.turnOrder.length - 1]`
這個手動陣列索引，型別是 `TurnMeta | undefined`，程式碼用 `if (last === undefined)`
明確處理，不是靠斷言蓋過去。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

八個突變各跑一次，每一個都必須讓測試變紅。**突變 1、2 是任務指名要驗的**，
突變 3、4、5 對應 complete 規則（裁決 5、15），突變 6 對應裁決 17 的 `error` 欄位，
突變 7 對應裁決 22 的 `reset`，突變 8 對應裁決 1 之後 `applyUnknown` 唯一的防線。
下表的紅燈條數與測試名稱都是 2026-09-02 在暫時 worktree 實跑的結果。

| # | 突變 | 改法 | 實測紅的測試 |
|---|---|---|---|
| 1 | 拿掉去重邏輯 | `placeBlock` 裡 `const existing = key === null ? undefined : records.find(...)` 改成 `const existing = undefined`，強迫每次都當成沒找到 | 6 條（見下方紅燈輸出） |
| 2 | 鍵從 `(messageId, index)` 改成只用 `index` | `blockKey` 的 `JSON.stringify([messageId, index])` 改成 `JSON.stringify([index])` | 「index 重置：兩則訊息各自的 index=0 thinking block 各自獨立」與「tool_use：live 路徑」共 2 條 |
| 3 | `complete` 不等 block-stop／session-end，快照一到就當完成 | `applyTextSnapshot` 的 `complete` 不再延續既有值，直接寫死 `true` | 「complete 的來源」的第一條（拿掉 block-stop 且截掉 result）；連帶命中「history 路徑與 session-end 的分工」的第一條，因為兩者都經過同一個 `applyTextSnapshot`。共 2 條 |
| 4 | `session-end` 不把 block 設 complete | `applyEvent` 的 `session-end` case 拿掉 `records: applySessionEnd(view.records)` 這一行 | 「complete 的來源」的第二條（只截掉 block-stop、保留 result）；「history 路徑與 session-end 的分工」的第二條（補一筆 session-end 後全部變 true）。共 2 條 |
| 5 | `user-text` 建立為 `complete:false` | `applyUserText` 的 `block` 字面量改回 `complete: false` | 「user-text：…建立時直接 complete:true」1 條 |
| 6 | `sessionEndError` 不判斷 `isError`，無論如何都回傳 error 物件 | `sessionEndError` 的 `if (event.isError !== true) return undefined` 拿掉，直接組 error 物件回傳 | 「正常 session-end 之後 view.error 是 undefined（裁決 17）」1 條 |
| 7 | `reset` 不清空 | `case 'reset'` 從 `return INITIAL_VIEW` 改成 `return view` | 「reset 之前的事件不出現在結果裡」1 條 |
| 8 | `unknown` 事件靜默丟棄 | `case 'unknown'` 從 `return applyUnknown(view, event.raw)` 改成 `return view` | 「手工合成的 unknown 事件掛到當下最後一個 turn 上」1 條 |

**突變 1 的實測輸出**（`placeBlock` 的 `existing` 強制設成 `undefined`）：

```
 FAIL  tests/fold.test.ts > 去重：同一個 (messageId, index) 的完整快照取代 delta 累積，不是附加
 > 8 筆 text-delta 疊出 466 字元，完整快照到達後仍是 466 字元而非 932
AssertionError: expected [ { kind: 'text', …(2) }, …(9) ] to have a length of 1 but got 10
 Tests  6 failed | 13 passed (19)
```

去重拿掉後，8 筆 delta 加 1 筆完整快照各自變成獨立 block，`textBlocks` 從 1 筆暴增
成 10 筆，目標測試變紅。同一個機制也讓 thinking-delta 的累加被打斷，msg1 那個
thinking block 從 1 筆暴增成多筆，連帶讓「index 重置」那條（斷言 `thinkingBlocks`
長度為 2）一起紅；另外還波及「complete 的來源」前兩條、「tool_use」的 live 路徑
那條，以及「fixture 03 全程沒有 unknown block」那條（`applyBlockStop` 查不到既有
block，四個 `block-stop` 各生一個 unknown block），共 6 個測試。這些測試都間接依賴
「同一個 block 只會有一筆紀錄」這個前提，去重一壞，連帶炸出的範圍比原本設想的更廣，
不是只有直接斷言去重行為的那一條。還原後重跑：`Tests  19 passed (19)`。

**突變 2 的實測輸出**（`blockKey` 只用 `JSON.stringify([index])`）：

```
 FAIL  tests/fold.test.ts > index 重置：不同訊息各自從 0 開始的 block index 不能混在一起
 > 兩則訊息各自的 index=0 thinking block 各自獨立，不被合併成一個
AssertionError: expected [ Array(1) ] to have a length of 2 but got 1
 FAIL  tests/fold.test.ts > tool_use：只給最小佔位，狀態推進不在本 task 範圍
 > live 路徑：block-start 產出佔位後，後續 tool-input-delta／tool-use／tool-result 都不改動它
AssertionError: expected [] to have a length of 1 but got +0
 Tests  2 failed | 17 passed (19)
```

msg1 與 msg2 的 index=0（都是 thinking block-start）鍵撞在一起：msg2 的
thinking block-start 找到 msg1 那筆舊 record（鍵同樣是 `[0]`），就地把內容換成
自己的，但 `turnId` 欄位沒有跟著換，那筆 record 仍然掛在 msg1 底下，`buildTurns`
用 `turnId` 分組時，msg2 的 turn 就少了這個 block，`thinkingBlocks` 從 2 筆掉到
只剩 1 筆（msg1、msg2 的 thinking 內容疊成同一筆，最後寫入的贏）。

同樣的碰撞也發生在 index=1：msg1 的 tool_use block-start 先佔用鍵 `[1]`，msg2 的
text block-start 後到，一樣「就地取代」那筆 record 的內容，把它從 tool 佔位換成
完整的 text block（466 字元、complete:true），`turnId` 一樣沒換。msg1 原本應該
有的那個 tool 佔位因此被整個蓋掉、憑空消失，`toolBlocks` 從 1 筆掉到 0 筆，對應
上面第二條紅燈輸出的 `expected [] to have a length of 1 but got +0`。
還原後重跑：`Tests  19 passed (19)`。

這組突變值得記一筆：**第一版實作（block 直接放進各自 turn 的陣列裡）完全測不出
這個突變**：測試全綠，因為 turn 的分隔本身已經用 messageId 分流過一次，鍵裡
帶不帶 messageId 不影響結果。改成全域 `records` 清單、查找不先按 turn 分流之後，
突變才會真正命中。這是撰寫本 task 時實際踩到、改掉的坑，不是紙上假設。

**突變 3 的實測輸出**（`applyTextSnapshot` 的 `complete` 寫死 `true`）：

```
 FAIL  tests/fold.test.ts > complete 的來源：block-stop 或 session-end（裁決 5、15）
 > 拿掉最後一個 block-stop（第 51 行）且截掉尾端的 result 訊息（第 52-54 行），text block 仍是 complete:false
AssertionError: expected true to be false // Object.is equality
 FAIL  tests/fold.test.ts > history 路徑與 session-end 的分工（裁決 15：載入端補一筆）
 > fixture 04 本身沒有 session-end，fold(normalizeHistory 產出) 的 assistant text／thinking block 全部 complete:false
AssertionError: expected false to be true // Object.is equality
 Tests  2 failed | 17 passed (19)
```

`applyTextSnapshot` 是 live 與 history 兩條路徑共用的函式（live 的完整 text 快照、
history 的 assistant 訊息都走它），寫死 `complete: true` 因此同時命中兩條測試：
live 那條「沒收到 block-stop 也沒收到 session-end 就該是 false」，以及 history 那條
「沒補 session-end 之前 assistant block 該是 false」。兩者都是同一個函式的同一顆
bug 造成，不是各自獨立的巧合。還原後重跑：`Tests  19 passed (19)`。

**突變 4 的實測輸出**（`applyEvent` 的 `session-end` case 拿掉
`records: applySessionEnd(view.records)`）：

```
 FAIL  tests/fold.test.ts > complete 的來源：block-stop 或 session-end（裁決 5、15）
 > 只截掉第 51 行的 block-stop、保留尾端的 result 訊息，text block 因 session-end 而 complete:true
AssertionError: expected false to be true // Object.is equality
 FAIL  tests/fold.test.ts > history 路徑與 session-end 的分工（裁決 15：載入端補一筆）
 > 載入端補一筆 { kind: session-end, isError: false } 後，同一批 assistant block 全部變 complete:true
AssertionError: expected false to be true // Object.is equality
 Tests  2 failed | 17 passed (19)
```

精準命中兩條測試：live 路徑靠 session-end 補完成的那條，以及 history 路徑靠載入端
補一筆 session-end 才變完成的那條。這兩條正是裁決 15「session-end 是唯一收尾訊號，
歷史路徑靠補一筆吃到同一條規則」這件事在測試裡的具體體現，拿掉 `applySessionEnd`
的呼叫，兩條防線一起消失。還原後重跑：`Tests  19 passed (19)`。

**突變 5 的實測輸出**（`applyUserText` 的 `block` 字面量改回
`complete: false`）：

```
 FAIL  tests/fold.test.ts > user-text：每個事件各自開一個新的 user turn，建立時直接 complete:true（裁決 5、15）
 > history fixture 第 1 行的使用者訊息變成一個 role: user 的 turn，complete 不等 block-stop 或 session-end
AssertionError: expected [ { kind: 'text', …(2) } ] to deeply equal [ { kind: 'text', …(2) } ]
 Tests  1 failed | 18 passed (19)
```

只有目標測試變紅，其餘 18 個不受影響，包含「history 路徑與 session-end 的分工」
那兩條：它們刻意只看 assistant turn 的 block（見 Step 1 的 `assistantCompletable`
輔助函式），不會被 user-text 的行為干擾，兩件事的測試範圍互不干擾。還原後重跑：
`Tests  19 passed (19)`。

**突變 6 的實測輸出**（裁決 17。`sessionEndError` 拿掉
`if (event.isError !== true) return undefined` 這行，無論 isError 為何都組 error 物件）：

```
 FAIL  tests/fold.test.ts > session 層級欄位 > 正常 session-end 之後 view.error 是 undefined（裁決 17）
AssertionError: expected {} to be undefined
 Tests  1 failed | 18 passed (19)
```

只有目標測試變紅：live fixture 完整跑完後 `isError` 是 `false`（Task 3「result 產出
session-end，帶成本與輪數」那條驗過的同一份 fixture），拿掉判斷後 `sessionEndError`
不分 isError 一律回傳（可能是空的）error 物件，`view.error` 從 `undefined` 變成 `{}`，
斷言 `toBeUndefined()` 落空。其餘 16 條不受影響，包含「isError 的 session-end 之後
view.error 帶 message 與 apiErrorStatus」那條：它驗證的是 error 物件的內容正確，這個
突變沒有改內容組裝邏輯，只是多了不該有的空物件，兩條測試踩的是同一個函式的不同面向。
還原後重跑：`Tests  19 passed (19)`。

**突變 7 的實測輸出**（裁決 22。`case 'reset'` 改成 `return view`）：

```
 FAIL  tests/fold.test.ts > reset：畫面從這裡重新開始（裁決 22） > reset 之前的事件不出現在結果裡，結果等於只餵 reset 之後的事件
AssertionError: expected { sessionId: 'sess-new', …(4) } to deeply equal { sessionId: 'sess-new', …(2) }
 Tests  1 failed | 18 passed (19)
```

**突變 8 的實測輸出**（`case 'unknown'` 改成 `return view`）：

```
 FAIL  tests/fold.test.ts > 不得靜默丟棄：認不出來的事件仍要有可見產出 > 手工合成的 unknown 事件掛到當下最後一個 turn 上，不憑空消失
AssertionError: expected [ 'text' ] to deeply equal [ 'text', 'unknown' ]
 Tests  1 failed | 18 passed (19)
```

裁決 1 之後 fixture 03 一個 unknown 都不產出，靠 fixture 已經測不到 `applyUnknown`，
這條合成測試是它唯一的防線。

八次突變後都確認測試變紅、還原後確認 19 個測試全綠，且每次還原都重新跑過
`tsc --noEmit` 確認無殘留的型別錯誤（2026-09-02 於暫時 worktree 實測，過程見上方
Step 4 的實測區塊）。

- [ ] **Step 6: 確認 coverage 已涵蓋 fold.ts**

`vitest.config.ts` 不必改：Task 1 已把 `'src/shared/**/*.ts'` 放進 `coverage.include`，
`src/shared/fold.ts` 與 Task 3 的 `src/shared/events.ts` 都被這個 glob 涵蓋（裁決 19：
每個 task 只增刪自己的檔案，不重寫整份清單）。

Run: `npx vitest run --coverage tests/fold.test.ts`
Expected: 覆蓋率報表出現 `src/shared/fold.ts` 一列，行覆蓋率 ≥ 80%。
實測（2026-09-02 於暫時 worktree，同時跑 `events.test.ts` 與 `fold.test.ts`）：
`fold.ts` 行覆蓋 95.83%、`events.ts` 97.67%。

- [ ] **Step 7: 執行完整測試套件**

Run: `npm test`
Expected: PASS。本文件撰寫當下（2026-09-02），專案既有測試共 59 個（`spawn-args`
11、`layout` 6、`ipc` 14、`cdp` 10、`measure-memory` 18，實際跑過 `npm test` 確認），
這是 Task 3／6／7 都還沒套用到專案時的基準數字。

執行本 task 時，Task 3（`events.ts` 與 `events.test.ts`）必須已經先套用，因為
`fold.ts` 直接 import 它的 `Event` 型別；Task 6、7 不是 `fold.ts` 的依賴，順序上
不影響本 task。實際總數 = 執行當下的既有總數 + 19（本 task 新增的 `fold.test.ts`，
先依裁決 5、15 從 12 條增為 15 條，依裁決 17 增為 17 條，再依裁決 1、22 增為 19 條）。
把當下實際跑出的數字記進報告，不要照抄本文件的 59 這個基準值，它只在 Task 3／6／7
都還沒套用的情況下成立。2026-09-02 的驗證 worktree 是從 `feat/a-sdk-host` 的 HEAD 開的
（Task 0、1、2 都還沒套用，所以既有測試仍是那 5 個檔 59 條），加上 Task 3 的 46 條與
本 task 的 19 條，`npm test` 是 `Test Files 7 passed`、`Tests 124 passed`。Task 0 刪
`spawn-args.test.ts`、Task 1 加 `session-args.test.ts` 之後這個基準會變，以當下實跑為準。

- [ ] **Step 8: 提交**

```bash
git add src/shared/fold.ts tests/fold.test.ts
git commit -m "feat: fold 核心，text/thinking 去重與 index 重置，complete 依裁決 5/15 三源決定，view.error 依裁決 17、reset 依裁決 22，tool_use 留最小佔位給 Task 4B"
```
