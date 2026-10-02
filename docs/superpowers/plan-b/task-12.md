### Task 12: HandoffCard 與 renderToolOverride

`request_handoff` 的卡片跟其他七個工具不一樣：它不是「看模型做了什麼」，而是「使用者現在要動手」。
預設的 `ToolCall` 只有標頭加可展開的參數與結果，畫不出按鈕，也畫不出「已等待 3 分鐘」。裁決 2 選了
最小的接法：`fold.ts` 不動、不新增 Block 種類，改在 `Turn` 加一個 `renderToolOverride`，由 `App`
依 `block.name === REQUEST_HANDOFF_TOOL` 決定要不要整張換掉。`ToolBlock` 已經有 `id`／`name`／
`input`／`result`／`status`／`deniedReason`，畫一張交接卡需要的東西一個都不缺。

`renderToolOverride` 與既有的 `renderToolExtra` 是兩種不同的東西，不能合成一個：`renderToolExtra`
是「在預設卡片底下再加一塊」（批准卡走這條），`renderToolOverride` 是「這張卡我自己畫」。回傳
`undefined` 就是「這個工具沒有專用卡」，走回預設的 `ToolCall`；判斷要看**回傳值**而不是「有沒有給
這個 callback」，否則 App 一掛上 callback，所有工具的卡片就全部消失。

卡片的六種樣貌先併成一個 `Phase`（`preparing`／`pending`／`stale`／`done`／`error`／`denied`），
之後每一塊內容只問 `phase` 一次。直接在 JSX 裡到處寫 `status === 'running' && !historical` 的話，
同一組布林運算會重複五次，改一次規則要改五個地方。契約 §12 只給四個 class modifier，所以
`preparing` 與 `pending` 共用 `--pending`、`denied` 與 `error` 共用 `--error`（依裁決 25）。

「已等待」有三個坑，都實測過。第一，起算點 `mountedAt` 要用惰性初始值取一次，每次重畫重取的話
永遠停在「不到 1 分鐘」。第二，重算間隔是 30 秒（`formatElapsed` 的最小刻度是一分鐘，30 秒讓跨分鐘
那一刻最多晚半分鐘才顯示），計時器只在 `pending` 排：歷史對話的交接不會有下文，繼續數秒數是騙人，
還會在使用者翻舊對話時留一堆醒著的 interval。第三，`now` 放進 ref 再讀，呼叫端每次重畫給一個新函式
時 interval 不會被拆掉重排，否則永遠等不到第一次到期。

「按兩次只送一次」原本寫成 `if (notified) return` 加 `disabled={notified}`，突變測試當場拆穿：
拿掉那行 guard 測試照樣全綠（見 Step 13 的突變 2）。原因有兩層，jsdom 對停用的按鈕根本不發第二個
click，而同一個批次裡的第二次點擊讀到的 `notified` 還是這一輪 render 的 `false`。改成 ref 記旗標，
測試改用同一個 `act` 內連發兩個 `MouseEvent`，這才是真的在測那件事。

**Files:**
- Create `src/renderer/components/HandoffCard.tsx`（169 行）
- Create `src/renderer/components/HandoffCard.css`（74 行）
- Modify `src/renderer/components/Turn.tsx`
  - 第 1 行 import 加 `Fragment`
  - 第 11 行後（`renderToolExtra` 之後）加 `renderToolOverride?`，並在 `TurnProps` 之後加 `RenderOptions`
  - 第 33-38 行 `renderBlock` 簽章改成收 `opts: RenderOptions`
  - 第 44-52 行 `case 'tool'` 改成先問 override
  - 第 60 行 `TurnImpl` 解構加 `renderToolOverride`、組出 `opts`
  - 第 65 行 `renderBlock` 呼叫改成傳 `opts`
  - 第 75 行後 memo 比較函式加 `renderToolOverride` 參考相等
- Modify `src/renderer/components/Conversation.tsx`
  - 第 20 行後（`ConversationProps.renderToolExtra` 之後）加 `renderToolOverride?`
  - 第 23 行參數解構加 `renderToolOverride`
  - 第 53 行後傳給 `Turn`
- Modify `src/renderer/App.tsx`
  - 第 3 行後加 `import { HandoffCard }`
  - 第 9 行後加 `import { REQUEST_HANDOFF_TOOL } from '../shared/view-tools.js'`
  - 第 87 行（`App` 的檔頭註解，`標題列（Task 11…` 之前）加一段交接卡的說明
  - 第 109 行後（`renderToolExtra` 的 `useCallback` 之後）加 `renderToolOverride`
  - 第 128 行後把 `renderToolOverride` 傳給 `Conversation`
- Test:
  - Create `tests/handoff-card.test.tsx`（313 行、21 個測試）
  - Modify `tests/conversation.test.tsx`：`renderToolExtra 沒給時…` 那個 `it` 之後加四個 `it`

三個 Plan A 測試檔（`tests/app-title-bar.test.tsx`、`tests/use-approvals.test.tsx`、
`tests/use-conversation.test.tsx`）的假 `YesChefApi` 由 Task 11 補上 `handoffDone`，本 task 不動。

**Interfaces:**
- Consumes：
  - Task 0：`REQUEST_HANDOFF_TOOL: string`（`src/shared/view-tools.ts`，值 `'mcp__yeschef__request_handoff'`）
  - Task 11：`formatElapsed(ms: number): string`（`src/renderer/components/relative-time.ts`）、
    `YesChefApi.handoffDone(toolUseId: string): void`（`src/shared/ipc.ts`，preload 已曝露）
  - Plan A 既有：`formatValue(value: unknown): string`（`ToolCall.tsx`）、
    `ToolBlock = Extract<Block, { kind: 'tool' }>`（`block-equals.ts`）
