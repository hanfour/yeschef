import type { ConversationView } from '../shared/fold.js'

export type ConversationCost = NonNullable<ConversationView['cost']>

/**
 * 花費的三個欄位各自可缺(codex 的 session-end 只有 tokens),
 * 所以先收集有值的再接起來,不能逐一在前面補分隔號:那樣缺開頭欄位時會多一個分隔號。
 */
export function formatCost(cost: ConversationCost): string {
  const parts: string[] = []
  if (cost.turns !== undefined) parts.push(`${String(cost.turns)} 輪`)
  if (cost.usd !== undefined) parts.push(`US$${cost.usd.toFixed(4)}`)
  if (cost.tokens !== undefined) parts.push(`${cost.tokens.toLocaleString('en-US')} tokens`)
  return parts.join(' · ')
}
