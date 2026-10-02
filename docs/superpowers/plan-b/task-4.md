### Task 4: snapshot 純函式與 fixture（snapshot.ts）

`view_snapshot` 的難處不在抓資料，在把一棵幾百到幾千個節點的無障礙樹壓成模型讀得懂又不爆 context 的文字。這個 task 只做「壓」這件事，把它寫成一個沒有副作用的函式：輸入是已經蒐集好的 AX 樹、矩形表與 viewport（Task 5 的 `collectSnapshotInput` 負責生產），輸出是 `Snapshot`、`RefTable` 與文字三件套。這樣切的理由是 CDP 蒐集那段沒辦法在單元測試裡跑，而過濾與編號的規則正是最容易寫錯又最難從實機看出錯的部分：ref 錯一號，agent 就點到隔壁的按鈕。

八條規則裡有三條是實機教出來的。第一條「從 `nodes[0]` 起依 `childIds` 深度優先」：`Accessibility.getFullAXTree` 的 `nodes` 陣列順序不保證等於樹的前序，照陣列跑會得到跟畫面不一樣的順序，所以本檔的 fixture 故意把陣列打亂（只留 `nodes[0]` 是 RootWebArea），實機抓回來的 `form.real.json` 陣列是前序，兩份都要過同一組測試。第二條「沒有矩形就略過」：`display: none` 的元素在 AX 樹裡還在，`DOM.getBoxModel` 會失敗，Task 5 不會把它放進 `boxes`，這裡直接當它不存在。第三條「structural 角色要求 name 非空」：沒有 alt 的 `<img>` 在 AX 樹裡是 `role: image` 且 `name: ''`，列出來只是浪費行數。

ref 只配給可操作角色，heading 與 image 出現在文字裡但沒有 ref 欄。這是刻意的：模型需要 heading 來判斷自己在頁面的哪一區，但點 heading 沒有意義，給了 ref 反而誘導它去點。編號 `e<n>` 從 0 起、跨 frame 連續遞增、structural 節點不佔號（契約 §6 規則 5 與文字格式範例的 `s12-e0`／`s12-e1`／`s12-e2` 一致）。

座標一律換算成主視窗 viewport 座標：`bounds` = frame 自身的 border 矩形加上 `FrameInput.offset`（OOPIF 才非零，裁決 7）。`scope: 'viewport'` 的可視判定用換算後的 `bounds` 比對，而且是閉區間（邊緣相切算看得到）。這兩件事在測試裡都用非零 offset 與不對稱矩形釘死，因為 offset 為 0、矩形正方形的測試對「忘了加 offset」「x 與 y 寫反」「開區間寫成閉區間」三種寫法都會巧合地通過。

本檔只依賴 `types.ts` 的型別，不 import Electron、不 import CDP，也不讀時鐘：`takenAt` 與 `id` 都由呼叫端給。`formatSnapshotText` 另外收一個 `intervention` 字串（`watch.ts` 的 `summarizeIntervention` 輸出，契約 §9.3），Task 9 的 controller 會把兩者串起來。

**Files:**

- Create `src/main/view-tools/snapshot.ts`（265 行，契約 §6 的全部匯出；未超過 400 行，不拆 `snapshot-text.ts`）
- Create `tests/fixtures/ax/form.json`（手寫的 `Accessibility.getFullAXTree` 回傳）
- Create `tests/fixtures/view/form.html`（與 `form.json` 對應的最小頁面，Task 14 用它抓 `form.real.json`）
- Test `tests/view-tools/snapshot.test.ts`（494 行，39 個測試）

**Interfaces:**

Consumes（Task 0 的 `src/main/view-tools/types.ts`）：

```ts
import type { AxNode, FrameSnapshot, Point, Rect, RefEntry, RefTable, Snapshot } from './types.js'
```

Task 0 若尚未完成，先照契約 §5 把 `types.ts` 建出來（只有型別，沒有值），內容逐字照契約 §5 的程式碼區塊。

Produces（契約 §6 全部）：

```ts
export interface AxRawNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value: unknown }
  readonly name?: { readonly value: unknown }
  readonly value?: { readonly value: unknown }
  readonly properties?: readonly { readonly name: string; readonly value: { readonly value: unknown } }[]
  readonly childIds?: readonly string[]
  readonly backendDOMNodeId?: number
}
export interface FrameInput {
  readonly sessionId?: string
  readonly frameId: string
  readonly url: string
  readonly offset: Point
  readonly nodes: readonly AxRawNode[]
  readonly boxes: ReadonlyMap<number, Rect>
}
export interface SnapshotInput {
  readonly id: number
  readonly takenAt: number
  readonly url: string
  readonly title: string
  readonly scope: 'viewport' | 'full'
  readonly viewport: Rect
  readonly frames: readonly FrameInput[]
  readonly unattachedFrames: number
}
export interface SnapshotResult {
  readonly snapshot: Snapshot
  readonly refs: RefTable
  readonly text: string
}
export const MAX_SNAPSHOT_NODES = 400
export const INTERACTIVE_ROLES: ReadonlySet<string>
export const STRUCTURAL_ROLES: ReadonlySet<string>
export function buildSnapshot(input: SnapshotInput): SnapshotResult
export function rectsIntersect(a: Rect, b: Rect): boolean
export function formatSnapshotText(snapshot: Snapshot, intervention?: string | null): string
```

下游：Task 5 的 `collectSnapshotInput` 產生 `SnapshotInput`；Task 9 的 controller 呼叫 `buildSnapshot` 與 `formatSnapshotText(snapshot, summary)`（第二參數收 `string | null | undefined`，裁決 22）；Task 14 把實機抓到的 `form.real.json` 加進本檔測試的 `AX_FIXTURES` 陣列。

---

- [ ] **Step 1a: 建兩份 fixture**

`tests/fixtures/view/form.html`（Task 14 會用 `spikes/capture-ax.ts` 對這個檔抓 `form.real.json`）：

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>訂單確認</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 80px 120px; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <h1>訂單</h1>
    <div>
      <label>電子郵件<input type="email" name="email" required /></label>
      <label>收件人<input type="text" name="recipient" value="王小明" /></label>
      <label>訂閱電子報<input type="checkbox" name="news" checked /></label>
      <button type="button" disabled>刪除</button>
      <button type="button" class="hidden">隱藏</button>
    </div>
    <a href="/help">說明</a>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="商品圖" width="100" height="100" />
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="100" height="100" />
  </body>
