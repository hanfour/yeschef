### Task 4B: fold 的工具區塊狀態機

**2026-09-02 依裁決 1、2、17、22 修訂**：本 task 給的 `fold.ts` 與 `fold.test.ts` 都是**完整
檔案**，取代 Task 4 的版本，兩份都以 Task 4 的最終版為底重做，實跑驗過：

- 裁決 17：Task 4 最終版的 `sessionEndError()`、`ConversationView.error` 與兩條 error 測試
  全部保留。上一版本 task 的 `session-end` case 片段是在裁決 17 之前寫的，照著貼會把這個功能刪掉。
- 裁決 22：`case 'reset': return INITIAL_VIEW` 與對應測試保留。
- 裁決 2：測試改用 `tests/helpers/live-events.ts` 的 `liveEvents()`，不再有 `runLive`／
  `resetLiveNormalizer`／`beforeEach`。
- 裁決 1：fixture 03 不再產出 6 個 `unknown`，「不得靜默丟棄」那組改成 Task 4 最終版的兩條。
- 測試數從 28 改成 35（Task 4 的 19 條裡 17 條照留、2 條 `tool_use` 最小佔位斷言被本 task 的
  狀態轉移測試取代，加上本 task 的 18 條）。突變清單合併成 13 條。

Task 4 把 `tool_use` 相關事件縮到只剩一個 `status: 'streaming-input'` 的最小佔位，
狀態怎麼從那裡推進到 `running`／`done`／`error`／`denied`，留給這個 task。本 task
擴充同一個 `src/shared/fold.ts`，讓 `Block` 的 `tool` 變體吃滿 CONTRACT.md 定義的
六個狀態，不新增檔案。型別契約只多一個欄位：`Block` 的 `tool` 變體新增
`deniedReason?: string`（2026-09-02 裁決 12），其餘型別不變。

**設計判斷：`awaiting-approval` 由 Task 9 的 UI 層管理，`fold()` 不產生這個狀態**

結論先講：`fold()` 永遠不會把任何 tool block 標成 `awaiting-approval`。這個狀態的
存在與退出完全交給 Task 9。理由：

1. CONTRACT.md 的 `Event` 聯集裡沒有任何一種事件代表「正在等待批准」。批准走的是
   `canUseTool` 回呼加上 IPC 的 `approvalAsk`／`approvalReply`（CONTRACT.md 的 IPC
   一節），跟 SDK 訊息流是兩條完全分開的管線：`fold()` 只吃 `Event[]`，這條管線
   上的東西它天生看不到。
2. `fold()` 的契約明講是「純函式，沒有任何跨呼叫狀態」。核准中的 `requestId` 活在
   Task 6 的 `ApprovalRegistry` 裡，不在事件流裡，`fold()` 沒有管道拿到。
3. 就算想用「input 已知、還沒有 tool-result／permission-denied」這段沉默去猜測
   「正在等批准」，這個猜測不可靠：同一段沉默也會發生在「工具已經在跑，只是還沒
   回來」（例如一個慢的 Bash 指令）。這兩種情況從 `fold()` 的視角是同一個訊號，
   差別只在於當下的權限模式要不要問人，而這個資訊 `fold()` 沒有。
4. 所以 tool-use 完整快照到達時，`fold()` 誠實地推進到它唯一能確定的下一步：
   `running`。Task 10 疊加 UI 層的批准提示（裁決 28：以 `block.id === ask.toolUseId`
   找到對應的 tool block，由 `applyPendingApprovals` 疊加 `status: 'awaiting-approval'`），
   在畫面上蓋一層「等待批准」的視覺，不動 `fold()` 本身的狀態。

**裁決 28 定案**：`approvalAsk` 的 payload 是 `{ requestId, toolUseId, toolName, input,
title?, displayName? }`。本 task 原本記錄的疑慮（同一個工具短時間內發出兩次幾乎一樣的
呼叫時對不準確切的 `id`）先由裁決 11 以內容比對回應，2026-09-02 重查 `sdk.d.ts` 發現
`CanUseTool` 的 options 本來就有必填的 `toolUseID`，裁決 28 改成直接帶 `toolUseId`，
內容比對作廢。細節見文件末尾「契約疑慮」第 1 項。

**Files:**
- Modify: `src/shared/fold.ts`（Step 3 給完整檔案，取代 Task 4 的版本。差別是：新增六個
  函式、改寫 `applyToolUseSnapshot`、`Block` 的 `tool` 變體加 `deniedReason?: string`
  （裁決 12）、`applyEvent` 的 `session-end` case 疊加 `applyToolsSessionEnd`（裁決 15）。
  `ConversationView`／`Turn`／`sessionEndError`／`reset` case 一字不動）
- Modify: `tests/fold.test.ts`（Step 1 給完整檔案，取代 Task 4 的版本，35 個測試。
  Task 4 的 19 條裡 17 條照留，2 條 `tool_use` 最小佔位斷言被本 task 的狀態轉移測試取代，
  理由見下一節）

**Interfaces:**
- Consumes: Task 3 的 `Event`（特別是 `tool-input-delta`／`tool-use`／`tool-result`／
  `tool-raw-output`／`permission-denied`／`session-end` 這六種）與 `tests/helpers/live-events.ts`
  的 `liveEvents()`、Task 4 內部的 `WorkingView`／`BlockRecord`／`placeBlock`／
  `applyUnknown`／`applySessionEnd`（不匯出，本 task 直接複用；`applySessionEnd` 是
  Task 4 因裁決 5、15 新增的函式，只碰 `text`／`thinking` block，本 task 的
  `applyToolsSessionEnd` 只碰 `tool` block，兩者在同一個 `session-end` case 疊加呼叫）
- Produces：對外簽名不變，仍是 `function fold(events: readonly Event[]): ConversationView`。
  差別在回傳的 `Block`（`kind: 'tool'`）現在會真的推進 `status`、填 `result`／`raw`；
  `status: 'denied'` 時額外填 `deniedReason`（裁決 12，`result` 維持 `undefined`）；
  `session-end` 到達時，所有 `running`／`streaming-input` 的 tool block 收尾成
  `done`，`result` 維持 `undefined`（裁決 15）。

**與 Task 4 的相容性：只有兩條既有斷言被取代，其餘 17 條照留**

Task 4 的「tool_use：只給最小佔位」那組測試，斷言 live 與 history 兩條路徑跑完
整份 fixture 後 `status` 都停在 `streaming-input`。這在 Task 4 的範圍內是對的（它
刻意不處理 `tool-use`／`tool-result`），但本 task 一旦接手狀態推進，兩份 fixture
（`03-sdk-live-stream.jsonl`、`04-session-history.jsonl`）都在那顆 Bash 工具呼叫
之後接了一個 `is_error:false` 的 `tool_result`，所以完整跑完後，正確答案是
`status: 'done'`，不會再是 `streaming-input`。這不是我選擇要改，是事實：fixture
本來就録到了完整的工具生命週期，Task 4 只是還沒有程式碼去讀那段尾巴。

