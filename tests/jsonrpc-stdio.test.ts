import { describe, it, expect, vi } from 'vitest'
import { createRpc, UNKNOWN_METHOD_CODE, type CodexIo } from '../src/main/jsonrpc-stdio.js'

function makeIo() {
  const written: string[] = []
  let emit: (line: string) => void = () => {}
  const io: CodexIo = {
    write: (line) => { written.push(line) },
    onLine: (cb) => { emit = cb },
  }
  return {
    io,
    written,
    /** 模擬 app-server 送一行進來。 */
    say: (obj: unknown) => { emit(`${JSON.stringify(obj)}\n`) },
    raw: (line: string) => { emit(line) },
    sent: () => written.map((w) => JSON.parse(w) as Record<string, unknown>),
  }
}

const setup = () => {
  const m = makeIo()
  const errors: string[] = []
  const rpc = createRpc(m.io, (e) => { errors.push(e.message) })
  return { ...m, errors, rpc }
}

describe('request', () => {
  it('timeoutMs 給 null 時不設逾時', async () => {
    vi.useFakeTimers()
    try {
      const m = makeIo()
      const rpc = createRpc(m.io, () => {}, 30_000)
      let settled = false
      const pending = rpc.request('turn/start', {}, null)
      void pending.then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(settled).toBe(false)
      m.say({ id: 1, result: {} })
      await pending
    } finally { vi.useRealTimers() }
  })

  it('送出的每個請求都帶 jsonrpc 2.0、遞增的 id 與 method', () => {
    const r = setup()
    void r.rpc.request('initialize', { a: 1 })
    void r.rpc.request('thread/start', { b: 2 })
    expect(r.sent()).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'thread/start', params: { b: 2 } },
    ])
  })

  it('每一行結尾有換行', () => {
    const r = setup()
    void r.rpc.request('initialize')
    expect(r.written[0]?.endsWith('\n')).toBe(true)
  })

  it('回應依 id 配對,resolve 成 result', async () => {
    const r = setup()
    const p1 = r.rpc.request<{ x: number }>('a')
    const p2 = r.rpc.request<{ y: number }>('b')
    r.say({ jsonrpc: '2.0', id: 2, result: { y: 20 } })
    r.say({ jsonrpc: '2.0', id: 1, result: { x: 10 } })
    expect(await p1).toEqual({ x: 10 })
    expect(await p2).toEqual({ y: 20 })
  })

  it('回應帶 error 時 reject,訊息含 method 與 error', async () => {
    const r = setup()
    const p = r.rpc.request('thread/start')
    r.say({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: '要 experimentalApi' } })
    await expect(p).rejects.toThrow(/thread\/start.*要 experimentalApi/)
  })

  it('沒有 params 時不送 params 欄位', () => {
    const r = setup()
    r.rpc.notify('initialized')
    expect(r.sent()).toEqual([{ jsonrpc: '2.0', method: 'initialized' }])
  })

  it('rejectAll 收掉全部待決的請求,之後的回應不會炸', async () => {
    const r = setup()
    const p = r.rpc.request('a')
    r.rpc.rejectAll(new Error('子程序沒了'))
    await expect(p).rejects.toThrow('子程序沒了')
    r.say({ jsonrpc: '2.0', id: 1, result: {} })
    expect(r.errors).toEqual([])
  })

  it('逾時的請求 reject,訊息含 method', async () => {
    vi.useFakeTimers()
    const m = makeIo()
    const errors: string[] = []
    const rpc = createRpc(m.io, (e) => { errors.push(e.message) }, 30_000)
    const p = rpc.request('initialize')
    const assertion = expect(p).rejects.toThrow(/initialize.*30000/)
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
    vi.useRealTimers()
  })
})

describe('通知與 server 請求', () => {
  it('通知交給 onNotification,不回任何東西', () => {
    const r = setup()
    const got: Array<[string, unknown]> = []
    r.rpc.onNotification((m, p) => { got.push([m, p]) })
    r.say({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'i1' } } })
    expect(got).toEqual([['item/completed', { item: { id: 'i1' } }]])
    expect(r.written).toEqual([])
  })

  it('server 請求交給 handler,回傳值當 result 送回,帶 jsonrpc 與同一個 id', async () => {
    const r = setup()
    r.rpc.onServerRequest(async (method) => ({ ok: method }))
    r.say({ jsonrpc: '2.0', id: 7, method: 'item/tool/call', params: {} })
    await vi.waitFor(() => expect(r.written.length).toBe(1))
    expect(r.sent()).toEqual([{ jsonrpc: '2.0', id: 7, result: { ok: 'item/tool/call' } }])
  })

  it('handler 丟例外:回 JSON-RPC 錯誤並記 log,不讓 codex 等下去', async () => {
    const r = setup()
    r.rpc.onServerRequest(async () => { throw new Error('處理不了') })
    r.say({ jsonrpc: '2.0', id: 3, method: 'item/fileChange/requestApproval', params: {} })
    await vi.waitFor(() => expect(r.written.length).toBe(1))
    const sent = r.sent()[0]!
    expect(sent['id']).toBe(3)
    expect(sent['error']).toMatchObject({ code: UNKNOWN_METHOD_CODE })
    expect(r.errors.some((e) => e.includes('處理不了'))).toBe(true)
  })

  it('沒有裝 handler 時,server 請求一樣要回錯誤', async () => {
    const r = setup()
    r.say({ jsonrpc: '2.0', id: 4, method: 'item/tool/call', params: {} })
    await vi.waitFor(() => expect(r.written.length).toBe(1))
    expect(r.sent()[0]).toMatchObject({ jsonrpc: '2.0', id: 4, error: { code: UNKNOWN_METHOD_CODE } })
  })
})

describe('框幀', () => {
  it('一次進來多行,逐行處理', () => {
    const m = makeIo()
    const rpc = createRpc(m.io, () => {})
    const got: string[] = []
    rpc.onNotification((method) => { got.push(method) })
    m.raw('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n')
    expect(got).toEqual(['a', 'b'])
  })

  it('切成半行也接得起來', () => {
    const m = makeIo()
    const rpc = createRpc(m.io, () => {})
    const got: string[] = []
    rpc.onNotification((method) => { got.push(method) })
    m.raw('{"jsonrpc":"2.0","me')
    expect(got).toEqual([])
    m.raw('thod":"a"}\n')
    expect(got).toEqual(['a'])
  })

  it('空行略過;非 JSON 的行記 log 略過,不中斷後續', () => {
    const r = setup()
    const got: string[] = []
    r.rpc.onNotification((method) => { got.push(method) })
    r.raw('\n')
    r.raw('這不是 JSON\n')
    r.raw('{"jsonrpc":"2.0","method":"a"}\n')
    expect(got).toEqual(['a'])
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toContain('這不是 JSON')
  })
})
