import { describe, it, expect } from 'vitest'
import { createPeerService, SCAN_INTERVAL_MS } from '../src/main/peer/service.js'
import { createPeerRegistry, type PeerEntry } from '../src/main/peer/registry.js'
import { createMailbox, type MailboxFs } from '../src/main/peer/mailbox.js'
import { PEER_MSG } from '../src/main/peer/errors.js'
import { QUESTION_TIMEOUT_MS, newAnswer, newQuestion } from '../src/main/peer/message.js'
import type { MergerClock } from '../src/main/agent-host.js'

/**
 * 手動推進的時鐘。與 `SYSTEM_CLOCK` 一樣是一次性計時器(setTimeout 語意):
 * 觸發後就從表裡消失,要再跑就得自己重排。service 的掃描迴圈正是這樣重排的。
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve()
}

function fakeClock() {
  let now = 1_000_000
  const timers = new Map<number, { fn: () => void; at: number }>()
  let nextHandle = 1
  const clock: MergerClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = nextHandle
      nextHandle += 1
      timers.set(handle, { fn, at: now + ms })
      return handle
    },
    clearTimer: (handle) => { timers.delete(handle as number) },
  }
  const tick = (): Promise<void> => drainMicrotasks()
  /** 前進時間,跑掉到期的計時器,然後把 promise 佇列清乾淨。 */
  const advance = async (ms: number): Promise<void> => {
    now += ms
    for (const [handle, t] of [...timers]) {
      if (t.at > now) continue
      timers.delete(handle)
      t.fn()
      await tick()
    }
    await tick()
  }
  return { clock, advance, at: () => now }
}

function memFs() {
  const files = new Map<string, string>()
  const failingWrites = new Set<string>()
  const fs: MailboxFs = {
    async readFile(p) { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    async writeFile(p, d) { if (failingWrites.has(p)) throw new Error('write failed'); files.set(p, d) },
    async rename(from, to) { const v = files.get(from)!; files.delete(from); files.set(to, v) },
    async readdir(p) { const pre = `${p}/`; return [...files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)) },
    async mkdir() {},
    async exists(p) { return files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)) },
  }
  return { fs, files, failingWrites }
}

function setup(scanIntervalMs = SCAN_INTERVAL_MS) {
  const { fs, files, failingWrites } = memFs()
  const { clock, advance } = fakeClock()
  const errors: string[] = []
  const delivered: Array<[string, string]> = []
  const registry = createPeerRegistry()
  let ids = 0
  const rawService = createPeerService({
    registry,
    scanIntervalMs,
    mailboxFor: (projectId) => createMailbox({
      dir: `/p/${projectId}/.yeschef/mail`,
      ignoreDir: `/p/${projectId}/.yeschef`,
      mirrorDir: `/data/mail/${projectId}`,
      fs,
      logError: (e) => { errors.push(e.message) },
    }),
    clock,
    newId: () => `id-${(ids += 1)}`,
    logError: (e) => { errors.push(e.message) },
  })
  // Attach a rejection observer immediately for intentionally ignored promises.
  const service = { ...rawService, forConversation(conversationId: string) {
    const tools = rawService.forConversation(conversationId)
    return { ...tools, askPeer(question: string, to?: string) {
      const pending = tools.askPeer(question, to)
      void pending.catch(() => {})
      return pending
    } }
  } }
  const busy = new Map<string, boolean>()
  const add = (conversationId: string, linkId: string): PeerEntry => {
    const entry: PeerEntry = {
      conversationId, projectId: 'alpha', rootPath: '/p/alpha', provider: 'claude',
      linkId: () => linkId,
      isBusy: () => busy.get(conversationId) ?? false,
      deliver: (text) => { delivered.push([conversationId, text]) },
      recentText: () => '',
    }
    registry.register(entry)
    return entry
  }
  return { service, registry, add, busy, delivered, errors, files, failingWrites, advance, clock }
}

const flush = (): Promise<void> => drainMicrotasks()

