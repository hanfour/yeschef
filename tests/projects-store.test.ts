import { describe, it, expect } from 'vitest'
import { createProjectsStore, backupPaths, type StoreFs } from '../src/main/projects-store.js'
import { parseProjectsState, readSchemaVersion } from '../src/main/projects-schema.js'
import { EMPTY_PROJECTS_STATE, PROJECTS_SCHEMA_VERSION, type ProjectsState } from '../src/shared/projects.js'

const FILE = '/data/yeschef-projects.json'
const [BAK0, BAK1] = backupPaths(FILE)

const STATE: ProjectsState = {
  schemaVersion: 2,
  activeId: 'p1',
  openIdsOnShutdown: ['p1'],
  projects: [{
    id: 'p1', rootPath: '/Users/x/demo', name: 'demo', addedAt: 1, lastOpenedAt: 2, lastUrl: null,
    tabs: [{ id: 't1', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1', provider: 'claude' }],
    threads: [{ id: 'th1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 1 }],
  }],
}

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const ops: string[] = []
  const fs: StoreFs = {
    async readFile(p) {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    async writeFile(p, data) { ops.push(`write ${p}`); files.set(p, data) },
    async rename(from, to) {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from); files.set(to, v); ops.push(`rename ${from} -> ${to}`)
    },
    async exists(p) { return files.has(p) },
  }
  return { fs, files, ops }
}

function setup(initial?: Record<string, string>) {
  const m = memFs(initial)
  const errors: string[] = []
  const store = createProjectsStore({ filePath: FILE, fs: m.fs, logError: (e) => errors.push(e.message) })
  return { ...m, errors, store }
}

describe('parseProjectsState', () => {
  it('完整狀態通過並原樣回傳', () => {
    expect(parseProjectsState(STATE)).toEqual(STATE)
  })
  it('schemaVersion 不是 2 就拒絕', () => {
    expect(parseProjectsState({ ...STATE, schemaVersion: 1 })).toBeNull()
    expect(parseProjectsState({ ...STATE, schemaVersion: 3 })).toBeNull()
  })
  it('專案沒有對話分頁拒絕;有兩個可以', () => {
    const none = { ...STATE, projects: [{ ...STATE.projects[0], tabs: [] }] }
    expect(parseProjectsState(none)).toBeNull()
    const second = { ...STATE.projects[0]!.tabs[0]!, id: 't2', sortOrder: 1, threadId: 'th1' }
    const two = { ...STATE, projects: [{ ...STATE.projects[0], tabs: [...STATE.projects[0]!.tabs, second] }] }
    expect(parseProjectsState(two)).not.toBeNull()
  })
  it('只有群組分頁仍因沒有對話分頁而拒絕', () => {
    const groupOnly = {
      ...STATE,
      projects: [{
        ...STATE.projects[0]!,
        tabs: [{ id: 'g1', contentType: 'group', label: '群組', customLabel: null, sortOrder: 1, lastFocusedAt: 2 }],
      }],
    }
    expect(parseProjectsState(groupOnly)).toBeNull()
  })
  it('readSchemaVersion 只讀版本欄位', () => {
    expect(readSchemaVersion({ schemaVersion: 7 })).toBe(7)
    expect(readSchemaVersion({})).toBeUndefined()
    expect(readSchemaVersion('x')).toBeUndefined()
  })
})

describe('load', () => {
  it('群組分頁存檔後可以讀回', async () => {
    const withGroup: ProjectsState = {
      ...STATE,
      projects: STATE.projects.map((project) => ({
        ...project,
        tabs: [...project.tabs, { id: 'g1', contentType: 'group', label: '群組', customLabel: null, sortOrder: 1, lastFocusedAt: 2 }],
      })),
    }
    const t = setup()
    await t.store.save(withGroup)
    const loaded = await t.store.load()
    expect(loaded.projects[0]?.tabs).toEqual(withGroup.projects[0]?.tabs)
  })

  it('主檔是版本 1:轉換成版本 2 回傳,並立刻寫回主檔', async () => {
    const v1 = JSON.stringify({
      ...STATE,
      schemaVersion: 1,
      projects: [{ ...STATE.projects[0], tabs: [{ ...STATE.projects[0]!.tabs[0], provider: undefined }] }],
    })
    const { store, files, errors } = setup({ [FILE]: v1 })
    const loaded = await store.load()
    expect(loaded.schemaVersion).toBe(2)
    expect(loaded.projects[0]?.tabs[0]?.provider).toBe('claude')
    expect(errors).toEqual([])
    expect(JSON.parse(files.get(FILE) ?? '{}')).toMatchObject({ schemaVersion: 2 })
    expect(files.has(BAK0)).toBe(true)
  })

  it('主檔損毀、.bak.0 是版本 1:退到備份並轉換成版本 2,寫回主檔', async () => {
    const v1 = JSON.stringify({
      ...STATE,
      schemaVersion: 1,
      projects: [{ ...STATE.projects[0], tabs: [{ ...STATE.projects[0]!.tabs[0], provider: undefined }] }],
    })
    const { store, files, errors } = setup({ [FILE]: '{not json', [BAK0]: v1 })
    const loaded = await store.load()
    expect(loaded.schemaVersion).toBe(2)
    expect(loaded.projects[0]?.tabs[0]?.provider).toBe('claude')
    expect(errors.length).toBe(1)
    expect(JSON.parse(files.get(FILE) ?? '{}')).toMatchObject({ schemaVersion: 2 })
  })

  it('版本 1 轉換後寫回失敗:記錯誤,仍回傳轉換後的版本 2 狀態', async () => {
    const v1 = JSON.stringify({
      ...STATE,
      schemaVersion: 1,
      projects: [{ ...STATE.projects[0], tabs: [{ ...STATE.projects[0]!.tabs[0], provider: undefined }] }],
    })
    const m = memFs({ [FILE]: v1 })
    const errors: string[] = []
    const failing: StoreFs = { ...m.fs, writeFile: async () => { throw new Error('磁碟滿了') } }
    const store = createProjectsStore({ filePath: FILE, fs: failing, logError: (e) => errors.push(e.message) })
    const loaded = await store.load()
    expect(loaded.schemaVersion).toBe(2)
    expect(loaded.projects[0]?.tabs[0]?.provider).toBe('claude')
    expect(errors).toEqual(['寫回版本 2 的狀態檔失敗:磁碟滿了'])
    expect(m.files.get(FILE)).toBe(v1)
  })

  it('主檔 schemaVersion 3(未來版本):改名保留,回空狀態', async () => {
    const { store, files, errors } = setup({ [FILE]: JSON.stringify({ ...STATE, schemaVersion: 3 }) })
    expect(await store.load()).toEqual(EMPTY_PROJECTS_STATE)
    expect(files.has(`${FILE}.schema-3`)).toBe(true)
    expect(errors.length).toBe(1)
  })
  it('檔案不存在回空狀態,不記錯', async () => {
    const t = setup()
    expect(await t.store.load()).toEqual(EMPTY_PROJECTS_STATE)
    expect(t.errors).toEqual([])
  })
  it('正常檔案照讀', async () => {
    const t = setup({ [FILE]: JSON.stringify(STATE) })
    expect(await t.store.load()).toEqual(STATE)
  })
  it('主檔損毀退到 .bak.0,記一筆錯', async () => {
    const t = setup({ [FILE]: '{not json', [BAK0]: JSON.stringify(STATE) })
    expect(await t.store.load()).toEqual(STATE)
    expect(t.errors).toHaveLength(1)
    expect(t.errors[0]).toContain(FILE)
  })
  it('主檔與 .bak.0 都壞退到 .bak.1', async () => {
    const t = setup({ [FILE]: '{', [BAK0]: '[]', [BAK1]: JSON.stringify(STATE) })
    expect(await t.store.load()).toEqual(STATE)
    expect(t.errors).toHaveLength(2)
  })
  it('三份都壞回空狀態且不刪任何檔', async () => {
    const t = setup({ [FILE]: '{', [BAK0]: '{', [BAK1]: '{' })
    expect(await t.store.load()).toEqual(EMPTY_PROJECTS_STATE)
    expect([...t.files.keys()].sort()).toEqual([FILE, BAK0, BAK1].sort())
  })
  it('主檔 schemaVersion 不認得:改名保留,回空狀態', async () => {
    const t = setup({ [FILE]: JSON.stringify({ ...STATE, schemaVersion: 3 }) })
    expect(await t.store.load()).toEqual(EMPTY_PROJECTS_STATE)
    expect(t.files.has(FILE)).toBe(false)
    expect(t.files.has(`${FILE}.schema-3`)).toBe(true)
    expect(t.errors[0]).toContain('schemaVersion 3')
  })
  // 唯讀的 userData 或權限不足時 rename 會失敗。這一步以前沒有守衛,錯誤一路往上
  // 傳到 createWindow() 就是 process.exit(1):狀態檔的問題不該讓 app 起不來。
  it('主檔 schemaVersion 不認得而改名失敗:記錯誤、原檔不動,仍回空狀態', async () => {
    const raw = JSON.stringify({ ...STATE, schemaVersion: 3 })
    const t = setup({ [FILE]: raw })
    const broken: StoreFs = {
      ...t.fs,
      rename: async (from, to) => {
        if (to.includes('.schema-')) throw new Error('EROFS')
        return t.fs.rename(from, to)
      },
    }
    const errors: string[] = []
    const store = createProjectsStore({ filePath: FILE, fs: broken, logError: (e) => errors.push(e.message) })

    expect(await store.load()).toEqual(EMPTY_PROJECTS_STATE)
    expect(t.files.get(FILE)).toBe(raw)
    expect(t.files.has(`${FILE}.schema-3`)).toBe(false)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('EROFS')
    expect(errors[0]).toContain('schemaVersion 3')
  })
})

describe('save', () => {
  it('第一次存:寫 .tmp 再 rename 成主檔,沒有備份', async () => {
    const t = setup()
    await t.store.save(STATE)
    expect(t.ops).toEqual([`write ${FILE}.tmp`, `rename ${FILE}.tmp -> ${FILE}`])
    expect(JSON.parse(t.files.get(FILE)!)).toEqual(STATE)
  })
  it('第二次存:主檔輪成 .bak.0', async () => {
    const t = setup()
    await t.store.save(STATE)
    await t.store.save({ ...STATE, activeId: null })
    expect(JSON.parse(t.files.get(BAK0)!)).toEqual(STATE)
    expect(JSON.parse(t.files.get(FILE)!).activeId).toBeNull()
    expect(t.files.has(BAK1)).toBe(false)
  })
  it('第三次存:.bak.0 輪成 .bak.1,只留兩份備份', async () => {
    const t = setup()
    await t.store.save(STATE)
    await t.store.save({ ...STATE, activeId: null })
    await t.store.save({ ...STATE, activeId: 'p1', openIdsOnShutdown: [] })
    expect(JSON.parse(t.files.get(BAK1)!)).toEqual(STATE)
    expect(JSON.parse(t.files.get(BAK0)!).activeId).toBeNull()
    expect([...t.files.keys()].sort()).toEqual([FILE, BAK0, BAK1].sort())
  })
  it('同時呼叫兩次 save 依序執行,不交錯', async () => {
    const t = setup()
    await Promise.all([t.store.save(STATE), t.store.save({ ...STATE, activeId: null })])
    expect(JSON.parse(t.files.get(FILE)!).activeId).toBeNull()
    expect(JSON.parse(t.files.get(BAK0)!).activeId).toBe('p1')
  })
  it('寫 .tmp 失敗時主檔與備份都不動,錯誤往外拋', async () => {
    const t = setup({ [FILE]: JSON.stringify(STATE) })
    const broken: StoreFs = { ...t.fs, writeFile: async () => { throw new Error('EACCES') } }
    const store = createProjectsStore({ filePath: FILE, fs: broken, logError: () => undefined })
    await expect(store.save({ ...STATE, activeId: null })).rejects.toThrow('EACCES')
    expect(JSON.parse(t.files.get(FILE)!)).toEqual(STATE)
    expect(t.files.has(BAK0)).toBe(false)
  })
})


it.each([undefined, { usd: 0, turns: 3, tokens: 4200 }])('session cost 選填且存讀不遺失 %j', async (cost) => {
  const state: ProjectsState = {
    ...STATE,
    projects: STATE.projects.map((p) => ({ ...p, threads: p.threads.map((t) => ({ ...t, sessions: [{
      linkId: 's1', provider: 'claude', sessionId: 's1', transcriptPath: null,
      parentLinkId: null, startedAt: 1, endedAt: null, endReason: null, models: [],
      ...(cost === undefined ? {} : { cost }),
    }] })) })),
  }
  const { store } = setup()
  await store.save(state)
  expect(await store.load()).toEqual(state)
})


it.each([undefined, '/p/.worktrees/task'])('worktreePath 舊檔相容與存讀保留 %j', async (worktreePath) => {
  const state: ProjectsState = {
    ...STATE,
    projects: STATE.projects.map((p) => ({ ...p, tabs: p.tabs.map((t) => ({
      ...t, ...(worktreePath === undefined ? {} : { worktreePath }),
    })) })),
  }
  const { store, errors } = setup({ [FILE]: JSON.stringify(state) })
  expect(await store.load()).toEqual(state)
  await store.save(state)
  expect(await store.load()).toEqual(state)
  expect(errors).toEqual([])
})


it('沒有 lastUrl 欄位的舊分頁照常讀得進來,有的也保留', () => {
  const oldTab = { id: 'a', contentType: 'conversation', label: 'a', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 't1' }
  const newTab = { ...oldTab, id: 'b', threadId: 't2', lastUrl: 'https://b.test/' }
  const raw = {
    schemaVersion: PROJECTS_SCHEMA_VERSION,
    projects: [{ id: 'p', rootPath: '/p', name: 'p', addedAt: 0, lastOpenedAt: 0, tabs: [oldTab, newTab], lastUrl: null,
      threads: [{ id: 't1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }, { id: 't2', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }] }],
    activeId: 'p', openIdsOnShutdown: [],
  }
  const parsed = parseProjectsState(raw)
  expect(parsed?.projects[0]?.tabs.map((t) => t.lastUrl)).toEqual([undefined, 'https://b.test/'])
})

it('狀態檔的 isGitRepo 選填，保留 true/false 並拒絕錯誤型別', () => {
  for (const isGitRepo of [true, false]) {
    const state = { ...STATE, projects: STATE.projects.map((p) => ({ ...p, isGitRepo })) }
    expect(parseProjectsState(state)).toEqual(state)
  }
  expect(parseProjectsState(STATE)).toEqual(STATE)
  expect(parseProjectsState({ ...STATE, projects: STATE.projects.map((p) => ({ ...p, isGitRepo: 'true' })) })).toBeNull()
})
