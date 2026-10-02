# Grok 對話:第三種 agent runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 yeschef 開 Grok 對話,能力與 Codex 對話相同:新對話、串流輸出、批准卡片、右窗格瀏覽器工具與測試機登入、worktree、歷史續接、主廚路由。

**Architecture:** 每個 Grok 對話一個 `grok agent stdio` 子行程,講 ACP(JSON-RPC 2.0 over stdio)。`src/main/codex/rpc.ts` 搬到 `src/main/jsonrpc-stdio.ts` 兩邊共用,`src/main/grok/` 放 client、mapper、conversation、catalog,形狀照 `src/main/codex/`。右窗格工具不走 in-process,改成每對話一個 localhost streamable HTTP MCP server(`src/main/view-tools/http-server.ts`),用 `session/new` 的 `mcpServers` 交給 grok。provider 的三值從一份 `PROVIDERS` 表導出,行為分支改 `Record<Provider, …>`。

**Tech Stack:** Electron 44、TypeScript 7(strict)、React 19、zod 4、vitest、`@modelcontextprotocol/sdk` 1.30.0、`@anthropic-ai/claude-agent-sdk` 0.3.258。

**Spec:** `docs/specs/2026-09-22-grok-runtime-design.md`

## Global Constraints

- TypeScript strict,既有 eslint 規則,`npm run typecheck` 與 `npm test`(vitest)每個 task 結束都要綠。
- 不新增依賴,除了 `@modelcontextprotocol/sdk` 鎖 `1.30.0` 進 dependencies。
- 程式與註解用台灣繁體中文,不用破折號,粗體一段最多一處;使用者看得到的訊息放在各模組的 `MSG` 常數。
- 檔案 800 行以內,函式 50 行以內,不 mutate 既有物件,不用 `console.log`(用 deps 的 `logError`)。
- 主行程不得把 grok 的 MCP token 寫進 log、事件、renderer。
- implementer 不 commit(controller 會 commit),但每個 task 的最後一步仍寫出 commit 訊息供 controller 使用。
- 不要跑 `npm test` 全套與 Electron spike 同時進行。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/shared/projects.ts` | 修改 | `PROVIDERS`、`Provider`、`providerSchema`、`PROVIDER_LABELS`;兩個 parse 守衛改查表 |
| `src/main/projects-schema.ts`、`src/shared/chef.ts` | 修改 | 刪掉自己的 `z.enum(['claude','codex'])`,改 import `providerSchema` |
| `src/main/view-tools/policy.ts` | 修改 | 批准政策改 `Record<Provider, readonly string[]>` |
| `src/main/chef/routing.ts` | 修改 | 偏好 provider 改查表 |
| `src/main/projects-state.ts` | 修改 | 分頁預設標籤查 `PROVIDER_LABELS` |
| `src/main/jsonrpc-stdio.ts` | 新增(搬家) | 換行分隔的 JSON-RPC,codex 與 grok 共用 |
| `src/main/codex/rpc.ts` | 刪除 | 內容搬到上一列 |
| `src/main/grok/mapper.ts` | 新增 | ACP `session/update` 轉 `Event` |
| `src/main/grok/client.ts` | 新增 | 一個對話一個 `grok agent stdio` 的生命週期 |
| `src/main/grok/conversation.ts` | 新增 | `Conversation` 介面的 grok 實作 |
| `src/main/grok/catalog.ts` | 新增 | 模型清單與 `session/list` |
| `src/main/view-tools/http-server.ts` | 新增 | 每對話一個 localhost MCP HTTP server |
| `src/main/chef/tools.ts` | 修改 | 多匯出 `sdkTools` 與 `names`,給別的 MCP server 掛用 |
| `src/main/view-tools/conversation-server.ts` | 修改 | 多一個 `chefTools` dep(grok 的 worker 專用) |
| `src/main/ipc-bridge.ts` | 修改 | `factories` 表、`grokCatalog`、`runtimeFor` 多收 provider、歷史清單來源 |
| `src/main/index.ts` | 修改 | `runtimeFor` 產 `grokViewTools`、接 `createGrokCatalog` |
| `src/main/chef/models.ts`、`src/renderer/components/ChefManager.tsx` | 修改 | 多一組 Grok 模型 |
| `src/renderer/components/LeftPane.tsx` 等五檔 | 修改 | 第三顆按鈕與 `PROVIDER_LABELS` |
| `spikes/grok-acceptance.ts`、`package.json` | 新增/修改 | `npm run spike:grok` |
| `docs/RESULTS-37-grok-runtime.md` | 新增 | 驗收結果骨架 |

---

### Task 1: `PROVIDERS` 表與行為分支收攏

**Files:**
- Modify: `src/shared/projects.ts`
- Modify: `src/main/projects-schema.ts:8`
- Modify: `src/shared/chef.ts:3,10`
- Modify: `src/main/view-tools/policy.ts`
- Modify: `src/main/chef/routing.ts:3-9`
- Modify: `src/main/projects-state.ts:170-180`
- Modify: `src/renderer/components/NewConversationForm.tsx:17`
- Modify: `src/renderer/components/ConversationPane.tsx:28,334,356,391`
- Modify: `src/renderer/components/WorkspaceHistory.tsx:24`
- Modify: `src/renderer/components/ChefManager.tsx:63`
- Test: `tests/providers.test.ts`

**Interfaces:**
- Produces(`src/shared/projects.ts`):

```ts
export const PROVIDERS: readonly ['claude', 'codex', 'grok']
export type Provider = (typeof PROVIDERS)[number]
export const providerSchema: z.ZodEnum<...>            // z.enum(PROVIDERS)
export function asProvider(raw: unknown): Provider | undefined
export const PROVIDER_LABELS: Readonly<Record<Provider, { readonly name: string; readonly tabTitle: string }>>
```

- Produces(`src/main/view-tools/policy.ts`):`viewToolPolicy(toolName: string, provider?: Provider): ToolDecision`,簽名不變,內部改查 `Record<Provider, readonly string[]>`。
- 後面每個 task 都 import `Provider` 與 `PROVIDER_LABELS`;Task 9 會再加兩張 `Record<Provider, …>`。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/providers.test.ts
import { describe, expect, it } from 'vitest'
import {
  PROVIDERS, PROVIDER_LABELS, asProvider, providerSchema,
  parseConversationOpen, parseSessionListScope,
} from '../src/shared/projects.js'
import { parseProjectsState } from '../src/main/projects-schema.js'
import { ChefModelSchema } from '../src/shared/chef.js'
import { viewToolPolicy } from '../src/main/view-tools/policy.js'
import { fullToolName } from '../src/shared/view-tools.js'
import { EMPTY_PROJECTS_STATE, type ProjectsState } from '../src/shared/projects.js'
import { addProject, openConversationTab } from '../src/main/projects-state.js'

describe('PROVIDERS 是唯一的來源', () => {
  it('三個值,順序固定', () => {
    expect(PROVIDERS).toEqual(['claude', 'codex', 'grok'])
  })

  it('providerSchema 三個都收,別的不收', () => {
    for (const p of PROVIDERS) expect(providerSchema.safeParse(p).success).toBe(true)
    expect(providerSchema.safeParse('gemini').success).toBe(false)
  })

  it('asProvider 只認得這三個', () => {
    expect(asProvider('grok')).toBe('grok')
    expect(asProvider('gemini')).toBeUndefined()
    expect(asProvider(1)).toBeUndefined()
  })

  it('PROVIDER_LABELS 對每一項都有值', () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_LABELS[p].name.length).toBeGreaterThan(0)
      expect(PROVIDER_LABELS[p].tabTitle.length).toBeGreaterThan(0)
    }
    expect(PROVIDER_LABELS.grok).toEqual({ name: 'Grok', tabTitle: 'Grok 對話' })
    // 裁決:codex 那列留小寫,既有分頁的編號才不會斷。
    expect(PROVIDER_LABELS.codex.tabTitle).toBe('codex 對話')
  })
})

describe('三處 schema 都接受 grok', () => {
  it('狀態檔的 tab.provider 與 session.provider', () => {
    const state = {
      schemaVersion: 2, activeId: 'p1', openIdsOnShutdown: [],
      projects: [{
        id: 'p1', rootPath: '/p', name: 'p', addedAt: 1, lastOpenedAt: 1, lastUrl: null,
        tabs: [{ id: 't1', contentType: 'conversation', label: 'Grok 對話', customLabel: null, sortOrder: 0, lastFocusedAt: 1, threadId: 'th1', provider: 'grok' }],
        threads: [{
          id: 'th1', handoffVersion: 0, switchPhase: { kind: 'idle' }, createdAt: 1,
          sessions: [{ linkId: 's1', provider: 'grok', sessionId: 's1', transcriptPath: null, parentLinkId: null, startedAt: 1, endedAt: null, endReason: null, models: [] }],
        }],
      }],
    }
    expect(parseProjectsState(state)).not.toBeNull()
  })

  it('ChefModelSchema 的 provider', () => {
    const model = { key: 'grok:grok-4-7', provider: 'grok', model: 'grok-4-7', label: 'Grok 4.7', description: '', recommended: true }
    expect(ChefModelSchema.safeParse(model).success).toBe(true)
  })

  it('IPC 的兩個守衛', () => {
    expect(parseConversationOpen({ projectId: 'p1', provider: 'grok' })).toEqual({ projectId: 'p1', provider: 'grok' })
    expect(parseConversationOpen({ projectId: 'p1', provider: 'gemini' })).toBeNull()
    expect(parseSessionListScope({ projectId: null, provider: 'grok' })).toEqual({ projectId: null, provider: 'grok' })
    expect(parseSessionListScope({ projectId: null, provider: 'gemini' })).toBeNull()
  })
})

describe('行為分支查表', () => {
  it('view_navigate 只有 codex 要批准', () => {
    expect(viewToolPolicy(fullToolName('view_navigate'), 'claude')).toBe('allow')
    expect(viewToolPolicy(fullToolName('view_navigate'), 'codex')).toBe('ask')
    expect(viewToolPolicy(fullToolName('view_navigate'), 'grok')).toBe('allow')
  })

  it('view_eval 三個 provider 都要批准', () => {
    for (const p of PROVIDERS) expect(viewToolPolicy(fullToolName('view_eval'), p)).toBe('ask')
  })

  it('不在白名單的名稱一律 ask', () => {
    for (const p of PROVIDERS) expect(viewToolPolicy('mcp__yeschef__view_navigate_extra', p)).toBe('ask')
  })

  it('新分頁的預設標籤照 PROVIDER_LABELS', () => {
    const added: ProjectsState = addProject(EMPTY_PROJECTS_STATE, { id: 'p1', rootPath: '/p', name: 'p', tabId: 't0', threadId: 'th0' }, 1)
    const next = openConversationTab(added, 'p1', { tabId: 't1', threadId: 'th1', provider: 'grok' }, 2)
    const tab = next.projects[0]?.tabs.find((t) => t.id === 't1')
    expect(tab?.label).toBe('Grok 對話')
    const third = openConversationTab(next, 'p1', { tabId: 't2', threadId: 'th2', provider: 'grok' }, 3)
    expect(third.projects[0]?.tabs.find((t) => t.id === 't2')?.label).toBe('Grok 對話 2')
  })
})
```

`addProject` 的參數以 `src/main/projects-state.ts` 目前的簽名為準;若它收的是別種形狀,照該檔既有測試 `tests/projects-state.test.ts` 的 helper 建初始狀態。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/providers.test.ts`
Expected: FAIL,`PROVIDERS` 不存在、`viewToolPolicy(..., 'grok')` 型別錯誤

- [ ] **Step 3: 實作 `src/shared/projects.ts`**

檔頭註解那句「不引入 Electron、zod 或 node 內建模組」改成「不引入 Electron 與 node 內建模組;zod 可以,renderer 已經因為 `shared/chef.ts` 與 `shared/test-machines.ts` 打包了它」。加 import 與下面這段,放在 `PROJECTS_SCHEMA_VERSION` 後面,並刪掉 `export type Provider = 'claude' | 'codex'`
與原本那兩行字面值的 `CONVERSATION_TAB_LABEL`、`CODEX_CONVERSATION_TAB_LABEL`(兩個名字留著,
改成從 `PROVIDER_LABELS` 導出,值一字不變,既有 import 不受影響):

```ts
import { z } from 'zod'

/** 三種對話核心。新增一種只改這一行,TypeScript 會在每張 Record 少一列時報錯。 */
export const PROVIDERS = ['claude', 'codex', 'grok'] as const
export type Provider = (typeof PROVIDERS)[number]
export const providerSchema = z.enum(PROVIDERS)

/** 外來資料轉 Provider。認不得回 undefined,呼叫端自己決定是丟棄還是退回 claude。 */
export function asProvider(raw: unknown): Provider | undefined {
  return PROVIDERS.find((known) => known === raw)
}

/**
 * 畫面上的名字。`name` 是行內標示,`tabTitle` 是新分頁的預設標籤。
 *
 * codex 那列的 `tabTitle` 是小寫的「codex 對話」,不是「Codex 對話」:既有存檔裡的
 * codex 分頁就叫這個名字,`nextConversationLabel` 的編號靠 base 逐字比對,改大寫會讓
 * 舊分頁對不上、下一個新分頁從頭編號。行內顯示一律用 `name`,所以看起來仍然是 Codex。
 */
export const PROVIDER_LABELS: Readonly<Record<Provider, { readonly name: string; readonly tabTitle: string }>> = {
  claude: { name: 'Claude', tabTitle: 'Claude 對話' },
  codex: { name: 'Codex', tabTitle: 'codex 對話' },
  grok: { name: 'Grok', tabTitle: 'Grok 對話' },
}
```

同檔兩個守衛改查表:

```ts
export function parseConversationOpen(raw: unknown): ConversationOpenPayload | null {
  if (!isRecord(raw) || !isNonEmptyString(raw['projectId'])) return null
  const provider = asProvider(raw['provider'])
  if (provider === undefined) return null
  const worktreeName = raw['worktreeName']
  if (worktreeName !== undefined && typeof worktreeName !== 'string') return null
  return { projectId: raw['projectId'], provider, ...(isNonEmptyString(worktreeName) ? { worktreeName } : {}) }
}

export function parseSessionListScope(raw: unknown): SessionListScope | null {
  if (!isRecord(raw)) return null
  const id = raw['projectId']
  const provider = raw['provider'] === undefined ? undefined : asProvider(raw['provider'])
  if (raw['provider'] !== undefined && provider === undefined) return null
  if (id !== null && !isNonEmptyString(id)) return null
  return { projectId: id, ...(provider === undefined ? {} : { provider }) }
}
```

`isTabEntry` 裡那一行 `raw['provider'] === 'claude' || raw['provider'] === 'codex'` 改成 `asProvider(raw['provider']) !== undefined`:

```ts
    (raw['provider'] === undefined || asProvider(raw['provider']) !== undefined) &&
```

- [ ] **Step 4: 實作其餘六個檔**

`src/main/projects-schema.ts`:刪掉第 8 行的 `const providerSchema = z.enum(['claude', 'codex'])`,改成 import:

```ts
import { PROJECTS_SCHEMA_VERSION, providerSchema, type ProjectsState } from '../shared/projects.js'
```

`src/shared/chef.ts`:頂端加 `import { providerSchema } from './projects.js'`,把 `ChefModelSchema` 與 `ChefAttemptSchema` 裡的 `z.enum(['claude', 'codex'])` 兩處都換成 `providerSchema`。

`src/main/view-tools/policy.ts` 整檔:

```ts
import { ANSWER_PEER_TOOL, ASK_PEER_TOOL } from '../../shared/peer-tools.js'
import { PROVIDERS, type Provider } from '../../shared/projects.js'
import { VIEW_EVAL_TOOL, VIEW_TOOL_NAMES, fullToolName } from '../../shared/view-tools.js'

/**
 * 批准政策(契約 §3)。純函式,不 import Electron。
 *
 * 白名單比對,不是前綴比對:只有右窗格工具(view_eval 除外)加兩個同伴工具的全名回
 * `'allow'`,其餘一律 `'ask'`。每個 provider 另有一張「這個核心額外要問」的表:
 * codex 的 view_navigate 要問,因為它的沙箱有網路限制,不問等於繞過;
 * grok 預設沒開沙箱,沒有同樣的繞過問題,所以與 Claude 相同(grok 規格 §7)。
 */
export type ToolDecision = 'allow' | 'ask'

const ALLOW_LIST: ReadonlySet<string> = new Set([
  ...VIEW_TOOL_NAMES.filter((name) => name !== 'view_eval').map((name) => fullToolName(name)),
  // 同伴問答不需要批准:一次呼叫只會讓另一個對話收到一段文字(P 規格 §4)。
  ASK_PEER_TOOL,
  ANSWER_PEER_TOOL,
])

/** 各核心額外要問的工具全名。少一列 TypeScript 會報錯。 */
const EXTRA_ASK: Readonly<Record<Provider, ReadonlySet<string>>> = {
  claude: new Set<string>(),
  codex: new Set<string>([fullToolName('view_navigate')]),
  grok: new Set<string>(),
}

export function viewToolPolicy(toolName: string, provider: Provider = 'claude'): ToolDecision {
  if (EXTRA_ASK[provider].has(toolName)) return 'ask'
  if (toolName === VIEW_EVAL_TOOL) return 'ask'
  return ALLOW_LIST.has(toolName) ? 'allow' : 'ask'
}

/** 測試與偵錯用:目前認得的核心。 */
export const POLICY_PROVIDERS = PROVIDERS
```

`src/main/chef/routing.ts` 的 `chooseModel`:把第 7 行的三元 `preferredProvider` 換成查表加一個「換一家」的加分,其餘不動:

```ts
import type { ChefAttempt, ChefModel, ChefPolicy } from '../../shared/chef.js'
import type { Event } from '../../shared/events.js'
import type { Provider } from '../../shared/projects.js'

/** 各種工作預設偏好哪一家。review 另外加「跟上一次不同家」的分,不寫死只有兩家。 */
const PREFERRED_BY_KIND: Readonly<Record<string, Provider>> = {
  code: 'codex', test: 'codex', analysis: 'claude', docs: 'claude', review: 'claude',
}
const DEFAULT_PREFERRED: Provider = 'claude'