</html>
```

`tests/fixtures/ax/form.json`：手寫，形狀照 `Accessibility.getFullAXTree` 的 `{ nodes: AXNode[] }`。三個刻意的安排：

1. `nodes[0]` 是 RootWebArea，其餘節點的陣列順序刻意打亂（不是前序），用來釘死「照 `childIds` 走，不照陣列走」。
2. `checked` 用 `{ "type": "tristate", "value": "true" }`：CDP 的 `AXPropertyName.checked` 對應 `AXValueType.tristate`，值是字串（Task 14 用 Electron 44 實機抓的 `form.real.json` 確認就是這個形狀；契約 §6 規則 6 同時接受字串與 boolean）。`disabled` 用 `boolean`、`required` 用 `booleanOrUndefined`。
3. 每個 textbox 都帶 `invalid`／`focusable`／`editable`／`settable`／`multiline`／`readonly` 這些 Chrome 實際會回的 property，用來釘死「表外的 property 一律不看」與「`readonly: false` 不產生 state」。

```json
{
  "nodes": [
    {
      "nodeId": "1",
      "ignored": false,
      "role": { "type": "internalRole", "value": "RootWebArea" },
      "name": { "type": "computedString", "value": "訂單確認" },
      "childIds": ["2", "3", "14", "16", "17"],
      "backendDOMNodeId": 1,
      "frameId": "FRAME-ROOT"
    },
    {
      "nodeId": "16",
      "ignored": false,
      "role": { "type": "role", "value": "image" },
      "name": { "type": "computedString", "value": "商品圖" },
      "childIds": [],
      "backendDOMNodeId": 116
    },
    {
      "nodeId": "4",
      "ignored": false,
      "role": { "type": "role", "value": "textbox" },
      "name": { "type": "computedString", "value": "電子郵件" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "editable", "value": { "type": "token", "value": "plaintext" } },
        { "name": "settable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "multiline", "value": { "type": "boolean", "value": false } },
        { "name": "readonly", "value": { "type": "booleanOrUndefined", "value": false } },
        { "name": "required", "value": { "type": "booleanOrUndefined", "value": true } }
      ],
      "childIds": [],
      "backendDOMNodeId": 104
    },
    {
      "nodeId": "20",
      "ignored": false,
      "role": { "type": "internalRole", "value": "StaticText" },
      "name": { "type": "computedString", "value": "訂單" },
      "childIds": [],
      "backendDOMNodeId": 102
    },
    {
      "nodeId": "10",
      "ignored": false,
      "role": { "type": "role", "value": "button" },
      "name": { "type": "computedString", "value": "刪除" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "disabled", "value": { "type": "boolean", "value": true } }
      ],
      "childIds": [],
      "backendDOMNodeId": 110
    },
    {
      "nodeId": "3",
      "ignored": false,
      "role": { "type": "role", "value": "generic" },
      "name": { "type": "computedString", "value": "" },
      "childIds": ["4", "6", "8", "10", "12"],
      "backendDOMNodeId": 103
    },
    {
      "nodeId": "17",
      "ignored": false,
      "role": { "type": "role", "value": "image" },
      "name": { "type": "computedString", "value": "" },
      "childIds": [],
      "backendDOMNodeId": 117
    },
    {
      "nodeId": "8",
      "ignored": false,
      "role": { "type": "role", "value": "checkbox" },
      "name": { "type": "computedString", "value": "訂閱電子報" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "checked", "value": { "type": "tristate", "value": "true" } }
      ],
      "childIds": [],
      "backendDOMNodeId": 108
    },
    {
      "nodeId": "14",
      "ignored": false,
      "role": { "type": "role", "value": "link" },
      "name": { "type": "computedString", "value": "說明" },
      "properties": [
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } }
      ],
      "childIds": ["21"],
      "backendDOMNodeId": 114
    },
    {
      "nodeId": "6",
      "ignored": false,
      "role": { "type": "role", "value": "textbox" },
      "name": { "type": "computedString", "value": "收件人" },
      "value": { "type": "string", "value": "王小明" },
      "properties": [
        { "name": "invalid", "value": { "type": "token", "value": "false" } },
        { "name": "focusable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "editable", "value": { "type": "token", "value": "plaintext" } },
        { "name": "settable", "value": { "type": "booleanOrUndefined", "value": true } },
        { "name": "multiline", "value": { "type": "boolean", "value": false } },
        { "name": "readonly", "value": { "type": "booleanOrUndefined", "value": false } },
        { "name": "required", "value": { "type": "booleanOrUndefined", "value": false } }
      ],
      "childIds": [],
      "backendDOMNodeId": 106
    },
    {
      "nodeId": "21",
      "ignored": false,
      "role": { "type": "internalRole", "value": "StaticText" },
      "name": { "type": "computedString", "value": "說明" },
      "childIds": [],
      "backendDOMNodeId": 115
    },
    {
      "nodeId": "12",
      "ignored": true,
      "ignoredReasons": [{ "name": "notRendered", "value": { "type": "boolean", "value": true } }],
      "role": { "type": "role", "value": "none" },
      "name": { "type": "computedString", "value": "隱藏" },
      "childIds": [],
      "backendDOMNodeId": 112
    },
    {
      "nodeId": "2",
      "ignored": false,
      "role": { "type": "role", "value": "heading" },
      "name": { "type": "computedString", "value": "訂單" },
      "properties": [{ "name": "level", "value": { "type": "integer", "value": 1 } }],
      "childIds": ["20"],
      "backendDOMNodeId": 101
    }
  ]
}
```

---

- [ ] **Step 1b: 寫失敗的測試**

`tests/view-tools/snapshot.test.ts` 全文（分三段貼，實際是同一個檔）。

`boxes` 不能用 `backendDOMNodeId` 當 key 寫死在測試裡：手寫的 `form.json` 與實機的 `form.real.json` 的 id 不同。改成用「角色｜名稱」查表，兩份 fixture 都適用；`display: none` 的 `button "隱藏"` 不在表裡（也是 `ignored: true`），兩條規則都會濾掉它，實機 fixture 不管把它標成哪一種都能過。

第一段（載入與工具函式）：

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildSnapshot,
  formatSnapshotText,
  rectsIntersect,
  INTERACTIVE_ROLES,
  STRUCTURAL_ROLES,
  MAX_SNAPSHOT_NODES,
  type AxRawNode,
  type FrameInput,
  type SnapshotInput,
} from '../../src/main/view-tools/snapshot.js'
import type { Rect } from '../../src/main/view-tools/types.js'

/**
 * Task 14 抓到實機的 form.real.json 之後只要加進這個陣列，同一組測試就會對它再跑一次。
 * 兩份 fixture 的差異只准出現在 nodeId 與屬性順序，所以測試不看 nodeId 也不看順序。
 */
const AX_FIXTURES = ['form.json'] as const

/** 矩形以「角色｜名稱」對應，才不會綁死 backendDOMNodeId（兩份 fixture 的 id 不同）。 */
const FORM_BOXES: ReadonlyMap<string, Rect> = new Map([
  ['heading|訂單', { x: 120, y: 80, width: 200, height: 32 }],
  ['textbox|電子郵件', { x: 120, y: 140, width: 240, height: 24 }],
  ['textbox|收件人', { x: 120, y: 180, width: 240, height: 24 }],
  ['checkbox|訂閱電子報', { x: 120, y: 220, width: 16, height: 16 }],
  ['button|刪除', { x: 120, y: 260, width: 80, height: 30 }],
  ['link|說明', { x: 120, y: 300, width: 60, height: 20 }],
  ['image|商品圖', { x: 120, y: 340, width: 100, height: 100 }],
  ['image|', { x: 120, y: 460, width: 100, height: 100 }],
])

function readAxFixture(file: string): readonly AxRawNode[] {
  const raw: unknown = JSON.parse(readFileSync(`tests/fixtures/ax/${file}`, 'utf8'))
  const nodes = (raw as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) throw new Error(`fixture ${file} 沒有 nodes 陣列`)
  return nodes as readonly AxRawNode[]
}

/** display: none 的 button 拿不到矩形（getBoxModel 會失敗），所以不進 boxes。 */
function boxesFor(nodes: readonly AxRawNode[]): ReadonlyMap<number, Rect> {
  const out = new Map<number, Rect>()
  for (const node of nodes) {
    const role = typeof node.role?.value === 'string' ? node.role.value : ''
    const name = typeof node.name?.value === 'string' ? node.name.value : ''
    const box = FORM_BOXES.get(`${role}|${name}`)
    if (node.ignored === false && node.backendDOMNodeId !== undefined && box !== undefined) {
      out.set(node.backendDOMNodeId, box)
    }
  }
  return out
}

function formInput(file: string, over: Partial<SnapshotInput> = {}): SnapshotInput {
  const nodes = readAxFixture(file)
  return {
    id: 7,
    takenAt: 1_700_000_000_000,
    url: 'https://example.test/form.html',
    title: '訂單確認',
    scope: 'full',
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    frames: [{ frameId: 'FRAME-ROOT', url: 'https://example.test/form.html', offset: { x: 0, y: 0 }, nodes, boxes: boxesFor(nodes) }],
    unattachedFrames: 0,
    ...over,
  }
}

/** 合成節點：只放規則用得到的欄位。 */
function raw(id: string, role: string, name: string, over: Partial<AxRawNode> = {}): AxRawNode {
  return { nodeId: id, ignored: false, role: { value: role }, name: { value: name }, childIds: [], backendDOMNodeId: Number(id), ...over }
}

function frame(nodes: readonly AxRawNode[], boxes: ReadonlyMap<number, Rect>, over: Partial<FrameInput> = {}): FrameInput {
  return { frameId: 'F', url: 'https://example.test/', offset: { x: 0, y: 0 }, nodes, boxes, ...over }
}

function input(frames: readonly FrameInput[], over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    id: 1,
    takenAt: 0,
    url: 'https://example.test/',
    title: 'T',
    scope: 'full',
    viewport: { x: 0, y: 0, width: 800, height: 600 },
    frames,
    unattachedFrames: 0,
    ...over,
  }
}

const BOX: Rect = { x: 10, y: 10, width: 10, height: 10 }
function boxesOf(...ids: readonly number[]): ReadonlyMap<number, Rect> {
  return new Map(ids.map((id) => [id, BOX]))
}

describe('fixture 守衛', () => {
  it.each(AX_FIXTURES)('%s 讀得到節點（fixture 被誤刪時測試會對空陣列跑然後全過）', (file) => {
    const nodes = readAxFixture(file)
    expect(nodes.length).toBeGreaterThanOrEqual(10)
    expect(boxesFor(nodes).size).toBe(FORM_BOXES.size)
  })
})

describe.each(AX_FIXTURES)('fixture %s：整棵 AX 樹的文字輸出', (file) => {
  it('依 childIds 深度優先排序，不是 nodes 陣列順序；ref 只給互動角色且從 e0 連續遞增', () => {
    const { snapshot, text } = buildSnapshot(formInput(file))
    expect(text).toBe(
      [
        '[page] 訂單確認 https://example.test/form.html',
        'heading "訂單"',
        's7-e0 textbox "電子郵件" (required)',
        's7-e1 textbox "收件人" value="王小明"',
        's7-e2 checkbox "訂閱電子報" (checked)',
        's7-e3 button "刪除" (disabled)',
        's7-e4 link "說明"',
        'image "商品圖"',
      ].join('\n'),
    )
    expect(snapshot.frames[0]?.nodes.map((n) => n.ref)).toEqual([
      undefined, 's7-e0', 's7-e1', 's7-e2', 's7-e3', 's7-e4', undefined,
    ])
  })

  it('display: none 的 button 與沒有 alt 的 image 都不出現，truncated 為 0', () => {
    const { snapshot, text } = buildSnapshot(formInput(file))
    expect(text).not.toContain('隱藏')
    expect(text.match(/image /g)).toHaveLength(1)
    expect(snapshot.truncated).toBe(0)
    expect(snapshot.frames[0]?.nodes).toHaveLength(7)
  })

  it('RefTable 的 key 是完整 ref、entries 帶 role 與 name，invalidatedBy 不設', () => {
    const { refs } = buildSnapshot(formInput(file))
    expect(refs.snapshotId).toBe(7)
    expect([...refs.entries.keys()]).toEqual(['s7-e0', 's7-e1', 's7-e2', 's7-e3', 's7-e4'])
    expect(refs.entries.get('s7-e3')).toEqual({ backendNodeId: expect.any(Number), role: 'button', name: '刪除' })
    expect(refs.invalidatedBy).toBeUndefined()
  })

  it('scope viewport 只留與 viewport 有交集的節點（y 260 的按鈕被 250 高的 viewport 濾掉）', () => {
    const { text } = buildSnapshot(formInput(file, { scope: 'viewport', viewport: { x: 0, y: 0, width: 800, height: 250 } }))
    expect(text.split('\n').slice(1)).toEqual([
      'heading "訂單"',
      's7-e0 textbox "電子郵件" (required)',
      's7-e1 textbox "收件人" value="王小明"',
      's7-e2 checkbox "訂閱電子報" (checked)',
    ])
  })

  it('scope full 不看 viewport：viewport 縮到 1x1 仍然七個節點', () => {
    const { snapshot } = buildSnapshot(formInput(file, { scope: 'full', viewport: { x: 0, y: 0, width: 1, height: 1 } }))
    expect(snapshot.frames[0]?.nodes).toHaveLength(7)
  })
})

```

