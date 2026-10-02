import type { Finding, UiCheckRule } from '../types.js'
import { cssBlocks, lineAt, snippetAt } from '../source.js'

const TEXT_CLIP = /(?:-webkit-)?background-clip\s*:\s*text\b/i
const GRADIENT = /\b(?:background|background-image)\s*:[^;{}]*\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i

export const gradientTextRule: UiCheckRule = {
  id: 'gradient-text',
  severity: 'warning',
  describe: '避免漸層文字；改用實色文字，漸層可留給小面積裝飾。',
  check(file) {
    const findings: Finding[] = []
    for (const block of cssBlocks(file.text)) {
      if (!GRADIENT.test(block.body)) continue
      const clip = TEXT_CLIP.exec(block.body)
      if (!clip) continue
      const offset = block.bodyStart + clip.index
      findings.push({ ruleId: this.id, path: file.path, line: lineAt(file.text, offset), snippet: snippetAt(file.text, offset) })
    }
    return findings
  },
}
