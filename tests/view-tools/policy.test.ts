import { ANSWER_PEER_TOOL, ASK_PEER_TOOL } from '../../src/shared/peer-tools.js'
import { describe, expect, it } from 'vitest'
import { fullToolName } from '../../src/shared/view-tools.js'
import { viewToolPolicy } from '../../src/main/view-tools/policy.js'

describe('viewToolPolicy', () => {
  it('codex 導航需要批准，Claude 與預設政策仍允許', () => {
    expect(viewToolPolicy('mcp__yeschef__view_navigate', 'codex')).toBe('ask')
    expect(viewToolPolicy('mcp__yeschef__view_navigate')).toBe('allow')
    expect(viewToolPolicy('mcp__yeschef__view_navigate', 'claude')).toBe('allow')
    expect(viewToolPolicy('mcp__sidepane__view_navigate', 'claude')).toBe('allow')
    expect(viewToolPolicy('mcp__sidepane__view_navigate', 'codex')).toBe('ask')
    expect(viewToolPolicy(fullToolName('view_click'), 'codex')).toBe('allow')
    expect(viewToolPolicy(fullToolName('view_eval'), 'codex')).toBe('ask')
  })

  it('七個非 view_eval 工具都是 allow', () => {
    const names = [
      'view_navigate',
      'view_snapshot',
      'view_screenshot',
      'view_click',
      'view_type',
      'view_press',
      'request_handoff',
    ] as const
    for (const name of names) {
      expect(viewToolPolicy(fullToolName(name))).toBe('allow')
    }
  })

  it('view_eval 是 ask', () => {
    expect(viewToolPolicy(fullToolName('view_eval'))).toBe('ask')
  })

  it('view_login 自動放行,codex 也是', () => {
    expect(viewToolPolicy(fullToolName('view_login'))).toBe('allow')
    expect(viewToolPolicy(fullToolName('view_login'), 'codex')).toBe('allow')
  })

  it('白名單比對而非前綴比對：多打一段的名稱是 ask', () => {
    expect(viewToolPolicy('mcp__yeschef__view_navigate_extra')).toBe('ask')
  })

  it('未知的 mcp__yeschef__ 工具名稱是 ask', () => {
    expect(viewToolPolicy('mcp__yeschef__somethingelse')).toBe('ask')
  })

  it('完全不相干的工具名稱是 ask', () => {
    expect(viewToolPolicy('Read')).toBe('ask')
    expect(viewToolPolicy('')).toBe('ask')
  })
})

describe('同伴問答的兩個工具', () => {
  it('都是 allow,不需要批准', () => {
    expect(viewToolPolicy(ASK_PEER_TOOL)).toBe('allow')
    expect(viewToolPolicy(ANSWER_PEER_TOOL)).toBe('allow')
  })

  it('名稱多打一段仍是 ask', () => {
    expect(viewToolPolicy(`${ASK_PEER_TOOL}_extra`)).toBe('ask')
  })
})
