import { displayAttachmentPrompt } from './conversation-tools.js'
import { canonicalToolName } from './tool-name.js'
/**
 * SDK 事件到本專案窄型別的正規化層（規格 §4.1）。
 *
 * 兩個轉接器的參數是 `unknown` 而非 SDK 型別：這裡是與 SDK 交接的地方，SDK 版本一變型別標註就
 * 說謊，只有執行期檢查算數。認不出來的輸入一律產出 `unknown` Event；認得出來但沒有可渲染內容
 * 的那幾種（裁決 1 的窮舉清單）回空陣列，每一處都在註解寫明理由。
 */

export type Event =
  | { kind: 'session-start'; sessionId: string; cwd?: string; model?: string }
  | { kind: 'message-start'; messageId: string; model?: string }
  | {
      kind: 'block-start'
      messageId: string
      index: number
      blockType: 'text' | 'thinking' | 'tool_use'
      toolName?: string
      toolUseId?: string
    }
  | { kind: 'text-delta'; messageId: string; index: number; text: string }
  | { kind: 'thinking-delta'; messageId: string; index: number; text: string }
  | { kind: 'tool-input-delta'; messageId: string; index: number; partialJson: string }
  | { kind: 'block-stop'; messageId: string; index: number }
  // 完整快照。live 路徑在 delta 之後才到，歷史路徑只有這些。
  | { kind: 'text'; messageId?: string; index?: number; text: string }
  | { kind: 'thinking'; messageId?: string; index?: number; text: string }
  | {
      kind: 'tool-use'
      messageId?: string
      index?: number
      id: string
      name: string
      input: unknown
    }
  | { kind: 'tool-result'; id: string; content: unknown; isError: boolean }
  | { kind: 'tool-raw-output'; id: string; stdout: string; stderr: string; interrupted: boolean }
  | { kind: 'user-text'; text: string }
  /**
   * SDK 注入的 user 訊息,實務上就是 auto-compact 之後那份摘要。它的 role 是 user,
   * 但不是使用者說的話。兩條路徑的旗標名字不同(實測):live 串流是 `isSynthetic`,
   * `getSessionMessages()` 的歷史是 `isCompactSummary`,兩個都收。
   *
   * `isSynthetic` 的語意比「壓縮摘要」寬,SDK 之後若注入別種 user 訊息也會落到
   * 這一類。目前只觀察到壓縮摘要一種;真的出現別種時,這裡要改成分辨得出來的判別。
   */
  | { kind: 'compact-summary'; text: string }
  | { kind: 'permission-denied'; toolName: string; toolUseId: string; message?: string }
  /** SDK 的 `compact_boundary`:context 在這個位置被壓縮,之後的回合從 postTokens 開始長。 */
  | { kind: 'compact-boundary'; trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number }
  | {
      kind: 'session-end'
      isError: boolean
      costUsd?: number
      numTurns?: number
      /** 這一回合結束時該 session 累計的 token 數。codex 用它顯示用量;Claude 那條路不填。 */
      tokens?: number
      apiErrorStatus?: unknown
      // 2026-09-02 依裁決 17 新增：result 訊息的 errors（字串陣列）以 '\n' 接成一段文字。
      errorMessage?: string
    }
  // 2026-09-02 依裁決 22 新增：main 合成，normalizer 不產出。
  | { kind: 'reset' }
  | { kind: 'unknown'; raw: unknown }

/**
 * 這個事件算不算「這個回合 agent 已經有東西給人看了」。
 *
 * 用反向列舉而不是正向列舉:正向列舉過一次 Claude 的 streaming 詞彙
 * (block-start/text-delta/...),codex 的 mapper 產的是 tool-use/text/thinking,
 * 於是 codex 一輪先跑指令時整輪停在「模型思考中」。新增事件種類時預設算內容,
 * 漏列的後果是早一點顯示「執行中」,比整輪卡在思考中輕。
 *
 * 排除的五種:session-start 與 session-end 是回合的框,message-start 是還沒有內容的
 * 訊息骨架,user-text 是使用者自己說的話,reset 是重播前的清空。
 */
export function isTurnContentEvent(event: Event): boolean {
  switch (event.kind) {
    case 'session-start':
    case 'session-end':
    case 'message-start':
    case 'user-text':
    case 'reset':
      return false
    default:
      return true
  }
}