- Produces：
  - `interface HandoffCardProps { block: ToolBlock; historical: boolean; onDone: (toolUseId: string) => void; now?: () => number }`
  - `function HandoffCard(props: HandoffCardProps)`
  - `HANDOFF_BUTTON_TEXT`／`HANDOFF_NOTIFIED_TEXT`／`HANDOFF_INCOMPLETE_TEXT`／
    `HANDOFF_PREPARING_TEXT`／`HANDOFF_NO_REASON_TEXT`（五個 `const`，契約 §12 逐字）
  - `TurnProps.renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined`
  - `ConversationProps.renderToolOverride?`（同簽章）
  - 下游：Task 13（`ipc-bridge.ts` 的 `handoff:done` handler 接收這張卡送出的通知）、
    Task 14（實機驗收第 20 到 22 項）

- [ ] **Step 1：寫失敗的測試（`renderToolOverride`）**

`tests/conversation.test.tsx`：在既有的 `it('renderToolExtra 沒給時不影響渲染，工具卡片照常出現', …)`
之後插入四個 `it`（同一個 `describe('Conversation', …)` 內，沿用檔案既有的 `tool()`／`viewOf()` helper）。

```tsx
  // 裁決 2：交接卡不新增 Block 種類，改用 renderToolOverride 整張換掉。
  it('renderToolOverride 回傳節點時取代整張 ToolCall，並收到 block 與 historical', () => {
    const block = tool({ name: 'mcp__yeschef__request_handoff', status: 'running' })
    const seen: Array<readonly [ToolBlock, boolean]> = []
    const renderToolOverride = (b: ToolBlock, historical: boolean) => {
      seen.push([b, historical])
      return <div className="fake-handoff">交接 {b.id}</div>
    }
    const { container } = render(
      <Conversation view={viewOf([block])} historical={true} renderToolOverride={renderToolOverride} />
    )
    expect(container.querySelector('.fake-handoff')?.textContent).toBe('交接 tu_1')
    // 整張換掉：預設卡片的任何一塊都不該留下。
    expect(container.querySelector('.tool-call')).toBeNull()
    expect(container.querySelector('.tool-head')).toBeNull()
    expect(seen).toEqual([[block, true]])
  })

  it('renderToolOverride 回傳 undefined 時退回預設的 ToolCall，renderToolExtra 照常生效', () => {
    const { container } = render(
      <Conversation
        view={viewOf([tool({ status: 'awaiting-approval' })])}
        historical={false}
        renderToolOverride={() => undefined}
        renderToolExtra={() => <div className="approval-card">要批准嗎</div>}
      />
    )
    expect(container.querySelector('.tool-call')).not.toBeNull()
    expect(container.querySelector('.tool-status')?.textContent).toBe('等待批准')
    expect(container.querySelector('.tool-extra .approval-card')?.textContent).toBe('要批准嗎')
  })

  // 同一個 turn 裡兩個工具，只有其中一個被接管：逐個 block 判斷，不是整個 turn 一刀切。
  it('renderToolOverride 只接管它認得的那個 block', () => {
    const handoff = tool({ id: 'tu_h', name: 'mcp__yeschef__request_handoff' })
    const bash = tool({ id: 'tu_b', name: 'Bash' })
    const { container } = render(
      <Conversation
        view={viewOf([handoff, bash])}
        historical={false}
        renderToolOverride={(b) => (b.name === 'mcp__yeschef__request_handoff' ? <div className="fake-handoff" /> : undefined)}
      />
    )
    expect(container.querySelectorAll('.fake-handoff')).toHaveLength(1)
    const tools = container.querySelectorAll('.tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.querySelector('.tool-name')?.textContent).toBe('Bash')
  })

  // memo 的比較函式漏了 renderToolOverride 的話，換一個新的 callback 畫面會停在舊結果。
  it('turn 內容不變但 renderToolOverride 換人時要重畫（memo 比較函式不得漏欄位）', () => {
    const view = viewOf([tool({ name: 'mcp__yeschef__request_handoff' })])
    const { container, rerender } = render(
      <Conversation view={view} historical={false} renderToolOverride={() => <div className="fake-handoff">第一版</div>} />
    )
    expect(container.querySelector('.fake-handoff')?.textContent).toBe('第一版')
    rerender(
      <Conversation view={view} historical={false} renderToolOverride={() => <div className="fake-handoff">第二版</div>} />
    )
    expect(container.querySelector('.fake-handoff')?.textContent).toBe('第二版')
  })
```

第四個測試刻意讓 `view` 兩次都是**同一個物件**：turn 的內容完全沒變，唯一變的是 callback 的參考。
memo 的比較函式若漏了這個欄位，`blocksEqual` 會說「一樣」，畫面就停在第一版。

- [ ] **Step 2：跑測試確認失敗**

```bash
npx vitest run tests/conversation.test.tsx
```

實測（worktree `wt-12`）：

```
     × renderToolOverride 回傳節點時取代整張 ToolCall，並收到 block 與 historical 11ms
     × renderToolOverride 只接管它認得的那個 block 5ms
     × turn 內容不變但 renderToolOverride 換人時要重畫（memo 比較函式不得漏欄位） 3ms
 Tests  3 failed | 27 passed (30)
```

第二個新測試（回 `undefined` 退回預設）這時就是綠的：`renderToolOverride` 還不存在，React 會忽略
這個未知的 prop，卡片本來就照畫。它是**回歸護欄**，真正的價值在 Step 13 的突變 3。

