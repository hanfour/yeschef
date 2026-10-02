import { describe, expect, it } from 'vitest'
import { EMPTY_REFS, formatRef, invalidateRefs, lookupRef, parseRef } from '../../src/main/view-tools/refs.js'
import type { RefEntry, RefTable } from '../../src/main/view-tools/types.js'

const entryA: RefEntry = { backendNodeId: 101, role: 'button', name: '送出' }
const entryB: RefEntry = { backendNodeId: 202, role: 'link', name: '說明' }

describe('parseRef', () => {
  it('接受標準格式 s1-e2', () => expect(parseRef('s1-e2')).toEqual({ snapshotId: 1, nodeIndex: 2 }))
  it('接受 s2-e1，且不與 s1-e2 混淆（防序號互換）', () => expect(parseRef('s2-e1')).toEqual({ snapshotId: 2, nodeIndex: 1 }))
  it('接受前導零 s01-e2（\\d+ 不排除前導零，依契約字面 regex）', () => expect(parseRef('s01-e2')).toEqual({ snapshotId: 1, nodeIndex: 2 }))
  it('接受多位數 s12-e70', () => expect(parseRef('s12-e70')).toEqual({ snapshotId: 12, nodeIndex: 70 }))
  it('拒絕大寫 S1-E2', () => expect(parseRef('S1-E2')).toBeNull())
  it('拒絕前面有空白', () => expect(parseRef(' s1-e2')).toBeNull())
  it('拒絕後面有空白', () => expect(parseRef('s1-e2 ')).toBeNull())
  it('拒絕負數', () => expect(parseRef('s-1-e2')).toBeNull())
  it('拒絕結尾多餘字元（regex 缺 $ 錨點會漏接這個）', () => expect(parseRef('s1-e2x')).toBeNull())
  it('拒絕開頭多餘字元', () => expect(parseRef('xs1-e2')).toBeNull())
  it("拒絕 't' 開頭", () => expect(parseRef('t1-e2')).toBeNull())
  it('拒絕缺少 e 節點段', () => expect(parseRef('s1-2')).toBeNull())
  it('拒絕空字串', () => expect(parseRef('')).toBeNull())
  it('拒絕沒有數字的 s-e', () => expect(parseRef('s-e')).toBeNull())
})

describe('formatRef', () => {
  it('組出 s12-e7', () => expect(formatRef(12, 7)).toBe('s12-e7'))
  it('s1-e2 與 s2-e1 是不同字串（防序號互換）', () => {
    expect(formatRef(1, 2)).toBe('s1-e2')
    expect(formatRef(2, 1)).toBe('s2-e1')
    expect(formatRef(1, 2)).not.toBe(formatRef(2, 1))
  })
  it('與 parseRef 互為反函式', () => expect(parseRef(formatRef(3, 9))).toEqual({ snapshotId: 3, nodeIndex: 9 }))
})

describe('EMPTY_REFS', () => {
  it('snapshotId 為 0、entries 為空、未失效', () => {
    expect(EMPTY_REFS.snapshotId).toBe(0)
    expect(EMPTY_REFS.entries.size).toBe(0)
    expect(EMPTY_REFS.invalidatedBy).toBeUndefined()
  })
})

describe('invalidateRefs', () => {
  it('回傳同 snapshotId、entries 清空的新表', () => {
    const result = invalidateRefs({ snapshotId: 5, entries: new Map([['s5-e0', entryA]]) }, 'documentUpdated')
    expect(result.snapshotId).toBe(5)
    expect(result.entries.size).toBe(0)
    expect(result.invalidatedBy).toBe('documentUpdated')
  })
  it('不修改原表（不可變）', () => {
    const originalEntries = new Map([['s5-e0', entryA]])
    const table: RefTable = { snapshotId: 5, entries: originalEntries }
    invalidateRefs(table, 'navigated')
    expect(table.entries.size).toBe(1)
    expect(table.invalidatedBy).toBeUndefined()
    expect(originalEntries.size).toBe(1)
  })
  it('不修改 EMPTY_REFS 本身', () => {
    invalidateRefs(EMPTY_REFS, 'userInput')
    expect(EMPTY_REFS.entries.size).toBe(0)
    expect(EMPTY_REFS.invalidatedBy).toBeUndefined()
  })
  it('第二次呼叫用新原因覆蓋，不保留第一次的原因（照契約字面：invalidatedBy = reason，每次呼叫都是新賦值，不是「已失效就不重建」；那個規則屬於 watch.ts 的呼叫端政策，見契約 §9.3）', () => {
    const first = invalidateRefs({ snapshotId: 5, entries: new Map() }, 'documentUpdated')
    expect(invalidateRefs(first, 'userInput').invalidatedBy).toBe('userInput')
  })
})

