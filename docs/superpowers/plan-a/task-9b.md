### Task 9B: 對話元件（Conversation／Turn／ToolCall／useConversation）

> **2026-09-02 依裁決 17 與接縫補記修訂**
>
> `Conversation` 依裁決 17 第 4 點加一張錯誤卡片（`view.error` 存在時渲染），新增兩條測試與突變 M8。
> `vitest.config.ts` 的 `test.include` 已由 Task 9 定案，本 task 只在 Step 2 確認，不再重複列為待改項目。
> 回報事項第 4、5、6 條依裁決 12、17 改寫為已定案結論。測試數由 34 增至 36，突變數由 7 增至 8。
>
> **2026-09-02 晚間依裁決 22 再修訂**
>
> 清空畫面的判斷從 `sessionState` 換一場改成事件流裡的 `{ kind: 'reset' }` 標記。`sameSession` 刪除，
> 新增純函式 `appendEvents`；`onSessionState` 只更新狀態。Step 1 換掉兩條測試、加六條，M1 改成
> 「收到 reset 不清空」。測試數由 36 增至 42。

把 Task 4／4B 的 `ConversationView` 畫成畫面，並把 Task 8 的 `window.yeschef` 接上 React。
Task 9 已經備妥外殼與 `Markdown` 元件，本 task 補上中間那一段：訂閱事件、投影成 view、逐 block 渲染。
批准卡片本體是 Task 10（本 task 只留 `renderToolExtra` 這個插入點），Recents 是 Task 11。

**設計取捨一：`fold()` 每幀重建物件，所以 `React.memo` 必須自帶比較函式，否則等於沒寫。**

`fold()` 是純函式，每次呼叫都從空 view 重播整條事件流，連內容一個字都沒變的 turn 也會拿到全新的
`Turn` 物件、全新的 `blocks` 陣列、全新的 `Block` 物件。`React.memo` 預設的淺比較看的是參照，
每幀都不相等，於是 memo 每次都放行。這不是「memo 效果差」，是 memo 完全不會命中，寫了只是裝飾。
Task 9 的解法（改傳原始值）在 `Markdown` 這一層有效，但 `Turn` 與 `ToolCall` 收的是 block 物件本身，
拆不成幾個原始值。所以這裡改用第二種解法：`memo(Component, areEqual)` 加一個逐欄位比較的純函式
`blockEquals`，放在獨立的 `block-equals.ts` 讓它能被單獨測。

比較函式對 `input` 與 `result` 用參照比較（`Object.is`），對 `raw` 用逐欄位比較。這個差別有實據：
`fold()` 把 `event.input`／`event.content` 原樣傳進 Block，而事件陣列是附加式的、元素本身從不重建，
所以同一次工具呼叫的 `input` 在每一幀都是同一個物件；`raw` 則是 `applyToolRawOutput` 每次重新組出來的
新物件，用參照比會永遠不等。判斷錯的代價不對稱：參照比較最壞的結果是多重繪一次（畫面正確、效能損失），
比較函式漏了欄位則會讓畫面停在舊資料（畫面錯誤）。所以參照比較用在安全的方向，漏欄位那一側靠測試擋。

**設計取捨二：批准卡片畫在摺疊區之外。**

`renderToolExtra` 的回傳值放在 `.tool-extra`，位置在卡片底部但不在 `open` 的條件裡面。理由是規格 §6
說批准出現時「對話已經卡住，無法繼續往下」，若把它塞進預設摺疊的工具內容裡，使用者會看到一個停住的
畫面卻找不到要按什麼。同理，`status === 'awaiting-approval'` 的卡片預設展開（規格 §6 要求顯示完整
input），作法是 `const open = override ?? block.status === 'awaiting-approval'`：使用者手動點過就以他的
選擇為準，沒點過就由狀態決定。用一個 `boolean | undefined` 的 state 表達「使用者有沒有表示過意見」，
比用 `useEffect` 去同步兩個狀態少一個特殊情況。

**設計取捨三：清空畫面的分界寫在事件流裡，不從 `session:state` 推論（裁決 22）。**

`onEvents` 收到的批次一律附加；批次裡出現 `{ kind: 'reset' }` 時，只保留最後一個 `reset` 之後的事件，
先前累積的全部丟掉，`reset` 本身也不留。`onSessionState` 只更新 `state`，不動 `events`。

理由是資料放在對的地方：「畫面從這裡重新開始」是事件流自己的分段，由主程序在推事件時合成
（Task 8 的 `ipc-bridge.ts`：全新 query 之前推一筆，載入歷史時放在歷史事件最前面），跟同一條頻道的
其他事件共用先後順序，所以 `session:state` 什麼時候到都不影響畫面內容。反過來用狀態差異推論的話，
有三處判斷會相反：`live` 轉 `idle`（query 結束或出錯）要保留裁決 17 的錯誤卡片、`viewing{A}` 轉
`live{A}`（輸入即 resume）要保留歷史、`live{}` 轉 `live{}`（live 中按新對話）才是真的要清。

`state` 與 `events` 仍然合在同一份 `{ state, events }`：拆成兩個 `useState` 的話，其中一個的更新函式
就得呼叫另一個的 setter，而 React 的更新函式必須是純的（StrictMode 會重複呼叫）。合成一份之後，
附加與截斷都是同一個純表達式算出來的。

截斷的部分抽成獨立的匯出函式 `appendEvents(prev, batch)`。原因是 `fold()` 自己也認得 `reset`
（裁決 22 給 Task 4 的那一條：`case 'reset': return INITIAL_VIEW`），所以 hook 少截一次，畫面看起來
一模一樣，差別只在累積陣列會無限長。這件事透過 `view` 觀察不到，只能直接測那個純函式，Step 5 的
M1 就掛在它上面。

**已驗證的範圍**：下面所有標「已驗證」「實測」的句子，都是在 `git worktree` 裡裝上真實套件版本
（react 19.2.8／@testing-library/react 16.3.3／jsdom 30.0.1）、把上游 task 的程式碼材料化之後，
實際跑過 `tsc --noEmit` 與 `vitest run` 得到的結果。42 個新測試全綠、8 個突變全部如預期變紅，
指令與輸出見 Step 4、Step 5。

**Files:**
- Create: `src/renderer/components/Conversation.tsx`
- Create: `src/renderer/components/Turn.tsx`
- Create: `src/renderer/components/ToolCall.tsx`
- Create: `src/renderer/components/ThinkingBlock.tsx`
- Create: `src/renderer/components/block-equals.ts`
- Create: `src/renderer/components/Conversation.css`
- Create: `src/renderer/hooks/useConversation.ts`
- Create: `tests/conversation.test.tsx`
- Create: `tests/use-conversation.test.tsx`
- Modify: `src/renderer/App.tsx`（換掉對話佔位，加輸入框）
- Modify: `src/renderer/App.css`（`.conversation` 改成直向 flex，加 `.composer`）
- Modify: `vitest.config.ts`（coverage 加新檔。`include` 的 `.tsx` glob 由 Task 9 負責，本 task 不動那一行）

兩個追加檔案的理由：`block-equals.ts` 是純函式，抽出來才能單獨測（Step 5 的突變 M6 就靠它），
`Conversation.css` 一份涵蓋四個元件的樣式，不切成四個十行的檔案。`UnknownBlock` 沒有獨立成檔，
它只有十幾行且只被 `Turn` 用到，留在 `Turn.tsx` 內。

**Interfaces:**
- Consumes:
  - `fold(events: readonly Event[]): ConversationView`、`ConversationView`、`Turn`、`Block`
    （Task 4／4B，`src/shared/fold.ts`）。`Block` 的 `kind: 'tool'` 依裁決 12 含 `deniedReason?: string`；
    `ConversationView` 依裁決 17 另含 `error?: { readonly message?: string; readonly apiErrorStatus?: unknown }`
  - `Event`（Task 3，`src/shared/events.ts`）
  - `SessionState`（Task 5，`src/shared/session-state.ts`，裁決 14）
  - `YesChefApi`（Task 8，`src/shared/ipc.ts`，以契約裁決 14 的定稿版為準）
  - `Markdown`、`MarkdownProps`（Task 9，`src/renderer/components/Markdown.tsx`）
  - `window.yeschef`（Task 8 的 `src/renderer/global.d.ts`）
