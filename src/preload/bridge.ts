import { CHEF_CHANNEL, ChefRequestSchema, ChefResponseSchema } from '../shared/chef.js'
import { CONVERSATION_TOOLS_CHANNEL, ConversationToolsRequestSchema, ConversationToolsResponseSchema } from '../shared/conversation-tools.js'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { PERMISSIONS_CHANNEL, PermissionsRequestSchema, PermissionsResponseSchema } from '../shared/permissions.js'
import { SKILLS_CHANNEL, SkillsRequestSchema, SkillsResponseSchema } from '../shared/skills.js'
import { TEST_MACHINES_CHANNEL, TestMachinesRequestSchema, TestMachinesResponseSchema } from '../shared/test-machines.js'
import { ERROR_INTAKE_CHANNEL, ErrorIntakeRequestSchema, ErrorIntakeResponseSchema } from '../shared/error-intake.js'
import { GROUP_CHANNEL, GroupRequestSchema, GroupResponseSchema, parseGroupMessagesPayload } from '../shared/group.js'
import type { GroupOpenPayload } from '../shared/group.js'
import { WORKTREE_MERGE_CHANNEL, WorktreeMergeRequestSchema, WorktreeMergeResponseSchema } from '../shared/worktree-merge.js'
import { ProjectRunRequestSchema, ProjectRunResponseSchema, parseProjectRunUpdate } from '../shared/project-run.js'
import {
  parseBrowserCommandResult, parseBrowserSessions, parseBrowserSnapshot, parseBrowserState, type BrowserCommand,
} from '../shared/browser-ipc.js'
import {
  IPC,
  type TranslatePayload,
  parseTranslateResult,
  type PreviewReadPayload,
  parsePreviewReadResult,
  type BrowserBoundsPayload,
  parsePeerState,
  parseApprovals,
  parseApprovalAsk,
  parseApprovalSettled,
  parseEventsBatchPayload,
  parseSessionStatePayload,
  parseSessionSummaries,
  type HandoffDonePayload,
  type YesChefApi,
  type TerminalEndpoint,
  type Unsubscribe,
} from '../shared/ipc.js'
import {
  parseAddProjectResult,
  parseProjectsView,
  type ConversationOpenPayload,
  type ProjectIdPayload,
  type SessionListScope,
  type TabOpenPayload,
  type TabTargetPayload,
} from '../shared/projects.js'

/**
 * 這支檔案的鐵律：**任何直接呼叫 `ipcRenderer` 的箭頭函式，函式體一律用大括號。**
 *
 * `ipcRenderer.on()` 與 `ipcRenderer.removeListener()` 為了鏈式呼叫都 `return this`。
 * 簡潔箭頭 `(cb) => ipcRenderer.on(ch, h)` 會把 `ipcRenderer` 本體當成回傳值，而
 * contextBridge 連回傳值一起 proxy，renderer 只要接住 `window.yeschef.onEvents(cb)`
 * 的回傳值，就拿到了完整的 ipcRenderer，可以對任意頻道 send／invoke，context
 * isolation 等於沒有。這是上一個分支的 Critical，成因就是少了一對大括號。
 *
 * 大括號讓函式體變成敘述清單，回傳值只能是我們明寫的東西：unsubscribe 閉包或 Promise。
 */
