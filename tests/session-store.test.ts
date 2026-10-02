import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSessionStore, type SdkSessionInfo } from '../src/main/session-store.js'
import { fold } from '../src/shared/fold.js'
import type { Event } from '../src/shared/events.js'

const HISTORY: readonly unknown[] = readFileSync(
  'tests/fixtures/events/04-session-history.jsonl',
  'utf8'
)
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as unknown)

const info = (over: Partial<SdkSessionInfo> & { sessionId: string }): SdkSessionInfo => ({
  summary: '摘要',
  lastModified: 1,
  ...over,
})

function storeOf(infos: readonly SdkSessionInfo[], messages: readonly unknown[] = HISTORY) {
  const calls: { limit?: number }[] = []
  const store = createSessionStore({
    listSessions: async (options) => {
      calls.push({ ...(options?.limit === undefined ? {} : { limit: options.limit }) })
      return infos
    },
    getSessionMessages: async () => messages,
  })
  return { store, calls }
}

describe('SessionStore.list：SDK 型別轉成 SessionSummary（裁決 7）', () => {
  it('只留下契約的六個欄位，SDK 專屬欄位不外洩', async () => {
    const { store } = storeOf([
      info({
        sessionId: 'a-1',
        summary: '摘要',
        lastModified: 1000,
        cwd: '/p',
        customTitle: '自訂',
        gitBranch: 'main',
        firstPrompt: '不該出現',
      }),
    ])
    const [first] = await store.list()
    expect(first).toEqual({
      sessionId: 'a-1',
      summary: '摘要',
      lastModified: 1000,
      cwd: '/p',
      customTitle: '自訂',
      gitBranch: 'main',
    })
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'customTitle',
      'cwd',
      'gitBranch',
      'lastModified',
      'sessionId',
      'summary',
    ])
  })

  it('沒有的選填欄位不會變成 undefined 屬性', async () => {
    const { store } = storeOf([info({ sessionId: 'a-2' })])
    const [first] = await store.list()
    expect(Object.keys(first ?? {}).sort()).toEqual(['lastModified', 'sessionId', 'summary'])
  })
})

describe('SessionStore.list：標題退回鏈', () => {
  it('summary 是空字串時退回 firstPrompt 的前 80 字', async () => {
    const long = 'x'.repeat(200)
    const { store } = storeOf([info({ sessionId: 'b-1', summary: '', firstPrompt: long })])
    const [first] = await store.list()
    expect(first?.summary).toHaveLength(80)
    expect(first?.summary).toBe('x'.repeat(80))
  })

  it('summary 只有空白也算空', async () => {
    const { store } = storeOf([info({ sessionId: 'b-2', summary: '   ', firstPrompt: '第一句' })])
    const [first] = await store.list()
    expect(first?.summary).toBe('第一句')
  })

  it('summary 與 firstPrompt 都空時退回 sessionId 前 8 碼', async () => {
    const { store } = storeOf([
      info({ sessionId: '0123456789abcdef', summary: '', firstPrompt: '' }),
    ])
    const [first] = await store.list()
    expect(first?.summary).toBe('01234567')
  })

  it('summary 有內容時不動它，也不被 firstPrompt 蓋掉', async () => {
    const { store } = storeOf([info({ sessionId: 'b-4', summary: '真摘要', firstPrompt: '第一句' })])
    const [first] = await store.list()
    expect(first?.summary).toBe('真摘要')
  })
})

