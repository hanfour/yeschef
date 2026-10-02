import { CONVERSATION_TOOLS_CHANNEL } from '../src/shared/conversation-tools.js'
import { registerProjectsIpc } from '../src/main/projects-ipc.js'
import { createMergeLocks } from '../src/main/merge-locks.js'
import type { WorktreeDeps } from '../src/main/worktree.js'
import { createPeerRegistry, type PeerEntry, type PeerRegistry } from '../src/main/peer/registry.js'
import type { PeerPending, PeerService, PeerTools } from '../src/main/peer/service.js'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { Event } from '../src/shared/events.js'
import { IPC, type SessionSummary } from '../src/shared/ipc.js'
import { EMPTY_PROJECTS_STATE, parseProjectsView, type ProjectsState, type ProjectsView } from '../src/shared/projects.js'
import {
  activeTabId, addProject, closeInactiveChefTabs, closeTab, conversationDir, conversationTabs, createProjectEntry, currentThread, focusTab, lastSessionId, openConversationTab, openGroupTab, openTab, findProject, recordSession, sessionCostOf, relocateProject, removeProject, setActive,
} from '../src/main/projects-state.js'
import { createProjectsService } from '../src/main/projects-service.js'
import type { Conversation, ConversationDeps } from '../src/main/conversation.js'
import type { CodexConversationDeps } from '../src/main/codex/conversation.js'
import type { GrokConversationDeps } from '../src/main/grok/conversation.js'
import { createSessionStore } from '../src/main/session-store.js'
import { checkNavigateUrl } from '../src/main/view-tools/urls.js'
import type { SessionOptions } from '../src/main/session-args.js'
import { createIpcBridge, type IpcBridgeDeps, type SessionSource } from '../src/main/ipc-bridge.js'

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
const B = 'proj-b'
const NOW = 1_000

/**
 * A 的 rootPath 用 realpath 形式(`/private/tmp/alpha`),因為主行程在路徑進入登錄表時
 * 就 realpath 過了(`index.ts` 的 `canonicalRoot`,I2)。SDK 記的 cwd 也是 realpath,
 * 所以 `s-1` 比得到、symlink 形式的 `s-3` 比不到。fixture 的 cwd 與 rootPath 若寫成
 * 同一串字,這條過濾規則對不對就測不出來。
 */
const SESSIONS: readonly SessionSummary[] = [
  { sessionId: 's-1', summary: '一', lastModified: 1, cwd: '/private/tmp/alpha' },
  { sessionId: 's-2', summary: '二', lastModified: 2, cwd: '/p/beta' },
  { sessionId: 's-3', summary: '三', lastModified: 3, cwd: '/tmp/alpha' },
  { sessionId: 's-9', summary: '九', lastModified: 9, cwd: '/p/other' },
]

function twoProjects(): ProjectsState {
  const a = createProjectEntry({ id: A, rootPath: '/private/tmp/alpha', conversationTabId: 'tab-a', threadId: 'th-a', now: NOW })
  const b = createProjectEntry({ id: B, rootPath: '/p/beta', conversationTabId: 'tab-b', threadId: 'th-b', now: NOW })
  return openGroupTab(openGroupTab(addProject(addProject(EMPTY_PROJECTS_STATE, a), b), A, 'group-a', NOW), B, 'group-b', NOW)
}

interface FakeCore {
  readonly core: Conversation
  readonly deps: ConversationDeps
  setHeld(n: number): void
  setBusy(n: boolean): void
}

/** `slowDispose`:模擬真的 `Conversation.dispose()`(effects 排進 pending 鏈再 await),用來驗證 runtime 有等它。 */
function makeFakeCore(
  tag: string,
  deps: ConversationDeps,
  record: (entry: string) => void,
  slowDispose: boolean,
): FakeCore {
  let busy = false
  let held = 0
  let active = false
  const core: Conversation = {
    userInput: vi.fn((text: string) => { record(`${tag}.userInput(${text})`) }),
    approvalReply: (requestId, decision) => { record(`${tag}.approvalReply(${requestId},${decision})`) },
    startNew: () => { record(`${tag}.startNew`) },
    openHistory: (sessionId) => { record(`${tag}.openHistory(${sessionId})`) },
    handoffDone: (toolUseId) => { record(`${tag}.handoffDone(${toolUseId})`) },
    activate: () => { active = true; record(`${tag}.activate`) },
    deactivate: () => { active = false; record(`${tag}.deactivate`) },
    replay: () => { record(`${tag}.replay`) },
    isActive: () => active,
    pendingApprovals: () => held,
    isBusy: () => busy,
    busyStartedAt: () => busy ? 123 : null,
    turnProduced: () => false,
    sessionState: () => ({ kind: 'idle' }),
    dispose: async () => {
      if (slowDispose) await Promise.resolve()
      record(`${tag}.dispose`)
    },
  }
  return { core, deps, setHeld: (n) => { held = n }, setBusy: (n) => { busy = n; deps.onBusyChange?.(n) } }
}

/** 讓已排入的 microtask 與 `.then` 鏈全部跑完。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

function makeRig(initial: ProjectsState = EMPTY_PROJECTS_STATE, extra: Partial<IpcBridgeDeps> = {}, slowDispose = false) {
  listeners.clear()
  handlers.clear()
  const log: string[] = []
  /** core 呼叫與送出的 channel 混在一起依序記,用來驗證「先推 projects:state 再切換」這種順序。 */
  const timeline: string[] = []
  const record = (entry: string): void => { log.push(entry); timeline.push(entry) }
  const errors: string[] = []
  const sent: string[] = []
  const messages: { channel: string; payload: unknown }[] = []
  const lastSent = new Map<string, unknown>()
  const aborts: string[] = []
  const invokes: string[] = []
  const browserLog: string[] = []
  const fakes = new Map<string, FakeCore>()
  /** 每次建 core 都記一筆(fakes 依 conversationId 覆寫,看不出重建)。 */
  const created: string[] = []
  const byOptions = new Map<ConversationDeps['sessionOptions'], string>()
  /** codex 的假 core 沒有 sessionOptions 可以認,改用 cwd 對到分頁 id。 */
  const codexTags = new Map<string, string>()
  const codexDeps = new Map<string, CodexConversationDeps>()
  /** grok 的假 core 一樣沒有 sessionOptions 可以認,改用 cwd 對到分頁 id。 */
  const grokTags = new Map<string, string>()
  const grokDeps = new Map<string, GrokConversationDeps>()
  /** 每次 runtimeFor 被呼叫都記一筆 [conversationId, provider],供斷言第四個參數。 */
  const runtimeProviders: [string, string][] = []
  let ids = 0
  const service = createProjectsService({
    store: { load: async () => initial, save: async () => {} },
    initial,
    now: () => NOW,
    newId: () => `id-${(ids += 1)}`,
    isDir: (path) => !path.endsWith('/gone'),
    logError: (e) => { errors.push(e.message) },
  })
  const sessions: SessionSource = {
    // store 的契約:帶 cwd 就只回那個目錄底下的。過濾在 store,不在 ipc-bridge。
    list: async (cwd?: string) =>
      cwd === undefined ? SESSIONS : SESSIONS.filter((s) => s.cwd === cwd),
    loadHistory: async (): Promise<readonly Event[]> => [],
    cwdOf: (sessionId) => SESSIONS.find((s) => s.sessionId === sessionId)?.cwd,
  }
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      messages.push({ channel, payload })
      sent.push(channel)
      timeline.push(channel)
      lastSent.set(channel, payload)
    },
  } as unknown as WebContents
  const bridge = createIpcBridge({
    webContents,
    projects: service,
    codexCatalog: { list: async () => [], items: async () => [] },
    grokCatalog: { models: async () => [], list: async () => [] },
    sessions,
    homeDir: '/home/u',
    logError: (e) => { errors.push(e.message) },
    runtimeFor: (projectId, rootPath, conversationId, provider) => {
      runtimeProviders.push([conversationId, provider])
      const sessionOptions = (resumeSessionId?: string): SessionOptions =>
        ({ projectId, rootPath, resumeSessionId }) as unknown as SessionOptions
      byOptions.set(sessionOptions, conversationId)
      return {
        sessionOptions,
        viewTools: {
          autoAllow: () => false,
          handoffDone: () => {},
          abortPending: (reason) => { aborts.push(`${conversationId}:${reason}`) },
        },
        codexViewTools: {
          invoke: async (name: string, _args: unknown, ctx: { callId: string | null }) => {
            invokes.push(`${conversationId}:${name}:${ctx.callId ?? '-'}`)
            return { ok: true, output: { kind: 'text', text: '好了' } }
          },
          handoffDone: (toolUseId: string) => { log.push(`${conversationId}.handoffDone(${toolUseId})`) },
        },
        grokViewTools: {
          mcpServers: async () => [{ name: 'yeschef', type: 'http' as const, url: `http://127.0.0.1:1/mcp`, headers: [{ name: 'Authorization', value: 'Bearer test' }] }],
          useApproval: () => { log.push(`${conversationId}.grokViewTools.useApproval`) },
          requestApproval: async () => 'deny' as const,
          handoffDone: (toolUseId: string) => { log.push(`${conversationId}.handoffDone(${toolUseId})`) },
          close: () => { log.push(`${conversationId}.grokHttp.close`); return Promise.resolve() },
        },
        dispose: () => { log.push(`${conversationId}.runtime.dispose`) },
      }
    },
    createConversation: (deps) => {
      const tag = byOptions.get(deps.sessionOptions) ?? 'unknown'
      const fake = makeFakeCore(tag, deps, record, slowDispose)
      fakes.set(tag, fake)
      created.push(tag)
      return fake.core
    },
    createCodexConversation: (d) => {
      const tag = codexTags.get(d.cwd) ?? 'codex-unknown'
      const fake = makeFakeCore(tag, { ...d, sessionOptions: () => ({}) } as unknown as ConversationDeps, record, slowDispose)
      fakes.set(tag, fake)
      created.push(tag)
      codexDeps.set(tag, d)
      return fake.core
    },
    createGrokConversation: (d) => {
      const tag = grokTags.get(d.cwd) ?? 'grok-unknown'
      const fake = makeFakeCore(tag, { ...d, sessionOptions: () => ({}) } as unknown as ConversationDeps, record, slowDispose)
      fakes.set(tag, fake)
      created.push(tag)
      grokDeps.set(tag, d)
      return fake.core
    },
    browser: {
      show: (id) => { browserLog.push(`show:${id ?? 'null'}`); timeline.push(`browser.show:${id ?? 'null'}`) },
      dispose: (id) => { browserLog.push(`dispose:${id}`); log.push(`${id}.browser.dispose`); return Promise.resolve() },
    },
    ...extra,
  })
  const fire = (channel: string, payload?: unknown): void => {
    const fn = listeners.get(channel)
    if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
    fn({}, payload)
  }
  const invokeFrom = async (channel: string, sender: unknown, payload?: unknown): Promise<unknown> => {
    const fn = handlers.get(channel)
    if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
    return fn({ sender }, payload)
  }
  const invoke = async (channel: string, payload?: unknown): Promise<unknown> => invokeFrom(channel, webContents, payload)
  const fake = (id: string): FakeCore => {
    const f = fakes.get(id)
    if (f === undefined) throw new Error(`對話 ${id} 還沒建 core`)
    return f
  }
  let focusTime = NOW
  const focus = (id: string): void => {
    focusTime += 1
    service.update((state) => {
      const owner = state.projects.find((p) => p.tabs.some((t) => t.id === id))!
      return focusTab(setActive(state, owner.id, focusTime), owner.id, id, focusTime)
    })
  }
  const appendSession = (id: string, linkId: string): void => {
    service.update((state) => {
      const owner = state.projects.find((p) => p.tabs.some((t) => t.id === id))!
      return recordSession(state, owner.id, currentThread(owner, id)!.id, {
        linkId, provider: 'claude', sessionId: linkId, transcriptPath: null,
        parentLinkId: null, startedAt: NOW, endedAt: null, endReason: null, models: [],
      })
    })
  }
  const closeConversation = (id: string): void => {
    service.update((state) => {
      const owner = state.projects.find((p) => p.tabs.some((t) => t.id === id))!
      return closeTab(state, owner.id, id, NOW)
    })
  }
  const coreFor = (id: string) => ({ ...fake(id).core, emitBusy: fake(id).setBusy })
  const view = (): ProjectsView => lastSent.get(IPC.projectsState) as ProjectsView
  return { emit: (channel: string, payload: unknown) => { listeners.get(channel)?.({}, payload) }, payloads: (channel: string) => messages.filter((m) => m.channel === channel).map((m) => m.payload), focus, appendSession, closeTab: closeConversation, coreFor, send: fire, bridge, service, log, timeline, errors, sent, lastSent, aborts, invokes, browserLog, fakes, created, fake, fire, invoke, invokeFrom, view, codexTags, codexDeps, grokTags, grokDeps, runtimeProviders }
}

