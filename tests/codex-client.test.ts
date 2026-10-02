import { describe, it, expect, vi } from 'vitest'
import { createCodexClient, type CodexClientDeps, type CodexProcess, type SpawnCodex } from '../src/main/codex/client.js'

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

function setup(over: Partial<Pick<CodexClientDeps, 'onApproval' | 'dynamicTools' | 'onDynamicToolCall' | 'skillRoots'>> = {}) {
  const s = makeSpawn()
  const errors: string[] = []
  const notes: Array<[string, unknown]> = []
  const exits: Array<number | null> = []
  const client = createCodexClient({
    ...over,
    cwd: '/p/alpha',
    logError: (e) => { errors.push(e.message) },
    onEvents: (method, params) => { notes.push([method, params]) },
    onApproval: over.onApproval ?? (async () => 'accept'),
    onExit: (code) => { exits.push(code) },
    spawn: s.spawn,
    killDelayMs: 5,
  })
  const paramsOf = async (method: string): Promise<Record<string, unknown>> => await vi.waitFor(() => {
    const hit = s.fake().sent.find((entry) => entry['method'] === method)
    if (hit === undefined) throw new Error(`還沒送出 ${method}`)
    return hit['params'] as Record<string, unknown>
  })
  const replyInitialize = async (): Promise<void> => { s.fake().reply('initialize', {}); await Promise.resolve() }
  const finishStart = async (started: ReturnType<typeof client.start>): Promise<void> => {
    await vi.waitFor(() => {
      const hit = s.fake().sent.find((entry) => entry['method'] === 'thread/start' || entry['method'] === 'thread/resume')
      if (hit === undefined) throw new Error('還沒送出 thread 請求')
      s.fake().reply(hit['method'] as string, { thread: { id: 'th-1' } })
    })
    await started
  }
  return {
    ...s, errors, notes, exits, client, paramsOf, replyInitialize, finishStart,
    say: (obj: unknown) => { s.fake().say(obj) },
    startAndSettle: async () => { const started = client.start(); await replyInitialize(); await finishStart(started) },
    nextReplyTo: async (id: number): Promise<unknown> => await vi.waitFor(() => {
      const hit = s.fake().sent.find((entry) => entry['id'] === id && ('result' in entry || 'error' in entry))
      if (hit === undefined) throw new Error(`還沒回覆 ${id}`)
      return hit['result']
    }),
    errorReplies: () => s.fake().sent.filter((entry) => 'error' in entry),
  }
}

/** 走完 start 的四個請求,回傳 threadId。 */
async function bootstrap(r: ReturnType<typeof setup>, threadId = 'th-1'): Promise<{ threadId: string; model?: string }> {
  const p = r.client.start()
  await vi.waitFor(() => r.fake().reply('initialize', { userAgent: 'codex' }))
  await vi.waitFor(() => r.fake().reply('thread/start', { thread: { id: threadId }, model: 'gpt-6-astra' }))
  return await p
}

