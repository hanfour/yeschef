### Task 10: 工具批准卡片端到端

> **2026-09-02 晚間依裁決 28 修訂**
>
> `CanUseTool` 的 options 有必填的 `toolUseID`，裁決 11 的內容比對前提是錯的。`deepEqual` 與它的
> 那組測試整組刪除，四個出口改成比 `block.id === ask.toolUseId` 與 block 狀態。突變表重做。

批准請求走的是 `canUseTool` 加 IPC 那條管線，跟 SDK 的訊息流完全分開，所以 `fold()` 看不到它
（Task 4B 的設計判斷）。`awaiting-approval` 這個狀態的唯一來源因此是 UI 層。至於「哪個請求對應
畫面上哪一個 tool block」，裁決 28 已經定案：`ApprovalAskPayload` 帶 `toolUseId`，就是 SDK 給
`canUseTool` 的 `options.toolUseID`，跟 `Block.id`（來自 `content_block_start` 的 tool_use id）
是同一個值。本 task 把這條規則寫成三個純函式，加上一個訂閱 hook 與一張內嵌卡片，湊成規格 §6 要的
「批准內嵌在對話流，不用彈窗」。

**三條規則。**

1. `matchApproval(view, ask)`：回傳 `id === ask.toolUseId` 且狀態是 `running` 或 `streaming-input`
   的 tool block，找不到就是 `undefined`。
2. `findAskForBlock(block, pending)`：block 的狀態還開著（`running`／`streaming-input`／
   `awaiting-approval`）時回 `pending.find((a) => a.toolUseId === block.id)`，`denied`／`done`／
   `error` 一律 `undefined`。`applyPendingApprovals` 只標它命中的那些。
3. `unmatchedAsks(view, pending)`：回傳 view 裡完全找不到 `id === toolUseId` 的那些 ask。找得到
   但已經關閉的不算未對應，也不畫。

第 2 條的狀態集合比第 1 條多一個 `awaiting-approval`，這是刻意的：`applyPendingApprovals` 會把
命中的 block 標成 `awaiting-approval`，而 `renderToolExtra` 拿到的是標過的那份 view，若
`findAskForBlock` 不認 `awaiting-approval`，卡片會在標記生效的下一幀自己消失。換句話說，
`findAskForBlock` 的輸入是標過的 view，`matchApproval` 的輸入是 `fold()` 直接產出的 raw view，
兩者各有一條測試釘住。私有的 `matches(block, ask)` 因此拆成兩個小述詞（`isOpen` 與
`stillOpenForCard`），比對鍵仍然只有一份。

**ask 先到、block 後到仍然可能，那些請求要畫在對話尾端。** `canUseTool` 是 SDK 在決定要不要執行
工具時走 control 通道回呼的，tool block 的快照則是走每幀合併的事件通道，兩者到達 renderer 的
先後沒有保證。批准請求先到、`tool_use` 快照後到是正常情況，此時畫面上還沒有那個 id 的 block 可以
掛卡片。這種請求不能靜默丟棄（規格 §8）：使用者不回答，主程序那個 promise 就掛著，直到 Task 6 的
計時器逾時把它拒絕掉。所以 `unmatchedAsks` 把它們挑出來，`App` 畫在對話尾端。

**逾時被拒絕之後卡片要消失。** Task 6 的計時器逾時把請求 deny 掉時，主程序會推出
`permission-denied` 事件，`fold()` 把那個 block 推進到 `denied`。`findAskForBlock` 對已關閉的
block 回 `undefined`，卡片跟著消失；`unmatchedAsks` 也不會把它撿回對話尾端，因為 view 裡找得到
那個 id。使用者看到的可見記錄是 block 上的 `deniedReason`，不是一張按了沒反應的卡片。

實機驗證：本檔所有「已驗證」都指在 worktree（`git worktree add`，`npm install` 裝好 react 19.2.8
／@testing-library/react 16.3.3／jsdom 30.0.1）裡真的跑過 `npx tsc --noEmit` 與 `npx vitest run`。
測試數與突變結果見 Step 4、Step 5。

**Files:**
- Create: `src/renderer/approvals.ts`
- Create: `src/renderer/hooks/useApprovals.ts`
- Create: `src/renderer/components/ApprovalCard.tsx`
- Create: `src/renderer/components/ApprovalCard.css`
- Create: `tests/approvals.test.ts`
- Create: `tests/approval-card.test.tsx`
- Create: `tests/use-approvals.test.tsx`
- Modify: `src/renderer/App.tsx`（在 Task 9B 的版本上加三個插入點，並把 `Composer` 的 `disabled`
  接起來）
- Modify: `vitest.config.ts`（只加 coverage 的 `src/renderer/approvals.ts`。`test.include` 那一行
  由 Task 9 改一次成 `'tests/**/*.test.{ts,tsx}'`，接縫補記定 9B／10／11 不重複宣告，只在
  Step 2 確認）

**Interfaces:**
- Consumes:
  - `ApprovalAskPayload`（`requestId`／`toolUseId`／`toolName`／`input`／`title?`／`displayName?`，
    `toolUseId` 由裁決 28 加入）、`ApprovalDecision`、`YesChefApi`（裁決 14 定稿版）：
    `src/shared/ipc.ts`（Task 8）
  - `SessionState`：`src/shared/session-state.ts`（Task 5，裁決 14）
  - `ConversationView`／`Turn`／`Block`：`src/shared/fold.ts`（Task 4／4B）
  - `ToolBlock`、`Conversation`、`ConversationProps.renderToolExtra`：
    `src/renderer/components/Conversation.tsx`（Task 9B）
  - `useConversation(api): { view, sessionState }`：`src/renderer/hooks/useConversation.ts`（Task 9B）