describe('askPeer 的成功路徑', () => {
  it('寫 question、立刻注入對方、answerPeer 之後拿到答案', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('要用哪個欄位?')
    await flush()
    expect([...r.files.keys()].some((k) => k.endsWith('question-id-1.json'))).toBe(true)
    expect(r.delivered).toHaveLength(1)
    const [target, text] = r.delivered[0]!
    expect(target).toBe('B')
    expect(text).toContain('同伴(claude,aaaa1111)提問:要用哪個欄位?')
    expect(text).toContain('id 是 id-1')

    expect(await r.service.forConversation('B').answerPeer('id-1', '用 linkId')).toBe(PEER_MSG.answered)
    expect(await pending).toBe('用 linkId')
    expect([...r.files.keys()].some((k) => k.endsWith('answer-id-1.json'))).toBe(true)
  })

  it('對方回合進行中時排隊,回合結束才注入,而且只注入一次', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    void r.service.forConversation('A').askPeer('在忙嗎?')
    await flush()
    expect(r.delivered).toHaveLength(0)
    r.busy.set('B', false)
    r.service.notifyIdle('B')
    await flush()
    expect(r.delivered).toHaveLength(1)
    r.service.notifyIdle('B')
    await flush()
    expect(r.delivered).toHaveLength(1)
  })

  it('to 指定同伴時送給指定的那個', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.add('C', 'cccc3333')
    void r.service.forConversation('A').askPeer('問你', 'cccc3333')
    await flush()
    expect(r.delivered[0]?.[0]).toBe('C')
  })
})

describe('askPeer 的錯誤', () => {
  it('寫 question 失敗會清除等待,下一次仍能提問', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.failingWrites.add('/p/alpha/.yeschef/mail/question-id-1.json.tmp')
    await expect(r.service.forConversation('A').askPeer('第一題')).rejects.toThrow(PEER_MSG.mailboxUnwritable('write failed'))
    expect(r.delivered).toHaveLength(0)
    const pending = r.service.forConversation('A').askPeer('第二題')
    await flush()
    expect(r.delivered).toHaveLength(1)
    await r.service.forConversation('B').answerPeer('id-2', '答案')
    expect(await pending).toBe('答案')
  })

  it('自己已有未決問題:第二次直接回錯誤,不寫檔', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('第一題')
    await flush()
    const before = r.files.size
    await expect(r.service.forConversation('A').askPeer('第二題')).rejects.toThrow(PEER_MSG.alreadyAsking('id-1'))
    expect(r.files.size).toBe(before)
  })

  it('死鎖:A 等 B 時 B 問 A,B 拿到錯誤,A 的問題不受影響', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const aPending = r.service.forConversation('A').askPeer('A 問 B')
    await flush()
    await expect(r.service.forConversation('B').askPeer('B 問 A')).rejects.toThrow(PEER_MSG.deadlock('id-1'))
    expect(await r.service.forConversation('B').answerPeer('id-1', '我先答')).toBe(PEER_MSG.answered)
    expect(await aPending).toBe('我先答')
  })

  it('沒有同伴:回錯誤', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    await expect(r.service.forConversation('A').askPeer('有人嗎')).rejects.toThrow(PEER_MSG.noPeers)
  })

})

describe('answerPeer 的錯誤', () => {
  it('四種錯誤各一', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const B = r.service.forConversation('B')
    await expect(B.answerPeer('nope', 'x')).rejects.toThrow(PEER_MSG.answerUnknown('nope'))

    void r.service.forConversation('A').askPeer('題目')
    await flush()
    // 不是問你的
    await expect(r.service.forConversation('A').answerPeer('id-1', 'x')).rejects.toThrow(PEER_MSG.answerNotYours('id-1'))
    await B.answerPeer('id-1', '答案')
    await expect(B.answerPeer('id-1', '再答一次')).rejects.toThrow(PEER_MSG.answerAlready('id-1'))

    void r.service.forConversation('A').askPeer('第二題')
    await flush()
    r.service.conversationEnded('A')
    await flush()
    await expect(B.answerPeer('id-3', '晚了')).rejects.toThrow(PEER_MSG.answerCancelled('id-3'))
  })
})

