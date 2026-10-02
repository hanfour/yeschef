### Task 5: snapshot 的 CDP 蒐集（snapshot-collect.ts）

Task 4 的 `buildSnapshot` 是純函式，它需要的東西（每個 frame 的 AX 樹、每個節點的矩形、每個 frame 的 offset、viewport）全部得從 CDP 問出來。這個 task 就只做問的部分：把四種 CDP 查詢串成一個 `SnapshotInput`，過濾與編號一條都不做。這樣切的理由是兩邊的失敗模式完全不同，一邊是 I/O（frame 可能在查到一半就卸載、OOPIF 的 session 可能已經斷線），一邊是規則（ref 編號、截斷、可視判定）。混在一起會讓「ref 編號錯了」與「某個 iframe 沒附著」這兩種問題在同一個函式裡除錯。

frame 的發現是這個 task 最容易寫錯的地方，而且錯了不會有任何錯誤訊息，只會少看到東西。RESULTS-03 實測過：在 root session 呼叫 `Page.getFrameTree`，對 Google Identity configurator 那種頁面只回傳頂層文件自己一個 frame，完全沒有 `childFrames`，跨行程的 OOPIF 不在裡面。所以裁決 6 的作法是兩個來源取聯集：root 的 frame 樹負責同行程的子 frame，`getAttachedTargets()` 的每個 `type === 'iframe'` target 負責 OOPIF（`frameId` 就是它的 `targetId`），再對每個 OOPIF 的 session 呼叫一次 `Page.getFrameTree`，把巢狀在 OOPIF 裡面的同行程 frame 也納入。同一個 `frameId` 從兩邊都進來時只留第一次看到的那筆，這讓「OOPIF 自己的 frame 樹的根就是它自己」這個重複情況不必寫成特殊判斷。

座標是第二個容易寫錯又不會報錯的地方。`DOM.getBoxModel` 回的是「該 session 頂層 frame 的 viewport 座標」，不是主視窗座標：一個 OOPIF 裡的按鈕拿到的 y 是它在 iframe 內部的 y。裁決 7 的解法是每個 session 算一次 offset，沿 `Target.getTargets` 的父欄位鏈往上走到頁面本身，把每一層在父層裡的左上角加起來。父欄位依裁決 26 讀 `parentId ?? parentFrameId`，兩個欄位都當選填：`spikes/probe-oopif.ts:125` 的探針就是這樣讀的，哪一個真的有值尚未分開驗證，只讀其中一個會讓所有 OOPIF 的 offset 靜靜變成 `{0,0}`（Task 14 實機時把實際有值的欄位記進 RESULTS-05）。這裡刻意寫成迴圈而不是遞迴：巢狀 OOPIF（金流 iframe 裡再包一層 SSO 登入框，RESULTS-03 在 Stripe 量到深度 3）要加兩層以上才會對，而「走到一半失敗」與「`parentId` 意外成環」兩件事在迴圈裡都只是 `break`，不必在遞迴的每一層各自處理一次。裁決 7 說「任一步失敗回 `{0,0}` 並 logError」，套在迴圈上就是：失敗那一層以上當作 `{0,0}`，已經算出來的下層照樣加上去，跟逐層套用遞迴版本的結果一致。

錯誤處理分成四種，刻意不一致。`Page.getLayoutMetrics` 與 root 的 `Page.getFrameTree` 失敗直接往外丟：連 viewport 或主 frame 都沒有的話，回一份空的 snapshot 比回錯誤更糟，模型會以為頁面是空的。frame 層級的失敗（AX 樹抓不到）記 `logError` 並計入 `unattachedFrames`，snapshot 文字會多一行讓模型知道自己看不到某些東西。節點層級的失敗（`DOM.getBoxModel` 回錯）完全不記錄，因為 `display: none` 的元素在 AX 樹裡還在、`getBoxModel` 必定失敗，一次 snapshot 記幾百則等於沒記。

offset 的失敗是第四種，依裁決 29 由呼叫端決定怎麼處理：`resolveFrameOffset` 自己一律往外丟，不回退成 `{0,0}`。理由是這個值算錯不會有任何跡象，一個「iframe 內部座標被當成主視窗座標」的點擊會落在主頁上的別的元素，看起來像成功了。snapshot 端 catch 成 `{0,0}` 並 `logError`，frame 照常列入（節點清單與 ref 不需要座標就能餵給 `view_type`）；click 端（Task 9，裁決 9）不 catch，錯誤到工具端變成 `cdpFailed`，寧可讓模型收到一句失敗也不點錯地方。

`MAX_BOX_LOOKUPS` 的額度跨 frame 共用而不是每個 frame 各自一份：它擋的是「一次 snapshot 發出幾千個 CDP 指令」這件事，跟 frame 有幾個無關。box 查詢逐個 `await` 不並發，理由寫在裁決 7：幾百個 CDP 指令同時送會讓 Electron 的 debugger 排隊到逾時。

**Files:**

- Create `src/main/view-tools/snapshot-collect.ts`（381 行，契約 §9.1 的全部匯出加上裁決 9 要共用的 `resolveFrameOffset`；未超過 400 行，不拆檔）
- Test `tests/view-tools/snapshot-collect.test.ts`（672 行，36 個測試）

不改任何既有檔案。域的啟用（裁決 5 的 `DOM.enable`／`Network.enable`／`Accessibility.enable`）是 Task 6 的 watch.ts 負責，本 task 假設呼叫時三個域已經啟用。

**Interfaces:**

Consumes：

```ts
// Task 1（src/main/cdp.ts）
import { CdpError } from '../cdp.js'
import type { CdpSession } from '../cdp.js'
// CdpSession.send<T>(method: string, params?: object, sessionId?: string): Promise<T>
// CdpSession.getAttachedTargets(): readonly AttachedTargetInfo[]   // { targetId, type, url, sessionId }
// CdpSession.getRearmErrors(): readonly CdpError[]

// Task 4（src/main/view-tools/snapshot.ts）
import { INTERACTIVE_ROLES, STRUCTURAL_ROLES } from './snapshot.js'
import type { AxRawNode, FrameInput, SnapshotInput } from './snapshot.js'

// Task 0（src/main/view-tools/types.ts）
import type { Point, Rect } from './types.js'

// 測試：Task 1 的 tests/helpers/fake-cdp.ts
import { createFakeCdp } from '../helpers/fake-cdp.js'   // onSend(method, responder, sessionId?)、emit、setAttachedTargets、setRearmErrors
// 測試：Task 4 的 tests/fixtures/ax/form.json
```

Produces：

```ts
export interface CollectDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly currentUrl: () => string       // wc.getURL()
  readonly currentTitle: () => string     // wc.getTitle()
  readonly now: () => number
  readonly logError: (error: Error) => void
}
export const MAX_BOX_LOOKUPS = 1500
/**
 * 裁決 9：controller 點擊 OOPIF 裡的元素時重算 offset，只傳前兩個參數。
 * 裁決 29：任一步失敗往外丟（CdpError 原樣；找不到 session／target 時 code 為
 * 'frame-detached'，CDP 回了預期外形狀時 code 為 'invalid-response'），不回 {0,0}。
 */
export function resolveFrameOffset(
  deps: CollectDeps,
  sessionId: string | undefined,
  cache?: Map<string, Point>
): Promise<Point>
export function collectSnapshotInput(
  deps: CollectDeps,
  id: number,
  scope: 'viewport' | 'full'
): Promise<SnapshotInput>
```

