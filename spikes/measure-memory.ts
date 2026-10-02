import { execSync } from 'node:child_process'

interface Group {
  readonly label: string
  /** 'name' 比對指令的 basename；'substr' 比對整行 */
  readonly mode: 'name' | 'substr'
  readonly match: readonly string[]
}

export const GROUPS: readonly Group[] = [
  { label: 'yeschef', mode: 'substr', match: ['yeschef', 'electron-vite'] },
  { label: '其中 electron-vite（dev 專用）', mode: 'substr', match: ['electron-vite'] },
  { label: 'claude CLI', mode: 'name', match: ['claude'] },
  { label: '基準線 iTerm2', mode: 'substr', match: ['iTerm.app'] },
  { label: '基準線 chrome-devtools-mcp 的 Chrome', mode: 'substr', match: ['chrome-devtools-mcp/chrome-profile'] },
]

/**
 * 算字串的「顯示寬度」而非 UTF-16 code unit 數：CJK 字元（含全形標點）在等寬
 * 終端機佔 2 格，`String.prototype.padEnd` 只算 code unit（1 格），CJK 標籤
 * 會因此對不齊。用 code point 掃過去，落在常見 CJK 區段就算 2，其餘算 1。
 */
export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首、標點、注音、假名、諺文
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音節
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK 相容表意文字
      (cp >= 0xff00 && cp <= 0xff60) || // 全形 ASCII 變體、全形標點
      (cp >= 0xffe0 && cp <= 0xffe6) || // 全形符號
      (cp >= 0x20000 && cp <= 0x3fffd) // CJK 擴展區（含 emoji 以外的補充平面表意文字）
    width += isWide ? 2 : 1
  }
  return width
}

/** 顯示寬度版的 padEnd：CJK 標籤照樣能對齊到 targetWidth 這一欄。 */
export function padEndDisplay(s: string, targetWidth: number): string {
  const pad = targetWidth - displayWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

/**
 * Pure function to filter ps output lines based on matching criteria.
 * Excludes the measurement script's own process to avoid self-counting.
 */
export function filterHits(lines: readonly string[], group: Group): readonly string[] {
  return lines.filter((l) => {
    // Exclude the measurement script itself (it's in the yeschef directory)
    if (l.includes('measure-memory')) {
      return false
    }

    if (group.mode === 'name') {
      // Extract the comm field (second column)
      const parts = l.trim().split(/\s+/)
      const comm = parts[1] ?? ''
      return group.match.some((m) => comm === m || comm.includes(m))
    } else {
      // Substring match on the full line
      return group.match.some((m) => l.includes(m))
    }
  })
}

function rssByGroup(group: Group): { readonly totalMb: number; readonly count: number } {
  const psOutput = execSync('ps -Ao rss,comm,command', { encoding: 'utf8' })
  const lines = psOutput.split('\n').slice(1)

  const hits = filterHits(lines, group)

  const kb = hits.reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0] ?? 0), 0)
  return { totalMb: Math.round(kb / 1024), count: hits.length }
}

const measurements = GROUPS.map((group) => ({ group, ...rssByGroup(group) }))
for (const { group, totalMb, count } of measurements) {
  console.log(`${padEndDisplay(group.label, 38)} ${String(totalMb).padStart(6)} MB  (${count} 個程序)`)
}

// 統一輸出契約:每一組都量到非負的 MB 數字才算完成;0 個程序（那組剛好沒在跑）本身不算失敗,
// 量到負值或量測本身丟例外才算失敗。
const ok = measurements.every((m) => Number.isFinite(m.totalMb) && m.totalMb >= 0)
console.log(JSON.stringify({
  check: '所有分組量測完成且數字有效',
  ok,
  detail: measurements.map((m) => `${m.group.label}=${m.totalMb}MB(${m.count})`).join(', '),
}))
if (!ok) process.exitCode = 1