實測驗證（見 Step 4／5，已在 worktree 跑過）：兩條路徑跑完 `status` 確實都是
`'done'`，`id`／`name`／`input` 不變。下面 Step 1 的測試檔案把這兩條換成本 task 的
狀態轉移測試（live 六條、history 三條）。

Task 4 其餘 17 條測試逐字保留，包含裁決 5、15 的 complete 三源、裁決 17 的兩條
`view.error`、裁決 22 的 `reset`，以及裁決 1 之後改寫的兩條 unknown。本 task 對
`session-end` 的測試（tool block 收尾那一半）與 Task 4 的（text／thinking 那一半）
是互補的，兩組同時在檔案裡。

- [ ] **Step 1: 寫失敗的測試**

`tests/fold.test.ts`（完整檔案，取代 Task 4 的版本；第一段：fixture／輔助函式，以及
Task 4 逐字保留的前四組測試）：

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

function toolBlocksOf(view: ConversationView) {
  return allBlocks(view).filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool')
}

const LIVE = readFixture('03-sdk-live-stream')
const HISTORY = readFixture('04-session-history')
const DENIED = readFixture('02-permission-denied')

describe('fixture 守衛', () => {
  it('三份 fixture 都讀得到內容（fixture 被誤刪時測試會對空陣列跑然後全過）', () => {
    expect(LIVE.length).toBeGreaterThanOrEqual(50)
    expect(HISTORY.length).toBeGreaterThanOrEqual(6)
    expect(DENIED.length).toBeGreaterThanOrEqual(20)
  })
})

describe('去重：同一個 (messageId, index) 的完整快照取代 delta 累積，不是附加', () => {
  it('8 筆 text-delta 疊出 466 字元，完整快照到達後仍是 466 字元而非 932', () => {
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
    // 只餵到第 50 行：完整 text 快照已經到，但 block-stop（51）與 result 訊息
    // （52-54，會產出 session-end）都還沒到，兩個 complete 來源都不在場
    const view = fold(liveEvents(LIVE.slice(0, 50)))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks).toHaveLength(1)
    expect(textBlocks[0]?.complete).toBe(false)
  })

  it('只截掉第 51 行的 block-stop、保留尾端的 result 訊息，text block 因 session-end 而 complete:true', () => {
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
    const view = fold(liveEvents(LIVE))
    const textBlocks = allBlocks(view).filter(
      (b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text'
    )
    expect(textBlocks[0]?.complete).toBe(true)
  })
})

```

以下六段對應六個狀態的轉移，全部用真實 fixture 03 的 Bash 工具呼叫（第 20-30 行：
`block-start`→4 筆 `tool-input-delta`→完整快照→`block-stop`→`tool-result`＋
`tool-raw-output`）分段餵入，用 `.slice(0, N)` 卡住餵到哪一行：

```typescript
describe('Bash 工具生命週期（真實 fixture 03，line 20-30）', () => {
  it('block-start 後：streaming-input，input 未知', () => {
    const view = fold(liveEvents(LIVE.slice(0, 20)))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual({
      kind: 'tool',
      id: 'toolu_01L2YCZHqTvRDmdkNpsprfCQ',
      name: 'Bash',
      input: undefined,
      status: 'streaming-input',
    })
  })

  it('4 筆 tool-input-delta 累積進 inputPartial，狀態仍是 streaming-input', () => {
    const view = fold(liveEvents(LIVE.slice(0, 24)))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('streaming-input')
    expect(tools[0]?.input).toBeUndefined()
    expect(tools[0]?.inputPartial).toBe(
      '{"command": "echo hello > cap.txt && ls -l cap.txt && cat cap.txt", "description": "Write hello to cap.txt and verify"}'
    )
  })

  it('完整快照到達：input 有值，狀態推進到 running', () => {
    const view = fold(liveEvents(LIVE.slice(0, 25)))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('running')
    expect(tools[0]?.input).toEqual({
      command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
      description: 'Write hello to cap.txt and verify',
    })
  })

  it('block-stop（第 26 行）不改動 tool block（tool 沒有 complete 欄位）', () => {
    const view = fold(liveEvents(LIVE.slice(0, 26)))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('running')
  })

  it('tool-result(isError:false) 與 tool-raw-output（第 30 行同一則訊息）到達：done，raw 與 result 都填入', () => {
    const view = fold(liveEvents(LIVE.slice(0, 30)))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBe('-rw-r--r--@ 1 me  wheel  6  9月  1 15:03 cap.txt\nhello')
    expect(tools[0]?.raw).toEqual({
      stdout: '-rw-r--r--@ 1 me  wheel  6  9月  1 15:03 cap.txt\nhello',
      stderr: '',
      interrupted: false,
    })
  })

  it('完整跑完整份 fixture：狀態最終停在 done（取代 Task 4 原本「停在 streaming-input」的斷言）', () => {
    const view = fold(liveEvents(LIVE))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
  })
})

```

裁決 15 的另一半（Task 4 只收尾 `text`／`thinking`，`tool` block 收尾是本 task 的
範圍，見 Step 3）：`session-end` 到達時，`running`／`streaming-input` 的 tool
block 一律收尾成 `done`，`result` 維持 `undefined`；`denied`／`done`／`error`
已經是終態，不受影響。前兩條各自截斷真實 fixture 03 到「running 但 tool-result
還沒到」（第 29 行）與「streaming-input，快照都還沒到」（第 24 行）的那一刻，
補一筆合成的 `session-end` 事件（跟 Task 11 的 `session-store.ts` 幫歷史對話補
`session-end` 是同一種手法，見裁決 15）：

```typescript
describe('session-end：running／streaming-input 的 tool block 收尾（裁決 15）', () => {
  it('running 的 tool block 在 session-end 之後變成 done，result 維持 undefined', () => {
    // 第 20-29 行：tool-use 完整快照已到（running，見上一組第 25 行），tool-result
    // 還沒到（第 30 行）。query 在這一刻結束，running 不會再等到結果。
    const events = [...liveEvents(LIVE.slice(0, 29)), { kind: 'session-end' as const, isError: false }]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBeUndefined()
  })

  it('streaming-input 的 tool block 在 session-end 之後也變成 done（快照沒到就代表串流被中斷）', () => {
    const events = [...liveEvents(LIVE.slice(0, 24)), { kind: 'session-end' as const, isError: false }]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBeUndefined()
  })

  it('denied 是終態，session-end 不覆蓋', () => {
    const events = [...liveEvents(DENIED), { kind: 'session-end' as const, isError: false }]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('denied')
  })

  it('done／error 已經是終態，session-end 不覆蓋', () => {
    const errorEvents: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg-err' },
      { kind: 'block-start', messageId: 'msg-err', index: 1, blockType: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_ERR' },
      { kind: 'tool-use', messageId: 'msg-err', index: 1, id: 'toolu_ERR', name: 'Bash', input: { command: 'false' } },
      { kind: 'tool-result', id: 'toolu_ERR', content: 'command exited 1', isError: true },
      { kind: 'session-end', isError: false },
    ]
    expect(toolBlocksOf(fold(errorEvents))[0]?.status).toBe('error')

    const doneEvents = [...liveEvents(LIVE.slice(0, 30)), { kind: 'session-end' as const, isError: false }]
    expect(toolBlocksOf(fold(doneEvents))[0]?.status).toBe('done')
  })
})

