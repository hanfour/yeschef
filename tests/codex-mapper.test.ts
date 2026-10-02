import { historyEvents } from '../src/main/codex/mapper.js'
import { describe, it, expect } from 'vitest'
import { createCodexMapper, MSG_NOT_LOGGED_IN } from '../src/main/codex/mapper.js'
import { fold } from '../src/shared/fold.js'
import type { Event } from '../src/shared/events.js'

const started = (item: Record<string, unknown>): unknown => ({ item, threadId: 't', turnId: 'u', startedAtMs: 1 })
const completed = (item: Record<string, unknown>): unknown => ({ item, threadId: 't', turnId: 'u', completedAtMs: 2 })
const map = (method: string, params: unknown): readonly Event[] => createCodexMapper().accept(method, params)

describe('文字與思考', () => {
  it('item/agentMessage/delta → text-delta,messageId 用 itemId、index 0', () => {
    expect(map('item/agentMessage/delta', { itemId: 'i1', delta: '嗨', threadId: 't', turnId: 'u' })).toEqual([
      { kind: 'text-delta', messageId: 'i1', index: 0, text: '嗨' },
    ])
  })

  it('item/completed agentMessage → text 完整快照,messageId 與 index 與 delta 對得上', () => {
    expect(map('item/completed', completed({ type: 'agentMessage', id: 'i1', text: '完整回覆', phase: 'final_answer' }))).toEqual([
      { kind: 'text', messageId: 'i1', index: 0, text: '完整回覆' },
    ])
  })

  it('phase 為 commentary 的 agentMessage 也是文字', () => {
    expect(map('item/completed', completed({ type: 'agentMessage', id: 'i2', text: '我先看一下', phase: 'commentary' }))).toEqual([
      { kind: 'text', messageId: 'i2', index: 0, text: '我先看一下' },
    ])
  })

  it('item/started agentMessage 不畫:內容由 delta 與 completed 帶', () => {
    expect(map('item/started', started({ type: 'agentMessage', id: 'i1', text: '' }))).toEqual([])
  })

  it('reasoning:summary 有值用 summary,否則用 content', () => {
    expect(map('item/completed', completed({ type: 'reasoning', id: 'r0', summary: [], content: [] }))).toEqual([])
    expect(map('item/completed', completed({ type: 'reasoning', id: 'r1', summary: ['先看檔案', '再改'], content: ['忽略'] }))).toEqual([
      { kind: 'thinking', messageId: 'r1', index: 0, text: '先看檔案\n再改' },
    ])
    expect(map('item/completed', completed({ type: 'reasoning', id: 'r2', summary: [], content: ['只有 content'] }))).toEqual([
      { kind: 'thinking', messageId: 'r2', index: 0, text: '只有 content' },
    ])
  })
})

