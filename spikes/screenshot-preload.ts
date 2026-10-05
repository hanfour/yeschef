/** 截圖用的 window.yeschef：每個方法回固定值，訂閱後立刻推 ui-fixture 的資料。不碰真的 IPC。 */
import { contextBridge } from 'electron'
import type { YesChefApi } from '../src/shared/ipc.js'
import type { GroupMessage, GroupMessagesPayload, GroupThread } from '../src/shared/group.js'
import type { ProjectRunUpdate } from '../src/shared/project-run.js'
import { ASK, BROWSER_SESSIONS, BROWSER_STATE, EVENTS, PROJECTS, SESSION_STATE, SESSIONS, CONVERSATION } from './fixtures/ui-fixture.js'

const later = (fn: () => void): void => { setTimeout(fn, 0) }
const unsubscribe = (): void => {}
const GROUP_TAB_ID = 'fixture-group'
const GROUP_NOW = Date.now()
const LONG_GROUP_PATH = `/private/tmp/yeschef-group/${'550e8400-e29b-41d4-a716-446655440000/'.repeat(7)}${'0123456789abcdef'.repeat(8)}`
const LONG_GROUP_TARGET = `長目標文字，用來確認 thread 膠囊不會撐寬中間欄位 ${LONG_GROUP_PATH} 請保留完整目標供 title 提示查看。`
const GROUP_THREADS: GroupThread[] = [
  { id: 'general', title: '未分派', status: 'open', createdAt: 0, holdsWorkspace: false, participants: [] },
  {
    id: 'task-login', title: '登入流程驗收', status: 'running', createdAt: GROUP_NOW - 60_000, holdsWorkspace: true,
    participants: [
      { label: '主廚', conversationId: 'fixture-conv-1', provider: 'claude', role: 'chef', unitTitle: '登入流程驗收' },
      { label: 'codex-1', conversationId: 'fixture-conv-2', provider: 'codex', role: 'worker', unitTitle: '檢查表單' },
      { label: 'grok-1', conversationId: 'fixture-grok-1', provider: 'grok', role: 'worker', unitTitle: '驗證流程' },
    ],
  },
  {
    id: 'task-long', title: LONG_GROUP_TARGET, status: 'running', createdAt: GROUP_NOW - 20_000, holdsWorkspace: true,
    participants: [{ label: '主廚', conversationId: 'fixture-conv-1', provider: 'claude', role: 'chef', unitTitle: LONG_GROUP_TARGET }],
  },
]
const GROUP_MESSAGES: GroupMessage[] = [
  { id: 'group-m1', projectId: 'p1', threadId: 'general', at: GROUP_NOW - 55_000, from: { kind: 'user' }, kind: 'text', text: '請幫我確認登入流程是否完整。', mentions: [] },
  { id: 'group-m2', projectId: 'p1', threadId: 'general', at: GROUP_NOW - 50_000, from: { kind: 'agent', conversationId: 'fixture-conv-1', label: '主廚', provider: 'claude', role: 'chef' }, kind: 'text', text: '收到，我會分派檢查表單與驗證流程。', mentions: [] },
  { id: 'group-m3', projectId: 'p1', threadId: 'general', at: GROUP_NOW - 45_000, from: { kind: 'system' }, kind: 'goal', text: '已建立「登入流程驗收」目標。', mentions: [] },
  { id: 'group-m4', projectId: 'p1', threadId: 'task-login', at: GROUP_NOW - 40_000, from: { kind: 'system' }, kind: 'delegated', text: '主廚把「檢查表單」交給 codex 的工作者', mentions: [] },
  { id: 'group-m5', projectId: 'p1', threadId: 'task-login', at: GROUP_NOW - 35_000, from: { kind: 'agent', conversationId: 'fixture-conv-2', label: 'codex-1', provider: 'codex', role: 'worker' }, kind: 'joined', text: 'codex-1 加入，負責「檢查表單」，用 gpt-5', mentions: [] },
  { id: 'group-m6', projectId: 'p1', threadId: 'task-login', at: GROUP_NOW - 30_000, from: { kind: 'agent', conversationId: 'fixture-grok-1', label: 'grok-1', provider: 'grok', role: 'worker' }, kind: 'progress', text: 'grok-1 完成「驗證流程」', mentions: [], unitId: 'unit-verify' },
  { id: 'group-m7', projectId: 'p1', threadId: 'task-long', at: GROUP_NOW - 10_000, from: { kind: 'user' }, kind: 'text', text: LONG_GROUP_TARGET, mentions: [] },
]
let fixtureProjects = {
  ...PROJECTS,
  projects: PROJECTS.projects.map((project) => project.tabs.some((tab) => tab.contentType === 'group')
    ? project
    : { ...project, tabs: [{ id: GROUP_TAB_ID, contentType: 'group' as const, label: '群組', customLabel: null, sortOrder: -1, lastFocusedAt: 0 }, ...project.tabs] }),
}
const projectListeners = new Set<(projects: typeof PROJECTS) => void>()
const groupListeners = new Set<(payload: GroupMessagesPayload) => void>()
const projectRunListeners = new Set<(payload: ProjectRunUpdate) => void>()