describe('start', () => {
  it('第一次:spawn 在專案根目錄,請求順序 initialize → initialized → thread/start', async () => {
    const r = setup()
    const got = await bootstrap(r)
    expect(r.cwds).toEqual(['/p/alpha'])
    expect(r.fake().sent.map((s) => s['method'])).toEqual(['initialize', 'initialized', 'thread/start'])
    expect(got).toEqual({ threadId: 'th-1', model: 'gpt-6-astra' })
  })

  it('每個請求都帶 jsonrpc 2.0', async () => {
    const r = setup()
    await bootstrap(r)
    expect(r.fake().sent.every((s) => s['jsonrpc'] === '2.0')).toBe(true)
  })

  it('initialize 宣告 experimentalApi;thread/start 帶 cwd 與可請求提升權限的批准政策', async () => {
    const r = setup()
    await bootstrap(r)
    const init = r.fake().sent.find((s) => s['method'] === 'initialize')!
    expect(init['params']).toMatchObject({ capabilities: { experimentalApi: true } })
    const start = r.fake().sent.find((s) => s['method'] === 'thread/start')!
    expect(start['params']).toMatchObject({ cwd: '/p/alpha', approvalPolicy: 'on-request', sandbox: 'workspace-write', dynamicTools: [] })
  })

  it('帶 threadId 時走 thread/resume,不走 thread/start', async () => {
    const r = setup()
    const p = r.client.start('th-old')
    await vi.waitFor(() => r.fake().reply('initialize', {}))
    await vi.waitFor(() => r.fake().reply('thread/resume', { thread: { id: 'th-old' }, model: 'gpt-6-astra' }))
    expect(await p).toEqual({ threadId: 'th-old', model: 'gpt-6-astra' })
    expect(r.fake().sent.map((s) => s['method'])).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(r.fake().sent.find((s) => s['method'] === 'thread/resume')!['params']).toMatchObject({ threadId: 'th-old', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  })

  it('thread/start 回錯誤時 reject,子程序收掉', async () => {
    const r = setup()
    const p = r.client.start()
    await vi.waitFor(() => r.fake().reply('initialize', {}))
    await vi.waitFor(() => {
      const hit = r.fake().sent.find((s) => s['method'] === 'thread/start')!
      r.fake().say({ jsonrpc: '2.0', id: hit['id'], error: { code: -32000, message: 'not logged in' } })
    })
    await expect(p).rejects.toThrow(/not logged in/)
    expect(r.client.isRunning()).toBe(false)
  })
})

describe('send 與 interrupt', () => {
  it('turn/start 超過 30 秒仍等待回覆', async () => {
    const r = setup()
    await bootstrap(r)
    vi.useFakeTimers()
    try {
      let settled = false
      const pending = r.client.send('你好')
      void pending.then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      expect(r.client.isRunning()).toBe(true)
      r.fake().reply('turn/start', {})
      await pending
    } finally { vi.useRealTimers() }
  })

  it('照片使用原生 localImage，文件內容與原始檔案路徑交付至同一回合', async () => {
    const r = setup(); await bootstrap(r)
    const p = r.client.send('檢查附件', [{ name: 'photo.png', path: '/copy/photo.png', kind: 'image', mime: 'image/png', data: 'unused' }, { name: 'notes.txt', path: '/copy/notes.txt', kind: 'text', mime: 'application/octet-stream', text: 'document contents' }, { name: 'report.pdf', path: '/copy/report.pdf', kind: 'file', mime: 'application/octet-stream' }])
    await vi.waitFor(() => r.fake().reply('turn/start', {})); await p
    const turn = r.fake().sent.find(s => s['method'] === 'turn/start')!
    expect(turn['params']).toMatchObject({ input: [{ type: 'text', text: expect.stringContaining('document contents') }, { type: 'localImage', path: '/copy/photo.png' }] })
    expect(JSON.stringify(turn['params'])).toContain('/copy/report.pdf')
  })

  it('send 走 turn/start,帶 threadId 與文字輸入', async () => {
    const r = setup()
    await bootstrap(r)
    const p = r.client.send('你好')
    await vi.waitFor(() => r.fake().reply('turn/start', {}))
    await p
    const turn = r.fake().sent.find((s) => s['method'] === 'turn/start')!
    expect(turn['params']).toEqual({ threadId: 'th-1', input: [{ type: 'text', text: '你好' }] })
  })

  it('沒有進行中的 turn 就不送 interrupt', async () => {
    const r = setup()
    await bootstrap(r)
    await r.client.interrupt()
    expect(r.fake().sent.some((s) => s['method'] === 'turn/interrupt')).toBe(false)
  })

  it('turn/started 之後 interrupt 帶 threadId 與 turnId;turn/completed 之後又不送', async () => {
    const r = setup()
    await bootstrap(r)
    r.fake().say({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th-1', turn: { id: 'turn-9' } } })
    const p = r.client.interrupt()
    await vi.waitFor(() => r.fake().reply('turn/interrupt', {}))
    await p
    expect(r.fake().sent.find((s) => s['method'] === 'turn/interrupt')!['params']).toEqual({ threadId: 'th-1', turnId: 'turn-9' })

    r.fake().say({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'turn-9', status: 'completed' } } })
    const before = r.fake().sent.length
    await r.client.interrupt()
    expect(r.fake().sent.length).toBe(before)
  })

  it('沒有 client 時 send 丟錯,訊息說得出原因', async () => {
    const r = setup()
    await expect(r.client.send('你好')).rejects.toThrow(/尚未啟動/)
  })
})

describe('通知與批准', () => {
  it('通知原樣交給 onEvents', async () => {
    const r = setup()
    await bootstrap(r)
    r.fake().say({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'i1' } } })
    expect(r.notes).toContainEqual(['item/completed', { item: { id: 'i1' } }])
  })

  it('commandExecution 的批准請求交給 onApproval,允許回 accept', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const r = setup({ onApproval: async (kind, params) => { seen.push([kind, params]); return 'accept' } })
    await bootstrap(r)
    const params = { itemId: 'c1', threadId: 'th-1', turnId: 'turn-1', startedAtMs: 1, command: 'rm x', cwd: '/p', reason: '要刪檔' }
    r.fake().say({ jsonrpc: '2.0', id: 55, method: 'item/commandExecution/requestApproval', params })
    await vi.waitFor(() => expect(r.fake().sent.some((s) => s['id'] === 55)).toBe(true))
    expect(seen).toEqual([['command', params]])
    expect(r.fake().sent.find((s) => s['id'] === 55)).toEqual({ jsonrpc: '2.0', id: 55, result: { decision: 'accept' } })
  })

  it('fileChange 的批准請求:拒絕回 decline,不是 cancel', async () => {
    const r = setup({ onApproval: async () => 'decline' })
    await bootstrap(r)
    r.fake().say({ jsonrpc: '2.0', id: 56, method: 'item/fileChange/requestApproval', params: { itemId: 'f1', threadId: 'th-1', turnId: 'turn-1', startedAtMs: 1, reason: '改檔' } })
    await vi.waitFor(() => expect(r.fake().sent.some((s) => s['id'] === 56)).toBe(true))
    expect(r.fake().sent.find((s) => s['id'] === 56)).toEqual({ jsonrpc: '2.0', id: 56, result: { decision: 'decline' } })
  })

  it('item/tool/requestUserInput 回空答案並記 log(規格 §3)', async () => {
    const r = setup()
    await bootstrap(r)
    r.fake().say({ jsonrpc: '2.0', id: 57, method: 'item/tool/requestUserInput', params: { question: '要選哪個' } })
    await vi.waitFor(() => expect(r.fake().sent.some((s) => s['id'] === 57)).toBe(true))
    expect(r.fake().sent.find((s) => s['id'] === 57)).toEqual({ jsonrpc: '2.0', id: 57, result: { answers: {} } })
    expect(r.errors.some((e) => e.includes('item/tool/requestUserInput'))).toBe(true)
  })

  it('認不得的 server 請求一定回覆,不讓 codex 等下去', async () => {
    const r = setup()
    await bootstrap(r)
    r.fake().say({ jsonrpc: '2.0', id: 58, method: 'item/somethingNew/requestApproval', params: {} })
    await vi.waitFor(() => expect(r.fake().sent.some((s) => s['id'] === 58)).toBe(true))
    expect(r.fake().sent.find((s) => s['id'] === 58)).toHaveProperty('error')
    expect(r.errors.some((e) => e.includes('item/somethingNew/requestApproval'))).toBe(true)
  })
})

