import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContentsView } from 'electron'
import { createBrowserSessions, type BrowserSessionsDeps, type StartToolsArgs } from '../src/main/browser-sessions.js'
import { createViewSwitch } from '../src/main/view-switch.js'
import type { ViewToolStartup } from '../src/main/view-tools/startup.js'
import type { ViewTools } from '../src/main/view-tools/server.js'
import { MSG } from '../src/main/view-tools/errors.js'

type Handler = (...args: unknown[]) => void

let log: string[]

// fakeView/fakeTools 故意不收 log 當參數,直接引用上面這個可變的 `log`:
// 測試中途會重指 `log = []` 來只看之後發生的事,若把 log 收成參數,建立時就會
// 綁死當下那個陣列,中途重指之後這些物件推的東西就再也看不到了。
function fakeView(id: string) {
  const handlers = new Map<string, Handler[]>()
  let destroyed = false
  const webContents = {
    on: (event: string, h: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), h]) },
    getURL: () => `https://${id}.test/`,
    getTitle: () => `標題 ${id}`,
    isLoading: () => false,
    isDestroyed: () => destroyed,
    close: () => { log.push(`${id}:close`) },
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
  }
  const view = {
    webContents,
    setVisible: (v: boolean) => { log.push(`${id}:visible:${String(v)}`) },
    setBounds: () => { log.push(`${id}:bounds`) },
  }
  const emit = (event: string, ...args: unknown[]): void => { for (const h of handlers.get(event) ?? []) h(...args) }
  const setDestroyed = (v: boolean): void => { destroyed = v }
  return { view: view as unknown as WebContentsView, emit, setDestroyed }
}

function fakeTools(id: string): ViewTools {
  return {
    invoke: () => Promise.resolve({ ok: false as const, text: '' }),
    handoffDone: () => {}, abortPending: () => {}, busy: () => false,
    dispose: () => { log.push(`${id}:tools.dispose`); return Promise.resolve() },
  }
}

let views: Map<string, ReturnType<typeof fakeView>>
let startArgs: Map<string, StartToolsArgs>
let startResult: (id: string) => Promise<ViewToolStartup>
let states: unknown[]
let sessionPushes: unknown[]
let navigated: string[]
let currentBuild: string

function setup(overrides: Partial<BrowserSessionsDeps> = {}) {
  const deps: BrowserSessionsDeps = {
    createView: (id) => { currentBuild = id; const v = fakeView(id); views.set(id, v); return v.view },
    addChildView: () => { log.push(`${currentBuild}:add`) },
    removeChildView: () => { log.push('remove') },
    loadPage: (_view, url) => { log.push(`${currentBuild}:load:${url}`) },
    startTools: (args) => { startArgs.set(currentBuild, args); return startResult(currentBuild) },
    projectDirOf: (id) => (id === 'gone' ? undefined : `/專案/${id}`),
    switcher: createViewSwitch(),
    relayout: () => { log.push('relayout') },
    onState: (s) => { states.push(s) },
    onSessions: (s) => { sessionPushes.push(s) },
    onNavigated: (id, url) => { navigated.push(`${id}:${url}`) },
    logError: vi.fn(),
    credentialsOf: (id, machine) => Promise.resolve({ username: `u-${id}`, password: 'p', passwordUnreadable: false, origin: `https://${machine}.test` }),
    ...overrides,
  }
  return createBrowserSessions(deps)
}

beforeEach(() => {
  log = []; views = new Map(); startArgs = new Map(); states = []; sessionPushes = []; navigated = []; currentBuild = ''
  startResult = (id) => Promise.resolve({
    viewTools: fakeTools(id),
    dispose: () => { log.push(`${id}:startup.dispose`); return Promise.resolve() },
  })
})

describe('ensure', () => {
  it('建立的順序:藏起來、加進視窗、先載入空白頁、再附著工具', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    expect(log.slice(0, 3)).toEqual(['a:visible:false', 'a:add', 'a:load:about:blank'])
    expect(sessions.get('a')).toBeDefined()
  })

  it('同一個 id 同時 ensure 兩次只建一份', async () => {
    const sessions = setup()
    const [first, second] = await Promise.all([sessions.ensure('a'), sessions.ensure('a')])
    expect(first).toBe(second)
    expect(log.filter((l) => l === 'a:add')).toHaveLength(1)
  })

  it('工具啟動失敗:reject browserUnavailable,view 被收掉,表裡沒有殘留,下一次會重試', async () => {
    const sessions = setup()
    const ok = startResult
    startResult = () => Promise.resolve({ viewTools: undefined, dispose: () => Promise.resolve() })
    await expect(sessions.ensure('a')).rejects.toThrow(MSG.browserUnavailable)
    expect(log).toContain('remove')
    expect(log).toContain('a:close')
    expect(sessions.get('a')).toBeUndefined()
    startResult = ok
    await expect(sessions.ensure('a')).resolves.toBeDefined()
  })

  it('projectDir 每次重查;對話已不在任何專案裡時丟 sessionEnded', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    expect(startArgs.get('a')?.projectDir()).toBe('/專案/a')
    await sessions.ensure('gone')
    expect(() => startArgs.get('gone')?.projectDir()).toThrow(MSG.sessionEnded)
  })

  it('startTools 收到的 credentials 綁定這個對話的 id', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await expect(startArgs.get('a')?.credentials('staging')).resolves.toEqual({ username: 'u-a', password: 'p', passwordUnreadable: false, origin: 'https://staging.test' })
  })

  it('建好之後推一次 sessions 與該對話的狀態', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    expect(sessionPushes.at(-1)).toEqual([{ conversationId: 'a', busy: false }])
    expect(states.at(-1)).toEqual({ conversationId: 'a', url: 'https://a.test/', title: '標題 a', loading: false, canGoBack: true, canGoForward: false })
  })
})

