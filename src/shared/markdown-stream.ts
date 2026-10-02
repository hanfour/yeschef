/**
 * 尾端的 `|` 是不是表格欄位分隔符：往前數連續反斜線，偶數個（含 0）代表這個
 * `|` 沒被跳脫，是真正的收尾；奇數個代表它是 `\|`，儲存格內容裡的文字，不是
 * 收尾。真實文件 fixture（裁決 27）裡 `{ type: 'user' \| 'assistant' }` 這種
 * 欄位就是這樣寫，原本只看 `endsWith('|')` 的版本會把這一列誤判成已收尾。
 */
function endsWithUnescapedPipe(s: string): boolean {
  if (!s.endsWith('|')) return false
  let backslashes = 0
  let i = s.length - 2
  while (i >= 0 && s[i] === '\\') {
    backslashes += 1
    i -= 1
  }
  return backslashes % 2 === 0
}

/**
 * 把串流到一半的 markdown 補成結構完整的形式，供解析器使用。
 *
 * 四條規則，只對副本操作：
 * 1. 尾端寫到一半的表格列先扣住（下一個 token 到齊自然恢復）
 * 2. 圍欄數為奇數時補一個收尾
 * 3. 圍欄外未閉合的行內反引號補上
 * 4. 圍欄外未閉合的粗體標記補上
 *
 * 規則 3、4 必須排除圍欄內的內容：程式碼裡的 ** 與 ` 不是 markdown 標記。
 * 補上的字元一律接在最後一個非圍欄行，避免破壞圍欄結構。
 */
export function closeIncomplete(text: string): string {
  const lines = text.split('\n')

  // 規則 1：用 endsWithUnescapedPipe 而非單純 endsWith('|')，
  // 否則儲存格裡跳脫的 \| 會被誤判成這一列已經收尾。
  const last = lines.at(-1) ?? ''
  const isPartialRow = last.startsWith('|') && !endsWithUnescapedPipe(last) && last.trim() !== '|'
  const kept = isPartialRow ? lines.slice(0, -1) : lines

  // 規則 3、4 的計數：只看圍欄之外
  let inFence = false
  let ticks = 0
  let bold = 0
  let lastNonFenceIdx = -1
  kept.forEach((line, i) => {
    if (line.startsWith('```')) { inFence = !inFence; return }
    if (inFence) return
    lastNonFenceIdx = i
    ticks += (line.match(/`/g) ?? []).length
    bold += (line.match(/\*\*/g) ?? []).length
  })

  const tail = (ticks % 2 === 1 ? '`' : '') + (bold % 2 === 1 ? '**' : '')
  const withTail = [...kept]
  if (tail !== '' && lastNonFenceIdx >= 0) {
    withTail[lastNonFenceIdx] = (withTail[lastNonFenceIdx] ?? '') + tail
  }

  // 規則 2：最後補圍欄，確保它在最尾端
  const fenceCount = withTail.filter((l) => l.startsWith('```')).length
  const out = fenceCount % 2 === 0 ? withTail : [...withTail, '```']

  return out.join('\n')
}
