import { describe, expect, it } from 'vitest'
import { createGrokMapper, GROK_PLAN_TITLE } from '../src/main/grok/mapper.js'
import type { Event } from '../src/shared/events.js'

/** 探測 grok 1.0.40 時抓下來的通知形狀(規格 §3)。 */
const UPDATE = (update: unknown): unknown => ({ sessionId: 's-1', update })

const TEXT_CHUNK = UPDATE({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } })
const TEXT_CHUNK_2 = UPDATE({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ',世界' } })
const THOUGHT_CHUNK = UPDATE({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看 README' } })
const USER_CHUNK = UPDATE({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '幫我看 README' } })
const TOOL_CALL = UPDATE({
  sessionUpdate: 'tool_call', toolCallId: 'call-1', title: '讀取 README.md', kind: 'read',
  status: 'pending', rawInput: { path: 'README.md' },
})
const TOOL_DONE = UPDATE({
  sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text: '# yeschef' } }],
  rawOutput: { stdout: '# yeschef\n', stderr: '', exitCode: 0 },
})
const TOOL_FAILED = UPDATE({
  sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed',
  content: [{ type: 'content', content: { type: 'text', text: 'ENOENT' } }],
})
const TOOL_RUNNING = UPDATE({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' })
const PLAN = UPDATE({
  sessionUpdate: 'plan',
  entries: [
    { content: '讀 README', priority: 'high', status: 'in_progress' },
    { content: '改 mapper', priority: 'medium', status: 'pending' },
  ],
})
const COMMANDS = UPDATE({
  sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'init', description: '初始化專案' }],
})
const NONSENSE = UPDATE({ sessionUpdate: 'quantum_flux', payload: 1 })

/**
 * 探測時抓到的真實形狀:與 `session/update` 同一種外形(`update.sessionUpdate`),
 * 只是 method 不同、模型欄位叫 `model_id`。
 */
const MODEL_CHANGED = {
  sessionId: 's-1',
  update: { sessionUpdate: 'model_changed', model_id: 'grok-4-fast', reasoning_effort: 'high' },
}
const HOOK_EXECUTION = {
  sessionId: 's-1',
  update: { sessionUpdate: 'hook_execution', name: 'pre_commit', status: 'running' },
}
const MCP_STATUS = {
  sessionId: 's-1', name: 'weather', status: 'unavailable',
  reason: 'connect_failed', detail: 'ECONNREFUSED 127.0.0.1:9',
}

function rig(model?: string) {
  const mapper = createGrokMapper('s-1', model)
  mapper.beginTurn()
  const out: Event[] = []
  const feed = (method: string, params: unknown): readonly Event[] => {
    const events = mapper.accept(method, params)
    out.push(...events)
    return events
  }
  return { mapper, out, feed, update: (params: unknown) => feed('session/update', params) }
}

describe('文字與思考', () => {
  it('第一個 chunk 先發 message-start,messageId 是 grok-<sessionId>-<turn>', () => {
    const r = rig('grok-4-7')
    expect(r.update(TEXT_CHUNK)).toEqual([
      { kind: 'message-start', messageId: 'grok-s-1-1', model: 'grok-4-7' },
      { kind: 'block-start', messageId: 'grok-s-1-1', index: 0, blockType: 'text' },
      { kind: 'text-delta', messageId: 'grok-s-1-1', index: 0, text: '你好' },
    ])
  })

  it('同一個區塊的後續 chunk 只有 delta', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.update(TEXT_CHUNK_2)).toEqual([
      { kind: 'text-delta', messageId: 'grok-s-1-1', index: 0, text: ',世界' },
    ])
  })

  it('文字換到思考:先 block-stop 再開新 index', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.update(THOUGHT_CHUNK)).toEqual([
      { kind: 'block-stop', messageId: 'grok-s-1-1', index: 0 },
      { kind: 'block-start', messageId: 'grok-s-1-1', index: 1, blockType: 'thinking' },
      { kind: 'thinking-delta', messageId: 'grok-s-1-1', index: 1, text: '先看 README' },
    ])
  })

  it('beginTurn 換一個 messageId,index 從 0 重數', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    r.mapper.promptFinished('end_turn')
    r.mapper.beginTurn()
    expect(r.update(TEXT_CHUNK)).toEqual([
      { kind: 'message-start', messageId: 'grok-s-1-2' },
      { kind: 'block-start', messageId: 'grok-s-1-2', index: 0, blockType: 'text' },
      { kind: 'text-delta', messageId: 'grok-s-1-2', index: 0, text: '你好' },
    ])
  })

  it('user_message_chunk 只在重播出現,畫成 user-text', () => {
    const r = rig()
    expect(r.update(USER_CHUNK)).toEqual([{ kind: 'user-text', text: '幫我看 README' }])
  })
})