第二段（座標、候選門檻、走訪、states、value）：

```ts
describe('rectsIntersect', () => {
  it('邊緣相切算有交集（閉區間）', () => {
    expect(rectsIntersect({ x: 100, y: 50, width: 20, height: 10 }, { x: 120, y: 50, width: 30, height: 10 })).toBe(true)
    expect(rectsIntersect({ x: 100, y: 40, width: 20, height: 10 }, { x: 100, y: 50, width: 20, height: 10 })).toBe(true)
  })

  it('差一單位就不相交', () => {
    expect(rectsIntersect({ x: 100, y: 50, width: 20, height: 10 }, { x: 121, y: 50, width: 30, height: 10 })).toBe(false)
    expect(rectsIntersect({ x: 100, y: 39, width: 20, height: 10 }, { x: 100, y: 50, width: 20, height: 10 })).toBe(false)
  })

  it('x 與 y 互換會得到不同答案（矩形不對稱，交換軸的實作會被抓到）', () => {
    const a: Rect = { x: 300, y: 10, width: 20, height: 500 }
    const b: Rect = { x: 0, y: 0, width: 100, height: 600 }
    expect(rectsIntersect(a, b)).toBe(false)
    expect(rectsIntersect({ x: a.y, y: a.x, width: a.height, height: a.width }, b)).toBe(true)
  })
})

describe('bounds 與 frame offset', () => {
  const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'button', '送出')]
  const boxes = new Map([[2, { x: 30, y: 20, width: 40, height: 10 }]])

  it('bounds 是矩形加上 frame offset（非零 offset）', () => {
    const { snapshot } = buildSnapshot(input([frame(nodes, boxes, { offset: { x: 120, y: 80 } })]))
    expect(snapshot.frames[0]?.nodes[0]?.bounds).toEqual({ x: 150, y: 100, width: 40, height: 10 })
  })

  it('viewport 判定用加過 offset 的 bounds：沒加 offset 會誤留在畫面外的節點', () => {
    const far = frame(nodes, boxes, { offset: { x: 900, y: 700 } })
    const kept = buildSnapshot(input([far], { scope: 'viewport', viewport: { x: 0, y: 0, width: 800, height: 600 } }))
    expect(kept.snapshot.frames[0]?.nodes).toHaveLength(0)
    const near = frame(nodes, boxes, { offset: { x: 120, y: 80 } })
    const inView = buildSnapshot(input([near], { scope: 'viewport', viewport: { x: 0, y: 0, width: 800, height: 600 } }))
    expect(inView.snapshot.frames[0]?.nodes).toHaveLength(1)
  })

  it('offset 的 x 與 y 不可互換：只在 y 方向超出時要被濾掉', () => {
    const out = buildSnapshot(input([frame(nodes, boxes, { offset: { x: 100, y: 700 } })], {
      scope: 'viewport',
      viewport: { x: 0, y: 0, width: 800, height: 400 },
    }))
    expect(out.snapshot.frames[0]?.nodes).toHaveLength(0)
    const swapped = buildSnapshot(input([frame(nodes, boxes, { offset: { x: 700, y: 100 } })], {
      scope: 'viewport',
      viewport: { x: 0, y: 0, width: 800, height: 400 },
    }))
    expect(swapped.snapshot.frames[0]?.nodes).toHaveLength(1)
  })
})

describe('候選節點的四道門檻', () => {
  const root = raw('1', 'RootWebArea', '', { childIds: ['2', '3', '4', '5', '6'] })

  it('ignored 為 true 的節點就算有矩形也不收', () => {
    const nodes = [root, raw('2', 'button', '甲', { ignored: true }), raw('3', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('boxes 沒有矩形的節點不收（getBoxModel 失敗等同不存在）', () => {
    const nodes = [root, raw('2', 'button', '甲'), raw('3', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(3))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('沒有 backendDOMNodeId 的節點不收', () => {
    const nodes = [root, { ...raw('2', 'button', '甲'), backendDOMNodeId: undefined }, raw('3', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('白名單外的角色不收；structural 角色名稱為空也不收，但互動角色名稱為空要收', () => {
    const nodes = [
      root,
      raw('2', 'paragraph', '段落'),
      raw('3', 'heading', ''),
      raw('4', 'button', ''),
      raw('5', 'heading', '標題'),
      { ...raw('6', 'button', '壞角色'), role: { value: 42 } },
    ]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3, 4, 5, 6))]))
    expect(snapshot.frames[0]?.nodes.map((n) => `${n.role}|${n.name}`)).toEqual(['button|', 'heading|標題'])
  })

  it('INTERACTIVE_ROLES 與 STRUCTURAL_ROLES 的內容照契約 §6', () => {
    expect([...INTERACTIVE_ROLES].sort()).toEqual(
      ['button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox'],
    )
    expect([...STRUCTURAL_ROLES].sort()).toEqual(['heading', 'image'])
  })
})

describe('走訪順序', () => {
  it('nodes 陣列順序與 childIds 順序相反時，輸出照 childIds', () => {
    const nodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2', '3'] }),
      raw('3', 'button', '丙', { childIds: [] }),
      raw('2', 'button', '乙', { childIds: ['4'] }),
      raw('4', 'button', '丁'),
    ]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2, 3, 4))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙', '丁', '丙'])
  })

  it('找不到的 childId 略過，不中斷同一層後面的兄弟', () => {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['9', '2'] }), raw('2', 'button', '乙')]
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    expect(snapshot.frames[0]?.nodes.map((n) => n.name)).toEqual(['乙'])
  })

  it('nodes 為空的 frame 得到空節點清單', () => {
    const { snapshot } = buildSnapshot(input([frame([], new Map())]))
    expect(snapshot.frames[0]?.nodes).toEqual([])
  })
})

describe('states', () => {
  function statesOf(properties: readonly { name: string; value: { value: unknown } }[]): readonly string[] {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'checkbox', 'X', { properties })]
    return buildSnapshot(input([frame(nodes, boxesOf(2))])).snapshot.frames[0]?.nodes[0]?.states ?? []
  }

  it('輸出順序固定，與 properties 的排列無關', () => {
    const props = [
      { name: 'pressed', value: { value: 'true' } },
      { name: 'required', value: { value: true } },
      { name: 'checked', value: { value: 'true' } },
      { name: 'disabled', value: { value: true } },
      { name: 'focused', value: { value: true } },
      { name: 'expanded', value: { value: true } },
      { name: 'selected', value: { value: true } },
      { name: 'readonly', value: { value: true } },
    ]
    const expected = ['disabled', 'checked', 'expanded', 'selected', 'required', 'focused', 'readonly', 'pressed']
    expect(statesOf(props)).toEqual(expected)
    expect(statesOf([...props].reverse())).toEqual(expected)
  })

  it('checked 的三種值分別對到 checked／unchecked／mixed，boolean 與 tristate 都吃', () => {
    expect(statesOf([{ name: 'checked', value: { value: 'true' } }])).toEqual(['checked'])
    expect(statesOf([{ name: 'checked', value: { value: true } }])).toEqual(['checked'])
    expect(statesOf([{ name: 'checked', value: { value: 'false' } }])).toEqual(['unchecked'])
    expect(statesOf([{ name: 'checked', value: { value: false } }])).toEqual(['unchecked'])
    expect(statesOf([{ name: 'checked', value: { value: 'mixed' } }])).toEqual(['mixed'])
  })

  it('expanded 為 false 是 collapsed；disabled／required 為 false 不產生任何 state', () => {
    expect(statesOf([{ name: 'expanded', value: { value: false } }])).toEqual(['collapsed'])
    expect(statesOf([{ name: 'disabled', value: { value: false } }, { name: 'required', value: { value: false } }])).toEqual([])
  })

  it('表外的 property 一律不看（focusable、editable、invalid、level）', () => {
    expect(statesOf([
      { name: 'focusable', value: { value: true } },
      { name: 'editable', value: { value: 'plaintext' } },
      { name: 'invalid', value: { value: 'false' } },
      { name: 'level', value: { value: 1 } },
    ])).toEqual([])
  })
})

describe('value', () => {
  function valueOf(value: unknown): string | undefined {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), { ...raw('2', 'textbox', 'X'), value: { value } }]
    return buildSnapshot(input([frame(nodes, boxesOf(2))])).snapshot.frames[0]?.nodes[0]?.value
  }

  it('只有非空字串才帶 value', () => {
    expect(valueOf('王小明')).toBe('王小明')
    expect(valueOf('')).toBeUndefined()
    expect(valueOf(0)).toBeUndefined()
    expect(valueOf(null)).toBeUndefined()
  })
})

```