beforeEach(() => { listeners.clear(); handlers.clear() })

function chefBridgeRig() {
  const rootPath = process.cwd()
  const project = createProjectEntry({ id: A, rootPath, conversationTabId: 'tab-a', threadId: 'thread-a', now: NOW })
  const initial = addProject(EMPTY_PROJECTS_STATE, project)
  let attemptStatus: 'running' | 'done' = 'running'
  const workerClosed = vi.fn()
  const chef = {
    runnable: (id: string) => id === 'worker' && attemptStatus === 'running',
    tasksOf: () => [{ id: 'task-a', projectId: A, attempts: [{ workerId: 'worker', status: attemptStatus }] }],
    worker: (id: string) => id === 'worker' ? { taskId: 'task-a', model: 'm', provider: 'claude', role: 'worker' } : undefined,
    workerClosed,
    taskContext: (id: string) => id === 'worker' ? { key: 'chef:task-a', cwd: rootPath } : undefined,
    guard: () => undefined,
    sources: () => [],
  } as unknown as IpcBridgeDeps['chef']
  const createConversation = (deps: ConversationDeps): Conversation => ({
    ...makeFakeCore('worker', deps, () => {}, false).core,
    shutdownConfirmed: () => true,
  })
  const rig = makeRig(initial, { chef, createConversation })
  return { rig, workerClosed, setAttemptStatus: (status: 'running' | 'done') => { attemptStatus = status }, rootPath }
}

it('停止確認後自動關閉背景主廚分頁,不呼叫 workerClosed 取消任務', async () => {
  const { rig, workerClosed, rootPath } = chefBridgeRig()
  const handle = await rig.bridge.startChefWorker({
    id: 'worker', taskId: 'task-a', projectId: A, cwd: rootPath, provider: 'claude', model: 'm',
    title: '實作', tabLabel: 'codex-1 · 實作', prompt: '開始', previousWorkerId: 'previous-worker',
  })

  expect(findProject(rig.service.state(), A)?.tabs.find((tab) => tab.id === 'worker')).toMatchObject({
    chefTaskId: 'task-a', label: 'codex-1 · 實作', customLabel: 'codex-1 · 實作',
  })
  expect(await handle.stop()).toBe(true)
  expect(findProject(rig.service.state(), A)?.tabs.some((tab) => tab.id === 'worker')).toBe(false)
  expect(workerClosed).not.toHaveBeenCalled()
  await rig.bridge.dispose()
})

it('停止時保留前景主廚分頁,使用者切走後下一次清理會關閉', async () => {
  const { rig, workerClosed, rootPath, setAttemptStatus } = chefBridgeRig()
  const handle = await rig.bridge.startChefWorker({
    id: 'worker', taskId: 'task-a', projectId: A, cwd: rootPath, provider: 'claude', model: 'm',
    title: '實作', tabLabel: '主廚 · 實作', prompt: '開始',
  })

  expect(await handle.stop()).toBe(true)
  expect(findProject(rig.service.state(), A)?.tabs.some((tab) => tab.id === 'worker')).toBe(true)
  setAttemptStatus('done')
  rig.focus('tab-a')
  expect(findProject(rig.service.state(), A)?.tabs.some((tab) => tab.id === 'worker')).toBe(false)
  expect(workerClosed).not.toHaveBeenCalled()
  await rig.bridge.dispose()
})

it('群組重開 session 以原名聚焦去重,且不被主廚分頁清理移除', () => {
  const rootPath = process.cwd()
  const project = createProjectEntry({ id: A, rootPath, conversationTabId: 'base', threadId: 'base-thread', now: NOW })
  const withWorker = openConversationTab(addProject(EMPTY_PROJECTS_STATE, project), A, {
    tabId: 'old-worker', threadId: 'old-worker-thread', provider: 'codex',
  }, NOW + 1)
  const initial: ProjectsState = {
    ...withWorker,
    projects: withWorker.projects.map(entry => entry.id !== A ? entry : {
      ...entry,
      tabs: entry.tabs.map(tab => tab.id === 'old-worker' ? { ...tab, chefTaskId: 'task-a' } : tab),
    }),
  }
  const chef = {
    tasksOf: (projectId: string) => projectId === A ? [{
      id: 'task-a', projectId: A, attempts: [{ workerId: 'old-worker', sessionId: 'codex-thread', status: 'done' }],
    }] : [],
    worker: () => undefined,
    workerClosed: vi.fn(),
    taskContext: () => undefined,
    guard: () => undefined,
    sources: () => [],
  } as unknown as IpcBridgeDeps['chef']
  const rig = makeRig(initial, { chef })
  const request = {
    projectId: A, provider: 'codex' as const, sessionId: 'codex-thread', tabLabel: 'codex-1 · 合併 PR #137',
  }

  rig.bridge.openHistoryConversation(request)
  rig.bridge.openHistoryConversation(request)

  const projectAfter = findProject(rig.service.state(), A)!
  const historyTabs = projectAfter.tabs.filter(tab => projectAfter.threads
    .find(thread => thread.id === tab.threadId)?.sessions.some(session => session.sessionId === request.sessionId))
  expect(historyTabs).toHaveLength(1)
  expect(historyTabs[0]).toMatchObject({
    label: request.tabLabel, customLabel: request.tabLabel, provider: 'codex',
  })
  expect(historyTabs[0]).not.toHaveProperty('chefTaskId')
  expect(activeTabId(projectAfter)).toBe(historyTabs[0]?.id)
  expect(rig.codexDeps.get('codex-unknown')?.initialThreadId).toBeUndefined()
  expect(rig.log.filter(entry => entry.endsWith('.openHistory(codex-thread)'))).toHaveLength(1)
  const cleaned = closeInactiveChefTabs(rig.service.state(), new Map(), NOW + 3)
  expect(findProject(cleaned, A)?.tabs.some(tab => tab.id === historyTabs[0]?.id)).toBe(true)
})

describe('啟動與切換', () => {
  it('main projects view 依 shared 規則將群組排在所有其他分頁前', () => {
    const rig = makeRig(twoProjects())
    const tabs = rig.view().projects.find((project) => project.id === A)?.tabs

    expect(tabs?.[0]?.contentType).toBe('group')
  })

  it('啟動只為 active 專案建 core 並 activate;initialSessionId 取 thread 鏈最後一筆', () => {
    const rig = makeRig(twoProjects())
    expect(rig.log).toEqual(['tab-a.activate'])
    expect(rig.fakes.has('tab-b')).toBe(false)
    expect(rig.fake('tab-a').deps.initialSessionId).toBeUndefined()

    const link = { linkId: 's-1', provider: 'claude' as const, sessionId: 's-1', transcriptPath: '/t/s-1.jsonl', parentLinkId: null, startedAt: 1, endedAt: null, endReason: null, models: [] }
    const linked = recordSession(twoProjects(), A, 'th-a', link)
    expect(makeRig(linked).fake('tab-a').deps.initialSessionId).toBe('s-1')
  })

  it('主廚管理的 Claude 對話自動放行 say_to_group', () => {
    const createConversation = vi.fn((deps: ConversationDeps) => makeFakeCore('tab-a', deps, () => {}, false).core)
    const chef = {
      worker: (id: string) => id === 'tab-a'
        ? { taskId: 'task-a', model: 'claude-sonnet', provider: 'claude', role: 'chef' }
        : undefined,
    } as unknown as IpcBridgeDeps['chef']
    const rig = makeRig(twoProjects(), { chef, createConversation })
    const internalAutoAllow = createConversation.mock.calls[0]?.[0].internalAutoAllow

    expect(internalAutoAllow?.('mcp__chef__say_to_group')).toBe(true)
  })

  it('主廚管理的對話不設批准逾時,逾時 outcome 會通知主廚', async () => {
    const denied = vi.fn()
    const createConversation = vi.fn((deps: ConversationDeps) => makeFakeCore('tab-a', deps, () => {}, false).core)
    const chef = {
      worker: (id: string) => id === 'tab-a'
        ? { taskId: 'task-a', model: 'claude-sonnet', provider: 'claude', role: 'chef' }
        : undefined,
      denied,
    } as unknown as IpcBridgeDeps['chef']
    const rig = makeRig(twoProjects(), { chef, createConversation })
    const conversationDeps = createConversation.mock.calls[0]?.[0]
    expect(conversationDeps?.approvalTimeoutMs).toBeNull()
    if (!conversationDeps?.createRegistry) throw new Error('主廚對話應有批准 registry')

    vi.useFakeTimers()
    try {
      const registry = conversationDeps.createRegistry({ timeoutMs: 10, sendRequest: () => {} })
      const outcome = registry.request({ toolUseId: 'toolu', toolName: 'Bash', input: {} })
      await vi.advanceTimersByTimeAsync(10)
      await expect(outcome).resolves.toMatchObject({ decision: 'deny', timedOut: true })
      expect(denied).toHaveBeenCalledWith('tab-a', { timedOut: true })
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('重新指定資料夾:core 重建成新 rootPath,active 專案重新 activate', async () => {
    const rig = makeRig(twoProjects())
    rig.log.length = 0
    rig.service.update((s) => relocateProject(s, A, '/p/alpha2'))
    await tick()
    // 舊 runtime 要等舊 core 收完才拆,所以它落在同步的重建之後
    expect(rig.log).toEqual(['tab-a.dispose', 'tab-a.activate', 'tab-a.runtime.dispose'])
    const opts = rig.fake('tab-a').deps.sessionOptions() as unknown as { rootPath: string }
    expect(opts.rootPath).toBe('/p/alpha2')
    expect(rig.view().projects[0]?.rootPath).toBe('/p/alpha2')
  })

  it('重新指定專案資料夾:同一個對話的瀏覽器留著(壽命跟著分頁,不跟著 slot)', async () => {
    const rig = makeRig(twoProjects())
    rig.browserLog.length = 0
    rig.service.update((s) => relocateProject(s, A, '/p/alpha2'))
    await tick()
    expect(rig.browserLog).not.toContain('dispose:tab-a')
    expect(rig.fake('tab-a').core.isActive()).toBe(true)
  })

  it('重新指定背景專案的資料夾:core 與 runtime 收掉,不重建也不 activate', async () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    rig.service.update((s) => setActive(s, A, NOW))
    const createdBefore = [...rig.created]
    rig.log.length = 0
    rig.service.update((s) => relocateProject(s, B, '/p/beta2'))
    await tick()
    expect(rig.log).toEqual(['tab-b.dispose', 'tab-b.runtime.dispose'])
    expect(rig.created).toEqual(createdBefore)
  })

  it('收掉 slot 時先等 core 收完才拆 runtime', async () => {
    const rig = makeRig(twoProjects(), {}, true)
    rig.log.length = 0
    rig.service.update((s) => removeProject(s, A))
    await tick()
    expect(rig.log).toEqual(['tab-a.browser.dispose', 'tab-b.activate', 'tab-a.dispose', 'tab-a.runtime.dispose'])
  })

  it('activeId 改變:先推 projects:state,再舊 core deactivate、新 core activate,右窗格換成新前景的瀏覽器', () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    expect(rig.log).toEqual(['tab-a.activate', 'tab-a.deactivate', 'tab-b.activate'])
    // 規則 2 的順序:renderer 先拿到新 activeId,才輪到右窗格換顯示、B activate 重播內容
    expect(rig.timeline.slice(-4)).toEqual([IPC.projectsState, 'tab-a.deactivate', 'browser.show:tab-b', 'tab-b.activate'])
    expect(rig.aborts).toEqual([])
    expect(rig.browserLog.at(-1)).toBe('show:tab-b')
    expect(rig.view().activeId).toBe(B)
    expect(rig.fake('tab-b').core.isActive()).toBe(true)
    expect(rig.fake('tab-a').core.isActive()).toBe(false)
  })

  it('建立時就顯示初始前景對話的瀏覽器', () => {
    const rig = makeRig(twoProjects())
    expect(rig.browserLog).toEqual(['show:tab-a'])
  })

  it('沒有專案時 show(null)', () => {
    const rig = makeRig(EMPTY_PROJECTS_STATE)
    expect(rig.browserLog).toEqual(['show:null'])
  })

  it('switchTo:browser.show 丟例外不阻斷新前景 activate,錯誤記下來', () => {
    const rig = makeRig(twoProjects(), {
      browser: {
        show: (id) => { if (id === 'tab-b') throw new Error('顯示失敗') },
        dispose: () => Promise.resolve(),
      },
    })
    rig.service.update((s) => setActive(s, B, NOW))
    expect(rig.fake('tab-b').core.isActive()).toBe(true)
    expect(rig.errors).toContain('browser.show：顯示失敗')
  })

  it('只收掉 slot(分頁還在):不收瀏覽器', async () => {
    const rig = makeRig(twoProjects())
    await rig.bridge.disposeConversation('tab-a')
    expect(rig.browserLog).not.toContain('dispose:tab-a')
    const tail = rig.log.filter((l) => l.startsWith('tab-a.')).slice(-2)
    expect(tail).toEqual(['tab-a.dispose', 'tab-a.runtime.dispose'])
  })

  it('沒有專案時啟動不建任何 core;有訊息進來記錯誤丟棄', () => {
    const rig = makeRig(EMPTY_PROJECTS_STATE)
    rig.fire(IPC.userInput, '嗨')
    expect(rig.fakes.size).toBe(0)
    expect(rig.errors).toEqual(['agent:input：沒有前景對話，已丟棄'])
  })

  it('移除背景專案:它的 core dispose,active 不動', async () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    rig.service.update((s) => setActive(s, A, NOW))
    rig.log.length = 0
    rig.service.update((s) => removeProject(s, B))
    await tick()
    expect(rig.log).toEqual(['tab-b.browser.dispose', 'tab-b.dispose', 'tab-b.runtime.dispose'])
    expect(rig.view().projects.map((p) => p.id)).toEqual([A])
  })

  it('移除 active 專案:它的 core dispose,下一個專案 activate', async () => {
    const rig = makeRig(twoProjects())
    rig.log.length = 0
    rig.service.update((s) => removeProject(s, A))
    await tick()
    expect(rig.log).toEqual(['tab-a.browser.dispose', 'tab-a.dispose', 'tab-b.activate', 'tab-a.runtime.dispose'])
  })
})

