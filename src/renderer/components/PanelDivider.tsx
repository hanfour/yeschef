import { useEffect, useRef, useState } from 'react'
import { clampWidth, currentWidth, usePanelWidth, PANEL_MIN, PANEL_LEFT_MIN } from '../hooks/usePanelWidth.js'
import './PanelDivider.css'

export interface PanelDividerProps {
  readonly onDragging: (dragging: boolean) => void
}

/**
 * 保留 Sidebar 的 preview/commit 與 capture 模式,但不共用事件 hook:
 * 右側寬度方向相反,且必須通知父層藏原生 view、同步 ARIA,共用會讓 Sidebar 多出無關設定。
 */
export function PanelDivider({ onDragging }: PanelDividerProps): React.ReactElement {
  const { previewWidth, commitWidth } = usePanelWidth()
  const [width, setWidth] = useState(currentWidth)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const resize = (): void => {
      setViewportWidth(window.innerWidth)
      setWidth(currentWidth())
    }
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize) }
  }, [])
  const offset = useRef<number | undefined>(undefined)
  const latest = useRef<number | undefined>(undefined)
  const removeWindowListeners = useRef<(() => void) | undefined>(undefined)
  const pointer = useRef<number | undefined>(undefined)
  // 拖曳中收起面板會卸載把手,必須解除父層旗標,下次展開才會恢復瀏覽器。
  useEffect(() => () => {
    removeWindowListeners.current?.()
    if (pointer.current !== undefined) onDragging(false)
  }, [onDragging])
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !e.isPrimary || pointer.current !== undefined) return
    e.currentTarget.setPointerCapture(e.pointerId)
    offset.current = currentWidth() + e.clientX
    pointer.current = e.pointerId
    onDragging(true)
    // capture 提早遺失時,視窗事件仍可收尾;保留同一組函式供重繪後移除。
    window.addEventListener('pointerup', endDrag, { once: true })
    window.addEventListener('pointercancel', endDrag, { once: true })
    removeWindowListeners.current = () => {
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (offset.current === undefined || pointer.current !== e.pointerId) return
    latest.current = offset.current - e.clientX
    previewWidth(latest.current)
    setWidth(clampWidth(latest.current, window.innerWidth))
  }
  // cancel 也提交最後一次 preview,避免系統中斷後瀏覽器一直藏著。
  const endDrag = (e: { readonly pointerId: number }): void => {
    if (pointer.current === undefined || pointer.current !== e.pointerId) return
    removeWindowListeners.current?.()
    if (latest.current !== undefined) commitWidth(latest.current)
    offset.current = undefined
    latest.current = undefined
    pointer.current = undefined
    onDragging(false)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16
    const delta = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0
    if (delta === 0) return
    e.preventDefault()
    const next = clampWidth(currentWidth() + delta, window.innerWidth)
    commitWidth(next)
    setWidth(next)
  }
  return <div className="panel-divider" role="separator" tabIndex={0}
    aria-orientation="vertical" aria-label="調整主分頁區寬度"
    aria-valuemin={PANEL_MIN} aria-valuemax={Math.max(PANEL_MIN, viewportWidth - PANEL_LEFT_MIN)}
    aria-valuenow={width} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={onKeyDown} />
}
