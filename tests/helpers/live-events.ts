import { stepLive, INITIAL_CURSOR, type Event, type LiveCursor } from '../../src/shared/events.js'

/**
 * 測試用：一次餵完一整段 live 訊息，回傳所有 Event。
 * 從 INITIAL_CURSOR 起用 stepLive 逐則歸約，把每步的 events 串起來。純函式，沒有跨呼叫狀態，
 * 兩次呼叫互不影響，正式程式碼的游標由 Task 8 的 agent-host 自己持有（裁決 2）。
 */
export function liveEvents(msgs: readonly unknown[]): readonly Event[] {
  const seed: { readonly events: readonly Event[]; readonly cursor: LiveCursor } = {
    events: [],
    cursor: INITIAL_CURSOR,
  }
  return msgs.reduce<typeof seed>((acc, msg) => {
    const step = stepLive(msg, acc.cursor)
    return { events: [...acc.events, ...step.events], cursor: step.cursor }
  }, seed).events
}
