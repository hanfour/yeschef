import type { InvalidationReason, RefEntry, RefTable } from './types.js'

export interface ParsedRef {
  readonly snapshotId: number
  readonly nodeIndex: number
}

// 裁決：契約 §7 只給 /^s(\d+)-e(\d+)$/，不接受 't' 開頭、不接受大小寫混合、
// 前後空白、負號；\d+ 不排除前導零（'s01-e2' 會被接受，見 refs.test.ts）。
const REF_PATTERN = /^s(\d+)-e(\d+)$/

export function parseRef(ref: string): ParsedRef | null {
  const match = REF_PATTERN.exec(ref)
  if (match === null) return null
  const snapshotPart = match[1]
  const nodePart = match[2]
  if (snapshotPart === undefined || nodePart === undefined) return null
  return { snapshotId: Number(snapshotPart), nodeIndex: Number(nodePart) }
}

export function formatRef(snapshotId: number, nodeIndex: number): string {
  return `s${snapshotId}-e${nodeIndex}`
}

export const EMPTY_REFS: RefTable = { snapshotId: 0, entries: new Map() }

export function invalidateRefs(table: RefTable, reason: InvalidationReason): RefTable {
  return { snapshotId: table.snapshotId, invalidatedBy: reason, entries: new Map() }
}

export type RefLookup =
  | { readonly kind: 'ok'; readonly entry: RefEntry }
  | { readonly kind: 'bad-format' }
  | { readonly kind: 'stale'; readonly snapshotId: number; readonly reason: InvalidationReason | 'newer-snapshot' }
  | { readonly kind: 'missing'; readonly snapshotId: number; readonly ref: string }

export function lookupRef(table: RefTable, ref: string): RefLookup {
  const parsed = parseRef(ref)
  if (parsed === null) return { kind: 'bad-format' }
  if (parsed.snapshotId !== table.snapshotId) {
    return { kind: 'stale', snapshotId: parsed.snapshotId, reason: 'newer-snapshot' }
  }
  if (table.invalidatedBy !== undefined) {
    return { kind: 'stale', snapshotId: table.snapshotId, reason: table.invalidatedBy }
  }
  const entry = table.entries.get(ref)
  if (entry === undefined) return { kind: 'missing', snapshotId: table.snapshotId, ref }
  return { kind: 'ok', entry }
}
