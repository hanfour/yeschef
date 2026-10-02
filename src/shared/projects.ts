/**
 * 子專案 D 的共用型別(規格 §4.1)與 thread/session 鏈型別(E 規格 §4.1,版本 2)。
 * main 與 renderer 都 import,所以不引入 Electron 與 node 內建模組;zod 可以,renderer
 * 已經因為 `shared/chef.ts` 與 `shared/test-machines.ts` 打包了它。
 */
import { z } from 'zod'
import type { ConversationView } from './fold.js'
import { isNonEmptyString, isRecord } from './ipc.js'

export const PROJECTS_SCHEMA_VERSION = 2

/** 三種對話核心。新增一種只改這一行,TypeScript 會在每張 Record 少一列時報錯。 */
export const PROVIDERS = ['claude', 'codex', 'grok'] as const
export type Provider = (typeof PROVIDERS)[number]
export const providerSchema = z.enum(PROVIDERS)

/** 外來資料轉 Provider。認不得回 undefined,呼叫端自己決定是丟棄還是退回 claude。 */
export function asProvider(raw: unknown): Provider | undefined {
  return PROVIDERS.find((known) => known === raw)
}

/**
 * 畫面上的名字。`name` 是行內標示,`tabTitle` 是新分頁的預設標籤。
 *
 * codex 那列的 `tabTitle` 是小寫的「codex 對話」,不是「Codex 對話」:既有存檔裡的
 * codex 分頁就叫這個名字,`nextConversationLabel` 的編號靠 base 逐字比對,改大寫會讓
 * 舊分頁對不上、下一個新分頁從頭編號。行內顯示一律用 `name`,所以看起來仍然是 Codex。
 */
export const PROVIDER_LABELS: Readonly<Record<Provider, { readonly name: string; readonly tabTitle: string }>> = {
  claude: { name: 'Claude', tabTitle: 'Claude 對話' },
  codex: { name: 'Codex', tabTitle: 'codex 對話' },
  grok: { name: 'Grok', tabTitle: 'Grok 對話' },
}

/** 舊名稱,值不變,既有 import 不受影響。 */
export const CONVERSATION_TAB_LABEL = PROVIDER_LABELS.claude.tabTitle
export const CODEX_CONVERSATION_TAB_LABEL = PROVIDER_LABELS.codex.tabTitle

export interface SwitchTarget {
  readonly provider: Provider
  /** 不知道就 null,不拿 requestedModel 冒充實際模型。 */
  readonly requestedModel: string | null
}

export type SwitchMode = 'handoff' | 'failure-recovery'

export type SwitchPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly startedAt: number }
  | { readonly kind: 'spawning'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly handoffVersion: number; readonly recoveryRequired: boolean }
  | { readonly kind: 'receiving'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly newLinkId: string; readonly newSessionId: string }

export interface SessionLink {
  /** transcript 沒有 SDK result,另存才能在重啟後還原花費。 */
  readonly cost?: ConversationView['cost']
  /** 宿主產生,鏈上唯一;跨後端的引用都用它。D2 只會出現 linkId === sessionId。 */
  readonly linkId: string
  readonly provider: Provider
  /** 該 provider 的原生 id,只給對應的 adapter 用。 */
  readonly sessionId: string
  /** Claude 有本機 transcript;沒有的 provider 為 null。 */
  readonly transcriptPath: string | null
  readonly parentLinkId: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly endReason: 'handoff' | 'failure-recovery' | 'user' | null
  /** system/init 回報過的模型,去重;D2 不填,留空陣列。 */
  readonly models: readonly string[]
}

export interface ThreadEntry {
  readonly id: string
  readonly sessions: readonly SessionLink[]
  readonly handoffVersion: number
  readonly switchPhase: SwitchPhase
  readonly createdAt: number
}

export type TabContentType = 'conversation' | 'terminal' | 'group'
export const GROUP_TAB_LABEL = '群組'

export interface TabEntry {
  readonly chefTaskId?: string
  readonly worktreePath?: string
  readonly id: string
  readonly contentType: TabContentType
  readonly label: string
  readonly customLabel: string | null
  readonly command?: string
  readonly sortOrder: number
  readonly lastFocusedAt: number
  /** contentType 為 'conversation' 時必填,對應 threads[].id。 */
  readonly threadId?: string
  /** contentType 為 'conversation' 時有值;缺就是 'claude'(版本 1 轉換前的資料)。 */
  readonly provider?: Provider
  /** 這個對話的瀏覽器最後停在哪(每對話瀏覽器規格 §4.6)。undefined 表示從沒記過,見 projects-state 的 tabLastUrl。 */
  readonly lastUrl?: string | null
}

