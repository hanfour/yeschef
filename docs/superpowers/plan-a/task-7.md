### Task 7: session-store（Recents 資料層）

Recents 這件事分成兩半：資料從哪來、畫面怎麼畫。本 task 只做前一半，也就是 main 側把 SDK 的 session API 包成本專案窄型別的 `src/main/session-store.ts`。後一半（`Recents.tsx`／`useSessions.ts`／`relative-time.ts`）是 Task 11。拆開的理由是排程：Task 8 的 `ipc-bridge.ts` 以 `SessionSource` 之名注入 `SessionStore`，所以資料層必須排在 Task 8 之前，而 renderer 那一半要等 Task 9B 的 App 版面，只能排最後。

三個設計判斷值得先講清楚。

**第一，`listSessions()` 不帶 `dir`。** 規格 §3.1 寫明「main 呼叫 `listSessions()`（不帶 `dir`，跨全部專案）」，§3.2 又補了理由：`YESCHEF_PROJECT_DIR` 只決定新對話開在哪，點別的專案的歷史對話是用它原本的 cwd `resume`。實查 SDK 型別（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts@0.3.258`，第 992 行的 `listSessions` 與第 997 行起的 `ListSessionsOptions`）確認 `dir` 是選填（第 1002 行），省略時「returns sessions across all projects」。所以照規格不傳。代價是實測數字：這台機器 `~/.claude/projects` 底下有 940 場 session，不帶 `dir` 也不帶 `limit` 的一次呼叫要 536 到 736 毫秒，序列化成 JSON 是 426 KB；帶 `limit: 100` 是 84 毫秒、39 KB。所以 `list()` 一律帶 `limit`（預設 100）。同一次實測也確認了 SDK 自己已經照 `lastModified` 由新到舊排序，且 `limit` 取的是最新的 N 筆，不是任意 N 筆，`limit` 因此不會漏掉最近的對話。`ListSessionsOptions.includeProgrammatic` 預設是 `true`（第 1028 行的註解），這一點很重要而且不能改：yeschef 自己開的對話正是 SDK session（entrypoint `sdk-ts`），傳 `false` 會讓使用者剛講完的那一場從 Recents 消失。

本檔引用的 `sdk.d.ts` 行號一律以 **0.3.258** 為準（裁決 24 釘的版本）：`listSessions` 992、`getSessionMessages` 797、`CanUseTool` 209、`ListSessionsOptions` 997、`includeProgrammatic` 1028。

**第二，SDK 呼叫失敗一律拋出，不回 `{ ok: false }`。** Task 8 Step 5 `ipc-bridge.ts` 的 `onSessionList` handler已經是「catch、`logError`、往上拋」的形狀，註解也寫明「回空陣列會被當成這台機器沒有歷史對話，那是靜默失敗」。`invoke` 的 reject 會走到 preload 再走到 Task 11 的 `useSessions` 的 `.catch`，錯誤訊息直接顯示在側邊欄。改成 Result 型別等於在同一條路徑上並存兩套錯誤語彙，而 Task 8 那一段還是得再包一次。所以這裡拋出 `Error`，並用 `cause` 掛住原始例外供主程序記錄。

**第三，歷史對話的事件流尾端補一筆 `session-end`（裁決 15）。** `loadHistory` 的產出是 `normalizeHistory` 逐則展開的結果加上 `{ kind: 'session-end', isError: false }`。這一筆不是造假：歷史訊息已經持久化，那場對話確實結束了。沒有它，`fold()` 跑完 fixture 04 之後每一個 text 與 thinking block 都是 `complete: false`，UI 會在一段早就結束的對話尾端畫游標（已用突變實測，見 Step 5 的突變 1）。同一段裡另一個必須知道的事實是裁決 4：`getSessionMessages()` 的產物不含 `tool_use_result`，所以 `loadHistory` 產出的事件裡永遠不會有 `tool-raw-output`。Task 9B 的 ToolCall 依 `historical` 顯示「這是歷史對話，沒有保存原始輸出」，來源就是這裡的缺席，本 task 有一條測試把這個缺席釘住。

實機驗證：本檔所有「已驗證」「實測」都指在 worktree（`git worktree add`，`npm install` 之後再 `npm install @anthropic-ai/claude-agent-sdk@0.3.258`）裡真的跑過 `npx tsc --noEmit -p .` 與 `npx vitest run`。最近一輪（2026-09-02 裁決 24 之後）材料化的上游是 Task 3 的 `events.ts`、Task 4／4B 的 `fold.ts`、Task 5 的狀態機、Task 6 的 `approval.ts` 與 Task 8 的 `ipc.ts`／`agent-host.ts`／`ipc-bridge.ts`，`tsc --noEmit -p .` 0 error，`tests/session-store.test.ts` 是 `Tests 19 passed (19)`，全 worktree 8 個測試檔 164 個測試全綠。四個突變逐一改壞、跑紅、還原、回綠，輸出見 Step 5。

**Files:**
- Create: `src/main/session-store.ts`
- Create: `tests/session-store.test.ts`
- Modify: `src/shared/ipc.ts`（只加 `SessionSummary` 這一個介面，見下面 Interfaces 的說明）
- Modify: `vitest.config.ts`（coverage 的 `include` 加 `src/main/session-store.ts`）
- Modify: `package.json`／`package-lock.json`（Step 0：加裝 `@anthropic-ai/claude-agent-sdk@0.3.258`，裁決 24）

`vitest.config.ts` 的 `test.include` 不動：那一行（改成 `'tests/**/*.test.{ts,tsx}'`）由 Task 9 做一次，本 task 的測試檔是 `.ts`，現行設定收得到。

**Interfaces:**
- Consumes:
  - `function normalizeHistory(msg: unknown): readonly Event[]`、`type Event`（Task 3，`src/shared/events.ts`）
  - `function fold(events: readonly Event[]): ConversationView`（Task 4／4B，`src/shared/fold.ts`）：只有 `tests/session-store.test.ts` 用它做端到端斷言，產品程式碼不依賴。這條測試要求 `fold()` 已依裁決 15 實作（`session-end` 到達時 text／thinking block 設 `complete: true`、`running`／`streaming-input` 的 tool block 設 `status: 'done'`）。Task 4 的 `applySessionEnd` 負責前半、Task 4B 的 `applyToolsSessionEnd` 負責後半，兩者在 `applyEvent` 的 `session-end` case 疊加呼叫。**Task 4B 已依裁決 15 實作**，本 task 直接依賴，不需要在這裡補。
- Produces:
  - `src/shared/ipc.ts`
    - `interface SessionSummary`（裁決 7 的六個欄位）
  - `src/main/session-store.ts`
    - `interface SdkSessionInfo`（`SDKSessionInfo` 用得到的七個欄位的窄複本）
    - `type ListSessionsFn = (options?: { limit?: number }) => Promise<readonly SdkSessionInfo[]>`
    - `type GetSessionMessagesFn = (sessionId: string) => Promise<readonly unknown[]>`
    - `interface SessionStore { list(): Promise<readonly SessionSummary[]>; loadHistory(sessionId: string): Promise<readonly Event[]>; cwdOf(sessionId: string): string | undefined }`
      （`cwdOf` 是裁決 20 加的：回傳最近一次 `list()` 結果裡該筆的 `cwd`，沒列過或該筆沒有 `cwd` 回 `undefined`）
    - `interface SessionStoreDeps { readonly listSessions: ListSessionsFn; readonly getSessionMessages: GetSessionMessagesFn; readonly limit?: number }`
    - `function createSessionStore(deps: SessionStoreDeps): SessionStore`
    - `const DEFAULT_SESSION_LIST_LIMIT = 100`

**`SessionSummary` 由本 task 加進 `src/shared/ipc.ts`，Task 8 改寫該檔時原樣保留。** 契約把 `SessionSummary` 記在 Task 8 的產出裡，但 Task 7 排在 Task 8 之前，`session-store.ts` 的 `list()` 回傳型別就是它，沒有它這個 task 編不過。解法是本 task 自己在 `src/shared/ipc.ts` 加上這個介面（原文照抄裁決 7，一個字不改），Task 8 的 Step 3 整支改寫 `ipc.ts` 時把這段留著。兩邊的字面完全相同，所以不論誰先做，結果的檔案內容一致：

```typescript
export interface SessionSummary {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly gitBranch?: string
}
```

下游用法：Task 8 的 `ipc-bridge.ts` 以 `SessionSource` 之名注入本 task 的 `SessionStore`，`session:list` handler 呼叫 `list()`，Task 5 的 `load-history` effect 呼叫 `loadHistory(sessionId)` 然後把回傳的 `Event[]` 從 `agent:events` 推出去。另外 Task 8 的 `index.ts` 用 `createSessionOptionsFactory(projectDir, sessions)` 接 `cwdOf`：resume 一場歷史對話時，`cwd` 用該場對話自己的目錄，`cwdOf` 回 `undefined` 才退回 `YESCHEF_PROJECT_DIR`（裁決 20）。組裝點（`src/main/index.ts`）這樣接：

```typescript
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { createSessionStore } from './session-store.js'

