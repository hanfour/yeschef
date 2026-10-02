import type { WebContentsView } from 'electron'
import type { BrowserSessionEntry, BrowserSnapshot, BrowserStatePayload } from '../shared/browser-ipc.js'
import { MSG, ViewToolError } from './view-tools/errors.js'
import type { ViewTools } from './view-tools/server.js'
import type { ViewToolStartup } from './view-tools/startup.js'
import type { Credentials } from './view-tools/controller-types.js'
import type { ViewSwitch } from './view-switch.js'

export interface BrowserSession {
  readonly view: WebContentsView
  readonly tools: ViewTools
}

export interface StartToolsArgs {
  readonly view: WebContentsView
  readonly projectDir: () => string
  readonly credentials: (machine: string) => Promise<Credentials | undefined>
  readonly onBusyChange: (busy: boolean) => void
}

export interface BrowserSessionsDeps {
  createView(conversationId: string): WebContentsView
  addChildView(view: WebContentsView): void
  removeChildView(view: WebContentsView): void
  loadPage(view: WebContentsView, url: string): void
  startTools(args: StartToolsArgs): Promise<ViewToolStartup>
  /** 對話目前所屬專案的 rootPath;每次用到都重查,專案被重新指定資料夾時不必另外同步。 */
  projectDirOf(conversationId: string): string | undefined
  /** 測試機規格 §5.4:這個對話所屬專案的測試機帳密;每次呼叫才查專案。 */
  credentialsOf(conversationId: string, machine: string): Promise<Credentials | undefined>
  readonly switcher: ViewSwitch
  /** 換了顯示目標之後,讓 placement 把目前的矩形套到新的 view 上。 */
  relayout(): void
  onState(state: BrowserStatePayload): void
  onSessions(sessions: readonly BrowserSessionEntry[]): void
  onNavigated(conversationId: string, url: string): void
  logError(error: Error): void
}

export interface BrowserSessions {
  ensure(conversationId: string): Promise<BrowserSession>
  get(conversationId: string): BrowserSession | undefined
  show(conversationId: string | null): void
  dispose(conversationId: string): Promise<void>
  disposeAll(): Promise<void>
  snapshot(): BrowserSnapshot
}

interface Entry {
  readonly session: BrowserSession
  readonly startup: ViewToolStartup
}

/** CDP 指令要等 renderer 行程存在才收得到,所以附著前先讓 view 開始載入,不必等它載完。 */
const INITIAL_URL = 'about:blank'

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

function stateOf(conversationId: string, view: WebContentsView): BrowserStatePayload {
  const wc = view.webContents
  return {
    conversationId,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  }
}

/**
 * 每個對話一個瀏覽器(每對話瀏覽器規格 §3、§4.1)。第一次用到才建,對話關閉時收掉。
 * 這裡是唯一加入與移除 agent view 的地方。
 */
