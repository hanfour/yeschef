# 主分頁區與瀏覽器分頁(增量 3a)實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** renderer 佔滿整個視窗、決定右窗格瀏覽器擺在哪裡;右側變成有分頁列的主分頁區,可以整個收起。

**Architecture:** 目前主行程用 `splitBounds(…, 0.5)` 把 renderer 與瀏覽器各擺一半。改成 renderer 佔滿視窗,右側畫一個主分頁區,量出分頁內容區的矩形,經新的 IPC 頻道 `layout:browser-bounds` 告訴主行程;主行程乘上縮放倍率擺放瀏覽器,收到 `null` 就 `setVisible(false)`。renderer 還沒回報之前主行程沿用對半切。

**Tech Stack:** Electron `BaseWindow` + `WebContentsView`、React 19、TypeScript strict、vitest

**Spec:** `docs/specs/2026-09-11-shell-regions-design.md` §3 與增量 3a

## Global Constraints

- TypeScript strict,`noUncheckedIndexedAccess` 開著,不可用 `any` 或 `!`。
- 不可就地修改,一律回傳新物件。IPC 進主行程的 payload 一律過 parse 函式,回傳新造的物件。
- 註解用繁體中文,說明為什麼。
- commit 訊息 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 測試不用 jest-dom,斷言用 `not.toBeNull()` 這類既有風格,不新增 `tests/setup.ts`、不改 `vitest.config.ts`。
- 測試門檻:Stmts ≥ 93、Branch ≥ 86。
- 瀏覽器藏起來一律用 `setVisible(false)`,不用寬高給 0。
- 右窗格的 webContents 一律 `setBackgroundThrottling(false)`(量測結果見規格 §3)。
- 新 IPC 頻道名固定為 `layout:browser-bounds`。
- 收起狀態存 `localStorage`,key 固定為 `yeschef.panelCollapsed`。
- 分頁列上的分頁文字固定為 `瀏覽器`;切換按鈕文字固定為 `收起右側` / `展開右側`。

---

### Task 1: 主行程依 renderer 回報的矩形擺放瀏覽器

**Files:**
- Modify: `src/shared/ipc.ts`(加頻道、型別、parse、`YesChefApi` 方法)
- Modify: `src/preload/bridge.ts`(加 `setBrowserBounds`)
- Create: `src/main/browser-placement.ts`
- Modify: `src/main/agent-view.ts`(加 `setBackgroundThrottling(false)`)
- Modify: `src/main/index.ts:196-206`(`applyLayout` 那段)與視窗關閉的收尾
- Modify: `tests/helpers/fake-yeschef.ts`(兩個假 api 都補 `setBrowserBounds`)
- Test: `tests/browser-placement.test.ts`(新增)、`tests/ipc.test.ts`(加)、`tests/preload-bridge.test.ts`(加)

**Interfaces:**
- Produces:
  - `IPC.browserBounds = 'layout:browser-bounds'`
  - `interface RectPayload { readonly x: number; readonly y: number; readonly width: number; readonly height: number }`
  - `interface BrowserBoundsPayload { readonly rect: RectPayload | null }`
  - `parseBrowserBounds(raw: unknown): BrowserBoundsPayload | null`(格式不對回 `null`)
  - `YesChefApi.setBrowserBounds(rect: RectPayload | null): void`
  - `createBrowserPlacement(deps: BrowserPlacementDeps): BrowserPlacement`
- Task 2 會呼叫 `api.setBrowserBounds`,並在測試裡用 fake 記下的呼叫紀錄 `setBrowserBounds:<JSON 或 null>`。

- [ ] **Step 1: 寫失敗測試**

