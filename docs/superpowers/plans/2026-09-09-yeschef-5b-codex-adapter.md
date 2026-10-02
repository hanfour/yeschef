# 子專案 5b:codex 對話分頁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓一個專案的對話分頁可以是 codex:`TabEntry.provider === 'codex'` 的分頁由一個把 codex app-server 協定翻成 yeschef `Event`／`SessionState`／`ApprovalRequest` 的 adapter 驅動,renderer 一行不改。

**Architecture:** `src/main/codex/` 四個檔各一個責任:`rpc.ts` 做 stdio 的換行分隔 JSON-RPC 框幀,`mapper.ts` 把 codex 通知翻成 `Event[]`,`client.ts` 管子程序與 thread／turn 的生命週期,`conversation.ts` 實作與 Claude 那邊同一個 `Conversation` 介面。`ipc-bridge.ts` 的 `createSlot` 依分頁的 `provider` 決定用哪一個工廠;批准、待批准記號、busy 記號、分頁關閉全部沿用 D2 既有的通道。

**Tech Stack:** Electron 44、TypeScript 7(`strict`、`noUncheckedIndexedAccess`)、vitest 4、`node:child_process`、codex-cli 0.153.4 的 app-server(stdio JSON-RPC)。

**Spec:** `docs/specs/2026-09-09-yeschef-5b-codex-adapter-design.md`。協定實測見 `docs/RESULTS-11-codex-dynamic-tools.md`;`Conversation` 介面見 `src/main/conversation.ts`。

## Global Constraints

- 每個請求都要帶 `jsonrpc: "2.0"`。缺了 app-server 完全不回、stdout 與 stderr 都是空的,沒有錯誤訊息(RESULTS-11 的坑)。單元測試要釘住這一點。
- `initialize` 的 `capabilities.experimentalApi` 為 `true`(5c 的 `dynamicTools` 需要;5b 先宣告好,不必等)。
- `thread/start` 與 `thread/resume` 的 `approvalPolicy` 用 `'untrusted'`:可信集合以外的都問,由 app 問(規格 §3)。
- **收到不認得的 server → client 請求時,一定要回一個 JSON-RPC 錯誤回應並記 log。** 不回覆會讓 codex 的 turn 永遠等下去。這條也是協定方法名寫錯時的安全網。
- 批准 decision 只用 `accept` 與 `decline`。拒絕與 30 秒逾時都送 `decline`,不用 `cancel`(那會中斷整個 turn,與 Claude 那邊「拒絕後模型繼續」不一致,規格 §3)。
- 一個 codex 對話一個 `codex app-server` 子程序,cwd 是專案根目錄。切到背景且回合結束就收掉:關 stdin → 等 2 秒 → SIGTERM(規格 §5)。
- codex 特有的畫面(`plan`、`webSearch`、`collabAgentToolCall` 等)第一版當未知事件,畫成既有的可展開「未知事件」,不靜默丟(規格 §0、§2)。只有**認得的通知但不認得的 `ThreadItem.type`** 才產生 `unknown`;不在對應表上的**通知方法**回空陣列,不進對話。
- 使用者可見文案:分頁標籤「codex 對話」「codex 對話 2」…;按鈕「新 codex 對話」;未登入「codex 未登入,請在終端執行 `codex login`」;PATH 找不到「PATH 找不到 codex,請先安裝」。
- 資料不就地修改:mapper 與 rpc 的純函式一律回新物件;模組私有的緩衝(事件 log、in-flight map)沿用既有做法。
- 所有測試檔放 `tests/`,`.tsx` 測試檔首行 `// @vitest-environment jsdom`。adapter 全部用假的 stdio 對測,**不起真的 codex**(規格 §8)。
- 覆蓋率門檻沿專案:Stmts ≥ 93、Branch ≥ 86;`src/main/index.ts` 維持排除。
- 每個 Task 結尾 `git add <明確檔名>` 與 `git commit` 分兩個指令執行,不用 `&&` 串接,不用 `git add -A`/`.`;commit message 格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 執行 `npm run typecheck` 與 `npm test` 都要綠才算完成一個 Task;Task 6 之後跑 `npm run test:coverage` 確認門檻。

---

## 檔案結構

新增:

| 檔案 | 責任 |
|---|---|
| `src/main/codex/rpc.ts` | 換行分隔 JSON-RPC 的框幀與配對:`request`、`notify`、回覆 server 請求、`rejectAll`;非 JSON 的行記 log 略過 |
| `src/main/codex/mapper.ts` | codex 通知 → `Event[]`(規格 §2 的對應表);唯一的狀態是最近一次 token 用量 |
| `src/main/codex/client.ts` | 子程序生命週期:spawn、`initialize`／`initialized`、`thread/start`／`thread/resume`、`turn/start`、`turn/interrupt`、收掉;真的 spawn 實作 `nodeSpawnCodex` 放檔尾 |
| `src/main/codex/conversation.ts` | 實作 `Conversation`:狀態、事件 log、批准註冊表與扣住、activate／deactivate／replay／dispose |
| `tests/codex-rpc.test.ts`、`tests/codex-mapper.test.ts`、`tests/codex-client.test.ts`、`tests/codex-conversation.test.ts` | 各自的單元測試 |

修改:

| 檔案 | 改動 |
|---|---|
| `src/shared/events.ts` | `session-end` 加選填的 `tokens` |
| `src/shared/fold.ts` | `cost` 加選填的 `tokens` |
| `src/renderer/components/Conversation.tsx` | 回合結尾多顯示 token 數 |
| `src/shared/projects.ts` | `ConversationOpenPayload` 加 `provider`;`CODEX_CONVERSATION_TAB_LABEL` |
| `src/shared/ipc.ts` | `YesChefApi.openConversation(projectId, provider)` |
| `src/preload/bridge.ts` | 送出 `provider` |
| `src/main/projects-state.ts` | `openConversationTab` 收 `provider`,標籤依 provider 分開編號 |
| `src/main/projects-ipc.ts` | `conversations:open` 帶 provider |
| `src/main/ipc-bridge.ts` | `createSlot` 依 `provider` 選工廠;`Slot.runtime` 改選填 |
| `src/renderer/hooks/useProjects.ts` | `openConversation(provider)` |
| `src/renderer/components/LeftPane.tsx` | 「新 codex 對話」按鈕 |
| `src/renderer/components/ConversationPane.tsx` | codex 分頁不畫 Recents 側欄 |

---

### Task 1: codex 的 JSON-RPC 框幀

**Files:**
- Create: `src/main/codex/rpc.ts`
- Test: `tests/codex-rpc.test.ts`

**Interfaces:**
- Produces:
  - `interface CodexIo { write(line: string): void; onLine(cb: (line: string) => void): void }`
  - `interface CodexRpc { request<T>(method: string, params?: unknown): Promise<T>; notify(method: string, params?: unknown): void; onServerRequest(h: ServerRequestHandler): void; onNotification(h: (method: string, params: unknown) => void): void; rejectAll(reason: Error): void }`
  - `type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>`
  - `createRpc(io: CodexIo, logError: (e: Error) => void, timeoutMs?: number): CodexRpc`
  - `const UNKNOWN_METHOD_CODE = -32601`

- [ ] **Step 1: 寫失敗測試**

`tests/codex-rpc.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createRpc, UNKNOWN_METHOD_CODE, type CodexIo } from '../src/main/codex/rpc.js'

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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/codex-rpc.test.ts`
Expected: FAIL,`Cannot find module '../src/main/codex/rpc.js'`

- [ ] **Step 3: 寫實作**

`src/main/codex/rpc.ts`:

```ts
/**
 * codex app-server 的 stdio JSON-RPC:換行分隔的一行一則訊息。
 *
 * 這一層只管框幀與配對,不認得任何 codex 的方法名。三條規則:
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
  request<T>(method: string, params?: unknown): Promise<T>
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
  readonly timer: ReturnType<typeof setTimeout>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function createRpc(
  io: CodexIo,
  logError: (error: Error) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
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
    clearTimeout(slot.timer)
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
      logError(new Error(`codex 請求 ${method} 處理失敗:${message}`))
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
      logError(new Error(`codex 送來非 JSON 的行,已略過:${line.slice(0, 200)}`))
      return
    }
    if (!isRecord(msg)) {
      logError(new Error(`codex 送來不是物件的訊息,已略過:${line.slice(0, 200)}`))
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
    request<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId
      nextId += 1
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`codex 請求 ${method} 超過 ${timeoutMs} 毫秒沒有回應`))
        }, timeoutMs)
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
        clearTimeout(slot.timer)
        slot.reject(reason)
      }
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/codex-rpc.test.ts`
Expected: PASS(14 tests)

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/codex/rpc.ts tests/codex-rpc.test.ts
git commit -m "feat: codex app-server 的 stdio JSON-RPC 框幀"
```

---

### Task 2: codex 通知 → Event 的對應

**Files:**
- Create: `src/main/codex/mapper.ts`
- Test: `tests/codex-mapper.test.ts`

**Interfaces:**
- Produces:
  - `interface CodexMapper { accept(method: string, params: unknown): readonly Event[] }`
  - `createCodexMapper(): CodexMapper`
  - `const CODEX_TOOL_NAMES = { command: 'Bash', fileChange: 'Edit' } as const`

規格 §2 的對應表。三條規則決定「什麼都不畫」與「畫成未知」的分界:

- 不在表上的**通知方法**(`hook/started`、`account/rateLimits/updated`、`turn/started` 等)回空陣列。它們與對話內容無關,畫成未知事件只會洗版。
- 在表上的通知但**認不得的 `ThreadItem.type`**(`plan`、`webSearch`、`todoList`…)回一則 `unknown`,畫成可展開的未知事件。
- `thread/started` 回空陣列:`session-start` 由 Task 3 的 client 從 `thread/start` 的**回應**產生,那裡才拿得到 `model`,而且 `thread/resume` 沒有這則通知。

- [ ] **Step 1: 先加 session-end 的 token 欄位**

規格 §2 要 codex 的回合結尾顯示 token 數,而 `session-end` 只有 `costUsd` 與 `numTurns`。
加一個選填欄位,Claude 那條路不受影響(它不填就不畫)。

`src/shared/events.ts` 的 `session-end` 變體加一行(放在 `numTurns` 之後):

```ts
      /** 這一回合結束時該 session 累計的 token 數。codex 用它顯示用量;Claude 那條路不填。 */
      tokens?: number
```

`src/shared/fold.ts`:兩處 `readonly cost?: { readonly usd?: number; readonly turns?: number }` 都改成

```ts
  readonly cost?: { readonly usd?: number; readonly turns?: number; readonly tokens?: number }
