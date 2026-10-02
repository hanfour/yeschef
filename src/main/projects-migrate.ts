/**
 * 狀態檔版本 1 → 2 的轉換(E 規格 §4.1)。只在 raw 物件上補欄位、改名,不驗證形狀:
 * 驗證交給 projects-schema.ts,這裡填錯的欄位會在那裡被擋下。不改傳入的物件。
 */
import { isRecord } from '../shared/ipc.js'

const CLAUDE_TARGET = { provider: 'claude', requestedModel: null } as const

function migrateLink(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const { parentSessionId, ...rest } = raw
  return {
    ...rest,
    linkId: raw['sessionId'],
    provider: 'claude',
    parentLinkId: parentSessionId ?? null,
    models: [],
  }
}

function migratePhase(raw: unknown): unknown {
  if (!isRecord(raw) || raw['kind'] === 'idle') return raw
  const base = { ...raw, mode: 'handoff', target: CLAUDE_TARGET }
  switch (raw['kind']) {
    case 'spawning':
      return { ...base, recoveryRequired: false }
    case 'receiving':
      return { ...base, newLinkId: raw['newSessionId'] }
    default:
      return base
  }
}

function migrateThread(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  return {
    ...raw,
    sessions: Array.isArray(raw['sessions']) ? raw['sessions'].map(migrateLink) : raw['sessions'],
    switchPhase: migratePhase(raw['switchPhase']),
  }
}

function migrateTab(raw: unknown): unknown {
  if (!isRecord(raw) || raw['contentType'] !== 'conversation') return raw
  return { ...raw, provider: 'claude' }
}

function migrateProject(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  return {
    ...raw,
    tabs: Array.isArray(raw['tabs']) ? raw['tabs'].map(migrateTab) : raw['tabs'],
    threads: Array.isArray(raw['threads']) ? raw['threads'].map(migrateThread) : raw['threads'],
  }
}

export function migrateV1(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  return {
    ...raw,
    schemaVersion: 2,
    projects: Array.isArray(raw['projects']) ? raw['projects'].map(migrateProject) : raw['projects'],
  }
}
