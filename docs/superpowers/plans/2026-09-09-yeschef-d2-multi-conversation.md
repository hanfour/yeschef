# 子專案 D2:每個專案多個對話 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓一個專案可以開多個對話分頁:每個對話分頁一個 conversation core、一份 renderer view、自己的批准;狀態檔升到版本 2。

**Architecture:** 主行程的 `ipc-bridge.ts` 從「每個專案一個 slot」改成「每個對話分頁一個 slot」,slot 的鍵是 `TabEntry.id`(叫 `conversationId`);`agent:events`、`session:state`、`agent:approval:ask` 三個頻道的 payload 都帶 `conversationId`,renderer 每個掛載中的對話分頁一份 `useConversation`/`useApprovals`,依 `conversationId` 分流。前景仍然只有一個:active 專案裡最近聚焦的對話分頁。狀態檔 `schemaVersion` 升到 2,`SessionLink`/`SwitchPhase` 換成 E 規格 §4.1 的欄位,版本 1 讀進來轉換後寫回。

**Tech Stack:** Electron 44、React 19、TypeScript 7(`strict`、`noUncheckedIndexedAccess`)、vitest 4(`.tsx` 測試檔首行 `// @vitest-environment jsdom`)、`@testing-library/react`、zod 4.5.4(只在 main 使用)、`@anthropic-ai/claude-agent-sdk` 0.3.258。

**Spec:** `docs/specs/2026-09-09-yeschef-d2-multi-conversation-design.md`。版本 2 的欄位與版本 1 的轉換規則以 `docs/specs/2026-09-08-yeschef-handoff-design.md` §4.1 為準。

## Global Constraints

- 對話的識別用 `TabEntry.id`,叫 `conversationId`,不新增另一個 id(規格 §1)。
- 三個頻道的 payload 都帶 `conversationId`;`agent:approval:ask` 同時保留 `projectId`,兩個都必填(規格 §1、§2)。三個 `parse*` 對 `conversationId` 的驗證規則同 `parseApprovalAsk` 對 `projectId`:非空字串,缺就整筆丟棄並記錯誤。
- 同時只有一個對話是前景:active 專案裡 `lastFocusedAt` 最大的 conversation 分頁。終端分頁在前景時,該專案最近聚焦的對話分頁仍視為前景(沿用 D:core 的 activate 跟專案走,不跟分頁走)。其他對話跟 D 的背景專案一樣:回合照跑、事件記 log、批准扣住(規格 §1)。
- 一個專案至少留一個 conversation 分頁;關最後一個被拒(規格 §3、§5)。
- 版本 1 的狀態檔依 E 規格 §4.1 轉換:`linkId = sessionId`、`provider = 'claude'`、`parentLinkId = parentSessionId`、`transcriptPath` 沿用、`models = []`;`switchPhase` 非 `idle` 的補 `mode: 'handoff'` 與 `target: { provider: 'claude', requestedModel: null }`,`spawning` 補 `recoveryRequired: false`,`receiving` 補 `newLinkId = newSessionId`;conversation 分頁補 `provider: 'claude'`。轉換後寫回版本 2。既有狀態檔不能因為升版而讀不到(規格 §5)。
- 版本 2 以外的 `schemaVersion` 沿用 D 的規則:改名保留原檔,改用空狀態。
- renderer 送回主行程的一律是 id,不送路徑(D 規格 §3.1)。
- 每個對話一份 MCP server(`runtimeFor` 每個 slot 呼叫一次),前景守衛改成「這個對話是前景」;右窗格仍然只有一個,背景對話呼叫瀏覽器工具回 `MSG.browserBusy`(規格 §3)。
- 使用者可見文案用繁體中文台灣用語,與既有文案一致:分頁標籤「Claude 對話」「Claude 對話 2」;按鈕「新對話」;提示「至少留一個對話」;確認「回合進行中，確定關閉？」。
- 覆蓋率門檻沿專案:Stmts ≥ 93、Branch ≥ 86;`src/main/index.ts` 維持排除。
- 所有測試檔放 `tests/`,`.tsx` 測試檔首行 `// @vitest-environment jsdom`。main 端測試用 `vi.mock('electron', …)` 替身(見 `tests/ipc-bridge.test.ts` 現有寫法)。
- 資料不就地修改:reducer 一律回新物件;模組私有的緩衝陣列沿用既有程式碼的做法。
- 每個 Task 結尾 `git add <明確檔名>` 與 `git commit` 分兩個指令執行,不用 `&&` 串接,不用 `git add -A`/`.`;commit message 格式 `<type>: <描述>`,繁體中文,不加任何 trailer。
- 執行 `npm run typecheck` 與 `npm test` 都要綠才算完成一個 Task;Task 7 之後跑 `npm run test:coverage` 確認門檻。
- Task 2 與 Task 5 之間 app 跑起來 renderer 收不到事件(preload 已改認新 payload,主行程還沒送):這是預期的中間狀態,Task 5 接上。不要為了這段空窗加相容分支。

---

## 檔案結構

新增:

| 檔案 | 責任 |
|---|---|
| `src/main/projects-migrate.ts` | 版本 1 → 2 的純轉換函式 `migrateV1` |
| `src/renderer/components/ConversationPane.tsx` | 一個對話分頁的完整畫面:Recents 側欄、對話、批准卡、輸入框;每個掛載中的對話分頁一份 |
| `tests/projects-migrate.test.ts` | 轉換規則每個欄位一測 |
| `tests/conversation-pane.test.tsx` | 兩個 pane 各自分流 |

修改:

| 檔案 | 改動 |
|---|---|
| `src/shared/projects.ts` | `PROJECTS_SCHEMA_VERSION = 2`;`SessionLink`、`SwitchPhase` 換成版本 2;`TabEntry.provider`;`ProjectView.pendingTabIds`、`busyTabIds`;`ConversationOpenPayload` 與 `parseConversationOpen` |
| `src/main/projects-schema.ts` | 版本 2 schema;refine 改成「至少一個對話分頁」 |
| `src/main/projects-store.ts` | 版本 1 轉換後寫回 |
| `src/main/projects-state.ts` | 多個對話分頁的 reducer/selector,全部收 `conversationId` |
| `src/shared/ipc.ts` | `EventsBatchPayload`、`SessionStatePayload`、`ApprovalAskPayload.conversationId`、`IPC.conversationsOpen`、`YesChefApi.openConversation` |
| `src/preload/bridge.ts` | 認新 payload;`openConversation` |
| `src/renderer/hooks/useConversation.ts`、`useApprovals.ts`、`useSessions.ts` | 依 `conversationId` 分流 |
| `src/renderer/hooks/useProjects.ts` | `openConversation()` |
| `src/main/conversation.ts` | `isBusy()`、`onBusyChange` |
| `src/main/projects-ipc.ts` | `conversations:open` |
| `src/main/ipc-bridge.ts` | slot 依 `conversationId` |
| `src/renderer/App.tsx`、`components/LeftPane.tsx` | 每個對話分頁一份 pane;分頁列的新對話、關閉、待批准記號 |
| `tests/helpers/fake-yeschef.ts` | payload 帶 `conversationId`;`ProjectView` 新欄位 |

---

### Task 1: 狀態檔版本 2

**Files:**
- Modify: `src/shared/projects.ts`
- Modify: `src/main/projects-schema.ts`
- Create: `src/main/projects-migrate.ts`
- Modify: `src/main/projects-store.ts:54-95`
- Modify: `src/main/projects-state.ts:22-44`(`createProjectEntry`)
- Modify: `src/main/ipc-bridge.ts:131-138`(`linkFor`)
- Test: `tests/projects-migrate.test.ts`(新)、`tests/projects-store.test.ts`、`tests/projects-shared.test.ts`、`tests/projects-state.test.ts`、`tests/preload-bridge.test.ts`、`tests/ipc-bridge.test.ts`

**Interfaces:**
- Produces:
  - `PROJECTS_SCHEMA_VERSION = 2`
  - `type Provider = 'claude' | 'codex'`
  - `SessionLink { linkId, provider, sessionId, transcriptPath: string | null, parentLinkId: string | null, startedAt, endedAt, endReason: 'handoff' | 'failure-recovery' | 'user' | null, models: readonly string[] }`
  - `SwitchPhase` 四種,非 idle 的帶 `mode: SwitchMode`、`target: SwitchTarget`
  - `TabEntry.provider?: Provider`
  - `ProjectView.pendingTabIds: readonly string[]`、`ProjectView.busyTabIds: readonly string[]`(Task 5 才會填真值,這裡先進型別與 parse)
  - `migrateV1(raw: unknown): unknown`
  - `createProjectEntry` 建的對話分頁帶 `provider: 'claude'`

- [ ] **Step 1: 寫轉換的失敗測試**

`tests/projects-migrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { migrateV1 } from '../src/main/projects-migrate.js'
import { parseProjectsState } from '../src/main/projects-schema.js'

const V1_LINK = {
  sessionId: 's-1', transcriptPath: '/h/.claude/projects/x/s-1.jsonl', parentSessionId: 's-0',
  startedAt: 5, endedAt: 9, endReason: 'user',
}

function v1(switchPhase: unknown = { kind: 'idle' }): unknown {
  return {
    schemaVersion: 1,
    activeId: 'p1',
    openIdsOnShutdown: ['p1'],
    projects: [{
      id: 'p1', rootPath: '/Users/x/demo', name: 'demo', addedAt: 1, lastOpenedAt: 2, lastUrl: null,
      tabs: [
        { id: 't1', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1' },
        { id: 't2', contentType: 'terminal', label: 'zsh', customLabel: null, sortOrder: 1, lastFocusedAt: 0 },
      ],
      threads: [{ id: 'th1', sessions: [V1_LINK], handoffVersion: 3, switchPhase, createdAt: 1 }],
    }],
  }
}

describe('migrateV1', () => {
  it('schemaVersion 變 2,轉換結果通過版本 2 的 schema', () => {
    const out = parseProjectsState(migrateV1(v1()))
    expect(out).not.toBeNull()
    expect(out?.schemaVersion).toBe(2)
  })

  it('SessionLink:linkId 取 sessionId、provider claude、parentLinkId 取 parentSessionId、models 空', () => {
    const out = parseProjectsState(migrateV1(v1()))
    expect(out?.projects[0]?.threads[0]?.sessions[0]).toEqual({
      linkId: 's-1', provider: 'claude', sessionId: 's-1', transcriptPath: '/h/.claude/projects/x/s-1.jsonl',
      parentLinkId: 's-0', startedAt: 5, endedAt: 9, endReason: 'user', models: [],
    })
  })

  it('conversation 分頁補 provider claude,terminal 分頁不動', () => {
    const tabs = parseProjectsState(migrateV1(v1()))?.projects[0]?.tabs
    expect(tabs?.[0]?.provider).toBe('claude')
    expect(tabs?.[1]).not.toHaveProperty('provider')
  })

  it('switchPhase idle 不動', () => {
    expect(parseProjectsState(migrateV1(v1()))?.projects[0]?.threads[0]?.switchPhase).toEqual({ kind: 'idle' })
  })

  it('preparing 補 mode 與 target', () => {
    const out = parseProjectsState(migrateV1(v1({ kind: 'preparing', txId: 'tx', startedAt: 7 })))
    expect(out?.projects[0]?.threads[0]?.switchPhase).toEqual({
      kind: 'preparing', txId: 'tx', startedAt: 7, mode: 'handoff', target: { provider: 'claude', requestedModel: null },
    })
  })

  it('spawning 補 recoveryRequired false', () => {
    const out = parseProjectsState(migrateV1(v1({ kind: 'spawning', txId: 'tx', handoffVersion: 2 })))
    expect(out?.projects[0]?.threads[0]?.switchPhase).toEqual({
      kind: 'spawning', txId: 'tx', handoffVersion: 2, mode: 'handoff',
      target: { provider: 'claude', requestedModel: null }, recoveryRequired: false,
    })
  })

  it('receiving 補 newLinkId = newSessionId', () => {
    const out = parseProjectsState(migrateV1(v1({ kind: 'receiving', txId: 'tx', newSessionId: 's-2' })))
    expect(out?.projects[0]?.threads[0]?.switchPhase).toEqual({
      kind: 'receiving', txId: 'tx', newSessionId: 's-2', newLinkId: 's-2', mode: 'handoff',
      target: { provider: 'claude', requestedModel: null },
    })
  })

  it('不是物件就原樣回傳,交給 schema 拒絕', () => {
    expect(migrateV1('x')).toBe('x')
    expect(parseProjectsState(migrateV1('x'))).toBeNull()
  })

  it('不改傳入的物件', () => {
    const input = v1()
    const before = JSON.stringify(input)
    migrateV1(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-migrate.test.ts`
Expected: FAIL,`Cannot find module '../src/main/projects-migrate.js'`

- [ ] **Step 3: 改共用型別**

`src/shared/projects.ts`,把檔頭到 `TabEntry` 這段換成:

