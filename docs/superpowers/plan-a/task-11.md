### Task 11: Recents 側邊欄

規格 §2.3 把「要有 Recents 才算堪用」列為每天用得下去的門檻。那條門檻分成兩半：資料從哪來、畫面怎麼畫。前一半是 Task 7 的 `src/main/session-store.ts`（排在 Task 8 之前，因為 Task 8 的 `ipc-bridge.ts` 要注入它）；本 task 是後一半，renderer 側的 `useSessions` 加 `Recents` 元件加一個相對時間的純函式，以及把 `App.tsx` 的側邊欄佔位換掉。

本 task 排最後，理由是它動的 `App.tsx` 必須疊在 Task 10 交出來的那一版之上。接縫補記把演進順序定成 9 → 9B → 10 → 11，每個 task 給的完整檔案都是前一個 task 的檔案加上自己的改動。所以 Step 3d 的 `App.tsx` 是 Task 10 Step 3c 那一份，只把 `<aside>` 裡的佔位換成 `<Recents>`，其餘一行不動。

`Recents` 本身刻意做得笨。清單是一個 `<ul>`，每筆一個 `<button>`，標題取 `customTitle` 優先否則 `summary`，時間交給一個十五行的純函式 `formatRelativeTime(ms, now)`，`gitBranch` 有才畫。沒有虛擬捲動、沒有搜尋、沒有分組，因為 Task 7 的 `limit: 100` 已經把資料量壓在一百筆以內，加那些東西是在解決還不存在的問題。

`useSessions` 自己訂閱 `session:state`，不從 Task 9B 的 `useConversation` 拿。理由有兩個：一是側邊欄不該為了知道「現在選中哪一場」而依賴對話元件，兩者唯一的共通點只是都讀同一個狀態；二是這樣本 task 可以獨立測，不必連著 9B 一起跑。多一個 `onSessionState` 訂閱者的成本是一個閉包。

實機驗證：本檔所有「已驗證」「實測」都指在 worktree（`git worktree add`，`npm install` 裝好 react 19.2.8／react-dom 19.2.8／@testing-library/react 16.3.3／jsdom 30.0.1／vitest 4.1.11／typescript 7.0.2）裡真的跑過 `npx tsc --noEmit -p .` 與 `npx vitest run`。材料化的上游是 Task 3／4／4B／5／8 的 shared 型別與 `global.d.ts`、Task 7／9／9B／10 的程式碼與測試，`App.tsx` 依 9B → 10 → 11 的順序套過兩次，最後一版就是 Step 3d 這一份。全專案 12 個測試檔 181 個測試全綠、`tsc` 退出碼 0，本 task 的兩個測試檔佔其中 31 個。三個突變逐一改壞、跑紅、還原、回綠，輸出見 Step 5。

裁決 21 補記（2026-09-02，本次修訂加）：標題列的 `title.ts`、`tests/app-title-bar.test.tsx`、`App.tsx`／`App.css` 的 header 改動是這次依裁決 21 補上的，只在文件層面推演過，還沒有像上一段那樣真的在 worktree 跑過 `vitest run`／`tsc --noEmit`。加上這批之後全專案會是 13 個測試檔、184 個測試（本 task 佔 34），但這個數字要等 Task 11 實際動工時重新在 worktree 跑一次才能當「已驗證」。

**Files:**
- Create: `src/renderer/hooks/useSessions.ts`
- Create: `src/renderer/components/Recents.tsx`
- Create: `src/renderer/components/Recents.css`
- Create: `src/renderer/components/relative-time.ts`
- Create: `tests/recents.test.tsx`
- Create: `tests/use-sessions.test.tsx`
- Create: `src/renderer/title.ts`
- Create: `tests/app-title-bar.test.tsx`
- Modify: `src/renderer/App.tsx`（Task 10 的版本，把 `<aside>` 裡的佔位換成 `<Recents>`，並在最上面加 `<header className="title-bar">`，裁決 21）
- Modify: `src/renderer/App.css`（加 `.title-bar` 樣式，`.app` 的 grid 改成兩欄兩列，裁決 21）
- Modify: `tests/use-conversation.test.tsx`（Task 9B 的假 `YesChefApi` 有一個「Task 9B 不該呼叫 listSessions」的拋錯樁；本 task 之後 `App` 掛上 `Recents`，`useSessions` 一掛載就會呼叫它，那個樁要改成回空清單。細節與實測輸出見 Step 3e）
- Modify: `vitest.config.ts`（裁決 19 指派給本 task 的三個 coverage 條目：`relative-time.ts`、`useSessions.ts`、`title.ts`。`test.include` 那一行由 Task 9 做一次，本 task 只在 Step 2 確認）

`Recents` 自己的樣式全在 `Recents.css` 裡，這個檔案本 task 不動。標題列的取值邏輯拆進 `title.ts`，理由跟 `relative-time.ts` 一樣：純函式獨立成檔，容易單獨看懂，也讓 `App.tsx` 不用把條件判斷寫在 JSX 裡。

`Recents.tsx` 沒有列進 coverage：裁決 19 指派給本 task 的就是 `relative-time.ts` 與 `useSessions.ts` 兩個，元件本身由 `tests/recents.test.tsx` 的 20 條測試守著，不另外算覆蓋率。

**Interfaces:**
- Consumes:
  - `interface SessionSummary`（Task 7 首次加入 `src/shared/ipc.ts`，Task 8 改寫該檔時保留；六個欄位照裁決 7）
  - `interface YesChefApi`（Task 8，`src/shared/ipc.ts`，以裁決 14 定稿版為準）：用到的是 `onSessionState`、`listSessions`、`startNew`、`openHistory`，加上裁決 21 的 `projectDir`（標題列）
  - `type SessionState`（Task 5，`src/shared/session-state.ts`）
  - `window.yeschef`（Task 8 的 `src/renderer/global.d.ts`）
  - `App.tsx` 的 Task 10 版本（Task 10 Step 3c 的完整檔案）：本 task 的 Step 3d 是它加上一處改動
  - `SessionStore`／`createSessionStore`（Task 7，`src/main/session-store.ts`）：**只在敘述層面**。renderer 不 import main，本 task 的程式碼一個字都碰不到 `session-store.ts`。真正的關係是這條鏈：Task 7 的 `list()` 回傳 `SessionSummary[]`，Task 8 的 `session:list` handler 把它送過 IPC，`useSessions` 呼叫 `api.listSessions()` 收到同一份資料。所以 Task 7 的三件事會直接顯示在側邊欄上：`limit: 100` 決定清單最多幾筆、`lastModified` 由新到舊的排序決定顯示順序、`summary` 的退回鏈決定沒有摘要的那幾筆長什麼樣。這三件事本 task 都不重做也不覆寫。
