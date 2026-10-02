/**
 * 把 Event 流投影成畫面要的 ConversationView（規格 4.2）。
 *
 * text、thinking、unknown 三種 Block 之外，tool block 的六個狀態推進也在這裡
 * （streaming-input / running / done / error / denied，awaiting-approval 由 Task 10 疊加）。
 */

import { parsePeerInjection } from './peer-tools.js'
import type { Event } from './events.js'

export interface ConversationView {
  readonly sessionId?: string
  readonly turns: readonly Turn[]
  readonly cost?: { readonly usd?: number; readonly turns?: number; readonly tokens?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增：session-end 的 isError:true 時由 fold() 設定，isError:false 維持 undefined。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

export interface Turn {
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
  readonly blocks: readonly Block[]
}

export type Block =
  | { readonly kind: 'text'; readonly markdown: string; readonly complete: boolean }
  | { readonly kind: 'thinking'; readonly text: string; readonly complete: boolean }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly inputPartial?: string
      readonly result?: unknown
      readonly deniedReason?: string
      readonly raw?: { readonly stdout: string; readonly stderr: string; readonly interrupted: boolean }
      readonly status: 'streaming-input' | 'awaiting-approval' | 'denied' | 'running' | 'done' | 'error'
    }
  | { readonly kind: 'compact-summary'; readonly text: string }
  | {
      readonly kind: 'peer-question'
      readonly questionId: string
      readonly fromLinkId: string
      readonly provider: string
      readonly text: string
    }
  | {
      readonly kind: 'compact-boundary'
      readonly trigger: 'manual' | 'auto'
      readonly preTokens?: number
      readonly postTokens?: number
    }
  | { readonly kind: 'unknown'; readonly raw: unknown }

/*
 * 內部工作模型：turn 的先後順序與身分，跟 turn 裝了哪些 block，分成兩份全域資料，
 * 不是每個 turn 自己揹一份 blocks 陣列。原因是去重規則的核心矛盾就發生在這裡：
 *
 * 規格明講去重鍵必須是 (messageId, index) 的組合，理由是 index 每則訊息各自從 0
 * 開始，只用 index 會把不同訊息的 block 混在一起。若實作把 block 直接放進各自
 * turn 自己的陣列裡（先用 messageId 找到 turn，再用 index 找 turn 內的 block），
 * messageId 這個維度其實已經靠「先找到哪個 turn」悄悄補上了，(messageId, index)
 * 會退化成只剩 index 在做事：那樣的話，去重鍵不管有沒有帶 messageId，結果都一樣，
 * 「把鍵改成只用 index」這種錯誤實作會完全測不出來，因為 turn 的分隔已經先擋掉問題。
 *
 * 所以這裡刻意用一份全域、跨所有 turn 的 records 清單，去重查找不先按 turn 分流，
 * 直接對整份清單比對鍵。這樣鍵要不要帶 messageId 才是唯一防線，錯了會真的讓兩則
 * 訊息的 index=0 撞在一起。turn 的先後順序另外記在 turnOrder，最後再用 turnId
 * 把 records 分組回各自的 turn。
 */

interface TurnMeta {
  readonly turnId: string
  readonly role: 'user' | 'assistant'
  readonly messageId?: string
}

/** key 為 null 表示不可去重（history 路徑的 assistant 訊息沒有 index），一律附加。 */
interface BlockRecord {
  readonly turnId: string
  readonly key: string | null
  readonly block: Block
}

interface WorkingView {
  readonly sessionId?: string
  readonly turnOrder: readonly TurnMeta[]
  readonly records: readonly BlockRecord[]
  readonly cost?: { readonly usd?: number; readonly turns?: number; readonly tokens?: number }
  readonly ended: boolean
  // 2026-09-02 依裁決 17 新增，見 sessionEndError。
  readonly error?: { readonly message?: string; readonly apiErrorStatus?: unknown }
}

const INITIAL_VIEW: WorkingView = { turnOrder: [], records: [], ended: false }

/**
 * 去重鍵：用 JSON.stringify 把 messageId 與 index 兩個維度編碼成同一個字串，
 * 不必自己挑分隔字元、也不必煩惱 messageId 裡會不會剛好出現那個分隔字元。
 * index 是 undefined 時代表 history 路徑的多 block 訊息（沒有 index 可用），
 * 回傳 null，呼叫端據此改成一律附加而非查表比對。
 */
function blockKey(messageId: string, index: number | undefined): string | null {
  return index === undefined ? null : JSON.stringify([messageId, index])
}

// ---- turn 身分：assistant 用 messageId 本身當 turnId，user 每次生一個新的 ----

function hasAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): boolean {
  return turnOrder.some((t) => t.role === 'assistant' && t.messageId === messageId)
}

