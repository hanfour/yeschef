/** 相對時間文案。純函式，now 由呼叫端傳入，測試不需要動系統時鐘。 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return '時間不明'
  const diff = now - ms
  // diff 為負是時鐘偏差（session 檔的 mtime 比本機時間新）。顯示「剛剛」而不是
  // 負數的分鐘，因為使用者要的是「這場很新」這個訊息，不是精確的時間差。
  if (diff < MINUTE) return '剛剛'
  if (diff < HOUR) return `${String(Math.floor(diff / MINUTE))} 分鐘前`
  if (diff < DAY) return `${String(Math.floor(diff / HOUR))} 小時前`
  if (diff < 30 * DAY) return `${String(Math.floor(diff / DAY))} 天前`
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * HandoffCard 的已等待時間。`ms` 是「現在 - 卡片出現時刻」，負數（時鐘偏差）與
 * 非有限數都落在「不到 1 分鐘」這個分支：guard 用 `ms < MINUTE`，負數必然小於
 * `MINUTE`，不需要另外夾成 0。
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return '不到 1 分鐘'
  return `${String(Math.floor(ms / MINUTE))} 分鐘`
}
