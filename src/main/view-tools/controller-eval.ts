/**
 * view_eval 與 request_handoff。兩個放一起的理由是它們都不碰 DOM 座標、
 * 也不等網路靜默，跟 page／input 兩組的流程沒有共用部分。
 */
import { MSG, ViewToolError } from './errors.js'
import { text, type ControllerCore } from './controller-core.js'
import { EVAL_MAX_CHARS, type ToolOutput } from './controller-types.js'

interface EvaluateResult {
  readonly result?: { readonly value?: unknown; readonly unserializableValue?: string }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

export function createEvalTools(core: ControllerCore): {
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  return {
    evaluate: (expression, signal) =>
      core.act(signal, async () => {
        const res = await call<EvaluateResult>('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        const details = res.exceptionDetails
        if (details !== undefined) {
          throw new ViewToolError(details.exception?.description ?? details.text ?? MSG.evalException)
        }
        // 裁決 28：NaN／Infinity／BigInt 只有 unserializableValue，value 是 undefined。
        // JSON.stringify 對 undefined／函式／symbol 也回 undefined，一併當成 'undefined'，
        // 不必為「值本身就是 undefined」另開一個特殊情況。
        const json = res.result?.unserializableValue ?? JSON.stringify(res.result?.value) ?? 'undefined'
        if (json.length <= EVAL_MAX_CHARS) return text(json)
        return text(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(json.length))
      }),

    // 不包 watcher.runAsAgent()：等待期間使用者的點擊與按鍵就是這個工具在等的事，
    // 要照常計入插手記錄，下一次 view_snapshot 才會告訴模型使用者做了什麼。
    requestHandoff: async (toolUseId, reason, signal) => {
      core.guard(signal)
      const { outcome } = await deps.handoff.begin(toolUseId, reason, signal)
      if (outcome === 'done') return text(MSG.handoffDone(deps.webContents.getURL()))
      if (outcome === 'timeout') return text(MSG.handoffTimeout(deps.webContents.getURL()))
      throw signal.reason instanceof Error ? signal.reason : new ViewToolError(MSG.sessionEnded)
    },
  }
}