/** 確保 messageId 有一個 assistant turn 存在；不存在就在陣列尾端新增。turnId 直接用 messageId。 */
function ensureAssistantTurn(turnOrder: readonly TurnMeta[], messageId: string): readonly TurnMeta[] {
  return hasAssistantTurn(turnOrder, messageId)
    ? turnOrder
    : [...turnOrder, { turnId: messageId, role: 'assistant' as const, messageId }]
}

/**
 * 全域去重：查找與寫入都對整份 records 清單直接比對 key，不先按 turnId 分流。
 * 這是讓「鍵要不要帶 messageId」這件事真正有意義的關鍵設計，見檔案開頭的說明。
 *
 * key 為 null（history 路徑，沒有 index）：一律新增一筆 record，不查表，效果
 * 等同附加在該 turn 的尾端（buildTurns 依 records 原始順序分組，天然保序）。
 * key 不為 null：查表命中就整份「取代」原本的 block（不是附加），查不到就新增
 * 並記住這把 key。build 收到既有 block（找不到就是 undefined），由呼叫端決定
 * 要不要延續舊內容（例如 text-delta 要接、完整快照要蓋）。
 */
function placeBlock(
  records: readonly BlockRecord[],
  turnId: string,
  key: string | null,
  build: (existing: Block | undefined) => Block
): readonly BlockRecord[] {
  const existing = key === null ? undefined : records.find((r) => r.key === key)
  if (existing === undefined) return [...records, { turnId, key, block: build(undefined) }]
  return records.map((r) => (r.key === key ? { ...r, block: build(existing.block) } : r))
}

// ---- text／thinking：delta 累加，完整快照取代 ----

function applyTextDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'text' ? existing.markdown : ''
    return { kind: 'text', markdown: prev + text, complete: false }
  })
}

function applyThinkingDelta(records: readonly BlockRecord[], messageId: string, index: number, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const prev = existing !== undefined && existing.kind === 'thinking' ? existing.text : ''
    return { kind: 'thinking', text: prev + text, complete: false }
  })
}

/**
 * 完整快照「取代」delta 累積出來的內容，不是附加：同一份內容用兩種方式送達，
 * 只算一份。key 為 null（history，無 index）時 placeBlock 一律新增，效果等同附加。
 * complete 延續既有值：block-stop 或 session-end 先到或後到都不影響這裡的判斷，
 * 這裡只是不要把已經標記的 complete 蓋回 false（見 applyBlockStop、applySessionEnd）。
 */
function applyTextSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'text' ? existing.complete : false
    return { kind: 'text', markdown: text, complete }
  })
}

function applyThinkingSnapshot(records: readonly BlockRecord[], messageId: string, index: number | undefined, text: string): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    const complete = existing !== undefined && existing.kind === 'thinking' ? existing.complete : false
    return { kind: 'thinking', text, complete }
  })
}

/**
 * complete 的來源之一（另外兩個是 applySessionEnd 與 user-text 建立時，見裁決
 * 5、15）。這裡只讓「收到 block-stop 的那一個」block 變完成，其餘不動。
 */
function applyBlockStop(records: readonly BlockRecord[], messageId: string, index: number): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing === undefined) {
      // 協定不應該讓 block-stop 搶在任何內容之前抵達；真的發生時不要吃掉這個事件，
      // 留一個看得見的痕跡而不是靜默略過。
      return { kind: 'unknown', raw: { note: 'block-stop 沒有對應的 block', messageId, index } }
    }
    if (existing.kind === 'text' || existing.kind === 'thinking') return { ...existing, complete: true }
    // tool／unknown 沒有 complete 欄位，block-stop 對它們沒有意義，維持原樣。
    return existing
  })
}

