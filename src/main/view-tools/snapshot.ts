import type { AxNode, FrameSnapshot, Point, Rect, RefEntry, RefTable, Snapshot } from './types.js'

/** Accessibility.getFullAXTree 回傳的 nodes[] 元素，只列本模組用到的欄位。 */
export interface AxRawNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role?: { readonly value: unknown }
  readonly name?: { readonly value: unknown }
  readonly value?: { readonly value: unknown }
  readonly properties?: readonly { readonly name: string; readonly value?: { readonly value: unknown } }[]
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
    // CDP property 可能缺少 value，忽略這個不完整 property，避免整張 snapshot 失敗。
    const v = prop.value?.value
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
  return { snapshot, refs }
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
  if (index === 0) return `[page] ${escapeText(snapshot.title)} ${snapshot.url}`
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
