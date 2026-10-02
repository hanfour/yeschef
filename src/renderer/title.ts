import type { ProjectView } from '../shared/projects.js'

export const NO_PROJECT_TITLE = '尚未加入專案'

/**
 * 標題列文字(規格 §3.2 標題列那一列):顯示 active 專案的名稱。
 * 沒有 active 專案(清單為空、或 active 指到已移除的專案)就顯示提示。
 * A 時期「viewing 別的目錄的 session 就顯示那個 cwd」的規則(裁決 21)不再需要:
 * Recents 預設只列本專案,切到「全部」時每一列自己標目錄(Task 13)。
 */
export function titleFor(active: ProjectView | undefined): string {
  return active?.name ?? NO_PROJECT_TITLE
}
