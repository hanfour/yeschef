# 群組頻道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加一種「群組」分頁,人在裡面跟主廚設目標,主廚派工、worker 的進度與卡關都落在同一條訊息流上,`@label` 可以直接跟某個 agent 說話。

**Architecture:** 群組有自己的 `GroupMessage[]`,存成每專案一個 append-only NDJSON,不聚合既有對話的事件,`fold()` 不動。寫入有三個來源:人的 composer、agent 的 `say_to_group` 工具、chef service 在五個時機自動寫的里程碑。只有人的訊息會 deliver 給 agent,走 `IpcBridge` 新增的 `deliverToManaged`,那條路刻意略過主廚的 `guard`。thread 不另外存,每次從主廚的 `ChefTask` 算出來。

**Tech Stack:** Electron 44、TypeScript 7(strict)、React 19、zod 4、vitest 4。

**Spec:** `docs/specs/2026-09-24-group-channel-design.md`

## Global Constraints

- TypeScript strict,既有 eslint 規則,`npm run typecheck` 與 `npm test`(vitest)每個 task 結束都要綠。
- 不新增依賴。
- 程式與註解用台灣繁體中文,不用破折號,粗體一段最多一處;使用者看得到的訊息放在 `src/main/group/messages.ts` 的 `MSG`。
- 檔案 800 行以內,函式 50 行以內(工廠函式外層 closure 不算),不 mutate 既有物件,不用 `console.log`(用 deps 的 `logError`)。
- 群組訊息不進任何 agent 的 context,除非主廚自己用 `task_progress` 查;里程碑與 `say_to_group` 不 deliver 給任何人。
- 主廚的任務流程不能被群組寫入失敗影響(寫入失敗只 `logError`)。
- 既有的 `fold()`、個別對話分頁、peer 機制都不動。
- 新 CSS 只用 `theme.css` 的 token,受 `tests/theme-rules.test.ts` 約束。
- implementer 不 commit(controller 會 commit),但每個 task 最後一步仍寫出 commit 訊息。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/shared/group.ts` | 新增 | 頻道常數、訊息與 thread 的 zod schema、request/response、推播 payload 的 parse |
| `src/main/group/store.ts` | 新增 | NDJSON append-only、讀最後 2000 則、壞行跳過、5 MB 裁半、同專案序列化寫入 |
| `src/main/group/messages.ts` | 新增 | `MSG`、`labelFor`、`roleOf`、`titleOf` |
| `src/main/group/service.ts` | 新增 | `handle`(get / send)、`write`、`recent`、`threadsOf`、推播批次 |
| `src/main/group/ipc.ts` | 新增 | `group:manage` 的 handler,sender 檢查 |
| `src/main/ipc-bridge.ts` | 修改 | 多一個 `deliverToManaged(projectId, conversationId, text)` |
| `src/main/chef/service.ts` | 修改 | 選填 `group` dep、五個里程碑、async `progress` 與 `groupMessages`、`sayToGroup`、`tasksOf`、抽出 `start` |
| `src/main/chef/tools.ts` | 修改 | `say_to_group` 進 `CHEF_TOOL_NAMES`,worker 拿得到 |
| `src/shared/projects.ts` | 修改 | `TabContentType` 加 `group`、`isTabEntry` 放行、`GROUP_TAB_LABEL` |
| `src/main/projects-state.ts` | 修改 | `openGroupTab`,一個專案最多一個 |
| `src/main/projects-ipc.ts` | 修改 | `group:open` 的 handler |
| `src/shared/ipc.ts` | 修改 | `IPC.groupMessages`、`IPC.groupOpen`、`YesChefApi` 三個新成員 |
| `src/preload/bridge.ts` | 修改 | `manageGroup`、`onGroupMessages`、`openGroup` |
| `src/renderer/hooks/useGroup.ts` | 新增 | 初次 `get` 加推播累積 |
| `src/renderer/components/GroupPane.tsx` | 新增 | 三段版面 |
| `src/renderer/components/GroupPane.css` | 新增 | 只用 theme token |
| `src/renderer/components/LeftPane.tsx` | 修改 | 「群組」按鈕與 group slot |
| `src/renderer/App.tsx` | 修改 | 把 `renderGroup` 傳給 `LeftPane` |
| `src/main/index.ts` | 修改 | store、service、ipc、chef 的 group dep 接線 |
| `tests/helpers/fake-yeschef.ts` | 修改 | 假 api 補 `manageGroup`／`onGroupMessages`／`openGroup` |
| `tests/group-schema.test.ts` | 新增 | schema 收與不收 |
| `tests/group-store.test.ts` | 新增 | 追加、壞行、2000、5 MB、併發 |
| `tests/group-labels.test.ts` | 新增 | `MSG` 與 `labelFor` |
| `tests/group-service.test.ts` | 新增 | `@` 解析、deliver 對象、開任務 |
| `tests/group-ipc.test.ts` | 新增 | sender 與 schema |
| `tests/chef-group-milestones.test.ts` | 新增 | 五個時機 |
| `tests/use-group.test.tsx` | 新增 | hook |
| `tests/group-pane.test.tsx` | 新增 | 元件 |
| `tests/ipc-bridge.test.ts` | 修改 | `deliverToManaged` |
| `tests/preload-bridge.test.ts` | 修改 | 三個新成員 |
| `tests/chef-view-tools.test.ts` | 修改 | `say_to_group` 的角色開放 |
| `tests/projects-state.test.ts`、`tests/projects-shared.test.ts`、`tests/projects-ipc.test.ts` | 修改 | `group` 分頁 |
| `tests/left-pane.test.tsx` | 修改 | 群組按鈕與 slot |
| `docs/RESULTS-39-group-channel.md` | 新增 | 驗收結果骨架 |

---

### Task 1: `src/shared/group.ts` 的頻道與 schema

**Files:**
- Create: `src/shared/group.ts`
- Test: `tests/group-schema.test.ts`

**Interfaces:**
- Consumes: `providerSchema`、`isRecord`、`isNonEmptyString`(既有)。
- Produces:

```ts
export const GROUP_CHANNEL = 'group:manage'
export const GENERAL_THREAD_ID = 'general'
export const GROUP_READ_LIMIT = 2000
export const GROUP_PROGRESS_LIMIT = 20
export const GROUP_PROGRESS_TEXT_MAX = 300
export const GROUP_REPORT_TEXT_MAX = 500
export type GroupSender = z.infer<typeof GroupSenderSchema>
export type GroupMessage = z.infer<typeof GroupMessageSchema>
export type GroupParticipant = z.infer<typeof GroupParticipantSchema>
export type GroupThread = z.infer<typeof GroupThreadSchema>
export type GroupRequest = z.infer<typeof GroupRequestSchema>
export type GroupResponse = z.infer<typeof GroupResponseSchema>
export type GroupMessagesPayload = z.infer<typeof GroupMessagesPayloadSchema>
export interface GroupOpenPayload { readonly projectId: string }
export function parseGroupMessagesPayload(raw: unknown): GroupMessagesPayload | null
export function parseGroupOpen(raw: unknown): GroupOpenPayload | null
export function isMilestone(message: GroupMessage): boolean
export const SayToGroupSchema: z.ZodObject<{ text: z.ZodString }>
```

- 注意:zod 4 的 `z.discriminatedUnion(...)` 沒有 `.strict()`,嚴格只能寫在每個成員上。規格 §7 那段示意碼把 `.strict()` 寫在成員上是對的,照抄即可。
- 注意:規格 §3.3 只給了 `GroupThread` 與 `GroupParticipant` 的 TS interface,但 §7 的 `GroupResponseSchema` 用到 `GroupThreadSchema`。這個 task 要把兩者補成 zod schema,型別從 schema 推出來,不另寫一份 interface。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/group-schema.test.ts
import { describe, expect, it } from 'vitest'
import {
  GENERAL_THREAD_ID,
  GROUP_CHANNEL,
  GroupMessageSchema,
  GroupRequestSchema,
  GroupResponseSchema,
  GroupThreadSchema,
  SayToGroupSchema,
  isMilestone,
  parseGroupMessagesPayload,
  parseGroupOpen,
} from '../src/shared/group.js'

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm1', projectId: 'p1', threadId: 't1', at: 1_700_000_000_000,
  from: { kind: 'user' }, kind: 'text', text: '嗨', mentions: [], ...over,
})

describe('群組頻道與訊息', () => {
  it('頻道名與 general 的 id 固定', () => {
    expect(GROUP_CHANNEL).toBe('group:manage')
    expect(GENERAL_THREAD_ID).toBe('general')
  })

  it.each([
    { kind: 'user' },
    { kind: 'system' },
    { kind: 'agent', conversationId: 'c1', label: 'codex-1', provider: 'codex', role: 'worker' },
    { kind: 'agent', conversationId: 'c2', label: '主廚', provider: 'claude', role: 'chef' },
  ])('三種 sender 都收:%j', (from) => {
    expect(GroupMessageSchema.safeParse(message({ from })).success).toBe(true)
  })

  it.each(['text', 'goal', 'delegated', 'progress', 'report', 'blocked', 'joined', 'left'])('八種 kind 都收:%s', (kind) => {
    expect(GroupMessageSchema.safeParse(message({ kind })).success).toBe(true)
  })

  it('unitId 選填,mentions 最多十個', () => {
    expect(GroupMessageSchema.safeParse(message({ unitId: 'u1' })).success).toBe(true)
    expect(GroupMessageSchema.safeParse(message({ mentions: Array.from({ length: 11 }, () => 'a') })).success).toBe(false)
  })

  it.each([
    message({ extra: 1 }),
    message({ at: -1 }),
    message({ at: 1.5 }),
    message({ kind: 'whisper' }),
    message({ from: { kind: 'agent', conversationId: 'c1', label: 'x', provider: 'openai', role: 'worker' } }),
    message({ from: { kind: 'agent', conversationId: 'c1', label: 'x', provider: 'codex' } }),
    message({ text: 'x'.repeat(4001) }),
    message({ projectId: '' }),
  ])('形狀不對不收:%j', (raw) => {
    expect(GroupMessageSchema.safeParse(raw).success).toBe(false)
  })

  it('里程碑是 text 與 goal 以外的 kind', () => {
    expect(isMilestone(GroupMessageSchema.parse(message({ kind: 'joined' })))).toBe(true)
    expect(isMilestone(GroupMessageSchema.parse(message({ kind: 'text' })))).toBe(false)
    expect(isMilestone(GroupMessageSchema.parse(message({ kind: 'goal' })))).toBe(false)
  })
})

describe('thread', () => {
  const thread = { id: 't1', title: '把測試補完', status: 'running', createdAt: 5, participants: [
    { label: '主廚', conversationId: 'c1', provider: 'claude', role: 'chef' },
    { label: 'codex-1', conversationId: 'c2', provider: 'codex', role: 'worker', unitTitle: '實作' },
  ] }
  it('完整的 thread 收得下', () => {
    expect(GroupThreadSchema.safeParse(thread).success).toBe(true)
  })
  it.each(['open', 'queued', 'running', 'stopping', 'completed', 'blocked', 'cancelled'])('七種狀態:%s', (status) => {
    expect(GroupThreadSchema.safeParse({ ...thread, status }).success).toBe(true)
  })
  it('多餘欄位、未知狀態與缺 createdAt 都不收', () => {
    expect(GroupThreadSchema.safeParse({ ...thread, extra: 1 }).success).toBe(false)
    expect(GroupThreadSchema.safeParse({ ...thread, status: 'paused' }).success).toBe(false)
    const { createdAt: _dropped, ...withoutCreatedAt } = thread
    expect(GroupThreadSchema.safeParse(withoutCreatedAt).success).toBe(false)
  })
})

describe('請求與回應', () => {
  it.each([
    { action: 'get', projectId: 'p1' },
    { action: 'send', projectId: 'p1', threadId: 'general', text: '做一份報表' },
  ])('兩種請求都收:%j', (raw) => {
    expect(GroupRequestSchema.safeParse(raw).success).toBe(true)
  })

  it.each([
    { action: 'get', projectId: 'p1', extra: 1 },
    { action: 'send', projectId: 'p1', threadId: 'general', text: '' },
    { action: 'send', projectId: 'p1', threadId: 'general', text: 'x'.repeat(4001) },
    { action: 'send', projectId: 'p1', text: 'hi' },
    { action: 'peek', projectId: 'p1' },
  ])('請求形狀不對不收:%j', (raw) => {
    expect(GroupRequestSchema.safeParse(raw).success).toBe(false)
  })

  it.each([
    { kind: 'state', messages: [message()], threads: [{ id: 'general', title: '未分派', status: 'open', createdAt: 0, participants: [] }] },
    { kind: 'sent', threadId: 't1' },
    { kind: 'error', message: '找不到這個專案' },
  ])('三種回應都收:%j', (raw) => {
    expect(GroupResponseSchema.safeParse(raw).success).toBe(true)
  })

  it('回應多欄位不收', () => {
    expect(GroupResponseSchema.safeParse({ kind: 'sent', threadId: 't1', extra: 1 }).success).toBe(false)
  })
})

describe('推播與開分頁的 payload', () => {
  it('形狀對就回新物件', () => {
    const payload = { projectId: 'p1', messages: [message()], threads: [{ id: 'general', title: '未分派', status: 'open', createdAt: 0, participants: [] }] }
    expect(parseGroupMessagesPayload(payload)?.projectId).toBe('p1')
    expect(parseGroupMessagesPayload(payload)?.messages).toHaveLength(1)
  })
  it.each([null, {}, { projectId: 'p1' }, { projectId: 'p1', messages: [{ id: 'x' }], threads: [] }])('形狀不對回 null:%j', (raw) => {
    expect(parseGroupMessagesPayload(raw)).toBeNull()
  })
  it('開分頁只收 projectId', () => {
    expect(parseGroupOpen({ projectId: 'p1' })).toEqual({ projectId: 'p1' })
    expect(parseGroupOpen({ projectId: 'p1', label: 'x' })).toEqual({ projectId: 'p1' })
    expect(parseGroupOpen({ projectId: '' })).toBeNull()
    expect(parseGroupOpen('p1')).toBeNull()
  })
})

describe('say_to_group 的參數', () => {
  it('一到兩千字之間', () => {
    expect(SayToGroupSchema.safeParse({ text: '我打算先補測試' }).success).toBe(true)
    expect(SayToGroupSchema.safeParse({ text: '' }).success).toBe(false)
    expect(SayToGroupSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false)
    expect(SayToGroupSchema.safeParse({ text: 'ok', extra: 1 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/group-schema.test.ts`
Expected: FAIL,`Cannot find module '../src/shared/group.js'`

- [ ] **Step 3: 寫最小實作**

```ts
// src/shared/group.ts
/**
 * 群組頻道的共用型別(群組規格 §3、§7)。main 與 renderer 都 import,
 * 所以不引入 Electron 與 node 內建模組。
 */
import { z } from 'zod'
import { isNonEmptyString, isRecord } from './ipc.js'
import { providerSchema } from './projects.js'

export const GROUP_CHANNEL = 'group:manage'
/** 還沒變成目標的訊息都掛在這條 thread 上,永遠存在,排在最前面。 */
export const GENERAL_THREAD_ID = 'general'
/** 讀取只取最後這麼多則(規格 §3.2)。 */
export const GROUP_READ_LIMIT = 2000
/** `task_progress` 回傳的群組訊息則數與每則的字數上限(規格 §4.3)。 */
export const GROUP_PROGRESS_LIMIT = 20
export const GROUP_PROGRESS_TEXT_MAX = 300
/** 任務收尾的里程碑只帶摘要的前這麼多字(規格 §4.2)。 */
export const GROUP_REPORT_TEXT_MAX = 500

export const GroupSenderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
  z.object({
    kind: z.literal('agent'),
    conversationId: z.string().min(1),
    label: z.string().min(1).max(40),
    provider: providerSchema,
    role: z.enum(['chef', 'worker']),
  }).strict(),
])
export type GroupSender = z.infer<typeof GroupSenderSchema>

export const GroupMessageKindSchema = z.enum(['text', 'goal', 'delegated', 'progress', 'report', 'blocked', 'joined', 'left'])
export type GroupMessageKind = z.infer<typeof GroupMessageKindSchema>

export const GroupMessageSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  threadId: z.string().min(1),
  at: z.number().int().nonnegative(),
  from: GroupSenderSchema,
  kind: GroupMessageKindSchema,
  text: z.string().max(4000),
  mentions: z.array(z.string().max(40)).max(10),
  unitId: z.string().optional(),
}).strict()
export type GroupMessage = z.infer<typeof GroupMessageSchema>

/** 一般發言以外的都是里程碑,畫面用不同的底色與字級區隔(規格 §8)。 */
export function isMilestone(message: GroupMessage): boolean {
  return message.kind !== 'text' && message.kind !== 'goal'
}

export const GroupParticipantSchema = z.object({
  label: z.string().min(1).max(40),
  conversationId: z.string().min(1),
  provider: providerSchema,
  role: z.enum(['chef', 'worker']),
  unitTitle: z.string().optional(),
}).strict()
export type GroupParticipant = z.infer<typeof GroupParticipantSchema>

export const GroupThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  /** `open` 是 general 專用;其餘與 `ChefTask['status']` 逐字相同。 */
  status: z.enum(['open', 'queued', 'running', 'stopping', 'completed', 'blocked', 'cancelled']),
  /** 對應 `ChefTask.createdAt`;general 固定 0。選「全部」時送訊息要靠它挑最新的進行中目標。 */
  createdAt: z.number().int().nonnegative(),
  participants: z.array(GroupParticipantSchema),
}).strict()
export type GroupThread = z.infer<typeof GroupThreadSchema>

export const GroupRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), projectId: z.string().min(1) }).strict(),
  z.object({
    action: z.literal('send'),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    text: z.string().min(1).max(4000),
  }).strict(),
])
export type GroupRequest = z.infer<typeof GroupRequestSchema>

export const GroupResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), messages: z.array(GroupMessageSchema), threads: z.array(GroupThreadSchema) }).strict(),
  z.object({ kind: z.literal('sent'), threadId: z.string() }).strict(),
  z.object({ kind: z.literal('error'), message: z.string() }).strict(),
])
export type GroupResponse = z.infer<typeof GroupResponseSchema>

/** `group:messages` 的 payload:訊息批次與當下整份 thread 清單(規格 §7)。 */
export const GroupMessagesPayloadSchema = z.object({
  projectId: z.string().min(1),
  messages: z.array(GroupMessageSchema),
  threads: z.array(GroupThreadSchema),
}).strict()
export type GroupMessagesPayload = z.infer<typeof GroupMessagesPayloadSchema>

export function parseGroupMessagesPayload(raw: unknown): GroupMessagesPayload | null {
  const result = GroupMessagesPayloadSchema.safeParse(raw)
  return result.success ? result.data : null
}

/** `group:open` 的 payload:只有專案 id,分頁 id 由主行程產。 */
export interface GroupOpenPayload {
  readonly projectId: string
}

export function parseGroupOpen(raw: unknown): GroupOpenPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId'])) return null
  return { projectId: raw['projectId'] }
}

/** `say_to_group` 的參數(規格 §4.1)。 */
export const SayToGroupSchema = z.object({ text: z.string().min(1).max(2000) }).strict()
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/group-schema.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/group.ts tests/group-schema.test.ts
git commit -m "feat: add group channel shared schema"
```

