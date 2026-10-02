/**
 * 合併用的進行中旗標,純記憶體,不落地。
 *
 * 誰拿鎖由呼叫端決定:`merge` 用 projectId(第二段跑在主目錄,同專案同時只能有一個),
 * `abort` 用 `projectId/tabId`(只動那個 worktree)。關分頁那邊只讀不拿(`isBusy`)。
 */
export interface MergeLocks {
  /** 拿得到回 true;已經有人拿著回 false,呼叫端不要動 git。 */
  acquire(key: string): boolean
  release(key: string): void
  isBusy(key: string): boolean
}

export function createMergeLocks(): MergeLocks {
  const held = new Set<string>()
  const acquire = (key: string): boolean => {
    if (held.has(key)) return false
    held.add(key)
    return true
  }
  return {
    acquire,
    release: (key: string): void => { held.delete(key) },
    isBusy: (key: string): boolean => held.has(key),
  }
}
