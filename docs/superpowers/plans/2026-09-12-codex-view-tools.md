# codex 對話接上右窗格瀏覽器工具 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** codex 對話能用右窗格的八個瀏覽器工具,批准、前景互斥、切走中止、交接卡、截圖預覽全部與 Claude 那側同一套零件。

**Architecture:** 不起獨立 MCP server。工具定義(名字、描述、zod shape、怎麼呼叫 controller)抽成一份後端無關的 `view-tools/tool-defs.ts`;`view-tools/server.ts` 的 `ProjectViewTools` 多一個後端無關的 `invoke(name, args, ctx)`,前景守衛、inflight、合併 AbortSignal、錯誤翻譯都在它裡面。Claude 的殼是既有的 `tool()` + MCP server,codex 的殼是 `codex/conversation.ts` 的 `dynamicTools` + `onDynamicToolCall`,兩邊呼叫同一個 `invoke`。`ipc-bridge.ts` 的 codex 分支改成也向 `runtimeFor` 要一份 runtime,`index.ts` 把該專案的 `ProjectViewTools` 包成 `CodexViewTools` 交下去。

**Spec:** `docs/specs/2026-09-12-codex-view-tools-design.md`;協定實測 `docs/RESULTS-22-codex-view-tools-probe.md`

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess`;不可用 `any` 或 `!`;不可就地修改(一律 spread 產新物件);註解用繁體中文寫「為什麼」。
- commit 訊息 `<type>: <描述>`,繁體中文,不加 trailer。測試不用 jest-dom(只用 `expect` 的原生 matcher 與 `container.querySelector`)。Stmts ≥ 93、Branch ≥ 86。
- 不新增任何 npm 套件。zod 是 `^4.5.4`,JSON Schema 用它內建的 `z.toJSONSchema()`,不引 `zod-to-json-schema`。
- 工具名對 codex **平鋪不加前綴**:`view_navigate` 而不是 `mcp__yeschef__view_navigate`(RESULTS-22 §5:namespace 會把名字變成 `view__click`)。Claude 那側維持 `mcp__yeschef__` 前綴,兩邊名字的橋是 `src/shared/view-tools.ts` 的 `asViewToolName` / `isViewToolName`。
- 批准政策表 `viewToolPolicy` 只認全名,codex 端一律先 `fullToolName(name)` 再問它。不改 `policy.ts`。
- 圖片回 codex 一律 **data URL**(`data:image/png;base64,…`),不用 `file://` 也不用 `https://`(RESULTS-22 §1:https 被伺服器擋掉並把 item 改成 failed)。
- codex 的 `callId` 就是 `toolUseId`(RESULTS-22 §9:與 `item/started` 的 `item.id` 逐字相同),批准卡與交接卡都用它。
- 非前景對話呼叫八個工具一律回 `{ success: false, contentItems: [{ type: 'inputText', text: MSG.browserBusy }] }`,`MSG.browserBusy` 用 `src/main/view-tools/errors.ts` 既有那一條,不新寫字串。
- 新增的使用者可見字串一律進 `MSG`(`view-tools/errors.ts`),不散在程式裡。
- `view-tools/tool-defs.ts` 不得 import Electron、不得 import `@anthropic-ai/claude-agent-sdk`;`codex/conversation.ts` 只能以 `import type` 碰 `controller.js` 的型別。

---

### Task 1:工具定義與 `invoke` 拆成後端無關的一份,Claude 殼行為不變

**Files:**
- Create: `src/main/view-tools/tool-defs.ts`
- Modify: `src/main/view-tools/errors.ts`(`MSG` 加 `badArgs`、`unknownTool`、`approvalDenied` 三條)
- Modify: `src/main/view-tools/server.ts`(刪掉 `TOOL_DESCRIPTIONS`、`createTools`、`handoffAction`、`toToolResult`、`toErrorResult`、`errorResult`、`mergeSignal`;改用 `VIEW_TOOL_DEFS`,`ProjectViewTools` 多 `invoke`)
- Test: `tests/view-tools/tool-defs.test.ts`(新增)、`tests/view-tools/server.test.ts`(加一個 `describe('invoke(後端無關的入口)')`)、`tests/view-tools/errors.test.ts`(加三條字串)

**Interfaces:**

```ts
// src/main/view-tools/tool-defs.ts 匯出
export interface ToolCallContext { readonly callId: string | null }
export interface InvokeContext { readonly callId: string | null; readonly signal?: AbortSignal }
export type ViewToolInvocation =
  | { readonly ok: true; readonly output: ToolOutput }
  | { readonly ok: false; readonly text: string }
export interface ViewToolDef {
  readonly name: ViewToolName
  readonly description: string
  readonly shape: z.ZodRawShape
  readonly inputSchema: Record<string, unknown>
  run(controller: ViewController, args: unknown, ctx: ToolCallContext, signal: AbortSignal): Promise<ToolOutput>
}
export const VIEW_TOOL_DEFS: readonly ViewToolDef[]
export function viewToolDef(name: string): ViewToolDef | undefined

// src/main/view-tools/server.ts 的 ProjectViewTools 多這一支,永不 reject
invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
```

`invoke` 的順序固定,兩個殼共用:前景守衛(`isActive` 為 false → `browserBusy`)→ dispose 守衛(→ `sessionEnded`)→ 查定義(查不到 → `unknownTool`)→ 登記 inflight → zod 驗參數 → 呼叫 controller → 例外翻成文字。與現在 `runTool` 的順序逐項相同,只差「查定義」與「zod 驗參數」兩步是新的(codex 送來的參數沒有人先驗)。

- [ ] **Step 1:寫失敗測試。**

新增 `tests/view-tools/tool-defs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { VIEW_TOOL_DEFS, viewToolDef } from '../../src/main/view-tools/tool-defs.js'
import { VIEW_TOOL_NAMES } from '../../src/shared/view-tools.js'

/** 八個工具各自的 JSON Schema 應有的欄位與必填,與契約 §2 的 zod shape 並排。 */
const EXPECTED: Readonly<Record<string, { properties: readonly string[]; required: readonly string[] }>> = {
  view_navigate: { properties: ['url'], required: ['url'] },
  view_snapshot: { properties: ['scope'], required: [] },
  view_screenshot: { properties: [], required: [] },
  view_click: { properties: ['ref'], required: ['ref'] },
  view_type: { properties: ['ref', 'text', 'clear', 'submit'], required: ['ref', 'text'] },
  view_press: { properties: ['key'], required: ['key'] },
  view_eval: { properties: ['expression'], required: ['expression'] },
  request_handoff: { properties: ['reason'], required: ['reason'] },
}

function schemaOf(def: { inputSchema: Record<string, unknown> }): { properties: string[]; required: string[] } {
  const props = def.inputSchema['properties']
  const required = def.inputSchema['required']
  return {
    properties: typeof props === 'object' && props !== null ? Object.keys(props) : [],
    required: Array.isArray(required) ? required.map((r) => String(r)) : [],
  }
}

describe('VIEW_TOOL_DEFS', () => {
  it('八個定義,名稱與順序照契約 §2', () => {
    expect(VIEW_TOOL_DEFS.map((d) => d.name)).toEqual([...VIEW_TOOL_NAMES])
  })

  it('每個定義都有非空的中文描述', () => {
    for (const def of VIEW_TOOL_DEFS) expect(def.description.length, def.name).toBeGreaterThan(0)
  })

  it('JSON Schema 是 object,不帶 $schema(codex 的 dynamicTools 只吃 schema 本體)', () => {
    for (const def of VIEW_TOOL_DEFS) {
      expect(def.inputSchema['type'], def.name).toBe('object')
      expect('$schema' in def.inputSchema, def.name).toBe(false)
    }
  })

  it('JSON Schema 的欄位名與必填逐個照契約', () => {
    for (const def of VIEW_TOOL_DEFS) {
      expect(schemaOf(def), def.name).toEqual({
        properties: [...(EXPECTED[def.name]?.properties ?? [])],
        required: [...(EXPECTED[def.name]?.required ?? [])],
      })
    }
  })

  it('zod shape 的欄位名與 JSON Schema 的欄位名一字不差(兩份不會分岔)', () => {
    for (const def of VIEW_TOOL_DEFS) {
      expect(schemaOf(def).properties, def.name).toEqual(Object.keys(def.shape))
    }
  })

  it('zod shape 的必填與 JSON Schema 的 required 一致', () => {
    for (const def of VIEW_TOOL_DEFS) {
      const optional = Object.entries(def.shape)
        .filter(([, field]) => z.object({ f: field }).safeParse({}).success)
        .map(([key]) => key)
      const required = Object.keys(def.shape).filter((key) => !optional.includes(key))
      expect(schemaOf(def).required, def.name).toEqual(required)
    }
  })

  it('viewToolDef 用平鋪名字查得到,前綴名與未知名查不到', () => {
    expect(viewToolDef('view_click')?.name).toBe('view_click')
    expect(viewToolDef('mcp__yeschef__view_click')).toBeUndefined()
    expect(viewToolDef('Read')).toBeUndefined()
  })
})
```

