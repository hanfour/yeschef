# yeschef A 實作計畫審查（動工前）

日期：2026-09-02
審查對象：
- 規格 `docs/specs/2026-09-01-yeschef-a-sdk-host-design.md`
- 計畫 `docs/superpowers/plans/2026-09-01-yeschef-a-sdk-host.md`（12 個 task 中已寫出的前 3 個）
- fixture `tests/fixtures/events/*.jsonl`（105 行真實事件）
- SDK 型別 `@anthropic-ai/claude-agent-sdk@0.3.252` 的 `sdk.d.ts`

驗證腳本留在
`/tmp/mdtest/`（`impl.mjs`、`run.mjs`、`run2.mjs`、`adv.mjs`）
與 `.../scratchpad/evtest/`（`events.mjs`、`run.mjs`）。

---

## 結論先講

**先修再動工。** 三個 task 都有「測試會過、程式不報錯，但它回答的不是要問的問題」型的缺陷，跟上一個分支那四次同構。最貴的一項是 Task 3 的 `Event` 型別：它缺的欄位會讓 Task 4 的 `fold()` 根本寫不出來，而它同時被後面九個 task 消費。

必須先修的最小集合：

1. Task 3 的 `Event` 型別補 `role`、block `index`、`block-start`/`block-stop`、`tool-input-delta`、`raw`、`api_error_status`、`parentToolUseId`
2. Task 1 的守衛述詞從「等於 appDir」改成「在 appDir 之下 / 在 EXCLUDE_PATHS 之下」，並加 realpath 與大小寫正規化；`permissionMode` 從 `'manual'` 改成 `'default'`
3. Task 2 刪掉規則 1（補圍欄收尾），並在數 `**` 之前先排除行內 code span
4. 三個 task 各補一條「刪掉實作就會紅」的斷言

---

## 1. Task 2 `closeIncomplete`

### 1.1 有沒有一個明顯錯的實作能讓前綴測試全過？有，而且不只一個

先更正一個數字。`DOC.length` 實測是 **157**，不是計畫 Step 4 寫的「約 250 個字元位置」（plan:430），更不是規格 §9 要求的「約 3000 字的真實文件產生約 3000 個案例」（spec:199）。差 20 倍。

實測方式：把計畫 Step 3 的實作逐字抄成 `impl.mjs`，把計畫 Step 1 的九個測試逐條抄成 `run2.mjs` 的判定，然後餵進四個候選實作。

```
$ node run2.mjs
DOC.length = 157
全部 9 個測試 PASS  計畫的實作
全部 9 個測試 PASS  G: 完全沒有圍欄內外之分
FAIL              return ""  → 1 完整文件原樣 | 2b | 4
FAIL              只回第一行  → 1 完整文件原樣 | 2a | 2b | 4 | 5 | 6 | 7 圍欄內反引號不算行內標記
```

單看前綴測試那一條（`run.mjs`）：

```
$ node run.mjs
== 計畫的實作 ==
[named ] plan: PASS
[prefix] plan: PASS

== 候選錯誤實作 ==
[named ] identity: FAIL ...
[prefix] identity: FAIL (93)
[named ] dropLast: FAIL ...
[prefix] dropLast: FAIL (39)
[named ] empty: FAIL ...
[prefix] empty: PASS          ← return '' 通過全部 157 個前綴案例
[named ] firstLine: FAIL ...
[prefix] firstLine: PASS      ← 只回第一行也通過
```

**`return ''` 通過全部 157 個前綴斷言。** 原因是那四條斷言全是否定式：

```ts
if (fenceLines(out) % 2 !== 0) failures.push(...)     // 沒有奇數圍欄
if (inlineTicks(out) % 2 !== 0) failures.push(...)    // 沒有奇數反引號
if (boldMarks(out) % 2 !== 0) failures.push(...)      // 沒有奇數粗體
if (l.startsWith('|') && !l.endsWith('|') ...)        // 尾端沒有半列表格
```

空輸出滿足每一條。整份測試沒有任何一條斷言檢查「輸出保留了輸入」。

### 1.2 更嚴重：一個連 9 個測試全過的錯誤實作

`noFenceAwareness` 跟計畫的實作只差一行，把 `if (inFence) continue` 拿掉，反引號與粗體不分圍欄內外一律數：