- Produces:
  - `type ToolBlock = Extract<Block, { kind: 'tool' }>`（宣告在 `block-equals.ts`，由 `Conversation.tsx`
    再匯出一次，讓 Task 10 可以照契約寫 `import type { ToolBlock } from './Conversation.js'`）
  - `interface ConversationProps { view; historical; renderToolExtra? }`
  - `function Conversation(props: ConversationProps)`
  - `function useConversation(api: YesChefApi): { view: ConversationView; sessionState: SessionState }`
    （`src/renderer/hooks/useConversation.ts`，同檔另出 `appendEvents`、`INITIAL_SESSION_STATE`）
  - `appendEvents(prev: readonly Event[], batch: readonly Event[]): readonly Event[]`
    （同檔。裁決 22 的截斷規則，抽出來才測得到，見設計取捨三）
  - `blockEquals(a: Block, b: Block): boolean`、`blocksEqual(a, b): boolean`（`block-equals.ts`）
  - `NO_RESULT_TEXT`、`HISTORICAL_RAW_TEXT`、`PENDING_RAW_TEXT`、`formatValue(value: unknown): string`
    （`ToolCall.tsx`。文案做成常數是為了讓測試斷言與實作共用同一份字串，改文案不會讓測試變成空轉）

  **下游用法（Task 10 必看）**：`renderToolExtra` 進了 `Turn` 與 `ToolCall` 的 memo 比較函式，
  用參照比較。Task 10 傳進來的函式**必須**用 `useCallback` 包住，否則每次 App 重繪都是新函式，
  兩層 memo 全部失效，等於本 task 的效能工作歸零。另外 `ToolCall` 對每一個 tool block 都會呼叫
  `renderToolExtra`，不只在 `awaiting-approval` 時呼叫，Task 10 自行判斷該不該回傳內容。

  回傳型別一律不標註（不寫 `: JSX.Element`），沿用 Task 9 查證過的慣例：標了就得額外顯式 import
  `JSX` 型別，讓 TS 自己推論則不必。契約的 `export function Conversation(props: ConversationProps): JSX.Element`
  只有回傳標註這一處沒有照抄，參數型別與名稱逐字相同，推論出來的型別也相同。

- [ ] **Step 1: 寫失敗的測試**

先確認 `vitest.config.ts` 的 `test.include` 已經是 `'tests/**/*.test.{ts,tsx}'`（Task 9 改的）。
若還是 `'tests/**/*.test.ts'`，後面兩個測試檔**一次也不會被執行**，而且不是報錯是靜默跳過：
已實測把兩個 `.tsx` 測試檔放進 `tests/` 之後跑 `npx vitest run` 得到「Test Files 4 passed」
（只有既有的 `.ts` 檔），連指名 `npx vitest run tests/conversation.test.tsx` 都回
「No test files found, exiting with code 1」。改成 `{ts,tsx}` 之後同一批檔案跑出「Test Files 6 passed」，
兩種寫法都實跑過。

本 task 只加 coverage 的六個條目，其餘既有條目不動（裁決 19：每個 task 只增刪自己的檔案，
不重寫整份清單）：

```diff
   test: {
     include: ['tests/**/*.test.{ts,tsx}'],
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/renderer/components/block-equals.ts',
+        'src/renderer/components/Conversation.tsx',
+        'src/renderer/components/Turn.tsx',
+        'src/renderer/components/ToolCall.tsx',
+        'src/renderer/components/ThinkingBlock.tsx',
+        'src/renderer/hooks/useConversation.ts',
       ],
     },
   },
```

`tests/conversation.test.tsx`（純渲染，view 全部手工建構，不經過 `fold()`）：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Conversation } from '../src/renderer/components/Conversation.js'
import {
  HISTORICAL_RAW_TEXT,
  NO_RESULT_TEXT,
  PENDING_RAW_TEXT,
} from '../src/renderer/components/ToolCall.js'
import { blockEquals, blocksEqual } from '../src/renderer/components/block-equals.js'
import type { Block, ConversationView, Turn } from '../src/shared/fold.js'
import type { ToolBlock } from '../src/renderer/components/block-equals.js'

afterEach(() => {
  cleanup()
})

/**
 * 工具參數刻意用同一個物件：fold() 是把 Event 上的 input 原樣傳進 Block，
 * 而事件陣列是附加式的、元素本身從不重建，所以真實管線裡同一次工具呼叫的
 * input 在每一幀都是同一個物件參照。測試要模擬這個前提，blockEquals 才是
 * 在測它真正會遇到的輸入。
 */
const LS_INPUT = { command: 'ls' }

function tool(over: Partial<ToolBlock> = {}): ToolBlock {
  return { kind: 'tool', id: 'tu_1', name: 'Bash', input: LS_INPUT, status: 'done', ...over }
}

function viewOf(blocks: readonly Block[], role: Turn['role'] = 'assistant'): ConversationView {
  return { turns: [{ role, messageId: 'msg_1', blocks }], ended: false }
}

/** 展開工具卡片：卡片標頭是唯一的 .tool-head 按鈕。 */
function expand(container: HTMLElement, selector: string): void {
  const head = container.querySelector(selector)
  if (head === null) throw new Error('找不到可展開的標頭：' + selector)
  fireEvent.click(head)
}