describe('SessionStore.list：排序與不可變性', () => {
  // 輸入刻意亂序，且四筆的正確順序跟輸入順序沒有任何一位重合，
  // 拿掉排序時整條斷言都會不同，不會因為第一筆剛好對而漏抓。
  const shuffled: readonly SdkSessionInfo[] = [
    info({ sessionId: 'c-mid', lastModified: 200 }),
    info({ sessionId: 'c-old', lastModified: 100 }),
    info({ sessionId: 'c-new', lastModified: 400 }),
    info({ sessionId: 'c-late', lastModified: 300 }),
  ]

  it('依 lastModified 新到舊排序', async () => {
    const { store } = storeOf(shuffled)
    const list = await store.list()
    expect(list.map((s) => s.sessionId)).toEqual(['c-new', 'c-late', 'c-mid', 'c-old'])
  })

  it('不修改 SDK 回傳的陣列', async () => {
    const input = [...shuffled]
    const store = createSessionStore({
      listSessions: async () => input,
      getSessionMessages: async () => HISTORY,
    })
    await store.list()
    expect(input.map((s) => s.sessionId)).toEqual(['c-mid', 'c-old', 'c-new', 'c-late'])
  })

  it('帶 limit 呼叫 SDK，不無上限抓全機器的 session', async () => {
    const { store, calls } = storeOf(shuffled)
    await store.list()
    expect(calls).toEqual([{ limit: 100 }])
  })
})

describe('SessionStore.cwdOf：跨專案 resume 的 cwd（裁決 20）', () => {
  // 兩筆的 cwd 刻意不同，且問的是第二筆：退化成「永遠回第一筆的 cwd」的實作
  // 會在這裡變紅，不會因為只有一筆而巧合通過。
  const twoProjects: readonly SdkSessionInfo[] = [
    info({ sessionId: 'd-1', cwd: '/Users/x/Projects/alpha' }),
    info({ sessionId: 'd-2', cwd: '/Users/x/Projects/beta' }),
  ]

  it('list() 之後回得出該筆自己的 cwd', async () => {
    const { store } = storeOf(twoProjects)
    await store.list()
    expect(store.cwdOf('d-2')).toBe('/Users/x/Projects/beta')
    expect(store.cwdOf('d-1')).toBe('/Users/x/Projects/alpha')
  })

  it('該筆沒有 cwd 時回 undefined，不是空字串', async () => {
    const { store } = storeOf([info({ sessionId: 'd-3' })])
    await store.list()
    expect(store.cwdOf('d-3')).toBeUndefined()
  })

  it('還沒 list() 過就問，回 undefined', () => {
    const { store } = storeOf(twoProjects)
    expect(store.cwdOf('d-1')).toBeUndefined()
  })
})

describe('SessionStore.list：錯誤不得靜默變成空清單', () => {
  it('listSessions 拋錯時 list() reject，並保留原因', async () => {
    const cause = new Error('EACCES ~/.claude/projects')
    const store = createSessionStore({
      listSessions: async () => {
        throw cause
      },
      getSessionMessages: async () => HISTORY,
    })
    await expect(store.list()).rejects.toThrow('讀取歷史對話清單失敗')
    await expect(store.list()).rejects.toHaveProperty('cause', cause)
  })
})

describe('SessionStore.loadHistory', () => {
  it('逐則 normalizeHistory 展開，尾端補一筆 session-end（裁決 15）', async () => {
    const { store } = storeOf([])
    const events = await store.loadHistory('s-1')
    expect(events.length).toBeGreaterThan(HISTORY.length)
    expect(events.at(-1)).toEqual({ kind: 'session-end', isError: false })
    expect(events.filter((e) => e.kind === 'session-end')).toHaveLength(1)
  })

  it('產出不含 tool-raw-output：歷史對話沒有保存原始輸出（裁決 4）', async () => {
    const { store } = storeOf([])
    const events = await store.loadHistory('s-1')
    expect(events.some((e) => e.kind === 'tool-use')).toBe(true)
    expect(events.some((e) => e.kind === 'tool-raw-output')).toBe(false)
  })

  it('餵進 fold 之後每一個 block 都是完成狀態，尾端不會畫游標', async () => {
    const { store } = storeOf([])
    const view = fold(await store.loadHistory('s-1'))
    const blocks = view.turns.flatMap((t) => t.blocks)
    expect(blocks.length).toBeGreaterThan(0)
    const incomplete = blocks
      .filter((b) => b.kind === 'text' || b.kind === 'thinking')
      .filter((b) => !b.complete)
    expect(incomplete).toEqual([])
    expect(blocks.filter((b) => b.kind === 'tool' && b.status === 'running')).toEqual([])
    expect(view.ended).toBe(true)
  })

  it('認不出來的歷史訊息產出 unknown，不丟棄', async () => {
    const { store } = storeOf([], [{ type: '未知型別', uuid: 'u-1' }])
    const events = await store.loadHistory('s-1')
    expect(events.map((e) => e.kind)).toEqual(['unknown', 'session-end'])
  })

  it('空的歷史也照樣補 session-end', async () => {
    const { store } = storeOf([], [])
    const events: readonly Event[] = await store.loadHistory('s-1')
    expect(events).toEqual([{ kind: 'session-end', isError: false }])
  })

  it('getSessionMessages 拋錯時 loadHistory reject，帶著 sessionId', async () => {
    const store = createSessionStore({
      listSessions: async () => [],
      getSessionMessages: async () => {
        throw new Error('ENOENT')
      },
    })
    await expect(store.loadHistory('s-404')).rejects.toThrow('s-404')
  })
})