第三段（400 上限、多 frame、文字格式、純函式性質）：

```ts
describe('400 上限', () => {
  function manyNodes(count: number): readonly AxRawNode[] {
    const ids = Array.from({ length: count }, (_, i) => String(i + 2))
    return [
      raw('1', 'RootWebArea', '', { childIds: ids }),
      ...ids.map((id, i) => raw(id, 'button', `按鈕${i}`)),
    ]
  }

  it('450 個候選只留 DFS 前 400 個，truncated 為 50', () => {
    const nodes = manyNodes(450)
    const boxes = new Map(nodes.slice(1).map((n) => [n.backendDOMNodeId ?? 0, BOX]))
    const { snapshot } = buildSnapshot(input([frame(nodes, boxes)]))
    const kept = snapshot.frames[0]?.nodes ?? []
    expect(kept).toHaveLength(MAX_SNAPSHOT_NODES)
    expect(snapshot.truncated).toBe(50)
    expect(kept[0]?.name).toBe('按鈕0')
    expect(kept[399]?.name).toBe('按鈕399')
    expect(kept.some((n) => n.name === '按鈕400')).toBe(false)
    expect(kept[399]?.ref).toBe('s1-e399')
  })

  it('剛好 400 個不算截斷', () => {
    const nodes = manyNodes(400)
    const boxes = new Map(nodes.slice(1).map((n) => [n.backendDOMNodeId ?? 0, BOX]))
    const { snapshot, text } = buildSnapshot(input([frame(nodes, boxes)]))
    expect(snapshot.truncated).toBe(0)
    expect(text).not.toContain('未列出')
  })

  it('被 viewport 濾掉的節點不算進 400 也不算進 truncated', () => {
    const nodes = manyNodes(410)
    const boxes = new Map(nodes.slice(1).map((n, i) => [n.backendDOMNodeId ?? 0, i < 20 ? { x: 5000, y: 5000, width: 10, height: 10 } : BOX]))
    const { snapshot } = buildSnapshot(input([frame(nodes, boxes)], { scope: 'viewport' }))
    expect(snapshot.frames[0]?.nodes).toHaveLength(390)
    expect(snapshot.truncated).toBe(0)
  })
})

describe('多個 frame', () => {
  function twoFrames(): SnapshotInput {
    const rootNodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2', '3'] }),
      raw('2', 'heading', '訂單'),
      raw('3', 'button', '送出'),
    ]
    const childNodes = [
      raw('11', 'RootWebArea', '', { childIds: ['12', '13'] }),
      raw('12', 'link', '說明'),
      raw('13', 'textbox', '搜尋'),
    ]
    return input(
      [
        frame(rootNodes, boxesOf(2, 3), { frameId: 'FRAME-ROOT', url: 'https://example.test/' }),
        frame(childNodes, boxesOf(12, 13), { frameId: 'FRAME-CHILD', url: 'https://ads.test/box', sessionId: 'S-1', offset: { x: 120, y: 80 } }),
      ],
      { id: 12, url: 'https://example.test/', title: '首頁' },
    )
  }

  it('ref 序號跨 frame 連續，iframe 的節點接在 root 之後', () => {
    const { snapshot, refs } = buildSnapshot(twoFrames())
    expect(snapshot.frames[0]?.nodes.map((n) => n.ref)).toEqual([undefined, 's12-e0'])
    expect(snapshot.frames[1]?.nodes.map((n) => n.ref)).toEqual(['s12-e1', 's12-e2'])
    expect([...refs.entries.keys()]).toEqual(['s12-e0', 's12-e1', 's12-e2'])
  })

  it('iframe 的節點帶 sessionId、bounds 已加 offset；root 的節點沒有 sessionId', () => {
    const { snapshot, refs } = buildSnapshot(twoFrames())
    expect(snapshot.frames[1]?.nodes[0]?.sessionId).toBe('S-1')
    expect(snapshot.frames[1]?.nodes[0]?.bounds).toEqual({ x: 130, y: 90, width: 10, height: 10 })
    expect(refs.entries.get('s12-e1')?.sessionId).toBe('S-1')
    expect('sessionId' in (refs.entries.get('s12-e0') ?? {})).toBe(false)
    expect(snapshot.frames[0]?.nodes[1]?.sessionId).toBeUndefined()
  })

  it('文字第一個 frame 是 [page]，其餘是 [iframe k]（k 從 1 起）', () => {
    const { text } = buildSnapshot(twoFrames())
    expect(text).toBe(
      [
        '[page] 首頁 https://example.test/',
        'heading "訂單"',
        's12-e0 button "送出"',
        '[iframe 1] https://ads.test/box',
        's12-e1 link "說明"',
        's12-e2 textbox "搜尋"',
      ].join('\n'),
    )
  })
})

describe('formatSnapshotText', () => {
  const base = buildSnapshot(input([frame(
    [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'button', '送出')],
    boxesOf(2),
  )])).snapshot

  it('沒有插手摘要時不多一行：省略、undefined、空字串、null 都一樣', () => {
    const plain = ['[page] T https://example.test/', 's1-e0 button "送出"'].join('\n')
    expect(formatSnapshotText(base)).toBe(plain)
    expect(formatSnapshotText(base, undefined)).toBe(plain)
    expect(formatSnapshotText(base, '')).toBe(plain)
    // summarizeIntervention() 回傳 string | null，controller 直接傳進來（裁決 22）
    expect(formatSnapshotText(base, null)).toBe(plain)
  })

  it('有插手摘要時放在最前面一行', () => {
    const summary = '使用者在你上次操作後點了 3 次、按了 12 個鍵，網址從 https://a.test/ 變成 https://b.test/'
    expect(formatSnapshotText(base, summary).split('\n')).toEqual([summary, '[page] T https://example.test/', 's1-e0 button "送出"'])
  })

  it('unattachedFrames 為 0 時沒有那一行，大於 0 時排在插手摘要之後', () => {
    expect(formatSnapshotText(base)).not.toContain('未附著')
    const withUnattached = { ...base, unattachedFrames: 2 }
    expect(formatSnapshotText(withUnattached, '摘要').split('\n').slice(0, 2)).toEqual(['摘要', '[iframe 未附著 2 個]'])
  })

  it('truncated 大於 0 時最後一行是截斷提示', () => {
    const lines = formatSnapshotText({ ...base, truncated: 37 }).split('\n')
    expect(lines[lines.length - 1]).toBe('（還有 37 個節點未列出，請縮小範圍或捲動後重拍）')
  })

  it('name 與 value 裡的雙引號與換行逸出', () => {
    const nodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2'] }),
      { ...raw('2', 'textbox', '請輸入「"暱稱"」\n第二行'), value: { value: '他說 "好"\r\n然後走了' } },
    ]
    const { text } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    expect(text.split('\n')[1]).toBe('s1-e0 textbox "請輸入「\\"暱稱\\"」\\n第二行" value="他說 \\"好\\"\\n然後走了"')
    expect(text.split('\n')).toHaveLength(2)
  })

  it('value 與 states 同時存在時 value 在前、states 在後，多個 state 以「、」連接', () => {
    const nodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2'] }),
      {
        ...raw('2', 'textbox', '電子郵件'),
        value: { value: 'a@b.c' },
        properties: [{ name: 'required', value: { value: true } }, { name: 'disabled', value: { value: true } }],
      },
    ]
    const { text } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    expect(text.split('\n')[1]).toBe('s1-e0 textbox "電子郵件" value="a@b.c" (disabled、required)')
  })
})

describe('純函式性質', () => {
  it('buildSnapshot 不改動輸入', () => {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'button', '送出')]
    const source = input([frame(nodes, boxesOf(2), { offset: { x: 120, y: 80 } })])
    const before = JSON.stringify({ ...source, frames: source.frames.map((f) => ({ ...f, boxes: [...f.boxes] })) })
    buildSnapshot(source)
    const after = JSON.stringify({ ...source, frames: source.frames.map((f) => ({ ...f, boxes: [...f.boxes] })) })
    expect(after).toBe(before)
  })

  it('同一份輸入跑兩次得到相同文字', () => {
    const source = formInput('form.json')
    expect(buildSnapshot(source).text).toBe(buildSnapshot(source).text)
  })
})
```

