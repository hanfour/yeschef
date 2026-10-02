/**
 * 八個方法共用的零件：逾時包裝的 call()、進門檢查、runAsAgent 包裝、
 * snapshot 編號、ref 查表與 ToolText 組裝。
 */
import { CdpError, toCdpError } from '../cdp.js'
import { MSG, ViewToolError } from './errors.js'
import { lookupRef } from './refs.js'
import type { CollectDeps } from './snapshot-collect.js'
import type { RefEntry } from './types.js'
import { CDP_CALL_TIMEOUT_MS, type ControllerDeps, type ToolText } from './controller-types.js'

/** 與 CdpSession.send 同簽章，多了 CDP_CALL_TIMEOUT_MS 的逾時。 */
export type CdpCall = <T>(method: string, params?: object, sessionId?: string) => Promise<T>

export interface ControllerCore {
  readonly deps: ControllerDeps
  readonly call: CdpCall
  /** 給 snapshot-collect 的 deps：send 走 call()，所以蒐集階段的指令也有逾時。 */
  readonly collect: CollectDeps
  /** 進門檢查（isDestroyed／已中止）後把整個動作包進 watcher.runAsAgent()。 */
  act<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>
  /** 只做進門檢查，不包 runAsAgent：request_handoff 的等待期間使用者操作是預期的。 */
  guard(signal: AbortSignal): void
  /** view_snapshot 的流水號，從 1 起。 */
  nextSnapshotId(): number
  /** ref 查表；bad-format／stale／missing 直接翻成 MSG 丟出。 */
  resolveEntry(ref: string): RefEntry
}

export function text(value: string): ToolText {
  return { kind: 'text', text: value }
}

interface CallState {
  timedOut: boolean
}

/**
 * 裁決 14：逾時計時器走注入的 clock，逾時丟 code 為 'timeout' 的 CdpError。
 * `settled` 旗標讓先到的一方定案：CDP 慢一步回來時不會覆寫已經丟出的逾時，
 * 逾時計時器也不會在指令成功後再開一槍。
 */
function createCall(deps: ControllerDeps, state: CallState): CdpCall {
  return <T,>(method: string, params?: object, sessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (state.timedOut) {
        reject(new CdpError(`前一次逾時，略過 ${method}`, 'timeout'))
        return
      }
      let settled = false
      const handle = deps.clock.setTimer(() => {
        if (settled) return
        settled = true
        state.timedOut = true
        reject(new CdpError(MSG.cdpTimeout(method, CDP_CALL_TIMEOUT_MS), 'timeout'))
      }, CDP_CALL_TIMEOUT_MS)
      deps.cdp.send<T>(method, params, sessionId).then(
        (value) => {
          if (settled) return
          settled = true
          deps.clock.clearTimer(handle)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          deps.clock.clearTimer(handle)
          reject(error instanceof Error ? error : toCdpError(error))
        }
      )
    })
}

export function createCore(deps: ControllerDeps): ControllerCore {
  const state: CallState = { timedOut: false }
  const call = createCall(deps, state)
  let lastSnapshotId = 0

  const guard = (signal: AbortSignal): void => {
    state.timedOut = false
    if (deps.webContents.isDestroyed()) throw new ViewToolError(MSG.viewGone)
    if (signal.aborted) throw new ViewToolError(MSG.sessionEnded)
  }

  return {
    deps,
    call,
    collect: {
      cdp: {
        send: call,
        getAttachedTargets: () => deps.cdp.getAttachedTargets(),
        getRearmErrors: () => deps.cdp.getRearmErrors(),
      },
      currentUrl: () => deps.webContents.getURL(),
      currentTitle: () => deps.webContents.getTitle(),
      now: () => deps.clock.now(),
      logError: deps.logError,
    },
    guard,
    act: async (signal, fn) => {
      guard(signal)
      return deps.watcher.runAsAgent(fn)
    },
    nextSnapshotId: () => {
      lastSnapshotId += 1
      return lastSnapshotId
    },
    resolveEntry: (ref) => {
      const lookup = lookupRef(deps.watcher.refs(), ref)
      switch (lookup.kind) {
        case 'ok':
          return lookup.entry
        case 'bad-format':
          throw new ViewToolError(MSG.refFormat)
        case 'stale':
          throw new ViewToolError(MSG.refStale(lookup.snapshotId, lookup.reason))
        default:
          throw new ViewToolError(MSG.refMissing(lookup.snapshotId, lookup.ref))
      }
    },
  }
}
