import type { Bounds } from './layout.js'
import type { PlaceableView } from './browser-placement.js'

/**
 * createBrowserPlacement 只認一個固定的 view。把這個轉接物件交給它,
 * 實際收指令的是「目前顯示的那個 session 的 view」(每對話瀏覽器規格 §4.5)。
 */
export interface ViewSwitch extends PlaceableView {
  /** 換目標:舊的先藏起來。新的不在這裡顯示,呼叫端接著叫 placement.relayout() 套矩形。 */
  target(view: PlaceableView | null): void
}

export function createViewSwitch(): ViewSwitch {
  let current: PlaceableView | null = null
  return {
    setBounds: (bounds: Bounds): void => { current?.setBounds(bounds) },
    setVisible: (visible: boolean): void => { current?.setVisible(visible) },
    target: (next): void => {
      if (next === current) return
      current?.setVisible(false)
      current = next
    },
  }
}