`resolveFrameOffset` 的第三個參數 `cache` 依裁決 26 定案並已寫進契約 §9.1：裁決 7 要求「同一次 snapshot 內以 sessionId 快取，不重算」，而同一個函式又要能被 controller 單獨呼叫（裁決 9）。選填加預設值兩件事都成立，`collectSnapshotInput` 內部建一份 cache 傳給每個 frame，controller 寫兩個參數即可。只有成功解析的層會進 cache，失敗不留下紀錄（裁決 29 之下失敗已經是例外，不是一個要記住的值）。

下游：Task 9 的 controller 呼叫 `collectSnapshotInput(deps, id, scope)` 後把結果交給 `buildSnapshot`，並在 `view_click` 遇到 `entry.sessionId` 有值時呼叫 `resolveFrameOffset(deps, entry.sessionId)`。

---

- [ ] **Step 1: 寫失敗的測試**

`tests/view-tools/snapshot-collect.test.ts` 全文（分四段貼，實際是同一個檔）。

假 CDP 用 Task 1 的 `createFakeCdp()`，`onSend` 依 method 與 sessionId 分別預錄：`onSend('X', fn)` 接所有 session 的 X，`onSend('X', fn, 's-a')` 只接那個 session 的，後者優先。`DOM.getBoxModel` 的預錄回應同時給 `border` 與 `content` 兩個 quad，因為節點的矩形與 iframe 擁有者的矩形查的是不同的 `backendNodeId`，不會互相干擾，一個 session 因此只需要一份預錄。

offset 的測試資料全部用非零、且同一層的 x 與 y 不相等的數字（外層 `(100, 40)`、內層 `(7, 13)`、相加是 `(107, 53)`）：offset 為 0 或 x 等於 y 的話，「忘記加父層」「只加父層」「x 與 y 寫反」三種寫法都會巧合地算出正確答案。

失敗的情況全部用 `rejects.toMatchObject({ code })` 驗 code（裁決 29），不驗 `logError`：`resolveFrameOffset` 本身不再記錄任何東西。snapshot 端的 `{0,0}` 回退另外一條測試單獨驗，而且刻意讓同一個 session 底下有兩個 frame，用來釘死「一個 session 只記一次」。

第一段（工具函式、基本欄位與 viewport）：

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CdpError } from '../../src/main/cdp.js'
import type { AttachedTargetInfo } from '../../src/main/cdp.js'
import {
  MAX_BOX_LOOKUPS,
  collectSnapshotInput,
  resolveFrameOffset,
} from '../../src/main/view-tools/snapshot-collect.js'
import type { CollectDeps } from '../../src/main/view-tools/snapshot-collect.js'
import { buildSnapshot } from '../../src/main/view-tools/snapshot.js'
import type { AxRawNode } from '../../src/main/view-tools/snapshot.js'
import { createFakeCdp } from '../helpers/fake-cdp.js'
import type { FakeCdp } from '../helpers/fake-cdp.js'

/** 軸對齊的 quad：[x1,y1,x2,y2,x3,y3,x4,y4]，順序是左上、右上、右下、左下。 */
function quad(x: number, y: number, width: number, height: number): readonly number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height]
}

/**
 * DOM.getBoxModel 的預錄回應：同一個 model 同時給 border 與 content。
 * 兩者查的是不同的 backendNodeId（節點的矩形 vs iframe 擁有者的矩形），
 * 不會互相干擾，測試因此不必為同一個 session 開兩份預錄。
 */
function boxModel(byId: Readonly<Record<number, readonly number[]>>) {
  return (params: object | undefined): unknown => {
    const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId
    const q = id === undefined ? undefined : byId[id]
    if (q === undefined) throw new CdpError(`沒有 node ${String(id)} 的 box model`, 'no-box-model')
    return { model: { border: q, content: q } }
  }
}

function axNode(
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId: number,
  extra: Partial<AxRawNode> = {}
): AxRawNode {
  return { nodeId, ignored: false, role: { value: role }, name: { value: name }, backendDOMNodeId, ...extra }
}

function frameTree(id: string, url: string, children: readonly { id: string; url: string }[] = []): unknown {
  return { frameTree: { frame: { id, url }, childFrames: children.map((c) => ({ frame: { id: c.id, url: c.url } })) } }
}

function target(targetId: string, sessionId: string, url: string, type = 'iframe'): AttachedTargetInfo {
  return { targetId, type, url, sessionId }
}

function makeDeps(cdp: FakeCdp): { deps: CollectDeps; errors: Error[] } {
  const errors: Error[] = []
  const deps: CollectDeps = {
    cdp,
    currentUrl: () => 'https://a.test/order',
    currentTitle: () => '訂單確認',
    now: () => 1700,
    logError: (e) => {
      errors.push(e)
    },
  }
  return { deps, errors }
}

/** 最小可用的樁：viewport 1024×768、一個主 frame、沒有 iframe。 */
function basicCdp(nodes: readonly AxRawNode[], byId: Readonly<Record<number, readonly number[]>>): FakeCdp {
  const cdp = createFakeCdp()
  cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 1024, clientHeight: 768 } }))
  cdp.onSend('Page.getFrameTree', () => frameTree('F-root', 'https://a.test/order'))
  cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes }))
  cdp.onSend('DOM.getBoxModel', boxModel(byId))
  return cdp
}

function methodCalls(cdp: FakeCdp, method: string): readonly unknown[][] {
  return (cdp.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === method)
}

describe('collectSnapshotInput：基本欄位與 viewport', () => {
  it('id、scope 與 deps 的 now／url／title 原樣帶進 SnapshotInput，viewport 取 cssVisualViewport 且 x、y 為 0', async () => {
    const cdp = basicCdp([], {})
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 7, 'full')
    expect(input.id).toBe(7)
    expect(input.scope).toBe('full')
    expect(input.takenAt).toBe(1700)
    expect(input.url).toBe('https://a.test/order')
    expect(input.title).toBe('訂單確認')
    // 寬高刻意不同，x/y 或 width/height 互換的實作會被抓到。
    expect(input.viewport).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })

  it('cssVisualViewport 沒有寬高時丟 CdpError（code invalid-response），不是靜靜回 0', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getLayoutMetrics', () => ({ layoutViewport: { clientWidth: 800, clientHeight: 600 } }))
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({
      name: 'CdpError',
      code: 'invalid-response',
    })
  })

  it('Page.getLayoutMetrics 失敗時錯誤往外丟，不吞掉', async () => {
    const cdp = basicCdp([], {})
    cdp.onSend('Page.getLayoutMetrics', () => {
      throw new CdpError('目標已關閉', 'targetClosed')
    })
    const { deps } = makeDeps(cdp)
    await expect(collectSnapshotInput(deps, 1, 'viewport')).rejects.toMatchObject({ code: 'targetClosed' })
  })
})
```

第二段（frame 發現與 unattachedFrames，裁決 6）：

```ts
describe('collectSnapshotInput：frame 發現（裁決 6）', () => {
  const rootNodes = [axNode('1', 'button', '送出', 11)]

  it('root 的 frame 樹遞迴攤平，同行程子 frame 的 sessionId 是 undefined，主 frame 排在最前', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.onSend('Page.getFrameTree', () =>
      frameTree('F-root', 'https://a.test/order', [{ id: 'F-child', url: 'https://a.test/side' }])
    )
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'F-child'])
    expect(input.frames.map((f) => f.sessionId)).toEqual([undefined, undefined])
    expect(input.frames[1]?.url).toBe('https://a.test/side')
  })

  it('getAttachedTargets 的 iframe target 成為 frame（frameId 就是 targetId），非 iframe 的 target 不算', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([
      target('T-oopif', 's-oopif', 'https://pay.test/'),
      target('T-worker', 's-worker', 'https://a.test/sw.js', 'service_worker'),
    ])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-oopif', 'https://pay.test/'), 's-oopif')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif'])
    expect(input.frames[1]?.sessionId).toBe('s-oopif')
    expect(input.frames[1]?.url).toBe('https://pay.test/')
  })

  it('iframe target 自己的 frame 樹也攤平，且跟 target 重複的 frameId 只出現一次', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend(
      'Page.getFrameTree',
      () => frameTree('T-oopif', 'https://pay.test/', [{ id: 'F-inner', url: 'https://pay.test/inner' }]),
      's-oopif'
    )
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif', 'F-inner'])
    expect(input.frames[2]?.sessionId).toBe('s-oopif')
  })

  it('iframe target 的 Page.getFrameTree 失敗只記錄，target 本身仍然是一個 frame', async () => {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40) })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend(
      'Page.getFrameTree',
      () => {
        throw new CdpError('session 已關閉', 'sessionClosed')
      },
      's-oopif'
    )
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) }))
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-oopif'])
    expect(errors.map((e) => e.message).join('\n')).toContain('T-oopif')
    expect(input.unattachedFrames).toBe(0)
  })
})