const sessions = createSessionStore({ listSessions, getSessionMessages })
```

這是唯一一處把 `SessionStore` 接上真正的 SDK。SDK 改形狀時這兩行會過不了 `tsc`，其餘程式碼都只看得到 `SdkSessionInfo` 這個窄型別。**這段接線本身由 Task 8 做**（`src/main/index.ts` 是 Task 8 的檔案），本 task 只負責讓它接得上，不改 `index.ts`。

- [ ] **Step 0: 安裝 SDK**

裁決 24：`@anthropic-ai/claude-agent-sdk` 由本 task 加裝，版本釘 0.3.258。本 task 的組裝點
（`src/main/index.ts`，Task 8 做）與 Step 6 的手動檢查都 import 它，所以安裝要排在寫實作之前。

```bash
npm install @anthropic-ai/claude-agent-sdk@0.3.258
```

Expected: `package.json` 的 `dependencies` 出現這一項，此時它是唯一一項：

```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "^0.3.258"
}
```

- [ ] **Step 1: 寫失敗的測試**

`tests/session-store.test.ts`。`getSessionMessages` 的假回傳直接用錄下來的真實產物 `tests/fixtures/events/04-session-history.jsonl`（6 則，型別只有 `user` 與 `assistant`，含一顆 Bash 工具呼叫與它的 `tool_result`）。`listSessions` 的假回傳則是手寫的，因為要測的是空字串、空白字串這些真實資料裡剛好沒有的情況（實測 940 筆裡 `summary` 空的有 0 筆，但 SDK 型別註解說它是「custom title, auto-generated summary, or first prompt」三選一，三個都沒有時會是空字串，所以退回鏈仍然必要）。

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSessionStore, type SdkSessionInfo } from '../src/main/session-store.js'
import { fold } from '../src/shared/fold.js'
import type { Event } from '../src/shared/events.js'

const HISTORY: readonly unknown[] = readFileSync(
  'tests/fixtures/events/04-session-history.jsonl',
  'utf8'
)
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as unknown)

const info = (over: Partial<SdkSessionInfo> & { sessionId: string }): SdkSessionInfo => ({
  summary: '摘要',
  lastModified: 1,
  ...over,
})

function storeOf(infos: readonly SdkSessionInfo[], messages: readonly unknown[] = HISTORY) {
  const calls: { limit?: number }[] = []
  const store = createSessionStore({
    listSessions: async (options) => {
      calls.push({ ...(options?.limit === undefined ? {} : { limit: options.limit }) })
      return infos
    },
    getSessionMessages: async () => messages,
  })
  return { store, calls }
}

describe('SessionStore.list：SDK 型別轉成 SessionSummary（裁決 7）', () => {
  it('只留下契約的六個欄位，SDK 專屬欄位不外洩', async () => {
    const { store } = storeOf([
      info({
        sessionId: 'a-1',
        summary: '摘要',
        lastModified: 1000,
        cwd: '/p',
        customTitle: '自訂',
        gitBranch: 'main',
        firstPrompt: '不該出現',
      }),
    ])
    const [first] = await store.list()
    expect(first).toEqual({
      sessionId: 'a-1',
      summary: '摘要',
      lastModified: 1000,
      cwd: '/p',
      customTitle: '自訂',
      gitBranch: 'main',
    })
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'customTitle',
      'cwd',
      'gitBranch',
      'lastModified',
      'sessionId',
      'summary',
    ])
  })

  it('沒有的選填欄位不會變成 undefined 屬性', async () => {
    const { store } = storeOf([info({ sessionId: 'a-2' })])
    const [first] = await store.list()
    expect(Object.keys(first ?? {}).sort()).toEqual(['lastModified', 'sessionId', 'summary'])
  })
})

describe('SessionStore.list：標題退回鏈', () => {
  it('summary 是空字串時退回 firstPrompt 的前 80 字', async () => {
    const long = 'x'.repeat(200)
    const { store } = storeOf([info({ sessionId: 'b-1', summary: '', firstPrompt: long })])
    const [first] = await store.list()
    expect(first?.summary).toHaveLength(80)
    expect(first?.summary).toBe('x'.repeat(80))
  })

  it('summary 只有空白也算空', async () => {
    const { store } = storeOf([info({ sessionId: 'b-2', summary: '   ', firstPrompt: '第一句' })])
    const [first] = await store.list()
    expect(first?.summary).toBe('第一句')
  })

  it('summary 與 firstPrompt 都空時退回 sessionId 前 8 碼', async () => {
    const { store } = storeOf([
      info({ sessionId: '0123456789abcdef', summary: '', firstPrompt: '' }),
    ])
    const [first] = await store.list()
    expect(first?.summary).toBe('01234567')
  })

  it('summary 有內容時不動它，也不被 firstPrompt 蓋掉', async () => {
    const { store } = storeOf([info({ sessionId: 'b-4', summary: '真摘要', firstPrompt: '第一句' })])
    const [first] = await store.list()
    expect(first?.summary).toBe('真摘要')
  })
})

describe('SessionStore.list：排序與不可變性', () => {
  // 輸入刻意亂序，且四筆的正確順序跟輸入順序沒有任何一位重合，
  // 拿掉排序時整條斷言都會不同，不會因為第一筆剛好對而漏抓。
  const shuffled: readonly SdkSessionInfo[] = [
    info({ sessionId: 'c-mid', lastModified: 200 }),
    info({ sessionId: 'c-old', lastModified: 100 }),
    info({ sessionId: 'c-new', lastModified: 400 }),
    info({ sessionId: 'c-late', lastModified: 300 }),
  ]

  it('依 lastModified 新到舊排序', async () => {
    const { store } = storeOf(shuffled)
    const list = await store.list()
    expect(list.map((s) => s.sessionId)).toEqual(['c-new', 'c-late', 'c-mid', 'c-old'])
  })

  it('不修改 SDK 回傳的陣列', async () => {
    const input = [...shuffled]
    const store = createSessionStore({
      listSessions: async () => input,
      getSessionMessages: async () => HISTORY,
    })
    await store.list()
    expect(input.map((s) => s.sessionId)).toEqual(['c-mid', 'c-old', 'c-new', 'c-late'])
  })

  it('帶 limit 呼叫 SDK，不無上限抓全機器的 session', async () => {
    const { store, calls } = storeOf(shuffled)
    await store.list()
    expect(calls).toEqual([{ limit: 100 }])
  })
})

describe('SessionStore.cwdOf：跨專案 resume 的 cwd（裁決 20）', () => {
  // 兩筆的 cwd 刻意不同，且問的是第二筆：退化成「永遠回第一筆的 cwd」的實作
  // 會在這裡變紅，不會因為只有一筆而巧合通過。
  const twoProjects: readonly SdkSessionInfo[] = [
    info({ sessionId: 'd-1', cwd: '/Users/x/Projects/alpha' }),
    info({ sessionId: 'd-2', cwd: '/Users/x/Projects/beta' }),
  ]

  it('list() 之後回得出該筆自己的 cwd', async () => {
    const { store } = storeOf(twoProjects)
    await store.list()
    expect(store.cwdOf('d-2')).toBe('/Users/x/Projects/beta')
    expect(store.cwdOf('d-1')).toBe('/Users/x/Projects/alpha')
  })

  it('該筆沒有 cwd 時回 undefined，不是空字串', async () => {
    const { store } = storeOf([info({ sessionId: 'd-3' })])
    await store.list()
    expect(store.cwdOf('d-3')).toBeUndefined()
  })

  it('還沒 list() 過就問，回 undefined', () => {
    const { store } = storeOf(twoProjects)
    expect(store.cwdOf('d-1')).toBeUndefined()
  })
})

describe('SessionStore.list：錯誤不得靜默變成空清單', () => {
  it('listSessions 拋錯時 list() reject，並保留原因', async () => {
    const cause = new Error('EACCES ~/.claude/projects')
    const store = createSessionStore({
      listSessions: async () => {
        throw cause
      },
      getSessionMessages: async () => HISTORY,
    })
    await expect(store.list()).rejects.toThrow('讀取歷史對話清單失敗')
    await expect(store.list()).rejects.toHaveProperty('cause', cause)
  })
})

describe('SessionStore.loadHistory', () => {
  it('逐則 normalizeHistory 展開，尾端補一筆 session-end（裁決 15）', async () => {
    const { store } = storeOf([])
    const events = await store.loadHistory('s-1')
    expect(events.length).toBeGreaterThan(HISTORY.length)
    expect(events.at(-1)).toEqual({ kind: 'session-end', isError: false })
    expect(events.filter((e) => e.kind === 'session-end')).toHaveLength(1)
  })

  it('產出不含 tool-raw-output：歷史對話沒有保存原始輸出（裁決 4）', async () => {
    const { store } = storeOf([])
    const events = await store.loadHistory('s-1')
    expect(events.some((e) => e.kind === 'tool-use')).toBe(true)
    expect(events.some((e) => e.kind === 'tool-raw-output')).toBe(false)
  })

  it('餵進 fold 之後每一個 block 都是完成狀態，尾端不會畫游標', async () => {
    const { store } = storeOf([])
    const view = fold(await store.loadHistory('s-1'))
    const blocks = view.turns.flatMap((t) => t.blocks)
    expect(blocks.length).toBeGreaterThan(0)
    const incomplete = blocks
      .filter((b) => b.kind === 'text' || b.kind === 'thinking')
      .filter((b) => !b.complete)
    expect(incomplete).toEqual([])
    expect(blocks.filter((b) => b.kind === 'tool' && b.status === 'running')).toEqual([])
    expect(view.ended).toBe(true)
  })

  it('認不出來的歷史訊息產出 unknown，不丟棄', async () => {
    const { store } = storeOf([], [{ type: '未知型別', uuid: 'u-1' }])
    const events = await store.loadHistory('s-1')
    expect(events.map((e) => e.kind)).toEqual(['unknown', 'session-end'])
  })

  it('空的歷史也照樣補 session-end', async () => {
    const { store } = storeOf([], [])
    const events: readonly Event[] = await store.loadHistory('s-1')
    expect(events).toEqual([{ kind: 'session-end', isError: false }])
  })

  it('getSessionMessages 拋錯時 loadHistory reject，帶著 sessionId', async () => {
    const store = createSessionStore({
      listSessions: async () => [],
      getSessionMessages: async () => {
        throw new Error('ENOENT')
      },
    })
    await expect(store.loadHistory('s-404')).rejects.toThrow('s-404')
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

先確認 `vitest.config.ts` 收得到這支測試：本 task 的檔案是 `.ts`，專案現行的 `include: ['tests/**/*.test.ts']` 就收得到，不用改。`.tsx` 那條（改成 `'tests/**/*.test.{ts,tsx}'`）由 Task 9 做一次，本 task 只確認、不動它。

Run: `npm test tests/session-store.test.ts`
Expected: FAIL，無法解析 `../src/main/session-store.js`（檔案還不存在）。

- [ ] **Step 3: 寫最小實作**

`src/main/session-store.ts`：

```typescript
/**
 * Recents 的資料來源：把 SDK 的 session API 包成本專案的窄介面（裁決 7）。
 *
 * 這一層不做執行期形狀驗證。理由是它的兩個依賴由組裝點直接接上 SDK 的
 * listSessions／getSessionMessages，型別在編譯期就對上了；真正跨越不可信
 * 界線的是 IPC，那一關由 Task 8 的 parseSessionSummaries 把守。在這裡再驗
 * 一次只是同一件事寫兩遍。
 */

