/**
 * 同伴問答的行為(P 規格 §4、§5、§6、§7)。
 *
 * 阻塞的那一半在這裡:`askPeer` 回傳一個 promise,收到答案、逾時、對話結束、
 * dispose、重啟取消、注入失敗或寫檔失敗時結束。掃描信箱是行程內喚醒失敗時的後盾。
 * 檔案是終態的依據;dispose 或寫檔失敗時仍會收掉等待,行程內的 Map 只是加速。
 *
 * 注入不插隊:對方回合進行中就排著,`notifyIdle` 來了再送。逾時從建立訊息時算,
 * 不從注入時算,問的那方感受到的是「我等了多久」。
 */
import type { Provider } from '../../shared/projects.js'
import type { MergerClock } from '../agent-host.js'
import { PEER_MSG, PeerError } from './errors.js'
import type { Mailbox, MailboxEntry } from './mailbox.js'
import { newAnswer, newCancel, newQuestion, type PeerMessage } from './message.js'
import type { PeerRegistry } from './registry.js'

export const SCAN_INTERVAL_MS = 5_000

export interface PeerTools {
  /** 阻塞到收到答案;逾時、取消、對方結束都以 `PeerError` 結束。 */
  askPeer(question: string, to?: string): Promise<string>
  answerPeer(id: string, text: string): Promise<string>
}

export interface PeerServiceDeps {
  readonly registry: PeerRegistry
  /** 每次呼叫都會新造 Mailbox,必須廉價且沒有副作用,不要在裡面 mkdir 或建快取。 */
  readonly mailboxFor: (projectId: string, rootPath: string) => Mailbox
  readonly clock: MergerClock
  readonly newId: () => string
  readonly logError: (error: Error) => void
  readonly scanIntervalMs?: number
}

/** 一則未決問題對外的樣子。給畫面用,不含 promise 的收尾函式。 */
export interface PeerPending {
  readonly targetProvider: Provider
  readonly questionId: string
  readonly projectId: string
  readonly askerConversationId: string
  readonly targetConversationId: string
  /** 被問的那方的 linkId。提問方那側的畫面顯示它的前 8 碼。 */
  readonly targetLinkId: string
  /** 提問方的 linkId。回答方那側的畫面顯示它的前 8 碼。 */
  readonly askerLinkId: string
  readonly text: string
  readonly createdAt: number
  /** 還沒注入(對方回合進行中)。 */
  readonly queued: boolean
}

export interface PeerService {
  /** 目前所有未決問題,依 createdAt 排序。取消中的不列。 */
  pending(): readonly PeerPending[]
  /** 未決集合有變動時通知。回傳取消訂閱的函式。 */
  onChange(listener: () => void): () => void
  /** 人代替同伴回答(規格 §6.5)。 */
  answerAsUser(questionId: string, text: string): Promise<void>
  /** 人取消一則提問(規格 §6.5)。 */
  cancelAsUser(questionId: string): Promise<void>

  readonly registry: PeerRegistry
  forConversation(conversationId: string): PeerTools
  /** 某個對話的回合結束了:把排給它的提問送進去。 */
  notifyIdle(conversationId: string): void
  /** 某個對話結束了:它問的與問它的未決問題都收掉。 */
  conversationEnded(conversationId: string): void
  /** app 啟動時掃這些專案的信箱,未決全取消(規格 §7)。 */
  cancelPendingOnStartup(projects: readonly { projectId: string; rootPath: string }[]): Promise<void>
  dispose(): void
}

