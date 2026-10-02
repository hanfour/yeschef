# 側邊欄能放多種內容 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 側邊欄從對話窗格裡拆出來變成一個容器,codex 對話不再整個沒有側邊欄,寬度可拖曳並記住。

**Architecture:** 新增 `Sidebar` 容器元件,內容由 provider 決定:Claude 畫既有的 `Recents`,codex 畫一句說明。寬度由 `useSidebarWidth` hook 管,寫進 `localStorage` 並設在 `document.documentElement` 的 `--sidebar-width` 上,不新增 IPC。

**Tech Stack:** React 19、TypeScript strict、vitest + @testing-library/react

**Spec:** `docs/specs/2026-09-11-shell-regions-design.md` 增量 2

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess` 開著,不可用 `any` 或 `!` 繞過。
- 不可就地修改:一律回傳新物件。
- 註解用繁體中文,說明為什麼這樣寫,不是重述程式碼。
- 不新增任何 IPC 頻道,不改 `src/main`。
- commit 訊息格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 測試門檻:Stmts ≥ 93、Branch ≥ 86。
- 寬度下限 180px、上限 520px,預設 280px。這三個值是常數,不可寫死在多處。
- codex 側邊欄的說明文字固定為:`codex 的歷史清單還沒做`。

---

### Task 1: 側邊欄容器,codex 對話也有側邊欄

**Files:**
- Create: `src/renderer/components/Sidebar.tsx`
- Create: `src/renderer/components/Sidebar.css`
- Modify: `src/renderer/components/ConversationPane.tsx:213-226`(那段 `provider === 'codex' ? null : <aside className="sidebar">…`)
- Test: `tests/sidebar.test.tsx`(新增)、`tests/conversation-pane.test.tsx`(加兩條)

**Interfaces:**
- Produces:`Sidebar`(元件)、`SidebarProps`、`CODEX_SIDEBAR_HINT`(常數,值 `'codex 的歷史清單還沒做'`)。Task 2 會在 `Sidebar.tsx` 裡加拖曳,靠的是這個檔案已經存在。
- Consumes:既有的 `Recents` 與 `RecentsProps`,不改它的介面。

現況:`ConversationPane` 直接畫 `<aside className="sidebar">`,而且 `provider === 'codex'` 時整個回傳 `null`,
所以 codex 分頁的畫面左邊是空的,使用者看不出那裡本來有東西。

- [ ] **Step 1: 寫失敗測試**

`tests/sidebar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CODEX_SIDEBAR_HINT, Sidebar } from '../src/renderer/components/Sidebar.js'

afterEach(cleanup)

describe('Sidebar', () => {
  it('有內容時畫內容', () => {
    render(<Sidebar><p>清單</p></Sidebar>)
    expect(screen.getByText('清單')).toBeInTheDocument()
    expect(screen.queryByText(CODEX_SIDEBAR_HINT)).toBeNull()
  })

  it('沒有內容時畫說明,側邊欄本身還在', () => {
    const { container } = render(<Sidebar hint={CODEX_SIDEBAR_HINT} />)
    expect(screen.getByText(CODEX_SIDEBAR_HINT)).toBeInTheDocument()
    expect(container.querySelector('.sidebar')).not.toBeNull()
  })
})
```

`tests/conversation-pane.test.tsx` 加:

```tsx
  it('codex 分頁的側邊欄不是消失而是有一句說明', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container } = render(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="codex" />
    )
    expect(container.querySelector('.sidebar')).not.toBeNull()
    expect(container.querySelector('.recents')).toBeNull()
    expect(screen.getByText('codex 的歷史清單還沒做')).toBeInTheDocument()
  })

  it('claude 分頁的側邊欄畫 Recents,沒有說明句', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    const { container } = render(
      <ConversationPane isActive={true} api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" provider="claude" />
    )
    expect(container.querySelector('.recents')).not.toBeNull()
    expect(screen.queryByText('codex 的歷史清單還沒做')).toBeNull()
  })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/sidebar.test.tsx tests/conversation-pane.test.tsx`
Expected: FAIL,找不到 `Sidebar` 模組

- [ ] **Step 3: 寫 Sidebar**

`src/renderer/components/Sidebar.tsx`:

```tsx
import type { ReactNode } from 'react'
import './Sidebar.css'

/** codex 的 thread 在 ~/.codex/sessions,是另一套格式,要新的資料來源(規格增量 2)。 */
export const CODEX_SIDEBAR_HINT = 'codex 的歷史清單還沒做'

export interface SidebarProps {
  /** 有內容就畫內容;沒有就畫 hint,側邊欄本身一律在。 */
  readonly children?: ReactNode
  readonly hint?: string
}