import { normalizeHistory, type Event } from '../shared/events.js'
import type { SessionSummary } from '../shared/ipc.js'

/**
 * SDK 的 SDKSessionInfo 裡本專案真的會讀的欄位（sdk.d.ts@0.3.258 第 4968 行）。
 * 用窄複本而不是直接 import SDK 型別：SDK 加欄位不會影響這裡，SDK 拿掉這七個
 * 之中任何一個，組裝點那一行會過不了 tsc，那正是我們要的訊號。
 */
export interface SdkSessionInfo {
  readonly sessionId: string
  readonly summary: string
  readonly lastModified: number
  readonly cwd?: string
  readonly customTitle?: string
  readonly firstPrompt?: string
  readonly gitBranch?: string
}

export type ListSessionsFn = (options?: { limit?: number }) => Promise<readonly SdkSessionInfo[]>
export type GetSessionMessagesFn = (sessionId: string) => Promise<readonly unknown[]>

export interface SessionStore {
  list(): Promise<readonly SessionSummary[]>
  loadHistory(sessionId: string): Promise<readonly Event[]>
  /**
   * 裁決 20：最近一次 `list()` 結果裡該筆的 `cwd`，給跨專案 resume 用。
   * 沒列過、或該筆沒有 `cwd`，回 `undefined`。
   */
  cwdOf(sessionId: string): string | undefined
}

