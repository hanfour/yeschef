import { randomUUID } from 'node:crypto'

/**
 * 批准逾時。原本 30 秒,是在「卡片一定是你正在看的東西」的前提下選的;
 * D2 規格 §11 之後任何對話的卡都會出現在人眼前,30 秒對別的對話的卡太短。
 */
export const APPROVAL_TIMEOUT_MS = 300_000

/**
 * canUseTool 的批准請求送到 renderer 時的形狀。
 * 與 CONTRACT.md 的 `approvalAsk`（`agent:approval:ask`）payload 逐欄位相同，
 * Task 8 可以把它原樣 `webContents.send`，不必轉形狀。`title`／`displayName`
 * 語意見裁決 11。
 */
export interface ApprovalRequest {
  readonly executionCwd?: string
  readonly validateEvidence?: () => boolean
  readonly requestId: string
  /**
   * SDK `CanUseTool` options 的 `toolUseID`（裁決 28）。renderer 靠
   * `block.id === toolUseId` 把批准卡片掛到對應的 tool block 上。
   */
  readonly toolUseId: string
  readonly toolName: string
  readonly input: unknown
  readonly title?: string        // SDK 產的完整提示句，官方建議優先用它
  readonly reviewStatus?: 'checking' | 'reviewing' | 'manual'
  readonly reviewReason?: string
  readonly displayName?: string  // 短名詞片語，適合按鈕標籤
}

/** `request()` 的輸入形狀：比 `ApprovalRequest` 少了 `requestId`，由 registry 補上（裁決 16）。 */
export type ApprovalAsk = Omit<ApprovalRequest, 'requestId'>

export type ApprovalDecision = 'allow' | 'deny'

/**
 * 待決 promise 的最終結果。
 *
 * deny 時盡量帶 reason，供 UI 在對話裡留下可見記錄（規格 §8：「拒絕是安全的
 * 方向，靜默掛住不是」。這句話反過來說就是「拒絕了也不能是靜默的」，要有
 * 看得見的原因）。allow 一律不帶 reason。
 *
 * Task 8 的 canUseTool 直接用這個值組出 SDK 的 PermissionResult：
 *   allow → { behavior: 'allow', updatedInput: input }
 *   deny  → { behavior: 'deny', message: reason ?? '使用者拒絕' }
 */
export interface ApprovalOutcome {
  readonly decision: ApprovalDecision
  readonly reason?: string
  readonly authorizationVersion?: number
  readonly source?: 'rule' | 'review' | 'user' | 'system'
  readonly timedOut?: boolean
}

/**
 * 把請求送到 renderer 的注入函式，由呼叫端（Task 8）決定怎麼送
 * （例如 `webContents.send`）。
 *
 * 是否「送得出去」用「會不會 throw」判斷：視窗已關閉或 webContents 已銷毀時，
 * Electron 的 send 本身會 throw，不需要呼叫端額外查視窗狀態、也不需要另一條
 *「處理視窗關閉」的路徑：throw 直接併入下面 request() 的 deny 邏輯。
 */
export type SendApprovalRequest = (request: ApprovalRequest) => void

export interface ApprovalRegistryOptions {
  readonly finalize?: (outcome: ApprovalOutcome) => ApprovalOutcome
  readonly validateAllow?: (request: ApprovalRequest) => Promise<ApprovalOutcome | null>
  readonly evaluate?: (request: ApprovalRequest, signal: AbortSignal, progress: (status: 'checking' | 'reviewing' | 'manual', reason: string) => void) => Promise<ApprovalOutcome | null>
  readonly onDecision?: (request: ApprovalRequest, outcome: ApprovalOutcome) => void
  readonly sendRequest: SendApprovalRequest
  /** 逾時毫秒數，預設 APPROVAL_TIMEOUT_MS。可注入以便測試。 */
  readonly timeoutMs?: number | null
  /** 每一筆了結(回覆、逾時、denyAll、送不出去)各通知一次。用來讓 renderer 拿掉卡片。 */
  readonly onSettled?: (requestId: string) => void
  /** requestId 產生器，預設 crypto.randomUUID。測試可注入以取得可預期的 id。 */
  readonly createRequestId?: () => string
}

export interface ApprovalRegistry {
  /**
   * 送出一筆批准請求，回傳掛著的 promise。
   *
   * 這個 promise **永遠 resolve，不 reject**：allow、deny、逾時、送不出去
   * 這四種結局在 canUseTool 眼中都是「有了結果」，不是例外，呼叫端不需要
   * 包 try/catch。
   *
   * 參數是 `ApprovalAsk`（裁決 16）：呼叫端把 `toolUseId`／`toolName`／`input`／
   * `title`／`displayName` 組成一個物件，registry 補上 `requestId` 後整個轉送給
   * `sendRequest`，不逐欄位重組。
   */
  request(ask: ApprovalAsk): Promise<ApprovalOutcome>

  /**
   * renderer 回覆時呼叫。找不到對應的待決請求（未知 id、已經結束過的 id）
   * 回傳 false，不做任何事、不 throw：遲到或重複的回覆在 IPC 世界是正常
   * 狀況，不是錯誤，不該讓整個 handler 掛掉。
   */
  reply(requestId: string, decision: ApprovalDecision): boolean

  /**
   * 把目前所有待決請求立即以 deny 結束。
   *
   * 規格 §3.2 收尾三步驟的第一步：切換 session 或關閉視窗前，先讓掛著的
   * 批准 promise 全部有個了結，再 interrupt() 進行中的工具、收掉 query。
   * 理由跟逾時一樣：拒絕是安全的方向；讓 promise 隨著被收掉的 query 一起
   * 消失、永遠不 resolve，才是真正危險的狀態。
   */
  denyAll(reason: string): void

