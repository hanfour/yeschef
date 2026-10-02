### Task 9: 八個工具的實際動作（controller）

controller 是 B 的執行層：server.ts 把 zod 驗過型別的參數交進來，controller 負責語意檢查（ref、網址、按鍵）、送 CDP、等頁面穩定、把結果組成給模型看的一句話。它是唯一同時碰到 `watcher`、`settle`、`handoff`、`snapshot-collect` 四個有狀態元件的地方，所以錯誤翻譯之外的判斷全部集中在這裡，server.ts 只剩下 `tool()` 註冊與 `CallToolResult` 包裝。

契約 §10.2 把八個方法的流程逐格寫死了，這個 task 的自由度只在「怎麼拆檔」與「怎麼讓測試看得見」。八個方法加 `call()` 逾時、offset 重算、輸出組字放同一個檔實測是 480 行，超過契約 §1 的 400 行上限，所以拆成六個檔。切法依「共用什麼」而不是依工具數量平均切：`controller-core.ts` 是八個方法都要的零件（逾時、進門檢查、`runAsAgent` 包裝、snapshot 流水號、ref 查表），`controller-page.ts` 三個方法共用 settle 的等待與網址檢查，`controller-input.ts` 三個方法共用 ref 查表、座標換算與按鍵送出，`controller-eval.ts` 的兩個方法不碰前兩者任何東西。`controller-types.ts` 單獨存在是為了避免循環匯入：`controller.ts` 匯入三個子模組，子模組又要用 `ControllerDeps`／`ToolOutput`，型別放在最下游的葉節點才不會繞回來。對外匯出仍然只有契約 §10.2 列的那幾個名字，全部從 `controller.ts` 轉出。

三個設計決定值得先講。第一，`call()` 的逾時（裁決 14）用注入的 `MergerClock` 而不是 `setTimeout`，先到的一方用 `settled` 旗標定案：CDP 慢一步回來時不會覆寫已經丟出的逾時，成功之後逾時計時器也已經被清掉。少了這個包裝，Electron 的 `debugger.sendCommand` 在 renderer 掛住時會永遠不 resolve，整個工具呼叫連同左窗格的那一輪對話一起卡死。第二，裁決 9 的 offset 每次點擊重算而不是存進 `RefEntry`：iframe 在主視窗裡的位置會因為捲動而變，存下來的座標在 snapshot 之後就過期了。第三，`requestHandoff` 是八個方法裡唯一不包在 `watcher.runAsAgent()` 內的：等待期間使用者的點擊與按鍵正是這個工具在等的事，要照常計入插手記錄，下一次 `view_snapshot` 才會告訴模型使用者做了什麼。

實機事實兩則：`docs/RESULTS-02-input-focus.md` 量到 CDP 的 `Input.*` 在右窗格沒有焦點、甚至整個視窗失焦時三種狀態各 200/200 全部成功，所以 `click`／`type`／`press` 不需要搶焦點也不需要遮罩。`docs/RESULTS-03-oopif.md` 量到 `Target.getTargets()` 回的是整個 browser context 的清單（會混進其他分頁與上一站殘留的 target），所以裁決 7 的父 target 一定要用 `targetId` 精確比對，不能拿清單順序當結構；同一份文件也記錄了 OOPIF 巢狀到第二層（`accounts.google.com/gsi/button` 這種 SSO 登入框）是真實情況，所以 offset 必須遞迴相加，測試也照這個形狀寫成兩層。

**Files:**

- Create `src/main/view-tools/controller-types.ts`：契約 §10.2 的公開型別（`ControllerDeps`、`ToolText`／`ToolImage`／`ToolOutput`、`ViewController`）與三個數值常數。只有型別與常數，沒有執行期邏輯。
- Create `src/main/view-tools/controller-core.ts`：`createCore(deps)`。逾時包裝的 `call()`、進門檢查 `guard()`、`act()`（進門檢查加 `runAsAgent`）、`collect`（給 snapshot-collect 的 deps，`send` 已換成 `call`）、`nextSnapshotId()`、`resolveEntry()`、`text()`。
- Create `src/main/view-tools/controller-page.ts`：`createPageTools(core)` → `navigate`、`snapshot`、`screenshot`。
- Create `src/main/view-tools/controller-input.ts`：`createInputTools(core)` → `click`、`type`、`press`，含 `centerOfQuad()`、`dispatchKey()`、`waitQuiet()`、`pointOf()`。
- Create `src/main/view-tools/controller.ts`：轉出契約 §10.2 的公開名稱，`createViewController(deps)` 把三組方法組成一個 `ViewController`。
- Create `src/main/view-tools/controller-eval.ts`：`createEvalTools(core)` → `evaluate`、`requestHandoff`。
- Test `tests/view-tools/controller-harness.ts`：測試共用的假 webContents、`createHarness()`、`sent()`、`refTable()`、`tick()`／`delay()`。副檔名不是 `.test.ts`，`vitest.config.ts` 的 `include: ['tests/**/*.test.{ts,tsx}']` 不會把它當測試檔收走。
- Test `tests/view-tools/controller.test.ts`：`navigate`、`snapshot`、`screenshot`、`evaluate`、`requestHandoff`。
- Test `tests/view-tools/controller-input.test.ts`：`click`、`type`、`press`，以及 `call()` 的逾時與錯誤傳遞。

兩個測試檔而不是一個：合成一檔是 641 行，拆開之後各 331 與 310 行，剛好落在契約 §1 的範圍內，切線就是「輸入層級」與「其餘」。

**Interfaces:**

Consumes：

```ts
// Task 0：src/main/view-tools/errors.ts
export class ViewToolError extends Error { readonly name = 'ViewToolError' }
export const MSG: { /* 契約 §10.1 全表 */ }
// Task 0：src/main/view-tools/types.ts
export interface Point { readonly x: number; readonly y: number }
export interface RefEntry { readonly sessionId?: string; readonly backendNodeId: number; readonly role: string; readonly name: string }
// Task 0：tests/helpers/manual-clock.ts
export function manualClock(start?: number): { readonly clock: MergerClock; advance(ms: number): void; now(): number }
// Task 1：src/main/cdp.ts
export class CdpError extends Error { readonly code: string; constructor(message: string, code: string, options?: { cause?: unknown }) }
export function toCdpError(raw: unknown): CdpError
export interface CdpSession { send<T>(method: string, params?: object, sessionId?: string): Promise<T>; /* … */ }
// Task 1：tests/helpers/fake-cdp.ts
export function createFakeCdp(): FakeCdp   // onSend(method, responder, sessionId?)、emit、setAttachedTargets、setRearmErrors
// Task 2：src/main/view-tools/refs.ts
export function lookupRef(table: RefTable, ref: string): RefLookup
export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable
// Task 3：src/main/view-tools/keys.ts、urls.ts
export function lookupKey(name: string): KeyDef | null
export const KEY_NAMES: readonly string[]
export function checkNavigateUrl(raw: string, projectDir: string): UrlCheck
// Task 4：src/main/view-tools/snapshot.ts
export function buildSnapshot(input: SnapshotInput): SnapshotResult
export function formatSnapshotText(snapshot: Snapshot, intervention?: string | null): string   // 裁決 22
// Task 5：src/main/view-tools/snapshot-collect.ts
export interface CollectDeps { readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>; readonly currentUrl: () => string; readonly currentTitle: () => string; readonly now: () => number; readonly logError: (error: Error) => void }
export function collectSnapshotInput(deps: CollectDeps, id: number, scope: 'viewport' | 'full'): Promise<SnapshotInput>
/** 第三參數 cache 選填（裁決 26），controller 只傳前兩個。 */
export function resolveFrameOffset(deps: CollectDeps, sessionId: string | undefined, cache?: Map<string, Point>): Promise<Point>
// Task 6：src/main/view-tools/watch.ts
export interface Watcher { refs(): RefTable; setRefs(table: RefTable): void; intervention(): InterventionLog; takeIntervention(): InterventionLog; runAsAgent<T>(fn: () => Promise<T>): Promise<T>; dispose(): void }
export function summarizeIntervention(log: InterventionLog, currentUrl: string): string | null
// Task 7：src/main/view-tools/handoff.ts
export interface Handoff { pending(): HandoffPending | null; begin(toolUseId: string, reason: string, signal?: AbortSignal): Promise<HandoffWaitResult>; done(toolUseId: string): void; abortAll(): void }
export const HANDOFF_TIMEOUT_MS: number
// Task 8：src/main/view-tools/settle.ts
export const SETTLE_QUIET_MS: number; export const SETTLE_TIMEOUT_MS: number; export const NAVIGATE_TIMEOUT_MS: number
export interface SettleTracker { inflight(): number; waitForQuiet(opts: SettleWaitOptions): Promise<SettleOutcome>; waitForLoad(opts: SettleWaitOptions): Promise<SettleOutcome>; dispose(): void }
```

