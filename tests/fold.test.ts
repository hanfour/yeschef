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
  it('session-end 只有 tokens 時 cost 也要成立', () => {
    const view = fold([{ kind: 'session-end', isError: false, tokens: 4200 }])
    expect(view.cost).toEqual({ tokens: 4200 })
  })

  it('session-start 設定 sessionId，session-end 設定 ended 與 cost', () => {
    const view = fold(liveEvents(LIVE))
    // fixture 第 9 行 session_id，第 54 行 total_cost_usd／num_turns
    expect(view.sessionId).toBe('a727625f-71c3-49c8-8646-2414bede4756')
    expect(view.ended).toBe(true)
    expect(view.cost?.usd).toBeCloseTo(0.3197795)
    expect(view.cost?.turns).toBe(2)
  })

  it('沒有 costUsd／numTurns 的 session-end 之後 view.cost 是 undefined（控制端修訂 1：修正 Task 4 一律建立 cost:{} 的 bug）', () => {
    // 歷史對話補的 session-end（裁決 15）就是這個形狀：{ kind: 'session-end', isError: false }，
    // 沒有 costUsd／numTurns。UI footer 以 view.cost !== undefined 判斷要不要畫，
    // 一律建物件會讓歷史對話多一個空 footer。
    const view = fold([{ kind: 'session-end', isError: false }])
    expect(view.cost).toBeUndefined()
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

  it('block-stop 沒有對應的 block 時留下 unknown，不靜默略過', () => {
    const events: readonly Event[] = [
      { kind: 'message-start', messageId: 'msg_孤兒', model: 'claude-opus-5' },
      { kind: 'block-stop', messageId: 'msg_孤兒', index: 7 },
    ]
    const view = fold(events)
    const unknowns = allBlocks(view).filter((b) => b.kind === 'unknown')
    expect(unknowns).toHaveLength(1)
    expect(JSON.stringify(unknowns[0])).toContain('block-stop 沒有對應的 block')
  })

  it('第一個事件就是 unknown 時新開一個 turn 來裝它，事件不會憑空消失', () => {
    const events: readonly Event[] = [{ kind: 'unknown', raw: { note: '開場就認不出來' } }]
    const view = fold(events)
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.role).toBe('assistant')
    expect(view.turns[0]?.blocks).toEqual([{ kind: 'unknown', raw: { note: '開場就認不出來' } }])
  })
})

describe('compact-boundary 進 fold', () => {
  const boundary: Event = { kind: 'compact-boundary', trigger: 'auto', preTokens: 70422, postTokens: 27775 }

  it('掛在目前最後一個 turn 的尾端,照串流順序', () => {
    const view = fold([
      { kind: 'user-text', text: '嗨' },
      { kind: 'text', messageId: 'm-1', index: 0, text: '好' },
      boundary,
    ])
    const last = view.turns[view.turns.length - 1]
    expect(last?.blocks.map((b) => b.kind)).toEqual(['text', 'compact-boundary'])
    expect(last?.blocks[1]).toEqual({ kind: 'compact-boundary', trigger: 'auto', preTokens: 70422, postTokens: 27775 })
  })

  it('一個 turn 都沒有時新開 assistant turn 來裝,不憑空消失', () => {
    const view = fold([boundary])
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.role).toBe('assistant')
    expect(view.turns[0]?.blocks.map((b) => b.kind)).toEqual(['compact-boundary'])
  })

  it('後面再來的訊息開新 turn,分隔線留在前一輪', () => {
    const view = fold([
      { kind: 'user-text', text: '嗨' },
      boundary,
      { kind: 'message-start', messageId: 'm-2' },
      { kind: 'text', messageId: 'm-2', index: 0, text: '接著' },
    ])
    expect(view.turns.map((t) => t.blocks.map((b) => b.kind))).toEqual([['text', 'compact-boundary'], ['text']])
  })
})

describe('compact-summary 進 fold', () => {
  it('自成一個 turn,block 是 compact-summary', () => {
    const view = fold([{ kind: 'compact-summary', text: '摘要內容' }])
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.blocks).toEqual([{ kind: 'compact-summary', text: '摘要內容' }])
  })

  it('接在分隔線之後,兩者不混進同一個 turn', () => {
    const view = fold([
      { kind: 'user-text', text: '嗨' },
      { kind: 'compact-boundary', trigger: 'auto', preTokens: 100, postTokens: 20 },
      { kind: 'compact-summary', text: '摘要內容' },
    ])
    expect(view.turns.map((t) => t.blocks.map((b) => b.kind))).toEqual([
      ['text', 'compact-boundary'],
      ['compact-summary'],
    ])
  })
})