describe('收尾', () => {
  it('子程序發出 error:記 log、待決請求收掉,不逸出成未捕捉例外', async () => {
    const r = setup()
    await bootstrap(r)
    const pending = r.client.send('你好')
    r.fake().fail(new Error('spawn ENOENT'))
    await expect(pending).rejects.toThrow()
    expect(r.errors.some((e) => e.includes('spawn ENOENT'))).toBe(true)
    expect(r.client.isRunning()).toBe(false)
  })

  it('teardown 收到 exit 就完成,不等 killDelayMs', async () => {
    const r = setup()
    await bootstrap(r)
    vi.useFakeTimers()
    try {
      const pending = r.client.teardown()
      r.fake().exit(0)
      await pending
      expect(r.fake().killed).toEqual(['closeStdin'])
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('teardown:先關 stdin,等一下再 SIGTERM,之後 isRunning 為 false', async () => {
    const r = setup()
    await bootstrap(r)
    const f = r.fake()
    await r.client.teardown()
    expect(f.killed).toEqual(['closeStdin', 'kill'])
    expect(r.client.isRunning()).toBe(false)
  })

  it('teardown 可以重複呼叫,第二次不再動子程序', async () => {
    const r = setup()
    await bootstrap(r)
    const f = r.fake()
    await r.client.teardown()
    await r.client.teardown()
    expect(f.killed).toEqual(['closeStdin', 'kill'])
  })

  it('子程序自己非零退出:通知 onExit 並記 log,待決請求被收掉', async () => {
    const r = setup()
    await bootstrap(r)
    const pending = r.client.send('你好')
    r.fake().exit(1)
    await expect(pending).rejects.toThrow()
    expect(r.exits).toEqual([1])
    expect(r.errors.some((e) => e.includes('1'))).toBe(true)
  })

  it('stderr 的內容記 log,不當成協定訊息', async () => {
    const r = setup()
    await bootstrap(r)
    r.fake().stderr('warning: something\n')
    expect(r.errors.some((e) => e.includes('warning: something'))).toBe(true)
    expect(r.notes.some(([m]) => m.includes('warning'))).toBe(false)
  })
})

describe('dynamic tools', () => {
  const TOOLS = [
    { type: 'function' as const, name: 'ask_peer', description: '問同伴', inputSchema: { type: 'object' } },
    { type: 'function' as const, name: 'answer_peer', description: '回答同伴', inputSchema: { type: 'object' } },
  ]

  it('thread/start 帶著工具規格', async () => {
    const h = setup({ dynamicTools: TOOLS })
    const started = h.client.start()
    await h.replyInitialize()
    const params = await h.paramsOf('thread/start')
    expect(params['dynamicTools']).toEqual(TOOLS)
    await h.finishStart(started)
  })

  it('thread/resume 也帶著工具規格', async () => {
    const h = setup({ dynamicTools: TOOLS })
    const started = h.client.start('th-1')
    await h.replyInitialize()
    const params = await h.paramsOf('thread/resume')
    expect(params['dynamicTools']).toEqual(TOOLS)
    expect(params['threadId']).toBe('th-1')
    await h.finishStart(started)
  })

  it('沒給工具時維持既有行為:start 送空陣列,resume 不帶那個欄位', async () => {
    const a = setup()
    void a.client.start()
    await a.replyInitialize()
    expect((await a.paramsOf('thread/start'))['dynamicTools']).toEqual([])

    const b = setup()
    void b.client.start('th-2')
    await b.replyInitialize()
    expect('dynamicTools' in (await b.paramsOf('thread/resume'))).toBe(false)
  })

  it('工具呼叫轉給 onDynamicToolCall,成功時回 success 與文字', async () => {
    const calls: Array<[string, unknown]> = []
    const h = setup({
      dynamicTools: TOOLS,
      onDynamicToolCall: async (tool, args) => { calls.push([tool, args]); return { ok: true, text: '同伴回答:好' } },
    })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 91, method: 'item/tool/call', params: { tool: 'ask_peer', arguments: { question: '在嗎' }, callId: 'c-1' } })
    const reply = await h.nextReplyTo(91)
    expect(calls).toEqual([['ask_peer', { question: '在嗎' }]])
    expect(reply).toEqual({ success: true, contentItems: [{ type: 'inputText', text: '同伴回答:好' }] })
  })

  it('工具回失敗時 success 是 false,文字照樣送過去', async () => {
    const h = setup({ dynamicTools: TOOLS, onDynamicToolCall: async () => ({ ok: false, text: '這個專案沒有別的同伴' }) })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 92, method: 'item/tool/call', params: { tool: 'ask_peer', arguments: {}, callId: 'c-2' } })
    expect(await h.nextReplyTo(92)).toEqual({
      success: false, contentItems: [{ type: 'inputText', text: '這個專案沒有別的同伴' }],
    })
  })

  it('沒給處理函式時回失敗,不丟 JSON-RPC 錯誤', async () => {
    const h = setup({ dynamicTools: TOOLS })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 93, method: 'item/tool/call', params: { tool: 'ask_peer', arguments: {}, callId: 'c-3' } })
    const reply = await h.nextReplyTo(93)
    expect(reply).toMatchObject({ success: false })
    expect(h.errorReplies()).toEqual([])
  })

  it('tool 不是字串時回失敗並記錯誤', async () => {
    const h = setup({ dynamicTools: TOOLS, onDynamicToolCall: async () => ({ ok: true, text: 'x' }) })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 94, method: 'item/tool/call', params: { arguments: {}, callId: 'c-4' } })
    expect(await h.nextReplyTo(94)).toMatchObject({ success: false })
    expect(h.errors.length).toBeGreaterThan(0)
  })

  it('處理函式丟例外時回失敗,訊息帶那個例外', async () => {
    const h = setup({ dynamicTools: TOOLS, onDynamicToolCall: async () => { throw new Error('信箱壞了') } })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 95, method: 'item/tool/call', params: { tool: 'ask_peer', arguments: {}, callId: 'c-5' } })
    const reply = await h.nextReplyTo(95) as { success: boolean; contentItems: { text: string }[] }
    expect(reply.success).toBe(false)
    expect(reply.contentItems[0]?.text).toContain('信箱壞了')
    expect(h.errors.length).toBeGreaterThan(0)
  })
  it('callId、threadId、turnId、tool 一起往上傳(RESULTS-22 §9)', async () => {
    const seen: Array<Record<string, string | null>> = []
    const h = setup({
      dynamicTools: TOOLS,
      onDynamicToolCall: async (_tool, _args, params) => { seen.push({ ...params }); return { ok: true, text: '好' } },
    })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 96, method: 'item/tool/call', params: {
      threadId: 'th-1', turnId: 'tu-1', callId: 'exec-5c9e', tool: 'view_screenshot', arguments: {},
    } })
    await h.nextReplyTo(96)
    expect(seen).toEqual([{ threadId: 'th-1', turnId: 'tu-1', callId: 'exec-5c9e', tool: 'view_screenshot' }])
  })

  it('params 缺 callId 時給 null，其餘缺欄位補空字串', async () => {
    const seen: Array<Record<string, string | null>> = []
    const h = setup({
      dynamicTools: TOOLS,
      onDynamicToolCall: async (_tool, _args, params) => { seen.push({ ...params }); return { ok: true, text: '好' } },
    })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 97, method: 'item/tool/call', params: { tool: 'view_snapshot', arguments: {} } })
    await h.nextReplyTo(97)
    expect(seen).toEqual([{ threadId: '', turnId: '', callId: null, tool: 'view_snapshot' }])
  })

  it('帶 imageDataUrl 時回兩項 contentItems,文字在前圖在後(RESULTS-22 §2)', async () => {
    const h = setup({
      dynamicTools: TOOLS,
      onDynamicToolCall: async () => ({ ok: true, text: '可視範圍 800×600', imageDataUrl: 'data:image/png;base64,CCCC' }),
    })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 98, method: 'item/tool/call', params: { tool: 'view_screenshot', arguments: {}, callId: 'exec-1' } })
    expect(await h.nextReplyTo(98)).toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: '可視範圍 800×600' },
        { type: 'inputImage', imageUrl: 'data:image/png;base64,CCCC' },
      ],
    })
  })

})

