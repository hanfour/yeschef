/**
 * Recents 的資料來源：把 SDK 的 session API 包成本專案的窄介面（裁決 7）。
 *
 * 這一層不做執行期形狀驗證。理由是它的兩個依賴由組裝點直接接上 SDK 的
 * listSessions／getSessionMessages，型別在編譯期就對上了；真正跨越不可信
 * 界線的是 IPC，那一關由 Task 8 的 parseSessionSummaries 把守。在這裡再驗
 * 一次只是同一件事寫兩遍。
 */

import { normalizeHistory, type Event } from '../shared/events.js'
import type { SessionLink } from '../shared/projects.js'
import type { SessionSummary } from '../shared/ipc.js'

/**
 * SDK 的 SDKSessionInfo 裡本專案真的會讀的欄位（sdk.d.ts@0.3.258 第 4968 行）。
 * 用窄複本而不是直接 import SDK 型別：SDK 加欄位不會影響這裡，SDK 拿掉這七個
 * 之中任何一個，組裝點那一行會過不了 tsc，那正是我們要的訊號。
 */
export interface SdkSessionInfo {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly firstPrompt?: string
  readonly gitBranch?: string
}

/**
 * SDK 的 `listSessions`(sdk.d.ts 的 `ListSessionsOptions`)。`dir` 由 SDK 端過濾,
 * 並涵蓋該目錄的 git worktree;窄複本只列本專案真的會用到的兩個選項。
 */
export type ListSessionsFn = (options?: {
  dir?: string
  limit?: number
}) => Promise<readonly SdkSessionInfo[]>
export type GetSessionMessagesFn = (sessionId: string) => Promise<readonly unknown[]>

export interface SessionStore {
  /**
   * `cwd` 給定時只回那個目錄底下的 session，且上限套在過濾之後（規格 §3.2 的
   * 「本專案」範圍）。不給就是全機器最新的 `limit` 筆。
   */
  list(cwd?: string): Promise<readonly SessionSummary[]>
  loadHistory(sessionId: string, costOf?: (sessionId: string) => SessionLink['cost']): Promise<readonly Event[]>
  /**
   * 裁決 20：最近一次 `list()` 結果裡該筆的 `cwd`，給跨專案 resume 用。
   * 沒列過、或該筆沒有 `cwd`，回 `undefined`。
   */
  cwdOf(sessionId: string): string | undefined
}

export interface SessionStoreDeps {
  readonly listSessions: ListSessionsFn
  readonly getSessionMessages: GetSessionMessagesFn
  readonly limit?: number
}

/**
 * 實測（2026-09-02，本機 940 場 session）：不帶 limit 的 listSessions() 要
 * 536 到 736 毫秒、序列化 426 KB；limit 100 是 84 毫秒、39 KB。側邊欄一次也
 * 看不完一百筆，這個上限沒有實際損失。同一次實測確認 SDK 自己就是由新到舊
 * 排序，limit 取的是最新的 N 筆。
 */
export const DEFAULT_SESSION_LIST_LIMIT = 100
const FIRST_PROMPT_MAX = 80
const SESSION_ID_PREFIX = 8

/**
 * summary 的退回鏈。SDK 的註解說 summary 是「custom title、auto-generated
 * summary 或 first prompt」三選一，三者都沒有時它是空字串，此時清單會出現
 * 一整排無法辨識的空白列。退到 firstPrompt，再退到 sessionId 前 8 碼：後者
 * 醜但至少可以分辨兩筆不同的對話。
 */
function fallbackTitle(info: SdkSessionInfo): string {
  const summary = info.summary.trim()
  if (summary !== '') return summary
  const firstPrompt = (info.firstPrompt ?? '').trim()
  if (firstPrompt !== '') return firstPrompt.slice(0, FIRST_PROMPT_MAX)
  return info.sessionId.slice(0, SESSION_ID_PREFIX)
}

function toSummary(info: SdkSessionInfo): SessionSummary {
  return {
    sessionId: info.sessionId,
    summary: fallbackTitle(info),
    lastModified: info.lastModified,
    ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
    ...(info.customTitle === undefined ? {} : { customTitle: info.customTitle }),
    ...(info.gitBranch === undefined ? {} : { gitBranch: info.gitBranch }),
  }
}

function wrap(cause: unknown, message: string): Error {
  return new Error(message, { cause })
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const limit = deps.limit ?? DEFAULT_SESSION_LIST_LIMIT
  /**
   * 裁決 20：sessionId 到 cwd 的對照表，只有 `list()` 會換掉它，而且是整份換新的
   * `ReadonlyMap`，不就地 `set`。就地改的話，前一次 `list()` 已經消失的 session
   * 會永遠留在表裡，`cwdOf` 會回一個 SDK 早就不認得的目錄。
   */
  let cwds: ReadonlyMap<string, string> = new Map()

  return {
    async list(cwd) {
      let infos: readonly SdkSessionInfo[]
      try {
        // 過濾交給 SDK 的 `dir`：自己抓全部再比對 cwd 的話，limit 會先砍掉全機器
        // 最新 100 筆以外的，某個專案的 session 排在 101 名之後就在過濾前消失，
        // 該專案的 Recents 變成空的，即使它有歷史。實測 962 場 session 時抓全部
        // 要 1188 毫秒，`dir` 過濾 32 毫秒，而且後者一併涵蓋 git worktree。
        infos = await deps.listSessions(cwd === undefined ? { limit } : { dir: cwd, limit })
      } catch (cause) {
        // 不回空陣列：那會被當成「這台機器沒有歷史對話」，是靜默失敗（規格 §8）。
        throw wrap(cause, '讀取歷史對話清單失敗，Recents 無法顯示')
      }
      // 複製再排序：sort 會就地改動陣列，而這個陣列是 SDK 的，不是我們的。
      // SDK 目前已經由新到舊排好，這一行仍然保留：那是 SDK 的實作細節不是它的契約。
      const summaries = [...infos].sort((a, b) => b.lastModified - a.lastModified).map(toSummary)
      // cwds 涵蓋這次取回的清單。cwdOf 服務的是「使用者點了 Recents 某一筆就
      // resume 它」，而使用者點得到的就是這一份，所以範圍相符。
      cwds = new Map(
        summaries.flatMap((s) => (s.cwd === undefined ? [] : [[s.sessionId, s.cwd] as const]))
      )
      return summaries
    },

    async loadHistory(sessionId, costOf) {
      let messages: readonly unknown[]
      try {
        messages = await deps.getSessionMessages(sessionId)
      } catch (cause) {
        throw wrap(cause, `讀取歷史對話 ${sessionId} 失敗`)
      }
      const events = messages.flatMap((m) => [...normalizeHistory(m)])
      // 裁決 15：歷史訊息已持久化，這場對話確實結束了，補這一筆不是造假。
      // 少了它，fold() 會讓每個 block 停在 complete: false，UI 在早就結束的
      // 對話尾端畫游標。
      const cost = costOf?.(sessionId)
      return [...events, {
        kind: 'session-end', isError: false,
        ...(cost?.usd === undefined ? {} : { costUsd: cost.usd }),
        ...(cost?.turns === undefined ? {} : { numTurns: cost.turns }),
        ...(cost?.tokens === undefined ? {} : { tokens: cost.tokens }),
      }]
    },

    cwdOf(sessionId) {
      return cwds.get(sessionId)
    },
  }
}