在 `tests/view-tools/errors.test.ts` 的 `describe('MSG（契約 §10.1，逐字比對）')` 裡加一條:

```ts
  it('codex 殼新增的三條', () => {
    expect(MSG.badArgs('view_click', 'ref')).toBe('view_click 的參數不合規：ref')
    expect(MSG.unknownTool('view_xxx')).toBe('不認得的工具 view_xxx')
    expect(MSG.approvalDenied).toBe('使用者拒絕')
  })
```

在 `tests/view-tools/server.test.ts` 檔尾加一個 describe(沿用檔案既有的 `build()`、`ctrl()`、`active`、`project`、`logError`):

```ts
describe('invoke(後端無關的入口)', () => {
  it('成功時回 ok 與 controller 的輸出,參數照樣傳下去', async () => {
    await build()
    const result = await project.invoke('view_click', { ref: 's2-e7' }, { callId: 'exec-1' })
    expect(result).toEqual({ ok: true, output: OK_TEXT })
    expect(ctrl('click').mock.calls[0]?.[0]).toBe('s2-e7')
  })

  it('影像輸出原樣回傳,由各自的殼決定怎麼包', async () => {
    await build()
    expect(await project.invoke('view_screenshot', {}, { callId: 'exec-2' })).toEqual({ ok: true, output: PNG })
  })

  it('非前景回 browserBusy,連 controller 都不呼叫', async () => {
    await build()
    active = false
    expect(await project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-3' }))
      .toEqual({ ok: false, text: MSG.browserBusy })
    expect(ctrl('click')).not.toHaveBeenCalled()
  })

  it('dispose 之後回 sessionEnded', async () => {
    await build()
    project.dispose()
    expect(await project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-4' }))
      .toEqual({ ok: false, text: MSG.sessionEnded })
  })

  it('不認得的工具名回 unknownTool,不記 logError', async () => {
    await build()
    expect(await project.invoke('view_teleport', {}, { callId: 'exec-5' }))
      .toEqual({ ok: false, text: MSG.unknownTool('view_teleport') })
    expect(logError).not.toHaveBeenCalled()
  })

  it('參數型別不對回 badArgs,不呼叫 controller,也不記 logError', async () => {
    await build()
    expect(await project.invoke('view_click', { ref: 7 }, { callId: 'exec-6' }))
      .toEqual({ ok: false, text: MSG.badArgs('view_click', 'ref') })
    expect(ctrl('click')).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  it('選填參數省略時補預設值,與 Claude 那條路一樣', async () => {
    await build()
    await project.invoke('view_type', { ref: 's3-e1', text: 'abc' }, { callId: 'exec-7' })
    await project.invoke('view_snapshot', {}, { callId: 'exec-8' })
    expect(ctrl('type').mock.calls[0]?.slice(0, 4)).toEqual(['s3-e1', 'abc', false, false])
    expect(ctrl('snapshot').mock.calls[0]?.[0]).toBe('viewport')
  })

  it('request_handoff 拿 ctx.callId 當 toolUseId;callId 為 null 時回 handoffNoId', async () => {
    await build()
    await project.invoke('request_handoff', { reason: '請登入' }, { callId: 'exec-9' })
    expect(ctrl('requestHandoff').mock.calls[0]?.slice(0, 2)).toEqual(['exec-9', '請登入'])
    expect(await project.invoke('request_handoff', { reason: '請登入' }, { callId: null }))
      .toEqual({ ok: false, text: MSG.handoffNoId })
  })

  it('ViewToolError 直接回訊息,一般例外先 logError 再包成 internal', async () => {
    await build()
    ctrl('click').mockRejectedValueOnce(new ViewToolError(MSG.refFormat))
    expect(await project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-a' }))
      .toEqual({ ok: false, text: MSG.refFormat })
    const boom = new Error('壞了')
    ctrl('evaluate').mockRejectedValueOnce(boom)
    expect(await project.invoke('view_eval', { expression: 'x()' }, { callId: 'exec-b' }))
      .toEqual({ ok: false, text: MSG.internal('壞了') })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('abortPending 會中止 invoke 進行中的呼叫(它有登記 inflight)', async () => {
    const tools = await build()
    shared.controller['click'] = pendingForever()
    void project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-c' })
    await Promise.resolve()
    expect(signals.at(-1)?.aborted).toBe(false)
    tools.abortPending(MSG.browserBusy)
    expect(signals.at(-1)?.aborted).toBe(true)
  })

  it('ctx.signal 與自己的中止合併,任一邊中止都會傳到 controller', async () => {
    await build()
    shared.controller['click'] = pendingForever()
    const outer = new AbortController()
    void project.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-d', signal: outer.signal })
    await Promise.resolve()
    expect(signals.at(-1)?.aborted).toBe(false)
    outer.abort(new Error('外面喊停'))
    expect(signals.at(-1)?.aborted).toBe(true)
  })
})
```

- [ ] **Step 2:確認失敗。** `npx vitest run tests/view-tools/tool-defs.test.ts tests/view-tools/server.test.ts tests/view-tools/errors.test.ts`,`tool-defs.ts` 不存在(模組解析失敗)、`project.invoke` 不是函式、`MSG.badArgs` 不存在。

- [ ] **Step 3:實作。**

新檔 `src/main/view-tools/tool-defs.ts`:

```ts
/**
 * 八個瀏覽器工具的定義,與後端無關(codex view tools 規格 §4.1)。
 * 這裡只有「名字、描述、參數形狀、怎麼呼叫 controller」;前景守衛、inflight、
 * 錯誤翻譯在 server.ts 的 invoke。兩個殼(Claude 的 MCP `tool()`、codex 的
 * `dynamicTools`)共用同一份,工具的說明與參數名不可能分岔。
 * 不 import Electron、不 import SDK:codex 那條路也要載得動這個檔。
 */
import { z } from 'zod'
import type { ViewToolName } from '../../shared/view-tools.js'
import type { ToolOutput, ViewController } from './controller.js'
import { MSG, ViewToolError } from './errors.js'

/** 一次呼叫的上下文。callId 是 Claude 的 toolUseId 或 codex 的 callId(RESULTS-22 §9:兩者都等於畫面上那個 tool block 的 id)。 */
export interface ToolCallContext {
  readonly callId: string | null
}

/** invoke 的上下文:多一個外面傳進來的中止訊號(MCP 的 extra.signal 或 codex 端的取消)。 */
export interface InvokeContext extends ToolCallContext {
  readonly signal?: AbortSignal
}

/** invoke 的結果。錯誤以文字回去而不是丟例外:兩個殼都要把它講給模型聽。 */
export type ViewToolInvocation =
  | { readonly ok: true; readonly output: ToolOutput }
  | { readonly ok: false; readonly text: string }

export interface ViewToolDef {
  readonly name: ViewToolName
  readonly description: string
  /** Claude 的 `tool()` 直接吃這一份 zod shape。 */
  readonly shape: z.ZodRawShape
  /** codex 的 `dynamicTools` 吃這一份,由同一個 zod 物件轉出來。 */
  readonly inputSchema: Record<string, unknown>
  /** args 先用同一份 zod 驗過再進 controller:codex 送來的參數沒有經過任何驗證。 */
  run(controller: ViewController, args: unknown, ctx: ToolCallContext, signal: AbortSignal): Promise<ToolOutput>
}

/** 給模型看的一句話。字串是使用者可見文案,改字要先改契約。 */
const TOOL_DESCRIPTIONS: Readonly<Record<ViewToolName, string>> = {
  view_navigate: '在右窗格開啟一個網址,支援 http、https,以及專案目錄底下的 file。',
  view_snapshot: '列出右窗格目前可操作的元素與它們的 ref,操作前先呼叫這個。',
  view_screenshot: '對右窗格的可視範圍截一張圖,用於確認版面或圖片內容。',
  view_click: '點擊 view_snapshot 給的 ref 所指的元素。',
  view_type: '在 view_snapshot 給的 ref 所指的欄位輸入文字,可選擇先清空或輸入後送出。',
  view_press: '對右窗格送出一個按鍵,例如 Enter、Tab 或方向鍵。',
  view_eval: '在右窗格的主 frame 執行一段 JavaScript 並取回結果,每次都需要使用者批准。',
  request_handoff: '把右窗格交給使用者處理(例如登入或輸入驗證碼),等他按下「我好了」再繼續。',
}

/**
 * 同一個 zod 物件同時產出兩份:`shape` 給 Claude、`inputSchema` 給 codex。
 * 去掉 `$schema`:`CodexDynamicTool.inputSchema` 只要 schema 本體,多的欄位沒有用處。
 */
function defineTool<S extends z.ZodRawShape>(
  name: ViewToolName,
  shape: S,
  run: (controller: ViewController, args: z.infer<z.ZodObject<S>>, ctx: ToolCallContext, signal: AbortSignal) => Promise<ToolOutput>
): ViewToolDef {
  const schema = z.object(shape)
  const full: Record<string, unknown> = { ...z.toJSONSchema(schema) }
  const inputSchema = Object.fromEntries(Object.entries(full).filter(([key]) => key !== '$schema'))
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    shape,
    inputSchema,
    run: (controller, args, ctx, signal) => {
      const parsed = schema.safeParse(args)
      if (!parsed.success) {
        // 欄位名講給模型聽,它才知道要改哪一個;值不回去,可能很長也可能含隱私。
        const fields = parsed.error.issues.map((issue) => issue.path.map((p) => String(p)).join('.')).join('、')
        return Promise.reject(new ViewToolError(MSG.badArgs(name, fields)))
      }
      return run(controller, parsed.data, ctx, signal)
    },
  }
}

/** 順序照契約 §2 的 VIEW_TOOL_NAMES。 */
export const VIEW_TOOL_DEFS: readonly ViewToolDef[] = [
  defineTool('view_navigate', { url: z.string() }, (c, a, _ctx, signal) => c.navigate(a.url, signal)),
  defineTool('view_snapshot', { scope: z.enum(['viewport', 'full']).optional() }, (c, a, _ctx, signal) =>
    c.snapshot(a.scope ?? 'viewport', signal)),
  defineTool('view_screenshot', {}, (c, _a, _ctx, signal) => c.screenshot(signal)),
  defineTool('view_click', { ref: z.string() }, (c, a, _ctx, signal) => c.click(a.ref, signal)),
  defineTool('view_type', {
    ref: z.string(), text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional(),
  }, (c, a, _ctx, signal) => c.type(a.ref, a.text, a.clear ?? false, a.submit ?? false, signal)),
  defineTool('view_press', { key: z.string() }, (c, a, _ctx, signal) => c.press(a.key, signal)),
  defineTool('view_eval', { expression: z.string() }, (c, a, _ctx, signal) => c.evaluate(a.expression, signal)),
  defineTool('request_handoff', { reason: z.string() }, (c, a, ctx, signal) => {
    // 裁決 8:沒有 id 就追蹤不了這次交接。Claude 從 extra._meta 取,codex 用 callId。
    if (ctx.callId === null) return Promise.reject(new ViewToolError(MSG.handoffNoId))
    return c.requestHandoff(ctx.callId, a.reason, signal)
  }),
]

/** 平鋪名字查定義;帶 `mcp__yeschef__` 前綴的查不到,那條路由 SDK 自己處理。 */
export function viewToolDef(name: string): ViewToolDef | undefined {
  return VIEW_TOOL_DEFS.find((def) => def.name === name)
}
```

