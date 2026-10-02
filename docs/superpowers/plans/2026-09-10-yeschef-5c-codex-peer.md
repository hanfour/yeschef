# 子專案 5c:codex 那邊也接上兩個工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 codex 的對話也能用 `ask_peer` 與 `answer_peer`,同一個專案裡 Claude 與 codex 可以互相問答。

**Architecture:** codex 這側走 app-server 的 dynamic tools:`thread/start` 與 `thread/resume` 都帶兩個工具,codex 呼叫時以 `item/tool/call` 這個伺服器請求送過來,宿主阻塞、回文字。行為主體(信箱、逾時、死鎖、排隊、人的介入)全部沿用既有的 `PeerService`,codex 這側只是第二種呼叫入口。注入走既有的 `send()`,codex 的 `userInput` 本來就會在本機推一則 `user-text`,所以畫面上的「同伴提問」自動成立。

**Tech Stack:** Electron 44、TypeScript 7(`strict`、`noUncheckedIndexedAccess`)、vitest 4、codex-cli 0.153.4 的 app-server(JSON-RPC over stdio)。

**Spec:** `docs/specs/2026-09-09-yeschef-peer-design.md` §8 的 5c 那一列與 §6.1 的 codex 注入;協定事實在 `docs/RESULTS-16-5c-probe.md`,那三條是實測過的,不要重新猜。

## Global Constraints

- `thread/start` 與 `thread/resume` 都要帶 `dynamicTools`。少一邊就是「重開 app 之後那個 codex 對話不能問也不能答」(RESULTS-16)。
- 工具呼叫的回覆形狀:`{ success: boolean, contentItems: [{ type: 'inputText', text }] }`。錯誤也走 `success: false` 加同樣的 `contentItems`,錯誤文字會進到模型的答案裡,不另開錯誤通道(RESULTS-16)。
- codex 的工具名稱是 `ask_peer` 與 `answer_peer`(沒有 `mcp__yeschef__` 前綴);Claude 那側是有前綴的全名。兩邊都要認得。
- 兩個工具在 codex 這側不需要批准:dynamic tool 不走 `approvalPolicy`,宿主收到就是要回。
- 逾時由宿主管,沿用 `PeerService` 的 10 分鐘。codex 的一個 turn 內可以等宿主很久,`item/tool/call` 回覆前 turn 不會結束(RESULTS-11)。
- 資料不就地修改;main 的使用者與模型可見文字集中在 `src/main/peer/errors.ts`。
- 測試放 `tests/`;子程序與時鐘一律注入,測試不真的起 `codex app-server`。
- TypeScript 是 `strict` + `noUncheckedIndexedAccess`;import 路徑帶 `.js` 副檔名。
- 每個 Task 結尾 `git add <明確檔名>` 與 `git commit` 分兩個指令;commit message 格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 完成前 `npm run typecheck` 與 `npx vitest run` 都要綠(整套現在不必再排除 measure-memory)。Task 3 之後跑 `npm run test:coverage`,Stmts ≥ 93、Branch ≥ 86。

---

## 檔案結構

修改:

| 檔案 | 改動 |
|---|---|
| `src/main/codex/client.ts` | `dynamicTools` 傳給 start 與 resume;處理 `item/tool/call` 這個伺服器請求 |
| `src/main/codex/conversation.ts` | 接受 `peerTools`,把兩個工具的規格交給 client,把呼叫轉給 `PeerService` |
| `src/main/ipc-bridge.ts` | codex 對話也登錄成同伴;把 `peer.forConversation` 交給 codex 核心 |
| `src/renderer/components/ToolCall.tsx` | 兩種工具名稱(有前綴與沒前綴)都認得 |
| `src/shared/peer-tools.ts` | 一個判斷用的小函式,兩側共用 |

不新增檔案。

---

### Task 1: client 帶工具規格並接住工具呼叫

**Files:**
- Modify: `src/main/codex/client.ts`
- Test: `tests/codex-client.test.ts`(加)