describe('指令執行', () => {
  const cmd = { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/p' }

  it('item/started → tool-use,名字 Bash,input 是指令與 cwd', () => {
    expect(map('item/started', started({ ...cmd, status: 'inProgress' }))).toEqual([
      { kind: 'tool-use', messageId: 'c1', index: 0, id: 'c1', name: 'Bash', input: { command: 'ls -la', cwd: '/p' } },
    ])
  })

  it('item/completed 成功 → tool-result 帶 exitCode,加 tool-raw-output 帶輸出', () => {
    expect(map('item/completed', completed({ ...cmd, status: 'completed', exitCode: 0, aggregatedOutput: 'a.ts\nb.ts' }))).toEqual([
      { kind: 'tool-result', id: 'c1', content: { exitCode: 0, status: 'completed' }, isError: false },
      { kind: 'tool-raw-output', id: 'c1', stdout: 'a.ts\nb.ts', stderr: '', interrupted: false },
    ])
  })

  it('status 不是 completed 就是錯誤;declined 標成中斷', () => {
    const failed = map('item/completed', completed({ ...cmd, status: 'failed', exitCode: 1, aggregatedOutput: '炸了' }))
    expect(failed[0]).toEqual({ kind: 'tool-result', id: 'c1', content: { exitCode: 1, status: 'failed' }, isError: true })
    expect(failed[1]).toEqual({ kind: 'tool-raw-output', id: 'c1', stdout: '炸了', stderr: '', interrupted: false })
    const declined = map('item/completed', completed({ ...cmd, status: 'declined', exitCode: null, aggregatedOutput: null }))
    expect(declined[1]).toEqual({ kind: 'tool-raw-output', id: 'c1', stdout: '', stderr: '', interrupted: true })
  })
})

describe('檔案修改與工具呼叫', () => {
  it('fileChange:started → tool-use Edit 帶 changes;completed → tool-result', () => {
    const changes = [{ path: '/p/a.ts', kind: 'update', diff: '@@' }]
    expect(map('item/started', started({ type: 'fileChange', id: 'f1', changes, status: 'inProgress' }))).toEqual([
      { kind: 'tool-use', messageId: 'f1', index: 0, id: 'f1', name: 'Edit', input: { changes } },
    ])
    expect(map('item/completed', completed({ type: 'fileChange', id: 'f1', changes, status: 'completed' }))).toEqual([
      { kind: 'tool-result', id: 'f1', content: { status: 'completed' }, isError: false },
    ])
  })

  it('mcpToolCall 與 dynamicToolCall:名字用 tool,input 用 arguments', () => {
    expect(map('item/started', started({ type: 'mcpToolCall', id: 'm1', tool: 'search', server: 's', arguments: { q: 'x' }, status: 'inProgress' }))).toEqual([
      { kind: 'tool-use', messageId: 'm1', index: 0, id: 'm1', name: 'search', input: { q: 'x' } },
    ])
    expect(map('item/completed', completed({ type: 'dynamicToolCall', id: 'd1', tool: 'ask_peer', arguments: { question: 'y' }, status: 'completed', contentItems: [{ type: 'inputText', text: '同伴回答' }] }))).toEqual([
      { kind: 'tool-result', id: 'd1', content: [{ type: 'inputText', text: '同伴回答' }], isError: false },
    ])
  })
})

describe('壓縮與回合結束', () => {
  it('contextCompaction → 壓縮分隔線,沒有 token 數就不帶數字', () => {
    expect(map('item/completed', completed({ type: 'contextCompaction', id: 'x1' }))).toEqual([
      { kind: 'compact-boundary', trigger: 'auto' },
    ])
  })

  it('turn/completed status completed → session-end 不是錯誤', () => {
    expect(map('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })).toEqual([
      { kind: 'session-end', isError: false },
    ])
  })

  it('turn/completed status failed → session-end 帶 error.message', () => {
    expect(map('turn/completed', { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: '模型拒絕' } } })).toEqual([
      { kind: 'session-end', isError: true, errorMessage: '模型拒絕' },
    ])
  })

  it('turn 因 401 失敗:訊息前面補上未登入的提示,原文保留', () => {
    const out = map('turn/completed', {
      threadId: 't',
      turn: { id: 'u', status: 'failed', error: { message: 'unexpected status 401 Unauthorized: {"code":"API_KEY_REQUIRED"}' } },
    })
    const msg = (out[0] as { errorMessage: string }).errorMessage
    expect(msg.startsWith(MSG_NOT_LOGGED_IN)).toBe(true)
    expect(msg).toContain('401')
  })

  it('其他錯誤不加提示', () => {
    const out = map('turn/completed', { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: '模型拒絕' } } })
    expect((out[0] as { errorMessage: string }).errorMessage).toBe('模型拒絕')
  })

  it('turn/completed status interrupted → session-end 帶中斷訊息', () => {
    expect(map('turn/completed', { threadId: 't', turn: { id: 'u', status: 'interrupted' } })).toEqual([
      { kind: 'session-end', isError: true, errorMessage: '回合已中斷' },
    ])
  })

  it('turn/completed 之前收過 tokenUsage 時,session-end 帶 token 數', () => {
    const m = createCodexMapper()
    expect(m.accept('thread/tokenUsage/updated', {
      threadId: 't', turnId: 'u',
      tokenUsage: { last: { totalTokens: 120 }, total: { totalTokens: 4200 } },
    })).toEqual([])
    expect(m.accept('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })).toEqual([
      { kind: 'session-end', isError: false, tokens: 4200 },
    ])
  })
})