describe('轉送給 active core', () => {
  it('輸入與交接到前景核心,批准依 requestId 歸屬轉送', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.userInput, '嗨')
    rig.fake('tab-a').deps.sink.approvalAsk({ requestId: 'r-1', toolUseId: 't', toolName: 'Bash', input: {} })
    rig.fire(IPC.approvalReply, { requestId: 'r-1', decision: 'allow' })
    rig.fire(IPC.handoffDone, { toolUseId: 't-1' })
    expect(rig.log.slice(1)).toEqual([
      'tab-a.userInput(嗨)',
      'tab-a.approvalReply(r-1,allow)',
      'tab-a.handoffDone(t-1)',
    ])
  })

  it('payload 形狀不符:記錯誤,不轉送', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.userInput, 42)
    expect(rig.errors).toEqual(['agent:input：payload 形狀不符（number），已丟棄'])
    expect(rig.log).toEqual(['tab-a.activate'])
  })

  it('start-new:先開新 thread 再 core.startNew', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.intentStartNew)
    const entry = findProject(rig.service.state(), A)
    // startThread 會丟掉沒有 session 的舊 thread(projects-state 的規則),所以 th-a 不留下
    expect(entry?.threads.map((t) => t.id)).toEqual(['id-1'])
    expect(currentThread(entry!, 'tab-a')?.id).toBe('id-1')
    expect(rig.log.at(-1)).toBe('tab-a.startNew')
  })

  it('open-history:把 session 記進 thread(用 session 自己的 cwd 算 transcript 路徑)再 core.openHistory', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-9' })
    const thread = currentThread(findProject(rig.service.state(), A)!, 'tab-a')
    expect(thread?.sessions).toEqual([
      expect.objectContaining({
        sessionId: 's-9',
        transcriptPath: '/home/u/.claude/projects/-p-other/s-9.jsonl',
        parentLinkId: null,
        endedAt: null,
      }),
    ])
    expect(rig.log.at(-1)).toBe('tab-a.openHistory(s-9)')
  })

  it('執行中點目前歷史不重開、不取消批准或同伴問答', () => {
    const rig = makeRig(twoProjects())
    const fake = rig.fake('tab-a')
    fake.setBusy(true)
    vi.spyOn(fake.core, 'sessionState').mockReturnValue({ kind: 'live', sessionId: 's-1' })
    const before = [...rig.log]
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-1' })
    expect(rig.log).toEqual(before)
    expect(fake.core.isBusy()).toBe(true)
    expect(conversationTabs(findProject(rig.service.state(), A)!)).toHaveLength(1)
  })

  it('執行中查看另一筆歷史另開分頁，原 core 保持執行', () => {
    const rig = makeRig(twoProjects())
    const fake = rig.fake('tab-a')
    fake.setBusy(true)
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-9' })
    const entry = findProject(rig.service.state(), A)!
    const added = conversationTabs(entry).find(tab => tab.id !== 'tab-a')!
    expect(added.provider).toBe('claude')
    expect(lastSessionId(entry, added.id)).toBe('s-9')
    expect(rig.fake(added.id).deps.initialSessionId).toBe('s-9')
    expect(fake.core.isBusy()).toBe(true)
    expect(rig.log).toContain('tab-a.deactivate')
    expect(rig.log).not.toContain('tab-a.openHistory(s-9)')
    expect(rig.log).not.toContain('tab-a.dispose')
    expect(lastSessionId(entry, 'tab-a')).toBeUndefined()
  })

  it('歷史已在其他分頁執行時，聚焦原分頁而不建立第二個 session', () => {
    const rig = makeRig(openConversationTab(twoProjects(), A, { tabId: 'tab-a2', threadId: 'th-a2' }, NOW + 1))
    rig.service.update(state => focusTab(state, A, 'tab-a', NOW + 2))
    const first = rig.fake('tab-a')
    first.setBusy(true)
    vi.spyOn(first.core, 'sessionState').mockReturnValue({ kind: 'live', sessionId: 's-1' })
    rig.service.update(state => focusTab(state, A, 'tab-a2', NOW + 3))
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-1' })
    expect(first.core.isActive()).toBe(true)
    expect(first.core.isBusy()).toBe(true)
    expect(conversationTabs(findProject(rig.service.state(), A)!)).toHaveLength(2)
    expect(rig.log).not.toContain('tab-a2.openHistory(s-1)')
  })

  it('open-history 的 session 查不到 cwd:退回專案 rootPath', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-unknown' })
    const thread = currentThread(findProject(rig.service.state(), A)!, 'tab-a')
    expect(thread?.sessions[0]?.transcriptPath).toBe('/home/u/.claude/projects/-private-tmp-alpha/s-unknown.jsonl')
  })
})

describe('core 回報', () => {
  it('onSessionStarted 記進現行 thread;沒有 cwd 就用 rootPath', () => {
    const rig = makeRig(twoProjects())
    rig.fake('tab-a').deps.onSessionStarted?.('s-5', undefined)
    const thread = currentThread(findProject(rig.service.state(), A)!, 'tab-a')
    expect(thread?.sessions.map((s) => s.sessionId)).toEqual(['s-5'])
    expect(thread?.sessions[0]?.transcriptPath).toBe('/home/u/.claude/projects/-private-tmp-alpha/s-5.jsonl')
    expect(rig.fake('tab-a').deps.initialSessionId).toBeUndefined()
  })

  it('onPendingApprovalsChange 推 projects:state,pendingApproval 跟著 pendingApprovals', () => {
    const rig = makeRig(twoProjects())
    rig.sent.length = 0
    rig.fake('tab-a').setHeld(1)
    rig.fake('tab-a').deps.onPendingApprovalsChange?.(1)
    expect(rig.sent).toEqual([IPC.projectsState])
    expect(rig.view().projects.find((p) => p.id === A)?.pendingApproval).toBe(true)
    expect(rig.view().projects.find((p) => p.id === B)?.pendingApproval).toBe(false)
  })

  it('sink 把事件與狀態送到 webContents,approvalAsk 在 webContents 銷毀時 throw', () => {
    const rig = makeRig(twoProjects())
    rig.fake('tab-a').deps.sink.events([{ kind: 'reset' } as Event])
    rig.fake('tab-a').deps.sink.state({ kind: 'idle' })
    expect(rig.sent.filter((c) => c !== IPC.projectsState)).toEqual([IPC.eventsBatch, IPC.sessionState])
    const gone = makeRig(twoProjects(), {
      webContents: { isDestroyed: () => true, send: () => {} } as unknown as WebContents,
    })
    expect(() => gone.fake('tab-a').deps.sink.approvalAsk({ requestId: 'r', toolUseId: 't', toolName: 'x', input: {} }))
      .toThrow('agent:approval:ask：webContents 已銷毀')
  })

  it('sink 的 approvalAsk 送到 renderer 時帶上該 core 的 projectId;approvalSettled 走 best-effort', () => {
    const rig = makeRig(twoProjects())
    rig.fake('tab-a').deps.sink.approvalAsk({ requestId: 'r-1', toolUseId: 't', toolName: 'Bash', input: {} })
    expect(rig.lastSent.get(IPC.approvalAsk)).toMatchObject({ requestId: 'r-1', projectId: A, conversationId: 'tab-a' })
    rig.fake('tab-a').deps.sink.approvalSettled('r-1')
    expect(rig.lastSent.get(IPC.approvalSettled)).toEqual({ requestId: 'r-1' })
    const gone = makeRig(twoProjects(), {
      webContents: { isDestroyed: () => true, send: () => {} } as unknown as WebContents,
    })
    expect(() => gone.fake('tab-a').deps.sink.approvalSettled('r-1')).not.toThrow()
  })
})

describe('invoke 通道', () => {
  it('projects:get 先 replay 再回 view;available 反映 isDir', async () => {
    const state = addProject(twoProjects(), createProjectEntry({ id: 'proj-c', rootPath: '/p/gone', conversationTabId: 'tab-c', threadId: 'th-c', now: NOW }))
    const rig = makeRig(state)
    const view = (await rig.invoke(IPC.projectsGet)) as ProjectsView
    expect(rig.log.at(-1)).toBe('tab-a.replay')
    expect(view.activeId).toBe(A)
    expect(view.projects.map((p) => [p.id, p.available, p.activeTabId])).toEqual([
      [A, true, 'tab-a'],
      [B, true, 'tab-b'],
      ['proj-c', false, 'tab-c'],
    ])
  })

  it('projects:get 沒有 active 專案:不 replay,view 仍合法', async () => {
    const rig = makeRig(EMPTY_PROJECTS_STATE)
    const view = (await rig.invoke(IPC.projectsGet)) as ProjectsView
    expect(rig.log).toEqual([])
    expect(parseProjectsView(view)).toEqual({ activeId: null, projects: [] })
    expect(rig.errors).toEqual([])
  })

  it('session:list 依 projectId 過濾;null 回全部;未知 id 回空', async () => {
    const rig = makeRig(twoProjects())
    // s-1 的 cwd 與 A 的 rootPath 同為 realpath 形式,列得到;s-3 是同一個目錄的
    // symlink 形式(`/tmp/alpha`),列不到。主行程在路徑進登錄表時就 realpath 過,
    // 所以真的跑起來時 rootPath 不會是 symlink 形式那一邊。
    const mine = (await rig.invoke(IPC.sessionList, { projectId: A })) as readonly SessionSummary[]
    expect(mine.map((s) => s.sessionId)).toEqual(['s-1'])
    const all = (await rig.invoke(IPC.sessionList, { projectId: null })) as readonly SessionSummary[]
    expect(all).toHaveLength(4)
    const none = (await rig.invoke(IPC.sessionList, { projectId: 'zzz' })) as readonly SessionSummary[]
    expect(none).toEqual([])
  })

  it('session:list 的 payload 形狀不符:reject 並記錯誤', async () => {
    const rig = makeRig(twoProjects())
    await expect(rig.invoke(IPC.sessionList, 'x')).rejects.toThrow('payload 形狀不符')
    expect(rig.errors).toEqual(['session:list：payload 形狀不符（string），已丟棄'])
  })

  it('session:list 讀取失敗:記錯誤後 rethrow', async () => {
    const rig = makeRig(twoProjects(), {
      sessions: { list: async () => { throw new Error('磁碟壞了') }, loadHistory: async () => [], cwdOf: () => undefined },
    })
    await expect(rig.invoke(IPC.sessionList, { projectId: null })).rejects.toThrow('磁碟壞了')
    expect(rig.errors).toEqual(['session:list：磁碟壞了'])
  })

  it('terminal:endpoint 只讓主視窗取得 port 與 token', async () => {
    const without = makeRig(twoProjects())
    await expect(without.invoke(IPC.terminalEndpoint)).rejects.toThrow('沒有註冊')
    const withPort = makeRig(twoProjects(), { terminalPort: 4321, terminalToken: 'secret' })
    await expect(withPort.invokeFrom(IPC.terminalEndpoint, {})).rejects.toThrow('不接受此來源')
    expect(await withPort.invoke(IPC.terminalEndpoint)).toEqual({ port: 4321, token: 'secret' })
  })
})

