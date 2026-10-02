import type { Bounds, Size } from './layout.js'
import type { RectPayload } from '../shared/ipc.js'

export interface PlaceableView {
  setBounds(bounds: Bounds): void
  setVisible(visible: boolean): void
}

export interface BrowserPlacementDeps {
  readonly view: PlaceableView
  /** renderer 的縮放倍率。renderer 回報的是 CSS px,乘上它才是 view 的座標。 */
  zoomFactor(): number
  contentSize(): Size
}

export interface BrowserPlacement {
  /** renderer 回報新的矩形;null 表示藏起來。 */
  report(rect: RectPayload | null): void
  /** 視窗改變大小時呼叫:用新的視窗尺寸重新切一次。 */
  relayout(): void
}

type Placement =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'placed'; readonly rect: RectPayload }

/**
 * 乘上縮放倍率、取整數,再切掉超出視窗的部分。
 * 四條邊各自取整數再相減,不是 x 與寬度各自取整數:倍率 1.25 時 y 38、高 834 各自取整數
 * 會得到底邊 48 + 1043 = 1091,實際是 (38 + 834) × 1.25 = 1090,多出的 1px 壓到下方的狀態列。
 */
function toViewBounds(rect: RectPayload, zoom: number, size: Size): Bounds {
  const left = Math.min(Math.round(rect.x * zoom), size.width)
  const top = Math.min(Math.round(rect.y * zoom), size.height)
  const right = Math.min(Math.round((rect.x + rect.width) * zoom), size.width)
  const bottom = Math.min(Math.round((rect.y + rect.height) * zoom), size.height)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

export function createBrowserPlacement(deps: BrowserPlacementDeps): BrowserPlacement {
  // renderer 回報之前先藏著(規格 §3):上次收起的話,先顯示再藏會在右半邊白閃約 180ms;
  // 那段時間 renderer 的右半邊已經畫好深色的主分頁區,藏著不會留下空白。
  let placement: Placement = { kind: 'hidden' }
  deps.view.setVisible(false)

  const show = (bounds: Bounds): void => {
    // 切完沒有面積就當成藏起來:寬高給 0 的 view 仍然留在畫面上(規格 §3)。
    if (bounds.width === 0 || bounds.height === 0) {
      deps.view.setVisible(false)
      return
    }
    deps.view.setVisible(true)
    deps.view.setBounds(bounds)
  }

  const apply = (): void => {
    if (placement.kind === 'hidden') {
      deps.view.setVisible(false)
      return
    }
    show(toViewBounds(placement.rect, deps.zoomFactor(), deps.contentSize()))
  }

  return {
    report: (rect) => {
      placement = rect === null ? { kind: 'hidden' } : { kind: 'placed', rect }
      apply()
    },
    // 藏起來的時候視窗改大小不必再碰 view:它已經藏了,再呼叫一次 setVisible(false) 沒有作用。
    relayout: () => {
      if (placement.kind !== 'hidden') apply()
    },
  }
}