export function Sidebar({ children, hint }: SidebarProps): React.ReactElement {
  return (
    <aside className="sidebar">
      {children ?? <p className="sidebar-hint">{hint}</p>}
    </aside>
  )
}
```

`src/renderer/components/Sidebar.css`:

```css
.sidebar-hint { margin: 12px 10px; opacity: 0.6; font-size: 12px; line-height: 1.5; }
```

`.sidebar` 的寬度規則已經在 `LeftPane.css:16`,不要搬也不要重複定義。

- [ ] **Step 4: 接到 ConversationPane**

把 `ConversationPane.tsx` 那段三元運算換成:

```tsx
      <Sidebar hint={CODEX_SIDEBAR_HINT}>
        {provider === 'codex' ? undefined : (
          <Recents
            sessions={sessions}
            current={current}
            error={error}
            threads={threads}
            scope={scope}
            onScopeChange={project === undefined ? undefined : setScope}
            onOpen={api.openHistory}
            onStartNew={api.startNew}
          />
        )}
      </Sidebar>
```

`import { CODEX_SIDEBAR_HINT, Sidebar } from './Sidebar.js'`。
第 29 行那則註解寫「codex 分頁沒有 Recents 側欄」,改成「codex 分頁的側邊欄沒有清單」,
輸入框旁那顆「新對話」的行為不動。

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/sidebar.test.tsx tests/conversation-pane.test.tsx`
Expected: PASS

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck` → 0 errors
Run: `npx vitest run` → 全部 PASS
Run: `npm run test:coverage` → Stmts ≥ 93、Branch ≥ 86

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/components/Sidebar.css src/renderer/components/ConversationPane.tsx tests/sidebar.test.tsx tests/conversation-pane.test.tsx
git commit -m "feat: 側邊欄拆成容器,codex 對話改顯示說明而不是整個消失"
```

---

### Task 2: 側邊欄寬度可拖曳並記住

**Files:**
- Create: `src/renderer/hooks/useSidebarWidth.ts`
- Modify: `src/renderer/components/Sidebar.tsx`(加拖曳把手)
- Modify: `src/renderer/components/Sidebar.css`(把手樣式)
- Test: `tests/sidebar-width.test.ts`(新增)、`tests/sidebar.test.tsx`(加)

**Interfaces:**
- Consumes:Task 1 的 `Sidebar`。
- Produces:`useSidebarWidth(): { width: number; setWidth: (px: number) => void }`、
  `SIDEBAR_WIDTH_KEY`、`SIDEBAR_MIN`、`SIDEBAR_MAX`、`SIDEBAR_DEFAULT`。

寬度存 `localStorage`,不走 IPC:這個值只影響畫面,主行程用不到它。
多個對話 pane 各有一個 `Sidebar`,它們讀寫同一個 key、設同一個 CSS 變數,值一致。

- [ ] **Step 1: 寫失敗測試**

`tests/sidebar-width.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { clampWidth, readWidth, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_WIDTH_KEY, writeWidth } from '../src/renderer/hooks/useSidebarWidth.js'

afterEach(() => { localStorage.clear() })

describe('側邊欄寬度', () => {
  it('沒存過就是預設值', () => {
    expect(readWidth()).toBe(SIDEBAR_DEFAULT)
  })

  it('存過就讀回來', () => {
    writeWidth(320)
    expect(readWidth()).toBe(320)
  })

  it('超出上下限會夾回範圍內', () => {
    expect(clampWidth(10)).toBe(SIDEBAR_MIN)
    expect(clampWidth(9999)).toBe(SIDEBAR_MAX)
  })

  it('存進去的壞值不會讓畫面爛掉', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, 'abc')
    expect(readWidth()).toBe(SIDEBAR_DEFAULT)
  })
})
```

`tests/sidebar.test.tsx` 加:

```tsx
  it('拖曳把手會改寬度並存起來', () => {
    const { container } = render(<Sidebar><p>清單</p></Sidebar>)
    const handle = container.querySelector('.sidebar-resizer')
    expect(handle).not.toBeNull()
    fireEvent.pointerDown(handle!, { clientX: 280 })
    fireEvent.pointerMove(window, { clientX: 340 })
    fireEvent.pointerUp(window, { clientX: 340 })
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340')
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('340px')
  })
```

測試檔要補 `fireEvent`、`SIDEBAR_WIDTH_KEY` 的 import,並在 `afterEach` 清掉 `localStorage`
與 `document.documentElement.style.removeProperty('--sidebar-width')`,不然測試之間會互相影響。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/sidebar-width.test.ts tests/sidebar.test.tsx`
Expected: FAIL,找不到 `useSidebarWidth` 模組

- [ ] **Step 3: 寫 hook**

`src/renderer/hooks/useSidebarWidth.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'