it('registers shared skill roots before creating or resuming a thread', async () => {
  for (const thread of [undefined, 'existing']) {
    const s = setup({ skillRoots: ['/app/shared-skills/revisions/r/skills'] })
    const started = s.client.start(thread)
    await s.replyInitialize()
    expect(await s.paramsOf('skills/extraRoots/set')).toEqual({ extraRoots: ['/app/shared-skills/revisions/r/skills'] })
    expect(s.fake().sent.some(item => item.method === 'thread/start' || item.method === 'thread/resume')).toBe(false)
    s.fake().reply('skills/extraRoots/set', {})
    await s.finishStart(started)
    await s.client.teardown()
  }
})

it('an unsupported skill roots API fails visibly instead of silently omitting shared skills', async () => {
  const s = setup({ skillRoots: ['/app/shared/skills'] })
  const started = s.client.start()
  const result = expect(started).rejects.toThrow('Codex 無法載入共用 Skills')
  await s.replyInitialize()
  await s.paramsOf('skills/extraRoots/set')
  const request = s.fake().sent.find(item => item.method === 'skills/extraRoots/set')!
  s.say({ id: request.id, error: { code: -32601, message: 'Method not found' } })
  await result
  expect(s.fake().sent.some(item => item.method === 'thread/start')).toBe(false)
})