```ts
/**
 * 子專案 D 的共用型別(規格 §4.1)與 thread/session 鏈型別(E 規格 §4.1,版本 2)。
 * main 與 renderer 都 import,所以不引入 Electron、zod 或 node 內建模組。
 */
import { isNonEmptyString, isRecord } from './ipc.js'

export const PROJECTS_SCHEMA_VERSION = 2
export const CONVERSATION_TAB_LABEL = 'Claude 對話'

export type Provider = 'claude' | 'codex'

export interface SwitchTarget {
  readonly provider: Provider
  /** 不知道就 null,不拿 requestedModel 冒充實際模型。 */
  readonly requestedModel: string | null
}

export type SwitchMode = 'handoff' | 'failure-recovery'

export type SwitchPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly startedAt: number }
  | { readonly kind: 'spawning'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly handoffVersion: number; readonly recoveryRequired: boolean }
  | { readonly kind: 'receiving'; readonly txId: string; readonly mode: SwitchMode; readonly target: SwitchTarget; readonly newLinkId: string; readonly newSessionId: string }

export interface SessionLink {
  /** 宿主產生,鏈上唯一;跨後端的引用都用它。D2 只會出現 linkId === sessionId。 */
  readonly linkId: string
  readonly provider: Provider
  /** 該 provider 的原生 id,只給對應的 adapter 用。 */
  readonly sessionId: string
  /** Claude 有本機 transcript;沒有的 provider 為 null。 */
  readonly transcriptPath: string | null
  readonly parentLinkId: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly endReason: 'handoff' | 'failure-recovery' | 'user' | null
  /** system/init 回報過的模型,去重;D2 不填,留空陣列。 */
  readonly models: readonly string[]
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
  /** contentType 為 'conversation' 時有值;缺就是 'claude'(版本 1 轉換前的資料)。 */
  readonly provider?: Provider
}
```

`ProjectView` 加兩個欄位(放在 `pendingApproval` 之後):

```ts
  /** 底下扣著批准的對話分頁 id(規格 §4:記號從專案格移到分頁)。`pendingApproval` 等於這個非空。 */
  readonly pendingTabIds: readonly string[]
  /** 回合進行中的對話分頁 id;renderer 關分頁前用它決定要不要先確認(規格 §5)。 */
  readonly busyTabIds: readonly string[]
```

在 `TabTargetPayload` 後面加:

```ts
export interface ConversationOpenPayload {
  readonly projectId: string
}

export function parseConversationOpen(raw: unknown): ConversationOpenPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId'])) return null
  return { projectId: raw['projectId'] }
}
```

`isTabEntry` 的回傳條件最後加一行:

```ts
    (raw['threadId'] === undefined || typeof raw['threadId'] === 'string') &&
    (raw['provider'] === undefined || raw['provider'] === 'claude' || raw['provider'] === 'codex')
```

`isProjectView` 加:

```ts
    typeof raw['pendingApproval'] === 'boolean' &&
    Array.isArray(raw['pendingTabIds']) &&
    raw['pendingTabIds'].every(isNonEmptyString) &&
    Array.isArray(raw['busyTabIds']) &&
    raw['busyTabIds'].every(isNonEmptyString) &&
```

- [ ] **Step 4: 改 schema**

`src/main/projects-schema.ts` 整檔換成:

```ts
/**
 * 狀態檔的執行期形狀驗證(規格 §4.1,版本 2)。zod 只在 main 使用(與 view-tools/server.ts 同樣的用法)。
 * renderer 不 import 這個檔案。版本 1 先經 projects-migrate.ts 轉換再進這裡。
 */
import { z } from 'zod'
import { PROJECTS_SCHEMA_VERSION, type ProjectsState } from '../shared/projects.js'

const providerSchema = z.enum(['claude', 'codex'])

const switchTargetSchema = z.object({
  provider: providerSchema,
  requestedModel: z.string().nullable(),
})

const switchModeSchema = z.enum(['handoff', 'failure-recovery'])

const switchPhaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('preparing'), txId: z.string(), mode: switchModeSchema, target: switchTargetSchema, startedAt: z.number() }),
  z.object({
    kind: z.literal('spawning'), txId: z.string(), mode: switchModeSchema, target: switchTargetSchema,
    handoffVersion: z.number(), recoveryRequired: z.boolean(),
  }),
  z.object({
    kind: z.literal('receiving'), txId: z.string(), mode: switchModeSchema, target: switchTargetSchema,
    newLinkId: z.string(), newSessionId: z.string(),
  }),
])

const sessionLinkSchema = z.object({
  linkId: z.string().min(1),
  provider: providerSchema,
  sessionId: z.string().min(1),
  transcriptPath: z.string().nullable(),
  parentLinkId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  endReason: z.enum(['handoff', 'failure-recovery', 'user']).nullable(),
  models: z.array(z.string()),
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
  provider: providerSchema.optional(),
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
  // D2 規格 §3:每個專案至少一個對話分頁。
  .refine((p) => p.tabs.some((t) => t.contentType === 'conversation'), {
    message: '每個專案至少要有一個對話分頁',
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

- [ ] **Step 5: 寫轉換函式**

`src/main/projects-migrate.ts`:

```ts
/**
 * 狀態檔版本 1 → 2 的轉換(E 規格 §4.1)。只在 raw 物件上補欄位、改名,不驗證形狀:
 * 驗證交給 projects-schema.ts,這裡填錯的欄位會在那裡被擋下。不改傳入的物件。
 */
import { isRecord } from '../shared/ipc.js'

const CLAUDE_TARGET = { provider: 'claude', requestedModel: null } as const

function migrateLink(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const { parentSessionId, ...rest } = raw
  return {
    ...rest,
    linkId: raw['sessionId'],
    provider: 'claude',
    parentLinkId: parentSessionId ?? null,
    models: [],
  }
}

function migratePhase(raw: unknown): unknown {
  if (!isRecord(raw) || raw['kind'] === 'idle') return raw
  const base = { ...raw, mode: 'handoff', target: CLAUDE_TARGET }
  switch (raw['kind']) {
    case 'spawning':
      return { ...base, recoveryRequired: false }
    case 'receiving':
      return { ...base, newLinkId: raw['newSessionId'] }
    default:
      return base
  }
}

function migrateThread(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  return {
    ...raw,
    sessions: Array.isArray(raw['sessions']) ? raw['sessions'].map(migrateLink) : raw['sessions'],
    switchPhase: migratePhase(raw['switchPhase']),
  }
}

function migrateTab(raw: unknown): unknown {
  if (!isRecord(raw) || raw['contentType'] !== 'conversation') return raw
  return { ...raw, provider: 'claude' }
}

function migrateProject(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  return {
    ...raw,
    tabs: Array.isArray(raw['tabs']) ? raw['tabs'].map(migrateTab) : raw['tabs'],
    threads: Array.isArray(raw['threads']) ? raw['threads'].map(migrateThread) : raw['threads'],
  }
}

export function migrateV1(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  return {
    ...raw,
    schemaVersion: 2,
    projects: Array.isArray(raw['projects']) ? raw['projects'].map(migrateProject) : raw['projects'],
  }
}
```

- [ ] **Step 6: 跑轉換測試**

Run: `npx vitest run tests/projects-migrate.test.ts`
Expected: PASS(9 tests)

- [ ] **Step 7: 寫 store 的失敗測試**

`tests/projects-store.test.ts` 的 `STATE` 常數改成版本 2(`schemaVersion: 2`,對話分頁加 `provider: 'claude'`;`sessions` 仍是空陣列所以不必加 link 欄位)。`describe('parseProjectsState')` 裡的 `'schemaVersion 不是 1 就拒絕'` 改名 `'schemaVersion 不是 2 就拒絕'`,內容改成 `schemaVersion: 1` 與 `3` 都回 null;`'專案沒有對話分頁或有兩個都拒絕'` 改成:

```ts
  it('專案沒有對話分頁拒絕;有兩個可以', () => {
    const none = { ...STATE, projects: [{ ...STATE.projects[0], tabs: [] }] }
    expect(parseProjectsState(none)).toBeNull()
    const second = { ...STATE.projects[0]!.tabs[0]!, id: 't2', sortOrder: 1, threadId: 'th1' }
    const two = { ...STATE, projects: [{ ...STATE.projects[0], tabs: [...STATE.projects[0]!.tabs, second] }] }
    expect(parseProjectsState(two)).not.toBeNull()
  })
```

`describe('load')` 加兩個測試:

```ts
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

  it('主檔 schemaVersion 3(未來版本):改名保留,回空狀態', async () => {
    const { store, files, errors } = setup({ [FILE]: JSON.stringify({ ...STATE, schemaVersion: 3 }) })
    expect(await store.load()).toEqual(EMPTY_PROJECTS_STATE)
    expect(files.has(`${FILE}.schema-3`)).toBe(true)
    expect(errors.length).toBe(1)
  })
```

既有的 `'主檔 schemaVersion 不認得:改名保留,回空狀態'` 與 `'…改名失敗…'` 兩個測試若用 `schemaVersion: 7` 之類的值可保留;若用 `schemaVersion: 2`(現在合法了)就改成 `7`。

- [ ] **Step 8: 跑 store 測試確認失敗**

Run: `npx vitest run tests/projects-store.test.ts`
Expected: FAIL,版本 1 那個測試 `loaded.schemaVersion` 是 `undefined`(讀到空狀態)或 parse 失敗

- [ ] **Step 9: 改 store**

`src/main/projects-store.ts` 的 `readCandidate` 與 `load` 換成:

```ts
  /** 認得的版本:現行版本直接讀;版本 1 轉換後讀。其餘照 D 的規則改名保留。 */
  const KNOWN_VERSIONS: readonly number[] = [1, PROJECTS_SCHEMA_VERSION]

  async function readCandidate(
    path: string,
    isMain: boolean,
  ): Promise<{ readonly state: ProjectsState; readonly migrated: boolean } | null | 'unknown-version'> {
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(path))
    } catch (cause) {
      logError(new Error(`讀取 ${path} 失敗:${messageOf(cause)}`))
      return null
    }
    const version = readSchemaVersion(raw)
    if (isMain && version !== undefined && !KNOWN_VERSIONS.includes(version)) {
      const kept = `${filePath}.schema-${version}`
      // 改名失敗(唯讀的 userData、權限不足)只記錯誤:狀態檔的問題不該讓 app 起不來。
      // 原檔留在原位也還安全,後續 save 會先把它輪到 .bak.0 再寫新的主檔。
      try {
        await fs.rename(filePath, kept)
        logError(new Error(`${filePath} 的 schemaVersion ${version} 不認得,已改名為 ${kept} 保留,改用空狀態`))
      } catch (cause) {
        logError(new Error(
          `${filePath} 的 schemaVersion ${version} 不認得,改名為 ${kept} 失敗:${messageOf(cause)};原檔未動,改用空狀態`
        ))
      }
      return 'unknown-version'
    }
    const migrated = version === 1
    const parsed = parseProjectsState(migrated ? migrateV1(raw) : raw)
    if (parsed === null) {
      logError(new Error(`讀取 ${path} 失敗:內容不符合 schemaVersion ${PROJECTS_SCHEMA_VERSION}`))
      return null
    }
    return { state: parsed, migrated }
  }

  async function load(): Promise<ProjectsState> {
    for (const path of [filePath, bak0, bak1]) {
      if (!(await fs.exists(path))) continue
      const result = await readCandidate(path, path === filePath)
      if (result === 'unknown-version') return EMPTY_PROJECTS_STATE
      if (result === null) continue
      // 規格 §5:版本 1 轉換後寫回,下次啟動就直接是版本 2。寫失敗只記錯,狀態照用。
      if (result.migrated) {
        try {
          await save(result.state)
        } catch (cause) {
          logError(new Error(`寫回版本 ${PROJECTS_SCHEMA_VERSION} 的狀態檔失敗:${messageOf(cause)}`))
        }
      }
      return result.state
    }
    return EMPTY_PROJECTS_STATE
  }
```

檔頭 import 加 `import { migrateV1 } from './projects-migrate.js'`。`save` 定義在 `load` 之後是函式宣告,hoisting 會處理;若是 `const`,把 `load` 移到 `save` 後面。

- [ ] **Step 10: 補 fixture 與 `createProjectEntry`**

`src/main/projects-state.ts` 的 `createProjectEntry` 對話分頁加 `provider: 'claude'`(放在 `threadId` 之後)。

`src/main/ipc-bridge.ts` 的 `linkFor` 改成:

```ts
  const linkFor = (rootPath: string, sessionId: string, cwd: string | undefined): SessionLink => ({
    linkId: sessionId,
    provider: 'claude',
    sessionId,
    transcriptPath: transcriptPathFor(deps.homeDir, cwd ?? rootPath, sessionId),
    parentLinkId: null,
    startedAt: deps.projects.now(),
    endedAt: null,
    endReason: null,
    models: [],
  })
