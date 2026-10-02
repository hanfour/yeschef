import type { Finding, UiCheckRule } from '../types.js'
import { cssBlocks, lineAt, snippetAt } from '../source.js'

const VISIBLE_BORDER = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/i
// 寬度可能寫在樣式之前或之後，單位可能是 px、rem、em（以 16px 換算）。
const WIDTH = /(?:^|\s)(\d*\.?\d+)(px|rem|em)\b/i
const KEYWORD_WIDTH: Readonly<Record<string, number>> = { thin: 1, medium: 3, thick: 5 }

function addFinding(file: { path: string; text: string }, offset: number, found: Finding[]) {
  found.push({ ruleId: 'side-stripe', path: file.path, line: lineAt(file.text, offset), snippet: snippetAt(file.text, offset) })
}

function exceedsOnePixel(value: string): boolean {
  const width = WIDTH.exec(value.trim())
  if (width !== null) return Number(width[1]) * (width[2]!.toLowerCase() === 'px' ? 1 : 16) > 1
  const keyword = /\b(thin|medium|thick)\b/i.exec(value)?.[1]?.toLowerCase()
  return keyword !== undefined && KEYWORD_WIDTH[keyword]! > 1
}

function eligibleSelector(selector: string): boolean {
  return selector.split(',').some((part) => {
    const target = part.trim().split(/(?:[>+~]|\s)+/).at(-1) ?? ''
    return !/^blockquote\b/i.test(target)
  })
}

function hasVisibleStyle(body: string, side: string): boolean {
  const specific = new RegExp(`\\bborder-${side}-style\\s*:\\s*([^;{}]+)`, 'i').exec(body)?.[1]
  if (specific !== undefined) return VISIBLE_BORDER.test(specific)
  const sideBorder = new RegExp(`\\bborder-${side}\\s*:\\s*([^;{}]+)`, 'i').exec(body)?.[1]
  const commonBorder = /\bborder(?:-style)?\s*:\s*([^;{}]+)/i.exec(body)?.[1]
  return [sideBorder, commonBorder].some((value) => value !== undefined && VISIBLE_BORDER.test(value))
}

function checkBlock(file: { path: string; text: string }, block: ReturnType<typeof cssBlocks>[number], found: Finding[]) {
  if (!eligibleSelector(block.selector)) return
  const shorthand = /\bborder-(left|right)\s*:\s*([^;{}]+)/gi
  for (const match of block.body.matchAll(shorthand)) {
    if (exceedsOnePixel(match[2]!) && VISIBLE_BORDER.test(match[2]!)) addFinding(file, block.bodyStart + match.index!, found)
  }
  const width = /\bborder-(left|right)-width\s*:\s*([^;{}]+)/gi
  for (const match of block.body.matchAll(width)) {
    const side = match[1]!.toLowerCase()
    if (exceedsOnePixel(match[2]!) && hasVisibleStyle(block.body, side)) addFinding(file, block.bodyStart + match.index!, found)
  }
}

export const sideStripeRule: UiCheckRule = {
  id: 'side-stripe',
  severity: 'warning',
  describe: '避免卡片、清單項目或提示框使用超過 1px 的單側粗框；改用背景、間距或較細的分隔線。',
  check(file) {
    const found: Finding[] = []
    for (const block of cssBlocks(file.text)) checkBlock(file, block, found)
    return found
  },
}