---

### Task 2: `src/main/group/store.ts` 的 NDJSON 落地

**Files:**
- Create: `src/main/group/store.ts`
- Test: `tests/group-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GroupMessage`、`GroupMessageSchema`、`GROUP_READ_LIMIT`。
- Produces:

```ts
export const GROUP_FILE_MAX_BYTES = 5 * 1024 * 1024
export interface GroupStore {
  append(message: GroupMessage): Promise<void>
  read(projectId: string): Promise<readonly GroupMessage[]>
  dispose(): Promise<void>
}
export function createGroupStore(dir: string, logError: (error: Error) => void): GroupStore
```

- Task 4 的 service 只用這三個方法;`append` 對同一個專案序列化寫入,兩個來源同時追加也不會交錯成壞行。
- `projectId` 會變成檔名,所以含 `/`、`\` 或 `..` 的一律拒絕,避免寫到目錄外。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/group-store.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GROUP_FILE_MAX_BYTES, createGroupStore, type GroupStore } from '../src/main/group/store.js'
import type { GroupMessage } from '../src/shared/group.js'

const roots: string[] = []
const stores: GroupStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const message = (id: string, over: Partial<GroupMessage> = {}): GroupMessage => ({
  id, projectId: 'p1', threadId: 't1', at: 1_700_000_000_000, from: { kind: 'user' },
  kind: 'text', text: `訊息 ${id}`, mentions: [], ...over,
})

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'yeschef-group-'))
  roots.push(root)
  const errors: Error[] = []
  const store = createGroupStore(root, (error) => errors.push(error))
  stores.push(store)
  return { root, errors, store, path: join(root, 'p1.ndjson') }
}

describe('群組訊息的 NDJSON 落地', () => {
  it('追加之後讀得回來,順序是舊到新', async () => {
    const r = await rig()
    await r.store.append(message('a'))
    await r.store.append(message('b'))
    expect((await r.store.read('p1')).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('沒有檔案時回空陣列,不記錯誤', async () => {
    const r = await rig()
    expect(await r.store.read('missing')).toEqual([])
    expect(r.errors).toHaveLength(0)
  })

  it('壞行被跳過,只記一次錯誤', async () => {
    const r = await rig()
    await r.store.append(message('a'))
    await writeFile(r.path, `${JSON.stringify(message('a'))}\n不是 JSON\n{"id":"缺欄位"}\n${JSON.stringify(message('b'))}\n`)
    expect((await r.store.read('p1')).map((m) => m.id)).toEqual(['a', 'b'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.message).toContain('2')
  })

  it('超過 2000 則只回最後 2000', async () => {
    const r = await rig()
    const lines = Array.from({ length: 2100 }, (_, i) => JSON.stringify(message(`m${i}`))).join('\n')
    await writeFile(r.path, `${lines}\n`)
    const read = await r.store.read('p1')
    expect(read).toHaveLength(2000)
    expect(read[0]?.id).toBe('m100')
    expect(read.at(-1)?.id).toBe('m2099')
  })

  it('超過 5 MB 讀取時裁掉前半,留下的舊訊息還在,新訊息接得上', async () => {
    const r = await rig()
    const padded = (id: string) => JSON.stringify(message(id, { text: 'x'.repeat(3000) }))
    const count = Math.ceil(GROUP_FILE_MAX_BYTES / 3100) + 20
    await writeFile(r.path, `${Array.from({ length: count }, (_, i) => padded(`m${i}`)).join('\n')}\n`)
    const read = await r.store.read('p1')
    expect(read.at(-1)?.id).toBe(`m${count - 1}`)
    expect(read.some((m) => m.id === `m${count - 5}`)).toBe(true)
    expect(read.some((m) => m.id === 'm0')).toBe(false)
    expect((await readFile(r.path, 'utf8')).length).toBeLessThan(GROUP_FILE_MAX_BYTES)
    expect(r.errors).toHaveLength(1)
    await r.store.append(message('after'))
    expect((await r.store.read('p1')).at(-1)?.id).toBe('after')
  })

  it('同時追加兩則不會交錯,兩則都完整', async () => {
    const r = await rig()
    await Promise.all([r.store.append(message('a')), r.store.append(message('b'))])
    const text = await readFile(r.path, 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(2)
    expect((await r.store.read('p1')).map((m) => m.id).sort()).toEqual(['a', 'b'])
  })

  it('追加失敗往外拋,呼叫端自己決定怎麼處理', async () => {
    const r = await rig()
    await expect(r.store.append(message('a', { projectId: '../escape' }))).rejects.toThrow('專案代號')
  })

  it('dispose 之後等得到還沒寫完的追加', async () => {
    const r = await rig()
    const pending = r.store.append(message('a'))
    await r.store.dispose()
    await pending
    expect((await createGroupStore(r.root, vi.fn()).read('p1')).map((m) => m.id)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/group-store.test.ts`
Expected: FAIL,`Cannot find module '../src/main/group/store.js'`

- [ ] **Step 3: 寫最小實作**

```ts
// src/main/group/store.ts
/**
 * 群組訊息的落地(群組規格 §3.2)。每個專案一個 append-only NDJSON,
 * 放 `<userData>/yeschef-group/<projectId>.ndjson`。
 *
 * 不放專案目錄的理由跟同伴信箱一樣:那裡可能被 `git clean -fdx` 清掉。
 * 程式中斷最多壞最後一行,讀取時跳過解析失敗的行並記一次 log。
 */
import { mkdir, appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { GROUP_READ_LIMIT, GroupMessageSchema, type GroupMessage } from '../../shared/group.js'

/** 超過就把前半裁掉:留一半比留全部安全,也不用逐則計數。 */
export const GROUP_FILE_MAX_BYTES = 5 * 1024 * 1024

export interface GroupStore {
  append(message: GroupMessage): Promise<void>
  /** 最後 `GROUP_READ_LIMIT` 則,舊到新。檔案不存在回空陣列。 */
  read(projectId: string): Promise<readonly GroupMessage[]>
  dispose(): Promise<void>
}

/** projectId 會變成檔名,不能帶路徑分隔符或上層參照。 */
function fileNameOf(projectId: string): string {
  if (projectId === '' || /[\\/]/.test(projectId) || projectId.includes('..')) {
    throw new Error(`群組訊息的專案代號不合法:${projectId}`)
  }
  return `${projectId}.ndjson`
}

function decode(text: string, onSkipped: (count: number) => void): readonly GroupMessage[] {
  const out: GroupMessage[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let raw: unknown
    try { raw = JSON.parse(line) } catch { skipped += 1; continue }
    const parsed = GroupMessageSchema.safeParse(raw)
    if (parsed.success) out.push(parsed.data)
    else skipped += 1
  }
  if (skipped > 0) onSkipped(skipped)
  return out
}

export function createGroupStore(dir: string, logError: (error: Error) => void): GroupStore {
  /** 每個專案一條 promise 鏈:兩個來源同時追加也不會交錯成壞行。 */
  let chains = new Map<string, Promise<void>>()
  let ready: Promise<void> | undefined

  const ensureDir = (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined)
    return ready
  }

  const serialize = (projectId: string, work: () => Promise<void>): Promise<void> => {
    const previous = chains.get(projectId) ?? Promise.resolve()
    const next = previous.then(work, work)
    chains = new Map([...chains, [projectId, next.catch(() => undefined)]])
    return next
  }

  /** 超過上限就讀進來、留後半、原子寫回。失敗只記 log,原檔留著。 */
  const halve = async (projectId: string, path: string): Promise<void> => {
    try {
      const text = await readFile(path, 'utf8')
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      const kept = lines.slice(Math.floor(lines.length / 2))
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, `${kept.join('\n')}\n`, { mode: 0o600 })
      await rename(temp, path)
      logError(new Error(`群組訊息檔超過上限,已裁掉前半:${projectId}`))
    } catch (cause) {
      logError(new Error(`群組訊息檔裁切失敗:${projectId}`, { cause }))
    }
  }

  return {
    async append(message) {
      const name = fileNameOf(message.projectId)
      await ensureDir()
      await serialize(message.projectId, async () => {
        await appendFile(join(dir, name), `${JSON.stringify(message)}\n`, { mode: 0o600 })
      })
    },

    async read(projectId) {
      const path = join(dir, fileNameOf(projectId))
      await ensureDir()
      const size = await stat(path).then((s) => s.size).catch(() => -1)
      if (size < 0) return []
      if (size > GROUP_FILE_MAX_BYTES) await serialize(projectId, () => halve(projectId, path))
      const text = await readFile(path, 'utf8').catch(() => '')
      const messages = decode(text, (count) => {
        logError(new Error(`群組訊息有 ${count} 行無法解析,已跳過:${projectId}`))
      })
      return messages.slice(-GROUP_READ_LIMIT)
    },

    async dispose() {
      await Promise.all([...chains.values()])
      chains = new Map()
    },
  }
}
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/group-store.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/group/store.ts tests/group-store.test.ts
git commit -m "feat: add append-only group message store"
```

---

### Task 3: `src/main/group/messages.ts` 的 `MSG` 與 label

**Files:**
- Create: `src/main/group/messages.ts`
- Test: `tests/group-labels.test.ts`

**Interfaces:**
- Consumes: `ChefTask`、`ChefAttempt`(`src/shared/chef.ts`,既有)。
- Produces:

```ts
export const CHEF_LABEL = '主廚'
export const USER_LABEL = '你'
export const SYSTEM_LABEL = '系統'
export const GENERAL_TITLE = '未分派'
export const TITLE_MAX = 60
export const MSG: {
  injection(label: string): string
  mentionNotFound(names: readonly string[]): string
  busy(label: string): string
  threadOpened(goal: string): string
  noProject: string
  noChef: string
  noModels: string
  startFailed: string
  noConversation(label: string): string
  delegated(title: string, kind: string): string
  joined(label: string, unitTitle: string, model: string): string
  left(label: string, reason: string): string
  unitDone(label: string, unitTitle: string): string
  unitBlocked(label: string, unitTitle: string, reason: string): string
  taskReport(outcome: 'completed' | 'blocked', summary: string): string
  chefPrompt: string
}
export function roleOf(task: ChefTask, attempt: ChefAttempt): 'chef' | 'worker'
export function labelFor(task: ChefTask, attempt: ChefAttempt): string
export function titleOf(goal: string): string
```

- Task 4、Task 7、Task 12 都用這份 `MSG`;Task 7 的里程碑用 `labelFor` 與 `roleOf`,Task 4 的 thread 清單用 `titleOf`。
- `noChef`／`noModels`／`startFailed` 是規格 §9 表格外多出來的三個鍵:§6 要在 general 開任務,開不起來時總得有句給人看的話。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/group-labels.test.ts
import { describe, expect, it } from 'vitest'
import { CHEF_LABEL, GENERAL_TITLE, MSG, labelFor, roleOf, titleOf } from '../src/main/group/messages.js'
import type { ChefAttempt, ChefTask } from '../src/shared/chef.js'

const attempt = (over: Partial<ChefAttempt>): ChefAttempt => ({
  id: 'a1', unitId: 'u1', workerId: 'w1', provider: 'claude', model: 'sonnet', status: 'running',
  startedAt: 0, reason: '', events: [], pendingTools: [], backgroundWork: false, denied: false, awaitingApproval: false,
  ...over,
})

const task = (over: Partial<ChefTask> = {}): ChefTask => ({
  id: 't1', projectId: 'p1', cwd: '/repo', goal: '把整份報表補完', followups: [],
  policy: { mode: 'auto', allowed: ['claude:c'], maxExecutions: 8, deadlineMinutes: 60 },
  status: 'running', createdAt: 0, deadlineAt: 0,
  units: [
    { id: 'u1', parentId: null, title: '規劃與執行', goal: 'g', kind: 'analysis', status: 'running' },
    { id: 'u2', parentId: 'u1', title: '實作', goal: 'g', kind: 'code', status: 'queued' },
    { id: 'u3', parentId: 'u1', title: '驗收', goal: 'g', kind: 'review', status: 'queued' },
  ],
  attempts: [], reason: '', cancelRequested: false, needsReconciliation: false,
  ...over,
})

describe('角色與 label', () => {
  it('根 unit 與 review unit 都是主廚', () => {
    const t = task()
    expect(roleOf(t, attempt({ unitId: 'u1' }))).toBe('chef')
    expect(roleOf(t, attempt({ unitId: 'u3' }))).toBe('chef')
    expect(labelFor(t, attempt({ unitId: 'u1' }))).toBe(CHEF_LABEL)
    expect(labelFor(t, attempt({ unitId: 'u3' }))).toBe(CHEF_LABEL)
  })

  it('worker 依同一家的第幾個 attempt 編號,主廚不佔號', () => {
    const attempts = [
      attempt({ id: 'a1', unitId: 'u1', provider: 'claude' }),
      attempt({ id: 'a2', unitId: 'u2', provider: 'codex' }),
      attempt({ id: 'a3', unitId: 'u2', provider: 'codex' }),
      attempt({ id: 'a4', unitId: 'u2', provider: 'grok' }),
    ]
    const t = task({ attempts })
    expect(attempts.map((a) => labelFor(t, a))).toEqual([CHEF_LABEL, 'codex-1', 'codex-2', 'grok-1'])
  })

  it('unit 找不到時當成主廚,不丟例外', () => {
    expect(labelFor(task(), attempt({ unitId: '不存在' }))).toBe(CHEF_LABEL)
  })
})

describe('標題', () => {
  it('超過 60 字就截斷', () => {
    expect(titleOf('x'.repeat(80))).toHaveLength(60)
    expect(titleOf('短目標')).toBe('短目標')
    expect(titleOf('  兩側空白  ')).toBe('兩側空白')
  })
  it('general 的標題是未分派', () => {
    expect(GENERAL_TITLE).toBe('未分派')
  })
})

describe('MSG', () => {
  it('每一則都是繁體中文,不含內部名稱與破折號', () => {
    const rendered = [
      MSG.injection('你'), MSG.mentionNotFound(['bob']), MSG.busy('codex-1'), MSG.threadOpened('補測試'),
      MSG.noProject, MSG.noChef, MSG.noModels, MSG.startFailed, MSG.noConversation('codex-1'),
      MSG.delegated('實作', 'code'), MSG.joined('codex-1', '實作', 'gpt-5'), MSG.left('codex-1', '額度用完'),
      MSG.unitDone('codex-1', '實作'), MSG.unitBlocked('codex-1', '實作', '缺權限'),
      MSG.taskReport('completed', '做完了'), MSG.chefPrompt,
    ]
    for (const text of rendered) {
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/--|—|TODO/)
    }
  })

  it('幾則關鍵訊息的內容', () => {
    expect(MSG.injection('你')).toBe('[群組 · 你]')
    expect(MSG.mentionNotFound(['bob', 'eve'])).toContain('bob、eve')
    expect(MSG.busy('codex-1')).toBe('codex-1 正在工作中,訊息已送出')
    expect(MSG.threadOpened('補測試')).toContain('補測試')
    expect(MSG.delegated('實作', 'code')).toBe('主廚把「實作」交給 code 的工作者')
    expect(MSG.joined('codex-1', '實作', 'gpt-5')).toBe('codex-1 加入,負責「實作」,用 gpt-5')
    expect(MSG.unitDone('codex-1', '實作')).toBe('codex-1 完成「實作」')
    expect(MSG.unitBlocked('codex-1', '實作', '缺權限')).toBe('codex-1 卡在「實作」:缺權限')
    expect(MSG.taskReport('completed', '做完了')).toBe('任務完成:做完了')
    expect(MSG.taskReport('blocked', '缺授權')).toBe('任務卡住:缺授權')
    expect(MSG.chefPrompt).toContain('say_to_group')
    expect(MSG.chefPrompt).toContain('task_progress')
  })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/group-labels.test.ts`
Expected: FAIL,`Cannot find module '../src/main/group/messages.js'`

- [ ] **Step 3: 寫最小實作**

```ts
// src/main/group/messages.ts
/**
 * 群組頻道給人看的字(群組規格 §9)與參與者名字的算法(§3.1)。
 *
 * label 在寫入訊息時就算好並存進去,之後 attempt 增減都不會改動歷史訊息上的名字。
 */
import type { ChefAttempt, ChefTask } from '../../shared/chef.js'

export const CHEF_LABEL = '主廚'
/** 人在群組裡的名字,只用在注入標記與 `task_progress` 的摘要上。 */
export const USER_LABEL = '你'
export const SYSTEM_LABEL = '系統'
export const GENERAL_TITLE = '未分派'
export const TITLE_MAX = 60

export const MSG = {
  injection: (label: string) => `[群組 · ${label}]`,
  mentionNotFound: (names: readonly string[]) => `群組裡沒有 ${names.join('、')},訊息沒有送給任何人`,
  busy: (label: string) => `${label} 正在工作中,訊息已送出`,
  threadOpened: (goal: string) => `開了新目標:${goal},主廚即將就位`,
  noProject: '找不到這個專案',
  noChef: '主廚服務沒有啟動,現在開不了新目標',
  noModels: '沒有可用的模型,請先在主廚控制台重新整理模型',
  startFailed: '新目標沒有建立成功,請稍後再試',
  noConversation: (label: string) => `${label} 的對話已經關閉`,
  delegated: (title: string, kind: string) => `主廚把「${title}」交給 ${kind} 的工作者`,
  joined: (label: string, unitTitle: string, model: string) => `${label} 加入,負責「${unitTitle}」,用 ${model}`,
  left: (label: string, reason: string) => `${label} 離開:${reason}`,
  unitDone: (label: string, unitTitle: string) => `${label} 完成「${unitTitle}」`,
  unitBlocked: (label: string, unitTitle: string, reason: string) => `${label} 卡在「${unitTitle}」:${reason}`,
  taskReport: (outcome: 'completed' | 'blocked', summary: string) => `任務${outcome === 'completed' ? '完成' : '卡住'}:${summary}`,
  chefPrompt: '這個任務在專案群組裡進行。用 say_to_group 對人與其他工作者說話,用 task_progress 看群裡發生什麼。',
} as const

/** 跟 `ChefService.worker()` 同一條規則:根 unit 與 review unit 是主廚,其餘是工作者。 */
export function roleOf(task: ChefTask, attempt: ChefAttempt): 'chef' | 'worker' {
  const unit = task.units.find((u) => u.id === attempt.unitId)
  return unit === undefined || unit.parentId === null || unit.kind === 'review' ? 'chef' : 'worker'
}

/** 主廚固定叫「主廚」;worker 叫 `<provider>-<序號>`,序號只數同一家的 worker attempt。 */
export function labelFor(task: ChefTask, attempt: ChefAttempt): string {
  if (roleOf(task, attempt) === 'chef') return CHEF_LABEL
  const sameProvider = task.attempts.filter((a) => a.provider === attempt.provider && roleOf(task, a) === 'worker')
  const index = sameProvider.findIndex((a) => a.id === attempt.id)
  return `${attempt.provider}-${index < 0 ? sameProvider.length + 1 : index + 1}`
}

export function titleOf(goal: string): string {
  return goal.trim().slice(0, TITLE_MAX)
}
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/group-labels.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/group/messages.ts tests/group-labels.test.ts
git commit -m "feat: add group channel messages and participant labels"
```

---

### Task 4: `src/main/group/service.ts` 的送訊息與 thread 清單

**Files:**
- Create: `src/main/group/service.ts`
- Test: `tests/group-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 schema 與常數、Task 2 的 `GroupStore`、Task 3 的 `MSG`／`labelFor`／`roleOf`／`titleOf`／`GENERAL_TITLE`／`USER_LABEL`。
- Produces:

```ts
export type DeliverOutcome = { readonly kind: 'delivered'; readonly busy: boolean } | { readonly kind: 'missing' }
export interface GroupChef {
  tasksOf(projectId: string): readonly ChefTask[]
  /** 實作在 `index.ts`,直接轉呼叫 Task 7 的 `ChefService.start`,不做任何 diff。 */
  start(projectId: string, goal: string): Promise<{ readonly kind: 'ok'; readonly taskId: string } | { readonly kind: 'error'; readonly message: string }>
}
export interface GroupMessageInput {
  readonly projectId: string
  readonly threadId: string
  readonly from: GroupSender
  readonly kind: GroupMessage['kind']
  readonly text: string
  readonly unitId?: string
}
export interface GroupServiceDeps {
  readonly store: GroupStore
  readonly chef: GroupChef
  readonly deliver: (projectId: string, conversationId: string, text: string) => DeliverOutcome
  readonly hasProject: (projectId: string) => boolean
  readonly onChange: (payload: GroupMessagesPayload) => void
  readonly newId: () => string
  readonly now: () => number
  readonly logError: (error: Error) => void
}
export interface GroupService {
  handle(raw: unknown): Promise<GroupResponse>
  /** 里程碑與 `say_to_group` 用。同步呼叫,寫入失敗只 logError,不往外拋。 */
  write(input: GroupMessageInput): void
  /**
   * `task_progress` 用。會先把這個專案的訊息從 store 載進來,所以重開 app 之後接續
   * blocked 任務時,主廚仍查得到重開前的群組訊息。
   */
  recent(projectId: string, threadId: string, limit: number): Promise<readonly GroupMessage[]>
  threadsOf(projectId: string): readonly GroupThread[]
  dispose(): Promise<void>
}
export function createGroupService(deps: GroupServiceDeps): GroupService
export function mentionsIn(text: string): readonly string[]
```

- Task 5 的 `deliverToManaged` 回的就是 `DeliverOutcome`;Task 7 的 chef dep 只用 `write` 與 `recent`;Task 6 的 handler 只用 `handle`;Task 12 在 `index.ts` 實作 `GroupChef`,其中 `start` 轉呼叫 Task 7 新增的 `ChefService.start`。
- `mentionsIn` 用 `/@([\w一-鿿-]{1,40})/g`。規格 §5 寫的 `/@([\w一-鿿-]{1,40})/g` 字元類尾端多一個 `-`,在嚴格模式的 unicode 情境下不可靠,改用明寫的碼點範圍。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/group-service.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGroupStore } from '../src/main/group/store.js'
import { createGroupService, mentionsIn, type DeliverOutcome, type GroupService } from '../src/main/group/service.js'
import { MSG } from '../src/main/group/messages.js'
import { GENERAL_THREAD_ID, type GroupMessagesPayload } from '../src/shared/group.js'
import type { ChefTask } from '../src/shared/chef.js'