---

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run tests/view-tools/snapshot.test.ts
```

預期：整個檔案在載入階段就失敗，錯誤是 `Failed to resolve import "../../src/main/view-tools/snapshot.js"`（`snapshot.ts` 還不存在）。若 `types.ts` 也還沒有，會多一則同樣形狀的錯誤，先照 Interfaces 那節把 `types.ts` 建出來再跑一次。

---

- [ ] **Step 3: 最小實作**

`src/main/view-tools/snapshot.ts` 全文（265 行，分兩段貼，實際是同一個檔）。第一段（型別、常數、規則的零件）：

```ts
import type { AxNode, FrameSnapshot, Point, Rect, RefEntry, RefTable, Snapshot } from './types.js'

/** Accessibility.getFullAXTree 回傳的 nodes[] 元素，只列本模組用到的欄位。 */
export interface AxRawNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value: unknown }
  readonly name?: { readonly value: unknown }
  readonly value?: { readonly value: unknown }
  readonly properties?: readonly { readonly name: string; readonly value: { readonly value: unknown } }[]
  readonly childIds?: readonly string[]
  readonly backendDOMNodeId?: number
}

export interface FrameInput {
  readonly sessionId?: string
  readonly frameId: string
  readonly url: string
  /** OOPIF 才非零（裁決 7，docs/superpowers/plan-b/CONTRACT.md）。 */
  readonly offset: Point
  readonly nodes: readonly AxRawNode[]
  /** backendNodeId → border 矩形（frame 自身座標，尚未加 offset）。 */
  readonly boxes: ReadonlyMap<number, Rect>
}