```

`permission-denied` 的兩個要求分開驗證：狀態轉移本身（用真實 fixture 02，它剛好
也證明了「denied 是終態」這件事），以及「多個工具呼叫同時存在時不能標錯」（真實
fixture 沒有兩個工具同時掛著的情境，這裡手工建構 `Event[]`（`fold()` 本來就吃
`Event[]`，不必經過 `stepLive`，這樣構造不算脫離「測 fold()」的範圍）：

```typescript
describe('permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉', () => {
  it('permission_denied 先到 → denied（deniedReason 有值，result 維持 undefined）；隨後 isError:true 的 tool-result 到達 → 仍是 denied 不是 error', () => {
    const view = fold(liveEvents(DENIED))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.id).toBe('toolu_015NDSGktRsH8rWhzAALV3vY')
    expect(tools[0]?.status).toBe('denied')
    // 裁決 12：拒絕理由填 deniedReason，不再塞進 result（result 的語意是工具的
    // 執行結果，denied 的工具根本沒有執行）
    expect(tools[0]?.deniedReason).toEqual(expect.stringContaining('was blocked'))
    expect(tools[0]?.result).toBeUndefined()
    // tool_use_result 是字串形式（裁決 3），raw 仍然要填，跟 status／deniedReason 是不同維度
    expect(tools[0]?.raw).toEqual({
      stdout: expect.stringContaining('was blocked'),
      stderr: '',
      interrupted: false,
    })
  })

  it('沒有前置 block-start（fixture 02 全程沒有 stream_event）時，tool-use 快照本身直接新建 running', () => {
    const view = fold(liveEvents(DENIED.slice(0, 15))) // 只到 tool_use 快照，permission_denied 第 16 行還沒到
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status).toBe('running')
    expect(tools[0]?.input).toEqual({
      command: 'rm -f nonexistent-probe.txt',
      description: 'Remove nonexistent-probe.txt if present',
    })
  })
})

describe('permission-denied 精準對應到正確 block（合成資料）', () => {
  const twoToolEvents: readonly Event[] = [
    { kind: 'message-start', messageId: 'msg-multi' },
    { kind: 'block-start', messageId: 'msg-multi', index: 1, blockType: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_AAA' },
    { kind: 'tool-use', messageId: 'msg-multi', index: 1, id: 'toolu_AAA', name: 'Bash', input: { command: 'rm -rf /' } },
    { kind: 'block-start', messageId: 'msg-multi', index: 3, blockType: 'tool_use', toolName: 'Read', toolUseId: 'toolu_BBB' },
    { kind: 'tool-use', messageId: 'msg-multi', index: 3, id: 'toolu_BBB', name: 'Read', input: { file_path: '/etc/hosts' } },
    { kind: 'permission-denied', toolName: 'Read', toolUseId: 'toolu_BBB', message: '危險指令被擋下' },
  ]

  it('只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響', () => {
    // 刻意讓被拒絕的是「後加入 records 的那一個」：如果查找邏輯退化成「抓第一個
    // tool block」而不是真的比對 id，這條測試才會被準確命中，見 Step 5 突變 2，
    // 這不是隨手安排，是驗算過的（先前一版把 denied 目標放在第一個工具上，突變
    // 2 完全測不出來，findIndex 天生回傳第一個符合的元素，撞上了）。
    const view = fold(twoToolEvents)
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(2)
    const aaa = tools.find((t) => t.id === 'toolu_AAA')
    const bbb = tools.find((t) => t.id === 'toolu_BBB')
    expect(bbb?.status).toBe('denied')
    expect(bbb?.deniedReason).toBe('危險指令被擋下')
    expect(bbb?.result).toBeUndefined()
    expect(aaa?.status).toBe('running')
    expect(aaa?.result).toBeUndefined()
  })
})

describe('tool-result(isError:true) 且從未被 denied：純粹的執行失敗（合成資料，理由：現有 fixture 唯一的 isError:true 案例是 fixture 02 的拒絕情境，無法單獨驗證「失敗」不牽動「拒絕」的邏輯）', () => {
  it('status 變成 error，不是 denied', () => {
    const events: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg-err' },
      { kind: 'block-start', messageId: 'msg-err', index: 1, blockType: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_ERR' },
      { kind: 'tool-use', messageId: 'msg-err', index: 1, id: 'toolu_ERR', name: 'Bash', input: { command: 'false' } },
      { kind: 'tool-result', id: 'toolu_ERR', content: 'command exited 1', isError: true },
    ]
    const view = fold(events)
    const tools = toolBlocksOf(view)
    expect(tools[0]?.status).toBe('error')
    expect(tools[0]?.result).toBe('command exited 1')
  })
})

describe('孤兒事件不靜默丟棄：tool-result／tool-raw-output／permission-denied 找不到對應 block', () => {
  it('tool-result 指名一個不存在的 id 時，產出可見的 unknown block 而不是被吞掉', () => {
    const events: readonly Event[] = [
      { kind: 'user-text', text: '隨便說點什麼開一個 turn' },
      { kind: 'tool-result', id: 'toolu_NOWHERE', content: 'x', isError: false },
    ]
    const view = fold(events)
    const unknowns = allBlocks(view).filter((b) => b.kind === 'unknown')
    expect(unknowns).toHaveLength(1)
    expect(toolBlocksOf(view)).toHaveLength(0)
  })
})

```

歷史路徑：更正 Task 4 的斷言，並補上裁決 4 要求的「無原始輸出」測試：

```typescript
describe('history 路徑（fixture 04）：tool block 的 status 與 raw', () => {
  it('id/name/input 不變；status 因為第 4 行有 tool_result 而推進到 done，不再停在 streaming-input', () => {
    const view = fold(runHistory(HISTORY))
    const tools = toolBlocksOf(view)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.id).toBe('toolu_01L2YCZHqTvRDmdkNpsprfCQ')
    expect(tools[0]?.name).toBe('Bash')
    expect(tools[0]?.input).toEqual({
      command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
      description: 'Write hello to cap.txt and verify',
    })
    expect(tools[0]?.status).toBe('done')
    expect(tools[0]?.result).toBe('-rw-r--r--@ 1 me  wheel  6  9月  1 15:03 cap.txt\nhello')
  })

  it('裁決 4：history 沒有 tool-raw-output，raw 必須是 undefined（明確的「無」），不是空字串組成的物件', () => {
    const view = fold(runHistory(HISTORY))
    const tools = toolBlocksOf(view)
    expect(tools[0]?.raw).toBeUndefined()
    // 反例對照：live 路徑同一顆工具的 raw 是有內容的物件，兩者不該長得一樣，
    // UI（Task 11）要能靠 raw === undefined 分辨「歷史對話沒存」跟「工具沒輸出」
    const liveView = fold(liveEvents(LIVE))
    expect(toolBlocksOf(liveView)[0]?.raw).not.toBeUndefined()
  })

  it('裁決 13／15 的分工：拿掉 tool_result（第 4 行）後 fold(history) 停在 running；載入端補一筆 session-end 才變成 done', () => {
    // HISTORY[3]（0-based）就是第 4 行的 tool_result 訊息（實測 fixture 04 確認：
    // 第 1 行 user、第 2 行 thinking、第 3 行 tool_use、第 4 行 tool_result）
    const withoutToolResult = HISTORY.filter((_, i) => i !== 3)
    const events = runHistory(withoutToolResult)

    const runningView = fold(events)
    const runningTools = toolBlocksOf(runningView)
    expect(runningTools).toHaveLength(1)
    expect(runningTools[0]?.status).toBe('running')

    // Task 11 的 session-store.ts 在載入歷史時於事件尾端補這一筆（裁決 15）
    const endedView = fold([...events, { kind: 'session-end', isError: false }])
    const endedTools = toolBlocksOf(endedView)
    expect(endedTools[0]?.status).toBe('done')
    expect(endedTools[0]?.result).toBeUndefined()
  })
})

