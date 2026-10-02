import { CdpError } from '../cdp.js'
import type { CdpSession } from '../cdp.js'
import { frameOffset, quadToRect } from './frame-offset.js'
export { resolveFrameOffset } from './frame-offset.js'
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
  if (frames.size === 0) {
    throw new CdpError('Page.getFrameTree 沒有回傳可用的 frameTree.frame.id', 'invalid-response')
  }
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
  failures: number
}

interface BoxCollection {
  readonly boxes: ReadonlyMap<number, Rect>
  readonly candidates: number
  readonly failures: number
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
): Promise<BoxCollection> {
  const boxes = new Map<number, Rect>()
  let candidates = 0
  const failureStart = budget.failures
  for (const node of nodes) {
    const backendNodeId = candidateBackendNodeId(node)
    if (backendNodeId === undefined) continue
    candidates += 1
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
      if (rect === null) {
        budget.failures += 1
      } else {
        boxes.set(backendNodeId, rect)
      }
    } catch {
      budget.failures += 1
    }
  }
  return { boxes, candidates, failures: budget.failures - failureStart }
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
  const takenAt = deps.now()
  const url = deps.currentUrl()
  const title = deps.currentTitle()
  const viewport = await readViewport(deps)
  const discovered = await discoverFrames(deps)
  const offsets = new Map<string, Point>()
  const failedOffsets = new Set<string>()
  const budget: BoxBudget = { remaining: MAX_BOX_LOOKUPS, skipped: 0, failures: 0 }
  const frames: FrameInput[] = []
  let unattachedFrames = 0

  for (const frame of discovered) {
    const nodes = await fetchAxNodes(deps, frame)
    if (nodes === null) {
      unattachedFrames += 1
      continue
    }
    const offset = await frameOffset(deps, frame.sessionId, offsets, failedOffsets)
    const collection = await collectBoxes(deps, frame.sessionId, nodes, budget)
    if (collection.candidates > 0 && collection.boxes.size === 0 && collection.failures > 0) {
      deps.logError(
        new Error(
          `frame ${frame.frameId} 的 ${collection.candidates} 個候選節點都沒有矩形，${collection.failures} 次 DOM.getBoxModel 失敗`
        )
      )
    }
    frames.push({
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      frameId: frame.frameId,
      url: frame.url,
      offset,
      nodes,
      boxes: collection.boxes,
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
    takenAt,
    url,
    title,
    scope,
    viewport,
    frames,
    unattachedFrames,
  }
}