describe('dispose', () => {
  it('拆掉所有 handler、dispose 所有 core、之後專案改變不再推送', async () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    rig.log.length = 0
    await rig.bridge.dispose()
    expect(rig.log.sort()).toEqual(['tab-a.dispose', 'tab-a.runtime.dispose', 'tab-b.dispose', 'tab-b.runtime.dispose'])
    expect(listeners.size).toBe(0)
    expect(handlers.size).toBe(0)
    rig.sent.length = 0
    rig.service.update((s) => setActive(s, A, NOW))
    expect(rig.sent).toEqual([])
    await rig.bridge.dispose()
  })
})

describe('conversationFor', () => {
  it('分頁不存在、專案不存在、或不是對話分頁都回 undefined', () => {
    const state = openTab(twoProjects(), A, { id: 'term-1', label: 'zsh' }, NOW + 1)
    const rig = makeRig(state)
    expect(rig.bridge.conversationFor('missing-project', 'tab-a')).toBeUndefined()
    expect(rig.bridge.conversationFor(A, 'missing-tab')).toBeUndefined()
    expect(rig.bridge.conversationFor(A, 'term-1')).toBeUndefined()
  })

  it('已有 slot(即使不再是前景)時,userInput 照樣送達,isBusy 反映該 slot', () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    const conversation = rig.bridge.conversationFor(A, 'tab-a')
    expect(conversation?.isBusy()).toBe(false)
    conversation?.userInput('嗨')
    expect(rig.fake('tab-a').core.userInput).toHaveBeenCalledWith('嗨')
  })

  it('已有 slot 時 isBusy 反映那個 slot 的忙碌狀態', () => {
    const rig = makeRig(twoProjects())
    const conversation = rig.bridge.conversationFor(A, 'tab-a')
    expect(conversation?.isBusy()).toBe(false)
    rig.fake('tab-a').setBusy(true)
    expect(conversation?.isBusy()).toBe(true)
  })

  /**
   * B 從沒被切到前景,tab-b 的 slot 從沒建過。userInput 不該像 slotFor 那樣「順便」
   * 建一個新的 agent session:那會拿衝突訊息當第一句 prompt 憑空開一場對話,而且
   * 沒人 activate/deactivate 它,變成背景孤兒 query(合併規格 §4)。
   */
  /**
   * 主廚管理中的分頁跟 peer 那邊一樣要先過 guard:那個工作目錄正在被主廚任務用,
   * 這時把合併衝突那句話塞進去等於插隊。isBusy 為 true,合併就會先被擋下來。
   */
  it('主廚管理中的分頁 isBusy 為 true,userInput 也不送出去', () => {
    const chef = {
      guard: (id: string) => (id === 'tab-a' ? '此工作目錄由主廚任務使用中，請先等待或停止該任務。' : undefined),
      worker: () => undefined,
      sources: () => [],
      taskContext: () => undefined,
      runnable: () => false,
      observe: () => {},
      waiting: () => {},
      denied: () => {},
      workerClosed: () => {},
    } as unknown as NonNullable<IpcBridgeDeps['chef']>
    const rig = makeRig(twoProjects(), { chef })
    const conversation = rig.bridge.conversationFor(A, 'tab-a')
    expect(conversation?.isBusy()).toBe(true)
    conversation?.userInput('主分支已合進目前分支,但有衝突')
    expect(rig.fake('tab-a').core.userInput).not.toHaveBeenCalled()
  })

  it('分頁沒開過對話時 userInput 不會建 slot,也不會送任何東西', () => {
    const rig = makeRig(twoProjects())
    const createdBefore = rig.created.length
    const conversation = rig.bridge.conversationFor(B, 'tab-b')
    expect(conversation?.isBusy()).toBe(false)
    conversation?.userInput('主分支已合進目前分支,但有衝突')
    expect(rig.created).toHaveLength(createdBefore)
    expect(rig.runtimeProviders.some(([id]) => id === 'tab-b')).toBe(false)
    expect(() => rig.fake('tab-b')).toThrow()
  })
})

describe('deliverToManaged', () => {
  it('專案不存在、分頁不存在、不是對話分頁、或沒有 slot 都回 missing', () => {
    const state = openTab(twoProjects(), A, { id: 'term-1', label: 'zsh' }, NOW + 1)
    const rig = makeRig(state)
    expect(rig.bridge.deliverToManaged('missing-project', 'tab-a', '嗨')).toEqual({ kind: 'missing' })
    expect(rig.bridge.deliverToManaged(A, 'missing-tab', '嗨')).toEqual({ kind: 'missing' })
    expect(rig.bridge.deliverToManaged(A, 'term-1', '嗨')).toEqual({ kind: 'missing' })
    // tab-b 的 slot 從沒建過:不憑空開一場 agent session。
    expect(rig.bridge.deliverToManaged(B, 'tab-b', '嗨')).toEqual({ kind: 'missing' })
  })

  it('主廚 guard 擋得住 conversationFor,擋不住 deliverToManaged', () => {
    const chef = {
      guard: (id: string) => (id === 'tab-a' ? '此工作目錄由主廚任務使用中，請先等待或停止該任務。' : undefined),
      worker: () => undefined,
      sources: () => [],
      taskContext: () => undefined,
      runnable: () => false,
      observe: () => {},
      waiting: () => {},
      denied: () => {},
      workerClosed: () => {},
    } as unknown as NonNullable<IpcBridgeDeps['chef']>
    const rig = makeRig(twoProjects(), { chef })
    const conversation = rig.bridge.conversationFor(A, 'tab-a')
    conversation?.userInput('走一般路')
    expect(rig.fake('tab-a').core.userInput).not.toHaveBeenCalled()
    expect(conversation?.isBusy()).toBe(true)

    expect(rig.bridge.deliverToManaged(A, 'tab-a', '走群組路')).toEqual({ kind: 'delivered', busy: false })
    expect(rig.fake('tab-a').core.userInput).toHaveBeenCalledWith('走群組路')
  })

  it('對方正在工作時仍然送出,並回報 busy', () => {
    const rig = makeRig(twoProjects())
    rig.bridge.deliverToManaged(A, 'tab-a', '先建 slot')
    rig.fake('tab-a').setBusy(true)
    expect(rig.bridge.deliverToManaged(A, 'tab-a', '插一句')).toEqual({ kind: 'delivered', busy: true })
    expect(rig.fake('tab-a').core.userInput).toHaveBeenLastCalledWith('插一句')
  })

  it('不是前景的對話送完之後被收回背景', () => {
    const rig = makeRig(twoProjects())
    rig.bridge.deliverToManaged(A, 'tab-a', '先建 slot')
    rig.service.update((s) => setActive(s, B, NOW))
    const before = rig.log.length
    expect(rig.bridge.deliverToManaged(A, 'tab-a', '背景也收得到')).toEqual({ kind: 'delivered', busy: false })
    expect(rig.fake('tab-a').core.userInput).toHaveBeenLastCalledWith('背景也收得到')
    expect(rig.log.slice(before)).toContain('tab-a.deactivate')
  })
})

describe('多個對話分頁', () => {
  it('分頁指到不存在的 thread:建 slot 記錯誤、當新對話;session-started 時補一條 thread 記進去', () => {
    const broken: ProjectsState = {
      ...twoProjects(),
      projects: twoProjects().projects.map((p) =>
        p.id === A ? { ...p, tabs: p.tabs.map((t) => (t.id === 'tab-a' ? { ...t, threadId: 'th-missing' } : t)) } : p),
    }
    const rig = makeRig(broken)
    expect(rig.errors).toEqual(['對話分頁 tab-a 指到不存在的 thread，當成新對話'])
    expect(rig.fake('tab-a').deps.initialSessionId).toBeUndefined()
    rig.fake('tab-a').deps.onSessionStarted?.('s-new', '/private/tmp/alpha')
    const a = findProject(rig.service.state(), A)!
    expect(lastSessionId(a, 'tab-a')).toBe('s-new')
    expect(currentThread(a, 'tab-a')?.id).toBe('id-1')
  })

  const withSecond = (): ProjectsState =>
    openConversationTab(twoProjects(), A, { tabId: 'tab-a2', threadId: 'th-a2' }, NOW + 1)

  it('啟動時前景是 active 專案最近聚焦的對話分頁;只建那一個 core', () => {
    const rig = makeRig(withSecond())
    expect(rig.log).toEqual(['tab-a2.activate'])
    expect(rig.fakes.has('tab-a')).toBe(false)
  })

  it('同專案切分頁:舊對話 deactivate、新對話 activate,右窗格換成新前景的瀏覽器;先推 projects:state', () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    expect(rig.log).toEqual(['tab-a2.activate', 'tab-a2.deactivate', 'tab-a.activate'])
    expect(rig.timeline.slice(-4)).toEqual([IPC.projectsState, 'tab-a2.deactivate', 'browser.show:tab-a', 'tab-a.activate'])
    expect(rig.aborts).toEqual([])
    expect(rig.browserLog.at(-1)).toBe('show:tab-a')
  })

  it('切到終端分頁不切前景對話', () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => openTab(s, A, { id: 'term-1', label: 'zsh' }, NOW + 5))
    expect(rig.log).toEqual(['tab-a2.activate'])
  })

  it('兩個對話的事件與狀態各帶自己的 conversationId,不互串', () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.fake('tab-a').deps.sink.events([{ kind: 'user-text', text: '甲' }])
    rig.fake('tab-a').deps.sink.state({ kind: 'live' })
    expect(rig.lastSent.get(IPC.eventsBatch)).toEqual({ conversationId: 'tab-a', events: [{ kind: 'user-text', text: '甲' }] })
    expect(rig.lastSent.get(IPC.sessionState)).toEqual({ conversationId: 'tab-a', state: { kind: 'live' } })
    rig.fake('tab-a2').deps.sink.events([{ kind: 'user-text', text: '乙' }])
    expect(rig.lastSent.get(IPC.eventsBatch)).toEqual({ conversationId: 'tab-a2', events: [{ kind: 'user-text', text: '乙' }] })
  })

  it('批准請求帶 projectId 與 conversationId', () => {
    const rig = makeRig(withSecond())
    rig.fake('tab-a2').deps.sink.approvalAsk({ requestId: 'r1', toolUseId: 't1', toolName: 'Bash', input: {} })
    expect(rig.lastSent.get(IPC.approvalAsk)).toEqual({
      requestId: 'r1', toolUseId: 't1', toolName: 'Bash', input: {}, projectId: A, conversationId: 'tab-a2',
    })
  })

  it('agent:input 與 intent 送給前景對話', () => {
    const rig = makeRig(withSecond())
    rig.fire(IPC.userInput, 'hi')
    rig.fire(IPC.intentStartNew)
    expect(rig.log).toContain('tab-a2.userInput(hi)')
    expect(rig.log).toContain('tab-a2.startNew')
    const a = findProject(rig.service.state(), A)!
    expect(conversationTabs(a).map((t) => t.threadId)).toEqual(['th-a', 'id-1'])
  })

  it('session-started 記進該對話分頁的 thread', () => {
    const rig = makeRig(withSecond())
    rig.fake('tab-a2').deps.onSessionStarted?.('s-new', '/private/tmp/alpha')
    const a = findProject(rig.service.state(), A)!
    expect(lastSessionId(a, 'tab-a2')).toBe('s-new')
    expect(lastSessionId(a, 'tab-a')).toBeUndefined()
    expect(currentThread(a, 'tab-a2')?.sessions[0]).toMatchObject({ linkId: 's-new', provider: 'claude', models: [] })
  })

  it('關閉對話分頁:dispose 那一個 slot,前景換到另一個對話', async () => {
    const rig = makeRig(withSecond())
    rig.log.length = 0
    rig.service.update((s) => closeTab(s, A, 'tab-a2', NOW + 3))
    await tick()
    expect(rig.log).toEqual(['tab-a2.browser.dispose', 'tab-a2.dispose', 'tab-a.activate', 'tab-a2.runtime.dispose'])
  })

  it('關閉對話分頁:分頁從狀態消失就收掉它的瀏覽器', async () => {
    const rig = makeRig(withSecond())
    rig.browserLog.length = 0
    rig.service.update((s) => closeTab(s, A, 'tab-a2', NOW + 3))
    await tick()
    expect(rig.browserLog.filter((l) => l === 'dispose:tab-a2')).toHaveLength(1)
    expect(rig.browserLog).not.toContain('dispose:tab-a')
  })

  it('移除專案:底下每個對話的 slot 都 dispose', async () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.log.length = 0
    rig.service.update((s) => removeProject(s, A))
    await tick()
    expect(rig.log.filter((l) => /^tab-a2?\.dispose$/.test(l)).sort()).toEqual(['tab-a.dispose', 'tab-a2.dispose'])
    expect(rig.log).toContain('tab-b.activate')
  })

  it('移除專案:底下每個對話的瀏覽器都收掉', async () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.browserLog.length = 0
    rig.service.update((s) => removeProject(s, A))
    await tick()
    expect(rig.browserLog.filter((l) => l === 'dispose:tab-a')).toHaveLength(1)
    expect(rig.browserLog.filter((l) => l === 'dispose:tab-a2')).toHaveLength(1)
  })

  it('view 的 pendingTabIds 與 busyTabIds 依對話分頁;pendingApproval 是任一', () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.fake('tab-a2').setHeld(1)
    rig.fake('tab-a2').deps.onPendingApprovalsChange?.(1)
    rig.fake('tab-a').setBusy(true)
    const a = rig.view().projects.find((p) => p.id === A)!
    expect(a.pendingTabIds).toEqual(['tab-a2'])
    expect(a.busyTabIds).toEqual(['tab-a'])
    expect(a.pendingApproval).toBe(true)
    rig.fake('tab-a2').setHeld(0)
    rig.fake('tab-a2').deps.onPendingApprovalsChange?.(0)
    expect(rig.view().projects.find((p) => p.id === A)!.pendingApproval).toBe(false)
  })

  it('router 只補 conversationId,一則進一則出', () => {
    // 背景抑制在 conversation.ts 的 emit 守衛,由 conversation.test.ts 驗;這裡的假 core 走不到它
    const rig = makeRig(withSecond())
    rig.fake('tab-a2').deps.sink.events([{ kind: 'user-text', text: 'x' }])
    expect(rig.sent.filter((c) => c === IPC.eventsBatch)).toHaveLength(1)
  })
})