/**
 * complete 的另一個來源（裁決 5、15）：session-end 到達時，「其餘所有」
 * text／thinking block 一律變完成，不分是否曾收到各自的 block-stop。這裡回傳
 * 新陣列，每筆需要改的 record 也是新物件，不就地改動舊的。
 *
 * tool block 這裡不動：running -> done 的推進是裁決 15 的另一半，由
 * applyToolsSessionEnd 負責，兩者在同一個 case 疊加呼叫。
 *
 * 歷史路徑不是這裡的特例：載入端（Task 11 的 session-store.ts）在
 * normalizeHistory 產出的事件尾端補一筆 session-end，會自然走到這個函式，
 * fold() 本身不需要知道事件是從哪條路徑來的。
 */
function applySessionEnd(records: readonly BlockRecord[]): readonly BlockRecord[] {
  return records.map((r) => {
    if (r.block.kind !== 'text' && r.block.kind !== 'thinking') return r
    return { ...r, block: { ...r.block, complete: true } }
  })
}

/**
 * session-end 的第四個效果（裁決 17，跟上面的 complete 規則是兩件事）：isError 為 true
 * 時把 errorMessage／apiErrorStatus 收進 view.error，兩個欄位都用條件展開避免寫入
 * undefined 鍵；isError 為 false 時回傳 undefined，讓 error 維持不設。
 */
function sessionEndError(
  event: Extract<Event, { kind: 'session-end' }>
): WorkingView['error'] {
  if (event.isError !== true) return undefined
  return {
    ...(event.errorMessage === undefined ? {} : { message: event.errorMessage }),
    ...(event.apiErrorStatus === undefined ? {} : { apiErrorStatus: event.apiErrorStatus }),
  }
}

/**
 * session-end 的 cost 欄位（Task 4B 控制端修訂 1，比照上面 sessionEndError 的寫法）：
 * costUsd／numTurns 至少一個有值才建立 cost 物件，兩者都缺席時回傳 undefined，讓
 * 呼叫端維持不設。Task 4 原本無條件建立 `cost: {}`，歷史路徑補的 session-end 沒有
 * 這兩個欄位，會讓 view.cost 變成 `{}` 而不是 undefined，UI 以 `cost !== undefined`
 * 判斷要不要畫 footer，因而在歷史對話多畫一個空的 cost footer。
 * tokens 也算一種 cost 來源（codex 用），單獨有值時同樣建立 cost 物件。
 */
function sessionEndCost(
  event: Extract<Event, { kind: 'session-end' }>
): WorkingView['cost'] {
  if (event.costUsd === undefined && event.numTurns === undefined && event.tokens === undefined) return undefined
  return {
    ...(event.costUsd === undefined ? {} : { usd: event.costUsd }),
    ...(event.numTurns === undefined ? {} : { turns: event.numTurns }),
    ...(event.tokens === undefined ? {} : { tokens: event.tokens }),
  }
}

// ---- tool_use：block-start 的最小佔位 ----

function applyBlockStart(
  records: readonly BlockRecord[],
  messageId: string,
  index: number,
  blockType: 'text' | 'thinking' | 'tool_use',
  toolName: string | undefined,
  toolUseId: string | undefined
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, () => {
    if (blockType === 'text') return { kind: 'text', markdown: '', complete: false }
    if (blockType === 'thinking') return { kind: 'thinking', text: '', complete: false }
    return { kind: 'tool', id: toolUseId ?? '', name: toolName ?? '', input: undefined, status: 'streaming-input' }
  })
}

/**
 * 完整快照到達：填 input 並推進到 running。live 路徑上 block-start 已經放了佔位，
 * history 路徑沒有 block-start，tool-use 快照是該工具呼叫唯一會抵達的事件，這裡新建。
 * 兩者的差別已經完全由「existing 有沒有東西」表達，不必另外分支。
 *
 * 這裡不會產生 awaiting-approval：Event 聯集裡沒有任何一種事件代表「正在等待批准」，
 * 批准走的是 canUseTool 加 IPC，跟 SDK 訊息流是兩條分開的管線。fold() 誠實地推進到
 * 它唯一能確定的下一步 running，等待批准的視覺由 Task 10 的 applyPendingApprovals 疊加。
 */