export function chooseModel(models: readonly ChefModel[], policy: ChefPolicy, kind: string, attempts: readonly ChefAttempt[], lastProvider?: string): ChefModel | undefined {
  const failed = new Set(attempts.filter(a => a.status === 'failed').map(a => `${a.provider}:${a.model}`))
  const unavailableProviders = new Set(attempts.filter(a => a.status === 'failed' && /not.?logged|登入|unauthoriz|quota|額度/i.test(a.reason)).map(a => a.provider))
  const eligible = models.filter(m => policy.allowed.includes(m.key) && !unavailableProviders.has(m.provider) && !failed.has(m.key) && (policy.mode !== 'pinned' || m.key === policy.preferred))
  const preferredProvider = PREFERRED_BY_KIND[kind] ?? DEFAULT_PREFERRED
  // review 要換一雙眼睛:跟上一次同一家就不加分,不同家才加。
  const crossCheck = (m: ChefModel): number => (kind === 'review' && lastProvider !== undefined && m.provider !== lastProvider ? 10 : 0)
  const score = (m: ChefModel) => (policy.mode === 'preferred' && m.key === policy.preferred ? 100 : 0) + (m.provider === preferredProvider ? 10 : 0) + crossCheck(m) + (m.recommended ? 5 : 0) - (attempts.some(a => a.status === 'failed' && a.provider === m.provider) ? 30 : 0)
  return [...eligible].sort((a,b) => score(b) - score(a) || a.key.localeCompare(b.key))[0]
}
```

`providerFailure` 與 `backgroundResult` 不動,但 `providerFailure` 的正規表示式加 `找不到 grok`:把 `找不到 codex/i` 改成 `找不到 (?:codex|grok)/i`。

`src/main/projects-state.ts`:import 那兩個舊常數的行改成 `PROVIDER_LABELS`,`nextConversationLabel` 第一行改:

```ts
function nextConversationLabel(p: ProjectEntry, provider: Provider): string {
  const base = PROVIDER_LABELS[provider].tabTitle
```

第 41 行 `label: CONVERSATION_TAB_LABEL` 改 `label: PROVIDER_LABELS.claude.tabTitle`。

四個 renderer 檔的顯示分支:

- `NewConversationForm.tsx`:props 的 `provider?: string` 改 `provider?: Provider`(`import type { Provider } from '../../shared/projects.js'`、`import { PROVIDER_LABELS } from '../../shared/projects.js'`),第 17 行改 `{provider && <span className="new-conversation-heading">新增 {PROVIDER_LABELS[provider].name} 對話</span>}`。
- `ConversationPane.tsx`:第 28 行的 `ASSISTANT_LABEL` 刪掉,`assistantLabel={ASSISTANT_LABEL[provider]}` 改 `assistantLabel={PROVIDER_LABELS[provider].name}`;第 334 行改 `{PROVIDER_LABELS[provider].name}`;第 356 行改 `{PROVIDER_LABELS[provider].name.toUpperCase()}`;第 391 行的 `{...(provider === 'codex' ? { onStartNew: api.startNew } : {})}` 改成查表:

```ts
/** 輸入框旁邊要不要多一顆「新對話」。Claude 那側的歷史側欄已經有,不重複。 */
const SHOW_START_NEW: Readonly<Record<Provider, boolean>> = { claude: false, codex: true, grok: true }
```
```tsx
          {...(SHOW_START_NEW[provider] ? { onStartNew: api.startNew } : {})}
```

- `WorkspaceHistory.tsx` 第 24 行改 `{PROVIDER_LABELS[provider].name} 歷史`。
- `ChefManager.tsx` 第 63 行的 `{model.provider === 'claude' ? 'Claude' : 'Codex'}` 改 `{PROVIDER_LABELS[model.provider].name}`,並在檔頭 import `PROVIDER_LABELS`。

- [ ] **Step 5: 跑測試**

Run: `npx vitest run tests/providers.test.ts && npm test && npm run typecheck`
Expected: PASS。`CONVERSATION_TAB_LABEL` 與 `CODEX_CONVERSATION_TAB_LABEL` 的值沒有變,
既有逐字比對分頁標籤的測試不必改。

- [ ] **Step 6: Commit**

```bash
git add src/shared/projects.ts src/main/projects-schema.ts src/shared/chef.ts src/main/view-tools/policy.ts src/main/chef/routing.ts src/main/projects-state.ts src/renderer/components tests/providers.test.ts
git commit -m "refactor: derive provider enums and behaviour tables from PROVIDERS"
```

---

### Task 2: `codex/rpc.ts` 搬到 `jsonrpc-stdio.ts`

**Files:**
- Create: `src/main/jsonrpc-stdio.ts`(內容來自 `src/main/codex/rpc.ts`)
- Delete: `src/main/codex/rpc.ts`
- Modify: `src/main/codex/client.ts:14`、`src/main/codex/catalog.ts:7`、`src/main/chef/models.ts:3`
- Test: `tests/jsonrpc-stdio.test.ts`(由 `tests/codex-rpc.test.ts` 搬家)

**Interfaces:**
- Produces(`src/main/jsonrpc-stdio.ts`),匯出名稱與原本逐字相同:

```ts
export interface CodexIo { write(line: string): void; onLine(cb: (line: string) => void): void }
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>
export interface CodexRpc {
  request<T>(method: string, params?: unknown, timeout?: number | null): Promise<T>
  notify(method: string, params?: unknown): void
  onServerRequest(handler: ServerRequestHandler): void
  onNotification(handler: (method: string, params: unknown) => void): void
  rejectAll(reason: Error): void
}
export const UNKNOWN_METHOD_CODE = -32601
export function createRpc(io: CodexIo, logError: (error: Error) => void, timeoutMs?: number): CodexRpc
```

- Task 4、Task 7 都從 `src/main/jsonrpc-stdio.ts` import `createRpc` 與 `CodexIo`。

- [ ] **Step 1: 搬檔案與測試**

```bash
git mv src/main/codex/rpc.ts src/main/jsonrpc-stdio.ts
git mv tests/codex-rpc.test.ts tests/jsonrpc-stdio.test.ts
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/jsonrpc-stdio.test.ts`
Expected: FAIL,`tests/jsonrpc-stdio.test.ts` 還在 import `../src/main/codex/rpc.js`

- [ ] **Step 3: 改四處 import 與檔頭註解**

`tests/jsonrpc-stdio.test.ts` 第 2 行:

```ts
import { createRpc, UNKNOWN_METHOD_CODE, type CodexIo } from '../src/main/jsonrpc-stdio.js'
```

`src/main/codex/client.ts` 第 14 行:

```ts
import { createRpc, type CodexIo } from '../jsonrpc-stdio.js'
```

`src/main/codex/catalog.ts` 第 7 行:

```ts
import { createRpc } from '../jsonrpc-stdio.js'
```

`src/main/chef/models.ts` 第 3 行:

```ts
import { createRpc } from '../jsonrpc-stdio.js'
```

`src/main/jsonrpc-stdio.ts` 的檔頭註解首行改成:

```ts
/**
 * 換行分隔的 stdio JSON-RPC:一行一則訊息。`codex app-server` 與 `grok agent stdio`
 * 兩邊共用這一層。
 *
 * 這一層只管框幀與配對,不認得任何一邊的方法名。三條規則:
```

其餘註解與程式碼一字不改(錯誤訊息裡的「codex」保留:它描述的是 stdio 對端,兩邊的
log 都認得,改字會讓既有測試的斷言失效)。

- [ ] **Step 4: 跑測試**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/jsonrpc-stdio.ts src/main/codex src/main/chef/models.ts tests/jsonrpc-stdio.test.ts
git commit -m "refactor: move stdio json-rpc out of the codex folder"
```

---

### Task 3: `grok/mapper.ts`

**Files:**
- Create: `src/main/grok/mapper.ts`
- Test: `tests/grok-mapper.test.ts`

**Interfaces:**
- Consumes:`src/shared/events.ts` 的 `Event`
- Produces:

```ts
export interface GrokMapper {
  /** 一個回合的開始:換 messageId、重設區塊計數。userInput 與 openHistory 各呼叫一次。 */
  beginTurn(): void
  /** ACP 的通知。method 是原始方法名,含 `_x.ai/` 開頭的那些。 */
  accept(method: string, params: unknown): readonly Event[]
  /** `session/prompt` 的回應。回合結束的唯一依據(規格 §5.3)。 */
  promptFinished(stopReason: string | undefined): readonly Event[]
  /** 目前生效的模型;`_x.ai/session_notification` 的 model_changed 會改它。 */
  model(): string | undefined
}
export function createGrokMapper(sessionId: string, initialModel?: string): GrokMapper
export const GROK_PLAN_TITLE = '計畫'
```

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/grok-mapper.test.ts
import { describe, expect, it } from 'vitest'
import { createGrokMapper, GROK_PLAN_TITLE } from '../src/main/grok/mapper.js'
import type { Event } from '../src/shared/events.js'

/** 探測 grok 1.0.40 時抓下來的通知形狀(規格 §3)。 */
const UPDATE = (update: unknown): unknown => ({ sessionId: 's-1', update })

const TEXT_CHUNK = UPDATE({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } })
const TEXT_CHUNK_2 = UPDATE({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ',世界' } })
const THOUGHT_CHUNK = UPDATE({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看 README' } })
const USER_CHUNK = UPDATE({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '幫我看 README' } })
const TOOL_CALL = UPDATE({
  sessionUpdate: 'tool_call', toolCallId: 'call-1', title: '讀取 README.md', kind: 'read',
  status: 'pending', rawInput: { path: 'README.md' },
})
const TOOL_DONE = UPDATE({
  sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text: '# yeschef' } }],
  rawOutput: { stdout: '# yeschef\n', stderr: '', exitCode: 0 },
})
const TOOL_FAILED = UPDATE({
  sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed',
  content: [{ type: 'content', content: { type: 'text', text: 'ENOENT' } }],
})
const TOOL_RUNNING = UPDATE({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' })
const PLAN = UPDATE({
  sessionUpdate: 'plan',
  entries: [
    { content: '讀 README', priority: 'high', status: 'in_progress' },
    { content: '改 mapper', priority: 'medium', status: 'pending' },
  ],
})
const COMMANDS = UPDATE({
  sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'init', description: '初始化專案' }],
})
const NONSENSE = UPDATE({ sessionUpdate: 'quantum_flux', payload: 1 })

/**
 * 探測時抓到的真實形狀:與 `session/update` 同一種外形(`update.sessionUpdate`),
 * 只是 method 不同、模型欄位叫 `model_id`。
 */
const MODEL_CHANGED = {
  sessionId: 's-1',
  update: { sessionUpdate: 'model_changed', model_id: 'grok-4-fast', reasoning_effort: 'high' },
}
const HOOK_EXECUTION = {
  sessionId: 's-1',
  update: { sessionUpdate: 'hook_execution', name: 'pre_commit', status: 'running' },
}
const MCP_STATUS = {
  sessionId: 's-1', name: 'weather', status: 'unavailable',
  reason: 'connect_failed', detail: 'ECONNREFUSED 127.0.0.1:9',
}

function rig(model?: string) {
  const mapper = createGrokMapper('s-1', model)
  mapper.beginTurn()
  const out: Event[] = []
  const feed = (method: string, params: unknown): readonly Event[] => {
    const events = mapper.accept(method, params)
    out.push(...events)
    return events
  }
  return { mapper, out, feed, update: (params: unknown) => feed('session/update', params) }
}

describe('文字與思考', () => {
  it('第一個 chunk 先發 message-start,messageId 是 grok-<sessionId>-<turn>', () => {
    const r = rig('grok-4-7')
    expect(r.update(TEXT_CHUNK)).toEqual([
      { kind: 'message-start', messageId: 'grok-s-1-1', model: 'grok-4-7' },
      { kind: 'block-start', messageId: 'grok-s-1-1', index: 0, blockType: 'text' },
      { kind: 'text-delta', messageId: 'grok-s-1-1', index: 0, text: '你好' },
    ])
  })

  it('同一個區塊的後續 chunk 只有 delta', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.update(TEXT_CHUNK_2)).toEqual([
      { kind: 'text-delta', messageId: 'grok-s-1-1', index: 0, text: ',世界' },
    ])
  })

  it('文字換到思考:先 block-stop 再開新 index', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.update(THOUGHT_CHUNK)).toEqual([
      { kind: 'block-stop', messageId: 'grok-s-1-1', index: 0 },
      { kind: 'block-start', messageId: 'grok-s-1-1', index: 1, blockType: 'thinking' },
      { kind: 'thinking-delta', messageId: 'grok-s-1-1', index: 1, text: '先看 README' },
    ])
  })

  it('beginTurn 換一個 messageId,index 從 0 重數', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    r.mapper.promptFinished('end_turn')
    r.mapper.beginTurn()
    expect(r.update(TEXT_CHUNK)).toEqual([
      { kind: 'message-start', messageId: 'grok-s-1-2' },
      { kind: 'block-start', messageId: 'grok-s-1-2', index: 0, blockType: 'text' },
      { kind: 'text-delta', messageId: 'grok-s-1-2', index: 0, text: '你好' },
    ])
  })

  it('user_message_chunk 只在重播出現,畫成 user-text', () => {
    const r = rig()
    expect(r.update(USER_CHUNK)).toEqual([{ kind: 'user-text', text: '幫我看 README' }])
  })
})

describe('工具', () => {
  it('tool_call 用 title 當名稱,rawInput 當參數,並收掉開著的文字區塊', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.update(TOOL_CALL)).toEqual([
      { kind: 'block-stop', messageId: 'grok-s-1-1', index: 0 },
      { kind: 'tool-use', messageId: 'call-1', index: 0, id: 'call-1', name: '讀取 README.md', input: { path: 'README.md' } },
    ])
  })

  it('沒有 title 時用 kind', () => {
    const r = rig()
    const events = r.update(UPDATE({ sessionUpdate: 'tool_call', toolCallId: 'c9', kind: 'execute', rawInput: {} }))
    expect(events).toEqual([{ kind: 'tool-use', messageId: 'c9', index: 0, id: 'c9', name: 'execute', input: {} }])
  })

  it('completed 成對回 tool-result,rawOutput 有 stdout 時另發 tool-raw-output', () => {
    const r = rig()
    r.update(TOOL_CALL)
    expect(r.update(TOOL_DONE)).toEqual([
      { kind: 'tool-result', id: 'call-1', content: [{ type: 'content', content: { type: 'text', text: '# yeschef' } }], isError: false },
      { kind: 'tool-raw-output', id: 'call-1', stdout: '# yeschef\n', stderr: '', interrupted: false },
    ])
  })

  it('failed 是錯誤;沒有 rawOutput 就不發 tool-raw-output', () => {
    const r = rig()
    expect(r.update(TOOL_FAILED)).toEqual([
      { kind: 'tool-result', id: 'call-2', content: [{ type: 'content', content: { type: 'text', text: 'ENOENT' } }], isError: true },
    ])
  })

  it('in_progress 不產生事件', () => {
    expect(rig().update(TOOL_RUNNING)).toEqual([])
  })
})

describe('計畫與雜訊', () => {
  it('plan 畫成一段條列文字,不做新事件種類', () => {
    const r = rig()
    expect(r.update(PLAN)).toEqual([
      { kind: 'text', text: `${GROK_PLAN_TITLE}\n- 讀 README\n- 改 mapper` },
    ])
  })

  it('available_commands_update 與 _x.ai/* 不產生 unknown', () => {
    const r = rig()
    expect(r.update(COMMANDS)).toEqual([])
    expect(r.feed('_x.ai/mcp/server_status', MCP_STATUS)).toEqual([])
    expect(r.feed('_x.ai/session/setup', { sessionId: 's-1', phase: 'mcp_merge' })).toEqual([])
    expect(r.feed('_x.ai/announcements/update', { items: [] })).toEqual([])
    expect(r.out.some((e) => e.kind === 'unknown')).toBe(false)
  })

  it('session_notification 的 model_changed 影響下一個 message-start', () => {
    const r = rig('grok-4-7')
    expect(r.feed('_x.ai/session_notification', MODEL_CHANGED)).toEqual([])
    expect(r.mapper.model()).toBe('grok-4-fast')
    r.mapper.promptFinished('end_turn')
    r.mapper.beginTurn()
    expect(r.update(TEXT_CHUNK)[0]).toEqual({ kind: 'message-start', messageId: 'grok-s-1-2', model: 'grok-4-fast' })
  })

  it('看不懂的 sessionUpdate 才是 unknown', () => {
    const r = rig()
    expect(r.update(NONSENSE)).toEqual([
      { kind: 'unknown', raw: { sessionUpdate: 'quantum_flux', payload: 1 } },
    ])
  })

  it('session_notification 的 hook_execution 忽略,也不動模型', () => {
    const r = rig('grok-4-7')
    expect(r.feed('_x.ai/session_notification', HOOK_EXECUTION)).toEqual([])
    expect(r.mapper.model()).toBe('grok-4-7')
  })

  it('同樣的 sessionUpdate 名稱走 session/update 時仍是 unknown:兩個 method 不共用表', () => {
    const r = rig()
    expect(r.update(MODEL_CHANGED)).toEqual([
      { kind: 'unknown', raw: MODEL_CHANGED.update },
    ])
  })

  it('params 不是物件、或沒有 update 欄位:前者忽略,後者 unknown', () => {
    const r = rig()
    expect(r.update('壞掉的東西')).toEqual([])
    expect(r.update({ sessionId: 's-1' })).toEqual([{ kind: 'unknown', raw: { sessionId: 's-1' } }])
  })
})

describe('回合結束', () => {
  it('promptFinished 收掉開著的區塊再發 session-end', () => {
    const r = rig()
    r.update(TEXT_CHUNK)
    expect(r.mapper.promptFinished('end_turn')).toEqual([
      { kind: 'block-stop', messageId: 'grok-s-1-1', index: 0 },
      { kind: 'session-end', isError: false },
    ])
  })

  it('cancelled 也算正常結束', () => {
    expect(rig().mapper.promptFinished('cancelled')).toEqual([{ kind: 'session-end', isError: false }])
  })

  it('沒有 stopReason 也結束', () => {
    expect(rig().mapper.promptFinished(undefined)).toEqual([{ kind: 'session-end', isError: false }])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/grok-mapper.test.ts`
Expected: FAIL,找不到 `../src/main/grok/mapper.js`

- [ ] **Step 3: 實作**

```ts
// src/main/grok/mapper.ts
/**
 * grok 的 ACP 通知翻成 yeschef 的 `Event`(grok 規格 §5.3)。
 *
 * 分界規則與 codex 那側一致:`_x.ai/*` 與 `available_commands_update` 與對話內容無關,
 * 回空陣列;認得是 `session/update` 但 `sessionUpdate` 不在表上的才回一則 `unknown`。
 *
 * grok 的 chunk 不帶訊息 id,所以 messageId 由這裡合成:`grok-<sessionId>-<turn>`。
 * 文字與思考各自佔一個區塊,index 在回合內遞增;工具沿用 codex 的做法,
 * messageId 就是 toolCallId、index 固定 0,畫面上那顆 block 才對得回來。
 */
import type { Event } from '../../shared/events.js'

export const GROK_PLAN_TITLE = '計畫'

export interface GrokMapper {
  beginTurn(): void
  accept(method: string, params: unknown): readonly Event[]
  promptFinished(stopReason: string | undefined): readonly Event[]
  model(): string | undefined
}

type BlockType = 'text' | 'thinking'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const unknownEvent = (raw: unknown): readonly Event[] => [{ kind: 'unknown', raw }]

/** ACP 的 content block。第一版只認文字;圖片與其他型別當看不懂。 */
function chunkText(update: Record<string, unknown>): string | undefined {
  const content = asRecord(update['content'])
  if (content === null || content['type'] !== 'text') return undefined
  return typeof content['text'] === 'string' ? content['text'] : undefined
}

/**
 * `_x.ai/session_notification` 的 model_changed。探測到的形狀與 `session/update` 同一種外形,
 * 只是 method 不同、模型欄位叫 `model_id`:
 * `{ sessionId, update: { sessionUpdate: 'model_changed', model_id, reasoning_effort } }`。
 * 同一個 method 也會送 `hook_execution`,那一種沒有東西可畫,回 undefined 就是忽略。
 */
function changedModel(params: unknown): string | undefined {
  const update = asRecord(asRecord(params)?.['update'])
  if (update === null || update['sessionUpdate'] !== 'model_changed') return undefined
  return str(update['model_id'])
}

