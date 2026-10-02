import { describe, it, expect } from 'vitest'
import {
  applyPendingApprovals,
  findAskForBlock,
  matchApproval,
  openAsks,
  unmatchedAsks,
} from '../src/renderer/approvals.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import type { Block, ConversationView } from '../src/shared/fold.js'
import type { ToolBlock } from '../src/renderer/components/Conversation.js'

/**
 * 工具名稱、tool_use_id 與 input 全部取自 tests/fixtures/events/03-sdk-live-stream.jsonl
 * 裡那顆真的 Bash 呼叫。view 本身是手組的：這一層測的是「兩個資料結構怎麼對上」，
 * 不是 fold() 怎麼組 view，把 fold 拉進來只會讓失敗訊息指向別人家的程式碼。
 */
const BASH_ID = 'toolu_01L2YCZHqTvRDmdkNpsprfCQ'
const BASH_INPUT = {
  command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
  description: 'Write hello to cap.txt and verify',
}

function toolBlock(
  id: string,
  status: ToolBlock['status'],
  input: unknown = BASH_INPUT,
  extra: { readonly name?: string; readonly result?: unknown } = {}
): ToolBlock {
  return {
    kind: 'tool',
    id,
    name: extra.name ?? 'Bash',
    input,
    result: extra.result,
    status,
  }
}

function viewOf(...blocks: readonly Block[]): ConversationView {
  return { turns: [{ role: 'assistant', messageId: 'msg_01', blocks }], ended: false }
}

/** toolUseId 預設就是那顆 Bash 的 id：多數案例要的是「對得上」。 */
function ask(over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId: 'req-1',
    projectId: 'p-1',
    conversationId: 'p-1-conv',
    toolUseId: BASH_ID,
    toolName: 'Bash',
    input: BASH_INPUT,
    ...over,
  }
}

describe('matchApproval', () => {
  it('toolUseId 對得上且狀態是 running 時命中', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    expect(matchApproval(view, ask())?.id).toBe(BASH_ID)
  })

  it('狀態是 streaming-input 也命中（input 還沒到齊不影響）', () => {
    const partial: ToolBlock = {
      kind: 'tool',
      id: BASH_ID,
      name: 'Bash',
      input: undefined,
      status: 'streaming-input',
    }
    expect(matchApproval(viewOf(partial), ask())?.id).toBe(BASH_ID)
  })

  it('toolUseId 對不上不命中，即使工具名稱與參數一模一樣', () => {
    const view = viewOf(toolBlock('toolu_OTHER', 'running'))
    expect(matchApproval(view, ask())).toBeUndefined()
  })

  it('同名同參數的兩個 block，各自的 ask 只掛到自己的 id', () => {
    const first = toolBlock('toolu_A', 'running')
    const second = toolBlock('toolu_B', 'running')
    const view = viewOf(first, second)
    expect(matchApproval(view, ask({ requestId: 'r1', toolUseId: 'toolu_A' }))?.id).toBe('toolu_A')
    expect(matchApproval(view, ask({ requestId: 'r2', toolUseId: 'toolu_B' }))?.id).toBe('toolu_B')
  })

  it('狀態是 denied／done／error 的 block 不命中', () => {
    for (const status of ['denied', 'done', 'error'] as const) {
      expect(matchApproval(viewOf(toolBlock(BASH_ID, status)), ask())).toBeUndefined()
    }
  })

  // matchApproval 的輸入是 fold() 直接產出的 raw view，那裡不會有 awaiting-approval
  // （它是 applyPendingApprovals 標上去的）。卡片要不要繼續畫由 findAskForBlock 決定。
  it('已經標成 awaiting-approval 的 block 不命中', () => {
    expect(matchApproval(viewOf(toolBlock(BASH_ID, 'awaiting-approval')), ask())).toBeUndefined()
  })

  it('跨 turn 尋找，text／thinking／unknown block 一律跳過', () => {
    const view: ConversationView = {
      turns: [
        { role: 'user', blocks: [{ kind: 'text', markdown: '跑一下', complete: true }] },
        {
          role: 'assistant',
          blocks: [
            { kind: 'thinking', text: '想一下', complete: true },
            { kind: 'unknown', raw: { hello: 'world' } },
            toolBlock(BASH_ID, 'running'),
          ],
        },
      ],
      ended: false,
    }
    expect(matchApproval(view, ask())?.id).toBe(BASH_ID)
  })

  it('沒有任何 tool block 時回 undefined', () => {
    expect(matchApproval({ turns: [], ended: false }, ask())).toBeUndefined()
  })
})

