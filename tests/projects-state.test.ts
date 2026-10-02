import { describe, it, expect } from 'vitest'
import {
  activeTabId, addProject, closeInactiveChefTabs, closeTab, activeConversationId, conversationDir, conversationTabs, findProjectByTab, foregroundConversationId, openConversationTab, createProjectEntry, currentThread, findProject,
  focusTab, lastSessionId, openTab, pointConversationAt, recordSession, relocateProject, removeProject, removedProjectIds,
  recordSessionCost, sessionCostOf, setActive, setLastUrl, setShutdown, startThread, openGroupTab,
  setTabLastUrl, tabLastUrl,
} from '../src/main/projects-state.js'
import { checkNavigateUrl } from '../src/main/view-tools/urls.js'
import { EMPTY_PROJECTS_STATE, PROJECTS_SCHEMA_VERSION, sortTabs, type ProjectEntry, type ProjectsState, type SessionLink, type TabEntry } from '../src/shared/projects.js'

const entryA = createProjectEntry({ id: 'a', rootPath: '/Users/x/alpha', conversationTabId: 'a-conv', threadId: 'a-th1', now: 100 })
const entryB = createProjectEntry({ id: 'b', rootPath: '/Users/x/beta', conversationTabId: 'b-conv', threadId: 'b-th1', now: 101 })
const two = addProject(addProject(EMPTY_PROJECTS_STATE, entryA), entryB)

const link = (sessionId: string): SessionLink => ({
  linkId: sessionId, provider: 'claude', sessionId, transcriptPath: `/home/.claude/projects/x/${sessionId}.jsonl`, parentLinkId: null, startedAt: 500, endedAt: null, endReason: null, models: [],
})