```

測試 fixture:
- `tests/projects-state.test.ts` 的 `link()` 改成回版本 2 的欄位(`linkId: sessionId, provider: 'claude', sessionId, transcriptPath, parentLinkId: null, startedAt: 500, endedAt: null, endReason: null, models: []`);`'名稱取資料夾名…'` 的 `tabs` 期望加 `provider: 'claude'`。
- `tests/projects-shared.test.ts`:`EMPTY_PROJECTS_STATE` 的測試改成 `schemaVersion 2`;`parseProjectsView` 的完整 view fixture 加 `pendingTabIds: []`、`busyTabIds: []`;加一個測試「`pendingTabIds` 不是字串陣列就拒絕」;加 `parseConversationOpen` 的測試(接受 `{ projectId: 'p' }`,丟掉多餘欄位,空字串回 null)。
- `tests/preload-bridge.test.ts` 的 `VIEW` 加 `pendingTabIds: []`、`busyTabIds: []`。
- `tests/ipc-bridge.test.ts` 若有比對 `SessionLink` 全欄位的斷言,補上四個新欄位。
- `tests/helpers/fake-yeschef.ts` 的 `projectView` 加 `pendingTabIds: []`、`busyTabIds: []`;`tests/use-projects.test.tsx` 的 `project()` 同樣補。
- `tests/recents-groups.test.ts`、`tests/recents.test.tsx` 的 `SessionLink`/`ProjectView` fixture 同樣補版本 2 欄位。
- `src/main/ipc-bridge.ts` 的 `composeView` 回傳的每個 `ProjectView` 先補 `pendingTabIds: []`、`busyTabIds: []`(Task 5 換成真值),否則 typecheck 不過。

- [ ] **Step 11: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 12: Commit**

```bash
git add src/shared/projects.ts src/main/projects-schema.ts src/main/projects-migrate.ts src/main/projects-store.ts src/main/projects-state.ts src/main/ipc-bridge.ts tests/projects-migrate.test.ts tests/projects-store.test.ts tests/projects-shared.test.ts tests/projects-state.test.ts tests/preload-bridge.test.ts tests/ipc-bridge.test.ts tests/helpers/fake-yeschef.ts tests/use-projects.test.tsx tests/recents-groups.test.ts tests/recents.test.tsx
git commit -m "feat: 狀態檔升到版本 2,版本 1 讀進來轉換後寫回"
```

---

### Task 2: IPC payload 帶 conversationId,renderer hooks 依它分流

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/bridge.ts`
- Modify: `src/renderer/hooks/useConversation.ts`、`useApprovals.ts`、`useSessions.ts`、`useProjects.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/helpers/fake-yeschef.ts`
- Test: `tests/ipc.test.ts`、`tests/preload-bridge.test.ts`、`tests/use-conversation.test.tsx`、`tests/use-approvals.test.tsx`、`tests/use-sessions.test.tsx`、`tests/use-projects.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ConversationOpenPayload`、`parseConversationOpen`、`ProjectView.busyTabIds`。
- Produces:
  - `IPC.conversationsOpen = 'conversations:open'`
  - `EventsBatchPayload { conversationId: string; events: readonly Event[] }`、`parseEventsBatchPayload`
  - `SessionStatePayload { conversationId: string; state: SessionState }`、`parseSessionStatePayload`
  - `ApprovalAskPayload.conversationId: string`(必填)
  - `YesChefApi.onEvents(cb: (payload: EventsBatchPayload) => void)`、`onSessionState(cb: (payload: SessionStatePayload) => void)`、`openConversation(projectId: string): void`
  - `useConversation(api, conversationId: string)`、`useApprovals(api, conversationId: string | null)`、`useSessions(api, refresh, scope, conversationId: string | null)`
  - `Projects.openConversation(): void`
  - `src/renderer/foreground.ts` 的 `foregroundConversationId(project: ProjectView | undefined): string | null`

- [ ] **Step 1: 寫 shared 的失敗測試**

`tests/ipc.test.ts`:

`'二十個頻道逐字比對'` 的期望物件加 `conversationsOpen: 'conversations:open'`,測試名改成 `'二十一個頻道逐字比對'`。

`describe('parseApprovalAsk 的 projectId 與 parseApprovalSettled')` 裡加:

```ts
  it('conversationId 缺或空字串整筆拒絕', () => {
    const base = { requestId: 'r', projectId: 'p', toolUseId: 't', toolName: 'Bash', input: {} }
    expect(parseApprovalAsk(base)).toBeNull()
    expect(parseApprovalAsk({ ...base, conversationId: '' })).toBeNull()
    expect(parseApprovalAsk({ ...base, conversationId: 'c-1' })?.conversationId).toBe('c-1')
  })
```

該檔既有的每個合法 `parseApprovalAsk` fixture 都要補 `conversationId: 'c-1'`,否則會因缺欄位變成 null。

新增兩個 describe:

```ts
describe('parseEventsBatchPayload', () => {
  const events = [{ kind: 'user-text', text: 'hi' }]
  it('conversationId 非空且 events 非空陣列才通過', () => {
    expect(parseEventsBatchPayload({ conversationId: 'c-1', events })).toEqual({ conversationId: 'c-1', events })
    expect(parseEventsBatchPayload({ conversationId: '', events })).toBeNull()
    expect(parseEventsBatchPayload({ events })).toBeNull()
    expect(parseEventsBatchPayload({ conversationId: 'c-1', events: [] })).toBeNull()
    expect(parseEventsBatchPayload(events)).toBeNull()
  })
})

describe('parseSessionStatePayload', () => {
  it('包一層 conversationId,state 沿用 parseSessionState 的規則', () => {
    expect(parseSessionStatePayload({ conversationId: 'c-1', state: { kind: 'idle' } })).toEqual({ conversationId: 'c-1', state: { kind: 'idle' } })
    expect(parseSessionStatePayload({ conversationId: 'c-1', state: { kind: 'viewing' } })).toBeNull()
    expect(parseSessionStatePayload({ conversationId: '', state: { kind: 'idle' } })).toBeNull()
    expect(parseSessionStatePayload({ kind: 'idle' })).toBeNull()
  })
})
```

import 清單加 `parseEventsBatchPayload, parseSessionStatePayload`。

`tests/preload-bridge.test.ts` 加一個測試:

```ts
  it('openConversation 送 conversations:open,payload 只有 projectId', async () => {
    const api = await loadBridge()
    api.openConversation('p-1')
    expect(sent.at(-1)).toEqual({ channel: 'conversations:open', payload: { projectId: 'p-1' } })
  })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/ipc.test.ts tests/preload-bridge.test.ts`
Expected: FAIL,`parseEventsBatchPayload is not a function`、`api.openConversation is not a function`

- [ ] **Step 3: 改 `src/shared/ipc.ts`**

`IPC` 物件在 `tabsActivate` 之後加:

```ts
  /** renderer → main:在某專案底下開一個新的對話分頁(D2) */
  conversationsOpen: 'conversations:open',
```

`ApprovalAskPayload` 在 `projectId` 之後加:

```ts
  /** 這筆批准屬於哪個對話分頁(D2)。renderer 每個對話一份 useApprovals,依它過濾。 */
  readonly conversationId: string
```

在 `SessionSummary` 之前加:

```ts
/** `agent:events` 的 payload(D2):每個對話分頁一條流,renderer 依 `conversationId` 分流。 */
export interface EventsBatchPayload {
  readonly conversationId: string
  readonly events: readonly Event[]
}

/** `session:state` 的 payload(D2)。 */
export interface SessionStatePayload {
  readonly conversationId: string
  readonly state: SessionState
}
```

`YesChefApi` 改三處:

```ts
  onEvents(cb: (payload: EventsBatchPayload) => void): () => void
  onSessionState(cb: (payload: SessionStatePayload) => void): () => void
  /** 在某專案底下開一個新的 Claude 對話分頁(D2)。 */
  openConversation(projectId: string): void
```

`parseApprovalAsk` 在 `projectId` 檢查後加 `if (!isNonEmptyString(v.conversationId)) return null`,回傳物件加 `conversationId: v.conversationId`。

`parseEventsBatch` 之後加:

```ts
export function parseEventsBatchPayload(v: unknown): EventsBatchPayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.conversationId)) return null
  const events = parseEventsBatch(v.events)
  return events === null ? null : { conversationId: v.conversationId, events }
}
```

`parseSessionState` 之後加:

```ts
export function parseSessionStatePayload(v: unknown): SessionStatePayload | null {
  if (!isRecord(v)) return null
  if (!isNonEmptyString(v.conversationId)) return null
  const state = parseSessionState(v.state)
  return state === null ? null : { conversationId: v.conversationId, state }
}
```

- [ ] **Step 4: 改 preload**

`src/preload/bridge.ts`:import 改成 `parseEventsBatchPayload`、`parseSessionStatePayload`(拿掉 `parseEventsBatch`、`parseSessionState`),`projects.js` 的 import 加 `type ConversationOpenPayload`;`api` 物件:

```ts
  onEvents: (cb) => subscribe(IPC.eventsBatch, parseEventsBatchPayload, cb),
  onSessionState: (cb) => subscribe(IPC.sessionState, parseSessionStatePayload, cb),
```

在 `activateTab` 之後加:

```ts
  openConversation: (projectId) => {
    ipcRenderer.send(IPC.conversationsOpen, { projectId } satisfies ConversationOpenPayload)
  },
```

- [ ] **Step 5: 改測試 helper**

`tests/helpers/fake-yeschef.ts`:

- import 加 `EventsBatchPayload, SessionStatePayload`。
- `FakeYesChef` 介面:`emitState(state: SessionState, conversationId?: string): void`、`emitEvents(events: readonly Event[], conversationId?: string): void`。
- 常數 `export const DEFAULT_CONVERSATION = 'p-1-conv'`(等於 `ONE_PROJECT` 的對話分頁 id)。
- `stateListeners` 型別改 `Set<(p: SessionStatePayload) => void>`,`eventListeners` 改 `Set<(p: EventsBatchPayload) => void>`。
- `api.onEvents: on(eventListeners)`、`api.onSessionState: on(stateListeners)` 不變(型別跟著 Set 走)。
- `api` 加 `openConversation: (projectId) => { calls.push(\`openConversation:${projectId}\`) }`。
- 回傳物件:

```ts
    emitState: (state, conversationId = DEFAULT_CONVERSATION) => {
      act(() => { rawEmit(stateListeners)({ conversationId, state }) })
    },
    emitEvents: (events, conversationId = DEFAULT_CONVERSATION) => {
      act(() => { rawEmit(eventListeners)({ conversationId, events }) })
    },
```

- `fakeProjects` 的 `Projects` 假物件加 `openConversation: () => { calls.push('openConversation') }`。

- [ ] **Step 6: 寫 hooks 的失敗測試**

`tests/use-conversation.test.tsx` 的本地 `Fake` 介面與 `createFake()`:`eventCbs` 型別改 `Array<(p: EventsBatchPayload) => void>`,`stateCbs` 改 `Array<(p: SessionStatePayload) => void>`;`emitEvents(events)` 實作改成呼叫 `cb({ conversationId: 'p-1-conv', events })`,`emitState(state)` 改成 `cb({ conversationId: 'p-1-conv', state })`。既有的 `renderHook(() => useConversation(fake.api))` 全改成 `useConversation(fake.api, 'p-1-conv')`。加一個測試:

```ts
  it('只收自己 conversationId 的事件與狀態', () => {
    const fake = createFake()
    const { result } = renderHook(() => useConversation(fake.api, 'p-1-conv'))
    act(() => {
      for (const cb of fake.eventCbs) cb({ conversationId: 'other', events: [{ kind: 'user-text', text: '不是我的' }] })
      for (const cb of fake.stateCbs) cb({ conversationId: 'other', state: { kind: 'live', sessionId: 'x' } })
    })
    expect(result.current.view.turns).toEqual([])
    expect(result.current.sessionState).toEqual({ kind: 'idle' })
  })
```

(`Fake` 介面要把 `eventCbs`、`stateCbs` 露出來給這個測試用。)

`tests/use-approvals.test.tsx`:`ask()` 的 fixture 加 `conversationId: 'p-1-conv'`;所有 `useApprovals(fake.api, 'p-1')` 改成 `useApprovals(fake.api, 'p-1-conv')`;依 `projectId` 過濾的那幾個測試改成依 `conversationId`:第二個專案的 ask 用 `ask('req-2', { projectId: 'p-2', conversationId: 'p-2-conv' })`,`rerender` 時傳 `'p-2-conv'`。

`tests/use-sessions.test.tsx`:呼叫改成 `useSessions(api, refresh, scope, 'p-1-conv')`;加一個測試:別的 `conversationId` 的 `session:state` 不改 `current`。

`tests/use-projects.test.tsx` 加:

```ts
  it('openConversation 對 active 專案送 conversations:open;沒有 active 專案不送', async () => {
    const { api, calls } = harness({ view: { activeId: 'a', projects: [project('a')] } })
    const { result } = renderHook(() => useProjects(api))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => { result.current.openConversation() })
    expect(calls).toContain('openConversation:a')
  })
```

(`harness` 是該檔既有的假 api 工廠,參數形狀以該檔為準;它的假 api 要加 `openConversation`,並把呼叫記成 `openConversation:<projectId>` 進 `calls`。)

- [ ] **Step 7: 跑測試確認失敗**

Run: `npx vitest run tests/use-conversation.test.tsx tests/use-approvals.test.tsx tests/use-sessions.test.tsx tests/use-projects.test.tsx`
Expected: FAIL(型別錯誤或 `openConversation` 不存在)

- [ ] **Step 8: 改 hooks**

`src/renderer/hooks/useConversation.ts` 的簽名與 effect:

```ts
export function useConversation(api: YesChefApi, conversationId: string): {
  readonly view: ConversationView
  readonly sessionState: SessionState
  readonly turnEnds: number
} {
  const [acc, setAcc] = useState<Accumulated>(INITIAL_ACCUMULATED)

  useEffect(() => {
    // 每個對話分頁一份 hook(D2)。別的對話的流在這裡就丟掉,不進 state。
    setAcc(INITIAL_ACCUMULATED)
    const offEvents = api.onEvents((payload) => {
      if (payload.conversationId !== conversationId || payload.events.length === 0) return
      setAcc((prev) => ({ ...prev, events: appendEvents(prev.events, payload.events) }))
    })
    const offState = api.onSessionState((payload) => {
      if (payload.conversationId !== conversationId) return
      setAcc((prev) => ({ ...prev, state: payload.state }))
    })
    return () => {
      offEvents()
      offState()
    }
  }, [api, conversationId])
```

其餘不動。

`src/renderer/hooks/useApprovals.ts`:簽名改 `useApprovals(api: YesChefApi, conversationId: string | null)`;`pending` 改成:

```ts
  const pending = useMemo(
    () => (conversationId === null ? [] : all.filter((a) => a.conversationId === conversationId)),
    [all, conversationId]
  )
```

