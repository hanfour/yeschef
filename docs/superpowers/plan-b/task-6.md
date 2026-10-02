### Task 6: 插手監看與摘要（watch.ts）

`watch.ts` 是右窗格「人機共用同一個 WebContents」這件事在程式碼裡唯一負責記帳的模組。它同時做兩件不相關但都要盯著同一批 CDP 事件的事：判斷 `RefTable` 什麼時候該作廢（`DOM.documentUpdated`、主 frame 換頁、使用者敲鍵盤滑鼠），以及把「使用者到底插手了幾次」累計成 `InterventionLog`，讓 `view_snapshot` 能在回傳文字裡老實告訴模型「你上次操作後發生了什麼」。裁決 5 又把三個 CDP 域（`DOM`、`Network`、`Accessibility`）的啟用塞進這個檔案：因為它本來就要訂閱 `Target.attachedToTarget`（cdp.ts 遞迴 re-arm 之後照樣把這個事件廣播出來）才能判斷「這是不是主 frame」，收到新 session 時順手補這三個域的啟用，不用另開一個模組重複訂閱同一個事件。`Page`／`Runtime` 已經由 cdp.ts 在 root 啟用過，契約 §9.1 裁決 5 只列了三個域，不是五個，這裡照契約字面只送三個。

最容易讀漏的一段規則是 agent 動作期間（`runAsAgent` 內）對 `input-event` 與 `Page.frameNavigated` 這兩種訊號的處理**不是同一套**。`input-event` 在 agent 期間「一律不計、不失效」：agent 自己用 CDP 的 `Input.dispatchMouseEvent` 觸發點擊時，Electron 照樣會冒出一個 `mouseDown` 的 `input-event`，如果不排除，agent 每點一次自己的按鈕就會被記成一次使用者插手，`view_snapshot` 的摘要會變成雜訊，而且會把自己剛設好的 `RefTable` 立刻打成失效。但 `Page.frameNavigated` 不一樣：agent 呼叫 `view_navigate` 觸發的真實換頁，舊 snapshot 的 ref 真的全部作廢了，這件事跟「是不是 agent 自己導航的」無關，所以失效永遠發生；只有 `navigations` 這個要進插手摘要文字的計數，才在 agent 期間跳過（`agentDepth === 0` 才加一）。這是契約 §9.3 寫的兩條不同規則，不是同一條規則的兩種寫法，實作時分開處理，不能把 `input-event` 的排除邏輯直接套到 `frameNavigated` 上。

第一個失效原因保留、之後的失效不覆蓋，是為了讓模型收到的訊息貼近真實成因：`RefTable` 一旦失效 `entries` 就清空，如果任由後到的事件改寫 `invalidatedBy`，常見情境是頁面自己非同步重繪（`documentUpdated`）先發生，接著使用者又點了一下，原因被覆寫成 `userInput`，模型看到的訊息就會誤導成「使用者插手了」而不是「頁面自己重繪了」。判斷式因此不是「每次都换新表」，而是「entries 還有東西，或者這份表根本還沒失效過」才换。

主 frame 的判準有一處契約字面沒寫死，這裡列成契約疑慮：契約 §9.3 只說「`Page.frameNavigated` 且主 frame」，沒有明講要不要連 `sessionId` 一起看；對照的 `settle.ts`（契約 §9.2）規則只看 `frame.parentId`，不提 session。CDP 的 frame 樹是「每個 target 各自一份」，OOPIF 自己那個 session 裡的頂層 frame，從它自己的角度看 `parentId` 一樣是 `undefined`；若只看 `parentId`，使用者在跨站 iframe（例如 SSO 登入框）裡點連結換頁，會被誤記成整個右窗格換頁。這裡的實作要求 `sessionId === undefined`（root session）**且** `frame.parentId === undefined` 才算主 frame，兩個條件缺一不可，測試把「OOPIF 自身 session、無 parentId」與「子 frame、有 parentId」分開驗證。

**Files:**
- Create `src/main/view-tools/watch.ts`
- Test: `tests/view-tools/watch.test.ts`