function applyToolUseSnapshot(
  records: readonly BlockRecord[],
  messageId: string,
  index: number | undefined,
  id: string,
  name: string,
  input: unknown
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing !== undefined && existing.kind === 'tool') {
      return { ...existing, id, name, input, status: 'running' }
    }
    return { kind: 'tool', id, name, input, status: 'running' }
  })
}

// ---- 工具區塊狀態機（tool-input-delta／tool-result／tool-raw-output／permission-denied）----

type ToolBlock = Extract<Block, { kind: 'tool' }>

/** tool-input-delta：累積進 inputPartial，狀態不變。 */
function applyToolInputDelta(
  records: readonly BlockRecord[],
  messageId: string,
  index: number,
  partialJson: string
): readonly BlockRecord[] {
  const key = blockKey(messageId, index)
  return placeBlock(records, messageId, key, (existing) => {
    if (existing !== undefined && existing.kind === 'tool') {
      return { ...existing, inputPartial: (existing.inputPartial ?? '') + partialJson }
    }
    // 協定應該保證 block-start 先到，這裡仍防禦性地開一個佔位承接，不吃掉事件。
    return { kind: 'tool', id: '', name: '', input: undefined, inputPartial: partialJson, status: 'streaming-input' }
  })
}

/**
 * 依 id（不是 messageId／index）找到對應的 tool block 並用 updater 更新它。
 * tool-result／tool-raw-output／permission-denied 三種事件只帶 id，契約的 Event 型別
 * 就是這樣定義的，沒得選。找不到就不靜默丟棄，用 applyUnknown 掛一個看得見的痕跡。
 */
function updateToolBlock(
  view: WorkingView,
  id: string,
  orphanNote: string,
  updater: (existing: ToolBlock) => ToolBlock
): WorkingView {
  const idx = view.records.findIndex((r) => r.block.kind === 'tool' && r.block.id === id)
  if (idx === -1) return applyUnknown(view, { note: orphanNote, id })
  const target = view.records[idx]
  const existingBlock = target?.block
  if (target === undefined || existingBlock === undefined || existingBlock.kind !== 'tool') return view
  const updatedRecord = { ...target, block: updater(existingBlock) }
  return { ...view, records: view.records.map((r, i) => (i === idx ? updatedRecord : r)) }
}

/**
 * tool-result：done／error。denied 是終態，一旦被拒絕，之後補到的 tool-result
 * （SDK 會生成一則「已封鎖」的合成結果讓對話能繼續）不得把 denied 蓋回 error。
 * 這正是 fixture 02 的真實序列（permission_denied 先到，隨後 user 訊息帶
 * isError:true 的 tool_result），不擋的話 UI 會把「使用者拒絕」顯示成「執行失敗」。
 */
function applyToolResult(view: WorkingView, id: string, content: unknown, isError: boolean): WorkingView {
  return updateToolBlock(view, id, 'tool-result 沒有對應的 tool block', (existing) =>
    existing.status === 'denied' ? existing : { ...existing, result: content, status: isError ? 'error' : 'done' }
  )
}

/**
 * tool-raw-output：填 raw，狀態不變，不受 denied／error／done 影響。裁決 4：
 * history 路徑永遠不會有這個事件，所以 history 的 tool block 的 raw 永遠停在
 * undefined，這是刻意的缺席，不是遺漏。
 */
function applyToolRawOutput(
  view: WorkingView,
  id: string,
  stdout: string,
  stderr: string,
  interrupted: boolean
): WorkingView {
  return updateToolBlock(view, id, 'tool-raw-output 沒有對應的 tool block', (existing) => ({
    ...existing,
    raw: { stdout, stderr, interrupted },
  }))
}

/**
 * permission-denied：denied，是終態（見 applyToolResult 的說明）。裁決 12：拒絕理由
 * 填 deniedReason，不塞進 result（result 的語意是工具的執行結果，被拒絕的工具根本
 * 沒有執行）。message 缺席時給一句預設文案，UI 不必另外處理「denied 但沒有理由」。
 */
function applyPermissionDenied(view: WorkingView, toolUseId: string, message: string | undefined): WorkingView {
  return updateToolBlock(view, toolUseId, 'permission-denied 沒有對應的 tool block', (existing) => ({
    ...existing,
    status: 'denied',
    deniedReason: message ?? '權限被拒絕',
  }))
}