- Produces:
  - `function matchApproval(view: ConversationView, ask: ApprovalAskPayload): ToolBlock | undefined`
  - `function findAskForBlock(block: ToolBlock, pending: readonly ApprovalAskPayload[]): ApprovalAskPayload | undefined`
  - `function applyPendingApprovals(view: ConversationView, pending: readonly ApprovalAskPayload[]): ConversationView`
  - `function unmatchedAsks(view: ConversationView, pending: readonly ApprovalAskPayload[]): readonly ApprovalAskPayload[]`
  - `interface Approvals { readonly pending: readonly ApprovalAskPayload[]; reply(requestId: string, decision: ApprovalDecision): void }`
  - `function useApprovals(api: YesChefApi): Approvals`
  - `interface ApprovalCardProps { readonly ask: ApprovalAskPayload; readonly onDecide: (requestId: string, decision: ApprovalDecision) => void; readonly unmatched?: boolean }`
  - `function ApprovalCard(props: ApprovalCardProps)`、`function formatToolInput(input: unknown): string`
  - `src/renderer/App.tsx` 的 `ComposerProps` 加一個 `readonly disabled?: boolean`（Task 9B 明文
    把「批准時輸入框停用」交棒給本 task，規格 §6）。`Composer` 不是匯出的元件，Task 11 不碰它，
    這一條只是記錄本 task 對 `App.tsx` 的第四處改動。

依賴順序：本 task 排在 Task 9B 之後（要 `Conversation` 的 `renderToolExtra` 接縫與
`useConversation`）。`App.tsx` 的演進順序是 9 → 9B → 10 → 11（接縫補記），本 task 給的完整檔案
就是 Task 9B 的版本加上自己的改動，Task 11 再在這份之上換掉側邊欄。回傳型別一律不標
`JSX.Element`，沿用 Task 9 的慣例。

- [ ] **Step 1a: 寫失敗的測試（純函式）**

`tests/approvals.test.ts`（Node 環境，不需要 jsdom）：

```typescript
import { describe, it, expect } from 'vitest'
import {
  applyPendingApprovals,
  findAskForBlock,
  matchApproval,
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
```

- [ ] **Step 1b: 寫失敗的測試（卡片）**

`tests/approval-card.test.tsx`。第一行的 `// @vitest-environment jsdom` 是 Vitest 官方的逐檔
覆寫語法，沿用 Task 9 的作法，不改 `vitest.config.ts` 的全域 environment：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard, formatToolInput } from '../src/renderer/components/ApprovalCard.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'

afterEach(cleanup)

const BASH_INPUT = {
  command: 'echo hello > cap.txt && ls -l cap.txt && cat cap.txt',
  description: 'Write hello to cap.txt and verify',
}

function ask(over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId: 'req-1',
    toolUseId: 'toolu_01L2YCZHqTvRDmdkNpsprfCQ',
    toolName: 'Bash',
    input: BASH_INPUT,
    ...over,
  }
}

describe('formatToolInput', () => {
  it('物件排版成多行 JSON', () => {
    expect(formatToolInput({ command: 'ls' })).toBe('{\n  "command": "ls"\n}')
  })

  it('字串原樣、undefined 有明確文案', () => {
    expect(formatToolInput('ls -l')).toBe('ls -l')
    expect(formatToolInput(undefined)).toBe('（沒有參數）')
  })

  it('有環的物件不丟錯（卡片一定要畫得出來）', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => formatToolInput(cyclic)).not.toThrow()
    expect(formatToolInput(cyclic)).toContain('object')
  })
})

describe('ApprovalCard 的文案', () => {
  it('有 title 時用 title，不自己拼 toolName 加 input', () => {
    render(<ApprovalCard ask={ask({ title: '要讓 Claude 執行這個指令嗎？' })} onDecide={vi.fn()} />)
    expect(screen.getByText('要讓 Claude 執行這個指令嗎？')).not.toBeNull()
    expect(screen.queryByText('Bash')).toBeNull()
  })

  it('沒有 title 時退回工具名稱加格式化的 input', () => {
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} />)
    expect(screen.getByText('Bash')).not.toBeNull()
    const card = screen.getByTestId('approval-card')
    expect(card.textContent).toContain('echo hello > cap.txt')
    expect(card.textContent).toContain('Write hello to cap.txt and verify')
  })

  it('title 是空字串時仍退回工具名稱加 input', () => {
    render(<ApprovalCard ask={ask({ title: '' })} onDecide={vi.fn()} />)
    expect(screen.getByText('Bash')).not.toBeNull()
  })

  it('有 displayName 時按鈕是「允許 {displayName}」，沒有就是「允許」', () => {
    const { unmount } = render(
      <ApprovalCard ask={ask({ displayName: '執行指令' })} onDecide={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: '允許 執行指令' })).not.toBeNull()
    unmount()
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: '允許' })).not.toBeNull()
  })

  it('未對應的請求多一段說明，一樣有兩個按鈕（規格 §8）', () => {
    render(<ApprovalCard ask={ask()} onDecide={vi.fn()} unmatched />)
    expect(screen.getByTestId('approval-card').textContent).toContain('還沒對應到畫面上的工具呼叫')
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})