describe('show', () => {
  it('先藏舊的,再 relayout 讓新的被套上矩形', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await sessions.ensure('b')
    sessions.show('a')
    log = []
    sessions.show('b')
    expect(log).toEqual(['a:visible:false', 'relayout'])
  })

  it('show 一個還沒有 session 的對話:全部藏起來;之後 ensure 完成就自動顯示', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessions.show('a')
    log = []
    sessions.show('b')
    expect(log).toEqual(['a:visible:false', 'relayout'])
    log = []
    await sessions.ensure('b')
    expect(log.at(-1)).toBe('relayout')
  })

  it('show(null) 全部藏起來', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessions.show('a')
    log = []
    sessions.show(null)
    expect(log).toEqual(['a:visible:false', 'relayout'])
  })
})

describe('事件', () => {
  it('did-navigate 記 lastUrl 並推狀態;子框架的 in-page 導航不記', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    states = []
    views.get('a')?.emit('did-navigate', {}, 'https://a.test/next')
    views.get('a')?.emit('did-navigate-in-page', {}, 'https://a.test/frame', false)
    views.get('a')?.emit('did-navigate-in-page', {}, 'https://a.test/#x', true)
    expect(navigated).toEqual(['a:https://a.test/next', 'a:https://a.test/#x'])
    expect(states).toHaveLength(2)
    void sessions
  })

  it('載入開始、結束與標題變更都推狀態', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    states = []
    for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) views.get('a')?.emit(event)
    expect(states).toHaveLength(3)
    void sessions
  })

  it('onBusyChange 觸發 sessions 重推', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessionPushes = []
    startArgs.get('a')?.onBusyChange(true)
    expect(sessionPushes).toHaveLength(1)
    void sessions
  })

  it('renderer 行程當掉就收掉那個 session', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    views.get('a')?.emit('render-process-gone')
    await vi.waitFor(() => { expect(sessions.get('a')).toBeUndefined() })
  })
})

describe('dispose', () => {
  it('正在顯示的先藏,再收工具、移出視窗、關 webContents', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    sessions.show('a')
    log = []
    await sessions.dispose('a')
    expect(log).toEqual(['a:visible:false', 'a:startup.dispose', 'remove', 'a:close'])
    expect(sessions.get('a')).toBeUndefined()
    expect(sessionPushes.at(-1)).toEqual([])
  })

  it('沒有 session 的 id 不做事', async () => {
    const sessions = setup()
    await expect(sessions.dispose('zzz')).resolves.toBeUndefined()
  })

  it('build 已寫入 entries、building 還沒清掉時被 dispose:照樣收乾淨', async () => {
    let reentered: Promise<void> | undefined
    const sessions = setup({
      onSessions: (list) => {
        sessionPushes.push(list)
        if (reentered === undefined && list.length === 1) reentered = sessions.dispose('a')
      },
    })
    await sessions.ensure('a')
    await reentered
    expect(sessions.get('a')).toBeUndefined()
    expect(log).toContain('a:startup.dispose')
    expect(log).toContain('remove')
    expect(log).toContain('a:close')
    expect(sessionPushes.at(-1)).toEqual([])
  })

  it('建立途中被 dispose:建完立刻收掉,ensure reject sessionEnded', async () => {
    let release: (s: ViewToolStartup) => void = () => {}
    startResult = () => new Promise((r) => { release = r })
    const sessions = setup()
    const pending = sessions.ensure('a')
    const disposing = sessions.dispose('a')
    release({ viewTools: fakeTools('a'), dispose: () => { log.push('a:startup.dispose'); return Promise.resolve() } })
    await expect(pending).rejects.toThrow(MSG.sessionEnded)
    await disposing
    expect(log).toContain('a:startup.dispose')
    expect(log).toContain('remove')
    expect(log).toContain('a:close')
    expect(sessions.get('a')).toBeUndefined()
  })

  it('disposeAll 收掉全部,之後的 ensure reject sessionEnded', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await sessions.ensure('b')
    await sessions.disposeAll()
    expect(sessions.snapshot()).toEqual({ states: [], sessions: [] })
    await expect(sessions.ensure('c')).rejects.toThrow(MSG.sessionEnded)
  })
})

describe('snapshot', () => {
  it('states 與 sessions 都濾掉 webContents 已銷毀的那份,兩份列表要一致', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await sessions.ensure('b')
    views.get('a')?.setDestroyed(true)
    const snap = sessions.snapshot()
    expect(snap.states.map((s) => s.conversationId)).toEqual(['b'])
    expect(snap.sessions.map((s) => s.conversationId)).toEqual(['b'])
  })

  it('存活的 session:兩份列表都帶得到,形狀符合各自的欄位', async () => {
    const sessions = setup()
    await sessions.ensure('a')
    await sessions.ensure('b')
    const snap = sessions.snapshot()
    expect(snap.states).toEqual([
      { conversationId: 'a', url: 'https://a.test/', title: '標題 a', loading: false, canGoBack: true, canGoForward: false },
      { conversationId: 'b', url: 'https://b.test/', title: '標題 b', loading: false, canGoBack: true, canGoForward: false },
    ])
    expect(snap.sessions).toEqual([
      { conversationId: 'a', busy: false },
      { conversationId: 'b', busy: false },
    ])
  })
})
