# 子專案 D:以專案整理工作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 yeschef 從「啟動時固定一個目錄」改成「多個可切換的專案」:切換專案時對話、終端分頁、右窗格檔案範圍一起換,背景專案的對話與終端繼續跑,狀態存到 `<userData>/yeschef-projects.json` 並在重開 app 時還原。

**Architecture:** 主行程持有專案登錄表與每個專案一份對話核心(`conversation.ts`,從現在的 `ipc-bridge.ts` 抽出,不碰 `ipcMain`),`ipc-bridge.ts` 改成路由器:只把 active 專案的事件、狀態、批准請求轉給唯一的 renderer,切換時重播該專案的內容。背景專案的對話用 sleeping session(回合結束後收掉串流,只留 sessionId),背景待批准先扣住不進 30 秒計時的註冊表。分頁清單由主行程持有並持久化,renderer 只送意圖與 id。右窗格維持單一 view,每個專案記 `lastUrl`,瀏覽器工具依專案各建一個 MCP server 實例,背景專案呼叫直接回錯。

**Tech Stack:** Electron 44、React 19、TypeScript 7(`strict`、`noUncheckedIndexedAccess`)、vitest 4(`.tsx` 測試檔首行 `// @vitest-environment jsdom`)、`@testing-library/react`、zod 4.5.4(只在 main 使用)、`@anthropic-ai/claude-agent-sdk` 0.3.258、ws、node-pty 1.1.0、xterm 6。

**Spec:** `docs/specs/2026-09-07-yeschef-projects-design.md`(子專案 D)。thread 與 session 鏈的型別以 `docs/specs/2026-09-08-yeschef-handoff-design.md` §4.1 為準,D 只存放與顯示,不做交接。

## Global Constraints

- 安全(規格 §3.1):renderer 送回主行程的一律是 `projectId`,不送路徑。終端 `open` 的 cwd、右窗格 `checkNavigateUrl` 的範圍都由主行程用 id 查表決定。主行程推給 renderer 的 `ProjectView.rootPath` 只供顯示(tooltip),任何 renderer → main 的 payload 都不得含路徑。
- 終端 `open` 帶未知或缺少的 `projectId`:送 `{ type: 'exit', code: 1 }` 後關連線,不退回任何預設目錄(規格 §6)。
- 背景專案呼叫任何瀏覽器工具:回 `isError` 文字「瀏覽器正由前景專案使用」,不改前景畫面(規格 §3.4)。
- 狀態檔 `<userData>/yeschef-projects.json`:原子寫(先寫 `.tmp` 再 rename),保留 `.bak.0`、`.bak.1` 兩份輪替備份;`schemaVersion` 不認得就當空狀態並保留原檔;損毀依序退到 `.bak.0`、`.bak.1`,都壞就空狀態且不刪原檔(規格 §4.1、§6)。
- 每個專案的 `tabs` 恰有一個 `contentType: 'conversation'` 的分頁,`sortOrder` 最小、不可關閉;關掉 active 的終端分頁後焦點回到對話分頁(規格 §4.1,沿用 C 的 `useTerminals` 規則)。
- sleeping session(規格 §3.3):切走時回合進行中維持 live,回合結束才收串流轉 sleeping;切回來先讀 transcript 顯示,下一則輸入才 resume。
- 背景待批准(規格 §2):不進 `ApprovalRegistry`(它一進去就開 30 秒計時),扣在對話核心裡;該專案在專案列顯示記號;切回去才送 `agent:approval:ask`。
- 覆蓋率門檻沿專案:Stmts ≥ 93、Branch ≥ 86;`src/main/index.ts` 維持排除(`vitest.config.ts` 已設)。
- 所有測試檔放 `tests/`,`.tsx` 測試檔首行 `// @vitest-environment jsdom`。main 端測試用 `vi.mock('electron', …)` 與 `vi.mock('@anthropic-ai/claude-agent-sdk', …)` 替身(見 `tests/ipc-bridge.test.ts` 現有寫法)。
- 資料不就地修改:reducer 一律回新物件;模組私有的緩衝陣列(事件 log、inflight 集合)沿用既有程式碼的做法,允許 `push`/`add`,但不得外流。
- 使用者可見文案用繁體中文台灣用語,與既有文案一致(「分頁」「對話」「專案」「終端機」)。
- 每個 Task 結尾 `git add <明確檔名>` 與 `git commit` 分兩個指令執行,不用 `&&` 串接,不用 `git add -A`/`.`;commit message 格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 執行 `npm run typecheck` 與 `npm test` 都要綠才算完成一個 Task;Task 14 之後跑 `npm run test:coverage` 確認門檻。

---

## 檔案結構

新增:

| 檔案 | 責任 |
|---|---|
| `src/shared/projects.ts` | 專案、分頁、thread、session 鏈的型別;renderer 用的 `ProjectsView`;IPC payload 型別與 parse 函式 |
| `src/shared/event-log.ts` | `appendEvents`(從 `useConversation.ts` 搬出,main 與 renderer 共用) |
| `src/main/projects-schema.ts` | 狀態檔的 zod schema 與 `parseProjectsState` |
| `src/main/projects-store.ts` | 狀態檔讀寫:原子寫、輪替備份、退回備份、不認得的 schemaVersion |
| `src/main/projects-state.ts` | `ProjectsState` 的純 reducer 與 selector(新增/移除/切 active/分頁/lastUrl/thread) |
| `src/main/transcript-path.ts` | `transcriptPathFor(homeDir, cwd, sessionId)` |
| `src/main/projects-service.ts` | 持有現行 `ProjectsState`,套 reducer 後存檔並通知訂閱者;`rootPathOf`、`isAvailable` |
| `src/main/conversation.ts` | 單一專案的對話核心:狀態機、host、批准註冊表、扣住的批准、事件 log、activate/deactivate |
| `src/main/projects-ipc.ts` | `projects:add/relocate/remove/activate` 與 `tabs:open/close/activate` 的 ipcMain 處理 |
| `src/renderer/hooks/useProjects.ts` | 訂閱 `projects:state`,包裝專案與分頁意圖 |
| `src/renderer/components/ProjectBar.tsx` + `.css` | 專案列 |
| `src/renderer/recents-groups.ts` | Recents 依 thread 分組的純函式 |
| `docs/RESULTS-08-projects.md` | 實機驗收與記憶體量測 |

修改:

| 檔案 | 改動 |
|---|---|
| `src/shared/ipc.ts` | `IPC` 加 9 個 channel;`YesChefApi` 加專案與分頁方法、`listSessions` 改帶範圍、移除 `projectDir`;移除 `PROJECT_DIR_ARG` |
| `src/main/session-machine.ts` | 新 action `sleep` |
| `src/main/ipc-bridge.ts` | 改成路由器:每專案一個 `Conversation`,只轉 active 專案;`projects:get`、`projects:state` |
| `src/main/terminal-server.ts` | `open` 必帶 `projectId`,`handleConnection` 改收 `resolveCwd` |
| `src/renderer/terminal-client.ts`、`components/Terminal.tsx` | `open` 帶 `projectId` |
| `src/main/view-tools/{server,startup,controller-types,controller-page,errors}.ts` | `projectDir` 改 `activeProjectDir()`;每專案一個 MCP server 實例與 `abortPending`;`MSG.browserBusy` |
| `src/preload/bridge.ts` | 新增 API,移除 argv 讀取 |
| `src/renderer/App.tsx`、`components/LeftPane.tsx`、`components/Recents.tsx`、`hooks/useSessions.ts`、`hooks/useApprovals.ts`、`hooks/useConversation.ts`、`title.ts` | 專案列、每專案分頁、thread 分組、標題列、切專案清批准 |
| `src/main/index.ts` | 載入狀態檔、建 service、依 `YESCHEF_PROJECT_DIR` 補種子、切換時換右窗格 URL、關閉時存 `openIdsOnShutdown` |
| `docs/specs/2026-09-07-yeschef-c-terminals-design.md` §5 | `open` 協定加必填 `projectId` |

刪除:`src/renderer/hooks/useTerminals.ts`、`tests/use-terminals.test.tsx`(分頁規則改由主行程 reducer 持有並測試)。

---

### Task 1: 共用型別、IPC channel 與 payload 解析

**Files:**
- Create: `src/shared/projects.ts`
- Modify: `src/shared/ipc.ts`
- Test: `tests/projects-shared.test.ts`

**Interfaces:**
- Consumes: `isRecord`、`isNonEmptyString`、`optionalString`(`src/shared/ipc.ts` 既有 helper,目前未 export,本 Task 加 `export`)。
- Produces(後續所有 Task 都用):型別 `ProjectsState`、`ProjectEntry`、`TabEntry`、`ThreadEntry`、`SessionLink`、`SwitchPhase`、`ProjectView`、`ProjectsView`、`TabOpenPayload`、`TabTargetPayload`、`ProjectIdPayload`、`AddProjectResult`、`SessionListScope`;常數 `PROJECTS_SCHEMA_VERSION = 1`、`EMPTY_PROJECTS_STATE`、`CONVERSATION_TAB_LABEL = 'Claude 對話'`;函式 `parseProjectId`、`parseTabOpen`、`parseTabTarget`、`parseSessionListScope`、`parseProjectsView`、`parseAddProjectResult`;`IPC` 新鍵 `projectsGet`、`projectsState`、`projectsAdd`、`projectsRelocate`、`projectsRemove`、`projectsActivate`、`tabsOpen`、`tabsClose`、`tabsActivate`。

- [ ] **Step 1: 寫失敗的測試**

`tests/projects-shared.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  EMPTY_PROJECTS_STATE,
  parseAddProjectResult,
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
      activeTabId: 't-conv',
      tabs: [
        { id: 't-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1' },
        { id: 't2', contentType: 'terminal', label: 'codex', customLabel: null, command: 'codex', sortOrder: 1, lastFocusedAt: 2 },
      ],
      threads: [{ id: 'th1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 1 }],
    },
  ],
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
  it('schemaVersion 1,沒有專案,activeId null', () => {
    expect(EMPTY_PROJECTS_STATE).toEqual({ schemaVersion: 1, projects: [], activeId: null, openIdsOnShutdown: [] })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-shared.test.ts`
Expected: FAIL,`Cannot find module '../src/shared/projects.js'`。

- [ ] **Step 3: 在 `src/shared/ipc.ts` 加 channel、export helper、改 `YesChefApi`**

`IPC` 表在 `handoffDone: 'handoff:done',` 之後加:

```ts
  projectsGet: 'projects:get',
  projectsState: 'projects:state',
  projectsAdd: 'projects:add',
  projectsRelocate: 'projects:relocate',
  projectsRemove: 'projects:remove',
  projectsActivate: 'projects:activate',
  tabsOpen: 'tabs:open',
  tabsClose: 'tabs:close',
  tabsActivate: 'tabs:activate',
```

刪掉 `export const PROJECT_DIR_ARG = '--yeschef-project-dir='` 這一行與它的註解(專案目錄改由 `projects:state` 推送,preload 不再讀 argv;Task 11 改 preload 與測試,Task 14 改 `index.ts`,在那之前 typecheck 會紅,這是預期的,本 Task 只跑 vitest 單檔)。

把 `isRecord`、`isNonEmptyString`、`optionalString` 三個 helper 前面加 `export`。

`YesChefApi` 改成(整段取代原本的介面;`import type` 從 `./projects.js` 取 `AddProjectResult`、`ProjectsView`、`SessionListScope`、`TabOpenPayload`、`TabTargetPayload`):

```ts
export interface YesChefApi {
  onEvents(cb: (batch: readonly Event[]) => void): () => void
  onApprovalAsk(cb: (ask: ApprovalAskPayload) => void): () => void
  onSessionState(cb: (state: SessionState) => void): () => void
  /** 主行程每次專案、分頁、待批准記號變動都會推一份完整的 view。 */
  onProjects(cb: (view: ProjectsView) => void): () => void
  sendInput(text: string): void
  replyApproval(reply: ApprovalReplyPayload): void
  /** `projectId` 為 null 時列全部;否則只列 cwd 等於該專案 rootPath 的 session。 */
  listSessions(scope: SessionListScope): Promise<readonly SessionSummary[]>
  startNew(): void
  openHistory(sessionId: string): void
  terminalEndpoint(): Promise<TerminalEndpoint>
  handoffDone(toolUseId: string): void
  getProjects(): Promise<ProjectsView>
  /** 主行程開資料夾選擇器;取消回 `{ kind: 'cancelled' }`。 */
  addProject(): Promise<AddProjectResult>
  /** 對不可用的專案重新指定資料夾,保留它的分頁與 thread。 */
  relocateProject(id: string): Promise<AddProjectResult>
  removeProject(id: string): void
  activateProject(id: string): void
  openTab(payload: TabOpenPayload): void
  closeTab(payload: TabTargetPayload): void
  activateTab(payload: TabTargetPayload): void
}
```

(移除 `readonly projectDir: string`。)

- [ ] **Step 4: 寫 `src/shared/projects.ts`**

```ts
/**
 * 子專案 D 的共用型別(規格 §4.1)與 thread/session 鏈型別(E 規格 §4.1)。
 * main 與 renderer 都 import,所以不引入 Electron、zod 或 node 內建模組。
 */
import { isNonEmptyString, isRecord } from './ipc.js'

export const PROJECTS_SCHEMA_VERSION = 1
export const CONVERSATION_TAB_LABEL = 'Claude 對話'

export type SwitchPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing'; readonly txId: string; readonly startedAt: number }
  | { readonly kind: 'spawning'; readonly txId: string; readonly handoffVersion: number }
  | { readonly kind: 'receiving'; readonly txId: string; readonly newSessionId: string }

export interface SessionLink {
  readonly sessionId: string
  readonly transcriptPath: string
  readonly parentSessionId: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly endReason: 'handoff' | 'user' | null
}

export interface ThreadEntry {
  readonly id: string
  readonly sessions: readonly SessionLink[]
  readonly handoffVersion: number
  readonly switchPhase: SwitchPhase
  readonly createdAt: number
}

export type TabContentType = 'conversation' | 'terminal'

export interface TabEntry {
  readonly id: string
  readonly contentType: TabContentType
  readonly label: string
  readonly customLabel: string | null
  readonly command?: string
  readonly sortOrder: number
  readonly lastFocusedAt: number
  /** contentType 為 'conversation' 時必填,對應 threads[].id。 */
  readonly threadId?: string
}

export interface ProjectEntry {
  readonly id: string
  readonly rootPath: string
  readonly name: string
  readonly addedAt: number
  readonly lastOpenedAt: number
  readonly tabs: readonly TabEntry[]
  readonly lastUrl: string | null
  readonly threads: readonly ThreadEntry[]
}

export interface ProjectsState {
  readonly schemaVersion: typeof PROJECTS_SCHEMA_VERSION
  readonly projects: readonly ProjectEntry[]
  readonly activeId: string | null
  readonly openIdsOnShutdown: readonly string[]
}

export const EMPTY_PROJECTS_STATE: ProjectsState = {
  schemaVersion: PROJECTS_SCHEMA_VERSION,
  projects: [],
  activeId: null,
  openIdsOnShutdown: [],
}

/** renderer 看到的一個專案。`rootPath` 只供顯示,renderer 送回 main 的一律是 `id`(規格 §3.1)。 */
export interface ProjectView {
  readonly id: string
  readonly name: string
  readonly rootPath: string
  /** 資料夾在磁碟上存在且是目錄。 */
  readonly available: boolean
  /** 該專案在背景時有扣住的批准請求(規格 §2)。 */
  readonly pendingApproval: boolean
  readonly tabs: readonly TabEntry[]
  readonly activeTabId: string
  readonly threads: readonly ThreadEntry[]
}

export interface ProjectsView {
  readonly projects: readonly ProjectView[]
  readonly activeId: string | null
}

export interface ProjectIdPayload {
  readonly id: string
}

export interface TabOpenPayload {
  readonly projectId: string
  readonly label: string
  readonly command?: string
}

export interface TabTargetPayload {
  readonly projectId: string
  readonly tabId: string
}

export interface SessionListScope {
  readonly projectId: string | null
}

export type AddProjectResult =
  | { readonly kind: 'added'; readonly id: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly message: string }

export function parseProjectId(raw: unknown): ProjectIdPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['id'])) return null
  return { id: raw['id'] }
}

export function parseTabOpen(raw: unknown): TabOpenPayload | null {
  if (!isRecord(raw)) return null
  const { projectId, label, command } = raw
  if (!isNonEmptyString(projectId) || !isNonEmptyString(label)) return null
  if (command !== undefined && typeof command !== 'string') return null
  return command === undefined ? { projectId, label } : { projectId, label, command }
}

export function parseTabTarget(raw: unknown): TabTargetPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId']) || !isNonEmptyString(raw['tabId'])) return null
  return { projectId: raw['projectId'], tabId: raw['tabId'] }
}

export function parseSessionListScope(raw: unknown): SessionListScope | null {
  if (!isRecord(raw)) return null
  const id = raw['projectId']
  if (id === null) return { projectId: null }
  return isNonEmptyString(id) ? { projectId: id } : null
}

export function parseAddProjectResult(raw: unknown): AddProjectResult | null {
  if (!isRecord(raw)) return null
  switch (raw['kind']) {
    case 'added':
      return isNonEmptyString(raw['id']) ? { kind: 'added', id: raw['id'] } : null
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'rejected':
      return typeof raw['message'] === 'string' ? { kind: 'rejected', message: raw['message'] } : null
    default:
      return null
  }
}

function isTabEntry(raw: unknown): raw is TabEntry {
  if (!isRecord(raw)) return false
  const type = raw['contentType']
  return (
    isNonEmptyString(raw['id']) &&
    (type === 'conversation' || type === 'terminal') &&
    typeof raw['label'] === 'string' &&
    (raw['customLabel'] === null || typeof raw['customLabel'] === 'string') &&
    (raw['command'] === undefined || typeof raw['command'] === 'string') &&
    typeof raw['sortOrder'] === 'number' &&
    typeof raw['lastFocusedAt'] === 'number' &&
    (raw['threadId'] === undefined || typeof raw['threadId'] === 'string')
  )
}

/** renderer 只用 thread 的 id 與 sessions[].sessionId 分組,其餘欄位原樣帶過(與 parseEventsBatch 同樣的淺層原則)。 */
function isThreadEntry(raw: unknown): raw is ThreadEntry {
  if (!isRecord(raw) || !isNonEmptyString(raw['id']) || !Array.isArray(raw['sessions'])) return false
  return raw['sessions'].every((s: unknown) => isRecord(s) && isNonEmptyString(s['sessionId']))
}

function isProjectView(raw: unknown): raw is ProjectView {
  if (!isRecord(raw)) return false
  return (
    isNonEmptyString(raw['id']) &&
    typeof raw['name'] === 'string' &&
    typeof raw['rootPath'] === 'string' &&
    typeof raw['available'] === 'boolean' &&
    typeof raw['pendingApproval'] === 'boolean' &&
    isNonEmptyString(raw['activeTabId']) &&
    Array.isArray(raw['tabs']) &&
    raw['tabs'].every(isTabEntry) &&
    Array.isArray(raw['threads']) &&
    raw['threads'].every(isThreadEntry)
  )
}

export function parseProjectsView(raw: unknown): ProjectsView | null {
  if (!isRecord(raw)) return null
  const { projects, activeId } = raw
  if (!Array.isArray(projects) || !projects.every(isProjectView)) return null
  if (activeId !== null && !isNonEmptyString(activeId)) return null
  return { projects, activeId }
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/projects-shared.test.ts tests/ipc.test.ts`
Expected: PASS(`tests/ipc.test.ts` 若有引用 `PROJECT_DIR_ARG` 的案例,把那個案例刪掉;它驗的常數已不存在)。

- [ ] **Step 6: Commit**

```bash
git add src/shared/projects.ts src/shared/ipc.ts tests/projects-shared.test.ts tests/ipc.test.ts
git commit -m "feat: 專案功能的共用型別、IPC channel 與 payload 解析"
```

---

### Task 2: 狀態檔 schema 與讀寫(原子寫、輪替備份、退回)

**Files:**
- Create: `src/main/projects-schema.ts`
- Create: `src/main/projects-store.ts`
- Test: `tests/projects-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ProjectsState`、`EMPTY_PROJECTS_STATE`、`PROJECTS_SCHEMA_VERSION`。
- Produces:
  - `parseProjectsState(raw: unknown): ProjectsState | null`、`readSchemaVersion(raw: unknown): number | undefined`(`projects-schema.ts`)。
  - `interface StoreFs { readFile(path): Promise<string>; writeFile(path, data): Promise<void>; rename(from, to): Promise<void>; exists(path): Promise<boolean> }`
  - `interface ProjectsStore { load(): Promise<ProjectsState>; save(state: ProjectsState): Promise<void> }`
  - `createProjectsStore(deps: { filePath: string; fs: StoreFs; logError: (error: Error) => void }): ProjectsStore`
  - `nodeStoreFs: StoreFs`(包 `node:fs/promises`,給 `index.ts` 用)。
  - `backupPaths(filePath): readonly [string, string]`。

- [ ] **Step 1: 寫失敗的測試**

`tests/projects-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createProjectsStore, backupPaths, type StoreFs } from '../src/main/projects-store.js'
import { parseProjectsState, readSchemaVersion } from '../src/main/projects-schema.js'
import { EMPTY_PROJECTS_STATE, type ProjectsState } from '../src/shared/projects.js'

const FILE = '/data/yeschef-projects.json'
const [BAK0, BAK1] = backupPaths(FILE)

const STATE: ProjectsState = {
  schemaVersion: 1,
  activeId: 'p1',
  openIdsOnShutdown: ['p1'],
  projects: [{
    id: 'p1', rootPath: '/Users/x/demo', name: 'demo', addedAt: 1, lastOpenedAt: 2, lastUrl: null,
    tabs: [{ id: 't1', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1' }],
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
  it('schemaVersion 不是 1 就拒絕', () => {
    expect(parseProjectsState({ ...STATE, schemaVersion: 2 })).toBeNull()
  })
  it('專案沒有對話分頁或有兩個都拒絕', () => {
    const p = STATE.projects[0]!
    expect(parseProjectsState({ ...STATE, projects: [{ ...p, tabs: [] }] })).toBeNull()
    expect(parseProjectsState({ ...STATE, projects: [{ ...p, tabs: [...p.tabs, { ...p.tabs[0]!, id: 't9' }] }] })).toBeNull()
  })
  it('readSchemaVersion 只讀版本欄位', () => {
    expect(readSchemaVersion({ schemaVersion: 7 })).toBe(7)
    expect(readSchemaVersion({})).toBeUndefined()
    expect(readSchemaVersion('x')).toBeUndefined()
  })
})

describe('load', () => {
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-store.test.ts`
Expected: FAIL,找不到 `../src/main/projects-store.js`。

- [ ] **Step 3: 寫 `src/main/projects-schema.ts`**

```ts
/**
 * 狀態檔的執行期形狀驗證(規格 §4.1)。zod 只在 main 使用(與 view-tools/server.ts 同樣的用法)。
 * renderer 不 import 這個檔案。
 */
import { z } from 'zod'
import { PROJECTS_SCHEMA_VERSION, type ProjectsState } from '../shared/projects.js'

const switchPhaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('preparing'), txId: z.string(), startedAt: z.number() }),
  z.object({ kind: z.literal('spawning'), txId: z.string(), handoffVersion: z.number() }),
  z.object({ kind: z.literal('receiving'), txId: z.string(), newSessionId: z.string() }),
])

const sessionLinkSchema = z.object({
  sessionId: z.string().min(1),
  transcriptPath: z.string(),
  parentSessionId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  endReason: z.enum(['handoff', 'user']).nullable(),
})

const threadSchema = z.object({
  id: z.string().min(1),
  sessions: z.array(sessionLinkSchema),
  handoffVersion: z.number().int().nonnegative(),
  switchPhase: switchPhaseSchema,
  createdAt: z.number(),
})

const tabSchema = z.object({
  id: z.string().min(1),
  contentType: z.enum(['conversation', 'terminal']),
  label: z.string(),
  customLabel: z.string().nullable(),
  command: z.string().optional(),
  sortOrder: z.number(),
  lastFocusedAt: z.number(),
  threadId: z.string().optional(),
})

const projectSchema = z
  .object({
    id: z.string().min(1),
    rootPath: z.string().min(1),
    name: z.string(),
    addedAt: z.number(),
    lastOpenedAt: z.number(),
    tabs: z.array(tabSchema),
    lastUrl: z.string().nullable(),
    threads: z.array(threadSchema),
  })
  // 規格 §4.1:每個專案恰有一個對話分頁。
  .refine((p) => p.tabs.filter((t) => t.contentType === 'conversation').length === 1, {
    message: '每個專案要有恰好一個對話分頁',
  })

const stateSchema = z.object({
  schemaVersion: z.literal(PROJECTS_SCHEMA_VERSION),
  projects: z.array(projectSchema),
  activeId: z.string().nullable(),
  openIdsOnShutdown: z.array(z.string()),
})

export function parseProjectsState(raw: unknown): ProjectsState | null {
  const result = stateSchema.safeParse(raw)
  return result.success ? result.data : null
}

/** 只讀版本欄位,讓 store 分辨「版本不認得」與「內容損毀」。 */
export function readSchemaVersion(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = (raw as Record<string, unknown>)['schemaVersion']
  return typeof v === 'number' ? v : undefined
}
```

- [ ] **Step 4: 寫 `src/main/projects-store.ts`**

```ts
/**
 * `<userData>/yeschef-projects.json` 的讀寫(規格 §4.1、§6)。
 *
 * 寫:先寫 `.tmp`,再把主檔輪到 `.bak.0`(舊的 `.bak.0` 輪到 `.bak.1`),最後 rename `.tmp`
 * 成主檔。任一步失敗,前面的檔案都還在,不會出現半份主檔。
 * 讀:依序試主檔、`.bak.0`、`.bak.1`,每一份讀不出來都記一筆錯;都不行回空狀態,
 * 不刪不改任何檔。主檔的 schemaVersion 不認得時改名保留(規格 §4.1「保留原檔」),
 * 之後的 save 才不會蓋掉它。
 */
import { promises as nodeFs } from 'node:fs'
import { EMPTY_PROJECTS_STATE, PROJECTS_SCHEMA_VERSION, type ProjectsState } from '../shared/projects.js'
import { parseProjectsState, readSchemaVersion } from './projects-schema.js'

export interface StoreFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface ProjectsStore {
  load(): Promise<ProjectsState>
  save(state: ProjectsState): Promise<void>
}

export interface ProjectsStoreDeps {
  readonly filePath: string
  readonly fs: StoreFs
  readonly logError: (error: Error) => void
}

export const nodeStoreFs: StoreFs = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  writeFile: (p, data) => nodeFs.writeFile(p, data, 'utf8'),
  rename: (from, to) => nodeFs.rename(from, to),
  exists: async (p) => {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
}

export function backupPaths(filePath: string): readonly [string, string] {
  return [`${filePath}.bak.0`, `${filePath}.bak.1`]
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createProjectsStore(deps: ProjectsStoreDeps): ProjectsStore {
  const { filePath, fs, logError } = deps
  const [bak0, bak1] = backupPaths(filePath)
  const tmp = `${filePath}.tmp`

  async function readCandidate(path: string, isMain: boolean): Promise<ProjectsState | null | 'unknown-version'> {
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(path))
    } catch (cause) {
      logError(new Error(`讀取 ${path} 失敗:${messageOf(cause)}`))
      return null
    }
    const version = readSchemaVersion(raw)
    if (isMain && version !== undefined && version !== PROJECTS_SCHEMA_VERSION) {
      const kept = `${filePath}.schema-${version}`
      await fs.rename(filePath, kept)
      logError(new Error(`${filePath} 的 schemaVersion ${version} 不認得,已改名為 ${kept} 保留,改用空狀態`))
      return 'unknown-version'
    }
    const parsed = parseProjectsState(raw)
    if (parsed === null) logError(new Error(`讀取 ${path} 失敗:內容不符合 schemaVersion ${PROJECTS_SCHEMA_VERSION}`))
    return parsed
  }

  async function load(): Promise<ProjectsState> {
    for (const path of [filePath, bak0, bak1]) {
      if (!(await fs.exists(path))) continue
      const result = await readCandidate(path, path === filePath)
      if (result === 'unknown-version') return EMPTY_PROJECTS_STATE
      if (result !== null) return result
    }
    return EMPTY_PROJECTS_STATE
  }

  async function writeAtomically(state: ProjectsState): Promise<void> {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2))
    if (await fs.exists(bak0)) await fs.rename(bak0, bak1)
    if (await fs.exists(filePath)) await fs.rename(filePath, bak0)
    await fs.rename(tmp, filePath)
  }

  // save 排成一條鏈:兩次 save 同時進來時輪替步驟不能交錯。
  let queue: Promise<void> = Promise.resolve()
  function save(state: ProjectsState): Promise<void> {
    const run = queue.then(() => writeAtomically(state))
    queue = run.catch(() => undefined)
    return run
  }

  return { load, save }
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/projects-store.test.ts`
Expected: PASS,15 條。

- [ ] **Step 6: Commit**

```bash
git add src/main/projects-schema.ts src/main/projects-store.ts tests/projects-store.test.ts
git commit -m "feat: 專案狀態檔的 schema、原子寫入與備份輪替"
```

---

### Task 3: `ProjectsState` 的純 reducer 與 transcript 路徑

**Files:**
- Create: `src/main/projects-state.ts`
- Create: `src/main/transcript-path.ts`
- Test: `tests/projects-state.test.ts`
- Test: `tests/transcript-path.test.ts`

**Interfaces:**
- Consumes: Task 1 的型別與 `CONVERSATION_TAB_LABEL`。
- Produces(Task 4 的 service 與 Task 7、8 的 IPC 都用):
  - `createProjectEntry(input: { id: string; rootPath: string; conversationTabId: string; threadId: string; now: number }): ProjectEntry`(name 取 `basename(rootPath)`)
  - `addProject(state, entry): ProjectsState`(`activeId` 為 null 時自動指到新專案)
  - `removeProject(state, id): ProjectsState`(移除的是 active 時,`activeId` 退到剩下的第一個,沒有就 null)
  - `relocateProject(state, id, rootPath): ProjectsState`(改 `rootPath` 與 `name`,分頁與 thread 不動)
  - `setActive(state, id, now): ProjectsState`(未知 id 回原 state)
  - `openTab(state, projectId, tab: { id: string; label: string; command?: string }, now): ProjectsState`(`sortOrder` = 最大值 + 1,新分頁取得焦點)
  - `closeTab(state, projectId, tabId, now): ProjectsState`(對話分頁或未知 id 回原 state;關掉有焦點的分頁時焦點回對話分頁)
  - `focusTab(state, projectId, tabId, now): ProjectsState`
  - `setLastUrl(state, projectId, url: string | null): ProjectsState`
  - `startThread(state, projectId, threadId, now): ProjectsState`(新 thread 接到尾端、對話分頁 `threadId` 指過去;順手丟掉沒有任何 session 的舊 thread)
  - `pointConversationAt(state, projectId, link: SessionLink, newThreadId, now): ProjectsState`(已有 thread 含該 session 就指過去;沒有就用 `newThreadId` 建一條含這一筆 link 的 thread)
  - `recordSession(state, projectId, threadId, link: SessionLink): ProjectsState`(最後一筆 sessionId 相同時回原 state)
  - `setShutdown(state, openIds: readonly string[]): ProjectsState`
  - selectors:`findProject(state, id)`, `activeTabId(entry): string`, `conversationTab(entry): TabEntry`, `currentThread(entry): ThreadEntry | undefined`, `lastSessionId(entry): string | undefined`
  - `encodeCwd(cwd: string): string`、`transcriptPathFor(homeDir: string, cwd: string, sessionId: string): string`(`transcript-path.ts`)

- [ ] **Step 1: 寫失敗的測試(reducer)**

`tests/projects-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  activeTabId, addProject, closeTab, conversationTab, createProjectEntry, currentThread, findProject,
  focusTab, lastSessionId, openTab, pointConversationAt, recordSession, relocateProject, removeProject,
  setActive, setLastUrl, setShutdown, startThread,
} from '../src/main/projects-state.js'
import { EMPTY_PROJECTS_STATE, type SessionLink } from '../src/shared/projects.js'

const entryA = createProjectEntry({ id: 'a', rootPath: '/Users/x/alpha', conversationTabId: 'a-conv', threadId: 'a-th1', now: 100 })
const entryB = createProjectEntry({ id: 'b', rootPath: '/Users/x/beta', conversationTabId: 'b-conv', threadId: 'b-th1', now: 101 })
const two = addProject(addProject(EMPTY_PROJECTS_STATE, entryA), entryB)

const link = (sessionId: string): SessionLink => ({
  sessionId, transcriptPath: `/home/.claude/projects/x/${sessionId}.jsonl`, parentSessionId: null, startedAt: 500, endedAt: null, endReason: null,
})

describe('createProjectEntry / addProject', () => {
  it('名稱取資料夾名,只有一個對話分頁與一條空 thread', () => {
    expect(entryA.name).toBe('alpha')
    expect(entryA.tabs).toEqual([
      { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 100, threadId: 'a-th1' },
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
    expect(conversationTab(p).lastFocusedAt).toBe(300)
  })
  it('closeTab 關掉沒有焦點的分頁,不動焦點', () => {
    const s = openTab(withTerm, 'a', { id: 'a-t2', label: 'zsh' }, 250)
    const closed = closeTab(s, 'a', 'a-t1', 300)
    expect(activeTabId(findProject(closed, 'a')!)).toBe('a-t2')
    expect(conversationTab(findProject(closed, 'a')!).lastFocusedAt).toBe(100)
  })
  it('closeTab 拒絕關對話分頁與未知分頁', () => {
    expect(closeTab(withTerm, 'a', 'a-conv', 300)).toBe(withTerm)
    expect(closeTab(withTerm, 'a', 'nope', 300)).toBe(withTerm)
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

describe('thread 與 session 鏈', () => {
  it('recordSession 接到指定 thread 尾端;同一 sessionId 連續兩次只記一次', () => {
    const s1 = recordSession(two, 'a', 'a-th1', link('s1'))
    const s2 = recordSession(s1, 'a', 'a-th1', link('s1'))
    expect(s2).toBe(s1)
    expect(currentThread(findProject(s1, 'a')!)!.sessions.map((l) => l.sessionId)).toEqual(['s1'])
    expect(lastSessionId(findProject(s1, 'a')!)).toBe('s1')
    expect(recordSession(two, 'a', 'nope', link('s1'))).toBe(two)
  })
  it('startThread 新增 thread、對話分頁指過去、丟掉沒有 session 的舊 thread', () => {
    const s1 = recordSession(two, 'a', 'a-th1', link('s1'))
    const s2 = startThread(s1, 'a', 'a-th2', 600)
    const p = findProject(s2, 'a')!
    expect(p.threads.map((t) => t.id)).toEqual(['a-th1', 'a-th2'])
    expect(conversationTab(p).threadId).toBe('a-th2')
    expect(currentThread(p)!.id).toBe('a-th2')
    expect(lastSessionId(p)).toBeUndefined()
    const s3 = startThread(s2, 'a', 'a-th3', 700)
    expect(findProject(s3, 'a')!.threads.map((t) => t.id)).toEqual(['a-th1', 'a-th3'])
  })
  it('pointConversationAt 找到含該 session 的 thread 就指過去', () => {
    const s1 = startThread(recordSession(two, 'a', 'a-th1', link('s1')), 'a', 'a-th2', 600)
    const s2 = pointConversationAt(s1, 'a', link('s1'), 'unused', 650)
    const p = findProject(s2, 'a')!
    expect(conversationTab(p).threadId).toBe('a-th1')
    expect(p.threads.map((t) => t.id)).toEqual(['a-th1'])
  })
  it('pointConversationAt 找不到就用 newThreadId 建一條含該 link 的 thread', () => {
    const s = pointConversationAt(two, 'a', link('legacy'), 'a-th9', 650)
    const p = findProject(s, 'a')!
    expect(p.threads.map((t) => t.id)).toEqual(['a-th9'])
    expect(currentThread(p)!.sessions).toEqual([link('legacy')])
    expect(currentThread(p)!.createdAt).toBe(650)
  })
  it('setShutdown 只換 openIdsOnShutdown', () => {
    expect(setShutdown(two, ['b']).openIdsOnShutdown).toEqual(['b'])
  })
})
```

- [ ] **Step 2: 寫失敗的測試(transcript 路徑)**

`tests/transcript-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { encodeCwd, transcriptPathFor } from '../src/main/transcript-path.js'

describe('transcriptPathFor', () => {
  it('cwd 的每個非英數字元都換成 -(含點與斜線),對照本機真實目錄名', () => {
    expect(encodeCwd('/Users/me/multi-repo-agent/.claude/worktrees/corpus'))
      .toBe('-Users-me-multi-repo-agent--claude-worktrees-corpus')
    expect(encodeCwd('/private/tmp/yeschef-acceptance')).toBe('-private-tmp-yeschef-acceptance')
  })
  it('組成 ~/.claude/projects/<encoded>/<sessionId>.jsonl', () => {
    expect(transcriptPathFor('/Users/me', '/Users/me/demo', 'abc-123'))
      .toBe('/Users/me/.claude/projects/-Users-me-demo/abc-123.jsonl')
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/projects-state.test.ts tests/transcript-path.test.ts`
Expected: FAIL,兩個模組都找不到。

- [ ] **Step 4: 寫 `src/main/transcript-path.ts`**

```ts
import { join } from 'node:path'

/**
 * Claude Code 把 transcript 放在 `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`。
 * 編碼規則以本機實際目錄名對照得出:每個非 `[a-zA-Z0-9]` 的字元換成 `-`
 * (`/a/.b` → `-a--b`)。SDK 沒有提供這個路徑,只能自己組。
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPathFor(homeDir: string, cwd: string, sessionId: string): string {
  return join(homeDir, '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)
}
```

- [ ] **Step 5: 寫 `src/main/projects-state.ts`**

