/**
 * xterm 只能畫整數行列，FitAddon 算完後 host 右邊與下方會剩不到一格的空白，右側再加上它預留的捲軸寬度。
 * 把剩下的空白對半分到兩側，文字區在 host 裡置中，左右、上下的留白才會相等。
 */
export interface TerminalCentering {
  readonly left: number
  readonly top: number
  /** xterm 元素的寬度：扣掉左側位移，捲軸才不會被推出 host。 */
  readonly width: number
}

/**
 * 文字區的大小由目前的行列數和每格大小算出，不讀 `.xterm-screen` 的 DOM 尺寸：
 * 分頁從隱藏切回前景時，xterm 要到下一次繪製才更新那個元素，當下讀到的還是預設的 80×24。
 * 還沒量到格子大小（在隱藏狀態下開啟）時回 undefined，等下一次尺寸變化再算。
 */
export function screenSize(cols: number, rows: number, cell: { readonly width: number; readonly height: number } | undefined): { readonly width: number; readonly height: number } | undefined {
  if (cell === undefined || cell.width <= 0 || cell.height <= 0) return undefined
  return { width: cols * cell.width, height: rows * cell.height }
}

export function centerTerminal(host: { readonly width: number; readonly height: number }, screen: { readonly width: number; readonly height: number }): TerminalCentering {
  const left = Math.max(0, Math.floor((host.width - screen.width) / 2))
  const top = Math.max(0, Math.floor((host.height - screen.height) / 2))
  return { left, top, width: Math.max(0, host.width - left) }
}