Produces（Task 10 的 server.ts 會用，全部從 `src/main/view-tools/controller.ts` 匯出）：

```ts
export const CDP_CALL_TIMEOUT_MS = 10_000
export const EVAL_MAX_CHARS = 8_192
export const SCREENSHOT_MAX_WIDTH = 1_280
export interface ControllerDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly webContents: { isDestroyed(): boolean; getURL(): string; getTitle(): string }
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
}
export interface ToolText { readonly kind: 'text'; readonly text: string }
export interface ToolImage { readonly kind: 'image'; readonly text: string; readonly dataBase64: string; readonly mimeType: 'image/png' }
export type ToolOutput = ToolText | ToolImage
export interface ViewController {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, text: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
}
export function createViewController(deps: ControllerDeps): ViewController
```

- [ ] **Step 1a: 寫測試共用的 harness（`tests/view-tools/controller-harness.ts` 完整內容）**

`watcher`／`settle`／`handoff` 全部用上游真實作，不 mock：controller 對它們的用法（`runAsAgent` 的巢狀、`waitForQuiet` 的 500ms 靜默視窗、`begin` 的單一 pending）如果換成假物件，測到的就只是「有沒有呼叫」，不是「行為對不對」。假的只有兩個：`CdpSession` 用 Task 1 的 `createFakeCdp()`，`webContents` 用最小假物件。時間全部走 `manualClock`，所以逾時測試不必真的等 10 秒。

```ts
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { createFakeCdp, type FakeCdp } from '../helpers/fake-cdp.js'
import { manualClock } from '../helpers/manual-clock.js'
import { createViewController } from '../../src/main/view-tools/controller.js'
import type { ViewController } from '../../src/main/view-tools/controller.js'
import { createHandoff, type Handoff } from '../../src/main/view-tools/handoff.js'
import { createSettleTracker, type SettleTracker } from '../../src/main/view-tools/settle.js'
import { createWatcher, type Watcher } from '../../src/main/view-tools/watch.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

/** 真計時器：把 microtask 與一輪 macrotask 都排空，讓 await 鏈走到下一個等待點。 */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type InputListener = (event: unknown, input: { readonly type: string }) => void

export interface FakeWebContents {
  on(event: 'input-event', listener: InputListener): unknown
  off(event: 'input-event', listener: InputListener): unknown
  isDestroyed(): boolean
  getURL(): string
  getTitle(): string
  setUrl(url: string): void
  setTitle(title: string): void
  destroy(): void
  /** 模擬使用者實際操作右窗格（Electron 的 input-event）。 */
  userInput(type: string): void
}

export function createFakeWebContents(url = 'https://example.test/'): FakeWebContents {
  let currentUrl = url
  let title = '起始頁'
  let destroyed = false
  const listeners = new Set<InputListener>()
  return {
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    isDestroyed: () => destroyed,
    getURL: () => currentUrl,
    getTitle: () => title,
    setUrl: (next) => {
      currentUrl = next
    },
    setTitle: (next) => {
      title = next
    },
    destroy: () => {
      destroyed = true
    },
    userInput: (type) => {
      for (const listener of [...listeners]) listener({}, { type })
    },
  }
}

export interface Harness {
  readonly cdp: FakeCdp
  readonly wc: FakeWebContents
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly controller: ViewController
  readonly logError: Mock
  readonly signal: AbortSignal
  readonly aborter: AbortController
  advance(ms: number): void
  now(): number
}

/** 已送出的 CDP 指令，依 method 過濾。 */
export function sent(cdp: FakeCdp, method: string): { params: unknown; sessionId: string | undefined }[] {
  return (cdp.send as unknown as Mock).mock.calls
    .filter((call) => call[0] === method)
    .map((call) => ({ params: call[1] as unknown, sessionId: call[2] as string | undefined }))
}

export function refTable(snapshotId: number, entries: readonly (readonly [string, RefEntry])[]): RefTable {
  return { snapshotId, entries: new Map(entries) }
}

/**
 * watcher／settle／handoff 一律用上游真實作，只有 CdpSession 與 webContents 是假的。
 * 時間全部走 manualClock，所以逾時測試不需要真的等。
 */
export async function createHarness(projectDir = '/tmp/yeschef-proj'): Promise<Harness> {
  const cdp = createFakeCdp()
  const clockKit = manualClock(1_000)
  const wc = createFakeWebContents()
  const logError = vi.fn()

  // createWatcher 建構時做裁決 5 的三個 enable。
  for (const method of ['DOM.enable', 'Network.enable', 'Accessibility.enable']) {
    cdp.onSend(method, () => ({}))
  }

  const watcher = await createWatcher({ cdp, webContents: wc, logError })
  const settle = createSettleTracker(cdp, clockKit.clock)
  const handoff = createHandoff(clockKit.clock, logError)
  const aborter = new AbortController()
  const controller = createViewController({
    cdp,
    webContents: wc,
    watcher,
    settle,
    handoff,
    clock: clockKit.clock,
    projectDir,
    logError,
  })

  return {
    cdp,
    wc,
    watcher,
    settle,
    handoff,
    controller,
    logError,
    aborter,
    signal: aborter.signal,
    advance: clockKit.advance,
    now: clockKit.now,
  }
}
```

- [ ] **Step 1b: 寫失敗的測試（`tests/view-tools/controller-input.test.ts`，第一段：`view_click`）**

座標的四組常數是這個檔的關鍵：`ROOT_BORDER` 的中心 `(62, 54)` 與左上角 `(12, 24)` 不同，所以「拿左上角當點擊點」的實作過不了；兩層 offset 各自非零且互不相等（`(100, 200)` 與 `(30, 40)`），所以「只算一層」與「完全不加」兩種錯誤都會被抓到。這是計畫撰寫者須知列的 B 特有盲點：offset 為 0 時加不加都對。

貼完第一段先不要跑，第二段接在同一個檔後面。

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { CdpError } from '../../src/main/cdp.js'
import { CDP_CALL_TIMEOUT_MS } from '../../src/main/view-tools/controller.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { KEY_NAMES } from '../../src/main/view-tools/keys.js'
import { invalidateRefs } from '../../src/main/view-tools/refs.js'
import { createHarness, delay, refTable, sent, tick, type Harness } from './controller-harness.js'

/** 主 target 的按鈕：border 四點的中心是 (62, 54)，跟左上角 (12, 24) 不同。 */
const ROOT_BORDER = [12, 24, 112, 24, 112, 84, 12, 84]
/** OOPIF 內的按鈕：中心 (60, 50)。 */
const INNER_BORDER = [10, 20, 110, 20, 110, 80, 10, 80]
/** 外層 iframe 在主視窗裡的位置：左上角 (100, 200)。 */
const OUTER_CONTENT = [100, 200, 300, 200, 300, 400, 100, 400]
/** 內層 iframe 在外層 iframe 座標系裡的位置：左上角 (30, 40)。 */
const INNER_CONTENT = [30, 40, 230, 40, 230, 140, 30, 140]

function quietOk(h: Harness): void {
  h.advance(500)
}