  /** 目前待決請求數。供測試與偵錯使用。 */
  pendingCount(): number
}

interface PendingEntry {
  answering?: boolean
  readonly request: ApprovalRequest
  readonly controller: AbortController
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly timer?: ReturnType<typeof setTimeout>
}

/**
 * 建立一份批准的待決 promise 註冊表。
 *
 * `canUseTool` 在主程序觸發後沒有第二次機會：SDK 等的是一個
 * `Promise<PermissionResult>`，這個 promise 不 resolve，`query()` 就卡住
 * 不動。四種結局（allow、deny、逾時、送不出去／視窗關閉）都必須走到
 * resolve，不得留置。
 */
export function createApprovalRegistry(options: ApprovalRegistryOptions): ApprovalRegistry {
  const { sendRequest } = options
  const timeoutMs = options.timeoutMs === undefined ? APPROVAL_TIMEOUT_MS : options.timeoutMs
  const createRequestId = options.createRequestId ?? randomUUID

  const pending = new Map<string, PendingEntry>()

  /** 唯一的了結入口：清計時器、從表裡刪掉、resolve。順序不能反過來。 */
  function settle(requestId: string, outcome: ApprovalOutcome): boolean {
    const entry = pending.get(requestId)
    if (entry === undefined) return false
    if (options.finalize) {
      try { outcome = options.finalize(outcome) } catch { outcome = { decision: 'deny', source: 'system', reason: '授權最終驗證失敗' } }
    }
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    pending.delete(requestId)
    entry.controller.abort()
    // Audit failure cannot strand the provider's approval promise.
    try { options.onDecision?.(entry.request, outcome) } catch { /* best effort */ }
    entry.resolve(outcome)
    options.onSettled?.(requestId)
    return true
  }

  function request(ask: ApprovalAsk): Promise<ApprovalOutcome> {
    const requestId = createRequestId()

    return new Promise<ApprovalOutcome>((resolve) => {
      // 逾時是安全的方向，不是例外：規格 §8「批准逾時 → 拒絕，並在對話裡
      // 留下可見記錄」。掛住不回覆比拒絕危險：掛住會讓 query() 整條卡死，
      // 使用者連「這次不行」都看不到。
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        settle(requestId, {
          decision: 'deny',
          reason: `批准請求逾時（${timeoutMs}ms 內未收到回覆）`,
          timedOut: true,
          ...(options.evaluate ? { source: 'system' as const } : {}),
        })
      }, timeoutMs)

      const request: ApprovalRequest = { ...ask, requestId }
      const { validateEvidence: _validate, ...publicRequest } = request
      const controller = new AbortController()
      pending.set(requestId, { resolve, ...(timer === undefined ? {} : { timer }), request, controller })

      try {
        // 展開整個 ask 再補上 requestId，不逐欄位挑：toolUseId（裁決 28）與
        // title／displayName 有沒有值都原樣轉送給 sendRequest（裁決 16）。
        let lastReason = '請由你確認這次操作'
        const progress = (reviewStatus: 'checking' | 'reviewing' | 'manual', reviewReason: string) => {
          lastReason = reviewReason
          if (pending.has(requestId)) sendRequest({ ...publicRequest, reviewStatus, reviewReason })
        }
        if (options.evaluate) {
          progress('checking', '正在檢查授權；你可以直接接管這筆請求')
          void Promise.resolve().then(() => {
            if (controller.signal.aborted) return null
            return options.evaluate!(request, controller.signal, progress)
          }).then(outcome => {
            if (controller.signal.aborted) return
            if (outcome) settle(requestId, outcome)
            else progress('manual', lastReason)
          }).catch(() => {
            if (controller.signal.aborted) return
            try { progress('manual', '自動審核無法完成，請由你確認') }
            catch { settle(requestId, { decision: 'deny', reason: '批准介面無法使用', source: 'system' }) }
          })
        } else sendRequest(publicRequest)
      } catch (error) {
        // 送不出去（視窗已關閉、renderer 還沒 preload 完成）跟逾時是同一種
        // 情況的另一個入口：不會有人回覆這筆請求。立即 deny，不必等滿
        // timeoutMs 才發現，也不能讓例外把 promise 就此晾在那裡沒人 resolve。
        // 規格 §8「批准時 renderer 未就緒或視窗已關 → 同上，拒絕並記錄」。
        settle(requestId, {
          decision: 'deny',
          reason: `無法送出批准請求：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    })
  }

  function reply(requestId: string, decision: ApprovalDecision): boolean {
    const entry = pending.get(requestId)
    if (!entry || entry.answering) return false
    if (decision === 'allow' && options.validateAllow) {
      entry.answering = true
      entry.controller.abort()
      void options.validateAllow(entry.request).then(blocked => {
        settle(requestId, blocked ?? { decision: 'allow', source: 'user' })
      }).catch(() => { settle(requestId, { decision: 'deny', reason: '無法驗證禁止規則', source: 'system' }) })
      return true
    }
    return settle(requestId, { decision })
  }

  function denyAll(reason: string): void {
    // 先把 key 複製出來：settle() 會修改 pending，在 Map 走訪中刪除「目前
    // 造訪的」key 雖然安全，但刪除「還沒走到」的 key 沒有規格保證，不賭這個。
    for (const requestId of [...pending.keys()]) {
      settle(requestId, { decision: 'deny', reason, ...(options.evaluate ? { source: 'system' as const } : {}) })
    }
  }

  function pendingCount(): number {
    return pending.size
  }

  return { request, reply, denyAll, pendingCount }
}
