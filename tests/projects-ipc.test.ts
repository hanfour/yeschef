import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../src/shared/ipc.js'
import { EMPTY_PROJECTS_STATE, type AddProjectResult, type ProjectsState } from '../src/shared/projects.js'
import { activeTabId, addProject, createProjectEntry, findProject, openGroupTab } from '../src/main/projects-state.js'
import { createProjectsService } from '../src/main/projects-service.js'
import type { WorktreeDeps } from '../src/main/worktree.js'
import { initializeGitRepoState, registerProjectsIpc, type ProjectsIpcDeps } from '../src/main/projects-ipc.js'
import { createMergeLocks } from '../src/main/merge-locks.js'
import { MSG } from '../src/main/merge.js'

type Handler = (event: unknown, payload?: unknown) => unknown
const listeners = new Map<string, Handler>()
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: Handler) => { listeners.set(channel, fn) },
    removeListener: (channel: string) => { listeners.delete(channel) },
    handle: (channel: string, fn: Handler) => { handlers.set(channel, fn) },
    removeHandler: (channel: string) => { handlers.delete(channel) },
  },
}))

const A = 'proj-a'

function oneProject(): ProjectsState {
  const a = createProjectEntry({ id: A, rootPath: '/p/alpha', conversationTabId: 'tab-a', threadId: 'th-a', now: 1 })
  return openGroupTab(addProject(EMPTY_PROJECTS_STATE, a), A, 'group-a', 1)
}

function conversationTabIds(project: ReturnType<typeof findProject>): readonly string[] {
  return project?.tabs.filter((tab) => tab.contentType !== 'group').map((tab) => tab.id) ?? []
}

function makeRig(initial: ProjectsState, picks: readonly (string | undefined)[] = [], extra: Partial<ProjectsIpcDeps> = {}) {
  listeners.clear()
  handlers.clear()
  const errors: string[] = []
  const queue = [...picks]
  let ids = 0
  let clock = 100
  const service = createProjectsService({
    store: { load: async () => initial, save: async () => {} },
    initial,
    now: () => (clock += 1),
    newId: () => `id-${(ids += 1)}`,
    isDir: () => true,
    logError: (e) => { errors.push(e.message) },
  })
  const unregister = registerProjectsIpc({
    service,
    disposeConversation: async () => {},
    worktree: { run: async () => ({ ok: true, out: '' }), readFile: async () => undefined, writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: (e) => { errors.push(e.message) } },
    locks: createMergeLocks(),
    pickFolder: async () => queue.shift(),
    validateRoot: (rootPath) => (rootPath.includes('bad') ? `不能用 ${rootPath}` : undefined),
    logError: (e) => { errors.push(e.message) },
    ...extra,
  })
  const fire = (channel: string, payload?: unknown): unknown => {
    const fn = listeners.get(channel)
    if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
    return fn({}, payload)
  }
  const invoke = async (channel: string, payload?: unknown): Promise<AddProjectResult> => {
    const fn = handlers.get(channel)
    if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
    return (await fn({}, payload)) as AddProjectResult
  }
  return { service, errors, unregister, fire, invoke }
}

beforeEach(() => { listeners.clear(); handlers.clear() })