**Interfaces:**

Consumes：
- Task 1（`src/main/cdp.ts`）的 `CdpSession`，只用 `onEvent`／`send`／`getAttachedTargets`（`Pick<CdpSession, 'onEvent' | 'send' | 'getAttachedTargets'>`），簽章照契約 §4：
```ts
export type CdpEventListener = (method: string, params: unknown, sessionId?: string) => void
export type Unsubscribe = () => void
export interface AttachedTargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  readonly sessionId: string
}
export interface CdpSession {
  send<T>(method: string, params?: object, sessionId?: string): Promise<T>
  detach(): void
  getAttachedTargets(): readonly AttachedTargetInfo[]
  getRearmErrors(): readonly CdpError[]
  onEvent(listener: CdpEventListener): Unsubscribe
}
```
- Task 0（`src/main/view-tools/types.ts`）的 `InvalidationReason`、`RefEntry`、`RefTable`、`InterventionLog`，簽章照契約 §5。
- Task 2（`src/main/view-tools/refs.ts`）的 `EMPTY_REFS`、`invalidateRefs`：
```ts
export const EMPTY_REFS: RefTable
export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable
```

Produces（契約 §9.3 全部匯出，簽章逐字照契約）：
```ts
export interface WatchDeps {
  readonly cdp: Pick<CdpSession, 'onEvent' | 'send' | 'getAttachedTargets'>
  readonly webContents: {
    on(event: 'input-event', listener: (event: unknown, input: { readonly type: string }) => void): unknown
    off(event: 'input-event', listener: (event: unknown, input: { readonly type: string }) => void): unknown
    getURL(): string
  }
  readonly logError: (error: Error) => void
}
export interface Watcher {
  refs(): RefTable
  setRefs(table: RefTable): void
  intervention(): InterventionLog
  takeIntervention(): InterventionLog
  runAsAgent<T>(fn: () => Promise<T>): Promise<T>
  dispose(): void
}
export function createWatcher(deps: WatchDeps): Promise<Watcher>
export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null
```

下游：Task 9（`controller.ts` 持有 `watcher: Watcher`，每個工具方法把 CDP 動作包在 `watcher.runAsAgent()` 裡，`snapshot` 方法用 `setRefs`／`takeIntervention`，`click`／`type` 用 `refs()` 給 `lookupRef`）、Task 10（`server.ts` 的 `createViewToolServer` 建構時 `await createWatcher(...)`，`dispose()` 呼叫 `watcher.dispose()`）。

- [ ] **Step 1：寫失敗的測試**

建立 `tests/view-tools/watch.test.ts`（`../helpers/fake-cdp.ts` 的 `createFakeCdp()` 是 Task 1 產出，簽章照契約 §14 第二點；下游 task 執行時它應已存在）：