export function createBrowserSessions(deps: BrowserSessionsDeps): BrowserSessions {
  let entries: ReadonlyMap<string, Entry> = new Map()
  let building: ReadonlyMap<string, Promise<BrowserSession>> = new Map()
  /** 建立途中被 dispose 的 id:建完要立刻收掉。 */
  let cancelled: ReadonlySet<string> = new Set()
  let shownId: string | null = null
  let closed = false

  const pushSessions = (): void => {
    deps.onSessions([...entries].map(([conversationId, e]) => ({ conversationId, busy: e.session.tools.busy() })))
  }
  const pushState = (id: string): void => {
    const entry = entries.get(id)
    if (entry !== undefined && !entry.session.view.webContents.isDestroyed()) deps.onState(stateOf(id, entry.session.view))
  }

  const removeView = (view: WebContentsView): void => {
    deps.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  const retarget = (): void => {
    const entry = shownId === null ? undefined : entries.get(shownId)
    deps.switcher.target(entry?.session.view ?? null)
    deps.relayout()
  }

  const watch = (id: string, view: WebContentsView): void => {
    const wc = view.webContents
    const navigatedTo = (url: string): void => { deps.onNavigated(id, url); pushState(id) }
    wc.on('did-navigate', (_event, url) => { navigatedTo(url) })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) navigatedTo(url) })
    wc.on('did-start-loading', () => { pushState(id) })
    wc.on('did-stop-loading', () => { pushState(id) })
    wc.on('page-title-updated', () => { pushState(id) })
    wc.on('render-process-gone', () => { dispose(id).catch((err: unknown) => { deps.logError(toError(err)) }) })
  }

  const projectDir = (id: string) => (): string => {
    const dir = deps.projectDirOf(id)
    if (dir === undefined) throw new ViewToolError(MSG.sessionEnded)
    return dir
  }

  const build = async (id: string): Promise<BrowserSession> => {
    const view = deps.createView(id)
    view.setVisible(false)
    deps.addChildView(view)
    deps.loadPage(view, INITIAL_URL)
    const startup = await deps.startTools({
      view,
      projectDir: projectDir(id),
      credentials: (machine) => deps.credentialsOf(id, machine),
      onBusyChange: pushSessions,
    })
    const wasCancelled = cancelled.has(id) || closed
    if (startup.viewTools === undefined || wasCancelled) {
      await startup.dispose().catch((err: unknown) => { deps.logError(toError(err)) })
      removeView(view)
      throw new Error(wasCancelled ? MSG.sessionEnded : MSG.browserUnavailable)
    }
    const session: BrowserSession = { view, tools: startup.viewTools }
    entries = new Map([...entries, [id, { session, startup }]])
    watch(id, view)
    if (shownId === id) retarget()
    pushSessions()
    pushState(id)
    return session
  }

  const ensure = (id: string): Promise<BrowserSession> => {
    if (closed) return Promise.reject(new Error(MSG.sessionEnded))
    const ready = entries.get(id)
    if (ready !== undefined) return Promise.resolve(ready.session)
    const running = building.get(id)
    if (running !== undefined) return running
    const task = build(id).finally(() => {
      building = new Map([...building].filter(([key]) => key !== id))
      cancelled = new Set([...cancelled].filter((key) => key !== id))
    })
    building = new Map([...building, [id, task]])
    return task
  }

  async function dispose(id: string): Promise<void> {
    const running = building.get(id)
    if (running !== undefined) {
      cancelled = new Set([...cancelled, id])
      await running.catch(() => {})
      // 不在這裡 return:running settle 之後有兩種情況都要往下走到 entries 那段清理——
      // 真的被取消的 build 從沒寫入 entries,下面 `entry === undefined` 會直接回傳;
      // 但若 build 其實已經成功(entries 已寫、只是清 building 的 .finally 還沒排到),
      // 上面的 cancelled 標記為時已晚不會有人再讀,這個 session 需要走正常收尾,
      // 否則 view 留在視窗裡、startup 沒收、登錄表留著永遠不會被清掉的一筆。
    }
    const entry = entries.get(id)
    if (entry === undefined) return
    entries = new Map([...entries].filter(([key]) => key !== id))
    if (shownId === id) deps.switcher.target(null)
    await entry.startup.dispose().catch((err: unknown) => { deps.logError(toError(err)) })
    removeView(entry.session.view)
    pushSessions()
  }

  return {
    ensure,
    get: (id) => entries.get(id)?.session,
    show: (id) => { shownId = id; retarget() },
    dispose,
    disposeAll: async () => {
      closed = true
      await Promise.all([...new Set([...entries.keys(), ...building.keys()])].map((id) => dispose(id)))
    },
    snapshot: () => {
      const alive = [...entries].filter(([, e]) => !e.session.view.webContents.isDestroyed())
      return {
        states: alive.map(([id, e]) => stateOf(id, e.session.view)),
        sessions: alive.map(([conversationId, e]) => ({ conversationId, busy: e.session.tools.busy() })),
      }
    },
  }
}