describe('lookupRef', () => {
  it('格式錯 → bad-format，即使 snapshotId 部分看起來合理', () => expect(lookupRef({ snapshotId: 1, entries: new Map() }, 'S1-E2')).toEqual({ kind: 'bad-format' }))
  it('格式錯優先於過期判斷（就算表已失效也先回 bad-format）', () => expect(lookupRef(invalidateRefs({ snapshotId: 1, entries: new Map() }, 'navigated'), 'not-a-ref')).toEqual({ kind: 'bad-format' }))
  it('ref 的 snapshot 序號小於目前 snapshotId → stale，snapshotId 取 ref 的編號', () => expect(lookupRef({ snapshotId: 3, entries: new Map() }, 's1-e0')).toEqual({ kind: 'stale', snapshotId: 1, reason: 'newer-snapshot' }))
  it('ref 的 snapshot 序號大於目前 snapshotId → 同樣 stale，snapshotId 仍取 ref 的編號', () => expect(lookupRef({ snapshotId: 3, entries: new Map() }, 's9-e0')).toEqual({ kind: 'stale', snapshotId: 9, reason: 'newer-snapshot' }))
  it('snapshotId 相等且 invalidatedBy 有值 → stale，reason 是 invalidatedBy（documentUpdated）', () => expect(lookupRef({ snapshotId: 3, invalidatedBy: 'documentUpdated', entries: new Map() }, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'documentUpdated' }))
  it('snapshotId 相等且 invalidatedBy 有值 → stale，reason 是 invalidatedBy（navigated）', () => expect(lookupRef({ snapshotId: 3, invalidatedBy: 'navigated', entries: new Map() }, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'navigated' }))
  it('snapshotId 相等且 invalidatedBy 有值 → stale，reason 是 invalidatedBy（userInput）', () => expect(lookupRef({ snapshotId: 3, invalidatedBy: 'userInput', entries: new Map() }, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'userInput' }))
  it('snapshotId 不相等優先於 invalidatedBy 判斷（不應報成 invalidatedBy 的原因）', () => expect(lookupRef({ snapshotId: 5, invalidatedBy: 'navigated', entries: new Map() }, 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'newer-snapshot' }))
  it('snapshotId 相等、未失效、entries 沒有這個 ref → missing', () => expect(lookupRef({ snapshotId: 3, entries: new Map([['s3-e0', entryA]]) }, 's3-e9')).toEqual({ kind: 'missing', snapshotId: 3, ref: 's3-e9' }))
  it('已失效的表對格式正確但 entries 已清空的 ref 回 stale，不是 missing（優先順序的關鍵測試）', () => expect(lookupRef(invalidateRefs({ snapshotId: 3, entries: new Map([['s3-e0', entryA]]) }, 'documentUpdated'), 's3-e0')).toEqual({ kind: 'stale', snapshotId: 3, reason: 'documentUpdated' }))
  it('全部符合 → ok，回傳對應 entry', () => expect(lookupRef({ snapshotId: 3, entries: new Map([['s3-e0', entryA]]) }, 's3-e0')).toEqual({ kind: 'ok', entry: entryA }))
  it('同時有 s1-e2 與 s2-e1 兩個不同 entry 時各自查到正確的一筆（防序號互換的盲點）', () => {
    expect(lookupRef({ snapshotId: 1, entries: new Map([[formatRef(1, 2), entryA]]) }, 's1-e2')).toEqual({ kind: 'ok', entry: entryA })
    expect(lookupRef({ snapshotId: 2, entries: new Map([[formatRef(2, 1), entryB]]) }, 's2-e1')).toEqual({ kind: 'ok', entry: entryB })
  })
  it('不修改傳入的 table', () => {
    const entries = new Map([['s3-e0', entryA]])
    const table: RefTable = { snapshotId: 3, entries }
    lookupRef(table, 's3-e0')
    lookupRef(table, 's3-e9')
    lookupRef(table, 'bad')
    expect(table.entries.size).toBe(1)
    expect(table.snapshotId).toBe(3)
  })
})