- Produces:
  - `src/renderer/components/relative-time.ts`
    - `function formatRelativeTime(ms: number, now: number): string`
  - `src/renderer/title.ts`
    - `function titleFor(projectDir: string, current: string | undefined, sessions: readonly SessionSummary[]): string`（裁決 21：標題列文字）
  - `src/renderer/components/Recents.tsx`
    - `interface RecentsProps`（契約四個 props 加一個選填的 `error?: string`，接縫補記已接受）
    - `function Recents(props: RecentsProps)`（回傳型別不標註，照 Task 9 的慣例）
  - `src/renderer/hooks/useSessions.ts`
    - `interface UseSessions { readonly sessions: readonly SessionSummary[]; readonly current?: string; readonly error?: string }`
    - `function useSessions(api: YesChefApi): UseSessions`
    - `function currentSessionId(state: SessionState): string | undefined`

- [ ] **Step 1a: 寫失敗的測試（Recents，jsdom 環境）**

`tests/recents.test.tsx`。檔首用 Task 9 定下的 per-file 註記 `// @vitest-environment jsdom`，不動 `vitest.config.ts` 的 `environment`。時間用 `vi.setSystemTime` 凍住，`formatRelativeTime` 本身是純函式，另外直接測。

「點清單第二筆」與「點第三筆」這兩條是刻意的：只點第一筆的話，「`onOpen` 永遠傳 `sessions[0].sessionId`」這個退化實作照樣全綠。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Recents, type RecentsProps } from '../src/renderer/components/Recents.js'
import { formatRelativeTime } from '../src/renderer/components/relative-time.js'
import type { SessionSummary } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const THREE: readonly SessionSummary[] = [
  { sessionId: 's-1', summary: '第一場', lastModified: NOW - 2 * MINUTE, gitBranch: 'main' },
  { sessionId: 's-2', summary: '第二場', lastModified: NOW - 3 * HOUR, customTitle: '自訂標題' },
  { sessionId: 's-3', summary: '第三場', lastModified: NOW - 5 * DAY },
]

function renderRecents(over: Partial<RecentsProps> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const onOpen = vi.fn()
  const onStartNew = vi.fn()
  const utils = render(
    <Recents sessions={THREE} onOpen={onOpen} onStartNew={onStartNew} {...over} />
  )
  return { ...utils, onOpen, onStartNew }
}

describe('formatRelativeTime', () => {
  it.each([
    ['一分鐘內是剛剛', NOW - 30_000, '剛剛'],
    ['未滿一小時用分鐘', NOW - 59 * MINUTE, '59 分鐘前'],
    ['未滿一天用小時', NOW - 23 * HOUR, '23 小時前'],
    ['未滿三十天用天', NOW - 29 * DAY, '29 天前'],
    ['超過三十天用日期', Date.UTC(2026, 0, 15), '2026-01-15'],
  ])('%s', (_label, ms, expected) => {
    expect(formatRelativeTime(ms, NOW)).toBe(expected)
  })

  it('剛好一分鐘就進位成 1 分鐘前，不再是剛剛', () => {
    expect(formatRelativeTime(NOW - MINUTE, NOW)).toBe('1 分鐘前')
  })

  it('時鐘偏差導致的未來時間顯示剛剛，不顯示負數', () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).toBe('剛剛')
  })

  it('不是有限數字時給明確文案，不產生 Invalid Date', () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('時間不明')
  })
})

describe('Recents 清單', () => {
  it('每一筆都畫出來，customTitle 優先於 summary', () => {
    const { container } = renderRecents()
    const titles = [...container.querySelectorAll('.recents-title')].map((n) => n.textContent)
    expect(titles).toEqual(['第一場', '自訂標題', '第三場'])
  })

  it('顯示相對時間', () => {
    const { container } = renderRecents()
    const times = [...container.querySelectorAll('time')].map((n) => n.textContent)
    expect(times).toEqual(['2 分鐘前', '3 小時前', '5 天前'])
  })

  it('有 gitBranch 才顯示分支', () => {
    const { container } = renderRecents()
    const branches = [...container.querySelectorAll('.recents-branch')].map((n) => n.textContent)
    expect(branches).toEqual(['main'])
  })

  it('current 那一筆才有高亮，其餘沒有', () => {
    const { container } = renderRecents({ current: 's-2' })
    const items = [...container.querySelectorAll('.recents-item')]
    expect(items.map((n) => n.classList.contains('is-current'))).toEqual([false, true, false])
    expect(items.map((n) => n.getAttribute('aria-current'))).toEqual([null, 'true', null])
  })

  it('沒有 current 時三筆都不高亮', () => {
    const { container } = renderRecents()
    expect(container.querySelectorAll('.is-current')).toHaveLength(0)
  })
})