檔頭註解裡「切專案只是換 `activeId` 這個過濾條件」改成「切對話只是換 `conversationId` 這個過濾條件」。

`src/renderer/hooks/useSessions.ts`:簽名改 `useSessions(api: YesChefApi, refresh: number, scope: SessionListScope, conversationId: string | null)`;訂閱改成:

```ts
  useEffect(
    () =>
      api.onSessionState((payload) => {
        if (payload.conversationId === conversationId) setState(payload.state)
      }),
    [api, conversationId]
  )
```

`src/renderer/hooks/useProjects.ts`:`Projects` 介面加 `openConversation(): void`(註解:「在 active 專案底下開一個新的 Claude 對話分頁;沒有 active 專案時不做事」);實作:

```ts
  const openConversation = useCallback((): void => {
    if (activeId === null) return
    api.openConversation(activeId)
  }, [api, activeId])
```

加進回傳的 `useMemo` 物件與 deps。

- [ ] **Step 9: 前景對話的 selector 與 App 暫時接線**

新檔 `src/renderer/foreground.ts`:

```ts
import type { ProjectView } from '../shared/projects.js'

/**
 * 一個專案的前景對話:`lastFocusedAt` 最大的 conversation 分頁。主行程用同一條規則
 * 決定哪個 core 是前景(projects-state.ts 的 `activeConversationId`),兩邊算出來要一樣。
 */
export function foregroundConversationId(project: ProjectView | undefined): string | null {
  if (project === undefined) return null
  const tabs = project.tabs.filter((t) => t.contentType === 'conversation')
  const best = tabs.reduce<typeof tabs[number] | undefined>(
    (acc, t) => (acc === undefined || t.lastFocusedAt > acc.lastFocusedAt ? t : acc),
    undefined
  )
  return best?.id ?? null
}
```

`src/renderer/App.tsx`:

```ts
  const projects = useProjects(api)
  const activeId = projects.view.activeId
  const conversationId = foregroundConversationId(projects.active)
  const { view: rawView, sessionState, turnEnds } = useConversation(api, conversationId ?? '')
  const { pending, reply } = useApprovals(api, conversationId)
  …
  const { sessions, current, error } = useSessions(api, turnEnds, listScope, conversationId)
```

import `foregroundConversationId`。這是過渡接線:Task 6 把整段搬進 `ConversationPane`,`App` 不再直接用這三個 hook。

`ApprovalAskPayload.conversationId` 變必填後,`src/main/ipc-bridge.ts` 的 `createSlot` 要補一個過渡值才過 typecheck:

```ts
// 過渡(D2 Task 2):現在每個專案只有一個對話分頁,它的 id 就是 conversationId。Task 5 改成 slot 自帶。
const conversationId = entry === undefined ? projectId : conversationTab(entry).id
```

`approvalAsk` 的 payload 改成 `{ ...request, projectId, conversationId }`;`events`、`state` 兩個 sink 不動。因型別變更而紅的既有測試 fixture(`approval-card`、`approvals`、`handoff-card`、`ipc-bridge`)補 `conversationId`。

- [ ] **Step 10: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npm test`
Expected: 全部 PASS。`tests/app-title-bar.test.tsx`、`tests/recents.test.tsx` 等會 render `App` 的測試若因 fixture 缺 `conversationId` 而紅,照 Step 5 的 helper 補。

- [ ] **Step 11: Commit**

```bash
git add src/shared/ipc.ts src/preload/bridge.ts src/main/ipc-bridge.ts src/renderer/hooks/useConversation.ts src/renderer/hooks/useApprovals.ts src/renderer/hooks/useSessions.ts src/renderer/hooks/useProjects.ts src/renderer/foreground.ts src/renderer/App.tsx tests/helpers/fake-yeschef.ts tests/ipc.test.ts tests/preload-bridge.test.ts tests/use-conversation.test.tsx tests/use-approvals.test.tsx tests/use-sessions.test.tsx tests/use-projects.test.tsx tests/approval-card.test.tsx tests/approvals.test.ts tests/handoff-card.test.tsx tests/ipc-bridge.test.ts
git commit -m "feat: 三個對話頻道的 payload 帶 conversationId,renderer hooks 依它分流"
```

---

### Task 3: reducer 與 selector 收 conversationId

**Files:**
- Modify: `src/main/projects-state.ts`
- Modify: `src/main/ipc-bridge.ts`(只改呼叫端,讓 typecheck 過;真正的多 slot 改造在 Task 5)
- Test: `tests/projects-state.test.ts`

**Interfaces:**
- Produces(全部 export 自 `src/main/projects-state.ts`):
  - `conversationTabs(entry: ProjectEntry): readonly TabEntry[]`(依 `sortOrder`)
  - `activeConversationId(entry: ProjectEntry): string`(`lastFocusedAt` 最大的 conversation 分頁;沒有就 throw)
  - `foregroundConversationId(state: ProjectsState): string | null`
  - `findProjectByTab(state: ProjectsState, tabId: string): ProjectEntry | undefined`
  - `openConversationTab(state, projectId, input: { tabId: string; threadId: string }, now): ProjectsState`
  - `closeTab(state, projectId, tabId, now)`:可關 conversation 分頁,最後一個拒絕(回原 state)
  - `startThread(state, projectId, conversationId, threadId, now)`
  - `pointConversationAt(state, projectId, conversationId, link, newThreadId, now)`
  - `currentThread(entry, conversationId): ThreadEntry | undefined`
  - `lastSessionId(entry, conversationId): string | undefined`
  - `recordSession(state, projectId, threadId, link)` 不變
  - 移除 `conversationTab(entry)`

- [ ] **Step 1: 寫失敗測試**

`tests/projects-state.test.ts` import 換成新名字(拿掉 `conversationTab`,加 `activeConversationId, conversationTabs, findProjectByTab, foregroundConversationId, openConversationTab`)。既有用到 `conversationTab(entry)` 的地方改成 `conversationTabs(entry)[0]`。既有的 `startThread(two, 'a', 'a-th2', 200)` 改成 `startThread(two, 'a', 'a-conv', 'a-th2', 200)`,`pointConversationAt(two, 'a', link('s'), 'a-th2', 200)` 改成 `pointConversationAt(two, 'a', 'a-conv', link('s'), 'a-th2', 200)`,`currentThread(entry)` 改 `currentThread(entry, 'a-conv')`,`lastSessionId(entry)` 改 `lastSessionId(entry, 'a-conv')`。

新增:

```ts
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
  it('pointConversationAt 指到既有 session 的 thread 時只改那個分頁', () => {
    const withSession = recordSession(s, 'a', 'a-th1', link('s-1'))
    const t = pointConversationAt(withSession, 'a', 'a-conv2', link('s-1'), 'unused', 400)
    const a = findProject(t, 'a')!
    expect(conversationTabs(a).map((x) => x.threadId)).toEqual(['a-th1', 'a-th1'])
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
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/projects-state.test.ts`
Expected: FAIL,`openConversationTab` 等不是函式

- [ ] **Step 3: 改 reducer**

`src/main/projects-state.ts`,從 `conversationTab` 到檔尾換成:

```ts
function mostRecent(tabs: readonly TabEntry[]): TabEntry | undefined {
  return tabs.reduce<TabEntry | undefined>(
    (best, t) => (best === undefined || t.lastFocusedAt > best.lastFocusedAt ? t : best),
    undefined,
  )
}

/** 一個專案的對話分頁,依 sortOrder。 */
export function conversationTabs(entry: ProjectEntry): readonly TabEntry[] {
  return entry.tabs.filter((t) => t.contentType === 'conversation').sort((a, b) => a.sortOrder - b.sortOrder)
}

/** 前景對話(D2 規格 §1):最近聚焦的對話分頁。schema 保證至少一個。 */
export function activeConversationId(entry: ProjectEntry): string {
  const tab = mostRecent(conversationTabs(entry))
  if (tab === undefined) throw new Error(`專案 ${entry.id} 沒有對話分頁`)
  return tab.id
}

export function activeTabId(entry: ProjectEntry): string {
  return mostRecent(entry.tabs)?.id ?? activeConversationId(entry)
}

export function foregroundConversationId(state: ProjectsState): string | null {
  const entry = state.activeId === null ? undefined : findProject(state, state.activeId)
  return entry === undefined ? null : activeConversationId(entry)
}

export function findProjectByTab(state: ProjectsState, tabId: string): ProjectEntry | undefined {
  return state.projects.find((p) => p.tabs.some((t) => t.id === tabId))
}

export interface NewTabInput {
  readonly id: string
  readonly label: string
  readonly command?: string
}

function nextSortOrder(p: ProjectEntry): number {
  return Math.max(...p.tabs.map((t) => t.sortOrder)) + 1
}

export function openTab(state: ProjectsState, projectId: string, tab: NewTabInput, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const entry: TabEntry = {
      id: tab.id,
      contentType: 'terminal',
      label: tab.label,
      customLabel: null,
      ...(tab.command === undefined ? {} : { command: tab.command }),
      sortOrder: nextSortOrder(p),
      lastFocusedAt: now,
    }
    return { ...p, tabs: [...p.tabs, entry] }
  })
}

export interface NewConversationInput {
  readonly tabId: string
  readonly threadId: string
}

/** 規格 §3:新增一個 conversation 分頁與一條空 thread;新開的立刻成為 active 分頁。 */
export function openConversationTab(
  state: ProjectsState,
  projectId: string,
  input: NewConversationInput,
  now: number,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const count = conversationTabs(p).length
    const entry: TabEntry = {
      id: input.tabId,
      contentType: 'conversation',
      label: count === 0 ? CONVERSATION_TAB_LABEL : `${CONVERSATION_TAB_LABEL} ${count + 1}`,
      customLabel: null,
      sortOrder: nextSortOrder(p),
      lastFocusedAt: now,
      threadId: input.threadId,
      provider: 'claude',
    }
    return { ...p, tabs: [...p.tabs, entry], threads: [...p.threads, newThread(input.threadId, now)] }
  })
}

/** 沒有分頁指到、也沒有 session 的 thread 回收掉;其餘保留。 */
function pruneThreads(tabs: readonly TabEntry[], threads: readonly ThreadEntry[]): readonly ThreadEntry[] {
  const referenced = new Set(tabs.map((t) => t.threadId))
  return threads.filter((t) => t.sessions.length > 0 || referenced.has(t.id))
}

/**
 * 關分頁。終端分頁照關;對話分頁可關,但一個專案至少留一個(規格 §3)。
 * 關掉的是 active 分頁時,焦點回到剩下的分頁裡最近聚焦的對話分頁(沿用 D:終端關掉回對話)。
 */
export function closeTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const target = p.tabs.find((t) => t.id === tabId)
    if (target === undefined) return p
    if (target.contentType === 'conversation' && conversationTabs(p).length <= 1) return p
    const wasFocused = activeTabId(p) === tabId
    const remaining = p.tabs.filter((t) => t.id !== tabId)
    const fallback = mostRecent(remaining.filter((t) => t.contentType === 'conversation'))?.id
    const tabs = remaining.map((t) => (wasFocused && t.id === fallback ? { ...t, lastFocusedAt: now } : t))
    return { ...p, tabs, threads: pruneThreads(tabs, p.threads) }
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

function pointTabAt(p: ProjectEntry, conversationId: string, threadId: string): readonly TabEntry[] {
  return p.tabs.map((t) => (t.id === conversationId ? { ...t, threadId } : t))
}

export function startThread(
  state: ProjectsState,
  projectId: string,
  conversationId: string,
  threadId: string,
  now: number,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    if (!p.tabs.some((t) => t.id === conversationId && t.contentType === 'conversation')) return p
    const tabs = pointTabAt(p, conversationId, threadId)
    return { ...p, tabs, threads: [...pruneThreads(tabs, p.threads), newThread(threadId, now)] }
  })
}

export function pointConversationAt(
  state: ProjectsState,
  projectId: string,
  conversationId: string,
  link: SessionLink,
  newThreadId: string,
  now: number,
): ProjectsState {
  return updateProject(state, projectId, (p) => {
    if (!p.tabs.some((t) => t.id === conversationId && t.contentType === 'conversation')) return p
    const existing = p.threads.find((t) => t.sessions.some((s) => s.sessionId === link.sessionId))
    if (existing !== undefined) {
      const tabs = pointTabAt(p, conversationId, existing.id)
      return { ...p, tabs, threads: pruneThreads(tabs, p.threads) }
    }
    const tabs = pointTabAt(p, conversationId, newThreadId)
    return { ...p, tabs, threads: [...pruneThreads(tabs, p.threads), newThread(newThreadId, now, [link])] }
  })
}

export function recordSession(state: ProjectsState, projectId: string, threadId: string, link: SessionLink): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const thread = p.threads.find((t) => t.id === threadId)
    if (thread === undefined) return p
    // 比對整條鏈,不只最後一筆:resume 回鏈上較早那段時會再收到一次它的
    // session-started,只看最後一筆的話同一個 sessionId 會被記第二次。
    if (thread.sessions.some((s) => s.sessionId === link.sessionId)) return p
    const updated: ThreadEntry = { ...thread, sessions: [...thread.sessions, link] }
    return { ...p, threads: p.threads.map((t) => (t.id === threadId ? updated : t)) }
  })
}

export function setShutdown(state: ProjectsState, openIds: readonly string[]): ProjectsState {
  return { ...state, openIdsOnShutdown: [...openIds] }
}