```

`sessionEndCost` 改成:

```ts
function sessionEndCost(
  event: Extract<Event, { kind: 'session-end' }>
): WorkingView['cost'] {
  if (event.costUsd === undefined && event.numTurns === undefined && event.tokens === undefined) return undefined
  return {
    ...(event.costUsd === undefined ? {} : { usd: event.costUsd }),
    ...(event.numTurns === undefined ? {} : { turns: event.numTurns }),
    ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
  }
}
```

`src/renderer/components/Conversation.tsx` 的 footer 加一段:

```tsx
        <p className="conversation-cost">
          {view.cost.turns === undefined ? '' : String(view.cost.turns) + ' 輪'}
          {view.cost.usd === undefined ? '' : ' · US$' + view.cost.usd.toFixed(4)}
          {view.cost.tokens === undefined ? '' : ' · ' + view.cost.tokens.toLocaleString('en-US') + ' tokens'}
        </p>
```

`tests/fold.test.ts` 加一條:

```ts
  it('session-end 只有 tokens 時 cost 也要成立', () => {
    const view = fold([{ kind: 'session-end', isError: false, tokens: 4200 }])
    expect(view.cost).toEqual({ tokens: 4200 })
  })
```

Run: `npx vitest run tests/fold.test.ts`
Expected: PASS

- [ ] **Step 2: 寫失敗測試**

`tests/codex-mapper.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createCodexMapper } from '../src/main/codex/mapper.js'
import type { Event } from '../src/shared/events.js'

const started = (item: Record<string, unknown>): unknown => ({ item, threadId: 't', turnId: 'u', startedAtMs: 1 })
const completed = (item: Record<string, unknown>): unknown => ({ item, threadId: 't', turnId: 'u', completedAtMs: 2 })
const map = (method: string, params: unknown): readonly Event[] => createCodexMapper().accept(method, params)

describe('文字與思考', () => {
  it('item/agentMessage/delta → text-delta,messageId 用 itemId、index 0', () => {
    expect(map('item/agentMessage/delta', { itemId: 'i1', delta: '嗨', threadId: 't', turnId: 'u' })).toEqual([
      { kind: 'text-delta', messageId: 'i1', index: 0, text: '嗨' },
    ])
  })

  it('item/completed agentMessage → text 完整快照,messageId 與 index 與 delta 對得上', () => {
    expect(map('item/completed', completed({ type: 'agentMessage', id: 'i1', text: '完整回覆', phase: 'final_answer' }))).toEqual([
      { kind: 'text', messageId: 'i1', index: 0, text: '完整回覆' },
    ])
  })

  it('phase 為 commentary 的 agentMessage 也是文字', () => {
    expect(map('item/completed', completed({ type: 'agentMessage', id: 'i2', text: '我先看一下', phase: 'commentary' }))).toEqual([
      { kind: 'text', messageId: 'i2', index: 0, text: '我先看一下' },
    ])
  })

  it('item/started agentMessage 不畫:內容由 delta 與 completed 帶', () => {
    expect(map('item/started', started({ type: 'agentMessage', id: 'i1', text: '' }))).toEqual([])
  })

  it('reasoning:summary 有值用 summary,否則用 content', () => {
    expect(map('item/completed', completed({ type: 'reasoning', id: 'r1', summary: ['先看檔案', '再改'], content: ['忽略'] }))).toEqual([
      { kind: 'thinking', messageId: 'r1', index: 0, text: '先看檔案\n再改' },
    ])
    expect(map('item/completed', completed({ type: 'reasoning', id: 'r2', summary: [], content: ['只有 content'] }))).toEqual([
      { kind: 'thinking', messageId: 'r2', index: 0, text: '只有 content' },
    ])
  })
})

describe('指令執行', () => {
  const cmd = { type: 'commandExecution', id: 'c1', command: 'ls -la', cwd: '/p' }

  it('item/started → tool-use,名字 Bash,input 是指令與 cwd', () => {
    expect(map('item/started', started({ ...cmd, status: 'inProgress' }))).toEqual([
      { kind: 'tool-use', id: 'c1', name: 'Bash', input: { command: 'ls -la', cwd: '/p' } },
    ])
  })

  it('item/completed 成功 → tool-result 帶 exitCode,加 tool-raw-output 帶輸出', () => {
    expect(map('item/completed', completed({ ...cmd, status: 'completed', exitCode: 0, aggregatedOutput: 'a.ts\nb.ts' }))).toEqual([
      { kind: 'tool-result', id: 'c1', content: { exitCode: 0, status: 'completed' }, isError: false },
      { kind: 'tool-raw-output', id: 'c1', stdout: 'a.ts\nb.ts', stderr: '', interrupted: false },
    ])
  })

  it('status 不是 completed 就是錯誤;declined 標成中斷', () => {
    const failed = map('item/completed', completed({ ...cmd, status: 'failed', exitCode: 1, aggregatedOutput: '炸了' }))
    expect(failed[0]).toEqual({ kind: 'tool-result', id: 'c1', content: { exitCode: 1, status: 'failed' }, isError: true })
    expect(failed[1]).toEqual({ kind: 'tool-raw-output', id: 'c1', stdout: '炸了', stderr: '', interrupted: false })
    const declined = map('item/completed', completed({ ...cmd, status: 'declined', exitCode: null, aggregatedOutput: null }))
    expect(declined[1]).toEqual({ kind: 'tool-raw-output', id: 'c1', stdout: '', stderr: '', interrupted: true })
  })
})

describe('檔案修改與工具呼叫', () => {
  it('fileChange:started → tool-use Edit 帶 changes;completed → tool-result', () => {
    const changes = [{ path: '/p/a.ts', kind: 'update', diff: '@@' }]
    expect(map('item/started', started({ type: 'fileChange', id: 'f1', changes, status: 'inProgress' }))).toEqual([
      { kind: 'tool-use', id: 'f1', name: 'Edit', input: { changes } },
    ])
    expect(map('item/completed', completed({ type: 'fileChange', id: 'f1', changes, status: 'completed' }))).toEqual([
      { kind: 'tool-result', id: 'f1', content: { status: 'completed' }, isError: false },
    ])
  })

  it('mcpToolCall 與 dynamicToolCall:名字用 tool,input 用 arguments', () => {
    expect(map('item/started', started({ type: 'mcpToolCall', id: 'm1', tool: 'search', server: 's', arguments: { q: 'x' }, status: 'inProgress' }))).toEqual([
      { kind: 'tool-use', id: 'm1', name: 'search', input: { q: 'x' } },
    ])
    expect(map('item/completed', completed({ type: 'dynamicToolCall', id: 'd1', tool: 'ask_peer', arguments: { question: 'y' }, status: 'completed', contentItems: [{ type: 'inputText', text: '同伴回答' }] }))).toEqual([
      { kind: 'tool-result', id: 'd1', content: [{ type: 'inputText', text: '同伴回答' }], isError: false },
    ])
  })
})

describe('壓縮與回合結束', () => {
  it('contextCompaction → 壓縮分隔線,沒有 token 數就填 0', () => {
    expect(map('item/completed', completed({ type: 'contextCompaction', id: 'x1' }))).toEqual([
      { kind: 'compact-boundary', trigger: 'auto', preTokens: 0 },
    ])
  })

  it('turn/completed status completed → session-end 不是錯誤', () => {
    expect(map('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })).toEqual([
      { kind: 'session-end', isError: false, numTurns: 1 },
    ])
  })

  it('turn/completed status failed → session-end 帶 error.message', () => {
    expect(map('turn/completed', { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: '模型拒絕' } } })).toEqual([
      { kind: 'session-end', isError: true, numTurns: 1, errorMessage: '模型拒絕' },
    ])
  })

  it('turn/completed status interrupted → session-end 帶中斷訊息', () => {
    expect(map('turn/completed', { threadId: 't', turn: { id: 'u', status: 'interrupted' } })).toEqual([
      { kind: 'session-end', isError: true, numTurns: 1, errorMessage: '回合已中斷' },
    ])
  })

  it('turn/completed 之前收過 tokenUsage 時,session-end 帶 token 數', () => {
    const m = createCodexMapper()
    expect(m.accept('thread/tokenUsage/updated', {
      threadId: 't', turnId: 'u',
      tokenUsage: { last: { totalTokens: 120 }, total: { totalTokens: 4200 } },
    })).toEqual([])
    expect(m.accept('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })).toEqual([
      { kind: 'session-end', isError: false, numTurns: 1, tokens: 4200 },
    ])
  })
})