```

最後一段是 Task 4 剩下的測試，逐字保留（前四組已經放在檔案開頭）：

```typescript
describe('history 路徑：assistant 訊息沒有 index，多個 block 依序附加進同一個 turn', () => {
  it('同一個 messageId 的 thinking 與 tool_use 兩個 block 依序附加，不互相取代', () => {
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
    const view = fold(runHistory(HISTORY))
    const completable = assistantCompletable(view)
    // fixture 04：msg1 一個 thinking，msg2 一個 thinking 加一個 text，共 3 個
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === false)).toBe(true)
  })

  it('載入端補一筆 { kind: session-end, isError: false } 後，同一批 assistant block 全部變 complete:true', () => {
    const events: readonly Event[] = [...runHistory(HISTORY), { kind: 'session-end', isError: false }]
    const view = fold(events)
    const completable = assistantCompletable(view)
    expect(completable.length).toBeGreaterThan(0)
    expect(completable.every((b) => b.complete === true)).toBe(true)
  })
})

describe('不得靜默丟棄：認不出來的事件仍要有可見產出', () => {
  it('fixture 03 全程沒有 unknown Event，fold 之後也沒有 unknown block（裁決 1）', () => {
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
    const view = fold(liveEvents(LIVE))
    // fixture 第 9 行 session_id，第 54 行 total_cost_usd／num_turns
    expect(view.sessionId).toBe('a727625f-71c3-49c8-8646-2414bede4756')
    expect(view.ended).toBe(true)
    expect(view.cost?.usd).toBeCloseTo(0.3197795)
    expect(view.cost?.turns).toBe(2)
  })

  it('沒有收到 session-end 之前 ended 是 false', () => {
    const view = fold(liveEvents(LIVE.slice(0, 53)))
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
    const view = fold(liveEvents(LIVE))
    expect(view.ended).toBe(true)
    expect(view.error).toBeUndefined()
  })
})
```

35 個測試的來源：Task 4 最終版 19 條裡 17 條逐字保留（`tool_use` 最小佔位那 2 條被
取代）；本 task 新增 18 條：Bash 生命週期 6 條、`session-end` 收尾 tool block 4 條、
`permission-denied` 用 fixture 02 的 2 條、`permission-denied` 精準對應 1 條、
純粹執行失敗 1 條、孤兒事件 1 條、history 路徑 3 條。17 + 18 = 35。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npm test tests/fold.test.ts`
Expected: FAIL。`fold.ts` 現在還是 Task 4 的版本（已含裁決 5、15 的 `applySessionEnd`
與 `applyUserText` 的 `complete:true`，但 `applyToolResult`／`applyToolRawOutput`／
`applyPermissionDenied`／`applyToolInputDelta`／`applyToolsSessionEnd` 都不存在），
但因為這些都是內部函式（`fold.test.ts` 只 import `fold` 本身），實際會看到的不是
「找不到函式」，而是新測試斷言值錯誤，例如「block-stop 不改動 tool block」讀到
`status` 停在 `'streaming-input'`（因為 Task 4 版本的 `tool-input-delta`／
`tool-result` 是 no-op，`applyToolUseSnapshot` 也還不推進到 `running`），跟預期的
`'running'`／`'done'` 對不上；`inputPartial` 的測試會讀到 `undefined`。

實測（把 Task 4 最終版的 `fold.ts` 放進 worktree，只套用本 task 的 `fold.test.ts`，
不套用本 task 對 `fold.ts` 的修改）：`Tests  17 failed | 18 passed (35)`。18 條
PASS 的是「block-start 後：streaming-input」與 17 條逐字保留自 Task 4 的測試；
其餘 17 條全部涉及工具狀態推進、`deniedReason` 或 `session-end` 收尾 tool block，
全部 FAIL，符合預期。

- [ ] **Step 3: 寫最小實作**

`src/shared/fold.ts` 完整檔案，取代 Task 4 的版本。跟 Task 4 最終版的差別只有四處：
`Block` 的 `tool` 變體加 `deniedReason?: string`（裁決 12）、`applyToolUseSnapshot`
從「有既有 block 就原樣不動」改成「填 input、推進到 running」、新增六個工具狀態函式、
`applyEvent` 的四個 case 接上它們。`ConversationView`／`Turn`／`sessionEndError`
（裁決 17）／`case 'reset'`（裁決 22）與其餘所有函式一字不動。

第一段：檔案開頭的說明、三個對外型別（`Block` 的 `tool` 變體多了 `deniedReason`）、
內部工作模型與去重機制。

```typescript
/**
 * 把 Event 流投影成畫面要的 ConversationView（規格 4.2）。
 *
 * text、thinking、unknown 三種 Block 之外，tool block 的六個狀態推進也在這裡
 * （streaming-input / running / done / error / denied，awaiting-approval 由 Task 10 疊加）。
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
      readonly deniedReason?: string
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

```