export function currentThread(entry: ProjectEntry, conversationId: string): ThreadEntry | undefined {
  const tab = entry.tabs.find((t) => t.id === conversationId && t.contentType === 'conversation')
  if (tab === undefined) return undefined
  return entry.threads.find((t) => t.id === tab.threadId)
}

export function lastSessionId(entry: ProjectEntry, conversationId: string): string | undefined {
  return currentThread(entry, conversationId)?.sessions.at(-1)?.sessionId
}
```

注意 `startThread` 的 `pruneThreads` 在 `newThread` 之前跑:新 thread 還沒被推進 `threads`,但 `tabs` 已指向它,所以不會被誤刪;舊 thread 若沒有 session、也沒有別的分頁指著,就會被回收(D 的既有行為)。

- [ ] **Step 4: 讓 ipc-bridge 過 typecheck**

`src/main/ipc-bridge.ts` 這一步只改呼叫,不改結構(Task 5 才重構):

- `recordStarted`:`currentThread(entry)` 改成 `currentThread(entry, activeConversationId(entry))`。
- `createSlot`:`lastSessionId(entry)` 改成 `lastSessionId(entry, activeConversationId(entry))`。
- `onIntentStartNew`:`startThread(state, projectId, deps.projects.newId(), deps.projects.now())` 改成 `startThread(state, projectId, activeConversationId(findProject(state, projectId)!), deps.projects.newId(), deps.projects.now())`。
- `onIntentOpenHistory`:`pointConversationAt(state, projectId, link, …)` 改成 `pointConversationAt(state, projectId, activeConversationId(findProject(state, projectId)!), link, …)`。
- Task 2 留的過渡行 `conversationTab(entry).id` 改成 `activeConversationId(entry)`。
- import 加 `activeConversationId`。

`!` 在這裡可以接受:這些呼叫都在 `withActive` 裡,專案一定存在;Task 5 會把它們換成 slot 自帶的 `projectId`。

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/projects-state.ts src/main/ipc-bridge.ts tests/projects-state.test.ts
git commit -m "feat: 專案狀態的 reducer 支援多個對話分頁"
```

---

### Task 4: 對話核心回報 busy;`conversations:open` 通道

**Files:**
- Modify: `src/main/conversation.ts`
- Modify: `src/main/projects-ipc.ts`
- Test: `tests/conversation.test.ts`、`tests/projects-ipc.test.ts`、`tests/ipc-bridge.test.ts`(假 core 補 `isBusy`)

**Interfaces:**
- Consumes: Task 1 的 `parseConversationOpen`;Task 3 的 `openConversationTab`。
- Produces:
  - `Conversation.isBusy(): boolean`
  - `ConversationDeps.onBusyChange?: (busy: boolean) => void`(只在值改變時呼叫)
  - `conversations:open` 的 ipcMain handler(`registerProjectsIpc` 內)

- [ ] **Step 1: 寫 conversation 的失敗測試**

`tests/conversation.test.ts` 的 `Rig` 加 `readonly busyChanges: boolean[]`;`setup()` 裡宣告 `const busyChanges: boolean[] = []`,`createConversation` 的 deps 加 `onBusyChange: (busy) => { busyChanges.push(busy) }`,回傳物件加 `busyChanges`。新增:

```ts
describe('busy', () => {
  it('一開始不 busy;userInput 之後 busy,session-end 之後不 busy;只在改變時通知', async () => {
    const rig = setup()
    expect(rig.core.isBusy()).toBe(false)
    rig.core.userInput('hi')
    await flush()
    expect(rig.core.isBusy()).toBe(true)
    rig.hostDeps().onBatch([START_S9, say('hi')])
    expect(rig.core.isBusy()).toBe(true)
    rig.hostDeps().onBatch([END_OK])
    expect(rig.core.isBusy()).toBe(false)
    expect(rig.busyChanges).toEqual([true, false])
  })

  it('startNew 與 openHistory 都把 busy 清掉', async () => {
    const rig = setup()
    rig.core.userInput('hi')
    await flush()
    rig.core.startNew()
    expect(rig.core.isBusy()).toBe(false)
    rig.core.userInput('again')
    await flush()
    rig.core.openHistory('s-old')
    expect(rig.core.isBusy()).toBe(false)
    expect(rig.busyChanges).toEqual([true, false, true, false])
  })

  it('host onEnded 也把 busy 清掉', async () => {
    const rig = setup()
    rig.core.userInput('hi')
    await flush()
    rig.hostDeps().onEnded()
    expect(rig.core.isBusy()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/conversation.test.ts`
Expected: FAIL,`rig.core.isBusy is not a function`

- [ ] **Step 3: 改 conversation.ts**

`ConversationDeps` 在 `onHeldChange` 之後加:

```ts
  /** 回合進行中與否改變時通知(D2);路由器據此更新分頁列的 busy 記號,renderer 關分頁前用它決定要不要確認。 */
  readonly onBusyChange?: (busy: boolean) => void
```

`Conversation` 介面在 `heldApprovals()` 之後加 `isBusy(): boolean`。

`createConversation` 內,`let busy = false` 之後加:

```ts
  const setBusy = (next: boolean): void => {
    if (busy === next) return
    busy = next
    deps.onBusyChange?.(next)
  }
```

把五處直接賦值換掉:`turnEnded` 的 `busy = false` → `setBusy(false)`;`onEnded` 的 `busy = false` → `setBusy(false)`;`userInput` 的 `busy = true` → `setBusy(true)`;`startNew`、`openHistory` 的 `busy = false` → `setBusy(false)`。改完 `grep -n "busy = " src/main/conversation.ts` 只該剩 `let busy = false` 與 `setBusy` 裡那一行。

回傳物件加 `isBusy: () => busy`。

- [ ] **Step 4: 補 ipc-bridge 測試的假 core**

`tests/ipc-bridge.test.ts` 的 `makeFakeCore` 加 `let busy = false`、`isBusy: () => busy`,`FakeCore` 介面加 `setBusy(n: boolean): void`,回傳加 `setBusy: (n) => { busy = n; deps.onBusyChange?.(n) }`。

- [ ] **Step 5: 寫 projects-ipc 的失敗測試**

`tests/projects-ipc.test.ts` 加:

```ts
describe('conversations:open', () => {
  it('在指定專案底下開一個新對話分頁,兩個 id 都由 newId 產生,成為 active 分頁', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, { projectId: A })
    const entry = findProject(rig.service.state(), A)
    expect(entry?.tabs.map((t) => t.id)).toEqual(['tab-a', 'id-1'])
    expect(entry?.tabs[1]).toMatchObject({ contentType: 'conversation', label: 'Claude 對話 2', threadId: 'id-2', provider: 'claude' })
    expect(entry?.threads.map((t) => t.id)).toEqual(['th-a', 'id-2'])
    expect(activeTabId(entry!)).toBe('id-1')
    expect(rig.errors).toEqual([])
  })

  it('未知 projectId:記錯誤,state 不變', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.conversationsOpen, { projectId: 'zzz' })
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
    rig.fire(IPC.conversationsOpen, { projectId: A })
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'id-1' })
    expect(findProject(rig.service.state(), A)?.tabs.map((t) => t.id)).toEqual(['tab-a'])
    const before = rig.service.state()
    rig.fire(IPC.tabsClose, { projectId: A, tabId: 'tab-a' })
    expect(rig.service.state()).toBe(before)
  })
})
```

`'unregister 拆掉全部 handler'` 的 `expect(listeners.size + handlers.size).toBe(7)` 改成 `toBe(8)`。

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run tests/projects-ipc.test.ts`
Expected: FAIL,`沒有註冊 conversations:open`

- [ ] **Step 7: 改 projects-ipc.ts**

import 加 `parseConversationOpen`(自 `../shared/projects.js`)與 `openConversationTab`(自 `./projects-state.js`)。在 `onTabActivate` 之後加:

```ts
  const onConversationOpen = onSend(
    IPC.conversationsOpen, parseConversationOpen, (p) => (s) =>
      openConversationTab(s, p.projectId, { tabId: service.newId(), threadId: service.newId() }, service.now()),
    (p) => p.projectId)
```

註冊與拆除各加一行:`ipcMain.on(IPC.conversationsOpen, onConversationOpen)`、`ipcMain.removeListener(IPC.conversationsOpen, onConversationOpen)`。

`onSend` 的 reducer 是在 `service.update` 內執行的,`service.newId()` 在 reducer 建構時就呼叫(箭頭函式 `(p) => (s) => …` 的內層才呼叫 `newId`,那是在 `update` 裡),兩個 id 的順序是 tabId 先、threadId 後,測試斷言 `id-1`/`id-2` 依這個順序。

- [ ] **Step 8: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/conversation.ts src/main/projects-ipc.ts tests/conversation.test.ts tests/projects-ipc.test.ts tests/ipc-bridge.test.ts
git commit -m "feat: 對話核心回報 busy,新增 conversations:open 通道"
```

---

### Task 5: ipc-bridge 每個對話分頁一個 slot