describe('controller：view_click', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, role: 'button', name: '送出' }]]))
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => ({}))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: ROOT_BORDER } }))
    h.cdp.onSend('Input.dispatchMouseEvent', () => ({}))
  })

  it('ref 格式錯回 refFormat，不送任何 CDP 指令', async () => {
    await expect(h.controller.click('t1-e0', h.signal)).rejects.toThrow(MSG.refFormat)
    expect(sent(h.cdp, 'DOM.getBoxModel')).toHaveLength(0)
  })

  it('snapshot 已失效回 refStale，原因照 RefTable 的 invalidatedBy', async () => {
    h.watcher.setRefs(invalidateRefs(h.watcher.refs(), 'userInput'))
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.refStale(1, 'userInput'))
  })

  it('ref 編號不在表裡回 refMissing', async () => {
    await expect(h.controller.click('s1-e7', h.signal)).rejects.toThrow(MSG.refMissing(1, 's1-e7'))
  })

  it('getBoxModel 失敗回 refDetached', async () => {
    h.cdp.onSend('DOM.getBoxModel', () => {
      throw new CdpError('Could not find node', 'nodeNotFound')
    })
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.refDetached('s1-e0'))
  })

  it('主 target 的節點點在 border 中心，mousePressed 與 mouseReleased 各一次', async () => {
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    const out = await promise

    const mouse = sent(h.cdp, 'Input.dispatchMouseEvent')
    expect(mouse).toHaveLength(2)
    expect(mouse[0]).toEqual({
      params: { type: 'mousePressed', x: 62, y: 54, button: 'left', clickCount: 1 },
      sessionId: undefined,
    })
    expect(mouse[1]?.params).toEqual({ type: 'mouseReleased', x: 62, y: 54, button: 'left', clickCount: 1 })
    expect(out).toEqual({ kind: 'text', text: MSG.clicked('button', '送出') })
  })

  it('scrollIntoViewIfNeeded 與 getBoxModel 送到節點所屬的 session', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 9, sessionId: 's-inner', role: 'link', name: '說明' }]]))
    h.cdp.setAttachedTargets([{ targetId: 'T-inner', type: 'iframe', url: 'https://in.test/', sessionId: 's-inner' }])
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')
    h.cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-page' }, { targetId: 'T-inner', parentId: 'T-page' }],
    }))
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 500 }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: OUTER_CONTENT } }))

    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise

    expect(sent(h.cdp, 'DOM.scrollIntoViewIfNeeded')[0]).toEqual({ params: { backendNodeId: 9 }, sessionId: 's-inner' })
    expect(sent(h.cdp, 'DOM.getBoxModel')[0]?.sessionId).toBe('s-inner')
  })

  it('兩層巢狀 OOPIF 的座標加上兩層 offset（裁決 9）', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, sessionId: 's-inner', role: 'button', name: '付款' }]]))
    h.cdp.setAttachedTargets([
      { targetId: 'T-outer', type: 'iframe', url: 'https://outer.test/', sessionId: 's-outer' },
      { targetId: 'T-inner', type: 'iframe', url: 'https://inner.test/', sessionId: 's-inner' },
    ])
    h.cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page' },
        { targetId: 'T-outer', parentId: 'T-page' },
        { targetId: 'T-inner', parentId: 'T-outer' },
      ],
    }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 501 }), 's-outer')
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: INNER_CONTENT } }), 's-outer')
    h.cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 500 }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { content: OUTER_CONTENT } }))

    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise

    // 中心 (60,50) + 內層 (30,40) + 外層 (100,200)
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')[0]?.params).toEqual({
      type: 'mousePressed',
      x: 190,
      y: 290,
      button: 'left',
      clickCount: 1,
    })
    expect(sent(h.cdp, 'DOM.getFrameOwner').map((c) => c.sessionId)).toEqual(['s-outer', undefined])
  })

  it('offset 算不出來時錯誤原樣傳出，不退回主視窗座標亂點（裁決 29）', async () => {
    h.watcher.setRefs(refTable(1, [['s1-e0', { backendNodeId: 42, sessionId: 's-inner', role: 'button', name: '付款' }]]))
    h.cdp.setAttachedTargets([
      { targetId: 'T-inner', type: 'iframe', url: 'https://inner.test/', sessionId: 's-inner' },
    ])
    // 這個 target 在 Target.getTargets 裡沒有 parentId：resolveFrameOffset 丟 frame-detached。
    h.cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-inner' }] }))
    h.cdp.onSend('DOM.getBoxModel', () => ({ model: { border: INNER_BORDER } }), 's-inner')

    const error = await h.controller.click('s1-e0', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CdpError)
    expect((error as CdpError).code).toBe('frame-detached')
    expect(sent(h.cdp, 'Input.dispatchMouseEvent')).toHaveLength(0)
  })

  it('點擊造成換頁時多一行 urlChanged', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.setUrl('https://example.test/next')
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    const out = await promise
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.clicked('button', '送出')}\n${MSG.urlChanged('https://example.test/next')}`,
    })
  })

  it('等不到靜默回 settleTimeout(5)', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.cdp.emit('Network.requestWillBeSent', { requestId: 'r1', type: 'XHR' })
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    h.advance(5_000)
    await expect(promise).rejects.toThrow(MSG.settleTimeout(5))
  })

  it('動作期間的 input-event 不算使用者插手（runAsAgent）', async () => {
    h.cdp.onSend('Input.dispatchMouseEvent', () => {
      h.wc.userInput('mouseDown')
      return {}
    })
    const promise = h.controller.click('s1-e0', h.signal)
    await tick()
    quietOk(h)
    await promise
    expect(h.watcher.intervention().clicks).toBe(0)
  })

  it('右窗格已銷毀回 viewGone', async () => {
    h.wc.destroy()
    await expect(h.controller.click('s1-e0', h.signal)).rejects.toThrow(MSG.viewGone)
  })

  it('CDP 指令逾時丟 code timeout 的 CdpError，不會永遠掛住（裁決 14）', async () => {
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => new Promise(() => {}))
    const settled = h.controller.click('s1-e0', h.signal).then(
      () => 'resolved' as const,
      (error: unknown) => error
    )
    await tick()
    h.advance(CDP_CALL_TIMEOUT_MS)
    const result = await Promise.race([settled, delay(50).then(() => 'hung' as const)])
    expect(result).toBeInstanceOf(CdpError)
    expect((result as CdpError).code).toBe('timeout')
  })

  it('CDP 指令自己失敗時原樣傳出，不當成逾時', async () => {
    h.cdp.onSend('DOM.scrollIntoViewIfNeeded', () => Promise.reject(new CdpError('boom', 'protocol')))
    const error = await h.controller.click('s1-e0', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CdpError)
    expect((error as CdpError).code).toBe('protocol')
  })
})
```

逾時那個測試用 `Promise.race` 加一個 50ms 的真計時器哨兵，而不是直接 `await`：實作若少了逾時包裝，`await` 會掛到 vitest 的 5 秒測試逾時才變紅，訊息也只說「測試逾時」；用哨兵則是立刻拿到 `'hung'`、斷言指著 `toBeInstanceOf(CdpError)` 失敗，訊息說得清楚。

- [ ] **Step 1c: 寫失敗的測試（`controller-input.test.ts` 第二段：`view_type` 與 `view_press`，接在第一段後面）**

```ts
describe('controller：view_type', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.watcher.setRefs(refTable(2, [['s2-e1', { backendNodeId: 7, role: 'textbox', name: '電子郵件' }]]))
    h.cdp.onSend('DOM.focus', () => ({}))
    h.cdp.onSend('Input.dispatchKeyEvent', () => ({}))
    h.cdp.onSend('Input.insertText', () => ({}))
  })

  it('focus 送到節點所屬 session，insertText 送 root', async () => {
    h.watcher.setRefs(refTable(2, [['s2-e1', { backendNodeId: 7, sessionId: 's-x', role: 'textbox', name: '帳號' }]]))
    h.cdp.onSend('DOM.focus', () => ({}), 's-x')
    await h.controller.type('s2-e1', 'abc', false, false, h.signal)
    expect(sent(h.cdp, 'DOM.focus')[0]).toEqual({ params: { backendNodeId: 7 }, sessionId: 's-x' })
    expect(sent(h.cdp, 'Input.insertText')[0]).toEqual({ params: { text: 'abc' }, sessionId: undefined })
  })

  it('clear 用 commands: [selectAll] 全選後按 Backspace（裁決 12）', async () => {
    const out = await h.controller.type('s2-e1', 'hi', true, false, h.signal)
    const keys = sent(h.cdp, 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toEqual({
      type: 'keyDown',
      modifiers: 4,
      commands: ['selectAll'],
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    })
    expect(keys[1]).toEqual({ type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    expect(keys[2]).toEqual({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    expect(keys[3]).toEqual({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    expect(out).toEqual({ kind: 'text', text: MSG.typed(2, 'textbox', '電子郵件') })
  })

  it('clear 為 false 時完全不送按鍵，只有 insertText', async () => {
    await h.controller.type('s2-e1', 'hi', false, false, h.signal)
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')).toHaveLength(0)
    expect(sent(h.cdp, 'Input.insertText')).toHaveLength(1)
  })

  it('submit 送 Enter 並等靜默，換頁時加 urlChanged', async () => {
    h.cdp.onSend('Input.dispatchKeyEvent', () => {
      h.wc.setUrl('https://example.test/search?q=hi')
      return {}
    })
    const promise = h.controller.type('s2-e1', 'hi', false, true, h.signal)
    await tick()
    h.advance(500)
    const out = await promise
    const keys = sent(h.cdp, 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toEqual({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(keys[1]).toEqual({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    expect(out).toEqual({
      kind: 'text',
      text: `${MSG.typed(2, 'textbox', '電子郵件')}\n${MSG.urlChanged('https://example.test/search?q=hi')}`,
    })
  })

  it('submit 為 false 時不等靜默也不比對網址', async () => {
    h.cdp.onSend('Input.insertText', () => {
      h.wc.setUrl('https://example.test/other')
      return {}
    })
    const out = await h.controller.type('s2-e1', 'hi', false, false, h.signal)
    expect(out).toEqual({ kind: 'text', text: MSG.typed(2, 'textbox', '電子郵件') })
  })

  it('ref 過期時不 focus 也不輸入', async () => {
    await expect(h.controller.type('s9-e1', 'hi', false, false, h.signal)).rejects.toBeInstanceOf(ViewToolError)
    expect(sent(h.cdp, 'DOM.focus')).toHaveLength(0)
  })
})

describe('controller：view_press', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.cdp.onSend('Input.dispatchKeyEvent', () => ({}))
  })

  it('不支援的按鍵回 badKey 並列出全部鍵名', async () => {
    await expect(h.controller.press('F13', h.signal)).rejects.toThrow(MSG.badKey('F13', KEY_NAMES))
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')).toHaveLength(0)
  })

  it('大小寫敏感：enter 不是 Enter', async () => {
    await expect(h.controller.press('enter', h.signal)).rejects.toThrow(MSG.badKey('enter', KEY_NAMES))
  })

  it('有 text 的鍵用 keyDown 並帶 text', async () => {
    const promise = h.controller.press('Space', h.signal)
    await tick()
    h.advance(500)
    const out = await promise
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')[0]?.params).toEqual({
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
      text: ' ',
    })
    expect(out).toEqual({ kind: 'text', text: MSG.pressed('Space') })
  })

  it('沒有 text 的鍵用 rawKeyDown 且不帶 text', async () => {
    const promise = h.controller.press('Tab', h.signal)
    await tick()
    h.advance(500)
    await promise
    expect(sent(h.cdp, 'Input.dispatchKeyEvent')[0]?.params).toEqual({
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    })
  })

  it('等待靜默期間 signal 中止回 sessionEnded', async () => {
    const promise = h.controller.press('Tab', h.signal)
    await tick()
    h.aborter.abort()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })
})
```