第二段：text／thinking 的 delta 累加與快照取代、`applyBlockStop`、`applySessionEnd`
（只碰 text／thinking），以及裁決 17 的 `sessionEndError`。這一段與 Task 4 最終版
逐字相同。

```typescript
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
    // tool／unknown 沒有 complete 欄位，block-stop 對它們沒有意義，維持原樣。
    return existing
  })
}

/**
 * complete 的另一個來源（裁決 5、15）：session-end 到達時，「其餘所有」
 * text／thinking block 一律變完成，不分是否曾收到各自的 block-stop。這裡回傳
 * 新陣列，每筆需要改的 record 也是新物件，不就地改動舊的。
 *
 * tool block 這裡不動：running -> done 的推進是裁決 15 的另一半，由
 * applyToolsSessionEnd 負責，兩者在同一個 case 疊加呼叫。
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

第三段：`block-start` 的最小佔位，以及改寫過的 `applyToolUseSnapshot`。history 沒有
前置 `block-start` 時（`existing` 是 `undefined`）新建也直接落在 `running`，不特別
區分 live／history，兩者的差異已經完全由「`existing` 有沒有東西」表達。

```typescript
// ---- tool_use：block-start 的最小佔位 ----

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
 * 完整快照到達：填 input 並推進到 running。live 路徑上 block-start 已經放了佔位，
 * history 路徑沒有 block-start，tool-use 快照是該工具呼叫唯一會抵達的事件，這裡新建。
 * 兩者的差別已經完全由「existing 有沒有東西」表達，不必另外分支。
 *
 * 這裡不會產生 awaiting-approval：Event 聯集裡沒有任何一種事件代表「正在等待批准」，
 * 批准走的是 canUseTool 加 IPC，跟 SDK 訊息流是兩條分開的管線。fold() 誠實地推進到
 * 它唯一能確定的下一步 running，等待批准的視覺由 Task 10 的 applyPendingApprovals 疊加。
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
    if (existing !== undefined && existing.kind === 'tool') {
      return { ...existing, id, name, input, status: 'running' }
    }
    return { kind: 'tool', id, name, input, status: 'running' }
  })
}

```

第四段：本 task 新增的六個函式。`tool-result`／`tool-raw-output`／`permission-denied`
這三種事件只帶 `id`（或 `toolUseId`），不帶 `messageId`／`index`（契約的 `Event` 型別
就是這樣定義的，沒得選），所以不能沿用 `blockKey`／`placeBlock` 那套 `(messageId, index)`
查找，得直接在全域 `records` 裡找 `block.id` 相符的那一筆。找不到就不靜默丟棄，掛一個
看得見的 `unknown` block（跟 `applyBlockStop` 找不到對應 block 時的處置一致）。

```typescript
// ---- 工具區塊狀態機（tool-input-delta／tool-result／tool-raw-output／permission-denied）----

type ToolBlock = Extract<Block, { kind: 'tool' }>

/** tool-input-delta：累積進 inputPartial，狀態不變。 */
function applyToolInputDelta(
  records: readonly BlockRecord[],
  messageId: string,
  index: number,
  partialJson: string
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing !== undefined && existing.kind === 'tool') {
      return { ...existing, inputPartial: (existing.inputPartial ?? '') + partialJson }
    }
    // 協定應該保證 block-start 先到，這裡仍防禦性地開一個佔位承接，不吃掉事件。
    return { kind: 'tool', id: '', name: '', input: undefined, inputPartial: partialJson, status: 'streaming-input' }
  })
}

/**
 * 依 id（不是 messageId／index）找到對應的 tool block 並用 updater 更新它。
 * tool-result／tool-raw-output／permission-denied 三種事件只帶 id，契約的 Event 型別
 * 就是這樣定義的，沒得選。找不到就不靜默丟棄，用 applyUnknown 掛一個看得見的痕跡。
 */
function updateToolBlock(
  view: WorkingView,
  id: string,
  orphanNote: string,
  updater: (existing: ToolBlock) => ToolBlock
): WorkingView {
  const idx = view.records.findIndex((r) => r.block.kind === 'tool' && r.block.id === id)
  if (idx === -1) return applyUnknown(view, { note: orphanNote, id })
  const target = view.records[idx]
  const existingBlock = target?.block
  if (target === undefined || existingBlock === undefined || existingBlock.kind !== 'tool') return view
  const updatedRecord = { ...target, block: updater(existingBlock) }
  return { ...view, records: view.records.map((r, i) => (i === idx ? updatedRecord : r)) }
}

/**
 * tool-result：done／error。denied 是終態，一旦被拒絕，之後補到的 tool-result
 * （SDK 會生成一則「已封鎖」的合成結果讓對話能繼續）不得把 denied 蓋回 error。
 * 這正是 fixture 02 的真實序列（permission_denied 先到，隨後 user 訊息帶
 * isError:true 的 tool_result），不擋的話 UI 會把「使用者拒絕」顯示成「執行失敗」。
 */
function applyToolResult(view: WorkingView, id: string, content: unknown, isError: boolean): WorkingView {
  return updateToolBlock(view, id, 'tool-result 沒有對應的 tool block', (existing) =>
    existing.status === 'denied' ? existing : { ...existing, result: content, status: isError ? 'error' : 'done' }
  )
}

/**
 * tool-raw-output：填 raw，狀態不變，不受 denied／error／done 影響。裁決 4：
 * history 路徑永遠不會有這個事件，所以 history 的 tool block 的 raw 永遠停在
 * undefined，這是刻意的缺席，不是遺漏。
 */
function applyToolRawOutput(
  view: WorkingView,
  id: string,
  stdout: string,
  stderr: string,
  interrupted: boolean
): WorkingView {
  return updateToolBlock(view, id, 'tool-raw-output 沒有對應的 tool block', (existing) => ({
    ...existing,
    raw: { stdout, stderr, interrupted },
  }))
}

/**
 * permission-denied：denied，是終態（見 applyToolResult 的說明）。裁決 12：拒絕理由
 * 填 deniedReason，不塞進 result（result 的語意是工具的執行結果，被拒絕的工具根本
 * 沒有執行）。message 缺席時給一句預設文案，UI 不必另外處理「denied 但沒有理由」。
 */
function applyPermissionDenied(view: WorkingView, toolUseId: string, message: string | undefined): WorkingView {
  return updateToolBlock(view, toolUseId, 'permission-denied 沒有對應的 tool block', (existing) => ({
    ...existing,
    status: 'denied',
    deniedReason: message ?? '權限被拒絕',
  }))
}