describe('codex 對話分頁', () => {
  const withCodex = (): ProjectsState =>
    // bridge 會立即建立前景 core;先留在 Claude,等 codexTags 設好再切過去。
    focusTab(openConversationTab(twoProjects(), A, { tabId: 'tab-ax', threadId: 'th-ax', provider: 'codex' }, NOW + 1), A, 'tab-a', NOW + 2)

  it('provider 為 codex 的分頁用 codex 工廠,cwd 是專案根目錄,並拿到右窗格工具', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    const d = rig.codexDeps.get('tab-ax')
    expect(d?.cwd).toBe('/private/tmp/alpha')
    expect(d?.initialThreadId).toBeUndefined()
    expect(d?.viewTools).toBeDefined()
  })

  it('codex 分頁切走時,它的右窗格呼叫不被中止', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.aborts.length = 0
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 4))
    expect(rig.aborts).toEqual([])
  })

  it('codex 核心拿到的 viewTools 就是那個分頁自己的 runtime 那一份', async () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    await rig.codexDeps.get('tab-ax')?.viewTools?.invoke('view_click', { ref: 's1-e0' }, { callId: 'exec-1' })
    expect(rig.invokes).toContain('tab-ax:view_click:exec-1')
  })

  it('handoff:done 送到前景的 codex 分頁,轉進它的 runtime', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.log.length = 0
    rig.fire(IPC.handoffDone, { toolUseId: 'exec-2' })
    expect(rig.log.some((l) => l.includes('tab-ax.handoffDone('))).toBe(true)
  })

  it('codex 對話的事件與批准一樣帶 conversationId 與 projectId', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    const fake = rig.fake('tab-ax')
    fake.deps.sink.events([{ kind: 'user-text', text: '甲' }])
    expect(rig.lastSent.get(IPC.eventsBatch)).toEqual({ conversationId: 'tab-ax', events: [{ kind: 'user-text', text: '甲' }] })
    fake.deps.sink.approvalAsk({ requestId: 'r1', toolUseId: 't1', toolName: 'Bash', input: {} })
    expect(rig.lastSent.get(IPC.approvalAsk)).toEqual({
      requestId: 'r1', toolUseId: 't1', toolName: 'Bash', input: {}, projectId: A, conversationId: 'tab-ax',
    })
  })

  it('codex 分頁的 threadId 存進 thread,重建時當成 initialThreadId', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.codexDeps.get('tab-ax')?.onSessionStarted?.('codex-thread-1', '/private/tmp/alpha')
    const a = findProject(rig.service.state(), A)!
    expect(lastSessionId(a, 'tab-ax')).toBe('codex-thread-1')
    expect(currentThread(a, 'tab-ax')?.sessions[0]).toMatchObject({ provider: 'codex', transcriptPath: null })
  })

  it('codex 分頁開歷史並記錄 codex link', () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.log.length = 0
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-9' })
    expect(rig.log).toContain('tab-ax.openHistory(s-9)')
    expect(JSON.stringify(rig.service.state())).toContain('s-9')
  })

  it('codex slot 收掉時連它的 runtime 一起拆(核心先收完才拆)', async () => {
    const rig = makeRig(withCodex())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.service.update((s) => focusTab(s, A, 'tab-ax', NOW + 3))
    rig.log.length = 0
    rig.service.update((s) => closeTab(s, A, 'tab-ax', NOW + 4))
    await tick()
    expect(rig.log.indexOf('tab-ax.dispose')).toBeGreaterThanOrEqual(0)
    expect(rig.log.indexOf('tab-ax.runtime.dispose')).toBeGreaterThan(rig.log.indexOf('tab-ax.dispose'))
    // 切分頁與關分頁是正常操作,不記進錯誤通道。
    expect(rig.errors).toEqual([])
  })
})

describe('grok 分頁', () => {
  const withGrokTab = (): ProjectsState =>
    // bridge 會立即建立前景 core;先留在 Claude,等 grokTags 設好、切到前景才建 grok 的 slot。
    focusTab(openConversationTab(twoProjects(), A, { tabId: 'grok-tab', threadId: 'th-grok', provider: 'grok' }, NOW + 1), A, 'tab-a', NOW + 2)

  function makeRigWithGrokTab() {
    const rig = makeRig(withGrokTab())
    rig.grokTags.set('/private/tmp/alpha', 'grok-a')
    rig.service.update((s) => focusTab(s, A, 'grok-tab', NOW + 3))
    return rig
  }

  it('provider 為 grok 的分頁用 grok 的對話核心,cwd 與 viewTools 都接上', () => {
    const rig = makeRigWithGrokTab()
    expect(rig.created).toContain('grok-a')
    const deps = rig.grokDeps.get('grok-a')
    expect(deps?.cwd).toBe('/private/tmp/alpha')
    expect(deps?.viewTools).toBeDefined()
  })

  it('grok 的 session 記進 thread 時 transcriptPath 是 null', () => {
    const rig = makeRigWithGrokTab()
    rig.grokDeps.get('grok-a')?.onSessionStarted?.('s-1', '/private/tmp/alpha')
    const link = rig.service.state().projects.flatMap((p) => p.threads).flatMap((t) => t.sessions).find((s) => s.sessionId === 's-1')
    expect(link).toMatchObject({ provider: 'grok', transcriptPath: null })
  })

  it('runtimeFor 收得到這個分頁的 provider', () => {
    const rig = makeRigWithGrokTab()
    expect(rig.runtimeProviders).toContainEqual(['grok-tab', 'grok'])
  })

  it('grok 分頁的 repo 清單只用 live 事件,不去讀 Claude 的逐字稿', async () => {
    const repositories = vi.fn(async () => ({ kind: 'repositories' as const, repositories: [], warnings: [] as string[] }))
    const loadClaudeActivity = vi.fn(async () => ({ groups: [], warnings: [] }))
    const rig = makeRig(withGrokTab(), {
      loadClaudeActivity,
      developmentDiff: { repositories, capture: async () => {}, read: async () => { throw Error('unused') } },
    })
    rig.grokTags.set('/private/tmp/alpha', 'grok-a')
    rig.service.update((s) => focusTab(s, A, 'grok-tab', NOW + 3))
    vi.spyOn(rig.fake('grok-a').core, 'sessionState').mockReturnValue({ kind: 'viewing', sessionId: 'g-1' })
    const result = await rig.invoke(CONVERSATION_TOOLS_CHANNEL, { action: 'repositories', conversationId: 'grok-tab' })
    expect(loadClaudeActivity).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'repositories', warnings: [] })
  })

  it('session:list 帶 provider grok 時查 grokCatalog', async () => {
    const listed: Array<string | undefined> = []
    const rig = makeRig(undefined, {
      grokCatalog: { models: async () => [], list: async (cwd?: string) => { listed.push(cwd); return [] } },
    })
    await rig.invoke(IPC.sessionList, { projectId: null, provider: 'grok' })
    expect(listed).toEqual([undefined])
  })
})

async function harnessWithPeer(service: PeerService | undefined) {
  const initial = addProject(EMPTY_PROJECTS_STATE, createProjectEntry({ id: 'p1', rootPath: '/p/one', conversationTabId: 'c1', threadId: 'th-1', now: NOW }))
  const h = makeRig(openConversationTab(initial, 'p1', { tabId: 'c2', threadId: 'th-2', provider: 'claude' }, NOW), { peer: service })
  h.codexTags.set('/p/one', 'codex-tab')
  h.service.update((s) => focusTab(openConversationTab(s, 'p1', { tabId: 'codex-tab', threadId: 'th-codex', provider: 'codex' }, NOW), 'p1', 'c2', NOW))
  h.appendSession('c1', 'sess-1')
  return { ...h, codexDeps: (id: string) => h.codexDeps.get(id) }
}

/** 只記下被呼叫了什麼,不做事。 */
function fakePeerService(opts: { failAnswer?: boolean; failCancel?: boolean; sync?: boolean } = {}) {
  let pendingValue: readonly PeerPending[] = []
  const changes = new Set<() => void>()
  const answered: [string, string][] = []
  const cancelled: string[] = []
  const entries = new Map<string, PeerEntry>()
  const calls: string[] = []
  const registry = {
    register: (e: PeerEntry) => { entries.set(e.conversationId, e); calls.push(`register:${e.conversationId}`) },
    unregister: (id: string) => { entries.delete(id); calls.push(`unregister:${id}`) },
    get: (id: string) => entries.get(id),
    byLinkId: () => undefined,
    peersOf: () => [],
    resolve: () => { throw new Error('未使用') },
  } as unknown as PeerRegistry
  const service: PeerService = {
    registry,
    pending: () => pendingValue,
    onChange: (cb) => { changes.add(cb); return () => { changes.delete(cb) } },
    answerAsUser: (id, text) => {
      if (opts.sync) throw new Error(id)
      if (opts.failAnswer) return Promise.reject(new Error(id))
      answered.push([id, text]); return Promise.resolve()
    },
    cancelAsUser: (id) => {
      if (opts.sync) throw new Error(id)
      if (opts.failCancel) return Promise.reject(new Error(id))
      cancelled.push(id); return Promise.resolve()
    },
    forConversation: (): PeerTools => ({ askPeer: async () => '', answerPeer: async () => '' }),
    notifyIdle: (id) => { calls.push(`idle:${id}`) },
    conversationEnded: (id) => { calls.push(`ended:${id}`) },
    cancelPendingOnStartup: async () => {},
    dispose: () => {},
  }
  return { service, entries, calls, answered, cancelled,
    get pendingValue() { return pendingValue },
    setPending: (p: readonly PeerPending[]) => { pendingValue = p.map((item) => ({ ...item })) },
    fireChange: () => { for (const cb of changes) cb() },
    changeCount: () => changes.size,
    register: registry.register.bind(registry) }
}