describe('collectSnapshotInput：unattachedFrames（裁決 6 第 3、4 點）', () => {
  const rootNodes = [axNode('1', 'button', '送出', 11)]

  function withTwoOopifs(): FakeCdp {
    const cdp = basicCdp(rootNodes, { 11: quad(10, 20, 30, 40), 900: quad(100, 40, 300, 200) })
    cdp.setAttachedTargets([target('T-a', 's-a', 'https://a.pay/'), target('T-b', 's-b', 'https://b.pay/')])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-a', 'https://a.pay/'), 's-a')
    cdp.onSend('Page.getFrameTree', () => frameTree('T-b', 'https://b.pay/'), 's-b')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-a', type: 'iframe', parentId: 'T-page' },
        { targetId: 'T-b', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    return cdp
  }

  it('AX 樹抓不到的 frame 略過、計入 unattachedFrames 並記錄錯誤', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-a'
    )
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-b'])
    expect(input.unattachedFrames).toBe(1)
    expect(errors.some((e) => e.message.includes('T-a'))).toBe(true)
  })

  it('getFullAXTree 回傳沒有 nodes 陣列時視同抓不到', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({}), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-b'])
    expect(input.unattachedFrames).toBe(1)
    expect(errors.some((e) => e.message.includes('nodes'))).toBe(true)
  })

  it('getRearmErrors 非空、但所有 frame 的 AX 樹都抓得到時，unattachedFrames 仍至少是 1', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames).toHaveLength(3)
    expect(input.unattachedFrames).toBe(1)
  })

  it('getRearmErrors 非空且已經有兩個 frame 抓不到時，維持 2 而不是被壓成 1', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-a'
    )
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => {
        throw new CdpError('frame 已卸載', 'frameGone')
      },
      's-b'
    )
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.unattachedFrames).toBe(2)
  })

  it('getRearmErrors 為空、frame 都正常時 unattachedFrames 是 0', async () => {
    const cdp = withTwoOopifs()
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-a')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }), 's-b')
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.unattachedFrames).toBe(0)
  })
})
```

第三段（offset，裁決 7）：

```ts
describe('resolveFrameOffset（裁決 7）', () => {
  /**
   * 兩層 OOPIF：T-outer 在頁面裡的 (100, 40)，T-inner 在 T-outer 座標系裡的 (7, 13)。
   * 每一層的 x 與 y 都不同、都不是 0，所以「只加自己那層」「只加父層」「x 與 y 寫反」
   * 三種錯法都會得到跟 (107, 53) 不同的值。
   */
  function nestedCdp(): FakeCdp {
    const cdp = basicCdp([], {})
    cdp.setAttachedTargets([
      target('T-outer', 's-outer', 'https://outer.test/'),
      target('T-inner', 's-inner', 'https://inner.test/'),
    ])
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' },
        { targetId: 'T-outer', type: 'iframe', parentId: 'T-page' },
      ],
    }))
    // root session（父是頁面本身）算 T-outer 的位置。
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 900: quad(100, 40, 300, 200) }))
    // s-outer session 算 T-inner 的位置。
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 901 }), 's-outer')
    cdp.onSend('DOM.getBoxModel', boxModel({ 901: quad(7, 13, 120, 60) }), 's-outer')
    return cdp
  }

  it('sessionId 為 undefined（root）時直接回 {0,0}，一個 CDP 指令都不發', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, undefined)).toEqual({ x: 0, y: 0 })
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(0)
    expect(errors).toEqual([])
  })

  it('單層 OOPIF：offset 就是父 session 裡 content 的左上角', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-outer')).toEqual({ x: 100, y: 40 })
    expect(errors).toEqual([])
  })

  it('兩層 OOPIF：offset 是整條父鏈相加，不是只有自己那一層', async () => {
    const cdp = nestedCdp()
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-inner')).toEqual({ x: 107, y: 53 })
    expect(errors).toEqual([])
  })

  it('getFrameOwner 送到父 session：T-inner 問 s-outer，T-outer 問 root', async () => {
    const cdp = nestedCdp()
    const { deps } = makeDeps(cdp)
    await resolveFrameOffset(deps, 's-inner')
    const owners = methodCalls(cdp, 'DOM.getFrameOwner')
    expect(owners).toEqual([
      ['DOM.getFrameOwner', { frameId: 'T-inner' }, 's-outer'],
      ['DOM.getFrameOwner', { frameId: 'T-outer' }, undefined],
    ])
  })

  it('Target.getTargets 找不到這個 target 的父 target 時往外丟 frame-detached（裁決 29）', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-somebody-else', type: 'iframe', parentId: 'T-page' }],
    }))
    const { deps, errors } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({
      name: 'CdpError',
      code: 'frame-detached',
    })
    // 容忍與否由呼叫端決定，函式本身不記錄也不回退。
    expect(errors).toEqual([])
  })

  it('TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-page', type: 'page' },
        { targetId: 'T-inner', type: 'iframe', parentFrameId: 'T-outer' },
        { targetId: 'T-outer', type: 'iframe', parentFrameId: 'T-page' },
      ],
    }))
    const { deps, errors } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-inner')).toEqual({ x: 107, y: 53 })
    expect(errors).toEqual([])
  })

  it('TargetInfo 有這個 target 但兩個父欄位都沒有時往外丟 frame-detached', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-outer', type: 'iframe' }] }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'frame-detached' })
  })

  it('getAttachedTargets 裡沒有這個 sessionId 時往外丟 frame-detached，不發任何指令', async () => {
    const cdp = nestedCdp()
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-unknown')).rejects.toMatchObject({ code: 'frame-detached' })
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(0)
  })

  it('DOM.getFrameOwner 失敗時把原本的 CdpError 原樣往外丟，不換成別的 code', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getFrameOwner', () => {
      throw new CdpError('找不到 frame owner', 'noNode')
    })
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'noNode' })
  })

  it('DOM.getFrameOwner 沒有回傳 backendNodeId 時往外丟 invalid-response', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getFrameOwner', () => ({}))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('backendNodeId'),
    })
  })

  it('Target.getTargets 失敗時把原本的 CdpError 原樣往外丟', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => {
      throw new CdpError('debugger 已卸除', 'detached')
    })
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'detached' })
  })

  it('父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）', async () => {
    const cdp = nestedCdp()
    // T-inner 在 T-outer 裡的位置查得到，但 T-outer 自己的父 target 查不到。
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' }],
    }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-inner')).rejects.toMatchObject({ code: 'frame-detached' })
  })

  it('content 的四點順序打亂時取最小外接矩形的左上角', async () => {
    const cdp = nestedCdp()
    // 右下、左下、左上、右上：左上角仍應是 (100, 40)。
    cdp.onSend('DOM.getBoxModel', () => ({ model: { content: [400, 240, 100, 240, 100, 40, 400, 40] } }))
    const { deps } = makeDeps(cdp)
    expect(await resolveFrameOffset(deps, 's-outer')).toEqual({ x: 100, y: 40 })
  })

  it('content 不是八個數字時往外丟 invalid-response', async () => {
    const cdp = nestedCdp()
    cdp.onSend('DOM.getBoxModel', () => ({ model: { content: [100, 40] } }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-outer')).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('父欄位成環時往外丟 invalid-response，不會無限打轉', async () => {
    const cdp = nestedCdp()
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [
        { targetId: 'T-outer', type: 'iframe', parentId: 'T-inner' },
        { targetId: 'T-inner', type: 'iframe', parentId: 'T-outer' },
      ],
    }))
    const { deps } = makeDeps(cdp)
    await expect(resolveFrameOffset(deps, 's-inner')).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('迴圈'),
    })
  })

  it('同一次 snapshot 內同一個 session 只算一次（快取）', async () => {
    const cdp = nestedCdp()
    cdp.setAttachedTargets([
      target('T-outer', 's-outer', 'https://outer.test/'),
      target('T-inner', 's-inner', 'https://inner.test/'),
    ])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-outer', 'https://outer.test/'), 's-outer')
    cdp.onSend('Page.getFrameTree', () => frameTree('T-inner', 'https://inner.test/'), 's-inner')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [] }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.offset)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 40 },
      { x: 107, y: 53 },
    ])
    // s-outer 出現在兩條解析路徑上（自己一次、s-inner 的父鏈一次），只能查一次 parentId。
    expect(methodCalls(cdp, 'Target.getTargets')).toHaveLength(2)
  })
})
```

第四段（裁決 29 的 snapshot 端處置、box 蒐集、`MAX_BOX_LOOKUPS`，以及跟 Task 4 `buildSnapshot` 串起來的整合測試）：

```ts
describe('collectSnapshotInput 對 offset 失敗的處置（裁決 29）', () => {
  it('offset 算不出來時該 frame 用 {0,0}、記錄一次，frame 與它的節點照常列入', async () => {
    const cdp = basicCdp([axNode('1', 'button', '主頁按鈕', 11)], { 11: quad(10, 20, 30, 40), 21: quad(5, 6, 30, 40) })
    cdp.setAttachedTargets([target('T-pay', 's-pay', 'https://pay.test/')])
    // 同一個 session 底下兩個 frame，錯誤只該記一次。
    cdp.onSend(
      'Page.getFrameTree',
      () => frameTree('T-pay', 'https://pay.test/', [{ id: 'F-inner', url: 'https://pay.test/inner' }]),
      's-pay'
    )
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [axNode('1', 'button', '付款', 21)] }), 's-pay')
    // T-pay 不在 Target.getTargets 的清單裡：resolveFrameOffset 丟 frame-detached。
    cdp.onSend('Target.getTargets', () => ({ targetInfos: [{ targetId: 'T-other', type: 'iframe' }] }))
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-pay', 'F-inner'])
    expect(input.frames.map((f) => f.offset)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ])
    // 節點與矩形照常蒐集：view_type 不需要座標，ref 仍然可用。
    expect([...(input.frames[1]?.boxes.keys() ?? [])]).toEqual([21])
    expect(input.frames[1]?.nodes).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('s-pay')
  })
})

