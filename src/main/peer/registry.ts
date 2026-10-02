/**
 * 活著的同伴(P 規格 §5)。「活著」= 有登錄、而且已經有 linkId:
 * 還沒送過訊息的對話沒有 session,指不到它,也注入不進去。
 *
 * 登錄的內容由 `ipc-bridge` 提供:它是唯一知道每個對話的 core 在不在、忙不忙、
 * 怎麼把一則文字送進去的地方。這個檔只管「有誰」與「`to` 指的是誰」。
 */
import type { Provider } from '../../shared/projects.js'
import { PEER_MSG, PeerError, type PeerCandidate } from './errors.js'

export const RECENT_TEXT_MAX = 40

export interface PeerEntry {
  readonly conversationId: string
  readonly projectId: string
  readonly rootPath: string
  readonly provider: Provider
  /** 這個對話目前的 linkId(= sessionId);還沒開始就是 undefined。 */
  readonly linkId: () => string | undefined
  readonly isBusy: () => boolean
  /** 把一則文字送進這個對話,跟使用者打字同一條路。 */
  readonly deliver: (text: string) => void
  /** 最近一則使用者訊息,給候選清單用。 */
  readonly recentText: () => string
}

export interface PeerRegistry {
  register(entry: PeerEntry): void
  unregister(conversationId: string): void
  get(conversationId: string): PeerEntry | undefined
  byLinkId(linkId: string): PeerEntry | undefined
  /** 同一個專案裡除了自己以外還活著的。 */
  peersOf(conversationId: string): readonly PeerEntry[]
  /** 解析 `to`;失敗丟 `PeerError`,訊息一律帶候選清單。 */
  resolve(conversationId: string, to: string | undefined): PeerEntry
}

const candidateOf = (entry: PeerEntry): PeerCandidate => ({
  linkId: entry.linkId() ?? '',
  provider: entry.provider,
  recent: entry.recentText().slice(0, RECENT_TEXT_MAX),
})

export function createPeerRegistry(): PeerRegistry {
  let entries = new Map<string, PeerEntry>()

  const alive = (entry: PeerEntry): boolean => entry.linkId() !== undefined

  const peersOf = (conversationId: string): readonly PeerEntry[] => {
    const self = entries.get(conversationId)
    if (self === undefined) return []
    return [...entries.values()].filter(
      (e) => e.conversationId !== conversationId && e.projectId === self.projectId && alive(e),
    )
  }

  return {
    register(entry) { entries = new Map([...entries, [entry.conversationId, entry]]) },
    unregister(conversationId) {
      entries = new Map([...entries].filter(([id]) => id !== conversationId))
    },
    get: (conversationId) => entries.get(conversationId),
    byLinkId: (linkId) => [...entries.values()].find((e) => alive(e) && e.linkId() === linkId),
    peersOf,

    resolve(conversationId, to) {
      const peers = peersOf(conversationId)
      const candidates = peers.map(candidateOf)
      if (peers.length === 0) throw new PeerError(PEER_MSG.noPeers)
      if (to === undefined) {
        const only = peers[0]
        if (peers.length === 1 && only !== undefined) return only
        throw new PeerError(PEER_MSG.toRequired(candidates))
      }
      // 完整比對優先:前綴相同的兩個同伴,給完整 id 時不該變成歧義。
      const exact = peers.find((e) => e.linkId() === to)
      if (exact !== undefined) return exact
      const prefixed = peers.filter((e) => to.length === 8 && e.linkId()?.slice(0, 8) === to)
      const first = prefixed[0]
      if (prefixed.length === 1 && first !== undefined) return first
      if (prefixed.length > 1) throw new PeerError(PEER_MSG.toAmbiguous(to, candidates))
      throw new PeerError(PEER_MSG.toUnknown(to, candidates))
    },
  }
}
