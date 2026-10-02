import { useCallback, useEffect, useState } from 'react'
import { readAppStorage, writeAppStorage } from '../storage.js'

export const PANEL_COLLAPSED_KEY = 'yeschef.panelCollapsed'

/** localStorage 在某些情況會丟例外,讀不到就當成展開。 */
function readCollapsed(): boolean {
  try {
    return readAppStorage(PANEL_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/** 整個視窗只有一個主分頁區,所以這裡用 React state 沒有多份過期的問題(對照 useSidebarWidth)。 */
export function usePanelCollapsed(): { readonly collapsed: boolean; readonly toggle: () => void } {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  // 存檔放在 effect 不放在 setState 的 updater 裡:updater 要是純函式,StrictMode 會呼叫它兩次。
  useEffect(() => {
    try {
      writeAppStorage(PANEL_COLLAPSED_KEY, String(collapsed))
    } catch {
      // 存不進去只是下次開回到展開,不值得打斷使用者。
    }
  }, [collapsed])
  const toggle = useCallback((): void => {
    setCollapsed((prev) => !prev)
  }, [])
  return { collapsed, toggle }
}