export interface SessionStoreDeps {
  readonly listSessions: ListSessionsFn
  readonly getSessionMessages: GetSessionMessagesFn
  readonly limit?: number
}

/**
 * 實測（2026-09-02，本機 940 場 session）：不帶 limit 的 listSessions() 要
 * 536 到 736 毫秒、序列化 426 KB；limit 100 是 84 毫秒、39 KB。側邊欄一次也
 * 看不完一百筆，這個上限沒有實際損失。同一次實測確認 SDK 自己就是由新到舊
 * 排序，limit 取的是最新的 N 筆。
 */
export const DEFAULT_SESSION_LIST_LIMIT = 100
const FIRST_PROMPT_MAX = 80
const SESSION_ID_PREFIX = 8

/**
 * summary 的退回鏈。SDK 的註解說 summary 是「custom title、auto-generated
 * summary 或 first prompt」三選一，三者都沒有時它是空字串，此時清單會出現
 * 一整排無法辨識的空白列。退到 firstPrompt，再退到 sessionId 前 8 碼：後者
 * 醜但至少可以分辨兩筆不同的對話。
 */
function fallbackTitle(info: SdkSessionInfo): string {
  const summary = info.summary.trim()
  if (summary !== '') return summary
  const firstPrompt = (info.firstPrompt ?? '').trim()
  if (firstPrompt !== '') return firstPrompt.slice(0, FIRST_PROMPT_MAX)
  return info.sessionId.slice(0, SESSION_ID_PREFIX)
}

