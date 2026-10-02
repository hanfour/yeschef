import type { ChefRequest, ChefResponse } from './chef.js'
import type { ConversationToolsRequest, ConversationToolsResponse } from './conversation-tools.js'
import { isTranslateLanguage, type TranslatePayload, type TranslateResult } from './translate.js'
import type { Event } from './events.js'
import type { SessionState } from './session-state.js'
import type { PermissionsRequest, PermissionsResponse } from './permissions.js'
import type { SkillsRequest, SkillsResponse } from './skills.js'
import type { TestMachinesRequest, TestMachinesResponse } from './test-machines.js'
import type { ErrorIntakeRequest, ErrorIntakeResponse } from './error-intake.js'
import type { GroupMessagesPayload, GroupOpenPayload, GroupRequest, GroupResponse } from './group.js'
import type { WorktreeMergeRequest, WorktreeMergeResponse } from './worktree-merge.js'
import type { BrowserCommand, BrowserCommandResult, BrowserSessionEntry, BrowserSnapshot, BrowserStatePayload } from './browser-ipc.js'
import {
  asProvider,
  type Provider,
  type AddProjectResult,
  type ProjectsView,
  type SessionListScope,
  type TabOpenPayload,
  type TabTargetPayload,
} from './projects.js'

export type { TranslatePayload, TranslateResult } from './translate.js'

/**
 * IPC 頻道。名稱與 CONTRACT.md 逐字一致，改名等於改契約。
 */
export const IPC = {
  /** renderer → main(invoke):沙箱內不能讀檔,由主行程檢查後提供預覽。 */
  previewRead: 'preview:read',
  /** renderer → main(invoke):獨立翻譯,不改變對話狀態。 */
  translateRun: 'translate:run',
  /** main → renderer：合併後的 Event 批次 */
  eventsBatch: 'agent:events',
  /** renderer → main：使用者輸入（字串） */
  userInput: 'agent:input',
  /** main → renderer：批准請求 */
  approvalAsk: 'agent:approval:ask',
  approvalsGet: 'approvals:get',
  /** renderer → main：批准回覆 */
  approvalReply: 'agent:approval:reply',
  /** main → renderer：某筆批准已了結（回覆、逾時、denyAll），renderer 把卡片拿掉 */
  approvalSettled: 'agent:approval:settled',
  /** renderer → main（invoke）：歷史對話清單 */
  sessionList: 'session:list',
  /** main → renderer：session 狀態（SessionState 物件，裁決 14） */
  sessionState: 'session:state',
  /** renderer → main：開一條全新對話。無 payload（裁決 6） */
  intentStartNew: 'session:intent:start-new',
  /** renderer → main：開啟一條歷史對話（裁決 6） */
  intentOpenHistory: 'session:intent:open-history',
  /** renderer → main（invoke）：終端機 websocket port */
  terminalEndpoint: 'terminal:endpoint',
  /** renderer → main：使用者按下交接卡的「我好了」（Task 11，契約 §11.3） */
  handoffDone: 'handoff:done',
  /** renderer → main（invoke）：拿一份完整的 projects view */
  projectsGet: 'projects:get',
  /** main → renderer：projects view 有變動時整份重推 */
  projectsState: 'projects:state',
  /** renderer → main（invoke）：開資料夾選擇器新增專案 */
  projectsAdd: 'projects:add',
  /** renderer → main（invoke）：對不可用的專案重新指定資料夾 */
  projectsRelocate: 'projects:relocate',
  /** renderer → main：移除一個專案 */
  projectsRemove: 'projects:remove',
  /** renderer → main：切換目前作用中的專案 */
  projectsActivate: 'projects:activate',
  /** renderer → main：在某專案底下開一個新分頁 */
  tabsOpen: 'tabs:open',
  /** renderer → main：關掉某專案底下的一個分頁 */
  tabsClose: 'tabs:close',
  /** renderer → main：切換某專案底下作用中的分頁 */
  tabsActivate: 'tabs:activate',
  /** renderer → main:在某專案底下開一個新的對話分頁(D2) */
  conversationsOpen: 'conversations:open',

  /** main → renderer:目前所有未決的同伴提問,整份重推 */
  peerState: 'peer:state',
  /** renderer → main(invoke):取得目前完整未決提問快照 */
  peerGet: 'peer:get',
  /** renderer → main:人代替同伴回答一則提問 */
  peerAnswer: 'peer:answer',
  /** renderer → main:人取消一則提問 */
  peerCancel: 'peer:cancel',
  /** renderer → main:主分頁區瀏覽器分頁的內容矩形(CSS px);null 表示藏起來 */
  browserBounds: 'layout:browser-bounds',
  /** renderer → main(invoke):網址列的指令,作用在前景對話的瀏覽器。 */
  browserCommand: 'browser:command',
  /** main → renderer:某個對話的瀏覽器狀態變了。 */
  browserState: 'browser:state',
  /** main → renderer:哪些對話有瀏覽器、哪些正在被工具操作。 */
  browserSessions: 'browser:sessions',
  /** renderer → main(invoke):renderer 重新載入後取回目前全部狀態。 */
  browserGet: 'browser:get',
  /** main → renderer:群組新訊息與當下的 thread 清單,批次送。 */
  groupMessages: 'group:messages',
  /** renderer → main:在某專案底下開群組分頁,已經有就切過去。 */
  groupOpen: 'group:open',

} as const