describe('ApprovalCard 的回答', () => {
  it('點允許送 allow，點拒絕送 deny，兩者都帶 requestId', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-42' })} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: '允許' }))
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }))
    expect(onDecide.mock.calls).toEqual([
      ['req-42', 'allow'],
      ['req-42', 'deny'],
    ])
  })

  it('卡片有焦點時 y 允許、n 拒絕，大寫也算', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-7' })} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    expect(document.activeElement).toBe(card)
    fireEvent.keyDown(card, { key: 'y' })
    fireEvent.keyDown(card, { key: 'N' })
    expect(onDecide.mock.calls).toEqual([
      ['req-7', 'allow'],
      ['req-7', 'deny'],
    ])
  })

  it('焦點在卡片外的元素時，y／n 不生效', () => {
    const onDecide = vi.fn()
    render(
      <div>
        <input data-testid="outside" />
        <ApprovalCard ask={ask()} onDecide={onDecide} />
      </div>
    )
    const outside = screen.getByTestId('outside')
    outside.focus()
    expect(document.activeElement).toBe(outside)
    fireEvent.keyDown(outside, { key: 'y' })
    fireEvent.keyDown(document.body, { key: 'y' })
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('卡片裡的按鈕有焦點時 y／n 一樣生效（事件從子節點冒上來）', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask({ requestId: 'req-9' })} onDecide={onDecide} />)
    const allow = screen.getByRole('button', { name: '允許' })
    allow.focus()
    fireEvent.keyDown(allow, { key: 'y' })
    expect(onDecide.mock.calls).toEqual([['req-9', 'allow']])
  })

  it('帶修飾鍵的 y／n 不算（Cmd+Y 是系統快捷鍵）', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    fireEvent.keyDown(card, { key: 'y', metaKey: true })
    fireEvent.keyDown(card, { key: 'n', ctrlKey: true })
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('其他按鍵不觸發任何決定', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard ask={ask()} onDecide={onDecide} />)
    const card = screen.getByTestId('approval-card')
    card.focus()
    for (const key of ['a', 'Enter', 'Escape', ' ']) {
      fireEvent.keyDown(card, { key })
    }
    expect(onDecide).not.toHaveBeenCalled()
  })
})
```

「焦點在卡片外的元素時 y／n 不生效」這條是本檔最重要的一條：它擋的是「用
`document.addEventListener('keydown')` 做快捷鍵」那個看起來合理的寫法。那樣寫的話，使用者在
輸入框裡打一個 y 就把工具批准送出去了。Step 5 的突變 5 就是這個。

- [ ] **Step 1c: 寫失敗的測試（hook）**

`tests/use-approvals.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useApprovals } from '../src/renderer/hooks/useApprovals.js'
import { App } from '../src/renderer/App.js'
import type { ApprovalAskPayload, ApprovalReplyPayload, YesChefApi } from '../src/shared/ipc.js'
import type { SessionState } from '../src/shared/session-state.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * 假的 YesChefApi。preload 的真品要 Electron，這裡只需要「訂閱得到、送得出去」
 * 這兩件事，所以自己拿兩個 Set 當事件來源，順便可以斷言訂閱有沒有解除。
 */
function createFakeApi(): {
  readonly api: YesChefApi
  readonly replies: ApprovalReplyPayload[]
  emitAsk(ask: ApprovalAskPayload): void
  emitState(state: SessionState): void
  listenerCounts(): { ask: number; state: number }
} {
  const askListeners = new Set<(ask: ApprovalAskPayload) => void>()
  const stateListeners = new Set<(state: SessionState) => void>()
  const replies: ApprovalReplyPayload[] = []

  const api: YesChefApi = {
    onEvents: () => () => undefined,
    onApprovalAsk: (cb) => {
      askListeners.add(cb)
      return () => {
        askListeners.delete(cb)
      }
    },
    onSessionState: (cb) => {
      stateListeners.add(cb)
      return () => {
        stateListeners.delete(cb)
      }
    },
    sendInput: () => undefined,
    replyApproval: (reply) => {
      replies.push(reply)
    },
    listSessions: () => Promise.resolve([]),
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: '/Users/x/Projects/demo',
  }

  return {
    api,
    replies,
    emitAsk: (ask) => {
      act(() => {
        for (const l of askListeners) l(ask)
      })
    },
    emitState: (state) => {
      act(() => {
        for (const l of stateListeners) l(state)
      })
    },
    listenerCounts: () => ({ ask: askListeners.size, state: stateListeners.size }),
  }
}

function ask(requestId: string, over: Partial<ApprovalAskPayload> = {}): ApprovalAskPayload {
  return {
    requestId,
    toolUseId: `toolu_${requestId}`,
    toolName: 'Bash',
    input: { command: 'ls' },
    ...over,
  }
}

describe('useApprovals', () => {
  it('一開始沒有待決請求，且已經訂閱兩個頻道', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    expect(result.current.pending).toEqual([])
    expect(fake.listenerCounts()).toEqual({ ask: 1, state: 1 })
  })

  it('依到達順序累積，且每次都是新陣列（不就地 push）', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))

    fake.emitAsk(ask('req-1'))
    const afterFirst = result.current.pending
    fake.emitAsk(ask('req-2', { toolName: 'Write' }))

    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1', 'req-2'])
    expect(result.current.pending).not.toBe(afterFirst)
    expect(afterFirst.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('同一個 requestId 重送不會疊出第二張卡片', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-1'))
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('reply 把決定送給 main，並把那一筆從 pending 移除', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-2'))

    act(() => {
      result.current.reply('req-1', 'allow')
    })

    expect(fake.replies).toEqual([{ requestId: 'req-1', decision: 'allow' }])
    // 卡片按了就要消失：這條是「按了沒反應」那個 bug 的守門員。
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-2'])
  })

  it('reply 只移除指定的那一筆，deny 一樣送得出去', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitAsk(ask('req-2'))
    fake.emitAsk(ask('req-3'))

    act(() => {
      result.current.reply('req-2', 'deny')
    })

    expect(fake.replies).toEqual([{ requestId: 'req-2', decision: 'deny' }])
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1', 'req-3'])
  })

  it('回覆一個不存在的 requestId 不影響 pending，但仍然送出去', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))

    act(() => {
      result.current.reply('req-does-not-exist', 'deny')
    })

    expect(fake.replies).toHaveLength(1)
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('session 狀態離開 live 就清空 pending（main 側已 denyAll）', () => {
    for (const state of [
      { kind: 'idle' } as const,
      { kind: 'viewing', sessionId: 's-1' } as const,
    ]) {
      const fake = createFakeApi()
      const { result, unmount } = renderHook(() => useApprovals(fake.api))
      fake.emitAsk(ask('req-1'))
      expect(result.current.pending).toHaveLength(1)

      fake.emitState(state)

      expect(result.current.pending).toEqual([])
      expect(fake.replies).toEqual([]) // 清空不等於代替使用者回答
      unmount()
    }
  })

  it('狀態還是 live 時不清空', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitState({ kind: 'live', sessionId: 's-1' })
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-1'])
  })

  it('清空之後新的請求照樣收得到', () => {
    const fake = createFakeApi()
    const { result } = renderHook(() => useApprovals(fake.api))
    fake.emitAsk(ask('req-1'))
    fake.emitState({ kind: 'idle' })
    fake.emitAsk(ask('req-2'))
    expect(result.current.pending.map((a) => a.requestId)).toEqual(['req-2'])
  })

  it('卸載時兩個訂閱都解除', () => {
    const fake = createFakeApi()
    const { unmount } = renderHook(() => useApprovals(fake.api))
    expect(fake.listenerCounts()).toEqual({ ask: 1, state: 1 })
    unmount()
    expect(fake.listenerCounts()).toEqual({ ask: 0, state: 0 })
  })
})