describe('逾時', () => {
  it('599 秒不取消,600 秒取消,原因正確', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('等你')
    await flush()
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })

    await r.advance(599_000)
    expect(settled).toBe(false)
    await r.advance(QUESTION_TIMEOUT_MS - 599_000 + SCAN_INTERVAL_MS)
    await expect(pending).rejects.toThrow(PEER_MSG.timedOut)
    expect([...r.files.keys()].some((k) => k.endsWith('cancel-id-1.json'))).toBe(true)
  })

  it('等待期間 question 損毀,600 秒後仍以逾時取消', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('等你')
    await flush()
    r.files.set('/p/alpha/.yeschef/mail/question-id-1.json', '不是 JSON')
    await r.advance(SCAN_INTERVAL_MS)
    await r.advance(QUESTION_TIMEOUT_MS - SCAN_INTERVAL_MS)
    await expect(pending).rejects.toThrow(PEER_MSG.timedOut)
    expect(JSON.parse(r.files.get('/p/alpha/.yeschef/mail/cancel-id-1.json')!).text).toBe(PEER_MSG.timedOut)
  })

  it('注入時已過期,直接取消而不送出', async () => {
    const r = setup(QUESTION_TIMEOUT_MS * 2)
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    const pending = r.service.forConversation('A').askPeer('排隊中')
    await flush()
    await r.advance(QUESTION_TIMEOUT_MS)
    r.busy.set('B', false)
    r.service.notifyIdle('B')
    await expect(pending).rejects.toThrow(PEER_MSG.timedOut)
    expect(r.delivered).toHaveLength(0)
    expect(JSON.parse(r.files.get('/p/alpha/.yeschef/mail/cancel-id-1.json')!).text).toBe(PEER_MSG.timedOut)
  })

  it('注入時目標已不在 registry,以同伴已結束取消', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    const pending = r.service.forConversation('A').askPeer('排隊中')
    await flush()
    r.registry.unregister('B')
    r.service.notifyIdle('B')
    await expect(pending).rejects.toThrow(PEER_MSG.peerEnded)
    expect(r.delivered).toHaveLength(0)
    expect(JSON.parse(r.files.get('/p/alpha/.yeschef/mail/cancel-id-1.json')!).text).toBe(PEER_MSG.peerEnded)
  })

  it('答案檔壞掉:不等 10 分鐘,下一次掃描就取消', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('等你')
    await flush()
    r.files.set('/p/alpha/.yeschef/mail/answer-id-1.json', '不是 JSON')
    await r.advance(SCAN_INTERVAL_MS)
    await expect(pending).rejects.toThrow(PEER_MSG.answerCorrupt)
    expect([...r.files.keys()].some((k) => k.endsWith('cancel-id-1.json'))).toBe(true)
  })

  it('逾時從建立訊息時算,不從注入時算', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    const pending = r.service.forConversation('A').askPeer('排隊中')
    await flush()
    await r.advance(QUESTION_TIMEOUT_MS + SCAN_INTERVAL_MS)
    await expect(pending).rejects.toThrow(PEER_MSG.timedOut)
    expect(r.delivered).toHaveLength(0)
  })
})

describe('對話結束', () => {
  it('提問方結束:寫 cancel,原因是提問方已結束', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    r.service.conversationEnded('A')
    await expect(pending).rejects.toThrow(PEER_MSG.askerEnded)
  })

  it('回答方結束:立刻取消,不等 10 分鐘', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    r.service.conversationEnded('B')
    await expect(pending).rejects.toThrow(PEER_MSG.peerEnded)
  })
})

describe('重啟掃描', () => {
  it('未決全取消、已答已取消不動', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('第一題')
    await flush()
    await r.service.forConversation('B').answerPeer('id-1', '答完了')
    void r.service.forConversation('A').askPeer('第二題')
    await flush()

    await r.service.cancelPendingOnStartup([{ projectId: 'alpha', rootPath: '/p/alpha' }])
    const names = [...r.files.keys()].map((k) => k.split('/').pop())
    expect(names).toContain('answer-id-1.json')
    expect(names).toContain('cancel-id-3.json')
    expect(names).not.toContain('cancel-id-1.json')
    const cancel = JSON.parse([...r.files.entries()].find(([k]) => k.endsWith('cancel-id-3.json'))![1]) as { text: string }
    expect(cancel.text).toBe(PEER_MSG.restarted)
  })
})

