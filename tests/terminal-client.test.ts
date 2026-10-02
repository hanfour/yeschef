import { describe, it, expect, vi } from 'vitest'
import { createTerminalClient, terminalWebSocketUrl } from '../src/renderer/terminal-client.js'

function fakeSocket() {
  const s: any = { sent: [], readyState: 1, onopen: null, onmessage: null, onclose: null, closed: false }
  s.send = (t: string) => s.sent.push(t)
  s.close = () => { s.closed = true }
  s.OPEN = 1
  return s
}

describe('terminal-client', () => {
  it('組出含已編碼 token 的 websocket URL', () => {
    expect(terminalWebSocketUrl({ port: 1234, token: 'a +/=' })).toBe('ws://127.0.0.1:1234/?token=a%20%2B%2F%3D')
  })

  it('open 送 open 訊息(連線已開時)', () => {
    const s = fakeSocket()
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn(), onError: vi.fn() }, () => s as any)
    s.onopen?.()
    c.open(80, 24, 'p1', 'tab-1', 'codex')
    expect(s.sent).toContain(JSON.stringify({ type: 'open', cols: 80, rows: 24, projectId: 'p1', tabId: 'tab-1', command: 'codex' }))
  })
  it('連線還沒開時 open 先排隊,開了才送', () => {
    const s = fakeSocket(); s.readyState = 0
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn(), onError: vi.fn() }, () => s as any)
    c.open(80, 24, 'p1', 'tab-1')
    expect(s.sent).toHaveLength(0)
    s.readyState = 1; s.onopen?.()
    expect(s.sent).toContain(JSON.stringify({ type: 'open', cols: 80, rows: 24, projectId: 'p1', tabId: 'tab-1' }))
  })
  it('sendInput 與 resize 送對應訊息', () => {
    const s = fakeSocket()
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn(), onError: vi.fn() }, () => s as any)
    s.onopen?.()
    c.sendInput('ls\r'); c.resize(90, 20)
    expect(s.sent).toContain(JSON.stringify({ type: 'input', data: 'ls\r' }))
    expect(s.sent).toContain(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }))
  })
  it('收到 output 呼叫 onOutput,收到 exit 呼叫 onExit', () => {
    const s = fakeSocket(); const onOutput = vi.fn(); const onExit = vi.fn()
    createTerminalClient('ws://x', { onOutput, onExit, onError: vi.fn() }, () => s as any)
    s.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hi' }) })
    s.onmessage?.({ data: JSON.stringify({ type: 'exit', code: 0 }) })
    expect(onOutput).toHaveBeenCalledWith('hi')
    expect(onExit).toHaveBeenCalledWith(0)
  })
  it('壞訊息忽略,不丟例外', () => {
    const s = fakeSocket(); const onOutput = vi.fn()
    createTerminalClient('ws://x', { onOutput, onExit: vi.fn(), onError: vi.fn() }, () => s as any)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => s.onmessage?.({ data: '不是 json' })).not.toThrow()
      expect(() => s.onmessage?.({ data: JSON.stringify({}) })).not.toThrow()
      expect(error).toHaveBeenCalledWith('[yeschef] 終端機收到非 JSON 訊息,已忽略')
      expect(error).toHaveBeenCalledWith('[yeschef] 終端機收到缺 type 的訊息,已忽略')
      expect(onOutput).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('連線錯誤時呼叫 onError', () => {
    const s = fakeSocket(); const onError = vi.fn()
    createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn(), onError }, () => s as any)
    s.onerror?.()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