export function createGrokMapper(sessionId: string, initialModel?: string): GrokMapper {
  let model = initialModel
  let turn = 0
  let messageId = `grok-${sessionId}-0`
  let started = false
  let nextIndex = 0
  let open: { readonly index: number; readonly type: BlockType } | null = null

  const closeOpen = (): readonly Event[] => {
    if (open === null) return []
    const event: Event = { kind: 'block-stop', messageId, index: open.index }
    open = null
    return [event]
  }

  /** 開一個文字或思考區塊,必要時先發 message-start、先收掉型別不同的前一塊。 */
  const head = (type: BlockType): readonly Event[] => {
    const before: Event[] = []
    if (!started) {
      started = true
      before.push({ kind: 'message-start', messageId, ...(model === undefined ? {} : { model }) })
    }
    if (open !== null && open.type === type) return before
    const closed = closeOpen()
    const index = nextIndex
    nextIndex += 1
    open = { index, type }
    return [...before, ...closed, { kind: 'block-start', messageId, index, blockType: type }]
  }

  const toolCall = (update: Record<string, unknown>): readonly Event[] => {
    const id = str(update['toolCallId'])
    if (id === undefined) return unknownEvent(update)
    const name = str(update['title']) ?? str(update['kind']) ?? 'tool'
    return [...closeOpen(), { kind: 'tool-use', messageId: id, index: 0, id, name, input: update['rawInput'] ?? null }]
  }

  const toolUpdate = (update: Record<string, unknown>): readonly Event[] => {
    const id = str(update['toolCallId'])
    if (id === undefined) return unknownEvent(update)
    const status = str(update['status'])
    // 只有結束的那一則要畫;in_progress 與純粹改標題的更新不產生事件。
    if (status !== 'completed' && status !== 'failed') return []
    const raw = asRecord(update['rawOutput'])
    const stdout = raw === null ? undefined : str(raw['stdout'])
    const result: Event = {
      kind: 'tool-result', id,
      content: update['content'] ?? update['rawOutput'] ?? null,
      isError: status === 'failed',
    }
    if (stdout === undefined) return [result]
    const stderr = raw === null ? undefined : str(raw['stderr'])
    return [result, { kind: 'tool-raw-output', id, stdout, stderr: stderr ?? '', interrupted: false }]
  }

  const plan = (update: Record<string, unknown>): readonly Event[] => {
    const entries = Array.isArray(update['entries']) ? update['entries'] : []
    const lines = entries.flatMap((entry: unknown) => {
      const content = str(asRecord(entry)?.['content'])
      return content === undefined ? [] : [`- ${content}`]
    })
    return lines.length === 0 ? [] : [...closeOpen(), { kind: 'text', text: `${GROK_PLAN_TITLE}\n${lines.join('\n')}` }]
  }

  const sessionUpdate = (params: unknown): readonly Event[] => {
    const record = asRecord(params)
    if (record === null) return []
    const update = asRecord(record['update'])
    if (update === null) return unknownEvent(params)
    switch (update['sessionUpdate']) {
      case 'agent_message_chunk': {
        const text = chunkText(update)
        if (text === undefined) return unknownEvent(update)
        const before = head('text')
        return [...before, { kind: 'text-delta', messageId, index: open?.index ?? 0, text }]
      }
      case 'agent_thought_chunk': {
        const text = chunkText(update)
        if (text === undefined) return unknownEvent(update)
        const before = head('thinking')
        return [...before, { kind: 'thinking-delta', messageId, index: open?.index ?? 0, text }]
      }
      case 'user_message_chunk': {
        const text = chunkText(update)
        return text === undefined ? unknownEvent(update) : [{ kind: 'user-text', text }]
      }
      case 'tool_call':
        return toolCall(update)
      case 'tool_call_update':
        return toolUpdate(update)
      case 'plan':
        return plan(update)
      // 斜線指令清單與對話內容無關,畫出來只會洗版。
      case 'available_commands_update':
        return []
      default:
        return unknownEvent(update)
    }
  }

  return {
    beginTurn() {
      turn += 1
      messageId = `grok-${sessionId}-${turn}`
      started = false
      nextIndex = 0
      open = null
    },
    accept(method, params) {
      if (method === 'session/update') return sessionUpdate(params)
      if (method === '_x.ai/session_notification') {
        const next = changedModel(params)
        if (next !== undefined) model = next
        return []
      }
      // `_x.ai/*` 的其餘通知與任何認不得的方法都不進對話;它們的內容由 client 寫 log。
      return []
    },
    promptFinished() {
      // `session/prompt` 的回應是回合結束的唯一依據,cancelled 也算結束(規格 §5.3)。
      return [...closeOpen(), { kind: 'session-end', isError: false }]
    },
    model: () => model,
  }
}
```

- [ ] **Step 4: 跑測試**

Run: `npx vitest run tests/grok-mapper.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/grok/mapper.ts tests/grok-mapper.test.ts
git commit -m "feat: map grok acp updates to yeschef events"
```

---

### Task 4: `grok/client.ts`

**Files:**
- Create: `src/main/grok/client.ts`
- Test: `tests/grok-client.test.ts`

**Interfaces:**
- Consumes:Task 2 的 `createRpc`、`CodexIo`(`src/main/jsonrpc-stdio.js`)
- Produces:

```ts
export interface GrokProcess {
  write(line: string): void
  closeStdin(): void
  kill(): void
  onLine(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  onError(cb: (error: Error) => void): void
  onExit(cb: (code: number | null) => void): void
}
export type SpawnGrok = (cwd: string, model?: string) => GrokProcess

export const MSG: Readonly<{ noGrok: string; loginFirst: string; noSessionId: string; notStarted: string }>
export const MSG_NO_GROK: string                       // 'PATH 找不到 grok,請先安裝'
export function withGrokAuthHint(message: string): string
export const nodeSpawnGrok: SpawnGrok

export interface GrokModel { readonly id: string; readonly name: string; readonly reasoningEfforts: readonly string[] }
export interface AcpMcpServer {
  readonly name: string
  readonly type: 'http'
  readonly url: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
}
export interface PromptBlock { readonly type: 'text'; readonly text: string }
export interface PromptResult { readonly stopReason: string | undefined }
export interface PermissionOption { readonly optionId: string; readonly name: string; readonly kind: string }
export interface PermissionRequest {
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly rawInput: unknown
  readonly options: readonly PermissionOption[]
}
export type PermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

export interface GrokClientDeps {
  readonly cwd: string
  readonly mcpServers: readonly AcpMcpServer[]
  readonly model?: string
  /** 有給就用 `session/load` 續接,沒給就 `session/new`(規格 §5.4 的 openHistory)。 */
  readonly resume?: string
  readonly onUpdate: (method: string, params: unknown) => void
  readonly onPermission: (request: PermissionRequest) => Promise<PermissionOutcome>
  readonly onStderr: (line: string) => void
  readonly onExit: (code: number | null) => void
  readonly logError: (error: Error) => void
  readonly spawn?: SpawnGrok
  readonly requestTimeoutMs?: number
  readonly killDelayMs?: number
}

export interface GrokClient {
  readonly sessionId: string
  prompt(blocks: readonly PromptBlock[]): Promise<PromptResult>
  cancel(): Promise<void>
  close(): Promise<void>
  models(): readonly GrokModel[]
  isRunning(): boolean
}

export function createGrokClient(deps: GrokClientDeps): Promise<GrokClient>
```

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/grok-client.test.ts
import { describe, expect, it, vi } from 'vitest'
import {
  createGrokClient, MSG, MSG_NO_GROK, withGrokAuthHint,
  type AcpMcpServer, type GrokClientDeps, type GrokProcess, type PermissionOutcome, type PermissionRequest, type SpawnGrok,
} from '../src/main/grok/client.js'

const MCP: AcpMcpServer = {
  name: 'yeschef', type: 'http', url: 'http://127.0.0.1:51234/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer tok-abc' }],
}

/** 探測 grok 1.0.40 抓下來的 initialize 回應(規格 §3)。 */
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
  mcpCapabilities: { http: true, sse: true },
  sessionCapabilities: { list: true, resume: true, close: true },
  authMethods: [{ id: 'cached_token', name: '快取的 token', description: '讀 ~/.grok/auth.json' }],
  _meta: {
    modelState: {
      currentModelId: 'grok-4-7',
      availableModels: [
        { id: 'grok-4-7', name: 'Grok 4.7', reasoningEfforts: ['low', 'high'] },
        { id: 'grok-4-fast', name: 'Grok 4 Fast', reasoningEfforts: ['low'] },
      ],
    },
  },
}

const PERMISSION_PARAMS = {
  sessionId: 's-1',
  toolCall: { toolCallId: 'call-2', title: '執行 npm test', kind: 'execute', rawInput: { command: 'npm test' } },
  options: [
    { optionId: 'allow', name: '允許一次', kind: 'allow_once' },
    { optionId: 'allow-always', name: '總是允許', kind: 'allow_always' },
    { optionId: 'reject', name: '拒絕', kind: 'reject_once' },
    { optionId: 'reject-always', name: '總是拒絕', kind: 'reject_always' },
  ],
}

interface Fake {
  readonly sent: Array<Record<string, unknown>>
  readonly killed: string[]
  say(obj: unknown): void
  reply(method: string, result: unknown): void
  failWith(method: string, error: unknown): void
  fail(error: Error): void
  exit(code: number | null): void
  stderr(text: string): void
}

function makeSpawn(): { spawn: SpawnGrok; fake: () => Fake; args: Array<[string, string | undefined]> } {
  const args: Array<[string, string | undefined]> = []
  let current: Fake | null = null
  const spawn: SpawnGrok = (cwd, model) => {
    args.push([cwd, model])
    const sent: Array<Record<string, unknown>> = []
    const killed: string[] = []
    let onLine: (c: string) => void = () => {}
    let onStderr: (c: string) => void = () => {}
    let onError: (error: Error) => void = () => {}
    let onExit: (code: number | null) => void = () => {}
    const proc: GrokProcess = {
      write: (line) => { sent.push(JSON.parse(line) as Record<string, unknown>) },
      closeStdin: () => { killed.push('closeStdin') },
      kill: () => { killed.push('kill') },
      onLine: (cb) => { onLine = cb },
      onStderr: (cb) => { onStderr = cb },
      onError: (cb) => { onError = cb },
      onExit: (cb) => { onExit = cb },
    }
    const find = (method: string): Record<string, unknown> => {
      const hit = [...sent].reverse().find((s) => s['method'] === method)
      if (hit === undefined) throw new Error(`還沒送出 ${method}`)
      return hit
    }
    current = {
      sent, killed,
      say: (obj) => { onLine(`${JSON.stringify(obj)}\n`) },
      reply: (method, result) => { onLine(`${JSON.stringify({ jsonrpc: '2.0', id: find(method)['id'], result })}\n`) },
      failWith: (method, error) => { onLine(`${JSON.stringify({ jsonrpc: '2.0', id: find(method)['id'], error })}\n`) },
      fail: (error) => { onError(error) },
      exit: (code) => { onExit(code) },
      stderr: (text) => { onStderr(text) },
    }
    return proc
  }
  return { spawn, fake: () => { if (current === null) throw new Error('還沒 spawn'); return current }, args }
}

function setup(over: Partial<GrokClientDeps> = {}) {
  const s = makeSpawn()
  const errors: string[] = []
  const stderrLines: string[] = []
  const updates: Array<[string, unknown]> = []
  const exits: Array<number | null> = []
  const permissions: PermissionRequest[] = []
  let answer: (outcome: PermissionOutcome) => void = () => {}
  const deps: GrokClientDeps = {
    cwd: '/p/alpha',
    mcpServers: [MCP],
    logError: (e) => { errors.push(e.message) },
    onUpdate: (method, params) => { updates.push([method, params]) },
    onStderr: (line) => { stderrLines.push(line) },
    onExit: (code) => { exits.push(code) },
    onPermission: (request) => {
      permissions.push(request)
      return new Promise<PermissionOutcome>((resolve) => { answer = resolve })
    },
    spawn: s.spawn,
    killDelayMs: 5,
    ...over,
  }
  const pending = createGrokClient(deps)
  const waitFor = (method: string): Promise<Record<string, unknown>> => vi.waitFor(() => {
    const hit = s.fake().sent.find((entry) => entry['method'] === method)
    if (hit === undefined) throw new Error(`還沒送出 ${method}`)
    return hit
  })
  const boot = async (sessionId = 's-1'): Promise<Awaited<typeof pending>> => {
    await waitFor('initialize')
    s.fake().reply('initialize', INITIALIZE_RESULT)
    const opened = over.resume === undefined ? 'session/new' : 'session/load'
    await waitFor(opened)
    s.fake().reply(opened, over.resume === undefined ? { sessionId, models: {} } : {})
    return pending
  }
  const replyTo = (id: unknown): Record<string, unknown> => {
    const hit = s.fake().sent.find((entry) => entry['id'] === id && ('result' in entry || 'error' in entry))
    if (hit === undefined) throw new Error(`還沒回覆 ${String(id)}`)
    return hit
  }
  return { ...s, errors, stderrLines, updates, exits, permissions, pending, waitFor, boot, replyTo, answer: (o: PermissionOutcome) => { answer(o) } }
}

describe('啟動', () => {
  it('initialize → session/new 的順序與參數', async () => {
    const r = setup()
    const init = await r.waitFor('initialize')
    expect(init['params']).toMatchObject({ protocolVersion: 1 })
    expect(r.args[0]).toEqual(['/p/alpha', undefined])
    r.fake().reply('initialize', INITIALIZE_RESULT)
    const opened = await r.waitFor('session/new')
    expect(opened['params']).toEqual({ cwd: '/p/alpha', mcpServers: [MCP] })
    r.fake().reply('session/new', { sessionId: 's-1', models: {} })
    const client = await r.pending
    expect(client.sessionId).toBe('s-1')
    expect(client.models()).toEqual([
      { id: 'grok-4-7', name: 'Grok 4.7', reasoningEfforts: ['low', 'high'] },
      { id: 'grok-4-fast', name: 'Grok 4 Fast', reasoningEfforts: ['low'] },
    ])
  })

  it('有 model 時帶進 spawn', async () => {
    const r = setup({ model: 'grok-4-fast' })
    await r.boot()
    expect(r.args[0]).toEqual(['/p/alpha', 'grok-4-fast'])
  })

  it('resume 走 session/load,參數帶 sessionId、cwd 與 mcpServers', async () => {
    const r = setup({ resume: 's-old' })
    r.fake // 觸發 spawn
    await r.waitFor('initialize')
    r.fake().reply('initialize', INITIALIZE_RESULT)
    const loaded = await r.waitFor('session/load')
    expect(loaded['params']).toEqual({ sessionId: 's-old', cwd: '/p/alpha', mcpServers: [MCP] })
    r.fake().reply('session/load', {})
    await expect(r.pending.then((c) => c.sessionId)).resolves.toBe('s-old')
  })

  it('找不到 grok:reject 成 MSG_NO_GROK,不留下子行程', async () => {
    const r = setup()
    await r.waitFor('initialize')
    r.fake().fail(Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' }))
    await expect(r.pending).rejects.toThrow(MSG_NO_GROK)
    expect(r.fake().killed).toContain('kill')
  })

  it('session/new 失敗且訊息含 auth:前面補一句 grok login,並收掉子行程', async () => {
    const r = setup()
    await r.waitFor('initialize')
    r.fake().reply('initialize', INITIALIZE_RESULT)
    await r.waitFor('session/new')
    r.fake().failWith('session/new', { code: -32000, message: 'unauthorized: run grok login' })
    await expect(r.pending).rejects.toThrow(MSG.loginFirst)
    expect(r.fake().killed).toContain('kill')
  })

  it('沒有 sessionId 的回應也算失敗', async () => {
    const r = setup()
    await r.waitFor('initialize')
    r.fake().reply('initialize', INITIALIZE_RESULT)
    await r.waitFor('session/new')
    r.fake().reply('session/new', { models: {} })
    await expect(r.pending).rejects.toThrow(MSG.noSessionId)
  })
})

describe('回合', () => {
  it('prompt 送 session/prompt 並回 stopReason', async () => {
    const r = setup()
    const client = await r.boot()
    const turn = client.prompt([{ type: 'text', text: '你好' }])
    const sent = await r.waitFor('session/prompt')
    expect(sent['params']).toEqual({ sessionId: 's-1', prompt: [{ type: 'text', text: '你好' }] })
    r.fake().reply('session/prompt', { stopReason: 'end_turn' })
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('cancel 送 session/cancel 通知', async () => {
    const r = setup()
    const client = await r.boot()
    await client.cancel()
    const sent = await r.waitFor('session/cancel')
    expect(sent['params']).toEqual({ sessionId: 's-1' })
    expect(sent['id']).toBeUndefined()
  })

  it('close 先送 session/close 再收掉子行程', async () => {
    const r = setup()
    const client = await r.boot()
    const closing = client.close()
    await r.waitFor('session/close')
    r.fake().reply('session/close', { _meta: { 'x.ai/closeOutcome': 'closed' } })
    await closing
    expect(r.fake().killed).toEqual(['closeStdin', 'kill'])
    expect(client.isRunning()).toBe(false)
  })
})

describe('通知與批准', () => {
  it('自己 sessionId 的 session/update 往上送,別人的丟棄並記 log', async () => {
    const r = setup()
    await r.boot()
    const mine = { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '嗨' } } }
    r.fake().say({ jsonrpc: '2.0', method: 'session/update', params: mine })
    r.fake().say({ jsonrpc: '2.0', method: 'session/update', params: { ...mine, sessionId: 's-other' } })
    await vi.waitFor(() => { expect(r.updates).toHaveLength(1) })
    expect(r.updates[0]).toEqual(['session/update', mine])
    expect(r.errors.some((e) => e.includes('s-other'))).toBe(true)
  })

  it('`_x.ai/*` 通知原樣往上送,不做 sessionId 過濾以外的處理', async () => {
    const r = setup()
    await r.boot()
    const params = { sessionId: 's-1', notification: { type: 'model_changed', model: 'grok-4-fast' } }
    r.fake().say({ jsonrpc: '2.0', method: '_x.ai/session_notification', params })
    await vi.waitFor(() => { expect(r.updates).toEqual([['_x.ai/session_notification', params]]) })
  })

  it('request_permission 轉 onPermission,回覆帶 optionId', async () => {
    const r = setup()
    await r.boot()
    r.fake().say({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: PERMISSION_PARAMS })
    await vi.waitFor(() => { expect(r.permissions).toHaveLength(1) })
    expect(r.permissions[0]).toEqual({
      toolCallId: 'call-2', title: '執行 npm test', kind: 'execute',
      rawInput: { command: 'npm test' }, options: PERMISSION_PARAMS.options,
    })
    r.answer({ outcome: 'selected', optionId: 'allow' })
    await vi.waitFor(() => { expect(r.replyTo(77)['result']).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } }) })
  })

  it('close 之後才回來的批准回 cancelled', async () => {
    const r = setup()
    const client = await r.boot()
    r.fake().say({ jsonrpc: '2.0', id: 78, method: 'session/request_permission', params: PERMISSION_PARAMS })
    await vi.waitFor(() => { expect(r.permissions).toHaveLength(1) })
    const closing = client.close()
    await r.waitFor('session/close')
    r.fake().reply('session/close', {})
    await closing
    r.answer({ outcome: 'selected', optionId: 'allow' })
    await vi.waitFor(() => { expect(r.replyTo(78)['result']).toEqual({ outcome: { outcome: 'cancelled' } }) })
  })

  it('stderr 一行一行進 onStderr,不進 onUpdate', async () => {
    const r = setup()
    await r.boot()
    r.fake().stderr('WARN mcp server weather unavailable\nERROR connect failed\n')
    expect(r.stderrLines).toEqual(['WARN mcp server weather unavailable', 'ERROR connect failed'])
    expect(r.updates).toHaveLength(0)
  })

  it('子行程自己結束時通知 onExit', async () => {
    const r = setup()
    await r.boot()
    r.fake().exit(1)
    expect(r.exits).toEqual([1])
  })
})

describe('withGrokAuthHint', () => {
  it('三個關鍵字任一個出現就補提示,原文保留', () => {
    expect(withGrokAuthHint('Unauthorized')).toBe(`${MSG.loginFirst}(Unauthorized)`)
    expect(withGrokAuthHint('auth token expired')).toBe(`${MSG.loginFirst}(auth token expired)`)
    expect(withGrokAuthHint('please login first')).toBe(`${MSG.loginFirst}(please login first)`)
    expect(withGrokAuthHint('磁碟已滿')).toBe('磁碟已滿')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/grok-client.test.ts`
Expected: FAIL,找不到 `../src/main/grok/client.js`

- [ ] **Step 3: 實作**

```ts
// src/main/grok/client.ts
/**
 * 一個 grok 對話的子行程生命週期(grok 規格 §5.2)。
 *
 * 一個對話一個 `grok agent stdio`,cwd 是那個對話的工作目錄。開場兩步:
 * `initialize` → `session/new`(或 `session/load`)。`session/load` 的重播可能很久,
 * 所以不設逾時;`session/prompt` 同理。
 *
 * stderr 是 tracing 格式的 log,含全域 MCP server 連不上的 ERROR。它不是致命錯誤,
 * 一行一行交給 `onStderr`,由上層寫 log,不進對話(規格 §3)。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createRpc, type CodexIo } from '../jsonrpc-stdio.js'

/** 子行程的最小介面。真的實作見檔尾的 `nodeSpawnGrok`,測試接假的。 */
export interface GrokProcess {
  write(line: string): void
  closeStdin(): void
  kill(): void
  onLine(cb: (chunk: string) => void): void
  onStderr(cb: (chunk: string) => void): void
  /** 子行程或它的 stdin 出錯。沒有監聽的話 Node 會把它變成未捕捉例外。 */
  onError(cb: (error: Error) => void): void
  onExit(cb: (code: number | null) => void): void
}

export type SpawnGrok = (cwd: string, model?: string) => GrokProcess

export const MSG = {
  noGrok: 'PATH 找不到 grok,請先安裝',
  loginFirst: '請先在終端機執行 `grok login`',
  noSessionId: 'grok 沒有回 sessionId',
  notStarted: 'grok 尚未啟動,這則訊息未送出',
} as const

export const MSG_NO_GROK = MSG.noGrok

/** grok 回的錯誤裡出現這三個字之一就當成未登入(規格 §5.2)。原文保留,它指得出端點。 */
const AUTH_HINTS = ['auth', 'login', 'unauthorized']

export function withGrokAuthHint(message: string): string {
  const lower = message.toLowerCase()
  return AUTH_HINTS.some((hint) => lower.includes(hint)) ? `${MSG.loginFirst}(${message})` : message
}

export interface GrokModel {
  readonly id: string
  readonly name: string
  readonly reasoningEfforts: readonly string[]
}

/** 交給 grok 的 MCP server 設定。第一版只用 http 這一種形狀(規格 §6.3)。 */
export interface AcpMcpServer {
  readonly name: string
  readonly type: 'http'
  readonly url: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
}

export interface PromptBlock { readonly type: 'text'; readonly text: string }
export interface PromptResult { readonly stopReason: string | undefined }

export interface PermissionOption { readonly optionId: string; readonly name: string; readonly kind: string }

export interface PermissionRequest {
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly rawInput: unknown
  readonly options: readonly PermissionOption[]
}

export type PermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

export interface GrokClientDeps {
  readonly cwd: string
  readonly mcpServers: readonly AcpMcpServer[]
  readonly model?: string
  /** 有給就用 `session/load` 續接,沒給就 `session/new`。 */
  readonly resume?: string
  /** 每一則通知原樣往上送,由 mapper 決定畫什麼。 */
  readonly onUpdate: (method: string, params: unknown) => void
  readonly onPermission: (request: PermissionRequest) => Promise<PermissionOutcome>
  readonly onStderr: (line: string) => void
  readonly onExit: (code: number | null) => void
  readonly logError: (error: Error) => void
  readonly spawn?: SpawnGrok
  readonly requestTimeoutMs?: number
  readonly killDelayMs?: number
}

export interface GrokClient {
  readonly sessionId: string
  prompt(blocks: readonly PromptBlock[]): Promise<PromptResult>
  cancel(): Promise<void>
  close(): Promise<void>
  models(): readonly GrokModel[]
  isRunning(): boolean
}

const DEFAULT_KILL_DELAY_MS = 2000
const PERMISSION_METHOD = 'session/request_permission'
const CANCELLED: PermissionOutcome = { outcome: 'cancelled' }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** `initialize` 回應的 `_meta.modelState.availableModels`。拿不到就回空陣列。 */
function readModels(result: unknown): readonly GrokModel[] {
  const state = asRecord(asRecord(asRecord(result)?.['_meta'])?.['modelState'])
  const list = state === null ? undefined : state['availableModels']
  if (!Array.isArray(list)) return []
  return list.flatMap((entry: unknown): readonly GrokModel[] => {
    const record = asRecord(entry)
    const id = record === null ? undefined : str(record['id'])
    if (record === null || id === undefined) return []
    const efforts = record['reasoningEfforts']
    return [{
      id,
      name: str(record['name']) ?? id,
      reasoningEfforts: Array.isArray(efforts) ? efforts.filter((e): e is string => typeof e === 'string') : [],
    }]
  })
}

function readOptions(raw: unknown): readonly PermissionOption[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: unknown): readonly PermissionOption[] => {
    const record = asRecord(entry)
    const optionId = record === null ? undefined : str(record['optionId'])
    if (record === null || optionId === undefined) return []
    return [{ optionId, name: str(record['name']) ?? optionId, kind: str(record['kind']) ?? '' }]
  })
}