**Interfaces:**
- Produces:
  - `interface CodexDynamicTool { readonly type: 'function'; readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }`
  - `CodexClientDeps.dynamicTools?: readonly CodexDynamicTool[]`
  - `CodexClientDeps.onDynamicToolCall?: (tool: string, args: unknown) => Promise<{ ok: boolean; text: string }>`
  - `TOOL_CALL_METHOD = 'item/tool/call'`

行為:

- `dynamicTools` 有給就一起送進 `thread/start` 與 `thread/resume`;沒給就照舊送空陣列給 start、resume 不帶那個欄位(維持既有行為)。
- 收到 `item/tool/call`:取 `tool` 與 `arguments`,交給 `onDynamicToolCall`,回
  `{ success, contentItems: [{ type: 'inputText', text }] }`。
- 沒給 `onDynamicToolCall`、或 `tool` 不是字串:回 `success: false` 加一句說明,不要丟例外
  (丟例外會讓 rpc 回 JSON-RPC error,codex 那邊的 turn 表現不一樣,而我們要的是把錯誤講給模型聽)。
- `onDynamicToolCall` 丟例外:記錯誤,回 `success: false` 加那個例外的訊息。

- [ ] **Step 1: 寫失敗測試**

`tests/codex-client.test.ts` 追加(沿用這個檔既有的假子程序與 `say` helper):

```ts
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
})
```