`src/main/view-tools/errors.ts` 的 `MSG` 物件裡加三條(放在 `internal` 後面):

```ts
  badArgs: (tool: string, fields: string) => `${tool} 的參數不合規：${fields}`,
  unknownTool: (name: string) => `不認得的工具 ${name}`,
  approvalDenied: '使用者拒絕',
```

`src/main/view-tools/server.ts` 的改法,逐段:

1. import 換成:

```ts
import { CDP_CALL_TIMEOUT_MS, createViewController, type ToolOutput, type ViewController } from './controller.js'
import { HANDOFF_TIMEOUT_MS, createHandoff, readToolUseId } from './handoff.js'
import {
  VIEW_TOOL_DEFS,
  viewToolDef,
  type InvokeContext,
  type ViewToolInvocation,
} from './tool-defs.js'
export type { InvokeContext, ViewToolInvocation }
```

2. 刪掉 `TOOL_DESCRIPTIONS`(整個常數搬進 tool-defs.ts)、`toToolResult`、`toErrorResult`、`mergeSignal`、`handoffAction`、`createTools`;`ViewToolName` 這個 type import 若不再用到就一併刪掉。

3. `errorResult` 留著(peer 那條路還在用),另外加兩支:

```ts
/** 例外翻成給模型看的一句中文(契約 §10.3)。ViewToolError 的 message 本來就是 MSG 表的字。 */
function toErrorText(error: unknown, logError: (error: Error) => void): string {
  if (error instanceof ViewToolError) return error.message
  if (error instanceof CdpError) return MSG.cdpFailed(error.code, error.message)
  const wrapped = error instanceof Error ? error : new Error(String(error))
  logError(wrapped)
  return MSG.internal(wrapped.message)
}

/** Claude 殼:把後端無關的結果包成 MCP 的 CallToolResult。 */
function toCallToolResult(result: ViewToolInvocation): CallToolResult {
  if (!result.ok) return errorResult(result.text)
  const output = result.output
  if (output.kind === 'image') {
    return {
      content: [
        { type: 'text', text: output.text },
        { type: 'image', data: output.dataBase64, mimeType: output.mimeType },
      ],
    }
  }
  return { content: [{ type: 'text', text: output.text }] }
}
```

4. `runTool` 整支換成 `invokeTool`:

```ts
/**
 * 後端無關的入口(規格 §4.1)。先過專案守衛,再登記 inflight、合併 signal、
 * 把任何結果或例外轉成 ViewToolInvocation。永不 reject。背景專案(D 規格 §3.4)
 * 連 CDP 都不送,直接回 browserBusy;已 dispose 的專案回 sessionEnded,
 * 否則呼叫會登記進沒人收得掉的 inflight。
 */
async function invokeTool(
  runtime: ToolRuntime,
  name: string,
  args: unknown,
  ctx: InvokeContext
): Promise<ViewToolInvocation> {
  if (!runtime.isActive()) return { ok: false, text: MSG.browserBusy }
  if (runtime.isDisposed()) return { ok: false, text: MSG.sessionEnded }
  const def = viewToolDef(name)
  if (def === undefined) return { ok: false, text: MSG.unknownTool(name) }
  const own = new AbortController()
  runtime.inflight.add(own)
  try {
    // 裁決 19:自己的中止與外面(MCP 的 extra.signal)的中止都要能停掉等待。
    const signal = ctx.signal === undefined ? own.signal : AbortSignal.any([own.signal, ctx.signal])
    return { ok: true, output: await def.run(runtime.controller, args, { callId: ctx.callId }, signal) }
  } catch (error) {
    return { ok: false, text: toErrorText(error, runtime.logError) }
  } finally {
    runtime.inflight.delete(own)
  }
}
```

5. `createPeerTools` 裡的 `runPeerTool` 不動,只把它的 `toErrorResult(error, logError)` 改成 `errorResult(toErrorText(error, logError))`。

6. 新的 Claude 殼工廠(取代 `createTools`):

```ts
/** 八個工具的 Claude 殼。裁決 10:zod shape 只宣告型別,值檢查在 controller。裁決 19:全部 alwaysLoad。 */
function createTools(invoke: (name: string, args: unknown, ctx: InvokeContext) => Promise<ViewToolInvocation>) {
  const always = { alwaysLoad: true }
  return VIEW_TOOL_DEFS.map((def) =>
    tool(def.name, def.description, def.shape, async (args, extra) => {
      const fromExtra = extraSignal(extra)
      const ctx: InvokeContext = {
        // 裁決 8:toolUseId 只能從 extra._meta 取,取不到就當這次交接無法追蹤。
        callId: readToolUseId(extra),
        ...(fromExtra === null ? {} : { signal: fromExtra }),
      }
      return toCallToolResult(await invoke(def.name, args, ctx))
    }, always))
}
```

7. `ProjectViewTools` 介面加一條,並在 `forProject` 回傳:

```ts
export interface ProjectViewTools {
  readonly server: McpSdkServerConfigWithInstance
  /** 後端無關的入口(規格 §4.1):Claude 的 MCP 殼與 codex 的 dynamicTools 殼都走這裡。永不 reject。 */
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  abortPending(reason: string): void
  dispose(): void
}
```

```ts
    const forProject = (isActive: () => boolean, peer?: PeerTools): ProjectViewTools => {
      const inflight = new Set<AbortController>()
      projects.add(inflight)
      let disposed = false
      const runtime: ToolRuntime = {
        controller, inflight, isActive, isDisposed: () => disposed, logError: deps.logError,
      }
      const invoke = (name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation> =>
        invokeTool(runtime, name, args, ctx)
      const server = createSdkMcpServer({
        name: VIEW_TOOL_SERVER_NAME,
        version: SERVER_VERSION,
        tools: [
          ...createTools(invoke),
          ...(peer === undefined ? [] : createPeerTools(peer, deps.logError)),
        ],
        timeout: TOOL_CALL_TIMEOUT_MS,
      })
      return {
        server,
        invoke,
        abortPending: (reason: string): void => { abortAll(inflight, reason) },
        dispose: (): void => {
          disposed = true
          abortAll(inflight, MSG.sessionEnded)
          projects.delete(inflight)
        },
      }
    }
```

- [ ] **Step 4:全綠。** `npm run typecheck`、`npx vitest run`、`npm run test:coverage`、`npm run build` 全過。特別確認 `tests/view-tools/server.test.ts` 既有的「工具定義」「參數傳遞與成功結果」「錯誤包裝」三個 describe 一條都沒改就通過(Claude 殼行為不變)。
- [ ] **Step 5:`git commit -m "refactor: 右窗格工具的定義與入口拆成後端無關的一份"`**