function toSummary(info: SdkSessionInfo): SessionSummary {
  return {
    sessionId: info.sessionId,
    summary: fallbackTitle(info),
    lastModified: info.lastModified,
    ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
    ...(info.customTitle === undefined ? {} : { customTitle: info.customTitle }),
    ...(info.gitBranch === undefined ? {} : { gitBranch: info.gitBranch }),
  }
}

function wrap(cause: unknown, message: string): Error {
  return new Error(message, { cause })
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const limit = deps.limit ?? DEFAULT_SESSION_LIST_LIMIT
  /**
   * 裁決 20：sessionId 到 cwd 的對照表，只有 `list()` 會換掉它，而且是整份換新的
   * `ReadonlyMap`，不就地 `set`。就地改的話，前一次 `list()` 已經消失的 session
   * 會永遠留在表裡，`cwdOf` 會回一個 SDK 早就不認得的目錄。
   */
  let cwds: ReadonlyMap<string, string> = new Map()

  return {
    async list() {
      let infos: readonly SdkSessionInfo[]
      try {
        infos = await deps.listSessions({ limit })
      } catch (cause) {
        // 不回空陣列：那會被當成「這台機器沒有歷史對話」，是靜默失敗（規格 §8）。
        throw wrap(cause, '讀取歷史對話清單失敗，Recents 無法顯示')
      }
      // 複製再排序：sort 會就地改動陣列，而這個陣列是 SDK 的，不是我們的。
      // SDK 目前已經由新到舊排好，這一行仍然保留：那是 SDK 的實作細節不是它的契約。
      const summaries = [...infos].sort((a, b) => b.lastModified - a.lastModified).map(toSummary)
      cwds = new Map(
        summaries.flatMap((s) => (s.cwd === undefined ? [] : [[s.sessionId, s.cwd] as const]))
      )
      return summaries
    },

    async loadHistory(sessionId) {
      let messages: readonly unknown[]
      try {
        messages = await deps.getSessionMessages(sessionId)
      } catch (cause) {
        throw wrap(cause, `讀取歷史對話 ${sessionId} 失敗`)
      }
      const events = messages.flatMap((m) => [...normalizeHistory(m)])
      // 裁決 15：歷史訊息已持久化，這場對話確實結束了，補這一筆不是造假。
      // 少了它，fold() 會讓每個 block 停在 complete: false，UI 在早就結束的
      // 對話尾端畫游標。
      return [...events, { kind: 'session-end', isError: false }]
    },

    cwdOf(sessionId) {
      return cwds.get(sessionId)
    },
  }
}
```

`vitest.config.ts` 的 coverage 那一段加一行（裁決 19：只用 diff 加自己的檔案，不重寫整份清單；`test.include` 不動）：

```diff
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/main/session-store.ts',
       ],
     },