describe('App 與批准的接線', () => {
  /**
   * 規格 §6「批准時輸入框停用」。Task 9B 的 Composer 留了 disabled 這個 prop
   * 沒有接，本 task 接上：pending 非空就停用，pending 清空就恢復。
   *
   * 這條放在本檔而不是另開一個 App 測試檔：要斷言的東西完全由 useApprovals 的
   * pending 決定，跟這裡既有的假 api 是同一套裝置。
   */
  it('有待決請求時輸入框與送出鍵都停用，請求清掉之後恢復', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    const send = container.querySelector('.composer-send')
    if (input === null || send === null) throw new Error('找不到輸入框或送出鍵')

    expect(input.disabled).toBe(false)
    expect((send as HTMLButtonElement).disabled).toBe(false)

    fake.emitAsk(ask('req-1'))
    expect(input.disabled).toBe(true)
    expect((send as HTMLButtonElement).disabled).toBe(true)

    // 離開 live 會清空 pending（main 側已 denyAll），輸入框跟著恢復。
    fake.emitState({ kind: 'idle' })
    expect(input.disabled).toBe(false)
    expect((send as HTMLButtonElement).disabled).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test tests/approvals.test.ts tests/approval-card.test.tsx tests/use-approvals.test.tsx
```

Expected: FAIL。三個檔案都無法解析 `../src/renderer/approvals.js`、
`../src/renderer/components/ApprovalCard.js`、`../src/renderer/hooks/useApprovals.js`（都還不存在）。

**兩個 `.tsx` 檔在改設定前根本不會被收集**（已實測）。`vitest.config.ts` 現行的
`include: ['tests/**/*.test.ts']` 不涵蓋 `.test.tsx`，即使在指令列指定檔名也一樣，Vitest 只會回：

```
No test files found, exiting with code 1

filter: tests/approval-card.test.tsx
include: tests/**/*.test.ts
```

Task 9 已經把 `include` 改成 `'tests/**/*.test.{ts,tsx}'`（接縫補記：這件事只做一次）。開工前
先確認那一行真的在，不在就先補上，本 task 的兩個 `.tsx` 測試檔才收得進來。這條同樣影響 Task 9
的 `tests/markdown-component.test.tsx`，見文末的「跨 task 發現」。

- [ ] **Step 3a: 最小實作（設定與純函式）**

`vitest.config.ts` 只動 coverage 那一段（裁決 19：只用 diff 加自己的檔案，不重寫整份清單。`test.include` 由 Task 9 負責，本 task 不碰）：

```diff
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/renderer/approvals.ts',
       ],
     },
```

coverage 只加 `approvals.ts`：hook 與元件要 jsdom 與 React 才跑得起來，跟既有 coverage 清單
（全是純函式模組）不同性質，維持清單只放純函式的慣例。

`src/renderer/approvals.ts`：

```typescript
/**
 * 批准請求與 tool block 的對應（裁決 28）。全部是純函式，不碰 React 也不碰 IPC。
 *
 * 對應的鍵是 tool_use id：`ApprovalAskPayload.toolUseId` 來自 SDK 給 `canUseTool`
 * 的 `options.toolUseID`，`Block.id` 來自同一顆 tool_use 的快照，兩者是同一個值。
 */
import type { ApprovalAskPayload } from '../shared/ipc.js'
import type { ConversationView, Turn } from '../shared/fold.js'
import type { ToolBlock } from './components/Conversation.js'

/**
 * 工具還在跑，還沒有任何了結：這種 block 才是批准請求該找的目標。
 * `streaming-input` 也算，因為批准請求可能比 tool_use 的完整快照先到。
 */
function isOpen(block: ToolBlock): boolean {
  return block.status === 'running' || block.status === 'streaming-input'
}

/**
 * 這個 block 底下還要不要繼續畫卡片。比 `isOpen` 多一個 `awaiting-approval`：
 * 那個狀態是 `applyPendingApprovals` 自己標上去的，而 `renderToolExtra` 拿到的
 * 正是標過的 view，這裡若不認它，卡片會在標記生效的下一幀自己消失。
 *
 * `denied`／`done`／`error` 一律不畫：Task 6 的計時器逾時把請求 deny 掉之後，
 * 主程序會推 `permission-denied`，block 進到 `denied`，卡片跟著收掉，可見記錄
 * 換成 block 上的 `deniedReason`（規格 §8 要的是「有東西可看」，不是「卡片留著」）。
 */
function stillOpenForCard(block: ToolBlock): boolean {
  return isOpen(block) || block.status === 'awaiting-approval'
}

function toolBlocksOf(turns: readonly Turn[]): readonly ToolBlock[] {
  return turns.flatMap((turn) => turn.blocks.filter((b): b is ToolBlock => b.kind === 'tool'))
}

/**
 * 這筆請求對應到哪個 block。輸入是 `fold()` 直接產出的 raw view，所以狀態只認
 * `running` 與 `streaming-input`（`awaiting-approval` 在那份資料裡不會出現）。
 */
export function matchApproval(
  view: ConversationView,
  ask: ApprovalAskPayload
): ToolBlock | undefined {
  return toolBlocksOf(view.turns).find((block) => block.id === ask.toolUseId && isOpen(block))
}

/**
 * 這個 block 底下要畫哪一筆請求的卡片。輸入是 `applyPendingApprovals` 標過的 view。
 * id 是一對一的，`find` 命中就只有那一筆。
 */
export function findAskForBlock(
  block: ToolBlock,
  pending: readonly ApprovalAskPayload[]
): ApprovalAskPayload | undefined {
  if (!stillOpenForCard(block)) return undefined
  return pending.find((ask) => ask.toolUseId === block.id)
}

/**
 * 把命中的 tool block 的狀態改成 `awaiting-approval`，其餘原樣。
 *
 * `fold()` 永遠不產生這個狀態（Task 4B 的設計判斷：批准走 canUseTool 那條管線，
 * 事件流裡看不到），所以這一層是它唯一的來源。
 *
 * 沒有任何 block 被改到時回傳**原本那個 view 物件**，不是內容相同的新物件：
 * 下游元件會用 `React.memo` 的淺比較擋重繪（裁決 10 同一個理由），每幀無條件
 * 造新物件等於讓那層比較永遠不成立。
 */
export function applyPendingApprovals(
  view: ConversationView,
  pending: readonly ApprovalAskPayload[]
): ConversationView {
  if (pending.length === 0) return view

  let viewChanged = false
  const turns = view.turns.map((turn) => {
    let turnChanged = false
    const blocks = turn.blocks.map((block) => {
      if (block.kind !== 'tool') return block
      if (findAskForBlock(block, pending) === undefined) return block
      if (block.status === 'awaiting-approval') return block
      turnChanged = true
      return { ...block, status: 'awaiting-approval' as const }
    })
    if (!turnChanged) return turn
    viewChanged = true
    return { ...turn, blocks }
  })

  return viewChanged ? { ...view, turns } : view
}

/**
 * view 裡完全找不到那個 id 的請求，要渲染在對話尾端（規格 §8：不得靜默丟棄）。
 * 來源是 `canUseTool` 早於 tool_use 快照到達，對應的 block 還沒進畫面。
 *
 * 判準只看 id 在不在，不看狀態：id 找得到但 block 已經關閉（逾時被 deny、
 * 執行完畢）的那些，卡片本來就該收掉，不能再從對話尾端冒出來一次。
 */
export function unmatchedAsks(
  view: ConversationView,
  pending: readonly ApprovalAskPayload[]
): readonly ApprovalAskPayload[] {
  if (pending.length === 0) return pending
  const ids = new Set(toolBlocksOf(view.turns).map((block) => block.id))
  return pending.filter((ask) => !ids.has(ask.toolUseId))
}
```

`ToolBlock` 從 Task 9B 的 `Conversation.tsx` 匯入，不在這裡重宣告一份。這是 `import type`，
編譯後整行消失，純函式模組在執行期不會因此相依 React。

- [ ] **Step 3b: 最小實作（卡片）**

`src/renderer/components/ApprovalCard.tsx`：

```tsx
import type { KeyboardEvent } from 'react'
import type { ApprovalAskPayload, ApprovalDecision } from '../../shared/ipc.js'
import './ApprovalCard.css'

export interface ApprovalCardProps {
  readonly ask: ApprovalAskPayload
  readonly onDecide: (requestId: string, decision: ApprovalDecision) => void
  /** 這筆請求沒有對應到任何 tool block，卡片畫在對話尾端（規格 §8）。 */
  readonly unmatched?: boolean
}

function isNonEmpty(v: string | undefined): v is string {
  return v !== undefined && v !== ''
}

/**
 * 把 input 變成看得懂的字。JSON.stringify 對 undefined 回傳 undefined、
 * 對有環的物件會丟錯，兩種都退回 String()：批准卡片的內容再怎麼難看都必須
 * 畫得出來，這裡丟錯等於使用者連拒絕的按鈕都看不到。
 */
export function formatToolInput(input: unknown): string {
  if (input === undefined) return '（沒有參數）'
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}

/**
 * 內嵌在對話流裡的批准卡片（規格 §6：不用彈窗）。
 *
 * 文案優先用 `ask.title`：那是 SDK 產的完整提示句，SDK 的註解明說不要自己
 * 從 toolName 加 input 重建（裁決 28 保留了裁決 11 的這一條）。沒有 title 才退回
 * 工具名稱加 input。`toolUseId` 只用來對應 block，不畫在卡片上。
 *
 * y／n 快捷鍵掛在卡片根節點的 onKeyDown 上，不是 document 上。React 的合成
 * 事件只會在事件目標落在這棵子樹裡時觸發，所以「卡片（或卡片裡的按鈕）有焦點」
 * 這個條件是結構本身保證的，不必自己比對 document.activeElement。掛 document
 * 會讓使用者在輸入框裡打 y 就送出批准。
 */
export function ApprovalCard({ ask, onDecide, unmatched = false }: ApprovalCardProps) {
  const allowLabel = isNonEmpty(ask.displayName) ? `允許 ${ask.displayName}` : '允許'

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // 有修飾鍵時放行：Cmd+Y／Ctrl+N 是瀏覽器與系統的快捷鍵，不是我們的。
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key !== 'y' && key !== 'n') return
    event.preventDefault()
    onDecide(ask.requestId, key === 'y' ? 'allow' : 'deny')
  }

  return (
    <div
      className={unmatched ? 'approval-card approval-card--unmatched' : 'approval-card'}
      role="group"
      aria-label="工具批准請求"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-testid="approval-card"
      data-request-id={ask.requestId}
    >
      {unmatched ? (
        <p className="approval-card__notice">
          這個請求還沒對應到畫面上的工具呼叫，回答它之後對話才會繼續。
        </p>
      ) : null}

      {isNonEmpty(ask.title) ? (
        <p className="approval-card__prompt">{ask.title}</p>
      ) : (
        <div className="approval-card__prompt">
          <p className="approval-card__tool">{ask.toolName}</p>
          <pre className="approval-card__input">{formatToolInput(ask.input)}</pre>
        </div>
      )}

      <div className="approval-card__actions">
        <button type="button" onClick={() => onDecide(ask.requestId, 'allow')}>
          {allowLabel}
        </button>
        <button type="button" onClick={() => onDecide(ask.requestId, 'deny')}>
          拒絕
        </button>
      </div>

      <p className="approval-card__hint">卡片有焦點時：y 允許、n 拒絕</p>
    </div>
  )
}
```

`src/renderer/components/ApprovalCard.css`：

```css
.approval-card {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid #7a6a2a;
  border-left-width: 3px;
  border-radius: 4px;
  background: #1c1a10;
}