describe('競態與掃描後盾', () => {
  it('尚未寫完就再次提問或反問,仍攔下重複與死鎖', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('第一題')
    await expect(r.service.forConversation('A').askPeer('第二題')).rejects.toThrow(PEER_MSG.alreadyAsking('id-1'))
    await expect(r.service.forConversation('B').askPeer('反問')).rejects.toThrow(PEER_MSG.deadlock('id-1'))
    await flush()
    await r.service.forConversation('B').answerPeer('id-1', '回答')
    expect(await pending).toBe('回答')
  })

  it('同時回答只能成功一次,不覆寫第一個答案', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    const B = r.service.forConversation('B')
    const results = await Promise.allSettled([B.answerPeer('id-1', '第一答'), B.answerPeer('id-1', '第二答')])
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: PEER_MSG.answerAlready('id-1') } })
    expect(await pending).toBe('第一答')
    expect(JSON.parse(r.files.get('/p/alpha/.yeschef/mail/answer-id-1.json')!).text).toBe('第一答')
  })

  it('寫檔前結束對話也會取消,不注入', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    r.service.conversationEnded('A')
    await expect(pending).rejects.toThrow(PEER_MSG.askerEnded)
    expect(r.delivered).toHaveLength(0)
    const cancel = JSON.parse(r.files.get('/p/alpha/.yeschef/mail/cancel-id-1.json')!)
    expect(cancel.from.linkId).toBe('aaaa1111')
  })

  it('第三輪掃描仍會讀取外部答案', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.advance(SCAN_INTERVAL_MS)
    await r.advance(SCAN_INTERVAL_MS)
    const question = JSON.parse(r.files.get('/p/alpha/.yeschef/mail/question-id-1.json')!)
    r.files.set('/p/alpha/.yeschef/mail/answer-id-1.json', JSON.stringify(newAnswer({
      id: 'external', question, text: '外部答案', actor: 'user', now: r.clock.now(),
    })))
    await r.advance(SCAN_INTERVAL_MS)
    expect(await pending).toBe('外部答案')
  })

  it('已落盤的答案不會被對話結束覆蓋', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    const question = JSON.parse(r.files.get('/p/alpha/.yeschef/mail/question-id-1.json')!)
    r.files.set('/p/alpha/.yeschef/mail/answer-id-1.json', JSON.stringify(newAnswer({
      id: 'external', question, text: '外部答案', actor: 'user', now: r.clock.now(),
    })))
    r.service.conversationEnded('B')
    expect(await pending).toBe('外部答案')
    expect(r.files.has('/p/alpha/.yeschef/mail/cancel-id-1.json')).toBe(false)
  })

  it('空 registry 仍能取消啟動專案裡的未決問題', async () => {
    const r = setup()
    r.files.set('/p/alpha/.yeschef/mail/question-old.json', JSON.stringify(newQuestion({
      id: 'old', from: { linkId: 'aaaa1111', provider: 'claude' },
      to: { linkId: 'bbbb2222', provider: 'claude' }, text: '舊問題', now: r.clock.now(),
    })))
    await r.service.cancelPendingOnStartup([{ projectId: 'alpha', rootPath: '/p/alpha' }])
    expect(JSON.parse(r.files.get('/p/alpha/.yeschef/mail/cancel-old.json')!).text).toBe(PEER_MSG.restarted)
  })

  it('專案信箱消失時先還原副本,三則未決問題都會取消', async () => {
    const r = setup()
    for (const id of ['old-1', 'old-2', 'old-3']) {
      r.files.set(`/data/mail/alpha/question-${id}.json`, JSON.stringify(newQuestion({
        id, from: { linkId: 'aaaa1111', provider: 'claude' },
        to: { linkId: 'bbbb2222', provider: 'claude' }, text: '舊問題', now: r.clock.now(),
      })))
    }
    await r.service.cancelPendingOnStartup([{ projectId: 'alpha', rootPath: '/p/alpha' }])
    for (const id of ['old-1', 'old-2', 'old-3']) {
      expect(r.files.has(`/p/alpha/.yeschef/mail/question-${id}.json`)).toBe(true)
      for (const dir of ['/p/alpha/.yeschef/mail', '/data/mail/alpha']) {
        expect(JSON.parse(r.files.get(`${dir}/cancel-${id}.json`)!).text).toBe(PEER_MSG.restarted)
      }
    }
    expect(r.errors).toEqual([])
  })

  it('dispose 收掉等待、拒絕後續呼叫且停止掃描', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    r.service.dispose()
    await expect(pending).rejects.toThrow(PEER_MSG.serviceStopped)
    await expect(r.service.forConversation('A').askPeer('再問')).rejects.toThrow(PEER_MSG.serviceStopped)
    await expect(r.service.forConversation('B').answerPeer('id-1', '答')).rejects.toThrow(PEER_MSG.serviceStopped)
    await r.advance(QUESTION_TIMEOUT_MS)
    expect(r.files.has('/p/alpha/.yeschef/mail/cancel-id-1.json')).toBe(false)
  })

  it('注入失敗會取消且記錄錯誤', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    const B = r.add('B', 'bbbb2222')
    r.registry.register({ ...B, deliver: () => { throw new Error('delivery failed') } })
    await expect(r.service.forConversation('A').askPeer('題目')).rejects.toThrow(PEER_MSG.peerEnded)
    expect(r.errors).toContain(PEER_MSG.deliveryFailed('id-1', 'delivery failed'))
  })
})