/** 群組固定在最前,其他分頁依使用者設定的 sortOrder 排列。 */
export function sortTabs(tabs: readonly TabEntry[]): readonly TabEntry[] {
  return [...tabs].sort((a, b) => {
    const groupOrder = Number(b.contentType === 'group') - Number(a.contentType === 'group')
    return groupOrder || a.sortOrder - b.sortOrder
  })
}

export interface ProjectEntry {
  readonly isGitRepo?: boolean
  readonly id: string
  readonly rootPath: string
  readonly name: string
  readonly addedAt: number
  readonly lastOpenedAt: number
  readonly tabs: readonly TabEntry[]
  readonly lastUrl: string | null
  readonly threads: readonly ThreadEntry[]
}

export interface ProjectsState {
  readonly schemaVersion: typeof PROJECTS_SCHEMA_VERSION
  readonly projects: readonly ProjectEntry[]
  readonly activeId: string | null
  readonly openIdsOnShutdown: readonly string[]
}

export const EMPTY_PROJECTS_STATE: ProjectsState = {
  schemaVersion: PROJECTS_SCHEMA_VERSION,
  projects: [],
  activeId: null,
  openIdsOnShutdown: [],
}

/** renderer 看到的一個專案。`rootPath` 只供顯示,renderer 送回 main 的一律是 `id`(規格 §3.1)。 */
export interface ProjectView {
  readonly isGitRepo?: boolean
  readonly id: string
  readonly name: string
  readonly rootPath: string
  /** 資料夾在磁碟上存在且是目錄。 */
  readonly available: boolean
  /** 該專案在背景時有扣住的批准請求(規格 §2)。 */
  readonly pendingApproval: boolean
  /** 底下扣著批准的對話分頁 id(規格 §4:記號從專案格移到分頁)。`pendingApproval` 等於這個非空。 */
  readonly pendingTabIds: readonly string[]
  /** 回合進行中的對話分頁 id;renderer 關分頁前用它決定要不要先確認(規格 §5)。 */
  readonly busyTabIds: readonly string[]
  /** 進行中且本回合已產出內容的分頁；舊資料補空陣列。 */
  readonly producingTabIds: readonly string[]
  /** 各進行中回合的開始時間;舊資料解析時補空物件。 */
  readonly busySince: Readonly<Record<string, number>>
  readonly tabs: readonly TabEntry[]
  readonly activeTabId: string
  readonly threads: readonly ThreadEntry[]
}

export interface ProjectsView {
  readonly error?: string
  readonly projects: readonly ProjectView[]
  readonly activeId: string | null
}

export interface ProjectIdPayload {
  readonly id: string
}

export interface TabOpenPayload {
  readonly projectId: string
  readonly label: string
  readonly command?: string
}

export interface TabTargetPayload {
  readonly projectId: string
  readonly tabId: string
}

export interface ConversationOpenPayload {
  readonly worktreeName?: string
  readonly projectId: string
  readonly provider: Provider
}

export function parseConversationOpen(raw: unknown): ConversationOpenPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId'])) return null
  const provider = asProvider(raw['provider'])
  if (provider === undefined) return null
  const worktreeName = raw['worktreeName']
  if (worktreeName !== undefined && typeof worktreeName !== 'string') return null
  return { projectId: raw['projectId'], provider, ...(isNonEmptyString(worktreeName) ? { worktreeName } : {}) }
}

export interface SessionListScope {
  readonly provider?: Provider
  readonly projectId: string | null
}

export type AddProjectResult =
  | { readonly kind: 'added'; readonly id: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly message: string }

export function parseProjectId(raw: unknown): ProjectIdPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['id'])) return null
  return { id: raw['id'] }
}

export function parseTabOpen(raw: unknown): TabOpenPayload | null {
  if (!isRecord(raw)) return null
  const { projectId, label, command } = raw
  if (!isNonEmptyString(projectId) || !isNonEmptyString(label)) return null
  if (command !== undefined && typeof command !== 'string') return null
  return command === undefined ? { projectId, label } : { projectId, label, command }
}

export function parseTabTarget(raw: unknown): TabTargetPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId']) || !isNonEmptyString(raw['tabId'])) return null
  return { projectId: raw['projectId'], tabId: raw['tabId'] }
}