```ts
/**
 * `ProjectsState` 的純 reducer(規格 §4.1)。每個函式回新物件,不改傳入的 state;
 * 沒有東西可改時回傳原 state(呼叫端可用 `===` 判斷要不要存檔)。
 */
import { basename } from 'node:path'
import {
  CONVERSATION_TAB_LABEL,
  type ProjectEntry,
  type ProjectsState,
  type SessionLink,
  type TabEntry,
  type ThreadEntry,
} from '../shared/projects.js'

export interface NewProjectInput {
  readonly id: string
  readonly rootPath: string
  readonly conversationTabId: string
  readonly threadId: string
  readonly now: number
}

function newThread(id: string, now: number, sessions: readonly SessionLink[] = []): ThreadEntry {
  return { id, sessions, handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: now }
}

export function createProjectEntry(input: NewProjectInput): ProjectEntry {
  return {
    id: input.id,
    rootPath: input.rootPath,
    name: basename(input.rootPath),
    addedAt: input.now,
    lastOpenedAt: input.now,
    tabs: [{
      id: input.conversationTabId,
      contentType: 'conversation',
      label: CONVERSATION_TAB_LABEL,
      customLabel: null,
      sortOrder: 0,
      lastFocusedAt: input.now,
      threadId: input.threadId,
    }],
    lastUrl: null,
    threads: [newThread(input.threadId, input.now)],
  }
}

export function findProject(state: ProjectsState, id: string): ProjectEntry | undefined {
  return state.projects.find((p) => p.id === id)
}

/** 套用到一個專案;找不到或 fn 回原 entry 時回原 state。 */
function updateProject(state: ProjectsState, id: string, fn: (p: ProjectEntry) => ProjectEntry): ProjectsState {
  const current = findProject(state, id)
  if (current === undefined) return state
  const next = fn(current)
  if (next === current) return state
  return { ...state, projects: state.projects.map((p) => (p.id === id ? next : p)) }
}

export function addProject(state: ProjectsState, entry: ProjectEntry): ProjectsState {
  return { ...state, projects: [...state.projects, entry], activeId: state.activeId ?? entry.id }
}

export function removeProject(state: ProjectsState, id: string): ProjectsState {
  if (findProject(state, id) === undefined) return state
  const projects = state.projects.filter((p) => p.id !== id)
  const activeId = state.activeId === id ? (projects[0]?.id ?? null) : state.activeId
  return { ...state, projects, activeId }
}

export function relocateProject(state: ProjectsState, id: string, rootPath: string): ProjectsState {
  return updateProject(state, id, (p) => ({ ...p, rootPath, name: basename(rootPath) }))
}

export function setActive(state: ProjectsState, id: string, now: number): ProjectsState {
  const next = updateProject(state, id, (p) => ({ ...p, lastOpenedAt: now }))
  return next === state ? state : { ...next, activeId: id }
}

export function conversationTab(entry: ProjectEntry): TabEntry {
  const tab = entry.tabs.find((t) => t.contentType === 'conversation')
  if (tab === undefined) throw new Error(`專案 ${entry.id} 沒有對話分頁`)
  return tab
}

export function activeTabId(entry: ProjectEntry): string {
  return entry.tabs.reduce((best, t) => (t.lastFocusedAt > best.lastFocusedAt ? t : best), conversationTab(entry)).id
}

export interface NewTabInput {
  readonly id: string
  readonly label: string
  readonly command?: string
}

export function openTab(state: ProjectsState, projectId: string, tab: NewTabInput, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const sortOrder = Math.max(...p.tabs.map((t) => t.sortOrder)) + 1
    const entry: TabEntry = {
      id: tab.id,
      contentType: 'terminal',
      label: tab.label,
      customLabel: null,
      ...(tab.command === undefined ? {} : { command: tab.command }),
      sortOrder,
      lastFocusedAt: now,
    }
    return { ...p, tabs: [...p.tabs, entry] }
  })
}

export function closeTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const target = p.tabs.find((t) => t.id === tabId)
    if (target === undefined || target.contentType === 'conversation') return p
    const wasFocused = activeTabId(p) === tabId
    const tabs = p.tabs
      .filter((t) => t.id !== tabId)
      .map((t) => (wasFocused && t.contentType === 'conversation' ? { ...t, lastFocusedAt: now } : t))
    return { ...p, tabs }
  })
}

export function focusTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    if (!p.tabs.some((t) => t.id === tabId)) return p
    return { ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, lastFocusedAt: now } : t)) }
  })
}

export function setLastUrl(state: ProjectsState, projectId: string, url: string | null): ProjectsState {
  return updateProject(state, projectId, (p) => (p.lastUrl === url ? p : { ...p, lastUrl: url }))
}

function pointTabAt(p: ProjectEntry, threadId: string): readonly TabEntry[] {
  return p.tabs.map((t) => (t.contentType === 'conversation' ? { ...t, threadId } : t))
}

export function startThread(state: ProjectsState, projectId: string, threadId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => ({
    ...p,
    threads: [...p.threads.filter((t) => t.sessions.length > 0), newThread(threadId, now)],
    tabs: pointTabAt(p, threadId),
  }))
}

export function pointConversationAt(
  state: ProjectsState,
  projectId: string,
  link: SessionLink,
  newThreadId: string,
  now: number,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const existing = p.threads.find((t) => t.sessions.some((s) => s.sessionId === link.sessionId))
    const kept = p.threads.filter((t) => t.sessions.length > 0)
    if (existing !== undefined) return { ...p, threads: kept, tabs: pointTabAt(p, existing.id) }
    return { ...p, threads: [...kept, newThread(newThreadId, now, [link])], tabs: pointTabAt(p, newThreadId) }
  })
}

export function recordSession(state: ProjectsState, projectId: string, threadId: string, link: SessionLink): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const thread = p.threads.find((t) => t.id === threadId)
    if (thread === undefined) return p
    if (thread.sessions.at(-1)?.sessionId === link.sessionId) return p
    const updated: ThreadEntry = { ...thread, sessions: [...thread.sessions, link] }
    return { ...p, threads: p.threads.map((t) => (t.id === threadId ? updated : t)) }
  })
}

export function setShutdown(state: ProjectsState, openIds: readonly string[]): ProjectsState {
  return { ...state, openIdsOnShutdown: [...openIds] }
}

export function currentThread(entry: ProjectEntry): ThreadEntry | undefined {
  const id = conversationTab(entry).threadId
  return entry.threads.find((t) => t.id === id) ?? entry.threads.at(-1)
}

export function lastSessionId(entry: ProjectEntry): string | undefined {
  return currentThread(entry)?.sessions.at(-1)?.sessionId
}
```

- [ ] **Step 6: 跑測試確認通過**

Run: `npx vitest run tests/projects-state.test.ts tests/transcript-path.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/main/projects-state.ts src/main/transcript-path.ts tests/projects-state.test.ts tests/transcript-path.test.ts
git commit -m "feat: 專案狀態的純 reducer 與 transcript 路徑"
```

---

### Task 4: `projects-service`:持有現行狀態、存檔、通知

**Files:**
- Create: `src/main/projects-service.ts`
- Test: `tests/projects-service.test.ts`

**Interfaces:**
- Consumes: Task 2 `ProjectsStore`;Task 3 `createProjectEntry`、`addProject`、`findProject`。
- Produces:
  ```ts
  export interface ProjectsServiceDeps {
    readonly store: ProjectsStore
    readonly initial: ProjectsState
    readonly now: () => number
    readonly newId: () => string
    readonly isDir: (path: string) => boolean
    readonly logError: (error: Error) => void
  }
  export interface ProjectsService {
    state(): ProjectsState
    /** 套 reducer;state 有變才存檔並同步通知訂閱者。回傳新 state。 */
    update(fn: (state: ProjectsState) => ProjectsState): ProjectsState
    subscribe(cb: (next: ProjectsState, prev: ProjectsState) => void): () => void
    rootPathOf(id: string): string | undefined
    /** 資料夾存在且是目錄(規格 §6:不存在標示為不可用,不移除)。 */
    isAvailable(id: string): boolean
    /** 建一個新專案(三個 id 都由 `newId` 產生),回專案 id。 */
    addProject(rootPath: string): string
    newId(): string
    now(): number
  }
  export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService
  ```

- [ ] **Step 1: 寫失敗的測試**

`tests/projects-service.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createProjectsService } from '../src/main/projects-service.js'
import type { ProjectsStore } from '../src/main/projects-store.js'
import { EMPTY_PROJECTS_STATE, type ProjectsState } from '../src/shared/projects.js'
import { setActive } from '../src/main/projects-state.js'

function setup(opts: { failSave?: boolean; dirs?: readonly string[] } = {}) {
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
    initial: EMPTY_PROJECTS_STATE,
    now: () => 1000,
    newId: () => `id-${++n}`,
    isDir: (p) => (opts.dirs ?? ['/Users/x/alpha']).includes(p),
    logError: (e) => errors.push(e.message),
  })
  return { service, saved, errors }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createProjectsService', () => {
  it('addProject 用 newId 產生專案、對話分頁、thread 三個 id,回專案 id,並存檔', async () => {
    const t = setup()
    const id = t.service.addProject('/Users/x/alpha')
    expect(id).toBe('id-1')
    const p = t.service.state().projects[0]!
    expect(p.tabs[0]!.id).toBe('id-2')
    expect(p.threads[0]!.id).toBe('id-3')
    expect(t.service.state().activeId).toBe('id-1')
    await flush()
    expect(t.saved).toHaveLength(1)
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
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-service.test.ts`
Expected: FAIL,找不到模組。

- [ ] **Step 3: 寫 `src/main/projects-service.ts`**

```ts
/**
 * 專案登錄表的唯一持有者(規格 §3.1)。state 只透過 `update` 換新;每次換新同步通知
 * 訂閱者(路由器據此切對話核心、右窗格),再非同步存檔,存檔失敗只記錯不回滾:
 * 使用者眼前的操作已經生效,下一次 update 會再存一次。
 */
import { addProject as addProjectEntry, createProjectEntry, findProject } from './projects-state.js'
import type { ProjectsStore } from './projects-store.js'
import type { ProjectsState } from '../shared/projects.js'

export interface ProjectsServiceDeps {
  readonly store: ProjectsStore
  readonly initial: ProjectsState
  readonly now: () => number
  readonly newId: () => string
  readonly isDir: (path: string) => boolean
  readonly logError: (error: Error) => void
}

export interface ProjectsService {
  state(): ProjectsState
  update(fn: (state: ProjectsState) => ProjectsState): ProjectsState
  subscribe(cb: (next: ProjectsState, prev: ProjectsState) => void): () => void
  rootPathOf(id: string): string | undefined
  isAvailable(id: string): boolean
  addProject(rootPath: string): string
  newId(): string
  now(): number
}

type Listener = (next: ProjectsState, prev: ProjectsState) => void

export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService {
  let state = deps.initial
  let listeners: readonly Listener[] = []

  function update(fn: (s: ProjectsState) => ProjectsState): ProjectsState {
    const prev = state
    const next = fn(prev)
    if (next === prev) return prev
    state = next
    for (const cb of listeners) cb(next, prev)
    deps.store.save(next).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      deps.logError(new Error(`寫入專案狀態檔失敗:${message}`))
    })
    return next
  }

  return {
    state: () => state,
    update,
    subscribe(cb) {
      listeners = [...listeners, cb]
      return () => {
        listeners = listeners.filter((l) => l !== cb)
      }
    },
    rootPathOf: (id) => findProject(state, id)?.rootPath,
    isAvailable(id) {
      const root = findProject(state, id)?.rootPath
      return root !== undefined && deps.isDir(root)
    },
    addProject(rootPath) {
      const entry = createProjectEntry({
        id: deps.newId(),
        rootPath,
        conversationTabId: deps.newId(),
        threadId: deps.newId(),
        now: deps.now(),
      })
      update((s) => addProjectEntry(s, entry))
      return entry.id
    },
    newId: deps.newId,
    now: deps.now,
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/projects-service.test.ts`
Expected: PASS,5 條。

- [ ] **Step 5: Commit**

```bash
git add src/main/projects-service.ts tests/projects-service.test.ts
git commit -m "feat: 專案登錄表 service,持有狀態並存檔通知"
```

---

### Task 5: 狀態機新增 `sleep` action

**Files:**
- Modify: `src/main/session-machine.ts`
- Test: `tests/session-machine.test.ts`

**Interfaces:**
- Produces: `Action` 多一個成員 `{ readonly kind: 'sleep' }`。live 帶 id → `viewing{sessionId}` + `teardownLive('專案切到背景')`;live 沒有 id → idle + 同樣三步;idle / viewing → 原狀態、無 effect。Task 6 的對話核心在專案切到背景且回合已結束時 dispatch 它(規格 §3.3)。

- [ ] **Step 1: 寫失敗的測試**

在 `tests/session-machine.test.ts` 末端加一個 describe:

```ts
describe('sleep:專案切到背景後收掉串流(規格 D §3.3)', () => {
  it('live 有 sessionId 時轉 viewing 並走三步收尾,之後再輸入才 resume', () => {
    const r = transition({ kind: 'live', sessionId: 's-1' }, { kind: 'sleep' })
    expect(r.state).toEqual({ kind: 'viewing', sessionId: 's-1' })
    expect(r.effects.map((e) => e.kind)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query'])
    expect(r.effects[0]).toEqual({ kind: 'deny-all-approvals', reason: '專案切到背景' })
  })
  it('live 還沒有 sessionId 時只能回 idle', () => {
    const r = transition({ kind: 'live' }, { kind: 'sleep' })
    expect(r.state).toEqual({ kind: 'idle' })
    expect(r.effects.map((e) => e.kind)).toEqual(['deny-all-approvals', 'interrupt-query', 'teardown-query'])
  })
  it('idle 與 viewing 忽略 sleep', () => {
    expect(transition({ kind: 'idle' }, { kind: 'sleep' })).toEqual({ state: { kind: 'idle' }, effects: [] })
    expect(transition({ kind: 'viewing', sessionId: 's-2' }, { kind: 'sleep' }))
      .toEqual({ state: { kind: 'viewing', sessionId: 's-2' }, effects: [] })
  })
  it('sleep 後 user-input 帶 resume', () => {
    const slept = transition({ kind: 'live', sessionId: 's-1' }, { kind: 'sleep' }).state
    const r = transition(slept, { kind: 'user-input', text: '繼續' })
    expect(r.effects).toEqual([{ kind: 'start-query', resumeSessionId: 's-1', initialInput: '繼續' }])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/session-machine.test.ts`
Expected: FAIL,`tsc` 層級的錯誤(`'sleep'` 不在 `Action` 裡)或 switch 沒對應而回 undefined。

- [ ] **Step 3: 實作**

`Action` union 在 `| { readonly kind: 'window-closed' }` 之後加:

```ts
  /**
   * 專案切到背景且回合已結束(規格 D §3.3):收掉串流只留 sessionId。之後 user-input
   * 會走 viewing 的路徑帶 resume,所以 live 有 id 時轉 viewing 而不是 idle。
   */
  | { readonly kind: 'sleep' }
```

`fromIdle` 的 `case 'window-closed':` 那一組加 `case 'sleep':`(同樣回 `{ state: { kind: 'idle' }, effects: [] }`)。

`fromLive` 加:

```ts
    case 'sleep':
      return state.sessionId === undefined
        ? { state: { kind: 'idle' }, effects: teardownLive('專案切到背景') }
        : { state: { kind: 'viewing', sessionId: state.sessionId }, effects: teardownLive('專案切到背景') }
```

`fromViewing` 的 `case 'session-started':` 那一組加 `case 'sleep':`(回 `{ state: { ...state }, effects: [] }`)。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/session-machine.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/session-machine.ts tests/session-machine.test.ts
git commit -m "feat: 狀態機新增 sleep,專案切到背景後收掉串流"
```

---
### Task 6: 每個專案一份的對話核心 `conversation.ts`

把 `ipc-bridge.ts` 裡「狀態機 + host + 批准 registry + effects 串行鏈」這一段抽成不碰 `ipcMain` 的 `createConversation()`。它多了三件事:前景／背景(`activate`／`deactivate`)、背景時扣住批准(規格 §2「背景待批准」)、切到背景且回合結束時發 `sleep`(規格 §3.3)。Task 7 的路由器對每個專案各建一份。

本 task 不改 `ipc-bridge.ts`,既有 `tests/ipc-bridge.test.ts` 繼續綠;Task 7 才把 bridge 改成路由器。

**Files:**
- Create: `src/shared/event-log.ts`
- Create: `src/main/conversation.ts`
- Create: `tests/conversation.test.ts`
- Modify: `src/renderer/hooks/useConversation.ts`(`appendEvents` 改從 shared 匯入並重新匯出)

**Interfaces:**
- Consumes: Task 5 的 `Action` 新增 `{ kind: 'sleep' }`;既有 `transition`、`createAgentHost`、`createApprovalRegistry`、`mergeAccept`／`mergeFlush`、`MSG.sessionEnded`。
- Produces(Task 7 用):
  ```ts
  export interface ConversationSink {
    events(batch: readonly Event[]): void
    state(state: SessionState): void
    approvalAsk(payload: ApprovalAskPayload): void   // 送不出去就 throw
  }
  export interface ConversationDeps {
    sink; sessionOptions; loadHistory(sessionId); logError;
    onSessionStarted?(sessionId, cwd?); onHeldChange?(count); initialSessionId?;
    queryFn?; approvalTimeoutMs?; createHost?; createRegistry?; viewTools?: ViewToolHooks
  }
  export interface Conversation {
    userInput(text); approvalReply(requestId, decision); startNew(); openHistory(sessionId);
    handoffDone(toolUseId); activate(); deactivate(); replay(); isActive(); heldApprovals(): number;
    sessionState(): SessionState; dispose(): Promise<void>
  }
  export function createConversation(deps: ConversationDeps): Conversation
  export type ViewToolHooks = Pick<ViewTools, 'autoAllow' | 'handoffDone' | 'abortPending'>
  ```
- Produces(renderer 與 main 共用):`src/shared/event-log.ts` 的 `appendEvents(prev, batch)`。

**行為規則(測試就是照這幾條寫的):**

1. 初始狀態:有 `initialSessionId` 就是 `viewing{sessionId}`(重開 app 時的 sleeping session),沒有就是 `idle`。
2. 事件與狀態只在前景推給 sink;背景時事件照樣記進記憶體 `log`(上一次 `reset` 之後的事件,用共用的 `appendEvents` 截斷)。
3. `replay()`(前景才有作用):`viewing` → 發 `open-history` 重讀 transcript(規格 §3.3「先讀 transcript 把既有內容顯示出來」);`live`／`idle` → 同步送 `[reset, ...log]`(用 `mergeAccept`／`mergeFlush` 分批)再送目前狀態。`activate()` = 標記前景 + `replay()` + 把扣住的批准依序交給 registry。renderer 重新載入時路由器只呼叫 `replay()`。
4. `deactivate()`:`live` 且回合進行中 → 記 `sleepPending`,收到 `session-end` 才發 `sleep`;`live` 且沒有回合 → 立刻發 `sleep`;其他狀態不動。
5. 回合進行中(`busy`)的判定:`userInput()` 一送出就是 true;收到 `session-end` 事件、host `onEnded`、`startNew()`、`openHistory()`、送出失敗補錯誤卡時回 false。
6. 批准:前景直接 `registry.request(ask)`;背景先扣住(不進 registry,因為 registry 一收就開始計時逾時),數量變動時呼叫 `onHeldChange(count)`。`deny-all-approvals` effect 除了 `registry.denyAll` 也把扣住的全部 deny。
7. 其餘行為(error card 文案、`asError` 標籤、`abortPending(MSG.sessionEnded)`)照搬 bridge,不改字。

- [ ] **Step 1: 建立共用的 `event-log.ts`,`useConversation` 改用它**

```ts
// src/shared/event-log.ts
import type { Event } from './events.js'

/** 最後一個 `reset` 的位置;沒有回 -1。不用 findLastIndex 是因為 target 是 ES2022。 */
function lastResetIndex(batch: readonly Event[]): number {
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    if (batch[i]?.kind === 'reset') return i
  }
  return -1
}

/**
 * 把一批事件接到既有事件之後。批次裡有 `reset` 就只留最後一個 `reset` 之後的部分,
 * 前面的全部丟掉。renderer 的 `useConversation` 與 main 的 `conversation.ts` 用同一條規則,
 * 切回前景重播 `[reset, ...log]` 時兩邊算出的內容才一致。
 */
export function appendEvents(prev: readonly Event[], batch: readonly Event[]): readonly Event[] {
  const cut = lastResetIndex(batch)
  return cut === -1 ? [...prev, ...batch] : batch.slice(cut + 1)
}
```

`src/renderer/hooks/useConversation.ts`:刪掉檔內的 `lastResetIndex` 與 `appendEvents` 定義,改成

```ts
import { appendEvents } from '../../shared/event-log.js'
export { appendEvents }
```

(`tests/use-conversation.test.tsx` 從 hook 匯入 `appendEvents`,重新匯出讓它不必改。)

Run: `npx vitest run tests/use-conversation.test.tsx`
Expected: PASS,行為沒變。

- [ ] **Step 2: 寫 `tests/conversation.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw new Error('測試不該走到真的 SDK')
  },
}))

import {
  createConversation,
  type Conversation,
  type ConversationSink,
} from '../src/main/conversation.js'
import type { Event } from '../src/shared/events.js'
import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import type { AgentHost, AgentHostDeps } from '../src/main/agent-host.js'
import { createApprovalRegistry, type ApprovalAsk } from '../src/main/approval.js'
import type { SessionOptions } from '../src/main/session-args.js'

const OPTIONS: SessionOptions = {
  cwd: '/p',
  permissionMode: 'default',
  includePartialMessages: true,
}
const HISTORY: readonly Event[] = [
  { kind: 'user-text', text: '舊的問題' },
  { kind: 'session-end', isError: false },
]
const START_S9: Event = { kind: 'session-start', sessionId: 's-9', cwd: '/p' }
const END_OK: Event = { kind: 'session-end', isError: false }
const say = (text: string): Event => ({ kind: 'user-text', text })
const ask = (toolUseId: string): ApprovalAsk => ({ toolUseId, toolName: 'Bash', input: {} })

/** 讓已 resolve 的 promise 鏈全部跑完:假 host 的 promise 都是立刻 resolve,一個 macrotask 就夠。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Rig {
  readonly core: Conversation
  readonly calls: string[]
  readonly errors: Error[]
  readonly heldCounts: number[]
  readonly started: string[]
  readonly asks: ApprovalAskPayload[]
  hostDeps(): AgentHostDeps
  failSend(): void
  failHistory(): void
}

function setup(options?: { initialSessionId?: string; withViewTools?: true }): Rig {
  const calls: string[] = []
  const errors: Error[] = []
  const heldCounts: number[] = []
  const started: string[] = []
  const asks: ApprovalAskPayload[] = []
  let hostDeps: AgentHostDeps | null = null
  let sendSucceeds = true
  let historyFails = false

  const fakeHost: AgentHost = {
    start: (resume, initial) => {
      calls.push(`start(${resume ?? '-'},${initial ?? '-'})`)
    },
    send: (text) => {
      calls.push(`send(${text})`)
      return sendSucceeds
    },
    interrupt: () => {
      calls.push('interrupt')
      return Promise.resolve()
    },
    teardown: () => {
      calls.push('teardown')
      return Promise.resolve()
    },
  }
  const sink: ConversationSink = {
    events: (batch) => {
      calls.push(`events(${batch.map((e) => e.kind).join(',')})`)
    },
    state: (state) => {
      calls.push(`state(${state.kind})`)
    },
    approvalAsk: (payload) => {
      asks.push(payload)
      calls.push(`ask(${payload.toolUseId})`)
    },
  }
  const core = createConversation({
    sink,
    sessionOptions: () => OPTIONS,
    loadHistory: (sessionId) => {
      calls.push(`loadHistory(${sessionId})`)
      return historyFails ? Promise.reject(new Error('磁碟壞了')) : Promise.resolve(HISTORY)
    },
    logError: (error) => {
      errors.push(error)
    },
    onSessionStarted: (sessionId) => {
      started.push(sessionId)
    },
    onHeldChange: (count) => {
      heldCounts.push(count)
    },
    approvalTimeoutMs: 60_000,
    createHost: (d) => {
      hostDeps = d
      return fakeHost
    },
    createRegistry: createApprovalRegistry,
    ...(options?.initialSessionId === undefined ? {} : { initialSessionId: options.initialSessionId }),
    ...(options?.withViewTools === undefined
      ? {}
      : {
          viewTools: {
            autoAllow: () => false,
            handoffDone: (id: string) => {
              calls.push(`handoffDone(${id})`)
            },
            abortPending: (reason: string) => {
              calls.push(`abortPending(${reason})`)
            },
          },
        }),
  })
  return {
    core,
    calls,
    errors,
    heldCounts,
    started,
    asks,
    hostDeps: () => {
      if (hostDeps === null) throw new Error('host 尚未建立')
      return hostDeps
    },
    failSend: () => {
      sendSucceeds = false
    },
    failHistory: () => {
      historyFails = true
    },
  }
}

/** 前景 + 開新 query + 送一則輸入 + SDK 回 session-start:之後就是「live 且回合進行中」。 */
async function liveBusy(rig: Rig): Promise<void> {
  rig.core.activate()
  rig.core.startNew()
  await flush()
  rig.core.userInput('嗨')
  await flush()
  rig.hostDeps().onBatch([START_S9])
  await flush()
  rig.calls.length = 0
}

describe('createConversation:初始狀態與 activate', () => {
  it('沒有 initialSessionId 就是 idle;activate 送 reset 與狀態', () => {
    const rig = setup()
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
    expect(rig.core.isActive()).toBe(false)
    rig.core.activate()
    expect(rig.core.isActive()).toBe(true)
    expect(rig.calls).toEqual(['events(reset)', 'state(idle)'])
  })

  it('有 initialSessionId 從 viewing 起步;activate 重讀 transcript', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-1' })
    rig.core.activate()
    await flush()
    expect(rig.calls).toEqual([
      'events(reset)',
      'loadHistory(s-1)',
      'events(user-text,session-end)',
      'state(viewing)',
    ])
  })

  it('activate 兩次只做一次', () => {
    const rig = setup()
    rig.core.activate()
    rig.core.activate()
    expect(rig.calls).toEqual(['events(reset)', 'state(idle)'])
  })

  it('replay 在前景重送目前內容;背景不動', () => {
    const rig = setup()
    rig.core.replay()
    expect(rig.calls).toEqual([])
    rig.core.activate()
    rig.core.replay()
    expect(rig.calls).toEqual(['events(reset)', 'state(idle)', 'events(reset)', 'state(idle)'])
  })

  it('讀歷史失敗:記錄並補一張錯誤卡', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.failHistory()
    rig.core.activate()
    await flush()
    expect(rig.calls).toEqual(['events(reset)', 'loadHistory(s-1)', 'events(session-end)', 'state(viewing)'])
    expect(rig.errors.map((e) => e.message)).toEqual(['load-history: 磁碟壞了'])
  })
})

describe('createConversation:session 切換(照搬 bridge 的順序)', () => {
  it('idle 的 startNew:reset 後開新 query', async () => {
    const rig = setup()
    rig.core.activate()
    rig.calls.length = 0
    rig.core.startNew()
    await flush()
    expect(rig.calls).toEqual(['events(reset)', 'start(-,-)', 'state(live)'])
  })

  it('live 的 openHistory:interrupt、teardown、reset、讀歷史', async () => {
    const rig = setup({ withViewTools: true })
    await liveBusy(rig)
    rig.core.openHistory('s-2')
    await flush()
    expect(rig.calls).toEqual([
      'abortPending(對話已結束)',
      'interrupt',
      'abortPending(對話已結束)',
      'teardown',
      'events(reset)',
      'loadHistory(s-2)',
      'events(user-text,session-end)',
      'state(viewing)',
    ])
  })

  it('viewing 的 userInput:用 resume 開新 query,不 reset', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.core.activate()
    await flush()
    rig.calls.length = 0
    rig.core.userInput('續')
    await flush()
    expect(rig.calls).toEqual(['start(s-1,續)', 'state(live)'])
  })

  it('live 的 userInput 直接 send', async () => {
    const rig = setup()
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.calls.length = 0
    rig.core.userInput('嗨')
    await flush()
    expect(rig.calls).toEqual(['state(live)', 'send(嗨)'])
  })

  it('send 失敗:記錄並補「已收尾」錯誤卡', async () => {
    const rig = setup()
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.failSend()
    rig.calls.length = 0
    rig.core.userInput('x')
    await flush()
    expect(rig.calls).toEqual(['state(live)', 'send(x)', 'events(session-end)'])
    expect(rig.errors).toHaveLength(1)
    expect(rig.errors[0]?.message).toContain('已收尾')
  })

  it('session-start 事件:更新狀態並回報 onSessionStarted', async () => {
    const rig = setup()
    await liveBusy(rig)
    expect(rig.core.sessionState()).toEqual({ kind: 'live', sessionId: 's-9' })
    expect(rig.started).toEqual(['s-9'])
  })
})

describe('createConversation:前景／背景與 sleep', () => {
  it('背景時不推事件;切回前景重播 reset 之後的 log', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    rig.hostDeps().onBatch([say('背景產生的')])
    expect(rig.calls).toEqual([])
    rig.core.activate()
    expect(rig.calls).toEqual(['events(reset,session-start,user-text)', 'state(live)'])
  })

  it('回合進行中切到背景:等 session-end 才 sleep,切回來重讀 transcript', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual([])
    expect(rig.core.sessionState()).toEqual({ kind: 'live', sessionId: 's-9' })
    rig.hostDeps().onBatch([END_OK])
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-9' })
    rig.calls.length = 0
    rig.core.activate()
    await flush()
    expect(rig.calls).toEqual([
      'events(reset)',
      'loadHistory(s-9)',
      'events(user-text,session-end)',
      'state(viewing)',
    ])
  })

  it('沒有回合進行中切到背景:立刻 sleep', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.hostDeps().onBatch([END_OK])
    await flush()
    rig.calls.length = 0
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-9' })
  })

  it('還沒拿到 session id 就切到背景:sleep 回 idle', async () => {
    const rig = setup()
    rig.core.activate()
    rig.core.startNew()
    await flush()
    rig.calls.length = 0
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
  })

  it('背景時 query 自己結束:轉 idle,不再等 session-end', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    rig.hostDeps().onEnded()
    await flush()
    expect(rig.core.sessionState()).toEqual({ kind: 'idle' })
    rig.core.activate()
    expect(rig.calls).toEqual(['events(reset,session-start)', 'state(idle)'])
  })

  it('idle 或 viewing 時 deactivate 不發任何 effect', async () => {
    const rig = setup({ initialSessionId: 's-1' })
    rig.core.activate()
    await flush()
    rig.calls.length = 0
    rig.core.deactivate()
    await flush()
    expect(rig.calls).toEqual([])
    expect(rig.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-1' })
  })
})

describe('createConversation:批准', () => {
  it('前景直接送 ask;回覆後 promise 了結', async () => {
    const rig = setup()
    await liveBusy(rig)
    const outcome = rig.hostDeps().requestApproval(ask('t1'))
    expect(rig.calls).toEqual(['ask(t1)'])
    expect(rig.heldCounts).toEqual([])
    rig.core.approvalReply(rig.asks[0]?.requestId ?? '', 'allow')
    await expect(outcome).resolves.toEqual({ decision: 'allow' })
  })

  it('背景時扣住並通知數量;切回前景才送出', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ask('t2'))
    expect(rig.calls).toEqual([])
    expect(rig.heldCounts).toEqual([1])
    expect(rig.core.heldApprovals()).toBe(1)
    rig.core.activate()
    expect(rig.heldCounts).toEqual([1, 0])
    expect(rig.calls.at(-1)).toBe('ask(t2)')
    rig.core.approvalReply(rig.asks[0]?.requestId ?? '', 'deny')
    await expect(outcome).resolves.toEqual({ decision: 'deny' })
  })

  it('切 session 時扣住的批准一起 deny', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ask('t3'))
    rig.core.openHistory('s-2')
    await flush()
    await expect(outcome).resolves.toEqual({ decision: 'deny', reason: '切換 session' })
    expect(rig.core.heldApprovals()).toBe(0)
    expect(rig.heldCounts).toEqual([1, 0])
  })

  it('approvalReply 找不到 requestId 只記錄', () => {
    const rig = setup()
    rig.core.approvalReply('nope', 'allow')
    expect(rig.errors.map((e) => e.message)).toEqual(['agent:approval:reply：找不到 nope，可能已逾時'])
  })
})

