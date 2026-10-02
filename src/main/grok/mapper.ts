/**
 * grok 的 ACP 通知翻成 YesChef 的 `Event`(grok 規格 §5.3)。
 *
 * 分界規則與 codex 那側一致:`_x.ai/*` 與 `available_commands_update` 與對話內容無關,
 * 回空陣列;認得是 `session/update` 但 `sessionUpdate` 不在表上的才回一則 `unknown`。
 *
 * grok 的 chunk 不帶訊息 id,所以 messageId 由這裡合成:`grok-<sessionId>-<turn>`。
 * 文字與思考各自佔一個區塊,index 在回合內遞增;工具沿用 codex 的做法,
 * messageId 就是 toolCallId、index 固定 0,畫面上那顆 block 才對得回來。
 */
import type { Event } from '../../shared/events.js'
import { isRecord } from '../../shared/ipc.js'

export const GROK_PLAN_TITLE = '計畫'

export interface GrokMapper {
  /** 一個回合的開始:換 messageId、重設區塊計數。userInput 與 openHistory 各呼叫一次。 */
  beginTurn(): void
  /** ACP 的通知。method 是原始方法名,含 `_x.ai/` 開頭的那些。 */
  accept(method: string, params: unknown): readonly Event[]
  /** `session/prompt` 的回應。回合結束的唯一依據(規格 §5.3)。 */
  promptFinished(stopReason: string | undefined): readonly Event[]
  /** 目前生效的模型;`_x.ai/session_notification` 的 model_changed 會改它。 */
  model(): string | undefined
}

type BlockType = 'text' | 'thinking'

/** 型別守衛共用 `shared/ipc.ts` 的 `isRecord`,這裡只是把它轉成「取不到就是 null」。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const unknownEvent = (raw: unknown): readonly Event[] => [{ kind: 'unknown', raw }]

/** ACP 的 content block。第一版只認文字;圖片與其他型別當看不懂。 */
function chunkText(update: Record<string, unknown>): string | undefined {
  const content = asRecord(update['content'])
  if (content === null || content['type'] !== 'text') return undefined
  return typeof content['text'] === 'string' ? content['text'] : undefined
}

/**
 * `_x.ai/session_notification` 的 model_changed。探測到的形狀與 `session/update` 同一種外形,
 * 只是 method 不同、模型欄位叫 `model_id`:
 * `{ sessionId, update: { sessionUpdate: 'model_changed', model_id, reasoning_effort } }`。
 * 同一個 method 也會送 `hook_execution`,那一種沒有東西可畫,回 undefined 就是忽略。
 */
function changedModel(params: unknown): string | undefined {
  const update = asRecord(asRecord(params)?.['update'])
  if (update === null || update['sessionUpdate'] !== 'model_changed') return undefined
  return str(update['model_id'])
}

export function createGrokMapper(sessionId: string, initialModel?: string): GrokMapper {
  let model = initialModel
  let turn = 0
  let messageId = `grok-${sessionId}-0`
  let started = false
  let nextIndex = 0
  let open: { readonly index: number; readonly type: BlockType } | null = null

  const closeOpen = (): readonly Event[] => {
    if (open === null) return []
    const event: Event = { kind: 'block-stop', messageId, index: open.index }
    open = null
    return [event]
  }

  /** 開一個文字或思考區塊,必要時先發 message-start、先收掉型別不同的前一塊。 */
  const head = (type: BlockType): readonly Event[] => {
    const before: Event[] = []
    if (!started) {
      started = true
      before.push({ kind: 'message-start', messageId, ...(model === undefined ? {} : { model }) })
    }
    if (open !== null && open.type === type) return before
    const closed = closeOpen()
    const index = nextIndex
    nextIndex += 1
    open = { index, type }
    return [...before, ...closed, { kind: 'block-start', messageId, index, blockType: type }]
  }

  const toolCall = (update: Record<string, unknown>): readonly Event[] => {
    const id = str(update['toolCallId'])
    if (id === undefined) return unknownEvent(update)
    const name = str(update['title']) ?? str(update['kind']) ?? 'tool'
    return [...closeOpen(), { kind: 'tool-use', messageId: id, index: 0, id, name, input: update['rawInput'] ?? null }]
  }

  const toolUpdate = (update: Record<string, unknown>): readonly Event[] => {
    const id = str(update['toolCallId'])
    if (id === undefined) return unknownEvent(update)
    const status = str(update['status'])
    // 只有結束的那一則要畫;in_progress 與純粹改標題的更新不產生事件。
    if (status !== 'completed' && status !== 'failed') return []
    const raw = asRecord(update['rawOutput'])
    const stdout = raw === null ? undefined : str(raw['stdout'])
    const result: Event = {
      kind: 'tool-result', id,
      content: update['content'] ?? update['rawOutput'] ?? null,
      isError: status === 'failed',
    }
    if (stdout === undefined) return [result]
    const stderr = raw === null ? undefined : str(raw['stderr'])
    return [result, { kind: 'tool-raw-output', id, stdout, stderr: stderr ?? '', interrupted: false }]
  }

  const plan = (update: Record<string, unknown>): readonly Event[] => {
    const entries = Array.isArray(update['entries']) ? update['entries'] : []
    const lines = entries.flatMap((entry: unknown) => {
      const content = str(asRecord(entry)?.['content'])
      return content === undefined ? [] : [`- ${content}`]
    })
    return lines.length === 0 ? [] : [...closeOpen(), { kind: 'text', text: `${GROK_PLAN_TITLE}\n${lines.join('\n')}` }]
  }

  const sessionUpdate = (params: unknown): readonly Event[] => {
    const record = asRecord(params)
    if (record === null) return []
    const update = asRecord(record['update'])
    if (update === null) return unknownEvent(params)
    switch (update['sessionUpdate']) {
      case 'agent_message_chunk': {
        const text = chunkText(update)
        if (text === undefined) return unknownEvent(update)
        const before = head('text')
        return [...before, { kind: 'text-delta', messageId, index: open?.index ?? 0, text }]
      }
      case 'agent_thought_chunk': {
        const text = chunkText(update)
        if (text === undefined) return unknownEvent(update)
        const before = head('thinking')
        return [...before, { kind: 'thinking-delta', messageId, index: open?.index ?? 0, text }]
      }
      case 'user_message_chunk': {
        const text = chunkText(update)
        return text === undefined ? unknownEvent(update) : [{ kind: 'user-text', text }]
      }
      case 'tool_call':
        return toolCall(update)
      case 'tool_call_update':
        return toolUpdate(update)
      case 'plan':
        return plan(update)
      // 斜線指令清單與對話內容無關,畫出來只會洗版。
      case 'available_commands_update':
        return []
      default:
        return unknownEvent(update)
    }
  }

  return {
    beginTurn() {
      turn += 1
      messageId = `grok-${sessionId}-${turn}`
      started = false
      nextIndex = 0
      open = null
    },
    accept(method, params) {
      if (method === 'session/update') return sessionUpdate(params)
      if (method === '_x.ai/session_notification') {
        const next = changedModel(params)
        if (next !== undefined) model = next
        return []
      }
      // `_x.ai/*` 的其餘通知與任何認不得的方法都不進對話;它們的內容由 client 寫 log。
      return []
    },
    promptFinished() {
      // `session/prompt` 的回應是回合結束的唯一依據,cancelled 也算結束(規格 §5.3)。
      return [...closeOpen(), { kind: 'session-end', isError: false }]
    },
    model: () => model,
  }
}