```ts
import { describe, expect, it, vi } from 'vitest'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import { EMPTY_REFS } from '../../src/main/view-tools/refs.js'
import { createWatcher, summarizeIntervention } from '../../src/main/view-tools/watch.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

type InputListener = (event: unknown, input: { readonly type: string }) => void

type OnOffMock = ReturnType<typeof vi.fn<(event: 'input-event', listener: InputListener) => unknown>>

function createFakeWebContents(initialUrl: string): {
  readonly on: OnOffMock
  readonly off: OnOffMock
  getURL(): string
  setUrl(url: string): void
} {
  let url = initialUrl
  return {
    on: vi.fn(),
    off: vi.fn(),
    getURL: () => url,
    setUrl: (u: string) => {
      url = u
    },
  }
}

function inputListenerOf(wc: { readonly on: OnOffMock }): InputListener {
  const call = wc.on.mock.calls.find((c) => c[0] === 'input-event')
  if (!call) throw new Error('input-event 未註冊')
  return call[1]
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

const entry: RefEntry = { backendNodeId: 101, role: 'button', name: '送出' }

describe('createWatcher：裁決 5 的域啟用', () => {
  it('建立時對 root 與既有 iframe target 各送 DOM／Network／Accessibility 三個 enable，非 iframe target 不送', async () => {
    const cdp = createFakeCdp()
    cdp.setAttachedTargets([
      { targetId: 't1', type: 'iframe', url: 'https://oopif.example/', sessionId: 's1' },
      { targetId: 't2', type: 'page', url: 'about:blank', sessionId: 's2' },
    ])
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })

    const calls = cdp.send.mock.calls
    const rootMethods = calls.filter((c) => c[2] === undefined).map((c) => c[0])
    const s1Methods = calls.filter((c) => c[2] === 's1').map((c) => c[0])
    const s2Methods = calls.filter((c) => c[2] === 's2')

    expect(rootMethods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(s1Methods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(s2Methods).toEqual([])
  })

  it('之後收到 Target.attachedToTarget（iframe）時對新 sessionId 再送三個 enable', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    cdp.send.mockClear()

    cdp.emit('Target.attachedToTarget', {
      sessionId: 's9',
      targetInfo: { targetId: 't9', type: 'iframe', url: 'https://new.example/' },
    })
    await flush()

    const s9Methods = cdp.send.mock.calls.filter((c) => c[2] === 's9').map((c) => c[0])
    expect(s9Methods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
  })

  it('Target.attachedToTarget 但 type 不是 iframe 時不送 enable', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    cdp.send.mockClear()

    cdp.emit('Target.attachedToTarget', {
      sessionId: 's9',
      targetInfo: { targetId: 't9', type: 'page', url: 'https://new.example/' },
    })
    await flush()

    expect(cdp.send.mock.calls.filter((c) => c[2] === 's9')).toEqual([])
  })

  it('enable 失敗記 logError 不丟出，且不中斷其餘 enable', async () => {
    const cdp = createFakeCdp()
    cdp.send.mockImplementation(async (method: unknown) => {
      if (method === 'Network.enable') throw new Error('nope')
      return undefined
    })
    const wc = createFakeWebContents('https://a.example/')
    const logError = vi.fn()

    await expect(createWatcher({ cdp, webContents: wc, logError })).resolves.toBeDefined()

    const rootMethods = cdp.send.mock.calls.filter((c) => c[2] === undefined).map((c) => c[0])
    expect(rootMethods).toEqual(['DOM.enable', 'Network.enable', 'Accessibility.enable'])
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })
})

describe('refs 失效', () => {
  it('DOM.documentUpdated（任一 session）使 refs 失效，原因 documentUpdated', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 3, entries: new Map([['s3-e0', entry]]) })

    cdp.emit('DOM.documentUpdated', {}, 's7')

    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')
    expect(watcher.refs().entries.size).toBe(0)
    expect(watcher.refs().snapshotId).toBe(3)
  })

  it('主 frame（root session、frame.parentId 不存在）的 Page.frameNavigated 使 refs 失效並計入 navigations', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })

    expect(watcher.refs().invalidatedBy).toBe('navigated')
    expect(watcher.intervention().navigations).toBe(1)
  })

  it('子 frame（frame.parentId 有值）的 frameNavigated 不算導航、不使 refs 失效（突變候選）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: 'root-frame-id' } })

    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('OOPIF 自身 session（sessionId 非 undefined、無 parentId）的 frameNavigated 不算主 frame（見回報契約疑慮）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 5, entries: new Map([['s5-e0', entry]]) })

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } }, 's1')

    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('第一個失效原因保留，之後不同來源的失效不覆蓋（突變候選）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    cdp.emit('DOM.documentUpdated', {})
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')

    inputListenerOf(wc)(undefined, { type: 'mouseDown' })
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')

    cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })
    expect(watcher.refs().invalidatedBy).toBe('documentUpdated')
  })
})

describe('使用者輸入（input-event）', () => {
  it('mouseDown 計 clicks 並使 refs 失效（userInput）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    inputListenerOf(wc)(undefined, { type: 'mouseDown' })

    expect(watcher.intervention().clicks).toBe(1)
    expect(watcher.refs().invalidatedBy).toBe('userInput')
  })

  it('keyDown 計 keys 並使 refs 失效（userInput）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })

    inputListenerOf(wc)(undefined, { type: 'keyDown' })

    expect(watcher.intervention().keys).toBe(1)
    expect(watcher.refs().invalidatedBy).toBe('userInput')
  })

  it('其他 type（mouseUp／mouseMove／keyUp／char／mouseWheel）不計、不使 refs 失效', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 2, entries: new Map([['s2-e0', entry]]) })
    const listener = inputListenerOf(wc)

    for (const type of ['mouseUp', 'mouseMove', 'keyUp', 'char', 'mouseWheel']) {
      listener(undefined, { type })
    }

    expect(watcher.intervention()).toEqual({ clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://a.example/' })
    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
  })
})

describe('runAsAgent', () => {
  it('期間的 frameNavigated 仍使 refs 失效，但不計入 navigations（突變候選：期間導航被算成使用者導覽）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 4, entries: new Map([['s4-e0', entry]]) })

    await watcher.runAsAgent(async () => {
      cdp.emit('Page.frameNavigated', { frame: { parentId: undefined } })
      return null
    })

    expect(watcher.refs().invalidatedBy).toBe('navigated')
    expect(watcher.intervention().navigations).toBe(0)
  })

  it('期間的 input-event 不計、不使 refs 失效（agent 自己的 CDP 操作觸發的合成輸入）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    watcher.setRefs({ snapshotId: 4, entries: new Map([['s4-e0', entry]]) })
    const listener = inputListenerOf(wc)

    await watcher.runAsAgent(async () => {
      listener(undefined, { type: 'mouseDown' })
      return null
    })

    expect(watcher.intervention().clicks).toBe(0)
    expect(watcher.refs().invalidatedBy).toBeUndefined()
    expect(watcher.refs().entries.size).toBe(1)
  })

  it('可重入：巢狀呼叫時內層結束不會提前恢復使用者插手偵測（用計數器而非布林）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    await watcher.runAsAgent(async () => {
      await watcher.runAsAgent(async () => {
        listener(undefined, { type: 'mouseDown' })
        return null
      })
      // 內層已經 return，但外層仍在進行中：這裡仍不該被計入
      listener(undefined, { type: 'mouseDown' })
      return null
    })
    expect(watcher.intervention().clicks).toBe(0)

    listener(undefined, { type: 'mouseDown' })
    expect(watcher.intervention().clicks).toBe(1)
  })

  it('fn 丟例外時仍會還原旗標（try/finally），例外原樣往外丟', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    await expect(
      watcher.runAsAgent(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    listener(undefined, { type: 'mouseDown' })
    expect(watcher.intervention().clicks).toBe(1)
  })
})

describe('intervention／takeIntervention', () => {
  it('intervention() 不歸零', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    inputListenerOf(wc)(undefined, { type: 'mouseDown' })

    watcher.intervention()

    expect(watcher.intervention().clicks).toBe(1)
  })

  it('takeIntervention() 回傳目前 log 並歸零，fromUrl 設為目前網址（突變候選：沒歸零）', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)
    listener(undefined, { type: 'mouseDown' })
    listener(undefined, { type: 'keyDown' })
    wc.setUrl('https://b.example/')

    const first = watcher.takeIntervention()
    expect(first).toEqual({ clicks: 1, keys: 1, navigations: 0, fromUrl: 'https://a.example/' })

    const second = watcher.takeIntervention()
    expect(second).toEqual({ clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://b.example/' })
  })
})

describe('setRefs／refs', () => {
  it('初始為 EMPTY_REFS；setRefs 直接替換整份表', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })

    expect(watcher.refs()).toBe(EMPTY_REFS)

    const table: RefTable = { snapshotId: 9, entries: new Map([['s9-e0', entry]]) }
    watcher.setRefs(table)
    expect(watcher.refs()).toBe(table)
  })
})

describe('dispose', () => {
  it('解除 cdp.onEvent 訂閱與 webContents 的 input-event 監聽', async () => {
    const cdp = createFakeCdp()
    const wc = createFakeWebContents('https://a.example/')
    const watcher = await createWatcher({ cdp, webContents: wc, logError: vi.fn() })
    const listener = inputListenerOf(wc)

    watcher.dispose()

    expect(wc.off).toHaveBeenCalledWith('input-event', listener)

    watcher.setRefs({ snapshotId: 1, entries: new Map([['s1-e0', entry]]) })
    cdp.emit('DOM.documentUpdated', {})
    expect(watcher.refs().invalidatedBy).toBeUndefined()
  })
})

describe('summarizeIntervention', () => {
  it('三個計數都是 0 時回 null', () => {
    const log = { clicks: 0, keys: 0, navigations: 0, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBeNull()
  })

  it('網址改變時用「網址從 A 變成 B」', () => {
    const log = { clicks: 3, keys: 12, navigations: 1, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://b.example/')).toBe(
      '使用者在你上次操作後點了 3 次、按了 12 個鍵，網址從 https://a.example/ 變成 https://b.example/'
    )
  })

  it('網址相同但 navigations > 0 時用「網址仍是」', () => {
    const log = { clicks: 1, keys: 0, navigations: 2, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBe(
      '使用者在你上次操作後點了 1 次、按了 0 個鍵，網址仍是 https://a.example/'
    )
  })

  it('navigations 為 0 且網址相同時省略網址段', () => {
    const log = { clicks: 2, keys: 5, navigations: 0, fromUrl: 'https://a.example/' }
    expect(summarizeIntervention(log, 'https://a.example/')).toBe('使用者在你上次操作後點了 2 次、按了 5 個鍵')
  })
})
```

