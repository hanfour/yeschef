import { useEffect, useRef, type ReactNode } from 'react'
import {
  readWidth,
  useSidebarWidth,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from '../hooks/useSidebarWidth.js'
import './Sidebar.css'

/** 鍵盤一次調整多少:方向鍵一格,加 Shift 一大格。 */
const KEY_STEP = 16
const KEY_STEP_LARGE = 64

export interface SidebarProps {
  /** 側邊欄本身一律在;清單與錯誤訊息由內容元件呈現。 */
  readonly children?: ReactNode
}

export function Sidebar({ children }: SidebarProps): React.ReactElement {
  const { previewWidth, commitWidth } = useSidebarWidth()
  /** 按下時的「寬度減滑鼠 x」,拖曳中用它把滑鼠位置換算回寬度;沒在拖就是 undefined。 */
  const offset = useRef<number | undefined>(undefined)
  const latest = useRef<number | undefined>(undefined)
  const removeWindowListeners = useRef<(() => void) | undefined>(undefined)

  useEffect(() => () => {
    removeWindowListeners.current?.()
  }, [])

  // capture 負責追蹤移動,視窗事件則補上 capture 遺失時的收尾。
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 只認主指標的左鍵:右鍵與中鍵按在把手上不該進入拖曳。
    if (e.button !== 0 || !e.isPrimary || offset.current !== undefined) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // 起點從 localStorage 當下的值算,不是這個元件記得的值:別的分頁可能剛拖過。
    offset.current = readWidth() - e.clientX
    window.addEventListener('pointerup', endDrag, { once: true })
    window.addEventListener('pointercancel', endDrag, { once: true })
    removeWindowListeners.current = () => {
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (offset.current === undefined) return
    latest.current = e.clientX + offset.current
    previewWidth(latest.current)
  }

  /** capture 遺失或指標結束都提交最後預覽;重複事件不再提交。 */
  const endDrag = (): void => {
    if (offset.current === undefined) return
    removeWindowListeners.current?.()
    if (latest.current !== undefined) commitWidth(latest.current)
    offset.current = undefined
    latest.current = undefined
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    if (delta === 0) return
    e.preventDefault()
    commitWidth(readWidth() + delta)
  }

  return (
    <>
      <aside className="sidebar">
        {children}
      </aside>
      <div
        className="sidebar-resizer"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="調整側邊欄寬度"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={readWidth()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      />
    </>
  )
}