export type ApprovalDecision = 'allow' | 'deny'
export type Unsubscribe = () => void

/**
 * 與 Task 6 的 `ApprovalRequest` 逐欄位相同（加上裁決 11 的兩個選填欄位與裁決 28 的
 * `toolUseId`）。ipc-bridge 用一次型別標註的賦值來確保兩者不漂移（裁決 8）。
 */
export interface ApprovalAskPayload {
  readonly reviewStatus?: 'checking' | 'reviewing' | 'manual'
  readonly reviewReason?: string
  readonly requestId: string
  /**
   * 這筆批准屬於哪個專案。renderer 收著所有專案的請求,只顯示 activeId 那個專案的;
   * 切走再切回,卡片還在。沒有這個欄位時 renderer 只能在切換時整批清空,
   * 前景時已送到的批准切走就再也拿不回來(RESULTS-08)。
   */
  readonly projectId: string
  /** 這筆批准屬於哪個對話分頁(D2)。renderer 每個對話一份 useApprovals,依它過濾。 */
  readonly conversationId: string

  /** SDK `CanUseTool` options 的 `toolUseID`。renderer 靠它找到對應的 tool block（裁決 28） */
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
  /** SDK 產的完整提示句，官方建議優先用它（裁決 11） */
  readonly title?: string
  /** 短名詞片語，適合按鈕標籤（裁決 11） */
  readonly displayName?: string
}

export interface ApprovalReplyPayload {
  readonly requestId: string
  readonly decision: ApprovalDecision
}

export interface IntentOpenHistoryPayload {
  readonly sessionId: string
}

export interface TerminalEndpoint {
  readonly port: number
  readonly token: string
}

/** 交接完成通知。`toolUseId` 對應 `request_handoff` 那次 tool call 的 id（契約 §11.3）。 */
export interface HandoffDonePayload {
  readonly toolUseId: string
}

/**
 * 歷史對話摘要（裁決 7 的六個欄位）。刻意是本專案自訂的窄型別，
 * 不是 SDK 的 `SDKSessionInfo`：SDK 型別不該穿過 IPC 進到 renderer，
 * 欄位會隨版本增減，而 renderer 沒有東西擋。
 */
export interface SessionSummary {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly gitBranch?: string
}

/** `agent:events` 的 payload(D2):每個對話分頁一條流,renderer 依 `conversationId` 分流。 */
export interface EventsBatchPayload {
  readonly conversationId: string
  readonly events: readonly Event[]
}

/** `session:state` 的 payload(D2)。 */
export interface SessionStatePayload {
  readonly conversationId: string
  readonly state: SessionState
}