- [ ] **Step 2：跑測試確認失敗**

```bash
npx vitest run tests/view-tools/watch.test.ts
```

預期：找不到 `src/main/view-tools/watch.ts`（模組不存在），測試檔本身載入失敗，全部 24 個案例顯示為錯誤（`Error: Cannot find module '../../src/main/view-tools/watch.js'` 或等價的解析錯誤）。

- [ ] **Step 3：最小實作**

建立 `src/main/view-tools/watch.ts`：

```ts
import type { CdpSession } from '../cdp.js'
import { EMPTY_REFS, invalidateRefs } from './refs.js'
import type { InterventionLog, InvalidationReason, RefTable } from './types.js'

type InputListener = (event: unknown, input: { readonly type: string }) => void

export interface WatchDeps {
  readonly cdp: Pick<CdpSession, 'onEvent' | 'send' | 'getAttachedTargets'>
  readonly webContents: {
    on(event: 'input-event', listener: InputListener): unknown
    off(event: 'input-event', listener: InputListener): unknown
    getURL(): string
  }
  readonly logError: (error: Error) => void
}

export interface Watcher {
  refs(): RefTable
  setRefs(table: RefTable): void
  intervention(): InterventionLog
  takeIntervention(): InterventionLog
  runAsAgent<T>(fn: () => Promise<T>): Promise<T>
  dispose(): void
}

// 裁決 5（docs/superpowers/plan-b/CONTRACT.md）：域的啟用由 watch.ts 做，Page／Runtime 已由 cdp.ts 啟用，
// 這裡只補 DOM／Network／Accessibility 三個。
const ENABLE_METHODS = ['DOM.enable', 'Network.enable', 'Accessibility.enable'] as const

interface FrameNavigatedParams {
  readonly frame?: { readonly parentId?: string }
}
interface AttachedToTargetParams {
  readonly sessionId: string
  readonly targetInfo: { readonly type: string }
}

async function enableDomains(
  cdp: WatchDeps['cdp'],
  sessionId: string | undefined,
  logError: WatchDeps['logError']
): Promise<void> {
  for (const method of ENABLE_METHODS) {
    try {
      await cdp.send(method, {}, sessionId)
    } catch (e) {
      logError(e instanceof Error ? e : new Error(String(e)))
    }
  }
}

export async function createWatcher(deps: WatchDeps): Promise<Watcher> {
  let refsTable: RefTable = EMPTY_REFS
  let log: InterventionLog = { clicks: 0, keys: 0, navigations: 0, fromUrl: deps.webContents.getURL() }
  let agentDepth = 0

  const invalidate = (reason: InvalidationReason): void => {
    // 裁決（契約 §9.3）：entries 還有東西，或者尚未失效過，才換新表；已失效的表保留第一個原因。
    if (refsTable.entries.size > 0 || refsTable.invalidatedBy === undefined) {
      refsTable = invalidateRefs(refsTable, reason)
    }
  }

  const onCdpEvent = (method: string, params: unknown, sessionId?: string): void => {
    if (method === 'DOM.documentUpdated') {
      invalidate('documentUpdated')
      return
    }
    if (method === 'Page.frameNavigated') {
      const p = params as FrameNavigatedParams
      const isMainFrame = sessionId === undefined && p.frame !== undefined && p.frame.parentId === undefined
      if (!isMainFrame) return
      invalidate('navigated')
      if (agentDepth === 0) {
        log = { ...log, navigations: log.navigations + 1 }
      }
      return
    }
    if (method === 'Target.attachedToTarget') {
      const p = params as AttachedToTargetParams
      if (p.targetInfo.type === 'iframe') {
        void enableDomains(deps.cdp, p.sessionId, deps.logError)
      }
    }
  }
  const unsubscribe = deps.cdp.onEvent(onCdpEvent)

  const onInputEvent: InputListener = (_event, input) => {
    // 契約 §9.3：agent 動作期間一律不計、不失效（agent 自己觸發的 CDP 輸入也會冒出這個事件）。
    if (agentDepth > 0) return
    if (input.type === 'mouseDown') {
      log = { ...log, clicks: log.clicks + 1 }
      invalidate('userInput')
    } else if (input.type === 'keyDown') {
      log = { ...log, keys: log.keys + 1 }
      invalidate('userInput')
    }
  }
  deps.webContents.on('input-event', onInputEvent)

  await enableDomains(deps.cdp, undefined, deps.logError)
  for (const target of deps.cdp.getAttachedTargets()) {
    if (target.type === 'iframe') {
      await enableDomains(deps.cdp, target.sessionId, deps.logError)
    }
  }

  return {
    refs: () => refsTable,
    setRefs: (table) => {
      refsTable = table
    },
    intervention: () => log,
    takeIntervention: () => {
      const current = log
      log = { clicks: 0, keys: 0, navigations: 0, fromUrl: deps.webContents.getURL() }
      return current
    },
    runAsAgent: async (fn) => {
      agentDepth += 1
      try {
        return await fn()
      } finally {
        agentDepth -= 1
      }
    },
    dispose: () => {
      unsubscribe()
      deps.webContents.off('input-event', onInputEvent)
    },
  }
}

function urlSegment(log: InterventionLog, currentUrl: string): string | null {
  if (log.fromUrl !== currentUrl) return `網址從 ${log.fromUrl} 變成 ${currentUrl}`
  if (log.navigations === 0) return null
  return `網址仍是 ${currentUrl}`
}

export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null {
  if (log.clicks === 0 && log.keys === 0 && log.navigations === 0) return null
  const base = `使用者在你上次操作後點了 ${log.clicks} 次、按了 ${log.keys} 個鍵`
  const seg = urlSegment(log, currentUrl)
  return seg === null ? base : `${base}，${seg}`
}
```