describe('projects:add', () => {
  it('選到資料夾:加入、成為 active、一個對話與群組分頁、一條 thread', async () => {
    const rig = makeRig(EMPTY_PROJECTS_STATE, ['/p/new'])
    expect(await rig.invoke(IPC.projectsAdd)).toEqual({ kind: 'added', id: 'id-1' })
    const s = rig.service.state()
    expect(s.activeId).toBe('id-1')
    const entry = findProject(s, 'id-1')
    expect(entry?.rootPath).toBe('/p/new')
    expect(entry?.name).toBe('new')
    expect(entry?.tabs.map((t) => [t.contentType, t.id, t.threadId])).toEqual([
      ['conversation', 'id-2', 'id-3'], ['group', 'id-4', undefined],
    ])
    expect(entry?.threads.map((t) => t.id)).toEqual(['id-3'])
  })

  it('取消:回 cancelled,state 不變', async () => {
    const rig = makeRig(oneProject(), [undefined])
    const before = rig.service.state()
    expect(await rig.invoke(IPC.projectsAdd)).toEqual({ kind: 'cancelled' })
    expect(rig.service.state()).toBe(before)
  })

  it('驗證不過:回 rejected 帶原因,state 不變', async () => {
    const rig = makeRig(oneProject(), ['/p/bad'])
    const before = rig.service.state()
    expect(await rig.invoke(IPC.projectsAdd)).toEqual({ kind: 'rejected', message: '不能用 /p/bad' })
    expect(rig.service.state()).toBe(before)
  })

  it('同一個資料夾已是專案:只切到它,不重複加', async () => {
    const rig = makeRig(oneProject(), ['/p/other', '/p/alpha'])
    await rig.invoke(IPC.projectsAdd)
    expect(rig.service.state().activeId).toBe('id-1')
    expect(await rig.invoke(IPC.projectsAdd)).toEqual({ kind: 'added', id: A })
    expect(rig.service.state().projects).toHaveLength(2)
    expect(rig.service.state().activeId).toBe(A)
  })

  it('選擇器丟例外:記錯誤並回 rejected', async () => {
    const rig = makeRig(oneProject(), [], { pickFolder: async () => { throw new Error('對話框開不起來') } })
    expect(await rig.invoke(IPC.projectsAdd)).toEqual({ kind: 'rejected', message: 'projects:add：對話框開不起來' })
    expect(rig.errors).toEqual(['projects:add：對話框開不起來'])
  })
})

describe('projects:relocate', () => {
  it('未知 id 回 rejected,不開選擇器', async () => {
    const rig = makeRig(oneProject(), ['/p/never'])
    expect(await rig.invoke(IPC.projectsRelocate, { id: 'zzz' })).toEqual({ kind: 'rejected', message: '找不到專案 zzz' })
    expect(rig.service.state()).toEqual(oneProject())
  })

  it('成功:換 rootPath 與 name,分頁與 thread 保留', async () => {
    const rig = makeRig(oneProject(), ['/p/moved'])
    expect(await rig.invoke(IPC.projectsRelocate, { id: A })).toEqual({ kind: 'added', id: A })
    const entry = findProject(rig.service.state(), A)
    expect(entry?.rootPath).toBe('/p/moved')
    expect(entry?.name).toBe('moved')
    expect(conversationTabIds(entry)).toEqual(['tab-a'])
    expect(entry?.threads.map((t) => t.id)).toEqual(['th-a'])
  })

  it('取消與驗證不過都不動 state', async () => {
    const rig = makeRig(oneProject(), [undefined, '/p/bad'])
    expect(await rig.invoke(IPC.projectsRelocate, { id: A })).toEqual({ kind: 'cancelled' })
    expect(await rig.invoke(IPC.projectsRelocate, { id: A })).toEqual({ kind: 'rejected', message: '不能用 /p/bad' })
    expect(findProject(rig.service.state(), A)?.rootPath).toBe('/p/alpha')
  })

  it('payload 形狀不符:回 rejected 並記錯誤', async () => {
    const rig = makeRig(oneProject())
    expect(await rig.invoke(IPC.projectsRelocate, 7)).toEqual({ kind: 'rejected', message: 'payload 形狀不符' })
    expect(rig.errors).toEqual(['projects:relocate：payload 形狀不符（number），已丟棄'])
  })
})