- [ ] **Step 3：最小實作（`Turn.tsx`、`Conversation.tsx`）**

`src/renderer/components/Turn.tsx`，第 1 行改成：

```tsx
import { Fragment, memo, useState, type ReactNode } from 'react'
```

第 11 行（`readonly renderToolExtra?: …`）之後、`TurnProps` 的 `}` 之前加一行，並在 `TurnProps`
整段之後加 `RenderOptions`：

```tsx
  /** 回傳非 undefined 時取代預設的 ToolCall（整張卡）。裁決 2（docs/superpowers/plan-b/CONTRACT.md） */
  readonly renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined
}

/**
 * renderBlock 的第三個參數。三個欄位刻意宣告成「必填但可以是 undefined」而不是選填：
 * TurnImpl 直接把解構出來的 props 原樣裝進去就好，不必為了每個可能不存在的 callback
 * 各寫一次條件展開。
 */
interface RenderOptions {
  readonly historical: boolean
  readonly renderToolExtra: ((block: ToolBlock) => ReactNode) | undefined
  readonly renderToolOverride: ((block: ToolBlock, historical: boolean) => ReactNode | undefined) | undefined
}
```

第 33-38 行的 `renderBlock` 簽章（四個參數那份）換成兩行：

```tsx
function renderBlock(block: Block, index: number, opts: RenderOptions) {
  const { historical, renderToolExtra, renderToolOverride } = opts
```

第 44 行的 `case 'tool':` 到它的 `)` 為止，整段換成（多一組大括號讓 `const override` 有自己的作用域）：

```tsx
    case 'tool': {
      // 裁決 2：交接卡不新增 Block 種類，由呼叫端依 block.name 決定要不要整張換掉。
      const override = renderToolOverride?.(block, historical)
      if (override !== undefined) return <Fragment key={index}>{override}</Fragment>
      return (
        <ToolCall
          key={index}
          block={block}
          historical={historical}
          {...(renderToolExtra === undefined ? {} : { renderExtra: renderToolExtra })}
        />
      )
    }
```

`<Fragment key={index}>` 不能省：`renderBlock` 的回傳值直接進 `turn.blocks.map()` 的陣列，React
對陣列元素要 key，而呼叫端給的節點身上不會有。

第 60 行與第 65 行：

```tsx
function TurnImpl({ turn, historical, renderToolExtra, renderToolOverride }: TurnProps) {
  const opts: RenderOptions = { historical, renderToolExtra, renderToolOverride }
```

```tsx
        {turn.blocks.map((block, i) => renderBlock(block, i, opts))}
```

第 75 行（`prev.renderToolExtra === next.renderToolExtra &&`）之後加一行：

```tsx
    prev.renderToolOverride === next.renderToolOverride &&
```

`src/renderer/components/Conversation.tsx`，第 20 行之後加兩行，第 23 行的參數解構拆成多行：

```tsx
  /** 原樣傳給 Turn：回傳非 undefined 時取代預設的 ToolCall（裁決 2）。 */
  readonly renderToolOverride?: (block: ToolBlock, historical: boolean) => ReactNode | undefined
}

export function Conversation({
  view,
  historical,
  renderToolExtra,
  renderToolOverride,
}: ConversationProps) {
```

第 53 行之後加一行，沿用檔案既有的條件展開寫法：

```tsx
          {...(renderToolOverride === undefined ? {} : { renderToolOverride })}
```

- [ ] **Step 4：跑測試確認通過**

```bash
npx vitest run tests/conversation.test.tsx
```

實測（worktree `wt-12`）：

```
 Test Files  1 passed (1)
      Tests  30 passed (30)
```

- [ ] **Step 5：寫失敗的測試（`HandoffCard`）**

