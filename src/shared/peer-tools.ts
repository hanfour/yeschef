/**
 * 同伴問答的兩個工具(P 規格 §4)。它們掛在與右窗格工具同一份 MCP server 上
 * (`VIEW_TOOL_SERVER_NAME`),所以完整名稱共用同一個前綴。
 * main 與 renderer 都會 import,這裡不引入 Electron 也不引入 `src/main/**`。
 */
import { VIEW_TOOL_PREFIX } from './view-tools.js'
import { canonicalToolName } from './tool-name.js'

export const PEER_TOOL_NAMES = ['ask_peer', 'answer_peer'] as const
export type PeerToolName = (typeof PEER_TOOL_NAMES)[number]

export const ASK_PEER_TOOL = `${VIEW_TOOL_PREFIX}ask_peer`
export const ANSWER_PEER_TOOL = `${VIEW_TOOL_PREFIX}answer_peer`

/**
 * 注入給對方的提問(P 規格 §6.1)。產生與解析放在一起:`fold` 要靠解析把它畫成
 * 獨立一輪,而 live 與歷史拿到的都只是一段文字,沒有別的標記可用。格式改動時
 * 兩邊一起改,round-trip 的測試會擋住只改一邊。
 */
export interface PeerInjection {
  readonly provider: string
  /** 提問方 linkId 的前 8 碼。 */
  readonly fromLinkId: string
  readonly questionId: string
  readonly text: string
}

const INJECTION_TAIL = '。答不出來也要回答「答不出來」加原因,不要不回。'

export function formatPeerInjection(injection: PeerInjection): string {
  const from = injection.fromLinkId.slice(0, 8)
  return (
    `同伴(${injection.provider},${from})提問:${injection.text}\n` +
    `用 answer_peer 回答,id 是 ${injection.questionId}${INJECTION_TAIL}`
  )
}

/**
 * 兩端都錨定:開頭的 ^ 擋掉「前面多一段字」的訊息,結尾的 $ 保證抓到的是最外層那個尾巴。
 * 問題本身包含一段長得像注入的文字時也因此解析得對,貪婪與非貪婪在這個形狀下等價。
 */
const INJECTION_RE = new RegExp(
  '^同伴\\(([^,()]+),([^,()]+)\\)提問:([\\s\\S]*)\\n用 answer_peer 回答,id 是 ([^\\s]+)' +
    INJECTION_TAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '$'
)

export function parsePeerInjection(raw: string): PeerInjection | null {
  const m = INJECTION_RE.exec(raw)
  if (m === null) return null
  const [, provider, fromLinkId, text, questionId] = m
  if (provider === undefined || fromLinkId === undefined || text === undefined || questionId === undefined) {
    return null
  }
  return { provider, fromLinkId, questionId, text }
}

/**
 * 這個工具名稱是不是那個同伴工具。Claude 那側是 `mcp__yeschef__ask_peer`,
 * codex 那側是裸的 `ask_peer`(dynamic tool 沒有前綴),畫面與接線兩邊都要認。
 */
export function isPeerToolName(name: string, which: PeerToolName): boolean {
  const normalized = canonicalToolName(name)
  return normalized === which || normalized === `${VIEW_TOOL_PREFIX}${which}`
}