`tests/browser-placement.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createBrowserPlacement, type PlaceableView } from '../src/main/browser-placement.js'

function fakeView() {
  const calls: string[] = []
  const view: PlaceableView = {
    setBounds: (b) => { calls.push(`bounds:${b.x},${b.y},${b.width},${b.height}`) },
    setVisible: (v) => { calls.push(`visible:${String(v)}`) },
  }
  return { view, calls }
}

function setup(zoom = 1, size = { width: 1600, height: 900 }) {
  const { view, calls } = fakeView()
  let z = zoom
  let s = size
  const placement = createBrowserPlacement({ view, zoomFactor: () => z, contentSize: () => s })
  return {
    placement, calls,
    setZoom: (next: number) => { z = next },
    setSize: (next: { width: number; height: number }) => { s = next },
  }
}

describe('瀏覽器擺放', () => {
  it('renderer 還沒回報前沿用對半切', () => {
    const { placement, calls } = setup()
    placement.relayout()
    expect(calls).toEqual(['visible:true', 'bounds:800,0,800,900'])
  })

  it('照回報的矩形擺,乘上縮放倍率並取整數', () => {
    const { placement, calls } = setup(1.25)
    // y: 30 × 1.25 = 37.5,取整數是 38
    placement.report({ x: 640, y: 30, width: 640, height: 600 })
    expect(calls).toEqual(['visible:true', 'bounds:800,38,800,750'])
  })

  it('回報 null 就藏起來,之後視窗改大小也不會跑出來', () => {
    const { placement, calls, setSize } = setup()
    placement.report(null)
    setSize({ width: 1200, height: 800 })
    placement.relayout()
    expect(calls).toEqual(['visible:false'])
  })

  it('超出視窗的部分切掉,切完沒有面積就藏起來', () => {
    const { placement, calls } = setup(1, { width: 1000, height: 800 })
    placement.report({ x: 900, y: 0, width: 400, height: 900 })
    expect(calls).toEqual(['visible:true', 'bounds:900,0,100,800'])
    placement.report({ x: 1200, y: 0, width: 400, height: 900 })
    expect(calls.at(-1)).toBe('visible:false')
  })

  it('視窗改大小時用新的尺寸重新切一次', () => {
    const { placement, calls, setSize } = setup(1, { width: 1600, height: 900 })
    placement.report({ x: 800, y: 0, width: 800, height: 900 })
    setSize({ width: 1000, height: 900 })
    placement.relayout()
    expect(calls.at(-1)).toBe('bounds:800,0,200,900')
  })
})
```

`tests/ipc.test.ts` 加(沿用檔案裡既有 parse 測試的寫法與 import):

```ts
describe('parseBrowserBounds', () => {
  it('矩形與 null 都收', () => {
    expect(parseBrowserBounds({ rect: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ rect: { x: 1, y: 2, width: 3, height: 4 } })
    expect(parseBrowserBounds({ rect: null })).toEqual({ rect: null })
  })

  it('多出來的欄位切掉', () => {
    expect(parseBrowserBounds({ rect: { x: 1, y: 2, width: 3, height: 4, z: 9 }, extra: 1 })).toEqual({ rect: { x: 1, y: 2, width: 3, height: 4 } })
  })

  it('負數、NaN、Infinity、缺欄位、不是物件都不收', () => {
    expect(parseBrowserBounds({ rect: { x: -1, y: 0, width: 1, height: 1 } })).toBeNull()
    expect(parseBrowserBounds({ rect: { x: 0, y: 0, width: Number.NaN, height: 1 } })).toBeNull()
    expect(parseBrowserBounds({ rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 } })).toBeNull()
    expect(parseBrowserBounds({ rect: { x: 0, y: 0, width: 1 } })).toBeNull()
    expect(parseBrowserBounds({})).toBeNull()
    expect(parseBrowserBounds('x')).toBeNull()
  })
})
```