describe('createConversation:handoff 與 dispose', () => {
  it('沒有 view tools 時 handoffDone 只記錄', () => {
    const rig = setup()
    rig.core.handoffDone('h1')
    expect(rig.errors.map((e) => e.message)).toEqual(['收到 handoff:done 但沒有 view tools'])
  })

  it('有 view tools 時轉交 handoffDone', () => {
    const rig = setup({ withViewTools: true })
    rig.core.handoffDone('h1')
    expect(rig.calls).toEqual(['handoffDone(h1)'])
  })

  it('dispose:live 收尾、扣住的批准 deny、之後不再推 sink', async () => {
    const rig = setup()
    await liveBusy(rig)
    rig.core.deactivate()
    const outcome = rig.hostDeps().requestApproval(ask('t4'))
    await rig.core.dispose()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
    await expect(outcome).resolves.toEqual({ decision: 'deny', reason: '視窗已關閉' })
    rig.core.activate()
    expect(rig.calls).toEqual(['interrupt', 'teardown'])
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/conversation.test.ts`
Expected: FAIL,`Cannot find module '../src/main/conversation.js'`。

- [ ] **Step 4: 寫 `src/main/conversation.ts`**

```ts
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { Event } from '../shared/events.js'
import type { SessionState } from '../shared/session-state.js'
import { IPC, type ApprovalAskPayload } from '../shared/ipc.js'
import { appendEvents } from '../shared/event-log.js'
import {
  createApprovalRegistry,
  type ApprovalAsk,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalRequest,
} from './approval.js'
import {
  DEFAULT_MERGE_CONFIG,
  INITIAL_MERGE_STATE,
  asError,
  createAgentHost,
  mergeAccept,
  mergeFlush,
  type AgentHost,
  type QueryFn,
} from './agent-host.js'
import { transition, type Action, type Effect } from './session-machine.js'
import type { SessionOptions } from './session-args.js'
import { MSG } from './view-tools/errors.js'
import type { ViewTools } from './view-tools/server.js'

/** 對話核心需要的 view tools 子集。Task 10 之後 `abortPending` 是每個專案自己的。 */
export type ViewToolHooks = Pick<ViewTools, 'autoAllow' | 'handoffDone' | 'abortPending'>

export const defaultQueryFn: QueryFn = (params) =>
  sdkQuery({ prompt: params.prompt, options: params.options })

/** 對話核心對外送東西的唯一出口;Task 7 的路由器把它接到 webContents。 */
export interface ConversationSink {
  events(batch: readonly Event[]): void
  state(state: SessionState): void
  /** 送不出去就 throw:registry 把 throw 當視窗已關,立刻 deny(沿用 approval.ts 的規則)。 */
  approvalAsk(payload: ApprovalAskPayload): void
}

export interface ConversationDeps {
  readonly sink: ConversationSink
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  readonly loadHistory: (sessionId: string) => Promise<readonly Event[]>
  readonly logError: (error: Error) => void
  /** live 拿到 SDK 的 session id 時通知;路由器據此記進 thread(規格 §2 thread 定義)。 */
  readonly onSessionStarted?: (sessionId: string, cwd?: string) => void
  /** 扣住的批准數量改變時通知;路由器據此更新專案列的記號(規格 §5)。 */
  readonly onHeldChange?: (count: number) => void
  /** 重開 app 時該專案的 sleeping session(規格 §3.3);有就從 viewing 起步。 */
  readonly initialSessionId?: string
  readonly queryFn?: QueryFn
  readonly approvalTimeoutMs?: number
  readonly createHost?: typeof createAgentHost
  readonly createRegistry?: typeof createApprovalRegistry
  readonly viewTools?: ViewToolHooks
}

export interface Conversation {
  userInput(text: string): void
  approvalReply(requestId: string, decision: ApprovalDecision): void
  startNew(): void
  openHistory(sessionId: string): void
  handoffDone(toolUseId: string): void
  /** 成為前景:重播內容、推狀態、把扣住的批准送出。 */
  activate(): void
  /** 退到背景:回合已結束就 sleep,否則等 session-end 再 sleep。 */
  deactivate(): void
  /** 把目前內容與狀態再推一次給 sink(renderer 剛載入時用);背景時不動。 */
  replay(): void
  isActive(): boolean
  heldApprovals(): number
  sessionState(): SessionState
  dispose(): Promise<void>
}

interface HeldAsk {
  readonly ask: ApprovalAsk
  readonly resolve: (outcome: ApprovalOutcome) => void
}

const RESET: Event = { kind: 'reset' }

export function createConversation(deps: ConversationDeps): Conversation {
  const queryFn = deps.queryFn ?? defaultQueryFn
  const createHost = deps.createHost ?? createAgentHost
  const viewTools = deps.viewTools

  let state: SessionState =
    deps.initialSessionId === undefined
      ? { kind: 'idle' }
      : { kind: 'viewing', sessionId: deps.initialSessionId }
  let active = false
  let disposed = false
  /** 上一次 reset 之後推過的事件;切回前景時重播。 */
  let log: readonly Event[] = []
  /** 回合進行中:userInput 送出後 true,session-end／onEnded／換 session 後 false。 */
  let busy = false
  /** 切到背景時回合還在跑,等它結束再 sleep。 */
  let sleepPending = false
  /** 背景時到達的批准。不進 registry:它一收就開始計時逾時,使用者根本還沒看到。 */
  let held: readonly HeldAsk[] = []
  let host: AgentHost | null = null
  /** effects 串行鏈:同一份對話的 effects 依 action 順序執行,不交錯。 */
  let pending: Promise<void> = Promise.resolve()

  const registry = (deps.createRegistry ?? createApprovalRegistry)({
    timeoutMs: deps.approvalTimeoutMs,
    sendRequest: (request: ApprovalRequest) => {
      const payload: ApprovalAskPayload = request
      deps.sink.approvalAsk(payload)
    },
  })

  const emit = (batch: readonly Event[]): void => {
    if (active) deps.sink.events(batch)
  }
  const emitState = (next: SessionState): void => {
    if (active) deps.sink.state(next)
  }
  /** 記進 log,前景時送出。 */
  const pushBatch = (events: readonly Event[]): void => {
    log = appendEvents(log, events)
    emit(events)
  }
  /** 一次很多事件時照 live 的規則分批,renderer 才不會一口氣吃下整份歷史。 */
  const chunked = (events: readonly Event[], out: (batch: readonly Event[]) => void): void => {
    const accepted = mergeAccept(INITIAL_MERGE_STATE, events, 0, DEFAULT_MERGE_CONFIG)
    const rest = mergeFlush(accepted.state)
    for (const batch of accepted.batches) out(batch)
    for (const batch of rest.batches) out(batch)
  }
  const pushHistory = (events: readonly Event[]): void => {
    chunked(events, pushBatch)
  }

  const setHeld = (next: readonly HeldAsk[]): void => {
    const changed = next.length !== held.length
    held = next
    if (changed) deps.onHeldChange?.(held.length)
  }
  const requestApproval = (request: ApprovalAsk): Promise<ApprovalOutcome> => {
    if (active) return registry.request(request)
    return new Promise<ApprovalOutcome>((resolve) => {
      setHeld([...held, { ask: request, resolve }])
    })
  }
  const releaseHeld = (): void => {
    const toSubmit = held
    setHeld([])
    for (const item of toSubmit) {
      registry.request(item.ask).then(item.resolve, (err: unknown) => {
        deps.logError(asError(err, 'held-approval'))
        item.resolve({ decision: 'deny', reason: '批准送出失敗' })
      })
    }
  }
  const denyHeld = (reason: string): void => {
    const toDeny = held
    setHeld([])
    for (const item of toDeny) item.resolve({ decision: 'deny', reason })
  }

  const turnEnded = (): void => {
    busy = false
    if (!sleepPending) return
    sleepPending = false
    dispatch({ kind: 'sleep' })
  }

  const pushLive = (events: readonly Event[]): void => {
    pushBatch(events)
    for (const event of events) {
      if (event.kind === 'session-start') {
        dispatch({ kind: 'session-started', sessionId: event.sessionId })
        deps.onSessionStarted?.(event.sessionId, event.cwd)
      }
      if (event.kind === 'session-end') turnEnded()
    }
  }

  const ensureHost = (): AgentHost => {
    if (host !== null) return host
    host = createHost({
      queryFn,
      sessionOptions: deps.sessionOptions,
      requestApproval,
      ...(viewTools === undefined ? {} : { autoAllow: (name, id) => viewTools.autoAllow(name, id) }),
      onBatch: pushLive,
      onError: deps.logError,
      onEnded: () => {
        busy = false
        sleepPending = false
        dispatch({ kind: 'session-ended' })
      },
    })
    return host
  }

  const runEffect = async (effect: Effect): Promise<void> => {
    switch (effect.kind) {
      case 'deny-all-approvals':
        registry.denyAll(effect.reason)
        denyHeld(effect.reason)
        return
      case 'interrupt-query':
        viewTools?.abortPending(MSG.sessionEnded)
        await ensureHost().interrupt()
        return
      case 'teardown-query':
        viewTools?.abortPending(MSG.sessionEnded)
        await ensureHost().teardown()
        return
      case 'start-query':
        if (effect.resumeSessionId === undefined) pushBatch([RESET])
        ensureHost().start(effect.resumeSessionId, effect.initialInput)
        return
      case 'load-history': {
        pushHistory([RESET])
        try {
          pushHistory(await deps.loadHistory(effect.sessionId))
        } catch (err) {
          const error = asError(err, 'load-history')
          deps.logError(error)
          pushHistory([
            { kind: 'session-end', isError: true, errorMessage: `讀取歷史對話失敗：${error.message}` },
          ])
        }
        return
      }
    }
  }
  const runEffects = async (effects: readonly Effect[]): Promise<void> => {
    for (const effect of effects) await runEffect(effect)
  }

  function dispatch(action: Action): void {
    const result = transition(state, action)
    state = result.state
    pending = pending
      .then(() => runEffects(result.effects))
      .catch((err: unknown) => deps.logError(asError(err, `effects(${action.kind})`)))
      .then(() => emitState(result.state))
  }

  const userInput = (text: string): void => {
    const wasLive = state.kind === 'live'
    dispatch({ kind: 'user-input', text })
    busy = true
    if (!wasLive) return
    pending = pending.then(() => {
      if (state.kind !== 'live') {
        deps.logError(new Error(`${IPC.userInput}：輸入到達時 session 已不在 live，這則輸入未送出`))
        pushBatch([
          { kind: 'session-end', isError: true, errorMessage: `這則輸入未送出（session 已切換）：${text}` },
        ])
        return
      }
      if (ensureHost().send(text)) return
      deps.logError(new Error(`${IPC.userInput}：session 已收尾，這則輸入未送出`))
      pushBatch([
        { kind: 'session-end', isError: true, errorMessage: `這則輸入未送出（session 已收尾）：${text}` },
      ])
      turnEnded()
    })
  }

  const approvalReply = (requestId: string, decision: ApprovalDecision): void => {
    if (registry.reply(requestId, decision)) return
    deps.logError(new Error(`${IPC.approvalReply}：找不到 ${requestId}，可能已逾時`))
  }

  const startNew = (): void => {
    busy = false
    sleepPending = false
    dispatch({ kind: 'start-new' })
  }

  const openHistory = (sessionId: string): void => {
    busy = false
    sleepPending = false
    dispatch({ kind: 'open-history', sessionId })
  }

  const handoffDone = (toolUseId: string): void => {
    if (viewTools === undefined) {
      deps.logError(new Error('收到 handoff:done 但沒有 view tools'))
      return
    }
    viewTools.handoffDone(toolUseId)
  }

  const replay = (): void => {
    if (!active) return
    if (state.kind === 'viewing') {
      // sleeping session:transcript 才是完整內容,log 只有切走前那一段(規格 §3.3)。
      dispatch({ kind: 'open-history', sessionId: state.sessionId })
      return
    }
    chunked([RESET, ...log], emit)
    deps.sink.state(state)
  }

  const activate = (): void => {
    if (active || disposed) return
    active = true
    sleepPending = false
    replay()
    releaseHeld()
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    if (state.kind !== 'live') return
    if (busy) {
      sleepPending = true
      return
    }
    dispatch({ kind: 'sleep' })
  }

  const dispose = async (): Promise<void> => {
    disposed = true
    active = false
    const result = transition(state, { kind: 'window-closed' })
    state = result.state
    pending = pending
      .then(() => runEffects(result.effects))
      .catch((err: unknown) => deps.logError(asError(err, 'effects(window-closed)')))
    await pending
  }

  return {
    userInput,
    approvalReply,
    startNew,
    openHistory,
    handoffDone,
    activate,
    deactivate,
    replay,
    isActive: () => active,
    heldApprovals: () => held.length,
    sessionState: () => state,
    dispose,
  }
}
```

兩個地方是刻意的:

- `activate()` 的重播是同步送,不排進 `pending` 鏈。鏈上可能還有一個 2 秒的 teardown 在等,排進去使用者切過來會看到上一個專案的畫面停 2 秒。重播用當下的 `log`,鏈上稍後才推的事件走 `pushBatch` 照常送出,順序不會亂。
- `userInput()` 在 dispatch 之後立刻 `busy = true`,不等 effect 真的跑。使用者送出就切走的話,`deactivate()` 看到的必須是「回合進行中」,不然會把剛送出去的輸入連 query 一起收掉。

- [ ] **Step 5: 跑測試與型別檢查**

Run: `npx vitest run tests/conversation.test.ts tests/use-conversation.test.tsx tests/ipc-bridge.test.ts`
Expected: PASS(bridge 測試沒動,仍綠)。

Run: `npm run typecheck`
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
git add src/shared/event-log.ts src/main/conversation.ts tests/conversation.test.ts src/renderer/hooks/useConversation.ts
git commit -m "feat: 抽出每個專案一份的對話核心,支援前景背景切換與扣住批准"
```

---

---

### Task 7: `ipc-bridge.ts` 改成專案路由器

**Files:**
- Modify: `src/main/ipc-bridge.ts`(整檔重寫:對話邏輯已搬到 Task 6,這裡只剩路由)
- Modify: `src/main/view-tools/errors.ts`(`MSG` 加一個 `browserBusy`)
- Rewrite: `tests/ipc-bridge.test.ts`(舊測試測的是對話行為,已由 `tests/conversation.test.ts` 接手;新測試只測路由)

**Interfaces:**
- Consumes: Task 6 的 `createConversation`、`Conversation`、`ConversationDeps`、`ViewToolHooks`;Task 4 的 `ProjectsService`(`state`、`update`、`subscribe`、`rootPathOf`、`isAvailable`、`newId`、`now`);Task 3 的 `findProject`、`activeTabId`、`currentThread`、`lastSessionId`、`startThread`、`pointConversationAt`、`recordSession`、`transcriptPathFor`;Task 1 的 `ProjectsView`、`SessionLink`、`parseSessionListScope`、`IPC.projectsGet`、`IPC.projectsState`;既有 `SessionStore.cwdOf`。
- Produces(Task 14 用):

```ts
export interface SessionSource {
  list(): Promise<readonly SessionSummary[]>
  loadHistory(sessionId: string): Promise<readonly Event[]>
  cwdOf(sessionId: string): string | undefined
}
/** 每個專案一份的執行環境,由 index.ts 用該專案的 rootPath 組出來。 */
export interface ProjectRuntime {
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  readonly viewTools?: ViewToolHooks
  /** 收掉這份執行環境專屬的資源(Task 10 的每專案 MCP server);core dispose 之後呼叫。 */
  readonly dispose?: () => void
}
export interface IpcBridgeDeps {
  readonly webContents: WebContents
  readonly projects: ProjectsService
  readonly sessions: SessionSource
  readonly runtimeFor: (projectId: string, rootPath: string, isActive: () => boolean) => ProjectRuntime
  readonly logError: (error: Error) => void
  readonly homeDir: string
  readonly queryFn?: QueryFn
  readonly approvalTimeoutMs?: number
  readonly createHost?: typeof createAgentHost
  readonly createRegistry?: typeof createApprovalRegistry
  readonly terminalPort?: number
  /** 測試用接縫:換掉對話核心。 */
  readonly createConversation?: typeof createConversation
}
export function createIpcBridge(deps: IpcBridgeDeps): { dispose(): Promise<void> }
```

路由器的規則,實作與測試都照這幾條:

1. 一個專案一個 `Conversation`(Task 6),存在 `slots: Map<projectId, { core, runtime }>`;第一次需要時才建(切成 active、或收到它的訊息),`initialSessionId` 取該專案 thread 鏈最後一筆。
2. 只有 active 專案的 core 是 `active`。`activeId` 改變時:先推一次 `projects:state`,再舊 core `deactivate()`、舊 runtime 的 `viewTools.abortPending(MSG.browserBusy)`、新 core `activate()`。先推的理由:renderer 收到新 `activeId` 才會清掉前一個專案的批准卡(Task 12 的 `useApprovals`),`activate()` 交出去的扣住批准隨後才送到,不會被一起清掉。啟動時對 `projects.state().activeId` 做一次同樣的事。
3. renderer 送來的 `agent:input`、`agent:approval:reply`、`handoff:done`、`session:intent:*` 都轉給 active core;沒有 active 專案就記錯誤丟棄:`${channel}：沒有 active 專案，已丟棄`。
4. `session:intent:start-new` 先 `startThread`(新 thread 成為對話分頁指向)再 `core.startNew()`;`session:intent:open-history` 先 `pointConversationAt`(該 session 已在某條 thread 上就指過去,否則開一條只含它的 thread)再 `core.openHistory()`。session 的 cwd 用 `sessions.cwdOf`,查不到退回專案 rootPath。
5. core 回報 `onSessionStarted(sessionId, cwd)` 時 `recordSession` 進該專案現行 thread;`transcriptPath` 用 `transcriptPathFor(homeDir, cwd ?? rootPath, sessionId)`。
6. `projects:state` 在專案狀態任何改變、以及任一 core 的 `onHeldChange` 時推送;內容是 `ProjectsView`(`available` 問 `projects.isAvailable`,`pendingApproval` = 該 core `heldApprovals() > 0`)。
7. `projects:get`(invoke)先叫 active core `replay()`(renderer 剛載入或重載,需要重送對話內容),再回傳 `ProjectsView`。
8. `session:list` 的 payload 是 `SessionListScope`:`projectId: null` 回全部,否則只回 `cwd === rootPathOf(projectId)` 的;未知 projectId 回空陣列。
9. 專案被移除時 `dispose()` 它的 core、再叫 `runtime.dispose?.()`,並從 `slots` 刪掉。bridge `dispose()`:取消訂閱、拆 ipc handler、所有 core `dispose()` 後各自 `runtime.dispose?.()`。
10. 專案的 `rootPath` 改變(使用者重新指定資料夾,規格 §6)時同樣 `dispose()` 舊 core 與 runtime:它的 sessionOptions 綁著舊 cwd。若它是 active 專案,下一次需要時重建並 `activate()`。

- [ ] **Step 1: `MSG` 加 `browserBusy`**

在 `src/main/view-tools/errors.ts` 的 `MSG` 物件裡,`sessionEnded: '對話已結束',` 這一行後面加:

```ts
  browserBusy: '瀏覽器正由前景專案使用',
```

這是規格 §3.4 給背景專案的錯誤文案。Task 10 的專案守衛也用這個常數。

- [ ] **Step 2: 重寫測試 `tests/ipc-bridge.test.ts`**

整檔換成以下內容。假的對話核心把每次呼叫記進 `log`,用 `sessionOptions` 函式的身分對回 projectId。

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { Event } from '../src/shared/events.js'
import { IPC, type SessionSummary } from '../src/shared/ipc.js'
import { EMPTY_PROJECTS_STATE, type ProjectsState, type ProjectsView } from '../src/shared/projects.js'
import {
  addProject, createProjectEntry, currentThread, findProject, recordSession, relocateProject, removeProject, setActive,
} from '../src/main/projects-state.js'
import { createProjectsService } from '../src/main/projects-service.js'
import type { Conversation, ConversationDeps } from '../src/main/conversation.js'
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

const SESSIONS: readonly SessionSummary[] = [
  { sessionId: 's-1', summary: '一', lastModified: 1, cwd: '/p/alpha' },
  { sessionId: 's-2', summary: '二', lastModified: 2, cwd: '/p/beta' },
  { sessionId: 's-9', summary: '九', lastModified: 9, cwd: '/p/other' },
]

function twoProjects(): ProjectsState {
  const a = createProjectEntry({ id: A, rootPath: '/p/alpha', conversationTabId: 'tab-a', threadId: 'th-a', now: NOW })
  const b = createProjectEntry({ id: B, rootPath: '/p/beta', conversationTabId: 'tab-b', threadId: 'th-b', now: NOW })
  return addProject(addProject(EMPTY_PROJECTS_STATE, a), b)
}

interface FakeCore {
  readonly core: Conversation
  readonly deps: ConversationDeps
  setHeld(n: number): void
}

function makeFakeCore(tag: string, deps: ConversationDeps, record: (entry: string) => void): FakeCore {
  let held = 0
  let active = false
  const core: Conversation = {
    userInput: (text) => { record(`${tag}.userInput(${text})`) },
    approvalReply: (requestId, decision) => { record(`${tag}.approvalReply(${requestId},${decision})`) },
    startNew: () => { record(`${tag}.startNew`) },
    openHistory: (sessionId) => { record(`${tag}.openHistory(${sessionId})`) },
    handoffDone: (toolUseId) => { record(`${tag}.handoffDone(${toolUseId})`) },
    activate: () => { active = true; record(`${tag}.activate`) },
    deactivate: () => { active = false; record(`${tag}.deactivate`) },
    replay: () => { record(`${tag}.replay`) },
    isActive: () => active,
    heldApprovals: () => held,
    sessionState: () => ({ kind: 'idle' }),
    dispose: async () => { record(`${tag}.dispose`) },
  }
  return { core, deps, setHeld: (n) => { held = n } }
}

function makeRig(initial: ProjectsState, extra: Partial<IpcBridgeDeps> = {}) {
  listeners.clear()
  handlers.clear()
  const log: string[] = []
  /** core 呼叫與送出的 channel 混在一起依序記,用來驗證「先推 projects:state 再切換」這種順序。 */
  const timeline: string[] = []
  const record = (entry: string): void => { log.push(entry); timeline.push(entry) }
  const errors: string[] = []
  const sent: string[] = []
  const lastSent = new Map<string, unknown>()
  const aborts: string[] = []
  const fakes = new Map<string, FakeCore>()
  const byOptions = new Map<ConversationDeps['sessionOptions'], string>()
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
    list: async () => SESSIONS,
    loadHistory: async (): Promise<readonly Event[]> => [],
    cwdOf: (sessionId) => SESSIONS.find((s) => s.sessionId === sessionId)?.cwd,
  }
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push(channel)
      timeline.push(channel)
      lastSent.set(channel, payload)
    },
  } as unknown as WebContents
  const bridge = createIpcBridge({
    webContents,
    projects: service,
    sessions,
    homeDir: '/home/u',
    logError: (e) => { errors.push(e.message) },
    runtimeFor: (projectId, rootPath) => {
      const sessionOptions = (resumeSessionId?: string): SessionOptions =>
        ({ projectId, rootPath, resumeSessionId }) as unknown as SessionOptions
      byOptions.set(sessionOptions, projectId)
      return {
        sessionOptions,
        viewTools: {
          autoAllow: () => false,
          handoffDone: () => {},
          abortPending: (reason) => { aborts.push(`${projectId}:${reason}`) },
        },
        dispose: () => { log.push(`${projectId}.runtime.dispose`) },
      }
    },
    createConversation: (deps) => {
      const projectId = byOptions.get(deps.sessionOptions) ?? 'unknown'
      const fake = makeFakeCore(projectId, deps, record)
      fakes.set(projectId, fake)
      return fake.core
    },
    ...extra,
  })
  const fire = (channel: string, payload?: unknown): void => {
    const fn = listeners.get(channel)
    if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
    fn({}, payload)
  }
  const invoke = async (channel: string, payload?: unknown): Promise<unknown> => {
    const fn = handlers.get(channel)
    if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
    return fn({}, payload)
  }
  const fake = (id: string): FakeCore => {
    const f = fakes.get(id)
    if (f === undefined) throw new Error(`專案 ${id} 還沒建 core`)
    return f
  }
  const view = (): ProjectsView => lastSent.get(IPC.projectsState) as ProjectsView
  return { bridge, service, log, timeline, errors, sent, aborts, fakes, fake, fire, invoke, view }
}

beforeEach(() => { listeners.clear(); handlers.clear() })

describe('啟動與切換', () => {
  it('啟動只為 active 專案建 core 並 activate;initialSessionId 取 thread 鏈最後一筆', () => {
    const rig = makeRig(twoProjects())
    expect(rig.log).toEqual(['proj-a.activate'])
    expect(rig.fakes.has(B)).toBe(false)
    expect(rig.fake(A).deps.initialSessionId).toBeUndefined()

    const link = { sessionId: 's-1', transcriptPath: '/t/s-1.jsonl', parentSessionId: null, startedAt: 1, endedAt: null, endReason: null }
    const linked = recordSession(twoProjects(), A, 'th-a', link)
    expect(makeRig(linked).fake(A).deps.initialSessionId).toBe('s-1')
  })

  it('重新指定資料夾:core 重建成新 rootPath,active 專案重新 activate', () => {
    const rig = makeRig(twoProjects())
    rig.log.length = 0
    rig.service.update((s) => relocateProject(s, A, '/p/alpha2'))
    expect(rig.log).toEqual(['proj-a.dispose', 'proj-a.runtime.dispose', 'proj-a.activate'])
    const opts = rig.fake(A).deps.sessionOptions() as unknown as { rootPath: string }
    expect(opts.rootPath).toBe('/p/alpha2')
    expect(rig.view().projects[0]?.rootPath).toBe('/p/alpha2')
  })

  it('activeId 改變:先推 projects:state,再舊 core deactivate、舊 view tools 收 browserBusy、新 core activate', () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    expect(rig.log).toEqual(['proj-a.activate', 'proj-a.deactivate', 'proj-b.activate'])
    // 規則 2 的順序:renderer 先拿到新 activeId,才輪到 B activate 把扣住的批准交出去
    expect(rig.timeline.slice(-3)).toEqual([IPC.projectsState, 'proj-a.deactivate', 'proj-b.activate'])
    expect(rig.aborts).toEqual(['proj-a:瀏覽器正由前景專案使用'])
    expect(rig.view().activeId).toBe(B)
    expect(rig.fake(B).core.isActive()).toBe(true)
    expect(rig.fake(A).core.isActive()).toBe(false)
  })

  it('沒有專案時啟動不建任何 core;有訊息進來記錯誤丟棄', () => {
    const rig = makeRig(EMPTY_PROJECTS_STATE)
    rig.fire(IPC.userInput, '嗨')
    expect(rig.fakes.size).toBe(0)
    expect(rig.errors).toEqual(['agent:input：沒有 active 專案，已丟棄'])
  })

  it('移除背景專案:它的 core dispose,active 不動', () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    rig.service.update((s) => setActive(s, A, NOW))
    rig.log.length = 0
    rig.service.update((s) => removeProject(s, B))
    expect(rig.log).toEqual(['proj-b.dispose', 'proj-b.runtime.dispose'])
    expect(rig.view().projects.map((p) => p.id)).toEqual([A])
  })

  it('移除 active 專案:它的 core dispose,下一個專案 activate', () => {
    const rig = makeRig(twoProjects())
    rig.log.length = 0
    rig.service.update((s) => removeProject(s, A))
    expect(rig.log).toEqual(['proj-a.dispose', 'proj-a.runtime.dispose', 'proj-b.activate'])
  })
})

describe('轉送給 active core', () => {
  it('agent:input、approval:reply、handoff:done 都到 active core', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.userInput, '嗨')
    rig.fire(IPC.approvalReply, { requestId: 'r-1', decision: 'allow' })
    rig.fire(IPC.handoffDone, { toolUseId: 't-1' })
    expect(rig.log.slice(1)).toEqual([
      'proj-a.userInput(嗨)',
      'proj-a.approvalReply(r-1,allow)',
      'proj-a.handoffDone(t-1)',
    ])
  })

  it('payload 形狀不符:記錯誤,不轉送', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.userInput, 42)
    expect(rig.errors).toEqual(['agent:input：payload 形狀不符（number），已丟棄'])
    expect(rig.log).toEqual(['proj-a.activate'])
  })

  it('start-new:先開新 thread 再 core.startNew', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.intentStartNew)
    const entry = findProject(rig.service.state(), A)
    expect(entry?.threads.map((t) => t.id)).toEqual(['th-a', 'id-1'])
    expect(currentThread(entry!)?.id).toBe('id-1')
    expect(rig.log.at(-1)).toBe('proj-a.startNew')
  })

  it('open-history:把 session 記進 thread(用 session 自己的 cwd 算 transcript 路徑)再 core.openHistory', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-9' })
    const thread = currentThread(findProject(rig.service.state(), A)!)
    expect(thread?.sessions).toEqual([
      expect.objectContaining({
        sessionId: 's-9',
        transcriptPath: '/home/u/.claude/projects/-p-other/s-9.jsonl',
        parentSessionId: null,
        endedAt: null,
      }),
    ])
    expect(rig.log.at(-1)).toBe('proj-a.openHistory(s-9)')
  })

  it('open-history 的 session 查不到 cwd:退回專案 rootPath', () => {
    const rig = makeRig(twoProjects())
    rig.fire(IPC.intentOpenHistory, { sessionId: 's-unknown' })
    const thread = currentThread(findProject(rig.service.state(), A)!)
    expect(thread?.sessions[0]?.transcriptPath).toBe('/home/u/.claude/projects/-p-alpha/s-unknown.jsonl')
  })
})

describe('core 回報', () => {
  it('onSessionStarted 記進現行 thread;沒有 cwd 就用 rootPath', () => {
    const rig = makeRig(twoProjects())
    rig.fake(A).deps.onSessionStarted?.('s-5', undefined)
    const thread = currentThread(findProject(rig.service.state(), A)!)
    expect(thread?.sessions.map((s) => s.sessionId)).toEqual(['s-5'])
    expect(thread?.sessions[0]?.transcriptPath).toBe('/home/u/.claude/projects/-p-alpha/s-5.jsonl')
    expect(rig.fake(A).deps.initialSessionId).toBeUndefined()
  })

  it('onHeldChange 推 projects:state,pendingApproval 跟著 heldApprovals', () => {
    const rig = makeRig(twoProjects())
    rig.sent.length = 0
    rig.fake(A).setHeld(1)
    rig.fake(A).deps.onHeldChange?.(1)
    expect(rig.sent).toEqual([IPC.projectsState])
    expect(rig.view().projects.find((p) => p.id === A)?.pendingApproval).toBe(true)
    expect(rig.view().projects.find((p) => p.id === B)?.pendingApproval).toBe(false)
  })

  it('sink 把事件與狀態送到 webContents,approvalAsk 在 webContents 銷毀時 throw', () => {
    const rig = makeRig(twoProjects())
    rig.fake(A).deps.sink.events([{ kind: 'reset' } as Event])
    rig.fake(A).deps.sink.state({ kind: 'idle' })
    expect(rig.sent.filter((c) => c !== IPC.projectsState)).toEqual([IPC.eventsBatch, IPC.sessionState])
    const gone = makeRig(twoProjects(), {
      webContents: { isDestroyed: () => true, send: () => {} } as unknown as WebContents,
    })
    expect(() => gone.fake(A).deps.sink.approvalAsk({ requestId: 'r', toolUseId: 't', toolName: 'x', input: {} }))
      .toThrow('agent:approval:ask：webContents 已銷毀')
  })
})

