/**
 * controller 的公開型別與數值常數（契約 §10.2）。獨立成檔的理由：
 * controller.ts 與 controller-page／input／eval 都要用這些型別，型別放在
 * 最上游的葉節點才不會出現「controller.ts 匯入子模組、子模組又回頭匯入
 * controller.ts 的型別」這種循環。對外仍只從 controller.ts 匯出。
 */
import type { MergerClock } from '../agent-host.js'
import type { CdpSession } from '../cdp.js'
import type { Handoff } from './handoff.js'
import type { SettleTracker } from './settle.js'
import type { Watcher } from './watch.js'

/** 測試機規格 §5.4：主行程解出的一筆帳密。password 為 null 時看 passwordUnreadable 分辨「沒設密碼」與「密文解不開」。 */
export interface Credentials {
  readonly username: string
  readonly password: string | null
  readonly passwordUnreadable: boolean
  readonly origin: string
}

export interface ControllerDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly webContents: { isDestroyed(): boolean; getURL(): string; getTitle(): string }
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly clock: MergerClock
  /** 這個 session 所屬專案的 rootPath；每次 navigate 都重新取，不用因為值變了就重建 controller。 */
  readonly projectDir: () => string
  readonly logError: (error: Error) => void
  /** 測試機規格 §5.4:這個 session 所屬專案的測試機帳密。每次呼叫才查,對話不在任何專案裡時回 undefined。 */
  readonly credentials: (machine: string) => Promise<Credentials | undefined>
}

/** 單一 CDP 指令的逾時（裁決 14：在 controller 的 call() 做，不改 cdp.ts）。 */
export const CDP_CALL_TIMEOUT_MS = 10_000
/** view_eval 回傳文字的上限，超過截斷並附原長。 */
export const EVAL_MAX_CHARS = 8_192
/** 截圖縮放的目標寬度上限。 */
export const SCREENSHOT_MAX_WIDTH = 1_280

export interface ToolText {
  readonly kind: 'text'
  readonly text: string
}

export interface ToolImage {
  readonly kind: 'image'
  readonly text: string
  readonly dataBase64: string
  readonly mimeType: 'image/png'
}

export type ToolOutput = ToolText | ToolImage

export interface ViewController {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, text: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
  login(machine: string, usernameRef: string, passwordRef: string, submitRef: string | undefined, signal: AbortSignal): Promise<ToolOutput>
}
