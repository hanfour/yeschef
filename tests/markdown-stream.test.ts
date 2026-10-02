import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { closeIncomplete } from '../src/shared/markdown-stream.js'

/** 手寫文件：刻意涵蓋四條規則各自的觸發條件 */
const CRAFTED = [
  '# 標題',
  '',
  '這是一段**粗體**與 `行內程式碼` 的文字。',
  '',
  '| 欄位 | 說明 |',
  '|---|---|',
  '| foo | 第一列 |',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '結尾，含 `token` 與 **強調**。',
].join('\n')

/** 真實回答：從錄下的事件流取出模型實際產生的回答 */
const REAL_ANSWER: string = (() => {
  const lines = readFileSync('tests/fixtures/events/03-sdk-live-stream.jsonl', 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const texts: string[] = []
  for (const d of lines) {
    if (d['type'] !== 'assistant') continue
    const msg = d['message'] as Record<string, unknown> | undefined
    for (const b of (msg?.['content'] as Record<string, unknown>[] | undefined) ?? []) {
      if (b['type'] === 'text') texts.push(String(b['text']))
    }
  }
  return texts.join('\n\n')
})()

/**
 * 真實文件：規格文件的完整複本（裁決 27，Step 1 準備好的 fixture）。
 * 規格 §9 要求「一份約 3000 字的真實文件產生約 3000 個案例」，這裡達到規格的規模。
 */
const REAL_DOC: string = readFileSync('tests/fixtures/markdown/real-doc.md', 'utf8')

const fenceLines = (s: string): number => s.split('\n').filter((l) => l.startsWith('```')).length

const inlineTicks = (s: string): number => {
  let inFence = false
  let n = 0
  for (const line of s.split('\n')) {
    if (line.startsWith('```')) { inFence = !inFence; continue }
    if (!inFence) n += (line.match(/`/g) ?? []).length
  }
  return n
}

const boldMarks = (s: string): number => (s.match(/\*\*/g) ?? []).length
const lastLine = (s: string): string => s.split('\n').at(-1) ?? ''

/** 輸入的所有「完整行」（最後一行以外）必須原樣保留在輸出開頭 */
const completeLinesOf = (s: string): string => {
  const lines = s.split('\n')
  return lines.length <= 1 ? '' : lines.slice(0, -1).join('\n')
}

describe('closeIncomplete', () => {
  it('真實回答取得到內容（防止 fixture 變動後測試空跑）', () => {
    expect(REAL_ANSWER.length).toBeGreaterThan(200)
  })

  it('真實文件達到規格 §9 的規模（防止 fixture 變動後測試空跑）', () => {
    expect(REAL_DOC.length).toBeGreaterThanOrEqual(3000)
  })

  it('完整文件原樣通過', () => {
    expect(closeIncomplete(CRAFTED)).toBe(CRAFTED)
    expect(closeIncomplete(REAL_ANSWER)).toBe(REAL_ANSWER)
    expect(closeIncomplete(REAL_DOC)).toBe(REAL_DOC)
  })

  it('未收尾的圍欄會被補上，且原始內容保留', () => {
    const src = '```ts\nconst x = 1'
    const out = closeIncomplete(src)
    expect(fenceLines(out) % 2).toBe(0)
    expect(out.startsWith(src)).toBe(true)
  })

  it('寫到一半的表格列會被扣住，但前面的列保留', () => {
    const out = closeIncomplete('| a | b |\n|---|---|\n| foo')
    expect(out).toBe('| a | b |\n|---|---|')
  })

  it('已收尾的表格列不會被扣住', () => {
    const src = '| a | b |\n|---|---|\n| foo | bar |'
    expect(closeIncomplete(src)).toBe(src)
  })

  it('未閉合的行內反引號會被補上', () => {
    const out = closeIncomplete('文字 `token')
    expect(inlineTicks(out) % 2).toBe(0)
    expect(out.startsWith('文字 `token')).toBe(true)
  })

  it('未閉合的粗體會被補上', () => {
    const out = closeIncomplete('文字 **強調')
    expect(boldMarks(out) % 2).toBe(0)
    expect(out.startsWith('文字 **強調')).toBe(true)
  })

  // 這一條專門擋「拿掉圍欄內外之分」的錯誤實作
  it('圍欄內的反引號與星號不參與配對，輸出不得被加料', () => {
    const src = '```py\nt = x ** 2  # `註解`\n```'
    expect(closeIncomplete(src)).toBe(src)
  })

  it('圍欄未收尾時，圍欄內的反引號同樣不參與配對', () => {
    const src = '```py\nt = x ** 2  # `註解`'
    const out = closeIncomplete(src)
    expect(out).toBe(src + '\n```')
  })

  // 本 task 的核心測試。REAL_DOC 是規格文件的完整複本，前綴數量達上萬，
  // 逐一跑 closeIncomplete 加四個檢查函式。2026-09-07 實測：單獨跑 2.7 秒，
  // 全套平行跑時會超過 vitest 預設的 5 秒 timeout，所以這條明確給 30 秒。
  it.each([
    ['手寫文件', CRAFTED],
    ['真實回答', REAL_ANSWER],
    ['真實文件', REAL_DOC],
  ])('%s 的每一個前綴都產出結構完整且保留輸入的輸出', (_label, doc) => {
    const failures: string[] = []
    for (let i = 1; i <= doc.length; i += 1) {
      const prefix = doc.slice(0, i)
      let out: string
      try {
        out = closeIncomplete(prefix)
      } catch (e) {
        failures.push(`長度 ${i} 拋錯: ${String(e)}`)
        continue
      }
      // 肯定式斷言：這一條擋掉 return ''、只回第一行、以及任何丟失內容的實作
      const kept = completeLinesOf(prefix)
      if (kept !== '' && !out.startsWith(kept)) {
        failures.push(`長度 ${i} 未保留輸入的完整行`)
      }
      if (fenceLines(out) % 2 !== 0) failures.push(`長度 ${i} 圍欄數為奇數`)
      if (inlineTicks(out) % 2 !== 0) failures.push(`長度 ${i} 行內反引號為奇數`)
      if (boldMarks(out) % 2 !== 0) failures.push(`長度 ${i} 粗體標記為奇數`)
      const l = lastLine(out)
      if (l.startsWith('|') && !l.endsWith('|') && l.trim() !== '|')
        failures.push(`長度 ${i} 尾端留下未收尾的表格列`)
    }
    expect(failures.slice(0, 8)).toEqual([])
    expect(failures).toHaveLength(0)
  }, 30_000)
})