describe('認不得的東西', () => {
  it('沒有專門畫法的 item type 畫成工具區塊,不靜默丟也不畫成空的未知事件', () => {
    const out = map('item/completed', completed({ type: 'webSearch', id: 'w1', query: 'x' }))
    expect(out.length).toBe(1)
    expect(out[0]?.kind).toBe('tool-result')
  })

  it.each(['item/started', 'item/completed'])('%s userMessage 不重複畫已送出的訊息', (method) => {
    expect(map(method, { item: { type: 'userMessage', id: 'u1', content: [{ type: 'inputText', text: '你好' }] } })).toEqual([])
  })

  it('截圖畫成工具區塊,參數是那張圖的路徑', () => {
    const item = { type: 'imageView', id: 'exec-1', path: '/tmp/screen.png' }
    expect(map('item/started', { item })).toEqual([
      { kind: 'tool-use', messageId: 'exec-1', index: 0, id: 'exec-1', name: '截圖', input: { path: '/tmp/screen.png' } },
    ])
    expect(map('item/completed', { item: { ...item, status: 'completed' } })).toEqual([
      { kind: 'tool-result', id: 'exec-1', content: { path: '/tmp/screen.png', status: 'completed' }, isError: false },
    ])
  })

  it('等待畫成工具區塊,參數是毫秒數', () => {
    const item = { type: 'sleep', id: 'call-1', durationMs: 35000 }
    expect(map('item/started', { item })).toEqual([
      { kind: 'tool-use', messageId: 'call-1', index: 0, id: 'call-1', name: '等待', input: { durationMs: 35000 } },
    ])
    expect(map('item/completed', { item: { ...item, status: 'completed' } })).toEqual([
      { kind: 'tool-result', id: 'call-1', content: { durationMs: 35000, status: 'completed' }, isError: false },
    ])
  })

  it('截圖與等待被中斷時算失敗', () => {
    const out = map('item/completed', { item: { type: 'sleep', id: 'call-2', durationMs: 1000, status: 'declined' } })
    expect(out).toEqual([{ kind: 'tool-result', id: 'call-2', content: { durationMs: 1000, status: 'declined' }, isError: true }])
  })

  it('沒有專門畫法的 item 畫成以 type 命名的工具區塊,不是空的未知事件', () => {
    const item = { type: 'webSearch', id: 'exec-9', query: '注音 輸入法', action: null, results: null }
    expect(map('item/started', { item })).toEqual([
      {
        kind: 'tool-use', messageId: 'exec-9', index: 0, id: 'exec-9', name: 'webSearch',
        input: { query: '注音 輸入法', action: null, results: null },
      },
    ])
    expect(map('item/completed', { item: { ...item, status: 'completed', results: ['a'] } })).toEqual([
      {
        kind: 'tool-result', id: 'exec-9',
        content: { query: '注音 輸入法', action: null, results: ['a'], status: 'completed' },
        isError: false,
      },
    ])
  })

  it('沒有專門畫法的 item 失敗時標成錯誤', () => {
    const out = map('item/completed', { item: { type: 'plan', id: 'p1', text: '第一步', status: 'failed' } })
    expect(out).toEqual([{ kind: 'tool-result', id: 'p1', content: { text: '第一步', status: 'failed' }, isError: true }])
  })

  it('真的畸形的 item 才回未知事件', () => {
    expect(map('item/started', { item: { id: 'x1' } })[0]?.kind).toBe('unknown')
    expect(map('item/started', { item: { type: 'webSearch' } })).toEqual([])
  })

  it('不在對應表上的通知方法回空陣列,不進對話', () => {
    for (const method of ['hook/started', 'hook/completed', 'account/rateLimits/updated', 'turn/started', 'thread/started', 'turn/diff/updated']) {
      expect(map(method, { anything: true })).toEqual([])
    }
  })

  it('params 形狀不符時回空陣列,不丟例外', () => {
    expect(map('item/completed', null)).toEqual([])
    expect(map('item/completed', { item: 'not-an-object' })).toEqual([])
    expect(map('item/agentMessage/delta', { itemId: 1, delta: 2 })).toEqual([])
    expect(map('turn/completed', {})).toEqual([])
  })
})