/**
 * session-end 收尾工具區塊（裁決 15，另一半是 applySessionEnd，只碰 text／thinking）：
 * running 收尾成 done，result 維持 undefined（沒有真正的結果，不造假一個）。
 * streaming-input 一併收尾：query 已經結束，輸入快照卻還沒到，代表串流被中斷，
 * 不可能再有內容進來。denied／done／error 已經是終態，原樣不動。
 *
 * 只碰 kind === 'tool' 的 record，跟 applySessionEnd 操作不相交的 block kind，
 * 兩者在 applyEvent 的 session-end case 疊加呼叫，順序不影響結果。
 */
function applyToolsSessionEnd(records: readonly BlockRecord[]): readonly BlockRecord[] {
  return records.map((r) => {
    if (r.block.kind !== 'tool') return r
    if (r.block.status !== 'running' && r.block.status !== 'streaming-input') return r
    return { ...r, block: { ...r.block, status: 'done' as const } }
  })
}

```

第五段：user turn 與 unknown 的掛載，與 Task 4 最終版逐字相同。

```typescript
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

```

第六段：主 reduce 與對外的 `fold`。跟 Task 4 最終版的差別是四個 case：
`tool-input-delta` 從「忽略」改成呼叫 `applyToolInputDelta`（跟其他 delta 事件一樣要先
`ensureAssistantTurn`，因為這個事件帶 `messageId`）；`tool-result`／`tool-raw-output`／
`permission-denied` 從「忽略」改成呼叫對應的新函式；`session-end` case 在
`applySessionEnd` 外面包一層 `applyToolsSessionEnd`。`ended`／`cost`／`sessionEndError`
與 `case 'reset'` 都不動。

```typescript
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
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyToolInputDelta(view.records, event.messageId, event.index, event.partialJson),
      }
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
    // 這三種只帶 id，不帶 messageId／index，所以不呼叫 ensureAssistantTurn，
    // updateToolBlock 直接對 records 操作。
    case 'tool-result':
      return applyToolResult(view, event.id, event.content, event.isError)
    case 'tool-raw-output':
      return applyToolRawOutput(view, event.id, event.stdout, event.stderr, event.interrupted)
    case 'permission-denied':
      return applyPermissionDenied(view, event.toolUseId, event.message)
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
        // applySessionEnd 只碰 text／thinking，applyToolsSessionEnd 只碰 tool，
        // 兩者操作不相交的 block kind，疊加順序不影響結果。
        records: applyToolsSessionEnd(applySessionEnd(view.records)),
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

`src/shared/fold.ts` 完整檔案實測 524 行（Task 4 最終版 410 行加上本 task 的六個函式與
`deniedReason` 欄位），仍在單檔 800 行的上限內。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/fold.test.ts`
Expected: PASS，35 個測試。

實測（`git worktree add` 出一份獨立工作樹，材料化 Task 3 的 `events.ts` 與
`tests/helpers/live-events.ts`、本文件的 `fold.ts` 與 `fold.test.ts`，用專案既有的
vitest／tsc 實際跑過，不是紙上推演）：

```
 RUN  v4.1.11

 Test Files  1 passed (1)
      Tests  35 passed (35)
   Duration  144ms
```

Run: `npm run typecheck`
Expected: 無錯誤。實測 `tsc --noEmit`（`strict`＋`noUncheckedIndexedAccess`）乾淨
通過。唯一需要注意型別窄化的地方是 `updateToolBlock` 裡 `view.records[idx]`：
`noUncheckedIndexedAccess` 下型別是 `BlockRecord | undefined`，程式碼用
`if (target === undefined || existingBlock === undefined || existingBlock.kind !== 'tool') return view`
明確處理，不是靠斷言蓋過去；理論上 `findIndex` 已經篩過 `kind === 'tool'`，這個
分支不會真的走到，但型別系統沒辦法從 `findIndex` 的 predicate 反推 `records[idx]`
的型別，寧可留一個不會觸發的安全網也不要用 `!` 斷言繞過去。

Run: `npm test`（同一個 worktree，跑既有五個測試檔＋Task 3 的 `events.test.ts`
＋本 task 的 `fold.test.ts`）：`Test Files  7 passed (7)`、`Tests  140 passed (140)`
（`spawn-args` 11、`layout` 6、`ipc` 14、`cdp` 10、`measure-memory` 18、
`events` 46、`fold` 35）。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

十三個突變：本 task 的 `fold.ts` 是完整檔案，所以 Task 4 的八條也要在這個檔案上重跑一次，
與本 task 自己的五條合併成一張表。每一條都在 worktree 裡真的改程式碼、真的跑 `vitest run`、
記下紅燈輸出，再還原、重新跑一次確認回到 35 個全綠，全部是實際跑出來的，不是預測。

沿用自 Task 4 的八條（編號沿用 Task 4，紅燈條數以本 task 的 35 條測試為準重跑）：

| # | 突變 | 實測紅的測試 |
|---|---|---|
| 1 | `placeBlock` 的 `existing` 強制設成 `undefined`（拿掉去重） | 13 條（Task 4 那六條，加上工具生命週期與 denied 對應共七條，見下方輸出） |
| 2 | `blockKey` 改成 `JSON.stringify([index])` | 「index 重置」、「完整跑完整份 fixture：狀態最終停在 done」、「裁決 4：history 沒有 tool-raw-output」共 3 條 |
| 3 | `applyTextSnapshot` 的 `complete` 寫死 `true` | 「complete 的來源」第一條與「history 路徑與 session-end 的分工」第一條，共 2 條 |
| 4 | `session-end` case 改成 `applyToolsSessionEnd(view.records)`（不呼叫 `applySessionEnd`） | 「complete 的來源」第二條與「history 路徑與 session-end 的分工」第二條，共 2 條 |
| 5 | `applyUserText` 的 `complete` 改回 `false` | 「user-text」1 條 |
| 6 | `sessionEndError` 拿掉 `if (event.isError !== true) return undefined` | 「正常 session-end 之後 view.error 是 undefined（裁決 17）」1 條 |
| 7 | `case 'reset'` 改成 `return view` | 「reset 之前的事件不出現在結果裡」1 條 |
| 8 | `case 'unknown'` 改成 `return view` | 「手工合成的 unknown 事件掛到當下最後一個 turn 上」1 條 |

本 task 自己的五條（編號沿用本 task 原本的 1 到 5，以 B 開頭區別）：

| # | 突變 | 改法 | 實測紅的測試 |
|---|---|---|---|
| B1 | denied 不再是終態 | `applyToolResult` 拿掉 `existing.status === 'denied' ? existing :` 這個守衛，改成 `tool-result` 永遠覆蓋 status | 「permission_denied 先到 → denied」（fixture 02）與「denied 是終態，session-end 不覆蓋」共 2 條 |
| B2 | `updateToolBlock` 查找不比對 id | `findIndex((r) => r.block.kind === 'tool' && r.block.id === id)` 改成 `findIndex((r) => r.block.kind === 'tool')` | 「只有後建立的 toolu_BBB 變成 denied」1 條 |
| B3 | tool-use 快照不推進狀態 | `applyToolUseSnapshot` 的兩個分支都拿掉 `status: 'running'`，既有 block 保留原 status、新建 block 改回 `status: 'streaming-input'` | 「完整快照到達：input 有值，狀態推進到 running」等 5 條 |
| B4 | session-end 不推進 running／streaming-input → done | `applyEvent` 的 `session-end` case 拿掉 `applyToolsSessionEnd(...)` 這層包裝，只留 `applySessionEnd(view.records)` | 「session-end：running／streaming-input 的 tool block 收尾」組裡的 running／streaming-input 兩條，加上 history「裁決 13／15 的分工」那條，共 3 條 |
| B5 | denied 把訊息塞回 result、不填 deniedReason | `applyPermissionDenied` 改回 `...(message === undefined ? {} : { result: message })`，拿掉 `deniedReason: message ?? '權限被拒絕'` | 「permission_denied 先到 → denied」（fixture 02）與「只有後建立的 toolu_BBB 變成 denied」共 2 條 |

突變 4 與 B4 動的是同一行的兩半：4 拿掉裡層的 `applySessionEnd`（text／thinking 不再收尾），
B4 拿掉外層的 `applyToolsSessionEnd`（tool 不再收尾），紅的測試互不重疊，兩條都要跑。

**突變 1 的實測輸出**（去重拿掉之後波及最廣的一條）：

```
 Tests  13 failed | 22 passed (35)