export interface SnapshotInput {
  readonly id: number
  readonly takenAt: number
  readonly url: string
  readonly title: string
  readonly scope: 'viewport' | 'full'
  readonly viewport: Rect
  readonly frames: readonly FrameInput[]
  readonly unattachedFrames: number
}

export interface SnapshotResult {
  readonly snapshot: Snapshot
  readonly refs: RefTable
  readonly text: string
}

export const MAX_SNAPSHOT_NODES = 400

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'switch', 'slider', 'tab', 'menuitem', 'option', 'listbox', 'spinbutton',
])

export const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['heading', 'image'])

/** 契約 §6 規則 6：states 的輸出順序固定，與 properties 的排列無關。 */
const STATE_ORDER: readonly string[] = [
  'disabled', 'checked', 'unchecked', 'mixed', 'expanded', 'collapsed',
  'selected', 'required', 'focused', 'readonly', 'pressed',
]

/** 邊緣相切算有交集（契約 §6 規則 3 的閉區間比較）。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  )
}

function textOf(field: { readonly value: unknown } | undefined): string {
  return typeof field?.value === 'string' ? field.value : ''
}

/** 契約 §6 規則 6 的對應表。值同時接受 CDP 的 boolean 與 tristate 兩種形狀。 */
function statesOf(node: AxRawNode): readonly string[] {
  const found = new Set<string>()
  for (const prop of node.properties ?? []) {
    const v = prop.value.value
    if (prop.name === 'disabled' && v === true) found.add('disabled')
    else if (prop.name === 'checked') {
      if (v === true || v === 'true') found.add('checked')
      else if (v === false || v === 'false') found.add('unchecked')
      else if (v === 'mixed') found.add('mixed')
    } else if (prop.name === 'expanded') {
      if (v === true) found.add('expanded')
      else if (v === false) found.add('collapsed')
    } else if (v === true && (prop.name === 'selected' || prop.name === 'required' || prop.name === 'focused' || prop.name === 'readonly')) {
      found.add(prop.name)
    } else if (prop.name === 'pressed' && (v === true || v === 'true')) found.add('pressed')
  }
  return STATE_ORDER.filter((s) => found.has(s))
}