**Files:**
- Modify: `src/main/ipc-bridge.ts`
- Modify: `src/main/index.ts:252`(`runtimeFor` 多一個參數,忽略即可)
- Test: `tests/ipc-bridge.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `activeConversationId`、`conversationTabs`、`findProjectByTab`、`foregroundConversationId`、`currentThread(entry, conversationId)`、`lastSessionId(entry, conversationId)`、`startThread(state, projectId, conversationId, …)`、`pointConversationAt(state, projectId, conversationId, …)`;Task 4 的 `isBusy`、`onBusyChange`;Task 2 的 `EventsBatchPayload`、`SessionStatePayload`、`ApprovalAskPayload.conversationId`。
- Produces:
  - `IpcBridgeDeps.runtimeFor: (projectId: string, rootPath: string, isActive: () => boolean, conversationId: string) => ProjectRuntime`
  - `agent:events` 送 `{ conversationId, events }`;`session:state` 送 `{ conversationId, state }`;`agent:approval:ask` 帶 `projectId` 與 `conversationId`
  - `ProjectView.pendingTabIds`、`busyTabIds` 有真值;`pendingApproval = pendingTabIds.length > 0`

- [ ] **Step 1: 改測試 rig**

`tests/ipc-bridge.test.ts`:

- `runtimeFor: (projectId, rootPath, _isActive, conversationId)`:`byOptions.set(sessionOptions, conversationId)`;`aborts.push(\`${conversationId}:${reason}\`)`;`dispose: () => { log.push(\`${conversationId}.runtime.dispose\`) }`。
- `createConversation`:`const tag = byOptions.get(deps.sessionOptions) ?? 'unknown'`,`makeFakeCore(tag, …)`,`fakes.set(tag, fake)`,`created.push(tag)`。
- `fake(id)` 的錯誤訊息改「對話 ${id} 還沒建 core」。
- 既有斷言全部從專案 id 改成對話分頁 id:`'proj-a.'` → `'tab-a.'`、`'proj-b.'` → `'tab-b.'`、`rig.fake(A)` → `rig.fake('tab-a')`、`rig.fake(B)` → `rig.fake('tab-b')`、`rig.fakes.has(B)` → `rig.fakes.has('tab-b')`、`rig.created` 的期望同樣改;`aborts` 的期望 `'proj-a:瀏覽器正由前景專案使用'` → `'tab-a:瀏覽器正由前景專案使用'`。
- `'啟動只為 active 專案建 core…'` 裡的 `link` 常數改成版本 2 欄位(Task 1 已做的話略過)。
- 檢查 `agent:events`/`session:state` payload 的斷言(若有 `lastSent.get(IPC.eventsBatch)` 之類)改成 `{ conversationId: 'tab-a', events: … }`;`approval:ask` 的期望加 `conversationId: 'tab-a'`。

新增:

```ts
describe('多個對話分頁', () => {
  const withSecond = (): ProjectsState =>
    openConversationTab(twoProjects(), A, { tabId: 'tab-a2', threadId: 'th-a2' }, NOW + 1)

  it('啟動時前景是 active 專案最近聚焦的對話分頁;只建那一個 core', () => {
    const rig = makeRig(withSecond())
    expect(rig.log).toEqual(['tab-a2.activate'])
    expect(rig.fakes.has('tab-a')).toBe(false)
  })

  it('同專案切分頁:舊對話 deactivate、view tools 收 browserBusy、新對話 activate;先推 projects:state', () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    expect(rig.log).toEqual(['tab-a2.activate', 'tab-a2.deactivate', 'tab-a.activate'])
    expect(rig.timeline.slice(-3)).toEqual([IPC.projectsState, 'tab-a2.deactivate', 'tab-a.activate'])
    expect(rig.aborts).toEqual(['tab-a2:瀏覽器正由前景專案使用'])
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
    expect(rig.log).toEqual(['tab-a2.dispose', 'tab-a.activate', 'tab-a2.runtime.dispose'])
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

  it('view 的 pendingTabIds 與 busyTabIds 依對話分頁;pendingApproval 是任一', () => {
    const rig = makeRig(withSecond())
    rig.service.update((s) => focusTab(s, A, 'tab-a', NOW + 2))
    rig.fake('tab-a2').setHeld(1)
    rig.fake('tab-a2').deps.onHeldChange?.(1)
    rig.fake('tab-a').setBusy(true)
    const a = rig.view().projects.find((p) => p.id === A)!
    expect(a.pendingTabIds).toEqual(['tab-a2'])
    expect(a.busyTabIds).toEqual(['tab-a'])
    expect(a.pendingApproval).toBe(true)
    rig.fake('tab-a2').setHeld(0)
    rig.fake('tab-a2').deps.onHeldChange?.(0)
    expect(rig.view().projects.find((p) => p.id === A)!.pendingApproval).toBe(false)
  })

  it('sink 的 events 與 state 都不吵:背景對話的 core 自己不送,router 不擋', () => {
    // core 在 deactivate 後不會呼叫 sink(conversation.ts 的 emit 守衛);router 只負責補 conversationId。
    const rig = makeRig(withSecond())
    rig.fake('tab-a2').deps.sink.events([{ kind: 'user-text', text: 'x' }])
    expect(rig.sent.filter((c) => c === IPC.eventsBatch)).toHaveLength(1)
  })
})
```

import 加 `closeTab, conversationTabs, currentThread, focusTab, lastSessionId, openConversationTab, openTab`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: FAIL(rig 的 `conversationId` 參數是 undefined、payload 形狀不符等)

- [ ] **Step 3: 重寫 ipc-bridge.ts 的 slot 管理**

`src/main/ipc-bridge.ts`:

import 換成:

```ts
import {
  activeConversationId,
  activeTabId,
  conversationTabs,
  currentThread,
  findProject,
  findProjectByTab,
  foregroundConversationId,
  lastSessionId,
  pointConversationAt,
  recordSession,
  startThread,
} from './projects-state.js'
```

`IpcBridgeDeps.runtimeFor` 改成:

```ts
  /** 每個對話分頁呼叫一次(D2)。`isActive` 是「這個對話是前景」;`conversationId` 供 log 與測試識別。 */
  readonly runtimeFor: (projectId: string, rootPath: string, isActive: () => boolean, conversationId: string) => ProjectRuntime
```

`Slot`:

```ts
interface Slot {
  readonly core: Conversation
  readonly runtime: ProjectRuntime
  readonly projectId: string
  /** 建 core 時的 rootPath;之後被重新指定就整個 core 重建。 */
  readonly rootPath: string
}
```

檔案主體從 `const slots = new Map` 到 `unsubscribe` 結束這段換成(`contents`、`sendOrThrow`、`sendBestEffort`、`linkFor` 不動):

```ts
  /** 鍵是 conversationId(= TabEntry.id)。 */
  const slots = new Map<string, Slot>()
  /** 前景對話的 conversationId。 */
  let currentId: string | null = null
  let disposed = false

  // ---- 專案狀態 → renderer ----

  const tabIdsWhere = (p: ProjectEntry, pick: (core: Conversation) => boolean): readonly string[] =>
    conversationTabs(p)
      .filter((t) => {
        const slot = slots.get(t.id)
        return slot !== undefined && pick(slot.core)
      })
      .map((t) => t.id)

  const composeView = (): ProjectsView => {
    const state = deps.projects.state()
    return {
      activeId: state.activeId,
      projects: state.projects.map((p) => {
        const pendingTabIds = tabIdsWhere(p, (core) => core.heldApprovals() > 0)
        return {
          id: p.id,
          name: p.name,
          rootPath: p.rootPath,
          available: deps.projects.isAvailable(p.id),
          pendingApproval: pendingTabIds.length > 0,
          pendingTabIds,
          busyTabIds: tabIdsWhere(p, (core) => core.isBusy()),
          tabs: p.tabs,
          activeTabId: activeTabId(p),
          threads: p.threads,
        }
      }),
    }
  }

  const pushProjects = (): void => {
    sendBestEffort(IPC.projectsState, composeView())
  }

  // ---- thread 記錄 ----

  const recordStarted = (conversationId: string, projectId: string, sessionId: string, cwd: string | undefined): void => {
    deps.projects.update((state) => {
      const entry = findProject(state, projectId)
      const thread = entry === undefined ? undefined : currentThread(entry, conversationId)
      if (entry === undefined || thread === undefined) return state
      return recordSession(state, projectId, thread.id, linkFor(entry.rootPath, sessionId, cwd))
    })
  }

  // ---- 每個對話分頁一份 core ----

  const createSlot = (conversationId: string, projectId: string, rootPath: string): Slot => {
    const runtime = deps.runtimeFor(projectId, rootPath, () => currentId === conversationId, conversationId)
    const entry = findProject(deps.projects.state(), projectId)
    const make = deps.createConversation ?? defaultCreateConversation
    const core = make({
      sink: {
        // conversationId 與 projectId 在這裡補:core 不知道自己是誰,router 知道。
        events: (events: readonly Event[]) => {
          const payload: EventsBatchPayload = { conversationId, events }
          sendBestEffort(IPC.eventsBatch, payload)
        },
        state: (state: SessionState) => {
          const payload: SessionStatePayload = { conversationId, state }
          sendBestEffort(IPC.sessionState, payload)
        },
        approvalAsk: (request) => {
          const payload: ApprovalAskPayload = { ...request, projectId, conversationId }
          sendOrThrow(IPC.approvalAsk, payload)
        },
        approvalSettled: (requestId) => sendBestEffort(IPC.approvalSettled, { requestId }),
      },
      sessionOptions: runtime.sessionOptions,
      loadHistory: (sessionId) => deps.sessions.loadHistory(sessionId),
      logError: deps.logError,
      onSessionStarted: (sessionId, cwd) => recordStarted(conversationId, projectId, sessionId, cwd),
      onHeldChange: pushProjects,
      onBusyChange: pushProjects,
      initialSessionId: entry === undefined ? undefined : lastSessionId(entry, conversationId),
      viewTools: runtime.viewTools,
      queryFn: deps.queryFn,
      approvalTimeoutMs: deps.approvalTimeoutMs,
      createHost: deps.createHost,
      createRegistry: deps.createRegistry,
    })
    return { core, runtime, projectId, rootPath }
  }

  const slotFor = (conversationId: string): Slot | undefined => {
    const existing = slots.get(conversationId)
    if (existing !== undefined) return existing
    const owner = findProjectByTab(deps.projects.state(), conversationId)
    if (owner === undefined) {
      // 規格 §5:狀態檔裡的分頁指到不存在的東西,記錯誤,不建 core。
      deps.logError(new Error(`找不到對話分頁 ${conversationId} 所屬的專案`))
      return undefined
    }
    const created = createSlot(conversationId, owner.id, owner.rootPath)
    slots.set(conversationId, created)
    return created
  }

  const activeSlot = (): Slot | undefined => (currentId === null ? undefined : slotFor(currentId))

  /** 規格 §3:舊對話退到背景(回合跑完才 sleep),進行中的瀏覽器工具呼叫收到明確錯誤。專案切換與同專案切分頁都走這裡。 */
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

  /**
   * 收掉一個 slot。runtime 一定等 core 收完才拆:`Conversation.dispose()` 是真的非同步,
   * 它排進 pending 鏈的 window-closed effects 還會用到 `viewTools.abortPending` 與
   * host 的 interrupt／teardown,先拆 runtime 等於把它們從底下抽掉(規則 9)。
   * core 收尾失敗只記錯,runtime 照樣拆掉,不把每對話的資源留在原地。
   */
  const closeSlot = async (conversationId: string, slot: Slot): Promise<void> => {
    try {
      await slot.core.dispose()
    } catch (err) {
      deps.logError(asError(err, `dispose(${conversationId})`))
    } finally {
      slot.runtime.dispose?.()
    }
  }

  const disposeSlot = (conversationId: string, slot: Slot): void => {
    slots.delete(conversationId)
    closeSlot(conversationId, slot).catch((err: unknown) => deps.logError(asError(err, `dispose(${conversationId})`)))
  }

  /** 這個 slot 綁的專案、資料夾、分頁還在不在。 */
  const slotStillValid = (state: ProjectsState, conversationId: string, slot: Slot): boolean => {
    const after = findProject(state, slot.projectId)
    return after !== undefined && after.rootPath === slot.rootPath && after.tabs.some((t) => t.id === conversationId)
  }

  const unsubscribe = deps.projects.subscribe((next) => {
    // 專案被移除、資料夾被重新指定(規格 §6)、對話分頁被關閉(D2 規格 §3):這個 core 已經不該存在,先收掉。
    // 關掉的若是前景對話,不另外 deactivate:core.dispose() 自己走收尾(deny-all、interrupt/teardown),
    // 下面 switchTo 找不到它就只 activate 新前景。順序與 D 相同。
    for (const [conversationId, slot] of [...slots]) {
      if (!slotStillValid(next, conversationId, slot)) disposeSlot(conversationId, slot)
    }
    const nextId = foregroundConversationId(next)
    if (nextId !== currentId) {
      // 規則 2:先讓 renderer 知道前景換了,它才能在新對話的批准卡送到之前換過濾條件。
      pushProjects()
      switchTo(nextId)
      return
    }
    if (nextId !== null && !slots.has(nextId)) activeSlot()?.core.activate()
    pushProjects()
  })
```

`withActive` 改成:

```ts
  const withActive = (channel: string, fn: (slot: Slot, conversationId: string) => void): void => {
    const slot = activeSlot()
    if (slot === undefined || currentId === null) {
      deps.logError(new Error(`${channel}：沒有前景對話，已丟棄`))
      return
    }
    fn(slot, currentId)
  }
```

`onIntentStartNew` 與 `onIntentOpenHistory` 的內層:

```ts
      withActive(IPC.intentStartNew, (slot, conversationId) => {
        deps.projects.update((state) =>
          startThread(state, slot.projectId, conversationId, deps.projects.newId(), deps.projects.now()),
        )
        slot.core.startNew()
      })
```

```ts
      withActive(IPC.intentOpenHistory, (slot, conversationId) => {
        const link = linkFor(slot.rootPath, payload.sessionId, deps.sessions.cwdOf(payload.sessionId))
        deps.projects.update((state) =>
          pointConversationAt(state, slot.projectId, conversationId, link, deps.projects.newId(), deps.projects.now()),
        )
        slot.core.openHistory(payload.sessionId)
      })
```

檔尾 `switchTo(deps.projects.state().activeId)` 改成 `switchTo(foregroundConversationId(deps.projects.state()))`。

型別 import 補 `EventsBatchPayload`、`SessionStatePayload`(自 `../shared/ipc.js`)與 `ProjectEntry`、`ProjectsState`(自 `../shared/projects.js`);`activeConversationId` 若沒用到就從 import 拿掉。

關於 subscribe 的順序:沿用 D,先 dispose 失效的 slot 再切前景。「關掉前景對話分頁」時舊 core 走 `dispose`(它自己 deny-all、interrupt/teardown),`switchTo` 找不到它就只 activate 新前景;既有 D 測試的順序期望(移除 active 專案 → dispose、activate、runtime.dispose;切換 → timeline 末三筆 projectsState、deactivate、activate)因此一字不改。

- [ ] **Step 4: 改 index.ts**

`src/main/index.ts` 的 `runtimeFor` 簽名加第四個參數 `_conversationId: string`(不使用)。

- [ ] **Step 5: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npm test`
Expected: 全部 PASS。既有的 D 測試改完 tag 之後應該全綠;紅的逐一看是 tag 沒改到還是順序真的變了(順序變了要回頭看 Step 3 的 subscribe)。

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-bridge.ts src/main/index.ts tests/ipc-bridge.test.ts
git commit -m "feat: 主行程每個對話分頁一個 conversation core"
```

---

### Task 6: renderer 每個對話分頁一份 ConversationPane

**Files:**
- Create: `src/renderer/components/ConversationPane.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/LeftPane.tsx`
- Test: `tests/conversation-pane.test.tsx`(新)、`tests/left-pane.test.tsx`、`tests/use-conversation.test.tsx`(其中 render `App` 的測試)

**Interfaces:**
- Consumes: Task 2 的 `useConversation(api, conversationId)`、`useApprovals(api, conversationId)`、`useSessions(api, refresh, scope, conversationId)`、`foregroundConversationId`。
- Produces:
  - `ConversationPane({ api, projects, projectId, conversationId })`
  - `LeftPaneProps.renderConversation: (projectId: string, conversationId: string) => React.ReactNode`(取代 `conversation: React.ReactNode`)

- [ ] **Step 1: 寫失敗測試**

`tests/conversation-pane.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ConversationPane } from '../src/renderer/components/ConversationPane.js'
import { createFakeYesChef, fakeProjects, ONE_PROJECT } from './helpers/fake-yeschef.js'

afterEach(cleanup)

describe('ConversationPane', () => {
  it('兩個 pane 各只收自己 conversationId 的事件', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    render(
      <>
        <div data-testid="pane-1">
          <ConversationPane api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" />
        </div>
        <div data-testid="pane-2">
          <ConversationPane api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv2" />
        </div>
      </>
    )
    fake.emitEvents([{ kind: 'user-text', text: '給一號的' }], 'p-1-conv')
    fake.emitEvents([{ kind: 'user-text', text: '給二號的' }], 'p-1-conv2')
    expect(screen.getByTestId('pane-1').textContent).toContain('給一號的')
    expect(screen.getByTestId('pane-1').textContent).not.toContain('給二號的')
    expect(screen.getByTestId('pane-2').textContent).toContain('給二號的')
    expect(screen.getByTestId('pane-2').textContent).not.toContain('給一號的')
  })

  it('批准卡只出現在自己的 pane,輸入框只在那個 pane 停用', () => {
    const fake = createFakeYesChef({ projects: ONE_PROJECT })
    const { projects } = fakeProjects(ONE_PROJECT)
    render(
      <>
        <div data-testid="pane-1">
          <ConversationPane api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv" />
        </div>
        <div data-testid="pane-2">
          <ConversationPane api={fake.api} projects={projects} projectId="p-1" conversationId="p-1-conv2" />
        </div>
      </>
    )
    fake.emitAsk({ requestId: 'r1', projectId: 'p-1', conversationId: 'p-1-conv2', toolUseId: 't1', toolName: 'Bash', input: { command: 'rm x' } })
    const inputs = screen.getAllByLabelText('輸入訊息') as HTMLTextAreaElement[]
    expect(inputs[0]?.disabled).toBe(false)
    expect(inputs[1]?.disabled).toBe(true)
    expect(screen.getByTestId('pane-2').querySelector('.approval-tail, .approval-card')).not.toBeNull()
    expect(screen.getByTestId('pane-1').querySelector('.approval-tail, .approval-card')).toBeNull()
  })
})
```

(`ApprovalCard` 的根 class 以 `src/renderer/components/ApprovalCard.tsx` 實際的為準;對應不到 block 的請求畫在 `.approval-tail` 裡,這裡兩個都查。)

`tests/left-pane.test.tsx`:所有 `conversation={conv}` 改成 `renderConversation={(pid, cid) => <div data-testid="conv">{`${pid}/${cid}`}</div>}`。兩條舊斷言描述的是單 pane 模型,改成新行為:「沒有專案」那條改成對話 pane 不掛載(`expect(screen.queryByTestId('conv')).toBeNull()`);「切換 A→B」那條改用帶 id 的 render 函式,切換後 A、B 兩個 pane 都掛載,B 的 slot 不 hidden、A 的 hidden。其餘既有斷言在單一專案、單一對話分頁的 fixture 下仍成立。新增:

```tsx
describe('LeftPane 對話分頁', () => {
  const twoConvs = projectView('a', {
    tabs: [
      { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'a-th', provider: 'claude' },
      { id: 'a-conv2', contentType: 'conversation', label: 'Claude 對話 2', customLabel: null, sortOrder: 1, lastFocusedAt: 2, threadId: 'a-th2', provider: 'claude' },
    ],
    activeTabId: 'a-conv2',
  })
  const renderConv = (pid: string, cid: string) => <div data-testid={`conv-${cid}`}>{`${pid}/${cid}`}</div>

  it('只掛載曾經前景過的對話分頁;切換後兩個都在,只有前景的不 hidden', () => {
    const view: ProjectsView = { activeId: 'a', projects: [twoConvs] }
    const { rerender } = render(<LeftPane projects={fakeProjects(view).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(screen.getByTestId('conv-a-conv2')).toBeTruthy()
    expect(screen.queryByTestId('conv-a-conv')).toBeNull()

    const switched: ProjectsView = {
      activeId: 'a',
      projects: [{ ...twoConvs, activeTabId: 'a-conv', tabs: twoConvs.tabs.map((t) => (t.id === 'a-conv' ? { ...t, lastFocusedAt: 3 } : t)) }],
    }
    rerender(<LeftPane projects={fakeProjects(switched).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(slotOf(screen.getByTestId('conv-a-conv')).hidden).toBe(false)
    expect(slotOf(screen.getByTestId('conv-a-conv2')).hidden).toBe(true)
  })

  it('關掉的對話分頁卸載', () => {
    const view: ProjectsView = { activeId: 'a', projects: [twoConvs] }
    const { rerender } = render(<LeftPane projects={fakeProjects(view).projects} renderConversation={renderConv} endpoint={WS} />)
    const closed: ProjectsView = { activeId: 'a', projects: [{ ...twoConvs, activeTabId: 'a-conv', tabs: twoConvs.tabs.slice(0, 1) }] }
    rerender(<LeftPane projects={fakeProjects(closed).projects} renderConversation={renderConv} endpoint={WS} />)
    expect(screen.queryByTestId('conv-a-conv2')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/conversation-pane.test.tsx tests/left-pane.test.tsx`
Expected: FAIL,找不到 `ConversationPane` 模組、`renderConversation` 不是合法 prop

- [ ] **Step 3: 寫 ConversationPane**

`src/renderer/components/ConversationPane.tsx`(從 `App.tsx` 搬 `Composer`、`placeholderFor`、hooks 與 `conversation` 那段 JSX 過來):

```tsx
import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Conversation, type ToolBlock } from './Conversation.js'
import { ApprovalCard } from './ApprovalCard.js'
import { HandoffCard } from './HandoffCard.js'
import { Recents, type SessionScope } from './Recents.js'
import { useConversation } from '../hooks/useConversation.js'
import { useApprovals } from '../hooks/useApprovals.js'
import { useSessions } from '../hooks/useSessions.js'
import type { Projects } from '../hooks/useProjects.js'
import { applyPendingApprovals, findAskForBlock, openAsks, unmatchedAsks } from '../approvals.js'
import type { YesChefApi } from '../../shared/ipc.js'
import type { SessionState } from '../../shared/session-state.js'
import { REQUEST_HANDOFF_TOOL } from '../../shared/view-tools.js'

export const VIEWING_PLACEHOLDER = '輸入以接續這條對話'
export const LIVE_PLACEHOLDER = '輸入訊息，Enter 送出，Shift+Enter 換行'

interface ComposerProps {
  readonly placeholder: string
  readonly onSend: (text: string) => void
  /** 有待決的批准請求時停用(規格 §6)。 */
  readonly disabled?: boolean
}

function Composer({ placeholder, onSend, disabled = false }: ComposerProps) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed === '') return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        className="composer-input"
        aria-label="輸入訊息"
        rows={3}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="composer-send" disabled={disabled}>
        送出
      </button>
    </form>
  )
}

function placeholderFor(state: SessionState): string {
  return state.kind === 'viewing' ? VIEWING_PLACEHOLDER : LIVE_PLACEHOLDER
}

export interface ConversationPaneProps {
  readonly api: YesChefApi
  readonly projects: Projects
  readonly projectId: string
  readonly conversationId: string
}

/**
 * 一個對話分頁的完整畫面(D2 規格 §4):Recents 側欄、對話、批准卡、輸入框。
 * 每個掛載中的對話分頁一份,三個 hook 都只收自己 `conversationId` 的東西。
 *
 * 批准的四個插入點沿用 A/B 的設計(原本在 App.tsx,註解一併搬過來):
 * 1. `applyPendingApprovals`:把命中的 tool block 標成 awaiting-approval
 * 2. `renderToolExtra`:把卡片畫進對應的 ToolCall 底部
 * 3. `unmatchedAsks`:對應不到 block 的請求畫在對話尾端,不靜默丟棄
 * 4. `Composer` 的 `disabled`:有待決請求時輸入框停用
 * 四點全部吃 `openAsks(rawView, pending)` 算出來的 `active`,不是 `useApprovals` 原始的 `pending`:
 * 批准逾時是主程序自己 deny 掉的,`active` 只留下 block 還開著的那些,了結的請求不再擋輸入框。
 *
 * 第 2 點的命中查找一定要走 `findAskForBlock`,不能在這裡重寫一次比對。
 *
 * `Composer` 送到 `api.sendInput`,主行程送給前景對話;能看見這個 pane 的時候它就是前景,兩邊一致。
 */
export function ConversationPane({ api, projects, projectId, conversationId }: ConversationPaneProps) {
  const { view: rawView, sessionState, turnEnds } = useConversation(api, conversationId)
  const { pending, reply } = useApprovals(api, conversationId)
  // Recents 的範圍(規格 §3.2):預設本專案,使用者可切成全部;切對話不重設(每個 pane 自己記)。
  const [scope, setScope] = useState<SessionScope>('project')
  const listScope = useMemo(() => ({ projectId: scope === 'all' ? null : projectId }), [scope, projectId])
  const project = useMemo(() => projects.view.projects.find((p) => p.id === projectId), [projects.view, projectId])
  const threads = useMemo(
    () => (scope === 'all' ? projects.view.projects.flatMap((p) => p.threads) : (project?.threads ?? [])),
    [scope, projects.view, project]
  )
  const { sessions, current, error } = useSessions(api, turnEnds, listScope, conversationId)

  const active = useMemo(() => openAsks(rawView, pending), [rawView, pending])
  const view = useMemo(() => applyPendingApprovals(rawView, active), [rawView, active])
  const orphans = useMemo(() => unmatchedAsks(view, active), [view, active])

  const renderToolExtra = useCallback(
    (block: ToolBlock) => {
      const ask = findAskForBlock(block, active)
      return ask === undefined ? null : <ApprovalCard ask={ask} onDecide={reply} />
    },
    [active, reply]
  )

  const renderToolOverride = useCallback(
    (block: ToolBlock, historical: boolean) =>
      block.name === REQUEST_HANDOFF_TOOL ? (
        <HandoffCard block={block} historical={historical} onDone={api.handoffDone} />
      ) : undefined,
    [api]
  )

  return (
    <>
      <aside className="sidebar">
        <Recents
          sessions={sessions}
          current={current}
          error={error}
          threads={threads}
          scope={scope}
          onScopeChange={project === undefined ? undefined : setScope}
          onOpen={api.openHistory}
          onStartNew={api.startNew}
        />
      </aside>
      <main className="conversation">
        <Conversation
          view={view}
          historical={sessionState.kind === 'viewing'}
          renderToolExtra={renderToolExtra}
          renderToolOverride={renderToolOverride}
        />
        {orphans.length > 0 ? (
          <div className="approval-tail">
            {orphans.map((ask) => (
              <ApprovalCard key={ask.requestId} ask={ask} onDecide={reply} unmatched />
            ))}
          </div>
        ) : null}
        <Composer
          placeholder={placeholderFor(sessionState)}
          onSend={(text) => api.sendInput(text)}
          disabled={active.length > 0}
        />
      </main>
    </>
  )
}
```

- [ ] **Step 4: 改 App.tsx**

`src/renderer/App.tsx` 整檔換成:

```tsx
import { useEffect, useState } from 'react'
import { ConversationPane } from './components/ConversationPane.js'
import { titleFor } from './title.js'
import { LeftPane } from './components/LeftPane.js'
import { ProjectBar } from './components/ProjectBar.js'
import { useProjects } from './hooks/useProjects.js'
import './App.css'

export { LIVE_PLACEHOLDER, VIEWING_PLACEHOLDER } from './components/ConversationPane.js'

/**
 * 「左＋中」這一個 React renderer(規格 §3,裁決 9)。右窗格是獨立的
 * WebContentsView,由主程序疊在視窗上,不在這棵 tree 裡。
 *
 * 專案(子專案 D):`useProjects` 是唯一的專案狀態來源,標題列、`ProjectBar`、
 * `LeftPane` 都吃它。`projects.loaded` 為 false 時不畫 `LeftPane`,避免啟動時先閃一下「加入專案開始使用」。
 *
 * 對話(D2):每個對話分頁一份 `ConversationPane`,由 `LeftPane` 決定哪些掛載、哪個可見;
 * 對話、批准、Recents 的狀態都在 pane 裡,App 不再持有。
 */
export function App() {
  const api = window.yeschef
  const projects = useProjects(api)
  const [endpoint, setEndpoint] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.resolve(api.terminalEndpoint()).then(
      (result) => {
        if (alive && result !== undefined) setEndpoint(`ws://127.0.0.1:${result.port}`)
      },
      (err: unknown) => console.error('[yeschef] 取終端機 port 失敗', err)
    )
    return () => {
      alive = false
    }
  }, [api])

  return (
    <div className="app">
      <header className="title-bar">{titleFor(projects.active)}</header>
      <ProjectBar projects={projects} />
      {projects.loaded ? (
        <LeftPane
          projects={projects}
          endpoint={endpoint}
          renderConversation={(projectId, conversationId) => (
            <ConversationPane api={api} projects={projects} projectId={projectId} conversationId={conversationId} />
          )}
        />
      ) : null}
    </div>
  )
}
```

`src/renderer/foreground.ts` 不再被 App 用到;LeftPane 會用(下一步)。

- [ ] **Step 5: 改 LeftPane**

`src/renderer/components/LeftPane.tsx`:

```tsx
export interface LeftPaneProps {
  readonly projects: Projects
  /** 每個要掛載的對話分頁呼叫一次;回傳的節點放進那個分頁的 slot(D2)。 */
  readonly renderConversation: (projectId: string, conversationId: string) => React.ReactNode
  readonly endpoint: string | null
}
```

`useSeen` 保持不變(泛用:給一個「現在的 id」與「已知 id 清單」)。`LeftPane` 本體:

```tsx
export function LeftPane({ projects, renderConversation, endpoint }: LeftPaneProps): React.ReactElement {
  const { view, active } = projects
  const seenProjects = useSeen(view.activeId, view.projects.map((p) => p.id))
  // 對話分頁比照終端分頁(D2 規格 §4):曾經前景過的都常駐掛載,用 hidden 切換,切走不卸載才不會丟串流中的畫面。
  const foreground = foregroundConversationId(active)
  const knownConversations = view.projects.flatMap((p) => p.tabs.filter((t) => t.contentType === 'conversation').map((t) => t.id))
  const seenConversations = useSeen(foreground, knownConversations)
  const usable = active !== undefined && active.available

  const visible = (p: ProjectView, tab: TabEntry): boolean =>
    usable && p.id === view.activeId && tab.id === p.activeTabId

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
        {/* slot 的排列順序看不見(同時只有一個不 hidden),所以用 `tabs` 原本的順序,
            不跟著 `sortOrder` 走:重排分頁時不必連帶搬動掛著 xterm 的那個節點。 */}
        {view.projects.flatMap((p) =>
          p.tabs
            .filter((tab) => tab.contentType === 'conversation' && seenConversations.includes(tab.id))
            .map((tab) => (
              <div key={tab.id} className="pane-slot pane-slot-conversation" hidden={!visible(p, tab)}>
                {renderConversation(p.id, tab.id)}
              </div>
            ))
        )}
        {view.projects
          .filter((p) => seenProjects.includes(p.id))
          .flatMap((p) =>
            p.tabs
              .filter((tab) => tab.contentType === 'terminal')
              .map((tab) => (
                <div key={tab.id} className="pane-slot" hidden={!visible(p, tab)}>
                  {endpoint === null ? (
                    <div className="term-loading">終端機連線中</div>
                  ) : (
                    <Terminal endpoint={endpoint} projectId={p.id} tabId={tab.id} command={tab.command} />
                  )}
                </div>
              ))
          )}
      </div>
    </div>
  )
}
```

import 加 `import { foregroundConversationId } from '../foreground.js'`。既有 `.pane-slot` 的樣式若是 flex 容器給對話用(側欄加主區),對話 slot 沿用同一個 class;`pane-slot-conversation` 只是標記,`LeftPane.css` 不必加規則,除非原本 `.pane-slot > .sidebar` 之類的選擇器依賴「對話 slot 是第一個子節點」,那就把選擇器改成 `.pane-slot-conversation`。

- [ ] **Step 6: 修既有的 App 測試**

`tests/use-conversation.test.tsx` 裡 render `App` 的測試:`import { App, LIVE_PLACEHOLDER, VIEWING_PLACEHOLDER } from '../src/renderer/App.js'` 維持可用(App.tsx 有 re-export)。這些測試靠 `ONE_PROJECT`(對話分頁 `p-1-conv`)與 helper 的預設 `conversationId`,應該不必改斷言。`tests/app-title-bar.test.tsx`、`tests/recents.test.tsx`、`tests/approval-card.test.tsx` 若 render `App`,同樣。紅的先看是不是 helper 的 `conversationId` 預設值與 `ONE_PROJECT` 對不上。

- [ ] **Step 7: 全部跑綠**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/ConversationPane.tsx src/renderer/App.tsx src/renderer/components/LeftPane.tsx tests/conversation-pane.test.tsx tests/left-pane.test.tsx tests/use-conversation.test.tsx
git commit -m "feat: renderer 每個對話分頁一份 ConversationPane"
```

