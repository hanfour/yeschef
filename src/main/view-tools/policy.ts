import { ANSWER_PEER_TOOL, ASK_PEER_TOOL } from '../../shared/peer-tools.js'
import { PROVIDERS, type Provider } from '../../shared/projects.js'
import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName } from '../../shared/view-tools.js'
import { chefToolPolicy } from '../chef/tool-policy.js'
import { canonicalToolName } from '../../shared/tool-name.js'

/**
 * 批准政策(契約 §3)。純函式,不 import Electron。
 *
 * 白名單比對,不是前綴比對:只有右窗格工具(view_eval 除外)加兩個同伴工具的全名回
 * `'allow'`,其餘一律 `'ask'`。每個 provider 另有一張「這個核心額外要問」的表:
 * codex 的 view_navigate 要問,因為它的沙箱有網路限制,不問等於繞過;
 * grok 預設沒開沙箱,沒有同樣的繞過問題,所以與 Claude 相同(grok 規格 §7)。
 */
export type ToolDecision = 'allow' | 'ask'

const ALLOW_LIST: ReadonlySet<string> = new Set([
  ...VIEW_TOOL_NAMES.filter((name) => name !== 'view_eval').map((name) => fullToolName(name)),
  // 同伴問答不需要批准:一次呼叫只會讓另一個對話收到一段文字(P 規格 §4)。
  ASK_PEER_TOOL,
  ANSWER_PEER_TOOL,
])

/** 各核心額外要問的工具全名。少一列 TypeScript 會報錯。 */
const EXTRA_ASK: Readonly<Record<Provider, ReadonlySet<string>>> = {
  claude: new Set<string>(),
  codex: new Set<string>([fullToolName('view_navigate')]),
  grok: new Set<string>(),
}

export function viewToolPolicy(toolName: string, provider: Provider = 'claude'): ToolDecision {
  const normalized = canonicalToolName(toolName)
  const chefDecision = chefToolPolicy(normalized)
  if (chefDecision !== 'unknown') return chefDecision
  if (EXTRA_ASK[provider].has(normalized)) return 'ask'
  if (normalized === VIEW_EVAL_TOOL) return 'ask'
  return ALLOW_LIST.has(normalized) ? 'allow' : 'ask'
}

/** 測試與偵錯用:目前認得的核心。 */
export const POLICY_PROVIDERS = PROVIDERS