`clear` 那個測試把四則按鍵事件逐一比對完整參數而不是只看有沒有 `selectAll`：`commands` 少了、`modifiers` 錯了、`keyUp` 忘了送、Backspace 用了 `keyDown` 而不是 `rawKeyDown`，四種錯法都各自有一行斷言擋著。

- [ ] **Step 1d: 寫失敗的測試（`tests/view-tools/controller.test.ts` 完整內容）**

只有 `collectSnapshotInput` 用 `vi.mock` 換掉，同一個模組的 `resolveFrameOffset` 保留真實作（`importOriginal()` 展開後只覆蓋一個名字）。理由：蒐集 AX 樹是 Task 5 的職責、有自己的測試，controller 的 `snapshot` 只負責流水號、`setRefs`、插手摘要與文字組裝；把整個蒐集流程真的跑一遍，這個檔會變成 Task 5 的第二份測試，而且 Task 5 一改 CDP 呼叫順序這裡就跟著紅。`resolveFrameOffset` 不能一起換掉：裁決 9 的座標重算是 controller 的行為，Step 1b 的兩層 offset 測試靠它。

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EVAL_MAX_CHARS, SCREENSHOT_MAX_WIDTH } from '../../src/main/view-tools/controller.js'
import { MSG, ViewToolError } from '../../src/main/view-tools/errors.js'
import { HANDOFF_TIMEOUT_MS } from '../../src/main/view-tools/handoff.js'
import { collectSnapshotInput } from '../../src/main/view-tools/snapshot-collect.js'
import type { SnapshotInput } from '../../src/main/view-tools/snapshot.js'
import { createHarness, sent, tick, type Harness } from './controller-harness.js'

// Task 5 的蒐集流程有自己的 task 與測試；這裡只驗 controller 的職責：流水號、
// setRefs、插手摘要與文字組裝。同一個模組的 resolveFrameOffset（裁決 9）保留真實作。
vi.mock('../../src/main/view-tools/snapshot-collect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/view-tools/snapshot-collect.js')>()
  return { ...actual, collectSnapshotInput: vi.fn() }
})

const collectMock = collectSnapshotInput as unknown as Mock

function inputFor(id: number, scope: 'viewport' | 'full' = 'viewport'): SnapshotInput {
  return {
    id,
    takenAt: 1_000,
    url: 'https://example.test/',
    title: '起始頁',
    scope,
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    frames: [
      {
        frameId: 'F1',
        url: 'https://example.test/',
        offset: { x: 0, y: 0 },
        nodes: [
          {
            nodeId: '1',
            ignored: false,
            role: { value: 'button' },
            name: { value: '送出' },
            backendDOMNodeId: 42,
            childIds: [],
          },
        ],
        boxes: new Map([[42, { x: 1, y: 2, width: 30, height: 10 }]]),
      },
    ],
    unattachedFrames: 0,
  }
}

describe('controller：view_navigate', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness('/tmp/yeschef-proj')
    h.cdp.onSend('Page.navigate', () => ({ frameId: 'F1' }))
  })

  const loadThenQuiet = (): void => {
    h.cdp.emit('Page.loadEventFired', { timestamp: 1 })
  }

  it('協定不在白名單回 badScheme，不送 Page.navigate', async () => {
    await expect(h.controller.navigate('ftp://example.test/x', h.signal)).rejects.toThrow(MSG.badScheme)
    expect(sent(h.cdp, 'Page.navigate')).toHaveLength(0)
  })

  it('無法解析的網址回 invalidUrl，訊息帶原字串', async () => {
    await expect(h.controller.navigate('example.test', h.signal)).rejects.toThrow(MSG.invalidUrl('example.test'))
  })

  it('專案目錄外的 file:// 回 outsideProject', async () => {
    await expect(h.controller.navigate('file:///etc/hosts', h.signal)).rejects.toThrow(
      MSG.outsideProject('/tmp/yeschef-proj')
    )
  })

  it('成功時送出正規化後的網址並回報網址與標題', async () => {
    h.wc.setUrl('https://example.test/a/b')
    h.wc.setTitle('目的地')
    const promise = h.controller.navigate('https://example.test/a/../a/b', h.signal)
    await tick()
    loadThenQuiet()
    await tick()
    h.advance(500)
    const out = await promise
    expect(sent(h.cdp, 'Page.navigate')[0]).toEqual({
      params: { url: 'https://example.test/a/b' },
      sessionId: undefined,
    })
    expect(out).toEqual({ kind: 'text', text: MSG.navigated('https://example.test/a/b', '目的地') })
  })

  it('Page.navigate 回 errorText 時丟 navigateFailed', async () => {
    h.cdp.onSend('Page.navigate', () => ({ frameId: 'F1', errorText: 'net::ERR_NAME_NOT_RESOLVED' }))
    await expect(h.controller.navigate('https://nope.test/', h.signal)).rejects.toThrow(
      MSG.navigateFailed('https://nope.test/', 'net::ERR_NAME_NOT_RESOLVED')
    )
  })

  it('8 秒內沒 load 完丟 navigateTimeout，帶當下網址', async () => {
    h.wc.setUrl('https://example.test/stuck')
    const promise = h.controller.navigate('https://example.test/stuck', h.signal)
    await tick()
    h.advance(8_000)
    await expect(promise).rejects.toThrow(MSG.navigateTimeout('https://example.test/stuck'))
  })

  it('等待中被中止丟 sessionEnded', async () => {
    const promise = h.controller.navigate('https://example.test/x', h.signal)
    await tick()
    h.aborter.abort()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })

  it('右窗格已銷毀時連網址檢查都不做', async () => {
    h.wc.destroy()
    await expect(h.controller.navigate('https://example.test/', h.signal)).rejects.toThrow(MSG.viewGone)
    expect(sent(h.cdp, 'Page.navigate')).toHaveLength(0)
  })
})