---

### Task 2:圖片認 `inputImage` 形狀,`client.ts` 把 `DynamicToolCallParams` 往上傳

**Files:**
- Modify: `src/shared/tool-images.ts`(`asImage` 多認 `{ type: 'inputImage', imageUrl: 'data:…' }`)
- Modify: `src/main/codex/client.ts`(新增 `DynamicToolCallParams` 與 `CodexToolOutcome`;`toolResult` 改吃 outcome;`handleToolCall` 把 params 往上傳)
- Test: `tests/tool-images.test.ts`(加一個 describe)、`tests/codex-client.test.ts`(在既有的工具呼叫 describe 裡加三條)

**Interfaces:**

```ts
// src/main/codex/client.ts 匯出
/** `item/tool/call` 的參數(RESULTS-22 §9:callId 與 item/started 的 item.id 逐字相同)。 */
export interface DynamicToolCallParams {
  readonly threadId: string
  readonly turnId: string
  readonly callId: string
  readonly tool: string
}
/** 宿主回給 codex 的結果。有圖就多一項 inputImage,且一定是 data: URL。 */
export interface CodexToolOutcome {
  readonly ok: boolean
  readonly text: string
  readonly imageDataUrl?: string
}
readonly onDynamicToolCall?: (tool: string, args: unknown, params: DynamicToolCallParams) => Promise<CodexToolOutcome>
```

第三個參數是新增的,TypeScript 允許少收參數的函式指派給多收參數的型別,所以 `conversation.ts` 既有的 `onDynamicToolCall = async (tool, args) => …` 與 `tests/codex-client.test.ts` 既有的假處理函式都不必改。`{ ok, text }` 也仍然指派得進 `CodexToolOutcome`。

- [ ] **Step 1:寫失敗測試。**

`tests/tool-images.test.ts` 檔尾加:

```ts
describe('codex 的 dynamicTool 結果', () => {
  // codex 的 contentItems 是 { type: 'inputImage', imageUrl }(RESULTS-22 §1、§2);
  // imageUrl 只吃 data: URL,https 會被 app-server 擋掉,file:// 走 codex 自己的 view_image。
  const items = [
    { type: 'inputText', text: '可視範圍 800×600' },
    { type: 'inputImage', imageUrl: 'data:image/png;base64,CCCC' },
  ]

  it('從 inputImage 的 data URL 取出 mimeType 與 base64', () => {
    expect(extractImages(items)).toEqual([{ mimeType: 'image/png', dataBase64: 'CCCC' }])
  })

  it('包在 contentItems 外層的 content 物件也取得到', () => {
    expect(extractImages({ content: items })).toEqual([{ mimeType: 'image/png', dataBase64: 'CCCC' }])
  })

  it('不是 data URL、不是 base64、mimeType 不在白名單的都不認', () => {
    expect(extractImages([{ type: 'inputImage', imageUrl: 'https://x.test/a.png' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 'file:///tmp/a.png' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 'data:image/png,notbase64' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 'data:image/svg+xml;base64,CCCC' }])).toEqual([])
    expect(extractImages([{ type: 'inputImage', imageUrl: 7 }])).toEqual([])
    expect(extractImages([{ type: 'inputImage' }])).toEqual([])
  })

  it('去掉圖片資料時換掉 imageUrl,文字項與原物件都不動', () => {
    expect(redactImages(items)).toEqual([
      { type: 'inputText', text: '可視範圍 800×600' },
      { type: 'inputImage', imageUrl: '(圖片,4 字元,已畫在上方)' },
    ])
    expect(items[1]).toEqual({ type: 'inputImage', imageUrl: 'data:image/png;base64,CCCC' })
  })

  it('toDataUrl 轉回去與原本的 imageUrl 一字不差', () => {
    const found = extractImages(items)[0]
    expect(found === undefined ? '' : toDataUrl(found)).toBe('data:image/png;base64,CCCC')
  })
})
```

`tests/codex-client.test.ts` 在既有那個含「工具呼叫轉給 onDynamicToolCall」的 describe 裡加三條:

```ts
  it('callId、threadId、turnId、tool 一起往上傳(RESULTS-22 §9)', async () => {
    const seen: Array<Record<string, string>> = []
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

  it('params 缺欄位時補空字串,不丟錯', async () => {
    const seen: Array<Record<string, string>> = []
    const h = setup({
      dynamicTools: TOOLS,
      onDynamicToolCall: async (_tool, _args, params) => { seen.push({ ...params }); return { ok: true, text: '好' } },
    })
    await h.startAndSettle()
    h.say({ jsonrpc: '2.0', id: 97, method: 'item/tool/call', params: { tool: 'view_snapshot', arguments: {} } })
    await h.nextReplyTo(97)
    expect(seen).toEqual([{ threadId: '', turnId: '', callId: '', tool: 'view_snapshot' }])
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
```

- [ ] **Step 2:確認失敗。** `npx vitest run tests/tool-images.test.ts tests/codex-client.test.ts`:`inputImage` 那些回空陣列、`params` 是 undefined、`imageDataUrl` 被吃掉只剩一項。

- [ ] **Step 3:實作。**

`src/shared/tool-images.ts`:把檔頭註解改成三種形狀,並把 `asImage` 換成:

```ts
/**
 * 工具結果裡的圖片有三種形狀:
 * - Anthropic image block `{ type: 'image', source: { type: 'base64', media_type, data } }`:Claude 那條路(規格 3b 實測)。
 * - MCP 圖片 `{ type: 'image', data, mimeType }`:codex 的 mcpToolCall 原樣轉傳 MCP 內容區塊(app-server 協定 schema)。
 * - codex 的 contentItems `{ type: 'inputImage', imageUrl: 'data:…;base64,…' }`:右窗格工具回給 codex 的截圖
 *   (RESULTS-22 §1:只吃 data: URL,https 被伺服器擋掉,file:// 會走 codex 自己的 view_image)。
 * 回傳圖片本身,以及把 data 換掉時要改的那一層物件。
 */

/** `data:<mime>;base64,<payload>`。只認 base64,其他編碼一律當成不是我們畫得出來的圖。 */
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/

function asInputImage(
  item: Record<string, unknown>
): { readonly image: ToolImage; readonly redact: (note: string) => unknown } | undefined {
  const url = item['imageUrl']
  if (typeof url !== 'string') return undefined
  const matched = DATA_URL_RE.exec(url)
  if (matched === null) return undefined
  const mimeType = matched[1]
  const data = matched[2]
  if (mimeType === undefined || data === undefined || !IMAGE_TYPES.has(mimeType)) return undefined
  return { image: { mimeType, dataBase64: data }, redact: (note) => ({ ...item, imageUrl: note }) }
}

function asImage(item: unknown): { readonly image: ToolImage; readonly redact: (note: string) => unknown } | undefined {
  if (!isRecord(item)) return undefined
  if (item['type'] === 'inputImage') return asInputImage(item)
  if (item['type'] !== 'image') return undefined
  const source = item['source']
  if (isRecord(source)) {
    const mimeType = source['media_type']
    const data = source['data']
    if (source['type'] !== 'base64' || typeof mimeType !== 'string' || !IMAGE_TYPES.has(mimeType) || typeof data !== 'string') return undefined
    return { image: { mimeType, dataBase64: data }, redact: (note) => ({ ...item, source: { ...source, data: note } }) }
  }
  const mimeType = item['mimeType']
  const data = item['data']
  if (typeof mimeType !== 'string' || !IMAGE_TYPES.has(mimeType) || typeof data !== 'string') return undefined
  return { image: { mimeType, dataBase64: data }, redact: (note) => ({ ...item, data: note }) }
}
```

`src/main/codex/client.ts`:

1. `CodexDynamicTool` 後面加兩個介面:

```ts
/**
 * `item/tool/call` 的參數。`callId` 與同一刻 `item/started` 的 `item.id` 逐字相同
 * (RESULTS-22 §9),所以宿主可以直接拿它當畫面上那顆 item 的 key,不必另建對照表。
 */
export interface DynamicToolCallParams {
  readonly threadId: string
  readonly turnId: string
  readonly callId: string
  readonly tool: string
}

/**
 * 宿主回給 codex 的結果。有圖就多一項 `inputImage`,`imageDataUrl` 必須是 data: URL:
 * https 會被 app-server 擋掉並把 item 改成 failed(RESULTS-22 §1)。
 */
export interface CodexToolOutcome {
  readonly ok: boolean
  readonly text: string
  readonly imageDataUrl?: string
}
```

2. `CodexClientDeps.onDynamicToolCall` 改成:

```ts
  /** codex 呼叫工具時問這裡。回 `ok: false` 就是把錯誤講給模型聽,不是協定層的錯誤。 */
  readonly onDynamicToolCall?: (tool: string, args: unknown, params: DynamicToolCallParams) => Promise<CodexToolOutcome>
```