describe('同伴登錄', () => {
  it('未建核心的登錄隨搬目錄更新，有 session 才可被同伴查到，終端不登錄', async () => {
    const peer = fakePeerService()
    const registry = createPeerRegistry()
    const initial = openTab(openConversationTab(twoProjects(), A,
      { tabId: 'tab-a2', threadId: 'th-a2' }, NOW), A,
      { id: 'term', label: '終端' }, NOW)
    const h = makeRig(initial, { peer: { ...peer.service, registry } })
    expect(registry.get('tab-a2')).toBeDefined()
    expect(registry.get('term')).toBeUndefined()
    expect(registry.peersOf('tab-a')).toEqual([])
    h.appendSession('tab-a2', 'saved-session')
    expect(registry.peersOf('tab-a').map((e) => e.conversationId)).toEqual(['tab-a2'])
    h.service.update((s) => relocateProject(s, A, '/moved'))
    expect(registry.get('tab-a2')?.rootPath).toBe('/moved')
    expect(h.fakes.has('tab-a2')).toBe(false)
    registry.get('tab-a2')?.deliver('續問')
    expect(h.fake('tab-a2').deps.initialSessionId).toBe('saved-session')
    expect(h.fake('tab-a2').core.userInput).toHaveBeenCalledExactlyOnceWith('續問')
    h.service.update((s) => removeProject(s, B))
    expect(registry.get('tab-b')).toBeUndefined()
    await h.bridge.dispose()
  })

  it('開機登錄兩專案四對話，背景投遞才建核心，未建核心的分頁關閉也解除', async () => {
    const peer = fakePeerService()
    const initial = setActive(openConversationTab(openConversationTab(twoProjects(), A,
      { tabId: 'tab-a2', threadId: 'th-a2', provider: 'claude' }, NOW), B,
      { tabId: 'tab-b2', threadId: 'th-b2', provider: 'claude' }, NOW), A, NOW)
    const h = makeRig(focusTab(initial, A, 'tab-a2', NOW + 1), { peer: peer.service })
    expect([...peer.entries.keys()].sort()).toEqual(['tab-a', 'tab-a2', 'tab-b', 'tab-b2'])
    expect(h.created).toEqual(['tab-a2'])
    const target = peer.entries.get('tab-b')
    expect(target?.isBusy()).toBe(false)
    target?.deliver('背景提問')
    expect(h.created).toEqual(['tab-a2', 'tab-b'])
    expect(h.fake('tab-b').core.isActive()).toBe(false)
    expect(h.fake('tab-b').core.userInput).toHaveBeenCalledExactlyOnceWith('背景提問')
    expect(h.log.slice(-2)).toEqual(['tab-b.userInput(背景提問)', 'tab-b.deactivate'])
    h.fake('tab-b').setBusy(true)
    expect(target?.isBusy()).toBe(true)
    h.service.update((s) => closeTab(s, A, 'tab-a', NOW))
    expect(peer.entries.has('tab-a')).toBe(false)
    expect(peer.calls.filter((c) => c.endsWith(':tab-a'))).toEqual(['register:tab-a', 'ended:tab-a', 'unregister:tab-a'])
    expect(peer.calls.filter((c) => c === 'register:tab-b')).toHaveLength(1)
    await h.bridge.dispose()
    expect(peer.entries.size).toBe(0)
  })

  it('每個對話在狀態同步時登錄一次,linkId、provider、rootPath 都對', async () => {
    const peer = fakePeerService()
    // 專案 p1 有一個 claude 對話 c1,狀態檔裡它的 thread 最後一場 link 是 'sess-1'。
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    const entry = peer.entries.get('c1')
    expect(entry).toBeDefined()
    expect(entry?.provider).toBe('claude')
    expect(entry?.rootPath).toBe('/p/one')
    expect(entry?.linkId()).toBe('sess-1')
  })

  it('linkId 每次都重讀:resume 換了 session 之後回新的那個', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.appendSession('c1', 'sess-2')
    expect(peer.entries.get('c1')?.linkId()).toBe('sess-2')
  })

  it('前景對話收到同伴投遞只送出輸入，不要求休眠', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    const before = h.log.length
    peer.entries.get('c1')?.deliver('同伴提問')
    expect(h.coreFor('c1').userInput).toHaveBeenCalledWith('同伴提問')
    expect(h.log.slice(before)).toEqual(['c1.userInput(同伴提問)'])
  })

  it('recentText 是使用者最後打的那句,注入的提問不算', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.send(IPC.userInput, '我打的字')
    peer.entries.get('c1')?.deliver('同伴(claude,aaaa)提問:別的字')
    expect(peer.entries.get('c1')?.recentText()).toBe('我打的字')
  })

  it('回合結束時通知 notifyIdle,開始忙不通知', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.coreFor('c1').emitBusy(true)
    expect(peer.calls).not.toContain('idle:c1')
    h.coreFor('c1').emitBusy(false)
    expect(peer.calls).toContain('idle:c1')
  })

  it('對話關掉時先 conversationEnded 再 unregister', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.closeTab('c1')
    expect(peer.calls.filter((c) => c.endsWith(':c1'))).toEqual(['register:c1', 'ended:c1', 'unregister:c1'])
  })

  it('開新對話也算那一場結束,但不取消登錄', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.send(IPC.intentStartNew, undefined)
    expect(peer.calls).toContain('ended:c1')
    expect(peer.calls).not.toContain('unregister:c1')
  })

  it('沒給 peer 時一切照舊,不會丟例外', async () => {
    const h = await harnessWithPeer(undefined)
    h.focus('c1')
    h.send(IPC.userInput, '照舊')
    expect(h.coreFor('c1').userInput).toHaveBeenCalledWith('照舊')
  })
})

describe('同伴生命週期', () => {
  it('整體 dispose 清掉所有登錄,重複 dispose 不重複取消', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.focus('c2')
    await h.bridge.dispose()
    await h.bridge.dispose()
    expect(peer.entries.size).toBe(0)
    expect(peer.calls.filter((c) => c.endsWith(':c1'))).toEqual(['register:c1', 'ended:c1', 'unregister:c1'])
    expect(peer.calls.filter((c) => c.endsWith(':c2'))).toEqual(['register:c2', 'ended:c2', 'unregister:c2'])
  })

  it('搬目錄重建登錄並清除最近訊息,移除專案後舊 linkId 回 undefined', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('c1')
    h.send(IPC.userInput, '我打的字')
    const old = peer.entries.get('c1')!
    h.service.update((s) => relocateProject(s, 'p1', '/p/moved'))
    const entry = peer.entries.get('c1')!
    expect(entry).not.toBe(old)
    expect(entry.rootPath).toBe('/p/moved')
    expect(entry.recentText()).toBe('')
    h.service.update((s) => removeProject(s, 'p1'))
    expect(entry.linkId()).toBeUndefined()
  })

  it('codex 對話也登錄成同伴,並拿到同伴工具', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.focus('codex-tab')
    const entry = peer.entries.get('codex-tab')
    expect(entry).toBeDefined()
    expect(entry?.provider).toBe('codex')
    expect(h.codexDeps('codex-tab')?.peerTools).toBeDefined()
  })

  it('沒給 peer 時 codex 核心不帶同伴工具', async () => {
    const h = await harnessWithPeer(undefined)
    h.focus('codex-tab')
    expect(h.codexDeps('codex-tab')?.peerTools).toBeUndefined()
  })
})

describe('同伴未決狀態', () => {
  it('peer.onChange 觸發時整份推 peer:state', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    peer.setPending([
      { questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2',
        askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false },
    ])
    peer.fireChange()
    expect(h.payloads(IPC.peerState)).toEqual([{ pending: peer.pendingValue }])
  })

  it('收到 peer:answer 就呼叫 answerAsUser', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.emit(IPC.peerAnswer, { questionId: 'q1', text: '我幫他答' })
    expect(peer.answered).toEqual([['q1', '我幫他答']])
  })

  it('peer:answer 少了 text 就記錯誤,不呼叫服務', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.emit(IPC.peerAnswer, { questionId: 'q1' })
    expect(peer.answered).toEqual([])
    expect(h.errors.some((e) => e.includes(IPC.peerAnswer))).toBe(true)
  })

  it('收到 peer:cancel 就呼叫 cancelAsUser', async () => {
    const peer = fakePeerService()
    const h = await harnessWithPeer(peer.service)
    h.fire(IPC.peerCancel, { questionId: 'q1' })
    expect(peer.cancelled).toEqual(['q1'])
  })

  it('服務丟錯時記錯誤,不讓例外跑出去', async () => {
    const peer = fakePeerService({ failAnswer: true })
    const h = await harnessWithPeer(peer.service)
    h.emit(IPC.peerAnswer, { questionId: 'q1', text: 'x' })
    await Promise.resolve()
    expect(h.errors.some((e) => e.includes('q1'))).toBe(true)
  })

  it('沒給 peer 時三個頻道都不註冊,送進來也不會炸', async () => {
    const h = await harnessWithPeer(undefined)
    expect(() => { h.emit(IPC.peerAnswer, { questionId: 'q1', text: 'x' }) }).not.toThrow()
  })
})

it('同伴頻道與變更訂閱在 dispose 解除,沒有 peer 完全不註冊', async () => {
  const peer = fakePeerService()
  const h = await harnessWithPeer(peer.service)
  expect(peer.changeCount()).toBe(1)
  await h.bridge.dispose()
  expect(peer.changeCount()).toBe(0)
  for (const channel of [IPC.peerState, IPC.peerAnswer, IPC.peerCancel]) {
    expect(listeners.has(channel)).toBe(false)
    expect(handlers.has(channel)).toBe(false)
  }
  const absent = await harnessWithPeer(undefined)
  for (const channel of [IPC.peerState, IPC.peerAnswer, IPC.peerCancel]) {
    expect(listeners.has(channel)).toBe(false)
    expect(handlers.has(channel)).toBe(false)
    expect(() => absent.emit(channel, null)).not.toThrow()
  }
})

it('取消失敗、同步丟錯及壞 payload 都只記錯誤', async () => {
  for (const opts of [{ failCancel: true }, { sync: true }]) {
    const peer = fakePeerService(opts)
    const h = await harnessWithPeer(peer.service)
    expect(() => h.fire(IPC.peerCancel, { questionId: 'q1' })).not.toThrow()
    await Promise.resolve()
    expect(h.errors.some((e) => e.includes('q1'))).toBe(true)
    if (opts.sync) expect(() => h.emit(IPC.peerAnswer, { questionId: 'q1', text: 'x' })).not.toThrow()
    h.fire(IPC.peerCancel, null)
    h.emit(IPC.peerAnswer, { questionId: '', text: 3 })
    expect(peer.answered).toEqual([])
    expect(peer.cancelled).toEqual([])
    expect(h.errors.some((e) => e.includes(IPC.peerCancel))).toBe(true)
  }
})

it('peer:get 供晚訂閱者取得未決快照,dispose 移除 invoke', async () => {
  const peer = fakePeerService()
  const h = await harnessWithPeer(peer.service)
  peer.setPending([{ questionId: 'q1', projectId: 'p1', askerConversationId: 'c1', targetConversationId: 'c2', askerLinkId: 'aaaa1111', targetProvider: 'claude' as const, targetLinkId: 'bbbb2222', text: '在嗎', createdAt: 1, queued: false }])
  expect(await h.invoke(IPC.peerGet)).toEqual({ pending: peer.pendingValue })
  await h.bridge.dispose()
  expect(handlers.has(IPC.peerGet)).toBe(false)
})