describe('controller：view_snapshot', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    collectMock.mockReset()
    collectMock.mockImplementation((_deps: unknown, id: number, scope: 'viewport' | 'full') =>
      Promise.resolve(inputFor(id, scope))
    )
  })

  it('流水號從 1 起遞增，scope 原樣傳給蒐集函式', async () => {
    await h.controller.snapshot('viewport', h.signal)
    await h.controller.snapshot('full', h.signal)
    expect(collectMock.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, 'viewport'],
      [2, 'full'],
    ])
  })

  it('把新的 RefTable 交給 watcher，ref 編號帶這次的流水號', async () => {
    await h.controller.snapshot('viewport', h.signal)
    const table = h.watcher.refs()
    expect(table.snapshotId).toBe(1)
    expect(table.entries.get('s1-e0')).toEqual({ backendNodeId: 42, role: 'button', name: '送出' })
  })

  it('沒有插手時文字不含摘要行', async () => {
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out).toEqual({
      kind: 'text',
      text: '[page] 起始頁 https://example.test/\ns1-e0 button "送出"',
    })
  })

  it('有插手時第一行是摘要，且摘要取完就歸零', async () => {
    h.wc.userInput('mouseDown')
    h.wc.userInput('keyDown')
    h.wc.setUrl('https://example.test/moved')
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out.text.split('\n')[0]).toBe(
      '使用者在你上次操作後點了 1 次、按了 1 個鍵，網址從 https://example.test/ 變成 https://example.test/moved'
    )
    expect(h.watcher.intervention()).toEqual({
      clicks: 0,
      keys: 0,
      navigations: 0,
      fromUrl: 'https://example.test/moved',
    })
  })

  it('蒐集期間的 input-event 不算插手（runAsAgent）', async () => {
    collectMock.mockImplementation((_deps: unknown, id: number) => {
      h.wc.userInput('mouseDown')
      return Promise.resolve(inputFor(id))
    })
    const out = await h.controller.snapshot('viewport', h.signal)
    expect(out.text.startsWith('[page]')).toBe(true)
    expect(h.watcher.intervention().clicks).toBe(0)
  })
})
```

- [ ] **Step 1e: 寫失敗的測試（`controller.test.ts` 第二段：`view_screenshot`、`view_eval`、`request_handoff`，接在第一段後面）**

```ts
describe('controller：view_screenshot', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
    h.cdp.onSend('Page.captureScreenshot', () => ({ data: 'UE5H' }))
  })

  const metrics = (clientWidth: number, clientHeight: number): void => {
    h.cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth, clientHeight } }))
  }

  it('寬度超過上限時等比縮小，clip 與文字用同一個 scale', async () => {
    metrics(1_600, 900)
    const out = await h.controller.screenshot(h.signal)
    expect(sent(h.cdp, 'Page.captureScreenshot')[0]?.params).toEqual({
      format: 'png',
      clip: { x: 0, y: 0, width: 1_600, height: 900, scale: 0.8 },
    })
    expect(out).toEqual({
      kind: 'image',
      text: MSG.screenshot(SCREENSHOT_MAX_WIDTH, 720, 'https://example.test/'),
      dataBase64: 'UE5H',
      mimeType: 'image/png',
    })
  })

  it('寬度小於上限時不放大', async () => {
    metrics(800, 601)
    const out = await h.controller.screenshot(h.signal)
    expect(sent(h.cdp, 'Page.captureScreenshot')[0]?.params).toMatchObject({
      clip: { width: 800, height: 601, scale: 1 },
    })
    expect(out.text).toBe(MSG.screenshot(800, 601, 'https://example.test/'))
  })
})

describe('controller：view_eval', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
  })

  const evaluates = (result: unknown): void => {
    h.cdp.onSend('Runtime.evaluate', () => result)
  }

  it('回傳值以 JSON 呈現，參數含 returnByValue 與 awaitPromise', async () => {
    evaluates({ result: { value: { a: 1 } } })
    const out = await h.controller.evaluate('({a:1})', h.signal)
    expect(sent(h.cdp, 'Runtime.evaluate')[0]).toEqual({
      params: { expression: '({a:1})', returnByValue: true, awaitPromise: true },
      sessionId: undefined,
    })
    expect(out).toEqual({ kind: 'text', text: '{"a":1}' })
  })

  it('值是 undefined 時回字串 undefined', async () => {
    evaluates({ result: {} })
    expect(await h.controller.evaluate('void 0', h.signal)).toEqual({ kind: 'text', text: 'undefined' })
  })

  it('NaN 這類值只有 unserializableValue 時用它（裁決 28）', async () => {
    evaluates({ result: { type: 'number', unserializableValue: 'NaN' } })
    expect(await h.controller.evaluate('0/0', h.signal)).toEqual({ kind: 'text', text: 'NaN' })
  })

  it('BigInt 的 unserializableValue 優先於 JSON.stringify', async () => {
    evaluates({ result: { type: 'bigint', unserializableValue: '1n' } })
    expect(await h.controller.evaluate('1n', h.signal)).toEqual({ kind: 'text', text: '1n' })
  })

  it('exceptionDetails 存在時丟出 description', async () => {
    evaluates({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } })
    await expect(h.controller.evaluate('x()', h.signal)).rejects.toThrow('TypeError: x is not a function')
  })

  it('沒有 description 時退回 exceptionDetails.text', async () => {
    evaluates({ exceptionDetails: { text: 'Uncaught SyntaxError' } })
    const error = await h.controller.evaluate('=', h.signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ViewToolError)
    expect((error as Error).message).toBe('Uncaught SyntaxError')
  })

  it('超長結果截到 8192 字元並附原長', async () => {
    const value = 'x'.repeat(9_000)
    evaluates({ result: { value } })
    const json = JSON.stringify(value)
    const out = await h.controller.evaluate('long', h.signal)
    expect(out.text).toBe(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(json.length))
    expect(out.text.startsWith(`"${'x'.repeat(EVAL_MAX_CHARS - 1)}`)).toBe(true)
  })

  it('剛好 8192 字元不截斷', async () => {
    const value = 'y'.repeat(EVAL_MAX_CHARS - 2)
    evaluates({ result: { value } })
    const out = await h.controller.evaluate('exact', h.signal)
    expect(out.text).toHaveLength(EVAL_MAX_CHARS)
    expect(out.text.includes('已截斷')).toBe(false)
  })
})

describe('controller：request_handoff', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
  })

  it('使用者按下後回 handoffDone，帶當下網址', async () => {
    const promise = h.controller.requestHandoff('tu-1', '請完成登入', h.signal)
    await tick()
    h.wc.setUrl('https://example.test/logged-in')
    h.handoff.done('tu-1')
    expect(await promise).toEqual({ kind: 'text', text: MSG.handoffDone('https://example.test/logged-in') })
  })

  it('逾時是狀態不是錯誤，回 handoffTimeout', async () => {
    const promise = h.controller.requestHandoff('tu-2', '請完成登入', h.signal)
    await tick()
    h.advance(HANDOFF_TIMEOUT_MS)
    expect(await promise).toEqual({ kind: 'text', text: MSG.handoffTimeout('https://example.test/') })
  })

  it('對話結束時丟 sessionEnded', async () => {
    const promise = h.controller.requestHandoff('tu-3', '請完成登入', h.signal)
    await tick()
    h.handoff.abortAll()
    await expect(promise).rejects.toThrow(MSG.sessionEnded)
  })

  it('已有一筆等待中時第二筆丟 handoffBusy', async () => {
    const first = h.controller.requestHandoff('tu-4', '請完成登入', h.signal)
    await tick()
    await expect(h.controller.requestHandoff('tu-5', '再一次', h.signal)).rejects.toThrow(
      MSG.handoffBusy('請完成登入')
    )
    h.handoff.done('tu-4')
    await first
  })

  it('等待期間的 input-event 要算使用者插手（不包在 runAsAgent 內）', async () => {
    const promise = h.controller.requestHandoff('tu-6', '請完成登入', h.signal)
    await tick()
    h.wc.userInput('mouseDown')
    h.wc.userInput('keyDown')
    h.wc.userInput('keyDown')
    h.handoff.done('tu-6')
    await promise
    expect(h.watcher.intervention()).toMatchObject({ clicks: 1, keys: 2 })
  })

  it('右窗格已銷毀時不建立 pending', async () => {
    h.wc.destroy()
    await expect(h.controller.requestHandoff('tu-7', '請完成登入', h.signal)).rejects.toThrow(MSG.viewGone)
    expect(h.handoff.pending()).toBeNull()
  })
})
```

`剛好 8192 字元不截斷` 這個上限測試存在的理由：截斷條件寫成 `>=` 而不是 `>` 時，長度恰好等於上限的結果會被多加一句「已截斷，原長 8192 字元」，是模型讀得到的假訊息。`'y'.repeat(EVAL_MAX_CHARS - 2)` 加上 `JSON.stringify` 的兩個雙引號剛好是 8192。

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/controller.test.ts tests/view-tools/controller-input.test.ts
```

六個實作檔都還不存在，兩個檔在載入階段就失敗。實跑輸出（已在 worktree 實跑）：

```
Error: Cannot find module '../../src/main/view-tools/controller.js' imported from …/tests/view-tools/controller-input.test.ts
Error: Cannot find module '/src/main/view-tools/controller.js' imported from …/tests/view-tools/controller.test.ts
 Test Files  2 failed (2)
      Tests  no tests
```

- [ ] **Step 3a: 最小實作（`src/main/view-tools/controller-types.ts` 完整內容）**