describe('SessionStore.list(cwd)：本專案清單不被全域上限先砍掉', () => {
  // SDK 原生支援 dir 過濾(sdk.d.ts 的 ListSessionsOptions),而且會一併涵蓋
  // 該目錄的 git worktree。先取全域最新 100 筆再過濾的作法會漏掉排在 100 名
  // 之後的本專案 session,實測 962 場 session 時抓全部要 1188 ms,dir 過濾 32 ms。
  const MINE = '/Users/x/Projects/mine'

  function dirStoreOf(infos: readonly SdkSessionInfo[]) {
    const calls: { dir?: string; limit?: number }[] = []
    const store = createSessionStore({
      listSessions: async (options) => {
        calls.push({ ...options })
        // 假替身照 SDK 的契約做:有 dir 就先過濾,limit 才套在過濾之後。
        const scoped = options?.dir === undefined ? infos : infos.filter((s) => s.cwd === options.dir)
        return options?.limit === undefined ? scoped : scoped.slice(0, options.limit)
      },
      getSessionMessages: async () => HISTORY,
    })
    return { store, calls }
  }

  // 全域最新的 120 筆全是別的專案,本專案那筆排在後面。
  const many: readonly SdkSessionInfo[] = [
    ...Array.from({ length: 120 }, (_unused, i) =>
      info({ sessionId: `other-${i}`, lastModified: 10_000 - i, cwd: '/Users/x/Projects/other' })
    ),
    info({ sessionId: 'mine-1', lastModified: 5, cwd: MINE }),
  ]

  it('把 cwd 當 dir 交給 SDK 過濾,limit 照帶', async () => {
    const { store, calls } = dirStoreOf(many)
    await store.list(MINE)
    expect(calls).toEqual([{ dir: MINE, limit: 100 }])
  })

  it('本專案的舊 session 排在全域第 101 名之後,仍然列得出來', async () => {
    const { store } = dirStoreOf(many)
    expect((await store.list(MINE)).map((s) => s.sessionId)).toEqual(['mine-1'])
  })

  it('不帶 cwd 時維持原本行為:只給 limit,不給 dir', async () => {
    const { store, calls } = dirStoreOf(many)
    await store.list()
    expect(calls).toEqual([{ limit: 100 }])
  })

  it('cwdOf 涵蓋這次取回的清單', async () => {
    const { store } = dirStoreOf(many)
    await store.list(MINE)
    expect(store.cwdOf('mine-1')).toBe(MINE)
  })
})


describe('歷史花費', () => {
  it.each([
    [{ usd: 0.12, turns: 3, tokens: 123 }, { costUsd: 0.12, numTurns: 3, tokens: 123 }],
    [{ usd: 0, turns: 0 }, { costUsd: 0, numTurns: 0 }],
    [{ tokens: 0 }, { tokens: 0 }],
    [undefined, {}],
  ])('只補存在的欄位 %j', async (cost, expected) => {
    const { store } = storeOf([])
    const events = await store.loadHistory('s-1', (id) => {
      expect(id).toBe('s-1')
      return cost
    })
    expect(events.at(-1)).toEqual({ kind: 'session-end', isError: false, ...expected })
  })
})