.approval-card:focus {
  outline: 1px solid #c9b458;
  outline-offset: 1px;
}

.approval-card--unmatched {
  border-color: #8a4a2a;
}

.approval-card__notice {
  margin: 0 0 6px;
  color: #e0a37a;
}

.approval-card__prompt {
  margin: 0 0 8px;
}

.approval-card__tool {
  margin: 0 0 4px;
  font-weight: 600;
}

.approval-card__input {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

.approval-card__actions {
  display: flex;
  gap: 8px;
}

.approval-card__actions button {
  padding: 4px 12px;
  border: 1px solid #4a4d40;
  border-radius: 3px;
  background: #23261c;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.approval-card__actions button:hover {
  background: #2d3124;
}

.approval-card__hint {
  margin: 6px 0 0;
  font-size: 0.85em;
  opacity: 0.6;
}

/* 對話尾端那一串「未對應」的請求。 */
.approval-tail {
  padding: 0 12px 12px;
}
```

卡片根節點的 `tabIndex={0}` 讓它自己可以被 Tab 選到，快捷鍵才有「取得焦點」這件事可言。不做
自動搶焦點：一次可能有多張卡片，搶焦點會讓捲軸跳動，也讓「哪一張會吃到 y」變得不可預期。

- [ ] **Step 3c: 最小實作（hook 與 App 的三個插入點）**

`src/renderer/hooks/useApprovals.ts`：

```typescript
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApprovalAskPayload, ApprovalDecision, YesChefApi } from '../../shared/ipc.js'