`watch.ts` 148 行。`invalidate` 的判斷式與 `runAsAgent` 用 `agentDepth`（數字而非布林）是這個 task 的兩個關鍵設計點，都已在前面的段落說明理由；`onCdpEvent` 用單一 if-chain 依序判斷三種 method，不拆成三個各自訂閱的 listener，因為契約要求的是同一個 `cdp.onEvent` 訂閱點收全部事件，拆開沒有好處只會多兩次訂閱開銷。

- [ ] **Step 4：跑測試確認通過**

```bash
npx vitest run tests/view-tools/watch.test.ts
```

已實測（worktree `/tmp/wt-6`，Task 0／1／2 尚未實作，照契約簽章自建最小 stub：`src/main/view-tools/types.ts`、`src/main/view-tools/refs.ts`（`EMPTY_REFS`／`invalidateRefs`／`parseRef`／`formatRef`／`lookupRef`）、`tests/helpers/fake-cdp.ts`，以及在既有 `src/main/cdp.ts` 上疊加 Task 1 的 `onEvent`／`AttachedTargetInfo.sessionId` 兩個新增欄位，讓 `watch.ts` 能照契約字面 `import type { CdpSession } from '../cdp.js'`）：

```
 Test Files  1 passed (1)
      Tests  24 passed (24)
```

