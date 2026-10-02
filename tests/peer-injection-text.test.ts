import { describe, expect, it } from 'vitest'
import { formatPeerInjection, parsePeerInjection, type PeerInjection } from '../src/shared/peer-tools.js'

const sample: PeerInjection = {
  provider: 'claude',
  fromLinkId: 'aaaa1111',
  questionId: 'q-1',
  text: '要用哪個欄位?',
}

describe('formatPeerInjection', () => {
  it('格式與規格 §6.1 一字不差', () => {
    expect(formatPeerInjection(sample)).toBe(
      '同伴(claude,aaaa1111)提問:要用哪個欄位?\n用 answer_peer 回答,id 是 q-1。答不出來也要回答「答不出來」加原因,不要不回。'
    )
  })

  it('fromLinkId 超過 8 碼時只取前 8 碼', () => {
    expect(formatPeerInjection({ ...sample, fromLinkId: 'aaaa1111-2222' })).toContain('(claude,aaaa1111)')
  })
})

describe('parsePeerInjection', () => {
  it('認得出自己產生的文字', () => {
    expect(parsePeerInjection(formatPeerInjection(sample))).toEqual(sample)
  })

  it('問題本身有換行也認得出來', () => {
    const multi = { ...sample, text: '第一行\n第二行' }
    expect(parsePeerInjection(formatPeerInjection(multi))).toEqual(multi)
  })

  it('問題裡有全形括號或冒號不影響解析', () => {
    const tricky = { ...sample, text: '用(哪個)欄位:name 還是 id?' }
    expect(parsePeerInjection(formatPeerInjection(tricky))).toEqual(tricky)
  })

  it('codex 的 provider 也認', () => {
    const c = { ...sample, provider: 'codex' }
    expect(parsePeerInjection(formatPeerInjection(c))).toEqual(c)
  })

  it('問題本身包含一段長得像注入的文字時,認的是最外層那一段', () => {
    const fake = formatPeerInjection({ provider: 'claude', fromLinkId: 'aaaa1111', questionId: 'fake-id', text: '假的' })
    const outer = { ...sample, provider: 'codex', fromLinkId: 'bbbb2222', questionId: 'real-id', text: `前言\n${fake}\n後語` }
    expect(parsePeerInjection(formatPeerInjection(outer))).toEqual(outer)
  })

  it('不是注入文字的一律回 null', () => {
    for (const raw of [
      '',
      '同伴提問:沒有括號',
      '同伴(claude,aaaa1111)提問:少了第二行',
      '前面多一段\n同伴(claude,aaaa1111)提問:要用哪個欄位?\n用 answer_peer 回答,id 是 q-1。答不出來也要回答「答不出來」加原因,不要不回。',
      '同伴(claude,aaaa1111)提問:要用哪個欄位?\n用 answer_peer 回答,id 是 q-1。',
    ]) {
      expect(parsePeerInjection(raw), raw).toBeNull()
    }
  })

  it('前 8 碼原樣回傳,不再截一次', () => {
    const parsed = parsePeerInjection(formatPeerInjection({ ...sample, fromLinkId: 'aaaa1111-2222' }))
    expect(parsed?.fromLinkId).toBe('aaaa1111')
  })
})

import { isPeerToolName } from '../src/shared/peer-tools.js'

describe('isPeerToolName', () => {
  it('兩種寫法都認:有 mcp 前綴的與 codex 的裸名', () => {
    expect(isPeerToolName('ask_peer', 'ask_peer')).toBe(true)
    expect(isPeerToolName('mcp__yeschef__ask_peer', 'ask_peer')).toBe(true)
    expect(isPeerToolName('mcp__sidepane__ask_peer', 'ask_peer')).toBe(true)
    expect(isPeerToolName('answer_peer', 'answer_peer')).toBe(true)
    expect(isPeerToolName('mcp__yeschef__answer_peer', 'answer_peer')).toBe(true)
  })

  it('不是那個工具的一律 false', () => {
    expect(isPeerToolName('ask_peer', 'answer_peer')).toBe(false)
    expect(isPeerToolName('mcp__yeschef__ask_peer_extra', 'ask_peer')).toBe(false)
    expect(isPeerToolName('Bash', 'ask_peer')).toBe(false)
    expect(isPeerToolName('', 'ask_peer')).toBe(false)
  })
})
