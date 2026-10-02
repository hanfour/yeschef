import { CdpError } from '../cdp.js'
import type { CollectDeps } from './snapshot-collect.js'
import type { Point, Rect } from './types.js'

const ORIGIN: Point = { x: 0, y: 0 }

/** CDP 的 quad 取四點的最小外接矩形，不假設四點的排列順序。 */
export function quadToRect(quad: unknown): Rect | null {
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

interface OwnerStep {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly dx: number
  readonly dy: number
}

interface RawTargetInfo {
  readonly targetId?: unknown
  /** 兩個欄位都選填，先讀 parentId，再讀 parentFrameId。 */
  readonly parentId?: unknown
  readonly parentFrameId?: unknown
}

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

async function ownerStep(deps: CollectDeps, sessionId: string): Promise<OwnerStep> {
  const targets = deps.cdp.getAttachedTargets()
  const self = targets.find((t) => t.sessionId === sessionId)
  if (self === undefined) {
    throw new CdpError(`getAttachedTargets 找不到 sessionId ${sessionId} 的 target`, 'frame-detached')
  }
  const parentTargetId = await findParentTargetId(deps, self.targetId)
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

/** 一個 session 的頂層 frame 在主視窗 viewport 裡的位置，root 為 {0,0}。 */
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

export async function frameOffset(
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

function errorOf(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}
