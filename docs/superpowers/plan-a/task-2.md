### Task 2: 未完成 markdown 的推測性收尾

逐字串流的主要技術風險。

**跨模型審查（2026-09-02）對本 task 的發現，已納入下方測試：**

原本的四條斷言全是否定式（沒有奇數圍欄／反引號／粗體、尾端沒有半列表格），因此 `return ''` 通過全部 157 個前綴案例。另有一個把「圍欄內外之分」整個拿掉的實作通過全部 9 個測試，**包括那條名為「圍欄內的反引號不算行內標記」的測試**，因為它唯一的斷言在數圍欄行數，跟反引號無關。

修法是加一條肯定式斷言（輸出必須保留輸入的完整行），並把圍欄那條改成真的檢查內容。

**Files:**
- Create: `src/shared/markdown-stream.ts`
- Create: `tests/markdown-stream.test.ts`
- Create: `tests/fixtures/markdown/real-doc.md`

**Interfaces:**
- Consumes: 無
- Produces: `function closeIncomplete(text: string): string`

- [ ] **Step 1: 準備真實文件 fixture（裁決 27）**

```bash
mkdir -p tests/fixtures/markdown
cp docs/specs/2026-09-01-yeschef-a-sdk-host-design.md tests/fixtures/markdown/real-doc.md
```

這是本 task 動工當下的完整複本，`cp` 一次，之後不跟著規格改：規格文件後續再修訂，這份 fixture 維持原樣，前綴測試的案例數才不會隨規格變動而跟著變。

Run: `wc -m tests/fixtures/markdown/real-doc.md`
Expected: 9617（2026-09-02 實測）。規格 §9 要求「一份約 3000 字的真實文件」，這份文件的字數遠超規格要求的規模，含表格、圍欄、清單、粗體、行內程式碼。

- [ ] **Step 2: 寫失敗的測試**

`tests/markdown-stream.test.ts`：

```typescript
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
  // 逐一跑 closeIncomplete 加四個檢查函式；實測這一條在本機跑 614ms，
  // 遠低於 vitest 預設的 5 秒 timeout，不需要加長。
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
  })
})
```

**注意**：`completeLinesOf` 對「尾端被扣住的表格列」是相容的，因為被扣掉的一定是最後一行，而這條斷言只檢查最後一行以外的部分。

- [ ] **Step 3: 執行測試，確認失敗**

Run: `npm test tests/markdown-stream.test.ts`
Expected: FAIL，無法解析 `../src/shared/markdown-stream.js`

- [ ] **Step 4: 寫最小實作**

真實文件 fixture（Step 1，裁決 27）跑前綴迴圈時踢出一個原版沒抓到的組合缺陷：規格文件裡有欄位內容含跳脫管線字元的表格列，例如 `` `{ type: 'user' \| 'assistant' \| 'system', ... }` ``。原本規則 1 只檢查 `last.endsWith('|')` 判斷這一列是否收尾，但跳脫用的 `\|` 結尾字元同樣是 `|`，會被誤判成「已收尾」，於是這一列不會被規則 1 扣住；接著規則 3 發現這一列的反引號數量是奇數（cell 裡的程式碼片段還沒收尾），在行尾補一個反引號，收尾後的最後一個字元從 `|` 變成 `` ` ``，這時再檢查「表格列是否收尾」就不成立了。手寫的 `CRAFTED` 與錄下的 `REAL_ANSWER` 都沒有這種欄位內跳脫管線的寫法，所以這個缺陷在裁決 27 之前的版本裡不會被任何測試踩到。修法是把「是否收尾」的判斷從單純 `endsWith('|')` 換成 `endsWithUnescapedPipe`：往前數 `|` 前面連續反斜線的個數，奇數個代表被跳脫，不算收尾。

`src/shared/markdown-stream.ts`：

```typescript
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
```

- [ ] **Step 5: 執行測試，確認通過**

Run: `npm test tests/markdown-stream.test.ts`
Expected: PASS，13 個測試（含三份文件各自的前綴迴圈）。實跑輸出：

```
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  737ms (transform 26ms, setup 0ms, import 35ms, tests 622ms, environment 0ms)
```

`REAL_DOC`（9617 字）那一列的前綴迴圈單獨跑 614ms，遠低於 vitest 預設的 5 秒 timeout，不需要加長。

- [ ] **Step 6: 突變測試（強制步驟）**

四個突變各跑一次，每一個都必須讓測試變紅（實測結果，三份文件的前綴迴圈都在跑，紅的測試數比原本只有兩份文件時多）：

| 突變 | 預期紅的測試 | 實測結果 |
|---|---|---|
| 整個函式改成 `return ''` | 前綴迴圈的「未保留輸入的完整行」 | 紅。`11 failed \| 2 passed`：三份文件的前綴迴圈與「完整文件原樣通過」都變紅 |
| 拿掉 `if (inFence) return`（不分圍欄內外） | 「圍欄內的反引號與星號不參與配對」 | 紅。`2 failed \| 11 passed`：那條與「圍欄未收尾時，圍欄內的反引號同樣不參與配對」一起變紅 |
| 規則 1 的表格判斷改成永遠 `false` | 前綴迴圈的「尾端留下未收尾的表格列」 | 紅。`4 failed \| 9 passed`：三份文件的前綴迴圈與「寫到一半的表格列會被扣住」一起變紅 |
| `endsWithUnescapedPipe(last)` 改回 `last.endsWith('\|')`（即修正前的版本） | 真實文件那一列的前綴迴圈 | 紅。只有真實文件的前綴迴圈變紅，失敗在前綴長度 4512 與 4527（含 `\|` 的表格列）；`CRAFTED` 與 `REAL_ANSWER` 沒有這種寫法，不受影響 |

四次都在改完後單獨跑 `vitest run`，還原程式碼後再跑一次確認回到「13 passed」，且與備份逐位元組比對一致。任何一個突變後測試仍然全綠，表示該條測試沒有測到它宣稱要測的東西，停下來回報；這裡四個都如預期變紅。

- [ ] **Step 7: 提交**

```bash
git add src/shared/markdown-stream.ts tests/markdown-stream.test.ts tests/fixtures/markdown/real-doc.md
git commit -m "feat: 未完成 markdown 的推測性收尾，含肯定式前綴斷言與規格規模的真實文件"
```
