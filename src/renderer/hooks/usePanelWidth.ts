import { useCallback, useLayoutEffect } from 'react'
import { readAppStorage, writeAppStorage } from '../storage.js'

export const PANEL_WIDTH_KEY = 'yeschef.panelWidth'
export const PANEL_MIN = 320
export const PANEL_LEFT_MIN = 480

export function clampWidth(px: number, innerWidth: number): number {
  return Math.min(Math.max(PANEL_MIN, innerWidth - PANEL_LEFT_MIN), Math.max(PANEL_MIN, Math.round(px)))
}

/** localStorage 在某些情況會丟例外(隱私模式、被停用),讀不到就用預設值,不讓畫面爛掉。 */
export function readWidth(): number {
  try {
    const raw = readAppStorage(PANEL_WIDTH_KEY)
    if (raw === null) return clampWidth(window.innerWidth / 2, window.innerWidth)
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? clampWidth(window.innerWidth / 2, window.innerWidth) : clampWidth(n, window.innerWidth)
  } catch {
    return clampWidth(window.innerWidth / 2, window.innerWidth)
  }
}

export function writeWidth(px: number): void {
  try {
    writeAppStorage(PANEL_WIDTH_KEY, String(clampWidth(px, window.innerWidth)))
  } catch {
    // 存不進去只是下次開回到預設值,不值得打斷使用者。
  }
}

/** 畫面值包含尚未提交的拖曳與視窗夾限,不能只讀儲存空間。 */
export function currentWidth(): number {
  const px = Number.parseFloat(document.documentElement.style.getPropertyValue('--panel-width'))
  return Number.isNaN(px) ? readWidth() : clampWidth(px, window.innerWidth)
}

function applyWidth(px: number): void {
  document.documentElement.style.setProperty('--panel-width', `${String(px)}px`)
}

/** preview 只改 CSS,commit 才寫同步儲存空間,避免拖曳每幀寫入。 */
export function usePanelWidth(): {
  readonly previewWidth: (px: number) => void
  readonly commitWidth: (px: number) => void
} {
  useLayoutEffect(() => {
    // 優先夾限既有畫面值:儲存失敗時重新展開,也不會把拖出的寬度蓋回預設值。
    // 用 layout effect 不是 effect:effect 在 paint 之後才跑,第一幀會先閃一下預設寬度。
    applyWidth(currentWidth())
    // 縮小只改畫面,保留上次提交的偏好;下次拖曳提交時才更新儲存空間。
    const resize = (): void => { applyWidth(currentWidth()) }
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize) }
  }, [])
  const previewWidth = useCallback((px: number): void => {
    applyWidth(clampWidth(px, window.innerWidth))
  }, [])
  const commitWidth = useCallback((px: number): void => {
    const next = clampWidth(px, window.innerWidth)
    writeWidth(next)
    applyWidth(next)
  }, [])
  return { previewWidth, commitWidth }
}
