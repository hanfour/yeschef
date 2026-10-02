import type { Finding, UiCheckRule } from '../types.js'
import { lineAt, snippetAt, stripComments } from '../source.js'

const OPEN_TAG = /<([a-z][\w:-]*)\b[^>]*>/gi
const CLASS_ATTRIBUTE = /\b(?:class|className|:class|v-bind:class)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/i
const LABEL_CLASS = /\b[\w-]*(?:eyebrow|kicker)[\w-]*\b/i
function hasLabelClass(attributes: string): boolean {
  const value = CLASS_ATTRIBUTE.exec(attributes)
  if (value && LABEL_CLASS.test(value[1] ?? value[2] ?? value[3] ?? '')) return true
  return [...attributes.matchAll(/\bclass:([\w-]+)/gi)].some((match) => LABEL_CLASS.test(match[1]!))
}

function nextTagAfter(source: string, offset: number): string {
  return source.slice(offset).replace(/^(?:(?:\s|<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\})+)/, '')
}

export const eyebrowLabelRule: UiCheckRule = {
  id: 'eyebrow-label',
  severity: 'warning',
  describe: '不要在標題上方加 eyebrow/kicker 小標籤；將分類資訊併入標題或正文。',
  check(file) {
    const findings: Finding[] = []
    const clean = stripComments(file.text)
    for (const tag of clean.matchAll(OPEN_TAG)) {
      const attributes = tag[0]!
      const classMatch = CLASS_ATTRIBUTE.exec(attributes)
      if (!hasLabelClass(attributes)) continue
      const close = new RegExp(`</${tag[1]}\\s*>`, 'i')
      const closing = close.exec(clean.slice(tag.index! + attributes.length))
      if (!closing) continue
      const after = tag.index! + attributes.length + closing.index + closing[0].length
      if (!/^<h[1-3]\b/i.test(nextTagAfter(clean, after))) continue
      const offset = tag.index! + (classMatch ? attributes.indexOf(classMatch[0]) : attributes.search(/\bclass:[\w-]+/i))
      findings.push({ ruleId: this.id, path: file.path, line: lineAt(file.text, offset), snippet: snippetAt(file.text, offset) })
    }
    return findings
  },
}