`npx tsc --noEmit -p tsconfig.json` 對這四個檔案（`watch.ts`、`watch.test.ts`、stub 的 `types.ts`／`refs.ts`／`fake-cdp.ts`、疊加後的 `cdp.ts`）0 error。

- [ ] **Step 5：突變測試**

四個突變都已在 worktree 實跑（改實作、跑測試看到指定案例變紅、還原、確認回綠）。

**突變 1：第一個失效原因被後來的覆蓋。**
```diff
-  const invalidate = (reason: InvalidationReason): void => {
-    if (refsTable.entries.size > 0 || refsTable.invalidatedBy === undefined) {
-      refsTable = invalidateRefs(refsTable, reason)
-    }
-  }
+  const invalidate = (reason: InvalidationReason): void => {
+    refsTable = invalidateRefs(refsTable, reason)
+  }
```
變紅：`refs 失效 > 第一個失效原因保留，之後不同來源的失效不覆蓋（突變候選）`（`AssertionError: expected 'userInput' to be 'documentUpdated'`）。其餘 23 個通過。還原後重跑 24 個全綠。

**突變 2：runAsAgent 期間的導航被算成使用者導覽。**
```diff
       invalidate('navigated')
-      if (agentDepth === 0) {
-        log = { ...log, navigations: log.navigations + 1 }
-      }
+      log = { ...log, navigations: log.navigations + 1 }
       return
```
變紅：`runAsAgent > 期間的 frameNavigated 仍使 refs 失效，但不計入 navigations（突變候選：期間導航被算成使用者導覽）`（`expected 1 to be +0`）。其餘 23 個通過。還原後重跑 24 個全綠。