const roots: string[] = []
const services: GroupService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function chefTask(over: Partial<ChefTask> = {}): ChefTask {
  return {
    id: 'task-1', projectId: 'p1', cwd: '/repo', goal: '把整份報表補完', followups: [],
    policy: { mode: 'auto', allowed: ['claude:c'], maxExecutions: 8, deadlineMinutes: 60 },
    status: 'running', createdAt: 0, deadlineAt: 0,
    units: [
      { id: 'u1', parentId: null, title: '規劃與執行', goal: 'g', kind: 'analysis', status: 'running' },
      { id: 'u2', parentId: 'u1', title: '實作', goal: 'g', kind: 'code', status: 'running' },
    ],
    attempts: [
      { id: 'a1', unitId: 'u1', workerId: 'chef-conv', provider: 'claude', model: 'sonnet', status: 'running', startedAt: 0, reason: '', events: [], pendingTools: [], backgroundWork: false, denied: false, awaitingApproval: false },
      { id: 'a2', unitId: 'u2', workerId: 'codex-conv', provider: 'codex', model: 'gpt-5', status: 'running', startedAt: 0, reason: '', events: [], pendingTools: [], backgroundWork: false, denied: false, awaitingApproval: false },
    ],
    reason: '', cancelRequested: false, needsReconciliation: false, ...over,
  }
}

async function rig(options: { tasks?: readonly ChefTask[]; deliver?: DeliverOutcome; startFails?: boolean; root?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'yeschef-group-svc-'))
  if (options.root === undefined) roots.push(root)
  const errors: Error[] = []
  const delivered: { conversationId: string; text: string }[] = []
  const pushes: GroupMessagesPayload[] = []
  let tasks = options.tasks ?? []
  let counter = 0
  const service = createGroupService({
    store: createGroupStore(root, (error) => errors.push(error)),
    chef: {
      tasksOf: (projectId) => tasks.filter((t) => t.projectId === projectId),
      start: async (projectId, goal) => {
        if (options.startFails === true) return { kind: 'error', message: MSG.noModels }
        const created = chefTask({ id: `task-${tasks.length + 1}`, projectId, goal, attempts: [] })
        tasks = [...tasks, created]
        return { kind: 'ok', taskId: created.id }
      },
    },
    deliver: (_projectId, conversationId, text) => {
      delivered.push({ conversationId, text })
      return options.deliver ?? { kind: 'delivered', busy: false }
    },
    hasProject: (projectId) => projectId === 'p1',
    onChange: (payload) => pushes.push(payload),
    newId: () => `m${++counter}`,
    now: () => 1_700_000_000_000,
    logError: (error) => errors.push(error),
  })
  services.push(service)
  return { root, service, errors, delivered, pushes, tasksNow: () => tasks }
}

describe('@ 解析', () => {
  it('掃得出中英文與連字號的名字,最多四十字', () => {
    expect(mentionsIn('@codex-1 幫我看一下 @主廚')).toEqual(['codex-1', '主廚'])
    expect(mentionsIn('沒有提到任何人')).toEqual([])
    expect(mentionsIn('信箱 a@b.com 只會掃到點號前那段')).toEqual(['b'])
    expect(mentionsIn(`@${'x'.repeat(50)}`)[0]).toHaveLength(40)
  })
})

describe('send', () => {
  it('沒有 @ 就送給這條 thread 的主廚,注入文字帶來源標記', async () => {
    const r = await rig({ tasks: [chefTask()] })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '先補測試' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    expect(r.delivered).toEqual([{ conversationId: 'chef-conv', text: `${MSG.injection('你')}\n先補測試` }])
  })

  it('@ 命中就送給那個參與者,不送主廚', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@codex-1 換個做法' })
    expect(r.delivered.map((d) => d.conversationId)).toEqual(['codex-conv'])
  })

  it('@ 沒命中就補一則 system 訊息,而且誰都不送', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '@不存在的人 在嗎' })
    expect(r.delivered).toEqual([])
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((m) => m.text)).toEqual(['@不存在的人 在嗎', MSG.mentionNotFound(['不存在的人'])])
    expect(state.messages[1]?.from).toEqual({ kind: 'system' })
  })

  it('對象忙碌時照樣送,並補一則 system 訊息', async () => {
    const r = await rig({ tasks: [chefTask()], deliver: { kind: 'delivered', busy: true } })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '先補測試' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.at(-1)?.text).toBe(MSG.busy('主廚'))
    expect(r.delivered).toHaveLength(1)
  })

  it('對話已經關掉時仍回 sent,並留下一則 system 訊息', async () => {
    const r = await rig({ tasks: [chefTask()], deliver: { kind: 'missing' } })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '在嗎' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((m) => m.text)).toEqual(['在嗎', MSG.noConversation('主廚')])
  })

  it('在 general 送訊息會開新任務,訊息的 threadId 直接用新的 taskId', async () => {
    const r = await rig()
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GENERAL_THREAD_ID, text: '把整份報表補完' })
    expect(response).toEqual({ kind: 'sent', threadId: 'task-1' })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages.map((m) => ({ threadId: m.threadId, kind: m.kind, text: m.text }))).toEqual([
      { threadId: 'task-1', kind: 'goal', text: '把整份報表補完' },
      { threadId: 'task-1', kind: 'text', text: MSG.threadOpened('把整份報表補完') },
    ])
    expect(r.delivered).toEqual([])
  })

  it('開任務失敗就回 error,一則訊息都不寫', async () => {
    const r = await rig({ startFails: true })
    const response = await r.service.handle({ action: 'send', projectId: 'p1', threadId: GENERAL_THREAD_ID, text: '做點什麼' })
    expect(response).toEqual({ kind: 'error', message: MSG.noModels })
    const state = await r.service.handle({ action: 'get', projectId: 'p1' })
    if (state.kind !== 'state') throw new Error('應該是 state')
    expect(state.messages).toEqual([])
  })

  it('已經有主廚的 thread 直接 deliver,不開新任務', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'send', projectId: 'p1', threadId: 'task-1', text: '再補一點' })
    expect(r.tasksNow()).toHaveLength(1)
  })

  it('不存在的專案回 error', async () => {
    const r = await rig()
    expect(await r.service.handle({ action: 'get', projectId: 'nope' })).toEqual({ kind: 'error', message: MSG.noProject })
  })

  it('形狀不對的請求回 error', async () => {
    const r = await rig()
    const response = await r.service.handle({ action: 'send', projectId: 'p1' })
    expect(response.kind).toBe('error')
  })
})

describe('thread 清單', () => {
  it('general 永遠在最前面,任務照 chef 的狀態與參與者', async () => {
    const r = await rig({ tasks: [chefTask()] })
    expect(r.service.threadsOf('p1')).toEqual([
      { id: GENERAL_THREAD_ID, title: '未分派', status: 'open', createdAt: 0, participants: [] },
      {
        id: 'task-1', title: '把整份報表補完', status: 'running', createdAt: 0,
        participants: [
          { label: '主廚', conversationId: 'chef-conv', provider: 'claude', role: 'chef', unitTitle: '規劃與執行' },
          { label: 'codex-1', conversationId: 'codex-conv', provider: 'codex', role: 'worker', unitTitle: '實作' },
        ],
      },
    ])
  })
})

describe('write 與 recent', () => {
  it('write 之後 recent 拿得到,而且會推播', async () => {
    const r = await rig({ tasks: [chefTask()] })
    await r.service.handle({ action: 'get', projectId: 'p1' })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'delegated', text: MSG.delegated('實作', 'code') })
    expect((await r.service.recent('p1', 'task-1', 20)).map((m) => m.text)).toEqual([MSG.delegated('實作', 'code')])
    await vi.waitFor(() => expect(r.pushes).toHaveLength(1))
    expect(r.pushes[0]?.messages.map((m) => m.kind)).toEqual(['delegated'])
    expect(r.pushes[0]?.threads[0]?.id).toBe(GENERAL_THREAD_ID)
  })

  it('同一輪事件迴圈裡的多則合併成一批', async () => {
    const r = await rig({ tasks: [chefTask()] })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '一' })
    r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '二' })
    await vi.waitFor(() => expect(r.pushes).toHaveLength(1))
    expect(r.pushes[0]?.messages.map((m) => m.text)).toEqual(['一', '二'])
  })

  it('recent 依 threadId 過濾,只回最後 limit 則', async () => {
    const r = await rig({ tasks: [chefTask()] })
    for (let i = 0; i < 25; i++) {
      r.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'progress', text: `第 ${i} 則` })
    }
    r.service.write({ projectId: 'p1', threadId: '別條', from: { kind: 'system' }, kind: 'progress', text: '不該出現' })
    const recent = await r.service.recent('p1', 'task-1', 20)
    expect(recent).toHaveLength(20)
    expect(recent[0]?.text).toBe('第 5 則')
    expect(recent.some((m) => m.text === '不該出現')).toBe(false)
  })

  it('重開之後 recent 讀得到上一輪落地的訊息', async () => {
    const first = await rig({ tasks: [chefTask()] })
    first.service.write({ projectId: 'p1', threadId: 'task-1', from: { kind: 'system' }, kind: 'joined', text: '重開前寫的' })
    await first.service.dispose()
    // 同一個目錄再開一份 service:記憶體是空的,recent 要自己去 store 把歷史載回來。
    const second = await rig({ tasks: [chefTask()], root: first.root })
    expect((await second.service.recent('p1', 'task-1', 20)).map((m) => m.text)).toEqual(['重開前寫的'])
  })

  it('寫入失敗只 logError,不往外拋', async () => {
    const r = await rig({ tasks: [chefTask()] })
    expect(() => r.service.write({ projectId: '../壞', threadId: 'task-1', from: { kind: 'system' }, kind: 'progress', text: 'x' })).not.toThrow()
    await vi.waitFor(() => expect(r.errors.length).toBeGreaterThan(0))
  })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/group-service.test.ts`
Expected: FAIL,`Cannot find module '../src/main/group/service.js'`

- [ ] **Step 3: 寫最小實作**

```ts
// src/main/group/service.ts
/**
 * 群組頻道的規則(群組規格 §4、§5、§6)。
 *
 * 記憶體裡的那份是唯一給讀取用的真相,NDJSON 是持久層:`task_progress` 要同步拿到
 * 最近的訊息,不能每次都去讀檔。第一次碰到某個專案時把檔案讀進來,之後只往後接。
 */
import type { ChefTask } from '../../shared/chef.js'
import {
  GENERAL_THREAD_ID,
  GROUP_READ_LIMIT,
  GroupRequestSchema,
  type GroupMessage,
  type GroupMessagesPayload,
  type GroupResponse,
  type GroupSender,
  type GroupThread,
} from '../../shared/group.js'
import { GENERAL_TITLE, MSG, USER_LABEL, labelFor, roleOf, titleOf } from './messages.js'
import type { GroupStore } from './store.js'

export type DeliverOutcome = { readonly kind: 'delivered'; readonly busy: boolean } | { readonly kind: 'missing' }

export interface GroupChef {
  tasksOf(projectId: string): readonly ChefTask[]
  /** 實作在 `index.ts`,直接轉呼叫 Task 7 的 `ChefService.start`,不做任何 diff。 */
  start(projectId: string, goal: string): Promise<{ readonly kind: 'ok'; readonly taskId: string } | { readonly kind: 'error'; readonly message: string }>
}

export interface GroupMessageInput {
  readonly projectId: string
  readonly threadId: string
  readonly from: GroupSender
  readonly kind: GroupMessage['kind']
  readonly text: string
  readonly unitId?: string
}

export interface GroupServiceDeps {
  readonly store: GroupStore
  readonly chef: GroupChef
  readonly deliver: (projectId: string, conversationId: string, text: string) => DeliverOutcome
  readonly hasProject: (projectId: string) => boolean
  readonly onChange: (payload: GroupMessagesPayload) => void
  readonly newId: () => string
  readonly now: () => number
  readonly logError: (error: Error) => void
}

export interface GroupService {
  handle(raw: unknown): Promise<GroupResponse>
  /** 里程碑與 `say_to_group` 用。同步呼叫,寫入失敗只 logError,不往外拋。 */
  write(input: GroupMessageInput): void
  /**
   * `task_progress` 用。先確保這個專案的訊息已經從 store 載進來,再從記憶體那份取:
   * 直接讀檔會漏掉剛寫下、還沒落地的里程碑,只讀記憶體則會漏掉重開 app 之前的訊息。
   */
  recent(projectId: string, threadId: string, limit: number): Promise<readonly GroupMessage[]>
  threadsOf(projectId: string): readonly GroupThread[]
  dispose(): Promise<void>
}

/** `@名字`:英數、底線、連字號與中日韓統一表意文字,最多四十字。 */
const MENTION = /@([\w一-鿿-]{1,40})/g

export function mentionsIn(text: string): readonly string[] {
  return [...text.matchAll(MENTION)].map((m) => m[1]!)
}

