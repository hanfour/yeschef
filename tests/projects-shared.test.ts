import { describe, it, expect } from 'vitest'
import {
  EMPTY_PROJECTS_STATE,
  parseAddProjectResult,
  parseConversationOpen,
  parseProjectId,
  parseProjectsView,
  parseSessionListScope,
  parseTabOpen,
  parseTabTarget,
  type ProjectsView,
} from '../src/shared/projects.js'
import { IPC } from '../src/shared/ipc.js'

const VIEW: ProjectsView = {
  activeId: 'p1',
  projects: [
    {
      id: 'p1',
      name: 'demo',
      rootPath: '/Users/x/demo',
      available: true,
      pendingApproval: false,
      pendingTabIds: [],
      busyTabIds: [],
      busySince: {},
      producingTabIds: [],
      activeTabId: 't-conv',
      tabs: [
        { id: 't-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1' },
        { id: 't2', contentType: 'terminal', label: 'codex', customLabel: null, command: 'codex', sortOrder: 1, lastFocusedAt: 2 },
      ],
      threads: [{ id: 'th1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 1 }],
    },
  ],
}

function viewWithTab(extra: Record<string, unknown>): unknown {
  const [firstTab, ...restTabs] = VIEW.projects[0]!.tabs
  return {
    ...VIEW,
    projects: [{ ...VIEW.projects[0]!, tabs: [{ ...firstTab, ...extra }, ...restTabs] }],
  }
}

describe('IPC channel 名稱', () => {
  it('九個新 channel 的字面值固定', () => {
    expect(IPC.projectsGet).toBe('projects:get')
    expect(IPC.projectsState).toBe('projects:state')
    expect(IPC.projectsAdd).toBe('projects:add')
    expect(IPC.projectsRelocate).toBe('projects:relocate')
    expect(IPC.projectsRemove).toBe('projects:remove')
    expect(IPC.projectsActivate).toBe('projects:activate')
    expect(IPC.tabsOpen).toBe('tabs:open')
    expect(IPC.tabsClose).toBe('tabs:close')
    expect(IPC.tabsActivate).toBe('tabs:activate')
  })
})

describe('parseProjectId', () => {
  it('接受 { id: 非空字串 },丟掉多餘欄位', () => {
    expect(parseProjectId({ id: 'p1', extra: 1 })).toEqual({ id: 'p1' })
  })
  it.each([null, {}, { id: '' }, { id: 1 }, 'p1'])('拒絕 %j', (raw) => {
    expect(parseProjectId(raw)).toBeNull()
  })
})

describe('parseTabOpen', () => {
  it('command 選填,沒有就不帶 key', () => {
    expect(parseTabOpen({ projectId: 'p1', label: 'zsh' })).toEqual({ projectId: 'p1', label: 'zsh' })
    expect(parseTabOpen({ projectId: 'p1', label: 'codex', command: 'codex' })).toEqual({
      projectId: 'p1', label: 'codex', command: 'codex',
    })
  })
  it.each([{ projectId: 'p1' }, { label: 'zsh' }, { projectId: 'p1', label: '' }, { projectId: 'p1', label: 'x', command: 3 }])(
    '拒絕 %j', (raw) => {
      expect(parseTabOpen(raw)).toBeNull()
    })
})

describe('parseTabTarget', () => {
  it('兩個 id 都要是非空字串', () => {
    expect(parseTabTarget({ projectId: 'p1', tabId: 't1' })).toEqual({ projectId: 'p1', tabId: 't1' })
    expect(parseTabTarget({ projectId: 'p1' })).toBeNull()
    expect(parseTabTarget({ projectId: 'p1', tabId: '' })).toBeNull()
  })
})

describe('parseSessionListScope', () => {
  it('projectId 可以是字串或 null', () => {
    expect(parseSessionListScope({ projectId: 'p1' })).toEqual({ projectId: 'p1' })
    expect(parseSessionListScope({ projectId: null })).toEqual({ projectId: null })
  })
  it.each([undefined, {}, { projectId: 1 }, { projectId: '' }])('拒絕 %j', (raw) => {
    expect(parseSessionListScope(raw)).toBeNull()
  })
})

describe('parseProjectsView', () => {
  it('收群組分頁,不收未知的 contentType', () => {
    const group = { id: 'g1', contentType: 'group', label: '群組', customLabel: null, sortOrder: 3, lastFocusedAt: 9 }
    const first = VIEW.projects[0]!
    const withGroup = { ...VIEW, projects: [{ ...first, tabs: [...first.tabs, group] }] }
    expect(parseProjectsView(withGroup)?.projects[0]?.tabs).toHaveLength(first.tabs.length + 1)
    const unknown = { ...group, contentType: 'whiteboard' }
    expect(parseProjectsView({ ...VIEW, projects: [{ ...first, tabs: [unknown] }] })).toBeNull()
  })
  it('pendingTabIds 不是字串陣列就拒絕', () => {
    expect(parseProjectsView({ ...VIEW, projects: [{ ...VIEW.projects[0], pendingTabIds: [1] }] })).toBeNull()
    expect(parseProjectsView({ ...VIEW, projects: [{ ...VIEW.projects[0], pendingTabIds: 't' }] })).toBeNull()
  })
  it('完整的 view 原樣通過', () => {
    expect(parseProjectsView(VIEW)).toEqual(VIEW)
  })
  it('activeId 允許 null', () => {
    expect(parseProjectsView({ ...VIEW, activeId: null })?.activeId).toBeNull()
  })
  it('tabs 裡有一筆形狀不對就整個拒絕', () => {
    const bad = {
      ...VIEW,
      projects: [{ ...VIEW.projects[0], tabs: [{ id: 't', contentType: 'video', label: 'x', customLabel: null, sortOrder: 0, lastFocusedAt: 0 }] }],
    }
    expect(parseProjectsView(bad)).toBeNull()
  })
  it('threads 只驗 id 與 sessions[].sessionId,其餘欄位原樣保留', () => {
    const withSession = {
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        threads: [{ id: 'th1', sessions: [{ sessionId: 's1', transcriptPath: '/t', parentSessionId: null, startedAt: 1, endedAt: null, endReason: null }], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 1 }],
      }],
    }
    expect(parseProjectsView(withSession)).toEqual(withSession)
    const badThread = { ...VIEW, projects: [{ ...VIEW.projects[0], threads: [{ id: 'th1', sessions: [{ sessionId: 3 }] }] }] }
    expect(parseProjectsView(badThread)).toBeNull()
  })
  it.each([null, { projects: 'x', activeId: null }, { projects: [], activeId: 1 }])('拒絕 %j', (raw) => {
    expect(parseProjectsView(raw)).toBeNull()
  })
})

