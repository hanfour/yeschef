// src/main/view-tools/conversation-server.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { PEER_MSG, PeerError } from '../peer/errors.js'
import type { PeerTools } from '../peer/service.js'
import { VIEW_TOOL_SERVER_NAME } from '../../shared/view-tools.js'
import { MSG } from './errors.js'
import { HANDOFF_TIMEOUT_MS, readToolUseId } from './handoff.js'
import { toErrorText, type ViewTools } from './server.js'
import { VIEW_TOOL_DEFS, type InvokeContext, type ViewToolInvocation } from './tool-defs.js'

export interface ConversationViewServerDeps {
  /**
   * 取得這個對話的 ViewTools(每對話瀏覽器規格 §4.3)。每次 invoke 都會呼叫一次,
   * 不是只有第一次:失敗時才有機會在下一次呼叫重試建立 view 與 CDP。實作必須
   * 自己 idempotent——已經建好就回傳既有的那一份,不要每次呼叫都重建。失敗就 reject。
   */
  readonly resolve: () => Promise<ViewTools>
  /** 給了就多掛 ask_peer 與 answer_peer;那兩個不需要瀏覽器,不會觸發 resolve。 */
  readonly peer?: PeerTools
  /**
   * 給了就把主廚的控制工具掛在同一份 server 上。只有 grok 的 worker 對話會給:
   * Claude 走 `sessionOptions.mcpServers.chef`、codex 走 dynamicTools,那兩條路自己有一份,
   * 這裡再掛一份會讓模型同時看到兩個 report_result。
   */
  readonly chefTools?: { readonly sdkTools: readonly SdkMcpToolDefinition[] }
  readonly logError: (error: Error) => void
}

export interface ConversationViewServer {
  readonly server: McpSdkServerConfigWithInstance
  /** Claude 與 codex 兩個殼共用的入口。永不 reject。 */
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  /** 之後的呼叫一律回 sessionEnded。session 本身由 browser-sessions 收。 */
  dispose(): void
}

const SERVER_VERSION = '0.1.0'
/**
 * 工具呼叫上限(裁決 32)。SDK 預設讀 MCP_TOOL_TIMEOUT 環境變數,明寫成 11 分鐘,
 * request_handoff 的 10 分鐘等待才不會被環境設定砍掉。
 */
const TOOL_CALL_TIMEOUT_MS = HANDOFF_TIMEOUT_MS + 60_000

/** 同伴問答的兩句話(P 規格 §4)。字串集中在 peer/errors.ts。 */
const PEER_TOOL_DESCRIPTIONS = {
  ask_peer: PEER_MSG.askPeerDescription,
  answer_peer: PEER_MSG.answerPeerDescription,
} as const

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

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function extraSignal(extra: unknown): AbortSignal | null {
  if (typeof extra !== 'object' || extra === null) return null
  const signal = (extra as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : null
}

/**
 * 同伴工具的外殼。與 `invoke` 的差別有兩個:不過瀏覽器(P 規格 §4:背景對話也要能問能答),
 * 也不進 inflight(等待由 service 自己的逾時收掉,不該被右窗格的 abortPending 打斷)。
 */
async function runPeerTool(
  logError: (error: Error) => void,
  action: () => Promise<string>
): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await action() }] }
  } catch (error) {
    if (error instanceof PeerError) return errorResult(error.message)
    return errorResult(toErrorText(error, logError))
  }
}

function createPeerTools(peer: PeerTools, logError: (error: Error) => void) {
  const always = { alwaysLoad: true }
  return [
    tool('ask_peer', PEER_TOOL_DESCRIPTIONS.ask_peer, {
      question: z.string(), to: z.string().optional(),
    }, (args) => runPeerTool(logError, () => peer.askPeer(args.question, args.to)), always),
    tool('answer_peer', PEER_TOOL_DESCRIPTIONS.answer_peer, {
      id: z.string(), text: z.string(),
    }, (args) => runPeerTool(logError, () => peer.answerPeer(args.id, args.text)), always),
  ]
}

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

/**
 * 一個對話一份 MCP server。工具有三組:右窗格工具(一定有)、同伴問答(有 peer 才有)、
 * 主廚控制工具(只有 grok 的 worker 對話才有,見 `chefTools` 的說明)。
 */
export function createConversationViewServer(deps: ConversationViewServerDeps): ConversationViewServer {
  let disposed = false
  const invoke = async (name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation> => {
    if (disposed) return { ok: false, text: MSG.sessionEnded }
    let tools: ViewTools
    try {
      tools = await deps.resolve()
    } catch (error) {
      deps.logError(error instanceof Error ? error : new Error(String(error)))
      return { ok: false, text: MSG.browserUnavailable }
    }
    // resolve 期間對話可能被關掉。
    if (disposed) return { ok: false, text: MSG.sessionEnded }
    return tools.invoke(name, args, ctx)
  }
  const server = createSdkMcpServer({
    name: VIEW_TOOL_SERVER_NAME,
    version: SERVER_VERSION,
    tools: [
      ...createTools(invoke),
      ...(deps.peer === undefined ? [] : createPeerTools(deps.peer, deps.logError)),
      ...(deps.chefTools === undefined ? [] : deps.chefTools.sdkTools),
    ],
    timeout: TOOL_CALL_TIMEOUT_MS,
  })
  return { server, invoke, dispose: () => { disposed = true } }
}