describe('remove、activate 與分頁', () => {
  it('remove 與 activate', () => {
    const b = createProjectEntry({ id: 'proj-b', rootPath: '/p/beta', conversationTabId: 'tab-b', threadId: 'th-b', now: 1 })
    const rig = makeRig(addProject(oneProject(), b))
    rig.fire(IPC.projectsActivate, { id: 'proj-b' })
    expect(rig.service.state().activeId).toBe('proj-b')
    rig.fire(IPC.projectsRemove, { id: 'proj-b' })
    expect(rig.service.state().projects.map((p) => p.id)).toEqual([A])
    expect(rig.service.state().activeId).toBe(A)
  })

  it('tabs:open 開終端分頁並成為 active;tabs:activate 切回對話;tabs:close 關掉', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.tabsOpen, { projectId: A, label: 'zsh' })
    rig.fire(IPC.tabsOpen, { projectId: A, label: 'codex', command: 'codex' })
    const entry = (): NonNullable<ReturnType<typeof findProject>> => findProject(rig.service.state(), A)!
    expect(entry().tabs.filter((t) => t.contentType !== 'group').map((t) => [t.id, t.label, t.command])).toEqual([
      ['tab-a', 'Claude 對話', undefined],
      ['id-1', 'zsh', undefined],
      ['id-2', 'codex', 'codex'],
    ])
    expect(activeTabId(entry())).toBe('id-2')
    rig.fire(IPC.tabsActivate, { projectId: A, tabId: 'tab-a' })
    expect(activeTabId(entry())).toBe('tab-a')
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(conversationTabIds(entry())).toEqual(['tab-a', 'id-2'])
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'tab-a' })
    expect(conversationTabIds(entry())).toEqual(['tab-a', 'id-2'])
  })

  it('send 通道 payload 形狀不符:記錯誤,state 不變', () => {
    const rig = makeRig(oneProject())
    const before = rig.service.state()
    rig.fire(IPC.projectsRemove, { nope: 1 })
    rig.fire(IPC.tabsOpen, { projectId: A })
    rig.fire(IPC.tabsClose, 'x')
    expect(rig.errors).toEqual([
      'projects:remove：payload 形狀不符（object），已丟棄',
      'tabs:open：payload 形狀不符（object），已丟棄',
      'tabs:close：payload 形狀不符（string），已丟棄',
    ])
    expect(rig.service.state()).toBe(before)
  })

  it('分頁通道收到未知 projectId:記錯誤,state 不變', () => {
    const rig = makeRig(oneProject())
    const before = rig.service.state()
    rig.fire(IPC.tabsOpen, { projectId: 'zzz', label: 'zsh' })
    rig.fire(IPC.tabsClose, { projectId: 'zzz', tabId: 'tab-a' })
    rig.fire(IPC.tabsActivate, { projectId: 'zzz', tabId: 'tab-a' })
    expect(rig.errors).toEqual([
      'tabs:open：找不到專案 zzz',
      'tabs:close：找不到專案 zzz',
      'tabs:activate：找不到專案 zzz',
    ])
    expect(rig.service.state()).toBe(before)
  })

  it('unregister 拆掉全部 handler', () => {
    const rig = makeRig(oneProject())
    expect(listeners.size + handlers.size).toBe(9)
    rig.unregister()
    expect(listeners.size + handlers.size).toBe(0)
  })
})

describe('group:open', () => {
  it('開啟既有群組分頁只移動焦點,再送一次不會多開', () => {
    const rig = makeRig(oneProject())
    const before = findProject(rig.service.state(), A)!.tabs.find((tab) => tab.contentType === 'group')!
    rig.fire(IPC.groupOpen, { projectId: A })
    rig.fire(IPC.groupOpen, { projectId: A })
    const tabs = findProject(rig.service.state(), A)!.tabs
    expect(tabs.filter((t) => t.contentType === 'group')).toHaveLength(1)
    expect(tabs.find((tab) => tab.contentType === 'group')?.id).toBe(before.id)
    expect(activeTabId(findProject(rig.service.state(), A)!)).toBe(before.id)
  })

  it('payload 形狀不對或專案不存在都只記錯誤,不開分頁', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.groupOpen, A)
    rig.fire(IPC.groupOpen, { projectId: '不存在' })
    expect(rig.errors).toHaveLength(2)
    expect(findProject(rig.service.state(), A)!.tabs.filter((t) => t.contentType === 'group')).toHaveLength(1)
  })

  it('tabs:close 對群組分頁不改變主行程狀態', () => {
    const rig = makeRig(oneProject())
    const before = rig.service.state()
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'group-a' })
    expect(rig.service.state()).toBe(before)
  })
})