describe('parseAddProjectResult', () => {
  it('三種結果', () => {
    expect(parseAddProjectResult({ kind: 'added', id: 'p1' })).toEqual({ kind: 'added', id: 'p1' })
    expect(parseAddProjectResult({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' })
    expect(parseAddProjectResult({ kind: 'rejected', message: '不是資料夾' })).toEqual({ kind: 'rejected', message: '不是資料夾' })
  })
  it.each([{ kind: 'added' }, { kind: 'rejected' }, { kind: 'nope' }, null])('拒絕 %j', (raw) => {
    expect(parseAddProjectResult(raw)).toBeNull()
  })
})

describe('EMPTY_PROJECTS_STATE', () => {
  it('schemaVersion 2,沒有專案,activeId null', () => {
    expect(EMPTY_PROJECTS_STATE).toEqual({ schemaVersion: 2, projects: [], activeId: null, openIdsOnShutdown: [] })
  })
})

describe('parseConversationOpen', () => {
  it('接受兩種 provider,丟掉多餘欄位', () => {
    expect(parseConversationOpen({ projectId: 'p', provider: 'claude', extra: 1 })).toEqual({ projectId: 'p', provider: 'claude' })
    expect(parseConversationOpen({ projectId: 'p', provider: 'codex' })).toEqual({ projectId: 'p', provider: 'codex' })
  })
  it('缺 provider 或不認得的值就拒絕', () => {
    expect(parseConversationOpen({ projectId: 'p' })).toBeNull()
    expect(parseConversationOpen({ projectId: 'p', provider: 'gemini' })).toBeNull()
    expect(parseConversationOpen({ projectId: '', provider: 'claude' })).toBeNull()
  })
})

it('session scope 接受 codex 與 claude,拒絕未知 provider', () => {
  expect(parseSessionListScope({ projectId: 'p', provider: 'codex' })).toEqual({ projectId: 'p', provider: 'codex' })
  expect(parseSessionListScope({ projectId: null, provider: 'claude' })).toEqual({ projectId: null, provider: 'claude' })
  // Task 1(PROVIDERS 表)之後 grok 是已知 provider,換一個仍然不認得的值測「拒絕未知 provider」。
  expect(parseSessionListScope({ projectId: 'p', provider: 'gemini' })).toBeNull()
})

it('舊 ProjectsView 缺 busySince 時以空物件補齊且不修改輸入', () => {
  const projects = VIEW.projects.map(({ busySince: _since, ...project }) => Object.freeze(project))
  const raw = Object.freeze({ ...VIEW, projects: Object.freeze(projects) })
  expect(parseProjectsView(raw)?.projects[0]?.busySince).toEqual({})
  expect(Object.hasOwn(projects[0] ?? {}, 'busySince')).toBe(false)
})
it.each([null, [], 'wrong', { tab: 'wrong' }, { tab: NaN }, { tab: Infinity }])('拒絕無效 busySince %j', (busySince) => {
  expect(parseProjectsView({ ...VIEW, projects: [{ ...VIEW.projects[0], busySince }] })).toBeNull()
})
it('保留有效 busySince', () => {
  expect(parseProjectsView({ ...VIEW, projects: [{ ...VIEW.projects[0], busySince: { tab: 123 } }] })?.projects[0]?.busySince).toEqual({ tab: 123 })
})

it('舊 ProjectsView 缺 producingTabIds 時補空陣列且不修改輸入', () => {
  const projects = VIEW.projects.map(({ producingTabIds: _producing, ...project }) => Object.freeze(project))
  const raw = Object.freeze({ ...VIEW, projects: Object.freeze(projects) })
  expect(parseProjectsView(raw)?.projects[0]?.producingTabIds).toEqual([])
  expect(Object.hasOwn(projects[0] ?? {}, 'producingTabIds')).toBe(false)
})
it.each([null, {}, 'wrong', [123], [''], [null]])('拒絕無效 producingTabIds %j', (producingTabIds) => {
  expect(parseProjectsView({ ...VIEW, projects: [{ ...VIEW.projects[0], producingTabIds }] })).toBeNull()
})
it('保留有效 producingTabIds', () => {
  expect(parseProjectsView({ ...VIEW, projects: [{ ...VIEW.projects[0], producingTabIds: ['tab'] }] })?.projects[0]?.producingTabIds).toEqual(['tab'])
})

describe('parseConversationOpen 的 worktreeName', () => {
  it.each([undefined, ''])('省略或空字串不帶入 %j', (worktreeName) => {
    expect(parseConversationOpen({ projectId: 'p', provider: 'claude', worktreeName }))
      .toEqual({ projectId: 'p', provider: 'claude' })
  })
  it('保留非空名稱並去除額外欄位', () => {
    expect(parseConversationOpen({ projectId: 'p', provider: 'codex', worktreeName: '新功能', extra: 1 }))
      .toEqual({ projectId: 'p', provider: 'codex', worktreeName: '新功能' })
  })
  it.each([null, 1, false, {}, []])('錯誤型別整包拒絕 %j', (worktreeName) => {
    expect(parseConversationOpen({ projectId: 'p', provider: 'claude', worktreeName })).toBeNull()
  })
})

it.each(['/p/.worktrees/task', 42])('projects view 驗證 worktreePath 型別 %j', (worktreePath) => {
  const raw = { ...VIEW, projects: VIEW.projects.map((p) => ({
    ...p, tabs: p.tabs.map((t) => ({ ...t, worktreePath })),
  })) }
  expect(parseProjectsView(raw)).toEqual(typeof worktreePath === 'string' ? raw : null)
})


it('isTabEntry 收 lastUrl 是字串或 null,其他型別拒收', () => {
  expect(parseProjectsView(viewWithTab({ lastUrl: 'https://a.test/' }))).not.toBeNull()
  expect(parseProjectsView(viewWithTab({ lastUrl: null }))).not.toBeNull()
  expect(parseProjectsView(viewWithTab({ lastUrl: 3 }))).toBeNull()
})

it('view 的 Git 快取與錯誤訊息選填，接受布林而拒絕錯誤型別', () => {
  const view = { ...VIEW, error: '保留目錄', projects: VIEW.projects.map((p) => ({ ...p, isGitRepo: true })) }
  expect(parseProjectsView(view)).toEqual(view)
  expect(parseProjectsView({ ...view, error: 1 })).toBeNull()
  expect(parseProjectsView({ ...view, projects: VIEW.projects.map((p) => ({ ...p, isGitRepo: 'true' })) })).toBeNull()
})
