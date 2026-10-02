import type { WebContents, WebContentsView } from 'electron'
import type { MergerClock } from '../agent-host.js'
import type { AttachCdpOptions, CdpSession } from '../cdp.js'
import type { ViewToolDeps, ViewTools } from './server.js'
import { CDP_CALL_TIMEOUT_MS } from './controller-types.js'

/** 停用時印在 console 的那一行前綴（契約 §13，裁決 17）。 */
export const VIEW_TOOLS_DISABLED_PREFIX = '[yeschef] 右窗格工具停用：'
/** 沿用單一 CDP 指令的 10 秒上限，避免附著動作永久等待。 */
export const ATTACH_CDP_TIMEOUT_MS = CDP_CALL_TIMEOUT_MS

export interface ViewToolStartupDeps {
  readonly view: WebContentsView
  readonly clock: MergerClock
  /** 目前 active 專案的 rootPath；原樣交給 create。 */
  readonly projectDir: () => string
  readonly logError: (error: Error) => void
  /** 測試機規格 §5.4：這個 session 所屬專案的測試機帳密；原樣交給 create。 */
  readonly credentials: ViewToolDeps['credentials']
  /** 印那一行；index.ts 給 console.error。 */
  readonly warn: (line: string) => void
  readonly attach: (wc: WebContents, opts: AttachCdpOptions) => Promise<CdpSession>
  readonly create: (deps: ViewToolDeps) => Promise<ViewTools>
  /** 進行中的工具呼叫從 0 變 1、從 1 變 0 時各叫一次；原樣交給 create。 */
  readonly onBusyChange?: (busy: boolean) => void
}

export interface ViewToolStartup {
  /** undefined 表示右窗格工具停用（裁決 17／34）；index.ts 就不替任何對話建 view server。 */
  readonly viewTools: ViewTools | undefined
  dispose(): Promise<void>
}

/** 裁決 34 的無工具路徑。viewTools 是 undefined，dispose 什麼都不做。 */
const NO_TOOLS: ViewToolStartup = {
  viewTools: undefined,
  dispose: () => Promise.resolve(),
}

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

function report(deps: ViewToolStartupDeps, error: Error): void {
  deps.logError(error)
  deps.warn(`${VIEW_TOOLS_DISABLED_PREFIX}${error.message}`)
}

/** cdp 收不掉不該再蓋掉原本的啟動失敗，記下來就好。 */
function detachQuietly(cdp: CdpSession, logError: (error: Error) => void): void {
  try {
    cdp.detach()
  } catch (raw) {
    logError(toError(raw))
  }
}

async function attachWithTimeout(deps: ViewToolStartupDeps): Promise<CdpSession> {
  let timer: unknown
  try {
    const timeout = new Promise<CdpSession>((_, reject) => {
      timer = deps.clock.setTimer(() => {
        reject(new Error(`CDP 附著逾時（${ATTACH_CDP_TIMEOUT_MS} 毫秒）`))
      }, ATTACH_CDP_TIMEOUT_MS)
    })
    return await Promise.race([
      deps.attach(deps.view.webContents, { onListenerError: deps.logError }),
      timeout,
    ])
  } finally {
    if (timer !== undefined) deps.clock.clearTimer(timer)
  }
}

export async function startViewTools(deps: ViewToolStartupDeps): Promise<ViewToolStartup> {
  let cdp: CdpSession
  try {
    cdp = await attachWithTimeout(deps)
  } catch (raw) {
    report(deps, toError(raw))
    return NO_TOOLS
  }

  let viewTools: ViewTools
  try {
    viewTools = await deps.create({
      view: deps.view,
      cdp,
      clock: deps.clock,
      projectDir: deps.projectDir,
      logError: deps.logError,
      credentials: deps.credentials,
      ...(deps.onBusyChange === undefined ? {} : { onBusyChange: deps.onBusyChange }),
    })
  } catch (raw) {
    report(deps, toError(raw))
    detachQuietly(cdp, deps.logError)
    return NO_TOOLS
  }

  let disposed = false
  return {
    viewTools,
    dispose: async () => {
      if (disposed) return
      disposed = true
      let disposeError: unknown
      let disposeFailed = false
      try {
        await viewTools.dispose()
      } catch (raw) {
        disposeFailed = true
        disposeError = raw
      }
      detachQuietly(cdp, deps.logError)
      if (disposeFailed) throw disposeError
    },
  }
}
