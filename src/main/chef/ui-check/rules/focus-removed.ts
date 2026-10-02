import type { Finding, UiCheckRule } from '../types.js'
import { lineAt, snippetAt, stripComments } from '../source.js'

const OUTLINE = /\boutline\s*:\s*([^;{}]+)/gi

function removesOutline(value: string): boolean {
  const first = value.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const zero = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:[a-z%]+)?$/i.exec(first)
  return first === 'none' || (zero !== null && Number(zero[1]) === 0)
}

export const focusRemovedRule: UiCheckRule = {
  id: 'focus-removed',
  severity: 'error',
  describe: '不要移除鍵盤焦點外框；為互動元素提供清楚的 :focus-visible 樣式。',
  check(file) {
    const clean = stripComments(file.text)
    if (/:focus-visible\b/i.test(clean)) return []
    return [...clean.matchAll(OUTLINE)].filter((match) => removesOutline(match[1]!)).map((match) => ({
      ruleId: this.id,
      path: file.path,
      line: lineAt(file.text, match.index!),
      snippet: snippetAt(file.text, match.index!),
    }))
  },
}