`setup`、`say`、`errors` 是這個檔既有的;`paramsOf(method)`、`finishStart`、`startAndSettle`、
`nextReplyTo(id)`、`errorReplies()` 若既有 helper 沒有,就在原 helper 上加,不要另建一套。
`nextReplyTo` 取的是宿主寫回子程序 stdin 的那一則 `{ id, result }` 的 `result`;
`errorReplies` 取的是宿主寫回去的 `{ id, error }`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/codex-client.test.ts`
Expected: FAIL,`dynamicTools` 不是 `CodexClientDeps` 的欄位

- [ ] **Step 3: 改 client**

型別與常數:

```ts
/** codex app-server 的 dynamic tool 規格(RESULTS-11、RESULTS-16 實測過的形狀)。 */
export interface CodexDynamicTool {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** codex 呼叫宿主提供的工具。回覆前那個 turn 不會結束,逾時由宿主自己管。 */
export const TOOL_CALL_METHOD = 'item/tool/call'
```

`CodexClientDeps` 加兩個選用欄位:

```ts
  /** 給 codex 的工具規格。`thread/start` 與 `thread/resume` 都會帶上。 */
  readonly dynamicTools?: readonly CodexDynamicTool[]
  /** codex 呼叫工具時問這裡。回 `ok: false` 就是把錯誤講給模型聽,不是協定層的錯誤。 */
  readonly onDynamicToolCall?: (tool: string, args: unknown) => Promise<{ ok: boolean; text: string }>
```

`start` 裡兩條路都帶上:

```ts
        const tools = deps.dynamicTools
        const result = existingThreadId === undefined
          ? await r.request('thread/start', { cwd: deps.cwd, ...common, dynamicTools: tools ?? [] })
          : await r.request('thread/resume', {
              threadId: existingThreadId,
              ...common,
              ...(tools === undefined ? {} : { dynamicTools: tools }),
            })
```

`handleServerRequest` 在批准那段之後、`USER_INPUT_METHOD` 之前加:

```ts
    if (method === TOOL_CALL_METHOD) return await handleToolCall(params)
```

```ts
  /**
   * codex 呼叫宿主的工具。一律回 `{ success, contentItems }`,不丟 JSON-RPC 錯誤:
   * 錯誤要以文字回給模型,模型才有辦法改做法(RESULTS-16 驗過失敗的文字會進到它的答案)。
   */
  const handleToolCall = async (params: unknown): Promise<unknown> => {
    const record = isRecord(params) ? params : {}
    const tool = record['tool']
    const handler = deps.onDynamicToolCall
    if (typeof tool !== 'string' || tool === '' || handler === undefined) {
      const why = typeof tool === 'string' && tool !== '' ? `這個對話沒有接工具:${tool}` : '工具呼叫沒有帶工具名稱'
      deps.logError(new Error(`${TOOL_CALL_METHOD}:${why}`))
      return toolResult(false, why)
    }
    try {
      const outcome = await handler(tool, record['arguments'])
      return toolResult(outcome.ok, outcome.text)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      deps.logError(new Error(`${TOOL_CALL_METHOD}(${tool}):${message}`))
      return toolResult(false, message)
    }
  }
```

檔案上方加一個小工具:

```ts
const toolResult = (success: boolean, text: string): unknown => ({
  success,
  contentItems: [{ type: 'inputText', text }],
})
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/codex-client.test.ts`
Expected: PASS

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/codex/client.ts tests/codex-client.test.ts
git commit -m "feat: codex client 帶工具規格並接住工具呼叫"
```

---

### Task 2: codex 對話把工具接到同伴服務

**Files:**
- Modify: `src/main/codex/conversation.ts`
- Modify: `src/shared/peer-tools.ts`
- Test: `tests/codex-conversation.test.ts`(加)、`tests/peer-injection-text.test.ts`(加)

**Interfaces:**
- Consumes:Task 1 的 `CodexDynamicTool`、`CodexClientDeps.dynamicTools`、`onDynamicToolCall`;既有的 `PeerTools`(`src/main/peer/service.ts`)。
- Produces:
  - `CodexConversationDeps.peerTools?: PeerTools`
  - `codexPeerToolSpecs(): readonly CodexDynamicTool[]`(`src/main/codex/conversation.ts` 匯出,供測試比對)
  - `isPeerToolName(name: string, which: PeerToolName): boolean`(`src/shared/peer-tools.ts`)

行為:

- 有給 `peerTools` 才把兩個工具規格交給 client;沒給就完全照舊(codex 對話沒有這兩個工具)。
- `ask_peer` 的參數:`question` 必填字串,`to` 選填字串。缺 `question` 回錯誤文字,不呼叫服務。
- `answer_peer` 的參數:`id` 與 `text` 都必填字串。缺任一個回錯誤文字。
- 服務丟 `PeerError` 時把它的訊息當作回給模型的文字,`ok: false`。
- 不認得的工具名稱回錯誤文字。

- [ ] **Step 1: 寫共用判斷的失敗測試**

`tests/peer-injection-text.test.ts` 加:

```ts
import { isPeerToolName } from '../src/shared/peer-tools.js'

describe('isPeerToolName', () => {
  it('兩種寫法都認:有 mcp 前綴的與 codex 的裸名', () => {
    expect(isPeerToolName('ask_peer', 'ask_peer')).toBe(true)
    expect(isPeerToolName('mcp__yeschef__ask_peer', 'ask_peer')).toBe(true)
    expect(isPeerToolName('answer_peer', 'answer_peer')).toBe(true)
    expect(isPeerToolName('mcp__yeschef__answer_peer', 'answer_peer')).toBe(true)
  })

  it('不是那個工具的一律 false', () => {
    expect(isPeerToolName('ask_peer', 'answer_peer')).toBe(false)
    expect(isPeerToolName('mcp__yeschef__ask_peer_extra', 'ask_peer')).toBe(false)
    expect(isPeerToolName('Bash', 'ask_peer')).toBe(false)
    expect(isPeerToolName('', 'ask_peer')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/peer-injection-text.test.ts`
Expected: FAIL,`isPeerToolName` 不存在

- [ ] **Step 3: 寫共用判斷**

`src/shared/peer-tools.ts` 追加:

```ts
/**
 * 這個工具名稱是不是那個同伴工具。Claude 那側是 `mcp__yeschef__ask_peer`,
 * codex 那側是裸的 `ask_peer`(dynamic tool 沒有前綴),畫面與接線兩邊都要認。
 */
export function isPeerToolName(name: string, which: PeerToolName): boolean {
  return name === which || name === `${VIEW_TOOL_PREFIX}${which}`
}
```

Run: `npx vitest run tests/peer-injection-text.test.ts`
Expected: PASS

- [ ] **Step 4: 寫 codex 對話的失敗測試**

`tests/codex-conversation.test.ts` 追加(沿用這個檔既有的假 client 與 `setup`):

```ts
describe('同伴工具', () => {
  const fakePeerTools = (over: Partial<PeerTools> = {}): PeerTools => ({
    askPeer: async () => '預設答案',
    answerPeer: async () => '已回答',
    ...over,
  })

  it('沒給 peerTools 時不帶工具規格', () => {
    const h = setup()
    expect(h.clientDeps().dynamicTools).toBeUndefined()
  })

  it('給了就帶兩個工具規格,名稱與描述都對', () => {
    const h = setup({ peerTools: fakePeerTools() })
    const tools = h.clientDeps().dynamicTools
    expect(tools?.map((t) => t.name)).toEqual(['ask_peer', 'answer_peer'])
    expect(tools?.map((t) => t.type)).toEqual(['function', 'function'])
    for (const t of tools ?? []) expect(t.description.length).toBeGreaterThan(0)
  })

  it('ask_peer 轉給服務,答案回給 codex', async () => {
    const seen: Array<[string, string | undefined]> = []
    const h = setup({ peerTools: fakePeerTools({ askPeer: async (q, to) => { seen.push([q, to]); return '同伴說好' } }) })
    const out = await h.clientDeps().onDynamicToolCall?.('ask_peer', { question: '在嗎', to: 'bbbb2222' })
    expect(seen).toEqual([['在嗎', 'bbbb2222']])
    expect(out).toEqual({ ok: true, text: '同伴說好' })
  })

  it('ask_peer 缺 question 時回錯誤,不呼叫服務', async () => {
    let called = false
    const h = setup({ peerTools: fakePeerTools({ askPeer: async () => { called = true; return 'x' } }) })
    const out = await h.clientDeps().onDynamicToolCall?.('ask_peer', { to: 'bbbb2222' })
    expect(called).toBe(false)
    expect(out?.ok).toBe(false)
  })

  it('answer_peer 轉給服務', async () => {
    const seen: Array<[string, string]> = []
    const h = setup({ peerTools: fakePeerTools({ answerPeer: async (id, text) => { seen.push([id, text]); return '已回答' } }) })
    const out = await h.clientDeps().onDynamicToolCall?.('answer_peer', { id: 'q-1', text: '我在' })
    expect(seen).toEqual([['q-1', '我在']])
    expect(out).toEqual({ ok: true, text: '已回答' })
  })

  it('answer_peer 缺參數時回錯誤', async () => {
    const h = setup({ peerTools: fakePeerTools() })
    expect((await h.clientDeps().onDynamicToolCall?.('answer_peer', { id: 'q-1' }))?.ok).toBe(false)
    expect((await h.clientDeps().onDynamicToolCall?.('answer_peer', { text: '我在' }))?.ok).toBe(false)
  })

  it('服務丟錯時把訊息當成回給模型的文字', async () => {
    const h = setup({ peerTools: fakePeerTools({ askPeer: async () => { throw new PeerError('這個專案沒有別的同伴') } }) })
    const out = await h.clientDeps().onDynamicToolCall?.('ask_peer', { question: '有人嗎' })
    expect(out).toEqual({ ok: false, text: '這個專案沒有別的同伴' })
  })

  it('不認得的工具名稱回錯誤', async () => {
    const h = setup({ peerTools: fakePeerTools() })
    expect((await h.clientDeps().onDynamicToolCall?.('view_click', {}))?.ok).toBe(false)
  })
})
```

`h.clientDeps()` 取的是這個對話建 client 時交出去的那份 deps;既有 helper 沒有就在原
helper 上加(既有測試已經在攔 `createClient`,把那份參數留下來即可)。

- [ ] **Step 5: 跑測試確認失敗**

Run: `npx vitest run tests/codex-conversation.test.ts`
Expected: FAIL,`peerTools` 不是 `CodexConversationDeps` 的欄位

- [ ] **Step 6: 改 codex 對話**

```ts
import { PEER_MSG, PeerError } from '../peer/errors.js'
import type { PeerTools } from '../peer/service.js'
import type { CodexDynamicTool } from './client.js'
import { PEER_TOOL_NAMES } from '../../shared/peer-tools.js'
```

`CodexConversationDeps` 加:

```ts
  /** 有給才把兩個同伴工具交給 codex(5c)。沒給就是這個對話不能問也不能答。 */
  readonly peerTools?: PeerTools
```

工具規格:

```ts
/**
 * 給 codex 的兩個工具規格。名稱與 Claude 那側的 MCP 工具同名(沒有前綴),
 * 描述沿用同一份文字,兩邊的模型看到的說明一樣。
 */
export function codexPeerToolSpecs(): readonly CodexDynamicTool[] {
  return [
    {
      type: 'function',
      name: PEER_TOOL_NAMES[0],
      description: PEER_MSG.askPeerDescription,
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' }, to: { type: 'string' } },
        required: ['question'],
      },
    },
    {
      type: 'function',
      name: PEER_TOOL_NAMES[1],
      description: PEER_MSG.answerPeerDescription,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    },
  ]
}
```

呼叫的轉接。放在 `createCodexConversation` 內、建 client 之前:

```ts
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

  /**
   * codex 呼叫同伴工具。參數檢查在這裡做:codex 的 inputSchema 是給模型看的提示,
   * 不保證送過來的東西合規。錯誤一律以文字回去,模型看得懂才改得了做法。
   */
  const onDynamicToolCall = async (tool: string, args: unknown): Promise<{ ok: boolean; text: string }> => {
    const peer = deps.peerTools
    if (peer === undefined) return { ok: false, text: PEER_MSG.peerToolsMissing }
    const record: Record<string, unknown> = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
    try {
      if (tool === PEER_TOOL_NAMES[0]) {
        const question = str(record['question'])
        if (question === undefined) return { ok: false, text: PEER_MSG.askPeerNeedsQuestion }
        return { ok: true, text: await peer.askPeer(question, str(record['to'])) }
      }
      if (tool === PEER_TOOL_NAMES[1]) {
        const id = str(record['id'])
        const text = str(record['text'])
        if (id === undefined || text === undefined) return { ok: false, text: PEER_MSG.answerPeerNeedsBoth }
        return { ok: true, text: await peer.answerPeer(id, text) }
      }
      return { ok: false, text: PEER_MSG.unknownTool(tool) }
    } catch (cause) {
      if (cause instanceof PeerError) return { ok: false, text: cause.message }
      throw cause
    }
  }
```

建 client 的地方多帶兩個欄位(只有給了 `peerTools` 才帶):

```ts
      ...(deps.peerTools === undefined ? {} : { dynamicTools: codexPeerToolSpecs(), onDynamicToolCall }),
```

`src/main/peer/errors.ts` 的 `PEER_MSG` 加三句,放在兩句工具描述旁邊:

```ts
  /** codex 那側的參數檢查與接線錯誤(5c)。 */
  peerToolsMissing: '這個對話沒有接上同伴問答',
  askPeerNeedsQuestion: 'ask_peer 要有 question',
  answerPeerNeedsBoth: 'answer_peer 要有 id 與 text',
  unknownTool: (tool: string) => `不認得的工具 ${tool}`,
```

- [ ] **Step 7: 跑測試確認通過**

Run: `npx vitest run tests/codex-conversation.test.ts tests/peer-injection-text.test.ts`
Expected: PASS

- [ ] **Step 8: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/codex/conversation.ts src/main/peer/errors.ts src/shared/peer-tools.ts tests/codex-conversation.test.ts tests/peer-injection-text.test.ts
git commit -m "feat: codex 對話把兩個同伴工具接到同伴服務"
```

---

### Task 3: 主行程登錄 codex 對話,畫面認得裸名

**Files:**
- Modify: `src/main/ipc-bridge.ts`
- Modify: `src/renderer/components/ToolCall.tsx`
- Test: `tests/ipc-bridge.test.ts`(改)、`tests/tool-call.test.tsx`(加)

**Interfaces:**
- Consumes:Task 2 的 `CodexConversationDeps.peerTools`;既有的 `PeerService.forConversation`;Task 2 的 `isPeerToolName`。

行為:

- codex 對話建好核心之後也登錄成同伴(第一階段刻意擋著,因為那時它沒有這兩個工具)。
- 建 codex 核心時把 `deps.peer?.forConversation(conversationId)` 交下去。
- `ToolCall` 的兩處文案改用 `isPeerToolName`,codex 的裸名也認得。

- [ ] **Step 1: 寫失敗測試**

`tests/ipc-bridge.test.ts`:既有那條「codex 對話不會進 registry」要反過來,不要留兩套:

```ts
  it('codex 對話也登錄成同伴,並拿到同伴工具', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('codex-tab')
    const entry = peer.entries.get('codex-tab')
    expect(entry).toBeDefined()
    expect(entry?.provider).toBe('codex')
    expect(h.codexDeps('codex-tab')?.peerTools).toBeDefined()
  })

  it('沒給 peer 時 codex 核心不帶同伴工具', async () => {
    const h = await harnessWithPeer(undefined)
    h.focus('codex-tab')
    expect(h.codexDeps('codex-tab')?.peerTools).toBeUndefined()
  })