describe('終端分頁收掉時通知(tmux session 由主行程負責殺)', () => {
  it('關掉終端分頁 → 通知那個 tabId;關對話分頁不會', () => {
    const closed: string[] = []
    const rig = makeRig(oneProject(), [], { onTerminalTabClosed: (tabId) => closed.push(tabId) })
    rig.fire(IPC.tabsOpen, { projectId: A, label: 'zsh' })
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'tab-a' })
    expect(closed).toEqual(['id-1'])
  })

  it('移除專案 → 該專案每個終端分頁各通知一次,對話分頁不算', () => {
    const closed: string[] = []
    const rig = makeRig(oneProject(), [], { onTerminalTabClosed: (tabId) => closed.push(tabId) })
    rig.fire(IPC.tabsOpen, { projectId: A, label: 'zsh' })
    rig.fire(IPC.tabsOpen, { projectId: A, label: 'codex', command: 'codex' })
    rig.fire(IPC.projectsRemove, { id: A })
    expect(closed.sort()).toEqual(['id-1', 'id-2'])
  })

  it('沒給 onTerminalTabClosed 時關分頁照常運作', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.tabsOpen, { projectId: A, label: 'zsh' })
    expect(() => rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })).not.toThrow()
    expect(rig.errors).toEqual([])
  })
})

describe('conversations:open', () => {
  it('provider codex:分頁標籤是 codex 對話,provider 存進狀態檔', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'codex' })
    const entry = findProject(rig.service.state(), A)
    expect(entry?.tabs.at(-1)).toMatchObject({ label: 'codex 對話', provider: 'codex' })
  })

  it('缺 provider:記錯誤,state 不變', () => {
    const rig = makeRig(oneProject())
    const before = rig.service.state()
    rig.fire(IPC.conversationsOpen, { projectId: A })
    expect(rig.errors).toEqual(['conversations:open：payload 形狀不符（object），已丟棄'])
    expect(rig.service.state()).toBe(before)
  })

  it('在指定專案底下開一個新對話分頁,兩個 id 都由 newId 產生,成為 active 分頁', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude' })
    const entry = findProject(rig.service.state(), A)
    expect(conversationTabIds(entry)).toEqual(['tab-a', 'id-1'])
    expect(entry?.tabs.find((tab) => tab.id === 'id-1')).toMatchObject({ contentType: 'conversation', label: 'Claude 對話 2', threadId: 'id-2', provider: 'claude' })
    expect(entry?.threads.map((t) => t.id)).toEqual(['th-a', 'id-2'])
    expect(activeTabId(entry!)).toBe('id-1')
    expect(rig.errors).toEqual([])
  })

  it('未知 projectId:記錯誤,state 不變', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, { projectId: 'zzz', provider: 'claude' })
    expect(rig.errors).toEqual(['conversations:open：找不到專案 zzz'])
    expect(rig.service.state()).toEqual(oneProject())
  })

  it('payload 形狀不符:記錯誤', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, 'nope')
    expect(rig.errors).toEqual(['conversations:open：payload 形狀不符（string），已丟棄'])
  })

  it('tabs:close 可以關第二個對話分頁;關最後一個時 state 不變', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude' })
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(conversationTabIds(findProject(rig.service.state(), A))).toEqual(['tab-a'])
    const before = rig.service.state()
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'tab-a' })
    expect(rig.service.state()).toBe(before)
  })
})