describe('findAskForBlock', () => {
  it('running 的 block 回 toolUseId 相同的那一筆', () => {
    const block = toolBlock(BASH_ID, 'running')
    const pending = [ask({ requestId: 'req-other', toolUseId: 'toolu_OTHER' }), ask()]
    expect(findAskForBlock(block, pending)?.requestId).toBe('req-1')
  })

  // applyPendingApprovals 標過之後 block 是 awaiting-approval，renderToolExtra 讀的
  // 就是標過的那份 view。這裡若不認 awaiting-approval，卡片會在標記生效的下一幀消失。
  it('awaiting-approval 的 block 仍然找得到那筆請求', () => {
    const block = toolBlock(BASH_ID, 'awaiting-approval')
    expect(findAskForBlock(block, [ask()])?.requestId).toBe('req-1')
  })

  it('block 已 denied 時回 undefined（逾時被拒絕後卡片跟著消失）', () => {
    const block = toolBlock(BASH_ID, 'denied')
    expect(findAskForBlock(block, [ask()])).toBeUndefined()
  })

  it('block 已 done 或 error 時回 undefined', () => {
    for (const status of ['done', 'error'] as const) {
      expect(findAskForBlock(toolBlock(BASH_ID, status), [ask()])).toBeUndefined()
    }
  })

  it('pending 裡沒有同一個 toolUseId 時回 undefined', () => {
    const block = toolBlock(BASH_ID, 'running')
    expect(findAskForBlock(block, [ask({ toolUseId: 'toolu_OTHER' })])).toBeUndefined()
    expect(findAskForBlock(block, [])).toBeUndefined()
  })
})

describe('applyPendingApprovals', () => {
  it('命中的 block 狀態改成 awaiting-approval', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const next = applyPendingApprovals(view, [ask()])
    expect(next.turns[0]?.blocks[0]).toMatchObject({
      kind: 'tool',
      id: BASH_ID,
      status: 'awaiting-approval',
    })
  })

  it('沒命中的 block 與其他 block 一字不改', () => {
    const other = toolBlock('toolu_OTHER', 'running', { command: 'ls' })
    const text: Block = { kind: 'text', markdown: '嗨', complete: false }
    const view = viewOf(other, toolBlock(BASH_ID, 'running'), text)
    const next = applyPendingApprovals(view, [ask()])
    expect(next.turns[0]?.blocks[0]).toBe(other)
    expect(next.turns[0]?.blocks[2]).toBe(text)
  })

  it('已經 denied 的 block 不會被標成 awaiting-approval', () => {
    const view = viewOf(toolBlock(BASH_ID, 'denied'))
    expect(applyPendingApprovals(view, [ask()])).toBe(view)
  })

  it('不修改傳進來的 view（純函式）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const before = JSON.stringify(view)
    applyPendingApprovals(view, [ask()])
    expect(JSON.stringify(view)).toBe(before)
    expect(view.turns[0]?.blocks[0]).toMatchObject({ status: 'running' })
  })

  it('沒有任何 block 被改到時回傳同一個 view 物件（memo 的淺比較要用）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    expect(applyPendingApprovals(view, [])).toBe(view)
    expect(applyPendingApprovals(view, [ask({ toolUseId: 'toolu_OTHER' })])).toBe(view)
  })

  it('重複套用是等冪的，且第二次回傳同一個物件', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const once = applyPendingApprovals(view, [ask()])
    expect(applyPendingApprovals(once, [ask()])).toBe(once)
  })

  it('多個 turn 各自命中', () => {
    const view: ConversationView = {
      turns: [
        { role: 'assistant', blocks: [toolBlock('t1', 'running', { command: 'ls' })] },
        { role: 'assistant', blocks: [toolBlock('t2', 'running', { command: 'pwd' })] },
      ],
      ended: false,
    }
    const next = applyPendingApprovals(view, [
      ask({ requestId: 'r1', toolUseId: 't1' }),
      ask({ requestId: 'r2', toolUseId: 't2' }),
    ])
    expect(next.turns.map((t) => (t.blocks[0] as ToolBlock).status)).toEqual([
      'awaiting-approval',
      'awaiting-approval',
    ])
  })
})

