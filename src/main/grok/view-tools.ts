// src/main/grok/view-tools.ts
/**
 * `runtimeFor` 給 grok 分頁用的右窗格工具(grok 規格 §5.6、§6)。從 `index.ts` 抽出來,
 * 好讓 HTTP server 的延遲啟動與失敗重試單獨測試,不必整個開 Electron。
 *
 * 這裡也是 grok 這條路的批准閘門(規格 §7)。Claude 走 `autoAllow`、codex 走
 * `runViewTool`,兩者都在 yeschef 這側問過政策;grok 走 HTTP,中間沒有任何一層
 * 會問,所以閘門包在交給 `createConversationViewServer` 的 `resolve` 外面:政策是
 * `ask` 的工具先出一張批准卡,允許了才真的呼叫 `ViewTools.invoke`。
 */
import { VIEW_TOOL_SERVER_NAME, fullToolName, type ViewToolName } from '../../shared/view-tools.js'
import type { ApprovalAsk, ApprovalDecision } from '../approval.js'
import type { AcpMcpServer } from './client.js'
import type { GrokViewTools } from './conversation.js'
import { MSG } from '../view-tools/errors.js'
import { viewToolPolicy } from '../view-tools/policy.js'
import { startViewToolHttpServer, type ViewToolHttpServer } from '../view-tools/http-server.js'
import {
  createConversationViewServer,
  type ConversationViewServer, type ConversationViewServerDeps,
} from '../view-tools/conversation-server.js'
import type { ViewTools } from '../view-tools/server.js'

export interface CreateGrokViewToolsDeps {
  /** 一個 MCP session 一份 view server,所以這裡收的是建構參數而不是建好的那一份。 */
  readonly view: ConversationViewServerDeps
  readonly logError: (error: Error) => void
  readonly handoffDone: (toolUseId: string) => void
  /** 測試用接縫:換掉 HTTP server 的啟動函式。 */
  readonly start?: typeof startViewToolHttpServer
  /** 測試用接縫:換掉 view server 的建構函式。 */
  readonly createView?: typeof createConversationViewServer
}

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

/**
 * 第一次呼叫 `mcpServers()` 才真的 listen(規格 §6)。`http` 快取的是 promise,
 * 啟動失敗(listen 或 connect 失敗)那一次的 rejection 用完就丟。不清掉的話,
 * 這個分頁會被同一個失敗結果卡死,之後永遠開不了 session(複審找到的問題)。
 */
export function createGrokViewTools(deps: CreateGrokViewToolsDeps): GrokViewTools {
  const start = deps.start ?? startViewToolHttpServer
  const createView = deps.createView ?? createConversationViewServer
  let http: Promise<ViewToolHttpServer> | null = null
  let approve: ((ask: ApprovalAsk) => Promise<ApprovalDecision>) | null = null
  /** grok 的 `tools/call` 沒有帶 toolUseId,合成一個才綁得回批准卡(規格 §7)。 */
  let askSeq = 0

  const decide = async (name: string, args: unknown, callId: string | null): Promise<boolean> => {
    const ask = approve
    // 對話還沒把批准入口接上就有工具呼叫:沒有人能回答,拒絕比靜默執行安全。
    if (ask === null) return false
    askSeq += 1
    const decision = await ask({ toolUseId: callId ?? `grok-view-${askSeq}`, toolName: name, input: args })
    return decision === 'allow'
  }

  /** 政策是 ask 的工具先問使用者,拒絕就以文字回去,不呼叫底下的工具。 */
  const gate = (tools: ViewTools): ViewTools => ({
    ...tools,
    invoke: async (name, args, ctx) => {
      if (viewToolPolicy(fullToolName(name as ViewToolName), 'grok') !== 'ask') return tools.invoke(name, args, ctx)
      if (!await decide(name, args, ctx.callId)) return { ok: false, text: MSG.approvalDenied }
      return tools.invoke(name, args, ctx)
    },
  })

  const makeView = (): ConversationViewServer =>
    createView({ ...deps.view, resolve: async () => gate(await deps.view.resolve()) })

  const closeHttp = async (): Promise<void> => {
    const started = http
    http = null
    if (started === null) return
    try {
      await (await started).close()
    } catch (cause) {
      deps.logError(toError(cause))
    }
  }

  const mcpServers = async (): Promise<readonly AcpMcpServer[]> => {
    http ??= start(makeView, deps.logError).catch((cause: unknown) => {
      http = null
      throw cause
    })
    const server = await http
    // token 只出現在這裡,不寫檔、不進 log、不進事件、不進 renderer(grok 規格 §6.2)。
    return [{
      name: VIEW_TOOL_SERVER_NAME, type: 'http' as const, url: server.url,
      headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
    }]
  }

  return {
    mcpServers,
    useApproval: (request) => { approve = request },
    requestApproval: (toolName, input) => {
      askSeq += 1
      const request = approve
      return request === null ? Promise.resolve('deny') : request({
        toolUseId: `grok-view-${askSeq}`, toolName, input,
      })
    },
    handoffDone: deps.handoffDone,
    close: closeHttp,
  }
}
