/**
 * 左邊 renderer 這個 webContents 只該載入 app 本身。preload 會在同一個 webContents 的
 * 每次導航重新注入,所以它一旦被導到外部網站,那個網站就拿得到 window.yeschef 整組 API
 * (送訊息給 agent、回覆批准、連本機終端機、讀專案檔案)。
 * 預覽 Markdown 讓專案裡任何人寫的連結都能觸發這件事(RESULTS-21 §5),所以導航一律擋下,
 * http 與 https 的連結改交給系統瀏覽器開,其他 scheme 一律不開。
 * 唯一的例外是 renderer 自己的來源(dev 模式的 vite server):HMR 整頁重載也是一次 will-navigate,
 * 擋下再交給系統瀏覽器會每次存檔多開一個 localhost 分頁。同來源的導航放行,那本來就是 app 自己。
 */
export type RendererNavigation =
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'self' }
  | { readonly kind: 'block' }

const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:'])

export function decideRendererNavigation(url: string, ownOrigin?: string): RendererNavigation {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'block' }
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return { kind: 'block' }
  if (ownOrigin !== undefined && parsed.origin === ownOrigin) return { kind: 'self' }
  return { kind: 'external', url: parsed.href }
}

export interface GuardableWebContents {
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
}

export interface RendererGuardDeps {
  openExternal(url: string): Promise<void>
  logError(error: Error): void
  /** renderer 自己的來源(例如 dev 的 `http://localhost:5173`);同來源的導航放行。打包後沒有,全部照擋。 */
  readonly ownOrigin?: string
}

export function guardRendererNavigation(contents: GuardableWebContents, deps: RendererGuardDeps): void {
  const handle = (url: string): void => {
    const decision = decideRendererNavigation(url, deps.ownOrigin)
    if (decision.kind === 'self') return
    if (decision.kind === 'block') {
      deps.logError(new Error(`左窗格擋下導航:${url}`))
      return
    }
    deps.openExternal(decision.url).catch((err: unknown) => {
      deps.logError(err instanceof Error ? err : new Error(String(err)))
    })
  }
  contents.on('will-navigate', (event, url) => {
    if (decideRendererNavigation(url, deps.ownOrigin).kind === 'self') return
    event.preventDefault()
    handle(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    handle(url)
    return { action: 'deny' }
  })
}