export const SIDEBAR_WIDTH_KEY = 'yeschef.sidebarWidth'
export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 520
export const SIDEBAR_DEFAULT = 280

export function clampWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)))
}

/** localStorage 在某些情況會丟例外(隱私模式、被停用),讀不到就用預設值,不讓畫面爛掉。 */
export function readWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (raw === null) return SIDEBAR_DEFAULT
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? SIDEBAR_DEFAULT : clampWidth(n)
  } catch {
    return SIDEBAR_DEFAULT
  }
}

export function writeWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampWidth(px)))
  } catch {
    // 存不進去只是下次開回到預設值,不值得打斷使用者。
  }
}

export function useSidebarWidth(): { readonly width: number; readonly setWidth: (px: number) => void } {
  const [width, setWidthState] = useState(readWidth)
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
  }, [width])
  const setWidth = useCallback((px: number): void => {
    const next = clampWidth(px)
    setWidthState(next)
    writeWidth(next)
  }, [])
  return { width, setWidth }
}
```

- [ ] **Step 4: 把手接上去**

`Sidebar.tsx` 裡用 pointer 事件,不是 mouse 事件:pointer capture 讓拖出元素外面也收得到。

```tsx
  const { width, setWidth } = useSidebarWidth()
  const dragging = useRef<number | undefined>(undefined)

  const onPointerDown = (e: React.PointerEvent): void => {
    dragging.current = width - e.clientX
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }
```

`onPointerMove` 算 `setWidth(e.clientX + dragging.current)`,`onPointerUp` 把 listener 拿掉。
兩個 handler 要用 `useCallback` 並且在元件卸載時移除,不然切走的 pane 會留著 listener。
把手要放在 `<aside>` **外面**,跟它同一層,不是裡面:
`LeftPane.css:16` 給 `.sidebar` 的是 `overflow-y: auto`,放在裡面的 absolute 把手會被裁掉、
而且會跟著清單一起捲走。`Sidebar` 改成回傳 fragment:

```tsx
  return (
    <>
      <aside className="sidebar">{children ?? <p className="sidebar-hint">{hint}</p>}</aside>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="調整側邊欄寬度"
        onPointerDown={onPointerDown}
      />
    </>
  )
```

`Sidebar.css` 加(`.pane-area` 是 flex,把手當成一個 6px 寬的 flex 子項,
用負的 margin 壓在側邊欄邊界上,這樣它既不被裁掉也不佔走版面):

```css
.sidebar-resizer { flex: 0 0 6px; margin-left: -3px; margin-right: -3px; cursor: col-resize; z-index: 1; }
.sidebar-resizer:hover { background: #3a3f36; }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/sidebar-width.test.ts tests/sidebar.test.tsx`
Expected: PASS

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck` → 0 errors
Run: `npx vitest run` → 全部 PASS
Run: `npm run test:coverage` → Stmts ≥ 93、Branch ≥ 86

- [ ] **Step 7: Commit**

```bash
git add src/renderer/hooks/useSidebarWidth.ts src/renderer/components/Sidebar.tsx src/renderer/components/Sidebar.css tests/sidebar-width.test.ts tests/sidebar.test.tsx
git commit -m "feat: 側邊欄寬度可拖曳並記住"
```

---

## 驗收

單元測試以外,用真的 app 跑這三項:

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 切到 codex 對話 | 側邊欄不是消失,而是有一句「codex 的歷史清單還沒做」 |
| 2 | 拖側邊欄右緣 | 寬度跟著滑鼠變,放開後停在那裡;拖到很窄或很寬會停在 180 / 520 |
| 3 | 關掉 app 再開 | 側邊欄寬度還是上次那個值 |

## 自我檢查

**規格涵蓋**:規格 §72-82 三點,「codex 顯示說明」在 Task 1,「寬度可調並記住」在 Task 2,
「把側邊欄從對話窗格拆出來」是 Task 1 的 `Sidebar` 元件。不做新的資料來源,codex 的歷史清單是另一個子專案。

**沒有佔位**:每個 Step 都有可以直接貼的程式碼或可以直接跑的指令。Task 2 Step 4 的兩個 handler
只給了形狀沒給完整程式碼,因為 `useCallback` 的相依與卸載清理要看 React 版本的實際寫法,
這是實作者該判斷的部分,但行為要求(拖出元素外也要收得到、卸載要移除 listener)寫清楚了。

**型別一致**:`SIDEBAR_MIN`/`SIDEBAR_MAX`/`SIDEBAR_DEFAULT`/`SIDEBAR_WIDTH_KEY` 只在
`useSidebarWidth.ts` 定義一次,Task 2 的兩個測試檔都從那裡 import。
`CODEX_SIDEBAR_HINT` 只在 `Sidebar.tsx` 定義一次。
