/**
 * 同伴訊息(P 規格 §3.2)。純資料與純函式,不碰檔案系統。
 *
 * 三種訊息共用一個形狀:`inReplyTo` 把 answer 與 cancel 綁回 question,
 * `deadlineAt` 只有 question 有值。`actor` 記的是「實際寫這則的是誰」,
 * 與 `from`(這則代表誰)分開:人代替對方回答時 `from` 仍是對方,`actor` 是 `user`。
 */
import { asProvider, type Provider } from '../../shared/projects.js'

export const QUESTION_TIMEOUT_MS = 600_000

export interface PeerRef {
  readonly linkId: string
  readonly provider: Provider
}

export type PeerKind = 'question' | 'answer' | 'cancel'
export type PeerActor = 'session' | 'user' | 'host'

export interface PeerMessage {
  readonly id: string
  readonly kind: PeerKind
  readonly from: PeerRef
  readonly to: PeerRef
  readonly actor: PeerActor
  readonly inReplyTo: string | null
  readonly text: string
  readonly createdAt: number
  readonly deadlineAt: number | null
}

export function newQuestion(args: {
  readonly id: string
  readonly from: PeerRef
  readonly to: PeerRef
  readonly text: string
  readonly now: number
}): PeerMessage {
  return {
    id: args.id,
    kind: 'question',
    from: args.from,
    to: args.to,
    actor: 'session',
    inReplyTo: null,
    text: args.text,
    createdAt: args.now,
    deadlineAt: args.now + QUESTION_TIMEOUT_MS,
  }
}

export function newAnswer(args: {
  readonly id: string
  readonly question: PeerMessage
  readonly text: string
  readonly actor: PeerActor
  readonly now: number
}): PeerMessage {
  return {
    id: args.id,
    kind: 'answer',
    // 答案由被問的那方發出,人代答時也一樣(規格 §6.5:from 沿用原問題的 to)。
    from: args.question.to,
    to: args.question.from,
    actor: args.actor,
    inReplyTo: args.question.id,
    text: args.text,
    createdAt: args.now,
    deadlineAt: null,
  }
}

export function newCancel(args: {
  readonly id: string
  readonly question: PeerMessage
  readonly reason: string
  readonly actor: PeerActor
  readonly now: number
  /** 預設 true(方向與 answer 相同)。「提問方已結束」那一種要給 false(規格 §6.5 的表)。 */
  readonly swap?: boolean
}): PeerMessage {
  const swap = args.swap ?? true
  return {
    id: args.id,
    kind: 'cancel',
    from: swap ? args.question.to : args.question.from,
    to: swap ? args.question.from : args.question.to,
    actor: args.actor,
    inReplyTo: args.question.id,
    text: args.reason,
    createdAt: args.now,
    deadlineAt: null,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseRef(raw: unknown): PeerRef | null {
  if (!isRecord(raw) || !nonEmpty(raw['linkId'])) return null
  const provider = asProvider(raw['provider'])
  if (provider === undefined) return null
  return { linkId: raw['linkId'], provider }
}

/**
 * 信箱檔案進來時的執行期驗證。檔案是我們自己寫的,但可能被手改、被舊版寫過、
 * 或寫到一半斷電,所以每個欄位都要真的檢查。一律回新造的物件,額外欄位在這裡被切掉。
 */
export function parsePeerMessage(raw: unknown): PeerMessage | null {
  if (!isRecord(raw)) return null
  const kind = raw['kind']
  if (kind !== 'question' && kind !== 'answer' && kind !== 'cancel') return null
  const actor = raw['actor']
  if (actor !== 'session' && actor !== 'user' && actor !== 'host') return null
  const from = parseRef(raw['from'])
  const to = parseRef(raw['to'])
  if (from === null || to === null) return null
  if (!nonEmpty(raw['id'])) return null
  if (typeof raw['text'] !== 'string') return null
  if (!finite(raw['createdAt'])) return null
  const inReplyTo = raw['inReplyTo']
  if (inReplyTo !== null && !nonEmpty(inReplyTo)) return null
  const deadlineAt = raw['deadlineAt']
  if (deadlineAt !== null && !finite(deadlineAt)) return null
  return {
    id: raw['id'],
    kind,
    from,
    to,
    actor,
    inReplyTo,
    text: raw['text'],
    createdAt: raw['createdAt'],
    deadlineAt,
  }
}