describe('invoke 通道', () => {
  it('projects:get 先 replay 再回 view;available 反映 isDir', () => {
    const state = addProject(twoProjects(), createProjectEntry({ id: 'proj-c', rootPath: '/p/gone', conversationTabId: 'tab-c', threadId: 'th-c', now: NOW }))
    const rig = makeRig(state)
    const view = (await rig.invoke(IPC.projectsGet)) as ProjectsView
    expect(rig.log.at(-1)).toBe('proj-a.replay')
    expect(view.activeId).toBe(A)
    expect(view.projects.map((p) => [p.id, p.available, p.activeTabId])).toEqual([
      [A, true, 'tab-a'],
      [B, true, 'tab-b'],
      ['proj-c', false, 'tab-c'],
    ])
  })

  it('session:list 依 projectId 過濾;null 回全部;未知 id 回空', async () => {
    const rig = makeRig(twoProjects())
    const mine = (await rig.invoke(IPC.sessionList, { projectId: A })) as readonly SessionSummary[]
    expect(mine.map((s) => s.sessionId)).toEqual(['s-1'])
    const all = (await rig.invoke(IPC.sessionList, { projectId: null })) as readonly SessionSummary[]
    expect(all).toHaveLength(3)
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

  it('terminal:endpoint 有 terminalPort 才註冊', async () => {
    const without = makeRig(twoProjects())
    await expect(without.invoke(IPC.terminalEndpoint)).rejects.toThrow('沒有註冊')
    const withPort = makeRig(twoProjects(), { terminalPort: 4321 })
    expect(await withPort.invoke(IPC.terminalEndpoint)).toEqual({ port: 4321 })
  })
})

describe('dispose', () => {
  it('拆掉所有 handler、dispose 所有 core、之後專案改變不再推送', async () => {
    const rig = makeRig(twoProjects())
    rig.service.update((s) => setActive(s, B, NOW))
    rig.log.length = 0
    await rig.bridge.dispose()
    expect(rig.log.sort()).toEqual(['proj-a.dispose', 'proj-a.runtime.dispose', 'proj-b.dispose', 'proj-b.runtime.dispose'])
    expect(listeners.size).toBe(0)
    expect(handlers.size).toBe(0)
    rig.sent.length = 0
    rig.service.update((s) => setActive(s, A, NOW))
    expect(rig.sent).toEqual([])
    await rig.bridge.dispose()
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: FAIL,`createIpcBridge` 的 deps 沒有 `projects`／`runtimeFor`(typecheck 錯誤或執行期 undefined)。

- [ ] **Step 4: 重寫 `src/main/ipc-bridge.ts`**

整檔換成:

```ts
import { ipcMain, type WebContents } from 'electron'
import type { Event } from '../shared/events.js'
import type { SessionState } from '../shared/session-state.js'
import {
  IPC,
  parseApprovalReply,
  parseHandoffDone,
  parseIntentOpenHistory,
  parseUserInput,
  type ApprovalAskPayload,
  type SessionSummary,
} from '../shared/ipc.js'
import { parseSessionListScope, type ProjectsView, type SessionLink } from '../shared/projects.js'
import { asError, type QueryFn, type createAgentHost } from './agent-host.js'
import type { createApprovalRegistry } from './approval.js'
import {
  createConversation as defaultCreateConversation,
  type Conversation,
  type ViewToolHooks,
} from './conversation.js'
import type { ProjectsService } from './projects-service.js'
import {
  activeTabId,
  currentThread,
  findProject,
  lastSessionId,
  pointConversationAt,
  recordSession,
  startThread,
} from './projects-state.js'
import type { SessionOptions } from './session-args.js'
import { transcriptPathFor } from './transcript-path.js'
import { MSG } from './view-tools/errors.js'

export type { ViewToolHooks }

export interface SessionSource {
  list(): Promise<readonly SessionSummary[]>
  loadHistory(sessionId: string): Promise<readonly Event[]>
  /** transcript 記的 cwd;SDK 列表裡沒有這個 session 時回 undefined。 */
  cwdOf(sessionId: string): string | undefined
}

/** 每個專案一份的執行環境,由 index.ts 用該專案的 rootPath 與 view tools 組出來。 */
export interface ProjectRuntime {
  readonly sessionOptions: (resumeSessionId?: string) => SessionOptions
  readonly viewTools?: ViewToolHooks
  /** 收掉這份執行環境專屬的資源(Task 10 的每專案 MCP server);core dispose 之後呼叫。 */
  readonly dispose?: () => void
}

export interface IpcBridgeDeps {
  readonly webContents: WebContents
  readonly projects: ProjectsService
  readonly sessions: SessionSource
  readonly runtimeFor: (projectId: string, rootPath: string, isActive: () => boolean) => ProjectRuntime
  readonly logError: (error: Error) => void
  /** `os.homedir()`,transcript 路徑的根。 */
  readonly homeDir: string
  readonly queryFn?: QueryFn
  readonly approvalTimeoutMs?: number
  readonly createHost?: typeof createAgentHost
  readonly createRegistry?: typeof createApprovalRegistry
  readonly terminalPort?: number
  /** 測試用接縫:換掉對話核心。 */
  readonly createConversation?: typeof defaultCreateConversation
}

export interface IpcBridge {
  dispose(): Promise<void>
}

interface Slot {
  readonly core: Conversation
  readonly runtime: ProjectRuntime
  /** 建 core 時的 rootPath;之後被重新指定就整個 core 重建。 */
  readonly rootPath: string
}

/**
 * 專案路由器:renderer 只有一份,主行程每個專案一份對話核心(Task 6)。
 * 這裡只做三件事:把 renderer 的訊息轉給 active 專案、把專案狀態推給 renderer、
 * 在 active 專案改變時切換前景。對話本身的狀態機、批准、事件流都在 conversation.ts。
 */
export function createIpcBridge(deps: IpcBridgeDeps): IpcBridge {
  const slots = new Map<string, Slot>()
  let currentId: string | null = null
  let disposed = false

  const contents = (): WebContents | null => {
    if (disposed || deps.webContents.isDestroyed()) return null
    return deps.webContents
  }

  /** 送不出去就 throw。對話核心把 throw 當成「視窗關了」的訊號,立即 deny。 */
  const sendOrThrow = (channel: string, payload: unknown): void => {
    const wc = contents()
    if (wc === null) throw new Error(`${channel}：webContents 已銷毀`)
    wc.send(channel, payload)
  }

  const sendBestEffort = (channel: string, payload: unknown): void => {
    const wc = contents()
    if (wc === null) {
      // 收尾途中送不出去是預期行為,不必吵;其餘情況要留下記錄。
      if (!disposed) deps.logError(new Error(`${channel}：視窗已不可用，這則訊息未送達`))
      return
    }
    wc.send(channel, payload)
  }

  // ---- 專案狀態 → renderer ----

  const composeView = (): ProjectsView => {
    const state = deps.projects.state()
    return {
      activeId: state.activeId,
      projects: state.projects.map((p) => ({
        id: p.id,
        name: p.name,
        rootPath: p.rootPath,
        available: deps.projects.isAvailable(p.id),
        pendingApproval: (slots.get(p.id)?.core.heldApprovals() ?? 0) > 0,
        tabs: p.tabs,
        activeTabId: activeTabId(p),
        threads: p.threads,
      })),
    }
  }

  const pushProjects = (): void => {
    sendBestEffort(IPC.projectsState, composeView())
  }

  // ---- thread 記錄 ----

  const linkFor = (rootPath: string, sessionId: string, cwd: string | undefined): SessionLink => ({
    sessionId,
    transcriptPath: transcriptPathFor(deps.homeDir, cwd ?? rootPath, sessionId),
    parentSessionId: null,
    startedAt: deps.projects.now(),
    endedAt: null,
    endReason: null,
  })

  const recordStarted = (projectId: string, sessionId: string, cwd: string | undefined): void => {
    deps.projects.update((state) => {
      const entry = findProject(state, projectId)
      const thread = entry === undefined ? undefined : currentThread(entry)
      if (entry === undefined || thread === undefined) return state
      return recordSession(state, projectId, thread.id, linkFor(entry.rootPath, sessionId, cwd))
    })
  }

  // ---- 每個專案一份 core ----

  const createSlot = (projectId: string, rootPath: string): Slot => {
    const runtime = deps.runtimeFor(projectId, rootPath, () => currentId === projectId)
    const entry = findProject(deps.projects.state(), projectId)
    const make = deps.createConversation ?? defaultCreateConversation
    const core = make({
      sink: {
        events: (batch: readonly Event[]) => sendBestEffort(IPC.eventsBatch, batch),
        state: (state: SessionState) => sendBestEffort(IPC.sessionState, state),
        approvalAsk: (payload: ApprovalAskPayload) => sendOrThrow(IPC.approvalAsk, payload),
      },
      sessionOptions: runtime.sessionOptions,
      loadHistory: (sessionId) => deps.sessions.loadHistory(sessionId),
      logError: deps.logError,
      onSessionStarted: (sessionId, cwd) => recordStarted(projectId, sessionId, cwd),
      onHeldChange: pushProjects,
      initialSessionId: entry === undefined ? undefined : lastSessionId(entry),
      viewTools: runtime.viewTools,
      queryFn: deps.queryFn,
      approvalTimeoutMs: deps.approvalTimeoutMs,
      createHost: deps.createHost,
      createRegistry: deps.createRegistry,
    })
    return { core, runtime, rootPath }
  }

  const slotFor = (projectId: string): Slot | undefined => {
    const existing = slots.get(projectId)
    if (existing !== undefined) return existing
    const rootPath = deps.projects.rootPathOf(projectId)
    if (rootPath === undefined) return undefined
    const created = createSlot(projectId, rootPath)
    slots.set(projectId, created)
    return created
  }

  const activeSlot = (): Slot | undefined => (currentId === null ? undefined : slotFor(currentId))

  /** 規格 §3.3、§3.4:舊專案退到背景(回合跑完才 sleep),進行中的瀏覽器工具呼叫收到明確錯誤。 */
  const switchTo = (nextId: string | null): void => {
    if (nextId === currentId) return
    const prev = currentId === null ? undefined : slots.get(currentId)
    currentId = nextId
    if (prev !== undefined) {
      prev.core.deactivate()
      prev.runtime.viewTools?.abortPending(MSG.browserBusy)
    }
    activeSlot()?.core.activate()
  }

  const disposeSlot = (projectId: string, slot: Slot): void => {
    slots.delete(projectId)
    slot.core.dispose().catch((err: unknown) => deps.logError(asError(err, `dispose(${projectId})`)))
    slot.runtime.dispose?.()
  }

  const unsubscribe = deps.projects.subscribe((next, prev) => {
    for (const [projectId, slot] of [...slots]) {
      const after = findProject(next, projectId)
      // 專案被移除,或資料夾被重新指定(規格 §6):這個 core 綁的 cwd 已經不對,收掉重建。
      if (after === undefined || after.rootPath !== slot.rootPath) disposeSlot(projectId, slot)
    }
    if (next.activeId !== prev.activeId) {
      // 規則 2:先讓 renderer 知道 activeId 換了,它才能在新專案的批准卡送到之前清掉舊的。
      pushProjects()
      switchTo(next.activeId)
      return
    }
    if (next.activeId !== null && !slots.has(next.activeId)) activeSlot()?.core.activate()
    pushProjects()
  })

  // ---- renderer → active core ----

  const guard = (label: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      deps.logError(asError(err, label))
    }
  }

  const rejectPayload = (channel: string, raw: unknown): Error =>
    new Error(`${channel}：payload 形狀不符（${typeof raw}），已丟棄`)

  const withActive = (channel: string, fn: (slot: Slot, projectId: string) => void): void => {
    const slot = activeSlot()
    if (slot === undefined || currentId === null) {
      deps.logError(new Error(`${channel}：沒有 active 專案，已丟棄`))
      return
    }
    fn(slot, currentId)
  }

  const onUserInput = (_event: unknown, raw: unknown): void =>
    guard(IPC.userInput, () => {
      const text = parseUserInput(raw)
      if (text === null) {
        deps.logError(rejectPayload(IPC.userInput, raw))
        return
      }
      withActive(IPC.userInput, (slot) => slot.core.userInput(text))
    })

  const onApprovalReply = (_event: unknown, raw: unknown): void =>
    guard(IPC.approvalReply, () => {
      const reply = parseApprovalReply(raw)
      if (reply === null) {
        deps.logError(rejectPayload(IPC.approvalReply, raw))
        return
      }
      withActive(IPC.approvalReply, (slot) => slot.core.approvalReply(reply.requestId, reply.decision))
    })

  const onHandoffDone = (_event: unknown, raw: unknown): void =>
    guard(IPC.handoffDone, () => {
      const payload = parseHandoffDone(raw)
      if (payload === null) {
        deps.logError(rejectPayload(IPC.handoffDone, raw))
        return
      }
      withActive(IPC.handoffDone, (slot) => slot.core.handoffDone(payload.toolUseId))
    })

  const onIntentStartNew = (): void =>
    guard(IPC.intentStartNew, () => {
      withActive(IPC.intentStartNew, (slot, projectId) => {
        deps.projects.update((state) => startThread(state, projectId, deps.projects.newId(), deps.projects.now()))
        slot.core.startNew()
      })
    })

  const onIntentOpenHistory = (_event: unknown, raw: unknown): void =>
    guard(IPC.intentOpenHistory, () => {
      const payload = parseIntentOpenHistory(raw)
      if (payload === null) {
        deps.logError(rejectPayload(IPC.intentOpenHistory, raw))
        return
      }
      withActive(IPC.intentOpenHistory, (slot, projectId) => {
        const link = linkFor(slot.rootPath, payload.sessionId, deps.sessions.cwdOf(payload.sessionId))
        deps.projects.update((state) =>
          pointConversationAt(state, projectId, link, deps.projects.newId(), deps.projects.now()),
        )
        slot.core.openHistory(payload.sessionId)
      })
    })

  // ---- invoke 通道 ----

  const onSessionList = async (_event: unknown, raw: unknown): Promise<readonly SessionSummary[]> => {
    const scope = parseSessionListScope(raw)
    if (scope === null) {
      const error = rejectPayload(IPC.sessionList, raw)
      deps.logError(error)
      throw error
    }
    try {
      const all = await deps.sessions.list()
      if (scope.projectId === null) return all
      const rootPath = deps.projects.rootPathOf(scope.projectId)
      return rootPath === undefined ? [] : all.filter((s) => s.cwd === rootPath)
    } catch (err) {
      const error = asError(err, IPC.sessionList)
      deps.logError(error)
      throw error
    }
  }

  /** renderer 剛載入(或重載)時呼叫:先把 active 專案的對話重送一遍,再給它專案清單。 */
  const onProjectsGet = (): ProjectsView => {
    activeSlot()?.core.replay()
    return composeView()
  }

  const onTerminalEndpoint = (): { port: number } => ({ port: deps.terminalPort! })

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    unsubscribe()
    ipcMain.removeListener(IPC.userInput, onUserInput)
    ipcMain.removeListener(IPC.approvalReply, onApprovalReply)
    ipcMain.removeListener(IPC.intentStartNew, onIntentStartNew)
    ipcMain.removeListener(IPC.intentOpenHistory, onIntentOpenHistory)
    ipcMain.removeListener(IPC.handoffDone, onHandoffDone)
    ipcMain.removeHandler(IPC.sessionList)
    ipcMain.removeHandler(IPC.projectsGet)
    if (deps.terminalPort !== undefined) ipcMain.removeHandler(IPC.terminalEndpoint)
    await Promise.all([...slots.values()].map((slot) => slot.core.dispose()))
    for (const slot of slots.values()) slot.runtime.dispose?.()
  }

  ipcMain.on(IPC.userInput, onUserInput)
  ipcMain.on(IPC.approvalReply, onApprovalReply)
  ipcMain.on(IPC.intentStartNew, onIntentStartNew)
  ipcMain.on(IPC.intentOpenHistory, onIntentOpenHistory)
  ipcMain.on(IPC.handoffDone, onHandoffDone)
  ipcMain.handle(IPC.sessionList, onSessionList)
  ipcMain.handle(IPC.projectsGet, onProjectsGet)
  if (deps.terminalPort !== undefined) ipcMain.handle(IPC.terminalEndpoint, onTerminalEndpoint)

  switchTo(deps.projects.state().activeId)

  return { dispose }
}
```

注意兩點:

- `switchTo` 先把 `currentId` 改成新值,再叫舊 core `deactivate()`。這樣 `runtimeFor` 拿到的 `isActive` 閉包在 `abortPending` 執行時已經回 false,Task 10 的專案守衛不會在切換瞬間放行一個排在後面的呼叫。
- `dispose()` 走 `slots` 而不是 `deps.projects.state()`:沒建過 core 的專案沒有東西要收。

- [ ] **Step 5: 跑測試與 typecheck**

Run: `npx vitest run tests/ipc-bridge.test.ts tests/conversation.test.ts && npm run typecheck`
Expected: 兩個檔案全綠。typecheck 會在 `src/main/index.ts` 報錯(`createIpcBridge` 的 deps 變了),那是 Task 14 的事;本 task 的 typecheck 只要求 `src/main/ipc-bridge.ts` 與 `tests/ipc-bridge.test.ts` 沒有錯誤。把 index.ts 的錯誤原文貼進 report 的 concerns。

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-bridge.ts src/main/view-tools/errors.ts tests/ipc-bridge.test.ts
git commit -m "refactor: ipc-bridge 改成專案路由器,對話核心改為每個專案一份"
```

---

### Task 8: 專案與分頁的 IPC 處理 `projects-ipc.ts`

**Files:**
- Create: `src/main/projects-ipc.ts`
- Test: `tests/projects-ipc.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `IPC.projectsAdd`／`projectsRelocate`／`projectsRemove`／`projectsActivate`／`tabsOpen`／`tabsClose`／`tabsActivate`、`parseProjectId`、`parseTabOpen`、`parseTabTarget`、`AddProjectResult`;Task 3 的 `addProject`、`createProjectEntry`、`relocateProject`、`removeProject`、`setActive`、`openTab`、`closeTab`、`focusTab`、`findProject`;Task 4 的 `ProjectsService`。
- Produces(Task 14 用):

```ts
export interface ProjectsIpcDeps {
  readonly service: ProjectsService
  /** 開資料夾選擇器;使用者取消回 undefined。 */
  readonly pickFolder: () => Promise<string | undefined>
  /** 這個資料夾能不能當專案:可以回 undefined,不行回給使用者看的原因。 */
  readonly validateRoot: (rootPath: string) => string | undefined
  readonly logError: (error: Error) => void
}
/** 註冊全部 handler,回傳拆掉它們的函式。 */
export function registerProjectsIpc(deps: ProjectsIpcDeps): () => void
```

規則:

1. 這個檔只改 `ProjectsState`,不碰對話與終端:改完 state,Task 7 的路由器透過 `subscribe` 自己反應(切前景、推 `projects:state`)。
2. `projects:add`(invoke):選資料夾 → 取消回 `{ kind: 'cancelled' }` → `validateRoot` 有原因回 `{ kind: 'rejected', message }` → 同一個 rootPath 已經是專案就只切到它,回 `{ kind: 'added', id }` 不重複加 → 否則 `addProject` + `setActive`,回 `{ kind: 'added', id }`。三個 id(專案、對話分頁、第一條 thread)都由 `service.newId()` 產生。
3. `projects:relocate`(invoke,payload `{ id }`):未知 id 回 `{ kind: 'rejected', message: '找不到專案 ${id}' }`;之後與 add 一樣選資料夾、驗證;成功 `relocateProject`(分頁與 thread 都保留),回 `{ kind: 'added', id }`。
4. `projects:remove`、`projects:activate`(send,payload `{ id }`)、`tabs:open`(`{ projectId, label, command? }`)、`tabs:close`、`tabs:activate`(`{ projectId, tabId }`)直接套對應 reducer;reducer 對未知 id 回原 state,不必另外檢查。
5. payload 形狀不符:send 通道記錯誤 `${channel}：payload 形狀不符（${typeof raw}），已丟棄`;invoke 通道回 `{ kind: 'rejected', message: 'payload 形狀不符' }` 並記同一則錯誤。
6. `pickFolder` 或 reducer 丟出例外:記 `asError(err, channel)`;invoke 通道回 `{ kind: 'rejected', message: error.message }`。

- [ ] **Step 1: 寫失敗的測試 `tests/projects-ipc.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../src/shared/ipc.js'
import { EMPTY_PROJECTS_STATE, type AddProjectResult, type ProjectsState } from '../src/shared/projects.js'
import { activeTabId, addProject, createProjectEntry, findProject } from '../src/main/projects-state.js'
import { createProjectsService } from '../src/main/projects-service.js'
import { registerProjectsIpc, type ProjectsIpcDeps } from '../src/main/projects-ipc.js'

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
  return addProject(EMPTY_PROJECTS_STATE, a)
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
    pickFolder: async () => queue.shift(),
    validateRoot: (rootPath) => (rootPath.includes('bad') ? `不能用 ${rootPath}` : undefined),
    logError: (e) => { errors.push(e.message) },
    ...extra,
  })
  const fire = (channel: string, payload?: unknown): void => {
    const fn = listeners.get(channel)
    if (fn === undefined) throw new Error(`沒有註冊 ${channel}`)
    fn({}, payload)
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
  it('選到資料夾:加入、成為 active、一個對話分頁、一條 thread', async () => {
    const rig = makeRig(EMPTY_PROJECTS_STATE, ['/p/new'])
    expect(await rig.invoke(IPC.projectsAdd)).toEqual({ kind: 'added', id: 'id-1' })
    const s = rig.service.state()
    expect(s.activeId).toBe('id-1')
    const entry = findProject(s, 'id-1')
    expect(entry?.rootPath).toBe('/p/new')
    expect(entry?.name).toBe('new')
    expect(entry?.tabs.map((t) => [t.contentType, t.id, t.threadId])).toEqual([['conversation', 'id-2', 'id-3']])
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
    expect(entry?.tabs.map((t) => t.id)).toEqual(['tab-a'])
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
    expect(entry().tabs.map((t) => [t.id, t.label, t.command])).toEqual([
      ['tab-a', 'Claude 對話', undefined],
      ['id-1', 'zsh', undefined],
      ['id-2', 'codex', 'codex'],
    ])
    expect(activeTabId(entry())).toBe('id-2')
    rig.fire(IPC.tabsActivate, { projectId: A, tabId: 'tab-a' })
    expect(activeTabId(entry())).toBe('tab-a')
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(entry().tabs.map((t) => t.id)).toEqual(['tab-a', 'id-2'])
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'tab-a' })
    expect(entry().tabs.map((t) => t.id)).toEqual(['tab-a', 'id-2'])
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

  it('unregister 拆掉全部 handler', () => {
    const rig = makeRig(oneProject())
    expect(listeners.size + handlers.size).toBe(7)
    rig.unregister()
    expect(listeners.size + handlers.size).toBe(0)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-ipc.test.ts`
Expected: FAIL,找不到 `../src/main/projects-ipc.js`。

- [ ] **Step 3: 寫 `src/main/projects-ipc.ts`**

```ts
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc.js'
import {
  parseProjectId,
  parseTabOpen,
  parseTabTarget,
  type AddProjectResult,
  type ProjectsState,
} from '../shared/projects.js'
import { asError } from './agent-host.js'
import type { ProjectsService } from './projects-service.js'
import {
  addProject,
  closeTab,
  createProjectEntry,
  findProject,
  focusTab,
  openTab,
  relocateProject,
  removeProject,
  setActive,
} from './projects-state.js'

export interface ProjectsIpcDeps {
  readonly service: ProjectsService
  /** 開資料夾選擇器;使用者取消回 undefined。 */
  readonly pickFolder: () => Promise<string | undefined>
  /** 這個資料夾能不能當專案:可以回 undefined,不行回給使用者看的原因。 */
  readonly validateRoot: (rootPath: string) => string | undefined
  readonly logError: (error: Error) => void
}

type Reducer = (state: ProjectsState) => ProjectsState

const BAD_PAYLOAD = 'payload 形狀不符'

/**
 * 專案與分頁的 IPC:只改 `ProjectsState`。改完之後路由器(ipc-bridge)透過 subscribe
 * 自己切前景、推 `projects:state`,這裡不需要知道對話與終端的存在。
 */
export function registerProjectsIpc(deps: ProjectsIpcDeps): () => void {
  const { service } = deps

  const badPayload = (channel: string, raw: unknown): Error =>
    new Error(`${channel}：${BAD_PAYLOAD}（${typeof raw}），已丟棄`)

  /** 選資料夾並驗證;三種結果對應 `AddProjectResult` 的前兩種加上「可以用的路徑」。 */
  const pickValidFolder = async (): Promise<
    { readonly kind: 'ok'; readonly rootPath: string } | Exclude<AddProjectResult, { kind: 'added' }>
  > => {
    const picked = await deps.pickFolder()
    if (picked === undefined) return { kind: 'cancelled' }
    const reason = deps.validateRoot(picked)
    if (reason !== undefined) return { kind: 'rejected', message: reason }
    return { kind: 'ok', rootPath: picked }
  }

  const addNew = (rootPath: string): AddProjectResult => {
    const existing = service.state().projects.find((p) => p.rootPath === rootPath)
    const id = existing?.id ?? service.newId()
    service.update((state) => {
      const now = service.now()
      const withEntry = existing !== undefined
        ? state
        : addProject(state, createProjectEntry({
          id,
          rootPath,
          conversationTabId: service.newId(),
          threadId: service.newId(),
          now,
        }))
      return setActive(withEntry, id, now)
    })
    return { kind: 'added', id }
  }

  const onAdd = async (): Promise<AddProjectResult> => {
    try {
      const picked = await pickValidFolder()
      return picked.kind === 'ok' ? addNew(picked.rootPath) : picked
    } catch (err) {
      const error = asError(err, IPC.projectsAdd)
      deps.logError(error)
      return { kind: 'rejected', message: error.message }
    }
  }

  const onRelocate = async (_event: unknown, raw: unknown): Promise<AddProjectResult> => {
    const payload = parseProjectId(raw)
    if (payload === null) {
      deps.logError(badPayload(IPC.projectsRelocate, raw))
      return { kind: 'rejected', message: BAD_PAYLOAD }
    }
    if (findProject(service.state(), payload.id) === undefined) {
      return { kind: 'rejected', message: `找不到專案 ${payload.id}` }
    }
    try {
      const picked = await pickValidFolder()
      if (picked.kind !== 'ok') return picked
      service.update((state) => relocateProject(state, payload.id, picked.rootPath))
      return { kind: 'added', id: payload.id }
    } catch (err) {
      const error = asError(err, IPC.projectsRelocate)
      deps.logError(error)
      return { kind: 'rejected', message: error.message }
    }
  }

  /** send 通道共用:解析 → 套 reducer;任何一步失敗都只記錯誤。 */
  const onSend = <T>(channel: string, parse: (raw: unknown) => T | null, reduce: (payload: T) => Reducer) =>
    (_event: unknown, raw: unknown): void => {
      const payload = parse(raw)
      if (payload === null) {
        deps.logError(badPayload(channel, raw))
        return
      }
      try {
        service.update(reduce(payload))
      } catch (err) {
        deps.logError(asError(err, channel))
      }
    }

  const onRemove = onSend(IPC.projectsRemove, parseProjectId, ({ id }) => (s) => removeProject(s, id))
  const onActivate = onSend(IPC.projectsActivate, parseProjectId, ({ id }) => (s) => setActive(s, id, service.now()))
  const onTabOpen = onSend(IPC.tabsOpen, parseTabOpen, (p) => (s) =>
    openTab(s, p.projectId, { id: service.newId(), label: p.label, command: p.command }, service.now()))
  const onTabClose = onSend(IPC.tabsClose, parseTabTarget, (p) => (s) => closeTab(s, p.projectId, p.tabId, service.now()))
  const onTabActivate = onSend(IPC.tabsActivate, parseTabTarget, (p) => (s) => focusTab(s, p.projectId, p.tabId, service.now()))

  ipcMain.handle(IPC.projectsAdd, onAdd)
  ipcMain.handle(IPC.projectsRelocate, onRelocate)
  ipcMain.on(IPC.projectsRemove, onRemove)
  ipcMain.on(IPC.projectsActivate, onActivate)
  ipcMain.on(IPC.tabsOpen, onTabOpen)
  ipcMain.on(IPC.tabsClose, onTabClose)
  ipcMain.on(IPC.tabsActivate, onTabActivate)

  return () => {
    ipcMain.removeHandler(IPC.projectsAdd)
    ipcMain.removeHandler(IPC.projectsRelocate)
    ipcMain.removeListener(IPC.projectsRemove, onRemove)
    ipcMain.removeListener(IPC.projectsActivate, onActivate)
    ipcMain.removeListener(IPC.tabsOpen, onTabOpen)
    ipcMain.removeListener(IPC.tabsClose, onTabClose)
    ipcMain.removeListener(IPC.tabsActivate, onTabActivate)
  }
}
```

`openTab` 的 `NewTabInput.command` 是可選欄位;`command: p.command` 在沒有 `exactOptionalPropertyTypes` 的設定下可直接傳 `undefined`,reducer 內已用 `tab.command === undefined ? {} : { command }` 處理,不會把 `command: undefined` 寫進狀態檔。

- [ ] **Step 4: 跑測試與 typecheck**

Run: `npx vitest run tests/projects-ipc.test.ts && npx tsc --noEmit -p . 2>&1 | grep -v "src/main/index.ts" | grep -v "src/preload" || true`
Expected: 測試全綠;typecheck 除了 `index.ts` 與 preload(Task 11、14 才改)以外沒有錯誤。

- [ ] **Step 5: Commit**

```bash
git add src/main/projects-ipc.ts tests/projects-ipc.test.ts
git commit -m "feat: 加入專案與分頁的 IPC 處理,含資料夾選擇與驗證"
```

---

### Task 9: 終端機 `open` 帶 `projectId`,伺服器查登錄表換 cwd

**Files:**
- Modify: `src/main/terminal-server.ts`(`handleConnection` 第 48–114 行、`startTerminalServer` 第 134–164 行)
- Modify: `src/renderer/terminal-client.ts`(`TerminalClient.open` 第 2 行與第 50–51 行)
- Modify: `src/renderer/components/Terminal.tsx`(props 第 8 行、`client.open` 第 36 行、effect deps 第 41 行)
- Modify: `tests/terminal-server.test.ts`
- Modify: `tests/terminal-client.test.ts`(第 17–18、23–26 行)
- Modify: `docs/specs/2026-09-07-yeschef-c-terminals-design.md` §5(第 54、82、90、92 行)、§9(第 122 行)、§10 修訂紀錄

**Interfaces:**
- Consumes:`ProjectsService.rootPathOf(id): string | undefined`(Task 4;Task 14 把它包成 `resolveCwd` 傳進來)。
- Produces:
  ```ts
  // src/main/terminal-server.ts
  export type ResolveCwd = (projectId: string) => string | undefined
  export function handleConnection(socket: SocketLike, spawn: SpawnPty, resolveCwd: ResolveCwd, logError: (e: Error) => void, commandExists?: (command: string) => boolean): void
  export function startTerminalServer(resolveCwd: ResolveCwd, logError: (e: Error) => void): Promise<TerminalServer>
  // src/renderer/terminal-client.ts
  export interface TerminalClient { open(cols: number, rows: number, projectId: string, command?: string): void; sendInput(data: string): void; resize(cols: number, rows: number): void; close(): void }
  // src/renderer/components/Terminal.tsx
  export function Terminal(props: { readonly endpoint: string; readonly projectId: string; readonly command?: string }): React.ReactElement
  ```
  Task 12 的 `LeftPane` 以 `<Terminal endpoint={endpoint} projectId={project.id} command={tab.command} />` 使用。

規則(規格 §3.1、§3.2、§6):

1. `open` 訊息形狀改為 `{ type: 'open', cols, rows, projectId: string, command?: string }`。`projectId` 必填。
2. 伺服器收到 `open` 時用 `resolveCwd(projectId)` 換 cwd。`projectId` 缺少、不是字串、或 `resolveCwd` 回 `undefined`,一律:`logError` 一個訊息為「終端機 open 的 projectId 不合法或不認得(<原值>),已拒絕」的 Error、送 `{ type: 'exit', code: 1 }`、關 socket。不退回任何預設目錄。
3. 這條連線被拒絕後,之後的訊息照舊「open 之前的訊息忽略」處理(`pty` 仍是 `null`),不會再 spawn。
4. `startTerminalServer` 不再收固定 cwd,收 `resolveCwd`。Task 14 傳 `(id) => service.rootPathOf(id)`;不可用的專案(`isAvailable` 為 false)在這一層仍會回 rootPath,spawn 會因目錄不存在而拋錯,走既有的「spawn 失敗 → exit 1 → 關 socket」路徑,不另加判斷。
5. renderer 的 `TerminalClient.open` 多一個必填參數 `projectId`,放在 `command` 之前。`Terminal` 元件多一個必填 prop `projectId`,並加進 effect deps:同一個分頁不會換專案,但 deps 完整才能讓 React 在 props 真的變動時重連。
6. C 規格 §5 的協定文字同步更新,§10 修訂紀錄加一列。

- [ ] **Step 1: 改寫 `tests/terminal-server.test.ts` 的 `handleConnection` 區塊**

把檔案內所有 `handleConnection(socket, spawn, '/proj', noop)` 之類的第三個參數 `'/proj'` 換成 `resolveCwd`,並在每則 `open` 訊息加 `projectId: 'p1'`。整個 `describe('handleConnection', …)` 與 `describe('handleConnection 的缺裝提示', …)` 改成下面這樣(`isAllowedOrigin` 與 `findInPath` 兩個 describe 不動):

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  findInPath,
  handleConnection,
  isAllowedOrigin,
  type PtyLike,
  type ResolveCwd,
  type SocketLike,
  type SpawnPty,
} from '../src/main/terminal-server.js'

function fakePty() {
  const p: any = { dataCb: null, exitCb: null, writes: [], resizes: [], killed: false }
  p.onData = (cb: (d: string) => void) => { p.dataCb = cb }
  p.onExit = (cb: (e: { exitCode: number }) => void) => { p.exitCb = cb }
  p.write = (d: string) => p.writes.push(d)
  p.resize = (c: number, r: number) => p.resizes.push([c, r])
  p.kill = () => { p.killed = true }
  return p as PtyLike & typeof p
}

function fakeSocket() {
  const s: any = { msgCb: null, closeCb: null, sent: [], closed: false }
  s.on = (ev: string, cb: any) => { if (ev === 'message') s.msgCb = cb; else s.closeCb = cb }
  s.send = (t: string) => s.sent.push(t)
  s.close = () => { s.closed = true }
  return s as SocketLike & typeof s
}

const noop = () => {}
/** 登錄表只認得 p1;其他 id 一律查不到 */
const resolveCwd: ResolveCwd = (id) => (id === 'p1' ? '/proj' : undefined)
const OPEN = { type: 'open', cols: 80, rows: 24, projectId: 'p1' }

describe('isAllowedOrigin', () => {
  // …原內容不動…
})

describe('handleConnection', () => {
  it('open 用 projectId 查到的 cwd 與給的 cols/rows spawn,command 寫進 pty 帶 \\r', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const spawn: SpawnPty = vi.fn(() => pty) as any
    handleConnection(socket, spawn, resolveCwd, noop)
    socket.msgCb(JSON.stringify({ type: 'open', cols: 100, rows: 30, projectId: 'p1', command: 'codex' }))
    expect(spawn).toHaveBeenCalledWith({ cols: 100, rows: 30, cwd: '/proj', shell: expect.any(String) })
    expect(pty.writes).toEqual(['codex\r'])
  })

  it('open 帶不認得的 projectId:log、送 exit 1、關 socket,不 spawn', () => {
    const socket = fakeSocket(); const logError = vi.fn()
    const spawn: SpawnPty = vi.fn(() => fakePty()) as any
    handleConnection(socket, spawn, resolveCwd, logError)
    socket.msgCb(JSON.stringify({ ...OPEN, projectId: 'nope' }))
    expect(spawn).not.toHaveBeenCalled()
    expect(socket.sent).toEqual([JSON.stringify({ type: 'exit', code: 1 })])
    expect(socket.closed).toBe(true)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]?.message).toBe('終端機 open 的 projectId 不合法或不認得(nope),已拒絕')
  })

  it('open 缺 projectId 或 projectId 不是字串:同樣拒絕,不退回預設目錄', () => {
    for (const bad of [{ type: 'open', cols: 80, rows: 24 }, { ...OPEN, projectId: 42 }]) {
      const socket = fakeSocket(); const logError = vi.fn()
      const spawn: SpawnPty = vi.fn(() => fakePty()) as any
      handleConnection(socket, spawn, resolveCwd, logError)
      socket.msgCb(JSON.stringify(bad))
      expect(spawn).not.toHaveBeenCalled()
      expect(socket.sent).toEqual([JSON.stringify({ type: 'exit', code: 1 })])
      expect(socket.closed).toBe(true)
      expect(logError).toHaveBeenCalledTimes(1)
    }
  })

  it('被拒絕的連線之後再送訊息仍不會 spawn', () => {
    const socket = fakeSocket()
    const spawn: SpawnPty = vi.fn(() => fakePty()) as any
    handleConnection(socket, spawn, resolveCwd, noop)
    socket.msgCb(JSON.stringify({ ...OPEN, projectId: 'nope' }))
    socket.msgCb(JSON.stringify({ type: 'input', data: 'ls\r' }))
    socket.msgCb(JSON.stringify(OPEN))
    expect(spawn).not.toHaveBeenCalled()
    expect(socket.sent).toHaveLength(1)
  })

  it('open 之前的訊息一律忽略', () => {
    const socket = fakeSocket(); const spawn: SpawnPty = vi.fn(() => fakePty()) as any
    handleConnection(socket, spawn, resolveCwd, noop)
    socket.msgCb(JSON.stringify({ type: 'input', data: 'x' }))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('open 後 input 寫進 pty、resize 呼叫 pty.resize', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop)
    socket.msgCb(JSON.stringify(OPEN))
    socket.msgCb(JSON.stringify({ type: 'input', data: 'ls\r' }))
    socket.msgCb(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }))
    expect(pty.writes).toEqual(['ls\r'])
    expect(pty.resizes).toEqual([[90, 20]])
  })

  it('pty 輸出送成 output,結束送 exit 再關 socket', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop)
    socket.msgCb(JSON.stringify(OPEN))
    pty.dataCb('hello')
    expect(socket.sent).toContain(JSON.stringify({ type: 'output', data: 'hello' }))
    pty.exitCb({ exitCode: 0 })
    expect(socket.sent).toContain(JSON.stringify({ type: 'exit', code: 0 }))
    expect(socket.closed).toBe(true)
  })

  it('socket 關閉時 kill pty', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop)
    socket.msgCb(JSON.stringify(OPEN))
    socket.closeCb()
    expect(pty.killed).toBe(true)
  })

  it('pty spawn 失敗時送 exit、關 socket、log 錯誤且維持未開啟', () => {
    const socket = fakeSocket(); const pty = fakePty(); const logError = vi.fn()
    const spawn: SpawnPty = () => { throw 'spawn failed' }
    handleConnection(socket, spawn, resolveCwd, logError)
    socket.msgCb(JSON.stringify(OPEN))
    expect(socket.sent).toEqual([JSON.stringify({ type: 'exit', code: 1 })])
    expect(socket.closed).toBe(true)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(() => socket.msgCb(JSON.stringify({ type: 'input', data: 'ls\r' }))).not.toThrow()
    expect(pty.writes).toEqual([])
  })

  it('壞訊息 log 後忽略,不關連線', () => {
    const socket = fakeSocket(); const logError = vi.fn()
    handleConnection(socket, () => fakePty(), resolveCwd, logError)
    socket.msgCb('這不是 json')
    socket.msgCb(JSON.stringify({ nope: 1 }))
    expect(socket.closed).toBe(false)
    expect(logError).toHaveBeenCalled()
  })
})

describe('findInPath', () => {
  // …原內容不動…
})

describe('handleConnection 的缺裝提示', () => {
  it('指令不在 PATH 時先送繁中提示,指令仍照送', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop, () => false)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'grok' }))
    const hint = socket.sent.find((t: string) => t.includes('找不到'))
    expect(hint).toBeTruthy()
    expect(JSON.parse(hint).type).toBe('output')
    expect(JSON.parse(hint).data).toContain('grok')
    expect(pty.writes).toEqual(['grok\r'])
  })

  it('指令在 PATH 時不送提示', () => {
    const socket = fakeSocket(); const pty = fakePty()
    handleConnection(socket, () => pty, resolveCwd, noop, () => true)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'codex' }))
    expect(socket.sent.filter((t: string) => t.includes('找不到'))).toEqual([])
    expect(pty.writes).toEqual(['codex\r'])
  })

  it('查的是指令第一個詞,不含參數', () => {
    const socket = fakeSocket(); const pty = fakePty()
    const commandExists = vi.fn(() => true)
    handleConnection(socket, () => pty, resolveCwd, noop, commandExists)
    socket.msgCb(JSON.stringify({ ...OPEN, command: 'claude --resume' }))
    expect(commandExists).toHaveBeenCalledWith('claude')
  })
})
```

- [ ] **Step 2: 改 `tests/terminal-client.test.ts` 第 17–18、23–26 行**

```ts
  it('open 送 open 訊息(連線已開時)', () => {
    const s = fakeSocket()
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn(), onError: vi.fn() }, () => s as any)
    s.onopen?.()
    c.open(80, 24, 'p1', 'codex')
    expect(s.sent).toContain(JSON.stringify({ type: 'open', cols: 80, rows: 24, projectId: 'p1', command: 'codex' }))
  })
  it('連線還沒開時 open 先排隊,開了才送', () => {
    const s = fakeSocket(); s.readyState = 0
    const c = createTerminalClient('ws://x', { onOutput: vi.fn(), onExit: vi.fn(), onError: vi.fn() }, () => s as any)
    c.open(80, 24, 'p1')
    expect(s.sent).toHaveLength(0)
    s.readyState = 1; s.onopen?.()
    expect(s.sent).toContain(JSON.stringify({ type: 'open', cols: 80, rows: 24, projectId: 'p1' }))
  })
```

- [ ] **Step 3: 跑兩個測試檔確認失敗**

Run: `npx vitest run tests/terminal-server.test.ts tests/terminal-client.test.ts`
Expected: FAIL。terminal-server 的新測試因為 `'/proj'` 仍被當成 cwd 字串而 spawn(`spawn` 被叫到、沒送 exit);terminal-client 的 `open` 少送 `projectId`。`ResolveCwd` 型別 import 在 vitest 下不會擋執行,但 `tsc` 會報找不到。

- [ ] **Step 4: 改 `src/main/terminal-server.ts`**

在 `SpawnPty` 型別下方(第 46 行後)新增:

```ts
/** 由 projectId 查該專案的根目錄;查不到回 undefined,由呼叫端拒絕連線 */
export type ResolveCwd = (projectId: string) => string | undefined
```

`handleConnection` 簽章與 `open` 分支改成:

```ts
export function handleConnection(
  socket: SocketLike,
  spawn: SpawnPty,
  resolveCwd: ResolveCwd,
  logError: (e: Error) => void,
  commandExists: (command: string) => boolean = realCommandExists
): void {
  let pty: PtyLike | null = null
  const shell = process.env.SHELL ?? 'zsh'

  const reject = (error: Error): void => {
    logError(error)
    socket.send(JSON.stringify({ type: 'exit', code: 1 }))
    socket.close()
  }

  socket.on('message', (raw) => {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      logError(new Error('終端機收到非 JSON 訊息,已忽略'))
      return
    }
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
      logError(new Error('終端機收到缺 type 的訊息,已忽略'))
      return
    }
    const m = msg as { type: string; [k: string]: unknown }

    if (m.type === 'open') {
      if (pty !== null) return
      // 規格 §3.1:renderer 只送 id,cwd 由主行程查表決定;查不到不退回任何預設目錄(§6)。
      const cwd = typeof m.projectId === 'string' ? resolveCwd(m.projectId) : undefined
      if (cwd === undefined) {
        reject(new Error(`終端機 open 的 projectId 不合法或不認得(${String(m.projectId)}),已拒絕`))
        return
      }
      const cols = typeof m.cols === 'number' ? m.cols : 80
      const rows = typeof m.rows === 'number' ? m.rows : 24
      try {
        pty = spawn({ cols, rows, cwd, shell })
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      pty.onData((data) => socket.send(JSON.stringify({ type: 'output', data })))
      pty.onExit(({ exitCode }) => {
        socket.send(JSON.stringify({ type: 'exit', code: exitCode }))
        socket.close()
      })
      if (typeof m.command === 'string' && m.command.length > 0) {
        // 快捷指令沒裝時,先給一行繁中提示再照送:有 shell 別名的情況仍能正常執行。
        const bin = m.command.trim().split(/\s+/)[0] ?? ''
        if (bin.length > 0 && !commandExists(bin)) {
          socket.send(
            JSON.stringify({
              type: 'output',
              data: `\r\n[yeschef] PATH 中找不到 ${bin},若尚未安裝請先安裝。\r\n`,
            })
          )
        }
        pty.write(m.command + '\r')
      }
      return
    }
    if (pty === null) return // open 之前(或被拒絕後)的其他訊息忽略
    if (m.type === 'input' && typeof m.data === 'string') { pty.write(m.data); return }
    if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      pty.resize(m.cols, m.rows); return
    }
    logError(new Error(`終端機收到不認得的訊息 type=${m.type},已忽略`))
  })

  socket.on('close', () => { if (pty !== null) pty.kill() })
}
```

`reject` 把「log、送 exit 1、關 socket」合成一個函式,拒絕 projectId 與 spawn 失敗共用;spawn 失敗仍傳原始 Error,堆疊不丟。

`startTerminalServer` 改成:

```ts
export function startTerminalServer(resolveCwd: ResolveCwd, logError: (e: Error) => void): Promise<TerminalServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: ({ origin }: { origin: string }) => isAllowedOrigin(origin),
    })
    wss.on('error', reject)
    wss.on('listening', () => {
      const addr = wss.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      wss.on('error', logError)
      wss.on('connection', (ws: WebSocket) => {
        ws.on('error', (e) => logError(e instanceof Error ? e : new Error(String(e))))
        const socket: SocketLike = {
          on: (ev: any, cb: any) => {
            if (ev === 'message') ws.on('message', (d) => cb(d.toString()))
            else ws.on('close', cb)
          },
          send: (t) => ws.send(t),
          close: () => ws.close(),
        }
        handleConnection(socket, realSpawn, resolveCwd, logError)
      })
      resolve({
        port,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      })
    })
  })
}
```

- [ ] **Step 5: 改 `src/renderer/terminal-client.ts`**

第 2 行與第 50–51 行:

```ts
export interface TerminalClient {
  open(cols: number, rows: number, projectId: string, command?: string): void
  sendInput(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}
```

```ts
  return {
    open: (cols, rows, projectId, command) =>
      send(
        command === undefined
          ? { type: 'open', cols, rows, projectId }
          : { type: 'open', cols, rows, projectId, command }
      ),
    sendInput: (data) => send({ type: 'input', data }),
    resize: (cols, rows) => send({ type: 'resize', cols, rows }),
    close: () => ws.close(),
  }
```

- [ ] **Step 6: 改 `src/renderer/components/Terminal.tsx`**

第 8 行、第 36 行、第 41 行:

```tsx
export function Terminal({
  endpoint,
  projectId,
  command,
}: {
  readonly endpoint: string
  readonly projectId: string
  readonly command?: string
}) {
```

```tsx
    client.open(term.cols, term.rows, projectId, command)
```

```tsx
  }, [endpoint, projectId, command])