describe('未決問題的快照與通知', () => {
  it.each(['claude', 'codex'] as const)('pending 帶出 registry 的 targetProvider %s', async (targetProvider) => {
    const r = setup()
    r.add('A', 'aaaa1111')
    const target = r.add('B', 'bbbb2222')
    r.registry.register({ ...target, provider: targetProvider })
    void r.service.forConversation('A').askPeer('第一題')
    await flush()
    expect(r.service.pending()).toEqual([
      expect.objectContaining({
        questionId: 'id-1',
        projectId: 'alpha',
        askerConversationId: 'A',
        targetConversationId: 'B',
        askerLinkId: 'aaaa1111', targetProvider, targetLinkId: 'bbbb2222',
        text: '第一題',
        queued: false,
      }),
    ])
  })

  it('回答之後就不在 pending 裡', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.forConversation('B').answerPeer('id-1', '答案')
    await flush()
    expect(r.service.pending()).toEqual([])
  })

  it('排隊中的也列出來,queued 是 true', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    void r.service.forConversation('A').askPeer('排隊中')
    await flush()
    expect(r.service.pending()[0]?.queued).toBe(true)
  })

  it('onChange 在加入與收掉時各通知一次,取消訂閱後不再通知', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    let count = 0
    const off = r.service.onChange(() => { count += 1 })
    void r.service.forConversation('A').askPeer('題目')
    await flush()
    const afterAsk = count
    expect(afterAsk).toBeGreaterThan(0)
    await r.service.forConversation('B').answerPeer('id-1', '答案')
    await flush()
    expect(count).toBeGreaterThan(afterAsk)
    off()
    const afterOff = count
    void r.service.forConversation('A').askPeer('第二題')
    await flush()
    expect(count).toBe(afterOff)
  })
})