export function createGrokClient(deps: GrokClientDeps): Promise<GrokClient> {
  const spawnGrok = deps.spawn ?? nodeSpawnGrok
  const killDelayMs = deps.killDelayMs ?? DEFAULT_KILL_DELAY_MS
  const proc = spawnGrok(deps.cwd, deps.model)
  const io: CodexIo = { write: (line) => { proc.write(line) }, onLine: (cb) => { proc.onLine(cb) } }
  const rpc = createRpc(io, deps.logError, deps.requestTimeoutMs)

  let sessionId: string | null = null
  let models: readonly GrokModel[] = []
  let alive = true
  let started = false
  let stopped = false
  let closing = false
  let exited: () => void = () => {}
  let stderrBuffer = ''

  const detach = (code: number | null, reason: Error): void => {
    exited()
    if (!alive) return
    alive = false
    rpc.rejectAll(reason)
    // 開場失敗由 boot 的 catch 統一回報,不重複通知上層。
    if (started) deps.onExit(code)
  }

  proc.onStderr((chunk) => {
    stderrBuffer += chunk
    let at = stderrBuffer.indexOf('\n')
    while (at >= 0) {
      const line = stderrBuffer.slice(0, at).trim()
      stderrBuffer = stderrBuffer.slice(at + 1)
      if (line !== '') deps.onStderr(line)
      at = stderrBuffer.indexOf('\n')
    }
  })
  proc.onError((error) => {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    detach(null, missing ? new Error(MSG.noGrok) : new Error(error.message))
  })
  proc.onExit((code) => { detach(code, new Error(`grok 子行程已結束(code ${code ?? 'null'})`)) })

  /** 這則訊息是不是屬於自己的 session。還沒拿到 id 前一律算是。 */
  const mine = (params: unknown): boolean => {
    const target = str(asRecord(params)?.['sessionId'])
    return sessionId === null || target === undefined || target === sessionId
  }

  rpc.onNotification((method, params) => {
    if (!mine(params)) {
      deps.logError(new Error(`grok 送來不是這個 session 的 ${method}(${String(asRecord(params)?.['sessionId'])}),已丟棄`))
      return
    }
    deps.onUpdate(method, params)
  })

  const handlePermission = async (params: unknown): Promise<unknown> => {
    if (!mine(params)) {
      deps.logError(new Error(`grok 的 ${PERMISSION_METHOD} 不屬於這個 session,回 cancelled`))
      return { outcome: CANCELLED }
    }
    const toolCall = asRecord(asRecord(params)?.['toolCall']) ?? {}
    const outcome = await deps.onPermission({
      toolCallId: str(toolCall['toolCallId']) ?? '',
      title: str(toolCall['title']) ?? '',
      kind: str(toolCall['kind']) ?? '',
      rawInput: toolCall['rawInput'] ?? null,
      options: readOptions(asRecord(params)?.['options']),
    })
    // 回覆之前對話被收掉:一律 cancelled,不讓已經沒人管的工具跑起來(規格 §5.2)。
    return { outcome: closing || !alive ? CANCELLED : outcome }
  }

  rpc.onServerRequest(async (method, params) => {
    if (method === PERMISSION_METHOD) return await handlePermission(params)
    // 認不得的請求交給 rpc 回錯誤;不回覆會讓 grok 的回合永遠等下去。
    throw new Error(`不認得的 grok 請求 ${method}`)
  })

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    closing = true
    // 先裝等待器再關 stdin,同步退出也不會漏接。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, killDelayMs)
      exited = () => { clearTimeout(timer); resolve() }
      proc.closeStdin()
    })
    proc.kill()
    detach(null, new Error('grok 子行程已收掉'))
  }

  const client: GrokClient = {
    get sessionId() { return sessionId ?? '' },
    prompt: async (blocks) => {
      if (!alive || sessionId === null) throw new Error(MSG.notStarted)
      const result = await rpc.request<unknown>('session/prompt', { sessionId, prompt: [...blocks] }, null)
      return { stopReason: str(asRecord(result)?.['stopReason']) }
    },
    cancel: () => {
      if (alive && sessionId !== null) rpc.notify('session/cancel', { sessionId })
      return Promise.resolve()
    },
    close: async () => {
      closing = true
      if (alive && sessionId !== null) {
        try {
          await rpc.request<unknown>('session/close', { sessionId })
        } catch (cause) {
          deps.logError(cause instanceof Error ? cause : new Error(String(cause)))
        }
      }
      await stop()
    },
    models: () => models,
    isRunning: () => alive && !stopped,
  }

  const open = async (): Promise<void> => {
    const params = { cwd: deps.cwd, mcpServers: [...deps.mcpServers] }
    if (deps.resume !== undefined) {
      // 先記下 id,重播的 session/update 才通得過 mine()。重播可能很久,不設逾時。
      sessionId = deps.resume
      await rpc.request<unknown>('session/load', { sessionId: deps.resume, ...params }, null)
      return
    }
    const opened = await rpc.request<unknown>('session/new', params)
    const id = str(asRecord(opened)?.['sessionId'])
    if (id === undefined) throw new Error(MSG.noSessionId)
    sessionId = id
  }

  const boot = async (): Promise<GrokClient> => {
    const initialize = await rpc.request<unknown>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'yeschef', version: '0.0.0' },
      // 規格 §10:檔案與終端機的 client 能力一律 false,grok 自己做。
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    models = readModels(initialize)
    await open()
    started = true
    return client
  }

  return boot().catch(async (cause: unknown) => {
    await stop()
    const error = cause instanceof Error ? cause : new Error(String(cause))
    throw new Error(withGrokAuthHint(error.message), { cause: error })
  })
}

/** 真的起一個 `grok agent stdio`。沒有單元測試,行為靠 spike 與實機驗收(規格 §11)。 */
export const nodeSpawnGrok: SpawnGrok = (cwd, model) => {
  const args = ['agent', 'stdio', ...(model === undefined ? [] : ['--model', model])]
  const child = nodeSpawn('grok', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false
  let report: (error: Error) => void = () => {}
  // ChildProcess 與 stdin 的 error 必須接住;spawn 失敗只發 error 不發 exit。
  child.on('error', (error) => { closed = true; report(error) })
  child.stdin?.on('error', (error) => { closed = true; report(error) })
  return {
    write: (line) => { if (!closed) child.stdin?.write(line) },
    closeStdin: () => { closed = true; child.stdin?.end() },
    kill: () => { closed = true; child.kill('SIGTERM') },
    onLine: (cb) => { child.stdout?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onStderr: (cb) => { child.stderr?.on('data', (d: Buffer) => { cb(String(d)) }) },
    onError: (cb) => { report = cb },
    onExit: (cb) => { child.on('exit', (code) => { closed = true; cb(code) }) },
  }
}
```

- [ ] **Step 4: 跑測試**

Run: `npx vitest run tests/grok-client.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/grok/client.ts tests/grok-client.test.ts
git commit -m "feat: run one grok agent stdio process per conversation"
```

---

### Task 5: 每對話一個 localhost MCP HTTP server

**Files:**
- Create: `src/main/view-tools/http-server.ts`
- Modify: `package.json`(`dependencies` 加 `@modelcontextprotocol/sdk`)
- Test: `tests/view-tools-http-server.test.ts`

**Interfaces:**
- Consumes:`src/main/view-tools/conversation-server.ts` 的 `ConversationViewServer`(`server: McpSdkServerConfigWithInstance`、`invoke`、`dispose`)
- Produces:

```ts
export interface ViewToolHttpServer {
  /** 交給 grok 的位址,例:`http://127.0.0.1:51234/mcp`。 */
  readonly url: string
  /** 只出現在 `session/new` 的 headers,不寫檔、不進 log、不進 renderer、不進事件。 */
  readonly token: string
  close(): Promise<void>
}
export const HTTP_MSG: Readonly<{ unauthorized: string; notFound: string; noPort: string }>
export function startViewToolHttpServer(
  view: ConversationViewServer,
  logError: (error: Error) => void,
): Promise<ViewToolHttpServer>
```

Transport 必須用 stateful 模式(`sessionIdGenerator` 有值):`@modelcontextprotocol/sdk` 1.30.0 的
stateless transport 第二次 `handleRequest` 會丟「Stateless transport cannot be reused across requests」。
`enableJsonResponse: true` 讓回應是單純 JSON,不必解 SSE。

- [ ] **Step 1: 加依賴**

`package.json` 的 `dependencies` 在 `@anthropic-ai/claude-agent-sdk` 後面加一行(鎖版本,不加 `^`):

```json
    "@modelcontextprotocol/sdk": "1.30.0",
```

Run: `npm install --no-save=false` 之後確認 `npm ls @modelcontextprotocol/sdk` 只有一份 `1.30.0`,`node_modules` 沒有多出第二份。

- [ ] **Step 2: 寫失敗的測試**

```ts
// tests/view-tools-http-server.test.ts
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversationViewServer } from '../src/main/view-tools/conversation-server.js'
import { HTTP_MSG, startViewToolHttpServer, type ViewToolHttpServer } from '../src/main/view-tools/http-server.js'
import type { ViewTools } from '../src/main/view-tools/server.js'
import { VIEW_TOOL_NAMES } from '../src/shared/view-tools.js'

interface Reply { readonly status: number; readonly body: string; readonly sessionId: string | undefined }

interface CallOptions {
  readonly token?: string | null
  readonly host?: string
  readonly path?: string
  readonly sessionId?: string
  readonly payload?: unknown
}

/** 用 node:http 而不是 fetch:fetch 不讓呼叫端自己設 Host,而 Host 正是要驗的東西。 */
function call(port: number, options: CallOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.payload === undefined ? '' : JSON.stringify(options.payload)
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: options.path ?? '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
        ...(options.token === null || options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.sessionId === undefined ? {} : { 'mcp-session-id': options.sessionId }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const header = res.headers['mcp-session-id']
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), sessionId: typeof header === 'string' ? header : undefined })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

function fakeTools(): ViewTools {
  return {
    invoke: vi.fn(() => Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: '快照好了' } })),
    handoffDone: vi.fn(), abortPending: vi.fn(), busy: () => false, dispose: () => Promise.resolve(),
  }
}

let running: ViewToolHttpServer | undefined
afterEach(async () => { await running?.close(); running = undefined })

async function start() {
  const logError = vi.fn()
  const view = createConversationViewServer({ resolve: () => Promise.resolve(fakeTools()), logError })
  const server = await startViewToolHttpServer(view, logError)
  running = server
  const port = Number(new URL(server.url).port)
  return { server, port, token: server.token, logError, view }
}

async function handshake(port: number, token: string): Promise<string> {
  const init = await call(port, {
    token,
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok', version: '1.0.40' } } },
  })
  expect(init.status).toBe(200)
  const sessionId = init.sessionId
  expect(sessionId).toBeDefined()
  await call(port, { token, sessionId, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } })
  return sessionId as string
}