```

`session-store.ts` 進得了這份清單，是因為它跟清單上其他成員同性質：不需要 jsdom、不需要 React，兩個依賴都用假函式注入就跑得起來。`src/shared/ipc.ts` 不用另外加：裁決 19 的基底清單已經有 `src/shared/**/*.ts` 這個 glob 涵蓋它。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/session-store.test.ts`
Expected: PASS，19 個測試（裁決 20 的 `cwdOf` 佔其中三條）。實跑輸出：

```
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

Run: `npm run typecheck`
Expected: 無錯誤。`session-store.ts` 共 131 行，在單檔上限內。已在 worktree 實測 `npx tsc --noEmit -p .`，`session-store.ts` 與 `tests/session-store.test.ts` 都沒有錯誤。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

四個突變，全部在 worktree 裡實際跑過：改壞、跑紅、還原、回綠。每一個都是「看起來合理」的寫法，不是明顯的破壞。

| # | 突變 | 變紅的測試 |
|---|---|---|
| 1 | `loadHistory` 直接回 `messages.flatMap(...)`，不補 `session-end` | 4 條 |
| 2 | `list()` 拿掉 `.sort(...)`，只保留 `[...infos].map(toSummary)` | 1 條 |
| 3 | `fallbackTitle` 拿掉 `firstPrompt` 那一段，空 summary 直接退到 sessionId | 2 條 |
| 4 | `list()` 成功後忘了換掉 `cwds` 對照表（拿掉 `cwds = new Map(...)` 那三行） | 1 條 |

**突變 1 是這個 task 存在的理由之一。** 少了那一筆 `session-end`，歷史對話的每一個 block 都停在 `complete: false`，畫面會在一段早就結束的對話尾端畫游標。輸出：

```
 × 逐則 normalizeHistory 展開，尾端補一筆 session-end（裁決 15） 2ms
 × 餵進 fold 之後每一個 block 都是完成狀態，尾端不會畫游標 3ms
 × 認不出來的歷史訊息產出 unknown，不丟棄 0ms
 × 空的歷史也照樣補 session-end 0ms
