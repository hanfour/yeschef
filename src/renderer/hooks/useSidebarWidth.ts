import { useCallback, useLayoutEffect } from 'react'
import { readAppStorage, writeAppStorage } from '../storage.js'

export const SIDEBAR_WIDTH_KEY = 'yeschef.sidebarWidth'
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 280

export function clampWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)))
}

/** localStorage 在某些情況會丟例外(隱私模式、被停用),讀不到就用預設值,不讓畫面爛掉。 */
export function readWidth(): number {
  try {
    const raw = readAppStorage(SIDEBAR_WIDTH_KEY)
    if (raw === null) return SIDEBAR_DEFAULT
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? SIDEBAR_DEFAULT : clampWidth(n)
  } catch {
    return SIDEBAR_DEFAULT
  }
}

export function writeWidth(px: number): void {
  try {
    writeAppStorage(SIDEBAR_WIDTH_KEY, String(clampWidth(px)))
  } catch {
    // 存不進去只是下次開回到預設值,不值得打斷使用者。
  }
}

function applyWidth(px: number): void {
  document.documentElement.style.setProperty('--sidebar-width', `${String(px)}px`)
}

/**
 * 寬度不放在 React state 裡:每個對話分頁都有一個側邊欄,各持一份 state 就會各自過期,
 * 在 A 拖寬之後切到 B 再拖,B 會用它自己的舊值當起點,寬度先跳一下。
 * 真相只有 localStorage 一份,畫面靠 CSS 變數生效,兩者都不需要重繪。
 *
 * preview 只改畫面,commit 才存檔:拖曳中每秒會呼叫上百次,那是這條路徑上唯一的同步 I/O。
 */
export function useSidebarWidth(): {
  readonly previewWidth: (px: number) => void
  readonly commitWidth: (px: number) => void
} {
  useLayoutEffect(() => {
    // 已經有值就不覆寫:localStorage 存不進去時(隱私模式、配額滿)readWidth 會一直回預設值,
    // 無條件套的話,開新分頁就會把這次拖出來的寬度蓋回 280。
    // 用 layout effect 不是 effect:effect 在 paint 之後才跑,第一幀會先閃一下預設寬度。
    if (document.documentElement.style.getPropertyValue('--sidebar-width') === '') applyWidth(readWidth())
  }, [])
  const previewWidth = useCallback((px: number): void => {
    applyWidth(clampWidth(px))
  }, [])
  const commitWidth = useCallback((px: number): void => {
    const next = clampWidth(px)
    writeWidth(next)
    applyWidth(next)
  }, [])
  return { previewWidth, commitWidth }
}
