import { describe, it, expect } from 'vitest'
import { groupSessions } from '../src/renderer/recents-groups.js'
import type { SessionSummary } from '../src/shared/ipc.js'
import type { SessionLink, ThreadEntry } from '../src/shared/projects.js'

const s = (sessionId: string, lastModified: number): SessionSummary => ({ sessionId, summary: sessionId, lastModified })
const link = (sessionId: string): SessionLink => ({
  linkId: sessionId,
  provider: 'claude',
  sessionId,
  transcriptPath: `/t/${sessionId}.jsonl`,
  parentLinkId: null,
  startedAt: 0,
  endedAt: null,
  endReason: null,
  models: [],
})
const thread = (id: string, ...ids: string[]): ThreadEntry => ({
  id,
  sessions: ids.map(link),
  handoffVersion: 0,
  switchPhase: { kind: 'idle' },
  createdAt: 0,
})

const A = s('a', 30)
const B = s('b', 20)
const C = s('c', 10)
const D = s('d', 40)

describe('groupSessions', () => {
  it('沒有 thread 時每一筆各自一組,依 lastModified 新到舊', () => {
    const groups = groupSessions([C, A, B], [])
    expect(groups.map((g) => g.key)).toEqual(['solo:a', 'solo:b', 'solo:c'])
    expect(groups.every((g) => g.rest.length === 0)).toBe(true)
  })

  it('同一條 thread 合成一組:head 是鏈上最後一筆,rest 新到舊', () => {
    const groups = groupSessions([A, B, C], [thread('th', 'a', 'c', 'b')])
    expect(groups).toEqual([{ key: 'thread:th', head: B, rest: [A, C] }])
  })

  it('鏈上最後一筆不在清單裡時,head 取該組最新的一筆', () => {
    const groups = groupSessions([A, C], [thread('th', 'c', 'a', 'zzz')])
    expect(groups).toEqual([{ key: 'thread:th', head: A, rest: [C] }])
  })

  it('整條 thread 一筆都對不到就不成組;對不到的連結不影響其他成員', () => {
    const groups = groupSessions([A], [thread('empty', 'x', 'y'), thread('th', 'a', 'x')])
    expect(groups).toEqual([{ key: 'thread:th', head: A, rest: [] }])
  })

  it('thread 組與 solo 混排,依 head.lastModified 新到舊', () => {
    const groups = groupSessions([A, B, C, D], [thread('th', 'c', 'b')])
    expect(groups.map((g) => g.key)).toEqual(['solo:d', 'solo:a', 'thread:th'])
    expect(groups[2]?.head).toEqual(B)
    expect(groups[2]?.rest).toEqual([C])
  })

  it('被 thread 收走的 session 不再另成 solo;兩條 thread 搶同一筆時先來的贏', () => {
    const groups = groupSessions([A, B], [thread('t1', 'a'), thread('t2', 'a', 'b')])
    expect(groups.map((g) => g.key)).toEqual(['thread:t1', 'thread:t2'])
    expect(groups[1]).toEqual({ key: 'thread:t2', head: B, rest: [] })
    expect(groups.flatMap((g) => [g.head, ...g.rest]).map((x) => x.sessionId).sort()).toEqual(['a', 'b'])
  })
})