function addGroupTab(projectId: string): void {
  fixtureProjects = {
    ...fixtureProjects,
    projects: fixtureProjects.projects.map((project) => {
      if (project.id !== projectId) return project
      const tabs = project.tabs.some((tab) => tab.id === GROUP_TAB_ID)
        ? project.tabs
        : [...project.tabs, { id: GROUP_TAB_ID, contentType: 'group' as const, label: '群組', customLabel: null, sortOrder: project.tabs.length, lastFocusedAt: GROUP_NOW }]
      return { ...project, activeTabId: GROUP_TAB_ID, tabs }
    }),
  }
  for (const listener of projectListeners) listener(fixtureProjects)
}

function activateFixtureTab(projectId: string, tabId: string): void {
  fixtureProjects = {
    ...fixtureProjects,
    projects: fixtureProjects.projects.map((project) => project.id === projectId ? { ...project, activeTabId: tabId } : project),
  }
  for (const listener of projectListeners) listener(fixtureProjects)
}

const api: YesChefApi = {
  // 對話框開得起來的查詢類：每個回一個 kind: 'state' 的空狀態
  manageChef: async () => ({ kind: 'state', state: {
    tasks: [],
    models: [{ key: 'codex:gpt-6-sol', provider: 'codex', model: 'gpt-6-sol', label: 'gpt-6-sol', description: '', recommended: true }],
    unavailableModels: [{ key: 'codex:gpt-6-sol', expiresAt: Date.now() + 24 * 60 * 60_000 }],
    notices: [],
  } }),
  conversationTools: async (request) => {
    if (request.action === 'send') return { kind: 'sent' }
    return { kind: 'error', message: '測試未設定對話工具' }
  },
  managePermissions: async () => ({ kind: 'state', state: { revision: 0, paused: false, policies: [] }, audit: [] }),
  manageSkills: async () => ({ kind: 'state', state: { revision: null, skills: [] } }),
  manageTestMachines: async () => ({
    kind: 'state',
    revision: 1,
    machines: [{ id: 'm1', name: 'staging', url: 'https://staging.example.com/login', username: 'qa', hasPassword: true, passwordNeedsReentry: false }],
  }),
  manageErrorIntake: async () => ({ kind: 'settings', settings: { host: '', port: 3306, database: '', tls: true, adminUsername: '', hasAdminPassword: false, hasAppPassword: false, schemaVersion: null, packageSource: '@yeschef/error-intake' } }),
  manageGroup: async (request) => request.action === 'get'
    ? { kind: 'state', messages: GROUP_MESSAGES, threads: GROUP_THREADS }
    : { kind: 'sent', threadId: request.threadId },
  manageProjectRun: async request => ({
    kind: 'state', candidates: [], snapshot: { projectId: request.projectId, state: 'stopped', restarted: false }, logs: [], logPath: '',
  }),
  onProjectRunUpdate: cb => { projectRunListeners.add(cb); return () => { projectRunListeners.delete(cb) } },
  onGroupMessages: (cb) => {
    groupListeners.add(cb)
    later(() => {
      if (groupListeners.has(cb)) cb({ projectId: 'p1', messages: GROUP_MESSAGES, threads: GROUP_THREADS })
    })
    return () => { groupListeners.delete(cb) }
  },
  openGroup: addGroupTab,
  worktreeMerge: async () => ({ kind: 'error', message: '測試未設定合併' }),
  translate: async () => ({ kind: 'rejected', message: 'fake' }),
  readPreview: async () => ({ kind: 'rejected', message: 'fake' }),
  setBrowserBounds: () => {},
  browserCommand: async () => ({ ok: true }),
  getBrowser: async () => ({ states: [BROWSER_STATE], sessions: [...BROWSER_SESSIONS] }),
  onBrowserState: (cb) => { later(() => cb(BROWSER_STATE)); return unsubscribe },
  onBrowserSessions: (cb) => { later(() => cb(BROWSER_SESSIONS)); return unsubscribe },
  getApprovals: async () => [ASK],
  getPeer: async () => ({ pending: [] }),
  onPeerState: () => unsubscribe,
  answerPeerAsUser: () => {},
  cancelPeer: () => {},
  onEvents: (cb) => { later(() => cb({ conversationId: CONVERSATION, events: EVENTS })); return unsubscribe },
  onApprovalAsk: (cb) => { later(() => cb(ASK)); return unsubscribe },
  onApprovalSettled: () => unsubscribe,
  onSessionState: (cb) => { later(() => cb(SESSION_STATE)); return unsubscribe },
  onProjects: (cb) => {
    projectListeners.add(cb)
    later(() => cb(fixtureProjects))
    return () => { projectListeners.delete(cb) }
  },
  sendInput: () => {},
  replyApproval: () => {},
  listSessions: async () => SESSIONS,
  startNew: () => {},
  openHistory: () => {},
  terminalEndpoint: async () => ({ port: 1, token: 'test-token' }),
  handoffDone: () => {},
  getProjects: async () => fixtureProjects,
  addProject: async () => ({ kind: 'cancelled' }),
  relocateProject: async () => ({ kind: 'cancelled' }),
  removeProject: () => {},
  activateProject: () => {},
  openTab: () => {},
  closeTab: () => {},
  activateTab: ({ projectId, tabId }) => { activateFixtureTab(projectId, tabId) },
  openConversation: () => {},
}

contextBridge.exposeInMainWorld('yeschef', api)
