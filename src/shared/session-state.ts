/** session 生命週期的三個狀態（規格 §7）。物件而非字串：viewing 要帶正在看哪一場。 */
export type SessionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'live'; readonly sessionId?: string }
  | { readonly kind: 'viewing'; readonly sessionId: string }
