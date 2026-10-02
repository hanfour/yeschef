import type { TerminalEndpoint } from '../shared/ipc.js'

export interface TerminalClient {
  open(cols: number, rows: number, projectId: string, tabId: string, command?: string): void
  sendInput(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

export interface TerminalClientHandlers {
  onOutput(data: string): void
  onExit(code: number | null): void
  onError(): void
}

export type SocketFactory = (url: string) => WebSocket

export function terminalWebSocketUrl(endpoint: TerminalEndpoint): string {
  return `ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`
}

export function createTerminalClient(
  url: string,
  handlers: TerminalClientHandlers,
  makeSocket: SocketFactory = (u) => new WebSocket(u),
): TerminalClient {
  const ws = makeSocket(url)
  const queue: string[] = []
  let open = false

  const flush = () => { while (queue.length > 0) ws.send(queue.shift() as string) }
  const send = (obj: unknown) => {
    const text = JSON.stringify(obj)
    if (open && ws.readyState === ws.OPEN) ws.send(text)
    else queue.push(text)
  }

  ws.onopen = () => { open = true; flush() }
  ws.onerror = () => { handlers.onError() }
  ws.onmessage = (ev: MessageEvent) => {
    let msg: unknown
    try { msg = JSON.parse(String(ev.data)) } catch {
      console.error('[yeschef] 終端機收到非 JSON 訊息,已忽略')
      return
    }
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
      console.error('[yeschef] 終端機收到缺 type 的訊息,已忽略')
      return
    }
    const m = msg as { type: string; data?: unknown; code?: unknown }
    if (m.type === 'output' && typeof m.data === 'string') handlers.onOutput(m.data)
    else if (m.type === 'exit') handlers.onExit(typeof m.code === 'number' ? m.code : null)
  }

  return {
    open: (cols, rows, projectId, tabId, command) =>
      send(
        command === undefined
          ? { type: 'open', cols, rows, projectId, tabId }
          : { type: 'open', cols, rows, projectId, tabId, command }
      ),
    sendInput: (data) => send({ type: 'input', data }),
    resize: (cols, rows) => send({ type: 'resize', cols, rows }),
    close: () => ws.close(),
  }
}
