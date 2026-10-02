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
const AX_FIXTURES = ['form.json', 'form.real.json'] as const

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
    const { snapshot } = buildSnapshot(formInput(file))
    const text = formatSnapshotText(snapshot)
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
    const { snapshot } = buildSnapshot(formInput(file))
    const text = formatSnapshotText(snapshot)
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
    const { snapshot } = buildSnapshot(formInput(file, { scope: 'viewport', viewport: { x: 0, y: 0, width: 800, height: 250 } }))
    const text = formatSnapshotText(snapshot)
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
  function statesOf(properties: readonly { name: string; value?: { value: unknown } }[]): readonly string[] {
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

  it('property 缺少 value 時不丟例外，節點照常列出但不產生該 state', () => {
    const nodes = [raw('1', 'RootWebArea', '', { childIds: ['2'] }), raw('2', 'button', '送出', { properties: [{ name: 'disabled' }] })]
    expect(() => buildSnapshot(input([frame(nodes, boxesOf(2))]))).not.toThrow()
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    expect(snapshot.frames[0]?.nodes).toHaveLength(1)
    expect(snapshot.frames[0]?.nodes[0]?.states).toEqual([])
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
    const { snapshot } = buildSnapshot(input([frame(nodes, boxes)]))
    const text = formatSnapshotText(snapshot)
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
    expect(snapshot.frames[1]?.sessionId).toBe('S-1')
    expect('sessionId' in (snapshot.frames[1] ?? {})).toBe(true)
    expect('sessionId' in (snapshot.frames[0] ?? {})).toBe(false)
    expect(snapshot.frames[1]?.nodes[0]?.sessionId).toBe('S-1')
    expect(snapshot.frames[1]?.nodes[0]?.bounds).toEqual({ x: 130, y: 90, width: 10, height: 10 })
    expect(refs.entries.get('s12-e1')?.sessionId).toBe('S-1')
    expect('sessionId' in (refs.entries.get('s12-e0') ?? {})).toBe(false)
    expect(snapshot.frames[0]?.nodes[1]?.sessionId).toBeUndefined()
  })

  it('文字第一個 frame 是 [page]，其餘是 [iframe k]（k 從 1 起）', () => {
    const { snapshot } = buildSnapshot(twoFrames())
    const text = formatSnapshotText(snapshot)
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
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    const text = formatSnapshotText(snapshot)
    expect(text.split('\n')[1]).toBe('s1-e0 textbox "請輸入「\\"暱稱\\"」\\n第二行" value="他說 \\"好\\"\\n然後走了"')
    expect(text.split('\n')).toHaveLength(2)
  })

  it('頁面標題裡的雙引號與換行逸出，不能偽造新的節點行', () => {
    const nodes = [
      raw('1', 'RootWebArea', '', { childIds: ['2'] }),
      raw('2', 'button', '送出'),
    ]
    const snapshot = buildSnapshot(
      input([frame(nodes, boxesOf(2))], { title: '首頁 "引號"\n第二行' }),
    ).snapshot
    const text = formatSnapshotText(snapshot)

    expect(text.split('\n')[0]).toBe('[page] 首頁 \\"引號\\"\\n第二行 https://example.test/')
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
    const { snapshot } = buildSnapshot(input([frame(nodes, boxesOf(2))]))
    const text = formatSnapshotText(snapshot)
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
    expect(formatSnapshotText(buildSnapshot(source).snapshot)).toBe(formatSnapshotText(buildSnapshot(source).snapshot))
  })
})