/**
 * session-end 收尾工具區塊（裁決 15，另一半是 applySessionEnd，只碰 text／thinking）：
 * running 收尾成 done，result 維持 undefined（沒有真正的結果，不造假一個）。
 * streaming-input 一併收尾：query 已經結束，輸入快照卻還沒到，代表串流被中斷，
 * 不可能再有內容進來。denied／done／error 已經是終態，原樣不動。
 *
 * 只碰 kind === 'tool' 的 record，跟 applySessionEnd 操作不相交的 block kind，
 * 兩者在 applyEvent 的 session-end case 疊加呼叫，順序不影響結果。
 */
function applyToolsSessionEnd(records: readonly BlockRecord[]): readonly BlockRecord[] {
  return records.map((r) => {
    if (r.block.kind !== 'tool') return r
    if (r.block.status !== 'running' && r.block.status !== 'streaming-input') return r
    return { ...r, block: { ...r.block, status: 'done' as const } }
  })
}

// ---- user turn：每個 user-text 都開一個新 turn，不嘗試合併 ----

/**
 * 使用者文字。注入的同伴提問走的是同一條路(它在 SDK 眼裡就是一則 user 訊息),
 * 所以在這裡解析一次:認得出來就自成一輪畫成同伴提問,認不出來照舊是文字。
 * live 與歷史共用這一個入口,不必兩套規則(P 規格 §6.2)。
 */
function applyUserText(view: WorkingView, text: string): WorkingView {
  const injection = parsePeerInjection(text)
  if (injection === null) return applyUserTurn(view, { kind: 'text', markdown: text, complete: true })
  return applyUserTurn(view, {
    kind: 'peer-question',
    questionId: injection.questionId,
    fromLinkId: injection.fromLinkId,
    provider: injection.provider,
    text: injection.text,
  })
}

/** 摘要自成一個 turn:它在對話裡的位置就是壓縮發生的位置,不併進前後任何一輪。 */
function applyCompactSummary(view: WorkingView, text: string): WorkingView {
  return applyUserTurn(view, { kind: 'compact-summary', text })
}

function applyUserTurn(view: WorkingView, block: Block): WorkingView {
  const turnId = 'user-' + String(view.turnOrder.length)
  return {
    ...view,
    turnOrder: [...view.turnOrder, { turnId, role: 'user' as const }],
    records: [...view.records, { turnId, key: null, block }],
  }
}

/**
 * 沒有任何 turn 可歸屬、又不能靜默丟棄的事件（Task 3 判定「認不出來」而產出的
 * unknown，以及缺 messageId 的完整快照）：掛到目前最後一個 turn 上；連一個 turn
 * 都還沒有就新開一個 assistant turn 來裝它，避免事件憑空消失。
 */
function applyUnknown(view: WorkingView, raw: unknown): WorkingView {
  return appendToLastTurn(view, { kind: 'unknown', raw })
}

/** 壓縮分隔線不屬於任何 message,歸屬規則與 unknown 相同:掛到最後一個 turn。 */
function applyCompactBoundary(
  view: WorkingView,
  event: Extract<Event, { kind: 'compact-boundary' }>
): WorkingView {
  return appendToLastTurn(view, {
    kind: 'compact-boundary',
    trigger: event.trigger,
    ...(event.preTokens === undefined ? {} : { preTokens: event.preTokens }),
    ...(event.postTokens === undefined ? {} : { postTokens: event.postTokens }),
  })
}

function appendToLastTurn(view: WorkingView, block: Block): WorkingView {
  const last = view.turnOrder[view.turnOrder.length - 1]
  if (last === undefined) {
    const turnId = 'unknown-' + String(view.turnOrder.length)
    return {
      ...view,
      turnOrder: [...view.turnOrder, { turnId, role: 'assistant' as const }],
      records: [...view.records, { turnId, key: null, block }],
    }
  }
  return { ...view, records: [...view.records, { turnId: last.turnId, key: null, block }] }
}

// ---- 主 reduce：一個 Event 對應一次狀態轉換 ----

