import { describe, expect, it, vi } from 'vitest'
import { createGrokCatalog, GROK_CACHE_MS, toGrokSummary } from '../src/main/grok/catalog.js'
import type { GrokProcess, SpawnGrok } from '../src/main/grok/client.js'

const INITIALIZE_RESULT = {
  protocolVersion: 1,
  _meta: {
    modelState: {
      // grok 1.0.40 真的回的形狀(controller 探測原文):modelId 加 _meta.reasoningEfforts。
      availableModels: [
        {
          modelId: 'grok-4.7',
          name: 'Grok 4.7',
          description: 'Our most capable agentic coding model',
          _meta: {
            totalContextTokens: 500000,
            agentType: 'grok-build-plan',
            supportsReasoningEffort: true,
            reasoningEffort: 'high',
            reasoningEfforts: [
              { id: 'high', value: 'high', label: 'High', description: 'Balanced', default: true },
              { id: 'low', value: 'low', label: 'Low', description: 'Fastest', default: false },
            ],
          },
        },
        { modelId: 'grok-4-fast', name: 'Grok 4 Fast', _meta: { reasoningEfforts: [{ id: 'low', default: true }] } },
      ],
    },
  },
}

// updatedAt 是真的 grok 1.0.40 回的格式:ISO 字串(探測抓到的原文),不是數字。
// s-2 留一筆數字的,確認兩種格式都要接住。
const REAL_UPDATED_AT = '2026-09-22T12:22:08.706986+00:00'
const LIST_RESULT = {
  sessions: [
    { sessionId: 's-1', cwd: '/p/alpha', updatedAt: REAL_UPDATED_AT, _meta: { 'x.ai/session': { kind: 'agent', title: '修 mapper' } } },
    { sessionId: 's-2', cwd: '/p/alpha', updatedAt: 1_799_000_000_000, _meta: { 'x.ai/session': { kind: 'agent' } } },
  ],
}

interface Fake {
  readonly sent: Array<Record<string, unknown>>
  readonly killed: string[]
  reply(method: string, result: unknown): void
  fail(error: Error): void
}

function makeSpawn(): { spawn: SpawnGrok; all: Fake[]; last: () => Fake } {
  const all: Fake[] = []
  const spawn: SpawnGrok = () => {
    const sent: Array<Record<string, unknown>> = []
    const killed: string[] = []
    let onLine: (c: string) => void = () => {}
    let onError: (error: Error) => void = () => {}
    const proc: GrokProcess = {
      write: (line) => { sent.push(JSON.parse(line) as Record<string, unknown>) },
      closeStdin: () => { killed.push('closeStdin') },
      kill: () => { killed.push('kill') },
      onLine: (cb) => { onLine = cb },
      onStderr: () => {},
      onError: (cb) => { onError = cb },
      onExit: () => {},
    }
    all.push({
      sent, killed,
      reply: (method, result) => {
        const hit = [...sent].reverse().find((s) => s['method'] === method)
        if (hit === undefined) throw new Error(`還沒送出 ${method}`)
        onLine(`${JSON.stringify({ jsonrpc: '2.0', id: hit['id'], result })}\n`)
      },
      fail: (error) => { onError(error) },
    })
    return proc
  }
  return { spawn, all, last: () => { const f = all.at(-1); if (f === undefined) throw new Error('還沒 spawn'); return f } }
}

function setup() {
  const s = makeSpawn()
  const logError = vi.fn()
  let clock = 1_000_000
  const catalog = createGrokCatalog({ spawn: s.spawn, logError, now: () => clock, homeDir: '/home/me' })
  const serve = async (): Promise<void> => {
    await vi.waitFor(() => { if (s.last().sent.every((e) => e['method'] !== 'initialize')) throw new Error('還沒 initialize') })
    s.last().reply('initialize', INITIALIZE_RESULT)
    await vi.waitFor(() => { if (s.last().sent.every((e) => e['method'] !== 'session/list')) throw new Error('還沒 session/list') })
    s.last().reply('session/list', LIST_RESULT)
  }
  return { ...s, logError, catalog, serve, advance: (ms: number) => { clock += ms } }
}