describe('餵進 fold 之後畫得出來(這一層抓得到 messageId 漏掉)', () => {
  it('commandExecution 的一整輪:tool block 有名字、有結果,不是未知事件', () => {
    const m = createCodexMapper()
    const events = [
      ...m.accept('item/started', started({ type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/p', status: 'inProgress' })),
      ...m.accept('item/completed', completed({ type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/p', status: 'completed', exitCode: 0, aggregatedOutput: 'a.ts' })),
    ]
    const view = fold(events)
    const blocks = view.turns.flatMap((t) => t.blocks)
    expect(blocks.some((b) => b.kind === 'unknown')).toBe(false)
    const tool = blocks.find((b) => b.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool', id: 'c1', name: 'Bash', status: 'done',
      result: { exitCode: 0, status: 'completed' },
      raw: { stdout: 'a.ts', stderr: '', interrupted: false },
    })
  })

  it('fileChange 與 dynamicToolCall 也畫得出 tool block', () => {
    const m = createCodexMapper()
    const view = fold([
      ...m.accept('item/started', started({ type: 'fileChange', id: 'f1', changes: [], status: 'inProgress' })),
      ...m.accept('item/started', started({ type: 'dynamicToolCall', id: 'd1', tool: 'ask_peer', arguments: {}, status: 'inProgress' })),
    ])
    const blocks = view.turns.flatMap((t) => t.blocks)
    expect(blocks.filter((b) => b.kind === 'tool').map((b) => b.name)).toEqual(['Edit', 'ask_peer'])
    expect(blocks.some((b) => b.kind === 'unknown')).toBe(false)
  })
})

describe('歷史完整回放', () => {
  it('依序重建使用者、助理與成對工具事件,並保留輸出與下一輪', () => {
    const items = [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '請查詢' }] },
      { type: 'agentMessage', id: 'a', text: '開始查詢' },
      { type: 'commandExecution', id: 'c', command: 'ls', commandActions: [], cwd: '/p', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 },
      { type: 'mcpToolCall', id: 'm', server: 'search', tool: 'lookup', arguments: { query: '資料' }, status: 'completed', result: { content: [] } },
      { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: '下一輪' }] },
      { type: 'agentMessage', id: 'a2', text: '收到' },
    ]
    const original = structuredClone(items)
    const events = historyEvents(items)
    expect(events).toEqual([
      { kind: 'user-text', text: '請查詢' },
      { kind: 'text', messageId: 'a', index: 0, text: '開始查詢' },
      { kind: 'tool-use', messageId: 'c', index: 0, id: 'c', name: 'Bash', input: { command: 'ls', cwd: '/p' } },
      { kind: 'tool-result', id: 'c', content: { exitCode: 0, status: 'completed' }, isError: false },
      { kind: 'tool-raw-output', id: 'c', stdout: 'ok', stderr: '', interrupted: false },
      { kind: 'tool-use', messageId: 'm', index: 0, id: 'm', name: 'lookup', input: { query: '資料' } },
      { kind: 'tool-result', id: 'm', content: { content: [] }, isError: false },
      { kind: 'user-text', text: '下一輪' },
      { kind: 'text', messageId: 'a2', index: 0, text: '收到' },
    ])
    expect(items).toEqual(original)
    const view = fold(events)
    expect(view.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'user', 'assistant'])
    expect(view.turns.flatMap((turn) => turn.blocks).filter((block) => block.kind === 'tool')).toMatchObject([
      { id: 'c', name: 'Bash', status: 'done', raw: { stdout: 'ok' } },
      { id: 'm', name: 'lookup', status: 'done', result: { content: [] } },
    ])
  })

  it('只串接文字項目,略過附件與畸形內容', () => {
    expect(historyEvents([{ type: 'userMessage', id: 'u', content: [
      { type: 'text', text: '第一段', text_elements: [] },
      { type: 'image', url: 'https://example.com/image.png' },
      { type: 'localImage', path: '/tmp/image.png' },
      null, { type: 'text', text: 3 }, { text: '缺少類型' },
      { type: 'text', text: '第二段' },
    ] }])).toEqual([{ kind: 'user-text', text: '第一段\n第二段' }])
    expect(historyEvents([{ type: 'userMessage', id: 'u', content: [] }])).toEqual([{ kind: 'user-text', text: '' }])
    expect(historyEvents([null, 3, {}, [], { type: 'userMessage', content: [] },
      { type: 'userMessage', id: 'u', content: null }])).toEqual([])
  })
})