describe('Conversation', () => {
  it('沒有任何 turn 時渲染空清單而不崩潰', () => {
    const { container } = render(<Conversation view={{ turns: [], ended: false }} historical={false} />)
    expect(container.querySelector('.conversation-list')).not.toBeNull()
    expect(container.querySelectorAll('.turn')).toHaveLength(0)
  })

  it('user 與 assistant 兩個 turn 各自渲染，順序不變', () => {
    const view: ConversationView = {
      turns: [
        { role: 'user', blocks: [{ kind: 'text', markdown: '幫我看看', complete: true }] },
        { role: 'assistant', messageId: 'msg_1', blocks: [{ kind: 'text', markdown: '好的', complete: true }] },
      ],
      ended: false,
    }
    const { container } = render(<Conversation view={view} historical={false} />)
    const turns = container.querySelectorAll('.turn')
    expect(turns).toHaveLength(2)
    expect(turns[0]?.className).toContain('turn-user')
    expect(turns[0]?.textContent).toContain('幫我看看')
    expect(turns[1]?.className).toContain('turn-assistant')
    expect(turns[1]?.textContent).toContain('好的')
  })

  // 裁決 10：text block 一律拆成 markdown／complete 兩個原始值傳給 Markdown。
  // 表格變成 <table> 證明真的走了 Markdown 的解析管線，不是直接印字串。
  it('text block 交給 Markdown 渲染，markdown 語法真的被解析', () => {
    const { container } = render(
      <Conversation view={viewOf([{ kind: 'text', markdown: '| a | b |\n|---|---|\n| 1 | 2 |', complete: true }])} historical={false} />
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('td')).toHaveLength(2)
  })

  // complete 必須逐 block 傳遞，不能寫死。fold() 讓收過 block-stop 的 block complete=true，
  // 所以「只有最後一個未完成的 block 有游標」是逐字串流時的正確畫面。
  it('只有 complete 為 false 的 text block 尾端有游標', () => {
    const { container } = render(
      <Conversation
        view={viewOf([
          { kind: 'text', markdown: '已完成的第一段', complete: true },
          { kind: 'text', markdown: '還在寫的第二段', complete: false },
        ])}
        historical={false}
      />
    )
    const cursors = container.querySelectorAll('.markdown-cursor')
    expect(cursors).toHaveLength(1)
    const blocks = container.querySelectorAll('.markdown-block')
    expect(blocks[0]?.querySelector('.markdown-cursor')).toBeNull()
    expect(blocks[1]?.querySelector('.markdown-cursor')).not.toBeNull()
  })

  it('thinking block 預設摺疊，點開才看得到內容', () => {
    const { container } = render(
      <Conversation view={viewOf([{ kind: 'thinking', text: '我先確認目錄結構', complete: true }])} historical={false} />
    )
    expect(container.textContent).not.toContain('我先確認目錄結構')
    expand(container, '.thinking-head')
    expect(container.querySelector('.thinking-text')?.textContent).toBe('我先確認目錄結構')
  })

  it('tool block 預設摺疊成一行標頭，點開才看得到參數', () => {
    const { container } = render(<Conversation view={viewOf([tool()])} historical={false} />)
    expect(container.querySelector('.tool-head')?.textContent).toContain('Bash')
    expect(container.querySelector('.tool-body')).toBeNull()
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-input')?.textContent).toContain('"command": "ls"')
  })

  // streaming-input：inputPartial 是半截 JSON，只能原文顯示。
  it('streaming-input 顯示 inputPartial 原文，不嘗試解析', () => {
    const partial = '{"command":"npm ru'
    const { container } = render(
      <Conversation view={viewOf([tool({ status: 'streaming-input', input: undefined, inputPartial: partial })])} historical={false} />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-input-partial')?.textContent).toBe(partial)
    expect(container.querySelector('.tool-input')).toBeNull()
  })

  // 裁決 12：拒絕理由在 deniedReason，不在 result。
  it('denied 顯示 deniedReason，不把 result 當成拒絕理由', () => {
    const { container } = render(
      <Conversation
        view={viewOf([tool({ status: 'denied', deniedReason: '使用者不允許刪除檔案', result: 'Tool call was blocked' })])}
        historical={false}
      />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-denied')?.textContent).toBe('使用者不允許刪除檔案')
    expect(container.textContent).not.toContain('Tool call was blocked')
  })

  // 裁決 15：done 但沒有結果，要說出來而不是留白。
  it('done 且 result 為 undefined 時顯示「工具沒有回傳結果」', () => {
    const { container } = render(
      <Conversation view={viewOf([tool({ status: 'done', result: undefined })])} historical={false} />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-no-result')?.textContent).toBe(NO_RESULT_TEXT)
  })

  it('done 且有 result 時顯示 result，且不顯示「沒有回傳結果」', () => {
    const { container } = render(
      <Conversation view={viewOf([tool({ status: 'done', result: 'total 24\nsrc' })])} historical={false} />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-result')?.textContent).toContain('total 24')
    expect(container.querySelector('.tool-no-result')).toBeNull()
  })

  // 裁決 4：同一個 block（raw 都是 undefined），只有 historical 決定文案。
  // 兩個方向都要驗：漏了任一邊，「文案寫死」與「不看 historical」都測不出來。
  it('historical 為 true 時原始輸出區顯示歷史限制說明，為 false 時不顯示', () => {
    const block = tool({ status: 'done', result: 'ok', raw: undefined })

    const hist = render(<Conversation view={viewOf([block])} historical />)
    expand(hist.container, '.tool-head')
    expect(hist.container.querySelector('.tool-raw-absent')?.textContent).toBe(HISTORICAL_RAW_TEXT)

    cleanup()

    const live = render(<Conversation view={viewOf([block])} historical={false} />)
    expand(live.container, '.tool-head')
    expect(live.container.querySelector('.tool-raw-absent')?.textContent).toBe(PENDING_RAW_TEXT)
    expect(live.container.textContent).not.toContain(HISTORICAL_RAW_TEXT)
  })

  it('live 且有 raw 時顯示未經處理的 stdout 與 stderr', () => {
    const { container } = render(
      <Conversation
        view={viewOf([tool({ raw: { stdout: 'src\ntests', stderr: 'ls: warn', interrupted: false } })])}
        historical={false}
      />
    )
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-stdout')?.textContent).toBe('src\ntests')
    expect(container.querySelector('.tool-stderr')?.textContent).toBe('ls: warn')
  })

  // 規格 §8：不靜默丟棄。
  it('unknown block 可展開看到原始 JSON', () => {
    const raw = { type: 'system', subtype: '沒見過的子型別' }
    const { container } = render(<Conversation view={viewOf([{ kind: 'unknown', raw }])} historical={false} />)
    expect(container.querySelector('.unknown-head')).not.toBeNull()
    expect(container.querySelector('.unknown-raw')).toBeNull()
    expand(container, '.unknown-head')
    expect(container.querySelector('.unknown-raw')?.textContent).toContain('沒見過的子型別')
  })

  it('awaiting-approval：狀態標籤與 renderToolExtra 的結果都不必展開就看得到', () => {
    const block = tool({ status: 'awaiting-approval', input: { command: 'rm -rf /' } })
    const seen: ToolBlock[] = []
    const renderToolExtra = (b: ToolBlock) => {
      seen.push(b)
      return <div className="approval-card">要執行 {b.name} 嗎</div>
    }
    const { container } = render(
      <Conversation view={viewOf([block])} historical={false} renderToolExtra={renderToolExtra} />
    )
    expect(container.querySelector('.tool-status')?.textContent).toBe('等待批准')
    expect(container.querySelector('.tool-extra .approval-card')?.textContent).toBe('要執行 Bash 嗎')
    // 等待批准時預設展開，使用者不必多按一下就看得到完整 input（規格 §6）
    expect(container.querySelector('.tool-input')?.textContent).toContain('rm -rf /')
    expect(seen[0]).toBe(block)
  })

  it('renderToolExtra 沒給時不影響渲染，工具卡片照常出現', () => {
    const { container } = render(<Conversation view={viewOf([tool()])} historical={false} />)
    expect(container.querySelector('.tool-call')).not.toBeNull()
    expect(container.querySelector('.tool-extra')?.textContent).toBe('')
  })

  // memo 的比較函式漏欄位會讓畫面停在舊狀態。fold() 每幀產生全新的 Block 物件，
  // 所以這裡刻意用「內容不同但形狀相同」的新物件重繪。
  it('狀態從 running 變成 done 時，標頭的狀態標籤要跟著換（memo 比較函式不得漏欄位）', () => {
    const view1 = viewOf([tool({ status: 'running' })])
    const { container, rerender } = render(<Conversation view={view1} historical={false} />)
    expect(container.querySelector('.tool-status')?.textContent).toBe('執行中')

    // 只改 status，其餘欄位（含 result）逐字相同：這樣 memo 的比較函式若漏了 status，
    // 就沒有別的欄位替它把不相等這件事撿回來，突變才測得到。
    const view2 = viewOf([tool({ status: 'done' })])
    rerender(<Conversation view={view2} historical={false} />)
    expect(container.querySelector('.tool-status')?.textContent).toBe('完成')
  })

  it('串流中的 text 每幀變長時畫面跟著變長', () => {
    const { container, rerender } = render(
      <Conversation view={viewOf([{ kind: 'text', markdown: '第一', complete: false }])} historical={false} />
    )
    expect(container.textContent).toContain('第一')
    rerender(<Conversation view={viewOf([{ kind: 'text', markdown: '第一段更長', complete: false }])} historical={false} />)
    expect(container.textContent).toContain('第一段更長')
  })

  it('blockEquals 分辨 thinking／unknown 與跨型別的比較', () => {
    expect(blockEquals({ kind: 'thinking', text: 'x', complete: true }, { kind: 'thinking', text: 'x', complete: true })).toBe(true)
    expect(blockEquals({ kind: 'thinking', text: 'x', complete: true }, { kind: 'thinking', text: 'y', complete: true })).toBe(false)
    const raw = { note: '沒見過' }
    expect(blockEquals({ kind: 'unknown', raw }, { kind: 'unknown', raw })).toBe(true)
    expect(blockEquals({ kind: 'unknown', raw }, { kind: 'unknown', raw: { note: '沒見過' } })).toBe(false)
    expect(blockEquals({ kind: 'text', markdown: 'a', complete: true }, { kind: 'thinking', text: 'a', complete: true })).toBe(false)
    expect(blockEquals(tool(), { kind: 'unknown', raw: null })).toBe(false)
  })

  it('blocksEqual 逐項比較，長度不同直接判不等', () => {
    const a: readonly Block[] = [{ kind: 'text', markdown: 'x', complete: true }]
    expect(blocksEqual(a, a)).toBe(true)
    expect(blocksEqual(a, [{ kind: 'text', markdown: 'x', complete: true }])).toBe(true)
    expect(blocksEqual(a, [...a, { kind: 'text', markdown: 'y', complete: false }])).toBe(false)
  })

  it('blockEquals 認得內容相同的兩個新物件，也認得欄位不同', () => {
    const sharedRaw = { stdout: 'a', stderr: '', interrupted: false }
    expect(blockEquals(tool({ raw: sharedRaw }), tool({ raw: sharedRaw }))).toBe(true)
    expect(blockEquals(tool(), tool())).toBe(true)
    expect(blockEquals(tool(), tool({ status: 'error' }))).toBe(false)
    expect(blockEquals(tool(), tool({ deniedReason: '不給' }))).toBe(false)
    expect(blockEquals(tool(), tool({ raw: { stdout: 'a', stderr: '', interrupted: false } }))).toBe(false)
    expect(blockEquals({ kind: 'text', markdown: 'a', complete: false }, { kind: 'text', markdown: 'a', complete: true })).toBe(false)
    // input 用參照比較：內容相同但是不同物件時判為不等，代價只是多重繪一次，
    // 不會讓畫面停在舊資料（比較保守的方向）。
    expect(blockEquals(tool(), tool({ input: { command: 'ls' } }))).toBe(false)
  })

  it('input 含迴圈參照時不讓整個 turn 崩潰', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular['self'] = circular
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { container } = render(<Conversation view={viewOf([tool({ input: circular })])} historical={false} />)
    expand(container, '.tool-head')
    expect(container.querySelector('.tool-input')?.textContent).toContain('object')
    spy.mockRestore()
  })

  // 裁決 17：session-end 帶 isError:true 時 fold() 會在 ConversationView 上設 error，
  // Conversation 要把它畫成一張獨立的錯誤卡片，不影響既有 cost 卡片的位置與條件。
  it('view.error 存在時渲染錯誤卡片，含標題、message 與 API 狀態', () => {
    const view: ConversationView = {
      turns: [{ role: 'assistant', messageId: 'msg_1', blocks: [{ kind: 'text', markdown: '算到一半', complete: false }] }],
      ended: true,
      error: { message: 'SDK 連線中斷', apiErrorStatus: 529 },
    }
    const { container } = render(<Conversation view={view} historical={false} />)
    const card = container.querySelector('[role="alert"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('對話因錯誤結束')
    expect(card?.textContent).toContain('SDK 連線中斷')
    expect(card?.textContent).toContain('API 狀態：529')
  })

  // ended 刻意是 true：驗的是「error 沒有值」這件事本身觸發不出卡片，不是靠「對話還沒結束」
  // 這個巧合擋住（否則把顯示條件誤改成看 view.ended 也會通過，見 Step 5 的 M8）。
  it('view.error 不存在時沒有錯誤卡片，即使對話已經正常結束', () => {
    const view: ConversationView = {
      turns: [{ role: 'assistant', messageId: 'msg_1', blocks: [{ kind: 'text', markdown: '正常結束', complete: true }] }],
      ended: true,
    }
    const { container } = render(<Conversation view={view} historical={false} />)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
```

`tests/use-conversation.test.tsx`（hook 與 App 的接線。App 的輸入框測試放這裡而不是另開第三個檔案，
因為它跟 hook 用的是同一個假 `YesChefApi`，兩者測的都是「renderer 怎麼接上 `window.yeschef`」）：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { appendEvents, useConversation } from '../src/renderer/hooks/useConversation.js'
import { App, LIVE_PLACEHOLDER, VIEWING_PLACEHOLDER } from '../src/renderer/App.js'
import { HISTORICAL_RAW_TEXT } from '../src/renderer/components/ToolCall.js'
import type { Event } from '../src/shared/events.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { YesChefApi, SessionSummary } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

interface Fake {
  readonly api: YesChefApi
  emitEvents(events: readonly Event[]): void
  emitState(state: SessionState): void
  readonly sent: string[]
  readonly unsubscribed: () => number
}

/**
 * 假的 YesChefApi。只實作 Task 9B 會用到的三個成員，其餘照介面補上會拋錯的樁，
 * 這樣元件若不小心呼叫了不該呼叫的東西，測試會直接炸而不是靜默通過。
 */
function createFake(): Fake {
  const eventCbs: Array<(events: readonly Event[]) => void> = []
  const stateCbs: Array<(state: SessionState) => void> = []
  const sent: string[] = []
  let unsubscribed = 0

  const api: YesChefApi = {
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
    sendInput(text) {
      sent.push(text)
    },
    replyApproval() {
      throw new Error('Task 9B 不該呼叫 replyApproval')
    },
    listSessions(): Promise<readonly SessionSummary[]> {
      throw new Error('Task 9B 不該呼叫 listSessions')
    },
    startNew() {
      throw new Error('Task 9B 不該呼叫 startNew')
    },
    openHistory() {
      throw new Error('Task 9B 不該呼叫 openHistory')
    },
    projectDir: '/Users/x/Projects/demo',
  }

  return {
    api,
    emitEvents(events) {
      act(() => {
        eventCbs.forEach((cb) => cb(events))
      })
    },
    emitState(state) {
      act(() => {
        stateCbs.forEach((cb) => cb(state))
      })
    },
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
    const { result } = renderHook(() => useConversation(fake.api))
    expect(result.current.sessionState).toEqual({ kind: 'idle' })
    expect(result.current.view.turns).toHaveLength(0)
  })

  it('多批事件以不可變方式累積，先後順序不變', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

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
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitEvents([say('上一場的話')])
    fake.emitEvents([RESET, say('第一句'), say('第二句')])

    expect(result.current.view.turns.map((t) => t.blocks[0])).toEqual([
      { kind: 'text', markdown: '第一句', complete: true },
      { kind: 'text', markdown: '第二句', complete: true },
    ])
  })

  it('reset 自己走一批也算數，之後的事件從空畫面重新累積', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

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
    const { result } = renderHook(() => useConversation(fake.api))

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
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitState({ kind: 'live', sessionId: 's-1' })
    fake.emitEvents([say('跑一下'), { kind: 'session-end', isError: true, errorMessage: '連線中斷' }])
    fake.emitState({ kind: 'idle' })

    expect(result.current.view.turns).toHaveLength(1)
    expect(result.current.view.error?.message).toBe('連線中斷')
  })

  it('viewing 變 live（輸入即 resume）不清事件，歷史留在畫面上', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitState({ kind: 'viewing', sessionId: 's-a' })
    fake.emitEvents([say('歷史的一句')])
    fake.emitState({ kind: 'live', sessionId: 's-a' })

    expect(result.current.sessionState).toEqual({ kind: 'live', sessionId: 's-a' })
    expect(result.current.view.turns).toHaveLength(1)
  })

  it('同一場的狀態重送不清空已累積的事件', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api))

    fake.emitState({ kind: 'live', sessionId: 's-1' })
    fake.emitEvents([say('串到一半')])
    fake.emitState({ kind: 'live', sessionId: 's-1' })

    expect(result.current.view.turns).toHaveLength(1)
  })

  it('unmount 時兩個訂閱都解除', () => {
    const fake = createFake()
    const { unmount } = renderHook(() => useConversation(fake.api))
    unmount()
    expect(fake.unsubscribed()).toBe(2)
  })
})

describe('App', () => {
  it('Enter 送出並清空輸入框', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    const input = container.querySelector('textarea')
    if (input === null) throw new Error('找不到輸入框')

    fireEvent.change(input, { target: { value: '幫我跑測試' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(fake.sent).toEqual(['幫我跑測試'])
    expect(input.value).toBe('')
  })

  it('Shift+Enter 不送出，內容保留', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
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
    const input = container.querySelector('textarea')
    expect(input?.placeholder).toBe(LIVE_PLACEHOLDER)

    fake.emitState({ kind: 'viewing', sessionId: 's-1' })
    expect(input?.placeholder).toBe(VIEWING_PLACEHOLDER)
  })

  it('事件到達時對話出現在畫面上', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

    fake.emitEvents([say('你好'), { kind: 'text', messageId: 'm1', index: 0, text: '哈囉' }])

    expect(container.querySelector('.conversation-list')?.textContent).toContain('你好')
    expect(container.querySelector('.conversation-list')?.textContent).toContain('哈囉')
  })

  // 裁決 4 的端到端接線：historical 是從 sessionState.kind 推出來的，不是寫死的 prop。
  it('viewing 時工具卡片展開後顯示歷史對話沒有原始輸出', () => {
    const fake = createFake()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

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
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`
Expected: FAIL，訊息是解析不到 `../src/renderer/components/Conversation.js`、`ToolCall.js`、
`block-equals.js`、`../src/renderer/hooks/useConversation.js`（檔案都還不存在），
以及 `App.js` 沒有匯出 `LIVE_PLACEHOLDER`／`VIEWING_PLACEHOLDER`。
若看到「No test files found, exiting with code 1」，是 Task 9 的 `include` glob 沒改到，不是預期的失敗。

- [ ] **Step 3: 寫最小實作**

沒有新相依。Task 9 已經裝好 `react`／`react-dom`／`@types/react`／`@types/react-dom`／
`@testing-library/react`／`jsdom`，也已經在 `tsconfig.json` 加了 `"jsx": "react-jsx"`。

**3a. `src/renderer/components/block-equals.ts`**（純函式，memo 的比較依據）：

```typescript
import type { Block } from '../../shared/fold.js'

export type ToolBlock = Extract<Block, { kind: 'tool' }>

function rawEquals(a: ToolBlock['raw'], b: ToolBlock['raw']): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return a.stdout === b.stdout && a.stderr === b.stderr && a.interrupted === b.interrupted
}

export function blockEquals(a: Block, b: Block): boolean {
  if (a === b) return true
  switch (a.kind) {
    case 'text':
      return b.kind === 'text' && a.markdown === b.markdown && a.complete === b.complete
    case 'thinking':
      return b.kind === 'thinking' && a.text === b.text && a.complete === b.complete
    case 'unknown':
      return b.kind === 'unknown' && Object.is(a.raw, b.raw)
    case 'tool':
      return (
        b.kind === 'tool' &&
        a.id === b.id &&
        a.name === b.name &&
        a.status === b.status &&
        a.inputPartial === b.inputPartial &&
        a.deniedReason === b.deniedReason &&
        Object.is(a.input, b.input) &&
        Object.is(a.result, b.result) &&
        rawEquals(a.raw, b.raw)
      )
  }
}

export function blocksEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((block, i) => {
    const other = b[i]
    return other !== undefined && blockEquals(block, other)
  })
}
```

`input`／`result` 用 `Object.is`、`raw` 逐欄位比，理由見開頭的設計取捨一。`unknown` 的 `raw` 同樣用
參照比較：它是 Task 3 直接從原始訊息帶過來的物件，同一筆事件在每一幀都是同一個參照。

**3b. `src/renderer/components/ToolCall.tsx`**：

```tsx
import { memo, useState, type ReactNode } from 'react'
import { blockEquals, type ToolBlock } from './block-equals.js'

export interface ToolCallProps {
  readonly block: ToolBlock
  readonly historical: boolean
  readonly renderExtra?: (block: ToolBlock) => ReactNode
}

const STATUS_LABEL: Record<ToolBlock['status'], string> = {
  'streaming-input': '接收參數中',
  'awaiting-approval': '等待批准',
  denied: '已拒絕',
  running: '執行中',
  done: '完成',
  error: '失敗',
}

export const NO_RESULT_TEXT = '工具沒有回傳結果'
export const HISTORICAL_RAW_TEXT = '這是歷史對話，沒有保存原始輸出'
export const PENDING_RAW_TEXT = '尚未收到原始輸出'

/** JSON.stringify 會對迴圈參照丟例外，也會對 undefined 回傳 undefined，兩種都要接住。 */
export function formatValue(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function ToolCallImpl({ block, historical, renderExtra }: ToolCallProps) {
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  const open = override ?? block.status === 'awaiting-approval'
  const settled = block.status === 'done' || block.status === 'error'

  return (
    <section className="tool-call" data-status={block.status}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        <span className="tool-name">{block.name === '' ? '（未知工具）' : block.name}</span>
        <span className="tool-status">{STATUS_LABEL[block.status]}</span>
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>

      {open && (
        <div className="tool-body">
          <h4 className="tool-section-title">參數</h4>
          {block.status === 'streaming-input' ? (
            <pre className="tool-input-partial">{block.inputPartial ?? ''}</pre>
          ) : (
            <pre className="tool-input">
              {block.input === undefined ? '（沒有收到參數）' : formatValue(block.input)}
            </pre>
          )}

          {block.status === 'denied' && (
            <>
              <h4 className="tool-section-title">拒絕原因</h4>
              <p className="tool-denied">{block.deniedReason ?? '（沒有提供拒絕原因）'}</p>
            </>
          )}

          {settled && (
            <>
              <h4 className="tool-section-title">結果</h4>
              {block.result === undefined ? (
                <p className="tool-no-result">{NO_RESULT_TEXT}</p>
              ) : (
                <pre className="tool-result">{formatValue(block.result)}</pre>
              )}
            </>
          )}

          <h4 className="tool-section-title">原始輸出</h4>
          {historical ? (
            <p className="tool-raw-absent">{HISTORICAL_RAW_TEXT}</p>
          ) : block.raw === undefined ? (
            <p className="tool-raw-absent">{PENDING_RAW_TEXT}</p>
          ) : (
            <div className="tool-raw">
              <pre className="tool-stdout">{block.raw.stdout}</pre>
              <pre className="tool-stderr">{block.raw.stderr}</pre>
              {block.raw.interrupted && <p className="tool-interrupted">執行被中斷</p>}
            </div>
          )}
        </div>
      )}

      <div className="tool-extra">{renderExtra?.(block)}</div>
    </section>
  )
}

export const ToolCall = memo(
  ToolCallImpl,
  (prev, next) =>
    blockEquals(prev.block, next.block) &&
    prev.historical === next.historical &&
    prev.renderExtra === next.renderExtra
)
```

四個對應裁決的地方，都刻意寫成三個分支而不是「有值就顯示」：`streaming-input` 走
`inputPartial` 原文（半截 JSON 不能 parse），`denied` 走 `deniedReason`（裁決 12），
`done`／`error` 沒有 `result` 時說出「沒有回傳結果」（裁決 15），原始輸出區在 `historical`
為真時說明歷史對話沒有保存（裁決 4）。每一格都有文字，沒有任何一個狀態會給出空白區塊。

**3c. `src/renderer/components/ThinkingBlock.tsx`**：

```tsx
import { memo, useState } from 'react'

export interface ThinkingBlockProps {
  readonly text: string
  readonly complete: boolean
}

function ThinkingBlockImpl({ text, complete }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  return (
    <section className="thinking-block">
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {complete ? '思考過程' : '思考中'}
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && <pre className="thinking-text">{text}</pre>}
    </section>
  )
}

export const ThinkingBlock = memo(ThinkingBlockImpl)
```

thinking 的 props 是兩個原始值（裁決 10 對 `Markdown` 的同一個理由），所以這裡用預設的淺比較就夠，
不必自訂比較函式。thinking 內容不走 markdown 解析：它是模型的內部推理，用 `<pre>` 原樣呈現最誠實。

**3d. `src/renderer/components/Turn.tsx`**：

```tsx
import { memo, useState, type ReactNode } from 'react'
import type { Block, Turn as TurnModel } from '../../shared/fold.js'
import { Markdown } from './Markdown.js'
import { ThinkingBlock } from './ThinkingBlock.js'
import { ToolCall, formatValue } from './ToolCall.js'
import { blocksEqual, type ToolBlock } from './block-equals.js'

export interface TurnProps {
  readonly turn: TurnModel
  readonly historical: boolean
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
}

/** 規格 §8：認不出來的事件渲染成可展開的原始 JSON，不靜默丟棄。 */
function UnknownBlock({ raw }: { readonly raw: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="unknown-block">
      <button
        type="button"
        className="unknown-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        未知事件
        <span className="chevron" aria-hidden="true">{open ? '⌄' : '›'}</span>
      </button>
      {open && <pre className="unknown-raw">{formatValue(raw)}</pre>}
    </section>
  )
}

function renderBlock(
  block: Block,
  index: number,
  historical: boolean,
  renderToolExtra?: (block: ToolBlock) => ReactNode
) {
  switch (block.kind) {
    case 'text':
      return <Markdown key={index} markdown={block.markdown} complete={block.complete} />
    case 'thinking':
      return <ThinkingBlock key={index} text={block.text} complete={block.complete} />
    case 'tool':
      return (
        <ToolCall
          key={index}
          block={block}
          historical={historical}
          {...(renderToolExtra === undefined ? {} : { renderExtra: renderToolExtra })}
        />
      )
    case 'unknown':
      return <UnknownBlock key={index} raw={block.raw} />
  }
}

const ROLE_LABEL: Record<TurnModel['role'], string> = { user: '你', assistant: 'Claude' }

function TurnImpl({ turn, historical, renderToolExtra }: TurnProps) {
  return (
    <article className={'turn turn-' + turn.role}>
      <div className="turn-role">{ROLE_LABEL[turn.role]}</div>
      <div className="turn-blocks">
        {turn.blocks.map((block, i) => renderBlock(block, i, historical, renderToolExtra))}
      </div>
    </article>
  )
}

export const Turn = memo(
  TurnImpl,
  (prev, next) =>
    prev.historical === next.historical &&
    prev.renderToolExtra === next.renderToolExtra &&
    prev.turn.role === next.turn.role &&
    prev.turn.messageId === next.turn.messageId &&
    blocksEqual(prev.turn.blocks, next.turn.blocks)
)
```

`renderBlock` 的 `switch` 沒有 `default`：`Block` 是四選一的聯集，少處理一種 TS 會在編譯期報錯，
這比執行期的 fallback 早得多。block 的 key 用陣列索引，因為 `fold()` 產出的 block 只會在尾端增加或
原地取代，不會重新排序（`placeBlock` 命中時是 `records.map` 就地換掉，順序不動）。

`renderToolExtra` 為 `undefined` 時用展開語法整個不傳，而不是傳 `renderExtra={undefined}`：
兩者對 React 是同一件事，但前者在 `exactOptionalPropertyTypes` 之類的嚴格設定下也成立。

**3e. `src/renderer/components/Conversation.tsx`**：

```tsx
import type { ReactNode } from 'react'
import type { ConversationView } from '../../shared/fold.js'
import { Turn } from './Turn.js'
import type { ToolBlock } from './block-equals.js'
import './Conversation.css'

export type { ToolBlock }

export interface ConversationProps {
  readonly view: ConversationView
  readonly historical: boolean
  readonly renderToolExtra?: (block: ToolBlock) => ReactNode
}

export function Conversation({ view, historical, renderToolExtra }: ConversationProps) {
  return (
    <div className="conversation-list">
      {view.turns.map((turn, i) => (
        <Turn
          key={turn.messageId ?? 'turn-' + String(i)}
          turn={turn}
          historical={historical}
          {...(renderToolExtra === undefined ? {} : { renderToolExtra })}
        />
      ))}
      {view.error !== undefined && (
        <div className="error-card" role="alert">
          <p className="error-title">對話因錯誤結束</p>
          {view.error.message !== undefined && <p className="error-message">{view.error.message}</p>}
          {view.error.apiErrorStatus !== undefined && (
            <p className="error-status">API 狀態：{String(view.error.apiErrorStatus)}</p>
          )}
        </div>
      )}
      {view.ended && view.cost !== undefined && (
        <p className="conversation-cost">
          {view.cost.turns === undefined ? '' : String(view.cost.turns) + ' 輪'}
          {view.cost.usd === undefined ? '' : ' · US$' + view.cost.usd.toFixed(4)}
        </p>
      )}
    </div>
  )
}
```

`Conversation` 本身不包 memo：它的 `view` prop 每幀都是新物件，包了也不會命中，而它自己只做一次
`map`，成本在 `Turn` 那一層擋掉就夠了。turn 的 key 優先用 `messageId`（assistant turn 的穩定身分），
user turn 沒有 `messageId`，退回索引，這也是穩定的，因為 turn 只會在尾端增加。

`cost` 那一段是規格 §8「SDK query 中途錯誤要渲染成卡片」的一半：`session-end` 帶回來的花費與
輪數顯示在對話尾端。另一半是裁決 17 定案的 `.error-card`：`view.error` 存在時（`fold()` 收到
`isError: true` 的 `session-end` 時設定，`isError: false` 時不設，屬於 Task 4 的範圍，本 task
只假設欄位存在並渲染）在 turns 之後、cost 卡片之前顯示一張卡片，`message`／`apiErrorStatus`
各自有值才顯示對應那一行，位置與 cost 卡片互不影響，cost 卡片原本的顯示條件不變。

**3f. `src/renderer/components/Conversation.css`**：

```css
.conversation-list { flex: 1 1 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding: 16px; }
.turn { display: grid; grid-template-columns: 72px 1fr; gap: 12px; }
.turn-role { opacity: 0.6; }
.tool-call, .thinking-block, .unknown-block { border: 1px solid #2a2d24; border-radius: 6px; }
.tool-head, .thinking-head, .unknown-head {
  display: flex; gap: 8px; width: 100%; padding: 6px 10px;
  background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.tool-status { opacity: 0.6; }
.chevron { margin-left: auto; }
.tool-body { padding: 0 10px 10px; }
.tool-section-title { margin: 8px 0 4px; font-size: 0.85em; opacity: 0.6; font-weight: normal; }
.tool-input, .tool-input-partial, .tool-result, .tool-stdout, .tool-stderr, .thinking-text, .unknown-raw {
  margin: 0; padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
}
.tool-stderr:empty { display: none; }
.tool-raw-absent, .tool-no-result { opacity: 0.6; font-style: italic; }
.tool-call[data-status='denied'] { border-color: #6d3b3b; }
.tool-call[data-status='error'] { border-color: #6d5a3b; }
.tool-call[data-status='awaiting-approval'] { border-color: #3b556d; }
.error-card { border: 1px solid #6d3b3b; border-radius: 6px; padding: 10px; }
.error-title { margin: 0 0 4px; font-weight: bold; }
.error-message, .error-status { margin: 4px 0 0; opacity: 0.8; }
.conversation-cost { opacity: 0.5; font-size: 0.85em; }
```

`data-status` 放在 DOM 上讓狀態的顏色由 CSS 決定，元件不必為了配色多帶一組 className。
`.tool-stderr:empty` 讓沒有 stderr 的工具不會多出一塊空白，但 DOM 節點仍在（測試可以斷言它是空字串，
而不是斷言它不存在，兩者的意思不一樣）。

**3g. `src/renderer/hooks/useConversation.ts`**：

```typescript
import { useEffect, useMemo, useState } from 'react'
import type { Event } from '../../shared/events.js'
import type { YesChefApi } from '../../shared/ipc.js'
import type { SessionState } from '../../shared/session-state.js'
import { fold, type ConversationView } from '../../shared/fold.js'

export const INITIAL_SESSION_STATE: SessionState = { kind: 'idle' }

interface Accumulated {
  readonly state: SessionState
  readonly events: readonly Event[]
}

const INITIAL_ACCUMULATED: Accumulated = { state: INITIAL_SESSION_STATE, events: [] }

/** 批次裡最後一個 reset 的位置，沒有就是 -1。不用 Array.prototype.findLastIndex：那是 ES2023，
 *  tsconfig 的 target 是 ES2022，型別上看不到它。 */
function lastResetIndex(batch: readonly Event[]): number {
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    if (batch[i]?.kind === 'reset') return i
  }
  return -1
}

/**
 * 附加一批事件（裁決 22）。批次裡有 `reset` 時，只保留最後一個 `reset` 之後的事件，
 * 先前累積的全部丟掉，`reset` 本身也不留。
 *
 * `fold()` 自己也認得 `reset`，所以這裡少截一次不會讓畫面出錯，只會讓累積陣列一直長下去。
 * 抽成匯出的純函式是為了讓那件事測得到（Step 5 的 M1）。
 */
export function appendEvents(
  prev: readonly Event[],
  batch: readonly Event[]
): readonly Event[] {
  const cut = lastResetIndex(batch)
  return cut === -1 ? [...prev, ...batch] : batch.slice(cut + 1)
}

export function useConversation(api: YesChefApi): {
  readonly view: ConversationView
  readonly sessionState: SessionState
} {
  const [acc, setAcc] = useState<Accumulated>(INITIAL_ACCUMULATED)

  useEffect(() => {
    const offEvents = api.onEvents((batch) => {
      setAcc((prev) =>
        batch.length === 0 ? prev : { ...prev, events: appendEvents(prev.events, batch) }
      )
    })
    const offState = api.onSessionState((next) => {
      setAcc((prev) => ({ ...prev, state: next }))
    })
    return () => {
      offEvents()
      offState()
    }
  }, [api])

  const view = useMemo(() => fold(acc.events), [acc.events])
  return { view, sessionState: acc.state }
}
```

三個細節：空批次直接回原本的 state（不產生新物件，省掉一次沒有內容的重繪）；事件用展開語法附加，
不用 `push`（不可變規則）；`useMemo` 的依賴是 `acc.events` 這個陣列的參照，只有真的收到新事件時
才會重跑 `fold()`，`sessionState` 自己變動不會觸發整份重算。

`onSessionState` 這一支只換 `state`，任何情況都不動 `events`（裁決 22）。主程序在同一場對話裡重送
同一個狀態、query 結束後從 `live` 回到 `idle`、輸入接續歷史時從 `viewing` 轉 `live`，這三種到達都不會
影響畫面內容。

`useEffect` 的依賴是 `[api]`。實務上 `window.yeschef` 由 preload 建立一次就不再變，所以訂閱只做一次；
測試裡傳的假 api 也是同一個物件。若哪天 api 真的換了，effect 會先解除舊訂閱再訂閱新的，不會漏掉清理。

**3h. `src/renderer/App.tsx`**（Task 9 的版本改兩處：對話佔位換成真的 `Conversation`，加輸入框）：

```tsx
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Conversation } from './components/Conversation.js'
import { useConversation } from './hooks/useConversation.js'
import type { SessionState } from '../shared/session-state.js'
import './App.css'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly onSend: (text: string) => void
}

function Composer({ placeholder, onSend }: ComposerProps) {
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
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="composer-send">送出</button>
    </form>
  )
}

function placeholderFor(state: SessionState): string {
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

export function App() {
  const { view, sessionState } = useConversation(window.yeschef)

  return (
    <div className="app">
      <aside className="sidebar">
        <p className="placeholder">Recents（Task 11）</p>
      </aside>
      <main className="conversation">
        <Conversation view={view} historical={sessionState.kind === 'viewing'} />
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => window.yeschef.sendInput(text)}
        />
      </main>
    </div>
  )
}
```

`<aside className="sidebar">` 那一段維持 Task 9 交出來的樣子，本 task 一個字都不動（含它的寬度寫法）。

`e.nativeEvent.isComposing` 這一行是給中文輸入用的：注音或拼音選字時按的 Enter 會先走一次 keydown，
沒有這個判斷會在選字的當下把半成品送出去。這是 macOS 上用中文輸入的人每天都會踩到的情況，不是假想威脅。

送出前 `trim()`，空白字串不送：規格沒有明文，但送一則只有空白的訊息會白白起一次 query。
`Composer` 自己持有輸入文字，不上提到 `App`：文字只有送出的那一刻需要被外面知道。

批准時「輸入框停用」（規格 §6）本 task 不做：判斷依據是有沒有待決的批准請求，
而那份資料由 Task 10 的 `useApprovals` 持有。Task 10 接手時給 `Composer` 加一個 `disabled` prop 即可。

**3i. `src/renderer/App.css`**（`.conversation` 改一條、加 `.composer` 與 `.composer-input` 兩條；下面是改完之後的完整檔案，逐字取代 Task 9 那一份。`html, body, #root`／`.app`／`.sidebar` 三條與 Task 9 相同，一字不改）：

```css
html,
body,
#root {
  height: 100%;
  margin: 0;
}

.app {
  --sidebar-width: 280px;

  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  height: 100%;
  font-family: ui-monospace, Menlo, monospace;
  color: #d8dcd4;
  background: #12140f;
}

.sidebar {
  border-right: 1px solid #2a2d24;
  overflow-y: auto;
}

.conversation { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.placeholder { padding: 12px; opacity: 0.6; }
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #2a2d24; }
.composer-input { flex: 1 1 auto; resize: vertical; font: inherit; }
```

捲動從 `.conversation` 移到 `.conversation-list`：輸入框要固定在底部，只有訊息清單捲動。
`min-height: 0` 是 flex 子項要能捲動的必要條件（預設 `min-height: auto` 會讓它被內容撐開而不出現捲軸）。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`
Expected: PASS，43 個測試（`conversation` 23、`use-conversation` 20）。已在 worktree 用材料化的
`fold.ts`（含裁決 17 的 `ConversationView.error?` 欄位與裁決 22 的 `case 'reset'`）實測，實際輸出是
「Test Files 2 passed (2)」「Tests 43 passed (43)」。

Run: `npm run typecheck`
Expected: 無錯誤。已在 worktree 實測 `npx tsc --noEmit` 退出碼 0。實測的前提是先把
`src/renderer/terminal.ts`、`src/preload/terminal.ts`、`src/main/pty-host.ts`（Task 0 刪除）、
`src/main/index.ts`（Task 0 改寫）、`tests/ipc.test.ts`（Task 8 改寫）移出去，否則它們對舊
`shared/ipc.ts` 的引用會蓋掉真正的錯誤訊息。本 task 產出的九個檔案自身沒有任何型別錯誤。

Run: `npm test`
Expected: PASS，總數在既有基礎上加 43。全專案總數要看當下材料化了哪些上游 task，本次修訂的
worktree（Task 3／4／4B／5／8 的 shared 型別與 `global.d.ts`、Task 9／9B／10 的程式碼與測試，
加上 repo 既有的 `cdp`／`layout`／`measure-memory`／`spawn-args` 四個測試檔）跑出來是
「Test Files 9 passed，Tests 139 passed」。

Run: `npx vitest run --coverage`
Expected: 新增檔案的敘述覆蓋率都在 89% 以上。下表是 2026-09-02 晚間依裁決 22 修訂後，用
`npx vitest run --coverage tests/conversation.test.tsx tests/use-conversation.test.tsx` 實測的值
（coverage 的 `include` 暫時加上 `src/renderer/**/*.{ts,tsx}` 才量得到元件）。

| 檔案 | % Stmts | % Branch |
|---|---:|---:|
| `Conversation.tsx` | 100 | 88.23 |
| `ToolCall.tsx` | 93.75 | 75.67 |
| `ThinkingBlock.tsx` | 100 | 83.33 |
| `block-equals.ts` | 89.47 | 84.21 |
| `useConversation.ts` | 100 | 83.33 |

`Turn.tsx` 與 `Markdown.tsx` 兩個檔案在 v8 provider 的報表裡沒有出現獨立的一列（元件層的測試
確實渲染過它們，M5 的突變也是掛在 `Turn.tsx` 上並且變紅）。這兩列的數字暫缺，實作者跑
`--coverage` 時若看到它們就照實補上。

未覆蓋的分支都是防禦性的空值處理（`inputPartial ?? ''`、`deniedReason ?? '（沒有提供拒絕原因）'`、
`name === '' ? '（未知工具）'`、`interrupted` 為真的那一支）。這些在正常資料流下不會發生，
留著是因為它們代表「資料缺了也要有東西可看」，不是死碼。

- [ ] **Step 5: 突變測試（強制步驟，八個突變全部實跑過）**

每一個突變都照 Step 3 的完整程式碼改過、跑
`npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`（43 個測試）、
記下變紅的測試名稱、還原、確認回綠。

| # | 突變 | 變紅的測試 | 實測結果 |
|---|---|---|---|
| M1（強制：裁決 22 的 reset） | `appendEvents` 的 `return cut === -1 ? [...prev, ...batch] : batch.slice(cut + 1)` 改成一律 `return [...prev, ...batch]` | 「批次裡有 reset 時只留它之後的事件，先前累積的與 reset 本身都不留」「批次裡有兩個 reset 時以最後一個為準」「批次只有 reset 時回空陣列」 | 紅，3 failed / 40 passed。三條都在 `appendEvents` 那一組 |
| M2（強制：裁決 4 的文案開關） | `ToolCall` 的 `{historical ? <p>{HISTORICAL_RAW_TEXT}</p> : block.raw === undefined ? ...}` 拿掉 `historical` 那一支 | 「historical 為 true 時原始輸出區顯示歷史限制說明，為 false 時不顯示」「viewing 時工具卡片展開後顯示歷史對話沒有原始輸出」 | 紅，2 failed / 41 passed。歷史對話的工具改顯示「尚未收到原始輸出」，等於告訴使用者再等一下，而它永遠不會來 |
| M3（裁決 12） | 拒絕原因那一行改成 `{formatValue(block.result)}`（Task 4B 定稿前的做法） | 「denied 顯示 deniedReason，不把 result 當成拒絕理由」 | 紅，1 failed / 42 passed。畫面顯示 SDK 合成的 `Tool call was blocked`，而不是使用者拒絕的理由 |
| M4（裁決 15） | 結果區改成無條件的 `<pre className="tool-result">{formatValue(block.result)}</pre>` | 「done 且 result 為 undefined 時顯示『工具沒有回傳結果』」 | 紅，1 failed / 42 passed。`formatValue(undefined)` 回空字串，畫面是一塊空白 |
| M5 | `Turn` 的 `<Markdown ... complete={block.complete} />` 改成 `complete` 寫死 | 「只有 complete 為 false 的 text block 尾端有游標」 | 紅，1 failed / 42 passed。串流中的最後一段沒有游標，看起來像已經講完 |
| M6 | `blockEquals` 的 tool 分支拿掉 `a.status === b.status &&` | 「狀態從 running 變成 done 時，標頭的狀態標籤要跟著換（memo 比較函式不得漏欄位）」「blockEquals 認得內容相同的兩個新物件，也認得欄位不同」 | 紅，2 failed / 41 passed |
| M7 | `streaming-input` 的參數區改成 `{formatValue(block.input)}` | 「streaming-input 顯示 inputPartial 原文，不嘗試解析」 | 紅，1 failed / 42 passed。串流中的 `input` 還是 undefined，畫面全空 |
| M8（裁決 17，強制） | `Conversation` 錯誤卡片的顯示條件從 `view.error !== undefined` 改成 `view.ended`（不看 error） | 「view.error 不存在時沒有錯誤卡片，即使對話已經正常結束」「viewing 時工具卡片展開後顯示歷史對話沒有原始輸出」 | 紅，2 failed / 41 passed。兩條測試的 view 都是 `ended: true` 但沒帶 `error`，`view.error.message` 讀到 `undefined.message` 直接拋例外，整棵樹連帶炸掉，比單純多顯示一張卡片更明顯 |

八個突變逐一還原後都跑回「Test Files 2 passed (2)」「Tests 43 passed (43)」，與突變前逐字相同。

**M1 只有 `appendEvents` 那一組測得到，hook 層的三條 reset 測試對它是盲的。** 原因是 `fold()` 自己
也有 `case 'reset': return INITIAL_VIEW`（裁決 22 給 Task 4 的那一條），hook 少截一次時 `view` 完全
一樣，差別只在累積陣列會一直長下去。這是計畫至今第八次「測試名字對、斷言對，但正確與錯誤實作
在挑的資料下同值」，處置方式跟 M6 一樣：把判準抽成獨立的純函式再直接測它。hook 層那三條仍然留著，
它們釘的是「畫面確實從 reset 之後重新開始」這個對外行為，跟截斷是不是發生在 hook 裡是兩件事。

**M8 的第二條測試第一次是盲的，改用 `ended: true` 才命中。** 起草時直接用 `viewOf(...)` 建構 view，
它的 `ended` 預設是 `false`；套用突變（條件從 `view.error !== undefined` 改成 `view.ended`）之後，
`ended: false` 讓正確條件與 mutant 條件算出同一個結果（都不顯示卡片），這條測試完全測不出來，
是本計畫第七次「測試名字對、斷言對，但挑的資料讓正確與錯誤實作巧合同值」。改成手工建構
`ended: true` 且不帶 `error` 的 view 之後才真的擋住：這正是規格要防的情境（對話正常結束，
不該冒出一張錯誤卡片），mutant 在這個情境下會讀到 `view.error.message`，`view.error` 是
`undefined`，直接拋例外。

M8 單獨還原後再跑一次 `npx vitest run tests/conversation.test.tsx tests/use-conversation.test.tsx`：
「Test Files 2 passed (2)」「Tests 43 passed (43)」，與突變前逐字相同。

**M6 第一次是盲的，測試改過才命中。** 初版的那條測試把 `running` 改成 `done` 的同時也把 `result` 從
`undefined` 改成 `'ok'`，於是 `blockEquals` 靠 `Object.is(a.result, b.result)` 就判出不相等，
拿掉 `status` 比較照樣重繪，元件層的測試全綠，只有 `blockEquals` 的單元測試變紅。改成
「只改 `status`、其餘欄位逐字相同」之後才真的擋住。這是本計畫第六次「測試名字對、斷言對，
但挑的資料讓正確與錯誤實作巧合同值」，模式跟 Task 7 的側邊欄寬度、Task 4B 的第一顆工具是同一個。

M6 順帶證明了一件事：`Turn` 的 `memo` 真的會命中。若 memo 從來沒攔下任何一次重繪，
拿掉比較函式裡的一個欄位不會有任何可觀察的後果，測試就不會紅。它紅了，代表比較函式回傳 true 時
React 確實跳過了那次渲染。這是本 task 效能主張的直接證據，不是推論。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/components/Conversation.tsx src/renderer/components/Conversation.css \
  src/renderer/components/Turn.tsx src/renderer/components/ToolCall.tsx \
  src/renderer/components/ThinkingBlock.tsx src/renderer/components/block-equals.ts \
  src/renderer/hooks/useConversation.ts \
  src/renderer/App.tsx src/renderer/App.css \
  tests/conversation.test.tsx tests/use-conversation.test.tsx vitest.config.ts
git commit -m "feat: 對話元件與 useConversation，memo 改用逐欄位比較函式，加裁決 17 錯誤卡片"
```

## 回報事項（不擅自更動，記錄理由）

1. **`vitest.config.ts` 的 `test.include` 已由 Task 9 定案，本 task 不再重複宣告。** 接縫補記已定案：
   `test.include` 改成 `'tests/**/*.test.{ts,tsx}'` 只在 Task 9 做一次，9B／10／11 不再重複宣告，
   只在 Step 2 確認。本 task 仍要改 `vitest.config.ts`，但只加六個 coverage 條目，不動 `include`
   那一行；若 Step 2 看到「No test files found, exiting with code 1」，代表 Task 9 沒做完，不是
   本 task 的問題。本 task 兩種 glob 都實跑過：舊的收 4 個檔，`{ts,tsx}` 收 6 個。

2. **契約的 `Conversation` 簽章有回傳型別標註，本 task 沒照抄那一段。** 契約寫
   `export function Conversation(props: ConversationProps): JSX.Element`，實作寫成不標註回傳型別。
   理由是 Task 9 已查證：標 `JSX.Element` 需要額外顯式 import `JSX` 型別（automatic JSX runtime 的
   已知限制），不標則由 TS 推論。參數型別與元件名稱逐字相同，對呼叫端沒有差別。

3. **`ToolBlock` 的宣告位置。** 契約把 `export type ToolBlock = Extract<Block, { kind: 'tool' }>` 列在
   `Conversation.tsx` 底下。實作把它宣告在 `block-equals.ts`（那裡最先需要它），再由 `Conversation.tsx`
   `export type { ToolBlock }` 轉出一次。Task 10 照契約從 `Conversation.js` import 完全可行。

4. **`Block.tool` 的 `deniedReason` 已由裁決 12 定案。** Task 4B 現行程式碼已經照裁決 12 寫
   `deniedReason`（拒絕理由填 `deniedReason`，`result` 維持 `undefined`）。本 task 的 `ToolCall`
   讀 `block.deniedReason`，與 Task 4B 定案版本一致，M3 那條突變測試的實機行為對得上，不再是
   待裁決疑慮。

5. **`session-end` 的錯誤資訊已由裁決 17 定案。** `ConversationView` 加
   `error?: { readonly message?: string; readonly apiErrorStatus?: unknown }`，`fold()` 收到
   `isError: true` 的 `session-end` 時設定它（屬於 Task 4 的範圍），`Conversation` 在對話尾端渲染
   `.error-card`，內容是「對話因錯誤結束」、`message`（若有）、`apiErrorStatus`（若有）。本 task
   已依裁決 17 第 4 點實作（見 Step 3e、Step 1 的兩條新測試、Step 5 的 M8），不再是待裁決疑慮。

6. **規格 §8 的「事件流中斷時顯示連線狀態」已由裁決 17 定案：不另設連線狀態 UI。** Task 8 的
   agent-host 在事件流中斷（`for await` 迭代器 throw，例如 SDK 程序崩潰或連線斷掉）時，把錯誤轉成
   一筆合成的 `{ kind: 'session-end', isError: true, errorMessage: err.message }`，走同一條 events
   通道，再走原本的 onEnded，狀態機照常回 `idle`。本 task 因此不需要另外處理連線狀態，第 4 點的
   錯誤卡片已經涵蓋這個情境。

