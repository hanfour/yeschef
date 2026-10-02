/**
 * 右窗格瀏覽器工具的共用常數（契約 §2）。main 與 renderer 都會 import，所以這裡
 * 不引入 Electron，也不引入 `src/main/**` 或 `src/renderer/**` 的任何東西。
 */
import { canonicalToolName } from './tool-name.js'

export const VIEW_TOOL_SERVER_NAME = 'yeschef'
export const VIEW_TOOL_PREFIX = `mcp__${VIEW_TOOL_SERVER_NAME}__`

export const VIEW_TOOL_NAMES = [
  'view_navigate',
  'view_snapshot',
  'view_screenshot',
  'view_click',
  'view_type',
  'view_press',
  'view_eval',
  'request_handoff',
  'view_login',
] as const

export type ViewToolName = (typeof VIEW_TOOL_NAMES)[number]

/** 模型看到的完整名稱，例：fullToolName('view_click') === 'mcp__yeschef__view_click' */
export function fullToolName(name: ViewToolName): string {
  return `${VIEW_TOOL_PREFIX}${name}`
}

export const REQUEST_HANDOFF_TOOL = fullToolName('request_handoff')
export const VIEW_EVAL_TOOL = fullToolName('view_eval')

/**
 * 把一個工具名稱對回這八個之一。Claude 那側是 `mcp__yeschef__view_click`,
 * codex 那側是裸的 `view_click`(dynamic tool 沒有前綴,RESULTS-22 §5),畫面與接線兩邊都要認。
 * 白名單比對而非前綴比對:`view_click_extra` 這種多打一段的不算。
 */
export function asViewToolName(name: string): ViewToolName | undefined {
  const normalized = canonicalToolName(name)
  return VIEW_TOOL_NAMES.find((known) => normalized === known || normalized === `${VIEW_TOOL_PREFIX}${known}`)
}

export function isViewToolName(name: string, which: ViewToolName): boolean {
  return asViewToolName(name) === which
}