/** 一筆進行中的等待。檔案是真相,這裡只是為了讓 promise 收得掉。 */
interface Waiting {
  readonly questionId: string
  readonly askerConversationId: string
  readonly targetConversationId: string
  readonly projectId: string
  readonly rootPath: string
  readonly question: PeerMessage
  readonly resolve: (text: string) => void
  readonly reject: (error: Error) => void
  /** 還沒注入(對方回合進行中)。 */
  readonly queued: boolean
  readonly cancelling?: boolean
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export function createPeerService(deps: PeerServiceDeps): PeerService {
  let waiting = new Map<string, Waiting>()
  let listeners: readonly (() => void)[] = []
  const notifyChange = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (cause) {
        deps.logError(new Error(PEER_MSG.changeNotificationFailed(messageOf(cause))))
      }
    }
  }

  /** 換掉 waiting 並通知。所有寫入都走這裡,漏一處畫面就不會更新。 */
  const setWaiting = (next: Map<string, Waiting>): void => {
    waiting = next
    notifyChange()
  }

  // 同一專案的檔案讀改寫依序完成,避免同時回答或取消覆蓋終態。
  let operations = new Map<string, Promise<unknown>>()
  const serial = <T>(projectId: string, work: () => Promise<T>): Promise<T> => {
    const next = (operations.get(projectId) ?? Promise.resolve()).then(work)
    const tail = next.catch(() => {})
    operations = new Map([...operations, [projectId, tail]])
    void tail.then(() => {
      if (operations.get(projectId) === tail) {
        operations = new Map([...operations].filter(([id]) => id !== projectId))
      }
    })
    return next
  }
  const scanEvery = deps.scanIntervalMs ?? SCAN_INTERVAL_MS
  let disposed = false

  const mailboxOf = (entry: { projectId: string; rootPath: string }): Mailbox =>
    deps.mailboxFor(entry.projectId, entry.rootPath)

  const settle = (questionId: string, done: (w: Waiting) => void): void => {
    const w = waiting.get(questionId)
    if (w === undefined) return
    setWaiting(new Map([...waiting].filter(([id]) => id !== questionId)))
    done(w)
  }

  /** 寫 cancel 並讓等待方以那個原因結束。寫檔失敗只記錯,promise 照樣收掉。 */
  const cancelQuestion = async (w: Waiting, reason: string, actor: 'host' | 'user', swap = true): Promise<void> => {
    const current = waiting.get(w.questionId)
    if (current === undefined || current.cancelling) return
    setWaiting(new Map([...waiting, [w.questionId, { ...current, cancelling: true }]]))
    await serial(w.projectId, async () => {
      if (!waiting.has(w.questionId)) return
      try {
        const mailbox = mailboxOf(w)
        const entry = await mailbox.read(w.questionId)
        if (entry?.status === 'answered' && entry.answer !== undefined) {
          const text = entry.answer.text
          settle(w.questionId, (x) => x.resolve(text))
          return
        }
        if (entry?.status === 'cancelled' && entry.cancel !== undefined) {
          const reason = entry.cancel.text
          settle(w.questionId, (x) => x.reject(new PeerError(reason)))
          return
        }
        await mailbox.write(newCancel({ id: deps.newId(), question: w.question, reason, actor, now: deps.clock.now(), swap }))
      } catch (cause) {
        deps.logError(new Error(PEER_MSG.cancelWriteFailed(w.questionId, messageOf(cause))))
      }
      settle(w.questionId, (x) => x.reject(new PeerError(reason)))
    })
  }

  const inject = (w: Waiting): void => {
    if (disposed || !waiting.has(w.questionId) || waiting.get(w.questionId)?.cancelling) return
    if (w.question.deadlineAt !== null && deps.clock.now() >= w.question.deadlineAt) {
      void cancelQuestion(w, PEER_MSG.timedOut, 'host')
      return
    }
    const target = deps.registry.get(w.targetConversationId)
    if (target === undefined) {
      void cancelQuestion(w, PEER_MSG.peerEnded, 'host')
      return
    }
    if (target.isBusy()) {
      setWaiting(new Map([...waiting, [w.questionId, { ...w, queued: true }]]))
      return
    }
    setWaiting(new Map([...waiting, [w.questionId, { ...w, queued: false }]]))
    const from = w.question.from
    try {
      target.deliver(PEER_MSG.injection(from.provider, from.linkId, w.questionId, w.question.text))
    } catch (cause) {
      deps.logError(new Error(PEER_MSG.deliveryFailed(w.questionId, messageOf(cause))))
      void cancelQuestion(w, PEER_MSG.peerEnded, 'host')
    }
  }

  /** 掃描:逾時、答案檔壞掉、行程內喚醒失敗的後盾。 */
  const scan = async (): Promise<void> => {
    const now = deps.clock.now()
    for (const w of [...waiting.values()]) {
      const deadline = w.question.deadlineAt
      if (deadline !== null && now >= deadline) {
        await cancelQuestion(w, PEER_MSG.timedOut, 'host')
        continue
      }
      let entry: MailboxEntry | null = null
      try {
        entry = await mailboxOf(w).read(w.questionId)
      } catch (cause) {
        deps.logError(new Error(PEER_MSG.scanFailed(w.questionId, messageOf(cause))))
        continue
      }
      if (entry === null) continue
      if (entry.status === 'answered' && entry.answer !== undefined) {
        const text = entry.answer.text
        settle(w.questionId, (x) => x.resolve(text))
        continue
      }
      if (entry.status === 'cancelled' && entry.cancel !== undefined) {
        const reason = entry.cancel.text
        settle(w.questionId, (x) => x.reject(new PeerError(reason)))
        continue
      }
      // 答案檔壞掉:等下去也等不到答案,不等逾時(規格 §3.1)。
      if (entry.corruptAnswer) {
        await cancelQuestion(w, PEER_MSG.answerCorrupt, 'host')
        continue
      }
    }
  }

  /**
   * 掃描迴圈。`MergerClock.setTimer` 是一次性的(setTimeout 語意),所以每輪掃完自己重排;
   * 掃描是 async,重排放在 finally,一次掃描丟出例外不會讓迴圈停掉。
   */
  let timer: unknown = null
  const arm = (): void => {
    timer = deps.clock.setTimer(() => {
      scan()
        .catch((cause: unknown) => { deps.logError(new Error(PEER_MSG.scanFailed(undefined, messageOf(cause)))) })
        .finally(() => { if (!disposed) arm() })
    }, scanEvery)
  }
  arm()

  /** 回答共用寫檔與行程內喚醒;呼叫端持有專案序列。 */
  const writeAnswer = async (mailbox: Mailbox, question: PeerMessage, text: string, actor: 'session' | 'user'): Promise<void> => {
    await mailbox.write(newAnswer({ id: deps.newId(), question, text, actor, now: deps.clock.now() }))
    settle(question.id, (w) => w.resolve(text))
  }

  const forConversation = (conversationId: string): PeerTools => ({
    async askPeer(question, to) {
      // dispose() 之後 MCP server 可能還在,工具還收得到呼叫。
      if (disposed) throw new PeerError(PEER_MSG.serviceStopped)
      const self = deps.registry.get(conversationId)
      const linkId = self?.linkId()
      if (self === undefined || linkId === undefined) throw new PeerError(PEER_MSG.noPeers)
      const mine = [...waiting.values()].find((w) => w.askerConversationId === conversationId)
      if (mine !== undefined) throw new PeerError(PEER_MSG.alreadyAsking(mine.questionId))

      const target = deps.registry.resolve(conversationId, to)
      // 死鎖:對方正在等我回答(規格 §6.4)。
      const theirs = [...waiting.values()].find(
        (w) => w.askerConversationId === target.conversationId && w.targetConversationId === conversationId,
      )
      if (theirs !== undefined) throw new PeerError(PEER_MSG.deadlock(theirs.questionId))

      const targetLinkId = target.linkId()
      if (targetLinkId === undefined) throw new PeerError(PEER_MSG.peerEnded)
      const message = newQuestion({
        id: deps.newId(),
        from: { linkId, provider: self.provider },
        to: { linkId: targetLinkId, provider: target.provider },
        text: question,
        now: deps.clock.now(),
      })
      return await new Promise<string>((resolve, reject) => {
        const w: Waiting = {
          questionId: message.id,
          askerConversationId: conversationId,
          targetConversationId: target.conversationId,
          projectId: self.projectId,
          rootPath: self.rootPath,
          question: message,
          resolve,
          reject,
          queued: false,
        }
        setWaiting(new Map([...waiting, [message.id, w]]))
        void serial(self.projectId, async () => {
          try {
            await mailboxOf(w).write(message)
          } catch (cause) {
            settle(message.id, (x) => x.reject(new PeerError(PEER_MSG.mailboxUnwritable(messageOf(cause)))))
            return
          }
          inject(w)
        })
      })
    },

    async answerPeer(id, text) {
      if (disposed) throw new PeerError(PEER_MSG.serviceStopped)
      const self = deps.registry.get(conversationId)
      if (self === undefined) throw new PeerError(PEER_MSG.answerUnknown(id))
      return await serial(self.projectId, async () => {
        if (disposed) throw new PeerError(PEER_MSG.serviceStopped)
        const mailbox = deps.mailboxFor(self.projectId, self.rootPath)
        const entry = await mailbox.read(id)
        if (entry === null) throw new PeerError(PEER_MSG.answerUnknown(id))
        if (entry.status === 'answered') throw new PeerError(PEER_MSG.answerAlready(id))
        if (entry.status === 'cancelled') throw new PeerError(PEER_MSG.answerCancelled(id))
        if (entry.question.to.linkId !== self.linkId()) throw new PeerError(PEER_MSG.answerNotYours(id))
        await writeAnswer(mailbox, entry.question, text, 'session')
        return PEER_MSG.answered
      })
    },
  })

  return {
    registry: deps.registry,
    forConversation,
    pending: () =>
      [...waiting.values()]
        .filter((w) => w.cancelling !== true)
        .map((w) => ({
          questionId: w.questionId,
          projectId: w.projectId,
          askerConversationId: w.askerConversationId,
          targetConversationId: w.targetConversationId,
          askerLinkId: w.question.from.linkId,
          targetLinkId: w.question.to.linkId,
          targetProvider: w.question.to.provider,
          text: w.question.text,
          createdAt: w.question.createdAt,
          queued: w.queued,
        }))
        .sort((a, b) => a.createdAt - b.createdAt),

    onChange(listener) {
      listeners = [...listeners, listener]
      return () => {
        listeners = listeners.filter((l) => l !== listener)
      }
    },

    async answerAsUser(questionId, text) {
      const w = waiting.get(questionId)
      if (w === undefined || w.cancelling === true) throw new PeerError(PEER_MSG.pendingUnknown(questionId))
      await serial(w.projectId, async () => {
        const current = waiting.get(questionId)
        if (current === undefined || current.cancelling === true) throw new PeerError(PEER_MSG.pendingUnknown(questionId))
        const mailbox = mailboxOf(current)
        const entry = await mailbox.read(questionId)
        if (entry?.status !== 'pending') throw new PeerError(PEER_MSG.pendingUnknown(questionId))
        await writeAnswer(mailbox, current.question, text, 'user')
      })
    },

    async cancelAsUser(questionId) {
      const w = waiting.get(questionId)
      if (w === undefined || w.cancelling === true) throw new PeerError(PEER_MSG.pendingUnknown(questionId))
      await cancelQuestion(w, PEER_MSG.userCancelled, 'user')
    },

    notifyIdle(conversationId) {
      for (const w of [...waiting.values()]) {
        if (w.targetConversationId === conversationId && w.queued) inject(w)
      }
    },

    conversationEnded(conversationId) {
      for (const w of [...waiting.values()]) {
        if (w.askerConversationId === conversationId) {
          // 提問方已結束:方向不換(規格 §6.5 的表)。
          void cancelQuestion(w, PEER_MSG.askerEnded, 'host', false)
        } else if (w.targetConversationId === conversationId) {
          void cancelQuestion(w, PEER_MSG.peerEnded, 'host')
        }
      }
    },

    // 啟動當下 registry 還是空的,要掃哪些專案由呼叫端給。
    async cancelPendingOnStartup(projects) {
      for (const p of projects) {
        const mailbox = deps.mailboxFor(p.projectId, p.rootPath)
        await mailbox.restoreFromMirror()
        for (const item of await mailbox.list()) {
          if (item.status !== 'pending') continue
          await serial(p.projectId, async () => {
            const current = await mailbox.read(item.question.id)
            if (current?.status !== 'pending') return
            await mailbox.write(newCancel({
              id: deps.newId(), question: item.question, reason: PEER_MSG.restarted, actor: 'host', now: deps.clock.now(),
            }))
            settle(item.question.id, (w) => w.reject(new PeerError(PEER_MSG.restarted)))
          })
        }
      }
    },

    dispose() {
      disposed = true
      deps.clock.clearTimer(timer)
      for (const w of [...waiting.values()]) {
        settle(w.questionId, (x) => x.reject(new PeerError(PEER_MSG.serviceStopped)))
      }
    },
  }
}
