import { describe, it, expect } from 'vitest'
import {
  QUESTION_TIMEOUT_MS, newAnswer, newCancel, newQuestion, parsePeerMessage,
  type PeerMessage, type PeerRef,
} from '../src/main/peer/message.js'

const A: PeerRef = { linkId: 'aaaaaaaa-1111', provider: 'claude' }
const B: PeerRef = { linkId: 'bbbbbbbb-2222', provider: 'codex' }

const question = (): PeerMessage => newQuestion({ id: 'q1', from: A, to: B, text: '要用哪個欄位?', now: 1000 })

describe('newQuestion', () => {
  it('欄位齊全,deadlineAt 是 createdAt 加 10 分鐘', () => {
    expect(question()).toEqual({
      id: 'q1', kind: 'question', from: A, to: B, actor: 'session',
      inReplyTo: null, text: '要用哪個欄位?', createdAt: 1000, deadlineAt: 1000 + QUESTION_TIMEOUT_MS,
    })
    expect(QUESTION_TIMEOUT_MS).toBe(600_000)
  })
})

describe('newAnswer', () => {
  it('from／to 與問題相反,inReplyTo 指回問題,沒有 deadline', () => {
    expect(newAnswer({ id: 'a1', question: question(), text: '用 linkId', actor: 'session', now: 2000 })).toEqual({
      id: 'a1', kind: 'answer', from: B, to: A, actor: 'session',
      inReplyTo: 'q1', text: '用 linkId', createdAt: 2000, deadlineAt: null,
    })
  })
  it('人代替回答時 from 仍是被代答的那一方,actor 是 user', () => {
    const m = newAnswer({ id: 'a2', question: question(), text: '我幫他答', actor: 'user', now: 2000 })
    expect(m.from).toEqual(B)
    expect(m.actor).toBe('user')
  })
})

describe('newCancel', () => {
  it('預設方向與 answer 相同(逾時、同伴已結束、重啟、使用者取消)', () => {
    expect(newCancel({ id: 'c1', question: question(), reason: '同伴 10 分鐘內沒有回答', actor: 'host', now: 3000 })).toEqual({
      id: 'c1', kind: 'cancel', from: B, to: A, actor: 'host',
      inReplyTo: 'q1', text: '同伴 10 分鐘內沒有回答', createdAt: 3000, deadlineAt: null,
    })
  })
  it('提問方已結束時方向不換:from 是原問題的 from(規格 §6.5 的表)', () => {
    const m = newCancel({ id: 'c2', question: question(), reason: '提問方已結束', actor: 'host', now: 3000, swap: false })
    expect(m.from).toEqual(A)
    expect(m.to).toEqual(B)
  })
})

describe('parsePeerMessage', () => {
  it('完整的訊息原樣通過,額外欄位被切掉', () => {
    const raw = { ...question(), extra: 1 }
    expect(parsePeerMessage(raw)).toEqual(question())
  })
  it('三種 kind 都認得', () => {
    for (const m of [question(), newAnswer({ id: 'a', question: question(), text: 't', actor: 'session', now: 1 }), newCancel({ id: 'c', question: question(), reason: 'r', actor: 'host', now: 1 })]) {
      expect(parsePeerMessage(JSON.parse(JSON.stringify(m)))).toEqual(m)
    }
  })
  it('缺欄位、型別不符、不認得的 kind 或 actor 都回 null', () => {
    const ok = question()
    expect(parsePeerMessage(null)).toBeNull()
    expect(parsePeerMessage({ ...ok, id: '' })).toBeNull()
    expect(parsePeerMessage({ ...ok, kind: 'notify' })).toBeNull()
    expect(parsePeerMessage({ ...ok, actor: 'robot' })).toBeNull()
    expect(parsePeerMessage({ ...ok, from: { linkId: 'x' } })).toBeNull()
    expect(parsePeerMessage({ ...ok, from: { linkId: 'x', provider: 'gemini' } })).toBeNull()
    expect(parsePeerMessage({ ...ok, text: 42 })).toBeNull()
    expect(parsePeerMessage({ ...ok, createdAt: 'now' })).toBeNull()
    expect(parsePeerMessage({ ...ok, inReplyTo: 5 })).toBeNull()
    expect(parsePeerMessage({ ...ok, deadlineAt: 'later' })).toBeNull()
  })
  it('grok 是合法的 provider,gemini 仍被拒(PROVIDERS 表之後 parseRef 不再寫死兩家)', () => {
    const ok = question()
    expect(parsePeerMessage({ ...ok, from: { linkId: 'x', provider: 'grok' } })?.from).toEqual({ linkId: 'x', provider: 'grok' })
    expect(parsePeerMessage({ ...ok, from: { linkId: 'x', provider: 'gemini' } })).toBeNull()
  })
  it('inReplyTo 與 deadlineAt 允許 null', () => {
    const m = newAnswer({ id: 'a', question: question(), text: 't', actor: 'session', now: 1 })
    expect(parsePeerMessage(JSON.parse(JSON.stringify(m)))?.deadlineAt).toBeNull()
    expect(parsePeerMessage(JSON.parse(JSON.stringify(question())))?.inReplyTo).toBeNull()
  })
})
