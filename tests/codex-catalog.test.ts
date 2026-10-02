import { homedir } from 'node:os'
import { MSG_NO_CODEX, MSG_NOT_LOGGED_IN } from '../src/main/codex/conversation.js'
import { afterEach, describe, it, expect, vi } from 'vitest'
import type { CodexProcess, SpawnCodex } from '../src/main/codex/client.js'
import { createCodexCatalog, ITEMS_MAX_PAGES, toSummary } from '../src/main/codex/catalog.js'

interface Fake {
  readonly sent: Array<Record<string, unknown>>
  readonly killed: string[]
  say(obj: unknown): void
  /** 依 method 自動回覆最近一筆同名請求。 */
  reply(method: string, result: unknown): void
  fail(error: Error): void
  exit(code: number | null): void
  stderr(text: string): void
}

function makeSpawn(): { spawn: SpawnCodex; fake: () => Fake; cwds: string[] } {
  const cwds: string[] = []
  let current: Fake | null = null
  const spawn: SpawnCodex = (cwd) => {
    cwds.push(cwd)
    const sent: Array<Record<string, unknown>> = []
    const killed: string[] = []
    let onLine: (c: string) => void = () => {}
    let onStderr: (c: string) => void = () => {}
    let onError: (error: Error) => void = () => {}
    let onExit: (code: number | null) => void = () => {}
    const proc: CodexProcess = {
      write: (line) => { sent.push(JSON.parse(line) as Record<string, unknown>) },
      closeStdin: () => { killed.push('closeStdin') },
      kill: () => { killed.push('kill') },
      onLine: (cb) => { onLine = cb },
      onStderr: (cb) => { onStderr = cb },
      onError: (cb) => { onError = cb },
      onExit: (cb) => { onExit = cb },
    }
    current = {
      sent,
      killed,
      say: (obj) => { onLine(`${JSON.stringify(obj)}\n`) },
      reply: (method, result) => {
        const hit = [...sent].reverse().find((s) => s['method'] === method)
        if (hit === undefined) throw new Error(`還沒送出 ${method}`)
        onLine(`${JSON.stringify({ jsonrpc: '2.0', id: hit['id'], result })}\n`)
      },
      fail: (error) => { onError(error) },
      exit: (code) => { onExit(code) },
      stderr: (text) => { onStderr(text) },
    }
    return proc
  }
  return { spawn, fake: () => { if (current === null) throw new Error('還沒 spawn'); return current }, cwds }
}