```

`h.codexDeps(id)` 取的是那個 codex 對話建核心時交出去的 deps;既有 harness 已經在攔
`createCodexConversation`,把那份參數留下來即可。fixture 要有一個 `provider: 'codex'` 的分頁,
既有 fixture 沒有就加一個,不要另建一套。

`tests/tool-call.test.tsx` 加:

```ts
it('codex 的裸名也認得:ask_peer 顯示等待秒數', () => {
  render(<ToolCall block={block({ name: 'ask_peer' })} historical={false} />)
  expect(screen.queryByText('等同伴回答，已等 0 秒')).not.toBeNull()
})

it('codex 的裸名也認得:answer_peer 顯示「回答同伴」', () => {
  render(<ToolCall block={block({ name: 'answer_peer', status: 'done' })} historical={false} />)
  expect(screen.queryByText('回答同伴')).not.toBeNull()
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts tests/tool-call.test.tsx`
Expected: FAIL,codex 沒有進 registry、裸名沒有換文案

- [ ] **Step 3: 改 ipc-bridge**

codex 那條分支:建核心時多帶一個欄位,建好之後登錄。

```ts
      const core = makeCodex({
        ...common,
        onSessionStarted: (sessionId, cwd) => recordStarted('codex', conversationId, projectId, sessionId, cwd),
        cwd: rootPath,
        ...(initialSessionId === undefined ? {} : { initialThreadId: initialSessionId }),
        ...(deps.peer === undefined ? {} : { peerTools: deps.peer.forConversation(conversationId) }),
      })
      registerPeer(core)
      return { core, projectId, rootPath }
```

`registerPeer` 上方那句「codex 要等 5c 接上兩個工具才能登錄」的註解刪掉。

- [ ] **Step 4: 改 ToolCall**

```ts
import { isPeerToolName } from '../../shared/peer-tools.js'
```

原本比對 `ASK_PEER_TOOL` 與 `ANSWER_PEER_TOOL` 的兩處改成:

```ts
  const waiting = isPeerToolName(block.name, 'ask_peer') && block.status === 'running'
```

```ts
  const toolLabel = isPeerToolName(block.name, 'answer_peer') ? '回答同伴' : block.name
```

(`toolLabel` 是既有那段判斷的名字;沿用既有寫法,只換比對方式。`ASK_PEER_TOOL` 與
`ANSWER_PEER_TOOL` 這兩個常數若因此在這個檔沒人用了,連 import 一起刪掉。)

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/ipc-bridge.test.ts tests/tool-call.test.tsx`
Expected: PASS

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run`
Expected: 全部 PASS

Run: `npm run test:coverage`
Expected: Stmts ≥ 93、Branch ≥ 86

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc-bridge.ts src/renderer/components/ToolCall.tsx tests/ipc-bridge.test.ts tests/tool-call.test.tsx
git commit -m "feat: codex 對話登錄成同伴,畫面認得沒有前綴的工具名"
```

---

## 驗收

規格 §8 的 5c 那一列寫「第 10 節五項再跑一次,兩個方向」。實際要跑的是下面六項,
同一個專案裡一個 Claude 對話與一個 codex 對話。操作方式沿用 RESULTS-15:
`npx electron . --remote-debugging-port=9336 --user-data-dir=<fixture>`,狀態檔事先擺好,
動作前先讀 `getProjects()` 的 `busyTabIds` 確認對方真的在忙。

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | Claude 問 codex | codex 那一輪是「同伴提問」,標示是 `claude · <前 8 碼>`;codex 用 `answer_peer` 回答,Claude 的工具結果就是那段文字 |
| 2 | codex 問 Claude | Claude 那一輪是「同伴提問」,標示是 `codex · <前 8 碼>`;codex 的 `ask_peer` 顯示「等同伴回答,已等 n 秒」 |
| 3 | codex 不給 `to`、專案裡有兩個同伴 | codex 的最終答案帶著「這個專案有多個同伴,to 要指定一個」與候選清單 |
| 4 | codex 問 Claude 之後,Claude 反過來問 codex | Claude 拿到「對方正在等你回答 #…」 |
| 5 | 在 Claude 那側按「代替回答」回覆 codex 的提問 | codex 的 `ask_peer` 拿到那段文字;信箱的 answer 檔 `actor` 是 `user` |
| 6 | 關掉 app 再開,在 codex 對話送第二則訊息,再問一次 | resume 之後工具還在,`ask_peer` 照樣叫得動(RESULTS-16 驗過協定收 resume 的 dynamicTools,這裡驗接線) |

檢查信箱:

```bash
ls -1 <專案>/.yeschef/mail/
cat <專案>/.yeschef/mail/question-*.json
```

`from` 與 `to` 的 `provider` 應該一邊是 `claude`、一邊是 `codex`。

## 自我檢查

**規格涵蓋**:§8 的 5c 那一列(codex 接兩個工具、跨模型跑通)在 Task 1 到 3;
§6.1 的 codex 注入走既有的 `send()`,不必改;
§6.2 的「同伴提問自成一輪」在 codex 這側自動成立,因為 codex 的 `userInput` 會在本機推
一則 `user-text`,`fold` 的解析對兩種 provider 一視同仁;
§4 的兩個工具在 codex 這側不需要批准,dynamic tool 本來就不走批准政策。

**沒有佔位**:每個 Step 都有可以直接貼的程式碼或可以直接跑的指令。三處明講「沿用既有 helper,
不要另建一套」的地方(Task 1 的 client 測試 helper、Task 2 的 `clientDeps()`、Task 3 的
`codexDeps()` 與 codex fixture),是因為那些 helper 的內部形狀要看現場,計畫不猜。

**型別一致**:`CodexDynamicTool` 的四個欄位在 Task 1 定義,Task 2 的 `codexPeerToolSpecs`
產出同一個型別;`onDynamicToolCall` 的簽章 `(tool: string, args: unknown) => Promise<{ ok: boolean; text: string }>`
在 Task 1 定義,Task 2 的實作與 Task 3 的測試都用同一個形狀;
`isPeerToolName(name, which)` 在 Task 2 定義,Task 3 用它;
`PeerTools` 是既有型別,`askPeer(question, to?)` 與 `answerPeer(id, text)` 兩個簽章沒有變。
