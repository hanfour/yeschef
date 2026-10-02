import { fileNameOf } from '../shared/preview.js'
import type { PreviewLocation } from '../shared/preview.js'

export const BROWSER_TAB_ID = 'browser'
export const SCREENSHOT_TITLE = '截圖'

export type PreviewSource =
  | { readonly kind: 'diff'; readonly conversationId: string }
  | { readonly kind: 'image'; readonly dataUrl: string; readonly key: string }
  | { readonly kind: 'file'; readonly projectId: string; readonly path: string; readonly location?: PreviewLocation }

export interface PreviewTab {
  readonly id: string
  readonly title: string
  readonly source: PreviewSource
  /** 同一個來源再開一次就加一,預覽內容以它為鍵重新讀取。 */
  readonly revision: number
}

export interface PanelTabs {
  readonly previews: readonly PreviewTab[]
  readonly activeId: string
}

export const INITIAL_TABS: PanelTabs = { previews: [], activeId: BROWSER_TAB_ID }

function sameSource(a: PreviewSource, b: PreviewSource): boolean {
  if (a.kind === 'diff' && b.kind === 'diff') return a.conversationId === b.conversationId
  if (a.kind === 'image' && b.kind === 'image') return a.key === b.key
  if (a.kind === 'file' && b.kind === 'file') return a.projectId === b.projectId && a.path === b.path
  return false
}

/**
 * 同一個來源已經開著就切過去並加一個 revision,不重開一個分頁。
 * 加 revision 是讓「再按一次預覽」等於重新整理:agent 改完同一份檔案,
 * 人再按一次預覽,要看到的是新內容,不是第一次開的時候讀到的那一份。
 */
export function openPreview(state: PanelTabs, source: PreviewSource, newId: string): PanelTabs {
  const existing = state.previews.find((t) => sameSource(t.source, source))
  if (existing !== undefined) {
    const previews = state.previews.map((t) => (t.id === existing.id ? { ...t, source, revision: t.revision + 1 } : t))
    return { previews, activeId: existing.id }
  }
  const title = source.kind === 'diff' ? '開發變更' : source.kind === 'image' ? SCREENSHOT_TITLE : fileNameOf(source.path)
  return { previews: [...state.previews, { id: newId, title, source, revision: 0 }], activeId: newId }
}

export function closePreview(state: PanelTabs, id: string): PanelTabs {
  const index = state.previews.findIndex((t) => t.id === id)
  if (index === -1) return state
  const previews = state.previews.filter((t) => t.id !== id)
  if (state.activeId !== id) return { ...state, previews }
  return { previews, activeId: previews[index - 1]?.id ?? BROWSER_TAB_ID }
}

export function activateTab(state: PanelTabs, id: string): PanelTabs {
  return { ...state, activeId: id }
}