describe('createProjectEntry / addProject', () => {
  it('名稱取資料夾名,只有一個對話分頁與一條空 thread', () => {
    expect(entryA.name).toBe('alpha')
    expect(entryA.tabs).toEqual([
      { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 100, threadId: 'a-th1', provider: 'claude' },
    ])
    expect(entryA.threads).toEqual([{ id: 'a-th1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 100 }])
    expect(entryA.lastUrl).toBeNull()
  })
  it('第一個加入的專案自動成為 active,之後加入的不搶', () => {
    expect(two.activeId).toBe('a')
    expect(two.projects.map((p) => p.id)).toEqual(['a', 'b'])
  })
  it('不修改傳入的 state', () => {
    const before = JSON.stringify(EMPTY_PROJECTS_STATE)
    addProject(EMPTY_PROJECTS_STATE, entryA)
    expect(JSON.stringify(EMPTY_PROJECTS_STATE)).toBe(before)
  })
})

describe('removeProject / setActive / relocateProject', () => {
  it('移除 active 專案時 activeId 退到剩下的第一個', () => {
    const s = removeProject(two, 'a')
    expect(s.projects.map((p) => p.id)).toEqual(['b'])
    expect(s.activeId).toBe('b')
  })
  it('移除最後一個專案後 activeId 為 null', () => {
    expect(removeProject(removeProject(two, 'a'), 'b').activeId).toBeNull()
  })
  it('移除非 active 專案不動 activeId;未知 id 回原 state', () => {
    expect(removeProject(two, 'b').activeId).toBe('a')
    expect(removeProject(two, 'zzz')).toBe(two)
  })
  it('setActive 改 activeId 並更新 lastOpenedAt;未知 id 回原 state', () => {
    const s = setActive(two, 'b', 900)
    expect(s.activeId).toBe('b')
    expect(findProject(s, 'b')?.lastOpenedAt).toBe(900)
    expect(setActive(two, 'zzz', 900)).toBe(two)
  })
  it('relocateProject 換路徑與名稱,分頁與 thread 原樣', () => {
    const s = relocateProject(two, 'a', '/Volumes/ext/alpha-moved')
    const p = findProject(s, 'a')!
    expect(p.rootPath).toBe('/Volumes/ext/alpha-moved')
    expect(p.name).toBe('alpha-moved')
    expect(p.tabs).toEqual(entryA.tabs)
    expect(p.threads).toEqual(entryA.threads)
  })
})

describe('分頁', () => {
  const withTerm = openTab(two, 'a', { id: 'a-t1', label: 'codex', command: 'codex' }, 200)

  it('openTab 接在最後、取得焦點,command 沒給就不帶 key', () => {
    const p = findProject(withTerm, 'a')!
    expect(p.tabs.map((t) => t.id)).toEqual(['a-conv', 'a-t1'])
    expect(p.tabs[1]).toEqual({ id: 'a-t1', contentType: 'terminal', label: 'codex', customLabel: null, command: 'codex', sortOrder: 1, lastFocusedAt: 200 })
    expect(activeTabId(p)).toBe('a-t1')
    const plain = openTab(withTerm, 'a', { id: 'a-t2', label: 'zsh' }, 201)
    expect(findProject(plain, 'a')!.tabs[2]).not.toHaveProperty('command')
    expect(findProject(plain, 'a')!.tabs[2]!.sortOrder).toBe(2)
  })
  it('開分頁只影響該專案', () => {
    expect(findProject(withTerm, 'b')!.tabs).toEqual(entryB.tabs)
  })
  it('closeTab 關掉有焦點的終端分頁後,焦點回對話分頁', () => {
    const s = closeTab(withTerm, 'a', 'a-t1', 300)
    const p = findProject(s, 'a')!
    expect(p.tabs.map((t) => t.id)).toEqual(['a-conv'])
    expect(activeTabId(p)).toBe('a-conv')
    expect(conversationTabs(p)[0]?.lastFocusedAt).toBe(300)
  })
  it('closeTab 關掉沒有焦點的分頁,不動焦點', () => {
    const s = openTab(withTerm, 'a', { id: 'a-t2', label: 'zsh' }, 250)
    const closed = closeTab(s, 'a', 'a-t1', 300)
    expect(activeTabId(findProject(closed, 'a')!)).toBe('a-t2')
    expect(conversationTabs(findProject(closed, 'a')!)[0]?.lastFocusedAt).toBe(100)
  })
  it('closeTab 拒絕關對話分頁與未知分頁', () => {
    expect(closeTab(withTerm, 'a', 'a-conv', 300)).toBe(withTerm)
    expect(closeTab(withTerm, 'a', 'nope', 300)).toBe(withTerm)
  })
  it('啟動清理移除已結束與找不到 attempt 的背景主廚分頁,保留執行中的與前景分頁', () => {
    const before = stateOf(entry([
      convTab('foreground', 0, { chefTaskId: 'task', lastFocusedAt: 500 }),
      convTab('done', 1, { chefTaskId: 'task', lastFocusedAt: 200 }),
      convTab('running', 2, { chefTaskId: 'task', lastFocusedAt: 300 }),
      convTab('stopping', 3, { chefTaskId: 'task', lastFocusedAt: 250 }),
      convTab('orphan', 4, { chefTaskId: 'missing-task', lastFocusedAt: 100 }),
      convTab('wrong-owner', 5, { chefTaskId: 'task', lastFocusedAt: 150 }),
    ], null))
    const after = closeInactiveChefTabs(before, new Map([
      ['task', new Set(['running', 'stopping'])],
      ['another-task', new Set(['wrong-owner'])],
    ]), 600)

    expect(findProject(after, 'p1')?.tabs.map((tab) => tab.id)).toEqual(['foreground', 'running', 'stopping'])
    expect(findProject(before, 'p1')?.tabs).toHaveLength(6)
  })
  it('前景主廚分頁先保留,使用者切走後下一次清理會關閉', () => {
    const before = stateOf(entry([
      convTab('other', 0, { lastFocusedAt: 100 }),
      convTab('foreground-chef', 1, { chefTaskId: 'task', lastFocusedAt: 200 }),
    ], null))
    const first = closeInactiveChefTabs(before, new Map(), 300)
    const switched = focusTab(first, 'p1', 'other', 400)
    const afterSwitch = closeInactiveChefTabs(switched, new Map(), 500)

    expect(findProject(first, 'p1')?.tabs.map((tab) => tab.id)).toEqual(['other', 'foreground-chef'])
    expect(findProject(afterSwitch, 'p1')?.tabs.map((tab) => tab.id)).toEqual(['other'])
  })
  it('最後一個對話分頁沿用 closeTab 規則保留', () => {
    const oneChefTab = stateOf(entry([
      convTab('only-chef', 0, { chefTaskId: 'task', lastFocusedAt: 100 }),
    ], null))
    const withGroup = openGroupTab(oneChefTab, 'p1', 'group', 200)

    expect(closeInactiveChefTabs(withGroup, new Map(), 300)).toBe(withGroup)
  })
  it('focusTab 更新 lastFocusedAt;未知分頁回原 state', () => {
    const s = focusTab(withTerm, 'a', 'a-conv', 400)
    expect(activeTabId(findProject(s, 'a')!)).toBe('a-conv')
    expect(focusTab(withTerm, 'a', 'nope', 400)).toBe(withTerm)
  })
  it('setLastUrl 只改該專案', () => {
    const s = setLastUrl(two, 'b', 'https://example.com/')
    expect(findProject(s, 'b')!.lastUrl).toBe('https://example.com/')
    expect(findProject(s, 'a')!.lastUrl).toBeNull()
  })
})

describe('openGroupTab', () => {
  it('一個專案只開一個,再開一次只是把焦點移過去', () => {
    const first = openGroupTab(two, 'a', 'g1', 300)
    const tabs = findProject(first, 'a')!.tabs
    expect(tabs.filter((t) => t.contentType === 'group')).toHaveLength(1)
    expect(tabs.at(-1)).toMatchObject({ id: 'g1', contentType: 'group', label: '群組', customLabel: null, lastFocusedAt: 300 })
    expect(tabs.at(-1)).not.toHaveProperty('threadId')
    expect(tabs.at(-1)).not.toHaveProperty('provider')

    const again = openGroupTab(first, 'a', 'g2', 400)
    const afterTabs = findProject(again, 'a')!.tabs
    expect(afterTabs.filter((t) => t.contentType === 'group')).toHaveLength(1)
    expect(afterTabs.find((t) => t.contentType === 'group')).toMatchObject({ id: 'g1', lastFocusedAt: 400 })
    expect(activeTabId(findProject(again, 'a')!)).toBe('g1')
  })

  it('主行程拒絕關閉群組分頁,最後一個對話分頁仍然關不掉', () => {
    const opened = openGroupTab(two, 'a', 'g1', 300)
    const closed = closeTab(opened, 'a', 'g1', 400)
    expect(closed).toBe(opened)
    expect(findProject(closed, 'a')!.tabs.some((t) => t.contentType === 'group')).toBe(true)
    expect(closeTab(closed, 'a', 'a-conv', 500)).toBe(closed)
  })

  it('群組依 shared 排序規則永遠排第一,即使 sortOrder 較大', () => {
    const opened = openGroupTab(two, 'a', 'g1', 300)
    const entry = findProject(opened, 'a')!
    const altered = { ...entry, tabs: entry.tabs.map((tab) => tab.contentType === 'group' ? { ...tab, sortOrder: 99 } : { ...tab, sortOrder: -1 }) }

    expect(sortTabs(altered.tabs).map((tab) => tab.contentType)).toEqual(['group', 'conversation'])
  })

  it('不改原 state,未知專案回原 state', () => {
    const before = JSON.stringify(two)
    openGroupTab(two, 'a', 'g1', 300)
    expect(JSON.stringify(two)).toBe(before)
    expect(openGroupTab(two, '不存在', 'g1', 300)).toBe(two)
  })
})

describe('thread 與 session 鏈', () => {
  it('recordSession 隔著別的 session 再出現同一個 sessionId,不重複記', () => {
    // E 在同一條 thread 上換 session 時會走到:s1 → s2 → 再收到一次 s1 的
    // session-started(resume 回舊那段)。只跟最後一筆比對的實作會記成四筆。
    const chain = recordSession(
      recordSession(recordSession(two, 'a', 'a-th1', link('s1')), 'a', 'a-th1', link('s2')),
      'a', 'a-th1', link('s1'),
    )
    expect(chain.projects[0]?.threads[0]?.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2'])
  })

  it('recordSession 遇到已在鏈上的 sessionId 時原樣回傳,不換新物件', () => {
    const s1 = recordSession(two, 'a', 'a-th1', link('s1'))
    const s2 = recordSession(s1, 'a', 'a-th1', link('s2'))
    expect(recordSession(s2, 'a', 'a-th1', link('s1'))).toBe(s2)
  })

  it('recordSession 接到指定 thread 尾端;同一 sessionId 連續兩次只記一次', () => {
    const s1 = recordSession(two, 'a', 'a-th1', link('s1'))
    const s2 = recordSession(s1, 'a', 'a-th1', link('s1'))
    expect(s2).toBe(s1)
    expect(currentThread(findProject(s1, 'a')!, 'a-conv')!.sessions.map((l) => l.sessionId)).toEqual(['s1'])
    expect(lastSessionId(findProject(s1, 'a')!, 'a-conv')).toBe('s1')
    expect(recordSession(two, 'a', 'nope', link('s1'))).toBe(two)
  })
  it('startThread 新增 thread、對話分頁指過去、丟掉沒有 session 的舊 thread', () => {
    const s1 = recordSession(two, 'a', 'a-th1', link('s1'))
    const s2 = startThread(s1, 'a', 'a-conv', 'a-th2', 600)
    const p = findProject(s2, 'a')!
    expect(p.threads.map((t) => t.id)).toEqual(['a-th1', 'a-th2'])
    expect(conversationTabs(p)[0]?.threadId).toBe('a-th2')
    expect(currentThread(p, 'a-conv')!.id).toBe('a-th2')
    expect(lastSessionId(p, 'a-conv')).toBeUndefined()
    const s3 = startThread(s2, 'a', 'a-conv', 'a-th3', 700)
    expect(findProject(s3, 'a')!.threads.map((t) => t.id)).toEqual(['a-th1', 'a-th3'])
  })
  it('pointConversationAt 找到含該 session 的 thread 就指過去', () => {
    const s1 = startThread(recordSession(two, 'a', 'a-th1', link('s1')), 'a', 'a-conv', 'a-th2', 600)
    const s2 = pointConversationAt(s1, 'a', 'a-conv', link('s1'), 'unused', 650)
    const p = findProject(s2, 'a')!
    expect(conversationTabs(p)[0]?.threadId).toBe('a-th1')
    expect(p.threads.map((t) => t.id)).toEqual(['a-th1'])
  })
  it('pointConversationAt 找不到就用 newThreadId 建一條含該 link 的 thread', () => {
    const s = pointConversationAt(two, 'a', 'a-conv', link('legacy'), 'a-th9', 650)
    const p = findProject(s, 'a')!
    expect(p.threads.map((t) => t.id)).toEqual(['a-th9'])
    expect(currentThread(p, 'a-conv')!.sessions).toEqual([link('legacy')])
    expect(currentThread(p, 'a-conv')!.createdAt).toBe(650)
  })
  it('setShutdown 只換 openIdsOnShutdown', () => {
    expect(setShutdown(two, ['b']).openIdsOnShutdown).toEqual(['b'])
  })
})

describe('openConversationTab', () => {
  const s = openConversationTab(two, 'a', { tabId: 'a-conv2', threadId: 'a-th2' }, 300)
  const a = findProject(s, 'a')!

  it('新增一個 conversation 分頁與一條空 thread,sortOrder 排最後,標籤帶序號', () => {
    expect(a.tabs.at(-1)).toEqual({
      id: 'a-conv2', contentType: 'conversation', label: 'Claude 對話 2', customLabel: null,
      sortOrder: 1, lastFocusedAt: 300, threadId: 'a-th2', provider: 'claude',
    })
    expect(a.threads.map((t) => t.id)).toEqual(['a-th1', 'a-th2'])
  })
  it('新開的立刻成為 active 分頁與前景對話', () => {
    expect(activeTabId(a)).toBe('a-conv2')
    expect(activeConversationId(a)).toBe('a-conv2')
    expect(foregroundConversationId(s)).toBe('a-conv2')
  })
  it('第三個的標籤是 3', () => {
    const t = openConversationTab(s, 'a', { tabId: 'a-conv3', threadId: 'a-th3' }, 400)
    expect(findProject(t, 'a')!.tabs.at(-1)?.label).toBe('Claude 對話 3')
  })
  it('關掉第一個對話後再開,標籤沿用最大序號加一', () => {
    const closed = closeTab(s, 'a', 'a-conv', 400)
    const t = openConversationTab(closed, 'a', { tabId: 'a-conv3', threadId: 'a-th3' }, 500)
    expect(conversationTabs(findProject(t, 'a')!).map((x) => x.label)).toEqual(['Claude 對話 2', 'Claude 對話 3'])
  })
  it('找不到專案回原 state', () => {
    expect(openConversationTab(two, 'zzz', { tabId: 'x', threadId: 'y' }, 1)).toBe(two)
  })
})

describe('closeTab 對 conversation 分頁', () => {
  const s = openConversationTab(two, 'a', { tabId: 'a-conv2', threadId: 'a-th2' }, 300)

  it('關掉 active 的對話分頁:分頁與它的空 thread 都移除,焦點回到另一個對話分頁', () => {
    const t = closeTab(s, 'a', 'a-conv2', 500)
    const a = findProject(t, 'a')!
    expect(a.tabs.map((x) => x.id)).toEqual(['a-conv'])
    expect(a.threads.map((x) => x.id)).toEqual(['a-th1'])
    expect(activeTabId(a)).toBe('a-conv')
    expect(a.tabs[0]?.lastFocusedAt).toBe(500)
  })
  it('關掉的對話分頁 thread 有 session 就保留', () => {
    const withSession = recordSession(s, 'a', 'a-th2', link('s-2'))
    const t = closeTab(withSession, 'a', 'a-conv2', 500)
    expect(findProject(t, 'a')!.threads.map((x) => x.id)).toEqual(['a-th1', 'a-th2'])
  })
  it('關最後一個對話分頁被拒,回原 state', () => {
    expect(closeTab(two, 'a', 'a-conv', 500)).toBe(two)
  })
  it('關掉 active 的終端分頁,焦點回到最近聚焦的對話分頁', () => {
    const withTerm = openTab(s, 'a', { id: 'a-t1', label: 'zsh' }, 600)
    const t = closeTab(withTerm, 'a', 'a-t1', 700)
    expect(activeTabId(findProject(t, 'a')!)).toBe('a-conv2')
  })
})

describe('startThread / pointConversationAt 只動指定的對話分頁', () => {
  const s = openConversationTab(two, 'a', { tabId: 'a-conv2', threadId: 'a-th2' }, 300)

  it('startThread 換掉 a-conv 的 thread,a-conv2 的空 thread 不被回收', () => {
    const t = startThread(s, 'a', 'a-conv', 'a-th9', 400)
    const a = findProject(t, 'a')!
    expect(conversationTabs(a).map((x) => x.threadId)).toEqual(['a-th9', 'a-th2'])
    expect(a.threads.map((x) => x.id)).toEqual(['a-th2', 'a-th9'])
  })
  it('pointConversationAt:沒人指著的既有 thread 直接接上', () => {
    const withSession = recordSession(s, 'a', 'a-th1', link('s-1'))
    // a-conv 指著 a-th1;把 a-conv 自己再指到 s-1 → 仍是 a-th1,不新建
    const t = pointConversationAt(withSession, 'a', 'a-conv', link('s-1'), 'unused', 400)
    expect(conversationTabs(findProject(t, 'a')!).map((x) => x.threadId)).toEqual(['a-th1', 'a-th2'])
  })
  it('pointConversationAt:別的分頁已指著那條 thread 時另建一條,起點同一場 session', () => {
    const withSession = recordSession(s, 'a', 'a-th1', link('s-1'))
    const t = pointConversationAt(withSession, 'a', 'a-conv2', link('s-1'), 'a-th9', 400)
    const a = findProject(t, 'a')!
    expect(conversationTabs(a).map((x) => x.threadId)).toEqual(['a-th1', 'a-th9'])
    expect(a.threads.map((x) => x.id)).toEqual(['a-th1', 'a-th9'])
    expect(lastSessionId(a, 'a-conv')).toBe('s-1')
    expect(lastSessionId(a, 'a-conv2')).toBe('s-1')
  })
  it('currentThread / lastSessionId 依 conversationId', () => {
    const withSession = recordSession(s, 'a', 'a-th2', link('s-2'))
    const a = findProject(withSession, 'a')!
    expect(currentThread(a, 'a-conv2')?.id).toBe('a-th2')
    expect(lastSessionId(a, 'a-conv2')).toBe('s-2')
    expect(lastSessionId(a, 'a-conv')).toBeUndefined()
    expect(currentThread(a, 'nope')).toBeUndefined()
  })
})

describe('findProjectByTab / foregroundConversationId', () => {
  it('依分頁 id 找到專案', () => {
    expect(findProjectByTab(two, 'b-conv')?.id).toBe('b')
    expect(findProjectByTab(two, 'nope')).toBeUndefined()
  })
  it('沒有 active 專案時前景是 null', () => {
    expect(foregroundConversationId(EMPTY_PROJECTS_STATE)).toBeNull()
  })
  it('active 專案在終端分頁時,前景仍是它最近聚焦的對話分頁', () => {
    const s = openTab(two, 'a', { id: 'a-t1', label: 'zsh' }, 900)
    expect(activeTabId(findProject(s, 'a')!)).toBe('a-t1')
    expect(foregroundConversationId(s)).toBe('a-conv')
  })
})

describe('conversationDir', () => {
  const worktreePath = '/private/tmp/alpha-worktrees/fix-tabs'
  const withWorktree = openConversationTab(two, 'a', {
    tabId: 'wt-conv', threadId: 'wt-thread', worktreePath,
  }, 300)

  it('分頁有 worktreePath 就回 worktree 路徑', () => {
    expect(conversationDir(withWorktree, 'wt-conv')).toBe(worktreePath)
  })

  it('分頁沒有 worktreePath 就回專案 rootPath', () => {
    expect(conversationDir(withWorktree, 'a-conv')).toBe('/Users/x/alpha')
  })

  it('找不到分頁所屬的專案就回 undefined', () => {
    expect(conversationDir(withWorktree, 'nope')).toBeUndefined()
  })

  it('與 checkNavigateUrl 組合:worktree 底下的對話進不去主 checkout,也進不去別的 worktree,只進得去自己的 worktree', () => {
    const siblingWorktree = '/private/tmp/alpha-worktrees/other-task'
    const withSibling = openConversationTab(withWorktree, 'a', {
      tabId: 'wt-conv2', threadId: 'wt-thread2', worktreePath: siblingWorktree,
    }, 301)
    const dir = conversationDir(withSibling, 'wt-conv')!
    expect(dir).toBe(worktreePath)
    expect(checkNavigateUrl(`file://${dir}/index.html`, dir).kind).toBe('ok')
    expect(checkNavigateUrl('file:///Users/x/alpha/index.html', dir).kind).toBe('outside-project')
    expect(checkNavigateUrl(`file://${siblingWorktree}/index.html`, dir).kind).toBe('outside-project')
  })
})

describe('openConversationTab 的 provider', () => {
  it('codex 分頁的標籤與 provider 分開編號', () => {
    const s1 = openConversationTab(two, 'a', { tabId: 'a-x1', threadId: 'a-t1', provider: 'codex' }, 300)
    expect(findProject(s1, 'a')!.tabs.at(-1)).toMatchObject({ label: 'codex 對話', provider: 'codex' })
    const s2 = openConversationTab(s1, 'a', { tabId: 'a-x2', threadId: 'a-t2', provider: 'codex' }, 400)
    expect(findProject(s2, 'a')!.tabs.at(-1)).toMatchObject({ label: 'codex 對話 2', provider: 'codex' })
    const s3 = openConversationTab(s2, 'a', { tabId: 'a-c2', threadId: 'a-t3' }, 500)
    expect(findProject(s3, 'a')!.tabs.at(-1)).toMatchObject({ label: 'Claude 對話 2', provider: 'claude' })
  })
})


describe('session 花費', () => {
  it('同一 session 的花費後蓋前，不累加且保留原 state', () => {
    const state = recordSession(two, 'b', 'b-th1', link('s1'))
    const first = recordSessionCost(state, 'b', 's1', { usd: 1, turns: 1 })
    const second = recordSessionCost(first, 'b', 's1', { usd: 2, turns: 3 })
    expect(sessionCostOf(second, 's1')).toEqual({ usd: 2, turns: 3 })
    expect(sessionCostOf(first, 's1')).toEqual({ usd: 1, turns: 1 })
    expect(sessionCostOf(state, 's1')).toBeUndefined()
  })

  it('跨專案 resume 可找回非目前專案底下的同一 session 花費', () => {
    const original = recordSession(two, 'b', 'b-th1', link('resumed'))
    const cost = { usd: 1, turns: 1 }
    const recorded = recordSessionCost(original, 'b', 'resumed', cost)
    expect(recorded.activeId).toBe('a')
    expect(sessionCostOf(recorded, 'resumed')).toEqual(cost)
  })

  it('更新任一 thread 的相符 session,保留其他 link 與原 state', () => {
    const state = recordSession(recordSession(two, 'b', 'b-th1', link('s1')), 'b', 'b-th1', link('s2'))
    const before = JSON.stringify(state)
    const cost = { usd: 0.12, turns: 3, tokens: 123 }
    const next = recordSessionCost(state, 'b', 's2', cost)
    expect(sessionCostOf(next, 's2')).toEqual(cost)
    expect(sessionCostOf(next, 's1')).toBeUndefined()
    expect(sessionCostOf(next, 'missing')).toBeUndefined()
    expect(JSON.stringify(state)).toBe(before)
    expect(recordSessionCost(state, 'b', 'missing', cost)).toBe(state)
    expect(recordSessionCost(state, 'missing', 's2', cost)).toBe(state)
  })
})


it('新增對話只將 worktreePath 寫進指定分頁且不改原狀態', () => {
  const before = JSON.stringify(two)
  const next = openConversationTab(two, 'a', {
    tabId: 'wt-tab', threadId: 'wt-thread', provider: 'codex', worktreePath: '/p/.worktrees/task',
  }, 300)
  expect(findProject(next, 'a')?.tabs.at(-1)).toMatchObject({ worktreePath: '/p/.worktrees/task' })
  expect(findProject(next, 'a')?.tabs[0]?.worktreePath).toBeUndefined()
  expect(findProject(next, 'b')).toBe(findProject(two, 'b'))
  expect(JSON.stringify(two)).toBe(before)
})

function convTab(id: string, sortOrder: number, extra: Partial<TabEntry> = {}): TabEntry {
  return { id, contentType: 'conversation', label: id, customLabel: null, sortOrder, lastFocusedAt: 0, threadId: `t-${id}`, ...extra }
}
function entry(tabs: readonly TabEntry[], lastUrl: string | null): ProjectEntry {
  return { id: 'p1', rootPath: '/p1', name: 'p1', addedAt: 0, lastOpenedAt: 0, tabs, lastUrl, threads: [] }
}
function stateOf(p: ProjectEntry): ProjectsState {
  return { schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [p], activeId: p.id, openIdsOnShutdown: [] }
}

describe('每個對話的 lastUrl', () => {
  it('setTabLastUrl 只改那個分頁,回傳新狀態,不動原本的', () => {
    const before = stateOf(entry([convTab('a', 0), convTab('b', 1)], null))
    const after = setTabLastUrl(before, 'b', 'https://b.test/')
    expect(after.projects[0]?.tabs.map((t) => t.lastUrl)).toEqual([undefined, 'https://b.test/'])
    expect(before.projects[0]?.tabs[1]?.lastUrl).toBeUndefined()
  })

  it('值沒變就回傳同一個物件,不觸發多餘的存檔', () => {
    const before = stateOf(entry([convTab('a', 0, { lastUrl: 'https://a.test/' })], null))
    expect(setTabLastUrl(before, 'a', 'https://a.test/')).toBe(before)
  })

  it('找不到分頁就原樣回傳', () => {
    const before = stateOf(entry([convTab('a', 0)], null))
    expect(setTabLastUrl(before, 'zzz', 'https://a.test/')).toBe(before)
  })

  it('tabLastUrl:自己有值用自己的', () => {
    const p = entry([convTab('a', 0, { lastUrl: 'https://a.test/' })], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBe('https://a.test/')
  })

  it('tabLastUrl:沒有自己的值時,只有 sortOrder 最小的對話分頁繼承專案層級的值', () => {
    const p = entry([convTab('b', 5), convTab('a', 2)], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBe('https://old.test/')
    expect(tabLastUrl(p, 'b')).toBeNull()
  })

  it('tabLastUrl:終端分頁不算,不會搶走繼承', () => {
    const term: TabEntry = { id: 't', contentType: 'terminal', label: 't', customLabel: null, sortOrder: 0, lastFocusedAt: 0 }
    const p = entry([term, convTab('a', 1)], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBe('https://old.test/')
  })

  it('tabLastUrl:自己的值是 null 就是 null,不往上繼承', () => {
    const p = entry([convTab('a', 0, { lastUrl: null })], 'https://old.test/')
    expect(tabLastUrl(p, 'a')).toBeNull()
  })
})

describe('removedProjectIds', () => {
  it('prev 有、next 沒有的專案 id;順序照 prev', () => {
    const a = { ...entry([convTab('a', 0)], null), id: 'pa' }
    const b = { ...entry([convTab('b', 0)], null), id: 'pb' }
    const prev: ProjectsState = { ...stateOf(a), projects: [a, b] }
    const next: ProjectsState = { ...stateOf(b), projects: [b] }
    expect(removedProjectIds(prev, next)).toEqual(['pa'])
    expect(removedProjectIds(next, prev)).toEqual([])
    expect(removedProjectIds(prev, prev)).toEqual([])
  })
})