/** 單則輸入的長度上限。整份檔案貼進輸入框時擋住，避免一次序列化幾十 MB。 */
export const MAX_INPUT_LENGTH = 100_000

/**
 * preload 透過 contextBridge 曝露給 renderer 的 `window.yeschef` 形狀。
 * 三個 `on*` 回傳解除訂閱的函式：React 的 effect 清理需要它，
 * 而且**回傳我們自己的閉包**可以杜絕「不小心把 ipcRenderer 回傳出去」那條路。
 */
export interface YesChefApi {
  manageChef(payload: ChefRequest): Promise<ChefResponse>
  conversationTools(payload: ConversationToolsRequest): Promise<ConversationToolsResponse>
  managePermissions(payload: PermissionsRequest): Promise<PermissionsResponse>
  manageSkills(payload: SkillsRequest): Promise<SkillsResponse>
  manageTestMachines(payload: TestMachinesRequest): Promise<TestMachinesResponse>
  manageErrorIntake(payload: ErrorIntakeRequest): Promise<ErrorIntakeResponse>
  /** 群組頻道的讀取與送訊息(群組規格 §7)。 */
  manageGroup(payload: GroupRequest): Promise<GroupResponse>
  onGroupMessages(cb: (payload: GroupMessagesPayload) => void): Unsubscribe
  /** 一個專案最多一個群組分頁;已經開著就切過去。 */
  openGroup(projectId: string): void
  /** worktree 分支合回主目錄目前的分支(合併規格 §4)。 */
  worktreeMerge(payload: WorktreeMergeRequest): Promise<WorktreeMergeResponse>
  translate(payload: TranslatePayload): Promise<TranslateResult>
  readPreview(payload: PreviewReadPayload): Promise<PreviewReadResult>
  /** 主分頁區瀏覽器分頁的內容矩形;null 表示收起或切到別的分頁,主行程會把瀏覽器藏起來。 */
  setBrowserBounds(rect: RectPayload | null): void
  browserCommand(command: BrowserCommand): Promise<BrowserCommandResult>
  getBrowser(): Promise<BrowserSnapshot>
  onBrowserState(cb: (state: BrowserStatePayload) => void): Unsubscribe
  onBrowserSessions(cb: (sessions: readonly BrowserSessionEntry[]) => void): Unsubscribe
  getApprovals(): Promise<readonly ApprovalAskPayload[]>
  getPeer(): Promise<PeerStatePayload>
  onPeerState(cb: (state: PeerStatePayload) => void): () => void
  answerPeerAsUser(payload: PeerActionPayload): void
  cancelPeer(payload: PeerActionPayload): void