it('沒有 peer 時 peer:get 回空清單', async () => {
  const h = makeRig(twoProjects())
  expect(await h.invoke(IPC.peerGet)).toEqual({ pending: [] })
})

it('背景批准路由、跨 slot 快照及了結與關閉清理', async () => {
  const r = makeRig(twoProjects())
  const ask = (requestId: string) => ({ requestId, toolUseId: 't', toolName: 'Bash', input: {} })
  r.fake('tab-a').deps.sink.approvalAsk(ask('a'))
  r.service.update((s) => setActive(s, B, NOW))
  r.fake('tab-b').deps.sink.approvalAsk(ask('b'))
  expect(await r.invoke(IPC.approvalsGet)).toEqual([
    { ...ask('a'), projectId: A, conversationId: 'tab-a' },
    { ...ask('b'), projectId: B, conversationId: 'tab-b' },
  ])
  r.fire(IPC.approvalReply, { requestId: 'a', decision: 'allow' })
  expect(r.log.at(-1)).toBe('tab-a.approvalReply(a,allow)')
  r.fake('tab-a').deps.sink.approvalSettled('a')
  r.fire(IPC.approvalReply, { requestId: 'a', decision: 'deny' })
  expect(r.errors.at(-1)).toContain('找不到 requestId a')
  r.service.update((s) => removeProject(s, B))
  expect(await r.invoke(IPC.approvalsGet)).toEqual([])
  r.fire(IPC.approvalReply, { requestId: 'b', decision: 'allow' })
  expect(r.errors.at(-1)).toContain('找不到 requestId b')
  await r.bridge.dispose()
  expect(handlers.has(IPC.approvalsGet)).toBe(false)
})

it('開歷史時取消該對話未決問答', () => {
  const peer = fakePeerService()
  const ended = vi.spyOn(peer.service, 'conversationEnded')
  const r = makeRig(twoProjects(), { peer: peer.service })
  r.fire(IPC.intentOpenHistory, { sessionId: 's-1' })
  expect(ended).toHaveBeenCalledWith('tab-a')
  expect(r.log.at(-1)).toBe('tab-a.openHistory(s-1)')
})


it('任何對話忙碌的布林值只在首次推送與變更時通知', () => {
  let changes: readonly boolean[] = []
  const rig = makeRig(twoProjects(), {
    onAnyBusyChange: (busy) => { changes = [...changes, busy] },
  })
  expect(changes).toEqual([false])
  // 建出另一專案的核心,確認背景對話也算在整體忙碌狀態內。
  rig.service.update((s) => setActive(s, B, NOW + 1))
  expect(changes).toEqual([false])
  rig.fake('tab-a').setBusy(true)
  expect(changes).toEqual([false, true])
  rig.fake('tab-b').setBusy(true)
  expect(changes).toEqual([false, true])
  rig.fake('tab-a').setBusy(false)
  expect(changes).toEqual([false, true])
  rig.fake('tab-b').setBusy(false)
  expect(changes).toEqual([false, true, false])
})

describe('live 花費持久化', () => {
  it('背景回呼寫入指定 session,無花費時不更新', () => {
    const rig = makeRig(twoProjects())
    const d = rig.fake('tab-a').deps
    d.onSessionStarted?.('s-old')
    d.onSessionStarted?.('s-new')
    rig.focus('tab-b')
    d.onSessionEnded?.('s-old', { kind: 'session-end', isError: false, costUsd: 0, numTurns: 3 })
    expect(sessionCostOf(rig.service.state(), 's-old')).toEqual({ usd: 0, turns: 3 })
    expect(sessionCostOf(rig.service.state(), 's-new')).toBeUndefined()
    const before = rig.service.state()
    d.onSessionEnded?.('s-old', { kind: 'session-end', isError: false })
    expect(rig.service.state()).toBe(before)
  })

  it('codex 結束的 tokens 同樣保存', () => {
    const rig = makeRig(twoProjects())
    rig.codexTags.set('/private/tmp/alpha', 'tab-ax')
    rig.service.update((s) => openConversationTab(s, A, { tabId: 'tab-ax', threadId: 'th-ax', provider: 'codex' }, NOW + 1))
    const d = rig.codexDeps.get('tab-ax')
    expect(d).toBeDefined()
    d?.onSessionStarted?.('cx')
    d?.onSessionEnded?.('cx', { kind: 'session-end', isError: false, tokens: 123 })
    expect(sessionCostOf(rig.service.state(), 'cx')).toEqual({ tokens: 123 })
  })
})


it('bridge 歷史載入即時查回狀態 cost', async () => {
  const rig = makeRig(twoProjects(), {
    sessions: createSessionStore({ listSessions: async () => [], getSessionMessages: async () => [] }),
  })
  const d = rig.fake('tab-a').deps
  d.onSessionStarted?.('s1')
  d.onSessionEnded?.('s1', { kind: 'session-end', isError: false, costUsd: 0.12, numTurns: 3 })
  expect(await d.loadHistory('s1')).toEqual([{ kind: 'session-end', isError: false, costUsd: 0.12, numTurns: 3 }])
  expect(await d.loadHistory('unknown')).toEqual([{ kind: 'session-end', isError: false }])
})

it('投遞目標已移除而無法建立核心時拋錯，讓同伴服務取消提問', async () => {
  const peer = fakePeerService()
  const h = makeRig(setActive(twoProjects(), A, NOW), { peer: peer.service })
  const target = peer.entries.get('tab-b')
  if (target === undefined) throw new Error('測試缺少背景同伴')
  h.service.update((state) => removeProject(state, B))
  expect(() => target.deliver('失效的提問')).toThrow('找不到對話核心 tab-b')
  expect(h.created).toEqual(['tab-a'])
  await h.bridge.dispose()
})

it('codex 清單依專案分流,全部專案不帶 cwd,失敗向上傳遞', async () => {
  const list = vi.fn(async (_cwd?: string) => SESSIONS)
  const claudeList = vi.fn(async () => [])
  const rig = makeRig(twoProjects(), {
    codexCatalog: { list, items: async () => [] },
    sessions: { list: claudeList, loadHistory: async () => [], cwdOf: () => undefined },
  })
  await expect(rig.invoke(IPC.sessionList, { projectId: A, provider: 'codex' })).resolves.toEqual(SESSIONS)
  expect(list).toHaveBeenLastCalledWith('/private/tmp/alpha')
  await rig.invoke(IPC.sessionList, { projectId: null, provider: 'codex' })
  expect(list).toHaveBeenLastCalledWith()
  await expect(rig.invoke(IPC.sessionList, { projectId: 'missing', provider: 'codex' })).resolves.toEqual([])
  expect(list).toHaveBeenCalledTimes(2)
  expect(claudeList).not.toHaveBeenCalled()
  list.mockRejectedValueOnce(new Error('catalog 壞了'))
  await expect(rig.invoke(IPC.sessionList, { projectId: A, provider: 'codex' })).rejects.toThrow('catalog 壞了')
})

it('busySince 只帶 busy 且有時間戳的分頁，停止後移除', () => {
  const rig = makeRig(openConversationTab(twoProjects(), A, { tabId: 'tab-a2', threadId: 'th-a2' }, NOW + 1))
  rig.service.update((state) => focusTab(state, A, 'tab-a', NOW + 2))
  expect(rig.view().projects.find((project) => project.id === A)?.busySince).toEqual({})
  rig.fake('tab-a').setBusy(true)
  expect(rig.view().projects.find((project) => project.id === A)?.busySince).toEqual({ 'tab-a': 123 })
  const missingTimestamp = vi.spyOn(rig.fake('tab-a2').core, 'busyStartedAt').mockReturnValue(null)
  rig.fake('tab-a2').setBusy(true)
  expect(rig.view().projects.find((project) => project.id === A)?.busySince).toEqual({ 'tab-a': 123 })
  expect(rig.view().projects.find((project) => project.id === A)?.busyTabIds).toEqual(['tab-a', 'tab-a2'])
  missingTimestamp.mockRestore()
  rig.fake('tab-a').setBusy(false)
  expect(rig.view().projects.find((project) => project.id === A)?.busySince).toEqual({ 'tab-a2': 123 })
})

it('producingTabIds 只含 busy 且已產出的分頁，產出通知立即更新', () => {
  const rig = makeRig(openConversationTab(twoProjects(), A, { tabId: 'tab-a2', threadId: 'th-a2' }, NOW + 1))
  rig.service.update((state) => focusTab(state, A, 'tab-a', NOW + 2))
  const producing = () => rig.view().projects.find((project) => project.id === A)?.producingTabIds
  expect(producing()).toEqual([])
  rig.fake('tab-a').setBusy(true)
  expect(producing()).toEqual([])
  vi.spyOn(rig.fake('tab-a').core, 'turnProduced').mockReturnValue(true)
  vi.spyOn(rig.fake('tab-a2').core, 'turnProduced').mockReturnValue(true)
  rig.fake('tab-a').deps.onTurnProduced?.()
  expect(producing()).toEqual(['tab-a'])
  rig.fake('tab-a2').setBusy(true)
  expect(producing()).toEqual(['tab-a', 'tab-a2'])
  rig.fake('tab-a').setBusy(false)
  expect(producing()).toEqual(['tab-a2'])
})

describe('worktree 對話工作目錄', () => {
  const worktreePath = '/private/tmp/alpha-worktrees/fix-tabs'
  const optionsFor = (cwd: string): SessionOptions => ({
    cwd, permissionMode: 'default', includePartialMessages: true, settingSources: ['project', 'local'],
  })

  it.each(['claude', 'codex', 'grok'] as const)('%s 的 cwd 與 runtime 範圍使用 worktree，舊分頁回退根目錄', async (provider) => {
    const runtimeFor = vi.fn((_projectId: string, rootPath: string, _conversationId: string, _provider: string) => ({
      sessionOptions: () => optionsFor(rootPath),
    }))
    const claude = vi.fn((deps: ConversationDeps) => makeFakeCore('claude', deps, () => {}, false).core)
    const codex = vi.fn((deps: CodexConversationDeps) => makeFakeCore('codex', {
      sink: deps.sink, logError: deps.logError, loadHistory: async () => [],
      sessionOptions: () => optionsFor(deps.cwd),
    }, () => {}, false).core)
    const grok = vi.fn((deps: GrokConversationDeps) => makeFakeCore('grok', {
      sink: deps.sink, logError: deps.logError, loadHistory: async () => [],
      sessionOptions: () => optionsFor(deps.cwd),
    }, () => {}, false).core)
    const items = vi.fn(async () => [])
    const state = openConversationTab(twoProjects(), A, {
      tabId: 'worktree-tab', threadId: 'worktree-thread', provider, worktreePath,
    }, NOW + 1)
    const rig = makeRig(state, {
      runtimeFor, createConversation: claude, createCodexConversation: codex, createGrokConversation: grok,
      codexCatalog: { list: async () => [], items },
    })
    expect(runtimeFor.mock.calls[0]).toEqual([A, worktreePath, 'worktree-tab', provider])
    if (provider === 'claude') {
      expect(claude.mock.calls[0]?.[0].sessionOptions().cwd).toBe(worktreePath)
    } else if (provider === 'codex') {
      expect(codex.mock.calls[0]?.[0].cwd).toBe(worktreePath)
      await codex.mock.calls[0]?.[0].loadHistory('history-id')
      expect(items).toHaveBeenCalledWith(worktreePath, 'history-id')
    } else {
      expect(grok.mock.calls[0]?.[0].cwd).toBe(worktreePath)
    }
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    expect(runtimeFor).toHaveBeenLastCalledWith(A, '/private/tmp/alpha', 'tab-a', 'claude')
    expect(claude.mock.calls.at(-1)?.[0].sessionOptions().cwd).toBe('/private/tmp/alpha')
    await rig.bridge.dispose()

    const legacy = { ...twoProjects(), projects: twoProjects().projects.map((p) => ({
      ...p, tabs: p.tabs.map((tab) => ({ ...tab, provider })),
    })) }
    const legacyRig = makeRig(legacy, {
      runtimeFor, createConversation: claude, createCodexConversation: codex, createGrokConversation: grok,
    })
    expect(runtimeFor).toHaveBeenLastCalledWith(A, '/private/tmp/alpha', 'tab-a', provider)
    if (provider === 'codex') expect(codex.mock.calls.at(-1)?.[0].cwd).toBe('/private/tmp/alpha')
    if (provider === 'grok') expect(grok.mock.calls.at(-1)?.[0].cwd).toBe('/private/tmp/alpha')
    await legacyRig.bridge.dispose()
  })

  it('瀏覽器的檔案範圍跟著擁有它的對話分頁本身，不是前景；終端分頁沒有自己的範圍', () => {
    const first = openConversationTab(twoProjects(), A, {
      tabId: 'worktree-tab', threadId: 'worktree-thread', worktreePath,
    }, NOW + 1)
    const secondPath = '/private/tmp/alpha-worktrees/other'
    const second = openConversationTab(first, A, {
      tabId: 'other-tab', threadId: 'other-thread', worktreePath: secondPath,
    }, NOW + 2)
    // 前景切換不影響:兩個對話分頁各自的範圍同時都算得到，不必先 focusTab。
    expect(conversationDir(second, 'worktree-tab')).toBe(worktreePath)
    expect(conversationDir(second, 'other-tab')).toBe(secondPath)
    expect(checkNavigateUrl(`file://${secondPath}/index.html`, conversationDir(second, 'other-tab')!).kind).toBe('ok')
    expect(checkNavigateUrl(`file://${worktreePath}/index.html`, conversationDir(second, 'other-tab')!).kind).toBe('outside-project')
    expect(checkNavigateUrl('file:///private/tmp/alpha/index.html', conversationDir(second, 'other-tab')!).kind).toBe('outside-project')
    // 沒有 worktreePath 的舊分頁回退專案 rootPath；換到別的專案也各自算得到。
    expect(conversationDir(second, 'tab-a')).toBe('/private/tmp/alpha')
    expect(conversationDir(second, 'tab-b')).toBe('/p/beta')
  })

  it('找不到分頁所屬的專案就回 undefined', () => {
    for (const state of [EMPTY_PROJECTS_STATE, { ...EMPTY_PROJECTS_STATE, activeId: 'missing' }]) {
      expect(conversationDir(state, 'missing-tab')).toBeUndefined()
    }
  })
})