describe('三道檢查', () => {
  it('url 綁 127.0.0.1,token 夠長且是 base64url', async () => {
    const { server } = await start()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('沒有 Authorization:401,回的是純文字不是 MCP 錯誤', async () => {
    const { port } = await start()
    const reply = await call(port, { token: null, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    expect(reply.status).toBe(401)
    expect(reply.body).toBe(HTTP_MSG.unauthorized)
  })

  it('token 不對:401', async () => {
    const { port } = await start()
    expect((await call(port, { token: 'wrong-token', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401)
  })

  it('Host 不是 127.0.0.1:<port>:401(擋 DNS rebinding)', async () => {
    const { port, token } = await start()
    expect((await call(port, { token, host: 'yeschef.evil.test', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401)
    expect((await call(port, { token, host: `localhost:${port}`, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401)
  })

  it('路徑不是 /mcp:404', async () => {
    const { port, token } = await start()
    const reply = await call(port, { token, path: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    expect(reply.status).toBe(404)
    expect(reply.body).toBe(HTTP_MSG.notFound)
  })

  it('401 與 404 都不留下 log:被擋下來是預期行為,不是故障', async () => {
    const { port, logError } = await start()
    await call(port, { token: null, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    await call(port, { token: 'x', path: '/other' })
    expect(logError).not.toHaveBeenCalled()
  })
})

describe('MCP 本體', () => {
  it('handshake 之後 tools/list 看得到全部的右窗格工具', async () => {
    const { port, token } = await start()
    const sessionId = await handshake(port, token)
    const listed = await call(port, { token, sessionId, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } })
    expect(listed.status).toBe(200)
    const names = (JSON.parse(listed.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    for (const name of VIEW_TOOL_NAMES) expect(names).toContain(name)
  })

  it('tools/call 打到同一份 invoke', async () => {
    const { port, token, view } = await start()
    const sessionId = await handshake(port, token)
    const invoked = vi.spyOn(view, 'invoke')
    const called = await call(port, {
      token, sessionId,
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'view_snapshot', arguments: { scope: 'full' } } },
    })
    expect(called.status).toBe(200)
    expect(called.body).toContain('快照好了')
    expect(invoked).toHaveBeenCalledWith('view_snapshot', { scope: 'full' }, expect.objectContaining({ callId: expect.anything() }))
  })

  it('close() 之後連不上', async () => {
    const { server, port, token } = await start()
    await handshake(port, token)
    await server.close()
    running = undefined
    await expect(call(port, { token, payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' } })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
```

`vi.spyOn(view, 'invoke')` 要求 `ConversationViewServer.invoke` 是物件上的可寫屬性;目前
`createConversationViewServer` 回的是物件字面值,可以 spy。若 TypeScript 因 `readonly` 擋下來,
改成在 `start()` 時自己包一層計數用的 `resolve`,斷言 `fakeTools().invoke` 被呼叫。

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run tests/view-tools-http-server.test.ts`
Expected: FAIL,找不到 `../src/main/view-tools/http-server.js`

- [ ] **Step 4: 實作**

```ts
// src/main/view-tools/http-server.ts
/**
 * 每個對話一個 localhost 的 streamable HTTP MCP server(grok 規格 §6)。
 *
 * 內容就是現有的 `createConversationViewServer`:同一份 `VIEW_TOOL_DEFS` 加兩個同伴工具,
 * 同一個 `invoke`,同一套批准政策。這裡只是把它多接一條 HTTP 通道,因為 grok 不收
 * `type: "sdk"` 的 in-process 形狀。
 *
 * 三道檢查在交給 transport 之前做,任一不過就 401 或 404 並關掉連線,不回 MCP 錯誤:
 * 擋下來的請求不該拿到任何協定層的資訊。token 只出現在 `session/new` 的 headers。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ConversationViewServer } from './conversation-server.js'

export const HTTP_MSG = {
  unauthorized: '未授權的右窗格工具請求',
  notFound: '沒有這個位址',
  noPort: '右窗格工具的本機伺服器沒有取得埠號',
} as const

export interface ViewToolHttpServer {
  readonly url: string
  readonly token: string
  close(): Promise<void>
}

const MCP_PATH = '/mcp'
/** IPv4 與 IPv6 的 loopback,以及 IPv4-mapped 的那一種。 */
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function authorized(req: IncomingMessage, token: string, port: number): boolean {
  if (req.headers['authorization'] !== `Bearer ${token}`) return false
  const remote = req.socket.remoteAddress
  if (remote === undefined || !LOOPBACK.has(remote)) return false
  // Host 必須逐字等於自己的位址,不接受 localhost:擋 DNS rebinding。
  return req.headers['host'] === `127.0.0.1:${port}`
}

function refuse(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
  res.end(text)
}

export function startViewToolHttpServer(
  view: ConversationViewServer,
  logError: (error: Error) => void,
): Promise<ViewToolHttpServer> {
  const token = randomBytes(32).toString('base64url')
  // stateful:1.30.0 的 stateless transport 只能處理一個請求(見 Task 5 說明)。
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  })
  transport.onerror = (error) => { logError(new Error(`右窗格工具的 MCP 傳輸錯誤:${error.message}`)) }
  let port = 0

  const http = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== MCP_PATH) { refuse(res, 404, HTTP_MSG.notFound); return }
    if (!authorized(req, token, port)) { refuse(res, 401, HTTP_MSG.unauthorized); return }
    transport.handleRequest(req, res).catch((cause: unknown) => {
      logError(cause instanceof Error ? cause : new Error(String(cause)))
      if (!res.headersSent) refuse(res, 500, HTTP_MSG.unauthorized)
      else res.end()
    })
  })

  return new Promise<ViewToolHttpServer>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      const address = http.address() as AddressInfo | null
      if (address === null) { http.close(); reject(new Error(HTTP_MSG.noPort)); return }
      port = address.port
      view.server.instance.connect(transport).then(() => {
        resolve({
          url: `http://127.0.0.1:${port}${MCP_PATH}`,
          token,
          close: async () => {
            await transport.close()
            await new Promise<void>((done) => { http.close(() => { done() }) })
          },
        })
      }, reject)
    })
  })
}
```

`createSdkMcpServer` 回的 `McpSdkServerConfigWithInstance` 帶的 `instance` 型別就是
`McpServer`,`connect(transport)` 直接可用;實測 `initialize` → `tools/list` → `tools/call`
三步都通。它在執行期是 agent SDK 打包進去的那一份 `McpServer`,不是
`node_modules/@modelcontextprotocol/sdk` 的同一個 class 物件,但兩邊都是 1.30.0,
`Transport` 是結構介面,不需要另外再建一個 `McpServer`。

- [ ] **Step 5: 跑測試**

Run: `npx vitest run tests/view-tools-http-server.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/view-tools/http-server.ts tests/view-tools-http-server.test.ts
git commit -m "feat: serve the per-conversation view tools over localhost http mcp"
```

---

### Task 6: `grok/conversation.ts`

**Files:**
- Create: `src/main/grok/conversation.ts`
- Test: `tests/grok-conversation.test.ts`

**Interfaces:**
- Consumes:Task 3 的 `createGrokMapper`;Task 4 的 `createGrokClient`、`AcpMcpServer`、`MSG_NO_GROK`、`withGrokAuthHint`、`PermissionRequest`、`PermissionOutcome`、`SpawnGrok`;`src/main/conversation.ts` 的 `Conversation`、`ConversationSink`;`src/main/approval.ts` 的 `createApprovalRegistry`
- Produces:

```ts
/** grok 對話要用的右窗格工具。conversation 不需要知道 MCP server 長什麼樣。 */
export interface GrokViewTools {
  /** 交給 grok 的 mcpServers;第一次呼叫才真的開 HTTP server。 */
  mcpServers(): Promise<readonly AcpMcpServer[]>
  handoffDone(toolUseId: string): void
  /** 關掉 HTTP server。一定在 client.close() 之後才呼叫(規格 §6.2)。 */
  close(): Promise<void>
}

export interface GrokConversationDeps {
  readonly model?: string
  readonly onEvents?: (events: readonly Event[]) => void
  readonly onActivity?: (sessionId: string, events: readonly Event[]) => void
  readonly viewTools?: GrokViewTools
  readonly sink: ConversationSink
  readonly cwd: string
  readonly logError: (error: Error) => void
  readonly onSessionEnded?: (sessionId: string, event: Extract<Event, { kind: 'session-end' }>) => void
  readonly onSessionStarted?: (sessionId: string, cwd?: string) => void
  readonly onPendingApprovalsChange?: (count: number) => void
  readonly onBusyChange?: (busy: boolean) => void
  readonly onTurnProduced?: () => void
  readonly initialSessionId?: string
  readonly approvalTimeoutMs?: number
  readonly createRegistry?: typeof createApprovalRegistry
  readonly createClient?: typeof createGrokClient
  readonly spawn?: SpawnGrok
  readonly commandExists?: (command: string) => boolean
}

export function createGrokConversation(deps: GrokConversationDeps): Conversation
export function grokStartFailureMessage(error: Error): string
export function pickPermissionOption(
  options: readonly PermissionOption[],
  decision: ApprovalDecision,
): string | undefined
export { MSG_NO_GROK }
```

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/grok-conversation.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGrokConversation, grokStartFailureMessage, pickPermissionOption,
  type GrokConversationDeps, type GrokViewTools,
} from '../src/main/grok/conversation.js'
import { MSG, MSG_NO_GROK, type AcpMcpServer, type GrokClient, type GrokClientDeps, type PermissionOption } from '../src/main/grok/client.js'
import type { ApprovalRequest } from '../src/main/approval.js'
import type { ConversationSink } from '../src/main/conversation.js'
import type { Event } from '../src/shared/events.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

const MCP: AcpMcpServer = {
  name: 'yeschef', type: 'http', url: 'http://127.0.0.1:51234/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer tok-abc' }],
}

const OPTIONS: readonly PermissionOption[] = [
  { optionId: 'a1', name: '允許一次', kind: 'allow_once' },
  { optionId: 'a2', name: '總是允許', kind: 'allow_always' },
  { optionId: 'r1', name: '拒絕', kind: 'reject_once' },
  { optionId: 'r2', name: '總是拒絕', kind: 'reject_always' },
]

function setup(options: {
  commandExists?: boolean
  initialSessionId?: string
  viewTools?: GrokViewTools
  bootError?: string
} = {}) {
  const events: Event[] = []
  const states: string[] = []
  const asks: ApprovalRequest[] = []
  const errors: string[] = []
  const busy: boolean[] = []
  const order: string[] = []
  let captured: GrokClientDeps | undefined
  let alive = false
  const prompts: unknown[][] = []
  let settlePrompt: (result: { stopReason: string | undefined }) => void = () => {}

  const sink: ConversationSink = {
    events: (batch) => { events.push(...batch) },
    state: (state) => { states.push(state.kind) },
    approvalAsk: (request) => { asks.push(request) },
    approvalSettled: () => {},
  }

  const client: GrokClient = {
    get sessionId() { return captured?.resume ?? 's-new' },
    prompt: (blocks) => {
      prompts.push([...blocks])
      return new Promise((resolve) => { settlePrompt = resolve })
    },
    cancel: () => { order.push('cancel'); return Promise.resolve() },
    close: () => { order.push('client.close'); alive = false; return Promise.resolve() },
    models: () => [],
    isRunning: () => alive,
  }

  const deps: GrokConversationDeps = {
    sink,
    cwd: '/p/alpha',
    logError: (e) => { errors.push(e.message) },
    onBusyChange: (next) => { busy.push(next) },
    commandExists: () => options.commandExists !== false,
    ...(options.initialSessionId === undefined ? {} : { initialSessionId: options.initialSessionId }),
    ...(options.viewTools === undefined ? {} : { viewTools: options.viewTools }),
    createClient: (clientDeps) => {
      captured = clientDeps
      if (options.bootError !== undefined) return Promise.reject(new Error(options.bootError))
      alive = true
      return Promise.resolve(client)
    },
  }

  const core = createGrokConversation(deps)
  core.activate()
  return {
    core, events, states, asks, errors, busy, order, prompts,
    clientDeps: () => { if (captured === undefined) throw new Error('還沒建 client'); return captured },
    finishTurn: async (stopReason = 'end_turn') => { settlePrompt({ stopReason }); await flush() },
    kinds: () => events.map((e) => e.kind),
  }
}

function fakeViewTools(order: string[]): GrokViewTools {
  return {
    mcpServers: () => Promise.resolve([MCP]),
    handoffDone: () => { order.push('handoffDone') },
    close: () => { order.push('viewTools.close'); return Promise.resolve() },
  }
}

describe('送出與回合', () => {
  it('userInput 先畫 user-text,再開 client 並送 session/prompt', async () => {
    const r = setup()
    r.core.userInput('你好')
    expect(r.events[0]).toEqual({ kind: 'user-text', text: '你好' })
    await flush()
    expect(r.prompts).toEqual([[{ type: 'text', text: '你好' }]])
    expect(r.clientDeps().cwd).toBe('/p/alpha')
    expect(r.kinds()).toContain('session-start')
    expect(r.states).toContain('live')
    expect(r.busy[0]).toBe(true)
  })

  it('mcpServers 從 viewTools 拿,原樣交給 client', async () => {
    const order: string[] = []
    const r = setup({ viewTools: fakeViewTools(order) })
    r.core.userInput('你好')
    await flush()
    expect(r.clientDeps().mcpServers).toEqual([MCP])
  })

  it('沒有 viewTools 時 mcpServers 是空陣列', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    expect(r.clientDeps().mcpServers).toEqual([])
  })

  it('prompt 回來才算回合結束,session-end 只發一次', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    expect(r.core.isBusy()).toBe(true)
    await r.finishTurn('end_turn')
    expect(r.kinds().filter((k) => k === 'session-end')).toHaveLength(1)
    expect(r.core.isBusy()).toBe(false)
  })

  it('回合進行中再送:先 cancel 再送新的 prompt', async () => {
    const r = setup()
    r.core.userInput('第一句')
    await flush()
    r.core.userInput('第二句')
    await flush()
    expect(r.order).toContain('cancel')
    expect(r.prompts).toHaveLength(2)
  })

  it('附件只帶路徑文字:grok 的 promptCapabilities.image 是 false', async () => {
    const r = setup()
    r.core.userInput('看這張', [{ name: 'a.png', path: '/p/a.png', kind: 'image', mime: 'image/png' }])
    await flush()
    const blocks = r.prompts[0] as { type: string; text: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toContain('/p/a.png')
  })
})

describe('批准', () => {
  it('request_permission 進批准卡片,allow 選 allow_once 的 optionId', async () => {
    const r = setup()
    r.core.userInput('改檔案')
    await flush()
    const outcome = r.clientDeps().onPermission({
      toolCallId: 'call-1', title: '寫入 README.md', kind: 'edit', rawInput: { path: 'README.md' }, options: OPTIONS,
    })
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.asks[0]).toMatchObject({ toolUseId: 'call-1', toolName: '寫入 README.md', displayName: 'edit', input: { path: 'README.md' } })
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    await expect(outcome).resolves.toEqual({ outcome: 'selected', optionId: 'a1' })
  })

  it('deny 選 reject_once', async () => {
    const r = setup()
    r.core.userInput('改檔案')
    await flush()
    const outcome = r.clientDeps().onPermission({ toolCallId: 'c', title: 't', kind: 'edit', rawInput: {}, options: OPTIONS })
    await flush()
    r.core.approvalReply(r.asks[0]!.requestId, 'deny')
    await expect(outcome).resolves.toEqual({ outcome: 'selected', optionId: 'r1' })
  })

  it('沒有任何可選項就回 cancelled', async () => {
    const r = setup()
    r.core.userInput('改檔案')
    await flush()
    const outcome = r.clientDeps().onPermission({ toolCallId: 'c', title: 't', kind: 'edit', rawInput: {}, options: [] })
    await flush()
    r.core.approvalReply(r.asks[0]!.requestId, 'allow')
    await expect(outcome).resolves.toEqual({ outcome: 'cancelled' })
  })

  it('pickPermissionOption:沒有 *_once 時退回第一個同向的選項', () => {
    const onlyAlways: readonly PermissionOption[] = [
      { optionId: 'a2', name: '總是允許', kind: 'allow_always' },
      { optionId: 'r2', name: '總是拒絕', kind: 'reject_always' },
    ]
    expect(pickPermissionOption(onlyAlways, 'allow')).toBe('a2')
    expect(pickPermissionOption(onlyAlways, 'deny')).toBe('r2')
    expect(pickPermissionOption(OPTIONS, 'allow')).toBe('a1')
    expect(pickPermissionOption([], 'allow')).toBeUndefined()
  })
})

describe('歷史與重新開始', () => {
  it('openHistory 用 resume 開新 client,重播完發 session-end', async () => {
    const r = setup()
    r.core.openHistory('s-old')
    await flush()
    expect(r.clientDeps().resume).toBe('s-old')
    expect(r.kinds()[0]).toBe('reset')
    expect(r.kinds()).toContain('session-start')
    expect(r.kinds().at(-1)).toBe('session-end')
    expect(r.states).toContain('viewing')
  })

  it('重播中到達的 session/update 進對話', async () => {
    const r = setup()
    r.core.openHistory('s-old')
    await flush()
    r.clientDeps().onUpdate('session/update', {
      sessionId: 's-old',
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '舊的一句' } },
    })
    await flush()
    expect(r.events.some((e) => e.kind === 'user-text' && e.text === '舊的一句')).toBe(true)
  })

  it('重開 app 的 initialSessionId:第一次輸入才 resume', async () => {
    const r = setup({ initialSessionId: 's-saved' })
    expect(r.core.sessionState()).toEqual({ kind: 'viewing', sessionId: 's-saved' })
    r.core.userInput('接著做')
    await flush()
    expect(r.clientDeps().resume).toBe('s-saved')
  })

  it('startNew 清空並收掉 client', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    await r.finishTurn()
    r.core.startNew()
    await flush()
    expect(r.order).toContain('client.close')
    expect(r.core.sessionState()).toEqual({ kind: 'idle' })
  })
})

describe('故障與收尾', () => {
  it('PATH 沒有 grok:卡片顯示那一句,不加前綴', async () => {
    const r = setup({ commandExists: false })
    r.core.userInput('你好')
    await flush()
    const ended = r.events.find((e) => e.kind === 'session-end')
    expect(ended).toMatchObject({ isError: true, errorMessage: MSG_NO_GROK })
    expect(r.core.isBusy()).toBe(false)
  })

  it('未登入:錯誤訊息前面補 grok login', async () => {
    const r = setup({ bootError: `${MSG.loginFirst}(unauthorized)` })
    r.core.userInput('你好')
    await flush()
    expect(r.events.find((e) => e.kind === 'session-end')).toMatchObject({ errorMessage: expect.stringContaining(MSG.loginFirst) })
  })

  it('子行程意外結束:發 session-end,狀態回到可重新開始', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    r.clientDeps().onExit(1)
    await flush()
    expect(r.events.find((e) => e.kind === 'session-end')).toMatchObject({ isError: true })
    expect(r.core.isBusy()).toBe(false)
    expect(r.core.sessionState().kind).toBe('viewing')
  })

  it('stderr 只進 logError,不進對話', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    const before = r.events.length
    r.clientDeps().onStderr('ERROR mcp server weather unavailable')
    expect(r.events).toHaveLength(before)
    expect(r.errors.some((e) => e.includes('weather'))).toBe(true)
  })

  it('全域 MCP server 連不上:記一行 log,不進對話(規格 §6.4)', async () => {
    const r = setup()
    r.core.userInput('你好')
    await flush()
    const before = r.events.length
    r.clientDeps().onUpdate('_x.ai/mcp/server_status', {
      sessionId: 's-new', name: 'weather', status: 'unavailable', reason: 'connect_failed', detail: 'ECONNREFUSED',
    })
    await flush()
    expect(r.events).toHaveLength(before)
    expect(r.errors.some((e) => e.includes('weather') && e.includes('connect_failed'))).toBe(true)
  })

  it('dispose 的順序:client.close 在 viewTools.close 之前', async () => {
    const order: string[] = []
    const r = setup({ viewTools: fakeViewTools(order) })
    r.core.userInput('你好')
    await flush()
    const disposing = r.core.dispose()
    await vi.advanceTimersByTimeAsync(0)
    await disposing
    expect(r.order.concat(order).filter((s) => s.endsWith('close'))).toEqual(['client.close', 'viewTools.close'])
  })

  it('grokStartFailureMessage:找不到 grok 不加前綴,其餘加', () => {
    expect(grokStartFailureMessage(new Error(MSG_NO_GROK))).toBe(MSG_NO_GROK)
    expect(grokStartFailureMessage(new Error('磁碟已滿'))).toBe('grok 啟動失敗:磁碟已滿')
  })
})
```

`r.order` 與 `order` 兩個陣列分別記 client 與 viewTools 的動作,最後一條測試把兩邊合起來看順序;
實作若把兩個 close 放進同一個陣列也可以,改斷言即可。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/grok-conversation.test.ts`
Expected: FAIL,找不到 `../src/main/grok/conversation.js`

- [ ] **Step 3: 實作**

```ts
// src/main/grok/conversation.ts
/**
 * grok 對話核心:對外與 Claude、codex 同一個 `Conversation` 介面(grok 規格 §5.4),
 * 路由器不必知道底下是哪一種。
 *
 * 狀態與 codex 同構:`idle` 是還沒開過 session;有 sessionId 但子行程不在是 `viewing`;
 * 子行程活著是 `live`。回合結束的唯一依據是 `session/prompt` 的回應,不猜「多久沒事件」。
 *
 * 與 codex 有兩處刻意不同,理由寫在各自的註解裡:退到背景不收子行程,
 * 以及 `replay()` 不自動載入歷史。
 */
import { accessSync, constants } from 'node:fs'
import { attachmentLabel, attachmentPrompt, type PromptAttachment } from '../../shared/conversation-tools.js'
import { appendEvents } from '../../shared/event-log.js'
import { isTurnContentEvent, type Event } from '../../shared/events.js'
import type { SessionState } from '../../shared/session-state.js'
import { DEFAULT_MERGE_CONFIG, INITIAL_MERGE_STATE, asError, mergeAccept, mergeFlush } from '../agent-host.js'
import {
  createApprovalRegistry,
  type ApprovalAsk, type ApprovalDecision, type ApprovalOutcome,
} from '../approval.js'
import type { Conversation, ConversationSink } from '../conversation.js'
import { createGrokMapper, type GrokMapper } from './mapper.js'
import {
  createGrokClient, MSG_NO_GROK, withGrokAuthHint,
  type AcpMcpServer, type GrokClient, type PermissionOption, type PermissionOutcome,
  type PermissionRequest, type PromptBlock, type SpawnGrok,
} from './client.js'

export { MSG_NO_GROK }

export const MSG = {
  windowClosed: '視窗已關閉',
  switchingSession: '切換 session',
  startFailed: (reason: string) => `grok 啟動失敗:${reason}`,
  exited: (code: number | null) => `grok 子行程結束,code ${code ?? 'null'}`,
  noViewTools: (toolUseId: string) => `grok 對話沒有接右窗格工具,交接 ${toolUseId} 無處可送`,
} as const

export interface GrokViewTools {
  mcpServers(): Promise<readonly AcpMcpServer[]>
  handoffDone(toolUseId: string): void
  close(): Promise<void>
}

export interface GrokConversationDeps {
  readonly model?: string
  readonly onEvents?: (events: readonly Event[]) => void
  readonly onActivity?: (sessionId: string, events: readonly Event[]) => void
  /** 有給才把右窗格工具交給 grok(規格 §6)。沒給就是這個對話不能開瀏覽器。 */
  readonly viewTools?: GrokViewTools
  readonly sink: ConversationSink
  /** 專案根目錄或 worktree,子行程的 cwd。 */
  readonly cwd: string
  readonly logError: (error: Error) => void
  readonly onSessionEnded?: (sessionId: string, event: Extract<Event, { kind: 'session-end' }>) => void
  readonly onSessionStarted?: (sessionId: string, cwd?: string) => void
  readonly onPendingApprovalsChange?: (count: number) => void
  readonly onBusyChange?: (busy: boolean) => void
  readonly onTurnProduced?: () => void
  /** 重開 app 時狀態檔記的 sessionId。 */
  readonly initialSessionId?: string
  readonly approvalTimeoutMs?: number
  readonly createRegistry?: typeof createApprovalRegistry
  readonly createClient?: typeof createGrokClient
  readonly spawn?: SpawnGrok
  readonly commandExists?: (command: string) => boolean
}

const RESET: Event = { kind: 'reset' }

/** 只選 `*_once`:`*_always` 會存進 grok 自己的 session 狀態,yeschef 管不到(規格 §7)。 */
const OPTION_KIND: Readonly<Record<ApprovalDecision, { readonly exact: string; readonly prefix: string }>> = {
  allow: { exact: 'allow_once', prefix: 'allow' },
  deny: { exact: 'reject_once', prefix: 'reject' },
}

export function pickPermissionOption(
  options: readonly PermissionOption[],
  decision: ApprovalDecision,
): string | undefined {
  const want = OPTION_KIND[decision]
  const exact = options.find((option) => option.kind === want.exact)
  const once = options.find((option) => option.kind.startsWith(want.prefix) && !option.kind.endsWith('_always'))
  const same = options.find((option) => option.kind.startsWith(want.prefix))
  return (exact ?? once ?? same)?.optionId
}

/** PATH 裡有沒有這個指令。與 codex 對話同一個做法。 */
function realCommandExists(command: string): boolean {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue
    try {
      accessSync(`${dir}/${command}`, constants.X_OK)
      return true
    } catch {
      // 這個目錄沒有,看下一個。
    }
  }
  return false
}

export function grokStartFailureMessage(error: Error): string {
  // 規格 §9:PATH 找不到 grok 的訊息就是那一句,不加前綴。
  if (error.message === MSG_NO_GROK) return MSG_NO_GROK
  const hinted = withGrokAuthHint(error.message)
  return hinted === error.message ? MSG.startFailed(error.message) : hinted
}

export function createGrokConversation(deps: GrokConversationDeps): Conversation {
  const makeClient = deps.createClient ?? createGrokClient
  const commandExists = deps.commandExists ?? realCommandExists

  let sessionId: string | null = deps.initialSessionId ?? null
  let resumeNext = deps.initialSessionId !== undefined
  let mapper: GrokMapper = createGrokMapper(sessionId ?? 'new', deps.model)
  let state: SessionState = sessionId === null ? { kind: 'idle' } : { kind: 'viewing', sessionId }
  let active = false
  let disposed = false
  let busy = false
  let busyStartedAt: number | null = null
  let turnProduced = false
  let closingClient = false
  let log: readonly Event[] = []
  let client: GrokClient | null = null
  /** 每次 startNew／openHistory 換一代;舊 client 之後才到的事件不能落進新對話。 */
  let generation = 0
  /** 動作串行鏈。只串 client 的建立與收尾,回合本身不進來,不然第二句話要等第一句跑完。 */
  let pending: Promise<void> = Promise.resolve()

  const registry = (deps.createRegistry ?? createApprovalRegistry)({
    timeoutMs: deps.approvalTimeoutMs,
    sendRequest: (request) => { deps.sink.approvalAsk(request) },
    onSettled: (requestId) => { deps.sink.approvalSettled(requestId) },
  })

  const emitState = (next: SessionState): void => { if (active) deps.sink.state(next) }
  const setState = (next: SessionState): void => { state = next; emitState(next) }
  const pushBatch = (events: readonly Event[]): void => {
    if (busy && !turnProduced && events.some(isTurnContentEvent)) {
      turnProduced = true
      deps.onTurnProduced?.()
    }
    if (events.length === 0) return
    log = appendEvents(log, events)
    deps.onEvents?.(events)
    if (sessionId !== null) deps.onActivity?.(sessionId, events)
    for (const event of events) {
      if (event.kind === 'session-end' && sessionId !== null) deps.onSessionEnded?.(sessionId, event)
    }
    if (active) deps.sink.events(events)
  }
  const chunked = (events: readonly Event[], out: (batch: readonly Event[]) => void): void => {
    const accepted = mergeAccept(INITIAL_MERGE_STATE, events, 0, DEFAULT_MERGE_CONFIG)
    const rest = mergeFlush(accepted.state)
    for (const batch of accepted.batches) out(batch)
    for (const batch of rest.batches) out(batch)
  }
  const setBusy = (next: boolean): void => {
    if (busy === next) return
    busy = next
    busyStartedAt = next ? Date.now() : null
    if (next) turnProduced = false
    deps.onBusyChange?.(next)
  }
  const notifyPending = (): void => { deps.onPendingApprovalsChange?.(registry.pendingCount()) }
  const requestApproval = (request: ApprovalAsk): Promise<ApprovalOutcome> => {
    const outcome = registry.request(request)
    notifyPending()
    return outcome.finally(notifyPending)
  }

  /** `session/request_permission` 轉批准卡片(規格 §7)。 */
  const onPermission = async (request: PermissionRequest): Promise<PermissionOutcome> => {
    if (disposed) return { outcome: 'cancelled' }
    const outcome = await requestApproval({
      toolUseId: request.toolCallId,
      toolName: request.title === '' ? request.kind : request.title,
      input: request.rawInput,
      executionCwd: deps.cwd,
      ...(request.title === '' ? {} : { title: request.title }),
      ...(request.kind === '' ? {} : { displayName: request.kind }),
    })
    const optionId = pickPermissionOption(request.options, outcome.decision)
    return optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId }
  }

  /**
   * 全域 MCP server 連不上時記一行 log,不顯示在對話裡(規格 §6.4)。
   * 那些 server 來自 `~/.grok/config.toml`,第一版不干預,但人要查得到為什麼工具少了。
   */
  const noteServerStatus = (method: string, params: unknown): void => {
    if (method !== '_x.ai/mcp/server_status') return
    const record = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    if (record['status'] !== 'unavailable') return
    deps.logError(new Error(`grok 的 MCP server ${String(record['name'])} 不可用:${String(record['reason'])} ${String(record['detail'])}`))
  }

  const prepareMapper = (id: string): void => {
    mapper = createGrokMapper(id, deps.model)
    mapper.beginTurn()
  }

  const pushSessionStart = (id: string): void => {
    const model = mapper.model()
    pushBatch([{ kind: 'session-start', sessionId: id, cwd: deps.cwd, ...(model === undefined ? {} : { model }) }])
  }

  const handleExit = (code: number | null): void => {
    client = null
    // 子行程沒了,下一句話要用 session/load 接回同一個 session。
    resumeNext = sessionId !== null
    if (busy) {
      pushBatch([{ kind: 'session-end', isError: true, errorMessage: MSG.exited(code) }])
      setBusy(false)
    }
    if (sessionId !== null) setState({ kind: 'viewing', sessionId })
  }

  const teardownClient = async (): Promise<void> => {
    const current = client
    client = null
    if (current === null) return
    closingClient = true
    try {
      await current.close()
    } finally {
      closingClient = false
    }
  }

  const ensureClient = async (): Promise<GrokClient> => {
    const existing = client
    if (existing !== null && existing.isRunning()) return existing
    if (!commandExists('grok')) throw new Error(MSG_NO_GROK)
    const gen = generation
    const mcpServers = deps.viewTools === undefined ? [] : await deps.viewTools.mcpServers()
    const resume = resumeNext && sessionId !== null ? sessionId : undefined
    // 重播的 session/update 在 makeClient 回來之前就會到,所以 mapper 要先就位。
    if (resume !== undefined) { prepareMapper(resume); pushSessionStart(resume) }
    const created = await makeClient({
      cwd: deps.cwd,
      mcpServers,
      logError: deps.logError,
      ...(deps.model === undefined ? {} : { model: deps.model }),
      ...(resume === undefined ? {} : { resume }),
      onUpdate: (method, params) => {
        if (gen !== generation || disposed) return
        noteServerStatus(method, params)
        pushBatch(mapper.accept(method, params))
      },
      onPermission: (request) => (gen === generation && !disposed
        ? onPermission(request)
        : Promise.resolve<PermissionOutcome>({ outcome: 'cancelled' })),
      onStderr: (line) => { deps.logError(new Error(`grok stderr:${line.slice(0, 300)}`)) },
      onExit: (code) => { if (gen === generation && !closingClient) handleExit(code) },
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    })
    if (disposed || gen !== generation) { await created.close(); throw new Error(MSG.switchingSession) }
    client = created
    resumeNext = false
    if (resume === undefined) {
      sessionId = created.sessionId
      prepareMapper(sessionId)
      pushSessionStart(sessionId)
      deps.onSessionStarted?.(sessionId, deps.cwd)
    }
    setState({ kind: 'live', sessionId: sessionId ?? created.sessionId })
    return created
  }

  /** 回合本身不進串行鏈:第二句話要能在第一句還沒結束時先 cancel 再送。 */
  const runTurn = async (c: GrokClient, gen: number, blocks: readonly PromptBlock[]): Promise<void> => {
    try {
      const result = await c.prompt(blocks)
      if (disposed || gen !== generation) return
      pushBatch(mapper.promptFinished(result.stopReason))
      setBusy(false)
    } catch (cause) {
      deps.logError(asError(cause, 'grok-turn'))
      if (disposed || gen !== generation) return
      const original = cause instanceof Error ? cause : new Error(String(cause))
      pushBatch([{ kind: 'session-end', isError: true, errorMessage: withGrokAuthHint(original.message) }])
      setBusy(false)
    }
  }

  const userInput = (text: string, attachments?: readonly PromptAttachment[]): void => {
    if (disposed) return
    if (state.kind === 'viewing' && !busy) generation += 1
    const gen = generation
    pushBatch([{ kind: 'user-text', text: attachmentLabel(text, attachments) }])
    const wasBusy = busy
    setBusy(true)
    const current = client
    // 回合進行中再送:先 cancel 再送,跟 Codex 一樣(規格 §5.4)。
    if (wasBusy && current !== null) {
      void current.cancel().catch((cause: unknown) => { deps.logError(asError(cause, 'grok-cancel')) })
    }
    pending = pending.then(async () => {
      if (disposed || gen !== generation) return
      try {
        const c = await ensureClient()
        if (disposed || gen !== generation) return
        mapper.beginTurn()
        // grok 的 promptCapabilities.image 是 false,附件只帶路徑文字(規格 §10)。
        void runTurn(c, gen, [{ type: 'text', text: attachmentPrompt(text, attachments) }])
      } catch (cause) {
        deps.logError(asError(cause, 'grok-input'))
        if (disposed || gen !== generation) return
        const original = cause instanceof Error ? cause : new Error(String(cause))
        pushBatch([{ kind: 'session-end', isError: true, errorMessage: grokStartFailureMessage(original) }])
        setBusy(false)
        await teardownClient()
        if (sessionId !== null) setState({ kind: 'viewing', sessionId })
      }
    }).catch((err: unknown) => { deps.logError(asError(err, 'grok-input')) })
  }

  const openHistory = (id: string): void => {
    if (disposed) return
    generation += 1
    const gen = generation
    const current = client
    if (current !== null) void current.cancel().catch((cause: unknown) => { deps.logError(asError(cause, 'grok-cancel')) })
    registry.denyAll(MSG.switchingSession)
    notifyPending()
    setBusy(false)
    log = []
    pushBatch([RESET])
    sessionId = id
    resumeNext = true
    setState({ kind: 'viewing', sessionId: id })
    pending = pending.then(async () => {
      await teardownClient()
      if (disposed || gen !== generation) return
      try {
        // 一律開新的子行程 load,不在同一個行程裡 close 再 load(規格 §3)。
        await ensureClient()
        if (disposed || gen !== generation) return
        pushBatch([{ kind: 'session-end', isError: false }])
      } catch (cause) {
        deps.logError(asError(cause, 'grok-history'))
        if (disposed || gen !== generation) return
        const original = cause instanceof Error ? cause : new Error(String(cause))
        pushBatch([{ kind: 'session-end', isError: true, errorMessage: grokStartFailureMessage(original) }])
      }
      setState({ kind: 'viewing', sessionId: id })
    }).catch((err: unknown) => { deps.logError(asError(err, 'grok-history')) })
  }

  const replay = (): void => {
    if (!active) return
    // 與 codex 不同:不自動 openHistory。grok 的歷史只能用 session/load 重播,
    // 那會多開一個子行程;切回前景不該付這個代價,由使用者輸入時才接回去。
    chunked([RESET, ...log], (batch) => { deps.sink.events(batch) })
    deps.sink.state(state)
  }

  return {
    shutdownConfirmed: () => client === null,
    userInput,
    approvalReply(requestId, decision: ApprovalDecision) {
      if (registry.reply(requestId, decision)) return
      deps.logError(new Error(`grok 對話:找不到批准 ${requestId},可能已逾時`))
    },
    startNew() {
      generation += 1
      registry.denyAll(MSG.switchingSession)
      notifyPending()
      setBusy(false)
      log = []
      sessionId = null
      resumeNext = false
      mapper = createGrokMapper('new', deps.model)
      pushBatch([RESET])
      setState({ kind: 'idle' })
      pending = pending.then(teardownClient).catch((err: unknown) => { deps.logError(asError(err, 'grok-start-new')) })
    },
    openHistory,
    handoffDone(toolUseId) {
      const view = deps.viewTools
      if (view === undefined) {
        deps.logError(new Error(MSG.noViewTools(toolUseId)))
        return
      }
      view.handoffDone(toolUseId)
    },
    activate() {
      if (active || disposed) return
      active = true
      replay()
    },
    deactivate() {
      // 與 codex 不同:不收子行程。grok 沒有 thread/resume 這種「接回去但不重播」的方法,
      // 收掉再回來只能 session/load,那會把整段歷史重播一次,畫面變兩份。
      // 這是已知代價:每個開著的 Grok 分頁常駐一個 `grok agent stdio`。
      active = false
    },
    replay,
    isActive: () => active,
    pendingApprovals: () => registry.pendingCount(),
    isBusy: () => busy,
    busyStartedAt: () => busyStartedAt,
    turnProduced: () => turnProduced,
    activityEvents: () => log,
    sessionState: () => state,
    async dispose() {
      disposed = true
      active = false
      registry.denyAll(MSG.windowClosed)
      notifyPending()
      pending = pending.then(async () => {
        // 順序固定:先 session/close 再關 HTTP server,反過來 grok 的 MCP client
        // 會在關閉時把 handshake 錯誤噴到 stderr(規格 §6.2)。
        await teardownClient()
        await deps.viewTools?.close()
      }).catch((err: unknown) => { deps.logError(asError(err, 'grok-dispose')) })
      await pending
    },
  }
}
```

- [ ] **Step 4: 跑測試**

Run: `npx vitest run tests/grok-conversation.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/grok/conversation.ts tests/grok-conversation.test.ts
git commit -m "feat: add the grok conversation core"
```

---

### Task 7: `grok/catalog.ts` 與 Chef 的 Grok 模型

**Files:**
- Create: `src/main/grok/catalog.ts`
- Modify: `src/main/chef/models.ts`
- Modify: `src/renderer/components/ChefManager.tsx`
- Test: `tests/grok-catalog.test.ts`

**Interfaces:**
- Consumes:Task 2 的 `createRpc`;Task 4 的 `nodeSpawnGrok`、`SpawnGrok`、`GrokProcess`、`GrokModel`、`MSG_NO_GROK`
- Produces:

```ts
export interface GrokCatalog {
  /** initialize 回應的 availableModels。找不到 grok 回空陣列。 */
  models(): Promise<readonly GrokModel[]>
  /** `session/list`。形狀與 `CodexCatalog.list` 相同,ipc-bridge 用同一張表查。 */
  list(cwd?: string): Promise<readonly SessionSummary[]>
}
export interface GrokCatalogDeps {
  readonly spawn?: SpawnGrok
  readonly logError: (error: Error) => void
  readonly timeoutMs?: number
  readonly cacheMs?: number
  readonly now?: () => number
  readonly homeDir?: string
}
export const GROK_CACHE_MS: 30_000
export function createGrokCatalog(deps: GrokCatalogDeps): GrokCatalog
export function toGrokSummary(raw: unknown): SessionSummary | undefined
```

- Chef:`createChefModelCatalog(queryFn, cwd, spawn?, grokSpawn?)` 多一個 `grok()` 來源,key 是 `grok:<id>`。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/grok-catalog.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createGrokCatalog, GROK_CACHE_MS, toGrokSummary } from '../src/main/grok/catalog.js'
import type { GrokProcess, SpawnGrok } from '../src/main/grok/client.js'

const INITIALIZE_RESULT = {
  protocolVersion: 1,
  _meta: {
    modelState: {
      availableModels: [
        { id: 'grok-4-7', name: 'Grok 4.7', reasoningEfforts: ['low', 'high'] },
        { id: 'grok-4-fast', name: 'Grok 4 Fast', reasoningEfforts: ['low'] },
      ],
    },
  },
}

const LIST_RESULT = {
  sessions: [
    { sessionId: 's-1', cwd: '/p/alpha', updatedAt: 1_800_000_000_000, _meta: { 'x.ai/session': { kind: 'agent', title: '修 mapper' } } },
    { sessionId: 's-2', cwd: '/p/alpha', updatedAt: 1_799_000_000_000, _meta: { 'x.ai/session': { kind: 'agent' } } },
  ],
}

interface Fake {
  readonly sent: Array<Record<string, unknown>>
  readonly killed: string[]
  reply(method: string, result: unknown): void
  fail(error: Error): void
}

function makeSpawn(): { spawn: SpawnGrok; all: Fake[]; last: () => Fake } {
  const all: Fake[] = []
  const spawn: SpawnGrok = () => {
    const sent: Array<Record<string, unknown>> = []
    const killed: string[] = []
    let onLine: (c: string) => void = () => {}
    let onError: (error: Error) => void = () => {}
    const proc: GrokProcess = {
      write: (line) => { sent.push(JSON.parse(line) as Record<string, unknown>) },
      closeStdin: () => { killed.push('closeStdin') },
      kill: () => { killed.push('kill') },
      onLine: (cb) => { onLine = cb },
      onStderr: () => {},
      onError: (cb) => { onError = cb },
      onExit: () => {},
    }
    all.push({
      sent, killed,
      reply: (method, result) => {
        const hit = [...sent].reverse().find((s) => s['method'] === method)
        if (hit === undefined) throw new Error(`還沒送出 ${method}`)
        onLine(`${JSON.stringify({ jsonrpc: '2.0', id: hit['id'], result })}\n`)
      },
      fail: (error) => { onError(error) },
    })
    return proc
  }
  return { spawn, all, last: () => { const f = all.at(-1); if (f === undefined) throw new Error('還沒 spawn'); return f } }
}

function setup() {
  const s = makeSpawn()
  const logError = vi.fn()
  let clock = 1_000_000
  const catalog = createGrokCatalog({ spawn: s.spawn, logError, now: () => clock, homeDir: '/home/me' })
  const serve = async (): Promise<void> => {
    await vi.waitFor(() => { if (s.last().sent.every((e) => e['method'] !== 'initialize')) throw new Error('還沒 initialize') })
    s.last().reply('initialize', INITIALIZE_RESULT)
    await vi.waitFor(() => { if (s.last().sent.every((e) => e['method'] !== 'session/list')) throw new Error('還沒 session/list') })
    s.last().reply('session/list', LIST_RESULT)
  }
  return { ...s, logError, catalog, serve, advance: (ms: number) => { clock += ms } }
}

describe('一個連線兩件事', () => {
  it('models 與 list 只開一個子行程,結束後收掉', async () => {
    const r = setup()
    const models = r.catalog.models()
    const listed = r.catalog.list('/p/alpha')
    await r.serve()
    expect(await models).toEqual(INITIALIZE_RESULT._meta.modelState.availableModels)
    expect(await listed).toEqual([
      { sessionId: 's-1', summary: '修 mapper', lastModified: 1_800_000_000_000, cwd: '/p/alpha' },
      { sessionId: 's-2', summary: 's-2', lastModified: 1_799_000_000_000, cwd: '/p/alpha' },
    ])
    expect(r.all).toHaveLength(1)
    expect(r.last().sent.find((e) => e['method'] === 'session/list')?.['params']).toEqual({ cwd: '/p/alpha' })
    expect(r.last().killed).toContain('kill')
  })

  it('沒給 cwd 時用 homeDir', async () => {
    const r = setup()
    const listed = r.catalog.list()
    await r.serve()
    await listed
    expect(r.last().sent.find((e) => e['method'] === 'session/list')?.['params']).toEqual({ cwd: '/home/me' })
  })
})

describe('快取', () => {
  it('30 秒內不再開子行程', async () => {
    const r = setup()
    const first = r.catalog.list('/p/alpha')
    await r.serve()
    await first
    r.advance(GROK_CACHE_MS - 1)
    await expect(r.catalog.list('/p/alpha')).resolves.toHaveLength(2)
    await expect(r.catalog.models()).resolves.toHaveLength(2)
    expect(r.all).toHaveLength(1)
  })

  it('超過 30 秒重查', async () => {
    const r = setup()
    const first = r.catalog.list('/p/alpha')
    await r.serve()
    await first
    r.advance(GROK_CACHE_MS + 1)
    const again = r.catalog.list('/p/alpha')
    await r.serve()
    await again
    expect(r.all).toHaveLength(2)
  })

  it('不同的 cwd 各自查', async () => {
    const r = setup()
    const first = r.catalog.list('/p/alpha')
    await r.serve()
    await first
    const second = r.catalog.list('/p/beta')
    await r.serve()
    await second
    expect(r.all).toHaveLength(2)
  })
})

describe('沒裝 grok', () => {
  it('回空清單,不丟錯,記一次 log', async () => {
    const r = setup()
    const models = r.catalog.models()
    const listed = r.catalog.list('/p/alpha')
    await vi.waitFor(() => { if (r.all.length === 0) throw new Error('還沒 spawn') })
    r.last().fail(Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' }))
    await expect(models).resolves.toEqual([])
    await expect(listed).resolves.toEqual([])
    expect(r.logError).toHaveBeenCalled()
  })
})

describe('toGrokSummary', () => {
  it('沒有 title 時用 sessionId 的前 8 碼', () => {
    expect(toGrokSummary({ sessionId: 'abcdefghijkl', cwd: '/p', updatedAt: 1_800_000_000_000 })).toEqual({
      sessionId: 'abcdefghijkl', summary: 'abcdefgh', lastModified: 1_800_000_000_000, cwd: '/p',
    })
  })

  it('秒為單位的 updatedAt 補成毫秒', () => {
    expect(toGrokSummary({ sessionId: 's', cwd: '/p', updatedAt: 1_800_000_000 })?.lastModified).toBe(1_800_000_000_000)
  })

  it('缺欄位回 undefined', () => {
    expect(toGrokSummary({ cwd: '/p', updatedAt: 1 })).toBeUndefined()
    expect(toGrokSummary('壞掉的東西')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/grok-catalog.test.ts`
Expected: FAIL,找不到 `../src/main/grok/catalog.js`

- [ ] **Step 3: 實作 `src/main/grok/catalog.ts`**

```ts
// src/main/grok/catalog.ts
/**
 * 模型清單與歷史 session 清單(grok 規格 §5.5)。
 *
 * 開一個短命的 `grok agent stdio`,`initialize` 之後同一個連線把兩件事一起做完再收掉,
 * 結果各快取 30 秒。找不到 grok 時一律回空清單:歷史清單與 Chef 不能因為沒裝 grok 而壞掉。
 */
import { homedir } from 'node:os'
import type { SessionSummary } from '../../shared/ipc.js'
import { createRpc } from '../jsonrpc-stdio.js'
import { nodeSpawnGrok, type GrokModel, type SpawnGrok } from './client.js'

export const GROK_CACHE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 15_000
const SUMMARY_MAX = 80

export interface GrokCatalog {
  models(): Promise<readonly GrokModel[]>
  list(cwd?: string): Promise<readonly SessionSummary[]>
}

export interface GrokCatalogDeps {
  readonly spawn?: SpawnGrok
  readonly logError: (error: Error) => void
  readonly timeoutMs?: number
  readonly cacheMs?: number
  readonly now?: () => number
  readonly homeDir?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** 只驗證清單會用到的欄位,協定新增其他欄位時不讓整份清單失效。 */
export function toGrokSummary(raw: unknown): SessionSummary | undefined {
  const record = asRecord(raw)
  if (record === null) return undefined
  const sessionId = record['sessionId']
  const cwd = record['cwd']
  const updatedAt = record['updatedAt']
  if (typeof sessionId !== 'string' || sessionId === '' || typeof cwd !== 'string') return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  const meta = asRecord(asRecord(record['_meta'])?.['x.ai/session'])
  const title = meta === null ? undefined : meta['title']
  const trimmed = typeof title === 'string' ? title.trim() : ''
  const summary = trimmed.length > SUMMARY_MAX ? `${trimmed.slice(0, SUMMARY_MAX)}…` : trimmed
  return {
    sessionId,
    summary: summary === '' ? sessionId.slice(0, 8) : summary,
    lastModified: updatedAt < 1e12 ? updatedAt * 1000 : updatedAt,
    cwd,
  }
}

function readModels(result: unknown): readonly GrokModel[] {
  const state = asRecord(asRecord(asRecord(result)?.['_meta'])?.['modelState'])
  const list = state === null ? undefined : state['availableModels']
  if (!Array.isArray(list)) return []
  return list.flatMap((entry: unknown): readonly GrokModel[] => {
    const record = asRecord(entry)
    const id = record === null ? undefined : record['id']
    if (record === null || typeof id !== 'string' || id === '') return []
    const efforts = record['reasoningEfforts']
    const name = record['name']
    return [{
      id,
      name: typeof name === 'string' && name !== '' ? name : id,
      reasoningEfforts: Array.isArray(efforts) ? efforts.filter((e): e is string => typeof e === 'string') : [],
    }]
  })
}

interface Probe {
  readonly models: readonly GrokModel[]
  readonly sessions: readonly SessionSummary[]
}

const EMPTY: Probe = { models: [], sessions: [] }

export function createGrokCatalog(deps: GrokCatalogDeps): GrokCatalog {
  const spawn = deps.spawn ?? nodeSpawnGrok
  const now = deps.now ?? (() => Date.now())
  const cacheMs = deps.cacheMs ?? GROK_CACHE_MS
  const home = deps.homeDir ?? homedir()
  let cache: ReadonlyMap<string, { readonly at: number; readonly value: Probe }> = new Map()
  let inflight: ReadonlyMap<string, Promise<Probe>> = new Map()

  /** 一個短命連線,initialize 取模型、session/list 取該 cwd 的 session,然後收掉。 */
  const probe = async (cwd: string): Promise<Probe> => {
    const proc = spawn(cwd)
    const rpc = createRpc({ write: (line) => { proc.write(line) }, onLine: (cb) => { proc.onLine(cb) } }, deps.logError, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    proc.onStderr(() => {})
    proc.onError((error) => { rpc.rejectAll(error) })
    proc.onExit((code) => { rpc.rejectAll(new Error(`grok 子行程已結束(code ${code ?? 'null'})`)) })
    try {
      const initialize = await rpc.request<unknown>('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'yeschef', version: '0.0.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      const listed = await rpc.request<unknown>('session/list', { cwd })
      const sessions = asRecord(listed)?.['sessions']
      return {
        models: readModels(initialize),
        sessions: Array.isArray(sessions)
          ? sessions.flatMap((entry: unknown) => { const one = toGrokSummary(entry); return one === undefined ? [] : [one] })
          : [],
      }
    } finally {
      rpc.rejectAll(new Error('grok 清單查詢已結束'))
      proc.closeStdin()
      proc.kill()
    }
  }

  const fresh = (cwd: string): Probe | undefined => {
    const hit = cache.get(cwd)
    return hit !== undefined && now() - hit.at < cacheMs ? hit.value : undefined
  }

  const load = (cwd: string): Promise<Probe> => {
    const cached = fresh(cwd)
    if (cached !== undefined) return Promise.resolve(cached)
    const running = inflight.get(cwd)
    if (running !== undefined) return running
    const task = probe(cwd).catch((cause: unknown) => {
      // 找不到 grok、沒登入、逾時都只記 log:清單其他部分照常(規格 §5.5)。
      deps.logError(cause instanceof Error ? cause : new Error(String(cause)))
      return EMPTY
    }).then((value) => {
      cache = new Map([...cache, [cwd, { at: now(), value }]])
      return value
    }).finally(() => {
      inflight = new Map([...inflight].filter(([key]) => key !== cwd))
    })
    inflight = new Map([...inflight, [cwd, task]])
    return task
  }

  return {
    models: async () => {
      // 模型與 cwd 無關,但要跟 session 清單共用同一個連線,所以掛在 home 這一格。
      const anyFresh = [...cache.values()].find((entry) => now() - entry.at < cacheMs)
      if (anyFresh !== undefined) return anyFresh.value.models
      return (await load(home)).models
    },
    list: async (cwd) => (await load(cwd ?? home)).sessions,
  }
}
```

測試「models 與 list 只開一個子行程」靠的是兩個呼叫同時發出時 `inflight` 只有一筆:
`models()` 沒有新鮮快取時走 `load(home)`,`list('/p/alpha')` 走 `load('/p/alpha')`,那是兩個
連線。要讓它們共用,`models()` 改成「先看有沒有任何進行中的 probe,有就等它」:

```ts
    models: async () => {
      const anyFresh = [...cache.values()].find((entry) => now() - entry.at < cacheMs)
      if (anyFresh !== undefined) return anyFresh.value.models
      const running = [...inflight.values()][0]
      if (running !== undefined) return (await running).models
      return (await load(home)).models
    },
```

把上面 `models` 的實作換成這一段。

- [ ] **Step 4: Chef 多一組 Grok 模型**

`src/main/chef/models.ts`:頂端加

```ts
import { createRpc } from '../jsonrpc-stdio.js'
import { nodeSpawnGrok, type SpawnGrok as SpawnGrokProcess } from '../grok/client.js'
```

`createChefModelCatalog` 的簽名多一個參數,預設 `nodeSpawnGrok`:

```ts
export function createChefModelCatalog(queryFn: typeof query, cwd: string, spawn: SpawnCodex = nodeSpawnCodex, spawnGrok: SpawnGrokProcess = nodeSpawnGrok): ModelCatalog {
```

`codex()` 後面加一個同形狀的 `grok()`:

```ts
  /** grok 的模型在 initialize 的 _meta.modelState.availableModels(grok 規格 §3)。 */
  async function grok(): Promise<ChefModel[]> {
    const p = spawnGrok(cwd), rpc = createRpc({ write: line => p.write(line), onLine: cb => p.onLine(cb) }, () => {}, 15000)
    p.onStderr(() => {})
    p.onError(error => rpc.rejectAll(error)); p.onExit(() => rpc.rejectAll(Error('Grok 模型清單連線已結束')))
    try {
      const response = await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'yeschef-chef', version: '1.0.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }) as { _meta?: { modelState?: { availableModels?: unknown[]; currentModelId?: unknown } } }
      const state = response._meta?.modelState
      return (state?.availableModels ?? []).flatMap((value): ChefModel[] => {
        const m = value as Record<string, unknown>
        if (typeof m.id !== 'string' || m.id === '') return []
        return [{ key: `grok:${m.id}`, provider: 'grok', model: m.id, label: typeof m.name === 'string' ? m.name : m.id, description: '', recommended: m.id === state?.currentModelId }]
      })
    } finally { rpc.rejectAll(Error('模型清單讀取結束')); p.closeStdin(); p.kill() }
  }
```

`list()` 裡的 `Promise.allSettled([claude(), codex()])` 改成三個,標籤陣列一起改:

```ts
      const results = await Promise.allSettled([claude(), codex(), grok()])
      const models: ChefModel[] = [], notices: string[] = []
      const LABELS = ['Claude', 'Codex', 'Grok'] as const
      results.forEach((result, i) => result.status === 'fulfilled' ? models.push(...result.value) : notices.push(`${LABELS[i]}：${result.reason instanceof Error ? result.reason.message : '模型清單不可用'}`))
```

`src/renderer/components/ChefManager.tsx` 第 63 行已在 Task 1 改成 `PROVIDER_LABELS[model.provider].name`,Grok 的那一組會自己出現,不需要再改。

- [ ] **Step 5: 跑測試**

Run: `npx vitest run tests/grok-catalog.test.ts tests/chef-routing.test.ts tests/chef-service.test.ts tests/chef-manager.test.tsx && npm run typecheck`
Expected: PASS。`tests/chef-service.test.ts` 若對 `createChefModelCatalog` 的 notices 逐字比對,補上 Grok 那一則。

- [ ] **Step 6: Commit**

```bash
git add src/main/grok/catalog.ts src/main/chef/models.ts tests/grok-catalog.test.ts
git commit -m "feat: list grok models and sessions"
```

---

### Task 8: 主廚的三個控制工具掛進 HTTP MCP server

**Files:**
- Modify: `src/main/chef/tools.ts`(多匯出 `sdkTools` 與 `names`)
- Modify: `src/main/view-tools/conversation-server.ts`(多一個 `chefTools` dep)
- Test: `tests/chef-view-tools.test.ts`

**Interfaces:**
- Consumes:Task 5 的 `startViewToolHttpServer`、`HTTP_MSG`
- Produces:

```ts
// src/main/chef/tools.ts:回傳值多兩個欄位,既有三個不變
export function createChefTools(service: ChefService, workerId: string): {
  readonly server: McpSdkServerConfigWithInstance
  readonly specs: CodexDynamicTool[]
  call(name: string, args: unknown): Promise<CodexToolOutcome>
  /** 這個工作者實際拿得到的工具名(coordinator 三個,worker 只有 task_progress)。 */
  readonly names: readonly string[]
  /** 與 `server` 裡那一份逐字相同的工具定義,給別的 MCP server 掛用。 */
  readonly sdkTools: readonly SdkMcpToolDefinition[]
}

// src/main/view-tools/conversation-server.ts
export interface ConversationViewServerDeps {
  readonly resolve: () => Promise<ViewTools>
  readonly peer?: PeerTools
  /**
   * 給了就把主廚的控制工具掛在同一份 server 上(grok 的 worker 專用)。
   * Claude 走 `sessionOptions.mcpServers.chef`、codex 走 dynamicTools,那兩條路不給這個,
   * 否則模型會同時看到 `mcp__chef__report_result` 與 `mcp__yeschef__report_result` 兩份。
   */
  readonly chefTools?: { readonly sdkTools: readonly SdkMcpToolDefinition[] }
  readonly logError: (error: Error) => void
}
```

Task 9 接線時怎麼知道一個 grok 對話是 worker:`runtimeFor` 多收第四個參數 `provider: Provider`
(Task 9 的 Step 3 會改 `IpcBridgeDeps.runtimeFor` 的簽名),`index.ts` 裡用
`provider === 'grok' && chef?.worker(conversationId) !== undefined` 決定要不要把
`createChefTools(chef, conversationId)` 的 `sdkTools` 交給 `createConversationViewServer`。
`chef.worker(conversationId)` 就是 `runtimeFor` 現在已經用來決定要不要掛 peer 的那個查詢。

- [ ] **Step 1: 寫失敗的測試**

```ts
// tests/chef-view-tools.test.ts
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChefTools } from '../src/main/chef/tools.js'
import { createConversationViewServer } from '../src/main/view-tools/conversation-server.js'
import { startViewToolHttpServer, type ViewToolHttpServer } from '../src/main/view-tools/http-server.js'
import type { ChefService } from '../src/main/chef/service.js'
import type { ViewTools } from '../src/main/view-tools/server.js'

interface Reply { readonly status: number; readonly body: string; readonly sessionId: string | undefined }

function call(port: number, token: string, payload: unknown, sessionId?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
        authorization: `Bearer ${token}`,
        ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const header = res.headers['mcp-session-id']
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), sessionId: typeof header === 'string' ? header : undefined })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

function fakeTools(): ViewTools {
  return {
    invoke: () => Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: '好了' } }),
    handoffDone: () => {}, abortPending: () => {}, busy: () => false, dispose: () => Promise.resolve(),
  }
}

const REPORT = { outcome: 'completed' as const, summary: '做完了', checks: [] }

/** 只實作 createChefTools 會碰到的那幾個方法。 */
function fakeChef(role: 'coordinator' | 'worker') {
  const reports: unknown[] = []
  const service = {
    runnable: () => true,
    worker: () => ({ role, model: 'grok-4-7', taskId: 'task-1' }),
    delegate: () => Promise.resolve({ ok: true }),
    progress: () => ({ workers: [] }),
    report: (workerId: string, args: unknown) => { reports.push([workerId, args]); return Promise.resolve({ accepted: true }) },
  } as unknown as ChefService
  return { service, reports }
}

let running: ViewToolHttpServer | undefined
afterEach(async () => { await running?.close(); running = undefined })

type ChefTools = ReturnType<typeof createChefTools>

async function start(chef?: ChefTools) {
  const logError = vi.fn()
  const view = createConversationViewServer({
    resolve: () => Promise.resolve(fakeTools()),
    logError,
    ...(chef === undefined ? {} : { chefTools: chef }),
  })
  const server = await startViewToolHttpServer(view, logError)
  running = server
  const port = Number(new URL(server.url).port)
  const init = await call(port, server.token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok', version: '1.0.40' } } })
  const sessionId = init.sessionId as string
  await call(port, server.token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
  const names = async (): Promise<string[]> => {
    const listed = await call(port, server.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId)
    return (JSON.parse(listed.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
  }
  const invoke = (name: string, args: unknown) =>
    call(port, server.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, sessionId)
  return { names, invoke, logError }
}

describe('主廚工具掛在 HTTP MCP server 上', () => {
  it('不是 worker 的對話:tools/list 沒有那三個工具', async () => {
    const rig = await start()
    const names = await rig.names()
    expect(names).toContain('view_snapshot')
    for (const name of ['delegate_task', 'task_progress', 'report_result']) expect(names).not.toContain(name)
  })

  it('coordinator 的 worker 對話:三個工具都在', async () => {
    const chef = fakeChef('coordinator')
    const rig = await start(createChefTools(chef.service, 'w-1'))
    const names = await rig.names()
    for (const name of ['delegate_task', 'task_progress', 'report_result']) expect(names).toContain(name)
    expect(names).toContain('view_snapshot')
  })

  it('role 是 worker 時只掛 task_progress,與 Claude、codex 那兩條路一致', async () => {
    const chef = fakeChef('worker')
    const rig = await start(createChefTools(chef.service, 'w-1'))
    const names = await rig.names()
    expect(names).toContain('task_progress')
    expect(names).not.toContain('report_result')
    expect(names).not.toContain('delegate_task')
  })

  it('report_result 的呼叫真的進到 Chef 的處理函式,workerId 是這個對話', async () => {
    const chef = fakeChef('coordinator')
    const rig = await start(createChefTools(chef.service, 'w-1'))
    const called = await rig.invoke('report_result', REPORT)
    expect(called.status).toBe(200)
    expect(chef.reports).toEqual([['w-1', REPORT]])
    expect(called.body).toContain('accepted')
  })

  it('主廚工具失敗時以文字回去,不是協定層錯誤', async () => {
    const chef = fakeChef('coordinator')
    const tools = createChefTools({ ...chef.service, runnable: () => false } as unknown as ChefService, 'w-1')
    const rig = await start(tools)
    const called = await rig.invoke('report_result', REPORT)
    expect(called.status).toBe(200)
    expect(called.body).toContain('這個工作者已停止或不是目前執行者')
  })
})
```

`fakeChef` 的 `worker()` 回傳形狀以 `src/main/chef/service.ts` 目前的 `WorkerHandle` 為準;
只要有 `role` 這個欄位,`createChefTools` 的 `names` 判斷就跑得起來。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/chef-view-tools.test.ts`
Expected: FAIL,`createChefTools` 沒有 `sdkTools`,`ConversationViewServerDeps` 沒有 `chefTools`

- [ ] **Step 3: 改 `src/main/chef/tools.ts`**

把建 `server` 的那一行拆成兩步,回傳多兩個欄位,其餘一字不改:

```ts
  const names = service.worker(workerId)?.role === 'worker' ? ['task_progress'] as const : CHEF_TOOL_NAMES
  const sdkTools = names.map(name => tool(name, descriptions[name], schemas[name].shape, async args => {
    const result = await call(name, args)
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.ok ? {} : { isError: true }) }
  }))
  const server = createSdkMcpServer({ name: 'chef', version: '1.0.0', tools: sdkTools })
  const specs: CodexDynamicTool[] = names.map(name => ({ type: 'function', name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) as Record<string, unknown> }))
  return { server, specs, call, names, sdkTools }
```

`sdkTools` 的型別由 `tool()` 推導,就是 `SdkMcpToolDefinition[]`;要在 `conversation-server.ts`
標註,從 agent SDK import 型別:

```ts
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
```

- [ ] **Step 4: 改 `src/main/view-tools/conversation-server.ts`**

1. import 加上面那一行。
2. `ConversationViewServerDeps` 在 `peer` 後面加:

```ts
  /**
   * 給了就把主廚的控制工具掛在同一份 server 上。只有 grok 的 worker 對話會給:
   * Claude 走 `sessionOptions.mcpServers.chef`、codex 走 dynamicTools,那兩條路自己有一份,
   * 這裡再掛一份會讓模型同時看到兩個 report_result。
   */
  readonly chefTools?: { readonly sdkTools: readonly SdkMcpToolDefinition[] }
```

3. `createSdkMcpServer` 的 `tools` 陣列多一段:

```ts
    tools: [
      ...createTools(invoke),
      ...(deps.peer === undefined ? [] : createPeerTools(deps.peer, deps.logError)),
      ...(deps.chefTools === undefined ? [] : deps.chefTools.sdkTools),
    ],
```

4. 檔頭 `createTools` 上方那句「八個工具的 Claude 殼」的註解不動;在 `createConversationViewServer`
上方補一句:

```ts
/**
 * 一個對話一份 MCP server。工具有三組:右窗格工具(一定有)、同伴問答(有 peer 才有)、
 * 主廚控制工具(只有 grok 的 worker 對話才有,見 `chefTools` 的說明)。
 */
```

- [ ] **Step 5: 跑測試**

Run: `npx vitest run tests/chef-view-tools.test.ts tests/view-tools/conversation-server.test.ts tests/chef-service.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/chef/tools.ts src/main/view-tools/conversation-server.ts tests/chef-view-tools.test.ts
git commit -m "feat: offer the chef control tools over the http mcp server"
```

---

### Task 9: `ipc-bridge.ts` 與 `index.ts` 接線

**Files:**
- Modify: `src/main/ipc-bridge.ts`(`ProjectRuntime`、`IpcBridgeDeps`、`linkFor`、`createSlot`、`onSessionList`、`activityFor`)
- Modify: `src/main/index.ts`(`runtimeFor` 的 `grokViewTools`、`createGrokCatalog`)
- Test: `tests/ipc-bridge.test.ts`

**Interfaces:**
- Consumes:Task 5 的 `startViewToolHttpServer`;Task 6 的 `createGrokConversation`、`GrokViewTools`;Task 7 的 `createGrokCatalog`、`GrokCatalog`;Task 8 的 `createChefTools(...).sdkTools` 與 `ConversationViewServerDeps.chefTools`
- Produces:

```ts
// src/main/ipc-bridge.ts
export interface ProjectRuntime {
  // …既有欄位不變…
  /** grok 對話用的右窗格工具(grok 規格 §5.6)。 */
  readonly grokViewTools?: GrokViewTools
}
export interface IpcBridgeDeps {
  // …既有欄位不變…
  readonly grokCatalog: GrokCatalog
  /**
   * 多收第四個參數 `provider`:index.ts 要靠它決定 grok 的 worker 對話要不要把
   * 主廚控制工具掛進 HTTP MCP server(Task 8)。前三個參數與意義都不變。
   */
  readonly runtimeFor: (projectId: string, cwd: string, conversationId: string, provider: Provider) => ProjectRuntime
  /** 測試用接縫:換掉 grok 的對話核心。 */
  readonly createGrokConversation?: typeof defaultCreateGrokConversation
}
```

- [ ] **Step 1: 寫失敗的測試**

`tests/ipc-bridge.test.ts` 的 `makeRig`:`codexCatalog` 那一行後面加一行,`runtimeFor` 回傳的物件加一塊,並多一個 `createGrokConversation` 接縫(寫法照既有的 `createCodexConversation`):

```ts
    grokCatalog: { models: async () => [], list: async () => [] },
```

```ts
        grokViewTools: {
          mcpServers: async () => [{ name: 'yeschef', type: 'http' as const, url: `http://127.0.0.1:1/mcp`, headers: [{ name: 'Authorization', value: 'Bearer test' }] }],
          handoffDone: (toolUseId: string) => { log.push(`${conversationId}.handoffDone(${toolUseId})`) },
          close: () => { log.push(`${conversationId}.grokHttp.close`); return Promise.resolve() },
        },
```

```ts
    createGrokConversation: (d) => {
      const tag = grokTags.get(d.cwd) ?? 'grok-unknown'
      const fake = makeFakeCore(tag, { ...d, sessionOptions: () => ({}) } as unknown as ConversationDeps, record, slowDispose)
      fakes.set(tag, fake)
      created.push(tag)
      grokDeps.set(tag, d)
      return fake.core
    },
```

`grokTags` 與 `grokDeps` 照 `codexTags`、`codexDeps` 的宣告加在同一處。`runtimeFor` 的箭頭函式
多收第四個參數 `provider`,並把它記進一個陣列供斷言:

```ts
    runtimeFor: (projectId, rootPath, conversationId, provider) => {
      runtimeProviders.push([conversationId, provider])
      // …其餘不變…
```

既有斷言 `expect(runtimeFor.mock.calls[0]).toEqual([A, worktreePath, 'worktree-tab'])` 要補上
第四個元素(那些分頁的 provider 是 `'claude'` 或 `'codex'`,照該分頁的設定填);
`toHaveBeenLastCalledWith` 的兩處同理。新的測試:

```ts
describe('grok 分頁', () => {
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

  it('session:list 帶 provider grok 時查 grokCatalog', async () => {
    const listed: Array<string | undefined> = []
    const rig = makeRig(undefined, {
      grokCatalog: { models: async () => [], list: async (cwd?: string) => { listed.push(cwd); return [] } },
    })
    await rig.invoke(IPC.sessionList, { projectId: null, provider: 'grok' })
    expect(listed).toEqual([undefined])
  })
})
```

`makeRigWithGrokTab` 是本檔既有 `makeRig` 的小包裝:初始狀態多一個 `provider: 'grok'` 的對話分頁,
寫法照既有建 codex 分頁的那一段(`codexTags` 怎麼填,`grokTags` 就怎麼填)。`rig.invoke` 是本檔
既有觸發 invoke 頻道的 helper;名字以該檔為準。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run tests/ipc-bridge.test.ts`
Expected: FAIL,`grokCatalog` 不是 `IpcBridgeDeps` 的欄位

- [ ] **Step 3: 改 `src/main/ipc-bridge.ts`**

1. 頂端 import 加:

```ts
import { createGrokConversation as defaultCreateGrokConversation, type GrokViewTools } from './grok/conversation.js'
import type { GrokCatalog } from './grok/catalog.js'
```

2. `ProjectRuntime` 在 `codexViewTools` 後面加:

```ts
  /** grok 對話用的右窗格工具(grok 規格 §5.6);token 在這裡面,不外流。 */
  readonly grokViewTools?: GrokViewTools
```

3. `IpcBridgeDeps` 的 `runtimeFor` 簽名多第四個參數:

```ts
  /** 每個對話分頁呼叫一次(D2)。`cwd` 是該對話的工作目錄,可能是 worktree 路徑;`provider` 決定要掛哪一組工具。 */
  readonly runtimeFor: (projectId: string, cwd: string, conversationId: string, provider: Provider) => ProjectRuntime
```

在 `codexCatalog` 後面加 `readonly grokCatalog: GrokCatalog`,在 `createCodexConversation` 後面加:

```ts
  /** 測試用接縫:換掉 grok 的對話核心。 */
  readonly createGrokConversation?: typeof defaultCreateGrokConversation
```

4. `linkFor` 上方加一張表,函式內改查它:

```ts
/** 哪一種 provider 有本機 transcript。codex 與 grok 都沒有,thread 記 null。 */
const HAS_TRANSCRIPT: Readonly<Record<Provider, boolean>> = { claude: true, codex: false, grok: false }
```
```ts
    transcriptPath: HAS_TRANSCRIPT[provider] ? transcriptPathFor(deps.homeDir, cwd ?? rootPath, sessionId) : null,
```

5. `createSlot` 結尾那段 `if (provider === 'codex') { … } … const runtime = …` 整段換成下面這一段
(`common`、`tab`、`cwd`、`provider`、`managed`、`chefTools`、`initialSessionId` 的宣告不動):

```ts
    const runtime = deps.runtimeFor(projectId, cwd, conversationId, provider)

    const makeClaude = (): Conversation => (deps.createConversation ?? defaultCreateConversation)({
      ...common,
      onSessionStarted: (sessionId, startedCwd) => recordStarted('claude', conversationId, projectId, sessionId, startedCwd),
      strictShutdown: Boolean(managed),
      internalAutoAllow: managed ? name => /^mcp__chef__(delegate_task|task_progress|report_result)$/.test(name) : undefined,
      sessionOptions: managed ? resume => { const options = runtime.sessionOptions(resume); return { ...options, model: managed.model, maxTurns: 64, disallowedTools: [...(options.disallowedTools ?? []), 'Agent', 'Task'], mcpServers: { ...options.mcpServers, ...(chefTools ? { chef: chefTools.server } : {}) } } } : runtime.sessionOptions,
      loadHistory: (sessionId) => deps.sessions.loadHistory(sessionId, (id) => sessionCostOf(deps.projects.state(), id)),
      initialSessionId,
      viewTools: runtime.viewTools,
      queryFn: deps.queryFn,
      createHost: deps.createHost,
    })

    const makeCodex = (): Conversation => (deps.createCodexConversation ?? defaultCreateCodexConversation)({
      ...common,
      ...(managed ? { model: managed.model } : {}),
      ...(chefTools ? { chefTools } : {}),
      onSessionStarted: (sessionId, startedCwd) => recordStarted('codex', conversationId, projectId, sessionId, startedCwd),
      cwd,
      ...(runtime.codexSkillRoots === undefined ? {} : { skillRoots: runtime.codexSkillRoots }),
      loadHistory: (threadId) => deps.codexCatalog.items(cwd, threadId),
      ...(initialSessionId === undefined ? {} : { initialThreadId: initialSessionId }),
      ...(deps.peer === undefined || managed ? {} : { peerTools: deps.peer.forConversation(conversationId) }),
      ...(runtime.codexViewTools === undefined ? {} : { viewTools: runtime.codexViewTools }),
    })

    /**
     * grok 的同伴工具不另外接:它們掛在同一份 HTTP MCP server 上,由 runtimeFor 建
     * `createConversationViewServer` 時就帶進去了(grok 規格 §6.1)。
     */
    const makeGrok = (): Conversation => (deps.createGrokConversation ?? defaultCreateGrokConversation)({
      ...common,
      ...(managed ? { model: managed.model } : {}),
      onSessionStarted: (sessionId, startedCwd) => recordStarted('grok', conversationId, projectId, sessionId, startedCwd),
      cwd,
      ...(initialSessionId === undefined ? {} : { initialSessionId }),
      ...(runtime.grokViewTools === undefined ? {} : { viewTools: runtime.grokViewTools }),
    })

    const factories: Readonly<Record<Provider, () => Conversation>> = { claude: makeClaude, codex: makeCodex, grok: makeGrok }
    return { core: factories[provider](), runtime, projectId, rootPath }
```

6. `onSessionList` 的 `const source = scope.provider === 'codex' ? deps.codexCatalog : deps.sessions` 換成:

```ts
      const sources: Readonly<Record<Provider, { list(cwd?: string): Promise<readonly SessionSummary[]> }>> = {
        claude: deps.sessions, codex: deps.codexCatalog, grok: deps.grokCatalog,
      }
      const source = sources[scope.provider ?? 'claude']
```

7. `activityFor` 的兩處 `if (provider === 'codex')` 與 `if (source.provider === 'codex')` 不動:
grok 沒有可回溯讀取的歷史 API,`session/load` 只能重播進一個活著的 session,不適合在
diff 查詢時做。grok 對話的寫檔證據只來自 `slot.core.activityEvents()`(live 那一段),
在 `activityFor` 裡不需要多寫程式,但要補註解說明為什麼沒有 grok 的分支:

```ts
    // grok 沒有「讀某個 session 的歷史項目」這種 API,只有 session/load 的重播。
    // 重播要一個活著的子行程,不適合在 diff 查詢裡做,所以 grok 只用 live 的事件。
    // 這是已知代價:Grok 分頁關掉再開,之前那一段的寫檔證據查不回來,diff 會少列檔案。
```

- [ ] **Step 4: 改 `src/main/index.ts`**

1. import 加:

```ts
import { createGrokCatalog } from './grok/catalog.js'
import { createChefTools } from './chef/tools.js'
import { startViewToolHttpServer, type ViewToolHttpServer } from './view-tools/http-server.js'
import type { Provider } from '../shared/projects.js'
```

`createChefTools` 在 `index.ts` 裡可能還沒 import(目前只有 `ipc-bridge.ts` 用它);
`Provider` 同理,若已經有就不重複。

2. `runtimeFor` 整個換成(既有內容加上 HTTP server 的延遲啟動與收尾):

```ts
  // 每個對話一份 MCP server;瀏覽器本身等第一次工具呼叫才建(規格 §4.3)。
  // grok 那條路再多一層 localhost HTTP,第一次要 mcpServers 時才 listen(grok 規格 §6)。
  const runtimeFor = (_projectId: string, cwd: string, conversationId: string, provider: Provider): ProjectRuntime => {
    const managed = chef?.worker(conversationId)
    // grok 的 worker 只有 HTTP MCP server 這一條路拿得到主廚的控制工具;
    // Claude 走 sessionOptions.mcpServers.chef,codex 走 dynamicTools,兩者都不從這裡拿。
    const workerTools = provider === 'grok' && managed !== undefined && chef !== undefined
      ? createChefTools(chef, conversationId)
      : undefined
    const own = createConversationViewServer({
      resolve: async () => (await browserSessions.ensure(conversationId)).tools,
      logError,
      ...(managed ? {} : { peer: peer.forConversation(conversationId) }),
      ...(workerTools === undefined ? {} : { chefTools: workerTools }),
    })
    const sessionOptions = createSessionOptionsFactory(
      cwd,
      appDir,
      liveCwd,
      { [VIEW_TOOL_SERVER_NAME]: own.server },
      { window: autoCompactWindow(), baseEnv: process.env },
      () => sharedSkills?.runtime().plugins ?? []
    )
    const tools = (): ViewTools | undefined => browserSessions.get(conversationId)?.tools
    let http: Promise<ViewToolHttpServer> | null = null
    const closeHttp = async (): Promise<void> => {
      const started = http
      http = null
      if (started === null) return
      try {
        await (await started).close()
      } catch (cause) {
        logError(toError(cause))
      }
    }
    return {
      sessionOptions,
      codexSkillRoots: () => sharedSkills?.runtime().roots ?? [],
      viewTools: {
        autoAllow: (toolName) => viewToolPolicy(toolName) === 'allow',
        handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
        abortPending: (reason) => { tools()?.abortPending(reason) },
      },
      codexViewTools: {
        invoke: (name, args, ctx) => own.invoke(name, args, ctx),
        handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
      },
      grokViewTools: {
        mcpServers: async () => {
          http ??= startViewToolHttpServer(own, logError)
          const server = await http
          // token 只出現在這裡,不寫檔、不進 log、不進事件、不進 renderer(grok 規格 §6.2)。
          return [{
            name: VIEW_TOOL_SERVER_NAME, type: 'http' as const, url: server.url,
            headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
          }]
        },
        handoffDone: (toolUseId) => { tools()?.handoffDone(toolUseId) },
        close: closeHttp,
      },
      dispose: () => {
        own.dispose()
        // 對話核心收尾時已經關過一次,這裡是「從沒開過對話就關分頁」的那條路。
        void closeHttp()
      },
    }
  }
```

3. `createIpcBridge` 的 deps,在 `codexCatalog: createCodexCatalog({ spawn: nodeSpawnCodex, logError }),` 後面加:

```ts
    grokCatalog: createGrokCatalog({ logError }),
```

- [ ] **Step 5: 跑測試**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-bridge.ts src/main/index.ts tests/ipc-bridge.test.ts
git commit -m "feat: route grok conversation tabs through the bridge"
```

---

### Task 10: Renderer 的第三顆按鈕

**Files:**
- Modify: `src/renderer/components/LeftPane.tsx`
- Test: `tests/left-pane.test.tsx`

**Interfaces:**
- Consumes:Task 1 的 `PROVIDER_LABELS`
- Produces:`export const NEW_GROK_CONVERSATION_LABEL = '新 Grok 對話'`

- [ ] **Step 1: 寫失敗的測試**

`tests/left-pane.test.tsx` 加(`renderPane`、`opened` 之類的 helper 以該檔既有寫法為準):

```tsx
  it('三顆新對話按鈕,按 Grok 那顆開 grok 對話', () => {
    const rig = renderPane()
    expect(screen.getByRole('button', { name: NEW_CONVERSATION_LABEL })).toBeTruthy()
    expect(screen.getByRole('button', { name: NEW_CODEX_CONVERSATION_LABEL })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: NEW_GROK_CONVERSATION_LABEL }))
    expect(rig.opened.at(-1)).toEqual(['grok', undefined])
  })
```

`rig.opened` 記的是 `projects.openConversation` 的呼叫;若該檔記的是別種形狀,照它改斷言。

Run: `npx vitest run tests/left-pane.test.tsx`
Expected: FAIL,找不到 `NEW_GROK_CONVERSATION_LABEL`

- [ ] **Step 2: 實作**

`src/renderer/components/LeftPane.tsx`:

1. 三個常數改成從 `PROVIDER_LABELS` 導出,並補第三個(import 加 `PROVIDER_LABELS`):

```ts
export const NEW_CONVERSATION_LABEL = '新對話'
export const NEW_CODEX_CONVERSATION_LABEL = `新 ${PROVIDER_LABELS.codex.name} 對話`
export const NEW_GROK_CONVERSATION_LABEL = `新 ${PROVIDER_LABELS.grok.name} 對話`
```

2. `quick-launch` 裡 Codex 那顆後面加第三顆:

```tsx
          <button type="button" className="tab-new-conversation" aria-label={NEW_GROK_CONVERSATION_LABEL} title={`新增 ${PROVIDER_LABELS.grok.name} 對話`} onClick={() => start('grok')}>
            <Icon name="plus" />{PROVIDER_LABELS.grok.name}
          </button>
```

Claude 與 Codex 那兩顆的 `title` 與按鈕文字同樣改查 `PROVIDER_LABELS`,三顆寫法一致。

3. `data-provider` 屬性已經吃 `tab.provider ?? 'claude'`,不必改;`LeftPane.css` 若有
`[data-provider='codex']` 的配色,照同一組規則加一條 `[data-provider='grok']`,顏色沿用現有 token。

- [ ] **Step 3: 跑測試**

Run: `npx vitest run tests/left-pane.test.tsx && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/LeftPane.tsx src/renderer/components/LeftPane.css tests/left-pane.test.tsx
git commit -m "feat: add the grok new conversation button"
```

---

### Task 11: Spike 與 RESULTS 骨架

**Files:**
- Create: `spikes/grok-acceptance.ts`
- Modify: `package.json`(`scripts` 加 `spike:grok`)
- Create: `docs/RESULTS-37-grok-runtime.md`

**Interfaces:**
- Consumes:Task 4 的 `createGrokClient`、`AcpMcpServer`;Task 5 的 `startViewToolHttpServer`;Task 3 的 `createGrokMapper`;`src/main/view-tools/conversation-server.ts` 的 `createConversationViewServer`
- Produces:`npm run spike:grok`,每項印一行 `{ check, ok, detail }`,全過 exit 0。

這個 spike 不需要 Electron:右窗格工具用一份假的 `ViewTools`,只回一段固定文字,
要驗的是「grok 真的打得到 localhost 的 MCP server」而不是瀏覽器本身。
它會用到 grok.com 的額度。

- [ ] **Step 1: 加 script**

`package.json` 的 `scripts` 在 `spike:acceptance` 後面加:

```json
    "spike:grok": "esbuild spikes/grok-acceptance.ts --bundle --platform=node --format=esm --packages=external --outfile=.spike-out/grok-acceptance.mjs && node .spike-out/grok-acceptance.mjs",
```

`--packages=external` 讓 `node_modules` 在執行時解析,不把 agent SDK 打進來。

- [ ] **Step 2: 寫 spike**

```ts
// spikes/grok-acceptance.ts
/**
 * 用真的 `grok` 驗四件事(grok 規格 §11.2):
 * 1. `session/new` 帶 http 形狀的 mcpServers,grok 連得上 yeschef 的 MCP server。
 * 2. 叫它呼叫 view_snapshot,`tools/call` 真的打到我們的 server。
 * 3. `session/request_permission` 進來,回 allow 之後回合結束。
 * 4. `session/list` 列得到剛才那個 session,`session/load` 重播得出同樣的工具呼叫。
 * 每項印一行 JSON:{ check, ok, detail }。全部通過 exit 0,否則 exit 1。
 * 會用到 grok.com 的額度。
 */
import { createGrokClient, type AcpMcpServer, type PermissionOutcome } from '../src/main/grok/client.js'
import { createGrokMapper } from '../src/main/grok/mapper.js'
import { createGrokCatalog } from '../src/main/grok/catalog.js'
import { createConversationViewServer } from '../src/main/view-tools/conversation-server.js'
import { startViewToolHttpServer } from '../src/main/view-tools/http-server.js'
import type { ViewTools } from '../src/main/view-tools/server.js'

const SNAPSHOT_TEXT = 'spike-snapshot-ok'
const PROMPT = `請呼叫 view_snapshot 工具看一下右窗格,然後把它回傳的第一行原樣告訴我。`
const results: { check: string; ok: boolean; detail: string }[] = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ check: name, ok, detail })
  console.log(JSON.stringify({ check: name, ok, detail }))
}

const toolCalls: string[] = []

/** 假的右窗格:只回一段固定文字,不開瀏覽器。 */
function fakeTools(): ViewTools {
  return {
    invoke: (name) => {
      toolCalls.push(name)
      return Promise.resolve({ ok: true as const, output: { kind: 'text' as const, text: SNAPSHOT_TEXT } })
    },
    handoffDone: () => {},
    abortPending: () => {},
    busy: () => false,
    dispose: () => Promise.resolve(),
  }
}

async function main(): Promise<void> {
  const logError = (error: Error): void => { console.error(error.message) }
  const view = createConversationViewServer({ resolve: () => Promise.resolve(fakeTools()), logError })
  const http = await startViewToolHttpServer(view, logError)
  const mcp: AcpMcpServer = {
    name: 'yeschef', type: 'http', url: http.url,
    headers: [{ name: 'Authorization', value: `Bearer ${http.token}` }],
  }
  const cwd = process.cwd()
  const seen: string[] = []
  const permissions: string[] = []
  let mapper = createGrokMapper('pending')

  const client = await createGrokClient({
    cwd, mcpServers: [mcp], logError,
    onUpdate: (method, params) => { for (const event of mapper.accept(method, params)) seen.push(event.kind) },
    onPermission: (request): Promise<PermissionOutcome> => {
      permissions.push(request.title === '' ? request.kind : request.title)
      const allow = request.options.find((option) => option.kind === 'allow_once') ?? request.options[0]
      return Promise.resolve(allow === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: allow.optionId })
    },
    onStderr: (line) => { console.error(`[grok] ${line}`) },
    onExit: (code) => { console.error(`[grok] exit ${code ?? 'null'}`) },
  })
  check('session/new 帶 http mcpServers', client.sessionId !== '', `sessionId=${client.sessionId} models=${client.models().length}`)

  mapper = createGrokMapper(client.sessionId)
  mapper.beginTurn()
  const turn = await client.prompt([{ type: 'text', text: PROMPT }])
  check('回合結束', turn.stopReason !== undefined, `stopReason=${String(turn.stopReason)}`)
  check('tools/call 打到 yeschef 的 MCP server', toolCalls.includes('view_snapshot'), toolCalls.join(','))
  check('request_permission 進得來', true, permissions.join(',') || '這次沒有需要批准的工具')
  check('事件進得了 mapper', seen.includes('text-delta') || seen.includes('tool-use'), seen.join(','))

  const sessionId = client.sessionId
  await client.close()

  const catalog = createGrokCatalog({ logError, cacheMs: 0 })
  const listed = await catalog.list(cwd)
  check('session/list 列得到剛才的 session', listed.some((s) => s.sessionId === sessionId), `共 ${listed.length} 筆`)

  const replayed: string[] = []
  let loadMapper = createGrokMapper(sessionId)
  loadMapper.beginTurn()
  const loader = await createGrokClient({
    cwd, mcpServers: [mcp], resume: sessionId, logError,
    onUpdate: (method, params) => { for (const event of loadMapper.accept(method, params)) replayed.push(event.kind) },
    onPermission: () => Promise.resolve<PermissionOutcome>({ outcome: 'cancelled' }),
    onStderr: () => {},
    onExit: () => {},
  })
  check('session/load 重播得出事件', replayed.length > 0, replayed.join(','))
  await loader.close()
  await http.close()
}

main().then(
  () => { process.exit(results.every((r) => r.ok) ? 0 : 1) },
  (cause: unknown) => {
    check('spike 本身', false, cause instanceof Error ? cause.message : String(cause))
    process.exit(1)
  },
)
```

- [ ] **Step 3: 跑 spike**

Run: `npm run spike:grok`
Expected: 六行 JSON 全部 `"ok":true`。跑之前確認 `grok models` 顯示已登入;
這一步不要和 `npm test` 同時跑。

- [ ] **Step 4: 寫 RESULTS 骨架**

```markdown
<!-- docs/RESULTS-37-grok-runtime.md -->
# RESULTS-37:Grok 對話

- 日期:(填實際驗收日)
- 規格:`docs/specs/2026-09-22-grok-runtime-design.md`
- 計畫:`docs/superpowers/plans/2026-09-22-grok-runtime.md`
- `grok` 版本:(填 `grok --version` 的輸出)

## 1. 單元測試

| 檔案 | 測試數 | 結果 |
|---|---|---|
| `tests/providers.test.ts` | | |
| `tests/jsonrpc-stdio.test.ts` | | |
| `tests/grok-mapper.test.ts` | | |
| `tests/grok-client.test.ts` | | |
| `tests/view-tools-http-server.test.ts` | | |
| `tests/grok-conversation.test.ts` | | |
| `tests/grok-catalog.test.ts` | | |
| `tests/chef-view-tools.test.ts` | | |
| `tests/ipc-bridge.test.ts` | | |
| `tests/left-pane.test.tsx` | | |
| `npm test` 全套 | | |

## 2. Spike

`npm run spike:grok` 的輸出逐行貼在這裡。

```text
(貼上六行 JSON)
```

## 3. 實機驗收

| # | 項目 | 結果 | 實際看到的 |
|---|---|---|---|
| 1 | 「+ Grok」開新對話,送一句話,串流顯示回覆 | 未驗收 | |
| 2 | 要它改一個檔案,批准卡片出現;允許後改動完成,拒絕後它停下 | 未驗收 | |
| 3 | 要它用右窗格開一個網址並截圖,右窗格真的動,截圖回到對話 | 未驗收 | |
| 4 | 設定一台測試機,要它 `view_login`,回覆不含帳密,右窗格已登入 | 未驗收 | |
| 5 | 關掉分頁再從歷史對話點開同一個 session,內容完整 | 未驗收 | |
| 6 | Chef 允許的模型勾一個 grok 模型,任務被路由到 Grok 對話,跑完後 Chef 收到 report_result | 未驗收 | |
| 7 | 把 `grok` 從 PATH 拿掉再開 Grok 對話,卡片顯示「PATH 找不到 grok,請先安裝」,Claude 與 Codex 不受影響 | 未驗收 | |

## 4. 已知限制

已知代價,兩條都是設計上選的,不是 bug:

- Grok 分頁退到背景不收子行程。grok 沒有「接回去但不重播」的方法,收掉再回來只能
  `session/load`,那會把整段歷史重播一次。代價是每個開著的 Grok 分頁常駐一個
  `grok agent stdio`。(開幾個分頁、實際的記憶體佔用填在這裡)
- Grok 對話的 diff 只看得到 live 的寫檔事件。grok 沒有「讀某個 session 的歷史項目」
  這種 API,分頁關掉再開,之前那一段的改動不會出現在 diff 的檔案清單裡。
- (其他在驗收時發現的限制寫在這裡;沒有就只留上面兩條)
```

- [ ] **Step 5: Commit**

```bash
git add spikes/grok-acceptance.ts package.json docs/RESULTS-37-grok-runtime.md
git commit -m "test: add the grok spike and the acceptance results skeleton"
```
