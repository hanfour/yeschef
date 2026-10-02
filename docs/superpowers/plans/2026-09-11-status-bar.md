# 增量 1:狀態列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 視窗底部一條狀態列,一處看得到誰在忙、誰等批准、有幾則同伴提問未決,以及目前這段對話花了多少。

**Architecture:** 不新增任何 IPC。三個數字來自 renderer 已經有的 `ProjectsView` 與 `usePeer`;目前對話的花費在 `ConversationPane` 裡面,由前景那個 pane 往上回報一次,App 持有並交給狀態列。「待批准」可點,點了切到那個專案與那個對話。

**Tech Stack:** React 19、TypeScript 7(`strict`、`noUncheckedIndexedAccess`)、vitest 4 加 @testing-library/react。

**Spec:** `docs/specs/2026-09-11-shell-regions-design.md` 的增量 1。

## Global Constraints

- 不新增 IPC 頻道,不改主行程。四個欄位的資料 renderer 都已經有了。
- 沒有資料的欄位整個不顯示,不要顯示 0 或「—」。
- 資料不就地修改;renderer 的文字跟著各元件既有做法走。
- 測試放 `tests/`;renderer 測試用 @testing-library/react 的 `render` 與 `fireEvent`(專案沒裝 user-event 與 jest-dom),斷言用 `not.toBeNull` 與 `textContent`,檔頭要有 `// @vitest-environment jsdom` 與 `afterEach(cleanup)`。
- TypeScript 是 `strict` + `noUncheckedIndexedAccess`;import 路徑帶 `.js` 副檔名。
- 每個 Task 結尾 `git add <明確檔名>` 與 `git commit` 分兩個指令;commit message 格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 完成前 `npm run typecheck` 與 `npx vitest run` 都要綠。Task 2 之後跑 `npm run test:coverage`,Stmts ≥ 93、Branch ≥ 86。

---

## 檔案結構

新增:

| 檔案 | 責任 |
|---|---|
| `src/renderer/components/StatusBar.tsx` | 狀態列本身。純顯示加一個跳轉回呼,不自己訂閱任何東西 |
| `src/renderer/components/StatusBar.css` | 同上的樣式 |
| `tests/status-bar.test.tsx` | 狀態列的單元測試 |

修改:

| 檔案 | 改動 |
|---|---|
| `src/renderer/App.tsx` | 掛上狀態列;持有前景對話的花費 |
| `src/renderer/App.css` | `.app` 的版面讓出底部那一條 |
| `src/renderer/components/LeftPane.tsx` | `renderConversation` 多傳一個「這個對話是不是前景」與回報花費的回呼 |
| `src/renderer/components/ConversationPane.tsx` | 是前景時把花費往上回報 |

---

### Task 1: 狀態列本身與三個數字

**Files:**
- Create: `src/renderer/components/StatusBar.tsx`
- Create: `src/renderer/components/StatusBar.css`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/App.css`
- Test: `tests/status-bar.test.tsx`(新)

**Interfaces:**
- Produces:
  - `interface ConversationCost { readonly turns?: number; readonly usd?: number; readonly tokens?: number }`
  - `interface StatusBarProps { readonly busy: number; readonly pending: number; readonly peerPending: number; readonly cost?: ConversationCost; readonly onJumpToPending?: () => void }`
  - `function StatusBar(props: StatusBarProps)`

行為:

- 四個欄位,任何一個沒有資料就整個不畫那一欄。`busy`、`pending`、`peerPending` 是 0 就當成沒有資料。
- `cost` 給了才畫;`turns`、`usd`、`tokens` 三個各自可缺,缺的不畫。
- 有 `onJumpToPending` 而且 `pending > 0` 時,「待批准」是一顆可點的按鈕;否則是純文字。
- 全部都沒有資料時狀態列仍然在,只是空的,不要整條消失(高度變動會讓下面的內容跳動)。

- [ ] **Step 1: 寫失敗測試**

`tests/status-bar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StatusBar } from '../src/renderer/components/StatusBar.js'

afterEach(cleanup)

