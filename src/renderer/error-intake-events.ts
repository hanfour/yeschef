/**
 * 錯誤收集的啟用狀態只存在主行程。設定對話框啟用成功後通知其他畫面重讀，
 * 否則群組分頁要切換專案才看得到「拉錯誤」（實機驗收時發現）。
 */
const EVENT = 'yeschef:error-intake-changed'

export function notifyErrorIntakeChanged(projectId: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: projectId }))
}

/** 只在指定專案的狀態改變時呼叫；回傳取消訂閱的函式。 */
export function onErrorIntakeChanged(projectId: string, listener: () => void): () => void {
  const handler = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail === projectId) listener()
  }
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