  onEvents(cb: (payload: EventsBatchPayload) => void): () => void
  onApprovalAsk(cb: (ask: ApprovalAskPayload) => void): () => void
  /** 某筆批准在主行程已了結。renderer 的 pending 是主行程 registry 的鏡像,靠這個頻道同步。 */
  onApprovalSettled(cb: (settled: ApprovalSettledPayload) => void): () => void
  onSessionState(cb: (payload: SessionStatePayload) => void): () => void
  /** 主行程每次專案、分頁、待批准記號變動都會推一份完整的 view。 */
  onProjects(cb: (view: ProjectsView) => void): () => void
  sendInput(text: string): void
  replyApproval(reply: ApprovalReplyPayload): void
  /** `projectId` 為 null 時列全部;否則只列 cwd 等於該專案 rootPath 的 session。 */
  listSessions(scope: SessionListScope): Promise<readonly SessionSummary[]>
  startNew(): void
  openHistory(sessionId: string): void
  terminalEndpoint(): Promise<TerminalEndpoint>
  handoffDone(toolUseId: string): void
  getProjects(): Promise<ProjectsView>
  /** 主行程開資料夾選擇器;取消回 `{ kind: 'cancelled' }`。 */
  addProject(): Promise<AddProjectResult>
  /** 對不可用的專案重新指定資料夾,保留它的分頁與 thread。 */
  relocateProject(id: string): Promise<AddProjectResult>
  removeProject(id: string): void
  activateProject(id: string): void
  openTab(payload: TabOpenPayload): void
  closeTab(payload: TabTargetPayload): void
  activateTab(payload: TabTargetPayload): void
  /** 在某專案底下開一個新的對話分頁(D2、5b)。 */
  openConversation(projectId: string, provider: Provider, worktreeName?: string): void
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * 以下每個 parse 函式都是 IPC 進 main 時的執行期驗證。
 *
 * renderer 是我們自己的程式碼，但它跑在另一個程序：可能是重新載入前的舊 bundle、
 * 可能被 DevTools 手動 send、也可能是 preload 版本與 main 版本對不上。上一個分支
 * 就出過 handler 標了 `(data: string)` 但執行期收到物件，主程序拋未捕捉例外。
 * 型別標註在執行期不存在，所以入口一定要有真的檢查。
 *
 * 一律回傳**新造的物件**，不把外來物件直接放行，額外欄位在這裡被切掉。
 * 例外只有 `parseEventsBatch`：它刻意只做淺檢查後原樣放行，理由見該函式的註解。
 */
export function parseUserInput(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (v.length === 0 || v.length > MAX_INPUT_LENGTH) return null
  return v
}

export function parseApprovalReply(v: unknown): ApprovalReplyPayload | null {
  if (!isRecord(v)) return null
  const decision = v.decision
  if (!isNonEmptyString(v.requestId)) return null
  if (decision !== 'allow' && decision !== 'deny') return null
  return { requestId: v.requestId, decision }
}

export function parseIntentOpenHistory(v: unknown): IntentOpenHistoryPayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.sessionId)) return null
  return { sessionId: v.sessionId }
}

export function parseTerminalEndpoint(raw: unknown): TerminalEndpoint | null {
  if (!isRecord(raw)) return null
  const port = raw['port']
  const token = raw['token']
  return typeof port === 'number' && Number.isFinite(port) && isNonEmptyString(token) ? { port, token } : null
}

export function parseHandoffDone(v: unknown): HandoffDonePayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.toolUseId)) return null
  return { toolUseId: v.toolUseId }
}

/**
 * `title`／`displayName` 是裁決 11 加的，型別不符時整筆回 null 而不是丟掉那個欄位：
 * 悄悄丟掉會讓 UI 退回「工具名稱加 input」而沒有人知道為什麼。
 *
 * `toolUseId` 是裁決 28 加的，必填。它缺席時 renderer 找不到對應的 tool block，
 * 卡片會畫在對話尾端；讓這種 payload 通過等於把一個看得見的錯誤變成看不見的錯位。
 */
export interface ApprovalSettledPayload {
  readonly requestId: string
}

export function parseApprovalSettled(v: unknown): ApprovalSettledPayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.requestId)) return null
  return { requestId: v.requestId }
}

export function parseApprovalAsk(v: unknown): ApprovalAskPayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.requestId)) return null
  if (!isNonEmptyString(v.projectId)) return null
  if (!isNonEmptyString(v.conversationId)) return null
  if (!isNonEmptyString(v.toolUseId)) return null
  if (!isNonEmptyString(v.toolName)) return null
  if (v.title !== undefined && typeof v.title !== 'string') return null
  if (v.displayName !== undefined && typeof v.displayName !== 'string') return null
  if (v.reviewStatus !== undefined && !['checking', 'reviewing', 'manual'].includes(String(v.reviewStatus))) return null
  if (v.reviewReason !== undefined && typeof v.reviewReason !== 'string') return null
  const title = optionalString(v.title)
  const displayName = optionalString(v.displayName)
  return {
    ...(v.reviewStatus === undefined ? {} : { reviewStatus: v.reviewStatus as 'checking' | 'reviewing' | 'manual' }),
    ...(v.reviewReason === undefined ? {} : { reviewReason: v.reviewReason as string }),
    requestId: v.requestId,
    projectId: v.projectId,
    conversationId: v.conversationId,
    toolUseId: v.toolUseId,
    toolName: v.toolName,
    input: v.input,
    ...(title === undefined ? {} : { title }),
    ...(displayName === undefined ? {} : { displayName }),
  }
}