```

紅的是：去重 1 條、index 重置 1 條、complete 來源 2 條、Bash 生命週期 5 條、
`session-end` 收尾 2 條、denied 精準對應 1 條、「fixture 03 全程沒有 unknown block」1 條。
最後那條是因為 `applyBlockStop` 查不到既有 block 時會生一個 unknown block，四個
`block-stop` 就是四個。還原後重跑：`Tests  35 passed (35)`。

**突變 B1 的實測輸出**：

**突變 1 的實測輸出**：

```
 FAIL  tests/fold.test.ts > session-end：running／streaming-input 的 tool block 收尾（裁決 15） > denied 是終態，session-end 不覆蓋
AssertionError: expected 'error' to be 'denied' // Object.is equality
 FAIL  tests/fold.test.ts > permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉 > permission_denied 先到 → denied（deniedReason 有值，result 維持 undefined）；隨後 isError:true 的 tool-result 到達 → 仍是 denied 不是 error
AssertionError: expected 'error' to be 'denied' // Object.is equality
 Tests  2 failed | 33 passed (35)
```

兩條變紅，其餘 33 條不受影響，這正是**「看起來還會過」的那種突變**：如果只看
「tool-result(isError:true) 且從未被 denied」那條，它斷言的是一個從未被拒絕的
block，跟這個守衛完全不相干，兩種實作結果一樣，看不出 denied 的優先權被拿掉了。
沒有這兩條專門對「denied 之後又收到 tool-result」序列斷言的測試，這個 bug 會直接
漏進 Task 9：使用者明明點了拒絕，畫面卻顯示成「執行失敗」。還原後重跑：
`Tests  35 passed (35)`。

**突變 B2 的實測輸出**：

```
 FAIL  tests/fold.test.ts > permission-denied 精準對應到正確 block（合成資料）
 > 只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響
AssertionError: expected 'running' to be 'denied' // Object.is equality
 Tests  1 failed | 34 passed (35)
```

這條也在草稿階段被驗算修過一次，記在這裡因為過程本身就是「不要假設」的示範：
第一版把被拒絕的目標放在 `twoToolEvents` 裡**第一個**建立的工具（`toolu_AAA`）
上。`Array.prototype.findIndex` 找到的第一個符合 `kind === 'tool'` 的 record
剛好就是它，所以那一版即使把 `&& r.block.id === id` 整段拿掉，`toolu_AAA` 依然
會被找到、依然變成 `denied`，測試全綠，**跟 Task 4 自己踩過的坑同一個模式**：斷言
和名字都對，但資料剛好讓查找邏輯的漏洞沒有機會顯現。改成把 denied 目標放在
`twoToolEvents` 陣列裡**第二個**建立的工具（`toolu_BBB`）之後，`findIndex`
不比對 id 時只會抓到第一個（`toolu_AAA`），跟預期的 `toolu_BBB` 對不上，才會真的
變紅（如上面的實測輸出）。還原後重跑：`Tests  35 passed (35)`。

**突變 B3 的實測輸出**：

```
 FAIL  tests/fold.test.ts > Bash 工具生命週期（真實 fixture 03，line 20-30） > 完整快照到達：input 有值，狀態推進到 running
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > Bash 工具生命週期（真實 fixture 03，line 20-30） > block-stop（第 26 行）不改動 tool block（tool 沒有 complete 欄位）
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉 > 沒有前置 block-start（fixture 02 全程沒有 stream_event）時，tool-use 快照本身直接新建 running
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > permission-denied 精準對應到正確 block（合成資料） > 只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響
AssertionError: expected 'streaming-input' to be 'running'
 FAIL  tests/fold.test.ts > history 路徑（fixture 04）：tool block 的 status 與 raw > 裁決 13／15 的分工：拿掉 tool_result（第 4 行）後 fold(history) 停在 running；載入端補一筆 session-end 才變成 done
AssertionError: expected 'streaming-input' to be 'running'
 Tests  5 failed | 30 passed (35)
```

五條變紅，全部是直接依賴「快照到達會推進到 running」這件事的測試，包含連鎖影響
到「denied 對應」測試裡對照組 `toolu_AAA` 的斷言（它預期維持 `running`，這個突變
下它從未離開過 `streaming-input`），以及 history 裁決 13／15 的分工測試（它的第一段
斷言就是 `running`，快照都推不進 `running`，自然連帶變紅）。這是本 task 五個突變裡
**最直接、最不需要巧思就能抓到**的一個，用來對照 B1／B2／B5 那種需要專門測試才抓得到
的類型。還原後重跑：`Tests  35 passed (35)`，並重新跑過 `tsc --noEmit` 確認無殘留的
型別錯誤。

**突變 B4 的實測輸出**：

```
 FAIL  tests/fold.test.ts > session-end：running／streaming-input 的 tool block 收尾（裁決 15） > running 的 tool block 在 session-end 之後變成 done，result 維持 undefined
AssertionError: expected 'running' to be 'done' // Object.is equality
 FAIL  tests/fold.test.ts > session-end：running／streaming-input 的 tool block 收尾（裁決 15） > streaming-input 的 tool block 在 session-end 之後也變成 done（快照沒到就代表串流被中斷）