describe('人的介入', () => {
  it('代替回答:answer 的 from 是原問題的 to,actor 是 user,提問方拿到那段文字', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.answerAsUser('id-1', '我幫他答')
    expect(await pending).toBe('我幫他答')
    const answer = JSON.parse(
      [...r.files.entries()].find(([k]) => k.endsWith('answer-id-1.json'))![1]
    ) as { from: { linkId: string }; to: { linkId: string }; actor: string; text: string }
    expect(answer.from.linkId).toBe('bbbb2222')
    expect(answer.to.linkId).toBe('aaaa1111')
    expect(answer.actor).toBe('user')
    expect(answer.text).toBe('我幫他答')
  })

  it('取消:cancel 的原因是使用者取消,actor 是 user,ask_peer 立刻以那個原因結束', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.cancelAsUser('id-1')
    await expect(pending).rejects.toThrow(PEER_MSG.userCancelled)
    const cancel = JSON.parse(
      [...r.files.entries()].find(([k]) => k.endsWith('cancel-id-1.json'))![1]
    ) as { actor: string; text: string; from: { linkId: string } }
    expect(cancel.actor).toBe('user')
    expect(cancel.text).toBe(PEER_MSG.userCancelled)
    expect(cancel.from.linkId).toBe('bbbb2222')
  })

  it('找不到那則未決問題時丟錯,不寫檔', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    // 先問一題,信箱裡才有東西可以「沒有變多」;空信箱下這條斷言任何實作都會過。
    void r.service.forConversation('A').askPeer('題目')
    await flush()
    const before = r.files.size
    expect(before).toBeGreaterThan(0)
    await expect(r.service.answerAsUser('nope', 'x')).rejects.toThrow(PEER_MSG.pendingUnknown('nope'))
    await expect(r.service.cancelAsUser('nope')).rejects.toThrow(PEER_MSG.pendingUnknown('nope'))
    expect(r.files.size).toBe(before)
  })

  it('已經回答過的不能再代替回答', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    void r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.forConversation('B').answerPeer('id-1', '答案')
    await flush()
    await expect(r.service.answerAsUser('id-1', '太晚了')).rejects.toThrow(PEER_MSG.pendingUnknown('id-1'))
  })
})

describe('未決狀態與介入的邊界', () => {
  it('多則問題依建立時間排序', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.add('C', 'cccc3333')
    void r.service.forConversation('A').askPeer('第一題', 'bbbb2222')
    await flush()
    await r.advance(1)
    void r.service.forConversation('C').askPeer('第二題', 'bbbb2222')
    await flush()
    expect(r.service.pending().map((w) => [w.text, w.createdAt])).toEqual([
      ['第一題', 1_000_000], ['第二題', 1_000_001],
    ])
  })

  it('快照不共用物件,排隊解除會通知,取消中立即隱藏', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.busy.set('B', true)
    void r.service.forConversation('A').askPeer('排隊')
    await flush()
    const snapshot = r.service.pending()
    expect(snapshot[0]).not.toBe(r.service.pending()[0])
    const states: boolean[][] = []
    r.service.onChange(() => { states.push(r.service.pending().map((w) => w.queued)) })
    r.busy.set('B', false)
    r.service.notifyIdle('B')
    expect(states).toEqual([[false]])
    expect(snapshot[0]?.queued).toBe(true)
    const cancel = r.service.cancelAsUser('id-1')
    expect(r.service.pending()).toEqual([])
    await expect(r.service.answerAsUser('id-1', '晚了')).rejects.toThrow(PEER_MSG.pendingUnknown('id-1'))
    await cancel
    expect(states).toContainEqual([])
  })

  it('通知者拋錯不阻斷其他通知與提問', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    r.service.onChange(() => { throw new Error('listener failed') })
    let count = 0
    r.service.onChange(() => { count += 1 })
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    await r.service.answerAsUser('id-1', '答案')
    expect(await pending).toBe('答案')
    expect(count).toBeGreaterThan(1)
    expect(r.errors).toContain(PEER_MSG.changeNotificationFailed('listener failed'))
  })

  it('兩次人代答共用序列,只有一次寫入成功', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    const results = await Promise.allSettled([
      r.service.answerAsUser('id-1', '第一答'),
      r.service.answerAsUser('id-1', '第二答'),
    ])
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: PEER_MSG.pendingUnknown('id-1') } })
    expect(await pending).toBe('第一答')
    expect(JSON.parse(r.files.get('/p/alpha/.yeschef/mail/answer-id-1.json')!).text).toBe('第一答')
  })

  it('人代答寫檔失敗仍保留未決,可重試', async () => {
    const r = setup()
    r.add('A', 'aaaa1111')
    r.add('B', 'bbbb2222')
    const pending = r.service.forConversation('A').askPeer('題目')
    await flush()
    r.failingWrites.add('/p/alpha/.yeschef/mail/answer-id-1.json.tmp')
    await expect(r.service.answerAsUser('id-1', '失敗')).rejects.toThrow()
    expect(r.service.pending()).toHaveLength(1)
    r.failingWrites.clear()
    await r.service.answerAsUser('id-1', '重試')
    expect(await pending).toBe('重試')
  })
})
