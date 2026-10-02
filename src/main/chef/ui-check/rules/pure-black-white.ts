import type { Finding, UiCheckRule } from '../types.js'
import { cssBlocks, lineAt, snippetAt } from '../source.js'

const DECLARATION = /(?:^|;)\s*(background(?:-color)?|color)\s*:\s*([^;{}]+)/gim
const OPAQUE_COLORS = new Set(['black', 'white', '#000', '#000f', '#000000', '#000000ff', '#fff', '#ffff', '#ffffff', '#ffffffff'])
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB = /^rgb\(\s*(?:(0|255)\s*,\s*(0|255)\s*,\s*(0|255)|(0|255)\s+(0|255)\s+(0|255))\s*\)$/i
const GLOBAL_SELECTOR = /(^|[\s>+~,(])(?:html|body|main)(?=$|[\s.#:[>+~,)])/i

function isPureBlackOrWhite(value: string): boolean {
  const color = value.trim().replace(/\s*!important\s*$/i, '').trim().toLowerCase()
  if (OPAQUE_COLORS.has(color)) return true
  if (HEX.test(color)) return false
  const channels = RGB.exec(color)
  if (!channels) return false
  const rgb = channels.slice(1).filter((channel): channel is string => channel !== undefined)
  return rgb[0] === rgb[1] && rgb[1] === rgb[2]
}

function hasGlobalSelector(selector: string): boolean {
  return selector.split(',').some((part) => GLOBAL_SELECTOR.test(part) || /:root(?![\w-])/i.test(part))
}

function isRelevant(block: ReturnType<typeof cssBlocks>[number], property: string): boolean {
  return property !== 'color' || hasGlobalSelector(block.selector)
}

export const pureBlackWhiteRule: UiCheckRule = {
  id: 'pure-black-white',
  severity: 'warning',
  describe: '避免使用純黑或純白作為大面積背景或全域文字色；改用介面色彩 token。',
  check(file) {
    const findings: Finding[] = []
    for (const block of cssBlocks(file.text)) {
      for (const match of block.body.matchAll(DECLARATION)) {
        const property = match[1]!.toLowerCase()
        if (!isRelevant(block, property) || !isPureBlackOrWhite(match[2]!)) continue
        const offset = block.bodyStart + match.index! + match[0]!.indexOf(match[1]!)
        findings.push({ ruleId: this.id, path: file.path, line: lineAt(file.text, offset), snippet: snippetAt(file.text, offset) })
      }
    }
    return findings
  },
}