/**
 * 契約 §6 規則 1：從 nodes[0] 起依 childIds 深度優先。nodes 陣列本身的順序不可靠
 * （CDP 不保證），所以先建 nodeId 索引再走 childIds；找不到的 childId 略過。
 */
function traverse(nodes: readonly AxRawNode[]): readonly AxRawNode[] {
  const first = nodes[0]
  if (first === undefined) return []
  const byId = new Map<string, AxRawNode>()
  for (const n of nodes) if (!byId.has(n.nodeId)) byId.set(n.nodeId, n)
  const out: AxRawNode[] = []
  const seen = new Set<string>()
  const stack: AxRawNode[] = [first]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || seen.has(node.nodeId)) continue
    seen.add(node.nodeId)
    out.push(node)
    const children = node.childIds ?? []
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const id = children[i]
      const child = id === undefined ? undefined : byId.get(id)
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

interface Candidate {
  readonly frameIndex: number
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: Rect
  readonly states: readonly string[]
  readonly backendNodeId: number
  readonly sessionId?: string
}

/** 契約 §6 規則 2 與 3：角色白名單、有 backendDOMNodeId、有矩形、（viewport 時）與 viewport 有交集。 */
function candidateOf(node: AxRawNode, frame: FrameInput, frameIndex: number, input: SnapshotInput): Candidate | null {
  if (node.ignored !== false) return null
  const role = textOf(node.role)
  const interactive = INTERACTIVE_ROLES.has(role)
  if (!interactive && !STRUCTURAL_ROLES.has(role)) return null
  const backendNodeId = node.backendDOMNodeId
  if (backendNodeId === undefined) return null
  const box = frame.boxes.get(backendNodeId)
  if (box === undefined) return null
  const name = textOf(node.name)
  if (!interactive && name === '') return null
  const bounds: Rect = {
    x: box.x + frame.offset.x,
    y: box.y + frame.offset.y,
    width: box.width,
    height: box.height,
  }
  if (input.scope === 'viewport' && !rectsIntersect(bounds, input.viewport)) return null
  const value = textOf(node.value)
  return {
    frameIndex,
    role,
    name,
    ...(value === '' ? {} : { value }),
    bounds,
    states: statesOf(node),
    backendNodeId,
    ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
  }
}

function collectCandidates(input: SnapshotInput): readonly Candidate[] {
  const out: Candidate[] = []
  input.frames.forEach((frame, frameIndex) => {
    for (const raw of traverse(frame.nodes)) {
      const candidate = candidateOf(raw, frame, frameIndex, input)
      if (candidate !== null) out.push(candidate)
    }
  })
  return out
}

```

第二段（`buildSnapshot` 與文字格式，接在第一段後面）：

```ts
/**
 * AX 樹（每個 frame 一份）轉成 Snapshot、RefTable 與給模型看的文字。
 * 純函式：同樣的輸入永遠得到同樣的輸出，不改動輸入的任何物件。
 */
export function buildSnapshot(input: SnapshotInput): SnapshotResult {
  const candidates = collectCandidates(input)
  const kept = candidates.slice(0, MAX_SNAPSHOT_NODES)
  const truncated = candidates.length - kept.length

  const entries = new Map<string, RefEntry>()
  const perFrame: AxNode[][] = input.frames.map(() => [])
  let nextIndex = 0
  for (const c of kept) {
    const ref = INTERACTIVE_ROLES.has(c.role) ? `s${input.id}-e${nextIndex}` : undefined
    if (ref !== undefined) {
      nextIndex += 1
      entries.set(ref, {
        ...(c.sessionId === undefined ? {} : { sessionId: c.sessionId }),
        backendNodeId: c.backendNodeId,
        role: c.role,
        name: c.name,
      })
    }
    const node: AxNode = {
      ...(ref === undefined ? {} : { ref }),
      role: c.role,
      name: c.name,
      ...(c.value === undefined ? {} : { value: c.value }),
      bounds: c.bounds,
      states: c.states,
      backendNodeId: c.backendNodeId,
      ...(c.sessionId === undefined ? {} : { sessionId: c.sessionId }),
    }
    perFrame[c.frameIndex]?.push(node)
  }

  const frames: readonly FrameSnapshot[] = input.frames.map((frame, i) => ({
    ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
    frameId: frame.frameId,
    url: frame.url,
    nodes: perFrame[i] ?? [],
  }))

  const snapshot: Snapshot = {
    id: input.id,
    takenAt: input.takenAt,
    url: input.url,
    title: input.title,
    scope: input.scope,
    frames,
    unattachedFrames: input.unattachedFrames,
    truncated,
  }
  const refs: RefTable = { snapshotId: input.id, entries }
  return { snapshot, refs, text: formatSnapshotText(snapshot) }
}

/** 契約 §6：name 與 value 裡的雙引號與換行要逸出，否則模型讀到的行會斷開。 */
function escapeText(raw: string): string {
  return raw.replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '\\n')
}

function nodeLine(node: AxNode): string {
  const head = node.ref === undefined ? '' : `${node.ref} `
  const value = node.value === undefined || node.value === '' ? '' : ` value="${escapeText(node.value)}"`
  const states = node.states.length === 0 ? '' : ` (${node.states.join('、')})`
  return `${head}${node.role} "${escapeText(node.name)}"${value}${states}`
}

/** 第一個 frame 是頁面本身，其餘依序是 iframe 1、iframe 2……（契約 §6 的文字格式）。 */
function frameHeader(frame: FrameSnapshot, index: number, snapshot: Snapshot): string {
  if (index === 0) return `[page] ${snapshot.title} ${snapshot.url}`
  return `[iframe ${index}] ${frame.url}`
}

/**
 * 給模型看的 snapshot 文字。intervention 是 summarizeIntervention() 的輸出
 * （watch.ts，契約 §9.3）：沒有插手時不給，那一行就不出現。空字串與 null
 * 一併當成沒給（裁決 22：controller 直接傳 summarizeIntervention 的結果）。
 */
