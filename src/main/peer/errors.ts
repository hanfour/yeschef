import { formatPeerInjection } from '../../shared/peer-tools.js'

/**
 * 同伴問答對模型與使用者說的每一句話。照 `view-tools/errors.ts` 的做法集中在一處:
 * 散在各處的字串會慢慢長出兩種語氣,而這些話有一半是模型看的,語氣要一致。
 */

/** 工具回給模型的錯誤。呼叫端接住之後轉成 `isError` 的工具結果。 */
export class PeerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PeerError'
  }
}

export interface PeerCandidate {
  readonly linkId: string
  readonly provider: string
  readonly recent: string
}

const renderCandidates = (candidates: readonly PeerCandidate[]): string =>
  candidates.map((c) => `${c.linkId.slice(0, 8)}(${c.provider})${c.recent === '' ? '' : `:${c.recent}`}`).join('、')

export const PEER_MSG = {
  codexToolUnavailable: (tool: string) => `這個對話沒有接工具:${tool}`,
  codexToolNameMissing: '工具呼叫沒有帶工具名稱',
  askPeerDescription: '問同一個專案裡的另一個對話一個問題,並等它回答。對方最多 10 分鐘沒回就會回錯誤。',
  answerPeerDescription: '回答同伴問你的問題。答不出來也要回答「答不出來」加原因,不要不回。',
  /** codex 那側的參數檢查與接線錯誤(5c)。 */
  peerToolsMissing: '這個對話沒有接上同伴問答',
  askPeerNeedsQuestion: 'ask_peer 要有 question',
  askPeerBadTo: 'ask_peer 的 to 要是同伴的 id;不指定就整個不要帶',
  answerPeerNeedsBoth: 'answer_peer 要有 id 與 text',
  unknownTool: (tool: string) => `不認得的工具 ${tool}`,
  deliveryFailed: (id: string, reason: string) => `注入提問失敗(${id}):${reason}`,
  cancelWriteFailed: (id: string, reason: string) => `寫 cancel 失敗(${id}):${reason}`,
  scanFailed: (id: string | undefined = undefined, reason: string) => `掃描信箱失敗${id === undefined ? '' : `(${id})`}:${reason}`,
  mailboxCorruptFile: (name: string) => `信箱裡 ${name} 解析不了,已略過`,
  mailboxConflictingTerminal: (questionId: string) => `問題 ${questionId} 同時有 answer 與 cancel,狀態當已取消`,
  mailboxMirrorWriteFailed: (path: string, reason: string) => `信箱副本寫入失敗(${path}):${reason}`,
  mailboxReadFailed: (dir: string, reason: string) => `讀取信箱 ${dir} 失敗:${reason}`,
  mailboxOrphanTerminal: (name: string) => `信箱裡 ${name} 找不到對應的 question,已略過`,
  serviceStopped: '同伴問答服務已停止',
  noPeers: '這個專案沒有別的同伴',
  toRequired: (candidates: readonly PeerCandidate[]) =>
    `這個專案有多個同伴,to 要指定一個:${renderCandidates(candidates)}`,
  toUnknown: (to: string, candidates: readonly PeerCandidate[]) =>
    `找不到同伴 ${to};目前有:${renderCandidates(candidates)}`,
  toAmbiguous: (to: string, candidates: readonly PeerCandidate[]) =>
    `${to} 對到多個同伴,請給完整的 id:${renderCandidates(candidates)}`,
  alreadyAsking: (id: string) => `你已經有一個問題在等回答(#${id}),先等它結束`,
  deadlock: (id: string) => `對方正在等你回答 #${id},先回答它`,
  mailboxUnwritable: (reason: string) => `信箱寫不進去:${reason}`,
  /** 人要介入的那則問題已經不在未決集合裡(答過了、取消了、或根本沒有)。 */
  pendingUnknown: (id: string) => `沒有在等回答的問題 #${id}`,
  changeNotificationFailed: (reason: string) => `同伴狀態通知失敗:${reason}`,
  /** 以下原因同時是 cancel 檔的 text,寫進信箱當紀錄。 */
  /** 人主動取消一則提問(規格 §6.5)。 */
  userCancelled: '使用者取消',
  timedOut: '同伴 10 分鐘內沒有回答',
  peerEnded: '同伴已結束',
  askerEnded: '提問方已結束',
  restarted: '重啟時取消',
  answerCorrupt: '答案檔損毀',
  /** answer_peer 的四種錯誤。 */
  answerUnknown: (id: string) => `找不到問題 #${id}`,
  answerAlready: (id: string) => `問題 #${id} 已經回答過了`,
  answerCancelled: (id: string) => `問題 #${id} 已取消`,
  answerNotYours: (id: string) => `問題 #${id} 不是問你的`,
  answered: '已回答',
  /** 注入給對方的提問。格式與解析都在 shared/peer-tools.ts,這裡只是轉呼叫。 */
  injection: (provider: string, linkId: string, id: string, text: string) =>
    formatPeerInjection({ provider, fromLinkId: linkId, questionId: id, text }),
} as const