```ts
/**
 * controller 的公開型別與數值常數（契約 §10.2）。獨立成檔的理由：
 * controller.ts 與 controller-page／input／eval 都要用這些型別，型別放在
 * 最上游的葉節點才不會出現「controller.ts 匯入子模組、子模組又回頭匯入
 * controller.ts 的型別」這種循環。對外仍只從 controller.ts 匯出。
 */
import type { MergerClock } from '../agent-host.js'
import type { CdpSession } from '../cdp.js'
import type { Handoff } from './handoff.js'
import type { SettleTracker } from './settle.js'
import type { Watcher } from './watch.js'

export interface ControllerDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly webContents: { isDestroyed(): boolean; getURL(): string; getTitle(): string }
  readonly watcher: Watcher
  readonly settle: SettleTracker
  readonly handoff: Handoff
  readonly clock: MergerClock
  readonly projectDir: string
  readonly logError: (error: Error) => void
}

/** 單一 CDP 指令的逾時（裁決 14：在 controller 的 call() 做，不改 cdp.ts）。 */
export const CDP_CALL_TIMEOUT_MS = 10_000
/** view_eval 回傳文字的上限，超過截斷並附原長。 */
export const EVAL_MAX_CHARS = 8_192
/** 截圖縮放的目標寬度上限。 */
export const SCREENSHOT_MAX_WIDTH = 1_280

export interface ToolText {
  readonly kind: 'text'
  readonly text: string
}

export interface ToolImage {
  readonly kind: 'image'
  readonly text: string
  readonly dataBase64: string
  readonly mimeType: 'image/png'
}

export type ToolOutput = ToolText | ToolImage

export interface ViewController {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, text: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
}
```

- [ ] **Step 3b: 最小實作（`src/main/view-tools/controller-core.ts` 完整內容）**

```ts
/**
 * 八個方法共用的零件：逾時包裝的 call()、進門檢查、runAsAgent 包裝、
 * snapshot 編號、ref 查表與 ToolText 組裝。
 */
import { CdpError, toCdpError } from '../cdp.js'
import { MSG, ViewToolError } from './errors.js'
import { lookupRef } from './refs.js'
import type { CollectDeps } from './snapshot-collect.js'
import type { RefEntry } from './types.js'
import { CDP_CALL_TIMEOUT_MS, type ControllerDeps, type ToolText } from './controller-types.js'

/** 與 CdpSession.send 同簽章，多了 CDP_CALL_TIMEOUT_MS 的逾時。 */
export type CdpCall = <T>(method: string, params?: object, sessionId?: string) => Promise<T>

export interface ControllerCore {
  readonly deps: ControllerDeps
  readonly call: CdpCall
  /** 給 snapshot-collect 的 deps：send 走 call()，所以蒐集階段的指令也有逾時。 */
  readonly collect: CollectDeps
  /** 進門檢查（isDestroyed／已中止）後把整個動作包進 watcher.runAsAgent()。 */
  act<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>
  /** 只做進門檢查，不包 runAsAgent：request_handoff 的等待期間使用者操作是預期的。 */
  guard(signal: AbortSignal): void
  /** view_snapshot 的流水號，從 1 起。 */
  nextSnapshotId(): number
  /** ref 查表；bad-format／stale／missing 直接翻成 MSG 丟出。 */
  resolveEntry(ref: string): RefEntry
}

export function text(value: string): ToolText {
  return { kind: 'text', text: value }
}

/**
 * 裁決 14：逾時計時器走注入的 clock，逾時丟 code 為 'timeout' 的 CdpError。
 * `settled` 旗標讓先到的一方定案：CDP 慢一步回來時不會覆寫已經丟出的逾時，
 * 逾時計時器也不會在指令成功後再開一槍。
 */
function createCall(deps: ControllerDeps): CdpCall {
  return <T,>(method: string, params?: object, sessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false
      const handle = deps.clock.setTimer(() => {
        if (settled) return
        settled = true
        reject(new CdpError(`CDP 指令 ${method} 逾時（${CDP_CALL_TIMEOUT_MS} 毫秒）`, 'timeout'))
      }, CDP_CALL_TIMEOUT_MS)
      deps.cdp.send<T>(method, params, sessionId).then(
        (value) => {
          if (settled) return
          settled = true
          deps.clock.clearTimer(handle)
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          deps.clock.clearTimer(handle)
          reject(error instanceof Error ? error : toCdpError(error))
        }
      )
    })
}

export function createCore(deps: ControllerDeps): ControllerCore {
  const call = createCall(deps)
  let lastSnapshotId = 0

  const guard = (signal: AbortSignal): void => {
    if (deps.webContents.isDestroyed()) throw new ViewToolError(MSG.viewGone)
    if (signal.aborted) throw new ViewToolError(MSG.sessionEnded)
  }

  return {
    deps,
    call,
    collect: {
      cdp: {
        send: call,
        getAttachedTargets: () => deps.cdp.getAttachedTargets(),
        getRearmErrors: () => deps.cdp.getRearmErrors(),
      },
      currentUrl: () => deps.webContents.getURL(),
      currentTitle: () => deps.webContents.getTitle(),
      now: () => deps.clock.now(),
      logError: deps.logError,
    },
    guard,
    act: async (signal, fn) => {
      guard(signal)
      return deps.watcher.runAsAgent(fn)
    },
    nextSnapshotId: () => {
      lastSnapshotId += 1
      return lastSnapshotId
    },
    resolveEntry: (ref) => {
      const lookup = lookupRef(deps.watcher.refs(), ref)
      switch (lookup.kind) {
        case 'ok':
          return lookup.entry
        case 'bad-format':
          throw new ViewToolError(MSG.refFormat)
        case 'stale':
          throw new ViewToolError(MSG.refStale(lookup.snapshotId, lookup.reason))
        default:
          throw new ViewToolError(MSG.refMissing(lookup.snapshotId, lookup.ref))
      }
    },
  }
}
```

`guard()` 除了 `isDestroyed()` 之外還檢查 `signal.aborted`，兩者都丟對應的 `MSG`（裁決 28）：`abortPending()` 之後才被模型叫到的工具，與其送出註定失敗的 CDP 指令，不如立刻回「對話已結束」。八個方法一致，`snapshot` 與 `screenshot` 的 `signal` 參數也因此有了實際用途。

- [ ] **Step 3c: 最小實作（`src/main/view-tools/controller-input.ts` 完整內容）**

```ts
/**
 * 輸入層級的三個工具：view_click、view_type、view_press。
 *
 * 三個共同點：Input.* 一律送 root session（CDP 的輸入是頁面層級的，送到
 * OOPIF 的 session 反而打不到主視窗座標系），而 DOM.* 送節點所屬的 session。
 */
import { KEY_NAMES, lookupKey, type KeyDef } from './keys.js'
import { MSG, ViewToolError } from './errors.js'
import { SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS } from './settle.js'
import { resolveFrameOffset } from './snapshot-collect.js'
import type { Point, RefEntry } from './types.js'
import { text, type ControllerCore } from './controller-core.js'
import type { ToolOutput } from './controller-types.js'

interface BoxModel {
  readonly model: { readonly border: readonly number[] }
}

/** border 四點（x1,y1,…,x4,y4）的最小外接矩形中心。 */
function centerOfQuad(quad: readonly number[]): Point {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < quad.length; i += 2) {
    xs.push(quad[i] as number)
    ys.push(quad[i + 1] as number)
  }
  if (xs.length === 0) return { x: 0, y: 0 }
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

export function createInputTools(core: ControllerCore): {
  click(ref: string, signal: AbortSignal): Promise<ToolOutput>
  type(ref: string, value: string, clear: boolean, submit: boolean, signal: AbortSignal): Promise<ToolOutput>
  press(key: string, signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  /** 契約 §8：有 text 的鍵用 keyDown，沒有的用 rawKeyDown。 */
  const dispatchKey = async (def: KeyDef, extra?: object): Promise<void> => {
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    await call('Input.dispatchKeyEvent', {
      ...base,
      type: def.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...(def.text === undefined ? {} : { text: def.text }),
      ...extra,
    })
    await call('Input.dispatchKeyEvent', { ...base, type: 'keyUp', ...extra })
  }

  const waitQuiet = async (signal: AbortSignal): Promise<void> => {
    const outcome = await deps.settle.waitForQuiet({
      quietMs: SETTLE_QUIET_MS,
      timeoutMs: SETTLE_TIMEOUT_MS,
      signal,
    })
    if (outcome === 'timeout') throw new ViewToolError(MSG.settleTimeout(SETTLE_TIMEOUT_MS / 1000))
    if (outcome === 'aborted') throw new ViewToolError(MSG.sessionEnded)
  }

  /** 裁決 9：OOPIF 的 offset 每次點擊重算，不存進 RefEntry（iframe 位置會隨捲動改變）。 */
  const pointOf = async (entry: RefEntry, ref: string): Promise<Point> => {
    let box: BoxModel
    try {
      box = await call<BoxModel>('DOM.getBoxModel', { backendNodeId: entry.backendNodeId }, entry.sessionId)
    } catch {
      throw new ViewToolError(MSG.refDetached(ref))
    }
    const center = centerOfQuad(box.model.border)
    const offset = await resolveFrameOffset(core.collect, entry.sessionId)
    return { x: center.x + offset.x, y: center.y + offset.y }
  }

  return {
    click: (ref, signal) =>
      core.act(signal, async () => {
        const entry = core.resolveEntry(ref)
        await call('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, entry.sessionId)
        const point = await pointOf(entry, ref)
        const before = deps.webContents.getURL()
        const mouse = { x: point.x, y: point.y, button: 'left', clickCount: 1 }
        await call('Input.dispatchMouseEvent', { ...mouse, type: 'mousePressed' })
        await call('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' })
        await waitQuiet(signal)
        const after = deps.webContents.getURL()
        const lines = [MSG.clicked(entry.role, entry.name)]
        if (after !== before) lines.push(MSG.urlChanged(after))
        return text(lines.join('\n'))
      }),

    type: (ref, value, clear, submit, signal) =>
      core.act(signal, async () => {
        const entry = core.resolveEntry(ref)
        await call('DOM.focus', { backendNodeId: entry.backendNodeId }, entry.sessionId)
        const before = deps.webContents.getURL()
        if (clear) {
          // 裁決 12（docs/superpowers/plan-b/CONTRACT.md）：macOS 的 Meta+A 不會進
          // renderer 的編輯指令，全選要靠 commands: ['selectAll'] 這個欄位。
          await call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: 4,
            commands: ['selectAll'],
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
          await call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: 4,
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
          const backspace = lookupKey('Backspace')
          if (backspace !== null) await dispatchKey(backspace)
        }
        await call('Input.insertText', { text: value })
        const lines = [MSG.typed(value.length, entry.role, entry.name)]
        if (submit) {
          const enter = lookupKey('Enter')
          if (enter !== null) await dispatchKey(enter)
          await waitQuiet(signal)
          const after = deps.webContents.getURL()
          if (after !== before) lines.push(MSG.urlChanged(after))
        }
        return text(lines.join('\n'))
      }),

    press: (key, signal) =>
      core.act(signal, async () => {
        const def = lookupKey(key)
        if (def === null) throw new ViewToolError(MSG.badKey(key, KEY_NAMES))
        await dispatchKey(def)
        await waitQuiet(signal)
        return text(MSG.pressed(key))
      }),
  }
}
```