`tests/preload-bridge.test.ts` 加一條,沿用檔案裡 `cancelPeer` 那條的寫法:
`api.setBrowserBounds({ x: 1, y: 2, width: 3, height: 4 })` 送出 `layout:browser-bounds`、payload 是
`{ rect: { x: 1, y: 2, width: 3, height: 4 } }`;`api.setBrowserBounds(null)` 的 payload 是 `{ rect: null }`;
兩者回傳值都是 `undefined`(檔頭說明的鐵律)。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/browser-placement.test.ts tests/ipc.test.ts tests/preload-bridge.test.ts`
Expected: FAIL,找不到 `browser-placement` 模組與 `parseBrowserBounds`

- [ ] **Step 3: shared 與 preload**

`src/shared/ipc.ts` 的 `IPC` 物件最後加:

```ts
  /** renderer → main:主分頁區瀏覽器分頁的內容矩形(CSS px);null 表示藏起來 */
  browserBounds: 'layout:browser-bounds',
```

型別與 parse(放在其他 parse 函式旁邊):

```ts
export interface RectPayload {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserBoundsPayload {
  readonly rect: RectPayload | null
}

function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function parseBrowserBounds(raw: unknown): BrowserBoundsPayload | null {
  if (!isRecord(raw) || !('rect' in raw)) return null
  const rect = raw['rect']
  if (rect === null) return { rect: null }
  if (!isRecord(rect)) return null
  const { x, y, width, height } = rect
  if (!isNonNegativeFinite(x) || !isNonNegativeFinite(y) || !isNonNegativeFinite(width) || !isNonNegativeFinite(height)) return null
  return { rect: { x, y, width, height } }
}
```

`YesChefApi` 加:

```ts
  /** 主分頁區瀏覽器分頁的內容矩形;null 表示收起或切到別的分頁,主行程會把瀏覽器藏起來。 */
  setBrowserBounds(rect: RectPayload | null): void
```

`src/preload/bridge.ts` 加(逐欄重組,跟 `openTab` 同一個理由):

```ts
  setBrowserBounds: (rect) => {
    const clean: BrowserBoundsPayload =
      rect === null ? { rect: null } : { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    ipcRenderer.send(IPC.browserBounds, clean)
  },
```

`tests/helpers/fake-yeschef.ts` 兩個假 api 都補:

```ts
    setBrowserBounds: (rect) => { calls.push(`setBrowserBounds:${rect === null ? 'null' : JSON.stringify(rect)}`) },
```

- [ ] **Step 4: browser-placement**

`src/main/browser-placement.ts`:

```ts
import { splitBounds, type Bounds, type Size } from './layout.js'
import type { RectPayload } from '../shared/ipc.js'

/** renderer 還沒回報之前的擺法:跟改版前一樣對半切,不留一塊空白(規格 §3)。 */
const FALLBACK_RATIO = 0.5

export interface PlaceableView {
  setBounds(bounds: Bounds): void
  setVisible(visible: boolean): void
}

export interface BrowserPlacementDeps {
  readonly view: PlaceableView
  /** renderer 的縮放倍率。renderer 回報的是 CSS px,乘上它才是 view 的座標。 */
  zoomFactor(): number
  contentSize(): Size
}

export interface BrowserPlacement {
  /** renderer 回報新的矩形;null 表示藏起來。 */
  report(rect: RectPayload | null): void
  /** 視窗改變大小時呼叫:用新的視窗尺寸重新切一次。 */
  relayout(): void
}

type Placement =
  | { readonly kind: 'unreported' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'placed'; readonly rect: RectPayload }

/** 乘上縮放倍率、取整數,再切掉超出視窗的部分。 */
function toViewBounds(rect: RectPayload, zoom: number, size: Size): Bounds {
  const x = Math.min(Math.round(rect.x * zoom), size.width)
  const y = Math.min(Math.round(rect.y * zoom), size.height)
  const width = Math.max(0, Math.min(Math.round(rect.width * zoom), size.width - x))
  const height = Math.max(0, Math.min(Math.round(rect.height * zoom), size.height - y))
  return { x, y, width, height }
}

export function createBrowserPlacement(deps: BrowserPlacementDeps): BrowserPlacement {
  let placement: Placement = { kind: 'unreported' }

  const show = (bounds: Bounds): void => {
    // 切完沒有面積就當成藏起來:寬高給 0 的 view 仍然留在畫面上(規格 §3)。
    if (bounds.width === 0 || bounds.height === 0) {
      deps.view.setVisible(false)
      return
    }
    deps.view.setVisible(true)
    deps.view.setBounds(bounds)
  }

  const apply = (): void => {
    if (placement.kind === 'hidden') {
      deps.view.setVisible(false)
      return
    }
    if (placement.kind === 'unreported') {
      show(splitBounds(deps.contentSize(), FALLBACK_RATIO).right)
      return
    }
    show(toViewBounds(placement.rect, deps.zoomFactor(), deps.contentSize()))
  }

  return {
    report: (rect) => {
      placement = rect === null ? { kind: 'hidden' } : { kind: 'placed', rect }
      apply()
    },
    // 藏起來的時候視窗改大小不必再碰 view:它已經藏了,再呼叫一次 setVisible(false) 沒有作用。
    relayout: () => {
      if (placement.kind !== 'hidden') apply()
    },
  }
}
```

- [ ] **Step 5: 接到主行程**

`src/main/agent-view.ts` 的 `createAgentView` 裡,建立 view 之後加:

```ts
  // 收起右側時這個 view 會被 setVisible(false)。預設的背景降速會讓頁面計時器降到
  // 十分之一、visibilityState 變 hidden,agent 正在操作的頁面行為會跟看得到時不一樣
  // (2026-09-11 量過兩次,見規格 §3)。
  view.webContents.setBackgroundThrottling(false)
```

`src/main/index.ts`:`applyLayout` 那段換成:

```ts
  const placement = createBrowserPlacement({
    view: agentView,
    zoomFactor: () => conversationView.webContents.getZoomFactor(),
    contentSize: () => {
      const { width, height } = win.getContentBounds()
      return { width, height }
    },
  })
  // renderer 佔滿整個視窗,瀏覽器疊在它上面、擺在 renderer 回報的位置(規格 §3)。
  const applyLayout = (): void => {
    const { width, height } = win.getContentBounds()
    conversationView.setBounds({ x: 0, y: 0, width, height })
    placement.relayout()
  }
  applyLayout()
  win.on('resize', applyLayout)

  const onBrowserBounds = (event: Electron.IpcMainEvent, raw: unknown): void => {
    // 只收左邊 renderer 送的:右窗格沒有 preload,理論上送不過來,但這是視窗層級的擺放,
    // 多一道檢查的成本是零。
    if (event.sender !== conversationView.webContents) return
    const payload = parseBrowserBounds(raw)
    if (payload === null) {
      logError(new Error(`${IPC.browserBounds} 收到格式不對的 payload`))
      return
    }
    placement.report(payload.rect)
  }
  ipcMain.on(IPC.browserBounds, onBrowserBounds)
```

在既有的 `win.on('closed', …)` 裡加 `ipcMain.removeListener(IPC.browserBounds, onBrowserBounds)`。
`splitBounds` 與 `DEFAULT_RATIO` 在 `index.ts` 不再用到的話就把 import 與常數一起刪掉。
`ipcMain`、`IPC`、`parseBrowserBounds`、`createBrowserPlacement` 要補 import。

`index.ts` 沒有單元測試(既有慣例,Electron 主程序靠實機驗收),這一步只要 typecheck 與 build 過。

- [ ] **Step 6: 跑測試確認通過**

Run: `npx vitest run tests/browser-placement.test.ts tests/ipc.test.ts tests/preload-bridge.test.ts`
Expected: PASS

- [ ] **Step 7: 全部跑綠**

Run: `npm run typecheck` → 0 errors
Run: `npx vitest run` → 全部 PASS
Run: `npm run test:coverage` → Stmts ≥ 93、Branch ≥ 86
Run: `npm run build` → 成功

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/preload/bridge.ts src/main/browser-placement.ts src/main/agent-view.ts src/main/index.ts tests/helpers/fake-yeschef.ts tests/browser-placement.test.ts tests/ipc.test.ts tests/preload-bridge.test.ts
git commit -m "feat: 主行程依 renderer 回報的矩形擺放瀏覽器"
```

---

### Task 2: renderer 的主分頁區與收起

**Files:**
- Create: `src/renderer/hooks/useReportBounds.ts`
- Create: `src/renderer/hooks/usePanelCollapsed.ts`
- Create: `src/renderer/components/PanelGroup.tsx`
- Create: `src/renderer/components/PanelGroup.css`
- Modify: `src/renderer/App.tsx`(外框改成左右兩欄)
- Modify: `src/renderer/App.css`(`.workbench`、`.main-column`、標題列的按鈕)
- Modify: `tests/app-title-bar.test.tsx`(`titleBarText` 改讀 `.title-text`)
- Test: `tests/panel-group.test.tsx`(新增)、`tests/app.test.tsx`(加)

**Interfaces:**
- Consumes:Task 1 的 `YesChefApi.setBrowserBounds(rect: RectPayload | null): void`、`RectPayload`,
  以及 fake api 的呼叫紀錄格式 `setBrowserBounds:<JSON 或 null>`。
- Produces:`PanelGroup`、`useReportBounds`、`usePanelCollapsed`、`PANEL_COLLAPSED_KEY`。

外框從上到下是標題列、專案列、左窗格、狀態列,全部在同一欄。改成:

```
.app(直的)
  .workbench(橫的,佔滿剩下的高度)
    .main-column(直的):標題列、專案列、左窗格
    PanelGroup(直的):分頁列、.panel-body(瀏覽器疊在這一塊上面)
  狀態列(跨整個寬度)
```

- [ ] **Step 1: 寫失敗測試**

`tests/panel-group.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { PanelGroup } from '../src/renderer/components/PanelGroup.js'
import type { RectPayload } from '../src/shared/ipc.js'

/** jsdom 沒有 ResizeObserver;記下 callback,測試自己觸發。 */
let observed: (() => void) | undefined
class FakeResizeObserver {
  constructor(cb: () => void) { observed = cb }
  observe(): void {}
  disconnect(): void { observed = undefined }
}

let rect = { x: 800, y: 30, width: 800, height: 840 }
function stubRect(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) }) as DOMRect
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  observed = undefined
  rect = { x: 800, y: 30, width: 800, height: 840 }
})

function setup(collapsed: boolean) {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  stubRect()
  const sent: (RectPayload | null)[] = []
  const api = { setBrowserBounds: (r: RectPayload | null) => { sent.push(r) } }
  const utils = render(<PanelGroup api={api} collapsed={collapsed} />)
  return { sent, ...utils }
}

describe('PanelGroup', () => {
  it('展開時回報內容區的矩形', () => {
    const { sent, container } = setup(false)
    expect(sent).toEqual([{ x: 800, y: 30, width: 800, height: 840 }])
    expect(container.querySelector('[role="tab"]')?.textContent).toBe('瀏覽器')
  })

  it('收起時回報 null,整個區塊藏起來', () => {
    const { sent, container } = setup(true)
    expect(sent).toEqual([null])
    expect(container.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(true)
  })

  it('大小沒變就不重送,變了才送', () => {
    const { sent } = setup(false)
    act(() => { observed?.() })
    expect(sent).toHaveLength(1)
    rect = { x: 700, y: 30, width: 900, height: 840 }
    act(() => { observed?.() })
    expect(sent).toEqual([{ x: 800, y: 30, width: 800, height: 840 }, { x: 700, y: 30, width: 900, height: 840 }])
  })

  it('視窗改大小也會重新量', () => {
    const { sent } = setup(false)
    rect = { x: 600, y: 30, width: 600, height: 700 }
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(sent.at(-1)).toEqual({ x: 600, y: 30, width: 600, height: 700 })
  })

  it('從展開切到收起送 null,再展開送回矩形', () => {
    const { sent, rerender } = setup(false)
    const api = { setBrowserBounds: (r: RectPayload | null) => { sent.push(r) } }
    rerender(<PanelGroup api={api} collapsed={true} />)
    expect(sent.at(-1)).toBeNull()
    rerender(<PanelGroup api={api} collapsed={false} />)
    expect(sent.at(-1)).toEqual({ x: 800, y: 30, width: 800, height: 840 })
  })

  it('卸載時送 null,瀏覽器不會留在畫面上', () => {
    const { sent, unmount } = setup(false)
    unmount()
    expect(sent.at(-1)).toBeNull()
  })
})
```

`tests/app.test.tsx` 加(沿用檔案裡既有的 `createFakeYesChef`、`flush` 寫法):

```tsx
describe('右側收起', () => {
  afterEach(() => { localStorage.clear() })

  it('按標題列的按鈕收起,文字換成展開,狀態記在 localStorage', async () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '收起右側' }))
    expect(screen.getByRole('button', { name: '展開右側' })).not.toBeNull()
    expect(document.querySelector('.panel-group')?.hasAttribute('hidden')).toBe(true)
    expect(localStorage.getItem('yeschef.panelCollapsed')).toBe('true')
    expect(fake.calls.at(-1)).toBe('setBrowserBounds:null')
  })

  it('上次收起的話,開起來就是收起的', async () => {
    localStorage.setItem('yeschef.panelCollapsed', 'true')
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    vi.stubGlobal('yeschef', fake.api)
    render(<App />)
    await flush()
    expect(screen.getByRole('button', { name: '展開右側' })).not.toBeNull()
  })
})
```

`ONE_PROJECT` 從 `./helpers/fake-yeschef.js` import;`fireEvent`、`screen` 從 `@testing-library/react`。
jsdom 沒有 `ResizeObserver`,`useReportBounds` 要在它不存在時照常運作(只是不會收到大小變化),
所以 `app.test.tsx` 不必 stub。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/panel-group.test.tsx tests/app.test.tsx`
Expected: FAIL,找不到 `PanelGroup` 模組

- [ ] **Step 3: 兩個 hook**

`src/renderer/hooks/useReportBounds.ts`:

```ts
import { useEffect, useRef, type RefObject } from 'react'
import type { RectPayload } from '../../shared/ipc.js'

function measure(el: HTMLElement): RectPayload {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}

function sameRect(a: RectPayload | null | undefined, b: RectPayload | null): boolean {
  if (a === undefined) return false
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * 把一個元素的矩形回報給主行程,主行程把瀏覽器疊在那個位置上(規格 §3)。
 * `active` 為 false 時回報 null,主行程會把瀏覽器藏起來。
 * 同樣的值不重送:ResizeObserver 與視窗 resize 常常一起觸發。
 */
export function useReportBounds(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  send: (rect: RectPayload | null) => void
): void {
  const last = useRef<RectPayload | null | undefined>(undefined)

  useEffect(() => {
    const report = (next: RectPayload | null): void => {
      if (sameRect(last.current, next)) return
      last.current = next
      send(next)
    }
    const el = ref.current
    if (!active || el === null) {
      report(null)
      return
    }
    const update = (): void => { report(measure(el)) }
    update()
    // jsdom 與很舊的環境沒有 ResizeObserver;沒有就只靠視窗 resize。
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [ref, active, send])

  // 卸載時藏起來:不然瀏覽器會留在一塊已經不存在的區域上。
  useEffect(() => () => { send(null) }, [send])
}
```

`src/renderer/hooks/usePanelCollapsed.ts`:

```ts
import { useCallback, useState } from 'react'

export const PANEL_COLLAPSED_KEY = 'yeschef.panelCollapsed'

/** localStorage 在某些情況會丟例外,讀不到就當成展開。 */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(PANEL_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/** 整個視窗只有一個主分頁區,所以這裡用 React state 沒有多份過期的問題(對照 useSidebarWidth)。 */
export function usePanelCollapsed(): { readonly collapsed: boolean; readonly toggle: () => void } {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = useCallback((): void => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(PANEL_COLLAPSED_KEY, String(next))
      } catch {
        // 存不進去只是下次開回到展開,不值得打斷使用者。
      }
      return next
    })
  }, [])
  return { collapsed, toggle }
}
```

- [ ] **Step 4: PanelGroup**

`src/renderer/components/PanelGroup.tsx`:

```tsx
import { useRef } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import { useReportBounds } from '../hooks/useReportBounds.js'
import './PanelGroup.css'

export interface PanelGroupProps {
  readonly api: Pick<YesChefApi, 'setBrowserBounds'>
  readonly collapsed: boolean
}

/**
 * 右側的主分頁區(規格增量 3a)。目前只有瀏覽器一個分頁;3b 會加預覽。
 * 瀏覽器本身是主行程的原生 view,不在這棵 DOM 裡,這裡只負責量出 `.panel-body`
 * 的位置交給主行程,讓它疊上來。
 */
export function PanelGroup({ api, collapsed }: PanelGroupProps): React.ReactElement {
  const body = useRef<HTMLDivElement>(null)
  useReportBounds(body, !collapsed, api.setBrowserBounds)
  return (
    <section className="panel-group" hidden={collapsed}>
      <div className="panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={true} className="panel-tab is-active">瀏覽器</button>
      </div>
      <div className="panel-body" ref={body} />
    </section>
  )
}
```

`api.setBrowserBounds` 從 `window.yeschef` 來,參考是穩定的;
但如果 App 傳的是每次 render 都新造的函式,`useReportBounds` 的 effect 會每次重跑。
App 直接傳 `api` 物件本身,不要包一層。

`src/renderer/components/PanelGroup.css`:

```css
.panel-group { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; border-left: 1px solid #2a2d24; }
/* 自己的 display: flex 會蓋掉瀏覽器預設的 [hidden] { display: none },要明講。 */
.panel-group[hidden] { display: none; }
.panel-tabs { display: flex; flex: 0 0 auto; gap: 2px; padding: 4px 8px 0; border-bottom: 1px solid #2a2d24; }
.panel-tab { padding: 4px 10px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; opacity: 0.6; }
.panel-tab.is-active { opacity: 1; border-bottom: 2px solid #c9b458; }
/* 瀏覽器疊在這一塊上面,這裡本身不畫任何東西。 */
.panel-body { flex: 1 1 auto; min-height: 0; }
```

- [ ] **Step 5: 接到 App**

`src/renderer/App.tsx` 的 return 改成:

```tsx
    <div className="app">
      <div className="workbench">
        <div className="main-column">
          <header className="title-bar">
            <span className="title-text">{titleFor(projects.active)}</span>
            <button type="button" className="panel-toggle" aria-pressed={!panel.collapsed} onClick={panel.toggle}>
              {panel.collapsed ? '展開右側' : '收起右側'}
            </button>
          </header>
          <ProjectBar projects={projects} />
          {/* 既有的 LeftPane 區塊原封不動搬進來 */}
        </div>
        <PanelGroup api={api} collapsed={panel.collapsed} />
      </div>
      {/* 既有的 StatusBar 原封不動 */}
    </div>
```

`const panel = usePanelCollapsed()` 放在其他 hook 旁邊。

`src/renderer/App.css`:

```css
.workbench { display: flex; flex: 1 1 auto; min-height: 0; }
.main-column { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; }
.title-bar { display: flex; align-items: center; gap: 8px; }
.title-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.panel-toggle { flex: 0 0 auto; padding: 2px 8px; border: 1px solid #3a3f36; background: none; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
```

既有的 `.title-bar` 規則裡 `white-space`、`overflow`、`text-overflow` 三條保留;
加上 `display: flex` 之後省略號要靠 `.title-text` 那條才會出現。
`.app > .status-bar { margin-top: auto; }` 保留,狀態列仍然是 `.app` 的直接子節點。

`tests/app-title-bar.test.tsx` 的 `titleBarText` 改讀 `.title-text`,
因為標題列裡多了一顆按鈕,`.title-bar` 的 `textContent` 會把按鈕文字也算進去。
其他斷言不動。

- [ ] **Step 6: 跑測試確認通過**

Run: `npx vitest run tests/panel-group.test.tsx tests/app.test.tsx tests/app-title-bar.test.tsx`
Expected: PASS

- [ ] **Step 7: 全部跑綠**

Run: `npm run typecheck` → 0 errors
Run: `npx vitest run` → 全部 PASS
Run: `npm run test:coverage` → Stmts ≥ 93、Branch ≥ 86
Run: `npm run build` → 成功

- [ ] **Step 8: Commit**

```bash
git add src/renderer/hooks/useReportBounds.ts src/renderer/hooks/usePanelCollapsed.ts src/renderer/components/PanelGroup.tsx src/renderer/components/PanelGroup.css src/renderer/App.tsx src/renderer/App.css tests/panel-group.test.tsx tests/app.test.tsx tests/app-title-bar.test.tsx
git commit -m "feat: 右側改成主分頁區,可以整個收起"
```

---

## 驗收

單元測試碰不到主行程的 `index.ts` 與真實的原生 view 疊放,這一段要用真的 app 跑。

啟動時多開主行程的 inspector:`npx electron . --inspect=9229 --remote-debugging-port=9336 --user-data-dir=<fixture>`。
主行程那一側直接讀值,不靠截圖目測:

```js
const { BaseWindow } = require('electron')
const win = BaseWindow.getAllWindows()[0]
const [renderer, browser] = win.contentView.children
({ content: win.getContentBounds(), renderer: renderer.getBounds(), browser: browser.getBounds(), visible: browser.getVisible() })
```

renderer 那一側用 CDP 讀 `.panel-body` 的 `getBoundingClientRect()`。

| # | 做什麼 | 應該看到 |
|---|---|---|
| 1 | 開起來 | renderer 的 bounds 等於整個視窗;瀏覽器的 bounds 等於 `.panel-body` 的矩形,`visible` 為 true |
| 2 | 按「收起右側」 | 瀏覽器 `visible` 為 false;`.main-column` 的寬度等於視窗寬度 |
| 3 | 按「展開右側」 | 瀏覽器 `visible` 回到 true,bounds 回到 `.panel-body` 的矩形 |
| 4 | 從主行程把視窗改成 1200×800 | 瀏覽器 bounds 跟著新的 `.panel-body` 走,兩者相等 |
| 5 | 收起後關掉 app 再開 | 一開起來就是收起的,瀏覽器 `visible` 為 false |
| 6 | 收起狀態下讓 agent 呼叫一次 view 截圖工具 | 截圖拿得到內容(規格 §3 量過,這裡在真 app 裡確認一次) |

## 自我檢查

**規格涵蓋**:§3 的三件配套事項,「CSS 像素換算」在 Task 1 的 `toViewBounds`,
「藏起來用 setVisible 不用 0 寬高」在 Task 1 的 `show`,「還沒量到之前用對半切」在 Task 1 的
`unreported` 狀態。增量 3a 的「分頁列」「整個可以收起」在 Task 2。
增量 3a 的驗收四條對應上表 2、3、4、5。3b 的預覽不在這份計畫。

**沒有佔位**:每個 Step 都有可以直接貼的程式碼。兩處明講「沿用既有寫法」
(Task 1 的 `preload-bridge.test.ts`、Task 2 的 `app.test.tsx`),是因為那兩個檔案的 mock 形狀
要看現場,計畫不猜。

**型別一致**:`RectPayload` 只在 `src/shared/ipc.ts` 定義一次,Task 1 的 preload、主行程,
Task 2 的 hook 與測試都從那裡 import。`setBrowserBounds` 的簽名在 Task 1 定義,Task 2 只呼叫。
fake api 的呼叫紀錄格式 `setBrowserBounds:<JSON 或 null>` 在 Task 1 定義、Task 2 的測試斷言它。
