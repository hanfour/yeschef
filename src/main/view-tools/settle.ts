import type { CdpEventListener, CdpSession } from '../cdp.js'
import type { MergerClock } from '../agent-host.js'

/** 在飛請求連續為零多久算靜默（契約 §9.2）。 */
export const SETTLE_QUIET_MS = 500
/** click／type／press 之後等靜默的上限。 */
export const SETTLE_TIMEOUT_MS = 5_000
/** navigate 的 load 加靜默合計上限。 */
export const NAVIGATE_TIMEOUT_MS = 8_000
/** 認定請求不會再有結束事件（例如 SSE 或長輪詢）的上限，須大於正常慢請求的回應時間。 */
export const INFLIGHT_MAX_AGE_MS = 30_000

export type SettleOutcome = 'quiet' | 'timeout' | 'aborted'

export interface SettleWaitOptions {
  readonly quietMs: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface SettleTracker {
  /** 目前在飛的請求數（所有 session 合計）。 */
  inflight(): number
  /** inflight 連續 quietMs 為 0 → 'quiet'；到 timeoutMs → 'timeout'；signal 中止 → 'aborted'。 */
  waitForQuiet(opts: SettleWaitOptions): Promise<SettleOutcome>
  /** 等主 frame 的 Page.loadEventFired 或 Page.navigatedWithinDocument 再接 waitForQuiet，兩段合計不超過 timeoutMs。 */
  waitForLoad(opts: SettleWaitOptions): Promise<SettleOutcome>
  /** 解除訂閱、清計時器；還在等的 waitFor* 全部以 'aborted' 結束。 */
  dispose(): void
}

interface QuietWaiter {
  readonly quietMs: number
  quietTimer: unknown
  deadlineTimer: unknown
  staleTimer: unknown
  readonly finish: (outcome: SettleOutcome) => void
}

interface LoadWaiter {
  readonly hit: () => void
  readonly abort: () => void
}

function requestIdOf(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const id = (params as { requestId?: unknown }).requestId
  return typeof id === 'string' ? id : null
}

/** requestWillBeSent 的 type 是 ResourceType，欄位在協定上是選填的。 */
function resourceTypeOf(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const type = (params as { type?: unknown }).type
  return typeof type === 'string' ? type : null
}

/** Target.detachedFromTarget 的 params.sessionId 是走掉的那個子 session。 */
function detachedSessionOf(params: unknown): string | null {
  if (params === null || typeof params !== 'object') return null
  const id = (params as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 主 frame 換頁：sessionId 為 undefined（root session）且 frame 沒有 parentId。
 *
 * 兩個條件都要：OOPIF 自己的 session 也會為它那個 iframe 送出沒有 parentId 的
 * frameNavigated（在那個 target 眼裡它就是最上層），只看 parentId 會讓 iframe
 * 內部換頁清掉整頁的在飛請求。
 */
function isMainFrameNavigation(params: unknown, sessionId: string | undefined): boolean {
  if (sessionId !== undefined) return false
  if (params === null || typeof params !== 'object') return false
  const frame = (params as { frame?: unknown }).frame
  if (frame === null || typeof frame !== 'object') return false
  return (frame as { parentId?: unknown }).parentId === undefined
}

/**
 * 網路靜默與載入等待。
 *
 * 只吃 CDP 事件，時間全部走注入的 clock（測試用 tests/helpers/manual-clock.ts），
 * 所以 500ms 與 5 秒兩個計時器並存時的到期順序是可測的。
 */
export function createSettleTracker(cdp: Pick<CdpSession, 'onEvent'>, clock: MergerClock): SettleTracker {
  /**
   * requestId 對同一個請求跨 session 相同（實測），所以結束事件只比對
   * requestId。sessionId 留在值裡，讓 Target.detachedFromTarget 能只清掉
   * 走掉那個 session 的請求。
   */
  const inflightIds = new Map<string, { sessionId: string | undefined; startedAt: number }>()
  const quietWaiters = new Set<QuietWaiter>()
  const loadWaiters = new Set<LoadWaiter>()
  let disposed = false

  const pruneExpiredInflight = (): void => {
    const cutoff = clock.now() - INFLIGHT_MAX_AGE_MS
    for (const [requestId, value] of inflightIds) {
      if (value.startedAt < cutoff) inflightIds.delete(requestId)
    }
  }

  const nextInflightExpiry = (): number | null => {
    let next = Number.POSITIVE_INFINITY
    for (const value of inflightIds.values()) {
      next = Math.min(next, value.startedAt + INFLIGHT_MAX_AGE_MS + 1)
    }
    return Number.isFinite(next) ? next : null
  }

  /** 靜默計時重排：呼叫當下就排一次，之後每則計數事件再排一次。 */
  const armQuiet = (waiter: QuietWaiter): void => {
    clock.clearTimer(waiter.quietTimer)
    waiter.quietTimer = null
    clock.clearTimer(waiter.staleTimer)
    waiter.staleTimer = null
    pruneExpiredInflight()
    if (inflightIds.size > 0) {
      const expiry = nextInflightExpiry()
      if (expiry !== null) {
        waiter.staleTimer = clock.setTimer(
          () => armQuiet(waiter),
          Math.max(1, expiry - clock.now()),
        )
      }
      return
    }
    waiter.quietTimer = clock.setTimer(() => {
      waiter.finish('quiet')
    }, waiter.quietMs)
  }

  /** 回傳這則事件是否進入在飛計數的範圍（是的話所有 waiter 都要重排靜默計時）。 */
  const applyToInflight = (method: string, params: unknown, sessionId: string | undefined): boolean => {
    if (method === 'Network.requestWillBeSent') {
      const id = requestIdOf(params)
      if (id === null) return false
      // EventSource 永遠不會有 loadingFinished，計進來就再也靜不下來。
      if (resourceTypeOf(params) === 'EventSource') return false
      // Map：redirect 會用同一個 requestId 再送一次，不重設原本的老化時間。
      if (!inflightIds.has(id)) inflightIds.set(id, { sessionId, startedAt: clock.now() })
      return true
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const id = requestIdOf(params)
      if (id === null) return false
      return inflightIds.delete(id)
    }
    if (method === 'Target.detachedFromTarget') {
      const gone = detachedSessionOf(params)
      if (gone === null) return false
      // iframe 在載入途中被移除：它的請求不會再有 finished，留著會永遠靜不下來。
      for (const [requestId, value] of inflightIds) {
        if (value.sessionId === gone) inflightIds.delete(requestId)
      }
      return true
    }
    if (method === 'Page.frameNavigated' && isMainFrameNavigation(params, sessionId)) {
      // 舊頁的請求不會再有 finished，留著會讓後續每次等待都撐到逾時。
      inflightIds.clear()
      return true
    }
    return false
  }

  const handleEvent: CdpEventListener = (method, params, sessionId) => {
    if (disposed) return
    // hash 與 SPA 的同文件導航只發 navigatedWithinDocument，沒有 loadEventFired。
    // 兩者都只認 root session 那則（裁決 30）。
    if (method === 'Page.loadEventFired' || method === 'Page.navigatedWithinDocument') {
      if (sessionId === undefined) for (const waiter of [...loadWaiters]) waiter.hit()
      return
    }
    if (!applyToInflight(method, params, sessionId)) return
    for (const waiter of quietWaiters) armQuiet(waiter)
  }

  const unsubscribe = cdp.onEvent(handleEvent)

  const waitForQuiet = (opts: SettleWaitOptions): Promise<SettleOutcome> => {
    if (opts.signal?.aborted === true || disposed) return Promise.resolve<SettleOutcome>('aborted')
    return new Promise<SettleOutcome>((resolve) => {
      const waiter: QuietWaiter = {
        quietMs: opts.quietMs,
        quietTimer: null,
        deadlineTimer: null,
        staleTimer: null,
        finish: (outcome) => {
          // delete 回 false 代表這個 waiter 已經結束過，後到的計時器不再改變結果。
          if (!quietWaiters.delete(waiter)) return
          clock.clearTimer(waiter.quietTimer)
          clock.clearTimer(waiter.deadlineTimer)
          clock.clearTimer(waiter.staleTimer)
          waiter.quietTimer = null
          waiter.deadlineTimer = null
          waiter.staleTimer = null
          opts.signal?.removeEventListener('abort', onAbort)
          resolve(outcome)
        },
      }
      const onAbort = (): void => {
        waiter.finish('aborted')
      }
      quietWaiters.add(waiter)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      waiter.deadlineTimer = clock.setTimer(() => {
        waiter.finish('timeout')
      }, opts.timeoutMs)
      armQuiet(waiter)
    })
  }

  const waitForLoad = (opts: SettleWaitOptions): Promise<SettleOutcome> => {
    if (opts.signal?.aborted === true || disposed) return Promise.resolve<SettleOutcome>('aborted')
    const startedAt = clock.now()
    return new Promise<SettleOutcome>((resolve) => {
      let settled = false
      let waiter: LoadWaiter | null = null
      let deadlineTimer: unknown = null
      const cleanup = (): void => {
        if (waiter !== null) loadWaiters.delete(waiter)
        clock.clearTimer(deadlineTimer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        waiter?.abort()
      }
      waiter = {
        hit: () => {
          if (settled) return
          settled = true
          cleanup()
          // 兩段合計不超過 timeoutMs：第二段只拿剩下的時間。
          const remaining = opts.timeoutMs - (clock.now() - startedAt)
          if (remaining <= 0) {
            resolve('timeout')
            return
          }
          resolve(waitForQuiet({ quietMs: opts.quietMs, timeoutMs: remaining, signal: opts.signal }))
        },
        abort: () => {
          if (settled) return
          settled = true
          cleanup()
          resolve('aborted')
        },
      }
      loadWaiters.add(waiter)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      deadlineTimer = clock.setTimer(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve('timeout')
      }, opts.timeoutMs)
    })
  }

  return {
    inflight: () => {
      pruneExpiredInflight()
      return inflightIds.size
    },
    waitForQuiet,
    waitForLoad,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      // 契約 §9.2 只寫「退訂並清計時器」；等待中的呼叫端一律收 'aborted'，
      // 不留永遠不 resolve 的 promise（teardown 時 controller 會翻成「對話已結束」）。
      for (const waiter of [...loadWaiters]) waiter.abort()
      for (const waiter of [...quietWaiters]) waiter.finish('aborted')
      inflightIds.clear()
    },
  }
}