function subscribe<T>(
  channel: string,
  parse: (raw: unknown) => T | null,
  cb: (value: T) => void
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, raw: unknown): void => {
    const parsed = parse(raw)
    if (parsed === null) {
      // main 也要驗：版本不一致或頻道撞名時，寧可丟一則錯誤也不要把壞資料交給 React。
      console.error(`[yeschef] ${channel} 收到形狀不符的 payload，已丟棄`, raw)
      return
    }
    cb(parsed)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * invoke 的回傳一律過 parser。main 與 preload 是同一個 build 出來的，形狀不符只會發生在
 * 頻道撞名或版本錯置，這時拋錯讓呼叫端顯示錯誤，比把壞資料交給 React 好。
 */
async function invokeParsed<T>(
  channel: string,
  payload: unknown,
  parse: (raw: unknown) => T | null,
  failure: string
): Promise<T> {
  const raw: unknown = await ipcRenderer.invoke(channel, payload)
  const parsed = parse(raw)
  if (parsed === null) throw new Error(failure)
  return parsed
}

const api: YesChefApi = {
  manageChef: payload => {
    return invokeParsed(CHEF_CHANNEL, ChefRequestSchema.parse(payload), raw => {
      const result = ChefResponseSchema.safeParse(raw); return result.success ? result.data : null
    }, '主廚回傳格式不正確')
  },
  conversationTools: payload => {
    return invokeParsed(CONVERSATION_TOOLS_CHANNEL, ConversationToolsRequestSchema.parse(payload), raw => {
      const result = ConversationToolsResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '對話工具回傳格式不正確')
  },
  managePermissions: (payload) => {
    return invokeParsed(PERMISSIONS_CHANNEL, PermissionsRequestSchema.parse(payload), raw => {
      const result = PermissionsResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '授權設定回傳格式不正確')
  },
  manageSkills: (payload) => {
    const clean = SkillsRequestSchema.parse(payload)
    return invokeParsed(SKILLS_CHANNEL, clean, raw => {
      const result = SkillsResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, 'Skills 回傳格式不正確')
  },
  manageTestMachines: (payload) => {
    return invokeParsed(TEST_MACHINES_CHANNEL, TestMachinesRequestSchema.parse(payload), (raw) => {
      const result = TestMachinesResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '測試機設定回傳格式不正確')
  },
  manageErrorIntake: (payload) => {
    return invokeParsed(ERROR_INTAKE_CHANNEL, ErrorIntakeRequestSchema.parse(payload), (raw) => {
      const result = ErrorIntakeResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '錯誤收集資料庫設定回傳格式不正確')
  },
  manageGroup: (payload) => {
    return invokeParsed(GROUP_CHANNEL, GroupRequestSchema.parse(payload), (raw) => {
      const result = GroupResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '群組回傳格式不正確')
  },
  manageProjectRun: payload => invokeParsed(IPC.projectRun, ProjectRunRequestSchema.parse(payload), raw => {
    const result = ProjectRunResponseSchema.safeParse(raw)
    return result.success ? result.data : null
  }, '專案執行回傳格式不正確'),
  onProjectRunUpdate: cb => subscribe(IPC.projectRunUpdate, parseProjectRunUpdate, cb),
  onGroupMessages: (cb) => subscribe(IPC.groupMessages, parseGroupMessagesPayload, cb),
  openGroup: (projectId) => {
    ipcRenderer.send(IPC.groupOpen, { projectId } satisfies GroupOpenPayload)
  },
  worktreeMerge: (payload) => {
    return invokeParsed(WORKTREE_MERGE_CHANNEL, WorktreeMergeRequestSchema.parse(payload), (raw) => {
      const result = WorktreeMergeResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '合併回傳格式不正確')
  },
  translate: (payload) =>
    invokeParsed(
      IPC.translateRun,
      { text: payload.text, target: payload.target } satisfies TranslatePayload,
      parseTranslateResult,
      'translate:run 回傳的形狀不符'
    ),

  readPreview: (payload) =>
    invokeParsed(
      IPC.previewRead,
      { projectId: payload.projectId, path: payload.path } satisfies PreviewReadPayload,
      parsePreviewReadResult,
      'preview:read 回傳的形狀不符'
    ),

  setBrowserBounds: (rect) => {
    const clean: BrowserBoundsPayload =
      rect === null ? { rect: null } : { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    ipcRenderer.send(IPC.browserBounds, clean)
  },
  browserCommand: (command) => {
    // 只把已知欄位送過去:renderer 物件上多出來的東西不該進主行程。
    const clean: BrowserCommand = command.kind === 'navigate' ? { kind: 'navigate', url: command.url } : { kind: command.kind }
    return invokeParsed(IPC.browserCommand, clean, parseBrowserCommandResult, 'browser:command 回傳的形狀不符')
  },
  getBrowser: () => invokeParsed(IPC.browserGet, undefined, parseBrowserSnapshot, 'browser:get 回傳的形狀不符'),
  onBrowserState: (cb) => subscribe(IPC.browserState, parseBrowserState, cb),
  onBrowserSessions: (cb) => subscribe(IPC.browserSessions, parseBrowserSessions, cb),
  getApprovals: () => invokeParsed(IPC.approvalsGet, undefined, parseApprovals, 'approvals:get 回傳的形狀不符'),
  getPeer: () => invokeParsed(IPC.peerGet, undefined, parsePeerState, 'peer:get 回傳的形狀不符'),
  onPeerState: (cb) => subscribe(IPC.peerState, parsePeerState, cb),
  answerPeerAsUser: (payload) => {
    ipcRenderer.send(IPC.peerAnswer, { questionId: payload.questionId, ...(payload.text === undefined ? {} : { text: payload.text }) })
  },
  cancelPeer: (payload) => {
    ipcRenderer.send(IPC.peerCancel, { questionId: payload.questionId })
  },
  onEvents: (cb) => subscribe(IPC.eventsBatch, parseEventsBatchPayload, cb),
  onApprovalAsk: (cb) => subscribe(IPC.approvalAsk, parseApprovalAsk, cb),
  onApprovalSettled: (cb) => subscribe(IPC.approvalSettled, parseApprovalSettled, cb),
  onSessionState: (cb) => subscribe(IPC.sessionState, parseSessionStatePayload, cb),
  onProjects: (cb) => subscribe(IPC.projectsState, parseProjectsView, cb),

  sendInput: (text) => {
    ipcRenderer.send(IPC.userInput, text)
  },

  replyApproval: (reply) => {
    ipcRenderer.send(IPC.approvalReply, { requestId: reply.requestId, decision: reply.decision })
  },

  listSessions: (scope) =>
    invokeParsed(
      IPC.sessionList,
      { projectId: scope.projectId, ...(scope.provider === undefined ? {} : { provider: scope.provider }) } satisfies SessionListScope,
      parseSessionSummaries,
      'session:list 回傳的形狀不符，無法顯示歷史對話'
    ),

  startNew: () => {
    ipcRenderer.send(IPC.intentStartNew)
  },

  openHistory: (sessionId) => {
    ipcRenderer.send(IPC.intentOpenHistory, { sessionId })
  },

  terminalEndpoint: () => {
    return ipcRenderer.invoke(IPC.terminalEndpoint) as Promise<TerminalEndpoint>
  },

  handoffDone: (toolUseId) => {
    ipcRenderer.send(IPC.handoffDone, { toolUseId } satisfies HandoffDonePayload)
  },

  getProjects: () =>
    invokeParsed(IPC.projectsGet, undefined, parseProjectsView, 'projects:get 回傳的形狀不符，無法顯示專案清單'),

  addProject: () =>
    invokeParsed(IPC.projectsAdd, undefined, parseAddProjectResult, 'projects:add 回傳的形狀不符'),

  relocateProject: (id) =>
    invokeParsed(
      IPC.projectsRelocate,
      { id } satisfies ProjectIdPayload,
      parseAddProjectResult,
      'projects:relocate 回傳的形狀不符'
    ),

  removeProject: (id) => {
    ipcRenderer.send(IPC.projectsRemove, { id } satisfies ProjectIdPayload)
  },

  activateProject: (id) => {
    ipcRenderer.send(IPC.projectsActivate, { id } satisfies ProjectIdPayload)
  },

  // payload 逐欄重組而不是原物件轉送：跟 replyApproval 一樣，只送我們認得的欄位。
  openTab: (payload) => {
    const clean: TabOpenPayload =
      payload.command === undefined
        ? { projectId: payload.projectId, label: payload.label }
        : { projectId: payload.projectId, label: payload.label, command: payload.command }
    ipcRenderer.send(IPC.tabsOpen, clean)
  },

  closeTab: (payload) => {
    ipcRenderer.send(IPC.tabsClose, { projectId: payload.projectId, tabId: payload.tabId } satisfies TabTargetPayload)
  },

  activateTab: (payload) => {
    ipcRenderer.send(IPC.tabsActivate, { projectId: payload.projectId, tabId: payload.tabId } satisfies TabTargetPayload)
  },
  openConversation: (projectId, provider, worktreeName) => {
    ipcRenderer.send(IPC.conversationsOpen, { projectId, provider, ...(worktreeName === undefined ? {} : { worktreeName }) } satisfies ConversationOpenPayload)
  },
}

contextBridge.exposeInMainWorld('yeschef', api)