```js
for (const line of withFence) {
  if (line.startsWith('```')) continue        // 唯一差別：不追蹤 inFence
  ticks += (line.match(/`/g) ?? []).length
  bold  += (line.match(/\*\*/g) ?? []).length
}
```

它 **9 個測試全過**，包括名為「圍欄內的反引號不算行內標記」那一個（plan:333-337）。那個測試唯一的斷言是：

```ts
const out = closeIncomplete('```\n`不是行內`\n')
expect(fenceLines(out) % 2).toBe(0)
```

`fenceLines` 在數以 ` ``` ` 開頭的行數，跟反引號計數毫無關係。**測試名字說的事情，測試沒有在檢查。**

這個實作在真實輸入上的行為：

```
IN  : ```py\ns = "a `b` c"\nt = x ** 2
OUT : ```py\ns = "a `b` c"\nt = x ** 2\n```**
計畫: ```py\ns = "a `b` c"\nt = x ** 2\n```
```

`` ```** `` 不是合法的 closing fence，後果見 1.3(a)。

### 1.3 比不處理更壞的輸入

工具：`micromark` + `micromark-extension-gfm`，也就是 `react-markdown` 底下那一家。

**(a) 規則 1 多餘，而它的實作會製造問題。**

未收尾的圍欄不處理時，micromark 依 CommonMark 在文件結尾自動關閉：

```
IN  : **重點\n```ts\nconst x = 1
OUT : <p>**重點</p><pre><code class="language-ts">const x = 1
      </code></pre>                                      ← 正確
```

`closeIncomplete` 規則 1 補 ` ``` `，然後規則 4 把 `**` 接在 `out[out.length-1]`（plan:421-423），而那一行剛好是剛補上的圍欄：

```
IN  : **重點\n```ts\nconst x = 1\n```**
OUT : <p>**重點</p><pre><code class="language-ts">const x = 1
      ```**
      </code></pre>                                      ← 圍欄沒關，後文全被吞
```

CommonMark 規定 closing fence 只能有 backtick 加空白。串流情境下「後文」就是接下來每一幀新到的字。**這是嚴格比不處理更壞。**

同一個 bug 的變體（`adv.mjs` 案例 A2）：行內反引號未閉合加未收尾圍欄，收尾行變成 ` ```` `。四個 backtick 是合法的 closer（不短於 opener），這個沒事，但補上去的那個反引號跑到圍欄外，原本要閉合的行內 code span 還是沒閉合。

**(b) 行內 code span 裡的 `**` 被當粗體。有量到，0.4%。**

掃使用者自己 40 個逐字稿裡的 **251 則真實 assistant 文字訊息**（全部都是已完成、不需要收尾的），送進 `closeIncomplete`：

```
完整訊息被 closeIncomplete 改動的數量 = 1 / 251 (0.4%)
   原長 14199 改動後尾端: "...如果你同意我再重新嘗試寫入。**"
```

追下去，肇因是這一行：

```
行 5 的 ** 個數為奇數: "> ...以下盤點涵蓋 `packages/backend`、`packages/worker`... 與 `package"
全文 ** 總數 = 1
```

那個 `**` 是 `` `apps/**/*.ts` `` 這種 glob，包在行內 code span 裡。粗體計數器只認 fenced block，不認 inline code span。渲染結果：

```
原文: <p>掃描 <code>apps/**/*.ts</code> 底下的檔案。</p>
補後: <p>掃描 <code>apps/**/*.ts</code> 底下的檔案。**</p>
```

段落尾端多一個可見的 `**`。coding agent 講 glob 是日常。

**(c) 圍欄內以 `|` 開頭的行被砍掉。**

規則 2（plan:396-398）跑在圍欄判斷之前，完全不看 `inFence`：

```
IN  : ```bash\ncat access.log \\\n| grep 500
OUT : ```bash\ncat access.log \\\n```           ← "| grep 500" 消失
```

micromark 對照：

```
不處理: <pre><code class="language-bash">cat access.log \
        | grep 500
        </code></pre>
處理後: <pre><code class="language-bash">cat access.log \
        </code></pre>                            ← 內容被吃掉
```

**(d) 其餘（列出來，但誠實標注頻率）。**

| 案例 | 行為 | 在 251 則真實訊息裡的出現次數 |
|---|---|---|
| `~~~` 圍欄 | `l.startsWith('```')` 認不出來，圍欄內的 `**`／反引號被當行內，尾端多出 `<p>**</p>` | 0 |
| 縮排圍欄（清單裡的 code block） | 同上 | 0 |
| 跳脫的 `` \` `` | 被當成真反引號，多補一個 | 0 |
| `***`（同時粗體與斜體） | `這是 ***又粗又斜` → `這是 ***又粗又斜**`，五個星號，斜體仍未閉合 | 0 |
| ` ````md ` 四反引號圍欄未收尾 | 補三個反引號，CommonMark 要求 closer 不短於 opener，關不掉 | 0 |

這五類在這個語料裡都是 0 次，是理論風險，不是量到的問題。誠實記錄。

**(e) CJK 與其他。** `｜` 全形直線不觸發規則 2，沒問題。前綴用 `slice` 切 code unit，CJK 是 BMP 不會裂開，emoji 會，但 DOC 裡沒有。清單中的表格（縮排的 `|` 列）不觸發規則 2，因為不是以 `|` 開頭，等於這條規則對清單裡的表格完全失效。

### 1.4 用真實 fixture 重播

把 fixture `03-sdk-live-stream.jsonl` 第 50 行那則 466 字元的真實訊息，用真實的 8 個 delta 邊界逐幀重播：

```
frame 1 len  56 | closeIncomplete 有改動: true  | 產出 HTML 與未處理相同: false
frame 2 len 141 | 有改動: false | 相同: true
frame 3 len 215 | 有改動: true  | 相同: false   尾端: " hello > cap.txt    # 覆寫：檔案存在就\n```"
frame 4 len 274 | 有改動: true  | 相同: false   尾端: " # 附加：接在既有內容後面\necho hello >| c\n```"
frame 5-8       | 有改動: false | 相同: true
```

再跑 466 個字元前綴，「產出非法 closing fence 的前綴數 = 0」。也就是說在這則真實訊息上，`closeIncomplete` 的行為是正確的（frame 1/3/4 的改動都是有益的圍欄與表格收尾）。1.3(a) 的災難需要「圍欄外有未閉合標記」加「圍欄開著」同時成立，這則訊息沒有。

結論：規則 2/3/4 的方向是對的，實作有邊界問題；規則 1 該刪。

### 1.5 最小修法

- **刪掉規則 1。** remark 與 marked 都自動關閉未收尾圍欄，已實測。若一定要留，tail 必須接在最後一個**非圍欄行**。
- 規則 2 移到圍欄判斷之後，只在圍欄外套用。
- 數 `**` 與反引號之前，先把成對的行內 code span 消掉：`s.replace(/`[^`\n]*`/g, '')`。
- 圍欄偵測改 `/^ {0,3}(`{3,}|~{3,})/`，記住 opener 的字元與長度，收尾用同字元且不短於 opener。
- **前綴測試加一條斷言**（這是最關鍵的一行）：

```ts
if (!out.startsWith(prefix) && !prefix.startsWith(out))
  failures.push(`前綴長度 ${i} 的輸出不是輸入的延伸`)
if (out.length < prefix.length - 200)
  failures.push(`前綴長度 ${i} 的輸出比輸入短太多`)
```

  這一條就把 `return ''` 與 `firstLine` 擋掉。
- 「圍欄內的反引號不算行內標記」那個測試要換成真的在檢查它的斷言，例如
  `expect(closeIncomplete('```\n`x\n```\n文字 `y')).toBe('```\n`x\n```\n文字 `y`')`。
  這一條會把 `noFenceAwareness` 擋掉。
- 語料換成 fixture 第 50 行那則真實訊息，並額外用真實的 8 個 delta 邊界再跑一輪。

---

## 2. Task 3 Event 型別與正規化

### 2.1 fixture 裡實際有哪些 `stream_event` 子型別（數過的，不是推測）

`03-sdk-live-stream.jsonl` 共 54 行，其中 32 筆 `stream_event`：

| 子型別 | 筆數 | 目前實作 |
|---|---:|---|
| `message_start` | 2 | 丟棄 |
| `content_block_start`（thinking×2、tool_use×1、text×1） | 4 | 丟棄 |
| `content_block_delta` / `text_delta` | 8 | → `text-delta` |
| `content_block_delta` / `thinking_delta` | 4 | → `thinking-delta` |
| `content_block_delta` / `signature_delta` | 2 | 丟棄 |
| `content_block_delta` / `input_json_delta` | 4 | **丟棄** |
| `content_block_stop` | 4 | 丟棄 |
| `message_delta`（帶 `stop_reason`） | 2 | 丟棄 |
| `message_stop` | 2 | 丟棄 |
| **合計** | **32** | 處理 12 筆 |

頂層另有 `system` 15（hook_started 4、hook_response 4、init 1、status 2、thinking_tokens 4）、`assistant` 4、`user` 1、`rate_limit_event` 1、`result` 1。

三份 fixture 合計 105 行：

```
01-tool-use-bash.jsonl    24 行，其中 15 行產出 0 個 Event
02-permission-denied.jsonl 27 行，其中 19 行產出 0 個 Event
03-sdk-live-stream.jsonl   54 行，其中 35 行產出 0 個 Event
合計 69 / 105 = 66% 的真實事件被靜默丟棄
```

全域約束「不得靜默丟棄認不出來的事件」（plan:20）在自己的 fixture 上就已經破了。兩個黑洞是 `if (type === 'system') return []`（plan:658）與 stream_event 分支尾端的 `return []`（plan:670）。未來 SDK 新增任何 system subtype 或 delta type，一律靜默消失，而這正是那條約束要防的東西。

### 2.2 `input_json_delta` 沒處理

確認沒處理。fixture 第 21-24 行四筆全丟，第 20 行的 `content_block_start`（帶 `id: "toolu_01L2YCZHqTvRDmdkNpsprfCQ"`、`name: "Bash"`、`input: {}`）也丟。四筆串接起來正好是完整的工具參數：

```json
{"command": "echo hello > cap.txt && ls -l cap.txt && cat cap.txt", "description": "Write hello to cap.txt and verify"}
```

**UI 上會是什麼：** 從 `content_block_start`（第 20 行）到完整 `assistant` 訊息（第 25 行）之間，畫面上完全沒有東西。工具呼叫不存在，然後一次跳出來，已經是完整形態。不是「參數逐字長出來」，是「先空白，再突然出現」。

這則 fixture 參數只有 119 bytes、4 個 delta，看不出來。一個 Write 或 Edit 的參數是幾千 token，那段時間 UI 就是空白。**這正好是 §2.3 花代價買的「逐字，像桌面版」唯一沒做到的地方。**

### 2.3 `complete: boolean`（規格 §4.2）沒有來源

`content_block_stop`（4 筆）、`message_stop`（2 筆）、`message_delta`（帶 `stop_reason`，2 筆）全部回 `[]`。`fold()` 手上只剩「陣列最後一個 Event」這個啟發式。

fixture 裡 thinking block（index 0）後面接 tool_use（index 1），兩者同屬 `msg_011CecHvRnPBQEKKkvdkgXkj`。用位置猜不出誰結束了。同一輪裡「text block 已完成、後面還要接 tool_use」這個情況，啟發式會把已完成的 block 標成未完成，或反過來。

### 2.4 文字被送兩次

```
text_delta 串接長度      = 466
assistant 完整 text 長度 = 466
完全相同                 = true
```

`normalizeLive` 對兩邊都產出 Event（8 個 `text-delta` 加 1 個 `text`），而 `Event` 型別裡沒有 index、沒有 messageId、沒有 block id。`fold()` 無從去重，回答會渲染兩次。thinking 同理（4 個 `thinking-delta` 加 2 個 `thinking`）。

SDK 是每個 content block 完成就送一則 `assistant`：

```
行 18 id= msg_011CecHvRnPBQEKKkvdkgXkj blocks= thinking
行 25 id= msg_011CecHvRnPBQEKKkvdkgXkj blocks= tool_use
行 39 id= msg_011CecHvmWYSkjexndc45ePc blocks= thinking
行 50 id= msg_011CecHvmWYSkjexndc45ePc blocks= text
```

### 2.5 `Event` 型別遺漏的東西（UI 實際要用）

| 缺什麼 | 為什麼要 | 資料在哪 |
|---|---|---|
| `role` | §4.2 的 `Turn.role`。`normalizeLive` 對 `type:'user'` 和 `'assistant'` 都走同一個 `fromContent`，產出的 Event 一模一樣，分不出誰說的 | 頂層 `type` |
| turn 邊界 | 沒有任何事件說「這一輪結束」。`fold()` 無法切 Turn | `message_start` / `message_stop` |
| `raw`（stdout/stderr） | §2.3 使用者選的終端機逃生口、§6「展開後顯示未經處理的 stdout／stderr」 | fixture 第 30 行頂層 `tool_use_result`，keys = `stdout, stderr, interrupted, isImage, noOutputExpected`；`stdout` 就是 `-rw-r--r--@ 1 me wheel 6 ... cap.txt\nhello`。`fromContent` 只讀 `message.content`，從沒碰過它 |
| `api_error_status` | §8 明寫「`result` 事件的 `is_error` 與 `api_error_status` 渲染成錯誤卡片」 | fixture 第 54 行有這個欄位；`session-end` Event 沒有 |
| `parentToolUseId` | subagent（Task 工具）的事件帶它。丟掉之後 subagent 的 thinking／tool_use 會直接混進主對話 | 每一筆頂層都有。三份 fixture 都是 null，所以測不出來 |
| `awaiting-approval` 的來源 | §4.2 的 `Block.tool.status` 有這個值，但它來自 `canUseTool` 回呼。`fold(events)` 的簽章沒有第二個參數 | 不在事件流裡，是介面缺口 |
| rate limit | §8 要求「事件流中斷顯示連線狀態」 | `rate_limit_event` 目前回 `[]` |

`session-end` 的 `costUsd` / `numTurns` / `isError` 對得上（fixture 第 54 行有 `total_cost_usd`、`num_turns: 2`、`is_error: false`）。`permission-denied` 的三個欄位也對得上（fixture 02 的 `tool_name`、`tool_use_id`、`message`），跟 `sdk.d.ts` 的 `SDKPermissionDeniedMessage` 一致。

### 2.6 13 個測試全過，即使把整段 `stream_event` 處理刪掉

```
$ node evtest/run.mjs
全部 13 個測試 PASS  ← 計畫的實作
全部 13 個測試 PASS  ← 把整段 stream_event 處理刪掉（等同完全沒有逐字串流）
```

原因：

- `it('抓得到文字內容')`（plan:489-492）的斷言是 `kind === 'text-delta' || kind === 'text'`。第 50 行的完整 `assistant` 訊息就滿足了，`|| 'text'` 讓 delta 那一半形同虛設。
- `it('抓得到工具呼叫與結果')` 靠第 25 行（完整 `assistant` 的 tool_use）與第 30 行（`user` 的 tool_result）滿足，跟串流無關。
- `it('每一筆都產出陣列，不拋錯')` 在刪掉分支後掉進 `return unknown(msg)`，那也是陣列。

**逐字串流這整件事在 Task 3 裡零覆蓋。** 這是整份計畫裡最接近失敗史那四次的一項。

### 2.7 `normalizeHistory` 完全沒有真實 fixture

三份 fixture 都是 `query()` 的 `SDKMessage`，不是 `getSessionMessages()` 的 `SessionMessage`。`normalizeHistory` 的三個測試（plan:526-550）全部自己餵手寫物件。規格 §9 要求兩個 normalize 都「用真實錄下的事件流當 fixture」，這一半沒做到。

實測後果，抽樣 12 個真實逐字稿：

```
content 為字串（→ normalizeHistory 判 unknown）= 19
content 為陣列 = 612
範例(字串 content): "You are a code quality analyst. Generate a CONVENTIONS document for \"demo-app\" ("
```

`fromContent` 對非陣列回 `[]`，然後 `events.length === 0 ? unknown(msg)`（plan:704），所以使用者自己打的 prompt 會變成一張原始 JSON 卡片。`SessionMessage.type` 還包含 `'system'`（`sdk.d.ts:5312`），那些條目沒有 `message` 欄位，也全變 unknown 卡片。歷史對話一打開就是滿螢幕 unknown。

另外掃 40 個逐字稿的 content block 種類只有 `thinking` / `text` / `tool_use` / `tool_result` 四種，跟規格 §1 一致。但使用者貼圖時會出現 `image`，`fromContent` 的 `default` 分支會把整包 base64 塞進 unknown 卡片渲染出來。

### 2.8 最小修法

```ts
// 加上 block 身分，讓 fold 能收斂 delta 與完整訊息
| { kind: 'block-start'; index: number; blockType: string; id?: string; name?: string }
| { kind: 'block-stop';  index: number }
| { kind: 'turn-start';  role: 'user' | 'assistant'; messageId: string }
| { kind: 'turn-end';    stopReason?: string }
| { kind: 'tool-input-delta'; index: number; partialJson: string }
// 既有的 delta 類全部加 index 與 messageId
// tool-result 加 raw?: { stdout: string; stderr: string; interrupted: boolean }
// session-end 加 apiErrorStatus?: unknown
// 全部 Event 加 parentToolUseId?: string | null
```

- `if (type === 'system') return []` 改成白名單列舉（`init`／`permission_denied`／`status`／`thinking_tokens`／`hook_*` 各自明確映射，含明確映射為零個），列舉之外一律 `unknown`。stream_event 尾端的 `return []` 同理。
- 補三條「刪掉實作就會紅」的斷言：

```ts
it('逐字串流的 text_delta 一筆都不能少', () => {
  const all = live.flatMap(normalizeLive)
  expect(all.filter((e) => e.kind === 'text-delta')).toHaveLength(8)
  expect(all.filter((e) => e.kind === 'tool-input-delta')).toHaveLength(4)
  expect(all.filter((e) => e.kind === 'block-stop')).toHaveLength(4)
})
it('tool-input-delta 串接後是合法的工具參數 JSON', () => { ... })
it('text-delta 串接的結果等於完整 text 事件', () => { ... })
```

- 錄一份 `getSessionMessages()` 的 fixture，並加一條「`content` 是純字串的 user 訊息要產出 `text` 而非 `unknown`」。

---

## 3. Task 1 的 `appDir` 守衛

### 3.1 最嚴重的一條不是繞過，是守衛問錯了問題

`~/.claude/usage-data/ingest-jsonl.mjs`：

```js
// 第 17-24 行
const EXCLUDE_PATHS = [
  '/Users/me/Projects',      // ← 整棵樹
  '/Users/me/Downloads',
  ...
];
// 第 39 行
return prefixes.some(prefix => p === prefix || p.startsWith(prefix + '/'));
// 第 201 行
if (isExcluded(meta.project_path) || isIgnored(meta.project_path)) { excludedCwd++; continue; }
```

`/Users/me/Projects` **整棵樹**都被排除，不只 app 目錄。

守衛檢查的是 `resolve(projectDir) === resolve(appDir)`（plan:205）：

- `projectDir = /Users/me/Projects/yeschef/docs` → 不等於 appDir → **通過** → 逐字稿照樣整場被排除
- `projectDir = /Users/me/Projects/任何別的專案` → **通過** → 一樣被排除

守衛宣稱的目的（讓 session 算進 Insights，plan:18、plan:196-199）跟它實際檢查的條件（不等於 app 目錄）是兩件事。測試照著條件寫（plan:112-125），所以永遠綠。**這跟失敗史裡的第一型完全同構。**

有意思的是，計畫已經測了 `'/Users/me/Projects/yeschef/docs/..'`（plan:123），那個會 `resolve` 回 yeschef 所以會擋。少了 `/..` 的 `'/Users/me/Projects/yeschef/docs'` 就不擋。兩個字元之差。

### 3.2 macOS 上的其他繞過（實測）

| 形式 | 實測結果 |
|---|---|
| `/tmp` vs `/private/tmp` | `resolve('/tmp/x')` 回 `/tmp/x`；但 `cd /tmp && node -e "process.cwd()"` 回 `/private/tmp`，逐字稿記的是 realpath。ingest 的 `IGNORE_PATHS`（第 29-32 行）含 `/private/tmp` 與 `/private/var/folders`，第 201 行對 cwd 直接 `continue`。守衛放行，Insights 丟掉 |
| 大小寫不敏感 | `fs.existsSync('/Users/me/projects/YESCHEF')` 為 `true`（同一個目錄），`resolve()` 字串不等 → 放行。而且 `fs.realpathSync` 在 macOS **不**正規化大小寫，實測回傳的還是輸入的大小寫，所以改用 realpath 也修不掉這一條 |
| 符號連結 | `resolve()` 不解析 symlink。`ln -s ~/Projects/yeschef ~/work` 之後給 `/Users/me/work` 就過 |
| `app.getAppPath()` | 打包後回 `<App>.app/Contents/Resources/app.asar`，永遠不等於任何真實 projectDir，守衛在打包版形同不存在。只有 dev（electron-vite dev 回專案根目錄）才會觸發。這個被列為唯一 Critical 的守衛，只在開發時有效 |

### 3.3 接縫沒被測到（跟上一個分支同一個缺陷）

十個測試全部自己餵 `projectDir` 與 `appDir`。產生這兩個值的程式沒有任何測試：

```ts
// src/main/index.ts:98-119（現行）
const projectDir = process.env.YESCHEF_PROJECT_DIR
if (!projectDir) { ... 印訊息、不啟動 ... }
...
projectDir,
appDir: app.getAppPath(),
```

計畫在 plan:112 把那條測試標成「接縫測試，上一個分支的 Critical」，但它沒有碰到接縫。把 `index.ts` 改成傳 `app.getAppPath()` 當 projectDir，十個測試照樣全綠。

另外規格 §3.2 自己開了一個旁路：「點別的專案的歷史對話則用它原本的 cwd `resume`」。那個 cwd 來自 `listSessions()`，不經過 `buildSessionOptions`。規格沒說要不要過守衛。

### 3.4 最小修法

```ts
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

// macOS 預設 APFS 不分大小寫，realpath 不會正規化大小寫，所以要自己降冪
const norm = (p: string): string => realpathSync(p).toLowerCase()

const p = norm(input.projectDir)
const a = norm(input.appDir)
if (p === a || p.startsWith(a + sep)) throw new Error('projectDir 不可在 app 目錄之下')
if (INSIGHTS_EXCLUDE_PATHS.some((x) => p === x || p.startsWith(x + sep)))
  throw new Error('projectDir 落在 Insights 的排除路徑下，這場 session 不會被計入')
```

再加：

- `INSIGHTS_EXCLUDE_PATHS` 抄成常數（或直接讀 ingest 腳本），並寫一條測試斷言 `/Users/me/Projects/yeschef/docs` 會被擋。**這一條才是守衛宣稱要防的東西。**
- 把「讀 env + `getAppPath` + 呼叫 `buildSessionOptions`」抽成純函式 `resolveProjectDir(env, appPath)` 並測它。這樣改壞 `index.ts` 測試會紅。
- 驗 `statSync(projectDir).isDirectory()`，否則 spawn 會在別的地方以難解的 ENOENT 爆掉。

---

## 4. 三個 task 之間、以及與後面九個的介面一致性

### 4.1 `fold()` 現在寫不出來

規格 §4.2 的 `Block` 與 Task 3 的 `Event` 之間，四個映射沒有來源：

| `Block` 需要 | 來源狀態 |
|---|---|
| `Turn.role` | 沒有。`type:'user'` 與 `type:'assistant'` 產出完全相同的 Event |
| `text.complete` / `thinking.complete` | 沒有。`content_block_stop` 被丟棄 |
| `tool.raw` | 沒有。`tool_use_result` 沒被讀 |
| `tool.status === 'awaiting-approval'` | 沒有。來自 `canUseTool`，不在事件流，而 `fold(events)` 沒有第二個參數 |

有來源的：`tool.status` 的 `denied`（`permission-denied` 的 `toolUseId` 可比對）、`running`（有 tool-use 無 tool-result）、`done`／`error`（`tool-result.isError`）、`tool.name`／`input`、`unknown.raw`。

### 4.2 `ConversationView` 從頭到尾沒定義

規格 §4.2 定義了 `Block`（spec:130-136）與 `Turn`（spec:138），但 `fold(events: readonly Event[]) → ConversationView`（spec:126）用的那個型別沒有任何地方定義。Task 4 得自己發明，而 Task 3 的測試已經 import 了 `type Event`，兩邊對不上時才會發現。

### 4.3 沒有 React key 的來源

`Turn` 與 `Block` 都沒有 id。逐幀整份重解析（spec:149）加 React，需要穩定 key，否則每幀 `<pre>` 重掛，文字選取與捲動位置會掉。key 的來源（`messageId` + block `index`）要在 Task 3 的 Event 型別裡就種下，跟 4.1 的修法是同一件事。

### 4.4 `permissionMode: 'manual'` 型別上過不了

用專案自己的 tsc（`node_modules/.bin/tsc`）實測，把 Task 1 的 `SessionOptions` 指派給 SDK 的 `Options`：

```
tscheck.ts(12,7): error TS2322: Type 'SessionOptions' is not assignable to type 'Options'.
  Types of property 'permissionMode' are incompatible.
    Type '"manual"' is not assignable to type 'PermissionMode | undefined'.
```

`sdk.d.ts:2238`：

```ts
export declare type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

`npm run typecheck` 會在 `agent-host.ts` 那個 task 才炸，Task 1 的十個測試不會。

**執行期的實際情況（2026-09-02 直接跑 CLI 實測）：**

```
$ claude --help | grep -A3 permission-mode
  --permission-mode <mode>   (choices: "acceptEdits", "auto",
                              "bypassPermissions", "manual", "dontAsk", "plan")
```

CLI **接受** `manual`（SDK 的 TS 型別漏了它，CLI 的 choices 又漏了 `default`，兩份清單不一致）。但它解析成什麼：

| 傳入 | `init.permissionMode` 回報 | SDK TS 型別接受 |
|---|---|---|
| `manual` | **`default`** | ✗ TS2322 |
| `default` | `default` | ✓ |
| `plan` | `plan` | ✓ |
| `auto` | `auto` | ✓ |
| 不傳 | **`auto`** | ✓ |

`plan` → 回報 `plan`，證明 `init.permissionMode` 忠實反映生效模式。所以 `manual` → `default` 是真的降級，不是回報欄位的假象。這跟 fixture `03-sdk-live-stream.jsonl` 第 9 行一致：那一場是 `capture.mjs:7` 用 `permissionMode: 'manual'` 跑的，init 記著 `"permissionMode": "default"`。

因果關係的更正（見第 5 節第二條）：`canUseTool` 被呼叫，是因為傳了 `canUseTool` 這個回呼，不是因為 `permissionMode: 'manual'`。測試名字「permissionMode 固定為 manual，讓 canUseTool 會被呼叫」（plan:139）把兩件事綁在一起，而測試本身只斷言字串等於 `'manual'`，永遠綠。

**修法：改成 `permissionMode: 'default'`。不可以省略這個欄位** —— 省略會落到 `auto`，那是不同的模式（SDK 的 `if(y) Z.push("--permission-mode", y)` 只在有值時才推旗標）。`'default'` 與現行 `'manual'` 的執行期行為相同，而且過得了 typecheck。

### 4.5 其他

- `SessionOptions` 不含 `canUseTool` 與 `abortController`，`agent-host.ts` 得自己補。守衛只保護走 `buildSessionOptions` 這一條路。
- 逐幀重解析加上 `fold()` 吃整個 `Event[]`，是 O(n) per frame，`closeIncomplete` 也重掃全部文字。規格 §5「訊息長度有限，重解析便宜」講的是單則訊息，`fold()` 吃的是整場對話。長 session 下這是真成本。不是 Task 1-3 的阻塞，記在這裡。

---

## 5. 規格本身

| 段落 | 問題 |
|---|---|
| §1「事件模型很小，5 種頂層 type」 | fixture 03 有 6 種（多一個 `rate_limit_event`，規格自己在別處也列了它）。這張表標題是「已查證的事實」 |
| §4.1「約 18 個變體的聯集」 | `sdk.d.ts:4498` 的 `SDKMessage` 是 **39** 個變體 |
| §1「`canUseTool` 提供互動式逐次批准」 | 事實本身成立（回呼被呼叫、回 allow 後工具執行）。但這個事實被隱含歸因給 `permissionMode: 'manual'`，而實測顯示 `manual` 生效後是 `default`，`canUseTool` 之所以被呼叫是因為傳了回呼。那次實測沒有能區分 `manual` 與 `default` 的對照組 |
| §5「反引號圍欄數為奇數就補收尾」 | remark 與 marked 都會在文件結尾自動關閉未收尾圍欄，實測確認。這條規則不需要存在，而它的實作會製造 `` ```** `` |
| §8「渲染 `api_error_status`」 | Task 3 的 `session-end` Event 沒這個欄位。fixture 第 54 行有 |
| §2.3／§6「未經處理的 stdout／stderr」 | 資料在 `tool_use_result`（fixture 第 30 行），Task 3 的 Event 沒有來源 |
| §4.2 | 定義了 `Block` 與 `Turn`，沒定義 `ConversationView`，但簽章用了它 |
| §9「約 3000 字的真實文件產生約 3000 個案例」 | 計畫用 157 字元的手寫 DOC，157 個案例。而且不是「真實錄下的」，是照著四條規則各自處理的四種結構寫出來的 |
| §9「兩個 normalize 都用真實錄下的事件流當 fixture」 | `normalizeHistory` 沒有 fixture，三個測試全是手寫物件 |
| §3.2 vs §2.1 | 「點別的專案的歷史對話用它原本的 cwd `resume`」，那個 cwd 可能落在 `EXCLUDE_PATHS` 裡（例如任何 `~/Projects/*` 的舊對話），規格沒說要不要擋 |
| §1「4 種 content block」 | 抽樣 40 個真實逐字稿確實只有 `thinking`／`text`／`tool_use`／`tool_result`，成立。但使用者貼圖會出現 `image`，`fromContent` 的 `default` 會把整包 base64 塞進 unknown 卡片渲染出來 |

---

## 6. 附：改完後的兩個回歸驗證

成本很低，而這次的問題就是這樣找出來的：

1. 把 `closeIncomplete` 換成 `return ''` 跑測試，**應該要紅**。目前是綠。
2. 把 `normalizeLive` 的整段 `stream_event` 分支刪掉跑測試，**應該要紅**。目前是綠。

第三個也建議加進去：

3. 把 `closeIncomplete` 的 `if (inFence) continue` 拿掉跑測試，**應該要紅**。目前是綠。