describe('collectSnapshotInput：box 蒐集', () => {
  it('只對角色白名單內、未 ignored 且有 backendDOMNodeId 的節點查 box', async () => {
    const nodes: readonly AxRawNode[] = [
      axNode('1', 'RootWebArea', '訂單確認', 1),
      axNode('2', 'button', '送出', 11),
      axNode('3', 'heading', '訂單', 12),
      axNode('4', 'generic', '', 13),
      axNode('5', 'StaticText', '送出', 14),
      axNode('6', 'button', '隱藏', 15, { ignored: true }),
      { nodeId: '7', ignored: false, role: { value: 'link' }, name: { value: '沒有節點' } },
    ]
    const cdp = basicCdp(nodes, { 11: quad(10, 20, 30, 40), 12: quad(1, 2, 3, 4) })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel').map((c) => c[1])).toEqual([{ backendNodeId: 11 }, { backendNodeId: 12 }])
    expect([...(input.frames[0]?.boxes.keys() ?? [])]).toEqual([11, 12])
    expect(errors).toEqual([])
  })

  it('border 取四點的最小外接矩形，順序打亂與非軸對齊都算得出來', async () => {
    const nodes = [axNode('1', 'button', '送出', 11)]
    const cdp = basicCdp(nodes, {})
    cdp.onSend('DOM.getBoxModel', () => ({ model: { border: [30, 5, 50, 25, 30, 45, 10, 25] } }))
    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(input.frames[0]?.boxes.get(11)).toEqual({ x: 10, y: 5, width: 40, height: 40 })
  })

  it('getBoxModel 失敗的節點不進 boxes，也不記錄錯誤（display: none 是常態）', async () => {
    const nodes = [axNode('1', 'button', '送出', 11), axNode('2', 'button', '隱藏', 12)]
    const cdp = basicCdp(nodes, { 11: quad(10, 20, 30, 40) })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect([...(input.frames[0]?.boxes.keys() ?? [])]).toEqual([11])
    expect(errors).toEqual([])
  })

  it('box 查詢送到該 frame 的 sessionId', async () => {
    const cdp = basicCdp([axNode('1', 'button', '主頁按鈕', 11)], {
      11: quad(10, 20, 30, 40),
      21: quad(1, 2, 3, 4),
      900: quad(100, 40, 300, 200),
    })
    cdp.setAttachedTargets([target('T-oopif', 's-oopif', 'https://pay.test/')])
    cdp.onSend('Page.getFrameTree', () => frameTree('T-oopif', 'https://pay.test/'), 's-oopif')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: [axNode('1', 'button', '付款', 21)] }), 's-oopif')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-oopif', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    const { deps } = makeDeps(cdp)
    await collectSnapshotInput(deps, 1, 'full')
    const calls = methodCalls(cdp, 'DOM.getBoxModel')
    expect(calls).toContainEqual(['DOM.getBoxModel', { backendNodeId: 11 }, undefined])
    expect(calls).toContainEqual(['DOM.getBoxModel', { backendNodeId: 21 }, 's-oopif'])
  })
})

describe('collectSnapshotInput：MAX_BOX_LOOKUPS（裁決 7）', () => {
  function manyNodes(prefix: string, count: number, firstId: number): readonly AxRawNode[] {
    return Array.from({ length: count }, (_, i) => axNode(`${prefix}${i}`, 'button', `按鈕 ${i}`, firstId + i))
  }

  it('額度跨 frame 共用：兩個各 800 個候選的 frame 只查 1500 次，多的不查也不進 boxes，並記錄一次', async () => {
    const first = manyNodes('a', 800, 1000)
    const second = manyNodes('b', 800, 5000)
    const cdp = basicCdp(first, {})
    cdp.onSend('Page.getFrameTree', () =>
      frameTree('F-root', 'https://a.test/order', [{ id: 'F-child', url: 'https://a.test/side' }])
    )
    cdp.onSend('Accessibility.getFullAXTree', (params) =>
      (params as { frameId?: string } | undefined)?.frameId === 'F-child' ? { nodes: second } : { nodes: first }
    )
    cdp.onSend('DOM.getBoxModel', (params) => {
      const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId ?? 0
      return { model: { border: quad(id, id + 1, 10, 10) } }
    })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel')).toHaveLength(MAX_BOX_LOOKUPS)
    expect(input.frames[0]?.boxes.size).toBe(800)
    expect(input.frames[1]?.boxes.size).toBe(700)
    // 第二個 frame 的第 701 個之後沒有矩形：buildSnapshot 規則 2 會把它們當不存在。
    expect(input.frames[1]?.boxes.has(5699)).toBe(true)
    expect(input.frames[1]?.boxes.has(5700)).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('100')
  })

  it('候選數剛好等於上限時全部查完，不記錄錯誤', async () => {
    const nodes = manyNodes('a', MAX_BOX_LOOKUPS, 1000)
    const cdp = basicCdp(nodes, {})
    cdp.onSend('DOM.getBoxModel', (params) => {
      const id = (params as { backendNodeId?: number } | undefined)?.backendNodeId ?? 0
      return { model: { border: quad(id, id + 1, 10, 10) } }
    })
    const { deps, errors } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 1, 'full')
    expect(methodCalls(cdp, 'DOM.getBoxModel')).toHaveLength(MAX_BOX_LOOKUPS)
    expect(input.frames[0]?.boxes.size).toBe(MAX_BOX_LOOKUPS)
    expect(errors).toEqual([])
  })
})