/**
 * 批次只做淺檢查：確認是非空陣列、每筆都是帶 `kind` 字串的物件。
 * 不逐一比對 `Event` 的每個變體，那份判斷屬於 Task 3 的正規化層，
 * 在這裡重寫一份只會多出一個會漂移的真相來源。
 */
export function parseEventsBatch(v: unknown): readonly Event[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  for (const item of v) {
    if (!isRecord(item)) return null
    if (!isNonEmptyString(item.kind)) return null
  }
  return v as readonly Event[]
}

export function parseEventsBatchPayload(v: unknown): EventsBatchPayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.conversationId)) return null
  const events = parseEventsBatch(v.events)
  return events === null ? null : { conversationId: v.conversationId, events }
}

/**
 * 裁決 14：`session:state` 送的是 `SessionState` 物件，不是字串。
 * `viewing` 必有非空 `sessionId`（Recents 要靠它標出目前選中的那一筆）；
 * `live` 的 `sessionId` 可以省略，因為 SDK 要吐出第一則訊息之後才知道 id。
 * 一律回新造的物件，額外欄位在這裡被切掉。
 */
export function parseSessionState(v: unknown): SessionState | null {
  if (!isRecord(v)) return null
  if (v.kind === 'idle') return { kind: 'idle' }
  if (v.kind === 'viewing') {
    if (!isNonEmptyString(v.sessionId)) return null
    return { kind: 'viewing', sessionId: v.sessionId }
  }
  if (v.kind === 'live') {
    if (v.sessionId === undefined) return { kind: 'live' }
    if (!isNonEmptyString(v.sessionId)) return null
    return { kind: 'live', sessionId: v.sessionId }
  }
  return null
}

export function parseSessionStatePayload(v: unknown): SessionStatePayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.conversationId)) return null
  const state = parseSessionState(v.state)
  return state === null ? null : { conversationId: v.conversationId, state }
}

export function parseSessionSummaries(v: unknown): readonly SessionSummary[] | null {
  if (!Array.isArray(v)) return null
  const out: SessionSummary[] = []
  for (const item of v) {
    if (!isRecord(item)) return null
    if (!isNonEmptyString(item.sessionId)) return null
    if (typeof item.summary !== 'string') return null
    if (typeof item.lastModified !== 'number' || !Number.isFinite(item.lastModified)) return null
    if (item.cwd !== undefined && typeof item.cwd !== 'string') return null
    if (item.customTitle !== undefined && typeof item.customTitle !== 'string') return null
    if (item.gitBranch !== undefined && typeof item.gitBranch !== 'string') return null
    const cwd = optionalString(item.cwd)
    const customTitle = optionalString(item.customTitle)
    const gitBranch = optionalString(item.gitBranch)
    out.push({
      sessionId: item.sessionId,
      summary: item.summary,
      lastModified: item.lastModified,
      ...(cwd === undefined ? {} : { cwd }),
      ...(customTitle === undefined ? {} : { customTitle }),
      ...(gitBranch === undefined ? {} : { gitBranch }),
    })
  }
  return out
}

/** 一則未決的同伴提問,給畫面用(P 規格 §6.5)。 */
export interface PeerPendingView {
  readonly targetProvider: Provider
  readonly questionId: string
  readonly projectId: string
  readonly askerConversationId: string
  readonly targetConversationId: string
  readonly targetLinkId: string
  readonly askerLinkId: string
  readonly text: string
  readonly createdAt: number
  readonly queued: boolean
}

export interface PeerStatePayload {
  readonly pending: readonly PeerPendingView[]
}

/** 人的兩個動作共用一個形狀:取消不帶 text,代替回答帶。 */
export interface PeerActionPayload {
  readonly questionId: string
  readonly text?: string
}