describe('StatusBar', () => {
  it('沒有任何資料時是空的,但那一條還在', () => {
    const { container } = render(<StatusBar busy={0} pending={0} peerPending={0} />)
    expect(container.querySelector('.status-bar')).not.toBeNull()
    expect(container.querySelector('.status-bar')?.textContent).toBe('')
  })

  it('三個數字各自只在大於零時出現', () => {
    render(<StatusBar busy={2} pending={0} peerPending={1} />)
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('2 個進行中')
    expect(text).toContain('1 則同伴提問')
    expect(text).not.toContain('待批准')
  })

  it('花費三個欄位各自可缺', () => {
    render(<StatusBar busy={0} pending={0} peerPending={0} cost={{ turns: 3 }} />)
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('3 輪')
    expect(text).not.toContain('US$')
    expect(text).not.toContain('tokens')
  })

  it('花費齊全時三個都畫,金額四位小數、token 有千分位', () => {
    render(<StatusBar busy={0} pending={0} peerPending={0} cost={{ turns: 2, usd: 0.1637, tokens: 204910 }} />)
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('2 輪')
    expect(text).toContain('US$0.1637')
    expect(text).toContain('204,910 tokens')
  })

  it('有待批准又給了跳轉時是按鈕,點了會呼叫', () => {
    const onJump = vi.fn()
    render(<StatusBar busy={0} pending={2} peerPending={0} onJumpToPending={onJump} />)
    const button = screen.getByRole('button', { name: '2 個待批准' })
    fireEvent.click(button)
    expect(onJump).toHaveBeenCalledTimes(1)
  })

  it('沒給跳轉時待批准是純文字,不是按鈕', () => {
    render(<StatusBar busy={0} pending={2} peerPending={0} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('.status-bar')?.textContent).toContain('2 個待批准')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/status-bar.test.tsx`
Expected: FAIL,找不到 `StatusBar`

- [ ] **Step 3: 寫元件**

`src/renderer/components/StatusBar.tsx`:

```tsx
import './StatusBar.css'

export interface ConversationCost {
  readonly turns?: number
  readonly usd?: number
  readonly tokens?: number
}

export interface StatusBarProps {
  /** 全部專案加起來,回合進行中的對話數。 */
  readonly busy: number
  /** 全部專案加起來,有批准在等的對話數。 */
  readonly pending: number
  /** 未決的同伴提問筆數。 */
  readonly peerPending: number
  /** 前景那個對話的花費;還沒有就不給。 */
  readonly cost?: ConversationCost
  /** 有給而且 pending 大於零時,「待批准」是可點的。 */
  readonly onJumpToPending?: () => void
}

/**
 * 視窗底部那一條。只負責顯示,不自己訂閱任何東西:數字由 App 從既有的
 * `projects:state` 與 `peer:state` 算好交下來(設計 §4 增量 1)。
 *
 * 沒有資料的欄位整個不畫,不畫 0 也不畫佔位符號:狀態列的用處是「一眼看出有事」,
 * 一排零會讓有事的那個數字混在裡面。空的時候那一條仍然在,否則下面的內容會跳動。
 */
export function StatusBar({ busy, pending, peerPending, cost, onJumpToPending }: StatusBarProps) {
  const pendingLabel = `${String(pending)} 個待批准`
  return (
    <footer className="status-bar">
      {busy > 0 ? <span className="status-item">{String(busy)} 個進行中</span> : null}
      {pending > 0
        ? onJumpToPending === undefined
          ? <span className="status-item status-pending">{pendingLabel}</span>
          : (
            <button type="button" className="status-item status-pending" onClick={onJumpToPending}>
              {pendingLabel}
            </button>
          )
        : null}
      {peerPending > 0 ? <span className="status-item">{String(peerPending)} 則同伴提問</span> : null}
      {cost === undefined ? null : (
        <span className="status-item status-cost">
          {cost.turns === undefined ? '' : `${String(cost.turns)} 輪`}
          {cost.usd === undefined ? '' : ` · US$${cost.usd.toFixed(4)}`}
          {cost.tokens === undefined ? '' : ` · ${cost.tokens.toLocaleString('en-US')} tokens`}
        </span>
      )}
    </footer>
  )
}
```

`src/renderer/components/StatusBar.css`:沿用既有元件的寫法,不新增顏色常數。
`.status-bar` 用 `flex`、`gap: 12px`、上方一條 `1px solid #2a2d24` 的邊、
`min-height` 固定(空的時候高度不變)、字級 `0.85em`、`opacity` 比內文低。
`.status-pending` 用既有批准卡那組顏色的其中一個,`button` 形態要 `background: none; border: 0; color: inherit; font: inherit; cursor: pointer`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/status-bar.test.tsx`
Expected: PASS

- [ ] **Step 5: 掛進 App**

`src/renderer/App.tsx`:

```tsx
import { StatusBar } from './components/StatusBar.js'
import { usePeer } from './hooks/usePeer.js'
```

```tsx
  const peer = usePeer(api)
  /** 三個數字跨全部專案加總:狀態列的用處是不必先切到某個專案才知道有事。 */
  const busy = projects.view.projects.reduce((n, p) => n + p.busyTabIds.length, 0)
  const pending = projects.view.projects.reduce((n, p) => n + p.pendingTabIds.length, 0)
  /** 第一個有待批准的對話;狀態列點下去就跳過去。 */
  const firstPending = projects.view.projects.flatMap(
    (p) => p.pendingTabIds.map((tabId) => ({ projectId: p.id, tabId }))
  )[0]
```

在 `.app` 的最後(`LeftPane` 之後)加:

```tsx
      <StatusBar
        busy={busy}
        pending={pending}
        peerPending={peer.pending.length}
        {...(firstPending === undefined
          ? {}
          : {
              onJumpToPending: () => {
                projects.activate(firstPending.projectId)
                projects.activateTab(firstPending.tabId, firstPending.projectId)
              },
            })}
      />
```

`src/renderer/App.css`:`.app` 已經是 `flex-direction: column` 且 `height: 100%`,
狀態列是最後一個子節點、`flex: 0 0 auto`,不必改 `.app` 本身;
確認 `LeftPane` 那一層是 `flex: 1 1 auto` 且 `min-height: 0`,狀態列才不會被擠出畫面。

- [ ] **Step 6: 補 App 的測試**

`tests/app.test.tsx`(既有檔;沒有就建)加:

```tsx
  it('狀態列跨專案加總進行中與待批准', async () => {
    const fake = createFakeYesChef()
    fake.emitProjects({
      activeId: 'p-1',
      projects: [
        { ...projectView('p-1'), busyTabIds: ['a'], pendingTabIds: [] },
        { ...projectView('p-2'), busyTabIds: ['b'], pendingTabIds: ['c'] },
      ],
    })
    render(<App />)
    await flush()
    const text = document.querySelector('.status-bar')?.textContent ?? ''
    expect(text).toContain('2 個進行中')
    expect(text).toContain('1 個待批准')
  })
```

`createFakeYesChef`、`projectView`、`flush` 沿用 `tests/helpers/fake-yeschef.ts` 與既有測試的寫法;
App 取 api 的方式若是 `window.yeschef`,測試要照既有做法先 stub 它。既有 helper 缺入口就在原
helper 上加,不要另建一套。

- [ ] **Step 7: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/StatusBar.tsx src/renderer/components/StatusBar.css src/renderer/App.tsx src/renderer/App.css tests/status-bar.test.tsx tests/app.test.tsx
git commit -m "feat: 狀態列顯示進行中、待批准與同伴提問"
```

---

### Task 2: 前景對話把花費回報上來

**Files:**
- Modify: `src/renderer/components/ConversationPane.tsx`
- Modify: `src/renderer/components/LeftPane.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/conversation-pane.test.tsx`(加)、`tests/app.test.tsx`(加)

**Interfaces:**
- Consumes:Task 1 的 `ConversationCost`、`StatusBarProps.cost`。
- Produces:
  - `ConversationPaneProps.onCost?: (cost: ConversationCost | undefined) => void`
  - `LeftPaneProps.renderConversation` 多一個參數:`isActive: boolean`

設計上的問題與決定:

花費在 `ConversationPane` 裡面(`useConversation` 的 `view.cost`),而 App 刻意不持有對話狀態
(`App.tsx` 的註解明寫「對話、批准、Recents 的狀態都在 pane 裡,App 不再持有」)。
狀態列要顯示它,只有兩條路:App 自己再訂閱一次事件流並重算(等於複製 fold),
或由 pane 往上回報一次。**選後者**:回報是一個窄介面,重算是一整套邏輯的第二份。

掛載中的 pane 不只一個(切過的分頁都留著),所以只有前景那個 pane 可以回報,
否則背景對話的花費會蓋掉前景的。前景與否由 `LeftPane` 決定,它本來就知道哪個可見。

邊界情況:切到一個還沒有花費的對話時,那個 pane 必須回報 `undefined`,
否則狀態列會留著上一個對話的數字。所以「成為前景」本身就要回報一次。

- [ ] **Step 1: 寫失敗測試**

`tests/conversation-pane.test.tsx` 加:

```tsx
describe('回報花費給狀態列', () => {
  it('是前景時回報花費', async () => {
    const onCost = vi.fn()
    renderPane({ isActive: true, onCost, view: { ended: true, cost: { turns: 2, usd: 0.5 } } })
    await flush()
    expect(onCost).toHaveBeenCalledWith({ turns: 2, usd: 0.5 })
  })

  it('不是前景時不回報', async () => {
    const onCost = vi.fn()
    renderPane({ isActive: false, onCost, view: { ended: true, cost: { turns: 2, usd: 0.5 } } })
    await flush()
    expect(onCost).not.toHaveBeenCalled()
  })

  it('成為前景而自己還沒有花費時回報 undefined,不讓上一個對話的數字留著', async () => {
    const onCost = vi.fn()
    renderPane({ isActive: true, onCost, view: { ended: false } })
    await flush()
    expect(onCost).toHaveBeenCalledWith(undefined)
  })
})
```

`renderPane` 是這個檔既有的 helper;`isActive`、`onCost`、`view` 三個入口沒有就在原 helper 上加。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/conversation-pane.test.tsx`
Expected: FAIL,`onCost` 不是 `ConversationPaneProps` 的欄位

- [ ] **Step 3: 改 ConversationPane**

props 加:

```ts
  /** 這個對話是不是前景。只有前景那個 pane 回報花費(掛載中的 pane 不只一個)。 */
  readonly isActive: boolean
  /** 把花費交給狀態列。成為前景而自己還沒有花費時要回報 undefined。 */
  readonly onCost?: (cost: ConversationCost | undefined) => void
```

```tsx
  const cost = view.ended ? view.cost : undefined
  useEffect(() => {
    if (!isActive) return
    onCost?.(cost)
  }, [isActive, cost, onCost])
```

- [ ] **Step 4: 改 LeftPane 與 App**

`LeftPaneProps.renderConversation` 的簽章加一個 `isActive: boolean`,
由 `LeftPane` 在決定哪個分頁可見的那一處傳下去(它已經知道 `activeTabId`)。

`App.tsx`:

```tsx
  const [cost, setCost] = useState<ConversationCost | undefined>(undefined)
```

```tsx
          renderConversation={(projectId, conversationId, provider, isActive) => (
            <ConversationPane
              api={api}
              projects={projects}
              projectId={projectId}
              conversationId={conversationId}
              provider={provider}
              isActive={isActive}
              onCost={setCost}
            />
          )}
```

狀態列的 `cost` 改成 `{...(cost === undefined ? {} : { cost })}`。

- [ ] **Step 5: 補 App 的測試**

`tests/app.test.tsx` 加一條:切換前景對話之後,狀態列顯示的是新那個對話的花費;
新的對話還沒有花費時,狀態列不再顯示上一個的數字。

- [ ] **Step 6: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npx vitest run`
Expected: 全部 PASS

Run: `npm run test:coverage`
Expected: Stmts ≥ 93、Branch ≥ 86

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/ConversationPane.tsx src/renderer/components/LeftPane.tsx src/renderer/App.tsx tests/conversation-pane.test.tsx tests/app.test.tsx
git commit -m "feat: 前景對話的花費顯示在狀態列"
```

---

## 驗收

單元測試以外,用真的 app 跑這三項。操作方式沿用 RESULTS-15:
`npx electron . --remote-debugging-port=9336 --user-data-dir=<fixture>`。

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 一個對話在跑、另一個對話等批准 | 狀態列同時顯示「1 個進行中」與「1 個待批准」 |
| 2 | 點狀態列的「待批准」 | 切到那個專案與那個對話,而且那張批准卡在畫面上 |
| 3 | 對話結束後不要捲動 | 花費出現在狀態列;切到另一個還沒跑過的對話,狀態列不再顯示上一個的數字 |

## 自我檢查

**規格涵蓋**:設計增量 1 的四個欄位都在 Task 1;「待批准要能點」在 Task 1 的第五步;
「不新增 IPC」由兩個 Task 的檔案清單保證(都沒有動 `src/shared/ipc.ts` 與主行程)。

**沒有佔位**:每個 Step 都有可以直接貼的程式碼或可以直接跑的指令。三處明講「沿用既有 helper」
的地方(`renderPane`、`createFakeYesChef`、`LeftPane` 決定可見分頁的那一處),
是因為那些 helper 的內部形狀要看現場,計畫不猜。

**型別一致**:`ConversationCost` 在 Task 1 定義,Task 2 的 `onCost` 與 App 的 state 用同一個型別;
`renderConversation` 的第四個參數 `isActive: boolean` 在 Task 2 一次加好,LeftPane 與 App 兩邊同時改。