describe('建立 worktree 後新增對話', () => {
  it.each([true, false])('git 建立結果 %j 都保留對話', async (ok) => {
    const run = vi.fn<WorktreeDeps['run']>(async () => ({ ok: true, out: '' }))
    run.mockImplementation(async (args) => ({ ok: args[0] === 'worktree' && args[1] === 'add' ? ok : true, out: ok ? '' : 'git failed' }))
    let errors: readonly string[] = []
    const logError = (error: Error): void => { errors = [...errors, error.message] }
    const rig = makeRig(oneProject(), [], { logError, worktree: {
      run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError,
    } })
    await rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'codex', worktreeName: '新功能' })
    const tab = findProject(rig.service.state(), A)?.tabs.at(-1)
    expect(tab).toMatchObject({ id: 'id-1', threadId: 'id-2', provider: 'codex' })
    expect(tab?.worktreePath).toBe(ok ? '/p/alpha/.worktrees/新功能' : undefined)
    expect(run).toHaveBeenCalledWith(['worktree', 'add', '/p/alpha/.worktrees/新功能', '-b', '新功能'], '/p/alpha')
    expect(errors).toEqual(ok ? [] : ['git failed'])
    expect(rig.service.error()).toBe(ok ? undefined : '建立 worktree 失敗：git failed；對話已在專案主目錄開啟。')
  })
  it('沒有名稱或未知專案時不執行 git', async () => {
    const run = vi.fn<WorktreeDeps['run']>()
    const rig = makeRig(oneProject(), [], { worktree: { run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {} } })
    await rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude' })
    await rig.fire(IPC.conversationsOpen, { projectId: 'missing', provider: 'claude', worktreeName: 'task' })
    expect(run).not.toHaveBeenCalled()
    expect(conversationTabIds(findProject(rig.service.state(), A))).toHaveLength(2)
    expect(rig.errors).toEqual(['conversations:open：找不到專案 missing'])
  })
})

it('等待 git 時不先新增分頁，完成後保留期間的狀態更新', async () => {
  let finish: () => void = () => { throw new Error('尚未初始化') }
  const pending = new Promise<{ readonly ok: boolean; readonly out: string }>((resolve) => {
    finish = () => resolve({ ok: true, out: '' })
  })
  const rig = makeRig(oneProject(), [], { worktree: {
    run: async (args) => args[0] === 'worktree' && args[1] === 'list' ? pending : { ok: true, out: '' },
    readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {},
  } })
  const opening = rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude', worktreeName: 'task' })
  expect(conversationTabIds(findProject(rig.service.state(), A))).toHaveLength(1)
  rig.fire(IPC.tabsOpen, { projectId: A, label: 'zsh' })
  finish()
  await opening
  expect(conversationTabIds(findProject(rig.service.state(), A))).toEqual(['tab-a', 'id-3', 'id-1'])
  expect(findProject(rig.service.state(), A)?.tabs.at(-1)?.worktreePath).toBe('/p/alpha/.worktrees/task')
})

it('對話狀態更新失敗時記錄錯誤，不留下未處理的 rejection', async () => {
  const rig = makeRig(oneProject())
  vi.spyOn(rig.service, 'update').mockImplementation(() => { throw new Error('update failed') })
  await rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude' })
  expect(rig.errors).toEqual(['conversations:open：update failed'])
})

