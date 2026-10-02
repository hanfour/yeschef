/**
 * view_navigate 的網址檢查：協定白名單與 file:// 的專案目錄範圍限制。
 *
 * 純 Node，不 import Electron（契約 §1：純函式模組不 import Electron）。
 * 只做判別，不丟例外；controller.ts 依 UrlCheck.kind 決定要不要用 errors.ts 的 MSG 組錯誤。
 */

import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'

export type UrlCheck =
  | { readonly kind: 'ok'; readonly url: string } // 正規化後（new URL().href）
  | { readonly kind: 'bad-scheme' }
  | { readonly kind: 'outside-project'; readonly projectDir: string }
  | { readonly kind: 'invalid' } // new URL() 丟例外，或 file: 網址無法轉成路徑

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:'])

/**
 * 不對目標做 realpath：目標檔可能還不存在（例如 view_navigate 到一個待產生的
 * 輸出檔），對不存在的路徑呼叫 realpath 會直接丟錯，把「合法但還沒建立」的
 * 路徑也擋下來。規格 §7 只要求路徑落在專案目錄底下（前綴限制），不要求目標
 * 真的存在，所以這裡只用字串層級的 `path.resolve` 正規化，不碰檔案系統。
 * 符號連結因此不會被解開：這是刻意的取捨，不是遺漏。
 */
export function checkNavigateUrl(raw: string, projectDir: string): UrlCheck {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { kind: 'invalid' }
  }

  // URL 的 protocol 一律是小寫（URL 標準規定解析時正規化大小寫），
  // 所以這裡不需要、也不能再對 raw 字串自己做一次大小寫處理。
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { kind: 'bad-scheme' }
  }

  if (parsed.protocol !== 'file:') {
    return { kind: 'ok', url: parsed.href }
  }

  let targetPath: string
  try {
    targetPath = fileURLToPath(parsed)
  } catch {
    // 例如帶了非 localhost 的 host（file://host/path）：fileURLToPath 在
    // macOS 上對這種網址丟例外，無法轉成本機路徑。
    return { kind: 'invalid' }
  }

  const resolvedTarget = resolve(targetPath)
  // projectDir 可能帶結尾斜線也可能不帶（呼叫端不保證），用 resolve 正規化到
  // 同一種形式再比較，避免尾斜線造成前綴比對誤判。
  const resolvedProject = resolve(projectDir)

  const isInside =
    resolvedTarget === resolvedProject || resolvedTarget.startsWith(resolvedProject + sep)

  return isInside ? { kind: 'ok', url: parsed.href } : { kind: 'outside-project', projectDir }
}
