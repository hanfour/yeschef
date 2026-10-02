import { describe, expect, it } from 'vitest'
import { fold } from '../src/shared/fold.js'
import { formatPeerInjection } from '../src/shared/peer-tools.js'
import type { Event } from '../src/shared/events.js'

const injected = formatPeerInjection({
  provider: 'claude', fromLinkId: 'aaaa1111', questionId: 'q-1', text: '要用哪個欄位?',
})

describe('同伴提問自成一輪', () => {
  it('注入的提問變成 peer-question 區塊,不是文字', () => {
    const view = fold([{ kind: 'user-text', text: injected }] as readonly Event[])
    expect(view.turns).toHaveLength(1)
    expect(view.turns[0]?.role).toBe('user')
    expect(view.turns[0]?.blocks).toEqual([
      { kind: 'peer-question', questionId: 'q-1', fromLinkId: 'aaaa1111', provider: 'claude', text: '要用哪個欄位?' },
    ])
  })

  it('一般的使用者文字不受影響', () => {
    const view = fold([{ kind: 'user-text', text: '同伴(claude,aaaa1111)提問:少了第二行' }] as readonly Event[])
    expect(view.turns[0]?.blocks[0]).toEqual({ kind: 'text', markdown: '同伴(claude,aaaa1111)提問:少了第二行', complete: true })
  })

  it('提問與它前後的輪次各自獨立', () => {
    const view = fold([
      { kind: 'user-text', text: '你好' },
      { kind: 'user-text', text: injected },
      { kind: 'user-text', text: '再見' },
    ] as readonly Event[])
    expect(view.turns.map((t) => t.blocks[0]?.kind)).toEqual(['text', 'peer-question', 'text'])
  })
})