it.each(['removed', 'dirty', 'failed', 'create-failed'] as const)(
  '等待建立期間移除專案：%s 不新增分頁並記錄善後結果', async (outcome) => {
    let finish: () => void = () => { throw new Error('尚未初始化') }
    let started: () => void = () => { throw new Error('尚未初始化') }
    const adding = new Promise<void>((resolve) => { started = resolve })
    const pending = new Promise<{ readonly ok: boolean; readonly out: string }>((resolve) => {
      finish = () => resolve(outcome === 'create-failed'
        ? { ok: false, out: 'create failed' } : { ok: true, out: '' })
    })
    let errors: readonly string[] = []
    const logError = (error: Error): void => { errors = [...errors, error.message] }
    const run = vi.fn<WorktreeDeps['run']>(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        started()
        return pending
      }
      if (args[2] === 'status') return { ok: true, out: outcome === 'dirty' ? '?? keep.txt' : '' }
      if (args[1] === 'remove' && outcome === 'failed') return { ok: false, out: 'remove failed' }
      return { ok: true, out: '' }
    })
    const rig = makeRig(oneProject(), [], { logError, worktree: {
      run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError,
    } })
    const opening = rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude', worktreeName: 'task' })
    await adding
    rig.fire(IPC.projectsRemove, { id: A })
    const removed = rig.service.state()
    finish()
    await opening
    expect(rig.service.state()).toBe(removed)
    expect(rig.service.state().projects).toEqual([])
    const disappeared = 'conversations:open：等待 git 期間專案 proj-a 已被移除'
    const leftover = 'conversations:open：專案已移除,殘留 worktree /p/alpha/.worktrees/task'
    expect(errors).toEqual(outcome === 'removed' ? [disappeared]
      : outcome === 'dirty' ? ['worktree 還有未提交的改動,留在 /p/alpha/.worktrees/task,請自己處理', leftover, disappeared]
      : outcome === 'failed' ? ['remove failed', leftover, disappeared]
      : ['create failed', disappeared])
    if (outcome === 'create-failed') {
      expect(run).not.toHaveBeenCalledWith(['-C', '/p/alpha/.worktrees/task', 'status', '--porcelain', '-uall', '--ignored'], '/p/alpha')
    } else {
      expect(run).toHaveBeenCalledWith(['-C', '/p/alpha/.worktrees/task', 'status', '--porcelain', '-uall', '--ignored'], '/p/alpha')
    }
    if (outcome === 'removed' || outcome === 'failed') {
      expect(run).toHaveBeenCalledWith(['worktree', 'remove', '/p/alpha/.worktrees/task'], '/p/alpha')
    } else {
      expect(run).not.toHaveBeenCalledWith(['worktree', 'remove', '/p/alpha/.worktrees/task'], '/p/alpha')
    }
  },
)