export interface Approvals {
  readonly pending: readonly ApprovalAskPayload[]
  reply(requestId: string, decision: ApprovalDecision): void
}

/**
 * 待回答的批准請求。
 *
 * 兩個訂閱：
 * - `onApprovalAsk`：到達順序累積，不可變地換新陣列
 * - `onSessionState`：狀態離開 `live` 就清空
 *
 * 清空只是「不再顯示」，不是「代替使用者回答」。切換 session 時 main 側的
 * 狀態機第一步就是 `registry.denyAll()`（Task 5 的收尾三步、Task 6 的註冊表），
 * 那些 promise 在主程序已經以 deny 了結，renderer 這邊再送一次回覆只會撞到
 * 一個不存在的 requestId。
 */
export function useApprovals(api: YesChefApi): Approvals {
  const [pending, setPending] = useState<readonly ApprovalAskPayload[]>([])

  useEffect(
    () =>
      api.onApprovalAsk((ask) => {
        setPending((prev) =>
          // 同一個 requestId 重送（例如 main 重試）不疊第二張卡片。
          prev.some((p) => p.requestId === ask.requestId) ? prev : [...prev, ask]
        )
      }),
    [api]
  )

  useEffect(
    () =>
      api.onSessionState((state) => {
        if (state.kind !== 'live') setPending([])
      }),
    [api]
  )

  const reply = useCallback(
    (requestId: string, decision: ApprovalDecision): void => {
      api.replyApproval({ requestId, decision })
      setPending((prev) => prev.filter((p) => p.requestId !== requestId))
    },
    [api]
  )

  return useMemo(() => ({ pending, reply }), [pending, reply])
}
```

`src/renderer/App.tsx`（在 Task 9B 的 3h 版本上加四處；下面是加完之後的完整檔案，逐字取代原檔。
`Composer`／`placeholderFor`／兩個 placeholder 常數／`<aside>` 佔位全部逐字保留 9B 的樣子，
側邊欄那一段是 Task 11 的位置，本 task 不動它的內容）：

```tsx
import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Conversation, type ToolBlock } from './components/Conversation.js'
import { ApprovalCard } from './components/ApprovalCard.js'
import { useConversation } from './hooks/useConversation.js'
import { useApprovals } from './hooks/useApprovals.js'
import { applyPendingApprovals, findAskForBlock, unmatchedAsks } from './approvals.js'
import type { SessionState } from '../shared/session-state.js'
import './App.css'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly onSend: (text: string) => void
  /** 有待決的批准請求時停用（規格 §6）。Task 9B 把這個 prop 留給 Task 10 接上。 */
  readonly disabled?: boolean
}

function Composer({ placeholder, onSend, disabled = false }: ComposerProps) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        className="composer-input"
        aria-label="輸入訊息"
        rows={3}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="composer-send" disabled={disabled}>
        送出
      </button>
    </form>
  )
}

function placeholderFor(state: SessionState): string {
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

/**
 * 「左＋中」這一個 React renderer（規格 §3，裁決 9）。右窗格是獨立的
 * WebContentsView，由主程序疊在視窗上，不在這棵 tree 裡。
 *
 * 批准的三個插入點（Task 10）：
 * 1. `applyPendingApprovals`：把命中的 tool block 標成 awaiting-approval
 * 2. `renderToolExtra`：把卡片畫進對應的 ToolCall 底部
 * 3. `unmatchedAsks`：對應不到 block 的請求畫在對話尾端，不靜默丟棄
 * 4. `Composer` 的 `disabled`：有待決請求時輸入框停用（規格 §6，9B 交棒）
 *
 * 第 2 點的命中查找一定要走 `findAskForBlock`，不能在這裡重寫一次比對：
 * 兩份比對邏輯遲早會漂移成「狀態標在 A、卡片畫在 B」。
 */
export function App() {
  const api = window.yeschef
  const { view: rawView, sessionState } = useConversation(api)
  const { pending, reply } = useApprovals(api)

  const view = useMemo(() => applyPendingApprovals(rawView, pending), [rawView, pending])
  const orphans = useMemo(() => unmatchedAsks(view, pending), [view, pending])

  const renderToolExtra = useCallback(
    (block: ToolBlock) => {
      const ask = findAskForBlock(block, pending)
      return ask === undefined ? null : <ApprovalCard ask={ask} onDecide={reply} />
    },
    [pending, reply]
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <p className="placeholder">Recents（Task 11）</p>
      </aside>
      <main className="conversation">
        <Conversation
          view={view}
          historical={sessionState.kind === 'viewing'}
          renderToolExtra={renderToolExtra}
        />
        {orphans.length > 0 ? (
          <div className="approval-tail">
            {orphans.map((ask) => (
              <ApprovalCard key={ask.requestId} ask={ask} onDecide={reply} unmatched />
            ))}
          </div>
        ) : null}
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => api.sendInput(text)}
          disabled={pending.length > 0}
        />
      </main>
    </div>
  )
}
```

`orphans` 算在 `view`（已套過 `applyPendingApprovals`）上而不是 `rawView` 上，兩者結果相同：
`awaiting-approval` 不在「已了結」那三個狀態裡，套過之後仍然命中。用 `view` 是因為那是畫面上
真的渲染的那份資料，算「誰沒被畫出來」就該對著它算。

跟 9B 的差別只有四處：檔首多四個 import、`ComposerProps` 多一個 `disabled?: boolean`（`textarea`
與送出鍵都吃它）、`App` 內多三行 hook 與 memo、`<main>` 裡多了 `renderToolExtra`／尾端卡片／
`disabled` 這三個接點。`onSend` 從 9B 的 `window.yeschef.sendInput(text)` 改成 `api.sendInput(text)`：
`api` 就是同一個 `window.yeschef`，本 task 已經把它取成區域常數，兩處用法不該分歧。

`Composer` 內部不再多寫一個「`disabled` 時 `submit()` 直接 return」的守衛：停用的 `textarea` 不會
發 keydown，停用的按鈕也不會送出 form，多那一行是在防一個 DOM 不允許發生的事。

- [ ] **Step 4: 跑測試確認通過**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` 無輸出；本 task 三個檔案 51 個測試全綠（`approvals` 26、`approval-card` 14、
`use-approvals` 11）。實跑輸出：

