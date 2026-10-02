import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { type RawData } from 'ws'

export interface PageTarget {
  readonly type: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

export interface BrowserVersion {
  readonly webSocketDebuggerUrl: string
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export class CdpConnection {
  private sequence = 0
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.onMessage(data))
    socket.on('close', () => this.rejectPending(new Error('CDP WebSocket 已關閉')))
    socket.on('error', (error) => this.rejectPending(asError(error)))
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url)
    try {
      await new Promise<void>((resolveOpen, rejectOpen) => {
        const timer = setTimeout(() => rejectOpen(new Error('CDP WebSocket 連線逾時')), 10_000)
        socket.once('open', () => { clearTimeout(timer); resolveOpen() })
        socket.once('error', (error) => { clearTimeout(timer); rejectOpen(asError(error)) })
      })
    } catch (error) {
      socket.terminate()
      throw error
    }
    return new CdpConnection(socket)
  }

  send<T>(method: string, params: object = {}): Promise<T> {
    const id = ++this.sequence
    return new Promise<T>((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`CDP ${method} 逾時`))
      }, 10_000)
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer })
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error == null) return
        clearTimeout(timer)
        this.pending.delete(id)
        rejectSend(asError(error))
      })
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      readonly result?: { readonly value?: T }
      readonly exceptionDetails?: { readonly text?: string }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (response.exceptionDetails !== undefined) throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate 失敗')
    return response.result?.value as T
  }

  close(): void {
    this.socket.close()
    this.rejectPending(new Error('CDP WebSocket 已關閉'))
  }

  private onMessage(raw: RawData): void {
    const message = JSON.parse(raw.toString()) as {
      readonly id?: number
      readonly result?: unknown
      readonly error?: { readonly message?: string }
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error != null) pending.reject(new Error(message.error.message ?? 'CDP 指令失敗'))
    else pending.resolve(message.result)
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
  return await response.json() as T
}

function localPath(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' ? resolve(fileURLToPath(parsed)) : undefined
  } catch {
    return undefined
  }
}

export async function rendererTarget(port: number, expectedPath: string): Promise<PageTarget | undefined> {
  const targets = await getJson<readonly PageTarget[]>(`http://127.0.0.1:${port}/json/list`)
  return targets.find((target) => target.type === 'page' && localPath(target.url) === expectedPath)
}
