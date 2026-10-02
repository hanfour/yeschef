import { describe, expect, it } from 'vitest'
import {
  REQUEST_HANDOFF_TOOL,
  VIEW_EVAL_TOOL,
  VIEW_TOOL_NAMES,
  VIEW_TOOL_PREFIX,
  VIEW_TOOL_SERVER_NAME,
  fullToolName,
  asViewToolName,
  isViewToolName,
} from '../../src/shared/view-tools.js'

describe('view-tools 共用常數', () => {
  it('server 名稱與前綴', () => {
    expect(VIEW_TOOL_SERVER_NAME).toBe('yeschef')
    expect(VIEW_TOOL_PREFIX).toBe('mcp__yeschef__')
  })

  it('九個工具名稱，順序與契約 §2 一致', () => {
    expect(VIEW_TOOL_NAMES).toEqual([
      'view_navigate',
      'view_snapshot',
      'view_screenshot',
      'view_click',
      'view_type',
      'view_press',
      'view_eval',
      'request_handoff',
      'view_login',
    ])
  })

  it('fullToolName 加上 mcp__yeschef__ 前綴', () => {
    expect(fullToolName('view_click')).toBe('mcp__yeschef__view_click')
    expect(fullToolName('request_handoff')).toBe('mcp__yeschef__request_handoff')
  })

  it('REQUEST_HANDOFF_TOOL 與 VIEW_EVAL_TOOL 是預先算好的全名', () => {
    expect(REQUEST_HANDOFF_TOOL).toBe('mcp__yeschef__request_handoff')
    expect(VIEW_EVAL_TOOL).toBe('mcp__yeschef__view_eval')
  })
})

describe('asViewToolName 與 isViewToolName', () => {
  it('平鋪名字與帶前綴的全名都認得(codex 那側沒有前綴)', () => {
    expect(asViewToolName('view_click')).toBe('view_click')
    expect(asViewToolName('mcp__yeschef__view_click')).toBe('view_click')
    expect(asViewToolName('mcp__sidepane__view_click')).toBe('view_click')
    expect(isViewToolName('request_handoff', 'request_handoff')).toBe(true)
    expect(isViewToolName('mcp__yeschef__request_handoff', 'request_handoff')).toBe(true)
  })

  it('不是這八個的一律不認,多打一段也不認', () => {
    expect(asViewToolName('Read')).toBeUndefined()
    expect(asViewToolName('')).toBeUndefined()
    expect(asViewToolName('view_click_extra')).toBeUndefined()
    expect(asViewToolName('mcp__yeschef__ask_peer')).toBeUndefined()
    expect(isViewToolName('view_click', 'request_handoff')).toBe(false)
  })
})