```
 Test Files  3 passed (3)
      Tests  51 passed (51)
```

全專案的總數要看當下材料化了哪些上游 task。2026-09-02 晚間依裁決 28 修訂後的驗證 worktree
（材料化 Task 3／4／4B／5／8 的 shared 型別與 `global.d.ts`、Task 9／9B／10 的程式碼與測試，
加上 repo 既有的 `cdp`／`layout`／`measure-memory`／`spawn-args` 四個測試檔）跑出來是：

```
 Test Files  9 passed (9)
      Tests  139 passed (139)
```

`npx tsc --noEmit -p .` 退出碼 0。`npx vitest run --coverage tests/approvals.test.ts` 量到
`src/renderer/approvals.ts` 的 % Stmts 97.22、% Branch 95.45，唯一沒走到的是
`unmatchedAsks` 的 `pending.length === 0` 提早返回。

- [ ] **Step 5: 突變測試**

七個突變全部在 worktree 實跑過：改壞、跑紅、還原、回綠。指令一律是
`npx vitest run tests/approvals.test.ts tests/approval-card.test.tsx tests/use-approvals.test.tsx`
（51 個測試）。

**突變 1：`matchApproval` 忽略狀態（已 denied 的 block 也命中）。**

```typescript
export function matchApproval(
  view: ConversationView,
  ask: ApprovalAskPayload
): ToolBlock | undefined {
  return toolBlocksOf(view.turns).find((block) => block.id === ask.toolUseId)
}
```

```
× 狀態是 denied／done／error 的 block 不命中
× 已經標成 awaiting-approval 的 block 不命中
Tests  2 failed | 49 passed (51)
```

實際後果：逾時被 deny 之後那個 id 還在 view 裡，`matchApproval` 照樣回傳它，呼叫端會以為
那筆請求還等得到回答。

**突變 2：`unmatchedAsks` 改用 `findAskForBlock` 判斷（已關閉的 block 上的 ask 被算成未對應）。**

```typescript
  const shown = new Set<string>()
  for (const block of toolBlocksOf(view.turns)) {
    const found = findAskForBlock(block, pending)
    if (found !== undefined) shown.add(found.requestId)
  }
  return pending.filter((ask) => !shown.has(ask.requestId))
```

```
× block 已 denied 時那筆 ask 不算未對應
× block 已 done 或 error 時那筆 ask 一樣不算未對應
Tests  2 failed | 49 passed (51)
```

這是最像正確答案的一個突變：讀起來完全合理，一般情況也對。錯的是逾時那條路：main 已經
deny 了，block 進到 `denied`，卡片本來就該收掉，這個版本卻把同一筆請求從對話尾端又畫一次，
使用者按下去只會在主程序 log 一句「找不到 requestId」。

**突變 3：`findAskForBlock` 忽略狀態（拿掉 `stillOpenForCard` 那一行）。**

```
× block 已 denied 時回 undefined（逾時被拒絕後卡片跟著消失）
× block 已 done 或 error 時回 undefined
× 已經 denied 的 block 不會被標成 awaiting-approval
Tests  3 failed | 48 passed (51)
```

第三條是 `applyPendingApprovals` 的連帶後果：它只標 `findAskForBlock` 命中的 block，判準一鬆，
已經拒絕的工具會被改回「等待批准」。

**突變 4：`findAskForBlock` 的狀態集合少了 `awaiting-approval`（`stillOpenForCard` 換成 `isOpen`）。**

```
× awaiting-approval 的 block 仍然找得到那筆請求
Tests  1 failed | 50 passed (51)
```

只有一條紅，但那一條就是這個設計的關鍵：`applyPendingApprovals` 標完之後 `renderToolExtra`
拿到的是標過的 view，判準若跟 `matchApproval` 完全一樣，卡片會在標記生效的下一幀自己消失。

**突變 5：`useApprovals.reply` 不從 pending 移除。**

```typescript
const reply = useCallback(
  (requestId: string, decision: ApprovalDecision): void => {
    api.replyApproval({ requestId, decision })
  },
  [api]
)
```

```
× reply 把決定送給 main，並把那一筆從 pending 移除
× reply 只移除指定的那一筆，deny 一樣送得出去
Tests  2 failed | 49 passed (51)
```

實際後果就是「按了允許，卡片還在那裡」。

**突變 6：y／n 改成 `document` 全域監聽。**

```tsx
useEffect(() => {
  const handler = (event: globalThis.KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key !== 'y' && key !== 'n') return
    event.preventDefault()
    onDecide(ask.requestId, key === 'y' ? 'allow' : 'deny')
  }
  document.addEventListener('keydown', handler)
  return () => document.removeEventListener('keydown', handler)
})
```

