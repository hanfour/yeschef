/**
 * 九個瀏覽器工具的定義,與後端無關(codex view tools 規格 §4.1)。
 * 這裡只有「名字、描述、參數形狀、怎麼呼叫 controller」;inflight、
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
  view_navigate: '在右窗格開啟一個網址，支援 http、https，以及專案目錄底下的 file。',
  view_snapshot: '列出右窗格目前可操作的元素與它們的 ref，操作前先呼叫這個。',
  view_screenshot: '對右窗格的可視範圍截一張圖，用於確認版面或圖片內容。',
  view_click: '點擊 view_snapshot 給的 ref 所指的元素。',
  view_type: '在 view_snapshot 給的 ref 所指的欄位輸入文字，可選擇先清空或輸入後送出。',
  view_press: '對右窗格送出一個按鍵，例如 Enter、Tab 或方向鍵。',
  view_eval: '在右窗格的主 frame 執行一段 JavaScript 並取回結果，每次都需要使用者批准。',
  request_handoff: '把右窗格交給使用者處理（例如登入或輸入驗證碼），等他按下「我好了」再繼續。',
  view_login: '用專案裡設定好的測試機帳密登入。先 view_snapshot 找到帳號欄與密碼欄的 ref。帳密由主行程填入，不會回傳給你。',
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
  defineTool('view_login', {
    machine: z.string(), usernameRef: z.string(), passwordRef: z.string(), submitRef: z.string().optional(),
  }, (c, a, _ctx, signal) => c.login(a.machine, a.usernameRef, a.passwordRef, a.submitRef, signal)),
]

/** 平鋪名字查定義;帶 `mcp__yeschef__` 前綴的查不到,那條路由 SDK 自己處理。 */
export function viewToolDef(name: string): ViewToolDef | undefined {
  return VIEW_TOOL_DEFS.find((def) => def.name === name)
}