```

`LeftPane.tsx` 第 71 行還沒傳 `projectId`,這一步之後 `tsc` 會在 `LeftPane.tsx` 報缺少必填 prop;Task 12 改寫 `LeftPane` 時補上。`tests/left-pane.test.tsx` 第 5–6 行把 `Terminal` mock 掉,不受影響。

- [ ] **Step 7: 跑測試與 typecheck**

Run: `npx vitest run tests/terminal-server.test.ts tests/terminal-client.test.ts tests/left-pane.test.tsx && npx tsc --noEmit -p . 2>&1 | grep -v "src/main/index.ts" | grep -v "src/preload" | grep -v "src/renderer/components/LeftPane.tsx" || true`
Expected: 三個測試檔全綠;typecheck 除了 `index.ts`(Task 14)、preload(Task 11)、`LeftPane.tsx`(Task 12)以外沒有錯誤。把 `LeftPane.tsx` 的那一條錯誤原文寫進報告的 concerns。

- [ ] **Step 8: 更新 C 規格 §5、§9 與 §10**

`docs/specs/2026-09-07-yeschef-c-terminals-design.md`:

第 54 行改成:

```
開新終端分頁:renderer 用一次性 IPC 問主行程要 ws 的 port(`terminal:endpoint`),連上 `ws://127.0.0.1:<port>`,送一則 `open`(帶 cols、rows、必填 projectId、選填 command)。主行程用 projectId 查專案登錄表取得 cwd,spawn 一個 node-pty(shell 用 `process.env.SHELL` 或 `zsh`),若 `open` 帶 command 就往 pty 寫一行那個指令。
```

第 82 行改成:

```
- `{ type: 'open', cols: number, rows: number, projectId: string, command?: string }`:用 projectId 查登錄表取得 cwd 後 spawn pty;有 command 就往 pty 寫 `command + '\r'`。
```

第 90 行改成:

```
第一則訊息必須是 `open`,在那之前收到別的訊息一律忽略。`open` 的 `projectId` 缺少、不是字串、或登錄表查不到時,記 log、送 `{ type: 'exit', code: 1 }` 後關連線,不退回任何預設目錄(D 規格 §6)。壞的或非預期的訊息(不是 JSON、缺 type、type 不認得)記 log 後忽略,不關連線。
```

第 92 行改成:

```
pty spawn 參數:`name: 'xterm-color'`、`cwd` 取自登錄表中該 projectId 的 rootPath、`env: process.env`、cols/rows 取自 `open`。
```

第 122 行改成:

```
- terminal-server:用假 pty factory、假 socket 與假登錄表測 `open`/`resize`/輸入/`exit` 的訊息拆解、binary 與 text 的分工、projectId 缺少或查不到時的拒絕、socket close 時 kill pty 的清理。
```

§10 修訂紀錄表格末尾加一列:

```
| 2026-09-08 | §3.2、§5、§9 | `open` 多一個必填 `projectId`,cwd 由主行程查登錄表決定;查不到就送 exit 並關連線 | 子專案 D 規格 §3.1、§3.2、§6 |
```

改完檢查行號沒有漂移:`grep -n "projectId" docs/specs/2026-09-07-yeschef-c-terminals-design.md` 應列出第 54、82、90、92、122 行與修訂紀錄那一列。

- [ ] **Step 9: Commit**

```bash
git add src/main/terminal-server.ts src/renderer/terminal-client.ts src/renderer/components/Terminal.tsx tests/terminal-server.test.ts tests/terminal-client.test.ts docs/specs/2026-09-07-yeschef-c-terminals-design.md
git commit -m "feat: 終端機 open 改帶 projectId,由主行程查登錄表決定 cwd"
```

---

### Task 10: 右窗格工具改成每個專案一份 MCP server,`projectDir` 改為 `activeProjectDir()`

**Files:**
- Modify: `src/main/view-tools/controller-types.ts:20`
- Modify: `src/main/view-tools/controller-page.ts:26`
- Modify: `src/main/view-tools/server.ts`(`ViewToolDeps`、`ViewTools`、新 `ProjectViewTools`、`ToolRuntime`、`runTool`、`createViewToolServer`)
- Modify: `src/main/view-tools/startup.ts`(`ViewToolStartupDeps`、`ViewToolStartup`、`NO_TOOLS`、`startViewTools`)
- Modify: `tests/view-tools/controller-harness.ts:86-108`
- Modify: `tests/view-tools/controller-input.test.ts:398,429,454`
- Modify: `tests/view-tools/server.test.ts`
- Modify: `tests/view-tools/startup.test.ts`

**Interfaces:**
- Consumes: Task 7 Step 1 加進 `errors.ts` 的 `MSG.browserBusy`(`'瀏覽器正由前景專案使用'`);既有 `MSG.sessionEnded`、`ViewToolError`、`createSdkMcpServer`、`VIEW_TOOL_SERVER_NAME`。
- Produces(Task 14 的 `index.ts` 與 Task 7 的 `ProjectRuntime` 靠這些):
  ```ts
  // src/main/view-tools/server.ts
  export interface ViewToolDeps {
    readonly view: WebContentsView
    readonly cdp: CdpSession
    readonly clock: MergerClock
    /** 回傳目前 active 專案的 rootPath。只在某個專案的工具通過 isActive 守衛後才會被呼叫。 */
    readonly activeProjectDir: () => string
    readonly logError: (error: Error) => void
  }
  /** 一個專案自己的那份工具。 */
  export interface ProjectViewTools {
    readonly server: McpSdkServerConfigWithInstance
    /** 只中止這個專案進行中的呼叫。 */
    abortPending(reason: string): void
    /** 中止自己的呼叫並從共用登錄移除;之後這份 server 不該再被用。 */
    dispose(): void
  }
  export interface ViewTools {
    autoAllow(toolName: string, toolUseId: string): boolean
    handoffDone(toolUseId: string): void
    /** 中止所有專案進行中的呼叫。 */
    abortPending(reason: string): void
    /** 替一個專案建一份 MCP server;isActive 回 false 時八個工具都直接回 MSG.browserBusy。 */
    forProject(isActive: () => boolean): ProjectViewTools
    dispose(): Promise<void>
  }
  // src/main/view-tools/startup.ts
  export interface ViewToolStartupDeps { view; clock; activeProjectDir: () => string; logError; warn; attach; create }
  export interface ViewToolStartup { readonly viewTools: ViewTools | undefined; dispose(): Promise<void> }
  // src/main/view-tools/controller-types.ts
  export interface ControllerDeps { …; readonly activeProjectDir: () => string; … }
  ```
  `ViewTools` 不再有 `server` 欄位,`ViewToolStartup` 不再有 `mcpServers`:兩者都是共用一份、不經過專案守衛的 server,留著等於給背景專案一條繞過守衛的路。Task 6 的 `ViewToolHooks = Pick<ViewTools, 'autoAllow' | 'handoffDone' | 'abortPending'>` 三個成員都還在,不用改。

規則:

1. `runTool` 一進來先看 `runtime.isActive()`,回 false 就 `return errorResult(MSG.browserBusy)`:不登記 inflight、不叫 controller、不送 CDP、不 `logError`(D 規格 §3.4、§6)。
2. 每份 `ProjectViewTools` 有自己的 `inflight: Set<AbortController>`,登記在共用的 `projects: Set<Set<AbortController>>`。`ProjectViewTools.abortPending` 只掃自己那一份;`ViewTools.abortPending` 掃全部。`ProjectViewTools.dispose()` 先用 `MSG.sessionEnded` 中止自己的呼叫,再從 `projects` 移除。
3. `createSdkMcpServer` 的 name、version、timeout 三個值不變(`VIEW_TOOL_SERVER_NAME`、`'0.1.0'`、`HANDOFF_TIMEOUT_MS + 60_000`),每次 `forProject` 各建一個實例;八個工具的描述、zod shape、`alwaysLoad` 不變。
4. controller 只有一個(watcher、settle、handoff 也只有一份):右窗格只有一個 view,這些都是 view 的附屬。`ControllerDeps.projectDir` 改成 `activeProjectDir: () => string`,`controller-page.ts` 的 `navigate` 每次呼叫時才取值,專案切換後不用重建 controller。
5. `ViewTools.dispose()` 順序不變:先中止(現在是全部專案)、再 `watcher.dispose()`、`settle.dispose()`、`handoff.abortAll()`。
6. `startViewTools` 把 `deps.activeProjectDir` 原樣傳進 `create`;成功路徑回 `{ viewTools, dispose }`,`NO_TOOLS` 是 `{ viewTools: undefined, dispose }`。
7. `tests/view-tools/urls.test.ts` 不動:`checkNavigateUrl(url, projectDir)` 的簽章不變,變的是呼叫端拿 projectDir 的方式。

- [ ] **Step 1: 改 `server.test.ts` 的 rig 與 build,並加新測試**

`tests/view-tools/server.test.ts` 第 9 行的 import 改成:

```ts
import { createViewToolServer, type ProjectViewTools, type ViewTools } from '../../src/main/view-tools/server.js'
import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName, type ViewToolName } from '../../src/shared/view-tools.js'
```

(第 10 行原本的 `import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName } from '../../src/shared/view-tools.js'` 由上面第二行取代。)

第 60 到 64 行的模組層變數後面加兩個:

```ts
/** build() 建的第一個專案是否 active;測背景守衛時改成 false。 */
let active: boolean
/** build() 替第一個專案建的那份工具。 */
let project: ProjectViewTools
```

`beforeEach` 開頭(`signals = []` 之前)加一行 `active = true`。

第 107 到 115 行的 `build()` 改成:

```ts
/** 建共用工具,並替「第一個專案」建一份 server;shared.serverOptions 之後就是這一份的內容。 */
async function build(): Promise<ViewTools> {
  const tools = await createViewToolServer({
    view: { webContents } as unknown as WebContentsView,
    cdp,
    clock: testClock.clock,
    activeProjectDir: () => '/專案',
    logError,
  })
  project = tools.forProject(() => active)
  return tools
}
```

`ctrl()` 之後、`describe('工具定義'` 之前加一個常數(給背景守衛測試每個工具一組合法參數):

```ts
const BUSY_ARGS: Readonly<Record<ViewToolName, object>> = {
  view_navigate: { url: 'https://a.test/' },
  view_snapshot: {},
  view_screenshot: {},
  view_click: { ref: 's1-e0' },
  view_type: { ref: 's1-e0', text: '嗨' },
  view_press: { key: 'Tab' },
  view_eval: { expression: '1 + 1' },
  request_handoff: { reason: '請登入' },
}
```

`describe('工具定義'` 內第一條測試名稱從「server 名稱、版本與八個工具的名稱順序都照契約」改成「每個專案的 server 名稱、版本與八個工具的名稱順序都照契約」,內容不變。同一個 describe 末尾(`createWatcher 收到 cdp、webContents 與 logError` 之後)加:

```ts
  it('forProject 每次各建一個 server 實例,工具 handler 不共用', async () => {
    const tools = await build()
    const first = shared.serverOptions
    const second = tools.forProject(() => true)
    expect(second.server).not.toBe(project.server)
    expect(shared.serverOptions).not.toBe(first)
    expect(shared.serverOptions.name).toBe(first.name)
    expect(shared.serverOptions.timeout).toBe(first.timeout)
    expect(shared.serverOptions.tools?.[0]?.handler).not.toBe(first.tools?.[0]?.handler)
  })
```

`describe('signal'` 整個改成下面這樣(前五條照舊,後面新增三條):

```ts
describe('signal 與專案守衛', () => {
  it('abortPending 中止全部進行中的呼叫', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' })
    void call('view_click', { ref: 's1-e1' })
    await Promise.resolve()
    expect(signals).toHaveLength(2)
    expect(signals.map((s) => s.aborted)).toEqual([false, false])
    tools.abortPending(MSG.sessionEnded)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
    expect(signals[0]?.reason).toBeInstanceOf(ViewToolError)
    expect((signals[0]?.reason as Error).message).toBe(MSG.sessionEnded)
  })

  it('已經結束的呼叫不會被之後的 abortPending 中止', async () => {
    const tools = await build()
    await call('view_press', { key: 'Tab' })
    tools.abortPending(MSG.sessionEnded)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
  })

  it('abortPending 之後開始的呼叫拿到乾淨的 signal', async () => {
    const tools = await build()
    tools.abortPending(MSG.sessionEnded)
    await call('view_press', { key: 'Tab' })
    expect(signals[0]?.aborted).toBe(false)
  })

  it('extra.signal 中止時 controller 收到的 signal 也中止', async () => {
    await build()
    ctrl('click').mockImplementation(pendingForever())
    const outer = new AbortController()
    void call('view_click', { ref: 's1-e0' }, { _meta: {}, signal: outer.signal })
    await Promise.resolve()
    expect(signals[0]?.aborted).toBe(false)
    outer.abort(new Error('MCP 端取消'))
    expect(signals[0]?.aborted).toBe(true)
  })

  it('extra 沒有 signal 或不是 AbortSignal 時照樣可用,自己的中止仍然有效', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' }, undefined)
    void call('view_click', { ref: 's1-e1' }, { _meta: {}, signal: '不是 signal' })
    await Promise.resolve()
    expect(signals).toHaveLength(2)
    tools.abortPending(MSG.sessionEnded)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
  })

  it('isActive 回 false 時八個工具都回 browserBusy,不呼叫 controller 也不 logError', async () => {
    await build()
    active = false
    for (const name of VIEW_TOOL_NAMES) {
      const result = await call(name, BUSY_ARGS[name], { _meta: { 'claudecode/toolUseId': 'toolu_1' } })
      expect(result, name).toEqual({ content: [{ type: 'text', text: MSG.browserBusy }], isError: true })
    }
    for (const name of Object.keys(shared.controller)) expect(ctrl(name), name).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
    expect(signals).toHaveLength(0)
  })

  it('專案的 abortPending 只中止自己的呼叫,共用的 abortPending 中止全部', async () => {
    const tools = await build()
    const firstClick = toolDef('view_click').handler
    const second = tools.forProject(() => true)
    const secondClick = toolDef('view_click').handler
    ctrl('click').mockImplementation(pendingForever())
    void firstClick({ ref: 's1-e0' } as never, { _meta: {} })
    void secondClick({ ref: 's1-e1' } as never, { _meta: {} })
    await Promise.resolve()
    expect(signals).toHaveLength(2)

    second.abortPending(MSG.browserBusy)
    expect(signals.map((s) => s.aborted)).toEqual([false, true])
    expect((signals[1]?.reason as Error).message).toBe(MSG.browserBusy)

    tools.abortPending(MSG.sessionEnded)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
    expect((signals[0]?.reason as Error).message).toBe(MSG.sessionEnded)
  })

  it('專案 dispose 以 sessionEnded 中止自己的呼叫,之後共用的 abortPending 不再碰它', async () => {
    const tools = await build()
    ctrl('click').mockImplementation(pendingForever())
    void call('view_click', { ref: 's1-e0' })
    await Promise.resolve()
    project.dispose()
    expect(signals[0]?.aborted).toBe(true)
    expect((signals[0]?.reason as Error).message).toBe(MSG.sessionEnded)

    // dispose 過的專案再被叫到(理論上不該發生),仍走一般路徑但不會被共用中止掃到
    void call('view_click', { ref: 's1-e1' })
    await Promise.resolve()
    tools.abortPending(MSG.browserBusy)
    expect(signals[1]?.aborted).toBe(false)
  })
})
```

`describe('autoAllow、handoffDone 與 dispose'` 的最後一條改成(多開一個專案,確認 dispose 中止的是全部):

```ts
  it('dispose 先中止所有專案進行中的呼叫,再依序收 watcher、settle、handoff', async () => {
    const tools = await build()
    const firstClick = toolDef('view_click').handler
    tools.forProject(() => true)
    const secondClick = toolDef('view_click').handler
    ctrl('click').mockImplementation(pendingForever())
    void firstClick({ ref: 's1-e0' } as never, { _meta: {} })
    void secondClick({ ref: 's1-e1' } as never, { _meta: {} })
    await Promise.resolve()
    signals[0]?.addEventListener('abort', () => { shared.order.push('abort') })
    signals[1]?.addEventListener('abort', () => { shared.order.push('abort') })
    await tools.dispose()
    expect(shared.order).toEqual(['abort', 'abort', 'watcher.dispose', 'settle.dispose', 'handoff.abortAll'])
    expect(signals.map((s) => (s.reason as Error).message)).toEqual([MSG.sessionEnded, MSG.sessionEnded])
  })
```

其餘測試不動:`call()` 走 `shared.serverOptions`,`build()` 之後那就是第一個專案的 server,所以「參數傳遞與成功結果」「錯誤翻譯」「request_handoff」都照原樣通過。

- [ ] **Step 2: 改 `startup.test.ts`**

第 3、4 行刪掉(`McpSdkServerConfigWithInstance` 與 `VIEW_TOOL_SERVER_NAME` 不再用到),第 16 行的 `const SERVER = …` 刪掉。

第 60 到 70 行的假 `viewTools` 改成:

```ts
  const viewTools: ViewTools = {
    autoAllow: () => true,
    handoffDone: () => {},
    abortPending: () => {},
    forProject: () => { throw new Error('startup 測試不該叫 forProject') },
    dispose: () => {
      calls.push('viewTools.dispose')
      return options.disposeFails === undefined
        ? Promise.resolve()
        : Promise.reject(options.disposeFails)
    },
  }
```

第 77 行 `projectDir: '/proj',` 改成 `activeProjectDir: () => '/proj',`。

第 99 到 107 行那條測試改成:

```ts
  it('成功時 viewTools 是 create 回來的那一個', async () => {
    const rig = setup()
    const startup = await startViewTools(rig.deps)

    expect(startup.viewTools).toBe(rig.viewTools)
    expect(rig.warned).toEqual([])
    expect(rig.logged).toEqual([])
  })
```

第 119 行 `expect(rig.created[0]?.projectDir).toBe('/proj')` 改成 `expect(rig.created[0]?.activeProjectDir()).toBe('/proj')`。

第 150、182、217 行的 `expect(startup.mcpServers).toBeUndefined()` 三行刪掉(下一行的 `expect(startup.viewTools).toBeUndefined()` 留著)。三個 describe 的名稱裡「兩個欄位都是 undefined」改成「viewTools 是 undefined」(只有第 146 行那條 `it` 的名稱有這幾個字)。

- [ ] **Step 3: 改 controller 測試的 deps**

`tests/view-tools/controller-harness.ts:108` 的 `projectDir,` 改成 `activeProjectDir: () => projectDir,`(第 86 行函式參數 `projectDir = '/tmp/yeschef-proj'` 不動,呼叫端 `createHarness('/x')` 的寫法不變)。

`tests/view-tools/controller-input.test.ts` 第 398、429、454 行三處 `projectDir: '/tmp/yeschef-proj',` 都改成 `activeProjectDir: () => '/tmp/yeschef-proj',`。用下面這行做,做完 `grep -n "projectDir" tests/view-tools/controller-input.test.ts` 應該只剩 `activeProjectDir`:

```bash
sed -i '' "s|projectDir: '/tmp/yeschef-proj',|activeProjectDir: () => '/tmp/yeschef-proj',|" tests/view-tools/controller-input.test.ts
```

- [ ] **Step 4: 跑測試確認失敗**

Run: `npx vitest run tests/view-tools/server.test.ts tests/view-tools/startup.test.ts tests/view-tools/controller-harness.ts tests/view-tools/controller-input.test.ts 2>&1 | tail -30`
Expected: FAIL。server.test 整檔在 `tools.forProject` 不是函式處失敗;startup.test 在 `activeProjectDir` 型別與 `forProject` 欄位處 typecheck 失敗;controller 測試在 `ControllerDeps` 沒有 `activeProjectDir` 處 typecheck 失敗(vitest 不擋型別錯誤時,controller 測試會因 `deps.projectDir` 為 undefined、`checkNavigateUrl(url, undefined)` 而在 file:// 的測試失敗)。

- [ ] **Step 5: 改 `controller-types.ts` 與 `controller-page.ts`**

`src/main/view-tools/controller-types.ts:20` 的 `readonly projectDir: string` 改成:

```ts
  /** 目前 active 專案的 rootPath;每次 navigate 都重新取,專案切換不用重建 controller。 */
  readonly activeProjectDir: () => string
```

`src/main/view-tools/controller-page.ts:26` 的 `const check = checkNavigateUrl(url, deps.projectDir)` 改成 `const check = checkNavigateUrl(url, deps.activeProjectDir())`。第 29 行 `MSG.outsideProject(check.projectDir)` 不動(`UrlCheck` 自己帶回它比對用的目錄)。

- [ ] **Step 6: 改 `server.ts`**

第 16 到 30 行的兩個介面改成:

```ts
export interface ViewToolDeps {
  readonly view: WebContentsView
  readonly cdp: CdpSession
  readonly clock: MergerClock
  /** 回傳目前 active 專案的 rootPath。只在某個專案的工具通過 isActive 守衛後才會被呼叫。 */
  readonly activeProjectDir: () => string
  readonly logError: (error: Error) => void
}

/** 一個專案自己的那份工具(D 規格 §3.4):server 放進該專案的 sessionOptions.mcpServers。 */
export interface ProjectViewTools {
  readonly server: McpSdkServerConfigWithInstance
  /** 只中止這個專案進行中的呼叫。 */
  abortPending(reason: string): void
  /** 中止自己的呼叫並從共用登錄移除;之後這份 server 不該再被用。 */
  dispose(): void
}

export interface ViewTools {
  autoAllow(toolName: string, toolUseId: string): boolean
  handoffDone(toolUseId: string): void
  /** 中止所有專案進行中的呼叫。 */
  abortPending(reason: string): void
  /** 替一個專案建一份 MCP server;isActive 回 false 時八個工具都直接回 MSG.browserBusy。 */
  forProject(isActive: () => boolean): ProjectViewTools
  dispose(): Promise<void>
}
```

第 93 到 114 行的 `ToolRuntime` 與 `runTool` 改成:

```ts
interface ToolRuntime {
  readonly controller: ViewController
  readonly inflight: Set<AbortController>
  /** 這份工具所屬的專案是否在前景。 */
  readonly isActive: () => boolean
  readonly logError: (error: Error) => void
}

/**
 * 所有工具的共用外殼:先過專案守衛,再登記 inflight、合併 signal、把任何結果或例外轉成
 * CallToolResult。永不 reject。背景專案(D 規格 §3.4)連 CDP 都不送,直接回 browserBusy。
 */
async function runTool(
  runtime: ToolRuntime,
  extra: unknown,
  action: (signal: AbortSignal) => Promise<ToolOutput>
): Promise<CallToolResult> {
  if (!runtime.isActive()) return errorResult(MSG.browserBusy)
  const own = new AbortController()
  runtime.inflight.add(own)
  try {
    return toToolResult(await action(mergeSignal(own.signal, extra)))
  } catch (error) {
    return toErrorResult(error, runtime.logError)
  } finally {
    runtime.inflight.delete(own)
  }
}

function abortAll(inflight: Set<AbortController>, reason: string): void {
  for (const pending of inflight) pending.abort(new ViewToolError(reason))
  inflight.clear()
}
```

`createViewToolServer` 內從 `const controller = createViewController({` 到函式結尾的 `return { … }` 改成:

```ts
    const controller = createViewController({
      cdp: deps.cdp,
      webContents,
      watcher: activeWatcher,
      settle,
      handoff,
      clock: deps.clock,
      activeProjectDir: deps.activeProjectDir,
      logError: deps.logError,
    })

    /** 每個專案一個 inflight 集合;共用的 abortPending 與 dispose 掃這裡的全部。 */
    const projects = new Set<Set<AbortController>>()
    const abortPending = (reason: string): void => {
      for (const inflight of projects) abortAll(inflight, reason)
    }

    const forProject = (isActive: () => boolean): ProjectViewTools => {
      const inflight = new Set<AbortController>()
      projects.add(inflight)
      const runtime: ToolRuntime = { controller, inflight, isActive, logError: deps.logError }
      const server = createSdkMcpServer({
        name: VIEW_TOOL_SERVER_NAME,
        version: SERVER_VERSION,
        tools: createTools(runtime),
        timeout: TOOL_CALL_TIMEOUT_MS,
      })
      return {
        server,
        abortPending: (reason: string): void => { abortAll(inflight, reason) },
        dispose: (): void => {
          abortAll(inflight, MSG.sessionEnded)
          projects.delete(inflight)
        },
      }
    }

    return {
      autoAllow: (toolName: string, _toolUseId: string): boolean => viewToolPolicy(toolName) === 'allow',
      handoffDone: (toolUseId: string): void => { handoff.done(toolUseId) },
      abortPending,
      forProject,
      dispose: async (): Promise<void> => {
        abortPending(MSG.sessionEnded)
        activeWatcher.dispose()
        settle.dispose()
        handoff.abortAll()
      },
    }
```

原本第 188 到 200 行(單一 `inflight`、單一 `server`、舊 `abortPending`)整段刪除,上面這段已經取代。第 151 到 154 行的檔頭註解改成:

```ts
/**
 * 組裝右窗格工具:watcher(含裁決 5 的域啟用,所以工廠是 async)、settle、handoff、
 * controller 只有一份,跟著唯一的右窗格 view;MCP server 則每個專案一份(forProject),
 * 各自帶專案守衛與 inflight。這個檔只做組裝與錯誤翻譯,動作全在 controller。
 */
```

- [ ] **Step 7: 改 `startup.ts`**

第 2、3 行的 `import type { McpServerConfig } …` 與 `import { VIEW_TOOL_SERVER_NAME } …` 刪掉。

第 14 到 36 行改成:

```ts
export interface ViewToolStartupDeps {
  readonly view: WebContentsView
  readonly clock: MergerClock
  /** 目前 active 專案的 rootPath;原樣交給 create。 */
  readonly activeProjectDir: () => string
  readonly logError: (error: Error) => void
  /** 印那一行;index.ts 給 console.error。 */
  readonly warn: (line: string) => void
  readonly attach: (wc: WebContents, opts: AttachCdpOptions) => Promise<CdpSession>
  readonly create: (deps: ViewToolDeps) => Promise<ViewTools>
}

export interface ViewToolStartup {
  /** undefined 表示右窗格工具停用(裁決 17／34);index.ts 就不替任何專案叫 forProject。 */
  readonly viewTools: ViewTools | undefined
  dispose(): Promise<void>
}

/** 裁決 34 的無工具路徑。viewTools 是 undefined,dispose 什麼都不做。 */
const NO_TOOLS: ViewToolStartup = {
  viewTools: undefined,
  dispose: () => Promise.resolve(),
}
```

第 84 到 90 行 `deps.create({ … })` 內的 `projectDir: deps.projectDir,` 改成 `activeProjectDir: deps.activeProjectDir,`。

第 98 到 100 行的回傳物件刪掉 `mcpServers: { [VIEW_TOOL_SERVER_NAME]: viewTools.server },` 那一行,只剩 `viewTools,` 與 `dispose`。

- [ ] **Step 8: 跑測試與 typecheck**

Run: `npx vitest run tests/view-tools/ && npx tsc --noEmit -p . 2>&1 | grep -v "src/main/index.ts" | grep -v "src/preload" | grep -v "src/renderer/components/LeftPane.tsx" || true`
Expected: `tests/view-tools/` 全部 PASS(server.test 新增 4 條,原有條數不減)。typecheck 除了 `src/main/index.ts`(還用舊的 `projectDir`、`startup.mcpServers`、`startTerminalServer(projectDir, …)`,Task 14 才改)、`src/preload`(Task 11)、`LeftPane.tsx`(Task 12)以外沒有錯誤。

- [ ] **Step 9: Commit**

```bash
git add src/main/view-tools/server.ts src/main/view-tools/startup.ts src/main/view-tools/controller-types.ts src/main/view-tools/controller-page.ts tests/view-tools/server.test.ts tests/view-tools/startup.test.ts tests/view-tools/controller-harness.ts tests/view-tools/controller-input.test.ts
git commit -m "feat: 右窗格工具改為每個專案一份 MCP server,背景專案呼叫回明確錯誤"
```

---

### Task 11: preload 新增專案與分頁 API,renderer 加 `useProjects`

**Files:**
- Modify: `src/preload/bridge.ts`
- Modify: `tests/preload-bridge.test.ts`
- Create: `src/renderer/hooks/useProjects.ts`
- Create: `tests/use-projects.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `YesChefApi`(新成員 `onProjects`、`getProjects`、`addProject`、`relocateProject`、`removeProject`、`activateProject`、`openTab`、`closeTab`、`activateTab`;`listSessions(scope)`)、`IPC.projectsGet`／`projectsState`／`projectsAdd`／`projectsRelocate`／`projectsRemove`／`projectsActivate`／`tabsOpen`／`tabsClose`／`tabsActivate`、`parseProjectsView`、`parseAddProjectResult`、型別 `ProjectsView`、`ProjectView`、`AddProjectResult`、`ProjectIdPayload`、`SessionListScope`、`TabOpenPayload`、`TabTargetPayload`。
- Produces(Task 12、13 的 renderer 靠這個):

```ts
// src/renderer/hooks/useProjects.ts
export interface Projects {
  /** 主行程推來的完整 view;第一次 getProjects 回來之前是空的 EMPTY_VIEW。 */
  readonly view: ProjectsView
  /** 第一份 view 到了沒。false 時 App 不畫左窗格內容,避免先閃一下「加入專案開始使用」。 */
  readonly loaded: boolean
  readonly active: ProjectView | undefined
  /** 加入或重新指定專案被拒的原因、或 IPC 失敗;下一次成功就清掉。 */
  readonly error: string | undefined
  activate(id: string): void
  add(): Promise<void>
  remove(id: string): void
  relocate(id: string): Promise<void>
  /** 三個分頁動作都作用在 active 專案;沒有 active 專案時不做事。 */
  openTab(label: string, command?: string): void
  closeTab(tabId: string): void
  activateTab(tabId: string): void
}
export const EMPTY_VIEW: ProjectsView = { projects: [], activeId: null }
export function useProjects(api: YesChefApi): Projects
```

preload 的規則沿用檔頭鐵律:任何直接呼叫 `ipcRenderer` 的箭頭函式,函式體一律用大括號。新增的 5 個 `send` 成員與 3 個 `invoke` 成員都照這條。`invoke` 的回傳一律過 Task 1 的 parser,形狀不符就拋錯,不把壞資料交給 React。

- [ ] **Step 1: 改寫 `tests/preload-bridge.test.ts`**

整檔取代:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { YesChefApi } from '../src/shared/ipc.js'

/**
 * preload 的鐵律測試（見 `src/preload/bridge.ts` 檔頭）：`ipcRenderer.on()` 與
 * `removeListener()` 為了鏈式呼叫都 `return this`，簡潔箭頭會把 `ipcRenderer`
 * 本體當成回傳值交給 contextBridge，renderer 接住 `onEvents(cb)` 的回傳值就拿到
 * 了完整的 ipcRenderer，context isolation 等於沒有。
 *
 * 替身刻意讓 `on`／`removeListener`／`send`／`invoke` 都回 `ipcRenderer` 自己，
 * 也就是把真品最危險的那個特性複製過來：少一對大括號，這裡就會紅。
 */
const exposed: { key: string; value: unknown }[] = []
const sent: { channel: string; payload: unknown }[] = []
const invoked: { channel: string; payload: unknown }[] = []
/** 每個 invoke channel 要回什麼;測試自己塞。 */
const replies = new Map<string, unknown>()

vi.mock('electron', () => {
  const ipcRenderer: Record<string, unknown> = {}
  Object.assign(ipcRenderer, {
    on: () => ipcRenderer,
    removeListener: () => ipcRenderer,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload })
      return ipcRenderer
    },
    invoke: (channel: string, payload: unknown) => {
      invoked.push({ channel, payload })
      return replies.has(channel) ? Promise.resolve(replies.get(channel)) : ipcRenderer
    },
  })
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        exposed.push({ key, value })
      },
    },
    ipcRenderer,
  }
  return { ...electron, default: electron }
})

async function loadBridge(): Promise<YesChefApi> {
  await import('../src/preload/bridge.js')
  const entry = exposed[0]
  if (entry === undefined) throw new Error('preload 沒有呼叫 exposeInMainWorld')
  return entry.value as YesChefApi
}

const VIEW = {
  activeId: 'p-1',
  projects: [
    {
      id: 'p-1',
      name: 'demo',
      rootPath: '/Users/x/demo',
      available: true,
      pendingApproval: false,
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 'th-1' }],
      threads: [{ id: 'th-1', sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }],
    },
  ],
}

describe('preload 不外洩 ipcRenderer', () => {
  it('掛在 window.yeschef 底下，且訂閱的回傳值不是 ipcRenderer', async () => {
    const api = await loadBridge()

    expect(exposed).toHaveLength(1)
    expect(exposed[0]?.key).toBe('yeschef')

    for (const ret of [api.onEvents(() => undefined), api.onProjects(() => undefined)]) {
      expect(typeof ret).toBe('function')
      expect('send' in (ret as object)).toBe(false)
      expect('invoke' in (ret as object)).toBe(false)
      expect('on' in (ret as object)).toBe(false)
    }
  })

  it('所有 send 類成員回 undefined 而不是 ipcRenderer，且 payload 形狀正確', async () => {
    const api = await loadBridge()
    sent.length = 0

    expect(api.sendInput('x')).toBeUndefined()
    expect(api.replyApproval({ requestId: 'r-1', decision: 'allow' })).toBeUndefined()
    expect(api.startNew()).toBeUndefined()
    expect(api.openHistory('s-1')).toBeUndefined()
    expect(api.handoffDone('toolu_1')).toBeUndefined()
    expect(api.removeProject('p-1')).toBeUndefined()
    expect(api.activateProject('p-2')).toBeUndefined()
    expect(api.openTab({ projectId: 'p-1', label: 'codex', command: 'codex' })).toBeUndefined()
    expect(api.openTab({ projectId: 'p-1', label: 'zsh' })).toBeUndefined()
    expect(api.closeTab({ projectId: 'p-1', tabId: 't-1' })).toBeUndefined()
    expect(api.activateTab({ projectId: 'p-1', tabId: 't-2' })).toBeUndefined()

    expect(sent.slice(-6)).toEqual([
      { channel: 'projects:remove', payload: { id: 'p-1' } },
      { channel: 'projects:activate', payload: { id: 'p-2' } },
      { channel: 'tabs:open', payload: { projectId: 'p-1', label: 'codex', command: 'codex' } },
      { channel: 'tabs:open', payload: { projectId: 'p-1', label: 'zsh' } },
      { channel: 'tabs:close', payload: { projectId: 'p-1', tabId: 't-1' } },
      { channel: 'tabs:activate', payload: { projectId: 'p-1', tabId: 't-2' } },
    ])
  })

  it('invoke 類成員的回傳過 parser：形狀對就回值，不對就拋錯', async () => {
    const api = await loadBridge()
    invoked.length = 0

    replies.set('projects:get', VIEW)
    replies.set('projects:add', { kind: 'cancelled' })
    replies.set('projects:relocate', { kind: 'added', id: 'p-1' })
    replies.set('session:list', [{ sessionId: 's-1', summary: '一場', lastModified: 1 }])

    await expect(api.getProjects()).resolves.toEqual(VIEW)
    await expect(api.addProject()).resolves.toEqual({ kind: 'cancelled' })
    await expect(api.relocateProject('p-1')).resolves.toEqual({ kind: 'added', id: 'p-1' })
    await expect(api.listSessions({ projectId: 'p-1' })).resolves.toHaveLength(1)
    expect(invoked.map((i) => i.channel)).toEqual(['projects:get', 'projects:add', 'projects:relocate', 'session:list'])
    expect(invoked[2]?.payload).toEqual({ id: 'p-1' })
    expect(invoked[3]?.payload).toEqual({ projectId: 'p-1' })

    replies.set('projects:get', { projects: 'nope' })
    replies.set('projects:add', { kind: 'weird' })
    await expect(api.getProjects()).rejects.toThrow('projects:get 回傳的形狀不符')
    await expect(api.addProject()).rejects.toThrow('projects:add 回傳的形狀不符')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/preload-bridge.test.ts`
Expected: FAIL。`api.onProjects is not a function`(第一條)、`api.removeProject is not a function`(第二條)。

- [ ] **Step 3: 改寫 `src/preload/bridge.ts`**

整檔取代(檔頭註解原樣保留,這裡只列程式碼部分的差異;`subscribe` 函式不變):

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  parseApprovalAsk,
  parseEventsBatch,
  parseSessionState,
  parseSessionSummaries,
  type HandoffDonePayload,
  type YesChefApi,
  type TerminalEndpoint,
  type Unsubscribe,
} from '../shared/ipc.js'
import {
  parseAddProjectResult,
  parseProjectsView,
  type ProjectIdPayload,
  type SessionListScope,
  type TabOpenPayload,
  type TabTargetPayload,
} from '../shared/projects.js'

/**
 * 這支檔案的鐵律：**任何直接呼叫 `ipcRenderer` 的箭頭函式，函式體一律用大括號。**
 * （以下原註解逐字保留）
 */
function subscribe<T>(
  channel: string,
  parse: (raw: unknown) => T | null,
  cb: (value: T) => void
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, raw: unknown): void => {
    const parsed = parse(raw)
    if (parsed === null) {
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
  onEvents: (cb) => subscribe(IPC.eventsBatch, parseEventsBatch, cb),
  onApprovalAsk: (cb) => subscribe(IPC.approvalAsk, parseApprovalAsk, cb),
  onSessionState: (cb) => subscribe(IPC.sessionState, parseSessionState, cb),
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
      { projectId: scope.projectId } satisfies SessionListScope,
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
}

contextBridge.exposeInMainWorld('yeschef', api)
```

刪掉的東西:`PROJECT_DIR_ARG` import、`readProjectDir()` 整個函式與它的註解、`projectDir: readProjectDir()` 成員。`src/renderer/global.d.ts` 不用改。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/preload-bridge.test.ts`
Expected: PASS,3 條。

- [ ] **Step 5: 寫 `tests/use-projects.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { EMPTY_VIEW, useProjects } from '../src/renderer/hooks/useProjects.js'
import type { YesChefApi } from '../src/shared/ipc.js'
import type { AddProjectResult, ProjectsView, ProjectView } from '../src/shared/projects.js'

afterEach(cleanup)

function project(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name: id,
    rootPath: `/p/${id}`,
    available: true,
    pendingApproval: false,
    activeTabId: `${id}-conv`,
    tabs: [
      { id: `${id}-conv`, contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: `${id}-th` },
    ],
    threads: [{ id: `${id}-th`, sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }],
    ...over,
  }
}

const TWO: ProjectsView = { activeId: 'a', projects: [project('a'), project('b')] }

interface Harness {
  readonly api: YesChefApi
  readonly calls: string[]
  push(view: ProjectsView): void
  unsubscribed(): number
}

function harness(opts: {
  readonly initial?: ProjectsView | Error
  readonly add?: AddProjectResult | Error
  readonly relocate?: AddProjectResult | Error
} = {}): Harness {
  const calls: string[] = []
  const listeners = new Set<(view: ProjectsView) => void>()
  let unsubscribed = 0
  const settle = <T,>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback)
  const api = {
    onProjects: (cb: (view: ProjectsView) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
        unsubscribed += 1
      }
    },
    getProjects: () => {
      calls.push('getProjects')
      return settle(opts.initial, TWO)
    },
    addProject: () => {
      calls.push('addProject')
      return settle(opts.add, { kind: 'cancelled' } as AddProjectResult)
    },
    relocateProject: (id: string) => {
      calls.push(`relocateProject:${id}`)
      return settle(opts.relocate, { kind: 'cancelled' } as AddProjectResult)
    },
    removeProject: (id: string) => { calls.push(`removeProject:${id}`) },
    activateProject: (id: string) => { calls.push(`activateProject:${id}`) },
    openTab: (p: { projectId: string; label: string; command?: string }) => {
      calls.push(`openTab:${p.projectId}:${p.label}:${p.command ?? '-'}`)
    },
    closeTab: (p: { projectId: string; tabId: string }) => { calls.push(`closeTab:${p.projectId}:${p.tabId}`) },
    activateTab: (p: { projectId: string; tabId: string }) => { calls.push(`activateTab:${p.projectId}:${p.tabId}`) },
  } as unknown as YesChefApi
  return {
    api,
    calls,
    push: (view) => {
      act(() => {
        for (const l of listeners) l(view)
      })
    },
    unsubscribed: () => unsubscribed,
  }
}

describe('useProjects 的載入', () => {
  it('掛載時先訂閱再 getProjects;回來之前 loaded 為 false、view 為空', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    expect(result.current.loaded).toBe(false)
    expect(result.current.view).toEqual(EMPTY_VIEW)
    expect(result.current.active).toBeUndefined()
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    expect(result.current.view).toEqual(TWO)
    expect(result.current.active?.id).toBe('a')
    expect(h.calls).toEqual(['getProjects'])
  })

  it('主行程推來的 view 直接取代;activeId 為 null 時 active 是 undefined', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    h.push({ activeId: 'b', projects: TWO.projects })
    expect(result.current.active?.id).toBe('b')
    h.push({ activeId: null, projects: [] })
    expect(result.current.active).toBeUndefined()
    expect(result.current.loaded).toBe(true)
  })

  it('getProjects 失敗:error 有訊息,loaded 也變 true(讓使用者看得到錯誤而不是永遠空白)', async () => {
    const h = harness({ initial: new Error('projects:get 回傳的形狀不符，無法顯示專案清單') })
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.error).toBe('projects:get 回傳的形狀不符，無法顯示專案清單')
    })
    expect(result.current.loaded).toBe(true)
  })

  it('卸載時取消訂閱', async () => {
    const h = harness()
    const { unmount } = renderHook(() => useProjects(h.api))
    unmount()
    expect(h.unsubscribed()).toBe(1)
  })
})

describe('useProjects 的動作', () => {
  it('activate / remove 直接轉給 api', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    result.current.activate('b')
    result.current.remove('a')
    expect(h.calls.slice(1)).toEqual(['activateProject:b', 'removeProject:a'])
  })

  it('分頁動作帶 active 專案的 id;沒有 active 專案時不送', async () => {
    const h = harness()
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    act(() => {
      result.current.openTab('codex', 'codex')
      result.current.openTab('zsh')
      result.current.closeTab('a-t1')
      result.current.activateTab('a-conv')
    })
    expect(h.calls.slice(1)).toEqual([
      'openTab:a:codex:codex',
      'openTab:a:zsh:-',
      'closeTab:a:a-t1',
      'activateTab:a:a-conv',
    ])

    h.push({ activeId: null, projects: [] })
    h.calls.length = 0
    act(() => {
      result.current.openTab('zsh')
      result.current.closeTab('x')
      result.current.activateTab('x')
    })
    expect(h.calls).toEqual([])
  })

  it('add 被拒時 error 是主行程給的原因;下一次成功就清掉', async () => {
    const h = harness({ add: { kind: 'rejected', message: '這個資料夾不能當專案' } })
    const { result } = renderHook(() => useProjects(h.api))
    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    await act(() => result.current.add())
    expect(result.current.error).toBe('這個資料夾不能當專案')

    const ok = harness({ add: { kind: 'added', id: 'c' } })
    const second = renderHook(() => useProjects(ok.api))
    await waitFor(() => {
      expect(second.result.current.loaded).toBe(true)
    })
    await act(() => second.result.current.add())
    expect(second.result.current.error).toBeUndefined()
  })

  it('add 取消不算錯誤', async () => {
    const h = harness({ add: { kind: 'cancelled' } })
    const { result } = renderHook(() => useProjects(h.api))
    await act(() => result.current.add())
    expect(result.current.error).toBeUndefined()
  })

  it('add 的 IPC 拋錯時 error 是那個訊息', async () => {
    const h = harness({ add: new Error('projects:add 回傳的形狀不符') })
    const { result } = renderHook(() => useProjects(h.api))
    await act(() => result.current.add())
    expect(result.current.error).toBe('projects:add 回傳的形狀不符')
  })

  it('relocate 帶 id,結果處理與 add 相同', async () => {
    const h = harness({ relocate: { kind: 'rejected', message: '資料夾不存在' } })
    const { result } = renderHook(() => useProjects(h.api))
    await act(() => result.current.relocate('b'))
    expect(h.calls).toContain('relocateProject:b')
    expect(result.current.error).toBe('資料夾不存在')
  })
})
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run tests/use-projects.test.tsx`
Expected: FAIL,`Failed to resolve import "../src/renderer/hooks/useProjects.js"`。

- [ ] **Step 7: 寫 `src/renderer/hooks/useProjects.ts`**

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { AddProjectResult, ProjectView, ProjectsView } from '../../shared/projects.js'

export interface Projects {
  /** 主行程推來的完整 view;第一次 getProjects 回來之前是空的 EMPTY_VIEW。 */
  readonly view: ProjectsView
  /** 第一份 view 到了沒。false 時 App 不畫左窗格內容,避免先閃一下「加入專案開始使用」。 */
  readonly loaded: boolean
  readonly active: ProjectView | undefined
  /** 加入或重新指定專案被拒的原因、或 IPC 失敗;下一次成功就清掉。 */
  readonly error: string | undefined
  activate(id: string): void
  add(): Promise<void>
  remove(id: string): void
  relocate(id: string): Promise<void>
  /** 三個分頁動作都作用在 active 專案;沒有 active 專案時不做事。 */
  openTab(label: string, command?: string): void
  closeTab(tabId: string): void
  activateTab(tabId: string): void
}

export const EMPTY_VIEW: ProjectsView = { projects: [], activeId: null }

const LOAD_FAILED = '讀取專案清單失敗'

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback
}

/**
 * 專案與分頁的 renderer 端狀態(規格 §3.1):renderer 只認 id,所有改動送到主行程,
 * 主行程改完狀態再推整份 `ProjectsView` 回來,這裡沒有任何本地推測更新。
 *
 * 先訂閱 `onProjects` 再 `getProjects()`:反過來的話,invoke 回來之前主行程推的
 * 那一份會漏掉。`getProjects` 順便讓主行程重送 active 對話的內容(Task 7 規則 7)。
 */
export function useProjects(api: YesChefApi): Projects {
  const [view, setView] = useState<ProjectsView>(EMPTY_VIEW)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    const unsubscribe = api.onProjects((next) => {
      setView(next)
      setLoaded(true)
    })
    let alive = true
    api
      .getProjects()
      .then((next) => {
        if (!alive) return
        setView(next)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(messageOf(err, LOAD_FAILED))
        setLoaded(true)
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api])

  const activeId = view.activeId
  const active = useMemo(
    () => (activeId === null ? undefined : view.projects.find((p) => p.id === activeId)),
    [view, activeId]
  )

  /** add 與 relocate 共用:rejected 顯示原因,added／cancelled 清掉舊錯誤,IPC 拋錯顯示訊息。 */
  const settle = useCallback((task: Promise<AddProjectResult>, fallback: string): Promise<void> => {
    return task
      .then((result) => {
        setError(result.kind === 'rejected' ? result.message : undefined)
      })
      .catch((err: unknown) => {
        setError(messageOf(err, fallback))
      })
  }, [])

  const activate = useCallback((id: string): void => { api.activateProject(id) }, [api])
  const remove = useCallback((id: string): void => { api.removeProject(id) }, [api])
  const add = useCallback((): Promise<void> => settle(api.addProject(), '加入專案失敗'), [api, settle])
  const relocate = useCallback(
    (id: string): Promise<void> => settle(api.relocateProject(id), '重新指定資料夾失敗'),
    [api, settle]
  )

  const openTab = useCallback(
    (label: string, command?: string): void => {
      if (activeId === null) return
      api.openTab(command === undefined ? { projectId: activeId, label } : { projectId: activeId, label, command })
    },
    [api, activeId]
  )
  const closeTab = useCallback(
    (tabId: string): void => {
      if (activeId === null) return
      api.closeTab({ projectId: activeId, tabId })
    },
    [api, activeId]
  )
  const activateTab = useCallback(
    (tabId: string): void => {
      if (activeId === null) return
      api.activateTab({ projectId: activeId, tabId })
    },
    [api, activeId]
  )

  return useMemo(
    () => ({ view, loaded, active, error, activate, add, remove, relocate, openTab, closeTab, activateTab }),
    [view, loaded, active, error, activate, add, remove, relocate, openTab, closeTab, activateTab]
  )
}
```