const unknownEvent = (raw: unknown): readonly Event[] => [{ kind: 'unknown', raw }]

// ---- 執行期型別守衛。對外來資料一律不信任 ----

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function asIndex(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}
function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : []
}
/** 2026-09-02 依裁決 17 新增：result 的 errors 欄位守衛，非字串陣列一律回 undefined。 */
function asStringArray(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as readonly string[])
    : undefined
}

// ---- content block 的映射。live 的完整快照與歷史共用同一份，形狀本來就一樣 ----

function assistantBlockToEvents(
  block: unknown,
  messageId: string | undefined,
  index: number | undefined
): readonly Event[] {
  const b = asRecord(block)
  if (b === null) return unknownEvent(block)
  const at = {
    ...(messageId === undefined ? {} : { messageId }),
    ...(index === undefined ? {} : { index }),
  }
  switch (b['type']) {
    case 'text': {
      const text = asString(b['text'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'text', ...at, text }]
    }
    case 'thinking': {
      const text = asString(b['thinking'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'thinking', ...at, text }]
    }
    case 'tool_use': {
      const id = asString(b['id'])
      const name = asString(b['name'])
      if (id === undefined || name === undefined) return unknownEvent(block)
      return [{ kind: 'tool-use', ...at, id, name: canonicalToolName(name), input: b['input'] }]
    }
    default:
      return unknownEvent(block)
  }
}

function userBlockToEvents(block: unknown): readonly Event[] {
  const b = asRecord(block)
  if (b === null) return unknownEvent(block)
  switch (b['type']) {
    case 'text': {
      const text = asString(b['text'])
      return text === undefined ? unknownEvent(block) : [{ kind: 'user-text', text: displayAttachmentPrompt(text) }]
    }
    case 'image':
      return [{ kind: 'user-text', text: '🖼️ 圖片附件' }]
    case 'document':
      return [{ kind: 'user-text', text: '📎 文件附件' }]
    case 'tool_result': {
      const id = asString(b['tool_use_id'])
      if (id === undefined) return unknownEvent(block)
      return [{ kind: 'tool-result', id, content: b['content'], isError: b['is_error'] === true }]
    }
    default:
      return unknownEvent(block)
  }
}

/**
 * `tool_use_result` 有兩種實測到的形狀，這裡統一成一種：
 * 物件 `{stdout, stderr, interrupted, ...}`（fixture 01／03），以及純字串（fixture 02 的
 * 權限拒絕，內容是 `Error: ... was blocked`）。字串就是那次執行的原始輸出，當成 stdout。
 * 規格 §6 的「展開後看得到未經處理的 stdout／stderr」只有這個來源。物件但沒有
 * stdout／stderr 的，是其他工具（Write／Edit／Read／Grep 等）的結構化結果，回空陣列。
 */
function rawOutputEvents(raw: unknown, toolUseId: string | undefined): readonly Event[] {
  if (raw === undefined || raw === null) return []
  if (toolUseId === undefined) return unknownEvent(raw)
  if (typeof raw === 'string') {
    return [{ kind: 'tool-raw-output', id: toolUseId, stdout: raw, stderr: '', interrupted: false }]
  }
  // MCP CallToolResult 的內容陣列已由 tool-result 帶著，不需要再產出一份原始輸出。
  if (Array.isArray(raw)) return []
  const r = asRecord(raw)
  if (r === null) return unknownEvent(raw)
  const stdout = asString(r['stdout'])
  const stderr = asString(r['stderr'])
  if (stdout === undefined && stderr === undefined) {
    // 非 Bash 工具的結構化結果（Write／Edit／Read／Grep 等，SDK ToolOutputSchemas 聯集，
    // 沒有共同欄位）：內容已在 tool_result 區塊裡，這裡沒有第二份可渲染的東西
    // （裁決 1 的「認得出來但沒有可渲染內容」；Ruling 14）。
    return []
  }
  return [
    {
      kind: 'tool-raw-output',
      id: toolUseId,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      interrupted: r['interrupted'] === true,
    },
  ]
}

function firstToolResultId(events: readonly Event[]): string | undefined {
  for (const e of events) if (e.kind === 'tool-result') return e.id
  return undefined
}