3. `toolResult` 改成吃 outcome:

```ts
const toolResult = (outcome: CodexToolOutcome): unknown => ({
  success: outcome.ok,
  contentItems: outcome.imageDataUrl === undefined
    ? [{ type: 'inputText', text: outcome.text }]
    : [
        // 文字在前圖在後,兩項都會進模型(RESULTS-22 §2)。
        { type: 'inputText', text: outcome.text },
        { type: 'inputImage', imageUrl: outcome.imageDataUrl },
      ],
})

/** params 的欄位缺了不能讓整個呼叫失敗:模型還在等回覆,回覆晚一步整個 turn 就停住。 */
const readString = (value: unknown): string => (typeof value === 'string' ? value : '')
```

4. `handleToalCall` → `handleToolCall` 內文:

```ts
  const handleToolCall = async (params: unknown): Promise<unknown> => {
    const record = isRecord(params) ? params : {}
    const tool = record['tool']
    const handler = deps.onDynamicToolCall
    if (typeof tool !== 'string' || tool === '' || handler === undefined) {
      const why = typeof tool === 'string' && tool !== '' ? PEER_MSG.codexToolUnavailable(tool) : PEER_MSG.codexToolNameMissing
      deps.logError(new Error(`${TOOL_CALL_METHOD}:${why}`))
      return toolResult({ ok: false, text: why })
    }
    const callParams: DynamicToolCallParams = {
      threadId: readString(record['threadId']),
      turnId: readString(record['turnId']),
      callId: readString(record['callId']),
      tool,
    }
    try {
      return toolResult(await handler(tool, record['arguments'], callParams))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      deps.logError(new Error(`${TOOL_CALL_METHOD}(${tool}):${message}`))
      return toolResult({ ok: false, text: message })
    }
  }
```

- [ ] **Step 4:全綠。** `npm run typecheck`、`npx vitest run`、`npm run test:coverage`、`npm run build` 全過。既有的四條 `item/tool/call` 測試不改也要通過。
- [ ] **Step 5:`git commit -m "feat: 圖片認 codex 的 inputImage 形狀,工具呼叫把 callId 往上傳"`**

---

### Task 3:codex 殼 —— 工具規格、分派、批准、交接

**Files:**
- Modify: `src/shared/view-tools.ts`(加 `asViewToolName`、`isViewToolName`)
- Modify: `src/main/codex/conversation.ts`(`CodexConversationDeps` 加 `viewTools`;加 `codexViewToolSpecs`;`onDynamicToolCall` 加第三個參數與 view 工具分支;`handoffDone` 轉給 runtime)
- Modify: `src/renderer/components/ConversationPane.tsx:208-214`(`renderToolOverride` 的比對改成 `isViewToolName`,codex 的平鋪名字才畫得出交接卡)
- Test: `tests/view-tools/view-tools-shared.test.ts`(加)、`tests/codex-conversation.test.ts`(加一個 describe,並把既有 15 處 `onDynamicToolCall` 呼叫補第三個參數)、`tests/handoff-card.test.tsx`(加一條 codex 平鋪名字的)

**Interfaces:**

```ts
// src/shared/view-tools.ts
export function asViewToolName(name: string): ViewToolName | undefined
export function isViewToolName(name: string, which: ViewToolName): boolean

// src/main/codex/conversation.ts
/** codex 對話要用的右窗格工具(規格 §4.1、§4.4)。由 index.ts 從該專案的 ProjectViewTools 組出來。 */
export interface CodexViewTools {
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  handoffDone(toolUseId: string): void
}
export function codexViewToolSpecs(): readonly CodexDynamicTool[]
// CodexConversationDeps 加:
readonly viewTools?: CodexViewTools
```

`onDynamicToolCall(tool, args, params)` 的分派順序:

1. `asViewToolName(tool)` 認得且 `deps.viewTools` 有給 → 走 view 工具那條。
2. 否則走既有的同伴工具那條(`PEER_TOOL_NAMES` 比對),行為一字不改。
3. 都不是 → `PEER_MSG.unknownTool(tool)`。

view 工具那條:
- `viewToolPolicy(fullToolName(name))` 是 `'ask'`(目前只有 `view_eval`)→ 先 `await requestApproval({ toolUseId: params.callId, toolName: name, input: 參數物件 })`;`decision !== 'allow'` 就回 `{ ok: false, text: outcome.reason ?? MSG.approvalDenied }`,不呼叫 `invoke`。
- `await deps.viewTools.invoke(name, args, { callId: params.callId })`。
- `ok: false` → `{ ok: false, text }`(非前景時這裡就是 `MSG.browserBusy`)。
- `ok: true` 且 `output.kind === 'image'` → `{ ok: true, text: output.text, imageDataUrl: toDataUrl({ mimeType, dataBase64 }) }`;否則 `{ ok: true, text: output.text }`。

`dynamicTools` 的組法:`[...(viewTools 有給 ? codexViewToolSpecs() : []), ...(peerTools 有給 ? codexPeerToolSpecs() : [])]`,長度為 0 時連 `dynamicTools` 與 `onDynamicToolCall` 都不帶(既有測試「沒給 peerTools 時不帶工具規格」靠這一條)。

- [ ] **Step 1:寫失敗測試。**

`tests/view-tools/view-tools-shared.test.ts` 加:

```ts
describe('asViewToolName 與 isViewToolName', () => {
  it('平鋪名字與帶前綴的全名都認得(codex 那側沒有前綴)', () => {
    expect(asViewToolName('view_click')).toBe('view_click')
    expect(asViewToolName('mcp__yeschef__view_click')).toBe('view_click')
    expect(isViewToolName('request_handoff', 'request_handoff')).toBe(true)
    expect(isViewToolName('mcp__yeschef__request_handoff', 'request_handoff')).toBe(true)
  })

  it('不是這八個的一律不認,多打一段也不認', () => {
    expect(asViewToolName('Read')).toBeUndefined()
    expect(asViewToolName('')).toBeUndefined()
    expect(asViewToolName('view_click_extra')).toBeUndefined()
    expect(asViewToolName('mcp__yeschef__ask_peer')).toBeUndefined()
    expect(isViewToolName('view_click', 'request_handoff')).toBe(false)
  })
})
```

(import 那行補上 `asViewToolName, isViewToolName`。)

`tests/codex-conversation.test.ts`:

先在檔頭加型別與一個共用的 params helper,並把既有 15 處呼叫改成帶第三個參數:

```ts
import type { CodexClient, CodexClientDeps, ApprovalKind, DynamicToolCallParams } from '../src/main/codex/client.js'
import type { CodexViewTools } from '../src/main/codex/conversation.js'
import { codexViewToolSpecs } from '../src/main/codex/conversation.js'
import { MSG } from '../src/main/view-tools/errors.js'
import { VIEW_TOOL_NAMES } from '../src/shared/view-tools.js'

/** `item/tool/call` 的參數;測試只在意 callId,其他兩欄固定。 */
const callParams = (callId = 'exec-1', tool = 'ask_peer'): DynamicToolCallParams =>
  ({ threadId: 'th-new', turnId: 'tu-1', callId, tool })
```

既有 15 處呼叫的機械改法(行號依現況):`452`、`462`、`473`、`484`、`493`(兩處)、`501`、`509` 的
`h.clientDeps().onDynamicToolCall?.(X, Y)` 全部改成 `h.clientDeps().onDynamicToolCall?.(X, Y, callParams())`;
`520`、`548` 取出的 `const call = h.clientDeps().onDynamicToolCall!` 之後的每一次 `call(X, Y)` 改成 `call(X, Y, callParams())`;
`536` 的 `onDynamicToolCall!('ask_peer', Object.freeze({ question: '在嗎' }))` 同樣補第三個參數。
這一輪只加參數,斷言一個字都不動。

然後在檔尾加新的 describe:

