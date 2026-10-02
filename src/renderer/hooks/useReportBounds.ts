import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { RectPayload } from '../../shared/ipc.js'

/**
 * 先把四條邊各自取整數再相減,不是 x 與寬度各自取整數:
 * x = 800.5、寬 799.5 各自進位會變成 801 與 800,右邊界跑到 1601,超出視窗 1px。
 */
function measure(el: HTMLElement): RectPayload {
  const r = el.getBoundingClientRect()
  const x = Math.round(r.left)
  const y = Math.round(r.top)
  return { x, y, width: Math.round(r.right) - x, height: Math.round(r.bottom) - y }
}

function sameRect(a: RectPayload | null | undefined, b: RectPayload | null): boolean {
  if (a === undefined) return false
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * 把一個元素的矩形回報給主行程,主行程把瀏覽器疊在那個位置上(規格 §3)。
 * `active` 為 false 時回報 null,主行程會把瀏覽器藏起來。
 * 同樣的值不重送:ResizeObserver 與視窗 resize 常常一起觸發。
 */
export function useReportBounds(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  send: (rect: RectPayload | null) => void
): () => void {
  const last = useRef<RectPayload | null | undefined>(undefined)

  const report = useCallback((next: RectPayload | null): void => {
    if (sameRect(last.current, next)) return
    last.current = next
    send(next)
  }, [send])
  const hiddenNow = useRef(false)
  const hideNow = useCallback((): void => {
    hiddenNow.current = true
    report(null)
  }, [report])

  // layout effect 不是 effect:收起時左欄已經撐滿,effect 要等畫面繪出後才送 null,
  // 那一格畫面裡瀏覽器還蓋在左欄右半邊上。
  useLayoutEffect(() => {
    hiddenNow.current = false
    const el = ref.current
    if (!active || el === null) {
      report(null)
      return
    }
    // 同步隱藏後到下一次提交前,舊的觀察器不可把原生視圖重新顯示。
    const update = (): void => { if (!hiddenNow.current) report(measure(el)) }
    update()
    // jsdom 與很舊的環境沒有 ResizeObserver;沒有就只靠視窗 resize。
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [ref, active, report])

  // 卸載時藏起來:不然瀏覽器會留在一塊已經不存在的區域上。
  useEffect(() => () => {
    // StrictMode 會清理後再掛載,快取也要反映已送出的隱藏狀態,才會重新回報矩形。
    last.current = null
    send(null)
  }, [send])
  return hideNow
}