/**
 * `tool_use_result` 在 user 訊息的頂層，不在 `content` 裡。它掛在同一則訊息的 tool_result 上。
 * 三道守衛與 `assistantMessageEvents` 對稱：`message` 不是物件、`content` 型別不對、整則產不出
 * 任何事件，都算畸形，回 `unknownEvent(msg)` 而非靜默回空陣列（修正回合 1）。
 */
/** 摘要的內容可能是字串或 text block 陣列,兩種都收;都拿不到文字就回 undefined。 */
function compactSummaryText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  const texts = asArray(content).flatMap((b) => {
    const rec = asRecord(b)
    const text = rec === null ? undefined : asString(rec['text'])
    return rec?.['type'] === 'text' && text !== undefined ? [text] : []
  })
  return texts.length === 0 ? undefined : texts.join('')
}

function userMessageEvents(msg: Record<string, unknown>): readonly Event[] {
  const message = asRecord(msg['message'])
  if (message === null) return unknownEvent(msg)
  if (msg['isCompactSummary'] === true || msg['isSynthetic'] === true) {
    const text = compactSummaryText(message['content'])
    return text === undefined ? unknownEvent(msg) : [{ kind: 'compact-summary', text }]
  }
  const content = message['content']
  if (content !== undefined && typeof content !== 'string' && !Array.isArray(content)) {
    return unknownEvent(msg)
  }
  const blocks: readonly unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content)
  const fromBlocks = blocks.flatMap(userBlockToEvents)
  const events = [
    ...fromBlocks,
    ...rawOutputEvents(msg['tool_use_result'], firstToolResultId(fromBlocks)),
  ]
  return events.length === 0 ? unknownEvent(msg) : events
}

function assistantMessageEvents(
  msg: Record<string, unknown>,
  fallbackMessageId: string | undefined,
  openIndex: number | undefined
): readonly Event[] {
  const message = asRecord(msg['message'])
  if (message === null) return unknownEvent(msg)
  const messageId = asString(message['id']) ?? fallbackMessageId
  const blocks = asArray(message['content'])
  if (blocks.length === 0) return unknownEvent(msg)
  /**
   * 只有單一 block 時才敢貼 index。`includePartialMessages: true` 下 SDK 一個 block 發一則
   * assistant 訊息（實機查證：四份 fixture 全部的 assistant 訊息 content 長度都是 1），
   * 這時當下開著的 block index 就是它。多 block 時無從對應，index 留空，由 fold 依序附加。
   */
  const index = blocks.length === 1 ? openIndex : undefined
  return blocks.flatMap((b) => assistantBlockToEvents(b, messageId, index))
}

function resultEvents(msg: Record<string, unknown>): readonly Event[] {
  const costUsd = asNumber(msg['total_cost_usd'])
  const numTurns = asNumber(msg['num_turns'])
  const apiErrorStatus = msg['api_error_status']
  // 2026-09-02 依裁決 17：errors 是字串陣列且非空才接成 errorMessage，否則不帶該欄位。
  const errors = asStringArray(msg['errors'])
  const errorMessage = errors !== undefined && errors.length > 0 ? errors.join('\n') : undefined
  return [
    {
      kind: 'session-end',
      isError: msg['is_error'] === true,
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(numTurns === undefined ? {} : { numTurns }),
      ...(apiErrorStatus === undefined || apiErrorStatus === null ? {} : { apiErrorStatus }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
  ]
}

// ---- live 路徑的游標 ----

/**
 * `content_block_start` ／ `content_block_delta` ／ `content_block_stop` 這三種 stream event
 * **不帶 message id**（實機查證：整份 03 fixture 只有第 11、18、25、32、39、50 行出現 `msg_...`），
 * 而 index 每則訊息各自從 0 重數，所以去重鍵必須是 `(messageId, index)`。兩件事只能靠一個跨訊息
 * 的游標調和：`messageId` 由 `message_start` 設定，`openIndex` 記住當下開著的 block，
 * 用來把後到的完整快照貼回正確的 index。
 */
export interface LiveCursor {
  readonly messageId: string
  readonly model?: string
  readonly openIndex: number
}

export interface LiveStep {
  readonly events: readonly Event[]
  readonly cursor: LiveCursor
}

export const INITIAL_CURSOR: LiveCursor = { messageId: '', openIndex: -1 }

/**
 * 裁決 1 的「認得出來但沒有可渲染內容」清單，`system` 的部分：hook／status／
 * thinking_tokens／api_retry。它們對渲染沒有意義且數量大（54 行的 fixture 裡佔
 * 14 行；401 情境連續產生 10 張 `api_retry`，見任務 12B 修正 4）。其餘的 subtype
 * 一律產出 unknown。
 */
const SILENT_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'hook_started',
  'hook_response',
  'status',
  'thinking_tokens',
  'api_retry',
])