export function formatSnapshotText(snapshot: Snapshot, intervention?: string | null): string {
  const lines: string[] = []
  if (intervention) lines.push(intervention)
  if (snapshot.unattachedFrames > 0) lines.push(`[iframe 未附著 ${snapshot.unattachedFrames} 個]`)
  snapshot.frames.forEach((frame, index) => {
    lines.push(frameHeader(frame, index, snapshot))
    for (const node of frame.nodes) lines.push(nodeLine(node))
  })
  if (snapshot.truncated > 0) {
    lines.push(`（還有 ${snapshot.truncated} 個節點未列出，請縮小範圍或捲動後重拍）`)
  }
  return lines.join('\n')
}
```

實作上兩個值得說的決定。`Candidate` 這個中間型別的存在是為了讓「先蒐集全部候選、再切 400、再編號」變成三個沒有分支的步驟：如果邊走訪邊編號，就得在走訪迴圈裡同時處理「還沒滿 400」「已經滿了」「這個要不要配 ref」三件事，那是特殊情況疊特殊情況。`buildSnapshot` 呼叫 `formatSnapshotText(snapshot)`（不帶 intervention），controller 拿到 `SnapshotResult` 之後再用摘要重新格式化一次，這樣純函式不必知道插手記錄是什麼。

---

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run tests/view-tools/snapshot.test.ts
npx tsc --noEmit -p tsconfig.json
```

預期（已在 worktree 實跑）：`Tests 39 passed (39)`，`tsc` 0 error。單檔覆蓋率（`npx vitest run tests/view-tools/snapshot.test.ts --coverage --coverage.include='src/main/view-tools/snapshot.ts'`）為 Stmts 99.15、Branch 93.75、Funcs 100、Lines 100，未覆蓋的是 `noUncheckedIndexedAccess` 逼出來的防呆分支（重複 nodeId、`childIds` 元素為 undefined、`perFrame[i] ?? []`）。

---

- [ ] **Step 5: 突變測試**

十一個突變都在 worktree `wt-4` 實跑過，每個都是「改實作、跑 `npx vitest run tests/view-tools/snapshot.test.ts`、記下變紅的測試、還原、確認回綠」。九個被抓到，兩個沒被抓到但查證後確認是等價改寫（不是測試盲點），照 WRITER-GUIDE 的要求把過程寫下來。

| # | 改法 | 變紅的測試 |
|---|---|---|
| 1 | `bounds` 不加 offset（`x: box.x, y: box.y`） | `bounds 是矩形加上 frame offset（非零 offset）`、`viewport 判定用加過 offset 的 bounds…`、`offset 的 x 與 y 不可互換…`、`iframe 的節點帶 sessionId、bounds 已加 offset…`（4 個） |
| 2 | `rectsIntersect` 四個比較全改成開區間（`<`／`>`） | `邊緣相切算有交集（閉區間）` |
| 3 | `traverse` 直接 `return nodes`（假設陣列已是前序） | `依 childIds 深度優先排序…`、`RefTable 的 key 是完整 ref…`、`scope viewport 只留與 viewport 有交集的節點…`、`nodes 陣列順序與 childIds 順序相反時，輸出照 childIds`（4 個） |
| 4 | `candidates.slice(0, MAX)` 改成 `slice(-MAX)`（取最後 400 個） | `450 個候選只留 DFS 前 400 個，truncated 為 50` |
| 5 | `nextIndex += 1` 移到 `if (ref !== undefined)` 之外（structural 也佔號） | `依 childIds 深度優先排序…`、`RefTable 的 key…`、`scope viewport…`、`ref 序號跨 frame 連續…`、`iframe 的節點帶 sessionId…`、`文字第一個 frame 是 [page]…`（6 個） |
| 6 | `statesOf` 回傳 `[...found]`（用出現順序，不照 STATE_ORDER） | `輸出順序固定，與 properties 的排列無關`、`value 與 states 同時存在時 value 在前、states 在後…`（2 個） |
| 7 | `rectsIntersect` 把 `a.x` 與 `a.y` 對調 | `scope viewport 只留與 viewport 有交集的節點…`、`邊緣相切算有交集（閉區間）`、`x 與 y 互換會得到不同答案…`、`offset 的 x 與 y 不可互換…`（4 個） |
| 8 | `...(value === '' ? {} : { value })` 改成 `value,`（空字串也帶） | `只有非空字串才帶 value` |
| 9 | `escapeText` 拿掉換行那一段 `.replace(/\r\n\|\r\|\n/g, '\\n')` | `name 與 value 裡的雙引號與換行逸出` |
| 10 | `frameHeader` 的 `[iframe ${index}]` 改成 `${index + 1}` | `文字第一個 frame 是 [page]，其餘是 [iframe k]（k 從 1 起）` |
| 11 | `if (!interactive && name === '') return null` 改成 `if (name === '') return null` | `白名單外的角色不收；structural 角色名稱為空也不收，但互動角色名稱為空要收` |

兩個全綠的改法與查證結果：

- `traverse` 的堆疊初值 `[first]` 改成 `[...nodes].reverse()`：39 個測試全過。查證後確認這是等價改寫，不是測試盲點。堆疊底部多塞的那些節點永遠排在自己父節點的後面被彈出，而彈出時 `seen` 已經記過它們，所以只有「從 `nodes[0]` 出發的 DFS 結果」會進 `out`；能到達的節點集合與順序都沒變。真正該測的「不照 `childIds` 走」是突變 3，那個有被抓到。
- `const truncated = candidates.length - kept.length` 改成 `Math.max(0, candidates.length - MAX_SNAPSHOT_NODES)`：39 個測試全過。因為 `kept = candidates.slice(0, MAX)`，兩式在數學上恆等。保留現寫法只是為了少一個常數引用。

突變 1 與 7 是這個 task 最重要的兩個。座標測試若用 `offset: {x: 0, y: 0}` 或正方形 viewport，這兩個突變都會巧合地全綠：所以 `bounds 與 frame offset` 那一組一律用 `{x: 120, y: 80}` 這種非零 offset，`x 與 y 互換會得到不同答案` 那個測試用的是 20×500 的細長矩形對 100×600 的 viewport（換軸之後答案由 `false` 變 `true`）。

---

- [ ] **Step 6: 提交**

```bash
git add src/main/view-tools/snapshot.ts tests/view-tools/snapshot.test.ts tests/fixtures/ax/form.json tests/fixtures/view/form.html
git commit -m "feat: snapshot 純函式與 AX fixture"
```

若 `src/main/view-tools/types.ts` 是本 task 補的（Task 0 尚未完成），一併 `git add src/main/view-tools/types.ts`，commit 訊息改為 `feat: snapshot 純函式、types 型別與 AX fixture`。