export function createGroupService(deps: GroupServiceDeps): GroupService {
  /** projectId 到那個專案的訊息。載入過的才在裡面。 */
  let cache = new Map<string, readonly GroupMessage[]>()
  let pending = new Map<string, readonly GroupMessage[]>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const messagesOf = (projectId: string): readonly GroupMessage[] => cache.get(projectId) ?? []

  const flush = (): void => {
    timer = undefined
    const batch = pending
    pending = new Map()
    for (const [projectId, messages] of batch) {
      deps.onChange({ projectId, messages: [...messages], threads: [...threadsOf(projectId)] })
    }
  }

  const schedule = (): void => {
    if (closed || timer !== undefined) return
    timer = setTimeout(flush, 0)
    timer.unref?.()
  }

  /** 唯一的寫入點:進快取、排推播、落檔。落檔失敗只記 log。 */
  const record = (input: GroupMessageInput, mentions: readonly string[] = []): GroupMessage => {
    const message: GroupMessage = {
      id: deps.newId(),
      projectId: input.projectId,
      threadId: input.threadId,
      at: deps.now(),
      from: input.from,
      kind: input.kind,
      text: input.text,
      mentions: [...mentions],
      ...(input.unitId === undefined ? {} : { unitId: input.unitId }),
    }
    cache = new Map([...cache, [message.projectId, [...messagesOf(message.projectId), message].slice(-GROUP_READ_LIMIT)]])
    pending = new Map([...pending, [message.projectId, [...(pending.get(message.projectId) ?? []), message]]])
    schedule()
    deps.store.append(message).catch((cause: unknown) => {
      deps.logError(new Error(`群組訊息寫入失敗:${message.projectId}`, { cause }))
    })
    return message
  }

  const ensureLoaded = async (projectId: string): Promise<void> => {
    if (cache.has(projectId)) return
    const loaded = await deps.store.read(projectId).catch((cause: unknown) => {
      deps.logError(new Error(`群組訊息讀取失敗:${projectId}`, { cause }))
      return [] as readonly GroupMessage[]
    })
    // 讀檔期間可能已經有里程碑寫進來,已載入就不覆蓋。
    if (!cache.has(projectId)) cache = new Map([...cache, [projectId, loaded]])
  }

  function threadsOf(projectId: string): readonly GroupThread[] {
    const general: GroupThread = { id: GENERAL_THREAD_ID, title: GENERAL_TITLE, status: 'open', createdAt: 0, participants: [] }
    const tasks = deps.chef.tasksOf(projectId).map((task) => ({
      id: task.id,
      title: titleOf(task.goal),
      status: task.status,
      createdAt: task.createdAt,
      participants: task.attempts.map((attempt) => {
        const unitTitle = task.units.find((u) => u.id === attempt.unitId)?.title
        return {
          label: labelFor(task, attempt),
          conversationId: attempt.workerId,
          provider: attempt.provider,
          role: roleOf(task, attempt),
          ...(unitTitle === undefined ? {} : { unitTitle }),
        }
      }),
    }))
    return [general, ...tasks]
  }

  /** general 或還沒有主廚的 thread:開一個新任務,人那則訊息直接掛在新 taskId 上(規格 §6)。 */
  const openGoal = async (projectId: string, text: string): Promise<GroupResponse> => {
    const started = await deps.chef.start(projectId, text)
    if (started.kind === 'error') return { kind: 'error', message: started.message }
    record({ projectId, threadId: started.taskId, from: { kind: 'user' }, kind: 'goal', text })
    record({ projectId, threadId: started.taskId, from: { kind: 'system' }, kind: 'text', text: MSG.threadOpened(titleOf(text)) })
    return { kind: 'sent', threadId: started.taskId }
  }

  /** 前置檢查失敗(專案不在、開不了新目標)才不寫訊息;寫進去之後一律回 sent(規格 §5)。 */
  const send = async (projectId: string, threadId: string, text: string): Promise<GroupResponse> => {
    await ensureLoaded(projectId)
    const thread = threadsOf(projectId).find((t) => t.id === threadId)
    const chefSeat = thread?.participants.find((p) => p.role === 'chef')
    if (chefSeat === undefined) return openGoal(projectId, text)
    const names = mentionsIn(text)
    const missing = names.filter((name) => !thread.participants.some((p) => p.label === name))
    const kind = messagesOf(projectId).some((m) => m.threadId === threadId) ? 'text' : 'goal'
    record({ projectId, threadId, from: { kind: 'user' }, kind, text }, names)
    // 有叫不到的名字就誰都不送:寧可讓人改一次,也不要猜他想找誰(規格 §5.1)。
    if (missing.length > 0) {
      record({ projectId, threadId, from: { kind: 'system' }, kind: 'text', text: MSG.mentionNotFound(missing) })
      return { kind: 'sent', threadId }
    }
    const target = thread.participants.find((p) => names.includes(p.label)) ?? chefSeat
    const outcome = deps.deliver(projectId, target.conversationId, `${MSG.injection(USER_LABEL)}\n${text}`)
    // 送不到人仍然回 sent:訊息已經寫進群組了,畫面上看得到那句「對話已經關閉」。
    // 回 error 會讓 composer 留住文字,人會誤以為自己什麼都沒送出。
    if (outcome.kind === 'missing') {
      record({ projectId, threadId, from: { kind: 'system' }, kind: 'text', text: MSG.noConversation(target.label) })
      return { kind: 'sent', threadId }
    }
    if (outcome.busy) record({ projectId, threadId, from: { kind: 'system' }, kind: 'text', text: MSG.busy(target.label) })
    return { kind: 'sent', threadId }
  }

  return {
    async handle(raw) {
      try {
        const request = GroupRequestSchema.parse(raw)
        if (closed) throw new Error('群組服務已停止')
        if (!deps.hasProject(request.projectId)) throw new Error(MSG.noProject)
        if (request.action === 'get') {
          await ensureLoaded(request.projectId)
          return { kind: 'state', messages: [...messagesOf(request.projectId)], threads: [...threadsOf(request.projectId)] }
        }
        return await send(request.projectId, request.threadId, request.text)
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : '群組操作失敗' }
      }
    },

    write(input) {
      try {
        record(input)
      } catch (cause) {
        deps.logError(new Error('群組里程碑寫入失敗', { cause }))
      }
    },

    async recent(projectId, threadId, limit) {
      await ensureLoaded(projectId)
      return messagesOf(projectId).filter((m) => m.threadId === threadId).slice(-limit)
    },

    threadsOf,

    async dispose() {
      closed = true
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      pending = new Map()
      await deps.store.dispose()
    },
  }
}
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/group-service.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/group/service.ts tests/group-service.test.ts
git commit -m "feat: add group service with mention routing and goal creation"
```

---

### Task 5: `IpcBridge.deliverToManaged` 略過主廚 guard 的注入口

**Files:**
- Modify: `src/main/ipc-bridge.ts:148-157`(`IpcBridge` 介面)、`src/main/ipc-bridge.ts:948-972`(`conversationFor` 旁邊)
- Test: `tests/ipc-bridge.test.ts`(在 `describe('conversationFor')` 後面補一個 `describe`)

**Interfaces:**
- Consumes: Task 4 的 `DeliverOutcome`。
- Produces:

```ts
export interface IpcBridge {
  startChefWorker(request: WorkerRequest): Promise<WorkerHandle>
  hasBusyWork(cwd: string): boolean
  dispose(): Promise<void>
  disposeConversation(conversationId: string): Promise<void>
  conversationFor(projectId: string, tabId: string): { isBusy(): boolean; userInput(text: string): void } | undefined
  /** 群組規格 §5.4:群組送訊息略過主廚 guard,回報對方當下忙不忙。 */
  deliverToManaged(projectId: string, conversationId: string, text: string): DeliverOutcome
}
```

- Task 12 在 `index.ts` 把它接成 `GroupServiceDeps.deliver`。
- 與 `conversationFor` 的差別只有一條:那支要過 `deps.chef?.guard(...)`,這支刻意不過。兩支都只看已經建起來的 slot,不用 `slotFor` 憑空開新 session。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/ipc-bridge.test.ts:在 describe('conversationFor') 後面補
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
    rig.fake('tab-a').core.deactivate.mockClear()
    expect(rig.bridge.deliverToManaged(A, 'tab-a', '背景也收得到')).toEqual({ kind: 'delivered', busy: false })
    expect(rig.fake('tab-a').core.userInput).toHaveBeenLastCalledWith('背景也收得到')
    expect(rig.fake('tab-a').core.deactivate).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts -t deliverToManaged`
Expected: FAIL,`rig.bridge.deliverToManaged is not a function`

- [ ] **Step 3: 寫最小實作**

在 `src/main/ipc-bridge.ts` 頂端的 import 區加:

```ts
import type { DeliverOutcome } from './group/service.js'
```

`IpcBridge` 介面補一行:

```ts
  /**
   * 群組規格 §5.4:群組送訊息略過主廚的 `guard`。guard 存在是為了擋「從一般介面
   * 打擾被主廚管理的對話」,群組是這件事唯一該發生的地方,所以這條路不套它。
   * 跟 `conversationFor` 一樣只看已經建起來的 slot:沒 slot 就是還沒跑過,不該憑空開。
   */
  deliverToManaged(projectId: string, conversationId: string, text: string): DeliverOutcome
```

`conversationFor` 定義後面加:

```ts
  const deliverToManaged = (projectId: string, conversationId: string, text: string): DeliverOutcome => {
    const owner = findProject(deps.projects.state(), projectId)
    const tab = owner?.tabs.find((t) => t.id === conversationId && t.contentType === 'conversation')
    if (owner === undefined || tab === undefined) return { kind: 'missing' }
    const slot = slots.get(conversationId)
    if (slot === undefined) return { kind: 'missing' }
    const busy = slot.core.isBusy()
    slot.core.userInput(text)
    if (currentId !== conversationId) slot.core.deactivate()
    return { kind: 'delivered', busy }
  }
```

最後一行的回傳改成:

```ts
  return { dispose, disposeConversation, startChefWorker, hasBusyWork, conversationFor, deliverToManaged }
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/ipc-bridge.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-bridge.ts tests/ipc-bridge.test.ts
git commit -m "feat: add deliverToManaged for group injections"
```

---

### Task 6: `group:manage` 的 IPC、`YesChefApi` 與 preload

**Files:**
- Create: `src/main/group/ipc.ts`
- Modify: `src/shared/ipc.ts:26-94`(`IPC`)、`src/shared/ipc.ts:178-227`(`YesChefApi`)、`src/preload/bridge.ts`
- Test: `tests/group-ipc.test.ts`、`tests/preload-bridge.test.ts`(補)

**Interfaces:**
- Consumes: Task 1 的 `GROUP_CHANNEL`、`GroupRequestSchema`、`GroupResponseSchema`、`parseGroupMessagesPayload`、`parseGroupOpen`。
- Produces:

```ts
// src/main/group/ipc.ts
export interface GroupIpcHandlerDeps {
  isTrustedSender(sender: unknown): boolean
  handle(raw: unknown): Promise<GroupResponse>
}
export function createGroupIpcHandler(deps: GroupIpcHandlerDeps): (event: { sender: unknown }, raw: unknown) => Promise<GroupResponse>

// src/shared/ipc.ts
IPC.groupMessages = 'group:messages'
IPC.groupOpen = 'group:open'
interface YesChefApi {
  manageGroup(payload: GroupRequest): Promise<GroupResponse>
  onGroupMessages(cb: (payload: GroupMessagesPayload) => void): Unsubscribe
  openGroup(projectId: string): void
}
```

- Task 9 用 `openGroup`,Task 10 用 `manageGroup` 與 `onGroupMessages`,Task 12 在 `index.ts` 註冊 `GROUP_CHANNEL` 並用 `IPC.groupMessages` 推播。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/group-ipc.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createGroupIpcHandler } from '../src/main/group/ipc.js'
import type { GroupResponse } from '../src/shared/group.js'

const state: GroupResponse = { kind: 'state', messages: [], threads: [] }

describe('group:manage 的 handler', () => {
  it('來源不對直接回 error,不呼叫 handle', async () => {
    const handle = vi.fn(async () => state)
    const onCall = createGroupIpcHandler({ isTrustedSender: () => false, handle })
    expect(await onCall({ sender: 'other' }, { action: 'get', projectId: 'p1' })).toEqual({ kind: 'error', message: '不接受此來源的群組請求' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('來源正確就把原始 payload 原樣交給 handle', async () => {
    const handle = vi.fn(async () => state)
    const onCall = createGroupIpcHandler({ isTrustedSender: () => true, handle })
    expect(await onCall({ sender: 'renderer' }, { action: 'get', projectId: 'p1' })).toEqual(state)
    expect(handle).toHaveBeenCalledWith({ action: 'get', projectId: 'p1' })
  })

  it('handle 丟例外時回 error,不讓主行程冒出未捕捉例外', async () => {
    const onCall = createGroupIpcHandler({ isTrustedSender: () => true, handle: () => Promise.reject(new Error('壞了')) })
    expect(await onCall({ sender: 'renderer' }, { action: 'get', projectId: 'p1' })).toEqual({ kind: 'error', message: '壞了' })
  })
})
```

```ts
// tests/preload-bridge.test.ts:在既有的 describe 裡補
it('manageGroup 送出的請求過 schema,回應也過 schema', async () => {
  const api = await loadBridge()
  replies.set('group:manage', { kind: 'sent', threadId: 't1' })
  await expect(api.manageGroup({ action: 'send', projectId: 'p1', threadId: 'general', text: '嗨' })).resolves.toEqual({ kind: 'sent', threadId: 't1' })
  expect(invoked.at(-1)).toEqual({ channel: 'group:manage', payload: { action: 'send', projectId: 'p1', threadId: 'general', text: '嗨' } })
  replies.set('group:manage', { kind: 'sent', threadId: 't1', extra: 1 })
  await expect(api.manageGroup({ action: 'get', projectId: 'p1' })).rejects.toThrow('群組回傳格式不正確')
})

it('onGroupMessages 回傳的是我們自己的解除訂閱,不是 ipcRenderer', () => {
  const api = exposed[0]!.value as YesChefApi
  const off = api.onGroupMessages(() => {})
  expect(typeof off).toBe('function')
  expect(off).not.toBe(ipcRenderer)
  off()
})

it('openGroup 只送 projectId', () => {
  const api = exposed[0]!.value as YesChefApi
  api.openGroup('p1')
  expect(sent.at(-1)).toEqual({ channel: 'group:open', payload: { projectId: 'p1' } })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/group-ipc.test.ts tests/preload-bridge.test.ts`
Expected: FAIL,`Cannot find module '../src/main/group/ipc.js'` 與 `api.manageGroup is not a function`

- [ ] **Step 3: 寫最小實作**

```ts
// src/main/group/ipc.ts
import type { GroupResponse } from '../../shared/group.js'

export interface GroupIpcHandlerDeps {
  isTrustedSender(sender: unknown): boolean
  handle(raw: unknown): Promise<GroupResponse>
}

/**
 * group:manage 頻道的 ipcMain.handle 處理器,抽法同 `test-machines/ipc.ts`。
 * 來源不對直接回 error,不呼叫 handle;handle 丟例外也收成 error 回應。
 */
export function createGroupIpcHandler(
  deps: GroupIpcHandlerDeps
): (event: { sender: unknown }, raw: unknown) => Promise<GroupResponse> {
  return async (event, raw) => {
    if (!deps.isTrustedSender(event.sender)) return { kind: 'error', message: '不接受此來源的群組請求' }
    try {
      return await deps.handle(raw)
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : '群組操作失敗' }
    }
  }
}
```

`src/shared/ipc.ts` 的 import 區加:

```ts
import type { GroupMessagesPayload, GroupOpenPayload, GroupRequest, GroupResponse } from './group.js'
```

`IPC` 物件在 `browserGet` 後面加:

```ts
  /** main → renderer:群組新訊息與當下的 thread 清單,批次送。 */
  groupMessages: 'group:messages',
  /** renderer → main:在某專案底下開群組分頁,已經有就切過去。 */
  groupOpen: 'group:open',
```

`YesChefApi` 在 `manageTestMachines` 後面加:

```ts
  /** 群組頻道的讀取與送訊息(群組規格 §7)。 */
  manageGroup(payload: GroupRequest): Promise<GroupResponse>
  onGroupMessages(cb: (payload: GroupMessagesPayload) => void): Unsubscribe
  /** 一個專案最多一個群組分頁;已經開著就切過去。 */
  openGroup(projectId: string): void
```

`src/preload/bridge.ts` 的 import 區加:

```ts
import { GROUP_CHANNEL, GroupRequestSchema, GroupResponseSchema, parseGroupMessagesPayload } from '../shared/group.js'
import type { GroupOpenPayload } from '../shared/group.js'
```

`api` 物件在 `manageTestMachines` 後面加:

```ts
  manageGroup: (payload) => {
    return invokeParsed(GROUP_CHANNEL, GroupRequestSchema.parse(payload), (raw) => {
      const result = GroupResponseSchema.safeParse(raw)
      return result.success ? result.data : null
    }, '群組回傳格式不正確')
  },
  onGroupMessages: (cb) => subscribe(IPC.groupMessages, parseGroupMessagesPayload, cb),
  openGroup: (projectId) => {
    ipcRenderer.send(IPC.groupOpen, { projectId } satisfies GroupOpenPayload)
  },
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/group-ipc.test.ts tests/preload-bridge.test.ts && npm run typecheck`
Expected: PASS(`tests/helpers/fake-yeschef.ts` 還沒補,typecheck 會在那個檔報 `YesChefApi` 少三個成員。同一步順手補上 Task 10 要用的三個假實作:`manageGroup: async () => ({ kind: 'state', messages: [], threads: [] })`、`onGroupMessages: on(groupListeners)`、`openGroup: (id) => { calls.push(\`openGroup:${id}\`) }`,並在回傳物件加 `emitGroup: emit(groupListeners)` 與對應的 `groupListeners` Set 與 `FakeYesChef` 介面欄位。)

- [ ] **Step 5: Commit**

```bash
git add src/main/group/ipc.ts src/shared/ipc.ts src/preload/bridge.ts tests/group-ipc.test.ts tests/preload-bridge.test.ts tests/helpers/fake-yeschef.ts
git commit -m "feat: wire group channel through ipc and preload"
```

---

### Task 7: chef service 的 group dep、五個里程碑、`start` 與 `sayToGroup`

**Files:**
- Modify: `src/main/chef/service.ts:12-18`(`ChefDeps`)、`:24`(`controlTool`)、`:65-72`(`promptFor`)、`:79-114`(`finish`)、`:115-146`(`drain`)、`:178-215`(`delegate`／`progress`／新增 `sayToGroup`／`tasksOf`／`start`)、`:250-261`(`handle` 的 start 分支)
- Test: `tests/chef-group-milestones.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SayToGroupSchema`、`GROUP_PROGRESS_LIMIT`、`GROUP_PROGRESS_TEXT_MAX`、`GROUP_REPORT_TEXT_MAX`;Task 3 的 `MSG`、`labelFor`、`roleOf`;Task 4 的 `GroupMessageInput`。
- Produces:

```ts
export interface ChefDeps {
  // 既有欄位不變,加一個選填的:
  /** 群組頻道(群組規格 §4.2)。沒給就完全沒有群組行為,其餘一模一樣。 */
  group?: {
    write(input: GroupMessageInput): void
    recent(projectId: string, threadId: string, limit: number): Promise<readonly GroupMessage[]>
  }
}

// createChefService 的回傳多四樣(progress 從同步改成 async):
tasksOf(projectId: string): readonly ChefTask[]
sayToGroup(id: string, raw: unknown): Promise<{ recorded: true; message: string }>
/** 建一個任務並開始跑,回新的 taskId。失敗丟 Error,訊息就是給人看的那句。 */
start(projectId: string, goal: string, policy: ChefPolicy): Promise<string>
progress(id: string): Promise<{ taskId: string; units: ...; attempts: ...; note: string; groupMessages: readonly { at: number; from: string; kind: GroupMessage['kind']; text: string }[] }>
```

- Task 8 的 `tools.ts` 呼叫 `sayToGroup`,並把 `progress` 改成 `await`;Task 12 的 `index.ts` 用 `tasksOf` 與 `start` 實作 `GroupChef`。
- `progress` 改成 async 的理由:重開 app 之後接續一個 blocked 任務時,主廚查 `task_progress` 正是最需要上下文的時候,同步版本看不到重開前的群組訊息。`tools.ts` 的 `call` 本來就是 async,`delegate` 與 `report` 也都已經 `await`,三家共用同一個 `call`,多一個 `await` 沒有額外成本。
- `start` 抽成內部方法的理由:群組 service 要知道新任務的 id,而 `handle({action:'start'})` 只回整份 snapshot。靠前後 diff 在兩個任務同時建立時會取錯,抽方法則不必動 IPC 契約。
- 五個時機(規格 §4.2):`delegate()` 排進新 unit、`drain()` 起一個 attempt、`finish()` unit 完成、unit 卡住、`report()` 生效;另外 attempt 結束但 unit 回到佇列時寫 `left`。
- 里程碑的 `from`:提到某個 attempt 的(`joined`／`progress`／`blocked`／`left`)用 `kind: 'agent'`,這樣畫面才畫得出跳分頁按鈕;整體性的(`delegated`／`report`)用 `kind: 'system'`。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/chef-group-milestones.test.ts
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChefService, type ChefService, type WorkerRequest } from '../src/main/chef/service.js'
import type { GroupMessageInput } from '../src/main/group/service.js'
import { MSG } from '../src/main/group/messages.js'
import type { ChefModel, ChefPolicy } from '../src/shared/chef.js'
import type { GroupMessage } from '../src/shared/group.js'

vi.setConfig({ testTimeout: 15000 })

const models: ChefModel[] = [
  { key: 'claude:c', provider: 'claude', model: 'c', label: 'Claude default', description: '', recommended: true },
  { key: 'codex:x', provider: 'codex', model: 'x', label: 'Codex default', description: '', recommended: true },
]
const roots: string[] = []
const services: ChefService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function rig(options: { writeThrows?: boolean } = {}) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'yeschef-chef-group-')))
  roots.push(root)
  const started: WorkerRequest[] = []
  const errors: Error[] = []
  const written: GroupMessageInput[] = []
  let recent: readonly GroupMessage[] = []
  const service = await createChefService({
    dir: join(root, 'tasks'),
    catalog: { list: async () => ({ models, notices: [] }) },
    rootOf: (id: string) => (id === 'p' ? root : undefined),
    busyIn: () => false,
    logError: (error: Error) => errors.push(error),
    startWorker: async (request: WorkerRequest) => {
      started.push(request)
      return { stop: async () => true }
    },
    group: {
      write: (input) => {
        if (options.writeThrows === true) throw new Error('群組寫入壞了')
        written.push(input)
      },
      recent: (_projectId, _threadId, limit) => Promise.resolve(recent.slice(-limit)),
    },
  })
  services.push(service)
  const policy: ChefPolicy = { mode: 'auto', allowed: models.map((m) => m.key), maxExecutions: 8, deadlineMinutes: 60 }
  const start = async () => {
    const result = await service.handle({ action: 'start', projectId: 'p', goal: '把整份報表補完', policy })
    expect(result.kind).toBe('state')
    await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(1))
    return started[0]!
  }
  const end = (id: string, over: Record<string, unknown> = {}) =>
    service.observe(id, [{ kind: 'session-end', isError: false, ...over } as never])
  return { root, service, started, errors, written, start, end, setRecent: (next: readonly GroupMessage[]) => { recent = next } }
}

