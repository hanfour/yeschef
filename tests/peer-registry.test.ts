import { describe, it, expect } from 'vitest'
import { createPeerRegistry, type PeerEntry } from '../src/main/peer/registry.js'
import { PeerError } from '../src/main/peer/errors.js'

function entry(over: Partial<PeerEntry> & { conversationId: string }): PeerEntry {
  return {
    projectId: 'p-a',
    rootPath: '/p/alpha',
    provider: 'claude',
    linkId: () => `${over.conversationId}-link-0000`,
    isBusy: () => false,
    deliver: () => {},
    recentText: () => '',
    ...over,
  }
}

describe('register / unregister', () => {
  it('相同 conversationId 重複登錄只保留最新一筆', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    const old = entry({ conversationId: 'c1' })
    const latest = entry({ conversationId: 'c1', linkId: () => 'new-link', rootPath: '/new' })
    r.register(old)
    r.register(old)
    expect(r.peersOf('me')).toEqual([old])
    r.register(latest)
    r.register(latest)
    expect(r.get('c1')).toBe(latest)
    expect(r.peersOf('me')).toEqual([latest])
    expect(r.byLinkId('c1-link-0000')).toBeUndefined()
    expect(r.byLinkId('new-link')).toBe(latest)
  })

  it('登錄之後查得到,移除之後查不到', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'c1' }))
    expect(r.get('c1')?.conversationId).toBe('c1')
    r.unregister('c1')
    expect(r.get('c1')).toBeUndefined()
  })

  it('byLinkId 只找得到有 linkId 的', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'c1' }))
    r.register(entry({ conversationId: 'c2', linkId: () => undefined }))
    expect(r.byLinkId('c1-link-0000')?.conversationId).toBe('c1')
    expect(r.byLinkId('c2-link-0000')).toBeUndefined()
  })
})

describe('peersOf', () => {
  it('只算同一個專案、有 linkId、且不是自己的', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'c1' }))
    r.register(entry({ conversationId: 'c2' }))
    r.register(entry({ conversationId: 'c3', linkId: () => undefined }))
    r.register(entry({ conversationId: 'c4', projectId: 'p-b' }))
    expect(r.peersOf('c1').map((e) => e.conversationId)).toEqual(['c2'])
  })

  it('自己還沒登錄時回空陣列', () => {
    expect(createPeerRegistry().peersOf('nope')).toEqual([])
  })
})

describe('resolve', () => {
  const twoPeers = () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111', recentText: () => '在改 fold' }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'bbbbbbbb-2222', provider: 'codex' }))
    return r
  }

  it('沒有同伴:錯誤說沒有別的同伴', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    expect(() => r.resolve('me', undefined)).toThrow(PeerError)
    expect(() => r.resolve('me', undefined)).toThrow('這個專案沒有別的同伴')
  })

  it('只有一個同伴:省略 to 就是它', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111' }))
    expect(r.resolve('me', undefined).conversationId).toBe('p1')
  })

  it('只有一個同伴但 to 對不上:錯誤並列出那一個', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111' }))
    expect(() => r.resolve('me', 'zzzz')).toThrow(/找不到同伴 zzzz.*aaaaaaaa/s)
  })

  it('兩個以上且沒給 to:錯誤要求指定,列出每一個的 id、provider 與最近訊息', () => {
    const r = twoPeers()
    expect(() => r.resolve('me', undefined)).toThrow(/to 要指定一個/)
    expect(() => r.resolve('me', undefined)).toThrow(/aaaaaaaa\(claude\):在改 fold/)
    expect(() => r.resolve('me', undefined)).toThrow(/bbbbbbbb\(codex\)/)
  })

  it('完整 linkId 對得上', () => {
    expect(twoPeers().resolve('me', 'bbbbbbbb-2222').conversationId).toBe('p2')
  })

  it('前 8 碼對得上', () => {
    expect(twoPeers().resolve('me', 'aaaaaaaa').conversationId).toBe('p1')
  })

  it('前 8 碼對到多個:錯誤要求給完整 id', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'same0000-1111' }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'same0000-2222' }))
    expect(() => r.resolve('me', 'same0000')).toThrow(/對到多個同伴/)
  })

  it('完整比對優先於前綴:給完整 id 時不會因為別人前綴相同而歧義', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'same0000-1111' }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'same0000-2222' }))
    expect(r.resolve('me', 'same0000-2222').conversationId).toBe('p2')
  })

  it('最近訊息超過 40 字時截斷', () => {
    const long = '一'.repeat(60)
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111', recentText: () => long }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'bbbbbbbb-2222' }))
    try {
      r.resolve('me', undefined)
      throw new Error('該丟錯')
    } catch (e) {
      expect((e as Error).message).toContain('一'.repeat(40))
      expect((e as Error).message).not.toContain('一'.repeat(41))
    }
  })
})

describe('解析邊界與即時登錄狀態', () => {
  it('不接受空字串、少於或超過 8 碼的非完整前綴', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'aaaaaaaa-1111' }))
    for (const to of ['', 'a', 'aaaaaaa', 'aaaaaaaa-']) {
      expect(() => r.resolve('me', to)).toThrow(PeerError)
      expect(() => r.resolve('me', to)).toThrow(/找不到同伴.*aaaaaaaa\(claude\)/s)
    }
  })


  it('歧義與未知目標列出全部候選,不列自己或其他專案', () => {
    const r = createPeerRegistry()
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => 'same0000-1111' }))
    r.register(entry({ conversationId: 'p2', linkId: () => 'same0000-2222', provider: 'codex' }))
    r.register(entry({ conversationId: 'p3', linkId: () => 'cccccccc-3333' }))
    r.register(entry({ conversationId: 'other', projectId: 'p-b' }))
    for (const to of ['same0000', 'unknown', 'me-link-0000', 'other-link-0000']) {
      expect(() => r.resolve('me', to)).toThrow(PeerError)
      expect(() => r.resolve('me', to)).toThrow(/same0000\(claude\).*same0000\(codex\).*cccccccc\(claude\)/)
    }
  })

  it('每次讀取目前 linkId,重複登錄取代舊資料,已取出的清單不變', () => {
    const r = createPeerRegistry()
    let linkId: string | undefined
    r.register(entry({ conversationId: 'me' }))
    r.register(entry({ conversationId: 'p1', linkId: () => linkId }))
    expect(r.peersOf('me')).toEqual([])
    linkId = 'aaaaaaaa-1111'
    const previous = r.peersOf('me')
    expect(r.resolve('me', undefined).conversationId).toBe('p1')
    expect(r.byLinkId(linkId)?.conversationId).toBe('p1')
    linkId = undefined
    expect(r.peersOf('me')).toEqual([])
    expect(r.byLinkId('aaaaaaaa-1111')).toBeUndefined()
    r.register(entry({ conversationId: 'p1', provider: 'codex' }))
    expect(r.peersOf('me')).toHaveLength(1)
    expect(r.get('p1')?.provider).toBe('codex')
    expect(previous[0]?.provider).toBe('claude')
    r.unregister('p1')
    expect(previous).toHaveLength(1)
    expect(r.peersOf('me')).toEqual([])
  })
})