export function parseSessionListScope(raw: unknown): SessionListScope | null {
  if (!isRecord(raw)) return null
  const id = raw['projectId']
  const provider = raw['provider'] === undefined ? undefined : asProvider(raw['provider'])
  if (raw['provider'] !== undefined && provider === undefined) return null
  if (id !== null && !isNonEmptyString(id)) return null
  return { projectId: id, ...(provider === undefined ? {} : { provider }) }
}

export function parseAddProjectResult(raw: unknown): AddProjectResult | null {
  if (!isRecord(raw)) return null
  switch (raw['kind']) {
    case 'added':
      return isNonEmptyString(raw['id']) ? { kind: 'added', id: raw['id'] } : null
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'rejected':
      return typeof raw['message'] === 'string' ? { kind: 'rejected', message: raw['message'] } : null
    default:
      return null
  }
}

function isTabEntry(raw: unknown): raw is TabEntry {
  if (!isRecord(raw)) return false
  const type = raw['contentType']
  return (
    isNonEmptyString(raw['id']) &&
    (type === 'conversation' || type === 'terminal' || type === 'group') &&
    typeof raw['label'] === 'string' &&
    (raw['customLabel'] === null || typeof raw['customLabel'] === 'string') &&
    (raw['worktreePath'] === undefined || typeof raw['worktreePath'] === 'string') &&
    (raw['command'] === undefined || typeof raw['command'] === 'string') &&
    typeof raw['sortOrder'] === 'number' &&
    typeof raw['lastFocusedAt'] === 'number' &&
    (raw['chefTaskId'] === undefined || typeof raw['chefTaskId'] === 'string') &&
    (raw['threadId'] === undefined || typeof raw['threadId'] === 'string') &&
    (raw['provider'] === undefined || asProvider(raw['provider']) !== undefined) &&
    (raw['lastUrl'] === undefined || raw['lastUrl'] === null || typeof raw['lastUrl'] === 'string')
  )
}

/** renderer 只用 thread 的 id 與 sessions[].sessionId 分組,其餘欄位原樣帶過(與 parseEventsBatch 同樣的淺層原則)。 */
function isThreadEntry(raw: unknown): raw is ThreadEntry {
  if (!isRecord(raw) || !isNonEmptyString(raw['id']) || !Array.isArray(raw['sessions'])) return false
  return raw['sessions'].every((s: unknown) => isRecord(s) && isNonEmptyString(s['sessionId']))
}

function isProjectView(raw: unknown): raw is ProjectView {
  if (!isRecord(raw)) return false
  return (
    isNonEmptyString(raw['id']) &&
    typeof raw['name'] === 'string' &&
    typeof raw['rootPath'] === 'string' &&
    (raw['isGitRepo'] === undefined || typeof raw['isGitRepo'] === 'boolean') &&
    typeof raw['available'] === 'boolean' &&
    typeof raw['pendingApproval'] === 'boolean' &&
    Array.isArray(raw['pendingTabIds']) &&
    raw['pendingTabIds'].every(isNonEmptyString) &&
    Array.isArray(raw['busyTabIds']) &&
    raw['busyTabIds'].every(isNonEmptyString) &&
    (raw['producingTabIds'] === undefined || (Array.isArray(raw['producingTabIds']) &&
      raw['producingTabIds'].every(isNonEmptyString))) &&
    (raw['busySince'] === undefined || (isRecord(raw['busySince']) &&
      Object.values(raw['busySince']).every((since) => typeof since === 'number' && Number.isFinite(since)))) &&
    isNonEmptyString(raw['activeTabId']) &&
    Array.isArray(raw['tabs']) &&
    raw['tabs'].every(isTabEntry) &&
    Array.isArray(raw['threads']) &&
    raw['threads'].every(isThreadEntry)
  )
}

export function parseProjectsView(raw: unknown): ProjectsView | null {
  if (!isRecord(raw)) return null
  const { projects, activeId } = raw
  if (!Array.isArray(projects) || !projects.every(isProjectView)) return null
  if (activeId !== null && !isNonEmptyString(activeId)) return null
  const error = raw['error']
  if (error !== undefined && typeof error !== 'string') return null
  const filled = projects.map((project) => ({
    ...project,
    producingTabIds: project.producingTabIds ?? [],
    busySince: project.busySince ?? {},
  }))
  return { projects: filled, activeId, ...(error === undefined ? {} : { error }) }
}