新建 `tests/handoff-card.test.tsx`。這一步先寫前三個 `describe`（卡片本身），第四個 `describe`
（App 接線）留到 Step 9。檔案完整內容如下，Step 9 只會在檔尾追加。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  HandoffCard,
  HANDOFF_BUTTON_TEXT,
  HANDOFF_INCOMPLETE_TEXT,
  HANDOFF_NOTIFIED_TEXT,
  HANDOFF_NO_REASON_TEXT,
  HANDOFF_PREPARING_TEXT,
} from '../src/renderer/components/HandoffCard.js'
import { App } from '../src/renderer/App.js'
import { REQUEST_HANDOFF_TOOL } from '../src/shared/view-tools.js'
import type { ToolBlock } from '../src/renderer/components/block-equals.js'
import type { Event } from '../src/shared/events.js'
import type { SessionSummary, YesChefApi } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * 基準時刻刻意不是 0：卡片顯示的是 `now() - mountedAt`，用 0 當基準的話
 * 「忘了減 mountedAt」這個突變會巧合通過（0 減不減都是 0）。
 */
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
    const { container } = render(
      <HandoffCard block={block({ status: 'streaming-input', input: undefined })} historical={false} onDone={vi.fn()} />
    )
    expect(textOf(container, '.handoff-card__title')).toBe('交接給使用者')
    expect(textOf(container, '.handoff-card__reason')).toBe(HANDOFF_PREPARING_TEXT)
    expect(container.querySelector('.handoff-card__elapsed')).toBeNull()
    expect(container.querySelector('.handoff-card__button')).toBeNull()
    expect(container.querySelector('.handoff-card__result')).toBeNull()
    expect(container.querySelector('.handoff-card--pending')).not.toBeNull()
  })

  it('running 且非歷史：理由、已等待與按鈕都在，class 是 --pending', () => {
    const { container } = render(
      <HandoffCard block={block()} historical={false} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__reason')).toBe('請幫我登入')
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')
    expect(textOf(container, '.handoff-card__button')).toBe(HANDOFF_BUTTON_TEXT)
    expect(container.querySelector('.handoff-card--pending')).not.toBeNull()
  })

  it('awaiting-approval 且非歷史：與 running 一樣有按鈕', () => {
    const { container } = render(
      <HandoffCard block={block({ status: 'awaiting-approval' })} historical={false} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__button')).toBe(HANDOFF_BUTTON_TEXT)
    expect(container.querySelector('.handoff-card__elapsed')).not.toBeNull()
  })

  it.each([
    ['input 不是物件', 'abc' as unknown],
    ['input 沒有 reason', { note: '無關欄位' } as unknown],
    ['reason 是空字串', { reason: '' } as unknown],
    ['reason 不是字串', { reason: 42 } as unknown],
  ])('理由取不到時用 HANDOFF_NO_REASON_TEXT：%s', (_label, input) => {
    const { container } = render(
      <HandoffCard block={block({ input })} historical={false} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__reason')).toBe(HANDOFF_NO_REASON_TEXT)
  })

  it('running 但 historical：顯示未完成，沒有按鈕也沒有等待時間，class 是 --stale', () => {
    const { container } = render(
      <HandoffCard block={block()} historical={true} onDone={vi.fn()} now={() => BASE} />
    )
    expect(textOf(container, '.handoff-card__reason')).toBe('請幫我登入')
    expect(textOf(container, '.handoff-card__result')).toBe(HANDOFF_INCOMPLETE_TEXT)
    expect(container.querySelector('.handoff-card__button')).toBeNull()
    expect(container.querySelector('.handoff-card__elapsed')).toBeNull()
    expect(container.querySelector('.handoff-card--stale')).not.toBeNull()
    expect(container.querySelector('.handoff-card--pending')).toBeNull()
  })

  it('done：結果是 [{ type: text }] 時取 text，class 是 --done', () => {
    const { container } = render(
      <HandoffCard
        block={block({ status: 'done', result: [{ type: 'text', text: '使用者已完成，網址 https://a.test/ok' }] })}
        historical={false}
        onDone={vi.fn()}
      />
    )
    expect(textOf(container, '.handoff-card__result')).toBe('使用者已完成，網址 https://a.test/ok')
    expect(container.querySelector('.handoff-card--done')).not.toBeNull()
    expect(container.querySelector('.handoff-card__button')).toBeNull()
  })

  it.each([
    ['第一個元素不是 text 型別', [{ type: 'image', data: 'x' }], '[\n  {\n    "type": "image",\n    "data": "x"\n  }\n]'],
    ['結果不是陣列', { ok: true }, '{\n  "ok": true\n}'],
  ])('done：%s 時退回 formatValue', (_label, result, expected) => {
    const { container } = render(
      <HandoffCard block={block({ status: 'done', result })} historical={false} onDone={vi.fn()} />
    )
    expect(textOf(container, '.handoff-card__result')).toBe(expected)
  })

  it('error：class 加 --error，結果文字照樣顯示', () => {
    const { container } = render(
      <HandoffCard
        block={block({ status: 'error', result: [{ type: 'text', text: '交接逾時' }] })}
        historical={false}
        onDone={vi.fn()}
      />
    )
    expect(container.querySelector('.handoff-card--error')).not.toBeNull()
    expect(textOf(container, '.handoff-card__result')).toBe('交接逾時')
  })

  it('denied：有 deniedReason 用它，沒有時用「已拒絕」', () => {
    const withReason = render(
      <HandoffCard block={block({ status: 'denied', deniedReason: '使用者按了拒絕' })} historical={false} onDone={vi.fn()} />
    )
    expect(textOf(withReason.container, '.handoff-card__result')).toBe('使用者按了拒絕')
    cleanup()
    const without = render(<HandoffCard block={block({ status: 'denied' })} historical={false} onDone={vi.fn()} />)
    expect(textOf(without.container, '.handoff-card__result')).toBe('已拒絕')
  })
})
```

接著兩個 `describe`（按鈕與計時器）：

```tsx
describe('HandoffCard 的「我好了」按鈕', () => {
  it('按一下用 block.id 呼叫 onDone，按鈕變成停用的已通知', () => {
    const onDone = vi.fn()
    const { container } = render(
      <HandoffCard block={block({ id: 'toolu_abc' })} historical={false} onDone={onDone} now={() => BASE} />
    )
    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    fireEvent.click(button)
    expect(onDone.mock.calls).toEqual([['toolu_abc']])
    expect(button.textContent).toBe(HANDOFF_NOTIFIED_TEXT)
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  /**
   * 兩次點擊在同一個批次裡送出：React 還沒重畫，`disabled` 還沒掛上去，
   * handler 讀到的 `notified` 也還是這一輪的 false。只靠這兩者都擋不住，
   * 卡片必須自己記住已經送過了。用 fireEvent 連點兩次測不到這件事：
   * fireEvent 之間 React 已經重畫，jsdom 對停用的按鈕根本不發第二個 click。
   */
  it('同一批次連按兩次只呼叫一次 onDone', () => {
    const onDone = vi.fn()
    const { container } = render(
      <HandoffCard block={block({ id: 'toolu_abc' })} historical={false} onDone={onDone} now={() => BASE} />
    )
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

    // 時鐘已經走過一分半，但計時器還差 1 毫秒沒到期：畫面必須還是舊值。
    current = BASE + 90_000
    act(() => {
      vi.advanceTimersByTime(29_999)
    })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 不到 1 分鐘')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(textOf(container, '.handoff-card__elapsed')).toBe('已等待 1 分鐘')

    // 第二次到期要再重算一次，證明是週期性的而不是只跑一次。
    current = BASE + 3 * 60_000
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
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
```

計時器那個測試的三段推進不能合併。`29_999` 那一段擋住「間隔比 30 秒短」的實作，
`+1` 那一段擋住「間隔比 30 秒長」與「乾脆沒排計時器」，最後一段擋住「只用 `setTimeout` 跑一次」。
時鐘的推進與計時器的推進刻意脫鉤（`current` 直接跳到 `BASE + 90_000`，計時器只走 29_999 毫秒），
不然「顯示的是計時器走過的時間」這個錯誤實作會巧合同值。

- [ ] **Step 6：跑測試確認失敗**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`，`HandoffCard.tsx` 還不存在）：

```
 FAIL  tests/handoff-card.test.tsx [ tests/handoff-card.test.tsx ]
Error: Failed to resolve import "../src/renderer/components/HandoffCard.js" from "tests/handoff-card.test.tsx". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 7：最小實作（`HandoffCard.tsx`）**

新建 `src/renderer/components/HandoffCard.tsx`（169 行）：

```tsx
import { useEffect, useRef, useState } from 'react'
import { formatElapsed } from './relative-time.js'
import { formatValue } from './ToolCall.js'
import type { ToolBlock } from './block-equals.js'
import './HandoffCard.css'

export interface HandoffCardProps {
  readonly block: ToolBlock
  readonly historical: boolean
  readonly onDone: (toolUseId: string) => void
  /** 測試注入；預設 Date.now。 */
  readonly now?: () => number
}

export const HANDOFF_BUTTON_TEXT = '我好了'
export const HANDOFF_NOTIFIED_TEXT = '已通知'
export const HANDOFF_INCOMPLETE_TEXT = '未完成（對話中途結束）'
export const HANDOFF_PREPARING_TEXT = '準備交接…'
export const HANDOFF_NO_REASON_TEXT = '（未說明理由）'

const TITLE_TEXT = '交接給使用者'
const DENIED_FALLBACK_TEXT = '已拒絕'

/**
 * 已等待文字的重算間隔（契約 §12）。formatElapsed 的最小刻度是一分鐘，
 * 30 秒讓跨分鐘那一刻最多晚半分鐘才顯示，而每分鐘只醒兩次。
 */
const TICK_MS = 30_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `input.reason` 是非空字串才用，其餘一律 HANDOFF_NO_REASON_TEXT（契約 §12）。 */
function reasonOf(input: unknown): string {
  if (!isRecord(input)) return HANDOFF_NO_REASON_TEXT
  const reason = input.reason
  return typeof reason === 'string' && reason !== '' ? reason : HANDOFF_NO_REASON_TEXT
}

/** 契約 §12：result 是陣列且第一個元素是 `{ type: 'text', text }` 時取 text，否則 formatValue。 */
function resultTextOf(result: unknown): string {
  if (!Array.isArray(result)) return formatValue(result)
  const first: unknown = result[0]
  if (!isRecord(first)) return formatValue(result)
  if (first.type !== 'text' || typeof first.text !== 'string') return formatValue(result)
  return first.text
}

/**
 * 卡片的六種樣貌。把 `status` 與 `historical` 兩個輸入先併成一個 phase，
 * 之後每一塊內容都只問 phase 一次，不必在 JSX 裡到處重複同一組布林運算。
 */
type Phase = 'preparing' | 'pending' | 'stale' | 'done' | 'error' | 'denied'

function phaseOf(status: ToolBlock['status'], historical: boolean): Phase {
  switch (status) {
    case 'streaming-input':
      return 'preparing'
    case 'running':
    case 'awaiting-approval':
      return historical ? 'stale' : 'pending'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'denied':
      return 'denied'
  }
}

/** 裁決 25：契約 §12 只給四個 modifier，denied 與 error 共用 --error，preparing 與等待中共用 --pending。 */
const MODIFIER: Record<Phase, string> = {
  preparing: 'pending',
  pending: 'pending',
  stale: 'stale',
  done: 'done',
  error: 'error',
  denied: 'error',
}

function resultOf(phase: Phase, block: ToolBlock): string | undefined {
  switch (phase) {
    case 'preparing':
    case 'pending':
      return undefined
    case 'stale':
      return HANDOFF_INCOMPLETE_TEXT
    case 'denied':
      return block.deniedReason ?? DENIED_FALLBACK_TEXT
    case 'done':
    case 'error':
      return resultTextOf(block.result)
  }
}

/**
 * `request_handoff` 的專用工具卡（裁決 2，docs/superpowers/plan-b/CONTRACT.md）。
 *
 * 「已等待」不是每秒重畫，也不是只在父層重繪時才更新：卡片自己排一個 30 秒的
 * interval，只有 `pending`（進行中且不是歷史對話）才排。歷史對話的交接永遠不會
 * 有下文，讓它繼續數秒數只會騙人，也會在使用者翻舊對話時留一堆醒著的計時器。
 *
 * `mountedAt` 用惰性初始值取一次就不再變：交接的起算點是卡片出現的時刻，
 * 每次重畫都重取會讓等待時間永遠停在「不到 1 分鐘」。
 */
export function HandoffCard({ block, historical, onDone, now = Date.now }: HandoffCardProps) {
  const phase = phaseOf(block.status, historical)
  const [mountedAt] = useState<number>(now)
  const [tick, setTick] = useState<number>(now)
  const [notified, setNotified] = useState<boolean>(false)
  // 已通知的旗標要另外用 ref 記一份：同一個批次裡送進來的第二次點擊，讀到的
  // `notified` 還是這一輪 render 的 false，只靠 state 擋不住（disabled 也還沒掛上去）。
  const notifiedRef = useRef<boolean>(false)

  // now 放進 ref：呼叫端若每次重畫都給一個新的函式（App 沒有，但測試與未來的呼叫端
  // 可能會），interval 不該因此被拆掉重排，否則永遠等不到第一次 30 秒。
  const nowRef = useRef<() => number>(now)
  useEffect(() => {
    nowRef.current = now
  }, [now])

  useEffect(() => {
    if (phase !== 'pending') return undefined
    const id = setInterval(() => {
      setTick(nowRef.current())
    }, TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [phase])

  /**
   * 主程序對同一個 toolUseId 只認第一次通知，第二次會記一筆「找不到 pending」的
   * 錯誤。卡片自己擋住連按，畫面上也才看得出第一次已經送出去了。
   */
  const done = (): void => {
    if (notifiedRef.current) return
    notifiedRef.current = true
    setNotified(true)
    onDone(block.id)
  }

  const result = resultOf(phase, block)

  return (
    <div
      className={`handoff-card handoff-card--${MODIFIER[phase]}`}
      role="group"
      aria-label="交接給使用者"
      data-testid="handoff-card"
      data-tool-use-id={block.id}
    >
      <p className="handoff-card__title">{TITLE_TEXT}</p>
      <p className="handoff-card__reason">
        {phase === 'preparing' ? HANDOFF_PREPARING_TEXT : reasonOf(block.input)}
      </p>
      {phase === 'pending' && (
        <p className="handoff-card__elapsed">已等待 {formatElapsed(tick - mountedAt)}</p>
      )}
      {result !== undefined && <p className="handoff-card__result">{result}</p>}
      {phase === 'pending' && (
        <button type="button" className="handoff-card__button" disabled={notified} onClick={done}>
          {notified ? HANDOFF_NOTIFIED_TEXT : HANDOFF_BUTTON_TEXT}
        </button>
      )}
    </div>
  )
}
```

`useState<number>(now)` 這個寫法是把 `now` 本身當惰性初始化函式傳給 `useState`，React 只在第一次
render 呼叫它一次。`useState(now())` 會每次重畫都算一遍（雖然結果被丟掉），意思一樣但多做事。

新建 `src/renderer/components/HandoffCard.css`（74 行）。`ApprovalCard.css` 一個字不動，
兩張卡各管各的：

```css
/* request_handoff 的專用卡片（契約 §12）。ApprovalCard.css 不動，兩張卡各自管自己的樣式。 */

.handoff-card {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid #2a6a7a;
  border-left-width: 3px;
  border-radius: 4px;
  background: #101a1c;
}

/* 還在等使用者：邊框亮一點，這是畫面上唯一在等人動作的東西。 */
.handoff-card--pending {
  border-color: #58a9c9;
}

/* 歷史對話裡沒有下文的交接。 */
.handoff-card--stale {
  border-color: #4a4d40;
  opacity: 0.75;
}

.handoff-card--done {
  border-color: #3f7a4a;
}

.handoff-card--error {
  border-color: #8a4a2a;
}

.handoff-card__title {
  margin: 0 0 4px;
  font-weight: 600;
}

.handoff-card__reason {
  margin: 0 0 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

.handoff-card__elapsed {
  margin: 0 0 8px;
  font-size: 0.85em;
  opacity: 0.7;
}

.handoff-card__result {
  margin: 0 0 6px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

.handoff-card__button {
  padding: 4px 12px;
  border: 1px solid #4a4d40;
  border-radius: 3px;
  background: #23261c;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.handoff-card__button:hover:not(:disabled) {
  background: #2d3124;
}

.handoff-card__button:disabled {
  cursor: default;
  opacity: 0.6;
}
```

`.handoff-card__result` 用 `<p>` 加 `white-space: pre-wrap`，不用 `<pre>`：同一個位置要輪流裝
`HANDOFF_INCOMPLETE_TEXT`、`deniedReason` 與 JSON 三種東西，換標籤等於多一個分支。三段文字各自
落在哪個 class 依裁決 25。

- [ ] **Step 8：跑測試確認通過**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`，這時第四個 `describe` 還沒寫）：

```
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

- [ ] **Step 9：寫失敗的測試（App 接線）**

在 `tests/handoff-card.test.tsx` 檔尾追加假 api 與第四個 `describe`：

```tsx
/** App 只認 window.yeschef，這裡給一份剛好夠用的假 api。 */
function createFakeApi(): {
  readonly api: YesChefApi
  readonly handoffDone: ReturnType<typeof vi.fn>
  emit(events: readonly Event[]): void
} {
  const listeners = new Set<(events: readonly Event[]) => void>()
  const handoffDone = vi.fn()
  const api: YesChefApi = {
    onEvents: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    onApprovalAsk: () => () => undefined,
    onSessionState: () => () => undefined,
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: (): Promise<readonly SessionSummary[]> => Promise.resolve([]),
    startNew: () => undefined,
    openHistory: () => undefined,
    handoffDone,
    projectDir: '/Users/x/Projects/demo',
  }
  return {
    api,
    handoffDone,
    emit: (events) => {
      act(() => {
        for (const l of listeners) l(events)
      })
    },
  }
}

const HANDOFF_EVENT: Event = {
  kind: 'tool-use',
  messageId: 'msg_1',
  index: 0,
  id: 'toolu_h1',
  name: REQUEST_HANDOFF_TOOL,
  input: { reason: '請登入這個網站' },
}

const BASH_EVENT: Event = {
  kind: 'tool-use',
  messageId: 'msg_1',
  index: 1,
  id: 'toolu_b1',
  name: 'Bash',
  input: { command: 'ls' },
}

describe('App 把 request_handoff 的工具卡換成 HandoffCard', () => {
  it('交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emit([{ kind: 'message-start', messageId: 'msg_1' }, HANDOFF_EVENT, BASH_EVENT])

    expect(container.querySelectorAll('.handoff-card')).toHaveLength(1)
    expect(textOf(container, '.handoff-card__reason')).toBe('請登入這個網站')
    // 非交接工具不受影響：Bash 那一格照樣是 ToolCall。
    const tools = container.querySelectorAll('.tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.querySelector('.tool-name')?.textContent).toBe('Bash')
  })

  it('按下「我好了」呼叫 api.handoffDone 並帶上 tool use id', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emit([{ kind: 'message-start', messageId: 'msg_1' }, HANDOFF_EVENT])

    const button = container.querySelector('.handoff-card__button')
    if (button === null) throw new Error('找不到按鈕')
    fireEvent.click(button)
    expect(fake.handoffDone.mock.calls).toEqual([['toolu_h1']])
  })
})
```

第一個測試同一輪放兩個工具而不是只放交接那一個：只放一個的話，「所有工具都換成 HandoffCard」
這個突變照樣全綠（見 Step 13 的突變 4）。

- [ ] **Step 10：跑測試確認失敗**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`，`App.tsx` 還沒接）：

```
     × 交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall
     × 按下「我好了」呼叫 api.handoffDone 並帶上 tool use id
       Error: 找不到按鈕
 Tests  2 failed | 19 passed (21)
```

- [ ] **Step 11：最小實作（`App.tsx`）**

`src/renderer/App.tsx`，第 3 行之後加一行、第 9 行之後加一行：

```tsx
import { HandoffCard } from './components/HandoffCard.js'
```

```tsx
import { REQUEST_HANDOFF_TOOL } from '../shared/view-tools.js'
```

第 87 行（`App` 檔頭註解裡 ` * 標題列（Task 11，裁決 21）：` 那一行）之前插入：

```tsx
 * 交接卡（Task 12，裁決 2）：`renderToolOverride` 只認工具名稱，fold.ts 不必知道
 * 有交接這回事。回 undefined 的那條路就是「這個工具沒有專用卡」，Conversation
 * 照樣畫預設的 ToolCall。
 *
```

第 109 行（`renderToolExtra` 的 `useCallback` 結尾 `)`）之後加：

```tsx

  const renderToolOverride = useCallback(
    (block: ToolBlock, historical: boolean) =>
      block.name === REQUEST_HANDOFF_TOOL ? (
        <HandoffCard block={block} historical={historical} onDone={api.handoffDone} />
      ) : undefined,
    [api]
  )
```

第 128 行（`renderToolExtra={renderToolExtra}`）之後加一行：

```tsx
          renderToolOverride={renderToolOverride}
```

依賴陣列是 `[api]` 而不是 `[]`：`api.handoffDone` 是從 `window.yeschef` 取的，`api` 換了就要重建。
`api` 在真實環境永遠是同一個物件，所以這個 callback 實際上不會重建，`Turn` 的 memo 擋得住。

`api.handoffDone` 直接當成函式參考傳出去，不用 `(id) => api.handoffDone(id)` 包一層：preload 的
`handoffDone` 是物件字面值裡的箭頭函式，沒有用到 `this`，跟既有的 `onOpen={api.openHistory}` 同一種
寫法。

三個 Plan A 測試檔（`app-title-bar`、`use-approvals`、`use-conversation`）手刻的假 `YesChefApi`
少了必填的 `handoffDone`（契約 §11.3、裁決 23），補樁由 Task 11 負責，執行順序在本 task 之前，
這裡不動那三個檔案。

- [ ] **Step 12：跑測試確認通過**

```bash
npx vitest run tests/handoff-card.test.tsx
```

實測（worktree `wt-12`）：

```
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

整個套件與型別檢查（`npx vitest run` 的基準是 Task 11 之後的 489 個測試；本 task 加 25 個）：

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
```

```
 Test Files  26 passed (26)
      Tests  514 passed (514)
```

`tsc --noEmit` 0 error（前提是 Task 11 已補上三個 Plan A 測試檔的 `handoffDone` 樁）。

覆蓋率（`npx vitest run --coverage`）：

```
All files          |   93.44 |    87.08 |   95.87 |   95.58
```

Stmts 93.44 ≥ 93、Branch 87.08 ≥ 86，符合契約 §14 的判準。`HandoffCard.tsx` 與 `Turn.tsx` 沒出現在
覆蓋率表裡：報表設了 `skipFull`，四項都 100% 的檔案不列。

- [ ] **Step 13：突變測試**

七個突變，全部在 worktree `wt-12` 實測，每個跑完立刻還原並確認回綠。

**突變 1（`HandoffCard.tsx`）：`phaseOf` 忽略 `historical`。**

```tsx
    case 'running':
    case 'awaiting-approval':
      return 'pending'          // 突變：原本是 historical ? 'stale' : 'pending'
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅兩個：

```
     × running 但 historical：顯示未完成，沒有按鈕也沒有等待時間，class 是 --stale
     × historical 的等待中卡片不排計時器
 Tests  2 failed | 19 passed (21)
```

歷史對話裡冒出一顆能按的「我好了」按鈕，是這張卡最糟的失效方式：那次交接的 pending 早就不存在，
按下去只會在主程序留一筆假錯誤。還原後 `21 passed (21)`。

**突變 2（`HandoffCard.tsx`）：拿掉 `notifiedRef` 這道 guard，只留 state 與 `disabled`。**

```tsx
  const done = (): void => {
    setNotified(true)         // 突變：拿掉 notifiedRef.current 的判斷與設值
    onDone(block.id)
  }
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 同一批次連按兩次只呼叫一次 onDone
 Tests  1 failed | 20 passed (21)
```

**這個突變是本 task 最重要的一個發現。** 第一版的實作寫的是 `if (notified) return`（讀 state），
測試寫的是 `fireEvent.click(button)` 連按三次，跑這個突變**全綠**：`fireEvent` 之間 React 已經重畫，
按鈕變成 `disabled`，jsdom 對停用的表單控制項根本不發第二個 click，測試從頭到尾只點得到一次。
而且讀 state 的 guard 對真正的雙擊（同一個批次、`notified` 還是 `false`）也擋不住。修法是兩邊都改：
實作改用 `notifiedRef`（依裁決 25），測試改成在同一個 `act` 內連發兩個 `MouseEvent`。
還原後 `21 passed (21)`。

**突變 3（`Turn.tsx`）：override 的判斷改看 callback 存不存在，而不是看回傳值。**

```tsx
      const override = renderToolOverride?.(block, historical)
      if (renderToolOverride !== undefined) return <Fragment key={index}>{override}</Fragment>
```

```bash
npx vitest run tests/conversation.test.tsx tests/handoff-card.test.tsx
```

變紅三個：

```
     × 交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall
     × renderToolOverride 回傳 undefined 時退回預設的 ToolCall，renderToolExtra 照常生效
     × renderToolOverride 只接管它認得的那個 block
 Tests  3 failed | 48 passed (51)
```

這是接法本身最容易寫錯的一步：App 一掛上 callback，畫面上所有工具卡就全部變空白。
還原後 `51 passed (51)`。

**突變 4（`App.tsx`）：不看工具名稱，每個工具都換成 HandoffCard。**

```tsx
  const renderToolOverride = useCallback(
    (block: ToolBlock, historical: boolean) => (
      <HandoffCard block={block} historical={historical} onDone={api.handoffDone} />
    ),
    [api]
  )
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 交接工具畫成 HandoffCard，同一輪的其他工具仍是預設的 ToolCall
 Tests  1 failed | 20 passed (21)
```

那個測試的 turn 裡刻意放了 Bash 與 request_handoff 兩個工具。只放一個交接工具的話，這個突變
會全綠：`.handoff-card` 找得到、理由也對，斷言全部命中，錯誤實作照樣通過。還原後 `21 passed (21)`。

**突變 5（`HandoffCard.tsx`）：`TICK_MS` 從 `30_000` 改成 `1_000`。**

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 未滿 30 秒不重算，滿 30 秒才重算
 Tests  1 failed | 20 passed (21)
```

推進 29_999 毫秒那一段擋住了它：間隔一秒的話畫面早就更新成「1 分鐘」。契約 §12 寫的是 30 秒，
只測「會更新」不測「什麼時候更新」的話，這個數字等於沒有被任何測試釘住。還原後 `21 passed (21)`。

**突變 6（`HandoffCard.tsx`）：`mountedAt` 每次重畫都重取。**

```tsx
  const mountedAt = now()      // 突變：原本是 const [mountedAt] = useState<number>(now)
```

```bash
npx vitest run tests/handoff-card.test.tsx
```

變紅：

```
     × 未滿 30 秒不重算，滿 30 秒才重算
 Tests  1 failed | 20 passed (21)
```

`tick` 與 `mountedAt` 同時前進，差永遠是 0，等待時間永遠停在「不到 1 分鐘」。基準時刻用
`BASE = 1_764_000_000_000` 而不是 0，才擋得住另一種變體（忘了減 `mountedAt`、直接顯示
`formatElapsed(tick)`）：用 0 當基準的話兩者巧合同值。還原後 `21 passed (21)`。

**突變 7（`Turn.tsx`）：memo 比較函式漏掉 `renderToolOverride`。**

```tsx
    prev.renderToolExtra === next.renderToolExtra &&
    // 突變：刪掉 prev.renderToolOverride === next.renderToolOverride &&
    prev.turn.role === next.turn.role &&
```

```bash
npx vitest run tests/conversation.test.tsx tests/handoff-card.test.tsx
```

變紅：

```
     × turn 內容不變但 renderToolOverride 換人時要重畫（memo 比較函式不得漏欄位）
 Tests  1 failed | 50 passed (51)
```

還原後 `51 passed (51)`。

七個突變全部還原後跑一次完整套件確認沒有殘留：

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git diff --stat
```

```
 Test Files  26 passed (26)
      Tests  514 passed (514)
```

`git diff --stat` 只剩下本 task 與上游 Task 0／11 的檔案改動，沒有任何突變殘留。

- [ ] **Step 14：提交**

```bash
git add \
  src/renderer/components/HandoffCard.tsx \
  src/renderer/components/HandoffCard.css \
  src/renderer/components/Turn.tsx \
  src/renderer/components/Conversation.tsx \
  src/renderer/App.tsx \
  tests/handoff-card.test.tsx \
  tests/conversation.test.tsx
git commit -m "feat: 交接卡與 renderToolOverride"
```