**突變 3：子 frame（有 parentId）的 frameNavigated 也算導航。**
```diff
-      const isMainFrame = sessionId === undefined && p.frame !== undefined && p.frame.parentId === undefined
+      const isMainFrame = sessionId === undefined && p.frame !== undefined
```
變紅：`refs 失效 > 子 frame（frame.parentId 有值）的 frameNavigated 不算導航、不使 refs 失效（突變候選）`（`expected 'navigated' to be undefined`）。其餘 23 個通過。還原後重跑 24 個全綠。

**突變 4：takeIntervention 沒歸零。**
```diff
   takeIntervention: () => {
-      const current = log
-      log = { clicks: 0, keys: 0, navigations: 0, fromUrl: deps.webContents.getURL() }
-      return current
+      return log
     },
```
變紅：`intervention／takeIntervention > takeIntervention() 回傳目前 log 並歸零，fromUrl 設為目前網址（突變候選：沒歸零）`（第二次呼叫回傳仍是 `{ clicks: 1, keys: 1, fromUrl: 'https://a.example/' }` 而非歸零後的值）。其餘 23 個通過。還原後重跑 24 個全綠。

四次突變後都確認 `git diff` 回到與 Step 3 相同的內容，且 `npx vitest run tests/view-tools/watch.test.ts` 回到 24 passed。

- [ ] **Step 6：提交**

```bash
git add src/main/view-tools/watch.ts tests/view-tools/watch.test.ts
git commit -m "feat: 新增 watch.ts 插手監看與摘要"
```
<!-- END -->
