import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** 離底部多近仍算「貼底」。 */
const STICK_THRESHOLD_PX = 40

export interface StickToBottom {
  readonly listRef: React.RefObject<HTMLDivElement | null>
  readonly contentRef: React.RefObject<HTMLDivElement | null>
  /** 使用者往上捲離開底部，畫面要顯示「回到最新訊息」。 */
  readonly away: boolean
  readonly onScroll: () => void
  readonly jumpToLatest: () => void
}

/**
 * 清單貼底：新內容進來時捲到最新一則；使用者往上捲之後不搶捲動位置。
 * 除了內容變化，也追蹤清單與內容的尺寸：隱藏中（高度 0）收到的訊息，
 * 以及畫出後才長高的內容（例如 Markdown 排版完成），都要在尺寸變化時補捲一次。
 * `reset` 為 true 時（例如清單清空）重新貼底。
 */
export function useStickToBottom(content: unknown, reset = false): StickToBottom {
  const listRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)

  const onScroll = useCallback((): void => {
    const el = listRef.current
    // 隱藏時的捲動事件不是使用者的動作，量到的全是 0，不能拿來改狀態。
    if (el === null || el.clientHeight === 0) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
    setAway(!stick.current)
  }, [])

  const toBottom = useCallback((): void => {
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [])

  // 用 useLayoutEffect：捲動位置要在繪製前定好，否則每多一段文字都會先閃一下舊位置。
  useLayoutEffect(() => {
    if (reset) stick.current = true
    if (!stick.current) return
    toBottom()
    setAway(false)
  }, [content, reset, toBottom])

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stick.current) toBottom()
      onScroll()
    })
    if (listRef.current) observer.observe(listRef.current)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [onScroll, toBottom])

  const jumpToLatest = useCallback((): void => {
    stick.current = true
    toBottom()
    setAway(false)
  }, [toBottom])

  return { listRef, contentRef, away, onScroll, jumpToLatest }
}