function systemStep(m: Record<string, unknown>, cursor: LiveCursor): LiveStep {
  const subtype = m['subtype']
  if (subtype === 'init') {
    const sessionId = asString(m['session_id'])
    if (sessionId === undefined) return { events: unknownEvent(m), cursor }
    const cwd = asString(m['cwd'])
    const model = asString(m['model'])
    return {
      events: [
        {
          kind: 'session-start',
          sessionId,
          ...(cwd === undefined ? {} : { cwd }),
          ...(model === undefined ? {} : { model }),
        },
      ],
      cursor,
    }
  }
  if (subtype === 'permission_denied') {
    const rawToolName = asString(m['tool_name'])
    const toolUseId = asString(m['tool_use_id'])
    if (rawToolName === undefined || toolUseId === undefined) return { events: unknownEvent(m), cursor }
    const toolName = canonicalToolName(rawToolName)
    const message = asString(m['message'])
    return {
      events: [
        {
          kind: 'permission-denied',
          toolName,
          toolUseId,
          ...(message === undefined ? {} : { message }),
        },
      ],
      cursor,
    }
  }
  if (subtype === 'compact_boundary') {
    const meta = m['compact_metadata']
    if (typeof meta !== 'object' || meta === null) return { events: unknownEvent(m), cursor }
    const md = meta as Record<string, unknown>
    const trigger = md['trigger']
    const preTokens = md['pre_tokens']
    if ((trigger !== 'manual' && trigger !== 'auto') || typeof preTokens !== 'number') {
      return { events: unknownEvent(m), cursor }
    }
    const postTokens = md['post_tokens']
    return {
      events: [
        {
          kind: 'compact-boundary',
          trigger,
          preTokens,
          ...(typeof postTokens === 'number' ? { postTokens } : {}),
        },
      ],
      cursor,
    }
  }
  if (typeof subtype === 'string' && SILENT_SYSTEM_SUBTYPES.has(subtype)) {
    return { events: [], cursor }
  }
  return { events: unknownEvent(m), cursor }
}