describe('工具', () => {
  it('tool_call 用 title 當名稱,rawInput 當參數,並收掉開著的文字區塊', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.update(TOOL_CALL)).toEqual([
      { kind: 'block-stop', messageId: 'grok-s-1-1', index: 0 },
      { kind: 'tool-use', messageId: 'call-1', index: 0, id: 'call-1', name: '讀取 README.md', input: { path: 'README.md' } },
    ])
  })

  it('沒有 title 時用 kind', () => {
    const r = rig()
    const events = r.update(UPDATE({ sessionUpdate: 'tool_call', toolCallId: 'c9', kind: 'execute', rawInput: {} }))
    expect(events).toEqual([{ kind: 'tool-use', messageId: 'c9', index: 0, id: 'c9', name: 'execute', input: {} }])
  })

  it('completed 成對回 tool-result,rawOutput 有 stdout 時另發 tool-raw-output', () => {
    const r = rig()
    r.update(TOOL_CALL)
    expect(r.update(TOOL_DONE)).toEqual([
      { kind: 'tool-result', id: 'call-1', content: [{ type: 'content', content: { type: 'text', text: '# yeschef' } }], isError: false },
      { kind: 'tool-raw-output', id: 'call-1', stdout: '# yeschef\n', stderr: '', interrupted: false },
    ])
  })

  it('failed 是錯誤;沒有 rawOutput 就不發 tool-raw-output', () => {
    const r = rig()
    expect(r.update(TOOL_FAILED)).toEqual([
      { kind: 'tool-result', id: 'call-2', content: [{ type: 'content', content: { type: 'text', text: 'ENOENT' } }], isError: true },
    ])
  })

  it('in_progress 不產生事件', () => {
    expect(rig().update(TOOL_RUNNING)).toEqual([])
  })
})

describe('計畫與雜訊', () => {
  it('plan 畫成一段條列文字,不做新事件種類', () => {
    const r = rig()
    expect(r.update(PLAN)).toEqual([
      { kind: 'text', text: `${GROK_PLAN_TITLE}\n- 讀 README\n- 改 mapper` },
    ])
  })

  it('available_commands_update 與 _x.ai/* 不產生 unknown', () => {
    const r = rig()
    expect(r.update(COMMANDS)).toEqual([])
    expect(r.feed('_x.ai/mcp/server_status', MCP_STATUS)).toEqual([])
    expect(r.feed('_x.ai/session/setup', { sessionId: 's-1', phase: 'mcp_merge' })).toEqual([])
    expect(r.feed('_x.ai/announcements/update', { items: [] })).toEqual([])
    expect(r.out.some((e) => e.kind === 'unknown')).toBe(false)
  })

  it('session_notification 的 model_changed 影響下一個 message-start', () => {
    const r = rig('grok-4-7')
    expect(r.feed('_x.ai/session_notification', MODEL_CHANGED)).toEqual([])
    expect(r.mapper.model()).toBe('grok-4-fast')
    r.mapper.promptFinished('end_turn')
    r.mapper.beginTurn()
    expect(r.update(TEXT_CHUNK)[0]).toEqual({ kind: 'message-start', messageId: 'grok-s-1-2', model: 'grok-4-fast' })
  })

  it('看不懂的 sessionUpdate 才是 unknown', () => {
    const r = rig()
    expect(r.update(NONSENSE)).toEqual([
      { kind: 'unknown', raw: { sessionUpdate: 'quantum_flux', payload: 1 } },
    ])
  })

  it('session_notification 的 hook_execution 忽略,也不動模型', () => {
    const r = rig('grok-4-7')
    expect(r.feed('_x.ai/session_notification', HOOK_EXECUTION)).toEqual([])
    expect(r.mapper.model()).toBe('grok-4-7')
  })

  it('同樣的 sessionUpdate 名稱走 session/update 時仍是 unknown:兩個 method 不共用表', () => {
    const r = rig()
    expect(r.update(MODEL_CHANGED)).toEqual([
      { kind: 'unknown', raw: MODEL_CHANGED.update },
    ])
  })

  it('params 不是物件、或沒有 update 欄位:前者忽略,後者 unknown', () => {
    const r = rig()
    expect(r.update('壞掉的東西')).toEqual([])
    expect(r.update({ sessionId: 's-1' })).toEqual([{ kind: 'unknown', raw: { sessionId: 's-1' } }])
  })
})

describe('回合結束', () => {
  it('promptFinished 收掉開著的區塊再發 session-end', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.mapper.promptFinished('end_turn')).toEqual([
      { kind: 'block-stop', messageId: 'grok-s-1-1', index: 0 },
      { kind: 'session-end', isError: false },
    ])
  })

  it('cancelled 也算正常結束', () => {
    expect(rig().mapper.promptFinished('cancelled')).toEqual([{ kind: 'session-end', isError: false }])
  })

  it('沒有 stopReason 也結束', () => {
    expect(rig().mapper.promptFinished(undefined)).toEqual([{ kind: 'session-end', isError: false }])
  })
})
