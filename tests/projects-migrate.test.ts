import { describe, it, expect } from 'vitest'
import { migrateV1 } from '../src/main/projects-migrate.js'
import { parseProjectsState } from '../src/main/projects-schema.js'

const V1_LINK = {
  sessionId: 's-1', transcriptPath: '/h/.claude/projects/x/s-1.jsonl', parentSessionId: 's-0',
  startedAt: 5, endedAt: 9, endReason: 'user',
}

function v1(switchPhase: unknown = { kind: 'idle' }): unknown {
  return {
    schemaVersion: 1,
    activeId: 'p1',
    openIdsOnShutdown: ['p1'],
    projects: [{
      id: 'p1', rootPath: '/Users/x/demo', name: 'demo', addedAt: 1, lastOpenedAt: 2, lastUrl: null,
      tabs: [
        { id: 't1', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1' },
        { id: 't2', contentType: 'terminal', label: 'zsh', customLabel: null, sortOrder: 1, lastFocusedAt: 0 },
      ],
      threads: [{ id: 'th1', sessions: [V1_LINK], handoffVersion: 3, switchPhase, createdAt: 1 }],
    }],
  }
}

describe('migrateV1', () => {
  it('schemaVersion 變 2,轉換結果通過版本 2 的 schema', () => {
    const out = parseProjectsState(migrateV1(v1()))
    expect(out).not.toBeNull()
    expect(out?.schemaVersion).toBe(2)
  })

  it('SessionLink:linkId 取 sessionId、provider claude、parentLinkId 取 parentSessionId、models 空', () => {
    const out = parseProjectsState(migrateV1(v1()))
    expect(out?.projects[0]?.threads[0]?.sessions[0]).toEqual({
      linkId: 's-1', provider: 'claude', sessionId: 's-1', transcriptPath: '/h/.claude/projects/x/s-1.jsonl',
      parentLinkId: 's-0', startedAt: 5, endedAt: 9, endReason: 'user', models: [],
    })
  })

  it('conversation 分頁補 provider claude,terminal 分頁不動', () => {
    const tabs = parseProjectsState(migrateV1(v1()))?.projects[0]?.tabs
    expect(tabs?.[0]?.provider).toBe('claude')
    expect(tabs?.[1]).not.toHaveProperty('provider')
  })

  it('switchPhase idle 不動', () => {
    expect(parseProjectsState(migrateV1(v1()))?.projects[0]?.threads[0]?.switchPhase).toEqual({ kind: 'idle' })
  })

  it('preparing 補 mode 與 target', () => {
    const out = parseProjectsState(migrateV1(v1({ kind: 'preparing', txId: 'tx', startedAt: 7 })))
    expect(out?.projects[0]?.threads[0]?.switchPhase).toEqual({
      kind: 'preparing', txId: 'tx', startedAt: 7, mode: 'handoff', target: { provider: 'claude', requestedModel: null },
    })
  })

  it('spawning 補 recoveryRequired false', () => {
    const out = parseProjectsState(migrateV1(v1({ kind: 'spawning', txId: 'tx', handoffVersion: 2 })))
    expect(out?.projects[0]?.threads[0]?.switchPhase).toEqual({
      kind: 'spawning', txId: 'tx', handoffVersion: 2, mode: 'handoff',
      target: { provider: 'claude', requestedModel: null }, recoveryRequired: false,
    })
  })

  it('receiving 補 newLinkId = newSessionId', () => {
    const out = parseProjectsState(migrateV1(v1({ kind: 'receiving', txId: 'tx', newSessionId: 's-2' })))
    expect(out?.projects[0]?.threads[0]?.switchPhase).toEqual({
      kind: 'receiving', txId: 'tx', newSessionId: 's-2', newLinkId: 's-2', mode: 'handoff',
      target: { provider: 'claude', requestedModel: null },
    })
  })

  it('不是物件就原樣回傳,交給 schema 拒絕', () => {
    expect(migrateV1('x')).toBe('x')
    expect(parseProjectsState(migrateV1('x'))).toBeNull()
  })

  it('不改傳入的物件', () => {
    const input = v1()
    const before = JSON.stringify(input)
    migrateV1(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