```ts
describe('右窗格工具', () => {
  const OK: ViewToolInvocation = { ok: true, output: { kind: 'text', text: '已到 https://a.test/,標題 A' } }
  const SHOT: ViewToolInvocation = {
    ok: true,
    output: { kind: 'image', text: '可視範圍 800×600', dataBase64: 'CCCC', mimeType: 'image/png' },
  }

  /** 假的 CodexViewTools:記下每次 invoke 的參數,結果由測試逐次排隊。 */
  function fakeViewTools(results: ViewToolInvocation[]): CodexViewTools & {
    readonly seen: Array<[string, unknown, string | null]>
    readonly dones: string[]
  } {
    const seen: Array<[string, unknown, string | null]> = []
    const dones: string[] = []
    return {
      seen,
      dones,
      invoke: async (name, args, ctx) => {
        seen.push([name, args, ctx.callId])
        return results.shift() ?? OK
      },
      handoffDone: (toolUseId) => { dones.push(toolUseId) },
    }
  }

  it('給了 viewTools 就把八個工具規格帶給 codex,名字平鋪、順序照契約', async () => {
    const view = fakeViewTools([])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    expect(h.clientDeps().dynamicTools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES])
    for (const spec of h.clientDeps().dynamicTools ?? []) {
      expect(spec.type, spec.name).toBe('function')
      expect(spec.description.length, spec.name).toBeGreaterThan(0)
      expect(spec.inputSchema['type'], spec.name).toBe('object')
    }
  })

  it('同時有 viewTools 與 peerTools 時十個工具都帶,view 在前(RESULTS-22 §5:平鋪十個照單全收)', async () => {
    const h = setup({ viewTools: fakeViewTools([]), peerTools: { askPeer: async () => 'a', answerPeer: async () => 'b' } })
    h.core.userInput('你好')
    await flush()
    expect(h.clientDeps().dynamicTools?.map((t) => t.name)).toEqual([...VIEW_TOOL_NAMES, 'ask_peer', 'answer_peer'])
  })

  it('白名單工具直接分派,callId 當 ctx.callId,不問批准', async () => {
    const view = fakeViewTools([OK])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.(
      'view_navigate', { url: 'https://a.test/' }, callParams('exec-7', 'view_navigate'))
    expect(view.seen).toEqual([['view_navigate', { url: 'https://a.test/' }, 'exec-7']])
    expect(out).toEqual({ ok: true, text: '已到 https://a.test/,標題 A' })
    expect(h.asks).toEqual([])
  })

  it('截圖回 data URL,文字照樣帶著(規格 §3:圖用 data URL)', async () => {
    const h = setup({ viewTools: fakeViewTools([SHOT]) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('view_screenshot', {}, callParams('exec-8', 'view_screenshot'))
    expect(out).toEqual({
      ok: true, text: '可視範圍 800×600', imageDataUrl: 'data:image/png;base64,CCCC',
    })
  })

  it('view_eval 先問批准,批准卡的 toolUseId 是 callId;允許後才分派', async () => {
    const view = fakeViewTools([OK])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const pending = h.clientDeps().onDynamicToolCall?.('view_eval', { expression: 'document.title' }, callParams('exec-9', 'view_eval'))
    await flush()
    expect(h.asks.map((a) => [a.toolUseId, a.toolName])).toEqual([['exec-9', 'view_eval']])
    expect(h.asks[0]?.input).toEqual({ expression: 'document.title' })
    expect(view.seen).toEqual([])
    const requestId = h.asks[0]?.requestId ?? ''
    h.core.approvalReply(requestId, 'allow')
    await flush()
    expect(await pending).toEqual({ ok: true, text: '已到 https://a.test/,標題 A' })
    expect(view.seen).toEqual([['view_eval', { expression: 'document.title' }, 'exec-9']])
  })

  it('拒絕 view_eval 時回拒絕原因,不呼叫 invoke', async () => {
    const view = fakeViewTools([OK])
    const h = setup({ viewTools: view })
    h.core.userInput('你好')
    await flush()
    const pending = h.clientDeps().onDynamicToolCall?.('view_eval', { expression: 'x()' }, callParams('exec-a', 'view_eval'))
    await flush()
    h.core.approvalReply(h.asks[0]?.requestId ?? '', 'deny')
    await flush()
    expect((await pending)?.ok).toBe(false)
    expect(view.seen).toEqual([])
  })

  it('invoke 回失敗時原樣把文字講給模型(非前景就是 browserBusy)', async () => {
    const h = setup({ viewTools: fakeViewTools([{ ok: false, text: MSG.browserBusy }]) })
    h.core.userInput('你好')
    await flush()
    const out = await h.clientDeps().onDynamicToolCall?.('view_click', { ref: 's1-e0' }, callParams('exec-b', 'view_click'))
    expect(out).toEqual({ ok: false, text: MSG.browserBusy })
  })

  it('沒給 viewTools 時不帶 view 工具規格,同伴工具照舊', async () => {
    const h = setup({ peerTools: { askPeer: async () => 'a', answerPeer: async () => 'b' } })
    h.core.userInput('你好')
    await flush()
    expect(h.clientDeps().dynamicTools?.map((t) => t.name)).toEqual(['ask_peer', 'answer_peer'])
  })

  it('handoffDone 轉給 runtime 的交接;沒接 viewTools 時記錯誤', async () => {
    const view = fakeViewTools([])
    const h = setup({ viewTools: view })
    h.core.handoffDone('exec-c')
    expect(view.dones).toEqual(['exec-c'])
    const bare = setup()
    bare.core.handoffDone('exec-d')
    expect(bare.errors.some((e) => e.includes('exec-d'))).toBe(true)
  })

  it('codexViewToolSpecs 每次回獨立物件,inputSchema 不共用', () => {
    const first = codexViewToolSpecs()
    expect(codexViewToolSpecs()[0]).not.toBe(first[0])
    expect(codexViewToolSpecs()[0]?.inputSchema).not.toBe(first[0]?.inputSchema)
  })
})
```

`setup()` 的 options 要加 `viewTools?: CodexViewTools`,並在 `createCodexConversation({...})` 裡展開:

```ts
function setup(options: { initialThreadId?: string; commandExists?: boolean; peerTools?: PeerTools; viewTools?: CodexViewTools } = {}): Rig {
  …
    ...(options.peerTools === undefined ? {} : { peerTools: options.peerTools }),
    ...(options.viewTools === undefined ? {} : { viewTools: options.viewTools }),
```

`tests/handoff-card.test.tsx` 在 `describe('App 把 request_handoff 的工具卡換成 HandoffCard')` 裡加:

```ts
  it('codex 的平鋪工具名也畫成 HandoffCard(dynamic tool 沒有前綴)', () => {
    const fake = createFakeApi()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    fake.emit([
      { kind: 'message-start', messageId: 'msg_1' },
      { kind: 'tool-use', messageId: 'msg_1', index: 0, id: 'exec-1', name: 'request_handoff', input: { reason: '請登入這個網站' } },
    ])
    expect(container.querySelectorAll('.handoff-card')).toHaveLength(1)
    expect(textOf(container, '.handoff-card__reason')).toBe('請登入這個網站')
  })
```

- [ ] **Step 2:確認失敗。** `npx vitest run tests/view-tools/view-tools-shared.test.ts tests/codex-conversation.test.ts tests/handoff-card.test.tsx`:`asViewToolName` 不存在、`viewTools` 不是 `CodexConversationDeps` 的欄位、codex 平鋪名字畫出來的是 `.tool-call` 不是 `.handoff-card`。

- [ ] **Step 3:實作。**

`src/shared/view-tools.ts` 檔尾加:

```ts
/**
 * 把一個工具名稱對回這八個之一。Claude 那側是 `mcp__yeschef__view_click`,
 * codex 那側是裸的 `view_click`(dynamic tool 沒有前綴,RESULTS-22 §5),畫面與接線兩邊都要認。
 * 白名單比對而非前綴比對:`view_click_extra` 這種多打一段的不算。
 */
export function asViewToolName(name: string): ViewToolName | undefined {
  return VIEW_TOOL_NAMES.find((known) => name === known || name === `${VIEW_TOOL_PREFIX}${known}`)
}

export function isViewToolName(name: string, which: ViewToolName): boolean {
  return asViewToolName(name) === which
}
```

`src/main/codex/conversation.ts`:

1. import 補上:

```ts
import type { CodexDynamicTool, CodexToolOutcome, DynamicToolCallParams } from './client.js'
import type { InvokeContext, ViewToolInvocation } from '../view-tools/tool-defs.js'
import { VIEW_TOOL_DEFS } from '../view-tools/tool-defs.js'
import { MSG } from '../view-tools/errors.js'
import { viewToolPolicy } from '../view-tools/policy.js'
import { asViewToolName, fullToolName, type ViewToolName } from '../../shared/view-tools.js'
import { toDataUrl } from '../../shared/tool-images.js'
```

2. `CodexConversationDeps` 加一條(放在 `peerTools` 後面):

```ts
  /** 有給才把八個右窗格工具交給 codex(規格 §4.1)。沒給就是這個對話不能開瀏覽器。 */
  readonly viewTools?: CodexViewTools
```

3. 檔案上方(`codexPeerToolSpecs` 前面)加介面與規格工廠:

```ts
/**
 * codex 對話要用的右窗格工具(規格 §4.1、§4.4)。這是 `ProjectViewTools` 的一小片:
 * conversation 不需要知道 MCP server,只要能呼叫與告知交接完成。
 */
export interface CodexViewTools {
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  handoffDone(toolUseId: string): void
}

/**
 * 八個右窗格工具的 codex 規格。名字平鋪,與 Claude 那側同名(codex 沒有 `mcp__yeschef__`
 * 這個慣例,加了 namespace 反而會變成 `view__click`,RESULTS-22 §5)。
 * inputSchema 與 Claude 那側的 zod shape 由同一份定義轉出來(tool-defs.ts)。
 */
export function codexViewToolSpecs(): readonly CodexDynamicTool[] {
  return VIEW_TOOL_DEFS.map((def) => ({
    type: 'function',
    name: def.name,
    description: def.description,
    inputSchema: { ...def.inputSchema },
  }))
}
```

