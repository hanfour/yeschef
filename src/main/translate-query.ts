import { parseTranslate, type TranslatePayload, type TranslateResult } from '../shared/ipc.js'
import type { TranslateDeps } from './translate.js'

interface TranslateQueryOptions {
  model: string
  tools: []
  maxTurns: 1
  thinking: { type: 'disabled' }
  persistSession: false
  cwd: string
  settingSources: []
  permissionMode: 'default'
  abortController: AbortController
}

export type TranslateQueryFn = (args: {
  prompt: string
  options: TranslateQueryOptions
}) => AsyncIterable<{ readonly type: string }>

/**
 * 只認得出 assistant 訊息裡的文字,認不出來的整個略過。
 *
 * 不用型別斷言:這裡是與 SDK 交接的地方,SDK 版本一變型別標註就說謊,只有執行期檢查算數
 * (同 `src/shared/events.ts` 開頭的理由)。形狀不符時當成沒有文字,不丟例外。
 */
function assistantText(message: { readonly type: string }): string {
  const content = (message as { readonly message?: { readonly content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block !== 'object' || block === null) return ''
      const record = block as { readonly type?: unknown; readonly text?: unknown }
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

export function createTranslateQuery(
  queryFn: TranslateQueryFn,
  /** 與任何專案無關的目錄;用 `process.cwd()` 會讓翻譯落到某個專案底下。 */
  userDataDir: string
): TranslateDeps['query'] {
  return async (prompt, model, signal) => {
    const abortController = new AbortController()
    const onAbort = (): void => { abortController.abort(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      const stream = queryFn({
        prompt,
        options: {
          model,
          tools: [],
          maxTurns: 1,
          // 翻譯不需要推理,思考只是多花時間與 token。實測同一段文字開著要 43 秒、關掉 15 秒。
          thinking: { type: 'disabled' as const },
          persistSession: false,
          // 不用 process.cwd()，避免繼承專案目錄，讓翻譯與專案歷史隔離。
          cwd: userDataDir,
          settingSources: [],
          permissionMode: 'default',
          abortController,
        },
      })
      let text = ''
      for await (const message of stream) {
        if (message.type !== 'assistant') continue
        text += assistantText(message)
      }
      return text
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

export function createTranslateHandler<Sender>(deps: {
  isAllowedSender(sender: Sender): boolean
  translate(payload: TranslatePayload): Promise<TranslateResult>
}): (event: { readonly sender: Sender }, raw: unknown) => Promise<TranslateResult> {
  return async (event, raw) => {
    if (!deps.isAllowedSender(event.sender)) return { kind: 'rejected', message: '不接受這個來源的請求' }
    const payload = parseTranslate(raw)
    if (payload === null) return { kind: 'rejected', message: 'payload 形狀不符' }
    return deps.translate(payload)
  }
}
