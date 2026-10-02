/**
 * `setWindowOpenHandler` 的判斷（規格 §3.3 加 §7）。
 *
 * 純 Node，不 import Electron：agent-view.ts 只負責把結果接到 webContents 上。
 *
 * 這條路原本直接 `loadURL(url)`，完全沒有經過 view_navigate 的協定白名單與專案
 * 範圍限制。頁面自己呼叫 `window.open('file:///Users/…/.ssh/id_rsa')` 就能把專案外
 * 的檔案載進右窗格，agent 接著 view_snapshot 就讀得到。兩條路要套同一份判斷。
 */

import { MSG } from './errors.js'
import { checkNavigateUrl } from './urls.js'

export type WindowOpenDecision =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'block'; readonly reason: string }

/**
 * `projectDir` 為 undefined 代表當下沒有 active 專案。這時一律擋下而不是丟例外：
 * 這個 handler 由頁面觸發，時機不在我們控制內，沒有 active 專案是可能發生的正常
 * 狀態，不是程式錯誤（browser-sessions.ts 的 projectDir 包裝會丟，是因為那條路
 * 只有已經建好瀏覽器 session 的對話才走得到）。
 */
export function decideWindowOpen(raw: string, projectDir: string | undefined): WindowOpenDecision {
  if (projectDir === undefined) return { kind: 'block', reason: MSG.noActiveProject }

  const check = checkNavigateUrl(raw, projectDir)
  switch (check.kind) {
    case 'ok':
      return { kind: 'navigate', url: check.url }
    case 'bad-scheme':
      return { kind: 'block', reason: MSG.badScheme }
    case 'outside-project':
      return { kind: 'block', reason: MSG.outsideProject(check.projectDir) }
    case 'invalid':
      return { kind: 'block', reason: MSG.invalidUrl(raw) }
  }
}