describe('一個連線兩件事', () => {
  it('models 與 list 只開一個子行程,結束後收掉', async () => {
    const r = setup()
    const models = r.catalog.models()
    const listed = r.catalog.list('/p/alpha')
    await r.serve()
    expect(await models).toEqual([
      { id: 'grok-4.7', name: 'Grok 4.7', reasoningEfforts: ['high', 'low'] },
      { id: 'grok-4-fast', name: 'Grok 4 Fast', reasoningEfforts: ['low'] },
    ])
    expect(await listed).toEqual([
      { sessionId: 's-1', summary: '修 mapper', lastModified: Date.parse(REAL_UPDATED_AT), cwd: '/p/alpha' },
      { sessionId: 's-2', summary: 's-2', lastModified: 1_799_000_000_000, cwd: '/p/alpha' },
    ])
    expect(r.all).toHaveLength(1)
    expect(r.last().sent.find((e) => e['method'] === 'session/list')?.['params']).toEqual({ cwd: '/p/alpha' })
    expect(r.last().killed).toContain('kill')
  })

  it('沒給 cwd 時用 homeDir', async () => {
    const r = setup()
    const listed = r.catalog.list()
    await r.serve()
    await listed
    expect(r.last().sent.find((e) => e['method'] === 'session/list')?.['params']).toEqual({ cwd: '/home/me' })
  })
})

describe('快取', () => {
  it('30 秒內不再開子行程', async () => {
    const r = setup()
    const first = r.catalog.list('/p/alpha')
    await r.serve()
    await first
    r.advance(GROK_CACHE_MS - 1)
    await expect(r.catalog.list('/p/alpha')).resolves.toHaveLength(2)
    await expect(r.catalog.models()).resolves.toHaveLength(2)
    expect(r.all).toHaveLength(1)
  })

  it('超過 30 秒重查', async () => {
    const r = setup()
    const first = r.catalog.list('/p/alpha')
    await r.serve()
    await first
    r.advance(GROK_CACHE_MS + 1)
    const again = r.catalog.list('/p/alpha')
    await r.serve()
    await again
    expect(r.all).toHaveLength(2)
  })

  it('不同的 cwd 各自查', async () => {
    const r = setup()
    const first = r.catalog.list('/p/alpha')
    await r.serve()
    await first
    const second = r.catalog.list('/p/beta')
    await r.serve()
    await second
    expect(r.all).toHaveLength(2)
  })
})

describe('沒裝 grok', () => {
  it('回空清單,不丟錯,記一次 log', async () => {
    const r = setup()
    const models = r.catalog.models()
    const listed = r.catalog.list('/p/alpha')
    await vi.waitFor(() => { if (r.all.length === 0) throw new Error('還沒 spawn') })
    r.last().fail(Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' }))
    await expect(models).resolves.toEqual([])
    await expect(listed).resolves.toEqual([])
    expect(r.logError).toHaveBeenCalled()
  })
})

describe('toGrokSummary', () => {
  it('沒有 title 時用 sessionId 的前 8 碼', () => {
    expect(toGrokSummary({ sessionId: 'abcdefghijkl', cwd: '/p', updatedAt: 1_800_000_000_000 })).toEqual({
      sessionId: 'abcdefghijkl', summary: 'abcdefgh', lastModified: 1_800_000_000_000, cwd: '/p',
    })
  })

  it('秒為單位的 updatedAt 補成毫秒', () => {
    expect(toGrokSummary({ sessionId: 's', cwd: '/p', updatedAt: 1_800_000_000 })?.lastModified).toBe(1_800_000_000_000)
  })

  it('updatedAt 是 ISO 字串時用 Date.parse(grok 1.0.40 的真實形狀)', () => {
    expect(toGrokSummary({ sessionId: 's', cwd: '/p', updatedAt: REAL_UPDATED_AT })?.lastModified).toBe(Date.parse(REAL_UPDATED_AT))
  })

  it('updatedAt 解不出日期就回 undefined', () => {
    expect(toGrokSummary({ sessionId: 's', cwd: '/p', updatedAt: '不是日期' })).toBeUndefined()
  })

  it('缺欄位回 undefined', () => {
    expect(toGrokSummary({ cwd: '/p', updatedAt: 1 })).toBeUndefined()
    expect(toGrokSummary('壞掉的東西')).toBeUndefined()
  })
})
