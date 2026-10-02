import type { Event } from './events.js'

/** 最後一個 `reset` 的位置;沒有回 -1。不用 findLastIndex 是因為 target 是 ES2022。 */
function lastResetIndex(batch: readonly Event[]): number {
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    if (batch[i]?.kind === 'reset') return i
  }
  return -1
}

/**
 * 把一批事件接到既有事件之後。批次裡有 `reset` 就只留最後一個 `reset` 之後的部分,
 * 前面的全部丟掉。renderer 的 `useConversation` 與 main 的 `conversation.ts` 用同一條規則,
 * 切回前景重播 `[reset, ...log]` 時兩邊算出的內容才一致。
 */
export function appendEvents(prev: readonly Event[], batch: readonly Event[]): readonly Event[] {
  const cut = lastResetIndex(batch)
  return cut === -1 ? [...prev, ...batch] : batch.slice(cut + 1)
}