4. `onDynamicToolCall` 前面加 view 工具那條路:

```ts
  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}

  /**
   * 右窗格工具(規格 §4.2)。codex 的 dynamic tool 呼叫不經 codex 自己的批准流程,
   * 所以 `ask` 的要自己先問使用者;批准卡的 toolUseId 用 callId,它與畫面上那顆
   * tool block 的 item.id 同值(RESULTS-22 §9),卡會掛在正確的 block 底下。
   */
  const runViewTool = async (
    view: CodexViewTools,
    name: ViewToolName,
    args: unknown,
    params: DynamicToolCallParams
  ): Promise<CodexToolOutcome> => {
    if (viewToolPolicy(fullToolName(name)) === 'ask') {
      const outcome = await requestApproval({ toolUseId: params.callId, toolName: name, input: asRecord(args) })
      if (outcome.decision !== 'allow') return { ok: false, text: outcome.reason ?? MSG.approvalDenied }
    }
    const result = await view.invoke(name, args, { callId: params.callId })
    if (!result.ok) return { ok: false, text: result.text }
    const output = result.output
    // 圖一律用 data URL:https 會被 app-server 擋掉,file:// 會多跑一顆 codex 自己的 view_image(RESULTS-22 §1)。
    return output.kind === 'image'
      ? { ok: true, text: output.text, imageDataUrl: toDataUrl({ mimeType: output.mimeType, dataBase64: output.dataBase64 }) }
      : { ok: true, text: output.text }
  }
```

5. `onDynamicToolCall` 的簽名與開頭改成:

```ts
  const onDynamicToolCall = async (
    tool: string,
    args: unknown,
    params: DynamicToolCallParams
  ): Promise<CodexToolOutcome> => {
    const view = deps.viewTools
    const viewName = asViewToolName(tool)
    if (view !== undefined && viewName !== undefined) return await runViewTool(view, viewName, args, params)
    const peer = deps.peerTools
    if (peer === undefined) return { ok: false, text: PEER_MSG.peerToolsMissing }
    …以下原樣不動…
```

6. `ensureClient` 裡組 dynamicTools:

```ts
    const dynamicTools = [
      ...(deps.viewTools === undefined ? [] : codexViewToolSpecs()),
      ...(deps.peerTools === undefined ? [] : codexPeerToolSpecs()),
    ]
```
並把原本那一行 `...(deps.peerTools === undefined ? {} : { dynamicTools: codexPeerToolSpecs(), onDynamicToolCall }),` 換成:
```ts
      ...(dynamicTools.length === 0 ? {} : { dynamicTools, onDynamicToolCall }),
```

7. `handoffDone` 換成:

```ts
    handoffDone(toolUseId) {
      const view = deps.viewTools
      if (view === undefined) {
        deps.logError(new Error(`codex 對話沒有接右窗格工具,交接 ${toolUseId} 無處可送`))
        return
      }
      view.handoffDone(toolUseId)
    },
```

`src/renderer/components/ConversationPane.tsx`:第 20 行的 import 改成
`import { isViewToolName } from '../../shared/view-tools.js'`(`REQUEST_HANDOFF_TOOL` 若無其他用途就移除),
`renderToolOverride` 的比對改成:

```ts
  const renderToolOverride = useCallback(
    // codex 那側工具名是平鋪的 `request_handoff`,Claude 那側帶 `mcp__yeschef__` 前綴,兩種都要畫成交接卡。
    (block: ToolBlock, historical: boolean) =>
      isViewToolName(block.name, 'request_handoff') ? (
        <HandoffCard block={block} historical={historical} onDone={api.handoffDone} />
      ) : undefined,
    [api]
  )
```

- [ ] **Step 4:全綠。** `npm run typecheck`、`npx vitest run`、`npm run test:coverage`、`npm run build` 全過。
- [ ] **Step 5:`git commit -m "feat: codex 對話接上右窗格八個工具與批准、交接"`**

---

### Task 4:接線 —— codex slot 拿 runtime,前景守衛與切走中止生效

**Files:**
- Modify: `src/main/ipc-bridge.ts:56-62`(`ProjectRuntime` 加 `codexViewTools`)、`:265-282`(codex 分支也拿 `runtimeFor`,把 `codexViewTools` 交下去,回傳 `{ core, runtime, … }`)、`:90-98`(`Slot.runtime` 的註解改掉)
- Modify: `src/main/index.ts:305-327`(`runtimeFor` 回傳值加 `codexViewTools`)
- Test: `tests/ipc-bridge.test.ts`(rig 的假 `runtimeFor` 補 `codexViewTools`;改兩條既有測試;加三條)

**Interfaces:**

```ts
// src/main/ipc-bridge.ts 的 ProjectRuntime 加一條
/** codex 對話用的右窗格工具(codex view tools 規格 §4.3)。Claude 那側走 sessionOptions 裡的 MCP server。 */
readonly codexViewTools?: CodexViewTools
```

`switchTo`(`ipc-bridge.ts:316-325`)已經是 `prev.runtime?.viewTools?.abortPending(MSG.browserBusy)`,`closeSlot`(`:333-349`)已經是 `slot.runtime?.dispose?.()`。codex slot 一旦帶了 `runtime`,這兩條就自動對它生效,不必改那兩支。前景守衛同理:`runtimeFor` 收到的 `isActive` 是 `() => currentId === conversationId`,`forProject` 把它交給 `invokeTool` 的第一道守衛。

- [ ] **Step 1:寫失敗測試。**

`tests/ipc-bridge.test.ts` 的 rig(第 144-163 行那個假 `runtimeFor`)在 `viewTools` 之後補一段:

```ts
        codexViewTools: {
          invoke: async (name: string, _args: unknown, ctx: { callId: string | null }) => {
            invokes.push(`${conversationId}:${name}:${ctx.callId ?? '-'}`)
            return { ok: true, output: { kind: 'text', text: '好了' } }
          },
          handoffDone: (toolUseId: string) => { log.push(`${conversationId}.handoffDone(${toolUseId})`) },
        },
```

並在 rig 上方 `const aborts: string[] = []` 旁邊加 `const invokes: string[] = []`,回傳物件(第 215 行那個 `return { … }`)加上 `invokes`。

改既有兩條:

```ts
  // 原「provider 為 codex 的分頁用 codex 工廠,cwd 是專案根目錄,不呼叫 runtimeFor」
  it('provider 為 codex 的分頁用 codex 工廠,cwd 是專案根目錄,並拿到右窗格工具', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    const d = rig.codexDeps.get('tab-ax')
    expect(d?.cwd).toBe('/private/tmp/alpha')
    expect(d?.initialThreadId).toBeUndefined()
    expect(d?.viewTools).toBeDefined()
  })

  // 原「codex slot 收掉時不會去拆不存在的 runtime」
  it('codex slot 收掉時連它的 runtime 一起拆(核心先收完才拆)', async () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.log.length = 0
    rig.service.update((s) => closeTab(s, A, 'tab-ax', NOW + 4))
    await tick()
    expect(rig.log.indexOf('tab-ax.dispose')).toBeGreaterThanOrEqual(0)
    expect(rig.log.indexOf('tab-ax.runtime.dispose')).toBeGreaterThan(rig.log.indexOf('tab-ax.dispose'))
    expect(rig.errors).toEqual([])
  })
```

加三條:

```ts
  it('codex 分頁切走時,它的右窗格呼叫收到 browserBusy(規格 §4.3)', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.aborts.length = 0
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 4))
    expect(rig.aborts).toContain(`tab-ax:${MSG.browserBusy}`)
  })

  it('codex 核心拿到的 viewTools 就是那個分頁自己的 runtime 那一份', async () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    await rig.codexDeps.get('tab-ax')?.viewTools?.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-1' })
    expect(rig.invokes).toContain('tab-ax:view_click:exec-1')
  })

  it('handoff:done 送到前景的 codex 分頁,轉進它的 runtime', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.log.length = 0
    rig.fire(IPC.handoffDone, { toolUseId: 'exec-2' })
    expect(rig.log).toContain('tab-ax.handoffDone(exec-2)')
  })
```

第三條要靠假 core 真的把 `handoffDone` 轉進 `deps.viewTools`。`makeFakeCore` 只記 `tab-ax.handoffDone(exec-2)` 這種呼叫記錄,不會碰 `deps.viewTools`;所以改成斷言假 core 的記錄:

```ts
    expect(rig.log.some((l) => l.includes('tab-ax.handoffDone('))).toBe(true)
```

(真正「轉進 runtime」那一段由 Task 3 的 `codex-conversation.test.ts`「handoffDone 轉給 runtime 的交接」那條蓋住;這裡只驗 IPC 有走到 codex slot 的 core。)

`MSG` 的 import:檔頭加 `import { MSG } from '../src/main/view-tools/errors.js'`(若已存在就不重複)。