```
× 焦點在卡片外的元素時，y／n 不生效
Tests  1 failed | 50 passed (51)
```

只有一條紅，但那一條就是規格要的行為：快捷鍵只在卡片取得焦點時生效。其餘的（含「卡片有
焦點時 y 允許」）在這個錯誤實作下照樣全綠，這正是為什麼那條否定式測試不能省。

**突變 7：`App` 不把 `disabled` 傳給 `Composer`（`Composer` 的 prop 與預設值都留著）。**

```tsx
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => api.sendInput(text)}
        />
```

```
 × 有待決請求時輸入框與送出鍵都停用，請求清掉之後恢復 14ms
AssertionError: expected false to be true // Object.is equality
 Tests  1 failed | 50 passed (51)
```

這個突變值得特別列：`Composer` 那一半（prop 宣告、`textarea` 與按鈕的 `disabled={disabled}`）
全部留著，`tsc` 也過得了，因為 `disabled?` 是選填的。錯的只是 App 忘了接。整份計畫裡唯一會
發現這件事的就是這條測試，所以它不能省。

七個突變逐一還原後都跑回全綠，全專案重跑：

```
 Test Files  9 passed (9)
      Tests  139 passed (139)
```

- [ ] **Step 6: 提交**

```bash
git add src/renderer/approvals.ts \
        src/renderer/hooks/useApprovals.ts \
        src/renderer/components/ApprovalCard.tsx \
        src/renderer/components/ApprovalCard.css \
        src/renderer/App.tsx \
        tests/approvals.test.ts \
        tests/approval-card.test.tsx \
        tests/use-approvals.test.tsx \
        vitest.config.ts
git commit -m "feat: 工具批准卡片端到端（toolUseId 比對、未對應請求不丟棄）"
```

## 跨 task 發現：`.test.tsx` 現在不會被 Vitest 收集

`vitest.config.ts` 的 `include: ['tests/**/*.test.ts']` 不涵蓋 `.test.tsx`，指令列指定檔名也
救不了（檔名過濾是在 `include` 找到的檔案裡篩）。實測輸出見 Step 2。

這條不只影響本 task：Task 9 建立的 `tests/markdown-component.test.tsx` 在現行設定下同樣一個
測試都不會跑，而 Task 9 的 Step 4 寫著跑過 `npm test tests/markdown-component.test.tsx`。
接縫補記已把這行的歸屬定給 Task 9（改成 `'tests/**/*.test.{ts,tsx}'`，只做一次），本 task 與
9B／11 只在 Step 2 確認。建議控制端順手確認 Task 9 的 9 個測試在補上這行之後是不是真的全綠。

## 手動檢查清單（Electron 裡才驗得到的部分）

自動測試涵蓋不到 preload 與真實 IPC，下面五項在 `npm run dev` 裡人工確認：

1. 一個需要批准的工具（例如 Bash）跑起來時，卡片出現在該工具呼叫的正下方，不是彈窗
2. 按「允許」後卡片消失、工具繼續執行；按「拒絕」後工具不執行，對話裡留下拒絕的記錄
3. 卡片點一下取得焦點後按 y／n 有效；焦點在輸入框時打 y 不會誤送
4. 卡片還在時輸入框停用、按下允許或拒絕之後恢復（規格 §6；`disabled` 的接線在本 task，
   Step 1c 有自動測試，這裡確認真實 Electron 裡也是同一個行為）
5. 批准出現時切換到另一條歷史對話：卡片消失，且主程序沒有留下掛著的 promise
   （Task 6 的 `denyAll` 已處理，看 log 確認）

## 契約疑慮

1. **`findAskForBlock` 認 `awaiting-approval`，`matchApproval` 不認，兩者的狀態集合不同。**
   裁決 28 對兩個函式都只寫了 `running`／`streaming-input`，但 `applyPendingApprovals` 會把命中的
   block 標成 `awaiting-approval`，而 `renderToolExtra` 讀的正是標過的那份 view。若 `findAskForBlock`
   照字面只認兩個狀態，卡片會在標記生效的下一幀消失。本 task 依裁決 28 括號裡「請自己決定輸入是
   raw view 還是標過的 view」那一句，選了「`findAskForBlock` 吃標過的 view，狀態集合多一個
   `awaiting-approval`；`matchApproval` 吃 raw view，維持兩個狀態」，兩邊各有一條測試與一個突變
   （突變 4、突變 1）。若控制端要改成兩者一致，改的是 `stillOpenForCard` 與那兩條測試。

2. **契約的 renderer 元件介面沒有 `findAskForBlock` 與 `unmatchedAsks`。** 裁決 28 的內文已經定義了
   這兩個函式的行為，但契約「renderer 元件介面」那一節的簽章清單裡仍然只有 `matchApproval` 與
   `applyPendingApprovals`。建議把兩行補進去，讓 Task 12 的驗收知道有這兩個出口。

3. **`App.tsx` 的三方修改已依接縫補記定序，不再是疑慮。** CONTRACT.md 的接縫補記
   （2026-09-02）把演進順序定成 9 → 9B → 10 → 11，並要求每個 task 給的完整檔案必須是前一個
   task 的檔案加上自己的改動。本 task 已照辦：上面 Step 3c 的完整檔案就是 Task 9B Step 3h
   那一份，加上四處改動（三個批准插入點與 `Composer` 的 `disabled`），`Composer`／
   `placeholderFor`／兩個 placeholder 常數／`<aside>` 佔位逐字保留。Task 11 再在這一份之上把
   `<aside>` 換成 `<Recents>`。「誰後做誰負責合併」的寫法補記已明文不接受，本檔不再出現。

4. **`useApprovals` 只在收到非 `live` 的 `SessionState` 時清空 pending，掛載時不清。** 掛載
   當下還沒收到任何狀態推送，此時清空與不清空沒有差別（pending 本來就是空的）；但如果之後
   Task 8 改成掛載時不推初始狀態，而 renderer 又是在 live 中途重新載入的，pending 會是空的、
   舊請求也收不到，這種情況只能靠 main 側重送。目前不處理，記一筆。