- [ ] **Step 8: 跑測試與 typecheck**

Run: `npx vitest run tests/use-projects.test.tsx tests/preload-bridge.test.ts`
Expected: PASS,use-projects 10 條、preload 3 條。

Run: `npx tsc --noEmit -p . 2>&1 | grep -E "^src/preload/|^src/renderer/hooks/useProjects|^tests/(use-projects|preload-bridge)" || echo "本 task 的檔案沒有型別錯誤"`
Expected: 印出「本 task 的檔案沒有型別錯誤」。整體 tsc 這時仍會有錯,都在別的 task 才改的檔案:`src/main/index.ts`(Task 14)、`src/renderer/App.tsx` 還讀 `api.projectDir`、`src/renderer/components/LeftPane.tsx` 還用舊的 `Terminal` props(Task 12),`tests/app-title-bar.test.tsx`、`tests/use-approvals.test.tsx`、`tests/use-sessions.test.tsx` 的 fake 還有 `projectDir` 又缺新成員(Task 12、13)。這些不在本 task 修。

- [ ] **Step 9: Commit**

```bash
git add src/preload/bridge.ts tests/preload-bridge.test.ts src/renderer/hooks/useProjects.ts tests/use-projects.test.tsx
git commit -m "feat: preload 提供專案與分頁 API,renderer 新增 useProjects"
```

---

### Task 12: 專案列、分頁列改吃主行程狀態、標題列與批准卡跟著專案切

**Files:**
- Create: `src/renderer/components/ProjectBar.tsx`
- Create: `src/renderer/components/ProjectBar.css`
- Create: `tests/project-bar.test.tsx`
- Create: `tests/helpers/fake-yeschef.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/title.ts`
- Modify: `src/renderer/components/LeftPane.tsx`
- Modify: `src/renderer/components/LeftPane.css`
- Modify: `src/renderer/hooks/useApprovals.ts`
- Modify: `tests/app-title-bar.test.tsx`
- Modify: `tests/left-pane.test.tsx`
- Modify: `tests/use-approvals.test.tsx`
- Delete: `src/renderer/hooks/useTerminals.ts`
- Delete: `tests/use-terminals.test.tsx`

**Interfaces:**
- Consumes: Task 11 的 `Projects`／`useProjects`／`EMPTY_VIEW`;Task 1 的 `ProjectView`、`ProjectsView`、`TabEntry`;Task 9 的 `Terminal({ endpoint, projectId, command? })`;既有 `useApprovals`、`useConversation`、`useSessions`、`Recents`、`Conversation`。
- Produces:

```ts
// src/renderer/components/ProjectBar.tsx
export interface ProjectBarProps { readonly projects: Projects }
export function ProjectBar({ projects }: ProjectBarProps): React.ReactElement

// src/renderer/components/LeftPane.tsx
export interface LeftPaneProps {
  readonly projects: Projects
  readonly conversation: React.ReactNode
  readonly endpoint: string | null
}
export const EMPTY_HINT = '加入專案開始使用'
export function LeftPane(props: LeftPaneProps): React.ReactElement

// src/renderer/title.ts
export const NO_PROJECT_TITLE = '尚未加入專案'
export function titleFor(active: ProjectView | undefined): string

// src/renderer/hooks/useApprovals.ts
export function useApprovals(api: YesChefApi, activeId: string | null): Approvals

// tests/helpers/fake-yeschef.ts(Task 13 的測試也用)
export const EMPTY_PROJECTS: ProjectsView
export function projectView(id: string, over?: Partial<ProjectView>): ProjectView
export function terminalTab(id: string, label: string, sortOrder: number, command?: string): TabEntry
export const ONE_PROJECT: ProjectsView        // p-1 / demo / /Users/x/Projects/demo,只有對話分頁
export function createFakeYesChef(opts?: { sessions?: readonly SessionSummary[]; projects?: ProjectsView }): FakeYesChef
export function fakeProjects(view: ProjectsView, over?: Partial<Projects>): { projects: Projects; calls: string[] }
```

規則(規格 §3.2、§5、§6):

1. 分頁狀態不再放 renderer(`useTerminals` 刪除)。分頁列畫的是 `active.tabs` 依 `sortOrder` 排序,標籤 `customLabel ?? label`,對話分頁沒有關閉鈕。點分頁送 `activateTab`、關送 `closeTab`、快捷送 `openTab(label, command)`。
2. 終端不能因為切專案而卸載:`terminal-server.ts` 在 ws 關閉時 `pty.kill()`,卸載 `Terminal` 等於殺掉背景專案的 shell,違反規格 §2「背景專案繼續跑」。所以每個曾經成為 active 的專案,其終端分頁都留在 DOM 裡,只用 `hidden` 控制可見;專案被移除後才卸載。這是記憶體成本,Task 15 量。
3. 對話內容只有一份 React tree(主行程對每個專案各有一個 core,切換時 `replay()` 整份重送,Task 7 規則 3),所以對話 slot 永遠掛載,只在 active 專案的 active 分頁是對話時顯示。
4. 沒有 active 專案:左窗格顯示「加入專案開始使用」,不畫分頁列。active 專案不可用(`available: false`):顯示「資料夾 {rootPath} 不存在」與「重新指定資料夾」「移除專案」兩顆鈕,不畫分頁列(規格 §6:標示為不可用,由使用者決定)。
5. 專案列(規格 §5):每個專案一格,active 高亮;`pendingApproval` 顯示 `●`;不可用顯示 `!`;每格一顆 `×` 移除;最右邊 `+` 開資料夾選擇器(呼叫 `projects.add()`,對話框由主行程開)。`projects.error` 顯示在專案列下方。
6. 標題列改顯示 active 專案名,沒有專案顯示「尚未加入專案」。裁決 21 的「顯示 session 的 cwd」作廢:Recents 之後(Task 13)預設只列本專案,cwd 不再需要在標題列講清楚。
7. `useApprovals` 多一個 `activeId` 參數:`activeId` 改變就清空 `pending`。Task 7 規則 2 保證主行程先推新的 `projects:state` 再送新專案扣住的批准,所以清空只會清到前一個專案的卡。前一個專案進行中的請求不會被回答,主行程 30 秒逾時後自己 deny(Task 6 的 registry 預設 30_000)。
8. `App` 在 `projects.loaded` 為 false 時不畫 `LeftPane`,避免啟動先閃一下「加入專案開始使用」。

- [ ] **Step 1: 寫 `tests/helpers/fake-yeschef.ts`**

```ts
import { act } from '@testing-library/react'
import type { Projects } from '../../src/renderer/hooks/useProjects.js'
import type { ApprovalAskPayload, ApprovalReplyPayload, SessionSummary, YesChefApi } from '../../src/shared/ipc.js'
import type { ProjectsView, ProjectView, TabEntry } from '../../src/shared/projects.js'
import type { SessionState } from '../../src/shared/session-state.js'
import type { Event } from '../../src/shared/events.js'

/**
 * 假的 YesChefApi。preload 的真品要 Electron,這裡只需要「訂閱得到、送得出去」
 * 這兩件事,所以自己拿幾個 Set 當事件來源,順便可以斷言訂閱有沒有解除。
 * `calls` 記所有 send 類呼叫(`名稱:引數`),測試斷言接線用。
 */
export interface FakeYesChef {
  readonly api: YesChefApi
  readonly replies: ApprovalReplyPayload[]
  readonly calls: string[]
  emitAsk(ask: ApprovalAskPayload): void
  emitState(state: SessionState): void
  emitEvents(events: readonly Event[]): void
  emitProjects(view: ProjectsView): void
  listenerCounts(): { ask: number; state: number }
}

export const EMPTY_PROJECTS: ProjectsView = { projects: [], activeId: null }

export function projectView(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name: id,
    rootPath: `/p/${id}`,
    available: true,
    pendingApproval: false,
    activeTabId: `${id}-conv`,
    tabs: [
      { id: `${id}-conv`, contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: `${id}-th` },
    ],
    threads: [{ id: `${id}-th`, sessions: [], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 }],
    ...over,
  }
}

export function terminalTab(id: string, label: string, sortOrder: number, command?: string): TabEntry {
  const base = { id, contentType: 'terminal' as const, label, customLabel: null, sortOrder, lastFocusedAt: sortOrder }
  return command === undefined ? base : { ...base, command }
}

export const ONE_PROJECT: ProjectsView = {
  activeId: 'p-1',
  projects: [projectView('p-1', { name: 'demo', rootPath: '/Users/x/Projects/demo' })],
}

export function createFakeYesChef(
  opts: { readonly sessions?: readonly SessionSummary[]; readonly projects?: ProjectsView } = {}
): FakeYesChef {
  const askListeners = new Set<(ask: ApprovalAskPayload) => void>()
  const stateListeners = new Set<(state: SessionState) => void>()
  const eventListeners = new Set<(events: readonly Event[]) => void>()
  const projectListeners = new Set<(view: ProjectsView) => void>()
  const replies: ApprovalReplyPayload[] = []
  const calls: string[] = []
  // getProjects 回「目前這一份」而不是建構時那一份:App 測試 render 之後立刻 emitProjects,
  // invoke 的 promise 在下一個 microtask 才 resolve,這時要拿到 emit 過的 view,不能把它蓋回去。
  let current: ProjectsView = opts.projects ?? EMPTY_PROJECTS

  const on = <T,>(set: Set<(v: T) => void>) => (cb: (v: T) => void) => {
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  const api: YesChefApi = {
    onEvents: on(eventListeners),
    onApprovalAsk: on(askListeners),
    onSessionState: on(stateListeners),
    onProjects: on(projectListeners),
    sendInput: (text) => { calls.push(`sendInput:${text}`) },
    replyApproval: (reply) => { replies.push(reply) },
    listSessions: () => Promise.resolve(opts.sessions ?? []),
    startNew: () => { calls.push('startNew') },
    openHistory: (sessionId) => { calls.push(`openHistory:${sessionId}`) },
    handoffDone: (toolUseId) => { calls.push(`handoffDone:${toolUseId}`) },
    terminalEndpoint: () => Promise.resolve({ port: 1 }),
    getProjects: () => Promise.resolve().then(() => current),
    addProject: () => { calls.push('addProject'); return Promise.resolve({ kind: 'cancelled' }) },
    relocateProject: (id) => { calls.push(`relocateProject:${id}`); return Promise.resolve({ kind: 'cancelled' }) },
    removeProject: (id) => { calls.push(`removeProject:${id}`) },
    activateProject: (id) => { calls.push(`activateProject:${id}`) },
    openTab: (p) => { calls.push(`openTab:${p.projectId}:${p.label}:${p.command ?? '-'}`) },
    closeTab: (p) => { calls.push(`closeTab:${p.projectId}:${p.tabId}`) },
    activateTab: (p) => { calls.push(`activateTab:${p.projectId}:${p.tabId}`) },
  }

  const emit = <T,>(set: Set<(v: T) => void>) => (value: T) => {
    act(() => {
      for (const l of set) l(value)
    })
  }

  return {
    api,
    replies,
    calls,
    emitAsk: emit(askListeners),
    emitState: emit(stateListeners),
    emitEvents: emit(eventListeners),
    emitProjects: (view) => {
      current = view
      emit(projectListeners)(view)
    },
    listenerCounts: () => ({ ask: askListeners.size, state: stateListeners.size }),
  }
}

/** 直接餵給 ProjectBar／LeftPane 的假 `Projects`,動作都記進 calls。 */
export function fakeProjects(view: ProjectsView, over: Partial<Projects> = {}): { projects: Projects; calls: string[] } {
  const calls: string[] = []
  const projects: Projects = {
    view,
    loaded: true,
    active: view.activeId === null ? undefined : view.projects.find((p) => p.id === view.activeId),
    error: undefined,
    activate: (id) => { calls.push(`activate:${id}`) },
    add: () => { calls.push('add'); return Promise.resolve() },
    remove: (id) => { calls.push(`remove:${id}`) },
    relocate: (id) => { calls.push(`relocate:${id}`); return Promise.resolve() },
    openTab: (label, command) => { calls.push(`openTab:${label}:${command ?? '-'}`) },
    closeTab: (tabId) => { calls.push(`closeTab:${tabId}`) },
    activateTab: (tabId) => { calls.push(`activateTab:${tabId}`) },
    ...over,
  }
  return { projects, calls }
}
```

這個檔案副檔名是 `.ts`(沒有 JSX),放 `tests/helpers/` 底下,vitest 的預設 include 只抓 `*.test.*`,不會把它當測試跑。`const on = <T,>(…)` 的逗號是為了在 `.tsx` 也能解析,`.ts` 檔保留無害。

- [ ] **Step 2: 寫 `tests/project-bar.test.tsx`**

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { ProjectBar } from '../src/renderer/components/ProjectBar.js'
import { EMPTY_PROJECTS, fakeProjects, projectView } from './helpers/fake-yeschef.js'
import type { ProjectsView } from '../src/shared/projects.js'

afterEach(cleanup)

const TWO: ProjectsView = {
  activeId: 'a',
  projects: [projectView('a', { name: 'mirage' }), projectView('b', { name: 'yeschef' })],
}

describe('ProjectBar', () => {
  it('每個專案一格,active 的 aria-selected 為 true,點別格呼叫 activate', () => {
    const { projects, calls } = fakeProjects(TWO)
    render(<ProjectBar projects={projects} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    expect(tabs[0]?.className).toContain('on')
    fireEvent.click(screen.getByRole('tab', { name: /yeschef/ }))
    expect(calls).toEqual(['activate:b'])
  })

  it('pendingApproval 顯示待批准記號;不可用的專案顯示 ! 並帶 unavailable class', () => {
    const view: ProjectsView = {
      activeId: 'a',
      projects: [
        projectView('a', { name: 'mirage', pendingApproval: true }),
        projectView('b', { name: 'gone', available: false }),
      ],
    }
    const { projects } = fakeProjects(view)
    render(<ProjectBar projects={projects} />)
    expect(screen.getAllByTitle('有待批准的請求')).toHaveLength(1)
    expect(screen.getAllByTitle('資料夾不存在')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: /gone/ }).className).toContain('unavailable')
    expect(screen.getByRole('tab', { name: /mirage/ }).className).not.toContain('unavailable')
  })

  it('移除鈕呼叫 remove,而且不會順便 activate 那一格', () => {
    const { projects, calls } = fakeProjects(TWO)
    render(<ProjectBar projects={projects} />)
    fireEvent.click(screen.getByRole('button', { name: '移除專案 yeschef' }))
    expect(calls).toEqual(['remove:b'])
  })

  it('+ 呼叫 add', () => {
    const { projects, calls } = fakeProjects(TWO)
    render(<ProjectBar projects={projects} />)
    fireEvent.click(screen.getByRole('button', { name: '加入專案' }))
    expect(calls).toEqual(['add'])
  })

  it('error 以 role=alert 顯示在專案列下方;沒有 error 就沒有那個元素', () => {
    const withError = fakeProjects(TWO, { error: '這個資料夾不能當專案' }).projects
    const { rerender } = render(<ProjectBar projects={withError} />)
    expect(screen.getByRole('alert').textContent).toBe('這個資料夾不能當專案')
    rerender(<ProjectBar projects={fakeProjects(TWO).projects} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('沒有專案時只剩加入鈕', () => {
    const { projects } = fakeProjects(EMPTY_PROJECTS)
    render(<ProjectBar projects={projects} />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '加入專案' })).toBeTruthy()
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/project-bar.test.tsx`
Expected: FAIL,`Failed to resolve import "../src/renderer/components/ProjectBar.js"`。

- [ ] **Step 4: 寫 `src/renderer/components/ProjectBar.tsx` 與 `ProjectBar.css`**

`src/renderer/components/ProjectBar.tsx`:

```tsx
import type React from 'react'
import type { Projects } from '../hooks/useProjects.js'
import type { ProjectView } from '../../shared/projects.js'
import './ProjectBar.css'

export interface ProjectBarProps {
  readonly projects: Projects
}

function chipClass(p: ProjectView, on: boolean): string {
  return ['project-chip', on ? 'on' : '', p.available ? '' : 'unavailable'].filter((c) => c !== '').join(' ')
}

/**
 * 分頁列上方那一列專案(規格 §5)。只畫 `projects.view`,所有動作送回主行程,
 * 主行程改完狀態再推新的 view 回來;這裡沒有自己的狀態。
 */
export function ProjectBar({ projects }: ProjectBarProps): React.ReactElement {
  const { view, error } = projects
  return (
    <div className="project-bar-wrap">
      <div className="project-bar" role="tablist" aria-label="專案">
        {view.projects.map((p) => {
          const on = p.id === view.activeId
          return (
            <div
              key={p.id}
              role="tab"
              aria-selected={on}
              className={chipClass(p, on)}
              onClick={() => projects.activate(p.id)}
            >
              <span className="project-name">{p.name}</span>
              {p.pendingApproval ? (
                <span className="project-pending" role="img" aria-label="有待批准的請求" title="有待批准的請求">
                  ●
                </span>
              ) : null}
              {p.available ? null : (
                <span className="project-unavailable" role="img" aria-label="資料夾不存在" title="資料夾不存在">
                  !
                </span>
              )}
              <button
                type="button"
                className="project-remove"
                aria-label={`移除專案 ${p.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  projects.remove(p.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="project-add"
          aria-label="加入專案"
          onClick={() => {
            void projects.add()
          }}
        >
          +
        </button>
      </div>
      {error === undefined ? null : (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
```

`src/renderer/components/ProjectBar.css`:

```css
.project-bar-wrap { flex: 0 0 auto; border-bottom: 1px solid #2a2d24; }
.project-bar { display: flex; align-items: center; gap: 4px; overflow-x: auto; padding: 4px 8px; }
.project-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 4px; color: #8e9488; cursor: pointer; white-space: nowrap; }
.project-chip.on { color: inherit; background: #1d2018; }
.project-chip.unavailable .project-name { text-decoration: line-through; }
.project-pending { color: #e0b64a; font-size: 10px; }
.project-unavailable { color: #d9705a; font-weight: bold; }
.project-remove { padding: 0 2px; border: 0; color: inherit; background: none; cursor: pointer; opacity: 0.6; }
.project-remove:hover { opacity: 1; }
.project-add { margin-left: auto; padding: 3px 8px; cursor: pointer; }
.project-error { margin: 0; padding: 2px 8px 6px; color: #d9705a; font-size: 12px; }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run tests/project-bar.test.tsx`
Expected: PASS,6 條。

- [ ] **Step 6: 改寫 `tests/left-pane.test.tsx`**

整檔取代:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'

vi.mock('../src/renderer/components/Terminal.js', () => ({
  Terminal: ({ projectId, command }: { projectId: string; command?: string }) => (
    <div data-testid="term">{`${projectId}:${command ?? 'zsh'}`}</div>
  ),
}))

import { LeftPane, EMPTY_HINT } from '../src/renderer/components/LeftPane.js'
import { EMPTY_PROJECTS, fakeProjects, projectView, terminalTab } from './helpers/fake-yeschef.js'
import type { ProjectsView } from '../src/shared/projects.js'

afterEach(cleanup)

const conv = <div data-testid="conv">對話內容</div>
const WS = 'ws://127.0.0.1:1'

/** 專案 a:對話 + codex 終端 + zsh 終端(sortOrder 故意打亂,測排序)。 */
const A_WITH_TERMS = projectView('a', {
  tabs: [
    terminalTab('a-t2', 'zsh', 2),
    { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 'a-th' },
    terminalTab('a-t1', 'codex', 1, 'codex'),
  ],
  activeTabId: 'a-conv',
})

function slotOf(el: HTMLElement): HTMLElement {
  const slot = el.closest('.pane-slot')
  if (!(slot instanceof HTMLElement)) throw new Error('元素不在 .pane-slot 裡')
  return slot
}

describe('LeftPane 沒有專案', () => {
  it('顯示提示,不畫分頁列,對話 slot 隱藏', () => {
    const { projects } = fakeProjects(EMPTY_PROJECTS)
    render(<LeftPane projects={projects} conversation={conv} endpoint={WS} />)
    expect(screen.getByText(EMPTY_HINT)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(true)
  })
})

describe('LeftPane 分頁列', () => {
  it('分頁依 sortOrder 排列,對話分頁沒有關閉鈕,customLabel 優先於 label', () => {
    const view: ProjectsView = {
      activeId: 'a',
      projects: [
        projectView('a', {
          tabs: [...A_WITH_TERMS.tabs.slice(0, 2), { ...terminalTab('a-t1', 'codex', 1, 'codex'), customLabel: '我的 codex' }],
        }),
      ],
    }
    render(<LeftPane projects={fakeProjects(view).projects} conversation={conv} endpoint={WS} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.querySelector('span')?.textContent)).toEqual(['Claude 對話', '我的 codex', 'zsh'])
    expect(tabs[0]?.querySelector('.tab-close')).toBeNull()
    expect(tabs[1]?.querySelector('.tab-close')).not.toBeNull()
  })

  it('對話分頁 active 時只顯示對話 slot;終端分頁 active 時只顯示那個終端', () => {
    const { rerender } = render(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] }).projects} conversation={conv} endpoint={WS} />
    )
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(false)
    const terms = screen.getAllByTestId('term')
    expect(terms.map((t) => t.textContent)).toEqual(['a:zsh', 'a:codex'])
    expect(terms.every((t) => slotOf(t).hidden)).toBe(true)

    const codexActive = projectView('a', { tabs: A_WITH_TERMS.tabs, activeTabId: 'a-t1' })
    rerender(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: [codexActive] }).projects} conversation={conv} endpoint={WS} />
    )
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(true)
    expect(slotOf(screen.getByText('a:codex')).hidden).toBe(false)
    expect(slotOf(screen.getByText('a:zsh')).hidden).toBe(true)
  })

  it('點分頁送 activateTab;點 × 送 closeTab 且不觸發 activateTab;快捷送 openTab', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] })
    render(<LeftPane projects={projects} conversation={conv} endpoint={WS} />)
    fireEvent.click(screen.getByRole('tab', { name: /^zsh/ }))
    fireEvent.click(screen.getAllByRole('button', { name: '關閉分頁' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'zsh' }))
    expect(calls).toEqual(['activateTab:a-t2', 'closeTab:a-t1', 'openTab:codex:codex', 'openTab:zsh:-'])
  })

  it('endpoint 還沒好時終端 slot 顯示連線中', () => {
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS] }).projects} conversation={conv} endpoint={null} />)
    expect(screen.getAllByText('終端機連線中')).toHaveLength(2)
    expect(screen.queryAllByTestId('term')).toHaveLength(0)
  })
})

describe('LeftPane 切專案', () => {
  const B = projectView('b', { tabs: [...projectView('b').tabs, terminalTab('b-t1', 'zsh', 1)], activeTabId: 'b-t1' })

  it('切到別的專案後,前一個專案的終端仍掛載但隱藏;沒成為過 active 的專案不掛', () => {
    const both = [A_WITH_TERMS, B]
    const { rerender } = render(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: both }).projects} conversation={conv} endpoint={WS} />
    )
    expect(screen.getAllByTestId('term').map((t) => t.textContent)).toEqual(['a:zsh', 'a:codex'])

    rerender(<LeftPane projects={fakeProjects({ activeId: 'b', projects: both }).projects} conversation={conv} endpoint={WS} />)
    const terms = screen.getAllByTestId('term').map((t) => t.textContent)
    expect(terms).toEqual(['a:zsh', 'a:codex', 'b:zsh'])
    expect(slotOf(screen.getByText('a:codex')).hidden).toBe(true)
    expect(slotOf(screen.getByText('b:zsh')).hidden).toBe(false)
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(true)
  })

  it('專案被移除後它的終端才卸載', () => {
    const { rerender } = render(
      <LeftPane projects={fakeProjects({ activeId: 'a', projects: [A_WITH_TERMS, B] }).projects} conversation={conv} endpoint={WS} />
    )
    rerender(<LeftPane projects={fakeProjects({ activeId: 'b', projects: [A_WITH_TERMS, B] }).projects} conversation={conv} endpoint={WS} />)
    expect(screen.getAllByTestId('term')).toHaveLength(3)
    rerender(<LeftPane projects={fakeProjects({ activeId: 'b', projects: [B] }).projects} conversation={conv} endpoint={WS} />)
    expect(screen.getAllByTestId('term').map((t) => t.textContent)).toEqual(['b:zsh'])
  })
})

describe('LeftPane 專案不可用', () => {
  it('顯示資料夾不存在與兩顆鈕,不畫分頁列;鈕分別呼叫 relocate 與 remove', () => {
    const gone = projectView('a', { rootPath: '/Users/x/gone', available: false })
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [gone] })
    render(<LeftPane projects={projects} conversation={conv} endpoint={WS} />)
    expect(screen.getByRole('alert').textContent).toContain('資料夾 /Users/x/gone 不存在')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(slotOf(screen.getByTestId('conv')).hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新指定資料夾' }))
    fireEvent.click(screen.getByRole('button', { name: '移除專案' }))
    expect(calls).toEqual(['relocate:a', 'remove:a'])
  })
})
```

- [ ] **Step 7: 跑測試確認失敗**

Run: `npx vitest run tests/left-pane.test.tsx`
Expected: FAIL,`EMPTY_HINT` 不是 export、`LeftPane` 讀不到 `projects` prop(`Cannot read properties of undefined (reading 'view')`)。

- [ ] **Step 8: 改寫 `src/renderer/components/LeftPane.tsx`,補 `LeftPane.css`,刪 `useTerminals`**

`src/renderer/components/LeftPane.tsx` 整檔取代:

```tsx
import type React from 'react'
import { useEffect, useState } from 'react'
import type { Projects } from '../hooks/useProjects.js'
import type { ProjectView, TabEntry } from '../../shared/projects.js'
import { Terminal } from './Terminal.js'
import './LeftPane.css'

export interface LeftPaneProps {
  readonly projects: Projects
  readonly conversation: React.ReactNode
  readonly endpoint: string | null
}

export const QUICK_LAUNCH: readonly { readonly label: string; readonly command?: string }[] = [
  { label: 'claude', command: 'claude' },
  { label: 'codex', command: 'codex' },
  { label: 'grok', command: 'grok' },
  { label: 'zsh' },
] as const

export const EMPTY_HINT = '加入專案開始使用'

function sortedTabs(p: ProjectView): readonly TabEntry[] {
  return [...p.tabs].sort((a, b) => a.sortOrder - b.sortOrder)
}

function labelOf(tab: TabEntry): string {
  return tab.customLabel ?? tab.label
}

/**
 * 曾經成為 active 的專案 id。終端的 ws 一斷主行程就 `pty.kill()`,所以背景專案的
 * `Terminal` 不能卸載,只能藏;這個清單決定哪些專案的終端要留在 DOM 裡。
 * 專案被移除(不在 `known` 裡)就不再保留。
 */
function useSeen(activeId: string | null, known: readonly string[]): readonly string[] {
  const [seen, setSeen] = useState<readonly string[]>(() => (activeId === null ? [] : [activeId]))
  useEffect(() => {
    if (activeId === null) return
    setSeen((prev) => (prev.includes(activeId) ? prev : [...prev, activeId]))
  }, [activeId])
  return seen.filter((id) => known.includes(id))
}