- [ ] **Step 2:確認失敗。** `npx vitest run tests/ipc-bridge.test.ts`:`d?.viewTools` 是 undefined、`tab-ax.runtime.dispose` 沒出現、`rig.aborts` 沒有 `tab-ax:…`。

- [ ] **Step 3:實作。**

`src/main/ipc-bridge.ts`:

1. import 加 `import type { CodexViewTools } from './codex/conversation.js'`(該檔已經 import `defaultCreateCodexConversation`,同一個模組)。
2. `ProjectRuntime` 加一條:

```ts
export interface ProjectRuntime {
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  readonly viewTools?: ViewToolHooks
  /** codex 對話用的右窗格工具(codex view tools 規格 §4.1)。Claude 那側走 sessionOptions 裡的 MCP server。 */
  readonly codexViewTools?: CodexViewTools
  /** 收掉這份執行環境專屬的資源(Task 10 的每專案 MCP server);core dispose 之後呼叫。 */
  readonly dispose?: () => void
}
```

3. `Slot.runtime` 的註解改成:

```ts
interface Slot {
  readonly core: Conversation
  /** 兩種 provider 都有:codex 不用 sessionOptions,但要同一份右窗格工具與前景守衛。 */
  readonly runtime?: ProjectRuntime
```

4. codex 分支(`:265-282`)換成:

```ts
    if (provider === 'codex') {
      // 規格 §4.3:codex 也要 runtime,switchTo 的 abortPending 與前景守衛才對它生效。
      const runtime = deps.runtimeFor(projectId, rootPath, () => currentId === conversationId, conversationId)
      const makeCodex = deps.createCodexConversation ?? defaultCreateCodexConversation
      const core = makeCodex({
        ...common,
        onSessionStarted: (sessionId, cwd) => recordStarted('codex', conversationId, projectId, sessionId, cwd),
        cwd: rootPath,
        ...(initialSessionId === undefined ? {} : { initialThreadId: initialSessionId }),
        ...(deps.peer === undefined ? {} : { peerTools: deps.peer.forConversation(conversationId) }),
        ...(runtime.codexViewTools === undefined ? {} : { viewTools: runtime.codexViewTools }),
      })
      registerPeer(core)
      return { core, runtime, projectId, rootPath }
    }
```

`src/main/index.ts` 的 `runtimeFor`(`:305-327`)最後那個 return 改成:

```ts
    if (shared === undefined || own === undefined) return { sessionOptions }
    return {
      sessionOptions,
      viewTools: {
        autoAllow: (toolName, toolUseId) => shared.autoAllow(toolName, toolUseId),
        handoffDone: (toolUseId) => shared.handoffDone(toolUseId),
        // 只中止這個專案自己的呼叫:切走或結束時不連累別的專案。
        abortPending: (reason) => own.abortPending(reason),
      },
      // codex 殼要的那一小片:呼叫與交接完成。批准、前景守衛、inflight 都在 own.invoke 裡。
      codexViewTools: {
        invoke: (name, args, ctx) => own.invoke(name, args, ctx),
        handoffDone: (toolUseId) => { shared.handoffDone(toolUseId) },
      },
      dispose: () => own.dispose(),
    }
```

- [ ] **Step 4:全綠。** `npm run typecheck`、`npx vitest run`、`npm run test:coverage`、`npm run build` 全過。
- [ ] **Step 5:`git commit -m "feat: codex 分頁接上每專案 runtime,前景互斥與切走中止生效"`**

---

## 驗收

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | codex 對話:`view_navigate` 開 example.com 再 `view_screenshot`,問大標題 | 答「Example Domain」;tool block 展開是圖不是 base64;截圖旁有「在側邊預覽開啟」 |
| 2 | codex 對話:`view_eval` 讀 `document.title` | 批准卡掛在那個 tool block 底下(卡的 toolUseId 等於那顆 item 的 id);允許後拿到標題 |
| 3 | codex 在跑 view 工具時切到另一個對話 | 它收到「瀏覽器正由前景對話使用」;切回來再叫可以 |
| 4 | codex 對話:`view_navigate` 開 `file:///etc/passwd` | 被 `checkNavigateUrl` 擋,回「只允許開啟 … 底下的本地檔案」 |
| 5 | codex `request_handoff` | 交接卡出現(不是普通 tool card);按完成後 codex 收到「使用者已完成,目前網址 …」並接續 |
| 6 | 關 app 重開,同一條 codex thread 再叫 `view_snapshot` | 可用(`thread/resume` 帶了 8 + 2 個 dynamicTools) |
| 7 | codex 傳一個型別不對的參數(例如 `view_click` 的 `ref` 給數字) | 回「view_click 的參數不合規:ref」,瀏覽器沒有動作 |
| 8 | Claude 對話跑一遍原本的八個工具 | 行為與改動前一字不差(Task 1 的既有測試沒改也全過) |

## 自我檢查

**一、規格涵蓋**

| 規格段落 | 落在哪 |
|---|---|
| §4.1 工具定義一份兩個殼 | Task 1(`tool-defs.ts`、`invoke`)、Task 3(`codexViewToolSpecs`、`onDynamicToolCall`) |
| §4.1 圖片回 `[inputText, inputImage]` | Task 2(`client.ts` 的 `toolResult`)、Task 3(`runViewTool` 產 `imageDataUrl`) |
| §4.1 錯誤回 `{ success:false, contentItems:[inputText] }` | Task 2(`toolResult` 吃 `ok:false`)、Task 3(`runViewTool` 的失敗路徑) |
| §4.2 批准:`ask` 的先 `requestApproval`,`toolUseId` 用 `callId` | Task 3(`runViewTool` 前半) |
| §4.3 前景互斥與切走中止 | Task 1(`invokeTool` 的 `isActive` 守衛)、Task 4(codex slot 拿 runtime) |
| §4.4 `request_handoff` 與 `handoffDone` | Task 1(`request_handoff` 用 `ctx.callId`)、Task 3(`handoffDone` 轉給 runtime) |
| §4.5 `extractImages` 認 `inputImage` | Task 2(`tool-images.ts`) |
| §3 的表:平鋪工具名、不用 `deferLoading`、不自己序列化、resume 帶工具 | Global Constraints 第 4 條;`codexViewToolSpecs` 不產 namespace 也不產 `deferLoading`;`client.ts` 的 `thread/resume` 帶 `dynamicTools` 那段不動 |
| §5 非目標:`view_eval` 以外不加批准、不做 MCP server、只有前景能用 | `runViewTool` 直接沿用 `viewToolPolicy`,沒有新政策;沒有新程序;守衛在 `invokeTool` |

規格沒寫、但驗收 #5 需要而本計畫補上的:`ConversationPane` 的交接卡比對從全名改成 `isViewToolName`(規格 §4.5 寫「畫面不改」,實際上不改就畫不出 codex 的交接卡)。

**二、佔位掃描**

全文沒有「照既有做法」「適當處理」「依情況」「視需要」這類字眼。需要看現場的地方都寫了檔名與行號:
`ipc-bridge.ts:56-62 / :90-98 / :265-282 / :316-325 / :333-349`、`index.ts:305-327`、
`ConversationPane.tsx:20 / :208-214`、`tests/ipc-bridge.test.ts:144-163 / :215`、
`tests/codex-conversation.test.ts` 的 15 處呼叫(452、462、473、484、493×2、501、509、520 起與 548 起的 `call(…)`、536)。
每段實作碼都是可直接貼的 TypeScript,沒有 `…省略…` 之外的空白(有 `…` 的兩處是明寫「以下原樣不動」的既有程式碼)。

**三、型別一致**

- `ToolCallContext` / `InvokeContext` / `ViewToolInvocation` / `ViewToolDef` 只在 `tool-defs.ts` 定義一次,`server.ts` 用 `export type { … }` 再匯出,`codex/conversation.ts` 直接從 `tool-defs.ts` 取(不繞經 `server.ts`,避免把 SDK 與 Electron 拉進 codex 那條路)。
- `invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>` 這個簽名在 Task 1(`ProjectViewTools`)、Task 3(`CodexViewTools`)、Task 4(`ProjectRuntime.codexViewTools` 與 `index.ts` 的實作)四處逐字相同。
- `CodexToolOutcome` 在 Task 2 定義,Task 3 的 `onDynamicToolCall` 與 `runViewTool` 都用它當回傳型別;`{ ok, text }` 的舊同伴路徑因為 `imageDataUrl` 是選填而不必改。
- `DynamicToolCallParams` 在 Task 2 定義(`client.ts`),Task 3 的 `onDynamicToolCall`、`runViewTool` 與測試的 `callParams()` helper 用同一個。
- `CodexViewTools` 在 Task 3 定義(`codex/conversation.ts`),Task 4 的 `ProjectRuntime` 以 `import type` 取用,方向是 ipc-bridge → codex,與既有的 `defaultCreateCodexConversation` 同向,不成環。
- `asViewToolName(name): ViewToolName | undefined` 在 Task 3 定義,`runViewTool` 的 `name: ViewToolName` 與 `fullToolName(name)` 都靠它收窄,沒有字串轉型。