const texts = (written: readonly GroupMessageInput[]) => written.map((w) => `${w.kind}:${w.text}`)

it('主廚起來時寫一則 joined,prompt 帶群組說明', async () => {
  const r = await rig()
  const chief = await r.start()
  expect(chief.prompt).toContain(MSG.chefPrompt)
  expect(texts(r.written)).toEqual([`joined:${MSG.joined('主廚', '規劃與執行', 'c')}`])
  expect(r.written[0]?.from).toEqual({ kind: 'agent', conversationId: chief.id, label: '主廚', provider: 'claude', role: 'chef' })
  expect(r.written[0]?.threadId).toBe(chief.taskId)
})

it('委派寫 delegated,工作者起來寫 joined,完成寫 progress', async () => {
  const r = await rig()
  const chief = await r.start()
  await r.service.delegate(chief.id, { title: '實作', kind: 'code', goal: '修改檔案' })
  expect(texts(r.written).at(-1)).toBe(`delegated:${MSG.delegated('實作', 'code')}`)
  expect(r.written.at(-1)?.from).toEqual({ kind: 'system' })

  r.end(chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const writer = r.started[1]!
  expect(texts(r.written).at(-1)).toBe(`joined:${MSG.joined('codex-1', '實作', 'x')}`)

  r.service.observe(writer.id, [
    { kind: 'tool-use', id: 'edit', name: 'Edit', input: { file_path: 'a' } },
    { kind: 'tool-result', id: 'edit', isError: false, content: 'done' },
  ])
  r.end(writer.id)
  await vi.waitFor(() => expect(texts(r.written)).toContain(`progress:${MSG.unitDone('codex-1', '實作')}`))
})

it('工作者卡住寫 blocked', async () => {
  const r = await rig()
  const chief = await r.start()
  r.service.observe(chief.id, [{ kind: 'tool-use', id: 'pending', name: 'Bash', input: { command: 'gh pr create' } }])
  r.end(chief.id)
  await vi.waitFor(() => expect(texts(r.written).some((t) => t.startsWith('blocked:'))).toBe(true))
  const blocked = r.written.find((w) => w.kind === 'blocked')!
  expect(blocked.text).toContain('主廚')
  expect(blocked.text).toContain('規劃與執行')
  expect(blocked.from).toMatchObject({ kind: 'agent', label: '主廚' })
})

it('模型故障改派時寫 left', async () => {
  const r = await rig()
  const chief = await r.start()
  r.end(chief.id, { isError: true, apiErrorStatus: 503, errorMessage: 'service unavailable' })
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const left = r.written.find((w) => w.kind === 'left')
  expect(left?.text).toContain('主廚')
  expect(left?.text).toContain('service unavailable')
})

it('任務收尾寫 report,摘要截到五百字', async () => {
  const r = await rig()
  const chief = await r.start()
  r.end(chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  const review = r.started[1]!
  await r.service.report(review.id, { outcome: 'completed', summary: '全部做完了'.repeat(200), checks: [] })
  r.end(review.id)
  await vi.waitFor(() => expect(r.written.some((w) => w.kind === 'report')).toBe(true))
  const report = r.written.find((w) => w.kind === 'report')!
  expect(report.text.startsWith('任務完成:')).toBe(true)
  expect(report.text.length).toBeLessThanOrEqual('任務完成:'.length + 500)
  expect(report.from).toEqual({ kind: 'system' })
})

it('群組寫入失敗只 logError,任務照常走完', async () => {
  const r = await rig({ writeThrows: true })
  const chief = await r.start()
  r.end(chief.id)
  await vi.waitFor(() => expect(r.started).toHaveLength(2))
  expect(r.errors.some((e) => e.message.includes('群組'))).toBe(true)
})

it('progress 帶最近的群組訊息,每則截到三百字,沒接 group dep 時是空陣列', async () => {
  const r = await rig()
  const chief = await r.start()
  r.setRecent(Array.from({ length: 3 }, (_, i) => ({
    id: `m${i}`, projectId: 'p', threadId: chief.taskId, at: i, kind: 'text' as const, mentions: [],
    from: i === 0 ? { kind: 'user' as const } : { kind: 'agent' as const, conversationId: 'c', label: 'codex-1', provider: 'codex' as const, role: 'worker' as const },
    text: 'x'.repeat(400),
  })))
  const progress = await r.service.progress(chief.id)
  expect(progress.groupMessages).toHaveLength(3)
  expect(progress.groupMessages[0]?.from).toBe('你')
  expect(progress.groupMessages[1]?.from).toBe('codex-1')
  expect(progress.groupMessages[0]?.text).toHaveLength(300)
  expect(progress.attempts).toHaveLength(1)
})

it('start 回新的 taskId,目標為空時丟錯且不留下任務', async () => {
  const r = await rig()
  const policy = { mode: 'auto' as const, allowed: models.map((m) => m.key), maxExecutions: 8, deadlineMinutes: 60 }
  const taskId = await r.service.start('p', '把整份報表補完', policy)
  expect(r.service.tasksOf('p').map((t) => t.id)).toEqual([taskId])
  await expect(r.service.start('p', '   ', policy)).rejects.toThrow('請輸入任務目標')
  expect(r.service.tasksOf('p')).toHaveLength(1)
  await expect(r.service.start('別的專案', '做點什麼', policy)).rejects.toThrow('專案已不存在')
})

it('sayToGroup 寫一則 text,不是目前執行者就拒絕', async () => {
  const r = await rig()
  const chief = await r.start()
  await r.service.sayToGroup(chief.id, { text: '我打算先補測試' })
  expect(texts(r.written).at(-1)).toBe('text:我打算先補測試')
  expect(r.written.at(-1)?.from).toMatchObject({ kind: 'agent', label: '主廚' })
  await expect(r.service.sayToGroup('不存在', { text: '嗨' })).rejects.toThrow('找不到主廚任務')
  await expect(r.service.sayToGroup(chief.id, { text: '' })).rejects.toThrow()
})

it('tasksOf 只回那個專案的任務', async () => {
  const r = await rig()
  await r.start()
  expect(r.service.tasksOf('p')).toHaveLength(1)
  expect(r.service.tasksOf('別的專案')).toHaveLength(0)
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/chef-group-milestones.test.ts`
Expected: FAIL,`service.sayToGroup is not a function` 與 `r.written` 是空的

- [ ] **Step 3: 寫最小實作**

`src/main/chef/service.ts` 的 import 區加:

```ts
import { GROUP_PROGRESS_LIMIT, GROUP_PROGRESS_TEXT_MAX, GROUP_REPORT_TEXT_MAX, SayToGroupSchema, type GroupMessage } from '../../shared/group.js'
import type { GroupMessageInput } from '../group/service.js'
import { MSG as GROUP_MSG, SYSTEM_LABEL, USER_LABEL, labelFor, roleOf } from '../group/messages.js'
```

`controlTool` 那一行加上新工具,免得它被當成實作證據:

```ts
const controlTool = (name: string) => /^(?:mcp__chef__)?(?:task_progress|delegate_task|report_result|say_to_group)$/.test(name) || name === 'ToolSearch'
```

`ChefDeps` 補一個選填欄位:

```ts
  /** 群組頻道(群組規格 §4.2)。沒給就完全沒有群組行為,其餘一模一樣。 */
  group?: { write(input: GroupMessageInput): void; recent(projectId: string, threadId: string, limit: number): Promise<readonly GroupMessage[]> }
```

`handle` 的 start 分支抽成方法。在 `cancel()` 定義後面加:

```ts
  /**
   * 建一個任務並開始跑,回新的 taskId(群組規格 §6)。
   * `handle({ action: 'start' })` 與群組頻道共用這一段,兩邊都拿得到新的 id。
   */
  async function start(projectId: string, goal: string, policy: ChefPolicy): Promise<string> {
    if (storageError) throw Error(storageError)
    const root = deps.rootOf(projectId); if (!root) throw Error('專案已不存在')
    const cwd = realpathSync.native(root)
    if (tasks.some(t => leased(t) && overlaps(t.cwd, cwd)) || deps.busyIn(cwd)) throw Error('工作目錄已有執行中的任務，請先等待或停止')
    await inventory()
    if (tasks.some(t => leased(t) && overlaps(t.cwd, cwd)) || deps.busyIn(cwd)) throw Error('工作目錄已有執行中的任務')
    if (!policy.allowed.every(key => models.some(m => m.key === key))) throw Error('模型池已變更，請重新整理模型')
    if (policy.mode !== 'auto' && !policy.allowed.includes(policy.preferred ?? '')) throw Error('請選擇模型池內的偏好／固定模型')
    const trimmed = goal.trim(); if (!trimmed) throw Error('請輸入任務目標')
    const task: ChefTask = { id: randomUUID(), projectId, cwd, goal: trimmed, followups: [], policy, status: 'queued', createdAt: now(), deadlineAt: now() + policy.deadlineMinutes * 60000, units: [{ id: randomUUID(), parentId: null, title: '規劃與執行', goal: trimmed, kind: 'analysis', status: 'queued' }], attempts: [], reason: '等待主廚選擇執行者', cancelRequested: false, needsReconciliation: false }
    tasks.push(task); await save(); void drain(task)
    return task.id
  }
```

> `ChefPolicy` 要加進 `shared/chef.js` 的 type import。原本 `handle` 裡「空目標」那條檢查在 `tasks.push` 之後才做,搬進 `start` 時提前到建物件之前:原本的順序會把目標為空的任務留在陣列裡。

`handle` 的 start 分支整段換成:

```ts
        if (request.action === 'start') { await start(request.projectId, request.goal, request.policy); return snapshot() }
```

`createChefService` 裡,`block()` 定義後面加三個工具函式:

```ts
  /** 里程碑一律不影響任務流程:寫入失敗只記 log(規格 §4.2)。 */
  function groupWrite(task: ChefTask, kind: GroupMessage['kind'], text: string, attempt?: ChefAttempt, unitId?: string) {
    if (!deps.group) return
    try {
      deps.group.write({
        projectId: task.projectId, threadId: task.id, kind, text,
        from: attempt === undefined
          ? { kind: 'system' }
          : { kind: 'agent', conversationId: attempt.workerId, label: labelFor(task, attempt), provider: attempt.provider, role: roleOf(task, attempt) },
        ...(unitId === undefined ? {} : { unitId }),
      })
    } catch (error) { deps.logError(error instanceof Error ? error : Error('群組里程碑寫入失敗')) }
  }
  /** unit 卡住的四個入口共用一條路,里程碑才不會漏寫或重複。 */
  function blockUnit(task: ChefTask, attempt: ChefAttempt, unit: ChefTask['units'][number], reason: string, uncertain = false) {
    attempt.status = 'blocked'; unit.status = 'blocked'
    groupWrite(task, 'blocked', GROUP_MSG.unitBlocked(labelFor(task, attempt), unit.title, reason), attempt, unit.id)
    block(task, reason, uncertain)
  }
  const senderLabel = (from: GroupMessage['from']): string =>
    from.kind === 'agent' ? from.label : from.kind === 'user' ? USER_LABEL : SYSTEM_LABEL
```

`promptFor` 的 return 字串尾端接上群組說明(只有接了 group dep 才有):

```ts
      `<checkpoint>\n${clipped(context, 32000)}\n</checkpoint>` +
      (deps.group === undefined ? '' : `\n${GROUP_MSG.chefPrompt}`)
```

> 原本 return 的最後一段是 ``` `...<checkpoint>\n${clipped(context, 32000)}\n</checkpoint>` ```,把它換成上面這兩行。

`finish()` 裡四處把 unit 設成 blocked 的地方改用 `blockUnit`:

```ts
      if (!confirmed || uncertain) { blockUnit(task, attempt, unit, !confirmed ? '舊執行者尚未確認停止，已禁止改派。' : '仍有背景工作或工具結果不明，請核對後接續。', true); await save(); return }
      if (attempt.denied) { blockUnit(task, attempt, unit, '工具請求被拒絕；不會透過改派繞過決定。', true); await save(); return }
```

`event.isError` 分支的兩條路:

```ts
        if (providerFailure(event) && tries.length < 3 && task.policy.mode !== 'pinned') {
          unit.status = 'queued'; task.reason = `正在改派：${attempt.reason}`
          groupWrite(task, 'left', GROUP_MSG.left(labelFor(task, attempt), attempt.reason), attempt, unit.id)
          await save()
        } else { blockUnit(task, attempt, unit, `${attempt.reason}；已保存進度，等待接續。`); await save(); return }
```

> `blockUnit` 會把 `attempt.status` 設成 `blocked`,但這條路上 `attempt.status` 已經是 `failed`。改成在 else 分支先寫里程碑再走原本的 `unit.status = 'blocked'; block(...)`:

```ts
        } else {
          unit.status = 'blocked'
          groupWrite(task, 'blocked', GROUP_MSG.unitBlocked(labelFor(task, attempt), unit.title, attempt.reason), attempt, unit.id)
          block(task, `${attempt.reason}；已保存進度，等待接續。`); await save(); return
        }
```

成功分支,`attempt.status = 'done'; unit.status = 'done'` 之後、`task.report?.unitId` 判斷之前插入:

```ts
        if (task.report?.unitId === unit.id && task.report.outcome === 'blocked') {
          unit.status = 'blocked'
          groupWrite(task, 'blocked', GROUP_MSG.unitBlocked(labelFor(task, attempt), unit.title, task.report.summary), attempt, unit.id)
          block(task, task.report.summary); await save(); return
        }
        groupWrite(task, 'progress', GROUP_MSG.unitDone(labelFor(task, attempt), unit.title), attempt, unit.id)
```

> 原本那行 `if (task.report?.unitId === unit.id && task.report.outcome === 'blocked') { unit.status = 'blocked'; block(task, task.report.summary); await save(); return }` 整段被上面取代。

任務收尾那行前面加一則 report:

```ts
          if (task.report?.unitId === unit.id && (unit.kind === 'review' || !edited)) {
            task.status = task.report.outcome; task.reason = task.report.summary
            groupWrite(task, 'report', GROUP_MSG.taskReport(task.report.outcome, task.report.summary.slice(0, GROUP_REPORT_TEXT_MAX)))
            await save(); return
          }
```

`drain()` 裡 `await save() // must be durable before spawning a worker` 的前一行加:

```ts
      groupWrite(task, 'joined', GROUP_MSG.joined(labelFor(task, attempt), unit.title, candidate.model), attempt, unit.id)
```

`delegate()` 的 `task.units.push(child); await save()` 改成:

```ts
      const child = { ...parsed.data, id: randomUUID(), parentId: unit.id, status: 'queued' as const }
      task.units.push(child)
      groupWrite(task, 'delegated', GROUP_MSG.delegated(child.title, child.kind), undefined, child.id)
      await save()
```

`progress()` 改成 async,並補一個欄位。整支換成:

```ts
    async progress(id: string) {
      const owner = current(id); if (!owner) throw Error('找不到主廚任務')
      const recent = await (deps.group?.recent(owner.task.projectId, owner.task.id, GROUP_PROGRESS_LIMIT) ?? Promise.resolve([]))
      return { taskId: owner.task.id, units: owner.task.units, attempts: owner.task.attempts.map(a => {
        const events = a.events as Event[]
        const receipts = events.filter((e): e is Extract<Event, { kind: 'tool-result' }> => e.kind === 'tool-result' && events.some(tool => tool.kind === 'tool-use' && tool.id === e.id && !controlTool(tool.name))).slice(-3).map(result => {
          const tool = events.find((e): e is Extract<Event, { kind: 'tool-use' }> => e.kind === 'tool-use' && e.id === result.id)
          return { toolUseId: result.id, name: tool?.name, input: clipped(tool?.input ?? '', 400), isError: result.isError, output: clipped(result.content, 800) }
        })
        return { workerId: a.workerId, unitId: a.unitId, provider: a.provider, model: a.actualModel ?? a.model, status: a.status, receipts }
      }), note: '每位工作者列出最近三筆工具結果；更完整內容在工作者對話。',
        groupMessages: recent.map(m => ({ at: m.at, from: senderLabel(m.from), kind: m.kind, text: m.text.slice(0, GROUP_PROGRESS_TEXT_MAX) })) }
    },
```

回傳物件補兩個方法(放在 `report` 後面):

```ts
    /** 群組規格 §6:群組要知道新任務的 id,所以建任務這段抽成方法,不靠前後 diff 猜。 */
    start,
    /** 群組規格 §4.1:主廚與工作者都能主動對群組說一句話,不觸發任何人。 */
    async sayToGroup(id: string, raw: unknown) {
      const input = SayToGroupSchema.parse(raw)
      const owner = current(id); if (!owner) throw Error('找不到主廚任務')
      groupWrite(owner.task, 'text', input.text, owner.attempt, owner.unit.id)
      return { recorded: true as const, message: '已送進專案群組。' }
    },
    tasksOf(projectId: string): readonly ChefTask[] { return tasks.filter(t => t.projectId === projectId) },
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/chef-group-milestones.test.ts tests/chef-service.test.ts && npm run typecheck`
Expected: PASS(`chef-service.test.ts` 沒給 `group` dep,行為與改動前一致)

- [ ] **Step 5: Commit**

```bash
git add src/main/chef/service.ts tests/chef-group-milestones.test.ts
git commit -m "feat: emit chef milestones into the project group"
```

---

### Task 8: `say_to_group` 工具進 `src/main/chef/tools.ts`

**Files:**
- Modify: `src/main/chef/tools.ts:6-25`
- Test: `tests/chef-view-tools.test.ts`(補)

**Interfaces:**
- Consumes: Task 1 的 `SayToGroupSchema`;Task 7 的 `ChefService.sayToGroup`。
- Produces:

```ts
export const CHEF_TOOL_NAMES = ['delegate_task', 'task_progress', 'report_result', 'say_to_group'] as const
```

- 角色開放(規格 §4.1):主廚拿得到全部四個,worker 拿得到 `task_progress` 與 `say_to_group`。一般對話分頁不是主廚管理的對話,`createChefTools` 根本不會被呼叫,所以拿不到。
- 三家共用同一份定義:Claude 走 SDK MCP(`sdkTools`)、Codex 走 `specs`、Grok 走 `call`,這個檔案已經一次產出三份,只要把名字加進 `names` 就三家都有。
- `task_progress` 那一行多一個 `await`:Task 7 把 `progress` 改成 async 了。`call` 本來就是 async,`delegate` 與 `report` 也都已經 `await`,三家零額外成本。
- `tests/chef-view-tools.test.ts` 既有的 `fakeChef` 裡 `progress: () => ({ workers: [] })` 要改成 `progress: () => Promise.resolve({ workers: [], groupMessages: [] })`,否則新的 `await` 沒有東西可等,那條斷言也測不到改動。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/chef-view-tools.test.ts:在既有 describe 裡補
it('主廚拿得到四個工具,worker 只拿得到 task_progress 與 say_to_group', () => {
  const chief = createChefTools(fakeChef('chef').service, 'w1')
  expect([...chief.names]).toEqual(['delegate_task', 'task_progress', 'report_result', 'say_to_group'])
  const worker = createChefTools(fakeChef('worker').service, 'w2')
  expect([...worker.names]).toEqual(['task_progress', 'say_to_group'])
  expect(worker.names).not.toContain('delegate_task')
  expect(worker.specs.map((s) => s.name)).toEqual(['task_progress', 'say_to_group'])
})

it('task_progress 回傳的是 async 解開後的結果,不是 Promise', async () => {
  const tools = createChefTools(fakeChef('worker').service, 'w5')
  const outcome = await tools.call('task_progress', {})
  expect(outcome.ok).toBe(true)
  expect(outcome.text).not.toContain('Promise')
  expect(JSON.parse(outcome.text)).toHaveProperty('groupMessages')
})

it('say_to_group 真的呼叫 service.sayToGroup,參數過 schema', async () => {
  const said: unknown[] = []
  const service = {
    runnable: () => true,
    worker: () => ({ role: 'worker' as const, model: 'grok-4-7', taskId: 'task-1' }),
    progress: () => Promise.resolve({ workers: [], groupMessages: [] }),
    sayToGroup: (workerId: string, args: unknown) => { said.push([workerId, args]); return Promise.resolve({ recorded: true, message: '已送進專案群組。' }) },
  } as unknown as ChefService
  const tools = createChefTools(service, 'w3')
  expect(await tools.call('say_to_group', { text: '我打算先補測試' })).toEqual({ ok: true, text: JSON.stringify({ recorded: true, message: '已送進專案群組。' }) })
  expect(said).toEqual([['w3', { text: '我打算先補測試' }]])
  const rejected = await tools.call('say_to_group', { text: '' })
  expect(rejected.ok).toBe(false)
  expect(said).toHaveLength(1)
})

it('say_to_group 的描述說清楚它不是逐步進度', () => {
  const tools = createChefTools(fakeChef('worker').service, 'w4')
  const spec = tools.specs.find((s) => s.name === 'say_to_group')
  expect(spec?.description).toContain('不用在逐步進度上')
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/chef-view-tools.test.ts -t say_to_group`
Expected: FAIL,`names` 只有三個、`call('say_to_group', ...)` 回「不支援的主廚工具」

- [ ] **Step 3: 寫最小實作**

```ts
// src/main/chef/tools.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { DelegateSchema, ChefReportSchema } from '../../shared/chef.js'
import { SayToGroupSchema } from '../../shared/group.js'
import type { ChefService } from './service.js'
import type { CodexDynamicTool, CodexToolOutcome } from '../codex/client.js'
export const CHEF_TOOL_NAMES = ['delegate_task', 'task_progress', 'report_result', 'say_to_group'] as const
const descriptions = {
  delegate_task: '把明確的子工作交給 YesChef 主廚選模型執行。只排程，等你結束本回合後才執行；不可等待或輪詢子任務。所有外部 agent 委派都用這個工具。',
  task_progress: '取得目前主廚任務的真實工作者、工作單位與工具紀錄，供交接／驗收與 report_result 引用工具 ID。',
  report_result: '主廚或驗收者回報本輪結果。完成時必須引用實作／測試工作者的成功工具結果，不能以摘要冒充驗證。仍有排程子任務時，先結束本回合讓它們執行。',
  say_to_group: '在專案群組裡對人與其他工作者說一句話。用在需要讓大家知道的事:你打算怎麼做、遇到什麼取捨、需要誰配合。不用在逐步進度上,那些會自動出現。',
}
const schemas = { delegate_task: DelegateSchema, task_progress: z.object({}).strict(), report_result: ChefReportSchema, say_to_group: SayToGroupSchema }
export function createChefTools(service: ChefService, workerId: string) {
  const call = async (name: string, args: unknown): Promise<CodexToolOutcome> => {
    try {
      if (!service.runnable(workerId)) throw Error('這個工作者已停止或不是目前執行者')
      let result: unknown
      if (name === 'delegate_task') result = await service.delegate(workerId, args)
      else if (name === 'task_progress') { schemas.task_progress.parse(args); result = await service.progress(workerId) }
      else if (name === 'report_result') result = await service.report(workerId, args)
      else if (name === 'say_to_group') result = await service.sayToGroup(workerId, args)
      else throw Error('不支援的主廚工具')
      return { ok: true, text: JSON.stringify(result) }
    } catch (error) { return { ok: false, text: error instanceof Error ? error.message : '主廚工具失敗' } }
  }
  // 工作者不該再次委派,也不該回報整個任務的結果;查進度與對群組說話兩件事對它有用。
  const names = service.worker(workerId)?.role === 'worker' ? ['task_progress', 'say_to_group'] as const : CHEF_TOOL_NAMES
  const sdkTools = names.map(name => tool(name, descriptions[name], schemas[name].shape, async args => {
    const result = await call(name, args)
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.ok ? {} : { isError: true }) }
  }))
  const server = createSdkMcpServer({ name: 'chef', version: '1.0.0', tools: sdkTools })
  const specs: CodexDynamicTool[] = names.map(name => ({ type: 'function', name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) as Record<string, unknown> }))
  return { server, specs, call, names, sdkTools }
}
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/chef-view-tools.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/chef/tools.ts tests/chef-view-tools.test.ts
git commit -m "feat: add say_to_group chef tool for chefs and workers"
```

---

### Task 9: `group` 分頁型別、開分頁流程與分頁列按鈕

**Files:**
- Modify: `src/shared/projects.ts:76`(`TabContentType`)、`:234-252`(`isTabEntry`)、加一個 `GROUP_TAB_LABEL`
- Modify: `src/main/projects-state.ts:146-159`(`openTab` 旁邊加 `openGroupTab`)
- Modify: `src/main/projects-ipc.ts:213-214`、`:303-321`
- Modify: `src/renderer/hooks/useProjects.ts:5-24`、`:104-108`
- Modify: `src/renderer/components/LeftPane.tsx`
- Test: `tests/projects-shared.test.ts`、`tests/projects-state.test.ts`、`tests/projects-ipc.test.ts`、`tests/left-pane.test.tsx`(都是補)

**Interfaces:**
- Consumes: Task 1 的 `parseGroupOpen`;Task 6 的 `IPC.groupOpen`、`YesChefApi.openGroup`。
- Produces:

```ts
// src/shared/projects.ts
export type TabContentType = 'conversation' | 'terminal' | 'group'
export const GROUP_TAB_LABEL = '群組'

// src/main/projects-state.ts
export function openGroupTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState

// src/renderer/hooks/useProjects.ts
interface Projects {
  /** 在 active 專案底下開群組分頁;已經有就切過去。 */
  openGroup(): void
}

// src/renderer/components/LeftPane.tsx
export const NEW_GROUP_LABEL = '群組'
interface LeftPaneProps {
  /** 每個群組分頁呼叫一次;沒給就不畫群組內容。 */
  readonly renderGroup?: (projectId: string) => React.ReactNode
}
```

- Task 11 的 `GroupPane` 由 `App.tsx` 經 `renderGroup` 掛進來。
- 群組分頁不帶 `threadId` 也不帶 `provider`,`conversationTabs()` 與 `activeConversationId()` 都只看 `contentType === 'conversation'`,所以主廚與 peer 的路徑一概不受影響。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/projects-shared.test.ts:在 describe('parseProjectsView') 裡補
it('收群組分頁,不收未知的 contentType', () => {
  const group = { id: 'g1', contentType: 'group', label: '群組', customLabel: null, sortOrder: 3, lastFocusedAt: 9 }
  const first = VIEW.projects[0]!
  const withGroup = { ...VIEW, projects: [{ ...first, tabs: [...first.tabs, group] }] }
  expect(parseProjectsView(withGroup)?.projects[0]?.tabs).toHaveLength(first.tabs.length + 1)
  const unknown = { ...group, contentType: 'whiteboard' }
  expect(parseProjectsView({ ...VIEW, projects: [{ ...first, tabs: [unknown] }] })).toBeNull()
})
```

```ts
// tests/projects-state.test.ts:補
import { openGroupTab } from '../src/main/projects-state.js'

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

  it('群組分頁可以關,最後一個對話分頁仍然關不掉', () => {
    const opened = openGroupTab(two, 'a', 'g1', 300)
    const closed = closeTab(opened, 'a', 'g1', 400)
    expect(findProject(closed, 'a')!.tabs.some((t) => t.contentType === 'group')).toBe(false)
    expect(closeTab(closed, 'a', 'a-conv', 500)).toBe(closed)
  })

  it('不改原 state,未知專案回原 state', () => {
    const before = JSON.stringify(two)
    openGroupTab(two, 'a', 'g1', 300)
    expect(JSON.stringify(two)).toBe(before)
    expect(openGroupTab(two, '不存在', 'g1', 300)).toBe(two)
  })
})
```

> `two`／`findProject`／`activeTabId`／`closeTab` 都是該檔既有的匯入;`two` 是 `entryA` 加 `entryB` 的雙專案 fixture,`a` 的對話分頁 id 是 `a-conv`。

```ts
// tests/projects-ipc.test.ts:補一個 describe
describe('group:open', () => {
  it('開一個群組分頁,再送一次不會多開', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.groupOpen, { projectId: 'a' })
    rig.fire(IPC.groupOpen, { projectId: 'a' })
    const tabs = findProject(rig.service.state(), 'a')!.tabs
    expect(tabs.filter((t) => t.contentType === 'group')).toHaveLength(1)
  })

  it('payload 形狀不對或專案不存在都只記錯誤,不開分頁', () => {
    const rig = makeRig(oneProject())
    rig.fire(IPC.groupOpen, 'a')
    rig.fire(IPC.groupOpen, { projectId: '不存在' })
    expect(rig.errors).toHaveLength(2)
    expect(findProject(rig.service.state(), 'a')!.tabs.some((t) => t.contentType === 'group')).toBe(false)
  })
})
```

> `makeRig(initial)` 與 `rig.fire`／`rig.errors`／`rig.service` 是該檔既有的輔助,`oneProject()` 是它的單專案 fixture,專案 id 是 `a`。

```ts
// tests/left-pane.test.tsx:補
it('分頁列有群組按鈕,按下去呼叫 openGroup', () => {
  const { projects, calls } = fakeProjects(ONE_PROJECT)
  render(<LeftPane projects={projects} endpoint={WS} renderConversation={() => <div />} />)
  fireEvent.click(screen.getByRole('button', { name: NEW_GROUP_LABEL }))
  expect(calls).toContain('openGroup')
})

it('群組分頁掛 renderGroup 的內容,切走只是 hidden 不卸載', () => {
  const withGroup = {
    activeId: 'a',
    projects: [projectView('a', {
      activeTabId: 'a-group',
      tabs: [
        { id: 'a-conv', contentType: 'conversation' as const, label: 'Claude 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 0, threadId: 'a-th' },
        { id: 'a-group', contentType: 'group' as const, label: '群組', customLabel: null, sortOrder: 1, lastFocusedAt: 5 },
      ],
    })],
  }
  const { projects } = fakeProjects(withGroup)
  render(<LeftPane projects={projects} endpoint={WS} renderConversation={() => <div />} renderGroup={(id) => <div data-testid="group">{id}</div>} />)
  expect(screen.getByTestId('group').textContent).toBe('a')
  expect(slotOf(screen.getByTestId('group')).hidden).toBe(false)
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/projects-shared.test.ts tests/projects-state.test.ts tests/projects-ipc.test.ts tests/left-pane.test.tsx`
Expected: FAIL,`openGroupTab` 不存在、`IPC.groupOpen` 沒有 handler、找不到「群組」按鈕

- [ ] **Step 3: 寫最小實作**

`src/shared/projects.ts`:

```ts
/** 三種分頁內容。`group` 一個專案最多一個,不帶 threadId 與 provider(群組規格 §8)。 */
export type TabContentType = 'conversation' | 'terminal' | 'group'
export const GROUP_TAB_LABEL = '群組'
```

`isTabEntry` 的 contentType 判斷改成:

```ts
    (type === 'conversation' || type === 'terminal' || type === 'group') &&
```

`src/main/projects-state.ts`,`openTab` 後面加:

```ts
/**
 * 群組分頁(群組規格 §8)。一個專案最多一個:已經有就只把焦點移過去,不再開第二個。
 * 不帶 threadId 與 provider,所以 `conversationTabs` 與主廚、peer 的路徑都碰不到它。
 */
export function openGroupTab(state: ProjectsState, projectId: string, tabId: string, now: number): ProjectsState {
  return updateProject(state, projectId, (p) => {
    const existing = p.tabs.find((t) => t.contentType === 'group')
    if (existing !== undefined) {
      return { ...p, tabs: p.tabs.map((t) => (t.id === existing.id ? { ...t, lastFocusedAt: now } : t)) }
    }
    const entry: TabEntry = {
      id: tabId,
      contentType: 'group',
      label: GROUP_TAB_LABEL,
      customLabel: null,
      sortOrder: nextSortOrder(p),
      lastFocusedAt: now,
    }
    return { ...p, tabs: [...p.tabs, entry] }
  })
}
```

> import 區補 `GROUP_TAB_LABEL`。

`src/main/projects-ipc.ts`:import 區補 `parseGroupOpen`(從 `../shared/group.js`)與 `openGroupTab`,`onTabOpen` 後面加:

```ts
  const onGroupOpen = onSend(IPC.groupOpen, parseGroupOpen, (p) => (s) =>
    openGroupTab(s, p.projectId, service.newId(), service.now()), tabProjectId)
```

註冊與解除各加一行:

```ts
  ipcMain.on(IPC.groupOpen, onGroupOpen)
  // ...
    ipcMain.removeListener(IPC.groupOpen, onGroupOpen)
```

`src/renderer/hooks/useProjects.ts`:`Projects` 介面加一行、`openConversation` 後面加:

```ts
  const openGroup = useCallback((): void => {
    if (activeId === null) return
    api.openGroup(activeId)
  }, [api, activeId])
```

並把 `openGroup` 加進最後的 `useMemo` 回傳物件與其依賴陣列。

`src/renderer/components/LeftPane.tsx`:

```ts
export const NEW_GROUP_LABEL = '群組'
```

`LeftPaneProps` 加:

```ts
  /** 每個群組分頁呼叫一次;沒給就不畫群組內容。 */
  readonly renderGroup?: (projectId: string) => React.ReactNode
```

`TabStrip` 的 props 與 `LeftPane` 的解構都不用改(按鈕只呼叫 `projects.openGroup()`)。在 `quick-launch` 的 `<details>` 前面插一顆按鈕:

```tsx
          <button type="button" className="tab-new-conversation" aria-label={NEW_GROUP_LABEL} title="開啟這個專案的群組" onClick={() => projects.openGroup()}>
            <Icon name="chat" />{NEW_GROUP_LABEL}
          </button>
```

`LeftPane` 的函式簽名加上 `renderGroup`,並在對話 slot 那一段後面加第三段:

```tsx
        {renderGroup === undefined ? null : view.projects.flatMap((p) =>
          p.tabs
            .filter((tab) => tab.contentType === 'group')
            .map((tab) => (
              <div key={tab.id} className="pane-slot pane-slot-group" hidden={!visible(p, tab)}>
                {renderGroup(p.id)}
              </div>
            ))
        )}
```

> `GroupPane` 在 Task 11 建立,`App.tsx` 那一行也留到 Task 11。這個 task 只把 `LeftPane` 的 `renderGroup` 接縫開好,沒給就不畫群組內容,既有畫面不變。

`tests/helpers/fake-yeschef.ts` 的 `fakeProjects` 補一行:

```ts
    openGroup: () => { calls.push('openGroup') },
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/projects-shared.test.ts tests/projects-state.test.ts tests/projects-ipc.test.ts tests/left-pane.test.tsx tests/use-projects.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/projects.ts src/main/projects-state.ts src/main/projects-ipc.ts src/renderer/hooks/useProjects.ts src/renderer/components/LeftPane.tsx tests/
git commit -m "feat: add group tab type and open flow"
```

---

### Task 10: `src/renderer/hooks/useGroup.ts`

**Files:**
- Create: `src/renderer/hooks/useGroup.ts`
- Test: `tests/use-group.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `YesChefApi.manageGroup`／`onGroupMessages`;Task 1 的 `GroupMessage`、`GroupThread`、`GENERAL_THREAD_ID`。
- Produces:

```ts
export interface Group {
  readonly messages: readonly GroupMessage[]
  readonly threads: readonly GroupThread[]
  readonly loaded: boolean
  readonly error: string | undefined
  /** 送出成功回 true;回 false 時 `error` 已經帶著原因,呼叫端自己決定要不要留住文字。 */
  send(threadId: string, text: string): Promise<boolean>
}
export type GroupApi = Pick<YesChefApi, 'manageGroup' | 'onGroupMessages'>
export function useGroup(api: GroupApi, projectId: string): Group
```

- Task 11 的 `GroupPane` 只吃這個介面。
- 先訂閱再 `get`:反過來的話,invoke 回來之前主行程推的那一批會漏掉。推播來的訊息依 `id` 去重再接在後面,`threads` 整份換掉。

- [ ] **Step 1: 寫失敗的測試**

```tsx
// tests/use-group.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useGroup, type GroupApi } from '../src/renderer/hooks/useGroup.js'
import { GENERAL_THREAD_ID, type GroupMessage, type GroupThread } from '../src/shared/group.js'
import { createFakeYesChef } from './helpers/fake-yeschef.js'

afterEach(cleanup)

const message = (id: string, projectId = 'p1'): GroupMessage => ({
  id, projectId, threadId: 't1', at: 1, from: { kind: 'user' }, kind: 'text', text: `訊息 ${id}`, mentions: [],
})
const general: GroupThread = { id: GENERAL_THREAD_ID, title: '未分派', status: 'open', createdAt: 0, participants: [] }

function Probe({ api, projectId }: { api: GroupApi; projectId: string }) {
  const group = useGroup(api, projectId)
  return (
    <>
      <output data-testid="ids">{group.messages.map((m) => m.id).join(',')}</output>
      <output data-testid="threads">{group.threads.map((t) => t.id).join(',')}</output>
      <output data-testid="loaded">{String(group.loaded)}</output>
      <output data-testid="error">{group.error ?? ''}</output>
      <button onClick={() => void group.send('t1', '哈囉')}>送出</button>
    </>
  )
}

describe('useGroup', () => {
  it('掛載就呼叫 get,把結果放進來', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockResolvedValue({ kind: 'state', messages: [message('a')], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('a'))
    expect(screen.getByTestId('threads').textContent).toBe(GENERAL_THREAD_ID)
    expect(screen.getByTestId('loaded').textContent).toBe('true')
    expect(fake.api.manageGroup).toHaveBeenCalledWith({ action: 'get', projectId: 'p1' })
  })

  it('推播的訊息接在後面,thread 整份換掉,重複的 id 不會進來兩次', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockResolvedValue({ kind: 'state', messages: [message('a')], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('a'))
    const task: GroupThread = { id: 't1', title: '補測試', status: 'running', createdAt: 10, participants: [] }
    fake.emitGroup({ projectId: 'p1', messages: [message('b')], threads: [general, task] })
    expect(screen.getByTestId('ids').textContent).toBe('a,b')
    expect(screen.getByTestId('threads').textContent).toBe(`${GENERAL_THREAD_ID},t1`)
    fake.emitGroup({ projectId: 'p1', messages: [message('b'), message('c')], threads: [general, task] })
    expect(screen.getByTestId('ids').textContent).toBe('a,b,c')
  })

  it('別的專案的推播不進來', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockResolvedValue({ kind: 'state', messages: [], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'))
    fake.emitGroup({ projectId: 'p2', messages: [message('x', 'p2')], threads: [] })
    expect(screen.getByTestId('ids').textContent).toBe('')
  })

  it('換專案時清空並重新載入', async () => {
    const fake = createFakeYesChef()
    const manage = vi.spyOn(fake.api, 'manageGroup')
    manage.mockResolvedValue({ kind: 'state', messages: [message('a')], threads: [general] })
    const { rerender } = render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('a'))
    manage.mockResolvedValue({ kind: 'state', messages: [message('z', 'p2')], threads: [general] })
    rerender(<Probe api={fake.api} projectId="p2" />)
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('z'))
    expect(manage).toHaveBeenLastCalledWith({ action: 'get', projectId: 'p2' })
  })

  it('send 送 action send;回 error 時顯示訊息', async () => {
    const fake = createFakeYesChef()
    const manage = vi.spyOn(fake.api, 'manageGroup')
    manage.mockResolvedValue({ kind: 'state', messages: [], threads: [general] })
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'))
    manage.mockResolvedValue({ kind: 'sent', threadId: 't1' })
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(manage).toHaveBeenLastCalledWith({ action: 'send', projectId: 'p1', threadId: 't1', text: '哈囉' }))
    expect(screen.getByTestId('error').textContent).toBe('')
    manage.mockResolvedValue({ kind: 'error', message: '找不到這個專案' })
    fireEvent.click(screen.getByRole('button', { name: '送出' }))
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('找不到這個專案'))
  })

  it('get 失敗時顯示錯誤,仍然算載入完成', async () => {
    const fake = createFakeYesChef()
    vi.spyOn(fake.api, 'manageGroup').mockRejectedValue(new Error('IPC 掛了'))
    render(<Probe api={fake.api} projectId="p1" />)
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('IPC 掛了'))
    expect(screen.getByTestId('loaded').textContent).toBe('true')
  })

  it('卸載解除訂閱', async () => {
    const fake = createFakeYesChef()
    const off = vi.fn()
    const original = fake.api.onGroupMessages
    vi.spyOn(fake.api, 'onGroupMessages').mockImplementation((cb) => {
      const unsubscribe = original(cb)
      return () => { off(); unsubscribe() }
    })
    const { unmount } = render(<Probe api={fake.api} projectId="p1" />)
    await act(async () => {})
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/use-group.test.tsx`
Expected: FAIL,`Cannot find module '../src/renderer/hooks/useGroup.js'`

- [ ] **Step 3: 寫最小實作**

```ts
// src/renderer/hooks/useGroup.ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { GroupMessage, GroupThread } from '../../shared/group.js'

export interface Group {
  readonly messages: readonly GroupMessage[]
  readonly threads: readonly GroupThread[]
  /** 第一份狀態到了沒。false 時畫面不顯示「還沒有訊息」,避免載入中先閃一下。 */
  readonly loaded: boolean
  readonly error: string | undefined
  /** 送出成功回 true;回 false 時 `error` 已經帶著原因。 */
  send(threadId: string, text: string): Promise<boolean>
}

export type GroupApi = Pick<YesChefApi, 'manageGroup' | 'onGroupMessages'>

const SEND_FAILED = '訊息沒有送出'
const LOAD_FAILED = '讀取群組訊息失敗'

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

interface Accumulated {
  readonly messages: readonly GroupMessage[]
  readonly threads: readonly GroupThread[]
}

const EMPTY: Accumulated = { messages: [], threads: [] }

/** 已有的 id 不再接一次:推播批次與初次 get 可能重疊。 */
function merge(previous: readonly GroupMessage[], incoming: readonly GroupMessage[]): readonly GroupMessage[] {
  const known = new Set(previous.map((m) => m.id))
  const fresh = incoming.filter((m) => !known.has(m.id))
  return fresh.length === 0 ? previous : [...previous, ...fresh]
}

/**
 * 群組頻道的 renderer 端狀態(群組規格 §7)。
 * 先訂閱再 `get`:反過來的話,invoke 回來之前主行程推的那一批會漏掉。
 */
export function useGroup(api: GroupApi, projectId: string): Group {
  const [acc, setAcc] = useState<Accumulated>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  useEffect(() => {
    let alive = true
    setAcc(EMPTY)
    setLoaded(false)
    setError(undefined)
    const unsubscribe = api.onGroupMessages((payload) => {
      if (!alive || payload.projectId !== projectId) return
      setAcc((prev) => ({ messages: merge(prev.messages, payload.messages), threads: payload.threads }))
    })
    api.manageGroup({ action: 'get', projectId })
      .then((response) => {
        if (!alive) return
        if (response.kind === 'state') {
          setAcc((prev) => ({ messages: merge(response.messages, prev.messages), threads: response.threads }))
        } else if (response.kind === 'error') {
          setError(response.message)
        }
        setLoaded(true)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        setError(messageOf(cause, LOAD_FAILED))
        setLoaded(true)
      })
    return () => { alive = false; unsubscribe() }
  }, [api, projectId])

  const send = useCallback(async (threadId: string, text: string): Promise<boolean> => {
    try {
      const response = await api.manageGroup({ action: 'send', projectId, threadId, text })
      if (!aliveRef.current) return false
      setError(response.kind === 'error' ? response.message : undefined)
      return response.kind !== 'error'
    } catch (cause) {
      if (aliveRef.current) setError(messageOf(cause, SEND_FAILED))
      return false
    }
  }, [api, projectId])

  return useMemo(
    () => ({ messages: acc.messages, threads: acc.threads, loaded, error, send }),
    [acc, loaded, error, send]
  )
}
```

> `merge(response.messages, prev.messages)` 的順序刻意是「先歷史再已推播的」:推播可能比 invoke 先到,歷史要墊在它前面。

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/use-group.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/useGroup.ts tests/use-group.test.tsx
git commit -m "feat: add useGroup hook"
```

---

### Task 11: `src/renderer/components/GroupPane.tsx` 與樣式

**Files:**
- Create: `src/renderer/components/GroupPane.tsx`
- Create: `src/renderer/components/GroupPane.css`
- Modify: `src/renderer/App.tsx`(把 `renderGroup` 接上)
- Test: `tests/group-pane.test.tsx`

**Interfaces:**
- Consumes: Task 10 的 `useGroup`、`Group`;Task 1 的 `GENERAL_THREAD_ID`、`isMilestone`;Task 9 的 `Projects.activateTab`;既有的 `formatRelativeTime`、`Icon`、`PROVIDER_LABELS`。
- Produces:

```ts
export const ALL_THREADS = 'all'
export const GROUP_PLACEHOLDER = '輸入訊息，@ 指定對象，Enter 送出，Shift+Enter 換行'
export const GROUP_EMPTY_HINT = '還沒有訊息。說一句話,主廚就會開始。'
/** 選「全部」時這則訊息要送去哪條 thread。 */
export function targetThreadOf(threads: readonly GroupThread[]): string
export interface GroupPaneProps {
  readonly api: GroupApi
  readonly projects: Pick<Projects, 'activate' | 'activateTab'>
  readonly projectId: string
  /** 測試注入,預設 `Date.now`。 */
  readonly now?: () => number
}
export function GroupPane(props: GroupPaneProps): React.ReactElement
```

- 版面三段(規格 §8):上方 thread 膠囊、中間訊息流、下方 composer。
- 捲動貼底沿用 `Conversation.tsx` 的做法:`stick` 用 ref、`useLayoutEffect` 在繪製前設 `scrollTop`,使用者往上捲就把控制權交還。
- 篩選只影響顯示;送出時送的 threadId 是「目前選中的 thread」。選「全部」時送給 `createdAt` 最大的那條 `running` thread,一條都沒在跑才送 `general` 開新目標:正在跑一個目標、切到「全部」想問一句話,不該變成開第二個目標。

- [ ] **Step 1: 寫失敗的測試**

```tsx
// tests/group-pane.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ALL_THREADS, GROUP_EMPTY_HINT, GroupPane, targetThreadOf } from '../src/renderer/components/GroupPane.js'
import { GENERAL_THREAD_ID, type GroupMessage, type GroupResponse, type GroupThread } from '../src/shared/group.js'
import { createFakeYesChef } from './helpers/fake-yeschef.js'

afterEach(cleanup)

const NOW = 1_700_000_000_000

const general: GroupThread = { id: GENERAL_THREAD_ID, title: '未分派', status: 'open', createdAt: 0, participants: [] }
const task: GroupThread = {
  id: 't1', title: '把整份報表補完', status: 'running', createdAt: 10,
  participants: [
    { label: '主廚', conversationId: 'chef-conv', provider: 'claude', role: 'chef', unitTitle: '規劃與執行' },
    { label: 'codex-1', conversationId: 'codex-conv', provider: 'codex', role: 'worker', unitTitle: '實作' },
  ],
}

const message = (over: Partial<GroupMessage>): GroupMessage => ({
  id: 'm1', projectId: 'p1', threadId: 't1', at: NOW - 60_000,
  from: { kind: 'user' }, kind: 'text', text: '先補測試', mentions: [], ...over,
})

const MESSAGES: readonly GroupMessage[] = [
  message({ id: 'm1', threadId: GENERAL_THREAD_ID, text: '還沒分派的一句' }),
  message({ id: 'm2', text: '先補測試' }),
  message({ id: 'm3', kind: 'joined', text: 'codex-1 加入,負責「實作」,用 gpt-5', from: { kind: 'agent', conversationId: 'codex-conv', label: 'codex-1', provider: 'codex', role: 'worker' } }),
]

function mount(over: { messages?: readonly GroupMessage[]; threads?: readonly GroupThread[]; onSend?: (payload: unknown) => GroupResponse } = {}) {
  const fake = createFakeYesChef()
  const calls: unknown[] = []
  vi.spyOn(fake.api, 'manageGroup').mockImplementation(async (payload) => {
    calls.push(payload)
    if (payload.action === 'get') {
      return { kind: 'state', messages: [...(over.messages ?? MESSAGES)], threads: [...(over.threads ?? [general, task])] }
    }
    return over.onSend?.(payload) ?? { kind: 'sent', threadId: 't1' }
  })
  const projectCalls: string[] = []
  const projects = {
    activate: (id: string) => { projectCalls.push(`activate:${id}`) },
    activateTab: (tabId: string, projectId?: string) => { projectCalls.push(`activateTab:${tabId}:${projectId ?? '-'}`) },
  }
  const utils = render(<GroupPane api={fake.api} projects={projects} projectId="p1" now={() => NOW} />)
  return { ...utils, fake, calls, projectCalls }
}

describe('GroupPane 的三段版面', () => {
  it('上中下三塊都在', async () => {
    const r = mount()
    await waitFor(() => expect(r.container.querySelector('.group-threads')).not.toBeNull())
    expect(r.container.querySelector('.group-stream')).not.toBeNull()
    expect(r.container.querySelector('.group-composer')).not.toBeNull()
  })

  it('thread 膠囊有全部、未分派與每個任務,任務帶狀態與人數', async () => {
    const r = mount()
    const strip = await waitFor(() => r.container.querySelector('.group-threads')!)
    const labels = [...strip.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels[0]).toBe('全部')
    expect(labels[1]).toBe('未分派')
    expect(labels[2]).toContain('把整份報表補完')
    expect(labels[2]).toContain('2 人')
  })

  it('預設顯示全部,點膠囊就篩選', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    expect(screen.getByText('還沒分派的一句')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    expect(screen.queryByText('還沒分派的一句')).toBeNull()
    expect(screen.getByText('先補測試')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText('還沒分派的一句')).toBeTruthy()
  })

  it('里程碑與一般發言用不同的 class', async () => {
    const r = mount()
    await waitFor(() => expect(r.container.querySelectorAll('.group-message')).toHaveLength(3))
    const milestone = r.container.querySelector('.group-message.is-milestone')
    expect(milestone?.textContent).toContain('codex-1 加入')
    expect(r.container.querySelectorAll('.group-message.is-milestone')).toHaveLength(1)
  })

  it('帶 conversationId 的訊息右側有跳分頁按鈕', async () => {
    const r = mount()
    const milestone = await waitFor(() => r.container.querySelector('.group-message.is-milestone')!)
    fireEvent.click(within(milestone as HTMLElement).getByRole('button', { name: '跳到 codex-1 的分頁' }))
    expect(r.projectCalls).toEqual(['activate:p1', 'activateTab:codex-conv:p1'])
  })

  it('人的訊息沒有跳分頁按鈕', async () => {
    const r = mount()
    await waitFor(() => expect(r.container.querySelectorAll('.group-message')).toHaveLength(3))
    const own = [...r.container.querySelectorAll('.group-message')].find((el) => el.textContent?.includes('先補測試'))!
    expect(within(own as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('完全沒有訊息時顯示提示', async () => {
    const r = mount({ messages: [] })
    await waitFor(() => expect(screen.getByText(GROUP_EMPTY_HINT)).toBeTruthy())
  })
})

describe('GroupPane 的 composer', () => {
  it('Enter 送出,送的是目前選中的 thread', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '再補一點' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(r.calls.at(-1)).toEqual({ action: 'send', projectId: 'p1', threadId: 't1', text: '再補一點' }))
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('選全部時送給最新的進行中目標,不開第二個', async () => {
    const older: GroupThread = { ...task, id: 't0', title: '舊目標', createdAt: 5 }
    const r = mount({ threads: [general, older, task] })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '順便問一句' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(r.calls.at(-1)).toMatchObject({ threadId: 't1' }))
  })

  it('沒有任何進行中的目標時,選全部才送 general', async () => {
    const done: GroupThread = { ...task, status: 'completed' }
    const r = mount({ threads: [general, done] })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '開個新目標' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(r.calls.at(-1)).toMatchObject({ threadId: GENERAL_THREAD_ID }))
  })

  it('targetThreadOf 只看 running,取 createdAt 最大的', () => {
    const running = (id: string, createdAt: number): GroupThread => ({ ...task, id, createdAt })
    expect(targetThreadOf([general])).toBe(GENERAL_THREAD_ID)
    expect(targetThreadOf([general, { ...task, status: 'blocked' }])).toBe(GENERAL_THREAD_ID)
    expect(targetThreadOf([general, running('a', 1), running('b', 9), running('c', 4)])).toBe('b')
  })

  it('Shift+Enter 不送出', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const before = r.calls.length
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '換行' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(r.calls).toHaveLength(before)
  })

  it('空白不送出,送出失敗時顯示錯誤且留住文字', async () => {
    const r = mount({ onSend: () => ({ kind: 'error', message: '找不到這個專案' }) })
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    const input = screen.getByLabelText('對群組說話')
    const before = r.calls.length
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(r.calls).toHaveLength(before)
    fireEvent.change(input, { target: { value: '會失敗' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('找不到這個專案'))
    expect((input as HTMLTextAreaElement).value).toBe('會失敗')
  })

  it('打 @ 會列出目前 thread 的參與者,點一個就補進輸入框', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '@co' } })
    const list = await waitFor(() => r.container.querySelector('.group-mentions')!)
    const options = [...list.querySelectorAll('button')].map((b) => b.textContent)
    expect(options).toEqual(['codex-1'])
    fireEvent.click(within(list as HTMLElement).getByRole('button', { name: 'codex-1' }))
    expect((input as HTMLTextAreaElement).value).toBe('@codex-1 ')
    expect(r.container.querySelector('.group-mentions')).toBeNull()
  })

  it('@ 後面沒有比對得上的就不顯示清單', async () => {
    const r = mount()
    await waitFor(() => expect(screen.getByText('先補測試')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /把整份報表補完/ }))
    const input = screen.getByLabelText('對群組說話')
    fireEvent.change(input, { target: { value: '@zzz' } })
    expect(r.container.querySelector('.group-mentions')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑測試,確認它失敗**

Run: `npx vitest run tests/group-pane.test.tsx`
Expected: FAIL,`Cannot find module '../src/renderer/components/GroupPane.js'`

- [ ] **Step 3: 寫最小實作**

```tsx
// src/renderer/components/GroupPane.tsx
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type React from 'react'
import { GENERAL_THREAD_ID, isMilestone, type GroupMessage, type GroupParticipant, type GroupThread } from '../../shared/group.js'
import { useGroup, type GroupApi } from '../hooks/useGroup.js'
import type { Projects } from '../hooks/useProjects.js'
import { formatRelativeTime } from './relative-time.js'
import { Icon } from './Icon.js'
import './GroupPane.css'

/** 膠囊列的「全部」不是一條真的 thread,所以用一個不會跟 ChefTask.id 撞的值。 */
export const ALL_THREADS = 'all'
export const GROUP_PLACEHOLDER = '輸入訊息，@ 指定對象，Enter 送出，Shift+Enter 換行'
export const GROUP_EMPTY_HINT = '還沒有訊息。說一句話,主廚就會開始。'

const STICK_THRESHOLD_PX = 40

/**
 * 選「全部」時這則訊息要送去哪條 thread(規格 §5 步驟 3 的延伸)。
 * 正在跑的目標裡最新的那個優先;一條都沒在跑才落到 general,由主廚開新目標。
 */
export function targetThreadOf(threads: readonly GroupThread[]): string {
  const latest = threads
    .filter((t) => t.status === 'running')
    .reduce<GroupThread | undefined>((best, t) => (best === undefined || t.createdAt > best.createdAt ? t : best), undefined)
  return latest?.id ?? GENERAL_THREAD_ID
}

const STATUS_LABELS: Readonly<Record<GroupThread['status'], string>> = {
  open: '未分派', queued: '排隊中', running: '進行中', stopping: '停止中',
  completed: '完成', blocked: '卡住', cancelled: '已取消',
}

function senderLabel(from: GroupMessage['from']): string {
  return from.kind === 'agent' ? from.label : from.kind === 'user' ? '你' : '系統'
}

function senderKey(from: GroupMessage['from']): string {
  return from.kind === 'agent' ? from.provider : from.kind
}

interface ThreadStripProps {
  readonly threads: readonly GroupThread[]
  readonly selected: string
  readonly onSelect: (id: string) => void
}

function ThreadStrip({ threads, selected, onSelect }: ThreadStripProps): React.ReactElement {
  return (
    <div className="group-threads" role="tablist" aria-label="群組目標">
      <button type="button" role="tab" aria-selected={selected === ALL_THREADS}
        className={`group-thread${selected === ALL_THREADS ? ' is-on' : ''}`}
        onClick={() => onSelect(ALL_THREADS)}>全部</button>
      {threads.map((thread) => (
        <button key={thread.id} type="button" role="tab" aria-selected={selected === thread.id}
          className={`group-thread${selected === thread.id ? ' is-on' : ''}`}
          title={thread.title}
          onClick={() => onSelect(thread.id)}>
          {thread.id === GENERAL_THREAD_ID
            ? thread.title
            : `${thread.title}（${STATUS_LABELS[thread.status]} · ${String(thread.participants.length)} 人）`}
        </button>
      ))}
    </div>
  )
}

interface MessageRowProps {
  readonly message: GroupMessage
  readonly now: number
  readonly onJump: (conversationId: string, label: string) => void
}

function MessageRow({ message, now, onJump }: MessageRowProps): React.ReactElement {
  const from = message.from
  return (
    <div className={`group-message${isMilestone(message) ? ' is-milestone' : ''}`}>
      <span className="group-from" data-from={senderKey(from)}>{senderLabel(from)}</span>
      <span className="group-at">{formatRelativeTime(message.at, now)}</span>
      <span className="group-text">{message.text}</span>
      {from.kind === 'agent' ? (
        <button type="button" className="group-jump" aria-label={`跳到 ${from.label} 的分頁`}
          onClick={() => onJump(from.conversationId, from.label)}><Icon name="forward" /></button>
      ) : null}
    </div>
  )
}

/** 游標前最後一個 `@` 之後的字;沒有就回 undefined。 */
function mentionPrefix(text: string): string | undefined {
  const at = text.lastIndexOf('@')
  if (at < 0) return undefined
  const tail = text.slice(at + 1)
  return /[\s@]/.test(tail) ? undefined : tail
}

export interface GroupPaneProps {
  readonly api: GroupApi
  readonly projects: Pick<Projects, 'activate' | 'activateTab'>
  readonly projectId: string
  /** 測試注入,預設 `Date.now`。 */
  readonly now?: () => number
}

/**
 * 群組分頁(群組規格 §8)。三段版面:上方 thread 膠囊、中間訊息流、下方 composer。
 * 捲動貼底沿用 `Conversation.tsx` 的做法:使用者往上捲之後就把控制權交還給他。
 */
export function GroupPane({ api, projects, projectId, now = Date.now }: GroupPaneProps): React.ReactElement {
  const group = useGroup(api, projectId)
  const [selected, setSelected] = useState<string>(ALL_THREADS)
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const stick = useRef(true)

  const visible = useMemo(
    () => (selected === ALL_THREADS ? group.messages : group.messages.filter((m) => m.threadId === selected)),
    [group.messages, selected]
  )
  const participants: readonly GroupParticipant[] = useMemo(
    () => group.threads.find((t) => t.id === selected)?.participants ?? [],
    [group.threads, selected]
  )
  const prefix = mentionPrefix(text)
  const suggestions = prefix === undefined
    ? []
    : participants.filter((p) => p.label.startsWith(prefix) && p.label !== prefix)

  useLayoutEffect(() => {
    const el = listRef.current
    if (el === null || !stick.current) return
    el.scrollTop = el.scrollHeight
  }, [visible])

  const onScroll = (): void => {
    const el = listRef.current
    if (el === null) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    const threadId = selected === ALL_THREADS ? targetThreadOf(group.threads) : selected
    // 送出成功才清空:失敗時文字留在框裡,人不用重打。
    void group.send(threadId, trimmed).then((sent) => { if (sent) setText('') })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  const complete = (label: string): void => {
    setText((previous) => `${previous.slice(0, previous.lastIndexOf('@'))}@${label} `)
    inputRef.current?.focus()
  }

  const jump = (conversationId: string): void => {
    projects.activate(projectId)
    projects.activateTab(conversationId, projectId)
  }

  return (
    <div className="group-pane">
      <ThreadStrip threads={group.threads} selected={selected} onSelect={setSelected} />
      <div className="group-stream" ref={listRef} onScroll={onScroll}>
        {group.loaded && visible.length === 0 ? <p className="group-empty">{GROUP_EMPTY_HINT}</p> : null}
        {visible.map((message) => (
          <MessageRow key={message.id} message={message} now={now()} onJump={jump} />
        ))}
      </div>
      <div className="group-composer">
        {group.error === undefined ? null : <p role="alert" className="group-error">{group.error}</p>}
        {suggestions.length === 0 ? null : (
          <div className="group-mentions" role="listbox" aria-label="群組成員">
            {suggestions.map((p) => (
              <button key={p.conversationId} type="button" onClick={() => complete(p.label)}>{p.label}</button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="group-input"
          aria-label="對群組說話"
          rows={3}
          value={text}
          placeholder={GROUP_PLACEHOLDER}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="group-composer-bar">
          <span className="group-hint"><kbd>Enter</kbd> 送出 <span>·</span> <kbd>Shift ↵</kbd> 換行</span>
          <button type="button" className="primary" disabled={text.trim() === ''} onClick={submit}>
            <Icon name="arrow" />送出
          </button>
        </div>
      </div>
    </div>
  )
}
```

```css
/* src/renderer/components/GroupPane.css:只用 theme.css 的 token(tests/theme-rules.test.ts)。 */
.group-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-content); }

.group-threads { display: flex; gap: 6px; padding: 8px; overflow-x: auto; border-bottom: 1px solid var(--separator); flex-shrink: 0; }
.group-thread { border-radius: 999px; white-space: nowrap; color: var(--label-2); }
.group-thread.is-on { background: var(--accent-soft); border-color: var(--accent); color: var(--label); }

.group-stream { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.group-empty { color: var(--label-3); font-size: var(--text-s); text-align: center; margin: 24px 0; }

.group-message { display: grid; grid-template-columns: auto auto 1fr auto; align-items: baseline; gap: 8px; padding: 6px 8px; border-radius: var(--radius-m); font-size: var(--text-m); color: var(--label); }
.group-message.is-milestone { background: var(--bg-raised); font-size: var(--text-xs); color: var(--label-2); }

.group-from { font-size: var(--text-xs); padding: 1px 6px; border-radius: var(--radius-s); background: var(--accent-soft); color: var(--label); }
.group-from[data-from="user"] { background: var(--accent); color: var(--accent-text); }
.group-from[data-from="system"] { background: var(--label-4); color: var(--label-2); }
.group-from[data-from="codex"] { background: color-mix(in srgb, var(--info) 22%, transparent); }
.group-from[data-from="grok"] { background: color-mix(in srgb, var(--warning) 22%, transparent); }

.group-at { font-size: var(--text-xs); color: var(--label-3); white-space: nowrap; }
.group-text { white-space: pre-wrap; word-break: break-word; }
.group-jump { min-height: 18px; padding: 0 4px; border-color: transparent; background: transparent; color: var(--label-2); }

.group-composer { border-top: 1px solid var(--separator); padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.group-error { margin: 0; color: var(--danger); font-size: var(--text-s); }
.group-mentions { display: flex; gap: 6px; flex-wrap: wrap; }
.group-input { resize: none; width: 100%; }
.group-composer-bar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.group-hint { margin-right: auto; font-size: var(--text-xs); color: var(--label-3); }
```

`src/renderer/App.tsx` 的 import 區加 `import { GroupPane } from './components/GroupPane.js'`,`<LeftPane ...>` 加:

```tsx
                  renderGroup={(projectId) => <GroupPane api={api} projects={projects} projectId={projectId} />}
```

- [ ] **Step 4: 跑測試,確認它通過**

Run: `npx vitest run tests/group-pane.test.tsx tests/theme-rules.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/GroupPane.tsx src/renderer/components/GroupPane.css src/renderer/App.tsx tests/group-pane.test.tsx
git commit -m "feat: add group pane with thread filter and mention completion"
```

---

### Task 12: `index.ts` 接線與 `docs/RESULTS-39-group-channel.md`

**Files:**
- Modify: `src/main/index.ts`(chef 建立處、bridge 建立後、IPC 註冊區、收尾區)
- Create: `docs/RESULTS-39-group-channel.md`
- Test: 無新測試。這個檔在 `vitest.config.ts` 的 coverage exclude 裡(「Electron 啟動接線，無測試縫」),驗收靠 `npm run typecheck` 加 §11 的實機項目。

**Interfaces:**
- Consumes: Task 2 的 `createGroupStore`、Task 4 的 `createGroupService`／`GroupChef`、Task 6 的 `createGroupIpcHandler`／`IPC.groupMessages`／`GROUP_CHANNEL`、Task 5 的 `bridge.deliverToManaged`、Task 7 的 `chef.tasksOf` 與 `chef.start`、Task 3 的 `MSG`。
- Produces: 沒有新的對外介面。

- [ ] **Step 1: 接線**

`src/main/index.ts` 的 import 區加:

```ts
import { GROUP_CHANNEL } from '../shared/group.js'
import { createGroupStore } from './group/store.js'
import { createGroupService, type GroupChef } from './group/service.js'
import { createGroupIpcHandler } from './group/ipc.js'
import { MSG as GROUP_MSG } from './group/messages.js'
```

`const chef = await createChefService({...})` 那一段前面先宣告 group 服務的容器,因為 chef 的 dep 要指到它、而 group 的 dep 又要指到 chef:

```ts
  // 群組頻道(群組規格 §3.2):訊息放 userData,跟同伴信箱同樣的理由,專案目錄可能被 git clean 清掉。
  let group: ReturnType<typeof createGroupService> | undefined
  const groupStore = createGroupStore(join(app.getPath('userData'), 'yeschef-group'), logError)
```

`createChefService` 的參數加一個 `group`:

```ts
    group: {
      write: (input) => { group?.write(input) },
      recent: (projectId, threadId, limit) => group?.recent(projectId, threadId, limit) ?? Promise.resolve([]),
    },
```

`bridge = createIpcBridge({...})` 之後(bridge 已經是確定的值)建立 group service:

```ts
  const groupChef: GroupChef = {
    tasksOf: (projectId) => chef?.tasksOf(projectId) ?? [],
    // 直接呼叫 chef 的 start 拿新的 taskId。不靠前後 diff 推:兩個任務同時建立時會取錯。
    start: async (projectId, goal) => {
      if (chef === undefined) return { kind: 'error', message: GROUP_MSG.noChef }
      try {
        const inventory = await chef.handle({ action: 'get' })
        if (inventory.kind !== 'state') return { kind: 'error', message: inventory.message }
        // 規格 §6:用現有的預設政策,分工表那份規格會換掉這裡。
        const allowed = inventory.state.models.map((m) => m.key)
        if (allowed.length === 0) return { kind: 'error', message: GROUP_MSG.noModels }
        const taskId = await chef.start(projectId, goal, { mode: 'auto', allowed, maxExecutions: 8, deadlineMinutes: 60 })
        return { kind: 'ok', taskId }
      } catch (error) {
        return { kind: 'error', message: error instanceof Error && error.message !== '' ? error.message : GROUP_MSG.startFailed }
      }
    },
  }
  group = createGroupService({
    store: groupStore,
    chef: groupChef,
    deliver: (projectId, conversationId, text) => bridge.deliverToManaged(projectId, conversationId, text),
    hasProject: (projectId) => service.rootPathOf(projectId) !== undefined,
    onChange: (payload) => { sendToRenderer(IPC.groupMessages, payload) },
    newId: randomUUID,
    now: Date.now,
    logError,
  })
```

IPC 註冊區(`TEST_MACHINES_CHANNEL` 旁邊)加:

```ts
  ipcMain.handle(GROUP_CHANNEL, createGroupIpcHandler({
    isTrustedSender: (sender) => sender === conversationView.webContents,
    handle: (raw) => group?.handle(raw) ?? Promise.resolve({ kind: 'error' as const, message: GROUP_MSG.noChef }),
  }))
```

收尾:`peer.dispose(); await permissions?.dispose(); await activityLedger.dispose()` 那一行改成:

```ts
      .then(async () => { peer.dispose(); await group?.dispose(); await permissions?.dispose(); await activityLedger.dispose() })
```

`win.once('closed', ...)` 的 `removeHandler` 區加一行(比照既有的 `IPC.translateRun` 那條):

```ts
    ipcMain.removeHandler(GROUP_CHANNEL)
```

- [ ] **Step 2: typecheck 與整套測試**

Run: `npm run typecheck && npm test`
Expected: 全綠

- [ ] **Step 3: 寫驗收結果骨架**

```markdown
<!-- docs/RESULTS-39-group-channel.md -->
# RESULTS-39:群組頻道

- 規格:`docs/specs/2026-09-24-group-channel-design.md`
- 計畫:`docs/superpowers/plans/2026-09-24-group-channel.md`

## 1. 單元測試

| 檔案 | 驗什麼 | 結果 |
|---|---|---|
| `tests/group-schema.test.ts` | 三種 sender、八種 kind、多餘欄位被拒、request 與 response 的每個成員 | 未驗收 |
| `tests/group-store.test.ts` | 追加後讀得回來;壞行被跳過且記一次 log;超過 2000 則只回最後 2000;超過 5 MB 裁半;同時追加不交錯 | 未驗收 |
| `tests/group-labels.test.ts` | `MSG` 的內容與 `labelFor` 的編號規則 | 未驗收 |
| `tests/group-service.test.ts` | `@` 命中送對人、沒命中補 system 且不 deliver、沒有 `@` 送主廚、general 開任務並改寫 threadId、忙碌補 system、對話不存在回 error | 未驗收 |
| `tests/group-ipc.test.ts` | sender 檢查、handle 例外收成 error | 未驗收 |
| `tests/chef-group-milestones.test.ts` | 五個時機各寫一則、內容與 label 正確、寫入失敗不影響任務流程、`progress` 帶群組訊息、`start` 回新的 taskId | 未驗收 |
| `tests/chef-view-tools.test.ts` | worker 拿得到 `task_progress` 與 `say_to_group`,拿不到 `delegate_task`;主廚四個都有 | 未驗收 |
| `tests/ipc-bridge.test.ts` | `deliverToManaged` 略過 guard、回報 busy、背景收回 | 未驗收 |
| `tests/preload-bridge.test.ts` | `manageGroup`／`onGroupMessages`／`openGroup` | 未驗收 |
| `tests/projects-state.test.ts` | 群組分頁一個專案只開一個 | 未驗收 |
| `tests/use-group.test.tsx` | 初次載入、推播接在後面、換專案清空重載 | 未驗收 |
| `tests/group-pane.test.tsx` | 三個區塊、thread 篩選、里程碑樣式、`@` 自動完成、送出、跳分頁、「全部」送給最新的進行中目標 | 未驗收 |

## 2. 實機驗收(規格 §11)

| # | 項目 | 結果 |
|---|---|---|
| 1 | 開群組分頁,打一句目標,看到「開了新目標」與主廚 `joined`,主廚開始回話 | 未驗收 |
| 2 | 主廚派工後,群組出現 `delegated` 與新工作者的 `joined`,點旁邊的按鈕跳得到那個分頁 | 未驗收 |
| 3 | 某個 worker 用 `say_to_group` 說話,群組看得到,而且主廚沒有因此跑一輪 | 未驗收 |
| 4 | `@codex-1` 說一句話,那個 agent 收到並回應,它的回應不會自動進群組 | 未驗收 |
| 5 | `@不存在的人` 說話,群組出現找不到的提示,訊息沒送出去 | 未驗收 |
| 6 | 一個 unit 完成與一個 unit 卡住,群組各出現一則對應的里程碑 | 未驗收 |
| 7 | 關掉 app 再開,群組訊息還在,thread 篩選仍正確 | 未驗收 |

驗收指令:`npm run dev`,UI 改動另附 `.spike-out/ui/` 截圖或 `npm run verify screenshots`。

## 3. 已知限制

- `task_progress` 的 `groupMessages` 第一次查某個專案時會讀一次 NDJSON,之後走記憶體。檔案裡只保留最後 2000 則,更早的訊息查不到。
- thread 的參與者含已結束的 attempt,label 保留;對已經關掉的對話 `@` 會寫進群組並顯示「對話已經關閉」,但那則訊息沒有人收到。
- 在「全部」檢視送訊息會落到最新的進行中目標;想開第二個目標要先切到「未分派」。
- 沒有 `@all`、沒有 agent 之間的自由對談、沒有訊息編輯與刪除、沒有跨專案的群組(規格 §12)。
```

- [ ] **Step 4: 再跑一次整套**

Run: `npm run typecheck && npm test`
Expected: 全綠

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts docs/RESULTS-39-group-channel.md
git commit -m "feat: wire the group channel into the main process"
```
