import type { WebContentsView } from 'electron'
import type { MergerClock } from '../agent-host.js'
import { CdpError, type CdpSession } from '../cdp.js'
import { MSG, ViewToolError } from './errors.js'
import { CDP_CALL_TIMEOUT_MS, createViewController, type Credentials, type ViewController } from './controller.js'
import { createHandoff } from './handoff.js'
import { viewToolDef, type InvokeContext, type ViewToolInvocation } from './tool-defs.js'
export type { InvokeContext, ViewToolInvocation }
import { createSettleTracker } from './settle.js'
import { createWatcher } from './watch.js'

export interface ViewToolDeps {
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly clock: MergerClock
  /** 這個 session 所屬專案的 rootPath。對話已不在任何專案裡時丟 ViewToolError(MSG.sessionEnded)。 */
  readonly projectDir: () => string
  readonly logError: (error: Error) => void
  /** 測試機規格 §5.4:這個 session 所屬專案的測試機帳密。 */
  readonly credentials: (machine: string) => Promise<Credentials | undefined>
  /** 進行中的工具呼叫從 0 變 1、從 1 變 0 時各叫一次。 */
  readonly onBusyChange?: (busy: boolean) => void
}

export interface ViewTools {
  invoke(name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation>
  handoffDone(toolUseId: string): void
  abortPending(reason: string): void
  busy(): boolean
  dispose(): Promise<void>
}

const WATCHER_CREATE_TIMEOUT_MS = CDP_CALL_TIMEOUT_MS

/** 例外翻成給模型看的一句中文(契約 §10.3)。ViewToolError 的 message 本來就是 MSG 表的字。 */
export function toErrorText(error: unknown, logError: (error: Error) => void): string {
  if (error instanceof ViewToolError) return error.message
  if (error instanceof CdpError) return MSG.cdpFailed(error.code, error.message)
  const wrapped = error instanceof Error ? error : new Error(String(error))
  logError(wrapped)
  return MSG.internal(wrapped.message)
}

interface Inflight {
  calls: readonly { readonly controller: AbortController; readonly handoff: boolean }[]
}

interface ToolRuntime {
  readonly controller: ViewController
  readonly inflight: Inflight
  readonly isDisposed: () => boolean
  readonly logError: (error: Error) => void
  readonly onBusyChange: (busy: boolean) => void
}

/**
 * 後端無關的入口(codex view tools 規格 §4.1)。登記 inflight、合併 signal、
 * 把任何結果或例外轉成 ViewToolInvocation。永不 reject。
 */
async function invokeTool(runtime: ToolRuntime, name: string, args: unknown, ctx: InvokeContext): Promise<ViewToolInvocation> {
  if (runtime.isDisposed()) return { ok: false, text: MSG.sessionEnded }
  const def = viewToolDef(name)
  if (def === undefined) return { ok: false, text: MSG.unknownTool(name) }
  const own = new AbortController()
  setCalls(runtime, [...runtime.inflight.calls, { controller: own, handoff: name === 'request_handoff' }])
  try {
    // 裁決 19:自己的中止與外面(MCP 的 extra.signal)的中止都要能停掉等待。
    const signal = ctx.signal === undefined ? own.signal : AbortSignal.any([own.signal, ctx.signal])
    return { ok: true, output: await def.run(runtime.controller, args, { callId: ctx.callId }, signal) }
  } catch (error) {
    return { ok: false, text: toErrorText(error, runtime.logError) }
  } finally {
    setCalls(runtime, runtime.inflight.calls.filter((call) => call.controller !== own))
  }
}

/** inflight 只從這裡改,0 與非 0 之間切換時才通知。 */
function setCalls(runtime: ToolRuntime, next: Inflight['calls']): void {
  const wasBusy = runtime.inflight.calls.length > 0
  runtime.inflight.calls = next
  const isBusy = next.length > 0
  if (wasBusy !== isBusy) runtime.onBusyChange(isBusy)
}

function abortAll(runtime: ToolRuntime, reason: string, disposing = false): void {
  // 交接就是等待使用者操作，切分頁不能打斷；只有收掉對話才中止它。
  const pending = runtime.inflight.calls
  setCalls(runtime, disposing ? [] : pending.filter((call) => call.handoff))
  for (const call of pending) {
    if (disposing || !call.handoff) call.controller.abort(new ViewToolError(reason))
  }
}

/**
 * 組裝一個 session 的工具:watcher、settle、handoff、controller 各一份,跟著這個
 * session 的 view。MCP server 在 conversation-server.ts。
 */
export async function createViewToolServer(deps: ViewToolDeps): Promise<ViewTools> {
  const webContents = deps.view.webContents
  let watcher: Awaited<ReturnType<typeof createWatcher>> | undefined
  let watcherTimedOut = false
  let watcherTimer: unknown = null
  const watcherPromise = createWatcher({ cdp: deps.cdp, webContents, logError: deps.logError })
  watcherPromise.then((created) => {
    if (watcherTimedOut) created.dispose()
  }).catch(() => {})
  try {
    const timeout = new Promise<Awaited<ReturnType<typeof createWatcher>>>((_, reject) => {
      watcherTimer = deps.clock.setTimer(() => {
        watcherTimedOut = true
        reject(new Error(MSG.internal('右窗格工具建立逾時')))
      }, WATCHER_CREATE_TIMEOUT_MS)
    })
    const activeWatcher = await Promise.race([watcherPromise, timeout])
    watcher = activeWatcher
    deps.clock.clearTimer(watcherTimer)

    const settle = createSettleTracker(deps.cdp, deps.clock)
    const handoff = createHandoff(deps.clock, deps.logError)
    const controller = createViewController({
      cdp: deps.cdp,
      webContents,
      watcher: activeWatcher,
      settle,
      handoff,
      clock: deps.clock,
      projectDir: deps.projectDir,
      logError: deps.logError,
      credentials: deps.credentials,
    })

    let disposed = false
    const runtime: ToolRuntime = {
      controller,
      inflight: { calls: [] },
      isDisposed: () => disposed,
      logError: deps.logError,
      onBusyChange: deps.onBusyChange ?? (() => {}),
    }
    return {
      invoke: (name, args, ctx) => invokeTool(runtime, name, args, ctx),
      handoffDone: (toolUseId) => { handoff.done(toolUseId) },
      abortPending: (reason) => { abortAll(runtime, reason) },
      busy: () => runtime.inflight.calls.length > 0,
      dispose: async () => {
        disposed = true
        abortAll(runtime, MSG.sessionEnded, true)
        activeWatcher.dispose()
        settle.dispose()
        handoff.abortAll()
      },
    }
  } catch (error) {
    if (watcherTimer !== null) deps.clock.clearTimer(watcherTimer)
    watcher?.dispose()
    throw error
  }
}