describe('unmatchedAsks', () => {
  it('view 裡沒有那個 id 時算未對應（規格 §8：不得靜默丟棄）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const early = ask({ requestId: 'req-early', toolUseId: 'toolu_NOT_YET', toolName: 'Write' })
    expect(unmatchedAsks(view, [ask(), early]).map((a) => a.requestId)).toEqual(['req-early'])
  })

  // 逾時被 deny 之後卡片消失，可見記錄是 block 上的 deniedReason，不是對話尾端
  // 又冒出一張按了沒反應的卡片。
  it('block 已 denied 時那筆 ask 不算未對應', () => {
    const view = viewOf(toolBlock(BASH_ID, 'denied'))
    expect(unmatchedAsks(view, [ask()])).toEqual([])
  })

  it('block 已 done 或 error 時那筆 ask 一樣不算未對應', () => {
    for (const status of ['done', 'error'] as const) {
      expect(unmatchedAsks(viewOf(toolBlock(BASH_ID, status)), [ask()])).toEqual([])
    }
  })

  it('全部對應得到時回空陣列', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    expect(unmatchedAsks(view, [ask()])).toEqual([])
  })

  it('同名同參數的兩個 block，兩筆 ask 各自掛自己的 id，沒有未對應', () => {
    const view = viewOf(toolBlock('toolu_A', 'running'), toolBlock('toolu_B', 'running'))
    const pending = [
      ask({ requestId: 'r1', toolUseId: 'toolu_A' }),
      ask({ requestId: 'r2', toolUseId: 'toolu_B' }),
    ]
    expect(unmatchedAsks(view, pending)).toEqual([])
  })

  it('對話裡完全沒有 tool block 時，所有請求都是未對應', () => {
    const view: ConversationView = { turns: [], ended: false }
    const pending = [
      ask({ requestId: 'r1', toolUseId: 'toolu_A' }),
      ask({ requestId: 'r2', toolUseId: 'toolu_B' }),
    ]
    expect(unmatchedAsks(view, pending)).toEqual(pending)
  })
})

// 修正 1（D4）：輸入框該不該停用，判準是「還在等使用者回答的請求」，不是
// 「收到過的請求」。openAsks 從 pending 濾掉 block 已了結（done／error）的那些。
describe('openAsks', () => {
  it('pending 為空時回傳同一個參考（memo 用得到）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    const pending: ApprovalAskPayload[] = []
    expect(openAsks(view, pending)).toBe(pending)
  })

  it('block 是 running 時留下', () => {
    const view = viewOf(toolBlock(BASH_ID, 'running'))
    expect(openAsks(view, [ask()]).map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('block 是 streaming-input 時留下（input 還沒到齊不影響）', () => {
    const partial: ToolBlock = {
      kind: 'tool',
      id: BASH_ID,
      name: 'Bash',
      input: undefined,
      status: 'streaming-input',
    }
    expect(openAsks(viewOf(partial), [ask()]).map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('block 是 done 時濾掉', () => {
    const view = viewOf(toolBlock(BASH_ID, 'done'))
    expect(openAsks(view, [ask()])).toEqual([])
  })

  it('block 是 error 時濾掉（逾時被 deny 或執行失敗，主程序早就收掉了）', () => {
    const view = viewOf(toolBlock(BASH_ID, 'error'))
    expect(openAsks(view, [ask()])).toEqual([])
  })

  it('view 裡完全找不到那個 id 時留下（tool_use 快照還沒到）', () => {
    const view = viewOf(toolBlock('toolu_OTHER', 'running'))
    expect(openAsks(view, [ask()]).map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('混合：running／error／不存在，只剩第一與第三筆，順序不變', () => {
    const view: ConversationView = {
      turns: [
        {
          role: 'assistant',
          blocks: [toolBlock('t-running', 'running'), toolBlock('t-error', 'error')],
        },
      ],
      ended: false,
    }
    const pending = [
      ask({ requestId: 'r1', toolUseId: 't-running' }),
      ask({ requestId: 'r2', toolUseId: 't-error' }),
      ask({ requestId: 'r3', toolUseId: 't-missing' }),
    ]
    expect(openAsks(view, pending).map((a) => a.requestId)).toEqual(['r1', 'r3'])
  })
})
