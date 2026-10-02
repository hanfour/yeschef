// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it('整輪只有同伴提問時角色標「同伴提問」', () => {
    render(<Conversation historical={false} view={{ ended: false,
      turns: [{ role: 'user', blocks: [{ kind: 'peer-question', questionId: 'q-1', fromLinkId: 'aaaa1111', provider: 'claude', text: '在嗎' }] }],
    }} />)
    expect(screen.getByText('同伴提問')).not.toBeNull()
    expect(screen.queryByText('你')).toBeNull()
  })

  it('同伴提問的每個欄位改變時都重畫，live 與歷史皆可顯示', () => {
    const question: Extract<Block, { kind: 'peer-question' }> = {
      kind: 'peer-question', questionId: 'q-1', fromLinkId: 'aaaa1111', provider: 'claude', text: '在嗎',
    }
    expect(blockEquals(question, { ...question })).toBe(true)
    for (const change of [
      { questionId: 'q-2' }, { fromLinkId: 'bbbb2222' }, { provider: 'codex' }, { text: '新的問題' },
    ]) {
      expect(blockEquals(question, { ...question, ...change })).toBe(false)
    }
    expect(blockEquals(question, { kind: 'text', markdown: '在嗎', complete: true })).toBe(false)
    const { rerender } = render(<Conversation view={viewOf([question], 'user')} historical={false} />)
    expect(screen.getByText('在嗎')).not.toBeNull()
    rerender(<Conversation view={viewOf([{ ...question, provider: 'codex', text: '新的問題' }], 'user')} historical />)
    expect(screen.getByText('新的問題')).not.toBeNull()
    expect(screen.getByTestId('peer-from').textContent).toContain('codex · aaaa1111')
    expect(screen.queryByText('在嗎')).toBeNull()
    expect(screen.getByText('同伴提問')).not.toBeNull()
  })

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

/**
 * jsdom 沒有版面，`scrollHeight`／`clientHeight` 恆為 0，`scrollTop` 的 setter 是
 * no-op。這裡在 div 的原型上蓋掉這三個屬性，造出一個「內容比可視區高」的可捲清單，
 * 捲動位置存在 WeakMap 裡，讀寫得回來。每條測試結束就還原。
 */
function installScrollMetrics(): {
  setScrollHeight: (px: number) => void
  restore: () => void
} {
  const proto = HTMLDivElement.prototype as unknown as Record<string, unknown>
  const tops = new WeakMap<object, number>()
  let scrollHeight = 1000

  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 200 })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: object) {
      return tops.get(this) ?? 0
    },
    set(this: object, value: number) {
      tops.set(this, value)
    },
  })

  return {
    setScrollHeight: (px) => {
      scrollHeight = px
    },
    restore: () => {
      delete proto['scrollHeight']
      delete proto['clientHeight']
      delete proto['scrollTop']
    },
  }
}

/** 造 n 個 turn，用來模擬「內容變多」。每次都是新物件，view 的參照也跟著換。 */
function longView(n: number): ConversationView {
  return {
    turns: Array.from({ length: n }, (_, i) => ({
      role: 'assistant' as const,
      messageId: 'msg_' + String(i),
      blocks: [{ kind: 'text' as const, markdown: '第 ' + String(i) + ' 段', complete: true }],
    })),
    ended: false,
  }
}

describe('Conversation：貼底自動捲動', () => {
  let metrics: ReturnType<typeof installScrollMetrics> | null = null

  afterEach(() => {
    metrics?.restore()
    metrics = null
  })

  it('初次渲染後捲到底', () => {
    metrics = installScrollMetrics()
    const { container } = render(<Conversation view={longView(3)} historical={false} />)
    const el = container.querySelector('.conversation-list') as HTMLDivElement
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('內容變多時仍然貼底', () => {
    metrics = installScrollMetrics()
    const { container, rerender } = render(<Conversation view={longView(3)} historical={false} />)
    const el = container.querySelector('.conversation-list') as HTMLDivElement
    expect(el.scrollTop).toBe(1000)

    metrics.setScrollHeight(2000)
    rerender(<Conversation view={longView(6)} historical={false} />)
    expect(el.scrollTop).toBe(2000)
  })

  it('往上捲顯示回到最新按鈕，點擊後恢復追蹤串流', () => {
    metrics = installScrollMetrics()
    const { container, rerender } = render(<Conversation view={longView(3)} historical={false} />)
    const el = container.querySelector('.conversation-list') as HTMLDivElement
    el.scrollTop = 100; fireEvent.scroll(el)
    fireEvent.click(screen.getByRole('button', { name: '↓ 回到最新訊息' }))
    expect(el.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: '↓ 回到最新訊息' })).toBeNull()
    metrics.setScrollHeight(2000); rerender(<Conversation view={longView(6)} historical={false} />)
    expect(el.scrollTop).toBe(2000)
  })

  it('使用者往上捲之後，新內容不搶走捲動位置', () => {
    metrics = installScrollMetrics()
    const { container, rerender } = render(<Conversation view={longView(3)} historical={false} />)
    const el = container.querySelector('.conversation-list') as HTMLDivElement

    el.scrollTop = 100
    fireEvent.scroll(el)

    metrics.setScrollHeight(2000)
    rerender(<Conversation view={longView(6)} historical={false} />)
    expect(el.scrollTop).toBe(100)
  })
})