describe('認不得的東西', () => {
  it('認得的通知裡認不得的 item type → unknown,不靜默丟', () => {
    const out = map('item/completed', completed({ type: 'webSearch', id: 'w1', query: 'x' }))
    expect(out.length).toBe(1)
    expect(out[0]?.kind).toBe('unknown')
  })

  it('userMessage 也是 unknown:那是我們自己送出去的,對話裡已經有了', () => {
    expect(map('item/completed', completed({ type: 'userMessage', id: 'u1', content: [] }))[0]?.kind).toBe('unknown')
  })

  it('不在對應表上的通知方法回空陣列,不進對話', () => {
    for (const method of ['hook/started', 'hook/completed', 'account/rateLimits/updated', 'turn/started', 'thread/started', 'turn/diff/updated']) {
      expect(map(method, { anything: true })).toEqual([])
    }
  })

  it('params 形狀不符時回空陣列,不丟例外', () => {
    expect(map('item/completed', null)).toEqual([])
    expect(map('item/completed', { item: 'not-an-object' })).toEqual([])
    expect(map('item/agentMessage/delta', { itemId: 1, delta: 2 })).toEqual([])
    expect(map('turn/completed', {})).toEqual([])
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/codex-mapper.test.ts`
Expected: FAIL,`Cannot find module '../src/main/codex/mapper.js'`

- [ ] **Step 4: 寫實作**

`src/main/codex/mapper.ts`:

```ts
/**
 * codex 的通知翻成 yeschef 的 `Event`(規格 §2 的對應表)。
 *
 * 分界規則:不在表上的通知方法回空陣列(`hook/*`、`account/*` 那些與對話內容無關,
 * 畫成未知事件只會洗版);在表上的通知但認不得的 `ThreadItem.type` 回一則 `unknown`,
 * 畫成可展開的未知事件,不靜默丟(規格 §0)。
 *
 * `thread/started` 刻意回空:`session-start` 由 client 從 `thread/start` 的回應產生,
 * 那裡才拿得到 model,而且 `thread/resume` 沒有這則通知。
 *
 * 唯一的狀態是最近一次 token 用量:codex 用另一則通知送它,要併進回合結束的事件裡。
 */
import type { Event } from '../../shared/events.js'

export const CODEX_TOOL_NAMES = { command: 'Bash', fileChange: 'Edit' } as const

/** codex 的 turn 中斷時給的訊息。 */
export const INTERRUPTED_MESSAGE = '回合已中斷'

export interface CodexMapper {
  accept(method: string, params: unknown): readonly Event[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** reasoning 的 summary 與 content 都是字串陣列;summary 有內容就用它。 */
function joinText(v: unknown): string {
  if (!Array.isArray(v)) return ''
  return v.filter((x): x is string => typeof x === 'string').join('\n')
}

function unknownEvent(raw: unknown): readonly Event[] {
  return [{ kind: 'unknown', raw }]
}

function itemStarted(item: Record<string, unknown>): readonly Event[] {
  const id = str(item['id'])
  if (id === undefined) return []
  switch (item['type']) {
    case 'agentMessage':
    case 'reasoning':
      // 內容由 delta 與 completed 帶,開始的時候沒有東西可畫。
      return []
    case 'commandExecution':
      return [{ kind: 'tool-use', id, name: CODEX_TOOL_NAMES.command, input: { command: item['command'], cwd: item['cwd'] } }]
    case 'fileChange':
      return [{ kind: 'tool-use', id, name: CODEX_TOOL_NAMES.fileChange, input: { changes: item['changes'] } }]
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const tool = str(item['tool'])
      return tool === undefined ? unknownEvent(item) : [{ kind: 'tool-use', id, name: tool, input: item['arguments'] }]
    }
    default:
      return unknownEvent(item)
  }
}

function itemCompleted(item: Record<string, unknown>): readonly Event[] {
  const id = str(item['id'])
  if (id === undefined) return []
  const status = str(item['status'])
  const isError = status !== undefined && status !== 'completed'
  switch (item['type']) {
    case 'agentMessage': {
      const text = str(item['text'])
      return text === undefined ? unknownEvent(item) : [{ kind: 'text', messageId: id, index: 0, text }]
    }
    case 'reasoning': {
      const summary = joinText(item['summary'])
      const text = summary === '' ? joinText(item['content']) : summary
      return [{ kind: 'thinking', messageId: id, index: 0, text }]
    }
    case 'commandExecution':
      return [
        { kind: 'tool-result', id, content: { exitCode: item['exitCode'] ?? null, status: status ?? null }, isError },
        {
          kind: 'tool-raw-output',
          id,
          stdout: str(item['aggregatedOutput']) ?? '',
          stderr: '',
          interrupted: status === 'declined',
        },
      ]
    case 'fileChange':
      return [{ kind: 'tool-result', id, content: { status: status ?? null }, isError }]
    case 'mcpToolCall':
      return [{ kind: 'tool-result', id, content: item['result'] ?? item['error'] ?? null, isError }]
    case 'dynamicToolCall':
      return [{ kind: 'tool-result', id, content: item['contentItems'] ?? null, isError }]
    case 'contextCompaction':
      // codex 沒有給壓縮前後的 token 數,分隔線只畫「對話已壓縮」。
      return [{ kind: 'compact-boundary', trigger: 'auto', preTokens: 0 }]
    default:
      return unknownEvent(item)
  }
}

function turnCompleted(params: Record<string, unknown>, totalTokens: number | undefined): readonly Event[] {
  const turn = params['turn']
  if (!isRecord(turn)) return []
  const status = str(turn['status'])
  const error = isRecord(turn['error']) ? str(turn['error']['message']) : undefined
  const errorMessage = status === 'interrupted' ? INTERRUPTED_MESSAGE : error
  const isError = status !== 'completed'
  return [{
    kind: 'session-end',
    isError,
    numTurns: 1,
    ...(totalTokens === undefined ? {} : { tokens: totalTokens }),
    ...(isError && errorMessage !== undefined ? { errorMessage } : {}),
  }]
}

export function createCodexMapper(): CodexMapper {
  let totalTokens: number | undefined

  return {
    accept(method, params) {
      if (!isRecord(params)) return []
      switch (method) {
        case 'item/agentMessage/delta': {
          const itemId = str(params['itemId'])
          const delta = str(params['delta'])
          if (itemId === undefined || delta === undefined) return []
          return [{ kind: 'text-delta', messageId: itemId, index: 0, text: delta }]
        }
        case 'item/started': {
          const item = params['item']
          return isRecord(item) ? itemStarted(item) : []
        }
        case 'item/completed': {
          const item = params['item']
          return isRecord(item) ? itemCompleted(item) : []
        }
        case 'thread/tokenUsage/updated': {
          const usage = params['tokenUsage']
          const total = isRecord(usage) && isRecord(usage['total']) ? num(usage['total']['totalTokens']) : undefined
          if (total !== undefined) totalTokens = total
          return []
        }
        case 'turn/completed':
          return turnCompleted(params, totalTokens)
        default:
          // `hook/*`、`account/*`、`turn/started`、`thread/started` 這些與對話內容無關。
          return []
      }
    },
  }
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/codex-mapper.test.ts`
Expected: PASS(16 tests)

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/events.ts src/shared/fold.ts src/renderer/components/Conversation.tsx src/main/codex/mapper.ts tests/fold.test.ts tests/codex-mapper.test.ts
git commit -m "feat: codex 通知翻成 yeschef 的事件,回合結尾可顯示 token 數"
```

---

### Task 3: codex 子程序的生命週期

**Files:**
- Create: `src/main/codex/client.ts`
- Test: `tests/codex-client.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createRpc`、`CodexIo`、`ServerRequestHandler`。
- Produces:
  - `interface CodexProcess { write(line: string): void; closeStdin(): void; kill(): void; onLine(cb: (chunk: string) => void): void; onStderr(cb: (chunk: string) => void): void; onExit(cb: (code: number | null) => void): void }`
  - `type SpawnCodex = (cwd: string) => CodexProcess`
  - `type ApprovalKind = 'command' | 'fileChange'`
  - `interface CodexClientDeps { cwd: string; logError: (e: Error) => void; onEvents: (method: string, params: unknown) => void; onApproval: (kind: ApprovalKind, params: Record<string, unknown>) => Promise<'accept' | 'decline'>; onExit: (code: number | null) => void; spawn?: SpawnCodex; requestTimeoutMs?: number; killDelayMs?: number }`
  - `interface CodexClient { start(threadId?: string): Promise<{ threadId: string; model?: string }>; send(text: string): Promise<void>; interrupt(): Promise<void>; teardown(): Promise<void>; isRunning(): boolean }`
  - `createCodexClient(deps: CodexClientDeps): CodexClient`
  - `const APPROVAL_METHODS = { 'item/commandExecution/requestApproval': 'command', 'item/fileChange/requestApproval': 'fileChange' } as const`
  - `nodeSpawnCodex: SpawnCodex`(真的 spawn,檔尾)

- [ ] **Step 1: 寫失敗測試**

`tests/codex-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createCodexClient, type CodexProcess, type SpawnCodex } from '../src/main/codex/client.js'

interface Fake {
  readonly sent: Array<Record<string, unknown>>
  readonly killed: string[]
  say(obj: unknown): void
  /** 依 method 自動回覆最近一筆同名請求。 */
  reply(method: string, result: unknown): void
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
    let onExit: (code: number | null) => void = () => {}
    const proc: CodexProcess = {
      write: (line) => { sent.push(JSON.parse(line) as Record<string, unknown>) },
      closeStdin: () => { killed.push('closeStdin') },
      kill: () => { killed.push('kill') },
      onLine: (cb) => { onLine = cb },
      onStderr: (cb) => { onStderr = cb },
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
      exit: (code) => { onExit(code) },
      stderr: (text) => { onStderr(text) },
    }
    return proc
  }
  return { spawn, fake: () => { if (current === null) throw new Error('還沒 spawn'); return current }, cwds }
}

function setup(over: { onApproval?: (kind: string, params: Record<string, unknown>) => Promise<'accept' | 'decline'> } = {}) {
  const s = makeSpawn()
  const errors: string[] = []
  const notes: Array<[string, unknown]> = []
  const exits: Array<number | null> = []
  const client = createCodexClient({
    cwd: '/p/alpha',
    logError: (e) => { errors.push(e.message) },
    onEvents: (method, params) => { notes.push([method, params]) },
    onApproval: over.onApproval ?? (async () => 'accept'),
    onExit: (code) => { exits.push(code) },
    spawn: s.spawn,
    killDelayMs: 5,
  })
  return { ...s, errors, notes, exits, client }
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

  it('initialize 宣告 experimentalApi;thread/start 帶 cwd 與 untrusted 的批准政策', async () => {
    const r = setup()
    await bootstrap(r)
    const init = r.fake().sent.find((s) => s['method'] === 'initialize')!
    expect(init['params']).toMatchObject({ capabilities: { experimentalApi: true } })
    const start = r.fake().sent.find((s) => s['method'] === 'thread/start')!
    expect(start['params']).toMatchObject({ cwd: '/p/alpha', approvalPolicy: 'untrusted' })
  })

  it('帶 threadId 時走 thread/resume,不走 thread/start', async () => {
    const r = setup()
    const p = r.client.start('th-old')
    await vi.waitFor(() => r.fake().reply('initialize', {}))
    await vi.waitFor(() => r.fake().reply('thread/resume', { thread: { id: 'th-old' }, model: 'gpt-6-astra' }))
    expect(await p).toEqual({ threadId: 'th-old', model: 'gpt-6-astra' })
    expect(r.fake().sent.map((s) => s['method'])).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(r.fake().sent.find((s) => s['method'] === 'thread/resume')!['params']).toMatchObject({ threadId: 'th-old', approvalPolicy: 'untrusted' })
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
    expect(r.fake().sent.find((s) => s['id'] === 57)).toMatchObject({ id: 57, result: {} })
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/codex-client.test.ts`
Expected: FAIL,`Cannot find module '../src/main/codex/client.js'`

- [ ] **Step 3: 寫實作**

`src/main/codex/client.ts`:

```ts
/**
 * 一個 codex 對話的子程序生命週期(規格 §5)。
 *
 * 一個對話一個 `codex app-server`,cwd 是專案根目錄。開場固定四步:
 * spawn → `initialize` → `initialized` → `thread/start` 或 `thread/resume`。
 * 收掉時關 stdin、等 2 秒、SIGTERM。
 *
 * 批准與其他 server 請求都在這裡接住:認不得的也一定要回覆,不回覆會讓 codex 的 turn
 * 永遠等下去(見 rpc.ts 的說明)。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createRpc, type CodexIo } from './rpc.js'

/** 子程序的最小介面。真的實作見檔尾的 `nodeSpawnCodex`,測試接假的。 */
export interface CodexProcess {
  write(line: string): void
  closeStdin(): void
  kill(): void
  onLine(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  onExit(cb: (code: number | null) => void): void
}

export type SpawnCodex = (cwd: string) => CodexProcess

export type ApprovalKind = 'command' | 'fileChange'

/** 兩種批准請求的方法名 → 我們自己的分類。 */
export const APPROVAL_METHODS: Readonly<Record<string, ApprovalKind>> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
}

/** codex 要問使用者問題:第一版回空答案並記 log(規格 §3)。 */
const USER_INPUT_METHOD = 'item/tool/requestUserInput'

const DEFAULT_KILL_DELAY_MS = 2000

export interface CodexClientDeps {
  readonly cwd: string
  readonly logError: (error: Error) => void
  /** 每一則通知原樣往上送,由 mapper 決定畫什麼。 */
  readonly onEvents: (method: string, params: unknown) => void
  readonly onApproval: (kind: ApprovalKind, params: Record<string, unknown>) => Promise<'accept' | 'decline'>
  /** 子程序結束(自己死或被我們收掉)。 */
  readonly onExit: (code: number | null) => void
  readonly spawn?: SpawnCodex
  readonly requestTimeoutMs?: number
  readonly killDelayMs?: number
}

export interface CodexClient {
  /** 沒給 threadId 就 `thread/start`,有就 `thread/resume`。 */
  start(threadId?: string): Promise<{ threadId: string; model?: string }>
  send(text: string): Promise<void>
  /** 有進行中的 turn 才送 `turn/interrupt`。 */
  interrupt(): Promise<void>
  teardown(): Promise<void>
  isRunning(): boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `thread/start` 與 `thread/resume` 的回應都是 `{ thread: { id }, model }`。 */
function readThread(result: unknown): { threadId: string; model?: string } | null {
  if (!isRecord(result) || !isRecord(result['thread'])) return null
  const id = result['thread']['id']
  if (typeof id !== 'string' || id === '') return null
  const model = result['model']
  return typeof model === 'string' ? { threadId: id, model } : { threadId: id }
}

export function createCodexClient(deps: CodexClientDeps): CodexClient {
  const spawnCodex = deps.spawn ?? nodeSpawnCodex
  const killDelayMs = deps.killDelayMs ?? DEFAULT_KILL_DELAY_MS
  let proc: CodexProcess | null = null
  let rpc: ReturnType<typeof createRpc> | null = null
  let threadId: string | null = null
  let turnId: string | null = null
  let closing = false

  const handleNotification = (method: string, params: unknown): void => {
    // turn/started 與 turn/completed 兩則我們自己也要看:interrupt 需要現行的 turnId。
    if (method === 'turn/started' && isRecord(params) && isRecord(params['turn'])) {
      const id = params['turn']['id']
      turnId = typeof id === 'string' ? id : null
    }
    if (method === 'turn/completed') turnId = null
    deps.onEvents(method, params)
  }

  const handleServerRequest = async (method: string, params: unknown): Promise<unknown> => {
    const kind = APPROVAL_METHODS[method]
    if (kind !== undefined) {
      const decision = await deps.onApproval(kind, isRecord(params) ? params : {})
      return { decision }
    }
    if (method === USER_INPUT_METHOD) {
      deps.logError(new Error(`codex 送來 ${USER_INPUT_METHOD},第一版回空答案:${JSON.stringify(params).slice(0, 200)}`))
      return {}
    }
    // 認不得的請求交給 rpc 回錯誤(它會記 log)。不回覆會讓 codex 的 turn 永遠等下去。
    throw new Error(`不認得的 codex 請求 ${method}`)
  }

  const detach = (code: number | null): void => {
    const had = proc !== null
    proc = null
    rpc?.rejectAll(new Error(`codex 子程序已結束(code ${code ?? 'null'})`))
    rpc = null
    turnId = null
    if (!had) return
    if (!closing && code !== 0) deps.logError(new Error(`codex 子程序非預期結束,code ${code ?? 'null'}`))
    deps.onExit(code)
  }

  const boot = (): ReturnType<typeof createRpc> => {
    const p = spawnCodex(deps.cwd)
    const io: CodexIo = { write: (line) => { p.write(line) }, onLine: (cb) => { p.onLine(cb) } }
    const r = createRpc(io, deps.logError, deps.requestTimeoutMs)
    r.onNotification(handleNotification)
    r.onServerRequest(handleServerRequest)
    p.onStderr((chunk) => {
      const text = chunk.trim()
      if (text !== '') deps.logError(new Error(`codex stderr:${text.slice(0, 300)}`))
    })
    p.onExit((code) => { detach(code) })
    proc = p
    rpc = r
    return r
  }

  const stop = async (): Promise<void> => {
    const p = proc
    if (p === null) return
    closing = true
    try {
      p.closeStdin()
      await new Promise((resolve) => setTimeout(resolve, killDelayMs))
      p.kill()
    } finally {
      closing = false
      if (proc === p) detach(null)
    }
  }

  return {
    async start(existingThreadId) {
      const r = boot()
      try {
        await r.request('initialize', {
          clientInfo: { name: 'yeschef', title: 'yeschef', version: '0.0.0' },
          capabilities: { experimentalApi: true },
        })
        r.notify('initialized')
        const common = { approvalPolicy: 'untrusted' as const }
        const result = existingThreadId === undefined
          ? await r.request('thread/start', { cwd: deps.cwd, ...common })
          : await r.request('thread/resume', { threadId: existingThreadId, ...common })
        const thread = readThread(result)
        if (thread === null) throw new Error('codex 沒有回 thread id')
        threadId = thread.threadId
        return thread
      } catch (cause) {
        await stop()
        throw cause instanceof Error ? cause : new Error(String(cause))
      }
    },
    async send(text) {
      const r = rpc
      if (r === null || threadId === null) throw new Error('codex 尚未啟動,這則訊息未送出')
      await r.request('turn/start', { threadId, input: [{ type: 'text', text }] })
    },
    async interrupt() {
      const r = rpc
      if (r === null || threadId === null || turnId === null) return
      await r.request('turn/interrupt', { threadId, turnId })
    },
    teardown: stop,
    isRunning: () => proc !== null,
  }
}

/** 真的起一個 `codex app-server`。沒有單元測試,行為靠實機驗收(規格 §8)。 */
export const nodeSpawnCodex: SpawnCodex = (cwd) => {
  const child = nodeSpawn('codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  return {
    write: (line) => { child.stdin?.write(line) },
    closeStdin: () => { child.stdin?.end() },
    kill: () => { child.kill('SIGTERM') },
    onLine: (cb) => { child.stdout?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onStderr: (cb) => { child.stderr?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onExit: (cb) => { child.on('exit', (code) => { cb(code) }) },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/codex-client.test.ts`
Expected: PASS(15 tests)

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/codex/client.ts tests/codex-client.test.ts
git commit -m "feat: codex 子程序的生命週期與批准接線"
```

---

### Task 4: codex 的對話核心

**Files:**
- Create: `src/main/codex/conversation.ts`
- Test: `tests/codex-conversation.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `createCodexMapper`;Task 3 的 `createCodexClient`、`CodexClient`、`SpawnCodex`、`ApprovalKind`。
- Produces:
  - `interface CodexConversationDeps { sink: ConversationSink; cwd: string; logError: (e: Error) => void; onSessionStarted?: (sessionId: string, cwd?: string) => void; onHeldChange?: (count: number) => void; onBusyChange?: (busy: boolean) => void; initialThreadId?: string; approvalTimeoutMs?: number; createRegistry?: typeof createApprovalRegistry; createClient?: typeof createCodexClient; spawn?: SpawnCodex; commandExists?: (command: string) => boolean }`
  - `createCodexConversation(deps: CodexConversationDeps): Conversation`
  - `const MSG_NO_CODEX = 'PATH 找不到 codex,請先安裝'`
  - `const MSG_NOT_LOGGED_IN = 'codex 未登入,請在終端執行 `codex login`'`

狀態比 Claude 那邊簡單:沒有 `session-machine`,只有三種 `SessionState`。`idle` 是還沒開過 thread;
有 threadId 且沒有活著的子程序是 `viewing`;子程序活著是 `live`。

規格沒有寫 codex 的歷史載入(`thread/resume` 的 `initialTurnsPage` 沒用)。重開 app 之後
codex 分頁是空的,狀態 `viewing`,送出下一則訊息才 resume。這是刻意的取捨,寫進規格修訂紀錄。

- [ ] **Step 1: 寫失敗測試**

`tests/codex-conversation.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createCodexConversation, MSG_NOT_LOGGED_IN, MSG_NO_CODEX } from '../src/main/codex/conversation.js'
import { createApprovalRegistry, type ApprovalRequest } from '../src/main/approval.js'
import type { CodexClient, ApprovalKind } from '../src/main/codex/client.js'
import type { Event } from '../src/shared/events.js'
import type { ConversationSink } from '../src/main/conversation.js'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Rig {
  readonly core: ReturnType<typeof createCodexConversation>
  readonly calls: string[]
  readonly events: Event[]
  readonly states: string[]
  readonly asks: ApprovalRequest[]
  readonly errors: string[]
  readonly heldCounts: number[]
  readonly busy: boolean[]
  readonly started: Array<[string, string | undefined]>
  /** 假 client 收到的通知處理器,用來灌 codex 的通知。 */
  notify(method: string, params: unknown): void
  /** 觸發一次批准請求,回傳 codex 會收到的 decision。 */
  approve(kind: ApprovalKind, params: Record<string, unknown>): Promise<'accept' | 'decline'>
  failStart(message: string): void
}

function setup(options: { initialThreadId?: string; commandExists?: boolean } = {}): Rig {
  const calls: string[] = []
  const events: Event[] = []
  const states: string[] = []
  const asks: ApprovalRequest[] = []
  const errors: string[] = []
  const heldCounts: number[] = []
  const busy: boolean[] = []
  const started: Array<[string, string | undefined]> = []
  let onEvents: (method: string, params: unknown) => void = () => {}
  let onApproval: (kind: ApprovalKind, params: Record<string, unknown>) => Promise<'accept' | 'decline'> = async () => 'decline'
  let startError: string | null = null
  let running = false

  const sink: ConversationSink = {
    events: (batch) => { events.push(...batch); calls.push(`events(${batch.map((e) => e.kind).join(',')})`) },
    state: (s) => { states.push(s.kind); calls.push(`state(${s.kind})`) },
    approvalAsk: (payload) => { asks.push(payload); calls.push(`ask(${payload.toolUseId})`) },
    approvalSettled: (id) => { calls.push(`settled(${id})`) },
  }

  const core = createCodexConversation({
    sink,
    cwd: '/p/alpha',
    logError: (e) => { errors.push(e.message) },
    onSessionStarted: (id, cwd) => { started.push([id, cwd]) },
    onHeldChange: (n) => { heldCounts.push(n) },
    onBusyChange: (b) => { busy.push(b) },
    ...(options.initialThreadId === undefined ? {} : { initialThreadId: options.initialThreadId }),
    approvalTimeoutMs: 60_000,
    createRegistry: createApprovalRegistry,
    commandExists: () => options.commandExists ?? true,
    createClient: (d) => {
      onEvents = d.onEvents
      onApproval = d.onApproval
      const client: CodexClient = {
        start: async (threadId) => {
          calls.push(`start(${threadId ?? '-'})`)
          if (startError !== null) throw new Error(startError)
          running = true
          return { threadId: threadId ?? 'th-new', model: 'gpt-6-astra' }
        },
        send: async (text) => { calls.push(`send(${text})`) },
        interrupt: async () => { calls.push('interrupt') },
        teardown: async () => { calls.push('teardown'); running = false },
        isRunning: () => running,
      }
      return client
    },
  })

  return {
    core, calls, events, states, asks, errors, heldCounts, busy, started,
    notify: (method, params) => { onEvents(method, params) },
    approve: (kind, params) => onApproval(kind, params),
    failStart: (message) => { startError = message },
  }
}

describe('第一則訊息', () => {
  it('start 之後 send;畫面有使用者的話與 session-start,狀態轉 live', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.calls.filter((c) => c.startsWith('start') || c.startsWith('send'))).toEqual(['start(-)', 'send(你好)'])
    // activate() 會先 replay 一個空 log,也就是一則 reset(與 Claude 那條路一致)。
    expect(r.events.map((e) => e.kind)).toEqual(['reset', 'user-text', 'session-start'])
    expect(r.events[2]).toEqual({ kind: 'session-start', sessionId: 'th-new', cwd: '/p/alpha', model: 'gpt-6-astra' })
    expect(r.states.at(-1)).toBe('live')
    expect(r.busy).toEqual([true])
  })

  it('threadId 記進 onSessionStarted,路由器才存得進 thread', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.started).toEqual([['th-new', '/p/alpha']])
  })

  it('第二則訊息不再 start,直接 send', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('一')
    await flush()
    r.core.userInput('二')
    await flush()
    expect(r.calls.filter((c) => c.startsWith('start'))).toEqual(['start(-)'])
    expect(r.calls.filter((c) => c.startsWith('send'))).toEqual(['send(一)', 'send(二)'])
  })

  it('重開 app:帶 initialThreadId 時狀態是 viewing,第一則訊息走 resume', async () => {
    const r = setup({ initialThreadId: 'th-old' })
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-old' })
    r.core.activate()
    r.core.userInput('接續')
    await flush()
    expect(r.calls.filter((c) => c.startsWith('start'))).toEqual(['start(th-old)'])
  })

  it('PATH 沒有 codex:不 spawn,畫面出錯誤,busy 解除', async () => {
    const r = setup({ commandExists: false })
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.calls.some((c) => c.startsWith('start'))).toBe(false)
    expect(r.events.at(-1)).toEqual({ kind: 'session-end', isError: true, errorMessage: MSG_NO_CODEX })
    expect(r.busy).toEqual([true, false])
  })

  it('未登入:thread/start 失敗時畫面出可讀的錯誤', async () => {
    const r = setup()
    r.failStart('thread/start:{"message":"not logged in"}')
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    const last = r.events.at(-1)
    expect(last?.kind).toBe('session-end')
    expect(last).toMatchObject({ isError: true })
    expect((last as { errorMessage?: string }).errorMessage).toContain(MSG_NOT_LOGGED_IN)
    expect(r.core.isBusy()).toBe(false)
  })
})

describe('通知翻成事件', () => {
  it('codex 的通知經 mapper 進畫面', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.notify('item/agentMessage/delta', { itemId: 'i1', delta: '嗨', threadId: 't', turnId: 'u' })
    r.notify('item/completed', { item: { type: 'agentMessage', id: 'i1', text: '嗨' }, threadId: 't', turnId: 'u', completedAtMs: 1 })
    expect(r.events.map((e) => e.kind)).toContain('text-delta')
    expect(r.events.map((e) => e.kind)).toContain('text')
  })

  it('turn/completed 讓 busy 解除', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    expect(r.core.isBusy()).toBe(true)
    r.notify('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })
    expect(r.core.isBusy()).toBe(false)
    expect(r.busy).toEqual([true, false])
  })

  it('背景時事件記進 log 不送出,切回前景重播', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const before = r.events.length
    r.notify('item/completed', { item: { type: 'agentMessage', id: 'i9', text: '背景講的話' }, threadId: 't', turnId: 'u', completedAtMs: 1 })
    expect(r.events.length).toBe(before)
    r.core.activate()
    expect(r.events.some((e) => e.kind === 'text' && (e as { text: string }).text === '背景講的話')).toBe(true)
    expect(r.events[before]).toEqual({ kind: 'reset' })
  })
})

describe('批准', () => {
  const cmdParams = { itemId: 'c1', threadId: 't', turnId: 'u', startedAtMs: 1, command: 'rm x', cwd: '/p', reason: '要刪檔' }

  it('前景:commandExecution 送批准卡,欄位是 Bash 與指令', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    const decision = r.approve('command', cmdParams)
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.asks[0]).toMatchObject({ toolUseId: 'c1', toolName: 'Bash', input: { command: 'rm x', cwd: '/p', reason: '要刪檔' } })
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    expect(await decision).toBe('accept')
  })

  it('fileChange 的卡片是 Edit,input 只有 reason(請求本身沒有 changes)', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    const decision = r.approve('fileChange', { itemId: 'f1', threadId: 't', turnId: 'u', startedAtMs: 1, reason: '改檔' })
    await flush()
    expect(r.asks[0]).toMatchObject({ toolUseId: 'f1', toolName: 'Edit', input: { reason: '改檔' } })
    r.core.approvalReply(r.asks[0]!.requestId, 'deny')
    expect(await decision).toBe('decline')
  })

  it('背景:批准扣住不送卡,heldApprovals 加一;切回前景才送出', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const decision = r.approve('command', cmdParams)
    await flush()
    expect(r.asks).toHaveLength(0)
    expect(r.core.heldApprovals()).toBe(1)
    expect(r.heldCounts).toEqual([1])
    r.core.activate()
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.core.heldApprovals()).toBe(0)
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    expect(await decision).toBe('accept')
  })

  it('逾時回 decline', async () => {
    vi.useFakeTimers()
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await vi.advanceTimersByTimeAsync(0)
    const decision = r.approve('command', cmdParams)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await decision).toBe('decline')
    vi.useRealTimers()
  })
})

describe('其他動作', () => {
  it('startNew:收掉子程序、清畫面、狀態回 idle', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.startNew()
    await flush()
    expect(r.calls).toContain('teardown')
    expect(r.events.at(-1)).toEqual({ kind: 'reset' })
    expect(r.core.sessionState()).toEqual({ kind: 'idle' })
    expect(r.core.isBusy()).toBe(false)
  })

  it('deactivate:回合已結束就收掉子程序;回合進行中等它結束', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    await flush()
    expect(r.calls.filter((c) => c === 'teardown')).toEqual([])
    r.notify('turn/completed', { threadId: 't', turn: { id: 'u', status: 'completed' } })
    await flush()
    expect(r.calls).toContain('teardown')
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 'th-new' })
  })

  it('openHistory 與 handoffDone 記錯誤,不做事', () => {
    const r = setup()
    r.core.openHistory('s-1')
    r.core.handoffDone('t-1')
    expect(r.errors).toHaveLength(2)
    expect(r.errors[0]).toContain('歷史')
    expect(r.errors[1]).toContain('交接')
  })

  it('dispose:有進行中的回合先 interrupt 再收掉,扣住的批准以 deny 收尾', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const decision = r.approve('command', { itemId: 'c1', threadId: 't', turnId: 'u', startedAtMs: 1, command: 'x', cwd: '/p' })
    await flush()
    await r.core.dispose()
    expect(r.calls).toContain('interrupt')
    expect(r.calls).toContain('teardown')
    expect(await decision).toBe('decline')
  })

  it('replay 在背景不動作', async () => {
    const r = setup()
    r.core.activate()
    r.core.userInput('你好')
    await flush()
    r.core.deactivate()
    const before = r.events.length
    r.core.replay()
    expect(r.events.length).toBe(before)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/codex-conversation.test.ts`
Expected: FAIL,`Cannot find module '../src/main/codex/conversation.js'`

- [ ] **Step 3: 寫實作**

`src/main/codex/conversation.ts`:

```ts
/**
 * codex 對話核心:對外與 Claude 那邊同一個 `Conversation` 介面(規格 §1),
 * 路由器不必知道底下是哪一種。
 *
 * 狀態比 Claude 簡單,沒有 session-machine:`idle` 是還沒開過 thread;有 threadId 但
 * 子程序不在是 `viewing`;子程序活著是 `live`。歷史不從 codex 載入(規格沒有寫這一段),
 * 所以重開 app 之後這個分頁是空的,送出下一則訊息才 `thread/resume`。
 */
import { accessSync, constants } from 'node:fs'
import type { Event } from '../../shared/events.js'
import type { SessionState } from '../../shared/session-state.js'
import { appendEvents } from '../../shared/event-log.js'
import {
  createApprovalRegistry,
  type ApprovalAsk,
  type ApprovalDecision,
  type ApprovalOutcome,
} from '../approval.js'
import { DEFAULT_MERGE_CONFIG, INITIAL_MERGE_STATE, asError, mergeAccept, mergeFlush } from '../agent-host.js'
import type { Conversation, ConversationSink } from '../conversation.js'
import { createCodexMapper } from './mapper.js'
import { createCodexClient, type ApprovalKind, type CodexClient, type SpawnCodex } from './client.js'

export const MSG_NO_CODEX = 'PATH 找不到 codex,請先安裝'
export const MSG_NOT_LOGGED_IN = 'codex 未登入,請在終端執行 `codex login`'
const MSG_WINDOW_CLOSED = '視窗已關閉'
const RESET: Event = { kind: 'reset' }

/** codex 回的錯誤裡出現這些字就當成未登入。 */
const NOT_LOGGED_IN_HINTS = ['not logged in', 'unauthorized', 'login']

export interface CodexConversationDeps {
  readonly sink: ConversationSink
  /** 專案根目錄,子程序的 cwd。 */
  readonly cwd: string
  readonly logError: (error: Error) => void
  readonly onSessionStarted?: (sessionId: string, cwd?: string) => void
  readonly onHeldChange?: (count: number) => void
  readonly onBusyChange?: (busy: boolean) => void
  /** 重開 app 時狀態檔記的 threadId。 */
  readonly initialThreadId?: string
  readonly approvalTimeoutMs?: number
  readonly createRegistry?: typeof createApprovalRegistry
  readonly createClient?: typeof createCodexClient
  readonly spawn?: SpawnCodex
  readonly commandExists?: (command: string) => boolean
}

interface HeldAsk {
  readonly ask: ApprovalAsk
  readonly resolve: (outcome: ApprovalOutcome) => void
}

/** PATH 裡有沒有這個指令。與 terminal-server 的判斷同一個做法。 */
function realCommandExists(command: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue
    try {
      accessSync(`${dir}/${command}`, constants.X_OK)
      return true
    } catch {
      // 這個目錄沒有,看下一個。
    }
  }
  return false
}

function startFailureMessage(error: Error): string {
  // 規格 §7:PATH 找不到 codex 的訊息就是那一句,不加前綴。
  if (error.message === MSG_NO_CODEX) return MSG_NO_CODEX
  const lower = error.message.toLowerCase()
  return NOT_LOGGED_IN_HINTS.some((h) => lower.includes(h))
    ? `${MSG_NOT_LOGGED_IN}(${error.message})`
    : `codex 啟動失敗:${error.message}`
}

export function createCodexConversation(deps: CodexConversationDeps): Conversation {
  const makeClient = deps.createClient ?? createCodexClient
  const commandExists = deps.commandExists ?? realCommandExists
  const mapper = createCodexMapper()

  let state: SessionState =
    deps.initialThreadId === undefined ? { kind: 'idle' } : { kind: 'viewing', sessionId: deps.initialThreadId }
  let threadId: string | null = deps.initialThreadId ?? null
  let active = false
  let disposed = false
  let busy = false
  let sleepPending = false
  let log: readonly Event[] = []
  let held: readonly HeldAsk[] = []
  let client: CodexClient | null = null
  /** 動作串行鏈,與 Claude 那邊同一個規則:同一份對話的非同步動作不交錯。 */
  let pending: Promise<void> = Promise.resolve()

  const registry = (deps.createRegistry ?? createApprovalRegistry)({
    timeoutMs: deps.approvalTimeoutMs,
    sendRequest: (request) => { deps.sink.approvalAsk(request) },
    onSettled: (requestId) => { deps.sink.approvalSettled(requestId) },
  })

  const emit = (batch: readonly Event[]): void => { if (active) deps.sink.events(batch) }
  const emitState = (next: SessionState): void => { if (active) deps.sink.state(next) }
  const setState = (next: SessionState): void => { state = next; emitState(next) }
  const pushBatch = (events: readonly Event[]): void => {
    if (events.length === 0) return
    log = appendEvents(log, events)
    emit(events)
  }
  const chunked = (events: readonly Event[], out: (batch: readonly Event[]) => void): void => {
    const accepted = mergeAccept(INITIAL_MERGE_STATE, events, 0, DEFAULT_MERGE_CONFIG)
    const rest = mergeFlush(accepted.state)
    for (const batch of accepted.batches) out(batch)
    for (const batch of rest.batches) out(batch)
  }
  const setBusy = (next: boolean): void => {
    if (busy === next) return
    busy = next
    deps.onBusyChange?.(next)
  }
  const setHeld = (next: readonly HeldAsk[]): void => {
    const changed = next.length !== held.length
    held = next
    if (changed) deps.onHeldChange?.(held.length)
  }
  const releaseHeld = (): void => {
    const toSubmit = held
    setHeld([])
    for (const item of toSubmit) {
      registry.request(item.ask).then(item.resolve, (err: unknown) => {
        deps.logError(asError(err, 'held-approval'))
        item.resolve({ decision: 'deny', reason: '批准送出失敗' })
      })
    }
  }
  const denyHeld = (reason: string): void => {
    const toDeny = held
    setHeld([])
    for (const item of toDeny) item.resolve({ decision: 'deny', reason })
  }

  const teardownClient = async (): Promise<void> => {
    const c = client
    client = null
    if (c === null) return
    await c.teardown()
  }

  /** 回合結束:解除 busy;切走時等的 sleep 在這裡補做(規格 §5)。 */
  const turnEnded = (): void => {
    setBusy(false)
    if (!sleepPending) return
    sleepPending = false
    pending = pending.then(async () => {
      await teardownClient()
      if (threadId !== null) setState({ kind: 'viewing', sessionId: threadId })
    }).catch((err: unknown) => deps.logError(asError(err, 'codex-sleep')))
  }

  const onEvents = (method: string, params: unknown): void => {
    const events = mapper.accept(method, params)
    pushBatch(events)
    if (events.some((e) => e.kind === 'session-end')) turnEnded()
  }

  const onApproval = async (kind: ApprovalKind, params: Record<string, unknown>): Promise<'accept' | 'decline'> => {
    const itemId = typeof params['itemId'] === 'string' ? params['itemId'] : ''
    const ask: ApprovalAsk = kind === 'command'
      ? {
          toolUseId: itemId,
          toolName: 'Bash',
          input: { command: params['command'], cwd: params['cwd'], reason: params['reason'] },
        }
      : {
          // fileChange 的請求本身不帶 changes,那些在 item/started 已經畫進 tool block 了。
          toolUseId: itemId,
          toolName: 'Edit',
          input: { reason: params['reason'] },
        }
    const outcome = active
      ? await registry.request(ask)
      : await new Promise<ApprovalOutcome>((resolve) => { setHeld([...held, { ask, resolve }]) })
    // 拒絕與逾時都送 decline:cancel 會中斷整個 turn(規格 §3)。
    return outcome.decision === 'allow' ? 'accept' : 'decline'
  }

  const ensureClient = async (): Promise<CodexClient> => {
    const existing = client
    if (existing !== null && existing.isRunning()) return existing
    if (!commandExists('codex')) throw new Error(MSG_NO_CODEX)
    const created = makeClient({
      cwd: deps.cwd,
      logError: deps.logError,
      onEvents,
      onApproval,
      onExit: (code) => {
        client = null
        if (busy) {
          pushBatch([{ kind: 'session-end', isError: true, errorMessage: `codex 子程序結束,code ${code ?? 'null'}` }])
          turnEnded()
        }
      },
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    })
    client = created
    const result = await created.start(threadId ?? undefined)
    threadId = result.threadId
    pushBatch([{
      kind: 'session-start',
      sessionId: result.threadId,
      cwd: deps.cwd,
      ...(result.model === undefined ? {} : { model: result.model }),
    }])
    deps.onSessionStarted?.(result.threadId, deps.cwd)
    setState({ kind: 'live', sessionId: result.threadId })
    return created
  }

  const userInput = (text: string): void => {
    if (disposed) return
    pushBatch([{ kind: 'user-text', text }])
    setBusy(true)
    pending = pending.then(async () => {
      try {
        const c = await ensureClient()
        await c.send(text)
      } catch (cause) {
        const error = asError(cause, 'codex-input')
        deps.logError(error)
        pushBatch([{ kind: 'session-end', isError: true, errorMessage: startFailureMessage(error) }])
        setBusy(false)
        await teardownClient()
        if (threadId !== null) setState({ kind: 'viewing', sessionId: threadId })
      }
    }).catch((err: unknown) => deps.logError(asError(err, 'codex-input')))
  }

  const replay = (): void => {
    if (!active) return
    chunked([RESET, ...log], (batch) => { deps.sink.events(batch) })
    deps.sink.state(state)
  }

  return {
    userInput,
    approvalReply(requestId, decision: ApprovalDecision) {
      if (registry.reply(requestId, decision)) return
      deps.logError(new Error(`codex 對話:找不到批准 ${requestId},可能已逾時`))
    },
    startNew() {
      setBusy(false)
      sleepPending = false
      log = []
      threadId = null
      pushBatch([RESET])
      setState({ kind: 'idle' })
      pending = pending.then(teardownClient).catch((err: unknown) => deps.logError(asError(err, 'codex-start-new')))
    },
    openHistory(sessionId) {
      deps.logError(new Error(`codex 對話不支援開啟歷史對話(${sessionId})`))
    },
    handoffDone(toolUseId) {
      deps.logError(new Error(`codex 對話沒有交接卡(${toolUseId})`))
    },
    activate() {
      if (active || disposed) return
      active = true
      sleepPending = false
      replay()
      releaseHeld()
    },
    deactivate() {
      if (!active) return
      active = false
      if (client === null) return
      if (busy) { sleepPending = true; return }
      pending = pending.then(async () => {
        await teardownClient()
        if (threadId !== null) setState({ kind: 'viewing', sessionId: threadId })
      }).catch((err: unknown) => deps.logError(asError(err, 'codex-deactivate')))
    },
    replay,
    isActive: () => active,
    heldApprovals: () => held.length,
    isBusy: () => busy,
    sessionState: () => state,
    async dispose() {
      disposed = true
      active = false
      denyHeld(MSG_WINDOW_CLOSED)
      registry.denyAll(MSG_WINDOW_CLOSED)
      pending = pending.then(async () => {
        const c = client
        if (c !== null && busy) await c.interrupt()
        await teardownClient()
      }).catch((err: unknown) => deps.logError(asError(err, 'codex-dispose')))
      await pending
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/codex-conversation.test.ts`
Expected: PASS(18 tests)

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/codex/conversation.ts tests/codex-conversation.test.ts
git commit -m "feat: codex 對話核心,對外與 Claude 同一個介面"
```

---

### Task 5: 路由器依 provider 選工廠

**Files:**
- Modify: `src/main/ipc-bridge.ts`
- Test: `tests/ipc-bridge.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `createCodexConversation`、`CodexConversationDeps`。
- Produces:
  - `IpcBridgeDeps.createCodexConversation?: typeof createCodexConversation`(測試接縫)
  - `Slot.runtime` 改成選填:codex 對話沒有 `sessionOptions`,也沒有右窗格 MCP server(規格 §0 不做)。

- [ ] **Step 1: 寫失敗測試**

`tests/ipc-bridge.test.ts` 的 `makeRig` 加一個假的 codex 工廠。在 `const bridge = createIpcBridge({` 的 deps 裡,`createConversation` 之後加:

```ts
    createCodexConversation: (d) => {
      const tag = codexTags.get(d.cwd) ?? 'codex-unknown'
      const fake = makeFakeCore(tag, { ...d, sessionOptions: () => ({}) } as unknown as ConversationDeps, record, slowDispose)
      fakes.set(tag, fake)
      created.push(tag)
      codexDeps.set(tag, d)
      return fake.core
    },
```

在 `makeRig` 開頭(`const byOptions = ...` 附近)加:

```ts
  /** codex 的假 core 沒有 sessionOptions 可以認,改用 cwd 對到分頁 id。 */
  const codexTags = new Map<string, string>()
  const codexDeps = new Map<string, CodexConversationDeps>()
```

並在回傳物件加 `codexTags, codexDeps`。import 加 `type CodexConversationDeps` 自 `../src/main/codex/conversation.js`。

新增 describe:

```ts
describe('codex 對話分頁', () => {
  const withCodex = (): ProjectsState =>
    openConversationTab(twoProjects(), A, { tabId: 'tab-ax', threadId: 'th-ax', provider: 'codex' }, NOW + 1)

  it('provider 為 codex 的分頁用 codex 工廠,cwd 是專案根目錄,不呼叫 runtimeFor', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    const d = rig.codexDeps.get('tab-ax')
    expect(d?.cwd).toBe('/private/tmp/alpha')
    expect(d?.initialThreadId).toBeUndefined()
  })

  it('codex 對話的事件與批准一樣帶 conversationId 與 projectId', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    const fake = rig.fake('tab-ax')
    fake.deps.sink.events([{ kind: 'user-text', text: '甲' }])
    expect(rig.lastSent.get(IPC.eventsBatch)).toEqual({ conversationId: 'tab-ax', events: [{ kind: 'user-text', text: '甲' }] })
    fake.deps.sink.approvalAsk({ requestId: 'r1', toolUseId: 't1', toolName: 'Bash', input: {} })
    expect(rig.lastSent.get(IPC.approvalAsk)).toEqual({
      requestId: 'r1', toolUseId: 't1', toolName: 'Bash', input: {}, projectId: A, conversationId: 'tab-ax',
    })
  })

  it('codex 分頁的 threadId 存進 thread,重建時當成 initialThreadId', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.codexDeps.get('tab-ax')?.onSessionStarted?.('codex-thread-1', '/private/tmp/alpha')
    const a = findProject(rig.service.state(), A)!
    expect(lastSessionId(a, 'tab-ax')).toBe('codex-thread-1')
  })

  it('codex slot 收掉時不會去拆不存在的 runtime', async () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.log.length = 0
    rig.service.update((s) => closeTab(s, A, 'tab-ax', NOW + 4))
    await tick()
    expect(rig.log).toContain('tab-ax.dispose')
    expect(rig.log.some((l) => l.includes('tab-ax.runtime.dispose'))).toBe(false)
    expect(rig.errors).toEqual([])
  })
})
```

`openConversationTab` 的第三個參數多了 `provider`,由 Task 6 提供;這個 task 先照新簽名寫測試,Task 6 之前 typecheck 會紅是預期的。**為了讓兩個 task 各自可獨立驗收,把 `provider` 加進 `openConversationTab` 的工作移到這個 task 的 Step 3。**

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: FAIL,`openConversationTab` 不吃 `provider`、`createCodexConversation` 不是合法的 dep

- [ ] **Step 3: reducer 收 provider**

`src/shared/projects.ts`:`CONVERSATION_TAB_LABEL` 之後加

```ts
export const CODEX_CONVERSATION_TAB_LABEL = 'codex 對話'
```

`src/main/projects-state.ts`:

```ts
export interface NewConversationInput {
  readonly tabId: string
  readonly threadId: string
  /** 缺就是 'claude'。 */
  readonly provider?: Provider
}
```

`nextConversationLabel` 改成依 provider 各自編號(兩種 provider 的分頁各自從 1 數起):

```ts
function nextConversationLabel(p: ProjectEntry, provider: Provider): string {
  const base = provider === 'codex' ? CODEX_CONVERSATION_TAB_LABEL : CONVERSATION_TAB_LABEL
  const sameProvider = conversationTabs(p).filter((t) => (t.provider ?? 'claude') === provider)
  if (sameProvider.length === 0) return base
  const used = sameProvider.map((t) => {
    if (t.label === base) return 1
    const m = new RegExp(`^${base} (\\d+)$`).exec(t.label)
    return m === null ? 1 : Number(m[1])
  })
  return `${base} ${Math.max(...used) + 1}`
}
```

`openConversationTab` 內:`const provider = input.provider ?? 'claude'`,`label: nextConversationLabel(p, provider)`,`provider`。import 加 `CODEX_CONVERSATION_TAB_LABEL` 與 `type Provider`。

`tests/projects-state.test.ts` 加:

```ts
describe('openConversationTab 的 provider', () => {
  it('codex 分頁的標籤與 provider 分開編號', () => {
    const s1 = openConversationTab(two, 'a', { tabId: 'a-x1', threadId: 'a-t1', provider: 'codex' }, 300)
    expect(findProject(s1, 'a')!.tabs.at(-1)).toMatchObject({ label: 'codex 對話', provider: 'codex' })
    const s2 = openConversationTab(s1, 'a', { tabId: 'a-x2', threadId: 'a-t2', provider: 'codex' }, 400)
    expect(findProject(s2, 'a')!.tabs.at(-1)).toMatchObject({ label: 'codex 對話 2', provider: 'codex' })
    const s3 = openConversationTab(s2, 'a', { tabId: 'a-c2', threadId: 'a-t3' }, 500)
    expect(findProject(s3, 'a')!.tabs.at(-1)).toMatchObject({ label: 'Claude 對話 2', provider: 'claude' })
  })
})
```

- [ ] **Step 4: 路由器選工廠**

`src/main/ipc-bridge.ts`:

- import 加 `import { createCodexConversation as defaultCreateCodexConversation } from './codex/conversation.js'`。
- `IpcBridgeDeps` 在 `createConversation` 之後加:

```ts
  /** 測試用接縫:換掉 codex 的對話核心。 */
  readonly createCodexConversation?: typeof defaultCreateCodexConversation
```

- `Slot` 的 `runtime` 改選填:

```ts
interface Slot {
  readonly core: Conversation
  /** codex 對話沒有 runtime:它不用 SessionOptions,也沒有右窗格 MCP server(5b 規格 §0)。 */
  readonly runtime?: ProjectRuntime
  readonly projectId: string
  readonly rootPath: string
}
```

- `createSlot` 的開頭抽出共用的 sink,再依 provider 分兩條:

```ts
  const createSlot = (conversationId: string, projectId: string, rootPath: string): Slot => {
    const entry = findProject(deps.projects.state(), projectId)
    // 規格 §5:狀態檔裡的分頁指到不存在的 thread,記錯誤;那個分頁當新對話(initialSessionId 為 undefined)。
    if (entry !== undefined && currentThread(entry, conversationId) === undefined) {
      deps.logError(new Error(`對話分頁 ${conversationId} 指到不存在的 thread，當成新對話`))
    }
    const initialSessionId = entry === undefined ? undefined : lastSessionId(entry, conversationId)
    const sink: ConversationSink = {
      // conversationId 與 projectId 在這裡補:core 不知道自己是誰,router 知道。
      events: (events: readonly Event[]) => {
        const payload: EventsBatchPayload = { conversationId, events }
        sendBestEffort(IPC.eventsBatch, payload)
      },
      state: (state: SessionState) => {
        const payload: SessionStatePayload = { conversationId, state }
        sendBestEffort(IPC.sessionState, payload)
      },
      approvalAsk: (request) => {
        const payload: ApprovalAskPayload = { ...request, projectId, conversationId }
        sendOrThrow(IPC.approvalAsk, payload)
      },
      approvalSettled: (requestId) => sendBestEffort(IPC.approvalSettled, { requestId }),
    }
    const common = {
      sink,
      logError: deps.logError,
      onSessionStarted: (sessionId: string, cwd?: string) => recordStarted(conversationId, projectId, sessionId, cwd),
      onHeldChange: pushProjects,
      onBusyChange: pushProjects,
      approvalTimeoutMs: deps.approvalTimeoutMs,
      createRegistry: deps.createRegistry,
    }

    const tab = entry?.tabs.find((t) => t.id === conversationId)
    if ((tab?.provider ?? 'claude') === 'codex') {
      const makeCodex = deps.createCodexConversation ?? defaultCreateCodexConversation
      const core = makeCodex({
        ...common,
        cwd: rootPath,
        ...(initialSessionId === undefined ? {} : { initialThreadId: initialSessionId }),
      })
      return { core, projectId, rootPath }
    }

    const runtime = deps.runtimeFor(projectId, rootPath, () => currentId === conversationId, conversationId)
    const make = deps.createConversation ?? defaultCreateConversation
    const core = make({
      ...common,
      sessionOptions: runtime.sessionOptions,
      loadHistory: (sessionId) => deps.sessions.loadHistory(sessionId),
      initialSessionId,
      viewTools: runtime.viewTools,
      queryFn: deps.queryFn,
      createHost: deps.createHost,
    })
    return { core, runtime, projectId, rootPath }
  }
```

- `ConversationSink` 的型別要 import:`import { createConversation as defaultCreateConversation, type Conversation, type ConversationSink, type ViewToolHooks } from './conversation.js'`。
- `switchTo` 的 `prev.runtime.viewTools?.abortPending(...)` 改成 `prev.runtime?.viewTools?.abortPending(...)`。
- `closeSlot` 的 `slot.runtime.dispose?.()` 改成 `slot.runtime?.dispose?.()`。

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/projects.ts src/main/projects-state.ts src/main/ipc-bridge.ts tests/projects-state.test.ts tests/ipc-bridge.test.ts
git commit -m "feat: 路由器依分頁的 provider 決定用哪一種對話核心"
```

---

### Task 6: 開 codex 對話的入口

**Files:**
- Modify: `src/shared/projects.ts`、`src/shared/ipc.ts`、`src/preload/bridge.ts`、`src/main/projects-ipc.ts`、`src/renderer/hooks/useProjects.ts`、`src/renderer/components/LeftPane.tsx`、`src/renderer/components/ConversationPane.tsx`、`src/renderer/App.tsx`
- Test: `tests/projects-shared.test.ts`、`tests/preload-bridge.test.ts`、`tests/projects-ipc.test.ts`、`tests/use-projects.test.tsx`、`tests/left-pane.test.tsx`、`tests/conversation-pane.test.tsx`、`tests/helpers/fake-yeschef.ts`

**Interfaces:**
- Consumes: Task 5 的 `NewConversationInput.provider`、`CODEX_CONVERSATION_TAB_LABEL`。
- Produces:
  - `ConversationOpenPayload { projectId: string; provider: Provider }`
  - `YesChefApi.openConversation(projectId: string, provider: Provider): void`
  - `Projects.openConversation(provider?: Provider): void`(缺省 `'claude'`)
  - `LeftPane` 的 `NEW_CODEX_CONVERSATION_LABEL = '新 codex 對話'`
  - `ConversationPaneProps.provider: Provider`

- [ ] **Step 1: 寫失敗測試**

`tests/projects-shared.test.ts` 的 `parseConversationOpen` 測試改成:

```ts
describe('parseConversationOpen', () => {
  it('接受兩種 provider,丟掉多餘欄位', () => {
    expect(parseConversationOpen({ projectId: 'p', provider: 'claude', extra: 1 })).toEqual({ projectId: 'p', provider: 'claude' })
    expect(parseConversationOpen({ projectId: 'p', provider: 'codex' })).toEqual({ projectId: 'p', provider: 'codex' })
  })
  it('缺 provider 或不認得的值就拒絕', () => {
    expect(parseConversationOpen({ projectId: 'p' })).toBeNull()
    expect(parseConversationOpen({ projectId: 'p', provider: 'gemini' })).toBeNull()
    expect(parseConversationOpen({ projectId: '', provider: 'claude' })).toBeNull()
  })
})
```

`tests/preload-bridge.test.ts` 的 `openConversation` 測試改成:

```ts
  it('openConversation 送 conversations:open,payload 有 projectId 與 provider', async () => {
    const api = await loadBridge()
    api.openConversation('p-1', 'codex')
    expect(sent.at(-1)).toEqual({ channel: 'conversations:open', payload: { projectId: 'p-1', provider: 'codex' } })
  })
```

`tests/projects-ipc.test.ts` 的 `conversations:open` describe 加:

```ts
  it('provider codex:分頁標籤是 codex 對話,provider 存進狀態檔', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'codex' })
    const entry = findProject(rig.service.state(), A)
    expect(entry?.tabs.at(-1)).toMatchObject({ label: 'codex 對話', provider: 'codex' })
  })
```

既有那幾條 `rig.fire(IPC.conversationsOpen, { projectId: A })` 全部改成帶 `provider: 'claude'`;
`'payload 形狀不符'` 那條(送字串 `'nope'`)不動,另加一條缺 provider 的:

```ts
  it('缺 provider:記錯誤,state 不變', () => {
    const rig = makeRig(oneProject())
    const before = rig.service.state()
    rig.fire(IPC.conversationsOpen, { projectId: A })
    expect(rig.errors).toEqual(['conversations:open：payload 形狀不符（object），已丟棄'])
    expect(rig.service.state()).toBe(before)
  })
```

`tests/use-projects.test.tsx` 的 openConversation 測試改成:

```ts
    act(() => { result.current.openConversation() })
    expect(calls).toContain('openConversation:a:claude')
    act(() => { result.current.openConversation('codex') })
    expect(calls).toContain('openConversation:a:codex')
```

`tests/helpers/fake-yeschef.ts`:`api.openConversation` 改成 `(projectId, provider) => { calls.push(\`openConversation:${projectId}:${provider}\`) }`;`fakeProjects` 的假物件改成 `openConversation: (provider) => { calls.push(\`openConversation:${provider ?? 'claude'}\`) }`。

`tests/left-pane.test.tsx` 的「新對話」測試期望改成 `['openConversation:claude']`,並加:

```ts
  it('「新 codex 對話」按鈕帶 codex', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    fireEvent.click(screen.getByRole('button', { name: NEW_CODEX_CONVERSATION_LABEL }))
    expect(calls).toEqual(['openConversation:codex'])
  })
```

import 加 `NEW_CODEX_CONVERSATION_LABEL`。

`tests/conversation-pane.test.tsx` 加:

```ts
  it('codex 對話不畫 Recents 側欄,claude 的照畫', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container, rerender } = render(
      <ConversationPane api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
    )
    expect(container.querySelector('.sidebar')).not.toBeNull()
    rerender(
      <ConversationPane api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />
    )
    expect(container.querySelector('.sidebar')).toBeNull()
    expect(container.querySelector('.composer-input')).not.toBeNull()
  })
```

既有兩條 `ConversationPane` 測試補 `provider="claude"`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-shared.test.ts tests/preload-bridge.test.ts tests/projects-ipc.test.ts tests/left-pane.test.tsx tests/conversation-pane.test.tsx`
Expected: FAIL,`provider` 不是合法參數、找不到「新 codex 對話」按鈕

- [ ] **Step 3: 改共用型別與 IPC**

`src/shared/projects.ts`:

```ts
export interface ConversationOpenPayload {
  readonly projectId: string
  readonly provider: Provider
}

export function parseConversationOpen(raw: unknown): ConversationOpenPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId'])) return null
  const provider = raw['provider']
  if (provider !== 'claude' && provider !== 'codex') return null
  return { projectId: raw['projectId'], provider }
}
```

`src/shared/ipc.ts` 的 `YesChefApi`:

```ts
  /** 在某專案底下開一個新的對話分頁(D2、5b)。 */
  openConversation(projectId: string, provider: Provider): void
```

import 加 `type Provider` 自 `./projects.js`。

`src/preload/bridge.ts`:

```ts
  openConversation: (projectId, provider) => {
    ipcRenderer.send(IPC.conversationsOpen, { projectId, provider } satisfies ConversationOpenPayload)
  },
```

`src/main/projects-ipc.ts` 的 `onConversationOpen`:

```ts
  const onConversationOpen = onSend(
    IPC.conversationsOpen, parseConversationOpen, (p) => (s) =>
      openConversationTab(s, p.projectId, { tabId: service.newId(), threadId: service.newId(), provider: p.provider }, service.now()),
    (p) => p.projectId)
```

- [ ] **Step 4: 改 renderer**

`src/renderer/hooks/useProjects.ts`:

```ts
  /** 在 active 專案底下開一個新的對話分頁;沒有 active 專案時不做事。 */
  openConversation(provider?: Provider): void
```

```ts
  const openConversation = useCallback((provider: Provider = 'claude'): void => {
    if (activeId === null) return
    api.openConversation(activeId, provider)
  }, [api, activeId])
```

import 加 `type Provider`。

`src/renderer/components/LeftPane.tsx`:常數旁加

```ts
export const NEW_CODEX_CONVERSATION_LABEL = '新 codex 對話'
```

`quick-launch` 那一段的「新對話」按鈕後面加一顆:

```tsx
        <button type="button" className="tab-new-conversation" onClick={() => projects.openConversation('claude')}>
          {NEW_CONVERSATION_LABEL}
        </button>
        <button type="button" className="tab-new-conversation" onClick={() => projects.openConversation('codex')}>
          {NEW_CODEX_CONVERSATION_LABEL}
        </button>
```

`renderConversation` 的簽名多帶 provider:

```ts
  readonly renderConversation: (projectId: string, conversationId: string, provider: Provider) => React.ReactNode
```

掛載處:

```tsx
                {renderConversation(p.id, tab.id, tab.provider ?? 'claude')}
```

import 加 `type Provider`。

`src/renderer/components/ConversationPane.tsx`:

```ts
export interface ConversationPaneProps {
  readonly api: YesChefApi
  readonly projects: Projects
  readonly projectId: string
  readonly conversationId: string
  /** codex 對話不畫 Recents:那份清單是 Claude 的 session,對 codex 沒有意義(5b 規格 §0)。 */
  readonly provider: Provider
}
```

函式簽名解構加 `provider`,`return` 的第一段改成:

```tsx
      {provider === 'codex' ? null : (
        <aside className="sidebar">
          <Recents
            sessions={sessions}
            current={current}
            error={error}
            threads={threads}
            scope={scope}
            onScopeChange={project === undefined ? undefined : setScope}
            onOpen={api.openHistory}
            onStartNew={api.startNew}
          />
        </aside>
      )}
```

import 加 `type Provider` 自 `../../shared/projects.js`。

`src/renderer/App.tsx` 的 `renderConversation`:

```tsx
          renderConversation={(projectId, conversationId, provider) => (
            <ConversationPane
              api={api}
              projects={projects}
              projectId={projectId}
              conversationId={conversationId}
              provider={provider}
            />
          )}
```

- [ ] **Step 5: 全部跑綠與覆蓋率**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run --exclude tests/measure-memory.test.ts`
Expected: 全部 PASS

Run: `npm run test:coverage`
Expected: Stmts ≥ 93、Branch ≥ 86。低於門檻時先看 `src/main/codex/` 底下哪些分支沒測到,寫進報告,不要為了衝數字加無意義的測試。

- [ ] **Step 6: Commit**

```bash
git add src/shared/projects.ts src/shared/ipc.ts src/preload/bridge.ts src/main/projects-ipc.ts src/renderer/hooks/useProjects.ts src/renderer/components/LeftPane.tsx src/renderer/components/ConversationPane.tsx src/renderer/App.tsx tests/projects-shared.test.ts tests/preload-bridge.test.ts tests/projects-ipc.test.ts tests/use-projects.test.tsx tests/left-pane.test.tsx tests/conversation-pane.test.tsx tests/helpers/fake-yeschef.ts
git commit -m "feat: 分頁列可以開 codex 對話,codex 分頁不畫 Recents"
```

---

## 實機驗收(計畫執行完之後,由控制端用 CDP 做)

規格 §8 的六項不在 codex 的任務範圍。做法沿用 `docs/RESULTS-12-d2-acceptance.md`。

| # | 項目 | 通過條件 |
|---|---|---|
| 1 | 開 codex 對話,送一則要它跑 `ls` | 畫面有 Bash 的 tool block、輸出、最終回覆;`~/.codex/sessions` 多一個 thread |
| 2 | 要它改一個檔案 | 出批准卡(Edit),允許後檔案真的改了;拒絕後 codex 回覆說被拒 |
| 3 | 切到別的對話再切回 | codex 對話的畫面完整;子程序在背景時已收掉(`ps` 看不到) |
| 4 | app 重啟後在 codex 對話送第二則 | 走 `thread/resume`,codex 記得第一則的內容 |
| 5 | 回合進行中按停止 | `turn/interrupt` 送出,畫面出現中斷 |
| 6 | 未登入(暫時把 `~/.codex/auth.json` 改名) | 錯誤卡文字正確,還原後正常 |

## 自查紀錄

規格逐節對照:

| 規格 | Task |
|---|---|
| §1 資料流與 `Conversation` 介面;依 `provider` 選工廠 | 4、5 |
| §2 事件對應表(13 列) | 2 |
| §3 批准:兩種請求進 registry、decision 對應、`approvalPolicy: 'untrusted'`、`requestUserInput` 回空答案 | 3、4 |
| §4 中斷對到 `turn/interrupt`,沒有進行中的 turn 就不送 | 3 |
| §5 行程與生命週期五列、每個請求帶 `jsonrpc` | 1、3、4 |
| §6 六種錯誤 | 1(非 JSON 行)、3(未登入、非零退出、`turn/start` 錯誤、請求逾時)、4(PATH 沒有 codex) |
| §7 分頁列與入口、`TabEntry.provider: 'codex'`、PATH 找不到的訊息 | 4、6 |
| §8 單元測試清單 | 每項都有對應的 it;實機那六項留給控制端 |

規格之外補的三項(執行時要記進規格修訂紀錄):

- **codex 對話不畫 Recents 側欄。** 那份清單是 Claude 的 session,對 codex 沒有意義,而且點下去會送 `openHistory` 給一個不支援它的核心。規格 §0 只寫「右窗格工具給 codex 用」不做,沒有提 Recents。
- **codex 不載入歷史。** 規格 §2 沒有歷史的對應,`thread/resume` 的 `initialTurnsPage` 沒用。重開 app 後 codex 分頁是空的,狀態 `viewing`,送出下一則訊息才 resume。
- **`session-end` 加了選填的 `tokens`。** 規格 §2 要 codex 的回合結尾顯示 token 數,而既有的 `session-end` 只有 `costUsd` 與 `numTurns`。加一個選填欄位並在 fold 的 `cost` 與回合結尾一起接上;Claude 那條路不填就不畫,行為不變。
- **`fileChange` 的批准卡 input 只有 `reason`。** 規格 §3 的表寫 `{ changes, reason }`,但 `FileChangeRequestApprovalParams` 沒有 `changes` 欄位(只有 `itemId`、`reason`、`grantRoot`、`threadId`、`turnId`、`startedAtMs`)。changes 在 `item/started` 就畫進 tool block 了,卡片掛在同一個 block 底下,不必重複。

已知取捨:

- `item/commandExecution/requestApproval` 與 `item/fileChange/requestApproval` 這兩個方法名是從 schema 的檔名推出來的,沒有實跑過。名字若不對,Task 3 的「認不得的 server 請求一定回錯誤並記 log」會讓它變成一筆 log 加一張沒出現的批准卡,不會讓 codex 卡住;實機驗收第 2 項會抓到。
- `session-start` 由 `thread/start` 的回應產生,不是規格 §2 寫的 `thread/started` 通知:回應裡才有 model,而且 `thread/resume` 沒有那則通知。mapper 對 `thread/started` 回空陣列。
