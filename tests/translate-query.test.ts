import { expect, it, vi } from 'vitest'
import { createTranslateHandler, createTranslateQuery, type TranslateQueryFn } from '../src/main/translate-query.js'

function setup(messages: readonly { readonly type: string; readonly message?: unknown; readonly result?: string }[] = []) {
  const queryFn = vi.fn<TranslateQueryFn>(() => (async function* () {
    for (const message of messages) yield message
  })())
  return { queryFn, run: createTranslateQuery(queryFn, '/user-data') }
}

it('翻譯不持久化且使用獨立目錄，不沿用專案工作目錄', async () => {
  const { queryFn, run } = setup()
  await run('source', 'model', new AbortController().signal)
  expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({
    prompt: 'source', options: expect.objectContaining({ persistSession: false, cwd: '/user-data' }),
  }))
})

it('停用全部內建工具並限制一回合，保留既有模型與設定限制', async () => {
  const { queryFn, run } = setup()
  await run('source', 'model', new AbortController().signal)
  expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
    tools: [], maxTurns: 1, model: 'model', settingSources: [], permissionMode: 'default',
  }) }))
  expect(queryFn.mock.calls[0]?.[0].options).not.toHaveProperty('allowedTools')
})

it('只串接多個 assistant 訊息的 text 區塊', async () => {
  const { run } = setup([
    { type: 'system', message: { content: [{ type: 'text', text: '忽略' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '甲' }, { type: 'tool_use', id: 'tool' }, { type: 'text', text: '乙' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '忽略' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '丙' }] } },
    { type: 'result', result: '忽略' },
  ])
  expect(await run('source', 'model', new AbortController().signal)).toBe('甲乙丙')
})

it.each([false, true])('外層 abort 轉發原因，呼叫前已中止：%s', async (alreadyAborted) => {
  const outer = new AbortController()
  const reason = new Error('停止')
  const { queryFn, run } = setup()
  const remove = vi.spyOn(outer.signal, 'removeEventListener')
  if (alreadyAborted) outer.abort(reason)
  const pending = run('source', 'model', outer.signal)
  if (!alreadyAborted) outer.abort(reason)
  await pending
  const controller = queryFn.mock.calls[0]?.[0].options.abortController
  expect(controller?.signal.aborted).toBe(true)
  expect(controller?.signal.reason).toBe(reason)
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function))
})

it.each(['同步', '串流'])('SDK %s 失敗仍移除 abort 監聽並傳回錯誤', async (mode) => {
  const error = new Error('失敗')
  const queryFn: TranslateQueryFn = () => {
    if (mode === '同步') throw error
    return (async function* () { throw error })()
  }
  const signal = new AbortController().signal
  const remove = vi.spyOn(signal, 'removeEventListener')
  await expect(createTranslateQuery(queryFn, '/user-data')('source', 'model', signal)).rejects.toBe(error)
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function))
})

it('來源不符就拒絕，不呼叫翻譯', async () => {
  const translate = vi.fn()
  const isAllowedSender = vi.fn(() => false)
  const handler = createTranslateHandler({ isAllowedSender, translate })
  expect(await handler({ sender: 'foreign' }, { text: 'hi', target: 'en' })).toEqual({ kind: 'rejected', message: '不接受這個來源的請求' })
  expect(isAllowedSender).toHaveBeenCalledExactlyOnceWith('foreign')
  expect(translate).not.toHaveBeenCalled()
})

it('允許的來源仍須驗證 payload，合法請求原樣回傳翻譯結果', async () => {
  const result = { kind: 'ok', text: '你好' } as const
  const translate = vi.fn().mockResolvedValue(result)
  const handler = createTranslateHandler({ isAllowedSender: (sender: string) => sender === 'allowed', translate })
  expect(await handler({ sender: 'allowed' }, null)).toEqual({ kind: 'rejected', message: 'payload 形狀不符' })
  expect(translate).not.toHaveBeenCalled()
  const payload = Object.freeze({ text: 'hi', target: 'en' })
  expect(await handler({ sender: 'allowed' }, payload)).toBe(result)
  expect(translate).toHaveBeenCalledExactlyOnceWith(payload)
})

it('assistant 訊息形狀不符時當成沒有文字,不丟例外', async () => {
  const messages: readonly { readonly type: string }[] = [
    { type: 'assistant' },
    { type: 'assistant', message: null } as { readonly type: string },
    { type: 'assistant', message: { content: 'not-an-array' } } as { readonly type: string },
    { type: 'assistant', message: { content: [null, 'x', { type: 'text' }, { type: 'text', text: 42 }] } } as { readonly type: string },
    { type: 'assistant', message: { content: [{ type: 'text', text: '好' }, { type: 'tool_use', text: '不要' }] } } as { readonly type: string },
  ]
  const queryFn: TranslateQueryFn = () => (async function* () { for (const m of messages) yield m })()
  const run = createTranslateQuery(queryFn, '/user-data')
  expect(await run('source', 'model', new AbortController().signal)).toBe('好')
})
