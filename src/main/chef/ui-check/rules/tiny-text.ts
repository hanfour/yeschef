import type { Finding, UiCheckRule } from '../types.js'
import { lineAt, snippetAt, stripComments } from '../source.js'

const FONT_SIZE = /\bfont-size\s*:\s*(\d*\.?\d+)px\b/gi

export const tinyTextRule: UiCheckRule = {
  id: 'tiny-text',
  severity: 'error',
  describe: '文字至少使用 11px；優先沿用 theme token，避免小字難以閱讀。',
  check(file) {
    const clean = stripComments(file.text)
    const findings: Finding[] = []
    for (const match of clean.matchAll(FONT_SIZE)) {
      if (Number(match[1]) >= 11) continue
      const offset = match.index!
      findings.push({ ruleId: this.id, path: file.path, line: lineAt(file.text, offset), snippet: snippetAt(file.text, offset) })
    }
    return findings
  },
}
