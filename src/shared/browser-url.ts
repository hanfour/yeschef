/** 網址列輸入的正規化(規格 §5.3)。純函式,renderer 顯示錯誤與 main 實際導航共用。 */
export type BrowserInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'not-url' }

/** 要排在協定判斷之前:`localhost:3000` 的形狀跟「協定 localhost」一樣。 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i
const SCHEME_WITH_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i
/** 沒有 `//` 的協定只認這幾個;原樣往下,由 checkNavigateUrl 的白名單決定放不放行。 */
const BARE_SCHEME = /^(about|javascript|data|blob|mailto):/i

export function normalizeBrowserInput(raw: string): BrowserInput {
  const text = raw.trim()
  if (text === '') return { kind: 'empty' }
  if (LOCAL_HOST.test(text)) return { kind: 'url', url: `http://${text}` }
  if (SCHEME_WITH_SLASHES.test(text) || BARE_SCHEME.test(text)) return { kind: 'url', url: text }
  if (text.includes('.') && !/\s/.test(text)) return { kind: 'url', url: `https://${text}` }
  return { kind: 'not-url' }
}