const thread = { id: 'thread-123456', preview: ' 完整摘要 ', updatedAt: 1_800_000_000_000, cwd: '/p', name: '標題', gitInfo: { branch: 'main' } }
function setup(timeoutMs?: number) {
  const s = makeSpawn()
  const logError = vi.fn()
  const catalog = createCodexCatalog({ spawn: s.spawn, logError, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  return { ...s, logError, catalog }
}
async function initialize(s: ReturnType<typeof setup>) {
  s.fake().reply('initialize', {})
  await Promise.resolve()
}
afterEach(() => { vi.useRealTimers() })
describe('codex catalog', () => {
  it('握手、固定參數與三筆映射,完成後 kill', async () => {
    const s = setup()
    const pending = s.catalog.list('/p')
    expect(s.cwds).toEqual(['/p'])
    expect(s.fake().sent[0]).toMatchObject({ method: 'initialize', params: {
      clientInfo: { name: 'yeschef', title: 'YesChef', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    } })
    await initialize(s)
    expect(s.fake().sent[1]).toEqual({ jsonrpc: '2.0', method: 'initialized' })
    expect(s.fake().sent[2]?.['params']).toEqual({ cwd: ['/p'], sortKey: 'updated_at', sortDirection: 'desc', limit: 50, archived: false })
    s.fake().reply('thread/list', { data: [
      thread, { ...thread, id: 'two', name: null, preview: ' 第一行  \n第二行', gitInfo: null },
      { ...thread, id: 'three', updatedAt: 123 }, null,
    ] })
    await expect(pending).resolves.toEqual([
      { sessionId: thread.id, summary: '完整摘要', lastModified: thread.updatedAt, cwd: '/p', customTitle: '標題', gitBranch: 'main' },
      { sessionId: 'two', summary: '第一行', lastModified: thread.updatedAt, cwd: '/p' },
      { sessionId: 'three', summary: '完整摘要', lastModified: 123000, cwd: '/p', customTitle: '標題', gitBranch: 'main' },
    ])
    expect(s.fake().killed).toEqual(['kill'])
  })
  it('全部專案省略 cwd', async () => {
    const s = setup()
    const pending = s.catalog.list()
    await initialize(s)
    expect(s.cwds).toEqual([homedir()])
    expect(s.fake().sent[2]?.['params']).toEqual({ sortKey: 'updated_at', sortDirection: 'desc', limit: 50, archived: false })
    s.fake().reply('thread/list', { data: [] })
    await expect(pending).resolves.toEqual([])
    expect(s.fake().killed).toEqual(['kill'])
  })
  it.each(['initialize', 'thread/list'])('%s 錯誤時 reject、log、kill', async (method) => {
    const s = setup()
    const pending = s.catalog.list('/p')
    if (method === 'thread/list') await initialize(s)
    const request = s.fake().sent.find((entry) => entry['method'] === method)
    s.fake().say({ id: request?.['id'], error: { code: -1, message: '失敗' } })
    await expect(pending).rejects.toThrow('失敗')
    expect(s.logError).toHaveBeenCalled()
    expect(s.fake().killed).toEqual(['kill'])
  })
  it.each(['initialize', 'thread/list'])('%s 預設 15 秒逾時', async (method) => {
    vi.useFakeTimers()
    const s = setup()
    const pending = s.catalog.list()
    if (method === 'thread/list') await initialize(s)
    const rejection = expect(pending).rejects.toThrow('15000')
    await vi.advanceTimersByTimeAsync(14999)
    expect(s.fake().killed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(s.fake().killed).toEqual(['kill'])
  })
  it('可覆寫逾時', async () => {
    const s = setup(1)
    await expect(s.catalog.list()).rejects.toThrow('1 毫秒')
    expect(s.fake().killed).toEqual(['kill'])
  })
  it.each(['error', 'exit', 'null-exit'])('子程序 %s 立即 reject 並 kill', async (kind) => {
    const s = setup()
    const pending = s.catalog.list()
    if (kind === 'error') s.fake().fail(new Error('EPIPE'))
    else s.fake().exit(kind === 'exit' ? 1 : null)
    await expect(pending).rejects.toThrow()
    expect(s.fake().killed).toEqual(['kill'])
    expect(s.logError).toHaveBeenCalled()
  })
  it.each([null, {}, { data: null }])('無效回應 reject', async (result) => {
    const s = setup()
    const pending = s.catalog.list()
    await initialize(s)
    s.fake().reply('thread/list', result)
    await expect(pending).rejects.toThrow()
    expect(s.fake().killed).toEqual(['kill'])
  })
  it('spawn 丟出非 Error 也記錄與 reject', async () => {
    const logError = vi.fn()
    const catalog = createCodexCatalog({ spawn: () => { throw 'spawn failed' }, logError })
    await expect(catalog.list()).rejects.toThrow('spawn failed')
    expect(logError).toHaveBeenCalledWith(expect.any(Error))
  })
})
describe('toSummary', () => {
  it('首行去空白、80 字截斷與空摘要 fallback', () => {
    expect(toSummary({ ...thread, preview: 'x'.repeat(81), name: '' })?.summary).toBe('x'.repeat(80) + '…')
    expect(toSummary({ ...thread, preview: 'x'.repeat(80) })?.summary).toBe('x'.repeat(80))
    expect(toSummary({ ...thread, preview: '  \n後文', name: '', gitInfo: { branch: null } })).toEqual({
      sessionId: thread.id, summary: 'thread-1', lastModified: thread.updatedAt, cwd: '/p',
    })
    expect(toSummary({ ...thread, updatedAt: 1e12 })?.lastModified).toBe(1e12)
  })
  it.each([null, [], {}, { ...thread, id: '' }, { ...thread, preview: null }, { ...thread, updatedAt: NaN },
    { ...thread, updatedAt: '123' }, { ...thread, cwd: null }, { ...thread, name: 1 },
    { ...thread, gitInfo: [] }, { ...thread, gitInfo: { branch: 1 } }])('略過不符形狀的 thread', (raw) => {
    expect(toSummary(raw)).toBeUndefined()
  })
  it('可省略選填欄位', () => {
    expect(toSummary({ id: 'id', preview: '', updatedAt: 0, cwd: '/p' })).toEqual({
      sessionId: 'id', summary: 'id', lastModified: 0, cwd: '/p',
    })
  })
})

it('items 解開 ThreadItemEntry 並依 nextCursor 翻到底', async () => {
  const s = setup()
  const pending = s.catalog.items('/p', 't1')
  await initialize(s)
  expect(s.fake().sent[2]?.['params']).toEqual({ threadId: 't1', limit: 200 })
  const item = { type: 'agentMessage', id: 'a', text: 'hello' }
  s.fake().reply('thread/items/list', { data: [{ item, turnId: 'turn1' }], nextCursor: 'next' })
  await Promise.resolve()
  expect(s.fake().sent.at(-1)?.['params']).toEqual({ threadId: 't1', limit: 200, cursor: 'next' })
  s.fake().reply('thread/items/list', { data: [{ item: { ...item, id: 'b' }, turnId: 'turn2' }], nextCursor: null })
  await expect(pending).resolves.toEqual([item, { ...item, id: 'b' }])
  expect(s.fake().killed).toEqual(['kill'])
})

function rejectLegacyItems(s: ReturnType<typeof setup>, message = 'unknown variant `thread/items/list`') {
  const request = s.fake().sent.at(-1)!
  s.fake().say({ jsonrpc: '2.0', id: request['id'], error: { code: -32600, message } })
}

it('新版 CLI 不支援舊 items/list 時讀完整 turn 分頁,按時間順序恢復對話', async () => {
  const s = setup()
  const pending = s.catalog.items('/p', 'new-cli')
  await initialize(s)
  rejectLegacyItems(s)
  await vi.waitFor(() => expect(s.fake().sent.at(-1)?.['method']).toBe('thread/turns/list'))
  expect(s.fake().sent.at(-1)?.['params']).toEqual({ threadId: 'new-cli', limit: 50, sortDirection: 'asc', itemsView: 'full' })
  const user = { type: 'userMessage', id: 'u', content: [] }
  const answer = { type: 'agentMessage', id: 'a', text: 'answer' }
  s.fake().reply('thread/turns/list', { data: [{ items: [user, answer], itemsView: 'full' }], nextCursor: 'older' })
  await vi.waitFor(() => expect(s.fake().sent.at(-1)?.['params']).toHaveProperty('cursor', 'older'))
  s.fake().reply('thread/turns/list', { data: [{ items: [{ ...answer, id: 'b' }] }], nextCursor: null })
  await expect(pending).resolves.toEqual([user, answer, { ...answer, id: 'b' }])
  expect(s.fake().killed).toEqual(['kill'])
})

it('認證錯誤不可切換介面掩蓋', async () => {
  const s = setup()
  const pending = s.catalog.items('/p', 'auth')
  await initialize(s)
  const rejected = expect(pending).rejects.toThrow()
  rejectLegacyItems(s, 'not logged in')
  await rejected
  expect(s.fake().sent.some((r) => r['method'] === 'thread/turns/list')).toBe(false)
})

it.each(['summary', 'notLoaded'])('新版回傳 %s 不可當作完整歷史', async (itemsView) => {
  const s = setup()
  const pending = s.catalog.items('/p', 'bad-view')
  await initialize(s)
  rejectLegacyItems(s)
  await vi.waitFor(() => expect(s.fake().sent.at(-1)?.['method']).toBe('thread/turns/list'))
  const rejected = expect(pending).rejects.toThrow('完整 items')
  s.fake().reply('thread/turns/list', { data: [{ items: [], itemsView }], nextCursor: null })
  await rejected
})

it('新版 turn 分頁遇到重複 cursor 時停止並回報', async () => {
  const s = setup()
  const pending = s.catalog.items('/p', 'repeat')
  await initialize(s)
  rejectLegacyItems(s)
  await vi.waitFor(() => expect(s.fake().sent.at(-1)?.['method']).toBe('thread/turns/list'))
  s.fake().reply('thread/turns/list', { data: [{ items: [] }], nextCursor: 'same' })
  await vi.waitFor(() => expect(s.fake().sent.at(-1)?.['params']).toHaveProperty('cursor', 'same'))
  const rejected = expect(pending).rejects.toThrow('重複')
  s.fake().reply('thread/turns/list', { data: [], nextCursor: 'same' })
  await rejected
  expect(s.fake().killed).toEqual(['kill'])
})

it('單一完整 turn 也遵守 4000 筆歷史上限', async () => {
  const s = setup()
  const pending = s.catalog.items('/p', 'large')
  await initialize(s)
  rejectLegacyItems(s)
  await vi.waitFor(() => expect(s.fake().sent.at(-1)?.['method']).toBe('thread/turns/list'))
  const items = Array.from({ length: 4001 }, (_, i) => ({ id: String(i), type: 'agentMessage', text: String(i) }))
  s.fake().reply('thread/turns/list', { data: [{ items }], nextCursor: null })
  await expect(pending).resolves.toEqual(items.slice(0, 4000))
  expect(s.logError).toHaveBeenCalledWith(new Error('thread large 超過 4000 筆,只載入前 4000 筆'))
})

it.each(['next', null, undefined])('items 第 20 頁 cursor 為 %s 時停止並保留全部已載入資料', async (lastCursor) => {
  const s = setup()
  const pending = s.catalog.items('/p', 't-limit')
  await initialize(s)
  expect(ITEMS_MAX_PAGES).toBe(20)
  const entries = Array.from({ length: 4000 }, (_, index) => ({
    turnId: `turn-${index}`,
    item: { type: 'agentMessage', id: `item-${index}`, text: `訊息 ${index}` },
  }))
  for (let page = 0; page < 20; page += 1) {
    expect(s.fake().sent.at(-1)?.['params']).toEqual({
      threadId: 't-limit', limit: 200,
      ...(page === 0 ? {} : { cursor: `cursor-${page}` }),
    })
    s.fake().reply('thread/items/list', {
      data: entries.slice(page * 200, (page + 1) * 200),
      nextCursor: page === 19 ? lastCursor : `cursor-${page + 1}`,
    })
    await Promise.resolve()
  }
  await expect(pending).resolves.toEqual(entries.map((entry) => entry.item))
  expect(s.fake().sent.filter((request) => request['method'] === 'thread/items/list')).toHaveLength(20)
  expect(s.fake().sent.filter((request) => request['id'] !== undefined)).toHaveLength(21)
  expect(s.fake().killed).toEqual(['kill'])
  if (lastCursor === 'next') {
    expect(s.logError).toHaveBeenCalledExactlyOnceWith(new Error('thread t-limit 超過 20 頁,只載入前 4000 筆'))
  } else {
    expect(s.logError).not.toHaveBeenCalled()
  }
})

it.each([null, {}, { data: [], nextCursor: 2 }])('items 無效回應會 reject 並 kill', async (result) => {
  const s = setup()
  const pending = s.catalog.items('/p', 't1')
  await initialize(s)
  s.fake().reply('thread/items/list', result)
  await expect(pending).rejects.toThrow()
  expect(s.fake().killed).toEqual(['kill'])
})
it('items 分頁逾時會 reject 並 kill', async () => {
  vi.useFakeTimers()
  const s = setup()
  const pending = s.catalog.items('/p', 't1')
  await initialize(s)
  s.fake().reply('thread/items/list', { data: [], nextCursor: 'next' })
  await Promise.resolve()
  const rejection = expect(pending).rejects.toThrow('15000')
  await vi.advanceTimersByTimeAsync(15000)
  await rejection
  expect(s.fake().killed).toEqual(['kill'])
})
it('items 拒絕重複 cursor,避免無限翻頁', async () => {
  const s = setup()
  const pending = s.catalog.items('/p', 't1')
  await initialize(s)
  s.fake().reply('thread/items/list', { data: [], nextCursor: 'next' })
  await Promise.resolve()
  s.fake().reply('thread/items/list', { data: [], nextCursor: 'next' })
  await expect(pending).rejects.toThrow('重複')
  expect(s.fake().killed).toEqual(['kill'])
})

it.each(['/p', undefined])('同 cwd %s 共用進行中的 promise,完成後重新查詢', async (cwd) => {
  const s = setup()
  const first = s.catalog.list(cwd)
  expect(s.catalog.list(cwd)).toBe(first)
  expect(s.cwds).toHaveLength(1)
  await initialize(s)
  expect(s.catalog.list(cwd)).toBe(first)
  s.fake().reply('thread/list', { data: [thread] })
  await expect(first).resolves.toHaveLength(1)
  const third = s.catalog.list(cwd)
  expect(third).not.toBe(first)
  expect(s.cwds).toHaveLength(2)
  await initialize(s)
  s.fake().reply('thread/list', { data: [] })
  await expect(third).resolves.toEqual([])
})

it('失敗後清除共用請求,可重新查詢', async () => {
  const s = setup()
  const first = s.catalog.list('/p')
  expect(s.catalog.list('/p')).toBe(first)
  s.fake().fail(new Error('失敗'))
  await expect(first).rejects.toThrow('失敗')
  const retry = s.catalog.list('/p')
  expect(s.cwds).toHaveLength(2)
  await initialize(s)
  s.fake().reply('thread/list', { data: [] })
  await expect(retry).resolves.toEqual([])
})

it('不同 cwd 各自查詢,一邊完成不會清掉另一邊', async () => {
  const s = setup()
  const first = s.catalog.list('/p')
  const firstProcess = s.fake()
  const second = s.catalog.list('/q')
  expect(second).not.toBe(first)
  expect(s.cwds).toEqual(['/p', '/q'])
  firstProcess.reply('initialize', {})
  await initialize(s)
  firstProcess.reply('thread/list', { data: [] })
  await first
  expect(s.catalog.list('/q')).toBe(second)
  s.fake().reply('thread/list', { data: [] })
  await second
})


it.each([null, {}, { item: null }, { item: [] }])('items 略過損壞 entry %s 並只記一次錯誤', async (broken) => {
  const s = setup()
  const pending = s.catalog.items('/p', 't1')
  await initialize(s)
  const first = Object.freeze({ type: 'agentMessage', id: 'a', text: '第一則' })
  const second = Object.freeze({ type: 'agentMessage', id: 'b', text: '第二則' })
  s.fake().reply('thread/items/list', { data: [{ item: first }, broken, { item: second, turnId: 123 }] })
  await expect(pending).resolves.toEqual([first, second])
  expect(s.logError).toHaveBeenCalledTimes(1)
  expect(s.fake().killed).toEqual(['kill'])
})

it.each(['list', 'items'] as const)('%s 未登入提供登入提示並保留原始錯誤', async (method) => {
  const s = setup()
  const pending = method === 'list' ? s.catalog.list() : s.catalog.items('/p', 't1')
  await initialize(s)
  const request = s.fake().sent.at(-1)
  s.fake().say({ id: request?.['id'], error: { code: 401, message: 'unauthorized' } })
  await expect(pending).rejects.toThrow(MSG_NOT_LOGGED_IN)
  expect(s.logError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('unauthorized') }))
  expect(s.fake().killed).toEqual(['kill'])
})

it.each(['throw', 'event'])('找不到 codex 的 %s 錯誤提供安裝提示', async (mode) => {
  const error = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
  const s = setup()
  const logError = vi.fn()
  const catalog = mode === 'throw' ? createCodexCatalog({ spawn: () => { throw error }, logError }) : s.catalog
  const pending = catalog.list()
  if (mode === 'event') s.fake().fail(error)
  await expect(pending).rejects.toThrow(MSG_NO_CODEX)
})