---

### Task 7: 分頁列:新對話、關閉對話分頁、待批准記號

**Files:**
- Modify: `src/renderer/components/LeftPane.tsx`(`TabStrip`)
- Modify: `src/renderer/components/LeftPane.css`
- Test: `tests/left-pane.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `Projects.openConversation()`;Task 1/5 的 `ProjectView.pendingTabIds`、`busyTabIds`。
- Produces:
  - `LeftPaneProps.confirmClose?: (message: string) => boolean`(預設 `window.confirm`;測試注入)
  - 常數 `NEW_CONVERSATION_LABEL = '新對話'`、`LAST_CONVERSATION_HINT = '至少留一個對話'`、`CLOSE_BUSY_CONFIRM = '回合進行中，確定關閉？'`(export 自 `LeftPane.tsx`)

- [ ] **Step 1: 寫失敗測試**

`tests/left-pane.test.tsx` import 加 `NEW_CONVERSATION_LABEL, LAST_CONVERSATION_HINT, CLOSE_BUSY_CONFIRM`。新增:

```tsx
describe('LeftPane 分頁列的對話分頁', () => {
  const two = projectView('a', {
    tabs: [
      { id: 'a-conv', contentType: 'conversation', label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 2, threadId: 'a-th', provider: 'claude' },
      { id: 'a-conv2', contentType: 'conversation', label: 'Claude 對話 2', customLabel: null, sortOrder: 1, lastFocusedAt: 1, threadId: 'a-th2', provider: 'claude' },
    ],
    activeTabId: 'a-conv',
  })
  const renderConv = () => <div data-testid="conv" />

  it('「新對話」按鈕呼叫 openConversation', () => {
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    fireEvent.click(screen.getByRole('button', { name: NEW_CONVERSATION_LABEL }))
    expect(calls).toEqual(['openConversation'])
  })

  it('只有一個對話分頁時關閉鈕停用並提示;兩個以上可關', () => {
    const one = fakeProjects({ activeId: 'a', projects: [projectView('a')] })
    const { unmount } = render(<LeftPane projects={one.projects} renderConversation={renderConv} endpoint={WS} />)
    const disabled = screen.getAllByRole('tab')[0]?.querySelector('.tab-close') as HTMLButtonElement | null
    expect(disabled?.disabled).toBe(true)
    expect(disabled?.title).toBe(LAST_CONVERSATION_HINT)
    unmount()

    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [two] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} />)
    const close = screen.getAllByRole('tab')[1]?.querySelector('.tab-close') as HTMLButtonElement
    expect(close.disabled).toBe(false)
    fireEvent.click(close)
    expect(calls).toEqual(['closeTab:a-conv2'])
  })

  it('關回合進行中的對話分頁要先確認;取消就不關', () => {
    const busy = { ...two, busyTabIds: ['a-conv2'] }
    const asked: string[] = []
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [busy] })
    const { rerender } = render(
      <LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} confirmClose={(m) => { asked.push(m); return false }} />
    )
    fireEvent.click(screen.getAllByRole('tab')[1]!.querySelector('.tab-close')!)
    expect(asked).toEqual([CLOSE_BUSY_CONFIRM])
    expect(calls).toEqual([])

    rerender(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} confirmClose={() => true} />)
    fireEvent.click(screen.getAllByRole('tab')[1]!.querySelector('.tab-close')!)
    expect(calls).toEqual(['closeTab:a-conv2'])
  })

  it('不 busy 的對話分頁不問就關', () => {
    const asked: string[] = []
    const { projects, calls } = fakeProjects({ activeId: 'a', projects: [two] })
    render(<LeftPane projects={projects} renderConversation={renderConv} endpoint={WS} confirmClose={(m) => { asked.push(m); return false }} />)
    fireEvent.click(screen.getAllByRole('tab')[1]!.querySelector('.tab-close')!)
    expect(asked).toEqual([])
    expect(calls).toEqual(['closeTab:a-conv2'])
  })

  it('扣著批准的對話分頁亮記號', () => {
    const pending = { ...two, pendingTabIds: ['a-conv2'], pendingApproval: true }
    render(<LeftPane projects={fakeProjects({ activeId: 'a', projects: [pending] }).projects} renderConversation={renderConv} endpoint={WS} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]?.querySelector('.tab-pending')).toBeNull()
    expect(tabs[1]?.querySelector('.tab-pending')?.getAttribute('aria-label')).toBe('有待批准的請求')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/left-pane.test.tsx`
Expected: FAIL,找不到「新對話」按鈕、對話分頁沒有 `.tab-close`

- [ ] **Step 3: 改 TabStrip**

`src/renderer/components/LeftPane.tsx`:

常數(放在 `EMPTY_HINT` 旁):

```ts
export const NEW_CONVERSATION_LABEL = '新對話'
export const LAST_CONVERSATION_HINT = '至少留一個對話'
export const CLOSE_BUSY_CONFIRM = '回合進行中，確定關閉？'
```

`LeftPaneProps` 加:

```ts
  /** 關回合進行中的對話分頁前的確認;預設 `window.confirm`,測試注入。 */
  readonly confirmClose?: (message: string) => boolean
```

`TabStrip` 換成:

```tsx
interface TabStripProps {
  readonly projects: Projects
  readonly active: ProjectView
  readonly confirmClose: (message: string) => boolean
}

function TabStrip({ projects, active, confirmClose }: TabStripProps): React.ReactElement {
  const conversationCount = active.tabs.filter((t) => t.contentType === 'conversation').length

  const closeTab = (tab: TabEntry): void => {
    // 規格 §5:回合進行中先問;取消就不送。終端分頁沒有這個問題。
    if (active.busyTabIds.includes(tab.id) && !confirmClose(CLOSE_BUSY_CONFIRM)) return
    projects.closeTab(tab.id)
  }

  return (
    <div className="tab-strip" role="tablist">
      {sortedTabs(active).map((tab) => {
        const on = tab.id === active.activeTabId
        const lastConversation = tab.contentType === 'conversation' && conversationCount <= 1
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={on}
            className={`tab${on ? ' on' : ''}`}
            onClick={() => projects.activateTab(tab.id)}
          >
            <span>{labelOf(tab)}</span>
            {active.pendingTabIds.includes(tab.id) ? (
              <span className="tab-pending" role="img" aria-label="有待批准的請求" title="有待批准的請求">
                ●
              </span>
            ) : null}
            <button
              type="button"
              className="tab-close"
              aria-label="關閉分頁"
              disabled={lastConversation}
              title={lastConversation ? LAST_CONVERSATION_HINT : undefined}
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <div className="quick-launch">
        <button type="button" className="tab-new-conversation" onClick={() => projects.openConversation()}>
          {NEW_CONVERSATION_LABEL}
        </button>
        {QUICK_LAUNCH.map((quick) => (
          <button key={quick.label} type="button" onClick={() => projects.openTab(quick.label, quick.command)}>
            {quick.label}
          </button>
        ))}
      </div>
    </div>
  )
}
```

`LeftPane` 把 `confirmClose = (message) => window.confirm(message)` 從 props 解構出來(預設值),傳給 `TabStrip`。

既有測試 `'分頁依 sortOrder 排列,對話分頁沒有關閉鈕…'` 的斷言 `expect(tabs[0]?.querySelector('.tab-close')).toBeNull()` 改成 `expect((tabs[0]?.querySelector('.tab-close') as HTMLButtonElement).disabled).toBe(true)`,測試名改成「…唯一的對話分頁關閉鈕停用…」。

- [ ] **Step 4: 樣式**

`src/renderer/components/LeftPane.css` 加:

```css
.tab-pending {
  margin-left: 4px;
  color: #e0b64a;
  font-size: 10px;
}

.tab-close:disabled {
  opacity: 0.3;
  cursor: default;
}
```

(`.tab-pending` 的顏色與 `ProjectBar.css` 的 `.project-pending` 相同。)

- [ ] **Step 5: 全部跑綠與覆蓋率**

Run: `npm run typecheck`
Expected: 0 errors

Run: `npm test`
Expected: 全部 PASS

Run: `npm run test:coverage`
Expected: Stmts ≥ 93、Branch ≥ 86。低於門檻時先看 `projects-migrate.ts`、`ipc-bridge.ts` 的 subscribe 分支與 `LeftPane.tsx` 的 `confirmClose` 分支有沒有測到。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/LeftPane.tsx src/renderer/components/LeftPane.css tests/left-pane.test.tsx
git commit -m "feat: 分頁列支援新對話、關閉對話分頁與分頁層的待批准記號"
```

---

## 實機驗收(計畫執行完之後,由使用者端或本 session 用 CDP 做)

規格 §6 的六項實機驗收不在 codex 的任務範圍。執行完 Task 7 後回報,再依 `docs/RESULTS-09-known-defects.md` 的 CDP 流程做:

| # | 項目 | 通過條件 |
|---|---|---|
| 1 | 同一專案開兩個 Claude 對話,各送一則 | 兩個畫面各只有自己的回覆,`~/.claude/projects` 是兩個不同的 session |
| 2 | A 對話跑長回合,切到 B 對話送訊息,再切回 A | A 的結果完整;B 的畫面沒有 A 的字 |
| 3 | A 對話的批准在背景到達,切到 B 看不到,切回 A 看得到 | 同 RESULTS-08 第 3 項,但分頁層 |
| 4 | 關掉 A 對話,B 照常;關最後一個被拒 | 關閉鈕停用且 title 是「至少留一個對話」 |
| 5 | 版本 1 的狀態檔重開 | 升到版本 2,對話分頁 `provider: 'claude'`,舊 thread 照常接上,`.bak.0` 是版本 1 |
| 6 | 記憶體 | 3 個對話各跑過 1 回合,比單一對話多不超過 150 MB |

## 執行紀錄

2026-09-09 由 codex gpt-6-astra 逐 task 實作、Claude subagent 逐 task 審查。執行中的裁決已回寫到各 task(Task 1 的 composeView 空陣列與 Recents fixture、Task 2 的 import 路徑與 ipc-bridge 過渡值、Task 3 的過渡行、Task 5 的 subscribe 順序與三條測試期望、Task 6 的兩條舊斷言)。codex 的沙箱不能跑 `ps`,`tests/measure-memory.test.ts` 由控制端在沙箱外補跑。

## 自查紀錄

規格逐節對照:

| 規格 | Task |
|---|---|
| §1 對話識別、core 對應、IPC、renderer、前景、分頁列、provider、狀態檔、Recents | 1、2、5、6、7;Recents「開在現行對話分頁」是 Task 5 的 `onIntentOpenHistory` 走前景對話 |
| §2 資料模型 | 1、2 |
| §3 主行程(slots、createSlot、switchTo、subscribe、sink、agent:input;view-tools 每對話一份;projects-state 三條) | 3、4、5 |
| §4 renderer(useConversation、LeftPane 常駐掛載、useApprovals、Composer、分頁列標籤與新對話、待批准記號移到分頁) | 2、6、7 |
| §5 失敗(版本 1 轉換、分頁指到不存在的 thread、關回合進行中的分頁、關最後一個、兩個對話搶右窗格) | 1、5(`slotFor` 記錯誤;thread 不存在時 `lastSessionId` 回 undefined 等於新對話)、7、5 |
| §6 單元測試清單 | 每項都有對應的 it |

已知取捨:
- 「分頁指到不存在的 thread」的畫面提示(規格 §5 第二列)以「那個分頁是空對話」呈現,不另加文案。
- `runtimeFor` 多了第四個參數 `conversationId`,規格 §3 沒寫;只給 log 與測試識別用,`index.ts` 忽略。