describe('關閉 worktree 對話', () => {
  it.each(['removed', 'dirty', 'failed'] as const)('%s：關分頁後檢查、只刪乾淨目錄並推送保留訊息', async (outcome) => {
    const path = '/p/alpha/.worktrees/task'
    const run = vi.fn<WorktreeDeps['run']>(async (args) => {
      if (args[2] === 'status') return { ok: true, out: outcome === 'dirty' ? '?? new.txt' : '' }
      if (args[2] === 'symbolic-ref') return { ok: true, out: '' }
      return { ok: outcome !== 'failed', out: 'remove failed' }
    })
    const rig = makeRig(oneProject(), [], { worktree: {
      run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {},
    } })
    await rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude' })
    rig.service.update((state) => ({ ...state, projects: state.projects.map((project) => ({
      ...project, tabs: project.tabs.map((tab) => tab.id === 'id-1' ? { ...tab, worktreePath: path } : tab),
    })) }))
    const messages: string[] = []
    rig.service.subscribe(() => { const message = rig.service.error(); if (message !== undefined) messages.push(message) })
    await rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(conversationTabIds(findProject(rig.service.state(), A))).toEqual(['tab-a'])
    expect(run).toHaveBeenCalledWith(['-C', path, 'status', '--porcelain', '-uall', '--ignored'], '/p/alpha')
    expect(run.mock.calls.filter(([args]) => args[1] === 'remove')).toHaveLength(outcome === 'dirty' ? 0 : 1)
    expect(messages).toEqual(outcome === 'dirty' ? [`worktree 還有未提交的改動,留在 ${path},請自己處理`]
      : outcome === 'failed' ? [`無法移除 worktree ${path}，已留在原地。原因：remove failed`] : [])
    await rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(run).toHaveBeenCalledTimes(outcome === 'dirty' ? 1 : 3)
  })

  // 審查追加:合併跑到一半把 worktree 刪掉,git 會停在半路。分頁留著,請使用者稍後再關。
  it.each([
    ['專案在 merge 中', A],
    ['這個分頁在 abort 中', `${A}/id-1`],
  ])('%s:關分頁被擋,worktree 留著,分頁也留著', async (_label, lockKey) => {
    const path = '/p/alpha/.worktrees/task'
    const run = vi.fn<WorktreeDeps['run']>(async () => ({ ok: true, out: '' }))
    const locks = createMergeLocks()
    const rig = makeRig(oneProject(), [], {
      locks,
      worktree: { run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {} },
    })
    await rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude' })
    rig.service.update((state) => ({ ...state, projects: state.projects.map((project) => ({
      ...project, tabs: project.tabs.map((tab) => tab.id === 'id-1' ? { ...tab, worktreePath: path } : tab),
    })) }))
    run.mockClear()
    expect(locks.acquire(lockKey)).toBe(true)

    await rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(rig.service.error()).toBe(MSG.closeWhileMerging)
    expect(conversationTabIds(findProject(rig.service.state(), A))).toEqual(['tab-a', 'id-1'])
    expect(run).not.toHaveBeenCalled()

    // 放開之後照舊關得掉。
    locks.release(lockKey)
    await rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(conversationTabIds(findProject(rig.service.state(), A))).toEqual(['tab-a'])
    expect(run.mock.calls.filter(([args]) => args[1] === 'remove')).toHaveLength(1)
  })

  // 審查追加:沒有 worktree 的分頁關閉根本不碰 git,合併中也不該被擋。
  it('合併中關沒有 worktree 的分頁照常關閉', async () => {
    const run = vi.fn<WorktreeDeps['run']>(async () => ({ ok: true, out: '' }))
    const locks = createMergeLocks()
    const closed: string[] = []
    const rig = makeRig(oneProject(), [], {
      locks,
      onTerminalTabClosed: (tabId) => { closed.push(tabId) },
      worktree: { run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {} },
    })
    rig.fire(IPC.tabsOpen, { projectId: A, label: 'zsh' })
    expect(locks.acquire(A)).toBe(true)

    await rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(conversationTabIds(findProject(rig.service.state(), A))).toEqual(['tab-a'])
    expect(rig.service.error()).toBeUndefined()
    expect(closed).toEqual(['id-1'])
    expect(run).not.toHaveBeenCalled()
  })

  it('別的分頁在 abort 中不擋這個分頁關閉', async () => {
    const run = vi.fn<WorktreeDeps['run']>(async () => ({ ok: true, out: '' }))
    const locks = createMergeLocks()
    const rig = makeRig(oneProject(), [], {
      locks,
      worktree: { run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {} },
    })
    await rig.fire(IPC.conversationsOpen, { projectId: A, provider: 'claude' })
    rig.service.update((state) => ({ ...state, projects: state.projects.map((project) => ({
      ...project, tabs: project.tabs.map((tab) => tab.id === 'id-1' ? { ...tab, worktreePath: '/p/alpha/.worktrees/task' } : tab),
    })) }))
    expect(locks.acquire(`${A}/另一個分頁`)).toBe(true)
    await rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(conversationTabIds(findProject(rig.service.state(), A))).toEqual(['tab-a'])
  })

  it('最後一個對話有 worktree 也不能移除', async () => {
    const run = vi.fn<WorktreeDeps['run']>()
    const initial = oneProject()
    const rig = makeRig({ ...initial, projects: initial.projects.map((project) => ({ ...project,
      tabs: project.tabs.map((tab) => ({ ...tab, worktreePath: '/keep' })),
    })) }, [], { worktree: { run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {} } })
    const before = rig.service.state()
    await rig.fire(IPC.tabsClose, { projectId: A, tabId: 'tab-a' })
    expect(rig.service.state()).toBe(before)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('專案 Git 判定快取', () => {
  it('加入、切換與重新定位各算一次，分頁更新不執行 git', async () => {
    const run = vi.fn<WorktreeDeps['run']>(async (_args, cwd) => ({ ok: cwd === '/git', out: '' }))
    const rig = makeRig(EMPTY_PROJECTS_STATE, ['/git', '/plain'], { worktree: {
      run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {},
    } })
    await rig.invoke(IPC.projectsAdd)
    expect(findProject(rig.service.state(), 'id-1')?.isGitRepo).toBe(true)
    await rig.fire(IPC.projectsActivate, { id: 'id-1' })
    rig.fire(IPC.tabsOpen, { projectId: 'id-1', label: 'zsh' })
    expect(run).toHaveBeenCalledTimes(2)
    await rig.invoke(IPC.projectsRelocate, { id: 'id-1' })
    expect(findProject(rig.service.state(), 'id-1')?.isGitRepo).toBe(false)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('舊資料啟動補一次，已有快取不重算', async () => {
    const rig = makeRig(oneProject())
    const run = vi.fn<WorktreeDeps['run']>(async () => ({ ok: true, out: '' }))
    const worktree: WorktreeDeps = { run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {} }
    await initializeGitRepoState(rig.service, worktree)
    expect(findProject(rig.service.state(), A)?.isGitRepo).toBe(true)
    const cached = rig.service.state()
    await initializeGitRepoState(rig.service, worktree)
    expect(run).toHaveBeenCalledTimes(1)
    expect(rig.service.state()).toBe(cached)
  })
})

it.each([
  [IPC.projectsAdd, undefined],
  [IPC.projectsRelocate, { id: A }],
  [IPC.conversationsOpen, { projectId: A, provider: 'claude' }],
  [IPC.tabsClose, { projectId: A, tabId: 'tab-a' }],
  [IPC.projectsActivate, { id: A }],
  [IPC.tabsActivate, { projectId: A, tabId: 'tab-a' }],
] as const)('下一次動作 %s 清掉舊錯誤（含無狀態變更）', async (channel, payload) => {
  const rig = makeRig(oneProject(), ['/p/new'])
  rig.service.reportError('舊錯誤')
  let observed: string | undefined = '尚未推播'
  rig.service.subscribe(() => { observed = rig.service.error() })
  if (channel === IPC.projectsAdd || channel === IPC.projectsRelocate) await rig.invoke(channel, payload)
  else await rig.fire(channel, payload)
  expect(rig.service.error()).toBeUndefined()
  expect(observed).toBeUndefined()
})

it('明確切換時更新已有的 Git 判定，反映後續 git init 或移除', async () => {
  const initial = oneProject()
  const run = vi.fn<WorktreeDeps['run']>().mockResolvedValueOnce({ ok: true, out: '' }).mockResolvedValueOnce({ ok: false, out: '' })
  const rig = makeRig({ ...initial, projects: initial.projects.map(project => ({ ...project, isGitRepo: false })) }, [], { worktree: {
    run, readFile: async () => undefined, writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {},
  } })
  await rig.fire(IPC.projectsActivate, { id: A })
  expect(findProject(rig.service.state(), A)?.isGitRepo).toBe(true)
  expect(run).toHaveBeenCalledTimes(1)
  expect(run).toHaveBeenLastCalledWith(['rev-parse', '--git-dir'], '/p/alpha')
  await rig.fire(IPC.projectsActivate, { id: A })
  expect(findProject(rig.service.state(), A)?.isGitRepo).toBe(false)
  expect(run).toHaveBeenCalledTimes(2)
})

it('切換檢查尚未完成就移除專案，不寫回過期結果', async () => {
  let release: (value: { ok: boolean; out: string }) => void = () => { throw new Error('尚未初始化') }
  const pending = new Promise<{ ok: boolean; out: string }>(resolve => { release = resolve })
  const rig = makeRig(oneProject(), [], { worktree: {
    run: async () => pending, readFile: async () => undefined, writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {},
  } })
  const activating = rig.fire(IPC.projectsActivate, { id: A })
  rig.fire(IPC.projectsRemove, { id: A })
  release({ ok: true, out: '' })
  await activating
  expect(rig.service.state().projects).toEqual([])
})