function applyEvent(view: WorkingView, event: Event): WorkingView {
  switch (event.kind) {
    case 'session-start':
      return { ...view, sessionId: event.sessionId }
    case 'message-start':
      return { ...view, turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId) }
    case 'block-start':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStart(view.records, event.messageId, event.index, event.blockType, event.toolName, event.toolUseId),
      }
    case 'text-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyTextDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'thinking-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyThinkingDelta(view.records, event.messageId, event.index, event.text),
      }
    case 'tool-input-delta':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyToolInputDelta(view.records, event.messageId, event.index, event.partialJson),
      }
    case 'block-stop':
      return {
        ...view,
        turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
        records: applyBlockStop(view.records, event.messageId, event.index),
      }
    case 'text':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyTextSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'thinking':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyThinkingSnapshot(view.records, event.messageId, event.index, event.text),
          }
    case 'tool-use':
      return event.messageId === undefined
        ? applyUnknown(view, event)
        : {
            ...view,
            turnOrder: ensureAssistantTurn(view.turnOrder, event.messageId),
            records: applyToolUseSnapshot(view.records, event.messageId, event.index, event.id, event.name, event.input),
          }
    // 這三種只帶 id，不帶 messageId／index，所以不呼叫 ensureAssistantTurn，
    // updateToolBlock 直接對 records 操作。
    case 'tool-result':
      return applyToolResult(view, event.id, event.content, event.isError)
    case 'tool-raw-output':
      return applyToolRawOutput(view, event.id, event.stdout, event.stderr, event.interrupted)
    case 'permission-denied':
      return applyPermissionDenied(view, event.toolUseId, event.message)
    case 'user-text':
      return applyUserText(view, event.text)
    case 'session-end': {
      // 裁決 17：error 是 session-end 的第四個效果，跟 ended／cost／block complete
      // 三件事並列，用同一次 reduce 更新算完，不另開一次遍歷。
      const error = sessionEndError(event)
      // Task 4B 控制端修訂 1：cost 比照 error 用條件展開，costUsd／numTurns 都缺席
      // 時不帶這個欄位，不建立 `{}`。
      const cost = sessionEndCost(event)
      return {
        ...view,
        ended: true,
        ...(cost === undefined ? {} : { cost }),
        // applySessionEnd 只碰 text／thinking，applyToolsSessionEnd 只碰 tool，
        // 兩者操作不相交的 block kind，疊加順序不影響結果。
        records: applyToolsSessionEnd(applySessionEnd(view.records)),
        ...(error === undefined ? {} : { error }),
      }
    }
    // 裁決 22：畫面從這裡重新開始。reset 由 Task 8 的 ipc-bridge 合成，正規化層不產出它。
    // 之前累積的 turn、block、sessionId、cost、error 全部丟掉，回到初始狀態。
    case 'reset':
      return INITIAL_VIEW
    case 'compact-summary':
      return applyCompactSummary(view, event.text)
    case 'compact-boundary':
      return applyCompactBoundary(view, event)
    case 'unknown':
      return applyUnknown(view, event.raw)
  }
}

function buildTurns(turnOrder: readonly TurnMeta[], records: readonly BlockRecord[]): readonly Turn[] {
  return turnOrder.map((tm) => ({
    role: tm.role,
    ...(tm.messageId === undefined ? {} : { messageId: tm.messageId }),
    blocks: records.filter((r) => r.turnId === tm.turnId).map((r) => r.block),
  }))
}

/**
 * fold 核心：把整條 Event 流投影成一份 ConversationView 快照。純函式，沒有任何
 * 跨呼叫狀態：呼叫端要拿到最新畫面，就把累積到當下的完整事件陣列整包丟進來重算，
 * 不是餵單一新事件做增量更新（跟 stepLive 的游標模式是兩回事）。
 */
export function fold(events: readonly Event[]): ConversationView {
  const view = events.reduce(applyEvent, INITIAL_VIEW)
  return {
    ...(view.sessionId === undefined ? {} : { sessionId: view.sessionId }),
    turns: buildTurns(view.turnOrder, view.records),
    ...(view.cost === undefined ? {} : { cost: view.cost }),
    ended: view.ended,
    ...(view.error === undefined ? {} : { error: view.error }),
  }
}
