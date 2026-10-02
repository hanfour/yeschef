import { describe, it, expect } from 'vitest'
import { createProjectsService } from '../src/main/projects-service.js'
import type { ProjectsStore } from '../src/main/projects-store.js'
import { EMPTY_PROJECTS_STATE, type ProjectsState } from '../src/shared/projects.js'
import { activeTabId, addProject, createProjectEntry, openConversationTab, openTab, setActive } from '../src/main/projects-state.js'

function setup(opts: { failSave?: boolean; dirs?: readonly string[]; initial?: ProjectsState } = {}) {
  const saved: ProjectsState[] = []
  const errors: string[] = []
  let n = 0
  const store: ProjectsStore = {
    load: async () => EMPTY_PROJECTS_STATE,
    save: async (s) => {
      if (opts.failSave) throw new Error('disk full')
      saved.push(s)
    },
  }
  const service = createProjectsService({
    store,
    initial: opts.initial ?? EMPTY_PROJECTS_STATE,
    now: () => 1000,
    newId: () => `id-${++n}`,
    isDir: (p) => (opts.dirs ?? ['/Users/x/alpha']).includes(p),
    logError: (e) => errors.push(e.message),
  })
  return { service, saved, errors }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createProjectsService', () => {
  it('addProject 用 newId 產生專案、對話、thread 與群組 id,回專案 id,並存檔', async () => {
    const t = setup()
    const id = t.service.addProject('/Users/x/alpha')
    expect(id).toBe('id-1')
    const p = t.service.state().projects[0]!
    expect(p.tabs.find((tab) => tab.contentType === 'conversation')!.id).toBe('id-2')
    expect(p.threads[0]!.id).toBe('id-3')
    expect(p.tabs.filter((tab) => tab.contentType === 'group')).toHaveLength(1)
    expect(t.service.state().activeId).toBe('id-1')
    await flush()
    expect(t.saved).toHaveLength(1)
  })

  it('載入舊專案時補群組分頁,保留其他分頁、thread 與前景', async () => {
    const base = createProjectEntry({ id: 'legacy', rootPath: '/Users/x/alpha', conversationTabId: 'conv-1', threadId: 'thread-1', now: 10 })
    const withConversation = openConversationTab(addProject(EMPTY_PROJECTS_STATE, base), 'legacy', { tabId: 'conv-2', threadId: 'thread-2', provider: 'codex' }, 20)
    const withTerminal = openTab(withConversation, 'legacy', { id: 'term-1', label: 'zsh' }, 30)
    const initial = { ...withTerminal, projects: withTerminal.projects.map((project) => ({ ...project, tabs: project.tabs.filter((tab) => tab.contentType !== 'group') })) }
    const t = setup({ initial })
    const project = t.service.state().projects[0]!
    await flush()

    expect(project.tabs.filter((tab) => tab.contentType === 'group')).toHaveLength(1)
    expect(project.tabs.filter((tab) => tab.contentType !== 'group').map((tab) => tab.id)).toEqual(['conv-1', 'conv-2', 'term-1'])
    expect(project.threads.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2'])
    expect(project.tabs.find((tab) => tab.id === 'term-1')?.lastFocusedAt).toBe(30)
    expect(activeTabId(project)).toBe('term-1')
    expect(t.saved.at(-1)?.projects[0]?.tabs.some((tab) => tab.contentType === 'group')).toBe(true)
  })
  it('update 有變才通知與存檔;回原 state 時兩者都不做', async () => {
    const t = setup()
    const id = t.service.addProject('/Users/x/alpha')
    const seen: string[] = []
    t.service.subscribe((next, prev) => seen.push(`${prev.activeId}->${next.activeId}`))
    t.service.update((s) => s)
    t.service.update((s) => setActive(s, 'nope', 5))
    expect(seen).toEqual([])
    t.service.update((s) => setActive(s, id, 5))
    expect(seen).toEqual([`${id}->${id}`])
    await flush()
    expect(t.saved).toHaveLength(2)
  })
  it('unsubscribe 之後不再收到通知', () => {
    const t = setup()
    const seen: number[] = []
    const off = t.service.subscribe(() => seen.push(1))
    t.service.addProject('/Users/x/alpha')
    off()
    t.service.addProject('/Users/x/beta')
    expect(seen).toEqual([1])
  })
  it('rootPathOf 與 isAvailable', () => {
    const t = setup({ dirs: ['/Users/x/alpha'] })
    const a = t.service.addProject('/Users/x/alpha')
    const b = t.service.addProject('/Users/x/gone')
    expect(t.service.rootPathOf(a)).toBe('/Users/x/alpha')
    expect(t.service.rootPathOf('zzz')).toBeUndefined()
    expect(t.service.isAvailable(a)).toBe(true)
    expect(t.service.isAvailable(b)).toBe(false)
    expect(t.service.isAvailable('zzz')).toBe(false)
  })
  it('存檔失敗記錯,state 仍然更新', async () => {
    const t = setup({ failSave: true })
    t.service.addProject('/Users/x/alpha')
    await flush()
    expect(t.errors).toEqual(['寫入專案狀態檔失敗:disk full'])
    expect(t.service.state().projects).toHaveLength(1)
  })
  it('訂閱者拋錯不阻斷存檔與其他訂閱者', async () => {
    const t = setup()
    const id = t.service.addProject('/Users/x/alpha')
    await flush()
    const savedBefore = t.saved.length
    const seen: string[] = []
    t.service.subscribe(() => {
      throw new Error('boom')
    })
    t.service.subscribe((next, prev) => seen.push(`${prev.activeId}->${next.activeId}`))
    const next = t.service.update((s) => setActive(s, id, 5))
    expect(seen).toEqual([`${id}->${id}`])
    expect(t.service.state()).toBe(next)
    await flush()
    expect(t.saved).toHaveLength(savedBefore + 1)
    expect(t.saved.at(-1)).toBe(next)
    expect(t.errors.some((m) => m.includes('boom'))).toBe(true)
  })
})