AssertionError: expected 6 to be greater than 6
AssertionError: expected [ { kind: 'thinking', …(2) }, …(2) ] to deeply equal []
AssertionError: expected [ 'unknown' ] to deeply equal [ 'unknown', 'session-end' ]
AssertionError: expected [] to deeply equal [ { kind: 'session-end', …(1) } ]
 Tests  4 failed | 15 passed (19)
```

「餵進 fold」那條測試的斷言順序刻意先驗 block 再驗 `ended`：`ended: false` 也會紅，但那個訊息不會告訴讀者真正的症狀是哪個 block 沒收尾。

突變 2 的輸出。四筆的正確順序與輸入順序沒有任何一位重合，所以整條斷言都不同，不會因為第一筆剛好對就漏抓：

```
 × 依 lastModified 新到舊排序 4ms
AssertionError: expected [ 'c-mid', 'c-old', 'c-new', 'c-late' ] to deeply equal [ 'c-new', 'c-late', 'c-mid', 'c-old' ]
 Tests  1 failed | 18 passed (19)
```

突變 3 的輸出。`b-1`／`b-2` 是那兩筆的 sessionId，紅燈訊息直接顯示退回鏈少了中間那一段：

```
 × summary 是空字串時退回 firstPrompt 的前 80 字 4ms
 × summary 只有空白也算空 1ms
AssertionError: expected 'b-1' to have a length of 80 but got 3
AssertionError: expected 'b-2' to be '第一句' // Object.is equality
 Tests  2 failed | 17 passed (19)