describe('collectSnapshotInput 的輸出直接餵得進 buildSnapshot', () => {
  const FORM_AX = JSON.parse(readFileSync('tests/fixtures/ax/form.json', 'utf8')) as { nodes: readonly AxRawNode[] }

  /** fixture 的 backendDOMNodeId → 矩形。刻意全部落在 viewport 內。 */
  const FORM_BOXES: Readonly<Record<number, readonly number[]>> = {
    101: quad(120, 80, 200, 32), // heading 訂單
    104: quad(120, 140, 240, 24), // textbox 電子郵件
    106: quad(120, 180, 240, 24), // textbox 收件人
    108: quad(120, 220, 16, 16), // checkbox 訂閱電子報
    110: quad(120, 260, 80, 30), // button 刪除
    114: quad(120, 300, 60, 20), // link 說明
    116: quad(120, 340, 100, 100), // image 商品圖
    117: quad(120, 460, 100, 100), // image（沒有 alt）
  }

  it('form.json 加一個 OOPIF：ref 連續編號、OOPIF 節點的 bounds 已經加上 offset、未附著數進文字', async () => {
    const cdp = createFakeCdp()
    cdp.onSend('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 1024, clientHeight: 768 } }))
    cdp.onSend('Page.getFrameTree', () => frameTree('F-root', 'https://a.test/order'))
    cdp.onSend('Page.getFrameTree', () => frameTree('T-pay', 'https://pay.test/'), 's-pay')
    cdp.onSend('Accessibility.getFullAXTree', () => ({ nodes: FORM_AX.nodes }))
    cdp.onSend(
      'Accessibility.getFullAXTree',
      () => ({
        nodes: [
          { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: '付款' }, childIds: ['2'] },
          axNode('2', 'button', '確認付款', 201),
        ],
      }),
      's-pay'
    )
    cdp.onSend('DOM.getBoxModel', boxModel({ ...FORM_BOXES, 900: quad(100, 40, 300, 200) }))
    cdp.onSend('DOM.getBoxModel', boxModel({ 201: quad(8, 12, 120, 30) }), 's-pay')
    cdp.onSend('Target.getTargets', () => ({
      targetInfos: [{ targetId: 'T-pay', type: 'iframe', parentId: 'T-page' }],
    }))
    cdp.onSend('DOM.getFrameOwner', () => ({ backendNodeId: 900 }))
    cdp.setAttachedTargets([target('T-pay', 's-pay', 'https://pay.test/')])
    cdp.setRearmErrors([new CdpError('re-arm 失敗', 'sessionClosed')])

    const { deps } = makeDeps(cdp)
    const input = await collectSnapshotInput(deps, 12, 'viewport')
    const { snapshot, refs, text } = buildSnapshot(input)

    expect(snapshot.frames.map((f) => f.frameId)).toEqual(['F-root', 'T-pay'])
    expect(refs.snapshotId).toBe(12)
    expect(refs.entries.get('s12-e0')).toEqual({ backendNodeId: 104, role: 'textbox', name: '電子郵件' })
    expect(refs.entries.get('s12-e4')).toEqual({ backendNodeId: 114, role: 'link', name: '說明' })
    // 編號跨 frame 連續：主 frame 用掉 e0 到 e4，OOPIF 的按鈕接在 e5。
    expect(refs.entries.get('s12-e5')).toEqual({
      sessionId: 's-pay',
      backendNodeId: 201,
      role: 'button',
      name: '確認付款',
    })
    // OOPIF 的按鈕在自己 frame 裡是 (8, 12)，加上 iframe 在主視窗的 (100, 40)。
    expect(snapshot.frames[1]?.nodes[0]?.bounds).toEqual({ x: 108, y: 52, width: 120, height: 30 })
    expect(text.split('\n')[0]).toBe('[iframe 未附著 1 個]')
    expect(text).toContain('[page] 訂單確認 https://a.test/order')
    expect(text).toContain('[iframe 1] https://pay.test/')
    expect(text).toContain('s12-e5 button "確認付款"')
    // 沒有 alt 的 image（name 為空）由 buildSnapshot 規則 2 濾掉，不佔行。
    expect(text).not.toContain('image ""')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/snapshot-collect.test.ts
```

實跑輸出（`src/main/view-tools/snapshot-collect.ts` 還不存在）：

```
Error: Cannot find module '../../src/main/view-tools/snapshot-collect.js' imported from .../tests/view-tools/snapshot-collect.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: 最小實作**

`src/main/view-tools/snapshot-collect.ts` 全文（381 行，分三段貼，實際是同一個檔）。第一段（型別、quad 與 viewport、frame 發現）：

```ts
import { CdpError } from '../cdp.js'
import type { CdpSession } from '../cdp.js'
import { INTERACTIVE_ROLES, STRUCTURAL_ROLES } from './snapshot.js'
import type { AxRawNode, FrameInput, SnapshotInput } from './snapshot.js'
import type { Point, Rect } from './types.js'

/** 契約 §9.1。cdp 只用得到三個方法，型別上就收窄，測試不必造整個 CdpSession。 */
export interface CollectDeps {
  readonly cdp: Pick<CdpSession, 'send' | 'getAttachedTargets' | 'getRearmErrors'>
  readonly currentUrl: () => string
  readonly currentTitle: () => string
  readonly now: () => number
  readonly logError: (error: Error) => void
}

/** 一次 snapshot 最多查幾個 DOM.getBoxModel（裁決 7）。跨 frame 共用同一份額度。 */
export const MAX_BOX_LOOKUPS = 1500

const ORIGIN: Point = { x: 0, y: 0 }

interface RawFrame {
  readonly id?: unknown
  readonly url?: unknown
}

interface RawFrameTreeNode {
  readonly frame?: RawFrame
  readonly childFrames?: readonly RawFrameTreeNode[]
}

interface DiscoveredFrame {
  readonly frameId: string
  readonly url: string
  readonly sessionId?: string
}

function errorOf(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

/**
 * CDP 的 quad 是 [x1,y1,x2,y2,x3,y3,x4,y4] 八個數字。取四點的最小外接矩形，
 * 不假設四點的排列順序（頁面有 transform 時 border 不是軸對齊的矩形）。
 */
function quadToRect(quad: unknown): Rect | null {
  if (!Array.isArray(quad) || quad.length < 8) return null
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < 8; i += 2) {
    const x = quad[i]
    const y = quad[i + 1]
    if (typeof x !== 'number' || !Number.isFinite(x)) return null
    if (typeof y !== 'number' || !Number.isFinite(y)) return null
    xs.push(x)
    ys.push(y)
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

/** viewport 取 root 的 cssVisualViewport（裁決 7）。抓不到寬高就是 CDP 回了預期外的形狀，直接失敗。 */
async function readViewport(deps: CollectDeps): Promise<Rect> {
  const metrics = await deps.cdp.send<{ cssVisualViewport?: { clientWidth?: unknown; clientHeight?: unknown } }>(
    'Page.getLayoutMetrics'
  )
  const width = metrics?.cssVisualViewport?.clientWidth
  const height = metrics?.cssVisualViewport?.clientHeight
  if (typeof width !== 'number' || !Number.isFinite(width) || typeof height !== 'number' || !Number.isFinite(height)) {
    throw new CdpError('Page.getLayoutMetrics 沒有回傳 cssVisualViewport 的寬高', 'invalid-response')
  }
  return { x: 0, y: 0, width, height }
}

/** 同一個 frameId 只留第一次看到的那筆：先進來的順序就是輸出順序（第一個是主 frame）。 */
function addFrame(into: Map<string, DiscoveredFrame>, frame: DiscoveredFrame): void {
  if (into.has(frame.frameId)) return
  into.set(frame.frameId, frame)
}

function addFrameTree(into: Map<string, DiscoveredFrame>, node: RawFrameTreeNode | undefined, sessionId?: string): void {
  if (node === undefined) return
  const id = node.frame?.id
  if (typeof id === 'string' && id !== '') {
    const url = node.frame?.url
    addFrame(into, {
      frameId: id,
      url: typeof url === 'string' ? url : '',
      ...(sessionId === undefined ? {} : { sessionId }),
    })
  }
  for (const child of node.childFrames ?? []) addFrameTree(into, child, sessionId)
}

/**
 * 裁決 6：root 的 Page.getFrameTree 只列同行程的子 frame，OOPIF 不在裡面
 * （RESULTS-03 實測），所以要再走一次 getAttachedTargets() 的 iframe target，
 * 每個 target 自己就是一個 frame（frameId 等於 targetId），再對它的 session
 * 呼叫一次 Page.getFrameTree 把它裡面的同行程子 frame 也納入。
 *
 * root 的 getFrameTree 失敗就整個 snapshot 失敗（連主 frame 都沒有，沒有東西可回）；
 * 個別 iframe target 的 getFrameTree 失敗只記錄，target 本身仍留在清單裡。
 */
async function discoverFrames(deps: CollectDeps): Promise<readonly DiscoveredFrame[]> {
  const frames = new Map<string, DiscoveredFrame>()
  const rootTree = await deps.cdp.send<{ frameTree?: RawFrameTreeNode }>('Page.getFrameTree')
  addFrameTree(frames, rootTree?.frameTree)
  for (const target of deps.cdp.getAttachedTargets()) {
    if (target.type !== 'iframe') continue
    addFrame(frames, { frameId: target.targetId, url: target.url, sessionId: target.sessionId })
    try {
      const tree = await deps.cdp.send<{ frameTree?: RawFrameTreeNode }>('Page.getFrameTree', {}, target.sessionId)
      addFrameTree(frames, tree?.frameTree, target.sessionId)
    } catch (e) {
      deps.logError(new Error(`iframe target ${target.targetId} 的 frame 樹抓不到：${errorOf(e).message}`, { cause: e }))
    }
  }
  return [...frames.values()]
}

/** 裁決 6 第 3 點：抓不到 AX 樹的 frame 略過並計入 unattachedFrames。 */
async function fetchAxNodes(deps: CollectDeps, frame: DiscoveredFrame): Promise<readonly AxRawNode[] | null> {
  try {
    const result = await deps.cdp.send<{ nodes?: unknown }>(
      'Accessibility.getFullAXTree',
      { frameId: frame.frameId },
      frame.sessionId
    )
    const nodes = result?.nodes
    if (!Array.isArray(nodes)) {
      deps.logError(new Error(`frame ${frame.frameId} 的 Accessibility.getFullAXTree 沒有回傳 nodes 陣列`))
      return null
    }
    return nodes as readonly AxRawNode[]
  } catch (e) {
    deps.logError(new Error(`frame ${frame.frameId} 的 AX 樹抓不到：${errorOf(e).message}`, { cause: e }))
    return null
  }
}
```

第二段（offset，裁決 7）：

```ts
interface OwnerStep {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly dx: number
  readonly dy: number
}

interface RawTargetInfo {
  readonly targetId?: unknown
  /** 兩個欄位都選填：裁決 26 照探針 spikes/probe-oopif.ts:125 的讀法，先 parentId 再 parentFrameId。 */
  readonly parentId?: unknown
  readonly parentFrameId?: unknown
}

/** 裁決 7 第 2 步：TargetInfo 的父欄位才是結構，清單順序不是。 */
async function findParentTargetId(deps: CollectDeps, targetId: string): Promise<string> {
  const result = await deps.cdp.send<{ targetInfos?: unknown }>('Target.getTargets')
  const infos = result?.targetInfos
  const entry = Array.isArray(infos)
    ? (infos as readonly RawTargetInfo[]).find((t) => t?.targetId === targetId)
    : undefined
  const parentId = entry?.parentId ?? entry?.parentFrameId
  if (typeof parentId !== 'string' || parentId === '') {
    throw new CdpError(`Target.getTargets 找不到 target ${targetId} 的父 target`, 'frame-detached')
  }
  return parentId
}

/**
 * 裁決 7 第 1 到 4 步：這個 session 的頂層 frame 在「父 session 座標系」裡的左上角。
 * 任何一步失敗都往外丟（裁決 29）：CDP 指令的錯誤原樣傳出去，找不到 session 或 target
 * 丟 code 'frame-detached'，CDP 回了預期外的形狀丟 code 'invalid-response'。
 */
async function ownerStep(deps: CollectDeps, sessionId: string): Promise<OwnerStep> {
  const targets = deps.cdp.getAttachedTargets()
  const self = targets.find((t) => t.sessionId === sessionId)
  if (self === undefined) {
    throw new CdpError(`getAttachedTargets 找不到 sessionId ${sessionId} 的 target`, 'frame-detached')
  }
  const parentTargetId = await findParentTargetId(deps, self.targetId)
  // 父 target 不在附著清單裡代表父就是頁面本身，指令送 root（sessionId 為 undefined）。
  const parentSessionId = targets.find((t) => t.targetId === parentTargetId)?.sessionId
  const owner = await deps.cdp.send<{ backendNodeId?: unknown }>(
    'DOM.getFrameOwner',
    { frameId: self.targetId },
    parentSessionId
  )
  const backendNodeId = owner?.backendNodeId
  if (typeof backendNodeId !== 'number') {
    throw new CdpError(`DOM.getFrameOwner 沒有回傳 frame ${self.targetId} 的 backendNodeId`, 'invalid-response')
  }
  const box = await deps.cdp.send<{ model?: { content?: unknown } }>(
    'DOM.getBoxModel',
    { backendNodeId },
    parentSessionId
  )
  const rect = quadToRect(box?.model?.content)
  if (rect === null) {
    throw new CdpError(`DOM.getBoxModel 沒有回傳 frame ${self.targetId} 可用的 content 矩形`, 'invalid-response')
  }
  return { sessionId, parentSessionId, dx: rect.x, dy: rect.y }
}

/**
 * 一個 session 的頂層 frame 在主視窗 viewport 裡的位置（裁決 7）。root 為 {0,0}。
 *
 * 沿 target 的父欄位鏈往上走到 root，把每一層的左上角加起來：巢狀 OOPIF
 * （SSO 登入框包在金流 iframe 裡）要加兩層以上才會對。寫成迴圈而不是遞迴，
 * 是為了讓「parentId 成環」這種結構異常只是一個 throw，不必在遞迴的每一層各自處理。
 *
 * 任一層失敗整條往外丟，不回退成 {0,0}（裁決 29）：算不出來時給一個「看起來合理
 * 但其實是 iframe 內部座標」的值，會讓 click 點到主頁上的別的東西。要不要容忍失敗
 * 由呼叫端決定：snapshot 端自己 catch 成 {0,0}（節點清單仍有價值），click 端不 catch。
 *
 * cache 由呼叫端提供並在同一次 snapshot 內共用（裁決 7「同一次 snapshot 內以
 * sessionId 快取，不重算」）；controller 點擊時重算 offset 只傳兩個參數即可。
 * 只有成功解析的層會進 cache，失敗不留下任何紀錄。
 */
export async function resolveFrameOffset(
  deps: CollectDeps,
  sessionId: string | undefined,
  cache: Map<string, Point> = new Map()
): Promise<Point> {
  if (sessionId === undefined) return ORIGIN
  const steps: OwnerStep[] = []
  const walking = new Set<string>()
  let base = ORIGIN
  let current: string | undefined = sessionId
  while (current !== undefined) {
    const cached = cache.get(current)
    if (cached !== undefined) {
      base = cached
      break
    }
    if (walking.has(current)) {
      throw new CdpError(`target 的父欄位形成迴圈（sessionId ${current}）`, 'invalid-response')
    }
    walking.add(current)
    const step = await ownerStep(deps, current)
    steps.push(step)
    current = step.parentSessionId
  }
  let acc = base
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step === undefined) continue
    acc = { x: acc.x + step.dx, y: acc.y + step.dy }
    cache.set(step.sessionId, acc)
  }
  return acc
}

/**
 * 裁決 29 的 snapshot 端：offset 算不出來時該 frame 的 offset 用 {0,0} 並 logError，
 * frame 照常列入（節點與 ref 仍然可用，view_type 不需要座標）。同一個 session
 * 只記一次，不會因為它底下有五個 frame 就記五次。
 */
async function frameOffset(
  deps: CollectDeps,
  sessionId: string | undefined,
  cache: Map<string, Point>,
  failed: Set<string>
): Promise<Point> {
  if (sessionId === undefined) return ORIGIN
  if (failed.has(sessionId)) return ORIGIN
  try {
    return await resolveFrameOffset(deps, sessionId, cache)
  } catch (e) {
    failed.add(sessionId)
    deps.logError(
      new Error(`session ${sessionId} 的 offset 算不出來，這個 frame 的座標以 {0,0} 計：${errorOf(e).message}`, {
        cause: e,
      })
    )
    return ORIGIN
  }
}
```

第三段（box 蒐集與 `collectSnapshotInput`）：

```ts
/** buildSnapshot 規則 2 裡「不必查 box 就能排除」的那半：ignored、角色白名單、有 backendDOMNodeId。 */
function candidateBackendNodeId(node: AxRawNode): number | undefined {
  if (node.ignored !== false) return undefined
  const role = node.role?.value
  if (typeof role !== 'string') return undefined
  if (!INTERACTIVE_ROLES.has(role) && !STRUCTURAL_ROLES.has(role)) return undefined
  return node.backendDOMNodeId
}

interface BoxBudget {
  remaining: number
  skipped: number
}

/**
 * 逐個 await（裁決 7）：一次幾百個 CDP 指令並發會讓 Electron 的 debugger 排隊到逾時。
 * getBoxModel 失敗是常態（display: none 的元素在 AX 樹裡還在），不記錄，
 * 沒有矩形的節點由 buildSnapshot 規則 2 略過。
 */
async function collectBoxes(
  deps: CollectDeps,
  sessionId: string | undefined,
  nodes: readonly AxRawNode[],
  budget: BoxBudget
): Promise<ReadonlyMap<number, Rect>> {
  const boxes = new Map<number, Rect>()
  for (const node of nodes) {
    const backendNodeId = candidateBackendNodeId(node)
    if (backendNodeId === undefined) continue
    if (budget.remaining <= 0) {
      budget.skipped += 1
      continue
    }
    budget.remaining -= 1
    try {
      const box = await deps.cdp.send<{ model?: { border?: unknown } }>(
        'DOM.getBoxModel',
        { backendNodeId },
        sessionId
      )
      const rect = quadToRect(box?.model?.border)
      if (rect !== null) boxes.set(backendNodeId, rect)
    } catch {
      // 略過：沒有矩形就等同不存在
    }
  }
  return boxes
}

/**
 * 蒐集 buildSnapshot（Task 4）需要的全部輸入：frame 清單、每個 frame 的 AX 樹、
 * 矩形表、offset 與 viewport。純粹是 I/O，過濾與編號的規則全在 snapshot.ts。
 */
export async function collectSnapshotInput(
  deps: CollectDeps,
  id: number,
  scope: 'viewport' | 'full'
): Promise<SnapshotInput> {
  const viewport = await readViewport(deps)
  const discovered = await discoverFrames(deps)
  const offsets = new Map<string, Point>()
  const failedOffsets = new Set<string>()
  const budget: BoxBudget = { remaining: MAX_BOX_LOOKUPS, skipped: 0 }
  const frames: FrameInput[] = []
  let unattachedFrames = 0

  for (const frame of discovered) {
    const nodes = await fetchAxNodes(deps, frame)
    if (nodes === null) {
      unattachedFrames += 1
      continue
    }
    const offset = await frameOffset(deps, frame.sessionId, offsets, failedOffsets)
    const boxes = await collectBoxes(deps, frame.sessionId, nodes, budget)
    frames.push({
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      frameId: frame.frameId,
      url: frame.url,
      offset,
      nodes,
      boxes,
    })
  }

  if (budget.skipped > 0) {
    deps.logError(
      new Error(`snapshot 的候選節點超過 ${MAX_BOX_LOOKUPS} 個，有 ${budget.skipped} 個沒有查矩形，不會出現在 snapshot 裡`)
    )
  }
  // 裁決 6 第 4 點：re-arm 失敗代表有子代 target 沒附著上，數字不能是 0。
  if (deps.cdp.getRearmErrors().length > 0) unattachedFrames = Math.max(1, unattachedFrames)

  return {
    id,
    takenAt: deps.now(),
    url: deps.currentUrl(),
    title: deps.currentTitle(),
    scope,
    viewport,
    frames,
    unattachedFrames,
  }
}
```

實作上兩個值得說明的取捨。第一，box 查詢是照 `nodes` 陣列順序走，不是照 `childIds` 的深度優先順序：順序只影響「超過 1500 個候選時哪些查得到矩形」這個已經降級的情況，而深度優先的規則是 Task 4 `snapshot.ts` 裡 `traverse()` 的職責，在這裡再寫一次等於同一條規則有兩份實作、兩邊可能各自改壞。`Accessibility.getFullAXTree` 實機回來的陣列本來就是前序（Task 4 的 `form.real.json` 是這樣，手寫的 `form.json` 才刻意打亂），所以真實資料上兩者一致。

第二，`candidateBackendNodeId` 只做「不必查 box 就能排除」的那三條（ignored、角色白名單、有 `backendDOMNodeId`），不做 `STRUCTURAL_ROLES` 的 name 非空檢查。那條是 `buildSnapshot` 規則 2 的一部分，放進來會變成兩個檔案各持有半條規則；多查幾個 `getBoxModel` 的代價遠小於規則散在兩處的代價。

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/snapshot-collect.test.ts
```

實跑輸出：

```
 Test Files  1 passed (1)
      Tests  36 passed (36)
```

型別檢查（實跑，零輸出、結束碼 0）：

```bash
npx tsc --noEmit
```

本模組自己的覆蓋率（實跑，兩個門檻都過：Stmts ≥ 93、Branch ≥ 86）：

```bash
npx vitest run --coverage --coverage.reporter=text \
  --coverage.include='src/main/view-tools/snapshot-collect.ts' \
  tests/view-tools/snapshot-collect.test.ts
```

```
 ...hot-collect.ts |   96.89 |    89.65 |     100 |     100 |
```

- [ ] **Step 5: 突變測試**

八個突變，全部在 worktree 實跑。每一個都先確認變紅、記下變紅的測試名稱，還原後確認回到 36 passed。

**突變 1：offset 不往上遞迴，只算自己在父層裡的位置**

```diff
     steps.push(step)
-    current = step.parentSessionId
+    current = undefined
```

```bash
npx vitest run tests/view-tools/snapshot-collect.test.ts
```

變紅 6 個（30 passed）：`兩層 OOPIF：offset 是整條父鏈相加，不是只有自己那一層`、`getFrameOwner 送到父 session：T-inner 問 s-outer，T-outer 問 root`、`TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）`、`父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）`、`父欄位成環時往外丟 invalid-response，不會無限打轉`、`同一次 snapshot 內同一個 session 只算一次（快取）`。這是裁決 7 最容易被寫成的錯誤版本：單層 OOPIF 測起來完全正確，只有巢狀兩層才會露餡，所以測試資料一定要有兩層而且兩層的值都非零。還原後 36 passed。

**突變 2：`Target.getTargets` 找不到 parentId 時當成「父就是頁面本身」**

```diff
   const parentId = entry?.parentId ?? entry?.parentFrameId
-  if (typeof parentId !== 'string' || parentId === '') {
-    throw new CdpError(`Target.getTargets 找不到 target ${targetId} 的父 target`, 'frame-detached')
-  }
-  return parentId
+  return typeof parentId === 'string' ? parentId : ''
```

變紅 3 個（33 passed）：`Target.getTargets 找不到這個 target 的父 target 時往外丟 frame-detached（裁決 29）`、`TargetInfo 有這個 target 但兩個父欄位都沒有時往外丟 frame-detached`、`父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）`。空字串找不到對應 target，於是 `parentSessionId` 變成 undefined、指令改送 root，算出一個看起來合理但其實是別人座標系的 offset，而且一聲不吭。還原後 36 passed。

**突變 3：`MAX_BOX_LOOKUPS` 改成每個 frame 各自一份額度**

```diff
     if (nodes === null) {
       unattachedFrames += 1
       continue
     }
+    budget.remaining = MAX_BOX_LOOKUPS
     const offset = await frameOffset(deps, frame.sessionId, offsets, failedOffsets)
```

變紅 1 個（35 passed）：`額度跨 frame 共用：兩個各 800 個候選的 frame 只查 1500 次，多的不查也不進 boxes，並記錄一次`（實際查了 1600 次、第二個 frame 拿到 800 個矩形而不是 700 個）。這個突變說明為什麼那個測試要用「兩個各 800 個」而不是「一個 1600 個」：單一 frame 的測試對兩種寫法都會通過。還原後 36 passed。

**突變 4：拿掉 `getRearmErrors()` 非空時的下限**

```diff
-  // 裁決 6 第 4 點：re-arm 失敗代表有子代 target 沒附著上，數字不能是 0。
-  if (deps.cdp.getRearmErrors().length > 0) unattachedFrames = Math.max(1, unattachedFrames)
-
```

變紅 2 個（34 passed）：`getRearmErrors 非空、但所有 frame 的 AX 樹都抓得到時，unattachedFrames 仍至少是 1`、`form.json 加一個 OOPIF：ref 連續編號、OOPIF 節點的 bounds 已經加上 offset、未附著數進文字`（後者的第一行從 `[iframe 未附著 1 個]` 變成 `[page] …`）。還原後 36 passed。

**突變 5：`Target.getTargets` 的回傳用清單第一筆，不用 targetId 精確比對**

```diff
   const entry = Array.isArray(infos)
-    ? (infos as readonly RawTargetInfo[]).find((t) => t?.targetId === targetId)
+    ? (infos as readonly RawTargetInfo[])[0]
     : undefined
```

變紅 11 個（25 passed）：`單層 OOPIF：offset 就是父 session 裡 content 的左上角`、`兩層 OOPIF：offset 是整條父鏈相加，不是只有自己那一層`、`getFrameOwner 送到父 session：T-inner 問 s-outer，T-outer 問 root`、`Target.getTargets 找不到這個 target 的父 target 時往外丟 frame-detached（裁決 29）`、`TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）`、`DOM.getFrameOwner 失敗時把原本的 CdpError 原樣往外丟，不換成別的 code`、`DOM.getFrameOwner 沒有回傳 backendNodeId 時往外丟 invalid-response`、`父那一層算不出來時整條往外丟，不拿自己那層的 offset 當答案（裁決 29）`、`content 的四點順序打亂時取最小外接矩形的左上角`、`content 不是八個數字時往外丟 invalid-response`、`同一次 snapshot 內同一個 session 只算一次（快取）`。這正是 RESULTS-03「`getTargets` 回整個 browser context 的 target，不能拿清單順序當結構」那一條，所以測試的 `targetInfos` 刻意排成 `[T-page, T-inner, T-outer]`，跟父子順序不一致。還原後 36 passed。

**突變 6：`quadToRect` 取第一個點，不取四點的最小值**

```diff
-  const minX = Math.min(...xs)
-  const minY = Math.min(...ys)
-  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
+  const [x0 = 0, y0 = 0] = [xs[0], ys[0]]
+  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 }
```

變紅 2 個（34 passed）：`content 的四點順序打亂時取最小外接矩形的左上角`、`border 取四點的最小外接矩形，順序打亂與非軸對齊都算得出來`。四點若照左上、右上、右下、左下排列，兩種寫法同值，所以這兩個測試的 quad 一個是順序打亂、一個是旋轉過的菱形。還原後 36 passed。

**突變 7：只讀 `parentId`，拿掉 `parentFrameId` 的退路（裁決 26）**

```diff
-  const parentId = entry?.parentId ?? entry?.parentFrameId
+  const parentId = entry?.parentId
```

變紅 1 個（35 passed）：`TargetInfo 只有 parentFrameId 沒有 parentId 時照樣算得出非零 offset（裁決 26）`。這個突變擋的是「照 CDP 文件只讀一個欄位」這種看起來最正規的寫法：真的發生時不會有錯誤訊息，只有全部 OOPIF 的座標一起變成 `{0,0}`，點擊落在主視窗左上角。還原後 36 passed。

**突變 8：`collectSnapshotInput` 不 catch offset 的失敗（裁決 29 的 snapshot 端）**

```diff
   if (sessionId === undefined) return ORIGIN
   if (failed.has(sessionId)) return ORIGIN
-  try {
-    return await resolveFrameOffset(deps, sessionId, cache)
-  } catch (e) {
-    failed.add(sessionId)
-    deps.logError(
-      new Error(`session ${sessionId} 的 offset 算不出來，這個 frame 的座標以 {0,0} 計：${errorOf(e).message}`, {
-        cause: e,
-      })
-    )
-    return ORIGIN
-  }
+  return await resolveFrameOffset(deps, sessionId, cache)
```

變紅 1 個（35 passed）：`offset 算不出來時該 frame 用 {0,0}、記錄一次，frame 與它的節點照常列入`（整個 `collectSnapshotInput` 改成 reject）。這個突變與突變 1 到 7 的方向相反：其他七個防的是「算錯」，這一個防的是「一個 OOPIF 的座標算不出來就整份 snapshot 都不給」，模型連頁面上還有什麼都看不到。還原後 36 passed。

- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/snapshot-collect.ts tests/view-tools/snapshot-collect.test.ts
git commit -m "feat: 用 CDP 蒐集 snapshot 輸入（frame 樹、AX 樹、矩形與 OOPIF offset）"
```