function TabStrip({ projects, active }: { readonly projects: Projects; readonly active: ProjectView }): React.ReactElement {
  return (
    <div className="tab-strip" role="tablist">
      {sortedTabs(active).map((tab) => {
        const on = tab.id === active.activeTabId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={on}
            className={`tab${on ? ' on' : ''}`}
            onClick={() => projects.activateTab(tab.id)}
          >
            <span>{labelOf(tab)}</span>
            {tab.contentType === 'terminal' ? (
              <button
                type="button"
                className="tab-close"
                aria-label="關閉分頁"
                onClick={(event) => {
                  event.stopPropagation()
                  projects.closeTab(tab.id)
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        )
      })}
      <div className="quick-launch">
        {QUICK_LAUNCH.map((quick) => (
          <button key={quick.label} type="button" onClick={() => projects.openTab(quick.label, quick.command)}>
            {quick.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Unavailable({ projects, active }: { readonly projects: Projects; readonly active: ProjectView }): React.ReactElement {
  return (
    <div className="pane-unavailable" role="alert">
      <p>資料夾 {active.rootPath} 不存在</p>
      <div className="pane-unavailable-actions">
        <button
          type="button"
          onClick={() => {
            void projects.relocate(active.id)
          }}
        >
          重新指定資料夾
        </button>
        <button type="button" onClick={() => projects.remove(active.id)}>
          移除專案
        </button>
      </div>
    </div>
  )
}

/**
 * 左窗格(規格 §3.2、§5):分頁列畫 active 專案的分頁,內容區放一份對話 slot 加上
 * 「所有曾 active 的專案」的終端 slot,用 `hidden` 決定誰可見。分頁狀態全在主行程,
 * 這裡只有 `useSeen` 這一點本地狀態,而且它只影響掛載,不影響顯示什麼。
 */
export function LeftPane({ projects, conversation, endpoint }: LeftPaneProps): React.ReactElement {
  const { view, active } = projects
  const seen = useSeen(view.activeId, view.projects.map((p) => p.id))
  const usable = active !== undefined && active.available
  const activeTab = active?.tabs.find((t) => t.id === active.activeTabId)
  const showConversation = usable && activeTab?.contentType === 'conversation'

  return (
    <div className="left-pane">
      {active === undefined ? (
        <div className="pane-empty">{EMPTY_HINT}</div>
      ) : active.available ? (
        <TabStrip projects={projects} active={active} />
      ) : (
        <Unavailable projects={projects} active={active} />
      )}
      <div className="pane-area" hidden={!usable}>
        <div className="pane-slot" hidden={!showConversation}>
          {conversation}
        </div>
        {view.projects
          .filter((p) => seen.includes(p.id))
          .flatMap((p) =>
            sortedTabs(p)
              .filter((tab) => tab.contentType === 'terminal')
              .map((tab) => (
                <div key={tab.id} className="pane-slot" hidden={!(p.id === view.activeId && tab.id === p.activeTabId)}>
                  {endpoint === null ? (
                    <div className="term-loading">終端機連線中</div>
                  ) : (
                    <Terminal endpoint={endpoint} projectId={p.id} command={tab.command} />
                  )}
                </div>
              ))
          )}
      </div>
    </div>
  )
}
```

`src/renderer/components/LeftPane.css` 在 `.pane-slot[hidden] { display: none; }` 之後加五行:

```css
.pane-area[hidden] { display: none; }
.pane-empty, .pane-unavailable { display: flex; flex: 1 1 auto; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #8e9488; }
.pane-unavailable p { margin: 0; padding: 0 16px; word-break: break-all; }
.pane-unavailable-actions { display: flex; gap: 8px; }
.pane-unavailable-actions button { padding: 4px 10px; cursor: pointer; }
```

`.pane-area` 自己有 `display: flex`,會蓋掉瀏覽器預設的 `[hidden] { display: none }`,所以 `.pane-area[hidden]` 要另外寫,跟 `.pane-slot[hidden]` 同一個理由。

刪檔:

```bash
git rm src/renderer/hooks/useTerminals.ts tests/use-terminals.test.tsx
```

- [ ] **Step 9: 跑測試確認通過**

Run: `npx vitest run tests/left-pane.test.tsx tests/project-bar.test.tsx`
Expected: PASS,left-pane 8 條、project-bar 6 條。

- [ ] **Step 10: 改 `src/renderer/title.ts` 與 `src/renderer/hooks/useApprovals.ts`**

`src/renderer/title.ts` 整檔取代:

```ts
import type { ProjectView } from '../shared/projects.js'

export const NO_PROJECT_TITLE = '尚未加入專案'

/**
 * 標題列文字(規格 §3.2 標題列那一列):顯示 active 專案的名稱。
 * 沒有 active 專案(清單為空、或 active 指到已移除的專案)就顯示提示。
 * A 時期「viewing 別的目錄的 session 就顯示那個 cwd」的規則(裁決 21)不再需要:
 * Recents 預設只列本專案,切到「全部」時每一列自己標目錄(Task 13)。
 */
export function titleFor(active: ProjectView | undefined): string {
  return active?.name ?? NO_PROJECT_TITLE
}
```

`src/renderer/hooks/useApprovals.ts` 整檔取代:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApprovalAskPayload, ApprovalDecision, YesChefApi } from '../../shared/ipc.js'

export interface Approvals {
  readonly pending: readonly ApprovalAskPayload[]
  reply(requestId: string, decision: ApprovalDecision): void
}

/**
 * 待回答的批准請求。
 *
 * 兩個訂閱加一個依賴:
 * - `onApprovalAsk`:到達順序累積,不可變地換新陣列
 * - `onSessionState`:狀態離開 `live` 就清空
 * - `activeId` 改變就清空:主行程只把 active 專案的 `approval:ask` 推給 renderer
 *   (Task 7 規則 2),切專案後留在這裡的都是前一個專案的請求。它們在主行程
 *   還開著,由 30 秒逾時自己 deny(Task 6 的 `createApprovalRegistry`),
 *   或使用者切回去時靠 `replay()` 重送再回答。
 *
 * 清空只是「不再顯示」,不是「代替使用者回答」。切換 session 時 main 側的
 * 狀態機第一步就是 `registry.denyAll()`,那些 promise 在主程序已經以 deny 了結,
 * renderer 這邊再送一次回覆只會撞到一個不存在的 requestId。
 */
export function useApprovals(api: YesChefApi, activeId: string | null): Approvals {
  const [pending, setPending] = useState<readonly ApprovalAskPayload[]>([])

  useEffect(
    () =>
      api.onApprovalAsk((ask) => {
        setPending((prev) =>
          // 同一個 requestId 重送(例如 main 重試或 replay)不疊第二張卡片。
          prev.some((p) => p.requestId === ask.requestId) ? prev : [...prev, ask]
        )
      }),
    [api]
  )

  useEffect(
    () =>
      api.onSessionState((state) => {
        if (state.kind !== 'live') setPending([])
      }),
    [api]
  )

  useEffect(() => {
    setPending([])
  }, [activeId])

  const reply = useCallback(
    (requestId: string, decision: ApprovalDecision): void => {
      api.replyApproval({ requestId, decision })
      setPending((prev) => prev.filter((p) => p.requestId !== requestId))
    },
    [api]
  )

  return useMemo(() => ({ pending, reply }), [pending, reply])
}
```

- [ ] **Step 11: 改 `tests/use-approvals.test.tsx`**

這個檔案大部分測試不動,只有四件事:本地的 `createFakeApi` 換成共用 helper、hook 多一個 `activeId` 引數、App 測試 render 後先送專案清單、新增一條 activeId 測試。用腳本改,每一步都有數量斷言,數量不對就停:

```bash
python3 - <<'PY'
import pathlib
p = pathlib.Path('tests/use-approvals.test.tsx')
s = p.read_text()

old_imports = """import type { ApprovalAskPayload, ApprovalReplyPayload, YesChefApi } from '../src/shared/ipc.js'
import type { SessionState } from '../src/shared/session-state.js'
import type { Event } from '../src/shared/events.js'
"""
new_imports = """import type { ApprovalAskPayload } from '../src/shared/ipc.js'
import { createFakeYesChef as createFakeApi, ONE_PROJECT } from './helpers/fake-yeschef.js'
"""
assert s.count(old_imports) == 1, 'import 區塊找不到'
s = s.replace(old_imports, new_imports)

start = s.index('/**\n * 假的 YesChefApi')
end = s.index('function ask(')
assert start < end, '本地 createFakeApi 的位置不對'
s = s[:start] + s[end:]

n = s.count('useApprovals(fake.api)')
assert n == 10, f'useApprovals(fake.api) 應有 10 處,實際 {n}'
s = s.replace('useApprovals(fake.api)', "useApprovals(fake.api, 'p-1')")

old_render = "const { container } = render(<App />)\n"
n = s.count(old_render)
assert n == 3, f'render(<App />) 應有 3 處,實際 {n}'
s = s.replace(old_render, old_render + "    fake.emitProjects(ONE_PROJECT)\n")

anchor = "  it('卸載時兩個訂閱都解除', () => {"
assert s.count(anchor) == 1, '找不到插入點'
new_test = """  it('activeId 改變時清空 pending,且不代替使用者回答', () => {
    const fake = createFakeApi()
    const { result, rerender } = renderHook(
      ({ activeId }: { activeId: string | null }) => useApprovals(fake.api, activeId),
      { initialProps: { activeId: 'p-1' } }
    )
    fake.emitAsk(ask('req-1'))
    expect(result.current.pending).toHaveLength(1)

    rerender({ activeId: 'p-2' })

    expect(result.current.pending).toEqual([])
    expect(fake.replies).toEqual([])
    fake.emitAsk(ask('req-2'))
    expect(result.current.pending.map((p) => p.requestId)).toEqual(['req-2'])
  })

"""
s = s.replace(anchor, new_test + anchor)
p.write_text(s)
print('ok')
PY
```

改完 `grep -n "createFakeApi\|emitProjects" tests/use-approvals.test.tsx` 應看到 import 那一行、13 處 `createFakeApi()`、3 處 `fake.emitProjects(ONE_PROJECT)`。

App 測試要在 `render(<App />)` 之後立刻 `emitProjects`,原因是 `App` 在 `projects.loaded` 為 false 時不畫 `LeftPane`,輸入框根本不在 DOM 裡;而且 `useApprovals` 在 activeId 從 null 變成 `p-1` 時會清空 pending,所以專案清單一定要在 `emitAsk` 之前送。

- [ ] **Step 12: 改寫 `tests/app-title-bar.test.tsx`**

整檔取代:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { App } from '../src/renderer/App.js'
import { NO_PROJECT_TITLE } from '../src/renderer/title.js'
import { createFakeYesChef, EMPTY_PROJECTS, ONE_PROJECT } from './helpers/fake-yeschef.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function titleBarText(container: HTMLElement) {
  return container.querySelector('.title-bar')?.textContent
}

describe('App 標題列', () => {
  it('沒有專案時顯示提示', () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(EMPTY_PROJECTS)
    expect(titleBarText(container)).toBe(NO_PROJECT_TITLE)
  })

  it('顯示 active 專案的名稱', () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    expect(titleBarText(container)).toBe('demo')
  })

  it('主行程推新的清單時標題跟著換', () => {
    const fake = createFakeYesChef()
    vi.stubGlobal('yeschef', fake.api)
    const { container } = render(<App />)
    fake.emitProjects(ONE_PROJECT)
    const renamed = { ...ONE_PROJECT, projects: ONE_PROJECT.projects.map((p) => ({ ...p, name: 'demo-2' })) }
    fake.emitProjects(renamed)
    expect(titleBarText(container)).toBe('demo-2')
  })
})
```

- [ ] **Step 13: 改 `src/renderer/App.tsx`**

四處改動,其他不動。

import 區加兩行(放在 `import { LeftPane } …` 之後):

```ts
import { ProjectBar } from './components/ProjectBar.js'
import { useProjects } from './hooks/useProjects.js'
```

`App()` 開頭的三行:

```ts
  const api = window.yeschef
  const { view: rawView, sessionState, turnEnds } = useConversation(api)
  const { pending, reply } = useApprovals(api)
```

改成:

```ts
  const api = window.yeschef
  const projects = useProjects(api)
  const activeId = projects.view.activeId
  const { view: rawView, sessionState, turnEnds } = useConversation(api)
  const { pending, reply } = useApprovals(api, activeId)
```

最後的 return:

```tsx
  return (
    <div className="app">
      <header className="title-bar">{titleFor(api.projectDir, current, sessions)}</header>
      <LeftPane conversation={conversation} endpoint={endpoint} />
    </div>
  )
```

改成:

```tsx
  return (
    <div className="app">
      <header className="title-bar">{titleFor(projects.active)}</header>
      <ProjectBar projects={projects} />
      {projects.loaded ? <LeftPane projects={projects} conversation={conversation} endpoint={endpoint} /> : null}
    </div>
  )
```

檔頭 doc comment 以「標題列（Task 11，裁決 21）」開頭的最後一段,整段換成:

```
 * 專案(子專案 D):`useProjects` 是唯一的專案狀態來源,標題列、`ProjectBar`、
 * `LeftPane` 都吃它;`useApprovals` 拿 `activeId` 在切專案時清掉前一個專案的卡片。
 * `projects.loaded` 為 false 時不畫 `LeftPane`,避免啟動時先閃一下「加入專案開始使用」。
 * A 時期「標題列顯示 viewing 的那個 cwd」(裁決 21)由 Recents 分組取代,見 Task 13。
```

- [ ] **Step 14: 跑測試與型別檢查**

Run: `npx vitest run tests/project-bar.test.tsx tests/left-pane.test.tsx tests/app-title-bar.test.tsx tests/use-approvals.test.tsx`
Expected: PASS,四檔共 6 + 8 + 3 + 14 = 31 條。

Run: `npx tsc --noEmit -p . 2>&1 | grep -E "^src/renderer/|^tests/(project-bar|left-pane|app-title-bar|use-approvals|helpers/fake-yeschef)" | grep -v "^src/renderer/hooks/useSessions" || echo "本 task 的檔案沒有型別錯誤"`

`src/renderer/hooks/useSessions.ts` 與 `tests/use-sessions.test.tsx` 會報 `listSessions` 少一個引數,那是 Task 13 的範圍;`src/main/index.ts` 會報 `PROJECT_DIR_ARG`、`startTerminalServer`、`createIpcBridge` 的型別錯誤,那是 Task 14 的範圍。這兩塊以外若還有紅字,就是本 task 的問題。

- [ ] **Step 15: Commit**

```bash
git add src/renderer/components/ProjectBar.tsx src/renderer/components/ProjectBar.css tests/project-bar.test.tsx tests/helpers/fake-yeschef.ts src/renderer/App.tsx src/renderer/title.ts src/renderer/components/LeftPane.tsx src/renderer/components/LeftPane.css src/renderer/hooks/useApprovals.ts tests/app-title-bar.test.tsx tests/left-pane.test.tsx tests/use-approvals.test.tsx
```

Step 8 的 `git rm` 已把兩個刪除的檔案排進暫存區,不必再列。接著:

```bash
git commit -m "feat: 專案列與分頁列改吃主行程狀態,標題列與批准卡跟著專案切"
```

---

### Task 13: Recents 依 thread 分組,預設只列本專案

**Files:**
- Create: `src/renderer/recents-groups.ts`
- Create: `tests/recents-groups.test.ts`
- Modify: `src/renderer/components/Recents.tsx`
- Modify: `src/renderer/components/Recents.css`
- Modify: `src/renderer/hooks/useSessions.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/recents.test.tsx`
- Modify: `tests/use-sessions.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ThreadEntry`、`SessionLink`、`SessionListScope`;Task 11 的 `Projects`(`view`、`active`);既有 `SessionSummary`(`sessionId`、`summary`、`lastModified`、`cwd?`、`customTitle?`、`gitBranch?`);Task 7 規則 8(`session:list` 依 `projectId` 過濾,`null` 回全部)。
- Produces:

```ts
// src/renderer/recents-groups.ts
export interface ThreadGroup {
  readonly key: string
  readonly head: SessionSummary
  readonly rest: readonly SessionSummary[]
}
export function groupSessions(sessions: readonly SessionSummary[], threads: readonly ThreadEntry[]): readonly ThreadGroup[]

// src/renderer/components/Recents.tsx
export type SessionScope = 'project' | 'all'
export interface RecentsProps {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly onOpen: (sessionId: string) => void
  readonly onStartNew: () => void
  readonly error?: string
  readonly threads?: readonly ThreadEntry[]
  readonly scope?: SessionScope
  readonly onScopeChange?: (scope: SessionScope) => void
}

// src/renderer/hooks/useSessions.ts
export function useSessions(api: YesChefApi, refresh: number, scope: SessionListScope): UseSessions
```

規則(規格 §3.2 Recents 那一列):

1. 分組是純函式 `groupSessions`,不碰 React。同一條 thread 的 session 合成一組:head 是鏈上最後一筆(它有在清單裡的話),否則取該組最新的一筆;`rest` 是其餘的,新到舊。不屬於任何 thread 的 session 各自一組,`key` 為 `solo:<sessionId>`;thread 組的 `key` 為 `thread:<threadId>`。組之間依 `head.lastModified` 新到舊。
2. thread 的連結指到清單裡沒有的 session(例如還在 live、或 transcript 已被刪)就略過;整條 thread 一筆都對不到就不成組。同一個 session 只會出現在一組。
3. `Recents` 預設一組畫一列(head),`rest` 非空時列尾多一顆「+N 筆較早」鈕,按了展開成子清單、鈕文字變「收合」。展開狀態放在 `Recents` 自己的 state,不進主行程。
4. 「本專案／全部」是一對 `aria-pressed` 按鈕;`onScopeChange` 沒給就不畫(沒有 active 專案時,App 不給)。`scope` 為 `all` 時每一列多顯示 `cwd`(有的話),因為標題列已不再顯示目錄。
5. `useSessions` 的重載鍵併入 `scope.projectId`(`null` 記成 `*`),scope 一變就重載;`listSessions` 改帶 `scope`。
6. `App` 持有 `scope` state,預設 `project`;`listScope` 為 `{ projectId: scope === 'all' ? null : activeId }`。`threads` 在 `project` 時給 active 專案的,`all` 時給所有專案的合併。切專案時 scope 不重設(使用者選了「全部」就一直是全部)。
7. 既有 `tests/recents.test.tsx` 的測試一條都不改,只追加;THREE 沒有 threads 時三筆各自一組,順序與畫法跟現在一樣,這是回歸防線。

- [ ] **Step 1: 寫 `tests/recents-groups.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { groupSessions } from '../src/renderer/recents-groups.js'
import type { SessionSummary } from '../src/shared/ipc.js'
import type { SessionLink, ThreadEntry } from '../src/shared/projects.js'

const s = (sessionId: string, lastModified: number): SessionSummary => ({ sessionId, summary: sessionId, lastModified })
const link = (sessionId: string): SessionLink => ({
  sessionId,
  transcriptPath: `/t/${sessionId}.jsonl`,
  parentSessionId: null,
  startedAt: 0,
  endedAt: null,
  endReason: null,
})
const thread = (id: string, ...ids: string[]): ThreadEntry => ({
  id,
  sessions: ids.map(link),
  handoffVersion: 0,
  switchPhase: { kind: 'idle' },
  createdAt: 0,
})

const A = s('a', 30)
const B = s('b', 20)
const C = s('c', 10)
const D = s('d', 40)

describe('groupSessions', () => {
  it('沒有 thread 時每一筆各自一組,依 lastModified 新到舊', () => {
    const groups = groupSessions([C, A, B], [])
    expect(groups.map((g) => g.key)).toEqual(['solo:a', 'solo:b', 'solo:c'])
    expect(groups.every((g) => g.rest.length === 0)).toBe(true)
  })

  it('同一條 thread 合成一組:head 是鏈上最後一筆,rest 新到舊', () => {
    const groups = groupSessions([A, B, C], [thread('th', 'a', 'c', 'b')])
    expect(groups).toEqual([{ key: 'thread:th', head: B, rest: [A, C] }])
  })

  it('鏈上最後一筆不在清單裡時,head 取該組最新的一筆', () => {
    const groups = groupSessions([A, C], [thread('th', 'c', 'a', 'zzz')])
    expect(groups).toEqual([{ key: 'thread:th', head: A, rest: [C] }])
  })

  it('整條 thread 一筆都對不到就不成組;對不到的連結不影響其他成員', () => {
    const groups = groupSessions([A], [thread('empty', 'x', 'y'), thread('th', 'a', 'x')])
    expect(groups).toEqual([{ key: 'thread:th', head: A, rest: [] }])
  })

  it('thread 組與 solo 混排,依 head.lastModified 新到舊', () => {
    const groups = groupSessions([A, B, C, D], [thread('th', 'c', 'b')])
    expect(groups.map((g) => g.key)).toEqual(['solo:d', 'solo:a', 'thread:th'])
    expect(groups[2]?.head).toEqual(B)
    expect(groups[2]?.rest).toEqual([C])
  })

  it('被 thread 收走的 session 不再另成 solo;兩條 thread 搶同一筆時先來的贏', () => {
    const groups = groupSessions([A, B], [thread('t1', 'a'), thread('t2', 'a', 'b')])
    expect(groups.map((g) => g.key)).toEqual(['thread:t1', 'thread:t2'])
    expect(groups[1]).toEqual({ key: 'thread:t2', head: B, rest: [] })
    expect(groups.flatMap((g) => [g.head, ...g.rest]).map((x) => x.sessionId).sort()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/recents-groups.test.ts`
Expected: FAIL,`Cannot find module '../src/renderer/recents-groups.js'`。

- [ ] **Step 3: 寫 `src/renderer/recents-groups.ts`**

```ts
import type { SessionSummary } from '../shared/ipc.js'
import type { ThreadEntry } from '../shared/projects.js'

export interface ThreadGroup {
  readonly key: string
  readonly head: SessionSummary
  readonly rest: readonly SessionSummary[]
}

const newestFirst = (a: SessionSummary, b: SessionSummary): number => b.lastModified - a.lastModified

const newestOf = (members: readonly SessionSummary[]): SessionSummary | undefined =>
  members.reduce<SessionSummary | undefined>((best, m) => (best === undefined || m.lastModified > best.lastModified ? m : best), undefined)

/**
 * 依 thread 分組(規格 §3.2 Recents 那一列)。
 * - 同一條 thread 的 session 合成一組;head 是鏈上最後一筆(有在清單裡的話),
 *   否則取該組最新的一筆;rest 新到舊。
 * - 不屬於任何 thread 的 session(別的工具開的、或 D 之前的歷史)各自一組。
 * - 組之間依 head.lastModified 新到舊。
 * 一個 session 只會出現在一組:先處理的 thread 先收走。
 */
export function groupSessions(sessions: readonly SessionSummary[], threads: readonly ThreadEntry[]): readonly ThreadGroup[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s] as const))
  const claimed = new Set<string>()
  const grouped: ThreadGroup[] = []

  for (const thread of threads) {
    const members = thread.sessions
      .map((l) => byId.get(l.sessionId))
      .filter((s): s is SessionSummary => s !== undefined && !claimed.has(s.sessionId))
    if (members.length === 0) continue
    for (const m of members) claimed.add(m.sessionId)
    const lastId = thread.sessions.at(-1)?.sessionId
    const head = members.find((m) => m.sessionId === lastId) ?? newestOf(members)
    if (head === undefined) continue
    grouped.push({ key: `thread:${thread.id}`, head, rest: members.filter((m) => m !== head).sort(newestFirst) })
  }

  const solo = sessions.filter((s) => !claimed.has(s.sessionId)).map((s) => ({ key: `solo:${s.sessionId}`, head: s, rest: [] }))
  return [...grouped, ...solo].sort((a, b) => newestFirst(a.head, b.head))
}
```

`newestOf` 用 reduce 而不是 `sort()[0]`,是因為 `noUncheckedIndexedAccess` 會讓 `[0]` 變成 `T | undefined`,寫法一樣要處理 undefined,reduce 少一次複製。`members.length === 0` 已經擋掉,`head === undefined` 那條 `continue` 只是讓型別收窄,不會真的走到。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run tests/recents-groups.test.ts`
Expected: PASS,6 條。

- [ ] **Step 5: 在 `tests/recents.test.tsx` 追加分組與範圍切換的測試**

檔頭 import 區加兩行(放在 `import type { SessionSummary } …` 之後):

```ts
import type { SessionLink, ThreadEntry } from '../src/shared/projects.js'
```

檔尾追加:

```tsx
const link = (sessionId: string): SessionLink => ({
  sessionId,
  transcriptPath: `/t/${sessionId}.jsonl`,
  parentSessionId: null,
  startedAt: 0,
  endedAt: null,
  endReason: null,
})
/** s-3 → s-2 這一條 thread,s-2 是現行。 */
const ONE_THREAD: readonly ThreadEntry[] = [
  { id: 'th', sessions: [link('s-3'), link('s-2')], handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 0 },
]

describe('Recents 依 thread 分組', () => {
  it('同一條 thread 收成一列,尾端有「+N 筆較早」', () => {
    const { container } = renderRecents({ threads: ONE_THREAD })
    const titles = [...container.querySelectorAll('.recents-title')].map((n) => n.textContent)
    expect(titles).toEqual(['第一場', '自訂標題'])
    expect(container.querySelector('.recents-expand')?.textContent).toBe('+1 筆較早')
  })

  it('按「+N 筆較早」展開較早的 session,再按一次收合', () => {
    const { container } = renderRecents({ threads: ONE_THREAD })
    fireEvent.click(container.querySelector('.recents-expand') as Element)
    const titles = [...container.querySelectorAll('.recents-title')].map((n) => n.textContent)
    expect(titles).toEqual(['第一場', '自訂標題', '第三場'])
    expect(container.querySelector('.recents-expand')?.textContent).toBe('收合')
    expect(container.querySelector('.recents-expand')?.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(container.querySelector('.recents-expand') as Element)
    expect(container.querySelectorAll('.recents-title')).toHaveLength(2)
  })

  it('展開後點較早的那一筆,onOpen 帶它的 sessionId', () => {
    const { container, onOpen } = renderRecents({ threads: ONE_THREAD })
    fireEvent.click(container.querySelector('.recents-expand') as Element)
    fireEvent.click(container.querySelector('.recents-rest .recents-item') as Element)
    expect(onOpen.mock.calls).toEqual([['s-3']])
  })

  it('current 在較早那一筆時,head 不高亮,展開後那一筆才高亮', () => {
    const { container } = renderRecents({ threads: ONE_THREAD, current: 's-3' })
    expect(container.querySelectorAll('.is-current')).toHaveLength(0)
    fireEvent.click(container.querySelector('.recents-expand') as Element)
    expect(container.querySelector('.is-current .recents-title')?.textContent).toBe('第三場')
  })
})

describe('Recents 的範圍切換', () => {
  it('沒給 onScopeChange 就不畫切換鈕', () => {
    const { container } = renderRecents()
    expect(container.querySelector('.recents-scope')).toBeNull()
  })

  it('本專案／全部 兩顆鈕以 aria-pressed 標示目前範圍,按另一顆呼叫 onScopeChange', () => {
    const onScopeChange = vi.fn()
    const { getByRole } = renderRecents({ scope: 'project', onScopeChange })
    expect(getByRole('button', { name: '本專案' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(getByRole('button', { name: '全部' }))
    expect(onScopeChange.mock.calls).toEqual([['all']])
  })

  it('範圍是全部時每一列顯示 cwd;本專案時不顯示', () => {
    const withCwd = THREE.map((s) => ({ ...s, cwd: `/Users/x/${s.sessionId}` }))
    const all = renderRecents({ sessions: withCwd, scope: 'all', onScopeChange: vi.fn() })
    expect([...all.container.querySelectorAll('.recents-cwd')].map((n) => n.textContent)).toEqual([
      '/Users/x/s-1',
      '/Users/x/s-2',
      '/Users/x/s-3',
    ])
    cleanup()
    const project = renderRecents({ sessions: withCwd, scope: 'project', onScopeChange: vi.fn() })
    expect(project.container.querySelectorAll('.recents-cwd')).toHaveLength(0)
  })
})
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run tests/recents.test.tsx`
Expected: 既有 21 條 PASS;新增 7 條 FAIL(`threads`／`scope` prop 沒被吃,找不到 `.recents-expand`、`.recents-scope`、`.recents-cwd`)。

- [ ] **Step 7: 改寫 `src/renderer/components/Recents.tsx`,補 `Recents.css`**

`src/renderer/components/Recents.tsx` 整檔取代:

```tsx
import { useState } from 'react'
import type { SessionSummary } from '../../shared/ipc.js'
import type { ThreadEntry } from '../../shared/projects.js'
import { groupSessions, type ThreadGroup } from '../recents-groups.js'
import { formatRelativeTime } from './relative-time.js'
import './Recents.css'

export type SessionScope = 'project' | 'all'

export interface RecentsProps {
  readonly sessions: readonly SessionSummary[]
  readonly current?: string
  readonly onOpen: (sessionId: string) => void
  readonly onStartNew: () => void
  readonly error?: string
  /** 用來分組的 thread;沒給就每一筆各自一列。 */
  readonly threads?: readonly ThreadEntry[]
  readonly scope?: SessionScope
  /** 沒給就不畫「本專案／全部」切換(沒有 active 專案時)。 */
  readonly onScopeChange?: (scope: SessionScope) => void
}

/** 裁決 7 的 SessionSummary 兩個欄位都可能是標題,customTitle 是使用者自己下的,優先。 */
function titleOf(s: SessionSummary): string {
  const custom = (s.customTitle ?? '').trim()
  return custom === '' ? s.summary : custom
}

interface ItemProps {
  readonly s: SessionSummary
  readonly current: string | undefined
  readonly at: number
  readonly showCwd: boolean
  readonly onOpen: (sessionId: string) => void
}

function SessionItem({ s, current, at, showCwd, onOpen }: ItemProps) {
  const isCurrent = s.sessionId === current
  return (
    <button
      type="button"
      className={isCurrent ? 'recents-item is-current' : 'recents-item'}
      aria-current={isCurrent ? 'true' : undefined}
      onClick={() => {
        onOpen(s.sessionId)
      }}
    >
      <span className="recents-title">{titleOf(s)}</span>
      <span className="recents-meta">
        <time dateTime={new Date(s.lastModified).toISOString()}>{formatRelativeTime(s.lastModified, at)}</time>
        {s.gitBranch === undefined ? null : <span className="recents-branch">{s.gitBranch}</span>}
      </span>
      {showCwd && s.cwd !== undefined ? <span className="recents-cwd">{s.cwd}</span> : null}
    </button>
  )
}

interface GroupProps extends Omit<ItemProps, 's'> {
  readonly group: ThreadGroup
  readonly open: boolean
  readonly onToggle: () => void
}

function Group({ group, open, onToggle, ...item }: GroupProps) {
  return (
    <li className="recents-group">
      <SessionItem s={group.head} {...item} />
      {group.rest.length === 0 ? null : (
        <>
          <button type="button" className="recents-expand" aria-expanded={open} onClick={onToggle}>
            {open ? '收合' : `+${group.rest.length} 筆較早`}
          </button>
          {open ? (
            <ul className="recents-rest">
              {group.rest.map((s) => (
                <li key={s.sessionId}>
                  <SessionItem s={s} {...item} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </li>
  )
}

export function Recents({
  sessions,
  current,
  onOpen,
  onStartNew,
  error,
  threads = [],
  scope = 'project',
  onScopeChange,
}: RecentsProps) {
  const at = Date.now()
  const [opened, setOpened] = useState<readonly string[]>([])
  const toggle = (key: string) => {
    setOpened((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }
  const groups = groupSessions(sessions, threads)

  return (
    <nav className="recents" aria-label="歷史對話">
      <button type="button" className="recents-new" onClick={onStartNew}>
        新對話
      </button>
      {onScopeChange === undefined ? null : (
        <div className="recents-scope" role="group" aria-label="範圍">
          <button type="button" aria-pressed={scope === 'project'} onClick={() => onScopeChange('project')}>
            本專案
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => onScopeChange('all')}>
            全部
          </button>
        </div>
      )}
      {error === undefined ? null : (
        <p className="recents-error" role="alert">
          {error}
        </p>
      )}
      {/* 有錯誤時不顯示「還沒有歷史對話」:讀不到跟真的沒有是兩件事,
          顯示成後者等於用一句安慰的話蓋掉一個故障。 */}
      {error === undefined && sessions.length === 0 ? <p className="recents-empty">還沒有歷史對話</p> : null}
      <ul className="recents-list">
        {groups.map((g) => (
          <Group
            key={g.key}
            group={g}
            open={opened.includes(g.key)}
            onToggle={() => toggle(g.key)}
            current={current}
            at={at}
            showCwd={scope === 'all'}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </nav>
  )
}
```

`src/renderer/components/Recents.css` 檔尾追加:

```css
.recents-scope { display: flex; gap: 4px; margin: 0 8px 8px; }
.recents-scope button { flex: 1 1 0; padding: 3px 0; border: 1px solid #3a3f36; background: none; color: inherit; cursor: pointer; font-size: 12px; }
.recents-scope button[aria-pressed="true"] { background: #232720; }
.recents-cwd { font-size: 11px; opacity: 0.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recents-expand { margin: 0 10px 4px; padding: 2px 6px; border: 0; background: none; color: inherit; opacity: 0.6; cursor: pointer; font-size: 11px; }
.recents-rest { list-style: none; margin: 0; padding: 0 0 0 12px; border-left: 1px solid #3a3f36; }
```

- [ ] **Step 8: 跑測試確認通過**

Run: `npx vitest run tests/recents.test.tsx tests/recents-groups.test.ts`
Expected: PASS,recents 28 條、recents-groups 6 條。

- [ ] **Step 9: 改 `tests/use-sessions.test.tsx`**

用腳本改,數量斷言不對就停:

```bash
python3 - <<'PY'
import pathlib
p = pathlib.Path('tests/use-sessions.test.tsx')
s = p.read_text()

old = "import type { SessionSummary, YesChefApi } from '../src/shared/ipc.js'\n"
new = old + "import type { SessionListScope } from '../src/shared/projects.js'\n"
assert s.count(old) == 1
s = s.replace(old, new)

old = "  readonly unsubscribed: () => number\n}\n"
new = "  readonly unsubscribed: () => number\n  readonly scopes: () => readonly (string | null)[]\n}\n\nconst PROJECT: SessionListScope = { projectId: 'p-1' }\n"
assert s.count(old) == 1
s = s.replace(old, new)

old = "  let unsubscribed = 0\n"
new = "  let unsubscribed = 0\n  const scopes: (string | null)[] = []\n"
assert s.count(old) == 1
s = s.replace(old, new)

old = "    listSessions: () => {\n      calls += 1\n"
new = "    listSessions: (scope: SessionListScope) => {\n      calls += 1\n      scopes.push(scope.projectId)\n"
assert s.count(old) == 1
s = s.replace(old, new)

old = "    projectDir: '/Users/x/Projects/demo',\n"
assert s.count(old) == 1
s = s.replace(old, "")

old = "    unsubscribed: () => unsubscribed,\n  }\n"
new = "    unsubscribed: () => unsubscribed,\n    scopes: () => scopes,\n  }\n"
assert s.count(old) == 1
s = s.replace(old, new)

n = s.count('useSessions(h.api, 0)')
assert n == 11, f'useSessions(h.api, 0) 應有 11 處,實際 {n}'
s = s.replace('useSessions(h.api, 0)', 'useSessions(h.api, 0, PROJECT)')
n = s.count('useSessions(h.api, refresh)')
assert n == 1, n
s = s.replace('useSessions(h.api, refresh)', 'useSessions(h.api, refresh, PROJECT)')

anchor = "  it('卸載時取消 session:state 訂閱', async () => {"
assert s.count(anchor) == 1
new_test = """  it('scope 改變時重載,且每次都把 projectId 傳給 listSessions(null 代表全部)', async () => {
    const h = harness()
    const { rerender } = renderHook(({ scope }: { scope: SessionListScope }) => useSessions(h.api, 0, scope), {
      initialProps: { scope: PROJECT },
    })
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })

    rerender({ scope: { projectId: null } })
    await waitFor(() => {
      expect(h.listCalls()).toBe(2)
    })
    rerender({ scope: { projectId: 'p-2' } })
    await waitFor(() => {
      expect(h.listCalls()).toBe(3)
    })
    expect(h.scopes()).toEqual(['p-1', null, 'p-2'])
  })

  it('內容相同的 scope 物件換新參照不重載', async () => {
    const h = harness()
    const { rerender } = renderHook(({ scope }: { scope: SessionListScope }) => useSessions(h.api, 0, scope), {
      initialProps: { scope: { projectId: 'p-1' } },
    })
    await waitFor(() => {
      expect(h.listCalls()).toBe(1)
    })
    rerender({ scope: { projectId: 'p-1' } })
    await Promise.resolve()
    expect(h.listCalls()).toBe(1)
  })

"""
s = s.replace(anchor, new_test + anchor)
p.write_text(s)
print('ok')
PY
```

- [ ] **Step 10: 跑測試確認失敗**

Run: `npx vitest run tests/use-sessions.test.tsx`
Expected: 新增兩條 FAIL(scope 變了沒有重載,`listSessions` 沒收到 scope 所以 `scopes()` 是 `[undefined, …]` 或直接 TypeError)。其餘照舊 PASS。

- [ ] **Step 11: 改 `src/renderer/hooks/useSessions.ts`**

三處改動。import 區加一行:

```ts
import type { SessionListScope } from '../../shared/projects.js'
```

`useSessions` 的簽名與 doc comment:

```ts
/**
 * @param refresh 額外的重載觸發。狀態沒變但內容變了的情況只有一種:live 對話在
 * 同一個 sessionId 底下又結束了一個回合,摘要與排序都該更新。呼叫端傳一個每回合
 * 遞增的數字,這裡就把它併進重載鍵。
 * @param scope 列哪個專案的(規格 §3.2):`projectId: null` 是全部。併進重載鍵的是
 * `projectId` 字串而不是物件本身,呼叫端每次 render 給新物件也不會重載。
 */
export function useSessions(api: YesChefApi, refresh: number, scope: SessionListScope): UseSessions {
```

重載鍵與呼叫:

```ts
  const projectKey = scope.projectId ?? '*'
  const key = `${reloadKey(state)}:${refresh}:${projectKey}`
  useEffect(() => {
    // cancelled 擋的是慢的舊請求蓋掉快的新請求:連按兩筆歷史對話時會有兩次
    // listSessions 同時在飛,先發的後回就會把畫面倒退回舊清單。
    let cancelled = false
    api
      .listSessions({ projectId: projectKey === '*' ? null : projectKey })
```

其餘(`then`／`catch`／回傳)不動。effect 的 deps 維持 `[api, key]`;`projectKey` 已經在 `key` 裡,不必另外列。

- [ ] **Step 12: 跑測試確認通過**

Run: `npx vitest run tests/use-sessions.test.tsx`
Expected: PASS,14 條。

- [ ] **Step 13: 改 `src/renderer/App.tsx` 接上 scope 與 threads**

import 區:`import { Recents } from './components/Recents.js'` 改成

```ts
import { Recents, type SessionScope } from './components/Recents.js'
```

`App()` 裡的這一段:

```ts
  // live 的 sessionId 由 session-started 寫進狀態,重載鍵一變就先重載一次,
  // 進行中的對話因此會出現在側邊欄並被高亮;之後每結束一個回合(session-end)
  // 再重載一次,摘要與排序跟著更新。
  const { sessions, current, error } = useSessions(api, turnEnds)
```

改成:

```ts
  // Recents 的範圍(規格 §3.2):預設本專案,使用者可切成全部;切專案不重設。
  const [scope, setScope] = useState<SessionScope>('project')
  const listScope = useMemo(() => ({ projectId: scope === 'all' ? null : activeId }), [scope, activeId])
  const threads = useMemo(
    () => (scope === 'all' ? projects.view.projects.flatMap((p) => p.threads) : (projects.active?.threads ?? [])),
    [scope, projects.view, projects.active]
  )
  // live 的 sessionId 由 session-started 寫進狀態,重載鍵一變就先重載一次,
  // 進行中的對話因此會出現在側邊欄並被高亮;之後每結束一個回合(session-end)
  // 再重載一次,摘要與排序跟著更新。
  const { sessions, current, error } = useSessions(api, turnEnds, listScope)
```

`<Recents … />` 的 JSX:

```tsx
        <Recents
          sessions={sessions}
          current={current}
          error={error}
          onOpen={api.openHistory}
          onStartNew={api.startNew}
        />
```

改成:

```tsx
        <Recents
          sessions={sessions}
          current={current}
          error={error}
          threads={threads}
          scope={scope}
          onScopeChange={projects.active === undefined ? undefined : setScope}
          onOpen={api.openHistory}
          onStartNew={api.startNew}
        />
```

`activeId === null` 且 scope 為 `project` 時 `listScope` 是 `{ projectId: null }`,會列全部;此時 `LeftPane` 反正只顯示「加入專案開始使用」,Recents 不在畫面上,列什麼都無所謂,不必為它多一個分支。

- [ ] **Step 14: 跑測試與型別檢查**

Run: `npx vitest run tests/recents.test.tsx tests/recents-groups.test.ts tests/use-sessions.test.tsx tests/app-title-bar.test.tsx tests/use-approvals.test.tsx`
Expected: PASS,28 + 6 + 14 + 3 + 14 = 65 條。

Run: `npx tsc --noEmit -p . 2>&1 | grep -v "^src/main/index.ts" || echo "index.ts 以外沒有型別錯誤"`
Expected: 只剩 `src/main/index.ts` 的錯誤(Task 14 處理)。renderer 與 tests 全部乾淨。

- [ ] **Step 15: Commit**

```bash
git add src/renderer/recents-groups.ts tests/recents-groups.test.ts src/renderer/components/Recents.tsx src/renderer/components/Recents.css src/renderer/hooks/useSessions.ts src/renderer/App.tsx tests/recents.test.tsx tests/use-sessions.test.tsx
```

```bash
git commit -m "feat: Recents 依 thread 分組,預設只列本專案並可切全部"
```

---

### Task 14: `index.ts` 接上專案登錄表

**Files:**
- Modify: `src/main/index.ts`(整檔取代)

**Interfaces:**
- Consumes: Task 2 `createProjectsStore`、`nodeStoreFs`;Task 3 `findProject`、`setLastUrl`、`setShutdown`;Task 4 `createProjectsService`、`ProjectsService`;Task 7 `createIpcBridge`(deps `projects`、`sessions`、`runtimeFor`、`homeDir`、`terminalPort`)與 `ProjectRuntime`;Task 8 `registerProjectsIpc`;Task 9 `startTerminalServer(resolveCwd, logError)`;Task 10 `startViewTools({ activeProjectDir })` 與 `ViewTools.forProject(isActive)`;既有 `createSessionOptionsFactory(projectDir, appDir, sessions, mcpServers?)`、`buildSessionOptions`、`VIEW_TOOL_SERVER_NAME`。
- Produces: 沒有新介面。`index.ts` 在 coverage 排除清單裡,本 task 的驗證是 typecheck、build 與全套測試;實機驗收在 Task 15。

規則(規格 §1、§3.1、§3.4、§4.1、§6):

1. 啟動不再要求 `YESCHEF_PROJECT_DIR`。狀態檔在 `<userData>/yeschef-projects.json`,`store.load()` 之後建 service。狀態檔是空的而環境變數有設,就把它加成第一個專案(D 之前唯一的專案目錄沿用當種子);不可用就記錯誤略過,app 照開。任何情況都不再 `app.exit(1)`。
2. `activeProjectDir()` 回 active 專案的 rootPath,沒有 active 專案就丟 `沒有 active 專案`。Task 10 保證它只在某個專案的工具通過 `isActive` 守衛後才被呼叫。
3. `runtimeFor(projectId, rootPath, isActive)`:向共用的 `startup.viewTools.forProject(isActive)` 要一份該專案的 MCP server,用該專案的 `rootPath` 建 sessionOptions 工廠;`viewTools` hooks 的 `abortPending` 是專案自己那份(只中止自己的呼叫),`autoAllow`／`handoffDone` 是共用的;`dispose` 收掉那份 server。右窗格工具停用時(`startup.viewTools === undefined`)只給 `sessionOptions`。
4. 終端機伺服器用 `(id) => service.rootPathOf(id)` 查 cwd。
5. `projects:add`／`projects:relocate` 的資料夾選擇器是 `dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })`;`validateRoot` 沿用 A 規格 §2.1 的守衛(`buildSessionOptions` 不丟就可以)。
6. 右窗格每次主框架導航完成(`did-navigate`、`did-navigate-in-page` 且 `isMainFrame`)就把 URL 記到 active 專案的 `lastUrl`,只記 `http:`／`https:`／`file:`;`about:blank`、`data:` 錯誤頁不記。`activeId` 改變時導到新專案的 `lastUrl`,沒有就 `about:blank`。啟動時右窗格也載 active 專案的 `lastUrl`(工具停用時維持既有的錯誤頁)。
7. 退出時記 `openIdsOnShutdown`(目前清單裡每個專案都算開著)並等這一筆寫進磁碟再退出:service 的存檔是背景排隊的,不等的話 `app.quit()` 可能先一步結束行程。`before-quit` 先 `preventDefault`,存完再 `app.quit()` 一次。
8. `createConversationView` 不再帶 `additionalArguments`(Task 1 已刪 `PROJECT_DIR_ARG`,Task 11 的 preload 不再讀 argv)。

- [ ] **Step 1: 確認起點是紅的**

Run: `npx tsc --noEmit -p . 2>&1 | grep "^src/main/index.ts" | head -5`
Expected: 有錯誤(`PROJECT_DIR_ARG` 不存在、`startTerminalServer`／`createIpcBridge`／`startViewTools` 的引數型別不符)。這是 Task 1、7、9、10 留給本 task 的殘留,不是新問題。

- [ ] **Step 2: 整檔取代 `src/main/index.ts`**

```ts
import { app, BaseWindow, WebContentsView, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { splitBounds } from './layout.js'
import { createAgentView } from './agent-view.js'
import { buildSessionOptions } from './session-args.js'
import { createSessionOptionsFactory } from './session-options.js'
import { createSessionStore } from './session-store.js'
import { createIpcBridge, type ProjectRuntime } from './ipc-bridge.js'
import { attachCdp } from './cdp.js'
import { SYSTEM_CLOCK } from './agent-host.js'
import { createViewToolServer } from './view-tools/server.js'
import { startViewTools } from './view-tools/startup.js'
import { startTerminalServer } from './terminal-server.js'
import { createProjectsStore, nodeStoreFs } from './projects-store.js'
import { createProjectsService, type ProjectsService } from './projects-service.js'
import { registerProjectsIpc } from './projects-ipc.js'
import { findProject, setLastUrl, setShutdown } from './projects-state.js'
import { VIEW_TOOL_SERVER_NAME } from '../shared/view-tools.js'
import type { ProjectsState } from '../shared/projects.js'

const DEFAULT_RATIO = 0.5
const INITIAL_AGENT_URL = 'about:blank'
/** 規格 §4.1:專案狀態檔,放 userData。 */
const PROJECTS_FILE = 'yeschef-projects.json'
/** 狀態檔還是空的時候,用這個環境變數補第一個專案(D 之前唯一的專案目錄,沿用當種子)。 */
const SEED_PROJECT_ENV = 'YESCHEF_PROJECT_DIR'
/** 右窗格會記住的 URL 種類:about:blank 與 data: 錯誤頁不算「上次看的頁面」。 */
const REMEMBERED_URL_SCHEMES: readonly string[] = ['http:', 'https:', 'file:']

/** 建一個帶失敗 URL 與訊息的本地錯誤頁,給窗格 loadURL/loadFile 失敗時用。 */
function buildErrorPageUrl(failedUrl: string, message: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { font: 14px ui-monospace, Menlo, monospace; background: #12140f; color: #d8dcd4; padding: 2rem; }
    h1 { font-size: 16px; }
    code { color: #f0a0a0; word-break: break-all; }
  </style><h1>[yeschef] 頁面載入失敗</h1><p>URL：<code>${escape(failedUrl)}</code></p><p>${escape(message)}</p>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function createConversationView(): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
}

function loadRenderer(view: WebContentsView): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    // dev 模式開 DevTools。只在 dev 開,打包後的 app 不該自己彈開發者工具。
    view.webContents.openDevTools({ mode: 'detach' })
    view.webContents.loadURL(rendererUrl).catch((err: unknown) => {
      console.error('[yeschef] 左窗格載入失敗:', rendererUrl, err)
    })
    return
  }
  const rendererFile = join(import.meta.dirname, '../renderer/index.html')
  view.webContents.loadFile(rendererFile).catch((err: unknown) => {
    console.error('[yeschef] 左窗格載入失敗:', rendererFile, err)
  })
}

function loadAgentPage(view: WebContentsView, url: string): void {
  view.webContents.loadURL(url).catch((err: unknown) => {
    console.error('[yeschef] 右窗格載入失敗:', url, err)
    const message = err instanceof Error ? err.message : String(err)
    if (view.webContents.isDestroyed()) return
    view.webContents.loadURL(buildErrorPageUrl(url, message)).catch((e: unknown) => {
      console.error('[yeschef] 右窗格錯誤頁也載入失敗:', e)
    })
  })
}

function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 這個資料夾能不能當專案:沿用 A 規格 §2.1 的守衛(絕對路徑、存在、不在 app 自身目錄底下)。 */
function validateRoot(rootPath: string): string | undefined {
  try {
    buildSessionOptions({ projectDir: rootPath, appDir: app.getAppPath() })
    return undefined
  } catch (err) {
    return toError(err).message
  }
}

/** 狀態檔是空的而環境變數有設,就把它加成第一個專案;不可用就記錯誤略過,app 照開。 */
function seedFromEnv(service: ProjectsService, logError: (error: Error) => void): void {
  const dir = process.env[SEED_PROJECT_ENV]
  if (dir === undefined || dir === '' || service.state().projects.length > 0) return
  const reason = validateRoot(dir)
  if (reason !== undefined) {
    logError(new Error(`${SEED_PROJECT_ENV} 不可用,略過:${reason}`))
    return
  }
  service.addProject(dir)
}

function shouldRemember(url: string): boolean {
  try {
    return REMEMBERED_URL_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** 規格 §3.4:active 專案上次看的頁面;沒有就 about:blank。 */
function agentUrlFor(state: ProjectsState): string {
  const active = state.activeId === null ? undefined : findProject(state, state.activeId)
  return active?.lastUrl ?? INITIAL_AGENT_URL
}

export async function createWindow(): Promise<BaseWindow> {
  const logError = (error: Error): void => {
    console.error('[yeschef]', error)
  }
  // 裁決 7:SDK 型別在 session-store 轉成 SessionSummary,不穿過 IPC。
  const sessions = createSessionStore({ listSessions, getSessionMessages })

  // 規格 §4.1、§6:讀不到主檔退到備份,備份也壞就是空狀態;這些都在 store 裡處理。
  const store = createProjectsStore({
    filePath: join(app.getPath('userData'), PROJECTS_FILE),
    fs: nodeStoreFs,
    logError,
  })
  const service = createProjectsService({
    store,
    initial: await store.load(),
    now: Date.now,
    newId: randomUUID,
    isDir: isDirectory,
    logError,
  })
  seedFromEnv(service, logError)

  const win = new BaseWindow({ width: 1600, height: 900, titleBarStyle: 'hiddenInset' })
  const conversationView = createConversationView()
  const agentView = createAgentView()

  win.contentView.addChildView(conversationView)
  win.contentView.addChildView(agentView)

  const applyLayout = (): void => {
    const { width, height } = win.getContentBounds()
    const { left, right } = splitBounds({ width, height }, DEFAULT_RATIO)
    conversationView.setBounds(left)
    agentView.setBounds(right)
  }
  applyLayout()
  win.on('resize', applyLayout)

  // CDP 指令要等 renderer 行程存在才收得到,所以附著前先讓右窗格開始載入,不必等它載完。
  loadAgentPage(agentView, INITIAL_AGENT_URL)

  // 規格 §3.2:右窗格的檔案範圍跟著 active 專案。Task 10 保證只在某個專案的工具
  // 通過 isActive 守衛後才呼叫,所以這裡沒有 active 專案是程式錯誤,直接丟。
  const activeProjectDir = (): string => {
    const { activeId } = service.state()
    const root = activeId === null ? undefined : service.rootPathOf(activeId)
    if (root === undefined) throw new Error('沒有 active 專案')
    return root
  }

  // 裁決 17(docs/superpowers/plan-b/CONTRACT.md):CDP 或 view tools 建立失敗時
  // viewTools 是 undefined,視窗照開,左窗格照常可用,右窗格只剩手動瀏覽。
  const startup = await startViewTools({
    view: agentView,
    clock: SYSTEM_CLOCK,
    activeProjectDir,
    logError,
    warn: (line) => {
      console.error(line)
    },
    attach: attachCdp,
    create: createViewToolServer,
  })

  if (win.isDestroyed()) {
    await startup.dispose().catch((err: unknown) => {
      console.error('[yeschef] 右窗格工具收尾失敗:', err)
    })
    return win
  }

  // 規格 §3.2、§3.4:每個專案一組 sessionOptions 與一份右窗格 MCP server;
  // 專案守衛(背景專案呼叫瀏覽器工具回錯誤)在 Task 10 的 forProject(isActive) 裡。
  const appDir = app.getAppPath()
  const runtimeFor = (_projectId: string, rootPath: string, isActive: () => boolean): ProjectRuntime => {
    const shared = startup.viewTools
    const own = shared?.forProject(isActive)
    // 裁決 20:resume 時工廠向 store 問那場對話原本的 cwd。
    const sessionOptions = createSessionOptionsFactory(
      rootPath,
      appDir,
      sessions,
      own === undefined ? undefined : { [VIEW_TOOL_SERVER_NAME]: own.server }
    )
    if (shared === undefined || own === undefined) return { sessionOptions }
    return {
      sessionOptions,
      viewTools: {
        autoAllow: (toolName, toolUseId) => shared.autoAllow(toolName, toolUseId),
        handoffDone: (toolUseId) => shared.handoffDone(toolUseId),
        // 只中止這個專案自己的呼叫:切走或結束時不連累別的專案。
        abortPending: (reason) => own.abortPending(reason),
      },
      dispose: () => own.dispose(),
    }
  }

  let term: Awaited<ReturnType<typeof startTerminalServer>> | undefined
  try {
    // 規格 §3.1:終端機 cwd 由 projectId 查登錄表,renderer 不送路徑。
    term = await startTerminalServer((id) => service.rootPathOf(id), logError)
  } catch (cause) {
    logError(toError(cause))
  }

  const bridge = createIpcBridge({
    webContents: conversationView.webContents,
    projects: service,
    sessions,
    runtimeFor,
    logError,
    homeDir: homedir(),
    terminalPort: term?.port,
  })

  const unregisterProjectsIpc = registerProjectsIpc({
    service,
    pickFolder: async () => {
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? undefined : result.filePaths[0]
    },
    validateRoot,
    logError,
  })

  // 規格 §3.4:每個專案記自己的 lastUrl。導航完成才記,所以錯誤頁與 about:blank 不會蓋掉上次的頁面。
  const rememberUrl = (url: string): void => {
    const { activeId } = service.state()
    if (activeId === null || !shouldRemember(url)) return
    service.update((s) => setLastUrl(s, activeId, url))
  }
  agentView.webContents.on('did-navigate', (_event, url) => {
    rememberUrl(url)
  })
  agentView.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) rememberUrl(url)
  })
  // 切換專案時右窗格導到該專案的 lastUrl。對話與終端的切換在 ipc-bridge 裡,這裡只管右窗格。
  const unsubscribe = service.subscribe((next, prev) => {
    if (next.activeId === prev.activeId) return
    loadAgentPage(agentView, agentUrlFor(next))
  })

  // 視窗關閉是狀態機的 `window-closed`:bridge.dispose() 會跑完每個專案的收尾再解掉 handler。
  win.on('closed', () => {
    unsubscribe()
    unregisterProjectsIpc()
    bridge.dispose().catch((err: unknown) => {
      console.error('[yeschef] 收尾失敗:', err)
    })
    startup.dispose().catch((err: unknown) => {
      console.error('[yeschef] 右窗格工具收尾失敗:', err)
    })
    term?.close().catch((err: unknown) => {
      console.error('[yeschef] 終端機伺服器收尾失敗:', err)
    })
  })

  // 規格 §4.1:退出時記下開著哪些專案,並等這一筆真的寫進磁碟。service 的存檔是背景排隊的,
  // store.save 排在同一條隊伍後面,等到它就等到了前面所有的。
  let flushed = false
  app.on('before-quit', (event) => {
    if (flushed) return
    event.preventDefault()
    const state = service.state()
    store
      .save(setShutdown(state, state.projects.map((p) => p.id)))
      .catch((err: unknown) => {
        logError(toError(err))
      })
      .finally(() => {
        flushed = true
        app.quit()
      })
  })

  loadRenderer(conversationView)
  loadAgentPage(
    agentView,
    startup.viewTools === undefined
      ? buildErrorPageUrl(INITIAL_AGENT_URL, '右窗格的自動操作工具已停用；左窗格對話仍可正常使用。')
      : agentUrlFor(service.state())
  )
  return win
}

app
  .whenReady()
  .then(() => createWindow())
  .catch((err: unknown) => {
    console.error('[yeschef] 應用初始化失敗:', err)
    process.exit(1)
  })

app.on('window-all-closed', () => {
  app.quit()
})
```

刪掉的東西:`PROJECT_DIR_ARG` import、`PROJECT_DIR_ENV` 常數、`failStartup`、`requireProjectDir`、`createConversationView` 的 `projectDir` 參數與 `additionalArguments`、`startup.mcpServers` 的使用(Task 10 已移除該欄位)。

- [ ] **Step 3: 型別檢查**

Run: `npx tsc --noEmit -p .`
Expected: 0 errors。這是 Task 1 之後第一次全綠:前面每個 task 都只跑自己的測試檔,殘留都收在這裡。

- [ ] **Step 4: 全套測試**

Run: `npx vitest run`
Expected: 全部 PASS,0 failed。有紅的先看是不是本 task 之前就紅(`git stash` 後再跑一次);是的話回報 DONE_WITH_CONCERNS 並列出檔名,不要在本 task 修別的 task 的測試。

- [ ] **Step 5: build**

Run: `npx electron-vite build 2>&1 | tail -15`
Expected: main、preload、renderer 三段都 `✓ built`,沒有 `Could not resolve`。這一步抓的是 import 路徑與 `import.meta.dirname` 這類 typecheck 看不到的問題。

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
```

```bash
git commit -m "feat: 主行程接上專案登錄表,啟動載入狀態檔並依專案切右窗格 URL"
```

---

### Task 15: 實機驗收、記憶體量測與 `docs/RESULTS-08-projects.md`

**Files:**
- Create: `docs/RESULTS-08-projects.md`
- Modify: 預期沒有程式碼改動。實機抓到缺陷時,修法各自一個 commit,commit hash 記進 RESULTS(C 的 RESULTS-06 就是這樣記 `9a21ad5`、`1370c9b`)。

**Interfaces:**
- Consumes: Task 14 完成後的整個 app;Task 12 的 DOM(`.project-bar [role="tab"]`、`.project-pending`、`.project-unavailable`、`.tab-strip .tab`、`.quick-launch button`、`.pane-slot`);既有 `.composer-input`、`.composer-send`、`.approval-card`(按鈕文字「允許 …」/「拒絕」)、xterm 的 `.xterm-helper-textarea`;Task 7 的 `MSG.browserBusy = '瀏覽器正由前景專案使用'`;Task 2 的狀態檔格式;`npm run spike:memory`。
- Produces: `docs/RESULTS-08-projects.md`,格式照 `docs/RESULTS-05-b-view-tools.md` 與 `docs/RESULTS-06-c-terminals.md`(量測日期、機器、版本、方法、結果表、缺陷、人工項目)。

規則(規格 §7 實機驗收 1 到 6):

1. 單元測試綠不代表可用,這是 B 與 C 的教訓。每一項都要在真的 Electron 裡做,以截圖與 DOM 讀值為證;「照理說會過」不算過。
2. 不碰真正的 userData。用 `--user-data-dir` 指到 `/tmp/yeschef-d-acceptance/userData`,啟動後先確認狀態檔真的寫在那裡(Step 4);沒有的話停下來把 `~/Library/Application Support/yeschef/yeschef-projects.json` 備份成 `.before-d-acceptance` 再繼續,驗完還原。
3. 只殺自己起的那個 Electron pid,不要 `pkill Electron`(使用者可能開著別的 Electron app)。
4. 「+」加入專案要開系統的資料夾對話框,CDP 開不了,列為人工項目;專案清單改用預先寫好的狀態檔。
5. 工具回傳的逐字內容從 SDK 的 session jsonl 讀(`~/.claude/projects/-private-tmp-yeschef-d-a/<sessionId>.jsonl`,`/tmp` 會被 macOS 解成 `/private/tmp`,RESULTS-05 §方法有寫)。
6. 抓到缺陷:先修、加上會抓到它的測試、各自 commit,再重跑那一項;RESULTS 記缺陷、修法與 commit hash。修不了的記成未過,不要把項目拿掉。

- [ ] **Step 1: build 與準備兩個專案資料夾**

```bash
npm run build 2>&1 | tail -5
mkdir -p /tmp/yeschef-d-a /tmp/yeschef-d-b /tmp/yeschef-d-c /tmp/yeschef-d-acceptance/userData
printf '<!doctype html><meta charset="utf-8"><title>專案 A 的頁面</title><h1>這是 A</h1>' > /tmp/yeschef-d-a/index.html
printf '<!doctype html><meta charset="utf-8"><title>專案 B 的頁面</title><h1>這是 B</h1>' > /tmp/yeschef-d-b/index.html
echo "marker-a" > /tmp/yeschef-d-a/MARKER
echo "marker-b" > /tmp/yeschef-d-b/MARKER
```

- [ ] **Step 2: 預先寫好狀態檔(兩個專案,A 是 active,A 有 lastUrl)**

```bash
cat > /tmp/yeschef-d-acceptance/userData/yeschef-projects.json <<'JSON'
{
  "schemaVersion": 1,
  "projects": [
    {
      "id": "aaaaaaaa-0000-4000-8000-000000000001",
      "rootPath": "/tmp/yeschef-d-a",
      "name": "yeschef-d-a",
      "addedAt": 1757300000000,
      "lastOpenedAt": 1757300000000,
      "tabs": [
        { "id": "tab-a-conv", "contentType": "conversation", "label": "Claude 對話", "customLabel": null, "sortOrder": 0, "lastFocusedAt": 1757300000000, "threadId": "thread-a-1" }
      ],
      "lastUrl": "file:///tmp/yeschef-d-a/index.html",
      "threads": [
        { "id": "thread-a-1", "sessions": [], "handoffVersion": 0, "switchPhase": { "kind": "idle" }, "createdAt": 1757300000000 }
      ]
    },
    {
      "id": "bbbbbbbb-0000-4000-8000-000000000002",
      "rootPath": "/tmp/yeschef-d-b",
      "name": "yeschef-d-b",
      "addedAt": 1757300001000,
      "lastOpenedAt": 1757300001000,
      "tabs": [
        { "id": "tab-b-conv", "contentType": "conversation", "label": "Claude 對話", "customLabel": null, "sortOrder": 0, "lastFocusedAt": 1757300001000, "threadId": "thread-b-1" }
      ],
      "lastUrl": null,
      "threads": [
        { "id": "thread-b-1", "sessions": [], "handoffVersion": 0, "switchPhase": { "kind": "idle" }, "createdAt": 1757300001000 }
      ]
    }
  ],
  "activeId": "aaaaaaaa-0000-4000-8000-000000000001",
  "openIdsOnShutdown": []
}
JSON
node -e "JSON.parse(require('fs').readFileSync('/tmp/yeschef-d-acceptance/userData/yeschef-projects.json','utf8')); console.log('JSON OK')"
```

欄位要跟 Task 1 的 `ProjectsState`／`ProjectEntry`／`TabEntry`／`ThreadEntry` 一模一樣;Task 2 的 `parseProjectsState` 不認得就會當空狀態,app 會開成「沒有專案」。那不是缺陷,是 fixture 打錯,回頭對 Task 1 的型別改。

- [ ] **Step 3: CDP 小工具**

寫到 `/tmp/yeschef-d-acceptance/cdp.mjs`(不進 repo):

```js
// 用法:
//   node cdp.mjs targets                       列出所有 target(title、url、id)
//   node cdp.mjs eval <titleSubstr> '<js>'      對 title 含該字串的 page 跑 Runtime.evaluate(awaitPromise)
//   node cdp.mjs shot <titleSubstr> <out.png>   Page.captureScreenshot
//   node cdp.mjs type <titleSubstr> '<text>'    Input.insertText(給 xterm 的 helper textarea 用,先 eval focus 它)
//   node cdp.mjs key <titleSubstr> Enter        Input.dispatchKeyEvent 的 keyDown+keyUp
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const PORT = 9333
const [cmd, titleSubstr, arg] = process.argv.slice(2)

const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
if (cmd === 'targets') {
  for (const t of targets) console.log(`${t.id}\t${t.title}\t${t.url}`)
  process.exit(0)
}
const target = targets.find((t) => t.type === 'page' && (t.title.includes(titleSubstr) || t.url.includes(titleSubstr)))
if (!target) { console.error(`找不到 title/url 含「${titleSubstr}」的 page,有的是:`, targets.map((t) => t.title)); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok) => ws.once('open', ok))
let seq = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((ok) => {
  const id = ++seq
  pending.set(id, ok)
  ws.send(JSON.stringify({ id, method, params }))
})

if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  console.log(r.result?.exceptionDetails ? `EXCEPTION ${r.result.exceptionDetails.text}` : JSON.stringify(r.result?.result?.value ?? null))
} else if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(arg, Buffer.from(r.result.data, 'base64'))
  console.log(`寫到 ${arg}`)
} else if (cmd === 'type') {
  await send('Input.insertText', { text: arg })
  console.log('typed')
} else if (cmd === 'key') {
  const code = arg === 'Enter' ? 13 : 0
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: arg, code: arg, windowsVirtualKeyCode: code, text: arg === 'Enter' ? '\r' : undefined })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: arg, code: arg, windowsVirtualKeyCode: code })
  console.log('key sent')
}
ws.close()
```

`ws` 是專案的依賴,從 repo 根目錄用 `node /tmp/yeschef-d-acceptance/cdp.mjs …` 跑就解得到;解不到就 `NODE_PATH=$PWD/node_modules`。

- [ ] **Step 4: 啟動並確認 userData 是指定的那個**

```bash
cd /Users/me/Projects/yeschef
npx electron . --remote-debugging-port=9333 --user-data-dir=/tmp/yeschef-d-acceptance/userData \
  > /tmp/yeschef-d-acceptance/main.log 2>&1 &
echo $! > /tmp/yeschef-d-acceptance/electron.pid
```

等 5 秒(用 `run_in_background` 的方式等,不要前景 `sleep`),然後:

```bash
node /tmp/yeschef-d-acceptance/cdp.mjs targets
node /tmp/yeschef-d-acceptance/cdp.mjs eval yeschef 'document.title'
node /tmp/yeschef-d-acceptance/cdp.mjs eval yeschef '[...document.querySelectorAll(".project-bar [role=tab]")].map(e => e.textContent)'
```

Expected:左窗格 target 的 title 是 `yeschef-d-a`(Task 12:標題列顯示專案名,`document.title` 跟著);專案列兩格 `yeschef-d-a`、`yeschef-d-b`;右窗格 target 的 url 是 `file:///tmp/yeschef-d-a/index.html`(Task 14 規則 6:啟動載 active 專案的 lastUrl)。

接著切一次專案讓 service 存檔,確認檔案寫在指定目錄:

```bash
node /tmp/yeschef-d-acceptance/cdp.mjs eval yeschef 'document.querySelectorAll(".project-bar [role=tab]")[1].click(); "clicked"'
ls -la /tmp/yeschef-d-acceptance/userData/ | grep yeschef-projects
ls -la ~/Library/Application\ Support/yeschef/ 2>/dev/null | grep yeschef-projects
```

Expected:指定目錄出現 `yeschef-projects.json.bak.0`(第二次存會輪備份);真正的 userData 那份 mtime 沒動。若相反,依規則 2 備份真正的那份、把 fixture 複製過去、不帶 `--user-data-dir` 重開,RESULTS 的「方法」要寫清楚。

- [ ] **Step 5: 驗收 1,終端 cwd 各自正確**

在 A(先點回第一格):

```bash
CDP="node /tmp/yeschef-d-acceptance/cdp.mjs"
$CDP eval yeschef 'document.querySelectorAll(".project-bar [role=tab]")[0].click(); document.title'
$CDP eval yeschef '[...document.querySelectorAll(".quick-launch button")].find(b => b.textContent.trim() === "zsh").click(); "ok"'
```

等 3 秒(p10k 要時間),對 xterm 送 `pwd`:

```bash
$CDP eval yeschef 'document.querySelector(".pane-slot:not([hidden]) .xterm-helper-textarea").focus(); "focused"'
$CDP type yeschef 'pwd'
$CDP key yeschef Enter
截圖未收錄。
```

切到 B 做同樣的事,截 `01-b-pwd.png`;再切回 A 截 `01-a-back.png`。

Expected:`01-a-pwd.png` 顯示 `/tmp/yeschef-d-a`,`01-b-pwd.png` 顯示 `/tmp/yeschef-d-b`;`01-a-back.png` 是 A 的終端分頁還在、剛才的 `pwd` 輸出還在(切走不卸載,pty 沒死);`ps -Ao pid,ppid,comm | grep -c zsh` 這時至少多 2 個 zsh。狀態檔裡 A 與 B 的 `tabs` 各多一筆 `terminal`。

- [ ] **Step 6: 驗收 2,長回合切走再切回看得到結果**

在 A 的 Claude 對話分頁(點 `.tab-strip .tab` 第一顆)送訊息:

```bash
$CDP eval yeschef 'document.querySelectorAll(".tab-strip .tab")[0].click(); "ok"'
$CDP eval yeschef '(() => { const el = document.querySelector(".composer-input"); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; setter.call(el, "請不要用任何工具,從 1 數到 120,每個數字一行,最後一行寫「數完了」。"); el.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector(".composer-send").click(); return "sent" })()'
```

3 秒內切到 B,在 B 截圖 `02-b-while-a-runs.png`;等 40 秒切回 A,截 `02-a-result.png`。

Expected:B 的畫面是 B 自己的空對話,看不到 A 的串流;切回 A 看到完整的 1 到 120 與「數完了」,composer 可再輸入(回合已結束)。`main.log` 沒有 `[yeschef]` 開頭的錯誤。狀態檔 A 的 `threads[0].sessions` 多一筆,`sessionId` 對得上 `~/.claude/projects/-private-tmp-yeschef-d-a/` 底下新出現的 jsonl 檔名。

- [ ] **Step 7: 驗收 3,背景專案的批准只顯示記號**

`permissionMode` 是 `default`,`Bash` 會進批准流程。在 A 送:

```bash
$CDP eval yeschef '(() => { const el = document.querySelector(".composer-input"); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; setter.call(el, "請用 Bash 工具執行 cat MARKER,把內容告訴我。"); el.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector(".composer-send").click(); return "sent" })()'
```

立刻切到 B。等 15 秒:

```bash
$CDP eval yeschef '({ pending: [...document.querySelectorAll(".project-pending")].length, cards: document.querySelectorAll(".approval-card").length, title: document.title })'
截圖未收錄。
```

Expected:`pending: 1`(A 那格有 `●`)、`cards: 0`、`title: yeschef-d-b`。切回 A:

```bash
$CDP eval yeschef 'document.querySelectorAll(".project-bar [role=tab]")[0].click(); "ok"'
$CDP eval yeschef '({ pending: document.querySelectorAll(".project-pending").length, cards: document.querySelectorAll(".approval-card").length })'
截圖未收錄。
$CDP eval yeschef '[...document.querySelectorAll(".approval-card button")].find(b => b.textContent.startsWith("允許")).click(); "allowed"'
```

Expected:批准卡出現(`cards: 1`)、記號消失(`pending: 0`,因為 A 變成 active,批准交出去了);按允許後回答含 `marker-a`。

- [ ] **Step 8: 驗收 4,右窗格每個專案記自己的 URL,背景專案的瀏覽器工具回錯誤**

(a) 還原:此刻 active 是 A,右窗格應該在 `file:///tmp/yeschef-d-a/index.html`。切到 B,右窗格 target 的 url 變 `about:blank`(B 沒有 lastUrl)。在 B 送「請用 view_navigate 開 file:///tmp/yeschef-d-b/index.html」,等回合結束,右窗格 url 是 B 的頁面、title 「專案 B 的頁面」。切回 A → 右窗格回到 A 的頁面;再切到 B → 回到 B 的頁面。每一步用 `$CDP targets` 讀右窗格 url,截 `04-a.png`、`04-b.png`。

(b) 檔案範圍跟著切:在 B 送「請用 view_navigate 開 file:///tmp/yeschef-d-a/index.html」。Expected:工具回傳 `只允許開啟 /tmp/yeschef-d-b 底下的本地檔案`(從 B 的 session jsonl 讀逐字),右窗格沒動。

(c) 背景工具:在 A 送「請用 view_snapshot 看一下右窗格,然後告訴我頁面標題」,3 秒內切到 B。Expected:A 的 jsonl 裡該 `tool_result` 的內容是 `瀏覽器正由前景專案使用`,`is_error: true`;右窗格 url 一直是 B 的頁面,沒有被 A 蓋掉。

(d) 切回 A,再送一次同樣的 view_snapshot 請求,不切走。Expected:正常回 `[page] 專案 A 的頁面 file:///tmp/yeschef-d-a/index.html …`(專案守衛只擋背景,不擋前景)。

- [ ] **Step 9: 驗收 5,關掉再開,清單、active、分頁都還原**

此刻 active 是 A,A 有 1 個對話分頁加 1 個終端分頁,B 也是。送 SIGTERM 給自己起的 pid(Electron 在 POSIX 把 SIGTERM 接成 `app.quit()`,會走 `before-quit`):

```bash
kill -TERM "$(cat /tmp/yeschef-d-acceptance/electron.pid)"
```

等 3 秒:

```bash
pgrep -F /tmp/yeschef-d-acceptance/electron.pid && echo "還活著" || echo "已退出"
node -e "const s = JSON.parse(require('fs').readFileSync('/tmp/yeschef-d-acceptance/userData/yeschef-projects.json','utf8')); console.log(JSON.stringify({ activeId: s.activeId, open: s.openIdsOnShutdown, tabs: s.projects.map(p => [p.name, p.tabs.map(t => t.contentType)]) }, null, 1))"
```

Expected:已退出;`openIdsOnShutdown` 是兩個 id;`activeId` 是 A;兩個專案 `tabs` 各是 `["conversation","terminal"]`。若 `openIdsOnShutdown` 是空的,表示 SIGTERM 沒走到 `before-quit`,改用 `osascript -e 'tell application "Electron" to quit'`(等同 Cmd+Q)重做一次,RESULTS 記下哪一種能觸發。

重開(同一行指令加 `--user-data-dir`),等 5 秒:

```bash
$CDP eval yeschef '({ title: document.title, projects: [...document.querySelectorAll(".project-bar [role=tab]")].map(e => e.textContent), tabs: [...document.querySelectorAll(".tab-strip .tab")].map(e => e.textContent) })'
截圖未收錄。
```

Expected:title `yeschef-d-a`、兩個專案、A 的分頁列有「Claude 對話」加一個終端分頁;終端分頁是空的新 shell(規格 §4.2:內容不存,tmux 在 roadmap 第 4 項);右窗格 url 是 A 的頁面。切到 B 也有它的終端分頁。

- [ ] **Step 10: 驗收 6,記憶體**

app 開著(兩個專案、各一個終端、A 跑過一回合)時:

```bash
npm run spike:memory 2>&1 | tee /tmp/yeschef-d-acceptance/mem-2-projects.txt
```

再把第三個專案加進狀態檔(退出 app、在 `projects` 陣列補一筆 `rootPath: "/tmp/yeschef-d-c"`、`name: "yeschef-d-c"`、其餘欄位照 B 的樣子改 id 為 `cccccccc-0000-4000-8000-000000000003`、tab id `tab-c-conv`、thread id `thread-c-1`),重開、在 C 開一個終端,再量一次:

```bash
npm run spike:memory 2>&1 | tee /tmp/yeschef-d-acceptance/mem-3-projects.txt
```

RESULTS 記兩組 `yeschef` 列的 MB 與程序數,並對照 RESULTS-06(2 個終端分頁加 tmux:全樹 353 MB、主行程 108 MB)。`electron-vite` 那列必為 0,理由見 RESULTS-04 §附註 2。沒有門檻,只記數字;若 3 個專案比 2 個多超過 150 MB,查是不是 sleeping session 沒睡(`ps` 看有沒有多餘的 `claude` 程序)。

- [ ] **Step 11: 不可用的專案(規格 §6)**

退出 app,`mv /tmp/yeschef-d-c /tmp/yeschef-d-c-moved`,重開:

```bash
$CDP eval yeschef '({ unavailable: document.querySelectorAll(".project-unavailable").length, projects: document.querySelectorAll(".project-bar [role=tab]").length })'
$CDP eval yeschef 'document.querySelectorAll(".project-bar [role=tab]")[2].click(); document.querySelector(".pane-unavailable")?.textContent ?? "沒有 pane-unavailable"'
截圖未收錄。
```

Expected:三個專案都在(不移除),C 那格有 `!`;切到 C 時左窗格顯示不可用說明與「重新指定」「移除」兩個動作(Task 12 的 `.pane-unavailable-actions`),終端快捷不能開。「重新指定」開資料夾對話框,列人工項目。驗完 `mv` 回去。

- [ ] **Step 12: 覆蓋率**

```bash
npm run test:coverage 2>&1 | grep -E "All files|Stmts|Branch" | head -5
```

Expected:Stmts ≥ 93、Branch ≥ 86(規格 §7)。低於門檻就把 `All files` 那行與最低的三個檔案記進 RESULTS,並回報 DONE_WITH_CONCERNS;補測試不在本 task 範圍,由控制者裁決要不要加一個 task。

- [ ] **Step 13: 退出 app、清理**

```bash
kill -TERM "$(cat /tmp/yeschef-d-acceptance/electron.pid)"
```

fixture 目錄留著(RESULTS 引用截圖路徑);若 Step 4 動過真正的 userData,現在還原。

- [ ] **Step 14: 寫 `docs/RESULTS-08-projects.md`**

照這個格式填,每一格都要是實測值,不要留「預期」:

```markdown
# 子專案 D 多專案實機驗收結果

量測日期:2026-09-__
機器:macOS __(Darwin __)、arm64
Node __ / Electron 44(Chrome __)/ Agent SDK 0.3.258
分支與起點:feat/d-projects,起點 97401f9,量測時 HEAD ______

量測方法:`npm run build` 之後 `npx electron . --remote-debugging-port=9333 --user-data-dir=/tmp/yeschef-d-acceptance/userData`,
狀態檔預先寫好兩個專案(`/tmp/yeschef-d-a`、`/tmp/yeschef-d-b`),左窗格用 CDP `Runtime.evaluate` 操作 DOM、
xterm 用 `Input.insertText`,畫面以 `Page.captureScreenshot` 為準,工具回傳逐字從 SDK session jsonl 讀
(`~/.claude/projects/-private-tmp-yeschef-d-a/`),主程序 log 導到 `main.log`。

## 結果表(規格 §7 實機驗收)

| # | 項目 | 結果 | 佐證 |
|---|---|---|---|
| 1 | 兩個專案各開終端,cwd 各自正確、切走不死 | | |
| 2 | A 跑長回合,切到 B 再回來看得到結果 | | |
| 3 | A 的批准在背景只顯示記號,切回才出批准卡 | | |
| 4a | 切換專案右窗格回到各自的 lastUrl | | |
| 4b | 檔案範圍跟著 active 專案 | | |
| 4c | 背景專案呼叫瀏覽器工具回「瀏覽器正由前景專案使用」 | | |
| 4d | 前景專案的瀏覽器工具正常 | | |
| 5 | 關掉再開:清單、active、分頁還原;openIdsOnShutdown 有寫 | | |
| 6 | 記憶體(見下) | | |
| 7 | 資料夾不存在:標示不可用、不移除 | | |

## 記憶體

| 情境 | yeschef 全樹 | 程序數 | 對照 |
|---|---|---|---|
| 2 個專案、各 1 終端、A 跑過 1 回合 | __ MB | __ | RESULTS-06:2 終端加 tmux 353 MB |
| 3 個專案、各 1 終端 | __ MB | __ | |

## 覆蓋率

`npm run test:coverage`:Stmts __%、Branch __%(門檻 93 / 86)。

## 實機找到的缺陷

| 缺陷 | 修法 | commit |
|---|---|---|

## 需要人工的項目

| 項目 | 為什麼機器測不了 | 怎麼驗 |
|---|---|---|
| 「+」加入專案 | 系統資料夾對話框,CDP 開不了 | 按 `+`,選任一資料夾,專案列多一格且成為 active |
| 不可用專案的「重新指定」 | 同上 | 搬走資料夾後重開,點該專案的「重新指定」,選新位置,`!` 消失 |
| 退出方式 | 本次用 SIGTERM(或 osascript)觸發 before-quit | 真的按 Cmd+Q,重開後 openIdsOnShutdown 非空 |

## 對規劃的影響

- `YESCHEF_PROJECT_DIR` 現在只是狀態檔為空時的種子,不再是必填;A／B／C 的 RESULTS 裡的啟動指令是歷史紀錄,不改。
- (其他實測後的發現)
```

- [ ] **Step 15: Commit**

```bash
git add docs/RESULTS-08-projects.md
```

```bash
git commit -m "docs: 子專案 D 實機驗收結果與記憶體量測"
```

---

## 自我檢查(寫計畫者自填,非派工)

### 規格覆蓋

| 規格 | 要求 | Task |
|---|---|---|
| §2 切專案範圍 | 對話、終端、右窗格檔案範圍一起切 | 7(對話)、9(終端)、10(右窗格) |
| §2 背景專案 | 繼續跑,回來看得到結果 | 6(core 不因 deactivate 中斷)、7(切回 `replay()`)、15 驗收 2 |
| §2、§3.3 sleeping session | 回合結束才收串流;切回先讀 transcript,下一則才 resume | 5(`sleep` action)、6 |
| §2 背景待批准 | 記號、不打斷、切回才出卡 | 6(扣住)、7(`pendingApproval`)、12(`●` 與 `useApprovals(api, activeId)`)、15 驗收 3 |
| §2 切換器位置 | 分頁列上方一列專案 | 12 `ProjectBar` |
| §2、§3.4 右窗格 | 單一 view、每專案 `lastUrl`、背景工具回錯 | 10(`forProject` 守衛、`MSG.browserBusy`)、14(記 URL、切換導頁)、15 驗收 4 |
| §2 專案是任意資料夾 | 不強制 git | 8 `validateRoot` 只沿用 A §2.1 守衛 |
| §2 記憶體 | 量測寫進 RESULTS | 15 Step 10 |
| §2 對話分頁是一條 thread | `startNew` 開新 thread | 3(`startThread`)、7 |
| §3.1 登錄表、renderer 只送 id | 安全要求 | 1(payload 只有 id)、4(`rootPathOf`)、9、11 |
| §3.2 終端 cwd | `open` 帶 `projectId`,查不到送 exit 關連線;C 規格 §5 更新 | 9 |
| §3.2 Claude 對話 | 每專案一組 sessionOptions | 14 `runtimeFor` |
| §3.2 右窗格檔案範圍 | `activeProjectDir()` | 10、14 |
| §3.2 Recents | 依 thread 分組、預設本專案、可切全部 | 13 |
| §3.2 標題列 | 顯示專案名 | 12 `title.ts` |
| §4.1 狀態檔 | schema、原子寫、兩份備份、不認得的版本不覆蓋 | 1(型別)、2(store) |
| §4.1 每專案恰一個對話分頁 | 排第一、不可關 | 3(reducer)、12(UI 沒有關閉鈕) |
| §4.1 `openIdsOnShutdown` | 退出時記 | 3(`setShutdown`)、14(`before-quit`) |
| §4.2 終端內容不存 | 還原的分頁是空終端 | 15 驗收 5 記錄 |
| §5 UI | 專案列、`+`、移除、切換 | 8(IPC)、12(UI)、15 人工項目(`+`) |
| §6 未知 `projectId` | exit 後關連線 | 9 |
| §6 資料夾不存在 | 標示不可用、不移除、可重新指定 | 4(`isAvailable`)、8(`relocate`)、12(`!` 與 `.pane-unavailable`)、15 Step 11 |
| §6 狀態檔損毀 | 退回備份 | 2 |
| §6 ws 只綁 127.0.0.1、Origin 檢查 | 沿用 | 9 沒動這兩段 |
| §7 單元測試五項 | 登錄表、狀態檔、分頁狀態、sleeping 轉換、專案守衛 | 4、2、3、5+6、10 |
| §7 覆蓋率 | Stmts ≥ 93、Branch ≥ 86,`index.ts` 排除 | 15 Step 12 |
| §7 實機驗收 1 到 6 | RESULTS-08 | 15 |

### 佔位符

全文 grep `TBD|TODO|類似 Task|同 Task N 的做法|適當的錯誤處理|加上驗證`:0 筆。每個改既有測試檔的步驟都用 python3 腳本帶精確數量斷言,不用「把 X 都改成 Y」。

### 型別一致

對照過的名字(各 task 的 Produces 對後面 task 的 Consumes):`ProjectRuntime{sessionOptions, viewTools?, dispose?}` 與 `runtimeFor(projectId, rootPath, isActive)`(7 → 14);`ViewToolHooks = Pick<ViewTools, 'autoAllow'|'handoffDone'|'abortPending'>`(6 → 7 → 14);`ViewTools.forProject(isActive): ProjectViewTools{server, abortPending, dispose}` 與 `ViewToolStartupDeps.activeProjectDir`(10 → 14);`startTerminalServer(resolveCwd, logError)`(9 → 14);`ProjectsIpcDeps{service, pickFolder, validateRoot, logError}`(8 → 14);`ProjectsServiceDeps{store, initial, now, newId, isDir, logError}` 與 `ProjectsService{state, update, subscribe, rootPathOf, isAvailable, addProject, newId, now}`(4 → 7、8、14);`ProjectsStoreDeps{filePath, fs, logError}`、`nodeStoreFs`(2 → 14);`findProject`、`setLastUrl(state, projectId, url)`、`setShutdown(state, openIds)`、`focusTab(state, projectId, tabId, now)`(3 → 7、8、14);`replay()`(6 → 7);`useApprovals(api, activeId)`(12);`useSessions(api, refresh, scope)` 與 `SessionListScope`(1 → 11 → 13);`Terminal({ endpoint, projectId, command? })`(9 → 12);`groupSessions`／`ThreadGroup`／`SessionScope`(13 內部);`EMPTY_HINT`、`NO_PROJECT_TITLE`(12 內部)。`createSessionOptionsFactory` 的 `mcpServers` 參數型別是 `Readonly<Record<string, McpServerConfig>>`,`ProjectViewTools.server` 的 `McpSdkServerConfigWithInstance` 是它的成員型別,Task 14 直接傳。

### 已修的筆誤

Task 12 Step 8 原寫「加四行」但列了五行 CSS,已改「加五行」。Task 14 註解一處「瀏覯器」已改「瀏覽器」。