```

突變 4 的輸出（裁決 20）。它是這一組裡最容易被寫成「看起來對」的一種：`cwdOf` 讀得到一個空 Map，回 `undefined`，`list()` 照樣正確，Recents 也照樣顯示，只有 resume 會悄悄用錯目錄：

```
 × list() 之後回得出該筆自己的 cwd 2ms
AssertionError: expected undefined to be '/Users/x/Projects/beta' // Object.is equality
 Tests  1 failed | 18 passed (19)
```

四個突變逐一還原後都跑回綠燈：`Tests 19 passed (19)`。最後一次是全 worktree 一起跑，
`Test Files 8 passed (8)`、`Tests 164 passed (164)`（其中 19 個是本 task 的，其餘是
Task 6 的 13 條、Task 8 的 98 條，以及 worktree 裡既有的 cdp／layout／measure-memory）。

- [ ] **Step 6: 執行完整測試套件與 typecheck**

Run: `npm run typecheck`
Expected: 無錯誤

Run: `npm test`
Expected: PASS。本 task 為總數加 19。

- [ ] **Step 7: 提交**

```bash
git add src/main/session-store.ts \
  src/shared/ipc.ts \
  tests/session-store.test.ts \
  vitest.config.ts \
  package.json package-lock.json
git commit -m "feat: session-store 資料層，歷史載入補 session-end"
```

## 手動檢查清單（本 task commit 當下就能做的部分）

裁決 18：手動檢查只放在跑得起來的那個 task。本 task 完成時 renderer 還是佔位頁面，側邊欄看不到東西，所以「Recents 列得出來」「點歷史對話」這些端對端項目都不在這裡，歸 Task 12。這裡只留一件現在就驗得到的事：`listSessions` 真的讀得到 `~/.claude/projects`。用一支五行的臨時腳本確認（不進版控）：

```bash
node --experimental-strip-types -e "
import('@anthropic-ai/claude-agent-sdk').then(async (sdk) => {
  const t = Date.now()
  const list = await sdk.listSessions({ limit: 100 })
  console.log(list.length, Date.now() - t, 'ms')
})"
```

預期：筆數不超過 100，耗時在百毫秒等級（本機實測 84 毫秒）。

## 契約疑慮（照契約字面做完，列出待裁決）

**一、`createSessionStore` 的 deps 沒有 `projectDir`：已由接縫補記定案。** CONTRACT.md 的接縫補記（2026-09-02）明寫「`createSessionStore` 不收 `projectDir`：規格 §3.1／§3.2 定 Recents 跨專案，`listSessions()` 不帶 `dir`，預設 `limit: 100`」。本 task 實作的就是這個版本 `{ listSessions, getSessionMessages }` 再加一個選填的 `limit`，不再是待裁決事項，這裡只記錄依據。`getSessionMessages` 同理也不帶 `dir`，否則別的專案的 session 會找不到（`sdk.d.ts@0.3.258` 第 803 行的 `GetSessionMessagesOptions.dir` 註解：省略時 searches all projects；函式本身在第 797 行）。

**二、Task 8 的 `SessionSource` 與契約的 `SessionStore` 形狀：已一致。** 撰寫當時 Task 8 的 `SessionSource` 是 `{ list(), messages(sessionId): Promise<readonly unknown[]> }`，ipc-bridge 自己做 `normalizeHistory` 的展開；契約與裁決 15 則把「`normalizeHistory` 展開加補 `session-end`」放進 `SessionStore.loadHistory`。Task 8 之後已改成 `SessionSource { list(); loadHistory(sessionId): Promise<readonly Event[]> }`（見 Task 8 Step 5 `ipc-bridge.ts` 的介面宣告），ipc-bridge 不再自己展開。這裡保留是為了說明為何 `loadHistory` 的展開責任在本 task。

**三、`SessionSummary` 的歸屬。** 契約把它記在 Task 8 的產出裡，本 task 因為排在 Task 8 之前而必須自己加（見 Interfaces 一節）。字面完全相同，先做的那個 task 加完後另一個就是 no-op，跟 `vitest.config.ts` 的 `include` 是同一種情況。建議控制端在契約的元件介面一節註明「`SessionSummary` 由 Task 7 首次加入 `src/shared/ipc.ts`，Task 8 保留」。
