/**
 * 交接等待（契約 §9.4）。單一 pending 的狀態機：同時只允許一筆 request_handoff
 * 在等使用者。使用者按下、逾時（`HANDOFF_TIMEOUT_MS`）、或收尾（`abortAll`／
 * `signal` 中止）三條路都會 resolve 同一個 promise，且都會清掉 pending 與計時器，
 * 讓下一次 `begin()` 可以重新開始。不碰 CDP、不碰 renderer，純狀態機加注入的
 * `MergerClock`（裁決 8：`toolUseId` 由呼叫端從 handler 的 `extra` 取出後傳進來）。
 */

import type { MergerClock } from '../agent-host.js'
import { MSG, ViewToolError } from './errors.js'
import type { HandoffOutcome, HandoffPending } from './types.js'

export const HANDOFF_TIMEOUT_MS = 10 * 60_000
export const EARLY_DONE_MAX = 8

export interface HandoffWaitResult {
  readonly outcome: HandoffOutcome
}

export interface Handoff {
  pending(): HandoffPending | null
  /**
   * 工具處理函式呼叫。建立以 toolUseId 為 key 的 pending 並等待。
   * 已有 pending → 丟 ViewToolError(MSG.handoffBusy(existing.reason))。
   * 使用者按下 → { outcome: 'done' }；逾時 → { outcome: 'timeout' }；signal 中止 → { outcome: 'session-ended' }。
   */
  begin(toolUseId: string, reason: string, signal?: AbortSignal): Promise<HandoffWaitResult>
  /**
   * renderer 的 handoff:done。id 等於 pending 的 → 以 done resolve。
   * 否則記進 earlyDone（最多 EARLY_DONE_MAX 個，滿了淘汰最舊的），不 logError：
   * 同一則訊息帶多個工具時，卡片按鈕會比 handler 早出現，使用者先按了就先記著（裁決 31）。
   * begin() 帶的 id 已在 earlyDone → 移除並立即回 { outcome: 'done' }。
   */
  done(toolUseId: string): void
  /** 收尾。pending 以 session-ended resolve；earlyDone 清空。 */
  abortAll(): void
}

/** 目前這一筆等待的所有可變狀態，全部包在一個物件裡，resolve 後整包丟棄。 */
interface ActiveWait {
  readonly pending: HandoffPending
  readonly resolve: (result: HandoffWaitResult) => void
  readonly timerHandle: unknown
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

export function createHandoff(clock: MergerClock, logError: (error: Error) => void): Handoff {
  let active: ActiveWait | null = null
  // 裁決 31：done() 對不上目前 pending 的 id 先記在這裡（FIFO，插入順序即 Set 的走訪順序），
  // 等對應的 begin() 真的呼叫時直接命中，不必等一輪逾時或誤判成別筆訊息。
  const earlyDone = new Set<string>()

  /** 三條收尾路徑（done／timeout／abortAll）共用：清 timer、解除 abort 監聽、清 pending，最後才 resolve。 */
  function finish(outcome: HandoffOutcome): void {
    const current = active
    if (current === null) return
    active = null
    clock.clearTimer(current.timerHandle)
    if (current.signal !== undefined && current.onAbort !== undefined) {
      current.signal.removeEventListener('abort', current.onAbort)
    }
    current.resolve({ outcome })
  }

  return {
    pending: () => (active === null ? null : active.pending),

    begin(toolUseId, reason, signal) {
      // 裁決 31：使用者搶先按過（handler 還沒開始跑，卡片已經先顯示出來），直接視為完成，
      // 不佔用 pending 名額，也不受目前是否有別筆 pending（handoffBusy）影響。
      if (earlyDone.has(toolUseId)) {
        earlyDone.delete(toolUseId)
        return Promise.resolve({ outcome: 'done' })
      }
      if (active !== null) {
        return Promise.reject(new ViewToolError(MSG.handoffBusy(active.pending.reason)))
      }
      if (signal?.aborted === true) {
        return Promise.resolve({ outcome: 'session-ended' })
      }
      return new Promise<HandoffWaitResult>((resolve) => {
        const timerHandle = clock.setTimer(() => finish('timeout'), HANDOFF_TIMEOUT_MS)
        const onAbort = signal === undefined ? undefined : () => finish('session-ended')
        if (signal !== undefined && onAbort !== undefined) {
          signal.addEventListener('abort', onAbort)
        }
        active = {
          pending: { toolUseId, reason, askedAt: clock.now() },
          resolve,
          timerHandle,
          signal,
          onAbort,
        }
      })
    },

    done(toolUseId) {
      if (active !== null && active.pending.toolUseId === toolUseId) {
        finish('done')
        return
      }
      // 裁決 31：不再 logError。記進 earlyDone，滿了（超過 EARLY_DONE_MAX）淘汰最舊的一筆；
      // Set 的走訪順序等於插入順序，第一個元素就是最舊的。重複呼叫同一個 id 不會移動它的位置。
      earlyDone.add(toolUseId)
      if (earlyDone.size > EARLY_DONE_MAX) {
        const oldest = earlyDone.values().next().value
        if (oldest !== undefined) earlyDone.delete(oldest)
      }
    },

    abortAll() {
      earlyDone.clear()
      if (active === null) return
      finish('session-ended')
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 從 MCP handler 的 `extra._meta['claudecode/toolUseId']` 取出 toolUseId（裁決 8）。
 * `extra` 不是物件、`_meta` 不是物件、或該欄位不是非空字串都回 null；server.ts
 * 收到 null 時丟 `ViewToolError(MSG.handoffNoId)`（那段邏輯不在這裡，這裡只負責讀值）。
 */
export function readToolUseId(extra: unknown): string | null {
  if (!isRecord(extra)) return null
  const meta = extra['_meta']
  if (!isRecord(meta)) return null
  const id = meta['claudecode/toolUseId']
  return typeof id === 'string' && id.length > 0 ? id : null
}