describe('Recents 互動', () => {
  // 點第二筆而不是第一筆：實作若退化成永遠傳第一筆的 sessionId，這條會紅。
  it('點清單第二筆時帶著那一筆的 sessionId 呼叫 onOpen', () => {
    const { container, onOpen, onStartNew } = renderRecents()
    const items = container.querySelectorAll('.recents-item')
    fireEvent.click(items[1] as Element)
    expect(onOpen.mock.calls).toEqual([['s-2']])
    expect(onStartNew).not.toHaveBeenCalled()
  })

  it('點第三筆帶第三筆的 sessionId', () => {
    const { container, onOpen } = renderRecents()
    fireEvent.click(container.querySelectorAll('.recents-item')[2] as Element)
    expect(onOpen.mock.calls).toEqual([['s-3']])
  })

  it('新對話按鈕呼叫 onStartNew，不呼叫 onOpen', () => {
    const { container, onOpen, onStartNew } = renderRecents()
    fireEvent.click(container.querySelector('.recents-new') as Element)
    expect(onStartNew).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('Recents 的空清單與錯誤', () => {
  it('沒有歷史對話時給明確文案', () => {
    const { container } = renderRecents({ sessions: [] })
    expect(container.querySelector('.recents-empty')?.textContent).toBe('還沒有歷史對話')
    expect(container.querySelector('.recents-error')).toBeNull()
  })

  it('載入失敗時顯示錯誤，且不顯示「還沒有歷史對話」', () => {
    const { container } = renderRecents({ sessions: [], error: '讀取歷史對話清單失敗' })
    expect(container.querySelector('.recents-error')?.textContent).toBe('讀取歷史對話清單失敗')
    expect(container.querySelector('.recents-empty')).toBeNull()
  })

  it('錯誤與舊清單同時存在時，兩者都看得到', () => {
    const { container } = renderRecents({ error: '讀取歷史對話清單失敗' })
    expect(container.querySelector('.recents-error')).not.toBeNull()
    expect(container.querySelectorAll('.recents-item')).toHaveLength(3)
  })

  it('新對話按鈕在錯誤狀態下仍然可用', () => {
    const { container, onStartNew } = renderRecents({ sessions: [], error: '壞了' })
    fireEvent.click(container.querySelector('.recents-new') as Element)
    expect(onStartNew).toHaveBeenCalledTimes(1)
  })
})
```
- [ ] **Step 1b: 寫失敗的測試（useSessions，jsdom 環境）**

`tests/use-sessions.test.tsx`。假的 `YesChefApi` 記錄 `listSessions` 被叫了幾次、`onSessionState` 的取消訂閱被叫了幾次，並提供一個 `push(state)` 把狀態推給所有監聽者。`respond(call)` 讓每一次呼叫可以回不同結果，用來測「第一次成功、第二次失敗」這種順序。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useSessions } from '../src/renderer/hooks/useSessions.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { SessionSummary, YesChefApi } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
})

const one: SessionSummary = { sessionId: 's-1', summary: '第一場', lastModified: 1 }
const two: SessionSummary = { sessionId: 's-2', summary: '第二場', lastModified: 2 }

interface Harness {
  readonly api: YesChefApi
  push(state: SessionState): void
  readonly listCalls: () => number
  readonly unsubscribed: () => number
}

function harness(
  respond: (call: number) => Promise<readonly SessionSummary[]> = async () => [one]
): Harness {
  let calls = 0
  let unsubscribed = 0
  const listeners: ((s: SessionState) => void)[] = []
  const api = {
    onEvents: () => () => undefined,
    onApprovalAsk: () => () => undefined,
    onSessionState: (cb: (s: SessionState) => void) => {
      listeners.push(cb)
      return () => {
        unsubscribed += 1
      }
    },
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: () => {
      calls += 1
      return respond(calls)
    },
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: '/Users/x/Projects/demo',
  } as unknown as YesChefApi
  return {
    api,
    push: (state) => {
      act(() => {
        for (const l of listeners) l(state)
      })
    },
    listCalls: () => calls,
    unsubscribed: () => unsubscribed,
  }
}

describe('useSessions 的載入時機', () => {
  it('掛載時就載入一次清單', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.sessions).toEqual([one])
    })
    expect(h.listCalls()).toBe(1)
  })

  it('一場新對話結束後（live → idle）重新載入，Recents 才會出現那一筆', async () => {
    const h = harness(async (call) => (call === 1 ? [] : [two]))
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    expect(result.current.sessions).toEqual([])

    h.push({ kind: 'live' })
    h.push({ kind: 'idle' })

    await waitFor(() => {
      expect(result.current.sessions).toEqual([two])
    })
    expect(h.listCalls()).toBe(3)
  })

  it('切到另一場歷史對話會重載', async () => {
    const h = harness()
    renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    h.push({ kind: 'viewing', sessionId: 's-b' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(3)
    })
  })

  it('內容相同的狀態重複推送不重載，避免每一次推播都打一次 SDK', async () => {
    const h = harness()
    renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await Promise.resolve()
    expect(h.listCalls()).toBe(2)
  })

  it('卸載時取消 session:state 訂閱', async () => {
    const h = harness()
    const { unmount } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    unmount()
    expect(h.unsubscribed()).toBe(1)
  })
})

describe('useSessions 的 current', () => {
  it('viewing 時 current 是正在看的那一場', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    h.push({ kind: 'viewing', sessionId: 's-old' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-old')
    })
  })

  it('live 帶 sessionId 時 current 是那一場', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    h.push({ kind: 'live', sessionId: 's-live' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-live')
    })
  })

  it('idle 沒有 current', async () => {
    const h = harness()
    const { result } = renderHook(() => useSessions(h.api))
    h.push({ kind: 'viewing', sessionId: 's-old' })
    await waitFor(() => {
      expect(result.current.current).toBe('s-old')
    })
    h.push({ kind: 'idle' })
    await waitFor(() => {
      expect(result.current.current).toBeUndefined()
    })
  })
})

describe('useSessions 的錯誤處理', () => {
  it('載入失敗時給出錯誤訊息，而不是安靜地變成空清單', async () => {
    const h = harness(async () => {
      throw new Error('讀取歷史對話清單失敗，Recents 無法顯示')
    })
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.error).toBe('讀取歷史對話清單失敗，Recents 無法顯示')
    })
    expect(result.current.sessions).toEqual([])
  })

  it('失敗時保留上一次讀到的清單，畫面不會突然清空', async () => {
    const h = harness(async (call) => {
      if (call === 1) return [one]
      throw new Error('壞了')
    })
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.sessions).toEqual([one])
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(result.current.error).toBe('壞了')
    })
    expect(result.current.sessions).toEqual([one])
  })

  it('重試成功後錯誤訊息清掉', async () => {
    const h = harness(async (call) => {
      if (call === 1) throw new Error('壞了')
      return [two]
    })
    const { result } = renderHook(() => useSessions(h.api))
    await waitFor(() => {
      expect(result.current.error).toBe('壞了')
    })
    h.push({ kind: 'viewing', sessionId: 's-a' })
    await waitFor(() => {
      expect(result.current.sessions).toEqual([two])
    })
    expect(result.current.error).toBeUndefined()
  })
})
```

- [ ] **Step 1c: 寫失敗的測試（App 標題列，jsdom 環境，裁決 21）**

`tests/app-title-bar.test.tsx`。這個假 `YesChefApi` 跟 1a／1b 的都不一樣：`onSessionState` 要支援多個訂閱者（`useConversation` 與 `useSessions`各訂一份），`listSessions` 要真的回資料而不是拋錯樁，因為標題列的第二、三條測試就是要看 `sessions` 裡的 `cwd`。

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { App } from '../src/renderer/App.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { SessionSummary, YesChefApi } from '../src/shared/ipc.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PROJECT_DIR = '/Users/x/Projects/demo'

function createFake(sessions: readonly SessionSummary[]): {
  readonly api: YesChefApi
  push(state: SessionState): void
} {
  const stateListeners = new Set<(state: SessionState) => void>()
  const api: YesChefApi = {
    onEvents: () => () => undefined,
    onApprovalAsk: () => () => undefined,
    onSessionState: (cb) => {
      stateListeners.add(cb)
      return () => {
        stateListeners.delete(cb)
      }
    },
    sendInput: () => undefined,
    replyApproval: () => undefined,
    listSessions: () => Promise.resolve(sessions),
    startNew: () => undefined,
    openHistory: () => undefined,
    projectDir: PROJECT_DIR,
  }
  return {
    api,
    push: (state) => {
      act(() => {
        for (const l of stateListeners) l(state)
      })
    },
  }
}

function titleBarText(container: HTMLElement) {
  return container.querySelector('.title-bar')?.textContent
}

describe('App 標題列（裁決 21）', () => {
  it('idle 時顯示 api.projectDir', () => {
    const fake = createFake([])
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    expect(titleBarText(container)).toBe(PROJECT_DIR)
  })

  it('viewing 一筆有 cwd 的 session 時顯示該 cwd', async () => {
    const withCwd: SessionSummary = {
      sessionId: 's-1',
      summary: '一場對話',
      lastModified: 1,
      cwd: '/Users/x/Projects/other',
    }
    const fake = createFake([withCwd])
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

    fake.push({ kind: 'viewing', sessionId: 's-1' })

    await waitFor(() => {
      expect(titleBarText(container)).toBe('/Users/x/Projects/other')
    })
  })

  it('viewing 一筆沒有 cwd 的 session 時顯示「目錄不明」', async () => {
    const noCwd: SessionSummary = { sessionId: 's-2', summary: '另一場對話', lastModified: 1 }
    const fake = createFake([noCwd])
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)

    fake.push({ kind: 'viewing', sessionId: 's-2' })

    await waitFor(() => {
      expect(titleBarText(container)).toBe('目錄不明')
    })
  })
})
```

- [ ] **Step 2: 執行測試，確認失敗**

先確認 `vitest.config.ts` 的 `include` 收得到 `.tsx`：

```
include: ['tests/**/*.test.{ts,tsx}'],
```

這一行由 Task 9 改（接縫補記定它只做一次），本 task 只確認在不在，不在就先補上再往下走。不是預防性的檢查：專案原本的 `include` 只寫 `*.test.ts`，picomatch 不把 `.test.tsx` 算進去，而且是靜默的，不警告、不失敗、就是不執行。在 worktree 裡放一個只有 `expect(1).toBe(1)` 的 `tests/smoke.test.tsx` 跑 `npx vitest run`，結果是 `Test Files 4 passed (4)`，而當時的 `.test.ts` 檔正好就是 4 個，那個 `.tsx` 完全沒跑。補上 pattern 之後同一個指令變成 `Test Files 5 passed (5)`。

Run: `npm test tests/recents.test.tsx tests/use-sessions.test.tsx tests/app-title-bar.test.tsx`
Expected: FAIL，無法解析 `../src/renderer/components/Recents.js`、`../src/renderer/components/relative-time.js`、`../src/renderer/hooks/useSessions.js`；`app-title-bar.test.tsx` 這份會等到 Step 3d 加上 `<header className="title-bar">` 之後才真的變綠，Step 3a／3b／3c 做完的當下它仍然是紅的（`.title-bar` 找不到）

- [ ] **Step 3: 寫最小實作**

`vitest.config.ts` 的 coverage 加兩行（裁決 19：只用 diff 加自己的檔案，不重寫整份清單）：

```diff
     coverage: {
       include: [
         // ...既有條目不動...
+        'src/renderer/components/relative-time.ts',
+        'src/renderer/hooks/useSessions.ts',
+        'src/renderer/title.ts',
       ],
     },
```
**3a. `src/renderer/components/relative-time.ts`**：

```typescript
/** 相對時間文案。純函式，now 由呼叫端傳入，測試不需要動系統時鐘。 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return '時間不明'
  const diff = now - ms
  // diff 為負是時鐘偏差（session 檔的 mtime 比本機時間新）。顯示「剛剛」而不是
  // 負數的分鐘，因為使用者要的是「這場很新」這個訊息，不是精確的時間差。
  if (diff < MINUTE) return '剛剛'
  if (diff < HOUR) return `${String(Math.floor(diff / MINUTE))} 分鐘前`
  if (diff < DAY) return `${String(Math.floor(diff / HOUR))} 小時前`
  if (diff < 30 * DAY) return `${String(Math.floor(diff / DAY))} 天前`
  return new Date(ms).toISOString().slice(0, 10)
}
```
**3b. `src/renderer/components/Recents.tsx` 與 `Recents.css`**：

```tsx
import type { SessionSummary } from '../../shared/ipc.js'
import { formatRelativeTime } from './relative-time.js'
import './Recents.css'

export interface RecentsProps {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly onOpen: (sessionId: string) => void
  readonly onStartNew: () => void
  /** 契約四個 props 之外唯一的追加，理由見本檔末的「契約疑慮」。 */
  readonly error?: string
}

/** 裁決 7 的 SessionSummary 兩個欄位都可能是標題，customTitle 是使用者自己下的，優先。 */
function titleOf(s: SessionSummary): string {
  const custom = (s.customTitle ?? '').trim()
  return custom === '' ? s.summary : custom
}

export function Recents({ sessions, current, onOpen, onStartNew, error }: RecentsProps) {
  const at = Date.now()
  return (
    <nav className="recents" aria-label="歷史對話">
      <button type="button" className="recents-new" onClick={onStartNew}>
        新對話
      </button>
      {error === undefined ? null : (
        <p className="recents-error" role="alert">
          {error}
        </p>
      )}
      {/* 有錯誤時不顯示「還沒有歷史對話」：讀不到跟真的沒有是兩件事，
          顯示成後者等於用一句安慰的話蓋掉一個故障。 */}
      {error === undefined && sessions.length === 0 ? (
        <p className="recents-empty">還沒有歷史對話</p>
      ) : null}
      <ul className="recents-list">
        {sessions.map((s) => (
          <li key={s.sessionId}>
            <button
              type="button"
              className={s.sessionId === current ? 'recents-item is-current' : 'recents-item'}
              aria-current={s.sessionId === current ? 'true' : undefined}
              onClick={() => {
                onOpen(s.sessionId)
              }}
            >
              <span className="recents-title">{titleOf(s)}</span>
              <span className="recents-meta">
                <time dateTime={new Date(s.lastModified).toISOString()}>
                  {formatRelativeTime(s.lastModified, at)}
                </time>
                {s.gitBranch === undefined ? null : (
                  <span className="recents-branch">{s.gitBranch}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

```css
.recents { display: flex; flex-direction: column; height: 100%; }
.recents-new { margin: 8px; padding: 6px 10px; cursor: pointer; }
.recents-error { margin: 8px; color: #ff9a8c; }
.recents-empty { margin: 8px; opacity: 0.6; }
.recents-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.recents-item { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 6px 10px; border: 0; background: none; color: inherit; text-align: left; cursor: pointer; }
.recents-item.is-current { background: #232720; }
.recents-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recents-meta { display: flex; gap: 8px; font-size: 11px; opacity: 0.6; }
```
**3c. `src/renderer/hooks/useSessions.ts`**：

這個 hook 自己訂閱 `session:state`，不從 Task 9B 的 `useConversation` 拿。理由有兩個：一是側邊欄不該為了知道「現在選中哪一場」而依賴對話元件，兩者唯一的共通點只是都讀同一個狀態；二是這樣本 task 可以獨立測，不必等 9B。多一個 `onSessionState` 訂閱者的成本是一個閉包。

```typescript
import { useEffect, useState } from 'react'
import type { SessionState } from '../../shared/session-state.js'
import type { SessionSummary, YesChefApi } from '../../shared/ipc.js'

export interface UseSessions {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly error?: string
}

const IDLE: SessionState = { kind: 'idle' }

/** 目前選中的那一筆（裁決 14）。idle 沒有選中的 session。 */
export function currentSessionId(state: SessionState): string | undefined {
  return state.kind === 'idle' ? undefined : state.sessionId
}

/**
 * 依 SessionState 產生的重載鍵。用字串而不是直接把 state 物件放進 deps：
 * main 每次推 session:state 都是新物件，用物件當 deps 會讓每一次推送都重打一次
 * listSessions。內容相同就不重載，內容變了才重載。
 */
function reloadKey(state: SessionState): string {
  return `${state.kind}:${currentSessionId(state) ?? ''}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : '讀取歷史對話清單失敗'
}

export function useSessions(api: YesChefApi): UseSessions {
  const [state, setState] = useState<SessionState>(IDLE)
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => api.onSessionState(setState), [api])

  const key = reloadKey(state)
  useEffect(() => {
    // cancelled 擋的是慢的舊請求蓋掉快的新請求：連按兩筆歷史對話時會有兩次
    // listSessions 同時在飛，先發的後回就會把畫面倒退回舊清單。
    let cancelled = false
    api
      .listSessions()
      .then((list) => {
        if (cancelled) return
        setSessions(list)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 不清空 sessions：清單讀不到時，把上一次讀到的留在畫面上比變成空白有用。
        setError(messageOf(err))
      })
    return () => {
      cancelled = true
    }
  }, [api, key])

  const current = currentSessionId(state)
  return {
    sessions,
    ...(current === undefined ? {} : { current }),
    ...(error === undefined ? {} : { error }),
  }
}
```

一個已知的限制寫在這裡免得日後有人當成 bug：一場全新對話在 `session-start` 到達之前，`SessionState` 是 `{ kind: 'live' }` 沒有 `sessionId`（Task 5 的 `transition` 對 `start-new` 就是這樣回的），所以那段期間 `current` 是 `undefined`，Recents 沒有任何一筆高亮。這是誠實的：那場對話還沒有 id，清單上也還沒有它。等 Task 8 之後把 `session-start` 的 sessionId 回填進 `SessionState`，這裡不用改就會自動正確。

**3c-2. `src/renderer/title.ts`**（裁決 21：標題列文字，跟 `relative-time.ts` 一樣拆成獨立的純函式檔）：

```typescript
import type { SessionSummary } from '../shared/ipc.js'

const UNKNOWN_DIR = '目錄不明'

/**
 * 標題列文字（裁決 21）。沒有正在看哪一場（idle 或全新 live）時顯示目前專案的目錄；
 * 有 current 時顯示那一筆 session 記錄的 cwd，沒記到 cwd 就顯示「目錄不明」。
 * 找不到那個 sessionId（理論上不會發生，current 一定來自 sessions 同一份 session:state）
 * 的處理方式跟「有這筆但沒 cwd」相同，都是 undefined，不需要另外判斷。
 */
export function titleFor(
  projectDir: string,
  current: string | undefined,
  sessions: readonly SessionSummary[]
): string {
  if (current === undefined) return projectDir
  return sessions.find((s) => s.sessionId === current)?.cwd ?? UNKNOWN_DIR
}
```

**3d. `src/renderer/App.tsx`**（Task 10 的版本改兩處：`<aside>` 裡的佔位換成 `<Recents>`，最上面加 `<header className="title-bar">`；下面是改完之後的完整檔案，逐字取代原檔）：

```tsx
import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Conversation, type ToolBlock } from './components/Conversation.js'
import { ApprovalCard } from './components/ApprovalCard.js'
import { Recents } from './components/Recents.js'
import { useConversation } from './hooks/useConversation.js'
import { useApprovals } from './hooks/useApprovals.js'
import { useSessions } from './hooks/useSessions.js'
import { applyPendingApprovals, findAskForBlock, unmatchedAsks } from './approvals.js'
import { titleFor } from './title.js'
import type { SessionState } from '../shared/session-state.js'
import './App.css'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly onSend: (text: string) => void
  /** 有待決的批准請求時停用（規格 §6）。Task 9B 把這個 prop 留給 Task 10 接上。 */
  readonly disabled?: boolean
}

function Composer({ placeholder, onSend, disabled = false }: ComposerProps) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        className="composer-input"
        aria-label="輸入訊息"
        rows={3}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="composer-send" disabled={disabled}>
        送出
      </button>
    </form>
  )
}

function placeholderFor(state: SessionState): string {
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

/**
 * 「左＋中」這一個 React renderer（規格 §3，裁決 9）。右窗格是獨立的
 * WebContentsView，由主程序疊在視窗上，不在這棵 tree 裡。
 *
 * 批准的三個插入點（Task 10）：
 * 1. `applyPendingApprovals`：把命中的 tool block 標成 awaiting-approval
 * 2. `renderToolExtra`：把卡片畫進對應的 ToolCall 底部
 * 3. `unmatchedAsks`：對應不到 block 的請求畫在對話尾端，不靜默丟棄
 * 4. `Composer` 的 `disabled`：有待決請求時輸入框停用（規格 §6，9B 交棒）
 *
 * 側邊欄（Task 11）：`useSessions` 自己訂閱 session:state，不從 useConversation 拿。
 *
 * 第 2 點的命中查找一定要走 `findAskForBlock`，不能在這裡重寫一次比對：
 * 兩份比對邏輯遲早會漂移成「狀態標在 A、卡片畫在 B」。
 *
 * 標題列（Task 11，裁決 21）：跨專案的 Recents 讓使用者看得到別的目錄的歷史對話，
 * 代價是要有個地方講清楚「現在看的到底是哪個目錄」，取值邏輯交給 `titleFor`。
 */
export function App() {
  const api = window.yeschef
  const { view: rawView, sessionState } = useConversation(api)
  const { pending, reply } = useApprovals(api)
  const { sessions, current, error } = useSessions(api)

  const view = useMemo(() => applyPendingApprovals(rawView, pending), [rawView, pending])
  const orphans = useMemo(() => unmatchedAsks(view, pending), [view, pending])

  const renderToolExtra = useCallback(
    (block: ToolBlock) => {
      const ask = findAskForBlock(block, pending)
      return ask === undefined ? null : <ApprovalCard ask={ask} onDecide={reply} />
    },
    [pending, reply]
  )

  return (
    <div className="app">
      <header className="title-bar">{titleFor(api.projectDir, current, sessions)}</header>
      <aside className="sidebar">
        <Recents
          sessions={sessions}
          current={current}
          error={error}
          onOpen={api.openHistory}
          onStartNew={api.startNew}
        />
      </aside>
      <main className="conversation">
        <Conversation
          view={view}
          historical={sessionState.kind === 'viewing'}
          renderToolExtra={renderToolExtra}
        />
        {orphans.length > 0 ? (
          <div className="approval-tail">
            {orphans.map((ask) => (
              <ApprovalCard key={ask.requestId} ask={ask} onDecide={reply} unmatched />
            ))}
          </div>
        ) : null}
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => api.sendInput(text)}
          disabled={pending.length > 0}
        />
      </main>
    </div>
  )
}
```

跟 Task 10 那一版的差別是五行 import 與 hook 呼叫、`<aside>` 裡的一個元素，加上最上面的 `<header className="title-bar">`。`<main>` 那一半一個字都沒動。

`titleFor` 只取三個原始值（`projectDir` 字串、`current` 字串或 undefined、`sessions` 陣列），不吃整個 `api` 物件：跟 Task 9 對 `Markdown` 的要求同一個理由，呼叫端傳基本值，函式本身才好單獨想清楚、單獨測。

`current={current}` 與 `error={error}` 直接寫，不用 `{...(current === undefined ? {} : { current })}` 這種條件展開：接縫補記已確認 `tsconfig.json` 沒開 `exactOptionalPropertyTypes`，`string | undefined` 賦給 `?: string` 直接可過。已在 worktree 實測 `npx tsc --noEmit -p .` 退出碼 0。

`onOpen={api.openHistory}` 與 `onStartNew={api.startNew}` 直接傳函式參照，不包 `useCallback`：`api` 就是 `window.yeschef`，由 preload 建立一次就不再變，它身上的方法參照也跟著穩定。`Recents` 沒有 memo，包了也省不到什麼。

**3d-2. `src/renderer/App.css`**（Task 9B 那一份加 `.title-bar`，`.app` 的 grid 從一列改兩列；下面是完整檔案，逐字取代原檔，`.conversation`／`.placeholder`／`.composer`／`.composer-input` 四條是 Task 9B 定的，一行不改）：

```css
html,
body,
#root {
  height: 100%;
  margin: 0;
}

.app {
  --sidebar-width: 280px;

  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  grid-template-rows: auto 1fr;
  height: 100%;
  font-family: ui-monospace, Menlo, monospace;
  color: #d8dcd4;
  background: #12140f;
}

.title-bar {
  grid-column: 1 / -1;
  padding: 4px 10px;
  font-family: ui-monospace, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid #2a2d24;
}

.sidebar {
  border-right: 1px solid #2a2d24;
  overflow-y: auto;
}

.conversation { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.placeholder { padding: 12px; opacity: 0.6; }
.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #2a2d24; }
.composer-input { flex: 1 1 auto; resize: vertical; font: inherit; }
```

`.app` 原本只定 `grid-template-columns`（兩欄一列，`<aside>` 與 `<main>` 各佔一格），沒有明講 `grid-template-rows`，因為當時只有一列。加 `<header>` 之後改成兩欄兩列：第一列給標題列，`grid-column: 1 / -1` 讓它跨滿兩欄；第二列還是 `<aside>` 跟 `<main>` 各占一欄，跟 Task 9 那一版一樣不用另外標 `grid-row`，CSS grid 的 auto-placement 本來就會把接下來兩個子元素依序放進第二列。`.sidebar` 之後那四條是 Task 9B 為輸入框改的，本 task 一行不動，列在這裡只是因為「完整檔案」的規矩要求逐字照抄。

**3e. `tests/use-conversation.test.tsx` 的假 api 改一個樁**（Task 9B 的檔案，本 task 動一處）：

Task 9B 的假 `YesChefApi` 把它不該用到的三個成員做成會拋錯的樁，`listSessions` 是其中之一。本 task 之後 `App` 掛上了 `Recents`，`useSessions` 一掛載就呼叫 `api.listSessions()`，於是 9B 那七條 `App` 測試全部炸掉。這不是 9B 寫錯，是接縫本身：那個樁在寫的當下是對的。改法是讓它回一個空清單。

```diff
     listSessions(): Promise<readonly SessionSummary[]> {
-      throw new Error('Task 9B 不該呼叫 listSessions')
+      // Task 11 之後 App 會掛上 Recents，useSessions 一掛載就呼叫這個。
+      // 本檔測的是對話那一半，回空清單即可。
+      return Promise.resolve([])
     },
```

`startNew` 與 `openHistory` 那兩個樁不用動：`App` 只是把它們當 prop 傳給 `Recents`，沒有呼叫，除非測試去點側邊欄的按鈕（9B 那七條都不點）。

不改這一行的實測後果（worktree 裡先套上 Step 3d 的 `App.tsx`、暫不改這個樁）：

```
 × Enter 送出並清空輸入框 11ms
 × Shift+Enter 不送出，內容保留 2ms
 × 輸入法組字中的 Enter 不送出（中文輸入選字用的 Enter） 2ms
 × 只有空白時不送出 2ms
 × viewing 時輸入框提示改成接續這條對話 1ms
 × 事件到達時對話出現在畫面上 1ms
 × viewing 時工具卡片展開後顯示歷史對話沒有原始輸出 1ms
Error: Task 9B 不該呼叫 listSessions
 Test Files  1 failed | 11 passed (12)
      Tests  7 failed | 153 passed (160)
```

改完之後同一個指令回到全綠。

- [ ] **Step 4: 執行測試，確認通過**

Run: `npm test tests/recents.test.tsx`
Expected: PASS，20 個測試（`formatRelativeTime` 的 `it.each` 展開成 5 個）

Run: `npm test tests/use-sessions.test.tsx`
Expected: PASS，11 個測試

Run: `npm test tests/use-conversation.test.tsx`
Expected: PASS，13 個測試（Step 3e 改完之後）

Run: `npm run typecheck`
Expected: 無錯誤。三支產品程式碼分別是 17／63／66 行，加上 `App.tsx` 的 129 行，全部在單檔上限內。

以上四個指令都在 worktree 裡對這份計畫的實際程式碼跑過（`react@19.2.8`、`@testing-library/react@16.3.3`、`jsdom@30.0.1`、`vitest@4.1.11`、`typescript@7.0.2`），不是推論。

Run: `npm test tests/app-title-bar.test.tsx`
Expected: PASS，3 個測試（idle 顯示 `projectDir`、viewing 有 `cwd` 的一筆、viewing 沒有 `cwd` 的一筆各一條）。`title.ts` 本身很短（約 14 行），`App.tsx` 加 header 之後約 131 行，都在單檔上限內；這一項是本次依裁決 21 補的，行數與測試結果尚未重新在 worktree 跑過，實作時要補做一次上面那句「不是推論」涵蓋的驗證。

- [ ] **Step 5: 突變測試（本計畫的強制步驟）**

三個突變，全部在 worktree 裡實際跑過，紅燈輸出照抄。每一個都是「看起來合理」的寫法，不是明顯的破壞。

| # | 突變 | 變紅的測試 |
|---|---|---|
| 1 | `useSessions` 的載入 effect deps 從 `[api, key]` 改成 `[api]` | 5 條 |
| 2 | 同一個 deps 改成 `[api, state]`（直接放狀態物件） | 1 條 |
| 3 | `Recents` 的 `onClick` 改成 `onOpen(sessions[0]?.sessionId ?? s.sessionId)` | 2 條 |
| 4 | `titleFor` 永遠回 `projectDir`，不看 `current`／`sessions` | 2 條 |

突變 1 的輸出。這是規格 §2.3「要有 Recents 才算堪用」的核心：講完一場新對話之後清單不更新，剛剛那一場就不見了：

```
 × 一場新對話結束後（live → idle）重新載入，Recents 才會出現那一筆 1016ms
 × 切到另一場歷史對話會重載 1005ms
 × 內容相同的狀態重複推送不重載，避免每一次推播都打一次 SDK 1005ms
 × 失敗時保留上一次讀到的清單，畫面不會突然清空 1058ms
 × 重試成功後錯誤訊息清掉 1058ms
AssertionError: expected [] to deeply equal [ { sessionId: 's-2', …(2) } ]
 Tests  5 failed | 6 passed (11)
```

**突變 2 是最需要提防的那種**：`[api, state]` 看起來比 `[api, key]` 更自然，功能上也「對」（狀態一變就重載），錯的是次數。main 每推一次 `session:state` 就是一個新物件，於是每一次推播都打一次 SDK。輸出：

```
 × 內容相同的狀態重複推送不重載，避免每一次推播都打一次 SDK 7ms
AssertionError: expected 4 to be 2 // Object.is equality
 Tests  1 failed | 10 passed (11)
```

突變 3 的輸出。點第二筆與第三筆這兩條測試就是為了它存在，只點第一筆的話這個退化實作照樣全綠：

```
 × 點清單第二筆時帶著那一筆的 sessionId 呼叫 onOpen 8ms
 × 點第三筆帶第三筆的 sessionId 3ms
 Tests  2 failed | 18 passed (20)
```

前三個突變逐一還原後都跑回綠燈，最後一次是全專案一起跑：`Test Files 12 passed (12)`、`Tests 181 passed (181)`（其中 31 個是本 task 新增的，其餘是 worktree 裡既有的 cdp／layout／measure-memory／spawn-args 與材料化的上游測試）。這是裁決 21 之前的實測結果。

突變 4 是本次依裁決 21 補的，未在 worktree 跑過，靠讀 `titleFor` 的程式碼推：把 `current === undefined` 那個分支拿掉、永遠回 `projectDir`，`tests/app-title-bar.test.tsx` 三條裡「idle 顯示 `projectDir`」那一條本來就期待 `projectDir`，不受影響；「viewing 有 cwd」與「viewing 沒有 cwd」這兩條分別期待 `/Users/x/Projects/other` 與「目錄不明」，都會被改成收到 `projectDir`，兩條一起變紅，不是只有一條。還原後預期跟其他三個突變一樣回到全綠。

- [ ] **Step 6: 執行完整測試套件與 typecheck**

Run: `npm run typecheck`
Expected: 無錯誤

Run: `npm test`
Expected: PASS。本 task 為總數加 34（`recents` 20、`use-sessions` 11、`app-title-bar` 3，最後一個是裁決 21 補的）。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/hooks/useSessions.ts \
  src/renderer/components/Recents.tsx src/renderer/components/Recents.css \
  src/renderer/components/relative-time.ts \
  src/renderer/title.ts \
  src/renderer/App.tsx src/renderer/App.css \
  tests/recents.test.tsx tests/use-sessions.test.tsx \
  tests/app-title-bar.test.tsx \
  tests/use-conversation.test.tsx \
  vitest.config.ts
git commit -m "feat: Recents 側邊欄接上 App，加標題列顯示目前目錄"
```

## 手動檢查清單（需要真的跑起來的部分）

單元測試碰不到的四件事，接上 Task 7 的 `session-store` 與 Task 8 的組裝點之後手動確認：

| # | 檢查 | 操作 | 預期 |
|---|---|---|---|
| 1 | Recents 真的列得出來 | `YESCHEF_PROJECT_DIR=$HOME/你的專案 npm run dev` | 側邊欄出現最近 100 筆，跨全部專案，最新的在最上面 |
| 2 | 新對話結束後清單更新 | 開新對話、問一句、等它答完 | 那一場出現在清單第一列 |
| 3 | 點歷史對話 | 點第二列 | 該筆高亮、對話區顯示歷史內容、工具呼叫展開後看到裁決 4 的文案 |
| 4 | `.title-bar` 標題列跟著切換（裁決 21） | 點別的專案的歷史對話，再按「開新對話」 | 標題列先換成那場對話原本的目錄，按「開新對話」後換回 `YESCHEF_PROJECT_DIR` |

裁決 18 明文保留 Task 11 的手動清單：本 task 是最後一個，commit 當下 Task 7 的資料層、Task 8 的 IPC、Task 9／9B／10 的 UI 都已經在，這三項現在就操作得到。第 1 與第 3 項驗的其實是 Task 7 那一半的產出（清單怎麼來、歷史怎麼載），本 task 只負責畫，兩邊接不上時先看 Task 7。第 4 項是裁決 21 加的，跨兩個裁決：`cwd` 從哪來要看裁決 20（跨專案 resume 帶原本的 cwd），標題列怎麼畫是本 task 的 `titleFor`。更完整的端對端驗收在 Task 12。

## 契約疑慮（照契約字面做完，列出待裁決）

**一、`RecentsProps` 多一個選填的 `error?: string`：接縫補記已接受，不再是疑慮。** 契約原本定四個 props。接縫補記（2026-09-02）明寫「`RecentsProps` 加 `readonly error?: string`：載入失敗時由 Recents 自己顯示錯誤並抑制『還沒有歷史對話』」。這裡記錄理由供日後查閱：「不顯示空清單」這件事只有 `Recents` 自己做得到，錯誤如果畫在 `App` 那一層，`Recents` 仍然會同時顯示「還沒有歷史對話」，等於用一句安慰的話蓋掉一個故障。選填欄位對 Task 9B 與 Task 10 沒有影響，兩者都不用 `Recents`。

**二、`createSessionStore` 不收 `projectDir`：接縫補記已定案，且不在本 task 範圍。** 補記明寫「規格 §3.1／§3.2 定 Recents 跨專案，`listSessions()` 不帶 `dir`，預設 `limit: 100`」。實作在 Task 7，本 task 只是那個決定的下游：側邊欄看得到別的專案的對話，是因為 Task 7 沒帶 `dir`。這裡不需要裁決，記錄依賴關係。

**三、Task 8 的 `SessionSource` 與契約的 `SessionStore` 形狀：已一致。** 這條屬 Task 7 與 Task 8 之間的接縫，Task 8 的 `SessionSource` 已是 `{ list(); loadHistory(sessionId): Promise<readonly Event[]> }`（見 Task 7 的契約疑慮二）。本 task 只在它壞掉時看得到症狀：點歷史對話之後對話區的每一個 block 停在未完成狀態，尾端畫游標。

**四、本 task 動了 Task 9B 的測試檔。** Step 3e 改的是 `tests/use-conversation.test.tsx` 裡一個假 api 的樁。按「不動別的 task 檔」的慣例這需要一句說明：那不是計畫檔而是程式碼，而且改動的必要性完全由本 task 引入（`App` 掛上 `Recents` 之後才會呼叫 `listSessions`）。誰引入誰負責，所以列在本 task 的 Files 與提交清單裡。若控制端偏好由 Task 9B 預先把樁寫成回空清單，本 task 的 Step 3e 就變成 no-op，其餘不受影響。
