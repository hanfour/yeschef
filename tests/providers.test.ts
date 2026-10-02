import { describe, expect, it } from 'vitest'
import {
  PROVIDERS, PROVIDER_LABELS, asProvider, providerSchema,
  parseConversationOpen, parseSessionListScope,
} from '../src/shared/projects.js'
import { parseProjectsState } from '../src/main/projects-schema.js'
import { ChefModelSchema } from '../src/shared/chef.js'
import { viewToolPolicy } from '../src/main/view-tools/policy.js'
import { fullToolName } from '../src/shared/view-tools.js'
import { EMPTY_PROJECTS_STATE, type ProjectsState } from '../src/shared/projects.js'
import { addProject, createProjectEntry, openConversationTab } from '../src/main/projects-state.js'

describe('PROVIDERS 是唯一的來源', () => {
  it('三個值,順序固定', () => {
    expect(PROVIDERS).toEqual(['claude', 'codex', 'grok'])
  })

  it('providerSchema 三個都收,別的不收', () => {
    for (const p of PROVIDERS) expect(providerSchema.safeParse(p).success).toBe(true)
    expect(providerSchema.safeParse('gemini').success).toBe(false)
  })

  it('asProvider 只認得這三個', () => {
    expect(asProvider('grok')).toBe('grok')
    expect(asProvider('gemini')).toBeUndefined()
    expect(asProvider(1)).toBeUndefined()
  })

  it('PROVIDER_LABELS 對每一項都有值', () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_LABELS[p].name.length).toBeGreaterThan(0)
      expect(PROVIDER_LABELS[p].tabTitle.length).toBeGreaterThan(0)
    }
    expect(PROVIDER_LABELS.grok).toEqual({ name: 'Grok', tabTitle: 'Grok 對話' })
    // 裁決:codex 那列留小寫,既有分頁的編號才不會斷。
    expect(PROVIDER_LABELS.codex.tabTitle).toBe('codex 對話')
  })
})

describe('三處 schema 都接受 grok', () => {
  it('狀態檔的 tab.provider 與 session.provider', () => {
    const state = {
      schemaVersion: 2, activeId: 'p1', openIdsOnShutdown: [],
      projects: [{
        id: 'p1', rootPath: '/p', name: 'p', addedAt: 1, lastOpenedAt: 1, lastUrl: null,
        tabs: [{ id: 't1', contentType: 'conversation', label: 'Grok 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1', provider: 'grok' }],
        threads: [{
          id: 'th1', handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 1,
          sessions: [{ linkId: 's1', provider: 'grok', sessionId: 's1', transcriptPath: null, parentLinkId: null, startedAt: 1, endedAt: null, endReason: null, models: [] }],
        }],
      }],
    }
    expect(parseProjectsState(state)).not.toBeNull()
  })

  it('ChefModelSchema 的 provider', () => {
    const model = { key: 'grok:grok-4-7', provider: 'grok', model: 'grok-4-7', label: 'Grok 4.7', description: '', recommended: true }
    expect(ChefModelSchema.safeParse(model).success).toBe(true)
  })

  it('IPC 的兩個守衛', () => {
    expect(parseConversationOpen({ projectId: 'p1', provider: 'grok' })).toEqual({ projectId: 'p1', provider: 'grok' })
    expect(parseConversationOpen({ projectId: 'p1', provider: 'gemini' })).toBeNull()
    expect(parseSessionListScope({ projectId: null, provider: 'grok' })).toEqual({ projectId: null, provider: 'grok' })
    expect(parseSessionListScope({ projectId: null, provider: 'gemini' })).toBeNull()
  })
})

describe('行為分支查表', () => {
  it('view_navigate 只有 codex 要批准', () => {
    expect(viewToolPolicy(fullToolName('view_navigate'), 'claude')).toBe('allow')
    expect(viewToolPolicy(fullToolName('view_navigate'), 'codex')).toBe('ask')
    expect(viewToolPolicy(fullToolName('view_navigate'), 'grok')).toBe('allow')
  })

  it('view_eval 三個 provider 都要批准', () => {
    for (const p of PROVIDERS) expect(viewToolPolicy(fullToolName('view_eval'), p)).toBe('ask')
  })

  it('不在白名單的名稱一律 ask', () => {
    for (const p of PROVIDERS) expect(viewToolPolicy('mcp__yeschef__view_navigate_extra', p)).toBe('ask')
  })

  it('新分頁的預設標籤照 PROVIDER_LABELS', () => {
    const entry = createProjectEntry({ id: 'p1', rootPath: '/p', conversationTabId: 't0', threadId: 'th0', now: 1 })
    const added: ProjectsState = addProject(EMPTY_PROJECTS_STATE, entry)
    const next = openConversationTab(added, 'p1', { tabId: 't1', threadId: 'th1', provider: 'grok' }, 2)
    const tab = next.projects[0]?.tabs.find((t) => t.id === 't1')
    expect(tab?.label).toBe('Grok 對話')
    const third = openConversationTab(next, 'p1', { tabId: 't2', threadId: 'th2', provider: 'grok' }, 3)
    expect(third.projects[0]?.tabs.find((t) => t.id === 't2')?.label).toBe('Grok 對話 2')
  })
})
