/**
 * 換行分隔的 stdio JSON-RPC:一行一則訊息。`codex app-server` 與 `grok agent stdio`
 * 兩邊共用這一層。
 *
 * 這一層只管框幀與配對,不認得任何一邊的方法名。三條規則:
 * 1. 每個送出去的物件都帶 `jsonrpc: "2.0"`。缺了 app-server 完全不回,stdout 與 stderr
 *    都是空的,沒有任何錯誤訊息(RESULTS-11)。
 * 2. server 對 client 的請求一定要回覆,認不得也要回錯誤:不回覆會讓 codex 的 turn 永遠等下去。
 * 3. 非 JSON 的行記 log 略過,不中斷後面的行。
 */

/** 換行分隔的雙向管道。真的實作接子程序的 stdin/stdout,測試接陣列。 */
export interface CodexIo {
  write(line: string): void
  onLine(cb: (line: string) => void): void
}

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>

export interface CodexRpc {
  /** timeout 給 null 不設逾時;省略用建構時預設。 */
  request<T>(method: string, params?: unknown, timeout?: number | null): Promise<T>
  notify(method: string, params?: unknown): void
  onServerRequest(handler: ServerRequestHandler): void
  onNotification(handler: (method: string, params: unknown) => void): void
  /** 子程序沒了:所有待決請求以這個理由 reject,之後到達的回應直接丟掉。 */
  rejectAll(reason: Error): void
}

/** 回給認不得或處理失敗的 server 請求。JSON-RPC 的「方法不存在」。 */
export const UNKNOWN_METHOD_CODE = -32601

const DEFAULT_TIMEOUT_MS = 30_000

interface Pending {
  readonly method: string
  readonly resolve: (value: never) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function createRpc(
  io: CodexIo,
  logError: (error: Error) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  /** 使用者看得到的訊息裡稱呼對面那一頭的名字。預設 codex,grok 那兩個呼叫端自己傳。 */
  label: string = 'codex',
): CodexRpc {
  const pending = new Map<number, Pending>()
  let nextId = 1
  let buffer = ''
  let serverRequest: ServerRequestHandler | null = null
  let notification: ((method: string, params: unknown) => void) | null = null

  const send = (payload: Record<string, unknown>): void => {
    io.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`)
  }

  const settleResponse = (msg: Record<string, unknown>): void => {
    const id = msg['id']
    if (typeof id !== 'number') return
    const slot = pending.get(id)
    // rejectAll 之後才到的回應:那筆已經收掉了,直接丟。
    if (slot === undefined) return
    pending.delete(id)
    if (slot.timer !== null) clearTimeout(slot.timer)
    const error = msg['error']
    if (error !== undefined) {
      slot.reject(new Error(`${slot.method}:${JSON.stringify(error)}`))
      return
    }
    slot.resolve(msg['result'] as never)
  }

  const answerServerRequest = (id: unknown, method: string, params: unknown): void => {
    const handler = serverRequest
    const fail = (message: string): void => {
      logError(new Error(`${label} 請求 ${method} 處理失敗:${message}`))
      send({ id, error: { code: UNKNOWN_METHOD_CODE, message } })
    }
    if (handler === null) {
      fail('沒有處理器')
      return
    }
    // 一定要回覆:不回覆 codex 的 turn 會永遠等下去。
    handler(method, params).then(
      (result) => { send({ id, result }) },
      (cause: unknown) => { fail(cause instanceof Error ? cause.message : String(cause)) },
    )
  }

  const handleLine = (line: string): void => {
    if (line.trim() === '') return
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      logError(new Error(`${label} 送來非 JSON 的行,已略過:${line.slice(0, 200)}`))
      return
    }
    if (!isRecord(msg)) {
      logError(new Error(`${label} 送來不是物件的訊息,已略過:${line.slice(0, 200)}`))
      return
    }
    const method = msg['method']
    if (typeof method !== 'string') {
      settleResponse(msg)
      return
    }
    if (msg['id'] !== undefined) {
      answerServerRequest(msg['id'], method, msg['params'])
      return
    }
    notification?.(method, msg['params'])
  }

  io.onLine((chunk) => {
    buffer += chunk
    let i = buffer.indexOf('\n')
    while (i >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      handleLine(line)
      i = buffer.indexOf('\n')
    }
  })

  return {
    request<T>(method: string, params?: unknown, timeout?: number | null): Promise<T> {
      const ms = timeout === undefined ? timeoutMs : timeout
      const id = nextId
      nextId += 1
      return new Promise<T>((resolve, reject) => {
        const timer = ms === null ? null : setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${label} 請求 ${method} 超過 ${ms} 毫秒沒有回應`))
        }, ms)
        pending.set(id, { method, resolve: resolve as (v: never) => void, reject, timer })
        send(params === undefined ? { id, method } : { id, method, params })
      })
    },
    notify(method: string, params?: unknown): void {
      send(params === undefined ? { method } : { method, params })
    },
    onServerRequest(handler) { serverRequest = handler },
    onNotification(handler) { notification = handler },
    rejectAll(reason) {
      const all = [...pending.values()]
      pending.clear()
      for (const slot of all) {
        if (slot.timer !== null) clearTimeout(slot.timer)
        slot.reject(reason)
      }
    },
  }
}
