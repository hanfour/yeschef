import { displayAttachmentPrompt } from '../../shared/conversation-tools.js'
/**
 * codex 的通知翻成 YesChef 的 `Event`(規格 §2 的對應表)。
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

export const CODEX_TOOL_NAMES = { command: 'Bash', fileChange: 'Edit', imageView: '截圖', sleep: '等待' } as const

/** codex 的 turn 中斷時給的訊息。 */
export const INTERRUPTED_MESSAGE = '回合已中斷'

export const MSG_NOT_LOGGED_IN = 'codex 未登入,請在終端執行 `codex login`'

/** codex 回的錯誤裡出現這些字就當成未登入(實機看到的是上游的 401 原文)。 */
const NOT_LOGGED_IN_HINTS = ['not logged in', 'unauthorized', 'api_key_required', '401']

/** 未登入的錯誤前面補一句可行動的提示;原文保留,它指得出實際的端點。 */
export function withAuthHint(message: string): string {
  const lower = message.toLowerCase()
  return NOT_LOGGED_IN_HINTS.some((h) => lower.includes(h)) ? `${MSG_NOT_LOGGED_IN}(${message})` : message
}

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

/**
 * 沒有專門畫法的 item。畫成以 `type` 命名的工具區塊,參數是它自己的欄位。
 *
 * codex 的 item 種類會一直長(schema 目前有 19 種,我們專門畫的只有一部分:
 * `codex app-server generate-json-schema` 的 `ThreadItem` 是權威清單)。
 * 一種一種追,漏掉的就變成畫面上一個空的「未知事件」,真實使用十分鐘就冒出十幾個。
 * 這裡把預設路徑做成「看得懂」,新種類不必等我們補也有內容;真正畸形的
 * (沒有 type 或沒有 id)才回 unknown。
 */
function genericItem(item: Record<string, unknown>, id: string, done: boolean): readonly Event[] {
  const type = str(item['type'])
  if (type === undefined) return unknownEvent(item)
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (key === 'type' || key === 'id') continue
    fields[key] = value
  }
  if (!done) return [{ kind: 'tool-use', messageId: id, index: 0, id, name: type, input: fields }]
  const status = str(item['status'])
  return [{ kind: 'tool-result', id, content: fields, isError: status !== undefined && status !== 'completed' }]
}

function itemStarted(item: Record<string, unknown>): readonly Event[] {
  const id = str(item['id'])
  if (id === undefined) return []
  switch (item['type']) {
    case 'userMessage':
      // codex 把使用者自己的訊息回送一次,本機已經推過,不重複畫。
      return []
    case 'agentMessage':
    case 'reasoning':
      // 內容由 delta 與 completed 帶,開始的時候沒有東西可畫。
      return []
    case 'commandExecution':
      return [{ kind: 'tool-use', messageId: id, index: 0, id, name: CODEX_TOOL_NAMES.command, input: { command: item['command'], cwd: item['cwd'] } }]
    case 'fileChange':
      return [{ kind: 'tool-use', messageId: id, index: 0, id, name: CODEX_TOOL_NAMES.fileChange, input: { changes: item['changes'] } }]
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const tool = str(item['tool'])
      return tool === undefined ? unknownEvent(item) : [{ kind: 'tool-use', messageId: id, index: 0, id, name: tool, input: item['arguments'] }]
    }
    // codex 看一張圖(例如它自己截的畫面)。這裡只畫路徑:整個專案還沒有畫圖片的地方,
    // 右窗格的截圖工具也一樣,那是另一件事。
    case 'imageView':
      return [{ kind: 'tool-use', messageId: id, index: 0, id, name: CODEX_TOOL_NAMES.imageView, input: { path: item['path'] } }]
    // codex 自己在等。不畫的話畫面會安靜好幾十秒,看不出它在做什麼。
    case 'sleep':
      return [{ kind: 'tool-use', messageId: id, index: 0, id, name: CODEX_TOOL_NAMES.sleep, input: { durationMs: item['durationMs'] } }]
    default:
      return genericItem(item, id, false)
  }
}

function itemCompleted(item: Record<string, unknown>): readonly Event[] {
  const id = str(item['id'])
  if (id === undefined) return []
  const status = str(item['status'])
  const isError = status !== undefined && status !== 'completed'
  switch (item['type']) {
    case 'userMessage':
      // codex 把使用者自己的訊息回送一次,本機已經推過,不重複畫。
      return []
    case 'agentMessage': {
      const text = str(item['text'])
      return text === undefined ? unknownEvent(item) : [{ kind: 'text', messageId: id, index: 0, text }]
    }
    case 'reasoning': {
      const summary = joinText(item['summary'])
      const text = summary === '' ? joinText(item['content']) : summary
      return text === '' ? [] : [{ kind: 'thinking', messageId: id, index: 0, text }]
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
    case 'imageView':
      return [{ kind: 'tool-result', id, content: { path: item['path'] ?? null, status: status ?? null }, isError }]
    case 'sleep':
      return [{ kind: 'tool-result', id, content: { durationMs: item['durationMs'] ?? null, status: status ?? null }, isError }]
    case 'contextCompaction':
      // codex 沒有給壓縮前後的 token 數,分隔線只畫「對話已壓縮」,不畫數字(規格 §2)。
      return [{ kind: 'compact-boundary', trigger: 'auto' }]
    default:
      return genericItem(item, id, true)
  }
}

function turnCompleted(params: Record<string, unknown>, totalTokens: number | undefined): readonly Event[] {
  const turn = params['turn']
  if (!isRecord(turn)) return []
  const status = str(turn['status'])
  const error = isRecord(turn['error']) ? str(turn['error']['message']) : undefined
  const errorMessage = status === 'interrupted' ? INTERRUPTED_MESSAGE : (error === undefined ? undefined : withAuthHint(error))
  const isError = status !== 'completed'
  return [{
    kind: 'session-end',
    isError,
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

/** 歷史沒有即時通知,先重建工具開頭再補結果;使用者文字只在歷史補回。 */
export function historyEvents(items: readonly unknown[]): readonly Event[] {
  return items.flatMap((item): readonly Event[] => {
    if (!isRecord(item)) return []
    if (item['type'] === 'userMessage') {
      if (typeof item['id'] !== 'string' || !Array.isArray(item['content'])) return []
      // schema 的 UserInput 也包含圖片與附件,只取文字項目並保留原順序。
      const text = item['content'].flatMap((part: unknown) =>
        isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : []
      ).join('\n')
      return [{ kind: 'user-text', text: displayAttachmentPrompt(text) }]
    }
    return [...itemStarted(item), ...itemCompleted(item)]
  })
}
