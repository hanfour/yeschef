import { describe, expect, it } from 'vitest'
import { formatCost } from '../src/renderer/format-cost.js'

describe('formatCost', () => {
  it('三個欄位都有就用分隔號接起來', () => {
    expect(formatCost({ turns: 2, usd: 0.5, tokens: 12345 })).toBe('2 輪 · US$0.5000 · 12,345 tokens')
  })

  it('只有 tokens 時開頭不會多一個分隔號', () => {
    expect(formatCost({ tokens: 12345 })).toBe('12,345 tokens')
  })

  it('只有輪數就只顯示輪數', () => {
    expect(formatCost({ turns: 1 })).toBe('1 輪')
  })

  it('三個都沒有就是空字串', () => {
    expect(formatCost({})).toBe('')
  })
})
