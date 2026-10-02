import type { WebContentsView } from 'electron'
import type { BrowserCommand, BrowserCommandResult } from '../shared/browser-ipc.js'
import { normalizeBrowserInput } from '../shared/browser-url.js'
import type { BrowserSessions } from './browser-sessions.js'
import { MSG } from './view-tools/errors.js'
import { checkNavigateUrl, type UrlCheck } from './view-tools/urls.js'

export interface BrowserCommandsDeps {
  readonly sessions: Pick<BrowserSessions, 'ensure' | 'get'>
  foregroundId(): string | null
  projectDirOf(conversationId: string): string | undefined
  loadPage(view: WebContentsView, url: string): void
  logError(error: Error): void
}

const OK: BrowserCommandResult = { ok: true }
const fail = (message: string): BrowserCommandResult => ({ ok: false, message })

/** 沒有列到的 UrlCheck 變體會在這裡編譯失敗,不會被靜默當成 invalidUrl。 */
function unreachable(check: never): never {
  throw new Error(`checkNavigateUrl 回傳了沒處理過的 kind：${JSON.stringify(check)}`)
}

function rejection(check: Exclude<UrlCheck, { kind: 'ok' }>, raw: string): string {
  if (check.kind === 'bad-scheme') return MSG.badScheme
  if (check.kind === 'outside-project') return MSG.outsideProject(check.projectDir)
  if (check.kind === 'invalid') return MSG.invalidUrl(raw)
  return unreachable(check)
}

/** 網址列的指令(每對話瀏覽器規格 §5.2)。一律作用在前景對話;人輸入的網址跟 view_navigate 過同一份檢查。 */
export function createBrowserCommands(deps: BrowserCommandsDeps): { run(command: BrowserCommand): Promise<BrowserCommandResult> } {
  const navigate = async (id: string, raw: string): Promise<BrowserCommandResult> => {
    const input = normalizeBrowserInput(raw)
    if (input.kind === 'empty') return OK
    if (input.kind === 'not-url') return fail(MSG.notUrl)
    const projectDir = deps.projectDirOf(id)
    if (projectDir === undefined) return fail(MSG.sessionEnded)
    const check = checkNavigateUrl(input.url, projectDir)
    if (check.kind !== 'ok') return fail(rejection(check, input.url))
    try {
      const session = await deps.sessions.ensure(id)
      deps.loadPage(session.view, check.url)
      return OK
    } catch (raw) {
      deps.logError(raw instanceof Error ? raw : new Error(String(raw)))
      return fail(MSG.browserUnavailable)
    }
  }

  const simple = (id: string, kind: Exclude<BrowserCommand['kind'], 'navigate'>): BrowserCommandResult => {
    const wc = deps.sessions.get(id)?.view.webContents
    if (wc === undefined) return OK
    if (kind === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (kind === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (kind === 'reload') wc.reload()
    if (kind === 'stop') wc.stop()
    return OK
  }

  return {
    run: async (command) => {
      const id = deps.foregroundId()
      if (id === null) return OK
      return command.kind === 'navigate' ? navigate(id, command.url) : simple(id, command.kind)
    },
  }
}
