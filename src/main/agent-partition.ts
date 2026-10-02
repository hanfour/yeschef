/**
 * 純函式模組,不 import Electron:每對話瀏覽器規格 §2 的 partition 命名規則要能在
 * vitest 底下直接測,不必先 mock 掉 electron。
 */

/** 每個對話自己的 partition。沒有 `persist:` 前綴:只在記憶體裡,對話關閉就清掉(每對話瀏覽器規格 §2)。 */
export function agentPartitionFor(conversationId: string): string {
  return `agent:${conversationId}`
}