四處值得說明。`centerOfQuad` 取最小外接矩形的中心而不是直接用 `border[0]`／`border[1]`：CDP 的四點在元素有 transform 時不一定是軸對齊的左上起點，取中心是唯一在旋轉後仍落在元素上的取法。`clear` 的 Backspace 走 `dispatchKey`（`KEY_TABLE` 沒有 `text` 所以是 `rawKeyDown`）而不是硬寫 `keyDown`，跟 `view_press` 送出同一個鍵時的形狀一致，這是裁決 28 定案的。`type` 的 `before` 在 `focus` 之後就取，但只在 `submit` 為真時比較：契約 §10.2 只在 submit 那一格提 `urlChanged`，純輸入不該報網址。`pointOf` 只對 `DOM.getBoxModel` 包 try／catch（那一個要翻成 `refDetached`），`resolveFrameOffset` 的錯誤原樣往外丟：裁決 29 的 fail closed，算不出 iframe 位置時寧可回報 `cdpFailed`，也不能拿 iframe 內的座標去點主頁上的別的東西。

- [ ] **Step 3d: 最小實作（`src/main/view-tools/controller-page.ts` 完整內容）**

```ts
/**
 * 頁面層級的三個工具：view_navigate、view_snapshot、view_screenshot。
 */
import { MSG, ViewToolError } from './errors.js'
import { NAVIGATE_TIMEOUT_MS, SETTLE_QUIET_MS } from './settle.js'
import { buildSnapshot, formatSnapshotText } from './snapshot.js'
import { collectSnapshotInput } from './snapshot-collect.js'
import { checkNavigateUrl } from './urls.js'
import { summarizeIntervention } from './watch.js'
import { text, type ControllerCore } from './controller-core.js'
import { SCREENSHOT_MAX_WIDTH, type ToolOutput } from './controller-types.js'

interface LayoutMetrics {
  readonly cssVisualViewport: { readonly clientWidth: number; readonly clientHeight: number }
}

export function createPageTools(core: ControllerCore): {
  navigate(url: string, signal: AbortSignal): Promise<ToolOutput>
  snapshot(scope: 'viewport' | 'full', signal: AbortSignal): Promise<ToolOutput>
  screenshot(signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  return {
    navigate: (url, signal) =>
      core.act(signal, async () => {
        // 檢查順序：協定與專案範圍先擋掉，不合格的網址不該送進 CDP。
        const check = checkNavigateUrl(url, deps.projectDir)
        if (check.kind === 'invalid') throw new ViewToolError(MSG.invalidUrl(url))
        if (check.kind === 'bad-scheme') throw new ViewToolError(MSG.badScheme)
        if (check.kind === 'outside-project') throw new ViewToolError(MSG.outsideProject(check.projectDir))

        // 裁決 13：走 Page.navigate 而不是 wc.loadURL，才拿得到 errorText。
        const result = await call<{ readonly errorText?: string }>('Page.navigate', { url: check.url })
        const errorText = result.errorText
        if (typeof errorText === 'string' && errorText !== '') {
          throw new ViewToolError(MSG.navigateFailed(check.url, errorText))
        }

        const outcome = await deps.settle.waitForLoad({
          quietMs: SETTLE_QUIET_MS,
          timeoutMs: NAVIGATE_TIMEOUT_MS,
          signal,
        })
        if (outcome === 'timeout') throw new ViewToolError(MSG.navigateTimeout(deps.webContents.getURL()))
        if (outcome === 'aborted') throw new ViewToolError(MSG.sessionEnded)

        return text(MSG.navigated(deps.webContents.getURL(), deps.webContents.getTitle()))
      }),

    snapshot: (scope, signal) =>
      core.act(signal, async () => {
        const id = core.nextSnapshotId()
        const input = await collectSnapshotInput(core.collect, id, scope)
        const built = buildSnapshot(input)
        deps.watcher.setRefs(built.refs)
        // takeIntervention 要在 setRefs 之後、回傳之前呼叫：這一次 snapshot 就是
        // 「上次操作」的新起點，摘要交給模型看過就歸零。
        const summary = summarizeIntervention(deps.watcher.takeIntervention(), deps.webContents.getURL())
        return text(formatSnapshotText(built.snapshot, summary))
      }),

    screenshot: (signal) =>
      core.act(signal, async () => {
        const metrics = await call<LayoutMetrics>('Page.getLayoutMetrics')
        const width = metrics.cssVisualViewport.clientWidth
        const height = metrics.cssVisualViewport.clientHeight
        // 寬度為 0（頁面還沒排版完）時不縮放，避免 1280 / 0 得到 Infinity。
        const scale = width > 0 ? Math.min(1, SCREENSHOT_MAX_WIDTH / width) : 1
        const shot = await call<{ readonly data: string }>('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width, height, scale },
        })
        return {
          kind: 'image',
          text: MSG.screenshot(Math.round(width * scale), Math.round(height * scale), deps.webContents.getURL()),
          dataBase64: shot.data,
          mimeType: 'image/png',
        }
      }),
  }
}
```

`summary` 直接傳、不加 `?? undefined`：裁決 22 定案 `formatSnapshotText` 第二參數收 `string | null | undefined`，Task 4 的簽章已改成 `intervention?: string | null`，controller 不必自己轉換。

- [ ] **Step 3e: 最小實作（`src/main/view-tools/controller-eval.ts` 完整內容）**

```ts
/**
 * view_eval 與 request_handoff。兩個放一起的理由是它們都不碰 DOM 座標、
 * 也不等網路靜默，跟 page／input 兩組的流程沒有共用部分。
 */
import { MSG, ViewToolError } from './errors.js'
import { text, type ControllerCore } from './controller-core.js'
import { EVAL_MAX_CHARS, type ToolOutput } from './controller-types.js'

interface EvaluateResult {
  readonly result?: { readonly value?: unknown; readonly unserializableValue?: string }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

export function createEvalTools(core: ControllerCore): {
  evaluate(expression: string, signal: AbortSignal): Promise<ToolOutput>
  requestHandoff(toolUseId: string, reason: string, signal: AbortSignal): Promise<ToolOutput>
} {
  const { deps, call } = core

  return {
    evaluate: (expression, signal) =>
      core.act(signal, async () => {
        const res = await call<EvaluateResult>('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        const details = res.exceptionDetails
        if (details !== undefined) {
          throw new ViewToolError(details.exception?.description ?? details.text ?? '')
        }
        // 裁決 28：NaN／Infinity／BigInt 只有 unserializableValue，value 是 undefined。
        // JSON.stringify 對 undefined／函式／symbol 也回 undefined，一併當成 'undefined'，
        // 不必為「值本身就是 undefined」另開一個特殊情況。
        const json = res.result?.unserializableValue ?? JSON.stringify(res.result?.value) ?? 'undefined'
        if (json.length <= EVAL_MAX_CHARS) return text(json)
        return text(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(json.length))
      }),

    // 不包 watcher.runAsAgent()：等待期間使用者的點擊與按鍵就是這個工具在等的事，
    // 要照常計入插手記錄，下一次 view_snapshot 才會告訴模型使用者做了什麼。
    requestHandoff: async (toolUseId, reason, signal) => {
      core.guard(signal)
      const { outcome } = await deps.handoff.begin(toolUseId, reason, signal)
      if (outcome === 'done') return text(MSG.handoffDone(deps.webContents.getURL()))
      if (outcome === 'timeout') return text(MSG.handoffTimeout(deps.webContents.getURL()))
      throw new ViewToolError(MSG.sessionEnded)
    },
  }
}
```