function streamEventStep(ev: Record<string, unknown>, cursor: LiveCursor): LiveStep {
  switch (ev['type']) {
    case 'message_start': {
      const message = asRecord(ev['message'])
      const messageId = message === null ? undefined : asString(message['id'])
      if (messageId === undefined) return { events: unknownEvent(ev), cursor }
      const model = message === null ? undefined : asString(message['model'])
      return {
        events: [{ kind: 'message-start', messageId, ...(model === undefined ? {} : { model }) }],
        cursor: { messageId, ...(model === undefined ? {} : { model }), openIndex: -1 },
      }
    }
    case 'content_block_start': {
      const index = asIndex(ev['index'])
      const cb = asRecord(ev['content_block'])
      const t = cb === null ? undefined : cb['type']
      const blockType = t === 'text' || t === 'thinking' || t === 'tool_use' ? t : undefined
      if (index === undefined || blockType === undefined || cb === null) {
        return { events: unknownEvent(ev), cursor }
      }
      const rawToolName = asString(cb['name'])
      const toolName = rawToolName === undefined ? undefined : canonicalToolName(rawToolName)
      const toolUseId = asString(cb['id'])
      return {
        events: [
          {
            kind: 'block-start',
            messageId: cursor.messageId,
            index,
            blockType,
            ...(toolName === undefined ? {} : { toolName }),
            ...(toolUseId === undefined ? {} : { toolUseId }),
          },
        ],
        cursor: { ...cursor, openIndex: index },
      }
    }
    case 'content_block_delta': {
      const index = asIndex(ev['index'])
      const d = asRecord(ev['delta'])
      if (index === undefined || d === null) return { events: unknownEvent(ev), cursor }
      const at = { messageId: cursor.messageId, index }
      switch (d['type']) {
        case 'text_delta': {
          const text = asString(d['text'])
          return text === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'text-delta', ...at, text }], cursor }
        }
        case 'thinking_delta': {
          const text = asString(d['thinking'])
          return text === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'thinking-delta', ...at, text }], cursor }
        }
        case 'input_json_delta': {
          const partialJson = asString(d['partial_json'])
          return partialJson === undefined
            ? { events: unknownEvent(ev), cursor }
            : { events: [{ kind: 'tool-input-delta', ...at, partialJson }], cursor }
        }
        // 裁決 1：signature_delta 是 thinking block 的密碼學簽章，不可顯示，也沒有任何
        // 可渲染內容。它認得出來，只是沒東西畫，所以回空陣列而不是產出一張原始 JSON 卡片。
        case 'signature_delta':
          return { events: [], cursor }
        default:
          return { events: unknownEvent(ev), cursor }
      }
    }
    case 'content_block_stop': {
      const index = asIndex(ev['index'])
      if (index === undefined) return { events: unknownEvent(ev), cursor }
      return {
        events: [{ kind: 'block-stop', messageId: cursor.messageId, index }],
        cursor: { ...cursor, openIndex: -1 },
      }
    }
    // 裁決 1：message_delta 帶的是 stop_reason 與 usage，統計已經由 result 訊息併進
    // session-end；message_stop 沒有任何欄位。兩者都認得出來但畫不出東西，回空陣列。
    // 游標不動：messageId 留到下一個 message_start 才換，跟其他不推進游標的分支一致。
    case 'message_delta':
    case 'message_stop':
      return { events: [], cursor }
    default:
      return { events: unknownEvent(ev), cursor }
  }
}

/**
 * live 轉接器：純函式，游標明著收進參數與回傳值。呼叫端（Task 8 的 agent-host）每場 session
 * 自己持有一份游標，從 `INITIAL_CURSOR` 起，每收一則訊息就把回傳的 `cursor` 存回去。
 */
export function stepLive(msg: unknown, cursor: LiveCursor): LiveStep {
  const m = asRecord(msg)
  if (m === null) return { events: unknownEvent(msg), cursor }
  switch (m['type']) {
    case 'system':
      return systemStep(m, cursor)
    case 'stream_event': {
      const ev = asRecord(m['event'])
      return ev === null ? { events: unknownEvent(m), cursor } : streamEventStep(ev, cursor)
    }
    case 'assistant': {
      const fallback = cursor.messageId === '' ? undefined : cursor.messageId
      const openIndex = cursor.openIndex >= 0 ? cursor.openIndex : undefined
      return { events: assistantMessageEvents(m, fallback, openIndex), cursor }
    }
    case 'user':
      return { events: userMessageEvents(m), cursor }
    case 'result':
      return { events: resultEvents(m), cursor }
    // 裁決 1：純粹的用量回報，認得出來但沒有可渲染內容。
    case 'rate_limit_event':
      return { events: [], cursor }
    default:
      return { events: unknownEvent(m), cursor }
  }
}

/**
 * `getSessionMessages()` 的產物。形狀是 `{type, uuid, session_id, message, ...}`：user 行的 `message`
 * 只有 `{role, content}`；assistant 行的 `message` 是完整的 API 訊息（`id`、`model`、`content`、`usage` 等）。
 * 沒有 stream event，所以不需要游標，也沒有 index。`messageId` 取 `message.id` 不取每行的 `uuid`：
 * 歷史檔把一則 API 訊息的每個 block 各寫成一行，fixture 04 的 4 行 assistant 只有 2 個 `message.id`。
 */
export function normalizeHistory(msg: unknown): readonly Event[] {
  const m = asRecord(msg)
  if (m === null) return unknownEvent(msg)
  switch (m['type']) {
    case 'user':
      return userMessageEvents(m)
    case 'assistant':
      return assistantMessageEvents(m, undefined, undefined)
    default:
      return unknownEvent(m)
  }
}
