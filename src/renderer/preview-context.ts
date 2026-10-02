import { createContext } from 'react'
import type { PreviewLocation } from '../shared/preview.js'

export type OpenPreviewRequest =
  | { readonly kind: 'diff'; readonly conversationId: string }
  | { readonly kind: 'image'; readonly dataUrl: string; readonly key: string }
  | { readonly kind: 'file'; readonly path: string; readonly projectId?: string; readonly location?: PreviewLocation }

/**
 * 對話裡的按鈕經這個 context 開預覽分頁。ToolCall 在好幾層 memo 過的元件底下,
 * 用 props 一路傳會讓每一層的比較函式都要多管一個 callback。
 * 預設 undefined:沒有 Provider 的地方(例如單獨測 ToolCall)不畫預覽按鈕。
 */
export const PreviewContext = createContext<((request: OpenPreviewRequest) => void) | undefined>(undefined)