it('專案 view 直接讀 Git 快取，既有推播帶上關閉後的錯誤訊息', async () => {
  const initial = twoProjects()
  const state = { ...initial, projects: initial.projects.map((p) => ({ ...p, isGitRepo: p.id === A })) }
  const rig = makeRig(state)
  const message = 'worktree 還有未提交的改動,留在 /repo/.worktrees/task,請自己處理'
  rig.service.reportError(message)
  expect(parseProjectsView(rig.view())?.error).toBe(message)
  expect(rig.view().projects.map((p) => p.isGitRepo)).toEqual([true, false])
  await rig.invoke(IPC.projectsGet)
  expect(rig.view().projects.map((p) => p.isGitRepo)).toEqual([true, false])
  expect(rig.service.state()).not.toHaveProperty('error')
  await rig.bridge.dispose()
})

it('關閉 worktree 等 core 完成收尾才執行 git', async () => {
  let release: () => void = () => { throw new Error('尚未初始化') }
  const pending = new Promise<void>((resolve) => { release = resolve })
  const initial = openConversationTab(twoProjects(), A, {
    tabId: 'closing', threadId: 'closing-thread', worktreePath: '/worktree',
  }, NOW)
  const rig = makeRig(initial)
  rig.focus('closing')
  rig.fake('closing').setBusy(true)
  const dispose = vi.spyOn(rig.fake('closing').core, 'dispose').mockReturnValue(pending)
  const run = vi.fn<WorktreeDeps['run']>(async () => ({ ok: true, out: '' }))
  const unregister = registerProjectsIpc({
    service: rig.service,
    disposeConversation: (id) => rig.bridge.disposeConversation(id),
    worktree: { run, readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, copyFile: async () => {}, rm: async () => {}, logError: () => {} },
    locks: createMergeLocks(),
    pickFolder: async () => undefined, validateRoot: () => undefined, logError: () => {},
  })
  const handler = listeners.get(IPC.tabsClose)
  if (handler === undefined) throw new Error('缺少關閉處理器')
  const closing = handler({}, { projectId: A, tabId: 'closing' })
  await tick()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(run).not.toHaveBeenCalled()
  expect(findProject(rig.service.state(), A)?.tabs.some((tab) => tab.id === 'closing')).toBe(false)
  release()
  await closing
  expect(run.mock.calls).toEqual([
    [['-C', '/worktree', 'status', '--porcelain', '-uall', '--ignored'], '/private/tmp/alpha'],
    [['-C', '/worktree', 'symbolic-ref', '--short', 'HEAD'], '/private/tmp/alpha'],
    [['worktree', 'remove', '/worktree'], '/private/tmp/alpha'],
  ])
  unregister()
  await rig.bridge.dispose()
})

it('背景專案移除不等待收尾，且同一收尾可重複等待', async () => {
  let release: () => void = () => { throw new Error('尚未初始化') }
  const pending = new Promise<void>((resolve) => { release = resolve })
  const rig = makeRig(twoProjects())
  rig.focus('tab-a')
  rig.focus('tab-b')
  const dispose = vi.spyOn(rig.fake('tab-a').core, 'dispose').mockReturnValue(pending)
  rig.service.update((state) => removeProject(state, A))
  expect(findProject(rig.service.state(), A)).toBeUndefined()
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(rig.fake('tab-b').core.isActive()).toBe(true)
  const first = rig.bridge.disposeConversation('tab-a')
  const second = rig.bridge.disposeConversation('tab-a')
  release()
  await Promise.all([first, second])
  await rig.bridge.disposeConversation('tab-a')
  expect(dispose).toHaveBeenCalledTimes(1)
  await rig.bridge.dispose()
})

it('重新指定資料夾不受同分頁舊 core 尚未收尾影響', async () => {
  let release: () => void = () => { throw new Error('尚未初始化') }
  const pending = new Promise<void>((resolve) => { release = resolve })
  const rig = makeRig(twoProjects())
  rig.focus('tab-a')
  const oldDispose = vi.spyOn(rig.fake('tab-a').core, 'dispose').mockReturnValue(pending)
  rig.service.update((state) => relocateProject(state, A, '/first'))
  const nextDispose = vi.spyOn(rig.fake('tab-a').core, 'dispose')
  rig.service.update((state) => relocateProject(state, A, '/second'))
  expect(oldDispose).toHaveBeenCalledTimes(1)
  expect(nextDispose).toHaveBeenCalledTimes(1)
  expect(rig.fake('tab-a').core.isActive()).toBe(true)
  release()
  await rig.bridge.disposeConversation('tab-a')
  await rig.bridge.dispose()
})

it('整體 dispose 等待已從 slots 移出的收尾與 runtime 清理', async () => {
  let release: () => void = () => { throw new Error('尚未初始化') }
  const pending = new Promise<void>(resolve => { release = resolve })
  const rig = makeRig(twoProjects())
  const coreDispose = vi.spyOn(rig.fake('tab-a').core, 'dispose').mockReturnValue(pending)
  rig.service.update(state => removeProject(state, A))
  let finished = false
  const disposing = rig.bridge.dispose().then(() => { finished = true })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(finished).toBe(false)
  expect(rig.log).not.toContain('tab-a.runtime.dispose')
  release()
  await disposing
  expect(finished).toBe(true)
  expect(coreDispose).toHaveBeenCalledTimes(1)
  expect(rig.log).toContain('tab-a.runtime.dispose')
})

it('projects:state 的對話分頁帶有效的 lastUrl:專案層級的舊值只給 sortOrder 最小的那個', () => {
  const base = twoProjects()
  const rig = makeRig({ ...base, projects: base.projects.map((p) => (p.id === A ? { ...p, lastUrl: 'https://old.test/' } : p)) })
  const tabs = rig.view().projects.find((p) => p.id === A)?.tabs.filter((t) => t.contentType === 'conversation') ?? []
  expect(tabs[0]?.lastUrl).toBe('https://old.test/')
  expect(tabs.slice(1).every((t) => t.lastUrl === null)).toBe(true)
})

describe('對話工具的訊息路由', () => {
  it('等 diff 基準時切換分頁，仍送給原對話；外部 sender 不可使用', async () => {
    let finish!: () => void
    const capture = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const rig = makeRig(twoProjects(), {
      attachments: { pick: async () => [], prepare: () => [], sent: () => {}, remove: async () => {} },
      developmentDiff: { repositories: async () => ({ kind: 'repositories', repositories: [], warnings: [] }), capture, read: async () => { throw Error('unused') } },
    })
    const pending = rig.invoke(CONVERSATION_TOOLS_CHANNEL, { action: 'send', conversationId: 'tab-a', text: 'hello', attachments: [] })
    await tick(); rig.focus('tab-b'); finish()
    expect(await pending).toEqual({ kind: 'sent' })
    expect(rig.log).toContain('tab-a.userInput(hello)')
    expect(rig.log).not.toContain('tab-b.userInput(hello)')
    const handler = handlers.get(CONVERSATION_TOOLS_CHANNEL)!
    expect(await handler({ sender: {} }, { action: 'pick', conversationId: 'tab-a' })).toMatchObject({ kind: 'error' })
  })
  it('建立基準途中改開新 session，拒絕送出而不把訊息送進新對話', async () => {
    let finish!: () => void
    const rig = makeRig(twoProjects(), {
      attachments: { pick: async () => [], prepare: () => [], sent: () => {}, remove: async () => {} },
      developmentDiff: { repositories: async () => ({ kind: 'repositories', repositories: [], warnings: [] }), capture: () => new Promise<void>(resolve => { finish = resolve }), read: async () => { throw Error('unused') } },
    })
    const pending = rig.invoke(CONVERSATION_TOOLS_CHANNEL, { action: 'send', conversationId: 'tab-a', text: 'old draft', attachments: [] })
    await tick(); rig.fire(IPC.intentStartNew); finish()
    expect(await pending).toMatchObject({ kind: 'error' })
    expect(rig.log).not.toContain('tab-a.userInput(old draft)')
  })
})

it('repo 清單只使用目前 session 及其 live 寫檔證據，不讀其他歷史對話', async () => {
  const repositories = vi.fn(async () => ({ kind: 'repositories' as const, repositories: [], warnings: [] }))
  const loadClaudeActivity = vi.fn(async () => ({ groups: [[{ kind: 'tool-use' as const, id: 'w', name: 'Write', input: { file_path: '/private/tmp/alpha/child/x' } }, { kind: 'tool-result' as const, id: 'w', isError: false, content: 'ok' }]], warnings: [] }))
  const rig = makeRig(twoProjects(), { loadClaudeActivity, developmentDiff: { repositories, capture: async () => {}, read: async () => { throw Error('unused') } } })
  vi.spyOn(rig.fake('tab-a').core, 'sessionState').mockReturnValue({ kind: 'viewing', sessionId: 'current' })
  await rig.invoke(CONVERSATION_TOOLS_CHANNEL, { action: 'repositories', conversationId: 'tab-a' })
  expect(loadClaudeActivity).toHaveBeenCalledExactlyOnceWith('current')
  expect(repositories).toHaveBeenCalledWith('/private/tmp/alpha', ['/private/tmp/alpha/child/x'])
})
it('等待工具歷史時切換 session，舊寫檔紀錄不能套到新對話', async () => {
  let finish!: (value: { groups: never[]; warnings: string[] }) => void
  const repositories = vi.fn(async () => ({ kind: 'repositories' as const, repositories: [], warnings: [] }))
  const rig = makeRig(twoProjects(), { loadClaudeActivity: () => new Promise(resolve => { finish = resolve }), developmentDiff: { repositories, capture: async () => {}, read: async () => { throw Error('unused') } } })
  const state = vi.spyOn(rig.fake('tab-a').core, 'sessionState').mockReturnValue({ kind: 'viewing', sessionId: 'old' })
  const pending = rig.invoke(CONVERSATION_TOOLS_CHANNEL, { action: 'repositories', conversationId: 'tab-a' })
  state.mockReturnValue({ kind: 'viewing', sessionId: 'new' }); finish({ groups: [], warnings: [] })
  expect(await pending).toMatchObject({ kind: 'error' }); expect(repositories).not.toHaveBeenCalled()
})