AssertionError: expected 'streaming-input' to be 'done' // Object.is equality
 FAIL  tests/fold.test.ts > history 路徑（fixture 04）：tool block 的 status 與 raw > 裁決 13／15 的分工：拿掉 tool_result（第 4 行）後 fold(history) 停在 running；載入端補一筆 session-end 才變成 done
AssertionError: expected 'running' to be 'done' // Object.is equality
 Tests  3 failed | 32 passed (35)
```

三條變紅：兩條直接測 session-end 收尾，一條是 history 路徑靠 session-end 收尾才
變 done 的分工測試（裁決 13／15）。這條突變抓的正是「拿掉這個 task 對裁決 15
的一半實作」這件事，若沒有這三條，本 task 加的 `applyToolsSessionEnd` 形同沒測到。
還原後重跑：`Tests  35 passed (35)`。

**突變 B5 的實測輸出**：

```
 FAIL  tests/fold.test.ts > permission-denied：真實 fixture 02，denied 是終態不被隨後的 tool-result 蓋掉 > permission_denied 先到 → denied（deniedReason 有值，result 維持 undefined）；隨後 isError:true 的 tool-result 到達 → 仍是 denied 不是 error
AssertionError: expected undefined to deeply equal StringContaining "was blocked"
 FAIL  tests/fold.test.ts > permission-denied 精準對應到正確 block（合成資料） > 只有後建立的 toolu_BBB 變成 denied（deniedReason 有值，result 是 undefined），先建立的 toolu_AAA 維持 running 不受影響
AssertionError: expected undefined to be '危險指令被擋下' // Object.is equality
 Tests  2 failed | 33 passed (35)
```

兩條變紅：`deniedReason` 讀到 `undefined`。這條突變抓的是裁決 12 的核心，若沒有
這兩條專門斷言 `deniedReason` 有值且 `result` 是 `undefined` 的測試，退回舊行為
（塞進 result）一樣能讓其他 33 條測試全綠，因為其他測試都不檢查 `deniedReason`。
還原後重跑：`Tests  35 passed (35)`。

十三條突變全部跑過，每條都至少讓一條測試變紅，沒有無效或重複的條目：Task 4 的八條
在本 task 的 35 條測試上仍然各自命中，本 task 的五條命中工具狀態推進的五個面向。

- [ ] **Step 6: 執行完整測試套件**

Run: `npm test`
Expected: PASS。本 task 沒有新增檔案，`tests/fold.test.ts` 的測試數從 Task 4 的 19
變成本 task 的 35。專案總數 = Task 4 完成時的總數 − 19 ＋ 35。本 task 給的
`fold.test.ts` 已經含 Task 4 全部保留下來的 17 條，不需要再手動合併任何東西。
把執行當下的實際數字記進報告，不要照抄本文件的數字，它是撰寫當下的快照。
2026-09-02 的驗證 worktree 是從 `feat/a-sdk-host` 的 HEAD 開的（Task 0、1、2 都還沒
套用，既有測試是 5 個檔 59 條），加上 Task 3 的 46 條與本 task 的 35 條，實測
`Test Files 7 passed`、`Tests 140 passed`。

執行本 task 前提：Task 4 的 `fold.ts`／`fold.test.ts` 必須已經套用到專案（本 task 的兩個
完整檔案是在它之上做的，Step 2 的失敗計數也是在它上面量的）。Task 3 的 `events.ts` 與
`tests/helpers/live-events.ts` 同樣必須先於 Task 4 存在。Task 5／6／7 不是 `fold.ts`
的依賴，順序上不影響本 task。

- [ ] **Step 7: 提交**

```bash
git add src/shared/fold.ts tests/fold.test.ts
git commit -m "feat: fold 的工具區塊狀態機，六個狀態的推進規則、denied 終態與 deniedReason、session-end 收尾（保留裁決 17 的 error 與裁決 22 的 reset）"
```

## 契約疑慮（不擅自更動，記錄理由）

本節原本記錄三項疑慮，控制端已在 2026-09-02 分別以裁決 11／28、12、13／15 定案。
記錄留著，改成陳述已定案的結論，供之後讀這份文件的人知道問題怎麼收的。

1. **`approvalAsk` 帶 `toolUseId`（裁決 28 定案，取代裁決 11）。** CONTRACT.md 的 IPC 一節
   原本只寫 `{ requestId, toolName, input }`，本 task 原本的疑慮是：要把「等待批准」
   精準疊到正確的 Block 上，需要一個能對回 `id` 的鍵，同一個工具短時間內發出兩次幾乎
   一樣的呼叫時對不準。裁決 11 先以「`toolName` 加 `input` 深度相等比對」回應；
   2026-09-02 重查 `sdk.d.ts`（0.3.258 第 248 行）發現 `CanUseTool` 的 options 有必填的
   `toolUseID`，裁決 28 改成 payload 直接帶 `toolUseId`，Task 10 的
   `applyPendingApprovals`（純函式）以 `block.id === ask.toolUseId` 疊加
   `status: 'awaiting-approval'`，`fold()` 本身不動，內容比對與它的特殊情況全部消失。
   `approvalAsk` payload 另外有 `title`／`displayName` 兩個 SDK 欄位供 UI 顯示提示句用
   （裁決 11 留下的部分）；本 task 不讀這些欄位。

2. **`result` 欄位一物二用（裁決 12 定案）。** 本 task 原本借用 `Block.tool.result`
   承接拒絕原因，控制端裁決：新增獨立的 `deniedReason?: string` 欄位，`result`
   的語意收回單純的「工具執行結果」。本文件的實作與測試已經照裁決 12 更新：
   `applyPermissionDenied` 填 `deniedReason`，不再動 `result`；denied 狀態下
   `result` 維持 `undefined`。

3. **歷史工具呼叫若沒有對應的 `tool_result`（裁決 13、15 定案）。** 本 task 原本
   的疑慮是：這類 tool block 的 `status` 會永遠停在 `running`。控制端裁決 15
   統一了收尾機制：`fold()` 收到 `session-end` 時，所有 `running`／
   `streaming-input` 的 tool block 一律收尾成 `done`，`result` 維持 `undefined`；
   歷史路徑由 Task 11 的 `session-store.ts` 在 `normalizeHistory` 產出的事件
   尾端補一筆 `{ kind: 'session-end', isError: false }`，走同一條規則，不需要
   `fold()` 知道事件來自哪條路徑。本文件的 Step 1「裁決 13／15 的責任分工」測試
   與 Step 5 突變 4 已經驗證這條規則。

4. **CONTRACT.md 的 `Block` 型別片段沒有同步裁決 12（已解決）。** 本 task 上一版
   回報的不一致：契約「## ConversationView」段落照抄的 `Block` 型別片段少了
   `deniedReason`。2026-09-02 覆查，契約那段已經補上
   `deniedReason?: string // 裁決 12：status 為 denied 時的拒絕理由，result 維持 undefined`，
   兩處一致，這一項結案。