export function parsePeerAction(raw: unknown): PeerActionPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['questionId'])) return null
  const text = raw['text']
  if (text !== undefined && typeof text !== 'string') return null
  return text === undefined ? { questionId: raw['questionId'] } : { questionId: raw['questionId'], text }
}

export function parsePeerState(raw: unknown): PeerStatePayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.pending)) return null
  const pending: PeerPendingView[] = []
  for (const item of raw.pending) {
    if (!isRecord(item) || !isNonEmptyString(item.questionId) || !isNonEmptyString(item.projectId) ||
      !isNonEmptyString(item.askerConversationId) || !isNonEmptyString(item.targetConversationId) ||
      !isNonEmptyString(item.targetLinkId) || !isNonEmptyString(item.askerLinkId) || typeof item.text !== 'string' ||
      typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || typeof item.queued !== 'boolean') return null
    const targetProvider = asProvider(item.targetProvider)
    if (targetProvider === undefined) return null
    pending.push({ questionId: item.questionId, projectId: item.projectId,
      askerConversationId: item.askerConversationId, targetConversationId: item.targetConversationId,
      targetProvider, targetLinkId: item.targetLinkId, askerLinkId: item.askerLinkId, text: item.text, createdAt: item.createdAt, queued: item.queued })
  }
  return { pending }
}

export function parseApprovals(raw: unknown): readonly ApprovalAskPayload[] | null {
  if (!Array.isArray(raw)) return null
  const out: ApprovalAskPayload[] = []
  for (const item of raw) {
    const ask = parseApprovalAsk(item)
    if (ask === null) return null
    out.push(ask)
  }
  return out
}

export interface RectPayload {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserBoundsPayload {
  readonly rect: RectPayload | null
}

function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function parseBrowserBounds(raw: unknown): BrowserBoundsPayload | null {
  if (!isRecord(raw) || !('rect' in raw)) return null
  const rect = raw['rect']
  if (rect === null) return { rect: null }
  if (!isRecord(rect)) return null
  const { x, y, width, height } = rect
  if (!isNonNegativeFinite(x) || !isNonNegativeFinite(y) || !isNonNegativeFinite(width) || !isNonNegativeFinite(height)) return null
  return { rect: { x, y, width, height } }
}


export interface PreviewReadPayload {
  readonly projectId: string
  readonly path: string
}

export type PreviewReadResult =
  | { readonly kind: 'image'; readonly mimeType: string; readonly dataBase64: string }
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'rejected'; readonly message: string }

export function parsePreviewRead(raw: unknown): PreviewReadPayload | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.projectId) || !isNonEmptyString(raw.path)) return null
  return { projectId: raw.projectId, path: raw.path }
}

export function parsePreviewReadResult(raw: unknown): PreviewReadResult | null {
  if (!isRecord(raw)) return null
  switch (raw.kind) {
    case 'image':
      if (typeof raw.mimeType !== 'string' || typeof raw.dataBase64 !== 'string') return null
      return { kind: 'image', mimeType: raw.mimeType, dataBase64: raw.dataBase64 }
    case 'markdown':
      if (typeof raw.text !== 'string') return null
      return { kind: 'markdown', text: raw.text }
    case 'rejected':
      if (typeof raw.message !== 'string') return null
      return { kind: 'rejected', message: raw.message }
    default:
      return null
  }
}

export function parseTranslate(raw: unknown): TranslatePayload | null {
  if (!isRecord(raw)) return null
  if (typeof raw.text !== 'string' || raw.text.trim() === '' || !isTranslateLanguage(raw.target)) return null
  return { text: raw.text, target: raw.target }
}

export function parseTranslateResult(raw: unknown): TranslateResult | null {
  if (!isRecord(raw)) return null
  switch (raw.kind) {
    case 'ok':
      if (typeof raw.text !== 'string') return null
      return { kind: 'ok', text: raw.text }
    case 'rejected':
      if (typeof raw.message !== 'string') return null
      return { kind: 'rejected', message: raw.message }
    default:
      return null
  }
}