- [ ] **Step 3f: 最小實作（`src/main/view-tools/controller.ts` 完整內容）**

```ts
/**
 * 八個工具的實際動作（契約 §10.2）。這個檔只做兩件事：把契約列的公開型別與
 * 常數轉出去，以及把三組方法組成一個 ViewController。
 *
 * 拆檔的理由：八個方法加 call() 逾時、offset 重算與輸出組字放同一個檔會超過
 * 400 行（契約 §1）。切法依「共用什麼」而不是依工具數量平均切：
 * controller-core 是全部共用的零件，controller-page 共用 settle 的等待與網址
 * 檢查，controller-input 共用 ref 查表、座標換算與按鍵送出，controller-eval
 * 兩個方法不碰前兩者任何東西。
 */
import { createCore } from './controller-core.js'
import { createEvalTools } from './controller-eval.js'
import { createInputTools } from './controller-input.js'
import { createPageTools } from './controller-page.js'
import type { ControllerDeps, ViewController } from './controller-types.js'

export {
  CDP_CALL_TIMEOUT_MS,
  EVAL_MAX_CHARS,
  SCREENSHOT_MAX_WIDTH,
  type ControllerDeps,
  type ToolImage,
  type ToolOutput,
  type ToolText,
  type ViewController,
} from './controller-types.js'

export function createViewController(deps: ControllerDeps): ViewController {
  const core = createCore(deps)
  const page = createPageTools(core)
  const input = createInputTools(core)
  const evalTools = createEvalTools(core)

  return {
    navigate: page.navigate,
    snapshot: page.snapshot,
    screenshot: page.screenshot,
    click: input.click,
    type: input.type,
    press: input.press,
    evaluate: evalTools.evaluate,
    requestHandoff: evalTools.requestHandoff,
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/controller.test.ts tests/view-tools/controller-input.test.ts
npx tsc --noEmit -p tsconfig.json
```

實跑輸出（已在 worktree 實跑，Task 0 到 8 的定稿程式碼全部放入，`snapshot-collect.ts` 用的是 task-5.md 的 371 行定稿版而不是 stub）：

```
 Test Files  2 passed (2)
      Tests  54 passed (54)
```

`tsc --noEmit` 無輸出、0 error。行數：`controller-core.ts` 111、`controller-eval.ts` 52、`controller-input.ts` 137、`controller-page.ts` 82、`controller-types.ts` 54、`controller.ts` 44，全部在 400 行以內。

- [ ] **Step 5: 突變測試（八個，全部已在 worktree 實跑）**

每個突變都是「看起來合理但錯」的版本，跑的指令一律是 `npx vitest run tests/view-tools/`（54 個測試）。改完跑、記下變紅的測試名、還原、再跑一次確認回綠。

**突變 1：`call()` 不做逾時，直接把 `cdp.send` 的 promise 傳出去。** 這是最容易發生的簡化：型別完全一樣，成功路徑的所有測試照樣綠。

```ts
function createCall(deps: ControllerDeps): CdpCall {
  return <T,>(method: string, params?: object, sessionId?: string): Promise<T> =>
    deps.cdp.send<T>(method, params, sessionId)
}
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_click > CDP 指令逾時丟 code timeout 的 CdpError，不會永遠掛住（裁決 14）`。還原後 54 綠。

**突變 2：`pointOf` 不加 frame offset，直接回 border 中心。**

```ts
    const center = centerOfQuad(box.model.border)
    return center
```

實跑結果：`Tests 2 failed | 52 passed (54)`，紅的是
`controller：view_click > 兩層巢狀 OOPIF 的座標加上兩層 offset（裁決 9）` 與
`controller：view_click > offset 算不出來時錯誤原樣傳出，不退回主視窗座標亂點（裁決 29）`（不呼叫就不會丟）。還原後 54 綠。
主 target 的點擊測試（offset 為 0）在這個突變下照樣綠，這正是計畫撰寫者須知說的盲點：測試必須用非零 offset 才擋得住。

**突變 3：Task 5 的 `resolveFrameOffset` 只往上走一層，不繼續找祖父 session。** 這一個比突變 2 更難察覺：offset 仍然非零，只是少了外層那 `(100, 200)`。改的是上游的檔，用意是確認 Task 9 的測試對「共用函式退化」也看得見。

```ts
    steps.push(step)
    current = undefined      // 原本是 current = step.parentSessionId
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的同樣是
`controller：view_click > 兩層巢狀 OOPIF 的座標加上兩層 offset（裁決 9）`（期望 `x: 190` 收到 `x: 90`）。還原後 54 綠。

**突變 4：`clear` 的全選按鍵不帶 `commands: ['selectAll']`，只留 `modifiers: 4`。** 這是裁決 12 要防的那個錯：在 macOS 上這個版本按下去什麼都不會選，接著的 Backspace 只刪掉一個字元，模型以為清空了。

```ts
          await call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: 4,
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
          })
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_type > clear 用 commands: [selectAll] 全選後按 Backspace（裁決 12）`。還原後 54 綠。

**突變 5：`evalTruncated` 帶截斷後的長度而不是原長。** 截斷本身還在做，字數也還是 8192，只有括號裡的數字錯了。

```ts
        return text(json.slice(0, EVAL_MAX_CHARS) + MSG.evalTruncated(EVAL_MAX_CHARS))
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_eval > 超長結果截到 8192 字元並附原長`。還原後 54 綠。

**突變 6：`requestHandoff` 也包進 `core.act()`（即 `watcher.runAsAgent()`）。** 這是最像「一致性重構」的錯：八個方法看起來就該一視同仁，包進去之後所有 handoff 的成功、逾時、忙碌測試照樣綠，只有插手記錄不見了。

```ts
    requestHandoff: (toolUseId, reason, signal) =>
      core.act(signal, async () => {
      const { outcome } = await deps.handoff.begin(toolUseId, reason, signal)
      // …（其餘不變）
      }),
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：request_handoff > 等待期間的 input-event 要算使用者插手（不包在 runAsAgent 內）`。還原後 54 綠。

**突變 7：`evaluate` 不看 `unserializableValue`，只用 `JSON.stringify(result.value)`。** 這是裁決 28 之前的寫法：`NaN`、`Infinity`、`1n` 的 `result.value` 是 undefined，模型會收到「undefined」而不是真正的值。

```ts
        const json = JSON.stringify(res.result?.value) ?? 'undefined'
```

實跑結果：`Tests 2 failed | 52 passed (54)`，紅的是
`controller：view_eval > NaN 這類值只有 unserializableValue 時用它（裁決 28）` 與
`controller：view_eval > BigInt 的 unserializableValue 優先於 JSON.stringify`。還原後 54 綠。

**突變 8：`click` 把 `resolveFrameOffset` 的錯誤吞掉，退回 `{0,0}`。** 這是最危險的一個「防禦性寫法」：算不出 iframe 位置時仍然照點，座標會落在主頁上完全不相干的地方。裁決 29 明訂 click 端不 catch。

```ts
    const offset = await resolveFrameOffset(core.collect, entry.sessionId).catch(() => ({ x: 0, y: 0 }))
```

實跑結果：`Tests 1 failed | 53 passed (54)`，紅的是
`controller：view_click > offset 算不出來時錯誤原樣傳出，不退回主視窗座標亂點（裁決 29）`。還原後 54 綠。

還原後最終確認（已實跑）：

```
$ npx vitest run tests/view-tools/
 Test Files  2 passed (2)
      Tests  54 passed (54)
$ npx tsc --noEmit -p tsconfig.json
（無輸出）
```

- [ ] **Step 6: 提交**

```bash
git add \
  src/main/view-tools/controller.ts \
  src/main/view-tools/controller-types.ts \
  src/main/view-tools/controller-core.ts \
  src/main/view-tools/controller-page.ts \
  src/main/view-tools/controller-input.ts \
  src/main/view-tools/controller-eval.ts \
  tests/view-tools/controller-harness.ts \
  tests/view-tools/controller.test.ts \
  tests/view-tools/controller-input.test.ts
git commit -m "feat: 八個右窗格工具的 CDP 動作（controller）"
```

